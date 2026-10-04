/** Shared, local memory contracts. No runtime/provider dependencies. */
export type MemoryScope = "global" | "project";
export type MemoryLane = "main" | "jarvis" | "manual";
export type MemoryKind = "note" | "conversation";
export type MemoryCategory = "user" | "feedback" | "project" | "reference";
export interface MemoryPolicy { enabled: boolean; capture: boolean; recall: boolean }
export interface MemorySource {
	lane: MemoryLane;
	sessionId: string;
	eventId: string;
	role?: "user" | "assistant";
}
export interface MemoryRecord {
	id: string;
	kind: MemoryKind;
	category: MemoryCategory;
	scope: MemoryScope;
	project: string;
	title: string;
	text: string;
	source: MemorySource;
	createdAt: number;
	updatedAt: number;
}
export interface MemoryInput {
	kind: MemoryKind;
	category: MemoryCategory;
	scope: MemoryScope;
	project: string;
	title: string;
	text: string;
	source: MemorySource;
}
export interface MemoryQuery {
	project: string;
	scope?: "current" | "global" | "all";
	kind?: MemoryKind;
	query?: string;
	limit?: number;
}
export interface MemorySaveResult { record?: MemoryRecord; outcome: "saved" | "updated" | "duplicate" | "forgotten" }
