import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
	clearJarvisModelSelectionSetting, clearJarvisThinkingSelectionSetting, getJarvisConfigPath,
	loadJarvisModelSelectionSetting, loadJarvisThinkingSelectionSetting,
	saveJarvisModelSelectionSetting, saveJarvisThinkingSelectionSetting,
} from "../jarvis-config.js";

// Deterministic fault injection works even when tests run as root. Never touches host config.
function withFsFault<K extends "readFileSync" | "writeFileSync" | "renameSync" | "fsyncSync" | "openSync" | "rmSync">(
	key: K, replacement: typeof fs[K], run: () => void,
): void {
	const original = fs[key];
	fs[key] = replacement;
	syncBuiltinESMExports();
	try { run(); } finally {
		fs[key] = original;
		syncBuiltinESMExports();
	}
}

export async function runConfigRegressionTests(): Promise<void> {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-jarvis-config-regression-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	try {
		for (const scope of ["project", "global"] as const) {
			const path = getJarvisConfigPath(cwd, scope, agentDir);
			fs.mkdirSync(dirname(path), { recursive: true });
			const initial = JSON.stringify({
				modelSelection: { mode: "follow-main" },
				thinkingSelection: { mode: "pinned", thinkingLevel: "high" },
				unknown: { keep: [1, 2] },
			});
			const reset = () => fs.writeFileSync(path, initial);
			reset();
			saveJarvisThinkingSelectionSetting(cwd, scope, { mode: "pinned", thinkingLevel: "max" }, agentDir);
			assert.deepEqual(loadJarvisThinkingSelectionSetting(cwd, scope, agentDir), { mode: "pinned", thinkingLevel: "max" });
			assert.deepEqual(loadJarvisModelSelectionSetting(cwd, scope, agentDir), { mode: "follow-main" });
			clearJarvisModelSelectionSetting(cwd, scope, agentDir);
			assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")).unknown, { keep: [1, 2] });
			assert.deepEqual(loadJarvisThinkingSelectionSetting(cwd, scope, agentDir), { mode: "pinned", thinkingLevel: "max" });
			clearJarvisThinkingSelectionSetting(cwd, scope, agentDir);
			assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), { unknown: { keep: [1, 2] } });

			for (const code of ["EACCES", "EIO", "EPERM"] as const) {
				reset();
				const error = Object.assign(new Error(`injected ${code}`), { code });
				const originalRead = fs.readFileSync;
				withFsFault("readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
					if (args[0] === path) throw error;
					return (originalRead as Function)(...args);
				}) as typeof fs.readFileSync, () => {
					for (const action of [
						() => loadJarvisModelSelectionSetting(cwd, scope, agentDir),
						() => loadJarvisThinkingSelectionSetting(cwd, scope, agentDir),
						() => clearJarvisModelSelectionSetting(cwd, scope, agentDir),
						() => clearJarvisThinkingSelectionSetting(cwd, scope, agentDir),
						() => saveJarvisModelSelectionSetting(cwd, scope, { mode: "follow-main" }, agentDir),
						() => saveJarvisThinkingSelectionSetting(cwd, scope, { mode: "auto" }, agentDir),
					]) assert.throws(action, (caught) => caught === error, `${code} must not trigger malformed-file recovery`);
				});
				assert.equal(fs.readFileSync(path, "utf8"), initial);
			}

			for (const key of ["writeFileSync", "renameSync", "fsyncSync", "openSync"] as const) {
				reset();
				const error = Object.assign(new Error(`injected ${key}`), { code: "EIO" });
				const originalWrite = fs.writeFileSync;
				withFsFault(key, ((...args: unknown[]) => {
					if (key === "writeFileSync") originalWrite(args[0] as number, "partial JSON");
					throw error;
				}) as typeof fs[typeof key], () => {
					assert.throws(() => saveJarvisThinkingSelectionSetting(cwd, scope, { mode: "auto" }, agentDir), (caught) => caught === error);
				});
				assert.equal(fs.readFileSync(path, "utf8"), initial, `${key} failure must preserve previous bytes`);
				assert.deepEqual(fs.readdirSync(dirname(path)), [scope === "project" ? "jarvis.json" : "pi-jarvis.json"], "failed writes must clean temporary files");
			}

			reset();
			const originalFailure = new Error("primary write failure");
			withFsFault("rmSync", (() => { throw new Error("secondary cleanup failure"); }) as typeof fs.rmSync, () => {
				withFsFault("writeFileSync", (() => { throw originalFailure; }) as typeof fs.writeFileSync, () => {
					assert.throws(() => saveJarvisThinkingSelectionSetting(cwd, scope, { mode: "auto" }, agentDir), (caught) => caught === originalFailure, "cleanup failure must not mask write failure");
				});
			});
			assert.equal(fs.readFileSync(path, "utf8"), initial);
			// The injected cleanup failure necessarily leaves a temp; clean it after restoring fs.
			for (const file of fs.readdirSync(dirname(path))) {
				if (file.endsWith(".tmp")) fs.rmSync(join(dirname(path), file));
			}

			reset();
			const originalRename = fs.renameSync;
			let renamed = false;
			withFsFault("renameSync", ((from, to) => {
				assert.equal(to, path);
				assert.equal(dirname(String(from)), dirname(path));
				assert.equal(fs.readFileSync(path, "utf8"), initial, "target remains intact until rename");
				assert.equal(JSON.parse(fs.readFileSync(from, "utf8")).thinkingSelection.mode, "auto");
				renamed = true;
				originalRename(from, to);
			}) as typeof fs.renameSync, () => saveJarvisThinkingSelectionSetting(cwd, scope, { mode: "auto" }, agentDir));
			assert.ok(renamed, "successful writes replace atomically");

			for (const malformed of ["{broken", "null", "[]", "42"]) {
				fs.writeFileSync(path, malformed);
				assert.throws(() => loadJarvisModelSelectionSetting(cwd, scope, agentDir));
				saveJarvisModelSelectionSetting(cwd, scope, { mode: "follow-main" }, agentDir);
				assert.deepEqual(loadJarvisModelSelectionSetting(cwd, scope, agentDir), { mode: "follow-main" });
				fs.writeFileSync(path, malformed);
				clearJarvisThinkingSelectionSetting(cwd, scope, agentDir);
				assert.ok(!fs.existsSync(path), "explicit clear still recovers malformed content");
			}
			assert.equal(loadJarvisModelSelectionSetting(cwd, scope, agentDir), undefined);
			clearJarvisModelSelectionSetting(cwd, scope, agentDir);
			saveJarvisThinkingSelectionSetting(cwd, scope, { mode: "auto" }, agentDir);
			if (process.platform !== "win32") assert.equal(fs.statSync(path).mode & 0o777, 0o600);
			clearJarvisThinkingSelectionSetting(cwd, scope, agentDir);
			assert.ok(!fs.existsSync(path));
		}
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runConfigRegressionTests();
	console.log("config regression tests passed");
}
