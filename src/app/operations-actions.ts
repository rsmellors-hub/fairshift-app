"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDatabase } from "@/server/db/client";
import { getConfigurationStatus } from "@/server/config/env";
import { createDepartment, createWorkPolicy, createRequirement, locationTimezone, offerAssignment, allocateAssignment, confirmWork } from "@/server/scheduling/operations";
import { UserFacingError } from "@/server/domain/errors";
import { confirmWorkPerformance, importAttributedSales } from "@/server/performance/attribution";
import { LocalTimeError, localDateTimeToInstant } from "@/server/domain/timezone";
import { requireScope } from "@/server/auth/request";
import { inviteMember } from "@/server/auth/tenancy";
import { saveWorkerAvailability, workerRespond } from "@/server/auth/operations";
import { dispatchNotification, dispatchWorkerEmails } from "@/server/notifications/service";
import { getEmailAdapter } from "@/server/notifications/email";
import { eq } from "drizzle-orm";
import { workers } from "@/server/db/schema";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { clearLabourPolicy, setLabourPolicy, setRegularCoverage, type PolicyLevel } from "@/server/intelligence/business-policy";
import { approveWorkPayable, refreshWorkPayout, submitWorkPayout } from "@/server/payments/work-payouts";

async function perform(path: string, fn: () => Promise<unknown>) {
  if (!getConfigurationStatus().databaseConfigured) redirect(`${path}${path.includes("?") ? "&" : "?"}status=error`);
  try { await fn(); } catch (error) {
    // A refusal the person can act on keeps its own message; anything else stays generic.
    const status = error instanceof UserFacingError ? error.feedback : error instanceof LocalTimeError ? `time-${error.problem.toLowerCase()}` : "error";
    redirect(`${path}${path.includes("?") ? "&" : "?"}status=${status}`);
  }
  for (const role of ["manager", "worker", "owner"]) revalidatePath(`/${role}`, "layout");
  redirect(`${path}${path.includes("?") ? "&" : "?"}status=saved`);
}
const field = (form: FormData, name: string) => String(form.get(name) ?? "");
function planPath(form: FormData) {
  const query = new URLSearchParams();
  const date = field(form, "planDate"), department = field(form, "planDepartment");
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) query.set("date", date);
  if (/^[0-9a-f-]{36}$/i.test(department)) query.set("department", department);
  // Only a known page: the value comes from a form and decides a redirect.
  const area = field(form, "returnArea") === "allocations" ? "allocations" : "fill";
  return `/manager/${area}${query.size ? `?${query}` : ""}`;
}
export async function createTeamAction(form: FormData) {
  const scope = await requireScope(["OWNER","MANAGER"]);
  return perform("/manager/team", async () => {
    const result = await inviteMember(getDatabase(),scope,{role:"TEAM_MEMBER",...Object.fromEntries(["firstName","surname","telephone","email"].map(key => [key,field(form,key)]))});
    await dispatchNotification(getDatabase(),getEmailAdapter(),result.notificationId,`/invite#${result.token}`);
  });
}
export async function createDepartmentAction(form: FormData) {
  const scope=await requireScope(["OWNER"]);
  return perform("/owner/policies", () => createDepartment(getDatabase(), field(form, "name"),scope));
}
export async function createPolicyAction(form: FormData) {
  const scope=await requireScope(["OWNER"]);
  return perform("/owner/policies", () => {
    const earningsModel = field(form, "earningsModel");
    const rate = field(form, "rate");
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(rate)) throw new Error("Enter a valid rate or percentage.");
    const [whole, fraction = ""] = rate.split(".");
    const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    const optionalAmount = (name: string) => {
      const text = field(form, name).trim();
      if (!text) return null;
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) throw new UserFacingError("policy-incentive", "Enter a valid amount.");
      const [units, cents = ""] = text.split(".");
      return Number(units) * 100 + Number(cents.padEnd(2, "0"));
    };
    const incentive = { incentiveTargetMinor: optionalAmount("incentiveTarget"), incentiveBonusMinor: optionalAmount("incentiveBonus") };
    return createWorkPolicy(getDatabase(), earningsModel === "COMMISSION" ? { earningsModel, commissionBps: value, commissionBasis: "VERIFIED_ATTRIBUTED_SALES", ...incentive } : { earningsModel, rateMinor: value, ...incentive }, field(form, "name"),scope);
  });
}
export async function createRequirementAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return perform(planPath(form), async () => {
    // Times are wall-clock at the work location; the session decides the location.
    const timeZone = await locationTimezone(getDatabase(), scope);
    return createRequirement(getDatabase(), { departmentId: field(form, "departmentId"), policyId: field(form, "policyId"), requiredHeadcount: Number(field(form, "headcount")),
      startsAt: localDateTimeToInstant(field(form, "startsAt"), timeZone), endsAt: localDateTimeToInstant(field(form, "endsAt"), timeZone) }, scope);
  });
}
export async function offerAssignmentAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return perform(planPath(form), async () => {
    const offer=await offerAssignment(getDatabase(),field(form,"shiftId"),field(form,"workerId"),scope);
    const [recipient]=await getDatabase().select().from(workers).where(eq(workers.id,offer.workerId));
    if (recipient) await dispatchWorkerEmails(getDatabase(),getEmailAdapter(),recipient.id);
  });
}
export async function allocateAssignmentAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return perform(planPath(form), () => allocateAssignment(getDatabase(), field(form, "offerId"),scope));
}
export async function respondAssignmentAction(form: FormData) {
  const scope=await requireScope(["TEAM_MEMBER"]);
  return perform("/worker/shifts", () => {
    const response = field(form, "response");
    if (response !== "ACCEPTED" && response !== "DECLINED") throw new Error("Invalid response.");
    return workerRespond(getDatabase(), scope, field(form, "offerId"), Number(field(form, "termsVersion")), response, field(form, "acknowledged") === "yes");
  });
}
// Worker's own weekly availability; blank clears a day to not provided.
export async function saveAvailabilityAction(form: FormData) {
  const scope=await requireScope(["TEAM_MEMBER"]);
  return perform("/worker/availability", () => saveWorkerAvailability(getDatabase(), scope, [1,2,3,4,5,6,7].map(day => {
    const value = field(form, `day${day}`);
    if (!value) return null;
    if (value !== "AVAILABLE" && value !== "UNAVAILABLE") throw new Error("Invalid availability.");
    return value;
  })));
}
export async function confirmWorkAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return perform("/manager/review", () => {
    if (field(form, "confirmed") !== "yes") throw new Error("Confirm completed work.");
    return confirmWork(getDatabase(), field(form, "offerId"),scope);
  });
}
// Sales evidence for this location. Workers, location and amounts come from the rows and
// the session; nothing else in the form is read.
export async function importAttributedSalesAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  let summary: Awaited<ReturnType<typeof importAttributedSales>>;
  try { summary = await importAttributedSales(getDatabase(), scope, field(form, "rows")); }
  catch (error) { redirect(`/manager/review?status=${error instanceof UserFacingError ? error.feedback : "error"}#performance`); }
  for (const role of ["manager", "worker", "owner"]) revalidatePath(`/${role}`, "layout");
  const rejected = summary.rejected.slice(0, 10).map(row => `${row.line}:${row.reason}`).join(",");
  redirect(`/manager/review?importResult=${summary.imported}.${summary.duplicates}.${summary.rejected.length}${rejected ? `.${rejected}` : ""}#performance`);
}
// The manager states the evidence is complete; the figures and incentive are calculated
// on the server. The seen values only detect sales that arrived after the page opened.
export async function confirmPerformanceAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return perform("/manager/review", () => {
    if (field(form, "complete") !== "yes") throw new Error("Confirm the sales are complete.");
    return confirmWorkPerformance(getDatabase(), scope, field(form, "allocationId"), { count: Number(field(form, "seenCount")), minor: Number(field(form, "seenMinor")) });
  });
}
// Payment actions take only the payable ID: amount, currency and recipient are read
// from the approved payable and the worker's saved payment settings on the server.
export async function approvePayableAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return perform("/manager/review", () => approveWorkPayable(getDatabase(), scope, field(form, "payableId")));
}
export async function sendPayoutAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return perform("/manager/review", () => submitWorkPayout(getDatabase(), getPayPalPayoutClient(), scope, field(form, "payableId")));
}
export async function refreshPayoutAction(form: FormData) {
  const scope=await requireScope(["OWNER","MANAGER"]);
  return perform("/manager/review", () => refreshWorkPayout(getDatabase(), getPayPalPayoutClient(), scope, field(form, "payableId")));
}
// Owner-only staffing inputs, for the organisation or the Owner's selected location.
function minorFromMajor(value: string) {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value)) throw new Error("Enter a valid amount.");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
function labourPolicyAction(level: PolicyLevel) {
  return async (form: FormData) => {
    const scope=await requireScope(["OWNER"]);
    return perform("/owner/policies", () => setLabourPolicy(getDatabase(),scope,level,{ currencyCode: field(form,"currencyCode").trim().toUpperCase(), salesMinorPerLabourHour: minorFromMajor(field(form,"salesPerLabourHour").trim()) }));
  };
}
export async function saveOrganisationLabourPolicyAction(form: FormData) { return labourPolicyAction("ORGANISATION")(form); }
export async function saveLocationLabourPolicyAction(form: FormData) { return labourPolicyAction("LOCATION")(form); }
export async function clearOrganisationLabourPolicyAction() {
  const scope=await requireScope(["OWNER"]);
  return perform("/owner/policies", () => clearLabourPolicy(getDatabase(),scope,"ORGANISATION"));
}
export async function clearLocationLabourPolicyAction() {
  const scope=await requireScope(["OWNER"]);
  return perform("/owner/policies", () => clearLabourPolicy(getDatabase(),scope,"LOCATION"));
}
// Hours per weekday: blank leaves the day not set; 0 is a configured zero.
export async function saveRegularCoverageAction(form: FormData) {
  const scope=await requireScope(["OWNER"]);
  return perform("/owner/policies", () => setRegularCoverage(getDatabase(),scope,[1,2,3,4,5,6,7].map(day => {
    const value = field(form,`day${day}`).trim();
    if (!value) return null;
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(value)) throw new Error("Enter hours as a number.");
    const [whole, fraction = ""] = value.split(".");
    const minutes = (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) * 60 / 100;
    if (!Number.isInteger(minutes)) throw new Error("Enter hours in whole minutes.");
    return minutes;
  })));
}
export async function changeAssignmentAction(form:FormData) {
 const scope=await requireScope(["OWNER","MANAGER"]);
 return perform(planPath(form),async ()=>{
  const {changeAssignment}=await import("@/server/scheduling/operations");
  const timeZone = await locationTimezone(getDatabase(), scope);
  await changeAssignment(getDatabase(),scope,field(form,"shiftId"),field(form,"cancel") === "yes" ? {cancel:true}:{startsAt:localDateTimeToInstant(field(form,"startsAt"),timeZone),endsAt:localDateTimeToInstant(field(form,"endsAt"),timeZone)});
  const members=await getDatabase().select().from(workers).where(eq(workers.locationId,scope.locationId));
  for (const member of members) await dispatchWorkerEmails(getDatabase(),getEmailAdapter(),member.id);
 });
}
