Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Wage Intelligence Evidence

| Control | Value |
|---|---|
| Packages | FS-HACK-WAGE-INTEL-001, the correction FS-HACK-WAGE-INTEL-001R, and the closeout FS-HACK-WAGE-INTEL-001C, which constrained enforcement to the England demo scope. All authorised by the Owner on 4 November 2026 |
| Decisions | FS-WAGE-INTEL-DEC-001 and FS-WAGE-INTEL-DEC-002 ([specification, section 1](FAIRSHIFT_PRODUCT_UX_SPEC.md)) |
| Baseline | Branch `fs-square-live-001`, HEAD `5b0d90234aad528c5102c3c5d2e3432507f28dc1` |
| Status | IMPLEMENTED, TESTED and VERIFIED LOCALLY in an isolated browser run (section 6). Committed locally in one commit under FS-HACK-WAGE-INTEL-001C. **Not pushed or deployed.** Not deployed. The AI explanation is **NOT VERIFIED** with a genuine model call |
| Golden-path steps | Roadmap section 15: 5 (shift under Owner pay policy), 7 (offer sent), 8 (worker sees terms and accepts), 11 (pay components presented), 15 (earnings and payout understood) |

Status terms follow [`AGENTS.md`](../AGENTS.md) section 8.

## 1. What is enforced (FS-WAGE-INTEL-DEC-002)

Every shift at a location under the UK wage reference must pay at least the GOV.UK rate for workers aged 21 and over in force on the shift's local date. That is £12.71 from 1 April 2026 and £13.21 from 1 April 2027. The demo company's locations are in England, the demonstration jurisdiction confirmed by the Owner.

| Situation | Status shown | Shift creation and offers |
|---|---|---|
| Pay per hour at or above the adult rate for the date | Rate checked | Allowed |
| Pay per hour below it | Below FairShift demo minimum | Refused by the server (`wage-below-minimum`) |
| No verified rate for the date (before 1 April 2024, after 31 March 2028) | Statutory reference unavailable | Refused (`wage-reference-unavailable`) |
| Commission, another currency, or unreadable terms | Pay can’t be checked | Refused (`wage-not-checkable`) |
| Scotland or Wales: same GOV.UK rates, outside the approved demo scope | Outside demo jurisdiction | Unchanged existing behaviour |
| Another country, Northern Ireland, or no country recorded | Statutory reference unavailable | Unchanged existing behaviour |

- **No youth or apprentice exceptions.** The check takes no worker facts at all. The lower categories are shown only as reference information. FairShift holds no age or apprenticeship records, and the page says this is a FairShift competition policy, not a statement that younger workers are legally owed the adult rate.
- **Daily terms** are compared exactly as pay per scheduled hour, in integers.
- **Existing Owner rates** are never changed: below-floor terms are kept and flagged, and shifts can't be created or offered on them.
- **Scope as implemented.** The approved England demo jurisdiction only: England and plain UK country values ("United Kingdom", "UK", "GB", "Great Britain"), which nothing else would place in England. FS-HACK-WAGE-INTEL-001R had also enforced the floor in Scotland and Wales, and FS-HACK-WAGE-INTEL-001C removed that, because wider enforcement was not authorised. Those locations now behave as before these packages.
- **Superseded.** FS-WAGE-INTEL-DEC-001's "Verification required" band, between the lowest category rate and the adult rate, is removed: under it, £8.00 to £12.70 could be offered with a warning. FS-HACK-WAGE-INTEL-001 implemented that band, and this package replaced it.

## 2. Where it lives

| Area | Behaviour |
|---|---|
| `src/server/domain/statutory-wage.ts` | Versioned dataset `fs-uk-nmw-v1`, jurisdiction mapping, `checkWage` (adult floor, no worker facts), `wageAllowsOffer`, `DEMO_WAGE_POLICY`. No server or React dependencies, so the forms preview the server's exact rule |
| `src/server/scheduling/operations.ts` | `assertWageAllowsOffer` runs inside `createRequirement` (including shifts created from a forecast opportunity) and `offerAssignment`. Unreadable terms are checked as unreadable, never skipped |
| Owner → Compensation | A "FairShift demo minimum · today" block, the competition-policy statement, all categories as reference, the next published change ("isn’t in force yet") and the GOV.UK source. Each policy shows its status. New hourly terms are prefilled at the adult rate, with a live check as the Owner types |
| Owner → Location | The demo minimum today, the policy statement and the source |
| Manager → Fill Shifts | The create form previews hourly wage, guaranteed base pay, variable earnings, a tips note and the check for the shift's date; Create is disabled below the floor. Each shift card shows its status, and "Send offer" is replaced by a reason when blocked |
| Worker → Offers | Guaranteed base pay, potential variable earnings ("Not guaranteed", the bonus condition, "Tips: not included"), final approved earnings, the holiday-pay disclosure and the adult-rate line |
| Worker → Earnings | "Final approved earnings" only once approved, and "Not final until your manager approves it" before then. Tips and holiday pay are disclosed as not included. The PayPal status display is unchanged |

Unchanged: the payable formula, base payable derivation, approval, PayPal payouts, Square attribution, forecasting, Bryntum, subscriptions, roles and location scope. No schema change, migration or dependency was added.

## 3. Wage data provenance

| Item | Value |
|---|---|
| Source | GOV.UK, "National Minimum Wage and National Living Wage rates", https://www.gov.uk/national-minimum-wage-rates |
| Verified | 4 November 2026, twice: in FS-HACK-WAGE-INTEL-001, and again before enforcement in FS-HACK-WAGE-INTEL-001R. Both read the GOV.UK content API (`/api/content/national-minimum-wage-rates`, `updated_at` 2 November 2026). Its current table shows April 2026 £12.71 / £10.85 / £8 / £8 and April 2027 £13.21 / £11.27 / £8.31 / £8.31, and the page states "The rates change on 1 April every year" |
| Status | **VERIFIED** against that source for every row below |

| Valid from | Valid to | 21 and over (enforced) | 18 to 20 | Under 18 | Apprentice |
|---|---|---|---|---|---|
| 1 Apr 2024 | 31 Mar 2025 | £11.44 | £8.60 | £6.40 | £6.40 |
| 1 Apr 2025 | 31 Mar 2026 | £12.21 | £10.00 | £7.55 | £7.55 |
| 1 Apr 2026 | 31 Mar 2027 | £12.71 | £10.85 | £8.00 | £8.00 |
| 1 Apr 2027 | 31 Mar 2028 | £13.21 | £11.27 | £8.31 | £8.31 |

The April 2027 rate applies only to shifts dated on or after 1 April 2027 (tested). Territorial extent is **INFERENCE**: the pages don't name the nations. Northern Ireland is **NOT VERIFIED** because nidirect returned 404. Pay reference periods aren't modelled: a shift is checked against the rate on its local start date. This is not legal advice.

## 4. AI explanation

`src/server/intelligence/wage-explanation.ts` and `explainWageAction`. It is optional and is never part of enforcement.

- It runs on request, for the Owner role only, rate-limited, and never in the public demo.
- Its input is the deterministic check plus the competition-policy statement, with no names or places.
- Its output is words only. Digits, currency or percent signs, compliance or guarantee claims, legal advice and exemptions are rejected. Nothing is stored except an audit event without the text.
- **Without AI configured**, the button isn't shown, the full check and source still render, and terms and shifts are created normally. This is tested, and was observed in the browser run, where the mirror had no OpenAI key. A provider failure or rejected output shows a plain message, never a fabricated explanation (tested with stub providers).
- **NOT VERIFIED** with a genuine model call. No paid or external model call was authorised or made.

## 5. Tests (FS-HACK-WAGE-INTEL-001R and -001C)

Run locally on 4 November 2026 with Node 24.22.0 on in-process PGlite. No hosted database or provider was contacted.

| Command | Result |
|---|---|
| `pnpm vitest run tests/unit/statutory-wage.test.ts` (final) | 19 / 19 passed |
| `pnpm vitest run tests/integration/wage-intelligence.test.ts` (final) | 10 / 10 passed |
| `pnpm vitest run` (full suite, after all fixture repairs, before the final CSS-only fixes) | 893 / 893 passed, 71 files |
| `pnpm vitest run` (001R final tree) | 893 / 893 passed, 71 files |
| `pnpm vitest run` (001C final tree, JSON reporter) | **896 / 896 passed, 71 files; 0 skipped, pending or todo.** The 69 pre-existing files hold 867 tests, the HEAD baseline (register P-18); the two new wage files hold 29 |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` (001C final tree) | Clean; build compiled successfully. `next-env.d.ts`, rewritten by the build, was restored to its pre-existing content |

**Test counts.** 867 pre-existing tests, plus 27 new from FS-HACK-WAGE-INTEL-001 (20 unit, 7 integration), gave 894. FS-HACK-WAGE-INTEL-001R rewrote the two new files for DEC-002 (18 unit, 8 integration), which gave 893: the superseded age and apprenticeship category tests were removed with the functions DEC-002 removed. FS-HACK-WAGE-INTEL-001C added the England-scope cases (19 unit, 10 integration), which gives 896. No pre-existing test was removed or skipped: all ten modified pre-existing test files have the same test declarations and parameter rows as at HEAD. Of their 109 changed lines, 98 only change values (rates and recomputed amounts), and the rest are comments, the fixture redesigns described below, or added assertions.

Package requirements 1–15 map to tests as follows:

| # | Requirement | Test |
|---|---|---|
| 1 | England 2026 adult minimum | Unit "1. uses £12.71…" |
| 2 | England 2027 adult minimum | Unit "2. uses £13.21…, and not before" |
| 3 | Effective-date transition | Unit "3. switches at the effective date"; integration 7/3/10/11 (£12.50 in March versus April 2026) |
| 4 | Rate above the floor | Unit 4 |
| 5 | Rate equal to the floor | Unit 5; integration (£12.71 × 8h = £101.68 created) |
| 6 | Rate below the floor | Unit 6 |
| 7 | Server-side shift-creation rejection | Integration 7 (service and form paths) |
| 8 | Server-side offer rejection | Integration 8 (service, form and Owner paths) |
| 9 | Existing Owner compensation preserved | Integration 9 (rows identical after render; below-floor terms kept) |
| 10 | No youth or apprentice bypass | Unit 10 (£10.85 and £8.00 refused; extra worker facts ignored); integration (the 18–20 rate is refused) |
| 11 | Missing statutory reference | Unit 11; integration (2028-04-10 refused; non-UK unchanged) |
| 12 | Owner and Manager location permissions | Integration 12 |
| 13 | Worker-facing guaranteed earnings | Integration 13/14/15 |
| 14 | Variable earnings labelled correctly | Integration 13/14/15 |
| 15 | Payment calculations unchanged | Integration 13/14/15 (payable equals the guaranteed base shown); the existing payable and payout suites |

**Fixture repairs.** The adult floor refused long-standing fixtures that paid £12.00 an hour at UK locations. They now pay £13.00 an hour, with the same times, target and bonus, and dependent amounts recomputed: for example, £96 + £25 = £121 became £104 + £25 = £129 in `square-live` and `performance-incentive`. The historical GBP 121.00 PayPal Sandbox evidence (`PAYPAL_FINAL_EVIDENCE.md`, and `paypal-final.test.ts`, which uses the short Square demo shift) is untouched. Other repairs:

- The small-earnings rendering fixture now uses 15 minutes at £13.00 (£3.25) instead of a sub-minimum rate.
- The commission confirmation test asserts that commission is refused in England, then runs at a location outside the reference.
- An "unfinished" shift moved from 2030, which has no verified rate, to 10 March 2028 at £14.00.
- The governance test now asserts the current `AGENTS.md` status ladder ("APPROVED ≠ IMPLEMENTED ≠ TESTED ≠ VERIFIED LOCALLY ≠ DEPLOYED ≠ VERIFIED ON HOSTED ≠ DEMO-READY") and that the authority register states the same ladder.

## 6. Local browser verification

| Item | Value |
|---|---|
| Environment | Mirror `~/fairshift-verify/app-mirror`, synced from the working tree and confirmed identical (`diff -rq`), served by `next dev --webpack` on 127.0.0.1:3001 under `env -i` with only `PATH`, `HOME`, `DATABASE_URL` and `APP_BASE_URL`. There were no PayPal, Square or OpenAI credentials, so no provider call was possible |
| Database | Disposable TCP-only cluster on 127.0.0.1:55433, database `fairshift_ownerops_verify_20261103`. Its "TEST Owner Ops Verification Cafe" organisation is in the United Kingdom. Neither the canonical nor the hosted database was used. A disposable worker was created through the app's own invitation path |
| Browser | Headless Chrome over the DevTools protocol: 1280px for Owner and Manager, 390px mobile emulation for Worker and Owner |
| Result | **88 / 88 checks passed** ([`evidence/fs-hack-wage-intel-001r/browser-checks.json`](evidence/fs-hack-wage-intel-001r/browser-checks.json)). No browser errors |

What was exercised:

- **Owner** (29 checks):
  - benchmark, source, effective dates and the April 2027 notice;
  - £12.71 prefill, with live checks at £12.00 (Below) and £12.71 (Rate checked);
  - £12.00 terms created, kept and flagged; £13.00 terms show Rate checked;
  - location panel; no horizontal overflow at 390px.
- **Manager** (19 checks):
  - below-floor preview, with Create disabled;
  - **a forced submit with the button re-enabled was refused by the server** and no shift was created;
  - a checked shift was created and offered;
  - **a stale page's Send offer was refused by the server** after the stored terms fell below the floor, no offer was created, and the reloaded card explains why.
- **Worker** (25 checks, 390px):
  - all offer terms;
  - the guaranteed, variable and final order;
  - Accept disabled until acknowledged;
  - no overflow or clipped labels;
  - both offers accepted.
- **Earnings** (15 checks):
  - one-hour £13.00 shift allocated, finished and confirmed, with a payable of £13.00;
  - "Not final until your manager approves it" before approval and "Final approved earnings" after;
  - nothing shown as paid;
  - the existing payout progress and "Payment details required" display unchanged.

**Timing.** The browser run was made under FS-HACK-WAGE-INTEL-001R, before FS-HACK-WAGE-INTEL-001C limited enforcement to the England demo scope. The scratch organisation's location is recorded as "United Kingdom", which is still enforced, so every flow above behaves the same after that change. The one visible difference is the jurisdiction badge, which now reads "England demo jurisdiction · United Kingdom" instead of "UK · United Kingdom", as in the screenshots. Scotland and Wales behaviour is covered by integration tests, not by this browser run.

Defects found in the browser and fixed in this package:
- the demo-minimum block had no styles, so its label, amount and note ran together;
- the "Not guaranteed" pill broke across two lines at 390px.

Both were re-captured after the fix. Screenshots are in [`evidence/fs-hack-wage-intel-001r/`](evidence/fs-hack-wage-intel-001r/). The dark "N" circle in them is the Next.js development indicator, and a bar mid-page in full-page mobile captures is the fixed bottom navigation drawn at the viewport edge.

## 7. Demo evidence matrix rows

| Stage | Positive | Negative or control | Automated | Status | User-visible | Demo step |
|---|---|---|---|---|---|---|
| Owner sets pay | £12.71 benchmark prefilled, Rate checked, source shown | £12.00 flagged "Below FairShift demo minimum", kept unchanged | Integration 9; browser | Verified locally | Compensation | 5 |
| Manager creates shift | Terms preview with check | Below-floor refused on the server, even when forced | Integration 7; browser | Verified locally | Fill Shifts | 5 |
| Manager sends offer | Offer on checked terms | Stale below-floor offer refused on the server | Integration 8; browser | Verified locally | Fill Shifts | 7 |
| Worker offer | Guaranteed / variable / final blocks | No tip or holiday amount invented | Integration 13/14; browser | Verified locally | Offers (mobile) | 8, 11 |
| Worker earnings | "Final approved earnings" after approval | "Not final" before; nothing shown as paid | Integration 15; browser | Verified locally | Earnings (mobile) | 15 |

Hosted behaviour and a genuine AI explanation are **NOT VERIFIED**.
