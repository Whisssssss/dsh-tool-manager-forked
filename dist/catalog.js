import { createHash, randomUUID } from "node:crypto";
import { DISCOVERY_TOOL_NAME } from "./types.js";
export const CATALOG_SOURCE_KIND = "tool-manager-catalog";
export function catalogEntriesFromGroups(groups) {
    return groups
        .filter((group) => group.tools.length > 0)
        .map((group) => ({
        name: group.name,
        description: group.description ?? "",
        tools: [...group.tools],
    }));
}
export function digestCatalogEntries(entries) {
    const canonical = entries
        .map((entry) => JSON.stringify([entry.name, entry.description, entry.tools]))
        .join("\n");
    return createHash("sha256").update(canonical).digest("hex");
}
export function renderCatalogText(entries, update) {
    const body = [
        "<available_tool_groups>",
        ...entries.map(renderCatalogLine),
        "</available_tool_groups>",
    ];
    if (!update) {
        return [
            "<system-reminder>",
            "Some tools are organized into on-demand groups and can be opened when needed.",
            "",
            ...body,
            "",
            `Call ${DISCOVERY_TOOL_NAME}({ group: "<name>" }) to open one group. All tools in that group become available for the rest of this session. Use the exact group name from this catalog.`,
            "</system-reminder>",
        ].join("\n");
    }
    const availability = entries.length === 0
        ? [
            `No on-demand tool groups are currently available through the ${DISCOVERY_TOOL_NAME} tool. Do not use names from earlier tool-group catalogs.`,
        ]
        : [
            `Use only names in this replacement catalog. Call ${DISCOVERY_TOOL_NAME}({ group: "<name>" }) to open one group. All tools in that group become available for the rest of this session.`,
        ];
    return [
        "<system-reminder>",
        "The on-demand tool group catalog changed. This complete catalog replaces every earlier tool-group list in this session:",
        "",
        ...body,
        "",
        ...availability,
        "</system-reminder>",
    ].join("\n");
}
export function renderCatalogMessage(entries, update) {
    const message = {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: renderCatalogText(entries, update) }],
        source: {
            kind: CATALOG_SOURCE_KIND,
            form: "catalog",
            entries: entries.map((entry) => ({ ...entry, tools: [...entry.tools] })),
            ...(update ? { update: true } : {}),
        },
    };
    Object.freeze(message.content[0]);
    Object.freeze(message.content);
    Object.freeze(message.source.entries);
    Object.freeze(message.source);
    return Object.freeze(message);
}
export function readCatalogEntries(source) {
    if (source === null || typeof source !== "object")
        return undefined;
    const record = source;
    if (record.kind !== CATALOG_SOURCE_KIND)
        return undefined;
    if (!Array.isArray(record.entries))
        return undefined;
    const readable = [];
    for (const entry of record.entries) {
        if (entry === null || typeof entry !== "object")
            return undefined;
        const { name, description, tools } = entry;
        if (typeof name !== "string" || name === "" || typeof description !== "string")
            return undefined;
        if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))) {
            return undefined;
        }
        readable.push({ name, description, tools: tools === undefined ? [] : [...tools] });
    }
    return readable;
}
export function catalogHistory(agent) {
    const session = agent.session;
    if (!session)
        return { published: false };
    const visible = new Set(session.surface?.nodes ?? []);
    let published = false;
    for (let index = session.seq - 1; index >= 0; index -= 1) {
        const event = session.eventAt(index);
        if (event === undefined)
            continue;
        if (event.type !== "user/message")
            continue;
        const data = asRecord(event.data);
        const entries = readCatalogEntries(data?.source);
        if (entries === undefined)
            continue;
        const digest = digestCatalogEntries(entries);
        published = true;
        if (visible.has(event.seq)) {
            return { visibleDigest: digest, published };
        }
    }
    return { published };
}
export function catalogMessage(messages) {
    for (const message of messages) {
        const record = asRecord(message);
        if (!record)
            continue;
        const entries = readCatalogEntries(record.source);
        if (entries === undefined)
            continue;
        return { message: message, entries };
    }
    return undefined;
}
export function applyCatalogDecision(decision, entries, history) {
    if (!isEnterDecision(decision))
        return decision;
    const messages = decision.messages;
    const digest = digestCatalogEntries(entries);
    const existing = catalogMessage(messages);
    if (history.visibleDigest === digest) {
        return existing === undefined
            ? decision
            : { ...decision, messages: messages.filter((message) => message.id !== existing.message.id) };
    }
    if (existing !== undefined && digestCatalogEntries(existing.entries) === digest)
        return decision;
    if (!history.published && entries.length === 0) {
        return existing === undefined
            ? decision
            : { ...decision, messages: messages.filter((message) => message.id !== existing.message.id) };
    }
    const catalog = renderCatalogMessage(entries, history.published);
    return {
        ...decision,
        messages: existing === undefined
            ? [...messages, catalog]
            : messages.map((message) => message.id === existing.message.id ? catalog : message),
    };
}
function renderCatalogLine(entry) {
    const heading = `- ${escapeText(entry.name)} (${entry.tools.length} tools)${entry.description ? `: ${escapeText(entry.description)}` : ""}`;
    return `${heading}\n  Tools: ${entry.tools.map(escapeText).join(", ")}`;
}
function escapeText(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function isEnterDecision(value) {
    if (value === null || typeof value !== "object")
        return false;
    const record = value;
    return record.kind === "enter" && Array.isArray(record.messages);
}
function asRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    return value;
}
//# sourceMappingURL=catalog.js.map