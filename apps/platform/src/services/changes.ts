/**
 * Change requests (architecture §4 services/changes.ts, §5, invariant 5).
 *
 * A change is a row in `change_sets`: a head branch proposed for a base
 * branch, numbered per repo. Creation resolves both branches fresh (one
 * ls-refs round trip) and records the head SHA; push events move the head
 * afterwards (services/events.ts folds the guarded UPDATE into its ingest
 * batch, so a late older event never rolls the head back).
 *
 * The rating is the compare rating of the base tip's tree against the head
 * tree, served from the same tree-pair cache as `compare/<base>...<head>`.
 * Mergeability and merges go through services/merge.ts and the checks-gate
 * only; the contributor's merge policy decides when a merge may happen:
 * `draft` never, `review` on an explicit merge call, `auto` as soon as the
 * change is mergeable and every required check passed (immediately while
 * the gate has no producers).
 */

import { ZERO_OID, type MergeResolution } from '@kvarm/gitops';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import { internalKey, readCachedJson, writeCachedJson } from '../cache/internal';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { attributeMerge, mergeAttributionDefaults, parseAttributionInput, type AttributionInput } from './attribution';
import { credentialMayUpdateRef, type Actor } from './authz';
import { BRANCH_RULE_COLUMNS, effectivePolicy, repoBranchRulesSelect, ruleFromRow, type BranchPolicy, type BranchRule, type BranchRuleRow } from './branchRules';
import {
  CHECK_RUN_COLUMNS,
  GUARD_CHECK,
  checkRunView,
  evaluateGuard,
  guardPending,
  guardRunExists,
  guardRunInsert,
  type CheckRunRow,
  type CheckRunView,
  type GuardSummary,
} from './checks';
import { defaultChecksGate, type ChecksGate, type ChecksSubject, type RequiredChecks } from './checksGate';
import { treePairBody, treePairRating, type CompareBody } from './compare';
import {
  blockFromRows,
  changeDependenciesStatement,
  changeNumberDependenciesStatement,
  handOffSettlement,
  landedDependentsStatement,
  landedWakeMarksStatement,
  preservationRefusal,
  satisfyLandedStatement,
  settleLanded,
  type DependencyRow,
  type DependencyView,
  type LandedRow,
} from './dependencyGate';
import {
  conflictTransition,
  conflictViews,
  markConflictedStatements,
  parseConflictRecord,
  reconcileConflicts,
  retireConflictTaskStatement,
  transitionStatements,
  type ConflictView,
} from './conflicts';
import { artifactsPusher, type GitPusher } from './gitwrite';
import { changeSignalCleanup } from './intents/store';
import {
  artifactsMergeSources,
  computeMergePlan,
  isCrissCrossRefusal,
  overlaySources,
  prepareMerge,
  publishMerge,
  type Mergeability,
  type MergeErrorCode,
  type MergePlanView,
  type MergeStatus,
  type MergeWork,
} from './merge';
import { RefStoreUnavailable, isValidRefName, lsRefs, resolveCommitish, type ResolveContext } from './refs';
import {
  parseReviewFacts,
  recordMissingEscalation,
  reviewFactsSelect,
  reviewFactsSelectById,
  reviewGate,
  type ReviewBlockDetail,
  type ReviewFacts,
  type ReviewFactsRow,
} from './reviewGate';
import type { ChangeRating } from './risk';
import { kickTrain } from './trainKick';
import { ciCleanupStatement, hasCiJobs, queueChangeCi, queueExactTreeCi } from './ci';
import { activeQuarantinesStatement, flakeCleanupStatements, markQuarantined, quarantineNames } from './flakes';

export const MERGE_POLICIES = ['auto', 'draft', 'review'] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];
export type ChangeState = 'open' | 'merged' | 'conflicted' | 'closed';
const LIST_STATES = ['open', 'closed', 'merged', 'conflicted', 'all'] as const;

export const CHANGE_LIMITS = {
  titleMax: 256,
  bodyMax: 65_536,
  pageDefault: 50,
  pageMax: 100,
  /** Check runs returned with a change; the query is bounded so detail cost stays constant. */
  checksMax: 100,
  /** Conflicts listed in a mergeability view. */
  conflictsMax: 100,
};

const ZERO_SHA = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

export interface ChangeRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string | null;
  base_ref: string;
  head_ref: string;
  head_sha: string | null;
  base_sha: string | null;
  state: ChangeState;
  author_id: string | null;
  author_login: string | null;
  agent_meta: string | null;
  merge_commit: string | null;
  merged_at: number | null;
  created_at: number;
  updated_at: number | null;
  merge_policy: MergePolicy;
  risk_score: number | null;
  risk_level: string | null;
  risk_reasons: string | null;
  kind: string;
  source_change_id: string | null;
  /** State of the change's active merge-queue entry (services/queue.ts), null when not queued. */
  queue_state: string | null;
  /** The agent workspace linked to this change set (services/workspaces.ts), if any. */
  workspace_id: string | null;
  /** JSON ConflictRecord (services/conflicts.ts) while the change is conflicted. */
  conflicts: string | null;
}

const CHANGE_SELECT = `SELECT c.id, c.repo_id, c.number, c.title, c.body, c.base_ref, c.head_ref, c.head_sha, c.base_sha,
       c.state, c.author_id, u.login AS author_login, c.agent_meta, c.merge_commit, c.merged_at, c.created_at,
       c.updated_at, c.merge_policy, c.risk_score, c.risk_level, c.risk_reasons, c.kind, c.source_change_id, c.conflicts,
       (SELECT q.state FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1) AS queue_state,
       (SELECT w.id FROM workspaces w WHERE w.change_set_id = c.id LIMIT 1) AS workspace_id
  FROM change_sets c LEFT JOIN users u ON u.id = c.author_id`;

export interface ChangeView {
  number: number;
  title: string;
  body: string | null;
  state: ChangeState;
  mergePolicy: MergePolicy;
  kind: string;
  base: string;
  head: string;
  baseSha: string | null;
  headSha: string | null;
  author: string | null;
  agent: { id: string; name: string } | null;
  mergeCommit: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Id of the agent workspace this change set was opened from, or null. */
  workspace: string | null;
  /** State of the change's merge-queue entry (`GET queue`), null when it is not queued. */
  queueState: string | null;
  /** The conflicts that made the change `conflicted` (empty otherwise). */
  conflicts: ConflictView[];
  conflictsTruncated?: true;
}

export interface MergeabilityView {
  status: MergeStatus;
  /** Fast-forward or clean, and every required check passed. */
  mergeable: boolean;
  fastForward: boolean;
  conflicts: ConflictView[];
  conflictsTruncated?: true;
  /** Paths both sides changed that the deterministic rules merged, with the rule. */
  resolved: MergeResolution[];
  resolvedTruncated?: true;
  targetSha: string;
  headSha: string;
  mergeBase: string | null;
  /** Every merge base when there are several (a criss-cross merged through a virtual base). */
  mergeBases?: string[];
  treeSha: string | null;
  unknownReason?: string;
  checks: RequiredChecks | null;
}

export interface ChangeDetail extends ChangeView {
  rating: ChangeRating | null;
  mergeability: MergeabilityView | null;
  checks: CheckRunView[];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function parseAgent(meta: string | null): { id: string; name: string } | null {
  if (!meta) return null;
  try {
    const v = JSON.parse(meta) as { agentId?: unknown; agentName?: unknown };
    return typeof v.agentId === 'string' && typeof v.agentName === 'string' ? { id: v.agentId, name: v.agentName } : null;
  } catch {
    return null;
  }
}

export function changeView(row: ChangeRow): ChangeView {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    mergePolicy: row.merge_policy,
    kind: row.kind,
    base: row.base_ref,
    head: row.head_ref,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    author: row.author_login,
    agent: parseAgent(row.agent_meta),
    mergeCommit: row.merge_commit,
    mergedAt: iso(row.merged_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at ?? row.created_at)!,
    workspace: row.workspace_id ?? null,
    queueState: row.queue_state ?? null,
    ...storedConflicts(row),
  };
}

function storedConflicts(row: Pick<ChangeRow, 'state' | 'conflicts'>): { conflicts: ConflictView[]; conflictsTruncated?: true } {
  const record = row.state === 'conflicted' ? parseConflictRecord(row.conflicts) : null;
  if (!record) return { conflicts: [] };
  return { conflicts: record.conflicts, ...(record.truncated ? { conflictsTruncated: true as const } : {}) };
}

function storedRating(row: ChangeRow): ChangeRating | null {
  if (row.risk_score === null || row.risk_level === null) return null;
  let reasons: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.risk_reasons ?? '[]');
    if (Array.isArray(parsed)) reasons = parsed.filter((r): r is string => typeof r === 'string');
  } catch {
    // stored reasons are informational
  }
  return { score: row.risk_score, level: row.risk_level as ChangeRating['level'], reasons };
}

function mergeabilityView(m: Mergeability): MergeabilityView {
  const { conflicts, truncated } = conflictViews(m.conflicts);
  const resolved = m.resolved.slice(0, CHANGE_LIMITS.conflictsMax);
  return {
    status: m.status,
    mergeable: m.mergeable,
    fastForward: m.fastForward,
    conflicts,
    ...(truncated ? { conflictsTruncated: true as const } : {}),
    resolved,
    ...(m.resolved.length > resolved.length ? { resolvedTruncated: true as const } : {}),
    targetSha: m.targetSha,
    headSha: m.headSha,
    mergeBase: m.mergeBase,
    ...(m.mergeBases ? { mergeBases: m.mergeBases } : {}),
    treeSha: m.treeSha,
    ...(m.unknownReason !== undefined ? { unknownReason: m.unknownReason } : {}),
    checks: m.checks,
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ChangeContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
  /** The repo's branch rules, when the caller read them in its authority batch. */
  branchRules?: BranchRule[];
  waitUntil(p: Promise<unknown>): void;
}

export type Fail = Extract<ServiceResult<never>, { ok: false }> & {
  conflicts?: ConflictView[];
  checks?: RequiredChecks;
  ref?: string;
  review?: ReviewBlockDetail;
  dependencies?: DependencyView[];
  headSha?: string;
  recordedHead?: string;
  /** Which criss-cross budget or limit refused a merge (`MULTIPLE_MERGE_BASES`). */
  reason?: string;
};

export function fail(status: number, error: string, code: string, extra: Partial<Fail> = {}): Fail {
  return { ok: false, status, error, code, ...extra };
}

/** The pin refusal (services/dependencyGate.ts) for the rows of a change's workspace pins, or null. */
export function dependencyRefusal(rows: readonly DependencyRow[] | undefined, mode: 'enqueue' | 'publish' = 'publish'): Fail | null {
  const block = blockFromRows(rows, mode);
  return block ? fail(block.status, block.error, block.code, { dependencies: block.dependencies }) : null;
}

export function resolveCtx(cx: Pick<ChangeContext, 'env' | 'repo' | 'waitUntil'>, artifacts: LazyRepo): ResolveContext {
  return { env: cx.env, repo: cx.repo, artifacts, bypass: false, waitUntil: cx.waitUntil };
}

export async function guarded<T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RefStoreUnavailable) {
      console.warn(JSON.stringify({ changesRefStore: err.message.slice(0, 200) }));
      return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
}

/** A branch name as given (`main`) or as a full branch ref (`refs/heads/main`); null otherwise. */
export function normalizeBranch(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  const name = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
  if (name.startsWith('refs/') || name === 'HEAD' || !isValidRefName(name)) return null;
  return name;
}

export const branchRef = (name: string) => `refs/heads/${name}`;

function isPolicy(v: unknown): v is MergePolicy {
  return typeof v === 'string' && (MERGE_POLICIES as readonly string[]).includes(v);
}

function validTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= CHANGE_LIMITS.titleMax ? t : null;
}

function validBody(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > CHANGE_LIMITS.bodyMax) return undefined;
  return v;
}

export function parseNumber(raw: string): number | null {
  return /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function changeSelect(db: D1Database, repoId: string, number: number): D1PreparedStatement {
  return db.prepare(`${CHANGE_SELECT} WHERE c.repo_id = ? AND c.number = ?`).bind(repoId, number);
}

export async function readChange(env: Env, repoId: string, number: number): Promise<ChangeRow | null> {
  return changeSelect(env.DB, repoId, number).first<ChangeRow>();
}

/**
 * One batch: the change, its newest check runs (bounded) and the active
 * quarantines, so the cost is the same for any number of runs.
 */
async function readChangeWithChecks(env: Env, repoId: string, number: number): Promise<{ row: ChangeRow; checks: CheckRunView[] } | null> {
  const [change, checks, quarantines] = await env.DB.batch([
    changeSelect(env.DB, repoId, number),
    env.DB.prepare(
      `SELECT ${CHECK_RUN_COLUMNS}
         FROM check_runs k
        WHERE k.change_set_id = (SELECT id FROM change_sets WHERE repo_id = ?1 AND number = ?2)
        ORDER BY k.created_at DESC, k.id DESC
        LIMIT ${CHANGE_LIMITS.checksMax}`,
    ).bind(repoId, number),
    activeQuarantinesStatement(env.DB, repoId, Date.now()),
  ]);
  const row = (change?.results as ChangeRow[] | undefined)?.[0];
  if (!row) return null;
  const names = quarantineNames(quarantines?.results as Array<{ name: string }> | undefined);
  return { row, checks: markQuarantined(((checks?.results as CheckRunRow[] | undefined) ?? []).map(checkRunView), names) };
}

export interface ChangePage {
  changes: ChangeView[];
  nextCursor: string | null;
}

/** A list page's SQL: binds ?1 repo id, ?2 exclusive number cursor, and ?3 state unless `state` is 'all'. */
export function listChangesSql(state: string, rows: number): string {
  const where = state === 'all' ? 'c.repo_id = ?1 AND c.number < ?2' : 'c.repo_id = ?1 AND c.state = ?3 AND c.number < ?2';
  return `${CHANGE_SELECT} WHERE ${where} ORDER BY c.number DESC LIMIT ${rows}`;
}

/** GET changes?state=&limit=&cursor= — newest first; one bounded indexed query. */
export async function listChanges(
  env: Env,
  repo: RepoRow,
  q: { state?: string; limit?: string; cursor?: string },
): Promise<ServiceResult<ChangePage>> {
  const state = q.state ?? 'open';
  if (!(LIST_STATES as readonly string[]).includes(state)) {
    return fail(400, `state must be one of ${LIST_STATES.join(', ')}`, 'INVALID_STATE');
  }
  let limit = CHANGE_LIMITS.pageDefault;
  if (q.limit !== undefined) {
    if (!/^\d+$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > CHANGE_LIMITS.pageMax) {
      return fail(400, `limit must be an integer from 1 to ${CHANGE_LIMITS.pageMax}`, 'INVALID_LIMIT');
    }
    limit = Number(q.limit);
  }
  let before = Number.MAX_SAFE_INTEGER;
  if (q.cursor !== undefined) {
    const n = parseNumber(q.cursor);
    if (n === null) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    before = n;
  }
  const stmt = env.DB.prepare(listChangesSql(state, limit + 1));
  const { results } = await (state === 'all' ? stmt.bind(repo.id, before) : stmt.bind(repo.id, before, state)).all<ChangeRow>();
  const rows = results ?? [];
  const page = rows.slice(0, limit);
  return {
    ok: true,
    value: { changes: page.map(changeView), nextCursor: rows.length > limit ? String(page[page.length - 1]!.number) : null },
  };
}

// ---------------------------------------------------------------------------
// Mergeability
// ---------------------------------------------------------------------------

type CachedPlan = MergePlanView;

/** Outcomes that depend only on the two commits (never transient read failures). */
function cacheablePlan(m: CachedPlan): boolean {
  return m.status !== 'unknown' || isCrissCrossRefusal(m.unknownReason) || (m.unknownReason?.startsWith('max') ?? false) || m.unknownReason === 'diffBudget';
}

/**
 * Mergeability of head into the target: the merge plan for a commit pair is
 * immutable, so it is cached per repo and pair; required checks always come
 * fresh from the checks-gate.
 */
export async function mergeabilityFor(ctx: ResolveContext, gate: ChecksGate, targetSha: string, headSha: string, changeId: string): Promise<Mergeability> {
  const plan = await mergePlanFor(ctx, targetSha, headSha);
  let subject: ChecksSubject | undefined;
  if (plan.treeSha && plan.mergeBase) {
    const base = (await resolveCommitish(ctx, [plan.mergeBase])).get(plan.mergeBase);
    if (!base) throw new RefStoreUnavailable(`merge base ${plan.mergeBase} could not be read`);
    subject = { changeId, headSha, guardBaseTree: base.tree };
  }
  const checks = plan.treeSha ? await gate.requiredChecksFor({ id: ctx.repo.id }, plan.treeSha, null, subject) : null;
  const mergeable = (plan.status === 'fast-forward' || plan.status === 'clean') && checks?.state === 'success';
  return { ...plan, checks, mergeable };
}

/** The cached merge plan of a commit pair, without asking the checks-gate (conflict evaluation, guard base). */
export async function mergePlanFor(ctx: ResolveContext, targetSha: string, headSha: string): Promise<CachedPlan> {
  // v3: v2 entries cached criss-cross pairs as refused; they now merge through a virtual base.
  const key = internalKey('mergeplan/v3', ctx.repo.id, targetSha, headSha);
  const hit = await readCachedJson<CachedPlan>(key);
  if (hit) return hit;
  const plan = await computeMergePlan(artifactsMergeSources(ctx), { targetSha, headSha });
  if (cacheablePlan(plan)) ctx.waitUntil(writeCachedJson(key, plan, 31_536_000));
  return plan;
}

// ---------------------------------------------------------------------------
// The guard (services/checks.ts) on creation and head refresh
// ---------------------------------------------------------------------------

/**
 * The guard over the change's own edits: its merge base's tree against the
 * head tree (the base tip's when there is none; for a criss-cross, the first
 * of its merge bases, architecture §3.1). `body` is
 * the base tip -> head compare body when the caller already holds it.
 */
async function guardFor(
  ctx: ResolveContext,
  p: { baseSha: string; baseTree: string; headTree: string; mergeBase: string | null; body?: CompareBody },
): Promise<GuardSummary> {
  try {
    if (p.mergeBase === null || p.mergeBase === p.baseSha) return await evaluateGuard(ctx, p.baseTree, p.headTree, p.body);
    const mb = (await resolveCommitish(ctx, [p.mergeBase])).get(p.mergeBase);
    if (!mb) throw new RefStoreUnavailable(`merge base ${p.mergeBase} could not be read`);
    return await evaluateGuard(ctx, mb.tree, p.headTree);
  } catch (err) {
    if (err instanceof RefStoreUnavailable) throw err;
    throw new RefStoreUnavailable(`guard read failed: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Records the guard run for a live change at `headSha` unless it has one:
 * one read batch (repo, change, existing run), the guard's reads, one
 * insert. Skips a change that moved on or left the live states. With
 * `rejudgeBaseTree` (a gate question whose guard answered pending for that
 * merge-base tree) it only re-judges a head that already has a run for
 * another base, and records the run only while the live base still yields
 * that tree; the first judgment of a head stays with creation and the push
 * hook.
 */
export async function recordGuard(
  env: Env,
  repoId: string,
  changeId: string,
  headSha: string,
  opts: { rejudgeBaseTree?: string } = {},
): Promise<'recorded' | 'skipped'> {
  const db = env.DB;
  const rejudge = opts.rejudgeBaseTree;
  const [repoRes, changeRes, existing, judged] = await db.batch([
    db.prepare('SELECT * FROM repos WHERE id = ?').bind(repoId),
    db.prepare('SELECT id, base_ref, head_sha, state FROM change_sets WHERE id = ? AND repo_id = ?').bind(changeId, repoId),
    guardRunExists(db, repoId, changeId, headSha, rejudge),
    ...(rejudge === undefined ? [] : [guardRunExists(db, repoId, changeId, headSha)]),
  ]);
  const repo = (repoRes?.results as RepoRow[] | undefined)?.[0];
  const change = (changeRes?.results as Array<{ id: string; base_ref: string; head_sha: string | null; state: ChangeState }> | undefined)?.[0];
  if (!repo || !change || change.head_sha !== headSha || !isLive({ state: change.state } as ChangeRow)) return 'skipped';
  if ((existing?.results?.length ?? 0) > 0) return 'skipped';
  if (rejudge !== undefined && (judged?.results?.length ?? 0) === 0) return 'skipped';
  const pending: Promise<unknown>[] = [];
  try {
    return await withLazyRepo(env, repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx({ env, repo, waitUntil: (p) => pending.push(p) }, artifacts);
      const baseRef = branchRef(change.base_ref);
      const baseSha = (await lsRefs(ctx, [baseRef])).get(baseRef) ?? null;
      if (!baseSha) return 'skipped' as const;
      const commits = await resolveCommitish(ctx, [baseSha, headSha]);
      const base = commits.get(baseSha);
      const head = commits.get(headSha);
      if (!base || !head) throw new RefStoreUnavailable(`commits of change ${changeId} could not be read`);
      const started = Date.now();
      const plan = await mergePlanFor(ctx, baseSha, headSha);
      let guardBase: { sha: string; tree: string } = base;
      if (plan.mergeBase !== null && plan.mergeBase !== baseSha) {
        const mb = (await resolveCommitish(ctx, [plan.mergeBase])).get(plan.mergeBase);
        if (!mb) throw new RefStoreUnavailable(`merge base ${plan.mergeBase} could not be read`);
        guardBase = mb;
      }
      if (rejudge !== undefined && guardBase.tree !== rejudge) return 'skipped' as const;
      const summary = await guardFor(ctx, { baseSha: guardBase.sha, baseTree: guardBase.tree, headTree: head.tree, mergeBase: null });
      const inserted = await guardRunInsert(db, { repoId, changeId, headSha, treeSha: head.tree, summary, startedAt: started, now: Date.now() }).run();
      return (inserted.meta.changes ?? 0) > 0 ? ('recorded' as const) : ('skipped' as const);
    });
  } finally {
    await Promise.allSettled(pending);
  }
}

/**
 * A gate question found `change`'s guard pending for `baseTree` (its merge
 * base moved since the head was judged, e.g. the change it was stacked on
 * landed): judges the head against that base and, once recorded, resumes
 * the change as a reported check would.
 */
export async function rejudgeGuard(
  env: Env,
  repoId: string,
  change: { id: string; number: number; policy: string; baseRef: string; queued: boolean },
  headSha: string,
  baseTree: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  try {
    if ((await recordGuard(env, repoId, change.id, headSha, { rejudgeBaseTree: baseTree })) === 'recorded') await resumeAfterCheck(env, repoId, change, waitUntil);
  } catch (err) {
    console.warn(JSON.stringify({ guardRejudgeFailed: { repoId, change: change.number, error: String(err).slice(0, 200) } }));
  }
}

/**
 * After a reported run on a live change's head: an `auto` change may now
 * merge, and a queued one's train re-checks it.
 */
export async function resumeAfterCheck(
  env: Env,
  repoId: string,
  change: { number: number; policy: string; baseRef: string; queued: boolean },
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  if (change.queued) await kickTrain(env, repoId, branchRef(change.baseRef), 'check-reported');
  else if (change.policy === 'auto') await resumeAutoChanges(env, repoId, [change.number], waitUntil);
}

/** Live base tip and head trees, the compare rating and mergeability for an open change. */
async function liveState(
  ctx: ResolveContext,
  gate: ChecksGate,
  row: ChangeRow,
): Promise<{ rating: ChangeRating | null; mergeability: Mergeability | null; baseSha: string | null }> {
  if (!row.head_sha) return { rating: null, mergeability: null, baseSha: null };
  const baseName = branchRef(row.base_ref);
  const resolved = await resolveCommitish(ctx, [baseName, row.head_sha]);
  const base = resolved.get(baseName) ?? null;
  const head = resolved.get(row.head_sha) ?? null;
  if (!base || !head) return { rating: null, mergeability: null, baseSha: base?.sha ?? null };
  const [rating, m] = await Promise.all([treePairRating(ctx, base.tree, head.tree), mergeabilityFor(ctx, gate, base.sha, head.sha, row.id)]);
  return { rating, mergeability: m, baseSha: base.sha };
}

function isLive(row: ChangeRow): boolean {
  return row.state === 'open' || row.state === 'conflicted';
}

/** The row after the conflict transition (services/conflicts.ts) this evaluation of its head calls for. */
async function reconciled(cx: ChangeContext, row: ChangeRow, m: Mergeability): Promise<ChangeRow> {
  const after = await reconcileConflicts(cx.env, cx.repo.id, row, m);
  if (!after) return row;
  // A base that moved past the conflict reopens an auto change here when a read sees it first; it then merges on its own.
  if (after.state === 'open' && row.merge_policy === 'auto') cx.waitUntil(resumeAutoChanges(cx.env, cx.repo.id, [row.number], (p) => cx.waitUntil(p)));
  return { ...row, ...after };
}

/** GET changes/:number — the change, its rating and mergeability (open changes) and check runs. */
export function getChange(cx: ChangeContext, rawNumber: string): Promise<ServiceResult<ChangeDetail>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const found = await readChangeWithChecks(cx.env, cx.repo.id, number);
    if (!found) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const { row, checks } = found;
    if (!isLive(row)) return { ok: true, value: { ...changeView(row), rating: storedRating(row), mergeability: null, checks } };
    return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const live = await liveState(resolveCtx(cx, artifacts), defaultChecksGate(cx.env), row);
      const current = live.mergeability ? await reconciled(cx, row, live.mergeability) : row;
      const view = changeView(current);
      return {
        ok: true,
        value: {
          ...view,
          baseSha: live.baseSha ?? view.baseSha,
          rating: live.rating,
          mergeability: live.mergeability ? mergeabilityView(live.mergeability) : null,
          checks,
        },
      };
    });
  });
}

/** GET changes/:number/mergeability */
export interface MergeabilityResponse {
  number: number;
  state: ChangeState;
  mergeability: MergeabilityView | null;
}

export function getMergeability(cx: ChangeContext, rawNumber: string): Promise<ServiceResult<MergeabilityResponse>> {
  return guarded<MergeabilityResponse>(async () => {
    const number = parseNumber(rawNumber);
    const row = number === null ? null : await readChange(cx.env, cx.repo.id, number);
    if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (!isLive(row) || !row.head_sha) return { ok: true, value: { number: row.number, state: row.state, mergeability: null } };
    return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      const baseName = branchRef(row.base_ref);
      const resolved = await resolveCommitish(ctx, [baseName]);
      const base = resolved.get(baseName);
      if (!base) return fail(409, `base branch ${row.base_ref} no longer exists`, 'BASE_NOT_FOUND');
      const m = await mergeabilityFor(ctx, defaultChecksGate(cx.env), base.sha, row.head_sha!, row.id);
      const current = await reconciled(cx, row, m);
      return { ok: true, value: { number: row.number, state: current.state, mergeability: mergeabilityView(m) } };
    });
  });
}

/** GET changes/:number/checks — the change's check runs, newest first (bounded). */
export async function listChangeChecks(env: Env, repo: RepoRow, rawNumber: string): Promise<ServiceResult<{ number: number; headSha: string | null; checks: CheckRunView[] }>> {
  const number = parseNumber(rawNumber);
  const found = number === null ? null : await readChangeWithChecks(env, repo.id, number);
  if (!found) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  return { ok: true, value: { number: found.row.number, headSha: found.row.head_sha, checks: found.checks } };
}

// ---------------------------------------------------------------------------
// Create and update
// ---------------------------------------------------------------------------

interface CreateInput {
  title: string;
  body: string | null;
  base: string;
  head: string;
  mergePolicy: MergePolicy;
}

function parseCreate(input: unknown): ServiceResult<CreateInput> {
  const b = (input ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  const title = validTitle(b.title);
  if (title === null) return fail(422, `title is required (1-${CHANGE_LIMITS.titleMax} characters)`, 'INVALID_TITLE');
  const body = b.body === undefined ? null : validBody(b.body);
  if (body === undefined) return fail(422, `body must be a string of at most ${CHANGE_LIMITS.bodyMax} characters`, 'INVALID_BODY');
  const base = normalizeBranch(b.base);
  if (base === null) return fail(422, 'base must be a branch name', 'INVALID_REF');
  const head = normalizeBranch(b.head);
  if (head === null) return fail(422, 'head must be a branch name', 'INVALID_REF');
  if (base === head) return fail(422, 'base and head must be different branches', 'SAME_REF');
  const mergePolicy = b.mergePolicy === undefined ? 'review' : b.mergePolicy;
  if (!isPolicy(mergePolicy)) return fail(422, `mergePolicy must be one of ${MERGE_POLICIES.join(', ')}`, 'INVALID_MERGE_POLICY');
  return { ok: true, value: { title, body, base, head, mergePolicy } };
}

/**
 * POST changes. Both branches are resolved fresh before anything is written;
 * a missing branch or base == head writes nothing. Numbering and the read-back
 * are one D1 batch: the number is MAX+1 inside the INSERT, and
 * UNIQUE(repo_id, number) guards concurrent creates.
 */
export interface CreateChangeOptions {
  /**
   * Runs once the change row exists and before an `auto` change may merge;
   * a failure is returned as is and nothing is published. Workspaces link
   * their change set here so admission is decided before publication.
   */
  admit?: (change: { id: string; number: number }) => Promise<Extract<ServiceResult<never>, { ok: false }> | null>;
}

export function createChange(cx: ChangeContext, input: unknown, opts: CreateChangeOptions = {}): Promise<ServiceResult<ChangeDetail>> {
  return guarded(async () => {
    const parsed = parseCreate(input);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const denied = agentMergeDenial(cx.actor, p.base, p.mergePolicy);
    if (denied) return denied;
    // Push events at or after this instant are newer than the head ls-refs reports.
    const observedAt = Date.now() - 1;
    const resolved = await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      const tips = await lsRefs(ctx, [branchRef(p.base), branchRef(p.head)]);
      const baseSha = tips.get(branchRef(p.base)) ?? null;
      const headSha = tips.get(branchRef(p.head)) ?? null;
      if (!baseSha) return fail(422, `base branch not found: ${p.base}`, 'REF_NOT_FOUND', { ref: p.base });
      if (!headSha) return fail(422, `head branch not found: ${p.head}`, 'REF_NOT_FOUND', { ref: p.head });
      const commits = await resolveCommitish(ctx, [baseSha, headSha]);
      const base = commits.get(baseSha);
      const head = commits.get(headSha);
      if (!base || !head) return fail(503, 'branch commits could not be read, retry shortly', 'STORAGE_UNAVAILABLE');
      // Conflict detection is eager: a change that conflicts is created `conflicted` with its resolve-conflict task.
      const [pair, m] = await Promise.all([treePairBody(ctx, base.tree, head.tree), mergePlanFor(ctx, baseSha, headSha)]);
      // The guard judges the change's own edits (merge base -> head) before the row exists, so its run lands in the same batch.
      const guardStarted = Date.now();
      const guard = await guardFor(ctx, { baseSha, baseTree: base.tree, headTree: head.tree, mergeBase: m.mergeBase, body: pair.body });
      return { ok: true as const, value: { baseSha, headSha, headTree: head.tree, rating: pair.body.rating, m, guard, guardStarted } };
    });
    if (!resolved.ok) return resolved;
    const { baseSha, headSha, headTree, rating, m, guard, guardStarted } = resolved.value;
    const ciConfig = await hasCiJobs(cx.env, cx.repo.artifacts_name, headSha);
    if (!ciConfig.ok) return ciConfig;

    const now = Date.now();
    const id = crypto.randomUUID();
    const agentMeta = cx.actor?.agent ? JSON.stringify({ agentId: cx.actor.agent.agentId, agentName: cx.actor.agent.agentName }) : null;
    // The head watermark is tied to the ref position: a push ingested since the
    // observation (newer event) is adopted outright; the push that produced the
    // observed head lends its event time; otherwise the observation time, so a
    // push racing this create and delivered later is still newer.
    const newerPush = `f.repo_id = ?2 AND f.ref = ?16 AND f.event_at > ?17 AND f.sha != '${ZERO_SHA}'`;
    const conflicted = conflictTransition({ id, state: 'open', head_sha: headSha, conflicts: null }, m);
    const results = await cx.env.DB.batch([
      cx.env.DB.prepare(
        `INSERT INTO change_sets (id, repo_id, number, title, body, base_ref, head_ref, head_sha, base_sha, state, author_id,
           agent_meta, merge_policy, risk_score, risk_level, risk_reasons, kind, created_at, updated_at, head_event_at)
         SELECT ?1, ?2, COALESCE(MAX(number), 0) + 1, ?3, ?4, ?5, ?6,
                COALESCE((SELECT f.sha FROM repo_refs f WHERE ${newerPush}), ?7),
                ?8, 'open', ?9, ?10, ?11, ?12, ?13, ?14, 'change', ?15, ?15,
                COALESCE((SELECT f.event_at FROM repo_refs f WHERE (${newerPush}) OR (f.repo_id = ?2 AND f.ref = ?16 AND f.sha = ?7)), ?17)
           FROM change_sets WHERE repo_id = ?2`,
      ).bind(
        id,
        cx.repo.id,
        p.title,
        p.body,
        p.base,
        p.head,
        headSha,
        baseSha,
        cx.actor?.user.id ?? null,
        agentMeta,
        p.mergePolicy,
        rating.score,
        rating.level,
        JSON.stringify(rating.reasons),
        now,
        branchRef(p.head),
        observedAt,
      ),
      // Guarded by the head: a newer push adopted by the INSERT was not evaluated here.
      ...(conflicted?.kind === 'mark' ? markConflictedStatements(cx.env.DB, id, conflicted.record, now) : []),
      // A change into a ref covered by a branch rule asks a human from the start.
      ...(cx.branchRules && effectivePolicy(cx.branchRules, branchRef(p.base)).protected
        ? [recordMissingEscalation(cx.env.DB, id, 'protected-path', now)]
        : []),
      guardRunInsert(cx.env.DB, { repoId: cx.repo.id, changeId: id, headSha, treeSha: headTree, summary: guard, startedAt: guardStarted, now }),
      cx.env.DB.prepare(`SELECT ${CHECK_RUN_COLUMNS} FROM check_runs k WHERE k.change_set_id = ? ORDER BY k.created_at DESC, k.id DESC LIMIT ${CHANGE_LIMITS.checksMax}`).bind(id),
      cx.env.DB.prepare(`${CHANGE_SELECT} WHERE c.id = ?`).bind(id),
    ]);
    let row = (results[results.length - 1]?.results as ChangeRow[] | undefined)?.[0];
    if (!row) return fail(500, 'change could not be created', 'CREATE_FAILED');
    let checks = ((results[results.length - 2]?.results as CheckRunRow[] | undefined) ?? []).map(checkRunView);
    if (row.head_sha && row.head_sha !== headSha) {
      // The insert adopted a push newer than the evaluated head; that push's hooks ran before the change existed.
      await recordGuard(cx.env, cx.repo.id, row.id, row.head_sha);
      const read = await listChangeChecks(cx.env, cx.repo, String(row.number));
      if (read.ok) checks = read.value.checks;
    }
    if (opts.admit) {
      const refused = await opts.admit({ id: row.id, number: row.number });
      if (refused) return refused;
    }
    if (row.head_sha) {
      const queued = await queueChangeCi(cx.env, cx.repo, row.id, row.head_sha, row.head_sha === headSha ? headTree : undefined);
      // A newer head may have raced the create after the observed head's
      // config was validated. queueChangeCi records kvarm/ci-config failure
      // on that persisted head, so return the created, blocked change rather
      // than an error that suggests no change exists.
      if (!queued.ok && row.head_sha === headSha) return queued;
      if (queued.ok && queued.value.jobs > 0) {
        const read = await listChangeChecks(cx.env, cx.repo, String(row.number));
        if (read.ok) checks = read.value.checks;
      } else if (!queued.ok) {
        const read = await listChangeChecks(cx.env, cx.repo, String(row.number));
        if (read.ok) checks = read.value.checks;
      }
    }
    if (row.merge_policy === 'auto') row = (await autoMerge(cx, row)) ?? row;
    return { ok: true, value: { ...changeView(row), rating: isLive(row) ? rating : storedRating(row), mergeability: null, checks } };
  });
}

interface Patch {
  title?: string;
  body?: string | null;
  mergePolicy?: MergePolicy;
  state?: 'open' | 'closed';
}

function parsePatch(input: unknown): ServiceResult<Patch> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  const b = input as Record<string, unknown>;
  const out: Patch = {};
  if (b.title !== undefined) {
    const t = validTitle(b.title);
    if (t === null) return fail(422, `title must be 1-${CHANGE_LIMITS.titleMax} characters`, 'INVALID_TITLE');
    out.title = t;
  }
  if (b.body !== undefined) {
    const body = validBody(b.body);
    if (body === undefined) return fail(422, `body must be a string of at most ${CHANGE_LIMITS.bodyMax} characters`, 'INVALID_BODY');
    out.body = body;
  }
  if (b.mergePolicy !== undefined) {
    if (!isPolicy(b.mergePolicy)) return fail(422, `mergePolicy must be one of ${MERGE_POLICIES.join(', ')}`, 'INVALID_MERGE_POLICY');
    out.mergePolicy = b.mergePolicy;
  }
  if (b.state !== undefined) {
    if (b.state !== 'open' && b.state !== 'closed') return fail(422, 'state must be "open" or "closed"', 'INVALID_STATE');
    out.state = b.state;
  }
  if (Object.keys(out).length === 0) return fail(422, 'nothing to update: pass title, body, mergePolicy or state', 'EMPTY_PATCH');
  return { ok: true, value: out };
}

/**
 * PATCH changes/:number. One batch: a guarded UPDATE that never touches a
 * merged change, then the read-back. Changing the policy to `auto` (or
 * reopening an `auto` change) merges it right away when it is mergeable;
 * an agent token must be allowed to update the base for either.
 */
export function updateChange(cx: ChangeContext, rawNumber: string, input: unknown): Promise<ServiceResult<ChangeView>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const parsed = parsePatch(input);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = ?${args.length + 2}`);
    };
    if (p.title !== undefined) set('title', p.title);
    if (p.body !== undefined) set('body', p.body);
    if (cx.actor?.agent && (p.mergePolicy === 'auto' || p.state === 'open')) {
      // Setting auto or reopening an auto change publishes to the base: the agent's ref ceiling applies.
      const current = await readChange(cx.env, cx.repo.id, number);
      if (!current) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
      if ((p.mergePolicy ?? current.merge_policy) === 'auto' && (p.state ?? current.state) === 'open') {
        const denied = agentMergeDenial(cx.actor, current.base_ref, p.mergePolicy === 'auto' ? 'auto' : 'merge');
        if (denied) return denied;
      }
    }
    if (p.mergePolicy !== undefined) set('merge_policy', p.mergePolicy);
    if (p.state === 'closed') set('state', 'closed');
    if (p.state === 'open') {
      // Reopening keeps a conflicted change conflicted; the next evaluation of its head decides.
      args.push('open');
      sets.push(`state = CASE WHEN state = 'conflicted' THEN state ELSE ?${args.length + 2} END`);
    }
    const now = Date.now();
    set('updated_at', now);
    const results = await cx.env.DB.batch([
      cx.env.DB.prepare(`UPDATE change_sets SET ${sets.join(', ')} WHERE repo_id = ?1 AND number = ?2 AND state != 'merged'`).bind(
        cx.repo.id,
        number,
        ...args,
      ),
      ...(p.state === 'closed' ? [retireConflictTaskStatement(cx.env.DB, cx.repo.id, number, now)] : []),
      changeSelect(cx.env.DB, cx.repo.id, number),
    ]);
    let row = (results[results.length - 1]?.results as ChangeRow[] | undefined)?.[0];
    if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (row.state === 'merged') return fail(409, 'a merged change cannot be updated', 'CHANGE_MERGED');
    if (row.merge_policy === 'auto' && row.state === 'open') row = (await autoMerge(cx, row)) ?? row;
    return { ok: true, value: changeView(row) };
  });
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  change: ChangeView;
  merge: { kind: 'fast-forward' | 'merge'; mergeCommit: string; treeSha: string; previous: string; work: MergeWork };
}

/** The gate's answer per tree (and subject head), asked once per merge attempt or train pass. */
export function memoGate(inner: ChecksGate): ChecksGate {
  const seen = new Map<string, Promise<RequiredChecks>>();
  return {
    requiredChecksFor(repo, treeSha, configId, subject) {
      const k = `${repo.id}:${treeSha}:${configId ?? ''}:${subject?.changeId ?? ''}:${subject?.headSha ?? ''}:${subject?.guardBaseTree ?? ''}`;
      let p = seen.get(k);
      if (!p) {
        p = inner.requiredChecksFor(repo, treeSha, configId, subject);
        seen.set(k, p);
      }
      return p;
    },
  };
}

/**
 * The rules' guard completeness, then the required checks of the target
 * ref's branch rules that the checks-gate answer does not satisfy. Under
 * `required` a passing kvarm/guard that did not inspect every changed file
 * is refused (GUARD_INCOMPLETE, terminal for that head: the same head is
 * judged the same way again). Approvals are the review gate's
 * (services/reviewGate.ts).
 */
export function branchPolicyBlock(policy: BranchPolicy, checks: RequiredChecks): Fail | null {
  // A rule that names a quarantined check still requires it: quarantine never overrides an explicit rule (§0.3).
  const named = (name: string) => checks.required.find((c) => c.name === name) ?? checks.quarantined?.find((c) => c.name === name);
  for (const name of policy.requiredChecks) {
    if (named(name)?.state === 'failure') {
      return fail(409, `required check ${name} failed`, 'REQUIRED_CHECKS_FAILED', { checks });
    }
  }
  // Before pending checks: completeness is fixed for the head, so a queue entry need not hold a checking slot for it.
  // A failing gate is reported as that failure, never as incompleteness.
  if (policy.guardCompleteness === 'required' && checks.state !== 'failure') {
    const guard = checks.required.find((c) => c.name === GUARD_CHECK);
    if (!guard) {
      return fail(409, `${policy.ref} requires a complete ${GUARD_CHECK} inspection and there is no ${GUARD_CHECK} verdict yet`, 'REQUIRED_CHECKS_PENDING', { checks });
    }
    if (guard.state === 'success' && guard.incomplete) {
      const what = guard.uninspected ? `${guard.uninspected} changed file(s) were` : 'part of the change was';
      return fail(
        409,
        `${policy.ref} requires a complete ${GUARD_CHECK} inspection; ${what} not fully inspected ` +
          '(over the file budget, past the per-file or per-line read limit, unreadable, or beyond a truncated change list); split the change so the guard can read all of it',
        'GUARD_INCOMPLETE',
        { checks },
      );
    }
  }
  for (const name of policy.requiredChecks) {
    if (named(name)?.state !== 'success') {
      return fail(409, `required check ${name} has not passed on the merge result`, 'REQUIRED_CHECKS_PENDING', { checks });
    }
  }
  return null;
}

/**
 * The review gate's refusal for publishing `change` into `policy.ref`, or
 * null. Escalations the gate finds missing are recorded first (one batch).
 */
export async function reviewRefusal(env: Env, changeId: string, facts: ReviewFacts, policy: BranchPolicy): Promise<Fail | null> {
  const gate = reviewGate(facts, policy);
  if (gate.missing.length > 0) {
    const now = Date.now();
    await env.DB.batch(gate.missing.map((reason) => recordMissingEscalation(env.DB, changeId, reason, now)));
  }
  return gate.block;
}

export interface MergeDeps {
  pusher(env: Env, repo: RepoRow): GitPusher;
  gate(env: Env): ChecksGate;
}

export const defaultMergeDeps: MergeDeps = {
  pusher: (env, repo) => artifactsPusher(env, repo),
  gate: (env) => defaultChecksGate(env),
};

const RETRYABLE: ReadonlySet<MergeErrorCode | string> = new Set(['STALE_TARGET']);

/** `explicit`: a merge call (review or auto policy). `auto`: the auto policy acting on its own. */
type MergeMode = 'explicit' | 'auto';

/** Why the change, as it is now, may not be merged at `headSha` (null: it may). */
export function mergeRefusal(row: ChangeRow | null, mode: MergeMode, headSha?: string): Fail | null {
  if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  if (row.state === 'merged') return fail(409, 'the change is already merged', 'ALREADY_MERGED');
  if (row.state === 'closed') return fail(409, 'a closed change cannot be merged; reopen it first', 'CHANGE_CLOSED');
  if (row.merge_policy === 'draft') {
    return fail(409, 'the change is a draft (mergePolicy draft) and never merges; set mergePolicy to review or auto', 'DRAFT');
  }
  if (mode === 'auto' && (row.merge_policy !== 'auto' || row.state !== 'open')) {
    return fail(409, 'the change no longer has mergePolicy auto', 'NOT_AUTO');
  }
  if (headSha !== undefined && row.head_sha !== headSha) {
    return fail(409, "the change's head moved while the merge was prepared; merge again to merge the new head", 'HEAD_MOVED');
  }
  return null;
}

/**
 * Compares the head branch as ls-refs reports it now with the head about to
 * be published. The recorded head follows push events, which trail the push
 * by seconds, so a merge issued right after a push (a force-push above all)
 * would otherwise publish the previous head and drop the newest one. A
 * deleted branch (null) is not a move: the change keeps its last head, as in
 * push processing.
 */
export function liveHeadRefusal(headRef: string, recorded: string, live: string | null | undefined): Fail | null {
  if (!live || live === recorded) return null;
  return fail(
    409,
    `${headRef} points at ${live}, not at the change's recorded head ${recorded}; the push is still being processed, re-read the change and merge again`,
    'HEAD_MOVED',
    { headSha: live, recordedHead: recorded },
  );
}

export interface HeadWorkspace {
  status: string;
  change_set_id: string | null;
}

/** The agent workspace whose ref is the change's head branch, if any. */
export function headWorkspaceSelect(db: D1Database, repoId: string, number: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT w.status, w.change_set_id FROM workspaces w
        WHERE w.repo_id = ?1 AND w.ref = (SELECT 'refs/heads/' || c.head_ref FROM change_sets c WHERE c.repo_id = ?1 AND c.number = ?2)`,
    )
    .bind(repoId, number);
}

/**
 * A change from a workspace branch publishes only while that workspace is
 * active and linked to this very change set: the workspace's one change set
 * is the only way its content reaches a base. An unlinked workspace refuses
 * too, because a change set row is visible to the push-event publisher
 * before its admission links it.
 */
export function workspaceAdmissionRefusal(row: ChangeRow, ws: HeadWorkspace | null): Fail | null {
  if (!ws) return null;
  if (ws.status !== 'active') return fail(409, `the change's workspace is ${ws.status}`, 'WORKSPACE_NOT_ACTIVE');
  if (ws.change_set_id === null) {
    return fail(409, "the change's workspace is not linked to it; open changes from a workspace with its change-set route", 'WORKSPACE_NOT_LINKED');
  }
  if (ws.change_set_id !== row.id) {
    return fail(409, "the change's workspace is linked to another change set", 'WORKSPACE_LINKED_ELSEWHERE');
  }
  return null;
}

/**
 * Records a confirmed publication: the change is marked merged only while
 * it is still open at the published head and not a draft; its workspace and
 * index rows follow only when that guarded write landed. The first
 * statement's `meta.changes` tells whether the change was recorded.
 * `dependents: false` leaves out the three pin statements that end the
 * batch; only for a change that no workspace is, or can still become,
 * linked to (they would find nothing).
 */
export function mergedRecordStatements(
  db: D1Database,
  repoId: string,
  row: Pick<ChangeRow, 'id' | 'number'>,
  pub: { mergeCommit: string; targetSha: string; headSha: string },
  mergedAt: number,
  queue?: { queueId: string; generation: number },
  opts: { dependents?: boolean } = {},
): D1PreparedStatement[] {
  // A train publication records only while its queue entry was just written published at the publisher's generation.
  const fenced = queue ? `AND EXISTS (SELECT 1 FROM merge_queue q WHERE q.id = ?7 AND q.generation = ?8 AND q.state = 'published' AND q.merge_commit = ?3)` : '';
  return [
    db
      .prepare(
        `UPDATE change_sets SET state = 'merged', merge_commit = ?3, merged_at = ?4, updated_at = ?4, base_sha = ?5, conflicts = NULL
          WHERE repo_id = ?1 AND number = ?2 AND state IN ('open', 'conflicted') AND head_sha = ?6 AND merge_policy != 'draft' ${fenced}`,
      )
      .bind(repoId, row.number, pub.mergeCommit, mergedAt, pub.targetSha, pub.headSha, ...(queue ? [queue.queueId, queue.generation] : [])),
    // The workspace the change was opened from (services/workspaces.ts) follows it, only when the guarded write above landed.
    db
      .prepare(
        `UPDATE workspaces SET status = 'merged', merged_at = ?3, updated_at = ?3, head_sha = ?4
          WHERE repo_id = ?1 AND change_set_id = ?2 AND status = 'active'
            AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = ?2 AND c.state = 'merged' AND c.merge_commit = ?5 AND c.merged_at = ?3)`,
      )
      .bind(repoId, row.id, mergedAt, pub.headSha, pub.mergeCommit),
    changeSignalCleanup(db, repoId, row.id),
    retireConflictTaskStatement(db, repoId, row.number, mergedAt),
    // Pins of the landed head are satisfied with the merge (each with its dependent's wake mark, written first under the
    // same predicate); the last statement finds the rest and the marks.
    ...(opts.dependents === false
      ? []
      : [
          landedWakeMarksStatement(db, repoId, row.id, pub, mergedAt),
          satisfyLandedStatement(db, repoId, row.id, pub, mergedAt),
          landedDependentsStatement(db, repoId, row.id, mergedAt, pub.mergeCommit),
        ]),
  ];
}

/**
 * Merges an open change's recorded head into its base branch: plan against
 * the base tip read fresh, in the same ls-refs round trip that confirms the
 * head branch still points at the recorded head (else 409 HEAD_MOVED naming
 * the live head), check branch rules against the checks-gate answer
 * for the exact merge tree, prepare the push (write token and pack), re-read
 * the change immediately before sending (state, policy and head must still
 * allow this merge, and a head workspace must still admit this change),
 * publish one ref with the tip as expected old value,
 * then mark the change merged only while its head is still the published
 * one and it is not a draft. A moved base re-plans once. A change edited
 * between that last read and the send is not caught here; the guarded
 * merged write then refuses to record it.
 */
async function performMerge(
  cx: ChangeContext,
  row: ChangeRow,
  author: { name: string; email: string } | undefined,
  deps: MergeDeps,
  mode: MergeMode,
  attribution: AttributionInput | null = null,
  reviewFacts?: ReviewFacts,
): Promise<ServiceResult<MergeOutcome>> {
  if (!row.head_sha) return fail(409, 'the change has no head commit', 'NO_HEAD');
  const headSha = row.head_sha;
  const targetRef = branchRef(row.base_ref);
  const headRef = branchRef(row.head_ref);
  const policy = effectivePolicy(cx.branchRules ?? [], targetRef);
  const facts = reviewFacts ?? parseReviewFacts(await reviewFactsSelectById(cx.env.DB, row.id).first<ReviewFactsRow>());
  const reviewBlock = await reviewRefusal(cx.env, row.id, facts, policy);
  if (reviewBlock) return reviewBlock;
  const gate = memoGate(deps.gate(cx.env));
  const pusher = deps.pusher(cx.env, cx.repo);

  return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
    const ctx = resolveCtx(cx, artifacts);
    const sources = artifactsMergeSources(ctx);
    let last: Fail | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const tips = await lsRefs(ctx, [targetRef, headRef]);
      const targetSha = tips.get(targetRef) ?? null;
      if (!targetSha) return fail(409, `base branch ${row.base_ref} no longer exists`, 'BASE_NOT_FOUND');
      const moved = liveHeadRefusal(headRef, headSha, tips.get(headRef));
      if (moved) return moved;
      const prepared = await prepareMerge(sources, {
        targetSha,
        headSha,
        message: `Merge change #${row.number} from ${row.head_ref}\n\n${row.title}\n`,
        ...(author ? { author } : {}),
      });
      if (!prepared.ok) {
        if (prepared.code === 'MERGE_CONFLICT' && prepared.conflicts) {
          const t = conflictTransition(row, { status: 'conflicts', headSha, targetSha, conflicts: prepared.conflicts });
          if (t) await cx.env.DB.batch(transitionStatements(cx.env.DB, cx.repo.id, { id: row.id, number: row.number, head_sha: headSha }, t, Date.now()));
        }
        return fail(prepared.status, prepared.error, prepared.code, {
          ...(prepared.reason !== undefined ? { reason: prepared.reason } : {}),
          ...(prepared.conflicts ? { conflicts: conflictViews(prepared.conflicts).conflicts } : {}),
        });
      }
      let ciCheckRef: string | null = null;
      if (prepared.value.kind === 'merge') {
        const configured = await hasCiJobs(cx.env, cx.repo.artifacts_name, prepared.value.headSha);
        if (!configured.ok) return configured;
        if (configured.value) {
          const checkRef = `refs/heads/kvarm-ci/${row.id}/${prepared.value.treeSha}`;
          ciCheckRef = checkRef;
          const live = (await lsRefs(ctx, [checkRef])).get(checkRef) ?? null;
          if (live) {
            const expected = await cx.env.DB.prepare(
              'SELECT head_sha FROM ci_jobs WHERE repo_id = ?1 AND change_set_id = ?2 AND tree_sha = ?3 ORDER BY created_at LIMIT 1',
            )
              .bind(cx.repo.id, row.id, prepared.value.treeSha)
              .first<string>('head_sha');
            const staged = await sources.readCommit(live);
            if (
              live !== expected ||
              !staged ||
              staged.treeHash !== prepared.value.treeSha ||
              staged.parents.length !== 2 ||
              staged.parents[0] !== prepared.value.targetSha ||
              staged.parents[1] !== prepared.value.headSha
            ) {
              return fail(503, 'the prepared CI commit identity is invalid', 'CI_PREPARED_COMMIT_INVALID');
            }
            prepared.value.mergeCommit = live;
          } else {
            const staged = await pusher.updateRef({ ref: checkRef, oldOid: ZERO_OID, newOid: prepared.value.mergeCommit }, prepared.value.objects);
            if (staged.status !== 'ok') return fail(503, 'the prepared CI commit could not be staged', 'CI_PREPARED_COMMIT_UNAVAILABLE');
          }
          const queued = await queueExactTreeCi(
            cx.env,
            cx.repo,
            row.id,
            prepared.value.headSha,
            prepared.value.mergeCommit,
            prepared.value.treeSha,
          );
          if (!queued.ok) return queued;
        }
      }
      const guardBase = await sources.readCommit(prepared.value.mergeBase);
      if (!guardBase) return fail(503, 'the merge base could not be read', 'MERGE_READ_FAILED');
      const subject: ChecksSubject = { changeId: row.id, headSha: prepared.value.headSha, guardBaseTree: guardBase.treeHash };
      const checks = await gate.requiredChecksFor({ id: cx.repo.id }, prepared.value.treeSha, null, subject);
      if (guardPending(checks)) {
        const change = { id: row.id, number: row.number, policy: row.merge_policy, baseRef: row.base_ref, queued: false };
        cx.waitUntil(rejudgeGuard(cx.env, cx.repo.id, change, prepared.value.headSha, guardBase.treeHash, cx.waitUntil));
      }
      const blocked = branchPolicyBlock(policy, checks);
      if (blocked) return blocked;
      // The last change read runs after every asynchronous preparation step (checks, write token, pack).
      const verdict: { refusal: Fail | null; facts: ReviewFacts | null; policy: BranchPolicy } = { refusal: null, facts: null, policy };
      const beforeSend = async () => {
        const [change, ws, reviews, pins, rulesRes] = await cx.env.DB.batch([
          changeSelect(cx.env.DB, cx.repo.id, row.number),
          headWorkspaceSelect(cx.env.DB, cx.repo.id, row.number),
          // Approvals are revalidated against the exact head immediately before publication.
          reviewFactsSelect(cx.env.DB, cx.repo.id, row.number),
          changeDependenciesStatement(cx.env.DB, cx.repo.id, row.id),
          // Rules raised or added since the authorization apply to this publication.
          repoBranchRulesSelect(cx.env.DB, cx.repo.id),
        ]);
        const current = (change?.results as ChangeRow[] | undefined)?.[0] ?? null;
        verdict.facts = parseReviewFacts((reviews?.results as ReviewFactsRow[] | undefined)?.[0]);
        verdict.policy = effectivePolicy(((rulesRes?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow), targetRef);
        const pinsNow = pins?.results as DependencyRow[] | undefined;
        verdict.refusal =
          mergeRefusal(current, mode, headSha) ??
          workspaceAdmissionRefusal(current!, (ws?.results as HeadWorkspace[] | undefined)?.[0] ?? null) ??
          reviewGate(verdict.facts, verdict.policy).block ??
          branchPolicyBlock(verdict.policy, checks) ??
          dependencyRefusal(pinsNow);
        if (!verdict.refusal && pinsNow?.some((p) => p.satisfied_commit)) {
          // A satisfied pin must be contained in this very publication, not only in some earlier landing.
          const objects = new Map(prepared.value.objects.map((o) => [o.hash, o]));
          const kept = await preservationRefusal(overlaySources(sources, objects), pinsNow, prepared.value.mergeCommit).catch(() => null);
          const r = kept?.refusal;
          verdict.refusal = kept ? (r ? fail(r.status, r.error, r.code, { dependencies: r.dependencies }) : null) : fail(503, 'could not read the pinned revisions to verify they are preserved', 'MERGE_READ_FAILED');
        }
        return verdict.refusal === null;
      };
      const published = await publishMerge({ pusher, gate, beforeSend }, { repo: { id: cx.repo.id }, ref: targetRef, subject }, prepared.value);
      if (verdict.refusal) {
        // A review refusal records the escalations it found missing.
        if (verdict.refusal.review && verdict.facts) return (await reviewRefusal(cx.env, row.id, verdict.facts, verdict.policy)) ?? verdict.refusal;
        return verdict.refusal;
      }
      let ok = published.ok;
      if (!published.ok && published.code === 'PUBLISH_UNKNOWN') {
        // The update may have landed: the ref decides.
        const now = (await lsRefs(ctx, [targetRef]).catch(() => new Map<string, string | null>())).get(targetRef);
        ok = now === prepared.value.mergeCommit;
      }
      if (!ok && !published.ok) {
        last = fail(published.status, published.error, published.code, published.checks ? { checks: published.checks } : {});
        if (RETRYABLE.has(published.code)) continue;
        return last;
      }
      const pv = prepared.value;
      const mergedAt = Date.now();
      const record = mergedRecordStatements(cx.env.DB, cx.repo.id, row, { mergeCommit: pv.mergeCommit, targetSha: pv.targetSha, headSha }, mergedAt);
      const recorded = await cx.env.DB.batch([...record, changeSelect(cx.env.DB, cx.repo.id, row.number)]);
      const update = recorded[0];
      const read = recorded[recorded.length - 1];
      await settleLanded(
        cx.env.DB,
        sources,
        cx.repo.id,
        recorded[record.length - 1]?.results as LandedRow[] | undefined,
        pv.mergeCommit,
        {
          source: { changeSetId: row.id, mergedAt },
          ref: targetRef,
          kick: (ref, reason) => kickTrain(cx.env, cx.repo.id, ref, reason),
          resume: (numbers) => resumeAutoDependents(cx.env, cx.repo.id, numbers, cx.waitUntil),
          handOff: (msg) => handOffSettlement(cx.env, msg),
          defer: cx.waitUntil,
        },
      );
      if (pv.kind === 'merge') {
        // The merge commit is Kvarm's own, so it carries the merging principal; a fast-forward publishes the author's commit untouched.
        await attributeMerge(cx, artifacts, pusher, { changeNumber: row.number, mergeCommit: pv.mergeCommit, input: attribution });
      }
      if (!update?.meta.changes) {
        console.warn(JSON.stringify({ mergeNotRecorded: { repo: cx.repo.id, number: row.number, mergeCommit: pv.mergeCommit, headSha } }));
        return fail(
          409,
          `the change was updated while it merged (head, policy or state); ${targetRef} now points at ${pv.mergeCommit}, which merged head ${headSha}, and the change was not marked merged`,
          'CHANGE_UPDATED_DURING_MERGE',
        );
      }
      if (ciCheckRef) {
        cx.waitUntil(
          pusher
            .updateRef({ ref: ciCheckRef, oldOid: pv.mergeCommit, newOid: ZERO_OID }, [])
            .then((r) => {
              if (r.status !== 'ok') console.warn(JSON.stringify({ ciPreparedRefCleanup: { repo: cx.repo.id, ref: ciCheckRef, status: r.status } }));
            })
            .catch((err) => console.warn(JSON.stringify({ ciPreparedRefCleanup: { repo: cx.repo.id, ref: ciCheckRef, error: String(err) } }))),
        );
      }
      const merged = (read?.results as ChangeRow[] | undefined)?.[0] ?? row;
      return {
        ok: true,
        value: {
          change: changeView(merged),
          merge: { kind: pv.kind, mergeCommit: pv.mergeCommit, treeSha: pv.treeSha, previous: pv.targetSha, work: pv.work },
        },
      };
    }
    return last ?? fail(409, 'the base branch kept moving, retry', 'STALE_TARGET');
  });
}

/**
 * A merge moves the base branch, so an agent token may merge, or opt a
 * change into `auto`, only when its ref patterns allow updating that branch.
 */
export function agentMergeDenial(actor: Actor | null, base: string, what: MergePolicy | 'merge'): Fail | null {
  if (!actor?.agent || (what !== 'merge' && what !== 'auto')) return null;
  if (credentialMayUpdateRef(actor, branchRef(base))) return null;
  const action = what === 'merge' ? 'merge into' : 'set mergePolicy auto on a change into';
  return fail(403, `this agent token may not ${action} ${branchRef(base)}`, 'AGENT_REF_FORBIDDEN');
}

export function mergeAuthor(actor: Actor | null): { name: string; email: string } | undefined {
  if (!actor) return undefined;
  if (actor.agent) return { name: actor.agent.agentName, email: `${actor.agent.agentId}@agents.kvarm.invalid` };
  return { name: actor.user.name ?? actor.user.login, email: actor.user.email };
}

/**
 * POST changes/:number/merge — explicit merge; refused for drafts, closed and
 * merged changes. `body.attribution` ({agent?, session?, promptHash?, model?})
 * fills the merge commit's attribution note; omitted fields name the caller.
 */
export function mergeChange(
  cx: ChangeContext,
  rawNumber: string,
  deps: MergeDeps = defaultMergeDeps,
  body: unknown = undefined,
): Promise<ServiceResult<MergeOutcome>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    let attribution: AttributionInput | null = null;
    if (body !== undefined && body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) return fail(400, 'body must be a JSON object {attribution?}', 'INVALID_BODY');
      const raw = (body as { attribution?: unknown }).attribution;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          return fail(422, 'attribution must be an object {agent?, session?, promptHash?, model?}', 'INVALID_ATTRIBUTION');
        }
        const parsed = parseAttributionInput(raw, mergeAttributionDefaults(cx.actor, number ?? 0));
        if (!parsed.ok) return fail(parsed.status, parsed.error, parsed.code ?? 'INVALID_ATTRIBUTION');
        attribution = parsed.value;
      }
    }
    let row: ChangeRow | null = null;
    let facts: ReviewFacts | undefined;
    let pins: DependencyRow[] | undefined;
    if (number !== null) {
      const [change, reviews, deps] = await cx.env.DB.batch([
        changeSelect(cx.env.DB, cx.repo.id, number),
        reviewFactsSelect(cx.env.DB, cx.repo.id, number),
        changeNumberDependenciesStatement(cx.env.DB, cx.repo.id, number),
      ]);
      row = (change?.results as ChangeRow[] | undefined)?.[0] ?? null;
      facts = parseReviewFacts((reviews?.results as ReviewFactsRow[] | undefined)?.[0]);
      pins = deps?.results as DependencyRow[] | undefined;
    }
    const refused = mergeRefusal(row, 'explicit');
    if (refused || !row) return refused ?? fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const denied = agentMergeDenial(cx.actor, row.base_ref, 'merge');
    if (denied) return denied;
    // A pinned dependency lands first: the explicit merge of a dependent waits for its source like the train does.
    const pinned = dependencyRefusal(pins);
    if (pinned) return pinned;
    return performMerge(cx, row, mergeAuthor(cx.actor), deps, 'explicit', attribution, facts);
  });
}

/**
 * Merges an open `auto` change when it is mergeable now. Returns the merged
 * row, or null when it stays open (not mergeable yet, checks pending or
 * failed, conflicts, or a caller's agent token that may not update the
 * base); a refusal is logged, never an error for the caller.
 */
export async function autoMerge(cx: ChangeContext, row: ChangeRow, deps: MergeDeps = defaultMergeDeps): Promise<ChangeRow | null> {
  return (await attemptAutoMerge(cx, row, deps)).row;
}

/**
 * An auto-merge attempt. `failed` marks an operational failure: the attempt
 * threw, or the merge refused with a status of 500 or above (storage
 * unavailable, head update failed, merge read failed). Such a change may
 * merge on a plain retry, so a settlement owner that resumed it keeps its
 * wake mark. A 4xx refusal (checks pending or failed, review, dependency
 * gates, head moved, conflicts) is not ready, not failed: the checks-gate
 * and push hooks resume it when its state changes.
 */
interface AutoMergeAttempt {
  row: ChangeRow | null;
  failed: boolean;
}

async function attemptAutoMerge(cx: ChangeContext, row: ChangeRow, deps: MergeDeps): Promise<AutoMergeAttempt> {
  if (row.merge_policy !== 'auto' || row.state !== 'open') return { row: null, failed: false };
  // A queued change publishes through the integration train (services/queue.ts) only.
  if (row.queue_state !== null) return { row: null, failed: false };
  if (agentMergeDenial(cx.actor, row.base_ref, 'merge')) {
    console.log(JSON.stringify({ autoMerge: { repo: cx.repo.id, number: row.number, ok: false, code: 'AGENT_REF_FORBIDDEN' } }));
    return { row: null, failed: false };
  }
  try {
    const r = await guarded(() => performMerge(cx, row, undefined, deps, 'auto'));
    console.log(JSON.stringify({ autoMerge: { repo: cx.repo.id, number: row.number, ok: r.ok, ...(r.ok ? {} : { code: r.code }) } }));
    if (!r.ok) return { row: null, failed: r.status >= 500 };
    return { row: (await readChange(cx.env, cx.repo.id, row.number)) ?? null, failed: false };
  } catch (err) {
    console.warn(JSON.stringify({ autoMerge: { repo: cx.repo.id, number: row.number, error: String(err).slice(0, 200) } }));
    return { row: null, failed: true };
  }
}

// ---------------------------------------------------------------------------
// Push hooks (services/events.ts)
// ---------------------------------------------------------------------------

/** An open change whose head branch an event touched, as read back by the ingest batch. */
export interface ChangeOnRef {
  id: string;
  number: number;
  /** Open or conflicted (absent in readbacks that predate conflicts: open). */
  state?: ChangeState;
  policy: MergePolicy;
  headSha: string | null;
  /** The head its active merge-queue entry approved, when the change is queued. */
  queuedHead?: string | null;
}

export interface HeadMoved {
  env: Env;
  repoId: string;
  change: ChangeOnRef;
  headSha: string;
}

/**
 * Runs for every open change whose head moved to a pushed commit, in order.
 * The guard comes first, so hooks after it (the train kick of a queued
 * change) and the auto merge that follows see the new head's guard run.
 */
export type HeadMovedHook = (e: HeadMoved) => Promise<void>;
export const HEAD_MOVED_HOOKS: HeadMovedHook[] = [
  async (e) => {
    await recordGuard(e.env, e.repoId, e.change.id, e.headSha);
  },
  async (e) => {
    const repo = await e.env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(e.repoId).first<RepoRow>();
    if (repo) await queueChangeCi(e.env, repo, e.change.id, e.headSha);
  },
];

async function repoWithRules(env: Env, repoId: string): Promise<{ repo: RepoRow; rules: BranchRule[] } | null> {
  const [repo, rules] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(repoId),
    env.DB.prepare(
      `SELECT ${BRANCH_RULE_COLUMNS}
         FROM branch_rules b WHERE b.repo_id = ? LIMIT 50`,
    ).bind(repoId),
  ]);
  const row = (repo?.results as RepoRow[] | undefined)?.[0];
  if (!row) return null;
  return { repo: row, rules: ((rules?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow) };
}

/** Open `auto` changes attempted per mergeReadyAutoChanges call. */
export const AUTO_MERGE_PAGE = 20;

export interface AutoMergePass {
  merged: number[];
  /** Changes whose attempt failed operationally (see AutoMergeAttempt); a retry may merge them. */
  failed: number[];
  /** Pass as `after` to continue with the changes numbered above it; null when none remain. */
  next: number | null;
}

/**
 * Attempts the merge of the open `auto` changes in the repo, or only the
 * given numbers, in number order and at most AUTO_MERGE_PAGE per call. The
 * checks-gate producers call this when a check run completes; push
 * processing calls it when an `auto` change's head moves.
 */
export async function mergeReadyAutoChanges(
  env: Env,
  repoId: string,
  numbers: number[] | null,
  waitUntil: (p: Promise<unknown>) => void,
  opts: { after?: number; deps?: MergeDeps } = {},
): Promise<AutoMergePass> {
  const ctxRows = await repoWithRules(env, repoId);
  if (!ctxRows) return { merged: [], failed: [], next: null };
  const after = opts.after ?? 0;
  const where = `c.repo_id = ?1 AND c.state = 'open' AND c.merge_policy = 'auto' AND c.number > ?2`;
  const page = `ORDER BY c.number LIMIT ${AUTO_MERGE_PAGE}`;
  const stmt = numbers
    ? env.DB.prepare(`${CHANGE_SELECT} WHERE ${where} AND c.number IN (SELECT value FROM json_each(?3)) ${page}`).bind(repoId, after, JSON.stringify(numbers))
    : env.DB.prepare(`${CHANGE_SELECT} WHERE ${where} ${page}`).bind(repoId, after);
  const rows = (await stmt.all<ChangeRow>()).results ?? [];
  const merged: number[] = [];
  const failed: number[] = [];
  const cx: ChangeContext = { env, repo: ctxRows.repo, actor: null, branchRules: ctxRows.rules, waitUntil };
  for (const row of rows) {
    const done = await attemptAutoMerge(cx, row, opts.deps ?? defaultMergeDeps);
    if (done.row?.state === 'merged') merged.push(row.number);
    else if (done.failed) failed.push(row.number);
  }
  return { merged, failed, next: rows.length === AUTO_MERGE_PAGE ? rows[rows.length - 1]!.number : null };
}

/**
 * Attempts the merge of the given open `auto` changes (a finite set), one
 * bounded page of AUTO_MERGE_PAGE at a time. Every gate is re-checked by
 * the merge itself; changes that are not open `auto` are skipped.
 */
export async function resumeAutoChanges(
  env: Env,
  repoId: string,
  numbers: number[],
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ merged: number[]; failed: number[] }> {
  const merged: number[] = [];
  const failed: number[] = [];
  for (let after: number | null = 0; numbers.length > 0 && after !== null; ) {
    const pass: AutoMergePass = await mergeReadyAutoChanges(env, repoId, numbers, waitUntil, { after });
    merged.push(...pass.merged);
    failed.push(...pass.failed);
    after = pass.next;
  }
  return { merged, failed };
}

/**
 * resumeAutoChanges for a landing's settlement owners: rejects when a
 * resumed dependent failed operationally, so the owner keeps its wake mark
 * and retries; a dependent that is merely not ready clears its mark.
 */
export async function resumeAutoDependents(env: Env, repoId: string, numbers: number[], waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const { failed } = await resumeAutoChanges(env, repoId, numbers, waitUntil);
  if (failed.length > 0) throw new Error(`auto dependents ${failed.map((n) => `#${n}`).join(',')} failed to resume operationally`);
}

/** Which live changes a conflict re-evaluation covers. */
type ConflictScope = { numbers: number[] } | { conflictedAutoOnBase: string };

/**
 * Re-evaluates the conflict state (services/conflicts.ts) of the scoped live
 * changes at their current heads against their base tips, in pages of
 * AUTO_MERGE_PAGE by number until none remain: per page two D1 reads, the
 * cached merge plans, and one batch with the transitions (none when nothing
 * changed). Returns the numbers now open.
 */
async function reevaluateConflicts(env: Env, repoId: string, scope: ConflictScope, waitUntil: (p: Promise<unknown>) => void): Promise<number[]> {
  const where =
    'numbers' in scope
      ? `c.state IN ('open', 'conflicted') AND c.number IN (SELECT value FROM json_each(?2))`
      : `c.state = 'conflicted' AND c.merge_policy = 'auto' AND c.base_ref = ?2`;
  const param = 'numbers' in scope ? JSON.stringify(scope.numbers) : scope.conflictedAutoOnBase;
  const open = new Set<number>();
  for (let after = 0; ; ) {
    const [repoRead, changeRead] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(repoId),
      env.DB.prepare(`${CHANGE_SELECT} WHERE c.repo_id = ?1 AND ${where} AND c.number > ?3 ORDER BY c.number LIMIT ${AUTO_MERGE_PAGE}`).bind(
        repoId,
        param,
        after,
      ),
    ]);
    const repo = (repoRead?.results as RepoRow[] | undefined)?.[0];
    const rows = (changeRead?.results as ChangeRow[] | undefined) ?? [];
    if (!repo || rows.length === 0) break;
    const now = Date.now();
    const writes: D1PreparedStatement[] = [];
    for (const r of rows) if (r.state === 'open') open.add(r.number);
    await withLazyRepo(env, repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx({ env, repo, waitUntil }, artifacts);
      const bases = [...new Set(rows.map((r) => branchRef(r.base_ref)))];
      const tips = await lsRefs(ctx, bases);
      for (const row of rows) {
        const target = tips.get(branchRef(row.base_ref));
        if (!target || !row.head_sha) continue;
        const m = await mergePlanFor(ctx, target, row.head_sha);
        const t = conflictTransition(row, m);
        if (!t) continue;
        writes.push(...transitionStatements(env.DB, repoId, { id: row.id, number: row.number, head_sha: row.head_sha }, t, now));
        if (t.kind === 'clear') open.add(row.number);
        else open.delete(row.number);
      }
    });
    if (writes.length > 0) await env.DB.batch(writes);
    if (rows.length < AUTO_MERGE_PAGE) break;
    after = rows[rows.length - 1]!.number;
  }
  return [...open];
}

/**
 * Push-event effect body for a branch that is the base of conflicted `auto`
 * changes: re-evaluates them against the new tip and merges those the move
 * cleared (every gate is re-checked by the merge).
 */
export async function onBasePushed(env: Env, repoId: string, branch: string, waitUntil: (p: Promise<unknown>) => void): Promise<{ state: 'done'; detail: string }> {
  const reopened = await reevaluateConflicts(env, repoId, { conflictedAutoOnBase: branch }, waitUntil);
  const { merged } = reopened.length > 0 ? await resumeAutoChanges(env, repoId, reopened, waitUntil) : { merged: [] };
  return { state: 'done', detail: `base: reopened ${reopened.length}, auto-merged ${merged.length}` };
}

/**
 * Push-event effect body for a branch push: runs the head-moved hooks for
 * live changes now at `after`, re-evaluates the conflict state of those that
 * do not merge on their own (conflicted ones, and open ones without
 * mergePolicy auto, whose merge attempt records a conflict itself), then
 * merges the `auto` ones that are ready. Costs no D1 when no live change
 * uses the branch as its head.
 */
export async function onHeadPushed(
  env: Env,
  repoId: string,
  changes: ChangeOnRef[],
  after: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ state: 'done' | 'skipped'; detail: string }> {
  if (after === ZERO_SHA) return { state: 'skipped', detail: 'ref deleted' };
  const moved = changes.filter((c) => c.headSha === after);
  if (moved.length === 0) return { state: 'skipped', detail: changes.length === 0 ? 'no open changes' : 'heads not at this push' };
  for (const change of moved) {
    for (const hook of HEAD_MOVED_HOOKS) await hook({ env, repoId, change, headSha: after });
  }
  const evaluate = moved.filter((c) => c.state === 'conflicted' || c.policy !== 'auto').map((c) => c.number);
  const reopened = evaluate.length > 0 ? new Set(await reevaluateConflicts(env, repoId, { numbers: evaluate }, waitUntil)) : new Set<number>();
  const auto = moved.filter((c) => c.policy === 'auto' && (c.state !== 'conflicted' || reopened.has(c.number))).map((c) => c.number);
  const { merged } = await resumeAutoChanges(env, repoId, auto, waitUntil);
  const parts = [`heads ${moved.map((c) => `#${c.number}`).join(',')}`];
  if (auto.length > 0) parts.push(`auto-merged ${merged.length ? merged.map((n) => `#${n}`).join(',') : 'none'}`);
  return { state: 'done', detail: parts.join('; ') };
}

/** Statements that remove a repo's changes and their dependents, for the repo DELETE batch (before the repo row). */
export function changeCleanupStatements(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM comments WHERE change_set_id IN (SELECT id FROM change_sets WHERE repo_id = ?)').bind(repoId),
    ciCleanupStatement(db, repoId),
    db.prepare('DELETE FROM check_runs WHERE repo_id = ?').bind(repoId),
    ...flakeCleanupStatements(db, repoId),
    db.prepare('UPDATE workspaces SET change_set_id = NULL WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM merge_queue WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM merge_trains WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM merge_admission WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM agent_tasks WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM change_reviews WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM change_escalations WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM review_policies WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM change_sets WHERE repo_id = ?').bind(repoId),
  ];
}
