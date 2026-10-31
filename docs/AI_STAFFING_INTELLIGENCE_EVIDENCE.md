# FS-AI-001 Evidence

Operational AI staffing intelligence on top of the deterministic forecast and staffing engine:
reference commerce history → deterministic forecast → deterministic staffing requirement →
**AI operational interpretation** → manager planning.

Evidence labels follow `AGENTS.md` §8. Every time is UTC unless stated otherwise.

**Summary.** FairShift asks a real model to interpret its calculated staffing week. The model
receives aggregate figures with opaque location keys, and its output is stored only if every
reference and number matches those figures. The calculated figures, including the order of
casual gaps, stay authoritative. The AI explains, recommends and flags evidence limits. It
cannot create shifts, allocate workers, or touch pay.

## Repository checkpoint

| Item | Value |
|---|---|
| Start branch / HEAD | `main` / `fd96e78` (clean) |
| Latest migration at start | `0014_work_payouts` |
| Migration added | `0015_ai_staffing_assessments` |

## Architecture

| Part | Where | Role |
|---|---|---|
| Contract | `src/server/intelligence/ai-staffing-contract.ts` | Builds the versioned input, fingerprint and JSON Schema, and validates output. Pure. |
| Service | `src/server/intelligence/ai-staffing.ts` | Authorisation, freshness and persistence. Reading never calls the model. |
| Provider | `src/server/integrations/openai/staffing-assessment.ts` | OpenAI Responses API call with typed failures. |
| Actions | `src/app/intelligence-actions.ts` | Explicit "Generate" requests. They take no form input; scope comes from the session. |
| Panel | `src/app/components/ai-staffing-assessment.tsx` | Owner Forecast and Manager Plan, after the calculated figures. |
| Store | `ai_staffing_assessments` | Input, fingerprint, model metadata and validated output, or failure. |

## Deterministic and AI authority

| Calculated by FairShift (authoritative) | Produced by the AI |
|---|---|
| Historical sales, forecast values and ranges | Weekly summary |
| Required labour, regular and allocated casual coverage | The reason each priority matters |
| Casual gap and indicative shifts | Severity category and recommended action |
| **The order of casual gaps (`rankedGapDays`)** | Evidence limits and signal commentary |
| Count of days with a gap the AI did not list | |
| Pay rates, currencies, earnings, payouts (not sent to the model) | |

**Why the gap order is calculated.** Early genuine runs had correct figures but wrong ordering.
One skipped a 43 h gap, and one called a 42.25 h gap "third-largest" ahead of a 45.5 h gap.
Prompt changes did not fix this. The order is a calculation, so FairShift now supplies it and
rejects output that departs from it.

## Provider and model

- **Provider:** OpenAI, through the repository's existing `OPENAI_API_KEY` and `OPENAI_MODEL`.
- **Model:** `gpt-6-luna`.
- **Call:** `POST https://api.openai.com/v1/responses` with strict `json_schema` output and `store: false`.

Official documentation accessed 31 Oct 2026:

| Source | Establishes |
|---|---|
| [Models](https://developers.openai.com/api/docs/models) | `gpt-6-luna` is a current model available through the Responses API |
| [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | The `text.format` `json_schema` request shape; availability from GPT-4o onwards; refusals as distinct output items |
| [Create a response](https://developers.openai.com/api/docs/api-reference/responses/create) | Request parameters including `store`; response `id`, `status`, `model`, `output` |

The docs do not guarantee length keywords under strict mode, so lengths are enforced by FairShift after the response.

## Input contract

`fs-staffing-ai-input-v1`:

- scope (`ORGANISATION` or `LOCATION`), staffing method version, planning period;
- `rankedGapDays`: every day with a casual gap, largest first;
- per location: opaque key (`L1`…), currency, labour policy version, evidence source and kind, synthetic and stale flags, data-through date, evidence age, regular coverage set or not, data-quality flags, week totals;
- per day: date, weekday, forecast sales, support, required labour, regular and allocated casual coverage, casual gap, indicative shifts, unavailable reason.

## Output contract

`fs-staffing-ai-output-v1`:

- `summary`;
- `priorities[]` (at most 8): rank, location key, date or null, severity, category, reason, 1–4 evidence items, action, action note;
- `constraints[]` (at most 10): type, location key or null, note;
- `signalCommentary`.

Enumerations are closed. Actions are limited to `FILL_SHIFTS`, `REVIEW_REGULAR_COVERAGE`, `REVIEW_FORECAST_EVIDENCE`, `MONITOR` and `NO_ACTION`. All of them are recommendations; none triggers anything.

## Validation

`validateAssessment` stores nothing unless all of these hold:

| Check | Failure code |
|---|---|
| Strict schema, enums, lengths, counts, ranks 1..n in order | `SCHEMA` |
| Locations, dates and `[[L1]]` text tokens exist in the input | `UNKNOWN_REFERENCE` |
| Every evidence value equals the deterministic figure for that location and date or week | `NUMBER_MISMATCH` |
| No digits in any prose field | `NUMBER_IN_TEXT` |
| Category and action are supported, for example `FILL_SHIFTS` needs a gap and `ADEQUATELY_COVERED` needs none | `INCONSISTENT` |
| Dated gap priorities follow `rankedGapDays` from its start, skipping none | `RANKING` |

Because prose cannot contain digits, every number on the panel comes from the calculated input. The panel re-reads each evidence value from that input rather than from the model's response.

**Not validated:** the meaning of the prose. A sentence can still be poorly judged, and the UI says the AI's wording is not checked beyond its figures and references.

## Prompt injection and input safety

- Location names, organisation names and all other free text are never sent. The model sees `L1`, and the UI substitutes the name when rendering.
- The instructions state that the input is data only.
- Nothing the model returns is executed, and no tool or function access is offered.

## Persistence and freshness

- Each row records organisation, location scope, planning period, data-through date, input and output versions, fingerprint, exact input, location key map, provider, requested and returned model, provider response ID, requester, time, and the assessment or failure code.
- **Fingerprint:** SHA-256 of the canonical input, location key map and instructions. A change in evidence or task supersedes earlier assessments. Renaming a location does not.
- **Rows are immutable.** A database trigger rejects updates and deletes, and requires a location row to name a location of its organisation. A check ties status to the assessment and failure fields.
- **One current assessment:** a partial unique index allows one `AVAILABLE` row per organisation, scope and fingerprint.
- **Reuse:** the same evidence is never assessed twice, and generation is rate limited per scope.

| State | What the viewer sees |
|---|---|
| Current | The assessment |
| Stale | A statement that evidence or method changed; **old content is not shown** |
| Failed | The failure in plain language, no AI text, and a retry |
| None | An offer to generate |
| Not configured | A statement that the calculated figures are complete without AI; no button |

**Retired:** the Manager Plan page previously called the model on every render through `getAiOperationalAssessment`. It no longer does. That module is not used by any page and remains only with its unit tests.

## Failure behaviour

| Failure | Result (all verified) |
|---|---|
| No credentials | No generate button; calculated figures complete |
| Invalid key | Genuine HTTP 401; `FAILED / HTTP_401`; status only logged; no AI text |
| Timeout, network, refusal, incomplete, unreadable | Typed code stored; no AI text (mocked provider) |
| Output fails validation | `FAILED / VALIDATION_*`; nothing the model said is shown |
| Assessment store unreadable | Forecast and staffing still render; the panel says AI is unavailable |

## Privacy boundary

Sent: aggregate location and day planning figures only.

Never sent: PayPal credentials, payout recipients, worker data or payment details, authentication secrets, organisation or location names, or outlet IDs.

VERIFIED on the disposable database: across all stored inputs, no location name or outlet ID appeared, and no `@` appeared in any stored input or assessment. Provider error bodies are neither logged nor stored.

## Genuine invocation

**VERIFIED.** All calls came from the running production build, through the UI, against a disposable PostgreSQL 15 database with 30,714 synthetic reference transactions. Planning week: 1–7 Nov 2026. Data through 28 Dec 2025.

| Time | Scope | Result | Provider response ID | Fingerprint | Note |
|---|---|---|---|---|---|
| 14:35:04 | Organisation | `AVAILABLE` | `resp_0e36b6ef86e51bf5016ae5fc99afb887d28edb817291cd3ae0` | `5e97e548d134` | First prompt |
| 14:37:31 | Organisation | `AVAILABLE` | `resp_01720beb8769c038016ae5fd2c617087d2ab6fa0d5958ac4ab` | `9f0b01df2451` | Improved prompt |
| 14:37:53 | Location | `AVAILABLE` | `resp_0eb655de5489229d016ae5fd42026887d28cf38990eb22017b` | `bf801ee76198` | Improved prompt |
| 14:43:48 | Location | `FAILED / HTTP_401` | none | `8a81510cca85` | Deliberate invalid key |
| 14:55:21 | Organisation | `AVAILABLE` | `resp_0d2d8cb2e77c67e9016ae6015a772c87d2bef88c2e230e1743` | `4ac18933092a` | Ranking instruction only; still misordered |
| 14:59:07 | Organisation | `AVAILABLE` | `resp_02e46e72641f29a6016ae6023c631087d2a5d4feca52812277` | `27458e021e55` | **Final contract** |
| 14:59:32 | Location | `AVAILABLE` | `resp_049841d663f53ecf016ae60254cc6487d2a1c99a2ecff50949` | `b2a6e8d8c18a` | **Final contract** |

One further deliberate invalid-key rejection was run on the final build. In total: 6 successful calls, all model `gpt-6-luna`, each validated and stored; 2 rejected by the provider.

Rows from earlier fingerprints show as superseded, which exercised the freshness rule with genuine data: the page reported that evidence or method had changed and hid the older content.

**Final Owner ranking (calculated gaps, AI interpretation alongside):**

| Rank | Location and date | Casual gap |
|---|---|---|
| 1 | Brighton, Sun 1 Nov | 48.5 h |
| 2 | Leeds Briggate, Sat 7 Nov | 45.75 h |
| 3 | Leeds Briggate, Sun 1 Nov | 45.5 h |
| 4 | Birmingham, Sat 7 Nov | 43 h |
| 5 | Manchester, Fri 6 Nov | 42.25 h |
| 6 | Brighton, Sat 7 Nov | 37.75 h |
| 7 | Leeds Briggate, Fri 6 Nov | 33.75 h |
| 8 | Birmingham, Sun 1 Nov | 31.25 h |

The panel adds: "18 other planning days also have a casual labour gap not listed above."

Example AI text: "Uncovered demand clusters on Sunday at Brighton and Leeds Briggate, and across Friday and Saturday at Leeds Briggate, Birmingham, and Manchester… The planning week is mapped from older synthetic reference history."

**UI consumed the stored result:** repeated renders at every width added no rows. Rows stayed at 7 across 6 page renders.

## Browser verification

Local production build; disposable database; headless Chrome; final tree.

| Check | Owner Forecast | Manager Plan |
|---|---|---|
| 1366×768, 1024×768, 390×844 overflow | None | None |
| Console and server errors | None | None |
| Keyboard focus (real Tab) | 25/25, 25/25, 24/24 | 23/24 at each width |
| Priorities shown | 8 | 7 |
| Locations in the AI panel | All five | Leeds Briggate only |

- The one manager focus miss is the existing native date filter, where Chrome highlights an inner segment. It predates this package and was not changed.
- AI content has its own "AI-assisted interpretation" label and is separate from the calculated tables, which still state "No AI is used in these figures".
- **Plan shifts** goes to `/manager/plan?date=2026-11-07#add-requirement` and opens the add-requirement section. Nothing is created.
- Invalid-key and no-key states were checked on the final build, with calculated staffing present.
- No AI path created anything: shifts, offers, allocations, payables and payouts all stayed at 0.

## Reference data honesty

- History stays labelled synthetic with its data-through date (28 Dec 2025), and it is not re-dated.
- Input flags mark it synthetic and stale, and the model must disclose both. Both genuine final assessments did.
- The existing Owner disclosure is unchanged.

## Tests

| Area | Where |
|---|---|
| Deterministic input and fingerprint, no names, schema limits, accepted output, malformed output, unknown references, number mismatches, digits in prose, unsupported claims, calculated ranking | `tests/unit/ai-staffing-contract.test.ts` (8) |
| Stored and reused, no model call on render, staleness and supersession, provider and validation failures, store failure, not configured, tenant/location/role scope, immutability, no evidence means no call, no operational side effects, disclosure, hand-off | `tests/integration/ai-staffing.test.ts` (5) |
| Provider request shape and failure codes | `tests/integration/ai-staffing.test.ts` (1) |
| 0015 leaves existing records unchanged | `tests/integration/migration.test.ts` |

Results on the final tree:

| Check | Result |
|---|---|
| `pnpm test` | **325/325** twice in a row (236 s and 202 s), 44 files |
| Typecheck, lint, `next build`, `smoke:manager`, `git diff --check` | Pass |

Timeouts were not raised. Two AI tests once exceeded the 5 s limit (6.8 s and 5.4 s) just after a stopped suite run. They then ran in about 3 s and passed in both full runs. The cause was not separately established.

## Competition relevance

- **AI is operationally meaningful:** it turns calculated week data into a dated, explained action list that leads into shift planning.
- **It is defensible:** a judge can trace each priority to calculated figures on the same page.
- **It fails truthfully:** deterministic planning works with AI off, failing or rejected.

## Golden-path advancement

| Step | Status |
|---|---|
| 2 Owner views next-week AI forecast/staffing recommendation | SUPPORTED, with the forecast itself deterministic and the recommendation AI-assisted |
| 3 Owner drills into demand, coverage and casual requirement | SUPPORTED, using the existing calculated tables beside the AI panel |
| 4 Manager proceeds from Forecast/Staffing toward Fill Shifts | SUPPORTED as a link into the existing requirement form |

## Known limitations

- Prose meaning is not verified.
- Only the top days are singled out; the rest are counted, not explained.
- A dated priority's link opens shift planning but does not pre-fill times, because shift entry still uses Johannesburg time.
- The Owner sees **Plan shifts** only for their currently selected location.
- Assessments are generated on request, not automatically.
- Nothing is hosted, and migrations 0011–0015 are not applied to any hosted database.

## Claims register

**May now be claimed:**

- "FairShift uses a real AI model (OpenAI `gpt-6-luna`) to interpret its calculated staffing week into ranked, explained priorities."
- "Every figure in an AI assessment is checked against FairShift's calculations before it is stored, and output that disagrees is rejected."
- "AI assessments are stored, auditable, tied to the exact evidence, and not shown once that evidence changes."
- "Forecast and staffing keep working when AI is unavailable."
- "Managers see only their own location's intelligence; Owners see the organisation's."
- "No names, worker data or payment data are sent to the AI provider."

**Still prohibited:**

- AI forecasting. The forecast is deterministic.
- That the AI calculates staffing numbers or decides the ranking of gaps.
- Any AI effect on pay, payouts, incentives, worker performance or shift allocation.
- That AI wording is independently verified.
- Forecast accuracy.
- Zettle, live or real commerce data. The evidence is synthetic reference history.
- Hosted or production verification.
