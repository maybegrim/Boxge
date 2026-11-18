<div align="center">
  <img src="frontend/public/icon.svg" width="140" alt="Boxge logo" />
  <h1>Boxge</h1>
  <p>A self-hosted web manager for Apple's <code>container</code> runtime, in the spirit of Dockge.</p>
</div>

Boxge brings a Compose-style workflow to Apple's native `container` runtime on macOS: file-based
stacks, a config editor, live logs, and a web terminal. It also has a menu bar app, and a command
line tool and MCP server so coding agents can manage stacks.

It is a fork of [Dockge](https://github.com/louislam/dockge) (MIT, © Louis Lam). Boxge keeps
Dockge's architecture (a TypeScript backend, a Socket.IO real-time layer, and a Vue 3 frontend) and
replaces the one part that shelled out to `docker compose` with an adapter that drives the
`container` CLI directly. Apple's runtime has no Compose primitive, so Boxge implements that layer
itself: it parses a `compose.yaml`, turns each service into a `container run`, and manages the
networks of each stack.

## Requirements

- macOS 26 or later, on Apple silicon.
- Apple's [`container`](https://github.com/apple/container) runtime, version 1.7.1 or later.
- Node 22 or later.

Boxge runs as a native host process and calls the `container` CLI. It is not itself a container, and
there is no Docker socket to mount.

## Getting started

```bash
npm install
npm run build:frontend
npm start                       # http://localhost:5001
```

Boxge starts the container runtime on boot if it is not already running.

Open the web UI and create an administrator account on first launch. Stacks live at
`~/.boxge/stacks/<name>/compose.yaml`. To run Boxge as a service that starts at login, see
[`docs/running-on-macos.md`](./docs/running-on-macos.md).

## How it works

Every interaction with the runtime lives in one module, `backend/container/`. It reads a stack's
`compose.yaml`, turns each service into a `container run`, and handles the things the runtime does
not do on its own:

- `depends_on` ordering, with health gating.
- Health checks, run with `container exec`.
- Restart policies, with a growing delay between attempts and a limit for `on-failure:N`. A service
  you stopped stays stopped, also across a Boxge restart.
- Cleanup of anonymous volumes and of the stack's networks on `down`.

A deploy only recreates the services whose configuration or image changed. Live logs keep following
a service after it is recreated. Boxge checks the `container` version at boot and warns when it is
older than the minimum.

## Compose support

Variables (`${VAR}`, `${VAR:-default}`, `$$` for a literal `$`) are filled in from the stack's
`.env` and from `global.env` in the stacks directory, the same way Compose does it.

Supported service keys include `image`, `build` (with `args` and `target`), `command`,
`entrypoint`, `environment`, `env_file` (with `required: false`), `ports` (short and long form,
host IP, ranges), `volumes` (short and long form), `tmpfs`, `networks`, `secrets`, `depends_on`,
`healthcheck`, `restart`, `profiles`, `extends` (same file or another file), `pull_policy`,
`stop_grace_period`, `stop_signal`, `user`, `working_dir`, `labels`, `cpus`, `mem_limit`,
`cap_add`, `cap_drop`, `read_only`, `init`, `tty`, `ulimits`, `platform` and the `dns` options.

Things that work differently from Docker, because of the runtime:

- **Only folders can be mounted, not single files.** A bind mount of a file such as
  `./nginx.conf:/etc/nginx/nginx.conf` is refused with a message; mount the folder that holds it.
  For the same reason `configs` is not supported.
- **Secrets** are mounted read-only in `/run/secrets`, from a `file` or an `environment` variable.
  Other target paths are not supported.
- **Named volumes keep the name you give them.** A volume called `data` is shared by every stack
  that uses that name. Give it a `name:` under top-level `volumes` to choose a distinct one.
  Volumes marked `external` are never created or removed.
- **Networks**: each stack gets `boxge-<stack>`, and every other network it declares becomes
  `boxge-<stack>.<name>`, unless it is `external` or has its own `name:`. `internal: true` is
  honoured. Per-network aliases and fixed addresses are not.
- **`on-failure` restarts after any exit** and `service_completed_successfully` cannot check the
  exit status, because the runtime does not report exit codes.
- **A service without a host port** in `ports` is published on the same port number.

Anything Boxge does not support, for example `container_name`, `hostname`, `privileged`,
`network_mode` or `links`, is listed as a warning on the stack page and in the deploy output
instead of being dropped silently.

## Networking

Published ports (`ports:` in Compose) are bound on the host, so a service is reachable at the
machine's address on its published port, for example `http://<your-mac-ip>:8080`. A port written as
`127.0.0.1:8080:80` stays on loopback. The UI links to the published address, using the host's LAN
IP by default. Each container also has a private IP on its network, shown for reference; that one
only works from the Mac itself.

Services can also reach each other by name. This is off by default. To turn it on, register a DNS
domain with macOS once, as an administrator:

```bash
sudo container system dns create boxge.test
```

Then enter the same domain under Settings, General, "Service DNS domain", and redeploy your stacks.
Inside a stack, a service named `db` is then reachable as `db`. From the Mac, and from other stacks,
it is `db.<stack>.boxge.test`. Boxge does this with the runtime's DNS aliases and a search domain per
stack, and it does not edit the runtime's own configuration.

## Menu bar app

`extra/menubar/` has a native macOS menu bar app. It shows your stacks with their state, starts,
stops and restarts them, opens a stack in the web UI, stops all containers at once, and starts or
stops Apple's container runtime:

```bash
./extra/menubar/build.sh --install
```

See its [README](./extra/menubar/README.md) for how it talks to the server.

## Agents

Coding agents such as Claude Code, Codex, pi and omp can manage stacks through an MCP server or a
command line tool, both in this repo:

```bash
bin/boxge mcp-config            # how to register the MCP server with each agent
bin/boxge help                  # the command line tool
```

They can read status, logs and disk usage, dry-run a compose file, create, edit, deploy and delete
stacks, run a command in a container, and change settings. See
[`extra/agent/README.md`](./extra/agent/README.md) for the tool list, the safeguards and the
underlying API.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BOXGE_PORT` | `5001` | Port the web UI listens on. |
| `BOXGE_HOSTNAME` | all interfaces | Address to bind the server to. |
| `STACKS_DIR` | `~/.boxge/stacks` | Where stacks are stored. |
| `BOXGE_DATA_DIR` | `./data/` | Application data (database, settings). |
| `BOXGE_ENABLE_CONSOLE` | `false` | Enable the host command console. |
| `BOXGE_SKIP_RUNTIME_START` | unset | Set to `1` to stop Boxge from starting the container runtime on boot. |
| `BOXGE_LOCAL_API_FILE` | `~/.boxge/local-api.json` | Where the server publishes its local API address and token. |
| `BOXGE_CONTAINER_BIN` | `container` | Path to the `container` command, if it is not on the PATH. |

The legacy `DOCKGE_*` equivalents still work.

## Development

```bash
npm install
npm run dev         # backend (5001) and frontend (5000) with hot reload
npm run check-ts    # type check
npm run lint        # ESLint
```

What the runtime actually does (JSON output, networking, DNS) was first written up in
[`docs/phase0-spike.md`](./docs/phase0-spike.md), which carries a note on what has changed since.

## Feature requests and bugs

Open an issue on GitHub.

If something is broken, include:

- what you were doing
- what you expected
- what actually happened
- your macOS version and the output of `container --version`
- any error output from the terminal, or `data/boxge.err.log` if you run it as a service

If you want a feature, describe the problem you are trying to solve, not just the feature you have in
mind. Knowing the goal makes it much easier to help.

This is a side project with a single maintainer, so a reply might take a while. Pull requests are
welcome, smaller and focused ones most of all.

## License

MIT. Boxge is a fork of Dockge by Louis Lam; the original copyright and license are kept in
[`LICENSE`](./LICENSE). Not affiliated with or endorsed by Apple.
