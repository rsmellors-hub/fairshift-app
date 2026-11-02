# FS-UI-PRODUCT-001 Handoff

> **Superseded for the reference company and demo path.** See `docs/HOSPITALITY_POLICY_FREEZE_EVIDENCE.md`. This handoff is otherwise unchanged.

For a new session with no history. Read `AGENTS.md` first.

## Project

**Thesis:** FairShift uses sales intelligence and AI to help businesses predict casual labour demand, offer the right shifts, measure performance against transparent incentives, and turn approved work into PayPal-powered payments.

**Golden Path:** five-location sales → next-week daily forecast and staffing gap → Manager creates a shift inside Owner policy → offers → Worker sees terms and accepts → Manager finalises on Bryntum → Square Sandbox attributed sales → target progress → base + incentive → Manager approves → PayPal Sandbox payout → Worker confirmation.

**Demo economics:** 14:00–20:00, £96 daily/fixed base, £200 target, £25 bonus, £121 payable. Never describe £96 as £12 × 8.

**Authority order:** official PayPal AI Hackathon requirements; FS-HACK-MASTER-001 (not found locally); repository reality; `docs/FAIRSHIFT_PRODUCT_UX_SPEC.md`; the current package; the demo-screen PDF (`~/Downloads/FairShift demo screens.pdf`, visual reference only, with stale Zettle, till-login and refund claims).

## Repository

- Branch `fs-square-live-001`. Starting HEAD `8121179f49ed4c0824f3f2c3494e2848ab23d206`.
- The UI and demo work is commit `e7fcdf9`, pushed and deployed. Later evidence commits may be local only: a push redeploys. `main` is not merged.
- Final gates: 663 of 663 tests, typecheck, lint, production build, `git diff --check` and secret scan all pass on the final tree. Migrations: 22.
- Don't commit `.claude/` or the generated `next-env.d.ts` change that `next dev` makes.
- `.claude/launch.json` is untracked and has a local `ui-scratch` entry pointing at a scratchpad path. Don't commit it.
- Render auto-deploys this branch. **A push deploys.** Don't push without authorisation.

## Hosted

**Hosted runs `e7fcdf9d4dad5afd9bff750c73952d9699c488ad`** on `fs-square-live-001`, with 22 migrations and Demo Access off. Hosted has no demo business yet. `getafairshift.com` is on registry `clientHold` and doesn't resolve; the service is reachable at `https://fairshift-n84v.onrender.com`. See `docs/HOSTED_REHEARSAL_EVIDENCE.md`. `.env.local` holds `HOSTED_DATABASE_URL` and `RENDER_API_KEY`: don't use them without explicit authorisation.

## Implementation

- **Styles:** `src/app/styles.css` is the one design system; `src/app/owner/owner.css` is deleted; `src/app/manager/allocations.css` themes Bryntum.
- **New public routes:** `product`, `pricing`, `faq`, `demo` (Explore FairShift and Demo Access).
- **New onboarding:** `check-email`, `components/auth-shell.tsx`, `components/plan-cards.tsx`.
- **New Owner:** `owner/setup-checklist.tsx`, `server/product/owner-setup.ts`.
- **New Manager:** `manager/today.tsx`.
- **Rebuilt:** `owner/{overview,sales,weekly-forecast,workspace}.tsx`, `owner/locations/[locationId]/page.tsx`, `manager/{workspace,plan-week,allocation-scheduler}.tsx`, `worker/{workspace,shift-cards}.tsx`, `account/page.tsx`, `subscribe/page.tsx`.
- **Redirects changed:** register and unverified sign-in go to `/check-email`; verify goes to `/subscribe?verified=1`; setup goes to `/owner?welcome=1`.
- **Tests:** copy assertions updated in `tests/integration/*`. Safety wording was kept in the product wherever a test locked it.
- **Backend:** forecast, ingestion, attribution, incentive, payable and payout logic were not changed. Demo Access changed session handling, added migration 0021 and added action gates; see below.

## Integrations

| Provider | Status |
|---|---|
| Square | SANDBOX-CONNECTED, active commerce provider. Physical till attribution and production NOT VERIFIED |
| OpenAI | Bounded interpretation. Not called in this package |
| Bryntum | Integrated and verified locally on the trial package. Licence NOT VERIFIED |
| PayPal | SANDBOX-CONNECTED. The genuine GBP 121.00 Sandbox payout is earlier local evidence, not hosted. The Paid screens in this package's screenshots are SIMULATED by a local stand-in |
| Zettle | Inactive, merchant connection NOT VERIFIED. No product UI |

## Claims firewall

**Allowed:** "AI-assisted demand intelligence", "Square Sandbox attributed sales", "Reference historical sales", "Reference data", "Manager-approved earnings", "PayPal Sandbox", "Daily forecast".

**Prohibited:** physical till login attribution proven; production Square or PayPal; genuine Square history driving the forecast; hourly AI forecasting; autonomous AI scheduling; AI choosing workers, setting compensation, approving pay or sending payouts; refunds identifying worker responsibility or reducing earnings; payroll or tax; cross-location casual scheduling; Zettle as the active provider.

## Founder walkthrough

1. **Owner:** Overview → Sales → Forecast → Leeds Briggate.
2. **Manager:** Forecast & staffing → `Fill Saturday gap` → set 14:00–20:00 and workers needed (the form defaults to 09:00–17:00) → create → Send offer.
3. **Worker, phone width:** Shifts → read the terms → tick → Accept shift.
4. **Manager:** Allocations (Bryntum) → select the shift → Finalise allocation.
5. **Worker:** Home → live target. In a genuine run, sales arrive as Square Sandbox attributed sales.
6. **Manager:** Review & pay → Confirm work → Confirm sales results → `Approve £121.00` → send with PayPal → Check payment status.
7. **Worker:** Earnings → £96 + £25 = £121, Paid.

Show about three controls: unavailable worker can't be offered, approval doesn't send money, duplicate payout refused. A genuine 14:00–20:00 run finishes after 20:00.

## Local verification setup

The scratch environment is in the original session's scratchpad and may not survive: a Postgres on port 55433 (`LC_ALL` must be set), a source mirror with no `.env` files, a production build on port 3100, and fixture and check scripts. To rebuild, copy the source without `.env*`, migrate a throwaway database, seed through server functions, and export every provider credential blank. Results are in `docs/evidence/fs-ui-product-001/screens/_checks.txt`.

**Dev server:** the Claude desktop `dev` preview (port 3000) reads `.env.local`, which holds real Sandbox keys. Never use it for validation. It stopped during this work: a careless `pkill` of mine ended it, and it wasn't restarted.

## Open items

- Reference data freshness: dataset ends 2025-12-28. Decide before loading hosted.
- Hosted onboarding retest, including email and PayPal subscription approval.
- Continuous hosted Golden Path on genuine Square and PayPal Sandbox, 14:00–20:00.
- Earnings statement: backend feature not built.
- Fill suggested window and shift-length assumption: need a product rule.
- `main` reconciliation (not merged).
- Public repository, README, licence, Bryntum licence terms.
- Final video and Devpost submission (deadline to verify from the official source).

## Public Demo Access

Authorised by the owner in a parallel workstream. Decision record: `docs/evidence/fs-ui-product-001/DEMO_ACCESS_DECISION.md`. Usability sources: `docs/evidence/fs-ui-product-001/JOURNEY_USABILITY_REVIEW.md`. Requirement-by-requirement reconciliation: report section 18.

**Status: LOCAL ONLY, NOT DEPLOYED. Concurrency: SHARED-BUT-RESETTABLE, not isolated.** Visitors share one business and can see each other's offers. One visitor's reset closes another's in-progress shifts. Earlier prepared evidence isn't affected.

**How it works:** `/demo` offers Owner, Manager or Worker entry. Sessions are marked DEMO server-side (`auth_sessions.demo_persona` and `demo_group`, additive migration 0021) and last two hours. Switching persona updates the session row. Identities come only from `FAIRSHIFT_PUBLIC_DEMO=enabled`, `FAIRSHIFT_DEMO_ORGANISATION_ID` and `FAIRSHIFT_DEMO_OWNER_MEMBERSHIP_ID`, `_MANAGER_` and `_WORKER_`. Incomplete configuration closes the demo. `src/proxy.ts` overwrites the request-method header. On any non-GET request `requireScope` refuses a demo session unless the action opts in with `demoWrite`: create shift, send offer, respond to offer, finalise allocation, change or move a shift, choose a location. Writes are rate-limited and open shifts capped at 12. Shifts with a payable, performance result, incentive, confirmed allocation or COMPLETED status can't be changed. `requireIdentity` refuses demo sessions.

**Reset** closes live shifts without finished-work evidence through the normal cancel path, and keeps acceptance evidence because acceptance records are immutable by trigger. It is transactional, audited and repeatable. Demo views leave closed shifts out.

**Before hosting:**
1. A genuine Paid record must come from a controlled, non-public rehearsal in the demo organisation with the flag **OFF**. Reset closes in-progress shifts and the demo organisation sends no email while it's on.
2. Prepare the business with only that Paid shift. An awaiting-approval shift shows a Today action the demo then refuses.
3. Hosted needs migration 0021 and the new env vars. Pushing `fs-square-live-001` auto-deploys, so it needs explicit authorisation.
4. Worker wording on the earlier shift depends on how the record was made. Never describe imported sales as Square.

**Not verified:** Bryntum drag and Change shift under a demo session in a browser (tests only), Send payout replay in a browser (tests only), demo email suppression with a real provider, a keyboard pass, hosted anything, a real judge using it.

## Next recommended package

**FS-HOSTED-REHEARSAL-001.** The owner reviews this build and authorises commit and deploy. Then, with `FAIRSHIFT_PUBLIC_DEMO` off: apply migration 0021, create the demo business through the hosted product, decide on reference data, and run the genuine 14:00–20:00 path on Square and PayPal Sandbox. Turn the demo on only after that. It is the first end-to-end proof on the release build, and Act 3 and Act 4 need genuine evidence before the video.
