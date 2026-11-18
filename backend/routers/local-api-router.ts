import fs, { promises as fsAsync } from "node:fs";
import path from "node:path";
import express, { Express, NextFunction, Request, Response, Router as ExpressRouter } from "express";
import { DockgeServer } from "../dockge-server";
import { Router } from "../router";
import { Stack } from "../stack";
import { Settings } from "../settings";
import { editEnv, listEnv } from "../env-file";
import { fileExists, ValidationError } from "../util-server";
import {
    buildBuildArgs,
    buildRunArgs,
    containerEngine,
    normalizeDnsDomain,
    runContainerCmd,
    serviceDnsName,
    type ServiceStatus,
} from "../container";
import { log } from "../log";

const STACK_NAME_PATTERN = /^[a-z0-9_-]+$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STACK_ACTIONS = [ "start", "deploy", "stop", "restart", "update", "down", "clean" ] as const;
const SERVICE_ACTIONS = [ "start", "stop", "restart" ] as const;
const RESOURCE_KINDS = [ "images", "volumes", "networks" ] as const;
const OUTPUT_LIMIT = 200 * 1024;
const DEFAULT_EXEC_TIMEOUT = 60;
const MAX_EXEC_TIMEOUT = 600;
const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 5000;

type StackAction = typeof STACK_ACTIONS[number];
type ServiceAction = typeof SERVICE_ACTIONS[number];

class HttpError extends Error {
    constructor(public status : number, message : string) {
        super(message);
    }
}

function summarize(services : ServiceStatus[]) : { status : string; running : number; total : number } {
    const total = services.length;
    const running = services.filter((s) => s.state === "running").length;
    let status = "inactive";
    if (total > 0) {
        status = running === total ? "running" : (running > 0 ? "partial" : "stopped");
    }
    return { status,
        running,
        total };
}

export function cleanOutput(text : string, maxLines = 400) : string {
    const lines = text
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .split(/\r\n|\r|\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line !== "");
    const out : string[] = [];
    let lastKey = "";
    for (const line of lines) {
        const key = /^\[\d+\/\d+\]/.test(line)
            ? "progress"
            : line.replace(/\[\d+s\]$/, "").replace(/\d+(\.\d+)?\s?(%|[KMG]i?B(\/s)?)/g, "#");
        if (out.length > 0 && key === lastKey) {
            out[out.length - 1] = line;
        } else {
            out.push(line);
        }
        lastKey = key;
    }
    return out.slice(-maxLines).join("\n");
}

function shellQuote(arg : string) : string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

function cap(text : string) : string {
    return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

function stackName(req : Request) : string {
    const name = req.params.name;
    if (!STACK_NAME_PATTERN.test(name)) {
        throw new HttpError(400, "Stack names may only contain a-z, 0-9, _ and -.");
    }
    return name;
}

function serviceName(req : Request) : string {
    const name = req.params.service;
    if (!SERVICE_NAME_PATTERN.test(name)) {
        throw new HttpError(400, "That is not a valid service name.");
    }
    return name;
}

function wantsSecrets(req : Request) : boolean {
    return req.query.secrets === "1" || req.query.secrets === "true";
}

async function existingStack(server : DockgeServer, name : string) : Promise<Stack> {
    try {
        return await Stack.getStack(server, name);
    } catch (e) {
        throw new HttpError(404, e instanceof Error ? e.message : String(e));
    }
}

function requireIdle(name : string) : void {
    if (Stack.isBusy(name)) {
        throw new HttpError(409, "Another operation is already running for this stack.");
    }
}

function globalEnvPath(server : DockgeServer) : string {
    return path.join(server.stacksDir, "global.env");
}

function readGlobalEnv(server : DockgeServer) : string {
    try {
        return fs.readFileSync(globalEnvPath(server), "utf-8");
    } catch {
        return "";
    }
}

export class LocalApiRouter extends Router {
    create(app : Express, server : DockgeServer) : ExpressRouter {
        const router = express.Router();

        const guard = (req : Request, res : Response, next : NextFunction) => {
            if (!server.localApi.authorize(req)) {
                res.status(401).json({ ok: false,
                    msg: "unauthorized" });
                return;
            }
            next();
        };

        const handle = (fn : (req : Request, res : Response) => Promise<void>) => {
            return (req : Request, res : Response) => {
                fn(req, res).catch((e) => {
                    const status = e instanceof HttpError ? e.status : (e instanceof ValidationError ? 400 : 500);
                    res.status(status).json({ ok: false,
                        msg: e instanceof Error ? e.message : String(e) });
                });
            };
        };

        const runOperation = async (name : string, label : string, wait : boolean, res : Response, op : () => Promise<unknown>, extra : object = {}) => {
            requireIdle(name);
            log.info("local-api", `${label} ${name}`);
            const running = op().finally(() => void server.sendStackList());
            if (!wait) {
                running.catch((e) => log.warn("local-api", `${label} ${name} failed: ${e instanceof Error ? e.message : e}`));
                res.status(202).json({ ok: true,
                    ...extra });
                return;
            }
            try {
                await running;
                res.json({ ok: true,
                    ...extra,
                    output: cleanOutput(Stack.lastOutput(name)) });
            } catch (e) {
                res.status(500).json({ ok: false,
                    ...extra,
                    msg: e instanceof Error ? e.message : String(e),
                    output: cleanOutput(Stack.lastOutput(name)) });
            }
        };

        const liveStatus = async () : Promise<Map<string, ServiceStatus[]>> => {
            try {
                return await containerEngine.allStackStatus();
            } catch (e) {
                log.debug("local-api", "Could not read stack status: " + (e instanceof Error ? e.message : e));
                return new Map();
            }
        };

        router.use("/api/local", guard, express.json({ limit: "2mb" }));

        router.get("/api/local/status", handle(async (_req, res) => {
            const runtime = await containerEngine.systemStatus();
            const managed = await Stack.getStackList(server);
            const live = runtime.running ? await liveStatus() : new Map<string, ServiceStatus[]>();

            let containers = { running: 0,
                total: 0 };
            if (runtime.running) {
                try {
                    const all = await containerEngine.listContainers();
                    containers = { running: all.filter((c) => c.status?.state === "running").length,
                        total: all.length };
                } catch (e) {
                    log.debug("local-api", "Could not list containers: " + (e instanceof Error ? e.message : e));
                }
            }

            const names = [ ...new Set([ ...managed.keys(), ...live.keys() ]) ].sort((a, b) => a.localeCompare(b));
            const stacks = names.map((name) => {
                const services = live.get(name) ?? [];
                return {
                    name,
                    ...summarize(services),
                    managed: managed.has(name),
                    busy: Stack.isBusy(name),
                    error: Stack.lastError(name) ?? null,
                    services: services
                        .map((s) => ({ name: s.service,
                            state: s.state,
                            health: s.health ?? null }))
                        .sort((a, b) => a.name.localeCompare(b.name)),
                };
            });

            res.json({
                ok: true,
                boxge: { version: server.packageJSON.version },
                runtime: {
                    running: runtime.running,
                    version: runtime.version,
                    supported: runtime.supported,
                    minVersion: runtime.minVersion,
                },
                containers,
                stacksDir: server.stackDirFullPath,
                serviceDnsDomain: Stack.serviceDnsDomain || null,
                stacks,
            });
        }));

        router.post("/api/local/runtime/start", handle(async (_req, res) => {
            log.info("local-api", "start runtime");
            await containerEngine.ensureSystemStarted();
            await Stack.reconcileSupervisors(server);
            void server.sendSystemStatus();
            void server.sendStackList();
            res.json({ ok: true });
        }));

        router.post("/api/local/runtime/stop", handle(async (_req, res) => {
            const busy = [ ...(await Stack.getStackList(server, true)).keys() ].filter((name) => Stack.isBusy(name));
            if (busy.length > 0) {
                throw new HttpError(409, `An operation is still running for: ${busy.join(", ")}.`);
            }
            log.info("local-api", "stop runtime");
            await containerEngine.stopSystem();
            void server.sendSystemStatus();
            void server.sendStackList();
            res.json({ ok: true });
        }));

        router.post("/api/local/containers/stop-all", handle(async (_req, res) => {
            log.info("local-api", "stop all containers");
            const result = await containerEngine.stopAllContainers();
            void server.sendStackList();
            res.status(result.failed.length > 0 ? 500 : 200).json({
                ok: result.failed.length === 0,
                msg: result.failed.length > 0 ? `${result.failed.length} container(s) could not be stopped.` : undefined,
                ...result,
            });
        }));

        router.post("/api/local/validate", handle(async (req, res) => {
            const body = (req.body ?? {}) as { name? : unknown; composeYAML? : unknown; composeENV? : unknown };
            if (typeof body.composeYAML !== "string") {
                throw new HttpError(400, "composeYAML is required.");
            }
            const name = typeof body.name === "string" && STACK_NAME_PATTERN.test(body.name) ? body.name : "preview";
            const draft = new Stack(server, name, body.composeYAML, typeof body.composeENV === "string" ? body.composeENV : "", true);
            const parsed = draft.parse();
            res.json({
                ok: true,
                warnings: parsed.warnings,
                networks: parsed.networks.map((n) => ({ name: n.name,
                    external: n.external })),
                services: parsed.services.map((svc) => ({
                    name: svc.name,
                    container: `${parsed.name}-${svc.name}`,
                    dnsName: serviceDnsName(parsed, svc.name) ?? null,
                    build: svc.build ? [ "container", ...buildBuildArgs(parsed, svc) ].map(shellQuote).join(" ") : null,
                    run: [ "container", ...buildRunArgs(parsed, svc) ].map(shellQuote).join(" "),
                })),
            });
        }));

        router.get("/api/local/stacks/:name", handle(async (req, res) => {
            const name = stackName(req);
            const stack = await existingStack(server, name);
            let services : ServiceStatus[] = [];
            try {
                services = await containerEngine.stackStatus(name);
            } catch (e) {
                log.debug("local-api", "Could not read stack status: " + (e instanceof Error ? e.message : e));
            }

            let parseError : string | null = null;
            let dnsNames : Record<string, string | null> = {};
            try {
                const parsed = stack.parse();
                dnsNames = Object.fromEntries(parsed.services.map((svc) => [ svc.name, serviceDnsName(parsed, svc.name) ?? null ]));
            } catch (e) {
                parseError = e instanceof Error ? e.message : String(e);
            }

            res.json({
                ok: true,
                stack: {
                    name,
                    ...summarize(services),
                    busy: Stack.isBusy(name),
                    error: Stack.lastError(name) ?? null,
                    path: stack.fullPath,
                    composeYAML: stack.composeYAML,
                    env: listEnv(stack.composeENV, wantsSecrets(req)),
                    warnings: stack.warnings,
                    parseError,
                    services: services
                        .map((s) => ({
                            name: s.service,
                            container: s.containerName,
                            state: s.state,
                            health: s.health ?? null,
                            ip: s.ipv4 ?? null,
                            dnsName: dnsNames[s.service] ?? null,
                            ports: (s.publishedPorts ?? []).map((p) => ({
                                hostAddress: p.hostAddress,
                                hostPort: p.hostPort,
                                containerPort: p.containerPort,
                                proto: p.proto,
                            })),
                        }))
                        .sort((a, b) => a.name.localeCompare(b.name)),
                },
            });
        }));

        router.put("/api/local/stacks/:name", handle(async (req, res) => {
            const name = stackName(req);
            const body = (req.body ?? {}) as { composeYAML? : unknown; composeENV? : unknown; deploy? : unknown };
            if (typeof body.composeYAML !== "string" || body.composeYAML.trim() === "") {
                throw new HttpError(400, "composeYAML is required.");
            }
            if (body.composeENV !== undefined && typeof body.composeENV !== "string") {
                throw new HttpError(400, "composeENV must be a string.");
            }
            requireIdle(name);

            const exists = await fileExists(path.join(server.stacksDir, name));
            const stack = new Stack(server, name, body.composeYAML, body.composeENV as string | undefined);
            const parsed = stack.parse();
            await stack.save(!exists);
            log.info("local-api", `${exists ? "update" : "create"} ${name}`);
            void server.sendStackList();

            const extra = { created: !exists,
                warnings: parsed.warnings };
            if (body.deploy === true) {
                await runOperation(name, "deploy", true, res, () => stack.deploy(), extra);
                return;
            }
            res.json({ ok: true,
                ...extra });
        }));

        router.post("/api/local/stacks/:name/env", handle(async (req, res) => {
            const name = stackName(req);
            const stack = await existingStack(server, name);
            const body = (req.body ?? {}) as { set? : Record<string, unknown>; unset? : unknown };
            const set = Object.fromEntries(Object.entries(body.set ?? {}).map(([ k, v ]) => [ k, String(v) ]));
            const unset = Array.isArray(body.unset) ? body.unset.map(String) : [];
            requireIdle(name);

            const updated = editEnv(stack.composeENV, set, unset);
            const envPath = path.join(stack.path, ".env");
            if (updated === "") {
                await fsAsync.rm(envPath, { force: true });
            } else {
                await fsAsync.writeFile(envPath, updated);
            }
            log.info("local-api", `env ${name}: set [${Object.keys(set).join(", ")}] unset [${unset.join(", ")}]`);
            res.json({ ok: true,
                keys: listEnv(updated, false).map((e) => e.key) });
        }));

        router.delete("/api/local/stacks/:name", handle(async (req, res) => {
            const name = stackName(req);
            if (req.query.confirm !== name) {
                throw new HttpError(400, "Pass confirm=<stack name> to delete a stack.");
            }
            const stack = await existingStack(server, name);
            requireIdle(name);
            log.info("local-api", `delete ${name}`);

            try {
                await stack.delete();
            } catch (e) {
                throw new HttpError(500, e instanceof Error ? e.message : String(e));
            }
            const output = cleanOutput(Stack.lastOutput(name));
            Stack.forget(name);
            void server.sendStackList();
            res.json({ ok: true,
                output });
        }));

        router.get("/api/local/stacks/:name/logs", handle(async (req, res) => {
            const name = stackName(req);
            const only = typeof req.query.service === "string" && req.query.service !== "" ? req.query.service : undefined;
            const requested = Number(req.query.tail ?? DEFAULT_LOG_TAIL);
            const tail = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LOG_TAIL) : DEFAULT_LOG_TAIL;

            const services = (await containerEngine.stackStatus(name)).filter((s) => !only || s.service === only);
            if (services.length === 0) {
                throw new HttpError(404, only ? `No container for service '${only}' in stack '${name}'.` : `Stack '${name}' has no containers.`);
            }
            const logs = [];
            for (const s of services.sort((a, b) => a.service.localeCompare(b.service))) {
                const result = await runContainerCmd([ "logs", "-n", String(tail), s.containerName ], { timeoutMs: 30_000 });
                logs.push({
                    service: s.service,
                    container: s.containerName,
                    state: s.state,
                    text: cap((result.stdout + result.stderr).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")),
                });
            }
            res.json({ ok: true,
                logs });
        }));

        router.post("/api/local/stacks/:name/services/:service/exec", handle(async (req, res) => {
            const name = stackName(req);
            const service = serviceName(req);
            const body = (req.body ?? {}) as { command? : unknown; timeoutSeconds? : unknown };
            if (!Array.isArray(body.command) || body.command.length === 0 || !body.command.every((part) => typeof part === "string")) {
                throw new HttpError(400, "command must be a non-empty array of strings.");
            }
            const requested = Number(body.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT);
            const timeout = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_EXEC_TIMEOUT) : DEFAULT_EXEC_TIMEOUT;
            const container = `${name}-${service}`;

            log.info("local-api", `exec ${container}: ${(body.command as string[]).map(shellQuote).join(" ")}`);
            const result = await runContainerCmd([ "exec", container, ...(body.command as string[]) ], { timeoutMs: timeout * 1000 });
            res.json({
                ok: true,
                exitCode: result.exitCode,
                timedOut: result.exitCode === -1,
                stdout: cap(result.stdout),
                stderr: cap(result.stderr),
            });
        }));

        router.post("/api/local/stacks/:name/services/:service/:action", handle(async (req, res) => {
            const name = stackName(req);
            const service = serviceName(req);
            const action = req.params.action as ServiceAction;
            if (!SERVICE_ACTIONS.includes(action)) {
                throw new HttpError(400, `Unknown service action. Use one of: ${SERVICE_ACTIONS.join(", ")}.`);
            }
            const stack = await existingStack(server, name);
            const operations : Record<ServiceAction, () => Promise<unknown>> = {
                start: () => stack.startService(undefined, service),
                stop: () => stack.stopService(undefined, service),
                restart: () => stack.restartService(undefined, service),
            };
            await runOperation(name, `${action} service ${service} in`, true, res, operations[action]);
        }));

        router.post("/api/local/stacks/:name/:action", handle(async (req, res) => {
            const name = stackName(req);
            const action = req.params.action as StackAction;
            if (!STACK_ACTIONS.includes(action)) {
                throw new HttpError(400, `Unknown stack action. Use one of: ${STACK_ACTIONS.join(", ")}.`);
            }
            const stack = await existingStack(server, name);
            try {
                stack.parse();
            } catch (e) {
                throw new HttpError(400, e instanceof Error ? e.message : String(e));
            }
            const operations : Record<StackAction, () => Promise<unknown>> = {
                start: () => stack.start(),
                deploy: () => stack.deploy(),
                stop: () => stack.stop(),
                restart: () => stack.restart(),
                update: () => stack.update(),
                down: () => stack.down(),
                clean: () => stack.clean(),
            };
            const wait = req.query.wait === "1" || req.query.wait === "true";
            await runOperation(name, action, wait, res, operations[action]);
        }));

        router.get("/api/local/resources/:kind", handle(async (req, res) => {
            const kind = req.params.kind as typeof RESOURCE_KINDS[number];
            if (!RESOURCE_KINDS.includes(kind)) {
                throw new HttpError(400, `Unknown resource kind. Use one of: ${RESOURCE_KINDS.join(", ")}.`);
            }
            const items = kind === "images"
                ? await containerEngine.listImages()
                : (kind === "volumes" ? await containerEngine.listVolumes() : await containerEngine.listNetworks());
            res.json({ ok: true,
                kind,
                items });
        }));

        router.get("/api/local/disk", handle(async (_req, res) => {
            res.json({ ok: true,
                usage: await containerEngine.diskUsage() });
        }));

        router.get("/api/local/stats", handle(async (_req, res) => {
            res.json({ ok: true,
                stats: await containerEngine.allStats() });
        }));

        router.get("/api/local/settings", handle(async (req, res) => {
            res.json({
                ok: true,
                settings: {
                    serviceDnsDomain: Stack.serviceDnsDomain,
                    serviceDnsRegistered: Stack.serviceDnsDomain !== "" && await containerEngine.isDnsDomainRegistered(Stack.serviceDnsDomain),
                    primaryHostname: (await Settings.get("primaryHostname")) || "",
                    globalEnv: listEnv(readGlobalEnv(server), wantsSecrets(req)),
                },
            });
        }));

        router.put("/api/local/settings", handle(async (req, res) => {
            const body = (req.body ?? {}) as {
                serviceDnsDomain? : unknown;
                primaryHostname? : unknown;
                globalEnv? : { set? : Record<string, unknown>; unset? : unknown };
            };
            const changed : string[] = [];

            if (body.serviceDnsDomain !== undefined) {
                let domain : string;
                try {
                    domain = normalizeDnsDomain(body.serviceDnsDomain);
                } catch (e) {
                    throw new HttpError(400, e instanceof Error ? e.message : String(e));
                }
                await Settings.set("serviceDnsDomain", domain, "general");
                changed.push("serviceDnsDomain");
            }
            if (body.primaryHostname !== undefined) {
                await Settings.set("primaryHostname", String(body.primaryHostname).trim(), "general");
                changed.push("primaryHostname");
            }
            if (body.globalEnv) {
                const set = Object.fromEntries(Object.entries(body.globalEnv.set ?? {}).map(([ k, v ]) => [ k, String(v) ]));
                const unset = Array.isArray(body.globalEnv.unset) ? body.globalEnv.unset.map(String) : [];
                let updated : string;
                try {
                    updated = editEnv(readGlobalEnv(server), set, unset);
                } catch (e) {
                    throw new HttpError(400, e instanceof Error ? e.message : String(e));
                }
                if (updated === "") {
                    await fsAsync.rm(globalEnvPath(server), { force: true });
                } else {
                    await fsAsync.writeFile(globalEnvPath(server), updated);
                }
                changed.push("globalEnv");
            }

            log.info("local-api", `settings changed: ${changed.join(", ") || "nothing"}`);
            await server.reloadServiceDns();
            void server.sendSystemStatus();
            res.json({ ok: true,
                changed });
        }));

        return router;
    }
}
