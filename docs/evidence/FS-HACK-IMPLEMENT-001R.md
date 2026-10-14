# FS-HACK-IMPLEMENT-001R — Webhook recovery repair

Date: 2026-10-14 (Africa/Johannesburg).

## Objective and baseline

Repair safe redelivery of verified but unfinished PayPal capture events and checkpoint the PayPal inbound foundation. No AI, staffing, scheduling, payouts, authentication changes, or sponsor integrations were implemented.

Mandatory baseline commands were run before editing: `pwd`, `git branch --show-current`, `git rev-parse HEAD`, `git log -1 --oneline`, `git status --short`, and `git status`.

- Repository: `/Users/ryanmellors/Projects/Fairshift/app`.
- Branch: `main`.
- HEAD: `1fa9ba5ddbe228e5a132019840dea5cfbd198917`.
- Latest commit: `1fa9ba5 chore: establish FairShift hackathon repository controls`.
- Only tracked modification: `.gitignore`; the FS-HACK-IMPLEMENT-001 foundation was untracked.
- No checkpoint or FS-HACK-IMPLEMENT-002 changes existed. `AGENTS.md` was unchanged.

## Reproducible environment

The shell initially selected Node 26.10.0 and did not expose pnpm. The existing runtime at `/private/tmp/fairshift-node-v24.22.0/bin` contained Node 24.22.0 and Corepack pnpm shims. All commands below used:

```sh
export PATH=/private/tmp/fairshift-node-v24.22.0/bin:$PATH
node --version # v24.22.0
pnpm --version # 12.11.2
```

No runtime/dependency pins were changed and no global dependencies were installed. `.node-version`, `.nvmrc`, `package.json`, `pnpm-workspace.yaml`, the lockfile, and README setup instructions were inspected. The first sandboxed frozen install failed on registry DNS access; the approved rerun outside the sandbox passed, restoring 387 locked packages from the existing store (0 downloads). The temporary runtime path is session-specific; other machines should provision the versions pinned in the repository.

## Defect and red/green regression

The inbox insert committed before capture retrieval. On transient failure, the event remained `RECEIVED`, but the duplicate branch returned HTTP 200 without retrying. Authenticity verification and financial processing completion had been conflated.

Before implementation, the permanent regression test in `tests/integration/webhook.test.ts` was run with:

```sh
pnpm test tests/integration/webhook.test.ts -t 'retries an unfinished event'
```

Result before fix: **1 failed, 6 skipped**, exit 1. Redelivery expected `PROCESSED`, but received `{ status: "RECEIVED", duplicate: true, httpStatus: 200 }`. The failure occurred after checking that the inbox record persisted and the sale remained `PENDING`.

After repair, the same test passes in the full suite. It verifies recovery to `VERIFIED`, terminal event evidence, one inbox row, one sale, one committed verification audit, signature verification on each delivery, and no further sale mutation or capture retrieval on terminal redelivery.

## Repair and state semantics

`src/server/integrations/paypal/webhook.ts` retains authenticity verification before any inbox/financial write. It persists the inbox record, then opens a database transaction, locks the event with `SELECT ... FOR UPDATE`, and reads the current state under the lock. Retrieval uses the original persisted capture reference. Existing reconciliation checks are unchanged.

| State | Meaning and redelivery behavior |
| --- | --- |
| `RECEIVED` | Authentic event persisted; processing unfinished. Eligible for retry. |
| `ERROR` | Existing schema's unfinished error state; eligible for retry. This repair does not write a new error state on failure. |
| `PROCESSED` | Reconciliation completed and local effects committed; repeated delivery returns 200 without reconciling again. A mismatch can be processed while the sale is `FAILED`, not `VERIFIED`. |
| `IGNORED` | Verified unsupported event; terminal, acknowledged with 200. |
| `UNMATCHED` | Verified capture has no matching sale; terminal quarantine, acknowledged with 202. No automatic re-evaluation is added. |

Sale reconciliation, reconciliation audit, event terminal state, and processing audit commit together. Exceptions roll back all of these effects; the inbox row remains unfinished for later valid redelivery. The lock prevents overlapping same-event deliveries from both committing financial effects. `duplicate: true` denotes an existing inbox row, including a successful recovery attempt, not necessarily skipped processing.

`DatabaseSession`, a narrow type for shared connection/transaction operations, permits the existing repository/reconciliation functions to use the same transaction. No queue, new states, schema changes, migrations, or infrastructure were introduced.

## HTTP behavior

The existing endpoint maps `PayPalApiError` (including timeout, network and provider 5xx errors) to HTTP 503 and unexpected processing errors to HTTP 500. These responses do not acknowledge completion. A later valid redelivery retries unfinished reconciliation and returns 200 after commit. Invalid signatures return 401; malformed JSON is rejected before verification/persistence.

PayPal documents 2xx as successful receipt and non-2xx as triggering delivery retries, up to 25 attempts over three days: [PayPal webhooks overview](https://developer.paypal.com/api/rest/webhooks). This supports the response choice; actual PayPal delivery/retry behavior was not exercised.

## Tests and verification

| Command | Final result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS; lockfile current; 387 packages restored; pnpm 12.11.2. |
| `pnpm test` | PASS; 6 files, 52 tests, 14.20 seconds. |
| `pnpm lint` | PASS; exit 0. |
| `pnpm typecheck` | PASS; exit 0. |
| `pnpm build` | PASS; production compilation, type analysis and all routes generated. |
| `git diff --check` | PASS for both unstaged and staged changes (`git diff --cached --check`). |

Coverage added/preserved:

- Normal processing and successful terminal deduplication.
- Timeout followed by successful redelivery; repeated network/provider 503/generic retrieval failures remain recoverable.
- Rollback of the sale, both audits, and event completion when a database trigger rejects the final processing audit; successful recovery after removing the test-only failure injection.
- Overlapping same-event deliveries produce one capture retrieval, one sale and one set of audit records.
- Amount/currency/order mismatches on recovery cannot produce `VERIFIED`.
- Unknown and unmatched terminal redeliveries do not repeat retrieval/mutation.
- Invalid signatures, malformed JSON and missing headers are rejected.
- Existing provider-event and capture uniqueness protections remain covered.
- Real Next route handler with mocked provider boundary and PGlite: 503/500 on failure, 200 after recovery; invalid signature 401.

An intermediate rollback-test setup failed because PGlite prepared statements reject multiple commands. Splitting function and trigger creation into separate statements fixed the test fixture; no production logic was relaxed.

Database tests use isolated in-memory PGlite with the existing migration. The overlapping-delivery test does not establish independent PostgreSQL connection/process contention behavior; that remains an external-runtime verification limitation. Provider interactions are deterministic mocks throughout.

## Runtime smoke evidence

```sh
pnpm start --hostname 127.0.0.1 --port 3210
curl -sS -o /private/tmp/fairshift-001r-home.html -w 'Home HTTP %{http_code}\n' http://127.0.0.1:3210/
curl -sS -w '\nHealth HTTP %{http_code}\n' http://127.0.0.1:3210/api/health
```

The sandbox first rejected listening with EPERM and could not access the external local server. Approved execution outside the sandbox succeeded. The production server was ready in 87 ms.

- `/`: HTTP 200. Returned HTML contained FairShift, `NOT CONFIGURED`, `NOT YET LIVE-VERIFIED`, `NOT IMPLEMENTED`, and the empty transaction message.
- `/api/health`: HTTP 503 with `{"status":"not_ready","database":"NOT_CONFIGURED","paypal":"NOT CONFIGURED"}`.
- This is HTTP/HTML evidence, not browser interaction evidence.

## Security and integration boundary

All 53 staged files were inspected and scanned without printing secrets; `git diff`, `git diff --cached`, the staged manifest, and both whitespace checks were reviewed. The staged path/artifact checks passed, and `AGENTS.md` was not staged. Environment checks reported the database URL and PayPal configuration variables unset; only `.env.example` existed. Its database URL was changed to an empty value. Remaining scanner matches were explicit mock client-secret/token literals in unit tests. `.env`, `.env.local`, `node_modules`, and `.next` are ignored; runtime smoke artifacts stay outside the repository.

PayPal status remains **IMPLEMENTED — NOT LIVE-VERIFIED**. No real OAuth, sandbox order/capture, public webhook delivery, provider IDs, or payer data were obtained. Local recovery behavior, route responses and build are verified; live integration is not. The implementation still has no background worker, automatic unmatched-event re-evaluation, or live refund lifecycle.

## Repair files and checkpoint

Repair changes relative to the supplied uncommitted foundation:

- `.env.example`: blank database configuration value.
- `src/server/db/client.ts`: transaction-compatible session type.
- `src/server/db/repository.ts`: session types on functions used in reconciliation.
- `src/server/domain/transactions.ts`: accept a session for capture reconciliation.
- `src/server/integrations/paypal/webhook.ts`: locked, transactional unfinished-event recovery.
- `src/app/api/webhooks/paypal/route.ts`: response-semantics comment.
- `tests/integration/webhook.test.ts`: recovery, rollback, overlap and terminal-safety regression coverage.
- `tests/integration/webhook-route.test.ts`: HTTP recovery and rejection tests.
- `README.md`, `docs/evidence/FS-HACK-IMPLEMENT-001.md`, and this document: current semantics and evidence.

One checkpoint commit is authorized with message `feat: establish PayPal inbound transaction foundation`, including the original foundation and this repair, after final staged-file, secret and whitespace review. The commit hash and exact resulting Git state are reported in the task's final response; use `git show --name-only` on that checkpoint for the complete foundation file manifest. No AI implementation is included. `AGENTS.md` remains unchanged.

Next package: **Resume FS-HACK-IMPLEMENT-002 from the AI forecasting/staffing objective.**

## Exact checkpoint file manifest

The reviewed checkpoint contains these 53 files (52 additions and the existing `.gitignore` modification):

```text
.env.example
.gitignore
.node-version
.nvmrc
LICENSE
README.md
docs/evidence/FS-HACK-IMPLEMENT-001.md
docs/evidence/FS-HACK-IMPLEMENT-001R.md
drizzle.config.ts
drizzle/0000_fairshift_paypal_inbound.sql
drizzle/meta/0000_snapshot.json
drizzle/meta/_journal.json
eslint.config.mjs
next-env.d.ts
next.config.ts
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/migrate.ts
src/app/api/health/route.ts
src/app/api/paypal/orders/[orderId]/capture/route.ts
src/app/api/paypal/orders/route.ts
src/app/api/webhooks/paypal/route.ts
src/app/checkout/cancel/page.tsx
src/app/checkout/return/page.tsx
src/app/components/capture-order.tsx
src/app/components/create-sale-button.tsx
src/app/layout.tsx
src/app/page.tsx
src/app/styles.css
src/server/config/env.ts
src/server/constants.ts
src/server/db/client.ts
src/server/db/repository.ts
src/server/db/schema.ts
src/server/domain/money.ts
src/server/domain/payment-status.ts
src/server/domain/transactions.ts
src/server/integrations/paypal/client.ts
src/server/integrations/paypal/factory.ts
src/server/integrations/paypal/schemas.ts
src/server/integrations/paypal/webhook.ts
src/server/security/origin.ts
tests/helpers/database.ts
tests/helpers/paypal.ts
tests/integration/database.test.ts
tests/integration/webhook-route.test.ts
tests/integration/webhook.test.ts
tests/unit/money.test.ts
tests/unit/payment-status.test.ts
tests/unit/paypal-client.test.ts
tsconfig.json
vitest.config.ts
```
