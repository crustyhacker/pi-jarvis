import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
	type KeybindingsManager, type RegisteredCommand, type SessionBeforeForkEvent, type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent, type SessionShutdownEvent, type SessionStartEvent, type Theme, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, StdinBuffer, TuiMainScreen, type Component, type TUI, type Terminal } from "@earendil-works/pi-tui";
import jarvisExtension from "../index.js";
import { createArchiveExtensionFactory } from "../archive-extension.js";
import { NativeArchiveKeychain } from "../archive-keychain.js";
import { abandonArchiveSecretPrompt, ArchiveSecretInput, isArchiveSecretPromptActive, revokeArchiveSecretPrompt } from "../archive-secret-input.js";
import { SharedMemoryService } from "../memory-service.js";
import { JarvisModelPicker } from "../model-picker.js";
import { SharedArchiveService } from "../archive-service.js";
import { ArchiveStore } from "../archive-store.js";
import type { ArchivePage } from "../archive-types.js";
import { JarvisOverlayComponent, type JarvisDisplayEntry, type JarvisOverlayView } from "../overlay.js";
import { JarvisSideSessionRuntime } from "../side-session.js";

// Real index, vault, cipher and default masked prompt; no SDK/provider runtime,
// native credentials, user paths, persistent grants or remembered-startup commands.
const PASSWORD = "index vault synthetic password canary";
const ENCRYPT = "encryption on --confirm-sensitive --confirm-stopped";
const require = createRequire(import.meta.url);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const model: Model<"openai-completions"> = {
	id: "index-fixture", name: "Index fixture", provider: "fixture", api: "openai-completions",
	baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000,
};
function nativeAvailable(t: TestContext): boolean {
	try { require.resolve("better-sqlite3-multiple-ciphers"); }
	catch (error) {
		if ((error as { code?: unknown }).code !== "MODULE_NOT_FOUND" || process.env.CI) throw error;
		t.skip("optional encrypted SQLite package is not installed"); return false;
	}
	assert.equal(require("better-sqlite3-multiple-ciphers/package.json").version, "13.0.3");
	// Installed binding/profile failures fail rather than skipping/building.
	return true;
}
async function tick(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await tick(); }
	assert.fail("timed out waiting for index fixture state");
}
type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type DisposableComponent = Component & { dispose?(): void; focused?: boolean };
type RuntimeOptions = Parameters<typeof JarvisSideSessionRuntime.create>[0];
interface Dialog {
	component: DisposableComponent; overlay: boolean; closed: boolean; disposed: boolean; owner: string;
}
// Own extension component seam, as in index-regression: never Pi private APIs.
function viewOf(component: JarvisOverlayComponent): JarvisOverlayView {
	return (component as unknown as { view: JarvisOverlayView }).view;
}
function apiFixture(manager: SessionManager, forbidden: () => never) {
	const handlers = new Map<string, Handler[]>(), commands = new Map<string, Command>();
	const tools = new Map<string, ToolDefinition<any>>();
	let activeTools: string[] = [];
	const api = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? []; handlers.set(name, [...list, handler]);
			return () => { handlers.set(name, (handlers.get(name) ?? []).filter(item => item !== handler)); };
		},
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
		registerTool: (tool: ToolDefinition<any>) => { tools.set(tool.name, tool); },
		getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = [...names]; },
		getThinkingLevel: () => "off",
		appendEntry: (customType: string, data: unknown) => { manager.appendCustomEntry(customType, data); },
		sendMessage: forbidden, sendUserMessage: forbidden, exec: forbidden, registerProvider: forbidden,
	} as unknown as ExtensionAPI;
	return {
		api, commands, tools,
		async emit<E extends { type: string }>(event: E, ctx: ExtensionContext): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(event.type) ?? []) results.push(await handler(event, ctx));
			return results;
		},
	};
}

class FakeRuntime {
	readonly manager: SessionManager;
	readonly ctx: ExtensionContext;
	readonly lifetime = new AbortController();
	readonly transcript: JarvisDisplayEntry[] = [];
	readonly sent: string[] = [];
	readonly access: boolean[] = [];
	readonly lane: ReturnType<typeof apiFixture>;
	disposed = false;
	private finalSnapshot?: () => void;
	constructor(readonly options: RuntimeOptions, readonly fixture: Fixture) {
		assert.ok(options.sessionFile.startsWith(fixture.agentDir + "/"));
		this.manager = SessionManager.inMemory(options.cwd);
		this.ctx = fixture.context(this.manager, `side-${fixture.runtimes.length}`, "tui", true);
		this.lane = apiFixture(this.manager, fixture.forbidden);
		assert.ok(options.archive);
		createArchiveExtensionFactory(options.archive, "jarvis", {
			lifetimeSignal: this.lifetime.signal, isProjectTrusted: options.archiveTrustProvider,
			registerFinalSnapshot: snapshot => { this.finalSnapshot = snapshot; },
		})(this.lane.api);
	}
	async start(): Promise<void> { await this.lane.emit({ type: "session_start", reason: "startup" }, this.ctx); }
	isReady(): boolean { return !this.disposed; }
	isStreaming(): boolean { return false; }
	getModelLabel(): string { return "fixture/index-fixture"; }
	getRepoToolsDetailLabel(): string { return "fixture repo tools"; }
	getDisplayEntries(): JarvisDisplayEntry[] { return [...this.transcript]; }
	setToolAccessEnabled(enabled: boolean): void {
		this.access.push(enabled); this.fixture.order.push(`repo:${enabled}`);
	}
	addSystemMessage(text: string): void {
		this.transcript.push({ kind: "system", text }); this.manager.appendCustomEntry("fixture-status", { text });
	}
	async syncModel(): Promise<void> {}
	async sendMessage(text: string): Promise<void> { this.sent.push(text); this.fixture.forbidden(); }
	flushArchive(): void {
		assert.equal(this.disposed, false, "side final snapshot precedes lifetime revocation");
		this.fixture.order.push("side:final-snapshot"); this.finalSnapshot?.();
	}
	dispose(): void {
		if (this.disposed) return;
		this.flushArchive(); this.finalSnapshot = undefined; this.lifetime.abort(); this.disposed = true;
		this.fixture.order.push("side:dispose");
	}
}

class Fixture {
	readonly root = mkdtempSync(join(tmpdir(), "pi-jarvis-vault-index-"));
	readonly agentDir = join(this.root, "agent");
	readonly project = join(this.root, "workspace");
	readonly order: string[] = [];
	readonly notices: string[] = [];
	readonly rendered: string[] = [];
	readonly ordinaryInput = new Input(); // Explicit public ordinary-editor sink in our fake host.
	readonly dialogs: Dialog[] = [];
	readonly runtimes: FakeRuntime[] = [];
	readonly services = new Set<SharedArchiveService>();
	readonly starts: Array<{ service: SharedArchiveService; ctx: ExtensionContext }> = [];
	readonly closes: Array<{ service: SharedArchiveService; reason: string | undefined }> = [];
	readonly mounts: Mount[] = [];
	foregroundCalls = 0;
	keychainCalls = 0;
	networkCalls = 0;
	activeDialog?: Dialog;
	onSecret?: (dialog: Dialog) => void;
	constructor() {
		mkdirSync(join(this.agentDir, "extensions"), { recursive: true }); mkdirSync(this.project);
		writeFileSync(join(this.agentDir, "extensions", "pi-jarvis.json"), JSON.stringify({ memory: { enabled: false } }));
		writeFileSync(join(this.agentDir, "extensions", "pi-jarvis-archive.json"),
			JSON.stringify({ archive: { enabled: true, capture: true, modelAccess: false } }));
	}
	forbidden = (): never => { this.foregroundCalls++; assert.fail("vault index test must not queue, steer or start provider work"); };
	context(manager: SessionManager, owner: string, mode: ExtensionContext["mode"] = "tui", side = false): ExtensionCommandContext {
		const registry = {
			find: () => model, getAll: () => [model], getAvailable: () => [model], refresh: async () => {},
			getProviderAuth: this.forbidden, getProviderAuthStatus: this.forbidden,
			stream: this.forbidden, streamSimple: this.forbidden,
		} as unknown as ExtensionContext["modelRegistry"];
		const ui = {
			theme, notify: (text: string) => { this.notices.push(text); },
			input: this.forbidden, editor: this.forbidden, confirm: this.forbidden,
			setEditorText: this.forbidden, pasteToEditor: this.forbidden,
			custom: (<T>(factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
				options: Parameters<ExtensionContext["ui"]["custom"]>[1]): Promise<T> => {
				assert.equal(side, false, "side startup must never own a private prompt/UI");
				assert.equal(mode, "tui", "non-TUI must not use custom input");
				assert.equal(this.activeDialog, undefined, "no overlapping overlay/editor-area custom components");
				assert.equal(typeof options?.overlay, "boolean");
				const overlay = options!.overlay!;
				this.order.push(overlay ? "overlay:custom" : "secret:custom");
				return new Promise<T>((resolve, reject) => {
					let record: Dialog | undefined;
					const host = { mode: "regular", terminal: { rows: 40, columns: 110 }, requestRender: () => {
						if (record && !record.disposed && record.component instanceof ArchiveSecretInput) {
							this.rendered.push(record.component.render(110).join("\n"));
						}
					} } as TUI;
					const done = (value: unknown) => {
						assert.ok(record, "fixture completes only after factory installation");
						if (record.closed) return;
						record.closed = true; this.order.push(overlay ? "overlay:done" : "secret:done");
						// Explicit fake host lifecycle: fulfil custom, then dispose/unmount
						// in a microtask. The index callback must yield before opening input.
						resolve(value as T);
						queueMicrotask(() => {
							record!.component.dispose?.(); record!.disposed = true;
							if (this.activeDialog === record) this.activeDialog = undefined;
							this.order.push(overlay ? "overlay:dispose" : "secret:dispose");
						});
					};
					try {
						// Public TUI bindings implement the matches/getKeys subset used by
						// these components; no host config/private runtime is constructed.
						const bindings = getKeybindings() as unknown as KeybindingsManager;
						const component = factory(host, theme, bindings, done);
						assert.ok(!(component instanceof Promise), "these index factories are synchronous");
						record = { component, overlay, closed: false, disposed: false, owner };
						this.dialogs.push(record); this.activeDialog = record; record.component.focused = true;
						if (!overlay) { assert.ok(component instanceof ArchiveSecretInput); this.onSecret?.(record); }
					} catch (error) { reject(error); }
				});
			}) as ExtensionContext["ui"]["custom"],
		} as unknown as ExtensionContext["ui"];
		return {
			cwd: this.project, mode, hasUI: mode === "tui" || mode === "rpc", ui, sessionManager: manager,
			modelRegistry: registry, model, scopedModels: [], signal: undefined,
			isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
			getSystemPrompt: () => "Synthetic index fixture only.", getContextUsage: () => undefined,
			abort: this.forbidden, shutdown: this.forbidden, compact: this.forbidden,
			getSystemPromptOptions: () => ({}), waitForIdle: async () => {},
			newSession: this.forbidden, fork: this.forbidden, navigateTree: this.forbidden, switchSession: this.forbidden,
		} as unknown as ExtensionCommandContext;
	}
	mount(mode: ExtensionContext["mode"] = "tui"): Mount {
		const manager = SessionManager.inMemory(this.project), ctx = this.context(manager, `main-${this.mounts.length}`, mode);
		const lane = apiFixture(manager, this.forbidden);
		jarvisExtension(lane.api);
		const mount: Mount = {
			ctx, manager, lane,
			start: async (reason = "startup") => { await lane.emit({ type: "session_start", reason } satisfies SessionStartEvent, ctx); },
			shutdown: async (reason = "quit") => { await lane.emit({ type: "session_shutdown", reason } satisfies SessionShutdownEvent, ctx); },
			command: (name, args = "") => { const command = lane.commands.get(name); assert.ok(command); return command.handler(args, ctx); },
		};
		this.mounts.push(mount); return mount;
	}
	routeInput(data: string): void {
		if (this.activeDialog && !this.activeDialog.disposed) this.activeDialog.component.handleInput?.(data);
		else this.ordinaryInput.handleInput(data);
	}
	get secretDialogs(): Dialog[] { return this.dialogs.filter(dialog => !dialog.overlay); }
	get service(): SharedArchiveService { const service = this.starts.at(-1)?.service; assert.ok(service); return service; }
	assertNoLeaks(): void {
		const text = JSON.stringify({ notices: this.notices, rendered: this.rendered, order: this.order,
			main: this.mounts.map(mount => mount.manager.getEntries()),
			side: this.runtimes.map(runtime => ({ entries: runtime.manager.getEntries(), transcript: runtime.transcript })),
		});
		assert.ok(!text.includes(PASSWORD), "synthetic password must never appear in notifications, renders or either transcript");
		for (const tail of ["INDEX_DELAYED_PRIVATE_TAIL", "INDEX_LATER_PRIVATE_TAIL"]) assert.ok(!text.includes(tail));
		assert.equal(this.ordinaryInput.getValue(), "", "no password/tail input may reach the ordinary editor");
		assert.equal(isArchiveSecretPromptActive(), false, "normal completion/shutdown releases this fixture's UI gate");
		assert.equal(this.foregroundCalls, 0); assert.equal(this.keychainCalls, 0); assert.equal(this.networkCalls, 0);
		assert.ok(this.runtimes.every(runtime => runtime.sent.length === 0));
		assert.equal(existsSync(join(this.agentDir, "extensions", "pi-jarvis-memory", "memory.sqlite")), false);
	}
}
interface Mount {
	ctx: ExtensionCommandContext; manager: SessionManager; lane: ReturnType<typeof apiFixture>;
	start(reason?: SessionStartEvent["reason"]): Promise<void>;
	shutdown(reason?: SessionShutdownEvent["reason"]): Promise<void>;
	command(name: string, args?: string): Promise<void>;
}

async function isolated(t: TestContext, body: (f: Fixture) => Promise<void>): Promise<void> {
	const f = new Fixture(), previousDir = process.env.PI_CODING_AGENT_DIR;
	const originalStart = SharedArchiveService.prototype.start, originalCreate = JarvisSideSessionRuntime.create;
	const originalClose = SharedArchiveService.prototype.close;
	process.env.PI_CODING_AGENT_DIR = f.agentDir;
	SharedArchiveService.prototype.start = async function(ctx) {
		f.services.add(this); f.starts.push({ service: this, ctx: ctx as ExtensionContext });
		await originalStart.call(this, ctx);
	};
	SharedArchiveService.prototype.close = function(reason) {
		f.closes.push({ service: this, reason }); f.order.push(`root:close:${reason}`);
		return originalClose.call(this, reason);
	};
	JarvisSideSessionRuntime.create = (async (options: RuntimeOptions) => {
		const runtime = new FakeRuntime(options, f); f.runtimes.push(runtime); await runtime.start();
		return runtime as unknown as JarvisSideSessionRuntime;
	}) as typeof JarvisSideSessionRuntime.create;
	for (const method of ["get", "set", "delete"] as const) t.mock.method(NativeArchiveKeychain.prototype, method, async () => {
		f.keychainCalls++; assert.fail("no real OS keychain operation is permitted");
	});
	t.mock.method(globalThis, "fetch", async () => { f.networkCalls++; assert.fail("no provider/network calls are permitted"); });
	try { await body(f); f.assertNoLeaks(); }
	finally {
		try {
			// Owner-only test host teardown, never ordinary operation cancellation.
			abandonArchiveSecretPrompt(); f.activeDialog?.component.dispose?.(); await tick();
			for (const runtime of f.runtimes) runtime.dispose();
			for (const service of f.services) originalClose.call(service, "quit");
		} finally {
			SharedArchiveService.prototype.start = originalStart; SharedArchiveService.prototype.close = originalClose;
			JarvisSideSessionRuntime.create = originalCreate; t.mock.restoreAll();
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
			rmSync(f.root, { recursive: true, force: true });
		}
	}
}
function displayedCode(component: ArchiveSecretInput): string {
	const rendered = component.render(110).join("\n");
	const match = /\b([A-HJ-NP-Z2-9]{4}) ([A-HJ-NP-Z2-9]{4}) ([A-HJ-NP-Z2-9]{4})\b/.exec(rendered);
	assert.ok(match, "human verification uses the fresh public rendered 4-4-4 code, never private nonce state");
	return match.slice(1).join("");
}
async function verifyDisplayedCode(f: Fixture, dialog: Dialog): Promise<void> {
	assert.equal(dialog.closed, false, "Enter/Escape alone cannot release private input ownership");
	const component = dialog.component as ArchiveSecretInput, code = displayedCode(component);
	for (const char of code) f.routeInput(char);
	f.routeInput("\r"); await until(() => dialog.disposed);
}
async function answer(f: Fixture, count: number): Promise<void> {
	for (let index = 0; index < count; index++) {
		await until(() => f.activeDialog?.component instanceof ArchiveSecretInput);
		const dialog = f.activeDialog!;
		assert.equal(dialog.overlay, false);
		const component = dialog.component as ArchiveSecretInput;
		for (const char of PASSWORD) component.handleInput(char); // Keyboard, not paste/CLI/history.
		const mask = component.render(110).join("\n");
		assert.ok(mask.includes("*")); assert.ok(!mask.includes(PASSWORD)); f.rendered.push(mask);
		component.handleInput("\r"); await verifyDisplayedCode(f, dialog);
		assert.deepEqual(component.render(110), [], "completed component releases secret editor state");
	}
}
async function encrypt(f: Fixture, mount: Mount): Promise<void> {
	const command = mount.command("jarvis-archive", ENCRYPT); await answer(f, 2); await command;
	assert.match(f.notices.at(-1)!, /encryption enabled; unlocked/);
}
async function open(f: Fixture, mount: Mount): Promise<{ opened: Promise<void>; component: JarvisOverlayComponent; runtime: FakeRuntime }> {
	const before = f.runtimes.length, opened = mount.command("jarvis");
	await until(() => f.runtimes.length > before && f.activeDialog?.component instanceof JarvisOverlayComponent);
	return { opened, component: f.activeDialog!.component as JarvisOverlayComponent, runtime: f.runtimes.at(-1)! };
}
function page(f: Fixture, query: string, ctx: ExtensionContext): ArchivePage {
	const text = f.service.search({ query, scope: "all" }, ctx, false);
	return JSON.parse(text.slice(text.indexOf("\n") + 1));
}
const bounded = { concurrency: false, timeout: 30_000 };

test("actual index exposes encryption controls but archive OFF never boots, reads records or falls back to ordinary input", bounded, async t => {
	await isolated(t, async f => {
		// Archive OFF: available controls must not activate recording/native work.
		writeFileSync(join(f.agentDir, "extensions", "pi-jarvis-archive.json"),
			JSON.stringify({ archive: { enabled: false, capture: false, modelAccess: false } }));
		for (const method of ["append", "search", "read", "session", "stats", "migrationDatabase"] as const) {
			t.mock.method(ArchiveStore.prototype, method, () => assert.fail("OFF archive must not access records"));
		}
		const h = f.mount(); await h.start();
		await h.command("jarvis-archive", "encryption status");
		assert.match(f.notices.at(-1)!, /encryption off \(legacy plaintext\)/);
		await h.command("jarvis-archive", ENCRYPT);
		await h.command("jarvis", "/archive unlock process");
		assert.equal(f.notices.filter(text => text.includes("enabled in a trusted project")).length, 2);
		assert.equal(f.dialogs.length, 0); assert.equal(f.runtimes.length, 0);
		assert.equal(existsSync(f.service.store.path), false);
		await h.shutdown(); assert.equal(f.closes.at(-1)?.reason, "quit");
	});
});


test("ordinary index close preserves all three grants and reusable side owner, unlike private password preparation", bounded, async t => {
	await isolated(t, async f => {
		const h = f.mount(); await h.start();
		const { opened, component, runtime } = await open(f, h), view = viewOf(component);
		view.toggleToolAccess(); view.toggleFollowUpToMain(); view.toggleSteerToMain();
		component.handleInput("\x1b"); await opened; await until(() => f.activeDialog === undefined);
		assert.equal(runtime.disposed, false); assert.equal(runtime.access.at(-1), true);
		assert.equal(view.isToolAccessEnabled(), true); assert.equal(view.isFollowUpToMainEnabled(), true); assert.equal(view.isSteerToMainEnabled(), true);
		assert.equal(await runtime.options.confirmSteerToMain("background must not ask invisibly"), false);
		const reopening = h.command("jarvis"); await until(() => f.activeDialog?.component instanceof JarvisOverlayComponent);
		const reopenedView = viewOf(f.activeDialog!.component as JarvisOverlayComponent);
		assert.equal(f.runtimes.length, 1, "reopen does not create another side runtime");
		assert.equal(reopenedView.isToolAccessEnabled(), true); assert.equal(reopenedView.isFollowUpToMainEnabled(), true); assert.equal(reopenedView.isSteerToMainEnabled(), true);
		await h.shutdown(); await reopening;
		assert.equal(reopenedView.isToolAccessEnabled(), false); assert.equal(reopenedView.isFollowUpToMainEnabled(), false); assert.equal(reopenedView.isSteerToMainEnabled(), false);
	});
});

test("index local encryption closes/disposes Jarvis and revokes transient Repo tools before both real masked editor prompts", bounded, async t => {
	if (!nativeAvailable(t)) return;
	await isolated(t, async f => {
		const h = f.mount(); await h.start();
		const { opened, component, runtime } = await open(f, h), overlay = f.activeDialog!;
		const view = viewOf(component);
		component.handleInput("\t"); component.handleInput(" "); // Public overlay control keys: Repo tools ON.
		view.toggleFollowUpToMain(); view.toggleSteerToMain();
		assert.equal(view.isToolAccessEnabled(), true); assert.equal(runtime.access.at(-1), true);
		const bootCount = f.runtimes.length;
		f.onSecret = () => {
			assert.equal(overlay.closed, true); assert.equal(overlay.disposed, true);
			assert.equal(view.isToolAccessEnabled(), false); assert.equal(runtime.access.at(-1), false);
			assert.equal(view.isFollowUpToMainEnabled(), false); assert.equal(view.isSteerToMainEnabled(), false);
			const enabled = f.order.indexOf("repo:true"), revoked = f.order.indexOf("repo:false", enabled + 1);
			assert.ok(revoked < f.order.indexOf("overlay:done"), "private preparation explicitly revokes access BEFORE ordinary close/yield");
			assert.ok(f.order.indexOf("overlay:done") < f.order.indexOf("overlay:dispose"));
			assert.ok(f.order.indexOf("overlay:dispose") < f.order.indexOf("secret:custom"));
		};
		// Actual /jarvis local-command interception while open, not a provider turn.
		const command = h.command("jarvis", `/archive ${ENCRYPT}`);
		await answer(f, 2); await command; await opened;
		assert.equal(f.secretDialogs.length, 2); assert.equal(f.runtimes.length, bootCount);
		const enabled = f.order.indexOf("repo:true"), revoked = f.order.indexOf("repo:false", enabled + 1);
		assert.ok(enabled < revoked && revoked < f.order.indexOf("secret:custom"));
		assert.ok(f.rendered.some(text => text.includes("New archive password")));
		assert.ok(f.rendered.some(text => text.includes("Repeat new archive password")));
		assert.ok(view.getQueuedMessageCount); assert.ok(view.getIsProcessing);
		assert.equal(view.getQueuedMessageCount(), 0); assert.equal(view.getIsProcessing(), false);
		assert.match(runtime.transcript.at(-1)!.text, /encryption enabled; unlocked/);
		assert.equal(f.service.policy(h.ctx).enabled, true);
		assert.equal(runtime.disposed, false, "private preparation revokes tools, but keeps the reusable side session");
		await h.shutdown(); assert.equal(runtime.disposed, true);
	});
});

test("side /new preserves the main-owned session lease and finalizes the retiring side before invalidating its boot guard", bounded, async t => {
	if (!nativeAvailable(t)) return;
	await isolated(t, async f => {
		const h = f.mount(); await h.start(); await encrypt(f, h);
		const first = await open(f, h);
		first.runtime.manager.appendMessage({ role: "user", content: "INDEX_SIDE_NEW_FINAL_CANARY", timestamp: 100 });
		await viewOf(first.component).sendMessage("/new");
		assert.equal(first.runtime.disposed, true); assert.equal(f.runtimes.length, 2);
		assert.equal(f.service.policy(h.ctx).enabled, true, "side boot ownership is not main trust/session revocation");
		assert.equal(page(f, "INDEX_SIDE_NEW_FINAL_CANARY", h.ctx).records.length, 1);
		assert.equal(f.secretDialogs.length, 2, "side /new never asks for another main-owned session unlock");
		await h.shutdown("quit"); await first.opened;
	});
});

test("index reason=new factory recreation loses session unlock, retains process handoff, and snapshots side before root shutdown", bounded, async t => {
	if (!nativeAvailable(t)) return;
	await isolated(t, async f => {
		const capture = SharedArchiveService.prototype.capture;
		t.mock.method(SharedArchiveService.prototype, "capture", function(this: SharedArchiveService, entry: unknown, lane: "main" | "jarvis", ctx: ExtensionContext) {
			f.order.push(`capture:${lane}:${(entry as { id: string }).id}`); return capture.call(this, entry, lane, ctx);
		});
		let h = f.mount(); await h.start(); await encrypt(f, h);
		const sessionOwner = f.service, first = await open(f, h);
		const sideId = first.runtime.manager.appendMessage({ role: "user", content: "INDEX_SIDE_FINAL_CANARY", timestamp: 100 });
		const mainId = h.manager.appendMessage({ role: "user", content: "INDEX_ROOT_FINAL_CANARY", timestamp: 100 });
		await h.shutdown("new"); await first.opened;
		assert.equal(first.runtime.disposed, true);
		assert.equal(f.closes.at(-1)?.service, sessionOwner); assert.equal(f.closes.at(-1)?.reason, "new");
		assert.ok(f.order.indexOf(`capture:jarvis:${sideId}`) >= 0);
		assert.ok(f.order.indexOf(`capture:jarvis:${sideId}`) < f.order.indexOf(`capture:main:${mainId}`));
		assert.ok(f.order.indexOf(`capture:main:${mainId}`) < f.order.indexOf("root:close:new"));
		h = f.mount(); await h.start("new");
		assert.notEqual(f.service, sessionOwner); assert.equal(f.service.policy(h.ctx).enabled, false);
		assert.equal(f.secretDialogs.length, 2, "manual startup never prompts when the session grant expires");
		assert.throws(() => sessionOwner.search({ query: "INDEX_SIDE_FINAL_CANARY" }, h.ctx, false), /disabled|revoked|locked/);
		const unlock = h.command("jarvis-archive", "unlock process"); await answer(f, 1); await unlock;
		assert.match(f.notices.at(-1)!, /unlocked \(process\)/);
		assert.equal(page(f, "INDEX_SIDE_FINAL_CANARY", h.ctx).records.length, 1);
		assert.equal(page(f, "INDEX_ROOT_FINAL_CANARY", h.ctx).records.length, 1);
		const processOwner = f.service, second = await open(f, h), promptCount = f.secretDialogs.length;
		second.runtime.manager.appendMessage({ role: "user", content: "INDEX_PROCESS_FINAL_CANARY", timestamp: 200 });
		await h.shutdown("new"); await second.opened;
		assert.equal(f.closes.at(-1)?.service, processOwner); assert.equal(f.closes.at(-1)?.reason, "new");
		h = f.mount(); await h.start("new");
		assert.notEqual(f.service, processOwner); assert.equal(f.service.policy(h.ctx).enabled, true);
		assert.equal(f.secretDialogs.length, promptCount, "new factory adopts process lease without password/credentials");
		assert.equal(page(f, "INDEX_PROCESS_FINAL_CANARY", h.ctx).records.length, 1);
		assert.ok(f.starts.every(start => f.mounts.some(mount => mount.ctx === start.ctx)), "side mounts must never call archive.start");
		await h.shutdown("quit");
	});
});

test("index startup manual reads no records or journal; prompt startup is root-only, closes open Jarvis, and has no RPC/input fallback", bounded, async t => {
	if (!nativeAvailable(t)) return;
	await isolated(t, async f => {
		let h = f.mount(); await h.start(); await encrypt(f, h); await h.shutdown("new");
		h = f.mount();
		let journalReads = 0, dataReads = 0;
		const getEntries = h.manager.getEntries.bind(h.manager), migrationDatabase = ArchiveStore.prototype.migrationDatabase;
		t.mock.method(h.manager, "getEntries", () => { journalReads++; return getEntries(); });
		t.mock.method(ArchiveStore.prototype, "migrationDatabase", function(this: ArchiveStore, ...args: Parameters<typeof migrationDatabase>) {
			dataReads++; return migrationDatabase.apply(this, args);
		});
		const promptCount = f.secretDialogs.length;
		await h.start("new");
		assert.equal(f.secretDialogs.length, promptCount); assert.equal(journalReads, 0); assert.equal(dataReads, 0);
		assert.equal(f.service.policy(h.ctx).enabled, false);
		const { opened, runtime } = await open(f, h), overlay = f.activeDialog!;
		assert.equal(f.secretDialogs.length, promptCount, "side extension startup does not prompt");
		assert.equal(dataReads, 0); assert.equal(journalReads, 0);
		await h.command("jarvis-archive", "startup prompt");
		assert.equal(f.secretDialogs.length, promptCount, "choosing startup prompt is not an unlock");
		f.onSecret = dialog => {
			assert.equal(dialog.owner, "main-1"); assert.equal(overlay.disposed, true); assert.equal(runtime.disposed, true);
			assert.equal(runtime.lifetime.signal.aborted, true);
		};
		const starting = h.start("reload"); await answer(f, 1); await starting; await opened;
		assert.equal(f.secretDialogs.length, promptCount + 1); assert.equal(f.service.policy(h.ctx).enabled, true);
		assert.ok(dataReads > 0, "successful startup authenticates the real encrypted database");
		assert.ok(journalReads > 0, "only successful unlock establishes the fresh journal baseline");
		assert.equal(f.runtimes.length, 1, "startup unlock closes the side runtime without booting another");
		assert.ok(f.starts.every(start => f.mounts.some(mount => mount.ctx === start.ctx)));
		await h.shutdown("new");
		f.onSecret = undefined;
		const rpc = f.mount("rpc"), dialogs = f.dialogs.length;
		await rpc.start("new"); await rpc.command("jarvis-archive", "unlock process");
		assert.equal(f.dialogs.length, dialogs); assert.equal(f.service.policy(rpc.ctx).enabled, false);
		assert.ok(f.notices.some(text => /cancelled|unavailable/.test(text) && /fallback/i.test(text)));
		await rpc.shutdown("quit");
	});
});

test("index cancels main switch/fork/tree during password entry and the revoked sink, until a fresh human exit code releases ownership", bounded, async t => {
	if (!nativeAvailable(t)) return;
	await isolated(t, async f => {
		const h = f.mount(); await h.start(); await encrypt(f, h); await h.command("jarvis-archive", "lock");
		const leafId = h.manager.appendMessage({ role: "user", content: "INDEX_NAVIGATION_FIXTURE", timestamp: 300 });
		const boundaries: Array<SessionBeforeSwitchEvent | SessionBeforeForkEvent | SessionBeforeTreeEvent> = [
			{ type: "session_before_switch", reason: "new" },
			{ type: "session_before_fork", entryId: leafId, position: "at" },
			{ type: "session_before_tree", signal: new AbortController().signal, preparation: {
				targetId: leafId, oldLeafId: leafId, commonAncestorId: leafId, entriesToSummarize: [], userWantsSummary: false,
			} },
		];
		const cancelled = (results: unknown[]) => results.some(result => result && typeof result === "object" &&
			(result as { cancel?: unknown }).cancel === true);
		for (const boundary of boundaries) {
			const manager = h.ctx.sessionManager, sessionId = manager.getSessionId();
			const unlocking = h.command("jarvis-archive", "unlock process");
			await until(() => f.activeDialog?.component instanceof ArchiveSecretInput);
			const dialog = f.activeDialog!, component = dialog.component as ArchiveSecretInput;
			for (const char of PASSWORD) f.routeInput(char);
			f.routeInput("\r"); const staleSubmitCode = displayedCode(component);
			assert.equal(isArchiveSecretPromptActive(), true);
			assert.equal(cancelled(await h.lane.emit(boundary, h.ctx)), true, `${boundary.type} must be cancellable while entering a password`);
			await unlocking; // Revoked result settles BEFORE UI/sink ownership releases.
			assert.equal(dialog.closed, false); assert.equal(dialog.disposed, false);
			assert.equal(f.activeDialog, dialog); assert.equal(isArchiveSecretPromptActive(), true);
			assert.equal(f.service.policy(h.ctx).enabled, false, "navigation revocation cannot grant an unlock");
			assert.notEqual(displayedCode(component), staleSubmitCode, "abort invalidates the old submit nonce");
			const promptCount = f.secretDialogs.length;
			for (const repeated of boundaries) {
				assert.equal(cancelled(await h.lane.emit(repeated, h.ctx)), true, `${repeated.type} stays blocked while the cancellation sink owns input`);
				assert.equal(f.activeDialog, dialog); assert.equal(dialog.closed, false);
			}
			await h.command("jarvis-archive", "unlock session");
			assert.equal(f.secretDialogs.length, promptCount, "cancelled sink retains the cross-lane prompt busy gate");
			assert.equal(f.activeDialog, dialog); assert.equal(dialog.closed, false);
			// Delayed hostile tails stay hidden in the cancellation sink. Neither
			// an old submit code, a pasted new code, nor Enter/Escape/Ctrl+C exits it.
			for (const char of staleSubmitCode) f.routeInput(char);
			f.routeInput("\r"); assert.equal(dialog.closed, false);
			const postAbortCode = displayedCode(component);
			f.routeInput(`\x1b[200~${postAbortCode}\x1b[201~`); f.routeInput("\r");
			assert.equal(dialog.closed, false);
			for (const tail of ["INDEX_DELAYED_PRIVATE_TAIL", "\r", "\x1b", "\x03", "\x1b[201~", "INDEX_LATER_PRIVATE_TAIL"]) {
				f.routeInput(tail); await tick();
				assert.equal(dialog.closed, false); assert.equal(f.ordinaryInput.getValue(), "");
				assert.ok(!component.render(110).join("\n").includes("PRIVATE_TAIL"));
			}
			f.routeInput("\x1b"); await verifyDisplayedCode(f, dialog);
			await until(() => !isArchiveSecretPromptActive());
			assert.equal(f.ordinaryInput.getValue(), ""); assert.equal(f.service.policy(h.ctx).enabled, false);
			assert.equal(h.ctx.sessionManager, manager); assert.equal(manager.getSessionId(), sessionId);
			for (const allowed of boundaries) {
				assert.equal(cancelled(await h.lane.emit(allowed, h.ctx)), false, "verified exit restores ordinary cancellable navigation");
			}
		}
		const unlock = h.command("jarvis-archive", "unlock session"); await answer(f, 1); await unlock;
		assert.equal(f.service.policy(h.ctx).enabled, true, "fresh explicit input can unlock after the old sink is released");
		assert.equal(f.runtimes.length, 0); await h.shutdown("quit");
	});
});

test("own main memory reviews, Jarvis and model pickers cannot steal private password or cancellation-sink focus", bounded, async t => {
	await isolated(t, async f => {
		writeFileSync(join(f.agentDir, "extensions", "pi-jarvis.json"), JSON.stringify({ memory: { enabled: true, capture: true, recall: true } }));
		// This is an input-ownership test, not memory storage coverage. No memory
		// database needs to open to supply a synthetic review to the real tool.
		t.mock.method(SharedMemoryService.prototype, "get", (): ReturnType<SharedMemoryService["get"]> => ({
			id: "review-fixture", kind: "note", category: "reference", scope: "project", project: f.project,
			title: "Synthetic review", text: "Disposable review fixture only.", createdAt: 1, updatedAt: 1,
			source: { lane: "manual", sessionId: "fixture", eventId: "fixture" },
		}));
		t.mock.method(SharedMemoryService.prototype, "forget", () => assert.fail("private input cannot authorize a memory deletion"));
		const h = f.mount(); await h.start();
		const encryption = h.command("jarvis-archive", ENCRYPT);
		await until(() => f.activeDialog?.component instanceof ArchiveSecretInput);
		const dialog = f.activeDialog!, count = f.dialogs.length;
		for (const phase of ["password", "cancel-sink"] as const) {
			if (phase === "cancel-sink") { revokeArchiveSecretPrompt(); await encryption; }
			const forget = h.lane.tools.get("jarvis_memory_forget")!;
			const result = await forget.execute("review", { id: "review-fixture" }, undefined, undefined, h.ctx as any);
			assert.match(JSON.stringify(result.content), /not forgotten/);
			await h.command("jarvis"); await h.command("jarvis-model");
			assert.equal(f.dialogs.length, count); assert.equal(f.activeDialog, dialog);
			assert.equal(dialog.closed, false); assert.equal(isArchiveSecretPromptActive(), true);
			assert.equal(f.runtimes.length, 0); assert.equal(f.foregroundCalls, 0);
		}
		await verifyDisplayedCode(f, dialog); await until(() => !isArchiveSecretPromptActive());
		await h.shutdown("quit");
	});
});

function syntheticReview(t: TestContext, f: Fixture): void {
	writeFileSync(join(f.agentDir, "extensions", "pi-jarvis.json"), JSON.stringify({ memory: { enabled: true, capture: true, recall: true } }));
	t.mock.method(SharedMemoryService.prototype, "get", (): ReturnType<SharedMemoryService["get"]> => ({
		id: "review-fixture", kind: "note", category: "reference", scope: "project", project: f.project,
		title: "Synthetic review", text: "Disposable fixture only.", createdAt: 1, updatedAt: 1,
		source: { lane: "manual", sessionId: "fixture", eventId: "fixture" },
	}));
	t.mock.method(SharedMemoryService.prototype, "forget", () => assert.fail("no synthetic review may delete memory"));
}

// Public renderer/transport and public custom/confirm callbacks matching Pi's
// showExtensionCustom/showExtensionSelector lifecycle. No private host calls.
function publicIndexHost(f: Fixture, h: Mount, options: { deferSecretFactory?: boolean; onOverlayClose?: () => void } = {}) {
	let onInput!: (data: string) => void;
	const writes: string[] = [];
	const terminal: Terminal = {
		columns: 160, rows: 24, kittyProtocolActive: false,
		start(input) { onInput = input; }, stop() {}, write(data) { writes.push(data); },
		async drainInput() {}, setTitle() {}, setProgress() {},
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
	};
	const host = new TuiMainScreen(terminal), editor = f.ordinaryInput, buffer = new StdinBuffer();
	host.addChild(editor); host.setFocus(editor); host.start();
	buffer.on("data", data => onInput(data)); buffer.on("paste", text => onInput(`\x1b[200~${text}\x1b[201~`));
	let confirms = 0, reviewRestores = 0;
	const privateStarts: Array<() => void> = [];
	const restore = () => { host.clear(); host.addChild(editor); host.setFocus(editor); host.requestRender(); };
	h.ctx.ui.confirm = (_title, _message, opts) => new Promise<boolean>(resolve => {
		confirms++;
		const selector = new Input(); host.clear(); host.addChild(selector); host.setFocus(selector);
		// Stock ordinary review AbortSignal cleanup unconditionally restores the
		// editor. Admission must prevent this callback from existing under a sink.
		const onAbort = () => { reviewRestores++; restore(); resolve(false); };
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
	});
	h.ctx.ui.custom = (<T>(factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
		opts: Parameters<ExtensionContext["ui"]["custom"]>[1]): Promise<T> => new Promise((resolve, reject) => {
		let record: Dialog | undefined, overlayHandle: ReturnType<TUI["showOverlay"]> | undefined, closed = false;
		const overlay = opts?.overlay ?? false;
		f.order.push(overlay ? "overlay:custom" : "ordinary-or-secret:custom");
		const done = (value: unknown) => {
			if (closed) return; closed = true;
			if (record) record.closed = true;
			if (overlay) overlayHandle?.hide(); else restore();
			resolve(value as T); record?.component.dispose?.();
			if (record) record.disposed = true;
			if (f.activeDialog === record) f.activeDialog = undefined;
			if (overlay) queueMicrotask(() => options.onOverlayClose?.());
		};
		const start = () => {
			try {
				Promise.resolve(factory(host, theme, getKeybindings() as unknown as KeybindingsManager, done)).then(component => {
					record = { component, overlay, owner: "main-public-fixture", closed, disposed: closed };
					f.dialogs.push(record);
					if (closed) return;
					f.activeDialog = record;
					if (overlay) overlayHandle = host.showOverlay(component);
					else { host.clear(); host.addChild(component); host.setFocus(component); }
				}, reject);
			} catch (error) { reject(error); }
		};
		if (options.deferSecretFactory && opts?.overlay === false) privateStarts.push(start);
		else start();
	})) as ExtensionContext["ui"]["custom"];
	return {
		host, editor, buffer, writes, privateStarts,
		confirms: () => confirms, reviewRestores: () => reviewRestores,
		verify(component: ArchiveSecretInput) {
			buffer.process("\x1b[99;5u"); // Fresh cancel intent without a timeout/split ESC fixture assumption.
			buffer.process(displayedCode(component)); buffer.process("\r");
		},
		stop() { buffer.destroy(); buffer.removeAllListeners(); host.stop(); },
	};
}

test("actual index reserves before overlay-close yield: raced memory/Jarvis/picker admission cannot install late reviewAbort beneath a sink", bounded, async t => {
	await isolated(t, async f => {
		syntheticReview(t, f);
		const h = f.mount(); await h.start();
		const reviewAbort = new AbortController();
		let raced: Promise<unknown[]> | undefined, reviewWork: Promise<unknown> | undefined;
		const publicHost = publicIndexHost(f, h, { deferSecretFactory: true, onOverlayClose: () => {
			assert.equal(isArchiveSecretPromptActive(), true, "reservation covers the actual beforeSecretPrompt yield");
			assert.equal(f.dialogs.filter(dialog => dialog.component instanceof ArchiveSecretInput).length, 0,
				"race runs before any private factory");
			reviewWork = h.lane.tools.get("jarvis_memory_forget")!.execute("review", { id: "review-fixture" }, reviewAbort.signal, undefined, h.ctx as any);
			raced = Promise.all([reviewWork, h.command("jarvis"), h.command("jarvis-model")]);
		} });
		try {
			const { opened } = await open(f, h), overlay = f.activeDialog!, bootCount = f.runtimes.length;
			const encryption = h.command("jarvis-archive", ENCRYPT);
			await until(() => raced !== undefined && publicHost.privateStarts.length === 1);
			const results = await raced!;
			assert.match(JSON.stringify(results[0]), /not forgotten/);
			assert.equal(publicHost.confirms(), 0); assert.equal(publicHost.reviewRestores(), 0);
			assert.equal(overlay.disposed, true, "actual overlay close/yield still completes before secret mount");
			assert.equal(f.runtimes.length, bootCount); assert.equal(f.dialogs.length, 1);
			assert.equal(isArchiveSecretPromptActive(), true, "backend/UI preparation/deferred factory share one owner");
			publicHost.privateStarts.shift()!();
			await until(() => f.activeDialog?.component instanceof ArchiveSecretInput);
			const secret = f.activeDialog!, component = secret.component as ArchiveSecretInput;
			publicHost.buffer.process("\x1b[200~fixture-prefix\x1b[201~\r");
			revokeArchiveSecretPrompt(); await encryption;
			assert.equal(secret.closed, false); assert.equal(isArchiveSecretPromptActive(), true);
			publicHost.buffer.process("\x1b[200~SYNTHETIC_PUBLIC_RACED_"); // Entire host paste pending, unseen by component.
			reviewAbort.abort(); await reviewWork;
			assert.equal(publicHost.reviewRestores(), 0, "denied review installed no late ordinary restoration callback");
			assert.equal(publicHost.host.getFocusedComponent(), component);
			assert.equal(secret.closed, false); assert.equal(secret.disposed, false);
			publicHost.buffer.process("TAIL\x1b[201~");
			assert.equal(publicHost.editor.getValue(), "");
			assert.ok(!component.render(160).join("").includes("SYNTHETIC_PUBLIC_RACED_TAIL"));
			publicHost.host.renderNow(); assert.ok(!publicHost.writes.join("").includes("SYNTHETIC_PUBLIC_RACED_TAIL"));
			publicHost.verify(component); await until(() => !isArchiveSecretPromptActive());
			assert.equal(secret.disposed, true); assert.equal(publicHost.editor.getValue(), "");
			await h.shutdown("quit"); await opened;
		} finally { publicHost.stop(); }
	});
});

for (const ordinary of ["memory", "model"] as const) {
	test(`actual index inverse admission: already-open ${ordinary} dialog refuses password without focus change or reservation leak`, bounded, async t => {
		await isolated(t, async f => {
			syntheticReview(t, f);
			const h = f.mount(); await h.start(); const publicHost = publicIndexHost(f, h);
			const reviewAbort = new AbortController();
			try {
				const ordinaryWork = ordinary === "memory" ?
					h.lane.tools.get("jarvis_memory_forget")!.execute("review", { id: "review-fixture" }, reviewAbort.signal, undefined, h.ctx as any).catch(() => undefined) :
					h.command("jarvis-model");
				await until(() => ordinary === "memory" ? publicHost.confirms() === 1 : f.activeDialog?.component instanceof JarvisModelPicker);
				const focus = publicHost.host.getFocusedComponent(), dialogs = f.dialogs.length;
				assert.ok(focus); assert.equal(isArchiveSecretPromptActive(), false);
				await h.command("jarvis-archive", ENCRYPT);
				assert.equal(publicHost.host.getFocusedComponent(), focus, "refusal must never request custom done/editor restoration");
				assert.equal(f.dialogs.length, dialogs); assert.equal(publicHost.confirms(), ordinary === "memory" ? 1 : 0);
				assert.equal(isArchiveSecretPromptActive(), false, "failed preparation releases only its reservation");
				assert.equal(f.dialogs.some(dialog => dialog.component instanceof ArchiveSecretInput), false);
				if (ordinary === "memory") reviewAbort.abort(); else publicHost.buffer.process("\x1b[27u");
				await ordinaryWork;
				assert.equal(publicHost.host.getFocusedComponent(), publicHost.editor);
				assert.equal(publicHost.reviewRestores(), ordinary === "memory" ? 1 : 0, "ordinary reviewAbort still works when it owns input");
				// A later explicit request proves neither reservation nor index dialog
				// flag leaked on refusal. Stop before password/KDF/native credentials.
				const next = h.command("jarvis-archive", ENCRYPT);
				await until(() => f.activeDialog?.component instanceof ArchiveSecretInput);
				const component = f.activeDialog!.component as ArchiveSecretInput;
				revokeArchiveSecretPrompt(); await next;
				assert.equal(isArchiveSecretPromptActive(), true); publicHost.verify(component);
				await until(() => !isArchiveSecretPromptActive()); await h.shutdown("quit");
			} finally { publicHost.stop(); }
		});
	});
}
