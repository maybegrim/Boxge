<div align="center">
  <img src="frontend/public/icon.svg" width="140" alt="Boxge logo" />
  <h1>Boxge</h1>
  <p>A self-hosted web manager for Apple's <code>container</code> runtime, in the spirit of Dockge.</p>
</div>

Boxge brings a Compose-style workflow to Apple's native `container` runtime on macOS: file-based
stacks, a config editor, live logs, and a web terminal.

It is a fork of [Dockge](https://github.com/louislam/dockge) (MIT, © Louis Lam). Boxge keeps
Dockge's architecture (a TypeScript backend, a Socket.IO real-time layer, and a Vue 3 frontend) and
replaces the one part that shelled out to `docker compose` with an adapter that drives the
`container` CLI directly. Apple's runtime has no Compose primitive, so Boxge implements that layer
itself: it parses a `compose.yaml`, turns each service into a `container run`, and manages a network
per stack.

## Requirements

- macOS 26 or later, on Apple silicon.
- Apple's [`container`](https://github.com/apple/container) runtime, version 1.0.0.

Boxge runs as a native host process and calls the `container` CLI. It is not itself a container, and
there is no Docker socket to mount.

## Getting started

```bash
container system start          # start the runtime if it isn't already
npm install
npm run build:frontend
npm start                       # http://localhost:5001
```

Open the web UI and create an administrator account on first launch. Stacks live at
`~/.boxge/stacks/<name>/compose.yaml`.

## How it works

Every interaction with the runtime lives in one module, `backend/container/`. It reads a stack's
`compose.yaml`, turns each service into a `container run`, and handles the things the runtime does
not do on its own: `depends_on` ordering and health gating, restart policies, and cleanup of
anonymous volumes. The supported `container` version is pinned, so keeping up with a CLI change
stays inside that one module.

What the runtime actually does (JSON output, networking, DNS) is written up in
[`docs/phase0-spike.md`](./docs/phase0-spike.md).

## Networking

Published ports (`ports:` in Compose) are bound on the host, so a service is reachable at the
machine's address on its published port, for example `http://<your-mac-ip>:8080`. The UI links to
that address, using the host's LAN IP by default. Each container also has a private IP on its
per-stack network, shown for reference; that one only works from the Mac itself.

Resolving services by name needs a DNS domain, created once by an administrator:

```bash
sudo container system dns create boxge.test
```

## Menu bar app

`extra/menubar/` has a small native macOS menu-bar agent that shows your stacks at a glance, separate
from the browser. See its [README](./extra/menubar/README.md) to build and run it.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BOXGE_PORT` | `5001` | Port the web UI listens on. |
| `BOXGE_HOSTNAME` | all interfaces | Address to bind the server to. |
| `STACKS_DIR` | `~/.boxge/stacks` | Where stacks are stored. |
| `BOXGE_DATA_DIR` | `./data/` | Application data (database, settings). |
| `BOXGE_ENABLE_CONSOLE` | `false` | Enable the host command console. |

The legacy `DOCKGE_*` equivalents still work.

## Development

```bash
npm install
npm run dev    # backend (5001) and frontend (5000) with hot reload
```

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
