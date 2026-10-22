import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolPolicyRuntime } from "../dist/runtime.js";

/**
 * Regression coverage for issue #1: a Session's FIRST model request carried the
 * full tool catalog (including tools the preset disables) because the policy
 * baseline was sampled at `agent/created` while the Preset composition had not
 * registered its tools yet — and DSH assembles the request surface before the
 * `agent/pre-step` waterfall, so nothing else could correct that first call.
 *
 * The fake context mirrors the real order: assemble() first, then agent/pre-step.
 */

const schema = (name) => ({ name, description: name, parameters: {} });

const ALL = [
  "edit", "glob", "grep", "learn_meme", "read", "read_image", "send_meme",
  "sidebar_open", "siyuan_read", "siyuan_write", "tool_list", "web_fetch", "web_search", "write",
];
const SETTINGS = {
  presets: {
    companion: {
      disabled: ["edit", "write", "sidebar_open"],
      groups: [
        { name: "网页检索与抓取", patterns: ["web_fetch", "web_search"] },
        { name: "思源笔记读取", patterns: ["siyuan_read"] },
        { name: "思源笔记编辑", patterns: ["siyuan_write"] },
        { name: "表情包收录", patterns: ["learn_meme"] },
        { name: "本地文件读取", patterns: ["glob", "grep", "read", "read_image"] },
      ],
    },
  },
};
const EXPECTED = ["send_meme", "tool_list"];

function blankSession() {
  return { seq: 0, inheritedEventCount: 0, eventAt: () => undefined, surface: { nodes: [] } };
}

/** @param {{ toolsAtCreate?: boolean, toolsVisibleAtCreate?: boolean }} options */
function harness(options) {
  const handlers = new Map();
  const restrictCalls = [];
  let denied = new Set();
  let guardFn;
  let assembleFn;
  let discovery;
  let toolsAvailable = options.toolsAtCreate !== false;
  let registryNames = options.toolsVisibleAtCreate === false ? [] : ALL.slice();

  const scopedTools = {
    schemas() { return ALL.filter((name) => registryNames.includes(name) && !denied.has(name)).map(schema); },
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
    id: "session-283f3b0d",
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
      if (name === "tools") return { schemas() { return []; }, register(definition) { discovery = definition; return () => {}; }, restrict() { throw new Error("host restrict"); } };
      if (name === "agents") return { list: () => agents };
      return undefined;
    },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  const presets = { composedPreset: (agentCtx) => (agentCtx === agent.ctx ? "companion" : undefined) };
  const runtime = new ToolPolicyRuntime(context, presets, SETTINGS);

  return {
    runtime,
    agent,
    agents,
    async start() { runtime.start(); },
    /** The Preset composition finally registers its tools (no tools/change edge yet). */
    publishTools() { toolsAvailable = true; registryNames = ALL.slice(); },
    /** DSH order: systemPrompt.assemble() -> agent/pre-step waterfall. */
    async assemble() {
      const raw = { tools: ALL.map(schema), sections: ALL.map((name) => ({ name: "tool:" + name })), contexts: [], variables: {} };
      const next = async () => raw;
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
    get guard() { return guardFn; },
    restrictCalls,
    get denied() { return [...denied]; },
  };
}

describe("first request honors the preset policy", () => {
  it("applies the policy when the Agent is created before its tools exist", async () => {
    const h = harness({ toolsAtCreate: false });
    await h.start();
    h.publishTools();

    const first = await h.assemble();
    assert.deepEqual(first.tools.map((item) => item.name), EXPECTED);
    assert.deepEqual(first.sections.map((item) => item.name), EXPECTED.map((name) => "tool:" + name));
    // restrict() is applied one tick after the request surface is adopted: it
    // emits tools/change synchronously, and doing that inside the assemble
    // waterfall can re-enter assemble() forever.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.denied.sort(), ["edit", "glob", "grep", "learn_meme", "read", "read_image", "sidebar_open", "siyuan_read", "siyuan_write", "web_fetch", "web_search", "write"].sort());
    // The dispatch-level guard is installed once the tools service appears.
    assert.ok(h.guard, "guard should be installed when tools become readable");
    assert.match(h.guard({ name: "edit" }), /disabled by the tool-manager policy/);
    assert.match(h.guard({ name: "web_fetch" }), /belongs to on-demand group/);
    await h.runtime.dispose();
  });

  it("applies the policy when the baseline was sampled empty", async () => {
    const h = harness({ toolsVisibleAtCreate: false });
    await h.start();
    h.publishTools();

    const first = await h.assemble();
    assert.deepEqual(first.tools.map((item) => item.name), EXPECTED);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.restrictCalls.length > 0, "restriction should be applied after the request surface is adopted");
    await h.runtime.dispose();
  });

  it("keeps the ordinary path unchanged and stays stable across steps", async () => {
    const h = harness({});
    await h.start();

    for (let index = 0; index < 3; index += 1) {
      const assembled = await h.assemble();
      assert.deepEqual(assembled.tools.map((item) => item.name), EXPECTED);
    }
    assert.equal(h.restrictCalls.length, 1, "one restriction for one policy state");
    await h.runtime.dispose();
  });

  it("still opens an on-demand group and never shrinks the baseline on assembly", async () => {
    const h = harness({});
    await h.start();
    await h.openGroup("网页检索与抓取");

    const opened = await h.assemble();
    const names = opened.tools.map((item) => item.name);
    assert.ok(names.includes("web_fetch"), "opened group members must be visible");
    assert.ok(names.includes("web_search"), "opened group members must be visible");
    assert.ok(!names.includes("edit"), "disabled tools stay hidden after opening a group");
    await h.runtime.dispose();
  });

  it("recovers the baseline from the request surface without oscillating", async () => {
    const h = harness({ toolsVisibleAtCreate: false });
    await h.start();
    h.publishTools();

    const first = (await h.assemble()).tools.map((item) => item.name);
    const callsAfterFirst = h.restrictCalls.length;
    const second = (await h.assemble()).tools.map((item) => item.name);
    const third = (await h.assemble()).tools.map((item) => item.name);

    assert.deepEqual(first, EXPECTED);
    assert.deepEqual(second, EXPECTED);
    assert.deepEqual(third, EXPECTED);
    assert.equal(h.restrictCalls.length, callsAfterFirst, "further assemblies must not re-adopt the surface");
    await h.runtime.dispose();
  });
});
