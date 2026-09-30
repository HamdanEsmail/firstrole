import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Supply a separately installed PGlite package directory or install it as a dev dependency.
const packagePath = process.argv[2];
const { PGlite } = packagePath
  ? await import(pathToFileURL(resolve(packagePath, 'dist/index.js')).href)
  : await import('@electric-sql/pglite');
const db = new PGlite();
try {
  for (const path of [
    'tests/database-bootstrap.sql',
    'supabase/migrations/202609290001_firstrole.sql',
    'supabase/migrations/202609290002_provider_rate_attestations.sql',
    'supabase/migrations/202609290003_rate_clock_skew.sql',
    'tests/database-catalog-baseline.sql',
    'supabase/migrations/202609300004_monotonic_job_facts.sql',
    'supabase/migrations/202609300005_optional_enrichment_budgets.sql',
    'tests/database-enrichment-provider-baseline.sql',
    'supabase/migrations/202609300006_enrichment_provider_allowlist.sql',
    'tests/database-bounded-agent-baseline.sql',
    'supabase/migrations/202609300007_bounded_agent_reservations.sql',
    'tests/database-assistance-baseline.sql',
    'supabase/migrations/202609300008_release_unused_assistance.sql',
    'tests/database-acceptance.sql',
    'tests/database-limits.sql',
    'tests/database-rates.sql',
    'tests/database-catalog.sql',
    'tests/database-enrichment.sql',
    'tests/database-enrichment-providers.sql',
    'tests/database-bounded-agent.sql',
    'tests/database-assistance.sql',
    'tests/database-cancel-assistance-baseline.sql',
    'supabase/migrations/202609300009_cancel_unused_assistance.sql',
    'tests/database-cancel-assistance.sql',
  ]) {
    const result = await db.exec(await readFile(path, 'utf8'));
    const messages = result.flatMap((r) => r.rows ?? []).filter((r) => r.result);
    for (const row of messages) console.log(row.result);
    console.log(`Passed: ${path}`);
  }
} finally {
  await db.close();
}
