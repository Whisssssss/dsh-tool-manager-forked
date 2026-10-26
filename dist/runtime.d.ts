import type { AgentPresetsLike, ContextLike, ToolSchemaLike } from "./dsh.js";
import { type ToolManagerSettings } from "./types.js";
export declare class ToolPolicyRuntime {
    private readonly ctx;
    private readonly presets;
    private settings;
    private readonly states;
    private readonly observedSchemas;
    private mutating;
    /** Last tools/change from outside this plugin's own restriction churn. */
    private lastToolsChangeAt;
    private refreshQueued;
    /** Depth of the `system-prompt/assemble` waterfall currently in flight. */
    private assembling;
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
     * without a `tools/change`.
     *
     * Adoption is GROW-ONLY, and that is load-bearing: while a Preset switch is
     * still mounting, a native request surface can be observed with only a
     * fraction of the catalog plus a few names the previous Preset lacked (PTC
     * exposes `ops_inspect_local_file`/`ops_result`/`ops_load_sdk` where standard
     * exposes `workflow`). Replacing the baseline with that surface would erase
     * the catalog, leave almost nothing to deny, and — because the baseline is
     * then non-empty and the Preset already matches — never be resampled.
     */
    private adoptRequestSurface;
    /**
     * Whether a request surface is PTC mode's collapsed transport: `run_code` is
     * the only tool the model may call directly, and every other tool is projected
     * into the generated SDK. Such a surface describes the presentation, never the
     * registry, so it must not shape the baseline.
     */
    private isCollapsedSurface;
    /**
     * Whether one Agent's baseline needs a new sample: never captured, collapsed
     * to the PTC transport, or taken under a different Preset.
     * @param state - the Agent state to inspect.
     * @param preset - the Agent's current Preset id.
     * @returns whether the baseline must be resampled.
     */
    private baselineIsStale;
    /**
     * Whether the tools service presents PTC mode for this Agent.
     *
     * `run_code` exists in the visibility view only under a PTC presentation, so
     * its presence is the cheapest reliable answer — and unlike `schemas()` a
     * single lookup does not deep-clone the whole catalog on every assembly.
     * @param agent - the Agent whose presentation to inspect.
     * @returns whether the Agent is presented through the PTC transport.
     */
    private isPtcScope;
    /**
     * Whether a sample may replace the baseline.
     *
     * A Preset switch legitimately changes the catalog — different modes compose
     * different tools — so "is every old name still present" cannot distinguish a
     * mid-transition sample from a real one (standard exposes `workflow` and
     * `ops_discover_tools`, PTC does not). Registry quiet can: the switch emits
     * tools/change while it unmounts the old composition and mounts the new one,
     * so a sample taken after the churn stops sees the settled catalog.
     * @param previous - the baseline before this sample.
     * @param previousPreset - the Preset that baseline was sampled under.
     * @param preset - the Agent's current Preset id.
     * @param names - the names the registry currently exposes.
     * @returns whether the sample may replace the baseline.
     */
    private isSettledSample;
    /**
     * Resample one Agent's baseline from the registry.
     *
     * A live restriction is dropped first: `schemas(agent)` reads the already
     * filtered view, so sampling under a restriction would record the hidden names
     * as the catalog and oscillate on the next reconcile.
     *
     * A stale baseline is REPLACED — a Preset switch may legitimately shrink the
     * catalog. A fresh one only GROWS when `merge` is set: a Session resumed from
     * disk, or composed before its Preset finished mounting, samples a subset of
     * the real catalog, and that must never erase what the baseline already holds.
     * @param state - the Agent state to resample.
     * @param merge - merge new tools instead of replacing when not stale.
     * @returns whether the baseline now reflects a usable sample.
     */
    private resampleBaseline;
    /**
     * Land the policy before the generated SDK is rendered.
     *
     * Only PTC mode needs this: its request surface carries nothing but the
     * transport, so the assemble filter above cannot derive the hidden names. This
     * runs before `next()`, where the SDK text is produced from the registry's
     * current visibility, so a restriction applied here reaches the FIRST request.
     * @param state - the Agent whose request is being assembled.
     */
    private ensureRequestBaseline;
    /**
     * Recover a missing, collapsed, or stale baseline on a short timer.
     *
     * It must not run inside the `system-prompt/assemble` waterfall: applying the
     * restriction there emits `tools/change`, which makes DSH re-assemble the
     * prompt for PTC mode and recurse. A timer is also exactly the window the
     * Preset composition needs to register its tools after `agent/created`.
     * @param state - the Agent state whose baseline needs a sample.
     * @param attempt - retry index; the first attempt runs on the next tick.
     */
    private scheduleBaselineRecovery;
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