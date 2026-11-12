Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# FairShift SA submission readiness

Date: 5 November 2026. Package: FS-HACK-SA-JUDGE-SUBMISSION-001. Classification: SUBMISSION-CRITICAL preparation for SA-R8 / SA-G8, covering canonical SA steps 1–14. **SA-G8 NOT PASSED.** Earlier gates remain prerequisites.

## Authority and source boundary

Owner authorisation dated 5 November 2026 explicitly permits documentation work from `789be8d9c0cb6c810452191609a25d65d6f01fa2` while the canonical checkout remains at `822c5fdf53fd330b5f98845141a157dab6e3c9ad`. The latter is a verified ancestor. This acknowledged difference is not a new discrepancy.

The current uncommitted governance in `../sa-roadmap-worktree` governs: FS-HACK-SA-AMENDMENT-001, FS-HACK-SA-ROADMAP-001, DEC-SA-011, current product specification and authority register. Those documents are not yet integrated here. The old UK roadmap and README descriptions in this source tree do not supersede the approved SA model. This report is a readiness record, not a parallel roadmap or a new Owner decision.

## Official submission checkpoint

Checked 5 November 2026; no source page revision date was displayed. Recheck before any submission.

The [official rules](https://paypalaihackathon.devpost.com/rules), sections 1, 3, 4 and 6, specify the 12 November 2026, 12:00 PM PST deadline and judging through 15 December 2026, 8:00 AM Pacific Time. They require Sandbox PayPal integration plus AI; a working accessible build; a public open-source repository with functional source/setup; English materials; and a public YouTube video under three minutes. Third-party rights and entrant eligibility must be satisfied. Existing projects must explain significant event-period changes. Stage-two criteria are equally weighted: technology, design, impact, innovation and presentation. These are planning facts, never application rules. No entrant eligibility, rights clearance, publication or submission is certified here.

The [official overview](https://paypalaihackathon.devpost.com/) additionally requests identification of the AI tools/models and an explanation of their use. Current tool disclosure must distinguish demand interpretation from the required, currently absent automatic Pay Agent.

## Submission assets and blockers

| Deliverable | Repository evidence / current finding | Required release action |
|---|---|---|
| Functional access | Configurable demo and authenticated routes exist; [judge guide](JUDGE_ACCESS.md) is preparation only | Verify a complete free access route against final revision; no static substitute |
| Source and licence | MIT `LICENSE` exists; package uses Bryntum trial | Verify public source URL/visibility, asset hygiene and third-party terms; publication requires separate authority |
| Setup | README, lockfile, `.env.example`, migration/seed scripts exist | Repair historical instructions and supply tested SA fixtures/access; execute a clean-room install |
| PayPal evidence | Historical UK/GBP and USD Sandbox evidence exists | Prove the approved SA merchant/recipient/category/provider currency; do not relabel prior evidence |
| AI evidence and disclosure | Bounded demand interpretation exists; automatic Pay Agent absent at this commit | Verify actual final model/version, inputs, structured result and allowlisted server consequence |
| Written project description | Historical product descriptions exist | Describe demonstrated final behaviour, audience and limitations; preserve DEC-SA-011 sequencing |
| Video | No release video inspected | Record final functioning build; validate public YouTube playback/duration and rights |
| Final verification | Earlier integration report records tests; no checks rerun here | Verify combined security/ZAR/Agent/tip changes and complete browser/provider path on final revision |

No sponsor-prize selection or sponsor-specific eligibility claim is made. No account, hosting, email, repository visibility or Devpost state was changed.

## Demo Evidence Matrix — baseline 789be8d only

All rows describe the required SA behaviour. REPOSITORY EVIDENCE is source inspection; automated coverage below is existing test source and historical evidence, **not a test execution by this package**. Historical UK provider evidence does not verify the SA path. No complete corrected-SA row is promoted to WORKING.

| SA step | Required positive behaviour | Required negative/control behaviour | Existing automated verification source | Integration status / current gap | User-visible evidence needed and intended demo step |
|---|---|---|---|---|---|
| 1 | Owner reads scoped historical sales with provenance | Missing POS data never becomes zero or silent synthetic history | `reference-history`, `commerce-independence`, `square-live` tests | PARTIAL; history pipeline exists; safety source separate; SA source not verified | Labelled history/source, date range and location; demo opening |
| 2 | Bounded AI informs deterministic staffing under Manager control | Model outage/invalid output preserves valid baseline | `demand-context`, `ai-staffing` tests; historical `DEMAND_CONTEXT_EVIDENCE.md` | PARTIAL; prior genuine local AI evidence, no new call | Actual supplied signals, recommendation and accepted staffing consequence |
| 3 | Manager creates Bryntum shift with preauthorised compensation | Conflict/stale move or unacceptable terms refused | `allocation-scheduler`, `workload-opportunity`, `wage-intelligence` tests | PARTIAL; integrated Bryntum source; SA compensation/preauthorisation not verified | Saved shift and disclosed terms on final integrated build |
| 4 | Eligible location-bound casual receives offer | Wrong location/worker/capacity or overlap blocked | `operations`, `opportunity-journey` tests | PARTIAL; existing offer path | Permitted offer and one conflict refusal |
| 5 | Worker accepts disclosed current terms | Stale terms, another worker or missing acknowledgement refused | `work-payables`, `opportunity-journey` tests | PARTIAL; immutable acceptance exists | Worker acceptance and persisted terms version |
| 6 | Accepted work is allocated and completed | Acceptance alone is not allocation; unfinished schedule cannot be confirmed | `operations`, `work-payables` tests | PARTIAL; allocation and confirm-as-scheduled source, no independent attendance proof | Persisted assignment before Manager completion |
| 7 | Manager confirms completed work | Premature/unauthorised confirmation refused | `work-payables` tests; `confirmWork` | PARTIAL; confirmation exists; next automation absent | Completion confirmation without new discretionary pay approval |
| 8 | Deterministic accepted earnings plus approved tips | Missing performance or unknown tip evidence blocks eligibility | `work-payable`, `performance-incentive`, `square-live` tests | PARTIAL; base + incentive only; tip evidence is not allocation | Explained separate earnings components and any blocked reason |
| 9 | Completion automatically triggers genuine model-backed Pay Agent | Repeated event/model failure cannot lose or duplicate an obligation | No implementation at this commit | ABSENT; separate unintegrated Agent foundation is not this baseline | Actual model invocation automatically tied to completion |
| 10 | Agent invokes an allowlisted settlement action by reference | Arbitrary amounts, destinations, tenants and provider operations rejected | No Agent-tool implementation at this commit | ABSENT | Redacted tool trace and server action outcome |
| 11 | Server resolves entitlement, sender, recipient, currency and authority | Wrong tenant/funding/category/unsupported currency refused before payment | Existing `work-payouts`, auth tests cover a subset | BLOCKED; global payout credentials; SA category/FX and merchant binding unresolved; ZAR gate separate | Server eligibility result with truthful blocker; no bypass |
| 12 | Shared service executes eligible Sandbox payout | No public demo or ordinary-tenant funding fallback | Existing payout/client tests; historical `PAYPAL_FINAL_EVIDENCE.md` | BLOCKED for SA; adapter exists; old UK proof only | Genuine authorised SA Sandbox item, distinct from simulation |
| 13 | Provider IDs/status persist; recovery is safe and idempotent | Duplicate, unknown, mismatched amount and expired no-batch resend protected | `work-payouts`, `work-payout-recovery`, `paypal-final` tests; `PAYOUT_RECOVERY_GUARD_EVIDENCE.md` | PARTIAL; merged recovery source and reported mocked checks; final merchant binding missing | Reloaded identifiers/status; duplicate refusal; no paid claim for unknown |
| 14 | Worker sees own truthful payment/history | Another worker's pay/details remain private; pending is not paid | `product-workspaces`, payout tests | PARTIAL; existing worker view; financial-history entitlement and final access require review | Own payment confirmation/history after item success |
| Supporting permanent tips | Approved period allocation → permitted employee request → same service → proof/history | Ceiling, consent, repeated/concurrent requests, privacy and payroll duplicate protection | Tip capture tests only; no completed tip-settlement tests | ABSENT / BLOCKED; lightweight identity/access, allocation, ceiling and proof/export missing | Separate requested release and status-aware reconciliation, only after implementation |

Test files are under `tests/unit/` or `tests/integration/` with `.test.ts` suffix. Inspect exact paths when preparing a final test invocation; this table is not a shell command. Historical verification at this baseline is recorded in the recovery evidence, including 974/974 reported full-suite passes, typecheck, lint and build. Those results predate the outstanding SA/security/Agent/tip integration and were not rerun here.

## Final integrated baseline handoff

1. Integrate approved SA governance/ZAR gates and separately reviewed security/isolation remediation under their own Owner authority. Preserve accepted currencies and earned obligations; do not overwrite overlapping payment/actions/register edits. Security, ZAR and Agent source are currently separate uncommitted contributions.
2. Resolve provider payment category, SA sender/recipient permissions, merchant/funding binding and ZAR/provider-currency/FX policy. The earlier feasibility research found a published Standard Payouts payroll exclusion; provider clearance cannot be replaced by Owner product approval or a Sandbox success.
3. Resolve the tip policy and permanent-request decisions identified by FS-HACK-SA-TIP-CONTRACT-001, then authorise any schema/application work. Preserve automatic casual sequencing and the separate requested permanent-tip path.
4. Complete and verify genuine Pay Agent orchestration and the shared settlement path. Prior foundation or historical demand-model calls are insufficient evidence.
5. Produce a manifest of the final full commit, integrated contribution commits, migration set, allowed environment, isolated fixture version, tool/model versions and verification results. Pin sender/environment for payment recovery; never recover an old obligation through whichever merchant happens to be globally configured.
6. Run meaningful combined positive/negative tests, then clean-room setup, independent browser/mobile access and the expressly authorised Sandbox exercise. Complete SA-G1–7 before claiming SA-G8.
7. Reconcile every matrix row, remove outdated setup/product claims, fill the judge release record and recheck official rules. Review public-source/data/licence hygiene and final video/description. Publication, deployment and submission each require their own authority.

**Current verdict: submission preparation completed; submission readiness BLOCKED.** This baseline must not be published as the completed SA build, and this package authorises no integration, commit, deployment, provider exercise or submission.
