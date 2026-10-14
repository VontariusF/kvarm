/**
 * Generic web surface: landing/dashboard, repo creation + import, and the
 * token settings pages (PATs and agent tokens). Repository pages (tree, blob,
 * raw, commits, branches, settings) live in repoPages.ts and mount after these
 * routes at /:owner/:repo.
 *
 * Every state-changing form here is session-only and requires a same-origin
 * request plus the session's CSRF token (architecture §11.1). Token pages
 * reuse the existing token services; they add no token logic of their own.
 */

import { Hono, type Context } from 'hono';
import { html, raw, timeAgo } from '@kvarm/ui';
import { listReposForOwner } from '../db/repos';
import type { UserRow } from '../db/users';
import { csrfTokenValid, isSameOriginRequest, type SessionInfo } from '../auth/workos';
import { mintPAT, parseScopes, revokePAT, SCOPES, type Scope } from '../auth/pat';
import { csrfInput, layout } from '../web/render';
import { CSRF_REFUSED } from './pageCsrf';
import * as svc from '../repos/service';
import * as agents from '../services/agents';
import { linkWorkOSIdentity } from '../services/identity';
import type { Actor } from '../services/authz';
import { requestSession, type App } from './api';

export const web = new Hono<App>();

interface PageCtx {
  session: SessionInfo | null;
  user: UserRow | null;
}

/** Narrowed context for routes that require a signed-in session. */
interface AuthedPageCtx {
  session: SessionInfo;
  user: UserRow;
}

type FormValue = string | File | (string | File)[];
type Form = Record<string, FormValue>;

/** Agents listed per account on the settings page; the rest are paged. */
const SETTINGS_AGENT_LIMIT = 50;
/** Organizations offered in the account switcher. */
const SETTINGS_ORG_LIMIT = 50;
/** PATs listed on the settings page. */
const SETTINGS_PAT_LIMIT = 200;

async function pageCtx(c: Context<App>): Promise<PageCtx> {
  const session = await requestSession(c);
  return { session, user: session?.user ?? null };
}

function page(c: Context<App>, ctx: PageCtx, title: string, body: string, status = 200): Response {
  return new Response(layout(c.env, { title, userLogin: ctx.user?.login ?? null }, body), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function errorPage(c: Context<App>, ctx: PageCtx, error: string, back: string, status: number): Response {
  return page(c, ctx, 'Error', html`<div class="flash err">${error}</div><a href="${back}">back</a>`, status);
}

async function requireSessionPage(c: Context<App>): Promise<AuthedPageCtx | Response> {
  const ctx = await pageCtx(c);
  if (!ctx.session || !ctx.user) {
    return c.redirect(`/auth/login?returnTo=${encodeURIComponent(new URL(c.req.url).pathname)}`);
  }
  return ctx as AuthedPageCtx;
}

function first(v: FormValue | undefined): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' ? x : undefined;
}

function every(v: FormValue | undefined): string[] {
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === 'string');
}

/**
 * A session's state-changing form post: same-origin, signed in, and carrying
 * the session's synchronizer CSRF token. Returns the parsed form.
 */
async function requireSessionForm(c: Context<App>): Promise<{ ctx: AuthedPageCtx; form: Form } | Response> {
  if (!isSameOriginRequest(c.req.raw, c.env)) return c.text('cross-origin request refused', 403);
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const form = (await c.req.parseBody({ all: true }).catch(() => ({}))) as Form;
  if (!csrfTokenValid(ctx.session, first(form._csrf))) return c.text(CSRF_REFUSED, 403);
  return { ctx, form };
}

function sessionActor(ctx: AuthedPageCtx): Actor {
  return { user: ctx.user, via: 'session', scopes: null };
}

function iso(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

web.get('/', async (c) => {
  const ctx = await pageCtx(c);
  let body: string;
  if (!ctx.user) {
    body = html`
      <div class="card">
        <h1>${c.env.SITE_NAME || 'Kvarm'}</h1>
        <p class="muted">A git platform for the agentic era, on Cloudflare Artifacts.</p>
        <p><a class="btn primary" href="/auth/login">Sign in to get started</a></p>
      </div>
    `;
  } else {
    const repos = await listReposForOwner(c.env.DB, ctx.user.login);
    const rows = repos
      .map(
        (r) => html`
          <div class="repo-row">
            <div>
              <a href="/${r.owner_login}/${r.name}"><strong>${r.owner_login}/${r.name}</strong></a>
              <span class="badge">${r.visibility}</span>
              <div class="muted">${r.description ?? ''}</div>
            </div>
            <div class="muted">${r.pushed_at ? timeAgo(r.pushed_at) : 'never pushed'}</div>
          </div>
        `,
      )
      .join('');
    const csrf = raw(csrfInput(ctx.session?.csrfToken));
    body = html`
      <div class="card">
        <h2>New repository</h2>
        <form method="post" action="/new-repo">
          ${csrf}
          <label for="name">Name</label>
          <input id="name" name="name" type="text" required placeholder="my-project" />
          <label for="description">Description</label>
          <input id="description" name="description" type="text" placeholder="optional" />
          <label for="visibility">Visibility</label>
          <select id="visibility" name="visibility">
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
          <p><button class="btn primary" type="submit">Create</button></p>
        </form>
      </div>
      <div class="card">
        <h2>Import from HTTPS</h2>
        <form method="post" action="/import-repo">
          ${csrf}
          <label for="url">Remote URL</label>
          <input id="url" name="url" type="url" required placeholder="https://github.com/owner/repo" />
          <label for="iname">Name</label>
          <input id="iname" name="name" type="text" placeholder="defaults to remote name" />
          <p><button class="btn" type="submit">Import</button></p>
        </form>
      </div>
      <div class="card">
        <h2>Your repositories</h2>
        ${raw(rows || '<p class="muted">none yet</p>')}
      </div>
    `;
  }
  return page(c, ctx, 'Home', body);
});

web.post('/new-repo', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const result = await svc.createRepo(c.env, {
    ownerLogin: ctx.user.login,
    name: first(form.name) ?? '',
    description: first(form.description) || null,
    visibility: first(form.visibility) === 'public' ? 'public' : 'private',
  });
  if (!result.ok) return errorPage(c, ctx, result.error, '/', 400);
  return c.redirect(`/${result.value.owner_login}/${result.value.name}`);
});

web.post('/import-repo', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const url = first(form.url) ?? '';
  const result = await svc.importRepo(c.env, {
    ownerLogin: ctx.user.login,
    sourceUrl: url,
    name: first(form.name) || (url.split('/').pop() ?? ''),
    description: null,
  });
  if (!result.ok) return errorPage(c, ctx, result.error, '/', 400);
  return c.redirect(`/${result.value.owner_login}/${result.value.name}`);
});

// ---------------------------------------------------------------------------
// Token settings: personal access tokens and agent tokens
// ---------------------------------------------------------------------------

function shownOnce(c: Context<App>, ctx: AuthedPageCtx, what: string, token: string, back: string): Response {
  return page(
    c,
    ctx,
    'Token created',
    html`
      <div class="card">
        <div class="flash ok">${what} created. Copy it now: it will not be shown again.</div>
        <pre><code>${token}</code></pre>
        <p><a class="btn" href="${back}">Back</a></p>
      </div>
    `,
    201,
  );
}

web.get('/settings/tokens', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const owner = c.req.query('owner') || ctx.user.login;
  const [[pats, orgs], listed] = await Promise.all([
    c.env.DB.batch([
    c.env.DB.prepare(
      'SELECT id, name, prefix, scopes, created_at, last_used_at FROM pat WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).bind(ctx.user.id, SETTINGS_PAT_LIMIT),
    c.env.DB.prepare(
      `SELECT o.login FROM orgs o JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = ? AND m.role = 'owner' ORDER BY o.login LIMIT ?`,
    ).bind(ctx.user.id, SETTINGS_ORG_LIMIT),
    ]),
    // An account the user cannot manage only empties the agent section; PATs stay manageable.
    agents.listAgents(c.env, sessionActor(ctx), owner, { limit: SETTINGS_AGENT_LIMIT }),
  ]);
  const csrf = raw(csrfInput(ctx.session.csrfToken));

  type PatRow = { id: string; name: string; prefix: string; scopes: string; created_at: number; last_used_at: number | null };
  const patRows = ((pats?.results ?? []) as PatRow[])
    .map(
      (t) => html`
        <div class="repo-row">
          <div>
            <strong>${t.name}</strong>
            <code>${t.prefix}…</code>
            <div class="muted">${parseScopes(t.scopes).join(', ')}</div>
          </div>
          <div>
            <span class="muted">${t.last_used_at ? timeAgo(t.last_used_at) : 'never used'}</span>
            <form method="post" action="/settings/tokens/${t.id}/delete" style="display:inline">
              ${csrf}
              <button class="btn" type="submit">Revoke</button>
            </form>
          </div>
        </div>
      `,
    )
    .join('');
  const scopeBoxes = SCOPES.map(
    (s) => html`<label><input type="checkbox" name="scopes" value="${s}" ${s === 'ci' ? '' : 'checked'} /> ${s}</label>`,
  ).join('');
  const accounts = [ctx.user.login, ...((orgs?.results ?? []) as Array<{ login: string }>).map((o) => o.login)]
    .map((login) =>
      login === owner ? html`<strong>${login}</strong>` : html`<a href="/settings/tokens?owner=${encodeURIComponent(login)}">${login}</a>`,
    )
    .join(' · ');
  const agentRows = (listed.ok ? listed.value.agents : [])
    .map(
      (a) => html`
        <div class="repo-row">
          <div>
            <a href="/settings/agents/${a.id}"><strong>${a.owner_login}/${a.name}</strong></a>
            <span class="badge">${a.revoked_at === null ? 'active' : 'revoked'}</span>
            <div class="muted">${a.description ?? ''}</div>
          </div>
          <div><a class="btn" href="/settings/agents/${a.id}">Tokens</a></div>
        </div>
      `,
    )
    .join('');
  const more = !listed.ok
    ? html`<div class="flash err">${listed.error}</div>`
    : listed.value.nextCursor
      ? html`<p class="muted">More agents exist; use <code>kvarm agents list</code>.</p>`
      : '';
  const admin = ctx.user.is_admin
    ? html`
      <div class="card">
        <h2>Link an account to WorkOS</h2>
        <p class="muted">
          Instance admins only. Gives a PAT-only account (one created by <code>scripts/mint-pat.mjs</code>) a
          WorkOS identity, so that person signs in as that account instead of getting a new one.
        </p>
        <form method="post" action="/settings/link-identity">
          ${csrf}
          <label for="llogin">Login</label>
          <input id="llogin" name="login" type="text" required />
          <label for="lwid">WorkOS user id</label>
          <input id="lwid" name="workosUserId" type="text" required placeholder="user_…" />
          <p><button class="btn" type="submit">Link</button></p>
        </form>
      </div>`
    : '';

  return page(
    c,
    ctx,
    'Access tokens',
    html`
      <div class="card">
        <h2>Personal access tokens</h2>
        <p class="muted">
          Used for git over HTTPS (<code>git clone https://user:PAT@host/owner/repo.git</code>),
          the REST API (<code>Authorization: Bearer PAT</code>), and MCP.
        </p>
        <form method="post" action="/settings/tokens">
          ${csrf}
          <label for="tname">Token name</label>
          <input id="tname" name="name" type="text" required placeholder="laptop, ci-bot…" />
          <label>Scopes</label>
          ${raw(scopeBoxes)}
          <p><button class="btn primary" type="submit">Generate token</button></p>
        </form>
        ${raw(patRows || '<p class="muted">no tokens yet</p>')}
      </div>
      <div class="card">
        <h2>Agent tokens</h2>
        <p class="muted">Account: ${raw(accounts)}</p>
        <p class="muted">
          Agent tokens are minted per agent, scoped to one repository and expire. Create agents with
          <code>kvarm agents create</code> or <code>POST /api/v1/agents</code>.
        </p>
        ${raw(agentRows || (listed.ok ? '<p class="muted">no agents for this account</p>' : ''))}
        ${raw(more)}
      </div>
      ${raw(admin)}
    `,
  );
});

web.post('/settings/tokens', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const scopes = every(form.scopes).filter((s): s is Scope => SCOPES.includes(s as Scope));
  if (scopes.length === 0) return errorPage(c, ctx, 'choose at least one scope', '/settings/tokens', 400);
  const minted = await mintPAT(c.env, ctx.user.id, (first(form.name) || 'token').slice(0, 100), scopes);
  return shownOnce(c, ctx, 'Personal access token', minted.token, '/settings/tokens');
});

web.post('/settings/tokens/:id/delete', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  await revokePAT(c.env, c.req.param('id'), posted.ctx.user.id);
  return c.redirect('/settings/tokens');
});

web.get('/settings/agents/:id', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const actor = sessionActor(ctx);
  // Both calls check manageability themselves, so they can run together.
  const [agent, tokens] = await Promise.all([
    agents.getAgent(c.env, actor, c.req.param('id')),
    agents.listAgentTokens(c.env, actor, c.req.param('id')),
  ]);
  if (!agent.ok) return errorPage(c, ctx, agent.error, '/settings/tokens', agent.status);
  if (!tokens.ok) return errorPage(c, ctx, tokens.error, '/settings/tokens', tokens.status);
  const a = agent.value;
  const csrf = raw(csrfInput(ctx.session.csrfToken));
  const now = Date.now();
  const rows = tokens.value
    .map((row) => {
      const t = agents.agentTokenJson(row, now);
      const revoke =
        t.status === 'active'
          ? html`<form method="post" action="/settings/agents/${a.id}/tokens/${t.id}/revoke" style="display:inline">
              ${csrf}<button class="btn" type="submit">Revoke</button></form>`
          : '';
      return html`
        <div class="repo-row">
          <div>
            <strong>${t.name ?? 'token'}</strong> <code>${t.prefix}…</code>
            <span class="badge">${t.status}</span>
            <div class="muted">${t.repo} · ${t.role}${t.refs.length ? ` · ${t.refs.join(', ')}` : ''} · expires ${t.expiresAt ?? ''}</div>
          </div>
          <div><span class="muted">last used ${t.lastUsedAt ?? 'never'}</span> ${raw(revoke)}</div>
        </div>
      `;
    })
    .join('');
  const mintForm =
    a.revoked_at === null
      ? html`
        <form method="post" action="/settings/agents/${a.id}/tokens">
          ${csrf}
          <label for="aname">Token name</label>
          <input id="aname" name="name" type="text" placeholder="optional" />
          <label for="arepo">Repository (owner/name)</label>
          <input id="arepo" name="repo" type="text" required placeholder="${a.owner_login}/project" />
          <label for="arole">Role</label>
          <select id="arole" name="role">
            <option value="read">read</option>
            <option value="write">write</option>
          </select>
          <label for="arefs">Ref patterns (write tokens; separated by spaces or commas)</label>
          <input id="arefs" name="refs" type="text" placeholder="refs/heads/agents/*" />
          <label for="attl">Expires in</label>
          <select id="attl" name="expiresIn">
            <option value="3600">1 hour</option>
            <option value="86400">1 day</option>
            <option value="604800">7 days</option>
            <option value="2592000">30 days</option>
          </select>
          <p><button class="btn primary" type="submit">Mint agent token</button></p>
        </form>`
      : html`<p class="muted">This agent is revoked (${iso(a.revoked_at)}); it cannot receive tokens.</p>`;
  return page(
    c,
    ctx,
    `Agent ${a.name}`,
    html`
      <div class="card">
        <h2>${a.owner_login}/${a.name}</h2>
        <p class="muted">${a.description ?? ''}</p>
        ${raw(mintForm)}
      </div>
      <div class="card">
        <h2>Tokens</h2>
        ${raw(rows || '<p class="muted">no tokens yet</p>')}
      </div>
      <p><a href="/settings/tokens?owner=${encodeURIComponent(a.owner_login)}">back to tokens</a></p>
    `,
  );
});

web.post('/settings/agents/:id/tokens', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const id = c.req.param('id');
  const refs = every(form.refs)
    .flatMap((v) => v.split(/[\s,]+/))
    .filter((r) => r.length > 0);
  const ttl = Number(first(form.expiresIn));
  const minted = await agents.mintAgentToken(c.env, sessionActor(ctx), id, {
    repo: first(form.repo) ?? '',
    role: first(form.role) ?? '',
    refs,
    expiresIn: Number.isFinite(ttl) && first(form.expiresIn) ? ttl : undefined,
    name: first(form.name) || null,
  });
  if (!minted.ok) return errorPage(c, ctx, minted.error, `/settings/agents/${id}`, minted.status);
  return shownOnce(c, ctx, 'Agent token', minted.value.token, `/settings/agents/${id}`);
});

web.post('/settings/agents/:id/tokens/:tokenId/revoke', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx } = posted;
  const id = c.req.param('id');
  const res = await agents.revokeAgentToken(c.env, sessionActor(ctx), id, c.req.param('tokenId'));
  if (!res.ok) return errorPage(c, ctx, res.error, `/settings/agents/${id}`, res.status);
  return c.redirect(`/settings/agents/${id}`);
});

web.post('/settings/link-identity', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const res = await linkWorkOSIdentity(c.env, sessionActor(ctx), (first(form.login) ?? '').trim(), (first(form.workosUserId) ?? '').trim());
  if (!res.ok) return errorPage(c, ctx, res.error, '/settings/tokens', res.status);
  return page(
    c,
    ctx,
    'Account linked',
    html`<div class="card"><div class="flash ok">${res.value.login} now signs in through WorkOS.</div>
      <p><a class="btn" href="/settings/tokens">Back</a></p></div>`,
  );
});
