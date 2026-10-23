import type { AgentLike } from "./dsh.js";
export declare const CATALOG_SOURCE_KIND = "tool-manager-catalog";
export interface CatalogEntry {
    name: string;
    description: string;
    tools: string[];
}
export interface CatalogHistory {
    published: boolean;
    visibleDigest?: string;
}
export interface CatalogUserMessage {
    id: string;
    role: "user";
    content: Array<{
        type: "text";
        text: string;
    }>;
    source: {
        kind: typeof CATALOG_SOURCE_KIND;
        form: "catalog";
        entries: CatalogEntry[];
        update?: true;
    };
}
export interface EnterDecision {
    kind: "enter";
    messages: CatalogUserMessage[];
    [key: string]: unknown;
}
export declare function catalogEntriesFromGroups(groups: ReadonlyArray<{
    name: string;
    description?: string;
    tools: readonly string[];
}>): CatalogEntry[];
export declare function digestCatalogEntries(entries: readonly CatalogEntry[]): string;
export declare function renderCatalogText(entries: readonly CatalogEntry[], update: boolean): string;
export declare function renderCatalogMessage(entries: readonly CatalogEntry[], update: boolean): CatalogUserMessage;
export declare function readCatalogEntries(source: unknown): CatalogEntry[] | undefined;
export declare function catalogHistory(agent: AgentLike): CatalogHistory;
export declare function catalogMessage(messages: readonly unknown[]): {
    message: CatalogUserMessage;
    entries: CatalogEntry[];
} | undefined;
export declare function applyCatalogDecision<T>(decision: T, entries: readonly CatalogEntry[], history: CatalogHistory): T;
//# sourceMappingURL=catalog.d.ts.map