# Hosted Rehearsal Evidence (FS-HOSTED-REHEARSAL-001)

**Status: the release is deployed and healthy, and the rehearsal is blocked.** `getafairshift.com` doesn't resolve because the domain is on registry hold. No demo business exists, and no genuine Golden Path run has happened on this release.

All of this is **HOSTED EVIDENCE**, except where marked. It contains no **GENUINE PROVIDER** transaction evidence: no Square payment, PayPal payout, PayPal subscription or OpenAI generation was started.

## 1. Authorisation

The owner authorised this package after reviewing FS-UI-PRODUCT-001. Demo Access stays off until a genuine rehearsal is complete.

## 2. Backup

| Item | Value |
|---|---|
| Method | Node client, one repeatable-read, read-only transaction, before the migration |
| Contents | 38 tables including drizzle's migration record, 3,787 rows, with a manifest of row counts and hashes |
| Location | Local machine, outside the repository, owner-only permissions. It holds account data, including password hashes |
| Restore check | **Not done** for this backup. The migration is additive and nothing has needed restoring |

## 3. Migration

| Item | Result |
|---|---|
| Applied | `0021_cultured_talon`, using `pnpm db:migrate` with `sslmode=require` set for that one command. `.env.local` is unchanged |
| First attempt | Refused with `SSL/TLS required`, so nothing was applied |
| After | 22 recorded, matching the journal |
| Added | `auth_sessions.demo_persona` and `demo_group`, both nullable, and two check constraints |
| Row counts | Unchanged in every table, except the migration record (21 to 22) |
| Demo sessions | 0 |

## 4. Deployment

| Item | Value |
|---|---|
| Commit | `e7fcdf9d4dad5afd9bff750c73952d9699c488ad` on `fs-square-live-001`. `main` was not merged |
| Before | `8040c16` |
| Deployment | `dep-dbjon53ncjis73dr8m50`, status `live`, triggered by the push |
| Timing | Render's record: 2026-11-01 18:57:24 to 18:59:14 UTC |
| Environment | No variable changed. `FAIRSHIFT_PUBLIC_DEMO` is not set |

## 5. Public checks

Against `https://fairshift-n84v.onrender.com`, the service's Render URL, read-only. No form was submitted and no account created. Screenshots: `docs/evidence/fs-hosted-rehearsal-001/`.

| Check | Result |
|---|---|
| `/api/health` | `ready`, database `CONNECTED`, PayPal `SANDBOX_CONFIGURED` |
| `/`, `/product`, `/pricing`, `/faq`, `/sign-in`, `/register` | Load with no page overflow, console errors or banned copy, at the widths captured (1440 or 1366, and 390 for `/` and `/register`) |
| `/demo` | "The demo isn't open right now", with no entry forms: fails closed |
| `/owner`, `/manager/review`, `/worker`, `/account`, `/subscribe`, `/check-email` signed out | Redirect to `/sign-in` |
| Render error logs since the deploy | The query returned 0 lines |

**Corrected on the way:** the first pass ran against `getafairshift.com` and reported "ok" on Chrome's error page. It was discarded and the script now detects an unreachable site. Those screenshots were deleted.

## 6. Blocker: the domain is on hold

| Item | Value |
|---|---|
| Registry status | `clientHold`, plus transfer and update prohibited |
| Registrar | Tucows Domains Inc. |
| Record updated | 2026-11-01 15:16:17 UTC |
| Expiry | 2027-10-15, so expiry is not the cause |
| DNS | NXDOMAIN at both 1.1.1.1 and 8.8.8.8 |
| Render | Both custom domains still show verified |

The cause of the hold is **NOT VERIFIED**. A `clientHold` is set by the registrar or reseller. A common cause is an unconfirmed registrant email, but only the registrar can say. This work didn't touch the domain.

**The hold blocks the rehearsal, not just the address:**

- `APP_BASE_URL` is `getafairshift.com`, so verification links, invitation links and PayPal return URLs point at a host that doesn't resolve.
- `EMAIL_FROM` uses `notify.getafairshift.com`, so verification and invitation email will probably fail or go unconfirmed while the domain is down.

`APP_BASE_URL` was not changed: it needs the owner's decision, and the domain is the proper fix.

## 7. Outstanding

1. **Owner:** get the hold removed, and confirm the domain resolves.
2. **Then:** re-run the public checks on `getafairshift.com`.
3. **Owner:** create the demo business through the product, including email verification and PayPal subscription approval.
4. **Owner decision:** reference history. The dataset ends on 2025-12-28, 309 days before the planning week. It's labelled, and it's the only five-location history available. Recommended: load it, because a forecast with no history doesn't tell the story.
5. **Genuine 14:00–20:00 path** on Square and PayPal Sandbox, with the flag off. It can only finish after 20:00 location time.
6. **Only then:** set the Demo Access variables and turn it on.

## 8. Untouched

"FairShift Demo Organisation", "FairShift Demo", their sales and incentive records, and all other hosted data apart from the migration above.
