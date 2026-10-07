import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type KeybindingsManager,
	type Theme, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, Input, StdinBuffer, TuiMainScreen, type Component, type TUI, type Terminal } from "@earendil-works/pi-tui";
import jarvisExtension from "../index.js";
import { createMemoryEditorBackend } from "../memory-editor-controller.js";
import type { MemoryEditorService } from "../memory-editor-types.js";
import { MemoryEditorOverlay } from "../memory-editor.js";
import { SharedMemoryService } from "../memory-service.js";
import { NativeArchiveKeychain } from "../archive-keychain.js";
import { abandonArchiveSecretPrompt, ArchiveSecretInput, isArchiveSecretPromptActive, promptArchiveSecret, revokeArchiveSecretPrompt } from "../archive-secret-input.js";
import { JarvisModelPicker } from "../model-picker.js";
import { JarvisOverlayComponent, type JarvisOverlayView } from "../overlay.js";
import { JarvisSideSessionRuntime } from "../side-session.js";

const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value, bold: (value: string) => value } as Theme;
const model: Model<"openai-completions"> = {
	id: "memory-editor-fixture", name: "Memory editor fixture", provider: "fixture", api: "openai-completions",
	baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000,
};
function deferred<T = void>() {
	let settle!: (value: T) => void;
	const promise = new Promise<T>(yes => { settle = yes; });
	const resolve = (value?: T) => settle(value as T);
	return { promise, resolve };
}
async function tick() { await new Promise<void>(yes => setImmediate(yes)); }
async function until(predicate: () => boolean) {
	for (let n = 0; n < 150; n++) { if (predicate()) return; await tick(); }
	assert.fail("timed out waiting for synthetic editor host");
}
type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type Dialog = { component: Component & { dispose?(): void; focused?: boolean }; closed: boolean; disposed: boolean; done(value?: unknown): void };
class FakeRuntime {
	readonly sent: string[] = [];
	readonly access: boolean[] = [];
	disposed = false;
	gate?: ReturnType<typeof deferred>;
	constructor(readonly options: Parameters<typeof JarvisSideSessionRuntime.create>[0]) {}
	isReady() { return true; }
	isStreaming() { return Boolean(this.gate); }
	getModelLabel() { return "fixture/memory-editor-fixture"; }
	getThinkingLevel() { return "off"; }
	getRepoToolsDetailLabel() { return "fake tools"; }
	getDisplayEntries() { return []; }
	setToolAccessEnabled(value: boolean) { this.access.push(value); }
	addSystemMessage() {}
	async syncModel() {}
	async sendMessage(text: string) { this.sent.push(text); await this.gate?.promise; }
	async cancelWork() { this.gate?.resolve(); }
	flushArchive() { assert.equal(this.disposed, false); }
	dispose() { this.disposed = true; }
}
class Fixture {
	readonly root = mkdtempSync(join(tmpdir(), "pi-jarvis-memory-editor-index-"));
	readonly agentDir = join(this.root, "agent");
	readonly project = join(this.root, "workspace");
	readonly manager: SessionManager;
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	readonly tools = new Map<string, ToolDefinition<any>>();
	readonly dialogs: Dialog[] = [];
	readonly starts: Array<() => void> = [];
	readonly notices: string[] = [];
	readonly services = new Set<SharedMemoryService>();
	readonly runtimes: FakeRuntime[] = [];
	readonly ordinary = new Input();
	readonly submissions: string[] = [];
	readonly stdin = new StdinBuffer();
	active?: Dialog;
	confirmGate?: ReturnType<typeof deferred<boolean>>;
	confirmCalls = 0;
	onDone?: () => void;
	registryCalls = 0;
	forbiddenCalls = 0;
	deferFactory = false;
	permitLateFactory = false;
	trusted = true;
	service?: SharedMemoryService;
	publicHost?: TuiMainScreen;
	ctx: ExtensionCommandContext;
	api: ExtensionAPI;
	constructor(mode: ExtensionContext["mode"] = "tui") {
		mkdirSync(join(this.agentDir, "extensions"), { recursive: true }); mkdirSync(this.project);
		writeFileSync(join(this.agentDir, "extensions", "pi-jarvis.json"), JSON.stringify({ memory: { enabled: true, capture: true, recall: true } }));
		writeFileSync(join(this.agentDir, "extensions", "pi-jarvis-archive.json"), JSON.stringify({ archive: { enabled: false, capture: false, modelAccess: false } }));
		this.manager = SessionManager.inMemory(this.project);
		this.ordinary.onSubmit = value => this.submissions.push(value);
		const forbidden = () => { this.forbiddenCalls++; assert.fail("no provider, credentials, network or injected model work in editor fixture"); };
		const registry = {
			find: () => model, getAvailable: () => [model], getAll: () => [model],
			refresh: async () => { this.registryCalls++; }, stream: forbidden, streamSimple: forbidden, getProviderAuth: forbidden,
		} as unknown as ExtensionContext["modelRegistry"];
		const ui = {
			theme, notify: (text: string) => { this.notices.push(text); }, setStatus() {},
			input: forbidden, editor: forbidden, setEditorText: forbidden, pasteToEditor: forbidden,
			confirm: async () => { this.confirmCalls++; return await this.confirmGate?.promise ?? false; },
			custom: this.custom,
		} as unknown as ExtensionContext["ui"];
		this.ctx = {
			cwd: this.project, mode, hasUI: mode === "tui" || mode === "rpc", ui, sessionManager: this.manager,
			modelRegistry: registry, model, scopedModels: [], signal: undefined,
			isProjectTrusted: () => this.trusted, isIdle: () => true, hasPendingMessages: () => false,
			getSystemPrompt: () => "Synthetic host.", getContextUsage: () => undefined,
		} as unknown as ExtensionCommandContext;
		let activeTools: string[] = [];
		this.api = {
			on: (name: string, handler: Handler) => { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); },
			registerCommand: (name: string, command: any) => { this.commands.set(name, command); },
			registerTool: (tool: ToolDefinition<any>) => { this.tools.set(tool.name, tool); },
			getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { activeTools = names; }, getThinkingLevel: () => "off",
			appendEntry: (kind: string, value: unknown) => this.manager.appendCustomEntry(kind, value),
			sendMessage: forbidden, sendUserMessage: forbidden, exec: forbidden, registerProvider: forbidden,
		} as unknown as ExtensionAPI;
		if (mode === "tui") this.usePublicHost();
	}
	custom: ExtensionContext["ui"]["custom"] = <T>(factory: Parameters<ExtensionContext["ui"]["custom"]>[0], opts?: Parameters<ExtensionContext["ui"]["custom"]>[1]): Promise<T> => {
		assert.equal(this.ctx.mode, "tui");
		return new Promise<T>((resolve, reject) => {
			let dialog: Dialog | undefined, closed = false;
			let handle: ReturnType<TUI["showOverlay"]> | undefined;
			const host = this.publicHost ?? { mode: "regular", terminal: { rows: 40, columns: 110 }, requestRender() {} } as TUI;
			const done = (value?: unknown) => {
				if (closed) return; closed = true;
				if (dialog) dialog.closed = true;
				this.onDone?.();
				if (opts?.overlay) this.publicHost?.hideOverlay(); // Public Pi custom close pops TOPMOST, never an exact handle.
				else if (this.publicHost) {
					if (dialog) this.publicHost.removeChild(dialog.component);
					this.publicHost.addChild(this.ordinary); this.publicHost.setFocus(this.ordinary);
				}
				resolve(value as T);
				dialog?.component.dispose?.(); if (dialog) dialog.disposed = true;
				if (this.active === dialog) this.active = undefined;
			};
			const start = () => {
				const previousActive = this.active;
				if (!this.permitLateFactory) assert.equal(this.active, undefined, "custom dialogs must never overlap");
				try {
					// Match public Pi: invoke factory now, mount in a Promise.then, then
					// expose onHandle. Completing before that mount pops someone else's UI.
					void Promise.resolve(factory(host, theme, getKeybindings() as unknown as KeybindingsManager, done)).then(component => {
						dialog = { component, done, closed, disposed: closed }; this.dialogs.push(dialog);
						if (closed) return;
						this.active = dialog;
						if (this.publicHost && opts?.overlay) {
							handle = this.publicHost.showOverlay(component, opts.overlayOptions instanceof Function ? opts.overlayOptions() : opts.overlayOptions);
							opts.onHandle?.(handle);
							if (handle.isHidden()) this.active = previousActive;
						} else if (this.publicHost) {
							this.publicHost.removeChild(this.ordinary); this.publicHost.addChild(component); this.publicHost.setFocus(component);
						} else dialog.component.focused = true;
					}).catch(reject);
				} catch (error) { reject(error); }
			};
			if (this.deferFactory) this.starts.push(start); else start();
		});
	};
	async emit(type: string, event: object = {}): Promise<unknown[]> {
		const result: unknown[] = [];
		for (const handler of this.handlers.get(type) ?? []) result.push(await handler({ type, ...event }, this.ctx));
		return result;
	}
	command(name: string, args = "") { const command = this.commands.get(name); assert.ok(command); return command.handler(args, this.ctx); }
	forget(signal?: AbortSignal) {
		const note = this.note();
		return this.tools.get("jarvis_memory_forget")!.execute("fixture-review", { id: note.id }, signal, undefined, this.ctx as any);
	}
	note() {
		assert.ok(this.service);
		const output = this.service.command("remember Synthetic fixture title | Synthetic durable fact.", this.ctx);
		const id = output.match(/[a-f0-9]{64}/)?.[0]; assert.ok(id);
		return this.service.editorGet(id, this.ctx, "current")!;
	}
	usePublicHost() {
		if (this.publicHost) return;
		const terminal: Terminal = {
			columns: 110, rows: 40, kittyProtocolActive: false, write() {},
			start: onInput => { this.stdin.on("data", onInput); }, stop() {}, async drainInput() {},
			setTitle() {}, setProgress() {}, moveBy() {}, hideCursor() {}, showCursor() {},
			clearLine() {}, clearFromCursor() {}, clearScreen() {},
		};
		this.publicHost = new TuiMainScreen(terminal); this.publicHost.addChild(this.ordinary); this.publicHost.setFocus(this.ordinary); this.publicHost.start();
	}
	forceUnmount() { this.active?.component.dispose?.(); if (this.active) this.active.disposed = true; this.active = undefined; }
}
async function isolated(t: TestContext, run: (f: Fixture) => Promise<void>, mode: ExtensionContext["mode"] = "tui") {
	const f = new Fixture(mode), prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = f.agentDir;
	const prepare = SharedMemoryService.prototype.prepare;
	t.mock.method(SharedMemoryService.prototype, "prepare", function(this: SharedMemoryService, ctx: Parameters<SharedMemoryService["prepare"]>[0]) {
		f.service = this; f.services.add(this); return prepare.call(this, ctx);
	});
	t.mock.method(JarvisSideSessionRuntime, "create", async (options: Parameters<typeof JarvisSideSessionRuntime.create>[0]) => {
		const runtime = new FakeRuntime(options); f.runtimes.push(runtime); return runtime as unknown as JarvisSideSessionRuntime;
	});
	for (const name of ["get", "set", "delete"] as const) t.mock.method(NativeArchiveKeychain.prototype, name, async () => assert.fail("OS credentials forbidden"));
	t.mock.method(globalThis, "fetch", async () => assert.fail("network forbidden"));
	try {
		jarvisExtension(f.api); await f.emit("session_start", { reason: "startup" });
		await run(f); assert.equal(f.forbiddenCalls, 0); assert.equal(f.ordinary.getValue(), ""); assert.deepEqual(f.submissions, []);
	} finally {
		abandonArchiveSecretPrompt(); f.forceUnmount(); f.stdin.destroy(); f.publicHost?.stop();
		await f.emit("session_shutdown", { reason: "quit" });
		for (const service of f.services) service.close(); t.mock.restoreAll();
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
		rmSync(f.root, { recursive: true, force: true });
	}
}
function viewOf(component: Component): JarvisOverlayView {
	// Own extension seam, never a Pi SDK backing field.
	return (component as unknown as { view: JarvisOverlayView }).view;
}
async function close(f: Fixture, memoryEditor = true) {
	const dialog = f.active!;
	dialog.component.handleInput?.("\x1b");
	if (memoryEditor) {
		assert.equal(f.active, dialog, "a lone Escape must retain editor ownership while it could be a paste opener");
		dialog.component.render(110);
		dialog.component.handleInput?.("\r");
	}
	await until(() => !f.active);
}
const bounded = { concurrency: false, timeout: 30000 };

test("editor initial geometry caps wide terminals while preserving its review height budget", bounded, async t => {
	await isolated(t, async f => {
		f.usePublicHost();
		const custom = f.ctx.ui.custom;
		let options: Parameters<ExtensionContext["ui"]["custom"]>[1];
		f.ctx.ui.custom = ((factory, opts) => { options = opts; return custom(factory, opts); }) as typeof custom;
		const opened = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active));
		assert.equal(typeof options?.overlayOptions, "function");
		const geometry = options!.overlayOptions as () => { width: number; maxHeight: string; minWidth: number };
		assert.equal(geometry().width, 99);
		(f.publicHost!.terminal as { columns: number }).columns = 400;
		assert.equal(geometry().width, 144, "a new wide-screen mount must keep a bounded readable width");
		(f.publicHost!.terminal as { columns: number }).columns = 40;
		assert.equal(geometry().width, 60, "Pi owns the final clamp to a tiny terminal");
		assert.equal(geometry().maxHeight, "90%", "component review pagination must match host max height");
		(f.publicHost!.terminal as { columns: number }).columns = 110;
		await close(f); await opened;
	});
});

for (const mode of ["rpc", "print", "json"] as const) test(`actual index editor is TUI-only in ${mode}, including initial aliases`, bounded, async t => {
	await isolated(t, async f => {
		await f.command("jarvis-memory", "editor"); await f.command("jarvis", "/memory editor"); await f.command("jarvis", "/jarvis-memory editor");
		assert.equal(f.dialogs.length, 0); assert.equal(f.runtimes.length, 0); assert.equal(f.registryCalls, 0);
		assert.equal(existsSync(join(f.agentDir, "extensions", "pi-jarvis-memory", "memory.sqlite")), false);
	}, mode);
});

test("actual index local aliases never boot/queue/append; status and inline edit remain unchanged", bounded, async t => {
	await isolated(t, async f => {
		const record = f.note(); await f.command("jarvis-memory", `edit ${record.id} Inline replacement fact.`);
		assert.equal(f.service!.editorGet(record.id, f.ctx, "current")!.text, "Inline replacement fact.");
		await f.command("jarvis-memory"); assert.match(f.notices.at(-1)!, /Shared memory ON/);
		await f.command("jarvis-memory", "editor --all"); assert.equal(f.dialogs.length, 0);
		const before = f.manager.getEntries();
		for (const [command, args] of [["jarvis-memory", "editor"], ["jarvis", "/memory editor"], ["jarvis", "/jarvis-memory editor"]]) {
			const opened = f.command(command!, args!); await until(() => Boolean(f.active)); await close(f); await opened;
		}
		assert.deepEqual(f.manager.getEntries(), before); assert.equal(f.runtimes.length, 0); assert.equal(f.registryCalls, 0);
	});
});

test("synchronous editor reservation gates deferred factory, Jarvis, picker, forget review and archive preparation", bounded, async t => {
	await isolated(t, async f => {
		f.note(); f.deferFactory = true;
		writeFileSync(join(f.agentDir, "extensions", "pi-jarvis-archive.json"), JSON.stringify({ archive: { enabled: true, capture: false, modelAccess: false } }));
		const opened = f.command("jarvis-memory", "editor");
		await f.command("jarvis"); await f.command("jarvis-model"); await f.command("jarvis-memory", "editor");
		const review = await f.forget(); assert.match(JSON.stringify(review), /not forgotten/);
		await f.command("jarvis-archive", "encryption on --confirm-sensitive --confirm-stopped");
		assert.equal(isArchiveSecretPromptActive(), false, "refusal releases only private primitive's reservation");
		assert.equal(f.confirmCalls, 0); assert.equal(f.registryCalls, 0); assert.equal(f.runtimes.length, 0);
		assert.equal(f.starts.length, 1); assert.equal(f.dialogs.length, 0);
		f.starts.shift()!(); await until(() => Boolean(f.active)); await close(f); await opened;
	});
});

test("editor admission remains reserved through reentrant host done until actual custom disposal", bounded, async t => {
	await isolated(t, async f => {
		f.note(); const opened = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active)); await tick();
		let raced: Promise<unknown[]> | undefined;
		f.onDone = () => { f.onDone = undefined; raced = Promise.all([f.command("jarvis"), f.command("jarvis-model"), f.command("jarvis-memory", "editor"), f.forget()]); };
		await close(f); await opened; assert.ok(raced); await raced;
		assert.equal(f.runtimes.length, 0); assert.equal(f.registryCalls, 0); assert.equal(f.confirmCalls, 0); assert.equal(f.dialogs.length, 1);
	});
});

test("clean pre-navigation can close a deferred editor factory without overlapping a fresh dialog", bounded, async t => {
	await isolated(t, async f => {
		f.deferFactory = true; const opened = f.command("jarvis-memory", "editor"); await until(() => f.starts.length === 1);
		assert.ok(!(await f.emit("session_before_tree")).some(result => (result as { cancel?: boolean } | undefined)?.cancel));
		await f.command("jarvis-memory", "editor"); assert.equal(f.starts.length, 1);
		f.starts.shift()!(); await opened; assert.equal(f.dialogs[0]!.closed, true); assert.equal(f.active, undefined);
	});
});

test("private preparation and revoked cancel-only sink refuse editor without data reads", bounded, async t => {
	await isolated(t, async f => {
		let reads = 0; t.mock.method(SharedMemoryService.prototype, "editorList", () => { reads++; assert.fail("no reads under private input"); });
		const prep = deferred(), result = promptArchiveSecret(f.ctx, "Synthetic private ownership", undefined, () => prep.promise);
		assert.equal(isArchiveSecretPromptActive(), true);
		await f.command("jarvis-memory", "editor"); assert.equal(f.dialogs.length, 0);
		revokeArchiveSecretPrompt(); await result; prep.resolve(); await until(() => Boolean(f.active));
		await f.command("jarvis-memory", "editor"); assert.equal(f.dialogs.length, 1); assert.equal(reads, 0);
		const secret = f.active!.component as ArchiveSecretInput;
		secret.handleInput("\x1b");
		const code = secret.render(110).join("\n").match(/\b([A-HJ-NP-Z2-9]{4}) ([A-HJ-NP-Z2-9]{4}) ([A-HJ-NP-Z2-9]{4})\b/);
		assert.ok(code); for (const char of code.slice(1).join("")) secret.handleInput(char); secret.handleInput("\r");
		await until(() => !isArchiveSecretPromptActive()); assert.equal(f.runtimes.length, 0);
	});
});

test("inverse model picker and main forget review admission refuse editor", bounded, async t => {
	await isolated(t, async f => {
		const picker = f.command("jarvis-model"); await until(() => f.active?.component instanceof JarvisModelPicker);
		await f.command("jarvis-memory", "editor"); assert.equal(f.dialogs.length, 1); await close(f, false); await picker;
		f.note(); f.confirmGate = deferred<boolean>(); const review = f.forget(); await until(() => f.confirmCalls === 1);
		await f.command("jarvis-memory", "editor"); assert.equal(f.dialogs.length, 1);
		f.confirmGate.resolve(false); await review;
		const opened = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active)); await close(f); await opened;
	});
});

test("public TUI close-to-editor preserves assigned Jarvis work and all grants; editor close never reopens", bounded, async t => {
	await isolated(t, async f => {
		f.usePublicHost();
		const jarvis = f.command("jarvis"); await until(() => f.active?.component instanceof JarvisOverlayComponent && f.runtimes.length === 1);
		const view = viewOf(f.active!.component), runtime = f.runtimes[0]!;
		view.toggleToolAccess(); view.toggleFollowUpToMain(); view.toggleSteerToMain();
		runtime.gate = deferred(); const work = view.sendMessage("Synthetic assigned work"); await until(() => runtime.sent.length === 1);
		f.deferFactory = true; const opened = view.sendMessage("/memory editor");
		await f.command("jarvis"); await f.command("jarvis-model"); await until(() => f.starts.length === 1); await jarvis;
		assert.equal(runtime.disposed, false); assert.equal(runtime.access.at(-1), true);
		assert.equal(view.isFollowUpToMainEnabled(), true); assert.equal(view.isSteerToMainEnabled(), true);
		f.starts.shift()!(); await until(() => Boolean(f.active)); f.publicHost!.renderNow();
		assert.equal(f.publicHost!.getFocusedComponent(), f.active!.component);
		assert.equal(await runtime.options.confirmSteerToMain("no invisible review"), false);
		await close(f); await opened;
		assert.equal(f.dialogs.length, 2); assert.equal(f.runtimes.length, 1); assert.equal(runtime.disposed, false);
		runtime.gate.resolve(); await work; assert.deepEqual(runtime.sent, ["Synthetic assigned work"]);
	});
});

test("dirty editor refuses cancellable navigation without nested review; normal journal append does not expire owner", bounded, async t => {
	await isolated(t, async f => {
		let dirty = true; t.mock.method(MemoryEditorOverlay.prototype, "isDirty", () => dirty);
		const opened = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active));
		f.manager.appendMessage({ role: "user", content: "Synthetic append, not navigation", timestamp: 1 });
		for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
			assert.ok((await f.emit(event)).some(result => (result as { cancel?: boolean } | undefined)?.cancel));
		}
		assert.equal(f.confirmCalls, 0); assert.equal(f.active!.disposed, false);
		dirty = false; assert.ok(!(await f.emit("session_before_tree")).some(result => (result as { cancel?: boolean } | undefined)?.cancel));
		await opened; await until(() => !f.active);
	});
});

test("forced unchanged-reference main tree disposes stale editor without done; deferred factory cannot restore it", bounded, async t => {
	await isolated(t, async f => {
		f.deferFactory = true; const old = f.command("jarvis-memory", "editor"); await until(() => f.starts.length === 1);
		await f.emit("session_tree"); await old; f.starts.shift()!(); await until(() => f.dialogs.length === 1);
		assert.deepEqual(f.dialogs[0]!.component.render(110), []); assert.equal(f.dialogs[0]!.closed, false);
		assert.equal(f.active, undefined, "exact hidden obsolete overlay never becomes active");
		const fresh = f.command("jarvis-memory", "editor"); await until(() => f.starts.length === 1); f.starts.shift()!();
		await until(() => Boolean(f.active)); assert.match(f.active!.component.render(110).join(""), /memory/i);
		await close(f); await fresh;
		// The public promise can remain abandoned, but the owned command already settled without stale done.
	});
});

test("deferred Jarvis factory is closed before editor custom request, with reservation across the wait", bounded, async t => {
	await isolated(t, async f => {
		f.deferFactory = true;
		const jarvis = f.command("jarvis"); await until(() => f.starts.length === 1);
		const opened = f.command("jarvis-memory", "editor");
		await f.command("jarvis"); await f.command("jarvis-model");
		assert.equal(f.starts.length, 1, "editor waits for prior public custom lifecycle rather than overlapping it");
		f.starts.shift()!(); await jarvis; await until(() => f.starts.length === 1);
		assert.equal(f.dialogs[0]!.closed, true); assert.deepEqual(f.dialogs[0]!.component.render(110), []);
		f.starts.shift()!(); await until(() => Boolean(f.active)); await close(f); await opened;
		assert.equal(f.runtimes.length, 1); assert.equal(f.runtimes[0]!.disposed, false);
	});
});

test("late forced editor factory cannot steal fresh public TUI focus and never invokes stale done", bounded, async t => {
	await isolated(t, async f => {
		f.usePublicHost(); f.deferFactory = true;
		const old = f.command("jarvis-memory", "editor"); await until(() => f.starts.length === 1);
		const oldStart = f.starts.shift()!; await f.emit("session_tree");
		f.deferFactory = false; const fresh = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active));
		const current = f.active!; f.permitLateFactory = true; oldStart(); f.permitLateFactory = false; await tick();
		assert.equal(f.active, current); assert.equal(f.publicHost!.getFocusedComponent(), current.component);
		const late = f.dialogs.at(-1)!; assert.equal(late.closed, false); assert.deepEqual(late.component.render(110), []);
		await close(f); await fresh; void old;
	});
});

test("queued side /new invalidates dirty editor without changing the main archive lifetime order", bounded, async t => {
	await isolated(t, async f => {
		const jarvis = f.command("jarvis"); await until(() => Boolean(f.active) && f.runtimes.length === 1);
		const view = viewOf(f.active!.component), first = f.runtimes[0]!;
		first.gate = deferred(); const work = view.sendMessage("Assigned synthetic work"); await until(() => first.sent.length === 1);
		const reset = view.sendMessage("/new");
		const editor = view.sendMessage("/jarvis-memory editor"); await jarvis; await until(() => Boolean(f.active));
		await tick(); f.active!.component.handleInput?.("n"); f.active!.component.handleInput?.("DIRTY_SIDE_NEW_CANARY");
		assert.match(f.active!.component.render(110).join(""), /DIRTY_SIDE_NEW_CANARY/);
		const snapshot = first.flushArchive.bind(first); let mainTrustAtFinalization = false;
		first.flushArchive = () => { mainTrustAtFinalization = first.options.archiveTrustProvider!(); snapshot(); };
		first.gate.resolve(); await Promise.all([work, reset, editor]); await until(() => !f.active);
		assert.equal(mainTrustAtFinalization, true); assert.equal(first.disposed, true); assert.equal(f.runtimes.length, 2);
	});
});

test("actual index owner expiry inside service SQLite guard prevents reviewed create COMMIT without trust denial", bounded, async t => {
	await isolated(t, async f => {
		f.note(); // Prewarm SQLite so the targeted final guard runs after INSERT, before COMMIT.
		const create = SharedMemoryService.prototype.editorCreate; let calls = 0; let navigation: Promise<unknown[]> | undefined;
		t.mock.method(SharedMemoryService.prototype, "editorCreate", function(this: SharedMemoryService, draft: Parameters<typeof create>[0], ctx: Parameters<typeof create>[1], check?: () => void) {
			assert.ok(check, "host must pass its last owner guard into service transactions");
			return create.call(this, draft, ctx, () => {
				if (++calls === 11) navigation = f.emit("session_tree");
				check();
			});
		});
		const opened = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active)); await tick();
		const editor = f.active!.component;
		editor.handleInput?.("n"); editor.handleInput?.("Cancelled create fixture"); editor.handleInput?.("\t");
		editor.handleInput?.("Synthetic transaction cancellation fact."); editor.handleInput?.("\x13");
		assert.match(editor.render(110).join(""), /SAVE REVIEW/); editor.handleInput?.("y"); await tick();
		assert.ok(navigation); await navigation;
		assert.equal(f.ctx.isProjectTrusted(), true); assert.deepEqual(editor.render(110), []);
		assert.equal(f.service!.editorList({ scope: "all", query: "Cancelled" }, f.ctx).total, 0, "cancelled transaction may not commit");
		f.forceUnmount(); void opened;
	});
});

test("data changes flag refresh without policy invalidation; observed full off immediately wipes editor", bounded, async t => {
	await isolated(t, async f => {
		const pauses: string[] = [], invalidate = MemoryEditorOverlay.prototype.invalidateAccess;
		t.mock.method(MemoryEditorOverlay.prototype, "invalidateAccess", function(this: MemoryEditorOverlay, reason: string) { pauses.push(reason); invalidate.call(this, reason); });
		const opened = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active)); await tick();
		f.active!.component.handleInput?.("n"); f.active!.component.handleInput?.("UNSAVED_HOST_DRAFT_CANARY");
		const epoch = f.service!.epoch;
		f.service!.editorCreate({ title: "External synthetic note", text: "External durable fixture fact.", scope: "project", category: "reference" }, f.ctx);
		assert.equal(f.service!.epoch, epoch); assert.equal(pauses.length, 0);
		assert.match(f.active!.component.render(110).join(""), /UNSAVED_HOST_DRAFT_CANARY/);
		await f.command("jarvis-memory", "off"); assert.equal(pauses.length, 1);
		assert.ok(!f.active!.component.render(110).join("").includes("External durable fixture fact"));
		assert.ok(!f.active!.component.render(110).join("").includes("UNSAVED_HOST_DRAFT_CANARY"));
		await close(f); await opened;
		const count = f.dialogs.length; await f.command("jarvis-memory", "editor"); assert.equal(f.dialogs.length, count);
	});
});

test("human editor remains available with capture and recall paused, but full off/untrusted deny before data methods", bounded, async t => {
	await isolated(t, async f => {
		await f.command("jarvis-memory", "capture off"); await f.command("jarvis-memory", "recall off");
		const opened = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active)); await close(f); await opened;
		let reads = 0; t.mock.method(SharedMemoryService.prototype, "editorList", () => { reads++; assert.fail("paused admission may not read records"); });
		f.trusted = false; await f.command("jarvis-memory", "editor"); assert.equal(reads, 0);
		f.trusted = true; await f.command("jarvis-memory", "off"); await f.command("jarvis-memory", "editor"); assert.equal(reads, 0);
	});
});

test("backend forwards exact last transaction check for all five methods, checks after data and does not falsify trust", bounded, async t => {
	await isolated(t, async f => {
		const ctx = f.ctx, expected = f.note(); let active = true, observed = 0;
		const check = () => { observed++; if (!active) throw new Error("synthetic cancellation"); };
		const callbacks: Array<() => void> = [];
		const service: MemoryEditorService = {
			editorAccess: () => ({ enabled: true, capture: false, recall: false }), onNotesChange: () => () => {},
			editorList: (_q, _c, guard) => { callbacks.push(guard!); return { records: [], total: 0, offset: 0, nextOffset: null }; },
			editorGet: (_id, _c, _s, guard) => { callbacks.push(guard!); return expected; },
			editorCreate: (_d, _c, guard) => { callbacks.push(guard!); return expected; },
			editorUpdate: (_r, _d, _c, _s, guard) => { callbacks.push(guard!); return expected; },
			editorForget: (_rs, _c, _s, guard) => { callbacks.push(guard!); return 1; },
		};
		const backend = createMemoryEditorBackend(service, ctx, check);
		const draft = { title: "Guard fixture", text: "Guard fixture fact", scope: "project" as const, category: "project" as const };
		backend.list({ scope: "current" }); backend.get(expected.id, "current"); backend.create(draft); backend.update(expected, draft, "current"); backend.forget([expected], "current");
		assert.equal(callbacks.length, 5); assert.ok(callbacks.every(callback => callback === check)); assert.ok(observed >= 20);
		service.editorCreate = (_d, _c, guard) => { active = false; guard!(); assert.fail("cancelled transaction must not commit"); };
		assert.throws(() => backend.create(draft), /cancellation/); assert.equal(ctx.isProjectTrusted(), true);
		active = true; service.editorGet = () => { active = false; return expected; };
		assert.throws(() => backend.get(expected.id, "current"), /cancellation/, "read results cannot escape a changed owner");
	});
});

test("actual public in-memory SDK host executes editor commands with no model call or Pi transcript injection", bounded, async t => {
	await isolated(t, async f => {
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
			modelsStorePath: join(f.agentDir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
		const registry = new ModelRegistry(runtime);
		registry.registerProvider({ id: model.provider, name: "Synthetic only", getModels: () => [model],
			auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			stream: () => assert.fail("editor cannot call model"), streamSimple: () => assert.fail("editor cannot call model") });
		const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd: f.project, agentDir: f.agentDir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Synthetic memory editor host.", extensionFactories: [jarvisExtension] });
		await loader.reload();
		const manager = SessionManager.inMemory(f.project);
		const { session } = await createAgentSession({ cwd: f.project, agentDir: f.agentDir, modelRuntime: runtime, model,
			thinkingLevel: "off", noTools: "all", resourceLoader: loader, settingsManager: settings, sessionManager: manager });
		try {
			await session.bindExtensions({ mode: "tui", uiContext: f.ctx.ui, onError: error => assert.fail(error.error) });
			const before = manager.getEntries();
			for (const command of ["/jarvis-memory editor", "/jarvis /memory editor", "/jarvis /jarvis-memory editor"]) {
				const opened = session.prompt(command); await until(() => Boolean(f.active)); await close(f); await opened;
			}
			assert.deepEqual(manager.getEntries(), before); assert.equal(f.runtimes.length, 0);
		} finally { session.dispose(); }
	});
});

for (const boundary of ["session_tree", "session_start", "session_shutdown"] as const) test(`forced ${boundary} settles a pending Jarvis/editor handoff before its obsolete factory and preserves fresh foreground`, bounded, async t => {
	await isolated(t, async f => {
		f.deferFactory = true;
		const oldJarvis = f.command("jarvis"); await until(() => f.starts.length === 1 && f.runtimes.length === 1);
		const obsoleteFactory = f.starts.shift()!, firstRuntime = f.runtimes[0]!;
		const editor = f.command("jarvis-memory", "editor");
		await f.emit(boundary, { reason: boundary === "session_shutdown" ? "reload" : "switch" });
		// Both extension-owned requests settle even if the host never executes or
		// settles the old public custom promise. No timeout/private-gate release.
		let settled = false; void Promise.all([oldJarvis, editor]).then(() => { settled = true; });
		await until(() => settled);
		if (boundary === "session_tree") {
			assert.equal(firstRuntime.disposed, false);
			assert.equal(firstRuntime.options.archiveTrustProvider!(), true, "UI retirement must not increment the boot generation");
		} else assert.equal(firstRuntime.disposed, true);
		f.deferFactory = false;
		const freshJarvis = f.command("jarvis"); await until(() => f.active?.component instanceof JarvisOverlayComponent);
		const fresh = f.active!, view = viewOf(fresh.component);
		view.toggleToolAccess(); view.toggleFollowUpToMain(); view.toggleSteerToMain();
		let obsoleteDone = 0; f.onDone = () => { obsoleteDone++; };
		f.permitLateFactory = true; obsoleteFactory(); f.permitLateFactory = false; await tick();
		assert.equal(obsoleteDone, 0, "an abandoned factory must NEVER invoke old public done");
		assert.equal(f.active, fresh); assert.equal(f.publicHost!.getFocusedComponent(), fresh.component);
		assert.equal(f.ordinary.focused, false); assert.deepEqual(f.dialogs.at(-1)!.component.render(110), []);
		assert.equal(f.dialogs.at(-1)!.closed, false);
		assert.equal(view.isToolAccessEnabled(), true); assert.equal(view.isFollowUpToMainEnabled(), true); assert.equal(view.isSteerToMainEnabled(), true);
		f.onDone = undefined;
		// Positive fresh UI control: late hidden overlay does not strand normal
		// close/handoff or the next editor behind an abandoned wait reference.
		const nextEditor = view.sendMessage("/memory editor"); await freshJarvis;
		await until(() => Boolean(f.active)); await tick();
		assert.equal(f.publicHost!.getFocusedComponent(), f.active!.component);
		f.stdin.process("\x1b"); await new Promise(resolve => setTimeout(resolve, 25));
		assert.ok(f.active, "native lone ESC retains the current editor");
		f.active!.component.render(110); f.stdin.process("\r"); await nextEditor; await until(() => !f.active);
		assert.equal(f.publicHost!.getFocusedComponent(), f.ordinary);
	});
});

test("cancellation retires an unmounted Jarvis handoff without fake trust denial or waiting for the abandoned host promise", bounded, async t => {
	await isolated(t, async f => {
		f.deferFactory = true;
		const jarvis = f.command("jarvis"); await until(() => f.starts.length === 1 && f.runtimes.length === 1);
		const obsoleteFactory = f.starts.shift()!, runtime = f.runtimes[0]!;
		const cancel = new AbortController(); f.ctx.signal = cancel.signal;
		const oldEditor = f.command("jarvis-memory", "editor"); cancel.abort();
		let settled = false; void Promise.all([jarvis, oldEditor]).then(() => { settled = true; }); await until(() => settled);
		assert.equal(f.ctx.isProjectTrusted(), true); assert.equal(runtime.disposed, false);
		assert.equal(runtime.options.archiveTrustProvider!(), true); f.ctx.signal = undefined;
		f.deferFactory = false; const picker = f.command("jarvis-model"); await until(() => f.active?.component instanceof JarvisModelPicker);
		const current = f.active!; let obsoleteDone = 0; f.onDone = () => { obsoleteDone++; };
		f.permitLateFactory = true; obsoleteFactory(); f.permitLateFactory = false; await tick();
		assert.equal(obsoleteDone, 0); assert.equal(f.publicHost!.getFocusedComponent(), current.component);
		f.onDone = undefined; await close(f, false); await picker;
		const editor = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active)); await close(f); await editor;
	});
});

for (const phase of ["preparation", "password sink", "cancel-only sink"] as const) test(`late Jarvis factory never completes or steals private archive ${phase} ownership`, bounded, async t => {
	await isolated(t, async f => {
		writeFileSync(join(f.agentDir, "extensions", "pi-jarvis-archive.json"), JSON.stringify({ archive: { enabled: true, capture: false, modelAccess: false } }));
		f.deferFactory = true;
		const jarvis = f.command("jarvis"); await until(() => f.starts.length === 1 && f.runtimes.length === 1);
		const obsoleteFactory = f.starts.shift()!;
		// The real index beforeSecretPrompt hook reserves private input, revokes
		// grants and retires Jarvis. No password is supplied or migration run.
		const archive = f.command("jarvis-archive", "encryption on --confirm-sensitive --confirm-stopped");
		await until(() => f.starts.length === 1 && isArchiveSecretPromptActive());
		await jarvis; const secretFactory = f.starts.shift()!;
		if (phase !== "preparation") { secretFactory(); await until(() => f.active?.component instanceof ArchiveSecretInput); }
		if (phase === "cancel-only sink") { revokeArchiveSecretPrompt(); await archive; assert.equal(isArchiveSecretPromptActive(), true); }
		const sink = f.active; let obsoleteDone = 0; f.onDone = () => { obsoleteDone++; };
		f.permitLateFactory = true; obsoleteFactory(); f.permitLateFactory = false; await tick();
		assert.equal(obsoleteDone, 0); assert.deepEqual(f.dialogs.at(-1)!.component.render(110), []);
		if (sink) { assert.equal(f.active, sink); assert.equal(f.publicHost!.getFocusedComponent(), sink.component); }
		else { assert.equal(f.active, undefined); secretFactory(); await until(() => f.active?.component instanceof ArchiveSecretInput); }
		f.onDone = undefined;
		await f.command("jarvis-memory", "editor"); await f.command("jarvis"); await f.command("jarvis-model");
		assert.equal(f.publicHost!.getFocusedComponent(), f.active!.component); assert.equal(f.registryCalls, 0);
		f.stdin.process("\x1b"); await new Promise(resolve => setTimeout(resolve, 25));
		const secret = f.active!.component as ArchiveSecretInput;
		const code = secret.render(110).join("\n").match(/\b([A-HJ-NP-Z2-9]{4}) ([A-HJ-NP-Z2-9]{4}) ([A-HJ-NP-Z2-9]{4})\b/);
		assert.ok(code); for (const char of code.slice(1).join("")) f.stdin.process(char); f.stdin.process("\r");
		await archive; await until(() => !isArchiveSecretPromptActive());
		assert.equal(f.active, undefined); assert.equal(f.publicHost!.getFocusedComponent(), f.ordinary);
	});
});

test("ordinary Jarvis handoff without its own foreground retires exactly, never pops a trusted newer public overlay", bounded, async t => {
	await isolated(t, async f => {
		const jarvis = f.command("jarvis"); await until(() => f.active?.component instanceof JarvisOverlayComponent && f.runtimes.length === 1);
		const old = f.active!, view = viewOf(old.component), takeover = new Input();
		const takeoverHandle = f.publicHost!.showOverlay(takeover); f.active = undefined; // Trusted host foreground replacement, not a custom completion.
		let oldDone = 0; f.onDone = () => { oldDone++; };
		const editor = view.sendMessage("/memory editor"); await jarvis;
		assert.equal(oldDone, 0); assert.equal(old.closed, false); assert.equal(old.component.focused, false);
		await until(() => Boolean(f.active)); f.onDone = undefined;
		await close(f); await editor;
		assert.equal(f.publicHost!.getFocusedComponent(), takeover, "editor's normal close must preserve the newer host overlay underneath");
		// The trusted external owner explicitly restores its own base focus on exit.
		takeoverHandle.hide(); f.publicHost!.setFocus(f.ordinary);
		assert.equal(f.publicHost!.getFocusedComponent(), f.ordinary);
	});
});

test("clean editor close after trusted foreground replacement hides only itself and settles without topmost completion", bounded, async t => {
	await isolated(t, async f => {
		const editor = f.command("jarvis-memory", "editor"); await until(() => Boolean(f.active));
		const old = f.active!, takeover = new Input(), takeoverHandle = f.publicHost!.showOverlay(takeover);
		let oldDone = 0; f.onDone = () => { oldDone++; };
		await f.emit("session_before_tree"); await editor;
		assert.equal(oldDone, 0); assert.equal(old.closed, false); assert.deepEqual(old.component.render(110), []);
		assert.equal(f.publicHost!.getFocusedComponent(), takeover); f.onDone = undefined; f.active = undefined;
		takeoverHandle.hide(); f.publicHost!.setFocus(f.ordinary);
		assert.equal(f.publicHost!.getFocusedComponent(), f.ordinary);
	});
});
