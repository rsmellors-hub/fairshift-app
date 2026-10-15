# FairShift Product and UX Specification

**Status:** Authoritative product and UX direction

**Scope:** FairShift customer product, worker experience, and bounded FairShift operator surface
**Implementation note:** The current manager and worker pages are functional scaffolding. They demonstrate working data and state transitions but are not the approved target experience.

## 1. Product thesis

FairShift connects a business's factual POS sales activity to workforce decisions and payment. It ingests and normalises sales, uses that history and AI to predict casual labour demand, helps managers offer the right shifts, measures performance against transparent incentives, and turns approved work into PayPal-powered payments.

The product closes an operational loop:

> POS / sales provider → FairShift sales ingestion and normalisation → canonical historical sales dataset → AI demand forecast → staffing recommendation → manager scheduling and Fill Shifts → worker shift and target acceptance → final shift allocation → work and performance → deterministic incentive calculation → manager approval → PayPal payout → confirmation

The POS integration is the factual operational input to forecasting and staffing, not an optional reporting source. PayPal is central to worker payment. AI is central to demand interpretation and staffing decisions. Human managers retain control of staffing and financial approval, while exact financial calculations remain deterministic.

[PayPal Zettle](https://developer.zettle.com) is the preferred POS provider for the hackathon demonstration. Its current status is **PLANNED / NEEDS VERIFICATION**. FairShift must not describe Zettle as integrated until real API authentication and data retrieval succeed. Exact capabilities, scopes, endpoints, merchant access, geography, and attribution behavior must be verified against current official Zettle documentation rather than inferred.

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

The exact adapter interface name is an implementation decision. The architectural contract is not: external provider payloads must be authenticated, validated, scoped, deduplicated where required, and translated into the canonical FairShift sales model before forecasting. Forecasting logic must not depend on Zettle-specific schemas, identifiers, or transport behavior. This boundary allows another POS provider to be supported later without redesigning the forecasting domain.

The sales data serves two distinct purposes:

1. **Location / business sales** power historical demand analysis, day/time patterns, forecasts, staffing recommendations, and owner/manager reporting. Verified location-level POS sales are sufficient for the core forecast and staffing workflow.
2. **Worker-attributed sales** may later support a worker's own aggregate performance and deterministic incentive progress or calculation. A suitable Zettle worker-attribution mechanism has not been verified. Its absence must not block location-level POS sales ingestion or forecasting.

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

## 9. Weekly planning model

Weekly planning is the primary owner and manager planning frame.

AI produces next-week staffing recommendations for seven days per outlet. The owner can view all five outlets consolidated, compare individual outlets, then drill into one outlet and day. A manager sees the same next-week model for the current authorised location.

Each day communicates:

- forecast demand or sales;
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

The strongest intended demonstration is one connected story:

1. **Zettle records business sales.** Zettle is the preferred demonstration POS, subject to verified API access.
2. **FairShift ingests and normalises sales.** A provider adapter converts authenticated POS data into canonical, location-scoped FairShift sales records with provenance.
3. **Historical demand becomes visible.** Owners and managers see factual sales history separately from predictions.
4. **AI forecasts next-week demand.** The manager sees predicted demand, uncertainty, comparable history, and an explanation.
5. **FairShift recommends casual staffing.** Demand becomes a total staffing requirement, known full-time coverage is applied, and the casual requirement is made explicit.
6. **Manager reviews the recommendation.** The manager remains responsible for the staffing decision.
7. **Manager creates and publishes a shift.** Date, time, casual requirement, offered compensation, and incentive terms are explicit and policy-valid.
8. **Worker receives and accepts the shift.** The worker sees the complete economic terms and responds to the individual offer.
9. **The final allocation is established.** Accepted casual workers and lightweight regular-staff coverage form the shift allocation.
10. **Performance or the applicable result is recorded.** Authorised factual results are attached to the completed shift.
11. **Incentive is calculated.** Deterministic policy determines whether and how much was earned.
12. **Manager approves the payable amount.** Base wage plus incentive is shown clearly; approval is an explicit human action.
13. **FairShift initiates a PayPal Sandbox payout.** Provider identifiers and status are persisted with idempotent submission protection.
14. **Worker sees payment confirmation.** FairShift reconciles provider status and presents the confirmed result in natural language.

Zettle remains **PLANNED / NEEDS VERIFICATION**. Until API authentication and location-level sales retrieval succeed, this target path must not be represented as fully implemented or API-backed.

### Current verified golden path

The current repository verifies a controlled path using canonical seeded sales history rather than live Zettle input:

> clearly labelled seeded sales → normalised FairShift transaction records → deterministic demand forecast and staffing recommendation → structured AI operational assessment where configured → manager shift publication → worker acceptance → recorded performance → deterministic incentive calculation → manager approval → PayPal Sandbox payout → persisted `PAID` confirmation

PayPal payout status is **SANDBOX-CONNECTED**. The current path proves the forecast-to-payment workflow and provider payout behavior, but it does not prove Zettle ingestion or worker-level POS attribution.

The currently verified demonstration uses a $650 performance target and a $25 incentive handled in integer cents. This proves a deterministic path; it is not the permanent universal incentive policy.

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
- **Primary user question:** “How many people are likely needed, why, and what should I do?”
- **Key information:** historical evidence, predicted sales, range, data quality, total requirement, full-time coverage, casual gap, key drivers, AI interpretation, and saved decision state.
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

### Core product and competition integrations

#### PayPal — SANDBOX-CONNECTED

- **Purpose:** Execute manager-approved worker incentive/payments and reconcile provider state.
- **Product placement:** Manager Payments & Approvals and worker Earnings/payment confirmation.
- **Current evidence:** Sandbox OAuth succeeded; one controlled $25 payout was accepted; the PayPal item reached `SUCCESS`; FairShift persisted `PAID`; duplicate submission prevention and status refresh passed.
- **Boundary:** This status applies to the Sandbox payout path. It does not imply production capability or live verification of every PayPal feature.

#### PayPal Zettle POS — PLANNED / NEEDS VERIFICATION

- **Purpose:** Supply factual operational location sales and demand input to FairShift's forecast and staffing pipeline.
- **Product placement:** The start of the golden path, before canonical historical sales, forecasting, staffing, and reporting.
- **Architecture:** A Zettle adapter/ingestion layer must translate verified provider data into canonical FairShift sales records. Forecasting must not depend on Zettle payload structures.
- **Required evidence before status promotion:** successful authentication, authorised merchant/data access, real or controlled location-level sales retrieval, input validation, scoping, provenance, persistence, and successful use by the existing forecast/staffing pipeline.
- **Verification boundary:** Exact capabilities, scopes, endpoints, access assumptions, geography, and worker-attribution behavior must be checked against the current [official Zettle developer documentation](https://developer.zettle.com). Worker-level attribution remains separately unverified and is not required for location-level forecasting.

### Planned sponsor integrations

#### AG Grid / AG Studio — PLANNED

- **Purpose:** Improve dense owner/manager operational intelligence where a data-grid or analytics surface materially improves comprehension.
- **Candidate uses:** multi-location sales, historical performance, forecasts, staffing recommendations, forecast-versus-outcome analysis, and operational drill-down.
- **Placement:** Owner Reporting and multi-location Forecast & Staffing; selected manager reporting where data density warrants it.
- **Boundary:** It must support the explanatory hierarchy and drill-down rather than replace it. AG Grid-style dense analytics do not belong in the worker experience. Do not install it simply for sponsor presence.

#### Bryntum — PLANNED

- **Purpose:** Provide manager-facing workforce and resource scheduling for a genuine time/resource problem.
- **Candidate uses:** weekly scheduling, workers/resources against shifts and time, Shift Allocations, and schedule visualisation.
- **Placement:** Past/current/future Shift Allocations, with weekly and daily views, regular-staff coverage, accepted casual workers, gaps, and conflicts. It may visually continue the Fill Shifts workflow after terms and invitees are selected.
- **Boundary:** Bryntum must consume FairShift's authoritative shift, offer, acceptance, and allocation state rather than create a parallel scheduling model. Licensing and technical fit require verification before implementation.

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
- **PLANNED / NEEDS VERIFICATION** for Zettle until actual API authentication and sales retrieval succeed.

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

- Permanent incentive policy and formula; the $650 / $25 demo rule is evidence of the current path only.
- Fair-opportunity distribution and matching weights. Hard eligibility, availability, conflicts, preferences, explainability, and manager control are established; a scoring algorithm is not.
- Over-invitation and capacity behaviour when more workers accept than required.
- Invitation transport and notification channel.
- Shift Sheet format and distribution channel.
- Detailed payment-dispute state machine and any payout-hold rules.

### NEEDS VERIFICATION

- Zettle authentication, merchant access, applicable scopes/endpoints, location-level sales retrieval, pagination/synchronisation behavior, and commercial/geographic availability against current official documentation.
- Zettle worker-level attribution mechanism suitable for FairShift. This is separate from, and must not block, location-level sales ingestion for forecasting.
- Any provider metadata proposed as evidence of worker-attributed performance.
- Bryntum and AG Grid licensing, supported package versions, and technical fit before installation.
- The exact APIMatic implementation and evidence that materially supports the PayPal integration.

### DEFERRED

- Exact SaaS subscription and billing model.
- Cross-location casual-worker scheduling.
- Full-time employee accounts.
- Full FairShift operator console.
- Production PayPal operation beyond the verified Sandbox implementation.

## 22. Competition-governance boundary

FairShift is currently being built for the PayPal AI Hackathon. As re-verified on 15 October 2026, governing requirements include a functional application using PayPal's free Sandbox developer platform, meaningful AI, a central PayPal integration, truthful alignment between the working product and submission claims, authorised third-party integrations, and submission by 12 November 2026 at 12:00 PM PST. Judging priorities are Technological Implementation, Design, Potential Impact, Innovation / Idea, and Presentation.

These constraints guide delivery and evidence; they are not FairShift business rules. Do not encode deadlines, judging criteria or weights, sponsor-prize conditions, Devpost wording, or eligibility rules in application logic. Current official competition sources override stale repository copies for compliance decisions.

## 23. Current implementation → target UX migration

The current implementation is valuable functional evidence. Migration should preserve its server-side flows while replacing the presentation hierarchy.

| Current presentation or flow | Classification | Target treatment |
| --- | --- | --- |
| Canonical normalised sales records and source provenance | **KEEP** | Use as the provider-independent boundary for future Zettle ingestion; do not pass Zettle payloads directly into forecasting. |
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

Implementation should proceed in slices that leave a coherent product after each step:

1. **Preserve the verified backend golden path.** Keep canonical sales records, forecast/staffing behavior, scheduling state, deterministic incentives, approval, PayPal idempotency, and payout reconciliation passing while presentation work proceeds.
2. **Establish coherent product UX foundations.** Create role-specific owner, manager, and worker shells, navigation, location context, responsive patterns, and natural state language without breaking the working path.
3. **Implement and verify Zettle POS ingestion and normalisation.** Verify official API access first, then add the provider-adapter boundary, safe synchronisation, provenance, scope, and canonical persistence. Do not make forecasting depend on Zettle-specific payloads.
4. **Connect controlled POS input to forecasting and staffing.** Prove that authenticated, normalised location sales enter the same established pipeline and visibly drive historical evidence, forecast, and staffing output.
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
