import { applyCatalogDecision, catalogEntriesFromGroups, catalogHistory, } from "./catalog.js";
import { restoredExposureNames } from "./exposure-history.js";
import { denyNames, findGroup, parseKnownRestrictable, policyFor, resolveActiveGroups, sameNames, } from "./policy.js";
import { DISCOVERY_TOOL_NAME, TOOL_MANAGER_PROBE_SESSION_ID, } from "./types.js";
export class ToolPolicyRuntime {
    ctx;
    presets;
    settings;
    states = new Map();
    observedSchemas = new Map();
    mutating = false;
    refreshQueued = false;
    discoveryDisposer;
    constructor(ctx, presets, initial) {
        this.ctx = ctx;
        this.presets = presets;
        this.settings = initial;
    }
    start() {
        this.registerDiscovery();
        const agents = this.ctx.get("agents");
        for (const agent of agents?.list() ?? [])
            this.install(agent);
        this.ctx.on("agent/created", (...args) => {
            const payload = asCreated(args[0]);
            if (payload)
                this.install(payload.agent);
        });
        this.ctx.on("agent/disposed", (...args) => {
            const payload = asCreated(args[0]);
            if (payload)
                this.uninstall(payload.agent);
        });
        this.ctx.on("tools/change", () => this.queueBaselineRefresh());
        this.ctx.on("agent/pre-step", (...args) => this.onPreStep(args[0], args[1]));
    }
    update(next) {
        this.settings = next;
        for (const state of this.states.values()) {
            const known = new Set(resolveActiveGroups(this.policy(state.agent), state.baseline)
                .map((group) => group.name.toLowerCase()));
            for (const name of [...state.exposures]) {
                if (!known.has(name.toLowerCase()))
                    state.exposures.delete(name);
            }
            this.reconcile(state);
        }
    }
    install(agent) {
        if (this.states.has(agent))
            return;
        // A Preset composition registers its tools a beat after the Agent exists.
        // Attaching anyway — even with an empty baseline — is what puts the
        // request-surface filter in place before the Session's first model step.
        // Skipping the attach because the tools service is not readable yet is
        // exactly how a first request ends up carrying every tool.
        const baselineSchemas = this.inheritedSchemas(agent);
        const baseline = baselineSchemas.map((schema) => schema.name);
        const groups = resolveActiveGroups(this.policy(agent), baseline);
        const restored = restoredExposureNames(agent.session);
        const exposures = new Set();
        for (const name of restored) {
            const group = findGroup(groups, name);
            if (group)
                exposures.add(group.name);
        }
        const state = {
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
    }
    uninstall(agent) {
        const state = this.states.get(agent);
        if (!state)
            return;
        this.states.delete(agent);
        this.mutating = true;
        try {
            state.restriction?.();
            state.guard?.();
            state.assemblyFilter?.();
        }
        finally {
            this.mutating = false;
        }
    }
    presetId(agent) {
        return this.presets.composedPreset(agent.ctx);
    }
    policy(agent) {
        return policyFor(this.settings, this.presetId(agent));
    }
    hostTools() {
        return this.ctx.get("tools");
    }
    inheritedSchemas(agent) {
        const scopedTools = agent.ctx.get("tools");
        if (!scopedTools)
            return [];
        return scopedTools.schemas(agent);
    }
    observe(state) {
        const presetId = this.presetId(state.agent);
        if (!presetId || state.agent.id === TOOL_MANAGER_PROBE_SESSION_ID)
            return;
        this.observeSchemas(presetId, state.baselineSchemas);
    }
    observeSchemas(presetId, schemasToAdd) {
        let schemas = this.observedSchemas.get(presetId);
        if (!schemas) {
            schemas = new Map();
            this.observedSchemas.set(presetId, schemas);
        }
        for (const schema of schemasToAdd)
            schemas.set(schema.name, schema);
    }
    observedSchemasFor(presetId) {
        return [...(this.observedSchemas.get(presetId)?.values() ?? [])];
    }
    installLocalPolicy(state) {
        this.ensureGuard(state);
        if (typeof state.agent.ctx.on !== "function")
            return;
        // The request surface is the one path every model step must pass through,
        // and DSH assembles it BEFORE the `agent/pre-step` waterfall runs — so this
        // listener is the earliest policy hook a Session can have. A baseline
        // captured at `agent/created` may still lack the Preset composition's tools
        // (an empty baseline means an empty deny set), which is why the deny set is
        // derived from the tools THIS request exposes rather than from the snapshot.
        state.assemblyFilter = state.agent.ctx.on("system-prompt/assemble", async (...args) => {
            const next = args.at(-1);
            if (typeof next !== "function")
                return args[0];
            const assembly = await next();
            if (!isPromptAssembly(assembly))
                return assembly;
            const names = assembly.tools.map((schema) => schema.name);
            this.adoptRequestSurface(state, names, assembly.tools);
            const hidden = new Set(denyNames(this.policy(state.agent), names, state.exposures));
            if (hidden.size === 0)
                return assembly;
            return {
                ...assembly,
                tools: assembly.tools.filter((schema) => !hidden.has(schema.name)),
                sections: assembly.sections.filter((section) => {
                    const toolName = section.name.startsWith("tool:") ? section.name.slice("tool:".length) : undefined;
                    return toolName === undefined || !hidden.has(toolName);
                }),
            };
        });
    }
    /** Install the dispatch-level guard once the Agent exposes its tools service. */
    ensureGuard(state) {
        if (state.guard)
            return;
        const scopedTools = state.agent.ctx.get("tools");
        if (!scopedTools?.guard)
            return;
        state.guard = scopedTools.guard((execution) => {
            const policy = this.policy(state.agent);
            const hidden = denyNames(policy, state.baseline, state.exposures);
            if (!hidden.includes(execution.name))
                return undefined;
            if (policy.disabled.includes(execution.name)) {
                return `tool ${JSON.stringify(execution.name)} is disabled by the tool-manager policy for this Agent preset`;
            }
            const open = new Set([...state.exposures].map((name) => name.toLowerCase()));
            const group = resolveActiveGroups(policy, state.baseline).find((item) => (!open.has(item.name.toLowerCase()) && item.tools.includes(execution.name)));
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
     * without a `tools/change`. Tools an existing restriction already denies are
     * never a reason to shrink the baseline — doing so would oscillate — so this
     * only fires when the request carries a name the baseline does not have.
     */
    adoptRequestSurface(state, names, schemas) {
        if (names.length === 0)
            return;
        const known = new Set(state.baseline);
        if (names.every((name) => known.has(name)))
            return;
        state.baseline = [...names];
        state.baselineSchemas = [...schemas];
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
    queueBaselineRefresh() {
        if (this.mutating || this.refreshQueued)
            return;
        this.refreshQueued = true;
        // Coalesce registry churn into one sample per window. A tools/change storm
        // while Sessions open must not turn into one full catalog rescan per event
        // — that is what let a few events per second become a 100% CPU loop.
        const timer = setTimeout(() => {
            this.refreshQueued = false;
            this.refreshAllBaselines();
        }, 250);
        timer.unref?.();
    }
    refreshAllBaselines() {
        this.mutating = true;
        try {
            for (const state of this.states.values()) {
                const preset = this.presetId(state.agent);
                // A resample means dropping the live restriction first and re-applying
                // it afterwards: two tools/change emissions per Agent per window. Only
                // a state whose sample is missing or invalid needs that. Everything
                // else is kept fresh by install() and adoptRequestSurface(), so an
                // ordinary tools/change costs nothing here.
                const needsSample = state.baseline.length === 0 || state.lastPreset !== preset;
                if (!needsSample)
                    continue;
                state.lastPreset = preset;
                state.restriction?.();
                state.restriction = undefined;
                state.lastDeny = undefined;
                const nextSchemas = this.inheritedSchemas(state.agent);
                const next = nextSchemas.map((schema) => schema.name);
                state.baselineSchemas = nextSchemas;
                if (!sameNames(state.baseline, next))
                    state.baseline = next;
                this.observe(state);
            }
        }
        finally {
            this.mutating = false;
        }
        for (const state of this.states.values())
            this.reconcile(state);
    }
    openGroup(agent, requestedGroup) {
        const state = this.states.get(agent);
        if (!state)
            throw new Error("tool manager is not attached to this Agent");
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
    async onPreStep(payload, next) {
        const decision = typeof next === "function"
            ? await next()
            : payload;
        if (!isEnterDecision(decision))
            return decision;
        const agent = asCreated(payload)?.agent;
        if (!agent)
            return decision;
        if (!this.states.has(agent))
            this.install(agent);
        const state = this.states.get(agent);
        if (!state)
            return decision;
        const groups = resolveActiveGroups(this.policy(agent), state.baseline);
        return applyCatalogDecision(decision, catalogEntriesFromGroups(groups), catalogHistory(agent));
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
    registerDiscovery() {
        const tools = this.hostTools();
        if (!tools)
            return;
        this.mutating = true;
        try {
            this.discoveryDisposer?.();
            this.discoveryDisposer = tools.register(this.discoveryDefinition());
        }
        catch (error) {
            this.discoveryDisposer = undefined;
            this.warn(`tool-manager failed to register ${DISCOVERY_TOOL_NAME}: ${errorMessage(error)}`);
        }
        finally {
            this.mutating = false;
        }
    }
    discoveryDefinition() {
        return {
            name: DISCOVERY_TOOL_NAME,
            description: "Open one on-demand tool group by exact name from this session's tool-group catalog. All tools in that group become available for the rest of this session.",
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
                render: (_args, value) => [
                    { type: "text", text: JSON.stringify(value, null, 2) },
                ],
            },
            execute: async (args, exec) => {
                const agent = exec?.agent;
                if (!agent)
                    throw new Error("tool_list requires a calling agent");
                return this.openGroup(agent, args.group);
            },
        };
    }
    reconcile(state) {
        const deny = denyNames(this.policy(state.agent), state.baseline, state.exposures);
        // Releasing and re-applying a restriction emits tools/change twice, and a
        // tools/change listener can schedule the next refresh — so re-applying an
        // unchanged deny turns one refresh into an endless event storm. Nothing
        // changed means nothing to do. A missing restriction (a previous apply
        // failed) is retried even when the deny set matches.
        if (state.restriction !== undefined && sameNames(state.lastDeny ?? [], deny))
            return;
        state.lastDeny = [...deny];
        this.mutating = true;
        try {
            state.restriction?.();
            state.restriction = undefined;
            if (deny.length === 0)
                return;
            state.restriction = this.applyDeny(state.agent, deny);
        }
        finally {
            this.mutating = false;
        }
    }
    applyDeny(agent, deny) {
        const scopedTools = agent.ctx.get("tools");
        if (!scopedTools)
            return undefined;
        try {
            return scopedTools.restrict({ deny });
        }
        catch (error) {
            const known = parseKnownRestrictable(error);
            if (!known) {
                this.warn(`tool-manager restrict failed: ${errorMessage(error)}`);
                return undefined;
            }
            const next = deny.filter((name) => known.has(name));
            if (next.length === 0)
                return undefined;
            try {
                return scopedTools.restrict({ deny: next });
            }
            catch (retryError) {
                this.warn(`tool-manager restrict retry failed: ${errorMessage(retryError)}`);
                return undefined;
            }
        }
    }
    warn(message) {
        const logger = this.ctx.get("logger");
        logger?.warn?.(message);
    }
    async dispose() {
        for (const agent of [...this.states.keys()])
            this.uninstall(agent);
        this.mutating = true;
        try {
            this.discoveryDisposer?.();
            this.discoveryDisposer = undefined;
        }
        finally {
            this.mutating = false;
        }
    }
}
function asCreated(value) {
    if (value === null || typeof value !== "object")
        return undefined;
    const agent = value.agent;
    if (!agent || typeof agent !== "object" || !("ctx" in agent))
        return undefined;
    return { agent };
}
function isEnterDecision(value) {
    if (value === null || typeof value !== "object")
        return false;
    const record = value;
    return record.kind === "enter" && Array.isArray(record.messages);
}
function isPromptAssembly(value) {
    if (value === null || typeof value !== "object")
        return false;
    const record = value;
    return Array.isArray(record.tools) && Array.isArray(record.sections);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=runtime.js.map