# Review plan (October 2026)

Findings from a four-pass code review ahead of the TinyFish student bounty submission. Each item was traced or reproduced against the code unless marked PLAUSIBLE. Priorities: P0 blocks a good review, P1 is a confirmed stability or correctness bug, P2 is presentation and cleanup.

Decisions already taken:

- Make the README reviewer-first: bash commands, any browser, a quick-start at the top.
- Work lands on `claude/review-hardening` and is reviewed through one pull request.
- The stale-run sweeper needs one new SQL migration, applied to Supabase by the owner after merge.

## Done on this branch

- Node 24 pinned (`.nvmrc`, `engines`, README). Node 22 ships npm 10, which does not apply the `undici` override and fails `npm ci`; CI already used Node 24.
- `server/index.ts` logs method, path, and error type for unexpected failures before the generic 503.
- Opt-in `deploy` job runs `wrangler deploy` once `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets exist.

## P0

### 1. Agent slot and $2.50 reservation leak after one transient error (effort S–M)

`server/agent-wait.ts`: `check-agent-cancel-${i}` calls `io.cancellationRequested()` and `requestedStop` calls `io.cancel()` with no try/catch, unlike `poll-agent-${i}`. `cancellationRequested` goes through `db.internal()`, which throws `STORAGE_UNAVAILABLE` on any Supabase 5xx or 12 s timeout. One such blip rejects `waitForAgent`; `AgentWorkflow`'s catch records a source error and finalizes without calling `cancelRun` or `db.settle`. `record-terminal-portal` is also `NO_RETRY`, so a blip after a COMPLETED run throws the paid result away.

The operation stays `claimed` with `terminal_verified=false`, which counts toward `global_agent_concurrency` (limit 2), `source_agent_concurrency`, and `global_agent_daily_limit` in `supabase/migrations/202609290001_firstrole.sql`. No sweeper exists. Two leaks disable the Agent for everyone; four hold the entire $10 budget. Reproduced with a fake `io`.

Plan:

- Catch errors from `cancellationRequested()` (treat as not cancelled) and from `cancel()` (return a waiting observation).
- In `AgentWorkflow`, once a ticket exists, any later exception runs a `stop-agent-after-error` step: `cancelRun`, then `getRun`, then `db.settle(..., observedStatus, isTerminal)`. Settling with a terminal status frees the slot while the money stays held until reconciled.
- Give `record-terminal-portal` retries (`{ limit: 3, delay: '5 seconds' }`); `settle_provider_operation` is idempotent.
- Add a `list_unreconciled_operations` view and a runbook entry in `supabase/README.md`.
- Tests: a throwing `cancellationRequested` case in `tests/server-agent-wait.test.ts`; see item 8 for the Workflow test.

### 2. Searches can stay non-terminal for 48 hours (effort M)

Paths that leave a run stuck until `expires_at`:

- Admitted but no Workflow: `POST /api/searches` admits, then `createBatch` fails or the client's 30 s abort cancels the Worker mid-request. The run stays `queued` and the guest's daily quota is spent.
- `load-search` gives up after one retry (`server/workflows.ts`), leaving `queued`.
- `finalize-or-handoff-once` throws `STORAGE_UNAVAILABLE` after two failures; `tests/server-finalization.test.ts` asserts this as intended.
- `AgentWorkflow` `if (!url) return;` after `extracting` was saved (PLAUSIBLE reachability).
- `EnrichmentWorkflow` `check-cancellation` and `finish-detail-check` use `ONCE` (zero retries), leaving `reading`.
- `verify-source-rates`, `show-discovery`, `show-reading`, `show-portal-extraction` are DB-only and `NO_RETRY`.

Plan:

- Retries on idempotent DB-only steps: `{ limit: 5, delay: '5 seconds', backoff: 'exponential' }`. `update_search_run` is monotonic and never moves a terminal run backwards; `createBatch` is idempotent by ID. Keep `NO_RETRY` on paid steps.
- New migration `202610xx0010_fail_stalled_search_runs.sql`: RPC that marks non-terminal runs with `updated_at` older than 15 minutes as `failed` and calls `release_unused_agent_allowance`. Run it from a Cron Trigger (`scheduled()` handler plus `triggers.crons` in `wrangler.jsonc`). The Agent wait is silent for up to 9 minutes, so either add a heartbeat `db.update` in the poll step or keep the threshold at 15 minutes or more.
- On `GET /api/searches/:id`, when a run is `queued` and older than 30 s, call `createBatch` again.
- Tests: `tests/database-stale-runs.sql` (stale runs fail, recent and terminal untouched, assistance released); item 8 covers the retry behaviour.

### 3. A reviewer's own deployment gets 403 on every POST (effort S)

`server/auth.ts` `checkOrigin` compares against `env.APP_ORIGIN`, and `wrangler.jsonc` ships `APP_ORIGIN` set to the owner's Worker URL. Anyone deploying to another account gets `firstrole.<other>.workers.dev`, so `ORIGIN_REJECTED` on search, cancel, refresh, and delete.

Plan: also accept the request's own origin (`origin !== expected && origin !== new URL(request.url).origin`); the `sec-fetch-site` check already covers cross-site. Add a test in `tests/server-auth.test.ts` with `APP_ORIGIN` set to a different host than the request.

## P1

### 4. Client polling never stops or backs off (effort S–M)

`src/App.tsx` polls every 4 s (15 s hidden), always reschedules in `finally` including on 404/401/403, has no maximum duration, and restore-on-reload gives up on 5xx with no retry.

Plan: move the loop into `src/lib/search-poller.ts`; stop on 4xx and clear `firstrole.search.${owner}`; back off exponentially on status 0 or 5xx up to 60 s; show "This search appears stalled" with a Stop button after 15 minutes without `updatedAt` change. Test: `tests/client-search-poller.test.ts` with fake timers.

### 5. One failed `/api/config` call bricks the workspace (effort S)

`App.tsx` loads config once; `workspaceReady` stays false forever, `toggleSave` returns silently, and the copy still says the workspace is available.

Plan: retry three times with backoff, a Retry button, and a guest-only fallback config (`searchEnabled: false`) so local saves keep working.

### 6. Corrupted or outdated guest storage blocks all saves permanently (effort S–M)

`src/lib/storage.ts` `readGuestWorkspace` rejects the whole workspace if one item fails validation; `persistGuest` then throws on every write; only Export carries recovery data.

Plan: validate items individually, move invalid ones to `firstrole.workspace.quarantine.v1`, add "Reset local data (after export)".

### 7. Malformed request bodies return 502 "source" errors (effort S)

`server/http.ts` `requestJson` reuses `boundedJson`, so a client typo yields `502 INVALID_RESPONSE "The source returned an unreadable response."`. `src/lib/api.ts` only clears the pending idempotency key on 4xx, so the client replays the bad request. Reproduced.

Plan: catch `AppError` from `boundedJson` in `requestJson` and rethrow as `INVALID_REQUEST` 400 (413 for too large). Test `requestJson` statuses in `tests/server-quality.test.ts`.

### 8. The three Workflow classes are never executed by any test (effort M)

Every test importing `server/index.ts` stubs the Workflow modules. Add `tests/workflow-orchestration.test.ts`: mock `cloudflare:workers` `WorkflowEntrypoint`, a fake `step` whose `do` memoizes by name and fails on duplicates with `sleep` as a no-op, an in-memory `Database`, and a mocked `TinyFish`. Assert: happy path ends `completed`/`partial`; all Fetch failures end `failed`; an Agent error after the ticket calls `cancelRun` and `settle`; replaying `run()` makes zero extra provider calls; an invalid `sourceUrl` still finalizes; a DB blip during finalize ends terminal after retries.

### 9. Uncertain Agent starts permanently consume a global slot (effort S)

`server/tinyfish.ts` settles every start failure except the two entitlement 403s as `unknown`, which becomes `needs_reconciliation` and counts toward concurrency. A 429 or 401 with no `run_id` twice, for example an out-of-credits key while a reviewer tries the demo, means "Both browser agents are busy" for everyone afterwards.

Plan: treat 401, 429, and 4xx responses with no `run_id` as `rejectBeforeStart`, like the entitlement cases. Keep connection errors as uncertain.

### 10. Quadratic regex in `plainText` (effort S, PLAUSIBLE)

`server/content.ts` `/\[([^\]]+)\]\([^)]*\)/g` backtracks per unclosed `[`. Measured 1.6 s per call on 60 KB of `[`, and `plainText` runs 6–10 times per page, so a hostile page costs over 10 s CPU inside `read-source`. Fix: bound the groups (`[^\]\n]{1,300}`, `[^)\n]{0,2000}`).

### 11. Reading a finished search fails if an optional lookup fails (effort S)

`server/freshness.ts` `hydrateTerminalSearch` → `latestVerifiedJobs` has no catch, so a hiccup returns 503 for a run whose results are already stored. Fix: `.catch(() => run)` with a `console.error`.

### 12. Cache-expiry and refresh-header edge cases surface as 429 "allowance" errors (effort S)

- A `get_search_cache` hit followed by `create_search_run` with `cached=true` after the row expired returns `cache_expired` as `429 CACHE_EXPIRED` with allowance wording. Fall through to a live run instead.
- The refresh route accepts any `idempotency-key` header; over 128 chars becomes SQL `invalid_request` as a 429. Validate with the same regex as `/api/searches`.

### 13. Provider network errors are reported as timeouts (effort S)

`server/tinyfish.ts` maps every `fetch()` rejection to `PROVIDER_TIMEOUT` 504. Check `error.name === 'TimeoutError'`, otherwise `PROVIDER_UNREACHABLE` 502.

### 14. Reviewer experience (effort S–M)

- README: add "For reviewers (5 minutes)" at the top with the demo link, expected run time (1–9 minutes), daily limits, the no-credentials path (`npm ci && npm run check && npm run dev:ui-test`), and a TinyFish usage map pointing at `server/tinyfish.ts` (`search`, `fetchPage`, `startAgent`, `getRun`, `cancelRun`) and the Workflow steps that call them.
- Replace "Microsoft Edge" and PowerShell fences (README, `docs/deployment.md`, `docs/accounts.md`, `supabase/README.md`) with any browser and bash.
- Replace the duplicated env block with `cp .dev.vars.example .dev.vars`; fix the `APP_ORIGIN` mismatch between README (`127.0.0.1:5173`) and the example file (`localhost:8787`).
- Move the budget accounting essay to `docs/budget.md`.
- `/api/config` without `.dev.vars` says "FirstRole is being connected to its live sources", wrong for local dev. Say "Local dev: copy .dev.vars.example".
- `searchEnabled` ignores `budget_guard`, the daily Agent cap of 4, and per-guest limits, so reviewers can hit a 429 with no warning. Add a read-only `get_public_availability()` RPC surfaced in `/api/config`, and a clearly labelled recorded example run so the Search → Fetch → Agent provenance is visible even when the budget is spent.
- `tests/ui/plugin.ts` returns `completed` instantly, so the no-credentials mode never shows stages, cancel, polling, partial failures, or the Agent preview. Make the fixture advance through stages over time, implement cancel, and add `?scenario=failed|stalled|budget`.

## P2

- Two finalizers (`finishSearch` in `search-state.ts`, `finishOrHandoffSearch` in `workflow-finalization.ts`); `enrichment-workflow.ts` reads cancellation twice. Use one.
- Terminal status lists defined in `index.ts`, `freshness.ts`, `workflow-finalization.ts`, `App.tsx`; provider terminal list in `index.ts` and `agent-preview.ts`. Export one from `shared/types.ts` and use `isTerminalAgentStatus`.
- `read-source-${i}` and `read-observed-detail-${i}` duplicate the fetch/extract/catch block. Extract a helper.
- Progress steps return the full `SearchRun` (up to 512 KB) into Workflow state. Return nothing.
- `presentRun` rewrites a "legacy" budget message that `admissionError` still produces for search/fetch. Return the scoped message at the source and delete the rewrite after the 48 h run expiry.
- The cancel route's final `db.update(run)` is a no-op after `request_search_cancel`; pass the stage into the RPC or drop the update.
- Dead files: `tests/integration/halliburton-diagnostic.ts`; 13 of 15 images in `artifacts/screenshots` are unreferenced; unused exports `fetchConfig`, `GUEST_ID_KEY`, `ACTIVE_SEARCH_KEY`.
- Architecture note: the bounded 20-step mode, schema fallback, and key-bound rate attestations are all off in the pilot config. Either remove the unused mode or add `docs/architecture.md` with a diagram of the three Workflows, the reserve → claim → bind → settle ledger, why paid steps never retry, and the reconciliation runbook.

## Suggested order

1. Items 1, 2, 3 (P0) with the Workflow orchestration test from item 8.
2. Items 7, 9, 10, 11, 12, 13 (small server fixes, each with a test).
3. Items 4, 5, 6 (client resilience).
4. Item 14 docs and UI test mode, then P2 cleanup.
