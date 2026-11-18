import fs from "node:fs";
import path from "node:path";
import { log } from "../log";
import {
    CREATED_FILE,
    EXITED,
    RUNNING,
    UNKNOWN,
} from "../../common/util-common";
import type { ChildProcess } from "node:child_process";
import {
    ANON_VOLUME_LABEL,
    MIN_CONTAINER_VERSION,
    NETWORK_PREFIX,
    STACK_LABEL,
    ensureSystemStartedImpl,
    invalidateContainerList,
    listAllContainers,
    readSystemStatus,
    registryLoginCmd,
    runContainerCmd,
    runContainerJson,
    spawnContainer,
    summarizeOutput,
    validateContainerVersion,
} from "./container-cli";
import {
    CONFIG_HASH_LABEL,
    STOP_SIGNAL_LABEL,
    STOP_TIMEOUT_LABEL,
    buildBuildArgs,
    buildRunArgs,
    builtImageTag,
    collectNamedVolumes,
    containerNameFor,
    fileMounts,
    prepareSecrets,
    serviceConfigHash,
    topoSortServices,
} from "./compose-translator";
import { healthMonitor } from "./health-monitor";
import { restartSupervisor } from "./restart-supervisor";
import type {
    IContainerStackEngine,
    ImageInfo,
    NetworkInfo,
    ParsedService,
    ParsedStack,
    ProgressSink,
    RawContainer,
    RawImage,
    RawNetwork,
    RawStats,
    RawVolume,
    ServiceStatus,
    StatsSnapshot,
    SystemStatus,
    VolumeInfo,
} from "./types";

const HEALTHY_WAIT_TIMEOUT = 120_000;
const DNS_LIST_TTL_MS = 30_000;
const SYSTEM_STOP_TIMEOUT = 120_000;
const LOG_SYNC_INTERVAL = 3000;
const CLEAN_TIMEOUT = 10 * 60_000;
const COMPLETED_WAIT_TIMEOUT = 300_000;

function linePrefixer(prefix: string, onData: (chunk: string) => void): (chunk: string) => void {
    let buffer = "";
    return (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) {
            onData(`\x1b[2m${prefix} |\x1b[0m ${line.replace(/\r$/, "")}\r\n`);
        }
    };
}

function hasHealthcheck(svc: ParsedService): boolean {
    return !!svc.healthcheck && !svc.healthcheck.disabled && svc.healthcheck.test.length > 0;
}

function describeFailure(result: { stderr: string; stdout: string; exitCode: number }): string {
    return summarizeOutput(result.stderr) || summarizeOutput(result.stdout) || `exit ${result.exitCode}`;
}

export class ContainerStackEngine implements IContainerStackEngine {

    private dnsDomainCache?: { at: number; domains: string[] };

    async listDnsDomains(): Promise<string[]> {
        const now = Date.now();
        if (this.dnsDomainCache && now - this.dnsDomainCache.at < DNS_LIST_TTL_MS) {
            return this.dnsDomainCache.domains;
        }
        const raw = await runContainerJson<unknown[]>([ "system", "dns", "list" ]);
        const domains = (Array.isArray(raw) ? raw : [])
            .map((entry) => (typeof entry === "string" ? entry : String((entry as { domain?: unknown; name?: unknown })?.domain ?? (entry as { name?: unknown })?.name ?? "")))
            .map((d) => d.toLowerCase().replace(/\.$/, ""))
            .filter((d) => d.length > 0);
        this.dnsDomainCache = { at: now,
            domains };
        return domains;
    }

    async isDnsDomainRegistered(domain: string): Promise<boolean> {
        try {
            const domains = await this.listDnsDomains();
            return domains.some((d) => domain === d || domain.endsWith("." + d));
        } catch (e) {
            log.debug("container", "dns list failed: " + (e instanceof Error ? e.message : e));
            return false;
        }
    }

    async systemStatus(): Promise<SystemStatus> {
        const { version, supported } = await validateContainerVersion();
        const raw = await readSystemStatus();
        return {
            running: raw?.status === "running",
            version,
            supported,
            minVersion: MIN_CONTAINER_VERSION,
            raw: raw ?? undefined,
        };
    }

    async ensureSystemStarted(): Promise<boolean> {
        const raw = await readSystemStatus();
        if (raw?.status === "running") {
            return false;
        }
        log.info("container", "container runtime not running; starting it (container system start)...");
        await ensureSystemStartedImpl();
        return true;
    }

    async stopSystem(): Promise<void> {
        log.info("container", "stopping the container runtime (container system stop)...");
        await runContainerCmd([ "system", "stop" ], { throwOnError: true,
            timeoutMs: SYSTEM_STOP_TIMEOUT });
        invalidateContainerList();
    }

    async stopAllContainers(): Promise<{ stopped: string[]; failed: { container: string; reason: string }[] }> {
        const running = (await this.listContainers()).filter((c) => c.status?.state === "running");
        const stopped: string[] = [];
        const failed: { container: string; reason: string }[] = [];
        for (const c of running) {
            restartSupervisor.markStopped(c.id);
            const result = await runContainerCmd(this.stopArgs(c.id, c));
            if (result.exitCode === 0) {
                stopped.push(c.id);
            } else {
                failed.push({ container: c.id,
                    reason: describeFailure(result) });
            }
        }
        return { stopped,
            failed };
    }

    async registryLogin(server: string, username: string, password: string): Promise<void> {
        await registryLoginCmd(server, username, password);
    }

    async registryLogout(server: string): Promise<void> {
        await runContainerCmd([ "registry", "logout", server ], { throwOnError: true });
    }

    async listRegistries(): Promise<string[]> {
        const { stdout } = await runContainerCmd([ "registry", "list" ]);
        return stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    }

    async up(stack: ParsedStack, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);

        for (const warning of stack.warnings) {
            onProgress(`\x1b[33m[boxge] warning:\x1b[0m ${warning}\r\n`);
        }

        if (stack.dnsDomain && !(await this.isDnsDomainRegistered(stack.dnsDomain))) {
            onProgress(`\x1b[33m[boxge] warning:\x1b[0m DNS domain '${stack.dnsDomain}' is not registered with macOS, so service names will not resolve. ` +
                `Run once: sudo container system dns create ${stack.dnsDomain}\r\n`);
        }

        for (const svc of stack.services) {
            const files = fileMounts(stack, svc);
            if (files.length > 0) {
                throw new Error(`service '${svc.name}' mounts a file (${files.join(", ")}). ` +
                    "The runtime can only mount folders; mount the folder that holds it instead.");
            }
        }

        const existingNetworks = new Set((await this.listNetworks()).map((n) => n.name));
        for (const network of stack.networks) {
            if (existingNetworks.has(network.name)) {
                continue;
            }
            if (network.external) {
                throw new Error(`network '${network.name}' is marked external but does not exist.`);
            }
            step(`Creating network ${network.name}`);
            const args = [ "network", "create", "--label", `${STACK_LABEL}=${stack.name}` ];
            if (network.internal) {
                args.push("--internal");
            }
            await runContainerCmd([ ...args, network.name ], { throwOnError: true });
        }

        for (const vol of collectNamedVolumes(stack)) {
            step(`Ensuring volume ${vol}`);
            await this.ensureVolume(vol, stack.name);
        }

        for (const svc of stack.services) {
            if (svc.build) {
                step(`Building image for service '${svc.name}'`);
                await runContainerCmd(buildBuildArgs(stack, svc), { cwd: stack.dir,
                    stream: onProgress,
                    throwOnError: true });
            }
        }

        for (const svc of stack.services) {
            if (!svc.image || svc.build) {
                continue;
            }
            const present = (await this.imageDigest(svc.image)).exists;
            if (svc.pullPolicy === "never") {
                if (!present) {
                    throw new Error(`service '${svc.name}': image ${svc.image} is not present and pull_policy is 'never'.`);
                }
                continue;
            }
            if (!present || svc.pullPolicy === "always") {
                step(`Pulling image ${svc.image}`);
                await runContainerCmd([ "image", "pull", svc.image ], { stream: onProgress,
                    throwOnError: true });
            }
        }

        const existing = new Map((await this.containersForStack(stack.name)).map((c) => [ c.id, c ]));

        const { order, cycle } = topoSortServices(stack);
        if (cycle.length > 0) {
            step(`⚠️  depends_on cycle among [${cycle.join(", ")}]; starting in declared order`);
        }
        for (const name of order) {
            const svc = stack.services.find((s) => s.name === name);
            if (!svc) {
                continue;
            }

            await this.waitForDependencies(stack, svc, step);

            const cname = containerNameFor(stack, svc.name);
            const hash = serviceConfigHash(stack, svc);
            const current = existing.get(cname);

            restartSupervisor.hold(cname);
            try {
                if (current && await this.isUpToDate(stack, svc, current, hash)) {
                    if (current.status?.state === "running") {
                        step(`Service '${svc.name}' is up to date`);
                    } else {
                        step(`Starting service '${svc.name}'`);
                        prepareSecrets(stack, svc);
                        await runContainerCmd([ "start", cname ], { stream: onProgress,
                            throwOnError: true });
                        healthMonitor.reset(cname);
                    }
                } else {
                    step(`${current ? "Recreating" : "Creating"} service '${svc.name}'`);
                    await this.removeContainer(current);
                    prepareSecrets(stack, svc);
                    await runContainerCmd(buildRunArgs(stack, svc, { [CONFIG_HASH_LABEL]: hash }), { cwd: stack.dir,
                        stream: onProgress,
                        throwOnError: true });
                    healthMonitor.reset(cname);
                }
                this.registerServiceSupervisors(stack, svc);
                restartSupervisor.markStarted(cname);
            } finally {
                restartSupervisor.release(cname);
            }
        }

        const wanted = new Set(stack.services.map((s) => containerNameFor(stack, s.name)));
        for (const c of existing.values()) {
            if (!wanted.has(c.id)) {
                step(`Removing orphan '${c.id}'`);
                healthMonitor.unregisterContainer(c.id);
                restartSupervisor.unregisterContainer(c.id);
                await this.removeContainer(c);
            }
        }

        step("✅ up complete");
    }

    private async waitForDependencies(stack: ParsedStack, svc: ParsedService, step: (msg: string) => void): Promise<void> {
        for (const dep of svc.dependsOn ?? []) {
            const depSvc = stack.services.find((s) => s.name === dep.service);
            if (!depSvc) {
                step(`⚠️  '${svc.name}' depends on '${dep.service}', which is not defined in this stack`);
                continue;
            }
            const depName = containerNameFor(stack, dep.service);

            if (dep.condition === "service_healthy") {
                if (!hasHealthcheck(depSvc)) {
                    step(`'${dep.service}' has no healthcheck; treating it as ready once started`);
                    continue;
                }
                step(`Waiting for '${dep.service}' to become healthy…`);
                const ok = await healthMonitor.waitForHealthy(depName, HEALTHY_WAIT_TIMEOUT);
                step(ok
                    ? `'${dep.service}' is healthy`
                    : `⚠️  '${dep.service}' did not become healthy in time; starting '${svc.name}' anyway`);
            } else if (dep.condition === "service_completed_successfully") {
                step(`Waiting for '${dep.service}' to finish…`);
                const done = await this.waitForStopped(depName, COMPLETED_WAIT_TIMEOUT);
                step(done
                    ? `'${dep.service}' finished (the runtime does not report exit codes, so success is assumed)`
                    : `⚠️  '${dep.service}' did not finish in time; starting '${svc.name}' anyway`);
            }
        }
    }

    private async waitForStopped(containerName: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const state = await this.stateOf(containerName);
            if (state === undefined || state === "stopped") {
                return true;
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
        return false;
    }

    private async isUpToDate(stack: ParsedStack, svc: ParsedService, current: RawContainer, hash: string): Promise<boolean> {
        if (current.configuration?.labels?.[CONFIG_HASH_LABEL] !== hash) {
            return false;
        }
        const runningDigest = current.configuration?.image?.descriptor?.digest;
        const local = await this.imageDigest(svc.image ?? builtImageTag(stack, svc));
        return !!runningDigest && !!local.digest && runningDigest === local.digest;
    }

    private registerServiceSupervisors(stack: ParsedStack, svc: ParsedService): void {
        const cname = containerNameFor(stack, svc.name);
        healthMonitor.register(stack.name, cname, svc.healthcheck);
        restartSupervisor.register(stack.name, cname, svc.restart, svc.restartMaxRetries);
    }

    registerSupervisors(stack: ParsedStack): void {
        for (const svc of stack.services) {
            this.registerServiceSupervisors(stack, svc);
        }
    }

    async down(stack: ParsedStack, opts: { removeNetwork?: boolean }, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);
        const failures: string[] = [];

        healthMonitor.unregister(stack.name);
        restartSupervisor.unregister(stack.name);

        const { order } = topoSortServices(stack);
        const existing = await this.containersForStack(stack.name);
        const byId = new Map(existing.map((c) => [ c.id, c ]));

        const anonCandidates = await this.collectMountedVolumeNames(existing);

        const remove = async (label: string, c: RawContainer) => {
            step(`Removing '${label}'`);
            try {
                await this.removeContainer(c, onProgress);
            } catch (e) {
                failures.push(e instanceof Error ? e.message : String(e));
            }
        };

        for (const name of [ ...order ].reverse()) {
            const c = byId.get(containerNameFor(stack, name));
            if (c) {
                await remove(name, c);
                byId.delete(c.id);
            }
        }
        for (const c of byId.values()) {
            await remove(`${c.id} (orphan)`, c);
        }

        try {
            await this.reapAnonymousVolumes(anonCandidates, step);
        } catch (e) {
            failures.push(e instanceof Error ? e.message : String(e));
        }

        if (opts.removeNetwork) {
            const owned = new Set(stack.networks.filter((n) => !n.external).map((n) => n.name));
            owned.add(NETWORK_PREFIX + stack.name);
            for (const network of await this.listNetworks()) {
                if (!owned.has(network.name) && network.labels[STACK_LABEL] !== stack.name) {
                    continue;
                }
                step(`Removing network ${network.name}`);
                const result = await runContainerCmd([ "network", "delete", network.name ], { stream: onProgress });
                if (result.exitCode !== 0) {
                    failures.push(`network delete ${network.name}: ${describeFailure(result)}`);
                }
            }
        }

        try {
            fs.rmSync(path.join(stack.dir, ".boxge"), { recursive: true,
                force: true });
        } catch (e) {
            failures.push(`could not remove prepared secrets: ${e instanceof Error ? e.message : String(e)}`);
        }

        if (failures.length > 0) {
            throw new Error(`down finished with ${failures.length} error(s): ${failures.join("; ")}`);
        }
        step("✅ down complete");
    }

    private async collectMountedVolumeNames(containers: RawContainer[]): Promise<Set<string>> {
        const names = new Set<string>();
        for (const c of containers) {
            try {
                const inspected = await runContainerJson<Array<{ configuration?: { mounts?: Array<{ type?: { volume?: { name?: string } } }> } }>>([ "inspect", c.id ]);
                for (const mount of inspected?.[0]?.configuration?.mounts ?? []) {
                    const volName = mount?.type?.volume?.name;
                    if (volName) {
                        names.add(volName);
                    }
                }
            } catch {
            }
        }
        return names;
    }

    private async reapAnonymousVolumes(candidates: Set<string>, step: (msg: string) => void): Promise<void> {
        if (candidates.size === 0) {
            return;
        }
        const volumes = await this.listVolumes();
        const byName = new Map(volumes.map((v) => [ v.name, v ]));
        for (const name of candidates) {
            const v = byName.get(name);
            if (v && ANON_VOLUME_LABEL in v.labels) {
                step(`Reaping anonymous volume ${name}`);
                await runContainerCmd([ "volume", "delete", name ], { throwOnError: true });
            }
        }
    }

    async restart(stack: ParsedStack, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);
        const existing = await this.containersForStack(stack.name);
        if (existing.length === 0) {
            step("Nothing deployed; performing up");
            return this.up(stack, onProgress);
        }
        for (const c of existing) {
            step(`Restarting '${c.id}'`);
            await this.restartContainer(c.id, c, onProgress);
        }
        step("✅ restart complete");
    }

    async pull(stack: ParsedStack, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);
        const images = new Set(stack.services
            .filter((svc) => svc.image && !svc.build && svc.pullPolicy !== "never")
            .map((svc) => svc.image as string));
        for (const image of images) {
            step(`Pulling image ${image}`);
            await runContainerCmd([ "image", "pull", image ], { stream: onProgress,
                throwOnError: true });
        }
        step("✅ pull complete");
    }

    async stopStack(stack: ParsedStack, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);
        const existing = await this.containersForStack(stack.name);
        for (const c of existing) {
            restartSupervisor.markStopped(c.id);
            if (c.status?.state === "stopped") {
                continue;
            }
            step(`Stopping '${c.id}'`);
            await runContainerCmd(this.stopArgs(c.id, c), { stream: onProgress,
                throwOnError: true });
        }
        step("✅ stop complete");
    }

    async startService(stackName: string, serviceName: string, onProgress: ProgressSink): Promise<void> {
        const name = `${stackName}-${serviceName}`;
        this.stepLogger(onProgress)(`Starting '${name}'`);
        await runContainerCmd([ "start", name ], { stream: onProgress,
            throwOnError: true });
        restartSupervisor.markStarted(name);
        healthMonitor.reset(name);
    }

    async stopService(stackName: string, serviceName: string, onProgress: ProgressSink): Promise<void> {
        const name = `${stackName}-${serviceName}`;
        restartSupervisor.markStopped(name);
        this.stepLogger(onProgress)(`Stopping '${name}'`);
        await runContainerCmd(this.stopArgs(name, await this.find(name)), { stream: onProgress,
            throwOnError: true });
    }

    async restartService(stackName: string, serviceName: string, onProgress: ProgressSink): Promise<void> {
        const name = `${stackName}-${serviceName}`;
        this.stepLogger(onProgress)(`Restarting '${name}'`);
        await this.restartContainer(name, await this.find(name), onProgress);
    }

    private stopArgs(name: string, c: RawContainer | undefined): string[] {
        const labels = c?.configuration?.labels ?? {};
        const args = [ "stop" ];
        const timeout = Number(labels[STOP_TIMEOUT_LABEL]);
        if (Number.isFinite(timeout) && timeout > 0) {
            args.push("-t", String(Math.round(timeout)));
        }
        if (labels[STOP_SIGNAL_LABEL]) {
            args.push("-s", labels[STOP_SIGNAL_LABEL]);
        }
        args.push(name);
        return args;
    }

    private async restartContainer(name: string, c: RawContainer | undefined, stream: ProgressSink): Promise<void> {
        restartSupervisor.hold(name);
        try {
            if (c?.status?.state !== "stopped") {
                await runContainerCmd(this.stopArgs(name, c), { stream,
                    throwOnError: true });
            }
            await runContainerCmd([ "start", name ], { stream,
                throwOnError: true });
            restartSupervisor.markStarted(name);
            healthMonitor.reset(name);
        } finally {
            restartSupervisor.release(name);
        }
    }

    private stepLogger(onProgress: ProgressSink): (msg: string) => void {
        return (msg: string) => onProgress(`\x1b[36m[boxge]\x1b[0m ${msg}\r\n`);
    }

    private async ensureVolume(name: string, stackName: string): Promise<void> {
        const vols = await this.listVolumes();
        if (vols.some((v) => v.name === name)) {
            return;
        }
        await runContainerCmd([ "volume", "create", "--label", `${STACK_LABEL}=${stackName}`, name ], { throwOnError: true });
    }

    private async imageDigest(ref: string): Promise<{ exists: boolean; digest?: string }> {
        const { exitCode, stdout } = await runContainerCmd([ "image", "inspect", ref ]);
        if (exitCode !== 0) {
            return { exists: false };
        }
        try {
            const parsed = JSON.parse(stdout) as Array<{ configuration?: { descriptor?: { digest?: string } }; descriptor?: { digest?: string } }>;
            const first = Array.isArray(parsed) ? parsed[0] : undefined;
            return { exists: true,
                digest: first?.configuration?.descriptor?.digest ?? first?.descriptor?.digest };
        } catch {
            return { exists: true };
        }
    }

    private async removeContainer(c: RawContainer | undefined, stream?: ProgressSink): Promise<void> {
        if (!c) {
            return;
        }
        if (c.status?.state !== "stopped") {
            const stopped = await runContainerCmd(this.stopArgs(c.id, c), { stream });
            if (stopped.exitCode !== 0) {
                log.debug("container", `stop ${c.id} before delete failed: ${describeFailure(stopped)}`);
            }
        }
        await runContainerCmd([ "delete", "--force", c.id ], { stream,
            throwOnError: true });
    }

    private async find(containerName: string): Promise<RawContainer | undefined> {
        const all = await this.listContainers();
        return all.find((c) => c.id === containerName);
    }

    private async stateOf(containerName: string): Promise<string | undefined> {
        return (await this.find(containerName))?.status?.state;
    }

    async diskUsage(): Promise<unknown> {
        return runContainerJson<unknown>([ "system", "df" ]);
    }

    async cleanStack(stackName: string, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);
        const running = (await this.containersForStack(stackName)).filter((c) => c.status?.state === "running");
        if (running.length === 0) {
            step("Nothing to clean: no containers of this stack are running");
            return;
        }
        for (const c of running) {
            step(`Reclaiming freed disk space in '${c.id}'`);
            await runContainerCmd([ "clean", c.id ], { stream: onProgress,
                throwOnError: true,
                timeoutMs: CLEAN_TIMEOUT });
        }
        step("✅ clean complete");
    }

    async listContainers(): Promise<RawContainer[]> {
        return listAllContainers();
    }

    async containersForStack(stackName: string): Promise<RawContainer[]> {
        const all = await this.listContainers();
        return all.filter((c) => c.configuration?.labels?.[STACK_LABEL] === stackName);
    }

    async stackStatus(stackName: string): Promise<ServiceStatus[]> {
        const containers = await this.containersForStack(stackName);
        return containers.map((c) => this.toServiceStatus(stackName, c));
    }

    async allStackStatus(): Promise<Map<string, ServiceStatus[]>> {
        const result = new Map<string, ServiceStatus[]>();
        for (const c of await this.listContainers()) {
            const stack = c.configuration?.labels?.[STACK_LABEL];
            if (!stack) {
                continue;
            }
            const list = result.get(stack) ?? [];
            list.push(this.toServiceStatus(stack, c));
            result.set(stack, list);
        }
        return result;
    }

    async streamStackLogs(stackName: string, onData: (chunk: string) => void): Promise<{ stop: () => void }> {
        const followers = new Map<string, { created: string; child: ChildProcess }>();
        let stopped = false;
        let syncing = false;
        let announcedEmpty = false;

        const sync = async () => {
            if (stopped || syncing) {
                return;
            }
            syncing = true;
            try {
                const containers = await this.containersForStack(stackName);
                if (stopped) {
                    return;
                }
                const present = new Set(containers.map((c) => c.id));
                for (const [ id, follower ] of followers) {
                    if (!present.has(id)) {
                        follower.child.kill();
                        followers.delete(id);
                    }
                }
                for (const c of containers) {
                    const created = c.configuration?.creationDate ?? "";
                    const existing = followers.get(c.id);
                    if (existing && existing.created === created) {
                        continue;
                    }
                    existing?.child.kill();
                    const service = c.id.startsWith(stackName + "-") ? c.id.slice(stackName.length + 1) : c.id;
                    onData(`\r\n\x1b[36m[boxge] ${existing ? "service was recreated, streaming logs again" : "streaming logs"}: ${service} (${c.id})\x1b[0m\r\n`);
                    const child = spawnContainer([ "logs", "-f", c.id ], { onData: linePrefixer(service, onData) });
                    followers.set(c.id, { created,
                        child });
                }
                if (containers.length === 0 && !announcedEmpty) {
                    announcedEmpty = true;
                    onData("[boxge] No containers for this stack yet. Logs appear here once it is deployed.\r\n");
                } else if (containers.length > 0) {
                    announcedEmpty = false;
                }
            } catch (e) {
                log.debug("container", "log sync failed: " + (e instanceof Error ? e.message : e));
            } finally {
                syncing = false;
            }
        };

        await sync();
        const timer = setInterval(() => void sync(), LOG_SYNC_INTERVAL);
        timer.unref();

        return {
            stop: () => {
                stopped = true;
                clearInterval(timer);
                for (const follower of followers.values()) {
                    try {
                        follower.child.kill();
                    } catch {
                    }
                }
                followers.clear();
            },
        };
    }

    private toServiceStatus(stackName: string, c: RawContainer): ServiceStatus {
        const service = c.id.startsWith(stackName + "-") ? c.id.slice(stackName.length + 1) : c.id;
        const ipv4 = c.status?.networks?.[0]?.ipv4Address?.split("/")[0];
        const state = c.status?.state ?? "unknown";
        return {
            service,
            containerName: c.id,
            state,
            health: state === "running" ? healthMonitor.getHealth(c.id) : undefined,
            ipv4,
            publishedPorts: c.configuration?.publishedPorts,
        };
    }

    async stackRuntimeStatusMap(): Promise<Map<string, number>> {
        const containers = await this.listContainers();
        const byStack = new Map<string, string[]>();

        for (const c of containers) {
            const stack = c.configuration?.labels?.[STACK_LABEL];
            if (!stack) {
                continue;
            }
            const list = byStack.get(stack) ?? [];
            list.push(c.status?.state ?? "unknown");
            byStack.set(stack, list);
        }

        const result = new Map<string, number>();
        for (const [ stack, states ] of byStack) {
            result.set(stack, this.aggregateStatus(states));
        }
        return result;
    }

    private aggregateStatus(states: string[]): number {
        if (states.length === 0) {
            return UNKNOWN;
        }
        const isStopped = (s: string) => s === "stopped" || s === "exited";
        if (states.some(isStopped)) {
            return EXITED;
        }
        if (states.some((s) => s === "running")) {
            return RUNNING;
        }
        return CREATED_FILE;
    }

    async statsForStack(stackName: string): Promise<StatsSnapshot[]> {
        const containers = await this.containersForStack(stackName);
        return this.statsForContainers(containers, stackName);
    }

    async allStats(): Promise<StatsSnapshot[]> {
        const containers = (await this.listContainers())
            .filter((c) => c.configuration?.labels?.[STACK_LABEL]);
        return this.statsForContainers(containers);
    }

    private async statsForContainers(containers: RawContainer[], stackName?: string): Promise<StatsSnapshot[]> {
        const ids = containers.filter((c) => c.status?.state === "running").map((c) => c.id);
        if (ids.length === 0) {
            return [];
        }
        let raw: RawStats[] = [];
        try {
            raw = await runContainerJson<RawStats[]>([ "stats", "--no-stream", ...ids ]);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("container", "stats failed: " + e.message);
            }
            return [];
        }
        return raw.map((s) => ({
            containerName: s.id,
            service: stackName && s.id.startsWith(stackName + "-") ? s.id.slice(stackName.length + 1) : s.id,
            numProcesses: s.numProcesses,
            cpuUtilization: s.cpuUtilization,
            memoryUsageBytes: s.memoryUsageBytes,
            memoryLimitBytes: s.memoryLimitBytes,
            networkRxBytes: s.networkRxBytes,
            networkTxBytes: s.networkTxBytes,
        }));
    }

    async listImages(): Promise<ImageInfo[]> {
        const raw = await runContainerJson<RawImage[]>([ "image", "list" ]);
        return raw.map((i) => ({
            id: i.id,
            reference: i.configuration?.name ?? i.id,
            digest: i.configuration?.descriptor?.digest,
            sizeInBytes: i.configuration?.descriptor?.size,
        }));
    }

    async listVolumes(): Promise<VolumeInfo[]> {
        const raw = await runContainerJson<RawVolume[]>([ "volume", "list" ]);
        return raw.map((v) => ({
            name: v.configuration?.name ?? v.id,
            driver: v.configuration?.driver ?? "local",
            sizeInBytes: v.configuration?.sizeInBytes ?? 0,
            source: v.configuration?.source ?? "",
            labels: v.configuration?.labels ?? {},
        }));
    }

    async listNetworks(): Promise<NetworkInfo[]> {
        const raw = await runContainerJson<RawNetwork[]>([ "network", "list" ]);
        return raw.map((n) => ({
            name: n.configuration?.name ?? n.id,
            mode: n.configuration?.mode ?? "nat",
            ipv4Subnet: n.status?.ipv4Subnet,
            ipv4Gateway: n.status?.ipv4Gateway,
            labels: n.configuration?.labels ?? {},
        }));
    }

    async networkNames(): Promise<string[]> {
        const networks = await this.listNetworks();
        return networks.map((n) => n.name).sort((a, b) => a.localeCompare(b));
    }

    static networkNameForStack(stackName: string): string {
        return NETWORK_PREFIX + stackName;
    }
}

export const containerEngine = new ContainerStackEngine();
