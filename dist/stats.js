import { matchesPattern } from "./policy.js";
export function toolCatalogStats(tools, policy) {
    const disabled = new Set(policy.disabled);
    const grouped = new Set();
    for (const tool of tools) {
        if (policy.groups.some((group) => group.patterns.some((pattern) => matchesPattern(tool.name, pattern)))) {
            grouped.add(tool.name);
        }
    }
    let ungroupedTools = 0;
    let onDemandTools = 0;
    let disabledTools = 0;
    for (const tool of tools) {
        if (disabled.has(tool.name))
            disabledTools += 1;
        else if (grouped.has(tool.name))
            onDemandTools += 1;
        else
            ungroupedTools += 1;
    }
    return {
        totalTools: tools.length,
        groupCount: policy.groups.length,
        ungroupedTools,
        onDemandTools,
        disabledTools,
    };
}
//# sourceMappingURL=stats.js.map