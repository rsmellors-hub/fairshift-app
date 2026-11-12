Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# PayPal currency evidence (Sandbox only)

| Control | Value |
|---|---|
| Date | 8 November 2026 (all times UTC) |
| Environment | PayPal **Sandbox** only (`api-m.sandbox.paypal.com`, `www.sandbox.paypal.com`). No live endpoint was called |
| Repository baseline | Branch `fs-square-live-001`, HEAD `822c5fd`. Evidence recorded on branch `evidence/paypal-currency-tests` |
| Authorisation | Owner instruction given directly in the session ("PayPal currency evidence (sandbox only)"). It carries no work-package ID, and the authority register (section 2) shows no active package. Evidence only |
| Application code changed | **None.** The live subscription flow, the four USD subscription plans and all product copy are unchanged. Every probe ran from throwaway files outside the repository, or from a temporary test file that was deleted after the run |
| Redaction | Client ID, client secret, OAuth access tokens, PayPal's browser low-scope token and the test recipient address are redacted (`[REDACTED_…]`, `f•••@example.com`). PayPal `debug_id` values are kept, because they are diagnostic identifiers rather than secrets |
| Status terms | Per [`AGENTS.md`](../../AGENTS.md), section 8 |

> **Baseline note (added on rebase onto `submission`).** These probes ran against `822c5fd`. On `submission`, FairShift holds rand obligations and reaches PayPal through a USD amount converted once at a frozen ECB rate (DEC-SA-012), so the current product never sends `currency: "ZAR"` to PayPal. The result in section 3 describes PayPal's own behaviour, and the reason a conversion is needed. It does not describe a path the current product takes.

## Summary

| # | Question | Result | Status |
|---|---|---|---|
| 1 | Subscribe button: JS SDK v5 or v6? | **Neither.** No PayPal JS SDK is loaded. The button is a server action that calls the REST Subscriptions API and redirects to PayPal's `approve` link | REPOSITORY EVIDENCE |
| 2 | v6 `findEligibleMethods({ paymentFlow: "RECURRING_PAYMENT" })` + `isEligible("paypal")` | USD → `true`. ZAR → `true`. PayPal's API returned the same body for both: `{"eligible_methods":{"paypal":{"can_be_vaulted":true}},"supplementary_data":{"buyer_country_code":"ZA"}}` | VERIFIED (Sandbox, two runs) |
| 3 | Payout item with `amount.currency = "ZAR"` | **HTTP 400 `VALIDATION_ERROR`**: `items[0].amount.currency`, "Currency is not supported". FairShift recorded `FAILED`, with no paid date and no Paid badge. Exactly one PayPal request and one payout row; both repeat attempts were refused without calling PayPal | VERIFIED (Sandbox + FairShift service, in-memory DB) |
| 4 | Payout item with `recipient_wallet = "RECIPIENT_SELECTED"` | **HTTP 400 `UNSUPPORTED_RECIPIENT_WALLET`**: "not supported by your program". No batch was created, so the recipient was offered nothing | VERIFIED (Sandbox) |

---

## 1. Subscribe button: SDK version

**REPOSITORY EVIDENCE.** FairShift does not load the PayPal JavaScript SDK, in either the v5 (`paypal.com/sdk/js`, `paypal.Buttons`) or the v6 (`/web-sdk/v6/core`, `createInstance`) form.

- [`src/app/subscribe/page.tsx`](../../src/app/subscribe/page.tsx): each plan's "Approve in PayPal" button is a plain `<form action={startSubscriptionAction}>`.
- [`src/server/billing/paypal.ts`](../../src/server/billing/paypal.ts): `PayPalSubscriptions.create` calls `POST /v1/billing/subscriptions` server-side with `plan_id`, `custom_id` and `application_context` (`user_action: "SUBSCRIBE_NOW"`, `return_url` `/billing/return`, `cancel_url` `/subscribe?billing=cancelled`). `approvalLink` then accepts only an `https://www.sandbox.paypal.com` `approve` link, and the browser is redirected there.
- A search of `src/` and `public/` for `paypal.com/sdk`, `@paypal/`, `paypal.Buttons`, `createInstance` and `findEligibleMethods` found no matches. `package.json` has no PayPal SDK dependency.

This is a redirect integration: PayPal hosts the approval. The v6 guide's server half (`POST /v1/billing/subscriptions`, then verify `GET /v1/billing/subscriptions/:id` is `ACTIVE`) already matches what FairShift does. Only the browser half (an in-page v6 subscription session) is absent. **No migration was made.** It needs Owner approval.

## 2. Subscriptions eligibility (v6 web SDK)

### Method

- **Reference:** https://developer.paypal.com/subscriptions/integrate/v6.
- **Throwaway page:** stored in the job's temporary directory, outside the repository. It was served at `http://localhost:47613` and is not linked from FairShift. It loaded `https://www.sandbox.paypal.com/web-sdk/v6/core`, fetched the Sandbox client ID from its own `/client-id` route, then ran:

  ```js
  const sdkInstance = await window.paypal.createInstance({ clientId, components: ["paypal-subscriptions"], pageType: "checkout" });
  for (const currencyCode of ["USD", "ZAR"]) {
    const paymentMethods = await sdkInstance.findEligibleMethods({ paymentFlow: "RECURRING_PAYMENT", currencyCode });
    paymentMethods.isEligible("paypal");
  }
  ```

- **Browser:** headless Chromium (`chrome-headless-shell` 1243), driven over the DevTools protocol. Network traffic to PayPal was captured.
- **SDK version served by PayPal:** `https://www.sandbox.paypal.com/web-sdk/v6.72.0/paypal-subscriptions`.

### Results (verbatim)

Run 1, 15:39:30.989Z – 15:39:33.551Z:

| Time | Step | Value |
|---|---|---|
| 15:39:31.278Z | `isBrowserSupportedByPayPal()` | `true` |
| 15:39:31.818Z | `createInstance` | resolved |
| 15:39:32.811Z | `findEligibleMethods({ paymentFlow: "RECURRING_PAYMENT", currencyCode: "USD" })` | resolved |
| 15:39:32.811Z | `isEligible("paypal")`, USD | `true` |
| 15:39:33.228Z | `findEligibleMethods({ paymentFlow: "RECURRING_PAYMENT", currencyCode: "ZAR" })` | resolved |
| 15:39:33.228Z | `isEligible("paypal")`, ZAR | `true` |

Run 2, 15:40:02.013Z – 15:40:05.587Z, gave the same results: USD `true` at 15:40:05.029Z and ZAR `true` at 15:40:05.547Z.

The SDK turns each call into this PayPal API request (run 2, captured verbatim):

```http
POST https://api-m.sandbox.paypal.com/v2/payments/find-eligible-methods
{"preferences":{"payment_flow":"RECURRING_PAYMENT","payment_source_constraint":{"constraint_type":"INCLUDE","payment_sources":["PAYPAL"]}},"purchase_units":[{"amount":{"currency_code":"USD"}}],"merchant_info":{"merchant_origin":"localhost"}}
```

```http
POST https://api-m.sandbox.paypal.com/v2/payments/find-eligible-methods
{"preferences":{"payment_flow":"RECURRING_PAYMENT","payment_source_constraint":{"constraint_type":"INCLUDE","payment_sources":["PAYPAL"]}},"purchase_units":[{"amount":{"currency_code":"ZAR"}}],"merchant_info":{"merchant_origin":"localhost"}}
```

Both answered **HTTP 200** with this identical body:

```json
{"eligible_methods":{"paypal":{"can_be_vaulted":true}},"supplementary_data":{"buyer_country_code":"ZA"}}
```

A third `200` response to the same URL had no retrievable body. **INFERENCE:** it was the CORS preflight. Both bodies that could be read are identical, so the USD and ZAR results do not depend on which response is which.

### What this shows, and what it does not

- **VERIFIED:** PayPal's Sandbox eligibility service reports the PayPal wallet as eligible, and vaultable, for a `RECURRING_PAYMENT` flow in both USD and ZAR, for this Sandbox app. It placed the buyer in South Africa (`buyer_country_code: "ZA"`, from the request location; no country was supplied).
- **NOT VERIFIED:** that a subscription plan can be created or billed in ZAR. This is a buyer-side eligibility check. It did not create a ZAR product or plan, did not run a checkout, and charged no one. The existing USD plans were not touched.
- **NOT VERIFIED:** the result outside Sandbox, or for buyers outside South Africa.
- **Documentation note:** PayPal's subscriptions page uses `paymentFlow: "RECURRING_PAYMENT"` and the `paypal-subscriptions` component. The general JS SDK reference lists neither the `paymentFlow` option nor that component. The SDK accepted both, and sent `payment_flow` to the API as shown above.

## 3. Payout in ZAR

### Method

The payout went through **FairShift's own payment path**, not a hand-built request: `approveWorkPayable` → `submitWorkPayout` → the production `PayPalPayoutClient` against PayPal Sandbox. It ran in a temporary vitest file using the repository's in-memory PGlite database, which runs all migrations and triggers. That file was deleted after the run and never committed. A recording `fetch` passed to the client logged each HTTP exchange.

**Test-only seeding, disclosed:**

- FairShift has no ZAR path. `resolveLocationCurrency` maps UK countries to GBP and every other country to the default USD, and `createRequirement` refuses a work policy that is not in the location's currency.
- The test therefore used an organisation in "South Africa" (resolved by FairShift to USD) and changed **only the shift's `currency_code` to ZAR**, before any offer. FairShift's trigger bumped the shift's terms to version 2, and the worker accepted version 2.
- Offer, acceptance, allocation, confirmation, payable calculation, approval and payout then all ran unchanged.
- An earlier attempt to edit the payable's currency directly was refused by the database (`Work payable financial facts are immutable`), before any PayPal call.
- The payable ID was pinned to `7e57c0de-0000-4000-8000-000000000001` (the `7E57C0DE` "test code" prefix). FairShift derives its deterministic sender IDs from the payable ID, so the IDs below are test-tagged and identical on every retry.

**Recipient:** `f•••@example.com`, an unregistered test address. No FairShift Sandbox personal account was available locally. PayPal refused the request on currency, before any recipient check.

### PayPal exchange (verbatim, recipient masked)

15:44:19.717Z, `POST /v1/oauth2/token`: **200**, debug_id `ca575b2c1eab0` (token redacted).

15:44:21.171Z, `POST https://api-m.sandbox.paypal.com/v1/payments/payouts`, `PayPal-Request-Id: FSWP-B-7E57C0DE000040008000000000000001`:

```json
{"sender_batch_header":{"sender_batch_id":"FSWP-B-7E57C0DE000040008000000000000001","email_subject":"FairShift work earnings","email_message":"Your manager-approved FairShift work earnings have been sent to your PayPal account."},"items":[{"recipient_type":"EMAIL","amount":{"value":"78.00","currency":"ZAR"},"receiver":"f•••@example.com","sender_item_id":"FSWP-I-7E57C0DE000040008000000000000001","note":"Manager-approved FairShift work earnings","purpose":"SERVICES"}]}
```

Response: **HTTP 400**, debug_id `ca575b2cb0afb`:

```json
{"name":"VALIDATION_ERROR","message":"Invalid request - see details","debug_id":"ca575b2cb0afb","information_link":"https://developer.paypal.com/docs/api/payments.payouts-batch/#errors","details":[{"field":"items[0].amount.currency","location":"body","issue":"Currency is not supported"}],"links":[]}
```

PayPal refused the whole request synchronously. No payout batch was created, and no batch ID was returned.

### FairShift state

| Time | Step | Result |
|---|---|---|
| 15:44:17.775Z | Payable calculated | `7800` minor units, `ZAR` (6 h × ZAR 13.00) |
| 15:44:17.781Z | Manager approval | `APPROVED`, `approvedAmountMinor 7800`, `approvedCurrencyCode ZAR` |
| 15:44:21.197Z | Submit #1 (service) | `submitted: true` → `status: FAILED`, `paypalBatchId: null`, `paidAt: null`, `lastError: {"code":"VALIDATION_ERROR","debugId":"ca575b2cb0afb","outcome":"REJECTED","httpStatus":400}` |
| 15:44:21.204Z | Submit #2 (service) | `submitted: false`, `status: FAILED`, PayPal not called |
| 15:44:21.209Z | Submit #3 (manager's Send action) | Redirect `/manager/review?status=payout-already-sent`, PayPal not called |
| 15:44:21.211Z | `work_payouts` rows | **1**: `FAILED`, `attempts 1`, `FSWP-B-7E57C0DE000040008000000000000001`, `ZAR 7800`, `paidAt null` |
| 15:44:21.211Z | `createPayout` calls | **1** |
| 15:44:21.212Z | Payout audit | `PAYOUT_RESERVED`, `PAYOUT_PROVIDER_RESPONSE` |

**NOT PAID:**
- The database shows `FAILED` with `paidAt` null.
- No rendered view (manager review, worker earnings, worker home) contains a "Paid" badge.
- The worker home shows "ZAR 78.00 approved", not paid.

**No duplicate:** one PayPal payout request, one payout row and one attempt, and both repeat attempts were refused locally. A `FAILED` payout cannot be re-sent from FairShift.

**Rendered wording.** To capture the full text, the same scenario was re-run with **no network**, replaying the recorded PayPal response above into the same client. This was for UI rendering only, and no second PayPal request was made. The views read:

- Manager review: "Approved · not yet paid ZAR 78.00 … Paid · confirmed by PayPal None … PayPal did not complete this payment. Nothing has been paid. … It cannot be sent again from FairShift; contact your platform operator. … PayPal status Unknown · PayPal reason VALIDATION_ERROR".
- Worker earnings: "Paid so far None … PayPal did not complete this payment. Nothing has been paid. Your payment needs attention: ask your manager to review it."
- Progress steps (`src/app/components/payment-progress.tsx`, `FAILED`): Approved ✓ · Sent to PayPal ✓ · **Processing marked as the problem step** · "PayPal confirms payment" not reached.

**Observations only, not changed:**
- FairShift's own currency guard (`payoutAmount`) accepts any two-decimal ISO currency, so PayPal, not FairShift, is what refuses ZAR. The failure is safe and truthful.
- For a request PayPal refused at validation, the manager reference shows "PayPal status Unknown" and the stepper ticks "Sent to PayPal".

**Follow-up, 8 November 2026 (Owner-directed display fix).** The two observations above were then addressed, in state and copy only:

- A payout PayPal refuses outright now keeps PayPal's short reason as `last_error.reason`. This is a refusal with an HTTP 4xx and no batch, recorded as `FAILED` with outcome `REJECTED`.
- The stepper no longer ticks "Sent to PayPal". Its problem step reads "Refused by PayPal".
- The manager reference shows "Refused by PayPal: Currency is not supported" instead of "PayPal status Unknown", and the batch, item and transaction rows read "None created".
- The worker sees "Not paid", the same reason, and "nothing has reached your PayPal account". Codes and debug IDs are not shown to the worker.
- Covered by two tests in `tests/integration/work-payouts.test.ts`: a refusal with the recorded Sandbox shape, and a control in which a payout PayPal accepted and later failed keeps its existing display.

The rendered wording quoted above is from before this fix.

## 4. Payout with `recipient_wallet = "RECIPIENT_SELECTED"`

### Method

FairShift's payout client has no `recipient_wallet` field, so this was a direct REST call from a throwaway script outside the repository. It sent one USD 1.00 item: Venmo, the alternative wallet a recipient could select, is US/USD only.

15:45:01.487Z, `POST /v1/oauth2/token`: **200**, debug_id `ca575b3c6deaf` (token redacted).

15:45:02.937Z, `POST https://api-m.sandbox.paypal.com/v1/payments/payouts`, `PayPal-Request-Id: FAIRSHIFT-TEST-RECIPIENT-SELECTED-001`:

```json
{"sender_batch_header":{"sender_batch_id":"FAIRSHIFT-TEST-RECIPIENT-SELECTED-001","email_subject":"FairShift Sandbox test (not a real payment)","email_message":"FairShift Sandbox test of recipient_wallet RECIPIENT_SELECTED. Not a real payment."},"items":[{"recipient_type":"EMAIL","recipient_wallet":"RECIPIENT_SELECTED","amount":{"value":"1.00","currency":"USD"},"receiver":"f•••@example.com","sender_item_id":"FAIRSHIFT-TEST-RECIPIENT-SELECTED-ITEM-001","note":"FairShift Sandbox test - recipient_wallet probe, not a real payment"}]}
```

Response: **HTTP 400**, debug_id `ca575b3d05d5e`:

```json
{"name":"UNSUPPORTED_RECIPIENT_WALLET","message":"The recipient wallet for this payout request is not supported by your program. If this is unexpected, please contact customer support.","debug_id":"ca575b3d05d5e","information_link":"https://developer.paypal.com/docs/api/payments.payouts-batch/#errors","links":[]}
```

### Result

- **VERIFIED:** this Sandbox app's Payouts program does not accept `RECIPIENT_SELECTED`. The request was refused before any batch existed, so **the recipient was offered nothing**: no batch, no item, no notification.
- **NOT VERIFIED:** what a recipient would be offered on an account where PayPal enables this wallet option. That would need PayPal to enable it on the account, which the error message points to as a customer-support matter.

## Facts for the Devpost "Challenges" section

These are evidence only. They are not product copy, and no product copy was changed.

- FairShift's subscription checkout is a server-side PayPal Subscriptions integration with a hosted approval redirect. It is not the v5 or v6 JS SDK.
- In PayPal Sandbox, the v6 eligibility check reported PayPal eligible for recurring payments in both USD and ZAR, for a buyer located in South Africa.
- In the same Sandbox, PayPal Payouts refused a ZAR payout item outright: HTTP 400 `VALIDATION_ERROR`, "Currency is not supported" on `items[0].amount.currency`. FairShift recorded the payout as failed and not paid, made no duplicate request, and blocked re-sending.
- PayPal Payouts refused `recipient_wallet: "RECIPIENT_SELECTED"` for this app: HTTP 400 `UNSUPPORTED_RECIPIENT_WALLET`.
- **INFERENCE:** taken together, a South African business could be eligible to pay a subscription through PayPal, but could not pay its workers in rand through PayPal Payouts in this Sandbox.

**Claims limit:** Sandbox only, one app, 8 November 2026. Production behaviour, other countries, and plan creation or billing in ZAR are NOT VERIFIED.
