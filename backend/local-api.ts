import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import { log } from "./log";

interface PublishedInfo {
    url? : string;
    token? : string;
    pid? : number;
    version? : string;
}

export function localApiInfoPath() : string {
    return process.env.BOXGE_LOCAL_API_FILE || path.join(os.homedir(), ".boxge", "local-api.json");
}

export class LocalApi {
    private readonly token = crypto.randomBytes(32).toString("hex");
    private url = "";
    private version = "";
    private warnedOwner? : number;

    async publish(url : string, version : string) : Promise<void> {
        this.url = url;
        this.version = version;
        await this.ensurePublished();
    }

    async ensurePublished() : Promise<void> {
        if (!this.url) {
            return;
        }
        const file = localApiInfoPath();
        const current = this.read(file);
        if (current?.pid === process.pid && current.token === this.token) {
            return;
        }
        if (current && current.pid !== process.pid && await this.isLive(current)) {
            if (this.warnedOwner !== current.pid) {
                this.warnedOwner = current.pid;
                log.warn("local-api", `Another Boxge server (pid ${current.pid}, ${current.url}) owns ${file}, so the menu bar app and agent tools ` +
                    "keep talking to that one. Set BOXGE_LOCAL_API_FILE to give this server its own file.");
            }
            return;
        }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.rmSync(file, { force: true });
            fs.writeFileSync(file, JSON.stringify({
                url: this.url,
                token: this.token,
                pid: process.pid,
                version: this.version,
            }, null, 4), { mode: 0o600 });
            fs.chmodSync(file, 0o600);
        } catch (e) {
            log.warn("local-api", `Could not write ${file}: ${e instanceof Error ? e.message : e}`);
        }
    }

    unpublish() : void {
        this.url = "";
        const file = localApiInfoPath();
        if (this.read(file)?.pid === process.pid) {
            fs.rmSync(file, { force: true });
        }
    }

    private read(file : string) : PublishedInfo | undefined {
        try {
            return JSON.parse(fs.readFileSync(file, "utf-8")) as PublishedInfo;
        } catch {
            return undefined;
        }
    }

    private async isLive(info : PublishedInfo) : Promise<boolean> {
        if (typeof info.pid !== "number" || typeof info.url !== "string" || typeof info.token !== "string") {
            return false;
        }
        try {
            process.kill(info.pid, 0);
        } catch {
            return false;
        }
        try {
            const response = await fetch(`${info.url}/api/local/status`, {
                headers: { Authorization: `Bearer ${info.token}` },
                signal: AbortSignal.timeout(3000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    authorize(req : Request) : boolean {
        const header = req.headers.authorization ?? "";
        const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
        const expected = Buffer.from(this.token);
        if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
            return false;
        }
        return this.isLocalAddress(req.socket.remoteAddress);
    }

    private isLocalAddress(address : string | undefined) : boolean {
        if (!address) {
            return false;
        }
        const normalized = address.replace(/^::ffff:/, "");
        if (normalized === "::1" || normalized.startsWith("127.")) {
            return true;
        }
        for (const addrs of Object.values(os.networkInterfaces())) {
            if ((addrs ?? []).some((a) => a.address === normalized)) {
                return true;
            }
        }
        return false;
    }
}
