Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Square Earnings to PayPal Sandbox Payout Evidence

**Result: one genuine PayPal Sandbox payout of GBP 121.00 reached item `SUCCESS`, and FairShift recorded it as `PAID`.** The payout came from a payable built on genuine Square Sandbox sales attributed to a mapped worker, and a Manager approved it. It ran locally on a production build against a scratch database. It is test money: not production PayPal, and not deployed.

**The limit that matters:** the Square payments named the team member through the API. Nothing here shows that a physical till identifies the logged-in worker.

## 1. Genuine evidence and fixtures

| Evidence | Source |
|---|---|
| Sections 3 to 7 | **GENUINE PROVIDER EVIDENCE**: PayPal Sandbox and Square Sandbox, driven through the browser on 2026-11-01 |
| `tests/integration/paypal-final.test.ts`, `tests/integration/work-payouts.test.ts`, `tests/unit/paypal-payout-client.test.ts` | **TEST/FIXTURE EVIDENCE**: stand-in PayPal and Square clients, no provider contact |
| The business and its people | Fictional, in a scratch PostgreSQL database |

## 2. Repository and timing

Started from branch `fs-square-live-001`, HEAD `8186aea`, clean. There is no new migration.

**Completed-shift timing:** no clock facility was added, and no production rule changed. The work came from a shift that really ran and ended, created by the existing Sandbox demo tool on the locked terms: 04:45–04:52 UTC on 2026-11-01. Work was confirmed after that real end, and sales were confirmed after a later Square sync, under the normal rules.

This was not the 14:00–20:00 window, so that rehearsal is still to be run.

## 3. Square performance used

Created by FS-SQUARE-LIVE-001 from genuine Square Sandbox payments ([evidence](SQUARE_LIVE_EVIDENCE.md)) and unchanged here.

| Item | Value |
|---|---|
| Provenance | `SQUARE_TEAM_MEMBER`, labelled "Square Sandbox attributed sales" |
| Attributed sales | 3 sales: £120.00, £79.99, £0.01 = £200.00 |
| Target | £200.00, reached |
| Bonus earned | £25.00 |
| Refund on record | A genuine £20 partial refund, retained as evidence. It doesn't change the result, under the MVP refund decision |

## 4. Payable and approval

| Item | Value |
|---|---|
| Terms | Daily, £96.00, from the accepted terms snapshot |
| Base + bonus | £96.00 + £25.00 |
| Approved | 12100 GBP minor units, by the Manager through "Approve £121.00" |
| Payouts before approval | 0 |

Audit order: `WORK_CONFIRMED`, `WORK_PERFORMANCE_CONFIRMED`, `PAYABLE_APPROVED`, `PAYOUT_RESERVED`, `PAYOUT_PROVIDER_RESPONSE`, `PAYOUT_STATUS_UPDATED`.

## 5. The payout

Environment: PayPal Sandbox, `https://api-m.sandbox.paypal.com`, which is fixed in code. Recipient: `s•••@personal.example.com`, a Sandbox personal account saved by the worker in Payment settings.

| Item | Value |
|---|---|
| Request | One `POST /v1/payments/payouts` from "Send £121.00 payout with PayPal" |
| Amount sent | `121.00` `GBP`, from the approved payable |
| Sender batch | `FSWP-B-E1BA4ED1892E41C0B7CD65F9BB96D96A` |
| PayPal batch | `YCXKPLF8JYNRJ` |
| PayPal item | `HHJF3JH4QNUG2` |
| Transaction | `7PD04400A6067962D` |
| PayPal fee | £2.42, reported by PayPal on the batch |

## 6. Reconciliation

| UTC | Source | PayPal batch | PayPal item | FairShift |
|---|---|---|---|---|
| 09:21:02 | Create response | `PENDING` | None returned | `PROCESSING` |
| 09:21:13 | Check payment status | `PROCESSING` | `PENDING` | `PROCESSING` |
| 09:21:32 | Check payment status | `SUCCESS` | `SUCCESS` | `PAID` |

A separate read-only `GET` of the batch afterwards returned item `SUCCESS` for GBP 121.00, which matches the approved amount. The payout was sent once (`attempts` 1), with no retry.

## 7. Duplicate payout

After `PAID`, the send button is gone. So the same send action was replayed over HTTP with the Manager's session, as a stale tab would send it, with a forged amount, currency and recipient added.

| Check | Result |
|---|---|
| Response | Redirect to `/manager/review?status=payout-already-sent` |
| Message | "This payment has already gone to PayPal, so no second payment was made." |
| Payout row | Unchanged, including `updated_at`: `PAID`, 12100 GBP, attempts 1 |
| Rows and audit | 1 payout, 1 `PAYOUT_RESERVED`, 1 `PAYOUT_PROVIDER_RESPONSE` |
| Worker replaying the same action (earlier build) | Redirected to `/account`, nothing changed |

The refusal happens inside FairShift, before any PayPal request. Concurrent sends are covered by tests with a fixture client, and were not sent to PayPal.

## 8. What the screens show

| File | Shows |
|---|---|
| `01-worker-payment-settings-390.png` | Masked payment details at 390px |
| `02-manager-review-before-approval.png` | Square Sandbox attributed sales, £200.00, £96 + £25, "Approve £121.00" |
| `03-manager-approved-before-payout.png` | Approved, payout not sent |
| `04-manager-payout-submitted.png` | Processing, not paid |
| `05-manager-paid-provider-reference.png` | Paid, with PayPal batch, item, transaction and status |
| `06-worker-earnings-paid-390.png` | Base £96.00, bonus £25.00, total £121.00, Paid, "PayPal confirmed" |
| `07-worker-home-paid-390.png` | "£121.00 paid" |
| `08-owner-payments.png` | Owner's payment record |
| `09-duplicate-payout-refused.png` | The refusal message |

Worker pages had no horizontal scroll at 390×844. `06` was captured on a taller viewport so that the phone navigation bar doesn't cover the figures. There were no browser console errors. The worker page shows no PayPal identifiers or recipient address.

## 9. Defects found

1. **`PAID` was not checked against the amount.** FairShift accepted item `SUCCESS` without comparing PayPal's amount. An item with another amount or currency, or none, now stays Processing, isn't resent, and tells the Manager why. This was fixed before the payout. The field was confirmed from a genuine read of an earlier payout, as `payout_item.amount`.
2. **A refused duplicate said "Changes saved".** No second payment was created, but the message was misleading. It now says no second payment was made.

## 10. Limitations

- A short real shift, not the 14:00–20:00 window.
- This one run started from an existing payable. Its Square steps ran earlier the same day, in FS-SQUARE-LIVE-001, on the same scratch data.
- Worker isolation and wrong-Manager refusals are test evidence, apart from the worker refusals seen in the browser. The scratch business has only one payout.
- No PayPal webhook was involved: status comes from the Manager's status check.
- The older $25 demo incentive payout path doesn't have the amount check. It isn't used here.
- Physical till identity, shared logins, production Square and production PayPal are **NOT VERIFIED**.

## 11. Claims

**Unlocked:** "FairShift demonstrated an end-to-end Sandbox flow in which genuine Square commerce evidence was attributed to a worker, FairShift calculated the worker's base pay and incentive, a Manager approved the resulting payable, and FairShift initiated and reconciled a genuine PayPal Sandbox payout."

**Still prohibited:** production money or production PayPal; a physical Square till identifying the logged-in worker; genuine Square history driving the forecast; anything about a hosted build.
