import { describe, expect, it } from 'vitest';
import {
  OPERATIONS,
  OperationInputError,
  buildRequest,
  findCommand,
  findOperation,
  requestTarget,
} from '../src/index.js';

const ORIGINAL_AVAILABLE = [
  'list_repos',
  'get_tree',
  'read_file',
  'compare',
  'get_file_diff',
  'create_workspace',
  'create_change_set',
  'get_change',
  'merge_change',
  'enqueue_change',
  'get_attribution',
  'set_attribution',
  'get_context',
  'list_tasks',
  'claim_task',
  'complete_task',
];

describe('operation registry', () => {
  it('is a finite list with unique tool names and CLI commands', () => {
    expect(OPERATIONS.length).toBeGreaterThan(0);
    const names = OPERATIONS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    const commands = OPERATIONS.map((o) => o.command.join(' '));
    expect(new Set(commands).size).toBe(commands.length);
    for (const op of OPERATIONS) {
      expect(op.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(op.command.length).toBe(2);
      for (const w of op.command) expect(w).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(op.description.length).toBeGreaterThan(20);
      expect(op.family.length).toBeGreaterThan(0);
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(op.method);
      expect(op.readOnly).toBe(op.method === 'GET');
    }
  });

  it('contains the original tools whose services exist', () => {
    const names = new Set(OPERATIONS.map((o) => o.name));
    for (const n of ORIGINAL_AVAILABLE) expect(names, n).toContain(n);
    expect(names).not.toContain('get_audit');
  });

  it('covers every implemented operation family', () => {
    const families = new Set(OPERATIONS.map((o) => o.family));
    for (const f of ['repos', 'content', 'compare', 'workspaces', 'changes', 'nexus', 'candidates', 'orgs', 'agents', 'branch-rules', 'attribution', 'queue', 'tasks', 'reviews', 'dependencies', 'flakes']) {
      expect(families, f).toContain(f);
    }
    expect(findOperation('list_tasks')).toMatchObject({ command: ['task', 'list'], method: 'GET', path: '/repos/{repo}/tasks', readOnly: true });
    expect(findOperation('list_tasks')?.params.map((p) => p.name)).toEqual(['repo', 'status', 'kind', 'limit', 'cursor']);
    expect(findOperation('claim_task')).toMatchObject({ command: ['task', 'claim'], method: 'POST', path: '/repos/{repo}/tasks/{task}/claim', readOnly: false });
    expect(findOperation('complete_task')).toMatchObject({ command: ['task', 'complete'], method: 'POST', path: '/repos/{repo}/tasks/{task}/complete', readOnly: false });
    expect(findCommand(['task', 'heartbeat'])?.name).toBe('heartbeat_task');
    expect(findCommand(['task', 'get'])?.name).toBe('get_task');
    // Arena ranking is reachable as a tool (VAL-CROSS-012).
    expect(findOperation('rank_arena')?.path).toBe('/repos/{repo}/arenas/{id}/candidates');
    expect(findOperation('list_flakes')).toMatchObject({ command: ['flake', 'list'], method: 'GET', path: '/repos/{repo}/flakes', readOnly: true });
    expect(findOperation('quarantine_check')).toMatchObject({ command: ['flake', 'quarantine'], method: 'POST', path: '/repos/{repo}/flakes/{check}/quarantine' });
    expect(findOperation('restore_check')).toMatchObject({ command: ['flake', 'restore'], method: 'POST', path: '/repos/{repo}/flakes/{check}/restore' });
  });

  it('registers review, approval and escalation operations', () => {
    expect(findOperation('review_change')).toMatchObject({ command: ['review', 'submit'], method: 'POST', path: '/repos/{repo}/changes/{number}/reviews', family: 'reviews' });
    expect(findOperation('review_change')?.params.map((p) => p.name)).toEqual(['repo', 'number', 'verdict', 'headSha', 'body']);
    expect(findOperation('approve_change')).toMatchObject({ command: ['review', 'approve'], method: 'POST', path: '/repos/{repo}/changes/{number}/approve' });
    expect(findOperation('request_changes')).toMatchObject({ command: ['review', 'request-changes'], method: 'POST', path: '/repos/{repo}/changes/{number}/request-changes' });
    expect(findOperation('get_reviews')).toMatchObject({ command: ['review', 'get'], method: 'GET', path: '/repos/{repo}/changes/{number}/reviews', readOnly: true });
    expect(findOperation('list_pending_reviews')).toMatchObject({ command: ['review', 'pending'], path: '/repos/{repo}/reviews/pending', readOnly: true });
    expect(findOperation('assign_reviewer')).toMatchObject({ command: ['review', 'assign'], path: '/repos/{repo}/changes/{number}/reviewers/assign' });
    expect(findOperation('resolve_escalation')).toMatchObject({ command: ['review', 'resolve'], path: '/repos/{repo}/changes/{number}/escalations/{id}/resolve' });
    expect(findOperation('get_review_policy')).toMatchObject({ command: ['review-policy', 'get'], method: 'GET', path: '/repos/{repo}/review-policy' });
    expect(findOperation('set_review_policy')).toMatchObject({ command: ['review-policy', 'set'], method: 'PUT', path: '/repos/{repo}/review-policy' });
    expect(findOperation('create_agent')?.params.map((p) => p.name)).toContain('modelFamily');
    const req = buildRequest(findOperation('approve_change')!, { repo: 'o/r', number: 3, headSha: 'a'.repeat(40) });
    expect([req.method, req.path, req.body]).toEqual(['POST', '/api/v1/repos/o/r/changes/3/approve', { headSha: 'a'.repeat(40) }]);
  });

  it('registers the dependency, train status and recovery operations', () => {
    const deps = '/repos/{repo}/workspaces/{workspace}/dependencies';
    expect(findOperation('add_dependency')).toMatchObject({ command: ['deps', 'add'], method: 'POST', path: deps, family: 'dependencies', readOnly: false });
    expect(findOperation('list_dependencies')).toMatchObject({ command: ['deps', 'list'], method: 'GET', path: deps, readOnly: true });
    expect(findOperation('repin_dependency')).toMatchObject({ command: ['deps', 'repin'], method: 'POST', path: `${deps}/{dependency}/repin` });
    expect(findOperation('detach_dependency')).toMatchObject({ command: ['deps', 'detach'], method: 'DELETE', path: `${deps}/{dependency}`, destructive: true });
    expect(findOperation('get_train')).toMatchObject({ command: ['train', 'status'], method: 'GET', path: '/repos/{repo}/train', family: 'queue', readOnly: true });
    const sha = 'c'.repeat(40);
    expect(buildRequest(findOperation('add_dependency')!, { repo: 'o/r', workspace: 'ab12', onWorkspace: 'cd34', revision: sha })).toEqual({
      method: 'POST',
      path: '/api/v1/repos/o/r/workspaces/ab12/dependencies',
      query: '',
      body: { onWorkspace: 'cd34', revision: sha },
    });
    expect(() => buildRequest(findOperation('add_dependency')!, { repo: 'o/r', workspace: 'ab12', revision: sha })).toThrow(/onWorkspace.*required/);
    expect(buildRequest(findOperation('repin_dependency')!, { repo: 'o/r', workspace: 'ab12', dependency: 'e1', revision: sha })).toMatchObject({
      path: '/api/v1/repos/o/r/workspaces/ab12/dependencies/e1/repin',
      body: { revision: sha },
    });
    expect(buildRequest(findOperation('detach_dependency')!, { repo: 'o/r', workspace: 'ab12', dependency: 'e1' })).toMatchObject({
      method: 'DELETE',
      path: '/api/v1/repos/o/r/workspaces/ab12/dependencies/e1',
      body: undefined,
    });
    expect(requestTarget(buildRequest(findOperation('get_train')!, { repo: 'o/r', base: 'main', limit: 5 }))).toBe('/api/v1/repos/o/r/train?base=main&limit=5');
  });

  it('declares every path placeholder as a path parameter and documents every parameter', () => {
    for (const op of OPERATIONS) {
      const placeholders = [...op.path.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
      const pathParams = op.params.filter((p) => p.in === 'path').map((p) => p.name);
      expect(pathParams.sort(), op.name).toEqual([...placeholders].sort());
      for (const p of op.params) {
        expect(p.description.length, `${op.name}.${p.name}`).toBeGreaterThan(3);
        if (p.in === 'path') expect(p.required, `${op.name}.${p.name}`).toBe(true);
      }
      const names = op.params.map((p) => p.name);
      expect(new Set(names).size, op.name).toBe(names.length);
    }
  });

  it('finds operations by tool name and by CLI command', () => {
    expect(findOperation('read_file')?.command).toEqual(['file', 'read']);
    expect(findCommand(['compare', 'get'])?.name).toBe('compare');
    expect(findCommand(['nope', 'nope'])).toBeUndefined();
    expect(findOperation('nope')).toBeUndefined();
  });
});

describe('buildRequest', () => {
  const op = (name: string) => {
    const o = findOperation(name);
    if (!o) throw new Error(`missing ${name}`);
    return o;
  };

  it('splits owner/name and encodes refs in the compare range', () => {
    const r = buildRequest(op('compare'), { repo: 'alice/demo', base: 'main', head: 'feature/x', order: 'risk', limit: 10 });
    expect(r.method).toBe('GET');
    expect(r.path).toBe('/api/v1/repos/alice/demo/compare/main...feature%2Fx');
    expect(r.query).toBe('order=risk&limit=10');
    expect(r.body).toBeUndefined();
    expect(requestTarget(r)).toBe('/api/v1/repos/alice/demo/compare/main...feature%2Fx?order=risk&limit=10');
  });

  it('maps get_file_diff onto the compare file route with an encoded path query', () => {
    const r = buildRequest(op('get_file_diff'), { repo: 'o/r', base: 'a', head: 'b', path: 'src/a b.ts' });
    expect(requestTarget(r)).toBe('/api/v1/repos/o/r/compare/a...b/file?path=src%2Fa+b.ts');
  });

  it('maps read_file and get_tree onto the REST content routes', () => {
    expect(requestTarget(buildRequest(op('read_file'), { repo: 'o/r', path: 'README.md', ref: 'main' }))).toBe(
      '/api/v1/repos/o/r/contents?path=README.md&ref=main',
    );
    expect(requestTarget(buildRequest(op('get_tree'), { repo: 'o/r' }))).toBe('/api/v1/repos/o/r/tree');
  });

  it('joins list query parameters with commas', () => {
    const r = buildRequest(op('forecast'), { repo: 'o/r', paths: ['a.ts', 'src/'] });
    expect(r.query).toBe('paths=a.ts%2Csrc%2F');
  });

  it('sends literal path lists as one repeated parameter per path, so commas stay part of a path', () => {
    const ctx = buildRequest(op('get_context'), { repo: 'o/r', path: ['src/a,b.ts', 'c.md'] });
    expect(ctx.query).toBe('path=src%2Fa%2Cb.ts&path=c.md');
    expect(new URLSearchParams(ctx.query).getAll('path')).toEqual(['src/a,b.ts', 'c.md']);
    const rec = buildRequest(op('record_decision'), { repo: 'o/r', paths: ['src/a,b.ts'], chosen: 'c', rejected: [], reason: 'r' });
    expect(rec.body).toMatchObject({ paths: ['src/a,b.ts'] });
    expect(op('get_context').params.find((p) => p.name === 'path')?.literal).toBe(true);
    expect(op('record_decision').params.find((p) => p.name === 'paths')?.literal).toBe(true);
  });

  it('registers the existing repository lifecycle routes as thin entries', () => {
    const del = op('delete_repo');
    expect(del).toMatchObject({ command: ['repo', 'delete'], family: 'repos', method: 'DELETE', path: '/repos/{repo}', destructive: true, readOnly: false });
    expect(buildRequest(del, { repo: 'o/r' })).toEqual({ method: 'DELETE', path: '/api/v1/repos/o/r', query: '', body: undefined });

    const fork = op('fork_repo');
    expect(fork).toMatchObject({ command: ['repo', 'fork'], family: 'repos', method: 'POST', path: '/repos/{repo}/forks' });
    expect(buildRequest(fork, { repo: 'o/r', name: 'r2' })).toEqual({ method: 'POST', path: '/api/v1/repos/o/r/forks', query: '', body: { name: 'r2' } });
    expect(buildRequest(fork, { repo: 'o/r' }).body).toBeUndefined();

    const imp = op('import_repo');
    expect(imp).toMatchObject({ command: ['repo', 'import'], family: 'repos', method: 'POST', path: '/import' });
    expect(imp.params.find((p) => p.name === 'url')).toMatchObject({ in: 'body', required: true, positional: true });
    expect(buildRequest(imp, { url: 'https://example.test/x.git', name: 'x', branch: 'main', visibility: 'public' })).toEqual({
      method: 'POST',
      path: '/api/v1/import',
      query: '',
      body: { url: 'https://example.test/x.git', name: 'x', branch: 'main', visibility: 'public' },
    });
    expect(() => buildRequest(imp, { url: 'https://example.test/x.git', visibility: 'internal' })).toThrow(/visibility.*one of/);
  });

  it('collects body parameters into one JSON object', () => {
    const r = buildRequest(op('create_workspace'), { repo: 'o/r', task: 'fix it', agent: 'bot', intent: { paths: ['a'] } });
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/api/v1/repos/o/r/workspaces');
    expect(r.body).toEqual({ task: 'fix it', agent: 'bot', intent: { paths: ['a'] } });
    const cs = buildRequest(op('create_change_set'), { repo: 'o/r', workspace: 'abc', title: 't', mergePolicy: 'review' });
    expect(cs.path).toBe('/api/v1/repos/o/r/workspaces/abc/change-set');
    expect(cs.body).toEqual({ title: 't', mergePolicy: 'review' });
  });

  it('sends no body for a POST without body parameters', () => {
    const r = buildRequest(op('merge_change'), { repo: 'o/r', number: 3 });
    expect(r).toMatchObject({ method: 'POST', path: '/api/v1/repos/o/r/changes/3/merge', body: undefined });
  });

  it('maps attribution and decision context onto their REST routes', () => {
    const sha = 'a'.repeat(40);
    const set = buildRequest(op('set_attribution'), { repo: 'o/r', sha, agent: 'a', session: 's', promptHash: 'h', model: 'm' });
    expect(set).toMatchObject({ method: 'POST', path: `/api/v1/repos/o/r/commits/${sha}/attribution`, body: { agent: 'a', session: 's', promptHash: 'h', model: 'm' } });
    expect(requestTarget(buildRequest(op('get_attribution'), { repo: 'o/r', sha }))).toBe(`/api/v1/repos/o/r/commits/${sha}/attribution`);
    const ctx = buildRequest(op('get_context'), { repo: 'o/r', task: 't1', path: ['src/a.ts', 'b.md'], limit: 5 });
    expect(requestTarget(ctx)).toBe('/api/v1/repos/o/r/context?task=t1&path=src%2Fa.ts&path=b.md&limit=5');
    const rec = buildRequest(op('record_decision'), { repo: 'o/r', task: 't1', paths: ['a'], chosen: 'c1', rejected: ['c2', { id: 'c3', reason: 'r' }], reason: 'why' });
    expect(rec).toMatchObject({ method: 'POST', path: '/api/v1/repos/o/r/decisions', body: { task: 't1', paths: ['a'], chosen: 'c1', rejected: ['c2', { id: 'c3', reason: 'r' }], reason: 'why' } });
    expect(findCommand(['attribution', 'set'])?.name).toBe('set_attribution');
    expect(findCommand(['decision', 'context'])?.name).toBe('get_context');
    // merge_change carries optional attribution fields for the merge commit's note.
    const merge = buildRequest(op('merge_change'), { repo: 'o/r', number: 2, attribution: { agent: 'a', session: 's' } });
    expect(merge.body).toEqual({ attribution: { agent: 'a', session: 's' } });
  });

  it('maps the task dispatch tools onto the task routes', () => {
    const id = 'abcd1234';
    expect(buildRequest(op('claim_task'), { repo: 'o/r', task: id, agent: 'bot', ttlSeconds: 60 })).toEqual({
      method: 'POST',
      path: `/api/v1/repos/o/r/tasks/${id}/claim`,
      query: '',
      body: { agent: 'bot', ttlSeconds: 60 },
    });
    expect(buildRequest(op('claim_task'), { repo: 'o/r', task: id }).body).toBeUndefined();
    const sha = 'b'.repeat(40);
    expect(buildRequest(op('complete_task'), { repo: 'o/r', task: id, generation: 2, sha })).toMatchObject({
      path: `/api/v1/repos/o/r/tasks/${id}/complete`,
      body: { generation: 2, sha },
    });
    expect(buildRequest(op('heartbeat_task'), { repo: 'o/r', task: id, generation: 1 }).path).toBe(`/api/v1/repos/o/r/tasks/${id}/heartbeat`);
    expect(requestTarget(buildRequest(op('get_task'), { repo: 'o/r', task: id }))).toBe(`/api/v1/repos/o/r/tasks/${id}`);
    expect(() => buildRequest(op('complete_task'), { repo: 'o/r', task: id })).toThrow(/generation.*required/);
  });

  it('refuses missing, mistyped, unknown and malformed arguments with the parameter named', () => {
    const fail = (name: string, args: Record<string, unknown>) => {
      try {
        buildRequest(op(name), args);
      } catch (err) {
        expect(err).toBeInstanceOf(OperationInputError);
        return (err as OperationInputError).message;
      }
      throw new Error('expected a failure');
    };
    expect(fail('get_change', { repo: 'o/r' })).toMatch(/number.*required/);
    expect(fail('get_change', { repo: 'o/r', number: 'x' })).toMatch(/number.*integer/);
    expect(fail('get_change', { repo: 'o/r', number: 1, bogus: 1 })).toMatch(/unknown argument "bogus"/);
    expect(fail('get_change', { repo: 'nope', number: 1 })).toMatch(/repo.*owner\/name/);
    expect(fail('list_changes', { repo: 'o/r', state: 'weird' })).toMatch(/state.*one of/);
    expect(fail('forecast', { repo: 'o/r', paths: 'a' })).toMatch(/paths.*list/);
  });
});
