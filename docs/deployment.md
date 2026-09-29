# FirstRole deployment and pilot operations

FirstRole uses a React/Vite frontend, Cloudflare Workers Static Assets, two durable Cloudflare Workflows, and one Supabase PostgreSQL database. Hosting targets the free plans. TinyFish usage consumes the owner's existing balance and is limited by an independent **$10 lifetime pilot ledger**, shared by development checks and public searches. No automatic top-up or paid upgrade is part of this setup.

## Account setup

Use Microsoft Edge for account setup and all browser verification. Create or select the owner's Cloudflare account and one Supabase free project. Authenticate Wrangler through its browser OAuth flow. Do not create a paid subscription or buy a domain. The default `workers.dev` hostname is sufficient.

Apply the files in `supabase/migrations/` in order, once each. If the first migration is already applied, run only the later additive migration(s), including `202609290002_provider_rate_attestations.sql`. Read `supabase/README.md` for the RPC and security contract. The database budget switch starts disabled. Do not enable it before all secrets, limits and account rates have been checked.

For optional account sync, configure the Google provider in Supabase Authentication with a Google OAuth web client. Add the callback URL supplied by Supabase to the Google client. In Supabase's URL settings, configure the actual deployed site URL and only the exact local/deployed redirect URLs used by the app. Enable `GOOGLE_AUTH_ENABLED` only after a real sign-in and sign-out check succeeds. Guest search and browser-local saves remain available without Google sign-in.

## Configuration

Copy `.dev.vars.example` to the ignored `.dev.vars` for local development. Fill values locally, never in a chat transcript or tracked file. Generate a random guest-cookie secret of at least 32 bytes. Keep the TinyFish key, Supabase service role key and guest-cookie secret only in Worker secrets. The Supabase project URL and publishable key are deliberately public; the service role key is never sent to the browser.

Set `APP_ORIGIN` to the exact deployed origin. The checked-in Wrangler configuration describes the running pilot, where `TINYFISH_ENABLED` is `true`. Set it to `false` while configuring a new deployment; the local example already starts disabled. Before new paid work, the server verifies the exact TinyFish Agent/step, Search/query, and Fetch/url USD meters through the documented wallet metadata GET. A private proof is cached for six hours and refreshed automatically when needed. Missing, stale, malformed, or higher rates fail closed; the ceilings remain $0.016/Agent step, $0.005/Search query, and $0.001/Fetch URL. A changed API key cannot reuse another key's proof.

Daily operator edits or redeployments are unnecessary. `TINYFISH_RATES_VERIFIED_AT` and `TINYFISH_RATES_KEY_SHA256` are an optional initial manual fallback, valid for at most 24 hours only when the timestamp is not in the future, the hash matches the current key, and no stored observation exists. Leave those fields unset to use runtime wallet verification from the first search. The public search entry remains available to trigger verification after an old manual timestamp expires; actual paid dispatch still requires a valid proof. Cached results do not require a new proof.

The metadata check never changes the lifetime $10 budget, enables the budget switch, clears reservations, buys credits, or configures automatic top-ups. Workflow steps persist only rate values and timestamps, and each Workflow reads one proof; they do not perform repeated wallet calls for each provider operation.

Production secrets are uploaded with `wrangler secret put <NAME>` through secure input. Do not pass keys in a command line or print secret values. Publishable configuration may be managed through Worker variables. Do not place any privileged secret in a `VITE_` variable.

## Local checks and deployment

1. Install dependencies from the lockfile and run `npm test`, `npm run typecheck`, and `npm run build`.
2. Run `npm run dev:api` to serve the built app and Worker locally. `npm run dev` serves the Vite interface and forwards API requests through its configured local proxy.
3. Run `npx wrangler deploy --dry-run --outdir .wrangler/dry-run` to validate the Worker bundle and bindings without publishing.
4. Deploy using `npm run deploy` after account setup is complete. Configure secrets and both workflow bindings, then enable the database pilot switch after the budget baseline is recorded.
5. Perform one bounded real search in Edge. Check source links, posting evidence, cancellation and browser refresh recovery. Count this check against the same $10 ledger. Never replace missing live data with fabricated jobs.

`SearchWorkflow` owns discovery and up to four source reads. `AgentWorkflow` handles one incomplete or interactive portal plus up to four detail verifications. A stable Workflow instance ID and database operation guard protect against duplicate requests. Splitting the stages avoids exceeding the free plan's external-subrequest allowance, including Supabase REST requests. Keep each response bounded; the free plan has a strict 10 ms CPU constraint, so inspect deployed CPU metrics before widening limits. Local emulation and a successful bundle do not establish deployed CPU headroom.

## Budget, retry and recovery

Every outbound provider request reserves budget atomically before dispatch. Search reserves $0.005 per attempt, Fetch reserves $0.001 per URL, and Agent reserves $2.50 per run based on the documented default ceiling of 150 steps at the verified account rate. The sum of spent and reserved amounts cannot exceed $10. These reservations intentionally limit the pilot to at most three Agent submissions unless authoritative reconciliation releases unused budget.

Agent creation has zero automatic retries. The database claim is committed before the provider POST. If a response is lost, the operation remains uncertain and retains its reservation and active slot; there is no blind resubmission. A known terminal provider status frees the concurrency slot while retaining the financial reservation. `num_of_steps` is usage evidence, not an authoritative charge receipt. Do not release budget from a step-count estimate or from elapsed time alone.

The only automatic alternative submission is a confirmed pre-execution `output_schema` entitlement rejection: the operation is reconciled as not started, and a new separately guarded request asks for the same JSON shape through the goal. Generic 403s and timeouts do not trigger this fallback.

If an operation is uncertain, inspect its stored operation ID and known provider run ID using the same TinyFish API-key scope. Reconcile only after establishing the actual run and terminal state. If the run ID was lost, find the unique operation reference in TinyFish's run history. Never reset the ledger or create a replacement operation merely to unblock a search. Disable the database budget switch to pause new claims immediately; retain audit records. Account deletion removes personal data while preserving detached usage records needed for the pilot budget.

Guests receive three searches/day; signed-in users receive ten. The network allowance is twenty/day. Browser-assisted checks are limited to one per actor/day, three per network/day, four globally/day, and two active globally. When the assisted allowance is unavailable, the app can still check directly readable listings within its ordinary allowance. Fresh cache hits do not debit search quotas or provider budget. Shared cache entries last six hours and preserve each listing's original check time.

## Acceptance checks before sharing

- Verify Google sign-in, sign-out, guest import and cross-device sync using two accounts; one account must never read or modify another's saved jobs or search history.
- Close Edge during an active search and reopen the same search. It must recover from Supabase and the running Workflow without another paid POST.
- Simulate a lost provider submission response, denied budget, expired rate timestamp, source timeout, unavailable page and unsupported schema. Confirm clear partial results and retained uncertain reservations.
- A failed refresh preserves the previous listing details but marks availability unverified. Only explicit closure or a missing listing page marks it closed.
- Inspect deployed Worker CPU and workflow step/subrequest usage at the permitted response limits. Keep the free tier enabled; if a limit is hit, reduce work instead of silently upgrading.
- Review actual source URLs in the final demo and document how Search discovers, Fetch reads/verifies and Agent operates an incomplete career portal.

Known operational limits: expiry pauses new live work until the owner re-verifies rates; external career sites can block automation; unknown submission outcomes require manual reconciliation; Supabase/Cloudflare free quotas can stop service until reset. Cached and browser-local records must remain clearly distinguishable from a newly checked opening.
