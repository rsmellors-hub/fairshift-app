Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# FS-UI-PRODUCT-001: Product UI Report

**Status: the final combined tree passed every gate locally, and the owner then authorised deployment.** This report describes the state at that point. What happened next is in [HOSTED_REHEARSAL_EVIDENCE.md](HOSTED_REHEARSAL_EVIDENCE.md).

Every screenshot comes from a production build of the final tree, on a throwaway database with PayPal, Square and OpenAI credentials blank. None comes from hosted or from a provider.

## Verdict on the story

COMMERCE DEMAND → STAFFING NEED → WORK OPPORTUNITY → PERFORMANCE → TRANSPARENT EARNINGS → PAYPAL PAYMENT now reads as one product across every role. The checks show it behaves correctly. Three things still weaken the demo:

1. **Act 3 and Act 4 have no genuine evidence on this build or on hosted.** In these screenshots, sales are labelled Imported and Paid comes from a local stand-in. A genuine hosted run is the next step.
2. **The Fill form doesn't suggest a shift window.** It defaults to 09:00–17:00 and prefills workers from 8-hour indicative shifts, so the 14:00–20:00 shift must be typed in.
3. **Reference data is old.** It ends on 28 Dec 2025, and the pages say so. A judge will see that the forecast rests on 10-month-old labelled data.

## 1. Route inventory

| Area | Before | After |
|---|---|---|
| Public | `/` (one paragraph) | `/`, `/product`, `/pricing`, `/faq`, `/demo` (new; `/demo` is Explore FairShift) |
| Onboarding | `/register`, `/verify-email`, `/account` (technical), `/subscribe`, `/billing/return`, `/onboarding` | Same plus new `/check-email`; `/account` no longer in the signup path; `/invite` signed-out state |
| Owner | `/owner`, `reporting`, `forecast`, `locations`, `locations/[id]`, `workforce`, `policies`, `payments`, `settings` | Same routes, rebuilt. Compensation and Incentives both live on `/owner/policies` |
| Manager | `/manager`, `plan`, `fill`, `allocations`, `team`, `review` | Same routes, relabelled Today, Forecast & staffing, Fill shifts, Allocations, Workers, Review & pay |
| Worker | `/worker`, `shifts`, `earnings`, `availability`, `profile` | Same routes. Bottom nav is Home, Shifts, Earnings, Profile; Availability sits under Profile |

## 2. Design-system decisions

- **One stylesheet.** `src/app/styles.css` replaces the old `styles.css` and `owner/owner.css` (deleted). Owner had a teal palette and Manager/Worker a navy and indigo one; everything now uses teal, which also matches the demo-screen PDF.
- **Tokens:** ink, muted, line, canvas, card, primary, gap (amber), danger, info, radius, shadow.
- **Status never relies on colour alone.** Every badge has words and every heat cell shows its figure.
- **Worker is a phone app at every width:** one centred column with bottom navigation.
- **Demo styling** stays apart in `src/app/demo/demo.css`.

## 3. Public

- **Home:** the brief's headline, CTA order Start your business, Try the demo, Sign in, and a labelled worked example (£96 + £25 = £121) rather than invented dashboard figures.
- **Product:** the 11 steps from the brief, plus what FairShift isn't.
- **Pricing:** figures come from the server catalogue. Annual shows £24.17 and £57.50 per month with Save 17%; Enterprise is 6+ and custom.
- **FAQ:** only what current behaviour can answer. VAT, cancellation, plan change and payout-fee questions are left out rather than guessed.

## 4. Onboarding

Register → Check email → Verify → Plan → PayPal → Workplace and first location → Owner Overview with a setup checklist.

- `/check-email` masks the address and offers Resend. It says "We sent" only when the email service accepted the message; otherwise it says it couldn't send. Delivery counts and "Retry pending operational emails" are gone from normal screens; the notification code underneath is unchanged.
- **The screenshot shows the sent state, which needed a seeded `ACCEPTED` delivery row** because no email provider is configured. The not-sent state is covered by a test.
- The verify link hides the code field once the link has supplied it. Plans say the customer leaves FairShift to approve in PayPal. Raw status text is gone.
- **Decision:** workplace and first location stay one page, because the backend saves them as one validated action.

## 5. Owner

- **Overview:** four figures, "Where are we short next week?", Needs attention, the sales week, a location comparison.
- **First-run checklist:** built from real records (`src/server/product/owner-setup.ts`, read-only) and gone once complete.
- **Forecast:** one matrix of five locations by seven days, each cell showing forecast sales and the gap, shaded by size. Staffing, commercial and evidence detail sit behind disclosures.
- **Location:** Forecast demand → Labour needed → Existing coverage → Remaining gap, then a day-by-day chart.
- **Sales:** filters by location, source and period; one comparison table; sources never combined.
- **Managers, Compensation, Incentives, Payments, Settings:** rebuilt. Incentives read "Reach £200 attributed sales → earn £25 bonus". The new-terms form offers Daily and Hourly only; existing commission policies still display and the backend is unchanged.

## 6. Manager

- **Today:** action queue, the next staffing gap, who is working.
- **Forecast & staffing:** the headline day with a `Fill Saturday gap` CTA that carries the date into Fill.
- **Fill shifts:** the gap's figures stay visible, then the form, then each shift with its terms in a bar (base, target, bonus, up to).
- **Candidates:** the server's own states, with a reason and no Send button when blocked. Readiness notes flag a missing PayPal email or Square mapping.

## 7. Worker

- **Home:** a live target leads only while on shift; otherwise a decision comes first.
- **Offer:** date, time, location, base pay, target, bonus and "up to", all before Accept. Accept stays disabled until the terms are ticked.
- **Accepted versus booked:** "Waiting for your manager" and "You're booked" are separate states.
- **Availability:** Available, Unavailable, Not set, with the meaning of Not set explained.
- **Earnings:** Earned, Pending, Paid, then per shift base + bonus = total.

## 8. Bryntum

Still the primary allocation surface, with no custom calendar. Its colours are mapped to FairShift's status colours through its own variables, the frame matches other tables, and week-view bars stack their hours so they don't clip. Server protections are untouched and their tests pass. The move dialog now says the shift has already been offered or accepted and workers must accept the new terms. Trial licence terms are **NOT VERIFIED**.

## 9. Square presentation

"Square Sandbox · team-member attributed" appears subtly on the target, and `team_member_id` never appears. Mapping and Worker wording claim nothing about a till login. **Square wording is verified by tests, not in these screenshots**, because the final run has no Square connection.

## 10. PayPal presentation

The pay card shows Accepted terms, Attributed sales, Target, Bonus and Total payable, with `Approve £121.00`. Approval says it doesn't send money. Progress reads Approved, Sent to PayPal, Processing, Paid, and Paid needs PayPal's confirmation. References stay in a Manager disclosure and never reach the Worker.

## 11. Empty and error states

Reused or added for: no history, forecast or coverage unavailable, no labour policy, no terms, no workers, no shifts, no allocations, sync failure, AI unavailable, payment service unavailable, payment details missing, no earnings, verification not sent, expired link, demo closed or expired.

## 12. Responsive

55 screen and width combinations at 1440, 1366, 1024, 768 and 390: **0 page overflow, 0 console errors, 0 banned-copy hits, 0 controls under 24px** (radio labels and inline text links excluded). Not every screen ran at every width; `screens/_report.json` lists each one. At 767px and below tables become stacked records. The Owner forecast on a phone is usable but long.

## 13. Accessibility

**Done:** skip link, semantic headings, labelled fields, focus outline, text beside status colour, table captions, 44px primary controls, 24px minimum targets, `scroll-padding-bottom` for the fixed Worker nav.

**NOT VERIFIED:** no screen-reader test and no audit tool such as axe. Contrast wasn't measured page by page. Keyboard behaviour in the Bryntum timeline wasn't tested; the Shift details selector is the non-pointer route to each shift's detail. The chart palette (`#0b8a6d`, `#5a8ef0`, `#c4730c`) passes the palette validator.

## 14. Golden Path walkthrough

Real clicks in headless Chrome and hand-built form posts against the production build. Full results: `screens/_checks.txt`. **86 of 86 checks passed** (18 forged requests, 41 click-through and demo, 27 second pass covering demo writes, cap and reset).

| Step | Result |
|---|---|
| Owner sees five locations and the gap | Shown, labelled Reference |
| Gap reaches the Manager | Date and figures carried into Fill |
| Manager sends offer | Response pending |
| Worker reads terms and accepts, 390px | Accept disabled until ticked; then "Waiting for your manager" |
| Manager finalises | Allocated |
| Worker | "You're booked" |
| Schedule | Shown in Bryntum |
| Manager approves £121 | Approved; nothing sent |
| PayPal unavailable | Says unavailable; never Paid |
| Worker sees £121 Paid, 390px | Shown, from a seeded earlier shift |

**Refusals proven in the browser or over HTTP:** signed-out and wrong-role access, unknown location, unavailable and unactivated workers can't be offered, approval doesn't send money.

### What this evidence is and isn't

- **SIMULATED / STAND-IN:** the Paid screen here. A local stand-in client produced it during seeding, with `FIXTURE-` identifiers. **It is not a new PayPal transaction.**
- **GENUINE PROVIDER EVIDENCE:** the earlier GBP 121.00 PayPal Sandbox payout in `PAYPAL_FINAL_EVIDENCE.md`, and the Square Sandbox attribution in `SQUARE_LIVE_EVIDENCE.md`. No new PayPal or Square transaction was made.
- **Imported, not Square:** all fixture sales are Imported, and the screens say so.
- **`reference:load`:** not run, here or against hosted. The throwaway database called `provisionReferenceHistory` directly, as the test suite does. **That is not equivalent to running `pnpm reference:load` against hosted.**

## 15. Remaining product gaps

- Genuine Act 3 and Act 4 on the release build (see the verdict).
- Fill suggested window and the 8-hour indicative assumption: both need a product rule.
- Review & pay can run long when several shifts are open.
- AI panel reviewed only in its not-configured state; the generated state is covered by tests.
- Earnings statement not built: it needs a backend feature. The per-shift cards are the integration point.
- Sales attribution codes on the Workers table are long and noisy.
- FS-HACK-MASTER-001 wasn't found locally. I worked from the brief, the product spec and the repository.

## 16. Claims that remain prohibited

Physical till login attribution; production Square or PayPal; genuine Square history driving the forecast; hourly forecasting; autonomous AI scheduling; AI choosing workers, setting pay, approving or sending; refunds identifying responsibility or reducing earnings; payroll or tax; cross-location scheduling; Zettle as the active provider; per-session demo isolation.

## 17. Screenshots

`docs/evidence/fs-ui-product-001/screens/`, captured after the tree settled. All 16 required screens are numbered 01–17, and demo mode is 18. `_report.json` and `_checks.txt` hold the per-screen and per-check results.

## 18. Demo Access reconciliation

Built by a parallel session the owner authorised. **Concurrency: SHARED-BUT-RESETTABLE, not isolated.** I reviewed the code and re-tested it on the final build, and found no violation of the authorised model. Decision record: [DEMO_ACCESS_DECISION.md](evidence/fs-ui-product-001/DEMO_ACCESS_DECISION.md). Usability sources: [JOURNEY_USABILITY_REVIEW.md](evidence/fs-ui-product-001/JOURNEY_USABILITY_REVIEW.md).

| Requirement | Result | Evidence |
|---|---|---|
| Designated organisation only | Pass | Configuration only; reset touched no other organisation |
| Server-side DEMO session | Pass | `demo_persona`, `demo_group` on the row; about 2 hours |
| Only configured personas; no arbitrary user, email, org or persona | Pass | Forged persona refused; extra fields ignored |
| Normal role and location permissions | Pass | Demo Manager can't open Owner; demo Worker can't open Manager |
| Demo can't become a normal account, and normal can't become demo | Pass | Tests 10, 11; normal session's switch refused over HTTP |
| No password or account flows | Pass | `/account` and `/subscribe` refused; password reset blocked for demo accounts while configured |
| Prepared evidence can't be mutated | Pass | Move, cancel, import, refresh and Approve refused; rows unchanged |
| No repeated or uncapped PayPal | Pass | Approve and refresh replays refused. **Send** isn't on the page with PayPal blank, so its replay is proven by tests 16–17 only |
| No repeated or uncapped Square | Pass | Tests 18; no Square tools shown; no page polls Square in demo |
| Reset server-side, flag-gated, tenant-scoped, safe | Pass | Closes shifts in one transaction under a lock, keeps acceptance evidence, audited, repeatable |
| Flag off fails closed | Pass | Separate server with the flag off shows "The demo isn't open right now" |
| Method header can't be forged | Pass | Forged GET refused; `/api` routes are outside the proxy, but both require a listed operator (403) |
| Email | Pass | The send step skips the demo organisation; test only, since no email provider is configured here |

**Accepted limits, for the owner to weigh:**
- Two judges can see each other's offers, and one's reset closes another's in-progress shifts.
- The open-shift cap is check-then-insert, so concurrent creates can slightly exceed 12. Rate limits bound this.
- A visitor could exhaust the shared entry or write limits, which shows "The demo is busy". Limits reset on their window.
- Password-reset blocking and email suppression apply only while the demo is configured. With the flag off, the demo accounts behave like normal accounts.
- Reset also closes a finished shift with no confirmed work. That's correct, but a genuine rehearsal must run with the flag off.
- "Short-lived" is implemented as two hours, which is the implementing session's judgement.
- Bryntum drag and Change shift under a demo session are covered by tests only, not by a browser pass.

## 19. Workstreams and reconciliations

- **UI workstream:** public pages, onboarding screens, all Owner, Manager and Worker presentation, the design system, Bryntum theming, copy-test updates, `public-onboarding-ui.test.ts`.
- **Demo Access workstream:** migration 0021, `src/proxy.ts`, `src/lib/request-method.ts`, `src/server/demo/*`, `src/app/demo/*` (replacing my earlier public walkthrough), gates in actions, `src/server/auth/request.ts` and `access.ts`, the notification skip, `demo-access.test.ts`, `journey-readiness.test.ts`, invite fix, password field, checklist correction, location and Square-mapping and payment readiness, friendly dates.
- **Reconciliations needed:**
  1. `= {}` on role page signatures broke `next build`; removed, with callers updated.
  2. Fill's Create panel collapses when a shift already exists on the day, which hid the gap figures. The figures now sit outside the panel, with a test.
  3. Candidate notes pushed Send offer out of line; CSS fixed.
  4. Trailing whitespace from moving that block.
  5. Missing favicon caused a console error; added `src/app/icon.svg`.
  6. Under-24px targets fixed; "Create work opportunity" button relabelled "Create shift".
  7. Chart casual colour changed so it can be told apart from regular.
  8. `testTimeout: 30_000` added (section 20).

## 20. Final gates

All run on the final combined tree, after it stopped changing. Source hash `ee64c4d24be6…` was unchanged from the browser pass through the gates, and the built mirror matched `src`.

| Gate | Result |
|---|---|
| Complete test suite | **663 of 663 passed, 61 files, 0 skipped failures**, 676s |
| Typecheck | Pass |
| Lint | Pass, no warnings shown |
| Production build (`next build --webpack`) | Pass, on the mirror with no `.env` files |
| `git diff --check` | Pass |
| Secret scan | Pass: no `.env.local` secret value or credential pattern in any changed or new text file. The only match is the non-secret `OPENAI_MODEL` default name, already in `.env.example` |
| Migrations | 22 (`0000`–`0021`), applied to a fresh database |
| Browser | 55 screen and width combinations clean; 86 of 86 interaction and tampering checks passed |
| Flag-off server | "The demo isn't open right now" |

**Test failures on the way, explained:** three earlier full runs on near-identical trees gave 663 passed, then 46 failed, then 1 failed. Every failure I could classify was the 5-second limit, under load averages up to 23, and each affected file passes alone. No assertion failed in the 1-failure run. The fix is `testTimeout: 30_000` in `vitest.config.ts`. It changes the time allowed, not what any test asserts, and it's what the newer test files already did. The run above used it. In the 46-failure run, 42 failures were confirmed timeouts; the other 4 weren't individually classified, and all 46 pass in the final run.

**Intermediate failures caused by my own check scripts** (a wrong form selected, an escaped regex, a text-split button) are not in these results; the final pass ran after they were fixed.
