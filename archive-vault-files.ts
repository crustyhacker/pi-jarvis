import {
	closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
	opendirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { isUtf8 } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { types } from "node:util";
import { parseArchiveEnvelope, type ArchiveKeyEnvelope } from "./archive-crypto.js";

export interface VaultGeneration { id: string; envelope: ArchiveKeyEnvelope | null }
export interface VaultReady {
	format: "pi-jarvis-archive-vault";
	version: 1;
	phase: "ready";
	revision: string;
	active: VaultGeneration;
	startup: "manual" | "prompt" | "remember";
	remember?: { account: string };
	retired: VaultGeneration[];
}
export interface VaultTransition {
	format: "pi-jarvis-archive-vault";
	version: 1;
	phase: "transition";
	revision: string;
	from: VaultReady | null;
	to: VaultReady;
	/** Only legacy sources: explicit absent/present baseline for copy and rollback. */
	legacySourcePresent?: boolean;
}
/** Filesystem metadata only; database bodies are never read by this preflight. */
export interface VaultGenerationFiles { databaseBytes: number | undefined; filesPresent: boolean }
export type VaultState = VaultReady | VaultTransition;
export interface ArchiveVaultLocked {
	read(): VaultState | undefined;
	write(state: VaultState): void;
	/** Creates an empty, private generation directory, never a database or a reused directory. */
	ensureStorageDir(id: string): string;
	/** lstat-only SQLite-file preflight; pins main-file presence/identity for this lock's lifetime. */
	generationFiles(generation: VaultGeneration): VaultGenerationFiles;
	/** Deletes only the four recognized SQLite filenames; caller must first close handles to deletion candidates.
	 * Rechecks an optional caller guard before each unlink; that guard must not open/close live DB/SHM files. */
	cleanupGeneration(generation: VaultGeneration, guard?: () => void): void;
}

export type ArchiveVaultFilesErrorCode =
	| "INVALID_STATE" | "UNSAFE_STORAGE" | "IO_FAILED" | "LOCK_TIMEOUT"
	| "STALE_LOCK" | "LOCK_RELEASE_FAILED";
const messages: Record<ArchiveVaultFilesErrorCode, string> = {
	INVALID_STATE: "Invalid archive vault metadata.",
	UNSAFE_STORAGE: "Unsafe or changed archive vault storage.",
	IO_FAILED: "Cannot access archive vault storage.",
	LOCK_TIMEOUT: "Archive vault is busy; lock timed out. Abandoned locks require manual recovery.",
	STALE_LOCK: "Archive vault lock is no longer active.",
	LOCK_RELEASE_FAILED: "Cannot safely release archive vault lock; manual recovery may be required.",
};
/** No paths, parser snippets, native errors, credentials or causes. */
export class ArchiveVaultFilesError extends Error {
	constructor(readonly code: ArchiveVaultFilesErrorCode) {
		super(messages[code]);
		this.name = "ArchiveVaultFilesError";
	}
}
const FORMAT = "pi-jarvis-archive-vault";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SQLITE = ["archive.sqlite", "archive.sqlite-wal", "archive.sqlite-shm", "archive.sqlite-journal"];
const MAX_BYTES = 64 * 1024;
const LOCK_BYTES = 4096;
const LOCK_WAIT_MS = 2000;
const POLL_MS = 20;
const sleep = new Int32Array(new SharedArrayBuffer(4));
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
function fail(code: ArchiveVaultFilesErrorCode): never { throw new ArchiveVaultFilesError(code); }
function safe<T>(run: () => T): T {
	try { return run(); } catch (error) {
		if (error instanceof ArchiveVaultFilesError) throw error;
		return fail("IO_FAILED");
	}
}
function uuid(value: unknown): asserts value is string {
	if (typeof value !== "string" || !UUID.test(value)) fail("INVALID_STATE");
}
function record(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
	if (!input || typeof input !== "object" || types.isProxy(input)) fail("INVALID_STATE");
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) fail("INVALID_STATE");
	const keys = Reflect.ownKeys(input);
	if (keys.length < required.length || keys.length > required.length + optional.length
		|| keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) fail("INVALID_STATE");
	const result: Record<string, unknown> = Object.create(null);
	for (const key of [...required, ...optional]) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor) { if (required.includes(key)) fail("INVALID_STATE"); else continue; }
		if (!("value" in descriptor) || !descriptor.enumerable) fail("INVALID_STATE");
		result[key] = descriptor.value;
	}
	return result;
}
function generation(input: unknown, legacy: boolean): VaultGeneration {
	const value = record(input, ["id", "envelope"]);
	if (legacy && value.id === "legacy") {
		if (value.envelope !== null) fail("INVALID_STATE");
		return { id: "legacy", envelope: null };
	}
	uuid(value.id);
	const envelope = value.envelope === null ? null : parseArchiveEnvelope(value.envelope);
	if (envelope && envelope.vaultId !== value.id) fail("INVALID_STATE");
	return { id: value.id, envelope };
}
function retired(input: unknown): VaultGeneration[] {
	if (!input || typeof input !== "object" || types.isProxy(input) || !Array.isArray(input)
		|| Object.getPrototypeOf(input) !== Array.prototype) fail("INVALID_STATE");
	const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
	if (!Number.isInteger(length) || length < 0 || length > 8 || Reflect.ownKeys(input).length !== length + 1) fail("INVALID_STATE");
	const result: VaultGeneration[] = [];
	for (let i = 0; i < length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("INVALID_STATE");
		result.push(generation(descriptor.value, true));
	}
	return result;
}
function header(value: Record<string, unknown>, phase: string): void {
	if (value.format !== FORMAT || value.version !== 1 || value.phase !== phase) fail("INVALID_STATE");
	uuid(value.revision);
}
function ready(input: unknown): VaultReady {
	const value = record(input, ["format", "version", "phase", "revision", "active", "startup", "retired"], ["remember"]);
	header(value, "ready");
	const active = generation(value.active, true), old = retired(value.retired);
	if (new Set([active.id, ...old.map(g => g.id)]).size !== old.length + 1) fail("INVALID_STATE");
	if (value.startup !== "manual" && value.startup !== "prompt" && value.startup !== "remember") fail("INVALID_STATE");
	if ((value.startup === "remember") !== Object.hasOwn(value, "remember")) fail("INVALID_STATE");
	const result: VaultReady = {
		format: FORMAT, version: 1, phase: "ready", revision: value.revision as string,
		active, startup: value.startup, retired: old,
	};
	if (value.startup === "remember") {
		const remember = record(value.remember, ["account"]);
		if (!active.envelope || typeof remember.account !== "string" || !/^[0-9a-f]{64}$/.test(remember.account)) fail("INVALID_STATE");
		result.remember = { account: remember.account };
	}
	return result;
}
/** Detached, bounded schema; no getters/proxies/custom serialization, future fields or nested transitions. */
export function parseVaultState(input: unknown): VaultState {
	try {
		if (!input || typeof input !== "object" || types.isProxy(input)) fail("INVALID_STATE");
		const phase = Object.getOwnPropertyDescriptor(input, "phase");
		if (!phase || !("value" in phase)) fail("INVALID_STATE");
		if (phase.value === "ready") return ready(input);
		const value = record(input, ["format", "version", "phase", "revision", "from", "to"], ["legacySourcePresent"]);
		header(value, "transition");
		const from = value.from === null ? null : ready(value.from), to = ready(value.to);
		const source = from?.active ?? { id: "legacy", envelope: null };
		const retained = to.retired.find(g => g.id === source.id);
		if (to.active.id === "legacy" || to.active.id === source.id || !retained || JSON.stringify(retained.envelope) !== JSON.stringify(source.envelope)) fail("INVALID_STATE");
		const result: VaultTransition = { format: FORMAT, version: 1, phase: "transition", revision: value.revision as string, from, to };
		if (Object.hasOwn(value, "legacySourcePresent")) {
			if (source.id !== "legacy" || typeof value.legacySourcePresent !== "boolean") fail("INVALID_STATE");
			result.legacySourcePresent = value.legacySourcePresent;
		}
		return result;
	} catch { return fail("INVALID_STATE"); }
}

/** Check duplicate members (including escaped aliases), depth and token budget before JSON.parse. */
function json(text: string): unknown {
	let offset = 0, nodes = 0;
	const space = () => { while (/[\x20\t\r\n]/.test(text[offset] ?? "!")) offset++; };
	const quoted = (): string => {
		const start = offset++;
		if (text[start] !== '"') fail("INVALID_STATE");
		while (offset < text.length) {
			const char = text[offset++];
			if (char === "\\") { offset++; continue; }
			if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
		}
		return fail("INVALID_STATE");
	};
	const value = (depth: number): void => {
		if (depth > 16 || ++nodes > 4096) fail("INVALID_STATE");
		space();
		const char = text[offset];
		if (char === '"') { quoted(); return; }
		if (char === "{" || char === "[") {
			offset++; space();
			const end = char === "{" ? "}" : "]", keys = new Set<string>();
			if (text[offset] === end) { offset++; return; }
			for (;;) {
				if (char === "{") {
					space(); const key = quoted();
					if (keys.has(key)) fail("INVALID_STATE");
					keys.add(key); space();
					if (text[offset++] !== ":") fail("INVALID_STATE");
				}
				value(depth + 1); space();
				if (text[offset] === end) { offset++; return; }
				if (text[offset++] !== ",") fail("INVALID_STATE");
			}
		}
		const token = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(offset));
		if (!token) fail("INVALID_STATE");
		offset += token[0].length;
	};
	try { value(0); space(); if (offset !== text.length) fail("INVALID_STATE"); return JSON.parse(text); }
	catch { return fail("INVALID_STATE"); }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function stat(path: string): Stats | undefined {
	try { return lstatSync(path); } catch (error) { if (missing(error)) return undefined; throw error; }
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a: Stats, b: Stats): boolean {
	return same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
}
function owner(info: Stats): void {
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail("UNSAFE_STORAGE");
}
function regular(info: Stats): void {
	owner(info);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o177) !== 0) fail("UNSAFE_STORAGE");
}
function directoryInfo(info: Stats, privateDir: boolean, owned: boolean): void {
	if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_STORAGE");
	if (owned) owner(info);
	else {
		// Canonical system ancestry (/, /home, sticky /tmp, etc.) may be administrator-
		// owned; another user's directory or an unprotected writable ancestor is unsafe.
		if (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0) fail("UNSAFE_STORAGE");
		if ((info.mode & 0o022) !== 0 && !(info.mode & 0o1000)) fail("UNSAFE_STORAGE");
	}
	if ((privateDir && (info.mode & 0o077) !== 0) || (owned && (info.mode & 0o022) !== 0)) fail("UNSAFE_STORAGE");
}
interface FileRead { text: string; info: Stats }
function readFile(path: string, limit: number): FileRead | undefined {
	const before = stat(path);
	if (!before) return undefined;
	regular(before);
	if (before.size > limit) fail("INVALID_STATE");
	const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd); regular(opened);
		if (!unchanged(before, opened)) fail("UNSAFE_STORAGE");
		if (opened.size > limit) fail("INVALID_STATE");
		const bytes = Buffer.alloc(opened.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		const after = fstatSync(fd), current = stat(path);
		regular(after);
		if (length !== opened.size || !unchanged(opened, after) || !current || !unchanged(after, current)) fail("UNSAFE_STORAGE");
		if (!isUtf8(bytes.subarray(0, length))) fail("INVALID_STATE");
		return { text: bytes.toString("utf8", 0, length), info: after };
	} finally { closeSync(fd); }
}
interface Lock {
	active: boolean;
	fd: number;
	info: Stats;
	text: string;
}

/**
 * Inert until accessed. Canonicalizes only the caller-selected agent root/alias; appended paths
 * never follow links. Inode pins survive failures for this instance's lifetime. Owned ancestry rejects foreign
 * owners and group/other writers; system ancestry permits administrator-owned/sticky dirs. Cooperative locks
 * are not a sandbox against hostile same-user filesystem mutation (Node has no public openat).
 */
export class ArchiveVaultFiles {
	private readonly selected: string;
	private canonical?: string;
	private anchor?: string;
	private readonly pins = new Map<string, Stats>();
	constructor(agentDir: string) {
		if (typeof agentDir !== "string" || !agentDir || agentDir.includes("\0") || Buffer.byteLength(agentDir) > 4096
			|| Buffer.from(agentDir).toString("utf8") !== agentDir) fail("UNSAFE_STORAGE");
		this.selected = resolve(agentDir);
	}
	private paths(): { agent: string; root: string; vaults: string; state: string; lock: string } {
		if (!this.canonical) {
			let current = this.selected;
			const suffix: string[] = [];
			while (!stat(current)) {
				const parent = dirname(current);
				if (parent === current) fail("UNSAFE_STORAGE");
				suffix.unshift(basename(current)); current = parent;
			}
			const anchor = realpathSync(current), info = lstatSync(anchor);
			if (!info.isDirectory()) fail("UNSAFE_STORAGE");
			// The selected existing agent root must be owned. A missing root may be below
			// a system-owned filesystem root/sticky temporary directory; new components are owned.
			if (!suffix.length || (anchor !== parse(anchor).root && !(info.mode & 0o1000))) owner(info);
			this.anchor = anchor;
			this.canonical = join(anchor, ...suffix);
		}
		const root = join(this.canonical, "extensions", "pi-jarvis-archive");
		return { agent: this.canonical, root, vaults: join(root, "vaults"), state: join(root, "archive.vault.json"), lock: join(root, "archive.vault.lock") };
	}
	/** Canonical selected root, with existing ancestors revalidated; never creates paths. */
	get agentRootPath(): string { return safe(() => { this.directories(false); return this.paths().agent; }); }
	get rootPath(): string { return safe(() => this.paths().root); }
	get statePath(): string { return safe(() => this.paths().state); }
	private pin(path: string, info: Stats, privateDir: boolean, owned = true): void {
		directoryInfo(info, privateDir, owned);
		const prior = this.pins.get(path);
		if (prior && !same(prior, info)) fail("UNSAFE_STORAGE");
		const fd = openSync(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = fstatSync(fd), current = stat(path);
			if (!same(info, opened) || !current || !same(opened, current)) fail("UNSAFE_STORAGE");
			directoryInfo(opened, privateDir, owned); directoryInfo(current, privateDir, owned);
		} finally { closeSync(fd); }
		this.pins.set(path, info);
	}
	private directory(path: string, create: boolean, privateDir: boolean, owned = true): boolean {
		let info = stat(path);
		if (!info && this.pins.has(path)) fail("UNSAFE_STORAGE");
		if (!info && create) {
			try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			}
			info = stat(path);
			if (!info) fail("UNSAFE_STORAGE");
			this.pin(path, info, privateDir, owned);
			this.syncDirectory(dirname(path));
		}
		if (!info) return false;
		this.pin(path, info, privateDir, owned);
		return true;
	}
	private directories(create: boolean): boolean {
		const p = this.paths(), all: string[] = [];
		let current = p.root;
		for (;;) { all.unshift(current); const parent = dirname(current); if (parent === current) break; current = parent; }
		let owned = false;
		for (const path of all) {
			if (path === this.anchor) owned = true;
			const systemAnchor = path === this.anchor && path !== p.agent && (path === parse(path).root || !!((stat(path)?.mode ?? 0) & 0o1000));
			if (!this.directory(path, create, path === p.root, owned && !systemAnchor)) return false;
		}
		this.directory(p.vaults, false, true);
		return true;
	}
	private syncDirectory(path: string): void {
		const before = stat(path);
		if (!before || !before.isDirectory() || before.isSymbolicLink()) fail("UNSAFE_STORAGE");
		const pinned = this.pins.get(path);
		if (pinned && !same(pinned, before)) fail("UNSAFE_STORAGE");
		const fd = openSync(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
		try {
			const opened = fstatSync(fd);
			if (!opened.isDirectory() || !same(before, opened)) fail("UNSAFE_STORAGE");
			fsyncSync(fd);
			const after = stat(path);
			if (!after || !same(opened, after)) fail("UNSAFE_STORAGE");
		} finally { closeSync(fd); }
	}
	private entries(path: string, allowed: readonly string[]): Map<string, Stats> {
		const result = new Map<string, Stats>(), handle = opendirSync(path);
		try {
			for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
				if (!allowed.includes(entry.name) || result.has(entry.name)) fail("UNSAFE_STORAGE");
				const info = stat(join(path, entry.name));
				if (!info) fail("UNSAFE_STORAGE");
				if (entry.name === "vaults") this.pin(join(path, entry.name), info, true);
				else regular(info);
				result.set(entry.name, info);
			}
		} finally { handle.closeSync(); }
		return result;
	}
	private rootEntries(temporary?: string): Map<string, Stats> {
		return this.entries(this.paths().root, [...SQLITE, "archive.vault.json", "archive.vault.lock", "vaults", ...(temporary ? [basename(temporary)] : [])]);
	}
	private snapshot(): { state: VaultState | undefined; file: FileRead | undefined } {
		if (!this.directories(false)) return { state: undefined, file: undefined };
		this.rootEntries();
		const p = this.paths(), file = readFile(p.state, MAX_BYTES);
		const state = file ? parseVaultState(json(file.text)) : undefined;
		if (!file && stat(p.vaults)) fail("UNSAFE_STORAGE");
		if (!this.directories(false)) fail("UNSAFE_STORAGE");
		return { state, file };
	}
	read(): VaultState | undefined { return safe(() => this.snapshot().state); }
	/** Observational only: no SQLite-file descriptors, native access or implicit creation/repair. */
	generationFiles(input: VaultGeneration): VaultGenerationFiles { return safe(() => this.preflightGeneration(input)); }
	private preflightGeneration(input: VaultGeneration, pins?: Map<string, Stats | undefined>): VaultGenerationFiles {
		const g = generation(input, true), p = this.paths();
		let main: Stats | undefined, filesPresent = false;
		if (this.directories(false)) {
			this.rootEntries();
			const target = g.id === "legacy" ? p.root : join(p.vaults, g.id);
			if (g.id === "legacy" || (this.directory(p.vaults, false, true) && this.directory(target, false, true))) {
				const entries = g.id === "legacy" ? this.rootEntries() : this.entries(target, SQLITE);
				for (const name of SQLITE) {
					const before = entries.get(name); if (!before) continue;
					// NEVER open/close DB or SHM descriptors here, even on the first
					// preflight: another same-process SQLite handle may already be live.
					// POSIX close drops that process's fcntl locks (see Store.privateFile).
					const current = stat(join(target, name));
					if (!current || !same(before, current)) fail("UNSAFE_STORAGE");
					regular(current); filesPresent = true;
					if (name === "archive.sqlite") main = current;
				}
				this.directories(false); this.directory(target, false, true);
				const current = stat(join(target, "archive.sqlite"));
				if (main ? !current || !same(main, current) : !!current) fail("UNSAFE_STORAGE");
				if (current) { regular(current); main = current; }
			}
		}
		if (pins?.has(g.id)) {
			const prior = pins.get(g.id);
			// SQLite may checkpoint/change size while the transaction is held. Pin
			// presence/inode, not a filesystem-content snapshot or immutable size.
			if (prior ? !main || !same(prior, main) : !!main) fail("UNSAFE_STORAGE");
		} else pins?.set(g.id, main);
		return { databaseBytes: main?.size, filesPresent };
	}
	private assertLock(lock: Lock): void {
		if (!lock.active) fail("STALE_LOCK");
		if (!this.directories(false)) fail("UNSAFE_STORAGE");
		const file = readFile(this.paths().lock, LOCK_BYTES), held = fstatSync(lock.fd);
		if (!file || held.nlink !== 1 || !same(file.info, lock.info) || !same(held, lock.info) || file.text !== lock.text) fail("STALE_LOCK");
		regular(held);
	}
	private attemptLock(): Lock | undefined {
		this.directories(true);
		const p = this.paths();
		let fd: number;
		try { fd = openSync(p.lock, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | constants.O_NONBLOCK, 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			const info = stat(p.lock);
			// Native pathname lookup may retain an inode just unlinked by its owner. No
			// stealing: retry exclusive open under the original deadline, even for nlink=0.
			if (info) {
				if (info.isFile() && info.nlink === 0) {
					owner(info); if (info.isSymbolicLink() || (info.mode & 0o177) !== 0) fail("UNSAFE_STORAGE");
				} else regular(info);
			}
			return undefined;
		}
		let lock: Lock | undefined;
		try {
			const info = fstatSync(fd); regular(info);
			lock = { active: true, fd, info, text: `${JSON.stringify({ token: randomBytes(32).toString("hex"), pid: process.pid, hostname: hostname() })}\n` };
			writeFileSync(fd, lock.text, "utf8"); fsyncSync(fd);
			this.assertLock(lock); this.rootEntries(); this.syncDirectory(p.root);
			return lock;
		} catch (error) {
			// Exclusive creation failed before publication. Only remove our still-pinned inode.
			try {
				const held = fstatSync(fd), current = stat(p.lock);
				if (!current || !same(held, current)) fail("LOCK_RELEASE_FAILED");
				regular(held); regular(current); unlinkSync(p.lock); this.syncDirectory(p.root);
			} catch { throw new ArchiveVaultFilesError("LOCK_RELEASE_FAILED"); }
			finally {
				if (lock) lock.active = false;
				try { closeSync(fd); } catch { fail("LOCK_RELEASE_FAILED"); }
			}
			throw error;
		}
	}
	private acquire(): Lock {
		const deadline = performance.now() + LOCK_WAIT_MS;
		for (;;) {
			const lock = this.attemptLock(); if (lock) return lock;
			const remaining = deadline - performance.now(); if (remaining <= 0) fail("LOCK_TIMEOUT");
			Atomics.wait(sleep, 0, 0, Math.min(POLL_MS, remaining));
		}
	}
	private async acquireAsync(): Promise<Lock> {
		const deadline = performance.now() + LOCK_WAIT_MS;
		for (;;) {
			const lock = safe(() => this.attemptLock()); if (lock) return lock;
			const remaining = deadline - performance.now(); if (remaining <= 0) fail("LOCK_TIMEOUT");
			await new Promise<void>(resolve => setTimeout(resolve, Math.min(POLL_MS, remaining)));
		}
	}
	private release(lock: Lock): void {
		try {
			this.assertLock(lock);
			const current = stat(this.paths().lock);
			if (!current || !same(current, lock.info)) fail("LOCK_RELEASE_FAILED");
			regular(current); unlinkSync(this.paths().lock); this.syncDirectory(this.paths().root);
		} catch { fail("LOCK_RELEASE_FAILED"); }
		finally {
			lock.active = false;
			try { closeSync(lock.fd); } catch { fail("LOCK_RELEASE_FAILED"); }
		}
	}
	/** Human recovery only. Never called by acquisition, read, write or startup. */
	breakAbandonedLock(): boolean {
		return safe(() => {
			if (!this.directories(false)) return false;
			this.rootEntries();
			const path = this.paths().lock, file = readFile(path, LOCK_BYTES);
			if (!file) return false;
			let metadata: Record<string, unknown>;
			try {
				metadata = record(json(file.text), ["token", "pid", "hostname"]);
				if (typeof metadata.token !== "string" || !/^[0-9a-f]{64}$/.test(metadata.token)
					|| !Number.isSafeInteger(metadata.pid) || (metadata.pid as number) < 1 || (metadata.pid as number) > 0x7fffffff
					|| typeof metadata.hostname !== "string" || !metadata.hostname || metadata.hostname.length > 255
					|| /[\p{Cc}\p{Zl}\p{Zp}]/u.test(metadata.hostname) || metadata.hostname !== hostname()) fail("UNSAFE_STORAGE");
			} catch { return fail("UNSAFE_STORAGE"); }
			try { process.kill(metadata.pid as number, 0); fail("UNSAFE_STORAGE"); }
			catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") fail("UNSAFE_STORAGE"); }
			if (!this.directories(false)) fail("UNSAFE_STORAGE");
			const again = readFile(path, LOCK_BYTES);
			if (!again || !unchanged(file.info, again.info) || again.text !== file.text) fail("UNSAFE_STORAGE");
			unlinkSync(path); this.syncDirectory(this.paths().root);
			return true;
		});
	}
	private finish(lock: Lock, failed: boolean): void {
		try { this.release(lock); } catch {
			if (failed) throw new AggregateError([], "Archive vault operation and lock release failed; manual recovery may be required.");
			fail("LOCK_RELEASE_FAILED");
		}
	}
	withLock<T>(run: (locked: ArchiveVaultLocked) => T): T {
		const lock = safe(() => this.acquire()); let failed = true;
		try {
			const result = run(this.handle(lock));
			if (types.isPromise(result)) fail("STALE_LOCK"); // Use withLockAsync for asynchronous work.
			failed = false; return result;
		} finally { this.finish(lock, failed); }
	}
	async withLockAsync<T>(run: (locked: ArchiveVaultLocked) => Promise<T>): Promise<T> {
		const lock = await this.acquireAsync(); let failed = true;
		try { const result = await run(this.handle(lock)); failed = false; return result; }
		finally { this.finish(lock, failed); }
	}
	private handle(lock: Lock): ArchiveVaultLocked {
		const sourcePins = new Map<string, Stats | undefined>();
		return Object.freeze({
			read: () => safe(() => { this.assertLock(lock); return this.snapshot().state; }),
			write: (state: VaultState) => safe(() => { this.assertLock(lock); this.write(lock, state); }),
			ensureStorageDir: (id: string) => safe(() => { this.assertLock(lock); return this.ensureStorageDir(lock, id); }),
			generationFiles: (g: VaultGeneration) => safe(() => { this.assertLock(lock); return this.preflightGeneration(g, sourcePins); }),
			cleanupGeneration: (g: VaultGeneration, guard?: () => void) => safe(() => { this.assertLock(lock); this.cleanup(lock, g, guard); }),
		});
	}
	private write(lock: Lock, input: VaultState): void {
		const state = parseVaultState(input), text = `${JSON.stringify(state)}\n`;
		if (Buffer.byteLength(text) > MAX_BYTES) fail("INVALID_STATE");
		const before = this.snapshot().file, p = this.paths(), temporary = join(p.root, `.archive.vault.${randomUUID()}.tmp`);
		let fd: number | undefined, owned: Stats | undefined, pending = false;
		try {
			fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
			owned = fstatSync(fd); regular(owned); pending = true;
			writeFileSync(fd, text, "utf8"); fsyncSync(fd);
			this.assertLock(lock); this.rootEntries(temporary);
			const current = stat(p.state);
			if (current) regular(current);
			if (before ? !current || !unchanged(before.info, current) : !!current) fail("UNSAFE_STORAGE");
			const temp = stat(temporary), held = fstatSync(fd);
			if (!temp || !same(owned, temp) || !unchanged(temp, held) || held.size !== Buffer.byteLength(text)) fail("UNSAFE_STORAGE");
			regular(held); closeSync(fd); fd = undefined;
			renameSync(temporary, p.state); pending = false;
			this.syncDirectory(p.root); // A failed/uncertain rename or fsync is never replayed.
		} finally {
			try {
				if (pending && owned) {
					this.assertLock(lock);
					const current = stat(temporary);
					if (!current || !same(current, owned)) fail("UNSAFE_STORAGE");
					regular(current); unlinkSync(temporary); this.syncDirectory(p.root);
				}
			} finally { if (fd !== undefined) closeSync(fd); }
		}
	}
	private ensureStorageDir(lock: Lock, id: string): string {
		uuid(id);
		if (!this.snapshot().state) fail("UNSAFE_STORAGE"); // Persist the first transition BEFORE creating vaults.
		const p = this.paths(), target = join(p.vaults, id);
		this.directory(p.vaults, true, true); this.assertLock(lock);
		if (stat(target) || this.pins.has(target)) fail("UNSAFE_STORAGE");
		mkdirSync(target, { mode: 0o700 });
		if (!this.directory(target, false, true)) fail("UNSAFE_STORAGE");
		this.syncDirectory(target); this.syncDirectory(p.vaults);
		return target;
	}
	private cleanup(lock: Lock, input: VaultGeneration, guard?: () => void): void {
		guard?.();
		let g: VaultGeneration;
		try { g = generation(input, true); } catch { return fail("INVALID_STATE"); }
		this.snapshot(); // Malformed/future metadata or an incomplete managed layout never authorizes deletion.
		const p = this.paths(), legacy = g.id === "legacy", target = legacy ? p.root : join(p.vaults, g.id);
		if (!legacy && !this.directory(p.vaults, false, true)) return;
		if (!this.directory(target, false, true)) return;
		const entries = legacy ? this.rootEntries() : this.entries(target, SQLITE);
		const opened: { path: string; info: Stats; fd: number }[] = [];
		try {
			// Destructive preflight ONLY, after the caller quiesces candidate handles;
			// these FDs are never used to observe an unrelated live active generation.
			// Validate/pin EVERY candidate before the first deletion; never read database bodies.
			for (const name of SQLITE) {
				const info = entries.get(name); if (!info) continue;
				const path = join(target, name), fd = openSync(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
				opened.push({ path, info, fd });
				const held = fstatSync(fd); regular(held);
				if (!unchanged(info, held)) fail("UNSAFE_STORAGE");
			}
			this.assertLock(lock); this.directory(target, false, true);
			const again = legacy ? this.rootEntries() : this.entries(target, SQLITE);
			for (const name of SQLITE) {
				const a = entries.get(name), b = again.get(name);
				if (a ? !b || !unchanged(a, b) : !!b) fail("UNSAFE_STORAGE");
			}
			// Keep the main file until EVERY auxiliary unlink succeeds. A partial
			// retired legacy backup must not become orphan sidecars that invalidate
			// an unrelated active managed generation. Never replay a thrown unlink.
			const removalOrder = [...opened.filter(file => basename(file.path) !== "archive.sqlite"),
				...opened.filter(file => basename(file.path) === "archive.sqlite")];
			for (const file of removalOrder) {
				this.assertLock(lock); this.directory(target, false, true);
				const current = stat(file.path), held = fstatSync(file.fd);
				regular(held);
				if (!current || !unchanged(file.info, current) || !unchanged(current, held)) fail("UNSAFE_STORAGE");
				guard?.();
				unlinkSync(file.path);
			}
			this.syncDirectory(target);
		} finally { for (const file of opened) closeSync(file.fd); }
	}
}
