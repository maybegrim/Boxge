import path from "node:path";
import { STACK_LABEL } from "./container-cli";
import type { ParsedService, ParsedStack } from "./types";

export const SERVICE_LABEL = "boxge.service";

export const VOLUME_STACK_LABEL = "boxge.stack";

export function containerNameFor(stack: ParsedStack, serviceName: string): string {
    return `${stack.name}-${serviceName}`;
}

export function builtImageTag(stack: ParsedStack, service: ParsedService): string {
    return `${stack.name}-${service.name}:local`;
}

function resolveInStack(stackDir: string, p: string): string {
    if (path.isAbsolute(p)) {
        return p;
    }
    return path.resolve(stackDir, p);
}

export function normalizeMemory(mem: string): string {
    const match = String(mem).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgtp])?b?$/i);
    if (!match) {
        return String(mem);
    }
    const value = match[1];
    const suffix = match[2] ? match[2].toUpperCase() : "";
    return `${value}${suffix}`;
}

export function buildRunArgs(stack: ParsedStack, service: ParsedService): string[] {
    const args: string[] = [ "run", "-d", "--name", containerNameFor(stack, service.name) ];

    args.push("--network", stack.networkName);

    args.push("-l", `${STACK_LABEL}=${stack.name}`);
    args.push("-l", `${SERVICE_LABEL}=${service.name}`);
    for (const [ k, v ] of Object.entries(service.labels ?? {})) {
        args.push("-l", `${k}=${v}`);
    }

    for (const [ k, v ] of Object.entries(service.environment ?? {})) {
        args.push("-e", `${k}=${v}`);
    }
    for (const f of service.envFiles ?? []) {
        args.push("--env-file", resolveInStack(stack.dir, f));
    }

    for (const p of service.ports ?? []) {
        const proto = p.proto && p.proto !== "tcp" ? `/${p.proto}` : "";
        const spec = (p.hostPort !== undefined ? `${p.hostPort}:` : "") + `${p.containerPort}` + proto;
        args.push("-p", spec);
    }

    for (const v of service.volumes ?? []) {
        if (v.type === "anonymous") {
            args.push("-v", v.target);
            continue;
        }
        const source = v.type === "bind" ? resolveInStack(stack.dir, v.source as string) : (v.source as string);
        if (v.readonly) {
            const mountType = v.type === "bind" ? "bind" : "volume";
            args.push("--mount", `type=${mountType},source=${source},target=${v.target},readonly`);
        } else {
            args.push("-v", `${source}:${v.target}`);
        }
    }

    if (service.workingDir) {
        args.push("-w", service.workingDir);
    }
    if (service.user) {
        args.push("-u", service.user);
    }

    if (service.cpus !== undefined && !Number.isNaN(service.cpus)) {
        args.push("-c", String(service.cpus));
    }
    if (service.memLimit) {
        args.push("-m", normalizeMemory(service.memLimit));
    }

    for (const c of service.capAdd ?? []) {
        args.push("--cap-add", c);
    }
    for (const c of service.capDrop ?? []) {
        args.push("--cap-drop", c);
    }
    if (service.readOnly) {
        args.push("--read-only");
    }
    for (const t of service.tmpfs ?? []) {
        args.push("--tmpfs", t);
    }
    if (service.shmSize) {
        args.push("--shm-size", service.shmSize);
    }

    for (const d of service.dns ?? []) {
        args.push("--dns", d);
    }
    for (const d of service.dnsSearch ?? []) {
        args.push("--dns-search", d);
    }

    let leadingArgs: string[] = [];
    if (service.entrypoint && service.entrypoint.length > 0) {
        args.push("--entrypoint", service.entrypoint[0]);
        leadingArgs = service.entrypoint.slice(1);
    }

    const image = service.image ?? builtImageTag(stack, service);
    args.push(image);

    const command = [ ...leadingArgs, ...(service.command ?? []) ];
    args.push(...command);

    return args;
}

export function buildBuildArgs(stack: ParsedStack, service: ParsedService): string[] {
    if (!service.build) {
        throw new Error(`service '${service.name}' has no build config`);
    }
    const args: string[] = [ "build", "-t", builtImageTag(stack, service) ];
    if (service.build.dockerfile) {
        args.push("-f", resolveInStack(stack.dir, service.build.dockerfile));
    }
    args.push("-l", `${STACK_LABEL}=${stack.name}`);

    args.push(resolveInStack(stack.dir, service.build.context || "."));
    return args;
}

export function collectNamedVolumes(stack: ParsedStack): string[] {
    const names = new Set<string>();
    for (const svc of stack.services) {
        for (const v of svc.volumes ?? []) {
            if (v.type === "named" && v.source) {
                names.add(v.source);
            }
        }
    }
    return [ ...names ];
}

export function topoSortServices(stack: ParsedStack): { order: string[]; cycle: string[] } {
    const names = stack.services.map((s) => s.name);
    const nameSet = new Set(names);
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const name of names) {
        indegree.set(name, 0);
    }
    for (const name of names) {

        const deps = (stack.dependsOn[name] ?? []).filter((d) => nameSet.has(d));
        indegree.set(name, deps.length);
        for (const dep of deps) {
            const list = dependents.get(dep) ?? [];
            list.push(name);
            dependents.set(dep, list);
        }
    }

    const queue = names.filter((n) => (indegree.get(n) ?? 0) === 0);
    const order: string[] = [];

    while (queue.length > 0) {
        const n = queue.shift() as string;
        order.push(n);
        for (const m of dependents.get(n) ?? []) {
            const d = (indegree.get(m) ?? 0) - 1;
            indegree.set(m, d);
            if (d === 0) {
                queue.push(m);
            }
        }
    }

    if (order.length !== names.length) {
        const cycle = names.filter((n) => !order.includes(n));
        return { order: names,
            cycle };
    }
    return { order,
        cycle: [] };
}
