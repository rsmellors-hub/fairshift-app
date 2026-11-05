> **Payment-model correction — 5 November 2026.** Owner work package **FS-HACK-SA-ROADMAP-CORRECTION-001** records **DEC-SA-011** in [the SA amendment](FS-HACK-SA-AMENDMENT-001.md). Casual compensation is preauthorised and accepted; manager-confirmed completion triggers automatic genuine model-backed Pay Agent orchestration, deterministic server checks and eligible Sandbox settlement. No casual-worker payout request or second discretionary Owner payment approval. Permanent-tip allocation approval and permitted employee request remain required; both paths use one settlement engine. The original manual approval/send narrative below is historical, not the current casual requirement. External provider/funding/currency/POS gates remain unresolved.

> **Superseded delivery roadmap — 5 November 2026.** Owner work package **FS-HACK-SA-ROADMAP-LOCK-001** authorises [FS-HACK-SA-AMENDMENT-001 / DEC-SA-001–010](FS-HACK-SA-AMENDMENT-001.md) and [FS-HACK-SA-ROADMAP-001](FS-HACK-SA-ROADMAP-001.md). The SA roadmap now controls the fourteen-step Golden Demo Path, REQUIRED Pay Agent, stage dependencies and future work-package references. This document's original status, dates, fifteen-step path, R0–R8 schedule and section 21 next-action wording are retained as history and do not activate work. Unaffected product constraints continue only as reconciled by the dated amendment and authority register. England/GBP evidence is historical, not current SA operating policy.

# FAIRSHIFT

## Official Competition Delivery Roadmap

**Document ID:** FS-HACK-ROADMAP-002\
**Version:** 2.0\
**Effective date:** 3 November 2026\
**Competition:** PayPal AI Hackathon\
**Submission deadline:** 12 November 2026, 12:00 PM PST / 22:00 SAST\
**Internal submission-ready target:** 11 November 2026\
**Status:** OFFICIAL OPERATING ROADMAP\
**Baseline authority:** FS-HACK-MASTER-001

> **Repository reconciliation notice. Not part of FS-HACK-ROADMAP-002.** Added by FS-HACK-GOV-APPLY-001A on 3 November 2026. The roadmap's wording is unchanged. So that the repository whitespace check passes, its trailing double spaces were removed: 25 line breaks are now written as backslash line breaks, and one at a paragraph end, which had no effect, was simply dropped. The rendered output is unchanged.
>
> - **Frozen baseline:** [`FS-HACK-MASTER-001.md`](FS-HACK-MASTER-001.md).
> - **Dated Owner decision register:** [`FAIRSHIFT_PRODUCT_UX_SPEC.md`](FAIRSHIFT_PRODUCT_UX_SPEC.md), section 1. Section 1 of this roadmap does not name it.
> - **This roadmap's role:** Owner-directed delivery authority for the delivery sequence, the scope freeze, golden-path acceptance and its step numbers (section 15).
> - **Unresolved conflicts with dated Owner decisions:** holiday pay in the payable (sections 10, 14; FS-PAY-TERMS-DEC-001); cancellation pay (section 14; FS-PAY-TERMS-DEC-001); the guaranteed-hours pathway (section 14; FS-PATHWAY-DEC-001); fair offer order (section 15, steps 6–7; FS-OFFER-ORDER-DEC-001); earned-wage-advance wording (section 11; FS-PRODUCT-PLAN-DEC-001, FS-PAY-TERMS-DEC-001); whether hourly-only pay and the minimum-rate check fall inside the section 14 freeze (FS-PAY-TERMS-DEC-001). Allocated tips (sections 3, 10, 15 step 11) still need the written tip rule that FS-TIP-DEC-001 leaves open. The pricing direction in section 13 is new and post-hackathon.
> - **Effect:** none of those clauses, and no contested part of the decisions they conflict with, directs implementation until the Owner records a decision in the specification.
> - **Bryntum forecast-gap planning** (sections 6, 9, 15 step 4) is an Owner-directed product refinement, on the Owner's explicit instruction. It is approved direction and not implemented.
> - Details and decision provenance: [`FS-DOCUMENT-AUTHORITY-REGISTER.md`](FS-DOCUMENT-AUTHORITY-REGISTER.md), sections 5 and 6.

---

# 1. Authority

FairShift will operate under the following authority order:

1. Current PayPal AI Hackathon Official Rules.
2. FS-HACK-MASTER-001, except for the explicit amendments recorded in this roadmap.
3. Current verified repository reality.
4. This delivery roadmap and authorised work packages.
5. Implementation preference.

Repository reality must never be assumed.

Before substantive implementation work, the canonical repository must be checked for:

- working directory;
- branch;
- HEAD;
- git status;
- relevant current implementation;
- test state where applicable.

If implementation materially differs from the expected state, work must stop for that affected area and report:

**Expected → Found → Impact → Recommended Action**

Competition compliance, product coherence, end-to-end reliability and presentation quality outrank feature count.

---

# 2. FairShift North Star

## Product thesis

**FairShift uses commerce intelligence and AI to predict casual labour demand, turn staffing gaps into suitable shift opportunities for a business's own casual-worker pool, measure completed worker performance against transparent incentives, and convert approved earnings into PayPal-powered payouts.**

### Product line

**The right people. The right place. The right time. The right pay.**

Forecasting is an engine of FairShift.

Scheduling is the operational bridge.

Worker performance and transparent earnings create the economic outcome.

PayPal closes the loop.

FairShift is not being repositioned as a generic rota application, payroll system, staffing marketplace or employment-law compliance platform for the competition MVP.

---

# 3. Official Core Loop

The competition product must prove this complete loop:

**Commerce data**

→ historical sales intelligence

→ AI demand forecast

→ staffing recommendation

→ **Bryntum staffing plan**

→ identified casual staffing gap

→ Fill Shift

→ eligible location Worker Pool

→ manager/owner worker selection

→ shift offer

→ worker accepts

→ final allocation

→ work completed

→ attributed worker performance

→ performance incentive

→ allocated tips

→ base wage + incentive + tips

→ business approval

→ PayPal Payout

→ persisted PayPal status

→ worker payment confirmation

No new feature may displace completion of this loop.

---

# 4. Product Structure

FairShift has **two product sides**.

## 4.1 FairShift Business

The subscribing entity is the business.

The business owns:

- company configuration;
- locations;
- business users;
- permissions;
- compensation policy;
- incentive policy;
- tip policy;
- PayPal configuration;
- sales data;
- forecasts;
- staffing plans;
- workers;
- shifts;
- allocations;
- performance;
- approvals;
- payouts.

### Business users

FairShift will no longer assume that job title determines product structure.

An authorised business user has:

**identity + permissions + location scope**

The Owner/Admin has full business authority by default.

A Manager/Supervisor is a **delegated business-user permission profile**, normally scoped to one or more locations.

An owner of one outlet may therefore operate the entire FairShift workflow without creating a redundant Manager account.

A larger business may delegate operational permissions to actual managers or supervisors.

### Competition demo personas

The demo may still use:

**Owner → Manager → Casual Worker**

because these personas make the workflow understandable to judges.

They do not represent a mandatory organisational hierarchy inside the FairShift product architecture.

---

# 5. Location Model

The competition demo remains:

**one fictional company with five locations.**

Casual workers remain **location-bound** for the MVP.

A casual worker belongs to one home-location Worker Pool.

Cross-location casual-worker scheduling remains outside the competition MVP.

Business-user permissions may span multiple authorised locations.

If a business user operates only one location, FairShift must not require a redundant location selector.

---

# 6. FairShift Business Surfaces

## Overview

Consolidated operational position across authorised locations.

For the Owner this may include all five locations.

For a delegated user it includes only authorised scope.

## Sales & Forecast

Historical commerce data.

AI next-week demand forecast.

Staffing recommendation.

Forecast reasoning should be concise and operational rather than dominate the interface.

## Staffing Planner — Bryntum

Bryntum becomes the primary visual operational surface connecting:

**forecast → staffing requirement → shifts → offers → allocations**

The scheduler should display, where the implemented data supports it:

- existing staffing coverage;
- casual staffing requirements;
- proposed shifts;
- created shifts;
- offered shifts;
- accepted workers;
- final allocations;
- completed shifts.

A forecast staffing gap should be actionable from the planning surface.

Bryntum must not become a generic calendar or rota product.

Its FairShift purpose is:

> **visualising and operating the conversion of predicted demand into staffing coverage.**

## Fill Shifts

A staffing requirement becomes an actionable shift.

FairShift carries forward known information wherever possible:

- location;
- date;
- start time;
- end time;
- required casual headcount;
- applicable compensation policy.

The business user should not repeatedly enter information FairShift already knows.

## Workers

Location Worker Pool.

Includes:

- worker profile;
- invitation/activation state;
- availability;
- preferences;
- accepted allocations;
- conflict state;
- payment information;
- relevant performance state.

## Allocations

Past, current and future final allocations.

Bryntum should provide the principal visual representation where appropriate.

## Performance

Worker performance from the implemented and defensible attribution path.

Competition MVP worker performance remains based on approved sales-performance measures, including:

- attributed sales count;
- attributed sales value;
- incentive progress/result.

## Payments

Each payable must show separately:

**Base wage**\
**Performance incentive**\
**Allocated tips**\
**Total payable**

An authorised business user reviews and approves the final payable.

FairShift then initiates the PayPal payout.

The Payments surface also exposes:

- approval state;
- PayPal payout state;
- payout identifiers where appropriate;
- payout history;
- failure/non-success state;
- payment disputes.

## Business Settings

Includes only configuration required by FairShift's operating loop:

- company;
- locations;
- business-user permissions;
- compensation policy;
- incentive policy;
- approved tip policy;
- PayPal configuration.

---

# 7. FairShift Worker

The worker experience remains mobile-oriented.

## Home

Next relevant shift, outstanding offer, earnings/payment status and important action.

## Offers

Worker sees the offered shift and its terms before accepting.

The worker may accept or decline.

## My Shifts

Accepted and completed shifts.

## Performance & Earnings

Worker sees only permitted own performance information.

Completed shift earnings must clearly separate:

**Base wage**\
**Performance incentive**\
**Allocated tips**\
**Total**

## Payout History

PayPal payout status and previous payments.

## Availability & Preferences

Operational availability and agreed scheduling preferences.

## Profile

Required personal/contact and PayPal payment information.

## Disputes

Worker can raise a payment-related dispute through the agreed lightweight workflow.

---

# 8. AI Contract

AI must materially affect the product.

AI is responsible for demand intelligence and staffing recommendation.

It must not autonomously:

- publish the final roster;
- accept shifts for workers;
- approve earnings;
- approve tips;
- approve incentive payments;
- initiate a PayPal payout without the required business approval.

Where deterministic calculation is appropriate, deterministic code must calculate the number.

The demo must make visible:

**input → AI assessment → staffing consequence**

not merely an AI-generated paragraph.

No further forecasting feature expansion is authorised until the complete golden path is reliable.

---

# 9. Bryntum Contract

Bryntum is a core competition integration.

Its primary FairShift use is the **Staffing Planner**.

### Required demonstration

The competition demo should show:

**AI identifies staffing gap**

→ gap appears visually in Bryntum

→ business user opens/actions the gap

→ shift is created or confirmed

→ offers are sent

→ worker accepts

→ allocation appears in the staffing view.

Where technically reliable, the scheduler should visibly change as the operational state changes.

Bryntum is not included merely to qualify for a sponsor prize.

Its use must improve FairShift's product experience.

Sponsor-prize eligibility is secondary to the overall FairShift submission.

---

# 10. Compensation Contract

The competition payable is:

## Total Payable

**Base wage + performance incentive + allocated tips**

Each component must remain separately visible.

The worker must understand how the final amount was constructed.

The business user must review the amount before payout.

The existing approved incentive and tip decisions should be implemented rather than redesigned unless repository reconciliation identifies a blocking defect.

FairShift must not silently invent a new payroll, holiday-pay, guaranteed-hours or employment-compliance architecture during the competition window.

---

# 11. PayPal Contract

PayPal must remain central to the demonstrated product.

The required worker-payment path is:

**approved FairShift payable → genuine PayPal sandbox payout → PayPal identifier/status persisted → worker confirmation**

Minimum acceptance evidence:

- authenticated sandbox integration;
- real payout request;
- returned PayPal identifiers;
- duplicate protection/idempotency;
- persisted payment state;
- refresh/reload preserves state;
- at least one non-success/failure path handled correctly;
- worker sees payout status.

Do not describe the worker payout as simulated if genuine PayPal sandbox functionality is being claimed.

Do not reframe the payout as an earned-wage advance unless a separately authorised product decision requires that model.

---

# 12. Commerce and Attribution Gate

The current implementation must be reconciled before any new commerce-data work.

The roadmap does not silently choose between Zettle, Square or another implemented sales-data path.

The repository review must establish:

1. what actually provides historical sales data;
2. what actually provides worker-level sales attribution;
3. which parts are live/API-backed;
4. which parts are demo data;
5. which claims are safe to make.

The demo must tell **one internally consistent story**.

PayPal must remain central even if another authorised third-party commerce source is used.

False attribution claims are prohibited.

---

# 13. Subscription and Commercial Model

## Hackathon

Do not undertake a major pricing-system rewrite before the golden path is secure.

Existing working PayPal Subscriptions functionality may be retained and demonstrated where useful.

Judge access must remain free and unrestricted as required by the competition.

The product architecture must not assume that Manager users are separate paid seats.

## Commercial direction after the hackathon

FairShift's future pricing model should be assessed across three value dimensions:

**Locations**

Primary operational scale.

**Capabilities**

Potential future packaging of planning, workforce operations and payments.

**Usage**

Potential future relationship to filled/paid casual shifts or payment volume.

Final commercial pricing remains outside the submission-critical implementation path.

---

# 14. Scope Freeze

Until the golden path reaches PASS, the following are not authorised as new submission-critical work:

- guaranteed-hours pathway;
- new UK employment-compliance engine;
- cancellation-pay framework;
- holiday-pay architecture;
- payroll export;
- regular/full-time worker application accounts;
- cross-location casual scheduling;
- generic HRIS functions;
- leave management;
- recruitment;
- more forecasting features;
- additional external-context integrations;
- new sponsor integrations;
- new pricing architecture;
- generic Bryntum rota features;
- major role-system rewrite unrelated to the agreed permission refinement.

Existing stable functionality should not be removed merely because it is outside the demo.

The rule is:

> **stop expanding, not start deleting.**

---

# 15. Official Golden Demo Path

The build is not considered competition-ready until this sequence runs reliably.

### Step 1 — Business position

Owner opens the five-location view and sees historical factual sales.

### Step 2 — AI forecast

Owner views the next-week forecast and staffing recommendation.

### Step 3 — Demand drill-down

Owner selects a location/day/period and sees:

forecast demand\
existing coverage\
additional casual requirement.

### Step 4 — Bryntum staffing plan

FairShift displays the staffing requirement in the weekly operational view.

The judge can visually understand where the labour gap exists.

### Step 5 — Fill Shift

Owner or delegated manager opens/actions the staffing gap.

Required shift information is created or confirmed.

### Step 6 — Worker eligibility

FairShift filters the location-bound Worker Pool using deterministic eligibility constraints such as:

availability\
existing allocation\
shift conflict\
approved preferences.

### Step 7 — Send offers

Authorised business user selects suitable workers and sends the shift offer.

### Step 8 — Worker acceptance

Casual worker opens the mobile experience, sees the shift and economic terms and accepts.

### Step 9 — Allocation

Acceptance persists.

The worker appears in the final allocation and the Bryntum staffing view reflects the filled position.

### Step 10 — Performance

The implemented sales-attribution path populates the worker's permitted performance.

### Step 11 — Earnings

FairShift calculates:

base wage\
performance incentive\
allocated tips\
total payable.

### Step 12 — Approval

Owner or authorised delegated user reviews and approves the final payable.

### Step 13 — PayPal

FairShift initiates a genuine PayPal sandbox payout.

### Step 14 — Payment persistence

PayPal identifier and current status are stored correctly.

### Step 15 — Worker confirmation

Worker sees earnings composition and payout status/history.

That is the FairShift competition story.

---

# 16. Delivery Roadmap

| Date | Phase | Primary objective | Exit condition |
|---|---|---|---|
| **3 Nov** | R0 — Product Reset & Repository Truth | Freeze this roadmap and reconcile actual repo state against the 15-step golden path | Every golden-path step classified WORKING / PARTIAL / BROKEN / ABSENT |
| **4 Nov** | R1 — Operational Spine | Repair forecast → staffing → shift → worker offer → acceptance → allocation | Steps 1–9 execute without DB intervention |
| **5 Nov** | R2 — Bryntum Integration | Make Bryntum the visible forecast-to-allocation operational surface | Staffing gap, shift and accepted allocation visibly represented |
| **6 Nov** | R3 — Performance & Earnings | Complete performance → incentive → tips → payable | Deterministic, explainable total payable produced for demo shift |
| **7 Nov** | R4 — PayPal Closure | Complete approval → payout → persistence → worker confirmation | Steps 10–15 execute end-to-end with genuine sandbox evidence |
| **8 Nov** | R5 — Hardening | Permissions, conflicts, payout failures, refresh state, resetability, mobile worker UX and performance | Golden path repeatable and critical defects closed |
| **9 Nov** | R6 — Demo Engineering | Reduce friction, remove unnecessary clicks/text, finalise demo data and demo script | Entire story comfortably demonstrable under 3 minutes |
| **10 Nov** | R7 — Submission Production | README, licence, public-repo preparation, Devpost copy, screenshots, tools disclosure and video | Submission package materially complete |
| **11 Nov** | R8 — Clean-Room Verification & Submit | Fresh run of product and submission assets | Internal submission-ready gate PASS; submit when verified |
| **12 Nov** | BUFFER ONLY | No planned feature development | Emergency correction only before official deadline |

---

# 17. Hard Gates

## G0 — Repository Truth

Required before new implementation.

Must establish:

- branch/HEAD/status;
- current architecture;
- working routes;
- working integrations;
- current tests;
- current demo-data state;
- exact golden-path gaps.

## G1 — Operational Loop

Forecast through allocation works.

Steps 1–9 PASS.

## G2 — Earnings Loop

Performance, incentive, tips and total payable work deterministically.

Steps 10–12 PASS.

## G3 — PayPal Closure

Payout request, persistence and worker confirmation work.

Steps 13–15 PASS.

## G4 — Bryntum

Bryntum materially demonstrates staffing planning and allocation.

It must be more than a decorative calendar.

## G5 — Demo Reliability

Complete golden path can be reset and rerun without manual database surgery.

No known critical defect remains in the demonstrated route.

## G6 — Competition Compliance

Must verify:

- working PayPal + AI integration;
- functional judge access;
- public repository;
- open-source licence;
- run/setup instructions;
- required tools disclosures;
- public YouTube demo under three minutes;
- descriptions match actual functionality.

---

# 18. Implementation Priority Rule

Every work item must answer:

**Which golden-path step does this advance?**

If the answer is none, the item is deferred unless required by competition compliance or to repair a blocker.

Priority order:

**P0 — Golden-path blocker**

**P1 — Reliability/security/data integrity blocker**

**P2 — Demo clarity or sponsor integration that materially improves the golden path**

**P3 — Submission documentation**

**P4 — Everything else**

P4 work does not begin before submission.

---

# 19. Demo Design Principle

The demo should feel like one continuous decision.

The judge should understand:

> Sales show demand.

> AI predicts where labour will be short.

> Bryntum makes the gap visible.

> FairShift finds the right available casual workers.

> The worker accepts.

> Their work produces transparent performance and earnings.

> The business approves base wage, incentive and tips.

> PayPal pays them.

The demo should not feel like a tour of software modules.

It should feel like one problem being solved from beginning to end.

---

# 20. Success Definition

FairShift succeeds at this hackathon if the submission proves:

### AI

AI materially changes a staffing decision.

### Design

Owner/delegated business user and worker experience form one coherent workflow.

### Innovation

Commerce intelligence connects demand, labour opportunity, performance and payment.

### Impact

The business fills real staffing gaps from its own casual pool with greater visibility and control while the worker receives clear opportunities, transparent earnings and fast digital payment.

### PayPal

PayPal is the actual payment endpoint of the operational workflow, not a decorative integration.

### Bryntum

Bryntum makes AI-driven staffing demand and actual workforce allocation visually understandable and actionable.

### Presentation

The entire journey can be understood and demonstrated reliably in less than three minutes.

---

# 21. Immediate Authorised Next Action

No further product redesign should occur.

The next work package must be:

## FS-HACK-GOLDEN-RECON-001

**Read-only repository reconciliation against this roadmap.**

Its output must classify each of the 15 golden-path steps:

**WORKING**\
**PARTIAL**\
**BROKEN**\
**ABSENT**

It must additionally identify:

- current Owner/Manager architecture;
- feasibility of the business-permission refinement without destabilising the build;
- current Bryntum implementation;
- current tip implementation;
- current performance attribution source;
- current commerce-data source;
- current PayPal Payouts status;
- current demo access;
- current page/performance blockers;
- minimum change set required to reach the complete golden path.

No architecture rewrite should be authorised before that reconciliation reports repository truth.

---

**FairShift • FS-HACK-ROADMAP-002 • v2.0 • 3 November 2026**

**Product rule:**\
**Protect the loop. Finish the loop. Demonstrate the loop.**