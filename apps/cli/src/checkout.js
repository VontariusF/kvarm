// @ts-check
/**
 * `kvarm checkout <owner/repo> <ref> <dir>`: snapshot first, git clone second.
 *
 * 1. Ask for the snapshot. With a PAT this is the explicit demand
 *    (`POST …/snapshots/:ref`), which starts a lazy build for a ref that has
 *    none; without one it is a metadata read (anonymous callers cannot
 *    demand builds).
 * 2. If the snapshot is ready, download it by commit SHA (so a moving branch
 *    cannot swap the bytes), check the byte count and extract it.
 * 3. Otherwise (building, absent, failed, an API error or a bad download)
 *    clone with git and check out the ref.
 *
 * Exactly one `source: snapshot` or `source: clone` line is printed on
 * success. A snapshot directory has no `.git`: it is the tree only.
 */

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitEnv, runGit } from './git.js';
import { nodeFetch } from './http.js';
import { extractArchive } from './archive.js';

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * @typedef {object} CheckoutOptions
 * @property {string} baseUrl platform origin, e.g. https://kvarm.example.workers.dev
 * @property {string} [pat] personal access or agent token
 * @property {string} repo `owner/name`
 * @property {string} ref branch, tag or commit SHA
 * @property {string} dir destination directory (missing or empty)
 * @property {(line: string) => void} stdout
 * @property {(line: string) => void} stderr
 * @property {NodeJS.ProcessEnv} [env] environment for git children
 * @property {import('./http.js').HttpFetch} [fetch] defaults to node:http(s)
 * @property {import('./git.js').GitRunner} [git]
 * @property {string} [cloneUrl] overrides `<baseUrl>/<owner>/<name>.git`
 *
 * @typedef {object} CheckoutResult
 * @property {'snapshot' | 'clone'} source
 * @property {string} sha
 * @property {string} [reason] why the snapshot was not used
 * @property {number} [bytes] snapshot bytes downloaded
 * @property {number} [files]
 */

/** @param {string} repo */
export function parseRepo(repo) {
  const m = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(repo);
  if (!m) throw new CliError(`invalid repository "${repo}", expected <owner>/<repo>`, 2);
  return { owner: /** @type {string} */ (m[1]), name: /** @type {string} */ (m[2]) };
}

/** @param {string} ref */
function encodeRef(ref) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/**
 * @param {string} dir
 * @returns {boolean} whether the directory already existed (and is empty)
 */
function prepareDir(dir) {
  let st;
  try {
    st = statSync(dir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isDirectory()) throw new CliError(`destination ${dir} exists and is not a directory`);
  if (readdirSync(dir).length > 0) throw new CliError(`destination ${dir} already exists and is not empty`);
  return true;
}

/**
 * Removes what this run wrote: the directory itself when it was created
 * here, otherwise only its contents (it was empty before).
 * @param {string} dir
 * @param {boolean} existed
 */
function resetDir(dir, existed) {
  if (!existed) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
}

/**
 * @param {import('./http.js').HttpResponse} res
 * @returns {Promise<any>}
 */
async function jsonBody(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Requests snapshot metadata, demanding a build when a token is available.
 * @param {CheckoutOptions & { fetch: import('./http.js').HttpFetch }} o
 * @param {string} path
 * @returns {Promise<{ status: number, body: any, demanded: boolean } | { error: string }>}
 */
async function requestSnapshot(o, path) {
  const headers = { accept: 'application/json', ...(o.pat ? { authorization: `Bearer ${o.pat}` } : {}) };
  try {
    const res = await o.fetch(`${o.baseUrl}${path}`, { method: o.pat ? 'POST' : 'GET', headers });
    return { status: res.status, body: await jsonBody(res), demanded: Boolean(o.pat) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {CheckoutOptions & { fetch: import('./http.js').HttpFetch }} o
 * @param {string} path
 * @param {{ sha: string, size?: number }} meta
 * @param {string} dir
 */
async function downloadSnapshot(o, path, meta, dir) {
  const headers = o.pat ? { authorization: `Bearer ${o.pat}` } : undefined;
  const res = await o.fetch(`${o.baseUrl}${path}/download`, { headers });
  if (res.status !== 200 || !res.body) {
    const body = await jsonBody(res);
    throw new Error(`download returned ${res.status}${body?.code ? ` ${body.code}` : ''}`);
  }
  const servedSha = res.headers.get('x-kvarm-snapshot-sha');
  if (servedSha && servedSha !== meta.sha) {
    discard(res.body);
    throw new Error(`download served ${servedSha}, expected ${meta.sha}`);
  }
  const result = await extractArchive(res.body, dir);
  if (typeof meta.size === 'number' && result.bytes !== meta.size) {
    throw new Error(`downloaded ${result.bytes} bytes, metadata size is ${meta.size}`);
  }
  return result;
}

/**
 * Stops a response body without reading it (web stream or Node stream).
 * @param {any} body
 */
function discard(body) {
  if (typeof body?.cancel === 'function') body.cancel().catch(() => {});
  else if (typeof body?.destroy === 'function') body.destroy();
}

/**
 * @param {CheckoutOptions & { git: import('./git.js').GitRunner }} o
 * @param {string} url
 * @param {string} dir
 */
async function cloneCheckout(o, url, dir) {
  const env = gitEnv(o.env ?? process.env, { baseUrl: o.baseUrl, pat: o.pat });
  const clone = await o.git(['clone', '-q', '--no-checkout', url, dir], { env });
  if (clone.code !== 0) throw new CliError(`git clone failed: ${clone.stderr || `exit ${clone.code}`}`);
  const target = o.ref.startsWith('refs/heads/') ? o.ref.slice('refs/heads/'.length) : o.ref;
  const co = await o.git(['checkout', '-q', target], { cwd: dir, env });
  if (co.code !== 0) throw new CliError(`git checkout ${o.ref} failed: ${co.stderr || `exit ${co.code}`}`);
  const head = await o.git(['rev-parse', 'HEAD'], { cwd: dir, env });
  if (head.code !== 0) throw new CliError(`git rev-parse HEAD failed: ${head.stderr}`);
  return head.stdout;
}

/**
 * @param {any} meta
 * @param {boolean} demanded
 */
function describeNotReady(meta, demanded) {
  const state = meta?.state ?? 'unknown';
  const sha = typeof meta?.sha === 'string' ? ` for ${meta.sha.slice(0, 12)}` : '';
  if (state === 'building') return `snapshot building${sha}${demanded ? (meta.started ? ' (build started)' : ' (build in progress)') : ''}`;
  if (state === 'absent') return `snapshot absent${sha}${demanded ? '' : ' (set KVARM_PAT to request a build)'}`;
  if (state === 'failed') return `snapshot failed${sha}`;
  return `snapshot state ${state}${sha}`;
}

/**
 * @param {CheckoutOptions} options
 * @returns {Promise<CheckoutResult>}
 */
export async function checkout(options) {
  const o = { ...options, fetch: options.fetch ?? nodeFetch, git: options.git ?? runGit, baseUrl: options.baseUrl.replace(/\/+$/, '') };
  const { owner, name } = parseRepo(o.repo);
  if (!o.ref) throw new CliError('missing <ref>', 2);
  if (!o.dir) throw new CliError('missing <dir>', 2);
  const dir = resolve(o.dir);
  const existed = prepareDir(dir);
  const path = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/snapshots/${encodeRef(o.ref)}`;

  /** @type {string} */
  let reason;
  const meta = await requestSnapshot(o, path);
  if ('error' in meta) {
    reason = `snapshot API unreachable: ${meta.error}`;
  } else if (meta.status === 200 && meta.body?.state === 'ready' && typeof meta.body.sha === 'string') {
    try {
      const got = await downloadSnapshot(o, `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/snapshots/${meta.body.sha}`, meta.body, dir);
      o.stdout('source: snapshot');
      o.stdout(`sha: ${meta.body.sha}`);
      o.stdout(`files: ${got.files}`);
      o.stdout(`bytes: ${got.bytes}`);
      o.stderr(`note: ${o.dir} holds the tree only (no .git); see "kvarm help checkout" before committing or pushing`);
      return { source: 'snapshot', sha: meta.body.sha, bytes: got.bytes, files: got.files };
    } catch (err) {
      reason = `snapshot download failed: ${err instanceof Error ? err.message : String(err)}`;
      resetDir(dir, existed);
    }
  } else if (meta.status === 200 || meta.status === 202 || meta.status === 409) {
    reason = describeNotReady(meta.body, meta.demanded);
  } else if (meta.status === 401 || meta.status === 403) {
    reason = `snapshot API refused the token (${meta.status}${meta.body?.error ? ` ${meta.body.error}` : ''})`;
  } else {
    reason = `snapshot API returned ${meta.status}${meta.body?.error ? ` ${meta.body.error}` : ''}`;
  }

  o.stderr(`${reason}; falling back to git clone`);
  const url = o.cloneUrl ?? `${o.baseUrl}/${owner}/${name}.git`;
  let sha;
  try {
    sha = await cloneCheckout(o, url, dir);
  } catch (err) {
    resetDir(dir, existed);
    throw err;
  }
  o.stdout('source: clone');
  o.stdout(`sha: ${sha}`);
  return { source: 'clone', sha, reason };
}
