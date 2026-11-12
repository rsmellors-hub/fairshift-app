Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Journey usability review (FS-UI-PRODUCT-001)

How the signup and demo journeys were checked against published guidance, and what was changed. No conversion or drop-off has been measured: FairShift has no real users yet, so nothing here is a measured improvement. Evidence strength differs by source, as labelled.

## Sources and how far to trust them

| Source | Strength | What it supports |
|---|---|---|
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [What's New](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) | Formal standard | Target size, focus visibility, redundant entry, accessible sign-in |
| [Baymard: password requirements](https://baymard.com/blog/password-requirements-and-password-reset) | Published usability research | Strict password rules cause sign-in problems on later visits; state requirements up front |
| [Baymard: show-password guideline](https://baymard.com/guidelines/665-show-password-feature) | Guideline title only; the full text wasn't read | A show-password feature is a recognised guideline |
| [HelpHero](https://helphero.co/blog/saas-onboarding/), [SaaS UI](https://www.saasui.design/blog/saas-onboarding-ux-examples) | Practitioner articles, no controlled data | One action per empty state; value-ordered checklists; avoid long setup forms |

The search for Nielsen Norman Group guidance on these specific points returned no relevant NN/g articles, so none is cited as support. The search found no evidence on a demo before signup. That decision rests on the judge-access need, not on research.

## Guidance applied

| Guidance | Change | Status |
|---|---|---|
| Let password managers and paste work, and let people check what they typed (WCAG 3.3.8, Baymard) | Show/hide control on sign-in and registration; standard `autocomplete` values; no confirm-password field | Implemented |
| State password rules up front (Baymard) | "At least 12 characters" shown under the field | Implemented |
| Don't ask for known information again (WCAG 3.3.7) | Forecast day and gap carry into Fill shifts; the invitation code survives signing in or registering | Browser-checked for Fill shifts; tested for the invite route's redirects |
| Targets of at least 24×24px (WCAG 2.5.8) | Automated check on Worker Earnings at 390px found none smaller | Checked on that page only |
| Focus not hidden by sticky content (WCAG 2.4.11) | Scroll padding for the fixed Worker navigation | Added by the UI session; not separately tested with a keyboard |
| Empty states give one next step | Empty Allocations and Workers pages link to the next action; the setup checklist leads with one button | Implemented |
| Setup in small, value-ordered steps | Setup checklist reads live state and hides when complete, with location and Square mapping steps only where they apply | Tested |

## Friction found by walking the product

These came from using the product, not from the sources above.

| Found | Fix |
|---|---|
| "Try the demo" led nowhere | One-click entry for Owner, Manager or Worker |
| Invited people who registered were sent to the owner's "Check your email" and lost their route back | Registration and sign-in return them to their invitation |
| After creating a shift, the form stayed open and pushed the next step off screen | The form collapses once that day has a shift |
| Demo bar took about a quarter of a phone screen above the offer | Compact bar on phones |
| Generic "Changes saved" after accepting a shift | "Response saved" on Worker Shifts, and a next-step message on Fill shifts |
| Raw `2026-11-07` dates in Manager views | Readable dates |
| Status messages missing on Today, Worker Home and Owner Overview | Those pages now show them |
| Payment details only blocked at the final send | Raised on Today, Workers, Fill shifts and Worker Shifts |

## Remaining friction

- **Bryntum week view at 1024px:** bars are about 27px wide, so labels such as "6 open" clip. Day view and the shift details below show the full text.
- **"Create work opportunity" button under a "Create a shift" heading:** inconsistent wording, left because existing tests assert the button text.
- **Fill shifts defaults to 09:00–17:00:** the manager changes it by hand. It isn't derived from demand because the forecast is daily.
- **Password rule:** a 12-character minimum remains. It is an existing security setting and was not changed.
- **Mandatory email verification before plan selection:** kept, because the product specification requires it. It is a known drop-off risk with no bypass here.
- **Demo entry page and persona switching:** a first-time judge hasn't tried them. An unmoderated run would show more than this review can.
