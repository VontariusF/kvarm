/**
 * Candidate comparison and ranking, arenas and composition
 * (services/candidates.ts, services/compositions.ts) through the Worker's
 * routes, the git gate and the push queue, over the in-memory Artifacts
 * fake. Overlap comes from the Nexus index the push consumer maintains.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_PACK, ZERO_OID, pktLine, readPktLines } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { getRepoById } from '../src/db/repos';
import { deleteRepo } from '../src/repos/service';
import { compose, defaultComposeDeps, type ComposeContext, type ComposeDeps } from '../src/services/compositions';
import type { ChecksGate } from '../src/services/checksGate';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, writeTree, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api', 'ci'];
const OWNER = 'cand-owner';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

const tok = { owner: '', outsider: '' };
let ownerId = '';

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(crypto.randomUUID(), OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  return repo;
}

interface Reply {
  status: number;
  text: string;
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
  return { status: res.status, text, json, cost: cost! };
}

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const createWs = (repo: string, task: string) => call('POST', `${R(repo)}/workspaces`, tok.owner, { task, agent: 'agent' });
const cands = (repo: string, ids: string[], token: string | undefined = tok.owner, base = 'main') =>
  call('GET', `${R(repo)}/candidates?base=${base}&workspaces=${ids.join(',')}`, token);
const workspaceTokens = new Map<string, string>();

async function workspaceToken(repo: string): Promise<string> {
  const cached = workspaceTokens.get(repo);
  if (cached) return cached;
  const agent = await call('POST', '/api/v1/agents', tok.owner, { name: `push-${repo}` });
  expect(agent.status).toBe(201);
  const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, {
    repo: `${OWNER}/${repo}`,
    role: 'write',
    refs: ['refs/heads/agents/*'],
  });
  expect(minted.status).toBe(201);
  const token = minted.json.token as string;
  workspaceTokens.set(repo, token);
  return token;
}

async function gitPush(repo: string, token: string, cmds: string[]): Promise<string[]> {
  const parts = cmds.map((c, i) => pktLine(i === 0 ? `${c}\0report-status agent=git/2.47\n` : `${c}\n`));
  const needsPack = cmds.some((c) => c.split(' ')[1] !== ZERO_OID);
  const body = new Blob([...parts, new TextEncoder().encode('0000'), ...(needsPack ? [EMPTY_PACK] : [])]);
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}/${OWNER}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`x:${token}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
    body: new Uint8Array(await body.arrayBuffer()),
  });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const buf = new Uint8Array(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return readPktLines(buf)
    .filter((p) => !p.flush)
    .map((p) => new TextDecoder().decode(p.data).trim());
}

let clock = Date.now();

async function deliver(repoName: string, ref: string, before: string, after: string): Promise<void> {
  const body = {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repoName}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date((clock += 1000)).toISOString() },
  };
  const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}

/** Pushes `files` as a commit on `from` to the workspace ref and reconciles its observed paths. */
async function push(repoName: string, repo: FakeRepo, ws: Record<string, any>, from: string, files: Files): Promise<string> {
  const c = await commit(repo, files, [from]);
  expect(await gitPush(repoName, await workspaceToken(repoName), [`${from} ${c.sha} ${ws.ref}`])).toEqual(['unpack ok', `ok ${ws.ref}`]);
  await deliver(repoName, ws.ref, from, c.sha);
  return c.sha;
}

const APP = (line5: string) => ['a1', 'a2', 'a3', 'a4', line5, 'a6', 'a7', 'a8', 'a9', 'a10'].join('\n') + '\n';
const SHARED = (first: string, last: string) => [first, 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', last].join('\n') + '\n';
const BASE: Files = { 'README.md': 'readme\n', 'src/app.ts': APP('a5'), 'src/shared.ts': SHARED('s1', 's10'), 'docs/guide.md': 'guide\n' };

async function based(repo: FakeRepo, files: Files = BASE) {
  const main = await commit(repo, files);
  repo.refs.set('refs/heads/main', main.sha);
  return main;
}

const PLANTED = `token=${'kvarm_pat_' + 'b'.repeat(64)}\n`;

/** `dev` = main + a planted secret: a branch a workspace may start from while its change opens against main. */
async function secretBranch(repo: FakeRepo, mainSha: string) {
  const dev = await commit(repo, { ...BASE, 'secret.txt': PLANTED }, [mainSha]);
  repo.refs.set('refs/heads/dev', dev.sha);
  return dev;
}

beforeAll(async () => {
  installFakeGitRemote();
  ownerId = await seedUser(OWNER);
  tok.owner = (await mintPAT(env, ownerId, 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('cand-outsider'), 'outsider', FULL)).token;
});

afterAll(() => restoreFetch());

/** The ranking-relevant parts of a response, canonicalized (sorted keys). */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );

// ---------------------------------------------------------------------------

describe('candidates', () => {
  it('reports vs-base summaries equal to compare, pairwise diffs, Nexus overlap and a total deterministic ranking', async () => {
    const repo = await seedRepo('cmp');
    const main = await based(repo);
    const a = (await createWs('cmp', 'impl a')).json;
    const b = (await createWs('cmp', 'impl b')).json;
    const c = (await createWs('cmp', 'impl c')).json;
    await push('cmp', repo, a, main.sha, { ...BASE, 'src/a.ts': 'export const a = 1;\n', 'src/shared.ts': SHARED('A1', 's10') });
    await push('cmp', repo, b, main.sha, { ...BASE, 'src/b.ts': 'export const b = 2;\n', 'src/shared.ts': SHARED('s1', 'B10') });
    await push('cmp', repo, c, main.sha, { ...BASE, 'docs/guide.md': 'guide v2\n', 'docs/more.md': 'more\n', 'docs/extra.md': 'x\n' });

    const r = await cands('cmp', [a.id, b.id, c.id]);
    expect(r.status).toBe(200);
    expect(r.json.base).toEqual({ ref: 'main', sha: main.sha, tree: main.tree });
    expect(r.json.candidates.map((x: any) => x.workspace)).toEqual([a.id, b.id, c.id]);
    for (const ws of [a, b, c]) {
      const summary = r.json.candidates.find((x: any) => x.workspace === ws.id);
      const cmp = await call('GET', `${R('cmp')}/compare/main...${ws.ref}`, tok.owner);
      expect(cmp.status).toBe(200);
      expect(summary.vsBase.files.map((f: any) => [f.path, f.status])).toEqual(cmp.json.files.map((f: any) => [f.path, f.status]));
      expect(summary.vsBase.totals).toEqual(cmp.json.totals);
      expect(summary.vsBase.rating).toEqual(cmp.json.rating);
      // No change judged these heads, so the always-required kvarm/guard is pending.
      expect(summary).toMatchObject({ ref: ws.ref, baseMatches: true, checks: { state: 'pending', required: [{ name: 'kvarm/guard', state: 'pending', producer: 'check-runs' }] } });
    }

    const ab = r.json.pairwise.find((p: any) => p.workspaces[0] === a.id && p.workspaces[1] === b.id);
    expect(ab.source).toBe('vs-base');
    expect(ab.files).toEqual([
      { path: 'src/a.ts', status: 'removed', changedBy: ['a'] },
      { path: 'src/b.ts', status: 'added', changedBy: ['b'] },
      { path: 'src/shared.ts', status: 'modified', changedBy: ['a', 'b'] },
    ]);
    expect(r.json.pairwise).toHaveLength(3);

    // Overlap is the Nexus index's: a and b share src/shared.ts.
    expect(r.json.overlap.pairs).toEqual([{ workspaces: [a.id, b.id].sort(), paths: ['src/shared.ts'], pathCount: 1 }]);
    expect(r.json.candidates.find((x: any) => x.workspace === c.id).overlap).toEqual({ with: [], sharedPaths: 0 });

    const ranking = r.json.ranking as any[];
    expect(ranking.map((e) => e.workspace).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(ranking.map((e) => e.rank)).toEqual([1, 2, 3]);
    for (const e of ranking) {
      expect(Object.keys(e.factors).sort()).toEqual(['changedFiles', 'changedLines', 'checks', 'complete', 'failingChecks', 'overlapSharedPaths', 'riskLevel', 'riskScore']);
    }
    expect(r.json.rankingFactors).toEqual(['checks', 'complete', 'riskScore', 'overlapSharedPaths', 'changedLines', 'changedFiles', 'workspace']);
    expect(r.json.truncated).toBe(false);

    // Repeat: byte-identical, tree diffs from the cache (art=0), same D1 count.
    const again = await cands('cmp', [a.id, b.id, c.id]);
    expect(again.text).toBe(r.text);
    expect(again.cost).toMatchObject({ art: 0, do: 0 });
    expect(again.cost.d1).toBe(3);
    const again2 = await cands('cmp', [a.id, b.id, c.id]);
    expect(again2.cost.d1).toBe(again.cost.d1);
  });

  it('pairwise entries under a directory/file replacement are the heads’ actual entries', async () => {
    const repo = await seedRepo('cmp-struct');
    const main = await based(repo);
    const a = (await createWs('cmp-struct', 'docs becomes a file')).json;
    const b = (await createWs('cmp-struct', 'edit the guide')).json;
    const { 'docs/guide.md': _dir, ...rest } = BASE;
    await push('cmp-struct', repo, a, main.sha, { ...rest, docs: 'docs as a file\n' });
    await push('cmp-struct', repo, b, main.sha, { ...BASE, 'docs/guide.md': 'guide v2\n' });

    const r = await cands('cmp-struct', [a.id, b.id]);
    expect(r.status).toBe(200);
    // a has no docs/guide.md at all, so it is never reported as modified between the heads: the
    // difference is the replacement itself, from the real head-to-head tree diff.
    expect(r.json.pairwise).toEqual([
      expect.objectContaining({ source: 'tree-pair', files: [{ path: 'docs', status: 'typechange' }], fileCount: 1, truncated: false }),
    ]);
  });

  it('places a candidate whose required check fails below a passing one', async () => {
    const repo = await seedRepo('ck');
    const main = await based(repo);
    const a = (await createWs('ck', 'a')).json;
    const b = (await createWs('ck', 'b')).json;
    await push('ck', repo, a, main.sha, { ...BASE, 'z.txt': 'zzzzzzzz\nzzzz\n' });
    const bHead = await push('ck', repo, b, main.sha, { ...BASE, 'y.txt': 'y\n' });
    const bTree = (await commit(repo, { ...BASE, 'y.txt': 'y\n' }, [main.sha])).tree;
    const failing: ChecksGate = {
      async requiredChecksFor(_repo, treeSha, configId) {
        const failed = treeSha === bTree;
        return { treeSha, configId, required: [{ name: 'test', state: failed ? 'failure' : 'success', producer: 'ci' }], state: failed ? 'failure' : 'success' };
      },
    };
    const { candidates } = await import('../src/services/candidates');
    const row = await env.DB.prepare('SELECT * FROM repos WHERE artifacts_name = ?').bind(`${OWNER}--ck`).first<any>();
    const ctx = createExecutionContext();
    const r = await candidates(
      { env, repo: row, actor: null, origin: ORIGIN, waitUntil: (p) => ctx.waitUntil(p), gate: failing },
      { base: 'main', workspaces: `${b.id},${a.id}` },
    );
    await waitOnExecutionContext(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bHead).toBeTruthy();
    expect(r.value.ranking.map((e) => e.workspace)).toEqual([a.id, b.id]);
    expect(r.value.ranking[1]!.factors).toMatchObject({ checks: 'failure', failingChecks: ['test'] });
  });

  it('ranks same-head changes by their own guards instead of another change guard', async () => {
    const repo = await seedRepo('ck-same-head');
    const main = await based(repo);
    const shared = await commit(repo, { ...BASE, 'secret.txt': `token=${'kvarm_pat_' + 'a'.repeat(64)}\n` }, [main.sha]);
    repo.refs.set('refs/heads/clean-base', shared.sha);
    const a = (await createWs('ck-same-head', 'a')).json;
    const b = (await call('POST', `${R('ck-same-head')}/workspaces`, tok.owner, { task: 'b', agent: 'agent', base: 'clean-base' })).json;
    repo.refs.set(a.ref, shared.sha);
    await deliver('ck-same-head', a.ref, main.sha, shared.sha);
    for (const ws of [a, b]) {
      const opened = await call('POST', `${R('ck-same-head')}/workspaces/${ws.id}/change-set`, tok.owner, {
        title: ws.task,
        mergePolicy: 'review',
        ...(ws.id === b.id ? { base: 'clean-base' } : {}),
      });
      expect(opened.status).toBe(201);
    }
    const result = await cands('ck-same-head', [a.id, b.id]);
    expect(result.status).toBe(200);
    expect(result.json.candidates.map((c: any) => [c.workspace, c.checks.state])).toEqual([
      [a.id, 'failure'],
      [b.id, 'success'],
    ]);
    expect(result.json.ranking.map((c: any) => c.workspace)).toEqual([b.id, a.id]);
  });

  it('ranks a change by its own base guard when its workspace started on another branch', async () => {
    const name = 'ck-bases';
    const repo = await seedRepo(name);
    const main = await based(repo);
    const dev = await secretBranch(repo, main.sha);
    const x = (await call('POST', `${R(name)}/workspaces`, tok.owner, { task: 'x', agent: 'agent', base: 'dev' })).json;
    const f = (await createWs(name, 'f')).json;
    const p = (await createWs(name, 'p')).json;
    await push(name, repo, x, dev.sha, { ...BASE, 'secret.txt': PLANTED, 'notes.txt': 'clean\n' });
    await push(name, repo, f, main.sha, { ...BASE, 'secret.txt': PLANTED });
    await push(name, repo, p, main.sha, { ...BASE, 'p.txt': 'p\n' });
    // x opens against the default base main, not the dev branch its workspace started from.
    const changeX = await call('POST', `${R(name)}/workspaces/${x.id}/change-set`, tok.owner, { title: 'x' });
    expect([changeX.status, changeX.json.base]).toEqual([201, 'main']);
    expect((await call('POST', `${R(name)}/workspaces/${f.id}/change-set`, tok.owner, { title: 'f' })).status).toBe(201);
    const run = (await call('GET', `${R(name)}/changes/${changeX.json.number}/checks`, tok.owner)).json.checks[0];
    expect(run).toMatchObject({ name: 'kvarm/guard', status: 'failure', summary: { baseTree: main.tree } });

    const r = await cands(name, [x.id, f.id, p.id]);
    expect(r.status).toBe(200);
    const sx = r.json.candidates.find((c: any) => c.workspace === x.id);
    expect(sx).toMatchObject({ workspaceBase: 'dev', checks: { state: 'failure', required: [{ name: 'kvarm/guard', state: 'failure' }] } });
    const ranking = r.json.ranking as any[];
    expect(ranking[0]).toMatchObject({ workspace: p.id, factors: { checks: 'pending', failingChecks: [] } });
    expect(ranking.slice(1).map((e) => e.workspace).sort()).toEqual([x.id, f.id].sort());
    for (const e of ranking.slice(1)) expect(e.factors).toMatchObject({ checks: 'failure', failingChecks: ['kvarm/guard'] });

    const merge = await call('POST', `${R(name)}/changes/${changeX.json.number}/merge`, tok.owner);
    expect([merge.status, merge.json.code]).toEqual([409, 'REQUIRED_CHECKS_FAILED']);
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);

    // Same request shape as every other candidate set: authority, the workspace batch, one coalesced gate read.
    expect((await cands(name, [x.id, f.id, p.id])).cost).toMatchObject({ d1: 3, art: 0, do: 0 });
  });

  it('answers pending, never success, when the recorded guard judged another base than the ranking plan', async () => {
    const name = 'ck-moved-base';
    const repo = await seedRepo(name);
    const main = await based(repo);
    const dev = await secretBranch(repo, main.sha);
    const x = (await call('POST', `${R(name)}/workspaces`, tok.owner, { task: 'x', agent: 'agent', base: 'dev' })).json;
    await push(name, repo, x, dev.sha, { ...BASE, 'secret.txt': PLANTED, 'notes.txt': 'clean\n' });
    expect((await call('POST', `${R(name)}/workspaces/${x.id}/change-set`, tok.owner, { title: 'x' })).status).toBe(201);
    // main fast-forwards to dev: the publication plan's merge base is now dev's tip, which the guard never judged.
    repo.refs.set('refs/heads/main', dev.sha);
    await deliver(name, 'refs/heads/main', main.sha, dev.sha);
    const r = await cands(name, [x.id]);
    expect(r.status).toBe(200);
    expect(r.json.candidates[0].checks).toMatchObject({ state: 'pending', required: [{ name: 'kvarm/guard', state: 'pending' }] });
    expect(r.json.ranking[0].factors).toMatchObject({ checks: 'pending', failingChecks: [] });
  });

  it('bounds the request: caps, malformed and unknown ids, inactive workspaces excluded, concealment', async () => {
    const repo = await seedRepo('bounds');
    const main = await based(repo);
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push((await createWs('bounds', `w${i}`)).json.id);
    const tooMany = await cands('bounds', ids);
    expect([tooMany.status, tooMany.json.code, tooMany.json.limit, tooMany.json.requested]).toEqual([422, 'TOO_MANY_CANDIDATES', 8, 9]);
    expect(tooMany.json.error).toMatch(/at most 8/);
    expect(tooMany.cost.art).toBe(0);
    expect((await call('GET', `${R('bounds')}/candidates?base=main`, tok.owner)).json.code).toBe('INVALID_WORKSPACES');
    expect((await cands('bounds', ['BAD!'])).json.code).toBe('INVALID_WORKSPACES');
    expect((await cands('bounds', [ids[0]!, ids[0]!])).json.code).toBe('DUPLICATE_WORKSPACES');
    const unknown = await cands('bounds', [ids[0]!, 'feedfeedfeedfeed']);
    expect([unknown.status, unknown.json.code, unknown.json.workspaces]).toEqual([404, 'WORKSPACE_NOT_FOUND', ['feedfeedfeedfeed']]);
    expect((await cands('bounds', [ids[0]!], tok.outsider)).status).toBe(404);
    expect((await cands('bounds', [ids[0]!], tok.owner, 'nope')).json.code).toBe('REF_NOT_FOUND');

    expect((await call('POST', `${R('bounds')}/workspaces/${ids[1]}/abandon`, tok.owner)).status).toBe(200);
    const eight = await cands('bounds', ids.slice(0, 8));
    expect(eight.status).toBe(200);
    expect(eight.json.candidates).toHaveLength(7);
    expect(eight.json.excluded).toEqual([{ workspace: ids[1], status: 'abandoned', reason: 'workspace is abandoned' }]);
    expect(eight.json.ranking).toHaveLength(7);
    expect(eight.json.pairwise).toHaveLength(21);
    expect(main.sha).toBeTruthy();
  });

  it('keeps D1 constant and rows read sub-quadratic as the candidate set grows', async () => {
    const repo = await seedRepo('scale');
    const main = await based(repo);
    const ws: Array<Record<string, any>> = [];
    for (let i = 0; i < 8; i++) {
      const w = (await createWs('scale', `s${i}`)).json;
      await push('scale', repo, w, main.sha, { ...BASE, 'src/shared.ts': SHARED(`x${i}`, 's10'), [`own/${i}.ts`]: `${i}\n` });
      ws.push(w);
    }
    const ids = ws.map((w) => w.id);
    await cands('scale', ids.slice(0, 4));
    await cands('scale', ids);
    const four = await cands('scale', ids.slice(0, 4));
    const eight = await cands('scale', ids);
    expect(eight.json.overlap.pairs).toHaveLength(28);
    // Authority, the workspace + overlap batch, and one coalesced checks-gate read for every candidate.
    expect([four.cost.d1, four.cost.art, four.cost.do]).toEqual([3, 0, 0]);
    expect([eight.cost.d1, eight.cost.art, eight.cost.do]).toEqual([3, 0, 0]);
    expect(eight.cost.rr).toBeLessThan(four.cost.rr * 4);
  });
});

describe('arenas', () => {
  it('creates 2-8 candidate workspaces at the base and refuses other counts with no side effects', async () => {
    const repo = await seedRepo('arena');
    const main = await based(repo);
    const made = await call('POST', `${R('arena')}/arenas`, tok.owner, { brief: 'Refactor auth module', base: 'main', candidates: 3 });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ brief: 'Refactor auth module', base: 'main', baseSha: main.sha, state: 'open', candidates: 3, selection: null });
    expect(made.json.workspaces).toHaveLength(3);
    for (const w of made.json.workspaces) {
      expect(w.ref).toMatch(new RegExp(`^refs/heads/agents/${w.id}/refactor-auth-module$`));
      expect(repo.refs.get(w.ref)).toBe(main.sha);
      expect(w).toMatchObject({ status: 'active', base: 'main', baseSha: main.sha, arena: made.json.id, pushUrl: `${ORIGIN}/${OWNER}/arena.git` });
    }
    const got = await call('GET', `${R('arena')}/arenas/${made.json.id}`, tok.owner);
    expect(got.json).toEqual(made.json);

    const pushesBefore = repo.count('receivePack:');
    for (const n of [1, 9, 0, 2.5, '3']) {
      const r = await call('POST', `${R('arena')}/arenas`, tok.owner, { brief: 'x', candidates: n });
      expect([r.status, r.json.code]).toEqual([422, 'INVALID_CANDIDATES']);
    }
    expect((await call('POST', `${R('arena')}/arenas`, tok.owner, { candidates: 3 })).json.code).toBe('INVALID_BRIEF');
    expect(repo.count('receivePack:')).toBe(pushesBefore);
    const list = await call('GET', `${R('arena')}/arenas`, tok.owner);
    expect(list.json.arenas.map((x: any) => x.id)).toEqual([made.json.id]);
    expect((await call('GET', `${R('arena')}/workspaces`, tok.owner)).json.workspaces).toHaveLength(3);

    for (const n of [2, 8]) {
      const r = await call('POST', `${R('arena')}/arenas`, tok.owner, { brief: `b${n}`, candidates: n });
      expect(r.status).toBe(201);
      expect(r.json.workspaces).toHaveLength(n);
    }
    expect((await call('GET', `${R('arena')}/arenas`, tok.owner)).json.arenas).toHaveLength(3);
    expect((await call('GET', `${R('arena')}/arenas/nope`, tok.owner)).json.code).toBe('ARENA_NOT_FOUND');
    expect((await call('GET', `${R('arena')}/arenas/${made.json.id}`, tok.outsider)).status).toBe(404);
    expect((await call('POST', `${R('arena')}/arenas`, tok.outsider, { brief: 'x', candidates: 2 })).status).toBe(404);
  });

  it('leaves no rows when a candidate ref cannot be created', async () => {
    const repo = await seedRepo('arena-fault');
    await based(repo);
    repo.receivePackStatus = 503;
    const r = await call('POST', `${R('arena-fault')}/arenas`, tok.owner, { brief: 'x', candidates: 2 });
    expect([r.status, r.json.code]).toEqual([502, 'REF_CREATE_FAILED']);
    repo.receivePackStatus = null;
    expect((await call('GET', `${R('arena-fault')}/arenas`, tok.owner)).json.arenas).toEqual([]);
    expect((await call('GET', `${R('arena-fault')}/workspaces`, tok.owner)).json.workspaces).toEqual([]);
  });

  it('ranks arena candidates without the overlap factor, reports duplication separately, and only records a selection', async () => {
    const repo = await seedRepo('arena-rank');
    const main = await based(repo);
    const arena = (await call('POST', `${R('arena-rank')}/arenas`, tok.owner, { brief: 'speed up parser', candidates: 3 })).json;
    const [a, b, c] = arena.workspaces;
    await push('arena-rank', repo, a, main.sha, { ...BASE, 'src/app.ts': APP('fast'), 'src/a.ts': 'a\n' });
    await push('arena-rank', repo, b, main.sha, { ...BASE, 'src/app.ts': APP('faster'), 'src/b.ts': 'b\n' });
    await push('arena-rank', repo, c, main.sha, { ...BASE, 'docs/c.md': 'c\n' });

    const r = await call('GET', `${R('arena-rank')}/arenas/${arena.id}/candidates`, tok.owner);
    expect(r.status).toBe(200);
    expect(r.json.arena).toBe(arena.id);
    expect(r.json.candidates.map((x: any) => x.workspace)).toEqual([a.id, b.id, c.id]);
    for (const ws of [a, b, c]) {
      const cmp = await call('GET', `${R('arena-rank')}/compare/main...${ws.ref}`, tok.owner);
      const s = r.json.candidates.find((x: any) => x.workspace === ws.id);
      expect(s.vsBase.files.map((f: any) => [f.path, f.status])).toEqual(cmp.json.files.map((f: any) => [f.path, f.status]));
      expect(s.overlap).toBeUndefined();
    }
    expect(r.json.ranking).toHaveLength(3);
    for (const e of r.json.ranking) expect(e.factors.overlapSharedPaths).toBeUndefined();
    expect(r.json.rankingFactors).not.toContain('overlapSharedPaths');
    expect(r.json.overlap).toBeUndefined();
    expect(r.json.duplication).toMatchObject({
      source: 'nexus-index',
      minSharedPaths: 1,
      pairs: [{ workspaces: [a.id, b.id].sort(), paths: ['src/app.ts'], pathCount: 1 }],
      truncated: false,
    });
    const again = await call('GET', `${R('arena-rank')}/arenas/${arena.id}/candidates`, tok.owner);
    expect(canonical(again.json)).toBe(canonical(r.json));
    expect(again.cost).toMatchObject({ art: 0, do: 0, d1: 4 });

    // Selection is a recorded choice: nothing merges, closes or abandons.
    const changeA = (await call('POST', `${R('arena-rank')}/workspaces/${a.id}/change-set`, tok.owner, { title: 'a' })).json;
    const changeB = (await call('POST', `${R('arena-rank')}/workspaces/${b.id}/change-set`, tok.owner, { title: 'b' })).json;
    const sel = await call('POST', `${R('arena-rank')}/arenas/${arena.id}/select`, tok.owner, { workspace: a.id });
    expect(sel.status).toBe(200);
    expect(sel.json).toMatchObject({ state: 'selected', selection: { selectedWorkspace: a.id, selectedBy: { login: OWNER, agent: null } } });
    expect(sel.json.selection.selectedAt).toEqual(expect.any(String));
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect((await call('GET', `${R('arena-rank')}/changes/${changeA.number}`, tok.owner)).json.state).toBe('open');
    expect((await call('GET', `${R('arena-rank')}/arenas/${arena.id}`, tok.owner)).json.selection.selectedWorkspace).toBe(a.id);
    expect((await call('POST', `${R('arena-rank')}/arenas/${arena.id}/select`, tok.owner, { workspace: 'feedfeed' })).json.code).toBe('NOT_ARENA_CANDIDATE');

    // A final selection escalates to a human; the winner's merge waits until one acts.
    const waiting = await call('POST', `${R('arena-rank')}/changes/${changeA.number}/merge`, tok.owner);
    expect([waiting.status, waiting.json.code, waiting.json.review?.openEscalations]).toEqual([409, 'ESCALATION_OPEN', ['final-selection']]);
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    const packet = (await call('GET', `${R('arena-rank')}/changes/${changeA.number}/reviews`, tok.owner)).json;
    const finalSel = packet.escalations.find((e: any) => e.reason === 'final-selection');
    expect(finalSel).toMatchObject({ state: 'open', openedBy: 'system' });
    expect((await call('POST', `${R('arena-rank')}/changes/${changeA.number}/escalations/${finalSel.id}/resolve`, tok.owner, {})).status).toBe(200);

    // The winner merges through its change set; losers stay live (B edited the same file, so it now conflicts), then one is abandoned.
    const merged = await call('POST', `${R('arena-rank')}/changes/${changeA.number}/merge`, tok.owner);
    expect(merged.status).toBe(200);
    expect((await call('GET', `${R('arena-rank')}/changes/${changeB.number}`, tok.owner)).json.state).toBe('conflicted');
    expect((await call('GET', `${R('arena-rank')}/workspaces/${c.id}`, tok.owner)).json.status).toBe('active');
    const ab = await call('POST', `${R('arena-rank')}/workspaces/${b.id}/abandon`, tok.owner);
    expect([ab.status, ab.json.status]).toEqual([200, 'abandoned']);
    const after = await call('GET', `${R('arena-rank')}/arenas/${arena.id}/candidates`, tok.owner);
    expect(after.json.excluded.map((x: any) => [x.workspace, x.status])).toEqual([
      [a.id, 'merged'],
      [b.id, 'abandoned'],
    ]);
  });

  it('ranks an arena candidate by its change base guard when the arena started on another branch', async () => {
    const name = 'arena-bases';
    const repo = await seedRepo(name);
    const main = await based(repo);
    const dev = await secretBranch(repo, main.sha);
    const arena = (await call('POST', `${R(name)}/arenas`, tok.owner, { brief: 'tidy notes', base: 'dev', candidates: 2 })).json;
    const [x, y] = arena.workspaces;
    expect([x.base, y.base]).toEqual(['dev', 'dev']);
    await push(name, repo, x, dev.sha, { ...BASE, 'secret.txt': PLANTED, 'notes.txt': 'clean\n' });
    await push(name, repo, y, dev.sha, { ...BASE, 'secret.txt': PLANTED, 'y.txt': 'y\n' });
    const changeX = await call('POST', `${R(name)}/workspaces/${x.id}/change-set`, tok.owner, { title: 'x' });
    expect([changeX.status, changeX.json.base]).toEqual([201, 'main']);
    const run = (await call('GET', `${R(name)}/changes/${changeX.json.number}/checks`, tok.owner)).json.checks[0];
    expect(run).toMatchObject({ name: 'kvarm/guard', status: 'failure', summary: { baseTree: main.tree } });

    const r = await call('GET', `${R(name)}/arenas/${arena.id}/candidates`, tok.owner);
    expect(r.status).toBe(200);
    expect(r.json.candidates.map((c: any) => [c.workspace, c.checks.state])).toEqual([
      [x.id, 'failure'],
      // No linked change: nothing judged y, so its always-required guard stays pending.
      [y.id, 'pending'],
    ]);
    expect(r.json.ranking.map((e: any) => [e.workspace, e.factors.checks, e.factors.failingChecks])).toEqual([
      [y.id, 'pending', []],
      [x.id, 'failure', ['kvarm/guard']],
    ]);
    expect((await call('GET', `${R(name)}/arenas/${arena.id}/candidates`, tok.owner)).cost).toMatchObject({ d1: 4, art: 0, do: 0 });
  });
});

describe('composition', () => {
  async function setup(name: string, aFiles: Files, bFiles: Files) {
    const repo = await seedRepo(name);
    const main = await based(repo);
    const a = (await createWs(name, 'a')).json;
    const b = (await createWs(name, 'b')).json;
    await push(name, repo, a, main.sha, aFiles);
    await push(name, repo, b, main.sha, bFiles);
    return { repo, main, a, b };
  }

  it('composes disjoint candidates into a composed workspace with a change set', async () => {
    const aFiles = { ...BASE, 'src/a.ts': 'export const a = 1;\n' };
    const bFiles = { ...BASE, 'docs/b.md': 'b docs\n' };
    const { repo, main, a, b } = await setup('compose', aFiles, bFiles);
    const r = await call('POST', `${R('compose')}/candidates/compose`, tok.owner, { base: 'main', workspaces: [a.id, b.id] });
    expect(r.status).toBe(201);
    const expectedTree = await writeTree(repo, { ...BASE, 'src/a.ts': 'export const a = 1;\n', 'docs/b.md': 'b docs\n' });
    expect(r.json).toMatchObject({
      base: 'main',
      baseSha: main.sha,
      treeSha: expectedTree,
      conflict: null,
      checks: { state: 'success', required: [{ name: 'kvarm/guard', state: 'success', producer: 'check-runs' }] },
      sources: [
        { workspace: a.id, mergeBase: main.sha, paths: null },
        { workspace: b.id, mergeBase: main.sha, paths: null },
      ],
    });
    expect(r.json.changeSet).toEqual(expect.any(Number));
    // Budget row "POST …/candidates/compose (clean)": d1 ≤ 8, sub ≤ 3.
    expect(r.cost.d1, JSON.stringify(r.cost)).toBeLessThanOrEqual(8);
    expect(r.cost.sub).toBeLessThanOrEqual(3);
    expect(r.json.workspace).toMatchObject({ status: 'active', base: 'main', changeSet: r.json.changeSet });
    expect(repo.refs.get(r.json.workspace.ref)).toBe(r.json.commitSha);
    // The composed workspace's head is the composed commit, not the base, before its push event is consumed.
    expect(r.json.workspace.headSha).toBe(r.json.commitSha);
    expect(r.json.workspace.baseSha).toBe(main.sha);

    const read = await call('GET', `${R('compose')}/compositions/${r.json.id}`, tok.owner);
    expect(read.json).toEqual(r.json);
    const listed = (await call('GET', `${R('compose')}/workspaces`, tok.owner)).json.workspaces.find((w: any) => w.id === r.json.workspace.id);
    expect(listed.headSha).toBe(r.json.commitSha);
    const cmp = await call('GET', `${R('compose')}/compare/main...${r.json.workspace.ref}`, tok.owner);
    expect(cmp.json.files.map((f: any) => f.path)).toEqual(['docs/b.md', 'src/a.ts']);
    expect(cmp.json.head.tree).toBe(expectedTree);
    const change = await call('GET', `${R('compose')}/changes/${r.json.changeSet}`, tok.owner);
    expect(change.json).toMatchObject({ state: 'open', mergePolicy: 'review', headSha: r.json.commitSha });
    expect((await call('GET', `${R('compose')}/compositions`, tok.owner)).json.compositions.map((x: any) => x.id)).toEqual([r.json.id]);
  });

  it('reports an incompatible selection and creates nothing; a partially compatible pair names only the conflicting path', async () => {
    const { repo, a, b } = await setup(
      'compose-x',
      { ...BASE, 'src/app.ts': APP('A5'), 'src/shared.ts': SHARED('A1', 's10') },
      { ...BASE, 'src/app.ts': APP('B5'), 'src/shared.ts': SHARED('s1', 'B10') },
    );
    const refs = new Map(repo.refs);
    const pushes = repo.count('receivePack:');
    const r = await call('POST', `${R('compose-x')}/candidates/compose`, tok.owner, { workspaces: [a.id, b.id] });
    expect([r.status, r.json.code, r.json.conflictKind]).toEqual([409, 'COMPOSITION_CONFLICT', 'textual']);
    expect(r.json.incompatible).toEqual(['src/app.ts']);
    expect(r.json.conflicts).toEqual([{ workspace: b.id, with: [a.id], path: 'src/app.ts', kind: 'content', paths: ['src/app.ts'], hunks: 1 }]);
    expect(r.json.error).toEqual(expect.any(String));
    expect(repo.count('receivePack:')).toBe(pushes);
    expect(repo.refs).toEqual(refs);
    expect((await call('GET', `${R('compose-x')}/compositions`, tok.owner)).json.compositions).toEqual([]);
    expect((await call('GET', `${R('compose-x')}/workspaces`, tok.owner)).json.workspaces).toHaveLength(2);

    // Selecting only the compatible path of a composes cleanly.
    const ok = await call('POST', `${R('compose-x')}/candidates/compose`, tok.owner, {
      workspaces: [{ workspace: a.id, paths: ['src/shared.ts'] }, b.id],
    });
    expect(ok.status).toBe(201);
    expect(ok.json.treeSha).toBe(await writeTree(repo, { ...BASE, 'src/app.ts': APP('B5'), 'src/shared.ts': SHARED('A1', 'B10') }));
    expect(ok.json.sources[0]).toMatchObject({ workspace: a.id, paths: ['src/shared.ts'] });

    const unmatched = await call('POST', `${R('compose-x')}/candidates/compose`, tok.owner, {
      workspaces: [a.id, b.id],
      paths: { [a.id]: ['docs/'] },
    });
    expect([unmatched.status, unmatched.json.code, unmatched.json.unmatched]).toEqual([422, 'SELECTION_UNMATCHED', [{ workspace: a.id, path: 'docs/' }]]);
  });

  it('composes a candidate that criss-crosses the base through a virtual merge base', async () => {
    const name = 'compose-cc';
    const repo = await seedRepo(name);
    const main0 = await based(repo);
    const a = (await createWs(name, 'a')).json;
    const b = (await createWs(name, 'b')).json;
    // main and workspace a each merge the same two commits, in opposite orders: their merge bases are x1 and x2.
    const x1 = await commit(repo, { ...BASE, 'src/app.ts': APP('X1') }, [main0.sha]);
    const x2 = await commit(repo, { ...BASE, 'docs/guide.md': 'guide x2\n' }, [main0.sha]);
    const merged = { ...BASE, 'src/app.ts': APP('X1'), 'docs/guide.md': 'guide x2\n' };
    const mainM = await commit(repo, merged, [x1.sha, x2.sha]);
    repo.refs.set('refs/heads/main', mainM.sha);
    const aHead = await commit(repo, { ...merged, 'src/a.ts': 'a\n' }, [x2.sha, x1.sha]);
    expect(await gitPush(name, await workspaceToken(name), [`${main0.sha} ${aHead.sha} ${a.ref}`])).toEqual(['unpack ok', `ok ${a.ref}`]);
    await deliver(name, a.ref, main0.sha, aHead.sha);
    const bHead = await commit(repo, { ...merged, 'docs/b.md': 'b\n' }, [mainM.sha]);
    expect(await gitPush(name, await workspaceToken(name), [`${main0.sha} ${bHead.sha} ${b.ref}`])).toEqual(['unpack ok', `ok ${b.ref}`]);
    await deliver(name, b.ref, main0.sha, bHead.sha);

    const r = await call('POST', `${R(name)}/candidates/compose`, tok.owner, { base: 'main', workspaces: [a.id, b.id] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // Budget row "POST …/candidates/compose (clean)" holds with the virtual merge base: its reads go to Artifacts, not D1.
    expect(r.cost.d1, JSON.stringify(r.cost)).toBeLessThanOrEqual(8);
    expect(r.cost.sub).toBeLessThanOrEqual(3);
    expect(r.json.treeSha).toBe(await writeTree(repo, { ...merged, 'src/a.ts': 'a\n', 'docs/b.md': 'b\n' }));
    expect(r.json.sources).toMatchObject([
      { workspace: a.id, mergeBase: [x1.sha, x2.sha].sort()[0], mergeBases: [x1.sha, x2.sha].sort() },
      { workspace: b.id, mergeBase: mainM.sha },
    ]);
  });

  it('validates input before any work', async () => {
    const { a, b } = await setup('compose-v', { ...BASE, 'x.txt': 'x\n' }, { ...BASE, 'y.txt': 'y\n' });
    const post = (body: unknown) => call('POST', `${R('compose-v')}/candidates/compose`, tok.owner, body);
    expect((await post({ workspaces: [a.id] })).json.code).toBe('INVALID_COMPOSITION');
    expect((await post({ workspaces: Array.from({ length: 9 }, (_, i) => `w${i}`) })).json.code).toBe('INVALID_COMPOSITION');
    expect((await post({ workspaces: [a.id, a.id] })).json.code).toBe('INVALID_COMPOSITION');
    expect((await post({ workspaces: [a.id, b.id], paths: { [a.id]: ['../x'] } })).json.code).toBe('INVALID_PATHS');
    expect((await post({ workspaces: [a.id, b.id], mergePolicy: 'yolo' })).json.code).toBe('INVALID_MERGE_POLICY');
    expect((await post({ workspaces: [a.id, 'feedfeed'] })).json.code).toBe('WORKSPACE_NOT_FOUND');
    expect((await call('POST', `${R('compose-v')}/candidates/compose`, tok.outsider, { workspaces: [a.id, b.id] })).status).toBe(404);
    await call('POST', `${R('compose-v')}/workspaces/${b.id}/abandon`, tok.owner);
    expect((await post({ workspaces: [a.id, b.id] })).json.code).toBe('WORKSPACE_NOT_ACTIVE');
  });

  it('reports a clean composition whose required check fails as a semantic conflict on the composed tree', async () => {
    const { repo, a, b } = await setup('compose-sem', { ...BASE, 'x.txt': 'x\n' }, { ...BASE, 'y.txt': 'y\n' });
    const composedTree = await writeTree(repo, { ...BASE, 'x.txt': 'x\n', 'y.txt': 'y\n' });
    const asked: string[] = [];
    const gate: ChecksGate = {
      async requiredChecksFor(_repo, treeSha, configId) {
        asked.push(treeSha);
        const failed = treeSha === composedTree;
        return { treeSha, configId, required: [{ name: 'test', state: failed ? 'failure' : 'success', producer: 'ci' }], state: failed ? 'failure' : 'success' };
      },
    };
    const row = await env.DB.prepare('SELECT * FROM repos WHERE artifacts_name = ?').bind(`${OWNER}--compose-sem`).first<any>();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ownerId).first<any>();
    const ctx = createExecutionContext();
    const cx: ComposeContext = { env, repo: row, actor: { user, via: 'pat', scopes: FULL }, origin: ORIGIN, waitUntil: (p) => ctx.waitUntil(p), gate };
    const r = await compose(cx, { workspaces: [a.id, b.id] });
    await waitOnExecutionContext(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(asked).toContain(composedTree);
    expect(r.value.treeSha).toBe(composedTree);
    expect(r.value.conflict).toEqual({ kind: 'semantic', checks: ['test'], treeSha: composedTree });
    expect(r.value.checks.state).toBe('failure');
    const read = await call('GET', `${R('compose-sem')}/compositions/${r.value.id}`, tok.owner);
    expect(read.json.conflict).toEqual({ kind: 'semantic', checks: ['test'], treeSha: composedTree });
  });

  it('records a runner failure on the exact composed tree as a semantic conflict and blocks merge (VAL-COMPOSE-003)', async () => {
    const ci = `${JSON.stringify({ jobs: [{ name: 'semantic', run: 'test ! -f a.txt -o ! -f b.txt', required: true }] })}\n`;
    const base = { ...BASE, '.kvarm/ci.json': ci };
    const repo = await seedRepo('compose-ci');
    const main = await based(repo, base);
    const a = (await createWs('compose-ci', 'a')).json;
    const b = (await createWs('compose-ci', 'b')).json;
    await push('compose-ci', repo, a, main.sha, { ...base, 'a.txt': 'a\n' });
    await push('compose-ci', repo, b, main.sha, { ...base, 'b.txt': 'b\n' });

    const composed = await call('POST', `${R('compose-ci')}/candidates/compose`, tok.owner, {
      base: 'main',
      workspaces: [a.id, b.id],
      mergePolicy: 'review',
    });
    expect(composed.status).toBe(201);
    expect(composed.json.checks.state).toBe('pending');
    expect(composed.json.checks.required.find((c: any) => c.name === 'semantic')).toMatchObject({
      name: 'semantic',
      state: 'pending',
      producer: 'check-runs',
    });
    // A required failure is retried once on the same composed tree; failing again makes it a semantic conflict.
    for (const attempt of [1, 2]) {
      const claim = await call('POST', `${R('compose-ci')}/ci/jobs/claim`, tok.owner, { runnerId: 'compose-runner' });
      expect(claim.json.job).toMatchObject({ name: 'semantic', sha: composed.json.commitSha, treeSha: composed.json.treeSha });
      const report = await call('POST', `${R('compose-ci')}/ci/jobs/${claim.json.job.id}/report`, tok.owner, {
        runnerId: 'compose-runner',
        generation: claim.json.job.generation,
        conclusion: 'failure',
        summary: { exitCode: 1 },
      });
      expect(report.status).toBe(200);
      expect(report.json.run.attempt).toBe(attempt);
      if (attempt === 1) {
        expect(report.json.retry).not.toBeNull();
        expect((await call('GET', `${R('compose-ci')}/compositions/${composed.json.id}`, tok.owner)).json.conflict).toBeNull();
      }
    }

    const read = await call('GET', `${R('compose-ci')}/compositions/${composed.json.id}`, tok.owner);
    expect(read.json.conflict).toEqual({ kind: 'semantic', checks: ['semantic'], treeSha: composed.json.treeSha });
    expect(read.json.checks.state).toBe('failure');
    const merge = await call('POST', `${R('compose-ci')}/changes/${composed.json.changeSet}/merge`, tok.owner);
    expect([merge.status, merge.json.code]).toEqual([409, 'REQUIRED_CHECKS_FAILED']);
    expect(merge.json.error).toContain('semantic');
  });

  it('a composed workspace joins the Nexus index even when its push event is consumed before it is registered', async () => {
    const { a, b } = await setup('compose-nx', { ...BASE, 'x.txt': 'x\n' }, { ...BASE, 'y.txt': 'y\n' });
    const row = await env.DB.prepare('SELECT * FROM repos WHERE artifacts_name = ?').bind(`${OWNER}--compose-nx`).first<any>();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ownerId).first<any>();
    const consumed: string[] = [];
    const deps: ComposeDeps = {
      ...defaultComposeDeps,
      pusher: (e, r) => {
        const real = defaultComposeDeps.pusher(e, r);
        return {
          ...real,
          updateRef: async (u, objects) => {
            const res = await real.updateRef(u, objects);
            // The push consumer handles the composed ref's event before the workspace row exists.
            if (res.status === 'ok') {
              await deliver('compose-nx', u.ref, u.oldOid, u.newOid);
              consumed.push(u.ref);
            }
            return res;
          },
        };
      },
    };
    const ctx = createExecutionContext();
    const cx: ComposeContext = { env, repo: row, actor: { user, via: 'pat', scopes: FULL }, origin: ORIGIN, waitUntil: (p) => ctx.waitUntil(p) };
    const r = await compose(cx, { workspaces: [a.id, b.id] }, deps);
    await waitOnExecutionContext(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ws = r.value.workspace!;
    expect(consumed).toEqual([ws.ref]);
    const skipped = await env.DB.prepare(
      `SELECT x.detail FROM push_event_effects x JOIN push_events p ON p.id = x.event_id
        WHERE p.repo_id = ? AND p.ref = ? AND x.effect = 'intent-index'`,
    )
      .bind(row.id, ws.ref)
      .first<{ detail: string }>();
    expect(skipped?.detail).toMatch(/no workspace/);

    const intent = await call('GET', `${R('compose-nx')}/workspaces/${ws.id}/intent`, tok.owner);
    expect(intent.json).toMatchObject({ observedPaths: ['x.txt', 'y.txt'], headSha: r.value.commitSha, observedCurrent: true });
    const f = await call('GET', `${R('compose-nx')}/forecast?paths=y.txt`, tok.owner);
    expect(f.json.matches.map((m: any) => m.workspace).sort()).toEqual([b.id, ws.id].sort());
    const o = await call('GET', `${R('compose-nx')}/workspaces/overlap?base=main`, tok.owner);
    expect(o.json.pairs.map((p: any) => p.workspaces.join(':')).sort()).toEqual(
      [[a.id, ws.id].sort().join(':'), [b.id, ws.id].sort().join(':')].sort(),
    );

    // A later push to the composed workspace still moves the observed set forward.
    const repo = fakeRepos.get(`${OWNER}--compose-nx`)!;
    const next = await push('compose-nx', repo, ws, r.value.commitSha, { ...BASE, 'x.txt': 'x\n', 'y.txt': 'y\n', 'z.txt': 'z\n' });
    expect((await call('GET', `${R('compose-nx')}/workspaces/${ws.id}/intent`, tok.owner)).json).toMatchObject({
      observedPaths: ['x.txt', 'y.txt', 'z.txt'],
      headSha: next,
    });
  });

  it('a composed workspace whose Nexus seed read fails once discloses an incomplete index until a later push reconciles it', async () => {
    const { a, b } = await setup('compose-seedfail', { ...BASE, 'x.txt': 'x\n' }, { ...BASE, 'y.txt': 'y\n' });
    const repo = fakeRepos.get(`${OWNER}--compose-seedfail`)!;
    const row = await env.DB.prepare('SELECT * FROM repos WHERE artifacts_name = ?').bind(`${OWNER}--compose-seedfail`).first<any>();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ownerId).first<any>();
    const failed: string[] = [];
    const deps: ComposeDeps = {
      ...defaultComposeDeps,
      pusher: (e, r) => {
        const real = defaultComposeDeps.pusher(e, r);
        return {
          ...real,
          updateRef: async (u, objects) => {
            const res = await real.updateRef(u, objects);
            if (res.status === 'ok') {
              // The early event is consumed before registration, then the seed's first storage read fails once.
              await deliver('compose-seedfail', u.ref, u.oldOid, u.newOid);
              repo.hook = async (call) => {
                if (failed.length === 0 && call.startsWith('readCommit:')) {
                  failed.push(call);
                  throw new Error('storage unavailable');
                }
              };
            }
            return res;
          },
        };
      },
    };
    const ctx = createExecutionContext();
    const cx: ComposeContext = { env, repo: row, actor: { user, via: 'pat', scopes: FULL }, origin: ORIGIN, waitUntil: (p) => ctx.waitUntil(p) };
    const r = await compose(cx, { workspaces: [a.id, b.id] }, deps);
    await waitOnExecutionContext(ctx);
    repo.hook = null;
    expect(failed).toHaveLength(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ws = r.value.workspace!;
    expect(r.value.changeSet).toEqual(expect.any(Number));

    const intent = (await call('GET', `${R('compose-seedfail')}/workspaces/${ws.id}/intent`, tok.owner)).json;
    expect(intent).toMatchObject({ observedPaths: [], observedTruncated: true, observedCurrent: false });
    expect(intent.observedTruncatedReason).toMatch(/seed/);
    const f = (await call('GET', `${R('compose-seedfail')}/forecast?paths=y.txt`, tok.owner)).json;
    expect(f.matches.map((m: any) => m.workspace)).toEqual([b.id]);
    expect(f.truncated).toBe(true);
    expect(f.incomplete).toEqual([{ workspace: ws.id, reason: expect.stringMatching(/seed/) }]);
    const o = (await call('GET', `${R('compose-seedfail')}/workspaces/overlap?base=main`, tok.owner)).json;
    expect(o.truncated).toBe(true);
    expect(o.incomplete).toEqual([{ workspace: ws.id, reason: expect.stringMatching(/seed/) }]);

    // A later push reconciles the observed set and clears the disclosure.
    const next = await push('compose-seedfail', repo, ws, r.value.commitSha, { ...BASE, 'x.txt': 'x\n', 'y.txt': 'y\n', 'z.txt': 'z\n' });
    expect((await call('GET', `${R('compose-seedfail')}/workspaces/${ws.id}/intent`, tok.owner)).json).toMatchObject({
      observedPaths: ['x.txt', 'y.txt', 'z.txt'],
      headSha: next,
      observedTruncated: false,
    });
    const after = (await call('GET', `${R('compose-seedfail')}/forecast?paths=y.txt`, tok.owner)).json;
    expect(after.matches.map((m: any) => m.workspace).sort()).toEqual([b.id, ws.id].sort());
    expect([after.truncated, after.incomplete]).toEqual([false, undefined]);
  });
});

describe('repo delete', () => {
  it('removes arenas and compositions with the repo', async () => {
    const repo = await seedRepo('cand-del');
    const main = await based(repo);
    const arena = (await call('POST', `${R('cand-del')}/arenas`, tok.owner, { brief: 'x', candidates: 2 })).json;
    const [a, b] = arena.workspaces;
    await push('cand-del', repo, a, main.sha, { ...BASE, 'x.txt': 'x\n' });
    await push('cand-del', repo, b, main.sha, { ...BASE, 'y.txt': 'y\n' });
    expect((await call('POST', `${R('cand-del')}/candidates/compose`, tok.owner, { workspaces: [a.id, b.id] })).status).toBe(201);
    const id = (await env.DB.prepare('SELECT id FROM repos WHERE artifacts_name = ?').bind(`${OWNER}--cand-del`).first<{ id: string }>())!.id;
    expect((await deleteRepo(env, (await getRepoById(env.DB, id))!)).ok).toBe(true);
    for (const t of ['arenas', 'compositions', 'workspaces']) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE repo_id = ?`).bind(id).first<{ n: number }>())!.n).toBe(0);
    }
  });
});
