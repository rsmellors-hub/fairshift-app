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

> **Superseded in part, 7 November 2026, by the DEC-SA-012 exchange-rate decision below.** The fixed `<RATE>` bullet is replaced by the ECB reference-rate rule. The operating currency (ZAR), the Sandbox provider payout currency (USD), rounding the USD amount down to the cent, and freezing the rate, USD amount and rate source on the reservation are unchanged.

### Owner decisions, 7 November 2026

**Decision date:** 7 November 2026. **Status:** OWNER APPROVED (confirmed by Ryan). **Authorising source:** Owner-supplied work package **FS-HACK-SA-SUBMISSION-001, Day 4** ("Runtime proof, FX, first sandbox payout, AI-verified shift-pool tip release"), section OWNER DECISIONS. Recorded verbatim. Requirements only: this record implements nothing.

```text
DEC-SA-012 — Exchange rate
  Payouts convert ZAR to USD at the most recent ECB reference
  rate (USD/ZAR derived from EUR/ZAR ÷ EUR/USD). The rate is
  locked in when a payout is reserved and never re-converted.
  If no rate from the last 3 business days is available,
  payouts are blocked.

FS-TIP-DEC-002 — Tip policy (amends FS-TIP-DEC-001)
  The owner sets one policy per location before a period's
  tips are imported:
  - DIRECT: each tip row goes 100% to the staff member on that
    POS row; unattributed rows stay unallocated and visible.
  - SHIFT_POOL: the owner defines shift blocks per location
    (e.g. Morning / Afternoon / Evening). Each tip row is
    assigned to a block by its transaction time. Each block is
    its own pool, split as one equal share per person in that
    block. Members are casuals with a confirmed FairShift shift
    in the block (automatic) plus permanent staff on the
    owner's standing weekly block roster. Someone working two
    blocks takes a share in each.
  Split in cents; remainder distributed in fixed staff-ID
  order so totals reconcile exactly. Hours-based pooling stays
  excluded. Known limitation: a person leaving mid-block still
  receives a full share.
  Casuals: at DIRECT locations their tips stay on shift pay
  (FS-TIP-DEC-001 "allocated tips" line). In a SHIFT_POOL
  block their share comes through the pool and their
  shift-pay tip line is zero for that block. Every tip row is
  paid exactly once.

SUPERSESSION
  For permanent-staff tips, FS-TIP-DEC-002 and
  FS-TIP-AGENT-DEC-001 replace these parts of
  FS-TIP-POOL-DEC-001 and related rules: hours-proportional
  service-period pools and any recording of permanent-staff
  hours; manager approval of tip allocations; staff release
  requests and early-access elections; the 50% early-access
  cap (replaced by the owner's per-staff daily auto-release
  cap). Record this supersession next to the decisions.
  Update UI copy that says FairShift does not allocate tips.
  If any other approved tip rule conflicts, list it in the
  report instead of silently overriding it.

FS-TIP-AGENT-DEC-001 — AI tip release
  The AI checks tip evidence per allocation (per block for
  SHIFT_POOL) and returns release_tip_allocation or
  hold_tip_allocation with a reason code: UNATTRIBUTED_TIPS,
  INACTIVE_STAFF_ATTRIBUTION, TIP_OUTLIER, RECONCILIATION_GAP,
  DUPLICATE_ROWS, ROSTER_MISMATCH. Amounts are always computed
  deterministically; the AI never sets amounts or recipients.
  Released allocations pass existing settlement gates
  automatically within an owner-set auto-release cap per staff
  member per day. Holds go to the owner, who may release as
  calculated or keep held; nobody edits amounts or recipients.
  Managers have no role in the normal tip flow. Approver of
  record for tip payouts: the owner, basis = standing tip
  policy + AI decision ID.

FS-APPROVER-DEC-001 — Casual approver
  Automatic casual settlements keep the confirming (or
  hold-releasing) manager as approver of record; audit basis:
  manager confirmation at preauthorised fixed terms
  (DEC-SA-011).

DEMO VALUES
  - Auto-release cap: R1,500 per staff member per day.
  - Pick two Jacaranda locations: one DIRECT, one SHIFT_POOL;
    the rest DIRECT. Report which.
  - Shift blocks for the SHIFT_POOL location:
    Morning 07:00–12:00, Afternoon 12:00–17:00,
    Evening 17:00–23:00 (Africa/Johannesburg).
  - Seed a small permanent-staff block roster for that
    location (front and back of house), and at least one
    casual confirmed shift inside a pooled block.
```

**Additional Owner requirement (Ryan, 7 November 2026), for Checkpoint C6.** Supplied by the Owner during the same work package. Recorded verbatim:

```text
Every tip hold and every owner decision on it must be recorded
permanently: the AI reason code and summary, whether the owner
released it or kept it held, who decided, when, and a written
reason (required). These records are append-only — never
edited or deleted. Show the hold history on the staff member's
statement. Add a test proving the records are append-only and
that a reason is required.
```

**Supersession record (as instructed above).** For permanent-staff tips, FS-TIP-DEC-002 and FS-TIP-AGENT-DEC-001 replace, in the specification's section 1: FS-TIP-POOL-DEC-001's hours-proportional service-period pools; FS-TIP-ELIGIBILITY-DEC-001's open recording of permanent-staff hours; the Manager approval of tip allocations in FS-TIP-POOL-DEC-001 and FS-TIP-DEC-001 (C); the staff request and election mechanism and the 50% ceiling of FS-PAYOUT-TIMING-DEC-002 (replaced by the Owner's per-staff daily auto-release cap); and the employee-requested permanent-tip release in DEC-SA-011 and FS-HACK-SA-ROADMAP-001 section 2's supporting path, which becomes AI-checked automatic release. FS-TIP-POOL-DEC-002's exclusion of hours-based pooling is retained. Every other dated rule stands.

### Owner decision, 8 November 2026 — AI local intelligence

**Decision date:** 8 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** supplied by the Owner during the work package **FairShift — Day 5b: hosted deploy, USD plans, demo open (SANDBOX ONLY)** (within FS-HACK-SA-SUBMISSION-001), completing its STEP 1, which had left this text open. Recorded verbatim. Requirements only: this record implements nothing, and no code was changed for it.

```text
1. AI LOCAL INTELLIGENCE (Owner decision, Ryan, 8 Nov 2026)
   Principle: sources supply facts; the AI finds, cites and
   interprets them. The AI's job is to identify EVERY influence
   that could affect each location's demand, ability to trade,
   or customer/staff access — not to work through a fixed list.

   a) Live holiday feed: fetch SA public holidays from a public
      holidays API (e.g. Nager.Date; verify SA coverage) on a
      schedule and on start. sa-public-holidays.ts is fallback
      only, labelled as such. UK behaviour unchanged.

   b) Open-ended discovery: per demo location, for the coming
      7 days, the model (web search tool if available) looks for
      any influence on that location. Examples only, NOT a limit:
      official holidays; cultural and religious observances;
      commemorative and commercial days; payday/month-end; school
      calendar; sport; festivals, concerts and cultural events;
      news and political events; local service disruptions
      (water, power, municipal works); access disruptions (road
      closures, race routes, taxi strikes); extreme weather;
      anything else plausibly relevant to that neighbourhood.
      Input: owner-written location profile (area, venue type,
      typical customers) — add the field; seed labelled demo
      profiles for the 5 locations.
      Schema per signal: category (known category or OTHER with
      a short label); effect type (DEMAND | CAPACITY | ACCESS);
      name; date/time window; date certainty (fixed /
      moon-dependent / estimated / short-notice); location;
      shift blocks; roles (FOH/BOH); direction + size band
      (DEMAND) or severity (CAPACITY/ACCESS); confidence; source
      tier (OFFICIAL | EVENT_ORGANISER | NEWS | UNCONFIRMED);
      one-sentence operational reasoning tied to the location
      profile; source URL.
      Coverage log per run: the categories and searches the model
      considered, including those that found nothing — shown to
      the owner, so breadth is visible.
      Neutrality: for news/political signals, operational impact
      only — no commentary on causes, groups or people.

   c) Server validation: reject signals without a reachable
      source URL, outside the window or for unknown locations.
      UNCONFIRMED signals are shown, never applied. No fixed cap
      on signals found; rank by impact and apply at most the top
      signals per block (bounded), listing the rest.

   d) Labels everywhere: "Feed: <source>", "AI-found, source:
      <link>", "Owner-entered, source: <link>", plus the AI's
      reasoning sentence.

   e) Forecast effect: deterministic baseline; AI proposes
      bounded adjustments per block and role (fixed bands, no
      free numbers); server applies them and records the AI
      response ID.

   f) CAPACITY/ACCESS: high-severity CAPACITY creates an owner
      alert; if closure is likely, recommend early shift notice
      to affected casuals so short-notice cancellation is
      avoided (owner confirms; cancellation-pay rules unchanged).
      ACCESS adds a staff-attendance risk flag to affected blocks.

   g) Cadence and cost: disruptions/news every few hours, other
      influences daily, all within a daily call cap; bounded
      calls; no loops.

   h) Track record: after each day, record predicted direction vs
      the day's actual (synthetic) sales per signal; show an "AI
      signal track record", labelled as measured against
      synthetic history.

   i) If the web search tool is unavailable on the configured
      model, report BLOCKED for (b) and complete the rest with
      feed and Owner-entered signals.
```

**Precedence (Owner instruction, same day):** where this overlaps the later 8 November decisions recorded below, the later ones win: cadence 05:00/17:00 SAST with a 20-call daily cap for scheduled discovery (part g); staffing changes only when an Owner or a Manager accepts (part e); bands ±5/10%, at most two signals per hour (parts c and e).

### Owner decisions, 8 November 2026

**Decision date:** 8 November 2026. **Status:** OWNER APPROVED (confirmed by Ryan). **Authorising source:** Owner-supplied work package **FairShift — Day 5: record decisions, harden, deploy `submission` to hosted** (within FS-HACK-SA-SUBMISSION-001), STEP 1. Recorded verbatim. Requirements only: this record implements nothing.

```text
  - Staffing gate: the server applies accepted signal bands to the forecast. Staffing changes only when a manager accepts the adjusted forecast. UNCONFIRMED signals are shown, never applied.
  - Roles: FOH/BOH appears on each signal as a label only. Staffing is not split by role.
  - Bands: fixed ±5% or ±10% (existing scenario percentages), at most two signals per hour.
  - AI discovery cadence: one discovery call per location at ~05:00 and ~17:00 SAST (10/day for 5 locations). Daily cap stays 20 AI calls; Owner manual refresh counts toward it. One retry with backoff ONLY after HTTP 429 or a call that returned no response. Never retry a successful call. Weather, holiday and ECB feeds keep their own schedules and don't count toward the AI cap.
```

> **Amended, 8 November 2026 (Day 5b), by the staffing-gate decision in the next record.** Staffing now changes only when an Owner or a Manager accepts the adjusted forecast, and Owners have every Manager function. The new text addresses who may accept. It says nothing about the bullet's other two sentences (the server applies accepted signal bands; UNCONFIRMED signals are shown, never applied), which stand as recorded, as do the Roles, Bands and cadence bullets.

**Not recorded here.** Code committed earlier on `submission` (`7f5417e`, `70abe3f`, `6c97ca1`, `71a2448`) cites "Owner decision(s), 8 November 2026" for local intelligence, capacity and access disruptions, the early shift notice, the signal track record and source links on Owner-entered events. Apart from the four decisions above, no verbatim text of those decisions is in this repository, and this record does not supply it.

> **Since supplied, 8 November 2026 (Day 5b):** the Owner's AI local intelligence decision is now recorded verbatim in "Owner decision, 8 November 2026 — AI local intelligence" above, with the Owner's note that the later decisions in this record prevail where they overlap.

### Owner decision, 8 November 2026 — demo casual pay term

**Decision date:** 8 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** Owner-supplied work package **FS-SITE-COPY-SA-001**, step 2 ("If casual pay terms for the example aren't recorded, STOP and ask; do not invent"). No casual pay term was recorded, so the Owner was asked and chose the option below, recorded verbatim. It is a value for the fictional demo business and its public worked example, not a rate for any real employer.

```text
Approve R45.00/hour — Record R45.00/hour (the demo's seeded casual terms, above the R30.23 SA national minimum) as an Owner-approved demo value, cite it, and keep 6 h × R45.00 = R270.00.
```

### Owner decisions, 8 November 2026 — scope, currency, pricing, VAT, staffing gate (Day 5b)

**Decision date:** 8 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** Owner-supplied work package **FairShift — Day 5b: hosted deploy, USD plans, demo open (SANDBOX ONLY)** (within FS-HACK-SA-SUBMISSION-001), STEP 1. Recorded verbatim. Requirements only: this record implements nothing.

```text
  - Staffing gate (amends the 8 Nov entry): "Staffing changes only when an Owner or a Manager accepts the adjusted forecast. Owners have every Manager function, because many venues are run by a single owner who is operationally involved."
  - Scope: "Sandbox only for the hackathon. Production availability is roadmap."
  - Currency: "FairShift is universal: each business has a home currency used for every displayed amount. Workers and SA owners always see rand first; any USD amount is a secondary, labelled line. Payouts and billing use the home currency where PayPal supports it, otherwise USD (ZAR → USD at the locked ECB rate, DEC-SA-012)."
  - Pricing (demo): "Venue (1 location) R499/month, R4,990/year; Group (up to 5 locations) R1,149/month, R11,490/year; prices incl. 15% VAT. Flat per location, no per-worker fee. Workers are never charged. 30-day free trial unchanged. Billed by PayPal in USD: US$30.17 / US$301.73 and US$69.48 / US$694.76 (ECB 6 Nov 2026, 16.5382)."
  - VAT: "VAT is never applied to worker earnings or tips."
```

**Effect on earlier records.** The pricing decision replaces, for the demo, the GBP catalogue in the product specification's "Commercial entry and FairShift viability" table (Single Outlet £29/£290, Multi Outlet £69/£690). It resolves the pricing-currency question left open by FS-SITE-COPY-SA-001. Location limits (1, and up to 5), the 30-day free trial (FS-SUBSCRIPTION-TRIAL-DEC-001) and Enterprise by contact are unchanged. The USD billing amounts are the Owner's figures. They are not computed by FairShift at checkout.

**AI local intelligence.** The "AI LOCAL INTELLIGENCE (8 Nov)" text was not in the work package. The Owner supplied it later the same day, and it is recorded verbatim, with the Owner's precedence note, in "Owner decision, 8 November 2026 — AI local intelligence" above.

### Owner decisions, 9 November 2026 — location-driven rules, events feed, access, notifications, worker pool, profile, setup, pay queries (Day 6)

**Decision date:** 9 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** Owner-supplied work package **FairShift — Day 6: product-ready by Wed 11 Nov 20:00 SAST (product freeze). SANDBOX ONLY.** (within FS-HACK-SA-SUBMISSION-001), STEP 0. Recorded verbatim. Requirements only: this record implements nothing.

```text
- Location-driven, never hardcoded (R1), covering AI rules AND pay rules.
- Events feed: OpenWeb Ninja replaces Ticketmaster ("Events in <city>" from the location record, distance-filtered, passed to AI as candidate evidence).
- Access: "Public demo visitors are simulated: no live AI, payouts or notices. Judges get signed-in Owner, Manager and Worker accounts (credentials only in Devpost's private judging instructions) with live AI (no per-session limit, all calls counted and logged), live in-app early notice, and real PayPal Sandbox payouts; every action audited."
- Notifications: "Workers are notified of shift offers, bookings, cancellations, early notices, confirmed earnings at the end of a shift, Pay Agent holds, payout sent, paid, not paid with reason, and pay-query updates. Every notification is logged in an outbox; content follows the business's country/currency profile."
- Worker pool, worker profile, editable setup and pay queries as described in Step 3.
```

The rule R1 referred to above, as stated in the same work package:

```text
R1 Nothing hardcoded to SA or the demo. AI prompts, queries, schedules, wage floors, holiday/cancellation rules, VAT, currency, conversion, notification text and all rule copy come from the business's country/currency profile and each location's record. Demo values live in seed data only.
```

Step 3 of the same work package, referred to by the last decision:

```text
b) Worker pool: Owner or Manager invites a casual worker (name, email or phone, home location); worker accepts to join that location's pool; only pool members get offers; removal recorded, never deleted.
c) Worker profile: worker edits contact details, availability and PayPal payout destination. Destination change needs re-confirmation and never changes an already-reserved payout. Audited.
d) Editable setup: Owner edits trading hours, service capacity/minimum cover, regular coverage, pay terms, tip policy and location profile after onboarding. Changes are dated and apply from then on; accepted shift terms never change. Validation from the country rules (R1), e.g. pay below the country wage floor is blocked with the floor shown.
e) Pay queries (inside FairShift — PayPal Payouts has no recipient dispute process):
 - Worker: "Query this payment" on any shift/payout; reason (hours wrong, tips missing, not received, amount wrong) + note.
 - Routed to the Owner (approver of record); hours queries also visible to the confirming Manager.
 - Pay Agent checks the query against evidence (accepted terms, confirmed hours, tip records, PayPal item status) and returns a finding with reason; never sets amounts or recipients.
 - Owner resolves: explain (close with mandatory written reason), approve a separate correction payout (through Pay Agent + PayPal), or re-send to the confirmed destination if PayPal status is UNCLAIMED/RETURNED.
 - Every query, AI finding and Owner decision permanently recorded (who, when, reason) and shown on the worker's statement.
```

**Effect on earlier records.** The events-feed decision replaces Ticketmaster (FS-CONTEXT-SIGNALS-DEC-001, DEC-002) as the event listing source once implemented; until then the existing Ticketmaster code is unchanged. The access decision replaces, for public (unsigned) demo visitors, the live behaviour introduced by `6a6abf2`. Nothing else in earlier records is changed.

### Owner decisions, 9 November 2026 — suggested shifts, guaranteed-hours alert and offer rounds (Day 6, Step 1i)

**Decision date:** 9 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** answers given in the Day 6 session to the agent's questions for Step 1i, recorded verbatim. They supply the values FS-OFFER-ORDER-DEC-001 and FS-PATHWAY-DEC-001 left OPEN, for this business's settings; every value is an Owner-editable setting, not code.

```text
Shift length (demo business's locations): Min 4 h, max 8 h, prefer 6 h.
Guaranteed-hours threshold: Alert the Owner when a casual worker averages 20 hours a week or more over a 12-week reference period. Owner setting per business; FairShift only alerts, never makes a guaranteed-hours offer itself.
Offer window: First round (workers who want more hours, fewest hours left to threshold first): 2 hours, or until 12 hours before the shift starts if that's sooner. Then open to all eligible workers at that location until filled. Owner setting per location; window shown on every offer.
```

**Effect on earlier records.** Resolves, for this business, the values register conflict R-05 depended on (threshold, reference period, acceptance window). The pathway's Owner alert is the only action: no offer of regular hours, contract or eligibility decision is made by FairShift.

### Owner decision, 9 November 2026 — Pay Agent holds on casual pay (amends FS-APPROVER-DEC-001)

**Decision date:** 9 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** the Owner's message in the Day 6 session confirming Owner-only release of casual-pay holds. Recorded verbatim.

```text
When the Pay Agent holds a casual settlement, only the Owner can release or reject it; the Owner is then the approver of record, with the AI finding and the Owner's written reason stored. Settlements without a hold keep the confirming manager as approver of record.
```

**Effect on earlier records.** Amends FS-APPROVER-DEC-001 ("Automatic casual settlements keep the confirming (or hold-releasing) manager as approver of record") for held settlements only: a hold is released or rejected by the Owner, with a written reason either way. Unheld settlements are unchanged.

### Owner instruction, 10 November 2026 — wage floors, "Minimum wage not checked" and commission terms (Day 6, Step 3a)

**Decision date:** 10 November 2026. **Status:** OWNER INSTRUCTION (Ryan), given in the Day 6 session. Recorded verbatim.

```text
Step 3a: confirm the "no wage rule recorded for this country/date" case shows "Minimum wage not checked" and requires an audited Owner acknowledgement (as asked earlier), and that commission casual terms are refused.
```

**As implemented (not a further decision).**

- Pay below the wage floor of the location's country, for the shift's date, is refused when terms are written (hourly) and when a shift is created or offered, with the floor shown. South Africa's National Minimum Wage (R30.23 an hour, 1 March 2026 to 28 February 2027) is enforced alongside the England demo minimum.
- Where FairShift holds no wage rule for the location's country, or no verified rate for the shift's date, the status is "Minimum wage not checked". Shifts are created and offered there only after the Owner acknowledges that for the location, under Compensation. The acknowledgement is an append-only audit row (`WAGE_NOT_CHECKED_ACKNOWLEDGED`) with the Owner, the time, the country and the statement, and it lapses if the location's country changes. It never lets pay below a known floor through.
- Commission casual terms are refused when written, in every country, and commission shifts made earlier are refused when created or offered. Commission work already accepted keeps flowing to confirmation, with no payable until attribution is verified.

The agent could find no earlier record of the acknowledgement requirement in this session or the repository. It was implemented from this instruction.

### Day 6, Step 3b — PayPal payout destination changes (as implemented, not a further decision)

Implements the Day 6 instruction "PayPal email change requires re-confirmation, is audited, and never affects reserved payouts". Re-confirmation was not further specified, and the agent chose this reading:

- The first PayPal email is typed twice.
- Changing an existing one needs the new address typed twice and the worker's current FairShift password. Attempts are limited to five per 15 minutes.
- Every save writes an audit row (`PAYOUT_DESTINATION_ADDED` or `PAYOUT_DESTINATION_CHANGED`) with masked old and new addresses, never the full ones, and a count of the worker's reserved payouts that the save leaves unchanged.
- A payout keeps the recipient it was reserved with, including when an unsent payout is sent again. A new address applies only to payouts reserved after the change.

No email is sent to confirm the new address: no email provider was added.

### Owner decisions, 10 November 2026 — open Sandbox scope, imported and sample history, capped AI for any business

**Decision date:** 10 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** the Owner's answers in the Day 6 session to the three decisions raised by the from-scratch audit. Recorded verbatim.

```text
Answers to your three decisions (Ryan, 10 Nov 2026) — record verbatim and dated as Owner decisions:
1. Sandbox scope: YES. Every business on the hosted Sandbox deployment may use PayPal Sandbox subscriptions, the Pay Agent and payouts. Guardrails: per-business cap of 5 payouts and US$100 per day; an env switch that restores demo-only isolation instantly; the ECB rate becomes a shared system feed for all businesses (remove the demo-owner-only rate recording).
2. CSV history: YES, it counts toward the 28-day forecast rule, labelled "Imported by Owner (CSV, <date>)". Also add "Use sample history for my venue" (reuse the generator, scaled to the venue's capacity), labelled "Sample history (synthetic)", which also counts.
3. AI for any business: YES, capped. Discovery runs when a location's pin is confirmed, plus a manual "Refresh local signals" (max 3/day per location, max 3 locations per business), with an overall cap of 100 AI calls/day across non-demo businesses and a clear "daily AI limit reached" message. Demo business and judge accounts stay unlimited.
```

### Owner decision, 10 November 2026 — people, invitations and sign-up (corrects the same day's items 1–2)

**Decision date:** 10 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** the Owner's correction in the Day 6 session. Recorded verbatim.

```text
CORRECTION to items 1–2 (Ryan, 10 Nov 2026), record as Owner decision:
1. People & places: the Owner (or a Manager, for their own location's workers only) adds a person with: name, email (phone optional), role (Manager or casual worker) and the work location(s) they belong to. No home address is ever asked for. Adding creates the person in status "Invited — not yet signed up" and sends the official FairShift invite email automatically. The person is NOT active until they open the link, verify their email and complete sign-up themselves (set password, confirm name and contact details; workers also add availability and their PayPal email per Step 3b). Only active people can receive shift offers or manage a location. Owner can edit, resend the invite, revoke an unaccepted invite, and deactivate (never hard-delete; audited). Locations: full create/edit/deactivate by the Owner, audited.
2. Official FairShift invite email via the existing Resend setup: from "FairShift <no-reply@your domain>", subject "<Business> invited you to FairShift", saying who invited them, which location and role, with a sign-up link that expires in 7 days; branded HTML + plain text; logged in an outbox. Expired links can be resent. Public demo: outbox only.
```

**Boundary kept.** Casual workers stay bound to one location (the authorised product scope; cross-location casual scheduling remains OPEN). "Work location(s)" therefore means one location for a casual worker and one or more for a Manager.

### Owner decisions, 10 November 2026 — the approved screen design (docs/design/fairshift-screens)

**Decision date:** 10 November 2026. **Status:** OWNER APPROVED (Ryan). **Authorising source:** the Owner's design package instruction in the Day 6 session ("From here, an approved design is the source of truth"), and the Owner's answers to the two conflicts the screen map raised.

1. **The design is the source of truth** for screens, navigation and copy from 10 November 2026. Mockup values (business, people, dates, amounts) are demo persona data and are never hard-coded.
2. **Casual workers may belong to several locations.** Answer recorded verbatim: "Allow several locations". A casual worker may belong to more than one location of the same business, receive offers from each, and their hours count across all of them for the regular-hours alert. This supersedes the boundary recorded earlier the same day ("Casual workers stay bound to one location") and the specification's DEFERRED status for cross-location casual scheduling. "Remove from {location}" ends one membership and keeps all history.
3. **Invitation email subject.** Answer recorded verbatim: "Design subject, our domain". The subject is "You're invited to work shifts at <Business>", in the design's layout. The sender stays FairShift <no-reply@notify.getafairshift.com>, FairShift's verified domain. This supersedes the subject in the same day's people decision.
4. **Cancellation pay** (register R-03, FS-PAY-TERMS-DEC-001). Instruction recorded verbatim: "Cancellation pay (default 50% under 24 h, printed on every offer)". It is a per-location Owner setting: a percentage of the shift's expected base earnings, owed when the venue cancels an accepted shift within the short-notice window. The default is 50% within 24 hours. The setting is printed on every offer and is a separate line, never folded into the base rate. Holiday pay (R-02) remains unresolved and is not built.
