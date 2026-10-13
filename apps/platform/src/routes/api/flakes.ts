/**
 * The flake registry and check quarantine under /api/v1/repos/:owner/:repo.
 * Thin adapters over services/flakes.ts. Anyone who can read the repo sees
 * its flakes and quarantines; only repo admins (owner, org owners and
 * maintainers, admin grants, the instance admin) quarantine or restore, and
 * agent credentials never do: an agent must not silence its own failing check.
 *
 *   GET  flakes?check=&limit=&cursor=
 *   POST flakes/:check/quarantine  {reason?, expiresAt?}
 *   POST flakes/:check/restore
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as flakes from '../../services/flakes';

export const flakesApi = new Hono<App>();

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  return c.json({ error: r.error, code: r.code }, r.status as never);
}

flakesApi.get('/repos/:owner/:repo/flakes', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await flakes.listFlakes(c.env, d.repo, { check: c.req.query('check'), limit: c.req.query('limit'), cursor: c.req.query('cursor') });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

flakesApi.post('/repos/:owner/:repo/flakes/:check/quarantine', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return c.json({ error: 'unauthorized' }, 401);
  // No body means the defaults; a body that is not JSON is refused rather than read as the defaults.
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: 'body must be a JSON object', code: 'INVALID_BODY' }, 400);
    }
  }
  const r = await flakes.quarantineCheck(c.env, d.repo, d.actor, c.req.param('check'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, { quarantine: r.value });
});

flakesApi.post('/repos/:owner/:repo/flakes/:check/restore', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return c.json({ error: 'unauthorized' }, 401);
  const r = await flakes.restoreCheck(c.env, d.repo, d.actor, c.req.param('check'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, { restored: true, quarantine: r.value });
});
