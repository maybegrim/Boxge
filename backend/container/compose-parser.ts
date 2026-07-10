import yaml from "yaml";
import { ContainerStackEngine } from "./container-stack-engine";
import type { ParsedService, ParsedStack } from "./types";

const UNSUPPORTED_TOP_LEVEL = [ "configs", "secrets", "profiles" ];

const UNSUPPORTED_SERVICE_KEYS = [ "extends", "configs", "secrets", "profiles", "links", "network_mode" ];

function asStringArray(value: unknown): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.map(String);
    }
    return [ String(value) ];
}

function parseEnvironment(value: unknown): Record<string, string> | undefined {
    if (!value) {
        return undefined;
    }
    const out: Record<string, string> = {};
    if (Array.isArray(value)) {
        for (const item of value) {
            const str = String(item);
            const eq = str.indexOf("=");
            if (eq === -1) {
                out[str] = "";
            } else {
                out[str.slice(0, eq)] = str.slice(eq + 1);
            }
        }
    } else if (typeof value === "object") {
        for (const [ k, v ] of Object.entries(value as Record<string, unknown>)) {
            out[k] = v === null || v === undefined ? "" : String(v);
        }
    }
    return out;
}

function parsePort(spec: string): { hostPort?: number; containerPort: number; proto: string } | null {
    const [ portPart, proto = "tcp" ] = spec.split("/");
    const segments = portPart.split(":");
    const containerStr = segments[segments.length - 1];
    const hostStr = segments.length >= 2 ? segments[segments.length - 2] : undefined;
    const containerPort = Number(containerStr);
    if (Number.isNaN(containerPort)) {
        return null;
    }
    const hostPort = hostStr !== undefined && hostStr !== "" ? Number(hostStr) : undefined;
    return { hostPort,
        containerPort,
        proto };
}

function parseVolume(spec: string): NonNullable<ParsedService["volumes"]>[number] {
    const parts = spec.split(":");
    if (parts.length === 1) {
        return { type: "anonymous",
            target: parts[0] };
    }
    const [ source, target, mode ] = parts;
    const readonly = mode === "ro";

    const isBind = source.startsWith("/") || source.startsWith(".") || source.startsWith("~");
    return { type: isBind ? "bind" : "named",
        source,
        target,
        readonly };
}

export function parseDuration(value: unknown): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === "number") {
        return value * 1000;
    }
    const str = String(value).trim();
    if (/^\d+$/.test(str)) {
        return Number(str) * 1000;
    }
    const re = /(\d+(?:\.\d+)?)(us|ms|s|m|h)/g;
    let total = 0;
    let matched = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(str)) !== null) {
        matched = true;
        const n = Number(m[1]);
        const unitMs: Record<string, number> = {
            us: 1 / 1000,
            ms: 1,
            s: 1000,
            m: 60 * 1000,
            h: 60 * 60 * 1000,
        };
        total += n * (unitMs[m[2]] ?? 0);
    }
    return matched ? Math.round(total) : undefined;
}

function parseHealthcheck(value: unknown): ParsedService["healthcheck"] | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const hc = value as Record<string, unknown>;
    if (hc.disable === true) {
        return { test: [],
            disabled: true };
    }

    let test: string[] = [];
    let disabled = false;
    if (typeof hc.test === "string") {
        test = [ "sh", "-c", hc.test ];
    } else if (Array.isArray(hc.test)) {
        const arr = hc.test.map(String);
        if (arr[0] === "NONE") {
            disabled = true;
        } else if (arr[0] === "CMD-SHELL") {
            test = [ "sh", "-c", arr.slice(1).join(" ") ];
        } else if (arr[0] === "CMD") {
            test = arr.slice(1);
        } else {
            test = arr;
        }
    }

    return {
        test,
        disabled: disabled || undefined,
        interval: parseDuration(hc.interval),
        timeout: parseDuration(hc.timeout),
        retries: hc.retries !== undefined ? Number(hc.retries) : undefined,
        startPeriod: parseDuration(hc.start_period),
    };
}

function parseDependsOn(value: unknown): { service: string; condition?: string }[] | undefined {
    if (!value) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.map((s) => ({ service: String(s) }));
    }
    if (typeof value === "object") {
        return Object.entries(value as Record<string, { condition?: string }>).map(([ service, cfg ]) => ({
            service,
            condition: cfg?.condition,
        }));
    }
    return undefined;
}

function parseService(name: string, raw: Record<string, unknown>, warnings: string[]): ParsedService {
    for (const key of UNSUPPORTED_SERVICE_KEYS) {
        if (key in raw) {
            warnings.push(`service '${name}': '${key}' is not supported in v1 and will be ignored.`);
        }
    }

    const networks = raw.networks;
    if (networks && (Array.isArray(networks) ? networks.length > 1 : Object.keys(networks).length > 1)) {
        warnings.push(`service '${name}': multiple/custom networks are not supported in v1 — using the single per-stack network.`);
    }

    const build = raw.build;
    let parsedBuild: ParsedService["build"];
    if (typeof build === "string") {
        parsedBuild = { context: build };
    } else if (build && typeof build === "object") {
        const b = build as Record<string, unknown>;
        parsedBuild = { context: String(b.context ?? "."),
            dockerfile: b.dockerfile ? String(b.dockerfile) : undefined };
    }

    const deployMem = (raw.deploy as { resources?: { limits?: { memory?: unknown } } } | undefined)
        ?.resources?.limits?.memory;

    return {
        name,
        image: raw.image ? String(raw.image) : undefined,
        build: parsedBuild,
        command: asStringArray(raw.command),
        entrypoint: asStringArray(raw.entrypoint),
        environment: parseEnvironment(raw.environment),
        envFiles: asStringArray(raw.env_file),
        ports: asStringArray(raw.ports)?.map(parsePort).filter((p): p is NonNullable<typeof p> => p !== null),
        volumes: asStringArray(raw.volumes)?.map(parseVolume),
        workingDir: raw.working_dir ? String(raw.working_dir) : undefined,
        user: raw.user ? String(raw.user) : undefined,
        labels: parseEnvironment(raw.labels),
        cpus: raw.cpus !== undefined ? Number(raw.cpus) : (raw.cpu_count !== undefined ? Number(raw.cpu_count) : undefined),
        memLimit: raw.mem_limit ? String(raw.mem_limit) : (deployMem !== undefined ? String(deployMem) : undefined),
        restart: raw.restart as ParsedService["restart"],
        capAdd: asStringArray(raw.cap_add),
        capDrop: asStringArray(raw.cap_drop),
        readOnly: raw.read_only === true,
        tmpfs: asStringArray(raw.tmpfs),
        shmSize: raw.shm_size ? String(raw.shm_size) : undefined,
        dns: asStringArray(raw.dns),
        dnsSearch: asStringArray(raw.dns_search),
        healthcheck: parseHealthcheck(raw.healthcheck),
        dependsOn: parseDependsOn(raw.depends_on),
    };
}

export function parseComposeStack(stackName: string, dir: string, composeYAML: string): ParsedStack {
    const doc = yaml.parse(composeYAML) as Record<string, unknown> | null;
    const warnings: string[] = [];

    if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") {
        throw new Error("compose file has no 'services' section");
    }

    for (const key of Object.keys(doc)) {
        if (UNSUPPORTED_TOP_LEVEL.includes(key)) {
            warnings.push(`top-level '${key}' is not supported in v1 and will be ignored.`);
        }
        if (key.startsWith("x-")) {

            continue;
        }
    }

    const services: ParsedService[] = [];
    const dependsOn: Record<string, string[]> = {};

    for (const [ name, rawService ] of Object.entries(doc.services as Record<string, unknown>)) {
        const svc = parseService(name, (rawService ?? {}) as Record<string, unknown>, warnings);
        services.push(svc);
        dependsOn[name] = (svc.dependsOn ?? []).map((d) => d.service);
        if (!svc.image && !svc.build) {
            warnings.push(`service '${name}': has neither 'image' nor 'build'.`);
        }
    }

    return {
        name: stackName,
        dir,
        networkName: ContainerStackEngine.networkNameForStack(stackName),
        services,
        dependsOn,
        warnings,
    };
}
