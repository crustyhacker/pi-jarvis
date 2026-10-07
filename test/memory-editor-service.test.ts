import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { memoryConfigPath, saveMemoryPolicy } from "../memory-config.js";
import { SharedMemoryService, type MemoryContext } from "../memory-service.js";
import { MemoryEditorDataError, type MemoryRecord } from "../memory-types.js";
import type { MemoryEditorService, MemoryNoteDraft } from "../memory-editor-types.js";

const require = createRequire(import.meta.url);
const sqlite = () => (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
const draft = (patch: Partial<MemoryNoteDraft> = {}): MemoryNoteDraft => ({ title: "Synthetic fact", text: "Synthetic concise factual note", category: "project", scope: "project", ...patch });
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-editor-service-"));
	const agent = join(root, "agent"), a = join(root, "workspace-a"), b = join(root, "workspace-b");
	for (const path of [agent, a, b]) mkdirSync(path);
	const services: SharedMemoryService[] = [];
	const service = () => { const value = new SharedMemoryService(agent); services.push(value); return value; };
	const notices: { text: string; level: string; databaseExists: boolean; disclosed: boolean }[] = [];
	const ctx = (cwd = a, trusted: () => boolean = () => true, sessionId: () => string = () => "synthetic-main"): MemoryContext => ({
		cwd, hasUI: true, mode: "tui", isProjectTrusted: trusted,
		sessionManager: { getSessionId: sessionId },
		ui: { notify: (text: string, level = "info") => {
			let disclosed = false;
			try { disclosed = JSON.parse(readFileSync(memoryConfigPath(cwd, agent, "global"), "utf8")).memoryDisclosedVersion === 1; } catch { /* Synthetic absent/malformed config. */ }
			notices.push({ text, level, databaseExists: existsSync(join(agent, "extensions", "pi-jarvis-memory", "memory.sqlite")), disclosed });
		} },
	} as unknown as MemoryContext);
	t.after(() => { for (const value of services) value.close(); rmSync(root, { recursive: true, force: true }); });
	return { root, agent, a, b, services, service, ctx, notices };
}
const asDraft = (record: MemoryRecord, patch: Partial<MemoryNoteDraft> = {}): MemoryNoteDraft => ({ title: record.title, text: record.text,
	category: record.category, scope: record.scope, ...patch });
function noData(t: TestContext, service: SharedMemoryService) {
	const calls: string[] = [];
	for (const method of ["save", "get", "list", "update", "forget", "forgetAll", "editorList", "editorGet", "editorCreate", "editorUpdate", "editorForget"] as const) {
		t.mock.method(service.store, method, () => { calls.push(method); throw new Error("synthetic forbidden record access"); });
	}
	return () => assert.deepEqual(calls, []);
}
function observeTransactions(t: TestContext) {
	const Database = sqlite(), exec = Database.prototype.exec;
	let active = false, db: DatabaseSync | undefined;
	t.mock.method(Database.prototype, "exec", function(this: DatabaseSync, sql: string) {
		const result = exec.call(this, sql);
		if (sql === "BEGIN IMMEDIATE") { active = true; db = this; }
		if (sql === "COMMIT" || sql === "ROLLBACK") active = false;
		return result;
	});
	return { active: () => active, db: () => db };
}

test("service implements exact editor API, lazy enabled access and disclosure BEFORE record reads", t => {
	const f = fixture(t), service: MemoryEditorService = f.service(), ctx = f.ctx();
	assert.deepEqual(service.editorAccess(ctx), { enabled: true, capture: true, recall: true });
	assert.equal(f.notices.length, 1);
	assert.equal(f.notices[0].databaseExists, false); assert.equal(f.notices[0].disclosed, false);
	assert.equal(JSON.parse(readFileSync(memoryConfigPath(f.a, f.agent, "global"), "utf8")).memoryDisclosedVersion, 1);
	assert.deepEqual(service.editorList({ scope: "current" }, ctx), { records: [], total: 0, offset: 0, nextOffset: null });
	assert.equal(existsSync((service as SharedMemoryService).store.path), false);
	const record = service.editorCreate(draft({ text: "  line\r\n\t👩‍💻 café  " }), ctx);
	assert.equal(record.kind, "note"); assert.equal(record.text, "  line\n\t👩‍💻 café  "); assert.equal(record.source.lane, "manual");
	assert.equal(record.source.sessionId, "synthetic-main"); assert.ok(record.source.eventId.length > 0);
	assert.equal(record.project, f.a); assert.deepEqual(service.editorGet(record.id, ctx, "project"), record);
	assert.equal(service.editorList({ scope: "current" }, ctx).records[0].textBytes, Buffer.byteLength(record.text));
	assert.equal(f.notices.length, 1);
});

test("capture/recall pauses permit explicit editor administration but preserve model capability restrictions", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx();
	saveMemoryPolicy(f.a, f.agent, "global", { capture: false, recall: false });
	assert.deepEqual(service.editorAccess(ctx), { enabled: true, capture: false, recall: false });
	assert.equal(service.canUse("jarvis_memory_remember", ctx), false); assert.equal(service.canUse("jarvis_memory_search", ctx), false);
	const record = service.editorCreate(draft(), ctx);
	assert.deepEqual(service.editorGet(record.id, ctx, "current"), record);
	assert.equal(service.editorList({ scope: "project" }, ctx).total, 1);
	const updated = service.editorUpdate(record, asDraft(record, { category: "feedback", text: "human correction" }), ctx, "current");
	assert.equal(updated.category, "feedback");
	assert.equal(service.editorForget([updated], ctx, "current"), 1);
	assert.throws(() => service.remember(draft(), ctx, "main", "synthetic-model-call"), /capture.*disabled/);
	assert.throws(() => service.search("synthetic", "current", ctx), /recall.*disabled/);
	assert.match(service.command("remember Inline | explicit manual fact", ctx), /saved:/);
	assert.equal(service.editorList({ scope: "current" }, ctx).total, 1);
});

test("full off, untrusted and malformed policies deny every editor data method without record-store entry", async t => {
	for (const mode of ["off", "untrusted", "malformed"] as const) await t.test(mode, t => {
		const f = fixture(t), service = f.service();
		const initial = f.ctx(), record = service.editorCreate(draft(), initial);
		if (mode === "off") saveMemoryPolicy(f.a, f.agent, "global", { enabled: false });
		if (mode === "malformed") writeFileSync(memoryConfigPath(f.a, f.agent, "global"), '{"memory":PRIVATE_SYNTHETIC_CONFIG_CANARY');
		const ctx = mode === "untrusted" ? f.ctx(f.a, () => false) : initial;
		const assertNoData = noData(t, service);
		assert.equal(service.editorAccess(ctx).enabled, false);
		for (const operation of [ () => service.editorList({ scope: "all" }, ctx), () => service.editorGet(record.id, ctx, "all"),
			() => service.editorCreate(draft({ title: "Blocked" }), ctx), () => service.editorUpdate(record, asDraft(record), ctx, "all"),
			() => service.editorForget([record], ctx, "all") ]) assert.throws(operation, /paused|untrusted/);
		assertNoData();
		assert.ok(f.notices.every(notice => !notice.text.includes("PRIVATE_SYNTHETIC_CONFIG_CANARY")));
	});
});

test("editor cannot bypass global master-off even with project on", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx();
	saveMemoryPolicy(f.a, f.agent, "global", { enabled: false });
	saveMemoryPolicy(f.a, f.agent, "project", { enabled: true, capture: true, recall: true });
	assert.equal(service.editorAccess(ctx).enabled, false);
	assert.throws(() => service.editorCreate(draft(), ctx), /paused/);
	assert.equal(existsSync(service.store.path), false);
	assert.equal(f.notices.length, 0);
});

test("throwing trust getter is denial, observed exactly once per policy call and broadcasts revocation", t => {
	const f = fixture(t), service = f.service();
	let calls = 0, throwing = false;
	const ctx = f.ctx(f.a, () => { calls++; if (throwing) throw new Error("SYNTHETIC_TRUST_PRIVATE_CANARY"); return true; });
	assert.equal(service.policy(ctx).enabled, true); assert.equal(calls, 1);
	service.editorCreate(draft(), ctx);
	let policyChanges = 0; service.onChange(() => { policyChanges++; });
	const epoch = service.epoch; throwing = true; calls = 0;
	assert.equal(service.policy(ctx).enabled, false); assert.equal(calls, 1);
	assert.equal(service.epoch, epoch + 1); assert.equal(policyChanges, 1);
	assert.throws(() => service.editorList({ scope: "all" }, ctx), /paused|untrusted/);
	assert.ok(f.notices.every(notice => !notice.text.includes("SYNTHETIC_TRUST_PRIVATE_CANARY")));
});

test("failed visible disclosure denies editor access without initializing records or marking disclosure", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx();
	ctx.ui.notify = ((_text: string, level?: string) => { if (level === "info") throw new Error("synthetic disclosure failure"); }) as typeof ctx.ui.notify;
	assert.equal(service.editorAccess(ctx).enabled, false);
	assert.throws(() => service.editorCreate(draft(), ctx), /paused/);
	assert.equal(existsSync(service.store.path), false);
	assert.equal(existsSync(memoryConfigPath(f.a, f.agent, "global")), false);
});

test("editor scope/filter/search never includes conversation data; explicit all-project is required", t => {
	const f = fixture(t), service = f.service(), a = f.ctx(), b = f.ctx(f.b);
	const local = service.editorCreate(draft({ title: "Local", category: "reference" }), a);
	const foreign = service.editorCreate(draft({ title: "Foreign", category: "user" }), b);
	const global = service.editorCreate(draft({ title: "Global", scope: "global" }), b);
	service.capture({ role: "user", content: "Synthetic capture keyword", timestamp: 1 }, "main", a);
	const conversation = service.store.list({ project: f.a, kind: "conversation" })[0]; assert.ok(conversation);
	assert.equal(service.editorList({ scope: "current" }, a).total, 2);
	assert.equal(service.editorList({ scope: "project" }, a).total, 1);
	assert.equal(service.editorList({ scope: "global" }, a).records[0].id, global.id);
	assert.equal(service.editorList({ scope: "all", category: "user", lane: "manual", sort: "title" }, a).records[0].id, foreign.id);
	assert.equal(service.editorGet(foreign.id, a, "current"), undefined);
	assert.equal(service.editorGet(conversation.id, a, "all"), undefined);
	assert.throws(() => service.editorUpdate(conversation, asDraft(conversation), a, "all"), /curated note/);
	assert.throws(() => service.editorForget([local, conversation], a, "all"), /curated note/);
	assert.throws(() => service.editorForget([local, foreign], a, "current"), /Nothing was deleted/);
	assert.equal(service.editorForget([local, foreign], a, "all"), 2);
	assert.deepEqual(service.store.get(conversation.id, f.a), conversation);
});

test("new/duplicate note destination uses current canonical workspace; edits preserve origin provenance/project", t => {
	const f = fixture(t), service = f.service(), a = f.ctx(), b = f.ctx(f.b);
	service.remember({ title: "Origin", text: "origin model fact", category: "feedback" }, b, "jarvis", "synthetic-model-event");
	const origin = service.editorList({ scope: "all" }, a).records[0];
	const expected = service.editorGet(origin.id, a, "all")!;
	const edited = service.editorUpdate(expected, asDraft(expected, { title: "New origin heading", category: "reference" }), a, "all");
	assert.equal(edited.project, f.b); assert.deepEqual(edited.source, expected.source); assert.equal(edited.createdAt, expected.createdAt);
	const duplicate = service.editorCreate(asDraft(edited, { title: "Duplicate" }), a);
	assert.equal(duplicate.project, f.a); assert.equal(duplicate.source.lane, "manual"); assert.notEqual(duplicate.source.eventId, edited.source.eventId);
	const promoted = service.editorUpdate(edited, asDraft(edited, { scope: "global" }), a, "all");
	assert.equal(promoted.project, f.b); assert.deepEqual(promoted.source, expected.source);
	const demoted = service.editorUpdate(promoted, asDraft(promoted, { title: "Current destination", scope: "project" }), a, "global");
	assert.equal(demoted.project, f.a); assert.deepEqual(demoted.source, expected.source);
});

test("canonical cwd aliases resolve only the current workspace; foreign stored project metadata is never traversed", t => {
	const f = fixture(t), service = f.service(), alias = join(f.root, "workspace-alias");
	symlinkSync(f.a, alias, "dir");
	const ctx = f.ctx(alias), created = service.editorCreate(draft(), ctx);
	assert.equal(created.project, f.a);
	assert.equal(service.editorList({ scope: "project" }, f.ctx()).records[0].id, created.id);
	const absentOrigin = join(f.root, "nonexistent-origin-metadata");
	const foreign = service.store.editorCreate({ kind: "note", title: "Absent origin", text: "synthetic old project fact", category: "reference",
		scope: "project", project: absentOrigin, source: { lane: "main", sessionId: "s", eventId: "e" } });
	const updated = service.editorUpdate(foreign, asDraft(foreign, { text: "human correction" }), ctx, "all");
	assert.equal(updated.project, absentOrigin); assert.equal(existsSync(absentOrigin), false);
	assert.equal(service.editorForget([updated], ctx, "all"), 1);
});

test("create/duplicate title collisions and forgotten titles reject; only explicit remember restores", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx();
	const original = service.editorCreate(draft(), ctx);
	assert.throws(() => service.editorCreate(draft({ title: " SYNTHETIC   FACT ", text: "not a duplicate overwrite" }), ctx), /already exists/);
	assert.deepEqual(service.editorGet(original.id, ctx, "current"), original);
	assert.equal(service.editorForget([original], ctx, "current"), 1);
	assert.throws(() => service.editorCreate(draft(), ctx), /forgotten/);
	assert.match(service.remember(draft(), ctx, "main", "synthetic-model-event"), /Not saved/);
	assert.match(service.command("remember Synthetic fact | explicitly restored", ctx), /saved:/);
	assert.equal(service.editorGet(original.id, ctx, "current")!.text, "explicitly restored");
});

test("note-data observers are separate, throw-isolated and notify only acknowledged curated changes", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx(); service.editorAccess(ctx);
	let notes = 0, policies = 0;
	const unsubscribe = service.onNotesChange(() => { notes++; });
	service.onNotesChange(() => { throw new Error("synthetic subscriber fault"); });
	service.onChange(() => { policies++; }); const epoch = service.epoch;
	const created = service.editorCreate(draft(), ctx); assert.equal(notes, 1);
	const updated = service.editorUpdate(created, asDraft(created, { category: "user" }), ctx, "current"); assert.equal(notes, 2);
	assert.equal(service.editorForget([updated], ctx, "current"), 1); assert.equal(notes, 3);
	service.remember({ title: "Model note", text: "model fact" }, ctx, "main", "call"); assert.equal(notes, 4);
	service.command("remember Manual note | manual fact", ctx); assert.equal(notes, 5);
	const manual = service.editorList({ scope: "current", query: "Manual" }, ctx).records[0];
	service.command(`edit ${manual.id} corrected manual fact`, ctx); assert.equal(notes, 6);
	assert.match(service.forget(manual.id, ctx), /Forgotten/); assert.equal(notes, 7);
	service.capture({ role: "user", content: "synthetic captured body", timestamp: 10 }, "main", ctx); assert.equal(notes, 7);
	service.editorList({ scope: "all" }, ctx); assert.equal(notes, 7);
	service.command("forget-all --confirm", ctx); assert.equal(notes, 8);
	assert.equal(service.epoch, epoch); assert.equal(policies, 0);
	unsubscribe(); service.editorCreate(draft({ title: "After unsubscribe" }), ctx); assert.equal(notes, 8);
});

test("failed conflict/collision/validation operations do not notify data observers or discard expected/draft", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx();
	const expected = service.editorCreate(draft(), ctx), savedDraft = asDraft(expected, { text: "unsaved editor draft" });
	let changes = 0; service.onNotesChange(() => { changes++; });
	service.remember({ title: expected.title, text: "concurrent correction", category: "feedback" }, ctx, "jarvis", "other-call"); assert.equal(changes, 1);
	assert.throws(() => service.editorUpdate(expected, savedDraft, ctx, "current"), /changed/);
	assert.throws(() => service.editorForget([expected], ctx, "current"), /changed/);
	assert.throws(() => service.editorCreate(draft(), ctx), /already exists/);
	assert.throws(() => service.editorCreate(draft({ text: "token=synthetic-sensitive-value" }), ctx), /possible secret/);
	assert.equal(changes, 1); assert.equal(savedDraft.text, "unsaved editor draft"); assert.equal(expected.text, "Synthetic concise factual note");
	assert.equal(service.editorGet(expected.id, ctx, "current")!.text, "concurrent correction");
});

test("optional owner/session/tree/cancellation guard denies BEFORE store admission without synthetic policy revocation", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx();
	const record = service.editorCreate(draft(), ctx), epoch = service.epoch;
	let policyChanges = 0; service.onChange(() => { policyChanges++; });
	const assertNoData = noData(t, service);
	const check = () => { throw new Error("synthetic owner/session/tree expiry"); };
	for (const operation of [ () => service.editorList({ scope: "all" }, ctx, check), () => service.editorGet(record.id, ctx, "all", check),
		() => service.editorCreate(draft({ title: "Blocked" }), ctx, check), () => service.editorUpdate(record, asDraft(record), ctx, "all", check),
		() => service.editorForget([record], ctx, "all", check) ]) assert.throws(operation, /ownership expired|cancelled/);
	assertNoData(); assert.equal(service.epoch, epoch); assert.equal(policyChanges, 0);
	assert.equal(service.editorAccess(ctx).enabled, true);
});

test("owner guard reaches inside the transaction before COMMIT and cancels without policy epoch/capture invalidation", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx(), original = service.editorCreate(draft(), ctx);
	const state = observeTransactions(t), epoch = service.epoch;
	let notes = 0; service.onNotesChange(() => { notes++; });
	assert.throws(() => service.editorUpdate(original, asDraft(original, { title: "Cancelled rename", text: "pending correction" }), ctx, "current", () => {
		if (state.active() && state.db()!.prepare("SELECT 1 FROM records WHERE title='Cancelled rename'").get()) throw new Error("synthetic late cancellation");
	}), /cancelled/);
	assert.equal(service.epoch, epoch); assert.equal(notes, 0);
	assert.deepEqual(service.editorGet(original.id, ctx, "current"), original);
	assert.equal(service.editorList({ scope: "all", query: "correction" }, ctx).total, 0);
	service.capture({ role: "user", content: "capture remains permitted", timestamp: 2 }, "main", ctx);
	assert.equal(service.store.list({ project: f.a, kind: "conversation" }).length, 1);
});

test("live trust/settings denial BEFORE COMMIT rolls back row/FTS/tombstone and safely closes active storage", async t => {
	for (const denial of ["trust", "throwing-trust", "settings"] as const) await t.test(denial, t => {
		const f = fixture(t), service = f.service(); let trusted = true, throwing = false;
		const ctx = f.ctx(f.a, () => { if (throwing) throw new Error("synthetic trust observation failure"); return trusted; });
		const original = service.editorCreate(draft(), ctx), epoch = service.epoch, state = observeTransactions(t);
		let changed = false, notes = 0; service.onNotesChange(() => { notes++; });
		assert.throws(() => service.editorUpdate(original, asDraft(original, { title: "Denied rename", text: "uncommitted correction" }), ctx, "current", () => {
			if (!changed && state.active() && state.db()!.prepare("SELECT 1 FROM records WHERE title='Denied rename'").get()) {
				changed = true;
				if (denial === "trust") trusted = false;
				else if (denial === "throwing-trust") throwing = true;
				else saveMemoryPolicy(f.a, f.agent, "global", { enabled: false });
			}
		}), /paused|untrusted/);
		assert.equal(changed, true); assert.equal(notes, 0); assert.ok(service.epoch > epoch);
		assert.equal(service.editorAccess(ctx).enabled, false);
		trusted = true; throwing = false;
		if (denial === "settings") saveMemoryPolicy(f.a, f.agent, "global", { enabled: true });
		assert.deepEqual(service.editorGet(original.id, ctx, "current"), original);
		assert.equal(service.editorList({ scope: "all", query: "correction" }, ctx).total, 0);
		assert.throws(() => service.editorCreate(draft(), ctx), /already exists/);
	});
});

test("read guards withhold selected bodies/pages after cancellation at SQL boundaries without revoking policy", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx(), record = service.editorCreate(draft(), ctx), epoch = service.epoch;
	const Database = sqlite(), prepare = Database.prototype.prepare;
	let cancelled = false;
	t.mock.method(Database.prototype, "prepare", function(this: DatabaseSync, sql: string) {
		const statement = prepare.call(this, sql), get = statement.get.bind(statement);
		if (/SELECT r\.\* FROM records r WHERE r\.id=/.test(sql) || /SELECT count\(\*\) AS count FROM records r WHERE r\.kind='note'/.test(sql)) {
			t.mock.method(statement, "get", (...args: Parameters<typeof statement.get>) => { const result = get(...args); cancelled = true; return result; });
		}
		return statement;
	});
	const check = () => { if (cancelled) throw new Error("synthetic late read cancellation"); };
	assert.throws(() => service.editorGet(record.id, ctx, "current", check), /cancelled/);
	cancelled = false;
	assert.throws(() => service.editorList({ scope: "all" }, ctx, check), /cancelled/);
	assert.equal(service.epoch, epoch);
	t.mock.restoreAll();
	assert.deepEqual(service.editorGet(record.id, ctx, "current"), record);
});

test("captured optional definitions cannot commit after synthetic session/tree owner replacement", t => {
	const f = fixture(t), service = f.service(); let session = "synthetic-session-a", tree = "synthetic-leaf-a";
	const ctx = f.ctx(f.a, () => true, () => session), original = service.editorCreate(draft(), ctx);
	const owner = { session, tree };
	const check = () => { if (owner.session !== session || owner.tree !== tree) throw new Error("synthetic stale owner"); };
	const captured = () => service.editorUpdate(original, asDraft(original, { text: "stale owner write" }), ctx, "current", check);
	tree = "synthetic-leaf-b"; assert.throws(captured, /ownership expired/);
	tree = owner.tree; session = "synthetic-session-b"; assert.throws(captured, /ownership expired/);
	assert.deepEqual(service.editorGet(original.id, f.ctx(), "current"), original);
});

test("external service corrections require explicit re-read/review before update or atomic deletion", t => {
	const f = fixture(t), service = f.service(), writer = f.service(), ctx = f.ctx();
	const a = service.editorCreate(draft({ title: "A" }), ctx), b = service.editorCreate(draft({ title: "B" }), ctx);
	writer.remember({ title: "B", text: "external-service correction" }, f.ctx(f.a, () => true, () => "writer-session"), "main", "writer-call");
	assert.throws(() => service.editorUpdate(b, asDraft(b), ctx, "current"), /changed/);
	assert.throws(() => service.editorForget([a, b], ctx, "current"), /Nothing was deleted/);
	assert.deepEqual(service.editorGet(a.id, ctx, "current"), a);
	const reviewed = service.editorGet(b.id, ctx, "current")!;
	assert.equal(service.editorForget([a, reviewed], ctx, "current"), 2);
});

test("safe validation and operational errors never echo SQL, input canaries or parser/filesystem details", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx();
	assert.throws(() => service.editorCreate(draft({ title: "line\nnext" }), ctx), /single line/);
	assert.throws(() => service.editorCreate(draft({ text: "token=SYNTHETIC_PRIVATE_INPUT_CANARY" }), ctx), error =>
		error instanceof MemoryEditorDataError && error.code === "invalid" && !error.message.includes("SYNTHETIC_PRIVATE_INPUT_CANARY"));
	assert.throws(() => service.editorList({ scope: "all", query: "password=SYNTHETIC_PRIVATE_QUERY_CANARY" }, ctx), error =>
		error instanceof MemoryEditorDataError && !error.message.includes("SYNTHETIC_PRIVATE_QUERY_CANARY"));
	t.mock.method(service.store, "editorList", () => { throw new Error("SQL parser filesystem SYNTHETIC_STORAGE_PRIVATE_CANARY"); });
	assert.throws(() => service.editorList({ scope: "all" }, ctx), error =>
		error instanceof MemoryEditorDataError && error.code === "storage" && !error.message.includes("SYNTHETIC_STORAGE_PRIVATE_CANARY"));
	assert.ok(f.notices.every(notice => !/SYNTHETIC_PRIVATE|SYNTHETIC_STORAGE_PRIVATE/.test(notice.text)));
});

test("uncertain COMMIT is not replayed or announced as a data change; explicit refresh reveals actual committed row", t => {
	const f = fixture(t), service = f.service(), ctx = f.ctx(); service.editorCreate(draft(), ctx);
	let notes = 0; service.onNotesChange(() => { notes++; });
	const Database = sqlite(), exec = Database.prototype.exec; let commits = 0;
	t.mock.method(Database.prototype, "exec", function(this: DatabaseSync, sql: string) {
		exec.call(this, sql);
		if (sql === "COMMIT") { commits++; throw new Error("SYNTHETIC_UNCERTAIN_COMMIT_CANARY"); }
	});
	assert.throws(() => service.editorCreate(draft({ title: "Uncertain acknowledged state" }), ctx), /uncertain write may already have committed/);
	assert.equal(commits, 1); assert.equal(notes, 0);
	t.mock.restoreAll();
	assert.equal(service.editorList({ scope: "all" }, ctx).total, 2);
	assert.throws(() => service.editorCreate(draft({ title: "Uncertain acknowledged state" }), ctx), /already exists/);
});
