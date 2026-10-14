/**
 * Read bounds of the review inbox (services/reviewInbox.ts, migration 0036,
 * architecture §10): many live changes the gate does not hold, and many
 * repositories the viewer has nothing to do with, must not make one /inbox
 * read scan all of them. Before the bound one page here read
 * `d1=12;rr=35010`; the page is now `d1=5` and its rows read do not grow with
 * either count.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { INBOX_LIMITS } from '../src/services/reviewInbox';

const env = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'ibc-owner';
const NOW = 1_760_000_000_000;
const HEAD = 'c'.repeat(40);
/** Live changes nobody needs to act on, all newer than the one that waits. */
const QUIET = 2000;
/** Repositories of another account in the same instance. */
const UNRELATED = 3000;
/** Rows one page may read: a window of candidates with their review facts, plus the shell. */
const PAGE_ROWS = 1500;
const tok = { owner: '', admin: '' };

async function call(path: string, token: string): Promise<{ status: number; text: string; cost: CostCounters }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, text, cost: parseCostHeader(res.headers.get(COST_HEADER))! };
}

async function seedUser(login: string, admin: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, admin ? 1 : 0, NOW)
    .run();
  return id;
}

beforeAll(async () => {
  const ownerId = await seedUser(OWNER, false);
  const otherId = await seedUser('ibc-other', false);
  const adminId = await seedUser('ibc-admin', true);
  const repoId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at, pushed_at)
     VALUES (?, ?, 'busy', ?, 'https://artifacts.invalid/busy', 'private', 'main', ?, ?)`,
  )
    .bind(repoId, OWNER, `${OWNER}--busy`, NOW, NOW)
    .run();
  // A branch rule on another branch: no change into main is held by it.
  await env.DB.prepare(
    `INSERT INTO branch_rules (id, repo_id, pattern, required_approvals, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, 'refs/heads/release', 1, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), repoId, ownerId, NOW, ownerId, NOW)
    .run();
  // The one change the gate holds (into the protected release branch), older than every quiet one.
  await env.DB.prepare(
    `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, merge_policy, created_at)
     VALUES (?, ?, 1, 'Held for a human', 'release', 'agents/w1/work', ?, 'open', ?, 'review', ?)`,
  )
    .bind(crypto.randomUUID(), repoId, HEAD, otherId, NOW - 10 * QUIET - 10)
    .run();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < QUIET; i++) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, merge_policy, created_at)
         VALUES (?, ?, ?, ?, 'main', ?, ?, 'open', ?, 'review', ?)`,
      ).bind(crypto.randomUUID(), repoId, i + 2, `Quiet ${i}`, `agents/q${i}/work`, HEAD, otherId, NOW - 10 * i),
    );
  }
  for (let i = 0; i < UNRELATED; i++) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at, pushed_at)
         VALUES (?, 'ibc-other', ?, ?, 'https://artifacts.invalid/r', 'private', 'main', ?, ?)`,
      ).bind(crypto.randomUUID(), `r${i}`, `ibc-other--r${i}`, NOW, NOW - 1 - i),
    );
  }
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  tok.owner = (await mintPAT(env, ownerId, 'cost', ['read', 'write', 'api'])).token;
  tok.admin = (await mintPAT(env, adminId, 'cost-admin', ['read', 'write', 'api'])).token;
});

describe('review inbox read bounds (architecture §10)', () => {
  it('examines a bounded window of candidates per page and pages on to the change that waits', async () => {
    let path: string | null = '/inbox';
    let pages = 0;
    let found = false;
    while (path && !found) {
      const r = await call(path, tok.owner);
      expect(r.status).toBe(200);
      expect(r.cost.d1, path).toBeLessThanOrEqual(6);
      expect(r.cost.rr, path).toBeLessThan(PAGE_ROWS);
      found = r.text.includes('Held for a human');
      const next = /href="(\/inbox\?cursor=[^"]+)">Older changes/.exec(r.text);
      path = next ? next[1]!.replaceAll('&amp;', '&') : null;
      if (!found) expect(path, 'an unfinished scan offers the next page').not.toBeNull();
      pages++;
    }
    expect(found).toBe(true);
    expect(pages).toBe(Math.ceil((QUIET + 1) / INBOX_LIMITS.scanWindow));
  });

  it('reads the instance admin’s repositories through a fixed window and says when it is full', async () => {
    const r = await call('/inbox', tok.admin);
    expect(r.status).toBe(200);
    expect(r.cost.d1).toBeLessThanOrEqual(6);
    expect(r.cost.rr).toBeLessThan(PAGE_ROWS + 7 * INBOX_LIMITS.adminReposWindow);
    expect(r.text).toContain('As instance admin you see your own repositories and the 500 most recently pushed');
  });
});
