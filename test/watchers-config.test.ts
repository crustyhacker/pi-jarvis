import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveWatcherPolicy, saveWatcherPolicy, watcherConfigPath } from "../watchers-config.js";
import { WATCHER_DEFAULTS } from "../watchers-types.js";
import { fixture } from "./watchers-fixture.js";

test("watcher settings are off by default and independent of memory/archive configuration", () => {
	const f = fixture(); try {
		mkdirSync(join(f.cwd, ".pi")); writeFileSync(join(f.cwd, ".pi", "jarvis.json"), '{"memory":{"enabled":false},"model":"unchanged"}');
		assert.deepEqual(resolveWatcherPolicy(f.cwd, f.agentDir), { policy: { ...WATCHER_DEFAULTS }, errors: [] });
	} finally { f.close(); }
});
test("project numeric overrides apply without materializing inherited values", () => {
	const f = fixture(); try {
		saveWatcherPolicy(f.cwd, f.agentDir, "global", { enabled: true, outputTailChars: 600 });
		saveWatcherPolicy(f.cwd, f.agentDir, "project", { minIntervalSeconds: 30 });
		assert.deepEqual(resolveWatcherPolicy(f.cwd, f.agentDir).policy, { ...WATCHER_DEFAULTS, enabled: true, outputTailChars: 600, minIntervalSeconds: 30 });
		assert.deepEqual(JSON.parse(readFileSync(watcherConfigPath(f.cwd, f.agentDir, "project"), "utf8")), { watchers: { minIntervalSeconds: 30 } });
	} finally { f.close(); }
});
test("explicit global off overrides project on", () => {
	const f = fixture(); try { saveWatcherPolicy(f.cwd, f.agentDir, "global", { enabled: false }); saveWatcherPolicy(f.cwd, f.agentDir, "project", { enabled: true }); assert.equal(resolveWatcherPolicy(f.cwd, f.agentDir).policy.enabled, false); } finally { f.close(); }
});
test("clear removes only watcher controls and fallback may re-enable", () => {
	const f = fixture(); try {
		saveWatcherPolicy(f.cwd, f.agentDir, "global", { enabled: true }); saveWatcherPolicy(f.cwd, f.agentDir, "project", { enabled: false });
		const file = watcherConfigPath(f.cwd, f.agentDir, "project"); writeFileSync(file, '{"other":"retain","watchers":{"enabled":false}}');
		saveWatcherPolicy(f.cwd, f.agentDir, "project", "clear"); assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other: "retain" }); assert.equal(resolveWatcherPolicy(f.cwd, f.agentDir).policy.enabled, true);
	} finally { f.close(); }
});
test("malformed JSON disables watchers and cannot be repaired by a write", () => {
	const f = fixture(); try {
		mkdirSync(join(f.cwd, ".pi")); const file = watcherConfigPath(f.cwd, f.agentDir, "project"); writeFileSync(file, "{sensitive invalid text");
		assert.equal(resolveWatcherPolicy(f.cwd, f.agentDir).policy.enabled, false); assert.equal(resolveWatcherPolicy(f.cwd, f.agentDir).errors[0], "Cannot read project watcher settings; watchers are disabled.");
		assert.throws(() => saveWatcherPolicy(f.cwd, f.agentDir, "project", { enabled: true }), /Cannot update project watcher settings/); assert.equal(readFileSync(file, "utf8"), "{sensitive invalid text");
	} finally { f.close(); }
});
test("unknown watcher controls fail closed instead of weakening limits", () => {
	const f = fixture(); try { mkdirSync(join(f.cwd, ".pi")); writeFileSync(watcherConfigPath(f.cwd, f.agentDir, "project"), '{"watchers":{"enabled":true,"surprise":1}}'); assert.equal(resolveWatcherPolicy(f.cwd, f.agentDir).policy.enabled, false); } finally { f.close(); }
});
test("untrusted policy is off even with valid enabled settings", () => {
	const f = fixture(); try { saveWatcherPolicy(f.cwd, f.agentDir, "global", { enabled: true }); assert.equal(resolveWatcherPolicy(f.cwd, f.agentDir, false).policy.enabled, false); } finally { f.close(); }
});
test("invalid numeric settings are refused without any write", () => {
	const f = fixture(); try { assert.throws(() => saveWatcherPolicy(f.cwd, f.agentDir, "global", { maxWatchers: 101 }), /Invalid watcher maxWatchers/); assert.deepEqual(resolveWatcherPolicy(f.cwd, f.agentDir).policy, { ...WATCHER_DEFAULTS }); } finally { f.close(); }
});
test("symlinked configuration paths are neither read nor replaced", () => {
	const f = fixture(); try { mkdirSync(join(f.cwd, ".pi")); const target = join(f.root, "external.json"); writeFileSync(target, '{"watchers":{"enabled":true}}'); symlinkSync(target, watcherConfigPath(f.cwd, f.agentDir, "project")); assert.equal(resolveWatcherPolicy(f.cwd, f.agentDir).policy.enabled, false); assert.throws(() => saveWatcherPolicy(f.cwd, f.agentDir, "project", "clear")); assert.equal(readFileSync(target, "utf8"), '{"watchers":{"enabled":true}}'); } finally { f.close(); }
});
test("settings lock contention fails without stealing or retrying a write", () => {
	const f = fixture(); try { saveWatcherPolicy(f.cwd, f.agentDir, "global", { enabled: true }); const lock = `${watcherConfigPath(f.cwd, f.agentDir, "global")}.lock`; writeFileSync(lock, "synthetic owner"); assert.throws(() => saveWatcherPolicy(f.cwd, f.agentDir, "global", { enabled: false }), /no automatic retry/); assert.equal(readFileSync(lock, "utf8"), "synthetic owner"); assert.equal(resolveWatcherPolicy(f.cwd, f.agentDir).policy.enabled, true); } finally { f.close(); }
});
