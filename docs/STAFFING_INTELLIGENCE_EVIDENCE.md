# FS-STAFF-001 Evidence

Evidence for coverage-aware staffing: forecast demand → required labour hours
→ existing coverage → casual labour-hour gap → indicative shifts. Status terms
follow `AGENTS.md` §8.

## Repository checkpoint

| Item | Value |
|---|---|
| Start branch / HEAD | `main` / `988f5c4` (clean) |
| Latest migration at start | `0011_reference_sales_history` |
| Test baseline at start | 250 tests (per the FS-OVERNIGHT-001 handoff) |
| Migration added | `0012_staffing_coverage` |

## Product decisions implemented

| Decision | Implementation |
|---|---|
| D2 planning horizon | Every source plans the next seven real local days, starting tomorrow. Historical evidence keeps its own data-through date. |
| D3 staffing unit | Labour held as integer minutes, shown as hours. |
| D4 productivity | `REFERENCE_LABOUR_POLICY` (`reference-productivity-v1`): £100 of forecast sales per labour hour, in GBP. |
| D5 coverage | Regular-staff rota plus allocated casual shifts only. |
| D6 gap | `max(0, required − regular − allocated casual)`. |
| D7 indicative shifts | `ceil(gap / 8 h)`. Nothing is created. |
| D8 timezone | Each location has its own time zone, resolved from its country. UK reference locations use Europe/London. The loader flag was removed. |
| D9 / D10 | Owner navigation and the neutral "UK reference retailer" label are unchanged. |

## Staffing formula

`src/server/intelligence/staffing.ts`:

```
required minutes  = ceil(forecast sales minor × 60 / (salesMinorPerLabourHour × 15)) × 15
coverage minutes  = regular rota minutes (location, local weekday)
                  + allocated casual shift minutes on the local planning day
casual gap        = max(0, required − coverage)
indicative shifts = ceil(casual gap / 480)
```

All arithmetic is integer: minor currency units and minutes. The arithmetic
is checked against safe-integer limits.

## Productivity assumption

**£100 of forecast sales per labour hour is a hackathon MVP reference
assumption for the fictional UK reference retailer.** It is not a UK retail
benchmark, an empirically validated workforce standard, a per-location learned
rate, or an AI output. The policy is versioned and named, and the UI calls it a
"Reference staffing assumption".

Assumptions are keyed by currency, and only GBP has one. A USD history (the
Rosebank demo) shows "No staffing assumption for this currency". Currencies
are never converted.

## Rounding rule

Required labour rounds **up** to the next 15 minutes:

- £1,010 → 606 minutes → 615 minutes.
- £1,025 → exactly 615 minutes.

Demand is never rounded down. Allocated casual minutes are floored when they
are clipped to a day, so coverage is never overstated.

## Regular coverage source

The new table `regular_staff_coverage` holds the organisation, location, ISO
weekday (1–7), planned minutes and source. It is a **standing weekly rota**
that applies to each planning date by its local weekday.

This replaces the suggested per-date table for two reasons:

- the reference input stays valid for any future planning week without
  reloading;
- the loader does not depend on the wall clock.

The table has these protections:

- `unique (outlet_id, iso_weekday)`;
- minutes between 0 and 1,440,000;
- `source in ('REFERENCE')`;
- a trigger that rejects rows whose location belongs to another organisation.

Coverage states:

- A location with no rota row for a weekday reads as **Regular coverage not
  set**, and its gap is unavailable.
- A row of 0 minutes reads as 0 h.

Regular staff are lightweight staffing input. They are not a role, an account,
a set of shifts, a timesheet or payroll. Bank-holiday exceptions are not
modelled.

## Casual allocation coverage source

The query joins these tables:

```
work_allocations → shift_offers → shifts → outlets, workers
```

A row counts only when all of these hold:

- `work_allocations.state = 'ALLOCATED'`;
- `shift_offers.status = 'ACCEPTED'`;
- the shift is `PUBLISHED` or `COMPLETED`;
- the worker is `CASUAL` and bound to the shift's location;
- the worker and location belong to the scoped organisation.

These do not count: offered, pending, declined or cancelled offers; accepted
offers awaiting allocation; and allocations reset to `REACCEPTANCE_REQUIRED`
by a material change. Each allocation is one worker on one shift, so nothing
is double-counted.

Shifts are clipped to the boundaries of each local day, so a shift that
crosses midnight counts only its hours on each day. The day boundaries come
from `startOfLocalDay`, which respects daylight saving: 25 October 2026 is a
25-hour day in London.

## Gap calculation

`calculateStaffing` keeps every underlying value: required, regular,
allocated casual and coverage minutes. The gap is floored at zero, so a
covered day still shows its required labour and coverage.

## Indicative shift calculation

The gap is divided into 8-hour shifts, rounding up. The UI labels this
"Indicative shifts" or "Approx. N shifts to fill · none created". No shift,
offer or requirement is created.

## Planning date model

`selectForecastSource` now sets `firstTarget = tomorrow (local)` for
historical sources, as it already did for provider sources.

Both services take an injected clock (`now`), so tests set dates explicitly.
The forecast method itself is unchanged: comparable weekdays from the 56 days
before the evidence's data-through date are mapped onto the planning dates.
The UI states that this history:

- runs through 28 December 2025;
- includes peak trading;
- has seasonal differences that are not modelled.

The reference rows are never re-dated. A test asserts that every reference
sale is before 29 December 2025.

The legacy Rosebank demo is affected too. Its single-day manager target moves
from 15 October to the next local day: 16 October 2026 at the demo as-of date
(8 workers, +3). This is intended.

## Timezone behaviour

The time zone is location data:

- `resolveLocationTimezone` checks the location's country, then the
  organisation's country, then the single time zone already used by the
  organisation's locations. Otherwise it falls back to the existing
  `Africa/Johannesburg` default.
- Onboarding and "Add location" both use it.
- Shift dates are derived in the outlet's time zone, not a hard-coded
  Johannesburg.
- Migration 0012 corrects `Africa/Johannesburg` to `Europe/London` only where
  the location's country, or else its organisation's country, is a United
  Kingdom name. The seeded Rosebank outlet and other South African outlets are
  unchanged.
- The reference loader no longer has `--set-london-timezone`. It refuses
  locations that are not in London and never changes them.

## Reference provenance

- Forecasts derived from reference history are labelled "Reference sales
  history · synthetic".
- They show "Historical evidence through Sun, 28 Dec 2025" and the evidence
  age (302–303 days before the planning week).
- Nothing is labelled live or real-time.
- The regular rota is labelled "standing regular-staff rota (synthetic
  input)".
- No AI is used in any staffing figure.

## Schema/migration

`drizzle/0012_staffing_coverage.sql` is additive:

- a new table, indexes and a scope trigger;
- a narrowly scoped `UPDATE outlets.timezone`.

It does not touch sale history, PayPal rows or shifts. Staffing outputs are
derived when read and never stored. The migration preview test applies
migrations 0000–0011, seeds mixed outlets, applies 0012 and checks that only
UK outlets changed.

## Tests

| Area | Tests |
|---|---|
| Productivity, rounding, GBP-only, gap, never negative, indicative shifts (0, 8, 8.25, 15, 16 h) | `tests/unit/staffing.test.ts` |
| Clipping to local days across midnight, 25-hour London BST-end day | `tests/unit/staffing.test.ts` |
| Forecast missing / no rota / USD shown as unavailable, never zero; explicit 0 h rota is valid | `tests/unit/staffing.test.ts` |
| Offered, accepted-not-allocated and declined shifts do not count; allocated counts; other date, location and organisation excluded; material change and cancellation remove coverage | `tests/integration/staffing.test.ts` |
| Five locations × seven days derived independently from the generator; variation; idempotent rota reload; no stored outputs; injected clock | `tests/integration/staffing.test.ts` |
| Tenant isolation, manager single location, Team Member refused, cross-organisation rota insert rejected | `tests/integration/staffing.test.ts` |
| Coverage-query failure keeps the forecast and shows "Staffing could not be loaded", not 0 h | `tests/integration/staffing.test.ts`, `tests/unit/owner-overview.test.ts` |
| Owner and single-location Manager rendering: GBP, assumption, no "created" claims, no location selector | `tests/integration/staffing.test.ts` |
| Location creation time zones (UK → London, SA → Johannesburg); migration 0012 correction | `tests/integration/location-timezone.test.ts` |
| Planning week from the clock; evidence date unchanged | `tests/unit/source-selection.test.ts`, `tests/integration/weekly-forecast.test.ts` |

Results:

| Check | Result |
|---|---|
| `pnpm test` | 271/271, 39 files, on two consecutive runs (about 158 s each) |
| Typecheck, lint | Pass |
| `next build` | Pass |
| `git diff --check` | Clean |
| `pnpm smoke:manager` | PASS (assertion updated to the intended 16 October target) |

## Browser verification

The check used a local production build (`next start`) and a disposable
PostgreSQL 15 cluster in the session scratchpad, with provider and AI
variables blanked. The browser was headless Chrome driven over CDP.

Fixture:

- an Owner and five locations created through the normal domain functions;
  all five resolved to Europe/London from the UK country, with no loader flag;
- the full reference load: 287,961 rows and 35 rota rows;
- a Manager invited for Brighton only;
- one allocated casual shift (Wednesday 28 October, 8 h) plus one offered-only
  worker.

Pages checked at 1366×768, 1024×768 and 390×844: Owner Overview, Owner
Forecast and Manager Plan.

- No horizontal page overflow on any page. The dense 1024 table scrolls inside
  a focusable region.
- Focus outline visible (3 px).
- The mobile Owner menu opens.
- No console errors and no server errors.
- GBP shown on staffing surfaces.
- Planning week Tue 27 October – Mon 2 November 2026.
- Historical evidence through 28 December 2025.
- The Brighton Manager sees no location selector.
- Brighton Wednesday: required 73 h, regular 72 h, allocated casual 8 h, gap
  0 h. The offered-only worker is not counted.

## Performance observations

Local production server with 288k reference rows, five warm requests each:

| Page | This package | Previous |
|---|---|---|
| Owner Overview | about 0.32 s | about 0.31 s |
| Owner Forecast | about 0.33 s | about 0.32 s |
| Manager Plan | about 0.12 s | — |

Staffing adds two indexed queries per request, both batched across all
locations: rota rows and allocated shifts in the planning window. It reuses
the per-request memoised daily sales aggregation and loads no transactions
row by row.

## Reference scenario (derived, planning week 27 Oct – 2 Nov 2026)

Totals across the five stores:

- required labour 4,878.75 h;
- existing coverage 4,408 h;
- casual labour gap 522.25 h, about 77 indicative shifts.

The coverage and gap include the fixture's 8 h allocated casual shift. Without
it, the gap would be 523.25 h.

| Store | Weekly gap | Indicative shifts | Pattern |
|---|---|---|---|
| Birmingham | 158.75 h | 23 | Gaps every day, largest on Saturday (43 h) |
| Leeds | 134 h | 20 | Small weekday gaps (0.5–7.5 h), large Fri–Sun |
| Brighton | 118.75 h | 17 | Covered Mon–Wed, weekend-heavy (Sunday 48.5 h) |
| Manchester | 83.75 h | 12 | Covered Mon/Tue, Friday 42.25 h |
| London Stratford | 27 h | 5 | Covered on 4 of 7 days |

Ten of the 35 store-days need no casual labour. Inference: Friday and Saturday demand is
high because the comparable-weekday lookback (2 November – 28 December 2025)
covers peak trading, including Black Friday and Christmas. Isolated high days
are capped at twice the median.

## Golden-path advancement

- **Step 2** (Owner views the next-week forecast and staffing foundation):
  supported.
- **Step 3** (Owner drills into demand, coverage and gap per location and day):
  supported.
- **Step 4** (Manager moves from forecast and staffing toward filling shifts):
  partially supported. The Manager Plan shows the week. A "Plan shifts for the
  casual labour gap" link opens the existing requirement form on the same
  page. No requirement is created automatically.

## Known limitations

- The forecast maps late-season (November–December) comparable weekdays onto
  an October planning week. Seasonality is not modelled.
- The regular rota is a standing weekly pattern: no date exceptions, holidays
  or leave.
- Only GBP has a labour assumption. The USD Rosebank demo shows staffing as
  unavailable.
- Pre-existing, not changed:
  - Shift terms are created in USD (`createRequirement`).
  - Shift times are entered and displayed in Johannesburg time on manager and
    worker scheduling screens. The labels are accurate, but the times are not
    local for UK locations.
- The Manager's single-day AI panel still uses the USD demonstration worker
  policy. For GBP locations it says so and points to the planning-week labour
  hours.
- Not verified on the hosted deployment. Migration 0012 has not been applied
  there.

## Deferred work

- AI staffing recommendation (priority, explanation) on top of this evidence;
- worker availability;
- worker matching and the Worker Pool;
- the Fill Shifts handoff that creates requirements from the gap;
- local-time shift entry and display, and shift currency;
- payables and wages;
- PayPal payout changes;
- Zettle;
- owner-editable regular coverage;
- date-specific coverage exceptions.

## Claims register

**May now be claimed:**

- FairShift turns a seven-day demand forecast into required labour hours per
  location and day. It uses a documented reference assumption (£100 of
  forecast sales per labour hour) and rounds up to 15 minutes.
- It subtracts planned regular-staff coverage and allocated casual shifts, and
  shows the remaining casual labour gap with an indicative 8-hour shift count.
- Only finally allocated casual work counts as coverage; offers and
  acceptances do not.
- Planning uses the next seven real local days in each location's own time
  zone, and shows the date of the historical evidence.
- These figures are deterministic, tenant-scoped and derived on read, with no
  AI.

**Still prohibited:**

- live or current demand;
- Zettle-sourced sales;
- AI-generated staffing;
- optimal or validated staffing levels;
- the £100 rate presented as a benchmark;
- shifts created or offered from the gap;
- worker availability or matching;
- hosted or production verification.
