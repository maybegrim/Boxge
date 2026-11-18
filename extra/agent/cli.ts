import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, BoxgeError, type ResourceKind, type ServiceAction, type StackAction } from "./client";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHER = path.join(ROOT, "bin", "boxge");

const USAGE = `boxge: manage Boxge stacks on this Mac from a terminal or an agent

Reading
  boxge status                         everything as JSON: runtime, stacks, services
  boxge ls                             one line per stack
  boxge show <stack> [--secrets]       compose file, .env names, services, ports
  boxge logs <stack> [service] [--tail N]
  boxge images | volumes | networks | stats | disk
  boxge settings [--secrets]

Changing stacks
  boxge validate -f <compose.yaml> [--env-file <.env>] [--name <stack>]
                                       dry run: warnings and the container commands
  boxge apply <stack> -f <compose.yaml> [--env-file <.env>] [--no-deploy]
                                       create or update a stack, then deploy it
  boxge deploy|start|stop|restart|update|down <stack>
  boxge clean <stack>                  give back disk space freed inside its containers
  boxge service <stack> <service> start|stop|restart
  boxge env <stack> list [--secrets]
  boxge env <stack> set KEY=VALUE ...
  boxge env <stack> unset KEY ...
  boxge exec <stack> <service> [--timeout N] -- <command> [args...]
  boxge rm <stack> --yes               removes containers, network and the stack folder
  boxge stop-all                       stop every running container, Boxge's or not

Settings
  boxge settings set serviceDnsDomain=<domain> | primaryHostname=<host>
  boxge settings env set KEY=VALUE ... | unset KEY ...
  boxge runtime start | stop           stopping the runtime stops every container

Agents
  boxge mcp                            run as an MCP server over stdio
  boxge mcp-config                     print how to register it with each agent

Use "-" as a file name to read from standard input. Values in .env files are
hidden unless --secrets is given.`;

const VALUE_FLAGS = new Set([ "file", "env-file", "tail", "timeout", "name" ]);
const SHORT_FLAGS : Record<string, string> = { f: "file",
    h: "help" };

interface Parsed {
    positional : string[];
    flags : Record<string, string | boolean>;
    rest : string[];
}

function parseArgs(argv : string[]) : Parsed {
    const positional : string[] = [];
    const flags : Record<string, string | boolean> = {};
    let rest : string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") {
            rest = argv.slice(i + 1);
            break;
        }
        const long = arg.startsWith("--") ? arg.slice(2) : (arg.length === 2 && arg.startsWith("-") ? SHORT_FLAGS[arg[1]] : undefined);
        if (long === undefined) {
            positional.push(arg);
            continue;
        }
        const [ name, inline ] = long.split(/=(.*)/s);
        if (VALUE_FLAGS.has(name)) {
            const value = inline ?? argv[++i];
            if (value === undefined) {
                throw new BoxgeError(`--${name} needs a value.`);
            }
            flags[name] = value;
        } else {
            flags[name] = true;
        }
    }
    return { positional,
        flags,
        rest };
}

function readInput(file : string) : string {
    return fs.readFileSync(file === "-" ? 0 : file, "utf-8");
}

function need(value : string | undefined, what : string) : string {
    if (!value) {
        throw new BoxgeError(`Missing ${what}. Run "boxge help" for usage.`);
    }
    return value;
}

function print(value : unknown) : void {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function pairs(items : string[]) : Record<string, string> {
    const out : Record<string, string> = {};
    for (const item of items) {
        const eq = item.indexOf("=");
        if (eq < 1) {
            throw new BoxgeError(`'${item}' is not in KEY=VALUE form.`);
        }
        out[item.slice(0, eq)] = item.slice(eq + 1);
    }
    return out;
}

function mcpConfig() : string {
    return `Register the Boxge MCP server with an agent. The command is the same everywhere:
  ${LAUNCHER} mcp

Claude Code
  claude mcp add boxge --scope user -- ${LAUNCHER} mcp

pi
  pi mcp add boxge -- ${LAUNCHER} mcp

Codex, in ~/.codex/config.toml
  [mcp_servers.boxge]
  command = "${LAUNCHER}"
  args = ["mcp"]

omp and other agents that read an mcp.json or .mcp.json file
  { "mcpServers": { "boxge": { "command": "${LAUNCHER}", "args": ["mcp"] } } }

Agents without MCP can call the command line tool directly; "boxge help" lists it.`;
}

async function main() : Promise<number> {
    const { positional, flags, rest } = parseArgs(process.argv.slice(2));
    const [ command, ...args ] = positional;
    const secrets = flags.secrets === true;

    if (!command || command === "help" || flags.help === true) {
        process.stdout.write(USAGE + "\n");
        return 0;
    }

    switch (command) {
        case "mcp": {
            const { runMcpServer } = await import("./mcp");
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as { version : string };
            await runMcpServer(pkg.version);
            return new Promise<number>(() => {});
        }
        case "mcp-config":
            process.stdout.write(mcpConfig() + "\n");
            return 0;
        case "status":
            print(await api.status());
            return 0;
        case "ls": {
            const status = await api.status() as { stacks : { name : string; status : string; running : number; total : number; busy : boolean }[] };
            for (const s of status.stacks) {
                process.stdout.write(`${s.name}\t${s.busy ? "busy" : s.status}\t${s.running}/${s.total}\n`);
            }
            return 0;
        }
        case "show":
            print(await api.stack(need(args[0], "a stack name"), secrets));
            return 0;
        case "validate":
            print(await api.validate(
                readInput(need(flags.file as string | undefined, "-f <compose file>")),
                typeof flags["env-file"] === "string" ? readInput(flags["env-file"]) : undefined,
                typeof flags.name === "string" ? flags.name : undefined));
            return 0;
        case "apply":
            print(await api.saveStack(
                need(args[0], "a stack name"),
                readInput(need(flags.file as string | undefined, "-f <compose file>")),
                typeof flags["env-file"] === "string" ? readInput(flags["env-file"]) : undefined,
                flags["no-deploy"] !== true));
            return 0;
        case "deploy":
        case "start":
        case "stop":
        case "restart":
        case "update":
        case "down":
        case "clean":
            print(await api.stackAction(need(args[0], "a stack name"), command as StackAction));
            return 0;
        case "service": {
            const action = need(args[2], "an action (start, stop or restart)");
            if (![ "start", "stop", "restart" ].includes(action)) {
                throw new BoxgeError(`Unknown service action '${action}'.`);
            }
            print(await api.serviceAction(need(args[0], "a stack name"), need(args[1], "a service name"), action as ServiceAction));
            return 0;
        }
        case "rm": {
            const name = need(args[0], "a stack name");
            if (flags.yes !== true) {
                throw new BoxgeError(`This removes the containers, network and folder of '${name}'. Add --yes to go ahead.`);
            }
            print(await api.deleteStack(name));
            return 0;
        }
        case "logs": {
            const tail = typeof flags.tail === "string" ? Number(flags.tail) : undefined;
            const result = await api.logs(need(args[0], "a stack name"), args[1], tail) as { logs : { service : string; state : string; text : string }[] };
            for (const entry of result.logs) {
                process.stdout.write(`==> ${entry.service} (${entry.state}) <==\n${entry.text}${entry.text.endsWith("\n") || entry.text === "" ? "" : "\n"}`);
            }
            return 0;
        }
        case "exec": {
            if (rest.length === 0) {
                throw new BoxgeError("Put the command after --, for example: boxge exec web app -- ls /");
            }
            const timeout = typeof flags.timeout === "string" ? Number(flags.timeout) : undefined;
            const result = await api.exec(need(args[0], "a stack name"), need(args[1], "a service name"), rest, timeout) as
                { exitCode : number; timedOut : boolean; stdout : string; stderr : string };
            process.stdout.write(result.stdout);
            process.stderr.write(result.stderr);
            if (result.timedOut) {
                process.stderr.write("boxge: the command timed out\n");
                return 124;
            }
            return result.exitCode;
        }
        case "env": {
            const name = need(args[0], "a stack name");
            const sub = args[1] ?? "list";
            if (sub === "list") {
                const result = await api.stack(name, secrets) as { stack : { env : unknown } };
                print(result.stack.env);
            } else if (sub === "set") {
                print(await api.setStackEnv(name, { set: pairs(args.slice(2)) }));
            } else if (sub === "unset") {
                print(await api.setStackEnv(name, { unset: args.slice(2) }));
            } else {
                throw new BoxgeError(`Unknown env command '${sub}'. Use list, set or unset.`);
            }
            return 0;
        }
        case "images":
        case "volumes":
        case "networks":
            print(await api.resources(command as ResourceKind));
            return 0;
        case "stats":
            print(await api.stats());
            return 0;
        case "disk":
            print(await api.disk());
            return 0;
        case "settings": {
            if (args[0] === undefined) {
                print(await api.settings(secrets));
            } else if (args[0] === "set") {
                const change = pairs(args.slice(1));
                for (const key of Object.keys(change)) {
                    if (key !== "serviceDnsDomain" && key !== "primaryHostname") {
                        throw new BoxgeError(`Unknown setting '${key}'. Use serviceDnsDomain or primaryHostname.`);
                    }
                }
                print(await api.setSettings(change));
            } else if (args[0] === "env" && args[1] === "set") {
                print(await api.setSettings({ globalEnv: { set: pairs(args.slice(2)) } }));
            } else if (args[0] === "env" && args[1] === "unset") {
                print(await api.setSettings({ globalEnv: { unset: args.slice(2) } }));
            } else {
                throw new BoxgeError("Unknown settings command. Run \"boxge help\" for usage.");
            }
            return 0;
        }
        case "runtime":
            if (args[0] === "start") {
                print(await api.startRuntime());
            } else if (args[0] === "stop") {
                print(await api.stopRuntime());
            } else {
                throw new BoxgeError("Use: boxge runtime start, or boxge runtime stop");
            }
            return 0;
        case "stop-all":
            print(await api.stopAll());
            return 0;
        default:
            throw new BoxgeError(`Unknown command '${command}'. Run "boxge help" for usage.`);
    }
}

main().then((code) => {
    process.exitCode = code;
}).catch((e) => {
    const body = e instanceof BoxgeError ? e.body : undefined;
    if (body && typeof body.output === "string" && body.output !== "") {
        process.stderr.write(body.output + "\n");
    }
    process.stderr.write(`boxge: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
});
