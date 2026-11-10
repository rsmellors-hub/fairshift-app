"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "@/app/revalidate";
import { requireOwnerCustomer, requireScope } from "@/server/auth/request";
import { createLocation } from "@/server/billing/locations";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { saveSetupVenue, setupProgress } from "@/server/onboarding/setup";
import { generateSampleHistory, importSalesCsv } from "@/server/sales/history-sources";

// The design's setup flow (Setup, 10 Nov 2026), steps 3–6, for any new business. Every step saves through
// FairShift's ordinary server checks; the flow only decides where to go next.

const field = (form: FormData, name: string) => String(form.get(name) ?? "");
const id = (form: FormData) => { const value = field(form, "locationId"); return /^[0-9a-f-]{36}$/.test(value) ? value : null; };
const go = (step: string, location: string | null, status?: string) => redirect(`/onboarding?step=${step}${location ? `&location=${location}` : ""}${status ? `&status=${status}` : ""}`);
const feedback = (error: unknown) => error instanceof UserFacingError ? error.feedback : "error";
const whole = (text: string) => /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : NaN;
function refresh() { for (const role of ["owner", "manager"]) revalidatePath(`/${role}`, "layout"); }

export async function saveSetupVenueAction(form: FormData) {
  const scope = await requireOwnerCustomer();
  let locationId = id(form);
  try {
    const location = await saveSetupVenue(getDatabase(), scope, { locationId, name: field(form, "name"), address: field(form, "address"), city: field(form, "city"), postalCode: field(form, "postalCode"),
      venueType: field(form, "venueType"), seats: whole(field(form, "seats")), customerTypes: form.getAll("customerTypes").map(String), customerNote: field(form, "customerNote"),
      trading: Array.from({ length: 7 }, (_, i) => field(form, `trading${i + 1}`)), coverage: Array.from({ length: 7 }, (_, i) => field(form, `coverage${i + 1}`)),
      transactionsPerStaffHour: whole(field(form, "transactionsPerStaffHour")), minimumStaffWhileOpen: whole(field(form, "minimumStaffWhileOpen")) });
    locationId = location.id;
  } catch (error) { go("venue", locationId, feedback(error)); }
  refresh();
  // Next: confirm the map pin, which starts the first look at the area.
  redirect(`/owner/locations/${locationId}/pin?next=setup`);
}

export async function sampleHistoryAction(form: FormData) {
  const location = id(form);
  const scope = await requireScope(["OWNER"], location ? { locationId: location } : {});
  let status = "sample-history-created";
  try { await generateSampleHistory(getDatabase(), scope); } catch (error) { status = feedback(error); }
  refresh();
  if (field(form, "next") === "settings") redirect(`/owner/settings?status=${status}#sales-data`);
  go("sales", scope.locationId, status);
}

export async function importSalesCsvAction(form: FormData) {
  const location = id(form);
  const scope = await requireScope(["OWNER"], location ? { locationId: location } : {});
  let status = "csv-imported";
  try {
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new UserFacingError("csv-invalid", "Choose a CSV file to upload.");
    if (file.size > 2_000_000) throw new UserFacingError("csv-invalid", "The file is larger than 2 MB.");
    await importSalesCsv(getDatabase(), scope, await file.text());
  } catch (error) { status = feedback(error); }
  refresh();
  if (field(form, "next") === "settings") redirect(`/owner/settings?status=${status}#sales-data`);
  go("sales", scope.locationId, status);
}

// Continue from pay terms only when at least one role is set (every rate was checked against the wage floor).
export async function continueSetupAction(form: FormData) {
  const scope = await requireOwnerCustomer();
  const location = id(form), step = field(form, "step");
  const progress = await setupProgress(getDatabase(), scope.organisationId, location);
  if (step === "pay" && !progress.pay) go("pay", location, "setup-needs-role");
  const next = { venue: "sales", sales: "pay", pay: "team" }[step] ?? "team";
  go(next, location);
}

export async function addAnotherLocationAction(form: FormData) {
  const scope = await requireOwnerCustomer();
  let location: string | null = null, status: string | undefined;
  try { location = (await createLocation(getDatabase(), scope, { name: field(form, "name") })).id; }
  catch (error) { status = error instanceof UserFacingError ? error.feedback : error instanceof Error && /plan allows/.test(error.message) ? "location-plan-limit" : "error"; }
  refresh();
  if (!location) go("team", id(form), status);
  go("venue", location);
}

export async function finishSetupAction() {
  await requireOwnerCustomer();
  refresh();
  redirect("/owner?welcome=1");
}
