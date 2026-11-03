# FairShift Roadmap Recovery

Package FS-ROADMAP-RESTORE-001. Baseline `main` at `94cedad`. Evidence labels follow `AGENTS.md` §8.

> **Superseded for commerce.** This document records that checkpoint and is otherwise unchanged. Square Sandbox has since replaced Zettle as the active commerce provider, and Square team-member attribution has replaced imported performance in the intended Golden Path. Current authority is `AGENTS.md` §4 and `docs/FAIRSHIFT_PRODUCT_UX_SPEC.md`.

> **Historical record, 1 November 2026. It does not direct new work.** Its recovery matrix and P0 list are overtaken: Zettle is inactive, a Paid state was proven locally ([`PAYPAL_FINAL_EVIDENCE.md`](PAYPAL_FINAL_EVIDENCE.md)), and hosted was released ([`HOSTED_RELEASE_002_EVIDENCE.md`](HOSTED_RELEASE_002_EVIDENCE.md)). It is not FS-HACK-ROADMAP-002. Current authority: [`FS-DOCUMENT-AUTHORITY-REGISTER.md`](FS-DOCUMENT-AUTHORITY-REGISTER.md), sections 1 and 2.

The approved product is commerce intelligence that turns into paid work:

Commerce data → historical intelligence → AI-interpreted demand forecast → labour requirement → staffing recommendation → manager planning → worker opportunity → acceptance → allocation → performance → incentive → manager approval → PayPal payout → commercial outcome.

## 1. Where the product had drifted

| What was approved | What the repository had at `94cedad` | Kind of drift |
|---|---|---|
| Zettle as the commerce input | No Zettle code. `ingestCommerceObservations` refused it, and the hand-off recorded "NO HEADROOM" | **Treated as out of scope** |
| Commerce intelligence in the foreground of the Owner product | Overview was four tiles, then a chart. Cost and labour required were absent, and the labour gap sat beside payment counts | **Watered down** |
| Economic implication of demand | No cost, comparable-sales or forecast-versus-actual figure anywhere | **Omitted** |
| Location drill-down | Absent. A test asserted that no location link existed | **Omitted and locked in by a test** |
| Public entry explains the proposition | "Plan work. Agree terms. Track earnings." | **Substituted**: read as a scheduling tool |
| AI reasons over commerce | The AI saw forecast, labour and gaps only, with no commercial context | **Watered down** |
| Owner sees what needs approval | Overview counted only the legacy `shift_incentives` table, so confirmed work awaiting approval showed as 0 | **Defect** |
| Sales page explains provenance | One line per source, with no freshness and no statement of what drove the forecast | **Watered down** |
| Incentives in Owner navigation | "Not available", although the Owner sets target and bonus on the Compensation page | **Contradictory** |
| Settings tells the truth about payouts | "USD incentive payouts" for a GBP business | **Contradictory** |
| AG Grid for factual sales detail | Not installed, not reported | **Omitted** |
| APIMatic evidence | Nothing in the repository | **Omitted** |
| Bryntum for allocation scheduling | Used, read-only, on the **trial** package with a visible watermark | **Partial** |
| Spec navigation for Manager and Worker | Manager has Today, Plan, Team, Review, not the seven spec areas. Worker has no separate Schedule or Performance | **Substituted**: the functions exist but are merged |

The quotation "Commerce intelligence in the foreground; operational complexity behind the glass" appears nowhere in this repository. The separate design authority is **NOT VERIFIED** here, so this work follows the quotation as given in the package and `docs/FAIRSHIFT_PRODUCT_UX_SPEC.md`.

## 2. Recovery matrix

| Capability | Reality now | Drift | Required restoration | Priority | Dependency | Hackathon value | Golden Path | Status |
|---|---|---|---|---|---|---|---|---|
| Zettle authentication | `src/server/integrations/zettle/client.ts`, assertion grant | Absent | Live proof with a merchant key | P0 | **Merchant account and API key (Ryan)** | Technological Implementation; PayPal ecosystem | Start of the path | Implemented, MOCKED; live endpoint only rejected placeholders |
| Zettle retrieval and normalisation | `connections.ts`, `zettle-adapter.ts`; paging, refunds excluded, idempotent | Absent | Real retrieval | P0 | As above | High | Start of the path | Implemented, MOCKED |
| Canonical boundary and provenance | `ZETTLE` source with a database constraint; generic import cannot claim it | Absent | Done | P0 | None | High | Commerce → history | **Done** |
| Forecast from connected commerce | Source rule v3: deep, recent Zettle sales win; thin or stale rejected with a reason | Absent | Done, needs real data | P0 | Merchant sales history | High | History → forecast | Done, MOCKED input |
| Commerce-to-labour economics | `commerce-labour.ts` | Omitted | Done | P0 | None | High: Potential Impact | Forecast → staffing → money | **Done** |
| Owner Overview | Six questions, then actions, then evidence | Watered down | Done | P0 | None | High: Design | Owner entry | **Done** |
| Owner Sales | Connection per location, source meaning, freshness, what drives the forecast | Watered down | AG Grid optional | P0 | None | High | Fact layer | **Done** |
| Owner Forecast | History → forecast → labour → gap → cost → AI | Partial | Done | P0 | None | High | Forecast | **Done** |
| Location drill-down | `/owner/locations/[locationId]` | Omitted | Done; shift-level links are still missing | P1 | None | High | Company → outlet | **Done** |
| AI commercial reasoning | Input v2, output v2, real model verified | Watered down | Done | P1 | `OPENAI_API_KEY` | High | Forecast → decision | **Done, VERIFIED locally** |
| Spelled-out figures in AI prose | Rejected like digits (found by a real response) | Gap | Done | P1 | None | Medium | Trust | **Done** |
| Forecast versus actual | Deterministic backtest on the chosen evidence | Omitted | Stored forecasts for true forecast-versus-actual | P2 | Time | Medium | Outcome | Backtest done; live NOT AVAILABLE |
| Actual labour cost | Confirmed casual pay only | Omitted | Regular wages are out of product scope | P2 | Product decision | Medium | Outcome | Partial, labelled |
| Worker attribution from Zettle | Imported path preserved; adapter reads no staff fields | Not attempted | See section 6 | P2 | Provider evidence | Medium | Performance | NOT VERIFIED |
| Owner sales CSV import | Boundary exists; no screen | Omitted | Small form on Sales | P1 | None | Medium: a fallback if Zettle access stalls | Commerce | **Missing** |
| Scheduled Zettle sync | Owner-pressed only | Scope kept small | Use the existing external scheduling pattern | P2 | Hosting | Low | Commerce | Missing |
| Zettle OAuth for any merchant | API-key path only | Scope kept small | Authorization-code flow | P3 | Zettle app registration | Low for the demo | Commerce | Post-hackathon |
| Paid end state on the current work model | A £12 payout stayed `ONHOLD` (recipient holds no GBP) | Evidence gap | One authorised Sandbox payout to a GBP-capable recipient | P0 | **Sandbox recipient (Ryan)** | High | Payout → confirmation | **Not proven** |
| PayPal subscription approval | Catalogue verified; no approved subscription on record | Evidence gap | One hosted Sandbox approval | P0 | Hosted migration approval | High | Commercial entry | NOT VERIFIED |
| Resend delivery | Adapter tested; no key in local env | Evidence gap | One real verification and one invitation email | P1 | Resend configuration | Medium | Onboarding | NOT VERIFIED |
| Bryntum licence | Trial, watermark visible | Partial | Confirm licence terms | P1 | Bryntum licence or sponsor terms | Sponsor value | Allocation view | Partial |
| AG Grid on Sales | Not installed | Omitted | Bounded package, section 5 | P2 | Licence check | Sponsor value | Sales detail | Reported, not installed |
| APIMatic | Nothing | Omitted | Bounded package, section 5 | P3 | Sponsor rule check | Sponsor value | None | Reported, not installed |
| Hosted release | `getafairshift.com` is up on an older build | Behind | Migrate 0011–0019, set `COMMERCE_CREDENTIAL_KEY`, deploy | P0 | **Approval (Ryan)** | Submission-critical | All | Not done |
| Spec navigation for Manager and Worker | Merged areas | Substituted | Decide: accept the merged form or split it | P2 | **Product decision** | Medium: Design | Manager, Worker | Open |

## 3. Commerce architecture

```
Zettle Purchase API        CSV / file (application level)     Reference generator
        │                               │                             │
 zettle-adapter.ts                      │                             │
 (identity, time, currency,             │                             │
  amount, refund marker only)           │                             │
        │                               │                             │
 ingestConnectedObservations   ingestCommerceObservations    persistCanonicalRows
        └───────────────┬───────────────┴─────────────────────────────┘
                        ▼
        sale_transactions (source, source system, source identity)
                        ▼
        loadDailySales → selectForecastSource (one history per outlet, never mixed)
                        ▼
        forecast → staffing → commerce-labour → Owner, Manager, AI input
```

| Source | Meaning | Synthetic | Provider-derived | Reconciled |
|---|---|---|---|---|
| `ZETTLE` | Retrieved from a connected merchant account | No | Yes | **No** |
| `PAYPAL_SANDBOX` | Verified Sandbox capture | No | Yes (test money) | Yes |
| `IMPORTED` | Supplied for the business | No | No | No |
| `REFERENCE` | Generated fictional retailer | Yes | No | No |
| `DEMO_SEEDED` | Legacy seed | Yes | No | No |

**Source precedence (rule v3), per location:** eligible Zettle, eligible PayPal Sandbox, sufficient imported, reference, demo. Provider history needs 28 days in the 56 to yesterday, three of each weekday, a sale in the last two days, and the location's planning currency. A disconnected or failing account goes stale, so it stops driving the forecast without any special case.

**Zettle decisions**

- **API-key connection, not OAuth.** Zettle documents the assertion grant for a merchant's own account. It needs no FairShift partner registration and no refresh-token rotation, which makes it the smallest correct path to a genuine connection.
- **One merchant account per location,** enforced across tenants by a database index, because the Purchase API has no location concept.
- **The key is sealed** with AES-256-GCM, bound to organisation and location. The access token lives only in memory for one sync. Disconnecting erases the sealed value and keeps retrieved history.
- **Refunds are excluded and counted, not netted.** Canonical history holds completed sales. So Zettle history is gross of refunds, and the product says so.
- **Failure is not zero.** A failed sync stores nothing new, does not advance the window, and is reported beside the location.

**Evidence level for the Zettle API:** the contract comes from Zettle's public documentation repository (`iZettle/api-documentation`, `authorization.md`, `purchase.adoc`). `developer.zettle.com` could not be read by the tooling used here. The only live contact was one request with placeholder credentials, which Zettle's token endpoint refused with an authentication-class response. **No real authentication or retrieval has succeeded.** The date format and paging behaviour are therefore documented, not observed.

## 4. Economic metrics

| Metric | Status | Kind | Notes |
|---|---|---|---|
| Historical sales, transaction count, average | Available | Recorded | Per source |
| Forecast sales and range | Available | Forecast | Range is not a confidence interval |
| Comparable sales, forecast delta | Available | Calculated | Latest observed matching weekdays, up to two weeks back; otherwise unavailable |
| Required labour, regular and allocated coverage, gap, indicative shifts | Available | Calculated, configured, recorded | Existing method |
| Recommended versus allocated casual | Available | Calculated | Need before allocations against allocated hours |
| Estimated casual cost | Available | Estimate | Gap priced on the location's own hourly or daily policies, shown as a range; no default rate |
| Casual cost / forecast sales | Available | Estimate | Unavailable at zero forecast. **Never total labour cost** |
| Forecast sales per planned labour hour | Available | Calculated | A plan, not a measurement |
| Backtest: forecast against what happened | Available | Backtest | At least 14 days with real comparable weekdays. On reference data it describes synthetic data only |
| Confirmed casual pay, paid amount | Available | Recorded | Paid only on PayPal `SUCCESS` |
| Attributed sales, attributed sales per unit of pay | Available | Recorded | Imported, not provider-verified; explicitly not causal |
| Total labour cost, labour % of sales | **Unavailable** | | FairShift does not hold regular wages |
| Actual sales per labour hour | **Unavailable** | | Actual hours are not recorded |
| Live forecast accuracy | **Unavailable** | | Forecasts are derived on read, not stored |
| Savings, return on investment | **Not calculated** | | Not supportable |

## 5. Sponsor integrations

| | Installed | Used | Licence | Product value | Effort and risk | Recommendation |
|---|---|---|---|---|---|---|
| **Bryntum** | Yes, `@bryntum/scheduler-trial@7.3.7` | Yes: `/manager/plan`, "Worker timeline", read-only | **Trial; watermark visible** | Real: it is the allocation view | Small to confirm licence. Editing is out of scope because it would create a parallel scheduling model | Keep. Confirm trial use is acceptable before recording the demo |
| **AG Grid** | No | No | Community licence terms **NOT VERIFIED** | Moderate: Sales "Latest days" and multi-location comparison are dense, and today use plain tables | About half a day for a Community grid on Sales; adds a client bundle to one Owner page. Low Golden Path risk | **Optional bounded package:** Community grid replacing the Sales daily table only, after the P0 items. Not installed here |
| **APIMatic** | No | No | **NOT VERIFIED** | Indirect: no user-visible module; the two PayPal clients are small and tested | About a day to generate and evaluate an SDK against the Payouts spec; replacing a working client would risk the Golden Path | **Do not replace the client.** Only pursue if a sponsor prize needs it, as a documented comparison |

## 6. Connected commerce and attribution

Location-level Zettle sales do not need worker identity, and the adapter reads none. The Zettle payload includes staff fields (for example a user display name), but whether they identify who earned a sale is **NOT VERIFIED**: a shared login would attribute every sale to one person.

The route that would stay truthful, if evidence supports it:

1. Prove with real data that the provider field is reliable for that merchant.
2. Have the Owner map provider users to FairShift workers explicitly. Nothing is inferred from names.
3. Store matches as attributed sales with their own provider and a distinct provenance value. The database currently allows only `IMPORTED_NOT_PROVIDER_VERIFIED`, so this would be a deliberate migration.
4. Keep the manager's confirmation before any amount is payable.

The imported path is unchanged and remains the working path for the MVP.

## 7. Product visibility

Screenshots are in `docs/evidence/fs-roadmap-restore-001/`, taken from a production build on a disposable PostgreSQL database: one fictional five-location company on labelled reference history. No console or server errors and no horizontal overflow occurred at the widths captured.

| # | File | Route | What the user sees | Decision | Data source shown | Integration visible | Missing or weak |
|---|---|---|---|---|---|---|---|
| 1 | `01-public-homepage.png` | `/` | The commerce-to-payment proposition in four steps | Start or join | None | PayPal named | Plain page; no product imagery |
| 2 | `02-owner-overview.png`, `02b-…-390.png` | `/owner` | Sales, demand, labour, gap, cost, actions, then chart and location table | Which outlet or gap first | Reference, labelled | None directly | No company view of AI on this page |
| 3 | `03-owner-sales.png` | `/owner/reporting` | Connection per location; history by source; what drives the forecast | Connect or sync; trust which history | Reference; each source explained | Zettle, not connected | Long list at five locations; no filters |
| 4 | `04-owner-forecast.png`, `04b-…-ai.png` | `/owner/forecast` | Forecast, staffing and commercial tables; AI priorities and implication | Where to staff first | Reference | OpenAI | Dense; many priorities |
| 5 | `05-location-drilldown.png`, `05b-…-390.png` | `/owner/locations/[id]` | One outlet from commerce through labour, cost and outcomes | Plan shifts here | Reference; imported attribution labelled | Zettle status, PayPal paid figure | No drill into a day or shift record |
| 6 | `06-manager-forecast-staffing.png` | `/manager/plan` | Week totals, cost, expected sales, day table | Which day to fill | Reference | OpenAI on request | Top of a long page |
| 7 | `07-fill-shifts.png` | `/manager/plan` | Requirements, responses, pool, timeline | Offer, allocate | Reference | **Bryntum, trial watermark visible** | Same page as 6, no separate navigation |
| 8 | `08-worker-offer-390.png` | `/worker/shifts` | Pay, bonus terms, accept or decline | Accept the work | Own offer | None | Good |
| 9 | `09-manager-performance-approval.png` | `/manager/review` | Confirmation, imported results, payables | Confirm, approve, send | Imported · not provider-verified | PayPal | Fixture stops short of sending |
| 10 | `10-worker-earnings-390.png` | `/worker/earnings` | Target reached, base + bonus, approved | None; understand pay | Imported, disclosed in words | PayPal named | Status badge is upper-case `APPROVED` |
| 11 | `09-manager-performance-approval.png` | `/manager/review` | Approval state and payout action | Approve, send | As 9 | PayPal | As 9 |
| 12 | `12-worker-payout-history-390.png` | `/worker/earnings` | Approved, not yet paid | None | Own record | PayPal named | **No paid state shown**: no payout was sent in this package |
| 13 | `13-zettle-connection-form.png`, `13b-zettle-real-rejection.png` | `/owner/reporting` | Connect form; Zettle's real refusal of placeholders | Connect | None | Zettle | No connected state from a real merchant |
| 14 | `14-paypal-configuration.png`, `15-owner-payments.png` | `/owner/settings`, `/owner/payments` | Subscription and payout configuration; payment states | Check subscription | Fixture subscription (a test fixture, not a PayPal approval) | PayPal | Status shown as a raw word; no webhook health |

## 8. Claims

**Unlocked**

- "FairShift has a Zettle integration boundary: connection, retrieval, normalisation and provenance are implemented and tested against a mocked client."
- "Connected sales enter the same pipeline, and forecast, labour and AI input change with no change to business logic." Tested with a mocked client.
- "Thin, stale, failed or other-currency connected data cannot displace other history or read as zero sales."
- "Owners see forecast demand, required labour, the casual gap, an estimated cost to fill it, and that cost against forecast sales, per location and company-wide."
- "AI gives a commercial interpretation over FairShift's calculated figures; any figure it cites must match exactly, and it may not state figures in prose." Verified with `gpt-6-luna` on reference data.
- "Forecast method backtested on the evidence it uses, with the result shown." On reference data this describes synthetic data.

**Still prohibited**

- "Zettle integrated", "live Zettle data" or "API-verified", until real authentication and retrieval succeed.
- Worker attribution from Zettle.
- Forecast accuracy as a general claim; savings, return on investment, or sales caused by a shift.
- Total labour cost or labour percentage of sales.
- Paid end-to-end on the current work model; approved PayPal subscription; delivered Resend email.
- Anything about the hosted build reflecting this work.
- AG Grid or APIMatic integration; a production Bryntum licence.
- Semantic verification of AI wording: figures and references are checked, meaning is not.
