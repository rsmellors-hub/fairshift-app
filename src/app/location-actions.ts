"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "@/app/revalidate";
import { requireScope } from "@/server/auth/request";
import { updateLocation } from "@/server/billing/locations";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { setTradingHours, setRegularCoverage, setVenueContext, setWorkloadPolicy } from "@/server/intelligence/business-policy";
import { pinConfirmed } from "@/server/intelligence/local-discovery-trigger";
import { parseCoverageText, parseTradingText } from "@/server/intelligence/workload";
import { createDepartment, createWorkPolicy, reviseWorkPolicy } from "@/server/scheduling/operations";
import { setShiftRules, setVenueFacts } from "@/server/settings/settings";
import { saveTipSettings } from "@/server/tips/service";
import { departments, outlets } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";

// The Owner's location page (design: OwnerLocation, 10 Nov 2026). Each section saves for the location the
// page shows (resolveScope refuses any location outside the Owner's business) and returns to it.

const field = (form: FormData, name: string) => String(form.get(name) ?? "");
async function ownerAt(form: FormData) {
  const id = field(form, "locationId");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Location unavailable.");
  return { scope: await requireScope(["OWNER"], { locationId: id }), id };
}
async function save(form: FormData, section: string, success: string, fn: (scope: Awaited<ReturnType<typeof ownerAt>>["scope"]) => Promise<unknown>) {
  const { scope, id } = await ownerAt(form);
  let outcome = success;
  try { await fn(scope); } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "error"; }
  for (const role of ["owner", "manager", "worker"]) revalidatePath(`/${role}`, "layout");
  // From the setup flow (design Setup), back to its step.
  const setup = /^setup:(venue|sales|pay|team)$/.exec(field(form, "next"));
  redirect(setup ? `/onboarding?step=${setup[1]}&location=${id}&status=${outcome}` : `/owner/locations/${id}?status=${outcome}#${section}`);
}
const whole = (text: string) => /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : NaN;
const minutes = (text: string) => { const value = Number(text.trim()); return text.trim() && Number.isFinite(value) ? Math.round(value * 60) : NaN; };
const amount = (text: string) => { const t = text.trim(); if (!/^\d{1,10}(\.\d{1,2})?$/.test(t)) return NaN; const [units, cents = ""] = t.split("."); return Number(units) * 100 + Number(cents.padEnd(2, "0")); };

export async function saveVenueDetailsAction(form: FormData) {
  return save(form, "venue", "location-updated", async scope => {
    await updateLocation(getDatabase(), scope, scope.locationId, { name: field(form, "name"), address: field(form, "address"), city: field(form, "city"), province: field(form, "province"), postalCode: field(form, "postalCode") });
    const seats = field(form, "seats").trim();
    await setVenueFacts(getDatabase(), scope, { customerTypes: form.getAll("customerTypes").map(String), customerNote: field(form, "customerNote"),
      venueType: field(form, "venueType") || null, seats: seats ? whole(seats) : null });
  });
}

// "Copy to all days" sends Monday's hours for every day.
export async function saveLocationTradingAction(form: FormData) {
  return save(form, "trading", "trading-saved", scope => {
    const copy = field(form, "copy") === "monday";
    const week = [1, 2, 3, 4, 5, 6, 7].map(day => { const text = field(form, `trading${copy ? 1 : day}`).trim(); if (!text) return null; try { return parseTradingText(text); } catch { throw new UserFacingError("trading-hours-invalid", "This time range couldn’t be read."); } });
    return setTradingHours(getDatabase(), scope, week);
  });
}

export async function saveStaffingAndOffersAction(form: FormData) {
  return save(form, "staffing", "staffing-saved", async scope => {
    const capacity = whole(field(form, "transactionsPerStaffHour")), minimum = whole(field(form, "minimumStaffWhileOpen"));
    if (!(capacity >= 1 && capacity <= 1000)) throw new UserFacingError("service-capacity-invalid", "Enter a whole number from 1 to 1000.");
    if (!(minimum >= 0 && minimum <= 100)) throw new UserFacingError("minimum-cover-invalid", "Enter a whole number from 0 to 100.");
    await setWorkloadPolicy(getDatabase(), scope, "LOCATION", { transactionsPerStaffHour: capacity, minimumStaffWhileOpen: minimum });
    await setShiftRules(getDatabase(), scope, { minMinutes: minutes(field(form, "minHours")), preferredMinutes: minutes(field(form, "preferredHours")), maxMinutes: minutes(field(form, "maxHours")),
      firstRoundMinutes: minutes(field(form, "firstRoundHours")), firstRoundCutoffMinutes: minutes(field(form, "cutoffHours")),
      cancellationPercent: whole(field(form, "cancellationPercent")), cancellationWindowMinutes: minutes(field(form, "cancellationHours")) });
    const coverage = [1, 2, 3, 4, 5, 6, 7].map(day => { const text = field(form, `coverage${day}`).trim(); if (!text) return null; try { return parseCoverageText(text); } catch { throw new UserFacingError("regular-coverage-invalid", "This regular cover couldn’t be read."); } });
    if (coverage.some(Boolean)) await setRegularCoverage(getDatabase(), scope, coverage);
  });
}

// A role is offered at its own hourly rate, checked against the wage floor before it can be saved.
export async function addRoleAction(form: FormData) {
  return save(form, "pay-terms", "role-added", async scope => {
    const role = field(form, "role").trim();
    if (!role) throw new UserFacingError("role-invalid", "Choose or type a role.");
    const db = getDatabase();
    const [existing] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.outletId, scope.locationId), eq(departments.name, role)));
    if (!existing) await createDepartment(db, role, scope);
    await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: amount(field(form, "rate")) }, role, scope);
  });
}

// "New version…": the new rate applies from now; shifts already created keep the terms they were made with.
export async function newPayVersionAction(form: FormData) {
  return save(form, "pay-terms", "pay-version-saved", scope => reviseWorkPolicy(getDatabase(), field(form, "policyId"), { earningsModel: "HOURLY", rateMinor: amount(field(form, "rate")) }, field(form, "name"), scope));
}

export async function saveLocationTipsAction(form: FormData) {
  return save(form, "tips", "tip-settings-saved", scope => saveTipSettings(getDatabase(), scope, { policy: field(form, "policy"), autoReleaseCapMinor: amount(field(form, "cap")) }));
}

// The Owner confirms the venue's pin. Changing it clears weather and event results for the old place
// (setVenueContext); local discovery for the new place follows (pinConfirmed).
export async function confirmPinAction(form: FormData) {
  const { scope, id } = await ownerAt(form);
  let outcome = "pin-confirmed";
  try {
    const [current] = await getDatabase().select({ venueProfile: outlets.venueProfile }).from(outlets).where(and(eq(outlets.id, id), eq(outlets.organisationId, scope.organisationId)));
    await setVenueContext(getDatabase(), scope, { venueProfile: current?.venueProfile ?? "", latitude: field(form, "latitude"), longitude: field(form, "longitude") });
    await getDatabase().update(outlets).set({ pinConfirmedAt: new Date() }).where(and(eq(outlets.id, id), eq(outlets.organisationId, scope.organisationId)));
    await pinConfirmed(getDatabase(), scope);
  } catch (error) { outcome = error instanceof UserFacingError ? error.feedback : "pin-invalid"; }
  for (const role of ["owner", "manager"]) revalidatePath(`/${role}`, "layout");
  redirect(field(form, "next") === "setup" ? `/onboarding?step=venue&location=${id}&status=${outcome}` : `/owner/locations/${id}?status=${outcome}#venue`);
}
