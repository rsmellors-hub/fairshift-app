# Hospitality Policy Freeze Evidence (FS-HOSPITALITY-POLICY-FREEZE-001)

**Status: frozen and verified locally. Not deployed.** The reference company now has its Owner-decided workload policy and a corrected Leeds rota, and authority and public copy match. The resulting Opportunity Demand is reported below as it fell. Status terms follow `AGENTS.md` §8. Reference data is **SIMULATED**.

This builds on FS-WORKLOAD-INTELLIGENCE-001, whose record stands as package history. Before this package, that record correctly said the reference policy was unset.

## 1. Owner decisions (2 November 2026)

| Decision | Value |
|---|---|
| Reference company | One fictional five-location UK fast-casual café and dining group. Hospitality is the demo vertical, not an architectural restriction |
| Service model | Shared by all five: order and pay at the counter or POS; drinks and simple items may be collected; prepared food may go to tables; staff clear and reset. Not full table service |
| Bill value differences | Product mix, daypart, transaction composition and location behaviour, not different service models |
| Operational staff | Everyone on duty actively contributing to service capacity, including preparation and support staff and a Manager while working operationally. Excludes off-site management, purely administrative time and non-operational company staff |
| Capacity | **7 completed transactions per operational staff-hour** of sustainable busy service, organisation level, no location overrides |
| Minimum cover | **2 operational staff** whenever open to customers |
| Leeds | Weekday 15:00–17:00 and Sunday corrected from ×1 to ×2 |
| Birmingham | Saturday/Sunday difference is a justified reference rota characteristic |
| Stratford | Saturday/Sunday and commuter pattern is a justified reference rota characteristic |
| Earnings direction | Base + variable tips = total approved earnings. **Authorised, not implemented.** Tip allocation is open |
| Zettle | No new implementation authorised |

**Interpretation of 7:** 60 ÷ 7 ≈ 8.6 operational labour minutes per transaction across the whole team. It doesn't mean one person spends 8.6 minutes on one bill.

## 2. Evidence status of 7

**Classification: REFERENCE-COMPANY ASSUMPTION.** It is not an industry standard, a legal requirement, a measured customer benchmark, or anything learned by AI or from the synthetic data.

- **Internal construction:** estimated labour minutes for three bill types (3.0, 8.5 and 16.0, in a 40/45/15 mix) give about 7.5 direct minutes. Allowing about 85% of a busy hour for transaction-linked work gives 8.8 minutes, or 6.8 transactions an hour, rounded to 7. Every input is judgement. The plausible range considered was 6 to 8.
- **Limit on independence:** that analysis was not fully blind. Its author had earlier seen a capacity-versus-gap table on the old rota, including 6 and 8. No gap was calculated for the analysis until the value was written down, and nothing changed afterwards.
- **External plausibility check:** the Owner reports a foodservice benchmarking study showing 6.9 transactions per hour worked. It is recorded as a plausibility check only. It wasn't reviewed in this package, and it doesn't prove that 7 is correct for UK fast-casual hospitality.

## 3. Transaction proxy limitations

Transactions are the MVP operational-workload proxy. FairShift does not claim that every transaction takes identical labour, or that transaction count perfectly measures workload, or captures covers, item complexity, kitchen bottlenecks or queue length. One rate overstates quick commuter bills and understates large evening ones. None of those variables is to be added before submission.

## 4. Anti-tuning rule

The Golden Path example must be discovered from accepted product rules. Rules, reference demand, capacity, regular coverage and forecast parameters must not be chosen or altered to manufacture a preferred example. The historical 14:00–20:00, £96, £200, £25, £121 example is not a hospitality target. This rule is now in `AGENTS.md` §4 and the product specification, section 1.

## 5. What changed

| Item | Change |
|---|---|
| `src/server/reference/uk-hospitality.ts` | `REFERENCE_WORKLOAD_POLICY`, the Leeds rota, the company label |
| `src/server/reference/provision.ts` | Writes the policy with `REFERENCE` source unless the organisation already has one. No location override |
| `scripts/load-reference-history.ts` | Usage and output text |
| `src/app/owner/staffing-configuration.tsx` | Field hints match the sustainable busy-service definition |
| `src/app/page.tsx`, `product/page.tsx`, `faq/page.tsx`, `components/plan-cards.tsx` | False or stale forecast and staffing copy corrected |
| `AGENTS.md`, `README.md`, `docs/FAIRSHIFT_PRODUCT_UX_SPEC.md` | Authority order, reference company, rules, firewalls |
| Five earlier evidence and handoff documents, plus the workload evidence | One-line pointer only |
| Tests | New `tests/integration/hospitality-policy-freeze.test.ts`; reference fixtures moved to the frozen policy; the guard scan of `components/staffing.tsx` restored; the historical terms fixture corrected to daily £96 |

No schema or migration change. `REFERENCE` provenance already existed.

**Dataset version: `uk-hospitality-v1` is retained.** The version identifies generated commerce, and its value seeds the bills. The commerce didn't change, so renaming it would imply new history and make existing rows look foreign. A SHA-256 over all 316,844 bills is `4f1e665686ad982b…` both before and after this package. The rota correction is recorded here. Rerunning the loader corrects an already-loaded `REFERENCE` rota and leaves `CONFIGURED` rows alone.

**Public copy deliberately left:** sales targets and bonuses on public pages describe generic capability that exists and is what a worker sees today. The demo page's £200, £96, £25 and £121 are labelled as an earlier completed shift. Tips aren't built, so no page may say otherwise.

## 6. Natural Opportunity Demand

Calculated through the real loader, database and engine on a throwaway database, on the real clock, with data through 1 Nov 2026, for Tue 3 to Mon 9 Nov 2026. Nothing was changed after seeing these results.

| Measure | Result |
|---|---|
| Expected transactions | 4,986 |
| Required / regular staff-hours | 952.75 / 1,007 |
| Casual requirement | **64.25 h** |
| Location-days | 20 of 35 |
| Windows | 32: 2 of 3 h or more, 22 of 2 h, 8 of 1 h |
| Median / largest window | 2 h / 7 h |
| Most casual staff at once | 3 |

| Location | Casual h | Required h | Regular h |
|---|---|---|---|
| London Stratford | 33 | 263.75 | 261 |
| Leeds | 20.25 | 154.75 | 144 |
| Birmingham | 9.75 | 181 | 191 |
| Brighton | 1 | 180 | 195 |
| Manchester | 0.25 | 173.25 | 216 |

Discovered candidates, which influenced nothing:

| | Birmingham | London Stratford | London Stratford |
|---|---|---|---|
| Date and window | Sun 8 Nov, 11:00–16:00 | Wed 4 Nov, 07:00–09:00 | Tue 3 Nov, 17:00–19:00 |
| Forecast transactions | 151 | 84 | 65 |
| Range and support | 107–195, moderate | 58–110, moderate | 45–85, moderate |
| Required capacity | 22 h | 12.25 h | 9.5 h |
| Regular coverage | 15 h | 8 h | 6 h |
| Allocated casual | 0 h | 0 h | 0 h |
| Remaining | **7 h** | **4.25 h** | **3.5 h** |

The strongest window at the Manager fixture's location is Leeds, Wed 4 Nov, 12:00–14:00: 62 transactions, 9.25 h required, 6 h regular, 3.25 h remaining. Exact figures move as the 56-day lookback rolls forward.

**Consequences reported, not corrected:**
- Most windows are 2 hours, and FairShift has no minimum casual shift length.
- 8 windows need 30 minutes or less, and the "approx. 53 shifts" figure counts them, so it overstates what a Manager would create.
- Just over half the requirement is at Stratford, the lowest-bill venue, which is partly the proxy limitation in section 3.

## 7. UI evidence

Local production build from a copy of the source with no `.env` files, a throwaway PostgreSQL database, no provider keys, and the policy provisioned by the real loader. Headless Chrome.

29 steps across 1280, 1024, 768 and 390 px had no page overflow, no console errors and no broken navigation. One text check failed as a test artefact, because rota values sit inside form inputs that a page-text check can't read. `05-owner-policy-configuration.png` shows them correctly. On workload surfaces and public pages, checks found no "Configuration required", Zettle, retail, per-labour-hour, "AI forecast" or "Sales floor" wording.

Screenshots are in `docs/evidence/fs-hospitality-policy-freeze-001/`. `07` and `08` use a throwaway £96 daily work policy so a shift could be created. That isn't an earnings decision.

## 8. Quality gates

Run on one frozen tree: a checksum of `src`, `tests`, `scripts` and `drizzle` matched before and after. Only documentation changed afterwards.

| Check | Result |
|---|---|
| Full test suite, run 1 | 65 files, 721 tests passed, 576.8 s |
| Full test suite, run 2 | 65 files, 721 tests passed, 576.4 s |
| `pnpm typecheck` | Exit 0 |
| `pnpm lint` | Exit 0, no findings |
| `pnpm smoke:manager` | PASS |
| Production build | Exit 0, from the copy with no `.env` files, with `DATABASE_URL` at a dead local port and no provider keys |
| Browser walkthrough | 29 steps; the one flagged check is the artefact in section 7 |

Downstream suites for worker eligibility, Bryntum, Square attribution, incentive, approval and PayPal payout are part of those runs, and their source is untouched.

## 9. Limitations and open items

- **Hosted is unchanged.** It needs migration `0022` and a reference load. An outlet holding retail history refuses hospitality data by design, so it needs a fresh organisation.
- **Tips are not implemented.** Allocation method, terms, refund treatment and Sandbox `tip_money` behaviour are open. The legal position on tip allocation is **NOT VERIFIED**.
- **Contextual AI is not implemented.** No real AI explanation of this dataset is verified.
- **No genuine end-to-end run on the hospitality story.** Square and PayPal evidence stands from earlier runs and was not rerun.

## 10. Safety

Nothing was pushed or deployed, and hosted data wasn't touched. No OpenAI, Square, PayPal, Zettle or email provider was called. Worker, scheduling, Bryntum, Square, incentive, approval, PayPal and Zettle source is untouched.
