import { Hono } from 'hono';
import { GIT_PATH_RE, handleGitRequest } from './routes/git';
import { authRoutes } from './routes/auth';
import { api } from './routes/api';
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
import { checksApi } from './routes/api/checks';
import { ciApi } from './routes/api/ci';
import { flakesApi } from './routes/api/flakes';
import { containerRunnerApi } from './routes/api/containerRunner';
import { handleEventBatch } from './services/events';
import { handleMcp } from './mcp/server';
import { web } from './routes/web';
import { repoPages } from './routes/repoPages';
import { installFetchMeter, serveMetered } from './cost/meter';
import { presentsCredential, withPrivateCacheControl } from './cache/scope';

export { TokenCache, RateLimiter, MergeLock } from './do';
export { SnapshotBuilder, CiPipeline, MergeWorkflow, RepoImport } from './workflows';
export { CiRunnerSandbox } from './containers/ciRunnerSandbox';

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
app.route('/api/v1', checksApi);
app.route('/api/v1', ciApi);
app.route('/api/v1', flakesApi);
app.route('/api/v1', containerRunnerApi);
// MCP tool calls are dispatched back through this router to their REST routes.
app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, async (req) => app.fetch(req, c.env, c.executionCtx)));
app.route('/', web);
// Repo pages mount after the generic web routes: /new-repo, /import-repo and
// /settings/tokens are two-segment paths that must win over /:owner/:repo.
app.route('/:owner/:repo', repoPages);

// Static assets (public/*) as the final fallback.
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404) {
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  return res;
});

export default {
  // Every response carries x-kvarm-cost (src/cost/meter.ts). Responses to a
  // presented credential are never shared-cacheable, on every transport.
  fetch: (request, env, ctx) =>
    serveMetered(request, env, ctx, async (req, e, cx) => {
      const res = await app.fetch(req, e, cx);
      return presentsCredential(req) ? withPrivateCacheControl(res) : res;
    }),
  // Artifacts push events, through the account-level event subscription
  // (services/events.ts).
  queue: (batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext) => handleEventBatch(batch, env),
} satisfies ExportedHandler<Env>;
