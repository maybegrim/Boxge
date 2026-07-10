import { log } from "../log";
import { runContainerCmd } from "./container-cli";
import type { ParsedService } from "./types";

export type HealthState = "starting" | "healthy" | "unhealthy";

interface Monitored {
    containerName: string;
    stackName: string;
    test: string[];
    interval: number;
    timeout: number;
    retries: number;
    startPeriod: number;
    startedAt: number;
    consecutiveFailures: number;
    state: HealthState;
    timer?: NodeJS.Timeout;
    checking: boolean;
}

const DEFAULT_INTERVAL = 30_000;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;

class HealthMonitor {
    private monitored = new Map<string, Monitored>();

    register(stackName: string, containerName: string, healthcheck: ParsedService["healthcheck"]): void {
        if (!healthcheck || healthcheck.disabled || healthcheck.test.length === 0) {
            return;
        }
        this.unregisterContainer(containerName);

        const m: Monitored = {
            containerName,
            stackName,
            test: healthcheck.test,
            interval: healthcheck.interval ?? DEFAULT_INTERVAL,
            timeout: healthcheck.timeout ?? DEFAULT_TIMEOUT,
            retries: healthcheck.retries ?? DEFAULT_RETRIES,
            startPeriod: healthcheck.startPeriod ?? 0,
            startedAt: Date.now(),
            consecutiveFailures: 0,
            state: "starting",
            checking: false,
        };
        this.monitored.set(containerName, m);
        m.timer = setInterval(() => this.check(m), m.interval);

        setTimeout(() => this.check(m), 1500);
        log.debug("health-monitor", `monitoring ${containerName} (interval ${m.interval}ms)`);
    }

    private async check(m: Monitored): Promise<void> {
        if (m.checking) {
            return;
        }
        m.checking = true;
        try {
            const { exitCode } = await runContainerCmd([ "exec", m.containerName, ...m.test ], {
                timeoutMs: m.timeout,
            });
            const withinStartPeriod = Date.now() - m.startedAt < m.startPeriod;
            if (exitCode === 0) {
                m.consecutiveFailures = 0;
                m.state = "healthy";
            } else {
                m.consecutiveFailures++;
                if (m.state === "healthy") {
                    m.state = "unhealthy";
                } else if (withinStartPeriod) {
                    m.state = "starting";
                } else if (m.consecutiveFailures >= m.retries) {
                    m.state = "unhealthy";
                } else {
                    m.state = "starting";
                }
            }
        } catch (e) {
            m.consecutiveFailures++;
            if (Date.now() - m.startedAt >= m.startPeriod && m.consecutiveFailures >= m.retries) {
                m.state = "unhealthy";
            }
            log.debug("health-monitor", `${m.containerName} check error: ${e instanceof Error ? e.message : e}`);
        } finally {
            m.checking = false;
        }
    }

    getHealth(containerName: string): HealthState | undefined {
        return this.monitored.get(containerName)?.state;
    }

    async waitForHealthy(containerName: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const m = this.monitored.get(containerName);
            if (!m) {
                return false;
            }
            if (m.state === "healthy") {
                return true;
            }
            void this.check(m);
            await new Promise((r) => setTimeout(r, 1000));
        }
        return this.monitored.get(containerName)?.state === "healthy";
    }

    unregister(stackName: string): void {
        for (const [ name, m ] of this.monitored) {
            if (m.stackName === stackName) {
                if (m.timer) {
                    clearInterval(m.timer);
                }
                this.monitored.delete(name);
            }
        }
    }

    unregisterContainer(containerName: string): void {
        const m = this.monitored.get(containerName);
        if (m?.timer) {
            clearInterval(m.timer);
        }
        this.monitored.delete(containerName);
    }
}

export const healthMonitor = new HealthMonitor();
