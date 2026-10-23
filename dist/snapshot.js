import { schemasForPreset } from "./dsh.js";
import { policyFor, policyOrphans, resolveGroups } from "./policy.js";
import { DISCOVERY_TOOL_NAME, PTC_TRANSPORT_NAME, } from "./types.js";
export async function buildSnapshot(presets, tools, settings, revision, configPath, observedSchemas) {
    const compositions = await presets.compositionInventory();
    const views = [];
    for (const composition of compositions) {
        let schemas = [];
        let broken = composition.broken;
        if (!broken) {
            try {
                const standing = await schemasForPreset(presets, tools, composition.id);
                const observed = observedSchemas?.(composition.id) ?? [];
                schemas = mergeSchemas(standing, observed)
                    .filter((schema) => schema.name !== DISCOVERY_TOOL_NAME && schema.name !== PTC_TRANSPORT_NAME)
                    .map(projectSchema);
            }
            catch (error) {
                broken = error instanceof Error ? error.message : String(error);
            }
        }
        const policy = policyFor(settings, composition.id);
        const names = schemas.map((item) => item.name);
        views.push({
            id: composition.id,
            ...(composition.name ? { name: composition.name } : {}),
            trust: composition.trust ?? "system",
            isDefault: composition.isDefault,
            ...(broken ? { broken } : {}),
            tools: schemas,
            policy,
            groups: resolveGroups(policy, names),
            orphans: policyOrphans(policy, names),
        });
    }
    return {
        writable: true,
        revision,
        configPath,
        presets: views,
    };
}
export function mergeSchemas(standing, observed) {
    const merged = new Map();
    for (const schema of standing)
        merged.set(schema.name, schema);
    for (const schema of observed)
        merged.set(schema.name, schema);
    return [...merged.values()];
}
function projectSchema(schema) {
    return {
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
    };
}
//# sourceMappingURL=snapshot.js.map