import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { api, BoxgeError } from "./client";

const INSTRUCTIONS = [
    "Boxge manages compose-style stacks on this Mac using Apple's container runtime.",
    "A stack is a folder with a compose.yaml and an optional .env. Each service becomes one container named <stack>-<service>.",
    "Typical flow: status, then stack_validate to dry-run a compose file, stack_save to write it (deploy: true to bring it up), then status, stack_get and logs to check the result.",
    "Not every Compose key is supported. stack_validate and stack_save return warnings for the ones that are ignored, and the container run command each service turns into.",
    "Values in .env files are hidden unless you ask for them. To change one variable, use stack_env_set instead of rewriting the whole file.",
    "Published ports bind on the Mac: '8080:80' is reachable from the local network, '127.0.0.1:8080:80' only from this Mac.",
].join(" ");

const stackName = z.string().regex(/^[a-z0-9_-]+$/).describe("Stack name: lowercase letters, digits, _ and - only.");
const serviceName = z.string().describe("Service name as written in the compose file.");
const envChange = {
    set: z.record(z.string(), z.string()).optional().describe("Variables to add or replace, as name to value."),
    unset: z.array(z.string()).optional().describe("Variable names to remove."),
};

type ToolResult = { content : { type : "text"; text : string }[]; isError? : boolean };

async function run(fn : () => Promise<unknown>) : Promise<ToolResult> {
    try {
        const result = await fn();
        return { content: [{ type: "text",
            text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
        const detail = e instanceof BoxgeError && e.body ? { ...e.body } : {};
        return {
            isError: true,
            content: [{ type: "text",
                text: JSON.stringify({ ...detail,
                    ok: false,
                    msg: e instanceof Error ? e.message : String(e) }, null, 2) }],
        };
    }
}

export async function runMcpServer(version : string) : Promise<void> {
    const server = new McpServer({ name: "boxge",
        version }, { instructions: INSTRUCTIONS });

    const readOnly = { readOnlyHint: true,
        openWorldHint: false };
    const changes = { readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false };
    const destructive = { readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false };

    server.registerTool("status", {
        description: "Overview: Boxge and runtime versions, whether the runtime is running, the stacks folder, and every stack with its state and services.",
        inputSchema: {},
        annotations: readOnly,
    }, () => run(() => api.status()));

    server.registerTool("stack_get", {
        description: "One stack in detail: compose.yaml, .env variable names, warnings, and each service's state, health, IP, DNS name and published ports.",
        inputSchema: {
            name: stackName,
            revealEnvValues: z.boolean().optional().describe("Include the values of .env variables. Leave off unless the values are needed; they may be secrets."),
        },
        annotations: readOnly,
    }, ({ name, revealEnvValues }) => run(() => api.stack(name, revealEnvValues === true)));

    server.registerTool("stack_validate", {
        description: "Dry run. Parses a compose file without saving or starting anything, and returns warnings plus the exact container command each service would run.",
        inputSchema: {
            composeYAML: z.string().describe("Full contents of the compose file."),
            composeENV: z.string().optional().describe("Contents of the .env file used for ${VAR} substitution."),
            name: stackName.optional(),
        },
        annotations: readOnly,
    }, ({ composeYAML, composeENV, name }) => run(() => api.validate(composeYAML, composeENV, name)));

    server.registerTool("stack_save", {
        description: "Create a stack or replace an existing stack's compose file. With deploy: true it also brings the stack up and returns the deploy output; only services whose configuration or image changed are recreated.",
        inputSchema: {
            name: stackName,
            composeYAML: z.string().describe("Full contents of the compose file."),
            composeENV: z.string().optional().describe("Full contents of the .env file. Omit to leave the existing .env untouched."),
            deploy: z.boolean().optional().describe("Bring the stack up after saving. Default false."),
        },
        annotations: changes,
    }, ({ name, composeYAML, composeENV, deploy }) => run(() => api.saveStack(name, composeYAML, composeENV, deploy === true)));

    server.registerTool("stack_env_set", {
        description: "Add, replace or remove single variables in a stack's .env without reading or rewriting the rest. Redeploy the stack afterwards for the change to reach its containers.",
        inputSchema: { name: stackName,
            ...envChange },
        annotations: changes,
    }, ({ name, set, unset }) => run(() => api.setStackEnv(name, { set,
        unset })));

    server.registerTool("stack_action", {
        description: "Run a lifecycle action on a stack and wait for it: deploy or start (bring up, pulling or building as needed), stop (stop containers, keep them), restart, update (pull images then redeploy), down (remove containers and the stack networks; named volumes and files are kept), clean (return disk space freed inside running containers to the Mac).",
        inputSchema: {
            name: stackName,
            action: z.enum([ "deploy", "start", "stop", "restart", "update", "down", "clean" ]),
        },
        annotations: changes,
    }, ({ name, action }) => run(() => api.stackAction(name, action)));

    server.registerTool("service_action", {
        description: "Start, stop or restart one service of a deployed stack.",
        inputSchema: {
            stack: stackName,
            service: serviceName,
            action: z.enum([ "start", "stop", "restart" ]),
        },
        annotations: changes,
    }, ({ stack, service, action }) => run(() => api.serviceAction(stack, service, action)));

    server.registerTool("stack_delete", {
        description: "Remove a stack: its containers, its network and its whole folder, including any files stored in that folder. Named volumes are kept. This cannot be undone.",
        inputSchema: {
            name: stackName,
            confirm: z.string().describe("Repeat the stack name exactly to confirm."),
        },
        annotations: destructive,
    }, ({ name, confirm }) => run(async () => {
        if (confirm !== name) {
            throw new BoxgeError("confirm must equal the stack name.");
        }
        return api.deleteStack(name);
    }));

    server.registerTool("logs", {
        description: "Recent log lines from a stack's containers.",
        inputSchema: {
            stack: stackName,
            service: serviceName.optional().describe("Limit to one service. Omit for all services."),
            tail: z.number().int().min(1).max(5000).optional().describe("Lines per service from the end. Default 200."),
        },
        annotations: readOnly,
    }, ({ stack, service, tail }) => run(() => api.logs(stack, service, tail)));

    server.registerTool("exec", {
        description: "Run a command inside a running service container and return its exit code and output. The command is an argument list, not a shell string; use [\"sh\", \"-c\", \"...\"] for shell syntax.",
        inputSchema: {
            stack: stackName,
            service: serviceName,
            command: z.array(z.string()).min(1).describe("Program and arguments."),
            timeoutSeconds: z.number().int().min(1).max(600).optional().describe("Default 60."),
        },
        annotations: changes,
    }, ({ stack, service, command, timeoutSeconds }) => run(() => api.exec(stack, service, command, timeoutSeconds)));

    server.registerTool("resources", {
        description: "List images, volumes or networks known to the container runtime.",
        inputSchema: { kind: z.enum([ "images", "volumes", "networks" ]) },
        annotations: readOnly,
    }, ({ kind }) => run(() => api.resources(kind)));

    server.registerTool("stats", {
        description: "CPU and memory use of every running Boxge container. cpuUtilization is a fraction of one core.",
        inputSchema: {},
        annotations: readOnly,
    }, () => run(() => api.stats()));

    server.registerTool("disk_usage", {
        description: "Disk space used by images, containers and volumes, and how much of it could be reclaimed.",
        inputSchema: {},
        annotations: readOnly,
    }, () => run(() => api.disk()));

    server.registerTool("settings_get", {
        description: "Boxge settings: the service DNS domain and whether macOS knows it, the primary hostname used for links, and the names of global environment variables shared by all stacks.",
        inputSchema: {
            revealEnvValues: z.boolean().optional().describe("Include global variable values. Leave off unless needed."),
        },
        annotations: readOnly,
    }, ({ revealEnvValues }) => run(() => api.settings(revealEnvValues === true)));

    server.registerTool("settings_set", {
        description: "Change Boxge settings. serviceDnsDomain turns per-service DNS names on (empty string turns it off); stacks need a redeploy to pick it up, and the domain must be registered once by the user with: sudo container system dns create <domain>.",
        inputSchema: {
            serviceDnsDomain: z.string().optional(),
            primaryHostname: z.string().optional(),
            globalEnv: z.object(envChange).optional().describe("Changes to the global variables shared by all stacks."),
        },
        annotations: changes,
    }, (change) => run(() => api.setSettings(change)));

    server.registerTool("runtime_start", {
        description: "Start Apple's container runtime if it is stopped.",
        inputSchema: {},
        annotations: changes,
    }, () => run(() => api.startRuntime()));

    server.registerTool("stop_all", {
        description: "Stop every running container on this Mac, including ones Boxge did not create. Containers are kept and stay stopped until started again.",
        inputSchema: {},
        annotations: destructive,
    }, () => run(() => api.stopAll()));

    server.registerTool("runtime_stop", {
        description: "Stop Apple's container runtime. Every container stops. When the runtime is started again, services with a restart policy come back up unless they were stopped by hand.",
        inputSchema: {},
        annotations: destructive,
    }, () => run(() => api.stopRuntime()));

    await server.connect(new StdioServerTransport());
}
