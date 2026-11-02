# FairShift — Repository Engineering Instructions

## 1. Purpose and authority

FairShift is an AI-assisted multi-outlet workforce planning and transparent worker-payment platform being developed for the PayPal AI Hackathon.

Use this authority order:

1. **Competition requirements:** current official PayPal AI Hackathon and Devpost sources. Repository copies of transient competition details may become stale.
2. **FS-HACK-MASTER-001:** the historical Phase 0 baseline, held at [`docs/FS-HACK-MASTER-001.md`](docs/FS-HACK-MASTER-001.md).
3. **Approved dated Owner amendments,** with the newest applicable amendment prevailing. These are recorded in [`docs/FAIRSHIFT_PRODUCT_UX_SPEC.md`](docs/FAIRSHIFT_PRODUCT_UX_SPEC.md), the current authoritative product/UX specification.
4. **Repository reality** for implementation state: the current repository and reproducible runtime evidence.
5. **The current authorised work package.**
6. **Implementation preference.**

AUTHORISED ≠ IMPLEMENTED ≠ VERIFIED ≠ DEMO-READY. An Owner decision is not a claim that functionality exists.

Do not infer implementation status from product copy, prototypes, plans, or prior conversation. Do not treat planned behavior as implemented.

When a material implementation or submission decision depends on a deadline, eligibility condition, judging criterion or weight, sponsor-prize requirement, or Devpost wording, verify the current official source. Never encode those competition details in application business logic.

## 2. Product north star

Protect this operational loop:

POS sales
→ FairShift ingestion and normalisation
→ canonical historical sales
→ deterministic commercial and operational forecast
→ staffing requirement and Opportunity Demand
→ manager scheduling
→ worker shift acceptance
→ performance evidence
→ deterministic earnings calculation
→ manager approval
→ PayPal payout
→ confirmation

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
- full-time employee accounts.

Use the product specification for their current authoritative status.

## 4. Current reference company and integration strategy

### Active reference company

The reference company is one fictional five-location UK fast-casual cafe and dining group, defined in the product specification, section 1. Hospitality is the demo vertical, not an architectural restriction. Retail reference work is historical evidence.

- Staffing comes from expected **transactions by time of day**, the business's capacity and minimum cover, and coverage. **Sales value does not set staffing.** The £100-per-labour-hour method is retired.
- Reference policy: **7 transactions per operational staff-hour, minimum 2 operational staff while open**, organisation level. This is a fictional-company assumption, never a benchmark or legal requirement, and never learned from data.
- Transactions are an MVP workload proxy. Do not claim they capture covers, item complexity, kitchen bottlenecks or queue length. Do not add those variables, or role-specific forecasting, before submission.
- **Golden Path anti-tuning:** discover the example from accepted rules. Never select or alter rules, reference demand, capacity, regular cover or forecast parameters to manufacture a preferred example. The historical 14:00–20:00, £96, £200, £25, £121 example is not a hospitality target.
- **Earnings:** the authorised direction is base + variable tips = total approved earnings. This is **not implemented** and the tip allocation method is open. Do not implement or claim tips without a work package.
- **Contextual AI (FS-DEMAND-CONTEXT-001) is not implemented.** The baseline is deterministic, and AI explains and ranks only.

### PayPal — SANDBOX-CONNECTED

PayPal is the central worker-payment integration. Current evidence establishes:

- Sandbox OAuth authentication;
- one controlled $25 Sandbox payout;
- persisted provider identifiers and payout state;
- provider status refresh and reconciliation to `PAID` after PayPal item `SUCCESS`;
- duplicate payout protection;
- one genuine GBP 121.00 Sandbox payout on Square-attributed work, reaching item `SUCCESS` and `PAID`.

This evidence does not imply production capability or verification of every PayPal feature. Never represent an unverified, pending, failed, or unknown operation as successful.

### Current hackathon architecture

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

This chain states the intended path. The stages from allocation to worker confirmation have been exercised locally on Square Sandbox evidence and a genuine PayPal Sandbox payout ([`docs/PAYPAL_FINAL_EVIDENCE.md`](docs/PAYPAL_FINAL_EVIDENCE.md)), on a short real shift rather than the 14:00–20:00 window. The reference-history forecast to allocation stages were not part of that one run, and nothing is deployed. See the product specification, section 10, for current status, the Golden Path economics, and the MVP refund decision.

### Square Sandbox — SANDBOX-CONNECTED, active hackathon commerce provider

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

AI must not determine whether a worker gets paid, approve payouts, fabricate financial results, or make consequential employment decisions.

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

Golden-path work should include positive verification and relevant negative-path verification. Priority judge-visible controls are scheduling conflict prevention, the manager approval gate, and duplicate PayPal payout protection. Keep demonstrations focused; do not build exhaustive enterprise-grade fault infrastructure for the hackathon.

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

1. read this `AGENTS.md`;
2. verify the current working directory;
3. verify the current branch;
4. verify HEAD;
5. inspect Git status;
6. inspect the relevant implementation and dependencies;
7. identify material assumptions and existing uncommitted work.

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

Do not create a commit unless the current work package explicitly authorises it. Review the staged file list and staged diff before every authorised commit. After work, report changed files and final Git state.

## 13. Testing priorities

A feature is not complete because code was written. Use targeted tests first, then the repository's normal verification when justified by the change.

Prioritise:

1. golden-path behavior;
2. POS ingestion and normalisation when implemented;
3. AI input/output contracts and degraded states;
4. scheduling, availability, and overlap conflicts;
5. worker offer response and acceptance;
6. deterministic performance and incentive calculation;
7. manager approval gate;
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

Substantive coding tasks should begin with one of:

- `CONTINUE CURRENT SESSION`
- `START NEW SESSION — EMPTY CONTEXT`

The work package should state:

- recommended agent/model;
- reasoning/effort;
- objective and definition of done;
- authorised scope;
- prohibited actions;
- repository baseline and verification;
- tests and verification;
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
- a required provider operation or capability cannot be verified;
- required credentials/configuration are unavailable for an operation that cannot proceed without them;
- implementation would expose secrets;
- an unexpected destructive migration is required;
- a major architecture replacement becomes necessary;
- a task would present planned, mocked, seeded, or simulated behavior as real;
- current official competition requirements are ambiguous or conflict with the package.

Use the discrepancy report format in section 9. Safe independent work may continue when it does not depend on the blocked decision.
