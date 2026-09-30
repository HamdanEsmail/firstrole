# FirstRole database

Apply the numbered files in `migrations/` in order to a **new Supabase project** using the SQL editor or Supabase migrations. On a project where the first migration already succeeded, apply only the later additive migration(s). They create the schema and grants; they do not provision a project, configure OAuth, or contact TinyFish. Never run `tests/database-bootstrap.sql` against a Supabase project: that file mocks Auth for isolated tests only.

## Browser account contract

The signed-in Supabase client can read and change only rows whose `user_id = (select auth.uid())`.

| Table        | Columns                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles`   | `user_id` UUID primary key; `preferences` JSON object; server-maintained `updated_at`                                                              |
| `saved_jobs` | Composite primary key `user_id, job_id`; `job` JSON snapshot; `status`; `notes`; nullable `applied_at`; `saved_at`; server-maintained `updated_at` |

Status values match `shared/types.ts`: Saved, Applied, Interviewing, Offer, Rejected, Withdrawn. Notes are limited to 10,000 characters and a job snapshot to 128 KiB. `job.id` must match `job_id`. The browser supplies ISO timestamp strings for saved/applied dates. Guest import uses conflict-ignore semantics on `(user_id, job_id)` so existing account data wins; only clear local records after verifying the account records.

Deleting the Auth user cascades preferences, saved jobs, and private search runs. The Worker first calls `cancel_user_searches`, then requests cancellation of known provider runs, then deletes the Auth user. Operation records detach from deleted searches and preserve provider run IDs, amounts, and claims required for reconciliation. They contain no search payload, notes, account UUID, or guest identity. The daily actor/network counters contain only server HMAC keys.

## Service-only orchestration

### Catalog freshness

Migration `202609300004_monotonic_job_facts.sql` makes `firstrole_index_jobs` replace a catalog entry only when the incoming `checkedAt` is strictly newer. Comparison uses an explicit-timezone timestamp, so equal instants expressed with different offsets do not replace one another. Older, missing, or invalid timestamps cannot overwrite an existing timestamped entry. A valid new check can replace an untimestamped legacy entry, and duplicate IDs within one payload select the newest observation.

The conflict update evaluates this guard atomically against the catalog row. The indexing function retains its identity, owner, `SECURITY DEFINER` behavior, fixed search path, and service-only execution permissions. Its timestamp parser is also private. Applying this migration changes functions and grants; it does not rewrite existing job, account, or budget rows.

HTTP reads of completed searches and cached results fetch at most twelve existing job IDs from this catalog, use only strictly newer source facts, and recompute eligibility and ranking for the current search preferences. Shared-cache expiry and saved application records are unchanged. Active search polling does not perform this extra catalog read.

All private tables have RLS enabled with no browser policies. All RPCs below explicitly revoke access from `PUBLIC`, `anon`, and `authenticated`; only `service_role` can call them. Never include the service-role secret in a browser bundle.

| RPC                                                                                                                                   | Result / behavior                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_search_run(p_run_id,p_actor_key,p_owner_id,p_guest_id,p_network_key,p_fingerprint,p_payload,p_assisted,p_idempotency_key)`    | `{admitted,run,reused,reason?}`. Exactly one of owner and guest must be present. Replayed actor/idempotency keys return the original run before charging/counting; a changed fingerprint is rejected.                                               |
| `get_search_run(p_run_id,p_actor_key)`                                                                                                | Owned, unexpired `SearchRun` or null.                                                                                                                                                                                                               |
| `get_internal_search_run(p_run_id)`                                                                                                   | `{payload,cancelRequested,actorKey,ownerId,guestId,networkKey,assisted}` or null.                                                                                                                                                                   |
| `update_search_run(p_run_id,p_payload)`                                                                                               | Updated `SearchRun`; terminal states cannot be overwritten. Server-verified results populate the private job catalog. Terminal updates return an unused assisted allowance in the same transaction.                                                                                                                               |
| `request_search_cancel(p_run_id,p_actor_key)`                                                                                         | Boolean. Marks the owned nonterminal run cancelled, prevents later claims, and returns its assisted allowance only if no Agent execution was used or remains uncertain.                                                                                                                                                                       |
| `release_unused_agent_allowance(p_run_id)`                                                                                            | `{released,reason?,usageDate?}`. Service-only repair for a terminal, noncached run. Returns only its unused assisted counters on the original admission's UTC date, once; search counters and money are unchanged. |
| `cancel_user_searches(p_owner_id)`                                                                                                    | Boolean. Fences all nonterminal account searches before account deletion.                                                                                                                                                                           |
| `reserve_provider_operation(p_run_id,p_operation_key,p_kind,p_units=1,p_source_host=null)`                                            | `{allowed,operationId,state,reservedUsd?,reused,reason?}`. Kind is search/fetch/agent. Repeat keys are free and must retain the same kind, units, and host.                                                                                         |
| `reserve_bounded_agent_operation(p_run_id,p_operation_key,p_source_host,p_max_steps,p_reservation_usd)`                                | Same reservation shape. Requires exactly 20 steps and USD 0.35. Shares the existing budget, claim, concurrency and daily limits; existing legacy reservations are never resized. |
| `claim_provider_operation(p_operation_id,p_claim_token)`                                                                              | `{claimed,state?,providerRunId?,claimToken?,reason?}`. Only the first claim may dispatch. A replay returns the original token for recovery, never another dispatch permit.                                                                          |
| `bind_provider_run(p_operation_id,p_claim_token,p_provider_run_id)`                                                                   | Boolean. Persist the provider ID immediately when received.                                                                                                                                                                                         |
| `settle_provider_operation(p_operation_id,p_claim_token,p_outcome,p_actual_usd=null,p_authoritative=false,p_terminal_verified=false)` | `{settled,state?,chargedUsd?,reservedUsd?,reused?,reason?}`. See reconciliation below.                                                                                                                                                              |
| `list_provider_operations(p_run_id)`                                                                                                  | Array including `id,claimToken,providerRunId,state,kind,reservedUsd,chargedUsd,outcome,terminalVerified`.                                                                                                                                           |
| `get_user_provider_operations(p_owner_id)`                                                                                            | Active/unreconciled operations for the account, including `runId`; call before deleting Auth user.                                                                                                                                                  |
| `get_authorized_job(p_job_id,p_actor_key,p_search_id=null,p_owner_id=null)`                                                           | Owned `Job` or null. For saved jobs, ownership comes from `saved_jobs` and source authority from `verified_jobs`; edited browser snapshots never control the refresh destination. The Worker derives owner ID from verified Auth, not request JSON. |
| `get_search_cache(p_fingerprint)`                                                                                                     | Fresh `{results,sources,errors}` or null.                                                                                                                                                                                                           |
| `put_search_cache(p_fingerprint,p_payload,p_ttl_seconds=21600)`                                                                       | Boolean. TTL defaults to six hours and is at most 21,600 seconds; stores only public result/source/error data, stripping preferences and identity.                                                                                                  |

Actor/network keys are opaque server-generated HMACs. Use a verified Auth user ID or a signed guest cookie as the actor input; use a trusted edge-provided IP value as the network input. Never trust a request body's actor key, owner ID, forwarded-IP string, cost, units, cache status, or operation key. Keys must remain stable across Worker instances and normal restarts. A reset guest cookie cannot bypass the separate network allowance. URLs must pass the Worker's public-URL/redirect checks before a provider reservation; a syntactically valid source hostname in SQL is not an SSRF defense.

A cache hit still gets a persisted, owned run. `create_search_run` accepts `payload.cached=true` only when a fresh fingerprint exists, replaces the caller's result data with the stored cache, and skips spend/search quotas. This works while spending is disabled or exhausted. Cached runs cannot start provider operations. Apply normal HTTP request throttling outside the paid-call quotas to prevent cache-only traffic from creating excessive storage.

## Limits and reconciliation

The singleton `budget_guard` row is locked first by admission, reservation, claim, cancellation, and settlement mutations. PostgreSQL holds that lock until the RPC transaction commits, so independent Workers cannot pass the same spend or concurrency check simultaneously. Unique operation keys and claim tokens prevent replayed Workflows from issuing a second provider request. Reserve each retry under a new attempt key; never reuse a successful claim to dispatch again.

| Control                      | Default                                                   |
| ---------------------------- | --------------------------------------------------------- |
| Total public-demo envelope   | USD 10, lifetime; never resets at midnight                |
| Search dispatch              | USD 0.005 per attempt                                     |
| Fetch dispatch               | USD 0.001 per URL per attempt                             |
| Standard Agent (pilot)       | USD 2.50 reservation; `TINYFISH_MAX_STEPS_ENABLED=false` omits beta-only `max_steps`; provider default maximum 150 steps |
| Beta-enabled bounded Agent   | USD 0.35 only with verified account entitlement and `TINYFISH_MAX_STEPS_ENABLED=true`; request must send `agent_config.max_steps=20` |
| Concurrent Agents            | 2 globally, 1 per source hostname                         |
| Agent starts                 | 4 per UTC day; verified pre-execution rejections excluded |
| Searches                     | Guest 3/day; account 10/day; network 20/day               |
| Assisted searches            | Actor 1/day; network 3/day                                |
| Source fetch allowance       | 30 URL units/hour/hostname                                |
| Private search read lifetime | 48 hours                                                  |

Migration `202609300007_bounded_agent_reservations.sql` adds the smaller reservation path without changing the legacy RPC or any stored balances. New operation keys use an internal `bounded20:` prefix so unchanged legacy callers cannot accidentally dispatch an unbounded request against the smaller hold. Callers supply the normal operation key. An upgraded caller that finds an existing legacy operation reuses it without changing its reservation.

The pilot sets `TINYFISH_MAX_STEPS_ENABLED=false` and uses the original standard Agent reservation RPC from the first attempt: USD 2.50, no beta-only `max_steps` parameter, and the documented provider default maximum of 150 steps. This hold is temporary when terminal usage can be validated: the enabled reported-usage policy records the reported cost and releases the unused amount automatically. Active and uncertain execution remains reserved.

The smaller reservation is an optional account-entitled path, enabled by `TINYFISH_MAX_STEPS_ENABLED=true`. Only a conclusive pre-execution capability rejection can settle a rejected bounded attempt at zero and select a separately admitted standard request. That request must reserve USD 2.50 before omitting `max_steps`. The Worker never omits the step limit while relying on the USD 0.35 hold. Unknown starts and generic access/credit errors do not trigger an alternative submission.

Search/Fetch reservations become charges at first dispatch claim. They remain conservatively charged if the response is lost. Agent reservations remain held after a transport failure, lost provider ID, or uncertain execution. A timeout or cancellation acknowledgment alone does not establish cost. There is no lease timeout that silently refunds an uncertain call.

`TINYFISH_REPORTED_USAGE_ENABLED=true` enables the owner's approved reported-usage policy. The Worker validates an exact matching terminal run ID, a safe integer `num_of_steps` between zero and the known dispatch cap (20 bounded or 150 legacy), and a fresh positive verified USD/step rate no greater than 0.016. It then supplies the reported steps multiplied by that rate as `p_actual_usd`, with `p_authoritative=true` and `p_terminal_verified=true`. Decimal arithmetic rounds any fractional microdollar upward to the ledger's six-decimal precision. This is reported-usage accounting, not final invoice evidence. Missing, mismatched, malformed or stale evidence retains the hold; old checkpoints without a proven dispatch cap also retain it. A matching terminal cancellation explicitly reporting zero steps can settle at zero.

`p_terminal_verified=true` alone frees the concurrency slot while preserving dollars. The SQL RPC still accepts only `completed`, `failed`, `cancelled`, `not-started` and `unknown`; there is no reported-usage suffix or separate persisted invoice/basis field. Completed, failed and cancelled executions can all have nonzero cost. Do not derive a charge from duration or assume cancellation was free. Amounts above a reservation are recorded truthfully and stop further admission if the envelope is exceeded; the Worker must also enforce the provider execution bound.

The narrow `not-started` outcome is only for conclusive pre-execution rejection: for example documented schema or step-limit entitlement rejection before an Agent run exists. It requires authoritative zero cost; for a claimed Agent it also requires terminal verification and no bound provider run ID. A cancelled in-flight request is not `not-started`. The fallback may reserve another Agent operation only when all earlier Agent operations for that search settled as `not-started`.

Migrations `202609300008_release_unused_assistance.sql` and `202609300009_cancel_unused_assistance.sql` return an unused assisted-search admission when a noncached run finishes or is cancelled before Agent execution. The shared budget lock is taken before the run lock, so a competing reservation or claim cannot race the release. Every Agent operation must be absent or conclusively settled as `not-started` with zero charge/hold and no provider run ID. Reserved, claimed, ambiguous, actually submitted and cancelled Agent operations keep the allowance, including a submitted cancellation with zero reported cost.

The release decrements only the original UTC admission day's actor/network `assisted` counts and changes `search_runs.assisted` to false as its replay guard. Ordinary search counts, other dates, spending and reservations are unchanged. Both counter rows must exist and be positive or the release fails closed. Terminal updates and cancellation perform it in their existing RPC transaction, adding no HTTP request. The explicit `release_unused_agent_allowance` RPC supports a targeted repair of an already-terminal run; the migrations perform no blanket retroactive refunds. Existing cancellation return values, terminal-state preservation and catalog freshness behavior remain intact.

Stop new paid work without destroying state:

```sql
update public.budget_guard set enabled=false where singleton;
```

Use `list_provider_operations` and matching provider evidence for reconciliation, then call `settle_provider_operation` with the exact saved claim token. The enabled reported-usage policy can supply validated terminal usage; separately confirmed per-run billing can support manual reconciliation. Keep unverified reservations in place. Do not directly edit spent/reserved totals, delete the ledger, or clear counters to get around a limit. `budget_ledger` records reservation, dispatch charge, and reconciliation deltas; totals must match operation amounts. None of these migrations increases or resets the USD 10 allowance.

Expired cache/search records are ignored by reads. No scheduler or cron is installed. If adding maintenance, delete expired cache rows freely, but preserve search rows with nonterminal/unreconciled provider operations until their run IDs can be safely retained for reconciliation. Never remove unsettled operation/ledger records as ordinary cleanup.

## Automatic provider rate verification

`202609290002_provider_rate_attestations.sql` adds only a private metadata table and three service-only RPCs. It does not update the existing budget guard, ledger, accounts, or allowance values. Before a new paid search or refresh, the Worker uses a fresh proof for the SHA-256 fingerprint of its API key, or verifies current rates with the SDK-documented `GET https://agent.tinyfish.ai/v1/wallet` and `X-API-Key` authentication. No raw key or wallet balance is stored in the proof table.

The required USD meters are exactly `TinyFish Agent` per `step` at at most 0.016, `TinyFish Search` per `query` at at most 0.005, and `TinyFish Fetch` per `url` at at most 0.001. Missing, duplicate, malformed, differently denominated, excessive, or more than 60 seconds future-dated rates fail closed. Migration `202609290003_rate_clock_skew.sql` permits that bounded clock difference without extending the six-hour validity window. The metadata GET rejects redirects, has a ten-second timeout, and is limited to 64 KiB. A null rates read or legacy-plan 404 does not verify rates.

Verified proofs expire six hours after the provider's `rates.as_of`. Refresh ownership uses a 30-second compare-and-set lease; only that exact token can complete it, preventing an old response from replacing or clearing a newer proof. Failed verification has a one-minute retry cooldown. The RPCs are `get_provider_rate_attestation`, `claim_provider_rate_refresh`, and `complete_provider_rate_refresh`; none are browser-callable.

An initial manual environment proof can be used for at most 24 hours only when `TINYFISH_RATES_KEY_SHA256` matches the configured key's SHA-256 and no stored observation exists. This binding prevents a rotated key from inheriting another account's manual rate proof. The deployed app does not require that optional fallback: it can verify the first proof automatically.

The public configuration no longer disables the search form solely because a manual timestamp has aged. The actual paid path must pass verification, and cached job results bypass that path. Each Workflow loads one safe rate snapshot with a single database read and does not issue wallet calls. Only rate values/timestamps are persisted in Workflow steps; API keys and environment bindings are not.

## Verification

`tests/database-acceptance.sql` tests RLS, forbidden browser RPCs, import conflicts, request/operation idempotency, per-URL charges, claim replay, cancellation, uncertain reservations, source limits, safe cache reuse, budget boundaries, and deletion cascades. `tests/database-limits.sql` tests global/source Agent concurrency, retained-cost terminal states, the exact no-start fallback, daily actor/network limits, and tampered-snapshot URL isolation. `tests/database-rates.sql` tests rate-proof permissions, key separation, refresh ownership, timestamps, price caps, cooldowns, and an unchanged budget guard. `tests/database-catalog.sql` checks out-of-order observations, stale cache publication, equal-timezone instants, malformed timestamps, batch duplicates, legacy entries, preserved function privileges/ownership, and unchanged budget/account state against a pre-migration snapshot. Its baseline script is test-only and must never run in a live project. `tests/rates.test.ts` covers wallet-response validation and rate preflight without live provider calls.

`tests/database-bounded-agent.sql` covers the USD 0.35 path, unchanged USD 2.50 legacy reservations, shared budget/concurrency/daily limits, idempotency and separately admitted capability fallback. `tests/database-assistance.sql` and `tests/database-cancel-assistance.sql` cover unused-allowance release, original UTC dates, preserved search counts, wrong-actor and repeated cancellation, both dispatch/release ordering outcomes, actual or uncertain execution, zero-step submitted cancellation, and unchanged financial rows and privileges. Their baseline scripts are also isolated-test-only. `tests/agent-usage.test.ts` checks terminal identity, dispatched caps, step counts, rate proofs and decimal calculation; provider integration tests check policy settlement arguments and failure responses.

The tests were executed using PGlite's PostgreSQL engine in an isolated in-memory database, not by applying anything to a live Supabase project. PGlite is included in the repository's development dependencies. From a clean checkout, run them without installing PostgreSQL or starting Docker:

```powershell
npm ci
npm run test:database
```

An optional isolated runtime can also be used without changing project dependencies:

```powershell
npm install --prefix "$env:TEMP\firstrole-db-validation" --no-save @electric-sql/pglite
node tests/database-check.mjs "$env:TEMP\firstrole-db-validation\node_modules\@electric-sql\pglite"
```

The bootstrap, migration, and test SQL can be run against a disposable native PostgreSQL database with `psql -v ON_ERROR_STOP=1`; the test bootstrap intentionally creates Supabase-like roles/Auth and must never target production.

PGlite validates real PostgreSQL syntax, constraints, RLS, triggers, and transactional behavior, but its single connection is not a multi-session load test. Before exposing a deployed demo, run simultaneous independent requests against the configured Supabase project and confirm exactly one provider claim per key, no more than two active Agents, and no reservation beyond the envelope.
