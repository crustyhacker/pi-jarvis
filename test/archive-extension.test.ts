import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ARCHIVE_TOOL_NAMES, createArchiveExtensionFactory, type ArchiveExtensionOptions, type ArchiveExtensionService } from "../archive-extension.js";
import type { ArchivePolicy } from "../archive-types.js";

type Entry = { id: string; parentId: string | null; type: string; timestamp: string; [key: string]: unknown };
type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
const OFF = { enabled: false, capture: true, modelAccess: false };
const ON = { enabled: true, capture: true, modelAccess: true };
const entry = (id: string, type = "custom", fields: Record<string, unknown> = {}, parentId: string | null = null): Entry => ({
	id, parentId, type, timestamp: "2026-01-02T03:04:05.000Z", ...fields,
});
const user = (content: unknown) => ({ role: "user", content, timestamp: 100 });
const assistant = (content: unknown) => ({ role: "assistant", content, stopReason: "stop", timestamp: 200 });

/** No settings, SQLite, providers, credentials, or user journals are touched. */
class MockArchiveService implements ArchiveExtensionService {
	epoch = 0;
	settings: ArchivePolicy = { ...OFF };
	listeners = new Set<() => void>();
	policyCalls = 0;
	closeCalls = 0;
	captureCalls = 0;
	captures: Array<{ entry: Entry; lane: "main" | "jarvis"; sessionId: string; cwd: string }> = [];
	reads: Array<{ method: string; params: unknown; model: boolean | undefined; cwd: string; sessionId: string }> = [];
	onPolicy?: () => void;
	onCapture?: () => void;
	onRead?: () => void;
	captureError = false;
	policy(ctx: ExtensionContext): ArchivePolicy {
		this.policyCalls++;
		const hook = this.onPolicy;
		this.onPolicy = undefined;
		hook?.();
		return ctx.isProjectTrusted() ? { ...this.settings } : { enabled: false, capture: false, modelAccess: false };
	}
	onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	setPolicy(patch: Partial<ArchivePolicy>, notify = true, bump = true) {
		this.settings = { ...this.settings, ...patch };
		if (bump) this.epoch++;
		if (notify) for (const listener of [...this.listeners]) listener();
	}
	capture(raw: unknown, lane: "main" | "jarvis", ctx: ExtensionContext): void {
		this.captureCalls++;
		if (this.captureError) throw new Error("RAW_PAYLOAD_MUST_NOT_APPEAR_IN_WARNING");
		const policy = this.policy(ctx);
		if (!policy.enabled || !policy.capture) return;
		this.captures.push({ entry: JSON.parse(JSON.stringify(raw)), lane, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });
		this.onCapture?.();
	}
	private retrieve(method: string, params: unknown, ctx: ExtensionContext, model?: boolean): string {
		const policy = this.policy(ctx);
		if (!policy.enabled || (model && !policy.modelAccess)) throw new Error("Archive access disabled");
		this.reads.push({ method, params, model, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
		this.onRead?.();
		return JSON.stringify({ method, data: "LOCAL_SYNTHETIC_ARCHIVE_FIXTURE" });
	}
	search(params: Parameters<ArchiveExtensionService["search"]>[0], ctx: ExtensionContext, model?: boolean) { return this.retrieve("search", params, ctx, model); }
	read(params: Parameters<ArchiveExtensionService["read"]>[0], ctx: ExtensionContext, model?: boolean) { return this.retrieve("read", params, ctx, model); }
	session(params: Parameters<ArchiveExtensionService["session"]>[0], ctx: ExtensionContext, model?: boolean) { return this.retrieve("session", params, ctx, model); }
	close() { this.closeCalls++; }
}

class Journal {
	entries: Entry[] = [];
	reads = 0;
	canRead = true;
	readError = false;
	onRead?: () => void;
	constructor(public id: string) {}
	getSessionId() { return this.id; }
	getEntries() {
		this.reads++;
		assert.equal(this.canRead, true, "getEntries must never run while archive/capture is off");
		if (this.readError) throw new Error("SYNTHETIC_JOURNAL_FAILURE");
		this.onRead?.();
		return this.entries.slice();
	}
	append(value: Entry) { this.entries.push(value); return value; }
}
function fixture(t: TestContext, service = new MockArchiveService(), lane: "main" | "jarvis" = "main", options: ArchiveExtensionOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-archive-extension-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "workspace"), agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const journal = new Journal(`${lane}-fixture-session`);
	const notices: Array<{ text: string; level: string }> = [];
	let trusted = true;
	const ctx = {
		cwd, mode: "tui", hasUI: true, signal: undefined, isProjectTrusted: () => trusted,
		sessionManager: journal,
		ui: { notify: (text: string, level: string) => { notices.push({ text, level }); } },
	} as unknown as ExtensionContext;
	const mounted = mount(service, lane, ctx, options);
	return { root, cwd, agentDir, journal, ctx, notices, service, ...mounted, setTrust: (value: boolean) => { trusted = value; } };
}
function mount(service: MockArchiveService, lane: "main" | "jarvis", ctx: ExtensionContext, options: ArchiveExtensionOptions = {}) {
	const handlers = new Map<string, Handler[]>(), tools = new Map<string, ToolDefinition<any>>();
	let activeTools: string[] = ["read", "host_tool", "jarvis_memory_search"];
	let selectionWrites = 0;
	const register = (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); };
	const pi = {
		on: register,
		registerTool: (tool: ToolDefinition<any>) => {
			tools.set(tool.name, tool);
			if (tool.exposure === "direct" && !activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; selectionWrites++; },
	} as unknown as ExtensionAPI;
	createArchiveExtensionFactory(service, lane, options)(pi);
	let messageCount = 0;
	return {
		tools, handlers, late: register,
		activeTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		selectionWrites: () => selectionWrites,
		async emit(name: string, event: any = { type: name }, context = ctx): Promise<any> {
			let result: any;
			for (const handler of handlers.get(name) ?? []) {
				const answer = await handler(event, context);
				if (answer !== undefined) result = answer;
				if (name === "message_end" && answer && typeof answer === "object" && "message" in answer) event.message = answer.message;
			}
			// Match Pi: only persist AFTER every message_end redactor has run.
			if (name === "message_end") (context.sessionManager as unknown as Journal).append(entry(`final-${++messageCount}`, "message", { message: event.message }));
			return result;
		},
		execute(name: string, params: any, signal?: AbortSignal, definition = tools.get(name)!, context = ctx) {
			return definition.execute("fixture-call", params, signal, undefined, context as ExtensionToolContext);
		},
	};
}
const ids = (service: MockArchiveService) => service.captures.map(({ entry }) => entry.id);
const text = (result: Awaited<ReturnType<ToolDefinition<any>["execute"]>>) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const before = (selectedTools: string[] = []) => ({ type: "before_agent_start", prompt: "fixture user request", systemPrompt: "HOST PROMPT",
	systemPromptOptions: { sections: { host: "HOST SECTION" }, selectedTools, forceSystemPrompt: "FORCED HOST PROMPT" } });
const params = (name: string) => name === "jarvis_archive_search" ? { query: "fixture" } : name === "jarvis_archive_read" ? { id: "record-fixture" } : { sessionId: "session-fixture" };

test("loading and full OFF never inspect journals, inject context, touch records, or start work", async t => {
	const f = fixture(t);
	f.journal.canRead = false;
	f.journal.append(entry("existing", "message", { message: user("historical fixture") }));
	assert.equal(f.service.policyCalls, 0);
	assert.equal(f.journal.reads, 0);
	assert.equal(f.selectionWrites(), 0, "loading cannot use unbound session controls");
	assert.equal(f.tools.size, 3);
	for (const name of ARCHIVE_TOOL_NAMES) assert.equal(f.tools.get(name)!.exposure, "hidden");
	for (const name of ["message_start", "message_update", "message_end", "tool_result", "provider_stream_event", "agent_end", "context", "context_with_system"])
		assert.equal(f.handlers.has(name), false, `${name} must not capture or inject`);
	await f.emit("session_start");
	for (const name of ["turn_end", "agent_settled", "session_before_compact", "session_compact", "session_before_switch", "session_before_fork", "session_before_tree", "session_tree", "model_select", "thinking_level_select", "session_info_changed"])
		await f.emit(name);
	const event = before(["read", "host_tool", ...ARCHIVE_TOOL_NAMES, "jarvis_memory_search"]);
	await f.emit("before_agent_start", event);
	assert.deepEqual(event.systemPromptOptions.selectedTools, ["read", "host_tool", "jarvis_memory_search"]);
	assert.equal(event.systemPromptOptions.forceSystemPrompt, "FORCED HOST PROMPT");
	assert.deepEqual(event.systemPromptOptions.sections, { host: "HOST SECTION" });
	for (const name of ARCHIVE_TOOL_NAMES) {
		assert.equal((await f.emit("tool_call", { toolName: name })).block, true);
		await assert.rejects(f.execute(name, params(name)), /archive access expired/i);
	}
	assert.equal(await f.emit("tool_call", { toolName: "jarvis_memory_search" }), undefined);
	await f.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
	assert.equal(f.journal.reads, 0);
	assert.equal(f.service.captureCalls, 0);
	assert.deepEqual(f.service.reads, []);
	assert.equal(f.service.closeCalls, 0, "shared service disposal belongs to the host");
	assert.equal(f.service.listeners.size, 0);
	assert.deepEqual(readdirSync(f.cwd), []);
	assert.deepEqual(readdirSync(f.agentDir), []);
});

test("baseline excludes all existing branches; new full raw roles/types retain thinking, tools, images and errors", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON, modelAccess: false };
	const f = fixture(t, service, "jarvis");
	f.journal.append(entry("old-active", "message", { message: user("old active branch") }));
	f.journal.append(entry("old-abandoned", "custom", { data: "old abandoned branch" }));
	await f.emit("session_start");
	assert.equal(f.journal.reads, 1);
	assert.deepEqual(ids(service), []);
	const entries = [
		entry("system", "message", { message: { role: "system", content: "", sections: { tools: "tool declarations", preamble: "fixture prompt" }, toolsAdded: [{ name: "fixture", parameters: {} }] } }),
		entry("user", "message", { message: user([{ type: "text", text: "new user" }, { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" }]) }, "system"),
		entry("assistant", "message", { message: assistant([{ type: "thinking", thinking: "exposed fixture thinking", thinkingSignature: "opaque-fixture-signature" }, { type: "toolCall", id: "call-fixture", name: "fixture", arguments: { input: "raw fixture" } }]) }, "user"),
		entry("tool", "message", { message: { role: "toolResult", toolCallId: "call-fixture", toolName: "fixture", isError: true, content: [{ type: "text", text: "raw tool fixture" }], structuredContent: { answer: 42 }, details: { raw: true } } }, "assistant"),
		entry("custom-message-role", "message", { message: { role: "custom", customType: "fixture", content: "custom fixture", display: false } }),
		entry("custom-entry", "custom", { customType: "fixture", data: { nested: ["unredacted fixture", 42] } }),
		entry("custom-message", "custom_message", { customType: "fixture", content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }], display: false }),
		entry("model", "model_change", { provider: "local-fixture", modelId: "mock" }),
		entry("thinking", "thinking_level_change", { thinkingLevel: "high" }),
		entry("compact", "compaction", { summary: "raw fixture summary", firstKeptEntryId: "user", details: { raw: true } }),
		entry("context-edit", "context_edit", { targetId: "user", replacement: null }),
		entry("usage", "usage", { kind: "future-fixture-kind", usage: { totalTokens: 42 } }),
		entry("abandoned-new", "branch_summary", { fromId: "assistant", summary: "new abandoned branch" }, "old-abandoned"),
		entry("label", "label", { targetId: "user", label: "fixture checkpoint" }),
		entry("name", "session_info", { name: "fixture title" }),
		entry("future", "future_entry_type", { future: { raw: true } }),
		entry("aborted", "message", { message: { ...assistant([{ type: "text", text: "persisted aborted output" }]), stopReason: "aborted" } }),
		entry("error", "message", { message: { ...assistant([]), stopReason: "error", errorMessage: "persisted fixture error" } }),
	];
	for (const value of entries) f.journal.append(value);
	const cancelledTurn = new AbortController(); cancelledTurn.abort(); f.ctx.signal = cancelledTurn.signal;
	await f.emit("turn_end", { message: assistant("INTERMEDIATE_EVENT_NOT_JOURNAL"), entries: [{ type: "custom", data: "UNCOMMITTED_BOUNDARY_DRAFT" }] });
	assert.deepEqual(service.captures.map(({ entry }) => entry), entries, "no sanitization, projection, role filter, or truncation");
	assert.ok(service.captures.every(capture => capture.lane === "jarvis" && capture.sessionId === f.journal.id && capture.cwd === f.cwd));
	await f.emit("agent_settled");
	assert.equal(service.captures.length, entries.length);
	for (const name of ARCHIVE_TOOL_NAMES) assert.equal(f.tools.get(name)!.exposure, "hidden");
});

test("later redactors win; intermediate message/tool/provider events never trigger reads or capture", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service);
	await f.emit("session_start");
	const baselineReads = f.journal.reads;
	f.late("message_end", event => ({ message: { ...event.message, content: [{ type: "text", text: "FINAL_REDACTED_FIXTURE" }] } }));
	f.late("message_end", event => ({ message: { ...event.message, content: [{ type: "text", text: "LATER_FINAL_FIXTURE" }] } }));
	for (const message of [user("UNREDACTED_EVENT"), assistant("UNREDACTED_EVENT"), { role: "toolResult", content: "UNREDACTED_EVENT", toolCallId: "fixture" }]) {
		await f.emit("message_update", { message });
		await f.emit("tool_result", { content: "RAW_RESULT" });
		await f.emit("provider_stream_event", { data: "RAW_PROVIDER_STREAM" });
		await f.emit("message_end", { message });
	}
	await f.emit("agent_end");
	assert.equal(f.journal.reads, baselineReads);
	assert.equal(service.captureCalls, 0);
	await f.emit("turn_end");
	assert.equal(service.captures.length, 3);
	assert.ok(service.captures.every(({ entry }) => JSON.stringify(entry).includes("LATER_FINAL_FIXTURE")));
	assert.ok(service.captures.every(({ entry }) => !JSON.stringify(entry).includes("UNREDACTED_EVENT")));
});

test("late actionable-boundary hooks are observed at settlement or the next safe boundary, never as drafts", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service);
	await f.emit("session_start");
	f.journal.append(entry("before-turn"));
	f.late("turn_end", () => { f.journal.append(entry("late-turn", "context_edit", { targetId: "before-turn", replacement: null })); });
	await f.emit("turn_end", { entries: [{ type: "custom", data: "draft-only" }] });
	assert.deepEqual(ids(service), ["before-turn"]);
	f.late("agent_before_settle", () => { f.journal.append(entry("late-settlement", "custom_message", { content: "final boundary fixture" })); });
	await f.emit("agent_before_settle");
	assert.deepEqual(ids(service), ["before-turn"]);
	await f.emit("agent_settled");
	assert.deepEqual(ids(service), ["before-turn", "late-turn", "late-settlement"]);
	await f.emit("before_agent_start", before());
	f.journal.append(entry("persisted-prompt-delta", "message", { message: { role: "system", sections: { host: "new host section" } } }));
	assert.equal(ids(service).includes("persisted-prompt-delta"), false);
	await f.emit("turn_end");
	assert.equal(ids(service).filter(id => id === "persisted-prompt-delta").length, 1);
});

test("capture pause/full OFF/re-enable discard disabled-period entries without backfill or off reads", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service);
	await f.emit("session_start");
	f.journal.append(entry("enabled-first")); await f.emit("agent_settled");
	const oldTool = f.tools.get("jarvis_archive_search")!;
	f.journal.canRead = false;
	const beforeOffReads = f.journal.reads;
	service.setPolicy({ capture: false });
	f.journal.append(entry("capture-paused"));
	await f.emit("agent_settled");
	assert.match(text(await f.execute("jarvis_archive_search", { query: "fixture" })), /LOCAL_SYNTHETIC/);
	await assert.rejects(f.execute("jarvis_archive_search", { query: "fixture" }, undefined, oldTool), /expired/);
	assert.equal(f.journal.reads, beforeOffReads);
	f.journal.canRead = true;
	service.setPolicy({ capture: true });
	assert.deepEqual(ids(service), ["enabled-first"]);
	f.journal.append(entry("capture-resumed")); await f.emit("agent_settled");
	f.journal.canRead = false;
	const fullOffReads = f.journal.reads;
	service.setPolicy({ enabled: false });
	f.journal.append(entry("full-off-period"));
	await f.emit("turn_end"); await f.emit("before_agent_start", before([...ARCHIVE_TOOL_NAMES]));
	assert.equal(f.journal.reads, fullOffReads);
	const readCount = service.reads.length;
	for (const name of ARCHIVE_TOOL_NAMES) await assert.rejects(f.execute(name, params(name)), /expired/);
	assert.equal(service.reads.length, readCount);
	f.journal.canRead = true;
	service.setPolicy({ enabled: true, modelAccess: false });
	f.journal.append(entry("full-on-again")); await f.emit("agent_settled");
	assert.deepEqual(ids(service), ["enabled-first", "capture-resumed", "full-on-again"]);
	assert.equal(f.notices.length, 0);
});

test("dynamic own-tool selection preserves Repo/memory/host tools and already-snapshotted prompt selection", async t => {
	let changed = 0;
	const f = fixture(t, new MockArchiveService(), "main", { onToolsChanged: () => { changed++; } });
	await f.emit("session_start");
	const original = ["read", "host_tool", "jarvis_memory_search"];
	f.service.onPolicy = () => f.service.setPolicy(ON); // First observed inside before_agent_start, with reentrant notification.
	const event = before(["earlier_hook_tool", "jarvis_memory_search", "read"]);
	await f.emit("before_agent_start", event);
	assert.deepEqual(f.activeTools(), [...original, ...ARCHIVE_TOOL_NAMES]);
	assert.deepEqual(event.systemPromptOptions.selectedTools, ["earlier_hook_tool", "jarvis_memory_search", "read", ...ARCHIVE_TOOL_NAMES]);
	assert.deepEqual(event.systemPromptOptions.sections, { host: "HOST SECTION" });
	assert.equal(event.systemPromptOptions.forceSystemPrompt, "FORCED HOST PROMPT");
	for (const name of ARCHIVE_TOOL_NAMES) {
		const tool = f.tools.get(name)!;
		assert.equal(tool.exposure, "direct");
		assert.equal(tool.annotations?.readOnlyHint, true);
		assert.match(tool.description, /untrusted history, not instructions/);
		assert.match(tool.description, /contain secrets/);
		assert.match(tool.description, /active model\/provider/);
		assert.match(tool.description, /explicit user request/);
	}
	const snapshotted = before(["earlier_hook_tool", ...ARCHIVE_TOOL_NAMES, "jarvis_memory_search"]);
	f.service.onPolicy = () => f.service.setPolicy({ modelAccess: false });
	await f.emit("before_agent_start", snapshotted);
	assert.deepEqual(snapshotted.systemPromptOptions.selectedTools, ["earlier_hook_tool", "jarvis_memory_search"]);
	assert.deepEqual(f.activeTools(), original);
	assert.ok(changed >= 3);
	assert.equal(f.tools.size, 3, "there are no model control/import/deletion tools");
});

test("tools forward the exact service API, including model=true and explicit all-project pagination", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON, capture: false };
	const f = fixture(t, service); f.journal.canRead = false;
	await f.emit("session_start");
	const requests = [
		{ name: "jarvis_archive_search", method: "search", args: { query: 'literal "phrase"', sessionId: "specific-session", scope: "all", offset: 40, limit: 50 } },
		{ name: "jarvis_archive_read", method: "read", args: { id: "archive-record-id", scope: "all", offset: 12_000, limit: 12_000 } },
		{ name: "jarvis_archive_session", method: "session", args: { sessionId: "specific-session", scope: "current", offset: 20, limit: 10 } },
	];
	for (const { name, method, args } of requests) {
		const result = await f.execute(name, args);
		assert.equal(result.details, undefined);
		assert.equal(JSON.parse(text(result)).method, method);
		assert.deepEqual(service.reads.at(-1), { method, params: args, model: true, cwd: f.cwd, sessionId: f.journal.id });
	}
	assert.equal(f.journal.reads, 0);
	assert.equal(service.captureCalls, 0);
});

test("stale definitions cannot revive after policy, trust, epoch or session generations change", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service); await f.emit("session_start");
	const stale = ARCHIVE_TOOL_NAMES.map(name => f.tools.get(name)!);
	service.setPolicy({ modelAccess: false }); service.setPolicy({ modelAccess: true });
	for (let i = 0; i < stale.length; i++) await assert.rejects(f.execute(ARCHIVE_TOOL_NAMES[i]!, params(ARCHIVE_TOOL_NAMES[i]!), undefined, stale[i]), /expired/);
	const epochStale = f.tools.get("jarvis_archive_search")!;
	service.setPolicy({}, false); // No push notification: execution itself must discover the epoch.
	await assert.rejects(f.execute("jarvis_archive_search", { query: "fixture" }, undefined, epochStale), /expired/);
	const trustStale = f.tools.get("jarvis_archive_search")!;
	f.setTrust(false); f.journal.canRead = false;
	await f.emit("before_agent_start", before());
	f.setTrust(true); f.journal.canRead = true;
	await f.emit("before_agent_start", before());
	await assert.rejects(f.execute("jarvis_archive_search", { query: "fixture" }, undefined, trustStale), /expired/);
	const sessionStale = f.tools.get("jarvis_archive_search")!;
	f.journal.id = "replacement-session";
	f.journal.entries = [entry("replacement-history")];
	await f.emit("session_start");
	await assert.rejects(f.execute("jarvis_archive_search", { query: "fixture" }, undefined, sessionStale), /expired/);
	f.journal.append(entry("replacement-new")); await f.emit("agent_settled");
	assert.deepEqual(ids(service), ["replacement-new"]);
	assert.deepEqual(service.reads, []);
});

test("model access changes revoke readers without dropping pending recording", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON, modelAccess: false };
	const f = fixture(t, service); await f.emit("session_start");
	f.journal.append(entry("before-reader-enable"));
	service.setPolicy({ modelAccess: true });
	const old = f.tools.get("jarvis_archive_read")!;
	f.journal.append(entry("before-reader-disable"));
	service.setPolicy({ modelAccess: false });
	await f.emit("agent_settled");
	assert.deepEqual(ids(service), ["before-reader-enable", "before-reader-disable"]);
	await assert.rejects(f.execute("jarvis_archive_read", { id: "fixture" }, undefined, old), /expired/);
});

test("even policy changes without an epoch bump revoke observed definitions; foreign contexts cannot rebind tools", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON, capture: false };
	const f = fixture(t, service); await f.emit("session_start");
	const stale = f.tools.get("jarvis_archive_read")!;
	service.setPolicy({ modelAccess: false }, true, false);
	service.setPolicy({ modelAccess: true }, true, false);
	await assert.rejects(f.execute("jarvis_archive_read", { id: "fixture" }, undefined, stale), /expired/);
	const foreignJournal = new Journal("foreign-fixture"); foreignJournal.canRead = false;
	const foreign = { ...f.ctx, sessionManager: foreignJournal } as unknown as ExtensionContext;
	await assert.rejects(f.execute("jarvis_archive_read", { id: "fixture" }, undefined, f.tools.get("jarvis_archive_read")!, foreign), /expired/);
	assert.equal(foreignJournal.reads, 0);
	assert.match(text(await f.execute("jarvis_archive_read", { id: "fixture" })), /LOCAL_SYNTHETIC/);
});

test("tool and context cancellation block reads, and mid-read revocation discards the result", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON, capture: false };
	const f = fixture(t, service); await f.emit("session_start");
	const aborted = new AbortController(); aborted.abort();
	for (const name of ARCHIVE_TOOL_NAMES) await assert.rejects(f.execute(name, params(name), aborted.signal), /cancelled/);
	f.ctx.signal = aborted.signal;
	for (const name of ARCHIVE_TOOL_NAMES) {
		await assert.rejects(f.execute(name, params(name)), /cancelled/);
		assert.equal((await f.emit("tool_call", { toolName: name })).block, true);
	}
	assert.deepEqual(service.reads, []);
	f.ctx.signal = undefined;
	const midRead = new AbortController(); service.onRead = () => midRead.abort();
	await assert.rejects(f.execute("jarvis_archive_read", { id: "fixture" }, midRead.signal), /cancelled/);
	service.onRead = () => service.setPolicy({ enabled: false });
	await assert.rejects(f.execute("jarvis_archive_search", { query: "fixture" }), /expired/);
	assert.equal(service.reads.length, 2, "already-started synchronous reads cannot be rolled back, but results are withheld");
});

test("side lifetime revocation is independent of main, Repo tools, memory tools and the shared service", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const lifetime = new AbortController();
	const main = fixture(t, service), side = fixture(t, service, "jarvis", { lifetimeSignal: lifetime.signal });
	await main.emit("session_start"); await side.emit("session_start");
	const sideDefinition = side.tools.get("jarvis_archive_search")!;
	side.setActiveTools(["jarvis_memory_search", ...ARCHIVE_TOOL_NAMES]); // Repo tools OFF does not gate archive.
	assert.match(text(await side.execute("jarvis_archive_search", { query: "fixture" })), /LOCAL_SYNTHETIC/);
	const sideReads = side.journal.reads;
	lifetime.abort(); side.journal.canRead = false;
	side.journal.append(entry("revoked-side"));
	await side.emit("agent_settled"); await side.emit("session_start");
	await assert.rejects(side.execute("jarvis_archive_search", { query: "fixture" }, undefined, sideDefinition), /expired/);
	assert.equal(side.journal.reads, sideReads);
	assert.deepEqual(side.activeTools(), ["jarvis_memory_search"]);
	assert.equal(service.listeners.size, 1);
	main.journal.append(entry("main-after-side-close")); await main.emit("agent_settled");
	assert.match(text(await main.execute("jarvis_archive_search", { query: "fixture" })), /LOCAL_SYNTHETIC/);
	assert.deepEqual(ids(service), ["main-after-side-close"]);
	assert.equal(service.closeCalls, 0);
	await main.emit("session_shutdown");
	assert.equal(service.listeners.size, 0);
});

test("already-aborted lifetime never reads/activates and cannot be resurrected by session_start", async t => {
	const signal = new AbortController(); signal.abort();
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service, "jarvis", { lifetimeSignal: signal.signal }); f.journal.canRead = false;
	await f.emit("session_start"); await f.emit("turn_end");
	assert.equal(f.journal.reads, 0);
	assert.equal(service.policyCalls, 0);
	assert.equal(service.listeners.size, 0);
	for (const name of ARCHIVE_TOOL_NAMES) assert.equal(f.tools.get(name)!.exposure, "hidden");
});

test("live host and optional trust gates fail closed, without reading old entries when trust returns", async t => {
	let optionTrust = false;
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service, "jarvis", { isProjectTrusted: () => optionTrust });
	f.journal.canRead = false;
	await f.emit("session_start");
	f.journal.append(entry("untrusted-history")); await f.emit("turn_end");
	assert.equal(f.journal.reads, 0);
	assert.equal(service.captureCalls, 0);
	optionTrust = true; f.journal.canRead = true;
	await f.emit("before_agent_start", before());
	f.journal.append(entry("trusted-new")); await f.emit("turn_end");
	assert.deepEqual(ids(service), ["trusted-new"]);
	f.setTrust(false); f.journal.canRead = false;
	await assert.rejects(f.execute("jarvis_archive_search", { query: "fixture" }), /expired/);
	for (const name of ARCHIVE_TOOL_NAMES) assert.equal(f.tools.get(name)!.exposure, "hidden");
});

test("tree/cancelled transitions keep complete-journal identity, capture late entries, and invalidate prepared tools", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service);
	f.journal.append(entry("old-other-branch")); await f.emit("session_start");
	const beforeTreeTool = f.tools.get("jarvis_archive_search")!;
	f.journal.append(entry("abandoned-new"));
	f.late("session_before_tree", () => { f.journal.append(entry("late-before-tree")); });
	await f.emit("session_before_tree");
	assert.deepEqual(ids(service), ["abandoned-new"]);
	f.journal.append(entry("summary", "branch_summary", { fromId: "abandoned-new", summary: "final fixture summary" }, "old-other-branch"));
	await f.emit("session_tree", { newLeafId: "summary", oldLeafId: "abandoned-new" });
	assert.deepEqual(ids(service), ["abandoned-new", "late-before-tree", "summary"]);
	await assert.rejects(f.execute("jarvis_archive_search", { query: "fixture" }, undefined, beforeTreeTool), /expired/);
	const beforeCancelledFork = f.tools.get("jarvis_archive_search")!;
	f.late("session_before_fork", () => ({ cancel: true }));
	assert.equal((await f.emit("session_before_fork")).cancel, true);
	f.journal.append(entry("after-cancelled-fork")); await f.emit("turn_end");
	await assert.rejects(f.execute("jarvis_archive_search", { query: "fixture" }, undefined, beforeCancelledFork), /expired/);
	assert.deepEqual(ids(service), ["abandoned-new", "late-before-tree", "summary", "after-cancelled-fork"]);
});

test("outgoing replacement/shutdown observes late before-switch entries while context is still valid", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service); await f.emit("session_start");
	f.journal.append(entry("before-switch"));
	f.late("session_before_switch", () => { f.journal.append(entry("late-before-switch")); });
	await f.emit("session_before_switch");
	assert.deepEqual(ids(service), ["before-switch"]);
	f.journal.append(entry("settled-before-shutdown", "message", { message: { ...assistant("final fixture aborted output"), stopReason: "aborted" } }));
	await f.emit("session_shutdown", { reason: "resume" });
	assert.deepEqual(ids(service), ["before-switch", "late-before-switch", "settled-before-shutdown"]);
	f.journal.canRead = false; await f.emit("agent_settled");
	assert.equal(service.closeCalls, 0);
	const replacement = fixture(t, service);
	replacement.journal.append(entry("replacement-old")); await replacement.emit("session_start");
	replacement.journal.append(entry("replacement-new")); await replacement.emit("agent_settled");
	assert.deepEqual(ids(service), ["before-switch", "late-before-switch", "settled-before-shutdown", "replacement-new"]);
});

test("compaction/model/thinking/name boundaries capture persisted metadata, not event copies", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service); await f.emit("session_start");
	for (const [event, type] of [["session_before_compact", "custom"], ["session_compact", "compaction"], ["model_select", "model_change"], ["thinking_level_select", "thinking_level_change"], ["session_info_changed", "session_info"]]) {
		f.journal.append(entry(event!, type, { fixture: "PERSISTED_VALUE" }));
		await f.emit(event!, { compactionEntry: entry("INTERMEDIATE_EVENT_COPY"), model: "EVENT_NOT_JOURNAL", level: "EVENT_NOT_JOURNAL" });
	}
	assert.deepEqual(ids(service), ["session_before_compact", "session_compact", "model_select", "thinking_level_select", "session_info_changed"]);
});

test("revocation inside a snapshot stops subsequent writes and never replays them after re-enable", async t => {
	for (const mode of ["epoch", "trust", "lifetime"] as const) {
		const service = new MockArchiveService(); service.settings = { ...ON };
		const lifetime = new AbortController();
		const f = fixture(t, service, "main", { lifetimeSignal: lifetime.signal }); await f.emit("session_start");
		for (const id of ["first", "second", "third"]) f.journal.append(entry(`${mode}-${id}`));
		service.onCapture = () => {
			service.onCapture = undefined;
			if (mode === "epoch") service.setPolicy({ capture: false });
			if (mode === "trust") f.setTrust(false);
			if (mode === "lifetime") lifetime.abort();
		};
		await f.emit("agent_settled");
		assert.deepEqual(ids(service), [`${mode}-first`]);
		if (mode !== "lifetime") {
			f.setTrust(true); service.setPolicy({ capture: true });
			f.journal.append(entry(`${mode}-new`)); await f.emit("agent_settled");
			assert.deepEqual(ids(service), [`${mode}-first`, `${mode}-new`]);
		}
	}
});

test("capture/snapshot/policy failures warn without leaking raw errors or silently retrying/backfilling", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON };
	const f = fixture(t, service); await f.emit("session_start");
	service.captureError = true;
	f.journal.append(entry("failed-capture")); await f.emit("turn_end");
	service.captureError = false; await f.emit("agent_settled");
	assert.deepEqual(ids(service), []);
	assert.equal(service.captureCalls, 1);
	f.journal.readError = true; f.journal.append(entry("unobserved-after-failure")); await f.emit("turn_end");
	f.journal.readError = false; await f.emit("agent_settled");
	assert.deepEqual(ids(service), []);
	f.journal.append(entry("new-after-failure")); await f.emit("turn_end");
	assert.deepEqual(ids(service), ["new-after-failure"]);
	service.onPolicy = () => { throw new Error("PRIVATE_CONFIG_ERROR_FIXTURE"); };
	f.journal.canRead = false;
	await f.emit("before_agent_start", before());
	assert.ok(f.notices.some(notice => /not retried/.test(notice.text)));
	assert.ok(f.notices.some(notice => /not be backfilled/.test(notice.text)));
	assert.ok(f.notices.some(notice => /policy could not be checked/.test(notice.text)));
	assert.ok(f.notices.every(notice => notice.level === "warning" && !/RAW_PAYLOAD|PRIVATE_CONFIG_ERROR/.test(notice.text)));
});

test("public in-memory SDK journal integration captures full entries without a model/provider or file session", async t => {
	const service = new MockArchiveService(); service.settings = { ...ON, modelAccess: false };
	const f = fixture(t, service);
	const manager = SessionManager.inMemory(f.cwd);
	manager.appendCustomEntry("fixture-old", { historical: true });
	const ctx = { ...f.ctx, sessionManager: manager } as unknown as ExtensionContext;
	await f.emit("session_start", { reason: "startup" }, ctx);
	const userId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "public SDK fixture" }, { type: "image", data: "ZmFrZQ==", mimeType: "image/png" }], timestamp: 100 });
	manager.appendThinkingLevelChange("high");
	manager.appendContextEdit(userId, null);
	manager.resetLeaf();
	manager.appendCustomEntry("fixture-new-branch", { raw: [1, 2, 3] });
	await f.emit("agent_settled", { type: "agent_settled" }, ctx);
	assert.deepEqual(service.captures.map(({ entry }) => entry), manager.getEntries().slice(1));
	assert.equal(manager.getSessionFile(), undefined);
	assert.deepEqual(readdirSync(f.cwd), []);
	assert.deepEqual(readdirSync(f.agentDir), []);
});
