import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
	clearJarvisModelSelectionSetting, clearJarvisThinkingSelectionSetting, getJarvisConfigPath, MalformedJarvisConfigError,
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
				memory: { enabled: false, capture: false, recall: false },
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
			assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), {
				memory: { enabled: false, capture: false, recall: false },
				unknown: { keep: [1, 2] },
			});

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
			if (process.platform !== "win32") fs.chmodSync(path, 0o640);
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
			if (process.platform !== "win32") assert.equal(fs.statSync(path).mode & 0o777, 0o640, "replacement preserves existing permissions");

			const settingActions = [
				{
					name: "set model", setting: "modelSelection", replacement: { mode: "follow-main" },
					run: () => saveJarvisModelSelectionSetting(cwd, scope, { mode: "follow-main" }, agentDir),
				},
				{
					name: "clear model", setting: "modelSelection", replacement: undefined,
					run: () => clearJarvisModelSelectionSetting(cwd, scope, agentDir),
				},
				{
					name: "set thinking", setting: "thinkingSelection", replacement: { mode: "auto" },
					run: () => saveJarvisThinkingSelectionSetting(cwd, scope, { mode: "auto" }, agentDir),
				},
				{
					name: "clear thinking", setting: "thinkingSelection", replacement: undefined,
					run: () => clearJarvisThinkingSelectionSetting(cwd, scope, agentDir),
				},
			] as const;
			const privateConfig = '{"memory":{"enabled":false},"private":"fixture-private-sentinel"}';
			const malformedFiles = [
				{ text: '{"memory":{"enabled":false},"private":"fixture-private-sentinel","invalid":fixture-parser-snippet}', parseError: true },
				{ text: ` \t${privateConfig}\n// fixture-parser-snippet\n`, parseError: true },
				{ text: "{broken", parseError: true },
				{ text: `[${privateConfig}]`, parseError: false },
				{ text: JSON.stringify(privateConfig), parseError: false },
				...["null", "[]", "42", "false"].map((text) => ({ text, parseError: false })),
			];
			for (const { text, parseError } of malformedFiles) {
				const bytes = Buffer.from(text);
				fs.writeFileSync(path, bytes);
				const before = fs.statSync(path);
				for (const { name, run } of [
					...settingActions,
					{ name: "load model", run: () => loadJarvisModelSelectionSetting(cwd, scope, agentDir) },
					{ name: "load thinking", run: () => loadJarvisThinkingSelectionSetting(cwd, scope, agentDir) },
				]) {
					assert.throws(run, (error) => {
						assert.ok(error instanceof MalformedJarvisConfigError);
						assert.equal(error.message, parseError
							? `Invalid JSON in ${path}. Repair this file manually before changing settings to preserve memory/privacy settings.`
							: `Expected ${path} to contain a JSON object. Repair this file manually before changing settings to preserve memory/privacy settings.`);
						assert.ok(!String(error).includes("fixture-private-sentinel"), "UI error must not expose private input");
						assert.ok(!String(error).includes("fixture-parser-snippet"), "UI error must not expose parser snippets");
						if (parseError) assert.ok(error.cause instanceof SyntaxError, "original parse error stays available as cause only");
						return true;
					}, `${scope} ${name} must fail closed on malformed JSON/nonobjects`);
					assert.deepEqual(fs.readFileSync(path), bytes, `${scope} ${name} must preserve exact corrupted bytes and any memory kill switch`);
					const after = fs.statSync(path);
					assert.equal(after.ino, before.ino, "refusal must not replace the file");
					assert.equal(after.mode, before.mode, "refusal must not change permissions");
					assert.equal(after.mtimeMs, before.mtimeMs, "refusal must not write the file");
					assert.deepEqual(fs.readdirSync(dirname(path)), [scope === "project" ? "jarvis.json" : "pi-jarvis.json"], "refusal must not leave temporary files");
				}
			}

			// Repairing/clearing an owned field in a valid object must retain all other settings.
			const malformedFields = {
				...JSON.parse(initial),
				modelSelection: { mode: "invalid-model" },
				thinkingSelection: { mode: "pinned", thinkingLevel: "invalid-thinking" },
			};
			for (const { name, setting, replacement, run } of settingActions) {
				fs.writeFileSync(path, JSON.stringify(malformedFields));
				assert.throws(() => loadJarvisModelSelectionSetting(cwd, scope, agentDir), MalformedJarvisConfigError);
				assert.throws(() => loadJarvisThinkingSelectionSetting(cwd, scope, agentDir), MalformedJarvisConfigError);
				run();
				const expected: Record<string, unknown> = { ...malformedFields };
				if (replacement === undefined) delete expected[setting];
				else expected[setting] = replacement;
				assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), expected, `${scope} ${name} must preserve memory, unknown keys, and the other field`);
			}

			fs.rmSync(path);
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
