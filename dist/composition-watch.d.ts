/**
 * Generic re-calibration for Preset switches.
 *
 * WHY THIS EXISTS
 * `agentPresets.recompose()` re-links one Agent and dispatches exactly ONE
 * `tools/change`. Every preset composition that installs per-Agent tools
 * reconciles on that event: the composition the Agent LEFT disposes its
 * registrations (asynchronously) while the composition it JOINED claims the
 * same names. Which side wins is decided by listener registration order — the
 * order presets were mounted in — and nothing in a plugin owns that order.
 *
 * Losing that race throws inside the joining composition's `ctx.inject`, and
 * DSH caches the failed fiber per Agent, so the tools stay unregistered for
 * that Agent until the Agent object is rebuilt (Session reopen, Host restart).
 *
 * WHAT THIS DOES INSTEAD
 * Stop predicting the race and make its outcome irrelevant: after every mode
 * switch, re-calibrate the Session by composing one other Preset and then
 * composing the intended one again. That round trip makes the previous
 * composition observe "the Agent left me" (clearing whatever the failed
 * attempt cached) and then lets the intended composition install into an Agent
 * that holds no competing registration. It is deliberately blind to tool names:
 * anything any plugin installs per Agent is re-installed the same way.
 *
 * SAFETY
 * A re-calibration is only attempted on a Session that has not started a turn —
 * DSH itself refuses to re-link a started Session, and a running turn must not
 * have its preset changed under it. The two legs are sequential and the second
 * one always runs: leaving an Agent on the transit Preset would be worse than
 * the missing tools this repairs.
 */
import type { AgentLike, AgentPresetsLike, AgentSessionLike, ContextLike, ToolRuntimeLike, ToolSchemaLike } from "./dsh.js";
export interface CompositionWatchOptions {
    presets: AgentPresetsLike;
    /** Live Agents, in any order. */
    agents: () => readonly AgentLike[];
    tools: () => ToolRuntimeLike | undefined;
    /**
     * Tool names a freshly composed Agent of one Preset would hold. Used only to
     * verify a suspected loss, never to decide a re-calibration.
     */
    probe?: (presetId: string) => Promise<readonly ToolSchemaLike[]>;
    /**
     * True when this plugin's own policy — not a lost registration — hides the
     * name (a disabled tool, an on-demand group member, the plugin's own tools).
     */
    explainedLoss?: (presetId: string | undefined, name: string) => boolean;
    warn: (message: string) => void;
    /** Informational sink; falls back to `warn` when the Host has no info level. */
    info?: (message: string) => void;
    /** Agent excluded from watching — the plugin's own probe Session. */
    excludeAgentId?: string;
    /** Quiet period after `tools/change`, so reconcilers can settle first. */
    debounceMs?: number;
    /** Lets one composition's registrations settle before the next leg. */
    settle?: () => Promise<void>;
}
/**
 * Watches live Agents across Preset switches and re-calibrates the Sessions a
 * switch may have left short of tools.
 */
export declare class CompositionWatch {
    private readonly options;
    private readonly observations;
    private readonly pending;
    private readonly busy;
    private readonly reported;
    private queue;
    private timer?;
    private disposed;
    constructor(options: CompositionWatchOptions);
    /** Subscribe to the events that can change an Agent's tool set. */
    start(context: ContextLike): void;
    /**
     * Inspect every live Agent now, then run the re-calibrations that inspection
     * queued. Two concurrent callers are serialized, so an inspection never
     * overlaps a re-calibration.
     */
    flush(): Promise<void>;
    dispose(): void;
    private schedule;
    private clearTimer;
    private drain;
    /** Compare every live Agent's tool set with the last one this class saw. */
    private inspect;
    /**
     * Report an Agent that lost tools without a mode switch — the shape a failed
     * per-Agent install leaves behind. A name the reference Agent of the same
     * Preset also lacks is a composition-level change, not this defect.
     */
    private reportLoss;
    /**
     * Name the tools one Preset provides that a started Session does not hold.
     *
     * The previous tool set cannot answer this: a switch is observed after DSH's
     * failed install already settled, so the shortfall only shows against a
     * freshly composed reference Agent of the same Preset.
     */
    private reportShortfall;
    /** The tool names a freshly composed Agent of one Preset holds. */
    private reference;
    /**
     * Re-link one Agent through a transit Preset and back, so the intended
     * composition installs into an Agent whose competing registrations are gone.
     */
    private recalibrate;
    /** The transit Preset: the one whose composition shares least with nothing. */
    private chooseTransit;
    /** Put one Agent back on its intended Preset after a failed leg. */
    private restore;
    private settle;
}
/**
 * Whether a Session is still blank enough for DSH to re-link it.
 *
 * `recompose()` itself has no lock — `agentPresets.select()` carries it — so
 * this mirrors that rule before touching a live Session: no turn started, no
 * inherited fork history to disturb.
 */
export declare function isBlankSession(session: AgentSessionLike | undefined): boolean;
//# sourceMappingURL=composition-watch.d.ts.map