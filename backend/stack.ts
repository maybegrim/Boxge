import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
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

/**
 * A Boxge stack: one directory containing a compose.yaml. File handling is identical to Dockge;
 * the difference is that every runtime operation now goes through the ContainerStackEngine
 * (Apple's `container` runtime) instead of `docker compose`.
 */
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

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            for (const filename of acceptedComposeFileNames) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = detectPrimaryHostname();
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
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

    /** Unsupported/deferred compose keys for this stack, surfaced in the UI. Empty on parse error. */
    get warnings() : string[] {
        try {
            return parseComposeStack(this.name, this.fullPath, this.composeYAML).warnings;
        } catch (e) {
            return [];
        }
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

    /**
     * Parse this stack's compose.yaml into the engine's ParsedStack model.
     * Throws ValidationError on malformed YAML so the socket layer surfaces it cleanly.
     */
    parse() : ParsedStack {
        try {
            return parseComposeStack(this.name, this.fullPath, this.composeYAML);
        } catch (e) {
            throw new ValidationError(e instanceof Error ? e.message : String(e));
        }
    }

    /**
     * Run a streamed lifecycle operation inside a fresh "compose" virtual terminal that the
     * frontend attaches to. Streams progress, marks completion/failure, and rejects if another
     * operation is already running for this stack.
     */
    protected async runWithComposeTerminal(socket : DockgeSocket, fn : (sink : ProgressSink) => Promise<void>) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        if (Terminal.getTerminal(terminalName)) {
            throw new Error("Another operation is already running for this stack, please wait.");
        }
        const vt = new VirtualTerminal(this.server, terminalName, this.path);
        vt.rows = PROGRESS_TERMINAL_ROWS;
        vt.join(socket);
        vt.start();
        try {
            await fn((chunk) => vt.writeOutput(chunk));
            vt.finish(0);
            return 0;
        } catch (e) {
            vt.writeOutput(`\r\n\x1b[31m[boxge] Failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`);
            vt.finish(1);
            throw e;
        }
    }

    /**
     * Per-service runtime status, reconstructed from the label-filtered container list.
     */
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
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Check YAML format
        yaml.parse(this.composeYAML);

        let lines = this.composeENV.split("\n");

        // Check if the .env is valid
        // It only happens when there is one line and it doesn't contain "="
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

        // if dir is relative, make it absolute
        let fullPathDir;
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        // Write or overwrite the compose.yaml
        fs.writeFileSync(path.join(dir, this._composeFileName), this.composeYAML);
        if (process.env.PUID && process.env.PGID) {
            const uid = Number(process.env.PUID);
            const gid = Number(process.env.PGID);
            fs.lchownSync(dir, uid, gid);
            fs.chownSync(path.join(dir, this._composeFileName), uid, gid);
        }
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.up(parsed, sink));
    }

    async delete(socket: DockgeSocket) : Promise<number> {
        // Tear down the runtime, then always remove the files. Even if teardown fails (e.g. the
        // stack was never deployed), we still delete the directory so the file-based model is
        // never "kidnapped".
        try {
            const parsed = this.parse();
            await this.runWithComposeTerminal(socket, (sink) => containerEngine.down(parsed, { removeNetwork: true }, sink));
        } catch (e) {
            log.warn("delete", "Teardown failed, removing files anyway: " + (e instanceof Error ? e.message : String(e)));
        }

        // Remove the stack folder
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

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
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

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
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

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // Overlay live runtime status from the container runtime (grouped by the boxge.stack label).
        // Replaces Dockge's `docker compose ls` — container has no compose-aggregate, so the engine
        // reconstructs per-stack status from the flat container list.
        try {
            let runtimeStatus = await containerEngine.stackRuntimeStatusMap();
            for (let [ stackName, status ] of runtimeStatus) {
                let stack = stackList.get(stackName);
                if (stack) {
                    stack._status = status;
                }
            }
        } catch (e) {
            if (e instanceof Error) {
                log.warn("getStackList", "Could not read runtime status: " + e.message);
            }
        }

        return stackList;
    }

    /**
     * Get the per-stack runtime status map, used to update stack statuses.
     */
    static async getStatusList() : Promise<Map<string, number>> {
        try {
            return await containerEngine.stackRuntimeStatusMap();
        } catch (e) {
            if (e instanceof Error) {
                log.warn("getStatusList", "Could not read runtime status: " + e.message);
            }
            return new Map<string, number>();
        }
    }

    /**
     * On boot, re-register the health + restart supervisors for every stack that is currently
     * running, so a Boxge restart doesn't drop restart policies or healthchecks on the floor.
     */
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
                const parsed = parseComposeStack(stackName, stack.fullPath, stack.composeYAML);
                containerEngine.registerSupervisors(parsed);
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
                // Really not found
                throw new ValidationError("Stack not found");
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
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

    async start(socket: DockgeSocket) {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.up(parsed, sink));
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.stopStack(parsed, sink));
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.restart(parsed, sink));
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const parsed = this.parse();
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.down(parsed, { removeNetwork: true }, sink));
    }

    async update(socket: DockgeSocket) {
        const parsed = this.parse();
        // pull updated images, then re-up to recreate containers on the new images.
        return this.runWithComposeTerminal(socket, async (sink) => {
            await containerEngine.pull(parsed, sink);
            await containerEngine.up(parsed, sink);
        });
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        let terminal = Terminal.getTerminal(terminalName);

        if (terminal instanceof VirtualTerminal) {
            // Already streaming — just attach this client and replay the scrollback.
            terminal.join(socket);
            return;
        }

        // Stream live logs (`container logs -f` per service) into one combined virtual terminal.
        const vt = new VirtualTerminal(this.server, terminalName, this.path);
        vt.rows = COMBINED_TERMINAL_ROWS;
        vt.cols = COMBINED_TERMINAL_COLS;
        vt.join(socket);
        vt.start(true); // auto-close (and stop the log streams) once every client has left

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
        // Web terminal: `container exec -it <stack>-<service> <shell>` as an interactive pty.
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
                    // The per-container IP is the real reachability address on the container runtime
                    // (host port publishing does not forward to localhost). Surfaced in the UI.
                    ip: svc.ipv4,
                });
            }
            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            return statusList;
        }
    }

    async startService(socket: DockgeSocket, serviceName: string) {
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.startService(this.name, serviceName, sink));
    }

    async stopService(socket: DockgeSocket, serviceName: string): Promise<number> {
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.stopService(this.name, serviceName, sink));
    }

    async restartService(socket: DockgeSocket, serviceName: string): Promise<number> {
        return this.runWithComposeTerminal(socket, (sink) => containerEngine.restartService(this.name, serviceName, sink));
    }
}
