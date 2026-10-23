import type { PresetToolPolicy, ToolSchemaView } from "./types.js";
export interface ToolCatalogStats {
    totalTools: number;
    groupCount: number;
    ungroupedTools: number;
    onDemandTools: number;
    disabledTools: number;
}
export declare function toolCatalogStats(tools: readonly Pick<ToolSchemaView, "name">[], policy: PresetToolPolicy): ToolCatalogStats;
//# sourceMappingURL=stats.d.ts.map