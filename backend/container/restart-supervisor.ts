import fs from "node:fs";
import { log } from "../log";
import { listAllContainers, runContainerCmd, summarizeOutput } from "./container-cli";
import type { RestartPolicy } from "./types";

interface Supervised {
    containerName: string;
    stackName: string;
    policy: RestartPolicy;
    maxRetries?: number;
    attempts: number;
    nextAttemptAt: number;
    lastStartAt: number;
    givenUp: boolean;
}

const RECONCILE_INTERVAL = 5_000;
const BACKOFF_BASE = 5_000;
const BACKOFF_MAX = 5 * 60_000;
const STABLE_AFTER = 60_000;
const START_TIMEOUT = 60_000;

class RestartSupervisor {
    private supervised = new Map<string, Supervised>();
    private stopped = new Set<string>();
    private held = new Map<string, number>();
    private interval?: NodeJS.Timeout;
    private reconciling = false;
    private stateFile?: string;

    setStateFile(file: string): void {
        this.stateFile = file;
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { stopped?: unknown };
            if (Array.isArray(data.stopped)) {
                this.stopped = new Set(data.stopped.map(String));
            }
        } catch {
            this.stopped = new Set();
        }
    }

    private persist(): void {
        if (!this.stateFile) {
            return;
        }
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify({ stopped: [ ...this.stopped ].sort() }, null, 4));
        } catch (e) {
            log.warn("restart-supervisor", `Could not save state: ${e instanceof Error ? e.message : e}`);
        }
    }

    register(stackName: string, containerName: string, policy: RestartPolicy | undefined, maxRetries?: number): void {
        if (!policy || policy === "no") {
            this.supervised.delete(containerName);
            if (this.stopped.delete(containerName)) {
                this.persist();
            }
            return;
        }
        const existing = this.supervised.get(containerName);
        this.supervised.set(containerName, {
            containerName,
            stackName,
            policy,
            maxRetries,
            attempts: existing?.attempts ?? 0,
            nextAttemptAt: existing?.nextAttemptAt ?? 0,
            lastStartAt: existing?.lastStartAt ?? 0,
            givenUp: false,
        });
        this.ensureLoop();
    }

    markStopped(containerName: string): void {
        if (this.supervised.has(containerName) && !this.stopped.has(containerName)) {
            this.stopped.add(containerName);
            this.persist();
        }
    }

    markStarted(containerName: string): void {
        const s = this.supervised.get(containerName);
        if (s) {
            s.attempts = 0;
            s.nextAttemptAt = 0;
            s.givenUp = false;
        }
        if (this.stopped.delete(containerName)) {
            this.persist();
        }
    }

    hold(containerName: string): void {
        this.held.set(containerName, (this.held.get(containerName) ?? 0) + 1);
    }

    release(containerName: string): void {
        const count = (this.held.get(containerName) ?? 0) - 1;
        if (count > 0) {
            this.held.set(containerName, count);
        } else {
            this.held.delete(containerName);
        }
    }

    unregister(stackName: string): void {
        let changed = false;
        for (const [ name, s ] of this.supervised) {
            if (s.stackName === stackName) {
                this.supervised.delete(name);
                changed = this.stopped.delete(name) || changed;
            }
        }
        if (changed) {
            this.persist();
        }
    }

    unregisterContainer(containerName: string): void {
        this.supervised.delete(containerName);
        if (this.stopped.delete(containerName)) {
            this.persist();
        }
    }

    restartInfo(containerName: string): { attempts: number; givenUp: boolean } | undefined {
        const s = this.supervised.get(containerName);
        return s ? { attempts: s.attempts,
            givenUp: s.givenUp } : undefined;
    }

    private ensureLoop(): void {
        if (this.interval) {
            return;
        }
        this.interval = setInterval(() => {
            void this.reconcile();
        }, RECONCILE_INTERVAL);
        this.interval.unref();
    }

    private async reconcile(): Promise<void> {
        if (this.reconciling || this.supervised.size === 0) {
            return;
        }
        this.reconciling = true;
        try {
            const containers = await listAllContainers();
            const byId = new Map(containers.map((c) => [ c.id, c ]));
            const now = Date.now();

            for (const [ name, s ] of this.supervised) {
                const state = byId.get(name)?.status?.state;
                if (state === "running") {
                    if (s.attempts > 0 && now - s.lastStartAt > STABLE_AFTER) {
                        s.attempts = 0;
                        s.nextAttemptAt = 0;
                    }
                    continue;
                }
                if (state !== "stopped" || s.givenUp || this.stopped.has(name) || this.held.has(name) || now < s.nextAttemptAt) {
                    continue;
                }
                if (s.maxRetries !== undefined && s.attempts >= s.maxRetries) {
                    s.givenUp = true;
                    log.warn("restart-supervisor", `Giving up on ${name} after ${s.attempts} restart attempts`);
                    continue;
                }

                s.attempts++;
                s.lastStartAt = now;
                s.nextAttemptAt = now + Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (s.attempts - 1));
                log.info("restart-supervisor", `Restarting ${name} (policy=${s.policy}, attempt ${s.attempts})`);
                try {
                    const { exitCode, stderr } = await runContainerCmd([ "start", name ], { timeoutMs: START_TIMEOUT });
                    if (exitCode !== 0) {
                        log.warn("restart-supervisor", `Failed to restart ${name}: ${summarizeOutput(stderr) || "exit " + exitCode}`);
                    }
                } catch (e) {
                    log.warn("restart-supervisor", `Failed to restart ${name}: ${e instanceof Error ? e.message : e}`);
                }
            }
        } catch (e) {
            log.debug("restart-supervisor", "reconcile failed: " + (e instanceof Error ? e.message : e));
        } finally {
            this.reconciling = false;
        }
    }
}

export const restartSupervisor = new RestartSupervisor();
