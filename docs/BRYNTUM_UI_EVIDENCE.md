Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Bryntum Scheduler and Product Surfaces Evidence

**Bryntum status: integrated with authoritative FairShift data, verified locally on a production build against a scratch database.** It has not been deployed. The package is the Bryntum trial, and its licence terms have not been checked here.

**Direction used:** the product specification and the work package. A separate approved demo-screen file was not found in the repository, so these screens have not been compared with one.

## 1. What changed

| Surface | Now |
|---|---|
| Manager navigation | Plan → Fill shifts → Allocations → Review are separate pages on a visible journey |
| Plan | Names the day needing most cover, regular staff plus gap, a chart of the week, AI priorities and "You decide" |
| Fill shifts | Keeps the staffing gap from Plan, and holds shift creation, Worker Pool, offers and responses |
| Allocations | Bryntum weekly and daily schedule with server-checked changes |
| Review | Work confirmed → Sales checked → Approve → Pay with PayPal, with counts, base + bonus and payout progress |
| Worker Home and Shifts | "Your shift target", from the worker's own attributed sales |
| Worker Earnings | Earned, Pending and Paid, each with base, bonus, total and state |
| Owner Overview | Not changed. It already leads with sales, forecast, labour, gap, cost and payments |
| Pricing | Not changed |

## 2. Scheduler authority

FairShift remains the authority. Bryntum has no data connection of its own: it displays server records, and every change goes through `rescheduleShift`.

| Shift state | Week or Day drag | Server rule |
|---|---|---|
| No live offers | Moves | Pay recalculated, new terms version, audited |
| Offered | Asks first | Old terms can no longer be accepted |
| Accepted, not finalised | Asks first | Acceptance returns to the worker; it can't be allocated on old terms |
| Allocated | Cannot be dragged | Refused even with a forged acknowledgement. **Change shift** needs an explicit acknowledgement, and the database rule then requires reacceptance |
| Finished, reviewed, cancelled | Cannot be moved | Refused |

The client sends only the shift, the terms version it saw, the proposed wall-clock times and whether the change was acknowledged. Any other field rejects the whole request, so a forged event can't set pay, a worker or a location.

**Week view moves a shift by day and keeps its hours.** Hours change only in Day view, in 15-minute steps. Without this, one drag moved a 09:00 shift to 00:00: the browser walkthrough found that, and no test had.

## 3. Browser proof

Production build, fictional business, real mouse input, browser in a different time zone from the location, no console errors.

| Action | Result |
|---|---|
| Drag an unoffered shift one day in Week view | Same hours on the next day, terms version 1 → 2 |
| Same drag from a second tab holding the older version | Refused with an explanation; the timeline shows the server's state |
| Resize in Week view | Nothing changed |
| Drag 2 hours in Day view | Exactly 2 hours later |
| Resize 1 hour in Day view | 9 hours; pay recalculated to £112.50 |
| Drag an accepted shift, then Keep | Nothing changed; offer stays accepted |
| Drag it again, then confirm | Terms version 2; offer returns to offered |
| Drag an allocated shift | Nothing changed |
| Change shift on allocated work, acknowledged | Terms version 2; allocation `REACCEPTANCE_REQUIRED` |
| Worker opens `/manager/allocations` | Sent away; no schedule shown |
| 390 px, Manager Allocations and all Worker pages | No horizontal page scroll |

## 4. Automated tests

`tests/integration/schedule-authority.test.ts`, `tests/unit/allocation-model.test.ts`, and existing journey tests updated for the new routes. No assertion protecting payment truth was weakened: two caught the first version of the payment progress printing "Paid" as a future step, and the component was changed instead.

| Case | Covered by |
|---|---|
| Another location, tenant or a worker changing a shift | Refused |
| Worker opening the Manager scheduler | Refused |
| Other workers and locations in schedule data | Absent |
| Overlapping work, unavailable day, inactive worker | Refused |
| Duplicate or conflicting allocation | Existing journey tests |
| Drag or resize in a disallowed state; accepted terms changed without reacceptance | Refused |
| Stale view, forged payload, cross-tenant worker ID | Refused |
| Offer sent, or shift cancelled, while the schedule is open | Refused |
| Clock-change time; moves across a clock change; overnight shift | Covered |
| Refused change reconciles in the UI | Browser walkthrough only |

## 5. Verification

Scratch PostgreSQL 15, migrations `0000` to `0019` from zero. No hosted system was touched, and no PayPal payout or subscription was created.

| Check | Result |
|---|---|
| Full suite on the committed code, run 1 | 508 of 508 passed |
| Full suite on the committed code, run 2 | 508 of 508 passed |
| Typecheck, lint, `smoke:manager`, production build, `git diff --check` | Passed |
| Secret pattern scan of the diff and new text files | 0 matches |
| One drag on the final build | Moved a day, kept its hours; no console or server errors |

**Earlier runs in this package** failed before the final pair. One failure, `work-payables`, in both runs, was a test still expecting the old Earnings wording; its assertions were rewritten for the new layout. The other was a single 5s timeout in `work-payouts` (5.7s; about 1s normally).

**Timeouts.** Across this work, three different tests have each timed out once during full-suite runs, with no failed assertion, and each passes in isolation. The timeout setting was not changed. **Treat a single 5s timeout in a full run as possible, and re-run it rather than assuming a pass.** The cause is **NOT VERIFIED**, apart from one run that overlapped a machine hibernation.

## 6. Limitations

- **Paid, held and failed in the browser:** only Approved was walked through, because no payout was sent. Those states are covered by automated tests with a stubbed provider. `Paid` reads as such only on PayPal's confirmation.
- **Worker target evidence is imported.** It is labelled `Imported · not provider-verified`. Zettle does not drive it.
- **Worker transaction activity is not shown.** Repository rules limit workers to their own aggregates, so the target shows count and value only.
- **Regular staff are not rows on the schedule.** They appear on Plan. The specification mentions regular coverage here as well, so this is a gap against it.
- **Manager Allocations at 390 px** works, but Week view scrolls sideways. Worker pages are the mobile priority.
- **Short state labels** on week bars ("Alloc", "Acc") are abbreviations for space. The full wording is on hover and in the details.
- **Email to workers after a change** uses the existing dispatcher. Delivery was not exercised, because no email provider is configured locally.

## 7. Claims

**Supportable:** Bryntum Scheduler is FairShift's Manager allocation view. Managers can move shifts that nobody has accepted, and any change to accepted terms requires the worker to accept again. FairShift's server checks every change.

**Prohibited:** production deployment, a licensed Bryntum build, provider-verified worker performance, automatic or AI rostering, AI setting pay, payroll or timesheets.

## 8. Evidence

`docs/evidence/fs-bryntum-ui-001/`:

| File | Shows |
|---|---|
| `03-bryntum-weekly-allocations.png` | Week view with all states |
| `04-selected-allocation-detail.png` | Selected allocation details |
| `05-move-accepted-needs-confirmation.png` | Confirmation before moving accepted work |
| `06-change-shift-requires-reacceptance.png` | Change shift result |
| `07-stale-refused-and-reconciled.png` | Stale change refused |
| `08-manager-plan.png` | Plan |
| `09-fill-handoff.png` | Staffing gap carried into Fill shifts |
| `10-manager-review-pay.png` | Review and payment progress |
| `12-worker-home-live-target-390.png` | Worker target at 390 px |
| `13-worker-shift-offer-390.png` | Worker offer at 390 px |
| `14-worker-earnings-390.png` | Worker earnings at 390 px |
| `15-owner-overview.png` | Owner Overview |
| `16-bryntum-day-view.png` | Day view |
