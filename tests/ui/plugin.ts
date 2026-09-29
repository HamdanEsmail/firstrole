import type { Plugin } from 'vite';
import { fixtureJobs } from './fixtures.ts';
import type { SearchRun } from '../../shared/types.ts';

export function uiTestPlugin(): Plugin {
  const runs = new Map<string, SearchRun>();
  return {
    name: 'firstrole-local-ui-test',
    transformIndexHtml(html) {
      return html.replace(
        '<body>',
        '<body><div style="position:fixed;right:8px;bottom:3px;z-index:9999;background:#fff0cb;color:#7c5010;padding:2px 8px;font:11px sans-serif;border:1px solid #e3ce9b;border-radius:4px;pointer-events:none">UI TEST · FICTIONAL LISTINGS · NO LIVE API CALLS</div>',
      );
    },
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        const path = req.url || '';
        res.setHeader('content-type', 'application/json');
        const send = (data: unknown, status = 200) => {
          res.statusCode = status;
          res.end(JSON.stringify(data));
        };
        if (path === '/config') {
          send({
            supabaseUrl: '',
            supabasePublishableKey: '',
            searchEnabled: true,
            googleEnabled: false,
          });
          return;
        }
        if (path === '/searches' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 20000) {
              send({ error: { message: 'Input too long' } }, 400);
              return;
            }
          }
          const { preferences } = JSON.parse(body);
          const now = new Date().toISOString();
          const run: SearchRun = {
            id: crypto.randomUUID(),
            status: 'completed',
            stage: 'UI test complete',
            preferences,
            sources: fixtureJobs.map((j) => ({
              url: j.sourceUrl,
              name: j.company,
              status: 'complete',
              count: 1,
            })),
            results: fixtureJobs,
            cached: false,
            errors: [],
            createdAt: now,
            updatedAt: now,
          };
          runs.set(run.id, run);
          send(run);
          return;
        }
        if (path.startsWith('/searches/')) {
          const run = runs.get(path.split('/')[2]);
          if (run) {
            send(run);
            return;
          }
          send({ error: { message: 'UI test search expired' } }, 404);
          return;
        }
        if (path.startsWith('/jobs/') && path.endsWith('/refresh')) {
          const job = fixtureJobs.find((j) => j.id === path.split('/')[2]);
          if (job) {
            send({ ...job, checkedAt: new Date().toISOString() });
            return;
          }
        }
        next();
      });
    },
  };
}
