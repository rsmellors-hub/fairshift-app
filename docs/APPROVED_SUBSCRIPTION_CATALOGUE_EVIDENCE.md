# Approved subscription catalogue and Sandbox provisioning

## Repository implementation

Baseline: `main`, `28f697b035d2ba6476f6a360163f1689954939ae`, clean before this work.

`src/server/billing/plans.ts` owns the GBP catalogue, billing cadence, location limit and configuration key. Browser forms supply only a validated internal tier/period. The subscription action whitelists those fields; arbitrary amounts, currency, provider plan IDs or limits cannot select commercial terms. Enterprise is contact-only (6+ locations); Single permits one active location and Multi permits up to five (commercially 2–5). Annual billing is 12 months for 10 monthly payments.

Before creating a subscription, the server reads the configured PayPal Plan and verifies its identifier, active status, exact GBP amount, recurring cadence, single unlimited regular cycle, absence of trial cycles, quantity pricing, setup charges and additional tax. Money comparison uses integer pence via BigInt. An authoritative ACTIVE reconciliation repeats commercial verification for tier-bearing subscriptions and rejects overridden subscription terms/quantity. Existing legacy subscriptions without tier metadata retain their established identity binding. Cancellation/suspension/expiry still withdraw entitlement even if a Plan has subsequently changed or become inactive.

Creation responses and browser returns never grant entitlement. The existing organisation/provider/plan identity binding, signed webhook verification, event deduplication, setup gate, location locks and payout separation remain in place. Conflicting Sandbox/Live environment settings and reuse of a payout webhook ID for subscriptions fail closed.

No schema changes or new migration are needed.

## VERIFIED: PayPal Sandbox objects

Created and read back through the configured Sandbox app on 16 October 2026. There were zero Products and Plans before provisioning. All four Plans are ACTIVE, belong to the single Product below, have one unlimited regular cycle, no trial or setup charge, and match these GBP terms:

Product: `PROD-8S5740580A111492L` — FairShift, SERVICE.

| Configuration variable | Sandbox Plan ID | Collection |
| --- | --- | --- |
| PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID | P-4MX001217X1775458NLIV3WY | GBP 29.00 / MONTH |
| PAYPAL_SINGLE_OUTLET_ANNUAL_PLAN_ID | P-6PR85965HF857390XNLIV3XA | GBP 290.00 / YEAR |
| PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID | P-1M6317095M539293XNLIV3XI | GBP 69.00 / MONTH |
| PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID | P-9NT72459MX685451UNLIV3XQ | GBP 690.00 / YEAR |

Separate Sandbox subscription webhook: `6MS581731P900925N`.

- URL: `https://getafairshift.com/api/webhooks/paypal-subscriptions`
- Events: BILLING.SUBSCRIPTION.CREATED, ACTIVATED, UPDATED, SUSPENDED, CANCELLED, EXPIRED.
- Existing payout webhook `5DL71320BE804574W`, its URL and six payout event registrations were read back and confirmed unchanged after creation.
- Registration is API-backed evidence; delivery/authenticity of an actual new subscription event has **NOT** been externally exercised.

The four Plan IDs and `PAYPAL_SUBSCRIPTION_WEBHOOK_ID` were added to ignored local `.env.local`. Client credentials were reused without printing or changing them. No provider identifiers are embedded in application business logic. Hosted Render environment was not inspected or changed in this package.

## One-off provisioning

Not invoked by application startup, build, deployment or database migration:

```sh
# Read-only: validates every existing candidate and reports missing configuration.
node --env-file-if-exists=.env.local --import tsx scripts/provision-paypal-subscriptions.ts --subscription-webhook

# Explicit mutation, only in Sandbox; checks existing objects before creation.
node --env-file-if-exists=.env.local --import tsx scripts/provision-paypal-subscriptions.ts --apply --subscription-webhook
```

The tool fails on ambiguous/duplicate/conflicting products, plans or subscription webhook registrations. It reads existing candidates before mutations and uses stable request IDs for creation. A failed or uncertain request stops without automatic retry. Inspect read-only before another explicit run. Webhook provisioning never patches or deletes existing webhooks and compares their registered IDs, URLs and event types afterward.

API shapes and behavior were checked against official [PayPal Product creation](https://developer.paypal.com/api/catalog-products/v1/products-create/), [Plan creation](https://developer.paypal.com/api/subscriptions/v1/plans-create), [subscription details](https://developer.paypal.com/api/subscriptions/v1/subscriptions-get) and [webhook integration](https://developer.paypal.com/api/rest/webhooks/rest/) documentation.

## Verification

- Focused: `pnpm test --maxWorkers=1 --no-file-parallelism tests/unit/subscription-catalogue.test.ts tests/integration/subscriptions.test.ts tests/integration/owner-onboarding.test.ts tests/integration/auth-request.test.ts tests/unit/transactional-adapters.test.ts` — **5 files / 46 tests passed**.
- Full serialized suite: `pnpm test --maxWorkers=1 --no-file-parallelism` — **25 files / 178 tests passed**. Includes auth/invitations, notification, migration, work-term and payout regression tests.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `DATABASE_URL=postgresql://localhost/fairshift pnpm build` — production Webpack build passed using a local database URL.
- `DATABASE_URL=postgresql://localhost/fairshift pnpm db:generate` — no schema changes, nothing to migrate.
- `git diff --check` — passed.
- Real runtime adapter, using configured local mappings: four read-only authoritative Sandbox Plan GETs and catalogue comparisons — **passed**.
- Provisioning read-only validation after initial creation found all four expected Plans and no missing Plans; the subsequent explicit webhook step reused them without creating duplicates.

## Golden-path status and next manual checks

| Stage | Evidence |
| --- | --- |
| Account → verification → subscription selection | Automated local regression tests; no new hosted identity created |
| Correct configured provider price/cadence | Real Sandbox Plan GETs through FairShift runtime adapter |
| Buyer checkout/approval | NOT TESTED against Sandbox in this package |
| Browser return / create response cannot activate | Automated controlled provider tests |
| Authoritative ACTIVE / webhook deduplication | Automated controlled provider tests; actual buyer subscription/webhook delivery NOT TESTED |
| ACTIVE → workplace setup → Owner workspace | Automated local regression tests; not exercised with a newly purchased Sandbox subscription |

Before hosted golden-path testing, map the four Plan IDs above and the separate subscription webhook ID into the existing Render service, preserving all existing credentials and payout configuration. Review/release this implementation separately; it is not committed, pushed or deployed here. Use a controlled Sandbox buyer to approve a selected plan, verify provider amount/cadence, and confirm authoritative GET/event processing establishes ACTIVE before setup or operations are accessible. Verify cancellation/suspension revokes access. Do not equate webhook registration or unit-test activation with an end-to-end Sandbox pass.

No subscription was created or approved, no payment was executed, no email was sent, and no hosted database, Render, DNS or Resend setting was changed in this package. Future provider pricing edits can invalidate the catalogue check and require explicit commercial review; no upgrade/downgrade/proration behavior was added.
