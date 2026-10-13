/**
 * Check runs (architecture §3/§4 services/checks.ts): the `check_runs` rows
 * with their tree identity, the `kvarm/guard` evaluation of a change's own
 * edits, the commit status rollup, reported runs, and the checks-gate
 * producer over all of them.
 *
 * The producer answers the gate from recorded runs only: the required runs
 * on the exact tree, plus the guard verdict of the head the tree publishes
 * (the guard judges a change's edits, which a merge or composition carries
 * unchanged). `kvarm/guard` is always required; a head it has not judged is
 * `pending`, never a pass. Concurrent gate questions in one request are
 * answered by one D1 batch of bounded index ranges.
 */

import { guard, guardWants, type GuardChange, type GuardContent, type GuardResult, type GuardUninspected } from '@kvarm/review';
import type { LazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { CHECKS_PRODUCERS, rollupState, type CheckState, type ChecksProducer, type ChecksSubject, type RequiredCheck } from './checksGate';
import { treePairBody, type CompareBody } from './compare';
import { activeQuarantinesStatement, markQuarantined, quarantineNames } from './flakes';
import { runPool } from './pool';
import { resolveCommitish, type ResolveContext } from './refs';

export const GUARD_CHECK = 'kvarm/guard';
export const CHECKS_WINDOW_CHECK = 'kvarm/checks-window';
/**
 * v2: an added line cut at the per-line scan limit makes the scan
 * incomplete (neutral, `line-prefix`) where v1 could conclude success.
 */
export const GUARD_VERSION = 'guard/v2';
const PRODUCER = 'check-runs';

export const GUARD_BUDGETS = {
  /** Bytes read from each side of a file; longer files are scanned up to this prefix. */
  maxBytesPerFile: 64 * 1024,
  /** Files whose content is scanned, in path order; later ones make the guard neutral (incomplete). */
  maxFiles: 100,
  concurrency: 6,
} as const;

export const CHECK_LIMITS = {
  /** Runs a commit status reads (newest first). */
  statusMax: 100,
  /** Newest counted runs the gate reads per tree (a check older than these is not seen). */
  gateRowsPerTree: 100,
  nameMax: 100,
  detailsUrlMax: 2048,
  summaryMaxBytes: 64 * 1024,
} as const;

const STATUSES = ['queued', 'running', 'success', 'failure', 'skipped'] as const;
type RunStatus = (typeof STATUSES)[number];
const CONCLUSIONS: Record<string, RunStatus> = {
  success: 'success',
  neutral: 'success',
  failure: 'failure',
  cancelled: 'failure',
  timed_out: 'failure',
  action_required: 'failure',
  skipped: 'skipped',
};

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

export const CHECK_RUN_COLUMNS = `k.id, k.name, k.head_sha, k.tree_sha, k.status, k.conclusion, k.details_url, k.attempt, k.required,
       k.quarantined, k.summary, k.started_at, k.finished_at, k.created_at`;

export interface CheckRunRow {
  id: string;
  name: string;
  head_sha: string;
  tree_sha: string | null;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  attempt: number | null;
  required: number | null;
  quarantined: number | null;
  summary: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

export interface CheckRunView {
  id: string;
  name: string;
  headSha: string;
  treeSha: string | null;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  attempt: number;
  required: boolean;
  quarantined: boolean;
  /** JSON summary (the guard's `{conclusion, findings[]}`), or the reported text. */
  summary: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function parseSummary(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function checkRunView(r: CheckRunRow): CheckRunView {
  return {
    id: r.id,
    name: r.name,
    headSha: r.head_sha,
    treeSha: r.tree_sha,
    status: r.status,
    conclusion: r.conclusion,
    detailsUrl: r.details_url,
    attempt: r.attempt ?? 1,
    required: (r.required ?? 1) === 1,
    quarantined: r.quarantined === 1,
    summary: parseSummary(r.summary),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    createdAt: iso(r.created_at)!,
  };
}

function stateOf(status: string): CheckState {
  if (status === 'failure') return 'failure';
  if (status === 'success' || status === 'skipped') return 'success';
  return 'pending';
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export interface GuardSummary extends GuardResult {
  version: typeof GUARD_VERSION;
  /**
   * One line for people: what the verdict proves. An incomplete run says so
   * first, whatever its conclusion, so a neutral never reads as a clean pass.
   */
  title: string;
  /** The trees compared: the change's merge base and its head. */
  baseTree: string;
  headTree: string;
  scanned: { files: number; bytes: number; blobReads: number };
}

const utf8 = new TextDecoder('utf-8');

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

type Side = { text: string; truncated: boolean } | { binary: true } | { unavailable: true };

async function readSide(artifacts: LazyRepo, hash: string, counter: { blobReads: number; bytes: number }): Promise<Side> {
  const handle = await artifacts.get();
  counter.blobReads++;
  let blob: Blob | null;
  try {
    blob = await handle.readBlob(hash);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'MEMORY_LIMIT') return { unavailable: true };
    throw err;
  }
  if (!blob) return { unavailable: true };
  const truncated = blob.size > GUARD_BUDGETS.maxBytesPerFile;
  const bytes = new Uint8Array(await (truncated ? blob.slice(0, GUARD_BUDGETS.maxBytesPerFile) : blob).arrayBuffer());
  counter.bytes += bytes.length;
  if (isBinary(bytes)) return { binary: true };
  return { text: utf8.decode(bytes), truncated };
}

const GITLINK_MODE = '160000';

/**
 * The guard over `baseTree → headTree` (the change's merge base and head):
 * the file list from the content-addressed compare body (`known` when the
 * caller already holds it), then at most GUARD_BUDGETS.maxFiles files'
 * texts, each side read up to maxBytesPerFile.
 */
export async function evaluateGuard(ctx: ResolveContext, baseTree: string, headTree: string, known?: CompareBody): Promise<GuardSummary> {
  const body = known ?? (await treePairBody(ctx, baseTree, headTree)).body;
  // The compare body marks a file binary when either side is: only an added one is surely binary on its new
  // side. For the rest the guard sniffs the new side itself, so text replacing a binary file is still scanned.
  const changes: GuardChange[] = body.files.map((f) => ({
    path: f.path,
    status: f.status,
    ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
    ...((f.binary && f.status === 'added') || f.newMode === GITLINK_MODE ? { binary: true } : {}),
  }));
  const contents = new Map<string, GuardContent>();
  const wanted: Array<{ i: number; old: boolean }> = [];
  changes.forEach((c, i) => {
    const w = guardWants(c);
    if (!w.new) return;
    if (wanted.length >= GUARD_BUDGETS.maxFiles) contents.set(c.path, { unavailable: true, overFileBudget: true });
    else wanted.push({ i, old: w.old && body.files[i]!.oldHash !== null && !body.files[i]!.binary });
  });
  const counter = { blobReads: 0, bytes: 0 };
  await runPool(wanted, GUARD_BUDGETS.concurrency, async ({ i, old }) => {
    const f = body.files[i]!;
    const [before, after] = await Promise.all([
      old && f.oldHash ? readSide(ctx.artifacts, f.oldHash, counter) : null,
      f.newHash ? readSide(ctx.artifacts, f.newHash, counter) : ({ unavailable: true } as const),
    ]);
    if ('binary' in after) {
      changes[i] = { ...changes[i]!, binary: true };
      return;
    }
    if ('unavailable' in after || (before && 'unavailable' in before)) {
      contents.set(f.path, { unavailable: true });
      return;
    }
    // A binary old side has no lines to subtract: every line of the new text counts as added.
    const oldText = before && 'text' in before ? before : null;
    contents.set(f.path, {
      old: oldText ? oldText.text : null,
      new: after.text,
      ...(after.truncated || oldText?.truncated ? { truncated: true } : {}),
    });
  });
  const result = guard(changes, contents, { listTruncated: body.truncated });
  return {
    version: GUARD_VERSION,
    title: guardTitle(result),
    ...result,
    baseTree,
    headTree,
    scanned: { files: wanted.length, bytes: counter.bytes, blobReads: counter.blobReads },
  };
}

function uninspectedPhrase(u: GuardUninspected): string {
  const files = `${u.count} changed file(s) not fully inspected`;
  if (!u.listTruncated) return files;
  const listed = 'the change list was truncated, so files past it were not inspected';
  return u.count > 0 ? `${listed}, and ${files}` : listed;
}

export function guardTitle(r: GuardResult): string {
  const counted = r.findings.length + (r.omitted ?? 0);
  if (!r.complete && r.uninspected) {
    return `incomplete: ${uninspectedPhrase(r.uninspected)}; the guard cannot vouch for content it did not read (${r.conclusion})`;
  }
  if (r.conclusion === 'failure') return `failed: ${counted} finding(s)`;
  if (r.conclusion === 'neutral') return `neutral: ${counted} advisory finding(s); every changed text file the guard covers was read in full`;
  return 'passed: every changed text file the guard covers was read in full and nothing was found';
}

/**
 * How much of its change a recorded guard summary did not inspect, or null
 * when it inspected everything. Runs recorded before `complete` existed
 * count as incomplete when they carry a guard/incomplete finding or
 * omitted findings (which could have hidden one).
 */
export function guardIncompleteness(summary: unknown): { uninspected: number } | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as { complete?: unknown; uninspected?: { count?: unknown }; findings?: unknown; omitted?: unknown; conclusion?: unknown };
  if (typeof s.complete === 'boolean') {
    if (s.complete) return null;
    return { uninspected: typeof s.uninspected?.count === 'number' ? s.uninspected.count : 0 };
  }
  const findings = Array.isArray(s.findings) ? (s.findings as Array<{ rule?: unknown }>) : [];
  const legacy = findings.some((f) => f?.rule === 'guard/incomplete') || (typeof s.omitted === 'number' && s.omitted > 0 && s.conclusion !== 'success');
  return legacy ? { uninspected: 0 } : null;
}

function guardStatus(s: GuardSummary): { status: RunStatus; conclusion: string } {
  if (s.conclusion === 'failure') return { status: 'failure', conclusion: 'failure' };
  return { status: 'success', conclusion: s.conclusion };
}

/**
 * Records a guard run for a change's head; a no-op when the change already
 * has one for that head judged against the same base tree (push deliveries
 * repeat). A head whose merge base moved (a stacked change whose base
 * landed) gets a second run for the new base.
 */
export function guardRunInsert(
  db: D1Database,
  run: { repoId: string; changeId: string; headSha: string; treeSha: string; summary: GuardSummary; startedAt: number; now: number },
): D1PreparedStatement {
  const { status, conclusion } = guardStatus(run.summary);
  return db
    .prepare(
      `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, tree_sha, name, status, conclusion, summary, attempt, required, quarantined,
                               started_at, finished_at, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, '${GUARD_CHECK}', ?6, ?7, ?8, 1, 1, 0, ?9, ?10, ?10
        WHERE NOT EXISTS (SELECT 1 FROM check_runs k WHERE k.repo_id = ?2 AND k.head_sha = ?4 AND k.name = '${GUARD_CHECK}' AND k.change_set_id = ?3
                            AND json_extract(k.summary, '$.baseTree') IS json_extract(?8, '$.baseTree'))`,
    )
    .bind(crypto.randomUUID(), run.repoId, run.changeId, run.headSha, run.treeSha, status, conclusion, JSON.stringify(run.summary), run.startedAt, run.now);
}

/**
 * Whether the change already has a guard run for the head (one indexed
 * probe), or, given `baseTree`, one judged against that base tree.
 */
export function guardRunExists(db: D1Database, repoId: string, changeId: string, headSha: string, baseTree?: string): D1PreparedStatement {
  return baseTree === undefined
    ? db
        .prepare(`SELECT 1 AS found FROM check_runs k WHERE k.repo_id = ?1 AND k.head_sha = ?2 AND k.name = '${GUARD_CHECK}' AND k.change_set_id = ?3 LIMIT 1`)
        .bind(repoId, headSha, changeId)
    : db
        .prepare(
          `SELECT 1 AS found FROM check_runs k WHERE k.repo_id = ?1 AND k.head_sha = ?2 AND k.name = '${GUARD_CHECK}' AND k.change_set_id = ?3
              AND json_extract(k.summary, '$.baseTree') = ?4 LIMIT 1`,
        )
        .bind(repoId, headSha, changeId, baseTree);
}

/** Whether a gate answer's `kvarm/guard` entry is pending. */
export function guardPending(checks: { required: ReadonlyArray<{ name: string; state: string }> }): boolean {
  return checks.required.some((c) => c.name === GUARD_CHECK && c.state === 'pending');
}

// ---------------------------------------------------------------------------
// The checks-gate producer
// ---------------------------------------------------------------------------

interface GateRow {
  id: string;
  name: string;
  status: string;
  tree_sha: string | null;
  head_sha: string;
  summary: string | null;
  created_at: number;
}

const GATE_COLUMNS = 'k.id, k.name, k.status, k.tree_sha, k.head_sha, k.summary, k.created_at';

interface Pending {
  treeSha: string;
  subject: ChecksSubject | null;
  resolve(v: Array<Omit<RequiredCheck, 'producer'>>): void;
  reject(err: unknown): void;
}

/** The gate's kvarm/guard entry for a recorded run, or pending when it judged another merge-base tree. */
function guardAnswer(row: GateRow, guardBaseTree: string): Omit<RequiredCheck, 'producer'> {
  const summary = parseSummary(row.summary);
  if ((summary as { baseTree?: unknown } | null)?.baseTree !== guardBaseTree) return { name: GUARD_CHECK, state: 'pending' };
  const missing = guardIncompleteness(summary);
  return { name: GUARD_CHECK, state: stateOf(row.status), runId: row.id, ...(missing ? { incomplete: true as const, uninspected: missing.uninspected } : {}) };
}

function answer(
  treeRows: readonly GateRow[],
  guardRows: readonly GateRow[],
  subject: ChecksSubject | null,
  treeWindowFull: boolean,
  quarantined: ReadonlySet<string>,
): Array<Omit<RequiredCheck, 'producer'>> {
  const newest = new Map<string, GateRow>();
  // Rows arrive newest first: the first row per name is its current run.
  for (const r of treeRows) if (r.name !== GUARD_CHECK && !newest.has(r.name)) newest.set(r.name, r);
  const out: Array<Omit<RequiredCheck, 'producer'>> = [...newest.values()].map((r) => ({
    name: r.name,
    state: stateOf(r.status),
    runId: r.id,
    ...(quarantined.has(r.name) ? { quarantined: true as const } : {}),
  }));
  const guard = subject ? guardRows[0] : undefined;
  out.push(guard ? guardAnswer(guard, subject!.guardBaseTree) : { name: GUARD_CHECK, state: 'pending' });
  if (treeWindowFull) out.push({ name: CHECKS_WINDOW_CHECK, state: 'pending' });
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One producer per gate (per request): questions asked together share one D1 batch per repo. */
export function checkRunsProducer(env: Pick<Env, 'DB'>): ChecksProducer {
  const queued = new Map<string, Pending[]>();
  let scheduled = false;

  const flush = async (repoId: string, batch: Pending[]) => {
    try {
      const trees = [...new Set(batch.map((p) => p.treeSha))].map((value) => ({ kind: 'tree' as const, value }));
      const guards = new Map(
        batch.flatMap((p) =>
          p.subject ? [[`${p.subject.changeId}:${p.subject.headSha}`, { kind: 'guard' as const, value: p.subject.headSha, changeId: p.subject.changeId }] as const] : [],
        ),
      ).values();
      const keys: Array<{ kind: 'tree'; value: string } | { kind: 'guard'; value: string; changeId: string }> = [...trees, ...guards];
      // One statement per key, each a bounded index range (a tree's newest counted runs, a head's newest
      // guard run), in one batch: D1 caps the terms of a compound SELECT well below the keys of a request.
      const statements = keys.map((k) =>
        k.kind === 'tree'
          ? env.DB.prepare(
              `SELECT ${GATE_COLUMNS} FROM check_runs k INDEXED BY idx_checks_tree_gate
                WHERE k.repo_id = ?1 AND k.tree_sha = ?2 AND k.required = 1 AND k.quarantined = 0
                ORDER BY k.created_at DESC, k.id DESC LIMIT ${CHECK_LIMITS.gateRowsPerTree}`,
            ).bind(repoId, k.value)
          : env.DB.prepare(
              `SELECT ${GATE_COLUMNS} FROM check_runs k INDEXED BY idx_checks_sha_name_newest
                WHERE k.repo_id = ?1 AND k.head_sha = ?2 AND k.name = '${GUARD_CHECK}' AND k.change_set_id = ?3
                  AND k.required = 1 AND k.quarantined = 0
                ORDER BY k.created_at DESC, k.id DESC LIMIT 1`,
            ).bind(repoId, k.value, k.changeId),
      );
      // Quarantine is read with the runs, so one answer never mixes two quarantine states (services/flakes.ts).
      statements.push(activeQuarantinesStatement(env.DB, repoId, Date.now()));
      const results = await env.DB.batch<GateRow>(statements);
      const quarantined = quarantineNames(results[keys.length]?.results);
      const rows = new Map(keys.map((k, i) => [`${k.kind}:${k.kind === 'guard' ? `${k.changeId}:` : ''}${k.value}`, results[i]?.results ?? []]));
      for (const p of batch) {
        const treeRows = rows.get(`tree:${p.treeSha}`) ?? [];
        const guardRows = p.subject ? (rows.get(`guard:${p.subject.changeId}:${p.subject.headSha}`) ?? []) : [];
        p.resolve(answer(treeRows, guardRows, p.subject, treeRows.length === CHECK_LIMITS.gateRowsPerTree, quarantined));
      }
    } catch (err) {
      for (const p of batch) p.reject(err);
    }
  };

  return {
    name: PRODUCER,
    requiredChecksFor(repo, treeSha, _configId, subject?: ChecksSubject) {
      return new Promise((resolve, reject) => {
        const list = queued.get(repo.id) ?? [];
        list.push({ treeSha, subject: subject ?? null, resolve, reject });
        queued.set(repo.id, list);
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          const all = [...queued.entries()];
          queued.clear();
          for (const [repoId, batch] of all) void flush(repoId, batch);
        });
      });
    },
  };
}

CHECKS_PRODUCERS.push((env) => checkRunsProducer(env));

// ---------------------------------------------------------------------------
// Commit status
// ---------------------------------------------------------------------------

export interface CommitStatus {
  sha: string;
  /** Rollup of each check's newest run that counts (required, not quarantined); `none` without runs. */
  state: CheckState | 'none';
  total: number;
  checks: CheckRunView[];
  /**
   * Names of checks whose newest run did not inspect everything it covers
   * (kvarm/guard past its read budgets), whatever its conclusion: a
   * success in `state` does not prove those runs saw all of the content.
   */
  incomplete: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * GET commits/:sha/status — one batch: the bounded indexed newest runs per
 * check name and the active quarantines (a quarantined check is neutral).
 */
export async function commitStatus(env: Env, repo: RepoRow, sha: string): Promise<ServiceResult<CommitStatus>> {
  if (!SHA_RE.test(sha)) return { ok: false, status: 422, error: 'sha must be a full 40-character commit id', code: 'INVALID_SHA' };
  const [runs, quarantines] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${CHECK_RUN_COLUMNS} FROM check_runs k WHERE k.repo_id = ?1 AND k.head_sha = ?2
        ORDER BY k.created_at DESC, k.id DESC LIMIT ${CHECK_LIMITS.statusMax}`,
    ).bind(repo.id, sha),
    activeQuarantinesStatement(env.DB, repo.id, Date.now()),
  ]);
  const seen = new Set<string>();
  let checks: CheckRunView[] = [];
  for (const r of (runs?.results ?? []) as CheckRunRow[]) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    checks.push(checkRunView(r));
  }
  checks = markQuarantined(checks, quarantineNames(quarantines?.results as Array<{ name: string }> | undefined));
  const counted = checks.filter((c) => c.required && !c.quarantined).map((c) => ({ state: stateOf(c.status) }));
  const incomplete = checks.filter((c) => c.name === GUARD_CHECK && guardIncompleteness(c.summary)).map((c) => c.name);
  return { ok: true, value: { sha, state: checks.length === 0 ? 'none' : rollupState(counted), total: checks.length, checks, incomplete } };
}

// ---------------------------------------------------------------------------
// Reported runs (POST check-runs, ci scope)
// ---------------------------------------------------------------------------

interface ReportInput {
  headSha: string;
  name: string;
  status: RunStatus;
  conclusion: string | null;
  detailsUrl: string | null;
  required: boolean;
  summary: string | null;
}

function parseReport(input: unknown): ServiceResult<ReportInput> {
  const bad = (error: string, code: string): ServiceResult<ReportInput> => ({ ok: false, status: 422, error, code });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, status: 400, error: 'body must be a JSON object', code: 'INVALID_BODY' };
  const b = input as Record<string, unknown>;
  const headSha = b.headSha ?? b.head_sha;
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) return bad('headSha must be a full 40-character commit id', 'INVALID_SHA');
  if (typeof b.name !== 'string' || b.name.trim() === '' || b.name.length > CHECK_LIMITS.nameMax) {
    return bad(`name is required (1-${CHECK_LIMITS.nameMax} characters)`, 'INVALID_NAME');
  }
  const name = b.name.trim();
  if (name.toLowerCase().startsWith('kvarm/')) return bad('check names under kvarm/ are reserved for the platform', 'RESERVED_CHECK_NAME');
  let conclusion: string | null = null;
  let status: RunStatus;
  if (b.conclusion !== undefined && b.conclusion !== null) {
    if (typeof b.conclusion !== 'string' || !(b.conclusion in CONCLUSIONS)) {
      return bad(`conclusion must be one of ${Object.keys(CONCLUSIONS).join(', ')}`, 'INVALID_CONCLUSION');
    }
    conclusion = b.conclusion;
    status = CONCLUSIONS[b.conclusion]!;
    if (b.status !== undefined && b.status !== 'completed' && b.status !== status) {
      return bad('status contradicts the conclusion (omit status or pass "completed")', 'INVALID_STATUS');
    }
  } else {
    const s = b.status ?? 'queued';
    if (typeof s !== 'string' || !(STATUSES as readonly string[]).includes(s)) return bad(`status must be one of ${STATUSES.join(', ')}`, 'INVALID_STATUS');
    status = s as RunStatus;
    if (status === 'success' || status === 'failure' || status === 'skipped') conclusion = status;
  }
  let detailsUrl: string | null = null;
  if (b.detailsUrl !== undefined && b.detailsUrl !== null) {
    if (typeof b.detailsUrl !== 'string' || b.detailsUrl.length > CHECK_LIMITS.detailsUrlMax || !/^https?:\/\//.test(b.detailsUrl)) {
      return bad('detailsUrl must be an http(s) URL', 'INVALID_URL');
    }
    detailsUrl = b.detailsUrl;
  }
  if (b.required !== undefined && typeof b.required !== 'boolean') return bad('required must be a boolean', 'INVALID_REQUIRED');
  let summary: string | null = null;
  if (b.summary !== undefined && b.summary !== null) {
    summary = JSON.stringify(b.summary);
    if (new TextEncoder().encode(summary).length > CHECK_LIMITS.summaryMaxBytes) return bad(`summary must be at most ${CHECK_LIMITS.summaryMaxBytes} bytes`, 'SUMMARY_TOO_LARGE');
  }
  return { ok: true, value: { headSha, name, status, conclusion, detailsUrl, required: b.required !== false, summary } };
}

export interface ReportedRun {
  run: CheckRunView;
  /** The live change whose head the run reports on, if any. */
  change: { number: number; policy: string; baseRef: string; queued: boolean } | null;
}

/**
 * POST check-runs: one commit read for the tree, then one batch (insert
 * linked to the live change at that head, change read-back).
 */
export async function reportCheckRun(ctx: ResolveContext, input: unknown): Promise<ServiceResult<ReportedRun>> {
  const parsed = parseReport(input);
  if (!parsed.ok) return parsed;
  const p = parsed.value;
  const commit = (await resolveCommitish(ctx, [p.headSha])).get(p.headSha);
  if (!commit) return { ok: false, status: 422, error: `commit not found: ${p.headSha}`, code: 'COMMIT_NOT_FOUND' };
  const db = ctx.env.DB;
  const id = crypto.randomUUID();
  const now = Date.now();
  const live = `SELECT c.id FROM change_sets c WHERE c.repo_id = ?2 AND c.head_sha = ?4 AND c.state IN ('open', 'conflicted') ORDER BY c.number DESC LIMIT 1`;
  const done = p.status === 'success' || p.status === 'failure' || p.status === 'skipped';
  const [, runRead, changeRead] = await db.batch([
    db
      .prepare(
        `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, tree_sha, name, status, conclusion, details_url, summary, attempt, required,
                                 quarantined, started_at, finished_at, created_at)
         VALUES (?1, ?2, (${live}), ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, 0, ?12, ?13, ?3)`,
      )
      .bind(id, ctx.repo.id, now, p.headSha, commit.tree, p.name, p.status, p.conclusion, p.detailsUrl, p.summary, p.required ? 1 : 0, p.status === 'queued' ? null : now, done ? now : null),
    db.prepare(`SELECT ${CHECK_RUN_COLUMNS} FROM check_runs k WHERE k.id = ?`).bind(id),
    db
      .prepare(
        `SELECT c.number, c.merge_policy, c.base_ref,
                EXISTS (SELECT 1 FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1) AS queued
           FROM change_sets c WHERE c.id = (SELECT k.change_set_id FROM check_runs k WHERE k.id = ?)`,
      )
      .bind(id),
  ]);
  const row = (runRead?.results as CheckRunRow[] | undefined)?.[0];
  if (!row) return { ok: false, status: 500, error: 'check run could not be recorded', code: 'CREATE_FAILED' };
  const c = (changeRead?.results as Array<{ number: number; merge_policy: string; base_ref: string; queued: number }> | undefined)?.[0];
  return {
    ok: true,
    value: { run: checkRunView(row), change: c ? { number: c.number, policy: c.merge_policy, baseRef: c.base_ref, queued: c.queued === 1 } : null },
  };
}

/** PATCH check-runs/:id — terminal/status updates for an externally created run. */
export async function updateCheckRun(env: Env, repo: RepoRow, id: string, input: unknown): Promise<ServiceResult<ReportedRun>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, status: 400, error: 'body must be a JSON object', code: 'INVALID_BODY' };
  }
  const b = input as Record<string, unknown>;
  const conclusion = b.conclusion;
  const status = conclusion === undefined ? b.status : CONCLUSIONS[String(conclusion)];
  if (conclusion !== undefined && (typeof conclusion !== 'string' || !(conclusion in CONCLUSIONS))) {
    return { ok: false, status: 422, error: `conclusion must be one of ${Object.keys(CONCLUSIONS).join(', ')}`, code: 'INVALID_CONCLUSION' };
  }
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
    return { ok: false, status: 422, error: `status must be one of ${STATUSES.join(', ')}`, code: 'INVALID_STATUS' };
  }
  let summary: string | null | undefined;
  if ('summary' in b) {
    summary = b.summary === null ? null : JSON.stringify(b.summary);
    if (summary !== null && new TextEncoder().encode(summary).length > CHECK_LIMITS.summaryMaxBytes) {
      return { ok: false, status: 422, error: `summary must be at most ${CHECK_LIMITS.summaryMaxBytes} bytes`, code: 'SUMMARY_TOO_LARGE' };
    }
  }
  const now = Date.now();
  const terminal = status === 'success' || status === 'failure' || status === 'skipped';
  const [updated, changeRead, ownershipRead] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE check_runs SET status = ?3, conclusion = ?4,
          summary = CASE WHEN ?5 IS NULL THEN summary ELSE ?5 END,
          started_at = CASE WHEN ?3 = 'queued' THEN started_at ELSE COALESCE(started_at, ?6) END,
          finished_at = CASE WHEN ?7 = 1 THEN ?6 ELSE NULL END
       WHERE id = ?1 AND repo_id = ?2 AND name NOT LIKE 'kvarm/%'
         AND NOT EXISTS (SELECT 1 FROM ci_jobs j WHERE j.check_run_id = check_runs.id)
         AND NOT EXISTS (SELECT 1 FROM check_runs r WHERE r.retry_of = check_runs.id)
       RETURNING ${CHECK_RUN_COLUMNS.replaceAll('k.', '')}`,
    ).bind(id, repo.id, status, conclusion ?? (terminal ? status : null), summary === undefined ? null : summary, now, terminal ? 1 : 0),
    env.DB.prepare(
      `SELECT c.number, c.merge_policy, c.base_ref,
              EXISTS (SELECT 1 FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1) AS queued
         FROM change_sets c WHERE c.id = (SELECT change_set_id FROM check_runs WHERE id = ?1 AND repo_id = ?2)`,
    ).bind(id, repo.id),
    env.DB.prepare(
      `SELECT name, EXISTS (SELECT 1 FROM ci_jobs j WHERE j.check_run_id = k.id)
                    OR EXISTS (SELECT 1 FROM check_runs r WHERE r.retry_of = k.id) AS runner_owned
         FROM check_runs k WHERE k.id = ?1 AND k.repo_id = ?2`,
    ).bind(id, repo.id),
  ]);
  const row = (updated?.results as CheckRunRow[] | undefined)?.[0];
  if (!row) {
    const owned = (ownershipRead?.results as Array<{ name: string; runner_owned: number }> | undefined)?.[0];
    if (owned) {
      return {
        ok: false,
        status: 403,
        error: owned.name.startsWith('kvarm/') ? 'platform check runs cannot be updated' : 'runner-owned check runs must be updated through CI reporting',
        code: 'RESERVED_CHECK_RUN',
      };
    }
    return { ok: false, status: 404, error: 'check run not found', code: 'CHECK_RUN_NOT_FOUND' };
  }
  const c = (changeRead?.results as Array<{ number: number; merge_policy: string; base_ref: string; queued: number }> | undefined)?.[0];
  return {
    ok: true,
    value: {
      run: checkRunView(row),
      change: c ? { number: c.number, policy: c.merge_policy, baseRef: c.base_ref, queued: c.queued === 1 } : null,
    },
  };
}

