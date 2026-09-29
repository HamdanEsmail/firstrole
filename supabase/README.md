# FirstRole database

Apply `migrations/202609290001_firstrole.sql` to a **new Supabase project** using the SQL editor or Supabase migrations. It creates the schema and grants; it does not provision a project, configure OAuth, or contact TinyFish. Never run `tests/database-bootstrap.sql` against a Supabase project: that file mocks Auth for isolated tests only.

## Browser account contract

The signed-in Supabase client can read and change only rows whose `user_id = (select auth.uid())`.

| Table | Columns |
| --- | --- |
| `profiles` | `user_id` UUID primary key; `preferences` JSON object; server-maintained `updated_at` |
| `saved_jobs` | Composite primary key `user_id, job_id`; `job` JSON snapshot; `status`; `notes`; nullable `applied_at`; `saved_at`; server-maintained `updated_at` |

Status values match `shared/types.ts`: Saved, Applied, Interviewing, Offer, Rejected, Withdrawn. Notes are limited to 10,000 characters and a job snapshot to 128 KiB. `job.id` must match `job_id`. The browser supplies ISO timestamp strings for saved/applied dates. Guest import uses conflict-ignore semantics on `(user_id, job_id)` so existing account data wins; only clear local records after verifying the account records.

Deleting the Auth user cascades preferences, saved jobs, and private search runs. The Worker first calls `cancel_user_searches`, then requests cancellation of known provider runs, then deletes the Auth user. Operation records detach from deleted searches and preserve provider run IDs, amounts, and claims required for reconciliation. They contain no search payload, notes, account UUID, or guest identity. The daily actor/network counters contain only server HMAC keys.

## Service-only orchestration

All private tables have RLS enabled with no browser policies. All RPCs below explicitly revoke access from `PUBLIC`, `anon`, and `authenticated`; only `service_role` can call them. Never include the service-role secret in a browser bundle.

| RPC | Result / behavior |
| --- | --- |
| `create_search_run(p_run_id,p_actor_key,p_owner_id,p_guest_id,p_network_key,p_fingerprint,p_payload,p_assisted,p_idempotency_key)` | `{admitted,run,reused,reason?}`. Exactly one of owner and guest must be present. Replayed actor/idempotency keys return the original run before charging/counting; a changed fingerprint is rejected. |
| `get_search_run(p_run_id,p_actor_key)` | Owned, unexpired `SearchRun` or null. |
| `get_internal_search_run(p_run_id)` | `{payload,cancelRequested,actorKey,ownerId,guestId,networkKey,assisted}` or null. |
| `update_search_run(p_run_id,p_payload)` | Updated `SearchRun`; terminal states cannot be overwritten. Server-verified results populate the private job catalog. |
| `request_search_cancel(p_run_id,p_actor_key)` | Boolean. Marks the owned nonterminal run cancelled and prevents later claims. |
| `cancel_user_searches(p_owner_id)` | Boolean. Fences all nonterminal account searches before account deletion. |
| `reserve_provider_operation(p_run_id,p_operation_key,p_kind,p_units=1,p_source_host=null)` | `{allowed,operationId,state,reservedUsd?,reused,reason?}`. Kind is search/fetch/agent. Repeat keys are free and must retain the same kind, units, and host. |
| `claim_provider_operation(p_operation_id,p_claim_token)` | `{claimed,state?,providerRunId?,claimToken?,reason?}`. Only the first claim may dispatch. A replay returns the original token for recovery, never another dispatch permit. |
| `bind_provider_run(p_operation_id,p_claim_token,p_provider_run_id)` | Boolean. Persist the provider ID immediately when received. |
| `settle_provider_operation(p_operation_id,p_claim_token,p_outcome,p_actual_usd=null,p_authoritative=false,p_terminal_verified=false)` | `{settled,state?,chargedUsd?,reservedUsd?,reused?,reason?}`. See reconciliation below. |
| `list_provider_operations(p_run_id)` | Array including `id,claimToken,providerRunId,state,kind,reservedUsd,chargedUsd,outcome,terminalVerified`. |
| `get_user_provider_operations(p_owner_id)` | Active/unreconciled operations for the account, including `runId`; call before deleting Auth user. |
| `get_authorized_job(p_job_id,p_actor_key,p_search_id=null,p_owner_id=null)` | Owned `Job` or null. For saved jobs, ownership comes from `saved_jobs` and source authority from `verified_jobs`; edited browser snapshots never control the refresh destination. The Worker derives owner ID from verified Auth, not request JSON. |
| `get_search_cache(p_fingerprint)` | Fresh `{results,sources,errors}` or null. |
| `put_search_cache(p_fingerprint,p_payload,p_ttl_seconds=21600)` | Boolean. TTL defaults to six hours and is at most 21,600 seconds; stores only public result/source/error data, stripping preferences and identity. |

Actor/network keys are opaque server-generated HMACs. Use a verified Auth user ID or a signed guest cookie as the actor input; use a trusted edge-provided IP value as the network input. Never trust a request body's actor key, owner ID, forwarded-IP string, cost, units, cache status, or operation key. Keys must remain stable across Worker instances and normal restarts. A reset guest cookie cannot bypass the separate network allowance. URLs must pass the Worker's public-URL/redirect checks before a provider reservation; a syntactically valid source hostname in SQL is not an SSRF defense.

A cache hit still gets a persisted, owned run. `create_search_run` accepts `payload.cached=true` only when a fresh fingerprint exists, replaces the caller's result data with the stored cache, and skips spend/search quotas. This works while spending is disabled or exhausted. Cached runs cannot start provider operations. Apply normal HTTP request throttling outside the paid-call quotas to prevent cache-only traffic from creating excessive storage.

## Limits and reconciliation

The singleton `budget_guard` row is locked first by admission, reservation, claim, cancellation, and settlement mutations. PostgreSQL holds that lock until the RPC transaction commits, so independent Workers cannot pass the same spend or concurrency check simultaneously. Unique operation keys and claim tokens prevent replayed Workflows from issuing a second provider request. Reserve each retry under a new attempt key; never reuse a successful claim to dispatch again.

| Control | Default |
| --- | --- |
| Total public-demo envelope | USD 10, lifetime; never resets at midnight |
| Search dispatch | USD 0.005 per attempt |
| Fetch dispatch | USD 0.001 per URL per attempt |
| Agent reservation | USD 2.50 per admitted start |
| Concurrent Agents | 2 globally, 1 per source hostname |
| Agent starts | 4 per UTC day; verified pre-execution rejections excluded |
| Searches | Guest 3/day; account 10/day; network 20/day |
| Assisted searches | Actor 1/day; network 3/day |
| Source fetch allowance | 30 URL units/hour/hostname |
| Private search read lifetime | 48 hours |

Search/Fetch reservations become charges at first dispatch claim. They remain conservatively charged if the response is lost. Agent reservations remain held after a timeout, transport failure, lost provider ID, requested cancellation, or terminal response without authoritative cost. There is no lease timeout that silently refunds an uncertain call.

`p_terminal_verified=true` means a provider status response establishes a terminal state. It frees the concurrency slot while preserving dollars until `p_authoritative=true` and a verified final amount are also supplied. `completed`, `failed`, and `cancelled` can all have nonzero cost. Do not estimate Agent cost from duration or assume a failure/cancellation was free. Amounts above the reservation are recorded truthfully and will stop further admission if the envelope is exceeded; the Worker must also apply the provider's configured execution bound.

The narrow `not-started` outcome is only for conclusive pre-execution rejection: for example the documented schema-entitlement rejection before an Agent run exists. It requires authoritative zero cost; for a claimed Agent it also requires terminal verification and no bound provider run ID. A cancelled in-flight request is not `not-started`. The fallback may reserve another Agent operation only when all earlier Agent operations for that search settled as `not-started`.

Stop new paid work without destroying state:

```sql
update public.budget_guard set enabled=false where singleton;
```

Use `list_provider_operations` and provider status/billing evidence for reconciliation, then call `settle_provider_operation` with the exact saved claim token. Keep unverified reservations in place. Do not directly edit spent/reserved totals, delete the ledger, or clear counters to get around a limit. `budget_ledger` records reservation, dispatch charge, and reconciliation deltas; totals must match operation amounts. This migration does not automatically increase the USD 10 allowance.

Expired cache/search records are ignored by reads. No scheduler or cron is installed. If adding maintenance, delete expired cache rows freely, but preserve search rows with nonterminal/unreconciled provider operations until their run IDs can be safely retained for reconciliation. Never remove unsettled operation/ledger records as ordinary cleanup.

## Verification

`tests/database-acceptance.sql` tests RLS, forbidden browser RPCs, import conflicts, request/operation idempotency, per-URL charges, claim replay, cancellation, uncertain reservations, source limits, safe cache reuse, budget boundaries, and deletion cascades. `tests/database-limits.sql` tests global/source Agent concurrency, retained-cost terminal states, the exact no-start fallback, daily actor/network limits, and tampered-snapshot URL isolation.

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
