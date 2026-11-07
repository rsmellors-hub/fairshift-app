// Generates fairshift-payouts.postman_collection.json: PayPal Sandbox negative tests for Payouts
// and Subscriptions (PayPal's documented test values: Payouts via items[0].note on create or the
// path ID on GET; Subscriptions via plan_id on create or the path ID). No secrets: credentials come
// from the environment ({{client_id}}, {{client_secret}}); the token is held only in the in-memory environment
// for the run (never exported). Every request asserts the host is the PayPal Sandbox. One call per code.
// Run: node docs/paypal-negative-tests/build-collection.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sandboxCheck = "pm.test('host is the PayPal Sandbox', () => pm.expect(pm.request.url.getHost()).to.eql('api-m.sandbox.paypal.com'));";
// Records status and the PayPal error name/issue only (never a token or full body).
const record = (code, expected) => [
  sandboxCheck,
  "let body = {}; try { body = pm.response.json(); } catch (e) {}",
  "const item = (body.items && body.items[0]) || {};",
  "const name = body.name || (item.errors && item.errors.name) || (body.batch_header && body.batch_header.batch_status) || body.transaction_status || body.status || null;",
  "const issue = (body.details && body.details[0] && body.details[0].issue) || item.transaction_status || null;",
  `console.log(JSON.stringify({ code: '${code}', expected: '${expected}', http: pm.response.code, name, issue, batchId: (body.batch_header && body.batch_header.payout_batch_id) || null }));`,
  `pm.test('${code}: PayPal answered (HTTP ' + pm.response.code + ', ' + name + ')', () => pm.expect(pm.response.code).to.be.a('number'));`,
];
const bearer = { type: "bearer", bearer: [{ key: "token", value: "{{access_token}}", type: "string" }] };
const json = [{ key: "Content-Type", value: "application/json" }];

const token = {
  name: "Get Sandbox OAuth token",
  request: { method: "POST", url: "{{base_url}}/v1/oauth2/token", auth: { type: "basic", basic: [{ key: "username", value: "{{client_id}}" }, { key: "password", value: "{{client_secret}}" }] },
    header: [{ key: "Content-Type", value: "application/x-www-form-urlencoded" }], body: { mode: "urlencoded", urlencoded: [{ key: "grant_type", value: "client_credentials" }] } },
  event: [{ listen: "test", script: { exec: [sandboxCheck, "pm.test('token HTTP ' + pm.response.code, () => pm.expect(pm.response.code).to.eql(200));",
    "const t = pm.response.json().access_token; pm.environment.set('access_token', t); pm.test('token returned', () => pm.expect(!!t).to.eql(true));"] } }],
};
const createPayout = (code, expected) => ({
  name: `Create payout ${code} (${expected})`,
  request: { method: "POST", url: "{{base_url}}/v1/payments/payouts", auth: bearer, header: [...json, { key: "PayPal-Request-Id", value: `FS-NEG-${code}-{{$timestamp}}` }],
    body: { mode: "raw", raw: JSON.stringify({ sender_batch_header: { sender_batch_id: `FS-NEG-${code}-{{$timestamp}}`, email_subject: "FairShift Sandbox negative test" },
      items: [{ recipient_type: "EMAIL", amount: { value: "1.00", currency: "USD" }, receiver: "{{payout_receiver}}", note: code, sender_item_id: `FS-NEG-I-${code}` }] }, null, 2) } },
  event: [{ listen: "test", script: { exec: record(code, expected) } }],
});
const getPayout = (code, expected, path) => ({
  name: `GET ${path} ${code} (${expected})`, request: { method: "GET", url: `{{base_url}}/v1/payments/${path}/${code}`, auth: bearer },
  event: [{ listen: "test", script: { exec: record(code, expected) } }],
});
const subscription = (name, method, path, code, expected, body) => ({
  name: `${name} ${code} (${expected})`, request: { method, url: `{{base_url}}${path}`, auth: bearer, header: json, ...(body ? { body: { mode: "raw", raw: JSON.stringify(body, null, 2) } } : {}) },
  event: [{ listen: "test", script: { exec: record(code, expected) } }],
});

const collection = {
  info: { name: "FairShift PayPal Sandbox negative tests", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description: "PayPal Sandbox only. Test values from https://developer.paypal.com/api/payouts/v5/standard/test-go-live/ and https://developer.paypal.com/subscriptions/test-go-live. Requires Negative Testing On for the Sandbox business account; otherwise PayPal returns real Sandbox responses." },
  variable: [{ key: "access_token", value: "" }],
  item: [
    token,
    { name: "Payouts: create", item: [["ERRPYO005", "INSUFFICIENT_FUNDS"], ["ERRPYO006", "INTERNAL_ERROR"], ["ERRPYO035", "RATE_LIMIT_VALIDATION"], ["ERRPYO036", "REQUEST_TIMEOUT_EXCEEDED"],
      ["ERRPYO038", "NON_HOLDING_CURRENCY"], ["ERRPYO039", "PREVIOUS_REQUEST_IN_PROGRESS"], ["ERRPYO001", "SENDER_RESTRICTED"], ["ERRPYO003", "AUTHORIZATION_ERROR"]].map(([c, e]) => createPayout(c, e)) },
    { name: "Payouts: show", item: [getPayout("ERRPYO018", "DUPLICATE_ITEM", "payouts"),
      ...[["ERRPYO043", "CURRENCY_NOT_SUPPORTED_FOR_RECEIVER"], ["ERRPYO045", "RECEIVER_COUNTRY_NOT_ALLOWED"], ["ERRPYO047", "RECEIVER_UNREGISTERED"], ["ERRPYO049", "RECEIVING_LIMIT_EXCEEDED"], ["ERRPYO052", "RISK_DECLINE"]]
        .map(([c, e]) => getPayout(c, e, "payouts-item"))] },
    { name: "Subscriptions", item: [
      ...[["ERRSUB032", "INTERNAL_SERVER_ERROR"], ["ERRSUB033", "NOT_AUTHORIZED"], ["ERRSUB034", "INVALID_REQUEST"], ["ERRSUB039", "UNPROCESSABLE_ENTITY"]]
        .map(([c, e]) => subscription("Create subscription", "POST", "/v1/billing/subscriptions", c, e, { plan_id: c })),
      ...[["ERRSUB044", "INTERNAL_SERVER_ERROR"], ["ERRSUB046", "RESOURCE_NOT_FOUND"]].map(([c, e]) => subscription("Show subscription", "GET", `/v1/billing/subscriptions/${c}`, c, e)),
      ...[["ERRSUB066", "INTERNAL_SERVER_ERROR"], ["ERRSUB069", "UNPROCESSABLE_ENTITY"]].map(([c, e]) => subscription("Activate subscription", "POST", `/v1/billing/subscriptions/${c}/activate`, c, e, { reason: "FairShift Sandbox negative test" })),
      ...[["ERRSUB063", "INTERNAL_SERVER_ERROR"], ["ERRSUB065", "RESOURCE_NOT_FOUND"]].map(([c, e]) => subscription("Cancel subscription", "POST", `/v1/billing/subscriptions/${c}/cancel`, c, e, { reason: "FairShift Sandbox negative test" })),
    ] },
  ],
};
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "fairshift-payouts.postman_collection.json"), JSON.stringify(collection, null, 2) + "\n");
