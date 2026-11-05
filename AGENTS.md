# FairShift — Repository Engineering Instructions

## 1. Purpose and authority

FairShift is an AI-assisted multi-outlet workforce planning and transparent worker-payment platform being developed for the PayPal AI Hackathon.

Use this authority order:

1. **Competition requirements:** current official PayPal AI Hackathon and Devpost sources. Repository copies of transient competition details may become stale.
2. **FS-HACK-MASTER-001:** the historical Phase 0 baseline, held at [`docs/FS-HACK-MASTER-001.md`](docs/FS-HACK-MASTER-001.md).
3. **Approved dated Owner amendments,** with the newest applicable amendment prevailing. These are recorded in [`docs/FAIRSHIFT_PRODUCT_UX_SPEC.md`](docs/FAIRSHIFT_PRODUCT_UX_SPEC.md), incorporating [`docs/FS-HACK-SA-AMENDMENT-001.md`](docs/FS-HACK-SA-AMENDMENT-001.md): Owner-approved **DEC-SA-001–010** from **FS-HACK-SA-ROADMAP-LOCK-001**, as amended by **DEC-SA-011** from **FS-HACK-SA-ROADMAP-CORRECTION-001**, both dated 5 November 2026.
4. **FS-HACK-SA-ROADMAP-001,** at [`docs/FS-HACK-SA-ROADMAP-001.md`](docs/FS-HACK-SA-ROADMAP-001.md): the LOCKED current delivery reference, fourteen-step Golden Demo Path and SA-R/SA-G dependencies. The Pay Agent is REQUIRED. FS-HACK-ROADMAP-002 delivery sequence and step numbers are historical. The SA roadmap cannot independently invent product policy or establish implementation. Unaffected older controls and unresolved authority conflicts remain binding/gated as recorded in the register.
5. **Repository reality** for implementation state: the current repository and reproducible runtime evidence.
6. **The current authorised work package.**
7. **Implementation preference.**

**One active roadmap (Owner decision, 5 November 2026):** FS-HACK-SA-ROADMAP-001, governed by DEC-SA-011, is the only active product roadmap. The UK Heads-up Rewards proposal is superseded. Do not merge the UK and SA product models, and do not create a parallel roadmap. FS-HACK-ROADMAP-002 and all UK/GBP plans are history.

[`docs/FS-DOCUMENT-AUTHORITY-REGISTER.md`](docs/FS-DOCUMENT-AUTHORITY-REGISTER.md) classifies every document, says whether it may direct new work, lists the open roadmap conflicts (section 5), traces the provenance of each Owner decision (section 6), and holds the current work-package pointer (section 2). Read its sections 1 and 2, the SA amendment and the SA roadmap before substantive work. These requirements apply to every subsequent coding session in a checkout containing this governance change; other worktrees are not updated by this package.

Historical evidence, reports and handoffs never direct new work. Their "next step", "recommended package" or "tomorrow" text is history, not a current task. Neither is a roadmap "next action", an earlier conversation, or an agent's own recommendation.

APPROVED ≠ IMPLEMENTED ≠ TESTED ≠ VERIFIED LOCALLY ≠ DEPLOYED ≠ VERIFIED ON HOSTED ≠ DEMO-READY. Each is a separate claim that needs its own evidence. An Owner decision is not a claim that functionality exists, and deployed code is not a completed hosted Golden Path.

Do not infer implementation status from product copy, prototypes, plans, or prior conversation. Do not treat planned behavior as implemented.

When a material implementation or submission decision depends on a deadline, eligibility condition, judging criterion or weight, sponsor-prize requirement, or Devpost wording, verify the current official source. Never encode those competition details in application business logic.

## 2. Product north star

Protect this operational loop:

sales intelligence → AI forecast → staffing → preauthorised casual shift offer → acceptance → allocation → manager-confirmed completion → verified performance and deterministic earnings → automatic FairShift Pay Agent orchestration → server financial checks → eligible PayPal Sandbox payment → reconciliation and worker history.

The canonical fourteen-step path is FS-HACK-SA-ROADMAP-001 section 2, corrected by DEC-SA-011. Casual compensation is preauthorised before offer and accepted by the worker; manager-confirmed completion triggers REQUIRED genuine model-backed orchestration through bounded, allowlisted server actions. No casual-worker payout request or second discretionary Owner payment approval applies. Performance evidence and financial eligibility stay deterministic; the server resolves entitlement, sender/merchant, recipient, amount, currency and existing payment authority. AI cannot invent or override those facts. Permanent staff follow POS evidence → approved tip allocation → permitted employee early-release request → Pay Agent → the same settlement engine → provider status/history; limited access and tip ceilings need explicit policy design, with no fourth application role.

The detailed roles, information architecture, navigation, golden-path UX, visibility rules, screen behavior, responsive expectations, terminology, and implementation sequence live in the authoritative product specification. Reference it rather than duplicating it here.

Do not silently expand FairShift into a general HRIS, payroll suite, recruitment platform, CRM, accounting system, or enterprise workforce-management suite.

## 3. Product decision control

Implementation must not silently invent or materially change the product roles, navigation architecture, golden-path UX, owner/admin experience, manager experience, worker experience, data visibility, or unresolved product rules defined in the product specification.

If implementation requires a material product decision not resolved there, stop affected work and surface the decision rather than inventing it.

Do not resolve OPEN, NEEDS VERIFICATION, or DEFERRED decisions inside this file. These include, among others:

- permanent incentive formula;
- hospitality tip allocation method;
- fairness or matching weighting;
- over-invitation and capacity behavior;
- invitation transport;
- Shift Sheet distribution;
- detailed payment-dispute workflow;
- verified Zettle worker attribution;
- SaaS subscription model;
- cross-location casual-worker scheduling;
- full-time employee accounts;
- every conflict listed in the authority register, section 5, including holiday pay in the payable, cancellation pay, the guaranteed-hours pathway, fair offer order and "advance of earned pay" wording.

Use the product specification for their current authoritative status.

Only the Owner makes product decisions. Agents propose; they never create, infer, complete or record an Owner decision on their own account. Record a decision only when the authorising work package supplies the Owner's decision, and cite its source. Only an approved Owner decision traceable to a dated record may amend a locked requirement of FS-HACK-MASTER-001. A label such as "Owner approved" is not provenance: use the register, section 6. OWNER CONFIRMATION REQUIRED is a verification flag, not a revocation: a decision so marked stays in force as recorded, and new implementation that depends on it needs the authorising work package to name it.

If an unresolved product-authority conflict affects the work, stop that work and report it in the section 9 format.

## 4. Current reference company and integration strategy

### Active reference company

The reference company is one fictional five-location **South African** fast-casual cafe and dining group with **ZAR operating currency** (DEC-SA-001–003). It is isolated demonstration data, never a runtime prerequisite for the independently usable multi-tenant SaaS product. England/GBP and retail reference requirements remain history. Hospitality is the demo vertical, not an architectural restriction. SA venue names, reference data and rates are not yet selected. **Implemented and tested locally, uncommitted:** a South African location's new work policies, shifts, accepted terms and payables are in ZAR, and the payout path refuses any currency without recorded genuine PayPal Sandbox payout evidence (currently GBP and USD only), so ZAR earnings stay recorded and unpaid until a provider route is verified (DEC-SA-010). The SA route gate also refuses legacy GBP/USD obligations for an SA business or location before reservation or provider-client creation; historical currency evidence grants no SA merchant permission. Known-batch status reconciliation remains available, while no-batch resends pass the route gate.

- Staffing comes from expected **transactions by time of day**, the business's capacity and minimum cover, and coverage. **Sales value does not set staffing.** The £100-per-labour-hour method is retired.
- Reference policy: **7 transactions per operational staff-hour, minimum 2 operational staff while open**, organisation level. This is a fictional-company assumption, never a benchmark or legal requirement, and never learned from data.
- Transactions are an MVP workload proxy. Do not claim they capture covers, item complexity, kitchen bottlenecks or queue length. Do not add those variables, or role-specific forecasting, before submission.
- **Golden Path anti-tuning:** discover the example from accepted rules. Never select or alter rules, reference demand, capacity, regular cover or forecast parameters to manufacture a preferred example. The historical 14:00–20:00, £96, £200, £25, £121 example is not a hospitality target.
- **Earnings (FS-TIP-DEC-001):** the authorised formula is guaranteed base earnings + performance incentive + allocated tips = total approved earnings. This is **not implemented**, and the exact written tip-allocation rule remains open for FS-HOSPITALITY-EARNINGS-001. Square tip-evidence capture is already implemented (`commerce_payment_evidence.tip_amount_minor`, migration `0025_square_tip_evidence.sql`); allocation and settlement remain incomplete. Do not claim that evidence capture is tip entitlement, SA provider verification or completed settlement, and do not implement the missing parts without a work package. FS-PAY-TERMS-DEC-001 adds a holiday-pay line that FS-HACK-ROADMAP-002 does not include; that conflict is unresolved (register, section 5), so implement neither form of the holiday-pay line without an Owner decision.
- **Contextual AI (FS-DEMAND-CONTEXT-001, FS-DEMAND-CONTEXT-DEC-001) is implemented and verified locally with a genuine model call.** Its code is deployed on hosted at `77ae36d` ([`docs/HOSTED_RELEASE_002_EVIDENCE.md`](docs/HOSTED_RELEASE_002_EVIDENCE.md)), where no AI proposal has been made. The baseline stays deterministic and canonical. AI chooses a named scenario from a closed set and cites supplied signals, code owns the fixed percentages, and only a Manager's acceptance changes staffing. Evidence: [`docs/DEMAND_CONTEXT_EVIDENCE.md`](docs/DEMAND_CONTEXT_EVIDENCE.md).
- **Context signals (FS-CONTEXT-SIGNALS-DEC-001) are implemented and verified locally.** Their code is deployed on hosted at `77ae36d`, where one signal refresh per venue has run and no AI proposal has been made. Open-Meteo weather, Ticketmaster listings (key-gated) and structured Manager signals inform time-targeted scenarios. No code applies an effect by venue, weather or event. Open-Meteo's free tier is non-commercial, and Ticketmaster's terms are **NOT VERIFIED** for this use, and real listing data stays out of the repository. Published history was rewritten before any push (`58eaf48`), so `c567f2e`, which holds real listing data, is on no remote. It survives only on the local branch `backup/pre-squash-db2dfde`, which must never be pushed. Making the repository public is a separate Owner decision. FS-CONTEXT-SIGNALS-DEC-002 sets the event influence window and listing filter. Evidence: [`docs/CONTEXT_SIGNALS_EVIDENCE.md`](docs/CONTEXT_SIGNALS_EVIDENCE.md).

### Current SA payment gates — NEEDS VERIFICATION

DEC-SA-005 as amended by DEC-SA-011 makes genuine model-backed FairShift Pay Agent orchestration REQUIRED; DEC-SA-006 limits official Toolkit/MCP use to verified supported capabilities. Native Payouts creation is not established by its reviewed documented tool inventory; a policy-bound custom Payouts API tool is permitted only after eligibility verification. The server authorises and executes through one shared settlement architecture for casual earnings and permanent-staff tips. Permanent staff remain lightweight records, never a fourth role; their request-access mechanism is unresolved.

Each genuine employer needs its own authorised funding/payment arrangement. A dedicated isolated demo merchant is permitted for the demo only; shared demo sender credentials must never become customer merchant credentials. ZAR earnings and provider payout currency are distinct. SA payout category, currency, merchant and recipient permission remain NEEDS VERIFICATION. Do not relabel GBP as ZAR, invent FX/fees, assume SA POS availability or infer authorisation from historical UK evidence. Production payroll, tax and regulatory integrations are DEFERRED.

### PayPal — historical UK/GBP Sandbox evidence, SANDBOX-CONNECTED

PayPal is the central worker-payment integration. Current evidence establishes:

- Sandbox OAuth authentication;
- one controlled $25 Sandbox payout;
- persisted provider identifiers and payout state;
- provider status refresh and reconciliation to `PAID` after PayPal item `SUCCESS`;
- duplicate payout protection;
- one genuine GBP 121.00 Sandbox payout on Square-attributed work, reaching item `SUCCESS` and `PAID`.

This evidence does not imply production capability or verification of every PayPal feature. Never represent an unverified, pending, failed, or unknown operation as successful.

### Historical exercised architecture and retained provider boundaries

Reference historical commerce
→ deterministic demand model
→ OpenAI bounded interpretation
→ staffing requirement
→ worker opportunity
→ Bryntum allocation
→ genuine Square Sandbox team-member-attributed commerce
→ FairShift performance/incentive
→ manager approval
→ genuine PayPal Sandbox payout
→ worker confirmation

Provider responsibilities:

- **Square:** commerce evidence.
- **OpenAI:** bounded interpretation and explanation.
- **Bryntum:** manager allocation surface.
- **FairShift:** business logic, worker and shift identity, compensation, incentive, attribution eligibility, and approval.
- **PayPal:** FairShift subscription infrastructure and worker payout.

This chain records the earlier UK/GBP path; the current required path is FS-HACK-SA-ROADMAP-001 section 2. It does not establish SA readiness. The stages from allocation to worker confirmation have been exercised locally on Square Sandbox evidence and a genuine PayPal Sandbox payout ([`docs/PAYPAL_FINAL_EVIDENCE.md`](docs/PAYPAL_FINAL_EVIDENCE.md)), on a short real shift rather than the 14:00–20:00 window. The reference-history forecast to allocation stages were not part of that one run. The hospitality engine's code is deployed on hosted ([`docs/HOSTED_RELEASE_002_EVIDENCE.md`](docs/HOSTED_RELEASE_002_EVIDENCE.md)), but no Golden Path has been run there, and the revision live after later pushes is NOT VERIFIED. See the product specification, section 10, for current status, the Golden Path economics, and the MVP refund decision.

### Square Sandbox — SANDBOX-CONNECTED UK evidence; SA applicability NEEDS VERIFICATION

Evidence: [`docs/SQUARE_LIVE_EVIDENCE.md`](docs/SQUARE_LIVE_EVIDENCE.md). **VERIFIED** on Square Sandbox:

- authenticated genuine UK/GBP Square Sandbox seller;
- genuine Square Sandbox payments ingested;
- Square `Payment.team_member_id` persisted and read back;
- FairShift maps a Square team-member identity to a worker;
- genuine Square Sandbox commerce can drive FairShift worker performance;
- the existing FairShift incentive calculation operates on that attributed evidence.

**Claims limit:** the demonstrated Sandbox payments explicitly supplied `team_member_id`. Do not state that a physical Square till or POS automatically identified the logged-in worker in this implementation. That, production Square, and shared logins are **NOT VERIFIED**.

**Forecast:** genuine Square history is currently insufficient for the 28-day threshold, so clearly labelled reference historical commerce remains the current forecast source. Do not manufacture Square history.

Keep provider payloads behind a provider ingestion/normalisation boundary:

POS provider
→ provider adapter / ingestion
→ canonical FairShift sales records
→ forecasting and staffing

Do not make forecasting depend on provider-specific structures.

### Zettle — INACTIVE for the hackathon Golden Path

Connector work is retained in the repository, built against documented API and mocked provider behaviour. A genuine merchant connection is not verified. Do not delete it, extend it, or represent it as the active provider or as integrated. No new Zettle implementation is authorised before submission. Evidence: [`docs/ZETTLE_LIVE_EVIDENCE.md`](docs/ZETTLE_LIVE_EVIDENCE.md).

### Sponsor integrations

- **AG Grid / AG Studio — PLANNED:** owner/manager operational analytics where dense data presentation materially improves comprehension.
- **Bryntum — integrated, verified locally:** the manager allocation surface over authoritative FairShift state. Evidence: [`docs/BRYNTUM_UI_EVIDENCE.md`](docs/BRYNTUM_UI_EVIDENCE.md). It uses the trial package, and its licence terms are **NOT VERIFIED**.
- **APIMatic — PLANNED / evidence required:** PayPal API development and integration support where it materially improves quality, documentation, workflow reliability, or credible sponsor evidence. It is not a user-facing module.

Do not add technology merely to increase sponsor count. Overall submission quality and a working golden path outrank sponsor accumulation. Verify capability, licensing, supported environments, and fit before implementation or claims.

## 5. AI and deterministic control

Meaningful AI follows this chain:

historical sales and demand
→ forecast
→ staffing recommendation
→ manager operational decision

AI must have understandable inputs, validated structured output, observable product consequences, and clear separation from factual historical data. Managers retain operational control. Do not treat an LLM explanation as evidence that a forecast occurred.

Use deterministic application logic for:

- permissions and scoping;
- scheduling conflicts;
- wage and incentive calculations;
- payout amounts and eligibility;
- financial reconciliation;
- other exact business rules.

AI must not independently determine payment entitlement or authority, approve payouts, fabricate financial results, or make consequential employment decisions. DEC-SA-011 requires genuine model-backed Pay Agent orchestration automatically after manager-confirmed completed casual work, and on a permitted permanent-staff early-tip request. Only bounded, allowlisted server actions may be invoked; financial authorisation and execution remain server-side. Duplicate triggers, repeated tool calls and uncertain outcomes require idempotency and safe recovery. A failed model call is not a payment, must preserve valid financial state and must not permit an unsafe resend.

## 6. Core domain and data boundaries

Keep these concepts distinct: factual sales, forecast, staffing requirement, staffing decision, shift, shift offer, worker response, shift allocation, performance result, incentive result, approved payable amount, payout, and payment status.

Preserve provenance between provider-derived records, seeded/demo data, simulated or mocked data, forecasts, recommendations, manager decisions, and verified outcomes. Never present seeded or simulated sales as provider-verified facts.

Casual workers are location-bound in the current product scope. Worker-facing performance is limited to the worker's own permitted aggregates. Do not expose customer/transaction detail, store-wide revenue, another worker's performance or earnings, or worker leaderboards.

Worker-level commerce attribution requires a verified provider mechanism. Do not fabricate attribution identifiers or infer capability from generic metadata.

Server-side authorisation must enforce organisation, location, worker, and financial-operation scope. Hidden UI is not authorisation.

## 7. Failure-safe development

Submission-critical functionality must fail safely and truthfully:

- POS failure is not zero sales.
- AI or forecast failure is not an invented forecast.
- A scheduling conflict is not a valid allocation.
- An unapproved incentive is not payable.
- PayPal failure is not `PAID`.
- An unknown payout state is not `SUCCESS`.

On critical failure, preserve valid prior state where appropriate, block unsafe downstream action, provide understandable user-facing feedback, support a safe recovery or retry path where appropriate, and retain enough evidence for diagnosis.

Golden-path work should include positive verification and relevant negative-path verification. Priority judge-visible controls are scheduling conflict prevention, preauthorised accepted compensation plus manager-confirmed casual completion (and approved permanent-tip allocation), deterministic server payment eligibility, and duplicate PayPal payout protection. No second discretionary Owner approval is added to the casual path. Keep demonstrations focused; do not build exhaustive enterprise-grade fault infrastructure for the hackathon.

## 8. Evidence and status discipline

Describe evidence using:

- **VERIFIED**
- **REPOSITORY EVIDENCE**
- **AGENT-REPORTED**
- **INFERENCE**
- **RECOMMENDATION**
- **NOT VERIFIED**

Describe integrations using:

- **MOCKED**
- **SIMULATED**
- **SANDBOX-CONNECTED**
- **API-BACKED**
- **VERIFIED**
- **DEMO-READY**

Never promote a status without evidence. Do not confuse implemented with tested, tested with externally verified, or externally verified with demo-ready. Never claim a test passed unless it was executed successfully. State why when a required check could not run.

Product-facing copy should use natural language while remaining truthful about data and provider state.

## 9. Repository verification and engineering discipline

Before substantive implementation, debugging, architecture, integration, repository review, or coding-agent handoff:

1. read this `AGENTS.md`, sections 1 and 2 of the authority register, FS-HACK-SA-AMENDMENT-001 and FS-HACK-SA-ROADMAP-001;
2. verify the current working directory;
3. verify the current branch;
4. verify HEAD;
5. inspect Git status;
6. inspect the relevant implementation, dependencies and, where applicable, test state;
7. identify material assumptions and existing uncommitted work;
8. confirm that a specific authorised work package covers the work (section 16).

The repository is authoritative for implementation state. If repository reality differs materially from the work package expectation, stop affected work and report:

Expected →
Found →
Impact →
Recommended action →

Preserve existing work and working behavior unless the authorised task requires change. Do not silently restructure established architecture or overwrite unrelated changes.

## 10. Architecture and implementation approach

Use the simplest architecture capable of producing a reliable, understandable hackathon demonstration.

Prefer:

- implementation speed;
- reliability;
- comprehensibility;
- integration quality;
- demo resilience;
- the smallest coherent change.

Avoid:

- unnecessary microservices;
- speculative scalability;
- duplicate data layers;
- speculative or unnecessary abstractions;
- unrelated refactors;
- architecture rewrites without demonstrated need;
- technology added solely for novelty.

Do not change the selected stack merely because another stack is preferred. Report a major architectural conflict before replacement work.

Make no architectural, schema, provider-boundary or dependency change outside the authorised package's scope, even when it looks like an improvement.

## 11. Security and secret handling

Financial and workforce functionality must account for server-side authorisation, organisation/location scope, worker isolation, role permissions, secret management, input/webhook verification, idempotency, auditability, and data minimisation.

Never expose, print, stage, or commit credentials, access tokens, private keys, sandbox passwords, database credentials, `.env` contents, or unnecessary payer/recipient information. Keep provider secrets server-side. Do not log raw sensitive provider responses.

Before a commit, review tracked, untracked, and staged files. Exclude local databases, dependency directories, build/cache output, editor/OS files, temporary reproductions, screenshots containing sensitive data, and other generated or unrelated files.

## 12. Git and repository safety

Do not:

- force-push;
- rewrite or squash development history;
- rebase without explicit authorisation;
- delete branches or evidence;
- destructively reset existing work;
- overwrite unrelated uncommitted work;
- stage or commit secrets or `.env` files;
- commit generated dependency or build directories.

Do not create a commit, push, merge or deployment unless the current work package explicitly authorises that action. Nothing is automatic. A push to `fs-square-live-001` auto-deploys on Render ([`docs/HOSTED_RELEASE_EVIDENCE.md`](docs/HOSTED_RELEASE_EVIDENCE.md), section 5), so a push is a deployment. Review the staged file list and staged diff before every authorised commit. After work, report changed files and final Git state.

## 13. Testing priorities

A feature is not complete because code was written. Use targeted tests first, then the repository's normal verification when justified by the change.

Prioritise:

1. golden-path behavior;
2. POS ingestion and normalisation when implemented;
3. AI input/output contracts and degraded states;
4. scheduling, availability, and overlap conflicts;
5. worker offer response and acceptance;
6. deterministic performance and incentive calculation;
7. casual preauthorisation/acceptance/completion and deterministic payment gate; permanent-tip allocation approval;
8. PayPal API behavior;
9. payout persistence and status reconciliation;
10. duplicate/idempotency protection;
11. other submission-critical negative paths;
12. organisation/location/worker access boundaries when implemented.

Use build, typecheck, lint, unit, integration, end-to-end, API, Sandbox, persisted-state, and UI evidence as applicable. Do not chase coverage percentages or broad repetitive checks at the expense of submission readiness.

## 14. Demo and submission evidence

For material integrations and golden-path stages, preserve evidence of what was implemented, where it lives, how it was tested, the expected behavior, the actual result, integration status, and visible application consequence.

Before submission, maintain the Demo Evidence Matrix required by the product specification:

feature or stage
→ positive behavior
→ negative or control behavior
→ automated verification
→ integration status
→ user-visible evidence
→ intended demo step

Do not create unsupported Devpost or presentation claims. Do not place private strategy or unrelated working notes in public technical documentation.

## 15. Scope and priority control

Use this decision order:

1. Competition compliance and eligibility
2. Submission deadline
3. Working end-to-end demo
4. PayPal plus meaningful AI
5. Judging criteria
6. Demo reliability
7. Valuable sponsor integrations
8. Design and presentation
9. Extra features
10. Post-hackathon work

Classify work as:

- **SUBMISSION-CRITICAL**
- **JUDGING-VALUE**
- **SPONSOR-VALUE**
- **POLISH**
- **POST-HACKATHON**

Protect the working golden path from lower-value scope. A functioning, defensible core outranks feature count.

## 16. Coding-agent work packages

Substantive work requires a specific authorised work package with its own ID. A handoff, report, evidence "next step", roadmap "next action", earlier conversation or agent recommendation is not a work package, and a package's authority ends with its own scope. Authorisation comes from the Owner: no work package authorises itself, widens its own scope or authorises a successor.

Substantive coding tasks should begin with one of:

- `CONTINUE CURRENT SESSION`
- `START NEW SESSION — EMPTY CONTEXT`

The work package should state:

- recommended agent/model;
- reasoning/effort;
- objective and definition of done;
- the golden-path step or steps it advances, by **FS-HACK-SA-ROADMAP-001 section 2** number, plus applicable SA-R stages and SA-G dependency/exit gates. If none, it is deferred unless competition compliance or a blocker repair requires it, and the package says which;
- any Owner decision it relies on that the register marks OWNER CONFIRMATION REQUIRED;
- authorised scope;
- prohibited actions;
- repository baseline and verification;
- material risks, positive and relevant negative-path tests, and verification;
- stopping condition;
- commit policy.

Prefer one coherent package per session. Related implementation and necessary tests may be combined. Continue useful session context when available and avoid broad rediscovery when repository and product authority already answer the question.

## 17. Hackathon and token efficiency

Keep work proportional to submission value:

- use narrow implementation packages;
- inspect only relevant repository areas;
- run targeted tests first;
- run the full suite/build when change risk or work-package requirements justify it;
- keep progress and final reports concise;
- preserve useful session context;
- avoid repeated rediscovery of settled product decisions.

Do not sacrifice correctness, security, or necessary verification merely to save time or tokens.

## 18. Public repository hygiene

Keep public files focused on FairShift product and engineering evidence. Comments should explain genuine domain or technical reasons rather than private evaluation strategy or prompt history.

Only include programme, event, or submission-specific material when required for a public deliverable. Competition governance belongs in planning and evidence, not product behavior.

## 19. Stop conditions

Stop affected work and report rather than guessing when:

- repository state differs materially from task assumptions;
- existing uncommitted work could be overwritten;
- a material product rule is missing or conflicts with the product specification;
- an unresolved product-authority conflict (register, section 5) affects the work;
- no specific authorised work package covers the work;
- a required provider operation or capability cannot be verified;
- required credentials/configuration are unavailable for an operation that cannot proceed without them;
- implementation would expose secrets;
- an unexpected destructive migration is required;
- a major architecture replacement becomes necessary;
- a task would present planned, mocked, seeded, or simulated behavior as real;
- current official competition requirements are ambiguous or conflict with the package.

Use the discrepancy report format in section 9. Safe independent work may continue when it does not depend on the blocked decision.
