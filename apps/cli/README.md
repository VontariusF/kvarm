# kvarm CLI

`apps/cli` is the Kvarm command-line client. It needs Node 20 or later. Its
only runtime dependency is the workspace package `@kvarm/ops`, the operation
registry it shares with the MCP server.

```bash
npm install                      # from the repo root; links the `kvarm` bin
export KVARM_BASE_URL=https://kvarm.example.com   # your deployment's origin
export KVARM_PAT=...             # personal access or agent token
npx kvarm checkout <owner>/demo main ./demo
# or: node apps/cli/bin/kvarm.js checkout <owner>/demo main ./demo
```

## Configuration

| variable | meaning |
| --- | --- |
| `KVARM_BASE_URL` | Platform origin (required). |
| `KVARM_PAT` | Token for private repositories, writes and snapshot demands. A PAT needs the `api` scope for the REST API (API commands and the snapshot API), `ci` for the runner, and `read` for git access. |

The token goes to the REST API as `Authorization: Bearer` and to git as a
basic-auth header scoped to `KVARM_BASE_URL`. It is passed through
`GIT_CONFIG_*` environment variables, never on the command line. Git runs with
credential helpers disabled and terminal prompts off, so no credential store
is read or written.

## API commands (`kvarm <group> <verb>`)

Every entry of the shared operation registry (`packages/ops/src/index.js`) is
a CLI command, a REST endpoint and an MCP tool at the same time. The MCP
server at `POST /mcp` lists the same entries as tools, so the CLI, REST and
MCP surfaces cannot drift apart. `kvarm --help` lists every command;
`kvarm help <group> <verb>` (or `<group> <verb> --help`) shows its usage,
arguments, REST endpoint and MCP tool name; `kvarm <group>` alone lists the
group's verbs.

```bash
kvarm repo list --json
kvarm file read <owner>/demo README.md --ref main
kvarm tree get <owner>/demo src --ref main
kvarm compare get <owner>/demo main feature/x --order=risk
kvarm workspace create <owner>/demo --task "fix parser" --intent '{"paths":["src/parse.ts"]}'
kvarm workspace change-set <owner>/demo <workspace-id> --title "Fix parser" --merge-policy review
kvarm change merge <owner>/demo 3
```

Positional arguments come in the order shown by the usage line; the other
parameters are kebab-case flags (`--merge-policy review` or
`--merge-policy=review`). List flags repeat or take commas
(`--paths a.ts --paths src/` or `--paths a.ts,src/`); JSON flags take a JSON
value. The reply is printed as indented JSON, or as one line with `--json`.
Commands send `Authorization: Bearer $KVARM_PAT` when it is set and run
anonymously otherwise (public reads). The token is never printed.

Exit status: 0 on success; 1 on an API or network failure, with
`<command>: <CODE> (HTTP <status>): <error>`, a `details:` line carrying the
current state from the reply (for example the head on a stale-revision
conflict) and a `hint:` line on stderr (with `--json` the error body
`{status, error, code, ...}` is also printed on stdout); 2 on a usage error
that names the argument.

## `kvarm checkout <owner/repo> <ref> <dir>`

Materializes a branch, tag or full commit SHA into `<dir>`, which must be
missing or empty.

1. With `KVARM_PAT`, checkout sends the explicit snapshot demand
   `POST /api/v1/repos/<owner>/<repo>/snapshots/<ref>`. Default-branch
   snapshots build eagerly on push. Other branches and workspace refs build
   lazily, so this demand is what starts their build. Without a token,
   checkout only reads the metadata (`GET`) and never starts a build.
2. If the snapshot is ready, checkout downloads
   `…/snapshots/<sha>/download` by commit SHA, so a branch that moves mid-run
   cannot swap the content. Snapshot tarballs are stored zstd-compressed;
   checkout advertises `application/zstd` and decodes the stored frames when
   the platform serves them (Node ≥ 22.15; older runtimes receive the plain
   tar). It checks that the tar byte count equals the metadata `size` (and
   the wire bytes equal `encodedSize` when compressed) and extracts the
   tarball. Output: `source: snapshot`.
3. Otherwise it runs `git clone --no-checkout` + `git checkout <ref>`.
   Output: `source: clone`. This covers a build in progress (including the one
   this checkout just demanded), an absent or failed snapshot, a refused
   token, an unreachable API and a bad download. A partial extraction is
   removed before the clone. A later checkout of the same ref uses the
   snapshot once the demanded build is ready.

stdout always starts with the pinned `source:` line, followed by `sha:
<commit>` (plus `files:`, `bytes:` (tar bytes), `transfer:` (wire bytes)
and `encoding:` (`zstd` or `identity`) for a snapshot). The reason for a
fallback goes to stderr. Exit status: 0 on success, 1 on failure (for
example an unknown ref or a private repo without a token), 2 on usage errors.

The extractor handles the snapshot builder's ustar/pax archives: modes,
symlinks, long and unicode paths. It refuses absolute and `..` paths under the
host's path rules (on Windows that includes `\` separators, drive letters and
UNC paths; on Linux and macOS a backslash is an ordinary filename character).
Every entry must resolve inside the checkout directory; the extractor never
creates anything through an existing symlink or overwrites a file it did not
create, and it creates symlinks only after all other entries, so no entry can
be written through a link.

### Snapshots have no git history

A snapshot checkout is the tree of one commit. It has no `.git` directory, no
history and no refs. To commit and push from it, attach it to the repository
first:

```bash
cd <dir>
git init -q
git remote add origin "$KVARM_BASE_URL/<owner>/<repo>.git"
git fetch -q origin <sha>          # the sha printed by kvarm checkout
git reset -q <sha>                 # HEAD and index at <sha>; working files untouched
git switch -q -c <new-branch>
# edit, commit, then: git push origin <new-branch>
```

`git status` is clean right after the reset, because the snapshot tree equals
the commit tree. `scripts/cli-checkout-e2e.mjs` checks this recipe live,
including the final push. When an agent needs history from the start, a clone
is the better choice.

## `kvarm runner --repo <owner/repo> [--once] [--fresh] [--workdir <dir>]`

Starts a user-owned CI runner. It claims a queued `.kvarm/ci.json` job with a
120-second generation-fenced lease, materializes the job's exact immutable
commit through snapshot checkout (clone fallback), runs the configured command
in a shell with its timeout, heartbeats while it runs, and reports a bounded
summary. `--once` exits after one job, or immediately when the queue is empty.
The PAT must have `ci` scope. Repository commands run only because the user
explicitly starts this process.

Jobs run in a persistent working directory per repository
(`<workdir>/<owner>/<repo>/slot-<n>/work`; default root
`$XDG_CACHE_HOME/kvarm/runner`, else `~/.cache/kvarm/runner`). A runner
process locks its slot (`slot-<n>.lock`, owner pid and host) for its whole
lifetime; a concurrent runner for the same repository takes the next free
slot, and a lock whose process has died is reclaimed. The first job in a slot
is a full snapshot checkout, and the slot records the exact tree it produced
(every tracked path with its git blob hash and mode). Later jobs, including
later `--once` processes, sync the delta instead of downloading the tree:
the runner asks the compare API which paths changed between the recorded
commit and the new head and fetches only those files. Deleted paths
disappear, changed and added paths are written with their exact bytes and
modes, and any tracked file a previous job dirtied is restored from the
recorded hashes even when the delta does not touch it. Parent directories
are made real directories before a tracked file is inspected or written, so a
symlink left in the workdir never redirects a read, mode change or delete
outside it. Any other untracked path is removed unless it is a dependency
cache directory (`node_modules`, `.venv`, `venv`, `target`, `.cache`,
`.gradle`, `.turbo`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`,
matched by name at any depth, including below untracked or deleted
directories); pruning never follows a symlink. The tracked tree therefore
equals a fresh snapshot checkout while installs are reused. Any error on the
warm path, including an unreadable or invalid recorded state, falls back to a
full checkout into an emptied directory, so the job never fails because of
the fast path. `--fresh`
rematerializes every job from an empty directory (caches included). The
runner prints `workdir: warm` or `workdir: fresh` per job and
`reported <conclusion> for <job> (<id>) in <ms> ms` (claim to report).

A required job that fails is requeued once by the platform for a second
attempt on the same commit: the runner claims it again like any queued job
(same job id, the next generation; a report under the old generation is
refused as stale). The report reply carries `retry` (the attempt-2 run) after
a first failure and `flake` after a second-attempt pass. `kvarm flake list`,
`kvarm flake quarantine` and `kvarm flake restore` read the flake registry and
quarantine checks (architecture §0.3).

## Performance

See `docs/benchmarks/clone-vs-snapshot.md` (`scripts/bench-clone-vs-snapshot.mjs`).
Downloads go through `node:https` rather than the global `fetch`. On the
benchmark host, `fetch` streamed the 33 MB fixture tarball at about half the
throughput of `node:https` and curl.

## Tests

`apps/cli/test` runs in the root vitest `packages` project
(`npx vitest run --project packages apps/cli`). The tests extract archives
built with `@kvarm/gitops`'s tar writer and with `git archive`, and compare
the result against real `git checkout` trees. They also cover path-traversal
and symlink-escape archives, every fallback path, and the `kvarm` bin against
a local server: a fake snapshot API plus `git http-backend` for the clone.
