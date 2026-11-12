Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Zettle Live Evidence

**Status: Stage A blocked. No genuine Zettle authentication, purchase read or sync has taken place.**
The integration status remains **MOCKED**. Nothing in this document supports a claim that FairShift has connected to a real Zettle merchant.

Blocker: no Zettle merchant credentials are available (`ZETTLE_CLIENT_ID` and `ZETTLE_API_KEY` are unset; `.env.local` holds neither). `COMMERCE_CREDENTIAL_KEY` is also unset, so the connection form is disabled locally.

Last updated: 2026-11-01.

## 1. Provider contract and its evidence level

**Source:** the public `iZettle/api-documentation` repository (`authorization.md`, `purchase.adoc`). It is deprecated, and the current developer portal could not be read by the tooling used. **Live responses remain the final proof and have not been obtained.**

| Item | Documented | Live evidence |
|---|---|---|
| Token | `POST https://oauth.zettle.com/token`, JWT-bearer assertion grant | Endpoint live; success NOT VERIFIED |
| API key and client ID | Owner creates the key at `my.zettle.com/apps/api-keys`; the key is a JWT; the client ID comes with it or can be read from the JWT | NOT VERIFIED |
| Identity | `GET /users/self` returns a user and organisation identifier. **No scope is documented** | Endpoint live; success NOT VERIFIED |
| Purchases | `GET purchase.izettle.com/purchases/v2`, scope `READ:PURCHASE`, `startDate`, `lastPurchaseHash`, page until the response is empty | Endpoint live; success NOT VERIFIED |
| Staff | `userDisplayName`: "Name of the merchant/employee that took the payment". `userId` appears only in examples | NOT VERIFIED |
| Refund link | `refundsPurchaseUUID1` on the refund, `refundedByPurchaseUUIDs1` on the original | NOT VERIFIED |

**Discrepancy with the work package:** the package lists `userUuid` as a known purchase field. The accessible documentation does not define it. Its presence and meaning are unknown until a genuine response is inspected.

**Open risk:** the Connect link requests `READ:PURCHASE` only, and connecting also calls `/users/self`. If that call needs another scope, connecting will fail with `zettle-scope-missing`. The scope has not been changed, because no evidence yet shows it is needed. The probe will show it as a 403 on `identity`.

## 2. Live requests made so far

All used deliberately fake credentials, on 2026-11-01. They show that the hosts answer and how they refuse. They do not show that anything works.

| Request | Status | Provider error | Client maps it to |
|---|---|---|---|
| Token, fake client ID and key | 400 | `invalid_grant` | `AUTH_REJECTED` |
| Token, invalid grant type | 400 | `unsupported_grant_type` | `AUTH_REJECTED` |
| `/users/self`, fake token | 401 | `INVALID_TOKEN` | `AUTH_REJECTED` |
| `/purchases/v2`, fake token | 401 | `INVALID_TOKEN` | `AUTH_REJECTED` |

Consequence: a bad client ID and a bad key could not be told apart with fake values, so both are reported together as a credentials failure.

## 3. Defects found and fixed without credentials

| Defect | Effect | Fix | Test |
|---|---|---|---|
| Sync committed each 10,000-purchase batch separately | A failed sync over 10,000 purchases left rows behind | One transaction across batches | `zettle-connection.test.ts`, "stored whole or not at all" |
| 403 from `/users/self` reported as an outage | A permissions problem read as "Zettle could not be reached" | Mapped to `SCOPE_MISSING`, with corrected wording | `zettle-adapter.test.ts`, "forbidden identity read" |

## 4. Negative test matrix, connection

All automated, against a mocked provider. "Live" means the real provider also produced that refusal.

| Case | Status |
|---|---|
| Bad client ID, bad API key, provider rejection | Tested; live with fake values |
| Missing scope | Tested |
| Malformed response | Tested |
| Pagination, duplicate page, partial provider failure | Tested |
| Repeated sync | Tested |
| Concurrent sync | Tested through a run already in progress |
| Stale data, insufficient data | Tested |
| Unsupported currency, future transaction | Tested |
| Cross-tenant and cross-location connection | Tested |
| Credential disclosure | Tested |

## 5. Not yet proven

- Authentication, identity and purchase retrieval
- Whether the adapter accepts genuine purchases
- A genuine sync into `sale_transactions`, including idempotency against real identifiers
- Owner Sales showing genuine Zettle data. The browser evidence so far covers only the pre-connection state and a refusal (section 9)
- Forecast eligibility from genuine sales

## 6. Stage B: staff identity

**NOT STARTED. Decision: NO-GO until Stage A passes and genuine responses are inspected.**

The meaning of `userUuid` is not established. No worker mapping or provider-derived attribution was built. The existing `Imported · not provider-verified` performance path stays as it is, and refunds do not alter worker earnings.

`pnpm zettle:probe` reports the evidence for the staff questions without exposing names or identifiers:

- which staff fields exist, and how many purchases carry them
- whether each `userUuid` keeps one display name
- whether a `userUuid` is really the organisation or the authenticated account
- what refunds carry, and whether they link to the original sale
- whether an identity changes between runs, using pseudonyms that stay stable for the same key

Two questions need the merchant rather than the API: which person each Zettle user is, and whether staff share a login. A single login would attribute every sale to one person, so the demo account needs at least two sales under each of two separate staff logins.

## 7. Credential model

**Hackathon:** a private integration for FairShift's own demo merchant, using the assertion grant. Credentials are sealed with AES-256-GCM, bound to organisation and location, never returned to the browser or logged, and erased on disconnect. Retrieved commerce remains with its provenance.

**Future production:** a merchant-authorised public integration using the authorization-code flow, subject to Zettle's approval and current requirements. It is not implemented.

## 8. Claims

**Unlocked by this work:** none about live connectivity.

**Supportable now:** FairShift has a Zettle connector tested against a mocked provider, built to the provider's public documentation. Its real endpoints refuse invalid credentials in the way the connector expects.

**Prohibited:**

- FairShift connects to Zettle, or has retrieved genuine Zettle sales
- Genuine Zettle sales drive the forecast
- Zettle identifies worker sales, or Zettle evidence drives an incentive
- Any Zettle merchant can connect FairShift
- Reference or imported data is Zettle data

## 9. Credential-independent verification

Scratch PostgreSQL 15 database, built from zero with migrations `0000` to `0019` (20 of 20). The stale local database and hosted systems were not used or changed.

| Check | Result |
|---|---|
| Full suite, run 1 | 483 of 483 passed |
| Full suite, run 2 | 482 of 483 passed: a Zettle provenance test timed out at 5.4s against the 5s limit |
| Full suite, run 3 | 483 of 483 passed, nothing else running and system sleep prevented |
| Typecheck, lint, `smoke:manager`, production build, `git diff --check` | Passed |
| Secret pattern scan of the diff and new files | 0 matches |

**Test timeouts.** Two different tests have timed out once each, only during full-suite runs, and neither failed an assertion.

- `webhook-route.test.ts` took 58s in the earlier run. It passed 3 of 3 runs in isolation (6s to 10s for the file) and in all three later full runs. The power log shows a wake from hibernation at 01:03:27, inside that run. **INFERENCE:** the machine slept during the test.
- The Zettle provenance test took 5.4s in run 2 and takes about 0.8s normally (3 of 3 isolated runs). No wake was logged during that run, so the cause of the stall is **NOT VERIFIED**. Timing, not logic, is the established failure.

No timeout, assertion or test was changed in response.

**Browser evidence** (production build, fictional business, `docs/evidence/fs-zettle-live-001/`):

| File | Shows |
|---|---|
| `01-pre-connection.png` | Owner Sales with no connection: "Not connected. This location has no Zettle sales." |
| `02-real-provider-rejects-fake-credentials.png` | Fake credentials through the real form, refused by the real provider. Nothing was connected, and no Zettle rows or connection rows were stored |
