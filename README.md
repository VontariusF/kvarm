# Kvarm

Kvarm is a git platform for teams of people and coding agents, built on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) for the Cloudflare [next Git platform](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) competition. One Cloudflare Worker serves git smart-HTTP, a versioned REST API (`/api/v1`), an MCP server (`/mcp`) and server-rendered repository pages. Agents run wherever their users run them (Claude Code, Devin, a laptop) and coordinate through git refs, MCP tools, declared intents, the merge queue and task dispatch. Kvarm calls no hosted model.

## Contents

- [Architecture](#architecture)
- [Capabilities](#capabilities)
- [Interfaces](#interfaces)
- [Deploy from zero](#deploy-from-zero)
- [Redeploy an existing deployment](#redeploy-an-existing-deployment)
- [Local development and tests](#local-development-and-tests)
- [CLI](#cli)
- [MCP](#mcp)
- [API reference](#api-reference)
- [Demo harness](#demo-harness)
- [Benchmarks and measured limits](#benchmarks-and-measured-limits)
- [Deferred roadmap](#deferred-roadmap)
- [License](#license)
- [Contributing](#contributing)

## Architecture

[`docs/architecture.md`](docs/architecture.md) describes the design in full: the decisions behind it, the invariants, every package and platform module, the data model, the cost model, tenancy, the Nexus forecast and the integration train. Source comments cite its numbered sections ("architecture §11.4").

```
git client  --smart-HTTP-->  git gate (routes/git.ts) ------------------------> Artifacts (git storage)
REST client --/api/v1/*-->   Hono routers (thin) --> services/* (all logic) --> Artifacts reads (binding)
MCP client  --/mcp------->   MCP tools (thin) ----/                         \-> Artifacts writes (receive-pack client)
                                  D1 (registry and state)   Cache API (content-addressed)   R2 (snapshots)
Artifacts push event --> queue kvarm-events --> queue() consumer --> cache purge, snapshot build, kvarm/guard,
                                                                    CI dispatch, change head refresh, train kicks
CI pipeline workflow --> ci_jobs (D1) <-- claim/report -- `kvarm runner` on the user's machine
merge queue --> parallel preparation and checks --> short MergeLock publication lease --> receive-pack with expected old value
```

- **Artifacts is the only git store.** Reads go through the Artifacts binding. Every server-side write (merge commits, workspace refs, attribution notes) goes through the smart-HTTP receive-pack client in `packages/gitops`, with the expected old value of the ref.
- **D1 holds the registry and state, never file content.** Schema changes are additive numbered migrations in `apps/platform/migrations/`.
- **Thin adapters, one logic layer.** Routers and MCP tools only adapt requests. Behavior lives in `apps/platform/src/services/*`; pure algorithms live in `packages/*` and are tested in Node.
- **One operation registry.** `packages/ops` defines every API operation once. Each entry is a REST endpoint, an MCP tool and a `kvarm` CLI command, so the three surfaces cannot drift.
- **One authority.** Git, REST, MCP and pages share one authorization service. Every repository metadata or content response runs one bounded indexed D1 lookup before anything is returned, including cache hits.
- **Content-addressed caching.** Anything derived from immutable SHAs (tree diffs, file diffs, risk, merge plans) is cached in the Cache API under `https://kvarm.internal/...` keys and never needs invalidation.
- **Budgets everywhere.** Every walk (tree diff, merge base, snapshot, guard scan) has read, size and time budgets and returns `truncated` instead of failing. Every response carries an `x-kvarm-cost` work counter.

| path | contents |
| --- | --- |
| `apps/platform` | the Worker: routes, services, Durable Objects (`TokenCache`, `RateLimiter`, `MergeLock`, `CiRunnerSandbox`), Workflows (`snapshot-builder`, `ci-pipeline`, `merge`, `repo-import`), migrations, workerd tests |
| `apps/cli` | the `kvarm` CLI: snapshot checkout, user-owned CI runner, status and every registry operation ([`apps/cli/README.md`](apps/cli/README.md)) |
| `packages/gitops` | packfile writer, receive-pack client, merge base, three-way merge, deterministic conflict rules, tar writer, notes |
| `packages/diffcore` | tree and line diffs with work budgets |
| `packages/review` | risk classification, change rating and the `kvarm/guard` rules (secrets, CI gaming, suspicious dependencies) |
| `packages/ops` | the shared operation registry (REST, MCP, CLI) |
| `packages/ui` | server-side rendering helpers for the existing pages |
| `scripts` | ops (`mint-pat.mjs`, `license-audit.mjs`), live end-to-end drivers (`*-e2e.mjs`), the demo harness, benchmarks and the cost sweep |

## Capabilities

**Access and tenancy.** Users and organizations share one login namespace. Organizations have owner, maintainer and member roles; repositories accept explicit read/write/admin grants. Personal access tokens carry scopes (`read`, `write`, `api`, `ci`). Agent principals get repository-scoped, expiring tokens whose ref patterns limit what they may push (for example `refs/heads/agents/*`). Branch rules protect refs with required checks and required human approvals, enforced on direct pushes and on every merge path. Private repositories are concealed (a private repository you cannot read answers exactly like a missing one). Revocation and visibility changes apply on the next request.

**Review.** Changes (pull-request equivalents) have a contributor-chosen merge policy: `review` (merge on an explicit call), `auto` (merge when mergeable and every required check passes) or `draft` (never merges). Approvals bind to the exact head commit; a push stales them. Agents can review. A per-repository policy can require N approving reviews from principals other than the author, and reviewer assignment prefers a different model family than the author's. Reviewer disagreement, a request for changes, a protected path or a final arena selection opens an escalation that only a human can resolve. `kvarm/guard` screens every change head for leaked secrets (including Kvarm tokens), CI gaming (`|| true`, deleted tests) and suspicious new dependencies; the risk rating tags CI config, test deletions, lockfiles, new dependencies and security-sensitive paths.

**Coordination.** Agents work in workspaces: server-side refs under `refs/heads/agents/<workspaceId>/<slug>`. Each workspace can declare an intent (paths and prefixes); the Nexus forecast reports which other active workspaces overlap before anyone writes duplicate work. Candidates compare several attempts at the same task, arenas rank them, and composition merges compatible pieces from several attempts into one composed change, whose exact tree runs the required checks (a clean merge that fails a check is reported as a semantic conflict). A textual conflict becomes a `resolve-conflict` task that an agent claims under a generation-fenced lease, resolves in its own workspace and completes. Workspaces may pin to another workspace at an exact revision (chains of up to 4). Decisions (chosen and rejected candidates with reasons) are recorded and returned by `get_context`, and merge commits carry attribution notes on `refs/notes/kvarm-attribution`.

**Merging and CI.** An explicit merge publishes inside the request. The merge queue runs a bounded integration train: candidates are prepared and checked in parallel against their exact composed tree, and only the final publication holds a short generation-fenced lease. CI is user-owned: a repository's `.kvarm/ci.json` creates check runs and jobs; `kvarm runner` claims them on the user's machine, runs them from a snapshot checkout in a warm working directory and reports back. A Container CI runner (Cloudflare Containers, public beta) is an opt-in showcase of the same claim, run and report loop.

**Reading code.** Compare and per-file diffs (content-addressed cache, risk-ordered file lists), snapshot tarballs in R2 for checkout without a clone, push events with per-effect processing state, and the server-rendered repository pages.

## Interfaces

| surface | name |
| --- | --- |
| npm workspaces | `@kvarm/platform`, `@kvarm/cli`, `@kvarm/ops`, `@kvarm/gitops`, `@kvarm/diffcore`, `@kvarm/review`, `@kvarm/ui` |
| CLI and its environment | `kvarm` (`apps/cli/bin/kvarm.js`), `KVARM_BASE_URL`, `KVARM_PAT` |
| tokens | `kvarm_pat_<64 hex>` (personal access), `kvarm_agt_<64 hex>` (agent) |
| CI configuration | `.kvarm/ci.json` |
| platform check names | `kvarm/guard`, `kvarm/ci-config`, `kvarm/checks-window` (job names may not start with `kvarm/`) |
| response headers | `x-kvarm-cost`, `x-kvarm-cache`, `x-kvarm-snapshot-sha` |
| attribution notes ref | `refs/notes/kvarm-attribution` |
| CI staging refs (platform-reserved) | `refs/heads/kvarm-ci/**` |
| outbound event type | `kvarm.task.created` |
| MCP server identity, site name | `Kvarm` |

Stable surfaces that never carry the brand:

| surface | value |
| --- | --- |
| REST API prefix | `/api/v1` |
| MCP endpoint | `/mcp` |
| MCP tool names | every tool name in `packages/ops/src/index.js` (`list_repos`, `merge_change`, `enqueue_change`, …) |
| agent workspace refs (platform-reserved) | `refs/heads/agents/**` |
| provisioned Cloudflare resources | worker `kvarm-platform`, D1 `kvarm`, R2 `kvarm-snapshots`, queues `kvarm-events` and `kvarm-events-dlq`, Artifacts namespace `default`, event subscription `kvarm-artifacts-pushed` |
| live worker URL | your `KVARM_APP_ORIGIN` setting (see [Deploy from zero](#deploy-from-zero)) |

## Deploy from zero

These are the steps for a new Cloudflare account. `scripts/bootstrap.mjs` provisions the resources idempotently; read [Bootstrap limits](#bootstrap-limits) for what has and has not been verified. For the existing deployment, skip to [Redeploy an existing deployment](#redeploy-an-existing-deployment).

Requirements: Node 20 or later, git, and a Cloudflare account on the Workers Paid plan with access to Artifacts (open beta) and Containers (public beta).

1. **Clone, install and authenticate.**

   ```sh
   git clone https://github.com/kvarm-git/kvarm.git kvarm && cd kvarm
   npm ci
   cd apps/platform && npx wrangler login && npx wrangler whoami && cd ../..   # or export CLOUDFLARE_API_TOKEN=...
   ```

   npm may report that it skipped the `workerd`/`esbuild` install scripts; the binaries work regardless. If your login can see more than one account, set `CLOUDFLARE_ACCOUNT_ID` in the environment or in `apps/platform/.env.deploy` (step 3).

2. **Provision the resources with the bootstrap script.** It reads every name from `apps/platform/wrangler.jsonc`: the D1 database `kvarm`, the R2 snapshot bucket `kvarm-snapshots`, the event queue `kvarm-events` and its dead-letter queue `kvarm-events-dlq` (3 retries, see `queues.consumers`), the Artifacts namespace `default`, and the account-level subscription `kvarm-artifacts-pushed` that delivers Artifacts `repo.pushed` events to `kvarm-events`. The default run is a dry run: it lists your account and prints what is missing. `--apply` creates only the missing resources, lists the account again to verify, and writes the new database's id to `KVARM_D1_DATABASE_ID` in `apps/platform/.env.deploy` (gitignored, created from `.env.deploy.example`; an existing different id is never overwritten). Running it again creates nothing.

   ```sh
   node scripts/bootstrap.mjs            # dry run
   node scripts/bootstrap.mjs --apply    # create what is missing, verify
   ```

   The Durable Objects, Workflows, the Container class, the rate limiters and the queue consumer are not created here; the deploy in step 6 creates them. Wrangler has no Artifacts namespace create command, so when the namespace is missing the script creates one Artifacts repository, `kvarm-bootstrap`, in it; the namespace exists from then on, and the platform ignores push events from that repository because it has no Kvarm record.

   The manual equivalent, for reference (run from an empty directory so wrangler does not offer to edit the committed config):

   ```sh
   npx wrangler d1 create kvarm
   npx wrangler r2 bucket create kvarm-snapshots
   npx wrangler queues create kvarm-events
   npx wrangler queues create kvarm-events-dlq
   npx wrangler artifacts repos create kvarm-bootstrap --namespace default     # only if `artifacts namespaces get default` fails
   npx wrangler queues subscription create kvarm-events --source artifacts --events repo.pushed --name kvarm-artifacts-pushed
   ```

3. **Deployment target and origin.** The committed `wrangler.jsonc` pins no deployment: its `database_id` and `APP_ORIGIN` are neutral placeholders. Your values live in `apps/platform/.env.deploy`, which `npm run deploy`, `npm run db:migrate:remote` and the scripts that query remote D1 read through `scripts/wrangler-target.mjs`; environment variables of the same name take precedence. After the bootstrap, set `KVARM_APP_ORIGIN` there to your worker's origin (`https://kvarm-platform.<your-subdomain>.workers.dev`, or a custom domain); the deploy writes it into `vars.APP_ORIGIN`, and clone URLs and links are built from it. `ARTIFACTS_NAMESPACE` stays `default`.

4. **Rate limiting binding.** `READ_LIMITER` (600 requests per 60 s) and `WRITE_LIMITER` (120 per 60 s) are declared in the `ratelimits` block of `wrangler.jsonc`. Workers Rate Limiting has no create command: the deploy creates the binding. If the `namespace_id` values (`4601`, `4602`) collide with another Worker in your account, pick other unique integers.

5. **Apply the D1 migrations.**

   ```sh
   npm run db:migrate:remote --workspace apps/platform
   ```

6. **Deploy.** This creates the Worker, its Durable Objects, Workflows, the Container class, the rate limiters and the queue consumer.

   ```sh
   npm run deploy            # runs `wrangler deploy` with your target (scripts/wrangler-target.mjs)
   curl -s https://kvarm-platform.<your-subdomain>.workers.dev/healthz   # ok
   ```

7. **Secrets.** None are required. WorkOS sign-in is deferred: without its secrets `/auth/*` answers 503 and personal access tokens are the way in. To enable it later:

   ```sh
   cd apps/platform
   npx wrangler secret put WORKOS_CLIENT_ID
   npx wrangler secret put WORKOS_API_KEY
   npx wrangler secret put WORKOS_COOKIE_PASSWORD   # a random value of 32+ characters, e.g. openssl rand -hex 32
   ```

   and set `vars.WORKOS_REDIRECT_URI` to `<APP_ORIGIN>/auth/callback`.

8. **Bootstrap admin and token.** `scripts/mint-pat.mjs` creates the user (non-admin) if the login is new, inserts a `kvarm_pat_` token row into remote D1 and writes the plaintext token only to a gitignored env file (it refuses any other file and prints only the token prefix). The second command makes that user the instance admin (needed for the `?nocache=1` compare bypass and the Container CI runner).

   ```sh
   node scripts/mint-pat.mjs --login <admin-login> --scopes read,write,api,ci \
     --name bootstrap --token-file .env.local --key KVARM_PAT
   node scripts/wrangler-target.mjs d1 execute DB --remote \
     --command "UPDATE users SET is_admin = 1 WHERE login = '<admin-login>'"
   printf 'KVARM_BASE_URL=%s\nKVARM_USER=%s\n' https://kvarm-platform.<your-subdomain>.workers.dev <admin-login> >> .env.local
   ```

   `.env.local` at the repository root is gitignored; every token is one you mint for your own deployment. Load it with `set -a; . ./.env.local; set +a`. The live drivers in `scripts/` read `KVARM_BASE_URL`, `KVARM_USER` and `KVARM_PAT` from the environment (defaults: `http://localhost:8787` and `admin`). Further tokens: `mint-pat.mjs` with another `--login`/`--key`, or `POST /api/v1/user/tokens` from a signed-in web session (the token routes refuse PAT callers with `403`, so a PAT-only setup mints through `mint-pat.mjs`).

9. **Smoke test.** Create a repository, push to it and read its events:

   ```sh
   curl -s -X POST "$KVARM_BASE_URL/api/v1/repos" -H "Authorization: Bearer $KVARM_PAT" \
     -H 'content-type: application/json' -d '{"name":"hello","visibility":"private"}'
   git push "$KVARM_BASE_URL/<admin-login>/hello.git" main        # username anything, password the PAT
   curl -s -H "Authorization: Bearer $KVARM_PAT" "$KVARM_BASE_URL/api/v1/repos/<admin-login>/hello/events"
   ```

   The push event shows as processed within seconds. To run this repository's own gate on your deployment, see [Kvarm CI](CONTRIBUTING.md#kvarm-ci-the-gate-runs-on-kvarm).

### Bootstrap limits

- `scripts/bootstrap.mjs` is covered by unit tests against a simulated account (`scripts/test/bootstrap.test.ts`: a first `--apply` creates the six missing resources, a second creates none, and a failed listing stops the run before anything is created). It has been run in `--local` mode, and as a dry run and with `--apply` against an account that already held every resource, where it created nothing. Its create path has not been run against a brand-new Cloudflare account. If a create fails there, the script stops with wrangler's error; fix the cause and run it again, and it continues with whatever is still missing.
- Cloudflare allows one subscription per account-level Artifacts event source. If another queue in your account already subscribes to Artifacts `repo.pushed`, the subscription step fails and the script cannot see that subscription (it lists only `kvarm-events`); move that subscription to `kvarm-events` yourself.
- The script checks resources by name only. A resource that exists with the right name but different settings (for example a queue in another jurisdiction) is reported as present.

## Redeploy an existing deployment

With the resources above already provisioned (this is the path for the running deployment):

```sh
git clone https://github.com/kvarm-git/kvarm.git kvarm && cd kvarm
git checkout <commit>
npm install
cd apps/platform && npx wrangler whoami && cd ../..          # wrangler must be authenticated for the account
cp apps/platform/.env.deploy.example apps/platform/.env.deploy   # once: KVARM_D1_DATABASE_ID, KVARM_APP_ORIGIN
npm run db:migrate:remote --workspace apps/platform           # applies only migrations not yet applied
npm run deploy                                                # wrangler deploy with your target settings
curl -s -o /dev/null -w '%{http_code}\n' https://kvarm-platform.<your-subdomain>.workers.dev/healthz   # 200 (the APP_ORIGIN host)
```

`wrangler deploy` prints the uploaded version id; `/healthz` answers `200 ok`. A deploy reuses the D1 database, bucket, queues, Artifacts namespace and subscription, and rotates no secrets.

## Local development and tests

[CONTRIBUTING.md](CONTRIBUTING.md#fresh-clone-no-credentials) walks a fresh clone through install, local D1 migrations, the offline Worker and a self-minted local token, with no Cloudflare account or credentials. In short:

```sh
npm ci
npm run db:migrate:local --workspace apps/platform  # local D1 for wrangler dev
npm run typecheck                                   # tsc over packages, scripts, the Worker and the CLI
npm run lint                                        # oxlint
npm run test -- --maxWorkers=3                      # vitest: `packages` (Node) and `platform` (workerd) projects
npx vitest run --project platform                   # one project
cd apps/platform && npx wrangler dev -c wrangler.dev.jsonc --port 8787   # offline, without the Artifacts binding
node scripts/mint-pat.mjs --local --login dev --scopes read,write,api,ci --name local --token-file .env.local --key KVARM_PAT
```

The `platform` project runs the Worker in workerd with real D1 (every migration applied) and in-memory fakes for Artifacts; the real binding is exercised by the live drivers. Plain `npm run dev` uses `wrangler.jsonc` and needs `CLOUDFLARE_API_TOKEN`, because the Artifacts binding is remote-only. Live end-to-end drivers (`scripts/*-e2e.mjs`, for example `ci-e2e.mjs`, `merge-queue-e2e.mjs`, `review-approvals-e2e.mjs`) create their own repositories against a deployed worker using `KVARM_BASE_URL` and `KVARM_PAT`, and delete them afterwards.

This repository's automated gate is Kvarm's own CI: [`.kvarm/ci.json`](.kvarm/ci.json) runs the typecheck, lint and test jobs on a Kvarm deployment, and `scripts/dogfood-ci.mjs` drives one change through it. There is no third-party CI. See [Kvarm CI](CONTRIBUTING.md#kvarm-ci-the-gate-runs-on-kvarm), and [AGENTS.md](AGENTS.md) for agent contributors.

## CLI

```sh
npm install                                           # links the `kvarm` bin
export KVARM_BASE_URL=https://kvarm-platform.<your-subdomain>.workers.dev
export KVARM_PAT=kvarm_pat_...                        # or an agent token kvarm_agt_...
npx kvarm checkout <owner>/<repo> main ./work         # snapshot checkout, git clone fallback
npx kvarm runner --repo <owner>/<repo> --once         # claim and run one CI job (PAT with the ci scope)
npx kvarm status <owner>/<repo>                       # workspaces with their pins, the train, open tasks
npx kvarm change merge <owner>/<repo> 3               # any registry operation: kvarm <group> <verb>
npx kvarm help change merge                           # usage, REST endpoint and MCP tool name
```

CI configuration lives at `.kvarm/ci.json` in the repository:

```json
{"jobs":[{"name":"test","run":"npm test","required":true,"timeoutSeconds":900}]}
```

Details (warm working directories, extraction safety, exit codes): [`apps/cli/README.md`](apps/cli/README.md).

## MCP

`POST /mcp` is a stateless Streamable HTTP MCP server (`@modelcontextprotocol/sdk`). Authenticate with `Authorization: Bearer <token>`: a personal access token with the `api` scope or an agent token. Every tool runs the same service code and the same authorization as REST.

The 91 tools come from the shared registry, grouped by family: `user`, `repos`, `content`, `compare`, `workspaces`, `dependencies`, `changes`, `queue`, `reviews`, `tasks`, `nexus` (`forecast`, `get_overlap`, intents), `candidates` (compose, arenas), `orgs`, `agents`, `attribution` (`record_decision`, `get_context`) and `branch-rules`. `kvarm --help` lists each tool with its CLI command; `scripts/mcp-agent.mjs` is a scripted MCP client.

Example client configuration (Claude Code):

```sh
claude mcp add --transport http kvarm "$KVARM_BASE_URL/mcp" --header "Authorization: Bearer $KVARM_PAT"
```

## API reference

All endpoints are under `/api/v1`, take and return camelCase JSON with ISO 8601 UTC timestamps, and fail with `{"error": "...", "code": "..."}`. Authenticate with `Authorization: Bearer kvarm_pat_...` (the PAT needs the `api` scope) or an agent token. Git uses the token as the basic-auth password. Every response carries `x-kvarm-cost` (`d1`, `rr`, `rw`, `art`, `do`, `r2a`, `r2b`, `q`, `sub`, `cache`); compare responses also carry `x-kvarm-cache: hit|miss|bypass`.

| area | endpoints (repository routes are under `/api/v1/repos/:owner/:repo`) |
| --- | --- |
| user and tokens | `GET /user`, `GET/POST /user/tokens`, `DELETE /user/tokens/:id` |
| repositories | `GET/POST /repos`, `POST /import`, `GET/PATCH/DELETE /repos/:owner/:repo`, `POST …/forks` |
| content | `GET …/tree`, `GET …/contents` (path and `ref` as query parameters), `GET …/events` |
| compare | `GET …/compare/:base...:head` (`order=path\|risk`, `limit`, `cursor`), `GET …/compare/:base...:head/file?path=`, `GET …/commits/:sha/diff` |
| snapshots | `GET/POST …/snapshots/:ref`, `GET …/snapshots/:sha/download` |
| changes | `POST/GET …/changes`, `GET/PATCH …/changes/:n`, `POST …/changes/:n/merge`, `GET …/changes/:n/mergeability`, `GET …/changes/:n/checks` |
| merge queue | `POST/DELETE …/changes/:n/enqueue`, `GET …/queue`, `GET …/train` |
| checks and CI | `GET …/commits/:sha/status`, `POST …/check-runs`, `PATCH …/check-runs/:id`, `POST …/ci/jobs/claim`, `POST …/ci/jobs/:id/heartbeat`, `POST …/ci/jobs/:id/report` (`ci` scope) |
| reviews | `GET/PUT …/review-policy`, `GET/POST …/changes/:n/reviews`, `POST …/changes/:n/approve`, `…/request-changes`, `…/reviewers/assign`, `…/escalations/:id/resolve`, `GET …/reviews/pending` |
| workspaces and Nexus | `POST/GET …/workspaces`, `GET …/workspaces/:id`, `POST …/workspaces/:id/change-set`, `POST …/workspaces/:id/abandon`, `GET/POST …/workspaces/:id/intent`, `GET …/forecast`, `GET …/workspaces/overlap` |
| dependencies | `POST/GET …/workspaces/:id/dependencies`, `POST …/workspaces/:id/dependencies/:dep/repin`, `DELETE …/workspaces/:id/dependencies/:dep` |
| candidates | `GET …/candidates`, `POST …/candidates/compose`, `GET …/compositions`, `GET …/compositions/:id`, `POST/GET …/arenas`, `GET …/arenas/:id`, `GET …/arenas/:id/candidates`, `POST …/arenas/:id/select` |
| tasks | `GET …/tasks`, `GET …/tasks/:id`, `POST …/tasks/:id/claim`, `…/heartbeat`, `…/complete` |
| attribution | `GET/POST …/commits/:sha/attribution`, `POST …/decisions`, `GET …/context?task=\|path=` |
| organizations | `POST /orgs`, `GET /orgs/:org`, `GET /user/orgs`, `GET /orgs/:org/members`, `PUT/DELETE /orgs/:org/members/:login` (`owner`/`maintainer`/`member`), `GET/POST /orgs/:org/repos` |
| access | `GET …/grants`, `PUT/DELETE …/grants/:login`, `POST/GET /agents`, `GET/DELETE /agents/:id`, `POST/GET /agents/:id/tokens`, `DELETE /agents/:id/tokens/:tokenId`, `GET/POST …/branch-rules`, `GET/PATCH/DELETE …/branch-rules/:id`, `GET …/branch-policy` |

The exact path, parameters and reply of every registry operation are printed by `kvarm help <group> <verb>`, and its JSON schema is in `packages/ops/src/index.js`. Two behaviors worth knowing:

- An explicit merge of a head whose required checks have not been recorded yet answers `409 REQUIRED_CHECKS_PENDING` and publishes nothing. This applies to a conflict task's resolution head right after `complete_task`: its `kvarm/guard` run arrives with the push event a few seconds later (completion records it directly only for `auto` changes). `enqueue_change` takes the queue path instead and publishes once the checks are recorded.
- Merge, queue and validation answers are synchronous or recorded, never stale: an explicit merge publishes inside the request, and `kvarm/guard` and CI dispatch are recorded by the push-event consumer; until then the checks gate answers pending.

## Demo harness

One command drives four scripted agent principals (two authors, two reviewers) and one human through MCP against a deployed worker, on a fresh private repository. No hosted model is called.

```sh
set -a; . ./.env.local; set +a   # KVARM_BASE_URL, KVARM_PAT
node scripts/demo-harness.mjs              # the seven agent-coordination steps
node scripts/demo-harness.mjs --container  # plus the Container CI runner (cold vs snapshot-warm)
node scripts/demo-harness.mjs --keep       # keep the repository afterwards
```

The seven steps: workspaces and declared intents, the overlap forecast, pushes and change sets, agent reviews with one escalation answered by the human, a composed outcome published through the merge queue, a textual conflict dispatched as a task and resolved by an agent, and a decision record read back with `get_context`. Each step prints its tool calls with timings. The script exits non-zero when any step fails and deletes its repository, agents and tokens at exit.

`--container` adds the Container CI runner showcase: an instance-admin route runs one `kvarm runner --once` job inside a `cloudflare/debian-trixie` container through the native `ctx.container` API. Run 1 installs the runner and toolchain, lets the runner claim the job and check out its workspace, and only then saves the container with `snapshotContainer` before the command runs. Run 2, an ordinary check run of a second change at the same head, starts from that snapshot, skips setup and finds the workspace already prepared (a warm sync with no checkout). Both check runs record through the standard CI endpoints. The user-owned `kvarm runner` remains the primary runner.

## Benchmarks and measured limits

[`docs/benchmarks/README.md`](docs/benchmarks/README.md) holds every measured number with its method and sample count (clone versus snapshot checkout, compare cold and warm, edge-cache hit rates, per-endpoint `x-kvarm-cost` medians, overlap forecast and composition, the 100-workspace fleet run and the dev-loop turnarounds). Speed statements in this repository refer to those measurements only. `node scripts/bench.mjs --write` re-measures against a deployed worker; `node scripts/cost-sweep.mjs --cost-md <path>` checks every work-budget row. The counters are work counts (D1 round trips and rows, Artifacts and Durable Object calls, queue sends, subrequests), not a bill.

Dev-loop and CI turnaround, client-side wall clock, from the committed table (measured 2026-10-12 against the deployed worker; host and sample counts in the table):

| metric | n | p50 |
| --- | ---: | ---: |
| explicit merge (`POST …/merge` → 200) | 10 | 1108 ms |
| mergeability, cold / warm | 10 / 10 | 366 ms / 136 ms |
| push → `kvarm/guard` verdict recorded | 10 | 6589 ms |
| push → CI job created (claimable) | 10 | 7032 ms |
| runner claim → report, cold install / warm workdir | 5 / 5 | 2669 ms / 1573 ms |
| Container CI run 1 cold / run 2 snapshot-warm (total) | 1 / 1 | 18.9 s / 8.7 s |

Measured scale: one 100-workspace fleet run published 99 changes through the train at 15.91 publications per minute (enqueue → published p50 94.0 s, p90 219.1 s, [fleet-100](docs/benchmarks/fleet-100.md)).

Configured limits (constants in the code, documented with their behavior in the API reference above):

- Rate limits per token: 600 reads and 120 writes per minute (`READ_LIMITER`, `WRITE_LIMITER`); a push uses about two writes.
- Merge queue: 8 prepared entries per pass, 4 in checking at once, 64 active entries per repository (then `429 QUEUE_FULL` with `Retry-After: 30`), 30 s publication lease.
- Compare: at most 2,000 tree reads or 20,000 changed files (then `truncated: true`); per-file line counts up to 300 changed files; files over 4 MiB are `tooLarge`.
- Dependencies: chains of at most 4 workspaces, at most 8 direct pins per workspace.
- `kvarm/guard` reads at most 100 files, 64 KiB per side.
- CI: at most 16 jobs per `.kvarm/ci.json`; runner leases of 120 s, renewed by heartbeat.
- Known engine limits: criss-cross histories with several merge bases are refused (`422 MULTIPLE_MERGE_BASES`); Artifacts `log()` follows first parents and is capped at 1,000 entries; multi-ref atomicity is not assumed, so the platform pushes one ref per write.

## Deferred roadmap

Not built in this version, recorded for after the submission:

- The collaborative UI pass (new pages and the visual direction); the existing pages are unchanged.
- WorkOS sign-in (configured by the secrets above; personal access tokens are the supported path today).
- Flaky-test retry and quarantine, revert change sets, inbound incident webhooks, outbound webhook delivery (the `kvarm.task.created` events are stored, not delivered), audit export and `get_audit`.
- Contract capsules, semantic packets, hotspot suggestions, priority credits, resource lifecycle and crash reconciliation after a ref move.
- Advisory low-signal test flags and an auto-updating repository wiki.
- Adopting Effect TS across the codebase.

## License

Kvarm is released under the [MIT License](LICENSE). [`docs/licenses.md`](docs/licenses.md) lists every dependency in `package-lock.json` with its declared license and names the non-permissive ones; regenerate it with `node scripts/license-audit.mjs` (`--check` fails when it is stale). The report is an inventory, not legal clearance.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md): the credential-free setup, the gate, Kvarm CI, and the commit and pull-request guide. Coding agents also read [AGENTS.md](AGENTS.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md); everyone in the project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
