import os from "node:os";

let prevCpu : { idle : number; total : number } | null = null;

function cpuTotals() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
        idle += c.times.idle;
        total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    return { idle,
        total };
}

export interface HostMetrics {
    cpuPercent : number;
    memUsedBytes : number;
    memTotalBytes : number;
    uptimeSeconds : number;
}

export function sampleHostMetrics() : HostMetrics {
    const now = cpuTotals();
    let cpuPercent = 0;
    if (prevCpu) {
        const idleDelta = now.idle - prevCpu.idle;
        const totalDelta = now.total - prevCpu.total;
        if (totalDelta > 0) {
            cpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
        }
    }
    prevCpu = now;

    const memTotalBytes = os.totalmem();
    const memUsedBytes = memTotalBytes - os.freemem();

    return {
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memUsedBytes,
        memTotalBytes,
        uptimeSeconds: Math.round(os.uptime()),
    };
}
