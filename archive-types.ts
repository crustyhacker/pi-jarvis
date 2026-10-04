/** Optional, unredacted finalized-session archive. Separate from curated memory. */
export type ArchiveScope = "global" | "project";
export type ArchiveLane = "main" | "jarvis" | "import";
export interface ArchivePolicy { enabled: boolean; capture: boolean; modelAccess: boolean }
export interface ArchiveInput {
	project: string;
	sessionId: string;
	lane: ArchiveLane;
	entry: { id: string; parentId: string | null; type: string; timestamp: string; [key: string]: unknown };
}
export interface ArchiveSummary {
	id: string;
	project: string;
	sessionId: string;
	entryId: string;
	parentId: string | null;
	lane: ArchiveLane;
	type: string;
	role?: string;
	timestamp: string;
	bytes: number;
	excerpt: string;
	/** Display-only abbreviation. Exact metadata is available via read(part="metadata"). */
	abbreviated?: string[];
}
export interface ArchiveSearch {
	project: string;
	scope?: "current" | "all";
	query?: string;
	sessionId?: string;
	offset?: number;
	limit?: number;
}
export interface ArchivePage { records: ArchiveSummary[]; nextOffset: number | null }
export interface ArchiveRead {
	record: ArchiveSummary;
	content: string;
	offset: number;
	nextOffset: number | null;
	totalCharacters: number;
	units: "unicode-codepoints";
	part?: "entry" | "metadata";
}
