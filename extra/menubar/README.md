# Boxge menu bar

A native macOS menu bar app for Boxge. It shows every stack with its state, lets you start, stop
and restart a stack, and opens a stack in the web UI. It can also stop all containers at once,
start or stop Apple's container runtime, and start the Boxge server when it is down.

## Build and install

```bash
./build.sh --install
```

This builds `build/Boxge.app`, copies it to `~/Applications/Boxge.app` and starts it. Run
`./build.sh` without the flag to only build. Turn on **Launch at Login** from the app's own menu.

It needs the Xcode command line tools and macOS 26 or later.

## How it gets its data

When the Boxge server is running, the app talks to it over a small local API
(`/api/local/...`). The server writes its address and a random token to
`~/.boxge/local-api.json`, readable only by your user, each time it starts. The app reads that
file, so there is nothing to configure. The API only answers requests that carry the token and
come from this Mac.

Stack actions go through the server, so restart policies and health checks stay consistent with
what the web UI shows.

**Stop All Containers** stops every running container, including ones Boxge did not create, and
they stay stopped until you start them again. **Stop Apple Container** stops the runtime itself;
when you start it again, services with a restart policy come back unless you had stopped them by
hand. Both ask before doing anything.

When the server is not running, the app falls back to reading `container list` directly. In that
mode it only sees stacks that have containers and cannot control single stacks; the two stop
commands and starting the runtime still work, by calling the `container` tool. If the server was
installed with `scripts/install-service.sh`, the menu offers **Start Boxge Server**.

If the server runs with TLS and a certificate macOS does not trust, the app cannot reach it and
behaves as if the server were not running.

## Checking it from a terminal

```bash
~/Applications/Boxge.app/Contents/MacOS/Boxge --print-status
```

prints what the menu would show and exits.

Quit the app from its menu, or with `pkill -x Boxge`.
