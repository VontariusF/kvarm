/**
 * Adversarial checks of the review pages (issue #8; routes/reviewPages.ts,
 * services/reviewInbox.ts, services/inboxCount.ts): what the inbox, change
 * page and badge conceal from a viewer who lost or never had access, what a
 * tampered decide post can and cannot do, and that every stored or echoed
 * string renders escaped.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader } from '../src/cost/meter';
import { toUserRow } from '../src/db/users';
import worker from '../src/index';
import { mintAgentToken } from '../src/services/agents';
import { validateOrgLogin } from '../src/services/orgs';
import { INBOX_LIMITS } from '../src/services/reviewInbox';
import { FakeRepo, commit, fakeArtifacts, fakeRepos } from './helpers/fakeArtifacts';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const ORIGIN = 'https://kvarm.test';
const NOW = 1_760_000_000_000;
const OWNER = 'sx-owner';
const XSS = `<script>alert(1)</script>"'><img src=x onerror=alert(2)>`;

const ids: Record<string, string> = {};
const repoIds: Record<string, string> = {};
const changeIds: Record<string, string> = {};
const esc: Record<string, string> = {};
const tok: Record<string, string> = {};
let head = '';

async function call(path: string, token?: string, init: RequestInit = {}): Promise<{ status: number; text: string; location: string | null; d1: number }> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { ...init, method: init.method ?? 'GET', headers, redirect: 'manual' }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, text, location: res.headers.get('location'), d1: parseCostHeader(res.headers.get(COST_HEADER))?.d1 ?? -1 };
}

const post = (fields: Record<string, string>): RequestInit => ({
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
  tok[login] = (await mintPAT(env, id, `${login}-pat`, ['read', 'write', 'api'])).token;
  return id;
}

async function seedRepo(owner: string, name: string, orgId: string | null = null): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at, pushed_at, owner_org_id)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?, ?, ?)`,
  )
    .bind(id, owner, name, `${owner}--${name}`, `https://artifacts.invalid/git/default/${owner}--${name}.git`, NOW, NOW, orgId)
    .run();
  repoIds[name] = id;
}

async function seedChange(key: string, repo: string, n: number, o: { title: string; author: string; headRef?: string; base?: string; agent?: { id: string; name: string } }): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, agent_meta, merge_policy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 'review', ?)`,
  )
    .bind(id, repoIds[repo], n, o.title, o.base ?? 'main', o.headRef ?? `agents/w${n}/work`, head, ids[o.author], o.agent ? JSON.stringify({ agentId: o.agent.id, agentName: o.agent.name }) : null, NOW - n)
    .run();
  changeIds[key] = id;
}

async function seedEscalation(key: string, change: string, reason: string, note: string | null = null): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO change_escalations (id, repo_id, change_set_id, change_number, reason, state, head_sha, detail, opened_by, opened_at, note)
     SELECT ?, c.repo_id, c.id, c.number, ?, 'open', c.head_sha, 'split', 'system', ?, ? FROM change_sets c WHERE c.id = ?`,
  )
    .bind(id, reason, NOW, note, changeIds[change])
    .run();
  esc[key] = id;
}

const count = async (sql: string, ...bind: unknown[]): Promise<number> => (await env.DB.prepare(sql).bind(...bind).first<{ n: number }>())?.n ?? -1;

beforeAll(async () => {
  for (const login of [OWNER, 'sx-author', 'sx-revoked', 'sx-exmember', 'sx-stranger']) await seedUser(login);
  await seedRepo(OWNER, 'core');
  for (const login of ['sx-author', 'sx-revoked']) {
    await env.DB.prepare("INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, 'write', ?, ?, ?)")
      .bind(repoIds.core, ids[login], ids[OWNER], NOW, NOW)
      .run();
  }
  // An org whose former maintainer still has a grant row: grants on org repos lapse with the membership.
  const orgId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO orgs (id, login, name, created_by, created_at) VALUES (?, 'sx-org', 'sx-org', ?, ?)").bind(orgId, ids[OWNER], NOW).run();
  await env.DB.prepare("INSERT INTO org_members (org_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)").bind(orgId, ids[OWNER], NOW, NOW).run();
  await seedRepo('sx-org', 'orgrepo', orgId);
  await env.DB.prepare("INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, 'write', ?, ?, ?)")
    .bind(repoIds.orgrepo, ids['sx-exmember'], ids[OWNER], NOW, NOW)
    .run();

  const git = new FakeRepo();
  fakeRepos.set(`${OWNER}--core`, git);
  const base = await commit(git, { 'README.md': 'readme\n' });
  head = (await commit(git, { 'README.md': 'changed\n' }, [base.sha], 'Change')).sha;
  git.refs.set('refs/heads/main', base.sha);

  await env.DB.prepare(
    "INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at, model_family) VALUES ('sx-agent', 'user', ?, ?, ?, ?, ?, ?)",
  )
    .bind(ids[OWNER], OWNER, `ag${XSS}`, ids[OWNER], NOW, `fam${XSS}`)
    .run();

  await seedChange('own', 'core', 1, { title: 'Author owns this one', author: 'sx-author' });
  await seedEscalation('own', 'own', 'review-blocked');
  await seedChange('hostile', 'core', 2, { title: `T${XSS}‮gnp.exe`, author: 'sx-author', headRef: `h${XSS}`, agent: { id: 'sx-agent', name: `ag${XSS}` } });
  await seedEscalation('hostile', 'hostile', 'reviewer-disagreement');
  await env.DB.prepare(
    `INSERT INTO change_reviews (id, repo_id, change_set_id, head_sha, principal, user_id, user_login, agent_id, agent_name, token_id, model_family, verdict, body, created_at, updated_at)
     SELECT ?, c.repo_id, c.id, c.head_sha, 'agent:sx-agent', ?, ?, 'sx-agent', ?, NULL, ?, 'request-changes', ?, ?, ? FROM change_sets c WHERE c.id = ?`,
  )
    .bind(crypto.randomUUID(), ids[OWNER], OWNER, `ag${XSS}`, `fam${XSS}`, `body${XSS}`, NOW, NOW, changeIds.hostile)
    .run();
  await env.DB.prepare(
    `INSERT INTO agent_decisions (id, repo_id, task_id, paths, chosen_candidate, rejected_candidates, reason, actor, agent_id, agent_name, at)
     VALUES (?, ?, 'change:2', '[]', ?, ?, ?, ?, NULL, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), repoIds.core, `chosen${XSS}`, JSON.stringify([{ id: `rej${XSS}`, reason: `why${XSS}` }, `plain${XSS}`]), `reason${XSS}`, `actor${XSS}`, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO attribution_evidence (repo_id, commit_sha, note_digest, notes_commit, source, agent, session, prompt_hash, model, actor, level, reasons,
                                       principal, token_kind, token_prefix, run_id, key_id, at, recorded_at)
     VALUES (?, ?, ?, ?, 'api', ?, ?, ?, ?, ?, 'verified', ?, 'agent:sx-agent', 'agent', 'kvarm_agt_sx01', ?, ?, ?, ?)`,
  )
    .bind(repoIds.core, head, crypto.randomUUID(), 'f'.repeat(40), `a${XSS}`, `s${XSS}`, `p${XSS}`, `m${XSS}`, `actor${XSS}`, JSON.stringify([`code${XSS}`]), `run${XSS}`, `key${XSS}`, NOW, NOW)
    .run();
  await seedChange('org', 'orgrepo', 1, { title: 'Org secret change', author: OWNER });
  await seedEscalation('org', 'org', 'review-blocked');

  // Access that ended: a revoked grant and a membership that ended (its grant row left behind).
  await env.DB.prepare('DELETE FROM repo_grants WHERE repo_id = ? AND user_id = ?').bind(repoIds.core, ids['sx-revoked']).run();
  const owner = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ids[OWNER]).first<Parameters<typeof toUserRow>[0]>();
  const minted = await mintAgentToken(env, { user: toUserRow(owner!), via: 'session', scopes: null }, 'sx-agent', {
    repo: `${OWNER}/core`,
    role: 'write',
    refs: ['refs/heads/agents/*'],
    expiresIn: 3600,
    name: null,
  });
  if (!minted.ok) throw new Error(minted.error);
  tok.agent = minted.value.token;
});

describe('concealment', () => {
  it('lists nothing and conceals the change page after a grant is revoked or an org membership ends', async () => {
    for (const login of ['sx-revoked', 'sx-exmember', 'sx-stranger']) {
      const inbox = await call('/inbox', tok[login]);
      expect(inbox.status, login).toBe(200);
      for (const secret of ['Author owns this one', 'Org secret change', 'core', 'orgrepo']) expect(inbox.text, `${login} ${secret}`).not.toContain(secret);
      expect((await call(`/${OWNER}/core/changes/1`, tok[login])).status, login).toBe(404);
      expect((await call('/sx-org/orgrepo/changes/1', tok[login])).status, login).toBe(404);
      const write = await call(`/sx-org/orgrepo/changes/1/escalations/${esc.org}/resolve`, tok[login], post({ resolution: 'resolve', note: 'mine now' }));
      expect(write.status, login).toBe(404);
    }
    expect(await count("SELECT COUNT(*) AS n FROM change_escalations WHERE id = ? AND state = 'open'", esc.org)).toBe(1);
  });

  it('reserves the inbox path, so no account’s profile hides behind it', () => {
    expect(validateOrgLogin('inbox')).toBe('login is reserved');
  });

  it('never shows one user the inbox count another user’s /inbox remembered', async () => {
    const own = await call('/inbox', tok[OWNER]);
    expect(own.text).toMatch(/<a class="k-needs" href="\/inbox"[^>]*><span>Needs you<\/span><b>[1-9]/);
    for (const login of ['sx-stranger', 'sx-revoked']) {
      const page = await call(`/${login}`, tok[login]);
      const badge = /<a class="k-needs" href="([^"]+)"[^>]*><span>Needs you<\/span><b>([^<]+)<\/b>/.exec(page.text);
      if (badge) expect(badge.slice(1), login).toEqual(['/fleet#approvals', '0']);
    }
  });
});

describe('tampered decide posts', () => {
  it('refuses the change author resolving an escalation on their own change, as the page offers no form', async () => {
    const r = await call(`/${OWNER}/core/changes/1/escalations/${esc.own}/resolve`, tok['sx-author'], post({ resolution: 'resolve', note: 'my own change is fine' }));
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/${OWNER}/core/changes/1?error=SELF_RESOLVE#escalations`);
    expect(await count("SELECT COUNT(*) AS n FROM change_escalations WHERE id = ? AND state = 'open'", esc.own)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM agent_decisions WHERE repo_id = ? AND task_id = 'change:1'", repoIds.core)).toBe(0);
    const page = await call(r.location!, tok['sx-author']);
    expect(page.text).toContain('another human resolves');
  });

  it('refuses an approval that names no head, so a page approves only the head it showed', async () => {
    for (const fields of [{ verdict: 'approve', note: 'blind approval' }, { verdict: 'approve', note: 'blind approval', headSha: '' }] as Array<Record<string, string>>) {
      const r = await call(`/${OWNER}/core/changes/1/review`, tok[OWNER], post(fields));
      expect(r.location).toBe(`/${OWNER}/core/changes/1?error=HEAD_MOVED#decide`);
    }
    expect(await count('SELECT COUNT(*) AS n FROM change_reviews WHERE change_set_id = ?', changeIds.own)).toBe(0);
  });

  it('refuses a resolution outside the enum instead of reading it as resolve', async () => {
    const r = await call(`/${OWNER}/core/changes/1/escalations/${esc.own}/resolve`, tok[OWNER], post({ resolution: 'approve', note: 'tampered' }));
    expect(r.location).toBe(`/${OWNER}/core/changes/1?error=INVALID_RESOLUTION#escalations`);
    expect(await count("SELECT COUNT(*) AS n FROM change_escalations WHERE id = ? AND state = 'open'", esc.own)).toBe(1);
  });

  it('refuses a verdict outside the enum, an oversized note and an escalation of another change', async () => {
    const verdict = await call(`/${OWNER}/core/changes/1/review`, tok[OWNER], post({ verdict: 'merge', headSha: head, note: 'x' }));
    expect(verdict.location).toBe(`/${OWNER}/core/changes/1?error=INVALID_VERDICT#decide`);
    const long = await call(`/${OWNER}/core/changes/1/review`, tok[OWNER], post({ verdict: 'approve', headSha: head, note: 'x'.repeat(INBOX_LIMITS.noteMax + 1) }));
    expect(long.location).toBe(`/${OWNER}/core/changes/1?error=INVALID_NOTE#decide`);
    // change 1's URL with change 2's escalation, and another repository's escalation.
    const mismatch = await call(`/${OWNER}/core/changes/1/escalations/${esc.hostile}/resolve`, tok[OWNER], post({ resolution: 'resolve', note: 'wrong change' }));
    expect(mismatch.location).toBe(`/${OWNER}/core/changes/1?error=ESCALATION_NOT_FOUND#escalations`);
    const foreign = await call(`/${OWNER}/core/changes/1/escalations/${esc.org}/resolve`, tok[OWNER], post({ resolution: 'resolve', note: 'other repo' }));
    expect(foreign.location).toBe(`/${OWNER}/core/changes/1?error=ESCALATION_NOT_FOUND#escalations`);
    expect(await count("SELECT COUNT(*) AS n FROM change_escalations WHERE state = 'open' AND id IN (?, ?)", esc.hostile, esc.org)).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM change_reviews WHERE change_set_id = ?', changeIds.own)).toBe(0);
  });

  it('never redirects off the site, whatever `back` and `cursor` say', async () => {
    for (const back of ['//evil.example/x', 'https://evil.example/', 'javascript:alert(1)', '/\\evil.example']) {
      for (const outcome of [{ note: '' }, { note: 'ok' }]) {
        const r = await call(`/${OWNER}/core/changes/1/review`, tok[OWNER], post({ verdict: 'request-changes', headSha: 'b'.repeat(40), back, cursor: `x"\r\nLocation: //evil`, ...outcome }));
        expect(r.status).toBe(303);
        expect(r.location!.startsWith(`/${OWNER}/core/changes/1?`), r.location!).toBe(true);
      }
    }
    const inbox = await call(`/${OWNER}/core/changes/1/review`, tok[OWNER], post({ verdict: 'request-changes', headSha: 'b'.repeat(40), note: 'x', back: 'inbox', cursor: '//evil.example\r\nx' }));
    expect(inbox.location!.startsWith('/inbox?'), inbox.location!).toBe(true);
    expect(inbox.location).not.toMatch(/[\r\n]/);
  });

  it('lets another human resolve it, within the decide budget', async () => {
    const r = await call(`/${OWNER}/core/changes/1/escalations/${esc.own}/resolve`, tok[OWNER], post({ resolution: 'acknowledge', note: 'seen; rework tracked' }));
    expect(r.location).toBe(`/${OWNER}/core/changes/1?done=acknowledge`);
    expect(r.d1).toBeLessThanOrEqual(5);
    expect(await count("SELECT COUNT(*) AS n FROM agent_decisions WHERE repo_id = ? AND task_id = 'change:1'", repoIds.core)).toBe(1);
  });

  it('answers an agent token on the pages as anonymous: no inbox, no change page, no decision', async () => {
    expect((await call('/inbox', tok.agent)).status).toBe(302);
    expect((await call(`/${OWNER}/core/changes/2`, tok.agent)).status).toBe(404);
    expect((await call(`/${OWNER}/core/changes/2/review`, tok.agent, post({ verdict: 'approve', headSha: head, note: 'agent' }))).status).toBe(404);
  });
});

describe('escaping', () => {
  const unsafe = (text: string): string[] => {
    const found: string[] = [];
    if (text.includes('<script>alert')) found.push('<script>');
    if (/<img[^>]*onerror/i.test(text)) found.push('<img onerror>');
    if (/href="javascript:/i.test(text)) found.push('javascript: href');
    if (/<!--[\s\S]*?kvarm_agt_/.test(text)) found.push('token in a comment');
    return found;
  };

  it('escapes stored titles, branches, agent names, families, review bodies, decisions and provenance fields', async () => {
    for (const path of ['/inbox', `/${OWNER}/core/changes/2`, `/${OWNER}/core/commit/${head}`]) {
      const r = await call(path, tok[OWNER]);
      expect(r.status, path).toBe(200);
      expect(unsafe(r.text), path).toEqual([]);
    }
    const page = await call(`/${OWNER}/core/changes/2`, tok[OWNER]);
    // Present, escaped: the hostile strings did render as text.
    expect(page.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&gt;&lt;img');
    for (const field of ['reason', 'chosen', 'rej', 'why', 'plain', 's', 'p', 'm', 'run', 'key', 'body']) expect(page.text, field).toContain(`${field}&lt;script&gt;`);
  });

  it('echoes no free text from the query string', async () => {
    const probe = 'Your-session-expired-call-555';
    for (const path of [`/inbox?error=${probe}`, `/inbox?error=${encodeURIComponent(XSS)}&item=${encodeURIComponent(XSS)}`, `/${OWNER}/core/changes/2?error=${probe}&done=${probe}`]) {
      const r = await call(path, tok[OWNER]);
      expect(r.status, path).toBe(200);
      expect(r.text, path).not.toContain(probe);
      expect(unsafe(r.text), path).toEqual([]);
    }
    // Names every object inherits are not outcomes.
    for (const done of ['constructor', 'toString', '__proto__']) {
      const r = await call(`/${OWNER}/core/changes/2?done=${done}`, tok[OWNER]);
      expect(r.text, done).not.toContain('class="k-note signal" role="status"');
      expect(r.text, done).not.toContain('[native code]');
    }
    const cursor = await call(`/inbox?cursor=${encodeURIComponent(XSS)}`, tok[OWNER]);
    expect(cursor.status).toBe(400);
    expect(unsafe(cursor.text)).toEqual([]);
  });

  it('shows the token prefix and principal to repository admins only, on both pages', async () => {
    await env.DB.prepare("INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, 'write', ?, ?, ?)")
      .bind(repoIds.core, ids['sx-stranger'], ids[OWNER], NOW, NOW)
      .run();
    for (const path of [`/${OWNER}/core/changes/2`, `/${OWNER}/core/commit/${head}`]) {
      const admin = await call(path, tok[OWNER]);
      expect(admin.text, path).toContain('kvarm_agt_sx01');
      const writer = await call(path, tok['sx-stranger']);
      expect(writer.status, path).toBe(200);
      expect(writer.text, path).not.toContain('kvarm_agt_');
      expect(writer.text, path).not.toContain('agent:sx-agent');
    }
  });
});
