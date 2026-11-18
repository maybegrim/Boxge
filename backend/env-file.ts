import dotenv from "dotenv";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvEntry {
    key : string;
    value : string | null;
}

export function listEnv(text : string, reveal : boolean) : EnvEntry[] {
    return Object.entries(dotenv.parse(text)).map(([ key, value ]) => ({
        key,
        value: reveal ? value : null,
    }));
}

function formatValue(key : string, value : string) : string {
    if (/^[A-Za-z0-9_.:/@%+,-]*$/.test(value)) {
        return value;
    }
    const multiline = /[\r\n]/.test(value);
    if (!multiline && !value.includes("'")) {
        return `'${value}'`;
    }
    if (!value.includes("\"")) {
        return `"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
    }
    if (!multiline && !value.includes("`")) {
        return `\`${value}\``;
    }
    throw new Error(`The value for '${key}' mixes quote characters in a way a .env file cannot hold.`);
}

function lineKey(line : string) : string | undefined {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return match ? match[1] : undefined;
}

export function editEnv(text : string, set : Record<string, string> = {}, unset : string[] = []) : string {
    for (const key of [ ...Object.keys(set), ...unset ]) {
        if (!KEY_PATTERN.test(key)) {
            throw new Error(`'${key}' is not a valid variable name.`);
        }
    }

    const pending = new Map(Object.entries(set).map(([ key, value ]) => [ key, String(value) ]));
    const removed = new Set(unset);
    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    const out : string[] = [];

    for (const line of lines) {
        const key = lineKey(line);
        if (key !== undefined && removed.has(key)) {
            continue;
        }
        if (key !== undefined && pending.has(key)) {
            out.push(`${key}=${formatValue(key, pending.get(key) as string)}`);
            pending.delete(key);
            continue;
        }
        out.push(line);
    }
    for (const [ key, value ] of pending) {
        out.push(`${key}=${formatValue(key, value)}`);
    }
    return out.length > 0 ? out.join("\n") + "\n" : "";
}
