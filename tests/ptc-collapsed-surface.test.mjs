import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolPolicyRuntime } from "../dist/runtime.js";

/**
 * PTC mode coverage: the request surface carries only `run_code` (every other
 * tool is projected into the generated SDK). Adopting that surface as the
 * baseline would record a one-name "catalog" that no group can match, silently
 * disabling the whole preset policy for the Session. The baseline must come
 * from the registry instead, and applying it must stay OUT of the assemble
 * waterfall: a restricted registry re-emits tools/change and PTC re-assembles.
 */

const schema = (name) => ({ name, description: name, parameters: {} });
const RUN_CODE = "run_code";

const ALL = [
  "edit", "glob", "grep", "learn_meme", "read", "read_image", "send_meme",
  "sidebar_open", "siyuan_read", "siyuan_write", "tool_list", "web_fetch", "web_search", "write",
];
const COMPANION_POLICY = {
  disabled: ["edit", "write", "sidebar_open"],
  groups: [
    { name: "网页检索与抓取", patterns: ["web_fetch", "web_search"] },
    { name: "思源笔记读取", patterns: ["siyuan_read"] },
    { name: "思源笔记编辑", patterns: ["siyuan_write"] },
    { name: "表情包收录", patterns: ["learn_meme"] },
    { name: "本地文件读取", patterns: ["glob", "grep", "read", "read_image"] },
  ],
};
const SETTINGS = {
  presets: {
    companion: COMPANION_POLICY,
    // Same policy under a second id, so a Preset switch is observable.
    companion2: COMPANION_POLICY,
  },
};

function blankSession() {
  return { seq: 0, inheritedEventCount: 0, eventAt: () => undefined, surface: { nodes: [] } };
}

const tick = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ toolsAtCreate?: boolean, presentation?: "native" | "ptc" }} options
 */
function harness(options) {
  let presentation = options.presentation ?? "native";
  const handlers = new Map();
  const restrictCalls = [];
  let denied = new Set();
  let guardFn;
  let assembleFn;
  let discovery;
  let toolsAvailable = options.toolsAtCreate !== false;
  let registryNames = options.partialRegistry
    ?? (options.toolsAtCreate === false ? [] : ALL.slice());

  const registry = () => presentation === "ptc" ? [...registryNames, RUN_CODE] : registryNames.slice();
  const scopedTools = {
    schemas() { return registry().filter((name) => !denied.has(name)).map(schema); },
    register() { throw new Error("scope register should not be used"); },
    restrict({ deny }) {
      restrictCalls.push([...deny]);
      const previous = denied;
      denied = new Set(deny);
      return () => { denied = previous; };
    },
    guard(callback) { guardFn = callback; return () => { guardFn = undefined; }; },
  };
  const agent = {
    id: "session-ptc-0001",
    ctx: {
      get(name) { return name === "tools" && toolsAvailable ? scopedTools : undefined; },
      on(name, handler) {
        if (name === "system-prompt/assemble") assembleFn = handler;
        return () => {};
      },
    },
    session: blankSession(),
  };
  const agents = [agent];
  const context = {
    get(name) {
      if (name === "tools") {
        return {
          schemas() { return []; },
          register(definition) { discovery = definition; return () => {}; },
          restrict() { throw new Error("host restrict"); },
        };
      }
      if (name === "agents") return { list: () => agents };
      return undefined;
    },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  let presetId = "companion";
  let renderDenied = [];
  const presets = { composedPreset: () => presetId };
  const runtime = new ToolPolicyRuntime(context, presets, SETTINGS);

  return {
    runtime,
    agent,
    agents,
    async start() { runtime.start(); },
    /** The Preset composition finally registers its tools. */
    publishTools() { toolsAvailable = true; registryNames = ALL.slice(); },
    /** DSH order: systemPrompt.assemble() -> agent/pre-step waterfall. */
    async assemble() {
      const tools = presentation === "ptc" ? [schema(RUN_CODE)] : registryNames.map(schema);
      const raw = {
        tools,
        sections: tools.map((item) => ({ name: "tool:" + item.name })),
        contexts: [],
        variables: {},
      };
      // Capture the restriction state at the moment the SDK would render.
      const next = async () => { renderDenied = [...denied]; return raw; };
      return assembleFn ? assembleFn({}, {}, next) : raw;
    },
    async step() {
      const assembly = await this.assemble();
      for (const handler of handlers.get("agent/pre-step") ?? []) {
        await handler({ agent, messages: [], turn: 1, step: 1 }, async () => ({ kind: "enter", messages: [{}] }));
      }
      return assembly.tools.map((item) => item.name);
    },
    async toolsChange() {
      for (const handler of handlers.get("tools/change") ?? []) handler();
      await new Promise((resolve) => setImmediate(resolve));
    },
    async openGroup(name) {
      return discovery.execute({ group: name }, { agent });
    },
    /** Simulate a WebUI Preset switch: the new composition presents PTC mode. */
    switchPreset(nextPresetId, mode = "ptc") {
      presetId = nextPresetId;
      presentation = mode;
      registryNames = ALL.slice();
    },
    /** Simulate a composition that has only partially mounted its tools. */
    setRegistry(names) { toolsAvailable = true; registryNames = [...names]; },
    restoreRegistry() { toolsAvailable = true; registryNames = ALL.slice(); },
    get guard() { return guardFn; },
    restrictCalls,
    get denied() { return [...denied]; },
    get renderDenied() { return [...renderDenied]; },
  };
}

describe("PTC mode keeps the preset policy", () => {
  it("never adopts the run_code transport as the catalog baseline", async () => {
    const h = harness({ toolsAtCreate: false, presentation: "ptc" });
    await h.start();

    // First request arrives while the Preset tools are still missing: the
    // surface is the transport only. It must NOT become the baseline.
    const first = await h.assemble();
    assert.deepEqual(first.tools.map((item) => item.name), [RUN_CODE]);

    // The composition lands a beat later; the registry sample must recover the
    // catalog and apply the restriction (deny every closed group member).
    h.publishTools();
    await tick();
    assert.ok(h.restrictCalls.length > 0, "the policy restriction must be applied");
    const deny = h.restrictCalls.at(-1);
    assert.ok(deny.includes("web_fetch"), "closed group members are denied: " + deny.join(","));
    assert.ok(deny.includes("siyuan_read"));
    assert.ok(!deny.includes(RUN_CODE), "the PTC transport is never denied");
    assert.ok(!deny.includes("send_meme"), "ungrouped tools stay available");
    await h.runtime.dispose();
  });

  it("serves the group catalog and opens groups after recovery", async () => {
    const h = harness({ toolsAtCreate: false, presentation: "ptc" });
    await h.start();
    await h.assemble();
    h.publishTools();
    await tick();

    const opened = await h.openGroup("网页检索与抓取");
    assert.equal(opened.name, "网页检索与抓取");
    assert.deepEqual(opened.tools.sort(), ["web_fetch", "web_search"]);
    // Opened members are excluded from the deny set, closed groups stay hidden.
    const deny = h.restrictCalls.at(-1);
    assert.ok(!deny.includes("web_fetch"));
    assert.ok(deny.includes("siyuan_read"));
    await h.runtime.dispose();
  });

  it("recovers even when the baseline was already collapsed", async () => {
    const h = harness({ toolsAtCreate: false, presentation: "ptc" });
    await h.start();
    h.publishTools();
    // Recovery runs on its own timer; the second assemble proves stability.
    await h.assemble();
    await tick();
    const before = h.restrictCalls.length;
    await h.assemble();
    await tick();
    assert.equal(h.restrictCalls.length, before, "further assemblies must not re-apply the policy");
    const deny = h.restrictCalls.at(-1);
    assert.ok(deny.includes("web_fetch"));
    assert.ok(h.guard, "the dispatch guard is installed on the recovered baseline");
    assert.match(h.guard({ name: "siyuan_read" }), /belongs to on-demand group/);
    await h.runtime.dispose();
  });

  it("leaves the native presentation untouched", async () => {
    const h = harness({ presentation: "native" });
    await h.start();
    const assembled = await h.assemble();
    const names = assembled.tools.map((item) => item.name);
    assert.ok(!names.includes("web_fetch"), "closed group members are filtered");
    assert.ok(!names.includes("edit"), "disabled tools are filtered");
    assert.ok(names.includes("send_meme"));
    await h.runtime.dispose();
  });

  it("reapplies the policy before the SDK renders when a Session switches to PTC", async () => {
    const h = harness({});
    await h.start();
    assert.equal(h.restrictCalls.length, 1, "native install applies the policy once");

    // The WebUI mode switch: another Preset, presented through PTC.
    h.switchPreset("companion2", "ptc");
    const first = await h.assemble();

    assert.deepEqual(first.tools.map((item) => item.name), [RUN_CODE]);
    // The restriction must be live BEFORE next() renders the SDK: this is the
    // only point where a PTC request can carry the preset policy.
    assert.ok(
      h.renderDenied.includes("web_fetch"),
      "restriction at render time: " + h.renderDenied.join(","),
    );
    assert.ok(h.renderDenied.includes("edit"));
    assert.ok(!h.renderDenied.includes(RUN_CODE), "the transport is never denied");

    // The catalog followed: the group is known and can be opened.
    const opened = await h.openGroup("网页检索与抓取");
    assert.deepEqual(opened.tools.slice().sort(), ["web_fetch", "web_search"]);
    await h.runtime.dispose();
  });

  it("refuses a mid-transition catalog and applies the settled one", async () => {
    const h = harness({});
    await h.start();
    h.switchPreset("companion2", "ptc");
    // The new composition is still mounting: two tools out of fourteen.
    h.setRegistry(["send_meme", "tool_list"]);
    await h.toolsChange();

    await h.assemble();
    // The partial sample must not replace the catalog: the old baseline still
    // resolves the groups, so the policy keeps hiding the right names.
    const opened = await h.openGroup("网页检索与抓取");
    assert.deepEqual(opened.tools.slice().sort(), ["web_fetch", "web_search"]);

    // The mount finishes and the registry goes quiet; the next sample sticks.
    h.restoreRegistry();
    await tick(350);
    await h.assemble();
    // `网页检索与抓取` is open from the call above, so its members stay visible;
    // the still-closed group proves the settled catalog drives the deny set.
    assert.ok(h.renderDenied.includes("siyuan_read"), "settled catalog is applied");
    assert.ok(!h.renderDenied.includes("web_fetch"), "opened group stays exposed");
    await h.runtime.dispose();
  });

  it("grows a baseline sampled before the Preset finished mounting", async () => {
    const h = harness({ partialRegistry: ["send_meme", "tool_list", "web_fetch"] });
    await h.start();
    // The composition finishes mounting a moment later.
    h.restoreRegistry();
    await h.toolsChange();
    await tick(320);
    await h.assemble();
    assert.ok(
      h.renderDenied.includes("siyuan_read"),
      "grow-only refresh recovered the catalog: " + h.renderDenied.join(","),
    );
    assert.ok(h.renderDenied.includes("learn_meme"));
    await h.runtime.dispose();
  });

  it("never shrinks the baseline to a partially mounted native surface", async () => {
    const h = harness({});
    await h.start();
    h.switchPreset("companion2", "native");
    // A Preset switch that is still mounting: four tools, one of them new to the
    // baseline. Adopting this surface must not erase the other ten.
    h.setRegistry(["send_meme", "tool_list", "web_fetch", "ops_result"]);

    await h.assemble();
    assert.ok(
      h.denied.includes("siyuan_read"),
      "catalog preserved at render time: " + h.denied.join(","),
    );
    assert.ok(h.denied.includes("learn_meme"));
    const opened = await h.openGroup("思源笔记读取");
    assert.deepEqual(opened.tools, ["siyuan_read"]);
    await h.runtime.dispose();
  });
});
