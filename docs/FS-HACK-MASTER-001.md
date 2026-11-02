<!--
Repository custody note. This block is not part of FS-HACK-MASTER-001.
Added by FS-AUTHORITY-REPAIR-001, 2 November 2026.

Source file: FairShift_Phase_0_Master_Project_Plan_v1_0.docx
Source SHA-256: 49a28e40083b33ca27bbed9ab9e69d85e7d2725502776333676a23748512b1eb
Source footer: FairShift • FS-HACK-MASTER-001 • v1.0 • 15 Oct 2026

This is a historical baseline. Its text below is a Markdown conversion of the source, with no wording updated.
Later Owner decisions are recorded separately in docs/FAIRSHIFT_PRODUCT_UX_SPEC.md and, where they apply, prevail over this text.
Do not read this document as a statement of current implementation or current competition rules.

Conversion changes format only: Word callout boxes became blockquotes, table header rows lost their bold,
and numbered lists restart at 1 for each list.
-->

# FAIRSHIFT

**Phase 0 Master Project Plan & Product Specification**

PayPal AI Hackathon — Definition Freeze

| Control | Value |
|---|---|
| Document ID | FS-HACK-MASTER-001 |
| Version | 1.0 |
| Status | PHASE 0 BASELINE — product direction frozen except items explicitly marked OPEN / NEEDS VERIFICATION |
| Prepared | 15 October 2026 |
| Competition authority | PayPal AI Hackathon Official Rules and Devpost competition pages |
| Canonical repository | /Users/ryanmellors/Projects/Fairshift/app |
| Submission deadline | 12 November 2026, 12:00 PM PST (22:00 SAST) |
| Internal target | Submission-ready by 11 November 2026; no submission-critical implementation planned for final day |

> **Control principle**
>
> Competition compliance and a reliable end-to-end demo outrank feature count. This document records only the product direction and integrations already discussed or required to deliver it. Unresolved items are explicitly marked rather than invented.

### Status legend

| Status | Meaning |
|---|---|
| LOCKED | Agreed product rule. Implementation should follow it unless deliberately changed. |
| REQUIRED | Required by competition rules or required to make the agreed golden path function. |
| OPEN | Decision still required. Do not invent during implementation. |
| NEEDS VERIFICATION | Concept is agreed but technical capability or access must be proven. |
| DEFERRED | Explicitly outside the competition MVP unless the golden path is secure. |

## 1. Competition Authority and Non-Negotiable Constraints

The PayPal AI Hackathon Official Rules and the Devpost competition pages are the source of truth for competition compliance. Where this plan conflicts with the current official rules, the official rules prevail.

| Requirement | Phase 0 interpretation | Status |
|---|---|---|
| Build/update an application using the PayPal developer platform in the free sandbox plus an AI tool/model/platform. | FairShift must demonstrate both as functional, meaningful parts of the product. | REQUIRED |
| PayPal integration must be central. | PayPal cannot be a decorative payment button or presentation-only claim. | REQUIRED |
| Functional demo. | Judges must be able to run/interact with a working build via repository instructions or hosted demo. | REQUIRED |
| Public code repository. | Repository must be public for judging/testing and contain source, assets and run instructions. | REQUIRED |
| Open-source licence. | A licence file must be visible in the repository. | REQUIRED |
| Demo video. | Under 3 minutes; publicly visible on YouTube; must show the project functioning. | REQUIRED |
| Text description and tools disclosure. | Submission must explain features/functionality and identify the AI/model/tools used and how. | REQUIRED |
| Third-party integrations. | FairShift must be authorised to use any third-party SDK/API/data under applicable terms/licences. | REQUIRED |
| Deadline. | 12 Nov 2026, 12:00 PM PST. FairShift internal target is one day earlier. | REQUIRED |

### 1.1 Judging criteria

| Criterion | FairShift response |
|---|---|
| Technological Implementation | Working PayPal integration plus meaningful AI forecasting/staffing and a non-trivial operational workflow. |
| Design | Coherent role-specific experience across owner, manager and casual worker; not a collection of disconnected screens. |
| Potential Impact | Specific retail/casual-labour problem: matching staffing to demand, improving worker opportunity fit, transparent incentives and faster approved payout. |
| Innovation / Idea | Commerce data drives labour planning; worker availability and fairness inform matching; performance closes the loop into PayPal payout. |
| Presentation | One rehearsable golden path demonstrating historical sales → AI → staffing → shift → worker → performance → approval → PayPal payout. |

### 1.2 Prize strategy

Primary objective: overall submission quality. Sponsor tools are included only where they materially improve the agreed product. Current planned sponsor integrations are AG Grid, Bryntum and APIMatic. The rules allow multiple sponsor tools, but a project may win at most one Sponsor Prize plus either one Grand Prize or one Honorable Mention.

- AG Grid: analytics/reporting surface for owner/manager sales, forecast and operational data.
- Bryntum: scheduling/shift-allocation interface because the product has a genuine time/resource scheduling problem.
- APIMatic: development-time PayPal API context for Claude Code/Codex integration work.
- No additional sponsor integration is authorised by this Phase 0 plan.

## 2. Product Definition

> **FairShift product thesis**
>
> FairShift uses sales intelligence and AI to help businesses predict casual labour demand, offer the right shifts, measure worker performance against transparent incentives, and turn approved work into PayPal-powered payments.

### 2.1 Core operational loop

PayPal/Zettle sales data → historical factual dataset → AI demand forecast → staffing recommendation → manager weekly planning / Fill Shifts → worker shift offer → worker acceptance → final shift allocation → work/performance → incentive calculation → manager approval → PayPal payout → confirmation.

### 2.2 Product boundary

| Included in competition MVP | Explicitly not expanded in Phase 0 |
|---|---|
| Three user levels: Admin/Owner, Manager/Supervisor, Casual Worker. | No separate Finance/Payroll user role. |
| Five-outlet demo company with historical data. | No general enterprise HRIS. |
| Full-time staff as lightweight staff/contact records used in shift allocation. | No full-time employee portal/account unless later required. |
| Weekly forecast/staffing plan with daily/shift drill-down. | No autonomous publication of rosters by AI. |
| Location-bound casual worker pool. | No cross-location casual-worker scheduling. |
| Worker availability/preferences for matching. | No collection of personal reasons for preferences. |
| Shift offers, accept/decline, allocations and shift sheets. | No broad leave/recruitment/payroll suite. |
| Worker performance summary: own sales count + own total attributed sales value. | No worker access to customer, product, transaction-level, store-wide or other-worker sales data. |
| Manager approval of wage + incentive and PayPal payout. | Wallet/employee-discount concept is deferred. |

## 3. Competition Demo Company and Data

The competition demo will use one fictional owner/company with five outlets in different areas. The system will contain historical factual demo data for all five outlets. The owner can view locations individually and consolidated and generate next-week reports/forecasts from that historical dataset.

| Demo element | Definition | Status |
|---|---|---|
| Company | One fictional retail company. | LOCKED |
| Locations | Five outlets in different areas. | LOCKED |
| Historical data | Historical sales for all five outlets; sufficient temporal detail to support day/time patterns and next-week forecasting. | LOCKED |
| Location behaviour | The dataset should contain realistic differences, noise, seasonality/pattern variation rather than identical outlets. | LOCKED |
| Staffing context | Full-time staffing inputs and casual staffing history where needed by the agreed staffing methodology. | LOCKED |
| Future report | Next-week forecast/recommendation is predictive output and must be labelled as such; historical inputs are factual demo records. | LOCKED |
| Exact outlet names/areas | Not yet specified in the agreed product direction. | OPEN |
| Exact historical period and row volume | Must be chosen when the forecasting methodology is frozen. | OPEN |

## 4. Users, Permissions and Data Visibility

### 4.1 Admin / Owner

- Creates/configures company details.
- Configures PayPal details required by the chosen PayPal integration.
- Creates locations.
- Adds managers and assigns each manager to one or multiple locations.
- Views sales for each location individually and all locations combined.
- Sets approved hourly/daily wage policy or rate ranges.
- Sets incentive structures/policies.
- Views company-level and location-level reporting, including next-week forecast outputs.
- Can drill down through All Locations → Location → Shift → Worker where the agreed data permissions allow.

### 4.2 Manager / Supervisor

- Operates only within locations assigned by Admin.
- If assigned one location, location context is implicit; the UI must not require a redundant store selector.
- If assigned multiple locations, selects the active authorised location where necessary.
- Creates shifts and sends shift offers.
- Can import data if needed by the implemented sales-data path.
- Views sales figures for the manager's assigned/current store and casual-worker performance within that store.
- Adds/deletes casual-worker records for the current location and initiates invitations.
- Reviews worker responses, finalises shift allocations and maintains past/current/future allocations.
- Approves end-of-shift/day wage, incentive and final payable amount.

### 4.3 Casual Worker

- Exists only after a manager creates the initial name/contact record for one location.
- Receives an activation code/invite and completes the remaining relevant profile details.
- Receives shift offers only for the assigned location.
- Accepts/declines offered shifts and terms.
- Maintains normal availability and shift preferences.
- Sees shift pay and relevant shift terms.
- Sees incentive target and payout/progress information.
- Sees only own aggregated sales count and own total attributed sales value for the relevant shift/period.
- Sees previous payouts and payout status.
- Can raise a payment dispute.
- Sees the assigned PayPal/POS attribution code or identifier if the verified sales-attribution implementation uses one.

### 4.4 Full-time staff

Full-time staff are lightweight staff/contact records, not a fourth user role in the competition MVP. They may be entered by name, included on shift allocations, and receive the final shift sheet/distribution where implemented.

### 4.5 Sales visibility matrix

| User | Permitted sales visibility |
|---|---|
| Casual Worker | Own sales count + own total attributed sales value only; derived incentive progress. |
| Manager/Supervisor | Store/location sales for assigned/current location plus individual casual-worker performance within that location. |
| Admin/Owner | All five locations individually and consolidated company-wide; drill-down by location/shift/worker as applicable. |

## 5. Casual Worker Lifecycle

### 5.1 Location-bound rule

> **LOCKED MVP RULE**
>
> Casual workers are location-bound. They are initially created by a manager as a name/contact record, receive a FairShift invitation or activation code, complete their own profile, and thereafter receive shift offers only for their assigned location. Cross-location casual-worker scheduling is outside the competition MVP.

### 5.2 Onboarding workflow

1. Manager opens Workers/Contacts in the active location context.
2. Manager creates the initial casual-worker record using name and contact details.
3. FairShift records the worker against that location and creates an invitation/activation mechanism.
4. Worker receives the invitation/code.
5. Worker opens FairShift and completes the relevant profile details.
6. Worker sets normal availability and shift preferences.
7. Worker completes the payment details required by the final PayPal payout design.
8. Worker becomes available in that location's Worker Pool for shift matching/invitations.

The exact invitation transport (for example email/SMS/link) has not been agreed and remains OPEN; implementation must not invent a product commitment before selection.

### 5.3 Availability and preferences

FairShift stores operational constraints, not unnecessary personal reasons. Example: store 'unavailable after 20:00', not 'has children'; store 'weekday availability after 16:00', not 'attends university'.

- Day availability/unavailability.
- Time-window availability where applicable.
- No-late-shift or latest-finish preference where set.
- Desired/maximum shift frequency only if included in the profile implementation.
- The worker does not select multiple locations.

## 6. Weekly Planning, AI Forecasting and Staffing Recommendation

### 6.1 Planning unit

FairShift's primary planning view is weekly. AI generates a next-week staffing recommendation across the seven days for each outlet. Individual shifts remain the operational unit for offers, acceptance, performance and payment.

### 6.2 Separation of decisions

| Layer | Purpose | Inputs / constraints |
|---|---|---|
| Demand intelligence | Determine expected demand and how many additional casual workers are needed. | Historical/recent sales, day/time pattern, existing full-time staffing and other inputs that are explicitly approved in the final methodology. |
| Worker eligibility | Determine who can be considered. | Location membership, availability, existing accepted allocations and overlap rules. |
| Worker matching | Recommend suitable candidates to the manager. | Eligible workers plus agreed preferences/fair-distribution factors. Manager remains in control. |

### 6.3 Forecast output

- Owner: next-week view across all five outlets, individually and consolidated.
- Manager: relevant next-week forecast/staffing recommendation for assigned/current store.
- Daily drill-down: forecast demand/sales, existing full-time coverage and recommended casual requirement.
- Forecasts/recommendations must be clearly distinguished from historical factual data.
- Manager can override recommendations; AI does not automatically publish the roster.

### 6.4 AI methodology freeze requirement

The exact mathematical/model methodology has not yet been agreed. Phase 0 therefore freezes the required contract, not an invented algorithm. Before implementation of the forecasting engine is considered complete, the project must explicitly define: historical window, temporal granularity, features used, forecast target, staffing conversion rule, fallback behaviour, confidence/uncertainty presentation, and validation metric.

| Methodology item | Current status |
|---|---|
| Historical PayPal/Zettle sales as a primary factual input | LOCKED concept |
| Day-of-week / time-of-day patterns | LOCKED concept |
| Existing full-time staffing as a staffing input | LOCKED concept |
| Sales-per-labour-hour or equivalent staffing conversion | OPEN — must be selected and justified |
| Exact AI/model/platform | OPEN — must be selected and disclosed in Devpost submission |
| External factors such as public holidays/events/weather | NOT AUTHORISED by this Phase 0 plan |
| Validation/forecast error metric | OPEN — required before AI milestone closes |

### 6.5 Worker matching and fairness

- Matching occurs only inside the worker's assigned location.
- Hard exclusions: unavailable worker, overlapping accepted allocation, other deterministic shift conflict.
- Preferences can be used to avoid irrelevant offers.
- Manager reviews recommendations and chooses whom to invite.
- Fair opportunity distribution is an agreed design principle; exact scoring/weighting remains OPEN and must not be invented silently.
- FairShift must avoid opaque 'AI score' presentation where an explainable reason can be shown.

## 7. Shift Creation, Offers, Acceptance and Allocation

### 7.1 Canonical terminology

| Term | Definition |
|---|---|
| Shift | A dated/time-bounded work period. |
| Shift Offer | Invitation sent to a casual worker for a shift and its terms. |
| Shift Acceptance | Worker acceptance of an offered shift/terms. |
| Shift Allocation | Final collection of staff assigned to the shift. |
| Shift Sheet | Saved, printable and distributable representation of the allocation. |

### 7.2 Manager Fill Shifts workflow

1. Manager selects Fill Shifts.
2. If the manager has one assigned location, FairShift uses it automatically. If multiple, the manager selects the active authorised location.
3. Manager enters shift date/day, start time, end time, casual-worker requirement and offered pay/rate within Admin-approved policy.
4. Manager presses Create.
5. FairShift creates the shift.
6. Manager selects contacts from that location's Worker Pool.
7. FairShift may surface eligible/recommended candidates based on availability, conflicts, preferences and agreed matching logic.
8. Manager selects candidates.
9. Manager presses Send.
10. Workers receive shift offers and accept/decline.
11. Manager is notified of responses.
12. Accepted workers form part of the final Shift Allocation.

### 7.3 Multi-day / weekly invitations

A manager may send a worker an invitation containing multiple shifts from the same location. The worker responds per shift rather than being forced to accept or reject the entire bundle.

- Each shift retains its own date/time, pay and applicable incentive terms.
- Accepted shifts participate in deterministic overlap/conflict checks.
- Cross-location invitations are not allowed in the MVP.

### 7.4 Open offer-capacity rule

The exact over-invitation/capacity model is not yet agreed: invite exactly the required number and replace declines, or invite more candidates and close places when capacity is filled. This remains OPEN and must be decided before shift-offer implementation is frozen.

### 7.5 Shift Allocations page

- Separate from Fill Shifts.
- Contains past, current and future allocations.
- For multi-location managers, supports authorised location context/filtering.
- Selecting an allocation opens the full record.
- Includes full-time staff records and accepted casual workers.
- Final Shift Sheet can be saved, printed and distributed/sent.
- The exact distribution channel is OPEN.

## 8. Sales Data, Attribution and Worker Performance

### 8.1 Sales-data purpose

Sales data serves two distinct product purposes: (1) historical factual input to forecasting/staffing; and (2) attributed casual-worker performance used for incentive progress and end-of-shift calculation.

### 8.2 Worker-facing performance

- Number of sales attributed to the worker.
- Total value of sales attributed to the worker.
- Derived incentive target/progress where applicable.
- No transaction-level customer/product detail.
- No store-wide sales.
- No other-worker sales.

### 8.3 Zettle integration role

Zettle is part of the PayPal developer platform under the hackathon rules and is the planned commerce-data integration for purchase/sales information. The current Zettle API documentation provides OAuth-based access to merchant data, a read-only Purchase API, Finance data, and Pusher webhooks such as PurchaseCreated.

| Zettle capability | Planned FairShift use | Status / work required |
|---|---|---|
| OAuth 2.0 | Authorise FairShift to access the demo merchant's Zettle data. | Create Zettle developer credentials; implement authorised flow; securely store/refresh tokens. |
| Purchase API / READ:PURCHASE | Retrieve purchase records for historical/demo sales ingestion and reporting. | Implement read path; map purchases to FairShift location/time records; verify real response shape. |
| Pusher PurchaseCreated webhook | Receive purchase events without polling where feasible. | Expose public HTTPS listener; create subscription; persist/process events; test retry/idempotency. |
| Finance API / READ:FINANCE | Available for processed transaction/balance/payout information if required by the agreed reporting path. | Use only if necessary; do not expand scope merely because available. |
| Worker/POS attribution | Associate relevant sales with the casual worker so FairShift can aggregate sales count/value. | NEEDS VERIFICATION. Exact mechanism must be proven before claiming live attribution. |

> **Critical Zettle constraint**
>
> Current Zettle documentation lists supported API markets including the US, UK and several European/Mexican markets, but not South Africa. The competition demo must therefore use a supported Zettle test/merchant context if Zettle is used. Do not claim South African Zettle availability.

The business requirement for worker attribution is LOCKED; the exact technical mechanism is NEEDS VERIFICATION. If Zettle cannot provide a defensible worker-level attribution path within the competition window, the project must stop and report the gap rather than represent simulated attribution as API-backed.

## 9. Compensation, Incentives, Approval and Payment

### 9.1 Compensation authority

- Admin/Owner defines approved wage policy/range (hourly/daily as applicable).
- Manager selects/offers compensation only within the approved policy/range.
- Shift offer shows the economic terms before worker acceptance.

### 9.2 Incentives

- Admin/Owner sets incentive structures/policies.
- Worker sees applicable target and payout/progress.
- FairShift calculates incentive from the agreed performance input.
- Manager reviews the calculated wage + incentive before payout.

The exact incentive formula (threshold, percentage, tiers, store-level versus individual rules) has not yet been agreed. It remains OPEN and must be frozen before implementation.

### 9.3 End-of-shift / end-of-day closeout

1. Shift ends / relevant performance period closes.
2. FairShift finalises the worker's relevant sales count and total attributed sales value.
3. FairShift determines base wage from the accepted shift terms.
4. FairShift calculates the incentive using the configured policy.
5. Manager reviews base wage, incentive and final payable amount.
6. Manager approves the payable amount.
7. FairShift initiates the PayPal payout through the verified sandbox integration.
8. FairShift persists PayPal identifiers/status and surfaces the resulting payment state to manager and worker.

### 9.4 PayPal Payouts integration

PayPal Payouts is the planned worker-payment mechanism. PayPal's current developer documentation describes Payouts for sending payments to recipients including contractors/employees and provides sandbox/API support and payout status tracking.

| Requirement | Implementation task | Acceptance evidence |
|---|---|---|
| Sandbox credentials | Create/configure PayPal developer app and required sandbox accounts; store credentials outside source control. | Authenticated sandbox API request succeeds. |
| Payout API | Implement server-side payout request using recipient details required by the chosen Payouts path. | Payout request returns real sandbox identifiers/status. |
| Idempotency / duplicate protection | Use stable internal payment/payout identifiers and prevent duplicate manager approval from creating duplicate payout requests. | Repeat action does not duplicate payout. |
| Status persistence | Persist FairShift payment record plus PayPal batch/item identifiers and current status. | UI survives refresh/restart with correct state. |
| Webhooks | Subscribe to relevant payout events; expose HTTPS endpoint; verify webhook authenticity; update persisted state. | Sandbox/test event changes FairShift state. |
| Failure handling | Handle failed/held/unclaimed/denied/returned states without displaying success. | At least one failure/non-success path is tested. |
| Worker confirmation | Worker payout history shows amount and current payment state. | End-to-end golden path demonstrates confirmation. |

### 9.5 Payment disputes

FairShift includes a lightweight internal payment-dispute workflow. Agreed dispute categories are incorrect hours, sales, incentive, payment not received, or other. The worker raises the issue; the manager can review it. The detailed resolution state machine and whether payout is held during dispute remain OPEN.

## 10. Planned Add-ons / Sponsor Integrations

These are the only sponsor add-ons authorised by this Phase 0 plan. They must be implemented as real product components or development tooling, not decorative name-drops.

### 10.1 Bryntum Scheduler

- Purpose: manager-facing time/resource scheduling and Shift Allocations presentation.
- Use: visualise staff against dated/timed shifts; support the agreed weekly/daily allocation workflow.
- Creation/setup: obtain the hackathon/trial package; install the Bryntum Scheduler package; integrate with FairShift shift/allocation data; theme it consistently; verify save/reload behaviour.
- Do not expand into Gantt/project management or unrelated calendar features.

### 10.2 AG Grid / AG Studio

- Purpose: owner/manager analytics and reporting surfaces for multi-location sales, forecasts, staffing recommendations and operational drill-down.
- Use: provide structured grids/charts/dashboard interactions where the data density genuinely benefits from AG Grid/Studio.
- Creation/setup: obtain the hackathon access/package; integrate with FairShift data contracts; configure role/location guardrails; build only the dashboard/report views required by the agreed workflows.
- Worker UI should not expose AG Grid-style commercial analytics; worker view remains intentionally minimal.

### 10.3 APIMatic Context Plugin

- Purpose: development-time support for Claude Code/Codex when implementing PayPal APIs.
- Use: provide PayPal API context to the coding agent to reduce integration errors and improve alignment with current API contracts.
- Creation/setup: claim/access the hackathon APIMatic resource; configure the coding agent/plugin according to the sponsor instructions; record its use in project documentation and Devpost tools disclosure.
- APIMatic is not a user-facing FairShift feature.

### 10.4 No other add-ons in Phase 0

Render, Channel3, Elastic, KERNEL, Astropods, Postman and Zapier are not included by this master plan. They may only be added later if a concrete submission-critical or judging-value need is demonstrated without threatening the golden path.

## 11. Required Product Surfaces

| User | Required surfaces / capabilities |
|---|---|
| Admin/Owner | Overview; Locations; Managers; Compensation; Incentives; PayPal/configuration; all-location sales/reporting; next-week forecast/report; location drill-down. |
| Manager/Supervisor | Dashboard; Forecast/Staffing; Fill Shifts; Shift Allocations; Workers/Contacts; Performance; Payments/Approvals. |
| Casual Worker | Home; Shifts/offers; own performance/earnings; payout history; dispute action; Profile/availability/preferences/payment details. |

Navigation labels are working product labels, not a requirement to create additional modules. Each screen must exist only where needed to complete the agreed workflows.

## 12. Minimum Data Domains

The implementation must support the following agreed conceptual relationships. Exact schema design is an implementation decision after repository verification.

| Domain | Required relationship / purpose |
|---|---|
| Company | Top-level demo organisation. |
| Location | Five outlets; parent company; manager assignments; sales context. |
| Manager assignment | Manager ↔ one/multiple authorised locations. |
| Full-time staff record | Lightweight location-bound contact used in allocations. |
| Casual worker | Exactly one location in MVP; invitation/profile status. |
| Worker availability/preferences | Operational availability and shift preferences. |
| Historical sales | Location/time factual records used for reporting and forecasting. |
| Forecast | Next-week predictive output by location/day/time as methodology defines. |
| Staffing recommendation | Recommended additional casual requirement derived from forecast + existing coverage. |
| Shift | Location/date/start/end/required casual count/accepted economic terms. |
| Shift offer | Worker-specific invitation and response state. |
| Shift allocation | Final assigned full-time + casual staff. |
| Performance | Worker sales count/value aggregates and incentive progress. |
| Incentive policy/result | Admin-configured policy and calculated shift result. |
| Payment | Approved amount + PayPal payout identifiers/status. |
| Dispute | Worker-raised payment issue linked to relevant payment/shift. |

## 13. Golden Demo Path

The competition build is not considered demo-ready until this exact narrative can be executed reliably:

1. Admin/Owner opens the five-outlet company view and sees historical factual sales.
2. Owner generates/views the next-week AI forecast and staffing recommendation across the five outlets.
3. Owner drills into a specific outlet/day to show forecast demand, existing full-time coverage and recommended casual requirement.
4. Manager for that outlet opens Forecast/Staffing and proceeds to Fill Shifts.
5. Manager creates the required shift(s) with pay within Admin policy.
6. FairShift filters the location-bound Worker Pool by availability/conflicts and surfaces suitable candidates.
7. Manager selects contacts and sends one or more shift offers.
8. Casual worker opens the mobile-oriented worker experience and accepts a shift with visible terms.
9. Manager sees the acceptance and the worker appears in the Shift Allocation / Shift Sheet.
10. Relevant worker performance is populated from the implemented sales-attribution path: sales count + total sales value.
11. FairShift calculates base wage and incentive according to the configured policy.
12. Manager reviews and approves the final payable amount.
13. FairShift initiates a real PayPal sandbox payout.
14. PayPal payout identifier/status is persisted and updated.
15. Worker sees the payout in earnings/history with confirmation/status.

## 14. Delivery Plan, Milestones and Timeframes

Schedule is intentionally front-loaded. The official deadline is 12 November 2026 at 12:00 PM PST; FairShift targets submission readiness by 11 November.

| Phase | Dates | Deliverable / exit condition |
|---|---|---|
| 0 — Definition Freeze | 15–16 Oct | This master plan approved; open decisions register established; competition requirements verified; no unrecorded product assumptions. |
| 1 — Foundation | 17–20 Oct | Application foundation, roles/permissions, company + 5 locations, demo dataset scaffold, stable navigation/data persistence. |
| 2 — Workforce & Scheduling | 21–24 Oct | Worker onboarding/profile, location-bound pools, availability/preferences, shifts, offers, accept/decline, allocations, Bryntum scheduling surface. |
| 3 — AI Intelligence | 25–28 Oct | Forecast methodology frozen and implemented; next-week forecast; staffing recommendation; worker eligibility/matching; validation evidence. |
| 4 — PayPal & Commerce | 29 Oct–2 Nov | Zettle sales path/attribution feasibility resolved; PayPal Payouts sandbox integration; webhooks/status persistence; AG Grid reporting; APIMatic used for PayPal build. |
| 5 — Golden Path | 3–5 Nov | Full end-to-end flow executes without manual database edits or false integration claims. |
| 6 — Hardening & UX | 6–8 Nov | Critical defects fixed; role permissions, conflict logic, payment states and demo reset/repeatability tested; worker mobile UX polished. |
| 7 — Submission Production | 9–10 Nov | README/setup, public repo readiness, licence, Devpost text, screenshots, architecture explanation, <3-minute video recorded/edited. |
| 8 — Submission Buffer | 11 Nov | Final clean-room run, links checked, repository public, video public, Devpost fields complete; submit if ready. |
| Official deadline | 12 Nov, 12 PM PST | No planned submission-critical development. |

### 14.1 Hard gates

| Gate | Date | Must be true |
|---|---|---|
| G1 Foundation | 20 Oct | Roles, five locations, permissions, persistence and demo-data foundation work. |
| G2 Components | 2 Nov | AI, scheduling, sales-data path and PayPal payout work independently with evidence. |
| G3 Golden Path | 5 Nov | Complete demo path works end-to-end. |
| G4 Submission Ready | 10 Nov | Product stable; documentation/video/submission assets complete enough for final verification. |

## 15. Verification and Acceptance Standard

| Area | Minimum acceptance test |
|---|---|
| Repository | Verify cwd, branch, HEAD, git status and relevant implementation before every substantive work package. |
| Permissions | Owner, manager and worker cannot access data outside agreed scope; manager location context enforced. |
| Worker onboarding | Manager-created worker can activate profile and appears only in assigned location pool. |
| Availability/conflicts | Unavailable/overlapping worker is not recommended for conflicting shift. |
| Shift offers | Offer sent; worker response persists; allocation updates correctly. |
| Forecast | Structured inputs/outputs; methodology documented; output reproducible enough for demo; validation metric recorded. |
| Staffing recommendation | Recommendation is traceable to forecast + existing coverage; manager can override. |
| Zettle | Real API/webhook evidence where claimed; worker attribution specifically verified or explicitly not claimed. |
| PayPal Payouts | Sandbox auth, payout request, persisted IDs/status, webhook/status update and failure/non-success handling. |
| Incentive | Configured policy produces deterministic amount and manager approval uses that amount. |
| Golden path | End-to-end run succeeds from sales/forecast through worker payout confirmation. |
| Demo repeatability | Demo can be reset/re-run without manual emergency fixes. |

## 16. Open Decisions / Needs Verification Register

| ID | Item | Status | Must be resolved by |
|---|---|---|---|
| O-01 | Exact AI model/platform. | OPEN | Before AI implementation starts |
| O-02 | Forecast methodology: historical window, granularity, features, model, validation metric. | OPEN | 24 Oct |
| O-03 | Forecast-to-staffing conversion rule. | OPEN | 24 Oct |
| O-04 | Worker matching/fairness scoring beyond hard eligibility rules. | OPEN | 24 Oct |
| O-05 | Shift-offer capacity model: exact-number vs over-invite/first-filled. | OPEN | Before offer logic freeze |
| O-06 | Exact incentive formula/policy structure. | OPEN | Before incentive implementation |
| O-07 | Invitation and Shift Sheet distribution channel. | OPEN | Before notification implementation |
| O-08 | Zettle worker-level transaction attribution mechanism. | NEEDS VERIFICATION | Before claiming API-backed performance |
| O-09 | Zettle supported-market demo account/context. | NEEDS VERIFICATION | Before Zettle build |
| O-10 | Payment dispute resolution states / payout-hold behaviour. | OPEN | Before dispute implementation |
| O-11 | Exact five demo outlet names/areas and historical dataset period. | OPEN | Before final demo-data generation |
| O-12 | Exact worker payment identifier/details required by selected PayPal Payouts path. | NEEDS VERIFICATION | Before worker profile freeze |

## 17. Deferred / Post-Core Register

| Item | Phase 0 decision |
|---|---|
| Worker wallet / stored money concept | DEFERRED. Do not implement before golden path is secure and PayPal capability is verified. |
| Employee retailer discounts via PayPal | DEFERRED. |
| Cross-location casual-worker scheduling | DEFERRED / outside competition MVP. |
| Full-time staff user accounts | DEFERRED; use lightweight records. |
| Separate finance/payroll role | DEFERRED / not required. |
| General HRIS, leave, recruitment, enterprise workforce suite | OUT OF SCOPE. |
| Additional sponsor integrations | Not authorised unless later justified against competition priorities. |

## 18. Repository and Coding-Agent Controls

Canonical repository: /Users/ryanmellors/Projects/Fairshift/app. Repository evidence is authoritative for implementation state.

- Before substantive coding/architecture/debugging/integration/repository review: verify working directory, branch, HEAD, git status and relevant implementation.
- If repository reality materially differs from the expected checkpoint, stop affected work and report Expected → Found → Impact → Recommended action.
- AGENTS.md remains repository-level control unless explicitly superseded.
- Claude Code or Codex is the normal implementation path; ChatGPT may implement if usage/tokens are unavailable.
- Every substantive coding-agent work package must state session mode, recommended model/effort, objective, authorised scope, prohibited actions, repository verification, tests and stopping condition.
- Do not auto-commit. Commits require explicit authorisation or an already-authorised work package.
- Never expose or commit credentials, tokens, private keys or unnecessary generated/local files.
- Once G3 golden path is achieved, resist architecture/feature churn.

## 19. Submission Package Checklist

| Artifact | Requirement |
|---|---|
| Functional project | Runs consistently and behaves as shown/described. |
| Public repository | GitHub/GitLab/Bitbucket; source, assets, setup/run instructions. |
| Open-source licence | Licence file visible at repository top level/About as required by Devpost. |
| Hosted demo or complete run instructions | At least one path enabling judges to actually interact with a working build. |
| Devpost text description | Problem, users, workflow, features, AI role, PayPal role, integrations, what is genuinely working. |
| Tools disclosure | Identify AI model/service and sponsor tools used and explain how each was used. |
| Demo video | Under 3 minutes; public YouTube; shows working end-to-end product. |
| PayPal evidence | Sandbox integration visible in demo/documentation; no simulated functionality described as integrated. |
| AI evidence | Inputs, structured outputs, operational consequence and validation/explainability visible. |
| Sponsor evidence | AG Grid, Bryntum and APIMatic use documented where genuinely implemented. |

## 20. Source Register

Competition sources below are authoritative for this plan. Product details elsewhere in this document come from the agreed FairShift direction unless explicitly marked as external technical reference.

| Source | URL | Used for |
|---|---|---|
| S1 — PayPal AI Hackathon Official Rules | https://paypalaihackathon.devpost.com/rules | Deadline, eligibility, project requirements, submission requirements, judging criteria, sponsor prizes. |
| S2 — PayPal AI Hackathon Overview | https://paypalaihackathon.devpost.com/ | Fundamental PayPal + AI requirement, submission checklist, demo/video/public-repository requirements. |
| S3 — Devpost Sponsor Resources | https://paypalaihackathon.devpost.com/resources | Official PayPal and sponsor resource directory. |
| S4 — AG Grid sponsor page | https://paypalaihackathon.devpost.com/details/aggrid | AG Grid/AG Studio sponsor positioning and prize eligibility. |
| S5 — Bryntum sponsor page | https://paypalaihackathon.devpost.com/details/bryntum | Scheduler/Calendar/Gantt sponsor capability and prize. |
| S6 — APIMatic sponsor page | https://paypalaihackathon.devpost.com/details/apimatic | PayPal Context Plugin and hackathon access/use. |
| S7 — PayPal Sandbox Testing | https://developer.paypal.com/sandbox-testing/overview/ | Sandbox behaviour and testing environment. |
| S8 — PayPal Payouts Overview | https://developer.paypal.com/payouts/overview/ | Payout capability and recipient use cases. |
| S9 — PayPal Payout Webhooks | https://developer.paypal.com/payouts/webhooks/ | Payout event/status webhooks. |
| S10 — PayPal Webhooks Guide | https://developer.paypal.com/api/webhooks/overview/ | Webhook listener and verification requirements. |
| S11 — Zettle APIs Overview | https://developer.zettle.com/docs/api | Available APIs, OAuth scopes and supported markets. |
| S12 — Zettle OAuth Overview | https://developer.zettle.com/docs/api/oauth/overview | Merchant authentication/authorisation and credentials. |
| S13 — Zettle Pusher API | https://developer.zettle.com/docs/api/pusher/overview | PurchaseCreated and real-time webhook subscriptions. |

## 21. Phase 0 Freeze Declaration

> **Freeze baseline**
>
> This document freezes the current FairShift competition product direction. LOCKED items may be implemented. OPEN and NEEDS VERIFICATION items must be resolved explicitly and recorded before implementation depends on them. DEFERRED items must not consume submission-critical time. Any material scope addition must be justified against competition compliance, judging value, golden-path strength, demo reliability and remaining time.

Immediate next action after approval: verify the canonical repository state, reconcile it against this Phase 0 baseline, then issue the first implementation work package for Phase 1 Foundation.
