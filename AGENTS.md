# FairShift — Codex Project Instructions

## 1. Project

FairShift is being developed as an entry for the PayPal AI Hackathon 2026.

This repository is the canonical implementation repository for the hackathon submission.

Competition compliance, demonstrable functionality, engineering quality, and evidence take priority over unnecessary feature expansion.

Do not invent hackathon requirements.

When a task identifies a requirement as an OFFICIAL RULE, treat the supplied wording as controlling. If implementation work exposes ambiguity about a competition requirement, stop and report the ambiguity rather than silently interpreting it.

## 2. Official Competition Control

The project must implement a functioning application that integrates:

- the PayPal developer platform using the free sandbox environment; and
- an AI tool, model, or platform.

PayPal integration must be central to the project.

The final application must function as represented.

A static mockup, static prototype, or non-functional demonstration is not sufficient for the final submission.

The final submission is expected to include a public source repository containing the necessary source, assets, instructions, and an open-source licence.

This project is being substantially developed during the hackathon submission period. Preserve a clear Git history showing material development.

Do not rewrite Git history, squash historical evidence, force-push, or delete development evidence unless explicitly instructed by the project owner.

## 3. Official Judging Criteria

The five Stage Two judging criteria supplied to this project are equally weighted:

1. Technological Implementation
2. Design
3. Potential Impact
4. Innovation/Idea
5. Presentation

Do not invent additional official criteria, weights, scoring systems, or competition requirements.

Recommendations may be made, but they must be identified as engineering or competition strategy rather than Official Rules.

## 4. Product Definition

FairShift is an AI-assisted multi-outlet workforce planning, sales-target, gratuity, incentive, and worker-payment platform.

The intended closed loop is:

PayPal sales/events
→ contextual demand signals
→ AI-assisted demand forecast
→ staffing requirement
→ manager staffing decision
→ applicable team sales target
→ worker shift terms and acceptance
→ live team sales progress
→ result verification
→ base pay + gratuity + optional incentive calculation
→ human approval
→ PayPal payment/payout
→ worker receipt

The core product principle is:

Predict demand.
Staff for it.
Set the target.
Show the team.
Verify the result.
Pay transparently.

## 5. Domain Boundaries

Keep these concepts separate:

- demand forecast
- business sales target
- staffing requirement
- staffing plan
- incentive threshold
- gratuity
- base pay
- payout

Do not collapse them into one field or concept merely for implementation convenience.

FairShift supports regular/permanent workers and flexible/casual workers.

A useful capacity relationship is:

required labour capacity
- scheduled regular labour capacity
= staffing gap or surplus

AI may recommend:

- expected demand;
- required staffing capacity;
- role/capacity gaps;
- target reasonableness;
- contextual signals;
- operational recommendations.

AI must not autonomously:

- hire or fire workers;
- rank workers for employment;
- make disciplinary decisions;
- approve financial payouts;
- fabricate financial results.

A manager or other authorised human remains responsible for consequential employment and financial decisions.

## 6. Team Target Principle

The product uses team/outlet sales targets for the applicable measurement window.

Do not introduce individual worker:

- sales quotas;
- sales rankings;
- performance leaderboards;
- individual revenue attribution for performance surveillance

unless explicitly authorised by the project owner.

Worker-facing views should emphasise:

- shift terms;
- guaranteed/base pay;
- applicable gratuity policy;
- optional incentive;
- shared team target;
- team progress;
- current or potential earnings;
- payment/receipt status.

## 7. AI Boundary

Use AI where probabilistic reasoning is appropriate, including:

- demand forecasting;
- contextual signal interpretation;
- explanations;
- operational recommendations.

Use deterministic application logic for:

- wage calculations;
- gratuity allocation calculations;
- incentive calculations;
- payout amounts;
- approval thresholds;
- permissions;
- financial reconciliation rules.

Do not ask an LLM to calculate authoritative financial amounts where deterministic code can perform the calculation.

Validate structured AI output before it enters application state.

Do not treat an LLM's explanation as evidence that a forecast calculation occurred.

## 8. Context Signals

Potential contextual inputs include:

- historical sales;
- weekday/time;
- seasonality;
- recent momentum;
- weather;
- local events;
- holidays;
- promotions;
- closures;
- transport disruptions;
- relevant local operational signals;
- comparable-event history.

The preferred conceptual pipeline is:

signal discovery
→ relevance assessment
→ structured feature
→ forecasting/recommendation system

Do not arbitrarily convert free-form LLM sentiment into unsupported numeric sales uplift.

## 9. PayPal Boundary

PayPal is a central commerce/payment integration.

Do not simulate PayPal functionality and represent it as a real integration.

Whenever PayPal functionality is displayed, distinguish among:

- real sandbox functionality;
- simulated/demo functionality;
- planned functionality.

Never expose PayPal credentials or secrets in:

- source code;
- client bundles;
- logs;
- screenshots;
- committed environment files.

Use server-side handling for secrets.

Use appropriate verification, authorization, idempotency, reconciliation, and error handling for financial operations.

Do not assume a particular PayPal API is appropriate merely because prototype copy names it.

Before implementing a material PayPal capability, verify that the selected PayPal API actually supports the required operation.

## 10. Prototype Claims

A prior FairShift prototype exists outside this canonical repository.

It contains product concepts and simulated UI.

Prototype labels such as:

- PayPal connected;
- Orders API;
- sandbox connected;
- webhook;
- transaction count;
- payout reference;
- AI forecast;
- forecast confidence;
- weather/event signals;
- payment sent;
- RBAC;
- audit trail

must NOT be treated as evidence that those capabilities have actually been implemented.

Implementation status must be determined from this repository and reproducible runtime evidence.

## 11. Implementation Status Vocabulary

When auditing or reporting functionality, use:

IMPLEMENTED
PARTIAL
SIMULATED
HARDCODED
ABSENT
UNKNOWN

For externally integrated functionality, where useful also distinguish:

REAL
PARTIAL
SIMULATED
ABSENT
UNKNOWN

Do not upgrade a status without evidence.

## 12. Security Baseline

Financial and workforce data require deliberate access control.

At minimum, architecture should account for:

- server-side authorization;
- organisation/outlet scoping;
- worker data isolation;
- role-based permissions;
- secret management;
- webhook/input verification;
- idempotency;
- auditability;
- financial-operation authorization;
- data minimisation.

Do not rely solely on hidden UI elements for authorization.

Never print secret values during audits.

## 13. Engineering Discipline

Before modifying code:

1. inspect the relevant implementation;
2. understand existing architecture;
3. identify dependencies;
4. state assumptions;
5. preserve working behaviour unless the task requires change.

Prefer the smallest coherent implementation that satisfies the task.

Avoid speculative abstraction.

Avoid unnecessary dependencies.

Do not perform unrelated refactors.

Do not silently broaden scope.

Do not change the selected technology stack merely because another stack is preferred.

If a requested implementation conflicts with existing architecture, report the conflict before making a major architectural replacement.

## 14. Verification

A feature is not complete merely because code was written.

Where applicable verify with:

- build;
- typecheck;
- lint;
- unit tests;
- integration tests;
- end-to-end tests;
- API response evidence;
- sandbox evidence;
- persisted-state evidence;
- UI behaviour.

Never claim a test passed if it was not run.

If a test cannot be run, state why.

## 15. Evidence

For material integrations, preserve enough evidence to establish:

- what was implemented;
- where it is implemented;
- how it was tested;
- expected behaviour;
- actual result.

Where useful, reports should identify file paths and relevant line ranges.

Do not fabricate evidence.

## 16. Git Safety

Do not:

- force-push;
- rewrite history;
- delete branches;
- delete evidence;
- reset destructive changes;
- commit secrets;
- commit .env files;
- commit generated dependency directories.

Do not create commits unless the task explicitly authorises a commit.

Before material implementation, inspect Git status.

After implementation, report changed files.

## 17. Scope Control

Each implementation task should have a bounded objective and definition of done.

If additional work is discovered, report it separately rather than silently implementing an expanding feature set.

Use these classifications when supplied by project control:

R = Official Rule requirement
J = Judging contribution
S = Sponsor-prize strategy
E = Engineering enabler
D = Deferred

An E item is not automatically an Official Rule.

An S item is not automatically an Official Rule.

A recommendation is not automatically an Official Rule.

## 18. Sponsor Technology

Sponsor technologies may be integrated when they materially strengthen FairShift.

Current strategic candidates include:

- Bryntum — workforce planning/scheduling;
- AG Grid / AG Studio — portfolio operational intelligence;
- Render — deployment/backend infrastructure;
- APIMatic — PayPal API development context;
- Elastic — contextual/operational intelligence;
- Postman — API testing/evidence.

Do not integrate sponsor products merely to increase sponsor count.

Do not allow sponsor integrations to compromise the core FairShift workflow.

PayPal + AI remain the primary technical story.

## 19. Stop Conditions

Stop and report rather than guessing when:

- an Official Rule appears ambiguous;
- a requested PayPal operation cannot be verified as supported;
- required credentials are unavailable;
- implementation would expose secrets;
- a destructive migration is required unexpectedly;
- an architectural replacement becomes necessary;
- repository state differs materially from task assumptions;
- existing uncommitted work could be overwritten;
- a task would falsely represent simulated functionality as real.

## 20. Priority

Until the core application works, priority is:

1. functioning PayPal sandbox integration;
2. functioning AI integration;
3. central FairShift end-to-end workflow;
4. reliable application state and persistence;
5. human approval and deterministic financial calculations;
6. testing and evidence;
7. coherent product experience;
8. sponsor integrations that materially improve the product;
9. presentation polish.

A functioning, defensible core outranks feature count.
