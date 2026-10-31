# Performance and incentive journey: evidence

Scope: Golden Path steps 10–12, from confirmed work to an approved final payable, on real-business records. Tested on a disposable local database and a local production build. No hosted system was touched and no PayPal request was made. The earlier ONHOLD Sandbox payout is untouched.

Evidence labels follow `AGENTS.md`. Results are **VERIFIED** by commands run on the final code unless stated otherwise.

- **Baseline HEAD:** `cf2630b`
- **Final HEAD:** the commit that adds this document
- **Migration:** `0018_work_performance`

## Audit before implementation

| Item | Status | Finding |
|---|---|---|
| Performance model | PARTIAL | One team sales figure on the demo incentive rail, with no sales count |
| Attribution model | PARTIAL | Worker attribution codes and an empty `attributed_sales` table, with no import |
| Incentive policy | CONTRADICTORY | Listed OPEN in the product spec; new shifts carried no incentive; no Owner configuration |
| Incentive calculation | CONTRADICTORY | A demo-only team threshold and a separate commission calculator |
| Payable | EXISTING, base only | A constraint forced approved amount to equal base |
| Manager and Worker UI | PARTIAL | Incentive views limited to the seeded demo |

The Product Owner resolved the open decisions: an individual sales target with a fixed bonus, and imported evidence may drive the payable if its provenance stays explicit.

## Incentive policy

This is the MVP policy, not a claim about permanent architecture.

**If the worker's own attributed sales value for the shift meets or exceeds the accepted target, the fixed bonus is earned. Otherwise the incentive is zero.**

- **Authority:** the Owner sets target and bonus on a work policy (`/owner/policies`). Both or neither, positive, on hourly or daily terms only.
- **Snapshot:** target, bonus and currency are copied to the shift and into the worker's immutable acceptance snapshot, with basis `INDIVIDUAL_ATTRIBUTED_SALES`. Later policy changes alter nothing accepted.
- **Before acceptance:** the Worker sees base earnings, target, bonus and potential total.
- **Formula code:** `calculateIncentive` in `src/server/domain/incentive.ts`, moved from the demo module so both use one function.
- **Excluded:** percentage commission and team performance. The seeded demo's team incentive has no basis, stays on its own rail, and is unchanged.

## Attribution path

1. A Manager or Owner pastes rows into **Review → Performance → Import attributed sales**.
2. `importAttributedSales` (`src/server/performance/attribution.ts`) reads exactly five columns: `transaction_id, attribution_code, occurred_at, amount, currency`. Other columns are refused, so customer or product data cannot come in.
3. Each row is matched on the worker's attribution code at the session's organisation and location, then on the worker's accepted incentive shift window (start inclusive, end exclusive) and its currency.
4. Rows are stored in `attributed_sales`. Every other row is reported by line number with a reason.

Repeat rows are counted as duplicates and never double-counted. A repeated transaction ID with different details is refused. The transaction unique index moved from provider-wide to per location, so one business cannot block another's IDs.

**Provenance:** imported evidence. Rows stay `UNVERIFIED`, results carry `IMPORTED_NOT_PROVIDER_VERIFIED`, and the Manager sees "Imported · not provider-verified". Manager confirmation does not change this. No provider, including Zettle, is involved.

## Evidence completeness

No result row means unknown. Sales show as not known, the Worker sees no sales figures or total, and approval is blocked in the server and the database. When the Manager confirms the evidence is complete, one immutable `work_performance_results` row is written, and from then a zero is a factual zero. Sales arriving after that are refused for the shift.

The Manager posts no figures. The count and value they saw are only compared with the server's own, so sales imported after the page opened are refused rather than confirmed unseen.

## Final payable

**Accepted base earnings + calculated incentive = final payable.**

There is one payable, through the existing approval and payout boundary. Base still comes only from the acceptance snapshot. The database enforces that approved amount equals base plus incentive, that an incentive can only come from the payable's own confirmed result, that it is recorded once, and that results cannot be edited or deleted. Existing payables stay base-only, because `incentive_required` defaults to false.

## Permissions

Import, review and confirmation are limited to Owner and Manager at the session's location and require an active entitlement. Workers cannot call them. A worker cannot confirm their own results. Workers see only their own aggregates, with no transaction, customer, product, store-wide or other-worker data.

## Negative tests

| # | Requirement | Result |
|---|---|---|
| 1 | Worker A can't see Worker B's performance | Passed |
| 2 | Outside Manager can't see or approve | Passed, other location and other tenant |
| 3–6 | Posted count, value, incentive or final payable | Ignored at confirmation and approval; outcome unchanged |
| 7 | Wrong worker | Passed |
| 8 | Wrong shift | Passed, including two shifts for one worker |
| 9 | Duplicate import | Not double-counted |
| 10 | Missing evidence isn't zero | Passed, for Manager and Worker |
| 11 | Zero distinct from missing | Passed |
| 12 | Invalid or negative values | Refused |
| 13 | Wrong currency | Refused |
| 14 | Base unchanged after policy change | Passed: £96.00 after rate, target and bonus edits |
| 15 | Calculation repeats exactly | Passed; a repeat confirmation returns the same record |
| 16 | Manager can't alter the incentive | Passed in the action and the database |
| 17 | Approval idempotent | Passed |
| 18 | Payout idempotent | One PayPal request across concurrent and repeated sends |
| 19 | ONHOLD isn't paid | Passed: Action required, no paid date |
| 20 | No network payout | Asserted with a `fetch` spy and a stub adapter |
| 21 | Substitution follows evidence | Passed |

## Substitution and hard-coding

Parameterised tests change the business, worker, rate, target, bonus and evidence, and the outputs follow, including just-under and exactly-at-target cases. A South African location with its own offset and currency also passes. A source scan refuses business names, places, currencies, demo constants and demo amounts in the two logic files.

## Mutation evidence

15 changes were applied to a disposable copy, and all were caught: bonus ignoring the target; hard-coded target; hard-coded bonus; approval ignoring missing evidence; approval at base only; sales outside the window; import ignoring location; any currency accepted; posted figures trusted; late sales after a final result; terms read from outside the snapshot; evidence marked verified; pending shown as £0.00; ONHOLD shown as Paid; results joined to the wrong shift.

The last one first survived. That exposed a real test gap, so a test for two shifts of one worker was added and the mutation was then caught. The migration test also found a real defect during implementation: SQL `NULL` comparisons let a half-set policy past a check constraint, which was tightened.

## Downstream payout regression

Using a stub adapter only, the amount passed to the payout boundary was exactly `121.00 GBP`, matching the approved payable. One payout row exists, and the held status stays `PROCESSING` with no paid date. Existing payable and payout suites pass.

## Browser evidence

Local production build, disposable PostgreSQL, Tokyo server clock, New York browser clock, PayPal credentials blank.

The prerequisites were seeded: business, identities and an earlier held payout from a local stub. Everything below was done through the real UI, with no clock changes. A genuine three-minute shift was used so the finished-shift rule stayed in force.

1. **Owner:** created a daily policy of £96.00, target £650.00, bonus £25.00.
2. **Manager:** created the shift and sent the offer. The preview showed "up to £121.00".
3. **Worker at 390 px:** saw base, bonus, target and potential total, then accepted.
4. **Manager:** allocated. Confirm work was disabled until the shift ended, then used.
5. **No evidence yet:** "None imported yet", no Approve button, Worker told results aren't final.
6. **Import:** 2 imported, 1 already imported, 3 not imported, each rejected line explained.
7. **Confirm:** 2 sales, £700.00, target reached, £25.00 bonus, £121.00 final.
8. **Approve:** `Approve £121.00`. No payout was sent.
9. **Worker:** saw sales, value, target reached, base, bonus and total, with no other worker's data, transaction IDs or codes.

Worker Home, Shifts and Earnings at 390, 1024 and 1366 px: no overflow, nothing off-screen or clipped, no target under 40 px apart from the 38 px logo link. Manager Review had no page overflow at 1366, 1024 and 390 px. No console or page errors.

After this run, one Manager link's wording changed to "Sales results needed", covered by a test and the final build, not by a repeat browser run.

## Known limitations

- Manager confirmation is a judgement, so a Manager could confirm incomplete evidence. It is audited, and no correction or dispute flow exists.
- Import is paste-only with no file upload. Refunds and negative sales are refused rather than modelled.
- The Manager's Today page doesn't flag sales results as needed; they appear on Review.
- A fixed target applies equally to short and long shifts on the same policy.
- Locking against concurrent import and confirmation is implemented but not race-tested, as PGlite has one connection.
- Worker activation still depends on email delivery, which isn't configured locally.
- A Sandbox recipient's GBP payout may still be held by PayPal, as already recorded.

## Claims unlocked

- Owners configure an individual sales target and fixed bonus.
- Workers see the incentive economics before accepting.
- Attributed sales count and value come from imported evidence matched to worker, location, shift and currency.
- The incentive is deterministic, explainable and calculated on the server.
- Managers approve one final payable, and the payout boundary receives exactly that amount.

## Claims prohibited

- Zettle or any provider-verified attribution.
- Live or automatic worker attribution.
- That this is FairShift's permanent incentive policy.
- That this journey ended in a completed PayPal payment. No real payout of a base + incentive payable has been sent.
- Hosted operation, payroll, or timesheets.
