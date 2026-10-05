import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings } from "@earendil-works/pi-tui";
import jarvisExtension from "../index.js";
import { JarvisModelPicker } from "../model-picker.js";
import { JarvisOverlayBridge } from "../overlay.js";
import { JarvisSideSessionRuntime } from "../side-session.js";
import { getJarvisConfigPath, saveJarvisModelSelectionSetting, saveJarvisThinkingSelectionSetting } from "../jarvis-config.js";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await tick(); }
	assert.fail("timed out waiting for test state");
}
const model = (id: string) => ({ provider: "test", id, name: id }) as any;
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as any;
const originalCreate = JarvisSideSessionRuntime.create;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const root = mkdtempSync(join(tmpdir(), "jarvis-index-regression-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
let harnessCount = 0;

class FakeRuntime {
	sent: string[] = [];
	disposed = false;
	syncs: { model: any; thinking: string | undefined }[] = [];
	gate?: ReturnType<typeof deferred<void>>;
	syncGate?: ReturnType<typeof deferred<void>>;
	aborts = 0;
	constructor(readonly options: any) {}
	isReady() { return true; }
	isStreaming() { return !!this.gate; }
	getModelLabel() { return "test/runtime"; }
	getThinkingLevel() { return "low"; }
	getRepoToolsDetailLabel() { return "local tools only"; }
	getDisplayEntries() { return []; }
	setToolAccessEnabled() {}
	addSystemMessage() {}
	describeSessionTree() { return "tree"; }
	async compactJarvisContext() {}
	async navigateSessionTree() { throw new Error("invalid tree target"); }
	async syncModel(selected: any, thinking: string | undefined) { this.syncs.push({ model: selected, thinking }); await this.syncGate?.promise; }
	async sendMessage(text: string) {
		assert.equal(this.disposed, false, "disposed runtime must never receive replacement input");
		this.sent.push(text);
		await this.gate?.promise;
	}
	async cancelWork() { this.aborts++; this.gate?.resolve(); }
	dispose() { this.disposed = true; }
}
function harness(mode = "tui") {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const commands = new Map<string, any>();
	const runtimes: FakeRuntime[] = [];
	const notices: string[] = [];
	let entries: any[] = [];
	let overlay: any;
	let customCalls = 0;
	let customOptions: any;
	const terminal = { rows: 40, columns: 100 };
	let refresh: () => Promise<void> = async () => {};
	const models = [model("main"), model("project"), model("global")];
	const ctx: any = {
		mode, hasUI: mode === "tui" || mode === "rpc", cwd: join(root, `project-${harnessCount++}`), model: models[0],
		isProjectTrusted: () => false, isIdle: () => true, hasPendingMessages: () => false,
		getSystemPrompt: () => "You are a coding assistant.", getContextUsage: () => undefined,
		sessionManager: { getBranch: () => entries, getSessionId: () => "test-main-session" },
		modelRegistry: { refresh: () => refresh(), getAvailable: () => models, find: (_: string, id: string) => models.find((m) => m.id === id) },
		ui: {
			theme, notify: (text: string) => notices.push(text),
			custom: (factory: any, options: any) => {
				customCalls++;
				customOptions = options;
				return new Promise((resolve) => {
					overlay = factory({ terminal, requestRender() {} }, theme, getKeybindings(), (value: unknown) => {
						overlay?.dispose?.(); resolve(value);
					});
				});
			},
		},
	};
	const pi: any = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool() {},
		getActiveTools: () => [],
		setActiveTools() {},
		on: (name: string, handler: any) => {
			const previous = handlers.get(name);
			handlers.set(name, async (event, context) => { await previous?.(event, context); await handler(event, context); });
		},
		getThinkingLevel: () => "high",
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendUserMessage() {},
	};
	JarvisSideSessionRuntime.create = (async (options: any) => {
		const runtime = new FakeRuntime(options); runtimes.push(runtime); return runtime;
	}) as any;
	jarvisExtension(pi);
	return {
		ctx, models, runtimes, notices,
		event: (name: string) => handlers.get(name)?.({}, ctx),
		command: (name: string, args = "") => commands.get(name).handler(args, ctx),
		get overlay() { return overlay; }, get customCalls() { return customCalls; },
		terminal, get customOptions() { return customOptions; },
		setRefresh(callback: () => Promise<void>) { refresh = callback; },
		clearBranch() { entries = []; },
	};
}

try {
	{
		const h = harness(); await h.event("session_start");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		assert.equal(typeof h.customOptions.overlayOptions, "function", "initial geometry must be calculated through Pi's public overlay options callback");
		for (const [columns, width] of [[100, 80], [400, 118], [140, 112], [54, 68], [1, 68]]) {
			h.terminal.columns = columns!;
			assert.equal(h.customOptions.overlayOptions().width, width);
		}
		assert.equal(h.customOptions.overlayOptions().maxHeight, "82%");
		assert.equal(h.customOptions.overlayOptions().anchor, "center");
		await h.event("session_shutdown"); await opened;
	}
	for (const mode of ["rpc", "json", "print"]) {
		const h = harness(mode);
		await h.event("session_start");
		await h.command("jarvis", "must not run");
		await h.command("jarvis-model");
		assert.equal(h.runtimes.length, 0);
		assert.equal(h.customCalls, 0);
		assert.ok(h.notices.some((text) => text.includes("interactive terminal")));
	}
	{
		const h = harness();
		await h.event("session_start");
		for (const initial of ["/memory off", "/jarvis-memory --project off", "/memory remember private | must not become a model prompt", "/jarvis-memory status",
			"/archive off", "/jarvis-archive status", "/archive on", "/archive search private",
			"/archive import-all", "/archive import-all --confirm-sensitive --preview stale", "/archive import-report stale", "/archive import-cancel"]) {
			const command = h.command("jarvis", initial);
			await tick();
			assert.equal(h.runtimes.length, 0, "initial memory/archive commands must not boot a side runtime");
			assert.equal(h.customCalls, 0, "initial memory/archive commands are local management, not an overlay/model prompt");
			await command;
		}
		assert.ok(h.notices.some((notice) => notice.includes("global memory settings updated")));
		await h.event("session_shutdown");
	}
	{
		const h = harness();
		await h.event("session_start");
		const oldOverlay = h.command("jarvis");
		await until(() => h.runtimes.length === 1);
		const oldRuntime = h.runtimes[0]!;
		const oldGate = deferred(); oldRuntime.gate = oldGate;
		const firstSend = h.overlay.view.sendMessage("old prompt");
		await until(() => oldRuntime.sent.length === 1);
		const oldView = h.overlay.view;
		await oldView.sendMessage("/memory --project off");
		await oldView.sendMessage("/archive off");
		assert.deepEqual(oldRuntime.sent, ["old prompt"], "memory/archive controls execute immediately without joining a busy provider queue");
		const snapshotTrust: boolean[] = [];
		h.ctx.isProjectTrusted = () => true;
		Object.assign(oldRuntime, { flushArchive: () => snapshotTrust.push(oldRuntime.options.archiveTrustProvider()) });
		h.clearBranch();
		await h.event("session_start");
		assert.deepEqual(snapshotTrust, [true], "owner snapshots before its boot generation invalidates archive trust");
		await oldOverlay;
		const newOverlay = h.command("jarvis");
		await until(() => h.runtimes.length === 2);
		const newRuntime = h.runtimes[1]!;
		const newGate = deferred(); newRuntime.gate = newGate;
		const secondSend = h.overlay.view.sendMessage("new first");
		await until(() => newRuntime.sent.length === 1);
		const thirdSend = h.overlay.view.sendMessage("new second");
		oldGate.resolve(); await firstSend;
		await oldView.sendMessage("stale view");
		newGate.resolve(); await Promise.all([secondSend, thirdSend]);
		assert.deepEqual(oldRuntime.sent, ["old prompt"]);
		assert.deepEqual(newRuntime.sent, ["new first", "new second"]);
		await h.event("session_shutdown"); await newOverlay;
	}
	{
		const h = harness(); await h.event("session_start");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		const view = h.overlay.view;
		await view.sendMessage("/tree bad-target");
		assert.ok(h.notices.length === 0); // processing errors belong to overlay bridge
		const archive = h.runtimes[0]!.options.archive;
		const cancelImports = archive.cancelImports.bind(archive);
		let importCancellations = 0;
		archive.cancelImports = () => { importCancellations++; cancelImports(); };
		const reset = view.sendMessage("/new");
		const following = view.sendMessage("after reset");
		await Promise.all([reset, following]);
		assert.equal(h.runtimes.length, 2, "one /new must create exactly one runtime");
		assert.ok(importCancellations > 0, "side /new cancels pending import previews/work before replacing its UI owner");
		assert.deepEqual(h.runtimes[1]!.sent, ["after reset"]);
		assert.equal(h.runtimes[0]!.disposed, true);
		assert.equal(h.runtimes[1]!.options.projectTrusted, false);
		await view.sendMessage("/tree --summarize");
		await view.sendMessage("still works");
		assert.deepEqual(h.runtimes[1]!.sent, ["after reset", "still works"]);
		await h.event("session_shutdown"); await opened;
	}
	{
		const h = harness();
		saveJarvisModelSelectionSetting(h.ctx.cwd, "project", { mode: "pinned", provider: "test", modelId: "project" });
		saveJarvisThinkingSelectionSetting(h.ctx.cwd, "project", { mode: "pinned", thinkingLevel: "high" });
		await h.event("session_start");
		await h.command("jarvis-model", "--global test/global");
		await h.command("jarvis-thinking", "--global low");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		assert.equal(h.runtimes[0]!.options.model.id, "project");
		assert.equal(h.runtimes[0]!.options.thinkingLevel, "high");
		await h.command("jarvis-thinking", "max");
		assert.equal(h.runtimes[0]!.syncs.at(-1)!.thinking, "max");
		await h.event("thinking_level_select");
		assert.equal(h.runtimes[0]!.syncs.at(-1)!.thinking, "max", "pinned thinking must stay pinned");
		await h.event("session_shutdown"); await opened;
	}
	{
		const h = harness();
		saveJarvisModelSelectionSetting(h.ctx.cwd, "project", { mode: "pinned", provider: "test", modelId: "project" });
		saveJarvisThinkingSelectionSetting(h.ctx.cwd, "project", { mode: "pinned", thinkingLevel: "high" });
		await h.event("session_start");
		const globalPath = getJarvisConfigPath(h.ctx.cwd, "global");
		const globalBefore = fs.readFileSync(globalPath, "utf8");
		const originalRead = fs.readFileSync;
		fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
			if (args[0] === getJarvisConfigPath(h.ctx.cwd, "project")) throw Object.assign(new Error("EACCES project config"), { code: "EACCES" });
			return (originalRead as Function)(...args);
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try {
			await h.command("jarvis-model", "--global follow-main");
			await h.command("jarvis-thinking", "--global off");
		} finally {
			fs.readFileSync = originalRead; syncBuiltinESMExports();
		}
		assert.equal(fs.readFileSync(globalPath, "utf8"), globalBefore, "read error must abort writes to the other scope");
		assert.equal(h.notices.filter((text) => text.includes("EACCES")).length, 2);
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		assert.equal(h.runtimes[0]!.options.model.id, "project");
		assert.equal(h.runtimes[0]!.options.thinkingLevel, "high");
		await h.event("session_shutdown"); await opened;
	}

	{
		const h = harness(); await h.event("session_start");
		h.models.push({ ...model("virtual"), api: "pi-virtual" });
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		const view = h.overlay.view, runtime = h.runtimes[0]!;
		const choices = await view.getModelChoices();
		assert.deepEqual(choices.map((choice: any) => choice.value), ["follow-main", "clear", "test/main", "test/project", "test/global"]);
		assert.equal(h.customCalls, 1, "embedded choices use the public registry, never a host dialog");
		await view.configureModel("test/project");
		await view.configureThinking("max");
		const projectPath = getJarvisConfigPath(h.ctx.cwd, "project");
		assert.equal(JSON.parse(fs.readFileSync(projectPath, "utf8")).modelSelection.modelId, "project");
		assert.match(view.getThinkingLabel(), /max.*effective low/, "label reports configured and SDK-clamped actual levels");
		assert.equal(h.ctx.model.id, "main", "Jarvis config never mutates the main model");
		const before = fs.readFileSync(projectPath, "utf8");
		const gate = deferred(); runtime.gate = gate;
		const sending = view.sendMessage("busy turn"); await until(() => runtime.sent.length === 1);
		for (const request of ["test/global", "follow-main", "clear"]) await view.configureModel(request);
		for (const request of ["off", "clear"]) await view.configureThinking(request);
		await h.command("jarvis-model", "--global follow-main"); await h.command("jarvis-thinking", "--global low");
		assert.equal(fs.readFileSync(projectPath, "utf8"), before, "busy choices are rejected BEFORE persistence");
		assert.ok(runtime.options.bridge.snapshot().notifications.some((notice: any) => /busy/.test(notice.message)));
		gate.resolve(); await sending; runtime.gate = undefined;
		await view.configureModel("test/disappeared");
		assert.equal(h.customCalls, 1, "stale/unknown embedded choices cannot fall back to nested host custom UI");
		await view.configureModel("clear");
		assert.ok(!JSON.parse(fs.readFileSync(projectPath, "utf8")).modelSelection, "same existing clear handler is reused");
		await h.event("session_shutdown"); await opened;
	}
	{
		// Registry refresh is an async boundary: an old embedded choice cannot
		// persist after close/reopen, even when the main/side owner is unchanged.
		const h = harness(); await h.event("session_start");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		const view = h.overlay.view, refresh = deferred(); h.setRefresh(() => refresh.promise);
		const choosing = view.configureModel("test/project");
		h.overlay.handleInput("\x1b"); await opened;
		const reopened = h.command("jarvis"); refresh.resolve(); await choosing;
		assert.equal(fs.existsSync(getJarvisConfigPath(h.ctx.cwd, "project")), false, "closed picker choice never persists after reopen");
		await view.configureThinking("high");
		assert.equal(fs.existsSync(getJarvisConfigPath(h.ctx.cwd, "project")), false, "stale view cannot configure the reopened presentation");
		await h.event("session_shutdown"); await reopened;
	}
	for (const kind of ["Model", "Thinking"] as const) {
		const h = harness(); await h.event("session_start");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		const oldRuntime = h.runtimes[0]!, sync = deferred(); oldRuntime.syncGate = sync;
		const selecting = h.overlay.view[`configure${kind}`](kind === "Model" ? "test/project" : "high");
		await until(() => oldRuntime.syncs.length === 1);
		h.clearBranch(); await h.event("session_start"); await opened;
		const reopened = h.command("jarvis"); await until(() => h.runtimes.length === 2);
		sync.resolve(); await selecting;
		assert.equal(fs.existsSync(getJarvisConfigPath(h.ctx.cwd, "project")), false, "replaced owner must never write stale config after model sync");
		const current = h.runtimes[1]!;
		assert.equal(current.syncs.length, 0, "stale rollback must not configure the new runtime");
		await h.event("session_shutdown"); await reopened;
	}

	{
		const h = harness(); await h.event("session_start");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		const refresh = deferred(); let loads = 0;
		h.setRefresh(() => ++loads === 1 ? refresh.promise : Promise.resolve());
		const older = h.overlay.view.configureModel("test/project");
		await tick();
		await h.overlay.view.configureModel("test/global");
		refresh.resolve(); await older;
		assert.equal(JSON.parse(fs.readFileSync(getJarvisConfigPath(h.ctx.cwd, "project"), "utf8")).modelSelection.modelId,
			"global", "late configuration must not overwrite a newer accepted choice in the same window");
		await h.event("session_shutdown"); await opened;
	}
	{
		const h = harness(); await h.event("session_start");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		const refresh = deferred(); let loads = 0;
		h.setRefresh(() => ++loads === 1 ? refresh.promise : Promise.resolve());
		const older = h.overlay.view.configureModel("test/project"); await tick();
		await h.overlay.view.sendMessage("/new");
		refresh.resolve(); await older;
		assert.equal(fs.existsSync(getJarvisConfigPath(h.ctx.cwd, "project")), false,
			"a same-main side reset must reject the old thread's uncommitted configuration");
		await h.overlay.view.configureModel("test/global");
		assert.equal(JSON.parse(fs.readFileSync(getJarvisConfigPath(h.ctx.cwd, "project"), "utf8")).modelSelection.modelId, "global");
		await h.event("session_shutdown"); await opened;
	}
	for (const kind of ["Model", "Thinking"] as const) {
		const h = harness(); await h.event("session_start");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		const runtime = h.runtimes[0]!, sync = deferred(); runtime.syncGate = sync;
		const first = h.overlay.view[`configure${kind}`](kind === "Model" ? "test/project" : "high");
		await until(() => runtime.syncs.length === 1);
		await h.overlay.view[`configure${kind}`](kind === "Model" ? "test/global" : "low");
		sync.resolve(); await first;
		const saved = JSON.parse(fs.readFileSync(getJarvisConfigPath(h.ctx.cwd, "project"), "utf8"));
		assert.equal(kind === "Model" ? saved.modelSelection.modelId : saved.thinkingSelection.thinkingLevel,
			kind === "Model" ? "project" : "high", "busy rejection must not supersede a valid admitted configuration");
		await h.event("session_shutdown"); await opened;
	}
	{
		const h = harness("print"); await h.event("session_start");
		const refresh = deferred(); h.setRefresh(() => refresh.promise);
		let finished = false;
		const command = h.command("jarvis-model", "test/project").then(() => { finished = true; });
		await tick(); assert.equal(finished, false);
		refresh.resolve(); await command;
		h.setRefresh(async () => { throw new Error("refresh unavailable"); });
		await h.command("jarvis-model", "test/global");
		assert.ok(h.notices.some((text) => text.includes("refresh unavailable")));
	}
	{
		let selected: string | undefined;
		const picker = new JarvisModelPicker({ terminal: { rows: 40 }, requestRender() {} } as any,
			theme, getKeybindings() as any, [model("one"), model("two")], (value) => { selected = value.id; }, () => {}, "two");
		picker.focused = true;
		assert.ok(picker.render(60).join("\n").includes("test/two"));
		picker.handleInput("\r"); assert.equal(selected, "two");
		const paging = new JarvisModelPicker({ terminal: { rows: 12 }, requestRender() {} } as any,
			theme, getKeybindings() as any, Array.from({ length: 20 }, (_, i) => model(`item-${i}`)),
			(value) => { selected = value.id; }, () => {});
		paging.focused = true; paging.render(60); // Selection requires a measured visible picker.
		paging.handleInput("\x1b[6~"); paging.handleInput("\r");
		assert.equal(selected, "item-9", "PageDown advances one visible page");
		paging.handleInput("\x1b[B"); paging.handleInput("\x1b[D"); paging.handleInput("\r");
		assert.equal(selected, "item-10", "cursor-only search keys must preserve model selection");
		paging.handleInput("\x1b[5~"); paging.handleInput("\r");
		assert.equal(selected, "item-1", "PageUp moves back one visible page");
	}
	{
		const h = harness(); await h.event("session_start");
		const opened = h.command("jarvis"); await until(() => h.runtimes.length === 1);
		h.clearBranch();
		await h.event("session_tree"); await opened;
		assert.equal(h.runtimes[0]!.disposed, true, "changing main branch reference disposes unrelated side thread");
		const reopened = h.command("jarvis"); await until(() => h.runtimes.length === 2);
		await h.event("session_shutdown"); await reopened;
	}
	{
		const bridge = new JarvisOverlayBridge();
		const oldSignal = new AbortController();
		const old = bridge.requestConfirmation("old", "old body", oldSignal.signal);
		const currentSignal = new AbortController();
		const current = bridge.requestConfirmation("new", "new body", currentSignal.signal);
		assert.equal(await old, false);
		oldSignal.abort();
		assert.equal(bridge.hasPendingConfirmation(), true, "old signal cannot dismiss replacement confirmation");
		currentSignal.abort();
		assert.equal(await current, false);
		assert.equal(bridge.hasPendingConfirmation(), false, "abort dismisses matching dialog immediately");
		assert.equal(await bridge.requestConfirmation("cancelled", "body", currentSignal.signal), false);
		assert.equal(bridge.hasPendingConfirmation(), false);
	}
	{
		const h = harness();
		const saved = { motion: process.env.PI_JARVIS_NO_ANIMATION, color: process.env.NO_COLOR, term: process.env.TERM };
		delete process.env.PI_JARVIS_NO_ANIMATION; delete process.env.NO_COLOR; process.env.TERM = "xterm-256color";
		let sessionId = "intro-first-main";
		h.ctx.sessionManager.getSessionId = () => sessionId;
		let opening: Promise<void> | undefined;
		const hasIntro = () => h.overlay.render(80).join("\n").includes("A SECOND LANE OF THOUGHT");
		try {
			await h.event("session_start");
			opening = h.command("jarvis", "greet while intro runs");
			await until(() => h.runtimes[0]?.sent.includes("greet while intro runs") === true);
			assert.equal(hasIntro(), true, "first actual TUI open shows the intro without blocking the initial prompt");
			h.overlay.handleInput("x");
			await h.overlay.view.sendMessage("/new");
			assert.equal(hasIntro(), false, "side /new never replays presentation");
			h.overlay.dispose(); await opening;
			opening = h.command("jarvis");
			assert.equal(hasIntro(), false, "reopen in the same main session skips the intro");
			await h.event("session_tree");
			assert.equal(hasIntro(), false, "tree navigation is not a first open");
			h.overlay.dispose(); await opening;
			sessionId = "intro-second-main"; h.clearBranch(); await h.event("session_start");
			opening = h.command("jarvis");
			assert.equal(hasIntro(), true, "a different main session gets its own first open");
			h.overlay.dispose(); await opening;
			sessionId = "intro-first-main"; h.clearBranch(); await h.event("session_start");
			opening = h.command("jarvis");
			assert.equal(hasIntro(), false, "returning to a seen main session does not replay");
		} finally {
			await h.event("session_shutdown"); await opening;
			for (const [key, value] of [["PI_JARVIS_NO_ANIMATION", saved.motion], ["NO_COLOR", saved.color], ["TERM", saved.term]]) {
				if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
			}
		}
	}
	console.log("index regression tests passed");
} finally {
	JarvisSideSessionRuntime.create = originalCreate;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(root, { recursive: true, force: true });
}
