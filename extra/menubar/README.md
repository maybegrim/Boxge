# Boxge menu bar

A small native macOS menu-bar agent that shows your Boxge stacks at a glance. It reads
`container list` directly, so it works whether or not the web server is running.

Click the icon for a list of stacks (running/total per stack), a link to open the web UI, and a
refresh. It polls every 8 seconds.

## Build and run

```bash
swiftc -O BoxgeMenubar.swift -o boxge-menubar
./boxge-menubar
```

Quit it from its own menu, or with `pkill boxge-menubar`.

Needs the Xcode command line tools and macOS 11 or later.
