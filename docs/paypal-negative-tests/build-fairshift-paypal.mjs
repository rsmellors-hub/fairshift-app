// Generates fairshift-paypal.postman_collection.json and the placeholder environment template: PayPal Sandbox
// negative tests over the REST API (Owner instruction, 11 Nov 2026), plus one positive control.
// - Sandbox only: every request asserts the host is api-m.sandbox.paypal.com before anything else.
// - No secrets: credentials come from the environment ({{client_id}}, {{client_secret}}); the token is set only
//   in the run's environment and stripped from saved reports.
// - One call per code. Each test asserts PayPal's documented error name and the HTTP status PayPal returned for
//   that code in the 7 Nov 2026 run (newman-summary-2026-11-07.json). Where PayPal answers differently, the
//   test fails and the report keeps what PayPal actually returned: no pass is faked.
// Run: node docs/paypal-negative-tests/build-fairshift-paypal.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SIMULATOR = "payouts-simulator-receiver@paypal.com";
const sandboxCheck = "pm.test('host is the PayPal Sandbox', () => pm.expect(pm.request.url.getHost()).to.eql('api-m.sandbox.paypal.com'));";
const parse = [
  "let body = {}; try { body = pm.response.json(); } catch (e) {}",
  "const item = (body.items && body.items[0]) || {};",
  "const name = body.name || (body.errors && body.errors.name) || (item.errors && item.errors.name) || null;",
  "const issue = (body.details && body.details[0] && body.details[0].issue) || null;",
  "const status = body.transaction_status || item.transaction_status || (body.batch_header && body.batch_header.batch_status) || body.status || null;",
];
// What PayPal returned, without tokens or full bodies.
const log = code => `console.log(JSON.stringify({ code: '${code}', http: pm.response.code, name, issue, status, batchId: (body.batch_header && body.batch_header.payout_batch_id) || body.payout_batch_id || null, debugId: body.debug_id || null }));`;
const expectHttp = http => `pm.test('HTTP ${http} (got ' + pm.response.code + ')', () => pm.expect(pm.response.code).to.eql(${http}));`;
const expectName = expected => `pm.test('error name ${expected} (got ' + name + ')', () => pm.expect(name).to.eql('${expected}'));`;
const bearer = { type: "bearer", bearer: [{ key: "token", value: "{{access_token}}", type: "string" }] };
const json = [{ key: "Content-Type", value: "application/json" }];
const test = exec => [{ listen: "test", script: { type: "text/javascript", exec } }];

const token = {
  name: "POST /v1/oauth2/token → 200",
  request: { method: "POST", url: "{{base_url}}/v1/oauth2/token", auth: { type: "basic", basic: [{ key: "username", value: "{{client_id}}", type: "string" }, { key: "password", value: "{{client_secret}}", type: "string" }] },
    header: [{ key: "Content-Type", value: "application/x-www-form-urlencoded" }], body: { mode: "urlencoded", urlencoded: [{ key: "grant_type", value: "client_credentials" }] } },
  event: test([sandboxCheck, expectHttp(200), "const t = pm.response.json().access_token; pm.environment.set('access_token', t); pm.test('token returned', () => pm.expect(!!t).to.eql(true));"]),
};
const payoutBody = (id, value, note) => JSON.stringify({ sender_batch_header: { sender_batch_id: `FS-NEG-${id}-{{$timestamp}}`, email_subject: "FairShift Sandbox negative test" },
  items: [{ recipient_type: "EMAIL", amount: { value, currency: "USD" }, receiver: SIMULATOR, ...(note ? { note } : {}), sender_item_id: `FS-NEG-I-${id}` }] }, null, 2);
const createPayout = (code, expected, http) => ({
  name: `POST /v1/payments/payouts · note ${code} → ${http} ${expected}`,
  request: { method: "POST", url: "{{base_url}}/v1/payments/payouts", auth: bearer, header: [...json, { key: "PayPal-Request-Id", value: `FS-NEG-${code}-{{$timestamp}}` }], body: { mode: "raw", raw: payoutBody(code, "1.00", code) } },
  event: test([sandboxCheck, ...parse, log(code), expectHttp(http), expectName(expected)]),
});
const getItem = (code, expected, transactionStatus) => ({
  name: `GET /v1/payments/payouts-item/${code} → 200 ${transactionStatus} (${expected})`,
  request: { method: "GET", url: `{{base_url}}/v1/payments/payouts-item/${code}`, auth: bearer },
  event: test([sandboxCheck, ...parse, log(code), expectHttp(200), `pm.test('transaction status ${transactionStatus} (got ' + status + ')', () => pm.expect(status).to.eql('${transactionStatus}'));`, expectName(expected)]),
});
const getBatch = (code, expected) => ({
  name: `GET /v1/payments/payouts/${code} → ${expected}`,
  request: { method: "GET", url: `{{base_url}}/v1/payments/payouts/${code}`, auth: bearer },
  event: test([sandboxCheck, ...parse, log(code), expectHttp(200), expectName(expected)]),
});
const createSubscription = (code, expected, http) => ({
  name: `POST /v1/billing/subscriptions · plan_id ${code} → ${http} ${expected}`,
  request: { method: "POST", url: "{{base_url}}/v1/billing/subscriptions", auth: bearer, header: [...json, { key: "PayPal-Request-Id", value: `FS-NEG-${code}-{{$timestamp}}` }], body: { mode: "raw", raw: JSON.stringify({ plan_id: code }, null, 2) } },
  event: test([sandboxCheck, ...parse, log(code), expectHttp(http), expectName(expected)]),
});
const getSubscription = (code, expected, http) => ({
  name: `GET /v1/billing/subscriptions/${code} → ${http} ${expected}`,
  request: { method: "GET", url: `{{base_url}}/v1/billing/subscriptions/${code}`, auth: bearer, header: json },
  event: test([sandboxCheck, ...parse, log(code), expectHttp(http), expectName(expected)]),
});
// Positive control: a US$0.01 payout to PayPal's simulator receiver, then one status read after a single wait.
const positiveCreate = {
  name: "POST /v1/payments/payouts · US$0.01 to the simulator → 201",
  request: { method: "POST", url: "{{base_url}}/v1/payments/payouts", auth: bearer, header: [...json, { key: "PayPal-Request-Id", value: "FS-POS-{{$timestamp}}" }], body: { mode: "raw", raw: payoutBody("POSITIVE", "0.01") } },
  event: test([sandboxCheck, ...parse, log("POSITIVE"), expectHttp(201), "pm.environment.set('positive_batch_id', (body.batch_header && body.batch_header.payout_batch_id) || '');", "pm.test('batch ID returned', () => pm.expect(!!(body.batch_header && body.batch_header.payout_batch_id)).to.eql(true));"]),
};
const positiveRead = {
  name: "GET /v1/payments/payouts/{positive batch} → item SUCCESS",
  request: { method: "GET", url: "{{base_url}}/v1/payments/payouts/{{positive_batch_id}}", auth: bearer },
  event: [{ listen: "prerequest", script: { type: "text/javascript", exec: ["// One wait for PayPal Sandbox to process the item; not a loop.", "setTimeout(() => {}, 20000);"] } },
    ...test([sandboxCheck, ...parse, log("POSITIVE"), expectHttp(200), "pm.test('item transaction status SUCCESS (got ' + status + ')', () => pm.expect(status).to.eql('SUCCESS'));"])],
};

const collection = {
  info: { name: "FairShift PayPal Sandbox negative tests", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description: "PayPal Sandbox only. Negative testing must be enabled on the platform app's Sandbox business account. Each request asserts PayPal's documented error name and the HTTP status PayPal returned on 7 Nov 2026; differences fail and are recorded. Generated by build-fairshift-paypal.mjs." },
  item: [
    token,
    createPayout("ERRPYO005", "INSUFFICIENT_FUNDS", 422),
    createPayout("ERRPYO006", "INTERNAL_ERROR", 500),
    createPayout("ERRPYO036", "REQUEST_TIMEOUT_EXCEEDED", 504),
    createPayout("ERRPYO038", "NON_HOLDING_CURRENCY", 400),
    createPayout("ERRPYO035", "RATE_LIMIT_VALIDATION", 429),
    createPayout("ERRPYO039", "PREVIOUS_REQUEST_IN_PROGRESS", 400),
    getItem("ERRPYO043", "CURRENCY_NOT_SUPPORTED_FOR_RECEIVER", "DENIED"),
    getItem("ERRPYO045", "RECEIVER_COUNTRY_NOT_ALLOWED", "FAILED"),
    getItem("ERRPYO047", "RECEIVER_UNREGISTERED", "UNCLAIMED"),
    getBatch("ERRPYO018", "DUPLICATE_ITEM"),
    createSubscription("ERRSUB032", "INTERNAL_SERVER_ERROR", 500),
    getSubscription("ERRSUB044", "INTERNAL_SERVER_ERROR", 500),
    positiveCreate,
    positiveRead,
  ],
};
const template = {
  name: "FairShift PayPal Sandbox (TEMPLATE: fill locally, never commit values)",
  values: ["base_url", "client_id", "client_secret", "access_token"].map(key => ({ key, value: "", type: "secret", enabled: true })),
  _postman_variable_scope: "environment",
};
writeFileSync(join(here, "fairshift-paypal.postman_collection.json"), JSON.stringify(collection, null, 2) + "\n");
writeFileSync(join(here, "fairshift-sandbox.postman_environment.template.json"), JSON.stringify(template, null, 2) + "\n");
console.log(`collection: ${collection.item.length} requests; template: ${template.values.map(v => v.key).join(", ")}`);
