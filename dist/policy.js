import { DISCOVERY_TOOL_NAME, PTC_TRANSPORT_NAME, } from "./types.js";
export const EMPTY_PRESET_POLICY = Object.freeze({
    disabled: [],
    groups: [],
});
export function normalizeSettings(value) {
    const record = asRecord(value);
    const inputPresets = asRecord(record?.presets);
    const presets = {};
    for (const [presetId, rawPolicy] of Object.entries(inputPresets ?? {})) {
        if (!presetId.trim())
            continue;
        presets[presetId] = normalizePresetPolicy(rawPolicy);
    }
    return { presets };
}
export function normalizePresetPolicy(value) {
    const record = asRecord(value);
    const disabled = uniqueStrings(record?.disabled);
    const groups = [];
    const seen = new Set();
    for (const value of Array.isArray(record?.groups) ? record.groups : []) {
        const group = asRecord(value);
        const name = groupNameOf(group);
        const key = name.toLowerCase();
        if (!name || seen.has(key))
            continue;
        seen.add(key);
        const description = groupDescriptionOf(group);
        groups.push({
            name,
            ...(description ? { description } : {}),
            patterns: uniqueStrings(group?.patterns),
        });
    }
    return { disabled, groups };
}
export function policyFor(settings, presetId) {
    if (!presetId)
        return EMPTY_PRESET_POLICY;
    return settings.presets[presetId] ?? EMPTY_PRESET_POLICY;
}
export function resolveGroups(policy, toolNames) {
    return policy.groups.map((group) => ({
        name: group.name,
        ...(group.description ? { description: group.description } : {}),
        patterns: [...group.patterns],
        tools: toolNames.filter((name) => isGroupableTool(name) && matchesAnyPattern(name, group.patterns)),
    }));
}
export function resolveActiveGroups(policy, toolNames) {
    const disabled = new Set(policy.disabled);
    const claimed = new Set();
    const active = [];
    for (const group of resolveGroups(policy, toolNames)) {
        const tools = group.tools.filter((name) => !disabled.has(name) && !claimed.has(name));
        if (tools.length === 0)
            continue;
        for (const name of tools)
            claimed.add(name);
        active.push({ ...group, tools });
    }
    return active;
}
export function groupPolicyIssues(policy, toolNames) {
    const disabled = new Set(policy.disabled);
    const owners = new Map();
    const emptyGroups = [];
    const disabledMembers = [];
    for (const group of resolveGroups(policy, toolNames)) {
        const enabled = group.tools.filter((name) => !disabled.has(name));
        if (enabled.length === 0)
            emptyGroups.push(group.name);
        for (const name of group.tools) {
            if (disabled.has(name))
                disabledMembers.push({ tool: name, groups: [group.name] });
            const groups = owners.get(name) ?? [];
            groups.push(group.name);
            owners.set(name, groups);
        }
    }
    const duplicateMembers = [...owners]
        .filter(([, groups]) => groups.length > 1)
        .map(([tool, groups]) => ({ tool, groups }));
    return { emptyGroups, disabledMembers, duplicateMembers };
}
export function hiddenTools(policy, toolNames) {
    const hidden = new Set();
    for (const name of toolNames) {
        if (policy.disabled.includes(name))
            hidden.add(name);
        if (policy.groups.some((group) => matchesAnyPattern(name, group.patterns))) {
            hidden.add(name);
        }
    }
    return hidden;
}
/**
 * Names `tools.restrict({ deny })` may legally receive for the current
 * inherited baseline: grouped tools that are not currently exposed, plus
 * every explicit disable. The PTC transport is never denied. `tool_list` is
 * registered globally so PTC's SDK can bind it. Presets with no active
 * (non-empty) on-demand groups hide it here so restrict() can deny the inherited name.
 */
export function denyNames(policy, toolNames, exposures) {
    const groups = resolveActiveGroups(policy, toolNames);
    const hidden = new Set();
    const open = new Set([...exposures].map((name) => name.toLowerCase()));
    for (const group of groups) {
        if (open.has(group.name.toLowerCase()))
            continue;
        for (const name of group.tools)
            hidden.add(name);
    }
    for (const name of policy.disabled) {
        if (toolNames.includes(name))
            hidden.add(name);
    }
    hidden.delete(PTC_TRANSPORT_NAME);
    if (groups.length > 0)
        hidden.delete(DISCOVERY_TOOL_NAME);
    else if (toolNames.includes(DISCOVERY_TOOL_NAME))
        hidden.add(DISCOVERY_TOOL_NAME);
    return toolNames.filter((name) => hidden.has(name));
}
export function emptyGroupNames(policy, toolNames) {
    return groupPolicyIssues(policy, toolNames).emptyGroups;
}
export function policyOrphans(policy, toolNames) {
    const present = new Set(toolNames);
    return {
        disabled: policy.disabled.filter((name) => !present.has(name)),
        emptyGroups: emptyGroupNames(policy, toolNames),
    };
}
export function listGroupViews(groups, exposures) {
    const open = new Set([...exposures].map((name) => name.toLowerCase()));
    return groups.map((group) => ({
        name: group.name,
        ...(group.description ? { description: group.description } : {}),
        exposed: open.has(group.name.toLowerCase()),
    }));
}
export function findGroup(groups, requested) {
    const needle = requested.trim().toLowerCase();
    if (!needle)
        return undefined;
    return groups.find((group) => group.name.toLowerCase() === needle);
}
export function matchesAnyPattern(value, patterns) {
    return patterns.some((pattern) => matchesPattern(value, pattern));
}
function isGroupableTool(name) {
    return name !== DISCOVERY_TOOL_NAME && name !== PTC_TRANSPORT_NAME;
}
/**
 * Compiled wildcard patterns.
 *
 * Every model step matches one Preset's whole tool catalog against every group
 * pattern (deny set, catalog, guard), so recompiling the same RegExp hundreds of
 * times per step is pure overhead. Patterns are few and stable; the cache is
 * bounded so a pathological settings file cannot grow it without limit.
 */
const patternCache = new Map();
export function matchesPattern(value, pattern) {
    if (!pattern.includes("*"))
        return value === pattern;
    let regex = patternCache.get(pattern);
    if (regex === undefined) {
        const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
        regex = new RegExp(`^${escaped}$`);
        if (patternCache.size < 512)
            patternCache.set(pattern, regex);
    }
    return regex.test(value);
}
export function sameNames(left, right) {
    if (left.length !== right.length)
        return false;
    return left.every((name, index) => name === right[index]);
}
export function asRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    return value;
}
export function normalizeGroupName(value) {
    return value.trim().replace(/\s+/g, " ");
}
function groupNameOf(group) {
    if (!group)
        return "";
    if (typeof group.name === "string")
        return normalizeGroupName(group.name);
    if (typeof group.id === "string")
        return normalizeGroupName(group.id);
    return "";
}
function groupDescriptionOf(group) {
    if (!group)
        return undefined;
    if (typeof group.description === "string" && group.description.trim())
        return group.description.trim();
    if (typeof group.label === "string" && group.label.trim())
        return group.label.trim();
    return undefined;
}
function uniqueStrings(value) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value
            .filter((item) => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean))];
}
export function parseKnownRestrictable(error) {
    const message = error instanceof Error ? error.message : String(error);
    const marker = "known global tools: ";
    const index = message.lastIndexOf(marker);
    if (index < 0)
        return undefined;
    const listed = message.slice(index + marker.length).trim();
    if (!listed || listed === "(none)")
        return new Set();
    return new Set(listed.split(", ").map((item) => item.trim()).filter(Boolean));
}
//# sourceMappingURL=policy.js.map