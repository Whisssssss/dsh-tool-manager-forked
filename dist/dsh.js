/** Structural DSH faces used by this plugin. No @deepseek-ai runtime imports. */
export function asRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    return value;
}
/** Read one preset's standing schemas and always release the revision lease. */
export async function schemasForPreset(presets, tools, id) {
    const lease = await presets.acquireScope(id);
    try {
        return tools.schemas(lease.key);
    }
    finally {
        await lease[Symbol.asyncDispose]();
    }
}
//# sourceMappingURL=dsh.js.map