import type { AgentPresetsLike, ToolRuntimeLike } from "./dsh.js";
import { type ToolManagerSettings, type ToolManagerSnapshot, type ToolSchemaView } from "./types.js";
export declare function buildSnapshot(presets: AgentPresetsLike, tools: ToolRuntimeLike, settings: ToolManagerSettings, revision: number, configPath: string, observedSchemas?: (presetId: string) => readonly ToolSchemaView[]): Promise<ToolManagerSnapshot>;
export declare function mergeSchemas<T extends {
    name: string;
}>(standing: readonly T[], observed: readonly T[]): T[];
//# sourceMappingURL=snapshot.d.ts.map