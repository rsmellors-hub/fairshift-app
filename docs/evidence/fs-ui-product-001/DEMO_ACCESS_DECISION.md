# Public Demo Access: state decision (FS-UI-PRODUCT-001)

**Concurrency: SHARED-BUT-RESETTABLE.** Demo sessions are not isolated from each other. Everyone in the public demo sees the same demonstration business and the same writable shifts. This was decided after inspecting the code and before implementing it.

## Data model implications

- Every operational record hangs off `organisation_id` / `outlet_id`. No table has a session or sandbox dimension.
- `sale_transactions` holds the reference history that drives the forecast. A five-location history is hundreds of thousands of rows.
- Shift records (`shifts`, `shift_offers`, `work_acceptances`, `work_allocations`) reference each other with `restrict` foreign keys, so a reset can delete them in a known order.
- `work_payables`, `work_payouts`, `work_performance_results` and the Square evidence tables record finished work. They are not needed for the writable flow.
- `auth_sessions` has no way to mark a session as a demo session, so that needs a small additive migration (`0021`).

## Option 1: per-session isolation: not feasible at this size

Two ways to do it, both too large:

- **Copying the business per session** means an organisation, five locations, workers, policies, coverage, memberships, and either the reference history or a rework of how forecasts read it. Copying the history per visitor is too expensive for public access.
- **Adding a session column** to the shift tables means changing every scheduling query and its authorisation, a large change to working code during a feature freeze.

## Option 2: deterministic reset: feasible and small

The writable part of the story is only the shift tables. A reset closes (`CANCELLED`) every live shift in the designated organisation that has no finished-work evidence, along with its offers, in one transaction. Demo views leave closed shifts out, so the live state returns to the same starting point, and repeating a reset changes nothing.

**Correction after browser testing:** the first version deleted these shifts. A browser check on an accepted offer showed that an existing database trigger makes acceptance evidence immutable, and it refused the delete. That control is right, so the reset now closes shifts and keeps the evidence. Closed rows stay in the database, and the demo's rate limits keep their growth small.

## Option 3: scheduled reset: not needed

A cap on open demo shifts plus a visible **Reset demo** control recovers the demo. Adding a scheduler would add a moving part with no demonstrated need.

## Design

1. **Identity.** The demo uses three dedicated accounts in one designated organisation, named by server configuration (`FAIRSHIFT_PUBLIC_DEMO`, `FAIRSHIFT_DEMO_ORGANISATION_ID`, and one membership ID per persona). A request only ever names a persona. If the configuration is incomplete or inconsistent, demo access is closed.
2. **Marked sessions.** `auth_sessions` gains `demo_persona` and `demo_group`. Sessions last two hours and are created only by demo entry. Switching persona updates the same session row on the server, so a slow response or double click can't strand a visitor, and it never extends the expiry.
3. **Default deny.** On any non-GET request, a demo session can't pass `requireScope` unless the action explicitly opts in, so a new action is closed by default. Account operations use `requireIdentity`, which refuses demo sessions outright. A proxy sets the request-method header and overwrites any value the client sends.
4. **Writable allowlist.** Only create shift, send offer, respond to offer, finalise allocation, change or move a shift, and choosing a location for viewing. Each write is rate-limited, refused on protected work, and shifts are capped.
5. **Protected evidence.** A shift with a payable, a performance result, an incentive, a confirmed allocation or `COMPLETED` status can't be changed by a demo session and survives reset.
6. **Providers.** Approve, send, status refresh, Square Sandbox payments and shifts, Square sync and mapping, and AI generation are all outside the allowlist, so a demo session can't reach those provider calls. Demo pages don't call Square. Offers create notification records through database triggers, so the send step itself skips the demo organisation and none of it becomes email.
7. **Prepared Paid record.** It isn't manufactured. It must be a genuine record from a controlled, non-public rehearsal in the demo organisation. The accounts can still sign in with a password for that rehearsal, and those sessions aren't demo sessions.

## Why this is enough

It meets the requirement for public access with one additive migration, one proxy file and one small demo module, with no change to forecasting, payments or scheduling rules. Its limit: two judges can see each other's offers and one judge's reset clears another's in-progress shift. Earlier prepared evidence isn't affected. The public copy says the business is shared and prepared, and doesn't imply everything happened in the visitor's own session.

## Operating rule

Turn `FAIRSHIFT_PUBLIC_DEMO` off during the genuine rehearsal, because a reset closes any shift without finished-work evidence, including one in progress. While the flag is on, the demo organisation also sends no email.
