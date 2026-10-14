/**
 * The session CSRF check for every HTML page route (architecture §11.1).
 *
 * index.ts installs sessionCsrf once, ahead of every router, so a page form
 * post is covered wherever and whenever it is mounted; only the paths in
 * csrfExempt skip it. Handlers keep their own sessionFormRefused /
 * requireSessionForm checks as a second layer.
 */

import type { MiddlewareHandler } from 'hono';
import { csrfTokenValid, isSameOriginRequest, isUnsafeMethod } from '../auth/workos';
import { requestSession, type App } from './api';

export const CSRF_REFUSED = 'invalid or missing CSRF token';

/**
 * Paths that never take a session form post. The REST API and MCP take JSON
 * and count a session only from the same origin (requestCredential); a
 * session's JSON write there carries no form token. `/auth/logout` checks its
 * own token and must not refresh the session it is about to end, which
 * resolving the session here would do.
 */
export function csrfExempt(path: string): boolean {
  return path === '/api/v1' || path.startsWith('/api/v1/') || path === '/mcp' || path === '/auth/logout';
}

/**
 * Refuses an unsafe request authenticated by the session cookie, before any
 * handler, unless its form body carries the session's `_csrf` token. Which
 * credential a request presents follows requestCredential: a same-origin
 * session cookie wins, a cross-origin one does not count, and a request
 * without the cookie (a bearer PAT or agent token, never ambient) needs no
 * token. The parsed form stays cached on the request, so the handler reads it
 * again for free.
 */
export const sessionCsrf: MiddlewareHandler<App> = async (c, next) => {
  if (!isUnsafeMethod(c.req.method) || csrfExempt(c.req.path)) return next();
  const session = await requestSession(c);
  if (!session || !isSameOriginRequest(c.req.raw, c.env)) return next();
  // A body that is not a form (JSON, text) parses to {} and fails for its
  // missing token; one that claims to be a form but is malformed throws.
  const form = (await c.req.parseBody({ all: true }).catch(() => null)) as Record<string, unknown> | null;
  // Handlers read a repeated field's first or last value; every one must be
  // the token, so no handler can pick a value this check did not accept.
  const submitted = form ? [form._csrf].flat() : [];
  if (submitted.length === 0 || !submitted.every((value) => csrfTokenValid(session, value))) return c.text(CSRF_REFUSED, 403);
  return next();
};
