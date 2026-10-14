/**
 * Fleet pages: repository environments (definitions, builds, rebuilds) and the
 * signed-in user's sandboxes across repositories, with command approvals and
 * the command audit log. SSR only; every mutation is a plain form post that
 * the environments and sandboxes services authorize (architecture §0.6). A
 * session's post also carries its CSRF token (architecture §11.1).
 */

import { Hono, type Context } from 'hono';
import { html, raw, timeAgo } from '@kvarm/ui';
import type { RepoRow } from '../db/repos';
import { listReposForOwner } from '../db/repos';
import { clientIp, requestCredential, requestSession, type ApiActor, type App as ApiApp } from './api';
import { sessionFormRefused } from './repoPages';
import { appLayout, csrfInput } from '../web/render';
import { resolveRepoAccess } from '../services/access';
import { getRepo } from '../db/repos';
import * as environments from '../services/environments';
import * as sandboxes from '../services/sandboxes';
import type { EnvironmentBuildView, EnvironmentView } from '../services/environments';
import type { SandboxApprovalView, SandboxCommandView, SandboxView } from '../services/sandboxes';

type App = ApiApp;

/** Mounted at `/:owner/:repo`, ahead of the repo page router. */
export const fleetRepoPages = new Hono<App>();
/** Mounted at `/fleet`, ahead of the generic web routes. */
export const fleetPages = new Hono<App>();

const INSTANCES = ['basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'] as const;

interface Resolved {
  repo: RepoRow;
  viewer: ApiActor | null;
  role: string;
}

function finish(c: Context<App>, res: Response): Response {
  for (const cookie of c.get('refreshCookies') ?? []) res.headers.append('Set-Cookie', cookie);
  return res;
}

function htmlResponse(c: Context<App>, body: string, status = 200): Response {
  return finish(c, new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }));
}

function notFound(c: Context<App>): Response {
  return finish(c, new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }));
}

async function resolveRepo(c: Context<App>): Promise<Resolved | null> {
  const owner = c.req.param('owner');
  const name = c.req.param('repo');
  if (!owner || !name) return null;
  const access = await resolveRepoAccess(c.env, {
    owner,
    name,
    need: 'read',
    transport: 'page',
    credential: await requestCredential(c),
    clientIp: clientIp(c),
    rejectedCredentialAsAnonymous: true,
  });
  if (!access.ok) return null;
  return { repo: access.repo, viewer: access.actor, role: access.role };
}

async function sessionActor(c: Context<App>): Promise<ApiActor | null> {
  const credential = await requestCredential(c);
  return credential.kind === 'session' ? credential.actor : null;
}

/** The session's hidden CSRF field for this page's forms; empty for a bearer caller. */
async function csrfField(c: Context<App>): Promise<string> {
  return csrfInput((await requestSession(c))?.csrfToken);
}

/**
 * The posted form, or the 403 for a session post without its CSRF token
 * (architecture §11.1). Handlers read their form only through here, before
 * any write, so a new handler cannot skip the check by reading the body itself.
 */
async function postedForm(c: Context<App>, viewer: ApiActor): Promise<Record<string, unknown> | Response> {
  const form = await readForm(c);
  return (await sessionFormRefused(c, viewer, form)) ?? form;
}

/**
 * postedForm for handlers that use no form fields: a bearer post's body is
 * never read, so these routes accept any body from it as they did before.
 */
async function csrfRefused(c: Context<App>, viewer: ApiActor): Promise<Response | null> {
  return viewer.via === 'session' ? sessionFormRefused(c, viewer, await readForm(c)) : null;
}

/** An unparseable body reads as an empty form, which a session post then fails for its missing token. */
async function readForm(c: Context<App>): Promise<Record<string, unknown>> {
  return ((await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>);
}

/** A same-origin Referer to return to; a missing, foreign or malformed one falls back to `/fleet`. */
function sameOriginReferer(c: Context<App>): string {
  const back = c.req.header('referer');
  if (!back || !URL.canParse(back)) return '/fleet';
  return new URL(back).origin === new URL(c.req.url).origin ? back : '/fleet';
}

function sandboxContext(c: Context<App>, repo: RepoRow, actor: ApiActor | null): sandboxes.SandboxContext {
  return {
    env: c.env,
    repo,
    actor,
    origin: new URL(c.req.url).origin,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
}

function repoBase(repo: RepoRow): string {
  return `/${repo.owner_login}/${repo.name}`;
}

function pill(status: string): string {
  return html`<span class="tag tag-${status}">${status}</span>`;
}

function shortSandboxId(id: string): string {
  const withoutPrefix = id.replace(/^sandbox[-_]/i, '');
  const shortened = (withoutPrefix || id).slice(0, 8);
  return shortened.replace(/[-_]+$/, '') || shortened;
}

function agentIdentity(agentId: string, agentName: string | null): string {
  const name = agentName?.trim() || agentId;
  return html`<span class="k-agent-label m-human" title="${name}">${name}</span><span class="k-agent-label k-mono m-agent" title="${agentId}">${agentId}</span>`;
}

function ago(iso: string | null): string {
  return iso ? timeAgo(Date.parse(iso)) : '—';
}

function lines(value: unknown): string[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function flash(message: string | undefined, kind: 'ok' | 'err' = 'err'): string {
  return message ? html`<div class="k-note ${kind === 'err' ? 'risk' : 'signal'}">${message}</div>` : '';
}

function repoTabHref(repo: RepoRow, tab: string): string {
  const base = repoBase(repo);
  switch (tab) {
    case 'commits':
      return `${base}/commits?ref=${encodeURIComponent(repo.default_branch)}`;
    case 'branches':
      return `${base}/branches`;
    case 'compare':
      return `${base}/compare`;
    case 'activity':
      return `${base}/activity`;
    case 'train':
      return `${base}/train`;
    case 'settings':
      return `${base}/settings`;
    case 'environments':
      return `${base}/environments`;
    default:
      return `${base}/tree/${encodeURIComponent(repo.default_branch)}`;
  }
}

async function repoShell(c: Context<App>, resolved: Resolved, title: string, body: string, status = 200): Promise<Response> {
  const repo = resolved.repo;
  const tabs = ['code', 'commits', 'branches', 'compare', 'activity', 'train'];
  if (resolved.viewer) tabs.push('environments');
  if (resolved.viewer?.user.login === repo.owner_login) tabs.push('settings');
  const tabLinks = tabs.map((tab) => {
    const label = tab === 'environments' ? 'Environments' : tab[0]?.toUpperCase() + tab.slice(1);
    return html`<a class="k-tab ${tab === 'environments' ? 'active' : ''}" href="${raw(repoTabHref(repo, tab))}" ${raw(tab === 'environments' ? 'aria-current="page"' : '')}>${label}</a>`;
  }).join('');
  const ownedRepos = resolved.viewer
    ? await listReposForOwner(c.env.DB, resolved.viewer.user.login, 8)
    : [];
  const links = [
    ...ownedRepos.map((item) => ({ ownerLogin: item.owner_login, name: item.name })),
    { ownerLogin: repo.owner_login, name: repo.name },
  ].filter((item, index, all) => all.findIndex((other) => other.ownerLogin === item.ownerLogin && other.name === item.name) === index);
  const repoBody = html`
    <div class="k-repo-head"><span class="hud">REPOSITORY</span><a href="${raw(repoBase(repo))}">${repo.owner_login}/${repo.name}</a><span class="k-visibility">${repo.visibility}</span></div>
    <nav class="k-tabs" aria-label="Repository">${raw(tabLinks)}</nav>
    ${raw(body)}`;
  const page = await appLayout(c.env, {
    title,
    userLogin: resolved.viewer?.user.login ?? null,
    userId: resolved.viewer?.user.id,
    repos: links,
    active: 'fleet',
  }, repoBody);
  return htmlResponse(c, page, status);
}

// ---------------------------------------------------------------------------
// Environment form
// ---------------------------------------------------------------------------

interface FormValues {
  name: string;
  baseRef: string;
  instance: string;
  setupScript: string;
  validateScript: string;
  envVars: string;
  allowedHosts: string;
  deny: string;
  approve: string;
  rebuildPaths: string;
  idleMinutes: string;
  maxBuildAgeHours: string;
}

function formValues(env: EnvironmentView | null, defaultBranch: string): FormValues {
  return {
    name: env?.name ?? '',
    baseRef: env?.baseRef ?? defaultBranch,
    instance: env?.instance ?? 'standard-1',
    setupScript: env?.setupScript ?? '',
    validateScript: env?.validateScript ?? '',
    envVars: env ? Object.entries(env.envVars).map(([k, v]) => `${k}=${v}`).join('\n') : '',
    allowedHosts: env ? env.allowedHosts.join('\n') : '',
    deny: env ? env.commandPolicy.deny.join('\n') : '',
    approve: env ? env.commandPolicy.approve.join('\n') : '',
    rebuildPaths: env ? env.rebuildPaths.join('\n') : '',
    idleMinutes: String(env?.idleMinutes ?? 30),
    maxBuildAgeHours: String(env?.maxBuildAgeHours ?? 72),
  };
}

function formInput(form: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const envVars: Record<string, string> = {};
  for (const line of lines(form.envVars)) {
    const eq = line.indexOf('=');
    if (eq > 0) envVars[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  const input: Record<string, unknown> = {
    baseRef: String(form.baseRef ?? '').trim(),
    instance: String(form.instance ?? 'standard-1'),
    setupScript: String(form.setupScript ?? '').replaceAll('\r\n', '\n'),
    validateScript: String(form.validateScript ?? '').replaceAll('\r\n', '\n'),
    envVars,
    commandPolicy: { deny: lines(form.deny), approve: lines(form.approve) },
    idleMinutes: Number(form.idleMinutes),
    maxBuildAgeHours: Number(form.maxBuildAgeHours),
  };
  // Blank list fields keep the platform defaults instead of clearing them.
  const hosts = lines(form.allowedHosts);
  if (hosts.length > 0 || !creating) input.allowedHosts = hosts;
  const paths = lines(form.rebuildPaths);
  if (paths.length > 0 || !creating) input.rebuildPaths = paths;
  if (creating) {
    input.name = String(form.name ?? '').trim();
    input.os = 'linux';
  }
  return input;
}

function formFromBody(form: Record<string, unknown>): FormValues {
  const s = (key: keyof FormValues) => String(form[key] ?? '');
  return {
    name: s('name'),
    baseRef: s('baseRef'),
    instance: s('instance'),
    setupScript: s('setupScript'),
    validateScript: s('validateScript'),
    envVars: s('envVars'),
    allowedHosts: s('allowedHosts'),
    deny: s('deny'),
    approve: s('approve'),
    rebuildPaths: s('rebuildPaths'),
    idleMinutes: s('idleMinutes'),
    maxBuildAgeHours: s('maxBuildAgeHours'),
  };
}

function environmentForm(action: string, values: FormValues, creating: boolean, csrf: string, error?: string): string {
  const instanceOptions = INSTANCES.map(
    (i) => html`<option value="${i}" ${raw(values.instance === i ? 'selected' : '')}>${i}</option>`,
  ).join('');
  const cancel = action;
  return html`
    ${raw(flash(error))}
    <form method="post" action="${raw(action)}" class="env-form">
      ${raw(csrf)}
      <div class="k-form-sections">
        <section class="panel k-consent">
          <div class="panel-head"><span class="hud">01 / BASICS</span></div>
          <div class="k-form-body">
            <div class="k-fields">
              <div class="k-field">
                <label class="hud" for="name">Environment name</label>
                ${raw(
                  creating
                    ? html`<input id="name" name="name" type="text" required pattern="[a-z][a-z0-9-]{0,62}" value="${values.name}" placeholder="default" />`
                    : html`<input id="name" type="text" value="${values.name}" disabled />`,
                )}
              </div>
              <div class="k-field">
                <label class="hud" for="baseRef">Base branch</label>
                <input id="baseRef" name="baseRef" type="text" required value="${values.baseRef}" />
              </div>
              <div class="k-field">
                <label class="hud" for="os">Operating system</label>
                <select id="os" disabled><option>linux (amd64)</option></select>
                <p class="hint m-human">Linux build snapshots are shared by every sandbox in this environment.</p>
                <p class="hint m-agent"><code>os=linux · arch=amd64</code></p>
              </div>
              <div class="k-field">
                <label class="hud" for="instance">Instance</label>
                <select id="instance" name="instance">${raw(instanceOptions)}</select>
              </div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><span class="hud">02 / SCRIPTS</span></div>
          <div class="k-form-body">
            <p class="hint m-human">Setup runs once per build, never per sandbox. Builds have no credentials or secrets; only validated builds are used.</p>
            <p class="hint m-agent">Build input is configuration only; runtime credentials are minted per run.</p>
            <div class="k-field">
              <label class="hud" for="setupScript">Setup script</label>
              <textarea id="setupScript" name="setupScript" rows="8" spellcheck="false" placeholder="npm ci">${values.setupScript}</textarea>
            </div>
            <div class="k-field">
              <label class="hud" for="validateScript">Validate script</label>
              <textarea id="validateScript" name="validateScript" rows="3" spellcheck="false" placeholder="npm test -- --run">${values.validateScript}</textarea>
            </div>
            <div class="k-field">
              <label class="hud" for="envVars">Environment variables · KEY=value · non-secret</label>
              <textarea id="envVars" name="envVars" rows="3" spellcheck="false">${values.envVars}</textarea>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><span class="hud">03 / NETWORK</span></div>
          <div class="k-form-body">
            <label class="hud" for="allowedHosts">Allowed hosts · one per line</label>
            <textarea id="allowedHosts" name="allowedHosts" rows="4" spellcheck="false" placeholder="default: npm, PyPI, crates.io and Go module proxies">${values.allowedHosts}</textarea>
            <p class="hint">The platform is always reachable. Changes apply on the next start or wake.</p>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><span class="hud">04 / COMMANDS</span></div>
          <div class="k-form-body k-form-grid">
            <div class="k-field">
              <label class="hud" for="deny">Never run · command globs</label>
              <textarea id="deny" name="deny" rows="4" spellcheck="false" placeholder="rm -rf /*">${values.deny}</textarea>
            </div>
            <div class="k-field">
              <label class="hud" for="approve">Needs approval · command globs</label>
              <textarea id="approve" name="approve" rows="4" spellcheck="false" placeholder="npm publish*">${values.approve}</textarea>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><span class="hud">05 / LIFECYCLE</span></div>
          <div class="k-form-body k-form-grid">
            <div class="k-field">
              <label class="hud" for="rebuildPaths">Rebuild when a push touches</label>
              <textarea id="rebuildPaths" name="rebuildPaths" rows="4" spellcheck="false" placeholder="default: lockfiles and .kvarm/**">${values.rebuildPaths}</textarea>
              <p class="hint">One path glob per line.</p>
            </div>
            <div class="k-field">
              <label class="hud" for="maxBuildAgeHours">Rebuild after · hours</label>
              <input id="maxBuildAgeHours" name="maxBuildAgeHours" type="number" min="1" max="600" value="${values.maxBuildAgeHours}" />
              <label class="hud" for="idleMinutes">Sleep after idle · minutes</label>
              <input id="idleMinutes" name="idleMinutes" type="number" min="1" max="360" value="${values.idleMinutes}" />
            </div>
          </div>
        </section>
      </div>
      <div class="k-form-footer">
        <span class="hud">${creating ? 'NEW BUILD ENVIRONMENT' : 'SAVE CONFIGURATION'}</span>
        <div class="actions"><a class="btn" href="${raw(cancel)}">Cancel</a><button class="btn btn-primary" type="submit">${creating ? 'Create environment' : 'Save and rebuild if needed'}</button></div>
      </div>
    </form>`;
}

// ---------------------------------------------------------------------------
// Repository environment pages
// ---------------------------------------------------------------------------

interface Kpi {
  label: string;
  value: string | number;
  warn?: boolean;
}

function pageHead(
  eyebrow: string,
  title: string,
  accent: string,
  human: string,
  agent: string,
  items: Kpi[],
  actions = '',
): string {
  const stats = items.map((item) => html`
    <div><span class="hud">${item.label}</span><b class="${item.warn ? 'warn' : ''}">${item.value}</b></div>
  `).join('');
  return html`
    <header class="k-head">
      <div class="k-head-copy">
        <span class="hud">${eyebrow}</span>
        <h1>${title}<br /><span class="ink">${accent}</span></h1>
        <p class="lede m-human">${human}</p>
        <p class="lede m-agent k-mono">${agent}</p>
        ${raw(actions ? html`<div class="k-head-actions">${raw(actions)}</div>` : '')}
      </div>
      <div class="k-head-side"><div class="k-kpis">${raw(stats)}</div></div>
    </header>`;
}

function phaseValue(phases: Record<string, number>, name: string): unknown {
  const values = phases as Record<string, unknown>;
  return values[name] ?? (name === 'clone' ? values.checkout ?? values.extract : undefined);
}

function phaseDuration(phases: Record<string, number>, name: string): number | undefined {
  const phase = phaseValue(phases, name);
  if (typeof phase === 'number') return phase;
  if (typeof phase !== 'object' || phase === null) return undefined;
  const duration = (phase as { durationMs?: unknown }).durationMs;
  return typeof duration === 'number' ? duration : undefined;
}

function phaseFailed(phases: Record<string, number>, name: string): boolean {
  const phase = phaseValue(phases, name);
  return typeof phase === 'object' && phase !== null && (phase as { status?: unknown }).status === 'failed';
}

function phaseBar(phases: Record<string, number>, buildStatus: string, detail = false): string {
  const names = ['clone', 'setup', 'validate', 'snapshot'];
  const failedPhase = names.find((name) => phaseFailed(phases, name)) ??
    (buildStatus === 'failed' ? [...names].reverse().find((name) => phaseDuration(phases, name) !== undefined) : undefined);
  const parts = names.map((name) => {
    const duration = phaseDuration(phases, name);
    const failed = name === failedPhase;
    const style = duration === undefined ? 'flex:0 0 2px' : `flex:${Math.max(duration, 1)} 1 0`;
    return html`<i class="${failed ? 'failed' : duration === undefined ? 'missing' : 'done'}" style="${style}" title="${name}${duration === undefined ? '' : ` · ${(duration / 1000).toFixed(1)}s`}"></i>`;
  }).join('');
  return html`<span class="k-stage ${detail ? 'k-stage-detail' : ''}">${raw(parts)}</span>`;
}

function buildRow(base: string, env: EnvironmentView, build: EnvironmentBuildView): string {
  const duration =
    build.startedAt && build.finishedAt
      ? `${Math.max(1, Math.round((Date.parse(build.finishedAt) - Date.parse(build.startedAt)) / 1000))}s`
      : '';
  return html`
    <tr>
      <td><a href="${raw(`${base}/environments/${encodeURIComponent(env.name)}/builds/${build.id}`)}"><b>#${build.seq}</b></a></td>
      <td>${raw(pill(build.status))}</td>
      <td class="muted">${build.reason}</td>
      <td><code>${build.baseSha ? build.baseSha.slice(0, 10) : '—'}</code></td>
      <td>${raw(phaseBar(build.phases, build.status))}</td>
      <td class="muted">${duration}</td>
      <td class="muted">${ago(build.createdAt)}</td>
    </tr>`;
}

fleetRepoPages.get('/environments', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const base = repoBase(resolved.repo);
  const listed = await environments.listEnvironments(c.env, resolved.repo, resolved.viewer);
  if (!listed.ok) return notFound(c);
  const rows = await Promise.all(
    listed.value.map(async (env) => {
      const builds = await environments.listEnvironmentBuilds(c.env, resolved.repo, resolved.viewer, env.id, 1);
      const latest = builds.ok ? builds.value[0] : undefined;
      const state = env.readyBuildId ? 'ready' : latest?.status ?? 'queued';
      return { env, latest, state };
    }),
  );
  const isAdmin = resolved.role === 'admin' && resolved.viewer !== null && !resolved.viewer.agent;
  const readyCount = rows.filter((row) => row.env.readyBuildId).length;
  const buildingCount = rows.filter((row) => ['queued', 'building', 'validating'].includes(row.latest?.status ?? '')).length;
  const failedCount = rows.filter((row) => row.latest?.status === 'failed').length;
  const tableRows = rows.map(({ env, latest, state }) => html`
    <tr>
      <td><a href="${raw(`${base}/environments/${encodeURIComponent(env.name)}`)}"><b>${env.name}</b></a><small>${env.os} · ${env.instance}</small></td>
      <td>${raw(pill(state))}</td>
      <td class="muted">${env.readyBuildId ? ago(latest?.finishedAt ?? env.updatedAt) : '—'}</td>
      <td><code>${env.instance}</code></td>
      <td><code>${env.baseRef}</code></td>
      <td class="muted">${latest ? `#${latest.seq} · ${latest.status}` : '—'}</td>
    </tr>`).join('');
  const body = html`
    ${raw(pageHead(
      `${resolved.repo.owner_login}/${resolved.repo.name} · FLEET`,
      'ENVIRONMENTS',
      `${readyCount} READY.`,
      'Build once, then resume the same workspace with its files, dependencies and caches intact.',
      `kvarm environment list --repo ${resolved.repo.owner_login}/${resolved.repo.name} · ${rows.length} environments · ${readyCount} ready`,
      [
        { label: 'Environments', value: rows.length },
        { label: 'Ready', value: readyCount },
        { label: 'Building', value: buildingCount },
        { label: 'Failed', value: failedCount, warn: failedCount > 0 },
      ],
      isAdmin ? html`<a class="btn btn-primary" href="${raw(`${base}/environments/new`)}">New environment</a>` : '',
    ))}
    <div class="k-content">
      <section class="panel">
        <div class="panel-head"><span class="hud">ENVIRONMENTS · <b>${rows.length}</b></span><a class="hud" href="/fleet">Fleet →</a></div>
        ${raw(rows.length
          ? html`<div class="tscroll"><table class="table"><thead><tr><th>Name</th><th>Status</th><th>Ready build</th><th>Instance</th><th>Base ref</th><th>Last build</th></tr></thead><tbody>${raw(tableRows)}</tbody></table></div>`
          : html`<div class="k-empty"><p class="m-human">No environments yet. Create one to give agents a ready-to-use cloud sandbox.</p><p class="m-agent k-mono">kvarm environment create --repo ${resolved.repo.owner_login}/${resolved.repo.name}</p></div>`)}
      </section>
      <section class="panel k-consent">
        <div class="panel-head"><span class="hud">START A SANDBOX</span></div>
        <div class="k-form-body"><p class="m-human">Agents call <code>start_sandbox</code> over MCP, then execute commands in the resumed workspace.</p><p class="m-agent k-mono">start_sandbox → exec_sandbox → stop_sandbox --discard=false</p></div>
      </section>
    </div>`;
  return repoShell(c, resolved, `Environments · ${resolved.repo.owner_login}/${resolved.repo.name}`, body);
});

fleetRepoPages.get('/environments/new', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved || resolved.role !== 'admin' || !resolved.viewer) return notFound(c);
  const base = repoBase(resolved.repo);
  const body = html`
    ${raw(pageHead(
      `${resolved.repo.owner_login}/${resolved.repo.name} · CONFIGURATION`,
      'NEW',
      'ENVIRONMENT.',
      'Set up a reusable build snapshot for agents working in this repository.',
      `kvarm environment create --repo ${resolved.repo.owner_login}/${resolved.repo.name}`,
      [{ label: 'OS', value: 'LINUX' }, { label: 'DEFAULT INSTANCE', value: 'STANDARD-1' }],
    ))}
    ${raw(environmentForm(`${base}/environments`, formValues(null, resolved.repo.default_branch), true, await csrfField(c)))}`;
  return repoShell(c, resolved, 'New environment', body);
});

fleetRepoPages.post('/environments', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved || !resolved.viewer) return notFound(c);
  const form = await postedForm(c, resolved.viewer);
  if (form instanceof Response) return form;
  const created = await environments.createEnvironment(
    { env: c.env, repo: resolved.repo, actor: resolved.viewer },
    formInput(form, true) as unknown as environments.CreateEnvironmentInput,
  );
  const base = repoBase(resolved.repo);
  if (!created.ok) {
    const body = html`<h2>New environment</h2>${raw(environmentForm(`${base}/environments`, formFromBody(form), true, await csrfField(c), created.error))}`;
    return repoShell(c, resolved, 'New environment', body, created.status === 403 ? 403 : 422);
  }
  return finish(c, c.redirect(`${base}/environments/${encodeURIComponent(created.value.environment.name)}`));
});

async function loadEnvironment(c: Context<App>): Promise<{ resolved: Resolved; env: EnvironmentView } | null> {
  const resolved = await resolveRepo(c);
  if (!resolved) return null;
  const listed = await environments.listEnvironments(c.env, resolved.repo, resolved.viewer);
  if (!listed.ok) return null;
  const env = listed.value.find((e) => e.name === c.req.param('name'));
  return env ? { resolved, env } : null;
}

fleetRepoPages.get('/environments/:name', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded) return notFound(c);
  const { resolved, env } = loaded;
  const base = repoBase(resolved.repo);
  const envBase = `${base}/environments/${encodeURIComponent(env.name)}`;
  const builds = await environments.listEnvironmentBuilds(c.env, resolved.repo, resolved.viewer, env.id, 20);
  const buildList = builds.ok ? builds.value : [];
  const ready = buildList.find((b) => b.id === env.readyBuildId);
  const latest = buildList[0];
  const isAdmin = resolved.role === 'admin' && resolved.viewer !== null && !resolved.viewer.agent;
  const notice = c.req.query('rebuilt') ? flash('Rebuild requested.', 'ok') : '';
  const duration = latest?.startedAt && latest.finishedAt
    ? `${Math.max(1, Math.round((Date.parse(latest.finishedAt) - Date.parse(latest.startedAt)) / 1000))}s`
    : '—';
  const csrf = isAdmin ? await csrfField(c) : '';
  const actions = isAdmin ? html`
      <form method="post" action="${raw(`${envBase}/rebuild`)}">${raw(csrf)}<button class="btn btn-primary" type="submit">Rebuild</button></form>
      <a class="btn" href="${raw(`${envBase}/edit`)}">Edit</a>
      <form method="post" action="${raw(`${envBase}/archive`)}" onsubmit="return confirm('Archive this environment?')">${raw(csrf)}<button class="btn btn-danger" type="submit">Archive</button></form>
    ` : '';
  const body = html`
    ${raw(notice)}
    ${raw(pageHead(
      `${resolved.repo.owner_login}/${resolved.repo.name} · ENVIRONMENT`,
      env.name,
      `${(env.readyBuildId ? 'READY' : latest?.status ?? 'QUEUED').toUpperCase()}.`,
      `${env.os} environment · ${env.instance} instance · base ${env.baseRef}${env.pending ? ' · another build is queued' : ''}`,
      `kvarm environment get ${env.name} · ready=${ready ? `#${ready.seq}` : 'none'} · latest=${latest ? `#${latest.seq}:${latest.status}` : 'none'}`,
      [
        { label: 'Status', value: (env.readyBuildId ? 'READY' : latest?.status ?? 'QUEUED').toUpperCase() },
        { label: 'Ready age', value: ready ? ago(ready.finishedAt) : '—' },
        { label: 'Last build', value: duration },
        { label: 'Instance', value: env.instance.toUpperCase() },
        { label: 'Idle min', value: env.idleMinutes },
      ],
      actions,
    ))}
    <div class="k-content">
      <section class="panel">
        <div class="panel-head"><span class="hud">BUILDS · <b>${buildList.length}</b></span><a class="hud" href="${raw(`${base}/environments`)}">All environments →</a></div>
        ${raw(buildList.length
          ? html`<div class="tscroll"><table class="table"><thead><tr><th>Build</th><th>Status</th><th>Trigger</th><th>Commit</th><th>Phases</th><th>Duration</th><th>Created</th></tr></thead><tbody>${raw(buildList.map((b) => buildRow(base, env, b)).join(''))}</tbody></table></div>`
          : html`<div class="k-empty">No builds yet.</div>`)}
      </section>
      <div class="k-split-panels">
        <section class="panel">
          <div class="panel-head"><span class="hud">BUILD CONFIGURATION</span></div>
          <div class="k-form-body">
            <div class="hud">SETUP</div><pre class="k-term"><code>${env.setupScript || '# no setup script'}</code></pre>
            <div class="hud k-subhead">VALIDATE</div><pre class="k-term"><code>${env.validateScript || '# no validation script'}</code></pre>
            <p class="hint m-human">The validated build is reused by every sandbox started from this environment.</p>
            <p class="hint m-agent">base_ref=${env.baseRef} · config_hash=${env.configHash}</p>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><span class="hud">NETWORK &amp; COMMAND POLICY</span></div>
          <div class="k-form-body">
            <div class="hud">ALLOWED HOSTS</div>
            <div class="k-chips">${raw(env.allowedHosts.map((host) => html`<span class="k-chip">${host}</span>`).join('') || html`<span class="muted">Default host set</span>`)}</div>
            <div class="k-policy-grid">
              <div><span class="hud">DENIED</span>${raw(env.commandPolicy.deny.map((rule) => html`<code class="k-rule">${rule}</code>`).join('') || html`<code class="k-rule k-rule-none">none</code>`)}</div>
              <div><span class="hud">APPROVAL REQUIRED</span>${raw(env.commandPolicy.approve.map((rule) => html`<code class="k-rule">${rule}</code>`).join('') || html`<code class="k-rule k-rule-none">none</code>`)}</div>
            </div>
            <p class="hint m-human">Host changes apply on the next start or wake.</p>
            <p class="hint m-agent">deny=[${env.commandPolicy.deny.join(',')}] · approve=[${env.commandPolicy.approve.join(',')}]</p>
          </div>
        </section>
      </div>
    </div>`;
  return repoShell(c, resolved, `${env.name} · Environments`, body);
});

fleetRepoPages.get('/environments/:name/edit', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded || loaded.resolved.role !== 'admin' || !loaded.resolved.viewer) return notFound(c);
  const { resolved, env } = loaded;
  const envBase = `${repoBase(resolved.repo)}/environments/${encodeURIComponent(env.name)}`;
  const body = html`
    ${raw(pageHead(`${resolved.repo.owner_login}/${resolved.repo.name} · CONFIGURATION`, 'EDIT', `${env.name.toUpperCase()}.`, 'Adjust the build, network and command policy for this environment.', `kvarm environment update ${env.name} --repo ${resolved.repo.owner_login}/${resolved.repo.name}`, [{ label: 'Build age', value: `${env.maxBuildAgeHours}H` }, { label: 'Idle', value: `${env.idleMinutes}M` }]))}
    ${raw(environmentForm(envBase, formValues(env, resolved.repo.default_branch), false, await csrfField(c)))}`;
  return repoShell(c, resolved, `Edit ${env.name}`, body);
});

fleetRepoPages.post('/environments/:name', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded || !loaded.resolved.viewer) return notFound(c);
  const form = await postedForm(c, loaded.resolved.viewer);
  if (form instanceof Response) return form;
  const { resolved, env } = loaded;
  const envBase = `${repoBase(resolved.repo)}/environments/${encodeURIComponent(env.name)}`;
  const updated = await environments.updateEnvironment(
    { env: c.env, repo: resolved.repo, actor: resolved.viewer },
    env.id,
    formInput(form, false) as environments.UpdateEnvironmentInput,
  );
  if (!updated.ok) {
    const values = { ...formFromBody(form), name: env.name };
    const body = html`${raw(pageHead(`${resolved.repo.owner_login}/${resolved.repo.name} · CONFIGURATION`, 'EDIT', `${env.name.toUpperCase()}.`, 'Adjust the build, network and command policy for this environment.', `kvarm environment update ${env.name} --repo ${resolved.repo.owner_login}/${resolved.repo.name}`, []))}${raw(environmentForm(envBase, values, false, await csrfField(c), updated.error))}`;
    return repoShell(c, resolved, `Edit ${env.name}`, body, updated.status === 403 ? 403 : 422);
  }
  return finish(c, c.redirect(envBase));
});

fleetRepoPages.post('/environments/:name/rebuild', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded || !loaded.resolved.viewer) return notFound(c);
  const refused = await csrfRefused(c, loaded.resolved.viewer);
  if (refused) return refused;
  const { resolved, env } = loaded;
  const result = await environments.rebuildEnvironment({ env: c.env, repo: resolved.repo, actor: resolved.viewer }, env.id);
  if (!result.ok) return notFound(c);
  return finish(c, c.redirect(`${repoBase(resolved.repo)}/environments/${encodeURIComponent(env.name)}?rebuilt=1`));
});

fleetRepoPages.post('/environments/:name/archive', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded || !loaded.resolved.viewer) return notFound(c);
  const refused = await csrfRefused(c, loaded.resolved.viewer);
  if (refused) return refused;
  const { resolved, env } = loaded;
  const result = await environments.archiveEnvironment({ env: c.env, repo: resolved.repo, actor: resolved.viewer }, env.id);
  if (!result.ok) return notFound(c);
  return finish(c, c.redirect(`${repoBase(resolved.repo)}/environments`));
});

fleetRepoPages.get('/environments/:name/builds/:build', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded) return notFound(c);
  const { resolved, env } = loaded;
  const result = await environments.getEnvironmentBuild(c.env, resolved.repo, resolved.viewer, env.id, c.req.param('build'));
  if (!result.ok) return notFound(c);
  const build = result.value;
  const envBase = `${repoBase(resolved.repo)}/environments/${encodeURIComponent(env.name)}`;
  const phaseNames = ['clone', 'setup', 'validate', 'snapshot'];
  const phaseCells = phaseNames.map((name) => html`
    <div class="k-phase"><span class="hud">${name}</span><b>${phaseDuration(build.phases, name) === undefined ? '—' : `${(phaseDuration(build.phases, name)! / 1000).toFixed(1)}s`}</b></div>
  `).join('');
  const body = html`
    ${raw(pageHead(
      `${resolved.repo.owner_login}/${resolved.repo.name} · ${env.name.toUpperCase()}`,
      `BUILD #${build.seq}`,
      `${build.status.toUpperCase()}.`,
      `${build.reason} build · ${build.baseSha ? `commit ${build.baseSha.slice(0, 10)}` : 'waiting for a commit'} · ${ago(build.createdAt)}`,
      `kvarm environment build get ${build.id} · status=${build.status} · reason=${build.reason}`,
      [{ label: 'Status', value: build.status.toUpperCase(), warn: build.status === 'failed' }, { label: 'Attempt', value: build.attempt }, { label: 'Created', value: ago(build.createdAt) }],
      html`<a class="btn" href="${raw(envBase)}">Environment</a>`,
    ))}
    <div class="k-content">
      ${raw(build.error ? html`<div class="k-note risk"><span class="hud">BUILD FAILED</span><p>${build.error}</p></div>` : '')}
      <section class="panel">
        <div class="panel-head"><span class="hud">PHASE TIMINGS</span><span class="k-mono">${build.baseSha ?? 'no commit'}</span></div>
        <div class="k-phase-strip">${raw(phaseBar(build.phases, build.status, true))}<div class="k-phase-labels">${raw(phaseCells)}</div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><span class="hud">BUILD OUTPUT</span><span class="k-mono">${build.outputTail ? `${build.outputTail.length} chars` : 'NO OUTPUT'}</span></div>
        <pre class="k-term k-log"><code>${build.outputTail || 'No output yet.'}</code></pre>
      </section>
    </div>`;
  return repoShell(c, resolved, `Build #${build.seq} · ${env.name}`, body);
});

// ---------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------

function commandRow(command: SandboxCommandView): string {
  const exit =
    command.policy === 'denied'
      ? pill('denied')
      : command.exitCode === null
        ? pill('pending')
        : command.exitCode === 0
          ? html`<span class="tag tag-ready">exit 0</span>`
          : html`<span class="tag tag-failed">exit ${command.exitCode}</span>`;
  const output = `${command.stdoutTail}${command.stderrTail}`;
  return html`
    <tr>
      <td class="muted">${ago(command.createdAt)}</td>
      <td><code class="command-code">${command.command}</code><small>${command.cwd}</small></td>
      <td>${raw(exit)}</td>
      <td class="k-mono">${(command.durationMs / 1000).toFixed(1)}s</td>
      <td>${raw(pill(command.policy))}</td>
      <td><details class="k-output"><summary class="hud">OUTPUT</summary><pre class="k-term"><code>${output || 'No output.'}</code></pre></details></td>
    </tr>`;
}

fleetRepoPages.get('/sandboxes/:id', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved || !resolved.viewer) return notFound(c);
  const id = c.req.param('id');
  const found = await sandboxes.getSandbox(c.env, resolved.repo, resolved.viewer, id);
  if (!found.ok) return notFound(c);
  const sandbox = found.value;
  const [commands, approvalResult] = await Promise.all([
    sandboxes.listSandboxCommands(c.env, resolved.repo, resolved.viewer, id, 100),
    sandboxes.listSandboxApprovals(c.env, resolved.repo, resolved.viewer, 100),
  ]);
  const commandList = commands.ok ? commands.value : [];
  const pending = approvalResult.ok
    ? approvalResult.value.filter((approval) => approval.sandboxId === id && approval.status === 'pending' && Date.parse(approval.expiresAt) > Date.now())
    : [];
  const live = sandbox.status === 'running' || sandbox.status === 'sleeping' || sandbox.status === 'starting';
  const startedFrom = sandbox.startedFrom ?? (sandbox.resumed ? 'resume' : 'build');
  const csrf = await csrfField(c);
  const approvalRows = pending.map((approval) => html`
    <div class="k-dec" style="--c:var(--heat-4)">
      <div><span class="hud">${approval.repo} · ${approval.id.slice(0, 8)}</span><h3 class="k-mono">${approval.command}</h3><div class="k-approval-agent">${raw(agentIdentity(approval.agentId ?? 'unknown', approval.agentName ?? null))}</div><p class="m-human">Waiting for your approval.</p><p class="m-agent k-mono">approval=${approval.id} · expires=${approval.expiresAt}</p></div>
      <div class="acts"><form method="post" action="/fleet/approvals/${approval.id}">${raw(csrf)}<input type="hidden" name="repo" value="${approval.repo}" /><button class="btn btn-primary btn-sm" name="decision" value="approve" type="submit">Approve</button><button class="btn btn-sm" name="decision" value="deny" type="submit">Deny</button></form></div>
    </div>`).join('');
  const body = html`
    ${raw(pageHead(
      `${resolved.repo.owner_login}/${resolved.repo.name} · SANDBOX`,
      'SANDBOX',
      `${sandbox.status.toUpperCase()}.`,
      sandbox.task ?? 'An isolated workspace with its files and dependencies preserved between runs.',
      `kvarm sandbox get ${sandbox.id} · ${sandbox.status} · ref=${sandbox.workspaceRef ?? '—'}`,
      [
        { label: 'Status', value: sandbox.status.toUpperCase() },
        { label: 'Environment', value: sandbox.environmentName.toUpperCase() },
        { label: 'Started from', value: startedFrom.toUpperCase() },
        { label: 'Last active', value: ago(sandbox.lastActiveAt) },
        { label: 'Expires', value: new Date(sandbox.expiresAt).toISOString().slice(0, 10) },
      ],
      live ? stopForms(`${repoBase(resolved.repo)}/sandboxes/${sandbox.id}`, sandbox.status, csrf) : '',
    ))}
    <div class="k-content">
      ${raw(sandbox.error ? flash(sandbox.error) : '')}
      ${raw(sandbox.buildOutdated ? html`<div class="k-note warn"><span class="hud">BUILD OUTDATED</span> This sandbox remains on its original snapshot until it is discarded.</div>` : '')}
      ${raw(sandbox.localDiverged ? html`<div class="k-note warn"><span class="hud">LOCAL BRANCH DIVERGED</span> Workspace changes were preserved; no fast-forward was applied.</div>` : '')}
      <section class="panel">
        <div class="panel-head"><span class="hud">WORKSPACE</span><a class="hud" href="${raw(repoBase(resolved.repo))}">Repository →</a></div>
        <div class="k-workspace">
          <div><span class="hud">WORKSPACE REF</span><code>${sandbox.workspaceRef ?? '—'}</code></div>
          <div><span class="hud">PUSH REF</span><code>${sandbox.pushRef ?? '—'}</code></div>
          <div><span class="hud">REPOSITORY DIRECTORY</span><code>${sandbox.repoDirectory}</code></div>
          <div><span class="hud">BUILD</span><code>${sandbox.buildId}</code></div>
        </div>
      </section>
      ${raw(pending.length ? html`<section class="panel"><div class="panel-head"><span class="hud">NEEDS YOU · <b>${pending.length}</b></span><a class="hud" href="/fleet#approvals">All approvals →</a></div>${raw(approvalRows)}</section>` : '')}
      <section class="panel">
        <div class="panel-head"><span class="hud">COMMAND HISTORY · <b>${commandList.length}</b></span></div>
        ${raw(commandList.length
          ? html`<div class="tscroll"><table class="table"><thead><tr><th>Time</th><th>Command</th><th>Exit</th><th>Duration</th><th>Decision</th><th></th></tr></thead><tbody>${raw(commandList.map(commandRow).join(''))}</tbody></table></div>`
          : html`<div class="k-empty">No commands have run in this sandbox.</div>`)}
      </section>
    </div>`;
    return repoShell(c, resolved, `Sandbox ${shortSandboxId(sandbox.id)}`, body);
});

function stopForms(action: string, status: string, csrf: string): string {
  return html`<div class="actions k-action-buttons">
    ${raw(status === 'running' ? html`<form method="post" action="${raw(`${action}/stop`)}">${raw(csrf)}<button class="btn btn-sm" type="submit">Sleep</button></form>` : '')}
    <form method="post" action="${raw(`${action}/discard`)}" onsubmit="return confirm('Discard this sandbox and its saved state?')">${raw(csrf)}<button class="btn btn-danger btn-sm" type="submit">Discard</button></form>
  </div>`;
}

async function stopFromPage(c: Context<App>, discard: boolean): Promise<Response> {
  const resolved = await resolveRepo(c);
  if (!resolved || !resolved.viewer) return notFound(c);
  const refused = await csrfRefused(c, resolved.viewer);
  if (refused) return refused;
  const result = await sandboxes.stopSandbox(sandboxContext(c, resolved.repo, resolved.viewer), c.req.param('id') ?? '', { discard });
  if (!result.ok) return notFound(c);
  // The sandbox has already changed state: a bad Referer must not turn that into a 500.
  return finish(c, c.redirect(sameOriginReferer(c)));
}

fleetRepoPages.post('/sandboxes/:id/stop', (c) => stopFromPage(c, false));
fleetRepoPages.post('/sandboxes/:id/discard', (c) => stopFromPage(c, true));

// ---------------------------------------------------------------------------
// Fleet dashboard
// ---------------------------------------------------------------------------

function sandboxRow(sandbox: SandboxView, csrf: string): string {
  const href = `/${sandbox.repo}/sandboxes/${sandbox.id}`;
  return html`
    <tr>
      <td><a href="${raw(href)}"><b>${raw(agentIdentity(sandbox.agentId, sandbox.agentName))}</b></a><small class="m-human">${sandbox.task || shortSandboxId(sandbox.id)}</small><small class="m-agent k-mono">${sandbox.id}</small></td>
      <td><a href="${raw(`/${sandbox.repo}`)}">${sandbox.repo}</a></td>
      <td>${sandbox.environmentName}</td>
      <td>${raw(pill(sandbox.status))}</td>
      <td class="k-mono">${sandbox.startedFrom ?? (sandbox.resumed ? 'resume' : 'build')}</td>
      <td class="muted">${ago(sandbox.lastActiveAt)}</td>
      <td class="right">${raw(sandbox.status === 'stopped' || sandbox.status === 'failed' ? '' : stopForms(`/${sandbox.repo}/sandboxes/${sandbox.id}`, sandbox.status, csrf))}</td>
    </tr>`;
}

function approvalRow(approval: SandboxApprovalView & { repo?: string }, csrf: string): string {
  const agentId = approval.agentId ?? 'unknown';
  return html`
    <div class="k-dec" style="--c:var(--heat-4)">
      <div>
        <span class="hud">${approval.repo ?? ''} · <a class="m-human" href="${raw(`/${approval.repo ?? ''}/sandboxes/${approval.sandboxId}`)}">SANDBOX ${shortSandboxId(approval.sandboxId)}</a><a class="m-agent k-approval-id-agent" href="${raw(`/${approval.repo ?? ''}/sandboxes/${approval.sandboxId}`)}">SANDBOX ${approval.sandboxId}</a> · ${ago(approval.createdAt)}</span>
        <div class="k-approval-agent">${raw(agentIdentity(agentId, approval.agentName ?? null))}</div>
        <h3 class="k-mono">${approval.command}</h3>
        <p class="m-human">This agent is waiting for permission to run the command.</p>
        <p class="m-agent k-mono">approval=${approval.id} · agent=${agentId}</p>
      </div>
      <div class="acts">
        <form method="post" action="/fleet/approvals/${approval.id}">
          ${raw(csrf)}
          <input type="hidden" name="repo" value="${approval.repo ?? ''}" />
          <button class="btn btn-primary btn-sm" name="decision" value="approve" type="submit">Approve</button>
          <button class="btn btn-sm" name="decision" value="deny" type="submit">Deny</button>
        </form>
      </div>
    </div>`;
}

fleetPages.get('/', async (c) => {
  const actor = await sessionActor(c);
  if (!actor) return finish(c, c.redirect('/auth/sign-in?returnTo=%2Ffleet'));
  return renderFleet(c, actor);
});

/** The fleet page; a refused approval decision re-renders it with `error` shown above the grid. */
async function renderFleet(c: Context<App>, actor: ApiActor, error?: string, status = 200): Promise<Response> {
  const [mine, approvals] = await Promise.all([
    sandboxes.listMySandboxes(c.env, actor, { limit: 100 }),
    sandboxes.listMyPendingApprovals(c.env, actor),
  ]);
  const all = mine.ok ? mine.value.sandboxes : [];
  const pending = approvals.ok ? approvals.value : [];
  const count = (state: string) => all.filter((s) => s.status === state).length;
  const running = count('running') + count('starting');
  const sleeping = count('sleeping');
  const active = all.filter((s) => s.status !== 'stopped' && s.status !== 'failed');
  const ended = all.filter((s) => s.status === 'stopped' || s.status === 'failed').slice(0, 20);
  const envCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM environments e JOIN repos r ON r.id = e.repo_id
     WHERE r.owner_login = ? AND e.archived_at IS NULL`,
  ).bind(actor.user.login).first<{ count: number }>();
  const repositories = await listReposForOwner(c.env.DB, actor.user.login, 12);
  const csrf = await csrfField(c);
  const table = (rows: SandboxView[]) =>
    html`<div class="tscroll"><table class="table"><thead><tr><th>Agent / sandbox</th><th>Repository</th><th>Environment</th><th>Status</th><th>Started from</th><th>Last active</th><th></th></tr></thead>
      <tbody>${raw(rows.map((row) => sandboxRow(row, csrf)).join(''))}</tbody></table></div>`;
  const runningRows = all.filter((sandbox) => sandbox.status === 'running' || sandbox.status === 'starting').map((sandbox) => html`
    <li><span class="k-ag ok">${sandbox.agentId.slice(0, 2).toUpperCase()}</span><div>
      <b><a href="${raw(`/${sandbox.repo}/sandboxes/${sandbox.id}`)}">${sandbox.task || shortSandboxId(sandbox.id)}</a></b>
      <small>${sandbox.repo} · ${sandbox.environmentName}</small>
      <small class="m-agent">${sandbox.id} · ${sandbox.workspaceRef ?? 'no ref'}</small>
    </div><span class="k-lease live">${ago(sandbox.lastActiveAt)}</span></li>`).join('');
  const empty = all.length === 0 && pending.length === 0;
  const body = html`
    ${raw(pageHead(
      'FLEET · REUSABLE ENVIRONMENTS',
      running ? `${running} SANDBOX${running === 1 ? '' : 'ES'}` : 'FLEET',
      running ? 'RUNNING.' : 'IDLE.',
      'Your agents keep their files, dependencies and caches when a sandbox sleeps, then resume where they left off.',
      `kvarm sandbox list · ${running} running · ${sleeping} sleeping · ${pending.length} approval`,
      [
        { label: 'Running', value: running },
        { label: 'Sleeping', value: sleeping },
        { label: 'Needs you', value: pending.length, warn: pending.length > 0 },
        { label: 'Environments', value: Number(envCount?.count ?? 0) },
      ],
    ))}
    ${raw(flash(error))}
    <div class="k-grid">
      <div class="k-col">
        ${raw(pending.length
          ? html`<section class="panel" id="approvals"><div class="panel-head"><span class="hud">NEEDS YOU · <b>${pending.length}</b></span><span class="hud">APPROVALS</span></div>${raw(pending.map((approval) => approvalRow(approval, csrf)).join(''))}</section>`
          : html`<section class="panel" id="approvals"><div class="panel-head"><span class="hud">NEEDS YOU · <b>0</b></span></div><div class="k-empty">No sandbox approvals are waiting.</div></section>`)}
        ${raw(empty
          ? html`<section class="panel"><div class="panel-head"><span class="hud">SANDBOXES · EMPTY</span></div><div class="k-empty"><p class="m-human">No sandboxes yet. Create an environment, then ask an agent to start a workspace.</p><pre class="k-term m-agent"><code>kvarm sandbox start --repo acme/web --env default
kvarm sandbox exec &lt;id&gt; -- npm test
kvarm sandbox stop &lt;id&gt;</code></pre><p class="m-human"><a class="btn btn-primary" href="/settings/tokens">Set up an agent →</a></p></div></section>`
          : html`<section class="panel"><div class="panel-head"><span class="hud">SANDBOXES · <b>${active.length}</b></span><a class="hud" href="/settings/tokens">Tokens &amp; agents →</a></div>${raw(active.length ? table(active) : html`<div class="k-empty">No running or sleeping sandboxes.</div>`)}</section>`)}
        ${raw(ended.length ? html`<section class="panel"><div class="panel-head"><span class="hud">RECENTLY ENDED · <b>${ended.length}</b></span></div>${raw(table(ended))}</section>` : '')}
      </div>
      <div class="k-col">
        <section class="panel">
          <div class="panel-head"><span class="hud">WORKING NOW · <b>${running}</b></span></div>
          ${raw(running ? html`<ul class="k-list">${raw(runningRows)}</ul>` : html`<div class="k-empty">No sandboxes are running right now.</div>`)}
        </section>
        <section class="panel">
          <div class="panel-head"><span class="hud">HOW SANDBOXES WORK</span></div>
          <div class="k-form-body m-human"><p>Builds run once per environment. Sandboxes resume with their workspace intact; sleep them when the work pauses and discard them when it is done.</p><a href="${raw(repositories[0] ? `/${repositories[0].owner_login}/${repositories[0].name}/environments` : '/settings/tokens')}" class="hud">Configure an environment →</a></div>
          <pre class="k-term m-agent"><code>start_sandbox --env default
exec_sandbox &lt;id&gt; -- npm test
stop_sandbox &lt;id&gt; --discard</code></pre>
        </section>
      </div>
    </div>`;
  const page = await appLayout(c.env, {
    title: 'Fleet',
    userLogin: actor.user.login,
    userId: actor.user.id,
    needsYouCount: pending.length,
    runningCount: running,
    repos: repositories.map((repo) => ({ ownerLogin: repo.owner_login, name: repo.name })),
    active: 'fleet',
  }, body);
  return htmlResponse(c, page, status);
}

fleetPages.post('/approvals/:id', async (c) => {
  const actor = await sessionActor(c);
  if (!actor) return finish(c, c.redirect('/auth/sign-in?returnTo=%2Ffleet'));
  const form = await postedForm(c, actor);
  if (form instanceof Response) return form;
  const [owner, name] = String(form.repo ?? '').split('/');
  const repo = owner && name ? await getRepo(c.env.DB, owner, name) : null;
  if (!repo) return renderFleet(c, actor, 'The approval request named no repository you can decide for. Open the fleet page again and use its buttons.', 404);
  // Anything but the two buttons' values is a malformed post, not a deny.
  if (form.decision !== 'approve' && form.decision !== 'deny') {
    return renderFleet(c, actor, 'Choose approve or deny to decide this approval. Nothing was changed.', 400);
  }
  const result = await sandboxes.decideSandboxApproval(sandboxContext(c, repo, actor), c.req.param('id'), form.decision);
  if (!result.ok) {
    return renderFleet(c, actor, `${result.error} (${result.code ?? result.status}). Open the fleet page again for its current state.`, result.status >= 400 && result.status < 500 ? result.status : 500);
  }
  return finish(c, c.redirect('/fleet'));
});
