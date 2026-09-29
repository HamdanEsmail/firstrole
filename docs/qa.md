# Verification record

Recorded on 29 September 2026. Local checks establish implementation behavior; hosted authentication and live provider integration remain separate release gates.

## Automated evidence

| Check                         | Observed result                                                             |
| ----------------------------- | --------------------------------------------------------------------------- |
| TypeScript                    | Passed                                                                      |
| Unit tests                    | 66 tests passed across five files                                           |
| PostgreSQL/PGlite             | Bootstrap, migration, acceptance, and limits/source-authority suites passed |
| Production build              | Passed; Vite 8.3.1, separated application/React/Supabase chunks             |
| Dependency audit              | 0 reported vulnerabilities, including development dependencies              |
| Cloudflare deployment dry run | Passed; API, static assets, SearchWorkflow, and AgentWorkflow bundled       |

Tests cover account storage and import conflicts, owner-bound delayed callbacks, retry keys, source evidence, strict filters, sponsorship negation, remote restrictions, deduplication, closure, unsafe URLs, bounded responses, uncertain Agent submissions, signed guest cookies, and origin checks. SQL tests exercise ownership policies under different test identities, private RPC permissions, atomic reservations/claims, concurrency limits, cancellation, cache reuse, account deletion, and server-authoritative refresh URLs.

Provider tests use mocked responses and spend no TinyFish credit. PGlite executes actual PostgreSQL rules on a single connection; it is not a deployed multi-connection load test.

## Microsoft Edge evidence

Browser control used Microsoft Edge only. Production-development URL: http://127.0.0.1:5173/. Isolated UI-test URL: http://127.0.0.1:5174/.

| Scenario                                     | Observed result                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page identity / nonblank / framework overlay | Correct FirstRole title and meaningful application UI; no framework error overlay                                                                                                                 |
| Desktop                                      | Checked at 1536 x 1024 against the approved concept                                                                                                                                               |
| Tablet                                       | Checked at 820 x 1180; usable two-column results and no page-wide horizontal overflow                                                                                                             |
| Mobile                                       | Checked at 390 x 844; full-width search fields, saved list, separate detail view, visible Apply action, and working Back action                                                                   |
| Guest saves                                  | Saved two fictional test jobs; count and records persisted after reload                                                                                                                           |
| Comparison                                   | Compared two jobs; location, salary, sponsorship, match reasons, and source destinations remained distinct                                                                                        |
| Application tracking                         | Changed a saved job to Applied, saved a note, reloaded, and read back both values                                                                                                                 |
| Dialog accessibility                         | Opening How it works focused the close control; Escape dismissed it and restored focus to the opener                                                                                              |
| Advanced filters                             | Expanded controls and inspected skills, posting-age, and explicit-sponsorship options                                                                                                             |
| Setup-required state                         | Real unconfigured API returned an actionable message; no provider call was made                                                                                                                   |
| Console                                      | No unexplained application errors during successful UI tests. Edge extension warnings were attributable to an installed extension. The deliberate unconfigured API test returns the expected 503. |

Browser date entry, a full keyboard traversal, reduced-motion emulation, and end-to-end offline/partial/quota UI simulations remain unverified. Their implementation or unit coverage must not be presented as completed browser checks.

All screenshots containing listings use fictional UI fixtures and are labelled as tests. They verify presentation and interactions, not job availability. The test middleware is excluded from production. Never use these as live bounty evidence.

## Design comparison

Reference: [approved concept](design/approved-concept.png). Screenshot evidence lives in [artifacts/screenshots](../artifacts/screenshots/).

The approved concept and the saved desktop render were inspected with the image viewer. Comparison covered:

- Heading, brand, navigation, search labels, and action copy.
- Desktop list/detail proportions, selected-row treatment, and spacing.
- Manrope headings, Source Sans 3 body/control typography, and legibility.
- White/cool-blue surfaces, royal-blue actions, green match evidence, and amber uncertainty.
- Outline icon weight, input/button geometry, and monogram treatment.
- Tablet and mobile transitions, visible application action, and absence of horizontal page overflow.

Corrections included desktop header/form spacing, larger result typography, full-width mobile inputs, left-aligned mobile branding, and singular source-count wording. Edge's Dark Reader extension initially replaced the approved palette; the app declares its light color scheme and preserves its intended colors without changing the user's global extension settings.

Intentional functional differences from the concept: optional Sign in, live data-dependent counts/text, deterministic company initials instead of fictional branded artwork, a storage/synchronization footer, requirements/source evidence sections, and longer detail content when necessary. No extra marketing headline, decorative hero badge, or fabricated statistic was added. The primary desktop heading, supporting sentence, navigation, search labels, and main action copy match the approved concept; account additions were explicitly requested.

## Hosted release gates

| Scenario                                                           | Status                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Public Cloudflare demo                                             | Pending: account email verification and deployment authorization              |
| Live Supabase migration                                            | Pending: user completes creation of the prepared free FirstRole project       |
| Google OAuth                                                       | Pending: provider credentials and exact redirect setup, then live sign-in     |
| Two-session synchronization / two-account isolation                | Pending deployed checks                                                       |
| Account deletion                                                   | Pending real authenticated check                                              |
| Real TinyFish Search, Fetch, and necessary Agent interaction       | Pending; no paid extraction run during implementation                         |
| Multiple employers / roles / at least two regions                  | Pending live acceptance search results                                        |
| Deployed cancellation, uncertain submissions, concurrent admission | Pending live/integration checks                                               |
| Free CPU and Workflow runtime limits                               | Pending deployed execution metrics                                            |
| Combined $10 allowance                                             | Controls implemented; reconcile any out-of-ledger setup costs before enabling |

The application keeps paid work disabled until configuration and rate verification are complete. Preserve uncertain reservations, inspect real source/application pages, and do not substitute test fixtures for these release gates.
