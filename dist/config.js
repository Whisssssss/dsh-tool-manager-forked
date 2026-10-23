import { mkdir, open, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeSettings } from "./policy.js";
export const CONFIG_FILE_NAME = "tool-manager.json";
export function resolveConfigPath(env = process.env, home = homedir()) {
    const explicit = env.DSH_TOOL_MANAGER_CONFIG?.trim();
    if (explicit)
        return resolve(explicit);
    const configured = env.DSH_HOME?.trim();
    const root = configured ? resolve(configured) : join(home, ".dsh");
    return join(root, CONFIG_FILE_NAME);
}
export class ToolManagerConfigStore {
    path;
    value;
    currentRevision = 0;
    writeQueue = Promise.resolve();
    constructor(path = resolveConfigPath()) {
        this.path = resolve(path);
        this.value = this.load();
    }
    get revision() {
        return this.currentRevision;
    }
    get() {
        return this.value;
    }
    replace(next, expectedRevision) {
        const normalized = normalizeSettings(next);
        const write = async () => {
            if (expectedRevision !== undefined && expectedRevision !== this.currentRevision) {
                throw new Error(`tool-manager config changed (expected revision ${expectedRevision}, current ${this.currentRevision}); refresh and retry`);
            }
            await this.write(normalized);
            this.value = normalized;
            this.currentRevision += 1;
        };
        const pending = this.writeQueue.then(write, write);
        this.writeQueue = pending.catch(() => undefined);
        return pending;
    }
    load() {
        let raw;
        try {
            raw = readFileSync(this.path, "utf8");
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT")
                return normalizeSettings(undefined);
            throw new Error(`failed to read tool-manager config ${this.path}: ${errorMessage(error)}`);
        }
        try {
            return normalizeSettings(JSON.parse(raw));
        }
        catch (error) {
            throw new Error(`failed to parse tool-manager config ${this.path}: ${errorMessage(error)}`);
        }
    }
    async write(value) {
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
        const content = `${JSON.stringify(value, null, 2)}\n`;
        let file;
        try {
            file = await open(temporary, "wx", 0o600);
            await file.writeFile(content, "utf8");
            await file.sync();
            await file.close();
            file = undefined;
            try {
                await rename(temporary, this.path);
            }
            catch (error) {
                if (!isWindowsReplaceError(error))
                    throw error;
                const backup = `${this.path}.${process.pid}.${Date.now()}.bak`;
                await rename(this.path, backup);
                try {
                    await rename(temporary, this.path);
                }
                catch (replaceError) {
                    await rename(backup, this.path).catch(() => undefined);
                    throw replaceError;
                }
                await rm(backup, { force: true });
            }
        }
        finally {
            await file?.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
        }
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function isWindowsReplaceError(error) {
    return process.platform === "win32"
        && isNodeError(error)
        && (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES");
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=config.js.map