import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { newSessionPayload, sessionCookie, type SessionPayload } from '../src/auth/workos';
import { toUserRow } from '../src/db/users';
import type { RepoRow } from '../src/db/repos';
import type { Actor } from '../src/services/authz';
import {
  createEnvironment,
  listEnvironments,
  requestEnvironmentBuild,
  type EnvironmentContext,
} from '../src/services/environments';
import {
  decideSandboxApproval,
  execSandbox,
  listMyPendingApprovals,
  listMySandboxes,
  startSandbox,
  stopSandbox,
  type SandboxContext,
} from '../src/services/sandboxes';
import { SANDBOX_PROVIDERS, type SandboxProvider } from '../src/services/sandboxes/provider';
import { runFleetSweeps } from '../src/services/sandboxes/sweeps';
import { promoteBuild } from '../src/workflows/environmentBuild';
import { getRepoById } from '../src/db/repos';
import worker from '../src/index';
import { environmentBuildEffect } from '../src/services/events';

const baseEnv = cfEnv as unknown as Env;
const OWNER = 'fleet-owner';
const scopes: Scope[] = ['read', 'write', 'api'];

class FakeWorkflow {
  created: string[] = [];
  async create(options: { id: string }) {
    this.created.push(options.id);
    return { id: options.id };
  }
}

let env: Env;
let owner: Actor;
let writer: Actor;
let outsider: Actor;
let ownerId = '';
let writerId = '';
let repo: RepoRow;
let startResponse: unknown;
const starts: Array<{ sandboxId: string; tokenId: string; refs: string[] }> = [];
let oldLinux: SandboxProvider;

const human = (user: Actor['user']): Actor => ({ user, via: 'session', scopes: null });

async function seedUser(login: string): Promise<Actor['user']> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `fleet:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Actor['user']>())!;
}

async function seedRepo(name = 'fleet'): Promise<RepoRow> {
  const id = crypto.randomUUID();
  const artifactsName = `${OWNER}--${name}`;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  return (await getRepoById(env.DB, id))!;
}

async function seedAgent(actor: Actor, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at)
     VALUES (?, 'user', ?, ?, ?, ?, ?)`,
  )
    .bind(id, actor.user.id, actor.user.login, name, actor.user.id, Date.now())
    .run();
  return id;
}

async function seedEnvironment(options: { ready?: boolean; policy?: string } = {}) {
  const id = crypto.randomUUID();
  const buildId = options.ready ? crypto.randomUUID() : null;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO environments
      (id, repo_id, name, os, base_ref, instance, allowed_hosts, command_policy, config_hash,
       ready_build_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'linux', 'main', 'standard-1', '["registry.npmjs.org"]', ?, 'config', ?, ?, ?, ?)`,
  )
    .bind(id, repo.id, `env-${id.slice(0, 8)}`, options.policy ?? '{"deny":[],"approve":[]}', buildId, ownerId, now, now)
    .run();
  if (buildId) {
    await env.DB.prepare(
      `INSERT INTO environment_builds
        (id, environment_id, repo_id, seq, status, reason, config_hash, snapshot_id, phases, output_tail, created_at, finished_at)
       VALUES (?, ?, ?, 1, 'ready', 'create', 'config', 'build-snapshot', '{}', '', ?, ?)`,
    )
      .bind(buildId, id, repo.id, now, now)
      .run();
  }
  return { id, buildId };
}

async function seedWorkspace(agentId: string, createdBy = ownerId) {
  const id = crypto.randomUUID();
  const ref = `refs/heads/agents/${id}/fleet`;
  await env.DB.prepare(
    `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, created_at, ref, created_by, agent_id)
     VALUES (?, ?, ?, 'fleet test', 'agent', 'active', ?, ?, ?, ?)`,
  )
    .bind(id, repo.id, repo.artifacts_name, Date.now(), ref, createdBy, agentId)
    .run();
  return { id, ref };
}

async function seedSandbox(options: {
  agentId: string;
  environmentId: string;
  buildId: string;
  workspaceId: string;
  owner?: string;
  status?: 'running' | 'sleeping';
  tokenId?: string | null;
  expiresAt?: number;
}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sandboxes
      (id, repo_id, environment_id, build_id, workspace_id, owner_user_id, agent_id, token_id, status,
       task, last_active_at, expires_at, run_expires_at, sleep_snapshot_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, repo.id, options.environmentId, options.buildId, options.workspaceId, options.owner ?? ownerId,
      options.agentId, options.tokenId ?? null, options.status ?? 'running', now,
      options.expiresAt ?? now + 25 * 86400_000, now + 86400_000,
      options.status === 'sleeping' ? 'sleep-snapshot' : null, now,
    )
    .run();
  return id;
}

function sandboxContext(actor: Actor): SandboxContext {
  return { env, repo, actor, origin: 'https://kvarm.test', waitUntil: () => undefined };
}

beforeAll(async () => {
  const workflow = new FakeWorkflow();
  env = { ...baseEnv, ENVIRONMENT_BUILD: workflow as unknown as Env['ENVIRONMENT_BUILD'] } as Env;
  const ownerUser = await seedUser(OWNER);
  const writerUser = await seedUser('fleet-writer');
  const outsiderUser = await seedUser('fleet-outsider');
  ownerId = ownerUser.id;
  writerId = writerUser.id;
  owner = human(ownerUser);
  writer = human(writerUser);
  outsider = human(outsiderUser);
  repo = await seedRepo();
  await env.DB.prepare(
    `INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at)
     VALUES (?, ?, 'write', ?, ?, ?)`,
  )
    .bind(repo.id, writerId, ownerId, Date.now(), Date.now())
    .run();
  oldLinux = SANDBOX_PROVIDERS.linux!;
  SANDBOX_PROVIDERS.linux = {
    ...oldLinux,
    agentSandbox: (boundEnv, sandboxId) => ({
      start: async (request) => {
        starts.push({ sandboxId, tokenId: request.tokenId, refs: JSON.parse(
          await boundEnv.DB.prepare('SELECT refs FROM agent_tokens WHERE id = ?').bind(request.tokenId).first<{ refs: string }>().then((row) => row?.refs ?? '[]'),
        ) as string[] });
        return startResponse;
      },
      sleep: async () => {
        const row = await boundEnv.DB.prepare('SELECT token_id FROM sandboxes WHERE id = ?').bind(sandboxId).first<{ token_id: string | null }>();
        await boundEnv.DB.batch([
          boundEnv.DB.prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").bind(row?.token_id, Date.now()),
          boundEnv.DB.prepare("UPDATE sandboxes SET status = 'sleeping', token_id = NULL, sleep_snapshot_id = 'sleep-snapshot' WHERE id = ?1").bind(sandboxId),
        ]);
        return { ok: true, value: { sleeping: true, snapshotId: 'sleep-snapshot' } };
      },
      discard: async () => {
        const row = await boundEnv.DB.prepare('SELECT token_id FROM sandboxes WHERE id = ?').bind(sandboxId).first<{ token_id: string | null }>();
        await boundEnv.DB.batch([
          boundEnv.DB.prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").bind(row?.token_id, Date.now()),
          boundEnv.DB.prepare("UPDATE sandboxes SET status = 'stopped', token_id = NULL, sleep_snapshot_id = NULL WHERE id = ?1").bind(sandboxId),
        ]);
        return { ok: true, value: { stopped: true } };
      },
      exec: async () => ({ ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' }),
      readFile: async () => ({ ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' }),
      writeFile: async () => ({ ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' }),
      egressCredential: async () => null,
    }),
  };
  startResponse = { ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' };
});

afterAll(() => {
  SANDBOX_PROVIDERS.linux = oldLinux;
});

describe('fleet services', () => {
  it('authorizes environment CRUD, rejects non-Linux, and keeps read costs bounded', async () => {
    const cx: EnvironmentContext = { env, repo, actor: owner };
    const created = await createEnvironment(cx, { name: `env-${crypto.randomUUID().slice(0, 8)}` });
    expect(created.ok).toBe(true);
    expect((await createEnvironment({ ...cx, actor: writer }, { name: 'writer-env' })).ok).toBe(false);
    const agentId = await seedAgent(owner, `agent-${crypto.randomUUID()}`);
    const agent: Actor = { ...owner, agent: { agentId, agentName: 'fleet-agent', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: ['refs/heads/agents/**'], expiresAt: Date.now() + 60_000 } };
    const forbidden = await createEnvironment({ ...cx, actor: agent }, { name: 'agent-env' });
    expect(forbidden).toMatchObject({ ok: false, status: 403, code: 'AGENT_FORBIDDEN' });
    expect(await createEnvironment(cx, { name: 'bad-os', os: 'macos' })).toMatchObject({ ok: false, status: 422, code: 'OS_UNAVAILABLE' });
    expect((await createEnvironment({ ...cx, actor: outsider }, { name: 'outsider-env' })).ok).toBe(false);
    expect(await listEnvironments(env, repo, writer)).toMatchObject({ ok: true });
    const pat = (await mintPAT(env, ownerId, 'fleet-cost', scopes)).token;
    const response = await worker.fetch(
      new Request(`https://kvarm.test/api/v1/repos/${OWNER}/fleet/environments`, {
        headers: { Authorization: `Bearer ${pat}` },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.headers.get('x-kvarm-cost')).toBeTruthy();
  });

  it('coalesces builds and supersedes the previous ready build on promotion', async () => {
    const { id: environmentId } = await seedEnvironment();
    const first = await requestEnvironmentBuild(env, environmentId, 'manual');
    const second = await requestEnvironmentBuild(env, environmentId, 'push');
    expect(first.ok && second.ok && first.value.id).toBe(second.ok ? second.value.id : '');
    expect((await env.DB.prepare('SELECT pending FROM environments WHERE id = ?').bind(environmentId).first<{ pending: number }>())?.pending).toBe(1);
    await env.DB.prepare("UPDATE environment_builds SET status = 'superseded' WHERE id = ?").bind(first.ok ? first.value.id : '').run();
    const oldId = crypto.randomUUID();
    const buildId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO environment_builds (id, environment_id, repo_id, seq, status, reason, config_hash, phases, output_tail, created_at) VALUES (?, ?, ?, 5, 'ready', 'create', 'config', '{}', '', ?)`).bind(oldId, environmentId, repo.id, now).run();
    await env.DB.prepare(`INSERT INTO environment_builds (id, environment_id, repo_id, seq, status, reason, config_hash, phases, output_tail, created_at) VALUES (?, ?, ?, 6, 'building', 'manual', 'config', '{}', '', ?)`).bind(buildId, environmentId, repo.id, now).run();
    const build = await env.DB.prepare('SELECT * FROM environment_builds WHERE id = ?').bind(buildId).first<any>();
    expect(await promoteBuild(env, build, { id: 'snapshot-new', size: 9 }, {}, '')).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM environment_builds WHERE id = ?').bind(oldId).first()).toMatchObject({ status: 'superseded' });
    expect(await env.DB.prepare('SELECT ready_build_id FROM environments WHERE id = ?').bind(environmentId).first()).toMatchObject({ ready_build_id: buildId });
  });

  it('requests push builds only when rebuild paths are touched', async () => {
    const workflow = env.ENVIRONMENT_BUILD as unknown as FakeWorkflow;
    const previousRepo = repo;
    repo = await seedRepo('fleet-push');
    try {
    const { id: environmentId } = await seedEnvironment();
    const initialBuildRequests = workflow.created.length;
    const unchanged = {
      env,
      repoId: repo.id,
      event: { ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'a'.repeat(40) },
    } as Parameters<typeof environmentBuildEffect.run>[0];
    expect((await environmentBuildEffect.run(unchanged)).state).toBe('skipped');
    expect(workflow.created).toHaveLength(initialBuildRequests);
    await env.DB.prepare('UPDATE environments SET rebuild_paths = ?2 WHERE id = ?1')
      .bind(environmentId, '["package-lock.json"]')
      .run();
    const truncatedDiff = {
      ...unchanged,
      event: { ...unchanged.event, before: 'a'.repeat(40), after: '0'.repeat(40) },
    } as Parameters<typeof environmentBuildEffect.run>[0];
    expect(await environmentBuildEffect.run(truncatedDiff)).toMatchObject({ state: 'done' });
    expect(workflow.created).toHaveLength(initialBuildRequests + 1);
    } finally {
      repo = previousRepo;
    }
  });

  it('starts only from a ready build and cleans up the scoped token on container failure', async () => {
    const notReady = await seedEnvironment();
    expect(await startSandbox(sandboxContext(owner), { environment: notReady.id })).toMatchObject({ ok: false, status: 409, code: 'ENVIRONMENT_NOT_READY' });
    const agentId = await seedAgent(owner, `start-${crypto.randomUUID()}`);
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'start', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: ['refs/heads/agents/**'], expiresAt: Date.now() + 60_000 } };
    const ready = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    starts.length = 0;
    startResponse = { ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' };
    const result = await startSandbox(sandboxContext(actor), { environment: ready.id, workspace: workspace.id });
    expect(result).toMatchObject({ ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE' });
    expect(starts[0]?.refs).toEqual([workspace.ref]);
    const row = await env.DB.prepare('SELECT status, token_id, workspace_id FROM sandboxes WHERE id = ?').bind(starts[0]?.sandboxId).first<any>();
    expect(row).toMatchObject({ status: 'failed', token_id: null, workspace_id: workspace.id });
    expect(await env.DB.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').bind(starts[0]?.tokenId).first<{ revoked_at: number }>()).toMatchObject({ revoked_at: expect.any(Number) });
  });

  it('resumes the same sleeping sandbox, rotates tokens, supports fresh and agent-scoped ownership', async () => {
    const agentId = await seedAgent(owner, `resume-${crypto.randomUUID()}`);
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'resume', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: ['refs/heads/agents/**'], expiresAt: Date.now() + 60_000 } };
    const environment = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    const previousToken = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO agent_tokens (id, agent_id, name, prefix, hash, repo_id, role, refs, created_by, created_at, expires_at) VALUES (?, ?, 'old', 'old', ?, ?, 'write', ?, ?, ?, ?)`)
      .bind(previousToken, agentId, crypto.randomUUID(), repo.id, JSON.stringify([workspace.ref]), ownerId, Date.now(), Date.now() + 60_000).run();
    const id = await seedSandbox({ agentId, environmentId: environment.id, buildId: environment.buildId!, workspaceId: workspace.id, status: 'sleeping' });
    await env.DB.prepare('UPDATE sandboxes SET build_id = ?2, token_id = ?3 WHERE id = ?1').bind(id, environment.buildId, previousToken).run();
    await env.DB.prepare('UPDATE environments SET ready_build_id = ?2 WHERE id = ?1').bind(environment.id, crypto.randomUUID()).run();
    startResponse = { ok: true, value: { started: true, localDiverged: false } };
    const resumed = await startSandbox(sandboxContext(actor), { environment: environment.id });
    expect(resumed.ok && resumed.value).toMatchObject({ id, status: 'running', resumed: true, startedFrom: 'resume', buildOutdated: true, repo: `${OWNER}/fleet`, environmentName: expect.any(String), repoDirectory: '/workspace/fleet', pushRef: workspace.ref });
    expect(starts.at(-1)?.sandboxId).toBe(id);
    expect(await env.DB.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').bind(previousToken).first<{ revoked_at: number }>()).toMatchObject({ revoked_at: expect.any(Number) });
    const fresh = await startSandbox(sandboxContext(actor), { environment: environment.id, workspace: workspace.id, fresh: true });
    expect(fresh.ok && fresh.value.id).not.toBe(id);
    await env.DB.prepare('UPDATE environments SET ready_build_id = ?2 WHERE id = ?1').bind(environment.id, environment.buildId).run();
    const otherAgentId = await seedAgent(owner, `other-${crypto.randomUUID()}`);
    const other: Actor = { ...actor, agent: { ...actor.agent!, agentId: otherAgentId } };
    expect(await startSandbox(sandboxContext(other), { environment: environment.id, workspace: workspace.id })).toMatchObject({ ok: false, status: 403 });
  });

  it('sleeps by default, discards on request, filters ownership, and expires sleeping rows in cron', async () => {
    const agentId = await seedAgent(owner, `stop-${crypto.randomUUID()}`);
    const environment = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    const tokenId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO agent_tokens (id, agent_id, name, prefix, hash, repo_id, role, refs, created_by, created_at, expires_at) VALUES (?, ?, 'run', 'run', ?, ?, 'write', ?, ?, ?, ?)`)
      .bind(tokenId, agentId, crypto.randomUUID(), repo.id, JSON.stringify([workspace.ref]), ownerId, Date.now(), Date.now() + 60_000).run();
    const id = await seedSandbox({ agentId, environmentId: environment.id, buildId: environment.buildId!, workspaceId: workspace.id, tokenId });
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'stop', ownerLogin: OWNER, ownerKind: 'user', tokenId, repoId: repo.id, role: 'write', refs: [workspace.ref], expiresAt: Date.now() + 60_000 } };
    expect((await stopSandbox(sandboxContext(actor), id)).ok).toBe(true);
    expect(await env.DB.prepare('SELECT status, token_id FROM sandboxes WHERE id = ?').bind(id).first()).toMatchObject({ status: 'sleeping', token_id: null });
    expect((await stopSandbox(sandboxContext(actor), id, { discard: true })).ok).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM sandboxes WHERE id = ?').bind(id).first()).toMatchObject({ status: 'stopped' });
    const pendingId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO sandbox_approvals (id, sandbox_id, repo_id, command, requested_by, status, created_at, expires_at) VALUES (?, ?, ?, 'npm install', ?, 'pending', ?, ?)`)
      .bind(pendingId, id, repo.id, ownerId, Date.now(), Date.now() + 60_000).run();
    expect(await listMyPendingApprovals(env, owner)).toMatchObject({ ok: true, value: [{ repo: `${OWNER}/fleet`, sandboxId: id }] });
    expect(await decideSandboxApproval(sandboxContext(actor), pendingId, 'approve')).toMatchObject({ ok: false, status: 403, code: 'AGENT_FORBIDDEN' });
    expect(await decideSandboxApproval(sandboxContext(owner), pendingId, 'approve')).toMatchObject({ ok: true, value: { status: 'approved', repo: `${OWNER}/fleet`, sandboxId: id } });
    const expired = await seedSandbox({ agentId, environmentId: environment.id, buildId: environment.buildId!, workspaceId: workspace.id, status: 'sleeping', expiresAt: Date.now() - 1 });
    await runFleetSweeps(env,);
    expect(await env.DB.prepare('SELECT status FROM sandboxes WHERE id = ?').bind(expired).first()).toMatchObject({ status: 'stopped' });
    const otherAgentId = await seedAgent(owner, `human-list-${crypto.randomUUID()}`);
    const otherWorkspace = await seedWorkspace(otherAgentId);
    const otherSandbox = await seedSandbox({ agentId: otherAgentId, environmentId: environment.id, buildId: environment.buildId!, workspaceId: otherWorkspace.id });
    const humanList = await listMySandboxes(env, owner);
    expect(humanList.ok && humanList.value.sandboxes.map((sandbox) => sandbox.id)).toContain(otherSandbox);
    const agentList = await listMySandboxes(env, actor);
    expect(agentList.ok && agentList.value.sandboxes.every((sandbox) => sandbox.agentId === agentId)).toBe(true);
  });

  it('applies deny and approval policy before execution and rejects a different owner', async () => {
    const agentId = await seedAgent(owner, `policy-${crypto.randomUUID()}`);
    const policy = await seedEnvironment({ ready: true, policy: '{"deny":["rm *"],"approve":["npm install"]}' });
    const workspace = await seedWorkspace(agentId);
    const id = await seedSandbox({ agentId, environmentId: policy.id, buildId: policy.buildId!, workspaceId: workspace.id });
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'policy', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: [workspace.ref], expiresAt: Date.now() + 60_000 } };
    expect(await execSandbox(sandboxContext(actor), id, { command: 'rm -rf /tmp/x' })).toMatchObject({ ok: false, status: 403, code: 'COMMAND_DENIED' });
    const approval = await execSandbox(sandboxContext(actor), id, { command: 'npm install' });
    expect(approval).toMatchObject({ ok: false, status: 409, code: 'APPROVAL_REQUIRED' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sandbox_commands WHERE sandbox_id = ?').bind(id).first()).toMatchObject({ n: 2 });
    expect(await execSandbox(sandboxContext(writer), id, { command: 'npm test' })).toMatchObject({ ok: false, status: 403, code: 'SANDBOX_NOT_OWNED' });
  });
});

describe('fleet pages: session CSRF (architecture §11.1)', () => {
  const ORIGIN = 'https://kvarm.test';
  const BASE = `/${OWNER}/fleet`;
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  let authEnv: Env;
  let payload: SessionPayload;
  let otherPayload: SessionPayload;
  let cookie = '';

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
    const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, authEnv, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }

  const browser = (path: string, init: RequestInit = {}) =>
    send(path, { ...init, headers: { cookie, ...(init.headers as Record<string, string>) } });

  /** A session post from `origin`; an undefined `csrf` leaves the field out. */
  const post = (path: string, body: string, csrf?: string, origin = ORIGIN) =>
    browser(path, {
      method: 'POST',
      headers: { ...form, origin },
      body: csrf === undefined ? body : `_csrf=${encodeURIComponent(csrf)}${body ? `&${body}` : ''}`,
    });

  /** The page renders each of `actions` as a post form, and every post form on it carries this session's token. */
  function expectTokenForms(text: string, actions: string[]) {
    const forms = text.match(/<form method="post"[\s\S]*?<\/form>/g) ?? [];
    for (const action of actions) expect(forms.some((f) => f.includes(`action="${action}"`)), action).toBe(true);
    for (const f of forms) expect(f).toContain(`name="_csrf" value="${payload.csrf}"`);
  }

  beforeAll(async () => {
    authEnv = {
      ...env,
      WORKOS_CLIENT_ID: 'client_fake',
      WORKOS_API_KEY: 'sk_fake_not_a_real_key',
      WORKOS_COOKIE_PASSWORD: 'test-cookie-password-0123456789abcdef',
    } as Env;
    payload = await signedIn(ownerId);
    // Another live session of the same user: its token must not stand in for this one's.
    otherPayload = await signedIn(ownerId);
    cookie = (await sessionCookie(authEnv, payload)).split(';')[0]!;
  });

  async function seedRunningSandbox() {
    const agentId = await seedAgent(owner, `csrf-${crypto.randomUUID()}`);
    const environment = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    const id = await seedSandbox({ agentId, environmentId: environment.id, buildId: environment.buildId!, workspaceId: workspace.id });
    return { id, environment };
  }

  const sandboxStatus = async (id: string) =>
    (await env.DB.prepare('SELECT status FROM sandboxes WHERE id = ?').bind(id).first<{ status: string }>())?.status;

  it('refuses an environment create without the session token and writes nothing', async () => {
    const page = await browser(`${BASE}/environments/new`);
    expect(page.status).toBe(200);
    expectTokenForms(page.text, [`${BASE}/environments`]);
    const name = `csrf-${crypto.randomUUID().slice(0, 8)}`;
    const rows = async () =>
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM environments WHERE repo_id = ? AND name = ?').bind(repo.id, name).first<{ n: number }>())?.n;
    const body = `name=${name}&baseRef=main&instance=standard-1&idleMinutes=30&maxBuildAgeHours=72`;

    expect((await post(`${BASE}/environments`, body)).status).toBe(403);
    expect((await post(`${BASE}/environments`, body, '')).status).toBe(403);
    expect((await post(`${BASE}/environments`, body, otherPayload.csrf)).status).toBe(403);
    // Cross-origin the session does not count: the browser is anonymous and the private repository is hidden.
    expect((await post(`${BASE}/environments`, body, payload.csrf, 'https://evil.test')).status).toBe(404);
    expect(await rows()).toBe(0);

    const created = await post(`${BASE}/environments`, body, payload.csrf);
    expect(created.status, created.text).toBe(302);
    expect(created.location).toBe(`${BASE}/environments/${name}`);
    expect(await rows()).toBe(1);
  });

  it('refuses environment edit, rebuild and archive without the session token', async () => {
    const { id } = await seedEnvironment({ ready: true });
    const row = () =>
      env.DB.prepare('SELECT name, instance, pending, archived_at FROM environments WHERE id = ?').bind(id).first<{ name: string; instance: string; pending: number; archived_at: number | null }>();
    const builds = async () =>
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM environment_builds WHERE environment_id = ?').bind(id).first<{ n: number }>())?.n;
    const before = (await row())!;
    const buildsBefore = await builds();
    const envBase = `${BASE}/environments/${before.name}`;

    const detail = await browser(envBase);
    expect(detail.status).toBe(200);
    expectTokenForms(detail.text, [`${envBase}/rebuild`, `${envBase}/archive`]);
    expectTokenForms((await browser(`${envBase}/edit`)).text, [envBase]);

    const edit = 'baseRef=main&instance=standard-2&idleMinutes=30&maxBuildAgeHours=72';
    for (const [path, body] of [[envBase, edit], [`${envBase}/rebuild`, ''], [`${envBase}/archive`, '']] as const) {
      expect((await post(path, body)).status, path).toBe(403);
      expect((await post(path, body, otherPayload.csrf)).status, path).toBe(403);
      expect((await post(path, body, payload.csrf, 'https://evil.test')).status, path).toBe(404);
    }
    expect(await row()).toEqual(before);
    expect(await builds()).toBe(buildsBefore);

    const rebuilt = await post(`${envBase}/rebuild`, '', payload.csrf);
    expect(rebuilt.status).toBe(302);
    expect(rebuilt.location).toContain('rebuilt=1');
    expect(await builds()).toBe(buildsBefore! + 1);
    expect((await post(envBase, edit, payload.csrf)).status).toBe(302);
    expect((await row())?.instance).toBe('standard-2');
    expect((await post(`${envBase}/archive`, '', payload.csrf)).status).toBe(302);
    expect((await row())?.archived_at).toEqual(expect.any(Number));
  });

  it('refuses a sandbox stop or discard without the session token and leaves the sandbox running', async () => {
    const { id } = await seedRunningSandbox();
    const page = await browser(`${BASE}/sandboxes/${id}`);
    expect(page.status).toBe(200);
    expectTokenForms(page.text, [`${BASE}/sandboxes/${id}/stop`, `${BASE}/sandboxes/${id}/discard`]);
    expectTokenForms((await browser('/fleet')).text, [`${BASE}/sandboxes/${id}/stop`, `${BASE}/sandboxes/${id}/discard`]);

    for (const action of ['stop', 'discard']) {
      expect((await post(`${BASE}/sandboxes/${id}/${action}`, '')).status, action).toBe(403);
      expect((await post(`${BASE}/sandboxes/${id}/${action}`, '', otherPayload.csrf)).status, action).toBe(403);
      expect((await post(`${BASE}/sandboxes/${id}/${action}`, '', payload.csrf, 'https://evil.test')).status, action).toBe(404);
    }
    expect(await sandboxStatus(id)).toBe('running');
    // A multipart post with no boundary cannot be parsed: refused as tokenless, not a 500.
    const unparseable = await browser(`${BASE}/sandboxes/${id}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data', origin: ORIGIN },
      body: 'x',
    });
    expect(unparseable.status).toBe(403);
    expect(await sandboxStatus(id)).toBe('running');

    expect((await post(`${BASE}/sandboxes/${id}/stop`, '', payload.csrf)).status).toBe(302);
    expect(await sandboxStatus(id)).toBe('sleeping');
    // A malformed Referer must not turn the completed discard into an error.
    const discarded = await browser(`${BASE}/sandboxes/${id}/discard`, {
      method: 'POST',
      headers: { ...form, origin: ORIGIN, referer: 'not a url' },
      body: `_csrf=${encodeURIComponent(payload.csrf)}`,
    });
    expect(discarded.status).toBe(302);
    expect(discarded.location).toBe('/fleet');
    expect(await sandboxStatus(id)).toBe('stopped');
  });

  it('refuses an approval decision without the session token and keeps it pending', async () => {
    const { id: sandboxId } = await seedRunningSandbox();
    const approvalId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO sandbox_approvals (id, sandbox_id, repo_id, command, requested_by, status, created_at, expires_at) VALUES (?, ?, ?, 'npm publish', ?, 'pending', ?, ?)`)
      .bind(approvalId, sandboxId, repo.id, ownerId, Date.now(), Date.now() + 60_000).run();
    const status = async () =>
      (await env.DB.prepare('SELECT status FROM sandbox_approvals WHERE id = ?').bind(approvalId).first<{ status: string }>())?.status;

    expectTokenForms((await browser('/fleet')).text, [`/fleet/approvals/${approvalId}`]);
    expectTokenForms((await browser(`${BASE}/sandboxes/${sandboxId}`)).text, [`/fleet/approvals/${approvalId}`]);

    const body = `repo=${encodeURIComponent(`${OWNER}/fleet`)}&decision=approve`;
    expect((await post(`/fleet/approvals/${approvalId}`, body)).status).toBe(403);
    expect((await post(`/fleet/approvals/${approvalId}`, body, otherPayload.csrf)).status).toBe(403);
    // Cross-origin the session does not count, and a decision needs one.
    const cross = await post(`/fleet/approvals/${approvalId}`, body, payload.csrf, 'https://evil.test');
    expect(cross.status).toBe(302);
    expect(cross.location).toContain('/auth/sign-in');
    expect(await status()).toBe('pending');

    const approved = await post(`/fleet/approvals/${approvalId}`, body, payload.csrf);
    expect(approved.status).toBe(302);
    expect(approved.location).toBe('/fleet');
    expect(await status()).toBe('approved');
  });

  describe('refused approval decisions', () => {
    async function seedApproval(status: string, expiresAt = Date.now() + 60_000) {
      const { id: sandboxId } = await seedRunningSandbox();
      const approvalId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO sandbox_approvals (id, sandbox_id, repo_id, command, requested_by, status, created_at, expires_at) VALUES (?, ?, ?, 'npm publish', ?, ?, ?, ?)`)
        .bind(approvalId, sandboxId, repo.id, ownerId, status, Date.now() - 1000, expiresAt).run();
      return approvalId;
    }
    const row = (id: string) => env.DB.prepare('SELECT * FROM sandbox_approvals WHERE id = ?').bind(id).first();
    const decide = (id: string, decision: string) =>
      post(`/fleet/approvals/${id}`, `repo=${encodeURIComponent(`${OWNER}/fleet`)}${decision ? `&decision=${decision}` : ''}`, payload.csrf);

    it('shows the service error for an already-decided approval and changes nothing', async () => {
      const id = await seedApproval('approved');
      const before = await row(id);
      const res = await decide(id, 'deny');
      expect(res.status).toBe(404);
      expect(res.text).toContain('pending sandbox approval not found');
      expect(res.text).toContain('APPROVAL_NOT_FOUND');
      expect(await row(id)).toEqual(before);
    });

    it('shows the service error for an expired approval and changes nothing', async () => {
      const id = await seedApproval('pending', Date.now() - 1000);
      const before = await row(id);
      const res = await decide(id, 'approve');
      expect(res.status).toBe(404);
      expect(res.text).toContain('APPROVAL_NOT_FOUND');
      expect(await row(id)).toEqual(before);
    });

    it('answers 400 for a missing or unknown decision instead of denying', async () => {
      const id = await seedApproval('pending');
      const before = await row(id);
      for (const decision of ['', 'maybe', 'APPROVE']) {
        const res = await decide(id, decision);
        expect(res.status, decision).toBe(400);
        expect(res.text).toContain('Choose approve or deny');
      }
      expect(await row(id)).toEqual(before);
    });

    it('shows an error rather than a bare 404 when the repo field is missing', async () => {
      const id = await seedApproval('pending');
      const res = await post(`/fleet/approvals/${id}`, 'decision=approve', payload.csrf);
      expect(res.status).toBe(404);
      expect(res.text).toContain('Open the fleet page again');
      expect(await row(id)).toMatchObject({ status: 'pending' });
    });

    it('still redirects to the fleet page on success', async () => {
      const id = await seedApproval('pending');
      const res = await decide(id, 'deny');
      expect(res.status).toBe(302);
      expect(res.location).toBe('/fleet');
      expect(await row(id)).toMatchObject({ status: 'denied' });
    });
  });

  it('still accepts bearer-token posts without a CSRF token', async () => {
    const pat = (await mintPAT(env, ownerId, 'fleet-pages', scopes)).token;
    const bearer = (path: string) =>
      send(path, { method: 'POST', headers: { ...form, authorization: `Bearer ${pat}` }, body: '' });
    const { id: environmentId } = await seedEnvironment({ ready: true });
    const name = (await env.DB.prepare('SELECT name FROM environments WHERE id = ?').bind(environmentId).first<{ name: string }>())!.name;
    const rebuilt = await bearer(`${BASE}/environments/${name}/rebuild`);
    expect(rebuilt.status).toBe(302);
    expect(rebuilt.location).toContain('rebuilt=1');
    const { id } = await seedRunningSandbox();
    expect((await bearer(`${BASE}/sandboxes/${id}/discard`)).status).toBe(302);
    expect(await sandboxStatus(id)).toBe('stopped');
  });
});
