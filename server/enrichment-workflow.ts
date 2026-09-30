import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Database } from './db';
import { EnrichmentBudget } from './enrichment-budget';
import { hasObservedIdentity, observedDraft, type EnrichmentInput } from './enrichment-candidates';
import type { Env } from './env';
import { extractObservedJob } from './extraction';
import { readPublicPosting } from './firecrawl';
import { extractionConfig, firecrawlConfig } from './optional-rates';
import { deduplicate, eligible, extractPageJob, scoreJob, verifyJob } from './quality';
import { finishSearch } from './search-state';
import type { FetchedPage } from './tinyfish';

const ONCE = { retries: { limit: 0, delay: '1 second' as const }, timeout: '4 minutes' as const };

/** A separate execution keeps optional readers out of the bounded TinyFish Agent path. */
export class EnrichmentWorkflow extends WorkflowEntrypoint<Env, EnrichmentInput> {
  async run(event: WorkflowEvent<EnrichmentInput>, step: WorkflowStep): Promise<void> {
    const db = new Database(this.env);
    const initial = await step.do('load-detail-check', ONCE, () =>
      db.internal(event.payload.searchId),
    );
    if (!initial || initial.cancelRequested) return;
    const run = initial.payload;
    const meter = new EnrichmentBudget(db, run.id);
    try {
      run.stage = 'Checking important details against the original postings.';
      run.status = 'reading';
      await step.do('show-detail-check', ONCE, () => db.update(run));
      // Config functions return secrets, so resolve them inside paid steps; never checkpoint keys.
      for (const [index, candidate] of event.payload.candidates.slice(0, 2).entries()) {
        const outcome = await step.do(`check-posting-${index}`, ONCE, async () => {
          let page: FetchedPage = candidate.page;
          let recovered = false;
          if (candidate.kind === 'render') {
            const read = await readPublicPosting(
              {
                sourceUrl: candidate.sourceUrl,
                previousText: typeof page.text === 'string' ? page.text : '',
                reason: 'shell',
                operationKey: `fallback-${index}`,
              },
              await firecrawlConfig(this.env, db),
              meter,
            );
            if (!read.page) return { job: candidate.job, message: null };
            page = read.page;
            recovered = true;
          }
          let draft = candidate.job || (await extractPageJob(page, run.preferences));
          const needsIdentity = !draft;
          if (!draft) draft = await observedDraft(page, run.preferences);
          if (!draft || typeof page.text !== 'string') return { job: null, message: null };
          // Availability and destination evidence are established by the reader, never the model.
          draft = verifyJob(draft, page, run.preferences);
          const extracted = await extractObservedJob(
            { text: page.text, currentJob: draft, operationKey: `extract-${index}` },
            await extractionConfig(this.env, db),
            meter,
          );
          const job = extracted.job;
          if (needsIdentity && !hasObservedIdentity(job)) return { job: null, message: null };
          const verified = verifyJob(job, page, run.preferences);
          job.availability = verified.availability;
          job.applyUrl = verified.applyUrl;
          // Organizing existing text is not a fresh web read.
          job.checkedAt = recovered ? draft.checkedAt : candidate.observedAt;
          job.match = scoreJob(job, run.preferences);
          return {
            job,
            message: extracted.conflicts.length
              ? 'Some extracted details disagreed with existing source facts. Original facts are retained; check the posting.'
              : extracted.status === 'enriched'
                ? `${recovered ? 'Firecrawl recovered this page. ' : ''}Details checked with Gemma against exact source excerpts.`
                : recovered
                  ? 'Page recovered with Firecrawl; details read from the source.'
                  : null,
          };
        });
        if (outcome.job) {
          run.results = deduplicate([
            ...run.results.filter((job) => job.id !== outcome.job!.id),
            outcome.job,
          ])
            .filter((job) => eligible(job, run.preferences))
            .slice(0, 12);
          const source = run.sources.find((item) => item.url === candidate.sourceUrl);
          if (source && outcome.message) {
            source.status = 'complete';
            source.count = eligible(outcome.job, run.preferences) ? 1 : 0;
            source.message = outcome.message;
            run.errors = run.errors.filter((error) => error.source !== candidate.sourceUrl);
          }
        }
      }
    } catch {
      // Optional extraction never discards the already verified shortlist or triggers a paid retry.
      run.errors.push({
        message: 'Additional detail checks were unavailable. Results already read are preserved.',
      });
    }
    const fresh = await step.do('check-cancellation', ONCE, () => db.internal(run.id));
    if (!fresh || fresh.cancelRequested) {
      if (fresh) await step.do('finish-cancelled-detail-check', ONCE, () => finishSearch(db, run));
      return;
    }
    await step.do('finish-detail-check', ONCE, () => finishSearch(db, run));
  }
}
