# Phase 0 Spike — Empirical findings on `apple/container`

Recorded against a real macOS 26.5.1 (build 25F80), Apple silicon (arm64) host.

```
container CLI version 1.0.0 (build: release, commit: ee848e3)
kernel: kata-static 3.28.0 arm64 (vmlinux-6.18.15-186)  [installed via `container system kernel set --recommended`]
node v22.23.0 / npm 10.9.8 / pnpm 10.28.0
```

> The brief flags these as blocking: "Everything downstream assumes these; verify before
> building." All JSON below is captured verbatim from this host and is the schema we pin to v1.0.0.

---

## 🔴 Two findings that change the design

### 1. `-p H:C` host port publishing does NOT forward to `localhost`
`container run -p 8080:80` records the mapping in config:
```json
"publishedPorts":[{"containerPort":80,"count":1,"hostAddress":"0.0.0.0","hostPort":8080,"proto":"tcp"}]
```
…but `curl http://localhost:8080/` returns **HTTP 000 (unreachable)**.

**What actually works:** the host reaches each container **directly at its per-container IP**:
```
curl http://192.168.65.2/   -> HTTP 200   (spike-web)
curl http://192.168.65.3/   -> HTTP 200   (spike-api)
```
Each container gets a routable IP on the network's vmnet subnet (here `192.168.65.0/24`,
gateway `.1`, containers from `.2`). **Access model = container IP, not `localhost:hostPort`.**
The UI should surface the container IP (+ DNS name) as the "where do I reach this" answer, and
treat `ports:` host mappings as advisory/metadata in v1 until/unless localhost forwarding is proven.

### 2. Service-to-service DNS requires an admin-created domain
On a shared user network, short names do **not** resolve out of the box:
```
container exec spike-api getent hosts spike-web   ->  (empty)
container exec spike-api wget http://spike-web/   ->  wget: bad address 'spike-web'
/etc/resolv.conf inside container: nameserver 192.168.65.1   (the gateway)
```
There are **no DNS domains configured** by default (`container system property list` → `[dns]` empty).
`container system dns create <domain>` exists but **must run as administrator (sudo)**.

**Implication for `depends_on` / inter-service discovery:** either (a) document a one-time
`sudo container system dns create <domain>` setup step and address services as `<name>.<domain>`,
or (b) the engine resolves sibling IPs itself (from `inspect`/`list`) and injects them. This is the
brief's Open Question #2/#3 — answered empirically here.

---

## ✅ Confirmed assumptions

- **Per-container IP + own gateway** — confirmed (each container routable from the host).
- **Labels persist and are queryable** — `container run --label containerge.stack=spike` →
  `configuration.labels: {"containerge.stack":"spike"}` in `list --format json`.
  There is **no native `--label` filter** on `container list`; the adapter filters client-side.
  This is the foundation of stack discovery (`stackStatus` via label-filtered list). ✅
- **`--format json` is stable and machine-clean** on `list`, `inspect`, `network/volume/image list`, `stats`.

---

## Captured JSON schemas (pinned to container 1.0.0)

### `container system status --format json`
```json
{"apiServerAppName":"container-apiserver","apiServerBuild":"release","apiServerCommit":"ee848e3...",
 "apiServerVersion":"container-apiserver version 1.0.0 (build: release, commit: ee848e3)",
 "appRoot":"/Users/<u>/Library/Application Support/com.apple.container/","installRoot":"/usr/local/",
 "status":"running"}        // "unregistered" before `container system start`
```

### `container list --all --format json`  (one container, abridged)
```json
[{
  "id":"spike-web",                              // == --name; this is the handle for stop/delete/exec
  "configuration":{
    "labels":{"containerge.stack":"spike"},      // <-- our discovery key
    "image":{"reference":"docker.io/library/nginx:alpine","descriptor":{"digest":"sha256:…"}},
    "initProcess":{"arguments":["nginx","-g","daemon off;"],"executable":"/docker-entrypoint.sh",
                   "environment":["…"],"workingDirectory":"/","user":{"id":{"uid":0,"gid":0}}},
    "networks":[{"network":"containerge-spike","options":{"hostname":"spike-web","mtu":1280}}],
    "publishedPorts":[{"containerPort":80,"hostPort":8080,"hostAddress":"0.0.0.0","proto":"tcp","count":1}],
    "resources":{"cpus":4,"memoryInBytes":1073741824},
    "capAdd":[],"capDrop":[],"readOnly":false,"stopSignal":"SIGQUIT"
  },
  "status":{
    "state":"running",                           // <-- per-container state (no docker-style flat string)
    "startedDate":"2026-06-26T00:19:39Z",
    "networks":[{"network":"containerge-spike","ipv4Address":"192.168.65.2/24",
                 "ipv4Gateway":"192.168.65.1","ipv6Address":"fd4f:…/64","macAddress":"f6:88:…","mtu":1280,
                 "hostname":"spike-web"}]
  }
}]
```
> NOTE: there is **no** Docker-style `docker compose ls` aggregate. We reconstruct per-stack status
> ourselves by listing all containers and grouping on the `containerge.stack` label.

### `container network list --format json`
```json
[{"id":"containerge-spike",
  "configuration":{"name":"containerge-spike","mode":"nat","plugin":"container-network-vmnet",
                   "labels":{},"options":{},"creationDate":"…"},
  "status":{"ipv4Gateway":"192.168.65.1","ipv4Subnet":"192.168.65.0/24","ipv6Subnet":"fd4f:…/64"}}]
```

### `container volume list --format json`
```json
[{"id":"spike-vol",
  "configuration":{"name":"spike-vol","driver":"local","format":"ext4","labels":{},"options":{},
                   "sizeInBytes":549755813888,
                   "source":"/Users/<u>/Library/Application Support/com.apple.container/volumes/spike-vol/volume.img"}}]
```
> Default volume size is 512 GiB sparse (`-s` to change). Volumes carry `labels` too — usable to
> tag anonymous volumes for the AnonVolumeReaper.

### `container image list --format json`  (abridged)
```json
[{"id":"54f2a904…","configuration":{"name":"docker.io/library/nginx:alpine",
   "descriptor":{"digest":"sha256:54f2a904…","mediaType":"application/vnd.oci.image.index.v1+json","size":10333}},
  "variants":[{"config":{"architecture":"arm64","config":{"Cmd":[…],"Entrypoint":[…],"Env":[…],
               "Labels":{…},"StopSignal":"SIGQUIT","WorkingDir":"/"}}}]}]
```

### `container stats --no-stream --format json <id>`
```json
[{"id":"spike-api","numProcesses":6,"cpuUsageUsec":24608,
  "memoryUsageBytes":16502784,"memoryLimitBytes":1073741824,
  "blockReadBytes":10293248,"blockWriteBytes":8192,"networkRxBytes":2439,"networkTxBytes":2392}]
```

### `container system property list`  (relevant defaults)
```
[dns]                       # empty by default -> no service discovery until a domain is created
[container] cpus=4 memory=1gb
[build]     image="ghcr.io/apple/container-builder-shim/builder:0.12.0" rosetta=true
[kernel]    binaryPath="opt/kata/share/kata-containers/vmlinux-6.18.15-186"
[registry]  domain="docker.io"
```

---

## CLI surface notes (vs. the brief's table)

- Subcommands present as documented: `run/create/start/stop/kill/delete/list/inspect/logs/exec/cp/stats`,
  `image|i`, `network|n`, `volume|v`, `registry|r`, `system|s`, `builder`, `build`.
- `container list` has **no** `--filter`/`--label` flag → filter client-side on the `containerge.stack` label.
- `container delete` alias `rm`; `list` alias `ls`; takes multiple ids.
- Starting the runtime: `container system start` (idempotent; needs a default kernel installed first
  via `container system kernel set --recommended`).

## Still open (need the host owner / a decision)
- `container system dns create <domain>` behavior — needs sudo; not yet exercised. Confirms whether
  `<service>.<domain>` resolution is the intended discovery path.
- `container exec -it` PTY cleanliness for the xterm.js web terminal (brief OQ #4) — not yet stress-tested.
- `container build` multi-arch + whether `container builder start` must run first (brief OQ #5).
