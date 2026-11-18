# Boxge for agents

Coding agents can manage Boxge stacks on this Mac in two ways, both backed by the same local API
on the Boxge server:

- **MCP server**, for agents that speak MCP: `bin/boxge mcp` (stdio).
- **Command line tool**, for anything that can run a shell command: `bin/boxge`.

There is no token to configure. The server writes its address and a random token to
`~/.boxge/local-api.json` each time it starts, readable only by your user, and both tools read it
from there. The API only answers requests that carry the token and come from this Mac. The Boxge
server has to be running.

## Register the MCP server

```bash
bin/boxge mcp-config
```

prints the lines below with the full path filled in.

| Agent | How |
| --- | --- |
| Claude Code | `claude mcp add boxge --scope user -- /path/to/Boxge/bin/boxge mcp` |
| pi | `pi mcp add boxge -- /path/to/Boxge/bin/boxge mcp` |
| Codex | In `~/.codex/config.toml`: `[mcp_servers.boxge]`, `command = "/path/to/Boxge/bin/boxge"`, `args = ["mcp"]` |
| omp and others | In an `mcp.json` or `.mcp.json`: `{ "mcpServers": { "boxge": { "command": "/path/to/Boxge/bin/boxge", "args": ["mcp"] } } }` |

## What an agent can do

| MCP tool | Command line | What it does |
| --- | --- | --- |
| `status` | `boxge status`, `boxge ls` | Runtime state and every stack with its services |
| `stack_get` | `boxge show <stack>` | Compose file, `.env` names, warnings, service state, IPs, ports |
| `stack_validate` | `boxge validate -f <file>` | Dry run: warnings and the `container` command per service |
| `stack_save` | `boxge apply <stack> -f <file>` | Create or update a stack, optionally deploy it |
| `stack_env_set` | `boxge env <stack> set K=V`, `unset K` | Change single `.env` variables |
| `stack_action` | `boxge deploy/start/stop/restart/update/down/clean <stack>` | Lifecycle, waits and returns the output |
| `service_action` | `boxge service <stack> <service> <action>` | Start, stop or restart one service |
| `stack_delete` | `boxge rm <stack> --yes` | Remove containers, network and the stack folder |
| `logs` | `boxge logs <stack> [service]` | Recent log lines |
| `exec` | `boxge exec <stack> <service> -- <cmd>` | Run a command in a container |
| `resources` | `boxge images`, `volumes`, `networks` | What the runtime holds |
| `stats` | `boxge stats` | CPU and memory per container |
| `disk_usage` | `boxge disk` | Disk space used and how much can be reclaimed |
| `settings_get`, `settings_set` | `boxge settings ...` | Service DNS domain, primary hostname, global variables |
| `runtime_start`, `runtime_stop` | `boxge runtime start`, `stop` | Start or stop Apple's container runtime |
| `stop_all` | `boxge stop-all` | Stop every running container |

`boxge help` lists every command.

## Safeguards

- Values in `.env` files and in the global variables are hidden unless asked for
  (`revealEnvValues`, `--secrets`). Single variables can be set without reading the others.
- Deleting a stack needs the stack name repeated (`confirm`, or `--yes` on the command line), and
  the stack's files are kept if its containers could not be removed. Named volumes are never
  deleted.
- Every change made through the API is written to the server log with a `LOCAL-API` tag.

This is not a sandbox. An agent that can deploy a stack can mount any folder your user can read,
the same as an agent that can run `container` in a shell. Give it to agents you would give a
terminal.

## The API

Both tools are thin clients of `http://127.0.0.1:<port>/api/local`, with
`Authorization: Bearer <token>` taken from `~/.boxge/local-api.json`.

| Method and path | Purpose |
| --- | --- |
| `GET /status` | Overview |
| `GET /stacks/:name` | One stack (`?secrets=1` to include `.env` values) |
| `PUT /stacks/:name` | Save `{ composeYAML, composeENV?, deploy? }` |
| `POST /stacks/:name/env` | `{ set?, unset? }` |
| `DELETE /stacks/:name?confirm=:name` | Delete |
| `POST /stacks/:name/:action` | `start`, `deploy`, `stop`, `restart`, `update`, `down`, `clean` (`?wait=1` to wait) |
| `POST /stacks/:name/services/:service/:action` | `start`, `stop`, `restart` |
| `POST /stacks/:name/services/:service/exec` | `{ command: [...], timeoutSeconds? }` |
| `GET /stacks/:name/logs` | `?service=&tail=` |
| `POST /validate` | `{ composeYAML, composeENV?, name? }` |
| `GET /resources/:kind` | `images`, `volumes`, `networks` |
| `GET /stats` | Container stats |
| `GET /disk` | Disk usage |
| `GET /settings`, `PUT /settings` | Settings |
| `POST /runtime/start`, `POST /runtime/stop` | Runtime |
| `POST /containers/stop-all` | Stop every running container |

To run a second Boxge server next to the main one, for testing, give it its own file with
`BOXGE_LOCAL_API_FILE=/some/path.json`; the tools honour the same variable. A server never takes
the file over from another server that is still answering.

If the server runs with TLS and a certificate Node does not trust, the tools cannot reach it.
