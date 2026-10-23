import { type PresetOrphans, type PresetToolPolicy, type ResolvedGroupView, type ToolListGroupView, type ToolManagerSettings } from "./types.js";
export declare const EMPTY_PRESET_POLICY: PresetToolPolicy;
export declare function normalizeSettings(value: unknown): ToolManagerSettings;
export declare function normalizePresetPolicy(value: unknown): PresetToolPolicy;
export declare function policyFor(settings: ToolManagerSettings, presetId: string | undefined): PresetToolPolicy;
export declare function resolveGroups(policy: PresetToolPolicy, toolNames: readonly string[]): ResolvedGroupView[];
export interface GroupConflict {
    tool: string;
    groups: string[];
}
export interface GroupPolicyIssues {
    emptyGroups: string[];
    disabledMembers: GroupConflict[];
    duplicateMembers: GroupConflict[];
}
export declare function resolveActiveGroups(policy: PresetToolPolicy, toolNames: readonly string[]): ResolvedGroupView[];
export declare function groupPolicyIssues(policy: PresetToolPolicy, toolNames: readonly string[]): GroupPolicyIssues;
export declare function hiddenTools(policy: PresetToolPolicy, toolNames: readonly string[]): Set<string>;
/**
 * Names `tools.restrict({ deny })` may legally receive for the current
 * inherited baseline: grouped tools that are not currently exposed, plus
 * every explicit disable. The PTC transport is never denied. `tool_list` is
 * registered globally so PTC's SDK can bind it. Presets with no active
 * (non-empty) on-demand groups hide it here so restrict() can deny the inherited name.
 */
export declare function denyNames(policy: PresetToolPolicy, toolNames: readonly string[], exposures: ReadonlySet<string>): string[];
export declare function emptyGroupNames(policy: PresetToolPolicy, toolNames: readonly string[]): string[];
export declare function policyOrphans(policy: PresetToolPolicy, toolNames: readonly string[]): PresetOrphans;
export declare function listGroupViews(groups: readonly ResolvedGroupView[], exposures: ReadonlySet<string>): ToolListGroupView[];
export declare function findGroup(groups: readonly ResolvedGroupView[], requested: string): ResolvedGroupView | undefined;
export declare function matchesAnyPattern(value: string, patterns: readonly string[]): boolean;
export declare function matchesPattern(value: string, pattern: string): boolean;
export declare function sameNames(left: readonly string[], right: readonly string[]): boolean;
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function normalizeGroupName(value: string): string;
export declare function parseKnownRestrictable(error: unknown): Set<string> | undefined;
//# sourceMappingURL=policy.d.ts.map