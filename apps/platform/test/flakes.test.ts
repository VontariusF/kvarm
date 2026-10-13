/**
 * Flaky required checks (services/flakes.ts): the one automatic retry of a
 * failed required CI job, flake entries, quarantine and restore with their
 * authorization and audit rows, and how quarantine and retries behave in
 * the checks gate, branch rules, direct merges and the integration train.
 * Runs through the Worker's routes over the in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { FLAKE_LIMITS } from '../src/services/flakes';
import { defaultTrainDeps, runTrain, type TrainDeps } from '../src/services/queue';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'fl-owner';
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/feature';
const ALL: Scope[] = ['read', 'write', 'api', 'ci'];

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const fakeEvents = {
  async send() {},
  async sendBatch() {},
};

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

const tok = { owner: '', reader: '', writer: '', stranger: '' };
const users: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  users[login] = id;
  return id;
}

async function seedRepo(name: string): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
       VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
    ).bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, now),
    env.DB.prepare(`INSERT INTO repo_grants (repo_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'read', ?, ?)`).bind(id, users['fl-reader'], now, now),
    env.DB.prepare(`INSERT INTO repo_grants (repo_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'write', ?, ?)`).bind(id, users['fl-writer'], now, now),
  ]);
  return repo;
}

interface Reply {
  status: number;
  json: Record<string, any>;
  cost: CostCounters;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, json, cost: cost! };
}

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const ci = (jobs: Array<{ name: string; run: string; required?: boolean }>) => `${JSON.stringify({ jobs })}\n`;
const BASE: Files = { 'README.md': '# App\n', 'src/app.js': 'module.exports = 1;\n' };

const claim = (repo: string, runnerId = 'runner') => call('POST', `${R(repo)}/ci/jobs/claim`, tok.owner, { runnerId });
const reportJob = (repo: string, job: { id: string; generation: number }, conclusion: 'success' | 'failure', runnerId = 'runner') =>
  call('POST', `${R(repo)}/ci/jobs/${job.id}/report`, tok.owner, { runnerId, generation: job.generation, conclusion, summary: { conclusion } });
const quarantine = (repo: string, check: string, body: unknown = {}, token = tok.owner) =>
  call('POST', `${R(repo)}/flakes/${encodeURIComponent(check)}/quarantine`, token, body);
const restore = (repo: string, check: string, token = tok.owner) => call('POST', `${R(repo)}/flakes/${encodeURIComponent(check)}/restore`, token);
const flakesOf = (repo: string, q = '', token = tok.owner) => call('GET', `${R(repo)}/flakes${q}`, token);
const mergeability = (repo: string, n = 1) => call('GET', `${R(repo)}/changes/${n}/mergeability`, tok.owner);
const merge = (repo: string, n = 1) => call('POST', `${R(repo)}/changes/${n}/merge`, tok.owner);
const status = (repo: string, sha: string) => call('GET', `${R(repo)}/commits/${sha}/status`, tok.owner);

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<number>('n')) ?? 0;
}
const runsNamed = (repo: string, name: string) => count('SELECT COUNT(*) AS n FROM check_runs WHERE repo_id = ? AND name = ?', repoIds[repo], name);
const jobsOf = (repo: string) => count('SELECT COUNT(*) AS n FROM ci_jobs WHERE repo_id = ?', repoIds[repo]);

/**
 * A repo whose main and feature both carry `config`; feature adds one file.
 * One change, feature → main, created after `rules` and approved by a
 * second human when there are rules (a protected target's review gate).
 */
async function ciChange(name: string, config: string, rules: Array<Record<string, unknown>> = []) {
  const repo = await seedRepo(name);
  const ruleIds: string[] = [];
  for (const rule of rules) {
    const r = await call('POST', `${R(name)}/branch-rules`, tok.owner, rule);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ruleIds.push(r.json.rule.id as string);
  }
  const main = await commit(repo, { ...BASE, '.kvarm/ci.json': config });
  const feature = await commit(repo, { ...BASE, '.kvarm/ci.json': config, [`${name}.txt`]: `${name}\n` }, [main.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set(FEATURE, feature.sha);
  const created = await call('POST', `${R(name)}/changes`, tok.owner, { title: 't', base: 'main', head: 'feature' });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  if (rules.length > 0) {
    const approved = await call('POST', `${R(name)}/changes/${created.json.number}/approve`, tok.writer, {});
    expect(approved.status, JSON.stringify(approved.json)).toBe(201);
  }
  return { repo, main, feature, number: created.json.number as number, ruleIds };
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', ALL)).token;
  tok.reader = (await mintPAT(env, await seedUser('fl-reader'), 'reader', ALL)).token;
  tok.writer = (await mintPAT(env, await seedUser('fl-writer'), 'writer', ALL)).token;
  tok.stranger = (await mintPAT(env, await seedUser('fl-stranger'), 'stranger', ALL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('retry-then-classify', () => {
  it('retries a failed required job once on the same job and tree; a pass on attempt 2 records a flake and counts as passed', async () => {
    const { feature } = await ciChange('retry-pass', ci([{ name: 'test', run: 'npm test', required: true }]));
    const first = await claim('retry-pass', 'runner-a');
    expect(first.json.job).toMatchObject({ name: 'test', generation: 1, sha: feature.sha, treeSha: feature.tree });

    const failed = await reportJob('retry-pass', first.json.job, 'failure', 'runner-a');
    expect(failed.status).toBe(200);
    expect(failed.json.run).toMatchObject({ name: 'test', status: 'failure', attempt: 1 });
    expect(failed.json.retry).toMatchObject({ attempt: 2, runId: expect.any(String) });
    expect(failed.json.flake).toBeNull();
    expect(failed.cost.d1).toBeLessThanOrEqual(2);
    expect(await jobsOf('retry-pass')).toBe(1);
    expect(await runsNamed('retry-pass', 'test')).toBe(2);

    // A runner that reports twice cannot schedule a second retry: the job already left `running`.
    const duplicate = await reportJob('retry-pass', first.json.job, 'failure', 'runner-a');
    expect([duplicate.status, duplicate.json.code]).toEqual([409, 'STALE_GENERATION']);
    expect(await runsNamed('retry-pass', 'test')).toBe(2);

    // The retry is the newest run: the head is pending, not failed.
    const pending = await status('retry-pass', feature.sha);
    expect(pending.json.state).toBe('pending');
    expect(pending.json.checks.find((r: any) => r.name === 'test')).toMatchObject({ attempt: 2, status: 'queued', id: failed.json.retry.runId });
    expect((await mergeability('retry-pass')).json.mergeability.checks.state).toBe('pending');
    expect((await merge('retry-pass')).json.code).toBe('REQUIRED_CHECKS_PENDING');
    // The superseded runner attempt stays runner-owned evidence.
    const patched = await call('PATCH', `${R('retry-pass')}/check-runs/${failed.json.run.id}`, tok.owner, { conclusion: 'success' });
    expect([patched.status, patched.json.code]).toEqual([403, 'RESERVED_CHECK_RUN']);

    const second = await claim('retry-pass', 'runner-b');
    expect(second.json.job).toMatchObject({ id: first.json.job.id, name: 'test', generation: 2, sha: feature.sha, treeSha: feature.tree });
    expect((await status('retry-pass', feature.sha)).json.checks.find((r: any) => r.name === 'test')).toMatchObject({ attempt: 2, status: 'running' });
    const stale = await reportJob('retry-pass', first.json.job, 'success', 'runner-a');
    expect([stale.status, stale.json.code]).toEqual([409, 'STALE_GENERATION']);

    const passed = await reportJob('retry-pass', second.json.job, 'success', 'runner-b');
    expect(passed.status).toBe(200);
    expect(passed.json.run).toMatchObject({ id: failed.json.retry.runId, status: 'success', attempt: 2 });
    expect(passed.json.retry).toBeNull();
    expect(passed.json.flake).toMatchObject({ id: expect.any(String) });
    expect(passed.cost.d1).toBeLessThanOrEqual(2);
    expect((await reportJob('retry-pass', second.json.job, 'success', 'runner-b')).status).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM check_flakes WHERE repo_id = ?', repoIds['retry-pass'])).toBe(1);

    const listed = await flakesOf('retry-pass');
    expect(listed.status).toBe(200);
    expect(listed.json).toMatchObject({ quarantines: [], nextCursor: null });
    expect(listed.json.flakes).toEqual([
      {
        id: passed.json.flake.id,
        check: 'test',
        treeSha: feature.tree,
        headSha: feature.sha,
        change: 1,
        failedRunId: failed.json.run.id,
        passedRunId: failed.json.retry.runId,
        quarantined: false,
        createdAt: expect.any(String),
      },
    ]);
    expect(listed.cost.d1).toBeLessThanOrEqual(2);
    expect(listed.cost.do).toBe(0);

    expect((await status('retry-pass', feature.sha)).json.state).toBe('success');
    const merged = await merge('retry-pass');
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
  });

  it('fails twice: no third attempt, no flake entry, and the failure blocks as before', async () => {
    const { feature } = await ciChange('retry-fail', ci([{ name: 'test', run: 'npm test', required: true }]));
    const first = await claim('retry-fail');
    expect((await reportJob('retry-fail', first.json.job, 'failure')).json.retry).not.toBeNull();
    const second = await claim('retry-fail');
    expect(second.json.job).toMatchObject({ id: first.json.job.id, generation: 2 });
    const failedAgain = await reportJob('retry-fail', second.json.job, 'failure');
    expect(failedAgain.json.run).toMatchObject({ attempt: 2, status: 'failure' });
    expect(failedAgain.json.retry).toBeNull();
    expect(failedAgain.json.flake).toBeNull();

    expect((await claim('retry-fail')).status).toBe(204);
    expect(await jobsOf('retry-fail')).toBe(1);
    expect(await runsNamed('retry-fail', 'test')).toBe(2);
    expect((await flakesOf('retry-fail')).json.flakes).toEqual([]);
    expect((await status('retry-fail', feature.sha)).json.state).toBe('failure');
    const refused = await merge('retry-fail');
    expect([refused.status, refused.json.code]).toEqual([409, 'REQUIRED_CHECKS_FAILED']);
  });

  it('never retries a non-required job or a quarantined check', async () => {
    const config = ci([
      { name: 'test', run: 'npm test', required: true },
      { name: 'optional', run: 'exit 1', required: false },
    ]);
    const repo = await seedRepo('no-retry');
    expect((await quarantine('no-retry', 'test', { reason: 'known flaky' })).status).toBe(200);
    const main = await commit(repo, { ...BASE, '.kvarm/ci.json': config });
    const feature = await commit(repo, { ...BASE, '.kvarm/ci.json': config, 'n.txt': 'n\n' }, [main.sha]);
    repo.refs.set(MAIN, main.sha);
    repo.refs.set(FEATURE, feature.sha);
    expect((await call('POST', `${R('no-retry')}/changes`, tok.owner, { title: 't', base: 'main', head: 'feature' })).status).toBe(201);

    for (const name of ['test', 'optional']) {
      const job = await claim('no-retry');
      expect(job.json.job.name).toBe(name);
      const r = await reportJob('no-retry', job.json.job, 'failure');
      expect(r.json.retry).toBeNull();
    }
    expect((await claim('no-retry')).status).toBe(204);
    expect(await runsNamed('no-retry', 'test')).toBe(1);
    expect(await runsNamed('no-retry', 'optional')).toBe(1);

    // Quarantined: it ran and failed, but it is neutral and blocks nothing.
    const st = await status('no-retry', feature.sha);
    expect(st.json.state).toBe('success');
    expect(st.json.checks.find((r: any) => r.name === 'test')).toMatchObject({ status: 'failure', quarantined: true, required: true });
    const m = (await mergeability('no-retry')).json.mergeability.checks;
    expect(m.state).toBe('success');
    expect(m.required.map((c: any) => c.name)).not.toContain('test');
    expect(m.quarantined).toEqual([expect.objectContaining({ name: 'test', state: 'failure', quarantined: true })]);
    expect((await merge('no-retry')).status).toBe(200);
  });
});

describe('quarantine and restore', () => {
  it('admins quarantine and restore with audit rows; others are refused by the shared policy', async () => {
    await seedRepo('q-authz');
    const anonymous = await quarantine('q-authz', 'test', {}, '');
    expect(anonymous.status).toBe(401);
    expect((await quarantine('q-authz', 'test', {}, tok.stranger)).status).toBe(404);
    expect((await quarantine('q-authz', 'test', {}, tok.reader)).json.code).toBe('FORBIDDEN');
    expect((await quarantine('q-authz', 'test', {}, tok.writer)).status).toBe(403);
    expect((await call('GET', `${R('q-authz')}/flakes`)).status).toBe(404);
    expect((await flakesOf('q-authz', '', tok.stranger)).status).toBe(404);

    expect((await quarantine('q-authz', 'kvarm/guard')).json.code).toBe('RESERVED_CHECK_NAME');
    expect((await quarantine('q-authz', 'test', { expiresAt: new Date(Date.now() - 1000).toISOString() })).json.code).toBe('INVALID_EXPIRY');
    expect((await quarantine('q-authz', 'test', { expiresAt: new Date(Date.now() + 91 * 86_400_000).toISOString() })).json.code).toBe('INVALID_EXPIRY');
    expect((await quarantine('q-authz', 'test', { reason: 'x'.repeat(501) })).json.code).toBe('INVALID_REASON');

    const before = Date.now();
    const q = await quarantine('q-authz', 'unit/js', { reason: 'times out on shared runners' });
    expect(q.status).toBe(200);
    expect(q.json.quarantine).toMatchObject({ check: 'unit/js', reason: 'times out on shared runners', quarantinedBy: OWNER });
    const ttl = Date.parse(q.json.quarantine.expiresAt) - before;
    expect(ttl).toBeGreaterThanOrEqual(FLAKE_LIMITS.defaultTtlMs - 5_000);
    expect(ttl).toBeLessThanOrEqual(FLAKE_LIMITS.defaultTtlMs + 5_000);
    expect(q.cost.d1).toBeLessThanOrEqual(2);
    expect(q.cost.do).toBe(0);

    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const again = await quarantine('q-authz', 'unit/js', { reason: 'still flaky', expiresAt: until });
    expect(again.json.quarantine).toMatchObject({ check: 'unit/js', reason: 'still flaky', expiresAt: until });

    const read = await flakesOf('q-authz', '', tok.reader);
    expect(read.status).toBe(200);
    expect(read.json.quarantines).toEqual([expect.objectContaining({ check: 'unit/js', reason: 'still flaky' })]);

    expect((await restore('q-authz', 'unit/js', tok.writer)).status).toBe(403);
    expect((await restore('q-authz', 'unit/js', '')).status).toBe(401);
    const restored = await restore('q-authz', 'unit/js');
    expect(restored.status).toBe(200);
    expect(restored.json).toMatchObject({ restored: true, quarantine: { check: 'unit/js' } });
    expect(restored.cost.d1).toBeLessThanOrEqual(2);
    const missing = await restore('q-authz', 'unit/js');
    expect([missing.status, missing.json.code]).toEqual([404, 'NOT_QUARANTINED']);
    expect((await flakesOf('q-authz')).json.quarantines).toEqual([]);

    const events =
      (
        await env.DB.prepare(`SELECT type, payload FROM events WHERE type LIKE 'check.%' AND json_extract(payload, '$.repoId') = ? ORDER BY created_at, rowid`)
          .bind(repoIds['q-authz'])
          .all<{ type: string; payload: string }>()
      ).results ?? [];
    expect(events.map((e) => [e.type, JSON.parse(e.payload).check, JSON.parse(e.payload).actor])).toEqual([
      ['check.quarantined', 'unit/js', OWNER],
      ['check.quarantined', 'unit/js', OWNER],
      ['check.restored', 'unit/js', OWNER],
    ]);
    expect(JSON.parse(events[1]!.payload)).toMatchObject({ reason: 'still flaky', expiresAt: until, repo: `${OWNER}/q-authz` });
  });

  it('caps active quarantines per repository and pages flakes with a cursor', async () => {
    await seedRepo('q-cap');
    const id = repoIds['q-cap']!;
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: FLAKE_LIMITS.quarantinesMax }, (_, i) =>
        env.DB.prepare('INSERT INTO check_quarantines (repo_id, name, quarantined_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(id, `c${i}`, OWNER, now, now + 60_000),
      ),
    );
    const over = await quarantine('q-cap', 'one-more');
    expect([over.status, over.json.code]).toEqual([422, 'TOO_MANY_QUARANTINES']);
    // Re-quarantining a listed check is an update, not a new row; an expired row frees its slot.
    expect((await quarantine('q-cap', 'c0')).status).toBe(200);
    await env.DB.prepare('UPDATE check_quarantines SET expires_at = ? WHERE repo_id = ? AND name = ?').bind(now - 1, id, 'c1').run();
    expect((await quarantine('q-cap', 'one-more')).status).toBe(200);

    await env.DB.batch(
      Array.from({ length: 5 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO check_flakes (id, repo_id, name, tree_sha, head_sha, change_set_id, failed_run_id, passed_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), id, i % 2 ? 'odd' : 'even', 'a'.repeat(40), 'b'.repeat(40), crypto.randomUUID(), crypto.randomUUID(), now - i * 1000),
      ),
    );
    const page1 = await flakesOf('q-cap', '?limit=2');
    expect(page1.json.flakes).toHaveLength(2);
    expect(page1.json.quarantines).toHaveLength(FLAKE_LIMITS.quarantinesMax);
    const page2 = await flakesOf('q-cap', `?limit=2&cursor=${encodeURIComponent(page1.json.nextCursor)}`);
    const page3 = await flakesOf('q-cap', `?limit=2&cursor=${encodeURIComponent(page2.json.nextCursor)}`);
    expect([...page1.json.flakes, ...page2.json.flakes, ...page3.json.flakes].map((f: any) => f.createdAt)).toEqual(
      [0, 1, 2, 3, 4].map((i) => new Date(now - i * 1000).toISOString()),
    );
    expect(page3.json.nextCursor).toBeNull();
    expect((await flakesOf('q-cap', '?check=odd')).json.flakes.map((f: any) => f.check)).toEqual(['odd', 'odd']);
    expect((await flakesOf('q-cap', '?cursor=nope')).json.code).toBe('INVALID_CURSOR');
    expect((await flakesOf('q-cap', '?limit=101')).json.code).toBe('INVALID_LIMIT');
  });
});

describe('quarantine in the checks gate', () => {
  it('a branch rule naming a quarantined check still requires it; restore and expiry make the failure block again', async () => {
    const { ruleIds } = await ciChange('q-gate', ci([{ name: 'test', run: 'npm test', required: true }]), [{ pattern: 'main' }]);
    const setRule = (requiredChecks: string[]) => call('PATCH', `${R('q-gate')}/branch-rules/${ruleIds[0]}`, tok.owner, { requiredChecks });
    for (let i = 0; i < 2; i++) {
      const job = await claim('q-gate');
      await reportJob('q-gate', job.json.job, 'failure');
    }
    expect((await merge('q-gate')).json.code).toBe('REQUIRED_CHECKS_FAILED');

    expect((await quarantine('q-gate', 'test')).status).toBe(200);
    expect((await mergeability('q-gate')).json.mergeability.checks.state).toBe('success');

    // Fail-closed: the rule names the check, so the quarantined failure still refuses the merge.
    expect((await setRule(['test'])).status).toBe(200);
    const ruled = await merge('q-gate');
    expect([ruled.status, ruled.json.code]).toEqual([409, 'REQUIRED_CHECKS_FAILED']);
    expect((await setRule([])).status).toBe(200);

    expect((await restore('q-gate', 'test')).status).toBe(200);
    expect((await merge('q-gate')).json.code).toBe('REQUIRED_CHECKS_FAILED');

    expect((await quarantine('q-gate', 'test')).status).toBe(200);
    await env.DB.prepare('UPDATE check_quarantines SET expires_at = ? WHERE repo_id = ?').bind(Date.now() - 1, repoIds['q-gate']).run();
    expect((await merge('q-gate')).json.code).toBe('REQUIRED_CHECKS_FAILED');
    expect((await flakesOf('q-gate')).json.quarantines).toEqual([]);

    expect((await quarantine('q-gate', 'test')).status).toBe(200);
    const merged = await merge('q-gate');
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
  });
});

describe('the integration train', () => {
  function trainDeps(): TrainDeps {
    return { ...defaultTrainDeps, kick: async () => {} };
  }

  /** A change of `name` forked from main's current head, enqueued. */
  async function queued(repoName: string, repo: FakeRepo, files: Files, branch: string) {
    const head = await commit(repo, files, [repo.refs.get(MAIN)!]);
    repo.refs.set(`refs/heads/${branch}`, head.sha);
    const created = await call('POST', `${R(repoName)}/changes`, tok.owner, { title: branch, base: 'main', head: branch, mergePolicy: 'review' });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return { number: created.json.number as number, head };
  }

  it('publishes a flake-passed change and a quarantined failure; a check that failed twice ejects', async () => {
    const config = ci([{ name: 'test', run: 'npm test', required: true }]);
    const repo = await seedRepo('q-train');
    const main = await commit(repo, { ...BASE, '.kvarm/ci.json': config });
    repo.refs.set(MAIN, main.sha);
    const files = (extra: string): Files => ({ ...BASE, '.kvarm/ci.json': config, [`${extra}.txt`]: `${extra}\n` });

    const flaky = await queued('q-train', repo, files('flaky'), 'flaky');
    const one = await claim('q-train');
    await reportJob('q-train', one.json.job, 'failure');
    const two = await claim('q-train');
    expect((await reportJob('q-train', two.json.job, 'success')).json.flake).not.toBeNull();
    expect((await call('POST', `${R('q-train')}/changes/${flaky.number}/enqueue`, tok.owner)).status).toBe(201);
    const run1 = await runTrain(env, repoIds['q-train']!, MAIN, trainDeps());
    expect(run1.ejected).toEqual([]);
    expect(run1.published).toEqual([flaky.number]);

    expect((await quarantine('q-train', 'test')).status).toBe(200);
    const quiet = await queued('q-train', repo, files('quiet'), 'quiet');
    const failing = await claim('q-train');
    expect((await reportJob('q-train', failing.json.job, 'failure')).json.retry).toBeNull();
    expect((await call('POST', `${R('q-train')}/changes/${quiet.number}/enqueue`, tok.owner)).status).toBe(201);
    const run2 = await runTrain(env, repoIds['q-train']!, MAIN, trainDeps());
    expect(run2.ejected).toEqual([]);
    expect(run2.published).toEqual([quiet.number]);
    expect((await restore('q-train', 'test')).status).toBe(200);

    const broken = await queued('q-train', repo, files('broken'), 'broken');
    for (let i = 0; i < 2; i++) await reportJob('q-train', (await claim('q-train')).json.job, 'failure');
    expect((await call('POST', `${R('q-train')}/changes/${broken.number}/enqueue`, tok.owner)).status).toBe(201);
    const run3 = await runTrain(env, repoIds['q-train']!, MAIN, trainDeps());
    expect(run3.ejected).toEqual([{ number: broken.number, code: 'CHECKS_FAILED' }]);
    expect(run3.published).toEqual([]);
  });

  it('retries a composed-tree job on the same composed commit; the pass publishes that tree', async () => {
    const config = ci([{ name: 'test', run: 'npm test', required: true }]);
    const repo = await seedRepo('q-compose');
    const files: Files = { ...BASE, '.kvarm/ci.json': config };
    const fork = await commit(repo, files);
    repo.refs.set(MAIN, fork.sha);
    const change = await queued('q-compose', repo, { ...files, 'f1.txt': 'one\n' }, 'b1');
    // The head's own job passes first.
    const headJob = await claim('q-compose');
    expect(headJob.json.job.sha).toBe(change.head.sha);
    await reportJob('q-compose', headJob.json.job, 'success');
    const moved = await commit(repo, { ...files, 'other.txt': 'other\n' }, [fork.sha]);
    repo.refs.set(MAIN, moved.sha);
    expect((await call('POST', `${R('q-compose')}/changes/${change.number}/enqueue`, tok.owner)).status).toBe(201);

    const prepared = await runTrain(env, repoIds['q-compose']!, MAIN, trainDeps());
    expect(prepared.published).toEqual([]);
    const composed = await claim('q-compose');
    expect(composed.json.job.sha).not.toBe(change.head.sha);
    const failed = await reportJob('q-compose', composed.json.job, 'failure');
    expect(failed.json.retry).not.toBeNull();

    const held = await runTrain(env, repoIds['q-compose']!, MAIN, trainDeps());
    expect(held.ejected).toEqual([]);
    expect(held.published).toEqual([]);
    const retried = await claim('q-compose');
    expect(retried.json.job).toMatchObject({ id: composed.json.job.id, sha: composed.json.job.sha, treeSha: composed.json.job.treeSha, generation: 2 });
    const passed = await reportJob('q-compose', retried.json.job, 'success');
    expect(passed.json.flake).not.toBeNull();
    const flakes = (await flakesOf('q-compose')).json.flakes;
    expect(flakes).toEqual([expect.objectContaining({ check: 'test', treeSha: composed.json.job.treeSha, headSha: composed.json.job.sha, change: change.number })]);

    const published = await runTrain(env, repoIds['q-compose']!, MAIN, trainDeps());
    expect(published.ejected).toEqual([]);
    expect(published.published).toEqual([change.number]);
  });
});
