import { log } from "../log";
import { listAllContainers, runContainerCmd } from "./container-cli";
import type { ParsedService } from "./types";

export type HealthState = "starting" | "healthy" | "unhealthy";

interface Monitored {
    containerName: string;
    stackName: string;
    signature: string;
    test: string[];
    interval: number;
    timeout: number;
    retries: number;
    startPeriod: number;
    startedAt: number;
    consecutiveFailures: number;
    state: HealthState;
    running: boolean;
    timer?: NodeJS.Timeout;
    firstCheck?: NodeJS.Timeout;
    checking: boolean;
}

const DEFAULT_INTERVAL = 30_000;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const FIRST_CHECK_DELAY = 1500;

class HealthMonitor {
    private monitored = new Map<string, Monitored>();

    register(stackName: string, containerName: string, healthcheck: ParsedService["healthcheck"]): void {
        if (!healthcheck || healthcheck.disabled || healthcheck.test.length === 0) {
            this.unregisterContainer(containerName);
            return;
        }
        const signature = JSON.stringify(healthcheck);
        if (this.monitored.get(containerName)?.signature === signature) {
            return;
        }
        this.unregisterContainer(containerName);

        const m: Monitored = {
            containerName,
            stackName,
            signature,
            test: healthcheck.test,
            interval: healthcheck.interval ?? DEFAULT_INTERVAL,
            timeout: healthcheck.timeout ?? DEFAULT_TIMEOUT,
            retries: healthcheck.retries ?? DEFAULT_RETRIES,
            startPeriod: healthcheck.startPeriod ?? 0,
            startedAt: Date.now(),
            consecutiveFailures: 0,
            state: "starting",
            running: false,
            checking: false,
        };
        this.monitored.set(containerName, m);
        m.timer = setInterval(() => void this.check(m), m.interval);
        m.timer.unref();
        m.firstCheck = setTimeout(() => void this.check(m), FIRST_CHECK_DELAY);
        m.firstCheck.unref();
        log.debug("health-monitor", `monitoring ${containerName} (interval ${m.interval}ms)`);
    }

    reset(containerName: string): void {
        const m = this.monitored.get(containerName);
        if (m) {
            m.running = false;
            m.state = "starting";
            m.consecutiveFailures = 0;
            if (m.firstCheck) {
                clearTimeout(m.firstCheck);
            }
            m.firstCheck = setTimeout(() => void this.check(m), FIRST_CHECK_DELAY);
            m.firstCheck.unref();
        }
    }

    private async isRunning(containerName: string): Promise<boolean> {
        try {
            const containers = await listAllContainers();
            return containers.find((c) => c.id === containerName)?.status?.state === "running";
        } catch {
            return false;
        }
    }

    private async check(m: Monitored): Promise<void> {
        if (m.checking || this.monitored.get(m.containerName) !== m) {
            return;
        }
        m.checking = true;
        try {
            const running = await this.isRunning(m.containerName);
            if (!running) {
                m.running = false;
                m.state = "starting";
                m.consecutiveFailures = 0;
                return;
            }
            if (!m.running) {
                m.running = true;
                m.startedAt = Date.now();
            }

            const { exitCode } = await runContainerCmd([ "exec", m.containerName, ...m.test ], {
                timeoutMs: m.timeout,
            });
            if (exitCode === 0) {
                m.consecutiveFailures = 0;
                m.state = "healthy";
                return;
            }
            m.consecutiveFailures++;
            const withinStartPeriod = Date.now() - m.startedAt < m.startPeriod;
            if (m.state === "healthy" || (!withinStartPeriod && m.consecutiveFailures >= m.retries)) {
                m.state = "unhealthy";
            }
        } catch (e) {
            log.debug("health-monitor", `${m.containerName} check error: ${e instanceof Error ? e.message : e}`);
        } finally {
            m.checking = false;
        }
    }

    isMonitored(containerName: string): boolean {
        return this.monitored.has(containerName);
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

    private dispose(m: Monitored): void {
        if (m.timer) {
            clearInterval(m.timer);
        }
        if (m.firstCheck) {
            clearTimeout(m.firstCheck);
        }
        this.monitored.delete(m.containerName);
    }

    unregister(stackName: string): void {
        for (const m of [ ...this.monitored.values() ]) {
            if (m.stackName === stackName) {
                this.dispose(m);
            }
        }
    }

    unregisterContainer(containerName: string): void {
        const m = this.monitored.get(containerName);
        if (m) {
            this.dispose(m);
        }
    }
}

export const healthMonitor = new HealthMonitor();
