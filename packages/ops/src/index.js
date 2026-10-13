// @ts-check
/**
 * The one operation registry shared by the `kvarm` CLI (apps/cli) and the MCP
 * server (apps/platform/src/mcp). Each entry maps one MCP tool and one CLI
 * command onto exactly one REST route under /api/v1, so both adapters reach
 * the same route handler, the same authority lookup and the same services.
 *
 * Plain JavaScript with JSDoc types so the dependency-free CLI can run it on
 * Node directly; the Worker bundles it like any other module.
 *
 * Later features add their operations here (attribution, queue, tasks,
 * reviews, dependencies). This file is the registry of record; `kvarm help
 * <group> <verb>` prints one entry.
 */

/**
 * @typedef {'string' | 'integer' | 'boolean' | 'string[]' | 'json'} ParamType
 *
 * @typedef {object} Param
 * @property {string} name
 * @property {ParamType} type
 * @property {'path' | 'query' | 'body'} in
 * @property {string} description
 * @property {boolean} [required]
 * @property {boolean} [positional] CLI positional argument (in declaration order) instead of a --flag
 * @property {readonly string[]} [enum]
 * @property {'repo'} [format] `owner/name`, expanded to two encoded path segments
 * @property {boolean} [literal] `string[]` whose items may contain commas (Git paths): sent as one repeated
 *   query parameter per item, and the CLI takes one item per repeated flag without splitting on commas
 *
 * @typedef {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} HttpMethod
 *
 * @typedef {object} Operation
 * @property {string} name MCP tool name
 * @property {readonly [string, string]} command CLI command words (`kvarm <group> <verb>`)
 * @property {string} family
 * @property {string} description
 * @property {HttpMethod} method
 * @property {string} path REST path below /api/v1, with {param} placeholders
 * @property {readonly Param[]} params
 * @property {boolean} readOnly
 * @property {boolean} [destructive]
 *
 * @typedef {object} BuiltRequest
 * @property {HttpMethod} method
 * @property {string} path absolute path including /api/v1
 * @property {string} query URL query without the leading "?" ('' when none)
 * @property {Record<string, unknown> | undefined} body JSON body (undefined: send none)
 */

export const API_PREFIX = '/api/v1';

export class OperationInputError extends Error {
  /**
   * @param {string} message
   * @param {string} [param]
   */
  constructor(message, param) {
    super(message);
    this.name = 'OperationInputError';
    this.code = 'INVALID_ARGUMENT';
    this.param = param;
  }
}

// ---------------------------------------------------------------------------
// Parameter helpers
// ---------------------------------------------------------------------------

/** @type {Param} */
const REPO = { name: 'repo', type: 'string', in: 'path', required: true, positional: true, format: 'repo', description: 'Repository as owner/name' };

/**
 * @param {string} name
 * @param {string} description
 * @returns {Param}
 */
const pathArg = (name, description) => ({ name, type: 'string', in: 'path', required: true, positional: true, description });

/**
 * @param {string} name
 * @param {string} description
 * @returns {Param}
 */
const numberArg = (name, description) => ({ name, type: 'integer', in: 'path', required: true, positional: true, description });

/** @type {Param} */
const CHANGE = numberArg('number', 'Change set number within the repository');
/** @type {Param} */
const WORKSPACE = pathArg('workspace', 'Workspace id (16 hex characters)');
/** @type {Param} */
const TASK = pathArg('task', 'Task id from list_tasks');

/**
 * @param {string} name
 * @param {ParamType} type
 * @param {string} description
 * @param {Partial<Param>} [extra]
 * @returns {Param}
 */
const query = (name, type, description, extra = {}) => ({ name, type, in: 'query', description, ...extra });

/**
 * @param {string} name
 * @param {ParamType} type
 * @param {string} description
 * @param {Partial<Param>} [extra]
 * @returns {Param}
 */
const body = (name, type, description, extra = {}) => ({ name, type, in: 'body', description, ...extra });

/** @param {number} max */
const LIMIT = (max) => query('limit', 'integer', `Page size (1-${max})`);
const CURSOR = query('cursor', 'string', 'Opaque cursor from the previous page (nextCursor)');
const MERGE_POLICIES = /** @type {const} */ (['review', 'auto', 'draft']);

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * @param {Omit<Operation, 'readOnly'> & { readOnly?: boolean }} op
 * @returns {Operation}
 */
function define(op) {
  return Object.freeze({ ...op, readOnly: op.method === 'GET', params: Object.freeze([...op.params]) });
}

/** @type {readonly Operation[]} */
export const OPERATIONS = Object.freeze([
  // --- user -----------------------------------------------------------------
  define({
    name: 'get_user',
    command: ['user', 'get'],
    family: 'user',
    description: 'Show the authenticated human account (login, email, admin flag). Agent tokens are refused.',
    method: 'GET',
    path: '/user',
    params: [],
  }),

  // --- repos ----------------------------------------------------------------
  define({
    name: 'list_repos',
    command: ['repo', 'list'],
    family: 'repos',
    description: 'List the repositories owned by the authenticated user (same set as GET /api/v1/repos).',
    method: 'GET',
    path: '/repos',
    params: [],
  }),
  define({
    name: 'get_repo',
    command: ['repo', 'get'],
    family: 'repos',
    description: 'Repository metadata (visibility, default branch, clone URL). Private repos you cannot read are not found.',
    method: 'GET',
    path: '/repos/{repo}',
    params: [REPO],
  }),
  define({
    name: 'create_repo',
    command: ['repo', 'create'],
    family: 'repos',
    description: 'Create a repository owned by the authenticated user. Visibility defaults to private.',
    method: 'POST',
    path: '/repos',
    params: [
      body('name', 'string', 'Repository name', { required: true, positional: true }),
      body('description', 'string', 'Short description'),
      body('visibility', 'string', 'public or private (default private)', { enum: ['public', 'private'] }),
      body('defaultBranch', 'string', 'Default branch name (default main)'),
    ],
  }),
  define({
    name: 'update_repo',
    command: ['repo', 'update'],
    family: 'repos',
    description: 'Change a repository description or visibility. Needs the admin role on the repository.',
    method: 'PATCH',
    path: '/repos/{repo}',
    params: [
      REPO,
      body('description', 'string', 'New description'),
      body('visibility', 'string', 'public or private', { enum: ['public', 'private'] }),
    ],
  }),
  define({
    name: 'delete_repo',
    command: ['repo', 'delete'],
    family: 'repos',
    description: 'Delete a repository with its git data, workspaces, changes and snapshots. Needs the admin role; agent tokens are refused.',
    method: 'DELETE',
    path: '/repos/{repo}',
    params: [REPO],
    destructive: true,
  }),
  define({
    name: 'fork_repo',
    command: ['repo', 'fork'],
    family: 'repos',
    description: 'Fork a repository you can read into a new private repository owned by you. Agent tokens are refused.',
    method: 'POST',
    path: '/repos/{repo}/forks',
    params: [REPO, body('name', 'string', 'Fork name (default <name>-fork)')],
  }),
  define({
    name: 'import_repo',
    command: ['repo', 'import'],
    family: 'repos',
    description: 'Import an HTTPS git remote into a new repository owned by you (status importing). Agent tokens are refused.',
    method: 'POST',
    path: '/import',
    params: [
      body('url', 'string', 'HTTPS git remote to import', { required: true, positional: true }),
      body('name', 'string', 'Repository name (default: the last segment of the URL)'),
      body('branch', 'string', 'Branch to import (optional)'),
      body('visibility', 'string', 'public or private (default private)', { enum: ['public', 'private'] }),
    ],
  }),

  // --- content --------------------------------------------------------------
  define({
    name: 'get_tree',
    command: ['tree', 'get'],
    family: 'content',
    description: 'List the entries (name, type, mode, hash) of a directory at a ref, like git ls-tree <ref> [<dir>].',
    method: 'GET',
    path: '/repos/{repo}/tree',
    params: [
      REPO,
      query('path', 'string', 'Directory path (default: the repository root)', { positional: true }),
      query('ref', 'string', 'Branch, tag or commit SHA (default: the default branch)'),
    ],
  }),
  define({
    name: 'read_file',
    command: ['file', 'read'],
    family: 'content',
    description: 'Read one file at a ref. Text comes back as utf-8, anything else as base64 (encoding field).',
    method: 'GET',
    path: '/repos/{repo}/contents',
    params: [
      REPO,
      query('path', 'string', 'File path', { required: true, positional: true }),
      query('ref', 'string', 'Branch, tag or commit SHA (default: the default branch)'),
    ],
  }),
  define({
    name: 'list_events',
    command: ['event', 'list'],
    family: 'content',
    description: 'Push events recorded for the repository, newest first, with the per-effect processing state.',
    method: 'GET',
    path: '/repos/{repo}/events',
    params: [REPO, LIMIT(100), CURSOR],
  }),
  define({
    name: 'get_snapshot',
    command: ['snapshot', 'get'],
    family: 'content',
    description: 'Snapshot metadata for a ref (ready, building, absent or failed). Never starts a build.',
    method: 'GET',
    path: '/repos/{repo}/snapshots/{ref}',
    params: [REPO, pathArg('ref', 'Branch, tag or commit SHA')],
  }),
  define({
    name: 'request_snapshot',
    command: ['snapshot', 'request'],
    family: 'content',
    description: 'Demand a snapshot build for a ref; returns the metadata view plus started:true|false.',
    method: 'POST',
    path: '/repos/{repo}/snapshots/{ref}',
    params: [REPO, pathArg('ref', 'Branch, tag or commit SHA')],
  }),

  // --- compare --------------------------------------------------------------
  define({
    name: 'compare',
    command: ['compare', 'get'],
    family: 'compare',
    description: 'Changed files between two commit-ishes (direct two-tree diff) with totals and a risk rating.',
    method: 'GET',
    path: '/repos/{repo}/compare/{base}...{head}',
    params: [
      REPO,
      pathArg('base', 'Base branch, tag, full ref or commit SHA'),
      pathArg('head', 'Head branch, tag, full ref or commit SHA'),
      query('order', 'string', 'File order: path (default) or risk', { enum: ['path', 'risk'] }),
      LIMIT(5000),
      CURSOR,
    ],
  }),
  define({
    name: 'get_file_diff',
    command: ['compare', 'file'],
    family: 'compare',
    description: 'Hunks of one changed file between two commit-ishes (git -U3 numbering).',
    method: 'GET',
    path: '/repos/{repo}/compare/{base}...{head}/file',
    params: [
      REPO,
      pathArg('base', 'Base branch, tag, full ref or commit SHA'),
      pathArg('head', 'Head branch, tag, full ref or commit SHA'),
      query('path', 'string', 'Changed file path', { required: true, positional: true }),
    ],
  }),
  define({
    name: 'get_commit_diff',
    command: ['commit', 'diff'],
    family: 'compare',
    description: 'Changed files of one commit against its first parent (the empty tree for a root commit).',
    method: 'GET',
    path: '/repos/{repo}/commits/{sha}/diff',
    params: [
      REPO,
      pathArg('sha', 'Full 40-hex commit SHA'),
      query('order', 'string', 'File order: path (default) or risk', { enum: ['path', 'risk'] }),
      LIMIT(5000),
      CURSOR,
    ],
  }),

  // --- workspaces -----------------------------------------------------------
  define({
    name: 'create_workspace',
    command: ['workspace', 'create'],
    family: 'workspaces',
    description: 'Create an agent workspace: a server-side ref refs/heads/agents/<id>/<slug> at the base head, with an optional intent declaration.',
    method: 'POST',
    path: '/repos/{repo}/workspaces',
    params: [
      REPO,
      body('task', 'string', 'What the workspace is for (1-500 characters)', { required: true }),
      body('agent', 'string', 'Agent display name (default: the token agent or your login)'),
      body('base', 'string', 'Base branch (default: the default branch)'),
      body('intent', 'json', 'Optional intent declaration {paths: string[], prefixes?: string[], ttlSeconds?: number}'),
    ],
  }),
  define({
    name: 'list_workspaces',
    command: ['workspace', 'list'],
    family: 'workspaces',
    description: 'Workspaces of the repository, newest first.',
    method: 'GET',
    path: '/repos/{repo}/workspaces',
    params: [REPO, query('status', 'string', 'active, merged, abandoned or all (default all)', { enum: ['active', 'merged', 'abandoned', 'all'] }), LIMIT(100), CURSOR],
  }),
  define({
    name: 'get_workspace',
    command: ['workspace', 'get'],
    family: 'workspaces',
    description: 'One workspace with its live head.',
    method: 'GET',
    path: '/repos/{repo}/workspaces/{workspace}',
    params: [REPO, WORKSPACE],
  }),
  define({
    name: 'create_change_set',
    command: ['workspace', 'change-set'],
    family: 'workspaces',
    description: 'Open the change set of a workspace (head = the workspace branch) with an explicit merge policy.',
    method: 'POST',
    path: '/repos/{repo}/workspaces/{workspace}/change-set',
    params: [
      REPO,
      WORKSPACE,
      body('title', 'string', 'Change title (1-256 characters)', { required: true }),
      body('body', 'string', 'Change description'),
      body('base', 'string', 'Target branch (default: the default branch)'),
      body('mergePolicy', 'string', 'review (default), auto or draft', { enum: MERGE_POLICIES }),
    ],
  }),
  define({
    name: 'abandon_workspace',
    command: ['workspace', 'abandon'],
    family: 'workspaces',
    description: 'Abandon a workspace: closes its open change set and deletes its ref. Idempotent.',
    method: 'POST',
    path: '/repos/{repo}/workspaces/{workspace}/abandon',
    params: [REPO, WORKSPACE],
    destructive: true,
  }),

  // --- dependencies: pinned draft dependencies between workspaces -------------
  define({
    name: 'add_dependency',
    command: ['deps', 'add'],
    family: 'dependencies',
    description:
      "Pin a workspace to another live workspace of the same repository at its exact current revision. The dependent's change cannot merge until the pinned revision lands (an enqueued dependent waits in the train). Chains are limited to 4 workspaces and cycles are refused with the path.",
    method: 'POST',
    path: '/repos/{repo}/workspaces/{workspace}/dependencies',
    params: [
      REPO,
      WORKSPACE,
      body('onWorkspace', 'string', 'Source workspace id (same repository)', { required: true }),
      body('revision', 'string', "The source's current head commit (40 hex); refused 422 REVISION_NOT_CURRENT naming currentRevision otherwise", { required: true }),
    ],
  }),
  define({
    name: 'list_dependencies',
    command: ['deps', 'list'],
    family: 'dependencies',
    description: "A workspace's pins with their state (active, stale, broken or satisfied), reason, depth and the source's current head.",
    method: 'GET',
    path: '/repos/{repo}/workspaces/{workspace}/dependencies',
    params: [REPO, WORKSPACE],
  }),
  define({
    name: 'repin_dependency',
    command: ['deps', 'repin'],
    family: 'dependencies',
    description:
      "Explicitly recover a stale or broken pin: move it to the current revision of the same source or of another live workspace. The platform never repins on its own; the dependent's ref and commits are untouched. Reports the previous pin.",
    method: 'POST',
    path: '/repos/{repo}/workspaces/{workspace}/dependencies/{dependency}/repin',
    params: [
      REPO,
      WORKSPACE,
      pathArg('dependency', 'Dependency id from list_dependencies'),
      body('revision', 'string', "The source's current head commit (40 hex)", { required: true }),
      body('onWorkspace', 'string', 'Another live source workspace (default: keep the source)'),
    ],
  }),
  define({
    name: 'detach_dependency',
    command: ['deps', 'detach'],
    family: 'dependencies',
    description: "Remove a pin explicitly; the dependent then publishes without that constraint. The dependent's ref, base and change are untouched.",
    method: 'DELETE',
    path: '/repos/{repo}/workspaces/{workspace}/dependencies/{dependency}',
    params: [REPO, WORKSPACE, pathArg('dependency', 'Dependency id from list_dependencies')],
    destructive: true,
  }),

  // --- changes --------------------------------------------------------------
  define({
    name: 'create_change',
    command: ['change', 'create'],
    family: 'changes',
    description: 'Open a change set from a head branch into a base branch.',
    method: 'POST',
    path: '/repos/{repo}/changes',
    params: [
      REPO,
      body('title', 'string', 'Change title (1-256 characters)', { required: true }),
      body('base', 'string', 'Target branch', { required: true }),
      body('head', 'string', 'Source branch', { required: true }),
      body('body', 'string', 'Change description'),
      body('mergePolicy', 'string', 'review (default), auto or draft', { enum: MERGE_POLICIES }),
    ],
  }),
  define({
    name: 'list_changes',
    command: ['change', 'list'],
    family: 'changes',
    description: 'Change sets of the repository, newest number first.',
    method: 'GET',
    path: '/repos/{repo}/changes',
    params: [REPO, query('state', 'string', 'open (default), closed, merged, conflicted or all', { enum: ['open', 'closed', 'merged', 'conflicted', 'all'] }), LIMIT(100), CURSOR],
  }),
  define({
    name: 'get_change',
    command: ['change', 'get'],
    family: 'changes',
    description: 'One change set with its risk rating, live mergeability and check runs.',
    method: 'GET',
    path: '/repos/{repo}/changes/{number}',
    params: [REPO, CHANGE],
  }),
  define({
    name: 'update_change',
    command: ['change', 'update'],
    family: 'changes',
    description: 'Edit a change set title, body, merge policy or open/closed state. Setting auto merges it when mergeable.',
    method: 'PATCH',
    path: '/repos/{repo}/changes/{number}',
    params: [
      REPO,
      CHANGE,
      body('title', 'string', 'New title'),
      body('body', 'string', 'New description'),
      body('mergePolicy', 'string', 'review, auto or draft', { enum: MERGE_POLICIES }),
      body('state', 'string', 'open or closed', { enum: ['open', 'closed'] }),
    ],
  }),
  define({
    name: 'merge_change',
    command: ['change', 'merge'],
    family: 'changes',
    description: 'Explicitly merge a change set into its base (fast-forward or a two-parent merge commit) under branch rules and required checks.',
    method: 'POST',
    path: '/repos/{repo}/changes/{number}/merge',
    params: [
      REPO,
      CHANGE,
      body('attribution', 'json', "Attribution note for a two-parent merge commit: {agent?, session?, promptHash?, model?}; omitted fields name the merging principal"),
    ],
  }),
  define({
    name: 'get_mergeability',
    command: ['change', 'mergeability'],
    family: 'changes',
    description: 'Whether a change set merges cleanly now: status, conflicts and the checks-gate answer for the merge tree.',
    method: 'GET',
    path: '/repos/{repo}/changes/{number}/mergeability',
    params: [REPO, CHANGE],
  }),
  define({
    name: 'list_checks',
    command: ['change', 'checks'],
    family: 'changes',
    description: 'Check runs of a change set, newest first.',
    method: 'GET',
    path: '/repos/{repo}/changes/{number}/checks',
    params: [REPO, CHANGE],
  }),

  // --- flaky checks: retry-then-classify registry and quarantine ------------
  define({
    name: 'list_flakes',
    command: ['flake', 'list'],
    family: 'flakes',
    description:
      'Flaky required checks: checks quarantined now (reason, who, expiry) and flake entries, newest first (a required CI job that failed once and passed its one automatic retry on the same tree). Bounded pages with nextCursor.',
    method: 'GET',
    path: '/repos/{repo}/flakes',
    params: [REPO, query('check', 'string', 'Only flakes of this check name'), LIMIT(100), CURSOR],
  }),
  define({
    name: 'quarantine_check',
    command: ['flake', 'quarantine'],
    family: 'flakes',
    description:
      'Quarantine a check by name (repo admins only; audited): it still runs but is neutral, never satisfying or blocking the checks gate, and gets no automatic retry. A branch rule that names it still requires it. Expires after 7 days unless expiresAt is given (at most 90 days).',
    method: 'POST',
    path: '/repos/{repo}/flakes/{check}/quarantine',
    params: [
      REPO,
      pathArg('check', 'Check name (CI job name; kvarm/ checks cannot be quarantined)'),
      body('reason', 'string', 'Why the check is quarantined (at most 500 characters)'),
      body('expiresAt', 'string', 'ISO 8601 time the quarantine ends (default 7 days, at most 90 days ahead)'),
    ],
  }),
  define({
    name: 'restore_check',
    command: ['flake', 'restore'],
    family: 'flakes',
    description: 'End a check quarantine (repo admins only; audited): the check counts as required again on every tree.',
    method: 'POST',
    path: '/repos/{repo}/flakes/{check}/restore',
    params: [REPO, pathArg('check', 'Check name')],
  }),

  // --- merge queue / integration train --------------------------------------
  define({
    name: 'enqueue_change',
    command: ['queue', 'add'],
    family: 'queue',
    description:
      "Enqueue a change set for the integration train. Enqueue approves the change's current head; the train merges it once the exact composed tree passes required checks. Drafts are refused (409); a full queue answers 429 with Retry-After.",
    method: 'POST',
    path: '/repos/{repo}/changes/{number}/enqueue',
    params: [
      REPO,
      CHANGE,
      body('headSha', 'string', 'Expected head commit (40 hex); refused 409 HEAD_MOVED if the change has moved'),
      body('mergePolicy', 'string', 'Expected merge policy; refused 409 POLICY_CHANGED if it differs', { enum: MERGE_POLICIES }),
      body('attribution', 'json', 'Attribution note for a two-parent merge commit: {agent?, session?, promptHash?, model?}; omitted fields name the enqueuing principal'),
    ],
  }),
  define({
    name: 'dequeue_change',
    command: ['queue', 'remove'],
    family: 'queue',
    description: 'Take a change set out of the merge queue (not while it is being published). The change itself stays open.',
    method: 'DELETE',
    path: '/repos/{repo}/changes/{number}/enqueue',
    params: [REPO, CHANGE],
  }),
  define({
    name: 'get_queue',
    command: ['queue', 'list'],
    family: 'queue',
    description: 'Active merge-queue entries in train order per target branch: position, state, approved head, exact composition identity and reason.',
    method: 'GET',
    path: '/repos/{repo}/queue',
    params: [REPO, query('base', 'string', 'Only this target branch'), LIMIT(100), CURSOR],
  }),
  define({
    name: 'get_train',
    command: ['train', 'status'],
    family: 'queue',
    description:
      'Integration train status: active entries per target branch with their pins and, for an entry held back by an unresolved pin, a machine-readable waiting reason {code, message, dependencies}.',
    method: 'GET',
    path: '/repos/{repo}/train',
    params: [REPO, query('base', 'string', 'Only this target branch'), LIMIT(100)],
  }),

  // --- reviews: exact-head approvals, policy and human escalations -----------
  define({
    name: 'get_reviews',
    command: ['review', 'get'],
    family: 'reviews',
    description:
      'The review packet of a change: required and counted approvals of the current head, reviews with principal, model family and differentFamily, blockers and escalations.',
    method: 'GET',
    path: '/repos/{repo}/changes/{number}/reviews',
    params: [REPO, CHANGE],
  }),
  define({
    name: 'review_change',
    command: ['review', 'submit'],
    family: 'reviews',
    description:
      "Review the change's current head (approve or request-changes) as a human or agent principal other than the author. A request-changes, or an approval next to one, escalates to a human.",
    method: 'POST',
    path: '/repos/{repo}/changes/{number}/reviews',
    params: [
      REPO,
      CHANGE,
      body('verdict', 'string', 'Review verdict', { required: true, enum: ['approve', 'request-changes'] }),
      body('headSha', 'string', 'The reviewed head commit (40 hex); refused 409 HEAD_MOVED if the change has moved'),
      body('body', 'string', 'Review comment'),
    ],
  }),
  define({
    name: 'approve_change',
    command: ['review', 'approve'],
    family: 'reviews',
    description: "Approve the change's current head. The approval is bound to that exact head; a head movement stales it.",
    method: 'POST',
    path: '/repos/{repo}/changes/{number}/approve',
    params: [
      REPO,
      CHANGE,
      body('headSha', 'string', 'The reviewed head commit (40 hex); refused 409 HEAD_MOVED if the change has moved'),
      body('body', 'string', 'Review comment'),
    ],
  }),
  define({
    name: 'request_changes',
    command: ['review', 'request-changes'],
    family: 'reviews',
    description: "Request changes on the change's current head. Publication is blocked and escalated to a human until one approves or resolves it.",
    method: 'POST',
    path: '/repos/{repo}/changes/{number}/request-changes',
    params: [
      REPO,
      CHANGE,
      body('headSha', 'string', 'The reviewed head commit (40 hex); refused 409 HEAD_MOVED if the change has moved'),
      body('body', 'string', 'Review comment'),
    ],
  }),
  define({
    name: 'list_pending_reviews',
    command: ['review', 'pending'],
    family: 'reviews',
    description: 'Live changes still short of the required approvals of their current head or with an open escalation, newest first.',
    method: 'GET',
    path: '/repos/{repo}/reviews/pending',
    params: [REPO, LIMIT(100), CURSOR],
  }),
  define({
    name: 'assign_reviewer',
    command: ['review', 'assign'],
    family: 'reviews',
    description:
      'Pick a reviewer among the agents holding a live write token for the repository (or the given ones), preferring a different model family than the author; reports whether the preference was met.',
    method: 'POST',
    path: '/repos/{repo}/changes/{number}/reviewers/assign',
    params: [REPO, CHANGE, body('candidates', 'string[]', 'Only consider these agent ids')],
  }),
  define({
    name: 'resolve_escalation',
    command: ['review', 'resolve'],
    family: 'reviews',
    description: 'Close an open escalation as a human (agents are refused 403 HUMAN_REQUIRED). Approving the current head as a human independent of the author (not the human who minted an authoring agent) resolves every open escalation too.',
    method: 'POST',
    path: '/repos/{repo}/changes/{number}/escalations/{id}/resolve',
    params: [
      REPO,
      CHANGE,
      pathArg('id', 'Escalation id from get_reviews'),
      body('resolution', 'string', 'How the escalation was handled (default resolve)', { enum: ['acknowledge', 'resolve'] }),
      body('note', 'string', 'Note recorded with the resolution'),
    ],
  }),
  define({
    name: 'get_review_policy',
    command: ['review-policy', 'get'],
    family: 'reviews',
    description: 'The repository review policy: approving reviews required per change from distinct principals other than the author.',
    method: 'GET',
    path: '/repos/{repo}/review-policy',
    params: [REPO],
  }),
  define({
    name: 'set_review_policy',
    command: ['review-policy', 'set'],
    family: 'reviews',
    description: 'Set how many approving reviews of the current head (humans or agents, distinct, not the author) a change needs (repo admins only).',
    method: 'PUT',
    path: '/repos/{repo}/review-policy',
    params: [REPO, body('requiredReviews', 'integer', 'Required approving reviews (0-10)', { required: true, positional: true })],
  }),

  // --- tasks: work Kvarm dispatches to agents --------------------------------
  define({
    name: 'list_tasks',
    command: ['task', 'list'],
    family: 'tasks',
    description:
      'Agent tasks of a repository, newest first: resolve-conflict tasks name the conflicted change, its head and base commits and the conflicting paths (lockfiles marked needsRegeneration).',
    method: 'GET',
    path: '/repos/{repo}/tasks',
    params: [
      REPO,
      query('status', 'string', 'Task status (default open)', { enum: ['open', 'claimed', 'completed', 'obsolete', 'all'] }),
      query('kind', 'string', 'Only tasks of this kind, e.g. resolve-conflict'),
      LIMIT(100),
      CURSOR,
    ],
  }),
  define({
    name: 'get_task',
    command: ['task', 'get'],
    family: 'tasks',
    description: 'One agent task with its claim lease (holder, generation, expiry), claim workspace and resolution.',
    method: 'GET',
    path: '/repos/{repo}/tasks/{task}',
    params: [REPO, TASK],
  }),
  define({
    name: 'claim_task',
    command: ['task', 'claim'],
    family: 'tasks',
    description:
      "Claim an open task under an expiring lease. Creates (or on a reclaim reuses) a workspace whose branch sits at the conflicting change's head; push the resolution there. A live claim by another agent is refused 409 CLAIMED; a lapsed lease is taken over under the next generation.",
    method: 'POST',
    path: '/repos/{repo}/tasks/{task}/claim',
    params: [
      REPO,
      TASK,
      body('agent', 'string', 'Agent display name (default: the token agent or your login; an agent token always claims as its agent)'),
      body('ttlSeconds', 'integer', 'Lease length in seconds (default 600, max 3600)'),
    ],
  }),
  define({
    name: 'heartbeat_task',
    command: ['task', 'heartbeat'],
    family: 'tasks',
    description: 'Extend the claim lease of a task you hold. Refused 409 STALE_GENERATION when the claim was taken over.',
    method: 'POST',
    path: '/repos/{repo}/tasks/{task}/heartbeat',
    params: [
      REPO,
      TASK,
      body('generation', 'integer', 'Lease generation returned by claim_task', { required: true }),
      body('agent', 'string', 'Agent display name used when claiming'),
      body('ttlSeconds', 'integer', 'New lease length in seconds (default 600, max 3600)'),
    ],
  }),
  define({
    name: 'complete_task',
    command: ['task', 'complete'],
    family: 'tasks',
    description:
      "Complete a claimed resolve-conflict task: the workspace head must descend from the change's head and merge with the base without conflicts. The change moves to the resolution, reopens and follows its merge policy (auto merges, review waits, draft stays draft).",
    method: 'POST',
    path: '/repos/{repo}/tasks/{task}/complete',
    params: [
      REPO,
      TASK,
      body('generation', 'integer', 'Lease generation returned by claim_task', { required: true }),
      body('sha', 'string', 'Expected resolution commit (40 hex); refused 409 if the workspace head differs'),
      body('agent', 'string', 'Agent display name used when claiming'),
      body('attribution', 'json', 'Attribution note for the resolution commit: {agent?, session?, promptHash?, model?}'),
    ],
  }),

  // --- nexus: intents, forecast, overlap ------------------------------------
  define({
    name: 'get_intent',
    command: ['intent', 'get'],
    family: 'nexus',
    description: 'A workspace intent: declared paths, observed paths from pushes and what lies outside the declaration.',
    method: 'GET',
    path: '/repos/{repo}/workspaces/{workspace}/intent',
    params: [REPO, WORKSPACE],
  }),
  define({
    name: 'set_intent',
    command: ['intent', 'set'],
    family: 'nexus',
    description: 'Replace a workspace intent declaration (advisory; nothing is locked).',
    method: 'POST',
    path: '/repos/{repo}/workspaces/{workspace}/intent',
    params: [
      REPO,
      WORKSPACE,
      body('paths', 'string[]', 'Declared paths; a trailing / marks a directory prefix', { required: true }),
      body('prefixes', 'string[]', 'Directory prefixes (paths with / appended)'),
      body('ttlSeconds', 'integer', 'Declaration lifetime in seconds (60-2592000)'),
    ],
  }),
  define({
    name: 'forecast',
    command: ['nexus', 'forecast'],
    family: 'nexus',
    description: 'Advisory forecast: active workspaces whose declared or observed paths intersect the given paths.',
    method: 'GET',
    path: '/repos/{repo}/forecast',
    params: [
      REPO,
      query('paths', 'string[]', 'Paths to forecast (at most 20; a trailing / marks a prefix)', { required: true }),
      query('base', 'string', 'Only workspaces on this base branch'),
      query('exclude', 'string', 'Workspace id to leave out (usually your own)'),
      LIMIT(100),
      CURSOR,
    ],
  }),
  define({
    name: 'get_overlap',
    command: ['nexus', 'overlap'],
    family: 'nexus',
    description: 'Pairs of active workspaces whose pushed changes touch the same paths (advisory, from the Nexus index).',
    method: 'GET',
    path: '/repos/{repo}/workspaces/overlap',
    params: [REPO, query('base', 'string', 'Base branch (default: the default branch)'), LIMIT(100), CURSOR],
  }),

  // --- candidates, arenas, composition --------------------------------------
  define({
    name: 'list_candidates',
    command: ['candidates', 'get'],
    family: 'candidates',
    description: 'Compare 1-8 workspaces against a base: per-candidate summaries, pairwise diffs, overlap and a deterministic ranking.',
    method: 'GET',
    path: '/repos/{repo}/candidates',
    params: [
      REPO,
      query('workspaces', 'string[]', 'Workspace ids (1-8)', { required: true }),
      query('base', 'string', 'Base branch (default: the default branch)'),
    ],
  }),
  define({
    name: 'compose_candidates',
    command: ['candidates', 'compose'],
    family: 'candidates',
    description: 'Compose selected workspace pieces onto the base into a new workspace and change set (refused on textual conflicts).',
    method: 'POST',
    path: '/repos/{repo}/candidates/compose',
    params: [
      REPO,
      body('workspaces', 'json', 'Workspace ids or {workspace, paths?} objects (2-8), in fold order', { required: true }),
      body('paths', 'json', 'Optional {<workspace id>: [paths]} selection'),
      body('base', 'string', 'Base branch (default: the default branch)'),
      body('title', 'string', 'Title of the composed change set'),
      body('mergePolicy', 'string', 'review (default), auto or draft', { enum: MERGE_POLICIES }),
      body('agent', 'string', 'Agent display name for the composed workspace'),
    ],
  }),
  define({
    name: 'list_compositions',
    command: ['composition', 'list'],
    family: 'candidates',
    description: 'Compositions of the repository, newest first.',
    method: 'GET',
    path: '/repos/{repo}/compositions',
    params: [REPO, LIMIT(100), CURSOR],
  }),
  define({
    name: 'get_composition',
    command: ['composition', 'get'],
    family: 'candidates',
    description: 'One composition: sources, composed tree and commit, its workspace and change set, and the checks answer.',
    method: 'GET',
    path: '/repos/{repo}/compositions/{id}',
    params: [REPO, pathArg('id', 'Composition id')],
  }),
  define({
    name: 'create_arena',
    command: ['arena', 'create'],
    family: 'candidates',
    description: 'Create 2-8 sibling candidate workspaces from one brief at the base head. Nothing is spawned or selected automatically.',
    method: 'POST',
    path: '/repos/{repo}/arenas',
    params: [
      REPO,
      body('brief', 'string', 'Shared brief (1-500 characters)', { required: true }),
      body('candidates', 'integer', 'Number of candidate workspaces (2-8)', { required: true }),
      body('base', 'string', 'Base branch (default: the default branch)'),
      body('agent', 'string', 'Agent display name for the workspaces'),
    ],
  }),
  define({
    name: 'list_arenas',
    command: ['arena', 'list'],
    family: 'candidates',
    description: 'Arenas of the repository, newest first.',
    method: 'GET',
    path: '/repos/{repo}/arenas',
    params: [REPO, LIMIT(100), CURSOR],
  }),
  define({
    name: 'get_arena',
    command: ['arena', 'get'],
    family: 'candidates',
    description: 'One arena with its candidate workspaces and recorded selection.',
    method: 'GET',
    path: '/repos/{repo}/arenas/{id}',
    params: [REPO, pathArg('id', 'Arena id')],
  }),
  define({
    name: 'rank_arena',
    command: ['arena', 'rank'],
    family: 'candidates',
    description: 'Ranked candidates of an arena (same factors as list_candidates) plus the separate duplication report.',
    method: 'GET',
    path: '/repos/{repo}/arenas/{id}/candidates',
    params: [REPO, pathArg('id', 'Arena id')],
  }),
  define({
    name: 'select_arena_winner',
    command: ['arena', 'select'],
    family: 'candidates',
    description: 'Record the chosen arena candidate. Merges, closes and abandons nothing; the winner merges through its own change set.',
    method: 'POST',
    path: '/repos/{repo}/arenas/{id}/select',
    params: [REPO, pathArg('id', 'Arena id'), body('workspace', 'string', 'Winning workspace id', { required: true })],
  }),

  // --- orgs, membership, grants ---------------------------------------------
  define({
    name: 'create_org',
    command: ['org', 'create'],
    family: 'orgs',
    description: 'Create an organization; the caller becomes its owner.',
    method: 'POST',
    path: '/orgs',
    params: [body('login', 'string', 'Organization login', { required: true, positional: true }), body('name', 'string', 'Display name')],
  }),
  define({
    name: 'get_org',
    command: ['org', 'get'],
    family: 'orgs',
    description: 'An organization and your role in it.',
    method: 'GET',
    path: '/orgs/{org}',
    params: [pathArg('org', 'Organization login')],
  }),
  define({
    name: 'list_my_orgs',
    command: ['org', 'list'],
    family: 'orgs',
    description: 'Organizations the authenticated user belongs to, with roles.',
    method: 'GET',
    path: '/user/orgs',
    params: [],
  }),
  define({
    name: 'list_org_members',
    command: ['org', 'members'],
    family: 'orgs',
    description: 'Members of an organization (members only).',
    method: 'GET',
    path: '/orgs/{org}/members',
    params: [pathArg('org', 'Organization login'), LIMIT(200), CURSOR],
  }),
  define({
    name: 'set_org_member',
    command: ['org', 'member-set'],
    family: 'orgs',
    description: 'Add a member or change a role (org owners only). The last owner cannot be demoted.',
    method: 'PUT',
    path: '/orgs/{org}/members/{login}',
    params: [
      pathArg('org', 'Organization login'),
      pathArg('login', 'User login'),
      body('role', 'string', 'owner, maintainer or member', { required: true, enum: ['owner', 'maintainer', 'member'] }),
    ],
  }),
  define({
    name: 'remove_org_member',
    command: ['org', 'member-remove'],
    family: 'orgs',
    description: "Remove a member (org owners only); also deletes the user's grants on the org's repositories.",
    method: 'DELETE',
    path: '/orgs/{org}/members/{login}',
    params: [pathArg('org', 'Organization login'), pathArg('login', 'User login')],
    destructive: true,
  }),
  define({
    name: 'list_org_repos',
    command: ['org', 'repos'],
    family: 'orgs',
    description: 'Repositories of an organization visible to you.',
    method: 'GET',
    path: '/orgs/{org}/repos',
    params: [pathArg('org', 'Organization login'), LIMIT(100), CURSOR],
  }),
  define({
    name: 'create_org_repo',
    command: ['org', 'repo-create'],
    family: 'orgs',
    description: 'Create a repository owned by an organization (owners and maintainers).',
    method: 'POST',
    path: '/orgs/{org}/repos',
    params: [
      pathArg('org', 'Organization login'),
      body('name', 'string', 'Repository name', { required: true, positional: true }),
      body('description', 'string', 'Short description'),
      body('visibility', 'string', 'public or private (default private)', { enum: ['public', 'private'] }),
      body('defaultBranch', 'string', 'Default branch name (default main)'),
    ],
  }),
  define({
    name: 'list_grants',
    command: ['grant', 'list'],
    family: 'orgs',
    description: 'Explicit repository grants (repo admins only).',
    method: 'GET',
    path: '/repos/{repo}/grants',
    params: [REPO],
  }),
  define({
    name: 'set_grant',
    command: ['grant', 'set'],
    family: 'orgs',
    description: 'Grant a user read, write or admin on a repository (repo admins only).',
    method: 'PUT',
    path: '/repos/{repo}/grants/{login}',
    params: [REPO, pathArg('login', 'User login'), body('role', 'string', 'read, write or admin', { required: true, enum: ['read', 'write', 'admin'] })],
  }),
  define({
    name: 'revoke_grant',
    command: ['grant', 'revoke'],
    family: 'orgs',
    description: "Revoke a user's explicit grant on a repository (repo admins only).",
    method: 'DELETE',
    path: '/repos/{repo}/grants/{login}',
    params: [REPO, pathArg('login', 'User login')],
    destructive: true,
  }),

  // --- agents ---------------------------------------------------------------
  define({
    name: 'create_agent',
    command: ['agent', 'create'],
    family: 'agents',
    description: 'Create an agent principal owned by you or by an organization you own.',
    method: 'POST',
    path: '/agents',
    params: [
      body('name', 'string', 'Agent name (lowercase, unique per owner)', { required: true, positional: true }),
      body('owner', 'string', 'Your login or an org login (default: you)'),
      body('description', 'string', 'Description (at most 500 characters)'),
      body('modelFamily', 'string', 'Model family of the agent (e.g. claude, gpt); reviewer assignment prefers a different family than the author'),
    ],
  }),
  define({
    name: 'list_agents',
    command: ['agent', 'list'],
    family: 'agents',
    description: 'Agents of an account you manage, sorted by name (revoked included).',
    method: 'GET',
    path: '/agents',
    params: [query('owner', 'string', 'Account login (default: you)'), LIMIT(200), CURSOR],
  }),
  define({
    name: 'get_agent',
    command: ['agent', 'get'],
    family: 'agents',
    description: 'One agent you manage (status, owner, creator).',
    method: 'GET',
    path: '/agents/{id}',
    params: [pathArg('id', 'Agent id')],
  }),
  define({
    name: 'revoke_agent',
    command: ['agent', 'revoke'],
    family: 'agents',
    description: 'Revoke an agent; all of its tokens stop working immediately.',
    method: 'DELETE',
    path: '/agents/{id}',
    params: [pathArg('id', 'Agent id')],
    destructive: true,
  }),
  define({
    name: 'create_agent_token',
    command: ['agent', 'token-create'],
    family: 'agents',
    description: 'Mint an expiring agent token for one repository (read, or write with ref patterns). The token is shown once.',
    method: 'POST',
    path: '/agents/{id}/tokens',
    params: [
      pathArg('id', 'Agent id'),
      body('repo', 'string', 'Repository as owner/name', { required: true }),
      body('role', 'string', 'read or write', { required: true, enum: ['read', 'write'] }),
      body('refs', 'string[]', 'Ref patterns a write token may update (1-16, e.g. refs/heads/agents/*)'),
      body('expiresIn', 'integer', 'Lifetime in seconds (60-2592000, default 3600)'),
      body('name', 'string', 'Token label'),
    ],
  }),
  define({
    name: 'list_agent_tokens',
    command: ['agent', 'tokens'],
    family: 'agents',
    description: 'Token metadata of an agent (prefix only, never the token).',
    method: 'GET',
    path: '/agents/{id}/tokens',
    params: [pathArg('id', 'Agent id')],
  }),
  define({
    name: 'revoke_agent_token',
    command: ['agent', 'token-revoke'],
    family: 'agents',
    description: 'Revoke one agent token.',
    method: 'DELETE',
    path: '/agents/{id}/tokens/{tokenId}',
    params: [pathArg('id', 'Agent id'), pathArg('tokenId', 'Token id')],
    destructive: true,
  }),

  // --- attribution and decision context ---------------------------------------
  define({
    name: 'set_attribution',
    command: ['attribution', 'set'],
    family: 'attribution',
    description:
      'Attach the attribution note {agent, session, promptHash, model?, actor, at} to a commit on refs/notes/kvarm-attribution (replaces an earlier note).',
    method: 'POST',
    path: '/repos/{repo}/commits/{sha}/attribution',
    params: [
      REPO,
      pathArg('sha', 'Full 40-character commit sha'),
      body('agent', 'string', 'Agent identity, e.g. claude-code-1', { required: true }),
      body('session', 'string', 'Agent session id', { required: true }),
      body('promptHash', 'string', 'Hash of the prompt that produced the commit', { required: true }),
      body('model', 'string', 'Model name'),
    ],
  }),
  define({
    name: 'get_attribution',
    command: ['attribution', 'get'],
    family: 'attribution',
    description: "A commit's attribution note (agent, session, promptHash, model, actor, at); not found when it has none.",
    method: 'GET',
    path: '/repos/{repo}/commits/{sha}/attribution',
    params: [REPO, pathArg('sha', 'Full 40-character commit sha')],
  }),
  define({
    name: 'record_decision',
    command: ['decision', 'record'],
    family: 'attribution',
    description: 'Record which candidate was chosen for a task and/or paths, the rejected candidates and why, for later agents to read with get_context.',
    method: 'POST',
    path: '/repos/{repo}/decisions',
    params: [
      REPO,
      body('task', 'string', 'Task id the decision belongs to (task and/or paths)'),
      body('paths', 'string[]', 'Repository paths the decision covers (at most 100)', { literal: true }),
      body('chosen', 'string', 'Chosen candidate, workspace or change id', { required: true }),
      body('rejected', 'json', 'Rejected candidates: ids or {id, reason} objects (at most 50)', { required: true }),
      body('reason', 'string', 'Why the chosen candidate won', { required: true }),
    ],
  }),
  define({
    name: 'get_context',
    command: ['decision', 'context'],
    family: 'attribution',
    description:
      'Prior decisions for a task and/or paths, newest first: chosen and rejected candidates with their reasons. Bounded pages with truncated/nextCursor.',
    method: 'GET',
    path: '/repos/{repo}/context',
    params: [
      REPO,
      query('task', 'string', 'Task id'),
      query('path', 'string[]', 'Repository paths (at most 20)', { literal: true }),
      LIMIT(50),
      CURSOR,
    ],
  }),

  // --- branch rules ---------------------------------------------------------
  define({
    name: 'list_branch_rules',
    command: ['branch-rule', 'list'],
    family: 'branch-rules',
    description: 'Branch protection rules of the repository.',
    method: 'GET',
    path: '/repos/{repo}/branch-rules',
    params: [REPO],
  }),
  define({
    name: 'create_branch_rule',
    command: ['branch-rule', 'create'],
    family: 'branch-rules',
    description: 'Protect matching refs from direct pushes and set required checks/approvals and guard completeness (repo admins only).',
    method: 'POST',
    path: '/repos/{repo}/branch-rules',
    params: [
      REPO,
      body('pattern', 'string', 'Branch name or ref pattern (main, release/*, refs/tags/*)', { required: true }),
      body('requiredChecks', 'string[]', 'Required check names'),
      body('requiredApprovals', 'integer', 'Required distinct human approvals (0-10)'),
      body(
        'guardCompleteness',
        'string',
        'advisory (default): an incomplete kvarm/guard scan is reported only; required: it blocks publication (GUARD_INCOMPLETE)',
        { enum: ['advisory', 'required'] },
      ),
    ],
  }),
  define({
    name: 'get_branch_rule',
    command: ['branch-rule', 'get'],
    family: 'branch-rules',
    description: 'One branch rule with its required checks and approvals.',
    method: 'GET',
    path: '/repos/{repo}/branch-rules/{id}',
    params: [REPO, pathArg('id', 'Rule id')],
  }),
  define({
    name: 'update_branch_rule',
    command: ['branch-rule', 'update'],
    family: 'branch-rules',
    description: "Change a branch rule's required checks, approvals or guard completeness (the pattern is immutable).",
    method: 'PATCH',
    path: '/repos/{repo}/branch-rules/{id}',
    params: [
      REPO,
      pathArg('id', 'Rule id'),
      body('requiredChecks', 'string[]', 'Required check names'),
      body('requiredApprovals', 'integer', 'Required distinct human approvals (0-10)'),
      body(
        'guardCompleteness',
        'string',
        'advisory (default): an incomplete kvarm/guard scan is reported only; required: it blocks publication (GUARD_INCOMPLETE)',
        { enum: ['advisory', 'required'] },
      ),
    ],
  }),
  define({
    name: 'delete_branch_rule',
    command: ['branch-rule', 'delete'],
    family: 'branch-rules',
    description: 'Delete a branch rule (repo admins only).',
    method: 'DELETE',
    path: '/repos/{repo}/branch-rules/{id}',
    params: [REPO, pathArg('id', 'Rule id')],
    destructive: true,
  }),
  define({
    name: 'get_branch_policy',
    command: ['branch-rule', 'policy'],
    family: 'branch-rules',
    description: 'The effective policy for one ref: protected, direct push, required checks, approvals and guard completeness.',
    method: 'GET',
    path: '/repos/{repo}/branch-policy',
    params: [REPO, query('ref', 'string', 'Branch name or full ref', { required: true, positional: true })],
  }),
]);

const BY_NAME = new Map(OPERATIONS.map((op) => [op.name, op]));
const BY_COMMAND = new Map(OPERATIONS.map((op) => [op.command.join(' '), op]));

/**
 * @param {string} name
 * @returns {Operation | undefined}
 */
export function findOperation(name) {
  return BY_NAME.get(name);
}

/**
 * @param {readonly string[]} words
 * @returns {Operation | undefined}
 */
export function findCommand(words) {
  return BY_COMMAND.get(words.join(' '));
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * @param {Param} p
 * @param {unknown} v
 * @returns {unknown}
 */
function checkValue(p, v) {
  const fail = (/** @type {string} */ what) => {
    throw new OperationInputError(`argument "${p.name}" must be ${what}`, p.name);
  };
  switch (p.type) {
    case 'string':
      if (typeof v !== 'string') fail('a string');
      if (p.required && /** @type {string} */ (v).length === 0) fail('a non-empty string');
      if (p.enum && !p.enum.includes(/** @type {string} */ (v))) fail(`one of ${p.enum.join(', ')}`);
      if (p.format === 'repo' && !REPO_RE.test(/** @type {string} */ (v))) fail('a repository as owner/name');
      return v;
    case 'integer':
      if (typeof v !== 'number' || !Number.isInteger(v)) fail('an integer');
      return v;
    case 'boolean':
      if (typeof v !== 'boolean') fail('a boolean');
      return v;
    case 'string[]':
      if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) fail('a list of strings');
      return v;
    default:
      return v;
  }
}

/**
 * Maps validated arguments onto the operation's REST request. Throws
 * OperationInputError naming the offending argument.
 *
 * @param {Operation} op
 * @param {Record<string, unknown>} args
 * @returns {BuiltRequest}
 */
export function buildRequest(op, args) {
  const known = new Set(op.params.map((p) => p.name));
  for (const key of Object.keys(args)) {
    if (!known.has(key)) throw new OperationInputError(`unknown argument "${key}" for ${op.name}`, key);
  }
  let path = op.path;
  const search = new URLSearchParams();
  /** @type {Record<string, unknown>} */
  const json = {};
  let hasBody = false;
  for (const p of op.params) {
    const raw = args[p.name];
    if (raw === undefined || raw === null) {
      if (p.required) throw new OperationInputError(`argument "${p.name}" is required (${p.description})`, p.name);
      continue;
    }
    const v = checkValue(p, raw);
    if (p.in === 'path') {
      const s = String(v);
      const segment = p.format === 'repo' ? s.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(s);
      path = path.replace(`{${p.name}}`, segment);
    } else if (p.in === 'query') {
      if (Array.isArray(v) && p.literal) for (const item of v) search.append(p.name, item);
      else search.set(p.name, Array.isArray(v) ? v.join(',') : String(v));
    } else {
      json[p.name] = v;
      hasBody = true;
    }
  }
  return {
    method: op.method,
    path: `${API_PREFIX}${path}`,
    query: search.toString(),
    body: hasBody ? json : undefined,
  };
}

/**
 * @param {BuiltRequest} req
 * @returns {string} path plus query
 */
export function requestTarget(req) {
  return req.query ? `${req.path}?${req.query}` : req.path;
}
