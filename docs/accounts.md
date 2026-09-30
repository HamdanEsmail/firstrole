# Accounts and saved workspaces

FirstRole works without an account. Google sign-in adds a private, synchronized workspace using Supabase Auth and PostgreSQL. The application does not ask for a password, mailbox access, Google Drive access, or a paid authentication subscription.

Account access uses the authenticated Supabase user identity. Browser queries are restricted by row ownership, and privileged orchestration stays in the Worker. The sections below cover setup, storage behavior, and checks for a configured deployment.

## What is stored

| Data                            | Guest                                                          | Signed in                                                         |
| ------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Saved job snapshots             | This browser's local storage                                   | `public.saved_jobs` under the authenticated user's ID             |
| Application status, notes, date | This browser's local storage                                   | The same account-owned saved-job row                              |
| Search preferences              | This browser's local storage                                   | `public.profiles` under the authenticated user's ID               |
| Search progress and results     | Server-side search records authorized by a signed guest cookie | Server-side search records authorized by a verified Supabase user |
| Sign-in session                 | None                                                           | Supabase's browser session persistence                            |

Guest data uses the versioned local-storage key `firstrole.workspace.v1`. Clearing browser storage removes it. Search ownership uses a separate server-issued, signed, HttpOnly cookie; JavaScript cannot choose another guest's identity. Guest saved jobs are local snapshots, so an old saved job can outlive its original server search. Rechecking such a listing can require searching again or importing it into an account.

Signed-in saves are read on sign-in and refreshed when the user returns to the tab. Writes complete against Supabase before the UI reports success. The application does not queue account changes for later offline delivery. A connection error leaves the existing saved state intact and displays an error.

## Configure the free project

Use Microsoft Edge for dashboard setup. Keep `GOOGLE_AUTH_ENABLED=false` until the provider and redirects are configured and a real sign-in has been checked.

1. Create a Supabase project on the free plan. Apply all numbered SQL files in `supabase/migrations` once in filename order. They create the account tables, ownership policies, search storage, spending controls, and private provider-rate proof cache.
2. Set the deployed FirstRole HTTPS origin as the Supabase Auth **Site URL**. Allow the exact redirect `${FIRSTROLE_ORIGIN}/`. For local development, also allow `http://127.0.0.1:5173/` if that is the origin being used. Keep production redirects specific to the deployed application.
3. Configure a Google OAuth web client for FirstRole. The Google redirect URI is the callback URI provided by the Supabase Google provider configuration, rather than the FirstRole homepage. Copy that callback exactly. Add the Google client ID and client secret to the Supabase provider configuration.
4. Complete the Google consent configuration. A consent application in testing mode must explicitly allow each pilot tester. Before inviting arbitrary public users, finish the provider's publishing requirements. Only basic identity scopes are needed: `openid`, `email`, and `profile`.
5. Set the Worker configuration below. Put confidential values in Worker secrets and the ignored local `.dev.vars` file when developing. Never put them in browser build variables, committed files, screenshots, or issue reports.
6. Verify sign-in and sign-out on the deployed origin. Enable `GOOGLE_AUTH_ENABLED=true` only after configuration is complete, then run the two-account checks below before declaring public account support ready.

| Configuration               | Location and purpose                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | Worker configuration; URL of the selected Supabase project. Published to the browser through `/api/config`.                         |
| `SUPABASE_PUBLISHABLE_KEY`  | Worker configuration; public browser key for the same project. Published through `/api/config`; ownership policies protect records. |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker secret only. Privileged orchestration and account deletion. Never exposed to the browser.                                    |
| `GUEST_COOKIE_SECRET`       | Worker secret only; a long random value used to sign guest identity cookies and pseudonyms.                                         |
| `APP_ORIGIN`                | The exact application origin, without a path; used for request-origin checks.                                                       |
| `GOOGLE_AUTH_ENABLED`       | `true` after setup; `false` keeps Google sign-in unavailable while guest saves remain usable.                                       |

The Google OAuth client secret belongs in Supabase's Google provider configuration. It is not a FirstRole frontend or Worker variable. TinyFish credentials are separate Worker secrets and are not involved in Google sign-in.

## Ownership and import behavior

The browser uses Supabase's Google OAuth flow with PKCE. The Worker validates bearer tokens with Supabase Auth before authorizing account searches or deletion. Browser database queries use the public key plus the current user session. Row-level policies require `user_id = auth.uid()` for every account read and write.

`saved_jobs` has a composite primary key of `user_id, job_id`. `profiles` has a primary key of `user_id`. Deleting the corresponding Supabase Auth user cascades to these account-owned records. Both tables have server-maintained update timestamps.

When an account is available, FirstRole offers to import guest saves. Import uses the job identity to merge records. Existing account records win, including their notes, dates, and application status. A successful database write is followed by a readback of the account. Guest copies are cleared only when every imported job can be read back. Changes made in another browser tab during the import are retained locally.

Account changes are serialized within the current page. Each callback is bound to the account and authentication generation that created it; a response arriving after sign-out cannot write into the next account. Account rows are removed from the rendered workspace when the identity changes. Guest jobs remain separate until explicitly imported.

Notes are limited to 10,000 characters in storage. Guest workspaces are limited to 500 saved jobs. Malformed or unsupported local-storage data is preserved rather than silently replaced; export includes the original value as recovery data. If storage is disabled or full, the save fails visibly.

## Export and deletion

Export produces a JSON file containing preferences, saved job snapshots, application notes, status, and dates. It does not contain authentication tokens or service credentials. Use the account export before deletion if a copy is needed.

Account deletion calls `POST /api/account/delete` with the current bearer token. The UI asks the user to type `DELETE`, and only a confirmed successful response completes the deletion flow. The user is then signed out of this browser. Deleting a FirstRole account does not delete the Google account. Guest copies that were never imported remain separate browser data.

## Verification before release

Use real listings already retrieved by the application, or explicitly isolated test fixtures. Never load synthetic jobs into the public demo as live results.

| Check                     | Expected result                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest reload              | A saved job, note, chosen status, date, and preferences survive reload on the same origin.                                                              |
| Storage unavailable       | A blocked or full local-storage write reports failure; no success notification appears.                                                                 |
| Google redirect           | Sign-in returns to the intended origin with the actual user's identity. A cancelled sign-in returns to usable guest access.                             |
| Second session            | A second authenticated session sees the saved job and notes; returning to the original tab reads the latest account state.                              |
| Guest import              | New jobs import once. A duplicate account job retains its existing notes, date, and status. Local copies disappear only after readback.                 |
| Import interruption       | A failed write, failed readback, or sign-out leaves guest copies available.                                                                             |
| Two-account isolation     | Account B cannot select, insert, modify, or delete rows owned by A using B's public-key session. Test both tables through the actual deployed database. |
| In-flight identity change | Start a refresh or save, then sign out. Old responses do not reveal A's private state or save into the guest workspace or B's account.                  |
| Application drafts        | Switching accounts never retains the previous account's note draft, even when both accounts saved the same job.                                         |
| Private routes            | Account deletion without a valid session fails. Search IDs owned by another actor cannot be read or cancelled.                                          |
| Deletion                  | The confirmed deletion removes the Auth user and account rows, signs out, and prevents the former session reading personal records.                     |

The local account tests cover storage corruption, unsafe saved links, quota failures, account-winning imports, concurrent-tab import preservation, explicit database ownership conversion, authentication headers, error messages, and idempotency after a lost response. They do not prove deployed OAuth or database policy behavior.
