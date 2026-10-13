/**
 * Snapshot routes under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/snapshots.ts; the shared authority lookup runs before any ref
 * resolution, cache lookup, D1 row or R2 read, so a repo that turned private
 * is concealed (404) from then on.
 *
 *   GET  snapshots/:ref            metadata: 200 ready, 202 building/absent, 409 failed, 404 unknown
 *   GET  snapshots/:ref/download   the tarball (gzip for new snapshots, plain tar for legacy
 *                                  ones; see tarResponse): a repo-scoped Cache API hit for the commit
 *                                  (no snapshot row, no R2), else streamed from R2 (one
 *                                  class-B read) and stored in the cache in step
 *   POST snapshots/:ref            explicit demand (checkout/CI): builds a missing snapshot
 *
 * `:ref` is a branch, tag or full commit SHA and may contain "/". A trailing
 * "/download" always selects the download; a ref whose name ends in
 * "/download" is reachable by its SHA.
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import { withLazyRepo } from '../../artifacts/repo';
import { matchSnapshot, streamAndStore } from '../../cache/snapshot';
import type { RepoRow } from '../../db/repos';
import { FORMAT_HTTP, formatOfKey, type SnapshotFormat } from '../../snapshotFormat';
import { isFullSha, type ResolveContext } from '../../services/refs';
import {
  RefStoreUnavailable,
  commitExists,
  demandSnapshot,
  isReady,
  readSnapshot,
  resolveSnapshotRef,
  snapshotView,
} from '../../services/snapshots';

export const snapshotsApi = new Hono<App>();

const PREFIX = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/snapshots\/(.+)$/;
const DOWNLOAD = '/download';

function parseRef(c: Context<App>): { ref: string; download: boolean } | null {
  const m = PREFIX.exec(new URL(c.req.url).pathname);
  if (!m) return null;
  let rest: string;
  try {
    rest = decodeURIComponent(m[3]!);
  } catch {
    return null;
  }
  if (rest.endsWith(DOWNLOAD)) return { ref: rest.slice(0, -DOWNLOAD.length), download: true };
  return { ref: rest, download: false };
}

function notFound(c: Context<App>): Response {
  return c.json({ error: 'snapshot not found', code: 'NOT_FOUND' }, 404);
}

function unavailable(c: Context<App>): Response {
  return c.json({ error: 'ref store unavailable', code: 'UPSTREAM_UNAVAILABLE' }, 503);
}

function demandPath(repo: RepoRow, ref: string): string {
  return `/api/v1/repos/${repo.owner_login}/${repo.name}/snapshots/${ref}`;
}

function resolveContext(c: Context<App>, repo: RepoRow, artifacts: ResolveContext['artifacts']): ResolveContext {
  return { env: c.env, repo, artifacts, bypass: false, waitUntil: (p) => c.executionCtx.waitUntil(p) };
}

snapshotsApi.get('/repos/:owner/:repo/snapshots/*', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const parsed = parseRef(c);
  if (!parsed || parsed.ref.length === 0) return notFound(c);
  const repo = d.repo;

  return withLazyRepo(c.env, repo.artifacts_name, async (artifacts) => {
    const ctx = resolveContext(c, repo, artifacts);
    let sha: string | null;
    try {
      sha = await resolveSnapshotRef(ctx, parsed.ref);
    } catch (err) {
      if (err instanceof RefStoreUnavailable) return unavailable(c);
      throw err;
    }
    if (!sha) return notFound(c);
    if (parsed.download) {
      const cached = await matchSnapshot(repo.id, sha);
      if (cached) return tarResponse(c, repo, sha, cached.tree, cached.size, cached.format, cached.body);
    }
    const row = await readSnapshot(c.env, repo.id, sha);
    if (!row && isFullSha(parsed.ref) && !(await commitExists(ctx, sha))) return notFound(c);

    if (!parsed.download) {
      const view = snapshotView(parsed.ref, sha, row, demandPath(repo, parsed.ref));
      return actorJson(c, view.body, view.status);
    }
    if (!isReady(row)) {
      const state = row?.state ?? 'absent';
      return c.json({ error: 'snapshot is not ready', code: 'SNAPSHOT_NOT_READY', state, sha }, 409);
    }
    const object = await c.env.SNAPSHOTS.get(row.r2_key);
    if (!object) return c.json({ error: 'snapshot bytes missing', code: 'SNAPSHOT_MISSING', sha }, 409);
    const tree = row.tree ?? sha;
    const format = formatOfKey(row.r2_key);
    const body = streamAndStore(c.executionCtx, repo.id, sha, tree, object, format);
    return tarResponse(c, repo, sha, tree, object.size, format, body);
  });
});

/**
 * A gzip snapshot is served as the archive it is (`application/gzip`, a
 * `.tar.gz` filename) with no Content-Encoding: that header would make fetch
 * and `curl --compressed` silently unwrap it and leave `content-length`
 * describing bytes the client never sees. Legacy uncompressed snapshots keep
 * `application/x-tar`. `x-kvarm-snapshot-format` names the form; the CLI
 * relies on the gzip magic bytes, not on any header.
 */
function tarResponse(
  c: Context<App>,
  repo: RepoRow,
  sha: string,
  tree: string,
  size: number,
  format: SnapshotFormat,
  body: ReadableStream<Uint8Array>,
): Response {
  const http = FORMAT_HTTP[format];
  const res = new Response(body, {
    headers: {
      'content-type': http.contentType,
      'content-length': String(size),
      'content-disposition': `attachment; filename="${repo.name}-${sha.slice(0, 12)}.${http.extension}"`,
      'x-kvarm-snapshot-format': format,
      etag: `"${tree}"`,
      'cache-control': 'no-store',
      'x-kvarm-snapshot-sha': sha,
    },
  });
  for (const cookie of c.get('refreshCookies') ?? []) res.headers.append('Set-Cookie', cookie);
  return res;
}

snapshotsApi.post('/repos/:owner/:repo/snapshots/*', async (c) => {
  // Demand starts background work, so it needs an identified caller (a
  // person or an agent/CI token) with read access.
  const d = await authorizeRoute(c, 'read', { requireActor: true, allowAgent: true });
  if (!d.ok) return denyJson(c, d);
  const parsed = parseRef(c);
  if (!parsed || parsed.download || parsed.ref.length === 0) return notFound(c);
  const repo = d.repo;

  return withLazyRepo(c.env, repo.artifacts_name, async (artifacts) => {
    const ctx = resolveContext(c, repo, artifacts);
    let sha: string | null;
    try {
      sha = await resolveSnapshotRef(ctx, parsed.ref, { fresh: true });
    } catch (err) {
      if (err instanceof RefStoreUnavailable) return unavailable(c);
      throw err;
    }
    if (!sha) return notFound(c);
    if (isFullSha(parsed.ref) && !(await commitExists(ctx, sha))) return notFound(c);
    const { row, started, startError } = await demandSnapshot(c.env, repo.id, sha);
    if (startError) {
      return actorJson(c, { ref: parsed.ref, sha, error: startError, code: 'SNAPSHOT_START_FAILED', started: false }, 503);
    }
    const view = snapshotView(parsed.ref, sha, row, demandPath(repo, parsed.ref));
    return actorJson(c, { ...view.body, started: started !== null }, view.status);
  });
});
