# Connect a coding agent to Kvarm

Kvarm serves an MCP server at `<KVARM_ORIGIN>/mcp` (stateless Streamable HTTP, `POST` only, JSON responses). Every tool is an entry of the operation registry in `packages/ops/src/index.js`, so the tools, the REST API and the `kvarm` CLI cannot drift. Any MCP client that supports Streamable HTTP and a custom `Authorization` header can use it.

| client | guide | config format |
| --- | --- | --- |
| Claude Code | [claude-code.md](claude-code.md) | `claude mcp add --transport http` or `.mcp.json` |
| OpenAI Codex CLI | [codex.md](codex.md) | `~/.codex/config.toml` (`[mcp_servers.<name>]`) |
| Cursor | [cursor.md](cursor.md) | `.cursor/mcp.json` |
| Any other client | [generic.md](generic.md) | raw JSON-RPC over HTTP, plus a curl walkthrough |
| Droid, Devin, others | not written yet | contributions welcome: follow the page template below and say how you verified it |

Once connected, read [workflow.md](workflow.md) (the intended agent flow, tool by tool) and drop [AGENTS.template.md](AGENTS.template.md) into your own repository so the agent learns the flow without being told each time.

## Placeholders used in every guide

| placeholder | meaning |
| --- | --- |
| `<KVARM_ORIGIN>` | the origin of your Kvarm deployment, for example the value of your `KVARM_APP_ORIGIN` setting, with no trailing slash and no `/mcp` |
| `<AGENT_TOKEN>` | an agent token, `kvarm_agt_` followed by 64 hex characters |
| `<owner>/<repo>` | the repository the agent works in |

Never paste a real token into a file you commit. The snippets read the token from the environment variable `KVARM_AGENT_TOKEN` wherever the client allows it.

## Create an agent token

An agent token is minted by a human (or a personal access token with the `api` scope). Agent tokens cannot mint tokens, create agents or list repositories: those are account-level actions and answer `AGENT_FORBIDDEN`.

1. Create the agent principal once (`create_agent`; REST `POST /api/v1/agents`; CLI `kvarm agent create <name>`). The reply carries the agent `id`.
2. Mint a token for one repository (`create_agent_token`; REST `POST /api/v1/agents/:id/tokens`; CLI `kvarm agent token-create <id> ...`, see `kvarm help agent token-create`):

```sh
curl -s -X POST "<KVARM_ORIGIN>/api/v1/agents/<agent-id>/tokens" \
  -H "Authorization: Bearer <YOUR_PAT>" -H "Content-Type: application/json" \
  -d '{"repo":"<owner>/<repo>","role":"write","refs":["refs/heads/agents/*"],"expiresIn":3600,"name":"my-agent"}'
```

| field | rule |
| --- | --- |
| `repo` | `owner/name`; the token works on this repository only |
| `role` | `read` (no `refs`) or `write` (1 to 16 `refs` patterns, required) |
| `refs` | full ref names or patterns ending in `/*` below `refs/<kind>/`; the token can push only to refs matching one of them. `refs/heads/agents/*` confines an agent to workspace branches |
| `expiresIn` | seconds, 60 to 2592000 (30 days); default 3600 |

The reply contains the `token` exactly once (`Cache-Control: no-store`). Store it in your secret manager and export it for the client:

```sh
export KVARM_AGENT_TOKEN='<AGENT_TOKEN>'
```

Your own access bounds the token: you cannot mint a `write` token for a repository you cannot write to. Revoke one token with `revoke_agent_token` or every token of the agent with `revoke_agent`; revocation applies on the next request.

## What an agent token can and cannot do

| works | answers `AGENT_FORBIDDEN` (403) |
| --- | --- |
| repository reads (`get_repo`, `get_tree`, `read_file`, `compare`), workspaces, intents, `forecast`, changes, the queue, tasks, `record_decision`, `get_context` | `get_user`, `list_repos`, `create_repo`, organizations, agents and agent tokens, branch rules |

Because `list_repos` is account-level, **verify an agent token with `get_repo`** (or `list_workspaces`), and verify a personal access token with `list_repos`. Each guide shows both.

## Verification, in one line

`tools/list` returns the registry (94 tools at the time of writing; the exact number follows `packages/ops`), then call `get_repo` with `{"repo":"<owner>/<repo>"}`. A result with `isError: true` carries `{status, error, code}` and is the same body the REST route returns.

## Troubleshooting (all clients)

| symptom | cause and fix |
| --- | --- |
| HTTP 401 `UNAUTHENTICATED` on `/mcp` | token missing, malformed, expired or revoked. The header must be exactly `Authorization: Bearer <AGENT_TOKEN>`. Mint a new token; list token expiry with `list_agent_tokens` |
| HTTP 403 `INSUFFICIENT_SCOPE` | a personal access token without the `api` scope. Use an agent token, or mint a PAT with `api` |
| HTTP 405 on `GET /mcp` | expected: the server is `POST` only. Clients that open an optional `GET` event stream should tolerate this |
| HTTP 429 `RATE_LIMITED` | wait the `Retry-After` seconds (60) |
| a tool returns `isError` with `status` 403 `AGENT_FORBIDDEN` | the tool is account-level (see the table above). Use a PAT, or a different tool |
| a tool returns `status` 404 `NOT_FOUND` | the repository is not the one the token is bound to, or you cannot see it. Private repositories answer exactly like missing ones |
| `git push` rejected | the ref is outside the token's `refs` patterns, the workspace is not active or not the agent's own, or a branch rule applies. Push only to `refs/heads/agents/<workspaceId>/<slug>` |
| the token stops working mid-session | it expired (`expiresIn`). Mint a longer-lived token for long sessions, up to 30 days |
