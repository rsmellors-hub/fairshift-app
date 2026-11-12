Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Opportunity to allocation journey: evidence

Scope: the middle of the golden path, from a forecast staffing gap to a worker's booked shift, on a disposable local database and a local production build. No hosted system was touched, and no PayPal request was made. The earlier ONHOLD Sandbox payout was not retried or replaced.

Evidence labels follow `AGENTS.md`. Unless stated otherwise, results below are **VERIFIED** by commands run on the final code.

## 1. Starting state

Baseline `a07a645`. Manager and Worker screens existed, but the journey needed shortcuts: shift times were parsed at a fixed `+02:00`, no availability concept existed, unactivated workers could be offered work, and the Worker view exposed planning language.

## 2. Gap map

| Stage | Before | After |
|---|---|---|
| Owner signup → subscription | PARTIAL | PARTIAL: needs configured email delivery (section 23) |
| Subscription → setup | WORKING by code and earlier evidence | NOT IN THIS PACKAGE; gate re-checked |
| Setup → Overview | WORKING | WORKING; unknown time zones now refused |
| Sales → Forecast | WORKING | WORKING, unchanged |
| Forecast → Staffing | WORKING | WORKING, unchanged |
| Staffing → Fill Shifts | PARTIAL: no context | WORKING |
| Fill Shifts → creation | BROKEN: wrong times outside SAST | WORKING |
| Shift → Worker Pool | PARTIAL: no clear states | WORKING |
| Pool → offer | PARTIAL: unavailable and unactivated not handled | WORKING |
| Offer → Worker | PARTIAL: dense, Manager language | WORKING |
| Worker → accept/decline | WORKING server-side, weak UX | WORKING |
| Acceptance → Manager | PARTIAL | WORKING |
| Manager → allocation | WORKING | WORKING |
| Allocation → Worker upcoming | PARTIAL | WORKING |
| Allocation → confirmed work | WORKING | WORKING, regression-tested |
| Worker payment setup visibility | PARTIAL | WORKING |
| Payout status → Worker | PARTIAL: provider wording | WORKING for visibility; recovery is a later package |

## 3. Time zone defect and correction

**Defect:** shift form values were read as `+02:00`, so a UK Manager's 10:00 was stored as 08:00 UTC, and displays were fixed to Johannesburg.

**Correction:** `localDateTimeToInstant(value, timeZone)` in `src/server/domain/timezone.ts` converts location wall-clock time using only the location's IANA zone. It refuses malformed values, impossible dates, times skipped by the clocks (`NONEXISTENT`), times repeated by them (`AMBIGUOUS`), and unknown zones. All shift displays now require the zone explicitly.

Unknown countries no longer default to Johannesburg when a location is created: the location is refused with a clear message.

Results for a 10:00 start: London winter 10:00Z, London summer 09:00Z, Johannesburg 08:00Z. The Johannesburg case needed no source change. The conversion was tested under four server zones, and the browser run used a Tokyo server with a New York browser against a London location. Cross-midnight, both clock changes and invalid input are tested.

## 4. Handoff

Gap days in the Manager's staffing table link to `Fill shifts` with the date. The form then shows required labour, regular coverage, allocated casual labour, gap, indicative shifts, the Owner's labour assumption and evidence date. Nothing is created until the Manager acts. A single-location Manager sees no location selector.

## 5. Shift creation

`RequirementForm` shows work, pay terms, location, local start and end, workers needed, duration and expected earnings. Its preview calls the same `expectedWorkEarnings` as the server, so there is no second calculator. The server recalculates and ignores any posted rate, location or currency.

## 6. Pay-policy enforcement

`createRequirement` refuses a policy from another tenant, a currency differing from the location's, a missing or zero rate, zero or negative duration, and non-whole earnings. Each has its own message, and nothing is stored on refusal.

## 7. Worker Pool

The pool lists only the location's workers, with one state from a shared rule (`src/server/scheduling/worker-pool.ts`): Available, Availability not provided, Unavailable, Already working, Awaiting activation or Inactive. Workers with an offer move to Responses, which covers the already-offered state. The same rule drives display and server enforcement.

## 8. Availability

Workers set a weekly pattern by day: Can work, Can't work or Not sure. Migration 0017 adds `worker_availability` and creates no rows, so existing workers stay "not provided". Those workers can be offered work and are labelled as such (Product Owner decision). A cross-midnight shift checks both local days in the location's zone. No reason is requested.

## 9. Conflict handling

Overlapping accepted work, or a stated Unavailable day, blocks offer, acceptance and allocation. Declining is never blocked. If availability changes after an offer, the Worker sees why and how to change it.

## 10. Offer model

Offers are persisted per worker and shift, duplicates are refused, and offers stay capped at the workers needed because over-invitation is an open product decision. Unactivated workers cannot be offered work since they could not see it. Incentives appear only when an amount exists.

## 11. Worker offer UX

Cards show what, where, local date and time, and earnings, with the rate basis and what happens next. Planning terms such as gap, coverage, allocation and payable do not appear (asserted in tests).

## 12. Immutable acceptance

Acceptance requires explicit acknowledgement and writes one immutable snapshot from server data. Posted rate, currency and earnings values are ignored. Repeats are idempotent, and accept-after-decline and decline-after-accept are refused. Changed terms require fresh acceptance against the new version, and the old acceptance is kept. Accepting creates no allocation. Finished-shift offers are closed to the Worker and refused at the Worker's authenticated entry point.

**Limitation:** `respondToAssignment` itself has no finished-shift rule, because fixtures and the seeded demo path accept past-dated work through it. Every real Worker request goes through `workerRespond`, which enforces the rule.

## 13. Allocation

The Manager sees Pending response, Accepted · ready to allocate, Allocated, Reacceptance required, Declined or Offer closed. Allocation needs an acceptance of the current terms version and re-checks scope, conflict and availability. Three concurrent requests produced one allocation.

## 14. Worker Home and Shifts

Home leads with live state: new offers, waiting for manager, next shift, payment setup, then earnings. Shifts groups the same records, and past or closed shifts collapse. Inbox notices were removed from Home because they kept saying "new offer" after a response; they remain under Account and notifications.

## 15. Payment readiness

Workers see "Payment details added" or "Payment setup incomplete. Add your payment details before your approved earnings can be sent." Copy states that FairShift has not checked the email with PayPal. Missing details do not block accepting work. Tests reject "verified" and "ready to receive" wording.

## 16. ONHOLD and not paid

A held or unclaimed payout shows "Action required" and a plain explanation to the Worker, with no provider code. It stays out of paid totals, and the Manager still sees the provider detail. Recovery guidance is not part of this package. Worker Home's earnings summary still says "sent to PayPal · processing" for a held payment, which is true but does not flag the action needed; that belongs with the recovery work.

## 17. Cross-role evidence

`tests/integration/opportunity-journey.test.ts` runs sales evidence → labour policy → gap → handoff → creation → pool → offer → Worker terms → acceptance → Manager view → allocation → Worker booked, through server actions and rendered pages on one set of records. The same journey was then run through the real UI in Chrome on the final build. Identities, sales history and rota were seeded for that run; every step of the journey itself was a real click.

## 18. Negative tests

| Area | Covered |
|---|---|
| Time zone | GMT, BST, Johannesburg, server zone differs, browser zone differs, cross-midnight, both clock changes, invalid, unknown zone |
| Location and security | Unauthorised location, other-location worker, cross-tenant worker, Worker A acting on B's offer, Manager on another location or tenant, posted location ignored |
| Eligibility | Unavailable, conflict, inactive, duplicate offer, availability missing, not activated |
| Shift | Zero duration, end before start, invalid compensation, wrong currency, foreign policy |
| Offer | Duplicate, wrong worker, wrong tenant, cancelled shift, changed terms, finished shift |
| Acceptance | Twice, decline twice, accept after decline, decline after accept, stale version, tampered rate/currency/earnings |
| Allocation | No acceptance, declined, duplicate and concurrent, overlap, wrong location, wrong tenant, changed terms, unavailable |
| Payment readiness | Missing, present, no verification wording, ONHOLD not Paid |
| UI | No offers, one, multiple, long names, small and large earnings, payment setup missing, waiting, booked, refresh after action |

## 19. Mutation evidence

Each change was applied to a disposable copy of the final code and caught by the journey or unit tests:

| Mutation | Failing tests |
|---|---|
| Fixed `+02:00` parsing | 4 |
| Cross-location offering | 1 |
| Client-supplied expected earnings | 1 |
| Acceptance auto-creates allocation | 2 |
| ONHOLD shown to Worker as Paid | 1 |
| Unavailable worker offerable | 4 |
| Unactivated worker offerable | 1 |
| Finished shift acceptable | 1 |
| Nonexistent local time mislabelled | 2 |
| Unknown zone defaulted | 2 |
| Worker label claims PayPal verification | 1 |

## 20. Security

Actions take scope from the session via `requireScope`. Offers are looked up by worker as well as ID. Availability writes require the Worker's own identity and an active entitlement, and the subscription gate test includes the new action. No secret, token or payer detail is added to logs or pages; the Worker sees a masked email only.

## 21. Mobile and browser

Local production build, disposable PostgreSQL, Tokyo server clock, New York browser clock.

- **Worker:** 5 areas for 2 workers at 390, 1024 and 1366 px, 30 checks: no horizontal overflow, nothing off-screen or clipped, and no target under 40 px at 390 apart from the 38 px logo link. Nav is one row of five. Accept and Decline are full width on the card.
- **Keyboard:** tabbing showed a 3 px outline on each stop checked. Accept is disabled, so skipped, until acknowledgement is ticked.
- **Manager:** Today, Plan and Review at 1366, 1024 and 390 px with no page overflow. Dense tables scroll inside their own containers below desktop width, and the Manager's mobile nav is 38 px high. Manager on a phone is usable but not optimised.
- **Errors:** no console or page errors in the final run.

Defects found and fixed by this pass: nav wrapping to two rows, stale notices on Home, raw fieldset borders on Availability, raw ISO dates and Sandbox wording in Earnings, a sales attribution code on Profile, narrow action buttons, cramped Fill shifts links, developer wording about capacity policy, and faint focus outlines missing on selects.

## 22. First-time Worker walkthrough

| Question | Answer |
|---|---|
| What needs attention? | Clear: Home leads with it |
| What is the work? | Yes |
| Where? | Yes |
| Local time? | Yes, labelled with the location |
| Earnings before accepting? | Yes, the largest text on the card |
| Accept without hunting? | Yes, on the card and on Home |
| Booked or waiting? | Yes, separate badges and "You're not booked yet" |
| Find an allocated shift again? | Yes, on Home and Shifts |
| Payment setup incomplete? | Yes, on Home with a link |
| Falsely provider-verified? | No |
| Paid while processing or held? | No |
| Dead ends? | None found |
| Desktop-only? | No |

This was walked by the implementer, not observed with a real first-time user.

## 23. Owner findings

Read-only walkthrough on the same build, PayPal credentials blank.

| Step | Rating | Finding |
|---|---|---|
| Landing and signup reachable | PASS | Get started → `/register` |
| Email verification | PARTIAL | No email provider is configured locally, so the page says delivery is not configured and verification stays pending. Hosted configuration NOT VERIFIED. |
| Plan selection | PASS | Plans and prices are understandable. Checkout showed as unavailable here because credentials were blank. Buttons say "Continue to PayPal Sandbox". |
| PayPal subscription | NOT RUN | No live PayPal in this package. Sandbox Products and Plans are recorded in `APPROVED_SUBSCRIPTION_CATALOGUE_EVIDENCE.md`; `SUBSCRIPTION_WORKPLACE_JOURNEY_EVIDENCE.md` records the hosted journey as NOT VERIFIED. |
| Subscription gating | PASS | Unsubscribed users are redirected from `/owner` and `/onboarding`. |
| Business setup and locations | PARTIAL | Works by test. Adding a location has no country or zone input, so an organisation with mixed zones and an unrecognised country is refused. |
| Reach Sales and Forecast | PASS | Overview, Locations and Forecast reached with data. |
| Owner → Fill shifts | Note | Owners see gaps but get no link to act on them. Manager path only. |

Open for an Owner Journey Closure package: email delivery configuration, time zone selection for countries beyond the UK and South Africa, and South African locations resolving to USD work policies while commerce may be ZAR.

**Worker activation has the same dependency:** invitation tokens reach people only by email and are never displayed. Without configured delivery, a new Worker cannot activate. Invitation transport remains an open product decision.

## 24. Downstream regression

A test runs allocation → confirmation → payable → approval → payout → status with a local stub adapter and a `fetch` spy asserting no network. After the Owner raised the policy rate, the payable and payout amount stayed at the accepted £96.00. A held status remained `PROCESSING` with no paid date. Existing payable and payout suites pass unchanged in intent, with fixtures now using activated workers.

## 25. Golden Demo impact

Forecast, staffing recommendation, Manager review, shift creation, Worker acceptance and allocation now run as one journey with no database step between them. Later stages are unchanged and regression-tested.

## 26. Limitations

- Sales history in the browser run was imported fixture data, not provider data. Zettle remains PLANNED / NEEDS VERIFICATION.
- The legacy seeded demo shift has a fixed date of 16 Oct 2026, so its offer now shows as Closed until a new cycle starts. The real journey is unaffected.
- Availability is a weekly pattern, with no date exceptions.
- Time zones resolve only for UK and South African countries, or from an organisation's single existing zone.
- Tests run on PGlite. The browser run used PostgreSQL 15. Concurrency was tested only at that level.
- A hosted environment was not used.

## 27. Claims unlocked

- A Manager at a location enters local times and Workers see the same local times, in London (GMT and BST) and Johannesburg, regardless of server or browser zone.
- A Manager moves from a staffing gap to a paid work opportunity with its context.
- Offers go only to eligible, activated workers at that location.
- Workers see what they will earn before accepting, and pay terms are server-authoritative.
- Acceptance and allocation are separate, explicit and idempotent.
- The Worker flow works at phone width in local testing.

## 28. Claims prohibited

- Zettle integration, or provider-verified sales.
- Verified PayPal recipients, or readiness to receive funds.
- That the ONHOLD Sandbox payout was paid, or that held-payment recovery exists.
- Hosted availability, or a verified hosted signup and subscription journey.
- Invitation or verification email working in any environment.
- Support for countries other than the UK and South Africa.
- Worker-level sales attribution, timesheets, attendance, overtime or payroll.
