# FairShift Product and UX Specification

**Status:** Authoritative product and UX direction

**Scope:** FairShift customer product, worker experience, and bounded FairShift operator surface
**Implementation note:** The current manager and worker pages are functional scaffolding. They demonstrate working data and state transitions but are not the approved target experience.
**Historical baseline:** [`FS-HACK-MASTER-001.md`](FS-HACK-MASTER-001.md) is the Phase 0 Master Project Plan. Dated Owner decisions in this specification prevail where they apply.

## 1. Product thesis

FairShift connects a business's factual POS sales activity to workforce decisions and payment. It ingests and normalises sales, forecasts commercial and operational demand deterministically from that history, explains it with AI, helps managers offer the right shifts, measures performance against transparent incentives, and turns approved work into PayPal-powered payments.

The product closes an operational loop:

> POS / sales provider → FairShift sales ingestion and normalisation → canonical historical sales dataset → deterministic commercial and operational forecast → staffing requirement and Opportunity Demand → manager scheduling and Fill Shifts → worker shift acceptance → final shift allocation → work and performance evidence → deterministic earnings calculation → manager approval → PayPal payout → confirmation

The POS integration is the factual operational input to forecasting and staffing, not an optional reporting source. PayPal is central to worker payment. AI interprets the calculated figures for managers and does not set baseline demand. Human managers retain control of staffing and financial approval, while exact financial calculations remain deterministic.

**Square Sandbox** is FairShift's active commerce provider for the hackathon, with status **SANDBOX-CONNECTED** (section 18). It supplies commerce evidence for worker performance. Clearly labelled reference historical commerce remains the forecast source, because genuine Square history is insufficient for the 28-day threshold.

Zettle connector work is retained but **inactive for the hackathon Golden Path, and no new Zettle implementation is authorised before submission**. It was built against documented API and mocked provider behaviour, and a genuine merchant connection is not verified. FairShift must not describe Zettle as integrated.

### Canonical hackathon demonstration vertical

**Owner amendment, FS-WORKLOAD-INTELLIGENCE-001, 2 November 2026.** This replaces the earlier specialty-retail reference scenario, which remains historical evidence in `docs/REFERENCE_REFRESH_EVIDENCE.md`.

FairShift remains a cross-industry product for organisations with variable demand and flexible workforce requirements. The canonical PayPal AI Hackathon demonstration uses **one fictional five-location UK fast-casual café and dining group**. Hospitality is the reference vertical, not an architectural restriction. Brand names remain an open decision.

> commerce data → historical data → demand intelligence → staffing recommendation → Fill Shifts → worker opportunity → acceptance → allocation → performance → incentive → manager approval → PayPal payout → confirmation

Rules established by the amendment:

- The operational workload unit is the **transaction (bill)**, not revenue, covers or guest count. Commercial sales value is forecast alongside it and does not directly set the staffing requirement.
- Planning is time-aware. Calculations use real start and end times and overlap. Names such as "lunch" are display labels only.
- Required capacity is deterministic: the larger of minimum cover and transaction workload, less regular and allocated casual cover, per time window. Surplus in one window doesn't cancel a shortage in another.
- Service capacity and minimum cover are Owner policy. FairShift has **no default** for either. Missing configuration is unavailable, never zero.
- Reference history is synthetic and labelled so. It is never presented as genuine Square Sandbox evidence, and it contains no invented events, weather or bookings.
- AI doesn't determine baseline demand. FS-DEMAND-CONTEXT-001 lets it propose a bounded scenario (FS-DEMAND-CONTEXT-DEC-001, below); a Manager must accept one before it affects staffing.
- Worker matching, roles, attribution, incentives, approval and PayPal payout are unchanged.

**Opportunity Demand** means expected operational workload → required capacity → regular coverage → allocated casual coverage → remaining casual-work requirement, for one location and time window.

Not authorised: covers, reservations or booking integration, tables, menus, kitchen inventory, tip pooling, role-based forecasting, AI or performance worker matching, monitoring daemons, alerts and autonomous schedule changes.

Historical facts, deterministic forecasts, AI interpretation, manager decisions and outcomes must remain distinguishable.

**Owner decisions, FS-HOSPITALITY-POLICY-FREEZE-001, 2 November 2026.** These refine the amendment above. Evidence: [`HOSPITALITY_POLICY_FREEZE_EVIDENCE.md`](HOSPITALITY_POLICY_FREEZE_EVIDENCE.md).

- **Service model:** all five venues are all-day fast-casual cafe/dining. Customers order and pay at the counter or POS, drinks and simple items may be collected, prepared food may be delivered to tables, and operational staff clear and reset customer areas. This is not full table service. Differences in transaction value come from product mix, daypart, transaction composition and location behaviour.
- **Operational staff:** everyone on duty and actively contributing to venue service capacity, including preparation and support staff and a Manager while working operationally. It excludes off-site management, purely administrative time and non-operational company staff. The model is total operational capacity. No front-of-house, kitchen or role-specific demand forecasting is authorised, and shift role stays Manager-selected.
- **Reference capacity: 7 completed transactions per operational staff-hour** of sustainable busy service, as one organisation-level policy with no location overrides. That is about 8.6 labour minutes per transaction across the whole team, not one person's time on one bill. It is a **reference-company assumption**: not an industry standard, a legal requirement, a measured customer benchmark, or anything learned by AI or from the synthetic data.
- **Reference minimum cover: 2 operational staff** whenever open to customers. This is the fictional company's operating policy, not a universal legal requirement.
- **Transaction proxy:** transactions are the MVP workload proxy. FairShift does not claim that every transaction takes identical labour, or that transaction count captures covers, item complexity, kitchen bottlenecks or queue length.
- **Rota rulings:** Leeds' single-person regular periods are corrected to two people. Birmingham's Saturday/Sunday difference and Stratford's Saturday/Sunday and commuter pattern are justified reference characteristics.
- **Superseded by FS-TIP-DEC-001 below, retained as the record of the earlier direction. Earnings direction (authorised, NOT implemented):** the active hospitality path will use base earnings + variable tip earnings = total approved earnings. Targeted sales incentives are not its intended variable-earnings mechanism. The tip allocation method is OPEN. Generic incentive capability remains in the product, and the £200 target, £25 bonus and £121 payout remain truthful historical evidence.

**Golden Path anti-tuning rule.** The Golden Path example must be discovered from accepted product rules. Product rules, reference demand, capacity, regular coverage and forecast parameters must not be selected or altered to manufacture a preferred example. The historical 14:00–20:00, £96, £200, £25, £121 example is not a target for the hospitality workload model.

### Owner decision FS-TIP-DEC-001: hospitality earnings

**Status: APPROVED. Decision date: 2 November 2026. Implementation: NOT IMPLEMENTED.** FS-HOSPITALITY-EARNINGS-001 is not yet authorised (section 24).

The active hospitality reference path retains performance incentives. Total approved earnings are:

> GUARANTEED BASE EARNINGS + PERFORMANCE INCENTIVE + ALLOCATED TIPS = TOTAL APPROVED EARNINGS

**Supersession.** This decision explicitly supersedes the earlier hospitality shorthand "base + variable tips = total approved earnings" for the active Golden Path earnings model, including the statement that targeted sales incentives are not its intended variable-earnings mechanism. The corrected active formula is **BASE + PERFORMANCE INCENTIVE + ALLOCATED TIPS = TOTAL APPROVED EARNINGS**. The earlier direction stays visible in this section and in `HOSPITALITY_POLICY_FREEZE_EVIDENCE.md` as history.

The three components have distinct sources.

**A. Base earnings**

- Derived from accepted shift terms.
- Guaranteed according to the applicable accepted terms.

**B. Performance incentive**

- Retains the FairShift product thesis of measuring worker performance against transparent incentives.
- Calculated from the authorised incentive policy and verified performance inputs.
- Historical incentive architecture remains preserved.
- The historical £121 PayPal Sandbox payout remains truthful historical evidence and must not be rewritten.

**C. Allocated tips**

- Based only on genuine Square Sandbox card-tip evidence for the hackathon reference path.
- FairShift applies a deterministic written employer/company tipping-policy rule. The policy rule, not Square itself, creates entitlement.
- Square `team_member_id` is evidence/input only and must not automatically be represented as tip ownership.
- The Manager may approve or decline/hold the calculated payable but may not type or alter the calculated tip amount.
- Card-processing fees are not deducted from the allocated tip.
- Out of scope: cash tips, service charges, venue-wide tronc/tip pooling, and hours-based pooling.

**AI has no role in** tip amount, tip allocation, incentive arithmetic, earnings arithmetic, manager approval, or PayPal payout.

**Refund rule**

| When the refund or source change happens | Treatment |
| --- | --- |
| Before Manager approval | Recalculate or exclude the affected tip before approval. |
| After Manager approval | Preserve the approved payable. Do not introduce a payout hold or rewrite approved earnings. Record the later refund or change as an exception/audit/reconciliation event. |
| After PayPal initiation or completion | Preserve historical payout evidence. No automatic clawback. |

**Addendum, 2 November 2026 (FS-CONTEXT-SIGNALS-001). Documentation only, nothing implemented.**

Refunds and tips: any refund recorded before Manager approval removes the whole tip on that payment. Partial refunds are not apportioned. Refunds after approval follow the existing exception rule (recorded, no hold, no change to the payout).

Open for FS-HOSPITALITY-EARNINGS-001: Square Sandbox `tip_money` behaviour must be verified first, and the tip window must be the same window used for sales performance attribution.

**Claims firewall.** FairShift must not claim to be a UK payroll engine, a tax engine, a statutory tronc service, a complete time-and-attendance system, or legally compliant merely because a Sandbox payout occurred. The policy demonstrated by the fictional company must not be described as legally fair or UK-compliant unless separately verified.

### Owner decision FS-DEMAND-CONTEXT-DEC-001: bounded contextual-demand scenarios

**Status: APPROVED. Decision date: 2 November 2026. Implementation: IMPLEMENTED, and VERIFIED locally with a genuine model call. Not deployed.** Evidence: [`DEMAND_CONTEXT_EVIDENCE.md`](DEMAND_CONTEXT_EVIDENCE.md).

AI may select only from this closed set. Code, not AI, maps each scenario to its percentage:

| Scenario | Planning assumption |
| --- | --- |
| `NONE` | 0% |
| `MINOR_UP` | +5% |
| `MODERATE_UP` | +10% |
| `MINOR_DOWN` | −5% |
| `MODERATE_DOWN` | −10% |

These percentages are planning assumptions and versioned product policy (`fs-demand-context-policy-v1`). They are not learned effects, forecast accuracy, model-generated percentages, or claims about the measured impact of any event, weather or holiday. AI must never emit or control a free numeric demand adjustment.

Rules as implemented:

- **Baseline first.** The deterministic baseline stays canonical and visible. Before a Manager accepts, only the baseline drives staffing.
- **Target.** An accepted scenario scales expected transactions by planning block. Commercial sales, capacity, minimum cover and regular coverage aren't changed, and the frozen workload policy converts the result.
- **Signals.** Momentum (latest 28 days against the prior 28, calculated), Manager-entered context (labelled as such, never as verified), and UK bank holidays from a dated GOV.UK snapshot, where the location record states its nation. A missing signal means unknown, not normal. School holidays aren't implemented. Weather, events, bookings and promotions are added by FS-CONTEXT-SIGNALS-DEC-001, below.
- **Human control.** A Manager accepts or dismisses, and can withdraw a decision. A business owner acting on their selected location can do the same under the existing location scope, and the role is recorded.
- **Staleness.** A decision applies only while the demand baseline, signals and policy it was made on are unchanged. Otherwise the day returns to its baseline and says so. Regular cover and allocated shifts don't invalidate it, because the scenario is a view about demand.
- **Failure.** Any AI failure or rejected output falls back to the baseline. Forecast, staffing, Opportunity Demand and Fill Shifts carry on.

### Owner decision FS-CONTEXT-SIGNALS-DEC-001: sourced local context signals

**Status: APPROVED. Decision date: 2 November 2026. Implementation: IMPLEMENTED, and VERIFIED locally with genuine Open-Meteo, Ticketmaster and OpenAI responses. Not deployed.** Evidence: [`CONTEXT_SIGNALS_EVIDENCE.md`](CONTEXT_SIGNALS_EVIDENCE.md).

**Authority.** The package FS-CONTEXT-SIGNALS-001 names this as the dated amendment required by "D-W11". It explicitly supersedes FS-HACK-MASTER-001 §6.4, "External factors ... NOT AUTHORISED", **for the signal classes listed here only**. It also narrows the earlier "not authorised" line in this section: Manager-entered bookings and expected covers are allowed as contextual signals. Reservation-platform integrations stay not authorised, and covers stay outside the workload calculation, which still uses transactions.

**D-S1 Venue profile.** Each location may carry one venue profile from a closed set: `STADIUM_DISTRICT`, `WATERFRONT_OUTDOOR`, `BUSINESS_DISTRICT`, `STATION_COMMUTER`, `SHOPPING_CENTRE`. It is set by the Owner. No profile means unknown, never assumed. The reference company's five venues take the profiles already defined in `uk-hospitality.ts` (A–E), labelled reference configuration. The profile is passed to the AI as an enum, never as free text. It is product context for reasoning, not a coefficient: no code applies a weather or event effect by profile.

**D-S2 Authorised signal classes.** Existing, unchanged: `MOMENTUM`, `BANK_HOLIDAY`, `MANAGER_ENTERED`. New:

- `WEATHER_FORECAST`: fetched automatically per location from a public forecast provider.
- `BOOKINGS`: Manager-entered, structured.
- `LOCAL_EVENT`: Manager-entered, structured; optionally also provider-fetched (D-S4).
- `PROMOTION`: Manager-entered, structured.

Not authorised: school holidays, footfall feeds, reservation-platform integrations, social media, news, traffic.

**D-S3 Time-targeted scenarios.** A scenario may apply to the whole trading day, as now, or to one contiguous period within the day's trading hours, on planning-block boundaries. The percentages are unchanged: `NONE` 0, `MINOR_UP` +5, `MODERATE_UP` +10, `MINOR_DOWN` −5, `MODERATE_DOWN` −10. Code applies the fixed percentage only to expected transactions inside the chosen period.

**D-S4 Provider events (optional, key-gated).** If `TICKETMASTER_API_KEY` is configured, FairShift fetches events within 3 km of each location for the next seven days. 3 km is a product setting recorded here, not tuned against results. Without a key, provider events are unavailable, and Manager-entered events still work.

**Unchanged.** The frozen workload policy, coverage, reference commerce and forecast parameters. AI chooses a scenario and cites signals, code owns the arithmetic, and only a person's acceptance changes staffing. Measured or learned weather or event effects remain prohibited claims.

### Owner decision FS-CONTEXT-SIGNALS-DEC-002: event influence window, listing filter, weather bands

**Status: APPROVED. Decision date: 2 November 2026. Implementation: IMPLEMENTED, and VERIFIED locally. Not deployed.** It amends D-S3's overlap rule for events only. Evidence: [`CONTEXT_SIGNALS_EVIDENCE.md`](CONTEXT_SIGNALS_EVIDENCE.md).

**Event influence window.**

- An event's influence window runs from 2 hours before its start time to 1 hour after its end time. If no end time is given, it runs to 3 hours after the start time.
- A time-targeted scenario citing an event must overlap that event's influence window.
- The rule applies identically to Manager-entered and Ticketmaster events.
- An event with no start time can support only a whole-day scenario.
- Weather keeps the existing rule: the period must overlap the forecast hours the signal describes.
- Reason: pre-event and post-event trade happens outside the event's own hours. These durations are product settings chosen from that reasoning, not from resulting gaps, and must not be adjusted after seeing results.

**Listing filter (provider events).** A Ticketmaster listing is excluded from signals when any of these holds, and each exclusion is counted by reason in the evidence:

- its influence window does not overlap the venue's trading hours that day;
- it is a standing attraction or a multi-day or long-running listing rather than a dated event, by the provider's classification and date fields;
- it duplicates another listing at the same venue and start time (existing rule).

Listings are not filtered by event size, genre or name keywords chosen to shape results.

**Weather bands.** For the input fingerprint only, weather is compared in bands: precipitation probability in steps of 10 percentage points, precipitation amount in steps of 0.5 mm, temperature in steps of 2°C. The full-precision values are still stored and shown. A change within the same band does not make an accepted proposal stale, and a band change does.

### Owner decision FS-CONTEXT-SIGNALS-DEC-003: the word "one" in a contextual reason

**Status: APPROVED. Decision date: 3 November 2026. Implementation: IMPLEMENTED, and VERIFIED locally.** The contextual reason check removes the word "one" from its spelled-number list. Digits, percent signs and every other number word remain rejected. Evidence: [`CONTEXT_SIGNALS_EVIDENCE.md`](CONTEXT_SIGNALS_EVIDENCE.md).

## 2. Product principles

1. **Turn intelligence into action.** A forecast is useful when it helps a manager decide how many people are needed and proceed into staffing.
2. **Keep facts, predictions, decisions, and outcomes distinct.** Historical sales, forecasts, staffing recommendations, manager plans, shift allocations, performance results, and payments are separate records and must be presented as such.
3. **Keep managers in control.** AI recommends. Managers create shifts, choose invitees, finalise allocations, and approve payable amounts.
4. **Make work terms clear before acceptance.** A worker sees date, time, location, guaranteed or base pay, and any incentive opportunity before responding to an offer.
5. **Use deterministic financial rules.** Base pay, incentive eligibility, payable amounts, approval rules, and payout reconciliation are application logic, not AI output.
6. **Protect worker dignity and privacy.** Worker views are personal, practical, mobile-oriented, and free of rankings, surveillance-style analytics, customer data, and other workers' performance.
7. **Preserve provenance.** Seeded data, provider-derived facts, forecasts, and AI interpretations remain visibly distinguishable.
8. **Design for multiple locations without adding redundant controls.** Owners can move between consolidated and location views. A manager with one authorised location works in that context automatically.
9. **Explain recommendations.** Users should understand the inputs, uncertainty, operating assumption, and recommended action without reading technical diagnostics.
10. **Prefer a coherent core over feature breadth.** FairShift is not a general HRIS, payroll suite, recruitment system, CRM, or accounting platform.
11. **Keep the forecasting domain provider-adaptable.** POS-specific payloads are translated into canonical FairShift sales records before they enter forecasting, staffing, or reporting.
12. **Integrate for product value.** FairShift does not add integrations merely to maximise sponsor count. Each integration must strengthen competition compliance, the golden path, technological implementation, product usability, demo clarity, judging evidence, or credible sponsor-prize eligibility. Overall submission quality outranks sponsor accumulation.
13. **Fail safely and truthfully.** FairShift must not convert upstream uncertainty, invalid state, API failure, or a rejected operation into a false successful outcome. POS failure is not zero sales; forecast failure is not an invented forecast; a scheduling conflict is not a valid allocation; an unapproved incentive is not payable; PayPal failure is not `PAID`; and unknown payout status is not `SUCCESS`.

### POS sales ingestion architecture

The product architecture begins at the sales provider boundary:

> POS provider → provider adapter / ingestion layer → normalised FairShift sales records → forecasting and staffing engine

The exact adapter interface name is an implementation decision. The architectural contract is not: external provider payloads must be authenticated, validated, scoped, deduplicated where required, and translated into the canonical FairShift sales model before forecasting. Forecasting logic must not depend on provider-specific schemas, identifiers, or transport behavior. This boundary allows another POS provider to be supported later without redesigning the forecasting domain.

The sales data serves two distinct purposes:

1. **Location / business sales** power historical demand analysis, day/time patterns, forecasts, staffing recommendations, and owner/manager reporting. Verified location-level POS sales are sufficient for the core forecast and staffing workflow.
2. **Worker-attributed sales** support a worker's own aggregate performance and deterministic incentive progress or calculation. On Square Sandbox, FairShift maps `Payment.team_member_id` to a worker. The demonstrated payments explicitly supplied that value, so this does not show that a physical till or POS identifies the logged-in worker. No Zettle worker-attribution mechanism has been verified. Do not assume that a POS provider exposes reliable employee or cashier attribution, and do not fabricate it. Its absence must not block location-level POS sales ingestion or forecasting. Imported sales remain a labelled path where no provider attribution is connected; the import is closed at a Square-connected location.

Provider provenance remains attached to normalised records. Failed, partial, seeded, simulated, and provider-derived data must never be silently blended or promoted to a stronger evidence status.

## 3. User and role model

### Customer company Admin / Owner

The Admin / Owner configures the customer company and operates across its locations. The competition demonstration company has five outlets. The owner can see all five outlets individually and in a consolidated view, manage location and manager context, define authorised compensation and incentive policies, inspect sales and forecast evidence, understand next-week staffing implications, and monitor payments.

The Admin / Owner is a customer-company role. It is distinct from the FairShift SaaS operator described in section 8.

### Manager / Supervisor

A manager operates within one or more authorised locations. One-location managers enter their location implicitly. Multi-location managers receive a clear current-location control containing only authorised locations.

Managers translate operational intelligence into staffing decisions. They create shifts, choose eligible workers, send offers, review responses, finalise allocations, review performance and calculated amounts, approve payouts, and monitor payment state. Server-side location and financial-operation authorisation must support this UX; hiding controls is insufficient.

### Casual Worker

A casual worker belongs to exactly one home location in the MVP. The worker receives offers for that location, responds independently to each shift, manages availability and preferences, sees their own schedule, performance, incentive progress, earnings, and payment history, and maintains their profile and payout destination.

The worker experience is not an administrative analytics surface. Cross-location casual-worker scheduling is outside the MVP.

### Full-time or regular staff

Full-time or regular staff are lightweight records used for coverage and allocation. They may appear in staffing capacity and shift allocations but are not a fourth primary authenticated role in the current scope. Full-time employee accounts are deferred.

## 4. Information architecture

Navigation should expose real workflows rather than every underlying entity.

### Admin / Owner

- **Overview** — consolidated company state and priority actions
- **Locations** — location list, comparison, and drill-down
- **Forecast & Staffing** — next-week demand and staffing outlook
- **Reporting** — factual sales and operational analysis
- **Workforce** — managers, assignments, and high-level workforce context
- **Policies** — compensation and incentive policy configuration
- **Payments** — payable, processing, failed, and completed payments
- **Settings** — company and integration configuration

### Manager

- **Overview** — current-location operational state and actions
- **Forecast & Staffing** — next-week forecast and recommended capacity
- **Fill Shifts** — create shifts, select workers, and send offers
- **Shift Allocations** — past, current, and future staffed shifts
- **Worker Pool** — eligible location-bound casual workers and availability
- **Performance** — authorised location and worker performance
- **Payments & Approvals** — calculated amounts, approval, payout, and status

### Worker

- **Home** — next action, next shift, progress, and recent earnings state
- **Shifts** — offered and upcoming shifts, with per-shift response
- **Schedule** — accepted past, current, and future work
- **Performance** — own aggregate sales and incentive progress
- **Earnings** — own payable, pending, and paid amounts and history
- **Profile** — personal details, availability/preferences, and payment settings

On small screens, worker navigation should use a compact bottom navigation or similarly reachable mobile pattern. Manager and owner navigation may use a responsive side rail on wide screens and a compact drawer or menu on narrow screens.

## 5. Admin / Owner experience

The owner experience answers three questions in order:

1. How is the company performing across all locations?
2. What does next week look like, and where are staffing decisions required?
3. Which location, shift, worker, or payment needs attention?

The owner opens on a consolidated five-outlet overview, with factual performance and predictive output visually separated. The overview should surface exceptions and decisions, not force the owner to inspect every location. Selecting a location moves into a consistent location context with historical facts, forecast, staffing, allocations, performance, and payments.

Owner drill-down follows this hierarchy where authorised:

> Company → location → day or shift → allocated worker → approved payment record

Worker-level data must still be limited to legitimate operational need. Consolidated analysis should not become a worker leaderboard.

### Customer economic value

The Owner/Admin experience should eventually answer: **“What economic value is FairShift creating for the customer?”** Where supported by implemented data and methods, it may present forecast demand, recommended and scheduled labour, staffing variance, labour cost, labour cost as a percentage of sales, sales per labour hour, forecast accuracy, incentive spend, staffing adjustments, and clearly labelled estimated avoidable labour cost or similar implications.

Every value must be classified and presented as a **factual metric**, **calculated estimate**, or **AI/predictive output**. FairShift must not claim causal savings that its data cannot support. Any estimate requires an understandable methodology, assumptions, and scope. Exact economic calculations are a later implementation decision and are not defined by this specification amendment.

## 6. Manager experience

The manager experience makes the FairShift thesis visible as an operational sequence:

> What happened → what FairShift predicts → required staffing → manager decision → shift offers → accepted allocation → measured result → calculated incentive → approval → payment

The Overview is an action-oriented entry point for the current location. It should show the next staffing gap, offers awaiting responses, upcoming allocations, completed shifts requiring performance review, incentives awaiting approval, and payout exceptions.

Forecast & Staffing provides the evidence behind the recommendation. Fill Shifts begins a manager-controlled workflow rather than automatically publishing a roster. Worker Pool supports selection within deterministic eligibility boundaries. Shift Allocations is the authoritative view of who is working when. Performance and Payments & Approvals complete the operational loop.

The manager should always be able to distinguish:

- factual historical sales;
- deterministic forecast baseline and its range;
- AI interpretation;
- recommended staffing requirement;
- current or saved staffing decision;
- outstanding action.

## 7. Worker experience

The worker experience should feel like a focused work and earnings companion. It prioritises decisions and money that affect the worker now.

The Home hierarchy is:

1. greeting and home-location context;
2. next actionable offer or next accepted shift;
3. date, time, location, guaranteed/base pay, incentive opportunity, and status;
4. upcoming schedule;
5. current incentive or performance progress;
6. earnings summary: base, incentive, pending, and paid;
7. recent payment status.

Offer acceptance uses natural state language such as “Offer accepted” and a confirmation time. It must not expose implementation phrases such as “accepted · persisted.” Technical IDs, raw enum values, migration guidance, provider plumbing, and configuration status do not belong in normal worker flows.

Payout destination belongs under Profile → Payment settings. The Home or Earnings view may prompt a worker to complete missing payment details when this blocks payment, but should link to the setting rather than embed raw configuration into the shift card.

## 8. FairShift operator/admin boundary

The FairShift SaaS operator surface is separate from the customer company's Admin / Owner surface. It may eventually cover customer accounts, account state, plan or billing state, PayPal and integration health, and support operations.

This surface is bounded and deferred for the competition golden path. Full subscription, merchant billing, and plan infrastructure must not consume submission-critical implementation time. Customer-company administrators must never be confused with FairShift platform operators in product language, navigation, or permissions.

### Commercial entry and FairShift viability

FairShift's approved **B2B SaaS** catalogue is based on the organisation's active location footprint, not worker count:

| Plan | Monthly | Annual | Active locations |
| --- | --- | --- | --- |
| Single Outlet | GBP £29 | GBP £290 | Maximum 1 |
| Multi Outlet | GBP £69 | GBP £690 | Commercial tier for 2–5; maximum 5 |
| Enterprise | Custom/contact | Custom/contact | 6+; explicitly configured entitlement |

Annual pricing provides 12 months for the equivalent of 10 monthly payments. There are no approved trials, setup fees, per-worker fees or other charges. Enterprise has no self-service checkout. Upgrade, downgrade and proration workflows remain deferred.

Acquisition is email/password → mandatory verification → plan selection → PayPal Sandbox approval → authoritative server verification of ACTIVE → personal/business/workplace setup → operational access. Organisation-owned subscription entitlement and workplace completion are separate. Browser return and subscription creation responses do not grant entitlement. Each self-service selection maps to its own server-configured PayPal Plan ID; provider price/cadence must match this catalogue. Worker payouts remain separate.

The product and final presentation should make the relationship between **customer value created** and **FairShift cost** credible and understandable. This business case strengthens Potential Impact, Design, Presentation, and overall credibility, but it must remain evidence-based.

Commercial product entry is **JUDGING-VALUE**, with this target lifecycle:

> Discover FairShift → business setup → plan → PayPal commercial payment where technically appropriate → onboarding → connect commercial/POS data → FairShift operation

A lightweight genuine PayPal-powered commercial entry flow may be evaluated later against current official capability, Sandbox availability, implementation cost, demo reliability, judging value, and regression risk. Full production subscription infrastructure—including recurring billing, proration, tax, dunning, cancellation management, and production invoicing—remains **DEFERRED**. Worker payout and meaningful commercial intelligence remain higher priority than SaaS billing.

## 9. Weekly planning model

Weekly planning is the primary owner and manager planning frame.

FairShift calculates next-week staffing requirements for seven days per outlet, by time of day, and AI explains them. The owner can view all five outlets consolidated, compare individual outlets, then drill into one outlet and day. A manager sees the same next-week model for the current authorised location.

Each day communicates:

- expected transactions by time of day, with expected sales shown separately as commercial context;
- forecast range or uncertainty;
- historical evidence and provenance;
- existing full-time coverage;
- recommended total requirement;
- recommended casual requirement or surplus;
- whether a manager decision has been saved;
- the next relevant action.

Weekly totals may aid orientation but must not obscure daily timing and capacity. Individual shifts remain the unit for terms, offers, responses, allocation, performance, incentive, and payment.

## 10. Golden-path UX

### Target golden path

The strongest intended demonstration is one connected hospitality story (section 1). Its current hackathon architecture is:

> Reference historical commerce → deterministic demand model → OpenAI bounded interpretation → staffing requirement → worker opportunity → Bryntum allocation → genuine Square Sandbox team-member-attributed commerce → FairShift performance/incentive → manager approval → genuine PayPal Sandbox payout → worker confirmation

Provider responsibilities:

- **Square:** commerce evidence.
- **OpenAI:** bounded interpretation and explanation.
- **Bryntum:** manager allocation surface.
- **FairShift:** business logic, worker and shift identity, compensation, incentive, attribution eligibility, and approval.
- **PayPal:** FairShift subscription infrastructure and worker payout.

The story runs:

1. **Reference historical commerce is the planning input.** It is clearly labelled as reference data. Square history replaces it for a location only if it meets the same 28-day threshold; no Square history is manufactured.
2. **FairShift normalises sales.** A provider adapter converts authenticated provider data into canonical, location-scoped FairShift sales records with provenance.
3. **Historical demand becomes visible.** Owners and managers see factual sales history separately from predictions.
4. **FairShift forecasts next-week demand deterministically.** The manager sees expected transactions by time, expected sales as separate context, uncertainty and comparable history. AI explains these figures and does not set them. Contextual AI (FS-DEMAND-CONTEXT-001) is authorised direction, not implemented.
5. **FairShift identifies Opportunity Demand.** Expected transactions become a required capacity under the business's own policy, regular and allocated casual coverage are applied, and the remaining casual requirement is made explicit by time window.
6. **Manager reviews the recommendation.** The manager remains responsible for the staffing decision.
7. **Manager creates and publishes a shift.** Date, time, casual requirement, offered compensation, and incentive terms are explicit and policy-valid.
8. **Worker receives and accepts the shift.** The worker sees the complete economic terms and responds to the individual offer.
9. **The final allocation is established.** Accepted casual workers and lightweight regular-staff coverage form the shift allocation.
10. **Genuine Square Sandbox sales become performance.** Eligible sales attributed through a mapped team member during the accepted shift form the worker's result, which the manager confirms after the shift.
11. **Incentive is calculated.** Deterministic policy determines whether and how much was earned.
12. **Manager approves the payable amount.** Base wage plus incentive is shown clearly; approval is an explicit human action.
13. **FairShift initiates a PayPal Sandbox payout.** Provider identifiers and status are persisted with idempotent submission protection.
14. **Worker sees payment confirmation.** FairShift reconciles provider status and presents the confirmed result in natural language.

### Current verified golden path

The Square Sandbox journey is verified locally from allocation to worker payment confirmation ([`SQUARE_LIVE_EVIDENCE.md`](SQUARE_LIVE_EVIDENCE.md), [`PAYPAL_FINAL_EVIDENCE.md`](PAYPAL_FINAL_EVIDENCE.md)):

> labelled reference history drives the forecast → manager offer → worker acceptance → allocation → genuine Square Sandbox payments carrying `team_member_id` → mapped worker performance → deterministic incentive → manager approval of £96 base + £25 bonus = £121 → genuine PayPal Sandbox payout of GBP 121.00 → item `SUCCESS` → persisted `PAID` → worker confirmation

**Context signals, FS-CONTEXT-SIGNALS-001:** weather, listed events and structured Manager signals, with time-targeted scenarios, are verified locally through to Fill Shifts ([`CONTEXT_SIGNALS_EVIDENCE.md`](CONTEXT_SIGNALS_EVIDENCE.md)). The one genuine answer cited a Manager-entered event, not a provider signal.

**Limits of that run:** it used a short real shift on the same terms, not the 14:00–20:00 window. The 14:00–20:00 rehearsal has not been run, and the path is not deployed.

**Contextual demand, FS-DEMAND-CONTEXT-001:** verified locally with a genuine OpenAI call on labelled reference history and a Manager-entered note, through to Fill Shifts ([`DEMAND_CONTEXT_EVIDENCE.md`](DEMAND_CONTEXT_EVIDENCE.md)). That run stopped at shift creation. It is not part of the Square and PayPal run above, the chain has not been run end to end in one sitting, and it is not deployed.

PayPal payout status is **SANDBOX-CONNECTED**. An earlier controlled path, on seeded sales with a $650 target and $25 incentive in integer cents, reached a persisted `PAID`. It does not prove Square ingestion. Neither target is the permanent universal incentive policy.

### Golden Path economics

**Historical evidence, not the hospitality target (section 1).** The table below records the proven retail-era example. It is not a staffing window to recreate, and the active hospitality earnings model is base + performance incentive + allocated tips (FS-TIP-DEC-001, section 1), which is not yet implemented.

| Term | Intended demonstration value |
| --- | --- |
| Shift | 14:00–20:00 |
| Duration | 6 hours |
| Base pay | £96 |
| Sales target | £200 |
| Fixed incentive | £25 |
| Payable if target reached | £121 |

- **Base pay basis:** £96 is the shift's base pay on daily terms, which pay a fixed amount regardless of the shift's length. Do not describe it as £12 × 8 hours. An hourly £12 policy would pay £72 for this shift, so it is not the policy for this example.
- **Rehearsal window:** the final Golden rehearsal uses a fresh shift window that excludes old Square Sandbox gate transactions. Do not distort compensation terms to avoid historical Sandbox payments.
- **Timing:** sales count only inside the accepted window, and work can be confirmed only after the shift has ended and Square has been checked again. A genuine 14:00–20:00 rehearsal therefore finishes after 20:00.

### MVP refund decision

Square refunds are retained and linked as audit evidence but do not automatically reduce worker performance or earned incentives.

For the hackathon MVP:

- eligible `COMPLETED` Square sales attributed during the accepted shift count toward performance, so a fully refunded sale still counts;
- refund evidence remains visible and auditable;
- refund team-member identity is not treated as proof of worker responsibility;
- once performance results are confirmed, the performance snapshot is immutable;
- once a payable is approved, later refunds do not silently rewrite approved worker earnings.

More sophisticated net-sales and refund incentive policy is deferred (section 21). This decision covers performance and incentives. The refund treatment of allocated tips is set by FS-TIP-DEC-001 (section 1).

The final demonstration narrative should also visibly demonstrate at least one scheduling or eligibility control, the approval-before-payment gate, and duplicate PayPal payout protection. These controls should support the story rather than turn the presentation into a test-suite walkthrough.

## 11. Key screen specifications

### Admin / Owner: Company Overview

- **Purpose:** Summarise the operating state of all five locations and identify decisions or exceptions.
- **Primary user question:** “Where does the business need my attention?”
- **Key information:** consolidated factual sales, location comparison, next-week demand and staffing summary, open staffing gaps, payment exceptions, and data provenance.
- **Primary actions:** open a location, open Forecast & Staffing, inspect a material exception, or review payments.
- **State and feedback:** data freshness, loading, unavailable integration, seeded/demo provenance, and empty states must be explicit.
- **Data restrictions:** organisation-scoped; worker detail appears only after an authorised drill-down and only to operationally necessary depth.
- **Golden-path relationship:** establishes the company-wide factual baseline and routes the owner to next-week staffing decisions.

### Admin / Owner: Multi-location Forecast & Staffing

- **Purpose:** Compare next-week demand and staffing implications across five outlets.
- **Primary user question:** “Which locations and days are likely under- or over-covered?”
- **Key information:** seven-day forecast per outlet, range, evidence quality, full-time coverage, recommended casual need, saved decision state, and provenance.
- **Primary actions:** filter or compare locations, choose a location/day, inspect evidence, and proceed to the appropriate manager workflow.
- **State and feedback:** factual history and prediction use distinct visual treatment; sparse or missing evidence is clearly disclosed.
- **Data restrictions:** organisation-wide for owners; no unnecessary individual-worker details.
- **Golden-path relationship:** translates company history into prioritised staffing work.

### Admin / Owner: Location Drill-down

- **Purpose:** Explain one outlet's performance, forecast, workforce plan, and payments in context.
- **Primary user question:** “What is happening at this outlet, and what is being done about it?”
- **Key information:** factual trend, forecast, staffing recommendations, current allocations, relevant performance, approvals, and payment exceptions.
- **Primary actions:** change time frame, open a day or shift, inspect manager actions, and review authorised worker/payment detail.
- **State and feedback:** active location and selected period remain unambiguous.
- **Data restrictions:** location-scoped within the organisation; customer and transaction detail is minimised.
- **Golden-path relationship:** connects the portfolio signal to individual operational records.

### Admin / Owner: Reporting / Analytics

- **Purpose:** Analyse dense factual and predictive operational data across locations and time.
- **Primary user question:** “What patterns and outcomes can I compare?”
- **Key information:** historical sales, forecasts versus outcomes, staffing recommendations versus decisions, allocation outcomes, and payment summaries.
- **Primary actions:** filter, group, sort, compare, export where later authorised, and drill into a location or shift.
- **State and feedback:** source, time zone, currency, freshness, and whether a value is factual or predicted accompany the data.
- **Data restrictions:** organisation-scoped; avoid worker ranking and customer-level detail.
- **Golden-path relationship:** supplies evidence about how the operating loop performs over time.

### Manager: Overview

- **Purpose:** Present the current location's work queue and near-term operating picture.
- **Primary user question:** “What do I need to decide or complete next?”
- **Key information:** next staffing gap, open offers, upcoming shifts, allocation exceptions, completed shifts awaiting results, incentives awaiting approval, and payment status exceptions.
- **Primary actions:** Fill Shifts, review offers, open an allocation, record or review performance, and approve eligible payment.
- **State and feedback:** success, pending, blocking, and exception states use natural language and clear next actions.
- **Data restrictions:** only authorised location data; no arbitrary location identifier from the client is trusted.
- **Golden-path relationship:** is the manager's control centre for progressing the loop.

### Manager: Forecast & Staffing

- **Purpose:** Explain next-week demand and turn it into a manager-controlled staffing decision.
- **Primary user question:** “When is more cover needed, why, and what should I do?”
- **Key information:** historical evidence, expected transactions by time, expected sales as context, range, data quality, required capacity, regular coverage, casual requirement, key drivers, AI interpretation, and saved decision state.
- **Primary actions:** inspect a day, adjust or accept a staffing decision, and continue to Fill Shifts.
- **State and feedback:** history, deterministic result, AI interpretation, and manager decision have distinct labels; unavailable AI does not remove the deterministic baseline.
- **Data restrictions:** current authorised location; no worker ranking.
- **Golden-path relationship:** bridges intelligence and shift creation.

### Manager: Fill Shifts

- **Purpose:** Create shift terms and invite eligible location-bound workers.
- **Primary user question:** “What shift must I fill, and whom should I invite?”
- **Key information:** date, start/end time, casual requirement, pay/rate within policy, relevant staffing context, and eligible Worker Pool.
- **Primary actions:** create or edit a draft shift, select invitees, review terms, and send offers.
- **State and feedback:** policy validation, unavailable workers, overlap conflicts, sent offers, and per-worker response state are visible. The unresolved over-invitation rule must not be assumed.
- **Data restrictions:** workers from the manager's authorised location only; preference or suitability explanations reveal no sensitive personal reason.
- **Golden-path relationship:** converts an approved staffing decision into explicit offers.

### Manager: Worker Pool

- **Purpose:** Support transparent selection from the location's casual workforce.
- **Primary user question:** “Who is eligible and available for this shift?”
- **Key information:** worker identity, relevant role capability if later approved, availability, deterministic conflicts, preferences, current invitation state, and concise recommendation reasons.
- **Primary actions:** filter eligible workers, inspect availability, select invitees, and open an authorised worker record.
- **State and feedback:** hard exclusions are explicit; any recommendation distinguishes eligibility from soft matching.
- **Data restrictions:** location-bound; no employment leaderboard, opaque fairness score, or unnecessary personal explanation.
- **Golden-path relationship:** supports the human invitation decision.

### Manager: Shift Allocations

- **Purpose:** Show past, current, and future allocations as the authoritative staffing schedule.
- **Primary user question:** “Who is allocated to each shift, and where are the gaps or conflicts?”
- **Key information:** shift time, role, required capacity, regular staff coverage, accepted casual workers, unfilled capacity, and shift state.
- **Primary actions:** switch past/current/future, open a full shift record, review responses, and maintain an allocation within approved rules.
- **State and feedback:** accepted offers and final allocation are distinguishable; conflicts and gaps are prominent.
- **Data restrictions:** authorised locations and operationally relevant worker information only.
- **Golden-path relationship:** records the staffing outcome before work occurs.

### Manager: Performance

- **Purpose:** Review authorised store and worker-attributed aggregate results after work.
- **Primary user question:** “What verified result applies to this shift and incentive?”
- **Key information:** completed shift, factual store result, permitted worker-attributed sales count/value, incentive threshold, provenance, and verification status.
- **Primary actions:** record or confirm an authorised result, inspect calculation evidence, and proceed to payment review.
- **State and feedback:** unverified attribution and missing results cannot be presented as factual evidence.
- **Data restrictions:** authorised location; customer and transaction-level detail is excluded unless separately justified.
- **Golden-path relationship:** supplies the factual input to deterministic incentive calculation.

### Manager: Payments & Approvals

- **Purpose:** Review final payable amounts, approve them, and monitor PayPal state.
- **Primary user question:** “Is this amount correct and ready to approve, and what happened after submission?”
- **Key information:** worker, shift, accepted base terms, deterministic incentive result, final payable amount, approval state, payout destination readiness, PayPal status, and exception reason.
- **Primary actions:** approve, initiate eligible payout, refresh or reconcile status, and inspect history.
- **State and feedback:** calculated, awaiting approval, approved, submitted, processing, paid, and failed states use clear wording. Duplicate submission is prevented and uncertain failures are not disguised as success.
- **Data restrictions:** authorised managers only; credentials, access tokens, unnecessary recipient data, and raw provider payloads are never shown.
- **Golden-path relationship:** completes human approval and PayPal payment.

### Worker: Home

- **Purpose:** Give the worker a fast, personal summary of the next decision, next work, and money state.
- **Primary user question:** “What do I need to do, when am I working, and what am I earning?”
- **Key information:** next offer or accepted shift, economic terms, upcoming schedule, current incentive progress, earnings summary, and latest payment status.
- **Primary actions:** review an offer, accept or decline, open schedule, view earnings, or complete a blocking profile setting.
- **State and feedback:** friendly confirmations, useful empty states, and one dominant next action; no raw enums or persistence language.
- **Data restrictions:** worker's own records and home-location context only.
- **Golden-path relationship:** brings the offer, work, incentive, and payment loop into one personal view.

### Worker: Shift Offers

- **Purpose:** Let the worker understand and respond to each offered shift.
- **Primary user question:** “What are the terms, and do I want this shift?”
- **Key information:** date, start/end, location, role, guaranteed/base pay, incentive opportunity and terms, response deadline if later defined, and offer state.
- **Primary actions:** accept or decline each shift independently and view full terms.
- **State and feedback:** response confirmation, changed or unavailable offer, conflict, and closed state are clear. Grouped invitations retain per-shift responses.
- **Data restrictions:** only offers addressed to the authenticated worker.
- **Golden-path relationship:** creates the worker-controlled acceptance state used by allocation.

### Worker: Schedule

- **Purpose:** Show the worker's accepted past, current, and upcoming work.
- **Primary user question:** “When and where am I working?”
- **Key information:** date, time, location, role, status, agreed terms, and relevant completion/payment link.
- **Primary actions:** open a shift and move between upcoming and past work.
- **State and feedback:** cancellations or changes require explicit, approved rules before implementation.
- **Data restrictions:** the worker's own allocations only.
- **Golden-path relationship:** confirms the allocation created from accepted offers.

### Worker: Performance and Incentive Progress

- **Purpose:** Explain the worker's own permitted aggregate result and incentive progress.
- **Primary user question:** “What progress applies to me, and how is my incentive determined?”
- **Key information:** own attributed sales count, own attributed total sales value, target, progress, deterministic result, and provenance or verification state.
- **Primary actions:** open the related shift or incentive terms.
- **State and feedback:** clearly distinguish in progress, target met, target not met, awaiting final result, and attribution unavailable.
- **Data restrictions:** no transaction/customer/product detail, store-wide revenue, other workers' data, rankings, or leaderboards.
- **Golden-path relationship:** makes the incentive result transparent without exposing inappropriate data.

### Worker: Earnings and Payment History

- **Purpose:** Show what the worker has earned and whether payment has completed.
- **Primary user question:** “How much is due or paid, and what is its status?”
- **Key information:** base pay, incentive, final approved amount, pending total, paid total, payment date, and natural-language status history.
- **Primary actions:** open a payment record, navigate to payment settings when required, and eventually raise a dispute once rules exist.
- **State and feedback:** awaiting approval, approved, processing, paid, and failed states include appropriate next steps without exposing provider plumbing.
- **Data restrictions:** the worker's own amounts and minimal payment reference only.
- **Golden-path relationship:** is the worker-facing proof of completion.

### Worker: Profile, Availability, and Payment Settings

- **Purpose:** Maintain worker-owned operational preferences and payment destination.
- **Primary user question:** “Are my availability, preferences, and payment details correct?”
- **Key information:** profile details, home location, availability windows, approved preferences, and masked payment destination status.
- **Primary actions:** update profile, availability/preferences, and PayPal payout destination.
- **State and feedback:** save confirmation and blocking validation are clear; secrets or credentials are never requested.
- **Data restrictions:** worker-owned data only; collect operational constraints rather than personal explanations.
- **Golden-path relationship:** provides eligibility input and the destination required after approval.

## 12. Navigation model

Role-specific shells prevent owner, manager, and worker responsibilities from blending together. A user sees only navigation authorised for their role.

Owner and manager views maintain persistent organisation/location context. A one-location manager does not see a redundant selector. A multi-location manager can change only among authorised locations. Drill-down pages preserve a clear route back to the relevant weekly or allocation context.

Cross-role links such as “Go to manager view” from the worker product should not exist in the target experience. Demonstration tooling, if retained, belongs behind a development/demo control separate from normal navigation.

## 13. Responsive and mobile expectations

The worker product is mobile-first:

- one primary task per view;
- thumb-reachable actions;
- concise cards and progressive disclosure;
- readable date, time, location, and money without horizontal scrolling;
- clear touch targets and accessible status text in addition to colour;
- offer acceptance and payment checks usable on a small phone;
- no dense administrative tables.

Manager and owner experiences are responsive desktop-first operational tools. Weekly planning and allocation views may use more horizontal space, but must retain a usable narrow-screen summary and drill-down. Dense grids should collapse to prioritised summaries or cards rather than compressing every column.

All surfaces require keyboard navigation, semantic headings, clear focus, meaningful loading/error states, adequate contrast, locale-aware dates, explicit time zone context where ambiguity is possible, and exact currency display.

## 14. Data visibility rules

| Data | Admin / Owner | Manager | Casual Worker |
| --- | --- | --- | --- |
| Consolidated company sales | Yes | No, unless separately authorised | No |
| Location sales | All company locations | Assigned locations only | No |
| Forecast and staffing | All locations and consolidated | Assigned/current locations | No |
| Worker Pool | Authorised operational drill-down | Current assigned location | No |
| Worker performance | Authorised aggregate drill-down | Relevant assigned-location workers | Own permitted aggregates only |
| Customer/transaction detail | Minimise; separate authorisation required | Minimise; separate authorisation required | Never |
| Other workers' earnings | Only if operationally authorised | Only where approval requires it | Never |
| Payment record | Organisation-authorised | Assigned-location approval scope | Own records only |
| Credentials and access tokens | Never | Never | Never |

All scoping is enforced server-side. Demo scope pinned on the server is acceptable for a clearly labelled demonstration but is not a replacement for production authorisation.

## 15. AI presentation rules

AI is operational intelligence, not decoration.

- Show the historical factual inputs and provenance that support the forecast.
- Label predictions as forecasts and present a range or uncertainty indicator.
- State the staffing policy or capacity assumption that translates demand into worker need.
- Separate the deterministic forecast/staffing baseline from AI interpretation where both exist.
- Present key drivers and a practical manager action in plain language.
- Keep the saved manager decision visible alongside the recommendation.
- Allow manager review and override; AI never publishes shifts or selects workers autonomously.
- Do not present generic “AI scores” without an operational meaning.
- Do not infer unsupported weather, event, promotion, availability, or performance facts.
- Do not use AI to calculate wages, incentives, payable amounts, or payout eligibility.
- If AI is unavailable, retain the deterministic baseline and say that the interpretation is unavailable.

## 16. Failure safety and negative-path demonstrability

Failure-safe behavior is part of the FairShift product contract and the submission evidence. Every submission-critical golden-path stage should define, where relevant:

- its success state;
- its failure or invalid state;
- understandable user-visible feedback;
- the persistence consequence;
- the downstream consequence;
- a safe recovery or retry path where appropriate;
- an automated negative test where practical;
- whether the control is valuable to demonstrate to judges.

When a critical operation fails, FairShift should preserve valid prior state where appropriate, block unsafe downstream action, explain what the user can do next, and retain enough operational evidence for diagnosis. This does not require production-scale observability infrastructure for the hackathon. Critical negative tests are a submission requirement rather than optional post-hackathon QA, but testing remains proportional to the golden path and judging value.

### Priority failure and control scenarios

| Stage / scenario | Required safe behavior | User-visible and downstream consequence | Verification and demo priority |
| --- | --- | --- | --- |
| **POS unavailable, rejected request, malformed payload, or invalid sales data** | Do not fabricate sales or interpret the failure as genuine zero demand. Preserve valid historical state and provenance where appropriate. | Show unavailable or stale input distinctly from factual zero sales; block unsupported refresh results from silently changing the forecast. Provide a safe retry when appropriate. | Add adapter/ingestion negative tests when implemented. High engineering priority; judge demo only if it communicates provenance better than the preferred controls below. |
| **Insufficient, invalid, or unavailable forecast input; forecast/AI failure** | Do not fabricate an AI forecast or unsupported prediction. Validate structured input and output. | Show an unavailable or degraded forecast/AI state. Do not turn unsupported prediction into staffing fact. Preserve a valid deterministic baseline when only the optional AI interpretation fails. | Automated invalid, sparse, unavailable, and malformed-output tests where applicable. Potential demo fallback, not a required judge-visible example. |
| **Manager disagrees with AI staffing recommendation** | AI remains advisory. Allow an authorised override where product rules permit, without altering the original recommendation. | Show both the AI/deterministic recommendation and the manager's operational decision, including that the manager remains accountable. | Test persistence and distinction when override behavior is implemented. Useful positive-control moment in the main demo. |
| **Invalid shift time, staffing requirement, pay/rate, or deterministic state** | Reject invalid shift creation before publication or invitation. | Show actionable field-level or workflow feedback; create no valid allocation from invalid terms. | Automated validation tests. |
| **Worker unavailable for proposed shift** | Exclude or mark the worker ineligible under deterministic availability rules. | Give the manager a concise exclusion reason; do not treat the worker as available. | Automated eligibility test. Preferred judge-visible scheduling-control example. |
| **Overlapping accepted allocation** | Detect the overlap deterministically and prevent the invalid allocation. | Explain the conflict to the manager without exposing unnecessary personal data. Preserve the existing valid allocation. | Automated conflict test. Preferred judge-visible scheduling-control example. |
| **Worker declines an offer** | Persist the decline and do not allocate that worker to the shift. | Worker sees confirmation; manager sees the accurate response and remaining gap or next action. | Automated offer/allocation test where implemented. |
| **Current demo performance target not achieved** | Under the implemented demo rule, calculate no earned incentive. | Show that the target was not met and that no incentive was earned; do not imply that the demo formula is universal policy. | Automated exact-boundary and below-target tests. |
| **Incentive earned but manager has not approved it** | Enforce the approval gate; payout is ineligible. | Show “Awaiting approval” and prevent payout initiation. | Automated payout-eligibility test. Preferred judge-visible approval-control example. |
| **Missing or invalid payout destination** | Reject payout submission before a provider request. | Tell the worker or manager that payment details must be completed, with a link to the appropriate setting. | Automated eligibility/validation test. |
| **PayPal rejects or fails a payout operation** | Never mark the payout `PAID`. Persist or represent an accurate failed or unresolved state and preserve idempotency. | Show processing, unresolved, or needs-attention language with a safe recovery route; never show false confirmation or raw provider payloads. | Mocked/API-boundary failure tests are required; Sandbox evidence should be added only when actually executed. High engineering priority. |
| **Duplicate payout after the payable item was submitted or paid** | Block the duplicate before another PayPal payout request. | Show that payment was already submitted or completed and direct the user to its status rather than offering another payment action. | **VERIFIED** against the current Sandbox-connected implementation. Preferred judge-visible payment-integrity example. |
| **PayPal status pending, unresolved, changed, or refreshed** | Reconcile against actual PayPal state; initiation alone never implies `SUCCESS`. | Show pending/processing until provider evidence supports paid; update persisted identifiers and status accurately. | Automated reconciliation tests plus existing Sandbox status-refresh evidence. |
| **Worker requests another worker's or unauthorised location/business data** | Deny access through server-side authorisation once authentication/authorisation is implemented. | Show a safe access-denied state without leaking the protected record. | **NOT VERIFIED** while RBAC/authentication remains deferred. Future security tests are required; do not claim current protection. |

### Judge-visible negative demonstrations

The final hackathon presentation should deliberately show approximately two or three high-value controls, not become a test-suite walkthrough. Preferred examples are:

1. **Scheduling conflict:** FairShift prevents selection or allocation of an unavailable worker or a worker with an overlapping accepted allocation. This demonstrates operational integrity and scheduling intelligence.
2. **Approval gate:** an earned incentive cannot be paid until a manager explicitly approves it. This demonstrates human control and payment governance.
3. **Duplicate PayPal payout protection:** a second attempt for the same submitted or paid incentive is rejected before another PayPal request. This demonstrates payment integrity and real-integration robustness.

A different failure may replace one of these if later implementation evidence shows that it communicates the product more clearly. Only behavior with reproducible evidence should appear as a working demo claim.

### Demo Evidence Matrix

Before submission, FairShift should maintain a compact Demo Evidence Matrix linking implementation and evidence to the final presentation. It may live in a separate submission/demo document once that workstream begins. Its required columns are:

| Feature / golden-path stage | Positive behavior | Negative/control behavior | Automated verification | Integration status | User-visible evidence | Intended demo step |
| --- | --- | --- | --- | --- | --- | --- |
| One row per material stage | Expected successful outcome | Safe invalid/failure outcome | Exact test or evidence reference | Evidence-based status | What the judge can see | Where it appears in the demo |

The matrix prevents unsupported Devpost or presentation claims, exposes evidence gaps before recording, and makes positive and negative behavior easy to assemble into one coherent demo.

### UX state requirements

Submission-critical screens and components must be designed for material states beyond the happy path. As applicable, this includes loading, empty, success, invalid input, unavailable or stale upstream data, conflict, pending external operation, failed external operation, retry/recovery, and already-completed/idempotent state. Every component does not need every state; the requirement applies where a state could materially change or block the golden path.

Worker-facing failure language remains simple, personal, and non-technical. Manager-facing language should identify the operational problem and next safe action. Normal users must never receive raw API payloads, stack traces, access tokens, or provider error details.

### Evidence and status discipline

Use **VERIFIED**, **REPOSITORY EVIDENCE**, **AGENT-REPORTED**, **INFERENCE**, **RECOMMENDATION**, and **NOT VERIFIED** to describe the strength and source of behavior evidence. A negative scenario is **VERIFIED** only after it has actually been executed successfully. Repository code or an unrun test is not execution evidence.

Continue to distinguish integration states: **MOCKED**, **SIMULATED**, **SANDBOX-CONNECTED**, **API-BACKED**, **VERIFIED**, and **DEMO-READY**. A passing mock does not establish provider connectivity, and a successful provider request does not prove every failure mode or make the whole workflow demo-ready.

## 17. PayPal and payment presentation rules

PayPal appears to workers primarily as the payment method, payout confirmation, and payment history. Provider API mechanics belong in operational diagnostics, not ordinary worker screens.

Before approval, managers see the accepted base terms, deterministic incentive result, and final payable amount. Approval is a distinct human action. After submission, natural states such as “Processing,” “Paid,” or “Payment needs attention” take precedence over raw provider enum values. Provider references may be available in authorised detail views for support and audit purposes.

The current payout integration is **SANDBOX-CONNECTED**. Verified evidence includes successful Sandbox OAuth, one controlled $25 payout accepted by PayPal, item status `SUCCESS`, FairShift state persisted as `PAID`, duplicate submission prevention, and successful status refresh. Historical verification transaction IDs must not be hard-coded into product behaviour or fixtures.

The product must never show or log PayPal credentials, OAuth access tokens, sandbox passwords, or unnecessary recipient data. It must not present a submitted or uncertain payout as paid until provider state supports that conclusion.

## 18. Integration strategy

Integrations must strengthen the product and its evidence. FairShift does not add integrations merely to maximise sponsor count. Overall submission quality outranks sponsor accumulation, and no integration receives a stronger status until reproducible evidence supports it.

Use these evidence terms consistently where applicable: **MOCKED**, **SIMULATED**, **SANDBOX-CONNECTED**, **API-BACKED**, **VERIFIED**, and **DEMO-READY**. Planned work remains labelled as planned; a mocked response is not API evidence, API access alone is not end-to-end verification, and verified engineering behavior is not automatically demo-ready.

### PayPal's potential product roles

PayPal may support three distinct parts of the product. Their statuses must never be conflated:

1. **FairShift subscription infrastructure.** A business customer pays FairShift during commercial entry through a PayPal Sandbox subscription boundary. See its evidence documents for what has been verified; hosted journey verification is **NOT VERIFIED**.
2. **Commercial intelligence — not a PayPal role in the current hackathon path.** Square Sandbox supplies commerce evidence. Zettle connector work is retained but inactive, and a genuine merchant connection is not verified.
3. **Worker reward — SANDBOX-CONNECTED.** FairShift sends a manager-approved worker incentive through PayPal and reconciles its state. This is the strongest currently verified PayPal role.

### Core product and competition integrations

#### PayPal — SANDBOX-CONNECTED

- **Purpose:** Execute manager-approved worker incentive/payments and reconcile provider state.
- **Product placement:** Manager Payments & Approvals and worker Earnings/payment confirmation.
- **Current evidence:** Sandbox OAuth succeeded; one controlled $25 payout was accepted; the PayPal item reached `SUCCESS`; FairShift persisted `PAID`; duplicate submission prevention and status refresh passed.
- **Boundary:** This status applies to the Sandbox payout path. It does not imply production capability or live verification of every PayPal feature.

#### Square Sandbox — SANDBOX-CONNECTED, active hackathon commerce provider

- **Purpose:** Supply commerce evidence for worker performance through FairShift's canonical sales layer.
- **Product placement:** Owner Sales for the connection and evidence, Manager Team for worker mapping, Worker Live Target, and Manager Review.
- **Architecture:** A Square adapter translates provider data into canonical FairShift sales records. Forecasting never reads Square payloads.
- **VERIFIED on Square Sandbox ([evidence](SQUARE_LIVE_EVIDENCE.md)):**
  - authenticated genuine UK/GBP Square Sandbox seller;
  - genuine Square Sandbox payments ingested;
  - Square `Payment.team_member_id` persisted and read back;
  - FairShift maps a Square team-member identity to a worker;
  - genuine Square Sandbox commerce can drive FairShift worker performance;
  - the existing FairShift incentive calculation operates on that attributed evidence.
- **Forecast:** genuine Square history is currently insufficient for the 28-day threshold. Clearly labelled reference historical commerce remains the current forecast source. Do not manufacture Square history.
- **Claims limit:** the demonstrated Sandbox payments explicitly supplied `team_member_id`. Do not state that a physical Square till or POS automatically identified the logged-in worker in this implementation. That, production Square, and shared logins are **NOT VERIFIED**.

#### Zettle — INACTIVE for the hackathon Golden Path

- **Status:** Connector work is retained, built against documented API and mocked provider behaviour. A genuine merchant connection is not verified.
- **Boundary:** Do not represent Zettle as the active provider or as integrated. Promoting it would need genuine authentication, merchant access, and retrieval ([evidence](ZETTLE_LIVE_EVIDENCE.md)).

### Planned sponsor integrations

#### AG Grid / AG Studio — PLANNED

- **Purpose:** Improve dense owner/manager operational intelligence where a data-grid or analytics surface materially improves comprehension.
- **Candidate uses:** multi-location sales, historical performance, forecasts, staffing recommendations, forecast-versus-outcome analysis, and operational drill-down.
- **Placement:** Owner Reporting and multi-location Forecast & Staffing; selected manager reporting where data density warrants it.
- **Boundary:** It must support the explanatory hierarchy and drill-down rather than replace it. AG Grid-style dense analytics do not belong in the worker experience. Do not install it simply for sponsor presence.

#### Bryntum — integrated, verified locally, licence NOT VERIFIED

- **Status:** The manager allocation surface, using the trial package ([evidence](BRYNTUM_UI_EVIDENCE.md)).
- **Purpose:** Provide manager-facing workforce and resource scheduling for a genuine time/resource problem.
- **Candidate uses:** weekly scheduling, workers/resources against shifts and time, Shift Allocations, and schedule visualisation.
- **Placement:** Past/current/future Shift Allocations, with weekly and daily views, regular-staff coverage, accepted casual workers, gaps, and conflicts. It may visually continue the Fill Shifts workflow after terms and invitees are selected.
- **Boundary:** Bryntum must consume FairShift's authoritative shift, offer, acceptance, and allocation state rather than create a parallel scheduling model. Licence terms still require verification.

#### APIMatic — PLANNED / exact implementation evidence required

- **Purpose:** Support PayPal API development where it materially improves integration quality, API documentation, SDK or workflow reliability, or credible sponsor-prize evidence.
- **Placement:** Development and integration tooling around PayPal APIs.
- **Boundary:** APIMatic is not a worker-facing or manager-facing product module. Do not invent visible UI merely to expose it, and do not claim integration until concrete implementation and evidence exist.

## 19. Product language and terminology

Use consistent, human language:

- **Historical sales** for factual commerce records.
- **Forecast** for predicted future demand or sales.
- **Forecast range** or **planning range** for uncertainty; do not call it statistical confidence unless calibrated as such.
- **Staffing recommendation** for calculated capacity.
- **Staffing decision** for a manager's saved choice.
- **Full-time coverage** and **casual requirement** for the capacity relationship.
- **Fill Shifts** for shift creation and invitations.
- **Shift offer** for an invitation; **accepted offer** for a worker response; **shift allocation** for the final staffed record.
- **Base pay** or **guaranteed pay**, **incentive**, **final payable amount**, and **payout** as distinct monetary concepts.
- **Awaiting approval**, **Approved**, **Processing**, **Paid**, and **Needs attention** for user-facing payment state.
- **Demo / seeded history** when data is synthetic; **PayPal Sandbox verified** only where reconciliation evidence supports it.
- **SANDBOX-CONNECTED** for Square; **inactive, genuine merchant connection not verified** for Zettle.

Avoid raw enum strings, database terminology, “persisted,” internal IDs, method versions in primary content, “AI score,” individual sales quota, and language that implies automatic hiring, ranking, roster publication, or payout approval.

## 20. Anti-patterns and what current scaffolding must not become

- A giant single-record worker page with every state and policy shown at once.
- A worker experience styled like an owner analytics dashboard.
- Technical labels such as “accepted · persisted,” raw PayPal status codes, migration guidance, or API configuration in normal flows.
- PayPal destination editing embedded prominently in the main shift decision.
- A manager page that stacks every stage of the lifecycle into one long technical demonstration.
- A forecast page that blurs history, prediction, AI interpretation, and manager decision.
- Automatic shift publication from an AI recommendation.
- Opaque worker rankings or an invented fairness score.
- Store-wide or other-worker performance in a worker view.
- Duplicate location selectors when authorisation already makes location unambiguous.
- A sponsor-branded module with no product purpose.
- Competition deadlines, judging criteria, or eligibility checks in business logic.

## 21. Open, needs-verification, and deferred decisions

### OPEN

- Final fictional hospitality group brand and venue names.
- The exact wording of the written tipping-policy rule and the tip terms. FS-TIP-DEC-001 (section 1) settles the earnings formula, tip evidence, exclusions, Manager limits and refund treatment, but doesn't state the rule itself. Nothing about tips is implemented.
- Final SaaS pricing and packaging.
- Permanent incentive policy and formula. The MVP uses an Owner-set individual sales target and fixed bonus (Product Owner decision, FS-PERF-INCENTIVE-001); this is not a claim about the permanent architecture. The $650 / $25 demo rule is evidence of the seeded path only.
- Fair-opportunity distribution and matching weights. Hard eligibility, availability, conflicts, preferences, explainability, and manager control are established; a scoring algorithm is not.
- Over-invitation and capacity behaviour when more workers accept than required.
- Invitation transport and notification channel.
- Shift Sheet format and distribution channel.
- Detailed payment-dispute state machine and any payout-hold rules.

### NEEDS VERIFICATION

- Whether a physical Square till or POS fills `team_member_id` from the logged-in worker, how shared logins behave, and any production Square capability.
- Zettle genuine merchant connection and worker-level attribution, if Zettle is ever reactivated. Neither blocks the hackathon Golden Path.
- Any provider metadata proposed as evidence of worker-attributed performance.
- Current PayPal capability, Sandbox fit, and implementation cost for a possible lightweight commercial entry flow.
- Bryntum and AG Grid licensing, supported package versions, and technical fit before installation.
- The exact APIMatic implementation and evidence that materially supports the PayPal integration.

### DEFERRED

- Net-sales and refund incentive policy beyond the MVP refund decision (section 10).
- Full production subscription infrastructure, including recurring billing, proration, tax, dunning, cancellation management, and production invoicing.
- Cross-location casual-worker scheduling.
- Full-time employee accounts.
- Full FairShift operator console.
- Production authentication and role-based access control.
- Production PayPal operation beyond the verified Sandbox implementation.

## 22. Competition-governance boundary

FairShift is currently being built for the PayPal AI Hackathon. As re-verified on 15 October 2026, governing requirements include a functional application using PayPal's free Sandbox developer platform, meaningful AI, a central PayPal integration, truthful alignment between the working product and submission claims, authorised third-party integrations, and submission by 12 November 2026 at 12:00 PM PST. Judging priorities are Technological Implementation, Design, Potential Impact, Innovation / Idea, and Presentation.

These constraints guide delivery and evidence; they are not FairShift business rules. Do not encode deadlines, judging criteria or weights, sponsor-prize conditions, Devpost wording, or eligibility rules in application logic. Current official competition sources override stale repository copies for compliance decisions.

### Judging-value filter

Significant remaining work should improve multiple judging dimensions while strengthening the golden path:

- **Technological Implementation:** real PayPal plus meaningful AI with observable operational consequences.
- **Design:** one coherent product lifecycle rather than disconnected prototype screens.
- **Potential Impact:** a credible operational and economic problem/solution for variable-demand businesses.
- **Innovation / Idea:** the closed commercial-activity → labour-decision → performance → reward loop.
- **Presentation:** one understandable end-to-end demonstration with truthful positive and negative evidence.

These are delivery and presentation filters, not application business logic. Do not hard-code judging weights or transient competition wording.

## 23. Current implementation → target UX migration

The current implementation is valuable functional evidence. Migration should preserve its server-side flows while replacing the presentation hierarchy.

| Current presentation or flow | Classification | Target treatment |
| --- | --- | --- |
| Canonical normalised sales records and source provenance | **KEEP** | Use as the provider-independent boundary; do not pass provider payloads directly into forecasting. |
| Persisted commercial history, provenance, forecast range, evidence, staffing policy, and worker delta | **KEEP** | Reuse as the factual and predictive foundation for owner/manager weekly views. |
| Structured OpenAI operational assessment with deterministic fallback | **KEEP** | Present as a bounded explanation beside, never above, the deterministic baseline. |
| Forecast evidence table and method details | **REPOSITION** | Place summary evidence near the recommendation; move technical method metadata into expandable detail or reporting. |
| Manager “publish casual shift” server action | **KEEP** | Preserve the explicit human action, but route it through the multi-step Fill Shifts workflow rather than a single demo button. |
| Persisted shift terms, offer, acceptance, and audit events | **KEEP** | Reuse behind Shift Offers and Shift Allocations. |
| Single hard-coded demo shift and worker | **REDESIGN** | Replace presentation with lists, weekly context, and selected records while retaining demo data only as clearly labelled seed/demo content where needed. |
| Worker shift terms and economic terms before acceptance | **KEEP** | Make these the focus of a compact, mobile offer card and full offer detail. |
| Worker acceptance status and confirmation time | **REPOSITION** | Show natural confirmation in Shifts and Schedule; remove persistence terminology. |
| “ACCEPTED · PERSISTED” and other raw state labels | **REMOVE FROM USER-FACING UX** | Use plain-language states; retain technical evidence only in tests or authorised diagnostics. |
| Payout email form inside the shift/incentive card | **REPOSITION** | Move to Profile → Payment settings; show only a contextual completion prompt when payment is blocked. |
| Deterministic incentive calculation, approval gate, integer-cent handling, and payout eligibility | **KEEP** | Reuse behind Performance, Payments & Approvals, and worker Earnings. |
| Manager's combined result/approval/payout demo panel | **REDESIGN** | Separate performance review from payable approval and payment status while preserving the state machine. |
| PayPal batch/status display and manual refresh action | **REPOSITION** | Show natural payment status in ordinary UI; retain provider references and refresh controls in authorised detail/operations views. |
| Direct worker-to-manager and manager-to-technical-evidence links | **REMOVE FROM USER-FACING UX** | Replace with role-specific navigation; keep demo/developer navigation outside normal product surfaces if still needed. |
| Database and migration error copy exposed in normal pages | **REDESIGN** | Provide user-safe unavailable states; log actionable diagnostics for operators without leaking internals. |
| Current shared visual styling | **REDESIGN** | Build distinct owner/manager operational and worker mobile patterns from this specification. |

Functionality that must survive redesign includes truthful provenance, validated forecast and AI contracts, server-side scope, explicit manager control, exact monetary arithmetic, acceptance persistence, incentive state transitions, approval before payout, PayPal idempotency, provider status reconciliation, and clear failure states.

## 24. Implementation sequencing recommendation

### Current authorised package order

Recorded by FS-AUTHORITY-REPAIR-001, 2 November 2026:

1. FS-AUTHORITY-REPAIR-001
2. FS-DEMAND-CONTEXT-001
3. Contextual-AI verification and Golden Path integration
4. FS-HOSPITALITY-EARNINGS-001
5. Full Golden Path rehearsal and hardening

This records order only. Each later package still needs its own authorisation. Hospitality earnings are **not implemented**, and FS-HOSPITALITY-EARNINGS-001 is **not yet authorised**. FS-DEMAND-CONTEXT-001 is implemented and verified locally, not deployed (section 1).

The workload model stays frozen as set out in section 1: 7 completed transactions per operational staff-hour, minimum 2 operational staff while open, one organisation-level policy with no reference-location overrides, a transaction-count workload proxy, and financial sales kept separate from operational demand.

### General sequencing

Implementation should proceed in slices that leave a coherent product after each step:

All subsequent demo work should use one coherent five-location hospitality scenario rather than inventing unrelated fixtures for each feature. Square commerce evidence, five-location demo data, weekly intelligence, Manager and Worker UX, worker targets, Owner economic-value analytics, Bryntum scheduling, AG Grid/Studio analytics, and final presentation evidence should describe the same fictional business once their exact fixtures are deliberately approved.

1. **Preserve the verified backend golden path.** Keep canonical sales records, forecast/staffing behavior, scheduling state, deterministic incentives, approval, PayPal idempotency, and payout reconciliation passing while presentation work proceeds.
2. **Establish coherent product UX foundations.** Create role-specific owner, manager, and worker shells, navigation, location context, responsive patterns, and natural state language without breaking the working path.
3. **Implement and verify POS ingestion and normalisation.** Done for Square Sandbox: provider-adapter boundary, safe synchronisation, provenance, scope, and canonical persistence. Forecasting does not depend on provider payloads.
4. **Connect controlled POS input to forecasting and staffing.** Sufficient connected history enters the same established pipeline. Genuine Square history is below the 28-day threshold, so labelled reference history drives the current forecast.
5. **Implement manager and worker golden-path UX.** Build weekly Forecast & Staffing, Fill Shifts, Worker Pool, shift offers, worker Home/Schedule, Performance, Payments & Approvals, and Earnings around the verified domain flows. Leave unresolved capacity behavior unimplemented until approved.
6. **Integrate Bryntum where scheduling benefits.** Apply it to authoritative Shift Allocations and weekly/daily resource scheduling after licensing and technical fit are confirmed.
7. **Integrate AG Grid / AG Studio where analytics benefits.** Apply it to owner/manager multi-location sales, historical performance, forecasts, staffing recommendations, and drill-down only where density justifies it.
8. **Establish meaningful APIMatic integration and evidence.** Use it around PayPal APIs only where it materially improves API quality, documentation, SDK/workflow reliability, or credible sponsor evidence.
9. **Complete end-to-end golden-demo verification.** Verify POS ingestion through forecast, staffing, scheduling, worker response, deterministic incentive, manager approval, PayPal Sandbox payout, persistence, confirmation, scoping, responsiveness, and accessibility.
10. **Complete presentation polish and submission evidence.** Refine demo clarity and capture truthful evidence only after the integrated path works as represented.

Within implementation and final verification, testing priority is:

1. golden-path positive verification;
2. critical negative-path controls;
3. PayPal and other API failure behavior;
4. duplicate and idempotency protection;
5. AI input, structured-output, and unavailability behavior;
6. scheduling availability and overlap conflicts;
7. persistence and external-state reconciliation;
8. judge-visible failure states linked to the Demo Evidence Matrix.

Testing should target submission-critical risk and demonstrability. Do not pursue exhaustive coverage percentages or enterprise-grade failure infrastructure at the expense of a reliable, presentable golden path.

POS ingestion is a high-priority core integration, not late analytics polish. Each slice should preserve truthful integration status, clearly label demo data, and verify the behavior it presents. Open product decisions remain explicit gates rather than hidden implementation assumptions.
