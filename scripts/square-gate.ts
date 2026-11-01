import { createHash, createHmac } from "node:crypto";

// Go/no-go check of whether Square Sandbox can carry the worker attribution FairShift needs.
// This is not the product integration: it writes nothing to FairShift. It creates synthetic
// team members, payments and one refund in Sandbox, reads them back and compares them.
//
//   node --env-file=.env.local --import tsx scripts/square-gate.ts --run <label>
//
// Every create uses a key derived from --run, so repeating a run replays the same Square
// objects rather than creating more: that repeat is also the stability evidence.
//
// Output is safe to keep. It holds field names, types, counts, money and keyed pseudonyms.
// A guard refuses to print if a credential or raw provider identifier reached the report.
const HOST = "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2026-09-16";
const SANDBOX_CARD_SOURCE = "cnon:card-nonce-ok";
const TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;
type Money = { amount?: number; currency?: string };
type Reply = { status: number; ok: boolean; body: Json };

const token = process.env.SQUARE_ACCESS_TOKEN?.trim();
const applicationId = process.env.SQUARE_APPLICATION_ID?.trim();
if (process.env.SQUARE_ENVIRONMENT?.trim() !== "sandbox") stop("SQUARE_ENVIRONMENT must be sandbox. Nothing was requested.");
if (!token || !applicationId) stop("SQUARE_ACCESS_TOKEN and SQUARE_APPLICATION_ID must be set. Nothing was requested.");
const runFlag = process.argv.indexOf("--run");
const run = runFlag > -1 ? process.argv[runFlag + 1] : undefined;
if (!run || !/^[\w-]{1,40}$/.test(run)) stop("Pass --run <label>: letters, numbers, dashes. It decides which Square objects this run creates or replays.");

function stop(message: string): never { console.error(message); process.exit(2); }

const seen = new Set<string>();
// Same value and same token give the same pseudonym, so separate runs can be compared.
const alias = (value: unknown) => {
  if (typeof value !== "string" || !value) return null;
  seen.add(value);
  return `id_${createHmac("sha256", token!).update(value).digest("hex").slice(0, 10)}`;
};
const key = (purpose: string) => createHash("sha256").update(`fairshift-gate:${run}:${purpose}`).digest("hex").slice(0, 45);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function collect(value: unknown, path: string, shape: Map<string, Set<string>>, depth = 0) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (path) shape.set(path, (shape.get(path) ?? new Set()).add(type));
  if (depth >= 5) return;
  if (Array.isArray(value)) value.forEach(item => collect(item, `${path}[]`, shape, depth + 1));
  else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) collect(item, path ? `${path}.${name}` : name, shape, depth + 1);
}
const fieldsOf = (...values: unknown[]) => { const shape = new Map<string, Set<string>>(); values.forEach(value => collect(value, "", shape)); return [...shape].sort(([a], [b]) => a.localeCompare(b)).map(([path, types]) => `${path}: ${[...types].sort().join("|")}`); };

// Only Square's error category, code and field: its detail text is not kept.
const errorsOf = (body: Json) => (Array.isArray(body.errors) ? body.errors : []).map(raw => { const error = raw as Json; return { category: error.category, code: error.code, field: error.field }; });
const calls: { method: string; path: string; status: number | "NETWORK_ERROR" }[] = [];

async function square(method: "GET" | "POST", path: string, payload?: Json): Promise<Reply> {
  let response: Response;
  const label = path.split("?")[0].replace(/\/v2\/(payments|refunds|team-members)\/(?!search$)[^/]+$/, "/v2/$1/{id}");
  try {
    response = await fetch(`${HOST}${path}`, { method, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Authorization: `Bearer ${token}`, "Square-Version": SQUARE_VERSION, "Content-Type": "application/json" }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  } catch { calls.push({ method, path: label, status: "NETWORK_ERROR" }); return { status: 0, ok: false, body: {} }; }
  calls.push({ method, path: label, status: response.status });
  let body: Json = {};
  try { body = await response.json() as Json; } catch { body = {}; }
  return { status: response.status, ok: response.ok, body };
}

const report: Json = { run, squareVersion: SQUARE_VERSION, host: HOST, checkedAt: new Date().toISOString() };
const gate: Record<string, boolean> = { authenticated: false, ukGbpLocation: false, teamApiUsable: false, twoTeamMembers: false, gbpPaymentsAssociated: false, sameTeamMemberReadBack: false, stableAcrossReads: false };

function finish(reason: string | null): never {
  const verdict = Object.values(gate).every(Boolean) && !reason ? "GO" : "NO-GO";
  const output = JSON.stringify({ ...report, gate, verdict, stoppedBecause: reason, calls }, null, 2);
  for (const secret of [token!, applicationId!, ...seen]) if (output.includes(secret)) stop("A credential or raw provider identifier reached the report, so it was not printed.");
  console.log(output);
  process.exit(verdict === "GO" ? 0 : 1);
}

// --- Location and seller
const locations = await square("GET", "/v2/locations");
report.locationsCall = { status: locations.status, errors: errorsOf(locations.body) };
if (!locations.ok) finish(locations.status === 401 || locations.status === 403 ? "Authentication failed: credential or seller configuration blocker." : "The locations call failed.");
gate.authenticated = true;
const allLocations = (Array.isArray(locations.body.locations) ? locations.body.locations : []) as Json[];
const describeLocation = (location: Json) => ({ location: alias(location.id), country: location.country, currency: location.currency, status: location.status, timezone: location.timezone, capabilities: location.capabilities, addressCountry: (location.address as Json | undefined)?.country });
report.locations = { count: allLocations.length, fields: fieldsOf(...allLocations), rows: allLocations.map(describeLocation) };
const location = allLocations.find(row => row.country === "GB" && row.currency === "GBP" && row.status === "ACTIVE");
if (!location) finish("No active GB location using GBP was returned.");
gate.ukGbpLocation = true;
const locationId = String(location.id);

// --- Team members
const members: { label: string; id: string }[] = [];
const createdTeam: unknown[] = [];
const teamRows: Json[] = [];
for (const label of ["A", "B"]) {
  const created = await square("POST", "/v2/team-members", { idempotency_key: key(`team:${label}`), team_member: { given_name: "FairShift Demo", family_name: `Worker ${label}`, reference_id: `fairshift-gate-${label.toLowerCase()}`, assigned_locations: { assignment_type: "EXPLICIT_LOCATIONS", location_ids: [locationId] } } });
  teamRows.push({ worker: label, status: created.status, errors: errorsOf(created.body) });
  const member = created.body.team_member as Json | undefined;
  if (!created.ok || typeof member?.id !== "string") { report.team = { requestFields: ["idempotency_key", "team_member.given_name", "team_member.family_name", "team_member.reference_id", "team_member.assigned_locations.assignment_type", "team_member.assigned_locations.location_ids"], rows: teamRows }; finish("Team member creation failed or is unavailable."); }
  createdTeam.push(member);
  members.push({ label, id: member.id });
}
gate.teamApiUsable = true;
gate.twoTeamMembers = new Set(members.map(member => member.id)).size === 2;
const readBackIds: boolean[] = [];
for (let round = 0; round < 2; round++) for (const member of members) {
  const read = await square("GET", `/v2/team-members/${member.id}`);
  readBackIds.push((read.body.team_member as Json | undefined)?.id === member.id);
}
const search = await square("POST", "/v2/team-members/search", { query: { filter: { location_ids: [locationId], status: "ACTIVE" } }, limit: 200 });
const searched = (Array.isArray(search.body.team_members) ? search.body.team_members : []) as Json[];
report.team = {
  endpoint: "POST /v2/team-members",
  requestFields: ["idempotency_key", "team_member.given_name", "team_member.family_name", "team_member.reference_id", "team_member.assigned_locations.assignment_type", "team_member.assigned_locations.location_ids"],
  returnedFields: fieldsOf(...createdTeam),
  rows: teamRows, members: members.map(member => ({ worker: member.label, teamMember: alias(member.id) })),
  idsStableAcrossGets: readBackIds.every(Boolean), getsCompared: readBackIds.length,
  foundInSearch: members.map(member => searched.some(row => row.id === member.id)), activeAtLocation: searched.length,
};
if (!readBackIds.every(Boolean)) { gate.teamApiUsable = false; finish("Team member identifiers were not stable when read back."); }

// --- Payments
const plan = [{ ref: "A1", worker: "A", amount: 101 }, { ref: "A2", worker: "A", amount: 102 }, { ref: "B1", worker: "B", amount: 201 }, { ref: "B2", worker: "B", amount: 202 }];
const memberId = (worker: string) => members.find(member => member.label === worker)!.id;
const paymentBody = (item: typeof plan[number], amount = item.amount) => ({ idempotency_key: key(`payment:${item.ref}`), source_id: SANDBOX_CARD_SOURCE, amount_money: { amount, currency: "GBP" }, location_id: locationId, team_member_id: memberId(item.worker), autocomplete: true });
type Created = typeof plan[number] & { id: string; createdAt: unknown };
const payments: Created[] = [];
const createdPayments: unknown[] = [];
for (const item of plan) {
  const created = await square("POST", "/v2/payments", paymentBody(item));
  const payment = created.body.payment as Json | undefined;
  if (!created.ok || typeof payment?.id !== "string") { report.paymentCreate = { failedOn: item.ref, status: created.status, errors: errorsOf(created.body) }; finish("A GBP Sandbox payment with team_member_id was not accepted."); }
  createdPayments.push(payment);
  payments.push({ ...item, id: payment.id, createdAt: payment.created_at });
}
gate.gbpPaymentsAssociated = true;
const summary = (payment: Json | undefined) => ({ employeeIdSameAsTeamMember: payment?.employee_id === payment?.team_member_id, payment: alias(payment?.id), location: alias(payment?.location_id), amount: (payment?.amount_money as Money | undefined)?.amount ?? null, currency: (payment?.amount_money as Money | undefined)?.currency ?? null, teamMember: alias(payment?.team_member_id), status: payment?.status ?? null });
const matches = (item: Created, payment: Json | undefined) => payment?.id === item.id && payment?.location_id === locationId && (payment?.amount_money as Money | undefined)?.amount === item.amount && (payment?.amount_money as Money | undefined)?.currency === "GBP" && payment?.team_member_id === memberId(item.worker);

async function listPayments() {
  const rows: Json[] = [];
  let cursor: string | undefined;
  const begin = new Date(Date.now() - 2 * 86_400_000).toISOString();
  do {
    const query = new URLSearchParams({ location_id: locationId, begin_time: begin, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await square("GET", `/v2/payments?${query}`);
    rows.push(...((Array.isArray(page.body.payments) ? page.body.payments : []) as Json[]));
    cursor = typeof page.body.cursor === "string" ? page.body.cursor : undefined;
  } while (cursor);
  return rows;
}
// A row that is returned must match exactly: any difference is a conflict, and a conflict is
// NO-GO. A row not returned is counted apart, because a list can lag behind a create. Every
// payment must still be present by the final read.
const rounds: { via: string; found: number; missing: number; conflicting: number }[] = [];
const matrix = new Map<string, Json>();
for (const round of [1, 2, 3]) {
  const gets = await Promise.all(payments.map(item => square("GET", `/v2/payments/${item.id}`)));
  gets.forEach((reply, i) => {
    const payment = reply.body.payment as Json | undefined, item = payments[i];
    if (round === 1) matrix.set(item.ref, { ref: item.ref, worker: item.worker, created: { payment: alias(item.id), location: alias(locationId), amount: item.amount, currency: "GBP", teamMember: alias(memberId(item.worker)) }, readBack: summary(payment), same: matches(item, payment) });
  });
  const direct = gets.map(reply => reply.body.payment as Json | undefined);
  rounds.push({ via: `GET /v2/payments/{id}, read ${round}`, found: direct.filter(Boolean).length, missing: direct.filter(row => !row).length, conflicting: direct.filter((row, i) => row && !matches(payments[i], row)).length });
  const listed = await listPayments();
  const inList = payments.map(item => listed.find(row => row.id === item.id));
  rounds.push({ via: `GET /v2/payments, read ${round}`, found: inList.filter(Boolean).length, missing: inList.filter(row => !row).length, conflicting: inList.filter((row, i) => row && !matches(payments[i], row)).length });
  if (round < 3) await wait(4_000);
}
gate.sameTeamMemberReadBack = [...matrix.values()].every(row => row.same === true);
gate.stableAcrossReads = rounds.every(round => round.conflicting === 0) && rounds.slice(-2).every(round => round.missing === 0);
report.payments = { endpoint: "POST /v2/payments", associationField: "team_member_id", requestFields: Object.keys(paymentBody(plan[0])), sourceUsed: SANDBOX_CARD_SOURCE, returnedFields: fieldsOf(...createdPayments), matrix: [...matrix.values()], readRounds: rounds };

// --- Idempotency: neither call may create an economic event.
const countBefore = (await listPayments()).length;
const replay = await square("POST", "/v2/payments", paymentBody(plan[0]));
const changedReplay = await square("POST", "/v2/payments", paymentBody(plan[0], plan[0].amount + 1));
const countAfter = (await listPayments()).length;
report.idempotency = { sameKeySameBody: { status: replay.status, samePaymentId: (replay.body.payment as Json | undefined)?.id === payments[0].id }, sameKeyDifferentAmount: { status: changedReplay.status, errors: errorsOf(changedReplay.body) }, paymentsAtLocationBefore: countBefore, paymentsAtLocationAfter: countAfter };

// --- Refund: Worker A's first payment, with Worker B named on the refund, so the two
// identities can be told apart if Square keeps both.
const target = payments[0];
const refundCall = await square("POST", "/v2/refunds", { idempotency_key: key("refund:A1"), payment_id: target.id, amount_money: { amount: target.amount, currency: "GBP" }, team_member_id: memberId("B"), reason: "FairShift gate synthetic refund" });
const refund = refundCall.body.refund as Json | undefined;
if (!refundCall.ok || typeof refund?.id !== "string") report.refund = { status: refundCall.status, errors: errorsOf(refundCall.body) };
else {
  const refundId = refund.id;
  const reads: Json[] = [];
  let latest: Json | undefined = refund;
  let linkStable = true;
  for (let round = 0; round < 3; round++) {
    await wait(3_000);
    latest = (await square("GET", `/v2/refunds/${refundId}`)).body.refund as Json | undefined;
    const original = (await square("GET", `/v2/payments/${target.id}`)).body.payment as Json | undefined;
    const refundIds = (Array.isArray(original?.refund_ids) ? original.refund_ids : []) as string[];
    linkStable &&= latest?.payment_id === target.id && refundIds.includes(refundId);
    reads.push({ refundStatus: latest?.status, refundPointsToOriginal: latest?.payment_id === target.id, originalListsRefund: refundIds.includes(refundId), refundedMoney: original?.refunded_money, originalStillCreditedToWorkerA: original?.team_member_id === memberId("A"), originalAmountUnchanged: (original?.amount_money as Money | undefined)?.amount === target.amount, refundCarriesWorkerB: latest?.team_member_id === memberId("B"), refundCarriesWorkerA: latest?.team_member_id === memberId("A") });
  }
  const listedRefunds = await square("GET", `/v2/refunds?location_id=${locationId}&limit=100`);
  const refundRows = (Array.isArray(listedRefunds.body.refunds) ? listedRefunds.body.refunds : []) as Json[];
  report.refund = { endpoint: "POST /v2/refunds", requestFields: ["idempotency_key", "payment_id", "amount_money", "team_member_id", "reason"], returnedFields: fieldsOf(refund, latest), refund: alias(refundId), originalPayment: alias(target.id), originalCreditedTo: alias(memberId("A")), namedOnRefund: alias(memberId("B")), refundTeamMember: alias(latest?.team_member_id), amount: latest?.amount_money, status: latest?.status, linkStableAcrossReads: linkStable, foundInRefundList: refundRows.some(row => row.id === refundId), reads };
}

finish(gate.sameTeamMemberReadBack ? gate.stableAcrossReads ? null : "team_member_id was not stable across reads." : "team_member_id was absent or different when read back.");
