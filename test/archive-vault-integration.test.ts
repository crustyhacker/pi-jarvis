import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolveArchivePolicy, saveArchivePolicy } from "../archive-config.js";
import { unlockArchiveEnvelope } from "../archive-crypto.js";
import { ARCHIVE_TOOL_NAMES, createArchiveExtensionFactory, type ArchiveExtensionOptions } from "../archive-extension.js";
import type { ArchiveKeychain } from "../archive-keychain.js";
import { SharedArchiveService, type ArchiveServiceOptions } from "../archive-service.js";
import { ArchiveStore } from "../archive-store.js";
import { openEncryptedArchiveDatabase, type ArchiveDatabase } from "../archive-sqlite.js";
import type { ArchiveInput, ArchivePage, ArchiveRead } from "../archive-types.js";
import { ArchiveVaultFiles, type VaultReady } from "../archive-vault-files.js";

// Real service, configuration, migration and cipher database; fake human input
// and credentials only. No provider is registered and every path is disposable.
const PASSWORD = "vault integration fixture password, never a user credential";
const PRIVATE_ERROR = "VAULT_PRIVATE_ERROR_CANARY";
const require = createRequire(import.meta.url);
function nativeAvailable(t: TestContext): boolean {
	try { require.resolve("better-sqlite3-multiple-ciphers"); }
	catch (error) {
		if ((error as { code?: unknown }).code !== "MODULE_NOT_FOUND" || process.env.CI) throw error;
		t.skip("optional encrypted SQLite package is not installed"); return false;
	}
	assert.equal(require("better-sqlite3-multiple-ciphers/package.json").version, "13.0.3");
	// Installed binding/profile failures are test failures, not skips or builds.
	return true;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
class FakeKeychain implements ArchiveKeychain {
	readonly entries = new Map<string, Buffer>();
	readonly calls: Array<{ op: "get" | "set" | "delete"; account: string }> = [];
	onGet?: (account: string) => Promise<Buffer | undefined>;
	onSet?: (account: string, key: Buffer) => Promise<void>;
	onDelete?: (account: string) => Promise<void>;
	private record(op: "get" | "set" | "delete", account: string): void {
		assert.match(account, /^[a-f0-9]{64}$/);
		this.calls.push({ op, account });
	}
	async get(account: string): Promise<Buffer | undefined> {
		this.record("get", account);
		if (this.onGet) return this.onGet(account);
		const key = this.entries.get(account); return key ? Buffer.from(key) : undefined;
	}
	async set(account: string, key: Buffer): Promise<void> {
		this.record("set", account); assert.equal(key.length, 32);
		if (this.onSet) return this.onSet(account, key);
		this.entries.get(account)?.fill(0); this.entries.set(account, Buffer.from(key));
	}
	async delete(account: string): Promise<void> {
		this.record("delete", account);
		if (this.onDelete) return this.onDelete(account);
		this.entries.get(account)?.fill(0); this.entries.delete(account);
	}
	dispose(): void { for (const key of this.entries.values()) key.fill(0); this.entries.clear(); }
}
interface Fixture {
	root: string; agentDir: string; project: string; otherProject: string;
	service: SharedArchiveService; keychain: FakeKeychain;
	prompt: { calls: Array<{ title: string; signal: AbortSignal }>; handler: (title: string, signal: AbortSignal) => Promise<string | undefined> };
	notices: string[]; foreground: string[];
	context: (sessionId?: string, cwd?: string, trusted?: () => boolean) => ExtensionContext;
	recreate: (options?: ArchiveServiceOptions) => SharedArchiveService;
}
function fixture(t: TestContext): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-vault-integration-"));
	const agentDir = join(root, "agent"), project = join(root, "project"), otherProject = join(root, "other-project");
	for (const path of [agentDir, project, otherProject]) mkdirSync(path);
	const keychain = new FakeKeychain(), notices: string[] = [], foreground: string[] = [], services: SharedArchiveService[] = [];
	const prompt: Fixture["prompt"] = { calls: [], handler: async () => PASSWORD };
	const context: Fixture["context"] = (sessionId = "main-owner", cwd = project, trusted = () => true) => {
		const manager = SessionManager.inMemory(cwd), header = manager.getHeader()!;
		manager.getSessionId = () => sessionId;
		manager.getHeader = () => ({ ...header, id: manager.getSessionId() });
		return { cwd, mode: "tui", hasUI: true, sessionManager: manager, isProjectTrusted: trusted,
			ui: { notify: (text: string) => notices.push(text), input: () => assert.fail("No ordinary password input fallback"),
				confirm: async () => assert.fail("No generic confirmation substitutes for literal flags") },
		} as unknown as ExtensionContext;
	};
	const f = { root, agentDir, project, otherProject, keychain, prompt, notices, foreground, context } as Fixture;
	f.recreate = (options = {}) => {
		const service = new SharedArchiveService(agentDir, {
			beforeSecretPrompt: () => { foreground.push("private-prompt"); },
			vault: { keychain, prompt: async (_ctx, title, signal) => {
				prompt.calls.push({ title, signal }); return prompt.handler(title, signal);
			} }, ...options,
		});
		services.push(service); f.service = service; return service;
	};
	f.recreate();
	t.mock.method(globalThis, "fetch", async () => assert.fail("Archive integration must never contact a provider/network"));
	t.after(() => {
		try { for (const service of services) service.close("quit"); }
		finally { keychain.dispose(); rmSync(root, { recursive: true, force: true }); }
	});
	return f;
}
type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
function mount(f: Fixture, lane: "main" | "jarvis", ctx: ExtensionContext, options: ArchiveExtensionOptions = {}) {
	const handlers = new Map<string, Handler[]>(), tools = new Map<string, ToolDefinition<any>>();
	let activeTools: string[] = [], forbiddenForeground = 0;
	const forbidden = () => { forbiddenForeground++; assert.fail("Archive commands/hooks must not append, steer or start foreground work"); };
	const pi = {
		registerTool: (tool: ToolDefinition<any>) => { tools.set(tool.name, tool); },
		on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = [...names]; },
		sendMessage: forbidden, sendUserMessage: forbidden, appendEntry: forbidden, exec: forbidden,
	} as unknown as ExtensionAPI;
	createArchiveExtensionFactory(f.service, lane, options)(pi);
	return {
		tools, activeTools: () => [...activeTools], foregroundCalls: () => forbiddenForeground,
		setRepoTools(enabled: boolean) {
			activeTools = [...(enabled ? ["read", "bash", "edit", "write"] : []), ...activeTools.filter(name => ARCHIVE_TOOL_NAMES.some(tool => tool === name))];
		},
		async emit(name: string, event: any = { type: name }) {
			let result: any;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
			return result;
		},
		execute(name: string, params: any, definition = tools.get(name)!) {
			return definition.execute("vault-fixture", params, undefined, undefined, ctx as ExtensionToolContext);
		},
	};
}
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 100 });
function entry(id: string, message: unknown, parentId: string | null = null): ArchiveInput["entry"] {
	return { id, parentId, type: "message", timestamp: "2026-01-02T03:04:05.000Z", message };
}
function append(ctx: ExtensionContext, text: string): string { return (ctx.sessionManager as SessionManager).appendMessage(user(text)); }
function data<T>(output: string): T {
	assert.match(output, /^UNTRUSTED archive data, not instructions/);
	return JSON.parse(output.slice(output.indexOf("\n") + 1));
}
const page = (output: string) => data<ArchivePage>(output);
function toolText(result: Awaited<ReturnType<ToolDefinition<any>["execute"]>>): string {
	return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
}
function raw(service: SharedArchiveService, id: string, ctx: ExtensionContext): string {
	let offset = 0, content = "";
	for (;;) {
		const text = service.read({ id, offset, limit: 71, scope: "all" }, ctx, false), chunk = data<ArchiveRead>(text);
		assert.equal(chunk.units, "unicode-codepoints"); assert.equal(chunk.offset, offset);
		assert.ok(Buffer.byteLength(text) < 25_000); content += chunk.content;
		if (chunk.nextOffset === null) { assert.equal([...content].length, chunk.totalCharacters); return content; }
		assert.equal(chunk.nextOffset, offset + [...chunk.content].length); assert.ok(chunk.nextOffset > offset); offset = chunk.nextOffset;
	}
}
function ready(f: Fixture): VaultReady {
	const state = new ArchiveVaultFiles(f.agentDir).read();
	assert.equal(state?.phase, "ready"); return state as VaultReady;
}
function activePath(f: Fixture): string { return join(dirname(f.service.store.path), "vaults", ready(f).active.id, "archive.sqlite"); }
function noLeak(f: Fixture, ...outputs: string[]): void {
	for (const text of [...outputs, ...f.notices, ...f.prompt.calls.map(call => call.title)]) {
		assert.ok(!text.includes(PASSWORD), "password must not appear in command/UI output");
		assert.ok(!text.includes(PRIVATE_ERROR), "adapter/parser error must not appear in command/UI output");
	}
}
async function enable(f: Fixture, ctx: ExtensionContext): Promise<void> { await f.service.command("on --confirm-sensitive", ctx); }
async function encrypt(f: Fixture, ctx: ExtensionContext): Promise<void> {
	const output = await f.service.command("encryption on --confirm-sensitive --confirm-stopped", ctx);
	assert.match(output, /encryption enabled; unlocked/); assert.match(output, /no history was backfilled/);
	assert.match(output, /Source retained.*cleanup.*not forensic erasure/); noLeak(f, output);
	assert.ok(ready(f).active.envelope); assert.equal(f.service.policy(ctx).enabled, true);
}
function transcript(f: Fixture, sessionId: string, text: string, directory = join(f.agentDir, "sessions")): string {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, sessionId + ".jsonl");
	writeFileSync(path, [JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: f.project, timestamp: "2026-01-01T00:00:00Z" }),
		JSON.stringify(entry("imported-entry", user(text)))].join("\n") + "\n");
	return path;
}
async function preview(f: Fixture, ctx: ExtensionContext): Promise<string> {
	const result = JSON.parse(await f.service.command("import-all", ctx));
	assert.equal(result.kind, "archive-import-preview"); assert.equal(result.candidates, 1); return result.previewId;
}

// Run this in a fresh process so a previously exercised native database cannot
// mask a constructor/start/status credential or cipher-backend load regression.
test("default production OFF constructors/start/status are inert with no native credentials or database", t => {
	const f = fixture(t);
	const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {createRequire} from 'node:module';
		const require=createRequire(import.meta.url), {SharedArchiveService}=await import(${JSON.stringify(new URL("../archive-service.ts", import.meta.url).href)});
		const [agent,cwd]=process.argv.slice(1), ctx={cwd,mode:'tui',hasUI:true,isProjectTrusted:()=>true,
			sessionManager:{getSessionId:()=> 'inert-owner',getEntries:()=>assert.fail('OFF journal read')},ui:{notify:()=>assert.fail('OFF notice')}};
		const production=new SharedArchiveService(agent), isolated=new SharedArchiveService(agent);
		for(const service of [production,isolated]){await service.start(ctx); assert.equal(service.policy(ctx).enabled,false);
			await service.command('status',ctx); service.capture({},'main',ctx); await assert.rejects(service.command('stats',ctx),/disabled/);}
		assert.match(await production.command('encryption on --confirm-sensitive --confirm-stopped',ctx),/enabled in a trusted project/);
		assert.match(await production.command('unlock remember',ctx),/enabled in a trusted project/);
		assert.match(await isolated.command('encryption status',ctx),/legacy plaintext/); await isolated.command('lock',ctx);
		production.close('quit');isolated.close('quit');assert.deepEqual(fs.readdirSync(agent),[]);
		assert.ok(!Object.keys(require.cache).some(path=>path.includes('@napi-rs/keyring')||path.includes('better-sqlite3-multiple-ciphers')));`;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.agentDir, f.project], { encoding: "utf8", timeout: 20_000 });
	assert.equal(child.status, 0, child.stderr); assert.doesNotMatch(child.stderr, /SQLite|ExperimentalWarning/);
	assert.deepEqual(readdirSync(f.agentDir), []); assert.equal(f.keychain.calls.length, 0); assert.equal(f.prompt.calls.length, 0);
});

test("vault commands require literal acknowledgements, reject inline secrets/extra arguments, and never reach ordinary input or foreground work", async t => {
	const f = fixture(t), ctx = f.context(); await f.service.start(ctx);
	const main = mount(f, "main", ctx), side = mount(f, "jarvis", f.context("side"));
	await main.emit("session_start"); await side.emit("session_start");
	await enable(f, ctx);
	for (const command of [
		"encryption on", "encryption on --confirm-sensitive", "encryption on --confirm-stopped",
		"encryption on --confirm-sensitive=true --confirm-stopped", "encryption on --confirm-sensitive --confirm-stopped=true",
		"encryption on --confirm-sensitive --confirm-sensitive --confirm-stopped",
		`encryption on --confirm-sensitive --confirm-stopped ${PRIVATE_ERROR}`,
		"encryption off --confirm-sensitive", "encryption cleanup --confirm-stopped", "encryption recover --confirm-sensitive --confirm-stopped",
		"encryption break-lock --confirm-sensitive", `unlock ${PRIVATE_ERROR}`, `unlock session ${PRIVATE_ERROR}`,
		"unlock for 0", "unlock idle 10081", "unlock for 1.5", `password ${PRIVATE_ERROR}`, `lock ${PRIVATE_ERROR}`,
		`startup remember ${PRIVATE_ERROR}`, `encryption status ${PRIVATE_ERROR}`, "encryption on --project --confirm-sensitive --confirm-stopped",
	]) {
		const output = await f.service.command(command, ctx); assert.match(output, /Invalid archive vault command/); noLeak(f, output);
	}
	assert.equal(f.prompt.calls.length, 0); assert.equal(f.keychain.calls.length, 0); assert.equal(existsSync(f.service.store.path), false);
	assert.equal(new ArchiveVaultFiles(f.agentDir).read(), undefined);
	assert.deepEqual(main.activeTools(), []); assert.deepEqual(side.activeTools(), []);
	assert.deepEqual([...main.tools.keys()].sort(), [...ARCHIVE_TOOL_NAMES].sort(), "models receive read-only tools, never vault controls");
	assert.equal(main.foregroundCalls() + side.foregroundCalls(), 0); assert.deepEqual(f.foreground, []);
});

test("human plaintext-to-cipher conversion preserves raw/provenance/FTS/tombstones and is independent of model access and Repo tools", async t => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t), mainCtx = f.context(), sideCtx = f.context("side-source"); await f.service.start(mainCtx);
	append(mainCtx, "HISTORICAL_VAULT_CANARY");
	const main = mount(f, "main", mainCtx), side = mount(f, "jarvis", sideCtx);
	await main.emit("session_start"); await side.emit("session_start"); await enable(f, mainCtx);
	const values = [
		entry("raw-user", { role: "user", content: [{ type: "text", text: "vaultfixture unfiltered api_key=disposable-secret 🛰️<>𐐀" },
			{ type: "image", mimeType: "image/png", data: "OPAQUE_VAULT_IMAGE" }], timestamp: 100 }),
		entry("raw-assistant", { role: "assistant", stopReason: "toolUse", timestamp: 200, content: [
			{ type: "thinking", thinking: "vaultfixture exposed reasoning", thinkingSignature: "OPAQUE_VAULT_SIGNATURE" },
			{ type: "toolCall", id: "fake-call", name: "fixture_tool", arguments: { value: "vaultfixture exact tool arguments" } },
		] }, "raw-user"),
		entry("raw-error", { role: "toolResult", toolName: "fixture_tool", toolCallId: "fake-call", isError: true,
			content: "vaultfixture final tool error", timestamp: 300, details: { exact: true } }, "raw-assistant"),
	];
	for (const [i, value] of values.entries()) f.service.capture(value, i === 1 ? "jarvis" : "main", i === 1 ? sideCtx : mainCtx);
	const foreign = entry("foreign", user("vaultfixture FOREIGN_PAYLOAD_VAULT_CANARY"));
	f.service.capture(foreign, "main", f.context("foreign-source", f.otherProject));
	const deletedPath = transcript(f, "deleted-source", "TOMBSTONED_VAULT_CANARY"), sourceBytes = readFileSync(deletedPath);
	assert.match(await f.service.command(`import --confirm-sensitive ${deletedPath}`, mainCtx), /Imported 2 entries/);
	assert.match(await f.service.command("forget-session --confirm deleted-source", mainCtx), /Deleted 2/);
	const token = await preview(f, mainCtx);
	const before = page(f.service.search({ query: "vaultfixture", scope: "all" }, mainCtx, false)).records;
	const beforeStats = JSON.parse(await f.service.command("stats --all", mainCtx));
	f.service.store.close(); const plaintextBytes = readFileSync(f.service.store.path);
	assert.equal(plaintextBytes.subarray(0, 16).toString(), "SQLite format 3\0");
	await encrypt(f, mainCtx);
	assert.equal(f.prompt.calls.length, 2); assert.equal(f.keychain.calls.length, 0);
	assert.deepEqual(ready(f).retired.map(generation => generation.id), ["legacy"]);
	assert.deepEqual(readFileSync(f.service.store.path), plaintextBytes, "conversion retains, never rewrites/deletes, the plaintext source");
	const cipherPath = activePath(f), cipherDirectory = dirname(cipherPath);
	for (const name of readdirSync(cipherDirectory)) {
		const bytes = readFileSync(join(cipherDirectory, name));
		assert.ok(!bytes.includes(Buffer.from("vaultfixture")), `active ${name} must not contain plaintext indexed/raw data`);
		assert.notEqual(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
	}
	assert.ok(!readFileSync(new ArchiveVaultFiles(f.agentDir).statePath, "utf8").includes(PASSWORD));
	const after = page(f.service.search({ query: "vaultfixture", scope: "all" }, mainCtx, false)).records;
	assert.deepEqual(after, before); assert.deepEqual(JSON.parse(await f.service.command("stats --all", mainCtx)), beforeStats);
	for (const value of [...values, foreign]) {
		const record = after.find(record => record.entryId === value.id)!; assert.ok(record);
		assert.equal(raw(f.service, record.id, mainCtx), JSON.stringify(value));
	}
	for (const [query, expected] of [['"exposed reasoning"', 1], ['"exact tool arguments"', 1], ['"final tool error"', 1], ["OPAQUE_VAULT_IMAGE", 0], ["OPAQUE_VAULT_SIGNATURE", 0], ["HISTORICAL_VAULT_CANARY", 0]] as const) {
		assert.equal(page(f.service.search({ query }, mainCtx, false)).records.length, expected, `FTS query: ${query}`);
	}
	assert.equal(page(f.service.search({ query: "FOREIGN_PAYLOAD_VAULT_CANARY" }, mainCtx, false)).records.length, 0);
	assert.equal(page(f.service.search({ query: "FOREIGN_PAYLOAD_VAULT_CANARY", scope: "all" }, mainCtx, false)).records.length, 1);
	assert.match(await f.service.command(`import --confirm-sensitive ${deletedPath}`, mainCtx), /0 entries; 0 duplicates and 2 deleted identities skipped/);
	assert.deepEqual(readFileSync(deletedPath), sourceBytes);
	await assert.rejects(f.service.command(`import-all --confirm-sensitive --preview ${token}`, mainCtx), /matching prior preview/);
	assert.throws(() => f.service.search({ query: "vaultfixture" }, mainCtx), /model access/);
	main.setRepoTools(true); side.setRepoTools(true); await main.emit("agent_settled"); await side.emit("agent_settled");
	assert.deepEqual(main.activeTools().sort(), ["bash", "edit", "read", "write"]);
	assert.ok(!side.activeTools().some(name => name.startsWith("jarvis_archive_")));
	await f.service.command("model-access on --confirm-sensitive", mainCtx);
	main.setRepoTools(false); side.setRepoTools(false);
	for (const extension of [main, side]) {
		await extension.emit("agent_settled"); assert.deepEqual(extension.activeTools().sort(), [...ARCHIVE_TOOL_NAMES].sort());
		assert.equal(page(toolText(await extension.execute("jarvis_archive_search", { query: "vaultfixture" }))).records.length, 3);
	}
	await f.service.command("model-access off", mainCtx);
	append(sideCtx, "AFTER_MODEL_OFF_VAULT_CANARY"); await side.emit("turn_end");
	assert.equal(page(f.service.search({ query: "AFTER_MODEL_OFF_VAULT_CANARY" }, mainCtx, false)).records.length, 1);
	const event = { systemPrompt: "HOST_UNCHANGED", systemPromptOptions: { selectedTools: ["host_tool", ...ARCHIVE_TOOL_NAMES] } };
	await main.emit("before_agent_start", event); assert.equal(event.systemPrompt, "HOST_UNCHANGED"); assert.deepEqual(event.systemPromptOptions.selectedTools, ["host_tool"]);
	assert.equal(main.foregroundCalls() + side.foregroundCalls(), 0); assert.deepEqual(f.foreground, ["private-prompt", "private-prompt"]); noLeak(f);
});

test("lock revokes captured definitions in both lanes with no record/journal access; unlock baselines exclude all locked entries and previews", async t => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t), mainCtx = f.context(), sideCtx = f.context("side-lock"); await f.service.start(mainCtx);
	const main = mount(f, "main", mainCtx), side = mount(f, "jarvis", sideCtx);
	await main.emit("session_start"); await side.emit("session_start"); await enable(f, mainCtx); await encrypt(f, mainCtx);
	await f.service.command("model-access on --confirm-sensitive", mainCtx);
	for (const [ctx, extension] of [[mainCtx, main], [sideCtx, side]] as const) { append(ctx, "BEFORE_LOCK_VAULT_CANARY"); await extension.emit("turn_end"); }
	const oldDefinitions = [main, side].map(extension => ARCHIVE_TOOL_NAMES.map(name => extension.tools.get(name)!));
	const knownRecord = page(f.service.search({ query: "BEFORE_LOCK_VAULT_CANARY" }, mainCtx, false)).records[0]!;
	transcript(f, "locked-preview", "LOCKED_PREVIEW_VAULT_CANARY"); const token = await preview(f, mainCtx);
	assert.match(await f.service.command("lock", mainCtx), /Archive locked/);
	assert.equal(resolveArchivePolicy(f.project, f.agentDir, true).policy.modelAccess, true, "locking does not change user model/recording settings");
	const cipherBytes = readFileSync(activePath(f));
	const recordCalls: string[] = [], journalCalls: string[] = [];
	for (const method of ["append", "search", "read", "session", "stats", "forgetSession", "prune"] as const) {
		t.mock.method(ArchiveStore.prototype, method, () => { recordCalls.push(method); throw new Error(PRIVATE_ERROR); });
	}
	for (const [name, ctx] of [["main", mainCtx], ["jarvis", sideCtx]] as const) {
		t.mock.method(ctx.sessionManager, "getEntries", () => { journalCalls.push(name); throw new Error(PRIVATE_ERROR); });
		append(ctx, `LOCKED_${name}_VAULT_CANARY`);
	}
	for (const [i, extension] of [main, side].entries()) {
		assert.deepEqual(extension.activeTools(), []);
		for (const name of ["message_end", "turn_end", "agent_settled", "session_tree", "session_compact"]) await extension.emit(name);
		for (const [j, name] of ARCHIVE_TOOL_NAMES.entries()) {
			assert.equal(extension.tools.get(name)!.exposure, "hidden");
			assert.equal((await extension.emit("tool_call", { toolName: name })).block, true);
			await assert.rejects(extension.execute(name, {}, oldDefinitions[i]![j]!), /expired|disabled/);
		}
	}
	f.service.capture(entry("locked-direct", user("LOCKED_DIRECT_VAULT_CANARY")), "main", mainCtx);
	for (const command of ["search vaultfixture", `read ${knownRecord.id}`, "session main-owner", "stats", "forget-session --confirm main-owner", "prune --confirm 2026-01-01T00:00:00Z"]) {
		await assert.rejects(f.service.command(command, mainCtx), /disabled|locked/);
	}
	assert.match(await f.service.command("encryption status", mainCtx), /locked/);
	assert.deepEqual(recordCalls, []); assert.deepEqual(journalCalls, []); assert.deepEqual(readFileSync(activePath(f)), cipherBytes);
	// Restore only our record/journal traps before successful authentication and
	// fresh baselines. Fetch remains forbidden throughout the unlocked phase.
	t.mock.restoreAll();
	t.mock.method(globalThis, "fetch", async () => assert.fail("No provider/network"));
	assert.match(await f.service.command("unlock", mainCtx), /unlocked \(session\)/);
	await assert.rejects(f.service.command(`import-all --confirm-sensitive --preview ${token}`, mainCtx), /matching prior preview/);
	for (const [i, extension] of [main, side].entries()) {
		assert.deepEqual(extension.activeTools().sort(), [...ARCHIVE_TOOL_NAMES].sort());
		for (const [j, name] of ARCHIVE_TOOL_NAMES.entries()) await assert.rejects(extension.execute(name, {}, oldDefinitions[i]![j]!), /expired/);
	}
	for (const [ctx, extension] of [[mainCtx, main], [sideCtx, side]] as const) {
		await extension.emit("agent_settled"); append(ctx, "AFTER_UNLOCK_VAULT_CANARY"); await extension.emit("turn_end");
	}
	assert.equal(page(f.service.search({ query: "BEFORE_LOCK_VAULT_CANARY" }, mainCtx, false)).records.length, 2);
	assert.equal(page(f.service.search({ query: "AFTER_UNLOCK_VAULT_CANARY" }, mainCtx, false)).records.length, 2);
	for (const query of ["LOCKED_main_VAULT_CANARY", "LOCKED_jarvis_VAULT_CANARY", "LOCKED_DIRECT_VAULT_CANARY", "LOCKED_PREVIEW_VAULT_CANARY"]) {
		assert.equal(page(f.service.search({ query }, mainCtx, false)).records.length, 0, "unlock must never backfill locked records/imports");
	}
	assert.equal(main.foregroundCalls() + side.foregroundCalls(), 0); noLeak(f);
});

test("fresh services hand off process unlock on new/resume/fork, revoke old owners and session grants, and never hand off on quit/reload", async t => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t); let ctx = f.context(); await f.service.start(ctx); await enable(f, ctx); await encrypt(f, ctx);
	await f.service.command("model-access on --confirm-sensitive", ctx);
	f.service.capture(entry("lifecycle", user("LIFECYCLE_VAULT_CANARY")), "main", ctx);
	const sessionOwner = f.service; sessionOwner.close("new"); f.recreate(); ctx = f.context("after-session-new"); await f.service.start(ctx);
	assert.equal(f.service.policy(ctx).enabled, false, "default session grant cannot survive factory recreation");
	assert.throws(() => sessionOwner.search({ query: "LIFECYCLE_VAULT_CANARY" }, ctx, false), /disabled|revoked|locked/);
	assert.equal(f.prompt.calls.length, 2, "manual startup does not implicitly prompt after a session grant expires");
	assert.match(await f.service.command("unlock process", ctx), /unlocked \(process\)/);
	const promptCount = f.prompt.calls.length;
	for (const reason of ["new", "resume", "fork"] as const) {
		const old = f.service, oldContext = ctx, oldMount = mount(f, "main", oldContext); await oldMount.emit("session_start");
		const stale = oldMount.tools.get("jarvis_archive_search")!;
		old.close(reason); f.recreate(); ctx = f.context(`process-after-${reason}`); await f.service.start(ctx);
		assert.equal(f.service.policy(ctx).enabled, true, `${reason} must adopt the process-local lease in a new service`);
		assert.equal(page(f.service.search({ query: "LIFECYCLE_VAULT_CANARY" }, ctx, false)).records.length, 1);
		assert.throws(() => old.search({ query: "LIFECYCLE_VAULT_CANARY" }, oldContext, false), /disabled|revoked|locked/);
		await assert.rejects(oldMount.execute("jarvis_archive_search", { query: "LIFECYCLE_VAULT_CANARY" }, stale), /expired|disabled/);
	}
	assert.equal(f.prompt.calls.length, promptCount); assert.equal(f.keychain.calls.length, 0);
	for (const reason of ["quit", "reload"] as const) {
		if (reason === "reload") assert.match(await f.service.command("unlock process", ctx), /unlocked \(process\)/);
		f.service.close(reason); f.recreate(); ctx = f.context(`after-${reason}`); await f.service.start(ctx);
		assert.equal(f.service.policy(ctx).enabled, false, `${reason} must destroy nonremembered process leases`);
		assert.throws(() => f.service.search({ query: "LIFECYCLE_VAULT_CANARY" }, ctx, false), /disabled|locked/);
	}
	noLeak(f);
});

test("remembered fake-keychain restart is main-only, respects direct OFF/untrusted policy and never restores merely on re-enable", async t => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t), first = f.context(); await f.service.start(first); await enable(f, first); await encrypt(f, first);
	f.service.capture(entry("remember", user("REMEMBERED_VAULT_CANARY")), "main", first);
	assert.match(await f.service.command("startup remember", first), /persistent-local/);
	const account = ready(f).remember!.account; assert.equal(f.keychain.entries.size, 1);
	f.service.close("quit"); saveArchivePolicy(f.project, f.agentDir, "global", { enabled: false });
	f.recreate(); let trusted = false; const ctx = f.context("remember-restart", f.project, () => trusted), side = mount(f, "jarvis", f.context("remember-side"));
	const nativeGets = () => f.keychain.calls.filter(call => call.op === "get").length;
	assert.equal(nativeGets(), 0, "constructor cannot restore native credentials");
	await side.emit("session_start"); await f.service.start(ctx); assert.equal(nativeGets(), 0);
	trusted = true; await f.service.start(ctx); assert.equal(nativeGets(), 0, "enabled=false startup cannot retrieve an opted-in key");
	saveArchivePolicy(f.project, f.agentDir, "global", { enabled: true, capture: false, modelAccess: false });
	assert.equal(f.service.policy(ctx).enabled, false); await side.emit("agent_settled");
	assert.equal(nativeGets(), 0, "policy observation/side boot/re-enable are not startup unlock");
	await f.service.start(ctx); assert.equal(nativeGets(), 1); assert.equal(f.service.policy(ctx).enabled, true);
	assert.equal(page(f.service.search({ query: "REMEMBERED_VAULT_CANARY" }, ctx, false)).records.length, 1);
	assert.throws(() => f.service.search({ query: "REMEMBERED_VAULT_CANARY" }, ctx), /model access/);
	assert.equal(f.prompt.calls.length, 2, "remembered restore never prompts or falls back to password input");
	saveArchivePolicy(f.project, f.agentDir, "global", { enabled: false }); assert.equal(f.service.policy(ctx).enabled, false);
	assert.equal(f.keychain.entries.has(account), true, "policy OFF revokes locally without implicitly deleting remembered credentials");
	saveArchivePolicy(f.project, f.agentDir, "global", { enabled: true }); assert.equal(f.service.policy(ctx).enabled, false);
	assert.equal(nativeGets(), 1); await f.service.start(ctx); assert.equal(nativeGets(), 2);
	const revision = ready(f).revision;
	// Simulate an OS deletion failure using only our fake. Durable authorization
	// must be cleared even though a noncooperating/native copy could remain.
	f.keychain.onDelete = async () => { throw new Error(PRIVATE_ERROR); };
	const locked = await f.service.command("lock", ctx); assert.match(locked, /deletion failed.*may remain/); noLeak(f, locked);
	assert.notEqual(ready(f).revision, revision); assert.equal(ready(f).remember, undefined); assert.equal(ready(f).startup, "manual");
	assert.equal(f.keychain.entries.has(account), true);
	f.service.close("reload"); f.recreate(); await f.service.start(f.context("remember-after-lock"));
	assert.equal(nativeGets(), 2, "durable lock marker blocks restoration even if native deletion failed");
	assert.equal(f.service.policy(f.context("remember-after-lock")).enabled, false); noLeak(f);
});

test("late fake password prompts after lock or main-owner replacement cannot unlock, disclose secrets, or run a KDF grant", async t => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t); let ctx = f.context(); await f.service.start(ctx); await enable(f, ctx); await encrypt(f, ctx);
	await f.service.command("lock", ctx);
	for (const reason of ["lock", "owner"] as const) {
		const entered = deferred<AbortSignal>(), answer = deferred<string | undefined>();
		f.prompt.handler = async (_title, signal) => { entered.resolve(signal); return answer.promise; };
		const unlocking = f.service.command("unlock process", ctx), signal = await entered.promise;
		if (reason === "lock") await f.service.command("lock", ctx);
		else { ctx = f.context("replacement-main"); await f.service.start(ctx); }
		assert.equal(signal.aborted, true); answer.resolve(PASSWORD);
		const output = await unlocking; assert.match(output, /cancelled|owner changed|revoked/); noLeak(f, output);
		assert.equal(f.service.policy(ctx).enabled, false); assert.match(await f.service.command("encryption status", ctx), /locked/);
	}
	assert.equal(f.keychain.calls.length, 0);
	f.prompt.handler = async () => { throw new Error(PRIVATE_ERROR); };
	const output = await f.service.command("unlock", ctx); assert.match(output, /failed.*fail-closed/); noLeak(f, output);
	assert.equal(f.service.policy(ctx).enabled, false);
});

test("late fake-keychain set/get completions after lock or owner replacement cannot reauthorize a remembered grant", async t => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t); let ctx = f.context(); await f.service.start(ctx); await enable(f, ctx); await encrypt(f, ctx);
	const attemptedAccounts: string[] = [];
	for (const reason of ["lock", "owner"] as const) {
		if (reason === "owner") assert.match(await f.service.command("unlock", ctx), /unlocked/);
		const entered = deferred<void>(), finish = deferred<void>();
		f.keychain.onSet = async (account, key) => {
			const copy = Buffer.from(key); attemptedAccounts.push(account); entered.resolve();
			await finish.promise; f.keychain.entries.set(account, copy);
		};
		const remembering = f.service.command("startup remember", ctx); await entered.promise;
		if (reason === "lock") await f.service.command("lock", ctx);
		else { ctx = f.context("keychain-set-replacement"); await f.service.start(ctx); }
		finish.resolve(); const output = await remembering;
		assert.match(output, /cancelled|owner changed|revoked/); noLeak(f, output);
		assert.equal(f.keychain.entries.size, 0, "stale successful set must delete its uniquely generated account");
		assert.equal(ready(f).remember, undefined); assert.equal(f.service.policy(ctx).enabled, false);
		f.keychain.onSet = undefined;
	}
	assert.equal(new Set(attemptedAccounts).size, 2, "remember grants must not reuse a stale native account");
	for (const reason of ["lock", "owner"] as const) {
		assert.match(await f.service.command("unlock", ctx), /unlocked/);
		assert.match(await f.service.command("startup remember", ctx), /persistent-local/);
		const account = ready(f).remember!.account, copy = Buffer.from(f.keychain.entries.get(account)!);
		f.service.close("quit"); f.recreate(); ctx = f.context(`keychain-get-${reason}`);
		const entered = deferred<void>(), finish = deferred<Buffer | undefined>(); let gets = 0;
		f.keychain.onGet = async () => { if (++gets === 1) { entered.resolve(); return finish.promise; } return undefined; };
		const promptCount = f.prompt.calls.length;
		const startup = f.service.start(ctx); await entered.promise;
		if (reason === "lock") await f.service.command("lock", ctx);
		else { ctx = f.context("keychain-get-replacement"); await f.service.start(ctx); }
		finish.resolve(copy); await startup;
		assert.equal(f.service.policy(ctx).enabled, false, "late get must not unlock the new owner or a durably locked revision");
		assert.match(await f.service.command("encryption status", ctx), /locked/);
		assert.equal(f.prompt.calls.length, promptCount, "remembered startup does not fall back to another prompt");
		f.keychain.onGet = undefined;
		await f.service.command("lock", ctx); assert.equal(ready(f).remember, undefined); assert.equal(f.keychain.entries.size, 0);
	}
	noLeak(f);
});

test("observed main, side and supplemental trust loss revokes the shared lease, previews and pending grants", async t => {
	if (!nativeAvailable(t)) return;
	const f = fixture(t);
	let mainTrusted = true, sideTrusted = true, supplemental = true;
	const ctx = f.context("trust-main", f.project, () => mainTrusted);
	const sideCtx = f.context("trust-side", f.project, () => sideTrusted);
	await enable(f, ctx); await f.service.start(ctx); await encrypt(f, ctx);
	await f.service.command("model-access on --confirm-sensitive", ctx);
	const main = mount(f, "main", ctx);
	const side = mount(f, "jarvis", sideCtx, { isProjectTrusted: () => supplemental });
	await main.emit("session_start"); await side.emit("session_start");
	for (const context of [ctx, sideCtx]) {
		const original = context.sessionManager.getEntries.bind(context.sessionManager);
		t.mock.method(context.sessionManager, "getEntries", () => {
			assert.ok(context.isProjectTrusted() && (context !== sideCtx || supplemental), "untrusted observations cannot read a journal");
			return original();
		});
	}
	const history = join(f.root, "trust-import"); mkdirSync(history);
	writeFileSync(join(history, "fixture.jsonl"), JSON.stringify({ type: "session", version: 3, id: "trust-import", timestamp: "2026-01-01T00:00:00.000Z", cwd: f.project }) + "\n");
	for (const reason of ["main", "side", "supplemental"] as const) {
		const preview = JSON.parse(await f.service.command(`import-all ${history}`, ctx)).previewId;
		const oldMain = main.tools.get("jarvis_archive_search")!, oldSide = side.tools.get("jarvis_archive_search")!;
		const promptCount = f.prompt.calls.length;
		if (reason === "main") mainTrusted = false;
		else if (reason === "side") sideTrusted = false;
		else supplemental = false;
		await (reason === "main" ? main : side).emit("agent_settled");
		assert.ok(!main.activeTools().includes("jarvis_archive_search"));
		assert.ok(!side.activeTools().includes("jarvis_archive_search"));
		await assert.rejects(main.execute("jarvis_archive_search", { query: "fixture" }, oldMain), /expired|disabled|untrusted/);
		await assert.rejects(side.execute("jarvis_archive_search", { query: "fixture" }, oldSide), /expired|disabled|untrusted/);
		mainTrusted = sideTrusted = supplemental = true;
		await main.emit("agent_settled"); await side.emit("agent_settled");
		assert.equal(f.service.policy(ctx).enabled, false, "restoring trust is not an implicit unlock");
		assert.equal(f.prompt.calls.length, promptCount);
		assert.match(await f.service.command("unlock process", ctx), /unlocked/);
		await assert.rejects(f.service.command(`import-all --confirm-sensitive --preview ${preview}`, ctx), /matching prior preview|expired|cancelled/);
	}
	await f.service.command("lock", ctx);
	const entered = deferred<AbortSignal>(), answer = deferred<string | undefined>();
	f.prompt.handler = async (_title, signal) => { entered.resolve(signal); return answer.promise; };
	const pending = f.service.command("unlock process", ctx), signal = await entered.promise;
	supplemental = false; await side.emit("agent_settled");
	assert.equal(signal.aborted, true, "supplemental trust must cancel the shared async owner, not just hide side tools");
	supplemental = true; await side.emit("agent_settled");
	answer.resolve(PASSWORD);
	assert.match(await pending, /cancelled|revoked/);
	assert.equal(f.service.policy(ctx).enabled, false);
	assert.equal(f.keychain.calls.length, 0); noLeak(f);
});

// Receipt tests deliberately revoke/fault only AFTER Store.append has returned.
// Import counts may cross that boundary, but data/read results may not.
type ReceiptKind = "single" | "bulk";
interface ReceiptSource { path: string; before: Buffer; args: string; sessionId: string; unprocessedId?: string }
async function receiptSource(f: Fixture, ctx: ExtensionContext, kind: ReceiptKind): Promise<ReceiptSource> {
	const sources = (kind === "single" ? ["01-receipt"] : ["01-receipt", "02-unprocessed"]).map(sessionId => {
		const path = transcript(f, sessionId, "receiptfixture acknowledged");
		// Every candidate exercises final-record EOF, regardless of native directory order.
		writeFileSync(path, readFileSync(path).subarray(0, fs.statSync(path).size - 1));
		return { path, sessionId, before: readFileSync(path) };
	});
	if (kind === "single") return { ...sources[0]!, args: `import --confirm-sensitive ${sources[0]!.path}` };
	const p = JSON.parse(await f.service.command("import-all", ctx));
	assert.equal(p.candidates, 2);
	const first = sources.find(source => source.path === p.samples[0].path);
	assert.ok(first, "first reviewed candidate must be one of the synthetic sources");
	return { ...first, unprocessedId: sources.find(source => source !== first)!.sessionId,
		args: `import-all --confirm-sensitive --preview ${p.previewId}` };
}
async function stoppedReceipt(f: Fixture, ctx: ExtensionContext, kind: ReceiptKind, args: string, saved: number): Promise<string> {
	let output = "";
	if (kind === "single") {
		await assert.rejects(f.service.command(args, ctx), error => {
			assert.ok(error instanceof Error); output = error.message;
			assert.match(output, new RegExp(`Archive import stopped.*${saved} saved, 0 duplicates, 0 deleted`));
			assert.match(output, /Completed entries remain; source unchanged/); return true;
		});
	} else {
		output = await f.service.command(args, ctx); const result = JSON.parse(output);
		assert.equal(result.saved, saved); assert.equal(result.duplicates, 0); assert.equal(result.deleted, 0);
		assert.equal(result.stopped, true); assert.equal(result.failed, 1); assert.equal(result.unprocessed, 1); assert.equal(result.succeeded, 0);
	}
	noLeak(f, output); return output;
}
async function receiptRecords(f: Fixture, ctx: ExtensionContext, encrypted: boolean, source: ReceiptSource): Promise<void> {
	if (encrypted && !f.service.policy(ctx).enabled) assert.match(await f.service.command("unlock process", ctx), /unlocked/);
	assert.equal(page(f.service.search({ query: "receiptfixture", scope: "all" }, ctx, false)).records.length, 1);
	assert.equal(page(f.service.session({ sessionId: source.sessionId, scope: "all" }, ctx, false)).records.length, 2);
	if (source.unprocessedId) assert.equal(page(f.service.session({ sessionId: source.unprocessedId, scope: "all" }, ctx, false)).records.length, 0);
}
for (const encrypted of [false, true]) for (const kind of ["single", "bulk"] as const) {
	for (const revoke of ["trust", "signal", "capture", "cancel"] as const) {
		test(`${encrypted ? "encrypted" : "vault legacy"} ${kind} final-record ${revoke} after append acknowledgment counts and stops`, async t => {
			if (encrypted && !nativeAvailable(t)) return;
			const f = fixture(t); let trusted = true;
			const abort = new AbortController(), ctx = { ...f.context("main-owner", f.project, () => trusted), signal: abort.signal };
			await enable(f, ctx); if (encrypted) await encrypt(f, ctx);
			const source = await receiptSource(f, ctx, kind), append = ArchiveStore.prototype.append; let receipts = 0;
			t.mock.method(ArchiveStore.prototype, "append", function(this: ArchiveStore, input: ArchiveInput) {
				const outcome = append.call(this, input); receipts++;
				if (input.entry.id === "imported-entry") {
					assert.equal(outcome, "saved");
					if (revoke === "trust") trusted = false;
					else if (revoke === "signal") abort.abort();
					else if (revoke === "capture") saveArchivePolicy(f.project, f.agentDir, "global", { capture: false });
					else f.service.cancelImports();
				}
				return outcome;
			});
			await stoppedReceipt(f, ctx, kind, source.args, 2);
			assert.equal(receipts, 2, "only header and final entry acknowledged, no replay/remaining file");
			t.mock.restoreAll(); trusted = true;
			await receiptRecords(f, f.context(), encrypted, source); assert.deepEqual(readFileSync(source.path), source.before); noLeak(f);
		});
	}

	test(`${encrypted ? "encrypted" : "vault legacy"} ${kind} uncertain native COMMIT throw is not an append receipt`, async t => {
		if (encrypted && !nativeAvailable(t)) return;
		const f = fixture(t), ctx = f.context(); await enable(f, ctx); if (encrypted) await encrypt(f, ctx);
		const source = await receiptSource(f, ctx, kind), append = ArchiveStore.prototype.append;
		const Constructor = encrypted ? require("better-sqlite3-multiple-ciphers") : require("node:sqlite").DatabaseSync;
		const exec = Constructor.prototype.exec; let armed = false, commits = 0, receipts = 0, attempts = 0;
		t.mock.method(Constructor.prototype, "exec", function(this: ArchiveDatabase, sql: string) {
			exec.call(this, sql);
			if (armed && sql === "COMMIT") { commits++; armed = false; throw new Error(`SQLITE_IOERR ${PRIVATE_ERROR}`); }
		});
		t.mock.method(ArchiveStore.prototype, "append", function(this: ArchiveStore, input: ArchiveInput) {
			attempts++; if (input.entry.id === "imported-entry") armed = true;
			const outcome = append.call(this, input); receipts++; return outcome;
		});
		await stoppedReceipt(f, ctx, kind, source.args, 1);
		assert.equal(commits, 1); assert.equal(attempts, 2); assert.equal(receipts, 1, "only header returned an acknowledged outcome");
		t.mock.restoreAll(); await receiptRecords(f, ctx, encrypted, source);
		assert.deepEqual(readFileSync(source.path), source.before); noLeak(f);
	});
}

for (const kind of ["single", "bulk"] as const) {
	test(`encrypted ${kind} post-action filesystem guard failure keeps known append receipt but stops`, async t => {
		if (!nativeAvailable(t)) return;
		const f = fixture(t), ctx = f.context(); await enable(f, ctx); await encrypt(f, ctx);
		const source = await receiptSource(f, ctx, kind), databasePath = activePath(f), append = ArchiveStore.prototype.append, lstat = fs.lstatSync;
		let armed = false, faults = 0, receipts = 0;
		t.mock.method(ArchiveStore.prototype, "append", function(this: ArchiveStore, input: ArchiveInput) {
			const outcome = append.call(this, input); receipts++;
			if (input.entry.id === "imported-entry") armed = true; return outcome;
		});
		t.mock.method(fs, "lstatSync", ((path: fs.PathLike, ...args: any[]) => {
			if (armed && String(path) === databasePath) { faults++; throw new Error(PRIVATE_ERROR); }
			return Reflect.apply(lstat, fs, [path, ...args]);
		}) as typeof lstat); syncBuiltinESMExports();
		try { await stoppedReceipt(f, ctx, kind, source.args, 2); }
		finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
		assert.equal(receipts, 2); assert.ok(faults > 0); await receiptRecords(f, ctx, true, source);
		assert.deepEqual(readFileSync(source.path), source.before); noLeak(f);
	});

	for (const phase of ["unlink", "directory fsync"] as const) {
		test(`encrypted ${kind} post-write lock-release ${phase} failure keeps receipt, stops and poisons without replay`, async t => {
			if (!nativeAvailable(t)) return;
			const f = fixture(t), ctx = f.context(); await enable(f, ctx); await encrypt(f, ctx);
			const state = ready(f), source = await receiptSource(f, ctx, kind), databasePath = activePath(f);
			const lockPath = join(dirname(f.service.store.path), "archive.vault.lock");
			const append = ArchiveStore.prototype.append, unlink = fs.unlinkSync, sync = fs.fsyncSync;
			let armed = false, unlinked = false, faults = 0, releases = 0, receipts = 0;
			t.mock.method(ArchiveStore.prototype, "append", function(this: ArchiveStore, input: ArchiveInput) {
				const outcome = append.call(this, input); receipts++;
				if (input.entry.id === "imported-entry") armed = true; return outcome;
			});
			t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
				if (armed && String(path) === lockPath) {
					releases++;
					if (phase === "unlink") { faults++; throw new Error(PRIVATE_ERROR); }
					unlink(path); unlinked = true; return;
				}
				unlink(path);
			});
			t.mock.method(fs, "fsyncSync", (fd: number) => {
				if (unlinked && fs.fstatSync(fd).isDirectory()) { faults++; throw new Error(PRIVATE_ERROR); }
				sync(fd);
			}); syncBuiltinESMExports();
			try { await stoppedReceipt(f, ctx, kind, source.args, 2); }
			finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
			assert.equal(receipts, 2); assert.equal(faults, 1); assert.equal(releases, 1);
			assert.equal(f.service.policy(ctx).enabled, false);
			await assert.rejects(f.service.command("stats", ctx), /disabled|locked/);
			assert.match(await f.service.command("unlock process", ctx), /restart the Pi process/);
			assert.equal(f.keychain.calls.length, 0); assert.deepEqual(readFileSync(source.path), source.before);
			// Fixture-only independent database inspection, not a service fallback
			// under poison. Verify both receipts persisted despite failed release.
			f.service.close("quit"); const key = await unlockArchiveEnvelope(state.active.envelope, PASSWORD);
			let db: ArchiveDatabase | undefined;
			try {
				db = openEncryptedArchiveDatabase(databasePath, key);
				assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE session_id=?").get(source.sessionId)!.count, 2);
				assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE session_id=?").get(source.unprocessedId ?? "02-unprocessed")!.count, 0);
			} finally { try { db?.close(); } finally { key.fill(0); } }
			noLeak(f);
		});
	}
}

for (const encrypted of [false, true]) {
	test(`${encrypted ? "encrypted" : "vault legacy"} revoked post-action read result remains denied, not a receipt`, async t => {
		if (encrypted && !nativeAvailable(t)) return;
		const f = fixture(t); let trusted = true; const ctx = f.context("main-owner", f.project, () => trusted);
		await enable(f, ctx); if (encrypted) await encrypt(f, ctx);
		f.service.capture(entry("read-canary", user("READ_MUST_NOT_ESCAPE")), "main", ctx);
		const search = ArchiveStore.prototype.search; let completed = false;
		t.mock.method(ArchiveStore.prototype, "search", function(this: ArchiveStore, query: Parameters<typeof search>[0]) {
			const result = search.call(this, query); assert.equal(result.records.length, 1); completed = true; trusted = false; return result;
		});
		assert.throws(() => f.service.search({ query: "READ_MUST_NOT_ESCAPE" }, ctx, false), /revoked|unavailable/);
		assert.equal(completed, true); noLeak(f);
	});
}

for (const kind of ["single", "bulk"] as const) {
	test(`encrypted ${kind} outer failure after receipt cannot masquerade as a continuable entry rejection`, async t => {
		if (!nativeAvailable(t)) return;
		const f = fixture(t), ctx = f.context(); await enable(f, ctx); await encrypt(f, ctx);
		const source = await receiptSource(f, ctx, kind), append = ArchiveStore.prototype.append, withLock = ArchiveVaultFiles.prototype.withLock;
		let armed = false, faults = 0, receipts = 0;
		t.mock.method(ArchiveStore.prototype, "append", function(this: ArchiveStore, input: ArchiveInput) {
			const outcome = append.call(this, input); receipts++;
			if (input.entry.id === "imported-entry") armed = true; return outcome;
		});
		t.mock.method(ArchiveVaultFiles.prototype, "withLock", function<T>(this: ArchiveVaultFiles, run: Parameters<typeof withLock<T>>[0]): T {
			const result = withLock.call(this, run) as T;
			if (armed) { faults++; throw new Error("Invalid archive input"); }
			return result;
		});
		await stoppedReceipt(f, ctx, kind, source.args, 2);
		assert.equal(receipts, 2); assert.equal(faults, 1);
		t.mock.restoreAll(); assert.equal(f.service.policy(ctx).enabled, false);
		assert.deepEqual(readFileSync(source.path), source.before); noLeak(f);
	});
}

for (const access of ["policy", "stats", "status"] as const) for (const phase of ["existing lease", "pending unlock"] as const) {
	test(`direct ${access} throwing trust observation revokes ${phase}; restored getter cannot reuse or grant late`, async t => {
		if (!nativeAvailable(t)) return;
		const f = fixture(t); let throwing = false, observations = 0;
		const ctx = f.context("main-owner", f.project, () => {
			observations++;
			if (throwing) throw new Error(PRIVATE_ERROR);
			return true;
		});
		await enable(f, ctx); await encrypt(f, ctx); await f.service.command("unlock process", ctx);
		f.service.capture(entry("trust-direct", user("directtrustfixture preserved")), "main", ctx);
		let pending: Promise<string> | undefined, signal: AbortSignal | undefined;
		const answer = deferred<string | undefined>();
		if (phase === "pending unlock") {
			await f.service.command("lock", ctx);
			const entered = deferred<AbortSignal>();
			f.prompt.handler = async (_title, inputSignal) => { entered.resolve(inputSignal); return answer.promise; };
			pending = f.service.command("unlock process", ctx); signal = await entered.promise;
			assert.equal(signal.aborted, false);
		}
		throwing = true; const before = observations;
		if (access === "policy") assert.deepEqual(f.service.policy(ctx), { enabled: false, capture: false, modelAccess: false });
		else if (access === "stats") await assert.rejects(f.service.command("stats", ctx), error => {
			assert.ok(error instanceof Error); assert.match(error.message, /disabled|locked|untrusted/); noLeak(f, error.message); return true;
		});
		else {
			const output = await f.service.command("status", ctx);
			assert.match(output, /effective access paused.*untrusted project/); assert.match(output, /locked/); noLeak(f, output);
		}
		assert.equal(observations - before, 1, "policy and status share one safe trust observation, without a raw re-read");
		if (signal) assert.equal(signal.aborted, true, "denial revokes pending backend authorization immediately");
		// Restore BEFORE any other availability/policy observation: it must not
		// mask a failure to revoke at the throwing direct observation itself.
		throwing = false;
		if (pending) { answer.resolve(PASSWORD); assert.match(await pending, /cancelled|revoked/); }
		assert.equal(f.service.policy(ctx).enabled, false, "trust recovery is not an implicit unlock or reuse of the old key");
		await assert.rejects(f.service.command("stats", ctx), /disabled|locked/);
		assert.throws(() => f.service.search({ query: "directtrustfixture" }, ctx, false), /disabled|locked/);
		f.prompt.handler = async () => PASSWORD;
		assert.match(await f.service.command("unlock process", ctx), /unlocked/);
		assert.equal(page(f.service.search({ query: "directtrustfixture" }, ctx, false)).records.length, 1);
		assert.equal(f.keychain.calls.length, 0); noLeak(f);
	});
}
