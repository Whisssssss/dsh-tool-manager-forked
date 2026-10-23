import type { AgentDefaultModelLike, LlmRuntimeLike, ToolSchemaLike } from "./dsh.js";
export declare const DEFAULT_SUGGESTION_TIMEOUT_MS = 60000;
export declare const DEFAULT_AUTO_GROUP_TIMEOUT_MS = 120000;
export declare const MIN_GENERATION_TIMEOUT_MS = 5000;
export declare const MAX_GENERATION_TIMEOUT_MS = 600000;
export interface GroupSuggestion {
    name: string;
    description: string;
}
export interface GroupSuggestionRequest {
    tools: ToolSchemaLike[];
    otherGroupNames: string[];
    prompt?: string;
}
export interface AutoGroupSuggestion extends GroupSuggestion {
    tools: string[];
}
export interface AutoGroupResult {
    groups: AutoGroupSuggestion[];
    ungrouped: string[];
}
export interface AutoGroupRequest {
    tools: ToolSchemaLike[];
    otherGroupNames: string[];
    prompt?: string;
}
export declare function generateGroupSuggestion(llm: LlmRuntimeLike, defaultModel: AgentDefaultModelLike, request: GroupSuggestionRequest, timeoutMs?: number): Promise<GroupSuggestion>;
export declare function selectSuggestionTools(schemas: ToolSchemaLike[], requestedNames: unknown): ToolSchemaLike[];
export declare function normalizeGroupNames(value: unknown): string[];
export declare function normalizeCustomPrompt(prompt: unknown): string | undefined;
export declare function generateAutoGroups(llm: LlmRuntimeLike, defaultModel: AgentDefaultModelLike, request: AutoGroupRequest, timeoutMs?: number): Promise<AutoGroupResult>;
export declare function buildSuggestionPrompt(request: GroupSuggestionRequest): string;
export declare function buildAutoGroupPrompt(request: AutoGroupRequest): string;
export declare function parseAutoGroupResult(output: string, candidateNames: string[], otherGroupNames: string[]): AutoGroupResult;
export declare function parseGroupSuggestion(output: string): GroupSuggestion;
export declare function validateGenerationTimeout(value: unknown): number;
//# sourceMappingURL=suggest.d.ts.map