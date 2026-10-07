import type { MemoryCategory, MemoryLane, MemoryPolicy, MemoryRecord, MemoryScope } from "./memory-types.js";

/** Human-only curated-note management. Never includes conversation captures or archive entries. */
export type MemoryEditorScope = "current" | "project" | "global" | "all";
export type MemoryEditorSort = "updated" | "created" | "title";
export interface MemoryEditorQuery {
	scope: MemoryEditorScope;
	query?: string;
	category?: MemoryCategory;
	lane?: MemoryLane;
	sort?: MemoryEditorSort;
	offset?: number;
	limit?: number;
}
export interface MemoryNoteSummary {
	id: string;
	title: string;
	category: MemoryCategory;
	scope: MemoryScope;
	project: string;
	lane: MemoryLane;
	createdAt: number;
	updatedAt: number;
	textBytes: number;
}
export interface MemoryEditorPage {
	records: MemoryNoteSummary[];
	total: number;
	offset: number;
	nextOffset: number | null;
}
export interface MemoryNoteDraft {
	title: string;
	text: string;
	category: MemoryCategory;
	scope: MemoryScope;
}

type MaybePromise<T> = T | Promise<T>;
/** Captured definitions are owner-bound by the host, and recheck live policy for every operation. */
export interface MemoryEditorBackend {
	readonly projectLabel: string;
	ensureActive(): void;
	list(query: MemoryEditorQuery): MaybePromise<MemoryEditorPage>;
	get(id: string, scope: MemoryEditorScope): MaybePromise<MemoryRecord | undefined>;
	create(draft: MemoryNoteDraft): MaybePromise<MemoryRecord>;
	update(expected: MemoryRecord, draft: MemoryNoteDraft, scope: MemoryEditorScope): MaybePromise<MemoryRecord>;
	forget(expected: MemoryRecord[], scope: MemoryEditorScope): MaybePromise<number>;
	/** Policy/data observation only; no polling or automatic provider/model work. */
	onChange?(listener: () => void): () => void;
}

/** Service contract used by the host; explicit administration works with capture/recall paused. */
export interface MemoryEditorService {
	editorAccess(ctx: import("./memory-service.js").MemoryContext): MemoryPolicy;
	editorList(query: MemoryEditorQuery, ctx: import("./memory-service.js").MemoryContext, check?: () => void): MemoryEditorPage;
	editorGet(id: string, ctx: import("./memory-service.js").MemoryContext, scope: MemoryEditorScope, check?: () => void): MemoryRecord | undefined;
	editorCreate(draft: MemoryNoteDraft, ctx: import("./memory-service.js").MemoryContext, check?: () => void): MemoryRecord;
	editorUpdate(expected: MemoryRecord, draft: MemoryNoteDraft, ctx: import("./memory-service.js").MemoryContext, scope: MemoryEditorScope, check?: () => void): MemoryRecord;
	editorForget(expected: MemoryRecord[], ctx: import("./memory-service.js").MemoryContext, scope: MemoryEditorScope, check?: () => void): number;
	onNotesChange(listener: () => void): () => void;
}
