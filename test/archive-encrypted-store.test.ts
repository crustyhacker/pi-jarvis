import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { openEncryptedArchiveDatabase, type ArchiveDatabase, type ArchiveNativeDatabaseConstructor } from "../archive-sqlite.js";
import { ArchiveStore, type ArchiveStoreOptions } from "../archive-store.js";
import type { ArchiveInput } from "../archive-types.js";

const require = createRequire(import.meta.url);
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
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-jarvis-encrypted-store-test-")); fs.chmodSync(root, 0o700);
	const agent = join(root, "agent"), project = join(root, "project"), key = randomBytes(32), stores: ArchiveStore[] = [];
	const calls: { path: string; create: boolean }[] = [];
	const factory: NonNullable<ArchiveStoreOptions["databaseFactory"]> = (path, options) => {
		calls.push({ path, create: options.create });
		return openEncryptedArchiveDatabase(path, key, options);
	};
	const store = (databaseFactory = factory, directory = agent) => { const value = new ArchiveStore(directory, { databaseFactory }); stores.push(value); return value; };
	t.after(() => { for (const s of stores) s.close(); key.fill(0); fs.rmSync(root, { recursive: true, force: true }); });
	const input = (entry: Partial<ArchiveInput["entry"]> = {}, patch: Partial<Omit<ArchiveInput, "entry">> = {}): ArchiveInput => ({
		project, sessionId: "encrypted-fixture-session", lane: "main", ...patch,
		entry: { id: "encrypted-fixture-entry", type: "message", parentId: null, timestamp: "2026-01-02T03:04:05.000Z",
			message: { role: "assistant", content: "encryptedfixturecanaryreference" }, ...entry },
	});
	return { root, agent, project, key, calls, factory, store, input };
}
function readAll(store: ArchiveStore, id: string, project: string): string {
	let offset = 0, content = "";
	for (;;) {
		const page = store.read(id, project, false, offset, 53)!; content += page.content;
		if (page.nextOffset === null) return content;
		assert.ok(page.nextOffset > offset); offset = page.nextOffset;
	}
}
function scan(directory: string, canary: string) {
	const script = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const [directory,canary]=process.argv.slice(1);
		console.log(JSON.stringify(fs.readdirSync(directory).map(name=>{const data=fs.readFileSync(path.join(directory,name));return {name,size:data.length,hash:crypto.createHash('sha256').update(data).digest('hex'),plaintext:data.includes(Buffer.from(canary)),header:data.subarray(0,16).equals(Buffer.from('SQLite format 3\\0'))};})));`;
	const child = spawnSync(process.execPath, ["-e", script, directory, canary], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout) as { name: string; size: number; hash: string; plaintext: boolean; header: boolean }[];
}

test("ArchiveStore custom factory remains lazy; absent reads never open or create encryption backend", (t) => {
	const f = fixture(t), store = f.store();
	store.close(); assert.deepEqual(store.search({ project: f.project }), { records: [], nextOffset: null });
	assert.deepEqual(store.stats(f.project), { records: 0, bytes: 0 });
	assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.agent), false);
});

test("encrypted ArchiveStore exact schema matches node:sqlite, full raw read and FTS preserve exposed data", (t) => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t), store = f.store(), canary = "encryptedfixturecanaryreference";
	const input = f.input({ message: { role: "assistant", content: [
		{ type: "thinking", thinking: `${canary} exposed reasoning`, thinkingSignature: "rawonlyfixturesignature" },
		{ type: "toolCall", id: "fixture-tool", name: "fixture_tool", arguments: { detail: `${canary} \n\u0000 😀`, large: canary.repeat(300) } },
		{ type: "image", data: "ZmFrZWZpeHR1cmVpbWFnZQ==", mimeType: "image/png" },
	] }, custom: { retained: true } });
	assert.equal(store.append(input), "saved");
	const record = store.session(input.sessionId, f.project).records[0];
	assert.equal(readAll(store, record.id, f.project), JSON.stringify(input.entry));
	assert.equal(store.search({ project: f.project, query: canary }).records.length, 1);
	assert.equal(store.search({ project: f.project, query: "rawonlyfixturesignature" }).records.length, 0);
	assert.deepEqual(store.stats(f.project), { records: 1, bytes: Buffer.byteLength(JSON.stringify(input.entry)) });
	assert.equal(f.calls.length, 1); assert.equal(f.calls[0].create, true);
	assert.equal(fs.statSync(dirname(store.path)).mode & 0o777, 0o700);
	for (const suffix of ["", "-wal", "-shm"]) assert.equal(fs.statSync(store.path + suffix).mode & 0o777, 0o600);
	const files = scan(dirname(store.path), canary);
	assert.ok(files.some(file => file.name.endsWith("-wal") && file.size > 0));
	assert.ok(files.every(file => !file.plaintext && !file.header));
	store.close();
	const encrypted = openEncryptedArchiveDatabase(store.path, f.key);
	const encryptedSchema = encrypted.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all().map(row => String(row.sql).replace(/\s+/g, " ").trim()).sort(); encrypted.close();
	const plain = new ArchiveStore(join(f.root, "plaintext-fixture-agent"));
	try {
		plain.append(input); plain.close();
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
		const db = new DatabaseSync(plain.path, { readOnly: true });
		try { const plainSchema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all().map(row => String(row.sql).replace(/\s+/g, " ").trim()).sort(); assert.deepEqual(encryptedSchema, plainSchema); }
		finally { db.close(); }
	} finally { plain.close(); }
	const reader = f.store(); assert.equal(readAll(reader, record.id, f.project), JSON.stringify(input.entry));
	assert.equal(f.calls.at(-1)?.create, false);
});

test("encrypted dedup, conflicting payload rejection, tombstones, session forget and prune match plain store semantics", (t) => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t), store = f.store(), input = f.input();
	assert.equal(store.append(input), "saved");
	assert.equal(store.append(input), "duplicate");
	assert.equal(store.append({ ...input, lane: "import" }), "duplicate");
	assert.throws(() => store.append(f.input({ message: { role: "assistant", content: "changed encrypted fixture" } })), /conflicting serialized payload/);
	assert.equal(store.stats(f.project).records, 1);
	assert.equal(store.forgetSession(input.sessionId, f.project), 1);
	assert.equal(store.append(input), "deleted");
	assert.equal(store.search({ project: f.project, query: "encryptedfixturecanaryreference" }).records.length, 0);
	const older = f.input({ id: "older", timestamp: "2025-01-01T00:00:00Z" }, { sessionId: "older-session" });
	assert.equal(store.append(older), "saved"); assert.equal(store.prune("2025-12-31T00:00:00Z", f.project), 1);
	assert.equal(store.append(older), "deleted");
	store.close(); const reopened = f.store();
	assert.equal(reopened.append(input), "deleted"); assert.equal(reopened.append(older), "deleted");
	assert.deepEqual(reopened.stats(f.project), { records: 0, bytes: 0 });
});

test("FTS failure rolls back encrypted transaction without uncertain record-write replay", (t) => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t); let fail = true, indexWrites = 0;
	const store = f.store((path, options): ArchiveDatabase => {
		const db = f.factory(path, options);
		return { exec: sql => db.exec(sql), close: () => db.close(), prepare(sql) {
			const statement = db.prepare(sql);
			if (!sql.startsWith("INSERT INTO records_fts(rowid")) return statement;
			return { get: (...values) => statement.get(...values), all: (...values) => statement.all(...values), run(...values) {
				indexWrites++; if (fail) throw Object.assign(new Error("synthetic FTS storage failure"), { code: "SQLITE_BUSY" });
				return statement.run(...values);
			} };
		} };
	});
	assert.throws(() => store.append(f.input()), /synthetic FTS storage failure/); assert.equal(indexWrites, 1);
	assert.deepEqual(store.stats(f.project), { records: 0, bytes: 0 });
	assert.equal(store.search({ project: f.project, query: "encryptedfixturecanaryreference" }).records.length, 0);
	fail = false; assert.equal(store.append(f.input()), "saved"); assert.equal(indexWrites, 2);
	assert.equal(store.stats(f.project).records, 1);
});

test("native BUSY startup classification retries only idempotent WAL upgrade", (t) => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t); let attempts = 0;
	const store = f.store((path, options): ArchiveDatabase => {
		const db = f.factory(path, options);
		return { exec: sql => db.exec(sql), close: () => db.close(), prepare(sql) {
			const statement = db.prepare(sql);
			if (sql !== "PRAGMA journal_mode=WAL") return statement;
			return { run: (...values) => statement.run(...values), all: (...values) => statement.all(...values), get(...values) {
				attempts++; if (attempts === 1) throw Object.assign(new Error("synthetic native busy"), { code: "SQLITE_BUSY", errcode: 5 });
				return statement.get(...values);
			} };
		} };
	});
	assert.equal(store.append(f.input()), "saved"); assert.equal(attempts, 2); assert.equal(store.stats(f.project).records, 1);
});

test("wrong encrypted key never initializes, changes source bytes, or falls back to plaintext", (t) => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t), writer = f.store(); writer.append(f.input()); writer.close();
	const before = scan(dirname(writer.path), "encryptedfixturecanaryreference");
	const wrong = randomBytes(32), rejected = f.store((path, options) => openEncryptedArchiveDatabase(path, wrong, options));
	assert.throws(() => rejected.stats(f.project), error => {
		assert.ok(error instanceof Error); assert.match(error.message, /unlock/); assert.doesNotMatch(error.message, /file is not a database|encryptedfixturecanaryreference/); assert.equal(error.cause, undefined); return true;
	});
	rejected.close(); wrong.fill(0);
	assert.deepEqual(scan(dirname(writer.path), "encryptedfixturecanaryreference"), before);
	assert.equal(f.store().stats(f.project).records, 1);
});
