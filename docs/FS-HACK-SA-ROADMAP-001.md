# FairShift South African Hackathon Delivery Roadmap

| Control | Value |
|---|---|
| Document ID | FS-HACK-SA-ROADMAP-001 |
| Effective date | 5 November 2026 |
| Authority | Owner work package FS-HACK-SA-ROADMAP-LOCK-001, phases 3–5; corrected by FS-HACK-SA-ROADMAP-CORRECTION-001 / DEC-SA-011, 5 November 2026; [dated amendment and decisions](FS-HACK-SA-AMENDMENT-001.md) |
| Status | LOCKED operating roadmap; all fourteen Golden Demo Path steps and FairShift Pay Agent REQUIRED |
| Supersedes | FS-HACK-ROADMAP-002 delivery sequence, demo path/step numbers and next-action pointer; older product rules only where the dated amendment expressly applies |
| Single active roadmap | Owner decision, 5 November 2026: this is FairShift's only active product roadmap. The UK Heads-up Rewards proposal is superseded; UK and SA product models are not merged; no parallel roadmap |
| Implementation authority | Each stage needs a separate Owner-authorised work package; this roadmap authorises no code, provider operation, commit, merge, push or deployment |
| Verified source | Integration branch fs-hack-integrate-001, HEAD 789be8d9c0cb6c810452191609a25d65d6f01fa2; clean preflight |

## 1. Required reading and authority

Read AGENTS.md, authority-register sections 1–2, the SA amendment, this roadmap and applicable product-specification decisions before implementation. Official [hackathon rules](https://paypalaihackathon.devpost.com/rules) outrank every repository document. The master remains the historical baseline; newer applicable dated Owner amendments prevail. Repository evidence determines what exists, never what is authorised.

**LOCKED** means approved direction requiring explicit dated Owner amendment to change. **REQUIRED** means necessary to complete the approved demo. **NEEDS VERIFICATION** means not proven and blocked for dependent claims/actions. **DEFERRED** means postponed beyond this Sandbox demo. **OUT OF SCOPE** means excluded from the authorised route. Approval is distinct from implemented, tested, verified locally, deployed, verified on hosted and demo-ready. Reconciliation uses WORKING (required behaviour demonstrated with reproducible evidence), PARTIAL (some required behaviour exists), ABSENT (required capability missing), BLOCKED (dependent policy/provider/safety gate unresolved), and UNVERIFIED (insufficient runtime evidence). Source code alone is not WORKING; distinguish automated, browser and provider evidence.

FairShift is an independently usable multi-tenant SaaS product. The fictional five-location SA/ZAR business is isolated demo data. An ordinary employer must onboard and operate without fixed demo identities, synthetic-history fallback or demo sender credentials. The separate uncommitted SaaS safety remediation is not present in this baseline and must not be merged by this package.

## 2. Final Golden Demo Path — canonical step numbers

All steps are REQUIRED target behavior, not a claim of current implementation.

1. Owner reviews historical sales.
2. AI predicts demand across relevant locations.
3. Manager creates the required shift using Bryntum with preauthorised compensation terms.
4. Location-bound eligible casual workers receive offers with disclosed compensation.
5. The casual worker accepts the offer and its disclosed compensation terms.
6. The worker completes the allocated assignment.
7. The manager confirms the completed shift.
8. FairShift verifies performance and calculates earnings deterministically from the accepted, preauthorised terms and verified evidence.
9. Confirmed completed work automatically triggers genuine model-backed FairShift Pay Agent orchestration, without a casual-worker payout request or second discretionary Owner payment approval.
10. The Pay Agent invokes a bounded, allowlisted server settlement action using verified records.
11. The server resolves entitlement, sender/merchant, recipient, amount, supported currency and existing payment authority, and enforces deterministic eligibility and funding checks.
12. The authorised shared settlement service calls PayPal Sandbox using the verified adapter only when all required gates pass.
13. Batch/item identifiers and actual provider status persist safely with duplicate protection, idempotent reconciliation and uncertain-outcome recovery.
14. The worker sees truthful payment status, confirmation when provider-confirmed, and financial history.

Supporting permanent-staff path: **POS evidence → approved tip allocation → employee requests permitted early tip release → genuine model-backed Pay Agent → shared settlement service → PayPal status and financial history.** Limited access and tip ceilings require explicit policy design; no fourth application user role is created.

**Supersession, 5 November 2026:** DEC-SA-011 replaces the original casual availability/request/tool sequence (steps 8–10, specifically the request mandates at 9/10) authorised by FS-HACK-SA-ROADMAP-LOCK-001. The original sequence is retained explicitly as superseded history in the correction evidence and the preceding reconciliation response; it does not direct new casual implementation. No casual-worker payout request or second discretionary Owner payment approval is required.

Step 2 retains the canonical deterministic forecast and bounded AI contract, with visible inputs, structured model output, staffing consequence and Manager control. Persisted final allocation is required after acceptance and before completion (steps 5–6); no actor accepts on the worker's behalf. Step 7 confirms completed work, not a fresh discretionary payment approval. Step 8 validates performance and calculates entitlement under existing authority; missing evidence or unapproved allocated tips cannot become eligible money. Steps 9–12 require automatic genuine model-backed orchestration and bounded server actions, while the server alone resolves financial facts and enforces authorisation. Duplicate completion events and tool calls must not duplicate payment; model/provider failure preserves valid obligation/status and a safe recovery path. Step 14 distinguishes pending, failed and unknown from confirmed payment: a batch response is not item success. Automatic orchestration does not promise instant or unconditional settlement.

## 3. Delivery stages and dependency gates

This gate sequence replaces the dated R0–R8 schedule in the older roadmap. It establishes dependencies, not new product rules or a claim that a gate passed. No new calendar commitment is invented. Each stage is REQUIRED and SUBMISSION-CRITICAL; stop dependent work when its gate is not met. Read-only investigation and independent authorised work may proceed.

| Stage | Steps advanced | Dependencies before implementation/provider action | Required exit gate |
|---|---|---|---|
| SA-R0 — Repository and authority reconciliation | 1–14 | Exact work-package branch/HEAD/status; current documents; no writes to protected worktrees | SA-G0: classify every revised step WORKING / PARTIAL / ABSENT / BLOCKED / UNVERIFIED with evidence, current security status and the smallest authorised change set |
| SA-R1 — Independent SaaS and isolated SA reference | 1–3; supporting path | SA-G0; separately authorised treatment/integration of SaaS safety work; approved SA data/rate scope | SA-G1: fresh ordinary business works without demo prerequisites; tenant/location/worker boundaries and explicit synthetic-data isolation verified; SA/ZAR reference clearly labelled |
| SA-R2 — Sales, bounded AI and Bryntum operations | 1–6 | SA-G1; verified commerce-source/attribution availability for the selected route; unresolved offer rules decided where needed | SA-G2: historical source truth → visible AI staffing consequence → Bryntum shift → eligible offer → disclosed acceptance → persisted allocation and completion; conflict prevention demonstrated |
| SA-R3 — Performance, tips and authorised entitlement | 7–8; supporting path | SA-G2; exact written allocation/eligibility/hours/refund decisions; verified POS tip/staff attribution; SA compensation scope | SA-G3: deterministic explained earnings from preauthorised accepted casual terms and manager-confirmed completion, without second discretionary Owner payment approval; approved tip allocation; permanent staff remain lightweight records; shared settlement identity and reconciliation |
| SA-R4 — PayPal capability and funding verification | 11–13 | SA-G0; current official Toolkit/API and SA country/currency/category evidence; separate Owner package for any Sandbox operations | SA-G4: specific authorised sender/funding, recipient, category and provider currency proven for Sandbox; ZAR/provider-currency separation and any required conversion/fee/rounding policy approved; supported adapter/tool capability recorded |
| SA-R5 — FairShift Pay Agent and controlled orchestration | 9–11; supporting path | SA-G1, SA-G3 and SA-G4; permanent-staff release access decided before that part is built | SA-G5: confirmed casual completion automatically triggers genuine model-backed orchestration through bounded, allowlisted actions, with no casual request or second discretionary Owner approval; permanent early tips require a permitted employee request after allocation approval; server resolves financial fields/authority; tampering, duplicate triggers and ineligible payments are refused |
| SA-R6 — Shared Sandbox settlement and history | 12–14; supporting path | SA-G3, SA-G4 and SA-G5; explicit Owner authorisation for the particular provider exercise | SA-G6: genuine Sandbox payment, safe batch/item persistence and reconciliation, item-success confirmation, duplicate protection, uncertain-outcome recovery and reload/history evidence; same controls for tips |
| SA-R7 — Repeatability and safety | 1–14 | SA-G2, SA-G3, SA-G5 and SA-G6 | SA-G7: complete route repeatable without database surgery; tenant isolation, scheduling conflict, casual preauthorisation/acceptance/completion checks, permanent-tip allocation approval/request, AI/tool denial, provider failure/unknown and duplicate/recovery controls; mobile worker acceptance |
| SA-R8 — Submission and clean-room evidence | 1–14 | SA-G7 and current official compliance verification | SA-G8: evidence matrix and claims match the working build; judge access, public-source/licence/setup, tools disclosure and functioning video meet current rules; publication/submission still requires its own authorisation |

SA-R4 research may run alongside SA-R1–3 under its own package. It cannot authorise provider calls or bypass SA-G3/5. A capability failure blocks the affected payment stage, not an invented replacement currency or merchant. FS-HACK-SA-GOLDEN-RECON-001 completed the read-only reconciliation, with findings recorded in the preceding session response and summarised in [correction evidence](FS-HACK-SA-ROADMAP-CORRECTION-001_EVIDENCE.md). SA-G0 has repository classifications, not application acceptance. DEC-SA-011 changes the target for the affected casual steps; their implementation remains ABSENT or BLOCKED. SA-G1–8 remain **NOT VERIFIED for the corrected SA path**. Prior UK/GBP or mocked tests are evidence of their own scope only.

### Earlier step-number crosswalk

| FS-HACK-ROADMAP-002 section 15 (historical) | This roadmap section 2 (current) |
|---|---|
| 1 historical business position | 1 |
| 2–3 forecast and demand drill-down | 2 |
| 4–5 Bryntum/fill shift | 3 |
| 6–7 eligibility/offers | 4 |
| 8 acceptance | 5 |
| 9 allocation | 5–6, with persisted allocation required before completion |
| 10 performance | 6–8 |
| 11–12 earnings/approval | 3–5 preauthorised accepted terms; 7 completion confirmation; 8 deterministic earnings; 11 existing authority checked, with no second discretionary Owner approval |
| No equivalent | 9–10 automatic casual Pay Agent orchestration; permitted permanent-staff requests remain in the supporting path |
| 13 PayPal | 11–12 |
| 14 persistence | 13 |
| 15 worker confirmation | 14 |

Existing historical records keep their original numbers. Future packages cite **FS-HACK-SA-ROADMAP-001 section 2** and the applicable SA-R/SA-G dependencies explicitly.

## 4. Payment and AI boundaries

- REQUIRED: DEC-SA-011 makes genuine model-backed Pay Agent orchestration automatic after manager-confirmed completed casual work. No casual payout request or second discretionary Owner payment approval. Permanent-staff early-tip release remains employee-requested after approved allocation. Both use bounded, allowlisted actions and one shared settlement engine; only the server resolves financial facts/authority and executes eligible payments. Duplicate/recovery safeguards are required.
- REQUIRED: every real employer has its own authorised arrangement. A dedicated isolated demo merchant is allowed only for that demo, never an ordinary customer fallback.
- NEEDS VERIFICATION: SA payout category, supported provider currency, sender and recipient permissions, adapter eligibility and any deterministic ZAR-to-provider conversion policy. ZAR is operating currency; it is not presumed to be a supported payout currency.
- REQUIRED: official Toolkit/MCP only within verified capabilities. A policy-bound custom Payouts API tool is permitted after eligibility verification; no direct model bypass around the shared server settlement boundary.
- REQUIRED: POS-attributed permanent-staff tips use approved allocation → permitted employee early-release request → Pay Agent → shared settlement → provider status/history. A staff sales code must have verified provider provenance. No automatic inference of tip ownership.
- NEEDS VERIFICATION / OPEN: exact tip-policy edge cases, SA applicability of earlier permanent-tip election/clearance rules and how a lightweight staff record can authorise a release without a new application role. No release-percentage change is inferred.
- DEFERRED: production payroll, tax and other regulatory integrations; production payment readiness. A Sandbox payment does not prove these.
- OUT OF SCOPE: disconnected tip-payment stack, shared demo funding for genuine employers, fourth permanent-staff user role, AI financial authority, cross-location casual scheduling, invented commerce attribution and undocumented feature/provider/schema expansion. Existing stable functionality is preserved.

## 5. Official-source checkpoint — 5 November 2026

Read-only documentation review only; no provider operation or account eligibility test occurred.

- [Official rules](https://paypalaihackathon.devpost.com/rules), sections 1 and 4, and [overview](https://paypalaihackathon.devpost.com/): Sandbox plus meaningful AI, functional judge access, public open-source repository, setup materials and a functioning short public YouTube demo remain submission requirements. The rules list the deadline as 12 November 2026, 12:00 PM PST. Recheck before submission; this checkpoint is not entrant eligibility certification.
- [Official PayPal MCP guide](https://developer.paypal.com/ai-tools/mcp-server) documents local/remote connection. [PayPal Agent Toolkit documented tools](https://github.com/paypal/agent-toolkit#available-tools) do not list native Payouts creation in the reviewed README. **Inference limited to that documented inventory:** native Payouts creation is not established; pin and verify the selected version/runtime tool list before claiming support. No installation or tool execution was performed.
- [PayPal country/features reference](https://developer.paypal.com/payouts/supported-features) lists South Africa (ZA) as send, receive and withdraw. This documentation is not proof that the selected merchant/recipient/category is permitted or that ZAR is a supported provider payout currency. DEC-SA-010 remains NEEDS VERIFICATION. [Payouts API reference](https://developer.paypal.com/api/payments.payouts-batch/v1) is a capability-verification starting point, not evidence of this project's eligible route.

No deadline, competition rule, provider permission or regulatory conclusion is encoded into application logic by this package.

## 6. Remaining blockers and next package

1. The integration baseline does not contain the uncommitted SaaS safety remediation. Its evidence reports local PASS; this governance package does not re-run or integrate it. Any transfer needs separate explicit Owner authorisation and review of overlapping authority-register edits.
2. FS-HACK-SA-GOLDEN-RECON-001 is complete as a read-only report in the preceding session response. Reusable operational/payable/recovery code exists; the Pay Agent, automatic completion trigger and corrected casual orchestration are absent. SA reference data/rates and the complete revised path remain unverified. UK/GBP evidence is not SA readiness; no bulk currency relabelling or UK safeguard removal is authorised. ~~SA locations currently fall back to USD for new work-policy currency.~~ **Repaired locally, 5 November 2026 (uncommitted):** South African locations now create ZAR terms (steps 3–5, 8), and ZAR payables are refused before any payout reservation because no ZAR PayPal route is verified (steps 11–12 gate). Existing USD-labelled SA records are not rewritten. **Bounded closeout correction, FS-HACK-SA-GOV-ZAR-CLOSE-001:** the SA route gate refuses even legacy GBP/USD obligations for an SA employer or location before reservation and provider-client construction; no-batch recovery resends pass the same gate. Known-batch status reads remain available. Historical currency evidence is not merchant permission.
3. Verify the actual SA commerce provider and staff/tip attribution capability. The prior UK Square seller and explicit team-member Sandbox payments establish only that UK route; do not assume a South African merchant can use it.
4. Verify the exact Sandbox payment category/currency, authorised merchant funding and recipient permissions; obtain any needed Owner FX/fee/rounding and release-policy decisions. Do not select a fallback merchant/currency or initiate a payout here.
5. Square tip-evidence capture exists; tip allocation and settlement remain incomplete. Resolve the written tip-policy details, limited permanent-staff request access/ceilings and relevant authority-register conflicts before dependent code. Preserve approved permanent-tip allocation, voluntary election and proof/reconciliation; casual authority follows DEC-SA-011 without a second discretionary Owner payment approval. No new production payroll/tax integration.
6. Confirm third-party licensing/terms and current judge-access/hosting/publication requirements before related claims or external actions. The complete SA Golden Path and integrated browser/hosted behavior are NOT VERIFIED.

**Completed reconciliation, not implementation authority:** FS-HACK-SA-GOLDEN-RECON-001 inspected repository/worktrees, all fourteen former steps, Pay Agent gaps, financial contracts, SaaS safety and provider gates. Its former casual request-tool and second approval assumptions are superseded by DEC-SA-011. Its source findings, funding/currency/POS blockers and evidence limits remain useful; no recommendation activates a successor. The report was delivered in conversation, not as a standalone repository report. This package records its outcome in [correction evidence](FS-HACK-SA-ROADMAP-CORRECTION-001_EVIDENCE.md).

**Additional isolation blockers from reconciliation:** the main payout factory uses global credentials without tenant funding binding; recovery must remain tied to the original merchant/environment. Safety remediation permits synthetic history only for public demo personas, while genuine AI/payment POSTs reject those personas. A separately authorised authenticated rehearsal context needs design; do not loosen public access or use demo funding for customers. Worker financial history remains operational-entitlement gated. SA commerce/staff attribution feasibility, provider payment category/currency, model-backed automatic orchestration and integrated browser/provider acceptance remain open.
**Next coding recommendation after SA-G0, NOT AUTHORISED: FS-HACK-SAAS-ISOLATION-001.** Advance SA-R1 / steps 1–3 by repairing only the SaaS/demo prerequisites confirmed by reconciliation, using the separately reviewed safety remediation where explicitly authorised. Verify fresh-business operation, ordinary-account refusal of synthetic/demo identities and cross-tenant access, plus scheduling/earnings/payment regressions. Exact baseline, source transfer/commit/integration policy and file scope must come from the new Owner package. Preserve the current safety worktree; no SA financial rule, FX policy or provider operation belongs in that coding scope.

Every later coding work package must identify its ID, session mode, model/effort, exact branch/HEAD/status, objective/definition of done, section 2 step numbers, SA-R/SA-G dependencies, relied-on Owner decisions (including any OCR decision), scope/exclusions, risks, positive/negative tests, stopping conditions and commit/integration/provider-operation policy. Unmapped features are deferred unless explicitly justified as a compliance requirement or blocker repair. Only a new Owner-authorised dated amendment can expand locked scope.
