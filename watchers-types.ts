export type WatcherScope = "global" | "project";
export interface WatcherPolicy {
	enabled: boolean;
	minIntervalSeconds: number;
	maxTimeoutSeconds: number;
	maxWatchers: number;
	maxCheckSeconds: number;
	outputTailChars: number;
	maxDirectoryEntries: number;
}
export const WATCHER_DEFAULTS: Readonly<WatcherPolicy> = Object.freeze({ enabled: false, minIntervalSeconds: 10, maxTimeoutSeconds: 21_600, maxWatchers: 5, maxCheckSeconds: 20, outputTailChars: 500, maxDirectoryEntries: 2_000 });
export type WatcherCondition =
	| { kind: "command"; command: string }
	| { kind: "file_lines"; path: string; minLines: number }
	| { kind: "path_quiet"; path: string; quietMinutes: number };
export interface WatcherRequest {
	label: string; note: string; condition: WatcherCondition;
	intervalSeconds?: number; timeoutSeconds: number; checkTimeoutSeconds?: number;
}
export type WatcherReason = "met" | "timed out" | "check failed" | "lost" | "overdue";
export interface CheckResult {
	version: 1; id: string; kind: "result" | "failed" | "refused" | "deadline";
	code?: number; output: string; omitted: boolean; detail: string; fingerprint?: string;
}
export interface WatcherRecord {
	version: 1; id: string; sessionId: string; cwd: string; label: string; note: string;
	condition: WatcherCondition; command: string; createdAt: number; deadline: number;
	intervalSeconds: number; checkTimeoutSeconds: number; outputTailChars: number; maxDirectoryEntries: number;
	state: "setting" | "running" | "finished" | "cancelled";
	reason?: WatcherReason; detail: string; output: string; omitted: boolean;
	fingerprint?: string; quietSince?: number; finishedAt?: number;
	delivery?: "pending" | "submitted" | "uncertain";
}
export interface WatcherClock {
	now(): number;
	monotonic(): number;
	setTimer(callback: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}
export const WATCHER_CLOCK: WatcherClock = {
	now: () => Date.now(), monotonic: () => performance.now(),
	setTimer(callback, ms) { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
	clearTimer(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
export const WATCHER_STATE_TYPE = "jarvis.watchers-state";
export const WATCHER_MESSAGE_TYPE = "jarvis.watcher";
