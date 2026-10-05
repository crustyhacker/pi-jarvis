import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createArchiveEnvelope, unlockArchiveEnvelope } from "../archive-crypto.js";
import type { ArchiveKeychain } from "../archive-keychain.js";
import { openEncryptedArchiveDatabase, type ArchiveStatement } from "../archive-sqlite.js";
import { ArchiveStore } from "../archive-store.js";
import { ArchiveUnlockLease } from "../archive-unlock.js";
import type { ArchiveInput } from "../archive-types.js";
import { ArchiveVault, type ArchiveVaultContext, type ArchiveVaultOptions } from "../archive-vault.js";
import { ArchiveVaultFiles, ArchiveVaultFilesError, type VaultReady, type VaultState } from "../archive-vault-files.js";

// Synthetic password/key and disposable native SQLite files ONLY. No real UI or
// credential adapter calls; all keychain methods below are in-memory fakes.
const PASSWORD = "synthetic vault fixture password";
const NEW_PASSWORD = "different synthetic fixture password";
const material = await createArchiveEnvelope(PASSWORD);
after(() => material.key.fill(0));
const require = createRequire(import.meta.url);
function encryptedTest(name: string, run: (t: TestContext) => Promise<void>): void {
	test(name, async t => {
		try { require.resolve("better-sqlite3-multiple-ciphers"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND" || process.env.CI) throw error;
			t.skip("optional encrypted SQLite package is not installed"); return;
		}
		await run(t);
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
class FakeKeychain implements ArchiveKeychain {
	keys = new Map<string, Buffer>();
	gets: string[] = []; sets: string[] = []; deletes: string[] = [];
	getWait?: ReturnType<typeof deferred<void>>;
	setWait?: ReturnType<typeof deferred<void>>;
	deleteFails = false;
	setFails = false;
	async get(account: string): Promise<Buffer | undefined> {
		this.gets.push(account);
		const snapshot = this.keys.get(account);
		const key = snapshot && Buffer.from(snapshot);
		await this.getWait?.promise;
		return key;
	}
	async set(account: string, key: Buffer): Promise<void> {
		this.sets.push(account);
		const copy = Buffer.from(key);
		await this.setWait?.promise;
		this.keys.set(account, copy);
		if (this.setFails) throw new Error("synthetic native SECRET must not escape");
	}
	async delete(account: string): Promise<void> {
		this.deletes.push(account);
		if (this.deleteFails) throw new Error("synthetic delete SECRET must not escape");
		this.keys.get(account)?.fill(0);
		this.keys.delete(account);
	}
	wipe() { for (const value of this.keys.values()) value.fill(0); this.keys.clear(); }
}
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-jarvis-vault-controller-test-")); fs.chmodSync(root, 0o700);
	const agent = join(root, "agent"), project = join(root, "project"); fs.mkdirSync(project, { mode: 0o700 });
	let allowed = true, trusted = true, owner = "fixture-main", prompts = 0, changes = 0;
	let prompt: NonNullable<ArchiveVaultOptions["prompt"]> = async () => PASSWORD;
	let onChange = () => {};
	const keychain = new FakeKeychain(), stores: ArchiveStore[] = [], vaults: ArchiveVault[] = [], notifications: string[] = [];
	const files = new ArchiveVaultFiles(agent);
	const ctx = {
		cwd: project, hasUI: true, mode: "tui", isProjectTrusted: () => trusted,
		sessionManager: { getSessionId: () => owner }, ui: { notify: (text: string) => notifications.push(text) },
	} as unknown as ArchiveVaultContext;
	function vault(selected = agent, Constructor: typeof ArchiveVault = ArchiveVault): ArchiveVault {
		let value: ArchiveVault;
		const legacy = new ArchiveStore(selected, { guard: () => value.guardLegacy() }); stores.push(legacy);
		value = new Constructor(selected, legacy, { isAllowed: () => allowed, onChange: () => { changes++; onChange(); },
			prompt: async (...args) => { prompts++; return prompt(...args); }, keychain });
		vaults.push(value); return value;
	}
	const input = (id = "entry", sessionId = "fixture-session", text = "vaultfixturecanary search reference"): ArchiveInput => ({
		project, sessionId, lane: "main", entry: { id, parentId: null, type: "message", timestamp: "2026-01-02T03:04:05.000Z",
			message: { role: "assistant", content: text } },
	});
	async function encrypted(startup: VaultReady["startup"] = "manual", withRecord = true) {
		const state: VaultReady = { format: "pi-jarvis-archive-vault", version: 1, phase: "ready", revision: randomUUID(),
			active: { id: material.envelope.vaultId, envelope: material.envelope }, retired: [], startup,
			...(startup === "remember" ? { remember: { account: "a".repeat(64) } } : {}) };
		files.withLock(locked => { locked.write(state); locked.ensureStorageDir(state.active.id); });
		const writer = new ArchiveStore(agent, { managed: true, storageId: state.active.id,
			databaseFactory: (path, options) => openEncryptedArchiveDatabase(path, material.key, options) }); stores.push(writer);
		if (withRecord) writer.append(input()); else writer.migrationDatabase(true, () => {});
		writer.close(); writer.migrationSync(() => {});
		if (state.remember) keychain.keys.set(state.remember.account, Buffer.from(material.key));
		return state;
	}
	t.after(() => { for (const value of vaults) value.shutdown("quit"); for (const store of stores) store.close(); keychain.wipe(); fs.rmSync(root, { recursive: true, force: true }); });
	return { root, agent, project, ctx, files, vault, input, encrypted, stores, vaults, keychain, notifications,
		get changes() { return changes; }, get prompts() { return prompts; },
		set allowed(value: boolean) { allowed = value; }, set trusted(value: boolean) { trusted = value; }, set owner(value: string) { owner = value; },
		set prompt(value: NonNullable<ArchiveVaultOptions["prompt"]>) { prompt = value; }, set onChange(value: () => void) { onChange = value; },
	};
}
function ready(state: VaultState | undefined): VaultReady { assert.equal(state?.phase, "ready"); return state as VaultReady; }
async function waitFor(check: () => boolean) { for (let i = 0; i < 2000; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("fixture asynchronous boundary not reached"); }
const CONFIRM = "--confirm-sensitive --confirm-stopped";

/** Real separate-process writer; synthetic key travels on stdin, never command arguments.
 * Probe rolls back immediately and never changes source records. */
function writerPeer(path: string, key?: Buffer): { outcome: "acquired" | "busy"; errcode?: number } {
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
		import { readFileSync } from 'node:fs';
		import { DatabaseSync } from 'node:sqlite';
		import { openEncryptedArchiveDatabase } from ${JSON.stringify(new URL("../archive-sqlite.ts", import.meta.url).href)};
		const { path, key64 } = JSON.parse(readFileSync(0, 'utf8'));
		const key = key64 ? Buffer.from(key64, 'base64') : undefined;
		const db = key ? openEncryptedArchiveDatabase(path, key, { create: false }) : new DatabaseSync(path);
		try {
			db.exec('PRAGMA busy_timeout=0');
			try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); console.log(JSON.stringify({ outcome: 'acquired' })); }
			catch (error) {
				if ((error.errcode & 255) !== 5 && !/^SQLITE_BUSY(?:_|$)/.test(error.code ?? '')) throw error;
				console.log(JSON.stringify({ outcome: 'busy', errcode: 5 }));
			}
		} finally { db.close(); key?.fill(0); }
	`], { input: JSON.stringify({ path, key64: key?.toString("base64") }), encoding: "utf8", timeout: 10_000 });
	assert.equal(child.status, 0, `fixture peer failed: ${child.stderr}`);
	return JSON.parse(child.stdout.trim()) as ReturnType<typeof writerPeer>;
}

test("constructor/off/pause/status are inert; legacy executes before main start", async t => {
	const f = fixture(t); f.allowed = false;
	const vault = f.vault();
	assert.equal(fs.existsSync(f.agent), false);
	assert.equal(vault.available(f.ctx), false); vault.pause(); vault.pause();
	assert.match(vault.description(), /legacy plaintext/);
	assert.equal(f.changes, 0); assert.equal(f.prompts, 0);
	assert.equal(fs.existsSync(f.agent), false); assert.deepEqual(f.keychain.gets, []);
	assert.throws(() => vault.execute(f.ctx, store => store.stats(f.project)), /unavailable/);
	f.allowed = true;
	assert.equal(vault.available(f.ctx), true);
	assert.equal(vault.execute(f.ctx, store => store.append(f.input())), "saved");
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
	assert.equal(f.prompts, 0); assert.equal(fs.existsSync(f.files.statePath), false);
	assert.equal(await vault.command("search fixture", f.ctx), undefined);
});

test("strict commands reject every extra argument and never reflect secrets or prompt", async t => {
	const f = fixture(t), vault = f.vault();
	for (const action of ["unlock SECRET", "unlock process SECRET", "unlock for 0", "unlock for 10081", "unlock idle 01", "unlock --global",
		"lock SECRET", "password SECRET", "startup prompt SECRET", "startup mystery", "encryption status SECRET",
		"encryption on --confirm-sensitive", `encryption on ${CONFIRM} SECRET`, `encryption recover ${CONFIRM}`,
		"encryption on --confirm-sensitive --confirm-sensitive", "encryption --project on"]) {
		const result = await vault.command(action, f.ctx);
		assert.match(result!, /Invalid archive vault command/); assert.doesNotMatch(result!, /SECRET/);
	}
	assert.equal(f.prompts, 0); assert.equal(fs.existsSync(f.agent), false);
});

encryptedTest("encrypted policy probes do not open DB/native credentials/prompt; malformed metadata never falls back", async t => {
	const f = fixture(t), state = await f.encrypted(), vault = f.vault();
	assert.equal(vault.available(f.ctx), false); assert.match(vault.description(), /on; locked/);
	assert.match(vault.description(), new RegExp(`vaults/${state.active.id}/archive.sqlite`));
	assert.equal(f.prompts, 0); assert.deepEqual(f.keychain.gets, []);
	fs.writeFileSync(f.files.statePath, "{ malformed fixture metadata", { mode: 0o600 });
	assert.equal(vault.available(f.ctx), false); assert.match(vault.description(), /unavailable/);
	assert.throws(() => vault.guardLegacy());
	assert.match((await vault.command("lock", f.ctx))!, /durable revocation could not be confirmed/);
	assert.equal(fs.readFileSync(f.files.statePath, "utf8"), "{ malformed fixture metadata");
	assert.equal(fs.existsSync(join(f.files.rootPath, "archive.sqlite")), false);
});

encryptedTest("unlock authenticates DB; execute accepts side context but stale stores and async actions cannot escape", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault(); await vault.start(f.ctx);
	assert.match((await vault.command("unlock", f.ctx))!, /unlocked \(session\)/);
	assert.equal(vault.available(f.ctx), true);
	const side = { ...f.ctx, sessionManager: { getSessionId: () => "fixture-side" } } as ArchiveVaultContext;
	assert.equal(vault.execute(side, store => store.stats(f.project)).records, 1);
	let retained!: ArchiveStore;
	vault.execute(side, store => { retained = store; return store.search({ project: f.project }).records.length; });
	assert.throws(() => retained.stats(f.project), /operation has ended/);
	let called = false;
	assert.throws(() => vault.execute(f.ctx, async () => { called = true; }), /synchronous/); assert.equal(called, false);
	assert.throws(() => vault.execute(f.ctx, () => Promise.resolve(1)), /synchronous/);
	assert.match((await vault.command("unlock process", side))!, /different main session/);
	await vault.command("lock", f.ctx);
	assert.equal(vault.available(side), false); assert.throws(() => retained.stats(f.project));
});

encryptedTest("wrong password, wrong remembered key and missing active database fail without creation", async t => {
	const f = fixture(t), state = await f.encrypted("remember"), vault = f.vault();
	f.prompt = async () => "wrong synthetic password";
	assert.match((await vault.command("unlock", f.ctx))!, /Unable to unlock/); assert.equal(vault.available(f.ctx), false);
	f.keychain.keys.set(state.remember!.account, Buffer.alloc(32, 7));
	await vault.start(f.ctx); assert.equal(vault.available(f.ctx), false); assert.match(f.notifications.at(-1)!, /remains locked/);
	f.prompt = async () => PASSWORD;
	const path = join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite"); fs.unlinkSync(path);
	assert.match((await vault.command("unlock", f.ctx))!, /missing/); assert.equal(fs.existsSync(path), false);
});

encryptedTest("successful keyed access cannot recreate a vanished active database", async t => {
	const f = fixture(t), state = await f.encrypted(), vault = f.vault();
	await vault.command("unlock process", f.ctx);
	const path = join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite"); fs.unlinkSync(path);
	assert.throws(() => vault.execute(f.ctx, store => store.append(f.input("new"))));
	assert.equal(fs.existsSync(path), false); assert.equal(fs.existsSync(join(f.files.rootPath, "archive.sqlite")), false);
});

encryptedTest("nonpersistent unlock atomically clears remembered authorization and startup remember", async t => {
	const f = fixture(t), before = await f.encrypted("remember"), vault = f.vault();
	assert.match((await vault.command("unlock for 3", f.ctx))!, /fixed duration/);
	const after = ready(f.files.read()); assert.notEqual(after.revision, before.revision);
	assert.equal(after.startup, "manual"); assert.equal(after.remember, undefined);
	assert.deepEqual(f.keychain.deletes, [before.remember!.account]);
	assert.equal(f.keychain.keys.size, 0); assert.equal(vault.available(f.ctx), true);
});

encryptedTest("explicit remember/startup remember use fresh unique accounts; off startup never reads credentials", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault();
	await vault.command("unlock remember", f.ctx);
	const first = ready(f.files.read()); assert.equal(first.startup, "remember"); assert.match(first.remember!.account, /^[a-f0-9]{64}$/);
	await vault.command("startup remember", f.ctx);
	const second = ready(f.files.read()); assert.notEqual(second.remember!.account, first.remember!.account);
	assert.equal(f.keychain.keys.size, 1); assert.ok(f.keychain.deletes.includes(first.remember!.account));
	vault.shutdown("quit"); const fresh = f.vault(); f.allowed = false; await fresh.start(f.ctx);
	assert.deepEqual(f.keychain.gets, []); assert.equal(fresh.available(f.ctx), false);
	f.allowed = true; assert.equal(fresh.available(f.ctx), false); assert.deepEqual(f.keychain.gets, []);
	await fresh.start(f.ctx); assert.equal(fresh.available(f.ctx), true); assert.equal(f.prompts, 1);
	await fresh.command("startup prompt", f.ctx);
	assert.equal(fresh.available(f.ctx), false); assert.equal(ready(f.files.read()).remember, undefined);
	assert.equal(f.keychain.keys.size, 0);
});

encryptedTest("lock while off durably rotates revision; credential deletion failures are safe and disclosed", async t => {
	const f = fixture(t), before = await f.encrypted("remember"), vault = f.vault(); await vault.start(f.ctx);
	f.allowed = false; vault.pause(); f.keychain.deleteFails = true;
	const result = await vault.command("lock", f.ctx);
	assert.match(result!, /deletion failed/); assert.doesNotMatch(result!, /SECRET/);
	const after = ready(f.files.read()); assert.notEqual(after.revision, before.revision); assert.equal(after.remember, undefined); assert.equal(after.startup, "manual");
	assert.equal(f.keychain.keys.size, 1);
	vault.shutdown("quit"); const fresh = f.vault(); f.allowed = true; await fresh.start(f.ctx);
	assert.equal(fresh.available(f.ctx), false); assert.equal(f.keychain.gets.length, 1);
});

encryptedTest("live trust/off revocation cancels pending prompts and does not delete persistent credentials", async t => {
	const f = fixture(t); await f.encrypted("remember"); const vault = f.vault(); await vault.start(f.ctx);
	const wait = deferred<string | undefined>(); f.prompt = async () => wait.promise;
	const pending = vault.command("unlock process", f.ctx);
	await waitFor(() => f.prompts === 1);
	f.trusted = false; vault.pause(); const changes = f.changes; vault.pause(); assert.equal(f.changes, changes);
	wait.resolve(PASSWORD); assert.match((await pending)!, /cancelled/);
	assert.equal(vault.available(f.ctx), false); assert.deepEqual(f.keychain.deletes, []);
	f.trusted = true; assert.equal(vault.available(f.ctx), false); // No implicit restore.
});

encryptedTest("late keychain set after lock is deleted and never durably reauthorizes; a new grant uses another account", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault(); f.keychain.setWait = deferred<void>();
	const remember = vault.command("unlock remember", f.ctx);
	await waitFor(() => f.keychain.sets.length === 1);
	const first = f.keychain.sets[0]; await vault.command("lock", f.ctx);
	const lockedRevision = ready(f.files.read()).revision;
	f.keychain.setWait.resolve(); assert.match((await remember)!, /cancelled/);
	assert.equal(ready(f.files.read()).revision, lockedRevision); assert.equal(ready(f.files.read()).remember, undefined);
	assert.equal(f.keychain.keys.size, 0); assert.ok(f.keychain.deletes.includes(first));
	f.keychain.setWait = undefined;
	await vault.command("unlock remember", f.ctx); assert.notEqual(f.keychain.sets[1], first);
	assert.equal(vault.available(f.ctx), true);
});

encryptedTest("failed keychain set cleans uncertain new account without fallback or grant", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault(); f.keychain.setFails = true;
	const result = await vault.command("unlock remember", f.ctx);
	assert.match(result!, /failed/); assert.doesNotMatch(result!, /SECRET/);
	assert.equal(vault.available(f.ctx), false); assert.equal(f.keychain.keys.size, 0);
	assert.equal(ready(f.files.read()).remember, undefined); assert.equal(f.keychain.deletes.length, 1);
});

encryptedTest("late remembered get after revision change/policy off cannot grant or call stale UI", async t => {
	for (const change of ["revision", "off", "shutdown"]) {
		const f = fixture(t); await f.encrypted("remember"); const vault = f.vault(); f.keychain.getWait = deferred<void>();
		const pending = vault.start(f.ctx); await waitFor(() => f.keychain.gets.length === 1);
		if (change === "revision") f.files.withLock(locked => { const state = ready(locked.read()); locked.write({ ...state, revision: randomUUID() }); });
		if (change === "off") { f.allowed = false; vault.pause(); }
		if (change === "shutdown") vault.shutdown("new");
		f.keychain.getWait.resolve(); await pending; assert.equal(vault.available(f.ctx), false);
		if (change === "shutdown") assert.deepEqual(f.notifications, []);
	}
});

encryptedTest("old facade prompt/KDF completion is permanently revoked across main replacement", async t => {
	const f = fixture(t); await f.encrypted(); const old = f.vault();
	const wait = deferred<string | undefined>(); f.prompt = async () => wait.promise;
	const result = old.command("unlock process", f.ctx); await waitFor(() => f.prompts === 1);
	old.shutdown("new"); f.owner = "fresh-main"; const fresh = f.vault(); await fresh.start(f.ctx);
	wait.resolve(PASSWORD); assert.match((await result)!, /cancelled/); assert.equal(fresh.available(f.ctx), false);
	f.prompt = async () => PASSWORD;
	const kdf = fresh.command("unlock process", f.ctx); await immediate(); fresh.shutdown("fork");
	f.owner = "forked-main"; const newest = f.vault(); await newest.start(f.ctx); await kdf;
	assert.equal(newest.available(f.ctx), false); assert.equal(old.available(f.ctx), false);
	assert.match((await old.command("lock", f.ctx))!, /owner has been revoked/);
});

encryptedTest("process/persistent-local leases hand off ONLY new/resume/fork; old facades cannot revoke adopters", async t => {
	for (const reason of ["new", "resume", "fork", "reload", "quit", undefined, "mystery"]) {
		const f = fixture(t); await f.encrypted(); const old = f.vault(); await old.command("unlock process", f.ctx);
		const oldChanges = f.changes; old.shutdown(reason); f.owner = "replacement-main";
		const fresh = f.vault(); assert.equal(f.changes, oldChanges); await fresh.start(f.ctx);
		const expected = ["new", "resume", "fork"].includes(reason ?? "");
		assert.equal(fresh.available(f.ctx), expected, String(reason)); assert.equal(old.available(f.ctx), false);
		old.shutdown("quit"); assert.equal(fresh.available(f.ctx), expected);
		assert.throws(() => old.execute(f.ctx, store => store.stats(f.project)));
		assert.equal(f.prompts, 1); assert.deepEqual(f.keychain.gets, []);
	}
	const f = fixture(t); await f.encrypted(); const old = f.vault(); await old.command("unlock remember", f.ctx);
	old.shutdown("resume"); f.owner = "remembered-replacement"; const fresh = f.vault(); await fresh.start(f.ctx);
	assert.equal(fresh.available(f.ctx), true); assert.deepEqual(f.keychain.gets, []);
});

encryptedTest("session grants do not hand off; changed/malformed metadata blocks handoff reuse", async t => {
	const f = fixture(t); await f.encrypted(); const old = f.vault(); await old.command("unlock", f.ctx);
	old.shutdown("new"); f.owner = "new-main"; const fresh = f.vault(); await fresh.start(f.ctx); assert.equal(fresh.available(f.ctx), false);
	await fresh.command("unlock process", f.ctx); fresh.shutdown("fork");
	f.files.withLock(locked => { const state = ready(locked.read()); locked.write({ ...state, revision: randomUUID() }); });
	f.owner = "forked-main"; const newest = f.vault(); await newest.start(f.ctx); assert.equal(newest.available(f.ctx), false);
	await newest.command("unlock process", f.ctx); newest.shutdown("new");
	fs.writeFileSync(f.files.statePath, "broken synthetic metadata"); const last = f.vault(); assert.equal(last.available(f.ctx), false);
});

encryptedTest("timed handoff preserves the original deadline and status never refreshes idle lifetime", async t => {
	const f = fixture(t); await f.encrypted();
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
	const old = f.vault(); await old.command("unlock for 1", f.ctx);
	t.mock.timers.tick(40_000); old.shutdown("new"); f.owner = "new-main"; const fresh = f.vault(); await fresh.start(f.ctx);
	assert.equal(fresh.available(f.ctx), true); t.mock.timers.tick(19_000); fresh.description();
	t.mock.timers.tick(1_001); assert.equal(fresh.available(f.ctx), false);
	await fresh.command("unlock idle 1", f.ctx); t.mock.timers.tick(40_000);
	fresh.execute(f.ctx, store => store.stats(f.project)); t.mock.timers.tick(40_000); assert.equal(fresh.available(f.ctx), true);
	fresh.description(); t.mock.timers.tick(20_001); assert.equal(fresh.available(f.ctx), false);
});

for (const idle of [false, true]) for (const advanceAtTouch of [false, true]) {
	encryptedTest(`managed raw read rechecks after real ${idle ? "idle" : "fixed"} touch; advance=${advanceAtTouch}`, async t => {
		const f = fixture(t); await f.encrypted(); const vault = f.vault();
		await vault.command("unlock process", f.ctx);
		const id = vault.execute(f.ctx, store => store.search({ project: f.project }).records[0].id);
		let wall = 1_000_000, touchBefore: boolean | undefined, touchAfter: boolean | undefined, touches = 0;
		// Advance ONLY inside the original touch boundary, not a timer or earlier guard.
		t.mock.method(Date, "now", () => wall);
		assert.match((await vault.command(`unlock ${idle ? "idle" : "for"} 1`, f.ctx))!, /unlocked/);
		const originalTouch = ArchiveUnlockLease.prototype.touch;
		t.mock.method(ArchiveUnlockLease.prototype, "touch", function(this: ArchiveUnlockLease) {
			touches++; touchBefore = this.status.unlocked;
			if (advanceAtTouch) wall += 60_001;
			originalTouch.call(this); // Real implementation revokes synchronously and returns normally.
			touchAfter = this.status.unlocked;
		});
		let returned: ReturnType<ArchiveStore["read"]>, readCompleted = false;
		const read = () => { returned = vault.execute(f.ctx, store => {
			const page = store.read(id, f.project)!;
			assert.equal(page.content, JSON.stringify(f.input().entry)); readCompleted = true;
			return page;
		}); };
		try {
			if (advanceAtTouch) { assert.throws(read, /revoked|locked/); assert.equal(returned, undefined); }
			else { read(); assert.equal(returned!.content, JSON.stringify(f.input().entry)); }
			assert.equal(readCompleted, true); assert.equal(touches, 1);
			assert.equal(touchBefore, true); assert.equal(touchAfter, !advanceAtTouch);
			assert.equal(vault.available(f.ctx), !advanceAtTouch);
			if (advanceAtTouch) assert.throws(() => vault.execute(f.ctx, store => store.read(id, f.project)), /unavailable/);
		} finally { t.mock.restoreAll(); }
	});
}

encryptedTest("migration retains source and exactly preserves raw/FTS/tombstone data; cleanup and plaintext conversion explicit", async t => {
	const f = fixture(t), vault = f.vault();
	const raw = f.input("rich"); raw.entry.message = { role: "assistant", content: [
		{ type: "thinking", thinking: "vaultfixturecanary exposed reasoning", thinkingSignature: "rawsignaturenotindexed" },
		{ type: "toolCall", id: "fixturetool", name: "synthetic_tool", arguments: { text: "vaultfixturecanary 😀 ", number: 42 } },
		{ type: "image", data: "ZmFrZWZpeHR1cmU=", mimeType: "image/png" },
	] }; raw.entry.custom = { retained: true };
	vault.execute(f.ctx, store => { store.append(raw); store.append(f.input("deleted", "deleted-session")); store.forgetSession("deleted-session", f.project); });
	f.prompt = async () => NEW_PASSWORD;
	const result = await vault.command(`encryption on ${CONFIRM}`, f.ctx); assert.match(result!, /enabled/); assert.match(result!, /Source retained/);
	const state = ready(f.files.read()); assert.ok(state.active.envelope); assert.equal(state.retired[0].id, "legacy");
	assert.equal(fs.existsSync(join(f.files.rootPath, "archive.sqlite")), true); assert.equal(vault.available(f.ctx), true);
	const record = vault.execute(f.ctx, store => store.search({ project: f.project, query: "vaultfixturecanary" }).records[0]);
	assert.equal(vault.execute(f.ctx, store => store.read(record.id, f.project))!.content, JSON.stringify(raw.entry));
	assert.equal(vault.execute(f.ctx, store => store.search({ project: f.project, query: "rawsignaturenotindexed" }).records.length), 0);
	assert.equal(vault.execute(f.ctx, store => store.append(f.input("deleted", "deleted-session"))), "deleted");
	assert.throws(() => new ArchiveStore(f.agent).stats(f.project)); // Old strict layout refuses marker.
	const encryptedPath = join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite");
	assert.equal(fs.readFileSync(encryptedPath).includes(Buffer.from("vaultfixturecanary")), false);
	assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /1 retired generation/);
	assert.equal(fs.existsSync(join(f.files.rootPath, "archive.sqlite")), false);
	assert.equal(vault.available(f.ctx), false); await vault.command("unlock", f.ctx);
	assert.match((await vault.command(`encryption off ${CONFIRM}`, f.ctx))!, /now plaintext/);
	const plaintext = ready(f.files.read()); assert.equal(plaintext.active.envelope, null); assert.equal(plaintext.retired[0].id, state.active.id);
	assert.equal(fs.existsSync(encryptedPath), true); assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
	assert.equal(vault.execute(f.ctx, store => store.append(f.input("deleted", "deleted-session"))), "deleted");
});

for (const sourceKind of ["legacy", "managed plain", "managed cipher"] as const) {
	encryptedTest(`actual controller ${sourceKind} migration keeps a real peer BEGIN IMMEDIATE excluded during copy`, async t => {
		const f = fixture(t);
		const state = sourceKind === "managed cipher" ? await f.encrypted() : sourceKind === "managed plain" ? plaintextActive(f) : undefined;
		const vault = f.vault(), encrypt = sourceKind !== "managed cipher";
		if (!state) vault.execute(f.ctx, store => store.append(f.input()));
		else if (!encrypt) assert.match((await vault.command("unlock process", f.ctx))!, /unlocked/);
		const path = state ? join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite") : join(f.files.rootPath, "archive.sqlite");
		const sourceKey = encrypt ? undefined : material.key;
		assert.deepEqual(writerPeer(path, sourceKey), { outcome: "acquired" }); // No transaction: positive control.
		const Native = require("better-sqlite3-multiple-ciphers"), prototype = encrypt ? Native.prototype : DatabaseSync.prototype;
		const originalPrepare = prototype.prepare; let copyChecks = 0;
		t.mock.method(prototype, "prepare", function(this: unknown, sql: string) {
			const statement = originalPrepare.call(this, sql);
			if (!sql.startsWith("INSERT INTO records_fts(rowid")) return statement;
			return { get: (...values: Parameters<ArchiveStatement["get"]>) => statement.get(...values),
				all: (...values: Parameters<ArchiveStatement["all"]>) => statement.all(...values),
				run: (...values: Parameters<ArchiveStatement["run"]>) => {
					const result = statement.run(...values); copyChecks++;
					// Actual controller source guard has run repeatedly AFTER BEGIN IMMEDIATE.
					assert.deepEqual(writerPeer(path, sourceKey), { outcome: "busy", errcode: 5 });
					return result;
				} };
		});
		try {
			assert.match((await vault.command(`encryption ${encrypt ? "on" : "off"} ${CONFIRM}`, f.ctx))!, encrypt ? /encryption enabled/ : /now plaintext/);
			assert.equal(copyChecks, 1);
		} finally { t.mock.restoreAll(); }
		assert.deepEqual(writerPeer(path, sourceKey), { outcome: "acquired" }); // Closed migration releases native locks normally.
		assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
	});
}

for (const action of ["unlock process", "password", `encryption cleanup ${CONFIRM}`]) {
	encryptedTest(`actual controller authentication guards preserve same-process native writer exclusion: ${action}`, async t => {
		const f = fixture(t), state = await f.encrypted(), vault = f.vault();
		assert.match((await vault.command("unlock process", f.ctx))!, /unlocked/);
		const path = join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite");
		assert.deepEqual(writerPeer(path, material.key), { outcome: "acquired" });
		// Normal read-only authentication itself need not exclude WAL writers.
		// A separate fixture-owned SAME-PROCESS connection owns this transaction;
		// observational preflight/guards must not release its locks by closing FDs.
		const held = openEncryptedArchiveDatabase(path, material.key, { create: false });
		held.exec("BEGIN IMMEDIATE");
		assert.deepEqual(writerPeer(path, material.key), { outcome: "busy", errcode: 5 });
		const Native = require("better-sqlite3-multiple-ciphers"), prepare = Native.prototype.prepare; let authChecks = 0;
		t.mock.method(Native.prototype, "prepare", function(this: { name: string }, sql: string) {
			const statement = prepare.call(this, sql);
			if (this.name !== path || !sql.startsWith("SELECT sql FROM sqlite_schema WHERE name")) return statement;
			return { get: (...values: Parameters<ArchiveStatement["get"]>) => statement.get(...values),
				run: (...values: Parameters<ArchiveStatement["run"]>) => statement.run(...values),
				all: (...values: Parameters<ArchiveStatement["all"]>) => {
					const rows = statement.all(...values); authChecks++;
					assert.deepEqual(writerPeer(path, material.key), { outcome: "busy", errcode: 5 });
					return rows;
				} };
		});
		if (action === "password") f.prompt = async () => NEW_PASSWORD;
		try {
			const result = await vault.command(action, f.ctx);
			assert.match(result!, action === "password" ? /password changed/ : action.startsWith("encryption") ? /cleanup: 0 retired/ : /unlocked/);
			assert.equal(authChecks, action === "password" ? 2 : 1);
			// Also check after native authentication handles have closed normally.
			assert.deepEqual(writerPeer(path, material.key), { outcome: "busy", errcode: 5 });
		} finally {
			t.mock.restoreAll();
			try { held.exec("ROLLBACK"); } finally { held.close(); }
		}
		assert.deepEqual(writerPeer(path, material.key), { outcome: "acquired" });
	});
}

encryptedTest("first encrypted archive is verified empty and private; off/trust cannot migrate or enable settings", async t => {
	const f = fixture(t), vault = f.vault(); f.allowed = false;
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /enabled in a trusted/); assert.equal(f.prompts, 0); assert.equal(fs.existsSync(f.agent), false);
	f.allowed = true; f.trusted = false;
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /enabled in a trusted/); assert.equal(f.prompts, 0);
	f.trusted = true;
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /enabled/);
	assert.deepEqual(vault.execute(f.ctx, store => store.stats(f.project)), { records: 0, bytes: 0 });
	assert.equal(fs.existsSync(join(f.files.rootPath, "archive.sqlite")), false);
	assert.equal(fs.existsSync(join(f.agent, "extensions", "pi-jarvis-archive.json")), false);
	assert.equal(fs.statSync(f.files.statePath).mode & 0o777, 0o600);
});

encryptedTest("migration cancellation leaves durable transition, retains source; explicit rollback preserves legacy marker", async t => {
	const f = fixture(t), vault = f.vault(); vault.execute(f.ctx, store => store.append(f.input()));
	f.stores[0].close();
	const original = fs.readFileSync(join(f.files.rootPath, "archive.sqlite"));
	f.onChange = () => { if (f.files.read()?.phase === "transition") f.allowed = false; };
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /transition remains blocked/);
	assert.equal(f.files.read()?.phase, "transition"); assert.equal(vault.available(f.ctx), false);
	assert.deepEqual(fs.readFileSync(join(f.files.rootPath, "archive.sqlite")), original);
	const transitionBeforeLock = f.files.read(); if (transitionBeforeLock?.phase !== "transition") assert.fail("transition missing");
	assert.equal(transitionBeforeLock.legacySourcePresent, true);
	assert.match((await vault.command("lock", f.ctx))!, /transition remains blocked/);
	const transitionAfterLock = f.files.read(); if (transitionAfterLock?.phase !== "transition") assert.fail("transition missing");
	assert.equal(transitionAfterLock.legacySourcePresent, true);
	assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /enabled in a trusted/);
	f.onChange = () => {}; f.allowed = true;
	assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /rolled back/);
	const state = ready(f.files.read()); assert.equal(state.active.id, "legacy"); assert.equal(state.active.envelope, null);
	assert.equal(fs.existsSync(f.files.statePath), true); assert.equal(vault.available(f.ctx), true);
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
	assert.throws(() => new ArchiveStore(f.agent).stats(f.project));
});

encryptedTest("failed target initialization is recoverable and cannot authorize plaintext fallback", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault(); await vault.command("unlock process", f.ctx);
	// Cooperating fixture callback introduces an unknown target file before copy.
	f.onChange = () => { const state = f.files.read(); if (state?.phase === "transition") {
		const path = join(f.files.rootPath, "vaults", state.to.active.id); fs.mkdirSync(path, { mode: 0o700 }); fs.writeFileSync(join(path, "unknown"), "synthetic blocker", { mode: 0o600 });
	} };
	assert.match((await vault.command(`encryption off ${CONFIRM}`, f.ctx))!, /transition remains blocked/);
	assert.equal(vault.available(f.ctx), false); assert.equal(f.files.read()?.phase, "transition");
	f.onChange = () => {};
	assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /failed/); assert.equal(f.files.read()?.phase, "transition");
});

encryptedTest("cleanup failure retains metadata entry and never deletes active storage", async t => {
	const f = fixture(t), state = await f.encrypted(), retiredId = randomUUID();
	f.files.withLock(locked => { locked.ensureStorageDir(retiredId); locked.write({ ...state, revision: randomUUID(), retired: [{ id: retiredId, envelope: null }] }); });
	fs.writeFileSync(join(f.files.rootPath, "vaults", retiredId, "foreign"), "synthetic foreign file", { mode: 0o600 });
	const vault = f.vault(); await vault.command("unlock", f.ctx);
	const result = await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx);
	assert.match(result!, /1 retained after cleanup failure/); assert.equal(ready(f.files.read()).retired.length, 1);
	assert.equal(fs.existsSync(join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite")), true);
});

encryptedTest("password change rewraps authenticated DEK, clears remembered grant and locks; old backups still unwrap", async t => {
	const f = fixture(t), before = await f.encrypted("remember"), vault = f.vault(); await vault.start(f.ctx);
	f.prompt = async () => NEW_PASSWORD;
	assert.match((await vault.command("password", f.ctx))!, /not key rotation/);
	const next = ready(f.files.read()); assert.equal(next.remember, undefined); assert.equal(next.startup, "manual"); assert.equal(vault.available(f.ctx), false);
	const oldKey = await unlockArchiveEnvelope(before.active.envelope, PASSWORD), newKey = await unlockArchiveEnvelope(next.active.envelope, NEW_PASSWORD);
	try { assert.deepEqual(oldKey, newKey); } finally { oldKey.fill(0); newKey.fill(0); }
	assert.match((await vault.command("unlock", f.ctx))!, /unlocked/);
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1); assert.equal(f.keychain.keys.size, 0);
});

encryptedTest("observed cross-process revision revokes existing key/store and propagates once despite reentrant callbacks", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault(); await vault.command("unlock process", f.ctx);
	vault.execute(f.ctx, store => store.stats(f.project)); const changes = f.changes;
	f.onChange = () => { vault.available(f.ctx); vault.pause(); vault.description(); };
	f.files.withLock(locked => { const state = ready(locked.read()); locked.write({ ...state, revision: randomUUID() }); });
	assert.equal(vault.available(f.ctx), false); assert.equal(f.changes, changes + 1); assert.equal(vault.available(f.ctx), false); assert.equal(f.changes, changes + 1);
});

encryptedTest("explicit break-lock is off-safe and rejects a live local PID without stealing or rewriting state", async t => {
	const f = fixture(t), state = await f.encrypted(), vault = f.vault(); f.allowed = false;
	const lock = join(f.files.rootPath, "archive.vault.lock");
	// Token schema is intentionally supplied by the files public implementation.
	fs.writeFileSync(lock, JSON.stringify({ token: "b".repeat(64), pid: process.pid, hostname: hostname() }), { mode: 0o600 });
	const result = await vault.command(`encryption break-lock ${CONFIRM}`, f.ctx);
	assert.match(result!, /failed/); assert.equal(fs.existsSync(lock), true); assert.equal(ready(f.files.read()).revision, state.revision);
	fs.unlinkSync(lock); assert.match((await vault.command(`encryption break-lock ${CONFIRM}`, f.ctx))!, /No abandoned/);
});

encryptedTest("stale same-facade remembered start cannot revoke a successful new main owner or notify stale UI", async t => {
	const f = fixture(t); await f.encrypted("remember"); const vault = f.vault();
	const wait = deferred<void>(); f.keychain.getWait = wait;
	const oldStart = vault.start(f.ctx); await waitFor(() => f.keychain.gets.length === 1);
	const freshCtx = { ...f.ctx, sessionManager: { getSessionId: () => "fresh-main-owner" } } as ArchiveVaultContext;
	f.keychain.getWait = undefined;
	await vault.start(freshCtx); assert.equal(vault.available(freshCtx), true);
	const changes = f.changes, notices = f.notifications.length;
	wait.resolve(); await oldStart;
	assert.equal(vault.available(freshCtx), true); assert.equal(f.changes, changes); assert.equal(f.notifications.length, notices);
});

encryptedTest("startup prompt is main-only session unlock; unavailable prompt has no ordinary-input fallback", async t => {
	const f = fixture(t); await f.encrypted("prompt"); const vault = f.vault();
	f.allowed = false; await vault.start(f.ctx); assert.equal(f.prompts, 0);
	f.allowed = true; await vault.start(f.ctx); assert.equal(f.prompts, 1); assert.equal(vault.available(f.ctx), true);
	vault.shutdown("new"); f.owner = "fresh-main"; const fresh = f.vault(); f.prompt = async () => undefined;
	await fresh.start(f.ctx); assert.equal(fresh.available(f.ctx), false); assert.deepEqual(f.keychain.gets, []);
	assert.equal(f.prompts, 2); assert.match(f.notifications.at(-1)!, /No fallback/);
});

encryptedTest("cancelled password completion cannot change the successor's grant/envelope", async t => {
	const f = fixture(t), before = await f.encrypted("remember"), vault = f.vault(); await vault.start(f.ctx);
	const wait = deferred<string | undefined>(); f.prompt = async () => wait.promise;
	const change = vault.command("password", f.ctx); await waitFor(() => f.prompts === 1);
	const freshCtx = { ...f.ctx, sessionManager: { getSessionId: () => "replacement-main" } } as ArchiveVaultContext;
	await vault.start(freshCtx); assert.equal(vault.available(freshCtx), true);
	wait.resolve(NEW_PASSWORD); assert.match((await change)!, /cancelled/);
	assert.equal(vault.available(freshCtx), true); assert.deepEqual(ready(f.files.read()).active.envelope, before.active.envelope);
	assert.deepEqual(f.keychain.deletes, []);
});

encryptedTest("explicit encrypted-source rollback drops only known target and clears source remembered grant", async t => {
	const f = fixture(t); await f.encrypted("remember"); const vault = f.vault(); await vault.start(f.ctx);
	f.onChange = () => { if (f.files.read()?.phase === "transition") f.allowed = false; };
	assert.match((await vault.command(`encryption off ${CONFIRM}`, f.ctx))!, /transition remains blocked/);
	const transition = f.files.read(); assert.equal(transition?.phase, "transition");
	f.onChange = () => {}; f.allowed = true;
	assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /rolled back/);
	const source = ready(f.files.read()); assert.ok(source.active.envelope); assert.equal(source.remember, undefined); assert.equal(source.startup, "manual");
	assert.equal(f.keychain.keys.size, 0); assert.equal(vault.available(f.ctx), false);
	await vault.command("unlock", f.ctx); assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
});

encryptedTest("retired cap prevents more migration without prompting and missing managed plaintext never recreates", async t => {
	const f = fixture(t), state = await f.encrypted(), vault = f.vault(); await vault.command("unlock", f.ctx);
	f.files.withLock(locked => locked.write({ ...state, revision: randomUUID(), retired: Array.from({ length: 8 }, () => ({ id: randomUUID(), envelope: null })) }));
	assert.match((await vault.command(`encryption off ${CONFIRM}`, f.ctx))!, /limit reached/); assert.equal(f.prompts, 1);
	// Publish a synthetic ready plaintext reference with missing body: fail closed,
	// rather than interpreting a missing generation as an empty/new archive.
	f.files.withLock(locked => locked.write({ ...state, revision: randomUUID(), active: { id: randomUUID(), envelope: null } }));
	assert.equal(vault.available(f.ctx), false); assert.throws(() => vault.execute(f.ctx, store => store.append(f.input("new"))));
});

encryptedTest("active execute rechecks live policy after callbacks and transactional write guard prevents revoked commit", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault(); await vault.command("unlock process", f.ctx);
	assert.throws(() => vault.execute(f.ctx, store => { const result = store.stats(f.project); f.allowed = false; return result; }), /revoked/);
	// Restore BEFORE any independent availability/policy observation can pause.
	f.allowed = true; assert.equal(vault.available(f.ctx), false);
	await vault.command("unlock process", f.ctx);
	assert.throws(() => vault.execute(f.ctx, store => {
		f.trusted = false; return store.append(f.input("revoked-entry"));
	}), /revoked/);
	f.trusted = true; assert.equal(vault.available(f.ctx), false);
	await vault.command("unlock", f.ctx);
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
});

for (const denial of ["trust", "full off"] as const) {
	encryptedTest(`managed raw-read ${denial} denial revokes immediately even when restored before later policy`, async t => {
		const f = fixture(t); await f.encrypted(); const vault = f.vault(); await vault.command("unlock process", f.ctx);
		const id = vault.execute(f.ctx, store => store.search({ project: f.project }).records[0].id);
		let completedRead = false;
		assert.throws(() => vault.execute(f.ctx, store => {
			const page = store.read(id, f.project)!;
			assert.equal(page.content, JSON.stringify(f.input().entry)); completedRead = true;
			if (denial === "trust") f.trusted = false; else f.allowed = false;
			return page;
		}), /Archive access was revoked/);
		assert.equal(completedRead, true);
		// No available(), description(), pause() or shared-policy probe while denied.
		f.trusted = true; f.allowed = true;
		assert.equal(vault.available(f.ctx), false);
		assert.throws(() => vault.execute(f.ctx, store => store.read(id, f.project)), /unavailable/);
		assert.match((await vault.command("unlock process", f.ctx))!, /unlocked/);
		assert.equal(vault.execute(f.ctx, store => store.read(id, f.project))!.content, JSON.stringify(f.input().entry));
	});
}

encryptedTest("owned keychain cleanup warnings do not leak native text on stale set after shutdown", async t => {
	const f = fixture(t); await f.encrypted(); const old = f.vault(); f.keychain.setWait = deferred<void>(); f.keychain.deleteFails = true;
	const grant = old.command("unlock remember", f.ctx); await waitFor(() => f.keychain.sets.length === 1);
	old.shutdown("new"); const fresh = f.vault(); await fresh.start(f.ctx);
	f.keychain.setWait.resolve(); const result = await grant;
	assert.match(result!, /key may remain/); assert.doesNotMatch(result!, /SECRET/);
	assert.equal(fresh.available(f.ctx), false); assert.equal(ready(f.files.read()).remember, undefined);
});

encryptedTest("independent nonpersistent password unlocks keep one unchanged global revision and coexist", async t => {
	const f = fixture(t), before = await f.encrypted(), first = f.vault(), second = f.vault();
	await first.start(f.ctx); await second.start(f.ctx);
	assert.match((await first.command("unlock process", f.ctx))!, /unlocked/);
	assert.equal(ready(f.files.read()).revision, before.revision);
	assert.match((await second.command("unlock for 2", f.ctx))!, /unlocked/);
	assert.equal(ready(f.files.read()).revision, before.revision);
	assert.equal(first.available(f.ctx), true); assert.equal(second.available(f.ctx), true);
	assert.equal(first.execute(f.ctx, store => store.stats(f.project)).records, 1);
	assert.equal(second.execute(f.ctx, store => store.stats(f.project)).records, 1);
	await second.command("lock", f.ctx);
	assert.equal(first.available(f.ctx), false); assert.equal(second.available(f.ctx), false);
});

encryptedTest("ordinary managed operation lock is contention, not a global availability/lease revocation", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault(); await vault.command("unlock process", f.ctx);
	const changes = f.changes;
	f.files.withLock(() => {
		assert.equal(vault.available(f.ctx), true); assert.match(vault.description(), /busy/);
		assert.equal(f.changes, changes);
	});
	assert.equal(vault.available(f.ctx), true); assert.equal(f.changes, changes);
});

test("legacy in-callback pause revokes the executing permit even if policy is immediately re-enabled", async t => {
	const f = fixture(t), vault = f.vault(); vault.execute(f.ctx, store => store.append(f.input()));
	assert.throws(() => vault.execute(f.ctx, store => {
		f.allowed = false; vault.pause(); f.allowed = true;
		return store.append(f.input("must-not-save"));
	}), /revoked/);
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
});

encryptedTest("quit clears all handoffs; reload/unknown disposal clears only its own root's unadopted grant", async t => {
	for (const reason of ["quit", "reload", undefined]) {
		const f = fixture(t); await f.encrypted(); const old = f.vault(), sameRoot = f.vault();
		await old.command("unlock process", f.ctx); old.shutdown("new");
		if (reason === "quit") { const other = fixture(t); other.vault().shutdown(reason); }
		else sameRoot.shutdown(reason);
		const fresh = f.vault(); await fresh.start(f.ctx); assert.equal(fresh.available(f.ctx), false);
	}
	const f = fixture(t); await f.encrypted(); const old = f.vault(); await old.command("unlock process", f.ctx); old.shutdown("new");
	const other = fixture(t); other.vault().shutdown("reload");
	const fresh = f.vault(); assert.equal(fresh.available(f.ctx), true); // Unrelated SDK root cannot revoke this handoff.
});

encryptedTest("storage controls publish safety notice before creating transition; failed notice causes no migration", async t => {
	const f = fixture(t), vault = f.vault(); let before: VaultState | undefined;
	const ctx = { ...f.ctx, ui: { ...f.ctx.ui, notify: () => { before = f.files.read(); throw new Error("synthetic host notice failure"); } } } as ArchiveVaultContext;
	assert.match((await vault.command(`encryption on ${CONFIRM}`, ctx))!, /notice unavailable/);
	assert.equal(before, undefined); assert.equal(f.files.read(), undefined); assert.equal(f.prompts, 0);
	assert.equal(fs.existsSync(f.agent), false);
});

encryptedTest("explicit lock rotates idle transition and clears both nested remembered grants even on native deletion failure", async t => {
	const f = fixture(t), from = await f.encrypted("remember"), target = await createArchiveEnvelope(NEW_PASSWORD);
	try {
		const to: VaultReady = { ...from, revision: randomUUID(), active: { id: target.envelope.vaultId, envelope: target.envelope },
			remember: { account: "c".repeat(64) }, retired: [from.active] };
		const transition: VaultState = { format: "pi-jarvis-archive-vault", version: 1, phase: "transition", revision: randomUUID(), from, to };
		f.files.withLock(locked => locked.write(transition));
		f.keychain.keys.set(to.remember!.account, Buffer.from(target.key)); f.keychain.deleteFails = true;
		const vault = f.vault(); f.allowed = false;
		const result = await vault.command("lock", f.ctx); assert.match(result!, /locked durably; transition remains blocked/); assert.match(result!, /deletion failed/);
		const locked = f.files.read(); assert.equal(locked?.phase, "transition");
		assert.notEqual(locked!.revision, transition.revision);
		if (locked?.phase !== "transition") assert.fail("transition marker lost");
		assert.equal(locked.from!.remember, undefined); assert.equal(locked.to.remember, undefined);
		assert.equal(locked.from!.startup, "manual"); assert.equal(locked.to.startup, "manual");
		assert.deepEqual(locked.from!.active.envelope, from.active.envelope); assert.deepEqual(locked.to.active.envelope, to.active.envelope);
		assert.deepEqual(new Set(f.keychain.deletes), new Set([from.remember!.account, to.remember!.account]));
		assert.equal(f.keychain.keys.size, 2); assert.equal(vault.available(f.ctx), false);
		f.allowed = true; f.keychain.deleteFails = false;
		assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /rolled back/);
		assert.equal(ready(f.files.read()).remember, undefined); assert.equal(vault.available(f.ctx), false);
		await vault.start(f.ctx); assert.deepEqual(f.keychain.gets, []); // Deleted marker blocks leftover native keys.
	} finally { target.key.fill(0); }
});

encryptedTest("lock waits asynchronously for own cancelled migration, then durably rotates retained transition", async t => {
	const f = fixture(t), vault = f.vault(); vault.execute(f.ctx, store => store.append(f.input()));
	let locking: Promise<string | undefined> | undefined, revision: string | undefined;
	f.onChange = () => { const state = f.files.read(); if (!locking && state?.phase === "transition") {
		revision = state.revision;
		// Deferring avoids assignment reentrancy in this test callback itself.
		locking = Promise.resolve().then(() => vault.command("lock", f.ctx));
	} };
	const migration = vault.command(`encryption on ${CONFIRM}`, f.ctx);
	assert.match((await migration)!, /transition remains blocked/);
	assert.match((await locking)!, /locked durably; transition remains blocked/);
	assert.notEqual(f.files.read()!.revision, revision); assert.equal(f.files.read()?.phase, "transition"); assert.equal(vault.available(f.ctx), false);
});

encryptedTest("process handoff registry is bounded and evicted grants cannot reauthorize a fresh facade", async t => {
	let oldest: ReturnType<typeof fixture> | undefined, latest: ReturnType<typeof fixture> | undefined;
	for (let i = 0; i < 65; i++) {
		const f = fixture(t); if (!oldest) oldest = f; latest = f;
		await f.encrypted("remember", false);
		const vault = f.vault(); await vault.start(f.ctx); assert.equal(vault.available(f.ctx), true); vault.shutdown("new");
	}
	// Native fake entries are separate opt-ins; set OFF to ensure an evicted
	// lease cannot be resurrected by constructor adoption or credential restore.
	oldest!.allowed = false; const evicted = oldest!.vault(); oldest!.allowed = true;
	assert.equal(evicted.available(oldest!.ctx), false); assert.equal(oldest!.keychain.gets.length, 1);
	const adopted = latest!.vault(); assert.equal(adopted.available(latest!.ctx), true); assert.equal(latest!.keychain.gets.length, 1);
	await adopted.command("lock", latest!.ctx); assert.equal(adopted.available(latest!.ctx), false);
});

encryptedTest("external live lock contention fails durable lock clearly without replay or stealing", async t => {
	const f = fixture(t), before = await f.encrypted("remember"), vault = f.vault(); await vault.start(f.ctx);
	const wait = deferred<void>(), entered = deferred<void>();
	const external = f.files.withLockAsync(async () => { entered.resolve(); await wait.promise; });
	await entered.promise;
	const result = await vault.command("lock", f.ctx);
	assert.match(result!, /locked locally, but durable revocation could not be confirmed/);
	assert.equal(ready(f.files.read()).revision, before.revision);
	assert.equal(f.keychain.deletes.length, 1); assert.equal(f.keychain.keys.size, 0);
	assert.equal(fs.existsSync(join(f.files.rootPath, "archive.vault.lock")), true);
	wait.resolve(); await external;
	assert.equal(vault.available(f.ctx), false);
	assert.equal(ready(f.files.read()).revision, before.revision);
});

encryptedTest("change/cleanup callback failure blocks subsequent archive access without leaking caller error", async t => {
	const f = fixture(t); await f.encrypted(); const vault = f.vault(); await vault.command("unlock", f.ctx);
	f.onChange = () => { throw new Error("synthetic callback SECRET"); };
	vault.pause(); assert.equal(vault.available(f.ctx), false);
	assert.match(vault.description(), /cleanup failed/); assert.doesNotMatch(vault.description(), /SECRET/);
	assert.match((await vault.command("unlock", f.ctx))!, /stop Pi and inspect/);
	assert.throws(() => vault.execute(f.ctx, store => store.stats(f.project)), /unavailable/);
});

// Only fixture I/O is faulted; each public helper/native prototype is restored
// before any fixture teardown. Captured leaked handles close AFTER assertions.
type NativeFixture = { name: string; open: boolean; close(): void };
async function fsFault<K extends "unlinkSync" | "fsyncSync" | "renameSync">(
	key: K, replace: typeof fs[K], run: () => Promise<void>,
): Promise<void> {
	const original = fs[key]; fs[key] = replace; syncBuiltinESMExports();
	try { await run(); } finally { fs[key] = original; syncBuiltinESMExports(); }
}
function plaintextActive(f: ReturnType<typeof fixture>): VaultReady {
	const state: VaultReady = { format: "pi-jarvis-archive-vault", version: 1, phase: "ready", revision: randomUUID(),
		active: { id: randomUUID(), envelope: null }, startup: "manual", retired: [{ id: "legacy", envelope: null }] };
	f.files.withLock(locked => { locked.write(state); locked.ensureStorageDir(state.active.id); });
	const writer = new ArchiveStore(f.agent, { managed: true, storageId: state.active.id }); f.stores.push(writer);
	writer.append(f.input()); writer.close(); return state;
}

encryptedTest("selected root alias supports end-to-end encrypt, authenticate, execute, plaintext conversion and recovery", async t => {
	const f = fixture(t); fs.mkdirSync(f.agent, { mode: 0o700 });
	const alias = join(f.root, "selected-alias"); fs.symlinkSync(f.agent, alias);
	const vault = f.vault(alias);
	assert.equal(vault.execute(f.ctx, store => store.append(f.input())), "saved");
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /enabled/);
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
	await vault.command("lock", f.ctx);
	assert.match((await vault.command("unlock", f.ctx))!, /unlocked/);
	assert.equal(vault.execute(f.ctx, store => store.search({ project: f.project }).records.length), 1);
	assert.match((await vault.command(`encryption off ${CONFIRM}`, f.ctx))!, /now plaintext/);
	const before = ready(f.files.read());
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
	f.onChange = () => { if (f.files.read()?.phase === "transition") f.allowed = false; };
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /transition remains blocked/);
	f.onChange = () => {}; f.allowed = true;
	assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /rolled back/);
	assert.equal(ready(f.files.read()).active.id, before.active.id);
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
});

test("selected root alias never permits symlinked appended storage before publication", async t => {
	const f = fixture(t); fs.mkdirSync(f.agent, { mode: 0o700 });
	const alias = join(f.root, "selected-alias"), outside = join(f.root, "outside");
	fs.mkdirSync(outside, { mode: 0o700 }); fs.symlinkSync(f.agent, alias); fs.symlinkSync(outside, join(f.agent, "extensions"));
	const vault = f.vault(alias);
	assert.equal(vault.available(f.ctx), false);
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /failed/);
	assert.equal(f.prompts, 0); assert.deepEqual(fs.readdirSync(outside), []);
});

test("partial legacy auxiliary cleanup retains main, active access works, and explicit retry succeeds", async t => {
	for (const afterUnlink of [false, true]) {
		const f = fixture(t), state = plaintextActive(f), vault = f.vault();
		const legacy = join(f.files.rootPath, "archive.sqlite");
		for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.writeFileSync(legacy + suffix, `synthetic retired${suffix}`, { mode: 0o600 });
		const unlink = fs.unlinkSync; let attempts = 0;
		await fsFault("unlinkSync", ((path: fs.PathLike) => {
			if (String(path) === legacy + "-shm") {
				attempts++; if (afterUnlink) unlink(path);
				throw Object.assign(new Error("synthetic SECRET unlink failure"), { code: "EACCES" });
			}
			unlink(path);
		}) as typeof fs.unlinkSync, async () => {
			const result = await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx);
			assert.match(result!, /0 retired generation\(s\) removed; 1 retained/);
			assert.match(result!, /possibly partial backups/); assert.doesNotMatch(result!, /SECRET/);
		});
		assert.equal(attempts, 1); assert.equal(fs.existsSync(legacy), true);
		assert.equal(fs.existsSync(legacy + "-wal"), false);
		assert.equal(ready(f.files.read()).retired[0].id, "legacy");
		assert.equal(vault.available(f.ctx), true);
		assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
		assert.equal(ready(f.files.read()).active.id, state.active.id);
		assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /1 retired generation\(s\) removed; 0 retained/);
		assert.equal(ready(f.files.read()).retired.length, 0); assert.equal(fs.existsSync(legacy), false);
		assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
	}
});

test("plaintext cleanup refuses a missing active generation before deleting retired data", async t => {
	const f = fixture(t), state = plaintextActive(f), vault = f.vault(), legacy = join(f.files.rootPath, "archive.sqlite");
	fs.writeFileSync(legacy, "synthetic retained backup", { mode: 0o600 });
	fs.unlinkSync(join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite"));
	const before = f.files.read();
	assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /source.*missing/);
	assert.equal(fs.readFileSync(legacy, "utf8"), "synthetic retained backup");
	assert.deepEqual(f.files.read(), before);
});

encryptedTest("cleanup rechecks lease, permission and active presence between individual retired unlinks", async t => {
	for (const fault of ["expiry", "permission", "active missing"]) {
		const f = fixture(t), state = await f.encrypted(), vault = f.vault(), legacy = join(f.files.rootPath, "archive.sqlite");
		f.files.withLock(locked => locked.write({ ...state, retired: [{ id: "legacy", envelope: null }] }));
		for (const suffix of ["", "-wal", "-shm"]) fs.writeFileSync(legacy + suffix, `synthetic retained${suffix}`, { mode: 0o600 });
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
		try {
			await vault.command("unlock for 1", f.ctx);
			const before = f.files.read(), unlink = fs.unlinkSync; let removed = 0;
			await fsFault("unlinkSync", ((path: fs.PathLike) => {
				unlink(path);
				if (String(path) === legacy + "-wal") {
					removed++;
					if (fault === "expiry") t.mock.timers.tick(60_001);
					else if (fault === "permission") f.allowed = false;
					else fs.renameSync(join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite"), join(f.root, "retained-active.sqlite"));
				}
			}) as typeof fs.unlinkSync, async () => {
				assert.doesNotMatch((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /retired generation\(s\) removed/);
			});
			assert.equal(removed, 1);
			assert.equal(fs.existsSync(legacy), true, `${fault}: main backup must remain`);
			assert.equal(fs.existsSync(legacy + "-shm"), true, `${fault}: no later unlink`);
			assert.deepEqual(f.files.read(), before, `${fault}: no metadata publication`);
		} finally { t.mock.timers.reset(); }
	}
});

test("retired cleanup directory fsync failure reports a possibly partial backup without replay", async t => {
	const f = fixture(t); plaintextActive(f); const vault = f.vault(), legacy = join(f.files.rootPath, "archive.sqlite");
	fs.writeFileSync(legacy, "synthetic retired main", { mode: 0o600 });
	const unlink = fs.unlinkSync, sync = fs.fsyncSync; let deleted = false, failures = 0, attempts = 0;
	await fsFault("unlinkSync", ((path: fs.PathLike) => {
		unlink(path); if (String(path) === legacy) { attempts++; deleted = true; }
	}) as typeof fs.unlinkSync, async () => fsFault("fsyncSync", ((fd: number) => {
		if (deleted && !failures && fs.fstatSync(fd).isDirectory()) { failures++; throw new Error("synthetic cleanup fsync failure"); }
		sync(fd);
	}) as typeof fs.fsyncSync, async () => {
		assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /1 retained after cleanup failure \(possibly partial backups\)/);
	}));
	assert.equal(attempts, 1); assert.equal(failures, 1); assert.equal(fs.existsSync(legacy), false);
	assert.equal(vault.execute(f.ctx, store => store.stats(f.project)).records, 1);
	assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /1 retired generation\(s\) removed; 0 retained/);
});

encryptedTest("before-native-target-close failure poisons canonical root across new/resume/fork/reload/quit and module reload", async t => {
	const f = fixture(t), vault = f.vault(); vault.execute(f.ctx, store => store.append(f.input()));
	const Native = require("better-sqlite3-multiple-ciphers") as { prototype: NativeFixture };
	const close = Native.prototype.close; let leaked: NativeFixture | undefined, attempts = 0;
	Native.prototype.close = function() {
		if (this.name.includes("/vaults/") && !leaked) { leaked = this; attempts++; throw new Error("synthetic close failed BEFORE native close"); }
		return close.call(this);
	};
	try {
		let result: string | undefined;
		try { result = await vault.command(`encryption on ${CONFIRM}`, f.ctx); }
		finally { Native.prototype.close = close; }
		assert.match(result!, /restart the Pi process/); assert.equal(attempts, 1); assert.equal(leaked!.open, true);
		const state = f.files.read(); assert.equal(state?.phase, "transition");
		if (state?.phase !== "transition") assert.fail("transition missing");
		const target = join(f.files.rootPath, "vaults", state.to.active.id, "archive.sqlite");
		const before = fs.readFileSync(target);
		assert.equal(vault.available(f.ctx), false); assert.doesNotMatch(vault.description(), /unlocked/);
		assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
		assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
		assert.deepEqual(fs.readFileSync(target), before); assert.equal(leaked!.open, true);
		vault.shutdown("new");
		const alias = join(f.root, "poison-alias"); fs.symlinkSync(f.agent, alias);
		for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
			const fresh = f.vault(reason === "resume" ? alias : f.agent);
			assert.equal(fresh.available(f.ctx), false);
			assert.match((await fresh.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
			fresh.shutdown(reason); assert.equal(fs.existsSync(target), true); assert.equal(leaked!.open, true);
		}
		const reloaded = await import(new URL(`../archive-vault.ts?fixture-reload=${randomUUID()}`, import.meta.url).href);
		const fresh = f.vault(alias, reloaded.ArchiveVault); await fresh.start(f.ctx);
		assert.match(f.notifications.at(-1)!, /startup restore was not performed/);
		assert.deepEqual(f.keychain.gets, []); assert.equal(fresh.available(f.ctx), false);
		assert.match((await fresh.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
		fs.writeFileSync(f.files.statePath, "malformed fixture metadata", { mode: 0o600 });
		const malformed = f.vault(); await malformed.start(f.ctx);
		assert.equal(malformed.available(f.ctx), false); assert.deepEqual(f.keychain.gets, []);
		assert.match((await malformed.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
		assert.deepEqual(fs.readFileSync(target), before); assert.equal(leaked!.open, true);
		const other = fixture(t), unrelated = other.vault();
		assert.equal(unrelated.execute(other.ctx, store => store.append(other.input())), "saved");
		assert.equal(unrelated.available(other.ctx), true); // No unsafe eviction/global poisoning at ordinary size.
	} finally { Native.prototype.close = close; if (leaked?.open) close.call(leaked); }
});

encryptedTest("before-native-source-close failure retains both generations and blocks recovery", async t => {
	const f = fixture(t); const source = await f.encrypted(); const vault = f.vault(); await vault.command("unlock", f.ctx);
	const Native = require("better-sqlite3-multiple-ciphers") as { prototype: NativeFixture }, close = Native.prototype.close;
	let leaked: NativeFixture | undefined;
	Native.prototype.close = function() {
		if (this.name.includes(source.active.id) && !leaked) { leaked = this; throw new Error("synthetic source close failed BEFORE native close"); }
		return close.call(this);
	};
	try {
		try { assert.match((await vault.command(`encryption off ${CONFIRM}`, f.ctx))!, /restart the Pi process/); }
		finally { Native.prototype.close = close; }
		assert.equal(leaked!.open, true); const state = f.files.read(); assert.equal(state?.phase, "transition");
		if (state?.phase !== "transition") assert.fail("transition missing");
		const target = join(f.files.rootPath, "vaults", state.to.active.id, "archive.sqlite");
		assert.equal(fs.existsSync(target), true);
		assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
		assert.equal(fs.existsSync(target), true); assert.equal(leaked!.open, true);
	} finally { Native.prototype.close = close; if (leaked?.open) close.call(leaked); }
});

encryptedTest("startup checks sticky native cleanup failure before credentials/authentication and warns truthfully", async t => {
	const f = fixture(t), state = await f.encrypted("remember"), vault = f.vault(); await vault.start(f.ctx);
	vault.execute(f.ctx, store => store.stats(f.project));
	const Native = require("better-sqlite3-multiple-ciphers") as { prototype: NativeFixture }, close = Native.prototype.close;
	let leaked: NativeFixture | undefined;
	Native.prototype.close = function() { leaked = this; throw new Error("synthetic close failed BEFORE native close"); };
	try {
		try { f.allowed = false; vault.pause(); } finally { Native.prototype.close = close; }
		assert.equal(leaked!.open, true); f.allowed = true;
		const gets = f.keychain.gets.length, notices = f.notifications.length;
		await vault.start(f.ctx);
		assert.equal(f.keychain.gets.length, gets); assert.equal(f.notifications.length, notices + 1);
		assert.match(f.notifications.at(-1)!, /unavailable.*restart the Pi process/);
		assert.doesNotMatch(vault.description(), /unlocked/); assert.equal(vault.available(f.ctx), false);
		vault.shutdown("reload"); const fresh = f.vault(); await fresh.start(f.ctx);
		assert.equal(f.keychain.gets.length, gets); assert.equal(f.prompts, 0); assert.equal(fresh.available(f.ctx), false);
		assert.equal(ready(f.files.read()).remember!.account, state.remember!.account); // Policy pause does not delete remembered authorization.
		assert.equal(leaked!.open, true);
	} finally { Native.prototype.close = close; if (leaked?.open) close.call(leaked); }
});

encryptedTest("Ready publication plus release failure never grants encrypted OR plaintext access or falsely claims Transition", async t => {
	for (const encrypt of [true, false]) for (const failure of ["before-unlink", "after-unlink-fsync", "after-public-helper"]) {
		const f = fixture(t); if (!encrypt) await f.encrypted();
		const vault = f.vault(); if (!encrypt) await vault.command("unlock", f.ctx);
		const lockPath = join(f.files.rootPath, "archive.vault.lock"), unlink = fs.unlinkSync, sync = fs.fsyncSync;
		let failures = 0, releases = 0, unlinked = false, output: string | undefined;
		const migrate = async () => { output = await vault.command(`encryption ${encrypt ? "on" : "off"} ${CONFIRM}`, f.ctx); };
		if (failure === "after-public-helper") {
			const original = ArchiveVaultFiles.prototype.withLockAsync;
			ArchiveVaultFiles.prototype.withLockAsync = async function(run) {
				await original.call(this, run); failures++;
				throw new ArchiveVaultFilesError("LOCK_RELEASE_FAILED");
			};
			try { await migrate(); } finally { ArchiveVaultFiles.prototype.withLockAsync = original; }
		} else {
			await fsFault("unlinkSync", ((path: fs.PathLike) => {
				if (String(path) === lockPath && f.files.read()?.phase === "ready") {
					releases++;
					if (failure === "before-unlink") { failures++; throw new Error("synthetic lock unlink failure"); }
					unlink(path); unlinked = true; return;
				}
				unlink(path);
			}) as typeof fs.unlinkSync, async () => fsFault("fsyncSync", ((fd: number) => {
				if (unlinked && !failures && fs.fstatSync(fd).isDirectory()) { failures++; throw new Error("synthetic release directory fsync failure"); }
				sync(fd);
			}) as typeof fs.fsyncSync, migrate));
			assert.equal(releases, 1); // Never replay uncertain unlink/release.
		}
		assert.equal(failures, 1); const state = ready(f.files.read());
		assert.equal(!!state.active.envelope, encrypt);
		assert.match(output!, /publication may have succeeded/); assert.match(output!, /restart the Pi process/);
		assert.doesNotMatch(output!, /transition remains blocked|rollback recovery required|enabled; unlocked|now plaintext/);
		assert.equal(vault.available(f.ctx), false); assert.doesNotMatch(vault.description(), /unlocked/);
		assert.throws(() => vault.execute(f.ctx, store => store.stats(f.project)), /unavailable/);
		vault.shutdown("reload"); const fresh = f.vault(); await fresh.start(f.ctx);
		assert.equal(fresh.available(f.ctx), false); assert.deepEqual(f.keychain.gets, []);
		assert.match((await fresh.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
		assert.match((await fresh.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
	}
});

encryptedTest("Ready metadata rename/fsync uncertainty fails closed even if actual publication succeeded", async t => {
	const f = fixture(t), vault = f.vault(), rename = fs.renameSync, sync = fs.fsyncSync;
	let publications = 0, readyRenamed = false, failures = 0;
	await fsFault("renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
		rename(from, to);
		if (String(to) === f.files.statePath) { publications++; if (f.files.read()?.phase === "ready") readyRenamed = true; }
	}) as typeof fs.renameSync, async () => fsFault("fsyncSync", ((fd: number) => {
		if (readyRenamed && !failures && fs.fstatSync(fd).isDirectory()) { failures++; throw new Error("synthetic post-Ready rename fsync failure"); }
		sync(fd);
	}) as typeof fs.fsyncSync, async () => {
		const result = await vault.command(`encryption on ${CONFIRM}`, f.ctx);
		assert.match(result!, /publication may have succeeded/); assert.doesNotMatch(result!, /transition remains blocked/);
	}));
	assert.equal(publications, 2); assert.equal(failures, 1); assert.equal(f.files.read()?.phase, "ready");
	assert.equal(vault.available(f.ctx), false); assert.throws(() => vault.execute(f.ctx, store => store.stats(f.project)));
});

encryptedTest("nonpersistent and remembered grants also wait for successful public lock release", async t => {
	for (const remember of [false, true]) {
		const f = fixture(t); await f.encrypted(); const vault = f.vault(), original = ArchiveVaultFiles.prototype.withLock;
		let locks = 0;
		ArchiveVaultFiles.prototype.withLock = function(run) {
			const result = original.call(this, run);
			if (++locks === (remember ? 2 : 1)) throw new ArchiveVaultFilesError("LOCK_RELEASE_FAILED");
			return result as ReturnType<typeof run>;
		};
		try { assert.match((await vault.command(`unlock ${remember ? "remember" : "process"}`, f.ctx))!, /failed/); }
		finally { ArchiveVaultFiles.prototype.withLock = original; }
		assert.equal(vault.available(f.ctx), false); assert.doesNotMatch(vault.description(), /unlocked/);
		assert.equal(f.keychain.keys.size, 0); // Unique uncertain remembered entry is removed, not retried.
		await vault.start(f.ctx); assert.deepEqual(f.keychain.gets, []);
		assert.match(f.notifications.at(-1)!, /startup restore was not performed/);
	}
});

encryptedTest("late public migration-helper failure cannot revoke a newer owner", async t => {
	const f = fixture(t), old = f.vault(), original = ArchiveVaultFiles.prototype.withLockAsync;
	const entered = deferred<void>(), late = deferred<void>();
	ArchiveVaultFiles.prototype.withLockAsync = async function(run) {
		const result = await original.call(this, run); entered.resolve(); await late.promise;
		throw new ArchiveVaultFilesError("LOCK_RELEASE_FAILED");
	};
	let work: Promise<string | undefined> | undefined;
	try {
		work = old.command(`encryption on ${CONFIRM}`, f.ctx); await entered.promise;
		ArchiveVaultFiles.prototype.withLockAsync = original;
		old.shutdown("new"); f.owner = "newer-owner"; const fresh = f.vault(); await fresh.start(f.ctx);
		assert.match((await fresh.command("unlock process", f.ctx))!, /unlocked/);
		assert.equal(fresh.execute(f.ctx, store => store.stats(f.project)).records, 0);
		const changes = f.changes; late.resolve(); await work;
		assert.equal(fresh.available(f.ctx), true); assert.equal(f.changes, changes);
		assert.equal(fresh.execute(f.ctx, store => store.stats(f.project)).records, 0);
	} finally { ArchiveVaultFiles.prototype.withLockAsync = original; late.resolve(); await work; }
});

encryptedTest("late credential cleanup failure after disposal cannot revoke an adopted core", async t => {
	const f = fixture(t); await f.encrypted("remember"); const old = f.vault();
	const entered = deferred<void>(), late = deferred<void>(), deleteKey = f.keychain.delete.bind(f.keychain);
	f.keychain.delete = async account => { entered.resolve(); await late.promise; throw new Error("synthetic late SECRET cleanup failure"); };
	let work: Promise<string | undefined> | undefined;
	try {
		work = old.command("unlock process", f.ctx); await entered.promise;
		assert.equal(old.available(f.ctx), true);
		old.shutdown("new"); f.owner = "adopter"; const fresh = f.vault(); await fresh.start(f.ctx);
		assert.equal(fresh.available(f.ctx), true); fresh.execute(f.ctx, store => store.stats(f.project));
		const changes = f.changes; late.resolve(); assert.match((await work)!, /deletion failed/);
		assert.equal(fresh.available(f.ctx), true); assert.equal(f.changes, changes);
		assert.equal(fresh.execute(f.ctx, store => store.stats(f.project)).records, 1);
		assert.doesNotMatch(fresh.description(), /cleanup failed/);
	} finally { f.keychain.delete = deleteKey; late.resolve(); await work; }
});

test("plaintext explicit-lock release uncertainty also blocks subsequent local data access", async t => {
	const f = fixture(t); plaintextActive(f); const vault = f.vault(), original = ArchiveVaultFiles.prototype.withLockAsync;
	ArchiveVaultFiles.prototype.withLockAsync = async function(run) {
		await original.call(this, run); throw new ArchiveVaultFilesError("LOCK_RELEASE_FAILED");
	};
	try { assert.match((await vault.command("lock", f.ctx))!, /durable revocation could not be confirmed/); }
	finally { ArchiveVaultFiles.prototype.withLockAsync = original; }
	assert.equal(f.files.read()?.phase, "ready"); assert.equal(vault.available(f.ctx), false);
	assert.throws(() => vault.execute(f.ctx, store => store.stats(f.project)), /unavailable/);
});

test("poison registry never evicts unsafe roots on overflow and unknown root close failure fails closed globally", () => {
	// Global overflow/unknown-root poisoning intentionally persists until real
	// process exit, so isolate these boundary probes in fresh synthetic children.
	for (const mode of ["overflow", "unknown-root"]) {
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			import assert from 'node:assert/strict';
			import fs from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; import {randomUUID} from 'node:crypto';
			import {ArchiveVault} from ${JSON.stringify(new URL("../archive-vault.ts", import.meta.url).href)};
			import {ArchiveStore} from ${JSON.stringify(new URL("../archive-store.ts", import.meta.url).href)};
			import {ArchiveVaultFiles} from ${JSON.stringify(new URL("../archive-vault-files.ts", import.meta.url).href)};
			const root=fs.mkdtempSync(join(tmpdir(),'jarvis-poison-boundary-fixture-')); fs.chmodSync(root,0o700);
			let gets=0, prompts=0; const notices=[];
			const ctx={cwd:root,hasUI:true,mode:'tui',isProjectTrusted:()=>true,sessionManager:{getSessionId:()=> 'fixture-main'},ui:{notify:m=>notices.push(m)}};
			const options={isAllowed:()=>true,onChange:()=>{},prompt:async()=>{prompts++;return undefined;},keychain:{get:async()=>{gets++;return undefined;},set:async()=>{},delete:async()=>{}}};
			const facades=[];
			function facade(agent,broken=false) {
				const legacy=new ArchiveStore(agent); let attempted=false;
				if(broken) legacy.close=()=>{if(!attempted){attempted=true;throw Error('synthetic uncertain close');}};
				const v=new ArchiveVault(agent,legacy,options);facades.push(v);return v;
			}
			try {
				if(${JSON.stringify(mode)}==='overflow') {
					for(let i=0;i<65;i++) { const v=facade(join(root,'agent-'+i),true);v.pause();v.shutdown('reload'); }
					const oldest=facade(join(root,'agent-0'));assert.equal(oldest.available(ctx),false);
					assert.match(await oldest.command('encryption recover --rollback --confirm-sensitive --confirm-stopped',ctx),/restart the Pi process/);
				} else {
					const agent=join(root,'unknown'),outside=join(root,'outside');fs.mkdirSync(agent,{mode:0o700});fs.mkdirSync(outside,{mode:0o700});fs.symlinkSync(outside,join(agent,'extensions'));
					const v=facade(agent,true);v.pause();v.shutdown('quit');
				}
				const freshAgent=join(root,'unrelated-after-global-poison'),files=new ArchiveVaultFiles(freshAgent);
				files.withLock(locked=>locked.write({format:'pi-jarvis-archive-vault',version:1,phase:'ready',revision:randomUUID(),
					active:{id:${JSON.stringify(material.envelope.vaultId)},envelope:${JSON.stringify(material.envelope)}},startup:'remember',remember:{account:'a'.repeat(64)},retired:[]}));
				const fresh=facade(freshAgent);await fresh.start(ctx);assert.equal(gets,0);assert.equal(prompts,0);assert.equal(fresh.available(ctx),false);
				assert.match(notices.at(-1),/startup restore was not performed/);assert.doesNotMatch(fresh.description(),/unlocked/);
			} finally {for(const v of facades)v.shutdown('quit');fs.rmSync(root,{recursive:true,force:true});}
		`], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
		assert.equal(child.status, 0, `${mode} fixture failed: ${child.stderr}`);
	}
});

encryptedTest("startup release failure warns no usable grant, rather than claiming work was not performed", async t => {
	const f = fixture(t); await f.encrypted("remember"); const vault = f.vault(), original = ArchiveVaultFiles.prototype.withLock;
	ArchiveVaultFiles.prototype.withLock = function(run) {
		original.call(this, run); throw new ArchiveVaultFilesError("LOCK_RELEASE_FAILED");
	};
	try { await vault.start(f.ctx); } finally { ArchiveVaultFiles.prototype.withLock = original; }
	assert.equal(f.keychain.gets.length, 1); assert.equal(vault.available(f.ctx), false);
	assert.match(f.notifications.at(-1)!, /did not provide a usable grant/);
	assert.doesNotMatch(f.notifications.at(-1)!, /was not performed|unlocked/);
});

test("plaintext cleanup metadata publication uncertainty also blocks access without replay", async t => {
	const f = fixture(t); plaintextActive(f); const vault = f.vault(), rename = fs.renameSync, sync = fs.fsyncSync;
	let renamed = false, publications = 0, failures = 0;
	await fsFault("renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
		rename(from, to); if (String(to) === f.files.statePath) { renamed = true; publications++; }
	}) as typeof fs.renameSync, async () => fsFault("fsyncSync", ((fd: number) => {
		if (renamed && !failures && fs.fstatSync(fd).isDirectory()) { failures++; throw new Error("synthetic metadata publication failure"); }
		sync(fd);
	}) as typeof fs.fsyncSync, async () => {
		const result = await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx);
		assert.match(result!, /Publication may have succeeded/); assert.match(result!, /restart the Pi process/);
	}));
	assert.equal(publications, 1); assert.equal(failures, 1); assert.equal(f.files.read()?.phase, "ready");
	assert.equal(vault.available(f.ctx), false);
	assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
});

encryptedTest("plaintext migration refuses fixed/idle timed grants without copying key, publishing marker or extending deadline", async t => {
	for (const idle of [false, true]) {
		const f = fixture(t); await f.encrypted(); const vault = f.vault();
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
		try {
			await vault.command(`unlock ${idle ? "idle" : "for"} 1`, f.ctx);
			const state = f.files.read(), directories = fs.readdirSync(join(f.files.rootPath, "vaults")), notices = f.notifications.length;
			t.mock.timers.tick(40_000);
			assert.match((await vault.command(`encryption off ${CONFIRM}`, f.ctx))!, /cannot use a timed unlock.*unlock session or process/);
			assert.deepEqual(f.files.read(), state); assert.deepEqual(fs.readdirSync(join(f.files.rootPath, "vaults")), directories);
			assert.equal(f.notifications.length, notices); assert.equal(vault.available(f.ctx), true);
			t.mock.timers.tick(20_001); assert.equal(vault.available(f.ctx), false); // Original fixed OR idle deadline.
			await vault.command("unlock process", f.ctx);
			assert.match((await vault.command(`encryption off ${CONFIRM}`, f.ctx))!, /now plaintext/);
		} finally { t.mock.timers.reset(); }
	}
});

encryptedTest("encrypted cleanup rejects locked, wrong-key and missing active DB before any retired deletion", async t => {
	for (const fault of ["locked", "wrong-key", "missing"]) {
		const f = fixture(t), state = await f.encrypted(), legacy = join(f.files.rootPath, "archive.sqlite"), vault = f.vault();
		f.files.withLock(locked => locked.write({ ...state, retired: [{ id: "legacy", envelope: null }] }));
		fs.writeFileSync(legacy, "synthetic retired backup", { mode: 0o600 });
		const before = f.files.read(), activePath = join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite");
		if (fault !== "locked") await vault.command("unlock", f.ctx);
		if (fault === "missing") fs.unlinkSync(activePath);
		if (fault === "wrong-key") {
			fs.unlinkSync(activePath);
			const wrongKey = Buffer.alloc(32, 19), writer = new ArchiveStore(f.agent, { managed: true, storageId: state.active.id,
				databaseFactory: (path, options) => openEncryptedArchiveDatabase(path, wrongKey, options) }); f.stores.push(writer);
			try { writer.append(f.input("synthetic wrong-key DB")); writer.close(); } finally { wrongKey.fill(0); }
		}
		const unlink = fs.unlinkSync; let deleted = 0;
		await fsFault("unlinkSync", ((path: fs.PathLike) => {
			if (String(path).startsWith(legacy)) deleted++;
			unlink(path);
		}) as typeof fs.unlinkSync, async () => {
			const result = await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx);
			assert.match(result!, fault === "locked" ? /Unlock the encrypted active archive before cleanup/ : /failed|missing/);
			assert.doesNotMatch(result!, /retired generation\(s\) removed/);
		});
		assert.equal(deleted, 0); assert.equal(fs.readFileSync(legacy, "utf8"), "synthetic retired backup");
		assert.deepEqual(f.files.read(), before); assert.equal(vault.available(f.ctx), false);
		if (fault === "missing") assert.equal(fs.existsSync(activePath), false); // No recreation during authentication.
	}
});

encryptedTest("encrypted cleanup rechecks live timed authorization across lock boundary", async t => {
	const f = fixture(t), state = await f.encrypted(), vault = f.vault(), legacy = join(f.files.rootPath, "archive.sqlite");
	f.files.withLock(locked => locked.write({ ...state, retired: [{ id: "legacy", envelope: null }] }));
	fs.writeFileSync(legacy, "synthetic retired backup", { mode: 0o600 });
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
	const original = ArchiveVaultFiles.prototype.withLock;
	try {
		await vault.command("unlock for 1", f.ctx);
		ArchiveVaultFiles.prototype.withLock = function(run) {
			return original.call(this, locked => { t.mock.timers.tick(60_001); return run(locked); }) as ReturnType<typeof run>;
		};
		assert.match((await vault.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /cancelled|expired|revoked/);
	} finally { ArchiveVaultFiles.prototype.withLock = original; t.mock.timers.reset(); }
	assert.equal(fs.readFileSync(legacy, "utf8"), "synthetic retired backup");
	assert.equal(ready(f.files.read()).retired.length, 1); assert.equal(vault.available(f.ctx), false);
});

encryptedTest("native factory profile/auth failure plus pre-return close failure poisons unlock/start/execute/migration across facades", async t => {
	for (const phase of ["profile", "auth"]) for (const action of ["unlock", "start", "execute", "migration"]) {
		const f = fixture(t);
		if (action !== "migration") await f.encrypted(action === "start" ? "remember" : "manual");
		const vault = f.vault();
		if (action === "execute") await vault.command("unlock process", f.ctx);
		if (action === "migration") vault.execute(f.ctx, store => store.append(f.input()));
		const Native = require("better-sqlite3-multiple-ciphers") as { prototype: NativeFixture & { exec(sql: string): void; prepare(sql: string): unknown } };
		const close = Native.prototype.close, exec = Native.prototype.exec, prepare = Native.prototype.prepare;
		let leaked: NativeFixture | undefined, closes = 0;
		Native.prototype.exec = function(sql) {
			if (phase === "profile" && !leaked && this.name.startsWith(f.files.rootPath) && sql.startsWith("PRAGMA cipher=")) {
				leaked = this; throw new Error("synthetic native profile SECRET failure before Store assignment");
			}
			return exec.call(this, sql);
		};
		Native.prototype.prepare = function(sql) {
			if (phase === "auth" && !leaked && this.name.startsWith(f.files.rootPath) && sql === "SELECT name FROM sqlite_schema LIMIT 1") {
				leaked = this; throw new Error("synthetic native auth SECRET failure before Store assignment");
			}
			return prepare.call(this, sql);
		};
		Native.prototype.close = function() {
			if (this === leaked) { closes++; throw new Error("synthetic close failed BEFORE actual native close"); }
			return close.call(this);
		};
		try {
			let result: string | undefined;
			try {
				if (action === "start") await vault.start(f.ctx);
				else if (action === "execute") {
					assert.throws(() => vault.execute(f.ctx, store => store.stats(f.project)), error => {
						assert.equal(Object.getOwnPropertyDescriptor(error, "closeFailed")?.value, true);
						assert.doesNotMatch((error as Error).message, /SECRET/); return true;
					});
				} else result = await vault.command(action === "migration" ? `encryption on ${CONFIRM}` : "unlock", f.ctx);
			} finally { Native.prototype.exec = exec; Native.prototype.prepare = prepare; Native.prototype.close = close; }
			assert.equal(leaked!.open, true); assert.equal(closes, 1); assert.equal(vault.available(f.ctx), false);
			assert.doesNotMatch(vault.description(), /unlocked|SECRET/);
			if (result) { assert.match(result, /restart the Pi process/); assert.doesNotMatch(result, /SECRET/); }
			if (action === "start") assert.match(f.notifications.at(-1)!, /did not provide a usable grant/);
			const leakedPath = leaked!.name; assert.equal(fs.existsSync(leakedPath), true);
			vault.shutdown("new"); const fresh = f.vault(); await fresh.start(f.ctx);
			assert.equal(fresh.available(f.ctx), false);
			assert.match((await fresh.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
			assert.match((await fresh.command(`encryption cleanup ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
			fresh.shutdown("reload"); const newest = f.vault(); await newest.start(f.ctx);
			assert.equal(newest.available(f.ctx), false); assert.equal(fs.existsSync(leakedPath), true); assert.equal(leaked!.open, true);
			assert.match((await newest.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /restart the Pi process/);
		} finally { Native.prototype.exec = exec; Native.prototype.prepare = prepare; Native.prototype.close = close; if (leaked?.open) close.call(leaked); }
	}
});

function pendingTarget(f: ReturnType<typeof fixture>, from: VaultReady | null, flag?: boolean) {
	const to: VaultReady = { format: "pi-jarvis-archive-vault", version: 1, phase: "ready", revision: randomUUID(),
		active: { id: randomUUID(), envelope: null }, startup: "manual", retired: [from?.active ?? { id: "legacy", envelope: null }] };
	const state: VaultState = { format: "pi-jarvis-archive-vault", version: 1, phase: "transition", revision: randomUUID(), from, to,
		...(flag === undefined ? {} : { legacySourcePresent: flag }) };
	f.files.withLock(locked => { locked.write(state); locked.ensureStorageDir(to.active.id); });
	return { state, path: join(f.files.rootPath, "vaults", to.active.id, "archive.sqlite") };
}
function seedUnpublishedTarget(f: ReturnType<typeof fixture>) {
	const state = f.files.read(); assert.equal(state?.phase, "transition"); if (state?.phase !== "transition") assert.fail("transition missing");
	const dir = join(f.files.rootPath, "vaults", state.to.active.id);
	if (!fs.existsSync(dir)) f.files.withLock(locked => locked.ensureStorageDir(state.to.active.id));
	const path = join(dir, "archive.sqlite"); fs.writeFileSync(path, "synthetic nonempty last potential target copy", { mode: 0o600 });
	return path;
}

test("missing/zero/unsafe managed plaintext source refuses encryption before prompt/marker with no empty cipher", async t => {
	for (const mutation of ["missing", "zero", "unsafe"]) {
		const f = fixture(t), state = plaintextActive(f), vault = f.vault();
		const path = join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite"), metadata = fs.readFileSync(f.files.statePath);
		if (mutation === "missing") fs.unlinkSync(path); else if (mutation === "zero") fs.truncateSync(path, 0); else fs.chmodSync(path, 0o644);
		assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/);
		assert.equal(f.prompts, 0); assert.equal(f.notifications.length, 0); assert.deepEqual(fs.readFileSync(f.files.statePath), metadata);
		assert.deepEqual(fs.readdirSync(join(f.files.rootPath, "vaults")), [state.active.id]);
		assert.equal(fs.existsSync(join(f.files.rootPath, "archive.sqlite")), false); assert.deepEqual(f.keychain.gets, []);
	}
});

test("source presence changed during password setup refuses before Transition publication", async t => {
	for (const kind of ["managed-disappear", "legacy-appear", "legacy-zero"]) {
		const f = fixture(t), state = kind === "managed-disappear" ? plaintextActive(f) : undefined, vault = f.vault();
		const path = state ? join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite") : join(f.files.rootPath, "archive.sqlite");
		if (kind === "legacy-zero") { fs.mkdirSync(f.files.rootPath, { recursive: true, mode: 0o700 }); fs.writeFileSync(path, "", { mode: 0o600 }); }
		f.prompt = async () => {
			if (state && fs.existsSync(path)) fs.unlinkSync(path);
			if (!state) { fs.mkdirSync(f.files.rootPath, { recursive: true, mode: 0o700 }); fs.writeFileSync(path, "synthetic appeared source", { mode: 0o600 }); }
			return PASSWORD;
		};
		assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/);
		assert.deepEqual(f.files.read(), state); assert.equal(f.prompts, kind === "legacy-zero" ? 0 : 2);
		assert.equal(fs.existsSync(join(f.files.rootPath, "vaults")), !!state);
	}
});

encryptedTest("managed source disappearance/replacement mid-copy guard retains target and never publishes Ready", async t => {
	for (const mutation of ["remove", "replace"]) {
		const f = fixture(t), state = plaintextActive(f), vault = f.vault();
		const path = join(f.files.rootPath, "vaults", state.active.id, "archive.sqlite");
		const validate = ArchiveStore.prototype.migrationValidateRecord; let changed = false;
		ArchiveStore.prototype.migrationValidateRecord = function(row) {
			validate.call(this, row);
			if (!changed) { changed = true; fs.renameSync(path, join(f.root, "retained-source.sqlite"));
				if (mutation === "replace") fs.copyFileSync(join(f.root, "retained-source.sqlite"), path); }
		};
		try { assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration.*transition remains blocked/); }
		finally { ArchiveStore.prototype.migrationValidateRecord = validate; }
		assert.equal(changed, true); const transition = f.files.read(); assert.equal(transition?.phase, "transition");
		if (transition?.phase !== "transition") assert.fail("unverified target published");
		assert.equal(transition.legacySourcePresent, undefined); assert.equal(vault.available(f.ctx), false);
		const target = join(f.files.rootPath, "vaults", transition.to.active.id, "archive.sqlite"); assert.ok(fs.statSync(target).size > 0);
		if (mutation === "replace") fs.unlinkSync(path);
		const metadata = fs.readFileSync(f.files.statePath), bytes = fs.readFileSync(target);
		assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/);
		assert.deepEqual(fs.readFileSync(f.files.statePath), metadata); assert.deepEqual(fs.readFileSync(target), bytes);
	}
});

encryptedTest("missing managed cipher source rollback retains a nonempty target and exact Transition", async t => {
	const f = fixture(t), from = await f.encrypted(), vault = f.vault(), target = pendingTarget(f, from);
	fs.writeFileSync(target.path, "synthetic last potential copy", { mode: 0o600 });
	fs.unlinkSync(join(f.files.rootPath, "vaults", from.active.id, "archive.sqlite"));
	const metadata = fs.readFileSync(f.files.statePath), bytes = fs.readFileSync(target.path);
	assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/);
	assert.deepEqual(fs.readFileSync(f.files.statePath), metadata); assert.deepEqual(fs.readFileSync(target.path), bytes); assert.equal(f.prompts, 0);
});

encryptedTest("new legacy-present marker records true; vanished source refuses copy and rollback without deleting target", async t => {
	const f = fixture(t), vault = f.vault(); vault.execute(f.ctx, store => store.append(f.input()));
	const source = join(f.files.rootPath, "archive.sqlite");
	f.onChange = () => { if (f.files.read()?.phase === "transition" && fs.existsSync(source)) fs.unlinkSync(source); };
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/); f.onChange = () => {};
	const transition = f.files.read(); assert.equal(transition?.phase, "transition");
	if (transition?.phase !== "transition") assert.fail("transition missing"); assert.equal(transition.legacySourcePresent, true);
	const target = seedUnpublishedTarget(f), metadata = fs.readFileSync(f.files.statePath), bytes = fs.readFileSync(target);
	assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/);
	assert.deepEqual(fs.readFileSync(f.files.statePath), metadata); assert.deepEqual(fs.readFileSync(target), bytes);
});

encryptedTest("new initially absent legacy marker records false, lock preserves it and explicit failed-setup rollback works", async t => {
	const f = fixture(t), vault = f.vault();
	f.onChange = () => { if (f.files.read()?.phase === "transition") f.allowed = false; };
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /transition remains blocked/); f.onChange = () => {};
	let transition = f.files.read(); if (transition?.phase !== "transition") assert.fail("transition missing");
	assert.equal(transition.legacySourcePresent, false); const revision = transition.revision;
	const target = seedUnpublishedTarget(f); assert.match((await vault.command("lock", f.ctx))!, /locked durably/);
	transition = f.files.read(); if (transition?.phase !== "transition") assert.fail("transition missing");
	assert.notEqual(transition.revision, revision); assert.equal(transition.legacySourcePresent, false);
	f.allowed = true; assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /rolled back.*explicitly absent/);
	assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(join(f.files.rootPath, "archive.sqlite")), false);
	assert.equal(ready(f.files.read()).active.id, "legacy"); assert.equal(vault.available(f.ctx), true);
});

encryptedTest("unexpected legacy source appearance after false marker refuses copy and rollback", async t => {
	const f = fixture(t), vault = f.vault();
	f.onChange = () => { if (f.files.read()?.phase === "transition") fs.writeFileSync(join(f.files.rootPath, "archive.sqlite"), "synthetic appeared source", { mode: 0o600 }); };
	assert.match((await vault.command(`encryption on ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/); f.onChange = () => {};
	const transition = f.files.read(); if (transition?.phase !== "transition") assert.fail("transition missing"); assert.equal(transition.legacySourcePresent, false);
	const target = seedUnpublishedTarget(f), metadata = fs.readFileSync(f.files.statePath), bytes = fs.readFileSync(target);
	assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/);
	assert.deepEqual(fs.readFileSync(f.files.statePath), metadata); assert.deepEqual(fs.readFileSync(target), bytes);
});

test("old unflagged absent legacy source conservatively retains any target files; data-free rollback is explicit", async t => {
	for (const sourceKind of ["initial", "ready-legacy"]) for (const targetKind of ["nonempty", "zero", "sidecar", "absent"]) {
		const f = fixture(t), vault = f.vault();
		const from: VaultReady | null = sourceKind === "initial" ? null : { format: "pi-jarvis-archive-vault", version: 1, phase: "ready", revision: randomUUID(),
			active: { id: "legacy", envelope: null }, startup: "manual", retired: [] };
		const target = pendingTarget(f, from), path = target.path + (targetKind === "sidecar" ? "-wal" : "");
		if (targetKind !== "absent") fs.writeFileSync(path, targetKind === "zero" ? "" : "synthetic only potential copy", { mode: 0o600 });
		const metadata = fs.readFileSync(f.files.statePath);
		const result = await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx);
		if (targetKind === "absent") {
			assert.match(result!, /rolled back.*presence was unrecorded.*no data files were deleted/); assert.equal(ready(f.files.read()).active.id, "legacy");
		} else {
			assert.match(result!, /Manual source inspection\/restoration/); assert.deepEqual(fs.readFileSync(f.files.statePath), metadata); assert.equal(fs.existsSync(path), true);
		}
	}
});

test("rollback rechecks known source after target preflight before the first unlink", async t => {
	const f = fixture(t), from = plaintextActive(f), vault = f.vault(), target = pendingTarget(f, from);
	fs.writeFileSync(target.path, "synthetic only potential copy", { mode: 0o600 });
	const source = join(f.files.rootPath, "vaults", from.active.id, "archive.sqlite"), metadata = fs.readFileSync(f.files.statePath);
	const original = fs.openSync; let removed = false;
	fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
		const fd = (original as Function)(path, ...args);
		if (String(path) === target.path && !removed) { removed = true; fs.unlinkSync(source); }
		return fd;
	}) as typeof fs.openSync; syncBuiltinESMExports();
	try { assert.match((await vault.command(`encryption recover --rollback ${CONFIRM}`, f.ctx))!, /Manual source inspection\/restoration/); }
	finally { fs.openSync = original; syncBuiltinESMExports(); }
	assert.equal(removed, true); assert.deepEqual(fs.readFileSync(f.files.statePath), metadata); assert.equal(fs.readFileSync(target.path, "utf8"), "synthetic only potential copy");
});
