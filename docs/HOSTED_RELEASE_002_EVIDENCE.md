# Hosted Release 002 Evidence (FS-HOSTED-RELEASE-002)

**Status: the hospitality engine is live on `https://getafairshift.com`, with a new five-location reference organisation, a Manager and a Worker. The Golden Path has not been run on hosted.** No PayPal payout, Square payment or OpenAI call was made. Status terms follow `AGENTS.md` §8.

Everything here is **HOSTED EVIDENCE**, except the gates and the restore check (**LOCAL-ONLY**). The organisation's sales are labelled synthetic **REFERENCE DATA**, never provider sales. The genuine provider contact was the PayPal Sandbox subscription and one Open-Meteo and one Ticketmaster fetch for each venue.

## 1. Owner inputs

| Input | Answer |
|---|---|
| OI-A | YES, and the names were checked on Render (section 6) |
| OI-B | Three email aliases the Owner controls. Not recorded here |
| OI-C | KEEP (FS-CONTEXT-SIGNALS-DEC-003) |
| Onboarding | Agent drove the forms in a visible browser. The Owner opened the verification and invitation links and approved PayPal personally |

## 2. Preflight

All as expected: repository path, branch `fs-square-live-001`, HEAD `db2dfde`, 7 commits ahead of `origin/fs-square-live-001` at `e7fcdf9`, `c567f2e` on no remote, `main` and `origin/main` ancestors of HEAD, status clean apart from untracked `.claude/`.

The domain hold recorded in `HOSTED_REHEARSAL_EVIDENCE.md` has cleared: `clientHold` is gone and the apex resolves. Its transfer and update locks remain.

## 3. History rewrite

| Check | Result |
|---|---|
| Method | `git branch backup/pre-squash-db2dfde db2dfde`, `git reset --soft 3816765`, new commit |
| New commit | `58eaf48`, parent `3816765` |
| Tree | `876adaa8b21f3340ae25bc87e0905e96e699cd8c`, identical to `db2dfde` |
| Listing data in the commit range | 324 names, venues and identifiers derived from the former commit. Matches only in ordinary text: "messa" inside "message", "patterns", "the script", and "against the current" in the earlier quotation of this same check |
| Control | The same terms match 525 times in the former commits |
| Removed files | The real-listing fixture, the original records and the screenshots sampled are unreachable from the new commit |
| Backup branch | Local only, never pushed. It still holds the listing data |

The term list was derived from the former commit, so it covers what that commit held. The closeout's list of 306 also covered a later fetch that was never committed.

## 4. Gates

Run on one frozen tree: the checksum of `src`, `tests`, `scripts` and `drizzle` matched before and after both suite runs.

| Check | Result |
|---|---|
| Full suite, run 1 | 69 files, 863 tests passed, 865 s |
| Full suite, run 2 | 69 files, 863 tests passed, 630 s |
| Typecheck | Exit 0 |
| Lint | Exit 0 |
| `pnpm smoke:manager` | PASS |
| Production build | Exit 0, from a copy with no `.env` files, `DATABASE_URL` at a dead local port and no provider keys |
| Baseline integration test | Holds 64.25 h, 32 windows, 20 of 35 location-days |
| Secrets in the release's commit range | 13 values from `.env.local` compared, 0 matches |

The 863 includes one new test for FS-CONTEXT-SIGNALS-DEC-003: "one" is accepted, and digits, "%", "two", "ten" and "percent" stay rejected.

## 5. Backup and migrations

| Item | Result |
|---|---|
| Backup | 2 Nov 2026 23:42 UTC, Node client, one repeatable-read read-only transaction. 38 tables, 3,788 rows, manifest of counts and hashes. Local machine, outside the repository, owner-only permissions. It holds account data, including password hashes |
| Restore check | Into a throwaway local database at `0021`: 38 tables compared by row count and hash, 0 mismatches, 3,704 sales totalling 24047750 minor units. The database was then removed |
| Migrations | `0022`, `0023`, `0024` with `pnpm db:migrate`, `sslmode=require` for that one command |
| Journal | 22 before, 25 after. 38 tables before, 46 after |
| Existing rows | Every existing table's count unchanged. The 8 new tables were empty |
| Old deployment | `e7fcdf9` still returned `ready` on the new schema |

## 6. Environment (names only)

Required by the code and present on Render:

`DATABASE_URL`, `APP_BASE_URL`, `EMAIL_FROM`, `RESEND_API_KEY`, `NOTIFICATIONS_DISPATCH_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `TICKETMASTER_API_KEY`, `COMMERCE_CREDENTIAL_KEY`, `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_APPLICATION_ID`, `FAIRSHIFT_DEMO_TOOLS`, `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_SUBSCRIPTION_WEBHOOK_ID`, and the four `PAYPAL_*_PLAN_ID` names.

Not set: `FAIRSHIFT_PUBLIC_DEMO`, the `FAIRSHIFT_DEMO_*_ID` names, `FAIRSHIFT_OPERATOR_USER_IDS`, `FAIRSHIFT_ENTERPRISE_CONTACT_EMAIL`, Zettle names. No variable was changed.

## 7. Deployment

| Item | Value |
|---|---|
| Commit | `77ae36d`, by push to `fs-square-live-001`, then fast-forwarded to `main`. Render's deploy branch unchanged |
| Deployment | `dep-dbkicut9el5s73brrfn0`, status `live`, 3 Nov 2026 00:10:35 to 00:12:55 UTC |
| `/api/health` | `ready`, database `CONNECTED`, PayPal `SANDBOX_CONFIGURED` on the apex and the Render URL. `www` answers 301 to the apex, then the same |

Committing this document deploys again by the same route, with documentation changes only.

## 8. Organisation

Created through hosted sign-up: registration, email verification, PayPal Sandbox approval and workplace setup, then four locations through "Add a location". No setup script. Hosted email delivery and hosted PayPal subscription approval worked for the first time on this path.

| Item | Value |
|---|---|
| Organisation | "FairShift Reference Hospitality", `03697040-9283-431e-8961-f1777e0f4f29` |
| Subscription | PayPal Sandbox, Multi Outlet, monthly, limit 5, `ACTIVE` |
| Locations | Leeds, Manchester, Birmingham, Brighton, London Stratford, all `Europe/London` |
| Manager, Worker | Both active and verified, both at Leeds |
| Work policy | None, as instructed |

Names and details the specification doesn't state were set to plainly fictional values: "Demo Owner", "Demo Manager", "Demo Worker", Ofcom's reserved drama phone numbers, and an address marked as a fictional venue. Leeds was chosen for the Manager and Worker because they must share a location and it's the venue used in `REFERENCE_REFRESH_EVIDENCE.md`.

The existing "FairShift Demo Organisation" and "FairShift Demo" are untouched: 3,704 sales totalling 24047750 minor units.

## 9. Reference load

`pnpm reference:load`, documented form, no date flags. **255,172 of 255,172** transactions inserted, all `REFERENCE`, through 2 Nov 2026.

| Venue | Transactions | Profile | Coordinates | Hours, cover |
|---|---|---|---|---|
| Leeds | 42,807 | `BUSINESS_DISTRICT` | 53.7975, −1.545 | 7, 7 |
| Manchester | 40,858 | `STADIUM_DISTRICT` | 53.465, −2.288 | 7, 7 |
| Birmingham | 54,097 | `SHOPPING_CENTRE` | 52.4775, −1.8936 | 7, 7 |
| Brighton | 39,833 | `WATERFRONT_OUTDOOR` | 50.8192, −0.142 | 7, 7 |
| London Stratford | 77,577 | `STATION_COMMUTER` | 51.5416, −0.0034 | 7, 7 |

One organisation-level reference workload policy was provisioned. All venue context reads `REFERENCE`. Nothing the loader provisions was set by hand.

## 10. Planning week, as it fell

**Wed 4 Nov to Tue 10 Nov 2026.** Read from the Owner's forecast page, and by the product's staffing code in a read-only database session.

| Venue | Casual hours | Windows | Location-days with a gap |
|---|---|---|---|
| London Stratford | 33 | 11 | 6 |
| Leeds | 20.5 | 11 | 6 |
| Birmingham | 9.75 | 6 | 4 |
| Brighton | 1 | 3 | 3 |
| Manchester | 0.25 | 1 | 1 |
| **All** | **64.5** | **32** | **20 of 35** |

The figure is 64.5 h, not the frozen 64.25 h, because the planning week falls one day later than the test's fixed date. Nothing was adjusted. The page's summary also read: expected transactions 4,981, forecast sales £66,381, required 953 h, existing 1,007 h, "approx. 52 shifts to fill". No accepted scenario exists, and no AI proposal or shift was created.

### One signal refresh

Run by opening each location's plan as the Owner, once each, 3 Nov 2026 about 00:10 to 00:12 UTC. All 10 feed calls succeeded.

| Venue | Weather days | Days with a listing | Listings kept | Outside hours | Standing | Duplicate | Cancelled or moved |
|---|---|---|---|---|---|---|---|
| Leeds | 7 | 4 | 4 | 28 | 0 | 2 | 0 |
| Manchester | 7 | 6 | 10 | 0 | 0 | 0 | 1 |
| Birmingham | 7 | 7 | 37 | 2 | 7 | 0 | 2 |
| Brighton | 7 | 6 | 13 | 0 | 7 | 0 | 0 |
| London Stratford | 7 | 5 | 8 | 0 | 0 | 4 | 0 |
| **All** | **35 of 35** | **28 of 35** | **72** | **30** | **14** | **6** | **3** |

Real listing names are in the hosted database and visible to signed-in users there. No screenshot of them, or of any other hosted page, is committed.

## 11. Findings

- **Slow pages.** Signed in as the Owner, `/owner/forecast` took 14 to 15 s and `/owner/locations` about 30 s, and `/manager/plan` 16 to 20 s. Before the timings, one forecast load exceeded a 30 s limit. Health stayed under 1 s, and Render recorded no restart or memory event. Measured once, over a single connection. Not changed here.
- **Venue country.** Only Leeds has a country, because "Add a location" asks only for a name. The bank-holiday signal needs a location's stated nation, so it reads as unknown at the other four, which is the safe failure. It may also be unknown at Leeds, because the signal can need a province as well. No UK bank holiday was checked for this week.
- **Worker payment details.** The Worker's page says "Payment setup incomplete". No PayPal address was added, because this package makes no payout.
- **Shifts need pay terms.** Creating a shift requires a work policy, so no shift can be created in this organisation until decision D1 is made.

## 12. Demo access (report only, nothing changed)

- **Which organisation "Try the demo" uses:** none. The link goes to `/demo`, which reads one organisation and three memberships from environment variables. They aren't set, so it shows "The demo isn't open right now".
- **Whether it can reach the new organisation:** not today. It would by setting `FAIRSHIFT_PUBLIC_DEMO` and the four `FAIRSHIFT_DEMO_*_ID` values. **INFERENCE**, from reading the code and not run: the organisation meets its entry checks (active and verified accounts, Manager and Worker at one location, linked Worker, active subscription, finished setup).
- **What a demo session could do once open:** select a location, create a requirement, offer, allocate, respond to an offer, change an assignment, reschedule a shift and reset the demo, under its write limits. Without a work policy, creating a requirement wouldn't get anywhere in this organisation.
- **What it can't do:** everything else is refused as read-only, including refreshing signals, entering signals, AI proposals and decisions, pay terms, Square payments, performance, incentives, approval, payouts, worker payment details, account and billing. A demo session never reaches a weather or event provider.
- **Copy to review:** `/demo` publicly describes an earlier completed shift with a £200 target and £96 + £25 = £121. The new organisation has no such shift, and that example isn't a hospitality target under `AGENTS.md`.

## 13. Open blockers

| Item | Position |
|---|---|
| Pay terms (decision D1) | Not made. Blocks shifts, offers and everything after them on hosted |
| Bryntum trial licence | Terms **NOT VERIFIED** |
| Demo access writability | Off, and most of the Golden Path is read-only in a demo session (section 12) |
| Tips | Not implemented. The rule remains open for FS-HOSPITALITY-EARNINGS-001 |
| Open-Meteo | The free tier is non-commercial, and it's now called from a public site |
| Ticketmaster | Terms **NOT VERIFIED**, including sending listings to an AI service. Hosted can now do that when a Manager asks for a proposal |
| Repository visibility | The history half of the pre-public blocker is closed. Visibility wasn't checked or changed |
| Stale statements | `AGENTS.md`, the specification's decision records and earlier evidence still say "not deployed" for the demand context and signals, and `AGENTS.md` still names `c567f2e`. Left as they are: outside this package |

## 14. Untouched

Workload policy, coverage, reference commerce, forecast parameters, scenario percentages, roles, eligibility, offers, Bryntum, Square, incentives, payables, approval, PayPal payouts, Zettle and tips. The only source change in this package is FS-CONTEXT-SIGNALS-DEC-003's one word and its test.
