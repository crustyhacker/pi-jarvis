import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	clearMemoryPolicy, hasMemoryDisclosure, markMemoryDisclosure, memoryConfigPath,
	resolveMemoryPolicy, saveMemoryPolicy,
} from "../memory-config.js";
import type { MemoryPolicy } from "../memory-types.js";

type Scope = "global" | "project";
const on: MemoryPolicy = { enabled: true, capture: true, recall: true };
const off: MemoryPolicy = { enabled: false, capture: false, recall: false };

function fixture(t: TestContext) {
	const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-jarvis-memory-config-")));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const path = (scope: Scope) => memoryConfigPath(cwd, agentDir, scope);
	const write = (scope: Scope, text: string) => {
		fs.mkdirSync(dirname(path(scope)), { recursive: true });
		fs.writeFileSync(path(scope), text);
	};
	return {
		root, cwd, agentDir, path, write,
		put: (scope: Scope, config: unknown) => write(scope, JSON.stringify(config)),
		read: (scope: Scope) => JSON.parse(fs.readFileSync(path(scope), "utf8")),
		policy: (trusted = true) => resolveMemoryPolicy(cwd, agentDir, trusted),
		save: (scope: Scope, patch: Partial<MemoryPolicy>) => saveMemoryPolicy(cwd, agentDir, scope, patch),
		clear: (scope: Scope) => clearMemoryPolicy(cwd, agentDir, scope),
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

test("defaults and reads never create settings, agent directories or memory storage", (t) => {
	const f = fixture(t);
	assert.equal(f.path("project"), join(f.cwd, ".pi", "jarvis.json"));
	assert.equal(f.path("global"), join(f.agentDir, "extensions", "pi-jarvis.json"));
	for (const trusted of [true, false]) {
		assert.deepEqual(f.policy(trusted), { policy: trusted ? on : off, errors: [], global: {}, project: {} });
	}
	assert.equal(hasMemoryDisclosure(f.agentDir), false);
	f.clear("global");
	f.clear("project");
	f.save("global", {});
	f.save("project", {});
	assert.deepEqual(fs.readdirSync(f.root), []);
	assert.throws(() => memoryConfigPath(f.cwd, f.agentDir, "invalid" as Scope));
});

test("all per-field precedence combinations respect the global master switch and untrusted full pause", (t) => {
	const f = fixture(t);
	for (const field of ["enabled", "capture", "recall"] as const) {
		for (const global of [undefined, false, true]) {
			for (const project of [undefined, false, true]) {
				const globalPatch = global === undefined ? {} : { [field]: global };
				const projectPatch = project === undefined ? {} : { [field]: project };
				f.put("global", { memory: globalPatch });
				f.put("project", { memory: projectPatch });
				for (const trusted of [true, false]) {
					const result = f.policy(trusted);
					let expected = project ?? global ?? true;
					if (field === "enabled" && global === false) expected = false;
					assert.deepEqual(result, {
						policy: trusted ? { ...on, [field]: expected } : off, errors: [], global: globalPatch, project: projectPatch,
					}, `${field}: global=${global}, project=${project}, trusted=${trusted}`);
				}
			}
		}
	}
});

test("capture/recall are independent; trusted projects can override defaults but not a global disable", (t) => {
	const f = fixture(t);
	f.save("global", { enabled: false, capture: false });
	f.save("project", { enabled: true, capture: true, recall: false });
	assert.deepEqual(f.policy().policy, { enabled: false, capture: true, recall: false });
	assert.deepEqual(f.policy(false).policy, off);
	assert.deepEqual(f.read("global"), { memory: { enabled: false, capture: false } });
	assert.deepEqual(f.read("project"), { memory: { enabled: true, capture: true, recall: false } });
	assert.deepEqual(fs.readdirSync(f.agentDir), ["extensions"], "disabled resolution never touches a DB path");
	assert.deepEqual(fs.readdirSync(join(f.agentDir, "extensions")), ["pi-jarvis.json"]);
});

test("untrusted projects pause all memory but controls stay readable/manageable without config errors", (t) => {
	const f = fixture(t);
	f.save("global", { recall: false });
	f.save("project", { capture: false, recall: true });
	assert.deepEqual(f.policy(false), {
		policy: off, errors: [], global: { recall: false }, project: { capture: false, recall: true },
	});
	assert.deepEqual(f.policy().policy, { enabled: true, capture: false, recall: true });
	f.save("project", { enabled: true, capture: true, recall: true });
	assert.deepEqual(f.policy(false).policy, off);
	assert.deepEqual(f.policy().policy, on, "trust restoration resumes resolved controls");
	f.clear("project");
	assert.deepEqual(f.policy(false).policy, off);
	assert.deepEqual(f.policy().policy, { enabled: true, capture: true, recall: false });
});

test("patches preserve model/thinking, unknown keys, disclosure and unspecified controls", (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		const original = {
			modelSelection: { mode: "pinned", provider: "fixture", modelId: "local" },
			thinkingSelection: { mode: "pinned", thinkingLevel: "high" },
			unknown: { keep: [1, "test"] }, memoryDisclosedVersion: 1,
			memory: { capture: false, future: { preserve: true } },
			["__proto__"]: { safe: "own JSON property" },
		};
		f.put(scope, original);
		f.save(scope, { recall: false });
		assert.deepEqual(f.read(scope), { ...original, memory: { ...original.memory, recall: false } });
		f.save(scope, { capture: true });
		assert.deepEqual(f.read(scope).memory, { capture: true, recall: false, future: { preserve: true } });
		f.clear(scope);
		const { memory: _, ...rest } = original;
		assert.deepEqual(f.read(scope), rest);
	}
});

test("clear removes only this scope and restores fallback; an otherwise-empty file stays a JSON object", (t) => {
	const f = fixture(t);
	f.save("global", { capture: false });
	f.save("project", { capture: true, recall: false });
	f.clear("project");
	assert.deepEqual(f.policy().policy, { enabled: true, capture: false, recall: true });
	assert.deepEqual(f.read("project"), {});
	f.clear("global");
	assert.deepEqual(f.policy().policy, on);
	assert.deepEqual(f.read("global"), {});
	const before = fs.readFileSync(f.path("global"), "utf8");
	f.clear("global");
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
});

test("disclosure is global, explicit and settings-preserving; reads never mark it", (t) => {
	const f = fixture(t);
	f.put("project", { memoryDisclosedVersion: 1 });
	f.put("global", { modelSelection: { mode: "follow-main" }, unknown: ["keep"], memory: { recall: false } });
	const before = fs.readFileSync(f.path("global"), "utf8");
	assert.equal(hasMemoryDisclosure(f.agentDir), false);
	f.policy();
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
	markMemoryDisclosure(f.agentDir);
	assert.equal(hasMemoryDisclosure(f.agentDir), true);
	assert.deepEqual(f.read("global"), {
		modelSelection: { mode: "follow-main" }, unknown: ["keep"], memory: { recall: false }, memoryDisclosedVersion: 1,
	});
	f.clear("global");
	assert.equal(hasMemoryDisclosure(f.agentDir), true, "clearing policy does not clear disclosure");
	const disclosed = fs.readFileSync(f.path("global"), "utf8");
	markMemoryDisclosure(f.agentDir);
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), disclosed, "same version is a no-op");
	for (const version of [0, 2, "1", null]) {
		f.put("global", { memoryDisclosedVersion: version });
		assert.equal(hasMemoryDisclosure(f.agentDir), false);
	}
});

test("mark can create only global settings without creating memory database storage", (t) => {
	const f = fixture(t);
	markMemoryDisclosure(f.agentDir);
	assert.deepEqual(f.read("global"), { memoryDisclosedVersion: 1 });
	assert.deepEqual(fs.readdirSync(f.root), ["agent"]);
	assert.deepEqual(fs.readdirSync(f.agentDir), ["extensions"]);
	assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis.json"]);
});

test("malformed JSON/root/memory fail closed and every write preserves exact corrupt bytes", (t) => {
	const f = fixture(t);
	const invalid = [
		'{"private-secret":"never echo", BROKEN', "null", "[]", "42", "true", '"private-secret"',
		...[
			null, false, "private-secret", [], { enabled: "false" }, { capture: 0 }, { recall: null },
		].map((memory) => JSON.stringify({ private: "private-secret", memory })),
	];
	for (const scope of ["global", "project"] as const) {
		for (const text of invalid) {
			f.put("global", { memory: { enabled: true } });
			f.put("project", { memory: { enabled: true } });
			f.write(scope, text);
			const result = f.policy();
			assert.deepEqual(result.policy, off);
			assert.equal(result.errors.length, 1);
			assert.match(result.errors[0], new RegExp(scope));
			assert.ok(!result.errors.join().includes("private-secret"));
			for (const action of [() => f.save(scope, { enabled: true }), () => f.save(scope, {}), () => f.clear(scope)]) {
				assert.throws(action, /Cannot update .* memory settings/);
			}
			if (scope === "global") {
				assert.throws(() => hasMemoryDisclosure(f.agentDir), /Cannot read global memory disclosure settings/);
				assert.throws(() => markMemoryDisclosure(f.agentDir), /Cannot update global memory settings/);
			}
			assert.equal(fs.readFileSync(f.path(scope), "utf8"), text);
			assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis.json" : "jarvis.json"]);
		}
	}
	f.write("global", "{bad global");
	f.write("project", "{bad project");
	assert.deepEqual(f.policy().policy, off);
	assert.equal(f.policy().errors.length, 2);
});

test("settings over 1 MiB fail closed before file reads; all writes preserve oversized bytes", (t) => {
	const f = fixture(t);
	const limit = 1024 * 1024;
	const text = JSON.stringify({ private: "private-secret", memory: { capture: false }, padding: "é".repeat(limit / 2) });
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
				assert.throws(action, /Cannot update .* memory settings/);
			}
			if (scope === "global") {
				assert.throws(() => hasMemoryDisclosure(f.agentDir), /Cannot read global memory disclosure settings/);
				assert.throws(() => markMemoryDisclosure(f.agentDir), /Cannot update global memory settings/);
			}
		});
		assert.equal(reads, 0, "lstat size is checked before bounded file reads");
		assert.equal(fs.readFileSync(f.path(scope), "utf8"), text);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis.json" : "jarvis.json"]);
	}
});

test("opened descriptor size is checked again before bounded file reads", (t) => {
	const f = fixture(t);
	f.put("global", { memory: { capture: false } });
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
			assert.throws(() => hasMemoryDisclosure(f.agentDir));
			assert.throws(() => markMemoryDisclosure(f.agentDir));
		});
	});
	assert.equal(reads, 0, "fstat catches file growth between lstat and open");
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
});

test("growth after fstat cannot cause an unbounded read/allocation or a recovery write", (t) => {
	const f = fixture(t);
	const before = JSON.stringify({ memory: { capture: false } });
	const grown = "x".repeat(1024 * 1024 + 1);
	const originalRead = fs.readSync;
	for (const action of [
		() => {
			const result = f.policy();
			assert.deepEqual(result.policy, off);
			assert.equal(result.errors.length, 1);
		},
		() => assert.throws(() => f.save("global", { enabled: true }), /Cannot update global memory settings/),
		() => assert.throws(() => f.clear("global"), /Cannot update global memory settings/),
		() => assert.throws(() => hasMemoryDisclosure(f.agentDir), /Cannot read global memory disclosure settings/),
		() => assert.throws(() => markMemoryDisclosure(f.agentDir), /Cannot update global memory settings/),
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
		assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis.json"]);
	}
});

test("exactly 1 MiB is readable; updates that would exceed the input bound fail without replacement", (t) => {
	const f = fixture(t);
	const limit = 1024 * 1024;
	const prefix = '{"memory":{"capture":false},"padding":"';
	const remaining = limit - Buffer.byteLength(prefix + '"}', "utf8");
	const text = prefix + "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2) + '"}';
	assert.equal(Buffer.byteLength(text, "utf8"), limit);
	for (const scope of ["global", "project"] as const) {
		f.write(scope, text);
		assert.deepEqual(f.policy().policy, { ...on, capture: false });
		assert.deepEqual(f.policy().errors, []);
		assert.throws(() => f.save(scope, { enabled: true }), /Cannot update .* memory settings/);
		if (scope === "global") {
			assert.equal(hasMemoryDisclosure(f.agentDir), false);
			assert.throws(() => markMemoryDisclosure(f.agentDir), /Cannot update global memory settings/);
		}
		assert.equal(fs.readFileSync(f.path(scope), "utf8"), text);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis.json" : "jarvis.json"]);
	}
});

test("invalid runtime patches throw rather than coercing values or replacing settings", (t) => {
	const f = fixture(t);
	f.put("global", { memory: { capture: false }, unknown: "keep" });
	const before = fs.readFileSync(f.path("global"), "utf8");
	for (const patch of [null, false, [], { capture: "false" }, { enabled: undefined }, { recall: 0 }, { extra: true }]) {
		assert.throws(() => f.save("global", patch as Partial<MemoryPolicy>), /Invalid memory controls/);
		assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
	}
});

test("read I/O failures fail closed, report no secrets, and cannot trigger write recovery", (t) => {
	const f = fixture(t);
	f.put("global", { memory: { capture: false }, private: "preserve" });
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
				() => markMemoryDisclosure(f.agentDir), () => hasMemoryDisclosure(f.agentDir),
			]) assert.throws(action, (error) => error instanceof Error && !error.message.includes("private-secret"));
		});
		assert.equal(fs.readFileSync(f.path("global"), "utf8"), before);
	}
});

test("inaccessible ancestors are not treated as missing/default-on settings", (t) => {
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
	const initial = JSON.stringify({ memory: { enabled: true }, private: "keep" });
	fs.writeFileSync(target, initial);
	for (const scope of ["global", "project"] as const) {
		fs.mkdirSync(dirname(f.path(scope)), { recursive: true });
		for (const kind of ["symlink", "hardlink", "dangling"] as const) {
			if (kind === "hardlink") fs.linkSync(target, f.path(scope));
			else fs.symlinkSync(kind === "dangling" ? join(f.root, "missing") : target, f.path(scope));
			assert.deepEqual(f.policy().policy, off);
			assert.throws(() => f.save(scope, { enabled: false }));
			assert.throws(() => f.clear(scope));
			if (scope === "global") {
				assert.throws(() => markMemoryDisclosure(f.agentDir));
				assert.throws(() => hasMemoryDisclosure(f.agentDir));
			}
			assert.equal(fs.readFileSync(target, "utf8"), initial);
			assert.equal(fs.lstatSync(f.path(scope)).isSymbolicLink(), kind !== "hardlink");
			fs.unlinkSync(f.path(scope));
		}
	}
});

test("caller-selected workspace/agent root symlinks support read/write/clear and disclosure", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		const root = scope === "global" ? f.agentDir : f.cwd;
		const target = join(f.root, `${scope}-real`);
		fs.mkdirSync(target);
		fs.symlinkSync(target, root, "dir");
		assert.deepEqual(f.policy().policy, on);
		f.clear(scope);
		f.save(scope, {});
		if (scope === "global") assert.equal(hasMemoryDisclosure(f.agentDir), false);
		assert.deepEqual(fs.readdirSync(target), [], "reads/no-op writes do not create settings beneath root links");
		f.save(scope, { capture: false });
		assert.deepEqual(f.read(scope), { memory: { capture: false } });
		assert.deepEqual(f.policy().policy, { ...on, capture: false });
		const directory = scope === "global" ? "extensions" : ".pi";
		assert.equal(fs.realpathSync(dirname(f.path(scope))), join(target, directory));
		f.clear(scope);
		assert.deepEqual(f.policy().policy, on);
		assert.deepEqual(f.read(scope), {});
		if (scope === "global") {
			markMemoryDisclosure(f.agentDir);
			assert.equal(hasMemoryDisclosure(f.agentDir), true);
			assert.deepEqual(f.read(scope), { memoryDisclosedVersion: 1 });
		}
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
	assert.deepEqual(resolveMemoryPolicy(cwd, agentDir), { policy: on, errors: [], global: {}, project: {} });
	assert.equal(hasMemoryDisclosure(agentDir), false);
	for (const scope of ["global", "project"] as const) {
		clearMemoryPolicy(cwd, agentDir, scope);
		saveMemoryPolicy(cwd, agentDir, scope, {});
	}
	assert.deepEqual(fs.readdirSync(actual), [], "missing roots remain absent on read/no-op operations");
	for (const scope of ["global", "project"] as const) {
		saveMemoryPolicy(cwd, agentDir, scope, { recall: false });
		assert.equal(fs.realpathSync(memoryConfigPath(cwd, agentDir, scope)), join(actual, "missing",
			scope === "global" ? "agent/extensions/pi-jarvis.json" : "workspace/.pi/jarvis.json"));
		assert.deepEqual(resolveMemoryPolicy(cwd, agentDir).policy, { ...on, recall: false });
		clearMemoryPolicy(cwd, agentDir, scope);
	}
	markMemoryDisclosure(agentDir);
	assert.equal(hasMemoryDisclosure(agentDir), true);
	assert.deepEqual(resolveMemoryPolicy(cwd, agentDir).policy, on, "existing roots beneath an ancestor link also work");
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
			assert.throws(() => f.save(scope, { enabled: true }), /Cannot update .* memory settings/);
			assert.throws(() => f.clear(scope), /Cannot update .* memory settings/);
			if (scope === "global") {
				assert.throws(() => hasMemoryDisclosure(f.agentDir), /Cannot read global memory disclosure settings/);
				assert.throws(() => markMemoryDisclosure(f.agentDir), /Cannot update global memory settings/);
			}
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
			if (scope === "global") {
				assert.throws(() => hasMemoryDisclosure(f.agentDir));
				assert.throws(() => markMemoryDisclosure(f.agentDir));
			}
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
	const text = JSON.stringify({ modelSelection: { mode: "follow-main" }, memory: { enabled: true } });
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
		if (scope === "global") {
			assert.throws(() => markMemoryDisclosure(f.agentDir));
			assert.throws(() => hasMemoryDisclosure(f.agentDir));
		}
		assert.ok(fs.lstatSync(f.path(scope)).isSymbolicLink());
		assert.equal(fs.readFileSync(target, "utf8"), text);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis.json" : "jarvis.json"]);
		fs.unlinkSync(f.path(scope));
	}
});

test("atomic replacement is same-directory, complete before rename, restrictive and leaves no artifacts", (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		f.put(scope, { unknown: "preserve", memory: { capture: false } });
		const initial = fs.readFileSync(f.path(scope), "utf8");
		const originalRename = fs.renameSync;
		let renamed = false;
		withFsFault("renameSync", ((from, to) => {
			assert.equal(to, f.path(scope));
			assert.equal(dirname(String(from)), dirname(String(to)));
			assert.equal(fs.readFileSync(f.path(scope), "utf8"), initial);
			assert.deepEqual(JSON.parse(fs.readFileSync(from, "utf8")), {
				unknown: "preserve", memory: { capture: false, recall: false },
			});
			renamed = true;
			originalRename(from, to);
		}) as typeof fs.renameSync, () => f.save(scope, { recall: false }));
		assert.ok(renamed);
		assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis.json" : "jarvis.json"]);
		if (process.platform !== "win32") assert.equal(fs.statSync(f.path(scope)).mode & 0o777, 0o600);
	}
});

test("failed atomic writes preserve old bytes and clean temporary files and cooperative locks", (t) => {
	const f = fixture(t);
	for (const scope of ["global", "project"] as const) {
		f.put(scope, { private: "keep", memory: { capture: false } });
		const initial = fs.readFileSync(f.path(scope), "utf8");
		for (const key of ["openSync", "writeFileSync", "fsyncSync", "renameSync"] as const) {
			const originalOpen = fs.openSync;
			const originalWrite = fs.writeFileSync;
			withFsFault(key, ((...args: unknown[]) => {
				if (key === "openSync" && !String(args[0]).endsWith(".tmp")) return (originalOpen as Function)(...args);
				if (key === "writeFileSync") originalWrite(args[0] as number, "partial JSON");
				throw Object.assign(new Error("private-secret failure"), { code: "EIO" });
			}) as typeof fs[typeof key], () => {
				assert.throws(() => f.save(scope, { recall: false }), (error) => error instanceof Error && !error.message.includes("private-secret"));
			});
			assert.equal(fs.readFileSync(f.path(scope), "utf8"), initial);
			assert.deepEqual(fs.readdirSync(dirname(f.path(scope))), [scope === "global" ? "pi-jarvis.json" : "jarvis.json"]);
		}
	}
});

test("lock acquisition I/O failure cannot overwrite settings", (t) => {
	const f = fixture(t);
	f.put("global", { memory: { capture: false } });
	const initial = fs.readFileSync(f.path("global"), "utf8");
	const original = fs.openSync;
	withFsFault("openSync", ((...args: Parameters<typeof fs.openSync>) => {
		if (String(args[0]).endsWith(".memory.lock")) throw Object.assign(new Error("fixture"), { code: "EACCES" });
		return (original as Function)(...args);
	}) as typeof fs.openSync, () => assert.throws(() => f.save("global", { enabled: false })));
	assert.equal(fs.readFileSync(f.path("global"), "utf8"), initial);
	assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis.json"]);
});

test("lock metadata I/O failure closes the descriptor even when safe ownership cleanup is impossible", (t) => {
	const f = fixture(t);
	f.put("global", { memory: { capture: false } });
	const initial = fs.readFileSync(f.path("global"), "utf8");
	const originalOpen = fs.openSync;
	const originalStat = fs.fstatSync;
	let lockFd: number | undefined;
	withFsFault("openSync", ((...args: Parameters<typeof fs.openSync>) => {
		const fd = (originalOpen as Function)(...args) as number;
		if (String(args[0]).endsWith(".memory.lock")) lockFd = fd;
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
	assert.ok(fs.statSync(`${f.path("global")}.memory.lock`).isFile(), "unverifiable lock ownership is never stolen");
});

test("abandoned locks have a finite wait, are never stolen, and do not affect settings-only reads", (t) => {
	const f = fixture(t);
	f.put("global", { memory: { capture: false } });
	const initial = fs.readFileSync(f.path("global"), "utf8");
	const lock = `${f.path("global")}.memory.lock`;
	fs.writeFileSync(lock, "existing owner", { flag: "wx" });
	assert.deepEqual(f.policy().policy, { enabled: true, capture: false, recall: true });
	const started = performance.now();
	assert.throws(() => f.save("global", { enabled: false }), /Cannot update global memory settings/);
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
	f.put("global", { memory: { capture: false } });
	const lock = `${f.path("global")}.memory.lock`;
	const outside = join(f.root, "lock-target");
	fs.writeFileSync(outside, "keep");
	fs.symlinkSync(outside, lock);
	assert.throws(() => f.save("global", { recall: false }));
	assert.equal(fs.readFileSync(outside, "utf8"), "keep");
	assert.ok(fs.lstatSync(lock).isSymbolicLink());
	fs.unlinkSync(lock);
	fs.mkdirSync(lock);
	assert.throws(() => f.save("global", { recall: false }));
	assert.ok(fs.statSync(lock).isDirectory());
});

test("separate processes serialize partial memory/disclosure changes and preserve unrelated settings", async (t) => {
	const f = fixture(t);
	f.put("global", { modelSelection: { mode: "follow-main" }, unknown: { keep: true } });
	// Hold all writers at the same barrier so this is actual lock contention, not serial startup.
	const lock = `${f.path("global")}.memory.lock`;
	fs.writeFileSync(lock, "test barrier", { flag: "wx" });
	const moduleUrl = new URL("../memory-config.ts", import.meta.url).href;
	const children = ["enabled", "capture", "recall", "disclosure"].map((field) => {
		const code = `
			import { saveMemoryPolicy, markMemoryDisclosure } from ${JSON.stringify(moduleUrl)};
			process.stdout.write('ready\\n');
			for (let i = 0; i < 12; i++) {
				${field === "disclosure"
					? `markMemoryDisclosure(${JSON.stringify(f.agentDir)});`
					: `saveMemoryPolicy(${JSON.stringify(f.cwd)}, ${JSON.stringify(f.agentDir)}, 'global', { ${field}: false });`}
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
		modelSelection: { mode: "follow-main" }, unknown: { keep: true }, memory: off, memoryDisclosedVersion: 1,
	});
	assert.deepEqual(f.policy().policy, off);
	assert.deepEqual(fs.readdirSync(dirname(f.path("global"))), ["pi-jarvis.json"]);
});
