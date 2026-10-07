import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { MemoryStore, MEMORY_STORE_LIMITS } from "../memory-store.js";
import type { MemoryInput, MemoryRecord } from "../memory-types.js";
import type { MemoryNoteDraft } from "../memory-editor-types.js";

const require = createRequire(import.meta.url);
const sqlite = () => (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const id = (input: MemoryInput) => createHash("sha256").update(JSON.stringify(["note", input.scope,
	input.scope === "project" ? input.project : "", normalized(input.title)])).digest("hex");
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-editor-store-"));
	const agent = join(root, "agent"), a = join(root, "workspace-a"), b = join(root, "workspace-b");
	for (const path of [agent, a, b]) mkdirSync(path);
	const stores: MemoryStore[] = [];
	const store = () => { const value = new MemoryStore(agent); stores.push(value); return value; };
	t.after(() => { for (const value of stores) value.close(); rmSync(root, { recursive: true, force: true }); });
	const input = (patch: Partial<MemoryInput> = {}): MemoryInput => ({ kind: "note", category: "project", scope: "project", project: a,
		title: "Synthetic fact", text: "Synthetic factual body", source: { lane: "manual", sessionId: "synthetic-session", eventId: "synthetic-event" }, ...patch });
	return { root, agent, a, b, store, input };
}
const draft = (record: MemoryRecord, patch: Partial<MemoryNoteDraft> = {}): MemoryNoteDraft => ({ title: record.title, text: record.text,
	category: record.category, scope: record.scope, ...patch });
function inspect(path: string, sql: string) {
	const db = new (sqlite())(path);
	try { return db.prepare(sql).all(); } finally { db.close(); }
}
function seed(path: string, inputs: MemoryInput[], tombstones = 0) {
	const db = new (sqlite())(path);
	try {
		db.exec("BEGIN IMMEDIATE");
		const insert = db.prepare(`INSERT INTO records(id,kind,category,scope,project,title,text,search_title,search_text,lane,session_id,event_id,role,created_at,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`), fts = db.prepare("INSERT INTO records_fts(rowid,search_title,search_text) VALUES(?,?,?)");
		for (const input of inputs) {
			const row = insert.run(id(input), input.kind, input.category, input.scope, input.project, input.title, input.text,
				normalized(input.title), normalized(input.text), input.source.lane, input.source.sessionId, input.source.eventId,
				input.source.role ?? null, 100, 100);
			fts.run(row.lastInsertRowid, normalized(input.title), normalized(input.text));
		}
		const tombstone = db.prepare("INSERT INTO tombstones VALUES(?,100)");
		for (let i = 0; i < tombstones; i++) tombstone.run(i.toString(16).padStart(64, "0"));
		db.exec("COMMIT");
	} finally { db.close(); }
}

test("editor reads are lazy, notes-only and scoped; summaries omit bodies and private source IDs", t => {
	const f = fixture(t), store = f.store();
	assert.deepEqual(store.editorList({ scope: "current" }, f.a), { records: [], total: 0, offset: 0, nextOffset: null });
	assert.equal(store.editorGet("a".repeat(64), f.a, "all"), undefined);
	assert.equal(existsSync(store.path), false);
	const a = store.editorCreate(f.input({ text: "  文本\n\t👩‍💻  " }));
	const b = store.editorCreate(f.input({ title: "Other", project: f.b, category: "feedback", source: { lane: "jarvis", sessionId: "s-b", eventId: "e-b" } }));
	const global = store.editorCreate(f.input({ title: "Global", scope: "global", source: { lane: "main", sessionId: "s-g", eventId: "e-g" } }));
	const conversation = store.save(f.input({ kind: "conversation", title: "Capture", text: "unrelated captured conversation" })).record!;
	const titles = (scope: "current" | "project" | "global" | "all") => store.editorList({ scope }, f.a).records.map(r => r.title).sort();
	assert.deepEqual(titles("current"), ["Global", "Synthetic fact"]);
	assert.deepEqual(titles("project"), ["Synthetic fact"]);
	assert.deepEqual(titles("global"), ["Global"]);
	assert.deepEqual(titles("all"), ["Global", "Other", "Synthetic fact"]);
	assert.equal(store.editorGet(b.id, f.a, "current"), undefined);
	assert.equal(store.editorGet(global.id, f.a, "project"), undefined);
	assert.equal(store.editorGet(a.id, f.a, "global"), undefined);
	assert.deepEqual(store.editorGet(b.id, f.a, "all"), b);
	assert.equal(store.editorGet(conversation.id, f.a, "all"), undefined);
	const summary = store.editorList({ scope: "project" }, f.a).records[0];
	assert.deepEqual(Object.keys(summary).sort(), ["id", "title", "category", "scope", "project", "lane", "createdAt", "updatedAt", "textBytes"].sort());
	assert.equal(summary.textBytes, Buffer.byteLength(a.text));
	assert.equal(summary.lane, "manual");
	assert.deepEqual(store.editorGet(a.id, f.a, "project"), a);
});

test("metadata paging has stable ID ties, total, scope/category/lane filters and literal FTS", t => {
	const f = fixture(t), store = f.store();
	store.editorCreate(f.input({ title: "Seed" })); store.close();
	seed(store.path, Array.from({ length: 115 }, (_, i) => f.input({ title: `Fixture ${String(i).padStart(3, "0")}`,
		text: "literalkeyword café ＷＩＤＥ", category: i % 2 ? "reference" : "user",
		source: { lane: i % 3 ? "main" : "jarvis", sessionId: "s", eventId: `e-${i}` } })));
	const first = store.editorList({ scope: "current", query: "literalkeyword", limit: 50, sort: "created" }, f.a);
	assert.equal(first.records.length, 50); assert.equal(first.total, 115); assert.equal(first.nextOffset, 50);
	const second = store.editorList({ scope: "current", query: "literalkeyword", offset: first.nextOffset!, limit: 50, sort: "created" }, f.a);
	const third = store.editorList({ scope: "current", query: "literalkeyword", offset: second.nextOffset!, limit: 50, sort: "created" }, f.a);
	assert.equal(third.records.length, 15); assert.equal(third.nextOffset, null);
	const ids = [...first.records, ...second.records, ...third.records].map(r => r.id);
	assert.equal(new Set(ids).size, 115); assert.deepEqual(ids, [...ids].sort());
	assert.equal(store.editorList({ scope: "current", query: "literalkeyword", offset: 200 }, f.a).records.length, 0);
	assert.equal(store.editorList({ scope: "all", category: "reference", lane: "jarvis" }, f.a).total, 19);
	assert.equal(store.editorList({ scope: "project", query: "cafe" }, f.a).total, 115);
	assert.equal(store.editorList({ scope: "all", query: "wide", limit: 900 }, f.a).records.length, 50);
	assert.equal(store.editorList({ scope: "current", query: "literalkeyword absent" }, f.a).total, 115);
	assert.equal(store.editorList({ scope: "current", query: "*" }, f.a).total, 0);
	for (const query of ["\" OR * NOT \"", "%_", ":", "NEAR(foo,bar)"]) assert.doesNotThrow(() => store.editorList({ scope: "all", query }, f.a));
	const sorted = store.editorList({ scope: "all", sort: "title" }, f.a);
	assert.equal(sorted.records[0].title, "Fixture 000");
	store.close(); assert.deepEqual(store.editorList({ scope: "all", query: "literalkeyword", sort: "created" }, f.a).records, first.records);
});

test("list SQL selects bounded metadata only, never SELECT * or full note bodies", t => {
	const f = fixture(t), store = f.store();
	for (let i = 0; i < 60; i++) store.editorCreate(f.input({ title: `Large ${i}`, text: "x".repeat(16384) }));
	const Database = sqlite(), original = Database.prototype.prepare, sqls: string[] = [];
	t.mock.method(Database.prototype, "prepare", function(this: DatabaseSync, sql: string) { sqls.push(sql); return original.call(this, sql); });
	assert.equal(store.editorList({ scope: "all", query: "Large", limit: 50 }, f.a).records.length, 50);
	const selects = sqls.filter(sql => /SELECT/i.test(sql) && /records/i.test(sql));
	assert.equal(selects.length, 2);
	assert.ok(selects.every(sql => !/SELECT\s+(?:\*|r\.\*)/i.test(sql)));
	assert.ok(selects.some(sql => /length\(CAST\(r\.text AS BLOB\)\)/.test(sql) && /LIMIT \? OFFSET \?/.test(sql)));
});

test("create-only rejects normalized collisions/tombstones without changing original or explicit restore behavior", t => {
	const f = fixture(t), store = f.store();
	const original = store.editorCreate(f.input({ title: " ＦＡＣＴ   One " }));
	assert.throws(() => store.editorCreate(f.input({ title: "fact one", text: "not an upsert" })), /already exists/);
	assert.deepEqual(store.editorGet(original.id, f.a, "current"), original);
	assert.equal(store.editorForget([original], f.a, "current"), 1);
	assert.throws(() => store.editorCreate(f.input({ title: "fact one" })), /forgotten.*explicit/);
	assert.deepEqual(store.save(f.input({ title: "fact one" })), { outcome: "forgotten" });
	const restored = store.save(f.input({ title: "fact one" }), { explicit: true });
	assert.equal(restored.outcome, "saved"); assert.equal(restored.record!.id, original.id);
});

test("all title/body/category/scope edits rekey atomically with FTS/tombstone/origin preservation", t => {
	const f = fixture(t), store = f.store();
	const original = store.editorCreate(f.input({ title: "Old heading", text: "obsoletekeyword", category: "feedback",
		source: { lane: "jarvis", sessionId: "origin-session", eventId: "origin-event", role: "assistant" } }));
	const next = store.editorUpdate(original, draft(original, { title: "New heading", text: "  replacementkeyword\r\n\tprecise  ", category: "reference", scope: "global" }), f.a, "current");
	assert.notEqual(next.id, original.id); assert.equal(next.id, id(f.input({ title: next.title, scope: "global" })));
	assert.equal(next.text, "  replacementkeyword\n\tprecise  "); assert.equal(next.category, "reference");
	assert.equal(next.createdAt, original.createdAt); assert.ok(next.updatedAt > original.updatedAt);
	assert.deepEqual(next.source, original.source); assert.equal(next.project, original.project);
	assert.equal(store.editorGet(original.id, f.a, "all"), undefined);
	assert.equal(store.save(f.input({ title: original.title })).outcome, "forgotten");
	assert.equal(store.editorList({ scope: "all", query: "obsoletekeyword" }, f.a).total, 0);
	assert.equal(store.editorList({ scope: "global", query: "replacementkeyword" }, f.b).records[0].id, next.id);
	const moved = store.editorUpdate(next, draft(next, { scope: "project" }), f.b, "global");
	assert.equal(moved.project, f.b); assert.equal(moved.createdAt, original.createdAt); assert.deepEqual(moved.source, original.source);
	assert.equal(store.editorGet(moved.id, f.a, "current"), undefined);
	store.close(); assert.deepEqual(store.editorGet(moved.id, f.b, "project"), moved);
	assert.equal(store.editorForget([moved], f.b, "project"), 1);
	store.close(); assert.equal(store.editorList({ scope: "all", query: "replacementkeyword" }, f.a).total, 0);
});

test("all-project edits retain the original project; global origin retained unless moved to current project", t => {
	const f = fixture(t), store = f.store();
	const foreign = store.editorCreate(f.input({ project: f.b }));
	assert.throws(() => store.editorUpdate(foreign, draft(foreign, { text: "unauthorized" }), f.a, "current"), /changed|accessible/);
	const edited = store.editorUpdate(foreign, draft(foreign, { category: "user" }), f.a, "all");
	assert.equal(edited.project, f.b); assert.equal(edited.id, foreign.id);
	const global = store.editorUpdate(edited, draft(edited, { scope: "global" }), f.a, "all");
	assert.equal(global.project, f.b);
	const revised = store.editorUpdate(global, draft(global, { text: "global revision" }), f.a, "global");
	assert.equal(revised.project, f.b); assert.deepEqual(revised.source, foreign.source);
});

test("rename/scope destination collision and forgotten target reject with no partial row/index/tombstone changes", t => {
	const f = fixture(t), store = f.store();
	const source = store.editorCreate(f.input({ title: "Source", text: "sourcekeyword" }));
	const occupied = store.editorCreate(f.input({ title: "Destination", scope: "global", text: "destinationkeyword" }));
	assert.throws(() => store.editorUpdate(source, draft(source, { title: occupied.title, scope: "global", text: "wrong" }), f.a, "current"), /already exists/);
	assert.deepEqual(store.editorGet(source.id, f.a, "current"), source);
	assert.equal(inspect(store.path, "SELECT count(*) AS n FROM tombstones")[0].n, 0);
	assert.equal(store.editorForget([occupied], f.a, "global"), 1);
	assert.throws(() => store.editorUpdate(source, draft(source, { title: occupied.title, scope: "global" }), f.a, "current"), /forgotten/);
	assert.equal(store.editorList({ scope: "all", query: "sourcekeyword" }, f.a).records[0].id, source.id);
	assert.equal(inspect(store.path, "SELECT count(*) AS n FROM tombstones")[0].n, 1);
});

test("complete expected fields are compared, independent of property order, and detached snapshots are pinned", t => {
	const f = fixture(t), store = f.store();
	const record = store.editorCreate(f.input());
	for (const changed of [ { ...record, text: "other" }, { ...record, category: "user" as const },
		{ ...record, source: { ...record.source, lane: "main" as const } }, { ...record, source: { ...record.source, eventId: "other" } },
		{ ...record, source: { ...record.source, sessionId: "other" } }, { ...record, source: { ...record.source, role: "user" as const } },
		{ ...record, createdAt: record.createdAt - 1 }, { ...record, updatedAt: record.updatedAt + 1 } ]) {
		assert.throws(() => store.editorUpdate(changed, draft(record), f.a, "current"), /changed/);
		assert.throws(() => store.editorForget([changed], f.a, "current"), /changed/);
	}
	const reordered = Object.fromEntries(Object.entries(record).reverse()) as unknown as MemoryRecord;
	const updated = store.editorUpdate(reordered, draft(record, { text: "correction" }), f.a, "current");
	const pinned = structuredClone(updated);
	assert.throws(() => store.editorUpdate(pinned, draft(updated, { text: "new correction" }), f.a, "current", () => { pinned.text = "not reviewed"; throw new Error("cancel"); }), /cancel/);
	assert.deepEqual(store.editorGet(updated.id, f.a, "current"), updated);
});

test("atomic reviewed batch deletion rejects stale/missing/duplicate/foreign/conversation IDs before deleting any", t => {
	const f = fixture(t), store = f.store();
	const a = store.editorCreate(f.input({ title: "A" })), b = store.editorCreate(f.input({ title: "B" }));
	const foreign = store.editorCreate(f.input({ title: "Foreign", project: f.b }));
	const conversation = store.save(f.input({ kind: "conversation" })).record!;
	assert.throws(() => store.editorForget([], f.a, "current"), /1 and 50/);
	assert.throws(() => store.editorForget(Array(51).fill(a), f.a, "current"), /1 and 50/);
	assert.throws(() => store.editorForget([a, a], f.a, "current"), /once/);
	assert.throws(() => store.editorForget([a, foreign], f.a, "current"), /changed|accessible/);
	assert.throws(() => store.editorForget([a, conversation], f.a, "all"), /curated note/);
	const latest = store.editorUpdate(b, draft(b, { text: "other writer" }), f.a, "current");
	assert.throws(() => store.editorForget([a, b], f.a, "current"), /Nothing was deleted/);
	assert.deepEqual(store.editorGet(a.id, f.a, "current"), a);
	assert.equal(store.editorForget([latest], f.a, "current"), 1);
	assert.throws(() => store.editorForget([a, latest], f.a, "current"), /Nothing was deleted/);
	assert.deepEqual(store.editorGet(a.id, f.a, "current"), a);
	assert.equal(store.editorForget([a, foreign], f.a, "all"), 2);
	assert.deepEqual(store.get(conversation.id, f.a), conversation);
});

test("exact 50-note deletion maintains FTS/tombstones across reopen", t => {
	const f = fixture(t), store = f.store();
	const notes = Array.from({ length: 50 }, (_, i) => store.editorCreate(f.input({ title: `Batch ${i}`, text: "batchneedle" })));
	assert.equal(store.editorForget(notes, f.a, "current"), 50);
	store.close(); assert.equal(store.editorList({ scope: "all", query: "batchneedle" }, f.a).total, 0);
	assert.equal(inspect(store.path, "SELECT count(*) AS n FROM tombstones")[0].n, 50);
	for (const note of notes) assert.throws(() => store.editorCreate(f.input({ title: note.title })), /forgotten/);
});

test("precommit cancellation rolls back create/rekey/batch deletion and leaves FTS unchanged", t => {
	const f = fixture(t), store = f.store();
	const a = store.editorCreate(f.input({ title: "Before", text: "beforekeyword" }));
	let connection: DatabaseSync | undefined, active = false;
	const Database = sqlite(), exec = Database.prototype.exec;
	t.mock.method(Database.prototype, "exec", function(this: DatabaseSync, sql: string) {
		const result = exec.call(this, sql);
		if (sql === "BEGIN IMMEDIATE") { connection = this; active = true; }
		if (sql === "COMMIT" || sql === "ROLLBACK") active = false;
		return result;
	});
	const cancelWhen = (condition: () => boolean) => () => { if (active && condition()) throw new Error("synthetic cancellation before COMMIT"); };
	assert.throws(() => store.editorCreate(f.input({ title: "Cancelled new" }), cancelWhen(() => !!connection!.prepare("SELECT 1 FROM records WHERE title='Cancelled new'").get())), /cancellation/);
	assert.throws(() => store.editorUpdate(a, draft(a, { title: "Cancelled rename", text: "afterkeyword" }), f.a, "current",
		cancelWhen(() => !!connection!.prepare("SELECT 1 FROM records WHERE title='Cancelled rename'").get())), /cancellation/);
	assert.throws(() => store.editorForget([a], f.a, "current", cancelWhen(() => !connection!.prepare("SELECT 1 FROM records WHERE id=?").get(a.id))), /cancellation/);
	assert.deepEqual(store.editorGet(a.id, f.a, "current"), a);
	assert.equal(store.editorList({ scope: "all", query: "beforekeyword" }, f.a).total, 1);
	assert.equal(store.editorList({ scope: "all", query: "afterkeyword" }, f.a).total, 0);
	assert.equal(inspect(store.path, "SELECT count(*) AS n FROM tombstones")[0].n, 0);
});

test("guard runs after a real waiting BEGIN; late cancellation prevents write work", { timeout: 10000 }, async t => {
	const f = fixture(t), store = f.store(), note = store.editorCreate(f.input());
	const cancelled = join(f.root, "synthetic-cancelled");
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import {DatabaseSync} from 'node:sqlite'; import {writeFileSync} from 'node:fs';
		const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n');
		setTimeout(()=>{writeFileSync(process.argv[2],'cancel'); db.exec('COMMIT'); db.close();},200);
	`, store.path, cancelled], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = ""; child.stderr.on("data", data => { stderr += data; });
	const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	t.after(() => { if (child.exitCode === null) child.kill(); });
	await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("close", code => { if (code !== 0) reject(new Error(stderr)); }); });
	assert.throws(() => store.editorUpdate(note, draft(note, { text: "must not commit" }), f.a, "current", () => {
		if (existsSync(cancelled)) throw new Error("synthetic cancellation after lock wait");
	}), /after lock wait/);
	assert.equal(await exited, 0, stderr);
	assert.deepEqual(store.editorGet(note.id, f.a, "current"), note);
});

test("cross-process corrected notes conflict atomically without implicit retry", t => {
	const f = fixture(t), store = f.store();
	const a = store.editorCreate(f.input({ title: "Reviewed A" })), b = store.editorCreate(f.input({ title: "Reviewed B" }));
	const url = new URL("../memory-store.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		const {MemoryStore}=await import(${JSON.stringify(url)}); const s=new MemoryStore(process.argv[1]);
		try { s.update(process.argv[3],process.argv[2],'external synthetic correction'); } finally {s.close();}
	`, f.agent, f.a, b.id], { encoding: "utf8", timeout: 10000 });
	assert.equal(child.status, 0, child.stderr);
	assert.throws(() => store.editorUpdate(b, draft(b, { text: "stale overwrite" }), f.a, "current"), /changed/);
	assert.throws(() => store.editorForget([a, b], f.a, "current"), /Nothing was deleted/);
	assert.deepEqual(store.editorGet(a.id, f.a, "current"), a);
	assert.equal(store.editorGet(b.id, f.a, "current")!.text, "external synthetic correction");
});

test("all editor fields/Unicode/UTF8/control/secrets/query limits validate without record writes", t => {
	const f = fixture(t), store = f.store();
	for (const patch of [ { kind: "conversation" }, { title: "a".repeat(161) }, { title: "😀".repeat(161) }, { title: "line\nnext" },
		{ title: "line\tcolumn" }, { title: "\u2028" }, { title: "\u001b[31mUnsafe" }, { title: "\ud800" },
		{ text: "😀".repeat(4097) }, { text: "\udfff" }, { text: "" }, { text: "hello\u0001world" },
		{ text: "token=synthetic-private-value" }, { title: "password=synthetic-private-value" }, { category: "invalid" }, { scope: "all" } ]) {
		assert.throws(() => store.editorCreate(f.input(patch as Partial<MemoryInput>)), /curated|Curated/);
	}
	assert.equal(existsSync(store.path), false);
	for (const query of [ { scope: "bad" }, { scope: "all", lane: "bad" }, { scope: "all", category: "bad" }, { scope: "all", sort: "bad" },
		{ scope: "all", offset: -1 }, { scope: "all", limit: NaN }, { scope: "all", query: "x".repeat(513) },
		{ scope: "all", query: Array.from({ length: 129 }, (_, i) => `q${i}`).join(" ") } ]) assert.throws(() => store.editorList(query as never, f.a));
	assert.equal(existsSync(store.path), false);
	const max = store.editorCreate(f.input({ title: "😀".repeat(160), text: "😀".repeat(4096) }));
	assert.equal([...max.title].length, 160); assert.equal(Buffer.byteLength(max.text), 16384);
	assert.deepEqual(store.editorGet(max.id, f.a, "current"), max);
});

test("1000-note capacity allows edits/rekeys but never silent eviction", { timeout: 15000 }, t => {
	const f = fixture(t), store = f.store(), first = store.editorCreate(f.input()); store.close();
	seed(store.path, Array.from({ length: MEMORY_STORE_LIMITS.notes - 1 }, (_, i) => f.input({ title: `Capacity ${i}` })));
	assert.throws(() => store.editorCreate(f.input({ title: "Over capacity" })), /note limit/);
	const updated = store.editorUpdate(first, draft(first, { title: "Capacity rename" }), f.a, "current");
	assert.equal(store.editorList({ scope: "all" }, f.a).total, 1000);
	assert.equal(updated.createdAt, first.createdAt);
});

test("100000-identity capacity rejects rekeys/create but allows same-ID edit and reserved deletion", { timeout: 15000 }, t => {
	const f = fixture(t), store = f.store(), original = store.editorCreate(f.input()); store.close();
	seed(store.path, [], MEMORY_STORE_LIMITS.identities - 1);
	assert.throws(() => store.editorCreate(f.input({ title: "New identity" })), /identity budget/);
	assert.throws(() => store.editorUpdate(original, draft(original, { title: "New identity" }), f.a, "current"), /identity budget/);
	assert.deepEqual(store.editorGet(original.id, f.a, "current"), original);
	const edited = store.editorUpdate(original, draft(original, { text: "same identity correction" }), f.a, "current");
	assert.equal(store.editorForget([edited], f.a, "current"), 1);
	assert.equal(inspect(store.path, "SELECT count(*) AS n FROM tombstones")[0].n, 100000);
});

test("uncertain COMMIT is never replayed; later explicit refresh can observe committed mutation", t => {
	const f = fixture(t), store = f.store(); store.editorCreate(f.input({ title: "Original" }));
	const Database = sqlite(), exec = Database.prototype.exec;
	let commits = 0;
	t.mock.method(Database.prototype, "exec", function(this: DatabaseSync, sql: string) {
		exec.call(this, sql);
		if (sql === "COMMIT") { commits++; throw new Error("synthetic uncertain COMMIT"); }
	});
	assert.throws(() => store.editorCreate(f.input({ title: "Committed uncertain" })), /uncertain COMMIT/);
	assert.equal(commits, 1);
	t.mock.restoreAll();
	assert.equal(store.editorList({ scope: "all" }, f.a).total, 2);
	assert.throws(() => store.editorCreate(f.input({ title: "Committed uncertain" })), /already exists/);
});
