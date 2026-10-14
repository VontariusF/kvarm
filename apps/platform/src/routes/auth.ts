/**
 * WorkOS AuthKit routes (architecture §11.1). Thin adapters over
 * auth/workos.ts and services/identity.ts. Without the WorkOS secrets every
 * route answers 503 and personal access tokens remain the way in.
 *
 *   GET  /auth/login     (alias /auth/sign-in)  start sign-in: state + PKCE
 *   GET  /auth/callback                         finish sign-in, set the session cookie
 *   GET  /auth/logout    (alias /auth/sign-out) confirmation form
 *   POST /auth/logout                           CSRF-checked sign-out
 */

import { Hono, type Context } from 'hono';
import { html } from '@kvarm/ui';
import {
  authConfigured,
  beginSignIn,
  clearSessionCookie,
  clearStateCookies,
  csrfTokenValid,
  getSessionInfo,
  httpWorkOSClient,
  isSameOriginRequest,
  newSessionPayload,
  pendingSignIn,
  revokeSession,
  sessionCookie,
} from '../auth/workos';
import { provisionSessionUser } from '../services/identity';
import { layout } from '../web/render';
import { CSRF_REFUSED } from './pageCsrf';

export const authRoutes = new Hono<{ Bindings: Env }>();

type C = Context<{ Bindings: Env }>;

/** 503 with setup guidance when WorkOS secrets are absent. */
function unconfigured(c: C): Response | null {
  if (!authConfigured(c.env)) {
    return c.text(
      'auth is not configured: set WORKOS_CLIENT_ID, WORKOS_API_KEY and WORKOS_COOKIE_PASSWORD (32+ characters) ' +
        '(see apps/platform/.dev.vars.example)',
      503,
    );
  }
  return null;
}

function redirect(location: string, cookies: string[]): Response {
  const res = new Response(null, { status: 302, headers: { Location: location } });
  for (const cookie of cookies) res.headers.append('Set-Cookie', cookie);
  return res;
}

function htmlPage(c: C, title: string, body: string, status: number, cookies: string[] = []): Response {
  const res = new Response(layout(c.env, { title }, body), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  for (const cookie of cookies) res.headers.append('Set-Cookie', cookie);
  return res;
}

function signInFailed(c: C, state: string | undefined, status = 400): Response {
  return htmlPage(
    c,
    'Sign-in failed',
    html`<div class="card"><div class="flash err">Sign-in could not be completed.</div>
      <p><a class="btn primary" href="/auth/login">Try again</a></p></div>`,
    status,
    clearStateCookies(state),
  );
}

async function login(c: C): Promise<Response> {
  const bail = unconfigured(c);
  if (bail) return bail;
  const { location, setCookie } = await beginSignIn(
    c.env,
    httpWorkOSClient(c.env),
    c.req.query('returnTo') ?? '/',
    new URL(c.req.url).origin,
  );
  return redirect(location, [setCookie]);
}

authRoutes.get('/login', login);
authRoutes.get('/sign-in', login);

authRoutes.get('/callback', async (c) => {
  const bail = unconfigured(c);
  if (bail) return bail;
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state || c.req.query('error')) return signInFailed(c, state);
  const pending = await pendingSignIn(c.req.raw, c.env, state);
  if (!pending) return signInFailed(c, state);
  let auth;
  try {
    auth = await httpWorkOSClient(c.env).authenticateWithCode({ code, codeVerifier: pending.verifier });
  } catch {
    return signInFailed(c, state);
  }
  let user;
  try {
    user = await provisionSessionUser(c.env, auth.user);
  } catch {
    return signInFailed(c, state, 500);
  }
  if (!user.ok) return signInFailed(c, state, user.status);
  // One clock reading, so Max-Age is exactly the session lifetime.
  const now = Date.now();
  const session = await sessionCookie(c.env, newSessionPayload(user.value, auth, now), now);
  return redirect(pending.returnTo, [...clearStateCookies(state), session]);
});

async function logoutForm(c: C): Promise<Response> {
  const bail = unconfigured(c);
  if (bail) return bail;
  const { session, setCookies } = await getSessionInfo(c.req.raw, c.env);
  if (!session) return redirect('/', setCookies);
  return htmlPage(
    c,
    'Sign out',
    html`<div class="card">
      <h2>Sign out of ${session.user.login}?</h2>
      <form method="post" action="/auth/logout">
        <input type="hidden" name="_csrf" value="${session.csrfToken}" />
        <p><button class="btn primary" type="submit">Sign out</button> <a class="btn" href="/">Cancel</a></p>
      </form>
    </div>`,
    200,
    setCookies,
  );
}

authRoutes.get('/logout', logoutForm);
authRoutes.get('/sign-out', logoutForm);

authRoutes.post('/logout', async (c) => {
  const bail = unconfigured(c);
  if (bail) return bail;
  if (!isSameOriginRequest(c.req.raw, c.env)) return c.text('cross-origin request refused', 403);
  // No refresh: the session is about to end, so redeeming its token is wasted.
  const { session } = await getSessionInfo(c.req.raw, c.env, { refresh: false });
  if (!session) return redirect('/', [clearSessionCookie()]);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  if (!csrfTokenValid(session, form._csrf)) return c.text(CSRF_REFUSED, 403);
  await revokeSession(c.env, session);
  // Ending the WorkOS session too keeps the next sign-in from silently reusing it.
  const location = session.sessionId
    ? httpWorkOSClient(c.env).logoutUrl({ sessionId: session.sessionId, returnTo: new URL(c.req.url).origin })
    : '/';
  return redirect(location, [clearSessionCookie()]);
});
