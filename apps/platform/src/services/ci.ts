/**
 * User-owned CI pipelines. `.kvarm/ci.json` is read at the immutable head,
 * each valid job becomes one queued check run and one generation-fenced
 * runner job, and claim/report use one D1 batch apiece.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { withLazyRepo } from '../artifacts/repo';
import { CHECK_RUN_COLUMNS, checkRunView, type CheckRunRow, type CheckRunView } from './checks';
import { CI_CONFIG_PATH, CI_LIMITS, parseCiConfig, type CiConfig } from './ciConfig';
import { quarantinedSql, retryOutcome, retryStatements, type RetryOutcome } from './flakes';

export const CI_LEASE_SECONDS = 120;
export { CI_CONFIG_PATH, CI_LIMITS, type CiConfig } from './ciConfig';

/**
 * Parsed configs keyed by (Artifacts repo, commit). A commit's config never
 * changes, so one train run reads each head's config once however many
 * passes and calls ask for it.
 */
export type CiConfigMemo = Map<string, Promise<ServiceResult<CiConfig | null>>>;

type Fail = Extract<ServiceResult<never>, { ok: false }>;
const fail = (status: number, error: string, code: string): Fail => ({ ok: false, status, error, code });

async function readConfigAt(env: Env, artifactsName: string, headSha: string): Promise<ServiceResult<CiConfig | null>> {
  return withLazyRepo(env, artifactsName, async (repo) => {
    const blob = await (await repo.get()).readFile({ ref: headSha, path: CI_CONFIG_PATH });
    if (!blob) return { ok: true, value: null };
    if (blob.size > CI_LIMITS.configBytes) return fail(422, `${CI_CONFIG_PATH} is too large`, 'CI_CONFIG_TOO_LARGE');
    return parseCiConfig(await blob.text());
  });
}

function configAt(env: Env, artifactsName: string, headSha: string, memo?: CiConfigMemo): Promise<ServiceResult<CiConfig | null>> {
  if (!memo) return readConfigAt(env, artifactsName, headSha);
  const key = `${artifactsName}:${headSha}`;
  let read = memo.get(key);
  if (!read) {
    read = readConfigAt(env, artifactsName, headSha);
    memo.set(key, read);
    // A failed read (storage, not config) is retried by the next caller instead of being remembered.
    read.catch(() => memo.delete(key));
  }
  return read;
}

export async function hasCiJobs(env: Env, artifactsName: string, headSha: string, memo?: CiConfigMemo): Promise<ServiceResult<boolean>> {
  const config = await configAt(env, artifactsName, headSha, memo);
  return config.ok ? { ok: true, value: (config.value?.jobs.length ?? 0) > 0 } : config;
}

export interface QueuedPipeline {
  jobs: number;
  workflowId: string | null;
}

async function queueJobs(
  env: Env,
  repo: Pick<RepoRow, 'id' | 'artifacts_name'>,
  changeId: string,
  configSha: string,
  headSha: string,
  treeSha: string | undefined,
  memo?: CiConfigMemo,
): Promise<ServiceResult<QueuedPipeline>> {
  const config = await configAt(env, repo.artifacts_name, configSha, memo);
  if (!config.ok) {
    const tree = await withLazyRepo(env, repo.artifacts_name, async (r) => (await (await r.get()).readCommit(headSha))?.treeHash);
    if (tree) {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, tree_sha, name, status, conclusion, summary, attempt, required, quarantined, started_at, finished_at, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'kvarm/ci-config', 'failure', 'failure', ?6, 1, 1, 0, ?7, ?7, ?7
          WHERE NOT EXISTS (SELECT 1 FROM check_runs WHERE change_set_id = ?3 AND head_sha = ?4 AND name = 'kvarm/ci-config')`,
      )
        .bind(crypto.randomUUID(), repo.id, changeId, headSha, tree, JSON.stringify({ code: config.code, error: config.error }), now)
        .run();
    }
    return config;
  }
  if (config.value === null || config.value.jobs.length === 0) return { ok: true, value: { jobs: 0, workflowId: null } };
  let tree = treeSha;
  if (!tree) {
    tree = await withLazyRepo(env, repo.artifacts_name, async (r) => (await (await r.get()).readCommit(headSha))?.treeHash);
    if (!tree) return fail(503, `commit could not be read: ${headSha}`, 'STORAGE_UNAVAILABLE');
  }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const [position, job] of config.value.jobs.entries()) {
    const runId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, tree_sha, name, status, attempt, required, quarantined, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'queued', 1, ?7, 0, ?8
          WHERE NOT EXISTS (SELECT 1 FROM check_runs WHERE change_set_id = ?3 AND head_sha = ?4 AND name = ?6)`,
      ).bind(runId, repo.id, changeId, headSha, tree, job.name, job.required ? 1 : 0, now + position),
      env.DB.prepare(
        `INSERT INTO ci_jobs (id, repo_id, change_set_id, check_run_id, head_sha, tree_sha, name, command, required, timeout_seconds, created_at)
         SELECT ?1, ?2, ?3, k.id, ?4, ?5, ?6, ?7, ?8, ?9, ?10
           FROM check_runs k WHERE k.change_set_id = ?3 AND k.head_sha = ?4 AND k.name = ?6
         ON CONFLICT(change_set_id, head_sha, name) DO NOTHING`,
      ).bind(jobId, repo.id, changeId, headSha, tree, job.name, job.run, job.required ? 1 : 0, job.timeoutSeconds, now + position),
    );
  }
  await env.DB.batch(statements);
  const workflowId = `ci-${repo.id}-${headSha}`;
  const pipeline = env.CI_PIPELINE;
  if (!pipeline) return { ok: true, value: { jobs: config.value.jobs.length, workflowId: null } };
  try {
    await pipeline.create({ id: workflowId, params: { repoId: repo.id, changeId, headSha, treeSha: tree } });
  } catch {
    const exists = await pipeline.get(workflowId).then(
      () => true,
      () => false,
    );
    if (!exists) {
      console.error(JSON.stringify({ ciPipelineStartFailed: workflowId }));
      return { ok: true, value: { jobs: config.value.jobs.length, workflowId: null } };
    }
  }
  return { ok: true, value: { jobs: config.value.jobs.length, workflowId } };
}

/** Queue jobs whose config and execution commit are the same change head. */
export function queueChangeCi(
  env: Env,
  repo: Pick<RepoRow, 'id' | 'artifacts_name'>,
  changeId: string,
  headSha: string,
  treeSha?: string,
): Promise<ServiceResult<QueuedPipeline>> {
  return queueJobs(env, repo, changeId, headSha, headSha, treeSha);
}

/**
 * Queue jobs for an exact prepared/composed commit. The commands come from
 * the source head's config, but the runner receives only `executionSha` and
 * therefore cannot accidentally build the source or an unrelated ref.
 */
export function queueExactTreeCi(
  env: Env,
  repo: Pick<RepoRow, 'id' | 'artifacts_name'>,
  changeId: string,
  configSha: string,
  executionSha: string,
  treeSha: string,
  memo?: CiConfigMemo,
): Promise<ServiceResult<QueuedPipeline>> {
  return queueJobs(env, repo, changeId, configSha, executionSha, treeSha, memo);
}

interface JobRow {
  id: string;
  name: string;
  command: string;
  head_sha: string;
  tree_sha: string;
  generation: number;
  claimed_by: string;
  lease_until: number;
  timeout_seconds: number;
  required: number;
  status: string;
}

export interface ClaimedJob {
  id: string;
  name: string;
  command: string;
  sha: string;
  treeSha: string;
  generation: number;
  runnerId: string;
  leaseUntil: string;
  leaseSeconds: number;
  timeoutSeconds: number;
  required: boolean;
}

function jobView(r: JobRow): ClaimedJob {
  return {
    id: r.id,
    name: r.name,
    command: r.command,
    sha: r.head_sha,
    treeSha: r.tree_sha,
    generation: r.generation,
    runnerId: r.claimed_by,
    leaseUntil: new Date(r.lease_until).toISOString(),
    leaseSeconds: CI_LEASE_SECONDS,
    timeoutSeconds: r.timeout_seconds,
    required: r.required === 1,
  };
}

function runnerIdOf(input: unknown): ServiceResult<string> {
  const id = (input as { runnerId?: unknown } | null)?.runnerId;
  return typeof id === 'string' && id.trim().length >= 1 && id.length <= 200
    ? { ok: true, value: id.trim() }
    : fail(422, 'runnerId is required (1-200 characters)', 'INVALID_RUNNER_ID');
}

/** Claims the oldest queued/expired job and explicitly demands its exact snapshot. */
export async function claimJob(env: Env, repo: RepoRow, input: unknown): Promise<ServiceResult<ClaimedJob | null>> {
  const owner = runnerIdOf(input);
  if (!owner.ok) return owner;
  const now = Date.now();
  const lease = now + CI_LEASE_SECONDS * 1000;
  const claimId = crypto.randomUUID();
  const candidate = `SELECT id FROM ci_jobs
    WHERE repo_id = ?1 AND (status = 'queued' OR (status = 'running' AND lease_until <= ?2))
    ORDER BY created_at, id LIMIT 1`;
  const [claimed, , , read] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ci_jobs SET status = 'running', generation = generation + 1, claimed_by = ?3, claim_id = ?4,
          lease_until = ?5, started_at = COALESCE(started_at, ?2)
       WHERE id = (${candidate})
       RETURNING id`,
    ).bind(repo.id, now, owner.value, claimId, lease),
    env.DB.prepare(
      `UPDATE check_runs SET status = 'running', started_at = COALESCE(started_at, ?2)
        WHERE id = (SELECT check_run_id FROM ci_jobs WHERE repo_id = ?1 AND claim_id = ?3)`,
    ).bind(repo.id, now, claimId),
    env.DB.prepare(
      `INSERT INTO snapshot_commits (repo_id, sha, tree, state, trigger, instance_id, attempt, requested_at)
       SELECT repo_id, head_sha, tree_sha, 'building', 'demand', 'snap-' || repo_id || '-' || head_sha, 0, ?2
         FROM ci_jobs WHERE repo_id = ?1 AND claim_id = ?3
       ON CONFLICT(repo_id, sha) DO NOTHING`,
    ).bind(repo.id, now, claimId),
    env.DB.prepare(
      `SELECT id, name, command, head_sha, tree_sha, generation, claimed_by, lease_until, timeout_seconds, required, status
         FROM ci_jobs WHERE repo_id = ?1 AND claim_id = ?2`,
    ).bind(repo.id, claimId),
  ]);
  if ((claimed?.results?.length ?? 0) === 0) return { ok: true, value: null };
  const row = (read?.results as JobRow[] | undefined)?.[0];
  if (!row) return fail(500, 'claimed CI job could not be read', 'CLAIM_FAILED');
  const snapshotId = `snap-${repo.id}-${row.head_sha}`;
  try {
    await env.SNAPSHOT_BUILDER.create({ id: snapshotId, params: { repoId: repo.id, sha: row.head_sha, trigger: 'demand' } });
  } catch {
    // A push, workflow, checkout, or earlier claim may already own the same immutable build.
    await env.SNAPSHOT_BUILDER.get(snapshotId).catch(() => undefined);
  }
  return { ok: true, value: jobView(row) };
}

interface FenceInput {
  runnerId: string;
  generation: number;
}

function parseFence(input: unknown): ServiceResult<FenceInput> {
  const owner = runnerIdOf(input);
  if (!owner.ok) return owner;
  const generation = (input as { generation?: unknown }).generation;
  return typeof generation === 'number' && Number.isInteger(generation) && generation >= 1
    ? { ok: true, value: { runnerId: owner.value, generation } }
    : fail(422, 'generation must be a positive integer', 'INVALID_GENERATION');
}

export async function heartbeatJob(env: Env, repo: RepoRow, id: string, input: unknown): Promise<ServiceResult<ClaimedJob>> {
  const p = parseFence(input);
  if (!p.ok) return p;
  const now = Date.now();
  const [renewed, current] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ci_jobs SET lease_until = ?6
       WHERE id = ?1 AND repo_id = ?2 AND generation = ?3 AND claimed_by = ?4 AND status = 'running' AND lease_until > ?5
       RETURNING id, name, command, head_sha, tree_sha, generation, claimed_by, lease_until, timeout_seconds, required, status`,
    ).bind(id, repo.id, p.value.generation, p.value.runnerId, now, now + CI_LEASE_SECONDS * 1000),
    env.DB.prepare('SELECT generation, claimed_by, status FROM ci_jobs WHERE id = ? AND repo_id = ?').bind(id, repo.id),
  ]);
  const row = (renewed?.results as JobRow[] | undefined)?.[0];
  if (row) return { ok: true, value: jobView(row) };
  const exists = (current?.results?.length ?? 0) > 0;
  return fail(exists ? 409 : 404, exists ? 'the CI job claim is stale' : 'CI job not found', exists ? 'STALE_GENERATION' : 'CI_JOB_NOT_FOUND');
}

/** A quarantined check is neutral in a composition's recorded checks, as in the gate. */
const QUARANTINED_X = quarantinedSql('x.repo_id', 'x.name', '?3');

interface ReportBody extends FenceInput {
  conclusion: 'success' | 'failure';
  summary: string;
}

function parseReport(input: unknown): ServiceResult<ReportBody> {
  const fence = parseFence(input);
  if (!fence.ok) return fence;
  const b = input as Record<string, unknown>;
  if (b.conclusion !== 'success' && b.conclusion !== 'failure') return fail(422, 'conclusion must be success or failure', 'INVALID_CONCLUSION');
  const summary = JSON.stringify(b.summary ?? null);
  if (new TextEncoder().encode(summary).length > CI_LIMITS.summaryBytes) return fail(422, `summary must be at most ${CI_LIMITS.summaryBytes} bytes`, 'SUMMARY_TOO_LARGE');
  return { ok: true, value: { ...fence.value, conclusion: b.conclusion, summary } };
}

export interface ReportedJob extends RetryOutcome {
  run: CheckRunView;
  change: { number: number; policy: string; baseRef: string; queued: boolean } | null;
  treeSha: string;
}

/**
 * Terminal update + check run + readback, atomically fenced by generation
 * and owner. A required attempt-1 failure schedules its one retry and an
 * attempt-2 pass records a flake in the same batch (services/flakes.ts).
 */
export async function reportJob(env: Env, repo: RepoRow, id: string, input: unknown): Promise<ServiceResult<ReportedJob>> {
  const p = parseReport(input);
  if (!p.ok) return p;
  const now = Date.now();
  const retry = retryStatements(env.DB, { jobId: id, repoId: repo.id, generation: p.value.generation, runnerId: p.value.runnerId, now });
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ci_jobs SET status = ?5, summary = ?6, finished_at = ?7, lease_until = NULL
       WHERE id = ?1 AND repo_id = ?2 AND generation = ?3 AND claimed_by = ?4 AND status = 'running' AND lease_until > ?7
       RETURNING tree_sha, check_run_id`,
    ).bind(id, repo.id, p.value.generation, p.value.runnerId, p.value.conclusion, p.value.summary, now),
    env.DB.prepare(
      `UPDATE check_runs SET status = ?5, conclusion = ?5, summary = ?6, finished_at = ?7
       WHERE id = (SELECT check_run_id FROM ci_jobs
                    WHERE id = ?1 AND repo_id = ?2 AND generation = ?3 AND claimed_by = ?4 AND status = ?5 AND finished_at = ?7)
       RETURNING ${CHECK_RUN_COLUMNS.replaceAll('k.', '')}`,
    ).bind(id, repo.id, p.value.generation, p.value.runnerId, p.value.conclusion, p.value.summary, now),
    env.DB.prepare(
      `SELECT c.number, c.merge_policy, c.base_ref,
              EXISTS (SELECT 1 FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1) AS queued
         FROM change_sets c WHERE c.id = (SELECT change_set_id FROM ci_jobs WHERE id = ?1 AND repo_id = ?2)`,
    ).bind(id, repo.id),
    ...retry,
    env.DB.prepare(
      `UPDATE compositions
          SET checks = json_object(
                'treeSha', tree_sha,
                'configId', NULL,
                'required', (
                  SELECT json_group_array(json_object(
                    'name', x.name,
                    'state', CASE x.status WHEN 'failure' THEN 'failure' WHEN 'success' THEN 'success' WHEN 'skipped' THEN 'success' ELSE 'pending' END,
                    'producer', 'check-runs',
                    'runId', x.id
                  ))
                  FROM check_runs x
                  WHERE x.repo_id = ?2 AND x.tree_sha = compositions.tree_sha AND x.required = 1 AND x.quarantined = 0 AND NOT ${QUARANTINED_X}
                    AND NOT EXISTS (
                      SELECT 1 FROM check_runs newer
                       WHERE newer.repo_id = x.repo_id AND newer.tree_sha = x.tree_sha AND newer.name = x.name
                         AND (newer.created_at > x.created_at OR (newer.created_at = x.created_at AND newer.id > x.id))
                    )
                ),
                'state', CASE
                  WHEN EXISTS (
                    SELECT 1 FROM check_runs x
                     WHERE x.repo_id = ?2 AND x.tree_sha = compositions.tree_sha AND x.required = 1 AND x.quarantined = 0 AND NOT ${QUARANTINED_X} AND x.status = 'failure'
                       AND NOT EXISTS (SELECT 1 FROM check_runs newer
                         WHERE newer.repo_id = x.repo_id AND newer.tree_sha = x.tree_sha AND newer.name = x.name
                           AND (newer.created_at > x.created_at OR (newer.created_at = x.created_at AND newer.id > x.id)))
                  )
                    THEN 'failure'
                  WHEN EXISTS (
                    SELECT 1 FROM check_runs x
                     WHERE x.repo_id = ?2 AND x.tree_sha = compositions.tree_sha AND x.required = 1 AND x.quarantined = 0 AND NOT ${QUARANTINED_X} AND x.status IN ('queued','running')
                       AND NOT EXISTS (SELECT 1 FROM check_runs newer
                         WHERE newer.repo_id = x.repo_id AND newer.tree_sha = x.tree_sha AND newer.name = x.name
                           AND (newer.created_at > x.created_at OR (newer.created_at = x.created_at AND newer.id > x.id)))
                  )
                    THEN 'pending'
                  ELSE 'success'
                END
              ),
              conflict_kind = CASE
                WHEN EXISTS (
                  SELECT 1 FROM check_runs x
                   WHERE x.repo_id = ?2 AND x.tree_sha = compositions.tree_sha AND x.required = 1 AND x.quarantined = 0 AND NOT ${QUARANTINED_X} AND x.status = 'failure'
                     AND NOT EXISTS (SELECT 1 FROM check_runs newer
                       WHERE newer.repo_id = x.repo_id AND newer.tree_sha = x.tree_sha AND newer.name = x.name
                         AND (newer.created_at > x.created_at OR (newer.created_at = x.created_at AND newer.id > x.id)))
                )
                  THEN 'semantic'
                ELSE NULL
              END
        WHERE repo_id = ?2 AND tree_sha = (SELECT tree_sha FROM ci_jobs WHERE id = ?1 AND repo_id = ?2)`,
    ).bind(id, repo.id, now),
  ]);
  const [job, runRead, changeRead] = results;
  // retryStatements reads back last; it follows the three statements above.
  const retryRead = results[3 + retry.length - 1];
  const moved = (job?.results as Array<{ tree_sha: string; check_run_id: string }> | undefined)?.[0];
  const run = (runRead?.results as CheckRunRow[] | undefined)?.[0];
  if (!moved || !run) {
    const exists = await env.DB.prepare('SELECT 1 FROM ci_jobs WHERE id = ? AND repo_id = ?').bind(id, repo.id).first();
    return fail(exists ? 409 : 404, exists ? 'the CI job claim is stale' : 'CI job not found', exists ? 'STALE_GENERATION' : 'CI_JOB_NOT_FOUND');
  }
  const c = (changeRead?.results as Array<{ number: number; merge_policy: string; base_ref: string; queued: number }> | undefined)?.[0];
  return {
    ok: true,
    value: {
      run: checkRunView(run),
      treeSha: moved.tree_sha,
      change: c ? { number: c.number, policy: c.merge_policy, baseRef: c.base_ref, queued: c.queued === 1 } : null,
      ...retryOutcome((retryRead?.results as Array<{ retry_run_id: string | null; flake_id: string | null }> | undefined)?.[0]),
    },
  };
}

export function ciCleanupStatement(db: D1Database, repoId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM ci_jobs WHERE repo_id = ?').bind(repoId);
}
