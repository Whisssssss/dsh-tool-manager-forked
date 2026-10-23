import type { AgentPresetsLike, ContextLike, ToolRuntimeLike, ToolSchemaLike } from "./dsh.js";
import { normalizeSettings } from "./policy.js";
export declare const name = "dsh-tool-manager";
export declare const inject: string[];
/**
 * A single live probe prevents one persistent Session per request or Preset.
 * Preset switches are serialized because `recompose()` mutates this Agent's
 * scope parent before its scoped tool catalog is read.
 */
export declare class PresetSchemaProbe {
    private readonly context;
    private readonly presets;
    private handle?;
    private initialization?;
    private queue;
    private disposed;
    constructor(context: ContextLike, presets: AgentPresetsLike);
    inspect(presetId: string): Promise<ToolSchemaLike[]>;
    private inspectSerial;
    private ensure;
    private initialize;
    dispose(): Promise<void>;
}
/**
 * The session-default preset's standing composition, composed before any other
 * preset this plugin mounts.
 *
 * `agentPresets` keeps ONE permanent standing composition per preset, and each
 * composition reconciles its own per-Agent tool registrations on every
 * `tools/change`. A blank Session is always composed from the deployment's
 * default preset and only then re-linked to the preset the mode picker names,
 * so that single switch dispatches one `tools/change` at which listeners run in
 * composition-mount order: the preset mounted FIRST disposes its per-Agent
 * registrations before the preset mounted SECOND claims the same tool names.
 *
 * Presets that install per-Agent tools — `modelSelectionSettings: true` on
 * `@deepseek-ai/dsh-tool-subagent` registers `subagent` and
 * `list_subagent_models` into the Agent's OWN scope layer — therefore lose
 * those tools on a default→preset switch whenever a non-default preset was
 * mounted first: a Session resumed in it, or this plugin's own catalog probe.
 * The tools stay missing for that Agent until it is rebuilt.
 *
 * Composing the default at plugin start pins the order to `[default, …]` for
 * the whole Host run, which is the order such a switch needs; every preset this
 * plugin mounts afterwards goes through {@link ensure} first. A failed attempt
 * is a warning, never a blocked catalog: the probe still answers from whatever
 * presets it can compose, and the next call retries.
 */
export declare class DefaultPresetMount {
    private readonly presets;
    private readonly warn;
    private attempt?;
    private ready;
    constructor(presets: AgentPresetsLike, warn: (message: string) => void);
    /**
     * Resolve once the default preset's standing composition exists, once its
     * composing attempt settled, or immediately when it already did.
     */
    ensure(): Promise<void>;
    private compose;
}
/** Lazily probed catalogs plus the observer-visible schemas of one Preset. */
export interface PresetCatalog {
    /** Every schema known for one Preset, for the page's per-Preset catalog. */
    schemasFor(presetId: string): ToolSchemaLike[];
    /** Probe one Preset on demand so `schemasFor` can answer for it. */
    ensure(presetId: string): Promise<void>;
    /** Probe every Preset the roster supplies, so the page can list all of them. */
    ensureAll(): Promise<void>;
}
export interface PresetCatalogOptions {
    context: ContextLike;
    presets: AgentPresetsLike;
    probe: PresetSchemaProbe;
    defaultPreset: DefaultPresetMount;
    /** Schemas observed on live Agents of one Preset, without probing. */
    observed: (presetId: string) => readonly ToolSchemaLike[];
}
/**
 * Build the per-Preset catalog readers shared by the snapshot and save paths.
 *
 * A Preset with a live Agent answers from that Agent, so probing — and the
 * mount it needs — is skipped where the live view is authoritative. Every cold
 * Preset is probed only after the session default is composed (see
 * {@link DefaultPresetMount}), which is what keeps the mount order that mode
 * switching depends on.
 */
export declare function createPresetCatalog(options: PresetCatalogOptions): PresetCatalog;
export declare function apply(ctx: unknown): void;
/**
 * Every tool name the page can show for one Preset: the standing composition
 * unioned with the Agent-scoped registrations the probe and live Agents
 * observed.
 *
 * Returns `undefined` when the standing composition cannot be read at all, so
 * the save path keeps its historical "an uninspectable Preset is not validated"
 * behaviour instead of reporting every group as empty.
 */
export declare function visiblePresetToolNames(presets: AgentPresetsLike, tools: ToolRuntimeLike, catalog: Pick<PresetCatalog, "schemasFor" | "ensure">, presetId: string): Promise<string[] | undefined>;
export declare function assertNoEmptyGroups(presets: AgentPresetsLike, tools: ToolRuntimeLike, settings: ReturnType<typeof normalizeSettings>, 
/** Composes the session default before this call mounts any other preset. */
composeDefaultFirst?: () => Promise<void>, 
/**
 * Reads the tool names one Preset can actually expose. Callers that have a
 * merged catalog must pass it: a standing-only read misses the tools plugins
 * register into each Agent's own scope, which the page lists and the runtime
 * happily opens. `undefined` skips that Preset.
 */
toolNamesFor?: (presetId: string) => Promise<string[] | undefined> | string[] | undefined): Promise<void>;
export { TOOL_MANAGER_PROBE_SESSION_ID } from "./types.js";
export { CompositionWatch, isBlankSession } from "./composition-watch.js";
export type { CompositionWatchOptions } from "./composition-watch.js";
export type * from "./types.js";
//# sourceMappingURL=index.d.ts.map