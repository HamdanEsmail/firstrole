// Explicitly authorized one-time diagnostic, guarded by the production quota/budget RPCs.
// Never invoke as part of the test suite or repeat to get around a claim refusal.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import type { SearchRun } from '../../shared/types';
import { Database } from '../../server/db';
import { TinyFish } from '../../server/tinyfish';
import { providerReady, type Env } from '../../server/env';
import { sha256, safeMessage } from '../../server/http';
import { extractPageJob } from '../../server/quality';

if (process.env.FIRSTROLE_ALLOW_DIAGNOSTIC_FETCH !== 'halliburton-once')
  throw new Error('This diagnostic requires explicit one-time authorization.');
const values: Record<string, string> = {};
for (const line of (await readFile('.dev.vars', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const env = { ...values, TINYFISH_ENABLED: 'true' } as unknown as Env;
if (!providerReady(env))
  throw new Error(
    'Existing rate verification/configuration is not valid; no operation was created.',
  );
const db = new Database(env);
const sourceRunId = process.env.FIRSTROLE_DIAGNOSTIC_SOURCE_RUN_ID;
if (!sourceRunId || !/^[a-f0-9-]{36}$/i.test(sourceRunId))
  throw new Error(
    'Supply the already-observed source search ID through the diagnostic environment.',
  );
const original = await db.internal(sourceRunId);
if (!original) throw new Error('Observed source search was not found.');
const url = original.payload.sources.find(
  (source) => new URL(source.url).hostname === 'careers.halliburton.com',
)?.url;
if (!url) throw new Error('The authorized Halliburton source is not present in that search.');
const now = new Date().toISOString();
const run: SearchRun = {
  id: crypto.randomUUID(),
  status: 'reading',
  stage: 'Owner-authorized diagnostic source read.',
  cached: false,
  createdAt: now,
  updatedAt: now,
  preferences: original.payload.preferences,
  sources: [{ url, name: 'careers.halliburton.com', status: 'reading', count: 0 }],
  results: [],
  errors: [],
};
const admission = await db.rpc<{
  admitted: boolean;
  reused?: boolean;
  reason?: string;
  run?: SearchRun;
}>('create_search_run', {
  p_run_id: run.id,
  p_actor_key: original.actorKey,
  p_owner_id: original.ownerId,
  p_guest_id: original.guestId,
  p_network_key: original.networkKey,
  p_fingerprint: await sha256(`diagnostic:${url}`),
  p_payload: run,
  p_assisted: false,
  p_idempotency_key: 'diagnostic-halliburton-20260929',
});
if (!admission.admitted || !admission.run)
  throw new Error(
    `Diagnostic admission rejected: ${admission.reason || 'unknown'}. No bypass attempted.`,
  );
if (admission.reused)
  throw new Error('This diagnostic was already admitted; refusing to submit it again.');
const saved = admission.run;
try {
  const page = await new TinyFish(env, db, saved.id).fetchPage(
    url,
    'diagnostic-halliburton-one-fetch',
  );
  await mkdir('artifacts/private/diagnostics', { recursive: true });
  await writeFile(
    'artifacts/private/diagnostics/halliburton-public-page.json',
    JSON.stringify(page, null, 2),
    'utf8',
  );
  const job = await extractPageJob(page, saved.preferences);
  saved.results = job ? [job] : [];
  saved.status = 'completed';
  saved.stage = 'Diagnostic source read completed.';
  saved.sources[0].status = 'complete';
  saved.sources[0].count = job ? 1 : 0;
  await db.update(saved);
  console.log(
    JSON.stringify({
      status: 'completed',
      accountedMaximumUsd: 0.001,
      pageTitle: page.title,
      characters: typeof page.text === 'string' ? page.text.length : 0,
      parsedJob: job
        ? {
            title: job.title,
            company: job.company,
            location: job.location,
            employmentType: job.employmentType,
            availability: job.availability,
          }
        : null,
    }),
  );
} catch (error) {
  saved.status = 'failed';
  saved.stage = safeMessage(error);
  saved.errors = [{ source: url, message: safeMessage(error) }];
  await db.update(saved);
  console.log(
    JSON.stringify({ status: 'failed', message: safeMessage(error), reservationRetained: true }),
  );
  process.exitCode = 1;
}
