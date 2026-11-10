"use client";

import { rand } from "@/app/components/format";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { EventModel, ResourceModel, Scheduler } from "@bryntum/scheduler";
import { allocateAssignmentAction } from "@/app/operations-actions";
import { offerFromScheduleAction, rescheduleShiftAction, type OfferResult, type ScheduleChange, type ScheduleResult } from "@/app/schedule-actions";
import type { PlanningSummary } from "@/server/scheduling/allocations";
import { type AllocationSchedule, dropRule, FORECAST_RESOURCE, moveToDay, OPEN_PLACES_RESOURCE, REGULAR_RESOURCE, schedulerConfig, type ScheduleEvent } from "./allocation-model";

const parts = (iso: string, timeZone: string) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
const localDate = (iso: string, timeZone: string) => { const p = parts(iso, timeZone); return `${p.year}-${p.month}-${p.day}`; };
const localInput = (iso: string, timeZone: string) => { const p = parts(iso, timeZone); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
// Bryntum's timeZone project holds the location's wall clock in the browser's Date fields.
const pad = (value: number) => String(value).padStart(2, "0");
const wallClock = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const mondayOf = (date: string) => { const day = new Date(`${date}T12:00:00Z`); day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7); return day.toISOString().slice(0, 10); };
const shown = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));

// A week is seven whole days, so an eight-hour shift is narrow. The bar carries its hours and
// a short state; the full wording is on hover and in the details below. No hours are hidden,
// because that could hide an overnight shift.
const hourLabel = (date: Date) => date.getMinutes() ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : pad(date.getHours());
const shortState = (event: ScheduleEvent | undefined) => {
  const state = event?.state ?? "";
  if (event?.kind === "GAP") return `${state.split(" ")[0]} open`;
  return state.startsWith("Allocated") ? "Alloc" : state.startsWith("Accepted") ? "Acc" : state.startsWith("Changed") ? "Chg" : state.startsWith("Offered") ? "Offer" : state.startsWith("Completed") ? "Done" : state.startsWith("Declined") ? "Decl" : "Closed";
};

const HOW: Record<ScheduleEvent["interaction"], string> = {
  MOVE: "Nobody has been offered this shift yet. Drag it or resize it to change the time.",
  MOVE_WITH_REACCEPTANCE: "Workers have live offers on this shift. Dragging it asks you to confirm first, and they must then accept the new times.",
  CHANGE_ONLY: "This shift is allocated, so it can’t be dragged. Use Change shift below: its workers must accept the new times before they’re booked again.",
  LOCKED: "This record is closed, so its times can’t be changed.",
};

type Pending = { event: ScheduleEvent; startsAt: string; endsAt: string; resolve: (confirmed: boolean) => void };
type PendingOffer = { event: ScheduleEvent; workerName: string; resolve: (confirmed: boolean) => void };
const hours = (minutes: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(minutes / 60)} h`;
const planningDay = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const SOURCE: Record<string, string> = { REFERENCE: "Reference sales history · synthetic", DEMO_SEEDED: "Demo / seeded history", IMPORTED: "Imported sales history · not provider-verified", SQUARE: "Square Sandbox sales · connected seller", ZETTLE: "Earlier connected-account sales" };

export function AllocationScheduler({ schedule, timeZone, planning = null, dragToOffer = true }: { schedule: AllocationSchedule; timeZone: string; planning?: PlanningSummary | null; dragToOffer?: boolean }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Scheduler | null>(null);
  const eventsRef = useRef(schedule.events);
  const scheduleRef = useRef(schedule);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const upcoming = [...schedule.events].filter(event => new Date(event.endDate) > new Date()).sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? schedule.events[0];
  const [selectedId, setSelectedId] = useState(upcoming?.id ?? "");
  // Open on the week with the next shift, else the planning week the forecast covers.
  const [date, setDate] = useState(upcoming ? mondayOf(localDate(upcoming.startDate, timeZone)) : planning ? mondayOf(planning.firstDate) : "");
  const [days, setDays] = useState(7);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingOffer, setPendingOffer] = useState<PendingOffer | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  // Design (OwnerSchedule, 10 Nov 2026): "Show open slots only" narrows the timeline and the list to places still to fill.
  const [openOnly, setOpenOnly] = useState(false);
  const listed = openOnly ? schedule.events.filter(event => event.kind === "GAP") : schedule.events;
  const selected = listed.find(event => event.id === selectedId) ?? listed[0] ?? null;

  const send = async (change: ScheduleChange) => {
    let result: ScheduleResult;
    try { result = await rescheduleShiftAction(change); }
    catch { result = { ok: false, code: "error", message: "The change could not be saved, so nothing was changed." }; }
    setOutcome(result.ok ? { ok: true, message: !result.changed ? "The times are unchanged." : change.acknowledgeReacceptance ? "Shift moved. Workers on it must accept the new times." : "Shift moved." } : { ok: false, message: result.message });
    // The server's state replaces whatever the timeline is showing, whichever way this went.
    startRefresh(() => router.refresh());
    return result.ok;
  };
  const sendOffer = async (event: ScheduleEvent, workerId: string, workerName: string) => {
    let result: OfferResult;
    try { result = await offerFromScheduleAction({ shiftId: event.shiftId, workerId }); }
    catch { result = { ok: false, code: "error", message: "The offer could not be sent, so nothing changed." }; }
    setOutcome(result.ok ? { ok: true, message: `Offer sent to ${workerName}. They must accept it before you can finalise the allocation.` } : { ok: false, message: result.message });
    startRefresh(() => router.refresh());
  };
  const allowOffer = useRef(dragToOffer);
  // The drop rule, with offers by drag turned off where this page can't send them (the public demo).
  const ruleFor = (event: ScheduleEvent, toRowId: string) => { const rule = dropRule(scheduleRef.current, event, toRowId); return rule.action === "OFFER" && !allowOffer.current ? { action: "REFUSE" as const, message: "In the demo, send offers from Fill shifts." } : rule; };
  const decide = useRef<(event: ScheduleEvent, start: Date, end: Date, to?: ResourceModel) => Promise<boolean>>(async () => false);
  const weekView = useRef(true);
  useEffect(() => {
    weekView.current = days === 7;
    decide.current = async (event, start, end, to) => {
      const rule = ruleFor(event, to ? String(to.id) : event.rowId);
      if (rule.action === "REFUSE") { setOutcome({ ok: false, message: rule.message }); return false; }
      if (rule.action === "OFFER") {
        const workerName = to?.name ? String(to.name) : "this worker";
        const confirmed = await new Promise<boolean>(resolve => setPendingOffer({ event, workerName, resolve }));
        setPendingOffer(null);
        // The open place stays where it is either way: an offer is not an allocation, and the
        // refreshed schedule shows the new offer on the worker's row.
        if (confirmed) await sendOffer(event, rule.workerId, workerName);
        return false;
      }
      const times = days === 7 ? moveToDay(event, wallClock(start).slice(0, 10), timeZone) : { startsAt: wallClock(start), endsAt: wallClock(end) };
      const confirmed = event.interaction === "MOVE" || await new Promise<boolean>(resolve => setPending({ event, ...times, resolve }));
      setPending(null);
      if (!confirmed) return false;
      return send({ shiftId: event.shiftId, expectedTermsVersion: event.termsVersion, ...times, source: "DRAG", acknowledgeReacceptance: event.interaction !== "MOVE" });
    };
  });
  useEffect(() => { eventsRef.current = schedule.events; scheduleRef.current = schedule; allowOffer.current = dragToOffer; }, [schedule, dragToOffer]);

  useEffect(() => {
    let cancelled = false;
    let scheduler: Scheduler | undefined;
    // Import only after mount: Bryntum requires browser APIs and must never run in SSR.
    import("@bryntum/scheduler").then(async ({ Scheduler }) => {
      if (cancelled || !host.current) return;
      const record = (model: EventModel) => eventsRef.current.find(event => event.id === String(model.id));
      scheduler = new Scheduler({
        ...schedulerConfig,
        features: { ...schedulerConfig.features, eventDrag: { ...schedulerConfig.features.eventDrag,
          // Early feedback while dragging; the drop decides again and the server has the last word.
          validatorFn: ({ eventRecords, newResource }: { eventRecords: EventModel[]; newResource: ResourceModel }) => {
            const event = eventRecords[0] && record(eventRecords[0]);
            if (!event || !newResource) return false;
            const rule = ruleFor(event, String(newResource.id));
            return rule.action === "REFUSE" ? { valid: false, message: rule.message } : { valid: true, message: rule.action === "OFFER" ? "Drop to offer this shift to this worker" : "" };
          } } },
        appendTo: host.current, autoHeight: true, minHeight: 200,
        timeZone, viewPreset: "dayAndWeek", forceFit: host.current.clientWidth >= 600, autoAdjustTimeAxis: false, rowHeight: 64, barMargin: 6, eventStyle: "filled",
        columns: [{ text: "Worker", field: "name", width: 150, htmlEncode: true }],
        eventRenderer: ({ eventRecord }) => {
          const event = record(eventRecord as EventModel), start = eventRecord.startDate as Date, end = eventRecord.endDate as Date;
          return { tag: "span", className: "allocation-bar", title: `${event?.workerName ?? ""} · ${eventRecord.name} · ${pad(start.getHours())}:${pad(start.getMinutes())} to ${pad(end.getHours())}:${pad(end.getMinutes())}`,
            // A week's bar is narrow, so its hours stack rather than clip.
            children: weekView.current ? [{ tag: "strong", text: `${hourLabel(start)}–` }, { tag: "strong", text: hourLabel(end) }, { tag: "span", text: shortState(event) }] : [{ tag: "strong", text: `${hourLabel(start)}–${hourLabel(end)}` }, { tag: "span", text: shortState(event) }] };
        },
        onEventClick: ({ eventRecord }) => setSelectedId(String(eventRecord.id)),
        // An open forecast window opens Fill shifts on that window; nothing is created here.
        onResourceTimeRangeClick: ({ resourceTimeRangeRecord }) => {
          const href = scheduleRef.current.timeRanges.find(range => range.id === String(resourceTimeRangeRecord.id))?.fillHref;
          if (href) router.push(href);
        },
        onBeforeEventDrag: ({ eventRecord }) => record(eventRecord as EventModel)?.draggable === true,
        onBeforeEventResize: ({ eventRecord }) => !weekView.current && record(eventRecord as EventModel)?.resizable === true,
        onBeforeEventDropFinalize: async ({ context }) => {
          const event = record(context.eventRecord);
          context.async = true;
          context.finalize(event ? await decide.current(event, context.startDate, context.endDate, context.newResource) : false);
        },
        onBeforeEventResizeFinalize: async (change) => {
          const event = record(change.eventRecord);
          const context = change.context as { async: boolean; finalize: (ok: boolean) => void; startDate: Date; endDate: Date };
          context.async = true;
          context.finalize(event ? await decide.current(event, context.startDate, context.endDate) : false);
        },
      });
      instance.current = scheduler;
      setLoad("ready");
    }).catch(() => { if (!cancelled) setLoad("error"); });
    return () => { cancelled = true; instance.current = null; scheduler?.destroy(); };
  }, [timeZone, router]);

  // Always the server's records: after any change, including a refused one, this replaces
  // what the timeline holds, so the browser's copy never becomes the truth.
  useEffect(() => {
    const scheduler = instance.current;
    if (!scheduler || load !== "ready") return;
    const state = scheduler as unknown as { resources: unknown; events: unknown; assignments: unknown; resourceTimeRanges: unknown };
    state.resources = schedule.resources.map(row => ({ ...row }));
    state.events = schedule.events.map(row => ({ ...row }));
    state.assignments = schedule.assignments.map(row => ({ ...row }));
    state.resourceTimeRanges = schedule.timeRanges.map(({ id, resourceId, startDate, endDate, name, cls }) => ({ id, resourceId, startDate, endDate, name, cls }));
  }, [schedule, load]);

  useEffect(() => {
    if (!instance.current || load !== "ready" || !date) return;
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + days);
    const scheduler = instance.current;
    let cancelled = false;
    // A fixed preset per view, fitted to the width by the scheduler. There is no zooming, because
    // zooming moves the visible dates: these are always exactly the dates asked for.
    Promise.resolve().then(() => {
      if (cancelled) return;
      scheduler.viewPreset = days === 1 ? "hourAndDay" : "dayAndWeek";
      scheduler.setTimeSpan(start, end);
      // A day has room for quarter-hours; a week can only say which day.
      scheduler.timeResolution = days === 1 ? { unit: "minute", increment: 15 } : { unit: "hour", increment: 1 };
    }).catch(() => { if (!cancelled) setLoad("error"); });
    return () => { cancelled = true; };
  }, [date, days, load]);

  useEffect(() => {
    const store = (instance.current as unknown as { eventStore?: { filterBy: (fn: (record: { id: unknown }) => boolean) => void; clearFilters: () => void } } | null)?.eventStore;
    if (!store || load !== "ready") return;
    if (openOnly) store.filterBy(record => eventsRef.current.find(event => event.id === String(record.id))?.kind === "GAP"); else store.clearFilters();
  }, [openOnly, load]);

  const shiftWeek = (weeks: number) => { const next = new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + weeks * days); setDate(next.toISOString().slice(0, 10)); };

  return <section className="panel allocation-schedule" aria-label="Location shift schedule">
    <div className="panel-head"><div><h2>Weekly schedule</h2><p className="panel-lede">Who is working, when and in what state. Times are {timeZone}.</p></div><Link className="secondary-button button-link" href="/manager/fill">Fill shifts</Link></div>
    <div className="allocation-controls">
      <button className="secondary-button" type="button" onClick={() => shiftWeek(-1)}>Previous</button>
      <label>Starting<input type="date" value={date} onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>
      <button className="secondary-button" type="button" onClick={() => shiftWeek(1)}>Next</button>
      <label>View<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>Week</option><option value={1}>Day</option></select></label>
      <button className="secondary-button" type="button" aria-pressed={openOnly} onClick={() => setOpenOnly(value => !value)}>{openOnly ? "Show all shifts" : "Show open slots only"}</button>
    </div>
    {planning ? <ForecastNeed planning={planning} /> : null}
    <ul className="allocation-legend" aria-label="Shift states">
      {planning ? <><li><i data-state="forecast-open" />Forecast casual need</li><li><i data-state="forecast-filled" />Need filled</li><li><i data-state="regular" />Regular staff</li></> : null}
      <li><i data-state="gap" />Places to fill</li><li><i data-state="offered" />Offered</li><li><i data-state="accepted" />Accepted</li><li><i data-state="allocated" />Allocated</li><li><i data-state="closed" />Finished or closed</li><li><i data-state="unavailable" />Worker unavailable</li>
    </ul>
    {load === "loading" ? <p role="status">Loading schedule timeline…</p> : null}
    {load === "error" ? <p role="alert">The timeline could not be loaded. Shift details remain available below. Reload this page to try again.</p> : null}
    {pending ? <div className="allocation-confirm" role="alertdialog" aria-labelledby="allocation-confirm-title">
      <h3 id="allocation-confirm-title">This shift has already been offered or accepted</h3>
      <p>{shown(pending.event.startDate, timeZone)} becomes {shown(`${pending.startsAt}:00Z`, "UTC")} to {pending.endsAt.slice(11)}. Changing the time means workers with an offer or acceptance must accept the new terms, and pay based on hours is recalculated.</p>
      <div className="allocation-confirm-actions"><button className="primary-button" type="button" onClick={() => pending.resolve(true)}>Move and ask workers again</button><button className="secondary-button" type="button" onClick={() => pending.resolve(false)}>Keep current times</button></div>
    </div> : null}
    {pendingOffer ? <div className="allocation-confirm" role="alertdialog" aria-labelledby="allocation-offer-title">
      <h3 id="allocation-offer-title">Offer this shift to {pendingOffer.workerName}?</h3>
      <p>{shown(pendingOffer.event.startDate, timeZone)} to {shown(pendingOffer.event.endDate, timeZone)} on the shift’s current terms. {pendingOffer.workerName} must accept before you can finalise the allocation. FairShift checks their availability, other work and the pay terms before it sends anything.</p>
      <div className="allocation-confirm-actions"><button className="primary-button" type="button" onClick={() => pendingOffer.resolve(true)}>Send offer</button><button className="secondary-button" type="button" onClick={() => pendingOffer.resolve(false)}>Don’t send</button></div>
    </div> : null}
    {outcome ? <p className={outcome.ok ? "allocation-outcome" : "allocation-outcome allocation-outcome-refused"} role={outcome.ok ? "status" : "alert"}>{outcome.message}{refreshing ? " Updating…" : ""}</p> : null}
    <div className="allocation-timeline" ref={host} />
    <p className="note">Select a shift for its details. In Week view, dragging moves a shift to another day at the same times; switch to Day view to change its hours. {dragToOffer ? "Drag an open place onto a worker to offer them the shift. " : ""}FairShift checks every change on the server, so a refused move returns to where it was.</p>
    <label>Shift details<select value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>{listed.map((event) => <option value={event.id} key={event.id}>{shown(event.startDate, timeZone)} · {event.workerName} · {event.state}</option>)}</select></label>
    {openOnly && !listed.length ? <p className="note">No open slots in this schedule.</p> : null}
    {selected ? <ShiftDetail key={`${selected.id}:${selected.termsVersion}`} event={selected} timeZone={timeZone} send={send} assign={dragToOffer && selected.kind === "GAP" ? { candidates: candidatesFor(schedule, selected), offer: sendOffer } : null} /> : null}
  </section>;
}

// "Assign…" on an open place (design, OwnerSchedule): pick someone from the location's team; they get a
// booking request (an offer) to accept. The same checks as dragging decide who can be picked, and the
// server checks again before anything is sent.
function candidatesFor(schedule: AllocationSchedule, event: ScheduleEvent) {
  const special = new Set([OPEN_PLACES_RESOURCE.id, FORECAST_RESOURCE.id, REGULAR_RESOURCE.id]);
  return schedule.resources.filter(row => !special.has(String(row.id))).map(row => { const rule = dropRule(schedule, event, String(row.id));
    return { id: rule.action === "OFFER" ? rule.workerId : String(row.id), name: String(row.name), refused: rule.action === "REFUSE" ? rule.message : null }; });
}
function AssignPicker({ event, candidates, offer }: { event: ScheduleEvent; candidates: ReturnType<typeof candidatesFor>; offer: (event: ScheduleEvent, workerId: string, workerName: string) => Promise<void> }) {
  const [choice, setChoice] = useState("");
  const [sending, setSending] = useState(false);
  const free = candidates.filter(row => !row.refused);
  const picked = free.find(row => row.id === choice);
  return <details className="allocation-change"><summary>Assign…</summary>
    {free.length ? <div className="workspace-form"><label>Who<select value={choice} onChange={change => setChoice(change.target.value)}><option value="">Choose someone free</option>{free.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      <button className="primary-button" type="button" disabled={!picked || sending} onClick={async () => { if (!picked) return; setSending(true); await offer(event, picked.id, picked.name); setSending(false); }}>Send booking request</button>
      <p className="note">They get it in their Inbox and by email, on this shift’s terms. They’re booked only once they accept and you finalise.</p></div>
      : <p className="note">Nobody on the team is free for this shift.</p>}
    {candidates.some(row => row.refused) ? <ul className="note">{candidates.filter(row => row.refused).map(row => <li key={row.id}>{row.name}: {row.refused}</li>)}</ul> : null}
  </details>;
}

function ShiftDetail({ event, timeZone, send, assign = null }: { event: ScheduleEvent; timeZone: string; send: (change: ScheduleChange) => Promise<boolean>; assign?: { candidates: ReturnType<typeof candidatesFor>; offer: (event: ScheduleEvent, workerId: string, workerName: string) => Promise<void> } | null }) {
  const [saving, setSaving] = useState(false);
  const pay = event.earningsModel === "COMMISSION" ? `${(event.commissionBps ?? 0) / 100}% commission` : event.currencyCode === "ZAR" ? rand(event.guaranteedBasePayMinor) : new Intl.NumberFormat("en-GB", { style: "currency", currency: event.currencyCode }).format(event.guaranteedBasePayMinor / 100);
  const submit = async (form: FormData) => {
    setSaving(true);
    await send({ shiftId: event.shiftId, expectedTermsVersion: event.termsVersion, startsAt: String(form.get("startsAt")), endsAt: String(form.get("endsAt")), source: "CHANGE", acknowledgeReacceptance: form.get("acknowledged") === "yes" });
    setSaving(false);
  };
  return <div aria-live="polite" className="allocation-detail"><h3>{event.workerName} · {event.roleName}</h3>
    <dl className="shift-terms">
      <div><dt>When · {timeZone}</dt><dd>{shown(event.startDate, timeZone)} to {shown(event.endDate, timeZone)}</dd></div>
      <div><dt>State</dt><dd>{event.state}</dd></div>
      <div><dt>Terms</dt><dd>Version {event.termsVersion}</dd></div>
      <div><dt>Base pay</dt><dd>{pay}</dd></div>
      <div><dt>Incentive opportunity</dt><dd>{event.bonusLabel}</dd></div>
      <div><dt>Performance</dt><dd>{event.performanceLabel}</dd></div>
      <div><dt>Payment</dt><dd>{event.paymentLabel}</dd></div>
    </dl>
    <p className="note">{HOW[event.interaction]}</p>
    <div className="allocation-links">
      {event.fillHref ? <Link href={event.fillHref}>Fill this shift</Link> : null}
      {event.kind === "OFFER" && event.state.startsWith("Accepted") ? <form action={allocateAssignmentAction} data-demo-write=""><input type="hidden" name="offerId" value={event.id} /><input type="hidden" name="returnArea" value="allocations" /><button className="primary-button">Finalise allocation</button></form> : null}
      {event.kind === "OFFER" && event.interaction === "LOCKED" && event.state === "Allocated" ? <Link href="/manager/review">Review this work</Link> : null}
    </div>
    {assign ? <AssignPicker event={event} candidates={assign.candidates} offer={assign.offer} /> : null}
    {event.interaction === "CHANGE_ONLY" ? <details className="allocation-change"><summary>Change shift</summary>
      <form action={submit} className="workspace-form" data-demo-write="">
        <label>New start · {timeZone}<input name="startsAt" type="datetime-local" required defaultValue={localInput(event.startDate, timeZone)} /></label>
        <label>New end · {timeZone}<input name="endsAt" type="datetime-local" required defaultValue={localInput(event.endDate, timeZone)} /></label>
        <label className="acceptance-check"><input name="acknowledged" type="checkbox" value="yes" required /> I understand the allocated workers must accept the new terms before they’re booked again.</label>
        <button className="secondary-button" disabled={saving}>Change shift and ask workers again</button>
      </form></details> : null}
  </div>;
}

// The planning week's casual need, from the same calculation as Forecast & staffing. Listed as
// well as drawn, so every open window can be reached without the timeline.
function ForecastNeed({ planning }: { planning: PlanningSummary }) {
  return <div className="forecast-need" aria-label="Forecast casual need">
    <p className="provenance-line">{planning.source ? <span className="forecast-source">{SOURCE[planning.source.source] ?? "Verified PayPal Sandbox sales"}</span> : null}<span>Planning week {planningDay(planning.firstDate)} – {planningDay(planning.lastDate)}</span></p>
    <p>{planning.open.length ? <>Casual need still open: <strong>{hours(planning.casualGapMinutes)}</strong> across {planning.open.length} {planning.open.length === 1 ? "time" : "times"}.</> : "No open casual need in the days FairShift can calculate."} Worked out from expected transactions by time of day, this location’s capacity policy, regular staff and allocated casual work{planning.acceptedScenarios ? `, including ${planning.acceptedScenarios === 1 ? "one scenario" : `${planning.acceptedScenarios} scenarios`} you accepted` : ""}. Offers and acceptances don’t count until they’re allocated.{planning.unavailableDays ? ` ${planning.unavailableDays} ${planning.unavailableDays === 1 ? "day" : "days"} can’t be calculated; see Forecast & staffing.` : ""}</p>
    {planning.open.length ? <details className="disclosure-inline"><summary>Open times · {planning.open.length}</summary><ul className="forecast-need-list">{planning.open.map(row => <li key={row.id}><span>{planningDay(row.date)} · {row.windowStart}–{row.windowEnd} · {hours(row.remainingMinutes)} · up to {row.peakCasualStaff} {row.peakCasualStaff === 1 ? "person" : "people"}{row.scenario ? " · includes your accepted scenario" : ""}</span><Link className="text-link" href={row.fillHref}>Create shift</Link></li>)}</ul></details> : null}
  </div>;
}
