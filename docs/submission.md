# FirstRole bounty submission package

The public demo and account flows are working. Live searches returned open US roles from multiple employers and a UAE Egis listing whose availability is clearly marked **Could not verify**. The outstanding endpoint acceptance check is a successful, useful TinyFish Agent interaction: two real attempts reached terminal states without usable jobs. This package remains unpublished, and the bounty has not been submitted.

| Item              | Value                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Bounty            | Job Portal / Careers Finder (`d001-jobs`)                                                        |
| Bounty page       | https://www.tinybounties.com/crm?view=board&bounty=d001-jobs                                     |
| Product           | FirstRole                                                                                        |
| Public demo       | [Open FirstRole](https://firstrole.hamdanesmail12-7a9.workers.dev)                               |
| Source repository | [HamdanEsmail/firstrole](https://github.com/HamdanEsmail/firstrole)                              |
| Verified release  | `83c01bee-7526-4117-a991-1bfed1eaf6f4`                                                           |
| Walkthrough       | `WALKTHROUGH_URL` — recording pending                                                            |
| Closing date      | Unknown: the board, claim, and submission form do not expose the actual go-live or closing date. |

The rulebook specifies an 18-day window from go-live and a first-Monday monthly release schedule. The inspected surfaces did not reveal this bounty's actual go-live/closing date; the 29 September claim is not enough to calculate it. The form confirms a **2,000-character reviewer field**, **up to five media files at 25 MB each**, a required LinkedIn post mentioning the [TinyFish company page](https://www.linkedin.com/company/tinyfish-ai/), and a required Discord **#showcase** post. No posts or submission have been published by this workflow.

## Requirement-to-evidence checklist

| Requirement                       | Verified evidence                                                                                                                                                                            | Remaining work or limitation                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Working demo                      | Public HTTPS application, API Worker, durable Workflows, guest workspace, and Google account integration. All 13 deployed read-only checks passed.                                           | Finish the walkthrough and recheck access before judging.                                                                                                          |
| User preferences                  | Role, location, opportunity type, workplace, keywords, sponsorship, and posting age. US and UAE inputs and different role categories were exercised.                                         | Earlier UAE engineering and Finance/Dubai searches honestly returned zero qualifying matches.                                                                      |
| Multiple companies or portals     | Earlier Intel result and corrected fresh US results for Katalyst and Medtronic. Final UAE result: Egis Graduate Mechanical Engineer – MEP in Dubai.                                          | Egis availability is unverified, and the UAE search is partial because one source was blocked.                                                                     |
| Structured, deduplicated listings | Observed source/apply links, requirements, evidence, dates, match reasons, and actual checked times. Corrected Medtronic employer is preserved in the fresh shared cache.                    | Keep each result's actual availability and restrictions visible. Egis requires UAE Nationals with Family Book Only.                                                |
| Meaningful TinyFish use           | Search and Fetch have useful live result evidence. Agent filters/navigation workflow is implemented.                                                                                         | Two real Agent attempts produced no usable jobs. Demonstrate one useful interaction after the normal daily allowance permits it; do not reset or bypass the quota. |
| Matching and freshness            | Relevant US roles with source-grounded reasons; UAE restrictions and unknown availability shown honestly. Identical searches reused cached results without changing original check times.    | Continue treating extraction, freshness, and current availability as separate claims.                                                                              |
| Optional accounts                 | Google sign-in/reload/second-tab saves; guest persistence; sign-out isolation; duplicate guest import; 41 real RLS checks; actual Worker deletion including cascade and old-token rejection. | A second physical device is not claimed as tested.                                                                                                                 |
| Pilot cost controls               | Final guard: enabled, $10 limit, $0.135 spent, $5 retained for two Agent attempts. Deployed guest-cookie handshakes produced no ledger change.                                               | Authoritative Agent charge reconciliation, simultaneous deployed admission checks, and measured CPU headroom remain open.                                          |

The complete check passed **144 unit tests across ten files**, TypeScript, all three migrations and PostgreSQL suites, and the production build. [QA](qa.md) separates automated coverage, actual browser/deployed observations, earlier unsuccessful searches, and outstanding checks. Completed Workflows do not establish useful Agent results or CPU headroom.

## Reviewer notes

Copy only the following block into the reviewer-notes field. It is below 2,000 characters. Update the Agent limitation only after a useful interaction has actually been demonstrated.

```text
FirstRole helps students find internships and first jobs, understand requirements, and track applications.

Demo: https://firstrole.hamdanesmail12-7a9.workers.dev
Source: https://github.com/HamdanEsmail/firstrole

Set role, location, opportunity type, workplace, keywords, and optional sponsorship/date filters. Results retain source/apply links, match reasons, requirements, and actual check times. Save jobs, compare up to three, and track status, notes, and dates.

TinyFish Search discovers careers sources; Fetch reads and checks listings. The Agent path handles portal filters/navigation, but useful Agent acceptance remains open: two terminal attempts produced no usable jobs. Daily allowances have not been reset or bypassed.

Live evidence: Intel, plus a fresh US search with open Katalyst Recent Graduate – Software Engineer I and Medtronic Software Engineering Intern – Summer 2027 roles. The final UAE search returned Egis Graduate Mechanical Engineer – MEP in Dubai, preserving UAE Nationals with Family Book Only. Egis is clearly marked Could not verify; that search is partial because a source was blocked.

Google sign-in, reload/second-tab saves, sign-out isolation, local guest persistence, and duplicate guest import passed. An identical guest search reused cached results despite the daily live-search limit, preserving original check times and making no new provider calls. 41 real Supabase ownership checks and actual Worker account deletion passed. The full check passed 144 unit tests, database suites, TypeScript, and build.

The pilot uses Cloudflare/Supabase free plans and a $10 combined testing/pilot cap. Final guard snapshot: $0.135 spent and $5 retained for the two Agent attempts. Uncertain costs are not refunded automatically. The deployed cookie handshake also passed without ledger changes. Remaining evidence and limits are in docs/qa.md.
```

## Short demonstration walkthrough

Aim for a clear two-to-three-minute recording. Keep credentials, account settings, personal notes, and billing details out of view.

1. Open FirstRole in Edge and show the actual software-engineering search in the United States. Open the corrected Katalyst and Medtronic results, their match reasons, source/application links, and check times.
2. Show **Sources checked** and explain that source coverage can be incomplete. Open the UAE Egis result and keep **Could not verify**, the partial-search notice, and UAE National/Family Book requirement visible.
3. Save useful opportunities and compare them. Demonstrate application status/notes with nonpersonal example text.
4. Show guest persistence after reload, then Google sign-in and the duplicate-import behavior: the prompt clears while existing account records, notes, and status are preserved.
5. Repeat an identical search to show its **Previous search** state and original check times. Explain the shared pilot allowance.
6. Add the useful Agent segment only after a successful, necessary portal interaction. Until then, state that limitation rather than substituting a fixture or an unsuccessful attempt.

Six real production screenshots are available:

| View                                               | Artifact                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Corrected US search with Katalyst and Medtronic    | [Live US search](../artifacts/screenshots/live-search-us-desktop.png)  |
| UAE Egis search, explicitly unverified and partial | [Live UAE search](../artifacts/screenshots/live-search-uae.png)        |
| Saved Intel, desktop 1536 × 1024                   | [Live saved desktop](../artifacts/screenshots/live-saved-desktop.png)  |
| Saved Intel, tablet 820 × 1180                     | [Live saved tablet](../artifacts/screenshots/live-saved-tablet.png)    |
| Saved Intel, mobile shortlist 390 × 844            | [Live mobile list](../artifacts/screenshots/live-saved-mobile.png)     |
| Saved Intel, mobile details 390 × 844              | [Live mobile details](../artifacts/screenshots/live-detail-mobile.png) |

These show real live-result/account flows without an email address. Keep them distinct from labelled fictional UI-test screenshots. Select at most four screenshots if the walkthrough will be the fifth uploaded file; each file must remain at or below 25 MB. Preserve the UAE screenshot's **Could not verify** badge, availability notice, partial-source warning, and nationality restriction.

## LinkedIn draft

Resolve `@TinyFish` to the verified [company page](https://www.linkedin.com/company/tinyfish-ai/) before publishing. This draft deliberately preserves the remaining Agent limitation.

```text
I’m building FirstRole for the TinyFish student bounty: a place to find internships and first jobs, understand the requirements, and keep a useful shortlist.

The public app now returns live opportunities with source links and check times. My latest US search found roles at Katalyst and Medtronic. A UAE result from Egis keeps its nationality requirement visible and is clearly marked “Could not verify” where availability could not be confirmed.

@TinyFish Search and Fetch handle discovery and reading. I’ve also built the Agent integration for interactive careers portals; a successful useful interaction is the remaining endpoint check after two attempts returned no usable jobs.

Google sign-in, saved-job persistence, guest import, account isolation, and account deletion have passed live checks. The complete local check passes 144 tests, database suites, TypeScript, and build.

Demo: https://firstrole.hamdanesmail12-7a9.workers.dev
Code: https://github.com/HamdanEsmail/firstrole

#TinyFish #StudentProjects #Internships
```

## Discord #showcase draft

```text
FirstRole — job search and application tracking for students

Choose a role and location, review source-linked opportunities with match reasons and checked times, then save, compare, and track applications.

Live US results include Intel, Katalyst, and Medtronic. The latest UAE search returned an Egis graduate role with its UAE National/Family Book requirement preserved; availability is explicitly unverified and the search is partial.

TinyFish Search and Fetch have useful live evidence. The Agent integration is implemented, but two terminal attempts returned no usable jobs; a successful useful interaction remains to be demonstrated under the normal daily allowance.

Verified: Google sign-in/persistence, guest saves and duplicate import, cached searches without new provider work, 41 real ownership checks, and deletion through the deployed Worker. Full check: 144 unit tests plus database, TypeScript, and build.

Demo: https://firstrole.hamdanesmail12-7a9.workers.dev
Repository: https://github.com/HamdanEsmail/firstrole
Walkthrough: WALKTHROUGH_URL
```

## Final submission checks

- [x] Inspect the bounty, rulebook, claim, and submission form in Edge.
- [ ] Obtain the actual closing date; the inspected surfaces did not expose it.
- [x] Add the actual public demo and repository URLs.
- [x] Verify corrected live US results from multiple employers and record the UAE result's restrictions and unverified availability.
- [x] Verify Google sign-in/persistence, guest save/import, cached-search reuse, and sign-out isolation.
- [x] Verify real Supabase ownership rules, the Worker deletion route, and the no-spend first-guest handshake.
- [x] Capture real US/UAE, desktop, tablet, and mobile production screenshots without an email address.
- [ ] Demonstrate one successful, useful Agent interaction when normally eligible; no quota reset or bypass.
- [ ] Complete simultaneous deployed admission checks and CPU headroom measurement.
- [ ] Retain the $5 Agent holds until authoritative charge evidence supports reconciliation; keep all setup/test/pilot work within the same $10 cap.
- [ ] Finish the recording, replace `WALKTHROUGH_URL`, and select up to five media files at 25 MB each.
- [ ] Recount reviewer notes after edits and keep them at or below 2,000 characters.
- [ ] Publish approved LinkedIn and Discord #showcase drafts manually, using the verified TinyFish mention, then add the actual post links.
- [ ] Review and submit the bounty manually. No publishing or submission has occurred in this workflow.
