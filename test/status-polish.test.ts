import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import jarvisExtension from "../index.js";
import type { JarvisDisplayEntry, JarvisOverlayBridge, JarvisOverlayView } from "../overlay.js";
import { JarvisSideSessionRuntime } from "../side-session.js";

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
type Deferred = ReturnType<typeof deferred>;
type StatusView = JarvisOverlayView & Required<Pick<JarvisOverlayView, "getQueuedMessageCount" | "getIsProcessing">>;
type Feedback = { queued: number; processing: boolean; ready: boolean; streaming: boolean };
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await tick();
	}
	assert.fail("timed out waiting for deterministic runtime state");
}
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as any;

class FakeRuntime {
	readonly sent: string[] = [];
	readonly entries: JarvisDisplayEntry[] = [{ kind: "assistant", text: "A real reply." }];
	readonly promptGates: Deferred[] = [];
	readonly toolAccess: boolean[] = [];
	disposed = false;
	aborts = 0;
	activePrompt?: Deferred;
	streaming = false;
	syncCalls = 0;
	syncGate?: Deferred;
	compactCalls = 0;
	compactGate?: Deferred;
	navigateCalls = 0;
	navigateGate?: Deferred;
	navigateError?: Error = new Error("Unknown side tree entry");
	constructor(readonly options: any) {}
	isReady() { return !this.disposed; }
	isStreaming() { return this.streaming; }
	getModelLabel() { return "test/runtime"; }
	getRepoToolsDetailLabel() { return "repo tools off"; }
	// Deliberately return the same array: view rendering must never mutate it.
	getDisplayEntries() { return this.entries; }
	setToolAccessEnabled(enabled: boolean) { this.toolAccess.push(enabled); this.options.bridge.refresh(); }
	addSystemMessage(text: string) { this.entries.push({ kind: "system", text }); this.options.bridge.refresh(); }
	describeSessionTree() { return "Side tree only"; }
	async navigateSessionTree() {
		this.navigateCalls++;
		await this.navigateGate?.promise;
		if (this.navigateError) throw this.navigateError;
	}
	async compactJarvisContext() { this.compactCalls++; await this.compactGate?.promise; }
	async syncModel() { this.syncCalls++; await this.syncGate?.promise; }
	async sendMessage(text: string) {
		assert.equal(this.disposed, false, "a disposed runtime cannot receive a replacement input");
		this.sent.push(text);
		this.entries.push({ kind: "user", text });
		this.streaming = true;
		this.options.bridge.setWorkingMessage("Thinking…");
		this.activePrompt = this.promptGates.shift();
		try { await this.activePrompt?.promise; }
		finally {
			this.activePrompt = undefined;
			this.streaming = false;
			if (!this.disposed) this.options.bridge.setWorkingMessage(undefined);
		}
	}
	async cancelWork() { this.aborts++; this.activePrompt?.resolve(); }
	// A low-level agent_end is not final settlement of the deferred prompt.
	endAgentRun() { this.streaming = false; this.options.bridge.refresh(); }
	dispose() { this.disposed = true; this.streaming = false; }
}

function harness(root: string, id: number) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const commands = new Map<string, any>();
	const runtimes: FakeRuntime[] = [];
	const hostNotices: string[] = [];
	const feedback: Feedback[] = [];
	const boots: Deferred[] = [];
	const statuses = new Map<string, string | undefined>();
	let branch: any[] = [];
	let overlay: any;
	let opened: Promise<void> | undefined;
	let onRender: (() => void) | undefined;
	const model = { provider: "test", id: "main", name: "Main" } as any;
	const ctx: any = {
		mode: "tui", hasUI: true, cwd: join(root, `project-${id}`), model,
		isProjectTrusted: () => false, isIdle: () => true, hasPendingMessages: () => false,
		getSystemPrompt: () => "Main prompt remains unchanged.", getContextUsage: () => undefined,
		sessionManager: { getBranch: () => branch, getSessionId: () => `test-main-${id}` },
		modelRegistry: { find: () => model },
		ui: {
			theme, notify: (text: string) => hostNotices.push(text),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			custom: (factory: any) => new Promise<void>((resolve) => {
				overlay = factory({ terminal: { rows: 50, columns: 120 }, requestRender() {
					if (overlay) feedback.push(snapshot(overlay.view));
					onRender?.();
				} }, theme, getKeybindings(), () => { overlay?.dispose(); resolve(); });
			}),
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
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		sendUserMessage() { assert.fail("status feedback must never deliver to the main session"); },
	};
	JarvisSideSessionRuntime.create = (async (options: any) => {
		const gate = boots.shift();
		const runtime = new FakeRuntime(options);
		runtimes.push(runtime);
		try { await gate?.promise; return runtime; }
		catch (error) { runtime.dispose(); throw error; }
	}) as any;
	jarvisExtension(pi);
	return {
		ctx, runtimes, hostNotices, feedback, statuses,
		command: (args: string) => commands.get("jarvis").handler(args, ctx),
		get view(): StatusView { return overlay.view; },
		get bridge(): JarvisOverlayBridge { return overlay.bridge; },
		get overlay() { return overlay; },
		render(): string { return overlay.render(110).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); },
		holdNextBoot() { const gate = deferred(); boots.push(gate); return gate; },
		setRenderHook(hook?: () => void) { onRender = hook; },
		clearBranch() { branch = []; },
		event: async (name: string) => { await handlers.get(name)?.({ type: name }, ctx); },
		start(args = "") { opened = commands.get("jarvis").handler(args, ctx); return opened!; },
		async stop() { onRender = undefined; await handlers.get("session_shutdown")?.({}, ctx); await opened; },
	};
}
function snapshot(view: StatusView): Feedback {
	return { queued: view.getQueuedMessageCount(), processing: view.getIsProcessing(), ready: view.isReady(), streaming: view.isStreaming() };
}
function assertFeedback(view: StatusView, queued: number, processing: boolean) {
	assert.equal(view.getQueuedMessageCount(), queued, "only waiting inputs count as queued");
	assert.equal(view.getIsProcessing(), processing, "processing follows the entire boot/flush, not just streaming");
}
function assertQueuedRendered(h: ReturnType<typeof harness>, queued: number) {
	assert.match(h.render(), new RegExp(`(?:${queued}\\s+queued|queued\\s*[:=]?\\s*${queued})`, "i"));
}

// A single parent owns the factory/environment patch; subtests execute serially.
test("truthful /jarvis queue and processing feedback", async (t) => {
	const originalCreate = JarvisSideSessionRuntime.create;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const root = mkdtempSync(join(tmpdir(), "jarvis-status-polish-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let id = 0;
	const make = () => harness(root, id++);
	try {

		await t.test("local controls never boot and footer survives ordinary close through boot/queued work", async () => {
			const h = make();
			try {
				await h.event("session_start");
				for (const control of ["status", "stop", "access off", "/status", "/jarvis stop"]) await h.command(control);
				assert.equal(h.runtimes.length, 0, "local controls never start the SDK/model or overlay");
				h.ctx.isProjectTrusted = () => true;
				const boot = h.holdNextBoot(), opening = h.start("assigned before close");
				await until(() => h.runtimes.length === 1);
				const runtime = h.runtimes[0]!, first = deferred(), second = deferred();
				runtime.promptGates.push(first, second);
				const view = h.view;
				view.toggleToolAccess(); view.toggleFollowUpToMain(); view.toggleSteerToMain();
				const waiting = view.sendMessage("queued before close");
				const confirmation = runtime.options.confirmSteerToMain("foreground review");
				assert.equal(h.bridge.hasPendingConfirmation(), true);
				h.overlay.handleInput("\x1b"); // Pending review Escape cancels it, not access.
				assert.equal(await confirmation, false);
				h.overlay.handleInput("\x1b"); await opening;
				assert.equal(view.isToolAccessEnabled(), true);
				assert.equal(view.isFollowUpToMainEnabled(), true); assert.equal(view.isSteerToMainEnabled(), true);
				assert.equal(runtime.disposed, false);
				assert.match(h.statuses.get("jarvis-background")!, /bg.*starting.*q2.*repo ON.*note ON.*redirect ASK/);
				assert.ok(h.statuses.get("jarvis-background")!.length <= 80, "all three grants precede hints in a compact 80-column main footer");
				assert.equal(await runtime.options.confirmSteerToMain("must not prompt invisibly"), false);
				assert.equal(await h.bridge.requestConfirmation("Forget memory", "closed human review"), false);
				boot.resolve(); await until(() => runtime.sent.length === 1);
				assert.match(h.statuses.get("jarvis-background")!, /bg.*working.*q1/);
				runtime.endAgentRun(); assert.match(h.statuses.get("jarvis-background")!, /working/);
				h.start(); assert.equal(h.runtimes.length, 1, "reopen reuses the same owner during active work");
				assert.equal(h.view.isToolAccessEnabled(), true);
				first.resolve(); await until(() => runtime.sent.length === 2);
				second.resolve(); await waiting;
				assert.deepEqual(runtime.sent, ["assigned before close", "queued before close"]);
				assert.match(h.statuses.get("jarvis-background")!, /idle.*repo ON/);
				await h.view.sendMessage("/access off");
				assert.equal(h.view.isToolAccessEnabled(), false); assert.equal(h.view.isFollowUpToMainEnabled(), false); assert.equal(h.view.isSteerToMainEnabled(), false);
				assert.equal(runtime.disposed, false);
			} finally { await h.stop(); }
			assert.equal(h.statuses.get("jarvis-background"), undefined, "shutdown clears the owned footer");
		});

		for (const boundary of ["boot", "sync", "prompt"] as const) {
			await t.test(`explicit stop during ${boundary} discards queued/dequeued work without disposal or replay`, async () => {
				const h = make();
				try {
					await h.event("session_start"); h.ctx.isProjectTrusted = () => true;
					const boot = boundary === "boot" ? h.holdNextBoot() : undefined;
					h.start(boundary === "boot" ? "cancel boot input" : "");
					await until(() => h.runtimes.length === 1);
					const runtime = h.runtimes[0]!;
					if (!boot) await until(() => h.view.isReady() && !h.view.getIsProcessing());
					h.view.toggleToolAccess(); h.view.toggleFollowUpToMain(); h.view.toggleSteerToMain();
					const sync = boundary === "sync" ? deferred() : undefined; runtime.syncGate = sync;
					if (boundary === "prompt") runtime.promptGates.push(deferred());
					const cancelled = h.view.sendMessage("cancel active input");
					if (boundary === "sync") await until(() => runtime.syncCalls === 1);
					if (boundary === "prompt") await until(() => runtime.sent.length === 1);
					const waiting = h.view.sendMessage("cancel waiting input");
					const stopping = h.command("stop");
					assert.equal(h.view.getQueuedMessageCount(), 0);
					await h.view.sendMessage("explicit while stopping");
					assert.ok(h.bridge.snapshot().notifications.some(item => /not queued/.test(item.message)), "new input during stop is explicitly refused, never stranded");
					boot?.resolve(); sync?.resolve();
					await stopping; await Promise.all([cancelled, waiting]);
					assertFeedback(h.view, 0, false);
					assert.deepEqual(runtime.sent, boundary === "prompt" ? ["cancel active input"] : []);
					assert.equal(runtime.aborts, 1); assert.equal(runtime.disposed, false);
					assert.equal(h.view.isToolAccessEnabled(), true); assert.equal(h.view.isFollowUpToMainEnabled(), true); assert.equal(h.view.isSteerToMainEnabled(), true);
					runtime.syncGate = undefined;
					await h.view.sendMessage("fresh explicit after stop");
					assert.equal(runtime.sent.at(-1), "fresh explicit after stop");
					assert.equal(h.runtimes.length, 1); assertFeedback(h.view, 0, false);
				} finally { await h.stop(); }
			});
		}

		await t.test("live trust denial/throw clears grants and review; restoration never revives them", async () => {
			const h = make();
			try {
				await h.event("session_start"); h.ctx.isProjectTrusted = () => true; h.start();
				await until(() => h.view.isReady() && !h.view.getIsProcessing());
				const runtime = h.runtimes[0]!;
				for (const denied of [() => false, () => { throw new Error("trust observation failed"); }]) {
					h.view.toggleToolAccess(); h.view.toggleFollowUpToMain(); h.view.toggleSteerToMain();
					const review = runtime.options.confirmSteerToMain("pending review");
					h.ctx.isProjectTrusted = denied;
					assert.deepEqual(runtime.options.communicationPermissionsProvider(), { allowFollowUpToMain: false, allowSteerToMain: false });
					assert.equal(await review, false);
					assert.equal(runtime.options.toolAccessProvider(), false);
					assert.equal(h.view.isToolAccessEnabled(), false); assert.equal(h.view.isFollowUpToMainEnabled(), false); assert.equal(h.view.isSteerToMainEnabled(), false);
					h.ctx.isProjectTrusted = () => true;
					assert.equal(runtime.options.toolAccessProvider(), false);
					assert.deepEqual(runtime.options.communicationPermissionsProvider(), { allowFollowUpToMain: false, allowSteerToMain: false });
				}
				assert.equal(runtime.disposed, false);
			} finally { await h.stop(); }
		});

		await t.test("empty boot is processing; idle renders do not append status chatter", async () => {
			const h = make();
			try {
				await h.event("session_start");
				const boot = h.holdNextBoot(); h.start();
				await until(() => h.runtimes.length === 1);
				assertFeedback(h.view, 0, true);
				assert.equal(h.view.isReady(), false);
				boot.resolve(); await until(() => h.view.isReady() && !h.view.getIsProcessing());
				assertFeedback(h.view, 0, false);
				const runtime = h.runtimes[0]!;
				for (let render = 0; render < 5; render++) {
					assert.deepEqual(h.view.getDisplayEntries(), [{ kind: "assistant", text: "A real reply." }]);
					h.render();
				}
				assert.equal(runtime.entries.length, 1);
				assert.equal(runtime.options.projectTrusted, false);
				assert.equal(runtime.options.systemPromptProvider(), "Main prompt remains unchanged.");
				assert.ok(h.feedback.some((state) => state.ready && !state.processing), "boot completion requests a render");
			} finally { await h.stop(); }
		});

		await t.test("boot queues, model sync, running, low-level end and settle show waiting counts", async () => {
			const h = make();
			try {
				await h.event("session_start");
				const boot = h.holdNextBoot(); h.start("initial question");
				await until(() => h.runtimes.length === 1);
				const runtime = h.runtimes[0]!;
				const sync = deferred(); runtime.syncGate = sync;
				const first = deferred(), second = deferred(), third = deferred();
				runtime.promptGates.push(first, second, third);
				const secondText = "second question\nkeeps its accepted line break";
				const sendSecond = h.view.sendMessage(secondText);
				assertFeedback(h.view, 2, true); assertQueuedRendered(h, 2);
				assert.equal(h.view.getDisplayEntries().filter((entry) => entry.kind === "status").length, 0);
				boot.resolve(); await until(() => runtime.syncCalls === 1);
				assertFeedback(h.view, 1, true);
				assert.equal(runtime.sent.length, 0, "dequeue precedes model sync without changing send semantics");
				assert.ok(h.feedback.some((state) => state.ready && state.queued === 1 && !state.streaming && state.processing), "dequeue requests a render before prompting");
				sync.resolve(); await until(() => runtime.sent.length === 1);
				assertFeedback(h.view, 1, true); assertQueuedRendered(h, 1);
				const beforeAddition = h.feedback.length;
				const sendThird = h.view.sendMessage("third question");
				assertFeedback(h.view, 2, true);
				assert.ok(h.feedback.slice(beforeAddition).some((state) => state.queued === 2), "queue additions request a render");
				runtime.endAgentRun();
				assert.equal(h.view.isStreaming(), false); assertFeedback(h.view, 2, true);
				assert.deepEqual(runtime.sent, ["initial question"], "agent_end must not dequeue the next request");
				first.resolve(); await until(() => runtime.sent.length === 2);
				assertFeedback(h.view, 1, true);
				second.resolve(); await until(() => runtime.sent.length === 3);
				assertFeedback(h.view, 0, true);
				third.resolve(); await Promise.all([sendSecond, sendThird]);
				assertFeedback(h.view, 0, false);
				assert.deepEqual(runtime.sent, ["initial question", secondText, "third question"]);
				assert.ok(h.feedback.some((state) => state.queued === 0 && state.processing), "active input is not queued");
				assert.ok(h.feedback.some((state) => !state.processing && state.ready), "flush completion requests a render");
			} finally { await h.stop(); }
		});

		await t.test("uncertain prompt errors are readable, consumed once and never auto-replayed", async () => {
			const h = make();
			try {
				await h.event("session_start"); h.start();
				await until(() => h.view.isReady() && !h.view.getIsProcessing());
				const runtime = h.runtimes[0]!;
				const failed = deferred(), next = deferred(); runtime.promptGates.push(failed, next);
				const sending = h.view.sendMessage("uncertain input");
				await until(() => runtime.sent.length === 1);
				const following = h.view.sendMessage("explicit next input");
				assertFeedback(h.view, 1, true);
				failed.reject(new Error("Provider disconnected")); await until(() => runtime.sent.length === 2);
				assertFeedback(h.view, 0, true);
				const errors = h.bridge.snapshot().notifications;
				assert.equal(errors.length, 1);
				assert.equal(errors[0]!.type, "error");
				assert.match(errors[0]!.message, /Provider disconnected.*Input was not retried/);
				assert.match(h.render(), /Provider disconnected/);
				for (let render = 0; render < 4; render++) h.render();
				assert.equal(h.bridge.snapshot().notifications.length, 1, "rendering is not another error event");
				next.resolve(); await Promise.all([sending, following]);
				assertFeedback(h.view, 0, false);
				await tick(); assert.deepEqual(runtime.sent, ["uncertain input", "explicit next input"]);
				assert.equal(h.hostNotices.length, 0, "side processing errors remain on the overlay bridge");
			} finally { await h.stop(); }
		});

		await t.test("startup errors clear waiting work; only a new explicit input boots again", async () => {
			const h = make();
			try {
				await h.event("session_start");
				const failedBoot = h.holdNextBoot(); h.start("not sent");
				await until(() => h.runtimes.length === 1);
				const waiting = h.view.sendMessage("also not sent");
				assertFeedback(h.view, 2, true);
				failedBoot.reject(new Error("Offline startup")); await waiting;
				assertFeedback(h.view, 0, false);
				assert.ok(h.bridge.snapshot().notifications.some((notice) => notice.type === "error" && /Offline startup.*Please submit again/.test(notice.message)));
				await tick(); assert.equal(h.runtimes.length, 1, "failed startup is not automatically retried");
				assert.deepEqual(h.runtimes[0]!.sent, []);
				await h.view.sendMessage("explicit retry");
				assert.equal(h.runtimes.length, 2);
				assert.deepEqual(h.runtimes[1]!.sent, ["explicit retry"]);
				assertFeedback(h.view, 0, false);
			} finally { await h.stop(); }
		});

		await t.test("startup failure queue-clear refresh cannot leak its error into a replacement main", async () => {
			const h = make();
			try {
				await h.event("session_start");
				const failedBoot = h.holdNextBoot(), oldOverlay = h.start("not sent");
				await until(() => h.runtimes.length === 1);
				const oldView = h.view, waiting = oldView.sendMessage("also not sent");
				let replacement: Promise<void> | undefined;
				h.setRenderHook(() => {
					if (oldView.getQueuedMessageCount() !== 0 || !oldView.getIsProcessing()) return;
					h.setRenderHook(); h.clearBranch();
					replacement = h.event("session_start");
				});
				failedBoot.reject(new Error("Old startup failed"));
				await waiting; await replacement; await oldOverlay;
				assert.ok(replacement, "main reset happens while publishing the cleared waiting queue");
				assertFeedback(oldView, 0, false);
				assert.equal(h.bridge.snapshot().notifications.length, 0, "a stale startup notification cannot repopulate reset UI");
				assert.equal(h.runtimes.length, 1);
				h.start("fresh explicit input");
				await until(() => h.view.isReady() && !h.view.getIsProcessing());
				assert.deepEqual(h.runtimes[1]!.sent, ["fresh explicit input"]);
			} finally { await h.stop(); }
		});

		await t.test("side commands process without streaming; /new preserves queued ownership and revokes permissions", async () => {
			const h = make();
			try {
				await h.event("session_start"); h.start();
				await until(() => h.view.isReady() && !h.view.getIsProcessing());
				const view = h.view, oldRuntime = h.runtimes[0]!;
				const compact = deferred(); oldRuntime.compactGate = compact;
				const compacting = view.sendMessage("/compact concise");
				await until(() => oldRuntime.compactCalls === 1);
				assertFeedback(view, 0, true); assert.equal(view.isStreaming(), false);
				compact.resolve(); await compacting; assertFeedback(view, 0, false);
				await view.sendMessage("/tree missing-entry");
				assert.match(h.bridge.snapshot().notifications.at(-1)!.message, /Unknown side tree entry.*not retried/);
				h.ctx.isProjectTrusted = () => true;
				view.toggleToolAccess(); view.toggleFollowUpToMain(); view.toggleSteerToMain();
				const oldPermissions = oldRuntime.options.communicationPermissionsProvider;
				assert.deepEqual(oldPermissions(), { allowFollowUpToMain: true, allowSteerToMain: true });
				const newBoot = h.holdNextBoot();
				const reset = view.sendMessage("/new");
				const following = view.sendMessage("after side reset");
				await until(() => h.runtimes.length === 2);
				assertFeedback(view, 1, true); assertQueuedRendered(h, 1);
				assert.equal(view.isReady(), false);
				assert.equal(oldRuntime.disposed, true);
				assert.equal(view.isToolAccessEnabled(), false);
				assert.equal(view.isFollowUpToMainEnabled(), false);
				assert.equal(view.isSteerToMainEnabled(), false);
				assert.deepEqual(oldPermissions(), { allowFollowUpToMain: false, allowSteerToMain: false });
				assert.equal(h.bridge.snapshot().notifications.length, 0, "/new clears old notices");
				const nextRuntime = h.runtimes[1]!, prompt = deferred(); nextRuntime.promptGates.push(prompt);
				newBoot.resolve(); await until(() => nextRuntime.sent.length === 1);
				assertFeedback(view, 0, true);
				prompt.resolve(); await Promise.all([reset, following]);
				assertFeedback(view, 0, false);
				assert.deepEqual(oldRuntime.sent, []);
				assert.deepEqual(nextRuntime.sent, ["after side reset"]);
				assert.equal(h.runtimes.length, 2, "a side /new is never duplicated");
				assert.equal(nextRuntime.options.projectTrusted, true);
			} finally { await h.stop(); }
		});

		await t.test("targeted side tree navigation returns to live without clearing draft/history; listing and failures do not", async () => {
			const h = make();
			try {
				await h.event("session_start"); h.start();
				await until(() => h.view.isReady() && !h.view.getIsProcessing());
				const runtime = h.runtimes[0]!;
				runtime.entries.push({ kind: "assistant", text: Array.from({ length: 100 }, (_, i) => `History line ${i}`).join("\n") });
				h.overlay.handleInput("\x1b[1;5F"); // Real scroll input dismisses the first-open decoration.
				const editor = h.overlay.input;
				editor.addToHistory("Prior accepted prompt"); editor.setText("Unsent draft stays");
				h.bridge.setDraft("Unsent draft stays");
				const thread = h.bridge.getThreadGeneration();
				let resets = 0;
				const resetTranscript = h.bridge.resetTranscript.bind(h.bridge);
				h.bridge.resetTranscript = () => { resets++; resetTranscript(); };
				h.render(); h.overlay.viewport.pageUp(); h.render();
				assert.equal(h.overlay.viewport.getStatus().following, false);
				await h.view.sendMessage("/tree"); h.render();
				assert.equal(resets, 0, "listing the tree does not replace its branch");
				assert.equal(h.overlay.viewport.getStatus().following, false);
				runtime.navigateError = undefined;
				const navigation = deferred(); runtime.navigateGate = navigation;
				const navigating = h.view.sendMessage("/tree next-entry");
				await until(() => runtime.navigateCalls === 1);
				assertFeedback(h.view, 0, true); assert.equal(resets, 0, "only fulfilled navigation resets the viewport");
				navigation.resolve(); await navigating; h.render();
				assert.equal(resets, 1);
				assert.equal(h.overlay.viewport.getStatus().following, true);
				assert.equal(h.bridge.getThreadGeneration(), thread, "navigation is not a new editor/thread lifecycle");
				assert.equal(h.overlay.input, editor);
				assert.equal(editor.getText(), "Unsent draft stays");
				assert.equal(h.bridge.getDraft(), "Unsent draft stays");
				editor.handleInput("\x1b[A"); // first Up moves to column zero
				editor.handleInput("\x1b[A"); // second Up browses native prompt history
				assert.equal(editor.getText(), "Prior accepted prompt", "prompt history survives branch navigation");
				h.overlay.viewport.pageUp(); h.render();
				assert.equal(h.overlay.viewport.getStatus().following, false);
				runtime.navigateError = new Error("Unknown side tree entry");
				await h.view.sendMessage("/tree missing-entry"); h.render();
				assert.equal(resets, 1, "failed navigation does not reset the transcript");
				assert.equal(h.overlay.viewport.getStatus().following, false);
			} finally { await h.stop(); }
		});

		await t.test("stale fulfilled side tree navigation cannot reset a new main viewport or processing", async () => {
			const h = make();
			try {
				await h.event("session_start"); const oldOverlay = h.start();
				await until(() => h.view.isReady() && !h.view.getIsProcessing());
				const oldRuntime = h.runtimes[0]!, navigation = deferred();
				oldRuntime.navigateError = undefined; oldRuntime.navigateGate = navigation;
				let resets = 0;
				const resetTranscript = h.bridge.resetTranscript.bind(h.bridge);
				h.bridge.resetTranscript = () => { resets++; resetTranscript(); };
				const navigating = h.view.sendMessage("/tree old-target");
				await until(() => oldRuntime.navigateCalls === 1);
				h.clearBranch(); await h.event("session_start"); await oldOverlay;
				const boot = h.holdNextBoot(); h.start("new active");
				await until(() => h.runtimes.length === 2);
				const nextRuntime = h.runtimes[1]!, prompt = deferred(); nextRuntime.promptGates.push(prompt);
				nextRuntime.entries.push({ kind: "assistant", text: Array.from({ length: 100 }, (_, i) => `New branch line ${i}`).join("\n") });
				boot.resolve(); await until(() => nextRuntime.sent.length === 1);
				const waiting = h.view.sendMessage("new waiting");
				h.bridge.setDraft("Fresh unsent draft");
				h.render(); h.overlay.viewport.pageUp(); h.render();
				assert.equal(h.overlay.viewport.getStatus().following, false);
				const beforeStale = resets;
				navigation.resolve(); await navigating; h.render();
				assert.equal(resets, beforeStale, "completed old navigation cannot reset the new transcript");
				assert.equal(h.overlay.viewport.getStatus().following, false);
				assert.equal(h.bridge.getDraft(), "Fresh unsent draft");
				assertFeedback(h.view, 1, true);
				assert.deepEqual(nextRuntime.sent, ["new active"]);
				prompt.resolve(); await waiting; assertFeedback(h.view, 0, false);
			} finally { await h.stop(); }
		});

		for (const resetEvent of ["session_start", "session_tree"]) {
			await t.test(`${resetEvent} isolates queues and stale prompt completion cannot unlock a new flush`, async () => {
				const h = make();
				try {
					await h.event("session_start"); const oldOverlay = h.start();
					await until(() => h.view.isReady() && !h.view.getIsProcessing());
					const oldView = h.view, oldRuntime = h.runtimes[0]!, oldPrompt = deferred();
					oldRuntime.promptGates.push(oldPrompt);
					const activeOld = oldView.sendMessage("old active");
					await until(() => oldRuntime.sent.length === 1);
					const waitingOld = oldView.sendMessage("old waiting"); assertFeedback(oldView, 1, true);
					h.clearBranch(); await h.event(resetEvent); await oldOverlay;
					assertFeedback(oldView, 0, false);
					const boot = h.holdNextBoot(); h.start("fresh active");
					await until(() => h.runtimes.length === 2);
					const newView = h.view, nextRuntime = h.runtimes[1]!, nextPrompt = deferred();
					nextRuntime.promptGates.push(nextPrompt);
					boot.resolve(); await until(() => nextRuntime.sent.length === 1);
					const waitingNew = newView.sendMessage("fresh waiting"); assertFeedback(newView, 1, true);
					const beforeStaleCompletion = h.feedback.length;
					oldPrompt.reject(new Error("Stale disconnection")); await Promise.all([activeOld, waitingOld]);
					assert.equal(h.feedback.length, beforeStaleCompletion, "stale finally must not refresh or unlock the new flush");
					assertFeedback(newView, 1, true);
					assert.equal(h.bridge.snapshot().notifications.length, 0, "stale failures do not leak into the replacement");
					await oldView.sendMessage("stale view input"); assertFeedback(oldView, 0, false);
					assert.deepEqual(nextRuntime.sent, ["fresh active"], "old completion does not start parallel sends");
					nextPrompt.resolve(); await waitingNew; assertFeedback(newView, 0, false);
					assert.deepEqual(oldRuntime.sent, ["old active"]);
					assert.deepEqual(nextRuntime.sent, ["fresh active", "fresh waiting"]);
				} finally { await h.stop(); }
			});
		}

		await t.test("stale boot completion disposes only old runtime and cannot clear new processing", async () => {
			const h = make();
			try {
				await h.event("session_start");
				const oldBoot = h.holdNextBoot(), oldOverlay = h.start("old boot input");
				await until(() => h.runtimes.length === 1);
				const oldView = h.view;
				const oldWaiting = oldView.sendMessage("old boot waiting");
				h.clearBranch(); await h.event("session_start"); await oldOverlay;
				assertFeedback(oldView, 0, false);
				const nextBoot = h.holdNextBoot(); h.start("fresh boot input");
				await until(() => h.runtimes.length === 2);
				assertFeedback(h.view, 1, true);
				const beforeStaleCompletion = h.feedback.length;
				oldBoot.resolve(); await oldWaiting;
				assert.equal(h.feedback.length, beforeStaleCompletion, "stale boot must not refresh new working state");
				assert.equal(h.runtimes[0]!.disposed, true);
				assert.equal(h.runtimes[1]!.disposed, false);
				assertFeedback(h.view, 1, true);
				assert.equal(h.bridge.snapshot().workingMessage, "Starting /jarvis…");
				assert.equal(h.bridge.snapshot().notifications.length, 0);
				nextBoot.resolve(); await until(() => h.view.isReady() && !h.view.getIsProcessing());
				assertFeedback(h.view, 0, false);
				assert.deepEqual(h.runtimes[0]!.sent, []);
				assert.deepEqual(h.runtimes[1]!.sent, ["fresh boot input"]);
			} finally { await h.stop(); }
		});

		for (const transition of ["push", "dequeue"]) {
			await t.test(`main reset during ${transition} refresh cannot bootstrap or execute a stale command`, async () => {
				const h = make();
				try {
					await h.event("session_start"); const oldOverlay = h.start();
					await until(() => h.view.isReady() && !h.view.getIsProcessing());
					const oldView = h.view;
					let replacement: Promise<void> | undefined;
					h.setRenderHook(() => {
						const atTransition = transition === "push"
							? oldView.getQueuedMessageCount() === 1 && !oldView.getIsProcessing()
							: oldView.getQueuedMessageCount() === 0 && oldView.getIsProcessing();
						if (!atTransition) return;
						h.setRenderHook(); h.clearBranch();
						replacement = h.event("session_start");
					});
					await oldView.sendMessage("/new"); await replacement; await oldOverlay; await tick();
					assert.ok(replacement, "the test reset happened at the new refresh boundary");
					assertFeedback(oldView, 0, false);
					assert.equal(h.runtimes.length, 1, "a stale input cannot create a hidden side runtime");
					h.start("fresh explicit input");
					await until(() => h.view.isReady() && !h.view.getIsProcessing());
					assert.equal(h.runtimes.length, 2);
					assert.deepEqual(h.runtimes[1]!.sent, ["fresh explicit input"]);
				} finally { await h.stop(); }
			});
		}

		await t.test("refresh reentry shares the published flush and sends each accepted input once", async () => {
			const h = make();
			try {
				await h.event("session_start"); h.start();
				await until(() => h.view.isReady() && !h.view.getIsProcessing());
				let reentered: Promise<void> | undefined;
				h.setRenderHook(() => {
					if (h.view.getIsProcessing() && !reentered) {
						h.setRenderHook();
						reentered = h.view.sendMessage("reentrant input");
					}
				});
				await h.view.sendMessage("original input"); await reentered;
				assert.deepEqual(h.runtimes[0]!.sent, ["original input", "reentrant input"]);
				assertFeedback(h.view, 0, false);
				assert.equal(h.runtimes.length, 1);
			} finally { await h.stop(); }
		});
	} finally {
		JarvisSideSessionRuntime.create = originalCreate;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
