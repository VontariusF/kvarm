/**
 * Snapshots (architecture §11.5): SnapshotBuilder steps over an in-memory
 * Artifacts and the local R2 bucket, and the snapshot API.
 *
 * The builder runs through a test step runner that persists every step result
 * the way Workflows does (streams re-read from stored bytes, JSON round
 * trips) and can retry a step, so replay and interruption are exercised on
 * the real step bodies.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { snapshotInstanceId } from '../src/services/events';
import { matchSnapshot, snapshotCacheKey, streamAndStore } from '../src/cache/snapshot';
import {
  BLOBS_PER_STEP,
  READ_AHEAD,
  READ_BUDGET,
  STALE_BUILD_MS,
  buildSnapshot,
  snapshotKey,
  type BuildCost,
  type SnapshotParams,
  type StepRunner,
} from '../src/workflows/snapshotBuilder';
import worker from '../src/index';
import {
  FAKE_STREAM_CHUNK,
  FakeRepo,
  blobHash,
  commit,
  fakeArtifacts,
  fakeRepos,
  installFakeGitRemote,
  lsRefsCalls,
  readTar,
  restoreFetch,
  type Files,
  type TarMember,
} from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'snap-owner';
const FULL: Scope[] = ['read', 'write', 'api'];

// ---------------------------------------------------------------------------
// Workflow fakes
// ---------------------------------------------------------------------------

async function persist<T>(value: T): Promise<T> {
  if (value instanceof ReadableStream) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    return new Blob([bytes]).stream() as T;
  }
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Runs steps like Workflows: results persisted, failed steps retried from the same input. */
class Runner implements StepRunner {
  steps: string[] = [];
  attempts: string[] = [];
  gates = new Map<string, Promise<void>>();
  onAttempt?: (name: string, attempt: number) => void;

  constructor(private readonly retries = 0) {}

  async do<T>(name: string, fn: (ctx?: { attempt: number }) => Promise<T>): Promise<T> {
    await this.gates.get(name);
    this.steps.push(name);
    for (let attempt = 0; ; attempt++) {
      this.attempts.push(name);
      this.onAttempt?.(name, attempt + 1);
      try {
        return await persist(await fn({ attempt: attempt + 1 }));
      } catch (err) {
        // Workflows never retry a NonRetryableError.
        if (attempt >= this.retries || (err as Error).name === 'NonRetryableError') throw err;
      }
    }
  }
}

/** SnapshotBuilder binding: unique instance ids; `drain` runs created instances. */
class FakeBuilder {
  instances = new Map<string, SnapshotParams>();
  creates: string[] = [];
  ran = new Set<string>();
  /** The next N creates fail without creating anything (Workflows outage). */
  failCreates = 0;

  async create(opts: { id: string; params: SnapshotParams }) {
    if (this.failCreates > 0) {
      this.failCreates--;
      throw new Error('workflows: service unavailable');
    }
    if (this.instances.has(opts.id)) throw new Error(`instance.already_exists: ${opts.id}`);
    this.instances.set(opts.id, opts.params);
    this.creates.push(opts.id);
    return { id: opts.id };
  }

  async get(id: string) {
    if (!this.instances.has(id)) throw new Error('instance.not_found');
    return { id };
  }

  async drain(runner = () => new Runner()) {
    for (const [id, params] of this.instances) {
      if (this.ran.has(id)) continue;
      this.ran.add(id);
      await buildSnapshot(env, { ...params, instanceId: id }, runner()).catch(() => undefined);
    }
  }
}

const builder = new FakeBuilder();
const env = {
  ...baseEnv,
  ARTIFACTS: { get: fakeArtifacts.get, delete: async () => true } as unknown as Artifacts,
  SNAPSHOT_BUILDER: builder as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

// ---------------------------------------------------------------------------
// Principals, repos and requests
// ---------------------------------------------------------------------------

const tok = { owner: '', outsider: '' };

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'public'): Promise<{ id: string; repo: FakeRepo }> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  return { id, repo };
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
  bytes: Uint8Array;
  headers: Headers;
  cost: CostCounters;
}

async function call(path: string, opts: { token?: string; method?: string } = {}): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  const req = new Request(`${ORIGIN}${path}`, { method: opts.method ?? 'GET', headers });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    // tar bytes or plain text
  }
  return { status: res.status, json, bytes, headers: res.headers, cost: cost! };
}

const snap = (repo: string, ref: string) => `/api/v1/repos/${OWNER}/${repo}/snapshots/${ref}`;

async function commitRow(repoId: string, sha: string) {
  return env.DB.prepare('SELECT * FROM snapshot_commits WHERE repo_id = ? AND sha = ?')
    .bind(repoId, sha)
    .first<{ state: string; tree: string; reused: number; build_cost: string | null; built_at: number | null; instance_id: string; error: string | null }>();
}

async function objectKeys(repoId: string): Promise<string[]> {
  const list = await env.SNAPSHOTS.list({ prefix: `trees/v1/${repoId}/` });
  return list.objects.map((o) => o.key);
}

/** The object as stored in R2: gzip for every snapshot built now. */
async function storedTarball(repoId: string, tree: string, key = snapshotKey(repoId, tree)): Promise<Uint8Array> {
  const obj = await env.SNAPSHOTS.get(key);
  expect(obj).not.toBeNull();
  return new Uint8Array(await obj!.arrayBuffer());
}

/** Multi-member aware: the builder writes one gzip member per step, and DecompressionStream rejects that. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(gunzipSync(bytes));
}

/** The tar inside the stored gzip object. */
async function tarball(repoId: string, tree: string): Promise<Uint8Array> {
  return gunzip(await storedTarball(repoId, tree));
}

/**
 * Turns a freshly built snapshot into what an earlier release left behind: the
 * plain tar under the `.tar` key, with the tree row pointing at it.
 */
async function downgradeToLegacy(repoId: string, tree: string): Promise<string> {
  const legacyKey = snapshotKey(repoId, tree, 'tar');
  const plain = await tarball(repoId, tree);
  await env.SNAPSHOTS.put(legacyKey, plain, { httpMetadata: { contentType: 'application/x-tar' } });
  await env.SNAPSHOTS.delete(snapshotKey(repoId, tree));
  await env.DB.prepare('UPDATE snapshot_trees SET r2_key = ?, size = ? WHERE repo_id = ? AND tree = ?')
    .bind(legacyKey, plain.length, repoId, tree)
    .run();
  return legacyKey;
}

/** Text that gzip cannot shrink much, so size-driven multipart behavior still happens. */
function noise(length: number): string {
  const raw = new Uint8Array(Math.ceil((length * 3) / 4));
  for (let off = 0; off < raw.length; off += 65536) crypto.getRandomValues(raw.subarray(off, off + 65536));
  let text = '';
  for (let off = 0; off < raw.length; off += 32768) text += btoa(String.fromCharCode(...raw.subarray(off, off + 32768)));
  return text.slice(0, length);
}

/** What a checkout of `files` contains: every file, symlink and (implied) directory. */
function expectedMembers(files: Files): Map<string, { type: string; mode: number; data?: string; linkname?: string }> {
  const out = new Map<string, { type: string; mode: number; data?: string; linkname?: string }>();
  for (const [path, spec] of Object.entries(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) out.set(parts.slice(0, i).join('/'), { type: 'dir', mode: 0o755 });
    const { content, mode } = typeof spec === 'string' || spec instanceof Uint8Array ? { content: spec, mode: '100644' } : spec;
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    if (mode === '120000') out.set(path, { type: 'symlink', mode: 0o777, linkname: text });
    else out.set(path, { type: 'file', mode: mode === '100755' ? 0o755 : 0o644, data: text });
  }
  return out;
}

function checkTar(members: TarMember[], files: Files): void {
  const want = expectedMembers(files);
  expect(new Set(members.map((m) => m.path))).toEqual(new Set(want.keys()));
  expect(members.length).toBe(want.size);
  for (const m of members) {
    const w = want.get(m.path)!;
    expect({ path: m.path, type: m.type, mode: m.mode }).toEqual({ path: m.path, type: w.type, mode: w.mode });
    if (w.type === 'file') expect(new TextDecoder().decode(m.data)).toBe(w.data);
    if (w.type === 'symlink') expect(m.linkname).toBe(w.linkname);
  }
  // Pre-order: every directory precedes its contents.
  const seen = new Set<string>();
  for (const m of members) {
    const parent = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : null;
    if (parent) expect(seen.has(parent), `${parent} before ${m.path}`).toBe(true);
    seen.add(m.path);
  }
}

const longName = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'n'.repeat(120)}.txt`;
const SMALL: Files = {
  'README.md': '# snap\n',
  'bin/run.sh': { content: '#!/bin/sh\necho run\n', mode: '100755' },
  'docs/résumé-日本.md': 'unicode\n',
  'docs/empty.txt': '',
  'link': { content: 'README.md', mode: '120000' },
  [longName]: 'deep file\n',
};

/** One `{cost, workflow: 'snapshot-builder', …}` line per step attempt. */
interface StepLog {
  cost: CostCounters;
  workflow: string;
  instance: string;
  step: string;
  outcome: 'ok' | 'failed';
  error?: string;
  /** Counters of the statement that stores buildCost, which buildCost cannot include. */
  excluded?: Partial<Record<'d1' | 'rr' | 'rw', number>>;
  /** R2 key of a finished tarball removed because its repo was deleted mid-build. */
  discarded?: string;
}

/** Runs `fn` and returns the builder's step-attempt log lines for `instance`. */
async function builderLogs(instance: string, fn: () => Promise<unknown>): Promise<StepLog[]> {
  const lines: unknown[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args[0]);
  });
  try {
    await fn().catch(() => undefined);
  } finally {
    spy.mockRestore();
  }
  const out: StepLog[] = [];
  for (const line of lines) {
    if (typeof line !== 'string' || !line.startsWith('{')) continue;
    const parsed = JSON.parse(line) as StepLog;
    if (parsed.workflow === 'snapshot-builder' && parsed.instance === instance) out.push(parsed);
  }
  return out;
}

/** The stored counters are exactly the completed step attempts' metered work, less the excluded store. */
function expectStoredMatchesLogs(cost: BuildCost, logs: StepLog[]): void {
  const ok = logs.filter((l) => l.outcome === 'ok');
  expect(cost.steps).toBe(ok.length);
  for (const k of ['d1', 'rr', 'rw', 'art', 'r2a', 'r2b', 'sub'] as const) {
    const sum = ok.reduce((n, l) => n + l.cost[k] - ((l.excluded as Record<string, number> | undefined)?.[k] ?? 0), 0);
    expect(cost[k], k).toBe(sum);
  }
}

/** F files of `size` bytes in 10 directories. */
function manyFiles(count: number, size: number, salt = '', incompressible = false): Files {
  const files: Files = {};
  for (let i = 0; i < count; i++) {
    const head = `file ${i}${salt}\n`;
    const fill = Math.max(0, size - head.length - 1);
    files[`d${i % 10}/f${String(i).padStart(5, '0')}.txt`] = head + (incompressible ? noise(fill) : 'x'.repeat(fill)) + '\n';
  }
  return files;
}

/** R2's minimum part size: lets a few MB of incompressible data span several parts. */
const SMALL_PARTS = { partSize: 5 * 1024 * 1024 };

beforeAll(async () => {
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('snap-outsider'), 'outsider', FULL)).token;
  installFakeGitRemote();
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

describe('SnapshotBuilder', () => {
  it('builds a tar of the commit tree: modes, symlinks, long and unicode paths, empty files', async () => {
    const { id, repo } = await seedRepo('small');
    const c = await commit(repo, SMALL);
    const runner = new Runner();
    let out: Awaited<ReturnType<typeof buildSnapshot>> | undefined;
    const logs = await builderLogs('snap-small', async () => {
      out = await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-small' }, runner);
    });
    expect(out?.outcome).toBe('built');
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'finish']);
    const bytes = await storedTarball(id, c.tree);
    checkTar(readTar(await gunzip(bytes)), SMALL);

    const row = await commitRow(id, c.sha);
    expect(row).toMatchObject({ state: 'ready', tree: c.tree, reused: 0 });
    const cost = JSON.parse(row!.build_cost!) as BuildCost;
    // resolve: repo row + claim batch, get + readCommit; batch: get + 5 trees + 6 blob/symlink reads, one put;
    // finish: the ready transition batch (the batch that stores buildCost is excluded).
    expect(cost).toMatchObject({ steps: 3, d1: 3, art: 2 + 1 + 5 + 6, r2a: 1, r2b: 0, treeReads: 5, blobReads: 6, parts: 0, objects: 1, reused: false });
    expect(cost.bytes).toBe(bytes.length);
    // The stored counters are the measured ones, including the finish transition's rows.
    expect(logs.map((l) => `${l.step}:${l.outcome}`)).toEqual(['resolve:ok', 'batch-1:ok', 'finish:ok']);
    expectStoredMatchesLogs(cost, logs);
    const finish = logs.find((l) => l.step === 'finish')!;
    expect(finish.cost.rw - (finish.excluded?.rw ?? 0)).toBeGreaterThan(0);
    expect(finish.excluded).toMatchObject({ d1: 1 });
    const tree = await env.DB.prepare('SELECT size, files FROM snapshot_trees WHERE repo_id = ? AND tree = ?')
      .bind(id, c.tree)
      .first<{ size: number; files: number }>();
    expect(tree).toEqual({ size: bytes.length, files: 6 });
  });

  it('stores a new snapshot gzip-compressed under a .tar.gz key, smaller than the tar it holds', async () => {
    const { id, repo } = await seedRepo('gz');
    const files = manyFiles(40, 6000, 'gz');
    const c = await commit(repo, files);
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-gz' }, new Runner());
    expect(await objectKeys(id)).toEqual([`trees/v1/${id}/${c.tree}.tar.gz`]);
    const stored = await storedTarball(id, c.tree);
    expect([stored[0], stored[1]]).toEqual([0x1f, 0x8b]);
    const tar = await gunzip(stored);
    checkTar(readTar(tar), files);
    expect(stored.length).toBeLessThan(tar.length / 5);
    const head = await env.SNAPSHOTS.head(snapshotKey(id, c.tree));
    expect(head?.httpMetadata?.contentType).toBe('application/gzip');
    expect(head?.customMetadata).toEqual({ format: 'tar+gzip' });
    const tree = await env.DB.prepare('SELECT r2_key, size FROM snapshot_trees WHERE repo_id = ? AND tree = ?')
      .bind(id, c.tree)
      .first<{ r2_key: string; size: number }>();
    expect(tree).toEqual({ r2_key: snapshotKey(id, c.tree), size: stored.length });
  });

  it('a failed tree rebuilt after a takeover keeps the key its row names: no orphaned object, legacy stays plain tar', async () => {
    const { id, repo } = await seedRepo('gz-rebuild');
    const c = await commit(repo, SMALL);
    const legacyKey = snapshotKey(id, c.tree, 'tar');
    await env.DB.prepare(
      `INSERT INTO snapshot_trees (repo_id, tree, state, builder, r2_key, created_at, error) VALUES (?, ?, 'failed', 'old', ?, ?, 'boom')`,
    )
      .bind(id, c.tree, legacyKey, Date.now())
      .run();
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-gz-rebuild' }, new Runner());
    const row = await env.DB.prepare('SELECT state, r2_key FROM snapshot_trees WHERE repo_id = ? AND tree = ?')
      .bind(id, c.tree)
      .first<{ state: string; r2_key: string }>();
    expect(row).toEqual({ state: 'ready', r2_key: legacyKey });
    expect(await objectKeys(id)).toEqual([legacyKey]);
    const plain = await storedTarball(id, c.tree, legacyKey);
    checkTar(readTar(plain), SMALL);
  });

  it('an R2 part upload failure mid-build fails the step promptly instead of hanging on the compressor', async () => {
    const { id, repo } = await seedRepo('gz-r2down');
    const files = manyFiles(100, 100_000, 'down', true);
    const c = await commit(repo, files);
    const failing = (upload: R2MultipartUpload): R2MultipartUpload =>
      ({
        uploadId: upload.uploadId,
        key: upload.key,
        uploadPart: async () => {
          throw new Error('r2 down');
        },
        abort: () => upload.abort(),
        complete: (parts: R2UploadedPart[]) => upload.complete(parts),
      }) as unknown as R2MultipartUpload;
    const bucket = {
      put: (...a: Parameters<R2Bucket['put']>) => env.SNAPSHOTS.put(...a),
      head: (k: string) => env.SNAPSHOTS.head(k),
      delete: (k: string | string[]) => env.SNAPSHOTS.delete(k),
      createMultipartUpload: async (k: string, o?: R2MultipartOptions) => failing(await env.SNAPSHOTS.createMultipartUpload(k, o)),
      resumeMultipartUpload: (k: string, u: string) => failing(env.SNAPSHOTS.resumeMultipartUpload(k, u)),
    } as unknown as R2Bucket;
    await expect(
      buildSnapshot({ ...env, SNAPSHOTS: bucket }, { repoId: id, sha: c.sha, instanceId: 'snap-gz-r2down' }, new Runner(), SMALL_PARTS),
    ).rejects.toThrow(/r2 down/);
    expect(await commitRow(id, c.sha)).toMatchObject({ state: 'failed' });
  });

  it(`batches about ${BLOBS_PER_STEP} blobs per step and streams multipart parts (steps <= ceil(F/500)+2)`, async () => {
    const { id, repo } = await seedRepo('many');
    const files = manyFiles(1001, 9000, '', true);
    const c = await commit(repo, files);
    const runner = new Runner();
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-many' }, runner, SMALL_PARTS);
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'batch-2', 'batch-3', 'finish']);
    const cost = JSON.parse((await commitRow(id, c.sha))!.build_cost!) as BuildCost;
    expect(cost.steps).toBe(5);
    expect(cost.steps).toBeLessThanOrEqual(Math.ceil(1001 / 500) + 2);
    expect(cost.blobReads).toBe(1001);
    // ~9.3 MB of base64 noise gzips to ~7 MB: parts are cut from the compressed
    // output (one full 5 MiB part plus the tail), carried across three steps
    // and three gzip members, written as one object.
    const bytes = await storedTarball(id, c.tree);
    expect(cost.bytes).toBe(bytes.length);
    expect(bytes.length).toBeGreaterThan(SMALL_PARTS.partSize);
    expect(cost.parts).toBe(Math.ceil(bytes.length / SMALL_PARTS.partSize));
    expect(cost.parts).toBe(2);
    expect(cost.objects).toBe(1);
    expect(cost.r2a).toBe(1 + 2 + 1);
    checkTar(readTar(await gunzip(bytes)), files);
  });

  it('retries an interrupted batch from its persisted input and still writes a correct tar', async () => {
    const { id, repo } = await seedRepo('retry');
    const files = manyFiles(1001, 9000, '-retry', true);
    const c = await commit(repo, files);
    // A blob in the second batch fails once, after that step already uploaded a part.
    const victim = Object.keys(files).sort()[900]!;
    repo.failBlobOnce.add(await blobHash(files[victim] as string));
    const runner = new Runner(2);
    const logs = await builderLogs('snap-retry', () =>
      buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-retry' }, runner, SMALL_PARTS),
    );
    expect(runner.attempts.filter((s) => s.startsWith('batch-')).length).toBe(4);
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'batch-2', 'batch-3', 'finish']);
    checkTar(readTar(await tarball(id, c.tree)), files);
    expect(await objectKeys(id)).toEqual([snapshotKey(id, c.tree)]);

    // The failed attempt's work is logged, not dropped; buildCost holds the completed attempts.
    const failed = logs.filter((l) => l.outcome === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ step: 'batch-2', error: expect.stringMatching(/transient/) });
    expect(failed[0]!.cost.art).toBeGreaterThan(400);
    const cost = JSON.parse((await commitRow(id, c.sha))!.build_cost!) as BuildCost;
    expectStoredMatchesLogs(cost, logs);
    const attempted = logs.reduce((n, l) => n + l.cost.art, 0);
    expect(attempted).toBe(cost.art + failed[0]!.cost.art);
  });

  it('streams each blob into parts within the read-ahead byte budget, no whole-blob copies, complete tar', async () => {
    const { id, repo } = await seedRepo('stream');
    const partSize = 5 * 1024 * 1024; // the R2 minimum part size
    const files = manyFiles(20, 300 * 1024, '-stream', true);
    files['big/large.txt'] = noise(12 * 1024 * 1024);
    files['big/link'] = { content: 'large.txt', mode: '120000' };
    const c = await commit(repo, files);
    const runner = new Runner();
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-stream' }, runner, { partSize });
    // Small blobs are read ahead; the 12 MiB blob is never held together with
    // more than the budget allows.
    expect(repo.maxOpenBlobs).toBeGreaterThan(1);
    expect(repo.maxOpenBlobs).toBeLessThanOrEqual(READ_AHEAD);
    expect(repo.maxOpenBytes).toBeLessThanOrEqual(READ_BUDGET);
    expect(repo.materialized).toBe(0);
    const bytes = await storedTarball(id, c.tree);
    checkTar(readTar(await gunzip(bytes)), files);
    const cost = JSON.parse((await commitRow(id, c.sha))!.build_cost!) as BuildCost;
    expect(cost.bytes).toBe(bytes.length);
    expect(cost.parts).toBe(Math.ceil(bytes.length / partSize));
    expect(cost.parts).toBeGreaterThan(2);
    expect(cost.largestBlob).toBe((files['big/large.txt'] as string).length);
    // Unflushed (compressed) bytes never exceed one part plus one compressor output chunk.
    expect(cost.peakBuffer).toBeLessThan(partSize + FAKE_STREAM_CHUNK + 2048);
    expect(cost.peakHeld).toBeGreaterThanOrEqual(repo.maxOpenBytes);
    expect(cost.peakHeld).toBeLessThanOrEqual(READ_BUDGET);
  });

  it('once blob sizes are known, read-ahead stays within the byte budget', async () => {
    const { id, repo } = await seedRepo('budget');
    const readBudget = 2 * 1024 * 1024;
    const files = manyFiles(6, 768 * 1024, '-budget');
    const c = await commit(repo, files);
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-budget' }, new Runner(), { readBudget });
    // 768 KiB each: two fit in 2 MiB, a third would not.
    expect(repo.maxOpenBlobs).toBe(2);
    expect(repo.maxOpenBytes).toBeLessThanOrEqual(readBudget);
    expect(repo.materialized).toBe(0);
    checkTar(readTar(await tarball(id, c.tree)), files);
    const cost = JSON.parse((await commitRow(id, c.sha))!.build_cost!) as BuildCost;
    expect(cost.peakHeld).toBeGreaterThanOrEqual(repo.maxOpenBytes);
    expect(cost.peakHeld).toBeLessThanOrEqual(readBudget);
  });

  it('a retried batch reads one blob at a time', async () => {
    const { id, repo } = await seedRepo('retry-serial');
    const files = manyFiles(30, 1024, '-retry');
    const c = await commit(repo, files);
    repo.failBlobOnce.add(await blobHash(files['d9/f00019.txt'] as string));
    const runner = new Runner(2);
    const peak: Record<number, number> = {};
    let attempt = 0;
    let base = 0;
    const record = () => {
      if (attempt > 0) peak[attempt] = repo.maxOpenBlobs - base;
    };
    runner.onAttempt = (name, n) => {
      record();
      if (!name.startsWith('batch')) return;
      attempt = n;
      // Blobs read ahead by a failed attempt are never consumed; count from here.
      base = repo.openBlobs;
      repo.maxOpenBlobs = repo.openBlobs;
    };
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-retry-serial' }, runner);
    record();
    expect(runner.attempts.filter((s) => s === 'batch-1')).toHaveLength(2);
    expect(peak[1]).toBeGreaterThan(1);
    expect(peak[2]).toBe(1);
    checkTar(readTar(await tarball(id, c.tree)), files);
  });

  it('a blob the binding cannot buffer (MEMORY_LIMIT) fails the build with that reason, without retries', async () => {
    const { id, repo } = await seedRepo('memlimit');
    const small: Files = {};
    for (let i = 0; i < 10; i++) small[`a/${i}.txt`] = `small ${i}\n`;
    // The refused blob is read ahead behind the small ones.
    const c = await commit(repo, { ...small, 'ok.txt': 'ok\n', 'huge/blob.bin': 'pretend this is huge\n' });
    repo.memoryLimit.add(await blobHash('pretend this is huge\n'));
    const runner = new Runner(3);
    await expect(buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-memlimit' }, runner)).rejects.toThrow(/MEMORY_LIMIT/);
    expect(runner.attempts.filter((s) => s === 'batch-1')).toHaveLength(1);
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'fail']);
    const row = await commitRow(id, c.sha);
    expect(row).toMatchObject({ state: 'failed' });
    expect(row!.error).toMatch(/huge\/blob\.bin/);
    expect(row!.error).toMatch(/MEMORY_LIMIT/);
    expect(await objectKeys(id)).toEqual([]);
  });

  it('a commit with an already-built tree reuses the tarball and keeps its own metadata', async () => {
    const { id, repo } = await seedRepo('reuse');
    const first = await commit(repo, SMALL);
    await buildSnapshot(env, { repoId: id, sha: first.sha, instanceId: 'snap-reuse-1' }, new Runner());
    const second = await commit(repo, SMALL, [first.sha]);
    expect(second.tree).toBe(first.tree);
    const before = repo.count('readBlob');
    const runner = new Runner();
    let out: Awaited<ReturnType<typeof buildSnapshot>> | undefined;
    const logs = await builderLogs('snap-reuse-2', async () => {
      out = await buildSnapshot(env, { repoId: id, sha: second.sha, instanceId: 'snap-reuse-2', trigger: 'demand' }, runner);
    });
    expect(out?.outcome).toBe('done');
    expect(runner.steps).toEqual(['resolve']);
    expect(repo.count('readBlob')).toBe(before);
    expect(await objectKeys(id)).toEqual([snapshotKey(id, first.tree)]);
    const a = await commitRow(id, first.sha);
    const b = await commitRow(id, second.sha);
    expect(b).toMatchObject({ state: 'ready', tree: first.tree, reused: 1 });
    expect(a!.reused).toBe(0);
    const cost = JSON.parse(b!.build_cost!) as BuildCost;
    expect(cost).toMatchObject({ steps: 1, d1: 2, r2a: 0, objects: 0, blobReads: 0, reused: true });
    // The reused commit's own metadata writes are counted.
    expect(cost.rw).toBeGreaterThan(0);
    expectStoredMatchesLogs(cost, logs);
  });

  it('replaying a finished build does nothing', async () => {
    const { id, repo } = await seedRepo('replay');
    const c = await commit(repo, SMALL);
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-replay' }, new Runner());
    const row = await commitRow(id, c.sha);
    const reads = repo.calls.length;
    const runner = new Runner();
    const out = await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-replay' }, runner);
    expect(out).toMatchObject({ outcome: 'done', reason: 'ready' });
    expect(runner.steps).toEqual(['resolve']);
    expect(repo.calls.length - reads).toBe(1); // the commit read only
    expect(await commitRow(id, c.sha)).toEqual(row);
  });

  it('a commit waiting on a tree another instance is building becomes ready when that build finishes', async () => {
    const { id, repo } = await seedRepo('wait');
    const x = await commit(repo, SMALL);
    const y = await commit(repo, SMALL, [x.sha]);
    let release!: () => void;
    const slow = new Runner();
    slow.gates.set('batch-1', new Promise<void>((r) => (release = r)));
    const xBuild = buildSnapshot(env, { repoId: id, sha: x.sha, instanceId: 'snap-wait-x' }, slow);
    await new Promise((r) => setTimeout(r, 50));
    const yOut = await buildSnapshot(env, { repoId: id, sha: y.sha, instanceId: 'snap-wait-y' }, new Runner());
    expect(yOut.reason).toBe('waiting on snap-wait-x');
    expect((await commitRow(id, y.sha))!.state).toBe('building');
    release();
    await xBuild;
    expect(await commitRow(id, y.sha)).toMatchObject({ state: 'ready', reused: 1 });
    expect(await objectKeys(id)).toHaveLength(1);
  });

  it('marks the commit and tree failed when the build cannot finish', async () => {
    const { id, repo } = await seedRepo('broken');
    const c = await commit(repo, { 'a.txt': 'a\n', 'b.txt': 'gone\n' });
    for (const [hash, o] of repo.objects) if (o.type === 'blob' && new TextDecoder().decode(o.content) === 'gone\n') repo.objects.delete(hash);
    const runner = new Runner(1);
    await expect(buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-broken' }, runner)).rejects.toThrow(/not found/);
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'fail']);
    expect(await commitRow(id, c.sha)).toMatchObject({ state: 'failed' });
    const tree = await env.DB.prepare('SELECT state FROM snapshot_trees WHERE repo_id = ? AND tree = ?').bind(id, c.tree).first();
    expect(tree).toEqual({ state: 'failed' });
  });

  it('a commit waiting on a tree fails with that tree build', async () => {
    const { id, repo } = await seedRepo('waitfail');
    const x = await commit(repo, { 'a.txt': 'a\n', 'b.txt': 'doomed\n' });
    const y = await commit(repo, { 'a.txt': 'a\n', 'b.txt': 'doomed\n' }, [x.sha]);
    let release!: () => void;
    const slow = new Runner();
    slow.gates.set('batch-1', new Promise<void>((r) => (release = r)));
    const xBuild = buildSnapshot(env, { repoId: id, sha: x.sha, instanceId: 'snap-waitfail-x' }, slow);
    await new Promise((r) => setTimeout(r, 50));
    const yOut = await buildSnapshot(env, { repoId: id, sha: y.sha, instanceId: 'snap-waitfail-y' }, new Runner());
    expect(yOut.reason).toBe('waiting on snap-waitfail-x');
    for (const [hash, o] of repo.objects) if (o.type === 'blob' && new TextDecoder().decode(o.content) === 'doomed\n') repo.objects.delete(hash);
    release();
    await expect(xBuild).rejects.toThrow(/not found/);
    expect(await commitRow(id, x.sha)).toMatchObject({ state: 'failed' });
    expect(await commitRow(id, y.sha)).toMatchObject({ state: 'failed' });
  });

  it('after a stale takeover, the old attempt failing cannot fail the successor, which then finishes', async () => {
    const { id, repo } = await seedRepo('takeover');
    const c = await commit(repo, { 'a.txt': 'takeover a\n', 'b.txt': 'takeover b\n' });
    repo.refs.set('refs/heads/main', c.sha);
    const base = snapshotInstanceId(id, c.sha);
    let releaseOld!: () => void;
    const oldRunner = new Runner();
    oldRunner.gates.set('batch-1', new Promise<void>((r) => (releaseOld = r)));
    const oldBuild = buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: base, trigger: 'push' }, oldRunner);
    await new Promise((r) => setTimeout(r, 50));
    expect(await commitRow(id, c.sha)).toMatchObject({ state: 'building', instance_id: base, tree: c.tree });

    // The old attempt looks dead: a demand takes over with -r1.
    await env.DB.batch([
      env.DB.prepare('UPDATE snapshot_commits SET requested_at = requested_at - ? WHERE repo_id = ?').bind(STALE_BUILD_MS + 1000, id),
      env.DB.prepare('UPDATE snapshot_trees SET created_at = created_at - ? WHERE repo_id = ?').bind(STALE_BUILD_MS + 1000, id),
    ]);
    const demand = await call(snap('takeover', 'main'), { method: 'POST', token: tok.owner });
    expect(demand.json).toMatchObject({ state: 'building', started: true });
    const successor = `${base}-r1`;
    expect(builder.creates.at(-1)).toBe(successor);
    builder.ran.add(successor);
    let releaseNew!: () => void;
    const newRunner = new Runner();
    newRunner.gates.set('batch-1', new Promise<void>((r) => (releaseNew = r)));
    const newBuild = buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: successor, trigger: 'demand' }, newRunner);
    await new Promise((r) => setTimeout(r, 50));
    const claimed = await env.DB.prepare('SELECT builder FROM snapshot_trees WHERE repo_id = ? AND tree = ?').bind(id, c.tree).first();
    expect(claimed).toEqual({ builder: successor });

    // The old attempt now fails.
    repo.failBlobOnce.add(await blobHash('takeover a\n'));
    releaseOld();
    await expect(oldBuild).rejects.toThrow(/transient/);
    expect(await commitRow(id, c.sha)).toMatchObject({ state: 'building', instance_id: successor, error: null });

    releaseNew();
    await expect(newBuild).resolves.toMatchObject({ outcome: 'built' });
    const ready = await call(snap('takeover', 'main'), { token: tok.owner });
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({ state: 'ready', sha: c.sha, tree: c.tree });
    checkTar(readTar(await tarball(id, c.tree)), { 'a.txt': 'takeover a\n', 'b.txt': 'takeover b\n' });
  });

  it('a repo deleted during its build leaves no completed tarball behind', async () => {
    const { id, repo } = await seedRepo('vanish');
    const c = await commit(repo, SMALL);
    let releaseBatch!: () => void;
    let releaseFinish!: () => void;
    const runner = new Runner();
    runner.gates.set('batch-1', new Promise<void>((r) => (releaseBatch = r)));
    runner.gates.set('finish', new Promise<void>((r) => (releaseFinish = r)));
    const seen: { del?: number; keysAfterDelete?: number; keysBeforeFinish?: number; outcome?: string } = {};
    const logs = await builderLogs('snap-vanish', async () => {
      const build = buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-vanish' }, runner);
      await new Promise((r) => setTimeout(r, 50));
      // The repo goes while the build holds its tree claim and no object exists yet.
      seen.del = (await call(`/api/v1/repos/${OWNER}/vanish`, { method: 'DELETE', token: tok.owner })).status;
      seen.keysAfterDelete = (await objectKeys(id)).length;
      releaseBatch();
      await vi.waitFor(async () => expect(await objectKeys(id)).toHaveLength(1), { timeout: 2000 });
      seen.keysBeforeFinish = (await objectKeys(id)).length;
      releaseFinish();
      seen.outcome = (await build).outcome;
    });
    expect(seen).toEqual({ del: 200, keysAfterDelete: 0, keysBeforeFinish: 1, outcome: 'built' });
    expect(await objectKeys(id)).toHaveLength(0);
    expect(await commitRow(id, c.sha)).toBeNull();
    const finish = logs.find((l) => l.step === 'finish');
    // The ready batch and one repo-existence check; the cost-store batch is skipped.
    expect(finish).toMatchObject({ outcome: 'ok', cost: { d1: 2 }, discarded: snapshotKey(id, c.tree) });
    expect(finish?.excluded).toBeUndefined();
  });

  it('an attempt superseded while its repo is alive deletes nothing when it finishes late', async () => {
    const { id, repo } = await seedRepo('late');
    const files: Files = { 'late.txt': 'late finisher\n' };
    const c = await commit(repo, files);
    let releaseOld!: () => void;
    const oldRunner = new Runner();
    oldRunner.gates.set('finish', new Promise<void>((r) => (releaseOld = r)));
    const oldBuild = buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-late' }, oldRunner);
    await vi.waitFor(async () => expect(await objectKeys(id)).toHaveLength(1), { timeout: 2000 });

    // The old attempt looks dead; its successor takes the tree and the commit over and finishes first.
    await env.DB.batch([
      env.DB.prepare('UPDATE snapshot_commits SET instance_id = ? WHERE repo_id = ?').bind('snap-late-r1', id),
      env.DB.prepare('UPDATE snapshot_trees SET created_at = created_at - ? WHERE repo_id = ?').bind(STALE_BUILD_MS + 1000, id),
    ]);
    const successor = await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-late-r1', trigger: 'demand' }, new Runner());
    expect(successor.outcome).toBe('built');
    const successorCost = (await commitRow(id, c.sha))?.build_cost;
    expect(successorCost).toBe(JSON.stringify(successor.cost));
    const treeCost = async () =>
      (await env.DB.prepare('SELECT build_cost FROM snapshot_trees WHERE repo_id = ? AND tree = ?').bind(id, c.tree).first<{ build_cost: string }>())
        ?.build_cost;
    const successorTreeCost = await treeCost();

    let oldOutcome: string | undefined;
    const logs = await builderLogs('snap-late', async () => {
      releaseOld();
      oldOutcome = (await oldBuild).outcome;
    });
    expect(oldOutcome).toBe('built');
    const finish = logs.find((l) => l.step === 'finish');
    expect(finish).toMatchObject({ outcome: 'ok' });
    expect(finish).not.toHaveProperty('discarded');
    expect(await objectKeys(id)).toEqual([snapshotKey(id, c.tree)]);
    checkTar(readTar(await tarball(id, c.tree)), files);
    expect(await commitRow(id, c.sha)).toMatchObject({ state: 'ready', instance_id: 'snap-late-r1', reused: 0, build_cost: successorCost });
    expect(await treeCost()).toBe(successorTreeCost);
  });

  it('a replayed finish with the repo alive deletes nothing', async () => {
    const { id, repo } = await seedRepo('refinish');
    const c = await commit(repo, SMALL);
    const runner = new Runner();
    const run = runner.do.bind(runner);
    // The finish body runs twice, as when a completed step's result is lost and the step reruns.
    runner.do = (async (name: string, fn: (ctx?: { attempt: number }) => Promise<unknown>) => {
      if (name === 'finish') await fn({ attempt: 1 });
      return run(name, fn);
    }) as StepRunner['do'];
    let outcome: Awaited<ReturnType<typeof buildSnapshot>> | undefined;
    const logs = await builderLogs('snap-refinish', async () => {
      outcome = await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-refinish' }, runner);
    });
    const finishes = logs.filter((l) => l.step === 'finish');
    expect(finishes.map((l) => l.outcome)).toEqual(['ok', 'ok']);
    expect(finishes.some((l) => 'discarded' in l)).toBe(false);
    expect(await objectKeys(id)).toEqual([snapshotKey(id, c.tree)]);
    checkTar(readTar(await tarball(id, c.tree)), SMALL);
    // The tree's own builder still records its measured cost on the replay.
    expect(await commitRow(id, c.sha)).toMatchObject({ state: 'ready', reused: 0, build_cost: JSON.stringify(outcome?.cost) });
  });

  it('a commit-not-found result from a superseded attempt leaves the active attempt alone', async () => {
    const { id } = await seedRepo('gone');
    const sha = 'a'.repeat(40);
    await env.DB.prepare(
      `INSERT INTO snapshot_commits (repo_id, sha, tree, state, trigger, instance_id, attempt, requested_at)
       VALUES (?, ?, NULL, 'building', 'demand', 'gone-x-r1', 1, ?)`,
    )
      .bind(id, sha, Date.now())
      .run();
    await buildSnapshot(env, { repoId: id, sha, instanceId: 'gone-x' }, new Runner());
    expect(await commitRow(id, sha)).toMatchObject({ state: 'building', instance_id: 'gone-x-r1', error: null });
    await buildSnapshot(env, { repoId: id, sha, instanceId: 'gone-x-r1', trigger: 'demand' }, new Runner());
    expect(await commitRow(id, sha)).toMatchObject({ state: 'failed', instance_id: 'gone-x-r1', error: 'commit not found' });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe('snapshot API', () => {
  const fx = {} as { id: string; repo: FakeRepo; main: { sha: string; tree: string }; feature: { sha: string; tree: string } };

  beforeAll(async () => {
    const seeded = await seedRepo('api');
    fx.id = seeded.id;
    fx.repo = seeded.repo;
    fx.main = await commit(fx.repo, SMALL);
    fx.feature = await commit(fx.repo, { ...SMALL, 'feature.txt': 'feature\n' }, [fx.main.sha]);
    fx.repo.refs.set('refs/heads/main', fx.main.sha);
    fx.repo.refs.set('refs/heads/agents/w1', fx.feature.sha);
  });

  it('returns 404 for unknown refs, SHAs and repos', async () => {
    expect((await call(snap('api', 'no-such-ref'), { token: tok.owner })).status).toBe(404);
    expect((await call(snap('api', 'no-such-ref/download'), { token: tok.owner })).status).toBe(404);
    expect((await call(snap('api', 'f'.repeat(40)), { token: tok.owner })).status).toBe(404);
    expect((await call(`/api/v1/repos/${OWNER}/no-such-repo/snapshots/main`, { token: tok.owner })).status).toBe(404);
  });

  it('metadata for an existing ref never starts a build (lazy until demanded)', async () => {
    const before = builder.creates.length;
    const res = await call(snap('api', 'agents/w1'), { token: tok.owner });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ state: 'absent', sha: fx.feature.sha });
    const bySha = await call(snap('api', fx.feature.sha), { token: tok.owner });
    expect(bySha.status).toBe(202);
    expect((await call(snap('api', 'agents/w1/download'), { token: tok.owner })).status).toBe(409);
    expect(builder.creates.length).toBe(before);
    expect(await commitRow(fx.id, fx.feature.sha)).toBeNull();
  });

  it('demand needs an identified caller with read access', async () => {
    expect((await call(snap('api', 'agents/w1'), { method: 'POST' })).status).toBe(401);
    await seedRepo('hidden', 'private');
    expect((await call(snap('hidden', 'main'), { method: 'POST', token: tok.outsider })).status).toBe(404);
  });

  it('an explicit demand builds once: 202 building, then 200 ready by ref and by SHA', async () => {
    const demand = await call(snap('api', 'agents/w1'), { method: 'POST', token: tok.owner });
    expect(demand.status).toBe(202);
    expect(demand.json).toMatchObject({ state: 'building', sha: fx.feature.sha, started: true, trigger: 'demand' });
    expect(builder.creates.at(-1)).toBe(snapshotInstanceId(fx.id, fx.feature.sha));
    const building = await call(snap('api', 'agents%2Fw1'), { token: tok.owner });
    expect(building.status).toBe(202);
    expect(building.json.state).toBe('building');
    const again = await call(snap('api', 'agents/w1'), { method: 'POST', token: tok.owner });
    expect(again.json).toMatchObject({ state: 'building', started: false });
    expect(builder.creates.filter((x) => x === snapshotInstanceId(fx.id, fx.feature.sha))).toHaveLength(1);

    await builder.drain();
    const ready = await call(snap('api', 'agents/w1'), { token: tok.owner });
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({ state: 'ready', sha: fx.feature.sha, tree: fx.feature.tree, files: 7, reused: false });
    expect(typeof ready.json.builtAt).toBe('string');
    expect(ready.json.size).toBeGreaterThan(0);
    expect((ready.json.buildCost as BuildCost).steps).toBeLessThanOrEqual(Math.ceil(7 / 500) + 2);
    const bySha = await call(snap('api', fx.feature.sha), { token: tok.owner });
    expect(bySha.status).toBe(200);
    expect(bySha.json.size).toBe(ready.json.size);
    const done = await call(snap('api', 'agents/w1'), { method: 'POST', token: tok.owner });
    expect(done.status).toBe(200);
    expect(done.json.started).toBe(false);
  });

  it('warm metadata reads no Artifacts (d1 <= 2, art = 0); download is one R2 class-B read', async () => {
    const warmup = await call(snap('api', 'agents/w1'), { token: tok.owner });
    expect(warmup.status).toBe(200);
    const lsBefore = lsRefsCalls.length;
    const warm = await call(snap('api', 'agents/w1'), { token: tok.owner });
    expect(warm.status).toBe(200);
    expect(warm.cost).toMatchObject({ art: 0, sub: 0, do: 0 });
    expect(warm.cost.d1).toBeLessThanOrEqual(2);
    expect(lsRefsCalls.length).toBe(lsBefore);

    const dl = await call(snap('api', 'agents/w1/download'), { token: tok.owner });
    expect(dl.status).toBe(200);
    // A new snapshot is a gzip archive served as such: no Content-Encoding, so
    // fetch and curl hand over the stored bytes and content-length matches them.
    expect(dl.headers.get('content-type')).toBe('application/gzip');
    expect(dl.headers.get('content-encoding')).toBeNull();
    expect(dl.headers.get('x-kvarm-snapshot-format')).toBe('gzip');
    expect(dl.headers.get('content-disposition')).toBe(`attachment; filename="api-${fx.feature.sha.slice(0, 12)}.tar.gz"`);
    expect(dl.cost).toMatchObject({ r2b: 1, r2a: 0, art: 0, do: 0 });
    expect(dl.cost.d1).toBeLessThanOrEqual(2);
    expect(dl.bytes.length).toBe(warm.json.size);
    expect(Number(dl.headers.get('content-length'))).toBe(warm.json.size);
    expect([dl.bytes[0], dl.bytes[1]]).toEqual([0x1f, 0x8b]);
    checkTar(readTar(await gunzip(dl.bytes)), { ...SMALL, 'feature.txt': 'feature\n' });
  });

  it('a legacy uncompressed snapshot still downloads (x-tar, same cost) and extracts; its object is never relabelled', async () => {
    const { id, repo } = await seedRepo('legacy');
    const files: Files = { ...SMALL, ...manyFiles(30, 12_000, 'legacy') };
    const c = await commit(repo, files);
    repo.refs.set('refs/heads/main', c.sha);
    await call(snap('legacy', 'main'), { method: 'POST', token: tok.owner });
    await builder.drain();
    const legacyKey = await downgradeToLegacy(id, c.tree);

    const meta = await call(snap('legacy', 'main'), { token: tok.owner });
    expect(meta.status).toBe(200);
    const first = await call(snap('legacy', `${c.sha}/download`), { token: tok.owner });
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/x-tar');
    expect(first.headers.get('x-kvarm-snapshot-format')).toBe('tar');
    expect(first.headers.get('content-disposition')).toBe(`attachment; filename="legacy-${c.sha.slice(0, 12)}.tar"`);
    expect(first.cost).toMatchObject({ r2b: 1, r2a: 0, art: 0, do: 0, sub: 0, cache: 'miss' });
    expect(first.cost.d1).toBeLessThanOrEqual(2);
    expect(first.bytes.length).toBe(meta.json.size);
    expect(Number(first.headers.get('content-length'))).toBe(meta.json.size);
    checkTar(readTar(first.bytes), files);

    const second = await call(snap('legacy', `${c.sha}/download`), { token: tok.owner });
    expect(second.cost).toMatchObject({ r2b: 0, cache: 'hit' });
    expect(second.cost.d1).toBe(1);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.headers.get('content-type')).toBe('application/x-tar');
    expect(second.headers.get('x-kvarm-snapshot-format')).toBe('tar');

    // A later commit with the same tree reuses the legacy object: no gzip twin appears.
    const later = await commit(repo, files, [c.sha]);
    repo.refs.set('refs/heads/main', later.sha);
    await call(snap('legacy', 'main'), { method: 'POST', token: tok.owner });
    await builder.drain();
    expect(await commitRow(id, later.sha)).toMatchObject({ state: 'ready', reused: 1 });
    expect(await objectKeys(id)).toEqual([legacyKey]);
    const reused = await call(snap('legacy', `${later.sha}/download`), { token: tok.owner });
    expect(reused.headers.get('content-type')).toBe('application/x-tar');
    expect(reused.bytes).toEqual(first.bytes);
  });

  it('a gzip and a plain entry for the same repo and commit never answer for each other in the cache', async () => {
    const repoId = crypto.randomUUID();
    const sha = 'e'.repeat(40);
    const plainBytes = new Uint8Array(4096).fill(7);
    const gzipBytes = new Uint8Array(2048).fill(9);
    const store = async (bytes: Uint8Array, format: 'tar' | 'gzip', tree: string) => {
      const ctx = createExecutionContext();
      const body = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
      await new Response(streamAndStore(ctx, repoId, sha, tree, { body, size: bytes.length } as unknown as R2ObjectBody, format)).arrayBuffer();
      await waitOnExecutionContext(ctx);
    };
    expect(snapshotCacheKey(repoId, sha, 'gzip').url).not.toBe(snapshotCacheKey(repoId, sha, 'tar').url);

    await store(plainBytes, 'tar', 't'.repeat(40));
    const plainOnly = await matchSnapshot(repoId, sha);
    expect(plainOnly).toMatchObject({ format: 'tar', size: plainBytes.length });
    expect(new Uint8Array(await new Response(plainOnly!.body).arrayBuffer())).toEqual(plainBytes);

    await store(gzipBytes, 'gzip', 'g'.repeat(40));
    const both = await matchSnapshot(repoId, sha);
    expect(both).toMatchObject({ format: 'gzip', size: gzipBytes.length, tree: 'g'.repeat(40) });
    expect(new Uint8Array(await new Response(both!.body).arrayBuffer())).toEqual(gzipBytes);
    // The plain entry is still intact under its own key.
    const plainHit = await caches.default.match(snapshotCacheKey(repoId, sha, 'tar'));
    expect(new Uint8Array(await plainHit!.arrayBuffer())).toEqual(plainBytes);
    const gzipOnly = await matchSnapshot(repoId, 'f'.repeat(40));
    expect(gzipOnly).toBeNull();
  });

  it('a failed build reports 409 and a new demand retries it', async () => {
    const { id, repo } = await seedRepo('flaky');
    const c = await commit(repo, { 'ok.txt': 'ok\n', 'lost.txt': 'lost\n' });
    repo.refs.set('refs/heads/main', c.sha);
    const lost = [...repo.objects].find(([, o]) => o.type === 'blob' && new TextDecoder().decode(o.content) === 'lost\n')!;
    repo.objects.delete(lost[0]);
    expect((await call(snap('flaky', 'main'), { method: 'POST', token: tok.owner })).status).toBe(202);
    await builder.drain();
    const failed = await call(snap('flaky', 'main'), { token: tok.owner });
    expect(failed.status).toBe(409);
    expect(failed.json).toMatchObject({ state: 'failed', code: 'SNAPSHOT_FAILED' });

    repo.objects.set(lost[0], lost[1]);
    const retry = await call(snap('flaky', 'main'), { method: 'POST', token: tok.owner });
    expect(retry.json).toMatchObject({ state: 'building', started: true });
    expect(builder.creates.at(-1)).toBe(`${snapshotInstanceId(id, c.sha)}-r1`);
    await builder.drain();
    expect((await call(snap('flaky', 'main'), { token: tok.owner })).json.state).toBe('ready');
  });

  it('a demand whose Workflow could not start is recoverable by the very next demand', async () => {
    const { id, repo } = await seedRepo('nostart');
    const c = await commit(repo, { 'n.txt': 'n\n' });
    repo.refs.set('refs/heads/main', c.sha);
    builder.failCreates = 1;
    const failed = await call(snap('nostart', 'main'), { method: 'POST', token: tok.owner });
    expect(failed.status).toBe(503);
    expect(failed.json).toMatchObject({ code: 'SNAPSHOT_START_FAILED' });
    expect(builder.instances.has(snapshotInstanceId(id, c.sha))).toBe(false);
    // The unstarted attempt is not left looking like a live build.
    const meta = await call(snap('nostart', 'main'), { token: tok.owner });
    expect(meta.status).toBe(409);
    expect(meta.json).toMatchObject({ state: 'failed', code: 'SNAPSHOT_FAILED' });

    // No stale-clock wait: the next demand starts a build at once.
    const retry = await call(snap('nostart', 'main'), { method: 'POST', token: tok.owner });
    expect(retry.status).toBe(202);
    expect(retry.json).toMatchObject({ state: 'building', started: true });
    expect(builder.creates.at(-1)).toBe(`${snapshotInstanceId(id, c.sha)}-r1`);
    await builder.drain();
    const ready = await call(snap('nostart', 'main'), { token: tok.owner });
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({ state: 'ready', sha: c.sha });
  });

  it('a create error for an instance that does exist is the same build, not a failure', async () => {
    const { id, repo } = await seedRepo('exists');
    const c = await commit(repo, { 'e.txt': 'e\n' });
    repo.refs.set('refs/heads/main', c.sha);
    // The eager push build already owns the base id.
    await builder.create({ id: snapshotInstanceId(id, c.sha), params: { repoId: id, sha: c.sha } });
    const demand = await call(snap('exists', 'main'), { method: 'POST', token: tok.owner });
    expect(demand.status).toBe(202);
    expect(demand.json).toMatchObject({ state: 'building', started: true });
    await builder.drain();
    expect((await call(snap('exists', 'main'), { token: tok.owner })).status).toBe(200);
  });

  it('private snapshots are concealed from anonymous and unrelated callers', async () => {
    const { id, repo } = await seedRepo('secret', 'private');
    const c = await commit(repo, SMALL);
    repo.refs.set('refs/heads/main', c.sha);
    expect((await call(snap('secret', 'main'), { method: 'POST', token: tok.owner })).status).toBe(202);
    await builder.drain();
    for (const token of [undefined, tok.outsider]) {
      expect((await call(snap('secret', 'main'), { token })).status).toBe(404);
      expect((await call(snap('secret', 'main/download'), { token })).status).toBe(404);
    }
    expect((await call(snap('secret', 'main'), { token: tok.owner })).status).toBe(200);
    const meta = await call(snap('secret', 'main'), { token: tok.owner });
    const dl = await call(snap('secret', 'main/download'), { token: tok.owner });
    expect(dl.status).toBe(200);
    expect(dl.bytes.length).toBe(meta.json.size);
    expect((await commitRow(id, c.sha))!.state).toBe('ready');
  });

  it('a visibility flip denies warmed snapshot metadata and downloads immediately', async () => {
    const { id, repo } = await seedRepo('flip');
    const c = await commit(repo, SMALL);
    repo.refs.set('refs/heads/main', c.sha);
    await call(snap('flip', 'main'), { method: 'POST', token: tok.owner });
    await builder.drain();
    for (let i = 0; i < 2; i++) {
      expect((await call(snap('flip', 'main'))).status).toBe(200);
      expect((await call(snap('flip', 'main/download'))).status).toBe(200);
    }
    // Direct D1 flip, as another colo would see it: no purge here.
    await env.DB.prepare("UPDATE repos SET visibility = 'private' WHERE id = ?").bind(id).run();
    for (const token of [undefined, tok.outsider]) {
      const meta = await call(snap('flip', 'main'), { token });
      expect(meta.status).toBe(404);
      expect(meta.json.size).toBeUndefined();
      const dl = await call(snap('flip', 'main/download'), { token });
      expect(dl.status).toBe(404);
      expect(dl.cost.r2b).toBe(0);
    }
    expect((await call(snap('flip', 'main'), { token: tok.owner })).status).toBe(200);
    expect((await call(snap('flip', 'main/download'), { token: tok.owner })).status).toBe(200);
  });

  it('a repeat download of a ready commit is served from the repo-scoped cache: same bytes and etag, r2b=0, d1=1', async () => {
    const { repo } = await seedRepo('dlcache');
    // Several hundred kilobytes, so the tarball streams in many chunks on the miss.
    const files: Files = { ...SMALL, ...manyFiles(30, 20_000, 'dl', true) };
    const c = await commit(repo, files);
    repo.refs.set('refs/heads/main', c.sha);
    await call(snap('dlcache', 'main'), { method: 'POST', token: tok.owner });
    await builder.drain();
    const meta = await call(snap('dlcache', 'main'), { token: tok.owner });
    expect(meta.status).toBe(200);

    const first = await call(snap('dlcache', `${c.sha}/download`), { token: tok.owner });
    expect(first.status).toBe(200);
    expect(first.cost).toMatchObject({ r2b: 1, r2a: 0, art: 0, do: 0, sub: 0, cache: 'miss' });
    expect(first.cost.d1).toBeLessThanOrEqual(2);
    expect(first.bytes.length).toBe(meta.json.size);
    expect(Number(first.headers.get('content-length'))).toBe(meta.json.size);
    expect(first.bytes.length).toBeGreaterThan(300_000);
    checkTar(readTar(await gunzip(first.bytes)), files);

    const second = await call(snap('dlcache', `${c.sha}/download`), { token: tok.owner });
    expect(second.status).toBe(200);
    expect(second.cost).toMatchObject({ r2b: 0, r2a: 0, art: 0, do: 0, sub: 0, cache: 'hit' });
    expect(second.cost.d1).toBe(1);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.headers.get('etag')).toBe(`"${c.tree}"`);
    for (const h of ['content-type', 'content-length', 'content-disposition', 'etag', 'cache-control', 'x-kvarm-snapshot-sha', 'x-kvarm-snapshot-format']) {
      expect(second.headers.get(h), h).toBe(first.headers.get(h));
    }
    expect(second.headers.get('cache-control')).toContain('no-store');
    expect(second.headers.get('cache-control')).not.toContain('public');

    // A ref name resolves (cached) to the same commit and hits the same entry.
    const byRef = await call(snap('dlcache', 'main/download'), { token: tok.owner });
    expect(byRef.cost).toMatchObject({ r2b: 0, cache: 'hit' });
    expect(byRef.bytes).toEqual(first.bytes);

    // The attachment name follows the current repo name, not the cached one.
    await env.DB.prepare("UPDATE repos SET name = 'dlcache-renamed' WHERE name = 'dlcache' AND owner_login = ?").bind(OWNER).run();
    const renamed = await call(snap('dlcache-renamed', `${c.sha}/download`), { token: tok.owner });
    expect(renamed.cost).toMatchObject({ r2b: 0, cache: 'hit' });
    expect(renamed.headers.get('content-disposition')).toBe(`attachment; filename="dlcache-renamed-${c.sha.slice(0, 12)}.tar.gz"`);
    expect(renamed.bytes).toEqual(first.bytes);
  }, 20_000);

  it('a caller that goes away mid-download still leaves a complete cache entry', async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => new Uint8Array(64 * 1024).fill(i + 1));
    const size = chunks.reduce((n, ch) => n + ch.length, 0);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const repoId = crypto.randomUUID();
    const sha = 'c'.repeat(40);
    const ctx = createExecutionContext();
    const client = streamAndStore(ctx, repoId, sha, 'd'.repeat(40), { body, size } as unknown as R2ObjectBody, 'tar');
    const reader = client.getReader();
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    await reader.cancel();
    await waitOnExecutionContext(ctx);
    const cached = await matchSnapshot(repoId, sha);
    expect(cached).not.toBeNull();
    expect(cached!.size).toBe(size);
    expect(cached!.tree).toBe('d'.repeat(40));
    const bytes = new Uint8Array(await new Response(cached!.body).arrayBuffer());
    expect(bytes.length).toBe(size);
    for (let i = 0; i < 8; i++) expect(bytes[i * 64 * 1024]).toBe(i + 1);
  });

  it('a cached download is never served to a denied caller: concealment 404 before any cache lookup', async () => {
    const { repo } = await seedRepo('dlcache-private', 'private');
    const c = await commit(repo, { ...SMALL, 'private.txt': 'private\n' });
    repo.refs.set('refs/heads/main', c.sha);
    await call(snap('dlcache-private', 'main'), { method: 'POST', token: tok.owner });
    await builder.drain();
    const owner1 = await call(snap('dlcache-private', `${c.sha}/download`), { token: tok.owner });
    const owner2 = await call(snap('dlcache-private', `${c.sha}/download`), { token: tok.owner });
    expect(owner1.cost.cache).toBe('miss');
    expect(owner2.cost.cache).toBe('hit');
    for (const token of [undefined, tok.outsider]) {
      const denied = await call(snap('dlcache-private', `${c.sha}/download`), { token });
      expect(denied.status).toBe(404);
      expect(denied.headers.get('content-type')).not.toBe('application/x-tar');
      expect(denied.bytes.length).toBeLessThan(200);
      expect(denied.cost).toMatchObject({ d1: 1, r2b: 0, cache: 'none' });
    }

    // Warmed while public, then flipped private: denied before the entry is consulted.
    const { id: pubId, repo: pubRepo } = await seedRepo('dlcache-flip');
    const p = await commit(pubRepo, { ...SMALL, 'flip.txt': 'flip\n' });
    pubRepo.refs.set('refs/heads/main', p.sha);
    await call(snap('dlcache-flip', 'main'), { method: 'POST', token: tok.owner });
    await builder.drain();
    expect((await call(snap('dlcache-flip', `${p.sha}/download`))).cost.cache).toBe('miss');
    expect((await call(snap('dlcache-flip', `${p.sha}/download`))).cost.cache).toBe('hit');
    await env.DB.prepare("UPDATE repos SET visibility = 'private' WHERE id = ?").bind(pubId).run();
    for (const token of [undefined, tok.outsider]) {
      const denied = await call(snap('dlcache-flip', `${p.sha}/download`), { token });
      expect(denied.status).toBe(404);
      expect(denied.cost).toMatchObject({ r2b: 0, cache: 'none' });
      expect(denied.headers.get('x-kvarm-snapshot-sha')).toBeNull();
    }
    expect((await call(snap('dlcache-flip', `${p.sha}/download`), { token: tok.owner })).cost.cache).toBe('hit');
  });

  it('deleting a repo removes its snapshot rows and tarballs within the DELETE budget (d1 <= 2)', async () => {
    const { id, repo } = await seedRepo('doomed');
    const main = await commit(repo, SMALL);
    const other = await commit(repo, { 'other.txt': 'other\n' }, [main.sha]);
    repo.refs.set('refs/heads/main', main.sha);
    repo.refs.set('refs/heads/other', other.sha);
    await call(snap('doomed', 'main'), { method: 'POST', token: tok.owner });
    await call(snap('doomed', 'other'), { method: 'POST', token: tok.owner });
    await builder.drain();
    expect(await objectKeys(id)).toHaveLength(2);
    const del = await call(`/api/v1/repos/${OWNER}/doomed`, { method: 'DELETE', token: tok.owner });
    expect(del.status).toBe(200);
    expect(del.cost.d1).toBeLessThanOrEqual(2);
    expect(del.cost).toMatchObject({ art: 1, r2a: 0, r2b: 0, do: 0 });
    expect(await objectKeys(id)).toHaveLength(0);
    expect(await commitRow(id, main.sha)).toBeNull();
    const trees = await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot_trees WHERE repo_id = ?').bind(id).first();
    expect(trees).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT id FROM repos WHERE id = ?').bind(id).first()).toBeNull();
  });

  it('deleting a repo without snapshots stays within the DELETE budget and touches no R2', async () => {
    const { id } = await seedRepo('bare');
    const del = await call(`/api/v1/repos/${OWNER}/bare`, { method: 'DELETE', token: tok.owner });
    expect(del.status).toBe(200);
    expect(del.cost.d1).toBeLessThanOrEqual(2);
    expect(del.cost).toMatchObject({ art: 1, r2a: 0, r2b: 0, do: 0 });
    expect(await env.DB.prepare('SELECT id FROM repos WHERE id = ?').bind(id).first()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Push events -> eager default-branch snapshots
// ---------------------------------------------------------------------------

describe('push events and snapshots', () => {
  function pushBody(artifactsName: string, ref: string, before: string, after: string, at: number) {
    return {
      type: 'cf.artifacts.repo.pushed',
      source: { type: 'artifacts', namespace: 'default', repoName: artifactsName },
      payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
      metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
    };
  }

  async function deliver(body: unknown, id = crypto.randomUUID()) {
    const batch = createMessageBatch('kvarm-events', [{ id, timestamp: new Date(), attempts: 1, body }]);
    const ctx = createExecutionContext();
    await worker.queue!(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);
    return result;
  }

  async function readyMeta(repo: string) {
    const res = await call(snap(repo, 'main'), { token: tok.owner });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { sha, size, files, builtAt, tree } = res.json as Record<string, unknown>;
    return { sha, size, files, builtAt, tree };
  }

  it('A-B-A-B reuses existing snapshots; replaying a delivery adds no work; workspace pushes stay lazy', async () => {
    const { id, repo } = await seedRepo('cycle');
    const name = `${OWNER}--cycle`;
    const ZERO = '0'.repeat(40);
    const A = await commit(repo, { 'a.txt': 'A\n' });
    const B = await commit(repo, { 'a.txt': 'B\n', 'b.txt': 'b\n' }, [A.sha]);
    const t0 = Date.now();

    repo.refs.set('refs/heads/main', A.sha);
    await deliver(pushBody(name, 'refs/heads/main', ZERO, A.sha, t0));
    await builder.drain();
    const metaA = await readyMeta('cycle');
    expect(metaA.sha).toBe(A.sha);

    repo.refs.set('refs/heads/main', B.sha);
    const abId = crypto.randomUUID();
    const ab = pushBody(name, 'refs/heads/main', A.sha, B.sha, t0 + 1000);
    await deliver(ab, abId);
    await builder.drain();
    const metaB = await readyMeta('cycle');
    expect(metaB.sha).toBe(B.sha);

    const creates = builder.creates.length;
    const objects = await objectKeys(id);
    repo.refs.set('refs/heads/main', A.sha);
    await deliver(pushBody(name, 'refs/heads/main', B.sha, A.sha, t0 + 2000));
    await builder.drain();
    expect(await readyMeta('cycle')).toEqual(metaA);

    repo.refs.set('refs/heads/main', B.sha);
    await deliver(pushBody(name, 'refs/heads/main', A.sha, B.sha, t0 + 3000));
    await builder.drain();
    expect(await readyMeta('cycle')).toEqual(metaB);

    // Replay the exact earlier A->B delivery: a duplicate, no new work.
    await deliver(ab, abId);
    await builder.drain();
    expect(builder.creates.length).toBe(creates);
    expect(await objectKeys(id)).toEqual(objects);
    expect(objects).toHaveLength(2);

    // A workspace push records the event but builds nothing.
    const W = await commit(repo, { 'w.txt': 'w\n' }, [B.sha]);
    repo.refs.set('refs/heads/agents/x', W.sha);
    await deliver(pushBody(name, 'refs/heads/agents/x', ZERO, W.sha, t0 + 4000));
    expect(builder.creates.length).toBe(creates);
    expect((await call(snap('cycle', 'agents/x'), { token: tok.owner })).json.state).toBe('absent');
  });
});
