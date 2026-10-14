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
  run: (env: Env, now: number) => Promise<StageResult>;
}

/** A stage's outcome as logged; `error` is set only when the stage itself threw. */
export interface StageOutcome extends StageResult {
  stage: string;
  ok: boolean;
  error?: string;
}

/** The Worker's 6-hour cron trigger: run the sweeps and log the per-stage outcome (a failure is logged, never thrown). */
export async function runFleetCron(env: Env): Promise<void> {
  try {
    const stages = await runFleetSweeps(env);
    const summary = Object.fromEntries(
      stages.map((s) => [s.stage, s.ok ? { count: s.count, failed: s.failed } : { error: s.error }]),
    );
    console.log(JSON.stringify({ cron: 'fleet', ok: stages.every((s) => s.ok), stages: summary }));
  } catch (err) {
    console.log(JSON.stringify({ cron: 'fleet', error: String(err).slice(0, 200) }));
  }
}

/**
 * Runs every stage in order. Each has its own try/catch so one failing query
 * cannot leave expired sandboxes running until the next 6-hour tick (#55).
 * `stages` is a seam for tests; production always uses FLEET_SWEEP_STAGES.
 */
export async function runFleetSweeps(env: Env, stages: SweepStage[] = FLEET_SWEEP_STAGES): Promise<StageOutcome[]> {
  const now = Date.now();
  const outcomes: StageOutcome[] = [];
  for (const stage of stages) {
    try {
      outcomes.push({ stage: stage.name, ok: true, ...(await stage.run(env, now)) });
    } catch (err) {
      const error = String(err).slice(0, 200);
      console.warn(JSON.stringify({ fleetSweep: stage.name, error }));
      outcomes.push({ stage: stage.name, ok: false, count: 0, failed: 0, error });
    }
  }
  return outcomes;
}

async function rebuildStage(env: Env, rows: { id: string }[], reason: 'age' | 'retry'): Promise<StageResult> {
  let failed = 0;
  for (const row of rows) {
    const requested = await requestEnvironmentBuild(env, row.id, reason);
    if (!requested.ok && requested.code !== 'BUILD_NOT_QUEUED') {
      failed++;
      console.warn(JSON.stringify({ fleetSweep: reason, environmentId: row.id, error: requested.error }));
    }
  }
  return { count: rows.length, failed };
}

/** Failure-shaped provider results are logged, not thrown, so the rest of the batch still runs. */
function refused(result: unknown): string | null {
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    return (result as { error?: string }).error ?? 'refused';
  }
  return null;
}

export const FLEET_SWEEP_STAGES: SweepStage[] = [
  {
    name: 'age',
    async run(env, now) {
      const aged = await env.DB.prepare(
        `SELECT e.id FROM environments e JOIN environment_builds b ON b.id = e.ready_build_id
          WHERE e.archived_at IS NULL AND b.status = 'ready'
            AND b.created_at < ?1 - e.max_build_age_hours * 3600000
          ORDER BY b.created_at LIMIT ?2`,
      )
        .bind(now, BATCH_SIZE)
        .all<{ id: string }>();
      return rebuildStage(env, aged.results ?? [], 'age');
    },
  },
  {
    name: 'retry',
    async run(env, now) {
      const retry = await env.DB.prepare(
        `SELECT e.id, b.attempt, b.finished_at FROM environments e
          JOIN environment_builds b ON b.environment_id = e.id
          WHERE e.archived_at IS NULL AND b.status = 'failed'
            AND b.seq = (SELECT MAX(latest.seq) FROM environment_builds latest WHERE latest.environment_id = e.id)
            AND b.finished_at <= ?1 - CASE WHEN b.attempt >= 5 THEN 24 ELSE (1 << MIN(b.attempt, 4)) END * 3600000
          ORDER BY b.finished_at LIMIT ?2`,
      )
        .bind(now, BATCH_SIZE)
        .all<{ id: string; attempt: number }>();
      return rebuildStage(env, retry.results ?? [], 'retry');
    },
  },
  {
    name: 'discard',
    async run(env, now) {
      const expired = await env.DB.prepare(
        `SELECT * FROM sandboxes WHERE status IN ('starting','running','sleeping') AND expires_at <= ?1
          ORDER BY expires_at LIMIT ?2`,
      )
        .bind(now, BATCH_SIZE)
        .all<{ id: string; status: string; token_id: string | null }>();
      let failed = 0;
      for (const row of expired.results ?? []) {
        const error = refused(await sandboxProvider('linux')?.agentSandbox(env, row.id).discard());
        if (error) {
          failed++;
          console.warn(JSON.stringify({ fleetSweep: 'discard', sandboxId: row.id, error }));
        }
      }
      return { count: expired.results?.length ?? 0, failed };
    },
  },
  {
    name: 'sleep',
    async run(env, now) {
      const endedRuns = await env.DB.prepare(
        `SELECT id FROM sandboxes WHERE status = 'running' AND run_expires_at <= ?1
          ORDER BY run_expires_at LIMIT ?2`,
      )
        .bind(now, BATCH_SIZE)
        .all<{ id: string }>();
      let failed = 0;
      for (const row of endedRuns.results ?? []) {
        const error = refused(await sandboxProvider('linux')?.agentSandbox(env, row.id).sleep());
        if (error) {
          failed++;
          console.warn(JSON.stringify({ fleetSweep: 'sleep', sandboxId: row.id, error }));
        }
      }
      return { count: endedRuns.results?.length ?? 0, failed };
    },
  },
];
