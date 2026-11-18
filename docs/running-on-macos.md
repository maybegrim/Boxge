# Running Boxge on macOS

Boxge runs as a **native host process** (not a container) that drives Apple's `container` CLI, with
a web server on top. There's no `docker compose up`-style one-liner, so this is the install/run story.

## Prerequisites (one-time)

1. **macOS 26+ on Apple silicon** with Apple's container runtime installed
   (https://github.com/apple/container). Verify:
   ```bash
   container --version          # Boxge needs 1.7.1 or later
   ```
2. **Start the runtime once** so it can install its default kernel:
   ```bash
   container system start
   ```
   After that, Boxge starts the runtime itself on boot when it is not running. Set
   `BOXGE_SKIP_RUNTIME_START=1` if you would rather start it yourself.
3. **Node 22+** (`node --version`).
4. *(optional, for reaching services by name)* register a DNS domain with macOS. This needs admin
   rights, so it is a one-time manual step:
   ```bash
   sudo container system dns create boxge.test
   ```
   Then set the same domain under Settings, General, "Service DNS domain" and redeploy. A service
   named `db` is reachable as `db` from the other services in its stack, and as
   `db.<stack>.boxge.test` from the Mac. The settings page tells you when the domain is not
   registered yet. Without any of this, reach a container at its own IP, which Boxge shows in the UI.

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

## Menu bar app

```bash
./extra/menubar/build.sh --install
```

builds `Boxge.app`, puts it in `~/Applications` and starts it. It shows your stacks, can start,
stop and restart them, and can start the runtime or the server when they are down. See
`extra/menubar/README.md`.

> launchd **user agents** run within your login session, which is fine for a Mac mini you log into. A
> true boot-time daemon (`/Library/LaunchDaemons`, runs as root before login) is possible but the
> container runtime's per-user state and the occasional `sudo` operations (e.g. `system dns`) make
> the user-agent model the simpler, recommended default.

## Notes

- Boxge stamps every container with `boxge.stack=<name>` and puts each stack on its own network
  (`boxge-<stack>`); it only manages what it created.
- Published ports (`ports:`) are bound on the host, so a service is reachable at the Mac's address
  on its published port. A port written as `127.0.0.1:8080:80` stays on loopback; one written as
  `8080:80` is reachable from the rest of your network.
- Explicit stops are remembered in `data/supervisor-state.json`, so a service you stopped stays
  stopped when Boxge restarts, whatever its restart policy.
