import os from "node:os";
import path from "node:path";

export function resolveInStack(stackDir: string, p: string): string {
    if (p === "~" || p.startsWith("~/")) {
        return path.join(os.homedir(), p.slice(1));
    }
    if (path.isAbsolute(p)) {
        return p;
    }
    return path.resolve(stackDir, p);
}

export function secretsDirFor(stackDir: string, serviceName: string): string {
    return path.join(stackDir, ".boxge", "secrets", serviceName);
}
