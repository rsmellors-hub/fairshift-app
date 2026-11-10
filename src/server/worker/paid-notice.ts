import { and, eq } from "drizzle-orm";
import { labelledMoney, money } from "@/app/components/format";
import type { Database, DatabaseSession } from "@/server/db/client";
import { getEmailAdapter } from "@/server/notifications/email";
import { dispatchNotification } from "@/server/notifications/service";
import { outlets, shifts, tipAllocationLines, tipAllocations, workPayables, workPayouts, workers } from "@/server/db/schema";
import { noticeToWorker } from "@/server/worker/inbox";

// The Paid notice and email (design: EmailPaid, 10 Nov 2026). Sent once, only when PayPal Sandbox has
// reported the payout item SUCCESS (status PAID). The worker's own currency comes first; then what PayPal
// was sent, with the ECB reference rate each payment locked when it was created, and the batch reference.
// Every figure is read from the stored payout, payable and tip records; nothing is recalculated.
type Payout = typeof workPayouts.$inferSelect;
const rate = (payout: Pick<Payout, "fxRateMicros" | "fxRateSource">) => payout.fxRateMicros ? `ECB ${(payout.fxRateMicros / 1_000_000).toFixed(4)}${payout.fxRateSource?.includes(":") ? ` (${payout.fxRateSource.split(":")[1]})` : ""}` : null;
const sent = (payout: Payout) => payout.providerCurrency !== payout.currencyCode ? labelledMoney(payout.providerAmountMinor, payout.providerCurrency) : money(payout.providerAmountMinor, payout.providerCurrency);
const day = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const clock = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);

export async function paidNotice(db: DatabaseSession, payout: Payout) {
  if (payout.status !== "PAID") return null;
  try {
    const [worker] = await db.select({ firstName: workers.firstName }).from(workers).where(eq(workers.id, payout.workerId));
    const [place] = await db.select({ name: outlets.name, timezone: outlets.timezone }).from(outlets).where(eq(outlets.id, payout.outletId));
    const lines: string[] = [], conversions: string[] = [];
    let title: string, opening: string, href = "/worker/pay", entityId = payout.id;
    if (payout.payableId) {
      const [row] = await db.select({ payable: workPayables, shift: shifts }).from(workPayables).innerJoin(shifts, eq(shifts.id, workPayables.shiftId)).where(eq(workPayables.id, payout.payableId));
      if (!row) return null;
      href = `/worker/pay/${row.payable.id}`; entityId = row.payable.id;
      const when = `${day(row.shift.shiftDate)} · ${place?.name ?? "your location"} · ${clock(row.shift.startsAt, place?.timezone ?? "UTC")}–${clock(row.shift.endsAt, place?.timezone ?? "UTC")}`;
      title = `Paid: ${money(payout.amountMinor, payout.currencyCode)} for ${day(row.shift.shiftDate)}, ${place?.name ?? "your shift"}`;
      opening = `Paid ✓ ${money(payout.amountMinor, payout.currencyCode)} is in your PayPal account.\n\nHi${worker?.firstName ? ` ${worker.firstName}` : ""}, your pay for ${when} has been paid.`;
      lines.push(`Shift earnings: ${money(payout.amountMinor, payout.currencyCode)}`);
      if (payout.providerCurrency !== payout.currencyCode) conversions.push(`shift ${sent(payout)}${rate(payout) ? ` at ${rate(payout)}` : ""}`);
      // Card tips for the same day at the same location, paid separately, if PayPal has confirmed them.
      const tips = await db.select({ line: tipAllocationLines, block: tipAllocations.blockName, paid: workPayouts }).from(tipAllocationLines)
        .innerJoin(tipAllocations, eq(tipAllocations.id, tipAllocationLines.allocationId)).innerJoin(workPayouts, eq(workPayouts.tipLineId, tipAllocationLines.id))
        .where(and(eq(tipAllocationLines.workerId, payout.workerId), eq(tipAllocationLines.outletId, payout.outletId), eq(tipAllocationLines.localDate, row.shift.shiftDate), eq(workPayouts.status, "PAID")));
      for (const tip of tips) {
        lines.push(`Card tips${tip.block ? ` · ${tip.block}` : ""}: ${money(tip.paid.amountMinor, tip.paid.currencyCode)} (paid separately)`);
        if (tip.paid.providerCurrency !== tip.paid.currencyCode) conversions.push(`tips ${sent(tip.paid)}${rate(tip.paid) ? ` at ${rate(tip.paid)}` : ""}`);
      }
    } else if (payout.tipLineId) {
      const [tip] = await db.select({ line: tipAllocationLines, block: tipAllocations.blockName }).from(tipAllocationLines).innerJoin(tipAllocations, eq(tipAllocations.id, tipAllocationLines.allocationId)).where(eq(tipAllocationLines.id, payout.tipLineId));
      if (!tip) return null;
      title = `Tips paid: ${money(payout.amountMinor, payout.currencyCode)} for ${day(tip.line.localDate)}, ${place?.name ?? "your location"}`;
      opening = `Paid ✓ ${money(payout.amountMinor, payout.currencyCode)} in card tips is in your PayPal account.`;
      lines.push(`Card tips${tip.block ? ` · ${tip.block}` : ""}: ${money(payout.amountMinor, payout.currencyCode)}`);
      if (payout.providerCurrency !== payout.currencyCode) conversions.push(`tips ${sent(payout)}${rate(payout) ? ` at ${rate(payout)}` : ""}`);
    } else return null;
    const body = [
      opening, "", ...lines,
      conversions.length ? `\nSent through PayPal Sandbox in ${payout.providerCurrency === "USD" ? "US dollars" : payout.providerCurrency} (${payout.currencyCode === "ZAR" ? "rand can't be sent through PayPal" : "PayPal's payout currency"}): ${conversions.join(" · ")}; rates locked when each payment was created.` : "",
      `PayPal batch: ${payout.paypalBatchId ?? payout.senderBatchId}`,
      payout.currencyCode === "ZAR" ? "If you withdraw to a rand bank account, PayPal converts at its own rate." : "",
      "\nSomething not right? Open the shift's pay in FairShift and choose “Query this shift's pay”.",
      "FairShift takes no fees from your earnings or tips. Sandbox: no real money moves.",
    ].filter(line => line !== "").join("\n");
    const notice = await noticeToWorker(db, { workerId: payout.workerId, kind: "PAYOUT_PAID", eventKey: `paid:${payout.id}`, entityId, title, body, href });
    // Sent at once; a failure leaves the delivery pending for the dispatcher.
    if (notice) await dispatchNotification(db as Database, getEmailAdapter(), notice.id).catch(() => undefined);
    return notice;
  } catch (error) {
    console.error("The paid notice could not be recorded.", { cause: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
