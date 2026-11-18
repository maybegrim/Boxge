import { spawn, type ChildProcess } from "node:child_process";
import semver from "semver";
import { log } from "../log";
import type { ProgressSink, RawContainer, RawSystemStatus } from "./types";

export const CONTAINER_BIN = process.env.BOXGE_CONTAINER_BIN || "container";

export const MIN_CONTAINER_VERSION = "1.7.1";

export const STACK_LABEL = "boxge.stack";

export const NETWORK_PREFIX = "boxge-";

export const ANON_VOLUME_LABEL = "com.apple.container.resource.anonymous";

const READ_TIMEOUT_MS = 30_000;

const SYSTEM_START_TIMEOUT_MS = 5 * 60_000;

const LIST_TTL_MS = 1500;

const VERSION_TTL_MS = 60_000;

const KILL_GRACE_MS = 3000;

const MUTATING_COMMANDS = new Set([ "run", "create", "start", "stop", "delete", "rm", "kill", "prune" ]);

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface RunOptions {
    cwd?: string;
    stream?: ProgressSink;
    throwOnError?: boolean;
    timeoutMs?: number;
}

export function summarizeOutput(text: string): string {
    const lines = text
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const errors = lines.filter((line) => /^error\b/i.test(line));
    if (errors.length > 0) {
        return errors.join(" ");
    }
    return lines[lines.length - 1] ?? "";
}

let listCache: { at: number; promise: Promise<RawContainer[]> } | undefined;

export function invalidateContainerList(): void {
    listCache = undefined;
}

export function runContainerCmd(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        log.debug("container", `${CONTAINER_BIN} ${args.join(" ")}`);

        const mutating = MUTATING_COMMANDS.has(args[0]);
        if (mutating) {
            invalidateContainerList();
        }

        const child = spawn(CONTAINER_BIN, args, {
            cwd: opts.cwd,
            env: process.env,
            stdio: [ "ignore", "pipe", "pipe" ],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        let killTimer: NodeJS.Timeout | undefined;
        const timer = opts.timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                try {
                    child.kill("SIGTERM");
                } catch {
                }
                killTimer = setTimeout(() => {
                    try {
                        child.kill("SIGKILL");
                    } catch {
                    }
                }, KILL_GRACE_MS);
            }, opts.timeoutMs)
            : undefined;

        child.stdout.on("data", (data: Buffer) => {
            const text = data.toString();
            stdout += text;
            opts.stream?.(text);
        });

        child.stderr.on("data", (data: Buffer) => {
            const text = data.toString();
            stderr += text;
            opts.stream?.(text);
        });

        child.on("error", (err) => {
            if (timer) {
                clearTimeout(timer);
            }
            reject(err);
        });

        child.on("close", (code) => {
            if (timer) {
                clearTimeout(timer);
            }
            if (killTimer) {
                clearTimeout(killTimer);
            }
            if (mutating) {
                invalidateContainerList();
            }
            const exitCode = timedOut ? -1 : (code ?? -1);
            if (opts.throwOnError && exitCode !== 0) {
                const reason = timedOut ? `timed out after ${opts.timeoutMs}ms` : (summarizeOutput(stderr) || summarizeOutput(stdout));
                reject(new Error(`container ${args.join(" ")} exited ${exitCode}: ${reason}`));
                return;
            }
            resolve({ stdout,
                stderr,
                exitCode });
        });
    });
}

export function registryLoginCmd(server: string, username: string, password: string): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(CONTAINER_BIN, [ "registry", "login", server, "-u", username, "--password-stdin" ], {
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => {
            stdout += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => {
            const exitCode = code ?? -1;
            if (exitCode !== 0) {
                reject(new Error(`registry login failed (${exitCode}): ${stderr.trim()}`));
            } else {
                resolve({ stdout,
                    stderr,
                    exitCode });
            }
        });
        child.stdin.write(password + "\n");
        child.stdin.end();
    });
}

export function spawnContainer(args: string[], opts: { cwd?: string; onData?: (chunk: string) => void } = {}): ChildProcess {
    log.debug("container", `(stream) ${CONTAINER_BIN} ${args.join(" ")}`);
    const child = spawn(CONTAINER_BIN, args, { cwd: opts.cwd,
        env: process.env,
        stdio: [ "ignore", "pipe", "pipe" ] });
    if (opts.onData) {
        child.stdout?.on("data", (d: Buffer) => opts.onData!(d.toString()));
        child.stderr?.on("data", (d: Buffer) => opts.onData!(d.toString()));
    }
    return child;
}

export async function runContainerJson<T>(args: string[], opts: RunOptions = {}): Promise<T> {
    const emitsJsonByDefault = args.includes("inspect");
    const withFormat = (emitsJsonByDefault || args.includes("--format")) ? args : [ ...args, "--format", "json" ];
    const { stdout, stderr, exitCode } = await runContainerCmd(withFormat, { timeoutMs: READ_TIMEOUT_MS,
        ...opts });
    if (exitCode !== 0) {
        throw new Error(`container ${args.join(" ")} failed (${exitCode}): ${summarizeOutput(stderr)}`);
    }
    if (!stdout.trim()) {
        return ([] as unknown) as T;
    }
    return JSON.parse(stdout) as T;
}

export function listAllContainers(): Promise<RawContainer[]> {
    const now = Date.now();
    if (listCache && now - listCache.at < LIST_TTL_MS) {
        return listCache.promise;
    }
    const promise = runContainerJson<RawContainer[]>([ "list", "--all" ]);
    const entry = { at: now,
        promise };
    listCache = entry;
    promise.catch(() => {
        if (listCache === entry) {
            listCache = undefined;
        }
    });
    return promise;
}

let versionCache: { at: number; version: string } | undefined;

export async function getContainerCliVersion(): Promise<string> {
    const now = Date.now();
    if (versionCache && now - versionCache.at < VERSION_TTL_MS) {
        return versionCache.version;
    }
    const { stdout } = await runContainerCmd([ "--version" ], { timeoutMs: READ_TIMEOUT_MS });
    const match = stdout.match(/version\s+(\d+\.\d+\.\d+)/i);
    const version = match ? match[1] : stdout.trim();
    versionCache = { at: now,
        version };
    return version;
}

export async function ensureSystemStartedImpl(): Promise<void> {
    const { stdout, stderr, exitCode } = await runContainerCmd(
        [ "system", "start", "--enable-kernel-install" ],
        { timeoutMs: SYSTEM_START_TIMEOUT_MS });
    const combined = stdout + stderr;
    if (combined.includes("No default kernel configured")) {
        throw new Error(
            "container has no default kernel configured. Run " +
            "`container system kernel set --recommended` once, then start Boxge again.");
    }
    if (exitCode !== 0) {
        throw new Error(`container system start failed (${exitCode}): ${summarizeOutput(stderr)}`);
    }
}

export async function readSystemStatus(): Promise<RawSystemStatus | null> {
    try {
        const { stdout } = await runContainerCmd([ "system", "status", "--format", "json" ], { timeoutMs: READ_TIMEOUT_MS });
        const parsed = JSON.parse(stdout) as RawSystemStatus;
        return parsed && typeof parsed.status === "string" ? parsed : null;
    } catch (e) {
        if (e instanceof Error) {
            log.debug("container", "readSystemStatus failed: " + e.message);
        }
        return null;
    }
}

export function isSupportedVersion(version: string): boolean {
    const parsed = semver.coerce(version);
    return parsed !== null && semver.gte(parsed, MIN_CONTAINER_VERSION);
}

let warnedVersion: string | undefined;

export async function validateContainerVersion(): Promise<{ version: string; supported: boolean }> {
    let version = "unknown";
    try {
        version = await getContainerCliVersion();
    } catch (e) {
        if (e instanceof Error) {
            log.error("container", `Could not run '${CONTAINER_BIN} --version': ${e.message}. ` +
                "Is Apple's container runtime installed? See https://github.com/apple/container");
        }
        return { version,
            supported: false };
    }

    const supported = isSupportedVersion(version);
    if (!supported && warnedVersion !== version) {
        warnedVersion = version;
        log.error("container",
            `container CLI version ${version} is older than ${MIN_CONTAINER_VERSION}, the minimum Boxge supports. ` +
            "Install the latest release from https://github.com/apple/container/releases. " +
            "Boxge will keep running, but CPU stats and newer features will not work.");
    }
    return { version,
        supported };
}
