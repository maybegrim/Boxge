import { log } from "../log";
import { runContainerCmd, runContainerJson } from "./container-cli";
import type { RawContainer } from "./types";

export type RestartPolicy = "no" | "always" | "on-failure" | "unless-stopped";

interface Supervised {
    containerName: string;
    stackName: string;
    policy: RestartPolicy;
    explicitlyStopped: boolean;
}

const RECONCILE_INTERVAL = 10_000;

class RestartSupervisor {
    private supervised = new Map<string, Supervised>();
    private interval?: NodeJS.Timeout;
    private reconciling = false;

    register(stackName: string, containerName: string, policy: RestartPolicy | undefined): void {
        if (!policy || policy === "no") {
            this.supervised.delete(containerName);
            return;
        }
        this.supervised.set(containerName, { containerName,
            stackName,
            policy,
            explicitlyStopped: false });
        this.ensureLoop();
    }

    markStopped(containerName: string): void {
        const s = this.supervised.get(containerName);
        if (s) {
            s.explicitlyStopped = true;
        }
    }

    markStarted(containerName: string): void {
        const s = this.supervised.get(containerName);
        if (s) {
            s.explicitlyStopped = false;
        }
    }

    unregister(stackName: string): void {
        for (const [ name, s ] of this.supervised) {
            if (s.stackName === stackName) {
                this.supervised.delete(name);
            }
        }
    }

    unregisterContainer(containerName: string): void {
        this.supervised.delete(containerName);
    }

    private ensureLoop(): void {
        if (this.interval) {
            return;
        }
        this.interval = setInterval(() => {
            void this.reconcile();
        }, RECONCILE_INTERVAL);
    }

    private async reconcile(): Promise<void> {
        if (this.reconciling || this.supervised.size === 0) {
            return;
        }
        this.reconciling = true;
        try {
            const containers = await runContainerJson<RawContainer[]>([ "list", "--all" ]);
            const byId = new Map(containers.map((c) => [ c.id, c ]));

            for (const [ name, s ] of this.supervised) {
                const c = byId.get(name);
                if (!c) {

                    continue;
                }
                const state = c.status?.state;
                const isDown = state === "stopped" || state === "exited";
                if (!isDown) {
                    continue;
                }
                if (s.explicitlyStopped) {
                    continue;
                }

                log.info("restart-supervisor", `Restarting ${name} (policy=${s.policy})`);
                try {
                    await runContainerCmd([ "start", name ], { timeoutMs: 60_000 });
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
