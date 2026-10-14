import { requestEnvironmentBuild } from '../environments';
import { sandboxProvider } from './provider';

const BATCH_SIZE = 50;

/** What one stage did: rows it picked up, and how many of them the service refused. */
export interface StageResult {
  count: number;
  failed: number;
}

export interface SweepStage {
  name: string;
  run: (env: Env) => Promise<StageResult>;
}

/** A stage's outcome as logged; `error` is set only when the stage itself threw. */
export interface StageOutcome extends StageResult {
  stage: string;
  ok: boolean;
  error?: string;
}

/** The Worker's 6-hour cron trigger: run the sweeps and log the per-stage outcome (runFleetSweeps never throws). */
export async function runFleetCron(env: Env): Promise<void> {
  const stages = await runFleetSweeps(env);
  const summary = Object.fromEntries(
    stages.map((s) => [s.stage, s.ok ? { count: s.count, failed: s.failed } : { error: s.error }]),
  );
  const ok = stages.every((s) => s.ok && s.failed === 0);
  // An error-level line is what a Worker log alert watches; a clean run stays at info.
  const line = JSON.stringify({ cron: 'fleet', ok, stages: summary });
  if (ok) console.log(line);
  else console.error(line);
}

/**
 * Runs every stage in order. Each has its own try/catch so one failing query
 * cannot leave expired sandboxes running until the next 6-hour tick (#55).
 * `stages` is a seam for tests; production always uses FLEET_SWEEP_STAGES.
 */
export async function runFleetSweeps(env: Env, stages: SweepStage[] = FLEET_SWEEP_STAGES): Promise<StageOutcome[]> {
  const outcomes: StageOutcome[] = [];
  for (const stage of stages) {
    try {
      outcomes.push({ stage: stage.name, ok: true, ...(await stage.run(env)) });
    } catch (err) {
      const error = String(err).slice(0, 200);
      console.warn(JSON.stringify({ fleetSweep: stage.name, error }));
      outcomes.push({ stage: stage.name, ok: false, count: 0, failed: 0, error });
    }
  }
  return outcomes;
}

/**
 * Applies `act` to each row on its own, so one row's throw or refusal counts
 * as failed and logged, and the rest of the batch still runs.
 */
async function eachRow(
  stage: string,
  idKey: 'environmentId' | 'sandboxId',
  rows: { id: string }[],
  act: (id: string) => Promise<string | null>,
): Promise<StageResult> {
  let failed = 0;
  for (const row of rows) {
    const error = await act(row.id).catch((err: unknown) => String(err).slice(0, 200) || 'threw');
    if (error !== null) {
      failed++;
      console.warn(JSON.stringify({ fleetSweep: stage, [idKey]: row.id, error }));
    }
  }
  return { count: rows.length, failed };
}

async function rebuildStage(env: Env, rows: { id: string }[], reason: 'age' | 'retry'): Promise<StageResult> {
  return eachRow(reason, 'environmentId', rows, async (id) => {
    const requested = await requestEnvironmentBuild(env, id, reason);
    return !requested.ok && requested.code !== 'BUILD_NOT_QUEUED' ? requested.error : null;
  });
}

/** A failure-shaped provider result is a refusal and counts as failed; a missing provider fails the stage. */
async function sandboxStage(env: Env, stage: 'discard' | 'sleep', rows: { id: string }[]): Promise<StageResult> {
  // Resolved once: with no provider the stage fails as a whole instead of warning per row.
  const provider = rows.length ? sandboxProvider('linux') : null;
  if (rows.length && !provider) throw new Error('no linux sandbox provider');
  return eachRow(stage, 'sandboxId', rows, async (id) => {
    const result: unknown = await provider!.agentSandbox(env, id)[stage]();
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
      return (result as { error?: string }).error || 'refused';
    }
    return null;
  });
}

export const FLEET_SWEEP_STAGES: SweepStage[] = [
  {
    name: 'age',
    async run(env) {
      const aged = await env.DB.prepare(
        `SELECT e.id FROM environments e JOIN environment_builds b ON b.id = e.ready_build_id
          WHERE e.archived_at IS NULL AND b.status = 'ready'
            AND b.created_at < ?1 - e.max_build_age_hours * 3600000
          ORDER BY b.created_at LIMIT ?2`,
      )
        .bind(Date.now(), BATCH_SIZE)
        .all<{ id: string }>();
      return rebuildStage(env, aged.results ?? [], 'age');
    },
  },
  {
    name: 'retry',
    async run(env) {
      const retry = await env.DB.prepare(
        `SELECT e.id FROM environments e
          JOIN environment_builds b ON b.environment_id = e.id
          WHERE e.archived_at IS NULL AND b.status = 'failed'
            AND b.seq = (SELECT MAX(latest.seq) FROM environment_builds latest WHERE latest.environment_id = e.id)
            AND b.finished_at <= ?1 - CASE WHEN b.attempt >= 5 THEN 24 ELSE (1 << MIN(b.attempt, 4)) END * 3600000
          ORDER BY b.finished_at LIMIT ?2`,
      )
        .bind(Date.now(), BATCH_SIZE)
        .all<{ id: string }>();
      return rebuildStage(env, retry.results ?? [], 'retry');
    },
  },
  {
    name: 'discard',
    async run(env) {
      const expired = await env.DB.prepare(
        `SELECT id FROM sandboxes WHERE status IN ('starting','running','sleeping') AND expires_at <= ?1
          ORDER BY expires_at LIMIT ?2`,
      )
        .bind(Date.now(), BATCH_SIZE)
        .all<{ id: string }>();
      return sandboxStage(env, 'discard', expired.results ?? []);
    },
  },
  {
    name: 'sleep',
    async run(env) {
      const endedRuns = await env.DB.prepare(
        `SELECT id FROM sandboxes WHERE status = 'running' AND run_expires_at <= ?1
          ORDER BY run_expires_at LIMIT ?2`,
      )
        .bind(Date.now(), BATCH_SIZE)
        .all<{ id: string }>();
      return sandboxStage(env, 'sleep', endedRuns.results ?? []);
    },
  },
];
