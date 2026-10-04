import {
	closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
	readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, parse, resolve } from "node:path";
import type { MemoryPolicy } from "./memory-types.js";

type Scope = "global" | "project";
type Config = Record<string, unknown>;
const FIELDS = ["enabled", "capture", "recall"] as const;
const CONFIG_LIMIT_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 20;
const sleep = new Int32Array(new SharedArrayBuffer(4));
const noFollow = constants.O_NOFOLLOW ?? 0;

/** Caller-spelled settings path, without I/O. Access canonicalizes only the chosen root. */
export function memoryConfigPath(cwd: string, agentDir: string, scope: Scope): string {
	if (scope !== "global" && scope !== "project") throw new Error("Invalid memory settings scope.");
	return scope === "global" ? join(agentDir, "extensions", "pi-jarvis.json") : join(cwd, ".pi", "jarvis.json");
}

/** Reads settings only. Defaults are on; untrusted projects and read/validation failures pause all memory. */
export function resolveMemoryPolicy(cwd: string, agentDir: string, trusted = true): {
	policy: MemoryPolicy; errors: string[]; global: Partial<MemoryPolicy>; project: Partial<MemoryPolicy>;
} {
	const errors: string[] = [];
	const read = (scope: Scope): Partial<MemoryPolicy> => {
		try {
			return parsePolicy(readConfig(settingsPath(cwd, agentDir, scope))?.memory);
		} catch {
			// Never include parser messages, config contents, paths or underlying I/O errors.
			errors.push(`Cannot read ${scope} memory settings; memory is disabled.`);
			return {};
		}
	};
	const global = read("global");
	const project = read("project");
	if (errors.length || !trusted) return { policy: { enabled: false, capture: false, recall: false }, errors, global, project };

	const base: MemoryPolicy = { enabled: true, capture: true, recall: true, ...global };
	const policy: MemoryPolicy = { ...base, ...project };
	// Only enabled is a master switch. Capture/recall remain independent preferences.
	if (global.enabled === false) policy.enabled = false;
	return { policy, errors, global, project };
}

/** Merges only supplied fields into this scope; never materializes inherited/default values. */
export function saveMemoryPolicy(cwd: string, agentDir: string, scope: Scope, patch: Partial<MemoryPolicy>): void {
	const parsed = parsePatch(patch);
	changeConfig(cwd, agentDir, scope, (config) => {
		if (!Object.keys(parsed).length) return false;
		config.memory = { ...(config.memory as Config | undefined), ...parsed };
		return true;
	});
}

/** Removes only memory controls. Corrupt files are never repaired or removed. */
export function clearMemoryPolicy(cwd: string, agentDir: string, scope: Scope): void {
	changeConfig(cwd, agentDir, scope, (config) => {
		if (!Object.hasOwn(config, "memory")) return false;
		delete config.memory;
		return true;
	});
}

/** Missing/other disclosure versions return false; invalid/inaccessible settings throw safely. */
export function hasMemoryDisclosure(agentDir: string): boolean {
	try {
		return readConfig(settingsPath("", agentDir, "global"))?.memoryDisclosedVersion === 1;
	} catch {
		throw new Error("Cannot read global memory disclosure settings.");
	}
}

/** The caller must show the visible disclosure before invoking this function. */
export function markMemoryDisclosure(agentDir: string): void {
	changeConfig("", agentDir, "global", (config) => {
		if (config.memoryDisclosedVersion === 1) return false;
		config.memoryDisclosedVersion = 1;
		return true;
	});
}

function parsePolicy(value: unknown): Partial<MemoryPolicy> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory controls.");
	const policy: Partial<MemoryPolicy> = {};
	for (const field of FIELDS) {
		if (!Object.hasOwn(value, field)) continue;
		const setting = (value as Config)[field];
		if (typeof setting !== "boolean") throw new Error("Invalid memory controls.");
		policy[field] = setting;
	}
	return policy;
}

function parsePatch(patch: Partial<MemoryPolicy>): Partial<MemoryPolicy> {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)
		|| Object.keys(patch).some((key) => !FIELDS.includes(key as typeof FIELDS[number]))) {
		throw new Error("Invalid memory controls patch.");
	}
	return parsePolicy(patch);
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Resolve user-selected roots (including ancestor links), but never appended settings paths. */
function settingsPath(cwd: string, agentDir: string, scope: Scope): string {
	// Validate scope before choosing/canonicalizing a root.
	memoryConfigPath(cwd, agentDir, scope);
	const root = canonicalRoot(scope === "global" ? agentDir : cwd);
	return scope === "global" ? join(root, "extensions", "pi-jarvis.json") : join(root, ".pi", "jarvis.json");
}

/** Missing roots inherit the real path of their nearest existing directory ancestor. */
function canonicalRoot(path: string): string {
	let current = resolve(path);
	const suffix: string[] = [];
	for (;;) {
		try { lstatSync(current); } catch (error) {
			if (!missing(error)) throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			suffix.unshift(basename(current));
			current = parent;
			continue;
		}
		// An existing dangling link or a nondirectory root is an error, not a missing config.
		const canonical = realpathSync(current);
		if (!lstatSync(canonical).isDirectory()) throw new Error("Unsafe memory settings root.");
		return join(canonical, ...suffix);
	}
}

/** Validate the canonical ancestry, missing root components and appended settings directories. */
function directories(path: string, create: boolean): boolean {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const parts: string[] = [];
	let current = absolute;
	while (current !== root) {
		parts.push(current);
		current = dirname(current);
	}
	parts.push(root);
	for (const directory of parts.reverse()) {
		let stat;
		try { stat = lstatSync(directory); } catch (error) {
			if (!missing(error)) throw error;
			if (!create) return false;
			try { mkdirSync(directory, { mode: 0o700 }); } catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException)?.code !== "EEXIST") throw mkdirError;
			}
			stat = lstatSync(directory);
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe memory settings directory.");
	}
	return true;
}

function regularFile(path: string): ReturnType<typeof lstatSync> | undefined {
	let stat;
	try { stat = lstatSync(path); } catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe memory settings file.");
	return stat;
}

function readConfig(path: string): Config | undefined {
	if (!directories(dirname(path), false)) return undefined;
	const stat = regularFile(path);
	if (!stat) return undefined;
	if (stat.size > CONFIG_LIMIT_BYTES) throw new Error("Memory settings exceed the size limit.");
	// O_NONBLOCK prevents a raced special file from blocking before fstat rejects it.
	const fd = openSync(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
	let text: string;
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
			throw new Error("Memory settings changed while opening.");
		}
		if (opened.size > CONFIG_LIMIT_BYTES) throw new Error("Memory settings exceed the size limit.");
		// A bounded buffer also handles growth after fstat: readFileSync could allocate
		// without limit in that race. The extra byte detects growth without reading it all.
		const bytes = Buffer.alloc(opened.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		if (length !== opened.size) throw new Error("Memory settings changed while reading.");
		text = bytes.toString("utf8", 0, length);
	} finally { closeSync(fd); }
	let config: unknown;
	try { config = JSON.parse(text); } catch { throw new Error("Invalid memory settings JSON."); }
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid memory settings object.");
	const record = config as Config;
	// Validate controls even for disclosure/clear calls; none may repair an invalid file.
	parsePolicy(record.memory);
	return record;
}

function changeConfig(cwd: string, agentDir: string, scope: Scope, change: (config: Config) => boolean): void {
	try {
		const path = settingsPath(cwd, agentDir, scope);
		// Avoid creating directories/lock files for absent clears or already-applied changes.
		const existing = readConfig(path);
		if (!change({ ...existing })) return;
		directories(dirname(path), true);
		withLock(path, () => {
			const config = readConfig(path) ?? {};
			if (change(config)) writeConfig(path, config);
		});
	} catch {
		throw new Error(`Cannot update ${scope} memory settings.`);
	}
}

/** Cooperative lock for memory writers only. Crashed writers leave locks; never steal a live lock. */
function withLock(path: string, run: () => void): void {
	const lock = `${path}.memory.lock`;
	const deadline = performance.now() + LOCK_WAIT_MS;
	let fd: number;
	for (;;) {
		try {
			fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			regularFile(lock); // Reject symlink/nonregular locks instead of waiting on them.
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new Error("Memory settings lock timed out.");
			Atomics.wait(sleep, 0, 0, Math.min(LOCK_POLL_MS, remaining));
		}
	}
	let owned: ReturnType<typeof fstatSync> | undefined;
	try {
		owned = fstatSync(fd);
		if (!owned.isFile() || owned.nlink !== 1) throw new Error("Unsafe memory settings lock.");
		run();
	} finally {
		try { closeSync(fd); } catch { /* Cleanup must not mask the primary failure. */ }
		try {
			const current = lstatSync(lock);
			if (owned && current.dev === owned.dev && current.ino === owned.ino && current.isFile() && !current.isSymbolicLink()) unlinkSync(lock);
		} catch { /* Failed cleanup can leave a lock; bounded waits still fail closed. */ }
	}
}

function writeConfig(path: string, config: Config): void {
	const text = `${JSON.stringify(config, null, "\t")}\n`;
	if (Buffer.byteLength(text, "utf8") > CONFIG_LIMIT_BYTES) throw new Error("Memory settings exceed the size limit.");
	const temporary = `${path}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	let created = false;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
		created = true;
		writeFileSync(fd, text, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		directories(dirname(path), false);
		regularFile(path); // Recheck the target before replacement; never replace a symlink.
		renameSync(temporary, path);
		created = false;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* Keep the primary failure. */ }
		}
		if (created) {
			try { unlinkSync(temporary); } catch { /* Keep the primary failure. */ }
		}
	}
}
