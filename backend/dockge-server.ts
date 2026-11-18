import "dotenv/config";
import { MainRouter } from "./routers/main-router";
import { LocalApiRouter } from "./routers/local-api-router";
import { LocalApi } from "./local-api";
import * as fs from "node:fs";
import os from "node:os";
import { PackageJson } from "type-fest";
import { Database } from "./database";
import packageJSON from "../package.json";
import { log } from "./log";
import * as socketIO from "socket.io";
import express, { Express } from "express";
import { parse } from "ts-command-line-args";
import https from "https";
import http from "http";
import { Router } from "./router";
import { Socket } from "socket.io";
import { MainSocketHandler } from "./socket-handlers/main-socket-handler";
import { SocketHandler } from "./socket-handler";
import { Settings } from "./settings";
import checkVersion from "./check-version";
import dayjs from "dayjs";
import { R } from "redbean-node";
import { genSecret, isDev, LooseObject } from "../common/util-common";
import { generatePasswordHash } from "./password-hash";
import { Bean } from "redbean-node/dist/bean";
import { Arguments, Config, detectPrimaryHostname, DockgeSocket } from "./util-server";
import { DockerSocketHandler } from "./agent-socket-handlers/docker-socket-handler";
import expressStaticGzip from "express-static-gzip";
import path from "path";
import { TerminalSocketHandler } from "./agent-socket-handlers/terminal-socket-handler";
import { Stack } from "./stack";
import { Cron } from "croner";
import gracefulShutdown from "http-graceful-shutdown";
import User from "./models/user";
import { containerEngine, normalizeDnsDomain, restartSupervisor } from "./container";
import { sampleHostMetrics } from "./host-metrics";
import { AgentManager } from "./agent-manager";
import { AgentProxySocketHandler } from "./socket-handlers/agent-proxy-socket-handler";
import { AgentSocketHandler } from "./agent-socket-handler";
import { AgentSocket } from "../common/agent-socket";
import { ManageAgentSocketHandler } from "./socket-handlers/manage-agent-socket-handler";
import { Terminal } from "./terminal";

function formatBytes(bytes : number) : string {
    if (!bytes || bytes < 0) {
        return "0 B";
    }
    const units = [ "B", "KiB", "MiB", "GiB", "TiB" ];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export class DockgeServer {
    app : Express;
    httpServer : http.Server;
    packageJSON : PackageJson;
    io : socketIO.Server;
    config : Config;
    indexHTML : string = "";

    routerList : Router[] = [
        new LocalApiRouter(),
        new MainRouter(),
    ];

    localApi : LocalApi = new LocalApi();

    socketHandlerList : SocketHandler[] = [
        new MainSocketHandler(),
        new ManageAgentSocketHandler(),
    ];

    agentProxySocketHandler = new AgentProxySocketHandler();

    agentSocketHandlerList : AgentSocketHandler[] = [
        new DockerSocketHandler(),
        new TerminalSocketHandler(),
    ];

    needSetup = false;

    jwtSecret : string = "";

    stacksDir : string = "";

    constructor() {
        let unexpectedErrorHandler = (error : unknown) => {
            console.trace(error);
            console.error("If you keep encountering errors, please report a Boxge issue (forked from Dockge, louislam/dockge).");
        };
        process.addListener("unhandledRejection", unexpectedErrorHandler);
        process.addListener("uncaughtException", unexpectedErrorHandler);

        if (!process.env.NODE_ENV) {
            process.env.NODE_ENV = "production";
        }

        log.info("server", "NODE_ENV: " + process.env.NODE_ENV);

        let defaultStacksDir;
        if (process.platform === "win32") {
            defaultStacksDir = "./stacks";
        } else {
            defaultStacksDir = path.join(os.homedir(), ".boxge", "stacks");
        }

        let args = parse<Arguments>({
            sslKey: {
                type: String,
                optional: true,
            },
            sslCert: {
                type: String,
                optional: true,
            },
            sslKeyPassphrase: {
                type: String,
                optional: true,
            },
            port: {
                type: Number,
                optional: true,
            },
            hostname: {
                type: String,
                optional: true,
            },
            dataDir: {
                type: String,
                optional: true,
            },
            stacksDir: {
                type: String,
                optional: true,
            },
            enableConsole: {
                type: Boolean,
                optional: true,
                defaultValue: false,
            }
        });

        this.config = args as Config;

        const env = (name : string) => process.env[`BOXGE_${name}`] ?? process.env[`DOCKGE_${name}`];
        this.config.sslKey = args.sslKey || env("SSL_KEY") || undefined;
        this.config.sslCert = args.sslCert || env("SSL_CERT") || undefined;
        this.config.sslKeyPassphrase = args.sslKeyPassphrase || env("SSL_KEY_PASSPHRASE") || undefined;
        this.config.port = args.port || Number(env("PORT")) || 5001;
        this.config.hostname = args.hostname || env("HOSTNAME") || undefined;
        this.config.dataDir = args.dataDir || env("DATA_DIR") || "./data/";
        this.config.stacksDir = args.stacksDir || process.env.STACKS_DIR || env("STACKS_DIR") || defaultStacksDir;
        this.config.enableConsole = args.enableConsole || env("ENABLE_CONSOLE") === "true" || false;
        this.stacksDir = this.config.stacksDir;

        log.debug("server", this.config);

        this.packageJSON = packageJSON as PackageJson;

        try {
            this.indexHTML = fs.readFileSync("./frontend-dist/index.html").toString();
        } catch (e) {
            if (process.env.NODE_ENV !== "development") {
                log.error("server", "Error: Cannot find 'frontend-dist/index.html', did you install correctly?");
                process.exit(1);
            }
        }

        this.app = express();

        if (this.config.sslKey && this.config.sslCert) {
            log.info("server", "Server Type: HTTPS");
            this.httpServer = https.createServer({
                key: fs.readFileSync(this.config.sslKey),
                cert: fs.readFileSync(this.config.sslCert),
                passphrase: this.config.sslKeyPassphrase,
            }, this.app);
        } else {
            log.info("server", "Server Type: HTTP");
            this.httpServer = http.createServer(this.app);
        }

        for (const router of this.routerList) {
            this.app.use(router.create(this.app, this));
        }

        this.app.use("/", expressStaticGzip("frontend-dist", {
            enableBrotli: true,
        }));

        this.app.get("*", async (_request, response) => {
            response.send(this.indexHTML);
        });

        let cors = undefined;
        if (isDev) {
            cors = {
                origin: "*",
            };
        }

        this.io = new socketIO.Server(this.httpServer, {
            cors,
            allowRequest: (req, callback) => {
                let isOriginValid = true;
                const bypass = isDev || process.env.UPTIME_KUMA_WS_ORIGIN_CHECK === "bypass";

                if (!bypass) {
                    let host = req.headers.host;

                    let origin = req.headers.origin;

                    if (origin) {
                        try {
                            let originURL = new URL(origin);

                            if (host !== originURL.host) {
                                isOriginValid = false;
                                log.error("auth", `Origin (${origin}) does not match host (${host}), IP: ${req.socket.remoteAddress}`);
                            }
                        } catch (e) {
                            isOriginValid = false;
                            log.error("auth", `Invalid origin url (${origin}), IP: ${req.socket.remoteAddress}`);
                        }
                    } else {
                        log.info("auth", `Origin is not set, IP: ${req.socket.remoteAddress}`);
                    }
                } else {
                    log.debug("auth", "Origin check is bypassed");
                }

                callback(null, isOriginValid);
            }
        });

        this.io.on("connection", async (socket: Socket) => {
            let dockgeSocket = socket as DockgeSocket;
            dockgeSocket.instanceManager = new AgentManager(dockgeSocket);
            dockgeSocket.emitAgent = (event : string, ...args : unknown[]) => {
                let obj = args[0];
                if (typeof(obj) === "object") {
                    let obj2 = obj as LooseObject;
                    obj2.endpoint = dockgeSocket.endpoint;
                }
                dockgeSocket.emit("agent", event, ...args);
            };

            if (typeof(socket.request.headers.endpoint) === "string") {
                dockgeSocket.endpoint = socket.request.headers.endpoint;
            } else {
                dockgeSocket.endpoint = "";
            }

            if (dockgeSocket.endpoint) {
                log.info("server", "Socket connected (agent), as endpoint " + dockgeSocket.endpoint);
            } else {
                log.info("server", "Socket connected (direct)");
            }

            this.sendInfo(dockgeSocket, true);

            if (this.needSetup) {
                log.info("server", "Redirect to setup page");
                dockgeSocket.emit("setup");
            }

            for (const socketHandler of this.socketHandlerList) {
                socketHandler.create(dockgeSocket, this);
            }

            let agentSocket = new AgentSocket();

            for (const socketHandler of this.agentSocketHandlerList) {
                socketHandler.create(dockgeSocket, this, agentSocket);
            }

            this.agentProxySocketHandler.create2(dockgeSocket, this, agentSocket);

            log.debug("auth", "check auto login");
            if (await Settings.get("disableAuth")) {
                log.info("auth", "Disabled Auth: auto login to admin");
                this.afterLogin(dockgeSocket, await R.findOne("user") as User);
                dockgeSocket.emit("autoLogin");
            } else {
                log.debug("auth", "need auth");
            }

            dockgeSocket.on("disconnect", () => {
                log.info("server", "Socket disconnected!");
                dockgeSocket.instanceManager.disconnectAll();
            });

        });

        this.io.on("disconnect", () => {
        });

        if (isDev) {
            setInterval(() => {
                log.debug("terminal", "Terminal count: " + Terminal.getTerminalCount());
            }, 5000);
        }
    }

    async afterLogin(socket : DockgeSocket, user : User) {
        socket.userID = user.id;
        socket.join(user.id.toString());

        this.sendInfo(socket);
        this.sendSystemStatus(socket);

        try {
            this.sendStackList();
        } catch (e) {
            log.error("server", e);
        }

        socket.instanceManager.sendAgentList();

        socket.instanceManager.connectAll();
    }

    async serve() {
        this.initDataDir();
        restartSupervisor.setStateFile(path.join(this.config.dataDir, "supervisor-state.json"));

        if (process.env.BOXGE_SKIP_RUNTIME_START !== "1") {
            try {
                if (await containerEngine.ensureSystemStarted()) {
                    log.info("server", "Started the Apple container runtime.");
                }
            } catch (e) {
                log.error("server", "Could not start the Apple container runtime: " + (e instanceof Error ? e.message : String(e)));
            }
        }

        try {
            const status = await containerEngine.systemStatus();
            if (status.running) {
                log.info("server", `Apple container runtime ${status.version} is running.`);
            } else {
                log.warn("server", `Apple container runtime ${status.version} is not running. ` +
                    "Start it with `container system start`.");
            }
        } catch (e) {
            log.error("server", "Could not reach the Apple container runtime. Is it installed? " +
                "See https://github.com/apple/container");
        }

        await Stack.reconcileSupervisors(this);

        try {
            await Database.init(this);
        } catch (e) {
            if (e instanceof Error) {
                log.error("server", "Failed to prepare your database: " + e.message);
            }
            process.exit(1);
        }

        let jwtSecretBean = await R.findOne("setting", " `key` = ? ", [
            "jwtSecret",
        ]);

        if (! jwtSecretBean) {
            log.info("server", "JWT secret is not found, generate one.");
            jwtSecretBean = await this.initJWTSecret();
            log.info("server", "Stored JWT secret into database");
        } else {
            log.debug("server", "Load JWT secret from database.");
        }

        this.jwtSecret = jwtSecretBean.value;

        await this.reloadServiceDns();

        const userCount = (await R.knex("user").count("id as count").first()).count;

        log.debug("server", "User count: " + userCount);

        if (userCount == 0) {
            log.info("server", "No user, need setup");
            this.needSetup = true;
        }

        this.httpServer.listen(this.config.port, this.config.hostname, () => {
            if (this.config.hostname) {
                log.info( "server", `Listening on ${this.config.hostname}:${this.config.port}`);
            } else {
                log.info("server", `Listening on ${this.config.port}`);
            }
            void this.localApi.publish(this.getLocalHttpURL(), String(this.packageJSON.version));

            Cron("*/10 * * * * *", {
                protect: true,
            }, () => {
                this.sendStackList(true);
                this.sendSystemStatus();
                void this.localApi.ensurePublished();
            });

            checkVersion.startInterval();
        });

        gracefulShutdown(this.httpServer, {
            signals: "SIGINT SIGTERM",
            timeout: 30000,
            development: false,
            forceExit: true,
            onShutdown: async (signal : string | undefined) => {
                this.localApi.unpublish();
                await this.shutdownFunction(signal);
            },
            finally: this.finalFunction,
        });

    }

    async sendInfo(socket : Socket, hideVersion = false) {
        let versionProperty;
        let latestVersionProperty;
        let isContainer;

        if (!hideVersion) {
            versionProperty = packageJSON.version;
            latestVersionProperty = checkVersion.latestVersion;
            isContainer = (process.env.DOCKGE_IS_CONTAINER === "1");
        }

        socket.emit("info", {
            version: versionProperty,
            latestVersion: latestVersionProperty,
            isContainer,
            primaryHostname: await Settings.get("primaryHostname") || detectPrimaryHostname(),
        });
    }

    async getClientIP(socket : Socket) : Promise<string> {
        let clientIP = socket.client.conn.remoteAddress;

        if (clientIP === undefined) {
            clientIP = "";
        }

        if (await Settings.get("trustProxy")) {
            const forwardedFor = socket.client.conn.request.headers["x-forwarded-for"];

            if (typeof forwardedFor === "string") {
                return forwardedFor.split(",")[0].trim();
            } else if (typeof socket.client.conn.request.headers["x-real-ip"] === "string") {
                return socket.client.conn.request.headers["x-real-ip"];
            }
        }
        return clientIP.replace(/^::ffff:/, "");
    }

    async getTimezone() {
        try {
            if (process.env.TZ) {
                this.checkTimezone(process.env.TZ);
                return process.env.TZ;
            }
        } catch (e) {
            if (e instanceof Error) {
                log.warn("timezone", e.message + " in process.env.TZ");
            }
        }

        const timezone = await Settings.get("serverTimezone");

        try {
            log.debug("timezone", "Using timezone from settings: " + timezone);
            if (timezone) {
                this.checkTimezone(timezone);
                return timezone;
            }
        } catch (e) {
            if (e instanceof Error) {
                log.warn("timezone", e.message + " in settings");
            }
        }

        try {
            const guess = dayjs.tz.guess();
            log.debug("timezone", "Guessing timezone: " + guess);
            if (guess) {
                this.checkTimezone(guess);
                return guess;
            } else {
                return "UTC";
            }
        } catch (e) {
            log.debug("timezone", "Guessed an invalid timezone. Use UTC as fallback");
            return "UTC";
        }
    }

    getTimezoneOffset() {
        return dayjs().format("Z");
    }

    checkTimezone(timezone : string) {
        try {
            dayjs.utc("2013-11-18 11:55").tz(timezone).format();
        } catch (e) {
            throw new Error("Invalid timezone:" + timezone);
        }
    }

    initDataDir() {
        if (! fs.existsSync(this.config.dataDir)) {
            fs.mkdirSync(this.config.dataDir, { recursive: true });
        }

        if (!fs.lstatSync(this.config.dataDir).isDirectory()) {
            throw new Error(`Fatal error: ${this.config.dataDir} is not a directory`);
        }

        if (!fs.existsSync(this.stacksDir)) {
            fs.mkdirSync(this.stacksDir, { recursive: true });
        }

        log.info("server", `Data Dir: ${this.config.dataDir}`);
    }

    async initJWTSecret() : Promise<Bean> {
        let jwtSecretBean = await R.findOne("setting", " `key` = ? ", [
            "jwtSecret",
        ]);

        if (!jwtSecretBean) {
            jwtSecretBean = R.dispense("setting");
            jwtSecretBean.key = "jwtSecret";
        }

        jwtSecretBean.value = generatePasswordHash(genSecret());
        await R.store(jwtSecretBean);
        return jwtSecretBean;
    }

    async sendStackList(useCache = false) {
        let socketList = this.io.sockets.sockets.values();

        let stackList;

        for (let socket of socketList) {
            let dockgeSocket = socket as DockgeSocket;

            if (dockgeSocket.userID) {

                if (!stackList) {
                    stackList = await Stack.getStackList(this, useCache);
                }

                let map : Map<string, object> = new Map();

                for (let [ stackName, stack ] of stackList) {
                    map.set(stackName, stack.toSimpleJSON(dockgeSocket.endpoint));
                }

                log.debug("server", "Send stack list to user: " + dockgeSocket.id + " (" + dockgeSocket.endpoint + ")");
                dockgeSocket.emitAgent("stackList", {
                    ok: true,
                    stackList: Object.fromEntries(map),
                });
            }
        }
    }

    async reloadServiceDns() {
        try {
            Stack.serviceDnsDomain = normalizeDnsDomain(await Settings.get("serviceDnsDomain"));
        } catch (e) {
            Stack.serviceDnsDomain = "";
            log.warn("server", "Ignoring the service DNS domain setting: " + (e instanceof Error ? e.message : String(e)));
        }
    }

    async sendSystemStatus(socket? : DockgeSocket) {
        const status = await containerEngine.systemStatus();
        const serviceDnsDomain = Stack.serviceDnsDomain;
        const payload = {
            serviceDnsDomain,
            serviceDnsRegistered: serviceDnsDomain !== "" && status.running
                ? await containerEngine.isDnsDomainRegistered(serviceDnsDomain)
                : false,
            runtimeRunning: status.running,
            runtimeVersion: status.version,
            runtimeSupported: status.supported,
            runtimeMinVersion: status.minVersion,
            host: sampleHostMetrics(),
        };

        if (socket) {
            socket.emit("systemStatus", payload);
            return;
        }

        for (const rawSocket of this.io.sockets.sockets.values()) {
            const dockgeSocket = rawSocket as DockgeSocket;
            if (dockgeSocket.userID) {
                dockgeSocket.emit("systemStatus", payload);
            }
        }
    }

    async getDockerNetworkList() : Promise<string[]> {
        try {
            return await containerEngine.networkNames();
        } catch (e) {
            if (e instanceof Error) {
                log.error("getDockerNetworkList", e.message);
            }
            return [];
        }
    }

    async getDockerStats() : Promise<Map<string, object>> {
        let stats = new Map<string, object>();

        try {
            const snapshots = await containerEngine.allStats();
            for (const s of snapshots) {
                const memPerc = s.memoryLimitBytes > 0
                    ? ((s.memoryUsageBytes / s.memoryLimitBytes) * 100).toFixed(2) + "%"
                    : "-";

                const cpuPerc = typeof s.cpuUtilization === "number"
                    ? (s.cpuUtilization * 100).toFixed(2) + "%"
                    : "-";

                stats.set(s.containerName, {
                    Name: s.containerName,
                    CPUPerc: cpuPerc,
                    MemUsage: `${formatBytes(s.memoryUsageBytes)} / ${formatBytes(s.memoryLimitBytes)}`,
                    MemPerc: memPerc,
                });
            }
            return stats;
        } catch (e) {
            log.error("getDockerStats", e);
            return stats;
        }
    }

    get stackDirFullPath() {
        return path.resolve(this.stacksDir);
    }

    async shutdownFunction(signal : string | undefined) {
        log.info("server", "Shutdown requested");
        log.info("server", "Called signal: " + signal);

        await Database.close();
        Settings.stopCacheCleaner();
    }

    finalFunction() {
        log.info("server", "Graceful shutdown successful!");
    }

    disconnectAllSocketClients(userID: number | undefined, currentSocketID? : string) {
        for (const rawSocket of this.io.sockets.sockets.values()) {
            let socket = rawSocket as DockgeSocket;
            if ((!userID || socket.userID === userID) && socket.id !== currentSocketID) {
                try {
                    socket.emit("refresh");
                    socket.disconnect();
                } catch (e) {
                }
            }
        }
    }

    isSSL() {
        return this.config.sslKey && this.config.sslCert;
    }

    getLocalHttpURL() {
        const protocol = this.isSSL() ? "https" : "http";
        const bound = this.config.hostname;
        const host = !bound || bound === "0.0.0.0" || bound === "::" ? "127.0.0.1" : bound;
        return `${protocol}://${host}:${this.config.port}`;
    }

    getLocalWebSocketURL() {
        const protocol = this.isSSL() ? "wss" : "ws";
        const host = this.config.hostname || "localhost";
        return `${protocol}://${host}:${this.config.port}`;
    }

}
