import fs from "node:fs";
import yaml from "yaml";
import { NETWORK_PREFIX } from "./container-cli";
import { resolveInStack } from "./paths";
import type {
    ParsedEnvFile,
    ParsedNetwork,
    ParsedPort,
    ParsedSecret,
    ParsedService,
    ParsedStack,
    ParsedVolume,
    PullPolicy,
    RestartPolicy,
} from "./types";

export type InterpolationEnv = Record<string, string | undefined>;

type RawMap = Record<string, unknown>;

const SUPPORTED_SERVICE_KEYS = new Set([
    "image", "build", "command", "entrypoint", "environment", "env_file", "ports", "volumes",
    "working_dir", "user", "labels", "cpus", "cpu_count", "mem_limit", "deploy", "restart",
    "cap_add", "cap_drop", "read_only", "tmpfs", "shm_size", "dns", "dns_search", "dns_opt",
    "healthcheck", "depends_on", "networks", "init", "tty", "stdin_open", "platform", "ulimits",
    "expose", "profiles", "extends", "secrets", "pull_policy", "stop_grace_period", "stop_signal",
]);

const EXTENDS_CONCAT_KEYS = new Set([
    "ports", "expose", "volumes", "dns", "dns_search", "dns_opt", "cap_add", "cap_drop", "tmpfs",
    "env_file", "secrets", "configs", "profiles",
]);

const EXTENDS_KEY_VALUE_KEYS = new Set([ "environment", "labels" ]);

const EXTENDS_NOT_INHERITED = new Set([ "depends_on", "volumes_from", "extends" ]);

const PULL_POLICIES: PullPolicy[] = [ "always", "missing", "never", "build" ];

const MAX_EXTENDS_DEPTH = 10;

const RESTART_POLICIES: RestartPolicy[] = [ "no", "always", "on-failure", "unless-stopped" ];

const VARIABLE_PATTERN = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export function interpolate(value: string, env: InterpolationEnv, onMissing: (name: string) => void = () => {}): string {
    return value.replace(VARIABLE_PATTERN, (match, braced: string | undefined, op: string | undefined, arg: string | undefined, bare: string | undefined) => {
        if (match === "$$") {
            return "$";
        }
        const name = (braced ?? bare) as string;
        const current = env[name];
        const isSet = current !== undefined;
        const nonEmpty = isSet && current !== "";
        const fallback = arg ?? "";
        switch (op) {
            case ":-":
                return nonEmpty ? current : fallback;
            case "-":
                return isSet ? current : fallback;
            case ":+":
                return nonEmpty ? fallback : "";
            case "+":
                return isSet ? fallback : "";
            case ":?":
                if (!nonEmpty) {
                    throw new Error(`required variable '${name}' is missing or empty${fallback ? `: ${fallback}` : ""}`);
                }
                return current;
            case "?":
                if (!isSet) {
                    throw new Error(`required variable '${name}' is missing${fallback ? `: ${fallback}` : ""}`);
                }
                return current;
            default:
                if (!isSet) {
                    onMissing(name);
                    return "";
                }
                return current;
        }
    });
}

function interpolateTree(node: unknown, env: InterpolationEnv, onMissing: (name: string) => void): unknown {
    if (typeof node === "string") {
        return interpolate(node, env, onMissing);
    }
    if (Array.isArray(node)) {
        return node.map((item) => interpolateTree(item, env, onMissing));
    }
    if (node && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [ key, value ] of Object.entries(node as Record<string, unknown>)) {
            out[key] = interpolateTree(value, env, onMissing);
        }
        return out;
    }
    return node;
}

export function splitCommand(value: string): string[] {
    const out: string[] = [];
    let current = "";
    let quote: string | null = null;
    let started = false;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else if (ch === "\\" && quote === "\"" && i + 1 < value.length && /["\\$`]/.test(value[i + 1])) {
                current += value[++i];
            } else {
                current += ch;
            }
        } else if (ch === "\"" || ch === "'") {
            quote = ch;
            started = true;
        } else if (ch === "\\" && i + 1 < value.length) {
            current += value[++i];
            started = true;
        } else if (/\s/.test(ch)) {
            if (started || current) {
                out.push(current);
                current = "";
                started = false;
            }
        } else {
            current += ch;
        }
    }
    if (started || current) {
        out.push(current);
    }
    return out;
}

function asStringArray(value: unknown): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.map(String);
    }
    return [ String(value) ];
}

function asCommand(value: unknown): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value.map(String);
    }
    return splitCommand(String(value));
}

function parseKeyValues(value: unknown, env: InterpolationEnv): Record<string, string> | undefined {
    if (!value) {
        return undefined;
    }
    const out: Record<string, string> = {};
    if (Array.isArray(value)) {
        for (const item of value) {
            const str = String(item);
            const eq = str.indexOf("=");
            if (eq !== -1) {
                out[str.slice(0, eq)] = str.slice(eq + 1);
            } else if (env[str] !== undefined) {
                out[str] = env[str] as string;
            }
        }
    } else if (typeof value === "object") {
        for (const [ k, v ] of Object.entries(value as Record<string, unknown>)) {
            if (v === null || v === undefined) {
                if (env[k] !== undefined) {
                    out[k] = env[k] as string;
                }
            } else {
                out[k] = String(v);
            }
        }
    }
    return out;
}

function parseEnvFiles(value: unknown): ParsedEnvFile[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const list = Array.isArray(value) ? value : [ value ];
    const out: ParsedEnvFile[] = [];
    for (const item of list) {
        if (item && typeof item === "object") {
            const entry = item as { path?: unknown; required?: unknown };
            if (entry.path !== undefined && entry.path !== null) {
                out.push({ path: String(entry.path),
                    required: entry.required !== false });
            }
        } else if (item !== undefined && item !== null) {
            out.push({ path: String(item),
                required: true });
        }
    }
    return out;
}

function isPlainObject(value: unknown): value is RawMap {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function keyValueMap(value: unknown): RawMap {
    if (isPlainObject(value)) {
        return { ...value };
    }
    const out: RawMap = {};
    for (const item of Array.isArray(value) ? value : []) {
        const str = String(item);
        const eq = str.indexOf("=");
        if (eq === -1) {
            out[str] = null;
        } else {
            out[str.slice(0, eq)] = str.slice(eq + 1);
        }
    }
    return out;
}

function deepMerge(base: unknown, override: unknown): unknown {
    if (isPlainObject(base) && isPlainObject(override)) {
        const out: RawMap = { ...base };
        for (const [ key, value ] of Object.entries(override)) {
            out[key] = deepMerge(base[key], value);
        }
        return out;
    }
    return override;
}

function mergeService(base: RawMap, override: RawMap): RawMap {
    const out: RawMap = {};
    for (const [ key, value ] of Object.entries(base)) {
        if (!EXTENDS_NOT_INHERITED.has(key)) {
            out[key] = value;
        }
    }
    for (const [ key, value ] of Object.entries(override)) {
        if (key === "extends") {
            continue;
        }
        const inherited = out[key];
        if (EXTENDS_KEY_VALUE_KEYS.has(key) && inherited !== undefined) {
            out[key] = { ...keyValueMap(inherited),
                ...keyValueMap(value) };
        } else if (EXTENDS_CONCAT_KEYS.has(key) && Array.isArray(inherited) && Array.isArray(value)) {
            const seen = new Set<string>();
            out[key] = [ ...inherited, ...value ].filter((item) => {
                const id = JSON.stringify(item);
                if (seen.has(id)) {
                    return false;
                }
                seen.add(id);
                return true;
            });
        } else {
            out[key] = deepMerge(inherited, value);
        }
    }
    return out;
}

interface ExtendsContext {
    dir: string;
    env: InterpolationEnv;
    onMissing: (name: string) => void;
    files: Map<string, RawMap>;
}

function servicesOfFile(file: string, ctx: ExtendsContext): RawMap {
    const cached = ctx.files.get(file);
    if (cached) {
        return cached;
    }
    let doc: unknown;
    try {
        doc = yaml.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
        throw new Error(`could not read '${file}' for extends: ${e instanceof Error ? e.message : String(e)}`);
    }
    const interpolated = interpolateTree(doc, ctx.env, ctx.onMissing);
    const services = isPlainObject(interpolated) && isPlainObject(interpolated.services) ? interpolated.services : {};
    ctx.files.set(file, services);
    return services;
}

function resolveExtends(name: string, services: RawMap, ctx: ExtendsContext, chain: string[] = []): RawMap {
    const raw = (services[name] ?? {}) as RawMap;
    const ext = raw.extends;
    if (ext === undefined || ext === null) {
        return raw;
    }
    const target = isPlainObject(ext) ? ext : { service: ext };
    const baseName = String(target.service ?? "");
    const file = target.file ? resolveInStack(ctx.dir, String(target.file)) : undefined;
    const id = `${file ?? ""}#${baseName}`;
    if (chain.includes(id) || chain.length >= MAX_EXTENDS_DEPTH) {
        throw new Error(`service '${name}': 'extends' forms a loop through '${baseName}'.`);
    }
    const pool = file ? servicesOfFile(file, ctx) : services;
    if (!(baseName in pool)) {
        throw new Error(`service '${name}': extends '${baseName}', which is not defined${file ? ` in ${file}` : ""}.`);
    }
    const base = resolveExtends(baseName, pool, ctx, [ ...chain, id ]);
    return mergeService(base, raw);
}

const PORT_PATTERN = /^\d+(-\d+)?$/;

const DNS_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isDnsLabel(value: string): boolean {
    return DNS_LABEL_PATTERN.test(value);
}

export function normalizeDnsDomain(value: unknown): string {
    const domain = String(value ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (domain === "") {
        return "";
    }
    const labels = domain.split(".");
    if (labels.length < 1 || !labels.every(isDnsLabel)) {
        throw new Error(`'${String(value)}' is not a valid DNS domain.`);
    }
    return domain;
}

function bracketIp(ip: string): string {
    return ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
}

export function parsePort(spec: unknown): { port?: ParsedPort; defaulted?: boolean } {
    let hostIp: string | undefined;
    let hostPort: string | undefined;
    let containerPort: string;
    let proto = "tcp";

    if (spec && typeof spec === "object") {
        const o = spec as Record<string, unknown>;
        if (o.target === undefined) {
            return {};
        }
        containerPort = String(o.target);
        hostPort = o.published !== undefined && o.published !== null && o.published !== "" ? String(o.published) : undefined;
        hostIp = o.host_ip ? bracketIp(String(o.host_ip)) : undefined;
        proto = o.protocol ? String(o.protocol).toLowerCase() : "tcp";
    } else {
        let rest = String(spec).trim();
        const slash = rest.lastIndexOf("/");
        if (slash !== -1) {
            proto = rest.slice(slash + 1).toLowerCase();
            rest = rest.slice(0, slash);
        }
        if (rest.startsWith("[")) {
            const close = rest.indexOf("]");
            if (close === -1) {
                return {};
            }
            hostIp = rest.slice(0, close + 1);
            rest = rest.slice(close + 1).replace(/^:/, "");
        }
        const segments = rest.split(":");
        if (segments.length === 3 && !hostIp) {
            hostIp = segments.shift();
        }
        if (segments.length < 1 || segments.length > 2) {
            return {};
        }
        containerPort = segments[segments.length - 1];
        hostPort = segments.length === 2 && segments[0] !== "" ? segments[0] : undefined;
    }

    if (!PORT_PATTERN.test(containerPort) || (hostPort !== undefined && !PORT_PATTERN.test(hostPort))) {
        return {};
    }
    if (proto !== "tcp" && proto !== "udp") {
        return {};
    }
    return {
        port: { hostIp: hostIp || undefined,
            hostPort: hostPort ?? containerPort,
            containerPort,
            proto },
        defaulted: hostPort === undefined,
    };
}

function isBindSource(source: string): boolean {
    return source.startsWith("/") || source.startsWith(".") || source.startsWith("~");
}

export function parseVolume(spec: unknown): { volume?: ParsedVolume; tmpfs?: string } {
    if (spec && typeof spec === "object") {
        const o = spec as Record<string, unknown>;
        const target = o.target !== undefined ? String(o.target) : undefined;
        if (!target) {
            return {};
        }
        const type = String(o.type ?? "volume");
        if (type === "tmpfs") {
            return { tmpfs: target };
        }
        if (o.source === undefined || o.source === null || o.source === "") {
            return { volume: { type: "anonymous",
                target } };
        }
        const source = String(o.source);
        return { volume: { type: type === "bind" || isBindSource(source) ? "bind" : "named",
            source,
            target,
            readonly: o.read_only === true } };
    }

    const parts = String(spec).split(":");
    if (parts.length === 1) {
        return { volume: { type: "anonymous",
            target: parts[0] } };
    }
    const [ source, target, mode ] = parts;
    const readonly = (mode ?? "").split(",").includes("ro");
    return { volume: { type: isBindSource(source) ? "bind" : "named",
        source,
        target,
        readonly } };
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
        return Object.entries(value as Record<string, { condition?: string } | null>).map(([ service, cfg ]) => ({
            service,
            condition: cfg?.condition,
        }));
    }
    return undefined;
}

function parseRestart(name: string, value: unknown, warnings: string[]): { policy?: RestartPolicy; maxRetries?: number } {
    if (value === undefined || value === null || value === false) {
        return {};
    }
    const [ rawPolicy, rawRetries ] = String(value).split(":");
    const policy = RESTART_POLICIES.find((p) => p === rawPolicy);
    if (!policy) {
        warnings.push(`service '${name}': restart policy '${String(value)}' is not recognised and will be ignored.`);
        return {};
    }
    const retries = rawRetries !== undefined ? Number(rawRetries) : undefined;
    if (policy === "on-failure") {
        warnings.push(`service '${name}': the runtime does not report exit codes, so 'on-failure' restarts the service after any exit.`);
    }
    return { policy,
        maxRetries: retries !== undefined && Number.isInteger(retries) && retries > 0 ? retries : undefined };
}

function parseUlimits(value: unknown): string[] | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const out: string[] = [];
    for (const [ type, limit ] of Object.entries(value as Record<string, unknown>)) {
        if (limit && typeof limit === "object") {
            const { soft, hard } = limit as { soft?: unknown; hard?: unknown };
            if (soft !== undefined) {
                out.push(`${type}=${String(soft)}${hard !== undefined ? `:${String(hard)}` : ""}`);
            }
        } else if (limit !== undefined && limit !== null) {
            out.push(`${type}=${String(limit)}`);
        }
    }
    return out;
}

function parsePullPolicy(name: string, value: unknown, warnings: string[]): PullPolicy | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const policy = String(value) === "if_not_present" ? "missing" : String(value);
    if (!PULL_POLICIES.includes(policy as PullPolicy)) {
        warnings.push(`service '${name}': pull_policy '${String(value)}' is not recognised and will be ignored.`);
        return undefined;
    }
    return policy as PullPolicy;
}

interface StackContext {
    stackName: string;
    dir: string;
    env: InterpolationEnv;
    warnings: string[];
    networks: Map<string, ParsedNetwork>;
    volumes: RawMap;
    secrets: RawMap;
}

function networkFor(key: string, ctx: StackContext, declared: RawMap, service: string): ParsedNetwork {
    const existing = ctx.networks.get(key);
    if (existing) {
        return existing;
    }
    if (key !== "default" && !(key in declared)) {
        ctx.warnings.push(`service '${service}': network '${key}' is not declared under top-level 'networks'; creating it for this stack.`);
    }
    const cfg = isPlainObject(declared[key]) ? declared[key] as RawMap : {};
    const external = cfg.external === true || isPlainObject(cfg.external);
    const defaultName = key === "default" ? NETWORK_PREFIX + ctx.stackName : `${NETWORK_PREFIX}${ctx.stackName}.${key}`;
    const network: ParsedNetwork = {
        key,
        name: cfg.name ? String(cfg.name) : (external ? key : defaultName),
        external,
        internal: cfg.internal === true,
    };
    ctx.networks.set(key, network);
    return network;
}

function parseServiceNetworks(name: string, value: unknown, ctx: StackContext, declared: RawMap): string[] {
    let keys: string[] = [];
    if (Array.isArray(value)) {
        keys = value.map(String);
    } else if (isPlainObject(value)) {
        keys = Object.keys(value);
        if (Object.values(value).some((cfg) => isPlainObject(cfg) && (cfg.aliases || cfg.ipv4_address || cfg.ipv6_address))) {
            ctx.warnings.push(`service '${name}': per-network aliases and fixed addresses are not supported and will be ignored.`);
        }
    }
    if (keys.length === 0) {
        keys = [ "default" ];
    }
    return [ ...new Set(keys) ].map((key) => networkFor(key, ctx, declared, name).name);
}

function parseSecrets(name: string, value: unknown, ctx: StackContext): ParsedSecret[] | undefined {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }
    const out: ParsedSecret[] = [];
    for (const item of value) {
        const entry: RawMap = isPlainObject(item) ? item : { source: item };
        const source = String(entry.source ?? "");
        const target = entry.target !== undefined ? String(entry.target) : source;
        const cfg = ctx.secrets[source];
        if (!isPlainObject(cfg)) {
            ctx.warnings.push(`service '${name}': secret '${source}' is not declared under top-level 'secrets' and was skipped.`);
            continue;
        }
        if (target.includes("/")) {
            ctx.warnings.push(`service '${name}': secret '${source}' can only be placed in /run/secrets, so target '${target}' was skipped.`);
            continue;
        }
        if (cfg.file) {
            out.push({ name: target,
                file: resolveInStack(ctx.dir, String(cfg.file)) });
        } else if (cfg.environment) {
            const variable = String(cfg.environment);
            if (ctx.env[variable] === undefined) {
                ctx.warnings.push(`service '${name}': secret '${source}' reads variable '${variable}', which is not set.`);
            }
            out.push({ name: target,
                value: ctx.env[variable] ?? "" });
        } else {
            ctx.warnings.push(`service '${name}': secret '${source}' needs 'file' or 'environment'; other sources are not supported.`);
        }
    }
    return out.length > 0 ? out : undefined;
}

function parseService(name: string, raw: RawMap, ctx: StackContext, declaredNetworks: RawMap): ParsedService {
    const warnings = ctx.warnings;
    const env = ctx.env;

    for (const key of Object.keys(raw)) {
        if (key === "configs") {
            warnings.push(`service '${name}': 'configs' is not supported because the runtime can only mount folders, not single files. Mount a folder with 'volumes' instead.`);
        } else if (!SUPPORTED_SERVICE_KEYS.has(key) && !key.startsWith("x-")) {
            warnings.push(`service '${name}': '${key}' is not supported and will be ignored.`);
        }
    }

    const build = raw.build;
    let parsedBuild: ParsedService["build"];
    if (typeof build === "string") {
        parsedBuild = { context: build };
    } else if (build && typeof build === "object") {
        const b = build as RawMap;
        parsedBuild = { context: String(b.context ?? "."),
            dockerfile: b.dockerfile ? String(b.dockerfile) : undefined,
            args: parseKeyValues(b.args, env),
            target: b.target ? String(b.target) : undefined };
    }

    const limits = (raw.deploy as { resources?: { limits?: { memory?: unknown; cpus?: unknown } } } | undefined)
        ?.resources?.limits;

    const ports: ParsedPort[] = [];
    for (const spec of Array.isArray(raw.ports) ? raw.ports : []) {
        const { port, defaulted } = parsePort(spec);
        const shown = typeof spec === "object" ? JSON.stringify(spec) : String(spec);
        if (!port) {
            warnings.push(`service '${name}': port '${shown}' could not be parsed and was skipped.`);
            continue;
        }
        if (defaulted) {
            warnings.push(`service '${name}': port '${shown}' has no host port; publishing it on host port ${port.hostPort}.`);
        }
        ports.push(port);
    }

    const volumes: ParsedVolume[] = [];
    const tmpfs: string[] = asStringArray(raw.tmpfs) ?? [];
    for (const spec of Array.isArray(raw.volumes) ? raw.volumes : []) {
        const parsed = parseVolume(spec);
        if (parsed.volume) {
            const volume = parsed.volume;
            if (volume.type === "named" && volume.source) {
                const cfg = isPlainObject(ctx.volumes[volume.source]) ? ctx.volumes[volume.source] as RawMap : {};
                volume.external = cfg.external === true || isPlainObject(cfg.external);
                volume.source = cfg.name ? String(cfg.name) : volume.source;
            }
            if (volume.type === "bind" && volume.source) {
                const source = resolveInStack(ctx.dir, volume.source);
                try {
                    if (fs.statSync(source).isFile()) {
                        warnings.push(`service '${name}': '${volume.source}' is a file. The runtime can only mount folders, so deploying will fail; mount the folder that holds it instead.`);
                    }
                } catch {
                }
            }
            volumes.push(volume);
        } else if (parsed.tmpfs) {
            tmpfs.push(parsed.tmpfs);
        } else {
            warnings.push(`service '${name}': volume '${JSON.stringify(spec)}' could not be parsed and was skipped.`);
        }
    }

    const restart = parseRestart(name, raw.restart, warnings);
    const cpus = raw.cpus ?? raw.cpu_count ?? limits?.cpus;
    const memory = raw.mem_limit ?? limits?.memory;
    const grace = parseDuration(raw.stop_grace_period);

    return {
        name,
        image: raw.image ? String(raw.image) : undefined,
        build: parsedBuild,
        command: asCommand(raw.command),
        entrypoint: asCommand(raw.entrypoint),
        environment: parseKeyValues(raw.environment, env),
        envFiles: parseEnvFiles(raw.env_file),
        networks: parseServiceNetworks(name, raw.networks, ctx, declaredNetworks),
        secrets: parseSecrets(name, raw.secrets, ctx),
        pullPolicy: parsePullPolicy(name, raw.pull_policy, warnings),
        stopGracePeriod: grace !== undefined ? Math.max(1, Math.round(grace / 1000)) : undefined,
        stopSignal: raw.stop_signal ? String(raw.stop_signal) : undefined,
        ports: ports.length > 0 ? ports : undefined,
        volumes: volumes.length > 0 ? volumes : undefined,
        workingDir: raw.working_dir ? String(raw.working_dir) : undefined,
        user: raw.user !== undefined && raw.user !== null && raw.user !== "" ? String(raw.user) : undefined,
        labels: parseKeyValues(raw.labels, env),
        cpus: cpus !== undefined && cpus !== null ? Number(cpus) : undefined,
        memLimit: memory !== undefined && memory !== null && memory !== "" ? String(memory) : undefined,
        restart: restart.policy,
        restartMaxRetries: restart.maxRetries,
        capAdd: asStringArray(raw.cap_add),
        capDrop: asStringArray(raw.cap_drop),
        readOnly: raw.read_only === true,
        tmpfs: tmpfs.length > 0 ? tmpfs : undefined,
        shmSize: raw.shm_size ? String(raw.shm_size) : undefined,
        dns: asStringArray(raw.dns),
        dnsSearch: asStringArray(raw.dns_search),
        dnsOptions: asStringArray(raw.dns_opt),
        init: raw.init === true,
        tty: raw.tty === true,
        stdinOpen: raw.stdin_open === true,
        platform: raw.platform ? String(raw.platform) : undefined,
        ulimits: parseUlimits(raw.ulimits),
        healthcheck: parseHealthcheck(raw.healthcheck),
        dependsOn: parseDependsOn(raw.depends_on),
    };
}

export function parseComposeStack(stackName: string, dir: string, composeYAML: string, env: InterpolationEnv = {}, opts: { dnsDomain?: string } = {}): ParsedStack {
    const rawDoc = yaml.parse(composeYAML) as RawMap | null;
    const warnings: string[] = [];

    if (!rawDoc || typeof rawDoc !== "object" || !rawDoc.services || typeof rawDoc.services !== "object") {
        throw new Error("compose file has no 'services' section");
    }

    const missing = new Set<string>();
    const onMissing = (name: string) => missing.add(name);
    const doc = interpolateTree(rawDoc, env, onMissing) as RawMap;

    if ("configs" in doc) {
        warnings.push("top-level 'configs' is not supported and will be ignored.");
    }

    const rawServices = doc.services as RawMap;
    const declaredNetworks = isPlainObject(doc.networks) ? doc.networks : {};
    const ctx: StackContext = {
        stackName,
        dir,
        env,
        warnings,
        networks: new Map(),
        volumes: isPlainObject(doc.volumes) ? doc.volumes : {},
        secrets: isPlainObject(doc.secrets) ? doc.secrets : {},
    };
    const extendsCtx: ExtendsContext = { dir,
        env,
        onMissing,
        files: new Map() };
    const activeProfiles = new Set((env.COMPOSE_PROFILES ?? "").split(",").map((p) => p.trim()).filter((p) => p !== ""));

    const services: ParsedService[] = [];
    for (const name of Object.keys(rawServices)) {
        const raw = resolveExtends(name, rawServices, extendsCtx);
        const profiles = asStringArray(raw.profiles) ?? [];
        if (profiles.length > 0 && !profiles.some((p) => activeProfiles.has(p))) {
            warnings.push(`service '${name}': skipped because none of its profiles (${profiles.join(", ")}) is active. Set COMPOSE_PROFILES in .env to include it.`);
            continue;
        }
        const svc = parseService(name, raw, ctx, declaredNetworks);
        services.push(svc);
        if (!svc.image && !svc.build) {
            warnings.push(`service '${name}': has neither 'image' nor 'build'.`);
        }
        if (opts.dnsDomain && !(isDnsLabel(name) && isDnsLabel(stackName))) {
            warnings.push(`service '${name}': '${name}.${stackName}' is not a valid DNS name, so this service gets no DNS name.`);
        }
    }

    for (const name of missing) {
        warnings.push(`variable '${name}' is not set; using an empty string.`);
    }

    const active = new Set(services.map((s) => s.name));
    const dependsOn: Record<string, string[]> = {};
    for (const svc of services) {
        const kept = (svc.dependsOn ?? []).filter((d) => {
            if (active.has(d.service)) {
                return true;
            }
            warnings.push(`service '${svc.name}': depends on '${d.service}', which is not part of this deployment.`);
            return false;
        });
        svc.dependsOn = kept.length > 0 ? kept : undefined;
        dependsOn[svc.name] = kept.map((d) => d.service);
    }

    return {
        name: stackName,
        dir,
        networkName: ctx.networks.get("default")?.name ?? NETWORK_PREFIX + stackName,
        networks: [ ...ctx.networks.values() ],
        dnsDomain: opts.dnsDomain || undefined,
        services,
        dependsOn,
        warnings,
    };
}
