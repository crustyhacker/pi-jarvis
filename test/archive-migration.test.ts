import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { copyArchiveStore } from "../archive-migration.js";
import { openEncryptedArchiveDatabase, type ArchiveDatabase, type ArchiveNativeDatabaseConstructor, type ArchiveSqlValue, type ArchiveStatement } from "../archive-sqlite.js";
import { ArchiveStore, type ArchiveStoreOptions } from "../archive-store.js";
import type { ArchiveInput } from "../archive-types.js";

const require = createRequire(import.meta.url);
const A = "01234567-89ab-4cde-8fab-0123456789ab", B = "fedcba98-7654-4321-9abc-0123456789ab";
const keyA = Buffer.alloc(32, 0x41), keyB = Buffer.alloc(32, 0x42); // Public disposable fixture keys only.
const canary = "migrationfixturecanary";
function nativeAvailable(t: TestContext): boolean {
	try { require.resolve("better-sqlite3-multiple-ciphers"); }
	catch (error) {
		if ((error as { code?: unknown }).code !== "MODULE_NOT_FOUND" || process.env.CI) throw error;
		t.skip("optional encrypted SQLite package is not installed"); return false;
	}
	assert.equal((require("better-sqlite3-multiple-ciphers/package.json") as { version: string }).version, "13.0.3");
	const Constructor = require("better-sqlite3-multiple-ciphers") as ArchiveNativeDatabaseConstructor;
	const db = new Constructor(":memory:", { fileMustExist: false, timeout: 5000 }); db.close(); return true;
}
function plain(path: string, options: { create: boolean }): ArchiveDatabase {
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	return new DatabaseSync(path, { readOnly: !options.create, enableDoubleQuotedStringLiterals: false });
}
// Migration source must be writable for BEGIN IMMEDIATE (no logical source writes).
function writablePlain(path: string): ArchiveDatabase {
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	return new DatabaseSync(path, { enableDoubleQuotedStringLiterals: false });
}
function factory(key?: Buffer): NonNullable<ArchiveStoreOptions["databaseFactory"]> {
	return key ? (path, options) => openEncryptedArchiveDatabase(path, key, options) : path => writablePlain(path);
}
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-jarvis-archive-migration-test-")); fs.chmodSync(root, 0o700);
	const agent = join(root, "agent"), project = join(root, "project"), stores: ArchiveStore[] = [];
	const store = (options: ArchiveStoreOptions = {}, directory = agent) => { const s = new ArchiveStore(directory, options); stores.push(s); return s; };
	t.after(() => { for (const s of stores) s.close(); fs.rmSync(root, { recursive: true, force: true }); });
	const input = (id = "entry", sessionId = "retained", lane: ArchiveInput["lane"] = "main"): ArchiveInput => ({
		project, sessionId, lane, entry: { id, parentId: id === "entry" ? null : "entry", type: "message", timestamp: "2026-01-02T03:04:05.000Z",
			message: { role: "assistant", content: [
				{ type: "thinking", thinking: `${canary} exposed thinking \n😀\u0000`, thinkingSignature: "rawonlyfixturesignature" },
				{ type: "toolCall", name: "fixture_tool", arguments: { detail: canary.repeat(40) } },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			] }, number: 1, unknown: { exact: true } },
	});
	return { root, agent, project, store, input };
}
function inspect(store: ArchiveStore, key?: Buffer) {
	const db = key ? openEncryptedArchiveDatabase(store.path, key) : plain(store.path, { create: false });
	try {
		return {
			records: db.prepare("SELECT CAST(rowid AS TEXT) AS preserved_rowid,* FROM records ORDER BY rowid").all().map(row => ({ ...row })),
			tombstones: db.prepare("SELECT CAST(rowid AS TEXT) AS preserved_rowid,* FROM tombstones ORDER BY rowid").all().map(row => ({ ...row })),
		};
	} finally { db.close(); }
}
function hashFile(path: string): string { return createHash("sha256").update(fs.readFileSync(path)).digest("hex"); }
function readAll(store: ArchiveStore, id: string, project: string): string {
	let offset = 0, result = "";
	for (;;) { const page = store.read(id, project, false, offset, 41)!; result += page.content; if (page.nextOffset === null) return result; offset = page.nextOffset; }
}
function populate(f: ReturnType<typeof fixture>, source: ArchiveStore, key?: Buffer): void {
	for (const [id, session, lane] of [["entry", "retained", "main"], ["second", "retained", "jarvis"], ["third", "other", "import"], ["forgotten", "deleted", "import"]] as const) source.append(f.input(id, session, lane));
	assert.equal(source.forgetSession("deleted", f.project), 1); source.close();
	const db = key ? openEncryptedArchiveDatabase(source.path, key) : writablePlain(source.path);
	try {
		db.exec("BEGIN IMMEDIATE");
		// Legal unusual rowids and raw JSON serialization: never renormalize them.
		db.prepare("UPDATE records SET rowid=-7 WHERE entry_id='entry'").run();
		db.prepare("UPDATE records SET rowid=73 WHERE entry_id='third'").run();
		db.prepare("UPDATE tombstones SET rowid=59").run();
		const raw = String(db.prepare("SELECT raw_json FROM records WHERE entry_id='entry'").get()!.raw_json).replace('"number":1,', '"number":1e+0,');
		const exact = ` \n${raw}\n `;
		db.prepare("UPDATE records SET raw_json=?,bytes=?,characters=length(?) WHERE entry_id='entry'").run(exact, Buffer.byteLength(exact), exact);
		db.prepare("INSERT INTO records_fts(records_fts) VALUES('rebuild')").run();
		db.exec("COMMIT");
	} finally { db.close(); }
}
type Report = Error & { partial: { records: number; tombstones: number }; commit: string; rollbackFailed: boolean; closeFailed: boolean };
function report(error: unknown, commit = "not-attempted"): error is Report {
	assert.ok(error instanceof Error); assert.equal(error.name, "ArchiveMigrationError");
	assert.equal((error as Report).commit, commit); assert.equal(error.cause, undefined);
	assert.doesNotMatch(error.message, /fixturecanary|synthetic secret|SQLITE|\/tmp\//);
	return true;
}
function proxy(db: ArchiveDatabase, hook: { exec?: (sql: string, run: () => void) => void; run?: (sql: string, values: ArchiveSqlValue[], run: () => ReturnType<ArchiveStatement["run"]>) => ReturnType<ArchiveStatement["run"]>; close?: () => void }): ArchiveDatabase {
	return {
		exec(sql) { if (hook.exec) hook.exec(sql, () => db.exec(sql)); else db.exec(sql); },
		close() { db.close(); hook.close?.(); },
		prepare(sql) {
			const statement = db.prepare(sql);
			return { get: (...values) => statement.get(...values), all: (...values) => statement.all(...values), run(...values) {
				return (hook.run ? hook.run(sql, values, () => statement.run(...values)) : statement.run(...values)) as ReturnType<typeof statement.run>;
			} };
		},
	};
}

test("managed options are strict, constructors remain lazy, and default four-file allowlist is unchanged", (t) => {
	const f = fixture(t);
	for (const options of [{ storageId: A }, { managed: false, storageId: A }, { managed: true, storageId: A.toUpperCase() }, { managed: true, storageId: "../outside" }, { managed: true, storageId: "01234567-89ab-1cde-8fab-0123456789ab" }, { managed: true, storageId: "01234567-89ab-4cde-7fab-0123456789ab" }, { managed: "true" }, { guard: 1 }]) assert.throws(() => f.store(options as ArchiveStoreOptions), /managed storage/);
	const managed = f.store({ managed: true, storageId: A, databaseFactory: () => { throw new Error("must stay lazy"); } });
	assert.equal(managed.path, join(f.agent, "extensions", "pi-jarvis-archive", "vaults", A, "archive.sqlite"));
	assert.deepEqual(managed.stats(f.project), { records: 0, bytes: 0 }); assert.equal(fs.existsSync(f.agent), false);
	fs.mkdirSync(join(f.agent, "extensions", "pi-jarvis-archive", "vaults"), { recursive: true });
	fs.writeFileSync(join(f.agent, "extensions", "pi-jarvis-archive", "archive.vault.json"), "fixture metadata owned by caller");
	assert.throws(() => f.store().stats(f.project), /storage entry/);
	assert.deepEqual(f.store({ managed: true }).stats(f.project), { records: 0, bytes: 0 });
});

for (const [label, sourceKey, targetKey] of [["plain -> encrypted", undefined, keyA], ["encrypted -> plain", keyA, undefined], ["encrypted -> encrypted", keyA, keyB]] as const) {
	test(`${label}: exact raw/index/provenance/rowids/tombstones, rebuilt FTS and unchanged source`, async t => {
		if (!nativeAvailable(t)) return;
		const f = fixture(t), source = f.store({ managed: true, storageId: sourceKey ? A : undefined, databaseFactory: factory(sourceKey) });
		populate(f, source, sourceKey);
		const original = inspect(source, sourceKey), originalHash = hashFile(source.path);
		const archive = join(f.agent, "extensions", "pi-jarvis-archive");
		fs.writeFileSync(join(archive, "archive.vault.json"), "caller transition fixture", { mode: 0o600 });
		fs.writeFileSync(join(archive, "archive.vault.lock"), "caller lock fixture", { mode: 0o600 });
		const target = f.store({ managed: true, storageId: B, databaseFactory: factory(targetKey) });
		let checks = 0;
		const originalParse = JSON.parse;
		t.mock.method(JSON, "parse", (text: string, ...args: Parameters<typeof JSON.parse> extends [string, ...infer Rest] ? Rest : never) => {
			assert.ok(!text.includes(canary), "migration must not parse raw JSON"); return originalParse(text, ...args);
		});
		assert.deepEqual(await copyArchiveStore(source, target, () => { checks++; }), { records: 3, tombstones: 1 });
		t.mock.restoreAll(); assert.ok(checks > 50);
		assert.deepEqual(inspect(target, targetKey), original); assert.deepEqual(inspect(source, sourceKey), original); assert.equal(hashFile(source.path), originalHash);
		const matches = target.search({ project: f.project, query: canary }).records;
		assert.equal(matches.length, 3); assert.equal(target.search({ project: f.project, query: "rawonlyfixturesignature" }).records.length, 0);
		const first = matches.find(row => row.entryId === "entry")!;
		const exact = original.records.find(row => row.entry_id === "entry")!.raw_json as string;
		assert.equal(readAll(target, first.id, f.project), exact);
		// A complete page must preserve legal noncanonical JSON too, rather than
		// rejecting whitespace/exponent spelling that tiny-page reads accept.
		assert.equal(target.read(first.id, f.project)!.content, exact);
		assert.equal(target.read(first.id, f.project, false, 0, [...exact].length)!.content, exact);
		assert.equal(target.read(first.id, f.project)!.nextOffset, null);
		assert.equal(target.append(f.input("forgotten", "deleted", "import")), "deleted"); target.close();
		assert.equal(fs.statSync(dirname(target.path)).mode & 0o777, 0o700); assert.equal(fs.statSync(target.path).mode & 0o777, 0o600);
		if (targetKey) { const bytes = fs.readFileSync(target.path); assert.equal(bytes.includes(Buffer.from(canary)), false); assert.equal(bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")), false); }
	});
}

for (const encrypted of [false, true]) test(`absent source initializes durable empty ${encrypted ? "encrypted" : "plain"} target without creating source`, async t => {
	if (encrypted && !nativeAvailable(t)) return;
	const f = fixture(t), source = f.store({ managed: true, databaseFactory: () => { throw new Error("absent source must not open"); } }, join(f.root, "absent-agent"));
	const target = f.store({ managed: true, storageId: B, databaseFactory: factory(encrypted ? keyB : undefined) });
	assert.deepEqual(await copyArchiveStore(source, target, () => {}), { records: 0, tombstones: 0 });
	assert.equal(fs.existsSync(dirname(dirname(dirname(source.path)))), false);
	assert.deepEqual(inspect(target, encrypted ? keyB : undefined), { records: [], tombstones: [] });
});

for (const phase of ["factory", "initialization"] as const) test(`close uncertainty during ${phase} failure survives before the target store returns`, async t => {
	const f = fixture(t), source = f.store({ managed: true }); populate(f, source);
	let leaked: ArchiveDatabase | undefined, closeAttempts = 0;
	const target = f.store({ managed: true, storageId: B, databaseFactory(path) {
		const db = writablePlain(path); leaked = db;
		if (phase === "factory") {
			closeAttempts++;
			throw Object.assign(new Error("synthetic secret initialization/close failure"), { closeFailed: true });
		}
		return {
			exec: sql => db.exec(sql),
			prepare: () => { throw new Error("synthetic secret schema failure"); },
			close: () => { closeAttempts++; throw new Error("synthetic secret close failure"); },
		};
	} });
	try {
		await assert.rejects(copyArchiveStore(source, target, () => {}), error => {
			report(error); assert.equal((error as Report).closeFailed, true); return true;
		});
		assert.equal(closeAttempts, 1, "uncertain native close cannot be replayed by cleanup");
		assert.equal(leaked!.prepare("SELECT 1 AS still_open").get()!.still_open, 1);
		assert.equal(fs.existsSync(target.path), true);
	} finally { leaked?.close(); }
});

test("zero-record/tombstone target is reusable, but nonempty records or tombstones refuse without changes", async t => {
	for (const kind of ["empty", "records", "tombstones"]) {
		const f = fixture(t), source = f.store({ managed: true }); populate(f, source);
		const before = inspect(source), target = f.store({ managed: true, storageId: B });
		target.append(f.input("target-fixture", "target"));
		if (kind !== "records") target.forgetSession("target", f.project);
		target.close();
		if (kind === "empty") { const db = writablePlain(target.path); db.exec("DELETE FROM tombstones"); db.close(); }
		const targetBefore = inspect(target);
		if (kind === "empty") assert.deepEqual(await copyArchiveStore(source, target, () => {}), { records: 3, tombstones: 1 });
		else { await assert.rejects(copyArchiveStore(source, target, () => {}), error => report(error)); assert.deepEqual(inspect(target), targetBefore); }
		assert.deepEqual(inspect(source), before);
	}
});

test("same canonical path, including a legacy root alias, refuses before a second database open", async t => {
	const f = fixture(t), source = f.store(); source.append(f.input()); source.close(); const before = inspect(source);
	fs.symlinkSync(f.agent, join(f.root, "alias"), "dir");
	const target = f.store({ databaseFactory: () => { throw new Error("same target must never open"); } }, join(f.root, "alias"));
	await assert.rejects(copyArchiveStore(source, target, () => {}), error => report(error)); assert.deepEqual(inspect(source), before);
});

for (const failure of ["FTS insert", "cancel", "rollback failure", "verify hash", "target FTS mismatch", "uncertain commit"]) test(`${failure}: no retry, generic partial report and source unchanged`, async t => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t), source = f.store({ managed: true }); populate(f, source); const before = inspect(source), sourceHash = hashFile(source.path);
	let indexWrites = 0, commits = 0, canceled = false, copying = false;
	const target = f.store({ managed: true, storageId: B, databaseFactory(path, options) {
		return proxy(openEncryptedArchiveDatabase(path, keyB, options), {
			exec(sql, run) {
				if (sql === "ROLLBACK" && failure === "rollback failure" && copying) throw new Error("synthetic secret rollback failure");
				if (sql === "COMMIT" && copying) { commits++; run(); if (failure === "uncertain commit") throw new Error("synthetic secret uncertain commit"); return; }
				run();
			},
			run(sql, values, run) {
				if (sql.startsWith("INSERT INTO records(rowid")) {
					copying = true;
					if (failure === "verify hash") { values[15] = "changed fixture excerpt"; }
				}
				if (sql.startsWith("INSERT INTO records_fts(rowid")) {
					indexWrites++;
					if (failure === "target FTS mismatch") values[1] = `${values[1]} injectedfixtureword`;
					if (indexWrites === 2 && ["FTS insert", "rollback failure"].includes(failure)) throw new Error("synthetic secret FTS failure");
					const result = run(); if (failure === "cancel" && indexWrites === 1) setImmediate(() => { canceled = true; }); return result;
				}
				return run();
			},
		});
	} });
	await assert.rejects(copyArchiveStore(source, target, () => { if (canceled) throw new Error("synthetic secret canceled"); }), error => {
		assert.ok(report(error, failure === "uncertain commit" ? "uncertain" : "not-attempted"));
		assert.equal(error.rollbackFailed, ["rollback failure", "uncertain commit"].includes(failure));
		assert.equal(error.partial.records, ["FTS insert", "cancel", "rollback failure"].includes(failure) ? 1 : 3); return true;
	});
	assert.equal(commits, failure === "uncertain commit" ? 1 : 0); assert.equal(indexWrites, failure === "cancel" ? 1 : ["FTS insert", "rollback failure"].includes(failure) ? 2 : 3);
	assert.deepEqual(inspect(source), before); assert.equal(hashFile(source.path), sourceHash);
	assert.equal(inspect(target, keyB).records.length, failure === "uncertain commit" ? 3 : 0);
});

test("guard brackets every store/migration SQL and post-BEGIN revocation rolls back before write action", async t => {
	const f = fixture(t); let epoch = 0, lastSqlEpoch = -1, armed = false, denied = false, inserts = 0, rollbacks = 0;
	const guard = () => { epoch++; if (denied) throw new Error("synthetic secret obsolete revision"); };
	const source = f.store({ managed: true, guard, databaseFactory(path) {
		const db = writablePlain(path);
		const sqlBoundary = () => { assert.ok(epoch > lastSqlEpoch, "SQL without a fresh guard check"); lastSqlEpoch = epoch; };
		return {
			exec(sql) { sqlBoundary(); db.exec(sql); if (sql === "BEGIN IMMEDIATE" && armed) denied = true; if (sql === "ROLLBACK") rollbacks++; },
			close() { db.close(); },
			prepare(sql) { sqlBoundary(); const stmt = db.prepare(sql); return {
				get(...args) { sqlBoundary(); return stmt.get(...args); }, all(...args) { sqlBoundary(); return stmt.all(...args); },
				run(...args) { sqlBoundary(); if (sql.startsWith("INSERT INTO records(")) inserts++; return stmt.run(...args); },
			}; },
		};
	} });
	source.append(f.input()); const beforeInserts = inserts;
	armed = true;
	assert.throws(() => source.append(f.input("must-not-write")), /obsolete revision/);
	assert.equal(rollbacks, 1); assert.equal(inserts, beforeInserts);
	armed = false; denied = false;
	assert.equal(source.stats(f.project).records, 1);
	const target = f.store({ managed: true, storageId: B, guard });
	assert.deepEqual(await copyArchiveStore(source, target, guard), { records: 1, tombstones: 0 });
});

test("store guard before commit rolls back a staged record; undefined guard preserves legacy behavior", t => {
	const f = fixture(t); let denied = false, armed = false, commits = 0;
	const s = f.store({ guard: () => { if (denied) throw new Error("revision changed"); }, databaseFactory(path) {
		return proxy(writablePlain(path), { exec(sql, run) { if (sql === "COMMIT" && armed) commits++; run(); }, run(sql, _values, run) {
			const result = run(); if (armed && sql.startsWith("INSERT INTO records_fts(rowid")) denied = true; return result;
		} });
	} });
	s.append(f.input()); armed = true;
	assert.throws(() => s.append(f.input("second")), /revision changed/); assert.equal(commits, 0);
	denied = false; armed = false; assert.equal(s.stats(f.project).records, 1);
});

test("target checkpoint and native close precede all fsync descriptors; durability failure is not success/retry", async t => {
	for (const fail of [false, true]) {
		const f = fixture(t), source = f.store({ managed: true }); populate(f, source);
		let live = false, opened = false, checkpoint = false, commits = 0, copying = false, fsyncs = 0;
		const target = f.store({ managed: true, storageId: B, databaseFactory(path) {
			opened = live = true;
			return proxy(writablePlain(path), {
				exec(sql, run) { if (sql === "COMMIT" && copying) commits++; run(); }, close() { live = false; },
				run(sql, _values, run) { if (sql.startsWith("INSERT INTO records(rowid")) copying = true; return run(); },
			});
		} });
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
		const prepare = DatabaseSync.prototype.prepare;
		t.mock.method(DatabaseSync.prototype, "prepare", function(this: InstanceType<typeof DatabaseSync>, sql: string) { if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") checkpoint = true; return prepare.call(this, sql); });
		const originalOpen = fs.openSync, originalSync = fs.fsyncSync;
		fs.openSync = ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
			if (opened && String(path) === target.path) { assert.equal(live, false, "extra file FD on live SQLite"); assert.equal(checkpoint, true); }
			return originalOpen(path, flags, mode);
		}) as typeof fs.openSync;
		fs.fsyncSync = fd => { assert.equal(live, false); assert.equal(checkpoint, true); fsyncs++; if (fail) throw new Error("synthetic secret fsync failure"); originalSync(fd); };
		syncBuiltinESMExports();
		try {
			if (fail) await assert.rejects(copyArchiveStore(source, target, () => {}), error => report(error, "committed"));
			else assert.deepEqual(await copyArchiveStore(source, target, () => {}), { records: 3, tombstones: 1 });
		} finally { fs.openSync = originalOpen; fs.fsyncSync = originalSync; syncBuiltinESMExports(); t.mock.restoreAll(); }
		assert.ok(fsyncs > 0); assert.equal(commits, 1); assert.equal(live, false); assert.equal(inspect(target).records.length, 3);
	}
});

for (const corruption of ["bytes", "characters", "invalid JSON", "raw provenance", "raw budget", "index budget", "invalid UTF-8 index", "invalid UTF-8 metadata", "oversized metadata", "unsafe rowid", "tombstone time", "source FTS", "schema", "version"]) test(`source ${corruption} rejects without publishing or changing source`, async t => {
	const f = fixture(t), source = f.store({ managed: true }); populate(f, source);
	const db = writablePlain(source.path);
	try {
		db.exec("PRAGMA ignore_check_constraints=ON");
		if (corruption === "bytes") db.exec("UPDATE records SET bytes=1 WHERE entry_id='entry'");
		if (corruption === "characters") db.exec("UPDATE records SET characters=1 WHERE entry_id='entry'");
		if (corruption === "invalid JSON") db.exec("UPDATE records SET raw_json='x',bytes=1,characters=1 WHERE entry_id='entry'");
		if (corruption === "raw provenance") { const raw = String(db.prepare("SELECT raw_json FROM records WHERE entry_id='entry'").get()!.raw_json).replace('"id":"entry"', '"id":"wrong"'); db.prepare("UPDATE records SET raw_json=?,bytes=?,characters=length(?) WHERE entry_id='entry'").run(raw, Buffer.byteLength(raw), raw); }
		if (corruption === "raw budget") db.exec("UPDATE records SET raw_json=CAST(zeroblob(67108865) AS TEXT),bytes=67108865,characters=1 WHERE entry_id='entry'");
		if (corruption === "index budget") db.exec("UPDATE records SET search_text=CAST(zeroblob(67108865) AS TEXT) WHERE entry_id='entry'");
		if (corruption === "invalid UTF-8 index") db.exec("UPDATE records SET search_text=CAST(x'ff' AS TEXT) WHERE entry_id='entry'");
		if (corruption === "invalid UTF-8 metadata") db.exec("UPDATE records SET excerpt=CAST(x'ff' AS TEXT) WHERE entry_id='entry'");
		if (corruption === "oversized metadata") db.exec("UPDATE records SET parent_id=printf('%1024s','x') WHERE entry_id='entry'");
		if (corruption === "unsafe rowid") db.exec("UPDATE records SET rowid=9007199254740993 WHERE entry_id='entry'");
		if (corruption === "tombstone time") db.exec("UPDATE tombstones SET deleted_at=0");
		if (corruption === "version") db.exec("PRAGMA user_version=7");
		if (corruption === "source FTS") db.exec("INSERT INTO records_fts(records_fts,rowid,search_text) SELECT 'delete',rowid,search_text FROM records WHERE entry_id='entry'");
		if (corruption === "schema") db.exec("CREATE TABLE unexpected(secret TEXT)");
	} finally { db.close(); }
	const before = inspect(source), originalHash = hashFile(source.path), target = f.store({ managed: true, storageId: B });
	await assert.rejects(copyArchiveStore(source, target, () => {}), error => report(error));
	assert.deepEqual(inspect(source), before); assert.equal(hashFile(source.path), originalHash);
	if (fs.existsSync(target.path)) assert.equal(inspect(target).records.length, 0);
});

for (const attack of ["root link", "extensions link", "archive link", "vaults link", "generation link", "metadata link", "metadata hardlink", "metadata directory", "lock link", "lock hardlink", "lock directory", "metadata owner", "extra root file", "extra generation file", "SQLite link", "SQLite hardlink", "orphan auxiliary", "replaced directory"]) test(`managed path rejects ${attack}`, async t => {
	const f = fixture(t), archive = join(f.agent, "extensions", "pi-jarvis-archive"), generation = join(archive, "vaults", B);
	fs.mkdirSync(generation, { recursive: true });
	const outside = join(f.root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "file"), "fixture");
	const source = f.store({ managed: true }, join(f.root, "absent-agent")), target = f.store({ managed: true, storageId: B });
	if (attack.endsWith(" link") && !/^(metadata|lock|SQLite)/.test(attack)) {
		const path = attack === "root link" ? f.agent : attack === "extensions link" ? join(f.agent, "extensions") : attack === "archive link" ? archive : attack === "vaults link" ? join(archive, "vaults") : generation;
		fs.rmSync(path, { recursive: true }); fs.symlinkSync(outside, path, "dir");
	}
	if (attack === "metadata link") fs.symlinkSync(join(outside, "file"), join(archive, "archive.vault.json"));
	if (attack === "metadata hardlink") fs.linkSync(join(outside, "file"), join(archive, "archive.vault.json"));
	if (attack === "metadata directory") fs.mkdirSync(join(archive, "archive.vault.json"));
	if (attack === "lock link") fs.symlinkSync(join(outside, "file"), join(archive, "archive.vault.lock"));
	if (attack === "lock hardlink") fs.linkSync(join(outside, "file"), join(archive, "archive.vault.lock"));
	if (attack === "lock directory") fs.mkdirSync(join(archive, "archive.vault.lock"));
	if (attack === "metadata owner") {
		const path = join(archive, "archive.vault.json"); fs.writeFileSync(path, "fixture"); const original = fs.lstatSync;
		t.mock.method(fs, "lstatSync", ((name: fs.PathLike, options?: never) => { const info = original(name, options); if (String(name) === path) Object.assign(info, { uid: typeof process.getuid === "function" ? process.getuid() + 1 : -1 }); return info; }) as typeof fs.lstatSync);
		syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		if (typeof process.getuid !== "function") { t.skip("POSIX ownership check"); return; }
	}
	if (attack === "extra root file") fs.writeFileSync(join(archive, "arbitrary.json"), "fixture");
	if (attack === "extra generation file") fs.writeFileSync(join(generation, "arbitrary.sqlite"), "fixture");
	if (attack === "SQLite link") fs.symlinkSync(join(outside, "file"), target.path);
	if (attack === "SQLite hardlink") fs.linkSync(join(outside, "file"), target.path);
	if (attack === "orphan auxiliary") fs.writeFileSync(target.path + "-wal", "orphan fixture");
	if (attack === "replaced directory") { assert.equal(target.stats(f.project).records, 0); fs.renameSync(join(archive, "vaults"), join(f.root, "old-vaults")); fs.mkdirSync(generation, { recursive: true }); }
	await assert.rejects(copyArchiveStore(source, target, () => {}), error => report(error));
	assert.equal(fs.readFileSync(join(outside, "file"), "utf8"), "fixture");
});

test("cancellation during target verification rolls back all staged records/tombstones", async t => {
	const f = fixture(t), source = f.store({ managed: true }); populate(f, source); const before = inspect(source);
	let canceled = false, commits = 0, copying = false, verifying = false;
	const target = f.store({ managed: true, storageId: B, databaseFactory(path) {
		const db = writablePlain(path);
		return {
			exec(sql) { if (sql === "COMMIT" && copying) commits++; db.exec(sql); }, close() { db.close(); },
			prepare(sql) {
				const statement = db.prepare(sql);
				return { all: (...values) => statement.all(...values), run(...values) { if (sql.startsWith("INSERT INTO records(rowid")) copying = true; return statement.run(...values); }, get(...values) {
					const result = statement.get(...values);
					if (sql.startsWith("SELECT CAST(raw_json AS BLOB)")) { verifying = true; setImmediate(() => { canceled = true; }); }
					return result;
				} };
			},
		};
	} });
	await assert.rejects(copyArchiveStore(source, target, () => { if (canceled) throw new Error("fixture canceled"); }), error => {
		assert.ok(report(error)); assert.deepEqual(error.partial, { records: 3, tombstones: 1 }); return true;
	});
	assert.equal(verifying, true); assert.equal(commits, 0); assert.deepEqual(inspect(target), { records: [], tombstones: [] }); assert.deepEqual(inspect(source), before);
});

for (const failure of ["checkpoint", "source close", "target close"]) test(`${failure} failure after commit never fsyncs or reports success; close/commit are not retried`, async t => {
	const f = fixture(t), writer = f.store({ managed: true }); populate(f, writer); const before = inspect(writer);
	let sourceCloses = 0, targetCloses = 0, commits = 0, copying = false, fsyncAttempts = 0;
	const source = f.store({ managed: true, databaseFactory(path) {
		const db = writablePlain(path); return proxy(db, { close() { sourceCloses++; if (failure === "source close") throw new Error("synthetic secret close failure"); } });
	} });
	const target = f.store({ managed: true, storageId: B, databaseFactory(path) {
		const db = writablePlain(path);
		const wrapped = proxy(db, { close() { targetCloses++; if (failure === "target close") throw new Error("synthetic secret close failure"); }, exec(sql, run) { if (sql === "COMMIT" && copying) commits++; run(); }, run(sql, _values, run) { if (sql.startsWith("INSERT INTO records(rowid")) copying = true; return run(); } });
		return { exec: sql => wrapped.exec(sql), close: () => wrapped.close(), prepare(sql) {
			const stmt = wrapped.prepare(sql);
			if (failure !== "checkpoint" || sql !== "PRAGMA wal_checkpoint(TRUNCATE)") return stmt;
			return { run: (...values) => stmt.run(...values), all: (...values) => stmt.all(...values), get() { return { busy: 1, log: 3, checkpointed: 0 }; } };
		} };
	} });
	t.mock.method(target, "migrationSync", () => { fsyncAttempts++; });
	await assert.rejects(copyArchiveStore(source, target, () => {}), error => {
		assert.ok(report(error, "committed")); assert.equal(error.closeFailed, failure.includes("close")); return true;
	});
	assert.equal(commits, 1); assert.equal(sourceCloses, 1); assert.equal(targetCloses, 1); assert.equal(fsyncAttempts, 0); assert.deepEqual(inspect(source), before); assert.equal(inspect(target).records.length, 3);
});

test("durability fsync includes all recursively-created root ancestors after target close", async t => {
	const f = fixture(t), source = f.store({ managed: true }, join(f.root, "absent-agent"));
	const first = join(f.root, "created-first"), second = join(first, "created-second"), agent = join(second, "created-agent");
	const target = f.store({ managed: true, storageId: B }, agent);
	const paths: string[] = [], original = fs.fsyncSync;
	fs.fsyncSync = fd => { paths.push(fs.realpathSync(`/proc/self/fd/${fd}`)); original(fd); };
	syncBuiltinESMExports();
	try {
		if (process.platform !== "linux") { t.skip("Linux fixture FD identity observation"); return; }
		assert.deepEqual(await copyArchiveStore(source, target, () => {}), { records: 0, tombstones: 0 });
	} finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
	for (const path of [target.path, dirname(target.path), dirname(dirname(target.path)), join(agent, "extensions", "pi-jarvis-archive"), join(agent, "extensions"), agent, second, first, f.root]) assert.ok(paths.includes(path), `missing durability fsync for ${path}`);
});
