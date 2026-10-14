/**
 * The human review inbox (architecture §0.4, §11.6): pending escalations and
 * approvals across every repository the viewer may review, and the page-side
 * decide flow that answers them.
 *
 * - Authority is the shared policy, never a second copy of it: one query
 *   reads the candidate repositories (ones the viewer owns, administers
 *   through an org, holds a write grant on, or every one for the instance
 *   admin, each with a live change) together with the viewer's membership
 *   and grant facts, and each row is decided by `authorizeRepo` with the
 *   `write` need on the page transport, exactly as a repository page would.
 * - Reads are bounded (§10): at most `reposMax` repositories, `limit` changes
 *   per page with a `(created_at, id)` cursor, and a fixed number of reviews
 *   and escalations per change. A capped repository scan reports `truncated`.
 * - Deciding goes through the same service functions as REST and MCP
 *   (`submitReview`, `resolveEscalation`) and then records a decision linked
 *   to the change (`recordDecision`, task `change:<number>`), with the
 *   required note as its reason.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { splitFacts, type RepoFactsRow } from './access';
import { authorizeRepo, type Actor } from './authz';
import type { ChangeContext } from './changes';
import { changeDecisionTask, recordDecision, type DecisionView } from './decisions';
import type { EscalationReason } from './reviewGate';
import { getReviewPacket, inboxCondition, pendingAcross, REVIEW_LIMITS, resolveEscalation, submitReview, type PendingChange, type ReviewVerdict } from './reviews';

export const INBOX_LIMITS = {
  /** Repositories considered for one inbox read. */
  reposMax: 100,
  changesDefault: 25,
  changesMax: 50,
  /** Candidate pages one inbox read scans to fill a page (candidates the gate does not block are skipped). */
  scanRounds: 4,
  /** The note every page decision requires (the review body and the decision's reason). */
  noteMax: REVIEW_LIMITS.noteMax,
};

/** Group order: what blocks hardest first; a change sits in the group of its first reason. */
export const INBOX_REASONS = ['reviewer-disagreement', 'review-blocked', 'protected-path', 'final-selection', 'approvals-required'] as const;
export type InboxReason = (typeof INBOX_REASONS)[number];

export interface InboxItem extends PendingChange {
  repo: { owner: string; name: string };
  /** Every reason the change is waiting, in group order; the first one places it. */
  reasons: InboxReason[];
}

export interface InboxGroup {
  reason: InboxReason;
  items: InboxItem[];
}

export interface ReviewInbox {
  groups: InboxGroup[];
  /** Totals over this page. */
  counts: { changes: number; escalations: number; awaitingApproval: number; staleApprovals: number };
  repositories: number;
  truncated: boolean;
  truncatedReason: 'repositories' | null;
  nextCursor: string | null;
}

type Fail = Extract<ServiceResult<never>, { ok: false }>;
const fail = (status: number, code: string, error: string): Fail => ({ ok: false, status, code, error });

function encodeCursor(c: { at: number; id: string }): string {
  return btoa(JSON.stringify([c.at, c.id])).replace(/=+$/, '');
}

function decodeCursor(raw: string): { at: number; id: string } | null {
  try {
    const v: unknown = JSON.parse(atob(raw));
    if (Array.isArray(v) && v.length === 2 && Number.isSafeInteger(v[0]) && typeof v[1] === 'string' && v[1].length <= 64) {
      return { at: v[0] as number, id: v[1] };
    }
  } catch {
    // not one of ours
  }
  return null;
}

/** The reasons a pending change waits for a human, in group order. */
export function inboxReasons(c: Pick<PendingChange, 'openEscalations' | 'missingEscalations' | 'approvals'>): InboxReason[] {
  const open = new Set<EscalationReason>([...c.openEscalations.map((e) => e.reason), ...c.missingEscalations]);
  const out: InboxReason[] = INBOX_REASONS.filter((r): r is EscalationReason => r !== 'approvals-required' && open.has(r as EscalationReason));
  if (awaitingApproval(c)) out.push('approvals-required');
  // A pending change always waits for something; an escalation beyond the per-change cap still places it.
  return out.length > 0 ? out : ['approvals-required'];
}

/** Short of the policy's approving reviews or of the protected target's human approvals. */
export function awaitingApproval(c: Pick<PendingChange, 'approvals'>): boolean {
  return c.approvals.count < c.approvals.required || c.approvals.humans < c.approvals.humansRequired;
}

/** Items grouped by their first reason, groups in INBOX_REASONS order, empty groups dropped. */
export function groupInbox(items: InboxItem[]): InboxGroup[] {
  return INBOX_REASONS.map((reason) => ({ reason, items: items.filter((i) => i.reasons[0] === reason) })).filter((g) => g.items.length > 0);
}

/**
 * Repositories the actor may review that hold a change waiting for a human
 * (the inbox candidate condition), newest push first. The candidate filter only narrows the read; `authorizeRepo` decides.
 */
async function reviewableRepos(env: Env, actor: Actor): Promise<{ repos: RepoRow[]; truncated: boolean }> {
  const { results } = await env.DB.prepare(
    `SELECT r.*, ?1 AS facts_user_id,
            (SELECT m.role FROM org_members m WHERE m.org_id = r.owner_org_id AND m.user_id = ?1) AS facts_org_role,
            (SELECT g.role FROM repo_grants g WHERE g.repo_id = r.id AND g.user_id = ?1) AS facts_grant
       FROM repos r
      WHERE (?3 = 1
             OR (r.owner_org_id IS NULL AND r.owner_login = ?2)
             OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = r.owner_org_id AND m.user_id = ?1 AND m.role IN ('owner', 'maintainer'))
             OR EXISTS (SELECT 1 FROM repo_grants g WHERE g.repo_id = r.id AND g.user_id = ?1 AND g.role IN ('write', 'admin')))
        AND EXISTS (SELECT 1 FROM change_sets c WHERE c.repo_id = r.id AND ${inboxCondition('c')})
      ORDER BY COALESCE(r.pushed_at, r.created_at) DESC, r.id
      LIMIT ?4`,
  )
    .bind(actor.user.id, actor.user.login, actor.user.is_admin === true ? 1 : 0, INBOX_LIMITS.reposMax + 1)
    .all<RepoFactsRow>();
  const rows = results ?? [];
  const repos: RepoRow[] = [];
  for (const row of rows.slice(0, INBOX_LIMITS.reposMax)) {
    const { repo, facts } = splitFacts(row);
    if (!repo) continue;
    const d = await authorizeRepo(env, repo, actor, 'write', 'page', facts);
    if (d.ok) repos.push(d.repo);
  }
  return { repos, truncated: rows.length > INBOX_LIMITS.reposMax };
}

/** GET /inbox: one page of pending changes across the repositories the actor may review. */
export async function reviewInbox(env: Env, actor: Actor, q: { limit?: string; cursor?: string }): Promise<ServiceResult<ReviewInbox>> {
  let limit = INBOX_LIMITS.changesDefault;
  if (q.limit !== undefined && q.limit !== '') {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > INBOX_LIMITS.changesMax) {
      return fail(400, 'INVALID_LIMIT', `limit must be an integer from 1 to ${INBOX_LIMITS.changesMax}`);
    }
    limit = n;
  }
  let after: { at: number; id: string } | null = null;
  if (q.cursor) {
    after = decodeCursor(q.cursor);
    if (!after) return fail(400, 'INVALID_CURSOR', 'cursor is not a nextCursor from this page');
  }
  const { repos, truncated } = await reviewableRepos(env, actor);
  const byId = new Map(repos.map((r) => [r.id, r]));
  const repoIds = [...byId.keys()];
  const changes: PendingChange[] = [];
  let cursor = after;
  let more = false;
  for (let round = 0; round < INBOX_LIMITS.scanRounds && changes.length < limit; round++) {
    const page = await pendingAcross(env, repoIds, { limit: limit - changes.length, after: cursor });
    changes.push(...page.changes);
    more = page.more;
    cursor = page.last ?? cursor;
    if (!page.more) break;
  }
  const items: InboxItem[] = changes.map((c) => {
    const repo = byId.get(c.repoId)!;
    return { ...c, repo: { owner: repo.owner_login, name: repo.name }, reasons: inboxReasons(c) };
  });
  return {
    ok: true,
    value: {
      groups: groupInbox(items),
      counts: {
        changes: items.length,
        escalations: items.reduce((n, i) => n + i.openEscalations.length + i.missingEscalations.length, 0),
        awaitingApproval: items.filter(awaitingApproval).length,
        staleApprovals: items.reduce((n, i) => n + i.staleApprovals, 0),
      },
      repositories: repos.length,
      truncated,
      truncatedReason: truncated ? 'repositories' : null,
      nextCursor: more && cursor ? encodeCursor(cursor) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Deciding from a page
// ---------------------------------------------------------------------------

export type PageDecision =
  | { kind: 'review'; verdict: ReviewVerdict; headSha: string | null }
  | { kind: 'resolve'; escalationId: string; resolution: 'resolve' | 'acknowledge' };

export interface PageDecisionOutcome {
  /** Null when the review or resolution landed but storing the decision row failed. */
  decision: DecisionView | null;
  /** The change's state after the decision (an auto change may have merged). */
  state: string;
}

/** The note a page decision requires: the review body or resolution note, and the decision's reason. */
export function parseDecisionNote(v: unknown): ServiceResult<string> {
  if (typeof v !== 'string' || v.trim().length === 0) return fail(422, 'NOTE_REQUIRED', 'a note is required: say why, for the record');
  // Browsers submit textarea line breaks as CRLF, which maxlength does not count twice.
  const note = v.replace(/\r\n/g, '\n').trim();
  if (note.length > INBOX_LIMITS.noteMax) return fail(422, 'INVALID_NOTE', `the note is at most ${INBOX_LIMITS.noteMax} characters`);
  return { ok: true, value: note };
}

/**
 * Approve, request changes or resolve an escalation, then record the decision.
 * The review or resolution is the authoritative write; the decision row is
 * written only after it succeeded.
 */
export async function decideFromPage(cx: ChangeContext, rawNumber: string, d: PageDecision, rawNote: unknown): Promise<ServiceResult<PageDecisionOutcome>> {
  const note = parseDecisionNote(rawNote);
  if (!note.ok) return note;
  let chosen: string;
  let state: string;
  let number: number;
  if (d.kind === 'review') {
    // Record any escalation the gate requires but nobody opened yet, so a human approval answers it now
    // instead of the approval's own packet read opening it right afterwards.
    if (d.verdict === 'approve') {
      const packet = await getReviewPacket(cx.env, cx.repo, rawNumber);
      if (!packet.ok) return packet;
    }
    const r = await submitReview(cx, rawNumber, { headSha: d.headSha, body: note.value }, d.verdict);
    if (!r.ok) return r;
    chosen = `${d.verdict}@${r.value.review.headSha}`;
    state = r.value.packet.state;
    number = r.value.packet.number;
  } else {
    const r = await resolveEscalation(cx, rawNumber, d.escalationId, { resolution: d.resolution, note: note.value });
    if (!r.ok) return r;
    chosen = `${d.resolution}:${r.value.escalation.reason}`;
    state = r.value.packet.state;
    number = r.value.packet.number;
  }
  // The review already landed and cannot be retried (a resolved escalation answers 409), so a failed
  // decision write is reported to the caller rather than turned into an error for an action that happened.
  let decision: DecisionView | null = null;
  try {
    const r = await recordDecision(
      { env: cx.env, repo: cx.repo, actor: cx.actor },
      { task: changeDecisionTask(number), paths: [], chosen, rejected: [], reason: note.value },
    );
    decision = r.ok ? r.value : null;
  } catch (err) {
    console.log(JSON.stringify({ inbox: 'decision-not-recorded', repo: cx.repo.id, change: number, error: String(err).slice(0, 200) }));
  }
  return { ok: true, value: { decision, state } };
}
