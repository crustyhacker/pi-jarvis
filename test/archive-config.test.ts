import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	archiveConfigPath, clearArchivePolicy, resolveArchivePolicy, saveArchivePolicy,
} from "../archive-config.js";
import type { ArchivePolicy, ArchiveScope } from "../archive-types.js";

type Scope = ArchiveScope;
const defaults: ArchivePolicy = { enabled: false, capture: true, modelAccess: false };
const on: ArchivePolicy = { enabled: true, capture: true, modelAccess: true };
const off: ArchivePolicy = { enabled: false, capture: false, modelAccess: false };

function fixture(t: TestContext) {
	const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-jarvis-archive-config-")));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const path = (scope: Scope) => archiveConfigPath(cwd, agentDir, scope);
	const write = (scope: Scope, text: string) => {
		fs.mkdirSync(dirname(path(scope)), { recursive: true });
		fs.writeFileSync(path(scope), text);
	};
	return {
		root, cwd, agentDir, path, write,
		put: (scope: Scope, config: unknown) => write(scope, JSON.stringify(config)),
		read: (scope: Scope) => JSON.parse(fs.readFileSync(path(scope), "utf8")),
		policy: (trusted = true) => resolveArchivePolicy(cwd, agentDir, trusted),
		save: (scope: Scope, patch: Partial<ArchivePolicy>) => saveArchivePolicy(cwd, agentDir, scope, patch),
		clear: (scope: Scope) => clearArchivePolicy(cwd, agentDir, scope),
	};
}

// Fault injection is deterministic under root too, and affects only temporary fixture operations.
function withFsFault<K extends "readSync" | "writeFileSync" | "renameSync" | "fsyncSync" | "openSync" | "lstatSync" | "fstatSync">(
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

test("defaults and reads never create settings, agent directories or archive storage", (t) => {
	const f = fixture(t);
	assert.equal(f.path("project"), join(f.cwd, ".pi", "jarvis-archive.json"));
	assert.equal(f.path("global"), join(f.agentDir, "extensions", "pi-jarvis-archive.json"));
	for (const trusted of [true, false]) {
		assert.deepEqual(f.policy(trusted), { policy: trusted ? defaults : off, errors: [] });
	}
	f.clear("global");
	f.clear("project");
	f.save("global", {});
	f.save("project", {});
	assert.deepEqual(fs.readdirSync(f.root), []);
	assert.throws(() => archiveConfigPath(f.cwd, f.agentDir, "invalid" as Scope));
});

test("archive settings neither read nor overwrite legacy shared memory/model settings or their locks", (t) => {
	const f = fixture(t);
	const legacy = [join(f.agentDir, "extensions", "pi-jarvis.json"), join(f.cwd, ".pi", "jarvis.json")];
	const originals = ['{"memory":{"enabled":true}, BROKEN', JSON.stringify({ memory: { enabled: false }, modelSelection: { mode: "follow-main" } })];
	for (let i = 0; i < legacy.length; i++) {
		fs.mkdirSync(dirname(legacy[i]), { recursive: true });
		fs.writeFileSync(legacy[i], originals[i]);
		fs.writeFileSync(`${legacy[i]}.memory.lock`, "unrelated writer");
	}
	assert.deepEqual(f.policy(), { policy: defaults, errors: [] });
	f.save("global", { enabled: true });
	assert.deepEqual(f.read("global"), { archive: { enabled: true } });
	assert.deepEqual(f.policy(), { policy: { ...defaults, enabled: true }, errors: [] });
	f.save("project", { capture: false });
	assert.deepEqual(f.read("project"), { archive: { capture: false } });
	assert.deepEqual(f.policy().policy, { enabled: true, capture: false, modelAccess: false });
	f.clear("global");
	f.clear("project");
	assert.deepEqual(f.policy(), { policy: defaults, errors: [] });
	for (let i = 0; i < legacy.length; i++) {
		assert.equal(fs.readFileSync(legacy[i], "utf8"), originals[i]);
		assert.equal(fs.readFileSync(`${legacy[i]}.memory.lock`, "utf8"), "unrelated writer");
	}
	assert.deepEqual(fs.readdirSync(f.agentDir), ["extensions"], "no archive or memory storage subtree is created");
});

test("all per-field precedence combinations respect the global master switch and untrusted full pause", (t) => {
	const f = fixture(t);
	for (const field of ["enabled", "capture", "modelAccess"] as const) {
		for (const global of [undefined, false, true]) {
			for (const project of [undefined, false, true]) {
				const globalPatch = global === undefined ? {} : { [field]: global };
				const projectPatch = project === undefined ? {} : { [field]: project };
				f.put("global", { archive: globalPatch });
				f.put("project", { archive: projectPatch });
				for (const trusted of [true, false]) {
					const result = f.policy(trusted);
					let expected = project ?? global ?? defaults[field];
					if (field === "enabled" && global === false) expected = false;
					assert.deepEqual(result, {
						policy: trusted ? { ...defaults, [field]: expected } : off, errors: [],
					}, `${field}: global=${global}, project=${project}, trusted=${trusted}`);
				}
			}
		}
	}
});

test("capture/model access are independent; trusted projects can override defaults but not a global disable", (t) => {
	const f = fixture(t);
	f.save("global", { enabled: false, capture: false });
	f.save("project", { enabled: true, capture: true, modelAccess: true });
	assert.deepEqual(f.policy().policy, { enabled: false, capture: true, modelAccess: true });
	assert.deepEqual(f.policy(false).policy, off);
	assert.deepEqual(f.read("global"), { archive: { enabled: false, capture: false } });
	assert.deepEqual(f.read("project"), { archive: on });
	assert.deepEqual(fs.readdirSync(f.agentDir), ["extensions"], "disabled resolution never touches a DB path");
	assert.deepEqual(fs.readdirSync(join(f.agentDir, "extensions")), ["pi-jarvis-archive.json"]);
});

test("only an explicit global off is a master switch; clear removes it without materializing defaults", (t) => {
	const f = fixture(t);
	f.save("project", { enabled: true });
	assert.deepEqual(f.read("project"), { archive: { enabled: true } });
	assert.deepEqual(f.policy().policy, { ...defaults, enabled: true }, "default off allows explicit project opt-in");
	f.save("global", { enabled: false });
	assert.deepEqual(f.policy().policy, defaults, "explicit global off blocks project opt-in");
	f.clear("global");
	assert.deepEqual(f.policy().policy, { ...defaults, enabled: true });
	f.save("global", { capture: false, modelAccess: true });
	assert.deepEqual(f.read("global"), { archive: { capture: false, modelAccess: true } });
	assert.deepEqual(f.policy().policy, { enabled: true, capture: false, modelAccess: true });
	f.save("project", { capture: true, modelAccess: false });
	assert.deepEqual(f.policy().policy, { ...defaults, enabled: true }, "project fields can override global capture/model access independently");
});

test("untrusted projects pause all archive but controls stay readable/manageable without config errors", (t) => {
	const f = fixture(t);
	f.save("global", { modelAccess: false });
	f.save("project", { capture: false, modelAccess: true });
	assert.deepEqual(f.policy(false), {
		policy: off, errors: [],
	});
	assert.deepEqual(f.policy().policy, { enabled: false, capture: false, modelAccess: true });
	f.save("project", { enabled: true, capture: true, modelAccess: true });
	assert.deepEqual(f.policy(false).policy, off);
	assert.deepEqual(f.policy().policy, on, "trust restoration resumes resolved controls");
	f.clear("project");
	assert.deepEqual(f.policy(false).policy, off);
	assert.deepEqual(f.policy().policy, defaults);
});

test("patches preserve model/thinking, unknown keys and unspecified controls", (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		const original = {
			modelSelection: { mode: "pinned", provider: "fixture", modelId: "local" },
			thinkingSelection: { mode: "pinned", thinkingLevel: "high" },
			unknown: { keep: [1, "test"] }, otherExtensionState: 1,
			memory: { enabled: "unknown unrelated control" },
			archive: { capture: false, future: { preserve: true } },
			["__proto__"]: { safe: "own JSON property" },
		};
		f.put(scope, original);
		f.save(scope, { modelAccess: false });
		assert.deepEqual(f.read(scope), { ...original, archive: { ...original.archive, modelAccess: false } });
		f.save(scope, { capture: true });
		assert.deepEqual(f.read(scope).archive, { capture: true, modelAccess: false, future: { preserve: true } });
		f.clear(scope);
		const { archive: _, ...rest } = original;
		assert.deepEqual(f.read(scope), rest);
	}
});

test("clear removes only this scope and restores fallback; an otherwise-empty file stays a JSON object", (t) => {
	const f = fixture(t);
	f.save("global", { enabled: true, capture: false });
	f.save("project", { capture: true, modelAccess: true });
	assert.deepEqual(f.policy().policy, on);
	f.clear("project");
	assert.deepEqual(f.policy().policy, { enabled: true, capture: false, modelAccess: false });
	assert.deepEqual(f.read("project"), {});
	f.clear("global");
	assert.deepEqual(f.policy().policy, defaults);
	assert.deepEqual(f.read("global"), {});
	const before = fs.readFileSync(f.path("global"), "utf8");
	f.clear("global");
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
});

test("malformed JSON/root/archive fail closed and every write preserves exact corrupt bytes", (t) => {
	const f = fixture(t);
	const invalid = [
		'{"private-secret":"never echo", BROKEN', "null", "[]", "42", "true", '"private-secret"',
		...[
			null, false, true, 0, "private-secret", [], { enabled: "false" }, { capture: 0 }, { modelAccess: null },
		].map((archive) => JSON.stringify({ private: "private-secret", archive })),
	];
	for (const scope of ["global", "project"] as const) {
		for (const text of invalid) {
			f.put("global", { archive: { enabled: true } });
			f.put("project", { archive: { enabled: true } });
			f.write(scope, text);
			const result = f.policy();
			assert.deepEqual(result.policy, off);
			assert.equal(result.errors.length, 1);
			assert.match(result.errors[0], new RegExp(scope));
			assert.ok(!result.errors.join().includes("private-secret"));
			for (const action of [() => f.save(scope, { enabled: true }), () => f.save(scope, {}), () => f.clear(scope)]) {
				assert.throws(action, /Cannot update .* archive settings/);
			}
			assert.equal(fs.readFileSync(f.path(scope), "utf8"), text);
			assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis-archive.json" : "jarvis-archive.json"]);
		}
	}
	f.write("global", "{bad global");
	f.write("project", "{bad project");
	assert.deepEqual(f.policy().policy, off);
	assert.equal(f.policy().errors.length, 2);
});

test("malformed UTF-8 fails closed and writes never silently repair the original bytes", (t) => {
	const f = fixture(t);
	const prefix = Buffer.from('{"archive":{"enabled":true},"private":"');
	const suffix = Buffer.from('"}');
	for (const scope of ["global", "project"] as const) {
		for (const encoding of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xc3]]) {
			f.put("global", { archive: on });
			f.put("project", { archive: on });
			const bytes = Buffer.concat([prefix, Buffer.from(encoding), suffix]);
			fs.writeFileSync(f.path(scope), bytes);
			const result = f.policy();
			assert.deepEqual(result.policy, off);
			assert.deepEqual(result.errors, [`Cannot read ${scope} archive settings; archive is disabled.`]);
			for (const action of [() => f.save(scope, { enabled: true }), () => f.save(scope, {}), () => f.clear(scope)]) {
				assert.throws(action, /Cannot update .* archive settings/);
			}
			assert.deepEqual(fs.readFileSync(f.path(scope)), bytes);
			assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis-archive.json" : "jarvis-archive.json"]);
		}
		f.put(scope, { archive: on, validUnicode: "é\ufffd🗄" });
	}
	assert.deepEqual(f.policy(), { policy: on, errors: [] }, "valid Unicode, including an encoded replacement character, is accepted");
});

test("settings over 1 MiB fail closed before file reads; all writes preserve oversized bytes", (t) => {
	const f = fixture(t);
	const limit = 1024 * 1024;
	const text = JSON.stringify({ private: "private-secret", archive: { capture: false }, padding: "é".repeat(limit / 2) });
	assert.ok(text.length < limit && Buffer.byteLength(text, "utf8") > limit, "limit counts bytes, not UTF-16 characters");
	for (const scope of ["global", "project"] as const) {
		f.put("global", {});
		f.put("project", {});
		f.write(scope, text);
		const original = fs.readSync;
		let reads = 0;
		withFsFault("readSync", ((...args: Parameters<typeof fs.readSync>) => {
			if (typeof args[0] === "number" && fs.fstatSync(args[0]).size > limit) {
				reads++;
				throw new Error("Oversized settings must not be read.");
			}
			return (original as Function)(...args);
		}) as typeof fs.readSync, () => {
			const result = f.policy();
			assert.deepEqual(result.policy, off);
			assert.equal(result.errors.length, 1);
			assert.ok(!result.errors.join().includes("private-secret"));
			for (const action of [() => f.save(scope, { enabled: true }), () => f.save(scope, {}), () => f.clear(scope)]) {
				assert.throws(action, /Cannot update .* archive settings/);
			}
		});
		assert.equal(reads, 0, "lstat size is checked before bounded file reads");
		assert.equal(fs.readFileSync(f.path(scope), "utf8"), text);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis-archive.json" : "jarvis-archive.json"]);
	}
});

test("opened descriptor size is checked again before bounded file reads", (t) => {
	const f = fixture(t);
	f.put("global", { archive: { capture: false } });
	const before = fs.readFileSync(f.path("global"), "utf8");
	const originalStat = fs.fstatSync;
	const originalRead = fs.readSync;
	let reads = 0;
	withFsFault("fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => {
		const stat = (originalStat as Function)(...args);
		stat.size = 1024 * 1024 + 1;
		return stat;
	}) as typeof fs.fstatSync, () => {
		withFsFault("readSync", ((...args: Parameters<typeof fs.readSync>) => {
			if (typeof args[0] === "number") reads++;
			return (originalRead as Function)(...args);
		}) as typeof fs.readSync, () => {
			assert.deepEqual(f.policy().policy, off);
			assert.throws(() => f.save("global", { enabled: true }));
			assert.throws(() => f.clear("global"));
		});
	});
	assert.equal(reads, 0, "fstat catches file growth between lstat and open");
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
});

test("growth after fstat cannot cause an unbounded read/allocation or a recovery write", (t) => {
	const f = fixture(t);
	const before = JSON.stringify({ archive: { capture: false } });
	const grown = "x".repeat(1024 * 1024 + 1);
	const originalRead = fs.readSync;
	for (const action of [
		() => {
			const result = f.policy();
			assert.deepEqual(result.policy, off);
			assert.equal(result.errors.length, 1);
		},
		() => assert.throws(() => f.save("global", { enabled: true }), /Cannot update global archive settings/),
		() => assert.throws(() => f.clear("global"), /Cannot update global archive settings/),
	]) {
		f.write("global", before);
		let reads = 0;
		withFsFault("readSync", ((...args: unknown[]) => {
			reads++;
			assert.equal((args[1] as Uint8Array).byteLength, Buffer.byteLength(before) + 1);
			assert.equal(args[3], Buffer.byteLength(before) + 1);
			fs.writeFileSync(f.path("global"), grown);
			return (originalRead as Function)(...args);
		}) as typeof fs.readSync, action);
		assert.equal(reads, 1, "reader stops at the prevalidated file size plus one sentinel byte");
		assert.equal(fs.readFileSync(f.path("global"), "utf8"), grown);
		assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis-archive.json"]);
	}
});

test("partial reads are supported; shrinkage during a bounded read fails closed", (t) => {
	const f = fixture(t);
	const text = JSON.stringify({ archive: on, padding: "fixture" });
	f.write("global", text);
	const originalRead = fs.readSync;
	withFsFault("readSync", ((fd, buffer, offset, length, position) => {
		return originalRead(fd, buffer, offset, Math.min(length, 3), position);
	}) as typeof fs.readSync, () => assert.deepEqual(f.policy(), { policy: on, errors: [] }));
	withFsFault("readSync", ((...args: unknown[]) => {
		fs.truncateSync(f.path("global"), 1);
		return (originalRead as Function)(...args);
	}) as typeof fs.readSync, () => {
		assert.deepEqual(f.policy().policy, off);
		assert.equal(f.policy().errors.length, 1);
		assert.throws(() => f.save("global", { enabled: true }), /Cannot update global archive settings/);
		assert.throws(() => f.clear("global"), /Cannot update global archive settings/);
	});
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), "{");
});

test("config swapped between lstat and open is rejected instead of read or repaired", (t) => {
	const f = fixture(t);
	f.put("global", { archive: on });
	const replacement = join(f.root, "replacement.json");
	fs.writeFileSync(replacement, JSON.stringify({ archive: { enabled: false } }));
	const originalOpen = fs.openSync;
	withFsFault("openSync", ((...args: Parameters<typeof fs.openSync>) => {
		if (String(args[0]) === f.path("global")) fs.renameSync(replacement, f.path("global"));
		return (originalOpen as Function)(...args);
	}) as typeof fs.openSync, () => {
		const result = f.policy();
		assert.deepEqual(result.policy, off);
		assert.equal(result.errors.length, 1);
	});
	assert.deepEqual(f.read("global"), { archive: { enabled: false } });
});

test("exactly 1 MiB is readable; updates that would exceed the input bound fail without replacement", (t) => {
	const f = fixture(t);
	const limit = 1024 * 1024;
	const prefix = '{"archive":{"capture":false},"padding":"';
	const remaining = limit - Buffer.byteLength(prefix + '"}', "utf8");
	const text = prefix + "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2) + '"}';
	assert.equal(Buffer.byteLength(text, "utf8"), limit);
	for (const scope of ["global", "project"] as const) {
		f.write(scope, text);
		assert.deepEqual(f.policy().policy, { ...defaults, capture: false });
		assert.deepEqual(f.policy().errors, []);
		assert.throws(() => f.save(scope, { enabled: true }), /Cannot update .* archive settings/);
		assert.equal(fs.readFileSync(f.path(scope), "utf8"), text);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis-archive.json" : "jarvis-archive.json"]);
	}
});

test("invalid runtime patches throw rather than coercing values or replacing settings", (t) => {
	const f = fixture(t);
	f.put("global", { archive: { capture: false }, unknown: "keep" });
	const before = fs.readFileSync(f.path("global"), "utf8");
	for (const patch of [null, false, [], { capture: "false" }, { enabled: undefined }, { modelAccess: 0 }, { extra: true }]) {
		assert.throws(() => f.save("global", patch as Partial<ArchivePolicy>), /Invalid archive controls/);
		assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
	}
});

test("read I/O failures fail closed, report no secrets, and cannot trigger write recovery", (t) => {
	const f = fixture(t);
	f.put("global", { archive: { capture: false }, private: "preserve" });
	const before = fs.readFileSync(f.path("global"), "utf8");
	for (const code of ["EACCES", "EIO", "EPERM"]) {
		const originalRead = fs.readSync;
		withFsFault("readSync", ((...args: Parameters<typeof fs.readSync>) => {
			if (typeof args[0] === "number") throw Object.assign(new Error("private-secret details"), { code });
			return (originalRead as Function)(...args);
		}) as typeof fs.readSync, () => {
			const result = f.policy();
			assert.deepEqual(result.policy, off);
			assert.equal(result.errors.length, 1);
			assert.ok(!result.errors.join().includes("private-secret"));
			for (const action of [
				() => f.save("global", { enabled: true }), () => f.clear("global"),
			]) assert.throws(action, (error) => error instanceof Error && !error.message.includes("private-secret"));
		});
		assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
	}
});

test("inaccessible ancestors are not treated as missing/default settings", (t) => {
	const f = fixture(t);
	const original = fs.lstatSync;
	withFsFault("lstatSync", ((...args: Parameters<typeof fs.lstatSync>) => {
		if (String(args[0]) === f.agentDir) throw Object.assign(new Error("fixture failure"), { code: "EACCES" });
		return (original as Function)(...args);
	}) as typeof fs.lstatSync, () => {
		assert.deepEqual(f.policy().policy, off);
		assert.equal(f.policy().errors.length, 1);
		assert.throws(() => f.save("global", { enabled: true }));
	});
	assert.deepEqual(fs.readdirSync(f.root), []);
});

test("nonregular settings targets and nondirectory roots fail closed without replacement", (t) => {
	const f = fixture(t);
	fs.mkdirSync(f.path("project"), { recursive: true });
	fs.writeFileSync(f.agentDir, "not a directory");
	assert.deepEqual(f.policy().policy, off);
	assert.equal(f.policy().errors.length, 2);
	for (const scope of ["global", "project"] as const) {
		assert.throws(() => f.save(scope, { enabled: true }));
		assert.throws(() => f.clear(scope));
	}
	assert.ok(fs.statSync(f.path("project")).isDirectory());
	assert.equal(fs.readFileSync(f.agentDir, "utf8"), "not a directory");
});

test("symlink and hardlinked config targets, including dangling links, are rejected", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const target = join(f.root, "target.json");
	const initial = JSON.stringify({ archive: { enabled: true }, private: "keep" });
	fs.writeFileSync(target, initial);
	for (const scope of ["global", "project"] as const) {
		fs.mkdirSync(dirname(f.path(scope)), { recursive: true });
		for (const kind of ["symlink", "hardlink", "dangling"] as const) {
			if (kind === "hardlink") fs.linkSync(target, f.path(scope));
			else fs.symlinkSync(kind === "dangling" ? join(f.root, "missing") : target, f.path(scope));
			assert.deepEqual(f.policy().policy, off);
			assert.throws(() => f.save(scope, { enabled: false }));
			assert.throws(() => f.clear(scope));
			assert.equal(fs.readFileSync(target, "utf8"), initial);
			assert.equal(fs.lstatSync(f.path(scope)).isSymbolicLink(), kind !== "hardlink");
			fs.unlinkSync(f.path(scope));
		}
	}
});

test("caller-selected workspace/agent root symlinks support read/write/clear", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		const root = scope === "global" ? f.agentDir : f.cwd;
		const target = join(f.root, `${scope}-real`);
		fs.mkdirSync(target);
		fs.symlinkSync(target, root, "dir");
		assert.deepEqual(f.policy().policy, defaults);
		f.clear(scope);
		f.save(scope, {});
		assert.deepEqual(fs.readdirSync(target), [], "reads/no-op writes do not create settings beneath root links");
		f.save(scope, { capture: false });
		assert.deepEqual(f.read(scope), { archive: { capture: false } });
		assert.deepEqual(f.policy().policy, { ...defaults, capture: false });
		const directory = scope === "global" ? "extensions" : ".pi";
		assert.equal(fs.realpathSync(dirname(f.path(scope))), join(target, directory));
		f.clear(scope);
		assert.deepEqual(f.policy().policy, defaults);
		assert.deepEqual(f.read(scope), {});
	}
});

test("missing roots canonicalize their nearest existing ancestor, including a /tmp-style alias", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const actual = join(f.root, "actual-temp");
	const alias = join(f.root, "temp-alias");
	fs.mkdirSync(actual);
	fs.symlinkSync(actual, alias, "dir");
	const cwd = join(alias, "missing", "workspace");
	const agentDir = join(alias, "missing", "agent");
	assert.deepEqual(resolveArchivePolicy(cwd, agentDir), { policy: defaults, errors: [] });
	for (const scope of ["global", "project"] as const) {
		clearArchivePolicy(cwd, agentDir, scope);
		saveArchivePolicy(cwd, agentDir, scope, {});
	}
	assert.deepEqual(fs.readdirSync(actual), [], "missing roots remain absent on read/no-op operations");
	for (const scope of ["global", "project"] as const) {
		saveArchivePolicy(cwd, agentDir, scope, { modelAccess: false });
		assert.equal(fs.realpathSync(archiveConfigPath(cwd, agentDir, scope)), join(actual, "missing",
			scope === "global" ? "agent/extensions/pi-jarvis-archive.json" : "workspace/.pi/jarvis-archive.json"));
		assert.deepEqual(resolveArchivePolicy(cwd, agentDir).policy, defaults);
		clearArchivePolicy(cwd, agentDir, scope);
	}
	assert.deepEqual(resolveArchivePolicy(cwd, agentDir).policy, defaults, "existing roots beneath an ancestor link also work");
});

test("dangling or nondirectory caller-root symlinks fail closed instead of creating replacement roots", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const file = join(f.root, "root-file");
	fs.writeFileSync(file, "keep");
	for (const scope of ["global", "project"] as const) {
		const root = scope === "global" ? f.agentDir : f.cwd;
		for (const target of [join(f.root, "missing-target"), file]) {
			fs.symlinkSync(target, root);
			assert.deepEqual(f.policy().policy, off);
			assert.equal(f.policy().errors.length, 1);
			assert.throws(() => f.save(scope, { enabled: true }), /Cannot update .* archive settings/);
			assert.throws(() => f.clear(scope), /Cannot update .* archive settings/);
			assert.ok(fs.lstatSync(root).isSymbolicLink());
			fs.unlinkSync(root);
		}
	}
	assert.equal(fs.readFileSync(file, "utf8"), "keep");
});

test("appended settings directories remain unsafe even beneath a caller-selected root link", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const target = join(f.root, "outside");
	fs.mkdirSync(target);
	for (const scope of ["global", "project"] as const) {
		const root = scope === "global" ? f.agentDir : f.cwd;
		const realRoot = join(f.root, `${scope}-real`);
		fs.mkdirSync(realRoot);
		for (const rootLink of [false, true]) {
			if (rootLink) fs.symlinkSync(realRoot, root, "dir");
			else fs.mkdirSync(root);
			fs.symlinkSync(target, dirname(f.path(scope)), "dir");
			assert.deepEqual(f.policy().policy, off);
			assert.equal(f.policy().errors.length, 1);
			assert.throws(() => f.save(scope, { enabled: true }));
			assert.throws(() => f.clear(scope));
			assert.deepEqual(fs.readdirSync(target), [], "no settings, locks or temporary files escape through appended links");
			fs.unlinkSync(dirname(f.path(scope)));
			if (rootLink) fs.unlinkSync(root);
			else fs.rmdirSync(root);
		}
	}
});

test("arbitrary config symlinks stay rejected beneath supported caller-root links", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const target = join(f.root, "other-settings.json");
	const text = JSON.stringify({ modelSelection: { mode: "follow-main" }, archive: { enabled: true } });
	fs.writeFileSync(target, text);
	for (const scope of ["global", "project"] as const) {
		const root = scope === "global" ? f.agentDir : f.cwd;
		const actual = join(f.root, `${scope}-real`);
		fs.mkdirSync(actual);
		fs.symlinkSync(actual, root, "dir");
		fs.mkdirSync(dirname(f.path(scope)));
		fs.symlinkSync(target, f.path(scope));
		assert.deepEqual(f.policy().policy, off);
		assert.throws(() => f.save(scope, { enabled: false }));
		assert.throws(() => f.clear(scope));
		assert.ok(fs.lstatSync(f.path(scope)).isSymbolicLink());
		assert.equal(fs.readFileSync(target, "utf8"), text);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis-archive.json" : "jarvis-archive.json"]);
		fs.unlinkSync(f.path(scope));
	}
});

test("atomic replacement is same-directory, complete before rename, restrictive and leaves no artifacts", (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		f.put(scope, { unknown: "preserve", archive: { capture: false } });
		const initial = fs.readFileSync(f.path(scope), "utf8");
		const originalRename = fs.renameSync;
		let renamed = false;
		withFsFault("renameSync", ((from, to) => {
			assert.equal(to, f.path(scope));
			assert.equal(dirname(String(from)), dirname(String(to)));
			assert.equal(fs.readFileSync(f.path(scope), "utf8"), initial);
			assert.deepEqual(JSON.parse(fs.readFileSync(from, "utf8")), {
				unknown: "preserve", archive: { capture: false, modelAccess: false },
			});
			renamed = true;
			originalRename(from, to);
		}) as typeof fs.renameSync, () => f.save(scope, { modelAccess: false }));
		assert.ok(renamed);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis-archive.json" : "jarvis-archive.json"]);
		if (process.platform !== "win32") assert.equal(fs.statSync(f.path(scope)).mode & 0o777, 0o600);
	}
});

test("created settings directories and files are private and archive storage stays absent", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		f.save(scope, { enabled: false });
		const root = scope === "global" ? f.agentDir : f.cwd;
		assert.equal(fs.statSync(root).mode & 0o777, 0o700);
		assert.equal(fs.statSync(dirname(f.path(scope))).mode & 0o777, 0o700);
		assert.equal(fs.statSync(f.path(scope)).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis-archive.json" : "jarvis-archive.json"]);
	}
});

test("settings are reread and validated under the cooperative lock; preflight cannot repair new corruption", (t) => {
	const f = fixture(t);
	f.put("global", { archive: { capture: false } });
	const corrupt = '{"private-secret":"never echo", BROKEN';
	const originalOpen = fs.openSync;
	withFsFault("openSync", ((...args: Parameters<typeof fs.openSync>) => {
		const fd = (originalOpen as Function)(...args);
		if (String(args[0]).endsWith(".archive.lock")) fs.writeFileSync(f.path("global"), corrupt);
		return fd;
	}) as typeof fs.openSync, () => {
		assert.throws(() => f.save("global", { enabled: true }), /Cannot update global archive settings/);
	});
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), corrupt);
	assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis-archive.json"]);
});

test("failed atomic writes preserve old bytes and clean temporary files and cooperative locks", (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		f.put(scope, { private: "keep", archive: { capture: false } });
		const initial = fs.readFileSync(f.path(scope), "utf8");
		for (const key of ["openSync", "writeFileSync", "fsyncSync", "renameSync"] as const) {
			const originalOpen = fs.openSync;
			const originalWrite = fs.writeFileSync;
			withFsFault(key, ((...args: unknown[]) => {
				if (key === "openSync" && !String(args[0]).endsWith(".tmp")) return (originalOpen as Function)(...args);
				if (key === "writeFileSync") originalWrite(args[0] as number, "partial JSON");
				throw Object.assign(new Error("private-secret failure"), { code: "EIO" });
			}) as typeof fs[typeof key], () => {
				assert.throws(() => f.save(scope, { modelAccess: false }), (error) => error instanceof Error && !error.message.includes("private-secret"));
			});
			assert.equal(fs.readFileSync(f.path(scope), "utf8"), initial);
			assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis-archive.json" : "jarvis-archive.json"]);
		}
	}
});

test("target links appearing before atomic replacement are rejected without following or replacing them", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	f.put("global", { archive: { capture: false } });
	const outside = join(f.root, "outside.json");
	const outsideText = JSON.stringify({ private: "preserve fixture" });
	fs.writeFileSync(outside, outsideText);
	const originalSync = fs.fsyncSync;
	withFsFault("fsyncSync", ((fd) => {
		originalSync(fd);
		fs.unlinkSync(f.path("global"));
		fs.symlinkSync(outside, f.path("global"));
	}) as typeof fs.fsyncSync, () => assert.throws(() => f.save("global", { enabled: true }), /Cannot update global archive settings/));
	assert.ok(fs.lstatSync(f.path("global")).isSymbolicLink());
	assert.equal(fs.readFileSync(outside, "utf8"), outsideText);
	assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis-archive.json"]);
});

test("lock cleanup never unlinks a replacement lock owned by another writer", (t) => {
	const f = fixture(t);
	const lock = `${f.path("global")}.archive.lock`;
	const replacement = join(f.root, "replacement-lock");
	fs.writeFileSync(replacement, "new owner");
	const originalRename = fs.renameSync;
	withFsFault("renameSync", ((from, to) => {
		originalRename(from, to);
		if (to === f.path("global")) originalRename(replacement, lock);
	}) as typeof fs.renameSync, () => f.save("global", { enabled: true }));
	assert.deepEqual(f.read("global"), { archive: { enabled: true } });
	assert.equal(fs.readFileSync(lock, "utf8"), "new owner");
});

test("lock acquisition I/O failure cannot overwrite settings", (t) => {
	const f = fixture(t);
	f.put("global", { archive: { capture: false } });
	const initial = fs.readFileSync(f.path("global"), "utf8");
	const original = fs.openSync;
	withFsFault("openSync", ((...args: Parameters<typeof fs.openSync>) => {
		if (String(args[0]).endsWith(".archive.lock")) throw Object.assign(new Error("fixture"), { code: "EACCES" });
		return (original as Function)(...args);
	}) as typeof fs.openSync, () => assert.throws(() => f.save("global", { enabled: false })));
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), initial);
	assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis-archive.json"]);
});

test("lock metadata I/O failure closes the descriptor even when safe ownership cleanup is impossible", (t) => {
	const f = fixture(t);
	f.put("global", { archive: { capture: false } });
	const initial = fs.readFileSync(f.path("global"), "utf8");
	const originalOpen = fs.openSync;
	const originalStat = fs.fstatSync;
	let lockFd: number | undefined;
	withFsFault("openSync", ((...args: Parameters<typeof fs.openSync>) => {
		const fd = (originalOpen as Function)(...args) as number;
		if (String(args[0]).endsWith(".archive.lock")) lockFd = fd;
		return fd;
	}) as typeof fs.openSync, () => {
		withFsFault("fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => {
			if (args[0] === lockFd) throw Object.assign(new Error("fixture"), { code: "EIO" });
			return (originalStat as Function)(...args);
		}) as typeof fs.fstatSync, () => assert.throws(() => f.save("global", { enabled: false })));
	});
	assert.notEqual(lockFd, undefined);
	assert.throws(() => fs.fstatSync(lockFd!), { code: "EBADF" });
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), initial);
	assert.ok(fs.statSync(`${f.path("global")}.archive.lock`).isFile(), "unverifiable lock ownership is never stolen");
});

test("abandoned locks have a finite wait, are never stolen, and do not affect settings-only reads", (t) => {
	const f = fixture(t);
	f.put("global", { archive: { capture: false } });
	const initial = fs.readFileSync(f.path("global"), "utf8");
	const lock = `${f.path("global")}.archive.lock`;
	fs.writeFileSync(lock, "existing owner", { flag: "wx" });
	assert.deepEqual(f.policy().policy, { ...defaults, capture: false });
	const started = performance.now();
	assert.throws(() => f.save("global", { enabled: false }), /Cannot update global archive settings/);
	const elapsed = performance.now() - started;
	assert.ok(elapsed >= 1_900 && elapsed < 6_000, `bounded lock wait: ${elapsed}ms`);
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), initial);
	assert.equal(fs.readFileSync(lock, "utf8"), "existing owner");
});

test("unsafe lock targets beneath a caller-selected root link are rejected without following them", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	const realRoot = join(f.root, "real-agent");
	fs.mkdirSync(realRoot);
	fs.symlinkSync(realRoot, f.agentDir, "dir");
	f.put("global", { archive: { capture: false } });
	const lock = `${f.path("global")}.archive.lock`;
	const outside = join(f.root, "lock-target");
	fs.writeFileSync(outside, "keep");
	fs.symlinkSync(outside, lock);
	assert.throws(() => f.save("global", { modelAccess: false }));
	assert.equal(fs.readFileSync(outside, "utf8"), "keep");
	assert.ok(fs.lstatSync(lock).isSymbolicLink());
	fs.unlinkSync(lock);
	fs.linkSync(outside, lock);
	assert.throws(() => f.save("global", { modelAccess: false }));
	assert.equal(fs.readFileSync(outside, "utf8"), "keep");
	assert.equal(fs.lstatSync(lock).nlink, 2);
	fs.unlinkSync(lock);
	fs.mkdirSync(lock);
	assert.throws(() => f.save("global", { modelAccess: false }));
	assert.ok(fs.statSync(lock).isDirectory());
});

test("separate processes serialize partial archive changes and preserve unrelated settings", async (t) => {
	const f = fixture(t);
	f.put("global", { modelSelection: { mode: "follow-main" }, unknown: { keep: true } });
	// Hold all writers at the same barrier so this is actual lock contention, not serial startup.
	const lock = `${f.path("global")}.archive.lock`;
	fs.writeFileSync(lock, "test barrier", { flag: "wx" });
	const moduleUrl = new URL("../archive-config.ts", import.meta.url).href;
	const children = ["enabled", "capture", "modelAccess"].map((field) => {
		const code = `
			import { saveArchivePolicy } from ${JSON.stringify(moduleUrl)};
			process.stdout.write('ready\\n');
			for (let i = 0; i < 12; i++) {
				saveArchivePolicy(${JSON.stringify(f.cwd)}, ${JSON.stringify(f.agentDir)}, 'global', { ${field}: ${field === "capture" ? "false" : "true"} });
			}
		`;
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", code], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stderr.on("data", (data) => { stderr += String(data); });
		let readyResolve!: () => void;
		let readyReject!: (error: Error) => void;
		const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
		child.stdout.on("data", (data) => {
			stdout += String(data);
			if (stdout.includes("ready\n")) readyResolve();
		});
		const done = new Promise<void>((yes, no) => {
			child.on("error", (error) => { readyReject(error); no(error); });
			child.on("exit", (status) => {
				if (status === 0) yes();
				else {
					const error = new Error(`fixture child ${field} exited ${status}: ${stderr}`);
					readyReject(error);
					no(error);
				}
			});
		});
		// Register rejection handling immediately while the parent waits on the barrier.
		done.catch(() => {});
		return { child, ready, done };
	});
	try {
		await Promise.all(children.map(({ ready }) => ready));
		fs.unlinkSync(lock);
		await Promise.all(children.map(({ done }) => done));
	} finally {
		for (const { child } of children) if (child.exitCode === null) child.kill();
		await Promise.allSettled(children.map(({ done }) => done));
	}
	assert.deepEqual(f.read("global"), {
		modelSelection: { mode: "follow-main" }, unknown: { keep: true }, archive: { enabled: true, capture: false, modelAccess: true },
	});
	assert.deepEqual(f.policy().policy, { enabled: true, capture: false, modelAccess: true });
	assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis-archive.json"]);
});
