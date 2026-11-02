# Reference Commerce and Weekly Forecast Evidence

Evidence for the five-location reference sales history and the deterministic
weekly demand forecast. Status terms follow `AGENTS.md` §8.

> **Later change:** the dataset described here (`uk-specialty-retail-v1`) has been
> replaced. See `docs/REFERENCE_REFRESH_EVIDENCE.md`, then `docs/WORKLOAD_INTELLIGENCE_EVIDENCE.md`
> for the current hospitality dataset. This record is otherwise unchanged.

## 1. What is implemented

| Capability | Where | Status |
|---|---|---|
| `REFERENCE` sales source with database-enforced provenance | `src/server/db/schema.ts`, `drizzle/0011_reference_sales_history.sql` | REPOSITORY EVIDENCE, tested |
| Deterministic five-store UK reference generator | `src/server/reference/uk-retail.ts` | REPOSITORY EVIDENCE, tested |
| Explicit, idempotent provisioning operator | `src/server/reference/provision.ts`, `scripts/load-reference-history.ts` (`pnpm reference:load`) | REPOSITORY EVIDENCE, tested, run locally |
| Shared daily sales aggregation with source provenance rules | `src/server/intelligence/sales-history.ts` | REPOSITORY EVIDENCE, tested |
| Versioned source-eligibility rule (`source-eligibility-v1`) | `src/server/intelligence/weekly.ts` `selectForecastSource` | REPOSITORY EVIDENCE, tested |
| Seven-day forecast per authorised location | `src/server/intelligence/weekly.ts` `getWeeklyForecast` | REPOSITORY EVIDENCE, tested |
| Owner weekly forecast page and Overview forecast summary | `src/app/owner/weekly-forecast.tsx`, `src/app/owner/overview.tsx` | REPOSITORY EVIDENCE, local browser-verified |

Integration status: reference data is **SIMULATED** (labelled synthetic input).
Nothing here is provider-backed. Zettle remains **PLANNED / NEEDS VERIFICATION**,
and nothing in this work calls Zettle or PayPal.

## 2. Reference history

- A fictional UK specialty retailer. No brand name has been authorised; the
  internal label is "UK reference retailer". Store codes are anchored to real
  city context: UK01 Leeds (Briggate), UK02 Manchester, UK03 Birmingham,
  UK04 Brighton and UK05 London Stratford. They are not real premises.
- 104 complete Monday–Sunday weeks, from 1 January 2024 to 28 December 2025,
  in GBP and the `Europe/London` time zone. Weeks from 6 October 2025 onward are
  reserved as a holdout for later out-of-sample evaluation, which is **not yet
  implemented**.
- Factual England and Wales calendar: bank holidays, and the large-shop closures
  on Christmas Day and Easter Sunday. Each store has its own scale, weekday shape
  and seasonality. Black Friday and Christmas trading are generator inputs.
- The full range produces 287,961 receipt-level transactions across 3,620
  trading store-days (20 store-days closed). Every store-day sums exactly to its
  generated demand.
- An earlier design described a dataset of 297,802 transactions. That dataset
  was not located. This generator is a representative replacement and does
  **not** reproduce those counts.
- Rows are never verified, reconciled or given provider identifiers. A database
  constraint requires `provider_status = 'REFERENCE'`, `PENDING`,
  `NOT_RECONCILED`, null PayPal fields, and an explicit `occurred_at` sale time.
  Dates are never shifted to look current.
- Line items and SKUs are not modelled, and no worker attribution exists.

### Operator

```
pnpm reference:load --organisation <uuid> \
  --outlet UK01=<uuid> --outlet UK02=<uuid> --outlet UK03=<uuid> \
  --outlet UK04=<uuid> --outlet UK05=<uuid> \
  [--from YYYY-MM-DD] [--through YYYY-MM-DD]
```

The operator requires one organisation and an explicit, distinct outlet for
every store. It refuses:

- outlets from another organisation;
- inactive outlets;
- an outlet that already holds a different store's history;
- dates outside the reference range;
- an outlet whose time zone is not `Europe/London`. The loader never changes a
  location's time zone; since FS-STAFF-001 it comes from the location's country
  (see `docs/STAFFING_INTELLIGENCE_EVIDENCE.md`).

Validation runs before any write, and the load is one transaction. Deterministic
references make reruns insert nothing. A later `--through` date extends the
history without duplicating rows.

Local run, against a disposable PostgreSQL database: the full load inserted
287,961 rows in about 23 s, and a rerun inserted 0.

## 3. Forecast method and date model

- The method is `comparable-days-recency-v1`, unchanged in substance from the
  existing manager forecast. It uses the 56 days ending at the data-through
  date, a recency-weighted mean of matching weekdays (falling back to recent
  days when there are fewer than three), and caps isolated high days at twice
  the median. The planning range is not a calibrated interval. No AI is
  involved.
- **Historical evidence** (reference, or legacy demo history) keeps its own
  data-through date (28 December 2025 for the reference history) and, since
  FS-STAFF-001, plans the next seven real local days from tomorrow, like
  provider sales. Comparable weekdays from the 56-day lookback are mapped onto
  the planning dates; dates are never rewritten. These forecasts do not
  describe current trading, and the UI says so.
- **Provider sales** (verified PayPal Sandbox) use completed days up to
  yesterday, and plan from tomorrow.
- **Source rule `source-eligibility-v1`.** A provider series replaces
  historical evidence only when, in the 56 days to yesterday, it has:
  - at least 28 distinct days;
  - at least 3 observations of every weekday;
  - a latest day no older than the day before yesterday;
  - the outlet's planning currency, which is the currency of its established
    reference or demo history.

  Series are never mixed. Ambiguous currencies yield no choice. Every rejected
  source is reported with its reason.
- A company total is shown only when every location forecasts the same dates
  from the same source and currency.
- The manager's single-day forecast uses the same rule. Its single-day
  demonstration worker estimate is USD-denominated, so non-USD history gets no
  worker figure there. Planning-week labour hours are described in
  `docs/STAFFING_INTELLIGENCE_EVIDENCE.md`.

## 4. Verification

| Area | Positive behaviour | Negative or control behaviour | Automated |
|---|---|---|---|
| Generator | 5 stores, GBP, 728 days, exact daily sums, GMT/BST trading hours | Out-of-range dates rejected; closed days carry no receipts | `tests/unit/reference-history.test.ts` |
| Provisioning | Five-outlet load, idempotent rerun, extension, data-through | Foreign or inactive outlets, duplicate mappings, mixed histories and unconfirmed time zones refused with no writes; DB rejects malformed reference rows | `tests/integration/reference-history.test.ts`, `tests/integration/migration.test.ts` |
| Source rule | Eligible provider selected | 1 day, 27 days, 28 days missing a weekday, wrong currency, stale data, future rows, ambiguous currencies | `tests/unit/source-selection.test.ts` |
| Weekly forecast | 5 × 7 forecasts, deterministic, independently matching the generator totals | Missing history is unavailable, not zero; mixed totals withheld; other tenants and Team Members denied | `tests/integration/weekly-forecast.test.ts` |
| Manager forecast | Eligible PayPal history selected | One verified capture no longer replaces 56 days of history | `tests/integration/manager.test.ts` |
| Owner pages | Overview, Forecast and Sales show labelled GBP reference history | Forecast failure keeps factual sections and shows "Unavailable" | `tests/unit/owner-overview.test.ts`, `tests/integration/owner-reference-pages.test.ts` |

Local production build, run against the full 288k-row reference organisation:

- Owner Overview renders in about 0.31 s.
- Weekly Forecast renders in about 0.32 s.
- No horizontal page overflow at 1366×768, 1024×768 or 390×844.
- Keyboard focus is visible throughout.

None of this has been verified on the hosted deployment.
