import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ArchiveStore, ARCHIVE_STORE_LIMITS } from "../archive-store.js";
import type { ArchiveInput } from "../archive-types.js";

const require = createRequire(import.meta.url);
const storeUrl = new URL("../archive-store.ts", import.meta.url).href;
function database(path: string): DatabaseSync {
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	return new DatabaseSync(path);
}
function rows(path: string, sql: string): Record<string, unknown>[] {
	const db = database(path);
	try { return db.prepare(sql).all(); } finally { db.close(); }
}
function opaqueId(input: ArchiveInput): string {
	return createHash("sha256").update(JSON.stringify([input.project, input.sessionId, input.entry.id])).digest("hex");
}
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-jarvis-archive-test-"));
	const agent = join(root, "agent"), a = join(root, "project-a"), b = join(root, "project-b");
	const stores: ArchiveStore[] = [];
	const store = (dir = agent) => { const value = new ArchiveStore(dir); stores.push(value); return value; };
	t.after(() => { for (const value of stores) value.close(); fs.rmSync(root, { recursive: true, force: true }); });
	const input = (entry: Partial<ArchiveInput["entry"]> = {}, patch: Partial<Omit<ArchiveInput, "entry">> = {}): ArchiveInput => ({
		project: a, sessionId: "fixture-session", lane: "main", ...patch,
		entry: { id: "fixture-entry", type: "message", parentId: null, timestamp: "2026-01-02T03:04:05.000Z",
			message: { role: "user", content: "local fixture reference" }, ...entry },
	});
	return { root, agent, a, b, store, input };
}
function withFault<K extends "lstatSync" | "openSync" | "opendirSync" | "fchmodSync">(key: K, run: () => void): void {
	const original = fs[key];
	fs[key] = (() => { throw Object.assign(new Error("fixture I/O failure"), { code: "EACCES" }); }) as typeof fs[K];
	syncBuiltinESMExports();
	try { run(); } finally { fs[key] = original; syncBuiltinESMExports(); }
}
function readAll(store: ArchiveStore, id: string, project: string, size = 43): string {
	let start = 0, content = "";
	for (;;) {
		const page = store.read(id, project, false, start, size)!;
		assert.equal(page.offset, start);
		assert.equal(page.units, "unicode-codepoints");
		assert.ok([...page.content].length <= size);
		content += page.content;
		if (page.nextOffset === null) { assert.equal([...content].length, page.totalCharacters); return content; }
		assert.ok(page.nextOffset > start);
		start = page.nextOffset;
	}
}

test("constructor/close are entirely lazy and absent reads/deletion never load or create SQLite", (t) => {
	const f = fixture(t);
	for (const key of ["lstatSync", "openSync", "opendirSync"] as const) withFault(key, () => {
		const store = f.store();
		assert.equal(store.path, join(f.agent, "extensions", "pi-jarvis-archive", "archive.sqlite"));
		store.close(); store.close();
	});
	const script = `const {ArchiveStore}=await import(${JSON.stringify(storeUrl)}); const [agent,project]=process.argv.slice(1);
		const s=new ArchiveStore(agent); s.close(); s.search({project}); s.read('a'.repeat(64),project);
		s.session('s',project); s.stats(project); s.forgetSession('s',project); s.prune('2026-01-01T00:00:00Z',project); s.close();`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.agent, f.a], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	assert.doesNotMatch(child.stderr, /SQLite|ExperimentalWarning/);
	assert.equal(fs.existsSync(f.agent), false);
	const store = f.store();
	fs.mkdirSync(dirname(store.path), { recursive: true });
	assert.deepEqual(store.search({ project: f.a }), { records: [], nextOffset: null });
	assert.equal(store.read("a".repeat(64), f.a), undefined);
	assert.deepEqual(store.session("s", f.a), { records: [], nextOffset: null });
	assert.deepEqual(store.stats(f.a), { records: 0, bytes: 0 });
	assert.equal(store.forgetSession("s", f.a), 0);
	assert.equal(store.prune("2026-01-01T00:00:00Z", f.a), 0);
	assert.deepEqual(fs.readdirSync(dirname(store.path)), []);
});

test("full unredacted JSON roundtrip, exact bytes/provenance, private modes and detached summaries", (t) => {
	const f = fixture(t), store = f.store();
	const input = f.input({ parentId: "parent", message: { role: "assistant", content: [
		{ type: "thinking", thinking: "exposed fixture reasoning", thinkingSignature: "opaque-fixture-signature" },
		{ type: "text", text: "  whitespace\n😀\u0000 literal fixture token sk-test-secret-not-real  " },
		{ type: "toolCall", id: "call", name: "fixture_tool", arguments: { command: "fixture command", details: ["reference"] } },
		{ type: "image", data: "ZmFrZS1maXh0dXJlLWltYWdl", mimeType: "image/png" },
	], errorMessage: "fixture failure", stopReason: "error" }, unknown: { retained: true }, optional: undefined });
	assert.equal(store.append(input), "saved");
	const record = store.session(input.sessionId, f.a).records[0];
	assert.equal(record.id, opaqueId(input));
	assert.equal(record.parentId, "parent");
	assert.equal(record.role, "assistant");
	assert.equal(record.lane, "main");
	assert.equal(record.bytes, Buffer.byteLength(JSON.stringify(input.entry)));
	assert.equal(readAll(store, record.id, f.a), JSON.stringify(input.entry));
	assert.deepEqual(store.stats(f.a), { records: 1, bytes: record.bytes });
	assert.equal(fs.statSync(dirname(store.path)).mode & 0o777, 0o700);
	for (const name of ["", "-wal", "-shm"]) assert.equal(fs.statSync(store.path + name).mode & 0o777, 0o600);
	record.excerpt = "mutated result"; record.sessionId = "changed";
	assert.equal(store.read(record.id, f.a)!.record.sessionId, input.sessionId);
	assert.notEqual(store.read(record.id, f.a)!.record.excerpt, record.excerpt);
	store.close(); store.close();
	assert.equal(readAll(store, record.id, f.a), JSON.stringify(input.entry));
	assert.equal(readAll(f.store(), record.id, f.a), JSON.stringify(input.entry));
	assert.deepEqual(rows(store.path, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'records_fts*' ORDER BY name").map(row => row.name), ["records", "tombstones"]);
});

test("every exposed entry type/role is accepted and indexed; signatures/images are raw-only", (t) => {
	const f = fixture(t), store = f.store();
	const entries = [
		f.input({ id: "user", message: { role: "user", content: "userword" } }),
		f.input({ id: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "thinkingword", thinkingSignature: "hiddensignatureword" }, { type: "toolCall", name: "toolnameword", arguments: { path: "argumentword" }, thoughtSignature: "hiddenotherword" }] } }),
		f.input({ id: "system", message: { role: "system", content: "systemword" } }),
		f.input({ id: "tool", message: { role: "toolResult", content: [{ type: "text", text: "toolresultword" }], details: { diagnostic: "detailword" } } }),
		f.input({ id: "custom", type: "custom", message: undefined, data: { reference: "customword" } }),
		f.input({ id: "model", type: "model_change", message: undefined, provider: "providerword", modelId: "modelword" }),
		f.input({ id: "compact", type: "compaction", message: undefined, summary: "summaryword", details: { unknown: "unknownword" } }),
		f.input({ id: "edit", type: "context_edit", message: undefined, targetId: "user", replacement: { content: "replacementword" } }),
		f.input({ id: "image", message: { role: "user", content: [{ type: "image", data: "hiddenimageword", mimeType: "image/png" }, { type: "text", text: "imagecaptionword" }] } }),
		f.input({ id: "label", type: "label", message: undefined, label: undefined }),
	];
	for (const input of entries) assert.equal(store.append(input), "saved");
	for (const word of ["userword", "thinkingword", "toolnameword", "argumentword", "systemword", "toolresultword", "detailword", "customword", "providerword", "modelword", "summaryword", "unknownword", "replacementword", "imagecaptionword"]) {
		assert.equal(store.search({ project: f.a, query: word }).records.length, 1, word);
	}
	for (const query of ["hiddensignatureword", "hiddenotherword", "hiddenimageword"]) assert.deepEqual(store.search({ project: f.a, query }).records, []);
	for (const input of entries) assert.equal(readAll(store, opaqueId(input), f.a), JSON.stringify(input.entry));
	store.close();
	assert.equal(store.search({ project: f.a, query: "thinkingword" }).records.length, 1);
});

test("identity is project/session/entry; identical cross-lane duplicates are allowed, conflicting raw JSON rejects", (t) => {
	const f = fixture(t), store = f.store(), input = f.input();
	assert.equal(store.append(input), "saved");
	assert.equal(store.append(input), "duplicate");
	assert.equal(store.append({ ...input, lane: "import" }), "duplicate");
	assert.equal(store.append({ ...input, lane: "jarvis", entry: { ...input.entry, optional: undefined } }), "duplicate", "compare serialized payloads, not object identity");
	const conflicts = [
		{ ...input.entry, message: { role: "assistant", content: "changed-private-fixture" } },
		{ ...input.entry, parentId: "changed-parent" },
		{ ...input.entry, timestamp: "2026-01-03T00:00:00Z" },
		Object.fromEntries(Object.entries(input.entry).reverse()) as ArchiveInput["entry"],
	];
	for (const entry of conflicts) assert.throws(() => store.append({ ...input, lane: "import", entry }), error => {
		assert.match(String(error), /conflicting serialized payload.*not saved or replaced/);
		assert.doesNotMatch(String(error), /changed-private-fixture|changed-parent/);
		return true;
	});
	assert.equal(readAll(store, opaqueId(input), f.a), JSON.stringify(input.entry));
	assert.equal(store.session(input.sessionId, f.a).records[0].lane, "main");
	assert.equal(store.search({ project: f.a, query: "changed-private-fixture" }).records.length, 0);
	store.close();
	const peer = f.store();
	assert.equal(peer.append({ ...input, lane: "import" }), "duplicate");
	assert.throws(() => peer.append({ ...input, entry: conflicts[0] }), /conflicting serialized payload/);
	assert.equal(readAll(peer, opaqueId(input), f.a), JSON.stringify(input.entry));
	for (const next of [f.input({}, { project: f.b }), f.input({}, { sessionId: "other" }), f.input({ id: "other" })]) assert.equal(store.append(next), "saved");
	assert.deepEqual(store.stats(f.a, true).records, 4);
	assert.equal(store.read(opaqueId(f.input({}, { project: f.b })), f.a), undefined);
	assert.ok(store.read(opaqueId(f.input({}, { project: f.b })), f.a, true));
	assert.equal(store.search({ project: f.a }).records.length, 3);
	assert.equal(store.search({ project: f.a, scope: "all" }).records.length, 4);
	assert.equal(store.session(input.sessionId, f.a).records.length, 2);
	assert.equal(store.session(input.sessionId, f.a, true).records.length, 3);
	assert.equal(store.search({ project: f.a, scope: "all", sessionId: "other" }).records.length, 1);
});

test("duplicate/conflict SQL compares raw inside BEGIN IMMEDIATE and never materializes the old body", (t) => {
	const f = fixture(t), store = f.store(), input = f.input(); store.append(input); store.close();
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
	let transaction = false, comparisons = 0;
	t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
		const result = exec.call(this, sql);
		if (sql === "BEGIN IMMEDIATE") transaction = true;
		if (sql === "COMMIT" || sql === "ROLLBACK") transaction = false;
		return result;
	});
	t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
		const statement = prepare.call(this, sql), get = statement.get.bind(statement);
		if (sql.includes("FROM records WHERE id=?")) {
			assert.match(sql, /^SELECT raw_json=\? AS identical /);
			t.mock.method(statement, "get", (...args: SQLInputValue[]) => {
				assert.equal(transaction, true);
				assert.equal(typeof args[0], "string");
				assert.equal(args[1], opaqueId(input));
				const row = get(...args)!;
				assert.deepEqual(Object.keys(row), ["identical"]);
				assert.equal(typeof row.identical, "number"); comparisons++;
				return row;
			});
		}
		return statement;
	});
	assert.equal(store.append({ ...input, lane: "import" }), "duplicate");
	assert.throws(() => store.append(f.input({ data: "different" })), /conflicting serialized payload/);
	assert.equal(comparisons, 2); assert.equal(transaction, false);
	t.mock.restoreAll();
	assert.equal(store.stats(f.a).records, 1);
	assert.equal(readAll(store, opaqueId(input), f.a), JSON.stringify(input.entry));
});

function indexLimits(store: ArchiveStore): { bytes: number; normalizationCharacters: number } {
	// Private instance test hook keeps all expansion/budget fixtures tiny.
	return (store as unknown as { indexLimits: { bytes: number; normalizationCharacters: number } }).indexLimits;
}

test("bounded normalization preserves composition, Hangul, surrogate pairs, case context and whitespace across cuts", (t) => {
	const f = fixture(t), store = f.store(); indexLimits(store).normalizationCharacters = 16;
	const values = [
		"x".repeat(15) + "A\u030a\u0323 tail",
		"x".repeat(14) + "\uffa1\uffc2\u11a8 tail", // Compatibility Jamo -> Hangul, kept together.
		"x".repeat(15) + "\u{1d400}\u030a tail", // Nominal cut is inside an astral compatibility character.
		"x".repeat(14) + "ΟΣ" + "x".repeat(35), // Sigma must see the following chunk's cased letter.
		"x".repeat(14) + "ΟΣ\ufeff" + "x".repeat(35),
		"x".repeat(14) + "ΟΣ\u0301\u0301 " + "x".repeat(35),
		"\uffa1\uffc2\u11a8".repeat(30), // No ASCII boundaries: normalized carry composes each syllable.
		"\u{16d63}\u{16d67}\u{16d67}".repeat(20), // Kirat Rai's starter/starter canonical composition.
		" \t\n\0".repeat(20) + "ＷＩＤＥ İ" + "\t\0 ".repeat(20),
	];
	const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\0]+/gu, " ").trim();
	const original = String.prototype.normalize;
	let calls = 0;
	t.mock.method(String.prototype, "normalize", function(this: string, form?: string) {
		assert.ok(this.length <= 16, `normalization input must be bounded: ${this.length}`);
		calls++;
		return original.call(this, form);
	});
	for (const [i, content] of values.entries()) store.append(f.input({ id: `unicode-${i}`, message: { role: "user", content } }));
	assert.ok(calls > values.length);
	t.mock.restoreAll();
	for (const [i, content] of values.entries()) {
		const input = f.input({ id: `unicode-${i}`, message: { role: "user", content } });
		const expected = [input.entry.id, input.entry.type, input.entry.timestamp, "user", content, f.a, input.sessionId, input.lane].map(normalize).join("\n");
		const row = rows(store.path, `SELECT search_text,excerpt FROM records WHERE entry_id='unicode-${i}'`)[0];
		assert.equal(row.search_text, expected);
		assert.equal(row.excerpt, [...expected].slice(0, 480).join("") + ([...expected].length > 480 ? "…" : ""));
		assert.equal(readAll(store, opaqueId(input), f.a), JSON.stringify(input.entry));
	}
	assert.equal(store.search({ project: f.a, query: "wide" }).records.length, 1);
});

test("streamed NFKC agrees with whole-string normalization for mixed Unicode starter/mark boundaries", (t) => {
	const f = fixture(t), store = f.store(); indexLimits(store).normalizationCharacters = 64;
	const alphabet = ["A", "Σ", "Ο", "İ", "x", " ", "\ufeff", "\u0301", "\u0323", "\u034f", "\u0345", "\uffa1", "\uffc2", "\u11a8",
		"\ufdfa", "\u0e33", "\u0f40", "\u0f73", "\u09c7", "\u09be", "\u{1d400}", "\u{16d63}", "\u{16d67}"];
	const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\0]+/gu, " ").trim();
	let state = 17;
	for (let i = 0; i < 60; i++) {
		let content = "";
		for (let j = 0; j < 60; j++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			content += alphabet[state % alphabet.length];
		}
		const input = f.input({ id: `mixed-${i}`, message: { role: "user", content } });
		assert.equal(store.append(input), "saved");
		const expected = [input.entry.id, input.entry.type, input.entry.timestamp, "user", content, f.a, input.sessionId, input.lane].map(normalize).join("\n");
		assert.equal(rows(store.path, `SELECT search_text FROM records WHERE entry_id='mixed-${i}'`)[0].search_text, expected, `Unicode fixture ${i}`);
	}
});

test("index budget rejects expansion, cumulative fields/separators/metadata and lowercase growth atomically", (t) => {
	const f = fixture(t), store = f.store(); store.append(f.input());
	const limits = indexLimits(store);
	assert.equal(limits.bytes, 64 * 1024 * 1024);
	assert.equal(ARCHIVE_STORE_LIMITS.entryBytes, 64 * 1024 * 1024);
	limits.bytes = 512;
	const rejected = [
		f.input({ id: "expanded", message: { role: "user", content: "\ufdfa".repeat(20) } }),
		f.input({ id: "lowercase", message: { role: "user", content: "İ".repeat(160) } }),
		f.input({ id: "cumulative", data: ["a".repeat(180), "b".repeat(180), "c".repeat(180)] }),
	];
	const stats = store.stats(f.a), before = rows(store.path, "SELECT count(*) AS count FROM records_fts")[0].count;
	for (const input of rejected) {
		assert.ok(Buffer.byteLength(JSON.stringify(input.entry)) < ARCHIVE_STORE_LIMITS.entryBytes);
		assert.throws(() => store.append(input), error => {
			assert.match(String(error), /search index.*budget.*not saved or truncated/);
			assert.doesNotMatch(String(error), /expanded|lowercase|cumulative|\ufdfa/);
			return true;
		});
		assert.deepEqual(store.stats(f.a), stats);
		assert.equal(store.read(opaqueId(input), f.a), undefined);
	}
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM records_fts")[0].count, before);
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, 0);
	assert.equal(store.search({ project: f.a, query: "fixture" }).records.length, 1);
	// Measure a small accepted fixture, then enforce its exact complete index
	// budget on a fresh entry (including separators and scope metadata).
	const accepted = f.input({ id: "boundary", message: { role: "user", content: "exactbudgetword" } });
	limits.bytes = 4096; assert.equal(store.append(accepted), "saved");
	const bytes = Number(rows(store.path, "SELECT length(CAST(search_text AS BLOB)) AS bytes FROM records WHERE entry_id='boundary'")[0].bytes);
	limits.bytes = bytes;
	assert.equal(store.append(f.input({ ...accepted.entry, id: "boundar2" })), "saved");
	limits.bytes = bytes - 1;
	assert.throws(() => store.append(f.input({ ...accepted.entry, id: "boundar3" })), /search index.*budget/);
	// Identity/tombstone checks still precede indexing, including after reopen.
	store.close(); assert.equal(store.append({ ...accepted, lane: "import" }), "duplicate");
	assert.equal(store.search({ project: f.a, query: "exactbudgetword" }).records.length, 2);
	limits.bytes = 4096;
	assert.equal(store.append(rejected[0]), "saved", "rejected identities remain retryable, not tombstoned");
});

test("overlong normalization contexts reject rather than splitting marks or silently shortening the index", (t) => {
	const f = fixture(t), store = f.store(); store.append(f.input());
	indexLimits(store).normalizationCharacters = 16;
	for (const content of ["\ufdfa".repeat(40), "A" + "\u0301".repeat(40), "\u0301".repeat(40)]) {
		assert.throws(() => store.append(f.input({ id: "unsafe-run", message: { role: "user", content } })), /normalization context.*budget.*not saved or truncated/);
		assert.equal(store.stats(f.a).records, 1);
		assert.equal(store.search({ project: f.a, query: "fixture" }).records.length, 1);
	}
	indexLimits(store).normalizationCharacters = 64;
	indexLimits(store).bytes = 4096;
	const content = "\ufdfa".repeat(40);
	assert.equal(store.append(f.input({ id: "unsafe-run", message: { role: "user", content } })), "saved", "compatibility expansions stream correctly with bounded context");
	const text = rows(store.path, "SELECT search_text FROM records WHERE entry_id='unsafe-run'")[0].search_text as string;
	assert.ok(text.includes(content.normalize("NFKC").toLowerCase()));
});

test("literal keywords/phrases, Unicode normalization, unsafe FTS syntax and query caps", (t) => {
	const f = fixture(t), store = f.store();
	const inputs = [
		f.input({ id: "phrase", message: { role: "user", content: 'alpha beta ÄPFEL ＷＩＤＥ %_ \' OR 1=1 -- "quoted" * : ()' } }),
		f.input({ id: "apart", message: { role: "user", content: "alpha intervening beta" } }),
		f.input({ id: "other", message: { role: "user", content: "unrelated" } }),
	];
	for (const input of inputs) store.append(input);
	const ids = (query: string) => store.search({ project: f.a, query }).records.map(row => row.id).sort();
	assert.deepEqual(ids('"alpha beta"'), [opaqueId(inputs[0])]);
	assert.deepEqual(ids("alpha absent"), inputs.slice(0, 2).map(opaqueId).sort());
	for (const query of ["äpfel", "apfel", "wide", '"quoted"']) assert.deepEqual(ids(query), [opaqueId(inputs[0])]);
	for (const query of ["%_", "*", ":", "()", '" OR * NOT "', "NEAR(alpha,beta)", '"unmatched']) assert.doesNotThrow(() => ids(query));
	assert.deepEqual(ids("*"), []);
	assert.deepEqual(ids("alpha*"), inputs.slice(0, 2).map(opaqueId).sort(), "literal punctuation is tokenized, never a wildcard operator");
	const before = ids("alpha"); store.close(); assert.deepEqual(ids("alpha"), before);
	assert.doesNotThrow(() => ids("q".repeat(512)));
	assert.doesNotThrow(() => ids(Array.from({ length: 16 }, (_, i) => `q${i}`).join(" ")));
	assert.throws(() => ids("q".repeat(513)), /query/);
	assert.throws(() => ids(Array.from({ length: 17 }, (_, i) => `q${i}`).join(" ")), /terms/);
	assert.throws(() => ids('"' + Array.from({ length: 17 }, (_, i) => `q${i}`).join(" ") + '"'), /terms/);
});

test("search/session pages have deterministic ordering, lookahead, defaults and capped limits", (t) => {
	const f = fixture(t), store = f.store();
	for (let i = 0; i < 63; i++) store.append(f.input({ id: `e-${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
	assert.equal(store.search({ project: f.a }).records.length, 20);
	assert.equal(store.search({ project: f.a, limit: 500 }).records.length, 50);
	assert.equal(store.search({ project: f.a, limit: -10 }).records.length, 1);
	assert.equal(store.session("fixture-session", f.a, false, 0, 0).records.length, 1);
	for (const mode of ["search", "session"] as const) {
		let start = 0; const ids: string[] = [];
		for (;;) {
			const page = mode === "search" ? store.search({ project: f.a, query: "fixture", offset: start, limit: 17 }) : store.session("fixture-session", f.a, false, start, 17);
			ids.push(...page.records.map(row => row.entryId));
			if (page.nextOffset === null) break;
			assert.equal(page.nextOffset, start + 17); start = page.nextOffset;
		}
		assert.equal(ids.length, 63); assert.equal(new Set(ids).size, 63);
		assert.equal(ids[0], mode === "search" ? "e-62" : "e-0");
		assert.equal(ids[62], mode === "search" ? "e-0" : "e-62");
	}
	assert.deepEqual(store.search({ project: f.a, offset: 63 }), { records: [], nextOffset: null });
	assert.deepEqual(store.session("fixture-session", f.a, false, 63), { records: [], nextOffset: null });
	const before = store.search({ project: f.a, limit: 50 }); store.close(); assert.deepEqual(store.search({ project: f.a, limit: 50 }), before);
});

test("raw read pages count Unicode codepoints, not bytes/UTF16, without truncation", (t) => {
	const f = fixture(t), store = f.store();
	const input = f.input({ message: { role: "user", content: "😀é雪\u0000\ud800".repeat(4000) } });
	store.append(input);
	const raw = JSON.stringify(input.entry), id = opaqueId(input), points = [...raw];
	assert.equal(readAll(store, id, f.a, 997), raw);
	const first = store.read(id, f.a, false, 0, 100_000)!;
	assert.equal([...first.content].length, 12_000);
	assert.equal(first.nextOffset, 12_000);
	assert.equal(first.totalCharacters, points.length);
	for (const start of [1, 133, points.length - 1, points.length, points.length + 100]) {
		const page = store.read(id, f.a, false, start, 7)!;
		assert.equal(page.content, points.slice(start, start + 7).join(""));
		assert.equal(page.nextOffset, start + 7 < points.length ? start + 7 : null);
	}
	assert.equal([...store.read(id, f.a, false, 0, 0)!.content].length, 1);
});

test("session forgetting and timestamp pruning are scoped, atomic, durable and block re-import", (t) => {
	const f = fixture(t), store = f.store();
	const inputs = [f.input({ id: "old", timestamp: "2026-01-01T00:00:00Z" }), f.input({ id: "boundary", timestamp: "2026-01-02T01:00:00+01:00" }),
		f.input({ id: "new", timestamp: "2026-01-03T00:00:00Z" }), f.input({ id: "old-b", timestamp: "2026-01-01T00:00:00Z" }, { project: f.b }),
		f.input({ id: "other" }, { sessionId: "other-session" })];
	for (const input of inputs) store.append(input);
	assert.equal(store.prune("2026-01-02T00:00:00Z", f.a), 1);
	assert.ok(store.read(opaqueId(inputs[1]), f.a), "pruning is strictly before the equivalent ISO instant");
	assert.ok(store.read(opaqueId(inputs[3]), f.b));
	assert.equal(store.append(inputs[0]), "deleted");
	assert.equal(store.forgetSession("fixture-session", f.a), 2);
	assert.equal(store.forgetSession("fixture-session", f.a), 0);
	assert.equal(store.stats(f.a).records, 1);
	store.close();
	for (const input of inputs.slice(0, 3)) assert.equal(store.append({ ...input, lane: "import", entry: { ...input.entry, data: "changed fixture" } }), "deleted");
	assert.equal(store.search({ project: f.a, query: "fixture" }).records.length, 1);
	assert.equal(store.forgetSession("fixture-session", f.a, true), 1);
	assert.equal(store.prune("2027-01-01T00:00:00Z", f.a, true), 1);
	store.close();
	assert.deepEqual(store.stats(f.a, true), { records: 0, bytes: 0 });
	for (const input of inputs) assert.equal(store.append(input), "deleted");
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, 5);
	assert.deepEqual(Object.keys(rows(store.path, "SELECT * FROM tombstones LIMIT 1")[0]).sort(), ["deleted_at", "id"]);
	assert.deepEqual(store.search({ project: f.a, query: "fixture", scope: "all" }).records, []);
});

test("invalid input/queries reject before filesystem access; JSON errors never silently truncate", (t) => {
	const f = fixture(t), store = f.store();
	const cycle: Record<string, unknown> = {}; cycle.self = cycle;
	withFault("lstatSync", () => {
		for (const entry of [null, [], { id: undefined }, { id: "" }, { parentId: undefined }, { parentId: 1 }, { type: "" }, { timestamp: "no" },
			{ timestamp: "2026-02-30T00:00:00Z" }, { timestamp: "2026-01-01T24:00:00Z" }, { id: "\ud800" },
			{ data: () => "no" }, { data: 1n }, { data: NaN }, { data: Infinity }, { data: Symbol() }, { data: new Date() },
			{ data: cycle }, { data: [undefined] }, { message: { role: 1 } }]) {
			const input = entry === null || Array.isArray(entry) ? { ...f.input(), entry } : f.input(entry as never);
			assert.throws(() => store.append(input as never), /Invalid archive/);
		}
		assert.throws(() => store.append(null as never), /input/);
		for (const patch of [{ project: "relative" }, { project: `${f.a}/..` }, { sessionId: "" }, { lane: "manual" }, { sessionId: "s".repeat(513) }]) assert.throws(() => store.append(f.input({}, patch as never)), /Invalid archive/);
		for (const query of [null, { project: "relative" }, { project: f.a, scope: null }, { project: f.a, scope: "global" },
			{ project: f.a, limit: NaN }, { project: f.a, limit: 1.5 }, { project: f.a, limit: null }, { project: f.a, offset: -1 },
			{ project: f.a, offset: 0.5 }, { project: f.a, offset: "0" }, { project: f.a, query: "\0" }, { project: f.a, query: null }, { project: f.a, sessionId: "" }]) assert.throws(() => store.search(query as never), /Invalid archive/);
		assert.throws(() => store.read("bad", f.a), /ID/);
		assert.throws(() => store.read("a".repeat(64), f.a, null as never), /flag/);
		assert.throws(() => store.read("a".repeat(64), f.a, false, NaN), /offset/);
		assert.throws(() => store.read("a".repeat(64), f.a, false, 0, Infinity), /limit/);
		assert.throws(() => store.session("", f.a), /session/);
		assert.throws(() => store.stats(f.a, 1 as never), /flag/);
		assert.throws(() => store.forgetSession("s", "relative"), /project/);
		assert.throws(() => store.prune("2026-01-01", f.a), /timestamp/);
	});
	assert.equal(fs.existsSync(f.agent), false);
});

test("64MiB UTF8 boundary rejects explicitly and retains exact maximum image JSON with bounded search/read", { timeout: 90_000 }, (t) => {
	const f = fixture(t);
	// Isolate large allocations from the rest of the suite's fixtures/mocks.
	const script = `import assert from 'node:assert/strict'; import fs from 'node:fs';
		const {ArchiveStore,ARCHIVE_STORE_LIMITS:L}=await import(${JSON.stringify(storeUrl)});
		const [agent,project]=process.argv.slice(1); const s=new ArchiveStore(agent);
		const input={project,sessionId:'big',lane:'main',entry:{id:'big',parentId:null,type:'message',timestamp:'2026-01-01T00:00:00Z',message:{role:'user',content:[{type:'text',text:'giantfixtureword'},{type:'image',data:'',mimeType:'image/png'}]}}};
		const overhead=Buffer.byteLength(JSON.stringify(input.entry));
		input.entry.message.content[1].data='x'.repeat(L.entryBytes-overhead+1);
		assert.throws(()=>s.append(input),/64 MiB.*not saved or truncated/); assert.equal(fs.existsSync(agent),false);
		input.entry.message.content[1].data=input.entry.message.content[1].data.slice(1);
		assert.equal(s.append(input),'saved'); const id=s.session('big',project).records[0].id;
		assert.equal(s.stats(project).bytes,L.entryBytes); s.close();
		const page=s.search({project,query:'giantfixtureword'}); assert.equal(page.records.length,1);
		assert.equal(page.records[0].bytes,L.entryBytes); assert.ok(page.records[0].excerpt.length<1000);
		assert.deepEqual(s.search({project,query:'xxxxxx'}).records,[]);
		const first=s.read(id,project); assert.equal(first.content.length,12000); assert.equal(first.totalCharacters,L.entryBytes);
		const tail=s.read(id,project,false,L.entryBytes-100,12000); assert.equal(tail.content.length,100); assert.equal(tail.nextOffset,null);
		assert.equal(s.forgetSession('big',project),1); assert.equal(s.append(input),'deleted'); s.close();`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.agent, f.a], { encoding: "utf8", timeout: 85_000 });
	assert.equal(child.status, 0, child.stderr || String(child.error));
});

test("large textual entries stay indexed in full while SQL returns only bounded summaries/chunks", (t) => {
	const f = fixture(t), store = f.store();
	const text = "neutral ".repeat(256_000) + " lateuniquefixtureword";
	const input = f.input({ message: { role: "user", content: text } });
	store.append(input); store.close();
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const prepare = DatabaseSync.prototype.prepare;
	t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
		const statement = prepare.call(this, sql);
		for (const method of ["get", "all"] as const) {
			const original = statement[method].bind(statement);
			t.mock.method(statement, method, (...args: SQLInputValue[]) => {
				const result = original(...args);
				for (const row of Array.isArray(result) ? result : result ? [result] : []) {
					assert.equal("raw_json" in row, false); assert.equal("search_text" in row, false);
					for (const value of Object.values(row)) if (typeof value === "string") assert.ok([...value].length <= 12_000);
				}
				return result;
			});
		}
		return statement;
	});
	assert.equal(store.search({ project: f.a, query: "lateuniquefixtureword" }).records[0].id, opaqueId(input));
	assert.ok(store.search({ project: f.a }).records[0].excerpt.endsWith("…"));
	assert.equal(store.read(opaqueId(input), f.a, false, 1_000_000)!.content.length, 12_000);
});

test("reopening touches only schema/version, never scans historical raw JSON, metadata or FTS bodies", (t) => {
	const f = fixture(t), store = f.store(), input = f.input(); store.append(input); store.close();
	const db = database(store.path);
	try { db.exec("PRAGMA ignore_check_constraints=ON; UPDATE records SET raw_json='deliberately invalid fixture JSON'"); } finally { db.close(); }
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
	t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
		assert.doesNotMatch(sql, /raw_json|json_valid|json_extract|quick_check|integrity-check/i);
		const statement = prepare.call(this, sql);
		t.mock.method(statement, "iterate", () => assert.fail("opening unbounded archives must not iterate historical rows"));
		return statement;
	});
	t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) { assert.doesNotMatch(sql, /quick_check|integrity-check/i); return exec.call(this, sql); });
	t.mock.method(JSON, "parse", () => assert.fail("no history parsing on open/search"));
	assert.equal(store.stats(f.a).records, 1);
	assert.equal(store.search({ project: f.a, query: "fixture" }).records.length, 1);
	t.mock.restoreAll();
	assert.throws(() => store.read(opaqueId(input), f.a), /read content|JSON/);
});

test("no memory retention cap or automatic eviction is applied", { timeout: 30_000 }, (t) => {
	const f = fixture(t), store = f.store();
	store.append(f.input()); store.close();
	const db = database(store.path);
	try {
		db.exec("BEGIN IMMEDIATE");
		const insert = db.prepare(`INSERT INTO records(id,project,session_id,entry_id,parent_id,lane,type,role,timestamp,timestamp_ms,bytes,characters,raw_json,search_text,excerpt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
		const fts = db.prepare("INSERT INTO records_fts(rowid,search_text) VALUES(?,?)");
		for (let i = 0; i < 10_001; i++) {
			const input = f.input({ id: `fixture-${i}` }), raw = JSON.stringify(input.entry);
			const inserted = insert.run(opaqueId(input), f.a, input.sessionId, input.entry.id, null, "main", "message", "user", input.entry.timestamp, Date.parse(input.entry.timestamp), Buffer.byteLength(raw), raw.length, raw, "fixture", "fixture");
			fts.run(inserted.lastInsertRowid, "fixture");
		}
		db.exec("COMMIT");
	} finally { db.close(); }
	assert.equal(store.stats(f.a).records, 10_002);
	assert.equal(store.append(f.input({ id: "newest" })), "saved");
	assert.equal(store.stats(f.a).records, 10_003);
	assert.ok(store.read(opaqueId(f.input()), f.a));
});

test("owned directory links/unexpected entries reject without touching their targets", async (t) => {
	for (const location of ["extensions", "archive", "unexpected"] as const) await t.test(location, (t) => {
		const f = fixture(t), store = f.store(), target = join(f.root, "target");
		fs.mkdirSync(target); fs.writeFileSync(join(target, "marker"), "unchanged");
		const archive = dirname(store.path);
		const path = location === "extensions" ? dirname(archive) : location === "archive" ? archive : join(archive, "unexpected");
		fs.mkdirSync(dirname(path), { recursive: true }); fs.symlinkSync(target, path, "dir");
		assert.throws(() => store.append(f.input()), /storage/);
		assert.throws(() => store.stats(f.a), /storage/);
		assert.deepEqual(fs.readdirSync(target), ["marker"]);
		assert.equal(fs.readFileSync(join(target, "marker"), "utf8"), "unchanged");
	});
});

test("database and every auxiliary path reject links, hardlinks and nonregular files", async (t) => {
	for (const name of ["archive.sqlite", "archive.sqlite-wal", "archive.sqlite-shm", "archive.sqlite-journal"]) {
		for (const kind of ["symlink", "hardlink", "directory"] as const) await t.test(`${name} ${kind}`, (t) => {
			const f = fixture(t), store = f.store(); store.append(f.input()); store.close();
			const path = join(dirname(store.path), name), victim = join(f.root, "victim");
			if (fs.existsSync(path)) fs.unlinkSync(path);
			fs.writeFileSync(victim, "unchanged fixture");
			if (kind === "symlink") fs.symlinkSync(victim, path);
			else if (kind === "hardlink") fs.linkSync(victim, path);
			else fs.mkdirSync(path);
			assert.throws(() => store.stats(f.a), /storage|orphaned|replaced/);
			assert.throws(() => store.append(f.input()), /storage|orphaned|replaced/);
			assert.equal(fs.readFileSync(victim, "utf8"), "unchanged fixture");
		});
	}
});

test("orphaned auxiliaries reject before database creation; permissive owned storage is tightened", (t) => {
	const f = fixture(t), store = f.store();
	fs.mkdirSync(dirname(store.path), { recursive: true, mode: 0o755 });
	store.append(f.input());
	assert.equal(fs.statSync(dirname(store.path)).mode & 0o777, 0o700);
	store.close(); fs.chmodSync(store.path, 0o644); fs.chmodSync(dirname(store.path), 0o755);
	store.stats(f.a);
	assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
	assert.equal(fs.statSync(dirname(store.path)).mode & 0o777, 0o700);
	const orphan = f.store(join(f.root, "orphan-agent"));
	fs.mkdirSync(dirname(orphan.path), { recursive: true }); fs.writeFileSync(`${orphan.path}-wal`, "orphan");
	assert.throws(() => orphan.stats(f.a), /orphaned/);
	assert.throws(() => orphan.append(f.input()), /orphaned/);
	assert.equal(fs.existsSync(orphan.path), false);
});

test("permission checks never open/close live SQLite main/sidecar descriptors or disturb peer locks", (t) => {
	const f = fixture(t), store = f.store(); store.append(f.input());
	fs.chmodSync(store.path, 0o644);
	for (const suffix of ["-wal", "-shm"]) fs.chmodSync(store.path + suffix, 0o644);
	const open = fs.openSync;
	const opened: string[] = [];
	t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
		const fd = open(...args);
		opened.push(String(args[0]));
		return fd;
	});
	syncBuiltinESMExports();
	try {
		const peer = f.store(); assert.equal(peer.stats(f.a).records, 1);
		assert.equal(peer.append(f.input({ id: "peer" })), "saved");
		peer.close(); assert.equal(peer.stats(f.a).records, 2);
		assert.equal(store.append(f.input({ id: "original" })), "saved");
		assert.deepEqual(opened.filter(path => path.startsWith(store.path)), [], "closing any extra main/shm descriptor releases process-wide POSIX fcntl locks");
		for (const suffix of ["", "-wal", "-shm"]) assert.equal(fs.statSync(store.path + suffix).mode & 0o777, 0o600);
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("replacement database/owned directory stays rejected after error and explicit close", async (t) => {
	for (const mode of ["database", "directory"] as const) await t.test(mode, (t) => {
		const f = fixture(t), store = f.store(); store.append(f.input()); store.close();
		if (mode === "database") {
			fs.renameSync(store.path, join(f.root, "old.sqlite")); fs.copyFileSync(join(f.root, "old.sqlite"), store.path);
		} else {
			fs.renameSync(dirname(store.path), join(f.root, "old-archive")); fs.mkdirSync(dirname(store.path));
			fs.copyFileSync(join(f.root, "old-archive", "archive.sqlite"), store.path);
		}
		for (let i = 0; i < 2; i++) {
			assert.throws(() => store.stats(f.a), /replaced/);
			store.close(); assert.throws(() => store.append(f.input()), /replaced/);
		}
	});
});

test("user-selected root/ancestor aliases work lazily, but retargeting and root inode replacement reject", (t) => {
	const f = fixture(t), target = join(f.root, "target"), alias = join(f.root, "alias");
	fs.mkdirSync(target); fs.symlinkSync(target, alias, "dir");
	const store = f.store(join(alias, "agent"));
	assert.deepEqual(store.stats(f.a), { records: 0, bytes: 0 });
	assert.equal(fs.existsSync(join(target, "agent")), false);
	store.append(f.input()); store.close(); assert.equal(store.stats(f.a).records, 1);
	const direct = join(f.root, "direct"); fs.symlinkSync(join(target, "agent"), direct, "dir");
	assert.equal(f.store(direct).stats(f.a).records, 1);
	const replacement = join(f.root, "replacement"); fs.mkdirSync(replacement);
	fs.unlinkSync(alias); fs.symlinkSync(replacement, alias, "dir");
	assert.throws(() => store.stats(f.a), /replaced agent root/); store.close();
	assert.throws(() => store.append(f.input()), /replaced agent root/);
	assert.equal(fs.existsSync(join(replacement, "agent")), false);
});

test("unknown/foreign/corrupt storage is never reset, and reads cannot initialize empty storage", async (t) => {
	const corruptions: [string, (db: DatabaseSync, id: string) => void][] = [
		["future version", db => db.exec("PRAGMA user_version=2")],
		["zero version with data", db => db.exec("PRAGMA user_version=0")],
		["foreign schema", db => db.exec("CREATE TABLE sqliteevil(fixture TEXT)")],
		["relative project", db => db.exec("UPDATE records SET project='relative'")],
		["identity mismatch", db => db.exec(`UPDATE records SET id='${"a".repeat(64)}'`)],
		["invalid timestamp", db => db.exec("UPDATE records SET timestamp='bad'")],
		["invalid JSON", db => db.exec("PRAGMA ignore_check_constraints=ON; UPDATE records SET raw_json='no json'")],
		["raw metadata mismatch", db => db.exec("UPDATE records SET raw_json=json_set(raw_json,'$.id','different')")],
		["byte mismatch", db => db.exec("UPDATE records SET bytes=bytes+1")],
		["raw missing parent", db => db.exec("UPDATE records SET raw_json=json_remove(raw_json,'$.parentId')")],
		["tombstone overlap", (db, id) => db.prepare("INSERT INTO tombstones VALUES(?,?)").run(id, Date.now())],
	];
	for (const [name, mutate] of corruptions) await t.test(name, (t) => {
		const f = fixture(t), store = f.store(), input = f.input(); store.append(input); store.close();
		const db = database(store.path); try { mutate(db, opaqueId(input)); } finally { db.close(); }
		const before = fs.readFileSync(store.path);
		// Unbounded storage does not scan historical bodies on open. Validate
		// malformed metadata when returned; validate raw JSON on bounded reads.
		const inspect = () => /JSON|raw|byte/.test(name) ? store.read(opaqueId(input), f.a) : store.search({ project: f.a, scope: "all" });
		assert.throws(inspect); store.close(); assert.throws(inspect);
		assert.deepEqual(fs.readFileSync(store.path), before);
	});
	await t.test("invalid SQLite header", (t) => {
		const f = fixture(t), store = f.store(); fs.mkdirSync(dirname(store.path), { recursive: true }); fs.writeFileSync(store.path, "fixture not SQLite");
		assert.throws(() => store.stats(f.a)); assert.equal(fs.readFileSync(store.path, "utf8"), "fixture not SQLite");
	});
	await t.test("empty file is not initialized by inspection", (t) => {
		const f = fixture(t), store = f.store(); fs.mkdirSync(dirname(store.path), { recursive: true }); fs.writeFileSync(store.path, "");
		assert.throws(() => store.stats(f.a), /version/); assert.equal(fs.statSync(store.path).size, 0);
		assert.equal(store.append(f.input()), "saved");
	});
});

test("I/O failures propagate without replacing data and can recover with the same path", (t) => {
	const f = fixture(t), store = f.store(), input = f.input(); store.append(input); store.close();
	for (const key of ["lstatSync", "openSync", "opendirSync", "fchmodSync"] as const) {
		withFault(key, () => assert.throws(() => store.append(f.input({ id: "must-not-save" })), /fixture I\/O failure/));
		store.close(); assert.equal(readAll(store, opaqueId(input), f.a), JSON.stringify(input.entry)); store.close();
	}
	assert.equal(store.stats(f.a).records, 1);
});

function sqliteError(errcode: number): Error { return Object.assign(new Error("fixture SQLite failure"), { code: "ERR_SQLITE_ERROR", errcode }); }
function interceptWal(t: TestContext, attempt: (db: DatabaseSync, get: () => Record<string, unknown> | undefined) => Record<string, unknown> | undefined): void {
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const prepare = DatabaseSync.prototype.prepare;
	t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
		const statement = prepare.call(this, sql);
		if (sql === "PRAGMA journal_mode=WAL") {
			const get = statement.get.bind(statement);
			t.mock.method(statement, "get", () => attempt(this, () => get()));
		}
		return statement;
	});
}

test("WAL startup retries actual upgrade locks after validation and restores busy timeout", (t) => {
	const f = fixture(t), store = f.store(); store.append(f.input()); store.close();
	const db = database(store.path); try { assert.equal(db.prepare("PRAGMA journal_mode=DELETE").get()!.journal_mode, "delete"); } finally { db.close(); }
	let attempts = 0; let connection!: DatabaseSync;
	interceptWal(t, (db, get) => {
		connection = db; assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 0);
		assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
		if (++attempts !== 1) return get();
		const blocker = database(store.path);
		try {
			blocker.exec("BEGIN"); blocker.prepare("SELECT id FROM records").get();
			assert.throws(get, (error: unknown) => { assert.equal((error as { errcode: number }).errcode & 0xff, 5); throw error; });
		} finally { blocker.close(); }
	});
	assert.equal(store.append(f.input({ id: "second" })), "saved");
	assert.equal(attempts, 2); assert.equal(connection.prepare("PRAGMA busy_timeout").get()!.timeout, 5000);
	assert.equal(store.stats(f.a).records, 2);
});

test("WAL retries BUSY/LOCKED extended codes only, within a single finite startup budget", (t) => {
	const f = fixture(t), store = f.store();
	let elapsed = 0, attempts = 0;
	t.mock.method(performance, "now", () => elapsed);
	t.mock.method(Atomics, "wait", (_buffer: Int32Array, _index: number, _value: number, timeout: number) => { assert.ok(timeout > 0 && timeout <= 20); elapsed += timeout; return "timed-out"; });
	interceptWal(t, db => {
		assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 0);
		assert.ok(elapsed < 5000); throw sqliteError([5, 6, 261, 262][attempts++ % 4]);
	});
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const close = DatabaseSync.prototype.close; const timeouts: number[] = [];
	t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) { timeouts.push(Number(this.prepare("PRAGMA busy_timeout").get()!.timeout)); close.call(this); });
	assert.throws(() => store.append(f.input()), /fixture SQLite failure/);
	assert.equal(elapsed, 5000); assert.equal(attempts, 250); assert.deepEqual(timeouts, [5000]);
	t.mock.restoreAll(); assert.equal(store.append(f.input()), "saved");
});

test("WAL preparation locks are retryable; non-lock errors and unexpected mode are not", async (t) => {
	await t.test("prepare lock", (t) => {
		const f = fixture(t), store = f.store();
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"), prepare = DatabaseSync.prototype.prepare;
		let attempts = 0;
		t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) { if (sql === "PRAGMA journal_mode=WAL" && ++attempts === 1) throw sqliteError(6); return prepare.call(this, sql); });
		assert.equal(store.append(f.input()), "saved"); assert.equal(attempts, 2);
	});
	for (const error of [sqliteError(10), sqliteError(11), sqliteError(17), new Error("database is locked"), Object.assign(new Error("locked"), { code: "EACCES", errcode: 5 }), undefined]) await t.test(String(error), (t) => {
		const f = fixture(t), store = f.store(); let attempts = 0;
		t.mock.method(Atomics, "wait", () => assert.fail("non-lock failures cannot retry"));
		interceptWal(t, () => { attempts++; if (error) throw error; return { journal_mode: "delete" }; });
		assert.throws(() => store.append(f.input()), (value: unknown) => error ? value === error : /journal mode/.test(String(value)));
		assert.equal(attempts, 1);
	});
});

test("failed FTS writes/deletions roll back bodies/tombstones; uncertain commits are never replayed", async (t) => {
	await t.test("FTS insert failure", (t) => {
		const f = fixture(t), store = f.store(); store.append(f.input());
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"), prepare = DatabaseSync.prototype.prepare;
		let writes = 0; const error = sqliteError(5);
		t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
			const statement = prepare.call(this, sql);
			if (sql === "INSERT INTO records_fts(rowid,search_text) VALUES(?,?)") t.mock.method(statement, "run", () => { writes++; throw error; });
			return statement;
		});
		// A fresh store prepares the statements under the fault injection.
		const other = f.store(); assert.throws(() => other.append(f.input({ id: "second" })), value => value === error);
		assert.equal(writes, 1); t.mock.restoreAll(); other.close();
		assert.equal(store.stats(f.a).records, 1); assert.equal(other.append(f.input({ id: "second" })), "saved");
	});
	await t.test("delete failure", (t) => {
		const f = fixture(t), store = f.store(); store.append(f.input());
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"), prepare = DatabaseSync.prototype.prepare;
		t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
			const statement = prepare.call(this, sql);
			if (sql.startsWith("DELETE FROM records WHERE")) t.mock.method(statement, "run", () => { throw sqliteError(10); });
			return statement;
		});
		assert.throws(() => store.forgetSession("fixture-session", f.a));
		t.mock.restoreAll(); store.close();
		assert.equal(store.search({ project: f.a, query: "fixture" }).records.length, 1);
		assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, 0);
	});
	await t.test("uncertain commit", (t) => {
		const f = fixture(t), store = f.store();
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"), exec = DatabaseSync.prototype.exec;
		let commits = 0;
		t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) { exec.call(this, sql); if (sql === "COMMIT" && ++commits === 2) throw sqliteError(5); });
		assert.throws(() => store.append(f.input())); assert.equal(commits, 2);
		t.mock.restoreAll(); assert.equal(store.append(f.input()), "duplicate"); assert.equal(store.stats(f.a).records, 1);
	});
});

test("simultaneous writer/deleter/reader processes initialize safely with no resurrection or lost updates", { timeout: 40_000 }, async (t) => {
	const f = fixture(t);
	const script = `const {ArchiveStore}=await import(${JSON.stringify(storeUrl)}); const [agent,project,worker]=process.argv.slice(1); const s=new ArchiveStore(agent);
		const input=(id,sessionId='shared')=>({project,sessionId,lane:'main',entry:{id,parentId:null,type:'message',timestamp:'2026-01-01T00:00:00Z',message:{role:'user',content:'local fixture '+(sessionId==='own-'+worker ? worker : 'shared')}}});
		process.stdout.write('ready\\n'); await new Promise(resolve=>process.stdin.once('data',resolve));
		try { if(worker==='reader') { for(let i=0;i<150;i++) { const page=s.search({project,query:'fixture',limit:50}); if(page.records.some(r=>r.project!==project||r.bytes<=0)) throw new Error('bad snapshot'); } }
		else { for(let i=0;i<80;i++) { s.append(input('shared-'+i)); s.append(input('own-'+worker+'-'+i,'own-'+worker)); s.append(input('forgotten-'+i,'forgotten')); s.forgetSession('forgotten',project); } }
		} finally {s.close(); process.stdin.destroy();} process.stdout.write('done\\n');`;
	const children = ["one", "two", "reader"].map(worker => spawn(process.execPath,
		["--import", "tsx", "--input-type=module", "-e", script, f.agent, f.a, worker], { stdio: ["pipe", "pipe", "pipe"] }));
	t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
	const states = children.map(child => {
		let stdout = "", stderr = "", readyResolve!: () => void;
		const ready = new Promise<void>(resolve => { readyResolve = resolve; });
		child.stdout.on("data", data => { stdout += data; if (stdout.includes("ready\n")) readyResolve(); });
		child.stderr.on("data", data => { stderr += data; });
		const done = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => { readyResolve(); code === 0 ? resolve() : reject(new Error(`worker exit ${code}: ${stderr}`)); }); });
		return { ready, done, output: () => stdout };
	});
	await Promise.all(states.map(state => state.ready)); for (const child of children) child.stdin.end("start\n");
	await Promise.all(states.map(state => state.done)); for (const state of states) assert.match(state.output(), /done/);
	const store = f.store(); assert.equal(store.stats(f.a).records, 240, JSON.stringify(rows(store.path, "SELECT session_id,count(*) AS count FROM records GROUP BY session_id")));
	assert.equal(store.session("shared", f.a, false, 0, 50).nextOffset, 50);
	assert.equal(rows(store.path, "SELECT count(*) AS count FROM tombstones")[0].count, 80);
	for (let i = 0; i < 80; i++) assert.equal(store.append(f.input({ id: `forgotten-${i}`, timestamp: "2026-01-01T00:00:00Z" }, { sessionId: "forgotten" })), "deleted");
	store.close(); assert.equal(store.search({ project: f.a, query: "fixture", limit: 50 }).records.length, 50);
	const db = database(store.path); try { assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal"); assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok"); } finally { db.close(); }
});
