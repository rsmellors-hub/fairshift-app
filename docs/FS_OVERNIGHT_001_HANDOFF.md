# FS-OVERNIGHT-001 HANDOFF

> **Historical handoff, 25 October 2026. It does not direct new work.** Its recommendations (FS-STAFF-001, decision D2, a USD £100-per-labour-hour policy) and its claims lists have been overtaken. Current authority: [`FS-DOCUMENT-AUTHORITY-REGISTER.md`](FS-DOCUMENT-AUTHORITY-REGISTER.md), sections 1 and 2. The body below is unchanged.

## 1. Executive summary

All four primary packages passed and were committed separately:

- FS-OWNER-001-CLOSE;
- FS-TEST-001;
- FS-REF-001;
- FS-FCST-001.

The surplus queue produced:

- one pre-existing production defect fix (database pool exhaustion);
- one hardening commit (the Sales page now shows reference history; workspace
  counts are aggregated in SQL);
- one quality commit (per-request memoisation; dated copy);
- one test-only commit;
- one copy fix.

FairShift can now hold a labelled five-store UK reference sales history and
forecast seven days of demand per location for the Owner, under a deterministic
source rule that one provider transaction can no longer override.

The established 297,802-transaction dataset was **not located**. A deterministic
representative generator was built instead.

One product decision blocks the next step (§13, D2). Reference forecasts target
the week after the history ends (29 Dec 2025 – 4 Jan 2026), not a 2026 week.
FS-STAFF-001 needs a decision on how reference evidence maps onto a real future
planning week.

The run finished at about 1 h 30 min of the 8 h window. Implementation stopped
when the authorised queue was complete, rather than continuing to change code.

## 2. Starting checkpoint

| Item | Value |
|---|---|
| Directory | `/Users/ryanmellors/Projects/Fairshift/app` |
| Branch | `main` |
| HEAD | `f72e23b9d8d19c0e9b3b7b21f14ca3342fea1c1f` |
| Dirty state | Exactly the 13 known FS-OWNER-001 entries (7 modified, 6 untracked) |
| `git diff --check` | Clean |

## 3. Runtime used

| Item | Value |
|---|---|
| Node | 24.22.0, via the existing `~/.nvm` install (the shell default was 24.15.0) |
| pnpm | 12.11.2 (the repository `packageManager`) |
| Tests | Vitest 5.0.4 with in-process PGlite per test |
| Local app verification | Production `next build` + `next start` on port 3100. It used a disposable PostgreSQL 15 instance created in the session scratchpad (port 55432) with PayPal, OpenAI and Resend variables blanked. Your local `fairshift` database was not used, because its role cannot create databases. |
| Browser | Headless Chrome for Testing (already cached locally), driven over CDP with Node's built-in WebSocket. Nothing was installed. |

## 4. Existing dataset discovery

**STATUS: NOT FOUND**

**Search scope:**

- the repository;
- `~/Projects/Fairshift/recovery`, which contains only a corrupt `node_modules`;
- `~/Projects/Fairshift-OLD-QUARANTINED-20261025`: an old app copy, empty
  `work`/`outputs` folders and marketing-site tarballs;
- `~/Desktop/FairShift-Recovered-PreRepair-20261025`, a repository copy;
- a home-wide search by file name for CSV, Parquet, SQLite, DB, JSONL and ZIP
  files and for FairShift, Zettle, synthetic, UK01 and holdout names;
- a content search for the markers 297802, 486067, 34220, UK01, Briggate,
  2025-10-06 and Stratford.

**Artifacts found:**

- Only earlier Claude session transcripts. The FS-ZETTLE-001 prompt describes
  the dataset design, and FS-COMP-001C holds the estimate register.
- No data files.

**Dataset path(s), size and schema:** none exists.

**What was imported:** nothing.

**What was committed:** a deterministic generator (`src/server/reference/uk-retail.ts`)
and an operator. Generated data is not committed.

**Reason:** the instructions say not to fabricate the historical counts. The
generator produces 287,961 transactions over the same 104-week range for the
same five store anchors. Any similarity to the earlier design's volume is not a
reproduction of it. Line items, SKUs and store-hour records are not modelled.

## 5. Packages attempted

### FS-OWNER-001-CLOSE — PASS

| Item | Detail |
|---|---|
| Start HEAD | f72e23b |
| End HEAD | b520a66 |
| Commit | b520a66 `feat: add owner overview workspace` |
| Time | 20:54–21:10, about 16 min |
| Files | The 13 FS-OWNER-001 files only |
| Migrations | None |
| Focused tests | 30/30 |
| Full suite | 216/216 with `--no-file-parallelism` (the default parallel run had 82 PGlite timeouts, which led to TEST-001) |
| Typecheck, lint, build | Pass |
| Browser | 1366/1024/390, empty state: no overflow; skip link and focus visible; mobile menu opened |
| Defects found | (a) The opened mobile Owner menu rendered as a clipped horizontal row and uppercased the planned "Incentives" item. (b) Pre-existing: production database pool exhaustion (D1, fixed later). |
| Defects fixed | (a), in `owner.css` |
| Deferred | Populated-history browser check, done in FS-REF-001 |

The Owner navigation labels (Sales, Forecast, Managers, Compensation, and
"Incentives — Not available") differ from the product specification §4 labels.
They were kept as authored in FS-OWNER-001.

### FS-TEST-001 — PASS

| Item | Detail |
|---|---|
| Start HEAD | b520a66 |
| End HEAD | 7ac130e |
| Commit | 7ac130e `test: stabilise integration test execution` |
| Time | 21:10–21:17 |
| Files | `vitest.config.ts` (`fileParallelism: false`, with a reason comment) |
| Timeouts | Not raised. The slowest test runs in 2.7 s serially, against the 5 s limit. |
| Full suite | `pnpm test` passed 216/216 on two consecutive runs (about 127 s each) |
| Typecheck, lint | Pass |

### FS-REF-001 — PASS

| Item | Detail |
|---|---|
| Start HEAD | 7ac130e |
| End HEAD | 4d18d89 |
| Commit | 4d18d89 `feat: add five-location reference sales history` |
| Time | 21:17–21:31 |
| Migration | `0011_reference_sales_history` (additive: `REFERENCE` source, nullable `occurred_at`, provenance check, `(outlet_id, occurred_at)` index) |
| Files | schema, migration and snapshot, `src/server/reference/{uk-retail,provision}.ts`, `scripts/load-reference-history.ts`, the `reference:load` script, Owner Overview SQL aggregation and labels, tests |
| Focused tests | 6 unit and 6 integration tests, plus a migration-preservation test |
| Full suite | 229/229 |
| Typecheck, lint, build | Pass |
| Browser | Overview with 288k rows at 1366/1024/390: GBP, "Reference sales history", data through 28 Dec 2025, Christmas Day unknown, no overflow |
| Defects found | Owner Overview loaded every sale row into memory; it now aggregates in SQL |
| Deferred | Sales page and workspace counts (done in HARDEN) |

`DEMO_SEEDED` stays as the legacy Rosebank value; `REFERENCE` is new and
separate. The migration-count assertion in `owner-onboarding.test.ts` was
updated from 11 to 12.

### FS-FCST-001 — PASS

| Item | Detail |
|---|---|
| Start HEAD | 4d18d89 |
| End HEAD | afc7de7 |
| Commit | afc7de7 `feat: add weekly demand forecasting` |
| Time | 21:31–21:51 |
| Migrations | None |
| Files | `forecast.ts` (core extracted: `forecastFromHistory`, `staffedForecast`, `eligibleObservation`, `startOfLocalDay`), new `sales-history.ts` and `weekly.ts`, `manager.ts`, `manager-forecast.tsx`, Owner forecast page, Overview, tests, `scripts/smoke-manager.ts` |
| Focused tests | 11 source-selection, 5 weekly, plus updated manager tests |
| Full suite | 247/247 |
| Smoke | `smoke:manager` PASS |
| Typecheck, lint, build | Pass |
| Browser | Forecast and Overview at 1366/1024/390: no page overflow; the 1024 table scrolls inside a focusable region with a sticky location column |

Defects found and fixed:

- The provider-precedence defect: one PayPal capture replaced the demo history.
- The manager UI hard-coded USD and "16 October 2026".
- `smoke-manager.ts` asserted a label that no longer existed. This was
  **pre-existing**; the smoke was already failing at the starting HEAD.

Intended behaviour changes:

- The Rosebank demo single-day target is now derived from the data:
  Thursday 2026-10-15 (7 workers, +2), previously the fixed
  Friday 2026-10-16 (8 workers, +3).
- The Owner Forecast page now shows the weekly forecast and no longer shows the
  manager single-day AI assessment.

Deferred: the D2 planning-week decision (§13).

### FS-OVERNIGHT-HARDEN — PASS

| Item | Detail |
|---|---|
| Commits | 93b86cb `fix: reuse database pool in production`; 5d5a419 `chore: harden reference forecasting workflow`; b3155c2 `test: cover manager forecast for reference history`; 1b307b7 `fix: clarify empty weekly forecast summary` |
| Time | 21:51–22:15, including QUALITY |

Defects fixed:

1. **Pre-existing production defect.** `getDatabase()` cached its pool only
   when `NODE_ENV !== "production"`, so `next start` opened a new pg pool on
   every call. After about 7 page loads PostgreSQL returned "too many clients
   already", which surfaced as React error #441. After the fix, 15 loads plus
   re-navigation produced no errors and 3 connections. **This bug also exists
   on the hosted deployment until this commit is deployed.**
2. The Owner Sales page showed nothing for reference history. It now uses the
   canonical aggregation, with a reference label.
3. Each Owner area page loaded every sale row. Counts are now aggregated in SQL.
4. When no location had history, the forecast summary said "Varies by location".

Tests added: the database pool, the Owner reference pages, the manager forecast
for a GBP reference outlet, and the empty forecast summary.

### FS-OVERNIGHT-QUALITY — PASS

| Item | Detail |
|---|---|
| Commit | c557559 `refactor: strengthen commerce intelligence foundation` |
| Change | Per-request memoisation of the organisation daily aggregation |
| Measured result | Overview response time fell from about 610 ms to about 312 ms on 288k rows |
| Copy | "Recent" became dated "Latest" wording |

Investigated and not changed:

- A windowed SQL variant gave no gain. The sort on the per-series maximum
  dominates, and a real gain would need an expression index, which means a new
  migration.
- The source-label maps in four UI contexts were left in place. Their wording
  is context-specific and tested.

### FS-OVERNIGHT-EVIDENCE — PASS

This handoff, plus `docs/REFERENCE_COMMERCE_FORECAST_EVIDENCE.md`. The lost
`docs/OWNER_OVERVIEW_EVIDENCE.md` was not reconstructed.

## 6. Final repository checkpoint

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD | The docs commit that adds this file (`git log -1`) |
| Status | Clean after the docs commit |
| `git diff --check` | Clean |

Nothing was pushed or deployed.

## 7. Complete commit list

1. `b520a66` feat: add owner overview workspace
2. `7ac130e` test: stabilise integration test execution
3. `4d18d89` feat: add five-location reference sales history
4. `afc7de7` feat: add weekly demand forecasting
5. `93b86cb` fix: reuse database pool in production
6. `5d5a419` chore: harden reference forecasting workflow
7. `c557559` refactor: strengthen commerce intelligence foundation
8. `b3155c2` test: cover manager forecast for reference history
9. `1b307b7` fix: clarify empty weekly forecast summary
10. docs: add overnight development handoff (this file and the evidence record)

## 8. Test status

| Check | Result |
|---|---|
| Focused tests | Passed for every package (see §5) |
| Full suite | `pnpm test`: 36 files, 250/250 (216 at the start) |
| Stability | Final full runs 250/250 twice consecutively (about 139 s each); earlier full runs after each package were also green |
| Typecheck | Pass |
| Lint | Pass, with 0 warnings |
| Build | `next build --webpack` pass |
| Smoke | `pnpm smoke:manager` PASS |

## 9. Product capability gained

Things FairShift can now do that it could not at the start:

- Hold a labelled synthetic five-location UK reference history (GBP, 2024–2025),
  with database-enforced provenance, loaded only by an explicit,
  organisation-scoped, idempotent operator.
- Give the Owner a seven-day demand forecast for every location, with ranges,
  evidence, data-through date, source, and a company total when combinable.
- Choose each location's history with a deterministic, versioned eligibility
  rule. A handful of provider sales no longer replaces history, and sources are
  never mixed.
- Show reference history on Owner Overview and Owner Sales without loading rows
  into memory.
- Keep a production server stable under normal navigation (the pool fix).

## 10. Data truthfulness

- **Reference provenance.** `source = REFERENCE`,
  `provider_status = REFERENCE`, unverified and unreconciled, no PayPal fields,
  and explicit `occurred_at`. All of this is enforced by a CHECK constraint.
  The UI says "Reference sales history … not Zettle, PayPal or other provider
  sales".
- **Currency.** GBP for reference data. PayPal payout currency is unchanged.
  The USD staffing policy is not applied to GBP.
- **Historical cutoff.** 28 Dec 2025. Dates are never rewritten.
- **Forecast target dates.** Historical evidence covers the seven days after
  its data-through date (29 Dec 2025 – 4 Jan 2026). Verified provider sales
  plan from tomorrow. Both cases are labelled.
- **Provider-source behaviour.** `source-eligibility-v1`: at least 28 days, at
  least 3 of every weekday, fresh data, and the planning currency. Rejected
  sources are shown with reasons.

## 11. Claims unlocked

- "FairShift forecasts seven days of demand for each of five locations from
  labelled historical sales, deterministically, with planning ranges and
  evidence." This is deterministic, not AI.
- "Reference sales history is clearly separated from provider data, and that
  separation is enforced in the database."
- "A small amount of provider data cannot silently replace a complete history;
  source selection is rule-based and shown to the owner."

## 12. Claims still prohibited

- Zettle integration or Zettle sales. Calling reference data real, live or
  verified sales.
- AI forecasting. The forecast uses no AI.
- Forecasts for the current or next real week from reference history.
- Staffing gaps, coverage, or casual requirements from the weekly forecast.
- Forecast accuracy or holdout results. The holdout is reserved but not
  evaluated.
- That the earlier 297,802-transaction dataset is in use.
- That any of this runs on the hosted app. It has not been deployed and
  migration 0011 has not been applied there.
- Worker-level attribution.

## 13. Product-owner decisions required

1. **D2: planning week for historical evidence (blocks FS-STAFF-001).** Today
   the reference forecast covers 29 Dec 2025 – 4 Jan 2026. Staffing gaps and
   shifts need real future dates. Options:
   - (a) Keep the pinned historical week. This is demo-coherent only if
     staffing also uses that week, and shifts cannot then be future-dated.
   - (b) Forecast the next seven real days using the reference history's last
     56 days as evidence. This is a seasonal mismatch: Nov–Dec evidence would
     drive a late-October week. It must be disclosed.
   - (c) Extend reference history with 2026-dated synthetic rows, as
     FS-COMP-001C's D2 recommended. This conflicts with the overnight rule not
     to present reference transactions as 2026 trading, unless relabelled.
   - (d) Another approach, for example same-week-last-year evidence.

   Once decided, the code change is small: `selectForecastSource` sets
   `firstTarget` for historical sources.
2. **Staffing policy for GBP and the reference stores.** `STAFFING_POLICY` is
   USD 100 per labour hour for an 8-hour day. Reference stores trade 10 h
   Monday–Saturday and 6 h on Sunday. FS-STAFF-001 needs authorised GBP values.
3. **Location time zone.** `createLocation` hard-codes `Africa/Johannesburg`.
   UK locations need `Europe/London`. The operator offers an explicit
   `--set-london-timezone` flag as a workaround. Decide whether locations get a
   time-zone choice.
4. **Retailer brand (D1).** Still unauthorised; a neutral label is used.
5. **Confirm the Owner navigation labels** from FS-OWNER-001 against
   specification §4.

## 14. Blockers

- D2 blocks a meaningful FS-STAFF-001 coverage gap.
- Hosted verification needs a deploy, migration 0011, and running the operator
  against the hosted database. These are your actions; all were prohibited
  tonight. The pool fix should be deployed before judging.

## 15. Schedule effect

The FS-COMP-001C register gives these expected agent hours (best / expected /
contingency):

| Package | Hours |
|---|---|
| OWNER-001 | 0.5 / 1 / 2 |
| TEST-001 | 0.25 / 0.5 / 1 |
| REF-001 | 2 / 3 / 5 |
| FCST-001 | 2 / 3 / 5 |
| **Total** | **4.75 / 7.5 / 13** |

All four are complete, together with part of the browser checks (about 1.25 h
of browser time was planned). Two unplanned items came from the FIX reserve:
the pool fix and the Sales page fix, about 0.5–1 h.

**EXPECTED ENGINEERING HOURS RECOVERED TONIGHT: about 8.** That is 7.5 planned
package hours plus about 0.5 h of fix reserve. It is not 8 hours because the
run lasted 8 hours; the run took about 1.5 hours.

**EXPECTED ENGINEERING HOURS REMAINING TO LAYER 2: about 39 h** of feature
engineering, out of FS-COMP-001C's 46.5 (range about 29–60). On top of that:

- the fix reserve (about 9 h remaining);
- operations and submission packages;
- about 1–3 h for whichever D2 option is chosen.

FS-COMP-001C split the work as OWNER-001 and TEST-001 on Sunday 25 Oct and
REF-001 and FCST-001 on Monday 26 Oct. Monday's engineering is now done.

## 16. Layer 2 position

**AHEAD**, by about one planned engineering day. Monday's packages finished on
Sunday evening, with a green suite and a reliability defect fixed. Two things
are conditional: D2 needs answering before FS-STAFF-001, and none of this is
verified on the hosted app yet.

## 17. Tomorrow recommendation

**FS-STAFF-001**, started only after D2 and the GBP staffing policy are decided.
The D2 change itself can be folded into FS-STAFF-001's first step. Note that
the next migration number is now **0012**, not 0011 as FS-COMP-001C assumed.
This is a recommendation, not an authorisation.

## 18. Stretch-feature headroom

| Feature | Headroom | Reason |
|---|---|---|
| Availability (AVAIL-001) | POSSIBLE | About 1 day ahead, but it is Layer 3 and only after Layer 2 is verified on the hosted app |
| PayPal Sandbox sales ingestion (PPIN-001) | POSSIBLE | The source rule and canonical aggregation now make it truthful; the checkout path still needs tenant scoping |
| Zettle | NO HEADROOM | Needs genuine supported-market merchant access, and there is no sandbox |
| Additional UI refinement | LIKELY | Small, local, and the Owner pages are now populated |
| Deeper Owner drill-down | POSSIBLE | OWNER-002 is already Layer 2 scope; it builds on the weekly data |

## 19. Competition impact

- **Technological Implementation:** a real commerce-to-forecast pipeline on a
  canonical ledger, with DB-enforced provenance, a versioned source rule,
  SQL aggregation and 34 new tests. Production stability is fixed.
- **Design:** Owner Overview and Weekly Forecast are populated and responsive,
  with distinct states for fact, forecast and unavailable data.
- **Potential Impact:** a five-store weekly demand view is the base for the
  staffing story.
- **Innovation:** the truthful source-selection rule (provider data must earn
  precedence) is a defensible differentiator.
- **Presentation:** a reproducible demo dataset via one operator command, with
  clear provenance labels.

## 20. North Star Scope Check

1. **Vision alignment:** advances "connecting demand for work". Demand is now
   visible per location and day.
2. **Commerce/AI alignment:** the commerce step is complete. AI is deliberately
   not used in the forecast, and the forecast feeds the later AI staffing step.
3. **Opportunity alignment:** indirect. Shifts and offers come later.
4. **Fairness/transparency:** provenance, data-through dates, ranges and
   rejected sources are all shown. Nothing is fabricated.
5. **Closed-loop alignment:** POS → history → forecast is complete. The next
   link is staffing (blocked on D2).
6. **Product coherence:** one fictional five-store business. There are no
   demo-only branches; any organisation can load the reference history.
7. **Competition value:** high. It unblocks the weekly staffing story.

## Local verification artefacts (not committed)

The session scratchpad holds:

- a disposable PostgreSQL data directory (port 55432);
- the verification fixture and CDP browser scripts;
- screenshots;
- the progress ledger.

The disposable database server and app server were stopped at the end of the
run.
