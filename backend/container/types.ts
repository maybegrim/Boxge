export interface RawSystemStatus {
    status: string;
    apiServerAppName: string;
    apiServerBuild: string;
    apiServerCommit: string;
    apiServerVersion: string;
    appRoot: string;
    installRoot: string;
}

export interface RawContainerNetworkStatus {
    network: string;
    hostname?: string;
    ipv4Address?: string;
    ipv4Gateway?: string;
    ipv6Address?: string;
    macAddress?: string;
    mtu?: number;
}

export interface RawPublishedPort {
    containerPort: number;
    hostPort: number;
    hostAddress: string;
    proto: string;
    count?: number;
}

export interface RawContainer {
    id: string;
    configuration: {
        labels: Record<string, string>;
        image: { reference: string; descriptor?: { digest?: string } };
        networks: { network: string; options?: Record<string, unknown> }[];
        publishedPorts: RawPublishedPort[];
        resources?: { cpus?: number; memoryInBytes?: number };
        initProcess?: {
            arguments?: string[];
            executable?: string;
            environment?: string[];
            workingDirectory?: string;
        };
    };
    status: {
        state: string;
        startedDate?: string;
        networks?: RawContainerNetworkStatus[];
    };
}

export interface RawNetwork {
    id: string;
    configuration: {
        name: string;
        mode: string;
        plugin: string;
        labels: Record<string, string>;
        creationDate?: string;
    };
    status: {
        ipv4Gateway?: string;
        ipv4Subnet?: string;
        ipv6Subnet?: string;
    };
}

export interface RawVolume {
    id: string;
    configuration: {
        name: string;
        driver: string;
        format: string;
        labels: Record<string, string>;
        sizeInBytes: number;
        source: string;
    };
}

export interface RawImage {
    id: string;
    configuration: {
        name: string;
        descriptor: { digest: string; mediaType: string; size: number };
    };
    variants?: unknown[];
}

export interface RawStats {
    id: string;
    numProcesses: number;
    cpuUsageUsec: number;
    memoryUsageBytes: number;
    memoryLimitBytes: number;
    blockReadBytes: number;
    blockWriteBytes: number;
    networkRxBytes: number;
    networkTxBytes: number;
}

export interface ServiceStatus {
    service: string;
    containerName: string;
    state: string;
    health?: string;
    ipv4?: string;
    publishedPorts?: RawPublishedPort[];
}

export interface ImageInfo {
    id: string;
    reference: string;
    digest?: string;
    sizeInBytes?: number;
}

export interface VolumeInfo {
    name: string;
    driver: string;
    sizeInBytes: number;
    source: string;
    labels: Record<string, string>;
}

export interface NetworkInfo {
    name: string;
    mode: string;
    ipv4Subnet?: string;
    ipv4Gateway?: string;
    labels: Record<string, string>;
}

export interface StatsSnapshot {
    containerName: string;
    service?: string;
    numProcesses: number;
    cpuUsageUsec: number;
    memoryUsageBytes: number;
    memoryLimitBytes: number;
    networkRxBytes: number;
    networkTxBytes: number;
}

export interface SystemStatus {
    running: boolean;
    version: string;
    raw?: RawSystemStatus;
}

export type ProgressSink = (chunk: string) => void;

export interface TerminalSession {
    write(input: string): void;
    resize(cols: number, rows: number): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (exitCode: number) => void): void;
    close(): void;
}

export interface ParsedService {
    name: string;
    image?: string;
    build?: { context: string; dockerfile?: string };
    command?: string[];
    entrypoint?: string[];
    environment?: Record<string, string>;
    envFiles?: string[];
    ports?: { hostPort?: number; containerPort: number; proto: string }[];
    volumes?: { type: "named" | "bind" | "anonymous"; source?: string; target: string; readonly?: boolean }[];
    workingDir?: string;
    user?: string;
    labels?: Record<string, string>;
    cpus?: number;
    memLimit?: string;
    restart?: "no" | "always" | "on-failure" | "unless-stopped";
    capAdd?: string[];
    capDrop?: string[];
    readOnly?: boolean;
    tmpfs?: string[];
    shmSize?: string;
    dns?: string[];
    dnsSearch?: string[];

    healthcheck?: {
        test: string[];
        interval?: number;
        timeout?: number;
        retries?: number;
        startPeriod?: number;
        disabled?: boolean;
    };
    dependsOn?: { service: string; condition?: string }[];
}

export interface ParsedStack {
    name: string;
    dir: string;
    networkName: string;
    services: ParsedService[];

    dependsOn: Record<string, string[]>;

    warnings: string[];
}

export interface IContainerStackEngine {

    systemStatus(): Promise<SystemStatus>;
    ensureSystemStarted(): Promise<void>;

    up(stack: ParsedStack, onProgress: ProgressSink): Promise<void>;
    down(stack: ParsedStack, opts: { removeNetwork?: boolean }, onProgress: ProgressSink): Promise<void>;
    restart(stack: ParsedStack, onProgress: ProgressSink): Promise<void>;
    pull(stack: ParsedStack, onProgress: ProgressSink): Promise<void>;

    stackStatus(stackName: string): Promise<ServiceStatus[]>;
    listImages(): Promise<ImageInfo[]>;
    listVolumes(): Promise<VolumeInfo[]>;
    listNetworks(): Promise<NetworkInfo[]>;
}
