import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INFO_PATH = process.env.BOXGE_LOCAL_API_FILE || path.join(os.homedir(), ".boxge", "local-api.json");

const DEFAULT_TIMEOUT_MS = 60_000;
const OPERATION_TIMEOUT_MS = 30 * 60_000;

export type StackAction = "start" | "deploy" | "stop" | "restart" | "update" | "down" | "clean";
export type ServiceAction = "start" | "stop" | "restart";
export type ResourceKind = "images" | "volumes" | "networks";

export interface EnvChange {
    set? : Record<string, string>;
    unset? : string[];
}

export class BoxgeError extends Error {
    constructor(message : string, public status? : number, public body? : Record<string, unknown>) {
        super(message);
    }
}

interface ServerInfo {
    url : string;
    token : string;
}

function readServerInfo() : ServerInfo {
    try {
        const info = JSON.parse(fs.readFileSync(INFO_PATH, "utf-8")) as Partial<ServerInfo>;
        if (typeof info.url === "string" && typeof info.token === "string") {
            return { url: info.url.replace(/\/$/, ""),
                token: info.token };
        }
    } catch {
    }
    throw new BoxgeError(
        "The Boxge server is not running, so there is nothing to talk to. " +
        "Start it with `npm start` in the Boxge folder, or load its launchd service.");
}

interface RequestOptions {
    query? : Record<string, string | number | boolean | undefined>;
    body? : unknown;
    timeoutMs? : number;
}

export async function request<T = Record<string, unknown>>(method : string, apiPath : string, opts : RequestOptions = {}) : Promise<T> {
    const info = readServerInfo();
    const url = new URL(`${info.url}/api/local${apiPath}`);
    for (const [ key, value ] of Object.entries(opts.query ?? {})) {
        if (value !== undefined) {
            url.searchParams.set(key, String(value));
        }
    }

    let response : Response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${info.token}`,
                ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
    } catch (e) {
        const cause = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
        throw new BoxgeError(`The Boxge server is not answering at ${info.url} (${cause}). ` +
            "Start it with `npm start` in the Boxge folder, or load its launchd service.");
    }

    const text = await response.text();
    let data : Record<string, unknown> = {};
    try {
        data = JSON.parse(text) as Record<string, unknown>;
    } catch {
        data = { msg: text.slice(0, 500) };
    }
    if (!response.ok) {
        throw new BoxgeError(typeof data.msg === "string" ? data.msg : `The server answered ${response.status}.`, response.status, data);
    }
    return data as T;
}

const enc = encodeURIComponent;

export const api = {
    status: () => request("GET", "/status"),

    startRuntime: () => request("POST", "/runtime/start", { timeoutMs: OPERATION_TIMEOUT_MS }),

    stopRuntime: () => request("POST", "/runtime/stop", { timeoutMs: OPERATION_TIMEOUT_MS }),

    stopAll: () => request("POST", "/containers/stop-all", { timeoutMs: OPERATION_TIMEOUT_MS }),

    stack: (name : string, secrets = false) => request("GET", `/stacks/${enc(name)}`, { query: { secrets: secrets ? 1 : undefined } }),

    validate: (composeYAML : string, composeENV? : string, name? : string) =>
        request("POST", "/validate", { body: { composeYAML,
            composeENV,
            name } }),

    saveStack: (name : string, composeYAML : string, composeENV : string | undefined, deploy : boolean) =>
        request("PUT", `/stacks/${enc(name)}`, {
            body: { composeYAML,
                composeENV,
                deploy },
            timeoutMs: deploy ? OPERATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
        }),

    setStackEnv: (name : string, change : EnvChange) => request("POST", `/stacks/${enc(name)}/env`, { body: change }),

    deleteStack: (name : string) =>
        request("DELETE", `/stacks/${enc(name)}`, { query: { confirm: name },
            timeoutMs: OPERATION_TIMEOUT_MS }),

    stackAction: (name : string, action : StackAction) =>
        request("POST", `/stacks/${enc(name)}/${action}`, { query: { wait: 1 },
            timeoutMs: OPERATION_TIMEOUT_MS }),

    serviceAction: (name : string, service : string, action : ServiceAction) =>
        request("POST", `/stacks/${enc(name)}/services/${enc(service)}/${action}`, { timeoutMs: OPERATION_TIMEOUT_MS }),

    logs: (name : string, service? : string, tail? : number) =>
        request("GET", `/stacks/${enc(name)}/logs`, { query: { service,
            tail } }),

    exec: (name : string, service : string, command : string[], timeoutSeconds? : number) =>
        request("POST", `/stacks/${enc(name)}/services/${enc(service)}/exec`, {
            body: { command,
                timeoutSeconds },
            timeoutMs: ((timeoutSeconds ?? 60) + 15) * 1000,
        }),

    resources: (kind : ResourceKind) => request("GET", `/resources/${kind}`),

    stats: () => request("GET", "/stats"),

    disk: () => request("GET", "/disk"),

    settings: (secrets = false) => request("GET", "/settings", { query: { secrets: secrets ? 1 : undefined } }),

    setSettings: (change : { serviceDnsDomain? : string; primaryHostname? : string; globalEnv? : EnvChange }) =>
        request("PUT", "/settings", { body: change }),
};
