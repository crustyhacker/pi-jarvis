import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openEncryptedArchiveDatabase, type ArchiveDatabase, type ArchiveNativeDatabase, type ArchiveNativeDatabaseConstructor, type ArchiveSqlValue, type ArchiveStatement } from "../archive-sqlite.js";

const require = createRequire(import.meta.url);
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-jarvis-encrypted-sqlite-test-"));
	fs.chmodSync(root, 0o700);
	const databases: ArchiveDatabase[] = [];
	t.after(() => { for (const db of databases) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
	return { root, path: join(root, "fixture.sqlite"), databases };
}
function fake() {
	const calls: { method: string; sql?: string; values?: ArchiveSqlValue[] }[] = [];
	const settings = new Map<string, string | number>();
	let encoded: Buffer | undefined, encodedCopy: Buffer | undefined, closes = 0;
	let fault: { method: string; error: unknown } | undefined;
	let keyResult = 0, authenticationFailure = false, tempStore = 2, inactiveCodec = false, inactiveHmac = false;
	class Native implements ArchiveNativeDatabase {
		constructor(readonly path: string, readonly options: { fileMustExist: boolean; timeout: number }) { calls.push({ method: "constructor" }); }
		exec(sql: string): void {
			calls.push({ method: "exec", sql });
			if (fault?.method === "exec") throw fault.error;
			const match = /^PRAGMA (\w+)=(?:'([^']+)'|(\d+))$/.exec(sql);
			if (match) settings.set(match[1], match[2] ?? Number(match[3]));
		}
		key(value: Buffer): number { calls.push({ method: "key" }); encoded = value; encodedCopy = Buffer.from(value); if (fault?.method === "key") throw fault.error; return keyResult; }
		prepare(sql: string): ArchiveStatement {
			calls.push({ method: "prepare", sql });
			if (fault?.method === "prepare") throw fault.error;
			return {
				run: (...values) => { calls.push({ method: "run", sql, values }); if (fault?.method === "run") throw fault.error; return { changes: 1, lastInsertRowid: 7 }; },
				get: (...values) => {
					calls.push({ method: "get", sql, values });
					if (fault?.method === "get") throw fault.error;
					if (sql === "SELECT name FROM sqlite_schema LIMIT 1") { if (authenticationFailure) throw new Error("sensitive native authentication details"); return undefined; }
					if (sql === "PRAGMA temp_store") return { temp_store: tempStore };
					if (sql === "PRAGMA cipher_salt") return { value: inactiveCodec ? undefined : "a".repeat(32) };
					if (sql === "PRAGMA hmac_use" && inactiveHmac) return { value: 0 };
					if (sql.startsWith("PRAGMA ")) return { value: settings.get(sql.slice(7)) };
					return { value: values[0] };
				},
				all: (...values) => { calls.push({ method: "all", sql, values }); if (fault?.method === "all") throw fault.error; return [{ value: values[0] }]; },
			};
		}
		close(): void { closes++; if (fault?.method === "close") throw fault.error; }
	}
	return { Constructor: Native, calls, get encoded() { return encoded; }, get encodedCopy() { return encodedCopy; }, get closes() { return closes; },
		setFault(method: string, error: unknown) { fault = { method, error }; }, setKeyResult(value: number) { keyResult = value; },
		setAuthenticationFailure() { authenticationFailure = true; }, setTempStore(value: number) { tempStore = value; }, setInactiveCodec() { inactiveCodec = true; }, setInactiveHmac() { inactiveHmac = true; } };
}
function sanitized(error: unknown): boolean {
	assert.ok(error instanceof Error);
	assert.doesNotMatch(error.message, /sensitive|native secret|fixture-sensitive|SELECT secret|passwordvalue/);
	assert.equal(error.cause, undefined);
	return true;
}
function nativeConstructor(t: TestContext): ArchiveNativeDatabaseConstructor | undefined {
	try { require.resolve("better-sqlite3-multiple-ciphers"); }
	catch (error) {
		if ((error as { code?: unknown }).code !== "MODULE_NOT_FOUND" || process.env.CI) throw error;
		t.skip("optional encrypted SQLite package is not installed"); return undefined;
	}
	assert.equal((require("better-sqlite3-multiple-ciphers/package.json") as { version: string }).version, "13.0.3");
	const Constructor = require("better-sqlite3-multiple-ciphers") as ArchiveNativeDatabaseConstructor;
	// Installed native loading/profile errors are failures, never silent skips.
	const probe = new Constructor(":memory:", { fileMustExist: false, timeout: 5000 }); probe.close();
	return Constructor;
}

test("module import does not load SQLite or optional native code", () => {
	const script = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);
		await import(${JSON.stringify(new URL("../archive-sqlite.ts", import.meta.url).href)});
		if(Object.keys(require.cache).some(p=>p.includes('better-sqlite3-multiple-ciphers')||p.endsWith('.node'))) process.exit(7);`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr); assert.doesNotMatch(child.stderr, /SQLite|ExperimentalWarning/);
});

test("raw binary DEK profile is fixed, key never appears in SQL, temporary copy wiped before bounded authentication", (t) => {
	const f = fixture(t), native = fake(), key = Buffer.alloc(32, 0xa7);
	const db = openEncryptedArchiveDatabase(f.path, key, { create: true, loadDatabase: () => native.Constructor }); f.databases.push(db);
	assert.equal(native.encodedCopy?.length, 36);
	assert.equal(native.encodedCopy?.subarray(0, 4).toString(), "raw:");
	assert.deepEqual(native.encodedCopy?.subarray(4), key);
	assert.deepEqual(native.encoded, Buffer.alloc(36)); assert.deepEqual(key, Buffer.alloc(32, 0xa7));
	assert.ok(native.calls.some(c => c.sql === "PRAGMA cipher='sqlcipher'"));
	for (const sql of ["PRAGMA legacy=4", "PRAGMA hmac_use=1", "PRAGMA hmac_algorithm=2", "PRAGMA plaintext_header_size=0", "PRAGMA hmac_check=1", "PRAGMA mc_legacy_wal=0"]) assert.ok(native.calls.some(c => c.sql === sql), sql);
	assert.ok(native.calls.some(c => c.sql?.includes("temp_store=MEMORY")));
	assert.ok(native.calls.every(c => !/PRAGMA\s+(?:hex)?key\s*=/i.test(c.sql ?? "")));
	const keyIndex = native.calls.findIndex(c => c.method === "key");
	assert.ok(native.calls.findIndex(c => c.sql === "SELECT name FROM sqlite_schema LIMIT 1") > keyIndex);
	assert.ok(native.calls.every(c => !/raw_json|CREATE TABLE|INSERT INTO|SELECT \*/i.test(c.sql ?? "")));
	assert.deepEqual(Object.keys(db).sort(), ["close", "exec", "prepare"]);
	assert.deepEqual(db.prepare("SELECT ? AS value").get("fixture"), { value: "fixture" });
	assert.deepEqual(db.prepare("SELECT ? AS value").all(3), [{ value: 3 }]);
	assert.deepEqual(db.prepare("INSERT INTO fixture VALUES(?)").run(null), { changes: 1, lastInsertRowid: 7 });
	db.close(); db.close(); assert.equal(native.closes, 1);
	assert.throws(() => db.exec("SELECT 1"), /closed/);
});

test("missing optional backend and missing native binary are actionable, sanitized, and never fall back", (t) => {
	const f = fixture(t), key = Buffer.alloc(32);
	for (const loadDatabase of [() => { throw new Error("sensitive native secret module path"); },
		() => class { constructor() { throw Object.assign(new Error("sensitive native binary path"), { code: "ERR_DLOPEN_FAILED" }); } } as unknown as ArchiveNativeDatabaseConstructor]) {
		assert.throws(() => openEncryptedArchiveDatabase(f.path, key, { create: true, loadDatabase }), error => {
			sanitized(error); assert.match((error as Error).message, /optional better-sqlite3-multiple-ciphers@13\.0\.3/); return true;
		});
	}
	assert.equal(fs.existsSync(f.path), false);
});

test("default loader rejects an unpinned manifest before loading package code", (t) => {
	const f = fixture(t);
	const script = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url), Module=require('node:module');
		const {openEncryptedArchiveDatabase}=await import(${JSON.stringify(new URL("../archive-sqlite.ts", import.meta.url).href)});
		const original=Module._load; let nativeLoaded=false;
		Module._load=function(request,...args) { if(request==='better-sqlite3-multiple-ciphers/package.json') return {version:'0.0.0'};
			if(request==='better-sqlite3-multiple-ciphers') { nativeLoaded=true; throw new Error('native should not load'); } return original.call(this,request,...args); };
		let rejected=false; try {openEncryptedArchiveDatabase(process.argv[1],Buffer.alloc(32),{create:true});}
		catch(e) { rejected=/optional better-sqlite3-multiple-ciphers@13.0.3/.test(e.message); }
		finally {Module._load=original;} if(!rejected||nativeLoaded) process.exit(8);`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.path], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr); assert.equal(fs.existsSync(f.path), false);
});

test("unknown/ignored HMAC configuration cannot return a plaintext adapter", (t) => {
	const f = fixture(t), native = fake(); native.setInactiveHmac();
	assert.throws(() => openEncryptedArchiveDatabase(f.path, Buffer.alloc(32), { create: true, loadDatabase: () => native.Constructor }), sanitized);
	assert.equal(native.closes, 1); assert.equal(native.encoded, undefined);
});

test("invalid keys and noncreation opens do not create files; zero-byte source requires explicit create", (t) => {
	const f = fixture(t), native = fake(); let loads = 0;
	const loadDatabase = () => { loads++; return native.Constructor; };
	for (const key of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32)]) assert.throws(() => openEncryptedArchiveDatabase(f.path, key as Buffer, { create: true, loadDatabase }), /32-byte key/);
	assert.equal(loads, 0);
	assert.throws(() => openEncryptedArchiveDatabase(f.path, Buffer.alloc(32), { loadDatabase }), /existing encrypted archive/);
	assert.equal(loads, 0); assert.equal(fs.existsSync(f.path), false);
	fs.writeFileSync(f.path, "", { mode: 0o600 });
	assert.throws(() => openEncryptedArchiveDatabase(f.path, Buffer.alloc(32), { loadDatabase }), /existing encrypted archive/);
	assert.equal(loads, 0); assert.equal(fs.statSync(f.path).size, 0);
	const db = openEncryptedArchiveDatabase(f.path, Buffer.alloc(32), { create: true, loadDatabase }); f.databases.push(db);
	assert.equal(loads, 1);
});

test("failed key/profile/authentication closes native connection and wipes key encoding", (t) => {
	const f = fixture(t);
	for (const mode of ["key-return", "key-throw", "auth", "temp", "inactive-codec"] as const) {
		const native = fake();
		if (mode === "key-return") native.setKeyResult(26);
		if (mode === "key-throw") native.setFault("key", new Error("sensitive native secret"));
		if (mode === "auth") native.setAuthenticationFailure();
		if (mode === "temp") native.setTempStore(1);
		if (mode === "inactive-codec") native.setInactiveCodec();
		assert.throws(() => openEncryptedArchiveDatabase(f.path, Buffer.alloc(32), { create: true, loadDatabase: () => native.Constructor }), sanitized);
		assert.equal(native.closes, 1); assert.deepEqual(native.encoded, Buffer.alloc(36));
	}
});

test("failed initialization cleanup exposes only safe close uncertainty before returning any adapter", (t) => {
	const f = fixture(t), native = fake();
	native.setAuthenticationFailure();
	native.setFault("close", new Error("sensitive native secret passwordvalue"));
	assert.throws(() => openEncryptedArchiveDatabase(f.path, Buffer.alloc(32), { create: true, loadDatabase: () => native.Constructor }), error => {
		sanitized(error);
		assert.equal(Object.getOwnPropertyDescriptor(error, "closeFailed")?.value, true);
		return true;
	});
	assert.equal(native.closes, 1, "uncertain native close must never be retried");
	assert.deepEqual(native.encoded, Buffer.alloc(36));
});

test("all runtime methods sanitize native errors while retaining BUSY/LOCKED primary classifications", (t) => {
	const f = fixture(t);
	for (const [method, code, primary] of [["run", "SQLITE_BUSY_SNAPSHOT", 5], ["get", "SQLITE_LOCKED_SHAREDCACHE", 6], ["all", "SQLITE_BUSY", 5], ["prepare", "SQLITE_LOCKED", 6], ["exec", "SQLITE_BUSY_RECOVERY", 5], ["close", "SQLITE_LOCKED", 6]] as const) {
		const native = fake(), db = openEncryptedArchiveDatabase(f.path, Buffer.alloc(32), { create: true, loadDatabase: () => native.Constructor });
		const statement = db.prepare("SELECT secret");
		native.setFault(method, Object.assign(new Error("sensitive native secret passwordvalue"), { code }));
		const action = method === "prepare" ? () => db.prepare("SELECT secret") : method === "exec" ? () => db.exec("SELECT secret") : method === "close" ? () => db.close() : () => statement[method]();
		assert.throws(action, error => { sanitized(error); assert.equal((error as { errcode: number }).errcode, primary); assert.equal((error as { code: string }).code, primary === 5 ? "SQLITE_BUSY" : "SQLITE_LOCKED"); assert.equal(Object.getOwnPropertyDescriptor(error, "closeFailed")?.value, method === "close" ? true : undefined); return true; });
		if (method !== "close") db.close();
	}
});

test("real optional engine: encrypted WAL/index/raw bodies, wrong keys, plaintext rejection, checkpoint and reopen", (t) => {
	const Constructor = nativeConstructor(t); if (!Constructor) return;
	const f = fixture(t), key = randomBytes(32), canary = "syntheticencryptedbodycanaryreference";
	const open = (create = false, unlockKey = key) => { const db = openEncryptedArchiveDatabase(f.path, unlockKey, { create, loadDatabase: () => Constructor }); f.databases.push(db); return db; };
	const db = open(true);
	assert.equal(db.prepare("PRAGMA temp_store").get()?.temp_store, 2);
	db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; CREATE TABLE records(body TEXT NOT NULL, raw_json TEXT CHECK(json_valid(raw_json))) STRICT; CREATE INDEX records_body ON records(body); CREATE VIRTUAL TABLE records_fts USING fts5(body,content='records',content_rowid='rowid')");
	const raw = JSON.stringify({ thinking: canary, tool: { text: canary.repeat(500) } });
	db.exec("BEGIN IMMEDIATE"); const inserted = db.prepare("INSERT INTO records(body,raw_json) VALUES(?,?)").run(canary, raw);
	db.prepare("INSERT INTO records_fts(rowid,body) VALUES(?,?)").run(inserted.lastInsertRowid, canary); db.exec("COMMIT");
	assert.equal(db.prepare("SELECT raw_json FROM records").get()?.raw_json, raw);
	assert.equal(db.prepare("SELECT count(*) AS count FROM records_fts WHERE records_fts MATCH ?").get(canary)?.count, 1);
	assert.throws(() => db.prepare('SELECT "unrecognized_column"').get());
	assert.throws(() => db.prepare("SELECT load_extension(?)").get(join(f.root, "nonexistent-fixture")));
	// Scan in another process: same-process close/read of an SQLite fd can release
	// POSIX locks. This scanner only sees temporary synthetic fixtures.
	const scanScript = `const fs=require('node:fs'),path=require('node:path'); const [root,canary]=process.argv.slice(1);
		console.log(JSON.stringify(fs.readdirSync(root).map(name=>{const data=fs.readFileSync(path.join(root,name));return {name,size:data.length,plaintext:data.includes(Buffer.from(canary)),header:data.subarray(0,16).equals(Buffer.from('SQLite format 3\\0'))};})));`;
	const scan = spawnSync(process.execPath, ["-e", scanScript, f.root, canary], { encoding: "utf8" });
	assert.equal(scan.status, 0, scan.stderr);
	const files = JSON.parse(scan.stdout) as { name: string; size: number; plaintext: boolean; header: boolean }[];
	assert.ok(files.some(file => file.name.endsWith("-wal") && file.size > 0));
	assert.ok(files.every(file => !file.plaintext && !file.header));
	assert.throws(() => open(false, randomBytes(32)), error => { sanitized(error); assert.match((error as Error).message, /unlock/); return true; });
	const reader = open(); assert.equal(reader.prepare("SELECT raw_json FROM records").get()?.raw_json, raw); reader.close();
	assert.equal(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy, 0); db.close();
	const reopened = open(); assert.equal(reopened.prepare("SELECT body FROM records").get()?.body, canary); reopened.close();
	const plainPath = join(f.root, "plain.sqlite"), plain = new Constructor(plainPath, { fileMustExist: false, timeout: 5000 }); plain.exec("CREATE TABLE fixture(body TEXT)"); plain.close();
	assert.throws(() => openEncryptedArchiveDatabase(plainPath, key, { loadDatabase: () => Constructor }), sanitized);
	key.fill(0);
});
