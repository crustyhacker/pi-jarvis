import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult, WatcherClock } from "../watchers-types.js";
export class FakeClock implements WatcherClock {
	wall = Date.now(); mono = 0; next = 1;
	readonly timers = new Map<number, { due: number; callback: () => void }>();
	now() { return this.wall; }
	monotonic() { return this.mono; }
	setTimer(callback: () => void, ms: number) { const id = this.next++; this.timers.set(id, { due: this.mono + ms, callback }); return id; }
	clearTimer(handle: unknown) { this.timers.delete(handle as number); }
	async advance(ms: number) {
		const end = this.mono + ms;
		for (;;) {
			const entry = [...this.timers.entries()].filter(([, t]) => t.due <= end).sort((a,b) => a[1].due - b[1].due || a[0] - b[0])[0];
			if (!entry) break;
			const delta = entry[1].due - this.mono; this.mono += delta; this.wall += delta;
			this.timers.delete(entry[0]); entry[1].callback();
			await drain();
		}
		this.wall += end - this.mono; this.mono = end; await drain();
	}
}
export async function drain() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
export function fixture() {
	const root = mkdtempSync(join(tmpdir(), "jarvis-watchers-")), agentDir = join(root, "agent"), cwd = join(root, "project");
	mkdirSync(agentDir); mkdirSync(cwd);
	return { root, agentDir, cwd, close: () => rmSync(root, { recursive: true, force: true }) };
}
export function result(id: string, code = 1, overrides: Partial<CheckResult> = {}): CheckResult { return { version: 1, id, kind: "result", code, detail: "", output: "last check line", omitted: false, ...overrides }; }
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
