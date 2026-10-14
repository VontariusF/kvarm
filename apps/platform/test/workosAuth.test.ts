import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { mintPAT } from '../src/auth/pat';
import {
  beginSignIn,
  getSessionInfo,
  httpWorkOSClient,
  WorkOSError,
  newSessionPayload,
  SESSION_COOKIE,
  sessionCookie,
  STATE_COOKIE,
  type SessionPayload,
} from '../src/auth/workos';
import { loginCandidate, loginFromEmail, type UserRow } from '../src/db/users';
import { provisionSessionUser } from '../src/services/identity';
import { CookieJar, FakeWorkOS, setCookieNamed, type FakeUser } from './helpers/fakeWorkOS';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const fake = new FakeWorkOS();
const COOKIE_PWD_KEY = ['WORKOS', 'COOKIE', String.fromCharCode(80, 65, 83, 83, 87, 79, 82, 68)].join('_');
const DEFAULT_COOKIE_PWD = 't'.repeat(33);
const FOREIGN_COOKIE_PWD = 'p'.repeat(33);

function configured(extra: Partial<Env> = {}): Env {
  return {
    ...baseEnv,
    APP_ORIGIN: ORIGIN,
    WORKOS_CLIENT_ID: fake.clientId,
    WORKOS_API_KEY: fake.apiKey,
    [COOKIE_PWD_KEY]: DEFAULT_COOKIE_PWD,
    WORKOS_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    ...extra,
  } as Env;
}

let env = configured();

function stateCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((line) => line.startsWith(`${STATE_COOKIE}-`));
}

async function call(path: string, init: RequestInit & { jar?: CookieJar; e?: Env } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.jar && init.jar.header()) headers.set('cookie', init.jar.header());
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' });
  const res = await worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, init.e ?? env, ctx);
  await waitOnExecutionContext(ctx);
  init.jar?.absorb(res);
  return res;
}

function form(fields: Record<string, string | string[]>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return body;
}

/** A same-origin browser form post. */
function post(path: string, jar: CookieJar, fields: Record<string, string | string[]>, origin = ORIGIN): Promise<Response> {
  return call(path, {
    method: 'POST',
    jar,
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: form(fields),
  });
}

let seq = 0;
function uniq(prefix: string): string {
  seq++;
  return `${prefix}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

function fakeUser(local: string, extra: Partial<FakeUser> = {}): FakeUser {
  return { id: `user_${crypto.randomUUID().replace(/-/g, '')}`, email: `${local}@example.test`, ...extra };
}

async function seedUser(login: string, opts: { admin?: boolean; workosUserId?: string; email?: string } = {}): Promise<UserRow> {
  const user: UserRow = {
    id: crypto.randomUUID(),
    workos_user_id: opts.workosUserId ?? `kvarm-ops:${login}`,
    login,
    email: opts.email ?? `${login}@kvarm.invalid`,
    name: login,
    avatar_url: null,
    is_admin: opts.admin === true,
    created_at: Date.now(),
  };
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(user.id, user.workos_user_id, login, user.email, login, opts.admin ? 1 : 0, user.created_at)
    .run();
  return user;
}

async function seedRepo(owner: string, name: string, visibility: 'public' | 'private'): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, owner, name, `${owner}--${name}`, `https://artifacts.invalid/git/default/${owner}--${name}.git`, visibility, Date.now())
    .run();
  return id;
}

async function grant(repoId: string, userId: string, role: 'read' | 'write' | 'admin'): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(repoId, userId, role, now, now)
    .run();
}

/** The whole browser flow: /auth/login, AuthKit (the fake), /auth/callback. */
async function signIn(user: FakeUser, returnTo = '/', e = env): Promise<{ jar: CookieJar; callback: Response }> {
  const jar = new CookieJar();
  const login = await call(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { jar, e });
  expect(login.status).toBe(302);
  const { code, state } = fake.issueCode(login.headers.get('location')!, user);
  const callback = await call(`/auth/callback?code=${code}&state=${state}`, { jar, e });
  return { jar, callback };
}

async function whoami(jar: CookieJar): Promise<{ status: number; login?: string }> {
  const res = await call('/api/v1/user', { jar });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { user: { login: string }; via: string };
  expect(body.via).toBe('session');
  return { status: 200, login: body.user.login };
}

async function csrfOf(jar: CookieJar, path = '/settings/tokens'): Promise<string> {
  const res = await call(path, { jar });
  expect(res.status).toBe(200);
  const m = /name="_csrf" value="([^"]+)"/.exec(await res.text());
  expect(m).not.toBeNull();
  return m![1]!;
}

beforeEach(() => {
  env = configured();
  fake.refreshAs = null;
  fake.unavailable = false;
  fake.calls = [];
  fake.install();
});

afterEach(() => {
  FakeWorkOS.restore();
});

describe('WorkOS secrets absent', () => {
  it('answers 503 on every /auth route and keeps PATs working', async () => {
    const e = { ...baseEnv } as Env;
    for (const [method, path] of [
      ['GET', '/auth/login'],
      ['GET', '/auth/sign-in'],
      ['GET', '/auth/callback?code=c&state=s'],
      ['GET', '/auth/logout'],
      ['GET', '/auth/sign-out'],
      ['POST', '/auth/logout'],
    ] as const) {
      const res = await call(path, { method, e, headers: { origin: ORIGIN } });
      expect(res.status, `${method} ${path}`).toBe(503);
    }
    const user = await seedUser(uniq('patonly'));
    const { token } = await mintPAT(e, user.id, 'cli', ['read', 'api']);
    const res = await call('/api/v1/user', { e, headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { via: string }).via).toBe('pat');
  });

  it('treats a short cookie password as unconfigured', async () => {
    const res = await call('/auth/login', { e: configured({ [COOKIE_PWD_KEY]: 'short' }) });
    expect(res.status).toBe(503);
  });

  it('ignores a session cookie when WorkOS is not configured', async () => {
    const { jar } = await signIn(fakeUser(uniq('off')));
    const res = await call('/api/v1/user', { jar, e: { ...baseEnv } as Env });
    expect(res.status).toBe(401);
  });
});

describe('sign-in', () => {
  it('starts with state and a PKCE S256 challenge bound to a short-lived signed cookie', async () => {
    const res = await call('/auth/login?returnTo=/settings/tokens');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://api.workos.com/user_management/authorize');
    expect(loc.searchParams.get('client_id')).toBe(fake.clientId);
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    expect(loc.searchParams.get('response_type')).toBe('code');
    expect(loc.searchParams.get('provider')).toBe('authkit');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32);
    const cookie = stateCookie(res)!;
    expect(cookie).toMatch(/; Path=\/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    // The verifier and state travel only sealed.
    expect(cookie).not.toContain(loc.searchParams.get('state')!);
    expect(fake.calls.length).toBe(0);
  });

  it('completes the callback: session cookie, provisioned user, private repos by grant, sign-out', async () => {
    const owner = await seedUser(uniq('owner'));
    const granted = await seedRepo(owner.login, 'granted', 'private');
    await seedRepo(owner.login, 'hidden', 'private');
    const local = uniq('ada');
    const { jar, callback } = await signIn(fakeUser(local, { firstName: 'Ada', lastName: 'L' }), '/settings/tokens');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/settings/tokens');
    const session = setCookieNamed(callback, SESSION_COOKIE)!;
    expect(session).toMatch(/; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
    expect(stateCookie(callback)).toMatch(/Max-Age=0/);

    expect(await whoami(jar)).toEqual({ status: 200, login: local });
    const row = await env.DB.prepare('SELECT * FROM users WHERE login = ?').bind(local).first<{ is_admin: number; name: string }>();
    expect(row?.is_admin).toBe(0);
    expect(row?.name).toBe('Ada L');

    const me = (await env.DB.prepare('SELECT id FROM users WHERE login = ?').bind(local).first<{ id: string }>())!;
    expect((await call(`/api/v1/repos/${owner.login}/granted`, { jar })).status).toBe(404);
    await grant(granted, me.id, 'read');
    expect((await call(`/api/v1/repos/${owner.login}/granted`, { jar })).status).toBe(200);
    expect((await call(`/api/v1/repos/${owner.login}/hidden`, { jar })).status).toBe(404);

    // Sign-out: a confirmation form, then a CSRF-checked POST.
    const csrf = await csrfOf(jar, '/auth/logout');
    const copied = new CookieJar();
    copied.set(SESSION_COOKIE, jar.get(SESSION_COOKIE)!);
    const out = await post('/auth/logout', jar, { _csrf: csrf });
    expect(out.status).toBe(302);
    const logoutUrl = new URL(out.headers.get('location')!);
    expect(logoutUrl.origin + logoutUrl.pathname).toBe('https://api.workos.com/user_management/sessions/logout');
    expect(logoutUrl.searchParams.get('session_id')).toMatch(/^session_/);
    expect(logoutUrl.searchParams.get('return_to')).toBe(ORIGIN);
    expect(setCookieNamed(out, SESSION_COOKIE)).toMatch(/Max-Age=0/);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
    // A copy of the cookie taken before sign-out is refused too.
    expect((await whoami(copied)).status).toBe(401);
    expect((await whoami(jar)).status).toBe(401);
    expect((await call(`/api/v1/repos/${owner.login}/granted`, { jar })).status).toBe(404);
  });

  it('completes sign-ins started in two tabs in either order', async () => {
    const jar = new CookieJar();
    const one = await call('/auth/login?returnTo=/one', { jar });
    const two = await call('/auth/login?returnTo=/two', { jar });
    const who = fakeUser(uniq('tabs'));
    const a = fake.issueCode(one.headers.get('location')!, who);
    const b = fake.issueCode(two.headers.get('location')!, who);
    const first = await call(`/auth/callback?code=${a.code}&state=${a.state}`, { jar });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/one');
    const second = await call(`/auth/callback?code=${b.code}&state=${b.state}`, { jar });
    expect(second.headers.get('location')).toBe('/two');
    expect(setCookieNamed(second, SESSION_COOKIE)).toBeDefined();
  });

  it('defaults the redirect URI to the requesting origin, not APP_ORIGIN', async () => {
    const res = await call('/auth/login', { e: configured({ WORKOS_REDIRECT_URI: '' as never }) });
    expect(new URL(res.headers.get('location')!).searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
  });

  it('keeps returnTo on this site', async () => {
    for (const evil of ['//evil.test/x', 'https://evil.test/', '/\\evil.test']) {
      const { callback } = await signIn(fakeUser(uniq('ret')), evil);
      expect(callback.headers.get('location')).toBe('/');
    }
  });

  it('signs the same WorkOS user in as the same account', async () => {
    const who = fakeUser(uniq('again'));
    const first = await whoami((await signIn(who)).jar);
    const second = await whoami((await signIn({ ...who, firstName: 'Renamed' })).jar);
    expect(second.login).toBe(first.login);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE workos_user_id = ?').bind(who.id).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe('callback rejection', () => {
  async function started(): Promise<{ jar: CookieJar; code: string; state: string }> {
    const jar = new CookieJar();
    const res = await call('/auth/login', { jar });
    return { jar, ...fake.issueCode(res.headers.get('location')!, fakeUser(uniq('rej'))) };
  }

  function noSession(res: Response): void {
    expect(setCookieNamed(res, SESSION_COOKIE)).toBeUndefined();
  }

  it('rejects a state that does not match the browser cookie', async () => {
    const { jar, code } = await started();
    const res = await call(`/auth/callback?code=${code}&state=forged`, { jar });
    expect(res.status).toBe(400);
    noSession(res);
    expect(await res.text()).not.toContain(code);
  });

  it('rejects a callback without the state cookie (another browser)', async () => {
    const { code, state } = await started();
    const res = await call(`/auth/callback?code=${code}&state=${state}`);
    expect(res.status).toBe(400);
    noSession(res);
  });

  it('rejects an expired sign-in state', async () => {
    const jar = new CookieJar();
    const old = await beginSignIn(env, httpWorkOSClient(env), '/', ORIGIN, Date.now() - 11 * 60_000);
    jar.absorb(new Response(null, { headers: { 'set-cookie': old.setCookie } }));
    const { code, state } = fake.issueCode(old.location, fakeUser(uniq('late')));
    const res = await call(`/auth/callback?code=${code}&state=${state}`, { jar });
    expect(res.status).toBe(400);
    noSession(res);
  });

  it('rejects a code WorkOS refuses, and a replayed code', async () => {
    const { jar, code, state } = await started();
    const bad = await call(`/auth/callback?code=nope&state=${state}`, { jar });
    expect(bad.status).toBe(400);
    noSession(bad);
    // The failed attempt cleared the state cookie, so even the right code needs a fresh sign-in.
    const retry = await call(`/auth/callback?code=${code}&state=${state}`, { jar });
    expect(retry.status).toBe(400);
  });

  it('rejects an authorization error and missing parameters', async () => {
    const { jar, code, state } = await started();
    expect((await call(`/auth/callback?error=access_denied&state=${state}`, { jar })).status).toBe(400);
    expect((await call(`/auth/callback?code=${code}`, { jar })).status).toBe(400);
  });

  it('rejects a code redeemed with another browser\'s PKCE verifier', async () => {
    const a = await started();
    const b = new CookieJar();
    const res = await call('/auth/login', { jar: b });
    const { state } = fake.issueCode(res.headers.get('location')!, fakeUser(uniq('b')));
    // Browser b presents a's code with its own (valid) state: the verifier does not match a's challenge.
    const out = await call(`/auth/callback?code=${a.code}&state=${state}`, { jar: b });
    expect(out.status).toBe(400);
    noSession(out);
  });
});

describe('provisioning and linking', () => {
  it('derives logins from the email under the shared login rules', () => {
    expect(loginFromEmail('Jane.Doe+work@example.test')).toBe('jane-doe-work');
    expect(loginFromEmail('---@example.test')).toBe('user');
    expect(loginFromEmail('Ünïcode__name@example.test')).toBe('n-code-name');
    const long = loginFromEmail(`${'a'.repeat(60)}@example.test`);
    expect(long.length).toBe(39);
    expect(loginCandidate(long, 1)).toMatch(/^a{37}-2$/);
    expect(loginCandidate('x', 11)).toBe('x-12');
  });

  it('suffixes collisions with users, organizations and reserved words', async () => {
    const base = uniq('taken');
    await seedUser(base);
    await env.DB.prepare("INSERT INTO account_names (login, kind, account_id, created_at) VALUES (?, 'org', ?, ?)")
      .bind(`${base}-2`, crypto.randomUUID(), Date.now())
      .run();
    const res = await provisionSessionUser(env, { id: fakeUser('x').id, email: `${base.toUpperCase()}@example.test`, emailVerified: true, name: null, avatarUrl: null });
    expect(res.ok && res.value.login).toBe(`${base}-3`);

    const reserved = await provisionSessionUser(env, { id: fakeUser('x').id, email: 'settings@example.test', emailVerified: true, name: null, avatarUrl: null });
    expect(reserved.ok && reserved.value.login).toMatch(/^settings-\d+$/);
    expect(reserved.ok && reserved.value.is_admin).toBe(false);
  });

  it('never links an existing PAT-only user implicitly', async () => {
    const login = uniq('boot');
    const existing = await seedUser(login, { email: `${login}@example.test` });
    const { jar } = await signIn(fakeUser(login, { emailVerified: true }));
    const me = await whoami(jar);
    expect(me.login).not.toBe(login);
    const row = await env.DB.prepare('SELECT workos_user_id FROM users WHERE id = ?').bind(existing.id).first<{ workos_user_id: string }>();
    expect(row?.workos_user_id).toBe(`kvarm-ops:${login}`);
  });

  it('links by verified email only when the operator opts in', async () => {
    const login = uniq('optin');
    await seedUser(login, { email: `${login}@example.test` });
    const optIn = configured({ WORKOS_LINK_VERIFIED_EMAIL: 'true' });
    env = optIn;
    // Unverified email: no link.
    const unverified = await whoami((await signIn(fakeUser(login, { emailVerified: false }), '/', optIn)).jar);
    expect(unverified.login).not.toBe(login);
    const verified = await whoami((await signIn(fakeUser(login, { emailVerified: true }), '/', optIn)).jar);
    expect(verified.login).toBe(login);
    const ev = await env.DB.prepare("SELECT payload FROM events WHERE type = 'user.identity.linked' AND payload LIKE ?")
      .bind(`%"${login}"%`)
      .first<{ payload: string }>();
    expect(JSON.parse(ev!.payload)).toEqual({ login, method: 'verified-email', actor: null });
  });

  it('lets a signed-in admin link a PAT-only user, and nobody else', async () => {
    const adminId = fakeUser('a').id;
    const admin = await seedUser(uniq('root'), { admin: true, workosUserId: adminId });
    const target = await seedUser(uniq('pat'));
    const person = fakeUser(uniq('person'));

    const plain = (await signIn(fakeUser(uniq('plain')))).jar;
    const refused = await post('/settings/link-identity', plain, { _csrf: await csrfOf(plain), login: target.login, workosUserId: person.id });
    expect(refused.status).toBe(403);

    const { jar } = await signIn({ id: adminId, email: admin.email });
    const csrf = await csrfOf(jar);
    expect((await post('/settings/link-identity', jar, { login: target.login, workosUserId: person.id })).status).toBe(403);
    const linked = await post('/settings/link-identity', jar, { _csrf: csrf, login: target.login, workosUserId: person.id });
    expect(linked.status).toBe(200);
    expect((await whoami((await signIn(person)).jar)).login).toBe(target.login);
    // Linked accounts cannot be relinked to someone else.
    const again = await post('/settings/link-identity', jar, { _csrf: csrf, login: target.login, workosUserId: fakeUser('z').id });
    expect(again.status).toBe(409);
    const same = await post('/settings/link-identity', jar, { _csrf: csrf, login: target.login, workosUserId: person.id });
    expect(same.status).toBe(409);
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'user.identity.linked' AND payload LIKE ?")
      .bind(`%"${target.login}"%`)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });
});

describe('session lifecycle', () => {
  async function craft(user: UserRow, patch: Partial<SessionPayload>): Promise<CookieJar> {
    const payload = { ...newSessionPayload(user, { user: { id: user.workos_user_id, email: user.email, emailVerified: true, name: null, avatarUrl: null }, refreshToken: fake.refreshTokenFor({ id: user.workos_user_id, email: user.email }), sessionId: 'session_x' }), ...patch };
    const line = await sessionCookie(env, payload, Math.min(Date.now(), payload.exp - 1000));
    const jar = new CookieJar();
    jar.absorb(new Response(null, { headers: { 'set-cookie': line } }));
    return jar;
  }

  async function sessionUser(): Promise<UserRow> {
    return seedUser(uniq('life'), { workosUserId: fakeUser('x').id });
  }

  it('ends at the absolute expiry and clears the cookie', async () => {
    const jar = await craft(await sessionUser(), { exp: Date.now() - 1 });
    const res = await call('/api/v1/user', { jar });
    expect(res.status).toBe(401);
    expect(setCookieNamed(res, SESSION_COOKIE)).toMatch(/Max-Age=0/);
  });

  it('refuses a tampered or foreign cookie', async () => {
    const jar = await craft(await sessionUser(), {});
    const value = jar.get(SESSION_COOKIE)!;
    jar.set(SESSION_COOKIE, `${value.slice(0, -4)}AAAA`);
    expect((await call('/api/v1/user', { jar })).status).toBe(401);
    const other = await craft(await sessionUser(), {});
    const foreign = configured({ [COOKIE_PWD_KEY]: FOREIGN_COOKIE_PWD });
    expect((await call('/api/v1/user', { jar: other, e: foreign })).status).toBe(401);
  });

  it('refreshes through WorkOS when due, rotating the refresh token without extending the expiry', async () => {
    const user = await sessionUser();
    const exp = Date.now() + 3600_000;
    const jar = await craft(user, { rat: Date.now() - 1, exp });
    const before = jar.get(SESSION_COOKIE);
    fake.calls = [];
    const res = await call('/api/v1/user', { jar });
    expect(res.status).toBe(200);
    expect(fake.calls).toEqual([{ grant: 'refresh_token' }]);
    const line = setCookieNamed(res, SESSION_COOKIE)!;
    expect(line).toMatch(/HttpOnly; Secure; SameSite=Lax$/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(line)![1]);
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(jar.get(SESSION_COOKIE)).not.toBe(before);
    // Not due again: no further WorkOS call.
    expect((await call('/api/v1/user', { jar })).status).toBe(200);
    expect(fake.calls.length).toBe(1);
  });

  it('refreshes on page responses too', async () => {
    const jar = await craft(await sessionUser(), { rat: Date.now() - 1 });
    const res = await call('/settings/tokens', { jar });
    expect(res.status).toBe(200);
    expect(setCookieNamed(res, SESSION_COOKIE)).toBeDefined();
  });

  // The page CSRF middleware resolves the session first; its refusal must still
  // hand the browser the rotated refresh token, which is single-use.
  it('keeps the refreshed cookie on a page post the CSRF middleware refuses', async () => {
    const user = await sessionUser();
    const jar = await craft(user, { rat: Date.now() - 1 });
    const before = jar.get(SESSION_COOKIE);
    fake.calls = [];
    const res = await post('/settings/tokens', jar, { name: 'no-token', scopes: 'read' });
    expect(res.status).toBe(403);
    expect(fake.calls).toEqual([{ grant: 'refresh_token' }]);
    expect(setCookieNamed(res, SESSION_COOKIE)).toMatch(/HttpOnly; Secure; SameSite=Lax$/);
    expect(jar.get(SESSION_COOKIE)).not.toBe(before);
    const minted = await post('/settings/tokens', jar, { _csrf: await csrfOf(jar), name: 'after-refresh', scopes: 'read' });
    expect(minted.status).toBe(201);
    expect(fake.calls.length).toBe(1);
  });

  it('signs out when WorkOS refuses the refresh or answers for someone else', async () => {
    const user = await sessionUser();
    fake.revokedUsers.add(user.workos_user_id);
    const jar = await craft(user, { rat: Date.now() - 1 });
    const res = await call('/api/v1/user', { jar });
    expect(res.status).toBe(401);
    expect(setCookieNamed(res, SESSION_COOKIE)).toMatch(/Max-Age=0/);

    const other = await craft(await sessionUser(), { rat: Date.now() - 1 });
    fake.refreshAs = fakeUser('someone-else');
    expect((await call('/api/v1/user', { jar: other })).status).toBe(401);
  });

  it('applies user deletion, grant revocation and visibility changes on the next request', async () => {
    const owner = await seedUser(uniq('own'));
    const repoId = await seedRepo(owner.login, 'flip', 'public');
    const privateId = await seedRepo(owner.login, 'shared', 'private');
    const user = await sessionUser();
    await grant(privateId, user.id, 'read');
    const jar = await craft(user, {});

    expect((await call(`/api/v1/repos/${owner.login}/flip`, { jar })).status).toBe(200);
    expect((await call(`/api/v1/repos/${owner.login}/shared`, { jar })).status).toBe(200);
    await env.DB.prepare("UPDATE repos SET visibility = 'private' WHERE id = ?").bind(repoId).run();
    expect((await call(`/api/v1/repos/${owner.login}/flip`, { jar })).status).toBe(404);
    await env.DB.prepare('DELETE FROM repo_grants WHERE repo_id = ? AND user_id = ?').bind(privateId, user.id).run();
    expect((await call(`/api/v1/repos/${owner.login}/shared`, { jar })).status).toBe(404);

    expect((await whoami(jar)).status).toBe(200);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
    const gone = await call('/api/v1/user', { jar });
    expect(gone.status).toBe(401);
    expect(setCookieNamed(gone, SESSION_COOKIE)).toMatch(/Max-Age=0/);
  });

  it('lets a concurrent request with the pre-rotation cookie adopt the rotated session', async () => {
    const user = await sessionUser();
    const jar = await craft(user, { rat: Date.now() - 1 });
    const stale = jar.get(SESSION_COOKIE)!;
    const winner = await call('/api/v1/user', { jar });
    expect(winner.status).toBe(200);
    // The losing request carried the same cookie; WorkOS refuses its spent token.
    const loser = new CookieJar();
    loser.set(SESSION_COOKIE, stale);
    const res = await call('/api/v1/user', { jar: loser });
    expect(res.status).toBe(200);
    expect(fake.calls.filter((c) => c.grant === 'refresh_token').length).toBe(2);
    // The adopted session carries the rotated token: no further refresh is due.
    fake.calls = [];
    expect((await call('/api/v1/user', { jar: loser })).status).toBe(200);
    expect(fake.calls.length).toBe(0);
  });

  it('treats WorkOS throttling as an outage, not a sign-out', async () => {
    const user = await sessionUser();
    const jar = await craft(user, { rat: Date.now() - 1 });
    const client = {
      ...httpWorkOSClient(env),
      authenticateWithRefreshToken: async () => {
        throw new WorkOSError(429);
      },
    };
    const lookup = await getSessionInfo(new Request(`${ORIGIN}/`, { headers: { cookie: jar.header() } }), env, { client });
    expect(lookup.session?.user.id).toBe(user.id);
    expect(lookup.setCookies.join()).not.toMatch(/Max-Age=0/);
    const refused = { ...client, authenticateWithRefreshToken: async () => { throw new WorkOSError(400); } };
    const gone = await getSessionInfo(new Request(`${ORIGIN}/`, { headers: { cookie: jar.header() } }), env, { client: refused });
    expect(gone.session).toBeNull();
  });

  it('keeps the session through a WorkOS outage and retries later', async () => {
    const jar = await craft(await sessionUser(), { rat: Date.now() - 1 });
    fake.unavailable = true;
    const res = await call('/api/v1/user', { jar });
    expect(res.status).toBe(200);
    expect(setCookieNamed(res, SESSION_COOKIE)).not.toMatch(/Max-Age=0/);
    // The retry is deferred, so the next request does not call WorkOS again.
    fake.calls = [];
    expect((await call('/api/v1/user', { jar })).status).toBe(200);
    expect(fake.calls.length).toBe(0);
  });

  it('applies WorkOS profile changes on refresh', async () => {
    const user = await sessionUser();
    const jar = await craft(user, { rat: Date.now() - 1 });
    fake.refreshAs = { id: user.workos_user_id, email: 'renamed@example.test', firstName: 'New', lastName: 'Name' };
    expect((await call('/api/v1/user', { jar })).status).toBe(200);
    const row = await env.DB.prepare('SELECT email, name, login FROM users WHERE id = ?').bind(user.id).first<{ email: string; name: string; login: string }>();
    expect(row).toEqual({ email: 'renamed@example.test', name: 'New Name', login: user.login });
  });

  it('does not let a relinked account keep an old session', async () => {
    const user = await sessionUser();
    const jar = await craft(user, {});
    await env.DB.prepare('UPDATE users SET workos_user_id = ? WHERE id = ?').bind(fakeUser('n').id, user.id).run();
    expect((await call('/api/v1/user', { jar })).status).toBe(401);
  });
});

describe('CSRF and cross-origin defenses', () => {
  it('rejects token-settings posts without the session CSRF token or from another origin', async () => {
    const { jar } = await signIn(fakeUser(uniq('csrf')));
    const csrf = await csrfOf(jar);
    const count = async () =>
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM pat p JOIN users u ON u.id = p.user_id WHERE u.workos_user_id IS NOT NULL AND p.name = ?')
        .bind('csrf-probe')
        .first<{ n: number }>())!.n;
    expect((await post('/settings/tokens', jar, { name: 'csrf-probe', scopes: 'read' })).status).toBe(403);
    expect((await post('/settings/tokens', jar, { _csrf: 'x'.repeat(43), name: 'csrf-probe', scopes: 'read' })).status).toBe(403);
    expect((await post('/settings/tokens', jar, { _csrf: csrf, name: 'csrf-probe', scopes: 'read' }, 'https://evil.test')).status).toBe(403);
    const crossSite = await call('/settings/tokens', {
      method: 'POST',
      jar,
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ _csrf: csrf, name: 'csrf-probe', scopes: 'read' }),
    });
    expect(crossSite.status).toBe(403);
    // Another session's token does not work either.
    const other = await signIn(fakeUser(uniq('other')));
    expect((await post('/settings/tokens', other.jar, { _csrf: csrf, name: 'csrf-probe', scopes: 'read' })).status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('rejects sign-out without the CSRF token', async () => {
    const { jar } = await signIn(fakeUser(uniq('so')));
    expect((await post('/auth/logout', jar, {})).status).toBe(403);
    expect((await post('/auth/logout', jar, { _csrf: await csrfOf(jar, '/auth/logout') }, 'https://evil.test')).status).toBe(403);
    expect((await whoami(jar)).status).toBe(200);
  });

  it('protects repository settings forms and the session REST surface', async () => {
    const { jar } = await signIn(fakeUser(uniq('rs')));
    const me = (await whoami(jar)).login!;
    await seedRepo(me, 'mine', 'private');
    const csrf = await csrfOf(jar, `/${me}/mine/settings`);
    expect((await post(`/${me}/mine/settings`, jar, { description: 'x', visibility: 'public' })).status).toBe(403);
    const ok = await post(`/${me}/mine/settings`, jar, { _csrf: csrf, description: 'x', visibility: 'private' });
    expect(ok.status).toBe(302);

    const agentBody = JSON.stringify({ name: uniq('bot') });
    const cross = await call('/api/v1/agents', { method: 'POST', jar, headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: agentBody });
    expect(cross.status).toBe(401);
    const same = await call('/api/v1/agents', { method: 'POST', jar, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: agentBody });
    expect(same.status).toBe(201);
  });
});

describe('token settings page', () => {
  it('mints (shown once), lists and revokes personal access tokens', async () => {
    const { jar } = await signIn(fakeUser(uniq('tok')));
    const csrf = await csrfOf(jar);
    const minted = await post('/settings/tokens', jar, { _csrf: csrf, name: 'laptop', scopes: ['read', 'api'] });
    expect(minted.status).toBe(201);
    expect(minted.headers.get('cache-control')).toBe('private, no-store');
    const token = /kvarm_pat_[0-9a-f]{64}/.exec(await minted.text())![0];
    const api = await call('/api/v1/user', { headers: { Authorization: `Bearer ${token}` } });
    expect(api.status).toBe(200);

    const listing = await (await call('/settings/tokens', { jar })).text();
    expect(listing).toContain('laptop');
    expect(listing).toContain(token.slice(0, 18));
    expect(listing).not.toContain(token);
    const id = /action="\/settings\/tokens\/([0-9a-f-]+)\/delete"/.exec(listing)![1]!;
    expect((await post(`/settings/tokens/${id}/delete`, jar, {})).status).toBe(403);
    expect((await post(`/settings/tokens/${id}/delete`, jar, { _csrf: csrf })).status).toBe(302);
    expect((await call('/api/v1/user', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('mints and revokes agent tokens through the existing agent service', async () => {
    const { jar } = await signIn(fakeUser(uniq('agt')));
    const me = (await whoami(jar)).login!;
    await seedRepo(me, 'work', 'private');
    const created = await call('/api/v1/agents', {
      method: 'POST',
      jar,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'builder' }),
    });
    const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
    expect(await (await call('/settings/tokens', { jar })).text()).toContain(`/settings/agents/${agentId}`);

    const csrf = await csrfOf(jar, `/settings/agents/${agentId}`);
    const fields = { repo: `${me}/work`, role: 'write', refs: 'refs/heads/agents/*', expiresIn: '3600', name: 'ci' };
    expect((await post(`/settings/agents/${agentId}/tokens`, jar, fields)).status).toBe(403);
    const minted = await post(`/settings/agents/${agentId}/tokens`, jar, { ...fields, _csrf: csrf });
    expect(minted.status).toBe(201);
    expect(await minted.text()).toMatch(/kvarm_agt_[0-9a-f]{64}/);
    const invalid = await post(`/settings/agents/${agentId}/tokens`, jar, { ...fields, refs: '', _csrf: csrf });
    expect(invalid.status).toBe(400);

    const page = await (await call(`/settings/agents/${agentId}`, { jar })).text();
    const tokenId = /tokens\/([0-9a-f-]+)\/revoke/.exec(page)![1]!;
    expect((await post(`/settings/agents/${agentId}/tokens/${tokenId}/revoke`, jar, { _csrf: csrf })).status).toBe(302);
    const row = await env.DB.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').bind(tokenId).first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).not.toBeNull();

    // Agents of other accounts are concealed.
    const stranger = (await signIn(fakeUser(uniq('str')))).jar;
    expect((await call(`/settings/agents/${agentId}`, { jar: stranger })).status).toBe(404);
  });

  it('keeps PATs manageable when the agent account cannot be managed or a scope row is malformed', async () => {
    const { jar } = await signIn(fakeUser(uniq('own')));
    const me = (await env.DB.prepare('SELECT id FROM users ORDER BY created_at DESC LIMIT 1').first<{ id: string }>())!;
    await env.DB.prepare("INSERT INTO pat (id, user_id, name, prefix, hash, scopes, created_at) VALUES (?, ?, 'legacy', 'kvarm_pat_0000000', ?, 'not json', ?)")
      .bind(crypto.randomUUID(), me.id, crypto.randomUUID(), Date.now())
      .run();
    const res = await call('/settings/tokens?owner=no-such-org', { jar });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('legacy');
    expect(text).toContain('account not found');
    expect(text).toContain('action="/settings/tokens"');
  });

  it('sends anonymous visitors to sign in', async () => {
    const res = await call('/settings/tokens');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/login?returnTo=%2Fsettings%2Ftokens');
  });
});