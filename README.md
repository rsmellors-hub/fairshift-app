# FairShift

FairShift turns commerce evidence into transparent, approved worker pay. It is being built for the PayPal AI Hackathon 2026. Square Sandbox is the active commerce provider. The first slice below, where a **PayPal sandbox inbound payment** becomes a persisted, reconciled FairShift sale, remains in the repository.

## Hackathon architecture

Reference historical commerce → deterministic demand model → OpenAI bounded interpretation → staffing requirement → worker opportunity → Bryntum allocation → genuine Square Sandbox team-member-attributed commerce → FairShift performance/incentive → manager approval → genuine PayPal Sandbox payout → worker confirmation

| Provider | Responsibility |
| --- | --- |
| Square | Commerce evidence |
| OpenAI | Bounded interpretation and explanation |
| Bryntum | Manager allocation surface |
| FairShift | Business logic, worker and shift identity, compensation, incentive, attribution eligibility, approval |
| PayPal | FairShift subscription infrastructure and worker payout |

The reference company is a fictional five-location UK fast-casual cafe and dining group with synthetic, labelled history. Staffing comes from expected transactions by time of day and the business's own capacity policy, not from sales value. Tips are authorised direction, not implemented. Contextual AI is implemented and verified locally. Retail material in `docs/` is historical evidence.

Current status, Golden Path economics and the MVP refund decision are in [the product specification](docs/FAIRSHIFT_PRODUCT_UX_SPEC.md), section 10. One genuine GBP 121.00 PayPal Sandbox payout on Square-attributed work has completed locally; see `docs/PAYPAL_FINAL_EVIDENCE.md`. The hospitality engine's code is deployed on hosted, but the Golden Path has not been run there; see `docs/HOSTED_RELEASE_002_EVIDENCE.md`. Which document governs what is recorded in [the document authority register](docs/FS-DOCUMENT-AUTHORITY-REGISTER.md).

## PayPal Sandbox

PayPal Sandbox supports an inbound sale proof and a demo shift-incentive payout path. One controlled $25 Sandbox incentive payout has been accepted and reconciled to `PAID`; payouts require a recorded target result and explicit manager approval. No production PayPal functionality is configured.

## Current architecture

- Next.js 16 App Router and React 19, written in TypeScript
- Node.js 24.22.0 LTS and pnpm 12.11.2
- PostgreSQL application state through Drizzle ORM
- Zod validation at environment and PayPal-response boundaries
- Server-only PayPal REST adapters for OAuth, Orders v2, Payments v2, webhook verification, and Payouts v1
- Vitest unit and PostgreSQL-compatible PGlite integration tests

The browser starts a sale and follows the approval URL, but it never receives the PayPal client secret or OAuth token. After buyer approval, the server captures the order and retrieves the capture from PayPal Payments v2. Only a completed capture whose order, currency, and amount match the persisted FairShift transaction becomes `VERIFIED`.

## Prerequisites

- Node.js 24.22.0 (see `.node-version` and `.nvmrc`)
- pnpm 12.11.2
- PostgreSQL 15 or newer
- A PayPal developer account with a sandbox REST app, sandbox business account, and sandbox personal buyer account

## Local setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create a PostgreSQL database and user. One example, adjusted for your local installation, is:

   ```sql
   CREATE ROLE fairshift LOGIN PASSWORD 'choose-a-local-password';
   CREATE DATABASE fairshift OWNER fairshift;
   ```

3. Copy `.env.example` to `.env.local` and replace its placeholders. Never commit that file.

4. Apply the schema and deterministic demo seed:

   ```sh
   pnpm db:migrate
   ```

5. Start the application:

   ```sh
   pnpm dev
   ```

6. Open `http://localhost:3000`. The single seeded outlet is **Rosebank Kitchen**.

Useful verification commands:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Server-side PostgreSQL connection URL. |
| `APP_BASE_URL` | Exact public application origin used in PayPal return and cancel URLs. |
| `PAYPAL_ENV` | Inbound payments environment; must be exactly `sandbox`. |
| `PAYPAL_ENVIRONMENT` | Payout environment; defaults to and accepts only `sandbox`. |
| `PAYPAL_CLIENT_ID` | Sandbox REST app client ID. Used only on the server. |
| `PAYPAL_CLIENT_SECRET` | Sandbox REST app secret. Used only on the server. |
| `PAYPAL_WEBHOOK_ID` | ID of the webhook registered for this application endpoint. |
| `PAYPAL_SANDBOX_CURRENCY` | Must be `USD` in this package. |
| `PAYPAL_SANDBOX_AMOUNT` | Fixed two-decimal technical proof amount; defaults to `5.00`. |
| `COMMERCE_CREDENTIAL_KEY` | Seals commerce credentials at rest. Missing or invalid disables connections. |
| `SQUARE_ENVIRONMENT` | Square environment; only `sandbox` is accepted. |
| `SQUARE_ACCESS_TOKEN` | Square Sandbox access token. Used only on the server. |
| `SQUARE_APPLICATION_ID` | Square Sandbox application ID. Used only on the server. |
| `FAIRSHIFT_DEMO_TOOLS` | Set to `enabled` to offer the Sandbox demo tools. Needs a Sandbox connection as well. |

PayPal client credentials are read only by server code. The worker enters their payout email in the worker view. Do not put real recipient details in source, tests, or documentation. The demo shift target and incentive amount are fixed in its terms; performance is recorded in integer USD cents, earned only when sales meet the target, then separately approved by the manager before a payout can be submitted.

The implementation deliberately uses USD. USD appears in PayPal's current REST currency-code documentation; ZAR does not, so this technical proof does not infer ZAR checkout capability or say anything about Payouts currency support.

## PayPal sandbox setup

1. In the PayPal Developer Dashboard, create or select a sandbox REST app owned by a sandbox business account.
2. Put that app's sandbox client ID and secret into the local, ignored environment file.
3. Use a separate sandbox personal account as the buyer during the approval step. Do not put sandbox account passwords in this repository.
4. Set `APP_BASE_URL` to the origin through which the browser will reach FairShift.
5. Run the application and choose **Create PayPal sandbox sale**. FairShift creates an Orders v2 order with its internal reference in `purchase_units[].custom_id`, redirects to PayPal for buyer approval, then offers server-side capture after PayPal returns.

The UI shows `CONNECTED` only after a PayPal order was successfully created and persisted. Merely setting environment variables does not claim a working connection.

## Webhook setup

Register this HTTPS endpoint on the same sandbox app:

```text
POST https://YOUR_PUBLIC_ORIGIN/api/webhooks/paypal
```

Subscribe only to:

```text
PAYMENT.CAPTURE.COMPLETED
```

Set `PAYPAL_WEBHOOK_ID` to the registered webhook's ID. The endpoint reads the request body once, validates the PayPal transmission headers, and sends the event plus headers to PayPal's `verify-webhook-signature` endpoint. Only a successful verification is admitted to the provider-event inbox. Accepted event IDs are unique, and financial state is then reconciled independently with Payments v2; the webhook body alone is not authoritative.

An existing inbox row is not proof of completed processing. Valid redeliveries retry unfinished `RECEIVED` or `ERROR` events. An event row lock serializes reconciliation, and sale changes, audit evidence, and the terminal event state commit together. Transient provider failures return HTTP 503; unexpected processing failures return HTTP 500. Terminal `PROCESSED` and `IGNORED` duplicates return 200 without reconciling again; terminal `UNMATCHED` duplicates return 202. `PROCESSED` means reconciliation completed, not necessarily that a sale passed verification. These recovery semantics are tested locally, not live-verified with PayPal. See [repair evidence](docs/evidence/FS-HACK-IMPLEMENT-001R.md).

A local-only URL cannot receive PayPal deliveries. Use an HTTPS public deployment or a secure forwarding URL, update both the registered webhook and `APP_BASE_URL`, and retain delivery evidence before upgrading webhook status to live-verified.

## PayPal API surface

| Purpose | Method and endpoint |
| --- | --- |
| Server OAuth | `POST /v1/oauth2/token` |
| Create order | `POST /v2/checkout/orders` |
| Capture approved order | `POST /v2/checkout/orders/{order_id}/capture` |
| Reconcile capture | `GET /v2/payments/captures/{capture_id}` |
| Verify webhook | `POST /v1/notifications/verify-webhook-signature` |
| Submit approved incentive | `POST /v1/payments/payouts` |
| Refresh payout status | `GET /v1/payments/payouts/{payout_batch_id}?fields=items` |

All calls target `https://api-m.sandbox.paypal.com`. Production configuration cannot be selected by environment variable in this package.

## Implementation status

| Capability | Status | Evidence boundary |
| --- | --- | --- |
| Next.js application and evidence UI | IMPLEMENTED | Build and route generation pass. |
| PostgreSQL/Drizzle schema and seed migration | IMPLEMENTED | Migration is applied in the database integration suite. |
| PayPal server adapter | IMPLEMENTED | Deterministic mocked HTTP tests cover success and failure paths. |
| Sandbox order creation, capture, and Payments v2 reconciliation code | IMPLEMENTED | Code and mocked adapter tests pass; no provider IDs are fabricated. |
| Verified, deduplicated webhook inbox | IMPLEMENTED — NOT LIVE-VERIFIED | Endpoint behavior is tested; no public PayPal delivery has reached this environment. |
| Real PayPal sandbox order and capture evidence | IMPLEMENTED — NOT LIVE-VERIFIED | Sandbox credentials are not available in this environment. |
| AI staffing and commercial interpretation | VERIFIED locally | Structured OpenAI assessment validated against calculated figures; see `docs/ROADMAP_RECOVERY.md`. |
| Square Sandbox commerce and team-member attribution | SANDBOX-CONNECTED, active provider | Genuine UK/GBP Sandbox seller, payments and `team_member_id` read back, mapped to a worker and used in the incentive calculation. The demonstrated payments explicitly supplied `team_member_id`, so a physical till identifying the logged-in worker is not verified. Genuine Square history is insufficient for the 28-day threshold, so labelled reference history remains the forecast source. See `docs/SQUARE_LIVE_EVIDENCE.md`. |
| Zettle connected commerce | INACTIVE for the hackathon Golden Path | Connector work retained, built against documented API and mocked provider behaviour. A genuine merchant connection is not verified. |
| Authenticated tenancy | REPOSITORY EVIDENCE; exercised once on hosted | Database sessions, Owner onboarding and invitation-derived scoped memberships. Hosted registration, email verification, PayPal Sandbox subscription approval and invited Manager and Worker accounts completed once for the reference organisation (`docs/HOSTED_RELEASE_002_EVIDENCE.md`); broader hosted verification is pending. |
| Demo shift incentive, manager approval, and PayPal Sandbox payout/status path | SANDBOX-CONNECTED | One controlled $25 Sandbox payout reached `SUCCESS`; FairShift persisted `PAID`, prevented duplicate submission, and refreshed the status. |

## Data and security boundaries

The schema contains organisation/outlet commerce records, shifts/workers/offers, and `shift_incentives`. Monetary values use integer minor units. Incentives are unique per shift and worker; PayPal batch and sender IDs are unique. A payout submission reserves the incentive before calling PayPal; uncertain failures remain locked from duplicate submission, and an existing batch can be queried for its current status.

This slice is intentionally limited to one server-selected outlet, so callers cannot submit an arbitrary outlet ID. Order and capture browser requests require the configured same origin. Webhook verification occurs before provider-event persistence or financial mutation. Raw webhook payloads, access tokens, secrets, and payer personal data are not stored; the inbox retains a SHA-256 payload digest and the minimum normalized provider evidence.

## Known limitations

- No real sandbox order, capture, or webhook delivery has been executed without credentials and a public webhook URL.
- The checkout flow is fixed to one seeded outlet and one configured USD proof amount.
- PayPal inbound refund lifecycle handling is not implemented. Reconciled refunded states cannot count as verified sales, leaving room for a later complete refund workflow. Square refunds follow the MVP refund decision in the product specification.
- Operational HTTP paths require authenticated memberships and organisation/location scope. Internal demo fixtures remain separate and gain no automatic account ownership.
- Background retry processing is deferred. Valid webhook redelivery retries unfinished reconciliation; terminal unmatched events remain quarantined and are not automatically re-evaluated.
- Hosted authentication, email delivery and organisation subscriptions have been exercised once on hosted and still require fuller verification. Existing incentive payout authority remains restricted to the controlled demo; this package adds no production payment authority.
- The inbound order/capture workflow has not been live-verified. The payout evidence is Sandbox-only and does not establish production payment capability. Use only an appropriate PayPal Sandbox recipient and configuration when deliberately exercising an actual transfer.

## Licence

MIT. See [LICENSE](LICENSE).

## Authenticated onboarding and transactional infrastructure

See [authenticated tenancy evidence](docs/AUTHENTICATED_TENANCY_EVIDENCE.md) for the
Owner → organisation → invitation → membership trust chain, Sandbox subscription
boundary, notification outbox, configuration and manual verification checklist.
Start at `/register` or `/sign-in`; invitations never self-assign roles. Email is
UNCONFIGURED until a Resend sender/key is supplied. Subscription billing requires
its own Sandbox plan/webhook configuration and never activates from browser return.
Apply reviewed local migrations before starting the new application paths. Existing
hosted databases must not be migrated without approval.
