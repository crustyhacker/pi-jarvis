import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isUtf8 } from "node:buffer";
import { WATCHER_DEFAULTS, type WatcherPolicy, type WatcherScope } from "./watchers-types.js";

type Config = Record<string, unknown>;
const LIMIT = 65_536, NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ranges: Record<Exclude<keyof WatcherPolicy, "enabled">, [number, number]> = {
	minIntervalSeconds: [1, 3_600], maxTimeoutSeconds: [1, 604_800], maxWatchers: [1, 100],
	maxCheckSeconds: [1, 300], outputTailChars: [1, 4_000], maxDirectoryEntries: [1, 10_000],
};
export function watcherConfigPath(cwd: string, agentDir: string, scope: WatcherScope): string {
	if (scope !== "global" && scope !== "project") throw new Error("Invalid watcher settings scope.");
	return scope === "global" ? join(agentDir, "extensions", "pi-jarvis-watchers.json") : join(cwd, ".pi", "jarvis-watchers.json");
}
function parse(value: unknown): Partial<WatcherPolicy> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid watcher settings.");
	const result: Partial<WatcherPolicy> = {};
	for (const [key, setting] of Object.entries(value)) {
		if (key === "enabled") {
			if (typeof setting !== "boolean") throw new Error("Invalid watcher enabled setting.");
			result.enabled = setting;
		} else if (Object.hasOwn(ranges, key)) {
			const field = key as keyof typeof ranges, [min, max] = ranges[field];
			if (!Number.isSafeInteger(setting) || (setting as number) < min || (setting as number) > max) throw new Error(`Invalid watcher ${key} setting.`);
			result[field] = setting as number;
		} else throw new Error("Unknown watcher setting.");
	}
	return result;
}
function directories(path: string, create: boolean): boolean {
	const parent = dirname(path);
	if (parent !== path && !directories(parent, create)) return false;
	let stat;
	try { stat = lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (!create) return false;
		try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
		stat = lstatSync(path);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe watcher settings directory.");
	return true;
}
function pathFor(cwd: string, agentDir: string, scope: WatcherScope): string {
	watcherConfigPath(cwd, agentDir, scope);
	// Only the selected existing root is canonicalized; appended paths are no-follow.
	const root = realpathSync(resolve(scope === "global" ? agentDir : cwd));
	if (!lstatSync(root).isDirectory()) throw new Error("Invalid settings root.");
	return watcherConfigPath(scope === "project" ? root : cwd, scope === "global" ? root : agentDir, scope);
}
function regular(path: string) {
	try {
		const s = lstatSync(path);
		if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error("Unsafe watcher settings file.");
		return s;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function readConfig(path: string): Config | undefined {
	if (!directories(dirname(path), false)) return undefined;
	const before = regular(path); if (!before) return undefined;
	if (before.size > LIMIT) throw new Error("Watcher settings too large.");
	const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK);
	let bytes: Buffer;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > LIMIT) throw new Error("Watcher settings changed.");
		bytes = Buffer.alloc(stat.size + 1);
		let count = 0, n = 0;
		while (count < bytes.length && (n = readSync(fd, bytes, count, bytes.length - count, null))) count += n;
		if (count !== stat.size || !isUtf8(bytes.subarray(0, count))) throw new Error("Invalid watcher settings read.");
		bytes = bytes.subarray(0, count);
	} finally { closeSync(fd); }
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid watcher settings object.");
	parse((value as Config).watchers);
	return value as Config;
}
export function resolveWatcherPolicy(cwd: string, agentDir: string, trusted = true): { policy: WatcherPolicy; errors: string[] } {
	const errors: string[] = [];
	const load = (scope: WatcherScope) => {
		try { return parse(readConfig(pathFor(cwd, agentDir, scope))?.watchers); }
		catch { errors.push(`Cannot read ${scope} watcher settings; watchers are disabled.`); return {}; }
	};
	const global = load("global"), project = load("project");
	const policy = { ...WATCHER_DEFAULTS, ...global, ...project };
	if (!trusted || errors.length || global.enabled === false) policy.enabled = false;
	return { policy, errors };
}
export function saveWatcherPolicy(cwd: string, agentDir: string, scope: WatcherScope, patch: Partial<WatcherPolicy> | "clear"): void {
	if (patch !== "clear") parse(patch);
	let temporary: string | undefined, lockFd: number | undefined, lockIdentity: ReturnType<typeof fstatSync> | undefined, lock = "";
	try {
		const path = pathFor(cwd, agentDir, scope);
		const existing = readConfig(path);
		if (patch === "clear" && !existing?.watchers) return;
		directories(dirname(path), true);
		lock = `${path}.lock`;
		// Refuse contention rather than stealing a lock or retrying an uncertain write.
		lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
		lockIdentity = fstatSync(lockFd);
		const config = readConfig(path) ?? {};
		if (patch === "clear") delete config.watchers;
		else config.watchers = { ...parse(config.watchers), ...patch };
		const text = `${JSON.stringify(config, null, "\t")}\n`;
		if (Buffer.byteLength(text) > LIMIT) throw new Error("Watcher settings too large.");
		temporary = `${path}.${randomUUID()}.tmp`;
		const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
		try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
		directories(dirname(path), false); regular(path);
		renameSync(temporary, path); temporary = undefined;
	} catch { throw new Error(`Cannot update ${scope} watcher settings; no automatic retry was attempted.`); }
	finally {
		if (temporary) { try { unlinkSync(temporary); } catch { /* Keep primary error. */ } }
		if (lockFd !== undefined) {
			try { closeSync(lockFd); } catch { /* Cleanup only. */ }
			try { const current = lstatSync(lock); if (current.dev === lockIdentity?.dev && current.ino === lockIdentity.ino) unlinkSync(lock); } catch { /* Never steal another lock. */ }
		}
	}
}
