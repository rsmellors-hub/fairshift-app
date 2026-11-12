# FairShift

**Fair shifts, paid fast.** FairShift helps a multi-location café or restaurant plan casual shifts from its own sales history, offer them fairly, and pay workers through PayPal once the work is confirmed: the worker's pay in their own currency first, with every amount, rate and reference visible.

Live (PayPal Sandbox): **https://getafairshift.com**

> **Sandbox only.** This deployment uses PayPal Sandbox and Square Sandbox. No real money moves. The demo business, Jacaranda Table, is fictional; its sales history is labelled synthetic.

## What it does

- **Set up a business** from scratch: account, email confirmation, a 30-day trial through PayPal Subscriptions (Sandbox), each venue with a confirmed map pin and its customer types, sales history (Square, a CSV upload, or labelled sample history), pay terms checked against the minimum wage, and team invitations.
- **Plan** next week from expected transactions by time of day: what's covered, what's still needed, and local signals (events, weather, closures) found by AI with their sources. Nothing changes staffing until a person accepts it.
- **Fill shifts** from suggested shifts cut to the location's rules (4–8 h by default), offered fairly: first to workers who want more hours, then to everyone eligible.
- **Workers** see offers with the full terms (pay, the wage check, the tip rule, cancellation pay), accept or decline, and follow their shifts, Inbox and pay in a mobile app.
- **Pay**: a manager confirms the hours, the Pay Agent checks the work, the Owner approves, and FairShift sends the payout through PayPal Payouts. It shows **Paid ✓ only when PayPal reports SUCCESS**, with the ECB rate it locked and the PayPal batch reference. Workers get a paid email and can query any shift's pay.
- **PayPal & AI records**: every PayPal call and AI call with its identifiers, downloadable as CSV.

## How PayPal is used

| PayPal API | Used for | Code |
| --- | --- | --- |
| OAuth 2.0 (`/v1/oauth2/token`) | Server-to-server access tokens | `src/server/integrations/paypal/` |
| Payouts (`/v1/payments/payouts`) | Paying workers for confirmed, approved shifts; status reconciliation by batch | `payout-client.ts` (`createPayout`, `getPayout`) |
| Subscriptions (`/v1/billing/subscriptions`, `/v1/billing/plans`) | Venues' 30-day trial and monthly or annual plan | `src/server/billing/paypal.ts` |
| Webhook verification (`/v1/notifications/verify-webhook-signature`) | Trusting subscription and payment events only when PayPal signs them | `client.ts` (`verifyWebhookSignature`) |
| Orders and Captures (`/v2/checkout/orders`, `/v2/payments/captures`) | Sandbox sale proof (inbound payment) | `client.ts` |

Rand can't be sent through PayPal, so a rand payout is sent in US dollars at the European Central Bank reference rate, locked when the payout is created. Each payable has a deterministic `sender_batch_id`, so a retry can never pay twice; an unknown or timed-out result goes to reconciliation, never to Paid.

## How AI is used

AI (OpenAI, a configured model) suggests and checks; **it never sets an amount, picks a worker or books a shift.**

- **Local signals**: for each location, an OpenAI web search for events and closures that could change demand, each with a source page that FairShift fetches and checks; hourly weather from Open-Meteo; South African public holidays from Nager.Date; and, where an API key is configured, Ticketmaster event listings near the venue. A demand change applies only after an Owner or Manager accepts it.
- **Staffing briefing**: explains which gaps to fill first, citing the figures.
- **Pay Agent**: checks each confirmed shift (hours, overlaps, timing, records) before payout. It can recommend settling or holding; holds go to the Owner, who decides with a written reason.

All pay, forecasts and staffing figures are deterministic code.

## Architecture

Next.js (App Router, server actions) and React, in TypeScript · PostgreSQL with Drizzle ORM and SQL migrations · PayPal REST (Payouts, Subscriptions, webhooks) · OpenAI Responses API · Square Sandbox (commerce evidence) · Resend (email) · Bryntum Scheduler (schedule view) · hosted on Render.

```
sales history → forecast by time of day → staffing gap → suggested shifts → offers → acceptance
→ confirmed work → Pay Agent check → Owner approval → PayPal payout → SUCCESS → Paid ✓
```

## Run it locally

Requirements: Node.js 24, pnpm, PostgreSQL.

```bash
pnpm install
cp .env.example .env.local      # set DATABASE_URL, then your own Sandbox values; never commit them
pnpm db:migrate                 # reads .env.local
pnpm dev
```

Only `DATABASE_URL` is required. `.env.example` lists every variable the code reads, one line each.

Without PayPal, OpenAI, Square or Resend credentials the app still runs: those features say they're not configured, and nothing is invented in their place.

## Tests

```bash
pnpm typecheck
pnpm lint
pnpm test          # Vitest: unit and integration suites (in-process PostgreSQL)
pnpm build
```

PayPal Sandbox negative tests (Postman and Newman) are in `docs/paypal-negative-tests/`.

`docs/` holds working notes from the build; where they differ from this README, the README describes the submitted build.

## Licence

MIT. See [LICENSE](LICENSE).
