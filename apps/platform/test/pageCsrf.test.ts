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
