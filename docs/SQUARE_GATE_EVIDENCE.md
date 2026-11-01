# Square Sandbox Attribution Gate Evidence

**Verdict: GO under the gate rule.** Square Sandbox stores a `team_member_id` supplied when a payment is created, and returns the same value on every read.

**Limit on that verdict:** in this gate FairShift's script supplied the team member on each payment. It proves Square keeps and returns the association. It does not prove that a real till sale takes the identity from the staff member logged in. The integration status is **SANDBOX-CONNECTED for this gate script only**. Square is not yet part of the FairShift product.

## 1. Run details

| Item | Value |
|---|---|
| Runs | Three, on 2026-11-01, at 01:42, 01:43 and 01:47 UTC |
| Repository baseline | Branch `fs-bryntum-ui-001`, HEAD `510a1ed`, clean |
| Environment | Square Sandbox, `https://connect.squareupsandbox.com` |
| `Square-Version` | `2026-09-16`, listed as latest in Square's changelog on the run date |
| Tool | `scripts/square-gate.ts`, direct HTTPS, no SDK |
| Run label | `fsgate-20261101`. Repeating it replays the same objects |

Identifiers below are keyed pseudonyms (`id_…`). The same value gives the same pseudonym in every run.

**Where the evidence comes from**

- **Genuine Square Sandbox:** everything in sections 2 to 6, unless marked otherwise.
- **Square documentation:** the request contract and API version only.
- **Repository tests:** none. This gate adds no product code or tests.
- **Inference:** marked **INFERENCE** where used.

## 2. Endpoints exercised

| Endpoint | Purpose | Result |
|---|---|---|
| `GET /v2/locations` | Authentication and location | 200 |
| `POST /v2/team-members` | Create two synthetic members | 200 |
| `GET /v2/team-members/{id}` | Read back | 200 |
| `POST /v2/team-members/search` | Find by location | 200 |
| `POST /v2/payments` | Create and replay payments | 200 |
| `POST /v2/payments`, same key, different amount | Idempotency refusal | 400 `IDEMPOTENCY_KEY_REUSED` |
| `GET /v2/payments/{id}`, `GET /v2/payments` | Read back | 200 |
| `POST /v2/refunds` | Refund one payment | 200 |
| `GET /v2/refunds/{id}`, `GET /v2/refunds` | Read back | 200 |

## 3. Location

Authentication succeeded. One location was returned.

| Field | Value |
|---|---|
| `id` | `id_e6ca2951dc` |
| `country` | `GB` |
| `currency` | `GBP` |
| `status` | `ACTIVE` |
| `timezone` | `UTC` |
| `capabilities` | `CREDIT_CARD_PROCESSING`, `AUTOMATIC_TRANSFERS` |

**Timezone caution:** a UK location reports `UTC`. FairShift should keep using its own location time zone for shift windows.

Fields returned: `address`, `business_hours`, `business_name`, `capabilities`, `country`, `created_at`, `currency`, `id`, `language_code`, `mcc`, `merchant_id`, `name`, `status`, `timezone`, `type`.

## 4. Team API

Two synthetic members were created: "FairShift Demo Worker A" and "FairShift Demo Worker B". They hold no personal details.

| Worker | `team_member.id` | Stable across gets | Found in search |
|---|---|---|---|
| A | `id_234d7ebeac` | Yes | Yes |
| B | `id_78d617b9ac` | Yes | Yes |

**Request fields:** `idempotency_key`, `team_member.given_name`, `team_member.family_name`, `team_member.reference_id`, `team_member.assigned_locations.assignment_type`, `team_member.assigned_locations.location_ids`.

**Returned fields:** `assigned_locations`, `created_at`, `family_name`, `given_name`, `id`, `is_owner`, `merchant_id`, `reference_id`, `status`, `updated_at`.

Search returns three active members at the location. **INFERENCE:** the third is the seller's own owner record. No run added more.

## 5. Payment attribution

**Association field: `team_member_id`**, on both the `CreatePayment` request and the returned `Payment`.

Each payment used `source_id` `cnon:card-nonce-ok`, GBP, the location above, `autocomplete: true` and its own idempotency key. No note, reference or metadata carries identity.

| Payment | Worker | Created with | Read back | Same |
|---|---|---|---|---|
| `id_22686f3d92` | A | £1.01, `id_234d7ebeac` | £1.01, `id_234d7ebeac`, `COMPLETED` | Yes |
| `id_2aaa09b0fb` | A | £1.02, `id_234d7ebeac` | £1.02, `id_234d7ebeac`, `COMPLETED` | Yes |
| `id_2182b0d9db` | B | £2.01, `id_78d617b9ac` | £2.01, `id_78d617b9ac`, `COMPLETED` | Yes |
| `id_59a529d530` | B | £2.02, `id_78d617b9ac` | £2.02, `id_78d617b9ac`, `COMPLETED` | Yes |

The location was `id_e6ca2951dc` on all four. `employee_id` is also returned, and equalled `team_member_id` on all four.

### Repeated reads

Each run read every payment three times by ID and three times by list, a few seconds apart. Payment ID, location, amount, currency and `team_member_id` matched on **every row returned, in all three runs**. The runs span about five minutes, so this shows stability over minutes, not days. No conflicting value was ever returned.

**List lag finding.** In the first run, the list call made immediately after creation returned 3 of 4 payments. The fourth appeared on the next read about 4 seconds later, with correct values. The first version of the script counted this as instability and returned NO-GO. On inspection nothing had changed, so the rule was corrected to separate the two:

- A returned row that differs from what was created is a conflict, and any conflict is NO-GO.
- A row not yet returned is counted separately, and every payment must be present by the final read.

Replays had no missing rows. The cause of the lag is **INFERENCE**: a list that catches up shortly after a create. A sync must not treat a very recent window as complete.

### Idempotency

| Check | Result |
|---|---|
| Same key, same body | Returned the same payment ID |
| Same key, different amount | 400 `IDEMPOTENCY_KEY_REUSED` |
| Payments at location before and after | 4 and 4, including after two full replays |

## 6. Refund

Worker A's £1.01 payment was refunded in full. Worker B was deliberately named on the refund, so the two identities could be told apart.

| Item | Result |
|---|---|
| Endpoint | `POST /v2/refunds` |
| Refund | `id_dc2f912c2a` |
| Amount and status | £1.01 GBP, `COMPLETED` |
| Refund to payment | `refund.payment_id` = the original payment |
| Payment to refund | `payment.refund_ids` contains the refund |
| Original afterwards | `amount_money` unchanged, `refunded_money` = £1.01 |
| Original's `team_member_id` | Still Worker A |
| Refund's `team_member_id` | Worker B, as supplied |

Returned refund fields: `amount_money`, `created_at`, `destination_type`, `id`, `location_id`, `order_id`, `payment_id`, `reason`, `status`, `team_member_id`, `updated_at`.

**A. Can FairShift identify the original payment?** Yes: Square links them in both directions, and the link held across all reads.

**B. Can it identify the worker originally credited?** Yes: follow `refund.payment_id` to the payment's `team_member_id`. The refund itself does not carry the seller's identity.

**C. Does Square identify who performed the refund?** Only partly. The refund stores the `team_member_id` it was given, separately from the original seller. This gate supplied that value, so it shows Square can hold a different person. It does not show Square verifies who actually performed a refund.

**Not tested:** partial refunds, a refund with no team member, and a refund made outside the original accounting period.

**The economic treatment of refunds stays OPEN.** The evidence links a refund to a seller, but no worker-refund rule has been decided.

## 7. Gate result

| Requirement | Result |
|---|---|
| Authenticated Sandbox access | Pass |
| UK/GBP seller location | Pass |
| Team API usable | Pass |
| Two synthetic team members | Pass |
| GBP payments associated with them | Pass |
| Same `team_member_id` returned | Pass |
| Association survives repeated reads | Pass |

## 8. Limitations

1. **The identity is supplied by the caller.** The gate script named the team member on each payment. Whether a real Square point-of-sale sale fills this field from the logged-in staff member is **NOT VERIFIED**. So is what happens with a shared login.
2. **Validation of the ID is not tested.** Whether Square rejects an unknown or other-location `team_member_id` would need a fifth payment, which this package did not authorise.
3. **A missing identity is not tested.** All four payments named a team member. FairShift must handle a payment without one.
4. **Sandbox only.** Production behaviour and the production credential model are not covered.
5. **The session scale is small.** Four payments and one refund show that the fields work, not behaviour at volume, including pagination at scale.
6. **Commerce history is thin.** Four payments on one day will not meet FairShift's forecast threshold of 28 trading days. Whether Sandbox payments can carry past dates has not been tested, and history must not be manufactured.

## 9. Claims

**Unlocked:**

- FairShift has authenticated to a UK, GBP Square Sandbox seller.
- Square Sandbox payments can carry a Square team member identity, and Square returns the same identity on every read.
- A Square Sandbox refund links to its original payment, and the original keeps its team member.

**Still prohibited:**

- Square is integrated into the FairShift product.
- Square sales drive FairShift's forecast, staffing or incentives.
- A till login automatically identifies the worker on a sale.
- Square verifies who made a sale or a refund.
- Any production Square capability.
- Any decided refund effect on worker earnings.
- Provider-verified worker performance in FairShift. The database currently allows only `IMPORTED_NOT_PROVIDER_VERIFIED`.
