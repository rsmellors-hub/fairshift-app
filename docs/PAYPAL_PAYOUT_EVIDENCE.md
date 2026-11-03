# FS-PAY-002 Evidence

> **Historical evidence, 31 October 2026. It does not direct new work.** The £12.00 payout below stayed `ONHOLD`. A later genuine GBP 121.00 Sandbox payout reached item `SUCCESS` and `PAID` locally ([`PAYPAL_FINAL_EVIDENCE.md`](PAYPAL_FINAL_EVIDENCE.md)), which overtakes this record's "not proven" and "still prohibited" lists for that local run. Current authority: [`FS-DOCUMENT-AUTHORITY-REGISTER.md`](FS-DOCUMENT-AUTHORITY-REGISTER.md). The body below is unchanged.

Manager approval of confirmed work payables and their genuine PayPal Sandbox payout:
confirmed work → base payable → manager approval → approved payable → PayPal Sandbox
payout → persisted PayPal identifiers and status → worker payout visibility.

Evidence labels follow `AGENTS.md` §8. Every time is UTC unless stated otherwise.

**Summary.** FairShift approved a £12.00 GBP base payable and initiated one genuine
PayPal Sandbox payout of exactly £12.00 GBP. PayPal accepted it and returned batch,
item and transaction identifiers. PayPal currently holds the item (`ONHOLD`), because
the recipient Sandbox account does not hold GBP. FairShift persists and shows this as
processing. **The payout has not completed and the worker has not been paid.**

## Repository checkpoint

| Item | Value |
|---|---|
| Start branch / HEAD | `main` / `bdc3eb5` (clean) |
| Latest migration at start | `0013_work_payables` |
| Implementation commit | `bc087de` feat: add approved PayPal payout workflow |
| Follow-up commit | Shows PayPal's hold reason and the worker's next step; adds this document (`git log -1`) |
| Migration added | `0014_work_payouts` |
| Tests at start | 292 |

**Pre-implementation test verification.**

- Run 1 on the committed tree: 292/292 in 198 s.
- Run 2: also 292/292, but implementation edits had begun during it.
- Run 2 was therefore repeated on a pristine `bdc3eb5` worktree: 292/292 in 200 s.

The FS-PAY-001 repeated-suite gap is **CLOSED**.

## Official PayPal documentation verified

All sources were accessed on 31 Oct 2026.

| Source | What it establishes |
|---|---|
| [Payouts API reference](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/) | Create: `POST /v1/payments/payouts`. Batch status: `GET /v1/payments/payouts/{id}`. Item status: `GET /v1/payments/payouts-item/{id}`. |
| [Official OpenAPI specification `payments_payouts_batch_v1.json`](https://github.com/paypal/paypal-rest-api-specifications) (PayPal's own repository) | See the detail below the table. |
| [Payouts integration guide](https://developer.paypal.com/docs/payouts/standard/integrate-api/) | Requires a business (sender) account. Retry after a 5xx with the same `sender_batch_id`. `PayPal-Request-Id` provides idempotency. To pay in a currency, set `currency`. |
| [Currency codes](https://developer.paypal.com/reference/currency-codes) | GBP is listed, with no restriction footnote. |
| [Payouts fees and transaction limits](https://developer.paypal.com/payouts/fees/) | GBP limits: 50,000 for registered recipients and 15,000 for unregistered. |
| [Payouts currency conversion](https://developer.paypal.com/docs/payouts/standard/reference/currency-conversion/) | PayPal converts into the recipient's primary currency. GBP is exchangeable. |

What the OpenAPI specification establishes:

- **Sandbox server:** `https://api-m.sandbox.paypal.com`.
- **`sender_batch_id`:** PayPal "does not process duplicate payouts". A `sender_batch_id` used in the last 30 days is rejected, with a link to the original. After a 5xx the request "can safely retry … with the same `sender_batch_id`". PayPal "completes a payment only once for a `sender_batch_id`" within 30 days.
- **`PayPal-Request-Id`:** keys are stored for 30 days.
- **`recipient_type`:** `EMAIL`, `PHONE`, `PAYPAL_ID`.
- **`purpose`:** optional on `payout_item_request`; it includes `SERVICES` ("Payouts for services provided").
- **Batch statuses:** `DENIED`, `PENDING`, `PROCESSING`, `SUCCESS`, `CANCELED`.
- **Item statuses:** `SUCCESS`, `FAILED`, `PENDING`, `UNCLAIMED`, `RETURNED`, `ONHOLD`, `BLOCKED`, `REFUNDED`, `REVERSED`.
- **Create response:** returns `batch_header` only, with no items. Item IDs come from a later status read.

Not re-read this session: the OAuth client-credentials documentation. OAuth is instead
verified by the genuine call below, which needed a token.

Documentation shows only that GBP is a supported Payouts currency. **The genuine
Sandbox transaction is the evidence that this configuration accepts a GBP payout.**

## Existing PayPal architecture

REPOSITORY EVIDENCE.

**Reused, with no second integration:**

- `PayPalPayoutClient` (`src/server/integrations/paypal/payout-client.ts`);
- its OAuth token cache;
- `getPayPalPayoutConfig`, which accepts `PAYPAL_ENVIRONMENT=sandbox` only, with the base URL hard-coded to Sandbox;
- the existing factory.

**Why the earlier path was demo-only and USD-only:**

- the client hard-coded `currency: "USD"` and incentive wording;
- the only caller, `src/server/incentives/demo.ts`, pays the Rosebank demo incentive from `shift_incentives`, gated to the demo organisation and to `currencyCode === "USD"`.

**What changed in the client** (the smallest boundary):

- it takes the currency, an optional `purpose` and the email wording as input;
- it refuses any host other than Sandbox in its constructor;
- it returns `itemStatus`, `batchStatus`, `transactionId` and the item error code;
- it classifies each failure by whether a payout can exist.

The incentive request is unchanged: USD, no `purpose`, same wording.

**Not changed:**

- the demo incentive rail. It pays a different concept (an incentive), so it is not a competing truth for base pay.
- the existing inbound PayPal webhook (orders and captures). No payout webhook was built; status comes from an explicit refresh.

## Approval model

- `work_payables.status` is now `PENDING_REVIEW` or `APPROVED`. The transition happens once and is one-way.
- Approval records `approved_at`, `approved_by` (the user), `approved_amount_minor` and `approved_currency_code`.
- The database requires `approved_amount_minor = base_amount_minor` and `approved_currency_code = currency_code`. A trigger makes approval final and rejects inserting a payable that is already approved.
- **Who may approve:** `OWNER` or `MANAGER`, through `requireScope`, `assertRole` and `requireEntitlement`. The payable must be at the actor's organisation and location.
- A worker cannot approve. A worker identity cannot approve its own payable.
- The manager approves the calculated amount and cannot edit it.
- Each approval writes a `PAYABLE_APPROVED` audit event with the allocation, acceptance, terms version and amounts.
- **Extension point:** a future approved incentive would make the final payable "base + incentive". The approval check is the single place that would change. No incentive logic exists.

## Approved amount integrity

- The payout amount and currency are copied from the approved payable when the payout is reserved.
- A trigger requires the payout's amount, currency, organisation, location and worker to match the `APPROVED` payable, and makes them immutable afterwards.
- Nothing is recalculated at payout time from the shift, policy, rate or the request.
- The server actions take only `payableId`. Extra `amount`, `currency` and `recipient` form fields are ignored (tested).

## Recipient model

- The recipient is `workers.paypal_payout_email`, set through the worker's own Profile → Payment settings action (`savePayoutDestination`).
- If it is missing, the payout is refused with `PaymentDetailsRequiredError` before any reservation or PayPal call. Manager and worker see "Payment details required" with a link to Profile.
- At reservation the recipient is copied to `work_payouts.recipient`, so any reconciliation resends the identical request even if the worker later changes their email.
- The recipient is shown neither to managers nor in audit metadata.

## Currency integrity

- The GBP payable was sent as `{ "value": "12.00", "currency": "GBP" }`.
- There is no FX and no USD fallback. Currencies without two decimal places (for example JPY) are refused before reservation rather than guessed.
- The reference company stays in GBP.

## GBP verification

**VERIFIED: PayPal Sandbox accepted a GBP payout from this configuration.** It returned
a batch, item and transaction, and did not reject the currency.

**NOT VERIFIED: a GBP payout reaching `SUCCESS`.** See [Genuine Sandbox payout](#genuine-sandbox-payout).

## PayPal request model

One batch with one item:

- `sender_batch_id` = `FSWP-B-<payable id>`;
- `sender_item_id` = `FSWP-I-<payable id>`;
- `PayPal-Request-Id` = the sender batch ID;
- `recipient_type: EMAIL`, with the receiver set to the saved recipient;
- the amount and currency of the approved payable;
- `purpose: SERVICES`;
- the generic wording "FairShift work earnings".

No performance, forecast or profile data is sent.

## Idempotency

| Layer | Protection |
|---|---|
| Database | Unique `work_payouts.payable_id`, so at most one payout per payable. Sender batch and item IDs, and the PayPal batch ID, are also unique. |
| Reservation | An `INSERT … ON CONFLICT DO NOTHING` is committed **before** PayPal is called. A repeat or concurrent request finds the row and returns it, without calling PayPal. |
| Deterministic IDs | Derived from the payable. Every retry reuses them, and PayPal pays a `sender_batch_id` at most once within 30 days. |
| Lifecycle trigger | `NOT_SENT` and `SUBMITTING` cannot hold a PayPal batch. Identifiers, once recorded, are immutable. |
| Tested | Repeats; four concurrent sends (one request); a direct duplicate insert (rejected); and repeat sends after `PROCESSING`, `PAID`, `FAILED` and `RECONCILIATION_REQUIRED` (no request). |

Allowed status transitions:

- `SUBMITTING` → `NOT_SENT`, `PROCESSING`, `PAID`, `FAILED` or `RECONCILIATION_REQUIRED`;
- `NOT_SENT` → `SUBMITTING`;
- `RECONCILIATION_REQUIRED` → `SUBMITTING`, `PROCESSING`, `PAID` or `FAILED`;
- among `PROCESSING`, `PAID` and `FAILED`, in any direction.

## Failure windows

| Window | Behaviour |
|---|---|
| The reservation commits, then PayPal is never reached (an OAuth failure, or a 401/403/429) | `NOT_SENT`. PayPal certainly made no payout. It can be sent again with the same IDs. |
| PayPal refuses the request (another 4xx) | `FAILED`, recording the code, HTTP status and debug ID. Never paid. It is not resent from FairShift. |
| A timeout, network failure, 5xx, or unreadable 2xx | `RECONCILIATION_REQUIRED`. It is never resent automatically, and a repeated Send does nothing. |
| PayPal succeeds, then the local update fails or the process stops | The row stays `SUBMITTING`. After 2 minutes, Check payment status treats it as unknown. |
| PayPal reports a duplicate `sender_batch_id` | The original batch linked in the error is adopted and read. |

**Reconciling an unknown outcome.** When a manager checks the status, FairShift repeats
the **identical** request: same sender IDs, amount, currency and recipient. Under
PayPal's documented contract this is processed at most once, so it returns or reveals
the original. It does not send a new payment.

During such a reconciliation, a refusal or a request that never left keeps the payout
in reconciliation. It cannot prove that the first request did not pay.

## Status mapping

`payoutStatusFromProvider` maps PayPal statuses as follows. **Paid is item-level `SUCCESS` only.**

| PayPal | FairShift |
|---|---|
| Item `SUCCESS` | `PAID` |
| Item `FAILED`, `RETURNED`, `BLOCKED`, `REFUNDED` or `REVERSED` | `FAILED` |
| Item `PENDING`, `UNCLAIMED`, `ONHOLD`, or an unrecognised status | `PROCESSING` |
| No item, batch `DENIED` or `CANCELED` | `FAILED` |
| No item, any other batch status, **including batch `SUCCESS`** | `PROCESSING` |

These persisted fields are stored separately:

- `paypal_batch_status`;
- `paypal_status` (item);
- `paypal_batch_id`, `paypal_item_id`, `paypal_transaction_id`;
- `last_error` (a structured code, HTTP status and debug ID only);
- `submitted_at`, `status_checked_at`, `paid_at`.

User-facing labels: Awaiting approval, Approved, Processing ("· on hold at PayPal",
"· awaiting PayPal claim"), Paid, Needs attention, and Payment status being confirmed.

## Reconciliation

- Managers use **Check payment status** (`refreshWorkPayout`).
- With a PayPal batch ID it only reads the batch (`GET …?fields=items`). It never creates.
- `ONHOLD` and `UNCLAIMED` stay `PROCESSING` and can be checked again at any time. A later `SUCCESS` moves the payout to `PAID` (tested).
- A failed status read leaves the recorded status unchanged.

## Genuine Sandbox payout

| Item | Value |
|---|---|
| Environment | PayPal **Sandbox** (`https://api-m.sandbox.paypal.com`, `PAYPAL_ENVIRONMENT=sandbox`) |
| Application | Local production build (`next start`) against a disposable PostgreSQL 15 database. No hosted database was used. |
| Origin | Shift → offer → acceptance → allocation → confirmation → payable → approval, all through the UI. Only identities, a UK location (Europe/London) and an active subscription were seeded. |
| Local payable | `81fae8a0-f9e9-4ec8-a98f-c11c54277786`: hourly £12.00 × 1 h, terms version 1, `APPROVED` 12:49:57 by the Manager. Approved amount 1200 GBP. |
| Local payout | `9313653b-6af1-4288-bb63-4f4a0c7c66bc`. Reserved 13:03:43.185. Attempts: **1**. |
| Sender IDs | `FSWP-B-81FAE8A0F9E94EC8A98FC11C54277786` / `FSWP-I-81FAE8A0F9E94EC8A98FC11C54277786` |
| Recipient | The worker's saved PayPal Sandbox personal account (`***@personal.example.com`), entered by the product owner through Profile → Payment settings |
| Amount and currency | **£12.00 GBP** (1200 minor units). Currency was not converted. |
| PayPal batch ID | `LPSNMYGEM4C56` |
| PayPal item ID | `2SZDLPPLYB6DG` |
| PayPal transaction ID | `3GF78853U2990772W` |

An earlier attempt to save the fixture login address as the recipient was caught before
any request. It is not a Sandbox account, so no payout was sent until a real Sandbox
personal account was saved.

### What FairShift initiated

VERIFIED (application, database and audit):

- one `POST /v1/payments/payouts` from the manager's **Send £12.00 payout with PayPal** action, at 13:03:43–45;
- audit trail: `PAYOUT_RESERVED` (attempt 1, 1200 GBP, the sender IDs), then `PAYOUT_PROVIDER_RESPONSE` (mode FIRST, no error, batch `LPSNMYGEM4C56`).

### What PayPal confirmed

VERIFIED (API responses persisted by FairShift):

| Time | Call | PayPal reported | FairShift state |
|---|---|---|---|
| 13:03:45 | Create | Batch `LPSNMYGEM4C56`, `batch_status: PENDING` | `PROCESSING` |
| 13:04:05 | Status read | Batch `PROCESSING`. Item `2SZDLPPLYB6DG`, transaction `3GF78853U2990772W`, `transaction_status: ONHOLD`, item error `PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE` | `PROCESSING` |
| 13:43:12 | Status read (reconciliation) | **Batch `SUCCESS`, item still `ONHOLD`** with the same error | `PROCESSING` (`paid_at` null) |

The last row shows why only item-level status is trusted. The batch reached `SUCCESS`
while the worker's item did not.

### Reported from the PayPal Sandbox interface

NOT VERIFIED by FairShift. The product owner reported these from the PayPal Sandbox interface:

- funding source `BALANCE`;
- activity ID `9R271032U12628306`;
- PayPal fee £0.24 GBP;
- the message that the payout is pending because the recipient reviews credits in this currency;
- the recipient account received the £12.00 GBP transaction with an **Accept** control;
- the Sandbox transaction list later showed it as **Unclaimed**.

The API item status at 13:43:12 was `ONHOLD`.

### Why the payout is non-terminal

The recipient Sandbox account does not hold GBP. It is configured to review, and accept
or deny, credits in currencies it does not hold
(`PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE`).

**Recipient-side limitation:** PayPal Sandbox returned
`PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE`, and the available recipient
Sandbox UI did not allow the GBP holding/preference state to be resolved.

The product owner chose to leave the payout as it is. No payout was sent, retried,
cancelled or replaced afterwards, and no USD alternative was tried.

### What was NOT proven

- That this payout reaches item `SUCCESS`, or that the worker received funds.
- That FairShift's genuine transition to **Paid** works. It is covered only by automated tests with a mocked provider.
- A GBP payout completing in Sandbox.
- Production or live payouts.
- Payout webhooks. None were built.

## Persisted FairShift state

VERIFIED after reconciliation at 13:43:12:

| Field | Value |
|---|---|
| Payable | `APPROVED`. Base 1200 GBP, approved 1200 GBP, unchanged. |
| Payout | `PROCESSING`, 1200 GBP, attempts 1 |
| PayPal statuses | Batch status `SUCCESS`; item status `ONHOLD` |
| `last_error` | `{"code":"PENDING_RECIPIENT_NON_HOLDING_CURRENCY_PAYMENT_PREFERENCE"}` |
| Timestamps | `submitted_at` 13:03:45.281; `status_checked_at` 13:43:12.862; `paid_at` null |
| Rows | One `work_payouts` row; one `PAYOUT_RESERVED` and one `PAYOUT_PROVIDER_RESPONSE` audit event |

Reconciliation created no payout, no provider create request and no amount change.

## Manager workflow

On Manager → Review, under "Payments & approvals · confirmed work":

1. **Confirm work.**
2. **Approve £12.00.**
3. **Payment details required**, until the worker saves a PayPal email.
4. **Send £12.00 payout with PayPal.**
5. **Check payment status.**

Totals are shown per currency: Awaiting approval, Approved · not yet paid, and Paid · confirmed by PayPal.

In the current state (VERIFIED in the browser):

- the badge reads **"Processing · on hold at PayPal"**;
- the note reads: "PayPal is waiting for the worker to accept the payment in their PayPal account. Nothing is paid until PayPal reports success";
- the only action offered is **Check payment status**.

The "PayPal Sandbox reference" disclosure shows:

- amount sent: £12.00;
- batch `LPSNMYGEM4C56`, item `2SZDLPPLYB6DG`, transaction `3GF78853U2990772W`;
- PayPal status `ONHOLD`, with the PayPal reason code;
- the time last checked.

## Worker workflow

VERIFIED in the browser:

- **Earnings:** the row reads "£12.00 base payable · £12.00/hour × 1 hour scheduled · work confirmed · PayPal is holding this payment: check your PayPal account to accept it", with the badge **"Processing · on hold at PayPal"**.
- **Totals:** "Approved · payment not yet confirmed £12.00"; "Paid · confirmed by PayPal: None".
- **Home:** "£12.00 sent to PayPal · processing".
- No Paid badge appears anywhere.
- No provider IDs, codes or recipient address are shown. The worker sees only their own payable.

**Owner → Payments:** "Work earnings payments · Leeds Briggate · Casey Verify · £12.00",
with the badge "Processing · on hold at PayPal".

**Dispute:** the worker copy says "Questions about a payment? Ask your manager". No
dispute system was built (the rules are OPEN).

## Security

| Area | Control |
|---|---|
| Tenant and location | The payable is read by organisation and location. Tested as denied: another location in the same organisation, another organisation, a forged organisation scope, and the cross-tenant location. |
| Worker | `TEAM_MEMBER` is denied by role. Self-approval is denied. Workers read only their own payout fields. |
| Request input | Server actions accept `payableId` only. Amount, currency and recipient come from the database. |
| Secrets | Credentials stay server-side in `.env.local`, which is gitignored. Nothing was printed or committed, and a staged-diff scan matched neither credential. Provider errors are logged as status, code, debug ID and field/issue only. |
| Sandbox only | Hard-coded Sandbox URL, `PAYPAL_ENVIRONMENT` literal `sandbox`, and a client constructor that rejects any other host (tested). |

## Schema/migration

`drizzle/0014_work_payouts.sql` is additive:

1. **`work_payables`:** four nullable approval columns; the status check widened to `APPROVED`; the approval-integrity check.
2. **`work_payouts`:** a new table with its foreign keys, unique indexes, and status, amount, provider and paid checks.
3. **Triggers:** the `CREATE OR REPLACE` of the payable integrity function (all 0013 rules plus final approval), and the new `fairshift_work_payout_integrity` trigger.

It rewrites no data. A preservation test applies 0000–0013 to real seeded rows, applies
0014, and shows them unchanged, still `PENDING_REVIEW`, with no payout created.

The full chain 0000–0014 also applied cleanly to the disposable PostgreSQL 15 database.

## Tests

| Area | Where |
|---|---|
| Client: currency and purpose passthrough, incentive unchanged, outcome classification (no token, 401/429, 400, timeout, 5xx, non-JSON, malformed 2xx, duplicate with link), item/transaction parsing, Sandbox-only constructor | `tests/unit/paypal-payout-client.test.ts` |
| A–P: approval; authorisation; amount immutability after a policy edit; GBP; recipient required; request fields; concurrent idempotency; not sent; rejected; unknown and reconciliation; duplicate adoption; interrupted submission; intermediate, reversed and status-read-failure states; worker privacy; no network; database constraints and lifecycle; server actions ignoring client money; manager, worker and owner rendering; the `ONHOLD` explanation | `tests/integration/work-payouts.test.ts` (15 tests) |
| 0014 preservation | `tests/integration/migration.test.ts` |
| Copy updates from FS-PAY-001 and the auth gate on the new actions | `work-payables`, `auth-request`, `owner-onboarding` (migration count 15) |

Results on the final tree:

| Check | Result |
|---|---|
| `pnpm test` | **310/310** twice in a row on an idle machine (197 s and 207 s) |
| Typecheck, lint (0 warnings), `next build`, `smoke:manager`, `git diff --check` | Pass |

**Earlier load-affected run.** A full run on the implementation commit had 4 failures
out of 309, all `Test timed out in 5000ms`, with no assertion failures. It took 441 s,
while another desktop process was using about 440% CPU.

The control: the same three files run alternately on pristine `bdc3eb5` and on the
implementation took 41.2 s against 44.0 s, then 20.5 s against 19.7 s. All passed with
the time limit lifted for diagnosis only. Timeouts were not raised in the repository.

## Browser verification

- **Setup:** headless Chrome over CDP; a local production build; a disposable database.
- **Widths:** 1366×768, 1024×768 and 390×844.
- **Pages:** manager Review, worker Earnings, Home and Profile, and Owner Payments.
- **Results:**
  - no horizontal page overflow;
  - no console errors and no server errors;
  - mobile navigation is present;
  - with real Tab key presses, every focused control showed a focus indicator. The only stops without one were `BODY`, where focus wraps past the last control.
- **States checked:** Awaiting approval → Approved with payment details required → Processing → Processing · on hold at PayPal.

## Golden-path advancement

| Step | Status | Evidence |
|---|---|---|
| 12 Manager approves the final payable | SUPPORTED | UI approval; approver, time, amount and currency persisted |
| 13 FairShift initiates a genuine PayPal Sandbox payout | SUPPORTED | Batch `LPSNMYGEM4C56` from the application action |
| 14 PayPal identifiers and status persist | SUPPORTED | Batch, item and transaction IDs, batch and item statuses, and reason, persisted and reconciled |
| 15 Worker sees payout status / confirmation | PARTIAL | The worker sees the truthful provider-backed status. A provider-confirmed Paid state was not reached genuinely. |

## Known limitations

- The verification payout is held by PayPal for the recipient's currency preference and has not completed.
- `FAILED` payouts cannot be resent from FairShift; a new attempt would need new sender IDs. Recovery needs the platform operator.
- No payout webhook exists. Status is refreshed by an explicit manager action.
- Shift entry and display still use Johannesburg time (FS-PAY-001 limitation). The verification shift was entered as 10:00–11:00 Johannesburg time, 08:00–09:00 UTC. The payable duration is correct.
- The demo incentive rail (`src/server/incentives/demo.ts`) still marks any submission error, including a timeout, as `FAILED` rather than unknown. It was not changed, because incentives are out of scope.
- Nothing is hosted. Migrations 0011–0014 have not been applied to any hosted database.

## Deferred work

- AI.
- Performance and incentives.
- Availability.
- Zettle.
- The local-time Fill Shifts UI.
- Deployment and hosted verification.
- A Sandbox payout to a recipient that accepts GBP automatically, to demonstrate a genuine Paid state.

## Claims register

**May now be claimed:**

- "FairShift initiates PayPal Sandbox payouts from approved worker earnings." This is VERIFIED for one GBP payout, which PayPal accepted and identified.
- "PayPal payout identifiers and status are persisted."
- "Workers can view their PayPal payout status." The status shown is read from persisted provider-backed state.
- "Managers explicitly approve the calculated payable before any payout; the amount sent is the approved amount, in its own currency."
- "Duplicate payouts of the same payable are prevented in the database and by PayPal's sender batch ID."

**Still prohibited:**

- That any worker has been paid, or that a FairShift work-earnings payout completed, in Sandbox or otherwise.
- That a GBP payout completed in Sandbox.
- Production or live-money payouts, and real worker payments.
- Zettle integration and real-time commerce.
- AI performance and incentive payouts.
- Hosted or deployed verification of this workflow.
