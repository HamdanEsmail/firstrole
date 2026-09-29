# FirstRole bounty submission package

This package is a draft. The local application is implemented; public deployment, Google sign-in, and the complete live demonstration must be verified before submission. Replace every placeholder and update the status statements to match recorded evidence. Do not publish the social drafts or submit the bounty automatically.

| Item              | Value                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Bounty            | Job Portal / Careers Finder (`d001-jobs`)                                                   |
| Bounty page       | https://www.tinybounties.com/crm?view=board&bounty=d001-jobs                                |
| Product           | FirstRole                                                                                   |
| Public demo       | `LIVE_DEMO_URL` — pending                                                                   |
| Source repository | [HamdanEsmail/firstrole](https://github.com/HamdanEsmail/firstrole)                         |
| Walkthrough       | `WALKTHROUGH_URL` — pending                                                                 |
| Closing date      | Verify on the live bounty/rulebook before submission; do not calculate from the claim date. |

## Requirement-to-evidence checklist

| Requirement                       | Implemented behavior                                                                                   | Evidence still needed                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Working demo                      | React interface, API Worker, durable Workflows, guest workspace, account integration.                  | Public HTTPS URL and an actual successful end-to-end search.                                                 |
| User preferences                  | Role, location, job types, workplace, keywords, sponsorship, and posting age.                          | Two roles across at least two regions with visibly different inputs/results.                                 |
| Multiple companies or portals     | Live discovery prioritizes different source hosts.                                                     | Real results from at least two employers or portals in the demonstration.                                    |
| Structured, deduplicated listings | Normalized jobs, source/apply links, identity-based deduplication, evidence, dates, and match reasons. | Inspect representative live jobs against their original pages.                                               |
| Meaningful TinyFish use           | Search discovers; Fetch reads/verifies; Agent interacts with a careers portal.                         | One successful Agent run that performs needed filters/navigation, plus successful Search and Fetch evidence. |
| Helpful matching                  | Requirements are filtered, results ranked, and uncertain fields kept explicit.                         | Show why one result fits and why another is limited or excluded.                                             |
| Optional accounts                 | Google PKCE, account-owned saves, guest import, notes/status, export/deletion.                         | Real Google sign-in, cross-session readback, two-account isolation, and deletion checks.                     |
| Responsible pilot costs           | $10 combined allowance, atomic reservations, no uncertain Agent resubmission.                          | Reconcile any external setup calls; verify deployed concurrent admission and current provider bounds.        |

Local automated coverage is documented in [QA](qa.md). It is evidence about implementation behavior; it does not substitute for a real public demo or live provider checks.

## Reviewer notes

Copy only the following block into the reviewer-notes field. It is below the 2,000-character limit. Replace links and the final status sentence after live verification; do not claim tests that have not been performed.

```text
FirstRole helps students find internships, graduate programmes, and entry-level jobs, understand the fit, and keep track of applications.

Demo: LIVE_DEMO_URL
Source: https://github.com/HamdanEsmail/firstrole

Users choose a role, location, opportunity type, work arrangement, and keywords, with optional sponsorship and posting-age filters. Results include observed source/application links, requirements, match reasons, and check times. Missing salary, sponsorship, dates, and remote restrictions remain explicit. Saved jobs can be compared, annotated, and tracked through application stages.

TinyFish Search discovers relevant careers pages across companies. Fetch reads direct listings and checks selected job pages. Agent uses careers-site filters/navigation when interaction is needed and returns structured, evidenced openings. These are distinct discovery, reading, and interaction tasks; endpoint count is not the goal.

Guests save locally. The Google/Supabase account integration adds synchronization and an import that preserves existing account notes/status. Search progress persists independently of the browser. Recent results may be reused for six hours with their original check times.

The pilot uses Cloudflare/Supabase free plans and a $10 combined testing/pilot allowance. Atomic reservations, unique dispatch claims, and retained uncertain costs prevent automatic duplicate Agent submissions.

Current handoff status: local implementation and automated tests are complete; public deployment, live Google sign-in, and the full live multi-source demonstration still need verification. See the repository QA record for the exact evidence.
```

## Short demonstration walkthrough

Aim for a clear two-to-three-minute recording after the live acceptance checks pass. Keep credentials, account settings, personal notes, and billing details out of the recording.

1. Open the public FirstRole page in Edge. Enter a student-relevant role and location, then show the search's source progress.
2. Open two results from different employers or portals. Point out the source, application link, freshness, and a concrete match reason. Show an unknown field honestly.
3. Explain the useful TinyFish interaction with the tested dynamic careers portal. Record the actual result and source; do not substitute test fixtures.
4. Save two opportunities and compare them. Move one application to Applied and enter a nonpersonal demonstration note/date.
5. Show guest persistence after reload. If Google sign-in has passed live checks, sign in and show the import/synchronization flow; otherwise disclose that it remains unavailable.
6. Show a second search for a different role/region, using a recent verified run if another live execution would exceed the remaining allowance. Keep its actual check time visible.

Capture a desktop screenshot at **1536 px wide**, a tablet screenshot, and a mobile screenshot after visual QA. Record the actual dimensions and whether each image shows live results or the labeled local fixture mode. Only live-result evidence belongs in the final bounty demonstration.

## LinkedIn draft

Resolve the `@TinyFish` mention to the actual TinyFish company/profile in LinkedIn before publishing. The text below describes the current handoff honestly; replace the pending sentence only after completing those checks.

```text
I’m building FirstRole for the TinyFish student bounty: a place to find internships and first jobs, understand the requirements, and keep a useful shortlist.

I wanted each result to answer the practical questions: Where is it? What experience does it need? Does “remote” have a location restriction? When was the source checked? If a listing doesn’t say, FirstRole doesn’t guess.

@TinyFish powers three parts of the search: discovering careers pages, reading job details, and interacting with portals that need filters or navigation. The workspace adds saved jobs, comparisons, application notes, and optional Google accounts.

The local build and automated checks are complete. Public deployment, live sign-in, and the full live demonstration are the next verification steps.

Demo: LIVE_DEMO_URL
Code: https://github.com/HamdanEsmail/firstrole

#TinyFish #StudentProjects #Internships
```

## Discord showcase draft

```text
FirstRole — job search and application tracking for students

Built for the Job Portal / Careers Finder bounty. Choose a role and location, review structured openings with source/apply links and match reasons, then save, compare, and track applications.

TinyFish Search discovers relevant careers sites; Fetch reads and checks listings; Agent handles careers filters/navigation. Unknown information stays unknown, and every result keeps its check time.

Guest saves work locally. The Google/Supabase account integration supports synchronization, guest import, personal notes, export, and deletion.

Status: local implementation and automated checks complete; public deployment, live sign-in, and the full live demonstration remain to be verified.

Demo: LIVE_DEMO_URL
Repository: https://github.com/HamdanEsmail/firstrole
Walkthrough: WALKTHROUGH_URL
```

## Final submission checks

- [ ] Confirm the actual bounty closing date and current rulebook requirements.
- [ ] Replace `LIVE_DEMO_URL` and `WALKTHROUGH_URL` with working public destinations; verify the repository link.
- [ ] Complete and record the live checks above; update every pending status statement accordingly.
- [ ] Open the public demo from a clean Edge session and verify the expected free-plan configuration.
- [ ] Confirm Google test-mode restrictions will not prevent reviewers from using the advertised sign-in feature.
- [ ] Reconcile all setup/test/pilot TinyFish costs within the combined $10 allowance.
- [ ] Capture real desktop/mobile evidence and preserve readable source/check-time details.
- [ ] Recount reviewer notes after edits; keep them at or below 2,000 characters.
- [ ] Publish the approved LinkedIn and Discord posts manually, with the correct TinyFish mention and channel, then add their actual links if the form requires them.
- [ ] Submit the bounty manually after reviewing the final package.
