import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";
import { buildWatcherCommand, decodeCheckResult, WATCHER_SUPERVISOR_SOURCE } from "../watchers-check.js";
import type { WatcherCondition, WatcherRecord } from "../watchers-types.js";
import { FakeClock, fixture } from "./watchers-fixture.js";

function record(cwd: string, condition: WatcherCondition, patch: Partial<WatcherRecord> = {}): WatcherRecord {
	const base = { version: 1 as const, id: "supervisor-fixture", sessionId: "main-fixture", cwd, condition, label: "fixture", note: "Synthetic test only.", createdAt: Date.now(), deadline: Date.now() + 120_000, intervalSeconds: 10, checkTimeoutSeconds: 20, outputTailChars: 500, maxDirectoryEntries: 2000, state: "running" as const, output: "", omitted: false, detail: "", ...patch };
	return { ...base, command: buildWatcherCommand(base) };
}
async function execute(r: WatcherRecord) {
	const child = spawn("/bin/sh", ["-c", r.command], { cwd: r.cwd, stdio: ["ignore", "pipe", "pipe"] });
	let output = "", error = "";
	child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { error += data; });
	const code = await new Promise<number | null>((yes, no) => { child.on("error", no); child.on("close", yes); });
	assert.equal(code, 0); assert.equal(error, ""); return decodeCheckResult(output, r.id, r.outputTailChars);
}
test("supervised command preserves single quotes, newlines and the exact cwd", async () => {
	const f = fixture(); try { const r = record(f.cwd, { kind: "command", command: "printf '%s\\n' \"quote's line\"; pwd" }); const result = await execute(r); assert.equal(result.code, 0); assert.equal(result.output, `quote's line\n${f.cwd}\n`); assert.equal(r.command, buildWatcherCommand(r)); assert.ok(r.command.includes(WATCHER_SUPERVISOR_SOURCE.slice(0, 20))); } finally { f.close(); }
});
test("supervisor keeps only the configured output tail and marks omission", async () => {
	const f = fixture(); try { const result = await execute(record(f.cwd, { kind: "command", command: "printf 123456789" }, { outputTailChars: 5 })); assert.equal(result.output, "56789"); assert.equal(result.omitted, true); assert.equal(result.code, 0); } finally { f.close(); }
});
test("supervisor returns command exit 1 as a predicate result", async () => {
	const f = fixture(); try { const result = await execute(record(f.cwd, { kind: "command", command: "exit 1" })); assert.equal(result.kind, "result"); assert.equal(result.code, 1); } finally { f.close(); }
});
test("supervisor reports signal termination as check failure", async () => {
	const f = fixture(); try { const result = await execute(record(f.cwd, { kind: "command", command: "kill -TERM $$" })); assert.equal(result.kind, "failed"); assert.equal(result.detail, "Check terminated by signal."); } finally { f.close(); }
});
test("file_lines missing target is not yet", async () => {
	const f = fixture(); try { const result = await execute(record(f.cwd, { kind: "file_lines", path: join(f.cwd, "not-created"), minLines: 2 })); assert.equal(result.kind, "result"); assert.equal(result.code, 1); assert.equal(result.detail, "File does not exist yet."); } finally { f.close(); }
});
test("file_lines becomes met when the known newline count reaches the target", async () => {
	const f = fixture(); try { const file = join(f.cwd, "lines"); writeFileSync(file, "one\ntwo\npartial"); const result = await execute(record(f.cwd, { kind: "file_lines", path: file, minLines: 2 })); assert.equal(result.code, 0); assert.equal(result.output, ""); } finally { f.close(); }
});
test("file_lines below target is not yet and does not retain file content", async () => {
	const f = fixture(); try { const file = join(f.cwd, "lines"); writeFileSync(file, "synthetic body\npartial"); const result = await execute(record(f.cwd, { kind: "file_lines", path: file, minLines: 2 })); assert.equal(result.code, 1); assert.equal(result.output, ""); } finally { f.close(); }
});
test("named conditions refuse a symlinked root rather than following it", async () => {
	const f = fixture(); try { const file = join(f.cwd, "lines"), link = join(f.cwd, "link"); writeFileSync(file, "one\n"); symlinkSync(file, link); const result = await execute(record(f.cwd, { kind: "file_lines", path: link, minLines: 1 })); assert.equal(result.kind, "failed"); } finally { f.close(); }
});
test("quiet missing path is check failed rather than a baseline", async () => {
	const f = fixture(); try { const result = await execute(record(f.cwd, { kind: "path_quiet", path: join(f.cwd, "missing"), quietMinutes: 1 })); assert.equal(result.kind, "failed"); assert.equal(result.fingerprint, undefined); } finally { f.close(); }
});
test("quiet inventory skips symlink targets and has a stable metadata fingerprint", async () => {
	const f = fixture(); try {
		const dir = join(f.cwd, "inventory"), outside = join(f.root, "outside"); mkdirSync(dir); mkdirSync(outside); symlinkSync(outside, join(dir, "link"));
		const r = record(f.cwd, { kind: "path_quiet", path: dir, quietMinutes: 1 }), a = await execute(r);
		writeFileSync(join(outside, "not-followed"), "fixture"); const b = await execute(r);
		assert.equal(a.kind, "result"); assert.match(a.fingerprint!, /^[a-f0-9]{64}$/); assert.equal(a.fingerprint, b.fingerprint);
	} finally { f.close(); }
});
test("quiet metadata change alters the fingerprint", async () => {
	const f = fixture(); try { const file = join(f.cwd, "changed"); writeFileSync(file, "one"); const r = record(f.cwd, { kind: "path_quiet", path: file, quietMinutes: 1 }), a = await execute(r); writeFileSync(file, "longer second value"); const b = await execute(r); assert.notEqual(a.fingerprint, b.fingerprint); } finally { f.close(); }
});
test("quiet inventory above its entry cap returns a clear refusal", async () => {
	const f = fixture(); try { const dir = join(f.cwd, "inventory"); mkdirSync(dir); writeFileSync(join(dir, "a"), "a"); writeFileSync(join(dir, "b"), "b"); const result = await execute(record(f.cwd, { kind: "path_quiet", path: dir, quietMinutes: 1 }, { maxDirectoryEntries: 2 })); assert.equal(result.kind, "refused"); assert.equal(result.detail, "Quiet inventory exceeds its entry, depth, or 8 MiB metadata limit."); } finally { f.close(); }
});
function simulatedSupervisor() {
	const clock = new FakeClock(), kills: Array<[number, string]> = [], outputs: string[] = [], handlers = new Map<string, () => void>();
	const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: { destroy() {} }, stdout: Object.assign(new EventEmitter(), { destroy() {} }), stderr: Object.assign(new EventEmitter(), { destroy() {}, resume() {} }) });
	const spec = { id: "clock-fixture", cwd: "/synthetic", deadline: clock.now() + 60_000, checkTimeoutSeconds: 20, outputTailChars: 500, maxDirectoryEntries: 2000, condition: { kind: "command", command: "foreground predicate" } };
	const req = createRequire(import.meta.url);
	runInNewContext(WATCHER_SUPERVISOR_SOURCE, {
		require: (name: string) => name === "node:child_process" ? { spawn: () => child } : req(name),
		process: { argv: ["node", JSON.stringify(spec)], execPath: "/fixture/node", kill: (pid: number, signal: string) => kills.push([pid,signal]), on: (event: string, handler: () => void) => handlers.set(event, handler), stdout: { write: (text: string, done: () => void) => { outputs.push(text); done(); } }, exit() {} },
		Date: { now: () => clock.now() }, setTimeout: clock.setTimer.bind(clock), clearTimeout: clock.clearTimer.bind(clock), Buffer,
	});
	return { clock, kills, outputs, handlers, child };
}
test("supervisor runtime limit uses fake time and kills the worker process group once", async () => {
	const h = simulatedSupervisor(); await h.clock.advance(19_999); assert.equal(h.kills.length, 0);
	await h.clock.advance(1); assert.deepEqual(h.kills, [[-12345, "SIGKILL"]]); assert.equal(JSON.parse(h.outputs[0]!).kind, "failed");
	assert.equal(JSON.parse(h.outputs[0]!).detail, "Check runtime limit reached."); await h.clock.advance(60_000); assert.equal(h.outputs.length, 1);
});
test("supervisor cancellation kills the group and clears its timer", () => {
	const h = simulatedSupervisor(); h.handlers.get("SIGTERM")!(); assert.deepEqual(h.kills, [[-12345, "SIGKILL"]]); assert.equal(h.clock.timers.size, 0); assert.equal(JSON.parse(h.outputs[0]!).detail, "Check cancelled.");
});
test("invalid or oversized supervised results are refused rather than treated as success", () => {
	assert.throws(() => decodeCheckResult("not JSON", "id", 500), /valid supervised result/);
	assert.throws(() => decodeCheckResult("a".repeat(32769), "id", 500), /oversized/);
	assert.throws(() => decodeCheckResult(JSON.stringify({ version: 1, id: "other", kind: "result", code: 0, output: "", omitted: false, detail: "" }), "id", 500), /Invalid watcher/);
});
