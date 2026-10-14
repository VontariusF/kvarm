/**
 * Credential + repository resolution in front of the shared policy in
 * services/authz.ts. Every transport (git gate, REST, pages, and later
 * compare, snapshots and MCP) must authorize repo responses through
 * resolveRepoAccess, before any cached body is read or upstream work starts.
 *
 * Every repo decision, public or private, read or write, is made on one
 * authoritative D1 batch (architecture §10, §11.1): the credential, the
 * repo's current row (visibility included) and the caller's org membership
 * and repo grant. Repo rows, memberships and grants are never cached, so a
 * visibility flip, revocation or removal applies to the next request in every
 * colo, not only where a cache entry was purged. Immutable payload caches
 * (pages, info/refs, content keyed by SHA) stay valid because they are only
 * consulted after this decision.
 *
 * The Cache API copy of a PAT never authorizes on its own. It only names
 * whose facts to read, throttles last_used_at stamps, and short-circuits
 * cached rejections; uncached PAT lookups pass a per-IP preauth throttle
 * first, so unknown tokens cannot amplify into D1 reads.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  PAT_PATTERN,
  patFromRow,
  patHash,
  patNeedsStamp,
  patSelect,
  patStamp,
  readPatCache,
  scopesAllow,
  writePatCache,
  type PATInfo,
  type PatRow,
} from '../auth/pat';
import { agentFromRow, agentTokenSelect, agentTokenStamp, isAgentToken, type AgentTokenRow } from '../auth/agentTokens';
import { PAT_STAMP_INTERVAL_MS } from '../auth/pat';
import type { RepoRow } from '../db/repos';
import { branchRulesSelect, ruleFromRow, type BranchRule, type BranchRuleRow } from './branchRules';
import { preauthAllowed } from '../ratelimit';
import {
  authorizeRepo,
  isOrgRole,
  isRepoNeed,
  NO_FACTS,
  patActor,
  type AccessFacts,
  type Actor,
  type AuthzDenyCode,
  type RepoNeed,
  type RepoRole,
  type Transport,
} from './authz';

export type Credential =
  | { kind: 'anonymous' }
  | { kind: 'pat'; token: string }
  | { kind: 'session'; actor: Actor };

export type AccessDenyCode = AuthzDenyCode | 'RATE_LIMITED' | 'AGENT_FORBIDDEN';

export type TokenKind = 'pat' | 'agent';

/** Well-formed tokens only; anything else is rejected without touching D1. */
export function tokenKind(token: string): TokenKind | null {
  if (PAT_PATTERN.test(token)) return 'pat';
  if (isAgentToken(token)) return 'agent';
  return null;
}

export const AGENT_FORBIDDEN: AccessDenied = {
  ok: false,
  status: 403,
  error: 'agent credentials cannot perform this action',
  code: 'AGENT_FORBIDDEN',
};

export interface AccessDenied {
  ok: false;
  status: 401 | 403 | 404 | 429;
  error: string;
  code: AccessDenyCode;
  /** The presented credential itself was rejected (unknown, revoked or expired). */
  badCredential?: true;
}

export type PrincipalResult = { ok: true; pat: PATInfo } | AccessDenied;

export type RepoAccess =
  | {
      ok: true;
      repo: RepoRow;
      actor: Actor | null;
      role: RepoRole;
      /** The repo's branch rules, present only when requested (read in the authoritative batch). */
      branchRules?: BranchRule[];
    }
  | AccessDenied;

export interface RepoAccessRequest {
  owner: string;
  name: string;
  need: RepoNeed;
  transport: Transport;
  credential: Credential;
  clientIp: string | null;
  /** The route needs an authenticated actor even for reads (e.g. forking). */
  requireActor?: boolean;
  /**
   * With requireActor, also accept agent tokens. Off by default: routes that
   * act on an account (forks, grants, settings) are human-only.
   */
  allowAgent?: boolean;
  /** Also read the repo's branch rules in the authoritative batch (git pushes; `write`/`admin` only). */
  branchRules?: boolean;
  /**
   * Decide as an anonymous caller when the presented token is malformed,
   * unknown, revoked or expired, instead of rejecting it with a 401. The
   * decision reuses the repo row already read in the authoritative batch, so
   * it costs no second lookup. Throttled checks are never downgraded.
   */
  rejectedCredentialAsAnonymous?: boolean;
}

const BAD_CREDENTIAL: AccessDenied = {
  ok: false,
  status: 401,
  error: 'unauthorized',
  code: 'UNAUTHENTICATED',
  badCredential: true,
};

const NO_ACTOR: AccessDenied = { ok: false, status: 401, error: 'unauthorized', code: 'UNAUTHENTICATED' };

const RATE_LIMITED: AccessDenied = { ok: false, status: 429, error: 'rate limited', code: 'RATE_LIMITED' };

/** Non-api PATs act as anonymous callers on REST and pages; agent tokens on pages. */
function actorFor(transport: Transport, pat: PATInfo | null | undefined): Actor | null {
  if (!pat) return null;
  if (pat.agent && transport === 'page') return null;
  // A ci-transport PAT without the `ci` scope stays the actor so the scope
  // ceiling answers 403 INSUFFICIENT_SCOPE rather than treating it as anonymous.
  if (transport !== 'git' && transport !== 'ci' && !scopesAllow(pat.scopes, 'api')) return null;
  return patActor(pat);
}

async function decide(
  env: Env,
  repo: RepoRow | null,
  actor: Actor | null,
  req: RepoAccessRequest,
  facts: AccessFacts = NO_FACTS,
): Promise<RepoAccess> {
  if (req.requireActor && !actor) return NO_ACTOR;
  const d = await authorizeRepo(env, repo, actor, req.need, req.transport, facts);
  if (!d.ok) return d;
  // Checked after the repo decision so a repo the agent cannot see stays concealed.
  if (req.requireActor && actor?.agent && !req.allowAgent) return AGENT_FORBIDDEN;
  return { ok: true, repo: d.repo, actor, role: d.role };
}

interface Authoritative {
  pat: PATInfo | null;
  repo: RepoRow | null;
  facts: AccessFacts;
  /** The user the facts were read for; null when none were read. */
  factsUserId: string | null;
  branchRules?: BranchRule[];
}

/**
 * Whose membership and grant to read alongside the repo row. For an agent
 * token that is the minting user.
 */
type FactsSubject = { userId: string } | { patHash: string } | { agentHash: string } | null;

export type RepoFactsRow = RepoRow & { facts_org_role: unknown; facts_grant: unknown; facts_user_id: string | null };

/**
 * The repo row plus the subject's org membership and explicit grant, in one
 * statement. Both subqueries are primary-key probes; personal repos have a
 * NULL `owner_org_id`, so their membership probe matches nothing.
 */
function repoFactsSelect(db: D1Database, owner: string, name: string, subject: FactsSubject): D1PreparedStatement {
  if (!subject) {
    return db.prepare('SELECT * FROM repos WHERE owner_login = ? AND name = ?').bind(owner, name);
  }
  const who =
    'userId' in subject
      ? 'SELECT ?3 AS uid'
      : 'patHash' in subject
        ? 'SELECT user_id AS uid FROM pat WHERE hash = ?3 LIMIT 1'
        : 'SELECT created_by AS uid FROM agent_tokens WHERE hash = ?3 LIMIT 1';
  const key = 'userId' in subject ? subject.userId : 'patHash' in subject ? subject.patHash : subject.agentHash;
  return db
    .prepare(
      `WITH who AS (${who})
       SELECT r.*, who.uid AS facts_user_id,
              (SELECT m.role FROM org_members m
                WHERE m.org_id = r.owner_org_id AND m.user_id = who.uid) AS facts_org_role,
              (SELECT g.role FROM repo_grants g WHERE g.repo_id = r.id AND g.user_id = who.uid) AS facts_grant
         FROM repos r LEFT JOIN who
        WHERE r.owner_login = ?1 AND r.name = ?2`,
    )
    .bind(owner, name, key);
}

/** A repo row read with `facts_*` columns, split into the row and the caller's access facts. */
export function splitFacts(row: RepoFactsRow | RepoRow | undefined): {
  repo: RepoRow | null;
  facts: AccessFacts;
  userId: string | null;
} {
  if (!row) return { repo: null, facts: NO_FACTS, userId: null };
  if (!('facts_grant' in row)) return { repo: row, facts: NO_FACTS, userId: null };
  const { facts_org_role, facts_grant, facts_user_id, ...repo } = row;
  return {
    repo,
    facts: {
      ownerIsOrg: typeof repo.owner_org_id === 'string',
      orgRole: isOrgRole(facts_org_role) ? facts_org_role : null,
      grant: isRepoNeed(facts_grant) ? facts_grant : null,
    },
    userId: facts_user_id,
  };
}

/**
 * One D1 round trip: optional throttled last_used_at stamp, the PAT join and
 * the repo row with the caller's membership and grant. Refreshes the Cache
 * API copy of the PAT with what it read; repo rows, membership and grants are
 * never cached.
 */
async function authoritativeLookup(
  env: Env,
  opts: {
    hash: string | null;
    kind?: TokenKind;
    stamp: boolean;
    repo: { owner: string; name: string } | null;
    subject?: FactsSubject;
    branchRules?: boolean;
    now: number;
  },
): Promise<Authoritative> {
  const stmts: D1PreparedStatement[] = [];
  let patIndex = -1;
  let repoIndex = -1;
  const agent = opts.kind === 'agent';
  if (opts.hash) {
    if (opts.stamp) {
      stmts.push(
        agent
          ? agentTokenStamp(env.DB, opts.hash, opts.now, PAT_STAMP_INTERVAL_MS)
          : patStamp(env.DB, opts.hash, opts.now),
      );
    }
    patIndex = stmts.push(agent ? agentTokenSelect(env.DB, opts.hash, opts.now) : patSelect(env.DB, opts.hash)) - 1;
  }
  if (opts.repo) {
    repoIndex = stmts.push(repoFactsSelect(env.DB, opts.repo.owner, opts.repo.name, opts.subject ?? null)) - 1;
  }
  let rulesIndex = -1;
  if (opts.repo && opts.branchRules) {
    rulesIndex = stmts.push(branchRulesSelect(env.DB, opts.repo.owner, opts.repo.name)) - 1;
  }
  if (stmts.length === 0) return { pat: null, repo: null, facts: NO_FACTS, factsUserId: null };
  const results = await env.DB.batch(stmts);
  const row = patIndex >= 0 ? results[patIndex]?.results?.[0] : undefined;
  const pat = agent
    ? agentFromRow(row as AgentTokenRow | undefined, opts.now)
    : patFromRow(row as PatRow | undefined, opts.now);
  const { repo, facts, userId } =
    repoIndex >= 0 ? splitFacts(results[repoIndex]?.results?.[0] as RepoFactsRow | undefined) : splitFacts(undefined);
  if (opts.hash) {
    await writePatCache(opts.hash, pat, opts.now);
    principalObserver.getStore()?.(pat);
  }
  const out: Authoritative = { pat, repo, facts, factsUserId: userId };
  if (rulesIndex >= 0) {
    out.branchRules = ((results[rulesIndex]?.results ?? []) as unknown as BranchRuleRow[]).map(ruleFromRow);
  }
  return out;
}

const principalObserver = new AsyncLocalStorage<(pat: PATInfo | null) => void>();

/**
 * Runs `fn` while reporting every authoritative token verification it
 * performs (null: the token was rejected). The MCP endpoint dispatches a tool
 * call to its REST route and learns from this whether the bearer token it
 * relayed was valid, without paying for a second lookup of its own.
 */
export function observePrincipals<T>(observer: (pat: PATInfo | null) => void, fn: () => Promise<T>): Promise<T> {
  return principalObserver.run(observer, fn);
}

/**
 * Authoritative PAT verification for routes that act on the caller's own
 * account (user info, tokens, repo creation): always confirms against D1.
 */
export async function resolvePAT(env: Env, token: string, clientIp: string | null): Promise<PrincipalResult> {
  const kind = tokenKind(token);
  if (!kind) return BAD_CREDENTIAL;
  const now = Date.now();
  const hash = await patHash(token);
  const cachedEntry = await readPatCache(hash, now);
  if (cachedEntry === 'invalid') return BAD_CREDENTIAL;
  const cached = cachedEntry === 'seen' ? undefined : cachedEntry;
  if (!cachedEntry && !(await preauthAllowed(env, clientIp))) return RATE_LIMITED;
  const { pat } = await authoritativeLookup(env, {
    hash,
    kind,
    stamp: kind === 'agent' || patNeedsStamp(cached, now),
    repo: null,
    now,
  });
  return pat ? { ok: true, pat } : BAD_CREDENTIAL;
}

/**
 * The actor a credential acts as on a page outside any repository (the review
 * inbox): the session's user, or a verified human PAT with the `api` scope.
 * Agent tokens, other PATs and rejected or throttled tokens act as anonymous,
 * as they do on repository pages (rejectedCredentialAsAnonymous).
 */
export async function resolvePageActor(env: Env, credential: Credential, clientIp: string | null): Promise<Actor | null> {
  if (credential.kind === 'anonymous') return null;
  if (credential.kind === 'session') return credential.actor;
  const res = await resolvePAT(env, credential.token, clientIp);
  return res.ok ? actorFor('page', res.pat) : null;
}

/**
 * Repo access for an actor already verified authoritatively on this request
 * (for example a human minting credentials for a repo named in the body).
 */
export function resolveRepoAccessAs(
  env: Env,
  actor: Actor,
  owner: string,
  name: string,
  need: RepoNeed,
): Promise<RepoAccess> {
  return resolveRepoAccess(env, {
    owner,
    name,
    need,
    transport: 'api',
    credential: { kind: 'session', actor },
    clientIp: null,
  });
}

/** Resolves the credential and repository, then applies the shared policy. */
export async function resolveRepoAccess(env: Env, req: RepoAccessRequest): Promise<RepoAccess> {
  const now = Date.now();
  const cred = req.credential;
  if (req.requireActor && cred.kind === 'anonymous') return NO_ACTOR;
  const asAnonymous = req.rejectedCredentialAsAnonymous === true && !req.requireActor;
  let hash: string | null = null;
  let kind: TokenKind | undefined;
  if (cred.kind === 'pat') {
    const k = tokenKind(cred.token);
    if (k) {
      kind = k;
      hash = await patHash(cred.token);
    } else if (!asAnonymous) {
      return BAD_CREDENTIAL;
    }
  }

  let cachedEntry = hash ? await readPatCache(hash, now) : undefined;
  if (cachedEntry === 'invalid') {
    if (!asAnonymous) return BAD_CREDENTIAL;
    hash = null;
    kind = undefined;
    cachedEntry = undefined;
  }
  // Agent tokens never resolve from cache ('seen' only skips the preauth throttle).
  const cachedPat = cachedEntry === 'seen' ? undefined : cachedEntry;

  if (hash && !cachedEntry && !(await preauthAllowed(env, req.clientIp))) return RATE_LIMITED;

  // A PAT's owning user never changes, so a cached PAT safely names whose
  // facts to read; the PAT itself is still re-verified in the same batch.
  const subject: FactsSubject =
    cred.kind === 'session'
      ? { userId: cred.actor.user.id }
      : hash
        ? kind === 'agent'
          ? { agentHash: hash }
          : cachedPat
            ? { userId: cachedPat.userId }
            : { patHash: hash }
        : null;
  const fresh = await authoritativeLookup(env, {
    hash,
    kind,
    stamp: hash !== null && (kind === 'agent' || patNeedsStamp(cachedPat, now)),
    repo: { owner: req.owner, name: req.name },
    subject,
    branchRules: req.branchRules === true && req.need !== 'read',
    now,
  });
  if (hash && !fresh.pat) {
    if (!asAnonymous) return BAD_CREDENTIAL;
    // The repo row is current regardless of whose facts were joined to it;
    // the rejected principal's membership and grant are discarded.
    return decide(env, fresh.repo, null, req, NO_FACTS);
  }
  const actor = cred.kind === 'session' ? cred.actor : actorFor(req.transport, fresh.pat);
  const facts = actor && fresh.factsUserId === actor.user.id ? fresh.facts : NO_FACTS;
  const decision = await decide(env, fresh.repo, actor, req, facts);
  if (decision.ok && fresh.branchRules) decision.branchRules = fresh.branchRules;
  return decision;
}
