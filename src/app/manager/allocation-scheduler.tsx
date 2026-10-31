"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectModel, Scheduler } from "@bryntum/scheduler";
import { type AllocationSchedule, readOnlySchedulerConfig } from "./allocation-model";

function localDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function AllocationScheduler({ schedule, timeZone }: { schedule: AllocationSchedule; timeZone: string }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Scheduler | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [selectedId, setSelectedId] = useState(schedule.events[0]?.id ?? "");
  const [date, setDate] = useState(schedule.events[0] ? localDate(schedule.events[0].startDate, timeZone) : "");
  const [days, setDays] = useState(7);
  const selected = schedule.events.find((event) => event.id === selectedId);

  useEffect(() => {
    let cancelled = false;
    let scheduler: Scheduler | undefined;
    // Import only after mount: Bryntum requires browser APIs and must never run in SSR.
    import("@bryntum/scheduler").then(async ({ Scheduler }) => {
      if (cancelled || !host.current) return;
      scheduler = new Scheduler({
        ...readOnlySchedulerConfig, appendTo: host.current, height: 330,
        timeZone, viewPreset: "hourAndDay", rowHeight: 70, barMargin: 10,
        columns: [{ text: "Worker", field: "name", width: 165, htmlEncode: true }],
        resources: schedule.resources.map((row) => ({ ...row })),
        events: schedule.events.map((row) => ({ ...row })),
        assignments: schedule.assignments.map((row) => ({ ...row })),
        eventRenderer: ({ eventRecord }) => ({ tag: "span", text: eventRecord.name }),
        onEventClick: ({ eventRecord }) => setSelectedId(String(eventRecord.id)),
      });
      await (scheduler.project as ProjectModel).commitAsync();
      if (cancelled) return;
      instance.current = scheduler;
      setLoad("ready");
    }).catch(() => { if (!cancelled) setLoad("error"); });
    return () => { cancelled = true; instance.current = null; scheduler?.destroy(); };
  }, [schedule, timeZone]);

  useEffect(() => {
    if (!instance.current || load !== "ready" || !date) return;
    // Bryntum's timeZone project renders location wall-clock dates in local Date objects.
    // Persisted event timestamps remain UTC; only the display window uses wall-clock dates.
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + days);
    const scheduler = instance.current;
    let cancelled = false;
    Promise.resolve().then(() => scheduler.setTimeSpan(start, end)).then(() => {
      if (!cancelled) scheduler.zoomToSpan({ startDate: start, endDate: end });
    }).catch(() => { if (!cancelled) setLoad("error"); });
    return () => { cancelled = true; };
  }, [date, days, load]);

  return <section className="panel allocation-schedule" aria-label="Location shift schedule">
    <h2>Worker timeline</h2>
    <p>{timeZone} time. Offers, accepted responses and allocations are shown separately. Select a shift to review its terms.</p>
    <div className="allocation-controls">
      <label>Period starting<input type="date" value={date} onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>
      <label>View<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>Day</option><option value={7}>Week</option></select></label>
      <button className="secondary-button" onClick={() => setDate(localDate(schedule.events[0].startDate, timeZone))}>Latest shift</button>
    </div>
    {load === "loading" ? <p role="status">Loading schedule timeline…</p> : null}
    {load === "error" ? <p role="alert">The timeline could not be loaded. Shift details remain available below. Reload this page to try again.</p> : null}
    <div className="allocation-timeline" ref={host} />
    <p className="method-note">Read-only schedule. Dates, workers and accepted terms cannot be changed here. Scroll the timeline horizontally on smaller screens.</p>
    <label>Shift details<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{schedule.events.map((event) => <option value={event.id} key={event.id}>{localDate(event.startDate, timeZone)} · {event.roleName} · {event.state}</option>)}</select></label>
    {selected ? <div aria-live="polite"><h3>{selected.roleName}</h3><dl className="shift-terms">
      <div><dt>Worker</dt><dd>{selected.workerName}</dd></div><div><dt>State</dt><dd>{selected.state}</dd></div>
      <div><dt>Starts · {timeZone}</dt><dd>{new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(selected.startDate))}</dd></div>
      <div><dt>Ends · {timeZone}</dt><dd>{new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(selected.endDate))}</dd></div>
      <div><dt>{selected.earningsModel === "COMMISSION" ? "Commission · verified attributed sales" : "Expected work earnings"}</dt><dd>{selected.earningsModel === "COMMISSION" ? `${(selected.commissionBps ?? 0) / 100}%` : new Intl.NumberFormat("en-US", { style: "currency", currency: selected.currencyCode }).format(selected.guaranteedBasePayMinor / 100)}</dd></div>
    </dl></div> : null}
  </section>;
}
