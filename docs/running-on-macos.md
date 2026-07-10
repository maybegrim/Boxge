# Running Boxge on macOS

Boxge runs as a **native host process** (not a container) that drives Apple's `container` CLI, with
a web server on top. There's no `docker compose up`-style one-liner — this is the install/run story.

## Prerequisites (one-time)

1. **macOS 26+ on Apple silicon** with Apple's container runtime installed
   (https://github.com/apple/container). Verify:
   ```bash
   container --version          # Boxge is pinned to 1.0.0
   ```
2. **Install a default kernel and start the runtime** (downloads the recommended kata kernel):
   ```bash
   container system kernel set --recommended
   container system start
   ```
3. **Node 22+** (`node --version`).
4. *(optional, for cross-service discovery by name)* create a DNS domain — this needs admin rights,
   so do it once up front rather than in Boxge's hot path:
   ```bash
   sudo container system dns create boxge.test
   ```
   Services on a stack then resolve each other as `<service>.boxge.test`. Without this, reach a
   container at its own IP (Boxge surfaces it in the UI). See `docs/phase0-spike.md` for why.

## Quick start (foreground)

```bash
npm install
npm run build:frontend
npm start                       # serves on http://localhost:5001
```

Useful env vars: `BOXGE_PORT` (default 5001), `STACKS_DIR` (default `~/.boxge/stacks`),
`BOXGE_DATA_DIR` (default `./data`), `BOXGE_HOSTNAME`. Legacy `DOCKGE_*` names still work.

## Run as a service (headless, auto-restart)

A per-user **launchd** agent keeps Boxge running across logout/crash and starts it at login:

```bash
./scripts/install-service.sh    # builds the frontend if needed, then loads the agent
# ...
./scripts/uninstall-service.sh  # stop + remove
```

This writes `~/Library/LaunchAgents/com.boxge.server.plist` (see `extra/macos/` for the template),
logs to `./data/boxge.log`, and serves on `BOXGE_PORT` (default 5001). To change the port:

```bash
BOXGE_PORT=8800 ./scripts/install-service.sh
```

> launchd **user agents** run within your login session — fine for a Mac mini you log into. A
> true boot-time daemon (`/Library/LaunchDaemons`, runs as root before login) is possible but the
> container runtime's per-user state and the occasional `sudo` operations (e.g. `system dns`) make
> the user-agent model the simpler, recommended default.

## Notes

- Boxge stamps every container with `boxge.stack=<name>` and puts each stack on its own network
  (`boxge-<stack>`); it only manages what it created.
- Host port publishing (`ports:`) is recorded but does **not** forward to `localhost` on the
  container runtime — reach a service at its container IP (shown in the UI) or via the DNS domain.
