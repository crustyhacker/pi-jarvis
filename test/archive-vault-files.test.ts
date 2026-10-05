import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import {
	ArchiveVaultFiles, ArchiveVaultFilesError, parseVaultState,
	type ArchiveVaultLocked, type VaultGeneration, type VaultReady, type VaultState, type VaultTransition,
} from "../archive-vault-files.js";
import type { ArchiveKeyEnvelope } from "../archive-crypto.js";

const names = ["archive.sqlite", "archive.sqlite-wal", "archive.sqlite-shm", "archive.sqlite-journal"];
function envelope(id: string): ArchiveKeyEnvelope {
	return {
		format: "pi-jarvis-archive-key", version: 1, vaultId: id, cipher: "sqlcipher4",
		passwordSlot: {
			kind: "password", kdf: { name: "scrypt", N: 131072, r: 8, p: 1 }, wrapCipher: "aes-256-gcm",
			salt: Buffer.alloc(32, 1).toString("base64"), nonce: Buffer.alloc(12, 2).toString("base64"),
			wrappedKey: Buffer.alloc(32, 3).toString("base64"), tag: Buffer.alloc(16, 4).toString("base64"),
		},
	};
}
function ready(encrypted = false): VaultReady {
	const id = randomUUID();
	return { format: "pi-jarvis-archive-vault", version: 1, phase: "ready", revision: randomUUID(),
		active: { id, envelope: encrypted ? envelope(id) : null }, startup: "manual", retired: [] };
}
function transition(from: VaultReady | null = null): VaultTransition {
	const to = ready(true); to.retired.push(from?.active ?? { id: "legacy", envelope: null });
	return { format: "pi-jarvis-archive-vault", version: 1, phase: "transition", revision: randomUUID(), from, to };
}
function fixture(t: TestContext) {
	const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-jarvis-vault-files-"))), agent = join(base, "agent");
	const files = new ArchiveVaultFiles(agent), root = join(agent, "extensions", "pi-jarvis-archive");
	const state = join(root, "archive.vault.json"), lock = join(root, "archive.vault.lock");
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const put = (value: string | Buffer) => {
		fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.writeFileSync(state, value, { mode: 0o600 });
	};
	const save = (value: VaultState = ready()) => { files.withLock(locked => locked.write(value)); return value; };
	return { base, agent, files, root, state, lock, put, save };
}
function fails(run: () => unknown, code?: string): void {
	assert.throws(run, (error: unknown) => error instanceof ArchiveVaultFilesError && (!code || error.code === code));
}
// Faults operate only on fixture I/O and are reset before the next test.
function fault<K extends "openSync" | "fstatSync" | "lstatSync" | "readSync" | "writeFileSync" | "renameSync" | "fsyncSync" | "unlinkSync">(
	key: K, replace: typeof fs[K], run: () => void,
): void {
	const original = fs[key]; fs[key] = replace; syncBuiltinESMExports();
	try { run(); } finally { fs[key] = original; syncBuiltinESMExports(); }
}

test("constructor and absent metadata reads/getters are inert, lazy and canonical", t => {
	const f = fixture(t);
	assert.equal(f.files.rootPath, f.root); assert.equal(f.files.agentRootPath, f.agent); assert.equal(f.files.statePath, f.state);
	assert.equal(f.files.read(), undefined); assert.deepEqual(fs.readdirSync(f.base), []);
	const absent = join(f.base, "missing", "nested", "agent");
	assert.equal(new ArchiveVaultFiles(absent).read(), undefined);
	assert.deepEqual(fs.readdirSync(f.base), []);
	fs.mkdirSync(f.agent, { mode: 0o700 }); fs.symlinkSync(f.agent, join(f.base, "alias"));
	const alias = new ArchiveVaultFiles(join(f.base, "alias"));
	assert.equal(alias.agentRootPath, fs.realpathSync(f.agent)); assert.equal(alias.rootPath, f.root);
	assert.equal(alias.read(), undefined); assert.deepEqual(fs.readdirSync(f.agent), []);
});

test("all supported phases, encrypted/plaintext startup policies and rollback legacy round-trip detached", t => {
	const f = fixture(t), states: VaultState[] = [ready(), ready(true), transition(), transition(ready(true))];
	const remembered = ready(true); remembered.startup = "remember"; remembered.remember = { account: "a".repeat(64) };
	const prompt = ready(); prompt.startup = "prompt";
	const rollback = ready(); rollback.active = { id: "legacy", envelope: null };
	states.push(remembered, prompt, rollback);
	for (const state of states) {
		f.save(state); const read = f.files.read(); assert.deepEqual(read, state); assert.notEqual(read, state);
		assert.equal(fs.statSync(f.state).mode & 0o777, 0o600);
	}
	assert.equal(fs.statSync(f.root).mode & 0o777, 0o700);
	assert.equal(fs.existsSync(f.lock), false);
	assert.deepEqual(fs.readdirSync(f.root), ["archive.vault.json"]);
});

test("strict schema rejects future/foreign keys, duplicate IDs, mismatched envelopes and invalid remember", () => {
	const good = ready(true), other = ready(true), cases: unknown[] = [
		null, [], 42, { ...good, version: 2 }, { ...good, format: "future" }, { ...good, phase: "future" },
		{ ...good, revision: "not-uuid" }, { ...good, revision: good.revision.toUpperCase() }, { ...good, secret: "private-secret" },
		{ ...good, active: { ...good.active, password: "private-secret" } },
		{ ...good, active: { id: "../escape", envelope: null } }, { ...good, active: { id: "legacy", envelope: good.active.envelope } },
		{ ...good, active: { ...good.active, envelope: other.active.envelope } },
		{ ...good, retired: [good.active] }, { ...good, retired: [other.active, other.active] },
		{ ...good, retired: Array.from({ length: 9 }, () => ready().active) }, { ...good, retired: [{ id: "legacy", envelope: good.active.envelope }] },
		{ ...good, startup: "future" }, { ...good, startup: "remember" },
		{ ...good, remember: { account: "a".repeat(64) } },
		{ ...ready(), startup: "remember", remember: { account: "a".repeat(64) } },
		{ ...good, startup: "remember", remember: { account: "A".repeat(64) } },
		{ ...good, startup: "remember", remember: { account: "a".repeat(64), foreign: true } },
		{ ...good, active: { ...good.active, envelope: { ...good.active.envelope, future: true } } },
	];
	for (const value of cases) fails(() => parseVaultState(value), "INVALID_STATE");
	const broken = structuredClone(good); Object.assign(broken.active.envelope!.passwordSlot.kdf, { N: 1 });
	fails(() => parseVaultState(broken), "INVALID_STATE");
});

test("transition is bounded and preserves the exact source envelope, with a fresh UUID target", () => {
	const from = ready(true), good = transition(from);
	assert.deepEqual(parseVaultState(good), good);
	const missing = structuredClone(good); missing.to.retired = [];
	const changed: VaultTransition = JSON.parse(JSON.stringify(good)); Object.assign(changed.to.retired[0].envelope!.passwordSlot, { tag: Buffer.alloc(16, 9).toString("base64") });
	const same = structuredClone(good); same.to.active = from.active; same.to.retired = [];
	const legacyTarget = structuredClone(good); legacyTarget.to.active = { id: "legacy", envelope: null };
	for (const value of [missing, changed, same, legacyTarget, { ...good, from: good }, { ...good, to: good }, { ...good, future: true }]) {
		fails(() => parseVaultState(value), "INVALID_STATE");
	}
	const initial = transition(); initial.to.retired = [];
	fails(() => parseVaultState(initial), "INVALID_STATE");
});

test("getters, proxies, custom prototypes, sparse arrays, symbols and serializers never execute", () => {
	let invoked = 0;
	const good = ready(), getter = { ...good };
	Object.defineProperty(getter, "active", { enumerable: true, get() { invoked++; throw new Error("private-secret"); } });
	const nested = { ...good.active }; Object.defineProperty(nested, "envelope", { enumerable: true, get() { invoked++; return null; } });
	const proxy = new Proxy(good, { ownKeys() { invoked++; return []; } });
	const array: VaultGeneration[] = []; array.length = 1;
	const arrayGetter = [good.active]; Object.defineProperty(arrayGetter, "0", { get() { invoked++; return good.active; }, enumerable: true });
	for (const value of [getter, proxy, Object.create(good), { ...good, active: nested }, { ...good, [Symbol("hidden")]: 1 },
		{ ...good, toJSON() { invoked++; return good; } }, { ...good, retired: array }, { ...good, retired: arrayGetter }]) {
		fails(() => parseVaultState(value), "INVALID_STATE");
	}
	const hidden = { ...good }; Object.defineProperty(hidden, "startup", { value: "manual", enumerable: false });
	fails(() => parseVaultState(hidden), "INVALID_STATE"); assert.equal(invoked, 0);
});

test("malformed, oversized, duplicate-member, deep and non-UTF8 metadata fails closed with byte preservation", t => {
	const f = fixture(t), good = JSON.stringify(ready());
	const bad = [
		Buffer.from('{"private-secret": BROKEN'), Buffer.from("[]"), Buffer.from("null"),
		Buffer.from(good.replace('"phase":"ready"', '"phase":"ready","ph\\u0061se":"ready"')),
		Buffer.from(good.replace('"active":{', '"active":{"id":"ignored",')),
		Buffer.from(" ".repeat(65537)), Buffer.from('['.repeat(20) + '0' + ']'.repeat(20)),
		Buffer.concat([Buffer.from('{"secret":"'), Buffer.from([0xff]), Buffer.from('"}')]),
	];
	for (const bytes of bad) {
		f.put(bytes); fails(() => f.files.read()); fails(() => f.save());
		assert.deepEqual(fs.readFileSync(f.state), bytes); assert.equal(fs.existsSync(f.lock), false);
		assert.deepEqual(fs.readdirSync(f.root), ["archive.vault.json"]);
	}
});

test("missing manifest with vaults rejects incomplete managed storage; first transition precedes mkdir", t => {
	const f = fixture(t);
	f.files.withLock(locked => { assert.equal(locked.read(), undefined); fails(() => locked.ensureStorageDir(randomUUID()), "UNSAFE_STORAGE"); });
	assert.equal(fs.existsSync(join(f.root, "vaults")), false);
	const pending = transition(); f.save(pending);
	const target = f.files.withLock(locked => locked.ensureStorageDir(pending.to.active.id));
	assert.deepEqual(fs.readdirSync(target), []); assert.equal(fs.statSync(target).mode & 0o777, 0o700);
	f.files.withLock(locked => fails(() => locked.ensureStorageDir(pending.to.active.id), "UNSAFE_STORAGE"));
	fs.unlinkSync(f.state); fails(() => f.files.read(), "UNSAFE_STORAGE"); fails(() => f.save(), "UNSAFE_STORAGE");
	assert.equal(fs.existsSync(f.state), false);
});

test("unsafe permissions, hardlinks, appended symlinks and special files never get repaired", t => {
	const f = fixture(t); f.save(); const original = fs.readFileSync(f.state);
	for (const path of [f.root, f.state]) {
		const mode = fs.statSync(path).mode & 0o777; fs.chmodSync(path, 0o777);
		fails(() => f.files.read(), "UNSAFE_STORAGE"); fails(() => f.save()); fs.chmodSync(path, mode);
		assert.deepEqual(fs.readFileSync(f.state), original);
	}
	fs.linkSync(f.state, join(f.base, "hardlink")); fails(() => f.files.read(), "UNSAFE_STORAGE"); fails(() => f.save());
	fs.unlinkSync(join(f.base, "hardlink"));
	fs.renameSync(f.state, join(f.base, "original")); fs.symlinkSync(join(f.base, "original"), f.state);
	fails(() => f.files.read(), "UNSAFE_STORAGE"); fails(() => f.save());
	assert.deepEqual(fs.readFileSync(join(f.base, "original")), original);
	fs.unlinkSync(f.state); fs.mkdirSync(f.state, { mode: 0o700 }); fails(() => f.files.read(), "UNSAFE_STORAGE");
});

test("canonical agent alias is allowed but owned appended directories cannot be symlinks", t => {
	const f = fixture(t); fs.mkdirSync(f.agent, { mode: 0o700 });
	const foreign = join(f.base, "outside"); fs.mkdirSync(foreign, { mode: 0o700 });
	fs.symlinkSync(foreign, join(f.agent, "extensions"));
	fails(() => f.files.read(), "UNSAFE_STORAGE"); fails(() => f.save()); assert.deepEqual(fs.readdirSync(foreign), []);
});

test("foreign-owned files and owned directory ancestors fail even under privileged test runners", t => {
	const f = fixture(t); f.save(); const original = fs.lstatSync;
	for (const path of [f.base, f.agent, join(f.agent, "extensions"), f.root, f.state]) {
		fault("lstatSync", ((target: fs.PathLike, ...args: unknown[]) => {
			const result = (original as Function)(target, ...args);
			if (String(target) === path) result.uid = (process.getuid?.() ?? 0) + 1;
			return result;
		}) as typeof fs.lstatSync, () => { fails(() => f.files.read(), "UNSAFE_STORAGE"); });
	}
});

test("root and vaults inode pins reject replacement and disappearance throughout instance lifetime", t => {
	const f = fixture(t); const state = f.save() as VaultReady;
	f.files.withLock(locked => locked.ensureStorageDir(state.active.id));
	const vaults = join(f.root, "vaults"); fs.renameSync(vaults, join(f.root, "saved-vaults")); fs.mkdirSync(vaults, { mode: 0o700 });
	fails(() => f.files.read(), "UNSAFE_STORAGE");
	fs.rmdirSync(vaults); fs.renameSync(join(f.root, "saved-vaults"), vaults);
	assert.deepEqual(f.files.read(), state);
	fs.renameSync(f.root, join(f.base, "saved-root")); fs.mkdirSync(f.root, { mode: 0o700 });
	fails(() => f.files.read(), "UNSAFE_STORAGE");
	fs.rmdirSync(f.root); fails(() => f.files.read(), "UNSAFE_STORAGE");
});

test("opened-file inode, link-count, same-size mutation and read growth races fail closed", t => {
	const f = fixture(t); f.save();
	const originalOpen = fs.openSync, originalRead = fs.readSync, originalFstat = fs.fstatSync;
	let metadataFd = -1, replaced = false;
	fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
		if (String(path) === f.state && !replaced) {
			replaced = true;
			const text = fs.readFileSync(f.state); fs.renameSync(f.state, join(f.base, "raced-original")); fs.writeFileSync(f.state, text, { mode: 0o600 });
		}
		return (originalOpen as Function)(path, ...args);
	}) as typeof fs.openSync, () => fails(() => f.files.read(), "UNSAFE_STORAGE"));
	fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
		const fd = (originalOpen as Function)(path, ...args); if (String(path) === f.state) metadataFd = fd; return fd;
	}) as typeof fs.openSync, () => {
		fault("fstatSync", ((fd: number, ...args: unknown[]) => {
			const result = (originalFstat as Function)(fd, ...args); if (fd === metadataFd) result.nlink = 0; return result;
		}) as typeof fs.fstatSync, () => fails(() => f.files.read(), "UNSAFE_STORAGE"));
	});
	for (const growth of [true, false]) {
		let changed = false;
		fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
			const fd = (originalOpen as Function)(path, ...args); if (String(path) === f.state) metadataFd = fd; return fd;
		}) as typeof fs.openSync, () => {
			fault("readSync", ((fd: number, ...args: unknown[]) => {
				const count = (originalRead as Function)(fd, ...args);
				if (fd === metadataFd && !changed) {
					changed = true;
					if (growth) fs.appendFileSync(f.state, " "); else {
						const text = fs.readFileSync(f.state); text[0] = 0x20; fs.writeFileSync(f.state, text);
						const now = new Date(Date.now() + 10_000); fs.utimesSync(f.state, now, now);
					}
				}
				return count;
			}) as typeof fs.readSync, () => fails(() => f.files.read(), "UNSAFE_STORAGE"));
		});
		f.put(JSON.stringify(ready()));
	}
});

test("atomic write faults before rename preserve prior metadata and clean only owned temporary file", t => {
	const f = fixture(t); f.save(); const before = fs.readFileSync(f.state), original = fs.renameSync;
	let renames = 0;
	fault("renameSync", ((...args: unknown[]) => { renames++; throw Object.assign(new Error("private-secret"), { code: "EIO" }); }) as typeof original,
		() => fails(() => f.save(), "IO_FAILED"));
	assert.equal(renames, 1); assert.deepEqual(fs.readFileSync(f.state), before);
	assert.deepEqual(fs.readdirSync(f.root), ["archive.vault.json"]);
	const originalOpen = fs.openSync, originalSync = fs.fsyncSync; let tempFd = -1, failed = false;
	fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
		const fd = (originalOpen as Function)(path, ...args); if (String(path).endsWith(".tmp")) tempFd = fd; return fd;
	}) as typeof fs.openSync, () => fault("fsyncSync", ((fd: number) => {
		if (fd === tempFd && !failed) { failed = true; throw new Error("private-secret"); } return originalSync(fd);
	}) as typeof fs.fsyncSync, () => fails(() => f.save(), "IO_FAILED")));
	assert.deepEqual(fs.readFileSync(f.state), before); assert.deepEqual(fs.readdirSync(f.root), ["archive.vault.json"]);
});

test("raced replacement at write preflight is not overwritten and uncertain successful rename is not replayed", t => {
	const f = fixture(t); f.save(); const original = fs.writeFileSync, rival = ready(); let injected = false;
	fault("writeFileSync", ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
		const result = (original as Function)(target, ...args);
		// The lock write occurs first; inject only once the metadata temp exists.
		if (!injected && fs.readdirSync(f.root).some(name => name.endsWith(".tmp"))) {
			injected = true; fs.unlinkSync(f.state); original(f.state, JSON.stringify(rival), { mode: 0o600 });
		}
		return result;
	}) as typeof fs.writeFileSync, () => fails(() => f.save(), "UNSAFE_STORAGE"));
	assert.deepEqual(f.files.read(), rival);
	const rename = fs.renameSync, after = ready(); let count = 0;
	fault("renameSync", ((...args: unknown[]) => { count++; (rename as Function)(...args); throw new Error("private-secret"); }) as typeof fs.renameSync,
		() => fails(() => f.save(after)));
	assert.equal(count, 1); assert.deepEqual(f.files.read(), after);
	assert.equal(fs.existsSync(f.lock), false);
});

test("metadata writes fsync file before rename and directory after, with exclusive private temp", t => {
	const f = fixture(t); f.save(); const open = fs.openSync, sync = fs.fsyncSync, rename = fs.renameSync;
	const events: string[] = [], paths = new Map<number, string>();
	fault("openSync", ((path: fs.PathLike, flags: number, mode?: number) => {
		if (String(path).endsWith(".tmp")) { assert.ok(flags & fs.constants.O_EXCL); assert.ok(flags & fs.constants.O_NOFOLLOW); assert.equal(mode, 0o600); }
		const fd = open(path, flags, mode); paths.set(fd, String(path)); return fd;
	}) as typeof fs.openSync, () => fault("fsyncSync", ((fd: number) => {
		events.push(`sync:${paths.get(fd)}`); sync(fd);
	}) as typeof fs.fsyncSync, () => fault("renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
		events.push("rename"); rename(from, to);
	}) as typeof fs.renameSync, () => f.save())));
	const renameIndex = events.indexOf("rename"); assert.ok(renameIndex > 0);
	assert.ok(events.slice(0, renameIndex).some(event => event.endsWith(".tmp")));
	assert.ok(events.slice(renameIndex + 1).includes(`sync:${f.root}`));
});

test("lock has private owner metadata; stale sync and async callback handles never regain authority", async t => {
	const f = fixture(t); let captured!: ArchiveVaultLocked;
	const result = f.files.withLock(locked => {
		captured = locked; const content = JSON.parse(fs.readFileSync(f.lock, "utf8"));
		assert.match(content.token, /^[0-9a-f]{64}$/); assert.equal(content.pid, process.pid); assert.equal(content.hostname, hostname());
		assert.equal(fs.statSync(f.lock).mode & 0o777, 0o600); locked.write(ready()); return 7;
	});
	assert.equal(result, 7);
	for (const run of [() => captured.read(), () => captured.write(ready()), () => captured.ensureStorageDir(randomUUID()), () => captured.cleanupGeneration({ id: "legacy", envelope: null })]) fails(run, "STALE_LOCK");
	f.files.withLock(() => fails(() => captured.read(), "STALE_LOCK"));
	await f.files.withLockAsync(async locked => { captured = locked; await Promise.resolve(); assert.ok(locked.read()); });
	fails(() => captured.read(), "STALE_LOCK");
	const failure = new Error("fixture callback failure");
	assert.throws(() => f.files.withLock(() => { throw failure; }), error => error === failure);
	await assert.rejects(f.files.withLockAsync(async locked => { captured = locked; throw failure; }), error => error === failure);
	fails(() => captured.read(), "STALE_LOCK"); assert.equal(fs.existsSync(f.lock), false);
});

test("lock replacement fails captured methods and release safely, without removing replacement", t => {
	const f = fixture(t); f.save();
	const replacement = "foreign-lock-private-secret";
	assert.throws(() => f.files.withLock(locked => {
		fs.unlinkSync(f.lock); fs.writeFileSync(f.lock, replacement, { mode: 0o600 });
		fails(() => locked.read(), "STALE_LOCK");
	}), (error: unknown) => error instanceof ArchiveVaultFilesError && error.code === "LOCK_RELEASE_FAILED" && !error.message.includes("private-secret"));
	assert.equal(fs.readFileSync(f.lock, "utf8"), replacement);
});

test("callback plus release failure is a sanitized aggregate, not either native secret", t => {
	const f = fixture(t); f.save();
	assert.throws(() => f.files.withLock(() => {
		fs.unlinkSync(f.lock); fs.writeFileSync(f.lock, "replacement", { mode: 0o600 }); throw new Error("private-secret");
	}), (error: unknown) => error instanceof AggregateError && error.errors.length === 0 && !error.message.includes("private-secret"));
});

test("lock contention is bounded and never steals a live or abandoned lock", async t => {
	const f = fixture(t); f.save(); const text = JSON.stringify({ token: "b".repeat(64), pid: process.pid, hostname: hostname() });
	fs.writeFileSync(f.lock, text, { mode: 0o600 }); const before = performance.now();
	await assert.rejects(f.files.withLockAsync(async () => { assert.fail("must not acquire"); }),
		(error: unknown) => error instanceof ArchiveVaultFilesError && error.code === "LOCK_TIMEOUT");
	const elapsed = performance.now() - before; assert.ok(elapsed >= 1800 && elapsed < 3500, `bounded wait ${elapsed}`);
	assert.equal(fs.readFileSync(f.lock, "utf8"), text);
});

test("async contention permits local release, then second writer acquires without replay", async t => {
	const f = fixture(t); f.save(); const events: string[] = [];
	const first = f.files.withLockAsync(async locked => { events.push("first"); await new Promise(resolve => setTimeout(resolve, 80)); locked.write(ready()); events.push("release"); });
	await new Promise(resolve => setTimeout(resolve, 10));
	const second = new ArchiveVaultFiles(f.agent).withLockAsync(async locked => { assert.ok(locked.read()); events.push("second"); });
	await Promise.all([first, second]); assert.deepEqual(events, ["first", "release", "second"]);
});

test("native EEXIST then missing or nlink-zero lock lookup retries exclusive open, never unlinks a foreign lock", t => {
	for (const raced of ["missing", "zero"] as const) {
		const f = fixture(t); f.save(); const open = fs.openSync, lookup = fs.lstatSync; let collide = true, lookupRace = false;
		fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
			if (String(path) === f.lock && collide) { collide = false; lookupRace = true; throw Object.assign(new Error("fixture EEXIST"), { code: "EEXIST" }); }
			return (open as Function)(path, ...args);
		}) as typeof fs.openSync, () => fault("lstatSync", ((path: fs.PathLike, ...args: unknown[]) => {
			if (String(path) === f.lock && lookupRace) {
				lookupRace = false; if (raced === "missing") throw Object.assign(new Error("fixture ENOENT"), { code: "ENOENT" });
				const info = lookup(f.state); info.nlink = 0; return info;
			}
			return (lookup as Function)(path, ...args);
		}) as typeof fs.lstatSync, () => f.files.withLock(locked => assert.ok(locked.read()))));
		assert.equal(fs.existsSync(f.lock), false);
	}
});

test("unsafe lock links and permissions reject immediately without waiting or unlinking", t => {
	const f = fixture(t); f.save(); fs.symlinkSync(f.state, f.lock);
	fails(() => f.files.withLock(() => {}), "UNSAFE_STORAGE"); assert.ok(fs.lstatSync(f.lock).isSymbolicLink()); fs.unlinkSync(f.lock);
	fs.linkSync(f.state, f.lock); fails(() => f.files.withLock(() => {}), "UNSAFE_STORAGE"); fs.unlinkSync(f.lock);
	fs.writeFileSync(f.lock, "fixture", { mode: 0o644 }); fails(() => f.files.withLock(() => {}), "UNSAFE_STORAGE");
	assert.equal(fs.readFileSync(f.lock, "utf8"), "fixture");
});

test("explicit abandoned-lock break requires dead local PID and strict token metadata; does not create absent roots", t => {
	const f = fixture(t); assert.equal(f.files.breakAbandonedLock(), false); assert.deepEqual(fs.readdirSync(f.base), []); f.save();
	const token = "c".repeat(64), deadPid = 0x7fffffff;
	assert.throws(() => process.kill(deadPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
	const good = { token, pid: deadPid, hostname: hostname() };
	for (const value of [{ ...good, pid: process.pid }, { ...good, hostname: "not-local-fixture" }, { ...good, pid: -1 }, { ...good, token: "bad" }, { ...good, foreign: true }]) {
		const text = JSON.stringify(value); fs.writeFileSync(f.lock, text, { mode: 0o600 });
		fails(() => f.files.breakAbandonedLock(), "UNSAFE_STORAGE"); assert.equal(fs.readFileSync(f.lock, "utf8"), text);
	}
	fs.writeFileSync(f.lock, JSON.stringify(good), { mode: 0o600 }); assert.equal(f.files.breakAbandonedLock(), true);
	assert.equal(fs.existsSync(f.lock), false); assert.equal(f.files.breakAbandonedLock(), false); assert.ok(f.files.read());
});

test("abandoned-lock inode/token race is not removed", t => {
	const f = fixture(t); f.save(); const text = JSON.stringify({ token: "d".repeat(64), pid: 0x7fffffff, hostname: hostname() });
	fs.writeFileSync(f.lock, text, { mode: 0o600 }); const open = fs.openSync; let lockOpens = 0;
	fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
		if (String(path) === f.lock && ++lockOpens === 2) { fs.unlinkSync(f.lock); fs.writeFileSync(f.lock, text.replace("dddd", "eeee"), { mode: 0o600 }); }
		return (open as Function)(path, ...args);
	}) as typeof fs.openSync, () => fails(() => f.files.breakAbandonedLock()));
	assert.equal(fs.existsSync(f.lock), true);
});

test("generation cleanup deletes only known SQLite files; keeps metadata, lock, vaults and directory", t => {
	const f = fixture(t), state = f.save() as VaultReady;
	f.files.withLock(locked => {
		const target = locked.ensureStorageDir(state.active.id);
		for (const name of names) { fs.writeFileSync(join(target, name), `fixture-${name}`, { mode: 0o600 }); fs.writeFileSync(join(f.root, name), `legacy-${name}`, { mode: 0o600 }); }
		locked.cleanupGeneration(state.active); assert.deepEqual(fs.readdirSync(target), []);
		locked.cleanupGeneration(state.active); // Already missing files is harmless.
		locked.cleanupGeneration({ id: "legacy", envelope: null });
		assert.deepEqual(fs.readdirSync(f.root).sort(), ["archive.vault.json", "archive.vault.lock", "vaults"]);
		assert.ok(locked.read());
	});
	assert.ok(f.files.read()); assert.equal(fs.existsSync(f.lock), false);
});

test("unknown files and unsafe cleanup targets fail before any deletion", t => {
	const f = fixture(t), state = f.save() as VaultReady;
	f.files.withLock(locked => {
		const target = locked.ensureStorageDir(state.active.id), first = join(target, names[0]), second = join(target, names[1]);
		fs.writeFileSync(first, "preserve", { mode: 0o600 }); fs.writeFileSync(second, "preserve-wal", { mode: 0o600 });
		fs.writeFileSync(join(target, "unexpected"), "preserve-extra", { mode: 0o600 });
		fails(() => locked.cleanupGeneration(state.active), "UNSAFE_STORAGE"); assert.equal(fs.readFileSync(first, "utf8"), "preserve");
		assert.equal(fs.readFileSync(join(target, "unexpected"), "utf8"), "preserve-extra"); fs.unlinkSync(join(target, "unexpected"));
		fs.unlinkSync(second); fs.symlinkSync(first, second); fails(() => locked.cleanupGeneration(state.active), "UNSAFE_STORAGE");
		assert.equal(fs.readFileSync(first, "utf8"), "preserve"); fs.unlinkSync(second); fs.linkSync(first, second);
		fails(() => locked.cleanupGeneration(state.active), "UNSAFE_STORAGE"); assert.equal(fs.readFileSync(first, "utf8"), "preserve");
		fs.unlinkSync(second); fs.chmodSync(first, 0o644); fails(() => locked.cleanupGeneration(state.active), "UNSAFE_STORAGE");
		fs.chmodSync(first, 0o600);
		fails(() => locked.cleanupGeneration({ id: "../../outside", envelope: null }), "INVALID_STATE");
		fails(() => locked.cleanupGeneration({ id: state.active.id, envelope: envelope(randomUUID()) }), "INVALID_STATE");
		assert.equal(fs.readFileSync(first, "utf8"), "preserve");
	});
});

test("generation directory link, file open race and replacement pins never follow cleanup outside", t => {
	const f = fixture(t), state = f.save() as VaultReady;
	f.files.withLock(locked => {
		const target = locked.ensureStorageDir(state.active.id), first = join(target, names[0]), second = join(target, names[1]);
		fs.writeFileSync(first, "keep", { mode: 0o600 }); fs.writeFileSync(second, "keep-wal", { mode: 0o600 });
		const open = fs.openSync; let injected = false;
		fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
			if (!injected && String(path) === second) { injected = true; fs.unlinkSync(second); fs.writeFileSync(second, "replacement", { mode: 0o600 }); }
			return (open as Function)(path, ...args);
		}) as typeof fs.openSync, () => fails(() => locked.cleanupGeneration(state.active), "UNSAFE_STORAGE"));
		assert.equal(fs.readFileSync(first, "utf8"), "keep");
		const moved = join(f.base, "old-generation"); fs.renameSync(target, moved); fs.symlinkSync(moved, target);
		fails(() => locked.cleanupGeneration(state.active), "UNSAFE_STORAGE"); assert.equal(fs.readFileSync(join(moved, names[0]), "utf8"), "keep");
		fs.unlinkSync(target); fs.mkdirSync(target, { mode: 0o700 }); fails(() => locked.cleanupGeneration(state.active), "UNSAFE_STORAGE");
	});
});

test("legacy unknown file prevents deletion, and missing generations are harmless without mkdir", t => {
	const f = fixture(t); f.save(); fs.writeFileSync(join(f.root, names[0]), "legacy", { mode: 0o600 });
	f.files.withLock(locked => {
		locked.cleanupGeneration(ready().active); assert.equal(fs.existsSync(join(f.root, "vaults")), false);
		fs.writeFileSync(join(f.root, "unknown"), "retain", { mode: 0o600 });
		fails(() => locked.cleanupGeneration({ id: "legacy", envelope: null }), "UNSAFE_STORAGE");
		assert.equal(fs.readFileSync(join(f.root, names[0]), "utf8"), "legacy");
		fs.unlinkSync(join(f.root, "unknown"));
	});
});

test("metadata probes and cleanup never read DB bodies", t => {
	const f = fixture(t); f.save(); fs.writeFileSync(join(f.root, "archive.sqlite"), "private synthetic DB body", { mode: 0o600 });
	const open = fs.openSync, read = fs.readSync, paths = new Map<number, string>();
	fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => { const fd = (open as Function)(path, ...args); paths.set(fd, String(path)); return fd; }) as typeof fs.openSync,
		() => fault("readSync", ((fd: number, ...args: unknown[]) => {
			assert.ok(!names.some(name => paths.get(fd)?.endsWith(name)), "no body read"); return (read as Function)(fd, ...args);
		}) as typeof fs.readSync, () => {
			assert.ok(f.files.read()); f.files.withLock(locked => { assert.ok(locked.read()); locked.cleanupGeneration({ id: "legacy", envelope: null }); });
		}));
});

test("cross-process cooperative writers preserve one another's metadata updates", async t => {
	const f = fixture(t); const original = f.save() as VaultReady;
	const moduleURL = pathToFileURL(join(process.cwd(), "archive-vault-files.ts")).href;
	const children = Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
			import { ArchiveVaultFiles } from ${JSON.stringify(moduleURL)};
			import { randomUUID } from 'node:crypto';
			const files = new ArchiveVaultFiles(${JSON.stringify(f.agent)});
			await files.withLockAsync(async locked => {
				const state = locked.read();
				await new Promise(resolve => setTimeout(resolve, ${30 + index * 5}));
				state.retired.push({id: randomUUID(), envelope:null}); state.revision=randomUUID(); locked.write(state);
			});
		`], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
		child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`fixture writer failed: ${stderr}`)));
	}));
	await Promise.all(children); const final = f.files.read() as VaultReady;
	assert.equal(final.retired.length, 4); assert.equal(new Set(final.retired.map(g => g.id)).size, 4);
	assert.deepEqual(final.active, original.active); assert.equal(fs.existsSync(f.lock), false);
});

test("post-rename directory fsync failure reports uncertainty without replaying metadata write", t => {
	const f = fixture(t); f.save(); const replacement = ready(), rename = fs.renameSync, sync = fs.fsyncSync;
	let renamed = false, failed = false, calls = 0;
	fault("renameSync", ((from: fs.PathLike, to: fs.PathLike) => { calls++; rename(from, to); renamed = true; }) as typeof fs.renameSync,
		() => fault("fsyncSync", ((fd: number) => {
			if (renamed && !failed && fs.fstatSync(fd).isDirectory()) { failed = true; throw new Error("private-secret"); }
			sync(fd);
		}) as typeof fs.fsyncSync, () => fails(() => f.save(replacement), "IO_FAILED")));
	assert.equal(calls, 1); assert.equal(failed, true); assert.deepEqual(f.files.read(), replacement);
	assert.deepEqual(fs.readdirSync(f.root), ["archive.vault.json"]);
});

test("sync contention also has a bounded deadline and preserves even malformed abandoned lock content", t => {
	const f = fixture(t); f.save(); fs.writeFileSync(f.lock, "private abandoned fixture", { mode: 0o600 });
	const before = performance.now(); fails(() => f.files.withLock(() => assert.fail("must not acquire")), "LOCK_TIMEOUT");
	const elapsed = performance.now() - before; assert.ok(elapsed >= 1800 && elapsed < 3500, `bounded wait ${elapsed}`);
	assert.equal(fs.readFileSync(f.lock, "utf8"), "private abandoned fixture");
});

test("owned ancestors reject group/other writers and missing/unsafe read IO is sanitized", t => {
	const f = fixture(t); f.save();
	for (const path of [f.agent, join(f.agent, "extensions")]) {
		const mode = fs.statSync(path).mode & 0o777; fs.chmodSync(path, 0o777);
		fails(() => f.files.read(), "UNSAFE_STORAGE"); fs.chmodSync(path, mode);
	}
	fault("readSync", (() => { throw new Error("private-secret-parser-snippet"); }) as typeof fs.readSync, () => {
		assert.throws(() => f.files.read(), (error: unknown) => error instanceof ArchiveVaultFilesError && error.code === "IO_FAILED"
			&& !error.message.includes("private-secret") && !Object.hasOwn(error, "cause"));
	});
});

test("EPERM is not evidence of an abandoned PID and synchronous locks reject Promise callbacks", t => {
	const f = fixture(t); f.save(); const text = JSON.stringify({ token: "e".repeat(64), pid: 0x7fffffff, hostname: hostname() });
	fs.writeFileSync(f.lock, text, { mode: 0o600 }); const kill = process.kill;
	try {
		process.kill = (() => { throw Object.assign(new Error("fixture EPERM"), { code: "EPERM" }); }) as typeof process.kill;
		fails(() => f.files.breakAbandonedLock(), "UNSAFE_STORAGE");
	} finally { process.kill = kill; }
	assert.equal(fs.readFileSync(f.lock, "utf8"), text); fs.unlinkSync(f.lock);
	let captured!: ArchiveVaultLocked;
	fails(() => f.files.withLock(locked => { captured = locked; return Promise.resolve(1); }), "STALE_LOCK");
	fails(() => captured.read(), "STALE_LOCK"); assert.equal(fs.existsSync(f.lock), false);
});

test("successful generation cleanup fsyncs its pinned directory", t => {
	const f = fixture(t); const state = f.save() as VaultReady;
	f.files.withLock(locked => {
		const target = locked.ensureStorageDir(state.active.id); fs.writeFileSync(join(target, "archive.sqlite"), "fixture", { mode: 0o600 });
		const sync = fs.fsyncSync, directory = fs.statSync(target); let synced = false;
		fault("fsyncSync", ((fd: number) => {
			const info = fs.fstatSync(fd); if (info.ino === directory.ino && info.dev === directory.dev && info.isDirectory()) synced = true;
			sync(fd);
		}) as typeof fs.fsyncSync, () => locked.cleanupGeneration(state.active));
		assert.equal(synced, true); assert.deepEqual(fs.readdirSync(target), []);
	});
});

test("cleanup cannot bypass malformed metadata or an incomplete managed layout", t => {
	const f = fixture(t); const state = f.save() as VaultReady;
	const target = f.files.withLock(locked => locked.ensureStorageDir(state.active.id)), path = join(target, "archive.sqlite");
	fs.writeFileSync(path, "preserve-fixture", { mode: 0o600 });
	f.put('{"private-secret": BROKEN');
	fails(() => f.files.withLock(locked => locked.cleanupGeneration(state.active)), "INVALID_STATE");
	assert.equal(fs.readFileSync(path, "utf8"), "preserve-fixture");
	fs.unlinkSync(f.state);
	fails(() => f.files.withLock(locked => locked.cleanupGeneration(state.active)), "UNSAFE_STORAGE");
	assert.equal(fs.readFileSync(path, "utf8"), "preserve-fixture");
});

test("cleanup preflights all four files, removes auxiliaries first, and retains main on auxiliary failure", t => {
	const f = fixture(t); f.save();
	for (const name of names) fs.writeFileSync(join(f.root, name), `retired-${name}`, { mode: 0o600 });
	const open = fs.openSync, unlink = fs.unlinkSync, preflight = new Set<string>(), attempts: string[] = [];
	f.files.withLock(locked => {
		fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
			const fd = (open as Function)(path, ...args);
			if (names.some(name => String(path) === join(f.root, name))) preflight.add(String(path));
			return fd;
		}) as typeof fs.openSync, () => fault("unlinkSync", ((path: fs.PathLike) => {
			if (names.some(name => String(path) === join(f.root, name))) {
				assert.equal(preflight.size, 4); attempts.push(String(path));
				if (String(path).endsWith("-shm")) throw Object.assign(new Error("synthetic unlink failure"), { code: "EACCES" });
			}
			unlink(path);
		}) as typeof fs.unlinkSync, () => fails(() => locked.cleanupGeneration({ id: "legacy", envelope: null }), "IO_FAILED")));
		assert.deepEqual(attempts, [join(f.root, names[1]), join(f.root, names[2])]);
		assert.equal(fs.existsSync(join(f.root, names[0])), true);
		assert.equal(fs.existsSync(join(f.root, names[1])), false); // A retained entry can be a partial backup.
		assert.equal(fs.existsSync(join(f.root, names[2])), true);
		locked.cleanupGeneration({ id: "legacy", envelope: null }); // Explicit retry only.
		for (const name of names) assert.equal(fs.existsSync(join(f.root, name)), false);
	});
});

test("uncertain auxiliary unlink is not replayed and cannot remove the main file", t => {
	const f = fixture(t); f.save();
	for (const name of names) fs.writeFileSync(join(f.root, name), `retired-${name}`, { mode: 0o600 });
	const unlink = fs.unlinkSync; let attempts = 0;
	f.files.withLock(locked => {
		fault("unlinkSync", ((path: fs.PathLike) => {
			if (String(path) === join(f.root, names[1])) { attempts++; unlink(path); throw new Error("synthetic post-unlink failure"); }
			unlink(path);
		}) as typeof fs.unlinkSync, () => fails(() => locked.cleanupGeneration({ id: "legacy", envelope: null }), "IO_FAILED"));
		assert.equal(attempts, 1); assert.equal(fs.existsSync(join(f.root, names[0])), true);
		locked.cleanupGeneration({ id: "legacy", envelope: null });
		for (const name of names) assert.equal(fs.existsSync(join(f.root, name)), false);
	});
});

test("legacy source presence flag is optional, strict and only valid for legacy transitions", t => {
	const f = fixture(t), legacy = ready(); legacy.active = { id: "legacy", envelope: null };
	for (const from of [null, legacy]) for (const flag of [undefined, true, false]) {
		const state = transition(from); if (flag !== undefined) state.legacySourcePresent = flag;
		assert.deepEqual(parseVaultState(state), state); f.save(state); assert.deepEqual(f.files.read(), state);
	}
	for (const flag of [null, undefined, 0, 1, "true", {}, new Boolean(false)]) {
		fails(() => parseVaultState({ ...transition(), legacySourcePresent: flag }), "INVALID_STATE");
	}
	for (const flag of [true, false]) fails(() => parseVaultState({ ...transition(ready()), legacySourcePresent: flag }), "INVALID_STATE");
	fails(() => parseVaultState({ ...ready(), legacySourcePresent: true }), "INVALID_STATE");
	let calls = 0;
	const getter = transition(); Object.defineProperty(getter, "legacySourcePresent", { enumerable: true, get() { calls++; return true; } });
	const proxy = new Proxy(transition(), { ownKeys() { calls++; return []; } });
	for (const value of [getter, proxy, { ...transition(), legacySourcePresent: false, foreign: true },
		{ ...transition(), legacySourcePresent: new Proxy({}, { get() { calls++; return false; } }) }]) fails(() => parseVaultState(value), "INVALID_STATE");
	assert.equal(calls, 0);
	const duplicate = JSON.stringify({ ...transition(), legacySourcePresent: false }).replace('"legacySourcePresent":false', '"legacySourcePresent":false,"legacySourcePresent":true');
	f.put(duplicate); fails(() => f.files.read(), "INVALID_STATE"); assert.equal(fs.readFileSync(f.state, "utf8"), duplicate);
});

test("generation preflight is nofollow, metadata-only and distinguishes absent/zero/nonzero files", t => {
	const f = fixture(t), legacy = { id: "legacy", envelope: null };
	assert.deepEqual(f.files.generationFiles(legacy), { databaseBytes: undefined, filesPresent: false });
	assert.deepEqual(fs.readdirSync(f.base), []);
	const state = f.save() as VaultReady; f.files.withLock(locked => locked.ensureStorageDir(state.active.id));
	const path = join(f.root, "vaults", state.active.id, "archive.sqlite");
	for (const bytes of [Buffer.alloc(0), Buffer.from("synthetic body must never be read")]) {
		fs.writeFileSync(path, bytes, { mode: 0o600 });
		fault("readSync", (() => { assert.fail("preflight must not read any file body"); }) as typeof fs.readSync, () => {
			assert.deepEqual(f.files.generationFiles(state.active), { databaseBytes: bytes.length, filesPresent: true });
		});
	}
	fs.chmodSync(path, 0o644); fails(() => f.files.generationFiles(state.active), "UNSAFE_STORAGE"); fs.chmodSync(path, 0o600);
	fs.linkSync(path, join(f.base, "hardlink")); fails(() => f.files.generationFiles(state.active), "UNSAFE_STORAGE"); fs.unlinkSync(join(f.base, "hardlink"));
	fs.renameSync(path, join(f.base, "outside")); fs.symlinkSync(join(f.base, "outside"), path);
	fails(() => f.files.generationFiles(state.active), "UNSAFE_STORAGE");
});

test("unlocked and lock-local generation observation never opens any SQLite file descriptor", t => {
	for (const kind of ["legacy", "plain", "cipher"] as const) {
		const f = fixture(t), state = f.save(ready(kind === "cipher")) as VaultReady;
		const g = kind === "legacy" ? { id: "legacy", envelope: null } : state.active;
		const dir = kind === "legacy" ? f.root : f.files.withLock(locked => locked.ensureStorageDir(g.id));
		const body = "synthetic SQLite metadata fixture", expected = { databaseBytes: Buffer.byteLength(body), filesPresent: true };
		for (const name of names) fs.writeFileSync(join(dir, name), body, { mode: 0o600 });
		const open = fs.openSync; let sqliteOpens = 0;
		fault("openSync", ((path: fs.PathLike, ...args: unknown[]) => {
			if (names.some(name => String(path) === join(dir, name))) {
				sqliteOpens++; throw new Error("observational SQLite descriptor open would release live POSIX locks on close");
			}
			return (open as Function)(path, ...args);
		}) as typeof fs.openSync, () => {
			assert.deepEqual(f.files.generationFiles(g), expected);
			f.files.withLock(locked => {
				for (let i = 0; i < 3; i++) assert.deepEqual(locked.generationFiles(g), expected);
			});
		});
		assert.equal(sqliteOpens, 0);
	}
});

test("lock-local generation identity pins allow SQLite file size changes", t => {
	const f = fixture(t), state = f.save() as VaultReady;
	const dir = f.files.withLock(locked => locked.ensureStorageDir(state.active.id)), path = join(dir, "archive.sqlite");
	fs.writeFileSync(path, "synthetic", { mode: 0o600 });
	f.files.withLock(locked => {
		assert.equal(locked.generationFiles(state.active).databaseBytes, 9);
		fs.appendFileSync(path, " checkpoint");
		assert.equal(locked.generationFiles(state.active).databaseBytes, 20);
	});
});

test("locked generation preflight pins source presence and inode without treating mutation as empty", t => {
	for (const mutation of ["remove", "replace", "appear"]) {
		const f = fixture(t), state = f.save() as VaultReady;
		f.files.withLock(locked => locked.ensureStorageDir(state.active.id));
		const path = join(f.root, "vaults", state.active.id, "archive.sqlite");
		if (mutation !== "appear") fs.writeFileSync(path, "synthetic source", { mode: 0o600 });
		f.files.withLock(locked => {
			assert.equal(locked.generationFiles(state.active).filesPresent, mutation !== "appear");
			if (mutation !== "appear") fs.renameSync(path, join(f.base, "retained"));
			if (mutation !== "remove") fs.writeFileSync(path, "synthetic source", { mode: 0o600 });
			fails(() => locked.generationFiles(state.active), "UNSAFE_STORAGE");
		});
	}
});

test("cleanup invokes caller guard after target preflight and before every unlink", t => {
	const f = fixture(t), state = f.save() as VaultReady;
	f.files.withLock(locked => locked.ensureStorageDir(state.active.id));
	const dir = join(f.root, "vaults", state.active.id);
	for (const name of names) fs.writeFileSync(join(dir, name), "synthetic retained target", { mode: 0o600 });
	let calls = 0;
	f.files.withLock(locked => fails(() => locked.cleanupGeneration(state.active, () => {
		if (++calls === 2) throw new Error("synthetic source revoked before first unlink");
	})));
	assert.equal(calls, 2); assert.deepEqual(fs.readdirSync(dir).sort(), [...names].sort());
});
