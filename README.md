# FairShift

FairShift is an AI-assisted workforce and transparent-payments product being built for the PayPal AI Hackathon 2026. This repository currently contains only the first executable vertical slice: a **PayPal sandbox inbound payment** becomes a persisted, reconciled FairShift sale.

This package is sandbox-only. It does not complete the PayPal + AI competition requirement, and it does not implement payouts.

## Current architecture

- Next.js 16 App Router and React 19, written in TypeScript
- Node.js 24.22.0 LTS and pnpm 12.11.2
- PostgreSQL application state through Drizzle ORM
- Zod validation at environment and PayPal-response boundaries
- A server-only PayPal adapter for OAuth, Orders v2, Payments v2, and webhook verification
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
| `PAYPAL_ENV` | Must be exactly `sandbox`; other values fail validation. |
| `PAYPAL_CLIENT_ID` | Sandbox REST app client ID. Used only on the server. |
| `PAYPAL_CLIENT_SECRET` | Sandbox REST app secret. Used only on the server. |
| `PAYPAL_WEBHOOK_ID` | ID of the webhook registered for this application endpoint. |
| `PAYPAL_SANDBOX_CURRENCY` | Must be `USD` in this package. |
| `PAYPAL_SANDBOX_AMOUNT` | Fixed two-decimal technical proof amount; defaults to `5.00`. |

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
| AI integration | NOT IMPLEMENTED | Deliberately deferred to a later package. |
| Authentication/RBAC UI | NOT IMPLEMENTED | Deliberately out of scope for this package. |
| Payouts, gratuities, incentives, and workforce scheduling | NOT IMPLEMENTED | Deliberately out of scope for this package. |

## Data and security boundaries

The minimum schema contains `organisations`, `outlets`, `paypal_connections`, `sale_transactions`, `provider_events`, and `audit_events`. Money is stored as integer minor units plus a three-letter currency code. Provider event IDs, PayPal order IDs, and PayPal capture IDs are uniquely constrained.

This slice is intentionally limited to one server-selected outlet, so callers cannot submit an arbitrary outlet ID. Order and capture browser requests require the configured same origin. Webhook verification occurs before provider-event persistence or financial mutation. Raw webhook payloads, access tokens, secrets, and payer personal data are not stored; the inbox retains a SHA-256 payload digest and the minimum normalized provider evidence.

## Known limitations

- No real sandbox order, capture, or webhook delivery has been executed without credentials and a public webhook URL.
- The checkout flow is fixed to one seeded outlet and one configured USD proof amount.
- Refund lifecycle handling is not implemented. Reconciled refunded states cannot count as verified sales, leaving room for a later complete refund workflow.
- Authentication and multi-outlet authorization are intentionally deferred. The server pins all current operations to the seeded outlet.
- Background retry processing is deferred. Valid webhook redelivery retries unfinished reconciliation; terminal unmatched events remain quarantined and are not automatically re-evaluated.
- AI and the remaining FairShift closed loop are not implemented.

## Licence

MIT. See [LICENSE](LICENSE).
