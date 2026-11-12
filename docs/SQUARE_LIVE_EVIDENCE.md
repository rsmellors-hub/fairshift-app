Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Square Sandbox Commerce and Worker Attribution Evidence

**Status: SANDBOX-CONNECTED, verified locally on a production build against a scratch database.** FairShift reads genuine Square Sandbox payments through its existing commerce boundary and uses the team member on them for worker performance. It has not been deployed, and production Square is not connected.

**The limit that matters:** in every payment here, the caller named the team member through the API. Nothing shows that a real Square till fills that field from the logged-in staff member.

## 1. What is genuine and what is a fixture

| Evidence | Source |
|---|---|
| Sections 3, 5 and 7 | Genuine Square Sandbox, driven through the browser on 2026-11-01 |
| `tests/integration/square-live.test.ts`, `tests/unit/square-client.test.ts` | **Test fixtures.** A stand-in Square client or stubbed `fetch`, used for failures that can't be produced on demand |
| The business, its people and its reference history | Fictional, in a scratch PostgreSQL database |

Provider IDs are not reproduced here. Owner Sales shows the last six characters of a Sandbox payment ID for audit.

## 2. Path through FairShift

```
Square Sandbox payment
→ square-adapter (reads only the fields below)
→ ingestConnectedObservations → sale_transactions, source SQUARE
→ commerce_payment_evidence, commerce_refund_evidence
→ deriveSquareAttribution → attributed_sales
→ getWorkerTargets / getLocationPerformance
→ existing incentive calculation → manager confirmation and approval → existing PayPal boundary
```

Forecasting reads `sale_transactions` only, so it knows nothing of Square's shape. The evidence tables hold what forecasting doesn't need.

**Provider fields read**

| Object | Fields |
|---|---|
| Location | `id`, `merchant_id`, `status`, `currency` |
| Team member | `id`, `status`, `is_owner`, `given_name`, `family_name` (names shown to the Manager, not stored) |
| Payment | `id`, `status`, `location_id`, `created_at`, `amount_money`, `team_member_id` |
| Refund | `id`, `status`, `location_id`, `payment_id`, `created_at`, `amount_money` |

Card, customer, note, reference and metadata fields are never read. A refund's `team_member_id` is deliberately not stored: nothing shows who performed a refund.

**Choices made from the evidence**

- **Sale value** is `amount_money`, so it excludes tips.
- **Sale time** is `created_at`, because a refund moves `updated_at`.
- **A sale** is status `COMPLETED` only. Other payments are counted and skipped, and are taken later if they complete.

## 3. Genuine endpoints exercised

| Endpoint | Used for | Result |
|---|---|---|
| `GET /v2/locations` | Connect | 200, one active GB/GBP location |
| `GET /v2/locations` with a bad token | Rejected credentials | 401 |
| `GET /v2/payments` | Connect check and every sync | 200 |
| `GET /v2/refunds` | Every sync | 200 |
| `POST /v2/team-members/search` | Mapping | 200, two synthetic members offered; the seller's own record excluded |
| `POST /v2/payments` | Demo sales, and a payment with no team member | 200, `COMPLETED` |
| `POST /v2/payments` with an unknown `team_member_id` | Edge check | **400 `INVALID_VALUE`** |
| `POST /v2/refunds` | Partial refund | 200, `PENDING`, then `COMPLETED` on the next sync |

**New findings since the gate**

- Square refuses an unknown `team_member_id`. FairShift still handles one defensively.
- A payment with no team member is accepted. It stays a sale at the location and is not attributed.
- A partial refund can start `PENDING`, so refund status is updated on later syncs. Its link and amount can't change.

Sandbox now holds 11 payments and 3 refunds from the gate and this package.

## 4. List lag and overlap

The gate saw one payment missing from an immediate list and present about 4 seconds later.

- **Overlap:** each sync reaches back one day before the last completed sync, so nothing depends on the newest boundary being complete.
- **Once only:** a Square payment ID is one sale, and repeats change nothing. A retrieval is read in full, then stored in one transaction, so a failed page stores nothing and doesn't advance the window.
- **Contradictions:** a held payment whose amount or `team_member_id` changes fails the sync and changes nothing.
- **Concurrency:** one run per connection, enforced by a unique index.

**Freshness bound.** A page showing Square figures polls every 10 seconds, and a location syncs at most once every 9 seconds. So a sale listed up to about 4 seconds late appears **within 30 seconds**. This is tested with a simulated clock (`SQUARE_VISIBLE_WITHIN_MS`).

Measured in the browser: **9.1 s, 8.1 s and 8.6 s**. The list lag did not recur in that run, so the worst case is shown only by the simulated test. Polling runs only while a page with an open target is visible. The bound assumes the lag stays near what was observed.

## 5. Browser journey

Production build, scratch database, genuine Sandbox, browser in a different time zone from the location. No console errors.

| Step | Result | Evidence |
|---|---|---|
| Owner connects Leeds | Connected, `SANDBOX`. Connect buttons disappear from the other four locations | `01` |
| First sync | Earlier genuine payments and refunds ingested | `09` |
| Manager maps Casey to Demo Worker A | Audited | `02` |
| Demo shift offered: £96 base, £200 target, £25 bonus | Created with the ordinary scheduling rules | `02` |
| Worker accepts at 390 px | `ACCEPTED`, by the worker | `03` |
| Manager finalises on Allocations | `ALLOCATED` | `04` |
| Target before any sale | "No sales recorded yet" | `05` |
| Sandbox sale £120.00 | "£80.00 to go" | `06` |
| Sandbox sale £79.99, total £199.99 | "£0.01 to go" | `07` |
| Sandbox sale £0.01, total £200.00 | "Target of £200.00 reached", bonus "to be confirmed" | `08` |
| Genuine £20 partial refund of the £120 sale | Attributed total stays £200.00 | `09` |
| Owner Sales | Square connected, gross of refunds, each payment's attribution state | `09` |
| After shift end and settle: confirm work and sales | 3 sales, £200.00, earned £25, `SQUARE_TEAM_MEMBER` | `11` |
| Manager Review | £96.00 base + £25.00 bonus, "Approve £121.00" | `11` |
| Worker Earnings | £121.00, awaiting approval | `12` |
| **Stopped here** | `work_payouts` has 0 rows. No approval or payout was made | |

The demo utility wrote no sale. Each one reached `sale_transactions` and `attributed_sales` only through a later read from Square.

**Found by the browser, not the tests**

1. An 8-hour back-dated demo shift picked up the gate's earlier £2.03 for the same team member. The rule was right but the demo figures were wrong, so the demo shift is now a short window starting a minute before now, with a fixed £96 base. It displays as daily terms rather than £12 × 8 hours.
2. Owner Sales said "another source takes precedence" for sales made only today, which was untrue. It now says too few completed days.
3. Success messages for the demo tools appeared under "Action could not be completed".
4. While writing the walkthrough, a page whose poll wasn't the one that found a new sale would never have refreshed. Pages now compare an opaque revision.

The final journey above followed these fixes. The complete run before it created four more genuine Sandbox payments and a refund, and supplied the bad-token, unknown-ID and no-team-member checks in section 3. That is why Owner Sales shows more payments than the final three.

## 6. Attribution rules

A payment is attributed only when all of these hold:

- Square status is `COMPLETED`, and it has a `team_member_id`.
- That ID has an active mapping for this merchant, organisation and location.
- The mapped worker belongs to this organisation and location.
- The payment falls in `[start, end)` of that worker's **allocated** shift, from the accepted terms.
- Its currency matches the accepted terms.
- That shift's results aren't confirmed, and the payment isn't already attributed.

`attributed_sales.verification_state` stays `UNVERIFIED`. The target, bonus and approval rules are unchanged.

**Controls added around that rule**

- **Pasted import closed** at a Square-connected location, so a sale can't be counted twice or forged. Older imported evidence on a shift is shown as mixed and confirmed as imported, the weaker label.
- **Missing evidence is not zero.** Results can't be confirmed until a sync has completed at least 30 seconds after the shift ended.
- **Removing a mapping** withdraws unconfirmed sales it attributed, so a mistake can be corrected. Confirmed results stay.

**Known limit:** a shift that starts before the worker accepts it can count payments from before acceptance, as the existing import rule does. The demo shift's short window keeps this to about a minute.

## 7. Forecast

The genuine run selected **reference history** for Leeds, and Owner Sales shows Square as "Not used for forecast · too few trading days. 0 of 28 required completed days." All genuine Square sales are from one day, and today doesn't count until it has finished. The threshold is unchanged, and a fixture test confirms sufficient Square history would be selected. No Square history was manufactured.

So the demo's two paths are separate: labelled reference history drives the forecast, and genuine Sandbox commerce drives current worker performance.

## 8. Refunds

Refunds are recorded, linked to their payment and shown to the Owner. Owner Sales states that Square history is gross of refunds. They change neither sales history nor a worker's result.

**The worker-refund attribution policy remains OPEN.** With this behaviour, a fully refunded sale still counts toward a bonus until that policy is decided.

## 9. Demo tools

The tools need `FAIRSHIFT_DEMO_TOOLS=enabled` **and** a Sandbox connection. The build mode is not used, because a hosted demo is a production build. They need a Manager or Owner at the location and a mapped worker. Sales are capped at £250.00 and use a key from the rendered page, so a double submission is one payment. The API host is fixed to Sandbox, and the database refuses a Square connection that isn't `SANDBOX`.

## 10. Automated tests

92 Square cases plus the existing suites. See the two test files named in section 1 for the matrix: provider failures, delayed lists, overlap and concurrency, attribution refusals, security boundaries, economics and page wording.

**Existing tests changed, all because a requirement changed:**

| Test | Change | Why |
|---|---|---|
| `owner-onboarding` migration count | 20 → 21 | Migration `0020` |
| `reference-history` wording | "not Zettle, PayPal…" → "not Square, PayPal…" | Amendment E |
| `zettle-connection` Owner pages (2 tests) | Now assert no Zettle controls or wording | Amendment E. The failed-sync page checks moved to the Square Owner Sales test |

Zettle's service tests are unchanged and pass. Its server actions remain but no page references them.

### Verification on the committed code

Scratch PostgreSQL 15, migrations `0000` to `0020` from zero. No hosted system was touched, and no PayPal payout or subscription was created.

| Check | Result |
|---|---|
| Targeted Square, commerce and incentive tests | 144 of 144 passed |
| Full suite, run 1 | 600 of 600 passed |
| Full suite, run 2 | 600 of 600 passed |
| Typecheck, lint, `smoke:manager`, production build, `git diff --check` | Passed |
| Secret scan of 42 changed files and the walkthrough logs, comparing real credential values and token patterns | 0 matches |

**Earlier failed runs.** One targeted run and one full run failed with 11 tests in total, every one a 5s timeout with no failed assertion and different tests each time. The machine's power log shows it was asleep throughout: one test's 901 seconds matches a 15-minute sleep exactly. Those runs are not counted. The two passes above were not interrupted, and the timeout setting was not changed.

## 11. Limits

- Whether a real till sets `team_member_id`, and what a shared login does: **NOT VERIFIED**.
- Stability of `team_member_id` beyond this session's hours: **NOT VERIFIED**. Any change would fail the sync.
- Connect needs exactly one active Square location. Choosing among several is not built.
- Each open page adds sync-run rows while it polls. There is no clean-up, which is acceptable for a demo.
- Square credentials come from server configuration and are sealed per connection. There is no merchant OAuth, so this is one Sandbox seller.
- Approval and PayPal payout on Square-attributed work were not exercised in the browser here. The evidence label doesn't feed the payout path.

## 12. Claims

**Supportable:**

- FairShift connects to a genuine UK/GBP Square Sandbox seller and ingests its genuine Sandbox payments.
- Square Sandbox payments carry a team-member identity, which FairShift maps to a FairShift worker and uses for performance attribution.
- FairShift uses this provider-derived evidence in its performance calculation, and its existing incentive calculation operates on it.

**Prohibited:**

- A physical Square till automatically identifies the logged-in worker.
- Production Square is connected, or shared logins are solved.
- Refunds determine worker responsibility.
- Genuine Square history currently drives the forecast.
- Square sets pay or incentives, approves earnings or triggers PayPal.
- Provider evidence proves employment status.
