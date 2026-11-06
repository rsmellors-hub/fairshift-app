# FairShift South African Hackathon Owner Amendment

| Control | Value |
|---|---|
| Document ID | FS-HACK-SA-AMENDMENT-001 |
| Decision date | 5 November 2026 |
| Authorising sources | DEC-SA-001–010: Owner work package FS-HACK-SA-ROADMAP-LOCK-001, phases 3–5. DEC-SA-011 and corrected demo path: Owner work package FS-HACK-SA-ROADMAP-CORRECTION-001, 5 November 2026 |
| Status | OWNER APPROVED; LOCKED product direction; governance recording only |
| Baseline amended | FS-HACK-MASTER-001 and applicable older product/roadmap clauses, only as explicitly identified below |
| Delivery reference | [FS-HACK-SA-ROADMAP-001](FS-HACK-SA-ROADMAP-001.md) |
| Implementation status | This amendment establishes requirements, not implementation, provider eligibility, deployment or demo readiness |

## 1. Authority and bounded supersession

Current official [PayPal AI Hackathon rules](https://paypalaihackathon.devpost.com/rules) remain highest authority. This dated Owner amendment prevails over the historical Phase 0 baseline and older dated decisions only in the scope stated here. The existing [product specification and decision register](FAIRSHIFT_PRODUCT_UX_SPEC.md), [authority register](FS-DOCUMENT-AUTHORITY-REGISTER.md) and unaffected financial/security controls continue to apply.

The Owner's authorisation supplied with FS-HACK-SA-ROADMAP-LOCK-001 is: “The FairShift owner has approved the South African hackathon pivot, the revised Golden Demo Path and the FairShift Pay Agent as REQUIRED functionality.” This record transcribes that authorisation; it creates no further Owner decision.

## 2. Complete Owner decision register

DEC-SA-001–010 have decision date **5 November 2026**, source **FS-HACK-SA-ROADMAP-LOCK-001, phase 3**, and approval **OWNER APPROVED / LOCKED**. DEC-SA-011 has the same date and approval status, with its distinct Owner source stated in full below. REQUIRED denotes a deliverable; NEEDS VERIFICATION denotes a dependency that approval does not prove.

### DEC-SA-001 — Demo jurisdiction and operating currency

South Africa replaces England as the hackathon demo jurisdiction. ZAR is the operating currency.

### DEC-SA-002 — Independent SaaS

FairShift remains an independently usable multi-tenant SaaS platform, not a prepopulated guided application.

### DEC-SA-003 — Isolated demonstration business

The five-location fictional SA business is isolated demonstration data, never a runtime prerequisite.

### DEC-SA-004 — Central product loop

> **Superseded in part, 5 November 2026, by DEC-SA-011 (FS-HACK-SA-ROADMAP-CORRECTION-001).** The original wording below is retained as history. Casual payment is event-triggered after manager-confirmed completion; a worker request applies only to permitted permanent-staff early tip release. No second discretionary Owner payment approval applies to the casual path.

The central product loop remains:

sales intelligence → AI forecast → staffing → shift offer → acceptance → allocation → verified performance and earnings → worker-requested release → PayPal payment → worker confirmation and financial history.

### DEC-SA-005 — FairShift Pay Agent REQUIRED

> **Superseded in part, 5 November 2026, by DEC-SA-011 (FS-HACK-SA-ROADMAP-CORRECTION-001).** The original wording below is retained as history. Casual payment is event-triggered after manager-confirmed completion; a worker request applies only to permitted permanent-staff early tip release. No second discretionary Owner payment approval applies to the casual path.

FairShift Pay Agent is REQUIRED.
The agent supports requests, explanations and payment orchestration using verified records.
The server authorises and executes payments.
The AI cannot invent amounts, recipients or funding identities or bypass financial policy.

### DEC-SA-006 — Actual Toolkit/MCP capability

The official PayPal AI Toolkit/MCP is used only for capabilities it actually supports. Do not claim it provides native Payouts creation if it does not.
A policy-bound custom tool may use the PayPal Payouts API after eligibility is verified.

### DEC-SA-007 — Sandbox experience and regulatory deferral

The hackathon demonstrates a functional Sandbox payment experience. Production payroll, tax and other regulatory integrations are deferred.
Do not represent deferred functionality as implemented or approved.

### DEC-SA-008 — Permanent-staff tips

POS-attributed tips for permanent staff remain in scope. Permanent staff are lightweight records, not a fourth application user role.

### DEC-SA-009 — Employer funding boundary

Each genuine employer requires its own authorised funding/payment arrangement. A dedicated demo merchant may be used for the isolated hackathon demo.
Never use shared demo sender credentials as customer merchant credentials.

### DEC-SA-010 — Separate operating and provider currencies

Operational ZAR earnings and PayPal provider payout currency are distinct. SA payout category, currency, merchant and recipient permission remain NEEDS VERIFICATION until actually proven.

### DEC-SA-011 — Event-Triggered Casual Payment and Worker-Requested Permanent-Staff Tip Release

**Decision date:** 5 November 2026. **Status:** OWNER APPROVED / LOCKED; REQUIRED target behaviour, not implemented by this amendment. **Authorising source:** Owner-supplied work package **FS-HACK-SA-ROADMAP-CORRECTION-001**, OWNER AUTHORITY, CORRECT MODEL and tasks 2–10, supplied directly in this session. This is the latest applicable Owner decision.

**Casual workers:** preauthorised shift compensation → accepted offer → manager-confirmed completed shift → automatic FairShift Pay Agent orchestration → deterministic financial checks → eligible PayPal Sandbox payment → reconciliation and worker history. No casual-worker payout request is required. No second discretionary Owner payment approval is required. The authorised compensation terms and the worker's acceptance precede work; manager confirmation establishes completed work, and deterministic checks establish whether payment is eligible under that existing authority. This is not permission to bypass missing performance evidence, unapproved tip allocation, funding authority or provider eligibility.

**Permanent staff:** POS evidence → approved tip allocation → employee requests permitted early tip release → Pay Agent → shared settlement service → PayPal status and financial history. Permanent staff remain lightweight records, not a fourth application user role. Limited access, request authentication, destination confirmation, election/consent and exact tip-ceiling policy remain subject to explicit policy design. This decision does not invent a new ceiling or resolve the open details of the previously recorded voluntary up-to-50% election.

**Pay Agent:** REQUIRED genuine model-backed orchestration, triggered automatically by manager-confirmed completed casual work; for permanent staff, triggered by their permitted early-tip request. It uses bounded, allowlisted server actions and verified records. It cannot invent financial data, independently determine or override amount, recipient, merchant, funding identity or payment authority, approve earnings, or execute an unrestricted provider operation. The server resolves and validates financial facts and authorises/executes the eligible payment through one shared settlement engine. Duplicate events/tool calls and uncertain outcomes require idempotency and safe recovery; a model failure or missing evidence is not payment success and must not erase the obligation or authorise an unsafe resend.

**Explicit supersession:** the casual-worker request requirements in DEC-SA-004/005 and the original SA Golden Demo Path steps 8–10, specifically steps 9/10, are superseded. The corrected fourteen steps are in FS-HACK-SA-ROADMAP-001 section 2. Older manual post-completion payable approval/initiation wording is historical for the revised casual path wherever it would impose a second discretionary payment approval. Preauthorisation, accepted terms, manager completion confirmation, deterministic financial controls and permanent-tip allocation approval remain required. Dated earlier decisions and evidence are retained with this bounded supersession.

**Retained gates:** SA PayPal merchant and recipient eligibility, payment category, supported provider currency, tenant-specific funding authority, ZAR/provider-currency separation and any FX/fee/rounding policy, SA POS provider feasibility, and Sandbox/production isolation remain NEEDS VERIFICATION or OPEN. Approval supplies no permission for a prohibited payment category. Independent SaaS onboarding and isolated fictional demonstration data remain required. Production payroll/tax integrations remain DEFERRED; no production compliance or provider permission is claimed. Implementation, provider exercises, commits and integration each require a separately authorised work package.

## 3. Exact effect on earlier authority

| Earlier provision | Effect of this amendment |
|---|---|
| Master sections 2–3, 4 and 9: demonstration company, operational loop, payment | DEC-SA-001–005 replace the demo jurisdiction/currency and add the Pay Agent; DEC-SA-011 supersedes casual-request sequencing with automatic orchestration after manager-confirmed completion. Permitted permanent-tip release remains employee-requested; no new application role |
| FS-WORKLOAD-INTELLIGENCE-001 and FS-HOSPITALITY-POLICY-FREEZE-001: UK company and named UK venues | UK geography and GBP demo economics are historical. The approved fictional five-location business is now SA/ZAR. SA venue names, data and rates are not selected by this package |
| FS-PRODUCT-PLAN-DEC-001 market and guardrail 2: UK hospitality only | Superseded for the hackathon demo by DEC-SA-001. Hospitality remains the demo vertical, not a SaaS runtime restriction |
| FS-WAGE-INTEL-DEC-002: England demo and adult GBP floor; England-specific FS-PAY-TERMS-DEC-001 amounts | Historical England requirements, not SA operating requirements. No GBP amount is relabelled as ZAR, no SA statutory rate is invented and no existing UK safeguard is removed. SA compensation/reference applicability is NEEDS VERIFICATION and needs its own package |
| Earlier core loops and FS-HACK-ROADMAP-002 sections 3, 11, 15–17, 21 | The SA roadmap now controls delivery, step numbers and dependencies. DEC-SA-011 replaces its original casual-request steps and supersedes older manual post-completion approval/initiation wherever it would add a second discretionary payment approval. Casual preauthorisation, acceptance, completion confirmation and deterministic checks remain; permanent-tip requests follow approved allocation |
| FS-TIP-DEC-001: “AI has no role in ... PayPal payout”; FS-PRODUCT-PLAN-DEC-001 guardrail 8: “AI ... never moves money” | DEC-SA-005, as amended by DEC-SA-011, permits bounded explanation and genuine model-backed orchestration: automatic after confirmed casual completion, employee-requested for permitted permanent-tip release. AI still cannot calculate/approve entitlement, choose financial identities, authorise or execute provider payments. Server financial controls remain binding |
| FS-TIP-POOL-DEC-001/002, FS-TIP-ELIGIBILITY-DEC-001, FS-PAYOUT-TIMING-DEC-002 and FS-PAYOUT-PROOF-DEC-001 | Not replaced by a new tip formula or release percentage. Existing approved participation, voluntary up-to-50% permanent-tip election, reconciliation/proof and approval rules remain recorded; unresolved allocation details and jurisdiction-specific treatment stay gated. Do not implement UK payroll/tax assumptions as SA rules |
| Genuine UK/GBP Square and PayPal Sandbox evidence | Preserved as historical evidence of those exact operations. It proves neither SA commerce availability nor an authorised ZAR payout route |
| Existing scope freeze | Retained except for the explicitly REQUIRED Pay Agent and revised SA path. Regulatory integrations are DEFERRED; demo/payment isolation is REQUIRED; no disconnected tip settlement system |

“AI forecast” retains the existing deterministic canonical baseline and bounded AI interpretation/scenarios under Manager control. DEC-SA-004 does not authorise an unconstrained forecasting rewrite.

POS staff attribution is evidence/input, not automatic tip ownership. The employer's approved deterministic policy creates the allocation. DEC-SA-008 does not authorise a permanent-staff account or decide how a lightweight staff record requests release; that access mechanism needs a scoped Owner decision before implementation.

## 4. Open boundaries preserved

The amendment does not choose a payout currency, conversion rate, FX/fee/rounding policy, payout category, merchant identity, recipient permission, SA POS provider, SA statutory wage, tax treatment, new release percentage or tip-policy edge case. Those remain NEEDS VERIFICATION or OPEN and block dependent implementation. Existing authority-register conflicts are not silently resolved. Production payroll/tax/regulatory integration is DEFERRED, not approved for production use.

Use one shared settlement engine with two authorised entry paths under DEC-SA-011: casual preauthorised terms + acceptance + manager-confirmed completion → automatic Pay Agent orchestration; permanent approved tip allocation + permitted employee request → Pay Agent orchestration. Both pass through deterministic entitlement/funding/provider checks → server-authorised execution → persisted actual status → reconciliation/history. There is no casual-worker request or second discretionary Owner payment approval. This governance amendment authorises no implementation or provider operation.

## 5. Addendum

### DEC-SA-012 — Operating currency, Sandbox provider payout currency and fixed demo rate

**Decision date:** 6 November 2026. **Status:** OWNER APPROVED. **Authorising source:** Owner-supplied work package **FS-HACK-SA-SUBMISSION-001**. Requirements only; this decision records no code and implements nothing.

- The operating currency is **ZAR**.
- The Sandbox provider payout currency is **USD**, because PayPal does not support ZAR.
- One fixed Sandbox demo rate of **<RATE> ZAR = 1 USD** applies, and it is shown to the worker. The value of `<RATE>` is **not yet recorded**: the Owner must supply it before any code or payout depends on this decision.
- The USD amount is rounded **down** to the cent.
- The rate, the USD amount and the rate source are **frozen on the payout reservation**, so recovery never re-converts.
