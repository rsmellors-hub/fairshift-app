Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Operational workflows and work terms

> **Historical evidence, 15 October 2026. It does not direct new work.** Later work replaced its server-pinned demo identities ([`AUTHENTICATED_TENANCY_EVIDENCE.md`](AUTHENTICATED_TENANCY_EVIDENCE.md)), its read-only Bryntum timeline ([`BRYNTUM_UI_EVIDENCE.md`](BRYNTUM_UI_EVIDENCE.md)), its absence of availability ([`OPPORTUNITY_ALLOCATION_JOURNEY_EVIDENCE.md`](OPPORTUNITY_ALLOCATION_JOURNEY_EVIDENCE.md)) and its navigation labels. Current authority: [`FS-DOCUMENT-AUTHORITY-REGISTER.md`](FS-DOCUMENT-AUTHORITY-REGISTER.md). The body below is unchanged.

## Architecture and scope

Manager: Today → Plan → Team → Review. Worker: Home → Shifts → Earnings → Profile.
Owner/Admin policies and the platform operator remain separate surfaces. Superseded
manager URLs redirect into Plan, Team or Review; worker Schedule and Performance
redirect to Shifts and Earnings.

Location membership makes Team the planning source. Departments belong to locations;
workers are not restricted to one department. Each coverage requirement has a date,
time interval, department, requested headcount and a copy of owner-defined economic
terms. Multiple offers and independently allocated workers share one requirement.
The Bryntum 7.3.7 timeline projects offers and allocations using separate event IDs
per offer and remains read only.

Owner/Admin creates immutable policy records for future requirements. Managers
select these policies, confirm performed work and approve the existing calculated
demo incentive. New policies have no incentive; the permanent incentive formula and
additional combinations remain unresolved. Policy creation does not rewrite existing
assignment terms. The application retains its existing server-pinned demonstration
identities; production authentication and role sessions are not implemented.

Team invitations store a generated token and `CREATED_NOT_SENT`. No delivery or
account-redemption capability is claimed. Managers enter contact details, never
PayPal destinations. Stable unique FairShift attribution codes are independent of
invitation tokens and external provider identifiers.

Hourly expected earnings use exact integer arithmetic against scheduled duration.
Daily terms preserve the daily rate. Fractional-cent hourly results are rejected
rather than choosing an unapproved rounding rule. Commission terms carry integer
basis points and the basis `VERIFIED_ATTRIBUTED_SALES`, with no expected fixed earnings.
A separate attributed-sales table prepares the provenance boundary; no ingestion,
seeded worker attribution, Zettle integration or commission payment rail is supplied.
The commission calculator returns an unavailable result without verified attribution,
and requires a rounding-policy decision for fractional cents.

Acceptance requires explicit acknowledgement and the current terms version. An
immutable acceptance row captures identity, assignment, location, department,
schedule, currency, economic and incentive terms, version and timestamp. A database
trigger versions material changes, returns accepted offers to awaiting response and
marks allocations as requiring reacceptance. Reviewed/confirmed work terms are locked.
Historical acceptances retain their original facts; migrations do not fabricate
historical snapshots or allocations.

Work confirmation records operational completion against an allocation. It does
not claim that work earnings were paid. The existing PayPal Sandbox rail still pays
the controlled demo incentive only. Its approval gate, payout reservation, duplicate
protection, destination persistence and provider reconciliation are retained.

## Verification matrix

| Stage | Positive behavior | Negative/control behavior | Automated verification | Integration status | Visible evidence / manual step |
| --- | --- | --- | --- | --- | --- |
| Team | Contact fields, location, attribution code and invitation persist | Missing fields rejected; attribution code cannot change; destination excluded from Manager form | `operations.test.ts`, `product-workspaces.test.ts` | Repository persistence; invitation delivery unavailable | Create two Team members; reload; inspect names, codes and invitation state |
| Work policies | Hourly, daily and commission terms persist and drive requirements | Invalid rates/bases rejected; Manager cannot supply replacement rates to requirement action | `work-terms.test.ts`, `operations.test.ts`, `product-workspaces.test.ts` | Deterministic application logic | Owner → Policies: configure departments and three economic models |
| Coverage / roster | Several workers can share one requirement; offered, accepted and allocated states remain separate | Inactive or out-of-scope workers and accepted overlaps blocked; decline creates no allocation | `operations.test.ts`, `allocation-model.test.ts`, `allocation-scheduler.test.ts` | Bryntum read-only projection | Plan: create a multi-place requirement, invite members, inspect independent timeline rows |
| Acceptance | Explicit acknowledgement snapshots current terms | Unchecked/stale acceptance rejected; material change requires reacceptance; snapshots immutable | `operations.test.ts`, `product-workspaces.test.ts`, `scheduling.test.ts` | Database-backed | Worker → Shifts: review terms; accept enabled only after checking acknowledgement |
| Commission | Percentage and verified attribution basis are visible | No fixed expected amount or payable commission invented; fractional-cent result waits for policy | `work-terms.test.ts`, `operations.test.ts`, `product-workspaces.test.ts` | Attribution ingestion NOT VERIFIED / not implemented | Inspect a commission offer and Earnings unavailable state |
| Review | Manager confirms performed work; existing incentive is deterministic | New assignments reject confirmation before scheduled end; reviewed terms locked; unapproved incentives cannot be paid | `operations.test.ts`, `incentive-payout.test.ts`, `product-workspaces.test.ts` | Existing controlled-demo incentive | Review: record team result, inspect calculation, approve separately |
| Payment | Existing destination, submit and refresh flow retained | Duplicate submission and historical failures remain protected | `incentive-payout.test.ts`, `product-workspaces.test.ts` | Existing SANDBOX-CONNECTED integration; automated provider calls MOCKED | Use only an approved controlled Sandbox run; verify Processing then provider-supported Paid |
| Migration | Existing work, acceptance timestamps, destination and failed payout facts survive | No fabricated acceptance evidence or allocations | `migration.test.ts` plus blank-database integration setup | PGlite PostgreSQL-compatible verification | Apply migrations before hosted verification; inspect migrated history |
| Navigation / scope | Four destinations for each operational role; contextual Plan filters | Old URLs redirect; worker views exclude others' performance and payout diagnostics | `product-shell.test.ts`, `product-workspaces.test.ts`, `operations.test.ts` | Server-rendered application | Check Manager desktop and Worker narrow viewport, back navigation and old URLs |

## Deliberately unresolved boundaries

- Production identity, role authentication and invitation redemption remain outside
  this implementation. Worker UI/actions retain the established demo worker identity;
  generic scheduling services are verified with multiple distinct workers.
- Availability, department preferences and transport delivery are not collected or
  inferred. Eligible candidates are active location members without accepted overlaps.
- Invitations beyond requested headcount are blocked pending an explicit capacity /
  over-invitation policy; no automatic allocation or excess-acceptance resolution exists.
- Existing fixed one-day demo earnings are preserved as daily terms. Historical
  acceptance snapshots are unavailable and are not reconstructed as if accepted.
- Work earnings, daily settlement, commission settlement and gratuity payment are
  not handled by the incentive payment rail. No new payment-authority engine exists.
- No overtime, partial-day reduction, fractional-cent rounding policy, permanent
  incentive formula, provider attribution or Zettle transport behavior is invented.
- Hosted UI behavior and live PayPal behavior require separate manual verification;
  automated tests and a production build do not establish hosted demo readiness.
