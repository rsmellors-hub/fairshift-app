# FS-INTEL-CORRECT-001 Evidence

> **Later change:** the labour policy described here is retired from the active path. See `docs/WORKLOAD_INTELLIGENCE_EVIDENCE.md` and `docs/HOSPITALITY_POLICY_FREEZE_EVIDENCE.md`. This record is otherwise unchanged.

Commerce intelligence independence and business policy hardening. Evidence labels follow
`AGENTS.md` §8. Times are UTC unless stated otherwise.

**Summary.** Forecasting, staffing and AI now derive their results from supplied commerce
evidence and each business's own configuration. The reference company is one business among
others: its £100 rate and rota are its own configuration, loaded by provisioning. The forecast
algorithm did not change.

## 1. Previous AMBER findings

| FS-INTEL-AUDIT-001 finding | Status |
|---|---|
| £100 labour rate was a hard-coded, GBP-only constant | Closed: persisted business policy |
| No other business or currency could get staffing | Closed: any configured two-decimal currency |
| Regular coverage could only have source `REFERENCE` | Closed: `CONFIGURED` source and Owner form |
| No defined import boundary | Closed: canonical ingestion boundary |
| Real customer history could not be represented truthfully | Closed: `IMPORTED` source |
| "Not PayPal" meant "synthetic" | Closed: derived from provenance |
| "Reference retailer", GBP and London leakage | Closed |
| Two contradictory staffing policies on the Manager page | Closed: legacy panel removed |
| No substitution regression test | Closed |

## 2. Implemented corrections

| Part | Where |
|---|---|
| Labour policy store | `labour_policies`, migration `0016_business_labour_policy` |
| Labour policy resolution | `resolveLabourPolicy` in `src/server/intelligence/staffing.ts` |
| Policy and coverage configuration | `src/server/intelligence/business-policy.ts` |
| Canonical ingestion | `src/server/commerce/ingestion.ts` |
| Owner configuration | `src/app/owner/staffing-configuration.tsx`, on Owner policies |
| Provenance | `isSyntheticSource` in `src/server/intelligence/forecast.ts` |
| Source selection | `selectForecastSource` in `src/server/intelligence/weekly.ts` (rule `source-eligibility-v2`) |

**Legacy single-day path.** The USD-only `STAFFING_POLICY` estimate is no longer on any page,
because it contradicted weekly staffing. The dead `operational-intelligence.ts` OpenAI module and
its test were deleted. `STAFFING_POLICY`, `getManagerForecast` and `ManagerForecast` remain but are
unreachable from the UI. They are kept only because `smoke:manager` and existing tests exercise
them, and removal is left for a later clean-up.

## 3. Canonical ingestion boundary

`ingestCommerceObservations` takes an organisation, a source (`IMPORTED` or `REFERENCE`), a source
system, and observations of location, source transaction ID, ISO timestamp with offset, currency,
gross minor units and `status: "COMPLETED"`.

| Rule | Behaviour |
|---|---|
| Batch semantics | **Atomic.** One invalid or conflicting observation rejects the whole batch |
| Repeat with the same facts | No change; counted as a duplicate |
| Same identity, different facts | Rejected (`CONFLICTING_DUPLICATE`) |
| Same ID from another source system | A separate transaction |
| Zero value | Accepted as a real observation |
| Negative or fractional value | Rejected |
| Malformed, offset-less or impossible dates | Rejected, never corrected |
| Future-dated | Rejected |
| Location not active in the organisation, or another tenant's | Rejected |
| A location's history gaining a second currency | Rejected; nothing is converted |
| Non-two-decimal or unknown currency | Rejected |
| `PAYPAL_SANDBOX`, `DEMO_SEEDED`, others | Rejected: PayPal captures keep their verified path |
| Empty, or over 10,000 observations | Rejected |

The reference loader now writes through the same duplicate-safe persistence step. The legacy demo
seed does not; it is unchanged.

**This is an application boundary only.** There is no route, CSV upload or user interface for it.

## 4. Source and provenance model

| Source | Meaning | Synthetic | Provider-verified |
|---|---|---|---|
| `PAYPAL_SANDBOX` | Verified, reconciled PayPal Sandbox capture | No | Yes |
| `IMPORTED` | Genuine history supplied for the business | No | **No** |
| `REFERENCE` | Generated reference dataset | Yes | No |
| `DEMO_SEEDED` | Legacy demo seed | Yes | No |

A database check requires imported rows to carry an occurred-at time and source identity, and
forbids provider identifiers and verification claims.

## 5. Source-selection precedence

Deterministic, per location, never mixing sources or currencies:

1. **Eligible PayPal.** In the 56 days to yesterday: 28 days, 3 of every weekday, recent, in the planning currency.
2. **Sufficient imported.** The same depth in the 56 days to its own latest day. It may be old; its age is reported.
3. **Reference.**
4. **Demo-seeded.**

Imported history that is too thin or in two currencies is rejected with its reason. It cannot replace another history. If nothing else exists there is **no forecast**, rather than a low-confidence one.

## 6. Labour policy resolution

1. A location override, if active.
2. Otherwise the organisation default.
3. Otherwise required labour is **unavailable** (`NO_LABOUR_POLICY`).

If the policy that applies is in another currency, labour is unavailable (`LABOUR_POLICY_CURRENCY_MISMATCH`). A mismatched override does **not** fall back to the organisation default, and nothing is converted.

- Rates are integer minor units, 1–10,000,000.
- Versions are append-only: a change supersedes the prior version, a database trigger keeps versions immutable, and they are never deleted.
- Staffing output and AI input carry the version (for example `organisation-v2`), so a policy change makes an AI assessment stale.
- The 15-minute planning increment and 8-hour indicative shift remain FairShift method constants.

**Migration behaviour.** 0016 creates no policy. Existing data has none until configured. Re-running the reference loader creates the reference company's £100 GBP policy, marked `REFERENCE`, and never overrides a policy the business already has.

## 7. Regular coverage semantics

| State | Meaning | Result |
|---|---|---|
| No row for a weekday | Not set | Gap unavailable (`REGULAR_COVERAGE_NOT_SET`) |
| Row with 0 minutes | Configured zero | The full requirement is the gap |
| Row above requirement | Over-covered | Gap 0, never negative |

Sources are `CONFIGURED` and `REFERENCE`. Owners set the rota per location, and blank days stay not set. No employee scheduling was added.

## 8. Demand Model v1

| Item | Definition |
|---|---|
| Demand signal | Gross daily commerce sales value |
| Method | `comparable-days-recency-v1`: 56-day lookback; matching weekdays when at least 3, otherwise the last 14 observed days; high days capped at 2× median with 5 or more days; recency weights 1..n |
| Staffing conversion | Forecast sales ÷ the business's sales per labour hour, rounded up to 15 minutes |

**The algorithm did not change in this package.** `forecastFromHistory` is byte-for-byte unchanged. The changes in `forecast.ts` are a new source value, its eligibility check, `isSyntheticSource` and a comment.

## 9. Known Demand Model v1 limitations

- Sales value is a proxy for workload, not a proven labour-demand predictor.
- Transaction volume, units and intraday workload are not independent signals. The same revenue from 20 or 200 transactions forecasts the same demand.
- There is no trend or seasonal model, and only the last 56 days count.
- Forecast accuracy has not been evaluated.

Evaluation of volume, temporal distribution and holdout accuracy belongs to a separate package.

## 10. Dataset-substitution evidence

`tests/integration/commerce-independence.test.ts`, through production ingestion, forecast, staffing and AI preparation:

| Dataset | Setup | Verified |
|---|---|---|
| A | 2 locations, GBP, Monday-heavy, £75/hour, configured rota | Forecast, required labour, gap and top-ranked day (Monday) equal independently computed values |
| B replaces A | Weekend-heavy, other values, £180/hour | All follow B; Saturdays lead; A's assessment goes stale; same AI instructions |
| C | 10 days only | No forecast, no staffing, reason shown, no model call |
| C (invalid) | Batch with a negative value | Rejected whole; valid history intact |
| ZAR | 3 South African locations, R1,500/hour | Staffing and AI input in ZAR; no conversion; no `£` or London on the page |
| Adversarial | 1 location in USD, 3 in ZAR, 7 in EUR; odd rates; histories ending in 2024–2026 | Exact values for every location and day |
| Source scan | Intelligence source files and AI instructions | No store names, codes, dates, fixed rates or GBP fallbacks |

**Genuine verification (real `gpt-6-luna`, production build, disposable database):**

| Time | Business | Result | Response ID |
|---|---|---|---|
| 16:33:40 | ZAR, 2 of 3 locations without a rota | `FAILED / VALIDATION_SCHEMA` | `resp_072821117adf5707016ae618652e7c87d2a679feb67325d257` |
| 16:35:18 | Same, after adding diagnostics | `FAILED / VALIDATION_SCHEMA` (`priorities.1.evidence`) | `resp_06877a4d4f3c7a8f016ae618c763cc87d29a4b24c1217b11f1` |
| 16:38:09 | Same, after the general contract fix | `AVAILABLE` | `resp_02b4670121eb50e8016ae6197240f087d2bb0f8ec4f9c3a96d` |
| 16:39:14 | UK reference company | `AVAILABLE`, ranking matches the calculated order | `resp_0255dc632afcf355016ae619b3408487d2822f51d9c65e36d6` |

**A real substitution defect this found.** Reference data has complete rotas, so it never revealed that the AI task did not say what to cite when a location has no weekly totals. The validator correctly rejected the output. The task gained one general rule on citing only figures that exist, with a regression test. **No dataset-specific prompt exists or is needed.**

## 11. Negative and adversarial test evidence

| Area | Where |
|---|---|
| Ingestion matrix (section 3), repeats, conflicts, atomicity, currency drift | `tests/integration/commerce-ingestion.test.ts` |
| Policy: resolve, override, versions, removal, no default, currency isolation, invalid values | `tests/integration/business-policy.test.ts`, `tests/unit/staffing.test.ts` |
| Coverage: positive, zero, not set, over-coverage, repeats, blank day, invalid | `tests/integration/business-policy.test.ts` |
| Staffing: £0, below one interval, exact boundary, large, unsafe size, coverage above requirement, no negative or non-finite values | `tests/unit/staffing.test.ts` |
| Source-selection precedence | `tests/unit/source-selection.test.ts` |
| Migration preservation and database constraints | `tests/integration/migration.test.ts` |
| AI malformed output, references, numbers, ranking, staleness, failures, access, no render calls, no side effects | `tests/integration/ai-staffing.test.ts`, `tests/unit/ai-staffing-contract.test.ts` |

**Would the suite catch a regression? Tested, not assumed.** Each assumption below was injected separately into a throwaway copy of the tree, and four suites were run against it (48 tests; the unmodified control passed 48/48).

| Injected assumption | Tests failed |
|---|---|
| Silent £100 default when no policy exists | 7 |
| Fixed £100 rate, ignoring the policy | 9 |
| GBP-only staffing | 9 |
| Five-store assumption | 11 |
| Reference-only history (imported ignored) | 15 |
| History always ending 28 Dec 2025 | 11 |
| "Not PayPal" means synthetic | 5 |
| A city name in intelligence source | 1 |
| Mismatched override falling back to the organisation default | 1 |

**Full verification on the final tree:**

| Check | Result |
|---|---|
| `pnpm test` | **348/348** twice in a row (247 s and 241 s), 46 files |
| Typecheck, lint, `next build`, `smoke:manager`, `git diff --check` | Pass |

Timeouts were not raised. Two AI tests once ran past the 5 s limit (6.8 s and 5.4 s) during FS-AI-001, and neither did so in these runs.

## 12. Security and access

- **Owner only, enforced on the server:** set or clear policies, set coverage, read configuration. Manager and worker scopes get `Access denied.`; a forged scope naming another tenant's location gets `Location unavailable.`
- **Actions:** new actions pass through `requireScope(["OWNER"])`, and the subscription gate test now includes them.
- **Managers** consume the resolved policy for their own location. They get no form.
- **Tenant isolation:** another business's policy is never applied.
- **AI privacy:** no location name or outlet ID appeared in any stored AI input.

## 13. Browser evidence

Local production build; disposable PostgreSQL 15; headless Chrome; two businesses.

| Check | Result |
|---|---|
| Owner Sales, Forecast and policies at 1366, 1024, 390 px | No overflow; focus on every stop |
| Manager Plan at the same widths | No overflow; one focus miss on the existing native date filter, unchanged |
| Console and server errors | None |

| State | Observed |
|---|---|
| Forecast, no policy | "No labour policy is configured"; "This does not mean no labour is needed"; no AI offered |
| Policy, no rota | "Regular coverage not set"; gap unavailable |
| Configured through the real Owner forms | Hours shown; the form's currency defaulted to ZAR from the evidence |
| Imported evidence | "Imported sales history · not provider-verified"; no synthetic or PayPal wording |
| Reference evidence | "Reference sales history · synthetic"; "the reference company's configured assumption" |
| AI not configured, or rejected | Calculated figures complete; no AI text |
| AI stale after a policy edit | Older content hidden; staleness stated |
| Non-GBP | ZAR amounts; generation time in Africa/Johannesburg |

## 14. Remaining limitations

- No user-facing import exists; the boundary is application-level.
- Refunds and voids are not modelled; only completed sales enter.
- The Owner sets the rota; Managers cannot.
- Non-two-decimal currencies are refused rather than supported.
- The legacy single-day code remains, unreachable.
- The legacy demo location has no labour policy until configured, so its staffing shows unavailable.
- AI wording is structurally and numerically validated, but its meaning is **not** independently verified.
- **Known P0 for FS-SCHED-001:** shift entry still parses `+02:00` (Johannesburg) for every location. It is the first required correction there, deliberately not changed here.
- Nothing is hosted. Migrations 0011–0016 are not applied to any hosted database, and a hosted reference organisation must re-run its loader to receive its policy.

## 15. Golden Path effect

| Step | Effect |
|---|---|
| 1 Owner views historical sales | Protected; imported provenance added |
| 2 Owner views forecast and staffing | Now uses the business's own policy |
| 3 Owner drills into demand, coverage, requirement | Zero and unavailable are distinct |
| 4 Manager proceeds toward Fill Shifts | Protected |

## 16. Claims unlocked

- "Labour productivity is each business's own configured policy, with location overrides."
- "Regular coverage is business data; zero and not-set are distinct."
- "Genuine imported history is represented truthfully, separate from reference, demo and PayPal data."
- "A different valid dataset, in another currency, drives forecast, staffing and AI input without source or dataset-specific prompt changes." Verified in tests, and with one genuine model call on ZAR data.
- "Missing policy produces unavailable staffing, never a default."

## 17. Claims still prohibited

- Forecast accuracy.
- Transaction-volume, unit or intraday intelligence.
- Sales value as a proven labour predictor.
- Zettle integration, or a customer import product.
- Production or live data. All verification data here is generated, including the ZAR fixture.
- Hosted verification.
- Semantic verification of AI wording.
