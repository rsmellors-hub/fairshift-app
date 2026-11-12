Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Context Signals Evidence (FS-CONTEXT-SIGNALS-001)

**Status: implemented and verified locally, with genuine Open-Meteo, Ticketmaster and OpenAI responses. Not deployed.** Parts A to D are all built. Status terms follow `AGENTS.md` §8.

Owner decisions: FS-CONTEXT-SIGNALS-DEC-001 and FS-CONTEXT-SIGNALS-DEC-002, in [`FAIRSHIFT_PRODUCT_UX_SPEC.md`](FAIRSHIFT_PRODUCT_UX_SPEC.md), section 1. The closeout package FS-CONTEXT-SIGNALS-CLOSEOUT-001 is in section 14, and where it changes an earlier section, that section says so. Earlier layer: [`DEMAND_CONTEXT_EVIDENCE.md`](DEMAND_CONTEXT_EVIDENCE.md).

## 1. What the evidence is

| Kind | What it covers | Where |
|---|---|---|
| **GENUINE PROVIDER** | One Open-Meteo and one Ticketmaster fetch for each of the five reference venues, and one OpenAI proposal, on labelled synthetic reference history and a throwaway PostgreSQL database | Sections 4 and 5, `evidence/fs-context-signals-001/genuine-records.json` |
| **SAVED RESPONSE** | One Open-Meteo response, trimmed to the fields FairShift reads, replayed offline | `tests/fixtures/context-signals/open-meteo-leeds.json` |
| **SYNTHETIC LISTINGS** | Invented listings in the provider's shape, marked as synthetic. Real Ticketmaster data isn't kept in the repository (section 14) | `tests/fixtures/context-signals/ticketmaster-synthetic.json` |
| **FIXTURE** | Scripted forecasts, listings and model answers in automated tests. Never provider evidence | `tests/unit/context-signals.test.ts`, `tests/integration/context-signals.test.ts` |

The Manager-entered event in the genuine run is invented rehearsal text about the fictional company, and is named as such. The reference venues aren't real premises.

## 2. Signals

| Signal | Source | Label shown | Direction | Time |
|---|---|---|---|---|
| Weather | Open-Meteo hourly rain chance, rain amount and temperature, for each planning day's trading hours | "Weather forecast from Open-Meteo, not a measurement" | None, because the effect depends on the venue | Trading-hours span, with hourly values |
| Bookings | Manager: date, optional period, bookings or expected covers, comparison with a usual day | "Manager-entered context, not independently verified" | From the Manager's comparison: above up, similar flat, below down, not stated none | Optional |
| Local event (Manager) | Manager: name, date, start, end, distance band, optional attendance band | As above | None | Required |
| Promotion | Manager: name, date range, optional period, description | As above | None | Optional |
| Local event (provider) | Ticketmaster Discovery API, within 3 km, for the planning week | "Listed by Ticketmaster, listings aren’t complete" | None | The provider's start, and its end only where it really states one. FairShift invents none. The signal claims no period, and shows an influence window (section 14) |
| Momentum, bank holiday, free-text note | Unchanged from FS-DEMAND-CONTEXT-001 | Unchanged | Unchanged | None |

FairShift's code writes every summary. Free text stays data, and the instructions tell the model to ignore anything in it that reads as an instruction. Coordinates are never sent to the model. The venue profile goes as an enum or null, and no code applies an effect by profile. A missing signal reads as unknown, never as fine weather or a quiet neighbourhood.

**Settings chosen in this package, none by looking at a result:** rain words at 30% ("possible") and 50% ("likely"), for the summary only; attendance bands under 1,000, 1,000–10,000, over 10,000; at most 15 listings a date, as an input bound.

**Reference configuration.** Profiles follow each venue's existing A–E design. Coordinates were set from the profile before any fetch:

| Venue | Profile | Latitude, longitude | Area |
|---|---|---|---|
| Leeds | `BUSINESS_DISTRICT` | 53.7975, −1.545 | City centre, around Park Row |
| Manchester | `STADIUM_DISTRICT` | 53.465, −2.288 | Old Trafford stadium area |
| Birmingham | `SHOPPING_CENTRE` | 52.4775, −1.8936 | Bullring area |
| Brighton | `WATERFRONT_OUTDOOR` | 50.8192, −0.142 | Seafront, around King's Road |
| London Stratford | `STATION_COMMUTER` | 51.5416, −0.0034 | Stratford station area |

## 3. Refresh and failure

- **When.** On an explicit "Check weather and events now", or on opening the Manager's plan when the last good fetch is over 6 hours old. Public demo sessions never reach a provider.
- **How long.** Page open waits at most 3 seconds a provider, and both feeds run together. After a failure it tries again no sooner than 15 minutes later, and two open tabs make one call.
- **Failure.** The last good signals stay, shown as stale with their age, and planning carries on. A failed fetch deletes nothing and doesn't change the fingerprint.
- **Staleness of a decision.** A listing that changes, or a forecast that changes band, alters the input fingerprint, so an earlier proposal or acceptance stops applying, under the existing rule. A revision within its bands doesn't (section 14). A forecast returning to its earlier values brings the earlier decision back. Age alone never makes a decision stale: the model is told the age, outside the fingerprint.
- **Key.** The Ticketmaster key travels in the query string as the API requires, so request URLs are never logged, stored or put in an error. A check of the server log, a dump of the context tables and the repository's tracked and untracked files found no copy of it.

## 4. Genuine fetch

The first fetch, before the listing filter. The filter's counts are in section 14. Retrieved 2 Nov 2026, about 19:20 UTC. All ten calls returned HTTP 200. Full results are in `genuine-records.json`.

| Venue | Forecast days | Listed by Ticketmaster | Kept after rules |
|---|---|---|---|
| Leeds | 7 | 31 | 28 |
| Manchester | 7 | 9 | 9 |
| Birmingham | 7 | 45 | 43 |
| Brighton | 7 | 18 | 18 |
| London Stratford | 7 | 12 | 8 |

After reviewing these, three things in FairShift's own processing were corrected and re-derived **from the saved responses, with no further provider call**: repeated package listings, the wording "up to 0%", and a per-day limit of six that had dropped a football match in favour of nearer small venues. None of these changes a staffing rule or was chosen to produce a staffing result.

**Coverage, as it fell.**

- **Football appears, unevenly.** Three matches were listed: two near Birmingham and one near London Stratford.
- **The stadium-district venue showed no football.** Nothing at Old Trafford was listed for 3–9 Nov. This run can't say whether no match was scheduled or Ticketmaster doesn't list it, so FairShift's copy says listings aren't complete.
- **Not all listings were events.** Daily attractions appeared, because no filter was applied. FS-CONTEXT-SIGNALS-DEC-002 now excludes them.
- **Many listings were after closing.** Most Leeds listings start in the evening, after that venue's 17:00 close on weekdays. FS-CONTEXT-SIGNALS-DEC-002 now excludes those that can't reach trading hours.

## 5. Genuine AI proposal

Chosen before any weather or event result was seen, and recorded with a timestamp: **Leeds, Wed 4 Nov**, with a Manager-entered rehearsal event, "Rehearsal trade conference next door", 12:00–14:00, under 1 km, 1,000 to 10,000 attending.

| Supplied | Value |
|---|---|
| Venue profile | `BUSINESS_DISTRICT` |
| Weather | Rain likely 09:00–16:00 (up to 60%), top 11°C |
| Listed events | Three, all starting at 18:30 or later |
| Manager event | As above |
| Momentum | 2.3% higher |

| Returned | Value |
|---|---|
| Scenario | `MINOR_UP` (+5%) |
| Period | 12:00–14:00 |
| Cited | The Manager's event only |
| Model | `gpt-6-luna` |
| Reason | "A manager-entered note describes a nearby trade conference during the midday period, which could bring additional visitors to this business-district location. The event and its potential effect are unverified." |

The model used the venue profile and targeted the note's period. **It did not cite the weather or the listed events**, so this answer didn't rest on a provider signal. Section 14 has the later runs. One answer shows the path works. It says nothing about the quality of its judgement.

**Before and after acceptance, real figures:**

| | Baseline | Accepted |
|---|---|---|
| Day: expected transactions | 155 | **158** |
| Day: required staff capacity | 26.75 h | **27.25 h** |
| Day: casual requirement | 4.75 h | **5.25 h** |
| 12:00–14:00: expected transactions | 62 | **66** |
| 12:00–14:00: required / casual | 9.25 h / 3.25 h | **9.75 h / 3.75 h** |
| Leeds week: casual | 20.25 h | **20.75 h** |

The 08:00–10:00 window stayed at 37 transactions and 1.5 h, unchanged. Fill Shifts showed "Includes the accepted scenario Minor increase (+5%) for 12:00–14:00".

## 6. Baseline unchanged

With no accepted scenario the company week read **64.25 h** on the Owner's forecast page in this run, with the genuine signals loaded. The integration test `demand-context.test.ts` holds **64.25 h, 32 windows and 20 of 35 location-days** through the real loader. The workload policy, coverage, reference commerce, forecast parameters and scenario percentages are unchanged. Worker, Bryntum, Square, performance, incentive, payable, approval, PayPal and Zettle source wasn't changed, except that a shift's frozen "why" record can now carry the scenario's period.

## 7. Controls

- **Output contract v3:** `scenario`, `period`, `citedSignalIds`, `reason`. Strict Structured Outputs, with the period closed to the day's block boundaries. Input v3 adds each event's `influenceWindow`.
- **Validator rejects, whole:** a period outside trading hours, off block boundaries, across a trading gap, outside any cited event's influence window, citing an event with no start time, or overlapping no cited signal that has a time, plus every earlier rule. A period on `NONE` means nothing and is dropped.
- **Arithmetic:** code applies the fixed basis points to the blocks in the period. Blocks outside it are identical to the baseline.
- **Database:** closed signal types and provenance, closed profile, coordinate ranges, a period check on signals and proposals, and a decision must repeat its proposal's period.
- **Scope:** location always from the session. Workers refused. Only an Owner sets venue context.

## 8. Screenshots

In `evidence/fs-context-signals-001/`, from the first walkthrough: `05` Owner forecast at baseline, `06` Owner venue context, `08` Fill Shifts.

**Removed, because they showed real listing names:** `01` forecast with signals, `02` structured event form, `03` Manager event saved, `04` genuine proposal with period, `07` accepted and recalculated, `w1024`, `w768` and `w390`. They're replaced by the synthetic set in `evidence/fs-context-signals-closeout-001/` (section 14), so **no committed screenshot now shows a genuine proposal**. The genuine answers are recorded as text and JSON instead.

## 9. Limitations and open items

- **Not deployed.** Migration `0024_context_signals` is additive and hasn't been applied to hosted. Most of the app reads `outlets`, so it must be applied before this code runs there.
- **Open-Meteo's free tier is non-commercial.** Production needs its paid plan or another provider.
- **Ticketmaster's terms are NOT VERIFIED** for this use, including sending listings to an AI service. Check them before any public release. **Pre-public blocker: section 14.**
- **A Manager's event can state only start and end together.** The form requires both, so the rule's no-end and no-start cases are reachable only through a listing today. The shared rule is tested for both kinds.
- **An influence window stays on the event's own date.** An event just after midnight has no effect on the evening before in FairShift, and a late event none on the next morning.
- **A venue's coverage of events differs by listing,** and silence isn't evidence of nothing happening.
- **Package listings can still mislead on the name.** One venue and start time counts once, under the shorter name, which can be the package's.
- **Forecast revisions can still send decisions back for review.** Bands reduce this, but a value just across an edge still counts, and how often it happens across real refreshes hasn't been measured. A live demo should still expect that an accepted day can read "Needs review" after a refresh that crosses a band.
- **Not exercised genuinely:** the explicit refresh button, page-open refresh and provider failure (fixtures and integration tests only); Bookings and Promotion reaching the real model; a weather citation.
- **Reasons can be rejected on ordinary words.** The figure check treated "one" as a number until FS-CONTEXT-SIGNALS-DEC-003 removed that word. Similar words remain rejected. A genuine answer was rejected under this check in section 14, and which word tripped it isn't known, so this change may not have altered that answer.
- **The public demo stays read-only here,** so a judge would need a prepared accepted state.
- **Coordinates are entered by hand.** No geocoding.

## 10. Claims

**Supported, with the qualification below:**

> FairShift's AI can weigh weather and local events against each venue's demand baseline and propose when demand may change, from fixed assumptions, and a Manager decides whether it changes staffing.

**Qualification.** The package's rule allows this wording once a genuine run has cited one of the two, and one has: a genuine answer cited a Ticketmaster event (section 14). **No genuine answer has cited weather**, though weather was supplied in every run, so it must not be said that weather has driven a proposal. It rests on one valid answer, whose accepted scenario changed no staffing hours, and says nothing about the quality of its judgement. Bookings and promotions reached the model only in fixtures, so they stay out of this wording.

**Prohibited:** measured or learned weather or event effects; AI forecasting demand by itself; reservation-platform integration; Manager-entered signals being verified; complete event coverage; anything about tips.

## 11. Tips addendum

FS-TIP-DEC-001 now records the pre-approval refund rule and the two items open for FS-HOSPITALITY-EARNINGS-001. Nothing about tips is implemented.

## 12. Quality gates

The gates for FS-CONTEXT-SIGNALS-001. The closeout's are in section 14. Run on one frozen tree: a checksum of `src`, `tests`, `scripts` and `drizzle` matched before and after both test runs. Only documentation changed afterwards.

| Check | Result |
|---|---|
| Full test suite, run 1 | 69 files, 841 tests passed, 707.7 s |
| Full test suite, run 2 | 69 files, 841 tests passed, 706.7 s |
| New tests | `tests/unit/context-signals.test.ts` (41), `tests/integration/context-signals.test.ts` (25) |
| Changed tests | `owner-onboarding.test.ts`: pinned migration count 24 → 25. `demand-context.test.ts`: helpers given the new period and blocks |
| Typecheck | `tsc --noEmit`, exit 0 |
| Lint | `eslint .`, exit 0 |
| Smoke | `pnpm smoke:manager`, PASS |
| Production build | Exit 0, from a copy with no `.env` files, with `DATABASE_URL` at a dead local port and no provider keys |
| Browser walkthrough | Headless Chrome on a local production build, throwaway PostgreSQL. No console errors, no overflow at 1280, 1024, 768 and 390 px |

An earlier pair of full runs had 11 failures with one cause: a new export on a module that eight test files mock whole. The helper moved to the Ticketmaster adapter, and both runs were repeated in full.

The walkthrough ran before two later changes: the per-day listing limit and that helper's move. Neither touches Leeds on 4 Nov, which has three listings, and the Birmingham result was re-derived from the saved responses rather than walked through the browser again.

## 13. Safety

Nothing was pushed or deployed, and hosted data wasn't touched. Provider keys were read only for the local server and fetch processes. No Square, PayPal or Zettle call was made.

## 14. Closeout (FS-CONTEXT-SIGNALS-CLOSEOUT-001)

Decision: FS-CONTEXT-SIGNALS-DEC-002, recorded in the specification before any code changed. Records: `evidence/fs-context-signals-closeout-001/genuine-run.json`.

### Event influence window

From 2 hours before the start to 1 hour after the end, or to 3 hours after the start with no end. One function serves Manager and provider events alike (`src/server/intelligence/event-influence.ts`). A period that only touches a window's edge doesn't overlap it. A scenario must overlap the window of every event it cites, and an event with no start time supports only a whole-day scenario. The model receives each window, and the Manager sees it beside each event. Weather's rule is unchanged. Contract input and output are now v3.

### Listing filter

Each listing is counted once, under the first rule it meets, in the order below. The counts go into the refresh's audit event.

| Reason | Rule and the exact provider fields |
|---|---|
| Standing or long-running | `dates.spanMultipleDays` is true; or `dates.end.localDate` with `dates.end.localTime` puts the end 24 hours or more after the start; or the primary `classifications[].segment.name` is `Miscellaneous` and the same name, venue and `dates.start.localTime` is listed on another date in the same fetch |
| Outside trading hours | The influence window, from `dates.start.localTime` and any stated end, doesn't overlap the venue's windows that day, or the venue is closed. A listing with no start time stays on an open day. Where no hours are known, nothing is judged |
| Duplicate | Same venue, date and start time (existing rule) |

No name, keyword, size or genre is read. Start times marked `dates.start.timeTBA` or `noSpecificTime` count as no start time.

**How the standing rule was reached, and what it can't do.** The provider has no field for a standing attraction, and `dates.spanMultipleDays` was false on all 115 saved listings, so that field alone found nothing. The repeat-in-Miscellaneous rule was written after seeing the saved listings, so it isn't blind to them. It's stated in structural terms and doesn't read the attraction's name, and a one-off in that segment stays. **A music residency near London Stratford stays**, because each performance is a dated event in another segment. The Owner may read "long-running" as including it, which this rule doesn't.

**What `dates.end` turned out to be.** 35 of the 115 saved listings have one. All 35 give the start's own local time and no date, and their `dateTime` equals `dates.access.endDateTime`, the end of entry. That doesn't state when an event ends, so FairShift treats it as no end, and the 3-hour rule applied to every saved listing. An end later than the start would be used, which a synthetic test covers, but none has been seen from the provider.

### Filter counts

Identical from both sources: re-derived offline from the saved responses of the earlier fetch, with no Ticketmaster call, and from the audit events of the new fetch at 21:35 UTC.

| Venue | Listed | Standing | Outside hours | Duplicate | Cancelled or moved | Kept |
|---|---|---|---|---|---|---|
| Leeds | 31 | 0 | 27 | 1 | 0 | **3** |
| Manchester | 9 | 0 | 0 | 0 | 0 | **9** |
| Birmingham | 45 | 7 | 2 | 0 | 2 | **34** |
| Brighton | 18 | 7 | 0 | 0 | 0 | **11** |
| London Stratford | 12 | 0 | 0 | 4 | 0 | **8** |
| **All** | **115** | **14** | **29** | **5** | **2** | **65** |

Cancelled or moved is the existing rule. No listing was outside the radius or the planning week, or over the per-day bound.

### Weather bands

The fingerprint compares rain chance in steps of 10 points, rain in steps of 0.5 mm and temperature in steps of 2°C. Bands start at zero, so the summary's 30% and 50% words only change when a band does. Full-precision values are stored, shown and sent to the model.

A signal row can't be edited (database trigger), so each distinct reading keeps its own row and id, and no migration was needed. The fingerprint ignores a forecast's id and summary. After a within-band revision the page shows the new reading and treats a citation of the earlier reading as this one, while the stored proposal keeps the id it cited.

### Redaction and the history blocker

- `evidence/fs-context-signals-001/genuine-records.json`: listing names, venue names, identifiers, summaries and exact distances replaced with start times, distance bands, per-date counts and a reference keyed with a discarded secret. Weather and the Manager's rehearsal event stay.
- The fixture built from real listings is deleted, replaced by invented listings with the same shapes and edge cases.
- Eight screenshots removed (section 8), and listing names taken out of this document.
- The new records hold no listing data. A check of every listing name, venue and identifier from both fetches against the working tree's text files is reported with the gates below.

> **Later change:** the history half of this blocker is closed. See "History rewrite" below. The paragraph that follows records the position at closeout.

**PRE-PUBLIC BLOCKER: history must be cleaned or terms verified before the repository is made public.** History was not rewritten. Commit `c567f2e` still contains the original data: `genuine-records.json`, `tests/fixtures/context-signals/ticketmaster-stratford.json`, the eight screenshots and the names in this document. The closeout commit's own diff shows the removed lines too. By the local remote-tracking refs, `c567f2e` isn't on `origin`, whose branch is at `e7fcdf9`, so the data hasn't been pushed from here. The repository's current visibility wasn't checked. The Owner will decide how to deal with this.

### History rewrite (FS-HOSTED-RELEASE-002)

**The history half of the pre-public blocker is closed.** Before any push, the two unpushed commits `c567f2e` and `db2dfde` were replaced with one commit, `58eaf48`, parented on `3816765`, using a soft reset and a new commit. Neither former commit had reached a remote.

| Check | Result |
|---|---|
| Tree | `876adaa8`, identical to the former closeout commit |
| Parent | `3816765` |
| Listing data in the patches from `origin`'s former branch tip to the new commit | 324 names, venues and identifiers derived from the former commit. Only ordinary-English matches in unrelated text: "messa" inside "message", "patterns", "the script", and the phrase "against the current" in this document's earlier quotation of the same check |
| Control | The same terms match 525 times in the former commits, so the check can find them |
| Removed files | The original records, the real-listing fixture and the screenshots sampled are unreachable from the new commit |

A local branch, `backup/pre-squash-db2dfde`, keeps the former commits and is never pushed. Ticketmaster's terms remain **NOT VERIFIED**, including sending listings to an AI service, and the repository's visibility is a separate Owner decision.

### Genuine runs, as they fell

One refresh of each feed for the five venues at 21:35 UTC on 2 Nov 2026, all HTTP success, then two `gpt-6-luna` calls through the real service on a throwaway database with labelled synthetic reference history. No Manager signal was added. The selection rules and an acceptance rule (accept a valid non-`NONE` answer, record the figures) were written down before the refresh, and the selection was recorded before the first call. Both calls ran from a script under the Owner role, and the acceptance was that script applying the rule. Nothing was re-run.

| | Run 1: weather | Run 2: provider event |
|---|---|---|
| Rule's choice | Highest hourly rain chance in trading hours across 35 venue-days: **Leeds, Wed 4 Nov, 57%**, no tie | Earliest day with a retained listing: **Birmingham, Tue 3 Nov**, with 2 |
| Supplied | Rain likely 10:00–15:00 (up to 57%), top 11.3°C; one listing starting 18:30 (window 16:30–21:30); momentum +2.3%; profile `BUSINESS_DISTRICT` | Low chance of rain (up to 2%), top 11.1°C; listings starting 19:00 and 20:00 (windows 17:00–22:00, 18:00–23:00); momentum +4.7%; profile `SHOPPING_CENTRE` |
| Answer | **`MINOR_UP` (+5%), 16:00–17:00** | **Rejected: `VALIDATION_NUMBER_IN_REASON`** |
| Cited | **The Ticketmaster listing only. Not the weather** | Not recorded for a rejected answer |
| Reason | "A nearby provider-listed event may bring some pre-event trade during the closing part of the trading day, though attendance is unknown." | Not retained, by design |
| Outcome | Accepted under the rule | Baseline stands, no retry |

**Run 1.** The run chosen for weather didn't use it, and the answer rests on a provider event, using the half hour of its influence window before closing. Under the earlier rule this listing had no time limit on it. This is one answer, and it says nothing about the quality of the judgement.

| Leeds, Wed 4 Nov | Baseline | Accepted |
|---|---|---|
| Day: expected transactions | 154.527 (shown as 155) | **154.69** (shown as 155) |
| Day: required staff capacity | 26.75 h | **26.75 h** |
| Day: casual requirement | 4.75 h | **4.75 h** |
| 16:00–17:00: expected transactions | 3.25 | **3.413** |
| 16:00–17:00: required / casual | 2 h / 0 h | **2 h / 0 h** |
| Leeds week: casual | 20.25 h | **20.25 h** |

**The accepted scenario changed no staffing hours.** That hour is quiet and held at minimum cover, so +5% of it moves nothing.

**Run 2.** The figure check refused the answer, and FairShift doesn't keep rejected text, so it can't be said what the model chose or which word tripped the check: a real figure or an ordinary word (section 9). That day's casual requirement is 0 h regardless.

### Baseline

On the throwaway database with the genuine signals loaded, before any decision: **64.25 casual hours, 32 windows, 20 of 35 location-days**. The integration test holds the same figures through the real loader. Scenario percentages, the workload policy, coverage, reference commerce and forecast parameters are unchanged. No worker, Bryntum, Square, incentive, payable, approval, PayPal or Zettle source changed.

### Screenshots

In `evidence/fs-context-signals-closeout-001/`, on invented listings and a scripted proposal, labelled as such on the page: `01` signals with influence windows, `02` event form, `03` accepted, `w1280`, `w768`, `w390`. The forecast behind them comes from the saved Open-Meteo response. Fill Shifts wasn't retaken, and `08` above still stands for it.

### Quality gates

Run on one frozen tree: a checksum of `src`, `tests`, `scripts` and `drizzle` matched before and after both test runs. Only documentation and evidence changed afterwards.

| Check | Result |
|---|---|
| Full test suite, run 1 | 69 files, 862 tests passed, 669.4 s |
| Full test suite, run 2 | 69 files, 862 tests passed, 767.3 s |
| Tests | 21 net new, in `tests/unit/context-signals.test.ts` and `tests/integration/context-signals.test.ts`, for window boundaries, identical treatment of both event kinds, the weather rule, each filter reason, synthetic fixtures only, and bands |
| Typecheck | `tsc --noEmit`, exit 0 |
| Lint | `eslint .`, exit 0, no warnings |
| Smoke | `pnpm smoke:manager`, PASS |
| Production build | Exit 0, from a copy with no `.env` files, with `DATABASE_URL` at a dead local port and no provider keys |
| Browser check | Headless Chrome on that build, throwaway PostgreSQL, synthetic listings and a placeholder event key. No console errors, no page overflow and no external request at 1280, 768 and 390 px. 390 px was also checked by eye |
| Listing data | 306 names, venues and identifiers from both fetches, checked against 379 text files in the working tree. Five hits, all ordinary English in unrelated text: "feedback", "patterns", "the script", "dinner", "against the current". Images: the three kept and the new set were looked at or use invented data |
| Keys | Five provider secrets compared by value against tracked and untracked files and this run's logs. No match |

This package's provider calls: five Open-Meteo, five Ticketmaster and two OpenAI, all in the genuine run. No Square, PayPal or Zettle call. Nothing pushed or deployed, and no hosted migration applied. No migration was added.
