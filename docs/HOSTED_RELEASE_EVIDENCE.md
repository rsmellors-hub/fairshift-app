# Hosted Release Evidence (FS-HOSTED-RELEASE-001)

**Status: the release is live on `https://getafairshift.com`, and the product checks have not started.** Branch `fs-square-live-001`, commit `8040c1620d68e07d10418d5baf7ada7ac9612019`. The hosted site is waiting for a five-location UK demo business, which the owner will create through the product.

This document covers the migration, configuration, deployment and public checks only. All of it is **HOSTED EVIDENCE**, apart from the backup restore check and the migration dry run (**LOCAL-ONLY**). It contains no **GENUINE PROVIDER** transaction evidence and no **REFERENCE DATA**. The local GBP 121.00 payout in `PAYPAL_FINAL_EVIDENCE.md` did not happen on this deployment.

## 1. Authorisation

The owner authorised migrating and deploying before the demo business exists, because that business should be onboarded on the release build. The two existing organisations were to stay untouched.

## 2. Backup

| Item | Value |
|---|---|
| Taken | 2026-11-01 11:50:44 UTC, in one repeatable-read, read-only transaction |
| Contents | Every public table plus drizzle's migration record: 3,768 rows in 26 files, with a manifest of row counts and hashes |
| Location | Local machine, outside the repository, owner-only permissions |
| Check | Restored into a throwaway local database at `0010`. All row counts and the sales total matched, and the database was then deleted |

It holds data only. The schema at that point can be rebuilt from migrations `0000`–`0010`. It wasn't a `pg_dump`, because no PostgreSQL 18 client is installed here. It stays until hosted verification is complete.

## 3. Environment (names only)

Set on the Render service, and checked against the intended values without printing them:

`COMMERCE_CREDENTIAL_KEY`, `SQUARE_ENVIRONMENT` (sandbox), `SQUARE_ACCESS_TOKEN`, `SQUARE_APPLICATION_ID`, `FAIRSHIFT_DEMO_TOOLS` (enabled)

Already present and unchanged: `DATABASE_URL`, `APP_BASE_URL`, `EMAIL_FROM`, `NOTIFICATIONS_DISPATCH_SECRET`, `OPENAI_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (sandbox), `PAYPAL_WEBHOOK_ID`, `PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID`, `PAYPAL_SINGLE_OUTLET_ANNUAL_PLAN_ID`, `PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID`, `PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID`, `PAYPAL_SUBSCRIPTION_WEBHOOK_ID`, `RESEND_API_KEY`

`OPENAI_MODEL` and `PAYPAL_ENVIRONMENT` remain unset, and their defaults apply (`gpt-6-luna`, sandbox). Zettle variables are not set.

## 4. Migrations

Applied with `pnpm db:migrate` against the confirmed `fairshift-db` instance, before the deploy.

| Item | Result |
|---|---|
| Before | `0000`–`0010`, hashes and timestamps matching the repository |
| Applied | `0011`, `0012`, `0013`, `0014`, `0015`, `0016`, `0017`, `0018`, `0019`, `0020` |
| After | 21 recorded, all hashes and order matching the repository; 37 public tables |
| `0012` | Affected 0 rows; no location resolves to a UK country |
| `0013` | Affected 0 rows; hosted had 0 work policies |
| Unchanged | Both organisations and locations, including `updated_at`; 3,704 sales totalling 24047750 minor units; 2 incentive records |
| New rows | 0 `REFERENCE` sales, 0 payables, 0 payouts |

The Square, work, performance and payment tables now exist.

## 5. Deployment

| Item | Value |
|---|---|
| Service | `fairshift`, `srv-db8bb1ivcj2c738sr04g` |
| Branch | `main` before, `fs-square-live-001` after. `main` was not merged or changed |
| Revision | `124645c` before, `8040c16` after |
| Deployment | `dep-dbjigdoae00c73eb5fu0`, status `live`, triggered by API |
| Timing | 2026-11-01 11:53:27 to 11:55:28 UTC |
| Plan | Unchanged, 512 MB, which was enough for the build |

Changing the branch didn't start a deploy, so it was triggered explicitly for the exact commit. Auto-deploy remains on, so a later push to this branch will deploy.

## 6. Public checks

| Check | Result |
|---|---|
| `/api/health` on the apex domain, `www` and the Render URL | 200, `ready`, database `CONNECTED`, PayPal `SANDBOX_CONFIGURED` |
| `/`, `/sign-in`, `/register` | 200, no console errors, no Zettle wording, no page overflow |
| `/owner`, `/manager/review`, `/worker` signed out | Redirect to `/sign-in` |
| Logs | No migration mentions at start-up, and none of the local secret values |
| Earlier log errors | 6 `Server Reference ID` errors from 2026-10-30, on the old build, before this release |

Screenshots: `01-hosted-landing.png`, `02-hosted-sign-in.png`, `03-hosted-register.png`, `04-hosted-health.png`, `05-hosted-landing-390.png`. The two `local-paypal-reference-*` files are **LOCAL-ONLY**, from a local build.

## 7. Outstanding, and why

- **Demo business and accounts:** the two existing organisations are not the demo business. The owner creates it through the product, which also tests hosted email and PayPal subscription approval for the first time.
- **Reference history:** not loaded, because it needs the five locations. The dataset ends on 2025-12-28. Whether that gap harms the demo needs reporting before the load.
- **Product checks:** Owner, Manager, Worker, Square, OpenAI, PayPal boundary and negative checks all need those accounts.

## 8. Untouched

"FairShift Demo Organisation" (Rosebank), "FairShift Demo" (its South African location), the `DEMO_SEEDED` sales and the old incentive records.

No Square payment, PayPal payout, PayPal subscription or OpenAI generation was started in this work. Provider contact was limited to sign-in checks and a Square location read during the preceding audit.
