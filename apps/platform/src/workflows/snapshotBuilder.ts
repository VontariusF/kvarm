/**
 * SnapshotBuilder (architecture §11.5): a commit's working tree as a tar in R2.
 *
 * Tarballs are keyed by (repo, root tree), so commits with identical trees
 * share one object; commit metadata stays per commit. Steps:
 *
 *   resolve   commit -> tree, then claim the tree build in one D1 batch. A
 *             tree that is already built marks the commit ready (reuse); a
 *             tree another instance is building leaves the commit waiting
 *             for that builder to finish it.
 *   batch-N   continues a pre-order walk of the tree and streams up to
 *             BLOBS_PER_STEP blobs into the tar in order: each blob's
 *             stream goes straight into equal PART_SIZE multipart parts.
 *             Blob reads run ahead of the writer under a byte budget (see
 *             BlobReader), so a step holds at most READ_BUDGET of returned
 *             blobs (or one blob larger than that) plus the part buffers.
 *             The unflushed tail and the walk cursor are the step's
 *             (streamed) output, so a retried or replayed step resumes
 *             from exactly the same input.
 *   finish    marks the tree and every commit waiting on it ready. If the
 *             repo was deleted during the build, it removes the tarball.
 *
 * New tarballs are gzip-compressed at build time (key `.tar.gz`, issue #20)
 * with CompressionStream('gzip'), whose level is the runtime default (it has
 * no level option). Compression state cannot cross Workflow steps, so each
 * step ends its gzip member and the object is a concatenation of members
 * (valid gzip; one member per step costs a little ratio). What a step carries
 * to the next is already-compressed bytes, so parts are cut from compressed
 * output. A tree already built as an uncompressed `.tar` is reused as is, and
 * a build that started with a `.tar` key finishes as plain tar.
 *
 * Every build attempt belongs to one instance id. Terminal writes to a
 * commit row (failed, commit not found) only apply while that instance is
 * the commit's active attempt, so a superseded attempt cannot fail its
 * successor; commits waiting on a tree follow that tree's builder.
 *
 * A tree with B blob/symlink entries takes 1 + max(1, ceil(B / 500)) + 1
 * steps. Each step attempt, failed ones included, logs one `{cost: …}`
 * line. The stored `buildCost` is the sum of the completed step attempts'
 * measured work, except the one batch that stores `buildCost` itself (its
 * counters are logged as `excluded`); failed attempts appear only in logs.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { decode, encode, gitModeToTar, tarEnd, tarHeader, tarPadding, type TarEntry } from '@kvarm/gitops';
import { withRepo } from '../artifacts/repo';
import { CostMeter, runWithMeter } from '../cost/meter';
import { FORMAT_HTTP, formatOfKey, snapshotKey } from '../snapshotFormat';

export { snapshotKey };

export const BLOBS_PER_STEP = 500;
/** R2 multipart parts must all be the same size except the last. */
export const PART_SIZE = 8 * 1024 * 1024;
/** A build still claimed after this long is presumed dead and can be taken over. */
export const STALE_BUILD_MS = 30 * 60 * 1000;
/** Most blob reads outstanding at once. */
export const READ_AHEAD = 8;
/** Bytes of returned and expected blobs a step lets the read-ahead hold. */
export const READ_BUDGET = 16 * 1024 * 1024;

export interface SnapshotParams {
  repoId: string;
  sha: string;
  trigger?: 'push' | 'demand';
}

export interface BuildCost {
  steps: number;
  d1: number;
  rr: number;
  rw: number;
  art: number;
  r2a: number;
  r2b: number;
  sub: number;
  treeReads: number;
  blobReads: number;
  /** Multipart parts uploaded (0 for a single put). */
  parts: number;
  /** R2 objects written: 1 for a fresh tarball, 0 when an existing one was reused. */
  objects: number;
  bytes: number;
  /** Size of the largest blob the binding returned (held whole while it streams). */
  largestBlob: number;
  /** Most unflushed tar bytes buffered at once before a part upload. */
  peakBuffer: number;
  /** Most binding-returned blob bytes held at once (read ahead or streaming). */
  peakHeld: number;
  reused: boolean;
}

export function emptyCost(): BuildCost {
  return {
    steps: 0,
    d1: 0,
    rr: 0,
    rw: 0,
    art: 0,
    r2a: 0,
    r2b: 0,
    sub: 0,
    treeReads: 0,
    blobReads: 0,
    parts: 0,
    objects: 0,
    bytes: 0,
    largestBlob: 0,
    peakBuffer: 0,
    peakHeld: 0,
    reused: false,
  };
}

/** The subset of WorkflowStep the builder uses, so tests can drive it directly. */
export interface StepRunner {
  /** `attempt` counts from 1, as in the Workflows step context. */
  do<T>(name: string, fn: (ctx?: { attempt: number }) => Promise<T>): Promise<T>;
}

/** D1 work a step did that its stored cost cannot include: the write that stores the cost. */
type Excluded = { d1: number; rr: number; rw: number };

interface StepNote {
  excluded?: Excluded;
  /** R2 key of a finished tarball removed because its repo was deleted during the build. */
  discarded?: string;
}

function errorMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 300);
}

/**
 * Runs one step attempt under a fresh meter. A completed attempt adds its
 * counters (less any `excluded` store) to `cost`; every attempt, failed
 * ones included, logs one `{cost, …, outcome}` line.
 */
async function metered<T>(
  env: Env,
  cost: BuildCost,
  log: Record<string, unknown>,
  fn: (env: Env, meter: CostMeter, note: StepNote) => Promise<T>,
): Promise<T> {
  const meter = new CostMeter();
  const note: StepNote = {};
  let value: T;
  try {
    value = await runWithMeter(meter, () => fn(meter.wrapEnv(env), meter, note));
  } catch (err) {
    console.log(
      JSON.stringify({ cost: meter.snapshot(), workflow: 'snapshot-builder', ...log, outcome: 'failed', error: errorMessage(err) }),
    );
    throw err;
  }
  addMeter(cost, meter, note.excluded);
  console.log(JSON.stringify({ cost: meter.snapshot(), workflow: 'snapshot-builder', ...log, outcome: 'ok', ...note }));
  return value;
}

function addMeter(cost: BuildCost, meter: CostMeter, excluded: Excluded = { d1: 0, rr: 0, rw: 0 }): void {
  cost.steps++;
  cost.d1 += meter.d1 - excluded.d1;
  cost.rr += meter.rr - excluded.rr;
  cost.rw += meter.rw - excluded.rw;
  cost.art += meter.art;
  cost.r2a += meter.r2a;
  cost.r2b += meter.r2b;
  cost.sub += meter.sub;
}

/** Runs `write` and returns the D1 work it did on `meter`. */
async function measureD1(meter: CostMeter, write: () => Promise<unknown>): Promise<Excluded> {
  const before = { d1: meter.d1, rr: meter.rr, rw: meter.rw };
  await write();
  return { d1: meter.d1 - before.d1, rr: meter.rr - before.rr, rw: meter.rw - before.rw };
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

function isMissingObject(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'INVALID_INPUT' || code === 'NOT_FOUND';
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

type Resolved =
  | { action: 'done'; reason: string; cost: BuildCost }
  | { action: 'build'; tree: string; key: string; artifactsName: string; mtime: number; cost: BuildCost };

interface ClaimRow {
  tree_state: string | null;
  r2_key: string | null;
  builder: string | null;
  commit_state: string;
}

/** Counters metered so far in this step, as a one-step reuse/wait cost. */
function settledCost(meter: CostMeter, extraD1 = 0): BuildCost {
  return {
    ...emptyCost(),
    steps: 1,
    d1: meter.d1 + extraD1,
    rr: meter.rr,
    rw: meter.rw,
    art: meter.art,
    r2a: meter.r2a,
    r2b: meter.r2b,
    sub: meter.sub,
    reused: true,
  };
}

async function resolveStep(env: Env, p: Required<SnapshotParams> & { instanceId: string }): Promise<Resolved> {
  const cost = emptyCost();
  const log = { step: 'resolve', instance: p.instanceId };
  return metered(env, cost, log, async (env, meter, note) => {
    const repo = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE id = ?')
      .bind(p.repoId)
      .first<{ artifacts_name: string }>();
    if (!repo) return { action: 'done', reason: 'repo deleted', cost };
    let commit: ArtifactsCommitMetadata | null;
    try {
      commit = await withRepo(env, repo.artifacts_name, (h) => h.readCommit(p.sha));
    } catch (err) {
      if (!isMissingObject(err)) throw err;
      commit = null;
    }
    const now = Date.now();
    if (!commit || commit.hash !== p.sha) {
      // Only the commit's active attempt may fail it.
      await env.DB.prepare(
        `INSERT INTO snapshot_commits (repo_id, sha, tree, state, trigger, instance_id, requested_at, error)
         VALUES (?1, ?2, NULL, 'failed', ?3, ?4, ?5, 'commit not found')
         ON CONFLICT (repo_id, sha) DO UPDATE SET state = 'failed', error = 'commit not found'
         WHERE snapshot_commits.state = 'building' AND snapshot_commits.instance_id = excluded.instance_id`,
      )
        .bind(p.repoId, p.sha, p.trigger, p.instanceId, now)
        .run();
      return { action: 'done', reason: 'commit not found', cost };
    }
    const tree = commit.treeHash;
    const key = snapshotKey(p.repoId, tree);
    // Placeholder until the measured cost replaces it: what is metered so far plus the claim batch.
    const settled = JSON.stringify(settledCost(meter, 1));
    const db = env.DB;
    // The commit row is (re)claimed only by its active attempt, or by any
    // attempt once it has failed; a superseded attempt leaves it alone.
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO snapshot_trees (repo_id, tree, state, builder, r2_key, created_at)
           VALUES (?1, ?2, 'building', ?3, ?4, ?5)
           ON CONFLICT (repo_id, tree) DO UPDATE SET
             state = 'building', builder = excluded.builder, created_at = excluded.created_at, error = NULL
           WHERE snapshot_trees.state = 'failed'
              OR (snapshot_trees.state = 'building' AND snapshot_trees.created_at < ?6)`,
        )
        .bind(p.repoId, tree, p.instanceId, key, now, now - STALE_BUILD_MS),
      db
        .prepare(
          `INSERT INTO snapshot_commits (repo_id, sha, tree, state, trigger, instance_id, requested_at, build_cost)
           VALUES (?1, ?2, ?3, 'building', ?4, ?5, ?6, ?7)
           ON CONFLICT (repo_id, sha) DO UPDATE SET
             tree = excluded.tree, state = 'building', error = NULL, build_cost = excluded.build_cost,
             instance_id = excluded.instance_id
           WHERE snapshot_commits.state != 'ready'
             AND (snapshot_commits.instance_id = excluded.instance_id OR snapshot_commits.state = 'failed')`,
        )
        .bind(p.repoId, p.sha, tree, p.trigger, p.instanceId, now, settled),
      db
        .prepare(
          `UPDATE snapshot_commits SET state = 'ready', reused = 1, built_at = ?3, error = NULL
           WHERE repo_id = ?1 AND sha = ?2 AND state = 'building'
             AND EXISTS (SELECT 1 FROM snapshot_trees t WHERE t.repo_id = ?1 AND t.tree = ?4 AND t.state = 'ready')`,
        )
        .bind(p.repoId, p.sha, now, tree),
      db
        .prepare(
          `SELECT t.state AS tree_state, t.r2_key, t.builder, c.state AS commit_state
             FROM snapshot_commits c
             LEFT JOIN snapshot_trees t ON t.repo_id = c.repo_id AND t.tree = c.tree
            WHERE c.repo_id = ?1 AND c.sha = ?2`,
        )
        .bind(p.repoId, p.sha),
    ]);
    const row = (results[3]?.results as ClaimRow[] | undefined)?.[0];
    if (row && row.tree_state === 'building' && row.builder === p.instanceId && row.commit_state !== 'ready') {
      // The cost is stored when the build finishes. A re-claimed (failed or
      // stale) row keeps the key it already names, so a takeover overwrites
      // the same object instead of orphaning the earlier attempt's, and a
      // build that began under a legacy `.tar` key finishes as plain tar.
      return { action: 'build', tree, key: row.r2_key ?? key, artifactsName: repo.artifacts_name, mtime: commit.committedAt, cost };
    }
    // This attempt claimed the commit and needs nothing more (reuse, or a
    // wait on another builder): store its measured cost over the placeholder.
    const claimed = (results[1]?.meta?.changes ?? 0) > 0;
    if (claimed) {
      const measured = JSON.stringify(settledCost(meter));
      note.excluded = await measureD1(meter, () =>
        db
          .prepare('UPDATE snapshot_commits SET build_cost = ?4 WHERE repo_id = ?1 AND sha = ?2 AND instance_id = ?3')
          .bind(p.repoId, p.sha, p.instanceId, measured)
          .run(),
      );
    }
    if (!row || row.commit_state === 'ready') return { action: 'done', reason: 'ready', cost };
    return { action: 'done', reason: `waiting on ${row.builder ?? 'another build'}`, cost };
  });
}

// ---------------------------------------------------------------------------
// batch-N: walk + tar + multipart
// ---------------------------------------------------------------------------

interface Frame {
  path: string;
  hash: string;
  next: number;
}

export interface BatchState {
  stack: Frame[];
  uploadId: string | null;
  parts: R2UploadedPart[];
  /** Bytes already uploaded as parts. */
  flushed: number;
  files: number;
  done: boolean;
  /** Total tar size, set by the final batch. */
  size: number;
  cost: BuildCost;
}

interface BuildTarget {
  instanceId: string;
  repoId: string;
  tree: string;
  key: string;
  artifactsName: string;
  mtime: number;
}

export interface BuildOptions {
  blobsPerStep?: number;
  partSize?: number;
  readAhead?: number;
  readBudget?: number;
}

/** Appends tar bytes and uploads every complete part. */
class PartWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private compressor: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private drained: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private closed = false;

  /**
   * In gzip mode `push` takes tar bytes and the part buffer holds compressed
   * bytes; `carry` is the previous step's compressed leftover.
   */
  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
    private readonly partSize: number,
    readonly state: BatchState,
    carry: Uint8Array,
  ) {
    if (formatOfKey(key) === 'gzip') {
      const cs = new CompressionStream('gzip');
      this.compressor = cs.writable.getWriter();
      this.drained = this.drain(cs.readable);
    }
    if (carry.length > 0) this.buffer(carry);
  }

  private buffer(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
    if (this.length > this.state.cost.peakBuffer) this.state.cost.peakBuffer = this.length;
  }

  /** Moves compressed output into the part buffer and uploads full parts as they fill. */
  private async drain(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.buffer(value);
        await this.uploadFull();
      }
    } catch (err) {
      // Nothing reads the compressor any more: abort it so a pending
      // `ready`/`close` rejects instead of waiting on backpressure forever.
      this.failure ??= err;
      await reader.cancel(err).catch(() => undefined);
      await this.compressor?.abort(err).catch(() => undefined);
    }
  }

  /** Drops the compressor of a step that failed, so a retry never races its uploads. */
  async abort(err: unknown): Promise<void> {
    this.failure ??= err;
    if (!this.compressor || this.closed) return;
    this.closed = true;
    await this.compressor.abort(err).catch(() => undefined);
    await this.drained;
  }

  private check(): void {
    if (this.failure !== null) throw this.failure;
  }

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (!this.compressor) return this.buffer(bytes);
    this.compressor.write(bytes).catch((err) => {
      this.failure ??= err;
    });
  }

  /** Ends the gzip member (if any) and waits until every part it produced is uploaded. */
  private async close(): Promise<void> {
    if (!this.compressor || this.closed) return;
    this.closed = true;
    await this.compressor.close().catch((err) => {
      this.failure ??= err;
    });
    await this.drained;
    this.check();
  }

  /** Streams a blob's bytes in, uploading each full part as soon as it fills; returns the byte count. */
  async pipe(stream: ReadableStream<Uint8Array>): Promise<number> {
    const reader = stream.getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return n;
      n += value.length;
      this.push(value);
      await this.flushFull();
    }
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0]!;
      const want = n - off;
      if (head.length <= want) {
        out.set(head, off);
        off += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, want), off);
        this.chunks[0] = head.subarray(want);
        off += want;
      }
    }
    this.length -= n;
    return out;
  }

  private upload(): R2MultipartUpload | Promise<R2MultipartUpload> {
    if (this.state.uploadId) return this.bucket.resumeMultipartUpload(this.key, this.state.uploadId);
    return this.bucket
      .createMultipartUpload(this.key, this.objectOptions())
      .then((u) => {
        this.state.uploadId = u.uploadId;
        return u;
      });
  }

  private objectOptions(): R2PutOptions & R2MultipartOptions {
    const format = formatOfKey(this.key);
    return {
      httpMetadata: { contentType: FORMAT_HTTP[format].contentType },
      customMetadata: { format: format === 'gzip' ? 'tar+gzip' : 'tar' },
    };
  }

  /** Gzip mode: waits until the compressor accepts more (the drain uploads parts). Plain: uploads full parts. */
  async flushFull(): Promise<void> {
    if (this.compressor) {
      await this.compressor.ready.catch((err) => {
        this.failure ??= err;
      });
      this.check();
      return;
    }
    await this.uploadFull();
  }

  private async uploadFull(): Promise<void> {
    while (this.length >= this.partSize) {
      const upload = await this.upload();
      const partNumber = this.state.parts.length + 1;
      const part = await upload.uploadPart(partNumber, this.take(this.partSize));
      this.state.parts.push(part);
      this.state.flushed += this.partSize;
      this.state.cost.parts++;
    }
  }

  /** Writes the remaining bytes as a single object or the final part, then completes. */
  async finish(): Promise<number> {
    await this.close();
    const size = this.state.flushed + this.length;
    if (!this.state.uploadId) {
      await this.bucket.put(this.key, this.take(this.length), this.objectOptions());
      return size;
    }
    const upload = await this.upload();
    try {
      if (this.length > 0) {
        const part = await upload.uploadPart(this.state.parts.length + 1, this.take(this.length));
        this.state.parts.push(part);
        this.state.cost.parts++;
      }
      await upload.complete(this.state.parts);
    } catch (err) {
      // A retry after a completed upload finds the object already in place.
      const head = await this.bucket.head(this.key);
      if (!head || head.size !== size) throw err;
    }
    return size;
  }

  /** Ends this step's gzip member and returns the unflushed bytes to carry to the next step. */
  async rest(): Promise<Uint8Array> {
    await this.close();
    return this.take(this.length);
  }
}

interface Pending {
  entry: TarEntry;
  hash: string | null;
}

/** One blob from the binding; a blob it refuses to buffer fails the build for good, saying so. */
async function readBlob(h: ArtifactsRepo, hash: string, path: string): Promise<Blob> {
  let blob: Blob | null;
  try {
    blob = await h.readBlob(hash);
  } catch (err) {
    if (errorCode(err) === 'MEMORY_LIMIT') {
      throw new NonRetryableError(`Artifacts MEMORY_LIMIT: blob ${hash} (${path}) is too large for the binding to buffer`);
    }
    throw err;
  }
  if (!blob) throw new Error(`blob ${hash} (${path}) not found`);
  return blob;
}

interface BlobRead {
  pending: Pending & { hash: string };
  blob: Promise<Blob>;
  size: number | null;
}

/**
 * Reads a step's blobs ahead of the tar writer, handing them out in tar
 * order. A blob's size is unknown until it arrives, so a further read is
 * admitted only while the returned blobs not yet released plus one estimate
 * per outstanding read fit the budget. The estimate is the largest of the
 * last few returned blobs, and the window opens by one read per returned
 * blob, starting from a single read in each step. A run of large blobs
 * right behind small ones can still push the held bytes past the budget,
 * by at most the reads already in flight.
 */
class BlobReader {
  private readonly queue: BlobRead[] = [];
  private readonly recent: number[] = [];
  private next = 0;
  private held = 0;
  private returned = 0;

  constructor(
    private readonly h: ArtifactsRepo,
    private readonly items: (Pending & { hash: string })[],
    private readonly cost: BuildCost,
    private readonly readAhead: number,
    private readonly budget: number,
  ) {}

  private estimate(): number {
    return this.recent.length === 0 ? Infinity : Math.max(...this.recent);
  }

  private fill(): void {
    while (this.next < this.items.length && this.queue.length < Math.min(this.readAhead, 1 + this.returned)) {
      if (this.queue.length > 0) {
        const est = this.estimate();
        const outstanding = this.queue.reduce((n, r) => n + (r.size ?? est), 0);
        if (outstanding + est > this.budget) return;
      }
      const pending = this.items[this.next++]!;
      this.cost.blobReads++;
      const read: BlobRead = {
        pending,
        size: null,
        blob: readBlob(this.h, pending.hash, pending.entry.path).then((blob) => {
          read.size = blob.size;
          this.returned++;
          this.held += blob.size;
          if (this.held > this.cost.peakHeld) this.cost.peakHeld = this.held;
          if (blob.size > this.cost.largestBlob) this.cost.largestBlob = blob.size;
          this.recent.push(blob.size);
          if (this.recent.length > this.readAhead) this.recent.shift();
          return blob;
        }),
      };
      // A failed read is reported when its turn comes; until then it must not be unhandled.
      read.blob.catch(() => undefined);
      this.queue.push(read);
    }
  }

  /** The next blob in tar order; call release() once it has been written. */
  async take(): Promise<Blob> {
    this.fill();
    const blob = await this.queue[0]!.blob;
    this.fill();
    return blob;
  }

  release(): void {
    const head = this.queue.shift()!;
    this.held -= head.size ?? 0;
    this.fill();
  }
}

async function batchStep(
  env: Env,
  target: BuildTarget,
  input: BatchState,
  carry: Uint8Array,
  index: number,
  opts: Required<BuildOptions>,
): Promise<{ state: BatchState; carry: Uint8Array }> {
  const state: BatchState = structuredClone(input);
  const log = { step: `batch-${index}`, instance: target.instanceId, tree: target.tree };
  return metered(env, state.cost, log, async (env) => {
    const writer = new PartWriter(env.SNAPSHOTS, target.key, opts.partSize, state, carry);
    await withRepo(env, target.artifactsName, async (h) => {
      const trees = new Map<string, ArtifactsTreeEntry[]>();
      const readTree = async (hash: string): Promise<ArtifactsTreeEntry[]> => {
        let entries = trees.get(hash);
        if (!entries) {
          state.cost.treeReads++;
          const read = await h.readTree(hash);
          if (!read) throw new Error(`tree ${hash} not found`);
          entries = read;
          trees.set(hash, entries);
        }
        return entries;
      };
      const stack = state.stack;
      await Promise.all(stack.map((f) => readTree(f.hash)));

      const pending: Pending[] = [];
      let blobs = 0;
      while (stack.length > 0 && blobs < opts.blobsPerStep) {
        const top = stack[stack.length - 1]!;
        const entries = trees.get(top.hash)!;
        if (top.next >= entries.length) {
          stack.pop();
          continue;
        }
        const e = entries[top.next++]!;
        const path = top.path ? `${top.path}/${e.name}` : e.name;
        const mapped = gitModeToTar(e.mode);
        if (!mapped) continue;
        const isTree = e.mode === '40000' || e.mode === '040000';
        if (!isTree) state.files++;
        if (mapped.type === 'dir') {
          pending.push({ entry: { path, ...mapped, mtime: target.mtime }, hash: null });
          if (isTree) {
            await readTree(e.hash);
            stack.push({ path, hash: e.hash, next: 0 });
          }
          continue;
        }
        pending.push({ entry: { path, ...mapped, mtime: target.mtime }, hash: e.hash });
        blobs++;
      }
      // Drop exhausted frames so the next step does not re-read their trees.
      while (stack.length > 0 && stack[stack.length - 1]!.next >= trees.get(stack[stack.length - 1]!.hash)!.length) {
        stack.pop();
      }

      const reader = new BlobReader(
        h,
        pending.filter((p): p is Pending & { hash: string } => p.hash !== null),
        state.cost,
        opts.readAhead,
        opts.readBudget,
      );
      for (const p of pending) {
        if (!p.hash) {
          writer.push(tarHeader(p.entry));
          continue;
        }
        const blob = await reader.take();
        if (p.entry.type === 'symlink') {
          writer.push(tarHeader({ ...p.entry, linkname: await blob.text() }));
        } else {
          writer.push(tarHeader({ ...p.entry, size: blob.size }));
          const n = await writer.pipe(blob.stream());
          if (n !== blob.size) throw new Error(`blob ${p.hash} (${p.entry.path}) streamed ${n} of ${blob.size} bytes`);
          writer.push(new Uint8Array(tarPadding(blob.size)));
        }
        reader.release();
        await writer.flushFull();
      }
      state.done = stack.length === 0;
    }).catch(async (err: unknown) => {
      await writer.abort(err);
      throw err;
    });
    if (!state.done) return { state, carry: await writer.rest() };
    writer.push(tarEnd());
    await writer.flushFull();
    state.size = await writer.finish();
    state.cost.objects = 1;
    state.cost.bytes = state.size;
    return { state, carry: new Uint8Array(0) };
  });
}

/** A batch result as one stream: u32 JSON length, the JSON state, then the carried tar bytes. */
export function encodeBatch(state: BatchState, carry: Uint8Array): ReadableStream<Uint8Array> {
  const json = encode(JSON.stringify(state));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, json.length);
  return new Blob([head, json, carry as Uint8Array<ArrayBuffer>]).stream();
}

export async function decodeBatch(stream: ReadableStream<Uint8Array>): Promise<{ state: BatchState; carry: Uint8Array }> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return { state: JSON.parse(decode(bytes.subarray(4, 4 + n))) as BatchState, carry: bytes.slice(4 + n) };
}

// ---------------------------------------------------------------------------
// finish / fail
// ---------------------------------------------------------------------------

async function finishStep(
  env: Env,
  p: Required<SnapshotParams> & { instanceId: string },
  target: BuildTarget,
  state: BatchState,
): Promise<BuildCost> {
  const cost = structuredClone(state.cost);
  const log = { step: 'finish', instance: p.instanceId, tree: target.tree };
  return metered(env, cost, log, async (env, meter, note) => {
    const now = Date.now();
    const db = env.DB;
    // Until the measured total is stored below, the ready rows carry the
    // cost of the steps before this one.
    const before = JSON.stringify(cost);
    const [treeReady] = await db.batch([
      db
        .prepare(
          `UPDATE snapshot_trees SET state = 'ready', size = ?4, files = ?5, built_at = ?6, build_cost = ?7, error = NULL
           WHERE repo_id = ?1 AND tree = ?2 AND builder = ?3 AND state = 'building'`,
        )
        .bind(p.repoId, target.tree, p.instanceId, state.size, state.files, now, before),
      db
        .prepare(
          `UPDATE snapshot_commits SET state = 'ready', built_at = ?4, error = NULL,
             build_cost = CASE WHEN sha = ?5 THEN ?6 ELSE build_cost END,
             reused = CASE WHEN sha = ?5 THEN 0 ELSE 1 END
           WHERE repo_id = ?1 AND tree = ?2 AND state = 'building'
             AND EXISTS (SELECT 1 FROM snapshot_trees t
                          WHERE t.repo_id = ?1 AND t.tree = ?2 AND t.builder = ?3 AND t.state = 'ready')`,
        )
        .bind(p.repoId, target.tree, p.instanceId, now, p.sha, before),
    ]);
    // No tree row moved: a successor took the tree over, an earlier run of
    // this step already finished it, or the repo was deleted mid-build. Only
    // the last leaves the object this build just completed unreferenced (the
    // repo delete ran before the object existed), so it is removed here.
    let repoGone = false;
    if ((treeReady?.meta?.changes ?? 0) === 0) {
      repoGone = !(await db.prepare('SELECT 1 AS ok FROM repos WHERE id = ?').bind(p.repoId).first());
      if (repoGone) {
        await env.SNAPSHOTS.delete(target.key);
        note.discarded = target.key;
      }
    }
    const final: BuildCost = {
      ...cost,
      steps: cost.steps + 1,
      d1: cost.d1 + meter.d1,
      rr: cost.rr + meter.rr,
      rw: cost.rw + meter.rw,
      art: cost.art + meter.art,
      r2a: cost.r2a + meter.r2a,
      r2b: cost.r2b + meter.r2b,
      sub: cost.sub + meter.sub,
    };
    if (repoGone) return final;
    const measured = JSON.stringify(final);
    // Both writes are fenced by tree ownership, not the commit's instance_id:
    // the attempt that built the tree measured the work even if the commit was
    // since taken over, and a superseded attempt must not replace the counters
    // of the successor that built it.
    note.excluded = await measureD1(meter, () =>
      db.batch([
        db
          .prepare(`UPDATE snapshot_trees SET build_cost = ?4 WHERE repo_id = ?1 AND tree = ?2 AND builder = ?3 AND state = 'ready'`)
          .bind(p.repoId, target.tree, p.instanceId, measured),
        db
          .prepare(
            `UPDATE snapshot_commits SET build_cost = ?4
             WHERE repo_id = ?1 AND sha = ?2 AND tree = ?3 AND state = 'ready' AND reused = 0
               AND EXISTS (SELECT 1 FROM snapshot_trees t
                            WHERE t.repo_id = ?1 AND t.tree = ?3 AND t.builder = ?5 AND t.state = 'ready')`,
          )
          .bind(p.repoId, p.sha, target.tree, measured, p.instanceId),
      ]),
    );
    return final;
  });
}

async function failStep(
  env: Env,
  p: Required<SnapshotParams> & { instanceId: string },
  tree: string | null,
  error: string,
): Promise<void> {
  const cost = emptyCost();
  await metered(env, cost, { step: 'fail', instance: p.instanceId, buildError: error }, async (env) => {
    const db = env.DB;
    // Fenced: this attempt fails its own commit only while it is the active
    // attempt, and the commits waiting on a tree only if it failed that tree.
    await db.batch([
      db
        .prepare(
          `UPDATE snapshot_trees SET state = 'failed', error = ?4
           WHERE repo_id = ?1 AND tree = ?2 AND builder = ?3 AND state = 'building'`,
        )
        .bind(p.repoId, tree, p.instanceId, error),
      db
        .prepare(
          `UPDATE snapshot_commits SET state = 'failed', error = ?4
           WHERE repo_id = ?1 AND state = 'building'
             AND ((sha = ?2 AND instance_id = ?5)
               OR (?3 IS NOT NULL AND tree = ?3 AND EXISTS (
                     SELECT 1 FROM snapshot_trees t
                      WHERE t.repo_id = ?1 AND t.tree = ?3 AND t.state = 'failed' AND t.builder = ?5)))`,
        )
        .bind(p.repoId, p.sha, tree, error, p.instanceId),
    ]);
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface BuildOutcome {
  outcome: 'built' | 'done';
  reason?: string;
  tree?: string;
  cost: BuildCost;
}

export async function buildSnapshot(
  env: Env,
  params: SnapshotParams & { instanceId: string },
  step: StepRunner,
  options: BuildOptions = {},
): Promise<BuildOutcome> {
  const opts: Required<BuildOptions> = {
    blobsPerStep: options.blobsPerStep ?? BLOBS_PER_STEP,
    partSize: options.partSize ?? PART_SIZE,
    readAhead: options.readAhead ?? READ_AHEAD,
    readBudget: options.readBudget ?? READ_BUDGET,
  };
  const p = { ...params, trigger: params.trigger ?? 'push' };
  let tree: string | null = null;
  try {
    const resolved = await step.do('resolve', () => resolveStep(env, p));
    if (resolved.action === 'done') return { outcome: 'done', reason: resolved.reason, cost: resolved.cost };
    tree = resolved.tree;
    const target: BuildTarget = {
      instanceId: p.instanceId,
      repoId: p.repoId,
      tree: resolved.tree,
      key: resolved.key,
      artifactsName: resolved.artifactsName,
      mtime: resolved.mtime,
    };
    let state: BatchState = {
      stack: [{ path: '', hash: resolved.tree, next: 0 }],
      uploadId: null,
      parts: [],
      flushed: 0,
      files: 0,
      done: false,
      size: 0,
      cost: resolved.cost,
    };
    let carry: Uint8Array = new Uint8Array(0);
    for (let i = 1; !state.done; i++) {
      const input = state;
      const inputCarry = carry;
      const out = await step.do(`batch-${i}`, async (ctx) => {
        // A retried batch may have died of a read-ahead surprise (a run of
        // unexpectedly large blobs), so retries read one blob at a time.
        const retry = (ctx?.attempt ?? 1) > 1;
        const r = await batchStep(env, target, input, inputCarry, i, retry ? { ...opts, readAhead: 1 } : opts);
        return encodeBatch(r.state, r.carry);
      });
      ({ state, carry } = await decodeBatch(out));
    }
    const finalState = state;
    const cost = await step.do('finish', () => finishStep(env, p, target, finalState));
    return { outcome: 'built', tree: target.tree, cost };
  } catch (err) {
    const message = errorMessage(err);
    const failedTree = tree;
    await step.do('fail', () => failStep(env, p, failedTree, message));
    throw err;
  }
}

const STEP_CONFIG = {
  retries: { limit: 4, delay: '5 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;

export class SnapshotBuilder extends WorkflowEntrypoint<Env, SnapshotParams> {
  async run(event: WorkflowEvent<SnapshotParams>, step: WorkflowStep) {
    const runner: StepRunner = {
      do: <T>(name: string, fn: (ctx?: { attempt: number }) => Promise<T>) =>
        step.do(name, STEP_CONFIG, fn as (ctx: { attempt: number }) => Promise<never>) as Promise<T>,
    };
    return buildSnapshot(this.env, { ...event.payload, instanceId: event.instanceId }, runner);
  }
}
