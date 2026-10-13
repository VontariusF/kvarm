import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as ci from '../../services/ci';
import { resumeAfterCheck } from '../../services/changes';

export const ciApi = new Hono<App>();

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>) {
  return c.json({ error: r.error, code: r.code }, r.status as never);
}

async function runnerContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'write', { requireActor: true, transport: 'ci' });
  return d.ok ? ({ d } as const) : ({ denied: denyJson(c, d) } as const);
}

const body = (c: Context<App>) => c.req.json().catch(() => undefined);

ciApi.post('/repos/:owner/:repo/ci/jobs/claim', async (c) => {
  const x = await runnerContext(c);
  if ('denied' in x) return x.denied;
  const r = await ci.claimJob(c.env, x.d.repo, await body(c));
  if (!r.ok) return failJson(c, r);
  if (r.value === null) return new Response(null, { status: 204 });
  return actorJson(c, { job: r.value });
});

ciApi.post('/repos/:owner/:repo/ci/jobs/:id/heartbeat', async (c) => {
  const x = await runnerContext(c);
  if ('denied' in x) return x.denied;
  const r = await ci.heartbeatJob(c.env, x.d.repo, c.req.param('id'), await body(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, { job: r.value });
});

ciApi.post('/repos/:owner/:repo/ci/jobs/:id/report', async (c) => {
  const x = await runnerContext(c);
  if ('denied' in x) return x.denied;
  const r = await ci.reportJob(c.env, x.d.repo, c.req.param('id'), await body(c));
  if (!r.ok) return failJson(c, r);
  if (r.value.change) {
    c.executionCtx.waitUntil(resumeAfterCheck(c.env, x.d.repo.id, r.value.change, (p) => c.executionCtx.waitUntil(p)));
  }
  return actorJson(c, { run: r.value.run, change: r.value.change ? { number: r.value.change.number } : null, retry: r.value.retry, flake: r.value.flake });
});
