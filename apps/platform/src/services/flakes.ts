/**
 * Flaky required checks (architecture §0.3): retry-then-classify and
 * quarantine.
 *
 * A required runner check (a `.kvarm/ci.json` job) that fails on attempt 1
 * gets exactly one more attempt on the same job row, so the same head and
 * tree (a composed train tree retries that composed tree only). Attempt 2
 * is a new check run with `retry_of` naming the failure; as the newest run
 * of its name on the tree it is what the gate reads. A pass on attempt 2
 * records a flake and the check counts as passed; a second failure blocks
 * like any failure and is never retried again. Platform checks
 * (`kvarm/*`), reported runs, non-required jobs, jobs of a change that is
 * no longer open or that has a newer job of the same name (a moved head or
 * a re-prepared composition), and quarantined checks no branch rule names
 * are never retried.
 *
 * Quarantine is per check name and always expires (default 7 days, at most
 * 90). A quarantined check still runs, but its runs are neutral: the gate
 * reports them apart from the required set, so they neither satisfy nor
 * block it. A branch rule that names a quarantined check still requires it
 * (fail-closed): quarantine never overrides an explicit rule. Repo admins
 * quarantine and restore; each change appends an `events` audit row.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';

export const FLAKE_LIMITS = {
  pageDefault: 50,
  pageMax: 100,
  /** Active quarantines per repository; the gate loads them in one bounded read. */
  quarantinesMax: 50,
  defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxTtlMs: 90 * 24 * 60 * 60 * 1000,
  reasonMax: 500,
  nameMax: 100,
} as const;

type Fail = Extract<ServiceResult<never>, { ok: false }>;
const fail = (status: number, error: string, code: string): Fail => ({ ok: false, status, error, code });

// ---------------------------------------------------------------------------
// Shared SQL
// ---------------------------------------------------------------------------

/** SQL true when check `name` of repo `repo` is quarantined at `now` (all three are SQL expressions). */
export function quarantinedSql(repo: string, name: string, now: string): string {
  return `EXISTS (SELECT 1 FROM check_quarantines q WHERE q.repo_id = ${repo} AND q.name = ${name} AND q.expires_at > ${now})`;
}

/** The names quarantined in a repository at `now`, as one bounded statement. */
export function activeQuarantinesStatement(db: D1Database, repoId: string, now: number): D1PreparedStatement {
  return db
    .prepare(`SELECT name FROM check_quarantines WHERE repo_id = ?1 AND expires_at > ?2 ORDER BY name LIMIT ${FLAKE_LIMITS.quarantinesMax}`)
    .bind(repoId, now);
}

export function quarantineNames(rows: ReadonlyArray<{ name: string }> | undefined): Set<string> {
  return new Set((rows ?? []).map((r) => r.name));
}

/** Views whose check is quarantined now read `quarantined: true` (neutral, never counted). */
export function markQuarantined<T extends { name: string; quarantined: boolean }>(views: T[], names: ReadonlySet<string>): T[] {
  if (names.size === 0) return views;
  return views.map((v) => (v.quarantined || !names.has(v.name) ? v : { ...v, quarantined: true }));
}

/** Statements that remove a repository's flake registry and quarantines (repo DELETE batch). */
export function flakeCleanupStatements(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM check_flakes WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM check_quarantines WHERE repo_id = ?').bind(repoId),
  ];
}

// ---------------------------------------------------------------------------
// Retry-then-classify (runs inside the CI report batch, services/ci.ts)
// ---------------------------------------------------------------------------

export interface RetryInput {
  jobId: string;
  repoId: string;
  generation: number;
  runnerId: string;
  /** The report's `finished_at`: it identifies the terminal transition this very batch made. */
  now: number;
}

/**
 * Statements appended to the fenced report batch after the job's terminal
 * update. Every one keys on the transition this report made (generation,
 * owner, terminal status and its `finished_at`), so a duplicate or stale
 * report, which makes no transition, retries nothing and records nothing.
 * The last statement reads back what happened.
 */
export function retryStatements(db: D1Database, r: RetryInput): D1PreparedStatement[] {
  const retryRunId = crypto.randomUUID();
  const flakeId = crypto.randomUUID();
  const transitioned = (status: 'failure' | 'success') =>
    `j.id = ?1 AND j.repo_id = ?2 AND j.generation = ?3 AND j.claimed_by = ?4 AND j.status = '${status}' AND j.finished_at = ?5`;
  return [
    // Attempt 2: only for a required attempt-1 runner run of a live change whose job is still the newest of its
    // name there. A quarantined check is retried only while a branch rule names it, since such a rule still
    // requires it (fail-closed). Created after attempt 1 so it is the newest run of the name on the tree, which
    // is what the gate and the commit status read.
    db
      .prepare(
        `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, tree_sha, name, status, attempt, required, quarantined, retry_of, created_at)
         SELECT ?6, k.repo_id, k.change_set_id, k.head_sha, k.tree_sha, k.name, 'queued', 2, 1, 0, k.id, max(?5, k.created_at + 1)
           FROM ci_jobs j JOIN check_runs k ON k.id = j.check_run_id
          WHERE ${transitioned('failure')}
            AND j.required = 1 AND k.required = 1 AND k.quarantined = 0 AND k.attempt = 1 AND k.retry_of IS NULL
            AND k.name NOT LIKE 'kvarm/%'
            AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = j.change_set_id AND c.state IN ('open', 'conflicted'))
            AND NOT EXISTS (SELECT 1 FROM ci_jobs n WHERE n.change_set_id = j.change_set_id AND n.name = j.name AND n.created_at > j.created_at)
            AND (NOT ${quarantinedSql('j.repo_id', 'k.name', '?5')}
                 OR EXISTS (SELECT 1 FROM branch_rules b, json_each(b.required_checks) rc WHERE b.repo_id = j.repo_id AND rc.value = k.name))
         ON CONFLICT DO NOTHING`,
      )
      .bind(r.jobId, r.repoId, r.generation, r.runnerId, r.now, retryRunId),
    // The same job row runs attempt 2: requeued under its current generation, which the next claim bumps, so
    // the attempt-1 runner's fence is stale from here on. It keeps its created_at, so the claim order serves it
    // next: a candidate is waiting on it. Attempt 1's summary stays on its own check run.
    db
      .prepare(
        `UPDATE ci_jobs SET status = 'queued', check_run_id = ?6, claimed_by = NULL, claim_id = NULL, lease_until = NULL,
                started_at = NULL, finished_at = NULL, summary = NULL
          WHERE id = ?1 AND repo_id = ?2 AND generation = ?3 AND claimed_by = ?4 AND status = 'failure' AND finished_at = ?5
            AND EXISTS (SELECT 1 FROM check_runs WHERE id = ?6 AND retry_of IS NOT NULL)`,
      )
      .bind(r.jobId, r.repoId, r.generation, r.runnerId, r.now, retryRunId),
    db
      .prepare(
        `INSERT INTO check_flakes (id, repo_id, name, tree_sha, head_sha, change_set_id, failed_run_id, passed_run_id, created_at)
         SELECT ?6, k.repo_id, k.name, k.tree_sha, k.head_sha, k.change_set_id, k.retry_of, k.id, ?5
           FROM ci_jobs j JOIN check_runs k ON k.id = j.check_run_id
          WHERE ${transitioned('success')} AND k.retry_of IS NOT NULL
         ON CONFLICT DO NOTHING`,
      )
      .bind(r.jobId, r.repoId, r.generation, r.runnerId, r.now, flakeId),
    db
      .prepare(
        `SELECT (SELECT id FROM check_runs WHERE id = ?1 AND repo_id = ?3) AS retry_run_id,
                (SELECT id FROM check_flakes WHERE id = ?2 AND repo_id = ?3) AS flake_id`,
      )
      .bind(retryRunId, flakeId, r.repoId),
  ];
}

export interface RetryOutcome {
  /** The attempt-2 run this failure scheduled, or null. */
  retry: { runId: string; attempt: 2 } | null;
  /** The flake this attempt-2 pass recorded, or null. */
  flake: { id: string } | null;
}

export function retryOutcome(row: { retry_run_id: string | null; flake_id: string | null } | undefined): RetryOutcome {
  return {
    retry: row?.retry_run_id ? { runId: row.retry_run_id, attempt: 2 } : null,
    flake: row?.flake_id ? { id: row.flake_id } : null,
  };
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

const QUARANTINE_COLUMNS = 'name, reason, quarantined_by, created_at, expires_at';

interface QuarantineRow {
  name: string;
  reason: string | null;
  quarantined_by: string;
  created_at: number;
  expires_at: number;
}

export interface QuarantineView {
  check: string;
  reason: string | null;
  quarantinedBy: string;
  quarantinedAt: string;
  expiresAt: string;
}

function quarantineView(r: QuarantineRow): QuarantineView {
  return {
    check: r.name,
    reason: r.reason,
    quarantinedBy: r.quarantined_by,
    quarantinedAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}

interface FlakeRow {
  id: string;
  name: string;
  tree_sha: string;
  head_sha: string;
  change_number: number | null;
  failed_run_id: string;
  passed_run_id: string;
  created_at: number;
}

export interface FlakeView {
  id: string;
  check: string;
  treeSha: string;
  headSha: string;
  change: number | null;
  failedRunId: string;
  passedRunId: string;
  /** Whether the check is quarantined now. */
  quarantined: boolean;
  createdAt: string;
}

export interface FlakePage {
  /** Checks quarantined now (expired quarantines count as restored and are not listed). */
  quarantines: QuarantineView[];
  flakes: FlakeView[];
  nextCursor: string | null;
}

/** `<created_at>.<id>` of the last flake on a page. */
const CURSOR = /^(\d{1,15})\.([0-9a-f-]{36})$/;

function checkName(raw: unknown): ServiceResult<string> {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length === 0 || name.length > FLAKE_LIMITS.nameMax) return fail(422, `check must be 1-${FLAKE_LIMITS.nameMax} characters`, 'INVALID_CHECK_NAME');
  if (name.toLowerCase().startsWith('kvarm/')) return fail(422, 'platform checks under kvarm/ cannot be quarantined', 'RESERVED_CHECK_NAME');
  return { ok: true, value: name };
}

/** GET flakes?check=&limit=&cursor= — one batch: the active quarantines and one newest-first page of flakes. */
export async function listFlakes(
  env: Env,
  repo: RepoRow,
  q: { check?: string; limit?: string; cursor?: string },
): Promise<ServiceResult<FlakePage>> {
  let check: string | null = null;
  if (q.check !== undefined && q.check !== '') {
    if (q.check.length > FLAKE_LIMITS.nameMax) return fail(400, `check must be at most ${FLAKE_LIMITS.nameMax} characters`, 'INVALID_CHECK_NAME');
    check = q.check;
  }
  let limit: number = FLAKE_LIMITS.pageDefault;
  if (q.limit !== undefined) {
    if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > FLAKE_LIMITS.pageMax) {
      return fail(400, `limit must be an integer from 1 to ${FLAKE_LIMITS.pageMax}`, 'INVALID_LIMIT');
    }
    limit = Number(q.limit);
  }
  let beforeAt = Number.MAX_SAFE_INTEGER;
  let beforeId = '~';
  if (q.cursor !== undefined && q.cursor !== '') {
    const m = CURSOR.exec(q.cursor);
    if (!m) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    beforeAt = Number(m[1]);
    beforeId = m[2]!;
  }
  const now = Date.now();
  const [quarantines, flakes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${QUARANTINE_COLUMNS} FROM check_quarantines
        WHERE repo_id = ?1 AND expires_at > ?2 ORDER BY name LIMIT ${FLAKE_LIMITS.quarantinesMax}`,
    ).bind(repo.id, now),
    env.DB.prepare(
      `SELECT f.id, f.name, f.tree_sha, f.head_sha, c.number AS change_number, f.failed_run_id, f.passed_run_id, f.created_at
         FROM check_flakes f LEFT JOIN change_sets c ON c.id = f.change_set_id
        WHERE f.repo_id = ?1 AND (?2 IS NULL OR f.name = ?2) AND (f.created_at < ?3 OR (f.created_at = ?3 AND f.id < ?4))
        ORDER BY f.created_at DESC, f.id DESC LIMIT ${limit + 1}`,
    ).bind(repo.id, check, beforeAt, beforeId),
  ]);
  const active = ((quarantines?.results ?? []) as QuarantineRow[]).map(quarantineView);
  const names = new Set(active.map((a) => a.check));
  const rows = (flakes?.results ?? []) as FlakeRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ok: true,
    value: {
      quarantines: active,
      flakes: page.map((f) => ({
        id: f.id,
        check: f.name,
        treeSha: f.tree_sha,
        headSha: f.head_sha,
        change: f.change_number,
        failedRunId: f.failed_run_id,
        passedRunId: f.passed_run_id,
        quarantined: names.has(f.name),
        createdAt: new Date(f.created_at).toISOString(),
      })),
      nextCursor: rows.length > limit && last ? `${last.created_at}.${last.id}` : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Quarantine and restore (repo admins; audited)
// ---------------------------------------------------------------------------

function auditQuarantine(db: D1Database, type: string, repo: RepoRow, name: string, actor: Actor, now: number, where: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, ?2, json_object('repoId', q.repo_id, 'repo', ?5, 'check', q.name, 'reason', q.reason,
                                  'expiresAt', strftime('%Y-%m-%dT%H:%M:%fZ', q.expires_at / 1000.0, 'unixepoch'), 'actor', ?6),
              ?7, ?7
         FROM check_quarantines q WHERE q.repo_id = ?3 AND q.name = ?4 AND ${where}`,
    )
    .bind(crypto.randomUUID(), type, repo.id, name, `${repo.owner_login}/${repo.name}`, actor.user.login, now);
}

function parseExpiry(raw: unknown, now: number): ServiceResult<number> {
  if (raw === undefined || raw === null) return { ok: true, value: now + FLAKE_LIMITS.defaultTtlMs };
  const at = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at) || at <= now || at > now + FLAKE_LIMITS.maxTtlMs) {
    return fail(422, 'expiresAt must be an ISO 8601 time in the future, at most 90 days ahead', 'INVALID_EXPIRY');
  }
  return { ok: true, value: at };
}

/**
 * POST flakes/:check/quarantine {reason?, expiresAt?}. Quarantining an
 * already quarantined check replaces its reason and expiry. One batch:
 * drop expired rows, upsert under the per-repo cap, audit, read back.
 */
export async function quarantineCheck(env: Env, repo: RepoRow, actor: Actor, rawName: string, input: unknown): Promise<ServiceResult<QuarantineView>> {
  const name = checkName(rawName);
  if (!name.ok) return name;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  const body = input as Record<string, unknown>;
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string' || body.reason.length > FLAKE_LIMITS.reasonMax) {
      return fail(422, `reason must be a string of at most ${FLAKE_LIMITS.reasonMax} characters`, 'INVALID_REASON');
    }
    reason = body.reason.trim() || null;
  }
  const now = Date.now();
  const expires = parseExpiry(body.expiresAt, now);
  if (!expires.ok) return expires;
  const written = `q.created_at = ${now} AND q.quarantined_by = ?6`;
  const [, , , read] = await env.DB.batch([
    env.DB.prepare('DELETE FROM check_quarantines WHERE repo_id = ?1 AND expires_at <= ?2').bind(repo.id, now),
    env.DB.prepare(
      `INSERT INTO check_quarantines (repo_id, name, reason, quarantined_by, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE (SELECT COUNT(*) FROM check_quarantines WHERE repo_id = ?1 AND name <> ?2) < ${FLAKE_LIMITS.quarantinesMax}
       ON CONFLICT (repo_id, name) DO UPDATE SET reason = excluded.reason, quarantined_by = excluded.quarantined_by,
                                                 created_at = excluded.created_at, expires_at = excluded.expires_at`,
    ).bind(repo.id, name.value, reason, actor.user.login, now, expires.value),
    auditQuarantine(env.DB, 'check.quarantined', repo, name.value, actor, now, written),
    env.DB.prepare(
      `SELECT ${QUARANTINE_COLUMNS} FROM check_quarantines q
        WHERE q.repo_id = ?1 AND q.name = ?2 AND q.created_at = ?3 AND q.quarantined_by = ?4`,
    ).bind(repo.id, name.value, now, actor.user.login),
  ]);
  const row = (read?.results as QuarantineRow[] | undefined)?.[0];
  if (!row) return fail(422, `a repository can quarantine at most ${FLAKE_LIMITS.quarantinesMax} checks at once`, 'TOO_MANY_QUARANTINES');
  return { ok: true, value: quarantineView(row) };
}

/** POST flakes/:check/restore — ends an active quarantine (404 when the check is not quarantined). */
export async function restoreCheck(env: Env, repo: RepoRow, actor: Actor, rawName: string): Promise<ServiceResult<QuarantineView>> {
  const name = checkName(rawName);
  if (!name.ok) return name;
  const now = Date.now();
  const [read] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${QUARANTINE_COLUMNS} FROM check_quarantines
        WHERE repo_id = ?1 AND name = ?2 AND expires_at > ?3`,
    ).bind(repo.id, name.value, now),
    auditQuarantine(env.DB, 'check.restored', repo, name.value, actor, now, `q.expires_at > ${now}`),
    env.DB.prepare('DELETE FROM check_quarantines WHERE repo_id = ?1 AND name = ?2').bind(repo.id, name.value),
  ]);
  const row = (read?.results as QuarantineRow[] | undefined)?.[0];
  if (!row) return fail(404, `check ${name.value} is not quarantined`, 'NOT_QUARANTINED');
  return { ok: true, value: quarantineView(row) };
}
