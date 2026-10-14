/**
 * The session CSRF middleware for the HTML pages (routes/pageCsrf.ts,
 * architecture §11.1), through the Worker. The walk covers every mounted route
 * that can take an unsafe method, so a page form post added later without the
 * middleware fails here.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { newSessionPayload, sessionCookie, type SessionPayload } from '../src/auth/workos';
import { toUserRow } from '../src/db/users';
import worker, { platformRoutes } from '../src/index';
import { CSRF_REFUSED, csrfExempt, sessionCsrf } from '../src/routes/pageCsrf';
import { mintAgentToken } from '../src/services/agents';
import { RESERVED_LOGINS } from '../src/services/orgs';
import { fakeArtifacts } from './helpers/fakeArtifacts';

const ORIGIN = 'https://kvarm.test';
const OWNER = 'csrf-owner';
const REPO = 'guarded';
const UNSAFE = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * What is registered before the middleware: the git smart-HTTP gate (basic
 * auth, never a session form), the health check, static assets and session
 * cookie persistence. Any route added ahead of it would escape it.
 */
const BEFORE_GUARD = ['ALL /*', 'GET /healthz', 'ALL /assets/*', 'ALL /*'];

const env = {
  ...(cfEnv as unknown as Env),
  ARTIFACTS: fakeArtifacts,
  WORKOS_CLIENT_ID: 'client_fake',
  WORKOS_API_KEY: 'sk_fake_not_a_real_key',
  WORKOS_COOKIE_PASSWORD: 'test-cookie-password-0123456789abcdef',
} as Env;

let payload: SessionPayload;
let cookie = '';
let otherCsrf = '';
let strangerPat = '';
let agentId = '';

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `csrf:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function signedIn(userId: string): Promise<SessionPayload> {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<Parameters<typeof toUserRow>[0]>();
  return newSessionPayload(toUserRow(row!), {
    user: { id: row!.workos_user_id, email: row!.email, emailVerified: true, name: null, avatarUrl: null },
    refreshToken: 'rt_unused',
    sessionId: null,
  });
}

async function send(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, { ...init, redirect: 'manual' });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: await res.text() };
}

/** A same-origin browser request carrying the session cookie. */
const browser = (path: string, init: RequestInit) =>
  send(path, { ...init, headers: { cookie, origin: ORIGIN, ...(init.headers as Record<string, string>) } });

const urlencoded = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

function multipart(fields: Record<string, string>): RequestInit {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return { body };
}

/** Every row of every table: a refused post must leave all of it unchanged. */
async function dbFingerprint(): Promise<string> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name",
  ).all<{ name: string }>();
  const parts: string[] = [];
  for (const { name } of tables.results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    parts.push(`${name}:${JSON.stringify(rows.results)}`);
  }
  return parts.join('\n');
}

/** A concrete request path for a route pattern, aimed at the seeded repository. */
function concrete(pattern: string): string {
  return pattern
    .replace(/:owner(\{[^}]*\})?/g, OWNER)
    .replace(/:repo(\{[^}]*\})?/g, REPO)
    .replace(/:number(\{[^}]*\})?/g, '1')
    .replace(/:id(\{[^}]*\})?/g, agentId)
    .replace(/:(\w+)(\{[^}]*\})?\??/g, 'x')
    .replace(/\*/g, 'x');
}

const guardIndex = () => platformRoutes().findIndex((r) => r.handler === sessionCsrf);
const takesUnsafe = (method: string) => UNSAFE.includes(method) || method === 'ALL';

/** Every route behind the middleware that can take an unsafe method and is not exempt. */
const pageRoutes = () =>
  platformRoutes()
    .slice(guardIndex() + 1)
    .filter((r) => takesUnsafe(r.method) && !csrfExempt(concrete(r.path)));

const unsafeMethods = (method: string) => (method === 'ALL' ? UNSAFE : [method]);

beforeAll(async () => {
  const ownerId = await seedUser(OWNER);
  const strangerId = await seedUser('csrf-stranger');
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(crypto.randomUUID(), OWNER, REPO, `${OWNER}--${REPO}`, `https://artifacts.invalid/git/default/${OWNER}--${REPO}.git`, Date.now())
    .run();
  agentId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at) VALUES (?, 'user', ?, ?, 'csrf-agent', ?, ?)`,
  )
    .bind(agentId, ownerId, OWNER, ownerId, Date.now())
    .run();
  payload = await signedIn(ownerId);
  otherCsrf = (await signedIn(ownerId)).csrf;
  cookie = (await sessionCookie(env, payload)).split(';')[0]!;
  strangerPat = (await mintPAT(env, strangerId, 'csrf', ['read', 'write', 'api'])).token;
});

describe('page CSRF middleware: every page route (architecture §11.1)', () => {
  it('runs ahead of every router', () => {
    const guard = guardIndex();
    expect(guard).toBeGreaterThan(0);
    expect(platformRoutes().slice(0, guard).map((r) => `${r.method} ${r.path}`)).toEqual(BEFORE_GUARD);
  });

  it('exempts only the REST API, MCP and sign-out', () => {
    const exempt = platformRoutes()
      .filter((r) => takesUnsafe(r.method) && csrfExempt(concrete(r.path)))
      .map((r) => r.path);
    expect(exempt).toContain('/auth/logout');
    expect(exempt).toContain('/mcp');
    for (const path of exempt) expect(path === '/mcp' || path === '/auth/logout' || path.startsWith('/api/v1/'), path).toBe(true);
    for (const near of ['/api/v1x', '/api', '/auth/logout/', '/auth/logoutx', '/mcp/', '/x/api/v1/repos']) expect(csrfExempt(near), near).toBe(false);
  });

  // The exemption is by path, so a /:owner/:repo page whose owner were `api`,
  // `mcp` or `auth` would skip the middleware; only reserved logins prevent that.
  it('exempts no path an account can own', () => {
    for (const login of ['api', 'mcp', 'auth']) expect(RESERVED_LOGINS.has(login), login).toBe(true);
  });

  it('finds the page routers’ form posts', () => {
    const paths = pageRoutes().map((r) => `${r.method} ${r.path}`);
    // Spot checks that the walk sees each router; the list itself is not pinned.
    for (const expected of [
      'POST /new-repo',
      'POST /settings/tokens',
      'POST /fleet/approvals/:id',
      'POST /:owner/:repo/settings',
      'POST /:owner/:repo/issues',
      'POST /:owner/:repo/arenas/:id/select',
      'POST /:owner/:repo/environments',
      'POST /:owner/:repo/changes/:number/review',
      'POST /:owner/:repo/changes/:number/escalations/:id/resolve',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it('refuses a signed-in session post without _csrf with 403 and writes nothing, on every route', async () => {
    const before = await dbFingerprint();
    for (const route of pageRoutes()) {
      for (const method of unsafeMethods(route.method)) {
        const path = concrete(route.path);
        const res = await browser(path, { method, ...urlencoded({ description: 'pwned', name: 'pwned', visibility: 'public' }) });
        expect({ route: `${method} ${route.path}`, status: res.status, text: res.text }).toEqual({
          route: `${method} ${route.path}`,
          status: 403,
          text: CSRF_REFUSED,
        });
      }
    }
    expect(await dbFingerprint()).toBe(before);
  });

  it('refuses another session’s token the same way, on every route', async () => {
    const before = await dbFingerprint();
    for (const route of pageRoutes()) {
      for (const method of unsafeMethods(route.method)) {
        const res = await browser(concrete(route.path), { method, ...urlencoded({ _csrf: otherCsrf, description: 'pwned' }) });
        expect({ route: `${method} ${route.path}`, status: res.status }).toEqual({ route: `${method} ${route.path}`, status: 403 });
      }
    }
    expect(await dbFingerprint()).toBe(before);
  });

  it('does not refuse a bearer post for its missing _csrf, on every route', async () => {
    for (const route of pageRoutes()) {
      for (const method of unsafeMethods(route.method)) {
        const res = await send(concrete(route.path), {
          method,
          headers: { authorization: `Bearer ${strangerPat}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'description=x',
        });
        // It may fail later (the stranger can reach none of it); just not here.
        expect({ route: `${method} ${route.path}`, csrf: res.status === 403 && res.text === CSRF_REFUSED }).toEqual({
          route: `${method} ${route.path}`,
          csrf: false,
        });
      }
    }
  });
});

describe('page CSRF middleware: evasion attempts (architecture §11.1)', () => {
  const settings = `/${OWNER}/${REPO}/settings`;
  const refusedOrUnrouted = (res: { status: number }) => res.status === 403 || res.status === 404 || res.status === 405;

  it('refuses tokenless session writes whatever the method spelling or override hint', async () => {
    const before = await dbFingerprint();
    const body = urlencoded({ description: 'override' });
    for (const method of ['post', 'patch', 'Put', 'delete', 'PROPFIND']) {
      const res = await browser(settings, { method, ...body });
      expect({ method, ok: refusedOrUnrouted(res) }).toEqual({ method, ok: true });
    }
    for (const override of ['x-http-method-override', 'x-http-method', 'x-method-override']) {
      const res = await browser(settings, { method: 'POST', ...body, headers: { ...body.headers, [override]: 'GET' } });
      expect(res).toEqual({ status: 403, text: CSRF_REFUSED });
    }
    expect(await browser(settings, { method: 'POST', ...urlencoded({ _method: 'GET', description: 'override' }) })).toEqual({ status: 403, text: CSRF_REFUSED });
    for (const method of ['HEAD', 'OPTIONS']) expect((await browser(settings, { method })).text).not.toBe(CSRF_REFUSED);
    expect(await dbFingerprint()).toBe(before);
  });

  it('refuses tokenless session writes on paths that only look exempt or are spelled differently', async () => {
    const before = await dbFingerprint();
    for (const path of [
      `/api/v1/../${OWNER}/${REPO}/settings`,
      `/mcp/../${OWNER}/${REPO}/settings`,
      `/auth/logout/../../${OWNER}/${REPO}/settings`,
      `/%63srf-owner/${REPO}/settings`,
      `/${OWNER}/${REPO}/%73ettings`,
      `/${OWNER}/${REPO}/settings/`,
      `/${OWNER.toUpperCase()}/${REPO}/settings`,
      `/${OWNER}/${REPO}/settings?_csrf=${payload.csrf}`,
      '/api/v1x',
      '/%61pi/v1x',
      '/auth/logout/',
      '/mcp/',
    ]) {
      const res = await browser(path, { method: 'POST', ...urlencoded({ description: 'path trick', name: 'path-trick' }) });
      expect({ path, res }).toEqual({ path, res: { status: 403, text: CSRF_REFUSED } });
    }
    expect(await dbFingerprint()).toBe(before);
  });

  it('decodes the exempt prefix the way the router does: an encoded /api/v1 reaches the REST API, never a page', async () => {
    const res = await browser(`/%61pi/v1/repos/${OWNER}/${REPO}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.text).not.toBe(CSRF_REFUSED);
    expect(res.status).toBe(200);
  });

  it('accepts only a string token in the form body: not a file part, the query string or a non-form body', async () => {
    const before = await dbFingerprint();
    const file = new FormData();
    file.append('_csrf', new File([payload.csrf], 'token.txt', { type: 'text/plain' }));
    file.append('description', 'file token');
    expect(await browser(settings, { method: 'POST', body: file })).toEqual({ status: 403, text: CSRF_REFUSED });
    expect(
      await browser(`${settings}?_csrf=${payload.csrf}`, { method: 'POST', ...urlencoded({ description: 'query token' }) }),
    ).toEqual({ status: 403, text: CSRF_REFUSED });
    expect(
      await browser(settings, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `_csrf=${payload.csrf}&description=plain` }),
    ).toEqual({ status: 403, text: CSRF_REFUSED });
    const empty = await browser(settings, { method: 'POST', ...urlencoded({ _csrf: '', description: 'empty token' }) });
    expect(empty).toEqual({ status: 403, text: CSRF_REFUSED });
    expect(await dbFingerprint()).toBe(before);
  });

  it('accepts a real form whatever the content-type parameters or case', async () => {
    const res = await browser(settings, {
      method: 'POST',
      headers: { 'content-type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ _csrf: payload.csrf, description: 'charset form' }).toString(),
    });
    expect(res.status).toBe(302);
  });

  it('counts the session over a bearer token from the same origin, so the token is still required', async () => {
    const res = await browser(settings, {
      method: 'POST',
      ...urlencoded({ description: 'session plus bearer' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${strangerPat}` },
    });
    expect(res).toEqual({ status: 403, text: CSRF_REFUSED });
  });

  it('requires the token from a session whose browser omits Origin unless Fetch Metadata says cross-site', async () => {
    const before = await dbFingerprint();
    const bare = (headers: Record<string, string>) =>
      send(settings, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'description=bare' });
    for (const site of [undefined, 'same-origin', 'none']) {
      const res = await bare(site === undefined ? {} : { 'sec-fetch-site': site });
      expect({ site, res }).toEqual({ site, res: { status: 403, text: CSRF_REFUSED } });
    }
    // Not the session (requestCredential): anonymous on a private repository, so concealed.
    for (const headers of [{ 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }] as Record<string, string>[]) {
      expect((await bare(headers)).status).toBe(404);
    }
    expect(await dbFingerprint()).toBe(before);
  });

  it('passes an agent token without _csrf to the handler', async () => {
    const owner = await env.DB.prepare('SELECT * FROM users WHERE login = ?').bind(OWNER).first<Parameters<typeof toUserRow>[0]>();
    const minted = await mintAgentToken(env, { user: toUserRow(owner!), via: 'session', scopes: null }, agentId, {
      repo: `${OWNER}/${REPO}`,
      role: 'read',
      refs: null,
      expiresIn: 3600,
      name: null,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const res = await send(settings, {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.value.token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'description=agent',
    });
    expect(res.text).not.toBe(CSRF_REFUSED);
  });

  it('treats a revoked session cookie as no session: no token demanded, nothing written, the cookie cleared', async () => {
    const owner = await env.DB.prepare('SELECT id FROM users WHERE login = ?').bind(OWNER).first<{ id: string }>();
    const revoked = await signedIn(owner!.id);
    await env.DB.prepare('INSERT INTO session_revocations (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(revoked.jti, owner!.id, revoked.exp, Date.now())
      .run();
    const before = await dbFingerprint();
    const ctx = createExecutionContext();
    const res = await worker.fetch!(
      new Request(`${ORIGIN}${settings}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: (await sessionCookie(env, revoked)).split(';')[0]!, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: `_csrf=${revoked.csrf}&description=revoked`,
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie().some((line) => /Max-Age=0/.test(line))).toBe(true);
    expect(await dbFingerprint()).toBe(before);
  });

  // MCP is bearer-only (mcp/server.ts); a browser that also sends its session cookie is not held to the form token.
  it('leaves a same-origin MCP call that also carries the session cookie to the JSON surface', async () => {
    const res = await browser('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${strangerPat}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.text).not.toBe(CSRF_REFUSED);
    expect(res.status).toBeLessThan(400);
  });
});

describe('page CSRF middleware: bodies and credentials (architecture §11.1)', () => {
  const settings = `/${OWNER}/${REPO}/settings`;
  const description = async () =>
    (await env.DB.prepare('SELECT description FROM repos WHERE owner_login = ? AND name = ?').bind(OWNER, REPO).first<{ description: string | null }>())
      ?.description;

  it('passes a urlencoded post with the token, and the handler still reads its fields', async () => {
    const res = await browser(settings, { method: 'POST', ...urlencoded({ _csrf: payload.csrf, description: 'from urlencoded' }) });
    expect(res.status).toBe(302);
    expect(await description()).toBe('from urlencoded');
  });

  it('passes a multipart post with the token, and the handler still reads its fields', async () => {
    const res = await browser(settings, { method: 'POST', ...multipart({ _csrf: payload.csrf, description: 'from multipart' }) });
    expect(res.status).toBe(302);
    expect(await description()).toBe('from multipart');
  });

  it('refuses a multipart post without the token', async () => {
    const res = await browser(settings, { method: 'POST', ...multipart({ description: 'no token' }) });
    expect(res).toEqual({ status: 403, text: CSRF_REFUSED });
    expect(await description()).not.toBe('no token');
  });

  it('refuses an unparseable body with 403, not a 500', async () => {
    const before = await dbFingerprint();
    const broken = await browser(settings, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=nope' },
      body: `garbage _csrf=${payload.csrf}`,
    });
    expect(broken).toEqual({ status: 403, text: CSRF_REFUSED });
    const noBoundary = await browser(settings, { method: 'POST', headers: { 'content-type': 'multipart/form-data' }, body: 'x' });
    expect(noBoundary).toEqual({ status: 403, text: CSRF_REFUSED });
    const json = await browser(settings, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _csrf: payload.csrf, description: 'json' }),
    });
    expect(json).toEqual({ status: 403, text: CSRF_REFUSED });
    expect(await dbFingerprint()).toBe(before);
  });

  it('refuses a token from another session of the same user', async () => {
    const res = await browser(settings, { method: 'POST', ...urlencoded({ _csrf: otherCsrf, description: 'other session' }) });
    expect(res).toEqual({ status: 403, text: CSRF_REFUSED });
    expect(await description()).not.toBe('other session');
  });

  it('does not count a cross-origin session post as the session, as before', async () => {
    const res = await browser(settings, {
      method: 'POST',
      ...urlencoded({ description: 'cross-site' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    });
    // Anonymous on a private repository: concealed, never the CSRF refusal or a write.
    expect(res.status).toBe(404);
    expect(await description()).not.toBe('cross-site');
  });

  it('skips a bearer post that also sends a cookie from another origin', async () => {
    const res = await send(settings, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', authorization: `Bearer ${strangerPat}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'description=bearer',
    });
    expect(res.text).not.toBe(CSRF_REFUSED);
    expect(await description()).not.toBe('bearer');
  });

  it('leaves safe methods alone', async () => {
    const res = await browser(settings, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('refuses a repeated _csrf unless every value is the token', async () => {
    const twice = (a: string, b: string) => ({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `_csrf=${encodeURIComponent(a)}&_csrf=${encodeURIComponent(b)}&description=repeated`,
    });
    expect(await browser(settings, { method: 'POST', ...twice(payload.csrf, otherCsrf) })).toEqual({ status: 403, text: CSRF_REFUSED });
    expect(await browser(settings, { method: 'POST', ...twice(otherCsrf, payload.csrf) })).toEqual({ status: 403, text: CSRF_REFUSED });
    expect(await description()).not.toBe('repeated');
    expect((await browser(settings, { method: 'POST', ...twice(payload.csrf, payload.csrf) })).status).toBe(302);
    expect(await description()).toBe('repeated');
  });

  it('answers a tokened post to a path no route serves with 404, not a 500 over the read body', async () => {
    for (const path of ['/no-such-page', `/${OWNER}/${REPO}/no-such-page`]) {
      expect((await browser(path, { method: 'POST', ...urlencoded({ _csrf: payload.csrf }) })).status, path).toBe(404);
    }
  });

  it('answers a tokened post to a static asset as the assets binding answers any post, body already read or not', async () => {
    const anonymous = await send('/favicon.ico', { method: 'POST', ...urlencoded({ pad: 'x'.repeat(5000) }) });
    for (const init of [{ method: 'POST', ...urlencoded({ _csrf: payload.csrf, pad: 'x'.repeat(5000) }) }, { method: 'POST', ...multipart({ _csrf: payload.csrf }) }]) {
      expect((await browser('/favicon.ico', init)).status).toBe(anonymous.status);
    }
    expect(anonymous.status).toBe(405);
  });

  it('refuses before the handler runs: an unknown repository answers 403, not the handler’s 404', async () => {
    const res = await browser(`/${OWNER}/no-such-repo/settings`, { method: 'POST', ...urlencoded({ description: 'x' }) });
    expect(res).toEqual({ status: 403, text: CSRF_REFUSED });
  });

  it('leaves session REST writes to the same-origin rule, and unknown API paths still 404', async () => {
    const res = await browser(`/api/v1/repos/${OWNER}/${REPO}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'from the API' }),
    });
    expect(res.status).toBe(200);
    expect(await description()).toBe('from the API');
    const missing = await browser('/api/v1/no-such-endpoint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(missing.status).toBe(404);
  });

  // Last: it ends the session the other tests use.
  it('leaves /auth/logout to its own token check', async () => {
    expect(await browser('/auth/logout', { method: 'POST', ...urlencoded({}) })).toEqual({ status: 403, text: CSRF_REFUSED });
    expect((await browser('/auth/logout', { method: 'POST', ...urlencoded({ _csrf: payload.csrf }) })).status).toBe(302);
  });
});
