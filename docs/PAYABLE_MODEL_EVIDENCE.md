Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# FS-PAY-001 Evidence

Evidence for confirmed work and the authoritative base payable:
allocated shift → confirmed work → base payable → manager-reviewable payable.
Status terms follow `AGENTS.md` §8. Nothing in this package approves, sends or
pays money.

## Repository checkpoint

| Item | Value |
|---|---|
| Start branch / HEAD | `main` / `232e0af` (clean) |
| Latest migration at start | `0012_staffing_coverage` |
| Test baseline at start | 271 tests |
| Migration added | `0013_work_payables` |
| Tests at end | 292 (21 added) |

## Staffing reconciliation

FS-STAFF-001 reported, for the planning week of 27 October to 2 November 2026:

- 4,878.75 h required labour;
- 4,408 h existing coverage;
- a 522.25 h casual gap.

The difference 4,878.75 − 4,408 is 470.75 h, not 522.25 h. **This is correct
and is not a defect.**

The gap is calculated per store and day as `max(0, required − coverage)`. The
weekly figure is the sum of those daily gaps. Surplus coverage on a covered day
cannot fill a shortage on another day or at another store. Recomputing the
week from `forecastFromHistory`, `calculateStaffing` and the reference rota
(with the fixture's 8 h Brighton shift) gives:

| Quantity | Hours |
|---|---|
| Required | 4,878.75 |
| Coverage | 4,408 |
| Required − coverage | 470.75 |
| Surplus coverage on the 10 store-days with no gap | 51.5 |
| **Sum of daily gaps** = 470.75 + 51.5 | **522.25** |

The recomputed per-store gaps are the published figures: Birmingham 158.75,
Leeds 134, Brighton 118.75, Manchester 83.75 and London Stratford 27. Brighton
Wednesday is one example: 73 h required, 80 h covered, no gap and 7 h surplus.
That is also why the fixture's 8 h shift reduced the weekly gap by only 1 h.

Staffing arithmetic was not changed. `tests/unit/staffing.test.ts` now has a
small worked example showing that the weekly gap equals
`required − coverage + surplus on covered days`.

## Existing payment architecture inspected

- **`shift_offers`** hold the offer states `OFFERED`, `ACCEPTED`, `DECLINED`
  and `CANCELLED`.
- **`work_acceptances`** hold an immutable JSON snapshot for each offer and
  terms version. A trigger (migration 0004) rejects updates and deletes.
- **`work_allocations`** link one offer to the acceptance of its current
  terms version. A material change to the shift sets the allocation to
  `REACCEPTANCE_REQUIRED` and reopens the offer.
- **`confirmWork`** already required:
  - an accepted offer;
  - a `PUBLISHED` shift at the scoped location;
  - an `ALLOCATED` allocation;
  - a scheduled end in the past.

  It set `work_allocations.confirmed_at`. Confirmed work locks the shift's
  terms (trigger from migration 0004).
- **`shift_incentives`** is the existing PayPal Sandbox payout rail. It has an
  approval gate, a payout reservation, duplicate protection and provider status
  reconciliation, and pays only the controlled USD demo incentive. It was
  **not changed**, and no payable state was added to it.
- **Work policies** are records created by the Owner/Admin with an earnings
  model and a rate. They had no currency. `createRequirement` copied their
  terms onto the shift and hard-coded the currency to `USD`.

## Confirmed-work model

The hackathon MVP model is confirm-as-scheduled. When a manager confirms work,
it means the allocated worker completed the scheduled work under the accepted
terms. There is:

- no timesheet;
- no clock-in or clock-out;
- no attendance edit;
- no overtime;
- no break deduction;
- no rounding of attendance.

The existing `confirmWork` is reused and extended. It now also:

- checks that the worker belongs to the organisation;
- locks the allocation row;
- loads the acceptance that the allocation points to, which must match the
  shift's current terms version;
- creates the base payable in the same transaction.

Work that cannot be confirmed, and so never produces a payable:

- offer-only;
- accepted but not allocated;
- declined;
- cancelled (cancellation also closes the offer);
- reacceptance required after a material change;
- not yet ended.

## Accepted compensation snapshot

The payable is derived only from the immutable `work_acceptances.snapshot`
that the allocation references. It is never derived from current policy,
shift, worker or currency values.

The snapshot already held everything needed:

- worker;
- offer;
- shift (`assignmentId`);
- location;
- start and end;
- earnings model;
- currency;
- rate;
- expected earnings;
- terms version.

The organisation is the location's organisation. The database trigger checks
it independently against the location and the worker. No second snapshot was
created.

## Compensation types supported

| Type | Base payable |
|---|---|
| `HOURLY` | Accepted rate × accepted scheduled duration |
| `DAILY` | Accepted daily amount, whatever the duration |
| `COMMISSION` | **None.** Work can be confirmed, but no payable is created (state `ATTRIBUTION_REQUIRED`). The manager and worker see that verified attributed sales are required. It is never shown as £0.00 and never converted to hourly pay. |

## Currency model

- `work_policies.currency_code` is a new, required field. When a policy is
  created, its currency is resolved from the location by
  `resolveLocationCurrency` in `src/server/domain/currency.ts`:
  - the location's own country decides when it has one;
  - otherwise the organisation's country decides;
  - United Kingdom names resolve to `GBP`;
  - everything else keeps the established default, `USD`.
- `createRequirement` copies the policy currency onto the shift. **The `USD`
  hard-code is removed.**
- The accepted snapshot, the payable, and the manager, worker and Owner
  surfaces all keep and display that one currency. The Owner policy form label
  reads "Rate (GBP)" for UK locations.
- Totals are grouped by currency and never added across currencies. There is
  no foreign-exchange conversion.
- Migration 0013 backfills existing policies with the same rule. Existing
  shifts, offers and acceptances are **not** rewritten, so any UK shift created
  before 0013 keeps the USD terms its worker saw.

## Base payable formula

`basePayableFromAcceptedTerms` in `src/server/domain/work-payable.ts` uses
calculation method `confirm-as-scheduled-v1`:

```
HOURLY: base minor units = rate minor × (scheduled end − scheduled start in ms) / 3,600,000
DAILY:  base minor units = daily rate minor
```

The function reuses `expectedWorkEarnings`, which is the same function that
produced the expected earnings the worker accepted. The result must equal the
snapshot's `expectedEarningsMinor`. A mismatch is reported as unavailable, so
the offer amount and the payable can never disagree.

The scheduled duration is the elapsed time between the accepted start and end
instants. Overnight shifts and shifts that cross a daylight-saving change are
paid on their real elapsed hours. Example: 23:00 BST to 06:00 GMT on
24–25 October 2026 is 8 h, giving £96.00.

## Money rounding

There is no rounding. Arithmetic uses integer minor units and `BigInt`. Hourly
terms that would give a fractional minor unit are refused at requirement
creation, which is existing behaviour, so they can never be offered or
accepted.

If such terms reached the calculation anyway (for example from a legacy row),
the result is `UNAVAILABLE / NOT_WHOLE_MINOR_UNITS`. It is never rounded and
never £0.00.

Tested examples at £12.00/hour:

| Scheduled duration | Base payable |
|---|---|
| 6 h | £72.00 |
| 6 h 15 min | £75.00 |
| 7 h 45 min | £93.00 |

Floating-point fractions such as 0.3 h stay exact.

## Payable persistence

The new table is `work_payables`, with one row per confirmed work unit
(allocation). It records:

- **References:** organisation, location, shift, worker, offer, allocation,
  and the acceptance whose terms were used.
- **Terms and amount:** terms version, calculation method, earnings model,
  currency, rate, scheduled start and end, and base amount as an integer
  `bigint` of minor units.
- **State and provenance:** status, confirmation time, confirming user and
  timestamps.

Each creation also writes `WORK_CONFIRMED` and `BASE_PAYABLE_CALCULATED` audit
events.

## State model

- `PENDING_REVIEW` is the only state. It is shown as "Awaiting approval".
- A CHECK constraint allows only this state, so no code path can mark a payable
  approved or paid.
- FS-PAY-002 can add approval and payout states by widening that constraint.
  That is an additive change, not a redesign. Only `status` (and `updated_at`)
  may change after insert.
- No parallel payout state machine was created, and `shift_incentives` is
  untouched.
- An incentive has no field on the payable. The payable is the base amount
  only, and its absence means no incentive was applied.

## Idempotency

- **Database uniqueness:** unique on `allocation_id`, and unique on
  `(shift_id, worker_id)`.
- **Locking:** `confirmWork` locks the shift row (existing) and the allocation
  row.
- **Retry-safe inserts:** the payable is inserted with
  `ON CONFLICT (allocation_id) DO NOTHING`, and the existing row is returned on
  any repeat.
- **What a repeat does:** a repeat or retry returns the same confirmation time
  and the same payable. It writes no further audit events.
- **Recovery:** work confirmed before 0013, or a calculation interrupted for
  any reason, can be recovered with the same action. The manager sees
  "Calculate base payable".
- **Unusable terms:** if fixed terms cannot be verified, the whole confirmation
  rolls back. Confirmation would otherwise lock terms that could never be paid.
- **Tested:** single repeats, three concurrent confirmations, and a direct
  duplicate insert, which is rejected.

## Tenant security

- **Application:** confirmation requires the shift to be at the scoped location
  of the scoped organisation, and the worker to be in that organisation.
  Manager reads of payables filter on organisation and location.
- **Rejected scopes:** a manager of another organisation, a manager of another
  location in the same organisation, and a forged scope naming another
  organisation's location.
- **Owner/Admin:** the Owner follows the same organisation scope at the
  selected location.
- **Database trigger `fairshift_work_payable_integrity`:** on insert it
  requires all of the following:
  - the location belongs to the organisation;
  - the shift is at that location on the payable's terms version;
  - the worker belongs to the organisation;
  - the offer is the worker's accepted offer for that shift;
  - the allocation is that offer's confirmed `ALLOCATED` allocation under that
    acceptance, at the same confirmation time;
  - the snapshot's model, currency, rate, start, end and expected earnings
    match.

  It also rejects any change to financial facts and any delete.

The integrity tests prove each of these by changing one field at a time on a
row that is otherwise valid. The valid row is then shown to insert.

## Manager review

Manager → Review:

- **Confirm work performed:** one entry per allocation, with the accepted
  terms, a Confirm form for work that has ended, and then the confirmation
  time in the location's time zone and the base payable.
- **Base payables · confirmed work:** an "Awaiting approval" total per
  currency, plus a table with worker, shift, accepted terms (for example
  `£12.00/hour × 6 hours scheduled · version 1`), confirmation time, base
  payable and status.
- **Copy:** it states that approval and payment of base payables are not yet
  available, so none of the amounts has been paid. There is no Pay button and
  no Paid state.

## Worker earnings

Worker → Earnings now has a "Work earnings" section with two totals:
"Expected · work not yet confirmed" and "Confirmed · awaiting approval".

Each accepted shift shows one of:

- expected earnings and "Awaiting work confirmation";
- the base payable, its basis and "Awaiting approval";
- for commission: "awaiting verified attributed sales".

No work earning is ever shown as paid. Incentive payments are a separate
section, and their dollar strip appears only when incentive records exist.
Home shows the confirmed total. Every amount uses its row's currency.

Workers see only their own payable. The worker query exposes no acceptance,
confirming-user or internal references.

## PayPal boundary

- No PayPal call, payout, credential, provider ID or Paid state is part of this
  package.
- The tests mock the payout factory and spy on `fetch`. Confirmation through
  the server action calls neither.
- The payable table has no provider columns.
- FS-PAY-002 can use `work_payables.base_amount_minor` and `currency_code` as
  the exact amount to approve and send.
- The existing payout rail is USD-only. FS-PAY-002 must verify PayPal Payouts
  support for GBP before sending a GBP payable.

## Schema/migration

`drizzle/0013_work_payables.sql` is additive:

1. **`work_policies.currency_code`:** added as nullable, backfilled by the
   location rule, then made `NOT NULL` with a format check.
2. **`work_payables`:** a new table with these constraints:
   - the method, the model (`HOURLY`/`DAILY` only), the currency format, safe
     integer ranges and schedule order;
   - an exact formula check (`DAILY`: base = rate; `HOURLY`:
     base × 3600 = rate × elapsed seconds);
   - the status check;
   - restricted foreign keys, the two unique indexes, and scope and worker
     indexes.
3. **Trigger:** the integrity and immutability trigger described above.

It does not change sales, staffing input, shifts, offers, acceptances,
allocations, incentives or PayPal identifiers. It creates no payable for work
confirmed earlier. `tests/integration/migration.test.ts` applies 0000–0012,
seeds such rows, applies 0013 and compares them.

One schema change has no SQL effect: `workAllocations` now declares `id`
before `confirmedAt` (see Defects). `drizzle-kit generate` reports no schema
changes for it.

## Tests

| Area | Where |
|---|---|
| Hourly, daily, fractional and drift-free arithmetic; expected-earnings parity; commission; malformed or mismatched terms reported as unavailable; currency resolution | `tests/unit/work-payable.test.ts` |
| Staffing reconciliation concept | `tests/unit/staffing.test.ts` |
| A: GBP hourly payable from accepted terms. E: confirm-as-scheduled. G: repeat, concurrent and duplicate-insert idempotency. L: no incentive. M: no PayPal fields | `tests/integration/work-payables.test.ts` |
| B: daily. D: accepted £12 survives a policy change to £13, and a changed shift needs reacceptance. F: state safety. H: tenant and location. I: worker privacy. J: unverifiable terms block confirmation. K: commission. N: fractional, overnight and DST. O: database integrity and immutability. USD contexts unchanged | `tests/integration/work-payables.test.ts` |
| C: GBP on manager, worker and Owner surfaces; confirmation through the server action with no PayPal factory call and no `fetch`; no Paid state or Pay button; allocated work visible for confirmation | `tests/integration/work-payables.test.ts` |
| Migration 0013 preservation and backfill | `tests/integration/migration.test.ts` |

Results:

| Check | Result |
|---|---|
| Focused suites | Pass |
| `pnpm test` | 292/292 on the full run of the committed tree. Later repeat runs had 5 s timeouts only; see below. |
| Typecheck, lint | Pass |
| `next build` | Pass |
| `pnpm smoke:manager` | PASS |
| Worker smoke | None exists in the repository |
| `git diff --check` | Clean |

**Full-suite stability: repeated green run NOT VERIFIED.** The full suite
passed 292/292 twice:

- once before two late, small changes (the allocation column order and the
  payable time zone);
- once on the committed tree (338 s, already under load).

Five further full runs had 1, 1, 6, 7 and 10 failures. Every failure whose
output was kept (runs 4–6) is `Test timed out in 5000ms`, mostly in the
scrypt-heavy auth tests. None is an assertion failure. Runs 1 and 2 were not
logged; each showed one `auth-tenancy` failure, and that test passes in
isolation.

During those runs an unrelated desktop application was using about 375% CPU,
and load average was 7–13 on 8 cores. Run time grew from the usual ~176 s to
410–472 s.

Control: the same test subset was run back to back on the untouched baseline
`232e0af` in a temporary worktree. The baseline failed 5 of 18 with the same
timeouts; this tree failed 2 of 18. Timeouts were not raised. **Rerun
`pnpm test` twice on an idle machine** to complete this gate.

## Browser verification

**Setup:**

- a local production build (`next start`);
- a disposable PostgreSQL 15 cluster in the session scratchpad;
- PayPal, OpenAI and Resend variables blanked (health reported
  `paypal: NOT_CONFIGURED`);
- headless Chrome driven over CDP.

The fixture created only the identities: an Owner, a Manager and a Team
Member, with an active subscription and a UK location (Leeds Briggate,
Europe/London). Every workflow step went through the UI, and no payable was
inserted directly:

1. The Owner adds a department and an hourly £12.00 policy. The form shows
   "Rate (GBP)" and the list shows "£12.00 / hour".
2. The Manager creates a 6 h requirement that has already ended. Terms show
   £12.00/hour and £72.00 expected, with no `$`.
3. The Manager sends the offer. The worker sees GBP terms and accepts after
   acknowledgement.
4. Worker Earnings shows "£72.00 expected work earnings · Awaiting work
   confirmation", with no payable.
5. The Manager allocates the work, then confirms it on Review.
6. Review shows "£72.00", "£12.00/hour × 6 hours scheduled",
   "Awaiting approval", and a confirmation time labelled Europe/London.
7. The worker sees "£72.00 base payable … work confirmed", "Confirmed ·
   awaiting approval" and "Awaiting approval". No Paid state appears anywhere.

At 1366×768, 1024×768 and 390×844, on manager Review and Plan, worker
Earnings, Shifts and Home, and Owner Policies:

- no horizontal page overflow;
- visible keyboard focus, and the payables table region is focusable;
- the worker bottom navigation works, the Owner mobile menu opens, and the
  manager navigation is reachable;
- no console errors and no server errors.

Local timings on this small dataset, five warm requests each: manager Review
about 9–20 ms and worker Earnings about 8–10 ms. Each payables list is one
joined, scoped query, with no per-worker queries.

## Golden-path advancement

- **Step 10 (confirmed-work basis):** supported. Allocated, ended work is
  confirmed by a manager as scheduled.
- **Step 11 (base wage):** supported. FairShift calculates and stores the base
  payable from the accepted terms.
- **Step 12 (manager can inspect the amount):** partially supported. The
  manager can review the amount, but **approval is not implemented**.
- **Steps 13–15:** not supported. No PayPal payout of work earnings, payout
  state or worker payment confirmation exists for base payables.

## Defects

**Found and fixed:**

1. **Shift currency hard-coded to USD.** UK shifts showed "$12.00/hour".
   Fixed through the policy currency.
2. **Pre-existing: allocated work hidden until confirmed.** Drizzle treats a
   left-joined object as absent when its first selected column is null, and
   `workAllocations` declared the nullable `confirmedAt` first. As a result:
   - Manager Plan showed "Accepted · allocation needed" after allocation;
   - Manager Review listed no unconfirmed allocations, so work could not be
     confirmed in the UI;
   - the worker saw "Awaiting allocation".

   Fixed by declaring `id` first. A regression test fails with the old order.
3. **New payable times shown in Johannesburg time.** They now use the location
   time zone and are labelled. Found during browser verification.

## Known limitations

- **Johannesburg times, still present.** Shift entry and display on manager
  and worker scheduling screens still use Johannesburg time:
  - `createRequirementAction` and `changeAssignmentAction` parse `+02:00`;
  - `ShiftTerms` and the worker's other timestamps use `dateTime`.

  The stored instants are what the worker accepted, so payable duration is
  correct. The displayed times are not UK-local. This belongs to the later
  Fill Shifts package.
- **Currency mapping.** Only United Kingdom names map to a local currency.
  Other countries, including South Africa, keep the established USD default.
- **Old UK shifts.** UK shifts created before 0013 keep their USD terms. They
  are not rewritten.
- **Pre-0013 confirmed work.** Work confirmed before 0013 has no payable until
  a manager uses "Calculate base payable".
- **No approval.** Payables cannot yet be approved, and work earnings cannot be
  paid.
- **Hosted environment.** Not deployed or verified. Migration 0013 has not been
  applied there.

## Deferred work

- manager approval and the final payable;
- genuine PayPal Sandbox payout of base payables, including GBP support
  verification;
- payout status reconciliation;
- performance and incentives;
- AI;
- availability;
- Zettle.

## Claims register

**May now be claimed:**

- FairShift preserves the compensation terms a worker accepted. Later policy
  changes do not change what confirmed work pays.
- Confirmed allocated work generates a durable base payable, calculated
  deterministically from the accepted scheduled terms.
- UK reference shifts, accepted terms and payables use GBP.
- Managers can review confirmed base payables awaiting approval. Workers can
  see their own confirmed earnings.
- Payable creation is idempotent and tenant-scoped, enforced in the
  application and in the database.

**Still prohibited:**

- PayPal payout of work earnings, or a worker paid for work;
- manager approval of payables;
- AI performance calculation or incentive payment;
- Zettle, live commerce or worker attribution;
- hosted or production verification.
