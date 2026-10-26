import type {
  AgentLike,
  AgentPresetsLike,
  ContextLike,
  ToolRuntimeLike,
  ToolSchemaLike,
} from "./dsh.js";
import {
  applyCatalogDecision,
  catalogEntriesFromGroups,
  catalogHistory,
} from "./catalog.js";
import { restoredExposureNames } from "./exposure-history.js";
import {
  denyNames,
  findGroup,
  parseKnownRestrictable,
  policyFor,
  resolveActiveGroups,
  sameNames,
} from "./policy.js";
import {
  DISCOVERY_TOOL_NAME,
  PTC_TRANSPORT_NAME,
  TOOL_MANAGER_PROBE_SESSION_ID,
  type PresetToolPolicy,
  type ToolListResult,
  type ToolManagerSettings,
} from "./types.js";

/**
 * Retry window for sampling a baseline the Preset composition had not
 * registered yet. The first sample runs immediately; later ones every
 * {@link BASELINE_RECOVERY_INTERVAL_MS}, because a Session created a beat too
 * early would otherwise carry an empty catalog for its whole life.
 */
const BASELINE_RECOVERY_INTERVAL_MS = 50;
const BASELINE_RECOVERY_ATTEMPTS = 60;
/**
 * A Preset switch briefly unmounts its predecessor before the new composition
 * registers, so the first samples can miss tools. After this many rejected
 * samples the catalog is accepted as-is — a shrink is real, not a transition.
 */
const SAMPLE_SETTLE_ATTEMPTS = 25;
/**
 * Quiet window that marks a Preset switch as finished. The switch emits
 * tools/change while it unmounts the old composition and mounts the new one; a
 * sample taken after the churn stops sees the complete catalog.
 */
const PRESET_SETTLE_MS = 300;

interface AgentState {
  readonly agent: AgentLike;
  baseline: string[];
  baselineSchemas: ToolSchemaLike[];
  restriction?: () => void;
  /** Deny set the live restriction enforces; a matching set needs no churn. */
  lastDeny?: string[];
  /** Preset the baseline was sampled under; a switch invalidates that sample. */
  lastPreset?: string;
  guard?: () => void;
  assemblyFilter?: () => void;
  /** A retrying baseline sample is armed; later requests reuse it. */
  recovering?: boolean;
  /** Consecutive samples rejected as mid-transition; forces acceptance eventually. */
  sampleRetries?: number;
  readonly exposures: Set<string>;
}

export class ToolPolicyRuntime {
  private settings: ToolManagerSettings;
  private readonly states = new Map<AgentLike, AgentState>();
  private readonly observedSchemas = new Map<string, Map<string, ToolSchemaLike>>();
  private mutating = false;
  /** Last tools/change from outside this plugin's own restriction churn. */
  private lastToolsChangeAt = 0;
  private refreshQueued = false;
  /** Depth of the `system-prompt/assemble` waterfall currently in flight. */
  private assembling = 0;
  private discoveryDisposer?: () => void;

  constructor(
    private readonly ctx: ContextLike,
    private readonly presets: AgentPresetsLike,
    initial: ToolManagerSettings,
  ) {
    this.settings = initial;
  }

  start(): void {
    this.registerDiscovery();
    const agents = this.ctx.get<{ list(): AgentLike[] }>("agents");
    for (const agent of agents?.list() ?? []) this.install(agent);

    this.ctx.on("agent/created", (...args: unknown[]) => {
      const payload = asCreated(args[0]);
      if (payload) this.install(payload.agent);
    });
    this.ctx.on("agent/disposed", (...args: unknown[]) => {
      const payload = asCreated(args[0]);
      if (payload) this.uninstall(payload.agent);
    });
    this.ctx.on("tools/change", () => {
      // Registry churn caused by this plugin's own restriction is not evidence
      // that a Preset composition is still mounting.
      if (!this.mutating) this.lastToolsChangeAt = Date.now();
      this.queueBaselineRefresh();
    });
    this.ctx.on("agent/pre-step", (...args: unknown[]) => this.onPreStep(args[0], args[1]));
  }

  update(next: ToolManagerSettings): void {
    this.settings = next;
    for (const state of this.states.values()) {
      const known = new Set(
        resolveActiveGroups(this.policy(state.agent), state.baseline)
          .map((group) => group.name.toLowerCase()),
      );
      for (const name of [...state.exposures]) {
        if (!known.has(name.toLowerCase())) state.exposures.delete(name);
      }
      this.reconcile(state);
    }
  }

  private install(agent: AgentLike): void {
    if (this.states.has(agent)) return;

    // A Preset composition registers its tools a beat after the Agent exists.
    // Attaching anyway — even with an empty baseline — is what puts the
    // request-surface filter in place before the Session's first model step.
    // Skipping the attach because the tools service is not readable yet is
    // exactly how a first request ends up carrying every tool.
    const baselineSchemas = this.inheritedSchemas(agent);
    const baseline = baselineSchemas.map((schema) => schema.name);
    const groups = resolveActiveGroups(this.policy(agent), baseline);
    const restored = restoredExposureNames(agent.session);
    const exposures = new Set<string>();
    for (const name of restored) {
      const group = findGroup(groups, name);
      if (group) exposures.add(group.name);
    }
    const state: AgentState = {
      agent,
      baseline,
      baselineSchemas,
      exposures,
      lastPreset: this.presetId(agent),
    };
    this.states.set(agent, state);
    this.observe(state);
    this.installLocalPolicy(state);
    this.reconcile(state);
    // A Preset composition registers its tools a beat after the Agent exists,
    // and a tools/change emitted inside that window is dropped while `mutating`
    // is set. Without this timer a Session created in that window keeps an empty
    // baseline for its whole life — and under PTC mode nothing later corrects
    // it, because the request surface carries only the transport.
    if (state.baseline.length === 0) this.scheduleBaselineRecovery(state);
  }

  private uninstall(agent: AgentLike): void {
    const state = this.states.get(agent);
    if (!state) return;
    this.states.delete(agent);
    this.mutating = true;
    try {
      state.restriction?.();
      state.guard?.();
      state.assemblyFilter?.();
    } finally {
      this.mutating = false;
    }
  }

  private presetId(agent: AgentLike): string | undefined {
    return this.presets.composedPreset(agent.ctx);
  }

  private policy(agent: AgentLike): PresetToolPolicy {
    return policyFor(this.settings, this.presetId(agent));
  }

  private hostTools(): ToolRuntimeLike | undefined {
    return this.ctx.get<ToolRuntimeLike>("tools");
  }

  private inheritedSchemas(agent: AgentLike): ToolSchemaLike[] {
    const scopedTools = agent.ctx.get<ToolRuntimeLike>("tools");
    if (!scopedTools) return [];
    return scopedTools.schemas(agent);
  }

  private observe(state: AgentState): void {
    const presetId = this.presetId(state.agent);
    if (!presetId || state.agent.id === TOOL_MANAGER_PROBE_SESSION_ID) return;
    this.observeSchemas(presetId, state.baselineSchemas);
  }

  observeSchemas(presetId: string, schemasToAdd: readonly ToolSchemaLike[]): void {
    let schemas = this.observedSchemas.get(presetId);
    if (!schemas) {
      schemas = new Map();
      this.observedSchemas.set(presetId, schemas);
    }
    for (const schema of schemasToAdd) schemas.set(schema.name, schema);
  }

  observedSchemasFor(presetId: string): ToolSchemaLike[] {
    return [...(this.observedSchemas.get(presetId)?.values() ?? [])];
  }

  private installLocalPolicy(state: AgentState): void {
    this.ensureGuard(state);
    if (typeof state.agent.ctx.on !== "function") return;
    // The request surface is the one path every model step must pass through,
    // and DSH assembles it BEFORE the `agent/pre-step` waterfall runs — so this
    // listener is the earliest policy hook a Session can have. A baseline
    // captured at `agent/created` may still lack the Preset composition's tools
    // (an empty baseline means an empty deny set), which is why the deny set is
    // derived from the tools THIS request exposes rather than from the snapshot.
    state.assemblyFilter = state.agent.ctx.on("system-prompt/assemble", async (...args: unknown[]) => {
      const next = args.at(-1);
      if (typeof next !== "function") return args[0];
      this.assembling += 1;
      try {
        // PTC mode collapses the request surface to the reserved transport, so
        // the generated SDK rendered inside next() IS the catalog the model
        // sees. Restricting after next() would be too late for the FIRST
        // request, and the assemble-filter below can never learn the hidden
        // names from a one-tool surface. Applying the policy before the render
        // is the only point where a PTC request can carry it; a re-entrant
        // assemble caused by tools/change sees the fresh baseline and only
        // renders.
        this.ensureRequestBaseline(state);
        const assembly = await (next as () => Promise<unknown>)();
        if (!isPromptAssembly(assembly)) return assembly;
        const names = assembly.tools.map((schema) => schema.name);
        this.adoptRequestSurface(state, names, assembly.tools);
        const hidden = new Set(denyNames(this.policy(state.agent), names, state.exposures));
        if (hidden.size === 0) return assembly;
        return {
          ...assembly,
          tools: assembly.tools.filter((schema) => !hidden.has(schema.name)),
          sections: assembly.sections.filter((section) => {
            const toolName = section.name.startsWith("tool:") ? section.name.slice("tool:".length) : undefined;
            return toolName === undefined || !hidden.has(toolName);
          }),
        };
      } finally {
        this.assembling -= 1;
      }
    }) as (() => void) | undefined;
  }

  /** Install the dispatch-level guard once the Agent exposes its tools service. */
  private ensureGuard(state: AgentState): void {
    if (state.guard) return;
    const scopedTools = state.agent.ctx.get<ToolRuntimeLike>("tools");
    if (!scopedTools?.guard) return;
    state.guard = scopedTools.guard((execution) => {
      const policy = this.policy(state.agent);
      const hidden = denyNames(policy, state.baseline, state.exposures);
      if (!hidden.includes(execution.name)) return undefined;
      if (policy.disabled.includes(execution.name)) {
        return `tool ${JSON.stringify(execution.name)} is disabled by the tool-manager policy for this Agent preset`;
      }
      const open = new Set([...state.exposures].map((name) => name.toLowerCase()));
      const group = resolveActiveGroups(policy, state.baseline).find((item) => (
        !open.has(item.name.toLowerCase()) && item.tools.includes(execution.name)
      ));
      if (group) {
        return `tool ${JSON.stringify(execution.name)} belongs to on-demand group ${JSON.stringify(group.name)} which is not open; call ${DISCOVERY_TOOL_NAME} with ${JSON.stringify({ group: group.name })} first`;
      }
      return `tool ${JSON.stringify(execution.name)} is unavailable under the tool-manager policy for this Agent preset`;
    });
  }

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
  private adoptRequestSurface(state: AgentState, names: string[], schemas: ToolSchemaLike[]): void {
    if (names.length === 0) return;
    // PTC mode collapses the request surface to the reserved transport: the
    // model may call only `run_code`, and every other tool arrives through the
    // generated SDK. Adopting that surface would record a "catalog" of one
    // transport name that no group can ever match — the policy would silently
    // stop hiding anything, and `refreshAllBaselines()` would never resample it
    // because the baseline is no longer empty. Sample the registry instead.
    if (this.isCollapsedSurface(names)) {
      this.scheduleBaselineRecovery(state);
      return;
    }
    const known = new Set(state.baseline);
    if (names.every((name) => known.has(name))) return;
    const merged = [...state.baseline];
    const byName = new Map(state.baselineSchemas.map((schema) => [schema.name, schema]));
    for (const [index, name] of names.entries()) {
      if (name === undefined || known.has(name)) continue;
      known.add(name);
      merged.push(name);
      const schema = schemas[index];
      if (schema !== undefined) byName.set(name, schema);
    }
    state.baseline = merged;
    state.baselineSchemas = [...byName.values()];
    this.observe(state);
    this.ensureGuard(state);
    // Never call reconcile() (and therefore tools.restrict()) here.
    // restrict() emits tools/change synchronously and its listeners re-do real
    // work for every live Agent (DSH recomputes and deep-clones the whole tool
    // catalog), so doing it per opened Session turns into a noticeable global
    // slowdown — and from inside the assemble waterfall it can even re-enter
    // assemble() forever. The request is already filtered from `names`, and the
    // guard above now reads the adopted baseline, so neither correctness nor
    // dispatch depends on the registry-level restriction. It is applied by the
    // throttled refresh path on the next genuine tools/change instead.
  }

  /**
   * Whether a request surface is PTC mode's collapsed transport: `run_code` is
   * the only tool the model may call directly, and every other tool is projected
   * into the generated SDK. Such a surface describes the presentation, never the
   * registry, so it must not shape the baseline.
   */
  private isCollapsedSurface(names: readonly string[]): boolean {
    return names.length > 0 && names.every((name) => name === PTC_TRANSPORT_NAME);
  }

  /**
   * Whether one Agent's baseline needs a new sample: never captured, collapsed
   * to the PTC transport, or taken under a different Preset.
   * @param state - the Agent state to inspect.
   * @param preset - the Agent's current Preset id.
   * @returns whether the baseline must be resampled.
   */
  private baselineIsStale(
    state: AgentState,
    preset: string | undefined = this.presetId(state.agent),
  ): boolean {
    return state.baseline.length === 0
      || this.isCollapsedSurface(state.baseline)
      || state.lastPreset !== preset;
  }

  /**
   * Whether the tools service presents PTC mode for this Agent.
   *
   * `run_code` exists in the visibility view only under a PTC presentation, so
   * its presence is the cheapest reliable answer — and unlike `schemas()` a
   * single lookup does not deep-clone the whole catalog on every assembly.
   * @param agent - the Agent whose presentation to inspect.
   * @returns whether the Agent is presented through the PTC transport.
   */
  private isPtcScope(agent: AgentLike): boolean {
    const tools = agent.ctx.get<ToolRuntimeLike>("tools");
    if (!tools) return false;
    if (typeof tools.get === "function") {
      try {
        return tools.get(PTC_TRANSPORT_NAME, agent) !== undefined;
      } catch {
        // Older runtimes may expose get() with different semantics; fall back
        // to the catalog projection below.
      }
    }
    try {
      return tools.schemas(agent).some((schema) => schema.name === PTC_TRANSPORT_NAME);
    } catch {
      return false;
    }
  }

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
  private isSettledSample(
    previous: readonly string[],
    previousPreset: string | undefined,
    preset: string | undefined,
    names: readonly string[],
  ): boolean {
    if (names.length === 0) return false;
    if (previous.length === 0 || this.isCollapsedSurface(previous)) return true;
    if (previousPreset === preset) return true;
    return Date.now() - this.lastToolsChangeAt >= PRESET_SETTLE_MS;
  }

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
  private resampleBaseline(state: AgentState, merge = false): boolean {
    const preset = this.presetId(state.agent);
    const stale = this.baselineIsStale(state, preset);
    if (!stale && !merge) return true;
    const previous = [...state.baseline];
    const previousPreset = state.lastPreset;
    this.mutating = true;
    try {
      state.restriction?.();
      state.restriction = undefined;
      state.lastDeny = undefined;
      const schemas = this.inheritedSchemas(state.agent);
      if (schemas.length === 0) return false;
      const names = schemas.map((schema) => schema.name);
      if (stale) {
        const complete = this.isSettledSample(previous, previousPreset, preset, names);
        const attempts = (state.sampleRetries ?? 0) + 1;
        if (!complete && attempts <= SAMPLE_SETTLE_ATTEMPTS) {
          state.sampleRetries = attempts;
          return false;
        }
        state.sampleRetries = 0;
        state.baseline = names;
        state.baselineSchemas = schemas;
        state.lastPreset = preset;
      } else {
        const known = new Set(previous);
        const added = schemas.filter((schema) => !known.has(schema.name));
        if (added.length === 0) return true;
        const byName = new Map(state.baselineSchemas.map((schema) => [schema.name, schema]));
        for (const schema of added) byName.set(schema.name, schema);
        state.baseline = [...previous, ...added.map((schema) => schema.name)];
        state.baselineSchemas = [...byName.values()];
      }
      this.observe(state);
      this.ensureGuard(state);
      return true;
    } finally {
      this.mutating = false;
    }
  }

  /**
   * Land the policy before the generated SDK is rendered.
   *
   * Only PTC mode needs this: its request surface carries nothing but the
   * transport, so the assemble filter above cannot derive the hidden names. This
   * runs before `next()`, where the SDK text is produced from the registry's
   * current visibility, so a restriction applied here reaches the FIRST request.
   * @param state - the Agent whose request is being assembled.
   */
  private ensureRequestBaseline(state: AgentState): void {
    if (this.assembling > 1) return;
    if (!this.isPtcScope(state.agent)) return;
    if (!this.baselineIsStale(state)) return;
    try {
      const accepted = this.resampleBaseline(state);
      this.reconcile(state);
      if (!accepted) this.scheduleBaselineRecovery(state);
    } catch {
      // The request must render even when recovery fails; the next assemble retries.
    }
  }

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
  private scheduleBaselineRecovery(state: AgentState, attempt = 0): void {
    if (this.states.get(state.agent) !== state) return;
    if (!this.baselineIsStale(state)) return;
    if (attempt === 0) {
      if (state.recovering) return;
      state.recovering = true;
    }
    if (attempt > BASELINE_RECOVERY_ATTEMPTS) {
      state.recovering = false;
      return;
    }
    const timer = setTimeout(() => {
      if (this.states.get(state.agent) !== state) return;
      if (!this.baselineIsStale(state)) {
        state.recovering = false;
        return;
      }
      if (!this.resampleBaseline(state)) {
        this.scheduleBaselineRecovery(state, attempt + 1);
        return;
      }
      state.recovering = false;
      this.reconcile(state);
    }, attempt === 0 ? 0 : BASELINE_RECOVERY_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  private queueBaselineRefresh(): void {
    if (this.mutating || this.refreshQueued) return;
    this.refreshQueued = true;
    // Coalesce registry churn into one sample per window. A tools/change storm
    // while Sessions open must not turn into one full catalog rescan per event
    // — that is what let a few events per second become a 100% CPU loop.
    const timer = setTimeout(() => {
      this.refreshQueued = false;
      this.refreshAllBaselines();
    }, 250);
    (timer as { unref?: () => void }).unref?.();
  }

  private refreshAllBaselines(): void {
    const states = [...this.states.values()];
    // A resample means dropping the live restriction first and re-applying it
    // afterwards: two tools/change emissions per Agent per window. A stale state
    // is replaced wholesale (a Preset switch may legitimately shrink the
    // catalog); a fresh one only GROWS, because a baseline sampled before the
    // Preset finished mounting is a strict subset of the real catalog and
    // losing it would leave nothing to deny.
    for (const state of states) {
      if (this.states.get(state.agent) !== state) continue;
      this.resampleBaseline(state, true);
    }
    for (const state of states) {
      if (this.states.get(state.agent) === state) this.reconcile(state);
    }
  }

  private openGroup(agent: AgentLike, requestedGroup: string | undefined): ToolListResult {
    const state = this.states.get(agent);
    if (!state) throw new Error("tool manager is not attached to this Agent");
    const groups = resolveActiveGroups(this.policy(agent), state.baseline);
    const known = groups.map((item) => item.name).join(", ") || "(none)";
    if (requestedGroup === undefined || requestedGroup.trim() === "") {
      throw new Error(`group is required; known groups: ${known}`);
    }
    const group = findGroup(groups, requestedGroup);
    if (!group) {
      throw new Error(`unknown tool group ${JSON.stringify(requestedGroup)}; known groups: ${known}`);
    }
    state.exposures.add(group.name);
    this.reconcile(state);
    return {
      name: group.name,
      ...(group.description ? { description: group.description } : {}),
      tools: group.tools,
    };
  }

  private async onPreStep(payload: unknown, next: unknown): Promise<unknown> {
    const decision = typeof next === "function"
      ? await (next as () => Promise<unknown>)()
      : payload;
    if (!isEnterDecision(decision)) return decision;
    const agent = asCreated(payload)?.agent;
    if (!agent) return decision;
    if (!this.states.has(agent)) this.install(agent);
    const state = this.states.get(agent);
    if (!state) return decision;
    const groups = resolveActiveGroups(this.policy(agent), state.baseline);
    return applyCatalogDecision(
      decision,
      catalogEntriesFromGroups(groups),
      catalogHistory(agent),
    );
  }

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
  private registerDiscovery(): void {
    const tools = this.hostTools();
    if (!tools) return;
    this.mutating = true;
    try {
      this.discoveryDisposer?.();
      this.discoveryDisposer = tools.register(this.discoveryDefinition());
    } catch (error) {
      this.discoveryDisposer = undefined;
      this.warn(`tool-manager failed to register ${DISCOVERY_TOOL_NAME}: ${errorMessage(error)}`);
    } finally {
      this.mutating = false;
    }
  }

  private discoveryDefinition(): unknown {
    return {
      name: DISCOVERY_TOOL_NAME,
      description:
        "Open one on-demand tool group by exact name from this session's tool-group catalog. All tools in that group become available for the rest of this session.",
      parameters: {
        type: "object",
        properties: {
          group: {
            type: "string",
            description: "Exact group name from this session's tool-group catalog.",
          },
        },
        required: ["group"],
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: JSON.stringify(value, null, 2) },
        ],
      },
      execute: async (
        args: { group?: string },
        exec?: { agent?: AgentLike },
      ) => {
        const agent = exec?.agent;
        if (!agent) throw new Error("tool_list requires a calling agent");
        return this.openGroup(agent, args.group);
      },
    };
  }

  private reconcile(state: AgentState): void {
    const deny = denyNames(
      this.policy(state.agent),
      state.baseline,
      state.exposures,
    );
    // Releasing and re-applying a restriction emits tools/change twice, and a
    // tools/change listener can schedule the next refresh — so re-applying an
    // unchanged deny turns one refresh into an endless event storm. Nothing
    // changed means nothing to do. A missing restriction (a previous apply
    // failed) is retried even when the deny set matches.
    if (state.restriction !== undefined && sameNames(state.lastDeny ?? [], deny)) return;
    state.lastDeny = [...deny];
    this.mutating = true;
    try {
      state.restriction?.();
      state.restriction = undefined;
      if (deny.length === 0) return;
      state.restriction = this.applyDeny(state.agent, deny);
    } finally {
      this.mutating = false;
    }
  }

  private applyDeny(agent: AgentLike, deny: string[]): (() => void) | undefined {
    const scopedTools = agent.ctx.get<ToolRuntimeLike>("tools");
    if (!scopedTools) return undefined;
    try {
      return scopedTools.restrict({ deny });
    } catch (error) {
      const known = parseKnownRestrictable(error);
      if (!known) {
        this.warn(`tool-manager restrict failed: ${errorMessage(error)}`);
        return undefined;
      }
      const next = deny.filter((name) => known.has(name));
      if (next.length === 0) return undefined;
      try {
        return scopedTools.restrict({ deny: next });
      } catch (retryError) {
        this.warn(`tool-manager restrict retry failed: ${errorMessage(retryError)}`);
        return undefined;
      }
    }
  }

  private warn(message: string): void {
    const logger = this.ctx.get<{ warn?(format: unknown, ...rest: unknown[]): void }>("logger");
    logger?.warn?.(message);
  }

  async dispose(): Promise<void> {
    for (const agent of [...this.states.keys()]) this.uninstall(agent);
    this.mutating = true;
    try {
      this.discoveryDisposer?.();
      this.discoveryDisposer = undefined;
    } finally {
      this.mutating = false;
    }
  }
}

function asCreated(value: unknown): { agent: AgentLike } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const agent = (value as { agent?: AgentLike }).agent;
  if (!agent || typeof agent !== "object" || !("ctx" in agent)) return undefined;
  return { agent };
}

function isEnterDecision(value: unknown): value is { kind: "enter"; messages: unknown[] } {
  if (value === null || typeof value !== "object") return false;
  const record = value as { kind?: unknown; messages?: unknown };
  return record.kind === "enter" && Array.isArray(record.messages);
}

function isPromptAssembly(value: unknown): value is {
  tools: ToolSchemaLike[];
  sections: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
} {
  if (value === null || typeof value !== "object") return false;
  const record = value as { tools?: unknown; sections?: unknown };
  return Array.isArray(record.tools) && Array.isArray(record.sections);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
