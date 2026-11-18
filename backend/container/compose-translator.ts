import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STACK_LABEL } from "./container-cli";
import { isDnsLabel } from "./compose-parser";
import { resolveInStack, secretsDirFor } from "./paths";
import type { ParsedService, ParsedStack } from "./types";

export const SERVICE_LABEL = "boxge.service";

export const CONFIG_HASH_LABEL = "boxge.config-hash";

export const STOP_TIMEOUT_LABEL = "boxge.stop-timeout";

export const STOP_SIGNAL_LABEL = "boxge.stop-signal";

export const SECRETS_TARGET = "/run/secrets";

export const VOLUME_STACK_LABEL = "boxge.stack";

export function containerNameFor(stack: ParsedStack, serviceName: string): string {
    return `${stack.name}-${serviceName}`;
}

export function serviceDnsName(stack: ParsedStack, serviceName: string): string | undefined {
    if (!stack.dnsDomain || !isDnsLabel(serviceName) || !isDnsLabel(stack.name)) {
        return undefined;
    }
    return `${serviceName}.${stack.name}.${stack.dnsDomain}`;
}

export function builtImageTag(stack: ParsedStack, service: ParsedService): string {
    return `${stack.name}-${service.name}:local`;
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

export function buildRunArgs(stack: ParsedStack, service: ParsedService, extraLabels: Record<string, string> = {}): string[] {
    const args: string[] = [ "run", "-d", "--name", containerNameFor(stack, service.name) ];

    const dnsName = serviceDnsName(stack, service.name);
    service.networks.forEach((network, index) => {
        args.push("--network", dnsName && index === 0 ? `${network},alias=${dnsName}` : network);
    });
    if (stack.dnsDomain && isDnsLabel(stack.name)) {
        args.push("--dns-search", `${stack.name}.${stack.dnsDomain}`);
    }

    args.push("-l", `${STACK_LABEL}=${stack.name}`);
    args.push("-l", `${SERVICE_LABEL}=${service.name}`);
    const stopLabels: Record<string, string> = {};
    if (service.stopGracePeriod !== undefined) {
        stopLabels[STOP_TIMEOUT_LABEL] = String(service.stopGracePeriod);
    }
    if (service.stopSignal) {
        stopLabels[STOP_SIGNAL_LABEL] = service.stopSignal;
    }
    for (const [ k, v ] of Object.entries({ ...service.labels,
        ...stopLabels,
        ...extraLabels })) {
        args.push("-l", `${k}=${v}`);
    }

    for (const [ k, v ] of Object.entries(service.environment ?? {})) {
        args.push("-e", `${k}=${v}`);
    }
    for (const f of service.envFiles ?? []) {
        const file = resolveInStack(stack.dir, f.path);
        if (f.required || fs.existsSync(file)) {
            args.push("--env-file", file);
        }
    }

    for (const p of service.ports ?? []) {
        const proto = p.proto && p.proto !== "tcp" ? `/${p.proto}` : "";
        const hostIp = p.hostIp ? `${p.hostIp}:` : "";
        args.push("-p", `${hostIp}${p.hostPort}:${p.containerPort}${proto}`);
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

    if (service.secrets && service.secrets.length > 0) {
        args.push("--mount", `type=bind,source=${secretsDirFor(stack.dir, service.name)},target=${SECRETS_TARGET},readonly`);
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
    for (const d of service.dnsOptions ?? []) {
        args.push("--dns-option", d);
    }

    if (service.init) {
        args.push("--init");
    }
    if (service.tty) {
        args.push("-t");
    }
    if (service.stdinOpen) {
        args.push("-i");
    }
    if (service.platform) {
        args.push("--platform", service.platform);
    }
    for (const u of service.ulimits ?? []) {
        args.push("--ulimit", u);
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
    const context = resolveInStack(stack.dir, service.build.context || ".");
    if (service.build.dockerfile) {
        args.push("-f", path.resolve(context, service.build.dockerfile));
    }
    for (const [ k, v ] of Object.entries(service.build.args ?? {})) {
        args.push("--build-arg", `${k}=${v}`);
    }
    if (service.build.target) {
        args.push("--target", service.build.target);
    }
    args.push("-l", `${STACK_LABEL}=${stack.name}`);

    args.push(context);
    return args;
}

export function serviceConfigHash(stack: ParsedStack, service: ParsedService): string {
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify(buildRunArgs(stack, service)));
    for (const f of service.envFiles ?? []) {
        try {
            hash.update(fs.readFileSync(resolveInStack(stack.dir, f.path)));
        } catch {
            hash.update("missing:" + f.path);
        }
    }
    for (const secret of service.secrets ?? []) {
        hash.update(secret.name);
        try {
            hash.update(secret.file ? fs.readFileSync(secret.file) : (secret.value ?? ""));
        } catch {
            hash.update("missing:" + secret.name);
        }
    }
    return hash.digest("hex").slice(0, 32);
}

export function collectNamedVolumes(stack: ParsedStack): string[] {
    const names = new Set<string>();
    for (const svc of stack.services) {
        for (const v of svc.volumes ?? []) {
            if (v.type === "named" && v.source && !v.external) {
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

export function prepareSecrets(stack: ParsedStack, service: ParsedService): void {
    const dir = secretsDirFor(stack.dir, service.name);
    fs.rmSync(dir, { recursive: true,
        force: true });
    if (!service.secrets || service.secrets.length === 0) {
        return;
    }
    fs.mkdirSync(dir, { recursive: true,
        mode: 0o755 });
    for (const secret of service.secrets) {
        const target = path.join(dir, secret.name);
        if (secret.file) {
            if (!fs.existsSync(secret.file) || !fs.statSync(secret.file).isFile()) {
                throw new Error(`service '${service.name}': secret file '${secret.file}' does not exist.`);
            }
            fs.copyFileSync(secret.file, target);
        } else {
            fs.writeFileSync(target, secret.value ?? "");
        }
        fs.chmodSync(target, 0o444);
    }
}

export function fileMounts(stack: ParsedStack, service: ParsedService): string[] {
    const files: string[] = [];
    for (const v of service.volumes ?? []) {
        if (v.type !== "bind" || !v.source) {
            continue;
        }
        const source = resolveInStack(stack.dir, v.source);
        try {
            if (fs.statSync(source).isFile()) {
                files.push(source);
            }
        } catch {
        }
    }
    return files;
}
