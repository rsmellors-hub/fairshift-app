# FS-HACK-IMPLEMENT-001 Evidence

> Historical package record. Independent review subsequently found a webhook recovery defect that the original 37 tests did not cover. FS-HACK-IMPLEMENT-001R repairs it and supersedes the original recovery/completeness claims; see the addendum below and [repair evidence](FS-HACK-IMPLEMENT-001R.md).

## Executive record

- Implementation date: 2026-10-14 (Africa/Johannesburg)
- Starting commit: `1fa9ba5ddbe228e5a132019840dea5cfbd198917`
- Branch: `main`
- Ending commit: unchanged; no commit was authorised or created
- Code-level result: complete and verified
- Integration-level result: **SANDBOX EXECUTION BLOCKED — CREDENTIALS REQUIRED**
- Package classification: **PASS — SANDBOX EXECUTION BLOCKED**

The repository began clean with only project controls. This package establishes the executable Next.js/PostgreSQL foundation and the PayPal sandbox inbound-payment path without claiming that a real sandbox transaction or public webhook delivery occurred.

## Architecture decisions

1. Node.js 24.22.0 LTS is pinned in `.node-version`, `.nvmrc`, and `package.json`; pnpm 12.11.2 is pinned through `packageManager`.
2. Next.js App Router routes run on the Node.js runtime. PayPal credentials and OAuth tokens remain server-only.
3. PostgreSQL is authoritative application state; Drizzle defines and migrates only the six tables needed for this slice.
4. The browser uses a redirect approval flow. FairShift creates the order on the server, sends the buyer to the provider-supplied sandbox approval URL, and captures only after PayPal returns the order token.
5. `purchase_units[].custom_id` contains the FairShift internal transaction reference, while `reference_id` contains the server-selected outlet reference.
6. Capture completion is not trusted from the capture response or webhook alone. Payments v2 capture retrieval supplies the reconciliation evidence, and deterministic rules compare capture ID, related order ID, currency, amount, and provider status.
7. The webhook uses PayPal's supported postback verification endpoint. The Next.js route reads the request body once, parses it once, verifies it before persistence or financial mutation, and deduplicates provider event IDs before reconciliation.
8. Raw provider payloads and payer data are not persisted. The provider inbox retains a SHA-256 digest and minimum normalized evidence.
9. The technical proof currency is USD 5.00. PayPal's current REST currency list includes USD and does not list ZAR; this package therefore makes no ZAR claim and does not conflate checkout with Payouts.
10. PGlite supplies isolated PostgreSQL-compatible database tests. A production connection uses `pg` and the same generated SQL migration.

## Documentation verified

Official sources consulted before implementation:

- Node.js release status: <https://nodejs.org/en/about/previous-releases>
- PayPal REST currency codes: <https://developer.paypal.com/api/rest/reference/currency-codes/>
- PayPal Orders v2, including `custom_id`: <https://developer.paypal.com/docs/api/orders/v2/>
- PayPal Payments v2 capture retrieval: <https://developer.paypal.com/docs/api/payments/v2/#captures_get>
- PayPal webhook signature verification: <https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature_post>
- PayPal webhook event names: <https://developer.paypal.com/api/rest/webhooks/event-names/>

No documented behavior contradicted the task's verified PayPal direction. No `PAYPAL API VERIFICATION BLOCKER` was encountered.

## PayPal APIs and endpoints implemented

All provider calls are constructed from the fixed sandbox base URL `https://api-m.sandbox.paypal.com`.

| Purpose | Endpoint | Implementation |
| --- | --- | --- |
| OAuth client credentials | `POST /v1/oauth2/token` | Server adapter with in-memory expiry-aware token cache. |
| Create sandbox order | `POST /v2/checkout/orders` | Server adapter; `CAPTURE` intent, custom/reference IDs, fixed USD proof amount, return/cancel URLs. |
| Capture approved order | `POST /v2/checkout/orders/{order_id}/capture` | Server adapter with stable `PayPal-Request-Id`. |
| Reconcile capture | `GET /v2/payments/captures/{capture_id}` | Explicit reconciliation service. |
| Verify webhook signature | `POST /v1/notifications/verify-webhook-signature` | Required transmission headers plus configured webhook ID. |

FairShift application routes:

| Route | Purpose |
| --- | --- |
| `POST /api/paypal/orders` | Create a persisted pending transaction and real sandbox order. |
| `POST /api/paypal/orders/[orderId]/capture` | Capture the approved persisted order, then reconcile. |
| `POST /api/webhooks/paypal` | Verify, deduplicate, persist, and process `PAYMENT.CAPTURE.COMPLETED`. |
| `GET /api/health` | Fail-closed configuration/database readiness. |

## Database migration

Migration: `drizzle/0000_fairshift_paypal_inbound.sql`

It creates:

- `organisations`
- `outlets`
- `paypal_connections`
- `sale_transactions`
- `provider_events`
- `audit_events`

The migration seeds one organisation, one outlet (`Rosebank Kitchen`), and its sandbox-only PayPal connection record. Money uses integer minor units plus currency code. Unique indexes protect internal references, PayPal order IDs, PayPal capture IDs, and PayPal event IDs. Check constraints bound reconciliation, verification, processing, and connection states.

The generated migration is applied afresh by every database integration test. A local external PostgreSQL server was not present, so `pnpm db:migrate` was not run against a persistent service; the PostgreSQL-compatible PGlite runs succeeded.

## Checkout, webhook, and reconciliation evidence

### Checkout/capture

1. Server creates a pending FairShift sale pinned to the seeded outlet.
2. Server creates a PayPal sandbox order and persists only the returned provider ID.
3. Browser follows the returned PayPal approval link.
4. PayPal returns the order token to `/checkout/return`.
5. Same-origin browser request asks the server to capture that persisted order.
6. Order ID, custom ID, amount, and currency are validated before attaching the capture ID.
7. Payments v2 capture retrieval runs before `VERIFIED` can be written.

### Webhook

1. Route reads the raw request representation once.
2. Required PayPal transmission headers and HTTPS PayPal certificate URL are validated.
3. Event shape is minimally validated.
4. PayPal postback signature verification must return `SUCCESS`.
5. A unique provider-event row is inserted before financial processing; duplicates return without invoking reconciliation again.
6. Only `PAYMENT.CAPTURE.COMPLETED` is processed. Other verified event types are retained as `IGNORED`.
7. Capture state is retrieved independently from Payments v2. Unmatched events are retained as `UNMATCHED` with HTTP 202.

### Deterministic status rules

- Provider `COMPLETED` + matching evidence -> reconciliation `RECONCILED`, verification `VERIFIED`.
- Provider `PENDING` + matching evidence -> reconciliation `PENDING`, verification `PENDING`.
- `FAILED`, `DECLINED`, `REFUNDED`, or `PARTIALLY_REFUNDED` -> not verified.
- Any order/currency/amount/capture evidence mismatch -> reconciliation `ERROR`, verification `FAILED`.

## Security controls checked

- Sandbox-only environment validation fails closed; production cannot be selected accidentally.
- Secret and database environment variables are server-only and absent from client components.
- `.env` and `.env.local` are ignored; `.env.example` contains names and empty placeholders only.
- OAuth tokens are kept only in server memory and are never logged.
- PayPal errors exposed to the browser are normalized codes, not raw provider bodies.
- Browser order and capture mutations require the configured exact origin.
- The browser cannot supply an outlet ID; repository operations are scoped to the seeded outlet.
- Webhook verification happens before event persistence or sale mutation.
- Duplicate event delivery does not invoke reconciliation twice.
- No raw webhook body or unnecessary payer/customer personal data is persisted.
- Provider identifiers have database uniqueness constraints.
- Financial audit events retain correlation and normalized evidence without credentials.
- `git diff --check` passed, and the secret-surface review found only environment variable references and explicit test placeholders.

## Tests

Final command: `pnpm test`

Result: **PASS**

- Test files: 5 passed
- Tests: 37 passed
- Duration: 8.60 seconds

Coverage represented in the suite:

- money parsing and minor-unit conversion;
- PayPal capture status mapping and reconciliation rules;
- token failure;
- order creation success and HTTP failure;
- capture success and HTTP failure;
- capture retrieval;
- malformed provider response;
- timeout and network failure classification;
- outlet association;
- duplicate capture protection;
- completed capture verification only after retrieval/reconciliation;
- non-completed captures cannot become verified;
- missing webhook headers;
- failed webhook verification before persistence;
- valid verified capture event;
- duplicate event without repeat reconciliation;
- unknown event type;
- unmatched capture/reference.

All PayPal HTTP tests are deterministic mocks. They are not represented as sandbox evidence.

## Build and quality commands

Final commands were run under Node.js 24.22.0 and pnpm 12.11.2:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS; lockfile current, 387 packages restored, approved native build scripts completed. |
| `pnpm lint` | PASS; exit 0, no findings. |
| `pnpm typecheck` | PASS; exit 0. |
| `pnpm test` | PASS; 5 files and 37 tests. |
| `pnpm build` | PASS; production compilation, type analysis, and route generation completed. |

Runtime smoke test:

- `next dev --hostname 127.0.0.1 --port 3210`: ready in 250 ms.
- `GET /`: HTTP 200, visibly reported PayPal and PostgreSQL as `NOT CONFIGURED`, webhook as `IMPLEMENTED / NOT YET LIVE-VERIFIED`, and AI as `NOT IMPLEMENTED`.
- `GET /api/health`: HTTP 503 with `database: NOT_CONFIGURED` and `paypal: NOT CONFIGURED`, demonstrating fail-closed behavior without credentials.

Notable intermediate correction: TypeScript 7 was initially selected by an unconstrained install but was incompatible with the current Next ESLint parser. Dependencies were then exact-pinned to TypeScript 6.0.3 and the complete final suite passed. pnpm's required build allowlist is explicit in `pnpm-workspace.yaml`.

## Real sandbox execution

Environment inspection found all of these unset:

- `DATABASE_URL`
- `PAYPAL_ENV`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_WEBHOOK_ID`

Accordingly:

| Sandbox action | Attempted | Actual result |
| --- | --- | --- |
| Obtain PayPal OAuth token | No | Blocked before request: sandbox app credentials absent. |
| Create real sandbox order | No | Blocked before request: sandbox app credentials absent. |
| Approve with sandbox buyer | No | No real order existed. |
| Capture and retrieve provider capture | No | No approved order existed. |
| Persist real PayPal provider IDs | No | No provider call occurred; no IDs were manufactured. |
| Receive public sandbox webhook | No | No public HTTPS URL or registered webhook ID was available. |

Provider IDs obtained: **none**.

This is accurately classified as `IMPLEMENTED — NOT LIVE-VERIFIED`, not a real completed PayPal integration proof.

## Exact setup required to unblock sandbox execution

1. A reachable PostgreSQL database and server-only `DATABASE_URL`.
2. A PayPal sandbox business account and REST app.
3. The app's sandbox `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
4. A PayPal sandbox personal buyer account for browser approval.
5. A public HTTPS `APP_BASE_URL` reachable by PayPal.
6. A sandbox webhook registered at `${APP_BASE_URL}/api/webhooks/paypal`, subscribed only to `PAYMENT.CAPTURE.COMPLETED`.
7. The resulting `PAYPAL_WEBHOOK_ID`.
8. Run `pnpm db:migrate`, `pnpm dev` (or deploy), perform the browser flow, and retain order/capture/webhook/persisted-state evidence without secrets or payer PII.

## Files changed or created

- Root/tooling: `.gitignore`, `.env.example`, `.node-version`, `.nvmrc`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `next-env.d.ts`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `drizzle.config.ts`
- Project/legal docs: `README.md`, `LICENSE`, `docs/evidence/FS-HACK-IMPLEMENT-001.md`
- Migration: `drizzle/0000_fairshift_paypal_inbound.sql`, `drizzle/meta/*`
- Application shell and routes: `src/app/**`
- Server implementation: `src/server/**`
- Migration runner: `scripts/migrate.ts`
- Test suite and helpers: `tests/**`

`AGENTS.md` remains unchanged. Next.js 16.4's automatic agent-rule mutation is disabled in `next.config.ts` to protect the repository's controlling instructions.

## Final Git state

- HEAD remains `1fa9ba5ddbe228e5a132019840dea5cfbd198917` on `main`.
- No commit was created.
- Existing tracked file modified: `.gitignore` only.
- All implementation files listed above are untracked additions pending owner review.
- No `.env`, credential, access token, sandbox password, provider ID, or payer information is present in Git status.

## Remaining blocker and next action

**SANDBOX EXECUTION BLOCKED — CREDENTIALS REQUIRED**

The recommended next action is to provision the exact sandbox/database inputs above, deploy or expose the HTTPS endpoint, execute one USD 5.00 buyer-approved transaction, verify the `PAYMENT.CAPTURE.COMPLETED` delivery, and capture redacted evidence of the order ID, capture ID, persisted transaction, and `VERIFIED` reconciliation state.

## FS-HACK-IMPLEMENT-001R recovery addendum — 2026-10-14

The mandatory FS-HACK-IMPLEMENT-002 foundation review discovered that an event inserted as `RECEIVED` remained unfinished after a transient capture-retrieval failure. The duplicate branch equated row existence with completed processing and returned HTTP 200 on redelivery without another reconciliation attempt. The original suite covered successful deduplication, but not failure/redelivery recovery.

A permanent regression test was added first and failed before the repair: expected `PROCESSED`, received `RECEIVED` with HTTP 200. The repair uses the existing state model: unfinished events retry under a row lock; reconciliation, its audit, event completion, and the processing audit commit atomically. A failure rolls back those changes while preserving the original verified inbox record for redelivery. Terminal `PROCESSED`, `IGNORED`, and `UNMATCHED` events retain their prior acknowledgement semantics. No schema or migration changes were needed.

New coverage includes failure/redelivery recovery, repeated network/provider/generic failures, rollback after reconciliation, overlapping deliveries, terminal deduplication, malformed JSON, amount/currency/order mismatches, and HTTP 503/500 followed by successful HTTP 200 redelivery. Existing tests remain intact. Final verification: `pnpm install --frozen-lockfile`, `pnpm test` (52 tests in 6 files), `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed under Node 24.22.0 and pnpm 12.11.2. HTTP smoke checks returned 200 for `/` and the expected fail-closed 503 for `/api/health` without configuration. See the repair record for command details and checkpoint review.

PayPal remains **IMPLEMENTED — NOT LIVE-VERIFIED**. No real OAuth request, sandbox order/capture, or public webhook delivery was performed. The database template now leaves `DATABASE_URL` blank; no real credentials are included. This addendum preserves the original development evidence rather than rewriting it.
