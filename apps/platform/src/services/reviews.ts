/**
 * Reviews, the per-repo review policy and human escalations (architecture
 * §0.4 agent review policy, §9). The gate itself is services/reviewGate.ts.
 *
 * - Any principal with write access may review: a human (PAT/session) or an
 *   agent (scoped agent token). The change author never reviews its own
 *   change (409 SELF_REVIEW). A review names the exact head it reviews; a
 *   second review by the same principal of the same head replaces the first.
 * - Each review records the reviewer's model family: the agent principal's
 *   `modelFamily`, or the `human` sentinel. The packet and the assignment
 *   mark for every reviewer whether its family differs from the author's.
 * - A request-changes review opens an escalation (`review-blocked`, or
 *   `reviewer-disagreement` when another principal approved the same head);
 *   an approval next to a request-changes opens `reviewer-disagreement`.
 *   An approval by a human other than the author closes every open
 *   escalation of the change, and a human may resolve one explicitly. Agents
 *   never close escalations.
 * - A change whose mergePolicy is auto is merged right away when a review or
 *   resolution leaves nothing unmet.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { modelFamilyEvidence, type EvidenceLevel } from './provenance';
import { BRANCH_RULE_COLUMNS, effectivePolicy, ruleFromRow, type BranchRule, type BranchRuleRow } from './branchRules';
import { autoMerge, branchRef, fail, guarded, parseNumber, readChange, type ChangeContext } from './changes';
import {
  HUMAN_MODEL_FAMILY,
  parseReviewFacts,
  recordMissingEscalation,
  reviewFactExpressions,
  reviewFactsColumns,
  reviewGate,
  type EscalationReason,
  type ReviewBlocker,
  type ReviewFactsRow,
} from './reviewGate';

export { HUMAN_MODEL_FAMILY };
export const REVIEW_VERDICTS = ['approve', 'request-changes'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_LIMITS = {
  requiredMax: 10,
  bodyMax: 65_536,
  noteMax: 4_000,
  /** Reviews returned in a packet (newest first). */
  reviewsMax: 100,
  /** Escalations returned in a packet (open first, then newest). */
  escalationsMax: 50,
  /** Agents considered by one assignment. */
  candidatesMax: 50,
  pendingDefault: 50,
  pendingMax: 100,
};

const SHA_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

interface Principal {
  id: string;
  kind: 'user' | 'agent';
  userId: string;
  login: string;
  agentId: string | null;
  agentName: string | null;
  tokenId: string | null;
}

function actorPrincipal(actor: Actor): Principal {
  const a = actor.agent;
  return a
    ? { id: `agent:${a.agentId}`, kind: 'agent', userId: actor.user.id, login: actor.user.login, agentId: a.agentId, agentName: a.agentName, tokenId: a.tokenId }
    : { id: `user:${actor.user.id}`, kind: 'user', userId: actor.user.id, login: actor.user.login, agentId: null, agentName: null, tokenId: null };
}

function parseAgentMeta(meta: string | null): { id: string; name: string } | null {
  if (!meta) return null;
  try {
    const v = JSON.parse(meta) as { agentId?: unknown; agentName?: unknown };
    return typeof v.agentId === 'string' && typeof v.agentName === 'string' ? { id: v.agentId, name: v.agentName } : null;
  } catch {
    return null;
  }
}

function differentFamily(reviewer: string | null, author: string | null): boolean {
  return reviewer !== null && author !== null && reviewer !== author;
}

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

interface PacketChangeRow extends ReviewFactsRow {
  id: string;
  number: number;
  state: string;
  merge_policy: string;
  base_ref: string;
  head_sha: string | null;
  author_id: string | null;
  author_login: string | null;
  agent_meta: string | null;
  author_family: string | null;
}

interface ReviewRow {
  id: string;
  head_sha: string;
  principal: string;
  user_id: string;
  user_login: string;
  agent_id: string | null;
  agent_name: string | null;
  model_family: string | null;
  verdict: ReviewVerdict;
  body: string | null;
  created_at: number;
  updated_at: number;
}

interface EscalationRow {
  id: string;
  change_number: number;
  reason: EscalationReason;
  state: 'open' | 'resolved';
  head_sha: string | null;
  detail: string | null;
  opened_by: string | null;
  opened_at: number;
  resolved_by_login: string | null;
  resolution: string | null;
  note: string | null;
  resolved_at: number | null;
}

export interface AuthorView {
  principal: string | null;
  kind: 'user' | 'agent';
  login: string | null;
  agent: { id: string; name: string } | null;
  modelFamily: string | null;
  /** Agent families are self-declared at principal creation (services/provenance.ts). */
  modelFamilyEvidence: EvidenceLevel | null;
}

export interface ReviewView {
  id: string;
  principal: string;
  reviewer: { kind: 'user' | 'agent'; login: string; agent: { id: string; name: string } | null };
  modelFamily: string | null;
  modelFamilyEvidence: EvidenceLevel | null;
  /** The reviewer's model family is known and differs from the author's. */
  differentFamily: boolean;
  /** How well `differentFamily` is established: the weaker of the two families' evidence. */
  differentFamilyEvidence: EvidenceLevel | null;
  verdict: ReviewVerdict;
  headSha: string;
  /** Reviews of an older head are stale and never count. */
  current: boolean;
  body: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EscalationView {
  id: string;
  number: number;
  reason: EscalationReason;
  state: 'open' | 'resolved';
  headSha: string | null;
  detail: string | null;
  openedBy: string | null;
  openedAt: string;
  resolvedBy: string | null;
  resolution: string | null;
  note: string | null;
  resolvedAt: string | null;
}

export interface ReviewPacket {
  number: number;
  state: string;
  mergePolicy: string;
  base: string;
  headSha: string | null;
  author: AuthorView;
  policy: { requiredReviews: number; humanApprovalsRequired: number; protected: boolean; branchRules: string[] };
  approvals: { count: number; required: number; humans: number; humansRequired: number };
  /** Nothing in the review gate blocks publication of the current head. */
  satisfied: boolean;
  blockers: ReviewBlocker[];
  reviews: ReviewView[];
  escalations: EscalationView[];
}

const iso = (ms: number) => new Date(ms).toISOString();

function authorView(row: PacketChangeRow): AuthorView {
  const agent = parseAgentMeta(row.agent_meta);
  if (agent) {
    return { principal: `agent:${agent.id}`, kind: 'agent', login: row.author_login, agent, modelFamily: row.author_family, modelFamilyEvidence: modelFamilyEvidence(row.author_family, false) };
  }
  return {
    principal: row.author_id ? `user:${row.author_id}` : null,
    kind: 'user',
    login: row.author_login,
    agent: null,
    modelFamily: HUMAN_MODEL_FAMILY,
    modelFamilyEvidence: modelFamilyEvidence(HUMAN_MODEL_FAMILY, true),
  };
}

const LEVEL_RANK: Record<EvidenceLevel, number> = { declared: 0, authenticated: 1, verified: 2 };

/** The weaker of two evidence levels; null when either side has no family. */
function weaker(a: EvidenceLevel | null, b: EvidenceLevel | null): EvidenceLevel | null {
  if (a === null || b === null) return null;
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

function reviewView(r: ReviewRow, headSha: string | null, author: Pick<AuthorView, 'modelFamily' | 'modelFamilyEvidence'>): ReviewView {
  const evidence = modelFamilyEvidence(r.model_family, r.agent_id === null);
  return {
    id: r.id,
    principal: r.principal,
    reviewer: { kind: r.agent_id ? 'agent' : 'user', login: r.user_login, agent: r.agent_id ? { id: r.agent_id, name: r.agent_name ?? '' } : null },
    modelFamily: r.model_family,
    modelFamilyEvidence: evidence,
    differentFamily: differentFamily(r.model_family, author.modelFamily),
    differentFamilyEvidence: weaker(evidence, author.modelFamilyEvidence),
    verdict: r.verdict,
    headSha: r.head_sha,
    current: r.head_sha === headSha,
    body: r.body,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function escalationView(e: EscalationRow): EscalationView {
  return {
    id: e.id,
    number: e.change_number,
    reason: e.reason,
    state: e.state,
    headSha: e.head_sha,
    detail: e.detail,
    openedBy: e.opened_by,
    openedAt: iso(e.opened_at),
    resolvedBy: e.resolved_by_login,
    resolution: e.resolution,
    note: e.note,
    resolvedAt: e.resolved_at === null ? null : iso(e.resolved_at),
  };
}

// ---------------------------------------------------------------------------
// Packet
// ---------------------------------------------------------------------------

const CHANGE_ID = '(SELECT id FROM change_sets WHERE repo_id = ?1 AND number = ?2)';

/** Change + facts, reviews, escalations and branch rules: one batch for any packet. */
function packetStatements(db: D1Database, repoId: string, number: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `SELECT c.id, c.number, c.state, c.merge_policy, c.base_ref, c.head_sha, c.author_id, u.login AS author_login, c.agent_meta,
                (SELECT a.model_family FROM agents a WHERE a.id = json_extract(c.agent_meta, '$.agentId')) AS author_family,
                ${reviewFactsColumns('c')}
           FROM change_sets c LEFT JOIN users u ON u.id = c.author_id
          WHERE c.repo_id = ?1 AND c.number = ?2`,
      )
      .bind(repoId, number),
    db
      .prepare(
        `SELECT r.id, r.head_sha, r.principal, r.user_id, r.user_login, r.agent_id, r.agent_name, r.model_family, r.verdict, r.body,
                r.created_at, r.updated_at
           FROM change_reviews r WHERE r.change_set_id = ${CHANGE_ID}
          ORDER BY r.updated_at DESC, r.id LIMIT ${REVIEW_LIMITS.reviewsMax}`,
      )
      .bind(repoId, number),
    db
      .prepare(
        `SELECT e.id, e.change_number, e.reason, e.state, e.head_sha, e.detail, e.opened_by, e.opened_at, e.resolved_by_login, e.resolution,
                e.note, e.resolved_at
           FROM change_escalations e WHERE e.change_set_id = ${CHANGE_ID}
          ORDER BY e.state = 'open' DESC, e.opened_at DESC, e.id LIMIT ${REVIEW_LIMITS.escalationsMax}`,
      )
      .bind(repoId, number),
    db
      .prepare(
        `SELECT ${BRANCH_RULE_COLUMNS}
           FROM branch_rules b WHERE b.repo_id = ?1 LIMIT 50`,
      )
      .bind(repoId),
  ];
}

interface PacketRead {
  change: PacketChangeRow;
  reviews: ReviewRow[];
  escalations: EscalationRow[];
  rules: BranchRule[];
}

function packetRead(results: D1Result[], offset: number): PacketRead | null {
  const change = (results[offset]?.results as PacketChangeRow[] | undefined)?.[0];
  if (!change) return null;
  return {
    change,
    reviews: (results[offset + 1]?.results as ReviewRow[] | undefined) ?? [],
    escalations: (results[offset + 2]?.results as EscalationRow[] | undefined) ?? [],
    rules: ((results[offset + 3]?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow),
  };
}

function buildPacket(p: PacketRead): ReviewPacket {
  const c = p.change;
  const author = authorView(c);
  const policy = effectivePolicy(p.rules, branchRef(c.base_ref));
  const facts = parseReviewFacts(c);
  const gate = reviewGate(facts, policy);
  return {
    number: c.number,
    state: c.state,
    mergePolicy: c.merge_policy,
    base: c.base_ref,
    headSha: c.head_sha,
    author,
    policy: { requiredReviews: facts.required, humanApprovalsRequired: policy.requiredApprovals, protected: policy.protected, branchRules: policy.rules },
    approvals: { count: facts.approvals, required: facts.required, humans: facts.humans, humansRequired: policy.requiredApprovals },
    satisfied: gate.block === null,
    blockers: gate.blockers,
    reviews: p.reviews.map((r) => reviewView(r, c.head_sha, author)),
    escalations: p.escalations.map(escalationView),
  };
}

/** Records escalations a live change must have but never got (protected target, final selection), then rereads. */
async function withRecordedEscalations(env: Env, repoId: string, p: PacketRead): Promise<PacketRead> {
  const c = p.change;
  if (c.state !== 'open' && c.state !== 'conflicted') return p;
  const gate = reviewGate(parseReviewFacts(c), effectivePolicy(p.rules, branchRef(c.base_ref)));
  if (gate.missing.length === 0) return p;
  const now = Date.now();
  const results = await env.DB.batch([
    ...gate.missing.map((reason) => recordMissingEscalation(env.DB, c.id, reason, now)),
    ...packetStatements(env.DB, repoId, c.number),
  ]);
  return packetRead(results, gate.missing.length) ?? p;
}

/** GET changes/:number/reviews — the review packet. */
export function getReviewPacket(env: Env, repo: RepoRow, rawNumber: string): Promise<ServiceResult<ReviewPacket>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const read = packetRead(await env.DB.batch(packetStatements(env.DB, repo.id, number)), 0);
    if (!read) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    return { ok: true, value: buildPacket(await withRecordedEscalations(env, repo.id, read)) };
  });
}

// ---------------------------------------------------------------------------
// Review policy
// ---------------------------------------------------------------------------

export interface ReviewPolicyView {
  requiredReviews: number;
  /** False while the repo has never set a policy (no review requirement). */
  configured: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface PolicyRow {
  required_reviews: number;
  updated_by_login: string | null;
  updated_at: number;
}

const POLICY_SELECT = `SELECT p.required_reviews, u.login AS updated_by_login, p.updated_at
  FROM review_policies p LEFT JOIN users u ON u.id = p.updated_by WHERE p.repo_id = ?1`;

function policyView(row: PolicyRow | null | undefined): ReviewPolicyView {
  if (!row) return { requiredReviews: 0, configured: false, updatedBy: null, updatedAt: null };
  return { requiredReviews: Number(row.required_reviews) || 0, configured: true, updatedBy: row.updated_by_login, updatedAt: iso(row.updated_at) };
}

/** GET review-policy */
export async function getReviewPolicy(env: Env, repo: RepoRow): Promise<ServiceResult<ReviewPolicyView>> {
  return { ok: true, value: policyView(await env.DB.prepare(POLICY_SELECT).bind(repo.id).first<PolicyRow>()) };
}

/** PUT review-policy {requiredReviews} (repo admins). One batch: upsert, audit row, read-back. */
export async function setReviewPolicy(env: Env, repo: RepoRow, actor: Actor, input: unknown): Promise<ServiceResult<ReviewPolicyView>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object {requiredReviews}', 'INVALID_BODY');
  const n = (input as Record<string, unknown>).requiredReviews;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > REVIEW_LIMITS.requiredMax) {
    return fail(400, `requiredReviews must be an integer from 0 to ${REVIEW_LIMITS.requiredMax}`, 'INVALID_REQUIRED_REVIEWS');
  }
  const now = Date.now();
  const [, , read] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO review_policies (repo_id, required_reviews, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (repo_id) DO UPDATE SET required_reviews = excluded.required_reviews, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(repo.id, n, actor.user.id, now),
    env.DB.prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       VALUES (?1, 'review_policy.updated', json_object('repoId', ?2, 'repo', ?3, 'requiredReviews', ?4, 'actor', ?5), ?6, ?6)`,
    ).bind(crypto.randomUUID(), repo.id, `${repo.owner_login}/${repo.name}`, n, actor.user.login, now),
    env.DB.prepare(POLICY_SELECT).bind(repo.id),
  ]);
  return { ok: true, value: policyView((read?.results as PolicyRow[] | undefined)?.[0]) };
}

// ---------------------------------------------------------------------------
// Submitting a review
// ---------------------------------------------------------------------------

interface ReviewInput {
  verdict: ReviewVerdict;
  headSha: string | null;
  body: string | null;
}

function parseReview(input: unknown, verdict: ReviewVerdict | null): ServiceResult<ReviewInput> {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    return fail(400, 'body must be a JSON object {verdict, headSha?, body?}', 'INVALID_BODY');
  }
  const b = (input ?? {}) as Record<string, unknown>;
  const v = verdict ?? b.verdict;
  if (typeof v !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(v)) {
    return fail(422, `verdict must be one of ${REVIEW_VERDICTS.join(', ')}`, 'INVALID_VERDICT');
  }
  let headSha: string | null = null;
  if (b.headSha !== undefined && b.headSha !== null) {
    if (typeof b.headSha !== 'string' || !SHA_RE.test(b.headSha)) return fail(422, 'headSha must be a full 40-character commit SHA', 'INVALID_HEAD_SHA');
    headSha = b.headSha;
  }
  let body: string | null = null;
  if (b.body !== undefined && b.body !== null) {
    if (typeof b.body !== 'string' || b.body.length > REVIEW_LIMITS.bodyMax) {
      return fail(422, `body must be a string of at most ${REVIEW_LIMITS.bodyMax} characters`, 'INVALID_BODY');
    }
    body = b.body;
  }
  return { ok: true, value: { verdict: v as ReviewVerdict, headSha, body } };
}

interface ReviewTargetRow {
  id: string;
  number: number;
  state: string;
  head_sha: string | null;
  author_id: string | null;
  agent_meta: string | null;
  merge_policy: string;
  reviewer_family: string | null;
}

export interface ReviewOutcome {
  created: boolean;
  review: ReviewView;
  packet: ReviewPacket;
}

/**
 * POST changes/:number/reviews {verdict, headSha?, body?} (also .../approve
 * and .../request-changes). Two D1 round trips after authority: the change
 * read, then one batch that upserts the review guarded by the head, opens or
 * closes escalations and reads the packet back.
 */
export function submitReview(cx: ChangeContext, rawNumber: string, input: unknown, verdict: ReviewVerdict | null = null): Promise<ServiceResult<ReviewOutcome>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (!cx.actor) return fail(401, 'unauthorized', 'UNAUTHORIZED');
    const parsed = parseReview(input, verdict);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const me = actorPrincipal(cx.actor);
    const db = cx.env.DB;
    const target = await db
      .prepare(
        `SELECT c.id, c.number, c.state, c.head_sha, c.author_id, c.agent_meta, c.merge_policy,
                (SELECT a.model_family FROM agents a WHERE a.id = ?3) AS reviewer_family
           FROM change_sets c WHERE c.repo_id = ?1 AND c.number = ?2`,
      )
      .bind(cx.repo.id, number, me.agentId)
      .first<ReviewTargetRow>();
    if (!target) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (target.state !== 'open' && target.state !== 'conflicted') return fail(409, `a ${target.state} change cannot be reviewed`, 'CHANGE_NOT_OPEN');
    if (!target.head_sha) return fail(409, 'the change has no head commit', 'NO_HEAD');
    if (p.headSha !== null && p.headSha !== target.head_sha) {
      return { ...fail(409, `the change's head is ${target.head_sha}, not the reviewed ${p.headSha}; review the new head`, 'HEAD_MOVED'), headSha: target.head_sha } as ServiceResult<never>;
    }
    const authorAgent = parseAgentMeta(target.agent_meta);
    const authorPrincipal = authorAgent ? `agent:${authorAgent.id}` : target.author_id ? `user:${target.author_id}` : null;
    if (authorPrincipal === me.id) {
      return fail(409, 'self-review: the author of a change cannot review it; another principal must review', 'SELF_REVIEW');
    }
    const headSha = target.head_sha;
    const family = me.kind === 'agent' ? target.reviewer_family : HUMAN_MODEL_FAMILY;
    // A human other than the author answers for every open escalation by approving the current head.
    const humanResolves = p.verdict === 'approve' && me.kind === 'user' && me.userId !== target.author_id;
    const now = Date.now();
    const landed = `EXISTS (SELECT 1 FROM change_reviews WHERE change_set_id = ?2 AND head_sha = ?3 AND principal = ?4 AND updated_at = ?5)`;
    const otherVerdict = (v: ReviewVerdict) =>
      `EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_set_id = c.id AND r.head_sha = c.head_sha AND r.verdict = '${v}' AND r.principal != ?4)`;
    const escalation = (reasonSql: string, condition: string) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO change_escalations (id, repo_id, change_set_id, change_number, reason, state, head_sha, detail, opened_by, opened_at)
           SELECT ?1, c.repo_id, c.id, c.number, ${reasonSql}, 'open', c.head_sha, ?6, ?4, ?5
             FROM change_sets c WHERE c.id = ?2 AND c.head_sha = ?3 AND ${landed} AND ${condition}`,
        )
        .bind(crypto.randomUUID(), target.id, headSha, me.id, now, `${p.verdict} by ${me.agentName ?? me.login}`);
    const effects: D1PreparedStatement[] = [];
    if (p.verdict === 'request-changes') {
      effects.push(escalation(`CASE WHEN ${otherVerdict('approve')} THEN 'reviewer-disagreement' ELSE 'review-blocked' END`, '1'));
    } else if (humanResolves) {
      effects.push(
        db
          .prepare(
            `UPDATE change_escalations SET state = 'resolved', resolution = 'approve', resolved_by = ?6, resolved_by_login = ?7, resolved_at = ?5
              WHERE change_set_id = ?2 AND state = 'open' AND ${landed}`,
          )
          .bind(null, target.id, headSha, me.id, now, me.userId, me.login),
      );
    } else {
      effects.push(escalation(`'reviewer-disagreement'`, otherVerdict('request-changes')));
    }
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO change_reviews (id, repo_id, change_set_id, head_sha, principal, user_id, user_login, agent_id, agent_name, token_id,
                                       model_family, verdict, body, created_at, updated_at)
           SELECT ?1, c.repo_id, c.id, c.head_sha, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13
             FROM change_sets c WHERE c.id = ?2 AND c.head_sha = ?3 AND c.state IN ('open', 'conflicted')
           ON CONFLICT (change_set_id, head_sha, principal) DO UPDATE SET
             verdict = excluded.verdict, body = excluded.body, model_family = excluded.model_family, token_id = excluded.token_id,
             user_login = excluded.user_login, agent_name = excluded.agent_name, updated_at = excluded.updated_at`,
        )
        .bind(crypto.randomUUID(), target.id, headSha, me.id, me.userId, me.login, me.agentId, me.agentName, me.tokenId, family, p.verdict, p.body, now),
      ...effects,
      ...packetStatements(db, cx.repo.id, number),
    ]);
    const read = packetRead(results, 1 + effects.length);
    const mine = read?.reviews.find((r) => r.principal === me.id && r.head_sha === headSha && r.updated_at === now);
    if (!read || !mine) {
      return fail(409, "the change's head moved or the change closed while the review was recorded; review the current head", 'HEAD_MOVED');
    }
    let packet = buildPacket(await withRecordedEscalations(cx.env, cx.repo.id, read));
    packet = await proceedPerPolicy(cx, number, packet);
    return { ok: true, value: { created: mine.created_at === now, review: reviewView(mine, headSha, packet.author), packet } };
  });
}

/** An `auto` change merges as soon as a review or resolution leaves its gate satisfied. */
async function proceedPerPolicy(cx: ChangeContext, number: number, packet: ReviewPacket): Promise<ReviewPacket> {
  if (packet.mergePolicy !== 'auto' || packet.state !== 'open' || !packet.satisfied) return packet;
  const row = await readChange(cx.env, cx.repo.id, number);
  if (!row) return packet;
  // Like a push-triggered auto merge, the merge is the policy's own, not the reviewer's.
  const merged = await autoMerge({ ...cx, actor: null }, row);
  return merged?.state === 'merged' ? { ...packet, state: 'merged' } : packet;
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export interface ResolveOutcome {
  escalation: EscalationView;
  packet: ReviewPacket;
}

/**
 * POST changes/:number/escalations/:id/resolve {resolution?, note?} — a human
 * closes one open escalation (`acknowledge` or `resolve`). One batch after
 * authority: the guarded update, the escalation read-back and the packet.
 */
export function resolveEscalation(cx: ChangeContext, rawNumber: string, id: string, input: unknown): Promise<ServiceResult<ResolveOutcome>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (!cx.actor || cx.actor.agent) return fail(403, 'only a human principal resolves an escalation', 'HUMAN_REQUIRED');
    if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
      return fail(400, 'body must be a JSON object {resolution?, note?}', 'INVALID_BODY');
    }
    const b = (input ?? {}) as Record<string, unknown>;
    const resolution = b.resolution ?? 'resolve';
    if (resolution !== 'acknowledge' && resolution !== 'resolve') return fail(422, 'resolution must be acknowledge or resolve', 'INVALID_RESOLUTION');
    let note: string | null = null;
    if (b.note !== undefined && b.note !== null) {
      if (typeof b.note !== 'string' || b.note.length > REVIEW_LIMITS.noteMax) return fail(422, `note must be a string of at most ${REVIEW_LIMITS.noteMax} characters`, 'INVALID_NOTE');
      note = b.note;
    }
    const db = cx.env.DB;
    const now = Date.now();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE change_escalations SET state = 'resolved', resolution = ?4, note = ?5, resolved_by = ?6, resolved_by_login = ?7, resolved_at = ?8
            WHERE id = ?3 AND repo_id = ?1 AND change_set_id = ${CHANGE_ID} AND state = 'open'`,
        )
        .bind(cx.repo.id, number, id, resolution, note, cx.actor.user.id, cx.actor.user.login, now),
      db
        .prepare(
          `SELECT e.id, e.change_number, e.reason, e.state, e.head_sha, e.detail, e.opened_by, e.opened_at, e.resolved_by_login, e.resolution,
                  e.note, e.resolved_at
             FROM change_escalations e WHERE e.id = ?3 AND e.repo_id = ?1 AND e.change_set_id = ${CHANGE_ID}`,
        )
        .bind(cx.repo.id, number, id),
      ...packetStatements(db, cx.repo.id, number),
    ]);
    const esc = (results[1]?.results as EscalationRow[] | undefined)?.[0];
    const read = packetRead(results, 2);
    if (!read) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (!esc) return fail(404, 'escalation not found', 'ESCALATION_NOT_FOUND');
    if (!results[0]?.meta.changes) return fail(409, `the escalation is already ${esc.state}`, 'ESCALATION_RESOLVED');
    const packet = await proceedPerPolicy(cx, number, buildPacket(read));
    return { ok: true, value: { escalation: escalationView(esc), packet } };
  });
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string;
  name: string;
  owner_login: string;
  model_family: string | null;
  reviewed: number;
}

export interface ReviewerCandidate {
  principal: string;
  agent: { id: string; name: string; owner: string };
  modelFamily: string | null;
  modelFamilyEvidence: EvidenceLevel | null;
  differentFamily: boolean;
  differentFamilyEvidence: EvidenceLevel | null;
  eligible: boolean;
  ineligibleReason?: 'author' | 'already-reviewed';
}

export interface Assignment {
  number: number;
  headSha: string | null;
  author: AuthorView;
  /** `evidence`: how well the met preference is established (agent families are declared). */
  preference: { rule: 'different-model-family'; authorModelFamily: string | null; met: boolean; evidence: EvidenceLevel | null };
  assigned: ReviewerCandidate | null;
  candidates: ReviewerCandidate[];
}

/**
 * POST changes/:number/reviewers/assign {candidates?: [agentId]} — picks a
 * reviewer among the agents holding a live write token for the repo (or the
 * given ones): eligible agents (not the author, not yet reviewed the current
 * head) of a different model family than the author are preferred. The
 * preference is advisory; any eligible reviewer's review counts.
 */
export function assignReviewer(cx: ChangeContext, rawNumber: string, input: unknown): Promise<ServiceResult<Assignment>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
      return fail(400, 'body must be a JSON object {candidates?}', 'INVALID_BODY');
    }
    const raw = ((input ?? {}) as Record<string, unknown>).candidates;
    let only: string[] | null = null;
    if (raw !== undefined && raw !== null) {
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > REVIEW_LIMITS.candidatesMax || !raw.every((v) => typeof v === 'string' && v.length <= 64)) {
        return fail(422, `candidates must be a list of 1-${REVIEW_LIMITS.candidatesMax} agent ids`, 'INVALID_CANDIDATES');
      }
      only = [...new Set(raw as string[])];
    }
    const db = cx.env.DB;
    const now = Date.now();
    const [changeRes, candRes] = await db.batch([
      packetStatements(db, cx.repo.id, number)[0]!,
      db
        .prepare(
          `SELECT a.id, a.name, a.owner_login, a.model_family,
                  EXISTS (SELECT 1 FROM change_reviews r JOIN change_sets c ON c.id = r.change_set_id AND r.head_sha = c.head_sha
                           WHERE c.repo_id = ?1 AND c.number = ?2 AND r.principal = 'agent:' || a.id) AS reviewed
             FROM agents a
            WHERE a.revoked_at IS NULL
              AND a.id IN (SELECT t.agent_id FROM agent_tokens t
                            WHERE t.repo_id = ?1 AND t.role = 'write' AND t.revoked_at IS NULL AND t.expires_at > ?3)
              AND (?4 IS NULL OR a.id IN (SELECT value FROM json_each(?4)))
            ORDER BY a.name, a.id LIMIT ${REVIEW_LIMITS.candidatesMax}`,
        )
        .bind(cx.repo.id, number, now, only ? JSON.stringify(only) : null),
    ]);
    const change = (changeRes?.results as PacketChangeRow[] | undefined)?.[0];
    if (!change) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const author = authorView(change);
    const candidates: ReviewerCandidate[] = ((candRes?.results as CandidateRow[] | undefined) ?? []).map((a) => {
      const principal = `agent:${a.id}`;
      const ineligible = principal === author.principal ? 'author' : a.reviewed ? 'already-reviewed' : null;
      return {
        principal,
        agent: { id: a.id, name: a.name, owner: a.owner_login },
        modelFamily: a.model_family,
        modelFamilyEvidence: modelFamilyEvidence(a.model_family, false),
        differentFamily: differentFamily(a.model_family, author.modelFamily),
        differentFamilyEvidence: weaker(modelFamilyEvidence(a.model_family, false), author.modelFamilyEvidence),
        eligible: ineligible === null,
        ...(ineligible ? { ineligibleReason: ineligible } : {}),
      };
    });
    const eligible = candidates.filter((c) => c.eligible);
    const assigned = eligible.find((c) => c.differentFamily) ?? eligible[0] ?? null;
    return {
      ok: true,
      value: {
        number: change.number,
        headSha: change.head_sha,
        author,
        preference: {
          rule: 'different-model-family',
          authorModelFamily: author.modelFamily,
          met: assigned?.differentFamily ?? false,
          evidence: assigned?.differentFamily ? assigned.differentFamilyEvidence : null,
        },
        assigned,
        candidates,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Pending reviews
// ---------------------------------------------------------------------------

export interface PendingReview {
  number: number;
  title: string;
  base: string;
  headSha: string | null;
  mergePolicy: string;
  approvals: { count: number; required: number };
  openEscalations: EscalationReason[];
}

interface PendingRow extends ReviewFactsRow {
  number: number;
  title: string;
  base_ref: string;
  head_sha: string | null;
  merge_policy: string;
}

/**
 * GET reviews/pending?limit=&cursor= — live non-draft changes still short of
 * the required reviews or with an open escalation, newest first. One query.
 */
export async function pendingReviews(env: Env, repo: RepoRow, q: { limit?: string; cursor?: string }): Promise<ServiceResult<{ changes: PendingReview[]; nextCursor: string | null }>> {
  let limit = REVIEW_LIMITS.pendingDefault;
  if (q.limit !== undefined) {
    if (!/^\d+$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > REVIEW_LIMITS.pendingMax) {
      return fail(400, `limit must be an integer from 1 to ${REVIEW_LIMITS.pendingMax}`, 'INVALID_LIMIT');
    }
    limit = Number(q.limit);
  }
  let before = Number.MAX_SAFE_INTEGER;
  if (q.cursor !== undefined) {
    const n = parseNumber(q.cursor);
    if (n === null) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    before = n;
  }
  const { results } = await env.DB.prepare(
    `SELECT c.number, c.title, c.base_ref, c.head_sha, c.merge_policy, ${reviewFactsColumns('c')}
       FROM change_sets c
      WHERE c.repo_id = ?1 AND c.number < ?2 AND ${pendingCondition('c')}
      ORDER BY c.number DESC LIMIT ?3`,
  )
    .bind(repo.id, before, limit + 1)
    .all<PendingRow>();
  const rows = results ?? [];
  const page = rows.slice(0, limit);
  return {
    ok: true,
    value: {
      changes: page.map((r) => {
        const facts = parseReviewFacts(r);
        return {
          number: r.number,
          title: r.title,
          base: r.base_ref,
          headSha: r.head_sha,
          mergePolicy: r.merge_policy,
          approvals: { count: facts.approvals, required: facts.required },
          openEscalations: facts.open,
        };
      }),
      nextCursor: rows.length > limit ? String(page[page.length - 1]!.number) : null,
    },
  };
}


/** A live, non-draft change still short of its required reviews or holding an open escalation. */
function pendingCondition(c: string): string {
  const f = reviewFactExpressions(c);
  return `${c}.state IN ('open', 'conflicted') AND ${c}.merge_policy != 'draft' AND (${f.openCount} > 0 OR ${f.approvals} < ${f.required})`;
}

// ---------------------------------------------------------------------------
// Pending reviews across repositories (the review inbox, services/reviewInbox.ts)
// ---------------------------------------------------------------------------

export const PENDING_ACROSS_LIMITS = {
  /** Reviews shown per change (newest first); the packet has the rest. */
  reviewsPerChange: 8,
  /** Open escalations shown per change. */
  escalationsPerChange: 8,
};

export interface PendingChange {
  repoId: string;
  number: number;
  title: string;
  state: string;
  mergePolicy: string;
  base: string;
  headSha: string | null;
  author: AuthorView;
  approvals: { count: number; required: number; humans: number };
  openEscalations: EscalationView[];
  /** Newest first: current and stale reviews alike; `current: false` marks a review of an older head. */
  reviews: ReviewView[];
  /** Approvals of an older head: a push staled them and they no longer count. */
  staleApprovals: number;
  createdAt: string;
  /** Sort key for the inbox cursor. */
  createdAtMs: number;
  id: string;
}

interface PendingAcrossRow extends PacketChangeRow {
  repo_id: string;
  title: string;
  created_at: number;
}

/**
 * Pending changes over the given repositories, newest first, `(created_at, id)`
 * keyset-paged. Callers authorize the repository ids first; nothing here
 * checks access. Two D1 round trips: the page, then one batch with each
 * listed change's newest reviews and open escalations (window-bounded per change).
 */
export async function pendingAcross(
  env: Env,
  repoIds: readonly string[],
  page: { limit: number; after: { at: number; id: string } | null },
): Promise<{ changes: PendingChange[]; more: boolean }> {
  if (repoIds.length === 0) return { changes: [], more: false };
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT c.id, c.repo_id, c.number, c.title, c.state, c.merge_policy, c.base_ref, c.head_sha, c.author_id, u.login AS author_login,
              c.agent_meta, c.created_at,
              (SELECT a.model_family FROM agents a WHERE a.id = json_extract(c.agent_meta, '$.agentId')) AS author_family,
              ${reviewFactsColumns('c')}
         FROM change_sets c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.repo_id IN (SELECT value FROM json_each(?1)) AND ${pendingCondition('c')}
          AND (?2 IS NULL OR (c.created_at, c.id) < (?2, ?3))
        ORDER BY c.created_at DESC, c.id DESC LIMIT ?4`,
    )
    .bind(JSON.stringify(repoIds), page.after?.at ?? null, page.after?.id ?? null, page.limit + 1)
    .all<PendingAcrossRow>();
  const rows = (results ?? []).slice(0, page.limit);
  const more = (results ?? []).length > page.limit;
  if (rows.length === 0) return { changes: [], more };
  const ids = JSON.stringify(rows.map((r) => r.id));
  const [reviewRes, escalationRes] = await db.batch([
    db
      .prepare(
        `SELECT * FROM (
           SELECT r.id, r.change_set_id, r.head_sha, r.principal, r.user_id, r.user_login, r.agent_id, r.agent_name, r.model_family, r.verdict,
                  r.body, r.created_at, r.updated_at,
                  ROW_NUMBER() OVER (PARTITION BY r.change_set_id ORDER BY r.updated_at DESC, r.id) AS k
             FROM change_reviews r WHERE r.change_set_id IN (SELECT value FROM json_each(?1)))
          WHERE k <= ${PENDING_ACROSS_LIMITS.reviewsPerChange}`,
      )
      .bind(ids),
    db
      .prepare(
        `SELECT * FROM (
           SELECT e.id, e.change_set_id, e.change_number, e.reason, e.state, e.head_sha, e.detail, e.opened_by, e.opened_at,
                  e.resolved_by_login, e.resolution, e.note, e.resolved_at,
                  ROW_NUMBER() OVER (PARTITION BY e.change_set_id ORDER BY e.opened_at DESC, e.id) AS k
             FROM change_escalations e WHERE e.change_set_id IN (SELECT value FROM json_each(?1)) AND e.state = 'open')
          WHERE k <= ${PENDING_ACROSS_LIMITS.escalationsPerChange}`,
      )
      .bind(ids),
  ]);
  const reviewsOf = new Map<string, Array<ReviewRow & { change_set_id: string }>>();
  for (const r of (reviewRes?.results as Array<ReviewRow & { change_set_id: string }> | undefined) ?? []) {
    reviewsOf.set(r.change_set_id, [...(reviewsOf.get(r.change_set_id) ?? []), r]);
  }
  const escalationsOf = new Map<string, EscalationRow[]>();
  for (const e of (escalationRes?.results as Array<EscalationRow & { change_set_id: string }> | undefined) ?? []) {
    escalationsOf.set(e.change_set_id, [...(escalationsOf.get(e.change_set_id) ?? []), e]);
  }
  const changes = rows.map((row): PendingChange => {
    const author = authorView(row);
    const facts = parseReviewFacts(row);
    const reviews = (reviewsOf.get(row.id) ?? [])
      .sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? -1 : 1))
      .map((r) => reviewView(r, row.head_sha, author));
    return {
      id: row.id,
      repoId: row.repo_id,
      number: row.number,
      title: row.title,
      state: row.state,
      mergePolicy: row.merge_policy,
      base: row.base_ref,
      headSha: row.head_sha,
      author,
      approvals: { count: facts.approvals, required: facts.required, humans: facts.humans },
      openEscalations: (escalationsOf.get(row.id) ?? []).sort((a, b) => b.opened_at - a.opened_at).map(escalationView),
      reviews,
      staleApprovals: reviews.filter((r) => r.verdict === 'approve' && !r.current).length,
      createdAt: iso(row.created_at),
      createdAtMs: row.created_at,
    };
  });
  return { changes, more };
}
