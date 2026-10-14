import { Hono } from 'hono';
import { GIT_PATH_RE, handleGitRequest } from './routes/git';
import { authRoutes } from './routes/auth';
import { api, persistSessionCookies } from './routes/api';
import { sessionCsrf } from './routes/pageCsrf';
import { tenancyApi } from './routes/api/tenancy';
import { agentsApi } from './routes/api/agents';
import { branchRulesApi } from './routes/api/branchRules';
import { compareApi } from './routes/api/compare';
import { contentsApi } from './routes/api/contents';
import { eventsApi } from './routes/api/events';
import { snapshotsApi } from './routes/api/snapshots';
import { changesApi } from './routes/api/changes';
import { reviewsApi } from './routes/api/reviews';
import { intentsApi } from './routes/api/intents';
import { candidatesApi } from './routes/api/candidates';
import { workspacesApi } from './routes/api/workspaces';
import { dependenciesApi } from './routes/api/dependencies';
import { attributionApi } from './routes/api/attribution';
import { issuesApi } from './routes/api/issues';
import { checksApi } from './routes/api/checks';
import { ciApi } from './routes/api/ci';
import { revertsApi } from './routes/api/reverts';
import { containerRunnerApi } from './routes/api/containerRunner';
import { fleetApi } from './routes/api/fleet';
import { webhooksApi } from './routes/api/webhooks';
import { handleEventBatch } from './services/events';
import { dispatchScheduled } from './scheduled';
import { handleMcp } from './mcp/server';
import { web } from './routes/web';
import { repoPages } from './routes/repoPages';
import { fleetPages, fleetRepoPages } from './routes/fleetPages';
import { issuePages } from './routes/issuePages';
import { coordinationPages } from './routes/coordinationPages';
import { comparePages } from './routes/comparePages';
import { inboxPages, reviewPages } from './routes/reviewPages';
import { installFetchMeter, serveMetered } from './cost/meter';
import { presentsCredential, withPrivateCacheControl } from './cache/scope';

export { TokenCache, RateLimiter, MergeLock } from './do';
export { SnapshotBuilder, CiPipeline, MergeWorkflow, RepoImport } from './workflows';
export { EnvironmentBuild } from './workflows/environmentBuild';
export { CiRunnerSandbox } from './containers/ciRunnerSandbox';
export { EnvironmentBuilder } from './containers/environmentBuilder';
export { AgentSandbox } from './containers/agentSandbox';
export { SandboxEgress } from './containers/sandboxEgress';

installFetchMeter();

const app = new Hono<{ Bindings: Env }>();

// Git smart HTTP gate. Mounted before every other route: paths like
// /{owner}/{repo}(.git)/info/refs are unambiguously git traffic; everything
// else falls through to web/API routes.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const m = url.pathname.match(GIT_PATH_RE);
  if (m) {
    const [, owner, name, subpath] = m as unknown as [string, string, string, string];
    return handleGitRequest(c, owner, name, subpath);
  }
  return next();
});

app.get('/healthz', (c) => c.text('ok'));

// Static assets are served ahead of web routes (web's /:owner/:repo
// catch-all would otherwise swallow /assets/*).
app.use('/assets/*', async (c, next) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  return next();
});

// Refreshed or cleared session cookies reach every response, whichever
// route resolved the session (routes/api.ts requestSession).
app.use('*', persistSessionCookies);

// Every session form post carries its CSRF token (architecture §11.1). Ahead
// of every router, so a page route mounted anywhere later is covered; only
// routes/pageCsrf.ts csrfExempt paths skip it.
app.use('*', sessionCsrf);

app.route('/auth', authRoutes);
app.route('/api/v1', api);
app.route('/api/v1', tenancyApi);
app.route('/api/v1', agentsApi);
app.route('/api/v1', branchRulesApi);
app.route('/api/v1', compareApi);
app.route('/api/v1', contentsApi);
app.route('/api/v1', eventsApi);
app.route('/api/v1', snapshotsApi);
app.route('/api/v1', changesApi);
app.route('/api/v1', reviewsApi);
// Before workspacesApi: `workspaces/overlap` would otherwise match `workspaces/:id`.
app.route('/api/v1', intentsApi);
app.route('/api/v1', dependenciesApi);
app.route('/api/v1', workspacesApi);
app.route('/api/v1', candidatesApi);
app.route('/api/v1', attributionApi);
app.route('/api/v1', issuesApi);
app.route('/api/v1', checksApi);
app.route('/api/v1', ciApi);
app.route('/api/v1', revertsApi);
app.route('/api/v1', containerRunnerApi);
app.route('/api/v1', fleetApi);
app.route('/api/v1', webhooksApi);
// MCP tool calls are dispatched back through this router to their REST routes.
app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, async (req) => app.fetch(req, c.env, c.executionCtx)));
app.route('/fleet', fleetPages);
app.route('/inbox', inboxPages);
app.route('/', web);
// Repo pages mount after the generic web routes: /new-repo, /import-repo and
// /settings/tokens are two-segment paths that must win over /:owner/:repo.
app.route('/:owner/:repo', fleetRepoPages);
// The issues, coordination and compare pages are further /:owner/:repo views;
// their paths (/issues, /activity, /train, /arenas, /candidates, /compare)
// collide with none of the pages above.
app.route('/:owner/:repo', issuePages);
app.route('/:owner/:repo', repoPages);
app.route('/:owner/:repo', coordinationPages);
app.route('/:owner/:repo', comparePages);
// The change page and its decide posts (/changes/...), issue #8.
app.route('/:owner/:repo', reviewPages);

// Static assets (public/*) as the final fallback.
app.all('*', async (c) => {
  // sessionCsrf may already have read a form post's body; assets never need it.
  const req = c.req.raw.bodyUsed ? new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers }) : c.req.raw;
  const res = await c.env.ASSETS.fetch(req);
  if (res.status === 404) {
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  return res;
});

/** Every mounted route, for the page CSRF coverage test (routes/pageCsrf.ts). */
export function platformRoutes(): ReadonlyArray<{ method: string; path: string; handler: unknown }> {
  return app.routes.map(({ method, path, handler }) => ({ method, path, handler }));
}

export function dispatchPlatformRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return serveMetered(request, env, ctx, async (req, e, cx) => {
    const response = await app.fetch(req, e, cx);
    return presentsCredential(req) ? withPrivateCacheControl(response) : response;
  });
}

export default {
  // Every response carries x-kvarm-cost (src/cost/meter.ts). Responses to a
  // presented credential are never shared-cacheable, on every transport.
  fetch: (request, env, ctx) =>
    dispatchPlatformRequest(request, env, ctx),
  // Artifacts push events, through the account-level event subscription
  // (services/events.ts).
  queue: (batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext) => handleEventBatch(batch, env),
  // One job per cron expression (cron.ts, scheduled.ts).
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    dispatchScheduled(controller.cron, env, ctx);
  },
} satisfies ExportedHandler<Env>;
