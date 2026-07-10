import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../log";
import type { ProgressSink, RawSystemStatus } from "./types";

export const CONTAINER_BIN = process.env.BOXGE_CONTAINER_BIN || "container";

export const SUPPORTED_CONTAINER_VERSION = "1.0.0";

export const STACK_LABEL = "boxge.stack";

export const NETWORK_PREFIX = "boxge-";

export const ANON_VOLUME_LABEL = "com.apple.container.resource.anonymous";

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

export function runContainerCmd(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        log.debug("container", `${CONTAINER_BIN} ${args.join(" ")}`);

        const child = spawn(CONTAINER_BIN, args, {
            cwd: opts.cwd,
            env: process.env,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = opts.timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                try {
                    child.kill("SIGKILL");
                } catch {
                }
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
            const exitCode = timedOut ? -1 : (code ?? -1);
            if (opts.throwOnError && exitCode !== 0) {
                reject(new Error(`container ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`));
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
        env: process.env });
    if (opts.onData) {
        child.stdout.on("data", (d: Buffer) => opts.onData!(d.toString()));
        child.stderr.on("data", (d: Buffer) => opts.onData!(d.toString()));
    }
    return child;
}

export async function runContainerJson<T>(args: string[], opts: RunOptions = {}): Promise<T> {
    const emitsJsonByDefault = args.includes("inspect");
    const withFormat = (emitsJsonByDefault || args.includes("--format")) ? args : [ ...args, "--format", "json" ];
    const { stdout, stderr, exitCode } = await runContainerCmd(withFormat, opts);
    if (exitCode !== 0) {
        throw new Error(`container ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
    }
    if (!stdout.trim()) {

        return ([] as unknown) as T;
    }
    return JSON.parse(stdout) as T;
}

export async function getContainerCliVersion(): Promise<string> {
    const { stdout } = await runContainerCmd([ "--version" ]);
    const match = stdout.match(/version\s+(\d+\.\d+\.\d+)/i);
    return match ? match[1] : stdout.trim();
}

export async function ensureSystemStartedImpl(): Promise<void> {
    const { stdout, stderr, exitCode } = await runContainerCmd([ "system", "start" ]);
    const combined = stdout + stderr;
    if (combined.includes("No default kernel configured")) {
        throw new Error(
            "container has no default kernel configured. Run " +
            "`container system kernel set --recommended` once, then start Boxge again.");
    }
    if (exitCode !== 0) {
        throw new Error(`container system start failed (${exitCode}): ${stderr.trim()}`);
    }
}

export async function readSystemStatus(): Promise<RawSystemStatus | null> {
    try {
        return await runContainerJson<RawSystemStatus>([ "system", "status" ]);
    } catch (e) {
        if (e instanceof Error) {
            log.debug("container", "readSystemStatus failed: " + e.message);
        }
        return null;
    }
}

let versionWarned = false;

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

    const supported = version === SUPPORTED_CONTAINER_VERSION;
    if (!supported && !versionWarned) {
        versionWarned = true;
        log.warn("container",
            `⚠️  container CLI version ${version} differs from the pinned, tested version ` +
            `${SUPPORTED_CONTAINER_VERSION}. Boxge may misbehave; all interaction is isolated in ` +
            "backend/container/ so adjustments are localized. Proceeding anyway.");
    }
    return { version,
        supported };
}
