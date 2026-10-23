import type { ToolManagerSettings } from "./types.js";
export declare const CONFIG_FILE_NAME = "tool-manager.json";
export declare function resolveConfigPath(env?: NodeJS.ProcessEnv, home?: string): string;
export declare class ToolManagerConfigStore {
    readonly path: string;
    private value;
    private currentRevision;
    private writeQueue;
    constructor(path?: string);
    get revision(): number;
    get(): ToolManagerSettings;
    replace(next: ToolManagerSettings, expectedRevision?: number): Promise<void>;
    private load;
    private write;
}
//# sourceMappingURL=config.d.ts.map