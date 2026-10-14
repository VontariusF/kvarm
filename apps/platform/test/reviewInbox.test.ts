/**
 * The human review inbox and provenance rendering (issue #8;
 * routes/reviewPages.ts, services/reviewInbox.ts, services/provenancePanel.ts):
 * cross-repository pending escalations and approvals under the shared
 * authority, the page decide flow through the REST service path with a
 * recorded decision, stale-approval marking, and the provenance panel on the
 * change and commit pages (present only when there is something to show,
 * redacted for non-admin readers).
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { newSessionPayload, sessionCookie } from '../src/auth/workos';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { toUserRow } from '../src/db/users';
import worker from '../src/index';
import { INBOX_LIMITS, parseDecisionNote } from '../src/services/reviewInbox';
import { staleApprovals, type ReviewView } from '../src/services/reviews';
import { FakeRepo, commit, fakeArtifacts, fakeRepos } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const env = { ...baseEnv, ARTIFACTS: fakeArtifacts } as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'ib-owner';
const OTHER = 'ib-other';
const NOW = 1_760_000_000_000;
const OLD_HEAD = 'a'.repeat(40);

const ids: Record<string, string> = {};
const repoIds: Record<string, string> = {};
const changeIds: Record<string, string> = {};
const tok = { owner: '', writer: '', reader: '', readScopeOnly: '', agent: '' };
let head = '';
let bare = '';

interface Read {
  status: number;
  text: string;
  cost: CostCounters;
  location: string | null;
}

async function call(path: string, token?: string, init: RequestInit = {}, e: Env = env): Promise<Read> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { ...init, method: init.method ?? 'GET', headers, redirect: 'manual' }) as Request<unknown, IncomingRequestCfProperties>,
    e,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  return { status: res.status, text, cost: cost!, location: res.headers.get('location') };
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, NOW)
    .run();
  ids[login] = id;
  return id;
}

async function seedRepo(owner: string, name: string, visibility: 'public' | 'private', pushedAt: number): Promise<string> {
  const id = crypto.randomUUID();
  const artifactsName = `${owner}--${name}`;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at, pushed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?, ?)`,
  )
    .bind(id, owner, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, NOW - 100_000, pushedAt)
    .run();
  repoIds[name] = id;
  return id;
}

async function grant(repo: string, login: string, role: 'read' | 'write'): Promise<void> {
  await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(repoIds[repo], ids[login], role, ids[OWNER], NOW, NOW)
    .run();
}

async function seedChange(
  key: string,
  repo: string,
  n: number,
  o: { title: string; author: string; headSha: string; createdAt: number; policy?: string; agent?: { id: string; name: string } },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, agent_meta, merge_policy, created_at)
     VALUES (?, ?, ?, ?, 'main', ?, ?, 'open', ?, ?, ?, ?)`,
  )
    .bind(id, repoIds[repo], n, o.title, `agents/w${n}/work`, o.headSha, ids[o.author], o.agent ? JSON.stringify({ agentId: o.agent.id, agentName: o.agent.name }) : null, o.policy ?? 'review', o.createdAt)
    .run();
  changeIds[key] = id;
  return id;
}

async function seedReview(change: string, o: { headSha: string; login: string; verdict: 'approve' | 'request-changes'; at: number; agent?: { id: string; name: string; family: string }; body?: string }): Promise<void> {
  const principal = o.agent ? `agent:${o.agent.id}` : `user:${ids[o.login]}`;
  await env.DB.prepare(
    `INSERT INTO change_reviews (id, repo_id, change_set_id, head_sha, principal, user_id, user_login, agent_id, agent_name, token_id, model_family, verdict, body, created_at, updated_at)
     SELECT ?, c.repo_id, c.id, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ? FROM change_sets c WHERE c.id = ?`,
  )
    .bind(crypto.randomUUID(), o.headSha, principal, ids[o.login], o.login, o.agent?.id ?? null, o.agent?.name ?? null, o.agent ? o.agent.family : 'human', o.verdict, o.body ?? null, o.at, o.at, changeIds[change])
    .run();
}

async function seedEscalation(change: string, reason: string, headSha: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO change_escalations (id, repo_id, change_set_id, change_number, reason, state, head_sha, detail, opened_by, opened_at)
     SELECT ?, c.repo_id, c.id, c.number, ?, 'open', ?, 'reviewers split on the head', 'system', ? FROM change_sets c WHERE c.id = ?`,
  )
    .bind(id, reason, headSha, NOW - 5_000, changeIds[change])
    .run();
  return id;
}

async function seedLedger(repo: string, sha: string, level: 'declared' | 'authenticated' | 'verified', reasons: string[]): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO attribution_evidence (repo_id, commit_sha, note_digest, notes_commit, source, agent, session, prompt_hash, model, actor, level, reasons,
                                       principal, token_kind, token_prefix, run_id, key_id, at, recorded_at)
     VALUES (?, ?, ?, ?, 'api', 'atlas', 'sess-42', 'sha256:prompt-abc', 'model-x', 'ib-owner', ?, ?, 'agent:ag-atlas', 'agent', 'kvarm_agt_abc1', ?, ?, ?, ?)`,
  )
    .bind(repoIds[repo], sha, crypto.randomUUID(), 'f'.repeat(40), level, JSON.stringify(reasons), level === 'verified' ? 'run-7' : null, level === 'verified' ? 'key0123456789abcd' : null, NOW, NOW)
    .run();
}

async function seedDecision(repo: string, task: string, at: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_decisions (id, repo_id, task_id, paths, chosen_candidate, rejected_candidates, reason, actor, agent_id, agent_name, at)
     VALUES (?, ?, ?, '[]', 'ws-atlas', ?, 'smaller diff and the tests pass', 'ib-owner', NULL, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), repoIds[repo], task, JSON.stringify([{ id: 'ws-boreas', reason: 'touched the lockfile' }, 'ws-cyan']), at)
    .run();
}

beforeAll(async () => {
  for (const login of [OWNER, OTHER, 'ib-writer', 'ib-reader']) await seedUser(login);
  await seedRepo(OWNER, 'alpha', 'private', NOW - 1_000);
  await seedRepo(OWNER, 'beta', 'public', NOW - 2_000);
  await seedRepo(OTHER, 'theirs', 'private', NOW - 500);
  await seedRepo(OTHER, 'lookonly', 'private', NOW - 400);
  await seedRepo(OTHER, 'granted', 'private', NOW - 300);
  await grant('alpha', 'ib-writer', 'write');
  await grant('alpha', 'ib-reader', 'read');
  await grant('lookonly', OWNER, 'read');
  await grant('granted', OWNER, 'write');
  await env.DB.prepare('INSERT INTO review_policies (repo_id, required_reviews, updated_by, updated_at) VALUES (?, 1, ?, ?)')
    .bind(repoIds.alpha, ids[OWNER], NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at, model_family) VALUES ('ag-atlas', 'user', ?, ?, 'atlas', ?, ?, 'gpt')",
  )
    .bind(ids['ib-writer'], 'ib-writer', ids['ib-writer'], NOW)
    .run();

  const git = new FakeRepo();
  fakeRepos.set(`${OWNER}--alpha`, git);
  const base = await commit(git, { 'README.md': 'readme\n' });
  head = (await commit(git, { 'README.md': 'readme\n', 'parser.ts': 'export {}\n' }, [base.sha], 'Fix the parser')).sha;
  bare = base.sha;
  git.refs.set('refs/heads/main', base.sha);

  // alpha#1: an agent-authored change where reviewers disagree, with one approval staled by a push.
  await seedChange('disputed', 'alpha', 1, { title: 'Fix the parser for nested quotes', author: 'ib-writer', headSha: head, createdAt: NOW - 60_000, agent: { id: 'ag-atlas', name: 'atlas' } });
  await seedReview('disputed', { headSha: OLD_HEAD, login: 'ib-reader', verdict: 'approve', at: NOW - 50_000 });
  await seedReview('disputed', { headSha: head, login: 'ib-writer', verdict: 'request-changes', at: NOW - 40_000, agent: { id: 'ag-boreas', name: 'boreas', family: 'claude' }, body: 'quotes still break' });
  ids.escalation = await seedEscalation('disputed', 'reviewer-disagreement', head);
  // alpha#2: short of the required review, no escalation.
  await seedChange('waiting', 'alpha', 2, { title: 'Add retry budget', author: 'ib-writer', headSha: head, createdAt: NOW - 30_000 });
  // alpha#3: a draft never waits for review.
  await seedChange('draft', 'alpha', 3, { title: 'Draft experiment', author: 'ib-writer', headSha: head, createdAt: NOW - 20_000, policy: 'draft' });
  // beta#1 (public, no policy): a protected-target escalation.
  await seedChange('protected', 'beta', 1, { title: 'Bump the release branch', author: 'ib-writer', headSha: head, createdAt: NOW - 10_000 });
  await seedEscalation('protected', 'protected-path', head);
  // Other people's repositories: concealed, read-only and write-granted.
  await seedChange('theirs', 'theirs', 1, { title: 'Secret refactor', author: OTHER, headSha: head, createdAt: NOW - 5_000 });
  await seedEscalation('theirs', 'review-blocked', head);
  await seedChange('lookonly', 'lookonly', 1, { title: 'Read-only change', author: OTHER, headSha: head, createdAt: NOW - 4_000 });
  await seedEscalation('lookonly', 'review-blocked', head);
  await seedChange('granted', 'granted', 1, { title: 'Granted change', author: OTHER, headSha: head, createdAt: NOW - 3_000 });
  await seedEscalation('granted', 'final-selection', head);

  // gamma: a branch rule wants one human approval on main; the review policy wants none.
  await seedRepo(OWNER, 'gamma', 'private', NOW - 5_000);
  await env.DB.prepare(
    `INSERT INTO branch_rules (id, repo_id, pattern, required_approvals, created_by, created_at, updated_by, updated_at)
     VALUES (?, ?, 'refs/heads/main', 1, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), repoIds.gamma, ids[OWNER], NOW, ids[OWNER], NOW)
    .run();
  // gamma#1: its protected-path escalation was acknowledged, yet the human approval is still missing;
  // its one reviewer approved an older head and then the current one, so nothing is stale.
  await seedChange('acknowledged', 'gamma', 1, { title: 'Acknowledged but unapproved', author: OTHER, headSha: head, createdAt: NOW - 200_000 });
  await seedEscalation('acknowledged', 'protected-path', head);
  await env.DB.prepare("UPDATE change_escalations SET state = 'resolved', resolution = 'acknowledge' WHERE change_set_id = ?").bind(changeIds.acknowledged).run();
  await seedReview('acknowledged', { headSha: OLD_HEAD, login: 'ib-writer', verdict: 'approve', at: NOW - 190_000 });
  await seedReview('acknowledged', { headSha: head, login: 'ib-writer', verdict: 'approve', at: NOW - 180_000 });
  // gamma#2: the protected-path escalation was never recorded.
  await seedChange('unrecorded', 'gamma', 2, { title: 'Unrecorded protected target', author: OTHER, headSha: head, createdAt: NOW - 210_000 });

  // alpha#4: a human author's change with a reviewer's request for changes open.
  await seedChange('own', 'alpha', 4, { title: 'Author asked to rework', author: 'ib-writer', headSha: head, createdAt: NOW - 300_000 });
  await seedEscalation('own', 'review-blocked', head);

  tok.owner = (await mintPAT(env, ids[OWNER]!, 'owner', ['read', 'write', 'api'])).token;
  tok.writer = (await mintPAT(env, ids['ib-writer']!, 'writer', ['read', 'write', 'api'])).token;
  tok.reader = (await mintPAT(env, ids['ib-reader']!, 'reader', ['read', 'write', 'api'])).token;
  tok.readScopeOnly = (await mintPAT(env, ids[OWNER]!, 'git-only', ['read', 'write'])).token;
});

describe('review inbox', () => {
  it('sends anonymous callers, git-only PATs and bad tokens to sign in', async () => {
    for (const token of [undefined, tok.readScopeOnly, `kvarm_pat_${'0'.repeat(64)}`]) {
      const r = await call('/inbox', token);
      expect(r.status).toBe(302);
      expect(r.location).toBe('/auth/sign-in?returnTo=%2Finbox');
    }
  });

  it('lists pending escalations and approvals the viewer may review, grouped by reason', async () => {
    const r = await call('/inbox', tok.owner);
    expect(r.status).toBe(200);
    // Grouped by reason, hardest first.
    const order = ['Reviewers disagree', 'Protected target', 'Arena final selection', 'Awaiting approval'].map((g) => r.text.indexOf(`>${g} · <b>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.text).toContain('Fix the parser for nested quotes');
    expect(r.text).toContain('Add retry budget');
    expect(r.text).toContain('Bump the release branch');
    expect(r.text).toContain('Granted change');
    // Drafts, concealed repositories and read-only grants never show.
    expect(r.text).not.toContain('Draft experiment');
    expect(r.text).not.toContain('Secret refactor');
    expect(r.text).not.toContain('Read-only change');
    // Each row links to the change, the risk-ordered compare and the verdicts.
    expect(r.text).toContain(`href="/${OWNER}/alpha/changes/1"`);
    expect(r.text).toContain(`href="/${OWNER}/alpha/compare/${encodeURIComponent(`main...${head}`)}"`);
    expect(r.text).toContain(`href="/${OWNER}/alpha/changes/1#verdicts"`);
    // Verdicts carry the model family with its evidence label, and the stale approval is marked.
    expect(r.text).toMatch(/<b>boreas<\/b>.*request changes.*<code>claude<\/code> <span class="k-ev k-ev-declared"/s);
    expect(r.text).toMatch(/<b>ib-reader<\/b>.*approve.*<code>human<\/code> <span class="k-ev k-ev-authenticated"/s);
    expect(r.text).toContain('tag tag-stale');
    expect(r.text).toContain('1 stale');
    // The Inbox is in the app rail.
    expect(r.text).toContain('<a href="/inbox" aria-current="page">');
    // The Inbox has its own glyph, not Fleet's.
    expect(r.text).toMatch(/<a href="\/inbox" aria-current="page"><svg aria-hidden="true"><use href="#g-tray"\/>/);
  });

  it('pages with bounded limits and an opaque cursor', async () => {
    const first = await call('/inbox?limit=2', tok.owner);
    expect(first.status).toBe(200);
    expect(first.text).toContain('Granted change');
    expect(first.text).toContain('Bump the release branch');
    expect(first.text).not.toContain('Add retry budget');
    const next = /href="\/inbox\?cursor=([^"&]+)&amp;limit=2"/.exec(first.text);
    expect(next).not.toBeNull();
    const second = await call(`/inbox?cursor=${next![1]}&limit=2`, tok.owner);
    expect(second.text).toContain('Add retry budget');
    expect(second.text).toContain('Fix the parser for nested quotes');
    expect(second.text).not.toContain('Granted change');
    expect((await call('/inbox?limit=500', tok.owner)).status).toBe(400);
    expect((await call('/inbox?cursor=nope', tok.owner)).status).toBe(400);
  });

  it('lists changes the branch rules hold for a human, and marks only approvals nobody renewed as stale', async () => {
    const r = await call('/inbox', tok.owner);
    const item = (title: string) => {
      const at = r.text.indexOf(title);
      expect(at, title).toBeGreaterThan(0);
      return r.text.slice(r.text.lastIndexOf('<article', at), r.text.indexOf('</article>', at));
    };
    const acknowledged = item('Acknowledged but unapproved');
    expect(acknowledged).toContain('Awaiting approval');
    expect(acknowledged).toContain('human 0/1');
    expect(acknowledged).not.toContain('tag-stale');
    const unrecorded = item('Unrecorded protected target');
    expect(unrecorded).toContain('Protected target');
  });

  it('counts CRLF line breaks once against the note limit', () => {
    const note = `${'x'.repeat(INBOX_LIMITS.noteMax - 20)}${'\r\n'.repeat(20)}y`;
    expect(parseDecisionNote(note).ok).toBe(false);
    const fits = `${'x'.repeat(INBOX_LIMITS.noteMax - 21)}${'\r\n'.repeat(20)}y`;
    expect(parseDecisionNote(fits)).toEqual({ ok: true, value: fits.replace(/\r\n/g, '\n') });
  });

  it('counts a stale approval once per principal', () => {
    const v = (principal: string, current: boolean, updatedAt: string) => ({ principal, verdict: 'approve', current, updatedAt }) as ReviewView;
    const reviews = [v('user:p', false, '2026-01-02T00:00:00Z'), v('user:p', false, '2026-01-01T00:00:00Z'), v('user:q', false, '2026-01-01T00:00:00Z'), v('user:q', true, '2026-01-03T00:00:00Z')];
    expect(staleApprovals(reviews)).toEqual([reviews[0]]);
  });

  it('shows the empty state in the product voice', async () => {
    const r = await call('/inbox', tok.reader);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Nothing needs a human right now.');
  });

  it('costs a bounded number of D1 round trips', async () => {
    const r = await call('/inbox', tok.owner);
    // PAT lookup, inbox repos, pending page, reviews+escalations batch, rail repos, header counts.
    expect(r.cost.d1).toBeLessThanOrEqual(7);
  });
});

describe('change page', () => {
  it('renders verdicts with the stale approval marked, escalations and the decide forms', async () => {
    const r = await call(`/${OWNER}/alpha/changes/1`, tok.owner);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Fix the parser for nested quotes');
    expect(r.text).toContain('k-row-stale');
    expect(r.text).toContain('went stale when the head moved');
    expect(r.text).toContain(`action="/${OWNER}/alpha/changes/1/review"`);
    expect(r.text).toContain(`action="/${OWNER}/alpha/changes/1/escalations/${ids.escalation}/resolve"`);
    expect(r.text).toMatch(/<textarea[^>]*name="note"[^>]*required/);
    // Gate and escalation copy is page copy, not the API's error strings.
    expect(r.text).not.toContain('open escalation(s) need a human');
    expect(r.text).toContain('Reviewers disagree waits for a human.');
    expect(r.text).toContain('The review policy wants 1 approving review of this head');
    expect(r.text).toContain('One reviewer approved the head another asked to change.');
    expect(r.text).toContain(' by Kvarm</span>');
    expect(r.text).not.toContain('by system');
    // A reviewer's note spans the table under its verdict instead of a narrow fifth column.
    expect(r.text).toContain('<td colspan="4" class="k-cell-note">quotes still break</td>');
    expect(r.text).not.toContain('scope="col">Note');
    // The open change is the current repository tab.
    expect(r.text).toContain('aria-current="page">Change #1</a>');
  });

  it('conceals private changes and hides decide forms from readers', async () => {
    expect((await call(`/${OWNER}/alpha/changes/1`)).status).toBe(404);
    expect((await call(`/${OTHER}/theirs/changes/1`, tok.owner)).status).toBe(404);
    const reader = await call(`/${OWNER}/alpha/changes/1`, tok.reader);
    expect(reader.status).toBe(200);
    expect(reader.text).not.toContain('/review"');
    expect((await call(`/${OWNER}/alpha/changes/99`, tok.owner)).status).toBe(404);
  });

  it('renders no provenance panel when there is no attribution or decision', async () => {
    const r = await call(`/${OWNER}/beta/changes/1`, tok.owner);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('class="k-prov"');
  });
});

describe('deciding from the page', () => {
  it('folds the inbox count into the header badge on every app page', async () => {
    const inbox = await call('/inbox', tok.owner);
    const n = /(\d+) CHANGES/.exec(inbox.text)?.[1];
    expect(n).toBeDefined();
    const badge = (text: string) => /<a class="k-needs" href="([^"]+)"[^>]*><span>Needs you<\/span><b>([^<]+)<\/b>/.exec(text);
    expect(badge(inbox.text)?.slice(1)).toEqual(['/inbox', n]);
    // Another app page reads the remembered count back, with no inbox query of its own.
    const change = await call(`/${OWNER}/beta/changes/1`, tok.owner);
    expect(badge(change.text)?.slice(1)).toEqual(['/inbox', n]);
  });

  it('returns a failed inbox decision to its item, panel open, error beside it', async () => {
    const r = await call(`/${OWNER}/alpha/changes/2/review`, tok.owner, form({ verdict: 'approve', headSha: head, note: '', back: 'inbox' }));
    const key = `ch/${OWNER}/alpha/2`;
    expect(r.location).toBe(`/inbox?error=NOTE_REQUIRED&item=${encodeURIComponent(key)}#${key}`);
    const page = await call(r.location!, tok.owner);
    const at = page.text.indexOf(`id="${key}"`);
    expect(at).toBeGreaterThan(0);
    const item = page.text.slice(at, page.text.indexOf('</article>', at));
    expect(item).toContain('<details class="k-decide" open>');
    expect(item).toMatch(/role="alert">Add a note/);
    // Shown once, next to the item, not again at the top of the page.
    expect(page.text.split('role="alert"').length).toBe(2);
  });

  it('requires a note and writes nothing without one', async () => {
    const r = await call(`/${OWNER}/alpha/changes/2/review`, tok.owner, form({ verdict: 'approve', headSha: head, note: '   ', back: 'change' }));
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/${OWNER}/alpha/changes/2?error=NOTE_REQUIRED#decide`);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM change_reviews WHERE change_set_id = ?').bind(changeIds.waiting).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('approves through the review service and records the decision', async () => {
    const r = await call(`/${OWNER}/alpha/changes/2/review`, tok.owner, form({ verdict: 'approve', headSha: head, note: 'retry budget reads right', back: 'inbox' }));
    expect(r.status).toBe(303);
    expect(r.location).toBe('/inbox?done=approve');
    const review = await env.DB.prepare('SELECT verdict, body, head_sha FROM change_reviews WHERE change_set_id = ?').bind(changeIds.waiting).first<Record<string, string>>();
    expect(review).toEqual({ verdict: 'approve', body: 'retry budget reads right', head_sha: head });
    const decision = await env.DB.prepare("SELECT chosen_candidate, reason, actor FROM agent_decisions WHERE repo_id = ? AND task_id = 'change:2'").bind(repoIds.alpha).first<Record<string, string>>();
    expect(decision).toEqual({ chosen_candidate: `approve@${head}`, reason: 'retry budget reads right', actor: OWNER });
    // A decision drops the remembered inbox count: the badge stops claiming stale work.
    const elsewhere = await call(`/${OWNER}/beta/changes/1`, tok.owner);
    expect(elsewhere.text).toContain('<a class="k-needs" href="/fleet#approvals"');
    // The approval met the policy: the change left the inbox, and the decision shows on its page.
    expect((await call('/inbox', tok.owner)).text).not.toContain('Add retry budget');
    const page = await call(`/${OWNER}/alpha/changes/2`, tok.owner);
    expect(page.text).toContain('class="k-prov"');
    expect(page.text).toContain(`approve@${head}`);
  });

  it('records a missing escalation before an approval, so the approval answers it', async () => {
    const r = await call(`/${OWNER}/gamma/changes/2/review`, tok.owner, form({ verdict: 'approve', headSha: head, note: 'protected bump is fine', back: 'inbox' }));
    expect(r.location).toBe('/inbox?done=approve');
    const esc = await env.DB.prepare("SELECT state, resolution FROM change_escalations WHERE change_set_id = ? AND reason = 'protected-path'")
      .bind(changeIds.unrecorded)
      .first<Record<string, string>>();
    expect(esc).toEqual({ state: 'resolved', resolution: 'approve' });
    expect((await call('/inbox', tok.owner)).text).not.toContain('Unrecorded protected target');
  });

  it('gives a change author no resolve form for their own change', async () => {
    const author = await call(`/${OWNER}/alpha/changes/4`, tok.writer);
    expect(author.status).toBe(200);
    expect(author.text).not.toContain('/resolve"');
    expect(author.text).toContain('/review"');
    const other = await call(`/${OWNER}/alpha/changes/4`, tok.owner);
    expect(other.text).toContain('/resolve"');
  });

  it('refuses a review of a head that moved', async () => {
    const r = await call(`/${OWNER}/alpha/changes/1/review`, tok.owner, form({ verdict: 'request-changes', headSha: OLD_HEAD, note: 'stale page', back: 'change' }));
    expect(r.location).toBe(`/${OWNER}/alpha/changes/1?error=HEAD_MOVED#decide`);
  });

  it('resolves an escalation through the review service and records the decision', async () => {
    const r = await call(
      `/${OWNER}/alpha/changes/1/escalations/${ids.escalation}/resolve`,
      tok.owner,
      form({ resolution: 'resolve', note: 'boreas is right; atlas reworks the quotes', back: 'change' }),
    );
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/${OWNER}/alpha/changes/1?done=resolve`);
    const esc = await env.DB.prepare('SELECT state, resolution, note, resolved_by_login FROM change_escalations WHERE id = ?').bind(ids.escalation).first<Record<string, string>>();
    expect(esc).toEqual({ state: 'resolved', resolution: 'resolve', note: 'boreas is right; atlas reworks the quotes', resolved_by_login: OWNER });
    const decision = await env.DB.prepare("SELECT chosen_candidate FROM agent_decisions WHERE repo_id = ? AND task_id = 'change:1'").bind(repoIds.alpha).first<{ chosen_candidate: string }>();
    expect(decision?.chosen_candidate).toBe('resolve:reviewer-disagreement');
    const again = await call(`/${OWNER}/alpha/changes/1/escalations/${ids.escalation}/resolve`, tok.owner, form({ resolution: 'resolve', note: 'twice', back: 'change' }));
    expect(again.location).toBe(`/${OWNER}/alpha/changes/1?error=ESCALATION_RESOLVED#escalations`);
  });

  it('answers 404 to callers without write access', async () => {
    const reader = await call(`/${OWNER}/alpha/changes/1/review`, tok.reader, form({ verdict: 'approve', note: 'lgtm' }));
    expect(reader.status).toBe(404);
    const anon = await call(`/${OWNER}/beta/changes/1/review`, undefined, form({ verdict: 'approve', note: 'lgtm' }));
    expect(anon.status).toBe(404);
  });

  it('requires the session CSRF token on a signed-in browser post', async () => {
    const authEnv = {
      ...env,
      WORKOS_CLIENT_ID: 'client_fake',
      WORKOS_API_KEY: 'sk_fake_not_a_real_key',
      WORKOS_COOKIE_PASSWORD: 'test-cookie-password-0123456789abcdef',
    } as Env;
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ids[OWNER]).first<Parameters<typeof toUserRow>[0]>();
    const payload = newSessionPayload(toUserRow(row!), {
      user: { id: row!.workos_user_id, email: row!.email, emailVerified: true, name: null, avatarUrl: null },
      refreshToken: 'rt_unused',
      sessionId: null,
    });
    const cookie = (await sessionCookie(authEnv, payload)).split(';')[0]!;
    const browser = (path: string, init: RequestInit = {}) =>
      call(path, undefined, { ...init, headers: { cookie, ...(init.headers as Record<string, string>) } }, authEnv);
    const inbox = await browser('/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.text).toContain(`name="_csrf" value="${payload.csrf}"`);
    const missing = await browser(`/${OWNER}/beta/changes/1/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: new URLSearchParams({ verdict: 'approve', headSha: head, note: 'ship it' }).toString(),
    });
    expect(missing.status).toBe(403);
    const none = await env.DB.prepare('SELECT COUNT(*) AS n FROM change_reviews WHERE change_set_id = ?').bind(changeIds.protected).first<{ n: number }>();
    expect(none?.n).toBe(0);
    const ok = await browser(`/${OWNER}/beta/changes/1/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: new URLSearchParams({ _csrf: payload.csrf, verdict: 'approve', headSha: head, note: 'ship it', back: 'inbox' }).toString(),
    });
    expect(ok.status).toBe(303);
    const esc = await env.DB.prepare("SELECT state FROM change_escalations WHERE change_set_id = ? AND reason = 'protected-path'").bind(changeIds.protected).first<{ state: string }>();
    expect(esc?.state).toBe('resolved');
  });
});

describe('provenance panel', () => {
  it('shows each evidence level with its reasons on the change page, redacted for non-admins', async () => {
    await seedLedger('alpha', head, 'authenticated', ['no-signed-evidence']);
    await seedDecision('alpha', 'change:1', NOW);
    const admin = await call(`/${OWNER}/alpha/changes/1`, tok.owner);
    expect(admin.text).toContain('class="k-prov"');
    expect(admin.text).toContain('k-ev k-ev-authenticated');
    expect(admin.text).toContain('sess-42');
    expect(admin.text).toContain('sha256:prompt-abc');
    expect(admin.text).toContain('No signed evidence from a trusted execution service.');
    expect(admin.text).toContain('kvarm_agt_abc1');
    expect(admin.text).toContain('agent:ag-atlas');
    // Chosen and rejected candidates with their reasons.
    expect(admin.text).toContain('ws-atlas');
    expect(admin.text).toContain('ws-boreas');
    expect(admin.text).toContain('touched the lockfile');
    expect(admin.text).toContain('smaller diff and the tests pass');
    const writer = await call(`/${OWNER}/alpha/changes/1`, tok.writer);
    expect(writer.text).toContain('k-ev k-ev-authenticated');
    expect(writer.text).not.toContain('kvarm_agt_abc1');
    expect(writer.text).not.toContain('agent:ag-atlas');
  });

  it('shows the newest ledger row: verified and declared', async () => {
    await env.DB.prepare('UPDATE attribution_evidence SET recorded_at = recorded_at - 10 WHERE repo_id = ?').bind(repoIds.alpha).run();
    await seedLedger('alpha', head, 'verified', []);
    const v = await call(`/${OWNER}/alpha/changes/1`, tok.owner);
    expect(v.text).toContain('k-ev k-ev-verified');
    expect(v.text).toContain('run-7');
    expect(v.text).not.toContain('Why not higher');
    await env.DB.prepare('UPDATE attribution_evidence SET recorded_at = recorded_at - 10 WHERE repo_id = ?').bind(repoIds.alpha).run();
    await seedLedger('alpha', head, 'declared', ['human-submitted-agent-metadata', 'no-signed-evidence']);
    const d = await call(`/${OWNER}/alpha/changes/1`, tok.owner);
    expect(d.text).toContain('k-ev k-ev-declared');
    expect(d.text).toContain('A human credential wrote agent metadata.');
  });

  it('renders on the commit page when present and not at all when absent', async () => {
    const with_ = await call(`/${OWNER}/alpha/commit/${head}`, tok.owner);
    expect(with_.status).toBe(200);
    expect(with_.text).toContain('class="k-prov"');
    expect(with_.text).toContain('/assets/tokens.css');
    const without = await call(`/${OWNER}/alpha/commit/${bare}`, tok.owner);
    expect(without.status).toBe(200);
    expect(without.text).not.toContain('k-prov');
    expect(without.text).not.toContain('/assets/tokens.css');
  });
});
