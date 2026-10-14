/**
 * What the commit and change pages show about a commit's provenance
 * (architecture §9 provenance, §11.6): the attribution Kvarm recorded for it
 * with its evidence level, and the decisions linked to the changes it heads
 * or merged.
 *
 * - The attribution comes from the evidence ledger (`attribution_evidence`),
 *   the row Kvarm stored when it wrote the note, newest first, exactly as the
 *   audit export reads it. The page therefore needs no Artifacts read, and a
 *   note pushed to the notes ref around Kvarm (no ledger row) shows nothing
 *   here; `GET commits/:sha/attribution` stays the authoritative reader.
 * - Redaction follows #45: the submitting principal id and the credential's
 *   token prefix are shown to repository admins only (evidenceForReader).
 * - Decisions are those whose task links them to a change (`change:<number>`)
 *   that published this commit (a merge or train publication in the audit's
 *   `ref_updates`, found through `idx_ref_updates_commit`), or the named change.
 * - One D1 batch of two bounded indexed reads.
 */

import type { RepoRow } from '../db/repos';
import { evidenceForReader, evidenceFromRow } from './attribution';
import { changeDecisionTask, decisionView, type DecisionRow, type DecisionView } from './decisions';
import type { Evidence } from './provenance';

export const PROVENANCE_PANEL_LIMITS = {
  /** Decisions shown; more are reported as truncated (get_context pages the rest). */
  decisions: 5,
  /** Changes a commit links decisions through (the changes that published it). */
  changes: 5,
};

export interface PanelAttribution {
  agent: string;
  session: string;
  promptHash: string | null;
  model: string | null;
  actor: string;
  /** ISO 8601 UTC: the record's own time. */
  at: string;
  evidence: Evidence;
}

export interface ProvenancePanel {
  attribution: PanelAttribution | null;
  decisions: DecisionView[];
  decisionsTruncated: boolean;
}

interface LedgerRow {
  agent: string;
  session: string;
  prompt_hash: string | null;
  model: string | null;
  actor: string;
  at: number;
  level: Evidence['level'];
  reasons: string;
  principal: string | null;
  token_kind: Evidence['tokenKind'];
  token_prefix: string | null;
  run_id: string | null;
  key_id: string | null;
}

/** True when the panel has nothing to show: the page renders no panel at all. */
export function panelEmpty(p: ProvenancePanel): boolean {
  return p.attribution === null && p.decisions.length === 0;
}

/**
 * The provenance of `sha` in `repo`, as a reader at `admin` may see it.
 * `change` adds that change's own decisions (the change page passes its
 * number); without it only the changes that published `sha` link decisions.
 */
export async function commitProvenance(
  env: Env,
  repo: RepoRow,
  sha: string | null,
  opts: { admin: boolean; change?: number },
): Promise<ProvenancePanel> {
  const db = env.DB;
  const changeTask = opts.change !== undefined ? changeDecisionTask(opts.change) : null;
  const [ledger, decisions] = await db.batch([
    db
      .prepare(
        `SELECT agent, session, prompt_hash, model, actor, at, level, reasons, principal, token_kind, token_prefix, run_id, key_id
           FROM attribution_evidence WHERE repo_id = ?1 AND commit_sha = ?2 ORDER BY recorded_at DESC LIMIT 1`,
      )
      .bind(repo.id, sha ?? ''),
    db
      .prepare(
        `SELECT d.id, d.task_id, d.paths, d.chosen_candidate, d.rejected_candidates, d.reason, d.actor, d.agent_id, d.agent_name, d.at
           FROM agent_decisions d
          WHERE d.repo_id = ?1
            AND d.task_id IN (SELECT t FROM (SELECT DISTINCT 'change:' || u.change_number AS t FROM ref_updates u
                                              WHERE u.repo_id = ?1 AND u.new_sha = ?2 AND u.change_number IS NOT NULL
                                              LIMIT ${PROVENANCE_PANEL_LIMITS.changes})
                              UNION ALL SELECT ?3 WHERE ?3 IS NOT NULL)
          ORDER BY d.at DESC, d.id DESC LIMIT ${PROVENANCE_PANEL_LIMITS.decisions + 1}`,
      )
      .bind(repo.id, sha ?? '', changeTask),
  ]);
  const row = (ledger?.results as LedgerRow[] | undefined)?.[0];
  const rows = (decisions?.results as DecisionRow[] | undefined) ?? [];
  return {
    attribution: row
      ? {
          agent: row.agent,
          session: row.session,
          promptHash: row.prompt_hash,
          model: row.model,
          actor: row.actor,
          at: new Date(row.at).toISOString(),
          evidence: evidenceForReader(evidenceFromRow(row), opts.admin),
        }
      : null,
    decisions: rows.slice(0, PROVENANCE_PANEL_LIMITS.decisions).map(decisionView),
    decisionsTruncated: rows.length > PROVENANCE_PANEL_LIMITS.decisions,
  };
}
