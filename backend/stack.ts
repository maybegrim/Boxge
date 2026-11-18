import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import dotenv from "dotenv";
import { detectPrimaryHostname, DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    getCombinedTerminalName,
    getComposeTerminalName,
    getContainerExecTerminalName,
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal, VirtualTerminal } from "./terminal";
import { Settings } from "./settings";
import {
    CONTAINER_BIN,
    containerEngine,
    parseComposeStack,
    type ParsedStack,
    type ProgressSink,
} from "./container";

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    protected static lastErrors: Map<string, string> = new Map();

    protected static lastOutputs: Map<string, string> = new Map();

    protected static readonly OUTPUT_LIMIT = 256 * 1024;

    static serviceDnsDomain = "";

    protected static runtimeUnreachable = false;

    protected static noteRuntimeStatus(error? : unknown) : void {
        if (error === undefined) {
            if (Stack.runtimeUnreachable) {
                Stack.runtimeUnreachable = false;
                log.info("stack", "The container runtime is answering again.");
            }
            return;
        }
        if (!Stack.runtimeUnreachable) {
            Stack.runtimeUnreachable = true;
            log.warn("stack", "Could not read runtime status; is the container runtime stopped? " +
                (error instanceof Error ? error.message : String(error)));
        }
    }

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (!skipFSOperations) {
            for (const filename of acceptedComposeFileNames) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = detectPrimaryHostname();
            } else {
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
            warnings: this.warnings,
        };
    }

    get warnings() : string[] {
        try {
            return parseComposeStack(this.name, this.fullPath, this.composeYAML, this.interpolationEnv(), { dnsDomain: Stack.serviceDnsDomain }).warnings;
        } catch (e) {
            return [];
        }
    }

    interpolationEnv() : Record<string, string | undefined> {
        let globalEnv : Record<string, string> = {};
        try {
            globalEnv = dotenv.parse(fs.readFileSync(path.join(this.server.stacksDir, "global.env")));
        } catch (e) {
            globalEnv = {};
        }
        return {
            ...process.env,
            ...globalEnv,
            ...dotenv.parse(this.composeENV),
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
        };
    }

    parse() : ParsedStack {
        try {
            return parseComposeStack(this.name, this.fullPath, this.composeYAML, this.interpolationEnv(), { dnsDomain: Stack.serviceDnsDomain });
        } catch (e) {
            throw new ValidationError(e instanceof Error ? e.message : String(e));
        }
    }

    protected async runWithComposeTerminal(socket : DockgeSocket | undefined, fn : (sink : ProgressSink) => Promise<void>) : Promise<number> {
        const terminalName = getComposeTerminalName(socket?.endpoint ?? "", this.name);
        if (Terminal.getTerminal(terminalName)) {
            throw new Error("Another operation is already running for this stack, please wait.");
        }
        const vt = new VirtualTerminal(this.server, terminalName, this.path);
        vt.rows = PROGRESS_TERMINAL_ROWS;
        if (socket) {
            vt.join(socket);
        }
        vt.start();
        let output = "";
        const record = (chunk : string) => {
            output = (output + chunk).slice(-Stack.OUTPUT_LIMIT);
            Stack.lastOutputs.set(this.name, output);
            vt.writeOutput(chunk);
        };
        Stack.lastOutputs.set(this.name, "");
        try {
            await fn(record);
            Stack.lastErrors.delete(this.name);
            vt.finish(0);
            return 0;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            Stack.lastErrors.set(this.name, message);
            record(`\r\n\x1b[31m[boxge] Failed: ${message}\x1b[0m\r\n`);
            vt.finish(1);
            throw e;
        }
    }

    static isBusy(stackName : string, endpoint = "") : boolean {
        return Terminal.getTerminal(getComposeTerminalName(endpoint, stackName)) !== undefined;
    }

    static lastError(stackName : string) : string | undefined {
        return Stack.lastErrors.get(stackName);
    }

    static lastOutput(stackName : string) : string {
        return Stack.lastOutputs.get(stackName) ?? "";
    }

    static forget(stackName : string) : void {
        Stack.lastErrors.delete(stackName);
        Stack.lastOutputs.delete(stackName);
    }

    async ps() : Promise<object> {
        return containerEngine.stackStatus(this.name);
    }

    get isManagedByDockge() : boolean {
        return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
    }

    get status() : number {
        return this._status;
    }

    validate() {
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        yaml.parse(this.composeYAML);

        let lines = this.composeENV.split("\n");

        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                this._composeYAML = fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, ".env"), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get path() : string {
        return path.join(this.server.stacksDir, this.name);
    }

    get fullPath() : string {
        let dir = this.path;

        let fullPathDir;
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        fs.writeFileSync(path.join(dir, this._composeFileName), this.composeYAML);

        const envPath = path.join(dir, ".env");
        if (await fileExists(envPath) || this.composeENV.trim() !== "") {
            fs.writeFileSync(envPath, this.composeENV);
        }
        if (process.env.PUID && process.env.PGID) {
            const uid = Number(process.env.PUID);
            const gid = Number(process.env.PGID);
            fs.lchownSync(dir, uid, gid);
            fs.chownSync(path.join(dir, this._composeFileName), uid, gid);
        }
    }

    async deploy(socket? : DockgeSocket) : Promise<number> {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.up(parsed, sink));
    }

    async delete(socket?: DockgeSocket) : Promise<number> {
        try {
            const parsed = this.parse();
            await this.runWithComposeTerminal(socket, (sink) => containerEngine.down(parsed, { removeNetwork: true }, sink));
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const leftovers = await containerEngine.containersForStack(this.name).catch(() => []);
            if (leftovers.length > 0) {
                throw new Error(`Teardown failed, so the stack files were kept: ${message}`);
            }
            log.warn("delete", "Teardown reported a problem but no containers remain, removing files: " + message);
        }
        Stack.forget(this.name);

        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        return 0;
    }

    async updateStatus() {
        let statusList = await Stack.getStatusList();
        let status = statusList.get(this.name);

        if (status) {
            this._status = status;
        } else {
            this._status = UNKNOWN;
        }
    }

    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            this.managedStackList = new Map(stackList);
        }

        try {
            let runtimeStatus = await containerEngine.stackRuntimeStatusMap();
            for (let [ stackName, status ] of runtimeStatus) {
                let stack = stackList.get(stackName);
                if (stack) {
                    stack._status = status;
                }
            }
            Stack.noteRuntimeStatus();
        } catch (e) {
            Stack.noteRuntimeStatus(e);
        }

        return stackList;
    }

    static async getStatusList() : Promise<Map<string, number>> {
        try {
            const statusMap = await containerEngine.stackRuntimeStatusMap();
            Stack.noteRuntimeStatus();
            return statusMap;
        } catch (e) {
            Stack.noteRuntimeStatus(e);
            return new Map<string, number>();
        }
    }

    static async reconcileSupervisors(server : DockgeServer) : Promise<void> {
        let runtime : Map<string, number>;
        try {
            runtime = await containerEngine.stackRuntimeStatusMap();
        } catch (e) {
            log.warn("reconcile", "Could not list running stacks: " + (e instanceof Error ? e.message : String(e)));
            return;
        }

        for (const stackName of runtime.keys()) {
            try {
                const stack = await Stack.getStack(server, stackName);
                containerEngine.registerSupervisors(stack.parse());
                log.info("reconcile", `Resumed supervisors for running stack '${stackName}'`);
            } catch (e) {
                log.warn("reconcile", `Could not resume supervisors for '${stackName}': ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        let dir = path.join(server.stacksDir, stackName);

        if (!skipFSOperations) {
            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                throw new ValidationError("Stack not found");
            }
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);
        return stack;
    }

    async start(socket?: DockgeSocket) {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.up(parsed, sink));
    }

    async stop(socket?: DockgeSocket) : Promise<number> {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.stopStack(parsed, sink));
    }

    async restart(socket?: DockgeSocket) : Promise<number> {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.restart(parsed, sink));
    }

    async down(socket?: DockgeSocket) : Promise<number> {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.down(parsed, { removeNetwork: true }, sink));
    }

    async clean(socket?: DockgeSocket) : Promise<number> {
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.cleanStack(this.name, sink));
    }

    async update(socket?: DockgeSocket) {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, async (sink) => {
            await containerEngine.pull(parsed, sink);
            await containerEngine.up(parsed, sink);
        });
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        let terminal = Terminal.getTerminal(terminalName);

        if (terminal instanceof VirtualTerminal) {
            terminal.join(socket);
            return;
        }

        const vt = new VirtualTerminal(this.server, terminalName, this.path);
        vt.rows = COMBINED_TERMINAL_ROWS;
        vt.cols = COMBINED_TERMINAL_COLS;
        vt.join(socket);
        vt.start(true);

        const handle = await containerEngine.streamStackLogs(this.name, (data) => vt.writeOutput(data));
        vt.onFinish(() => handle.stop());
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            const containerName = `${this.name}-${serviceName}`;
            terminal = new InteractiveTerminal(this.server, terminalName, CONTAINER_BIN, [ "exec", "-it", containerName, shell ], this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", `exec into ${containerName} (${shell})`);
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList() {
        let statusList = new Map<string, Array<object>>();

        try {
            const services = await containerEngine.stackStatus(this.name);
            for (const svc of services) {
                if (!statusList.has(svc.service)) {
                    statusList.set(svc.service, []);
                }
                statusList.get(svc.service)?.push({
                    status: svc.health || svc.state,
                    name: svc.containerName,
                    ip: svc.ipv4,
                });
            }
            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            return statusList;
        }
    }

    async startService(socket: DockgeSocket | undefined, serviceName: string) {
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.startService(this.name, serviceName, sink));
    }

    async stopService(socket: DockgeSocket | undefined, serviceName: string): Promise<number> {
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.stopService(this.name, serviceName, sink));
    }

    async restartService(socket: DockgeSocket | undefined, serviceName: string): Promise<number> {
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.restartService(this.name, serviceName, sink));
    }
}
