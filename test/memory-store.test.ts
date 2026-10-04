import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { MemoryStore, MEMORY_STORE_LIMITS } from "../memory-store.js";
import type { MemoryInput, MemoryRecord } from "../memory-types.js";

const require = createRequire(import.meta.url);
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const storeUrl = new URL("../memory-store.ts", import.meta.url).href;
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-jarvis-memory-test-"));
	const agent = join(root, "agent");
	const a = join(root, "project-a");
	const b = join(root, "project-b");
	const stores: MemoryStore[] = [];
	const store = (dir = agent) => { const value = new MemoryStore(dir); stores.push(value); return value; };
	t.after(() => { for (const value of stores) value.close(); fs.rmSync(root, { recursive: true, force: true }); });
	const input = (patch: Partial<MemoryInput> = {}): MemoryInput => ({
		kind: "note", category: "user", scope: "project", project: a, title: "Useful fact", text: "Temporary fixture fact",
		source: { lane: "manual", sessionId: "fixture-session", eventId: "fixture-event" }, ...patch,
	});
	return { root, agent, a, b, store, input };
}
function database(path: string): DatabaseSync {
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	return new DatabaseSync(path);
}
function withFault<K extends "lstatSync" | "openSync" | "opendirSync" | "fchmodSync">(key: K, run: () => void): void {
	const original = fs[key];
	fs[key] = (() => { throw Object.assign(new Error("fixture I/O failure"), { code: "EACCES" }); }) as typeof fs[K];
	syncBuiltinESMExports();
	try { run(); } finally { fs[key] = original; syncBuiltinESMExports(); }
}
function opaqueId(input: MemoryInput): string {
	const normalized = input.title.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
	const identity = input.kind === "note"
		? ["note", input.scope, input.scope === "project" ? input.project : "", normalized]
		: ["conversation", input.project, input.source.lane, input.source.sessionId, input.source.eventId];
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
function seed(path: string, inputs: MemoryInput[], timestamp = Date.now() - 100_000): void {
	const db = database(path);
	try {
		db.exec("BEGIN IMMEDIATE");
		const statement = db.prepare(`INSERT INTO records(id,kind,category,scope,project,title,text,search_title,search_text,lane,session_id,event_id,role,created_at,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
		const fts = db.prepare("INSERT INTO records_fts(rowid,search_title,search_text) VALUES(?,?,?)");
		for (const [index, input] of inputs.entries()) {
			const inserted = statement.run(opaqueId(input), input.kind, input.category, input.scope, input.project, input.title,
				input.text, normalize(input.title), normalize(input.text), input.source.lane, input.source.sessionId, input.source.eventId,
				input.source.role ?? null, timestamp + index, timestamp + index);
			fts.run(inserted.lastInsertRowid, normalize(input.title), normalize(input.text));
		}
		db.exec("COMMIT");
	} finally { db.close(); }
}
function rows(path: string, sql: string): Record<string, unknown>[] {
	const db = database(path);
	try { return db.prepare(sql).all(); } finally { db.close(); }
}

test("constructor/close are entirely lazy; fresh reads do not create directories or load SQLite", (t) => {
	const f = fixture(t);
	for (const key of ["lstatSync", "openSync", "opendirSync"] as const) withFault(key, () => {
		const store = f.store();
		assert.equal(store.path, join(f.agent, "extensions", "pi-jarvis-memory", "memory.sqlite"));
		store.close(); store.close();
	});
	const store = f.store();
	assert.deepEqual(store.list({ project: f.a }), []);
	assert.equal(store.get("a".repeat(64), f.a), undefined);
	assert.equal(fs.existsSync(f.agent), false);
	const script = `const {MemoryStore}=await import(${JSON.stringify(storeUrl)}); const s=new MemoryStore(process.argv[1]);
		s.close(); s.list({project:process.argv[2]}); s.get('a'.repeat(64),process.argv[2]);`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.agent, f.a], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	assert.doesNotMatch(child.stderr, /SQLite|ExperimentalWarning/);
	assert.equal(fs.existsSync(f.agent), false);
});

test("persistent roundtrip, detached results, opaque IDs, and idempotent close/reopen", (t) => {
	const f = fixture(t);
	const store = f.store();
	const input = f.input({ text: "  exact whitespace\n☃ fixture  ", source: { lane: "manual", sessionId: "s", eventId: "e", role: "user" } });
	const result = store.save(input);
	assert.equal(result.outcome, "saved");
	const record = result.record!;
	assert.match(record.id, /^[a-f0-9]{64}$/);
	assert.equal(record.id, opaqueId(input));
	assert.equal(record.createdAt, record.updatedAt);
	assert.deepEqual(store.get(record.id, f.a), record);
	assert.equal(fs.statSync(dirname(store.path)).mode & 0o777, 0o700);
	assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
	for (const name of ["memory.sqlite-wal", "memory.sqlite-shm"]) assert.equal(fs.statSync(join(dirname(store.path), name)).mode & 0o777, 0o600);
	const pristine = structuredClone(record);
	record.text = "mutated result";
	record.source.eventId = "mutated source";
	assert.deepEqual(store.get(record.id, f.a), pristine);
	store.close(); store.close();
	assert.deepEqual(store.get(record.id, f.a), pristine);
	assert.deepEqual(f.store().get(record.id, f.a), pristine);
	assert.deepEqual(rows(store.path, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'records_fts*' ORDER BY name").map(row => row.name), ["records", "tombstones"]);
});

test("scope isolation for list/get/update/forget and explicit all-project opt-ins", (t) => {
	const f = fixture(t);
	const store = f.store();
	const a = store.save(f.input({ title: "A" })).record!;
	const b = store.save(f.input({ project: f.b, title: "B" })).record!;
	const global = store.save(f.input({ scope: "global", title: "Global" })).record!;
	const titles = (scope?: "current" | "global" | "all") => store.list({ project: f.a, scope }).map(row => row.title).sort();
	assert.deepEqual(titles(), ["A", "Global"]);
	assert.deepEqual(titles("global"), ["Global"]);
	assert.deepEqual(titles("all"), ["A", "B", "Global"]);
	assert.equal(store.get(b.id, f.a), undefined);
	assert.deepEqual(store.get(b.id, f.a, true), b);
	assert.deepEqual(store.get(global.id, f.b), global);
	assert.equal(store.update(b.id, f.a, "wrong project"), undefined);
	assert.equal(store.forget(b.id, f.a), false);
	assert.deepEqual(store.get(b.id, f.b), b);
	assert.equal(store.update(global.id, f.b, "global update")!.text, "global update");
	assert.equal(store.forget(b.id, f.a, true), true);
	assert.equal(store.get(b.id, f.b), undefined);
	assert.equal(store.forget(a.id, f.a), true);
	assert.equal(store.forget(a.id, f.a), false);
	assert.equal(store.forget(global.id, f.b), true);
});

test("notes deduplicate normalized scoped titles and track latest correcting source/category", (t) => {
	const f = fixture(t);
	const store = f.store();
	const original = store.save(f.input({ title: "  ＦＡＣＴ   One  ", category: "feedback" })).record!;
	const next = store.save(f.input({ title: "fact one", text: "Revised fact", category: "reference", source: { lane: "jarvis", sessionId: "other", eventId: "other" } }));
	assert.equal(next.outcome, "updated");
	assert.equal(next.record!.id, original.id);
	assert.equal(next.record!.category, "reference");
	assert.deepEqual(next.record!.source, { lane: "jarvis", sessionId: "other", eventId: "other" });
	assert.equal(next.record!.createdAt, original.createdAt);
	assert.ok(next.record!.updatedAt > original.updatedAt);
	assert.equal(store.save(f.input({ title: "fact one", text: "Revised fact", category: "reference", source: { lane: "jarvis", sessionId: "other", eventId: "other" } })).outcome, "duplicate");
	assert.equal(store.save(f.input({ project: f.b, title: "fact one" })).outcome, "saved");
	const global = store.save(f.input({ scope: "global", title: "fact one" })).record!;
	const globalUpdate = store.save(f.input({ scope: "global", project: f.b, title: "FACT ONE", text: "Updated across projects" }));
	assert.equal(globalUpdate.outcome, "updated");
	assert.equal(globalUpdate.record!.id, global.id);
	assert.equal(globalUpdate.record!.project, f.b);
	assert.equal(store.list({ project: f.a, scope: "all" }).length, 3);
});

test("capture deduplication uses lane, session, event and exact project, never message body", (t) => {
	const f = fixture(t);
	const store = f.store();
	const captured = f.input({ kind: "conversation", source: { lane: "main", sessionId: "s", eventId: "e", role: "user" } });
	const original = store.save(captured).record!;
	assert.equal(store.save({ ...captured, text: "a duplicate must not overwrite", scope: "global" }).outcome, "duplicate");
	assert.deepEqual(store.get(original.id, f.a), original);
	for (const changed of [
		{ ...captured, project: f.b },
		{ ...captured, source: { ...captured.source, lane: "jarvis" as const } },
		{ ...captured, source: { ...captured.source, sessionId: "s2" } },
		{ ...captured, source: { ...captured.source, eventId: "e2" } },
	]) assert.equal(store.save(changed).outcome, "saved");
	assert.equal(store.list({ project: f.a, scope: "all", kind: "conversation" }).length, 5);
});

test("forget persists compact tombstones; only explicit human recreation removes them", (t) => {
	const f = fixture(t);
	const store = f.store();
	for (const kind of ["note", "conversation"] as const) {
		const input = f.input({ kind, text: "private fixture text" });
		const id = store.save(input).record!.id;
		assert.equal(store.forget(id, f.a), true);
		store.close();
		assert.deepEqual(store.save(input), { outcome: "forgotten" });
		assert.deepEqual(store.save({ ...input, text: "changed content still forgotten" }, { explicit: false }), { outcome: "forgotten" });
		assert.equal(store.get(id, f.a), undefined);
		const tombstone = rows(store.path, "SELECT * FROM tombstones").find(row => row.id === id)!;
		assert.deepEqual(Object.keys(tombstone).sort(), ["deleted_at", "id"]);
		const result = store.save(input, { explicit: true });
		assert.equal(result.outcome, "saved");
		assert.equal(result.record!.id, id);
		assert.equal(rows(store.path, `SELECT count(*) AS count FROM tombstones WHERE id='${id}'`)[0].count, 0);
	}
});

test("updates preserve scope/category/source, rename deterministically, and reject collisions atomically", (t) => {
	const f = fixture(t);
	const store = f.store();
	const record = store.save(f.input({ category: "reference", title: "Old title" })).record!;
	const updated = store.update(record.id, f.a, "new text")!;
	assert.deepEqual({ ...updated, text: record.text, updatedAt: record.updatedAt }, record);
	assert.ok(updated.updatedAt > record.updatedAt);
	const renamed = store.update(record.id, f.a, "renamed text", "New title")!;
	assert.notEqual(renamed.id, record.id);
	assert.equal(renamed.id, opaqueId(f.input({ title: "New title" })));
	assert.equal(renamed.createdAt, record.createdAt);
	assert.equal(store.get(record.id, f.a), undefined);
	assert.equal(store.save(f.input({ title: "Old title" })).outcome, "forgotten");
	const occupied = store.save(f.input({ title: "Occupied" })).record!;
	assert.throws(() => store.update(renamed.id, f.a, "not saved", occupied.title), /already exists/);
	assert.deepEqual(store.get(renamed.id, f.a), renamed);
	assert.equal(store.forget(occupied.id, f.a), true);
	assert.throws(() => store.update(renamed.id, f.a, "not saved", occupied.title), /forgotten/);
	assert.deepEqual(store.get(renamed.id, f.a), renamed);
	const capture = store.save(f.input({ kind: "conversation" })).record!;
	assert.equal(store.update(capture.id, f.a, "edited capture", "Edited heading")!.id, capture.id);
});

test("keyword recall is literal, Unicode normalized, scoped, capped and deterministically ranked", (t) => {
	const f = fixture(t);
	const store = f.store();
	const old = store.save(f.input({ title: "Fixture match old", text: "foo bar" })).record!;
	const recent = store.save(f.input({ title: "Fixture match recent", text: "foo bar" })).record!;
	store.update(recent.id, f.a, "foo bar");
	store.save(f.input({ kind: "conversation", title: "Fixture match capture", text: "foo bar" }));
	store.save(f.input({ project: f.b, title: "Fixture match other project", text: "foo bar" }));
	assert.deepEqual(store.list({ project: f.a, query: "foo bar" }).map(row => row.title), [recent.title, old.title, "Fixture match capture"]);
	assert.equal(store.list({ project: f.a, query: "foo absent" }).length, 3, "OR keywords should not require every natural-question term");
	assert.equal(store.list({ project: f.a, scope: "all", query: "foo", kind: "note" }).length, 3);
	const literal = store.save(f.input({ title: "literal syntax", text: `%_ ' OR 1=1 -- \"quoted\" * : () ÄPFEL ＷＩＤＥ` })).record!;
	for (const query of ["\"quoted\"", "äpfel", "wide"]) {
		assert.deepEqual(store.list({ project: f.a, query }).map(row => row.id), [literal.id]);
	}
	for (const query of ["%_", "*", ":", "()", "\" OR * NOT \"", "NEAR(foo,bar)"]) {
		assert.doesNotThrow(() => store.list({ project: f.a, query }));
	}
	assert.deepEqual(store.list({ project: f.a, query: "*" }), [], "literal wildcard must not expose all records");
	const snapshot = store.list({ project: f.a, query: "fixture match", scope: "all" }).map(row => row.id);
	store.close();
	assert.deepEqual(store.list({ project: f.a, query: "fixture match", scope: "all" }).map(row => row.id), snapshot);
	for (let i = 0; i < 60; i++) store.save(f.input({ title: `limit note ${i}` }));
	assert.equal(store.list({ project: f.a }).length, 20);
	assert.equal(store.list({ project: f.a, limit: 500 }).length, 50);
	assert.equal(store.list({ project: f.a, limit: 0 }).length, 1);
	assert.equal(store.list({ project: f.a, limit: -10 }).length, 1);
});

test("invalid inputs reject before filesystem access, with exact UTF-8 and title boundaries", (t) => {
	const f = fixture(t);
	const store = f.store();
	const patches = [
		{ kind: "invalid" }, { category: "invalid" }, { scope: "all" }, { project: "relative" }, { project: `${f.a}/..` },
		{ title: " " }, { title: "a".repeat(161) }, { title: "😀".repeat(161) }, { title: "\ud800" },
		{ text: "" }, { text: " " }, { text: "\0" }, { text: "\udfff" }, { text: "😀".repeat(4097) },
		{ source: null }, { source: { lane: "invalid", sessionId: "s", eventId: "e" } },
		{ source: { lane: "main", sessionId: "", eventId: "e" } },
		{ source: { lane: "main", sessionId: "s", eventId: "e".repeat(513) } },
		{ source: { lane: "main", sessionId: "s", eventId: "e", role: "system" } },
	];
	withFault("lstatSync", () => {
		for (const patch of patches) assert.throws(() => store.save(f.input(patch as Partial<MemoryInput>)), /Invalid memory/);
		assert.throws(() => store.save(f.input(), { explicit: "yes" } as never), /options/);
		assert.throws(() => store.save(null as never), /input/);
		for (const query of [
			{ project: "relative" }, { project: f.a, scope: "bad" }, { project: f.a, scope: null }, { project: f.a, kind: "bad" },
			{ project: f.a, limit: NaN }, { project: f.a, limit: 1.5 }, { project: f.a, limit: "1" },
			{ project: f.a, query: "\0" }, { project: f.a, query: "q".repeat(513) },
			{ project: f.a, query: Array.from({ length: 129 }, (_, i) => `q${i}`).join(" ") },
		]) assert.throws(() => store.list(query as never), /Invalid memory/);
		assert.throws(() => store.get("not an ID", f.a), /ID/);
		assert.throws(() => store.get("a".repeat(64), f.a, "yes" as never), /flag/);
		assert.throws(() => store.forget("a".repeat(64), f.a, 1 as never), /flag/);
		assert.throws(() => store.update("a".repeat(64), f.a, "a".repeat(16385)), /text/);
		assert.throws(() => store.update("a".repeat(64), f.a, "text", "a".repeat(161)), /title/);
	});
	assert.equal(fs.existsSync(f.agent), false);
	const max = store.save(f.input({ title: "😀".repeat(160), text: "😀".repeat(4096) })).record!;
	assert.equal(Buffer.byteLength(max.text), 16384);
	assert.equal([...max.title].length, 160);
	assert.deepEqual(store.get(max.id, f.a), max);
	store.close();
	assert.deepEqual(store.get(max.id, f.a), max);
});

test("retention prunes only oldest captures and explicitly fails at curated note cap", (t) => {
	const f = fixture(t);
	const store = f.store();
	const note = store.save(f.input({ title: "Curated permanent" })).record!;
	store.close();
	const captures = Array.from({ length: MEMORY_STORE_LIMITS.conversations }, (_, i) => f.input({
		kind: "conversation", title: `Capture ${i}`, source: { lane: "main", sessionId: "fixture", eventId: `e-${i}` },
	}));
	seed(store.path, captures, Date.now() + 100_000); // Simulate a backwards clock: the new capture must still survive.
	const newest = store.save(f.input({ kind: "conversation", source: { lane: "main", sessionId: "fixture", eventId: "newest" } })).record!;
	assert.ok(newest);
	assert.equal(store.get(opaqueId(captures[0]), f.a), undefined);
	assert.ok(store.get(opaqueId(captures[1]), f.a));
	assert.deepEqual(store.get(note.id, f.a), note);
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records WHERE kind='conversation'")[0].count, MEMORY_STORE_LIMITS.conversations);
	store.close();
	seed(store.path, Array.from({ length: MEMORY_STORE_LIMITS.notes - 1 }, (_, i) => f.input({ title: `Curated ${i}` })));
	assert.throws(() => store.save(f.input({ title: "Cannot silently drop notes" })), /note limit/);
	assert.equal(store.save(f.input({ title: note.title, text: "still can update at cap" })).outcome, "updated");
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records WHERE kind='note'")[0].count, MEMORY_STORE_LIMITS.notes);
	const blocked = f.input({ title: "Previously forgotten at full note cap" });
	const db = database(store.path);
	try { db.prepare("INSERT INTO tombstones VALUES(?,?)").run(opaqueId(blocked), Date.now()); } finally { db.close(); }
	assert.throws(() => store.save(blocked, { explicit: true }), /note limit/);
	assert.equal(store.save(blocked).outcome, "forgotten", "failed explicit recreation must roll back tombstone deletion");
	assert.equal(store.get(newest.id, f.a)!.id, newest.id);
});

test("identity budget pauses only new identities; forgetting, upserting and explicit restore remain available", (t) => {
	const f = fixture(t); const store = f.store();
	const noteInput = f.input({ title: "Reviewed fixture at capacity" });
	const note = store.save(noteInput).record!;
	store.close();
	const captures = Array.from({ length: MEMORY_STORE_LIMITS.conversations }, (_, i) => f.input({
		kind: "conversation", source: { lane: "main", sessionId: "budget-fixture", eventId: `e-${i}` },
	}));
	seed(store.path, captures);
	const db = database(store.path);
	try {
		db.exec("BEGIN IMMEDIATE");
		const insert = db.prepare("INSERT INTO tombstones(id,deleted_at) VALUES(?,?)");
		for (let i = 0; i < MEMORY_STORE_LIMITS.identities - captures.length - 1; i++) insert.run(i.toString(16).padStart(64, "0"), Date.now());
		db.exec("COMMIT");
	} finally { db.close(); }
	assert.throws(() => store.save(f.input({ title: "New identity blocked" })), /identity budget exhausted/);
	assert.throws(() => store.update(note.id, f.a, "not saved", "Renamed identity blocked"), /identity budget exhausted/);
	assert.deepEqual(store.get(note.id, f.a), note);
	assert.equal(store.save({ ...noteInput, text: "same identity can be corrected" }).outcome, "updated");
	const newest = store.save(f.input({ kind: "conversation", source: { lane: "main", sessionId: "budget-fixture", eventId: "new-at-capacity" } })).record!;
	assert.ok(newest, "archive pruning happens before new identity reservation");
	assert.equal(store.get(opaqueId(captures[0]), f.a), undefined);
	assert.equal(store.save(f.input({ kind: "conversation", source: { lane: "main", sessionId: "budget-fixture", eventId: "new-at-capacity" } })).outcome, "duplicate");
	const current = store.get(note.id, f.a)!;
	assert.equal(store.forget(note.id, f.a, false, current), true, "live record reserved deletion capacity");
	assert.equal(store.save(noteInput, { explicit: true }).outcome, "saved", "restore transfers tombstone slot to live record");
	assert.equal(store.forgetAll(f.a, "all"), captures.length + 1, "all existing rows can become tombstones at capacity");
	store.close();
	assert.deepEqual(store.list({ project: f.a, scope: "all" }), []);
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, MEMORY_STORE_LIMITS.identities);
	assert.equal(store.save(noteInput).outcome, "forgotten");
	assert.throws(() => store.save(f.input({ title: "Still blocked new identity" })), /identity budget exhausted/);
	assert.equal(store.save(noteInput, { explicit: true }).outcome, "saved");
	assert.equal(store.forget(note.id, f.a), true);
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, MEMORY_STORE_LIMITS.identities);
});

test("symlink directories and unexpected owned-subtree entries are rejected", async (t) => {
	for (const location of ["extensions", "memory", "unexpected"] as const) await t.test(location, (t) => {
		const f = fixture(t);
		const store = f.store();
		const target = join(f.root, "target"); fs.mkdirSync(target); fs.writeFileSync(join(target, "marker"), "unchanged");
		const memory = dirname(store.path);
		const path = location === "extensions" ? dirname(memory) : location === "memory" ? memory : join(memory, "unexpected");
		fs.mkdirSync(dirname(path), { recursive: true });
		fs.symlinkSync(target, path, "dir");
		assert.throws(() => store.save(f.input()), /storage/);
		assert.throws(() => store.list({ project: f.a }), /storage/);
		assert.deepEqual(fs.readdirSync(target), ["marker"]);
		assert.equal(fs.readFileSync(join(target, "marker"), "utf8"), "unchanged");
	});
});

test("DB and all SQLite auxiliary paths reject symlinks, hardlinks and nonregular files", async (t) => {
	for (const name of ["memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm", "memory.sqlite-journal"]) {
		for (const kind of ["symlink", "hardlink", "directory"] as const) await t.test(`${name} ${kind}`, (t) => {
			const f = fixture(t);
			const store = f.store();
			store.save(f.input()); store.close();
			const path = join(dirname(store.path), name);
			if (fs.existsSync(path)) fs.unlinkSync(path);
			const victim = join(f.root, "victim"); fs.writeFileSync(victim, "unchanged fixture");
			if (kind === "symlink") fs.symlinkSync(victim, path);
			else if (kind === "hardlink") fs.linkSync(victim, path);
			else fs.mkdirSync(path);
			assert.throws(() => store.list({ project: f.a }), /storage|orphaned/);
			assert.throws(() => store.save(f.input()), /storage|orphaned/);
			assert.equal(fs.readFileSync(victim, "utf8"), "unchanged fixture");
		});
	}
});

test("existing permissive storage is tightened, active DB replacement and orphan auxiliaries reject", (t) => {
	const f = fixture(t);
	const store = f.store();
	fs.mkdirSync(dirname(store.path), { recursive: true, mode: 0o755 });
	store.save(f.input());
	assert.equal(fs.statSync(dirname(store.path)).mode & 0o777, 0o700);
	fs.renameSync(store.path, join(f.root, "old.sqlite"));
	fs.copyFileSync(join(f.root, "old.sqlite"), store.path);
	assert.throws(() => store.list({ project: f.a }), /replaced database/);
	store.close();
	const other = f.store(join(f.root, "orphan-agent"));
	fs.mkdirSync(dirname(other.path), { recursive: true });
	fs.writeFileSync(`${other.path}-wal`, "orphan");
	assert.throws(() => other.list({ project: f.a }), /orphaned/);
	assert.throws(() => other.save(f.input()), /orphaned/);
	assert.equal(fs.existsSync(other.path), false);
});

test("unknown versions, foreign schema and malformed/corrupt content are never reset", async (t) => {
	const corruptions: [string, (db: DatabaseSync, record: MemoryRecord) => void][] = [
		["future version", db => db.exec("PRAGMA user_version=2")],
		["zero version with data", db => db.exec("PRAGMA user_version=0")],
		["unexpected schema", db => db.exec("CREATE TABLE sqliteevil(secret TEXT)")],
		["oversize text", db => db.exec("PRAGMA ignore_check_constraints=ON; UPDATE records SET text=printf('%017000d',0)")],
		["relative project", db => db.exec("UPDATE records SET project='relative'")],
		["identity mismatch", db => db.exec(`UPDATE records SET id='${"a".repeat(64)}'`)],
		["invalid timestamp", db => db.exec("PRAGMA ignore_check_constraints=ON; UPDATE records SET updated_at=0")],
		["invalid role", db => db.exec("PRAGMA ignore_check_constraints=ON; UPDATE records SET role='system'")],
		["invalid UTF8", db => db.exec("UPDATE records SET text=CAST(x'ff' AS TEXT)")],
		["FTS index content mismatch", db => db.exec("INSERT INTO records_fts(records_fts,rowid,search_title,search_text) SELECT 'delete',rowid,search_title,search_text FROM records")],
		["derived search content mismatch", db => db.exec("UPDATE records SET search_text='wrong index source'")],
		["record/tombstone overlap", (db, record) => db.prepare("INSERT INTO tombstones VALUES(?,?)").run(record.id, Date.now())],
	];
	for (const [name, mutate] of corruptions) await t.test(name, (t) => {
		const f = fixture(t);
		const store = f.store();
		const record = store.save(f.input()).record!; store.close();
		const db = database(store.path); try { mutate(db, record); } finally { db.close(); }
		const before = fs.readFileSync(store.path);
		assert.throws(() => store.list({ project: f.a }));
		assert.throws(() => store.save(f.input()));
		assert.deepEqual(fs.readFileSync(store.path), before);
	});
	await t.test("over-budget database rejects without resetting", (t) => {
		const f = fixture(t); const store = f.store(); store.save(f.input()); store.close();
		const db = database(store.path);
		try {
			db.exec("BEGIN IMMEDIATE"); const insert = db.prepare("INSERT INTO tombstones VALUES(?,?)");
			for (let i = 0; i < MEMORY_STORE_LIMITS.identities; i++) insert.run(i.toString(16).padStart(64, "0"), Date.now());
			db.exec("COMMIT");
		} finally { db.close(); }
		const before = fs.readFileSync(store.path);
		assert.throws(() => store.list({ project: f.a }), /identity budget/);
		assert.deepEqual(fs.readFileSync(store.path), before);
	});
	await t.test("invalid SQLite header", (t) => {
		const f = fixture(t); const store = f.store();
		fs.mkdirSync(dirname(store.path), { recursive: true });
		fs.writeFileSync(store.path, "not a database: fixture bytes");
		assert.throws(() => store.list({ project: f.a }));
		assert.equal(fs.readFileSync(store.path, "utf8"), "not a database: fixture bytes");
	});
	await t.test("oversize SQLite file", (t) => {
		const f = fixture(t); const store = f.store();
		fs.mkdirSync(dirname(store.path), { recursive: true }); fs.writeFileSync(store.path, "");
		fs.truncateSync(store.path, 512 * 1024 * 1024 + 1);
		assert.throws(() => store.list({ project: f.a }), /database size/);
		assert.equal(fs.statSync(store.path).size, 512 * 1024 * 1024 + 1);
	});
});

test("I/O errors propagate, preserve existing data, and can recover after close", (t) => {
	const f = fixture(t); const store = f.store();
	const record = store.save(f.input()).record!; store.close();
	for (const key of ["lstatSync", "openSync", "opendirSync", "fchmodSync"] as const) {
		withFault(key, () => assert.throws(() => store.save(f.input({ text: "must not be saved" })), /fixture I\/O failure/));
		store.close();
		assert.deepEqual(store.get(record.id, f.a), record);
		store.close();
	}
});

function sqliteError(errcode: number): Error {
	return Object.assign(new Error("fixture SQLite failure"), { code: "ERR_SQLITE_ERROR", errcode });
}
function interceptWal(t: TestContext, attempt: (db: DatabaseSync, get: () => Record<string, unknown> | undefined) => Record<string, unknown> | undefined): void {
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const prepare = DatabaseSync.prototype.prepare;
	t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
		const db = this;
		const statement = prepare.call(db, sql);
		if (sql === "PRAGMA journal_mode=WAL") {
			const get = statement.get.bind(statement);
			t.mock.method(statement, "get", () => attempt(db, () => get()));
		}
		return statement;
	});
}
function observeCloseTimeout(t: TestContext): number[] {
	const timeouts: number[] = [];
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const close = DatabaseSync.prototype.close;
	t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
		timeouts.push(Number(this.prepare("PRAGMA busy_timeout").get()!.timeout));
		close.call(this);
	});
	return timeouts;
}

test("WAL initialization retries a real upgrade lock only after validation and restores busy timeout", (t) => {
	const f = fixture(t); const store = f.store();
	const original = store.save(f.input()).record!; store.close();
	const db = database(store.path);
	try { assert.equal(db.prepare("PRAGMA journal_mode=DELETE").get()!.journal_mode, "delete"); }
	finally { db.close(); }
	let attempts = 0;
	let connection!: DatabaseSync;
	interceptWal(t, (db, get) => {
		connection = db;
		assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 0);
		assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
		assert.equal(db.prepare("SELECT count(*) AS count FROM records").get()!.count, 1);
		if (++attempts !== 1) return get();
		// Acquire a rollback-journal reader AFTER validation's COMMIT. WAL's
		// exclusive upgrade must fail even though ordinary writes are valid.
		const blocker = database(store.path);
		try {
			blocker.exec("BEGIN");
			blocker.prepare("SELECT * FROM records").get();
			try { get(); } catch (error) {
				assert.equal((error as { errcode: number }).errcode & 0xff, 5);
				throw error; // Deliver the actual SQLite contention to initialization.
			}
			assert.fail("WAL upgrade unexpectedly succeeded under a reader lock");
		} finally { blocker.close(); }
	});
	assert.equal(store.save(f.input({ title: "Second fixture" })).outcome, "saved");
	assert.equal(attempts, 2);
	assert.equal(connection.prepare("PRAGMA busy_timeout").get()!.timeout, 5000);
	assert.equal(connection.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
	assert.deepEqual(store.get(original.id, f.a), original);
	assert.equal(store.list({ project: f.a }).length, 2);
});

test("WAL initialization retries only SQLite BUSY/LOCKED, including extended result codes", (t) => {
	const f = fixture(t); const store = f.store();
	const errors = [5, 6, 261, 262].map(sqliteError);
	let attempts = 0;
	let connection!: DatabaseSync;
	interceptWal(t, (db, get) => {
		connection = db;
		assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 0);
		const error = errors[attempts++];
		if (error) throw error;
		return get();
	});
	assert.equal(store.save(f.input()).outcome, "saved");
	assert.equal(attempts, errors.length + 1);
	assert.equal(connection.prepare("PRAGMA busy_timeout").get()!.timeout, 5000);
	assert.equal(store.list({ project: f.a }).length, 1);
});

test("WAL initialization also retries lock failures while preparing the pragma", (t) => {
	const f = fixture(t); const store = f.store();
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const prepare = DatabaseSync.prototype.prepare;
	let attempts = 0;
	let connection!: DatabaseSync;
	t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
		if (sql === "PRAGMA journal_mode=WAL") {
			connection = this;
			if (++attempts === 1) throw sqliteError(6);
		}
		return prepare.call(this, sql);
	});
	assert.equal(store.save(f.input()).outcome, "saved");
	assert.equal(attempts, 2);
	assert.equal(connection.prepare("PRAGMA busy_timeout").get()!.timeout, 5000);
});

test("WAL initialization has one finite retry budget and restores timeout on exhaustion", (t) => {
	const f = fixture(t); const store = f.store();
	const error = sqliteError(5);
	const timeouts = observeCloseTimeout(t);
	let elapsed = 0, attempts = 0, waits = 0;
	t.mock.method(performance, "now", () => elapsed);
	t.mock.method(Atomics, "wait", (_buffer: Int32Array, _index: number, _value: number, timeout: number) => {
		assert.ok(timeout > 0 && timeout <= 20);
		elapsed += timeout; waits++;
		return "timed-out";
	});
	interceptWal(t, (db) => {
		assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 0);
		assert.ok(elapsed < 5000, "must not start a retry after the deadline");
		attempts++; throw error;
	});
	try {
		assert.throws(() => store.save(f.input()), (value: unknown) => value === error);
		assert.equal(elapsed, 5000);
		assert.equal(attempts, 250);
		assert.equal(waits, 250);
		assert.deepEqual(timeouts, [5000]);
	} finally { t.mock.restoreAll(); }
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records")[0].count, 0);
	assert.equal(store.save(f.input()).outcome, "saved", "bounded contention failure can recover on a later explicit call");
});

test("WAL initialization never retries non-lock failures or an unexpected mode, and restores timeout", async (t) => {
	const cases = [
		["I/O", sqliteError(10)], ["corruption", sqliteError(11)], ["schema", sqliteError(17)],
		["message only", new Error("database is locked")],
		["non-SQLite code", Object.assign(new Error("database is locked"), { code: "EACCES", errcode: 5 })],
		["unexpected mode", undefined],
	] as const;
	for (const [name, error] of cases) await t.test(name, (t) => {
		const f = fixture(t); const store = f.store();
		const timeouts = observeCloseTimeout(t);
		let attempts = 0;
		t.mock.method(Atomics, "wait", () => assert.fail("non-lock errors must not be retried"));
		interceptWal(t, () => { attempts++; if (error) throw error; return { journal_mode: "delete" }; });
		assert.throws(() => store.save(f.input()), (value: unknown) => error ? value === error : /journal mode/.test(String(value)));
		assert.equal(attempts, 1);
		assert.deepEqual(timeouts, [5000]);
		t.mock.restoreAll();
		assert.equal(rows(store.path, "SELECT count(*) AS count FROM records")[0].count, 0);
	});
});

test("WAL initialization never runs on unknown schema or mutates its journal mode", (t) => {
	const f = fixture(t); const store = f.store();
	fs.mkdirSync(dirname(store.path), { recursive: true });
	const db = database(store.path);
	try { db.exec("CREATE TABLE foreign_records(fixture TEXT); PRAGMA user_version=1"); }
	finally { db.close(); }
	const before = fs.readFileSync(store.path);
	interceptWal(t, () => assert.fail("unknown schema must be rejected before WAL initialization"));
	t.mock.method(Atomics, "wait", () => assert.fail("unknown schema must not trigger WAL retry"));
	assert.throws(() => store.list({ project: f.a }), /database schema/);
	assert.throws(() => store.save(f.input()), /database schema/);
	assert.deepEqual(fs.readFileSync(store.path), before);
	assert.equal(rows(store.path, "PRAGMA journal_mode")[0].journal_mode, "delete");
});

test("WAL retry does not replay failed record writes", (t) => {
	const f = fixture(t); const store = f.store();
	const error = sqliteError(5);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const prepare = DatabaseSync.prototype.prepare;
	let writes = 0;
	t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
		const statement = prepare.call(this, sql);
		if (sql.startsWith("INSERT INTO records(")) t.mock.method(statement, "run", () => { writes++; throw error; });
		return statement;
	});
	assert.throws(() => store.save(f.input()), (value: unknown) => value === error);
	assert.equal(writes, 1);
	t.mock.restoreAll();
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records")[0].count, 0);
	assert.equal(store.save(f.input()).outcome, "saved");
});

test("WAL retry does not replay uncertain record commits", (t) => {
	const f = fixture(t); const store = f.store();
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const exec = DatabaseSync.prototype.exec;
	let commits = 0;
	t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
		exec.call(this, sql);
		// Validation commits first. The record commits next, but the caller gets
		// a BUSY error rather than reliable acknowledgement of that record write.
		if (sql === "COMMIT" && ++commits === 2) throw sqliteError(5);
	});
	assert.throws(() => store.save(f.input()));
	assert.equal(commits, 2, "only schema validation and the original write may commit");
	t.mock.restoreAll();
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records")[0].count, 1);
	assert.equal(store.save(f.input()).outcome, "duplicate", "later explicit calls see the committed record");
});

test("two simultaneous writer processes and a reader safely initialize, deduplicate and transact", { timeout: 30_000 }, async (t) => {
	const f = fixture(t);
	const script = `
		const {MemoryStore}=await import(${JSON.stringify(storeUrl)});
		const [agent,project,worker]=process.argv.slice(1);
		const s=new MemoryStore(agent);
		const input=(kind,title,event)=>({kind,category:'project',scope:'project',project,title,text:'local fixture '+worker,
			source:{lane:'main',sessionId:'fixture-concurrent',eventId:event}});
		process.stdout.write('ready\\n');
		await new Promise(resolve=>process.stdin.once('data',resolve));
		try {
			if(worker==='reader') {
				for(let i=0;i<150;i++) { const result=s.list({project,query:'fixture',limit:50});
					if(result.some(r=>r.project!==project||!r.id.match(/^[a-f0-9]{64}$/))) throw new Error('bad reader snapshot'); }
			} else {
				for(let i=0;i<60;i++) {
					s.save(input('conversation','Capture '+i,'shared-'+i));
					s.save(input('note','Writer '+worker+' note '+i,'note-'+worker+'-'+i));
					s.save(input('note','Shared fact','shared-note'));
				}
				const forgotten=input('note','Forgotten fact','forgotten');
				const result=s.save(forgotten); if(result.record) s.forget(result.record.id,project);
			}
		} finally {s.close(); process.stdin.destroy();}
		process.stdout.write('done\\n');
	`;
	const children = ["one", "two", "reader"].map(worker => spawn(process.execPath,
		["--import", "tsx", "--input-type=module", "-e", script, f.agent, f.a, worker], { stdio: ["pipe", "pipe", "pipe"] }));
	t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
	const states = children.map(child => {
		let stdout = "", stderr = "";
		let readyResolve!: () => void;
		const ready = new Promise<void>(resolve => { readyResolve = resolve; });
		child.stdout.on("data", data => { stdout += data; if (stdout.includes("ready\n")) readyResolve(); });
		child.stderr.on("data", data => { stderr += data; });
		const done = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", code => { readyResolve(); code === 0 ? resolve() : reject(new Error(`worker exit ${code}: ${stderr}`)); });
		});
		return { ready, done, output: () => stdout };
	});
	await Promise.all(states.map(state => state.ready));
	for (const child of children) child.stdin.end("start\n");
	await Promise.all(states.map(state => state.done));
	for (const state of states) assert.match(state.output(), /done/);
	const store = f.store();
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records WHERE kind='conversation'")[0].count, 60);
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records WHERE kind='note'")[0].count, 121);
	assert.equal(store.save(f.input({ title: "Forgotten fact", category: "project", text: "no resurrection", source: { lane: "main", sessionId: "fixture-concurrent", eventId: "forgotten" } })).outcome, "forgotten");
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, 1);
	const db = database(store.path);
	try { assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal"); assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok"); }
	finally { db.close(); }
});

test("human bulk forgetting selects only requested scope, persists and prevents automatic resurrection", (t) => {
	const f = fixture(t); const store = f.store();
	const inputs = [f.a, f.b].flatMap(project => (["note", "conversation"] as const).map(kind => f.input({ project, kind })));
	inputs.push(...(["note", "conversation"] as const).map(kind => f.input({ scope: "global", kind,
		source: { lane: "manual", sessionId: "global", eventId: kind } })));
	for (const input of inputs) store.save(input);
	assert.equal(store.forgetAll(f.a), 2);
	store.close();
	assert.equal(store.list({ project: f.a, scope: "current" }).length, 2, "project bulk forget must retain global rows");
	assert.equal(store.list({ project: f.a, scope: "all" }).length, 4);
	for (const input of inputs.filter(input => input.project === f.a && input.scope === "project")) assert.equal(store.save(input).outcome, "forgotten");
	assert.equal(store.forgetAll(f.a), 0);
	assert.equal(store.forgetAll(f.b, "global"), 2);
	store.close();
	assert.equal(store.list({ project: f.a, scope: "global" }).length, 0);
	assert.equal(store.list({ project: f.a, scope: "all" }).length, 2);
	assert.equal(store.forgetAll(f.a, "all"), 2);
	store.close();
	assert.deepEqual(store.list({ project: f.a, scope: "all" }), []);
	for (const input of inputs) assert.equal(store.save(input).outcome, "forgotten");
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, 6);
	assert.equal(store.save(inputs[0], { explicit: true }).outcome, "saved");
	assert.equal(store.forgetAll(f.a, "all"), 1);
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, 6);
	withFault("lstatSync", () => {
		assert.throws(() => store.forgetAll("relative"), /project/);
		assert.throws(() => store.forgetAll(f.a, "current" as never), /scope/);
	});
	const fresh = f.store(join(f.root, "fresh-bulk-agent"));
	assert.equal(fresh.forgetAll(f.a, "all"), 0);
	assert.equal(fs.existsSync(dirname(fresh.path)), false);
});

test("trusted agent root/ancestor symlinks are canonicalized lazily, but active root replacement rejects", (t) => {
	const f = fixture(t);
	const target = join(f.root, "trusted-target"); fs.mkdirSync(target);
	const alias = join(f.root, "trusted-alias"); fs.symlinkSync(target, alias, "dir");
	const agent = join(alias, "agent");
	const store = f.store(agent);
	assert.equal(fs.existsSync(join(target, "agent")), false);
	assert.deepEqual(store.list({ project: f.a }), []);
	const record = store.save(f.input()).record!;
	assert.ok(fs.existsSync(join(target, "agent", "extensions", "pi-jarvis-memory", "memory.sqlite")));
	assert.equal(store.path, join(agent, "extensions", "pi-jarvis-memory", "memory.sqlite"));
	store.close();
	assert.deepEqual(store.get(record.id, f.a), record);
	const directAlias = join(f.root, "direct-agent-alias");
	fs.symlinkSync(join(target, "agent"), directAlias, "dir");
	const direct = f.store(directAlias);
	assert.deepEqual(direct.get(record.id, f.a), record, "direct agentDir symlinks also work");
	direct.close();
	const replacement = join(f.root, "replacement-root"); fs.mkdirSync(replacement);
	fs.unlinkSync(alias); fs.symlinkSync(replacement, alias, "dir");
	assert.throws(() => store.get(record.id, f.a), /replaced agent root/);
	assert.equal(fs.existsSync(join(replacement, "agent")), false);
});

test("snapshot-confirmed forget rejects cross-process edits atomically and accepts unchanged reviewed rows", (t) => {
	const f = fixture(t); const store = f.store();
	const reviewed = store.save(f.input()).record!;
	const script = `const {MemoryStore}=await import(${JSON.stringify(storeUrl)}); const [agent,project,id]=process.argv.slice(1);
		const s=new MemoryStore(agent); try { s.update(id,project,'new fixture version after confirmation'); } finally {s.close();}`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.agent, f.a, reviewed.id], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	assert.throws(() => store.forget(reviewed.id, f.a, false, reviewed), /^Error: Memory changed during confirmation$/);
	const latest = store.get(reviewed.id, f.a)!;
	assert.equal(latest.text, "new fixture version after confirmation");
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, 0);
	assert.equal(store.forget(reviewed.id, f.a, false, latest), true);
	assert.throws(() => store.forget(reviewed.id, f.a, false, latest), /changed during confirmation/);
	assert.equal(store.save(f.input()).outcome, "forgotten");
	assert.throws(() => store.forget(reviewed.id, f.a, false, { ...latest, id: "a".repeat(64) }), /expected record/);
});

test("FTS updates and deletes stay transactionally consistent with record bodies across reopen", (t) => {
	const f = fixture(t); const store = f.store();
	const old = store.save(f.input({ text: "obsoletekeyword", title: "Original heading" })).record!;
	assert.equal(store.list({ project: f.a, query: "obsoletekeyword" })[0].id, old.id);
	const revised = store.save(f.input({ text: "replacementkeyword", title: "Original heading",
		source: { lane: "jarvis", sessionId: "correcting-session", eventId: "correcting-event" }, category: "feedback" })).record!;
	assert.deepEqual(store.list({ project: f.a, query: "obsoletekeyword" }), []);
	assert.equal(store.list({ project: f.a, query: "replacementkeyword" })[0].id, revised.id);
	assert.equal(revised.source.lane, "jarvis");
	assert.equal(revised.category, "feedback");
	assert.equal(revised.createdAt, old.createdAt);
	store.close();
	assert.equal(store.list({ project: f.a, query: "replacementkeyword" })[0].id, revised.id);
	assert.equal(store.forget(revised.id, f.a), true);
	store.close();
	assert.deepEqual(store.list({ project: f.a, query: "replacementkeyword" }), []);
});

test("indexed recall stays bounded at 10,000 full-size capture fixtures", { timeout: 90_000 }, (t) => {
	const f = fixture(t); const store = f.store();
	store.save(f.input({ title: "Curated fixture", text: "recallneedle" })); store.close();
	const body = "fixture background neutral ".repeat(700).slice(0, 16_384);
	assert.equal(Buffer.byteLength(body), 16_384);
	seed(store.path, Array.from({ length: MEMORY_STORE_LIMITS.conversations }, (_, i) => f.input({
		kind: "conversation", title: `Large capture ${i}`, text: i % 1000 === 0 ? `recallneedle ${body.slice(13)}` : body,
		source: { lane: "main", sessionId: "full-archive-fixture", eventId: `full-${i}` },
	})));
	const initial = performance.now();
	assert.equal(store.list({ project: f.a, query: "recallneedle", limit: 8 }).length, 8);
	const openMs = performance.now() - initial;
	const samples: number[] = [];
	for (let i = 0; i < 20; i++) {
		const started = performance.now();
		assert.equal(store.list({ project: f.a, query: i % 2 ? "neutral" : "recallneedle", limit: 8 }).length, 8);
		samples.push(performance.now() - started);
	}
	const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
	t.diagnostic(`full archive: first open/integrity ${openMs.toFixed(1)}ms; indexed rare/common query avg ${average.toFixed(1)}ms, max ${Math.max(...samples).toFixed(1)}ms; main file ${(fs.statSync(store.path).size / 1024 / 1024).toFixed(1)}MiB`);
	// The contract is structural, not a hardware-specific timing promise. A wide
	// guard catches accidental reintroduction of repeated JS 160MiB body scans.
	assert.ok(average < 500, `unexpected full-archive recall regression: ${average}ms`);
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records WHERE kind='conversation'")[0].count, 10_000);
});
