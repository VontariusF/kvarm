# Kvarm architecture

This document describes Kvarm as it is built: one Cloudflare Worker that serves git smart-HTTP, a versioned REST API, an MCP server and server-rendered repository pages on top of Cloudflare Artifacts. The [README](../README.md) covers deployment, the CLI, the API reference and measured limits; this document explains how the parts fit together and which rules they follow.

**Citations.** Source comments cite this document by section number, for example "architecture §11.4" or "§0.1/§0.3". "Invariant N" means §2.N. A few comments say "STEER v2 §0.x"; that is an older name for the §0 decisions and points at the same sections. `node scripts/check-architecture-refs.mjs` checks that every numbered citation in the repository resolves to a heading here (or in the document the citation names), and the test suite runs it.

**Budgets, the registry of record and the risk rules.** Tests and scripts cite "budget rows": the per-endpoint work budgets. §10 describes the budget model, `scripts/lib/cost-catalog.mjs` holds every budgeted row as a machine-checked spec, and [`docs/benchmarks/README.md`](benchmarks/README.md) lists the measured counters per endpoint next to their budgets. The operation registry of record is `packages/ops/src/index.js` (every operation with its REST route, MCP tool and CLI command; `kvarm help <group> <verb>` prints one entry), and the risk rules are the code and tests of `packages/review`. `scripts/cost-sweep.mjs` reads the budget rows from a markdown budget table given as `--cost-md`; `scripts/mcp-agent.mjs` and `scripts/dependencies-e2e.mjs` compare the registry against a markdown registry table only when `--api-doc` names one.

## 0. Design decisions

These decisions shape the whole codebase. Later sections refer back to them.

### 0.1 One owner per concern

- **Overlap and conflict prediction** belongs to the Nexus forecast service, `services/intents/forecast.ts`. Nothing else computes overlap. The candidates service ranks and diffs candidates and reads overlap from the Nexus index (§4, §11.2).
- **One operation registry.** `packages/ops` defines every operation once. Each entry is a REST endpoint, an MCP tool and a `kvarm` CLI command, so the three surfaces cannot drift (§4, §11.6).
- **Fencing** belongs to the merge queue. Publication leases (`do/mergeLock.ts`) and the generation/owner-fenced claims of CI jobs and agent tasks (`services/fencing.ts`) share one model: every claim has a generation, and a late report or release from an earlier holder is rejected (§11.4).
- **Arenas are candidate sets.** An arena is an explicit set of 2–8 candidate workspaces inside the candidates service, not a separate subsystem (§11.7).

### 0.2 Out of scope for this version

The following are designed but not built; the README lists them under "Deferred roadmap": flaky-test retry and quarantine, revert change sets, inbound incident webhooks and outbound webhook delivery, audit export (`get_audit`), contract capsules, semantic packets, hotspot suggestions, priority credits, resource lifecycle, crash reconciliation after a ref move, advisory low-signal test flags, the collaborative UI pass and WorkOS sign-in. Code paths that would serve them either do not exist or are documented as inert.

### 0.3 The checks gate

Merge, queue and composition code never talks to a concrete check producer. It asks one interface, `requiredChecksFor(repo, treeSha, configId)` in `services/checksGate.ts`, which returns the required check set for an exact tree and its state. Producers register with the gate: `kvarm/guard` (`services/checks.ts`) and user-owned CI (`services/ci.ts`). With no producers the required set is empty and its state is `success`, so a merge is gated by mergeability alone.

This inversion is why the merge engine and the integration train do not depend on CI: adding or removing a producer changes no merge, queue or composition code. A change with merge policy `auto` merges when every required check of its exact tree passes (§2.5).

### 0.4 Review, composition and decisions

- **Agent review.** Agent principals may review. A per-repository policy requires N approving reviews from principals other than the author; each agent principal records a nullable `modelFamily`, and reviewer assignment prefers a family different from the author's. Reviewer disagreement, a request for changes, a touched protected path or branch rule, and a final arena selection each open an escalation that only a human can resolve. Protected targets still need human approvals. Approvals bind to the exact head and are revalidated immediately before publication (`services/reviews.ts`, `services/reviewGate.ts`, §9).
- **Composition.** `POST candidates/compose` folds compatible pieces (paths) from several candidate attempts onto the base head with gitops `merge3`, creating a composed workspace ref and change. The composed tree runs the same exact-tree required checks as the train. A clean merge whose required check fails is a **semantic conflict**, reported separately from textual conflicts (`services/compositions.ts`, §11.4).
- **Decisions and context.** Besides attribution notes, agents record decisions `{task?, paths[], chosen, rejected[], reason, actor, at}` in D1, indexed by task and by path. The MCP tool `get_context(task|path)` returns earlier decisions and rejection reasons, bounded, paginated and checked by the shared authority (`services/decisions.ts`, `services/attribution.ts`).

### 0.5 Execution posture

Kvarm runs no agents and calls no hosted model. Agents run where their users run them (Claude Code, Devin, a laptop, an on-premises runner) and coordinate through git workspace refs, MCP tools, declared intents, the merge queue and task dispatch. CI is user-owned: `kvarm runner` claims jobs on the user's machine.

Cloudflare Containers (public beta) have exactly one hosted use: an opt-in CI check runner showcase. A Durable Object controller (`containers/ciRunnerSandbox.ts`) starts a container through the native `ctx.container` API that runs the same claim → snapshot checkout → run → report loop as `kvarm runner`. The first run prepares the workspace and saves a container snapshot; a later run restores it and skips setup. Credentials pass per `exec()` environment and are never written to the container filesystem, because snapshots capture the writable root.

Agent-facing capabilities follow one test: they change a surface every user already touches (merge, review, queue, forecast, CI, status), work through the existing identity, gate and cost machinery, and help a user who never thinks about agents.

## 1. System shape

```
git client  --smart-HTTP-->  git gate (routes/git.ts) ------------------------> Artifacts (git storage)
REST client --/api/v1/*-->   Hono routers (thin) --> services/* (all logic) --> Artifacts reads (binding)
MCP client  --/mcp------->   MCP tools (thin) ----/                         \-> Artifacts writes (receive-pack client)
                                  D1 (registry and state)   Cache API (content-addressed)   R2 (snapshots)
Artifacts push event --> queue kvarm-events --> queue() consumer --> cache purge, snapshot build, kvarm/guard,
                                                                    CI dispatch, change head refresh, train kicks
CI pipeline workflow --> ci_jobs (D1) <-- claim/report -- `kvarm runner` on the user's machine
merge queue --> parallel preparation and checks --> short MergeLock publication lease --> receive-pack with expected old value
workspace intents and pushes --> Nexus path index --> advisory forecast --> opt-in pinned dependencies
```

**Layering.** Routers (`routes/**`) and MCP tools (`mcp/server.ts`) are thin adapters. All behavior lives in `apps/platform/src/services/*.ts`; service functions return `ServiceResult<T>` (`{ok: true, value}` or `{ok: false, status, error}`). Pure algorithms live in `packages/*` and are tested in Node.

**Bindings.** D1 `DB` (registry and state), Artifacts `ARTIFACTS` (git storage, namespace `default`), R2 `SNAPSHOTS`, the `EVENTS` queue (`kvarm-events`, with `kvarm-events-dlq`), the Workers Rate Limiting bindings `READ_LIMITER` and `WRITE_LIMITER`, the Durable Objects `MergeLock` and `CiRunnerSandbox` (plus `TokenCache` and `RateLimiter`, which stay exported to keep the Durable Object migration history intact but are no longer used), and the Workflows `snapshot-builder`, `ci-pipeline`, `merge` and `repo-import`.

### 1.1 Git gate

`routes/git.ts` serves `https://<host>/<owner>/<repo>.git/*`: `info/refs`, `git-upload-pack` and `git-receive-pack` (smart HTTP v0 and v2). Web paths are the same without `.git`.

- **Authorization first.** Personal access tokens and agent tokens arrive as the basic-auth password; anonymous reads are allowed for public repositories. Every request goes through the shared authority (`resolveRepoAccess`, §11.1) before any cached body, token mint or upstream fetch.
- **Streaming.** The proxy streams both directions and buffers nothing; pack generation stays inside Artifacts. Memory and CPU stay flat regardless of repository size.
- **Upstream tokens.** Artifacts git tokens are cached per repository and scope in the Cache API (`artifacts/tokens.ts`); a miss mints through the Artifacts binding directly, once per colo per refresh window. Anonymous and authenticated reads share the read-only token, because platform authorization has already happened by then.
- **Edge-cached advertisements.** `info/refs` for public repositories is cached briefly, keyed by the repository view generation that a confirmed push advances before its reply ends (§9 push freshness).
- **Receive-pack gate.** Before object data streams, `services/receivePackGate.ts` parses the bounded command header and enforces repository access, agent workspace ownership, branch rules, platform-reserved namespaces (`refs/heads/agents/**`, `refs/heads/kvarm-ci/**`) and non-fast-forward rules (§11.1).
- **No Durable Object on the hot path.** Rate limits use the Workers Rate Limiting bindings; tokens come from the Cache API.

## 2. Invariants

### 2.1 Artifacts is the only git store

Reads go through the binding (`readTree`, `readBlob`, `readCommit`, `readFile`, `log`). Every server-side write (merge commits, notes, ref moves, workspace refs) goes through the smart-HTTP `git-receive-pack` client in `packages/gitops` (`services/gitwrite.ts`, the `GitPusher`), with the ref's expected old value. Kvarm never reimplements git storage.

### 2.2 D1 holds registry and state, never file content

Schema changes are new numbered migrations in `apps/platform/migrations/` (§6). Migrations are additive; existing data is not dropped or altered.

### 2.3 Content-addressed caching

Anything derived from immutable SHAs is cached in `caches.default` under synthetic keys `https://kvarm.internal/<kind>/...`, for example `treediff/<baseTree>/<headTree>`, `filediff/<oldBlob>/<newBlob>` and `risk/<baseTree>/<headTree>` (`cache/compare.ts`). These entries never need invalidation. Responses for moving refs get short TTLs and are invalidated by pushes. A cached body is served only **after** the per-request authority lookup (§10, §11.1); a cache hit never substitutes for authorization, and repository metadata is not exempt. When derived output changes shape, the cache key version advances so old entries are never adopted.

### 2.4 Budgets everywhere

Every walk (tree diff, merge-base search, snapshot build, guard scan) has explicit read, size and time budgets and returns `truncated: true` with a reason instead of failing or hanging. Per-request binding calls stay below the Workers subrequest limit.

### 2.5 Merge policy belongs to the contributor

`change_sets.merge_policy` is `auto`, `draft` or `review` (default `review`). `auto` merges through the queue when every required check passes; `draft` never merges, even after conflict resolution; `review` stays open until an explicit `POST …/merge`. Changes that Kvarm generates (conflict resolutions, compositions) declare their policy explicitly, and Kvarm never overrides a contributor's policy. The required check set comes from the checks gate (§0.3).

### 2.6 Stable versioned JSON and shared authorization

Endpoints live under `/api/v1`, use camelCase JSON with ISO 8601 UTC timestamps, and fail with `{error, code?}`. Every surface uses one repository authorization service (§11.1). Public reads stay possible; unauthorized access to a private repository is concealed (it answers exactly like a missing one).

### 2.7 No secrets in code or logs

Tokens are stored as SHA-256 hashes and shown once at creation. Worker secrets stay in the secret store. Cost headers and logs carry counts, never identifiers or secrets. `kvarm/guard` findings never include the secret value.

### 2.8 Cost-efficient by construction

Requests record work counters and stay within documented budgets (§10). Cached content is preferred over D1, Artifacts and Durable Objects; statements and messages are batched; N+1 queries are avoided; background work is bounded. Access revocation and tenant isolation take precedence over warm-cache shortcuts.

### 2.9 One owner per concern

Overlap signal, the operation registry and fencing each have exactly one owner (§0.1). Merge, queue and composition depend only on the checks gate (§0.3).

### 2.10 Check evidence identity and reserved namespaces

- The gate answers `kvarm/guard` only from the publishing change's own recorded run. A run judged against a different merge base than the publication's plan answers pending, never success, and a newer clean run from another change at the same head never masks an earlier failure.
- A bounded gate window that may have truncated reports pending; bounded reads never prove completeness by omission.
- Repository CI commands run in a minimal child environment without credential variables. Runner report summaries are bounded by the UTF-8 size of the complete serialized JSON and keep the job conclusion.
- `refs/heads/kvarm-ci/**` (CI staging) and `refs/heads/agents/**` (agent workspaces) are platform-reserved. Receive-pack rejects human pushes to them in every repository; platform writes use the direct writer.

### 2.11 Fast dev loop

The platform adds no avoidable wall-clock latency to merge, validation or CI paths. Answers are synchronous (an explicit merge publishes inside the request) or recorded (`kvarm/guard` and CI dispatch are written by the push-event consumer), and the gate answers pending until a verdict is recorded, never a stale one. Mergeability is probed once per (target, head) and then served from the content-addressed cache; checks-gate questions in one request share one bounded D1 batch. CI is fast by construction: snapshot checkout instead of clone, warm working directories reused across runner jobs, and container snapshot reuse. Turnaround is measured in [`docs/benchmarks/README.md`](benchmarks/README.md), not asserted.

## 3. Packages (pure, Node-tested)

- **`packages/gitops`**
  - `pack.ts`: packfile v2 writer, including the empty pack for pure ref moves.
  - `receivePack.ts`, `reportStatus.ts`, `refUpdates.ts`, `lsRefs.ts`: the smart-HTTP receive-pack client. It reads the advertisement, sends `<old> <new> <ref>` commands with `report-status`, and parses `unpack ok` / `ok <ref>` / `ng <ref> <reason>`. HTTP 200 alone is never success.
  - `mergebase.ts`: budgeted merge-base search over a commit reader. Criss-cross histories with several merge bases are refused.
  - `merge3.ts`, `mergeText.ts`: tree-level three-way merge plus line-level diff3 of blobs, returning merged entries and `conflicts[]` by kind (content, add-add, modify-delete, rename, type change, binary). It is also the engine of composition (§0.4) via `compose.ts`.
  - `resolve.ts`: deterministic conflict resolution, the stage between git's merge and a human or agent. Rules: non-overlapping hunks (already merged by diff3), the identical change on both sides, identical add-add, and whitespace-only conflicts (the target's variant wins). Lockfile conflicts are never resolved here; they are marked `needsRegeneration` and dispatched as a task (`services/conflicts.ts`, `services/tasks.ts`).
  - `tar.ts`: streaming ustar/pax writer for snapshots.
  - `notes.ts`: git-notes commits on `refs/notes/kvarm-attribution` (path = commit SHA).
  - `treediff.ts`: pruned tree diff with one global read limit.
- **`packages/diffcore`**: line diffs and hunks with work budgets.
- **`packages/review`**: `classifyFile` and `rateChange` (risk score, level and tags such as `ci-config`, `test-deletion`, `lockfile`, `new-dependency`, `generated`, `mechanical`, `security-sensitive`, `large`), and `guard`, the `kvarm/guard` rules: secrets (known token formats including `kvarm_pat_`/`kvarm_agt_`, private keys, high-entropy assignments), CI gaming (`|| true`, `continue-on-error: true`, deleted or skipped tests) and suspicious new dependencies.
- **`packages/ops`**: the shared operation registry (§0.1): every operation's REST route, MCP tool name, CLI command and JSON schema.
- **`packages/ui`**: server-rendering helpers for the existing pages.

## 4. Platform modules (`apps/platform/src`)

- **Access:** `services/access.ts` (credential and repository resolution, `resolveRepoAccess`, `authorizeRoute`), `services/authz.ts` (the shared policy), `services/orgs.ts`, `services/orgRepos.ts`, `services/grants.ts`, `services/agents.ts`, `services/branchRules.ts` (§11.1).
- **Reading code:** `services/compare.ts` resolves refs to commits and trees, diffs trees over the Artifacts binding, adds per-file stats, per-file diffs and risk from `packages/review`, and caches by content (§2.3, §9). `services/contents.ts` serves trees and files; `services/snapshots.ts` and `workflows/snapshotBuilder.ts` build and serve snapshot tarballs (§11.5).
- **Changes:** `services/changes.ts` implements change requests over `change_sets`: create, list, get, update, close, head refresh on push, risk rating, mergeability and the merge endpoint that honors the merge policy (§2.5, §5).
- **Checks and CI:** `services/checks.ts` (check runs with tree identity, the `kvarm/guard` evaluation and the commit status rollup) and `services/ci.ts` with `workflows/ciPipeline.ts` (`.kvarm/ci.json` at the immutable head becomes queued check runs and fenced runner jobs). Both register as checks-gate producers (§0.3).
- **Merging:** `services/merge.ts` plans a fast-forward or a two-parent merge commit over `merge3` outside any lease, asks the checks gate about the exact tree, and publishes the one target ref through the `GitPusher` with the target as expected old value; a moved target is `STALE_TARGET` and is re-planned. `services/conflicts.ts` records conflict state and dispatches `resolve-conflict` tasks.
- **Merge queue:** `services/queue.ts` with `do/mergeLock.ts` and `services/trainKick.ts` runs the bounded integration train (§11.4). It never holds a publication lease while checks run.
- **Events:** `services/events.ts` and the Worker's `queue()` handler process push events with independently replayable effects (§11.5); `services/pushFreshness.ts` makes a confirmed push visible before its reply ends (§9).
- **Agents and coordination:** `services/workspaces.ts` (workspace lifecycle on `refs/heads/agents/<workspaceId>/<slug>`, §9), `services/intents/*` (the Nexus index and forecast, §11.2), `services/candidates.ts` and `services/compositions.ts` (candidate diffs, ranking, arenas and composition, §0.4, §11.7), `services/dependencies.ts` and `services/dependencyGate.ts` (pinned dependencies, §11.3), `services/tasks.ts` (agent tasks claimed under fenced leases), `services/reviews.ts` and `services/reviewGate.ts` (§0.4), `services/attribution.ts` and `services/decisions.ts`.
- **MCP:** `mcp/server.ts` builds an `McpServer` with the stateless `WebStandardStreamableHTTPServerTransport`, one server and transport per request, authenticated by Bearer token. Every tool comes from the operation registry and calls the same services as REST.
- **Cost:** `cost/meter.ts` (§10).
- **CLI (`apps/cli`):** snapshot checkout with git clone fallback, the user-owned CI runner with warm working directories, `kvarm status`, and every registry operation as `kvarm <group> <verb>`.

## 5. API surface

All repository routes live under `/api/v1/repos/:owner/:repo/...`. The README's API reference lists every endpoint and `kvarm help <group> <verb>` prints each operation's path, parameters and reply. The main areas:

| area | shape |
| --- | --- |
| compare | `GET compare/:base...:head` (`order=path\|risk`, `limit`, `cursor`) returns base and head `{ref, sha, tree}`, `files[]` with status, modes, blob hashes, optional line stats and risk, `totals`, `totalsComplete`, a change `rating`, `truncated` and `nextCursor`; `GET compare/:base...:head/file?path=` returns hunks; `GET commits/:sha/diff` compares a commit with its first parent |
| snapshots | `GET snapshots/:ref` (metadata, `202` while building, `404`), `POST snapshots/:ref` (explicit demand), `GET snapshots/:sha/download` (tarball stream from R2: gzip for new snapshots, plain tar for legacy ones) |
| changes | `POST changes {title, body?, base, head, mergePolicy?}`, `GET changes?state=`, `GET/PATCH changes/:n`, `POST changes/:n/merge`, `GET changes/:n/mergeability`, `GET changes/:n/checks` |
| checks and CI | `GET commits/:sha/status`, `POST check-runs`, `PATCH check-runs/:id`, `POST ci/jobs/claim`, `POST ci/jobs/:id/heartbeat`, `POST ci/jobs/:id/report` (`ci` scope) |
| merge queue | `POST/DELETE changes/:n/enqueue`, `GET queue`, `GET train` |
| workspaces and Nexus | `POST workspaces {task, agent}`, `GET workspaces`, `POST workspaces/:id/change-set`, `POST workspaces/:id/abandon`, `GET/POST workspaces/:id/intent`, `GET forecast`, `GET workspaces/overlap` (the only overlap surface, §0.1) |
| candidates | `GET candidates?base=&workspaces=a,b,c` (the list is the explicit candidate set), `POST candidates/compose`, arenas |
| tasks | `GET tasks`, `POST tasks/:id/claim`, `POST tasks/:id/heartbeat`, `POST tasks/:id/complete` |
| attribution | `GET/POST commits/:sha/attribution`, `POST decisions`, `GET context?task=\|path=` |
| MCP | `POST /mcp`, stateless Streamable HTTP; every registry operation is a tool |

## 6. Data model

D1 is created by `0001_init.sql` and extended by additive migrations:

| migration | adds |
| --- | --- |
| `0002_org_tenancy` | organizations, direct membership, per-repository grants and the shared account-name namespace (§11.1) |
| `0003_repo_owner_org` | the owning organization of an org repository |
| `0004_agent_credentials` | durable agent principals and their expiring, repository- and ref-scoped tokens (§11.1) |
| `0005_branch_rules` | opt-in branch rules (§11.1) |
| `0006_push_events` | the push event ledger and per-effect completion (§11.5) |
| `0007_snapshots` | per-commit snapshot metadata and per-tree tarballs (§11.5) |
| `0008_change_requests` | merge policy, base SHA, risk, kind and queue state on `change_sets` (§2.5, §4) |
| `0009_check_runs_newest` | an index for a change's newest check runs |
| `0010_workspaces` | workspace refs and lifecycle |
| `0011_intents`, `0013_observed_omitted`, `0022_nexus_path_shares` | the Nexus declared and observed path index, its completeness, and shared-path reads (§11.2) |
| `0012_candidates` | candidate sets, arenas and compositions |
| `0014_agent_decisions` | decision records indexed by task and path (§0.4) |
| `0015_merge_queue` | queue entries, train state, admission and the shared fenced claims (§11.4) |
| `0016_conflict_tasks`, `0017_task_dispatch` | conflict state, agent tasks and their fenced claims |
| `0018_reviews` | reviews, the review policy, escalations and the agent `model_family` (§0.4) |
| `0019_dependencies` | pinned draft dependencies (§11.3) |
| `0020_check_runs_identity` | check-run tree, attempt, required, quarantined and summary (§0.3) |
| `0021_ci_jobs` | user-owned CI runner jobs with generation and owner fencing |

## 7. Testing

`npm run test` runs two vitest projects. `packages` runs in Node (`packages/**/test`, `scripts/test`, `apps/cli/test`); `platform` runs the Worker in workerd through `@cloudflare/vitest-plugin`, with real D1 (every migration applied) and in-memory fakes for Artifacts behind small interfaces (`TreeReader`, `CommitReader`, `BlobReader`, `GitPusher`). Three-way merge is compared with real `git merge-file` and `git merge-tree --write-tree` on a scripted conflict corpus, and the receive-pack client is tested against a local `git receive-pack --stateless-rpc`. The real Artifacts binding is exercised by the live drivers in `scripts/*-e2e.mjs` against a deployed worker.

## 8. Deployment

The README's "Deploy from zero" and "Redeploy an existing deployment" sections are the deployment procedure. The committed `wrangler.jsonc` carries neutral placeholders; a deployer's D1 id and origin come from the environment or the gitignored `apps/platform/.env.deploy`, read by `scripts/wrangler-target.mjs`. Migrations are applied before the deploy that needs them.

## 9. Pinned behaviors

- **Compare.** Paginated responses carry `nextCursor`, and `totals` describe the whole reported comparison, never one page. A compare within its read budget reports `totalsComplete: true` with exact totals; a compare truncated by its budget reports `totalsComplete: false`, and its `totals` are a labeled lower bound over the discovered subset. Responses carry `x-kvarm-cache: hit|miss|bypass`; `?nocache=1` is honored for instance admins only, skips cache reads and writes, and is the method for cold timings. Per-file line stats appear for up to 300 changed files (above that, `statsOmitted: true`). Files over 4 MiB are `tooLarge`. Budgets: 2,000 tree reads and 20,000 changed files, then `truncated: true`.
- **Compare performance gate.** On the 1M-changed-line fixture, the cold compare file list must answer with p50 under 500 ms over 10 runs, and no request may exceed 30 s. If the gate failed twice, the planned fallback was per-commit path-to-hash manifests built on push. The gate is met without the fallback; see [`docs/benchmarks/compare.md`](benchmarks/compare.md).
- **Push freshness.** After a protocol-confirmed receive-pack (complete report, `unpack ok`, at least one `ok <ref>`), the gate advances the repository's view generation and `pushed_at` and awaits both (bounded) before the client sees the end of the reply. HTTP 200 alone, `ng`, fatal and truncated reports change nothing. The push-event dispatcher repeats invalidation and records effect completion.
- **Snapshots.** Default-branch pushes build eagerly; other refs build on explicit demand. `kvarm checkout` prints `source: snapshot` or `source: clone`.
- **CI.** Runner job leases last 120 s by default, renewed by heartbeat. A `.kvarm/ci.json` has at most 16 jobs; job names may not start with `kvarm/`.
- **Merge policy and the queue.** Enqueueing a `review` change approves its current head only; configured separate-review requirements remain additional gates. A draft cannot be enqueued (`409`). A head change stales approvals. A fast-forward merge reports `mergeCommit` equal to the head.
- **Workspaces.** The workspace ref is created server-side at the base head when the workspace is created. Abandoning a workspace deletes its ref and sets its status to `abandoned`; nothing is deleted automatically. Tasks are repository-scoped.
- **Attribution and decisions.** An attribution note is `{agent, session, promptHash, model?, actor, at}` on `refs/notes/kvarm-attribution`. Decision records and `get_context` are described in §0.4.
- **Agent review policy.** See §0.4. Approvals are revalidated immediately before publication; agent approvals never satisfy a protected target's human-approval requirement.
- **Semantic conflict.** A composition that merges cleanly but fails a required check on the composed tree is a semantic conflict, distinct from a textual one.

## 10. Cost metering and budgets

- **Meter.** `cost/meter.ts` wraps bindings in counting proxies for every request. It counts D1 round trips with rows read and written, Artifacts RPCs, Durable Object calls, R2 class A and class B operations, queue sends, outbound subrequests and the Cache API result. The counters are application work counts, not a bill: CPU, duration, storage and post-response background work are not included.
- **Header.** Every response carries `x-kvarm-cost: d1=…;rr=…;rw=…;art=…;do=…;r2a=…;r2b=…;q=…;sub=…;cache=hit|miss|none|bypass`, with counts only.
- **Background work.** The queue consumer, Workflows and the `MergeLock` Durable Object log the same counters per message, step or run, and store the last run's counters where an API exposes them (for example a snapshot's `buildCost`).
- **Authority before metadata and content.** Every repository metadata and content response (REST, git gate, pages, compare, snapshots and MCP repository tools) runs one bounded indexed D1 authority lookup before returning anything, including a cached hit (§11.1). That lookup is the authority component (`d1 ≤ 1`, `rr ≤ 8`, `do = 0`), not a cap on the whole request. A fully cached body totals `d1 ≤ 1`; a response that also reads its own service row (snapshot metadata or download, workspace list, queue read, cold compare) totals `d1 ≤ 2`; a bounded paginated service read (the dependency list) totals `d1 ≤ 3`. Writes authorize authoritatively and are not served from cache.
- **Other budgets.** The git gate makes no Durable Object call (`do = 0`). A cold compare costs at most `treeReads + blobReads + 3` Artifacts calls, with one documented exception of `+4` for a first-ever compare against a base off the head's first-parent chain in a colo with no cached token. Write endpoints batch their D1 statements; the queue consumer uses one D1 batch per message plus required work; an MCP tool call costs the same as the equivalent REST call. PAT `last_used_at` stamping is throttled to one write per token every 10 minutes.
- **Measured values.** [`docs/benchmarks/README.md`](benchmarks/README.md) records the median counters per endpoint, and `scripts/cost-sweep.mjs` re-checks every budget row against a deployed worker.

## 11. Tenancy, Nexus and the integration train

### 11.1 Tenant and principal model

- Users and organizations share one account-name namespace. Organizations have `owner`, `maintainer` and `member` roles; at least one owner always remains. Repositories accept explicit `admin`, `write` and `read` grants; members get no implicit private access. Durable agent principals belong to a user or organization and receive owner-minted, expiring tokens scoped to one repository and, for writes, a list of ref patterns. Agent tokens cannot mint credentials or escalate grants.
- `services/authz.ts` resolves the actor's role, the credential ceiling (token scopes) and public visibility in one decision; `services/access.ts` loads the credential, the repository's current row, the org membership and the repository grant in **one** authoritative D1 batch. Repository rows, memberships and grants are never cached, so a visibility flip, revocation or removal applies to the next request in every colo. The Cache API copy of a token never authorizes by itself. Unknown, deleted and revoked principals fail closed; private repositories the caller cannot read are concealed.
- Removing a member deletes that user's org-repository grants in the same guarded statement as the membership, including when an owner removes themselves; the last-owner protection stays inside that operation. Re-adding a former member does not reactivate old grants.
- The receive-pack gate parses bounded command headers before object data and enforces repository and workspace-ref access, branch rules, reserved namespaces and non-fast-forward rules. Agent tokens cannot leave their granted workspace refs.
- Branch rules are opt-in per repository and ref pattern. A protected ref cannot be created, updated or deleted by a direct push (the instance admin included); it changes only through the merge paths, which enforce required checks and required approvals from human principals other than the change author, pinned to the head SHA.

### 11.2 Intent and forecast service

- Workspaces record their declaration, base and head revision, actor and activity. The Nexus index stores declared and observed paths per workspace (with bounded prefixes for wide edits); forecast and overlap reads follow shared paths instead of comparing every pair of workspaces.
- Intent is declared at creation and updated later. Push processing reconciles the cumulative base-to-head changed-path set, so deletions and reverted edits leave the observed set.
- Declarations are non-exclusive. A forecast reports evidence, freshness, a confidence class (declared or observed), the matching workspaces, and `truncated`/incomplete reasons under explicit budgets and cursors. An empty or truncated forecast is not proof of compatibility. Prefix overlap works: a declaration of `src/` intersects an observed `src/a.ts`.
- The index steers work; mergeability and composed-tree checks remain the correctness gates. This service is the single owner of overlap signal (§0.1).

### 11.3 Draft dependency lifecycle

- A workspace may pin another workspace in the same repository at an exact revision. Chains are at most 4 deep, a workspace has at most 8 direct pins, and cycles are rejected with the offending path.
- Pins are `active`, `stale`, `satisfied` or `broken`. Source movement marks a pin stale; abandonment or ejection marks it broken; a landing satisfies it only when the pinned content is preserved in the published history. A SHA never counts as landed merely because a related change merged.
- Dependent contributors choose to repin, detach, or rebase or compose explicitly. Kvarm never rewrites a base or ref automatically.
- The train respects dependency order, and unresolved stale or broken pins cannot publish (`services/dependencyGate.ts`).
- **Landing settlement is bounded and durable.** Each settlement invocation processes a fixed number of pages of incoming pins; each page is one D1 batch fenced by the exact landing identity and pin revision, and also records a wake mark for each affected dependent. If work remains, the landing is handed to two independent owners: a continuation message on the existing event queue, and a settlement intent stored in the target ref's `MergeLock` Durable Object together with its alarm in one storage transaction. Wake marks follow a claim, send, confirm lifecycle on the fenced-claims machinery, so overlapping owners never both act on one mark. The alarm re-derives remaining work from D1, settles bounded pages idempotently, kicks queued dependents, resumes open `auto` dependents, and re-arms only while fenced work remains. One residual is accepted: a kick whose confirm failed may be sent once more after its claim lapses, which publication fencing absorbs.

### 11.4 Bounded integration train

- The queue keeps per-repository, per-target-ref partitions of immutable candidates in enqueue order, with the states queued, preparing, checking, ready, publishing, published, ejected and stale, the expected base and head, the approved tree, the check identity and an attempt generation.
- A train run takes the partition's D1 run claim, then composes the first 8 active entries in order, each on top of the previous candidate's prepared result, and asks the checks gate about each exact composed tree. At most 4 candidates are checking at once. Expensive merge, guard and CI work happens outside any publication lease. Admission is bounded: 64 active entries per repository, then `429 QUEUE_FULL` with `Retry-After: 30`; stale policy or revision answers `409`.
- Publication revalidates the current head, contributor policy, authorization, approvals and the exact composition check identity, acquires a short (30 s) generation- and owner-fenced lease in `MergeLock`, and moves the ref through receive-pack with the expected old value, parsing the status. The registry head never advances before the git ref is confirmed. A stale generation can neither release a successor's lease nor report success. An expired lease is recovered by its alarm, which kicks the train before clearing it.
- Required checks run on the actual composed tree; path-disjoint edits are not treated as semantic proof. A failing composition ejects or re-prepares only the affected entries. Foreign head movement invalidates and re-prepares affected candidates with bounded retries.
- Fast-forward and three-way merge graphs and the contributor's policy are preserved. `services/fencing.ts` provides the same generation/owner-fenced expiring claims for CI jobs and agent tasks.

### 11.5 Events and snapshots

- Artifacts `repo.pushed` events reach the `kvarm-events` queue through one account-level subscription. For each message, one ingest D1 batch records the event, advances `pushed_at` monotonically, moves the ref position only for a newer event and refreshes the heads of open changes on that branch. Each downstream effect (cache invalidation, snapshot build, `kvarm/guard`, CI dispatch, Nexus index, train kicks) runs and is recorded independently, so a redelivery runs only what is missing. Out-of-order pushes cannot roll state back; a genuine repeated transition (A→B→A→B) is still processed.
- Snapshots are addressed by commit: per-commit metadata points at an immutable per-tree tarball in R2, so commits with identical trees share bytes. `SnapshotBuilder` walks the tree in bounded Workflow steps. Reading metadata never starts a build.
- New tarballs are gzip-compressed at build time under a `.tar.gz` key (`CompressionStream('gzip')` at the runtime's default level; one gzip member per Workflow step, because compressor state cannot cross steps). The format lives in the tree row's `r2_key`, so no migration was needed and a tree already built as `.tar` keeps its object, which is never relabelled or rewritten. Download serves whichever object the row names: `application/gzip` with a `.tar.gz` filename (no `Content-Encoding`, so `fetch` and `curl` return the stored bytes and `content-length` matches them) or, for legacy snapshots, `application/x-tar`; `x-kvarm-snapshot-format` names the form. The edge cache key includes the format, so a gzip and a plain entry for one commit never answer for each other. `size` in snapshot metadata is the stored (compressed) size. The CLI detects gzip by its magic bytes, applies every extraction check to the decompressed stream and refuses output past 8 GiB or a 1000:1 ratio.
- Kvarm never deletes repository refs, user code or history automatically; an explicit abandon deletes only its workspace ref. Growing lists are paginated, comparisons and output are bounded, and runners poll with backoff.

### 11.6 Human and agent surfaces

REST, MCP and the CLI are thin adapters over the same services, generated from one operation registry (§0.1). They cover organizations, members and grants, agent credentials, reviews and escalations, workspaces, intents, forecasts and dependencies, the train and queue, tasks, candidates, compositions and arenas, attribution and decisions. CLI errors exit non-zero with an actionable message; MCP returns the same state and errors as REST.

### 11.7 Arenas and deferred experiments

An arena is an explicit candidate set of 2–8 workspaces created together from one brief and base (§0.1). The existing candidate ranking compares them and reports deliberate duplication separately. The caller selects a winner through the normal merge policy, and selection opens a human escalation (§0.4). Losing candidates stay open until explicitly abandoned; nothing is spawned or selected automatically.

Four further experiments (contract capsules, semantic packets, hotspot suggestions and priority credits) are designed but deferred (§0.2).

### 11.8 Scale evidence

Scale claims rest on one measured live run of 100 workspaces through the train, recorded in [`docs/benchmarks/fleet-100.md`](benchmarks/fleet-100.md), plus the per-endpoint counters. The drivers are bounded (one driver, at most 3 git children and 5 HTTP requests in flight, a 10,000-request campaign ceiling) and honor rate limits. These measurements do not support claims of universal thousand-agent throughput or a monetary bill.
