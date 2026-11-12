# FairShift judge access — preparation only

Date: 5 November 2026. Package: FS-HACK-SA-JUDGE-SUBMISSION-001.

**NOT READY FOR JUDGE DISTRIBUTION.** The reviewed source baseline is `789be8d9c0cb6c810452191609a25d65d6f01fa2`, not the final submission build. No working judge URL, test login, clean-room run, hosted revision or complete South African payment journey was verified by this package. No credentials are included.

## Access routes and release conditions

The [official rules, section 4](https://paypalaihackathon.devpost.com/rules), checked 5 November 2026, accept complete local setup instructions or a hosted functional demo. Private access needs testing credentials; access must be free and available through judging. Credentials and provider secrets must not be committed to the public repository. Provide any authorised test login through the designated private testing instructions, with public documentation explaining the access process. No access details were issued here.

Before distribution, complete the release record below against the final integrated revision. Blank fields are release blockers, not placeholders judges should have to resolve.

| Release fact | Current state | Required completion evidence |
|---|---|---|
| Final source revision and public repository URL | NOT VERIFIED | Exact full commit; authorised publication; source and licence reachable without owner access |
| Chosen hosted or local route | NOT VERIFIED | Independent browser/session or clean-machine run against that revision |
| Hosted URL and deployed revision, if used | NOT VERIFIED | Hosting revision matches the release record; no inference from a push |
| Test persona access and expiration | NOT PROVISIONED | Owner, Manager and Casual Worker access works; permanent staff remain lightweight records with separately authorised limited access |
| Isolated SA/ZAR reference tenant | NOT VERIFIED | Five fictional venues, labelled reference sales and accepted ZAR terms; no customer/demo identity crossover |
| Provider and model availability | BLOCKED | Authorised Sandbox sender/recipient/category/currency and actual bounded model call; no shared customer funding fallback |
| Reset and concurrency instructions | NOT VERIFIED | Repeatable exercise without database surgery or resetting an in-flight financial obligation |
| Support route and access availability | NOT PROVIDED | Working contact/access instructions and an operator responsible through judging |

## Public exploration and genuine Sandbox execution

The baseline has a configurable `/demo` route with Owner, Manager and Worker personas. `src/server/demo/config.ts` requires an explicit enable flag and three distinct configured memberships. Financial POSTs use `requireFinancialScope`, whose demo branch refuses writes. A public persona is therefore not proof of genuine PayPal or Pay Agent execution. An enabled setting is not verified availability.

The separate SaaS safety remediation has not been integrated into this worktree. Its reported controls distinguish public synthetic exploration from genuine model/payment operations. Final judge access must preserve that distinction and establish a separately authorised, authenticated rehearsal context for any genuine provider exercise. Do not disable guards, grant an Operator role, expose merchant secrets, or share demo sender credentials with ordinary tenants to make a demonstration work.

The required casual path is preauthorised terms → worker acceptance → allocation → Manager-confirmed completion → automatic genuine model-backed orchestration → deterministic server checks → eligible Sandbox settlement → actual status/history. There is no casual payout request or second discretionary Owner payment approval. Permanent-staff early tips follow approved allocation → permitted employee request → the same settlement engine. These are DEC-SA-011 requirements, not capabilities demonstrated here.

## Local setup preparation

These commands were inspected against source, **not executed**. This is an operator preparation recipe, not a certified clean-room path. Complete and verify the missing fixture/access/provider instructions on the final integrated build before giving it to judges.

1. Obtain the authorised final source revision. Use Node `24.22.0`, pnpm `12.11.2`, and a disposable PostgreSQL database (repository prerequisite: PostgreSQL 15+). Review third-party licence/install availability, especially the Bryntum trial dependency.
2. Install from the lockfile: `pnpm install --frozen-lockfile`.
3. Prepare a private `.env.local` using the variable names in `.env.example`; do not copy credentials from another business. Set only the isolated database/origin and capabilities actually authorised for the exercise. No `.env` file was accessed in this package.
4. Migrate with `pnpm db:migrate`, which reads `DATABASE_URL` from `.env.local`. Target only the disposable database.
5. Provision the final approved SA fixtures and judge identities through the release-specific, tested procedure. **This procedure is missing.** Existing historical seeds/reference loaders do not establish the required isolated SA/ZAR fixture. Do not improvise SQL, reuse UK amounts, relabel currencies or enable synthetic fallback for a real tenant.
6. Start with `pnpm dev`, or run `pnpm build` and `pnpm start` for a production-mode local check. Next.js loads the private local environment; external services remain unavailable unless correctly configured and authorised.
7. Verify access from a fresh browser session, then record the results and limitations. A landing page, mocked test or video alone is not an interactive build verification.

Ordinary customer onboarding starts at `/register` or `/sign-in`; source enforces email verification, membership, subscription entitlement and workplace completion. It is not a substitute for a prepared free judge route. Billing/email dependencies and the absence of a tested judge route remain blockers.

## Judge exercise after release clearance

1. Review the labelled history and bounded AI staffing recommendation; identify actual inputs and the Manager's accepted operational consequence.
2. Create/offer a shift through Bryntum; use the worker session to inspect and accept its disclosed terms. Demonstrate a scheduling conflict refusal.
3. Complete the allocated test assignment and have the Manager confirm completion. Show the automatic Pay Agent trigger and bounded tool invocation without a casual request or a fresh discretionary payment approval.
4. Observe the server-resolved entitlement and permitted Sandbox settlement. Show the item status, original identifiers, amount/currency and worker history; a batch success is insufficient.
5. Show duplicate prevention and a truthful pending/unknown outcome. Do not create additional live or Sandbox payments merely to illustrate a screen.
6. Demonstrate the separate permanent-tip request only when allocation policy, authentication, ceiling, provider permission and shared settlement have been implemented and verified. Otherwise identify it as blocked.

This exercise is a future acceptance procedure. It was not run in this documentation package. See [submission readiness](SA_SUBMISSION_READINESS.md) for the evidence matrix and final-baseline handoff.
