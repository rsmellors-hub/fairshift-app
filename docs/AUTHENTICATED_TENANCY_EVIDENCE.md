# Authenticated tenancy, billing and transactional notifications

## Implementation and authority

Repository evidence only unless a verification result below explicitly says otherwise.
The operational checkpoint is `cb102976158add91e2737ced887d78f90d89f501`.
This foundation uses the existing Next.js App Router, PostgreSQL and Drizzle stack.
It adds no identity SaaS, database service, email SDK or payment SDK dependency.

### Identity and sessions

`src/server/auth/identity.ts` uses Node's standard asynchronous scrypt (N=131072,
r=8, p=1), random per-password salts and timing-safe comparison. Random 256-bit
session tokens are held in HTTP-only, SameSite=Lax cookies (Secure in production);
only SHA-256 token hashes are stored in PostgreSQL. Sessions expire after seven
days. Sign-out revokes the persisted session. Password-reset links expire in one
hour, are single-use, and invalidate sessions and outstanding identity links.
Email verification is required before organisation creation. An invitation can
verify its matching identity's email through possession of its secret link.

Database-backed limits constrain registration, login, verification, reset,
invitation creation/resend and redemption. Login errors and reset requests avoid
revealing whether an email has an account. Next server actions retain framework
Origin/Host CSRF protection. Financial proof API routes also retain their origin
check and require a separately provisioned Operator identity.

This is a small application-owned credential/session implementation using the
runtime's established cryptographic primitives, not custom cryptography. It avoids
external identity-service lock-in. MFA, account recovery support, breach-password
screening, device management and independent security assessment remain future
hardening. Production authentication/browser behaviour has not been verified.

References: [Next.js authentication](https://nextjs.org/docs/app/guides/authentication),
[Node crypto](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).

### Owner-originated authority and scope

Public registration creates an identity with no organisational authority. A verified
identity creates an organisation, its first location, an OWNER membership and an
UNCONFIGURED organisation subscription in one transaction. A user can hold different
memberships across organisations; no global organisational role exists on the user.

Only an Owner invites Managers. Owners and scoped Managers invite Team Members.
Managers have an explicit location membership. Team memberships link the identity
to the existing location-bound worker record; attribution codes and worker-owned
PayPal destinations remain independent. Management never sets another person's
password or payout destination. Owners can select among their existing locations.

`request.ts` resolves the cookie session, active membership, permitted role and
location on the server. Layouts and data-rendering workspaces both check access;
server actions independently recheck it. URL/form IDs only identify resources within
the resolved scope. Department/policy/requirement/offer queries use that scope.
Worker reads and responses derive the worker ID from membership, never form data.
Worker Profile destination updates also match the authenticated user on the worker.
Notification reads and read/unread mutations match the authenticated recipient.

Operator access is separate: a verified identity must be listed in the server-only
`FAIRSHIFT_OPERATOR_USER_IDS`. Owner registration never grants Operator authority.
There is no automatic ownership or identity claim on historical/demo organisations.
Internal demo fixture services remain for tests/operator workflows, with request
entry points protected by membership and the exact demo organisation/location.

### Invitations

The original `team_invitations` entity is extended for Manager and Team invitations.
Its existing `token` column now holds a one-way SHA-256 digest, enforced by a database
constraint. The migration hashes old prepared tokens and backfills organisation,
location and contact context without creating users or memberships.

Lifecycle: CREATED_NOT_SENT → SENT (provider acknowledged acceptance), or
DELIVERY_FAILED (send not confirmed), then REDEEMED, EXPIRED or REVOKED. Expiry is
checked during redemption regardless of stored state. SENT never means delivered.

Redemption locks the invitation, checks hash, state, expiry and authenticated email,
then links worker identity, inserts invitation-derived membership, records redemption
and associates pending in-app notifications atomically. A unique invitation-to-
membership constraint and row lock prevent replay. Submitted role/location overrides
are not used. Membership database checks enforce location and invitation consistency.

Resend rotates the token and expiry, preserving the invitation/worker identity and
invalidating the old link. Late acknowledgement of an older email cannot mark the
new invitation sent. Tokens appear only in ephemeral email bodies and URL fragments,
never persisted notification text, server request URLs or logs. The browser preserves
an invitation fragment in tab-scoped sessionStorage across sign-in; tokens still
expire and become unusable after redemption. Email-verification/reset links use the
same fragment pattern. Referrer-Policy is no-referrer.

### Organisation subscription lifecycle

`src/server/billing` is isolated from incentive payouts. One externally configured
Sandbox PayPal plan is sufficient; no prices, tax, proration or invoicing are invented.
The organisation owns the subscription, stable request ID, plan/provider identifiers,
state and last verification time. Owner membership is required for initiation and
refresh. Possible states: UNCONFIGURED, PENDING, APPROVAL_PENDING, APPROVED, ACTIVE,
SUSPENDED, CANCELLED and EXPIRED.

Creation reserves a stable request ID before calling PayPal. It preserves PENDING
on failure, retries the same ID and blocks stale retries after 48 hours rather than
risking recreation after PayPal's documented 72-hour idempotency retention. Successful
creation records approval pending; activation requires GET subscription details with
matching provider ID, organisation custom_id and plan ID. Approval URLs are restricted
to HTTPS Sandbox PayPal. Browser return ignores client subscription/status IDs and
only reconciles the authenticated organisation's stored provider ID.

`POST /api/webhooks/paypal-subscriptions` uses the separate configured webhook ID and
PayPal's signature-verification endpoint. It validates the event, locks the matching
subscription, deduplicates event IDs/payload hashes, retrieves authoritative current
state and commits state/event together. Invalid signatures cannot mutate billing.
Failure is retryable; unknown subscriptions are not acknowledged as processed.
No webhook was registered by this package. Capture/payout webhook behaviour is separate.

References: [create subscription](https://developer.paypal.com/api/subscriptions/v1/subscriptions-create),
[subscription details](https://developer.paypal.com/api/subscriptions/v1/subscriptions-get),
[webhook verification](https://developer.paypal.com/api/rest/webhooks/rest/).

### Notifications and email

`notifications` is the persistent in-app event projection. `notification_deliveries`
records channel, destination, provider, message ID, attempt/acceptance/delivery times
and safe failure code. Event keys are unique. Database triggers create notifications
and delivery rows in the same transaction as shift offers, material term changes,
cancellations, work confirmation and significant incentive states. Triggered term
changes retain the existing immutable acceptance/version invalidation rules.

Invitation and identity notifications are created before attempting email. Invited
recipients without an identity have pending email-address/worker association; redemption
associates them with the matching user. Email failure never deletes a domain event.
Worker Home shows unread actionable items; Account provides recipient-specific read/
unread controls and workspace selection without changing primary operational navigation.

Resend is the single provider: a small fetch adapter, transactional API, provider
message acknowledgement and idempotency keys require little configuration. No existing
provider was configured; introducing SES infrastructure or several alternatives was
unnecessary. The adapter can be replaced without changing domain events.
References: [send email](https://resend.com/docs/api-reference/emails/send-email),
[idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).

Missing API key/from address returns UNCONFIGURED without network traffic. A successful
API response means ACCEPTED by provider, not delivered. Unknown outcomes are UNKNOWN;
no automatic retry guesses delivery. SENDING interrupted by a process crash requires
operator review. No delivery webhook is implemented and delivered_at stays null.
Invitation UI SENT describes provider acceptance, never mailbox delivery.

Offer/change actions attempt operational email immediately. A persisted pending outbox
can be processed by a separately scheduled authenticated POST to
`/api/notifications/dispatch`; `NOTIFICATIONS_DISPATCH_SECRET` must be at least 32
characters. No scheduler/deployment was configured. The endpoint processes up to 100
pending operational notifications. Users can also retry their pending operational
emails in Account. Sensitive invitation/identity links are not recoverable from hashes:
resend rotates/reissues the link instead of persisting raw credentials for later jobs.

## Migration and verification

- `0006_authenticated_tenancy.sql`: identity/session/token/limit tables, memberships,
  organisation subscriptions/events, notifications/deliveries, workforce user links,
  invitation extension/backfill/hash and transactional notification/scope triggers.
- `0007_invitation_token_guard.sql`: requires hashed invitation tokens.
- Forward-only; previously committed migrations are unchanged. No hosted migration run.
- PostgreSQL-compatible PGlite integration tests apply all migrations on blank databases.
  Historical upgrade tests retain offers, acceptance facts, attribution codes, payout
  destination and failed payout state; no identities/memberships are manufactured.

| Behaviour | Automated evidence | External status |
| --- | --- | --- |
| Registration, verification, sessions, password reset, Owner creation | `auth-tenancy.test.ts`, `auth-request.test.ts` | Local automated only |
| Owner/Manager invitations, email matching, replay/expiry/revocation, role escalation, location/org isolation | `auth-tenancy.test.ts`, `auth-request.test.ts` | Delivery and hosted redemption NOT VERIFIED |
| Worker record/offer isolation, acceptance and destination | `auth-tenancy.test.ts`, `auth-request.test.ts`, existing operations/scheduling tests | Local database-backed |
| Subscription persistence, pending/retry, authoritative activation, signature/deduplication, browser return | `subscriptions.test.ts`, `auth-request.test.ts`, `transactional-adapters.test.ts` | PayPal boundary MOCKED; live subscription NOT VERIFIED |
| Notification persistence, email failure/acknowledgement, recipient/read isolation, material changes | `auth-tenancy.test.ts`, `transactional-adapters.test.ts` | Resend boundary MOCKED / unconfigured |
| Existing work terms, incentive and PayPal payout controls | existing operational and incentive suites | Retains prior Sandbox evidence; no new live payout |
| Blank/historical migration, invitation token hashes | `migration.test.ts`, all integration DB setup | PGlite only; hosted PostgreSQL NOT VERIFIED |

## Deliberately unresolved / external prerequisites

- The repository environment has existing payout credentials but no subscription plan,
  subscription webhook ID, Resend key or sender configuration. No live provider calls,
  real emails, financial transactions, deployment or hosted migrations were executed.
- Sandbox only; this package does not establish production PayPal capability.
- Billing entitlement restrictions are not invented. Pending/suspended billing is visible;
  policy for restricting operational access, pricing, cancellation management, dunning
  and production billing remains separate product work.
- One first location is created in onboarding; location provisioning beyond existing
  records is not expanded. Managers can hold separate memberships for several locations
  and choose them in Account; no automatic organisation-wide Manager authority exists.
- Existing demo company/worker records remain unclaimed. An operator must arrange an
  explicitly authorised historical account-linking/bootstrap procedure before using
  those fixtures through authenticated hosted pages; migrations never grant ownership.
- New organisations use the existing generic staffing/acceptance/work confirmation
  workflow. The controlled demo incentive payment service remains scoped to its original
  fixture; no new incentive policy, commission payout or payment-authority engine exists.
- Operational timestamps retain the established Johannesburg operating context. New
  onboarding locations use Africa/Johannesburg; a timezone configuration expansion is
  outside this package.
- No provider delivery webhook, MFA, production email-domain setup, autonomous scheduler
  configuration or independent security audit is claimed.

## Hosted/manual verification checklist (requires separate approval)

1. Review migrations and back up a nonproduction database; apply approved migrations.
2. Configure HTTPS APP_BASE_URL, a verified Resend sender/key and separate Sandbox
   subscription plan/webhook IDs. Provision a verified Operator UUID explicitly.
3. Register Owner, inspect HTTP-only/Secure/SameSite cookie, verify email, create org.
   Confirm no membership exists before creation and subscription remains unconfigured/
   pending until provider verification. Do not execute chargeable actions without approval.
4. Invite Manager and Team Member, inspect prepared/provider-accepted states and received
   emails separately. Redeem through each identity; reject wrong mailbox, replay, expired,
   revoked and replaced links. Confirm no role override grants authority.
5. Use two organisations, two locations and two worker accounts. Manipulate IDs in forms,
   cookies and requests; verify access rejection and absence of foreign data.
6. Configure three work models, create a multiple-worker requirement, offer/accept/allocate.
   Check notifications, explicit acknowledgement and immutable accepted snapshots.
7. Reschedule, confirm pending reacceptance and notifications; cancel an unreviewed
   assignment. Confirm completed/confirmed work remains locked. Verify unread/read controls.
8. Exercise email-provider failure; retain in-app events and inspect UNKNOWN/UNCONFIGURED
   independently. Configure the protected pending-outbox job only if approved.
9. Review a separately authorised Sandbox subscription run: direct browser return cannot
   activate, authoritative GET can; invalid/duplicate webhooks cannot falsely mutate state.
10. Repeat approved incentive/destination/duplicate-payout controls without executing any
    new real payment unless specifically authorised. Verify sign-out and reset revoke sessions.

## Executed verification

- Approved checkpoint: 19 files / 122 tests passed before checkpoint commit, plus
  standalone typecheck, lint, production Webpack build and diff check.
- Focused new/security and regression runs passed, including real session-cookie and
  server-action boundary tests; providers were controlled mocks/unconfigured adapters.
- Final `pnpm test --maxWorkers=1 --no-file-parallelism`: **23 files / 140 tests passed**.
- Final standalone `pnpm typecheck`, `pnpm lint`, `pnpm build` (Webpack) and
  `git diff --check`: **passed**.
- `DATABASE_URL=postgresql://localhost/fairshift pnpm db:generate`: no schema drift;
  this command generated/compared local migration metadata and did not migrate a database.
- No hosted UI, real email, live subscription, production authentication or hosted
  PostgreSQL verification was performed. No new work was staged or committed.
