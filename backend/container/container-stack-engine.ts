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
    NETWORK_PREFIX,
    STACK_LABEL,
    ensureSystemStartedImpl,
    readSystemStatus,
    registryLoginCmd,
    runContainerCmd,
    runContainerJson,
    spawnContainer,
    validateContainerVersion,
} from "./container-cli";
import {
    buildBuildArgs,
    buildRunArgs,
    collectNamedVolumes,
    containerNameFor,
    topoSortServices,
} from "./compose-translator";
import { healthMonitor } from "./health-monitor";
import { restartSupervisor } from "./restart-supervisor";
import type { ParsedService } from "./types";

const HEALTHY_WAIT_TIMEOUT = 120_000;
import type {
    IContainerStackEngine,
    ImageInfo,
    NetworkInfo,
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

export class NotImplementedError extends Error {
    constructor(feature: string, phase: string) {
        super(`${feature} is not implemented yet — lands in ${phase}.`);
        this.name = "NotImplementedError";
    }
}

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

export class ContainerStackEngine implements IContainerStackEngine {

    async systemStatus(): Promise<SystemStatus> {
        const { version } = await validateContainerVersion();
        const raw = await readSystemStatus();
        return {
            running: raw?.status === "running",
            version,
            raw: raw ?? undefined,
        };
    }

    async ensureSystemStarted(): Promise<void> {
        const raw = await readSystemStatus();
        if (raw?.status === "running") {
            return;
        }
        log.info("container", "container runtime not running; starting it (container system start)...");
        await ensureSystemStartedImpl();
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

        step(`Ensuring network ${stack.networkName}`);
        await this.ensureNetwork(stack.networkName);

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
            if (svc.image && !svc.build && !(await this.imageExists(svc.image))) {
                step(`Pulling image ${svc.image}`);
                await runContainerCmd([ "image", "pull", svc.image ], { stream: onProgress,
                    throwOnError: true });
            }
        }

        const { order, cycle } = topoSortServices(stack);
        if (cycle.length > 0) {
            step(`⚠️  depends_on cycle among [${cycle.join(", ")}] — starting in declared order`);
        }
        for (const name of order) {
            const svc = stack.services.find((s) => s.name === name);
            if (!svc) {
                continue;
            }

            for (const dep of svc.dependsOn ?? []) {
                if (dep.condition === "service_healthy") {
                    step(`Waiting for '${dep.service}' to become healthy…`);
                    const ok = await healthMonitor.waitForHealthy(containerNameFor(stack, dep.service), HEALTHY_WAIT_TIMEOUT);
                    step(ok
                        ? `'${dep.service}' is healthy`
                        : `⚠️  '${dep.service}' did not become healthy in time — starting '${svc.name}' anyway`);
                }
            }

            step(`Starting service '${svc.name}'`);
            await this.runService(stack, svc, onProgress);
            this.registerServiceSupervisors(stack, svc);
        }

        step("✅ up complete");
    }

    private registerServiceSupervisors(stack: ParsedStack, svc: ParsedService): void {
        const cname = containerNameFor(stack, svc.name);
        if (svc.healthcheck && !svc.healthcheck.disabled && svc.healthcheck.test.length > 0) {
            healthMonitor.register(stack.name, cname, svc.healthcheck);
        }
        if (svc.restart && svc.restart !== "no") {
            restartSupervisor.register(stack.name, cname, svc.restart);
        }
        restartSupervisor.markStarted(cname);
    }

    registerSupervisors(stack: ParsedStack): void {
        for (const svc of stack.services) {
            this.registerServiceSupervisors(stack, svc);
        }
    }

    async down(stack: ParsedStack, opts: { removeNetwork?: boolean }, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);

        healthMonitor.unregister(stack.name);
        restartSupervisor.unregister(stack.name);

        const { order } = topoSortServices(stack);
        const existing = await this.containersForStack(stack.name);
        const existingIds = new Set(existing.map((c) => c.id));

        const anonCandidates = await this.collectMountedVolumeNames(existing);

        for (const name of [ ...order ].reverse()) {
            const cname = containerNameFor(stack, name);
            if (existingIds.has(cname)) {
                step(`Stopping '${name}'`);
                await runContainerCmd([ "stop", cname ], { stream: onProgress });
                step(`Removing '${name}'`);
                await runContainerCmd([ "delete", "--force", cname ], { stream: onProgress });
            }
        }

        const known = new Set(order.map((n) => containerNameFor(stack, n)));
        for (const c of existing) {
            if (!known.has(c.id)) {
                step(`Removing orphan '${c.id}'`);
                await runContainerCmd([ "delete", "--force", c.id ], { stream: onProgress });
            }
        }

        await this.reapAnonymousVolumes(anonCandidates, step);

        if (opts.removeNetwork) {
            step(`Removing network ${stack.networkName}`);
            await runContainerCmd([ "network", "delete", stack.networkName ], { stream: onProgress });
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
                await runContainerCmd([ "volume", "delete", name ]);
            }
        }
    }

    async restart(stack: ParsedStack, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);
        const existing = await this.containersForStack(stack.name);
        if (existing.length === 0) {
            step("Nothing running — performing up");
            return this.up(stack, onProgress);
        }
        for (const c of existing) {
            step(`Restarting '${c.id}'`);
            await runContainerCmd([ "stop", c.id ], { stream: onProgress });
            await runContainerCmd([ "start", c.id ], { stream: onProgress,
                throwOnError: true });
        }
        step("✅ restart complete");
    }

    async pull(stack: ParsedStack, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);
        for (const svc of stack.services) {
            if (svc.image && !svc.build) {
                step(`Pulling image ${svc.image}`);
                await runContainerCmd([ "image", "pull", svc.image ], { stream: onProgress });
            }
        }
        step("✅ pull complete");
    }

    async stopStack(stack: ParsedStack, onProgress: ProgressSink): Promise<void> {
        const step = this.stepLogger(onProgress);
        const existing = await this.containersForStack(stack.name);
        for (const c of existing) {

            restartSupervisor.markStopped(c.id);
            healthMonitor.unregisterContainer(c.id);
            step(`Stopping '${c.id}'`);
            await runContainerCmd([ "stop", c.id ], { stream: onProgress });
        }
        step("✅ stop complete");
    }

    async startService(stackName: string, serviceName: string, onProgress: ProgressSink): Promise<void> {
        const name = `${stackName}-${serviceName}`;
        restartSupervisor.markStarted(name);
        this.stepLogger(onProgress)(`Starting '${name}'`);
        await runContainerCmd([ "start", name ], { stream: onProgress,
            throwOnError: true });
    }

    async stopService(stackName: string, serviceName: string, onProgress: ProgressSink): Promise<void> {
        const name = `${stackName}-${serviceName}`;
        restartSupervisor.markStopped(name);
        healthMonitor.unregisterContainer(name);
        this.stepLogger(onProgress)(`Stopping '${name}'`);
        await runContainerCmd([ "stop", name ], { stream: onProgress,
            throwOnError: true });
    }

    async restartService(stackName: string, serviceName: string, onProgress: ProgressSink): Promise<void> {
        const name = `${stackName}-${serviceName}`;
        const step = this.stepLogger(onProgress);
        restartSupervisor.markStarted(name);
        step(`Restarting '${name}'`);
        await runContainerCmd([ "stop", name ], { stream: onProgress });
        await runContainerCmd([ "start", name ], { stream: onProgress,
            throwOnError: true });
    }

    private stepLogger(onProgress: ProgressSink): (msg: string) => void {
        return (msg: string) => onProgress(`\x1b[36m[boxge]\x1b[0m ${msg}\r\n`);
    }

    private async ensureNetwork(name: string): Promise<void> {
        const nets = await this.listNetworks();
        if (nets.some((n) => n.name === name)) {
            return;
        }
        await runContainerCmd([ "network", "create", name ], { throwOnError: true });
    }

    private async ensureVolume(name: string, stackName: string): Promise<void> {
        const vols = await this.listVolumes();
        if (vols.some((v) => v.name === name)) {
            return;
        }
        await runContainerCmd([ "volume", "create", "--label", `${STACK_LABEL}=${stackName}`, name ], { throwOnError: true });
    }

    private async imageExists(ref: string): Promise<boolean> {
        const { exitCode } = await runContainerCmd([ "image", "inspect", ref ]);
        return exitCode === 0;
    }

    private async runService(stack: ParsedStack, svc: ParsedService, stream: ProgressSink): Promise<void> {

        await this.removeContainerIfExists(containerNameFor(stack, svc.name));
        await runContainerCmd(buildRunArgs(stack, svc), { cwd: stack.dir,
            stream,
            throwOnError: true });
    }

    private async removeContainerIfExists(name: string): Promise<void> {
        const { exitCode } = await runContainerCmd([ "inspect", name ]);
        if (exitCode === 0) {
            await runContainerCmd([ "stop", name ]);
            await runContainerCmd([ "delete", "--force", name ]);
        }
    }

    async listContainers(): Promise<RawContainer[]> {
        return runContainerJson<RawContainer[]>([ "list", "--all" ]);
    }

    async containersForStack(stackName: string): Promise<RawContainer[]> {
        const all = await this.listContainers();
        return all.filter((c) => c.configuration?.labels?.[STACK_LABEL] === stackName);
    }

    async stackStatus(stackName: string): Promise<ServiceStatus[]> {
        const containers = await this.containersForStack(stackName);
        return containers.map((c) => this.toServiceStatus(stackName, c));
    }

    async streamStackLogs(stackName: string, onData: (chunk: string) => void): Promise<{ stop: () => void }> {
        const containers = await this.containersForStack(stackName);
        if (containers.length === 0) {
            onData("[boxge] No containers for this stack yet — deploy it to see live logs.\r\n");
            return { stop: () => {} };
        }

        const children: ChildProcess[] = [];
        for (const c of containers) {
            const service = c.id.startsWith(stackName + "-") ? c.id.slice(stackName.length + 1) : c.id;
            onData(`\r\n\x1b[36m[boxge] streaming logs: ${service} (${c.id})\x1b[0m\r\n`);
            const child = spawnContainer([ "logs", "-f", c.id ], { onData: linePrefixer(service, onData) });
            children.push(child);
        }

        return {
            stop: () => {
                for (const child of children) {
                    try {
                        child.kill();
                    } catch {
                    }
                }
            },
        };
    }

    private toServiceStatus(stackName: string, c: RawContainer): ServiceStatus {
        const service = c.id.startsWith(stackName + "-") ? c.id.slice(stackName.length + 1) : c.id;
        const ipv4 = c.status?.networks?.[0]?.ipv4Address?.split("/")[0];
        return {
            service,
            containerName: c.id,
            state: c.status?.state ?? "unknown",
            health: healthMonitor.getHealth(c.id),
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
        if (containers.length === 0) {
            return [];
        }
        const ids = containers.map((c) => c.id);
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
            cpuUsageUsec: s.cpuUsageUsec,
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
