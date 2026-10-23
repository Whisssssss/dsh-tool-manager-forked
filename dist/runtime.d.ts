import type { AgentPresetsLike, ContextLike, ToolSchemaLike } from "./dsh.js";
import { type ToolManagerSettings } from "./types.js";
export declare class ToolPolicyRuntime {
    private readonly ctx;
    private readonly presets;
    private settings;
    private readonly states;
    private readonly observedSchemas;
    private mutating;
    private refreshQueued;
    private discoveryDisposer?;
    constructor(ctx: ContextLike, presets: AgentPresetsLike, initial: ToolManagerSettings);
    start(): void;
    update(next: ToolManagerSettings): void;
    private install;
    private uninstall;
    private presetId;
    private policy;
    private hostTools;
    private inheritedSchemas;
    private observe;
    observeSchemas(presetId: string, schemasToAdd: readonly ToolSchemaLike[]): void;
    observedSchemasFor(presetId: string): ToolSchemaLike[];
    private installLocalPolicy;
    /** Install the dispatch-level guard once the Agent exposes its tools service. */
    private ensureGuard;
    /**
     * Adopt the tool surface a model request actually exposes as this Agent's
     * baseline when the snapshot taken at `agent/created` is missing names it now
     * has. That happens when the Preset composition registers its tools after the
     * Agent was created, or when a dynamic source (an MCP tools/list) lands
     * without a `tools/change`. Tools an existing restriction already denies are
     * never a reason to shrink the baseline — doing so would oscillate — so this
     * only fires when the request carries a name the baseline does not have.
     */
    private adoptRequestSurface;
    private queueBaselineRefresh;
    private refreshAllBaselines;
    private openGroup;
    private onPreStep;
    /**
     * Register `tool_list` on the host/global tools layer, not per agent.
     *
     * PTC prompt assembly projects inherited (global + preset-standing) tools
     * into the SDK. A scope-local registration on `agent.ctx` is visible to
     * `schemas(agent)` after the fact, but is easy to lose at `agent/created`
     * and is the wrong layer for the generated SDK. `skill` works in PTC
     * because the preset standing scope inherits it; `tool_list` must do the
     * same. Presets without active (non-empty) on-demand groups hide it with `restrict()`.
     */
    private registerDiscovery;
    private discoveryDefinition;
    private reconcile;
    private applyDeny;
    private warn;
    dispose(): Promise<void>;
}
//# sourceMappingURL=runtime.d.ts.map