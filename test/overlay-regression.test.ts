import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen,
	getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth,
	type Terminal, type TUI,
} from "@earendil-works/pi-tui";
import {
	JarvisOverlayBridge, JarvisOverlayComponent, attachOverlayBridge,
	type JarvisDisplayEntry, type JarvisOverlayView,
} from "../overlay.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

function fixture(bridge = new JarvisOverlayBridge(), keybindings = getKeybindings(), entries: JarvisDisplayEntry[] = []) {
	const terminal = { rows: 40, columns: 120 };
	let renders = 0;
	let closes = 0;
	const sent: string[] = [];
	const state = { entries, streaming: false, tools: false, followUp: false, steer: false };
	const host = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
	const view: JarvisOverlayView = {
		isReady: () => true, isStreaming: () => state.streaming,
		getModelLabel: () => "test/model", getModelModeLabel: () => "follow main",
		getMainStatusLabel: () => "idle", getMainModelLabel: () => "test/main",
		getMainFocusLabel: () => "idle", getMainDeltaLabel: () => "unchanged",
		getRepoToolsDetailLabel: () => "tools off",
		isToolAccessEnabled: () => state.tools, isFollowUpToMainEnabled: () => state.followUp,
		isSteerToMainEnabled: () => state.steer,
		toggleToolAccess: () => { state.tools = !state.tools; },
		toggleFollowUpToMain: () => { state.followUp = !state.followUp; },
		toggleSteerToMain: () => { state.steer = !state.steer; },
		getDisplayEntries: () => state.entries, sendMessage: async (text) => { sent.push(text); },
	};
	const overlay = attachOverlayBridge(new JarvisOverlayComponent(host, theme, bridge, view, () => {
		closes++;
	}, keybindings), bridge, host);
	overlay.focused = true;
	return { overlay, bridge, host, terminal, view, state, sent, renders: () => renders, closes: () => closes };
}

function assertBounds(lines: string[], width: number, rows: number) {
	assert.ok(lines.length <= rows, `height ${lines.length} > ${rows}`);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `width ${visibleWidth(line)} > ${width}`);
		assert.ok(!line.includes("\n") && !line.includes("\r"), "component lines must be single terminal lines");
	}
}

test("normal and confirmation layouts respect even tiny terminal bounds", () => {
	const f = fixture();
	f.state.entries = [{ kind: "assistant", text: "中文🙂 wide content\n".repeat(30) }];
	f.bridge.notify("long notice ".repeat(20));
	for (const rows of [0, 1, 2, 3, 4, 5, 8, 12, 40]) {
		f.terminal.rows = rows;
		for (const width of [0, 1, 2, 3, 4, 5, 8, 20, 28, 34, 80]) {
			assertBounds(f.overlay.render(width), width, rows);
			void f.bridge.requestConfirmation("中文🙂 title ".repeat(8), "message\n".repeat(100));
			assertBounds(f.overlay.render(width), width, rows);
			f.bridge.resolveConfirmation(false);
		}
	}
	f.overlay.dispose();
});

test("long confirmation requires rendering every page, including its wrapped title", async () => {
	const f = fixture();
	f.terminal.rows = 12;
	const confirmation = f.bridge.requestConfirmation("long title ".repeat(8), Array.from({ length: 60 }, (_, i) => `directive ${i}`).join("\n"));
	f.overlay.handleInput("y");
	assert.ok(f.bridge.hasPendingConfirmation(), "cannot approve before first render");
	let output = f.overlay.render(40);
	assert.ok(plain(output).includes("Review all pages"));
	f.overlay.handleInput("y");
	assert.ok(f.bridge.hasPendingConfirmation());
	// Keys without intervening renders cannot mark invisible pages as reviewed.
	for (let i = 0; i < 100; i++) f.overlay.handleInput("\x1b[6~");
	f.overlay.render(40);
	f.overlay.handleInput("y");
	assert.ok(f.bridge.hasPendingConfirmation());
	for (let i = 0; i < 100; i++) f.overlay.handleInput("\x1b[5~");
	for (let i = 0; i < 100; i++) {
		output = f.overlay.render(40);
		assertBounds(output, 40, 12);
		if (plain(output).includes("Y confirm")) break;
		f.overlay.handleInput("\x1b[6~");
	}
	assert.ok(plain(output).includes("Y confirm"));
	f.overlay.handleInput("\x1b[121u");
	assert.equal(await confirmation, true, "Kitty printable Y approves reviewed message");
	f.overlay.dispose();
});

test("resize, replacement, and invalidation cannot reuse stale approval", async () => {
	const f = fixture();
	const old = f.bridge.requestConfirmation("title", "short message");
	f.overlay.render(80);
	f.terminal.rows = 2;
	f.overlay.handleInput("y");
	assert.ok(f.bridge.hasPendingConfirmation(), "resize before redraw invalidates approval");
	f.overlay.render(80);
	f.overlay.handleInput("y");
	assert.ok(f.bridge.hasPendingConfirmation(), "tiny layouts never approve");
	f.terminal.rows = 40;
	f.overlay.render(80);
	const next = f.bridge.requestConfirmation("title", "short message");
	assert.equal(await old, false);
	f.overlay.handleInput("y");
	assert.ok(f.bridge.hasPendingConfirmation(), "identical replacement is a new review");
	f.overlay.render(80);
	f.overlay.invalidate();
	f.overlay.handleInput("y");
	assert.ok(f.bridge.hasPendingConfirmation());
	f.overlay.render(80);
	f.overlay.handleInput("\x1b[110u");
	assert.equal(await next, false, "Kitty N cancels");
	f.overlay.dispose();
});

test("confirmation swallows ordinary input and Escape cancels without closing", async () => {
	const f = fixture();
	f.overlay.handleInput("draft");
	const pending = f.bridge.requestConfirmation("title", "body");
	f.overlay.render(80);
	for (const key of ["a", "\t", "\r", " "]) f.overlay.handleInput(key);
	assert.deepEqual(f.sent, []);
	assert.equal(f.state.tools, false);
	f.overlay.handleInput("\x1b");
	assert.equal(await pending, false);
	assert.equal(f.closes(), 0);
	assert.ok(plain(f.overlay.render(80)).includes("draft"));
	f.overlay.handleInput("\x1b");
	assert.equal(f.closes(), 1);
});

test("native prompt history preserves drafts without indexing a changing transcript", () => {
	const f = fixture(undefined, undefined, [{ kind: "user", text: "first" }, { kind: "user", text: "second" }]);
	f.overlay.handleInput("draft");
	f.overlay.render(80);
	f.overlay.handleInput("\x01"); // beginning of first line enables native history
	f.overlay.handleInput("\x1b[A");
	assert.equal(f.bridge.getDraft(), "second");
	f.state.entries = [{ kind: "user", text: "replacement" }];
	f.overlay.handleInput("\x1b[A");
	assert.equal(f.bridge.getDraft(), "first", "prompt recall is independent of transcript projection");
	f.state.entries = [];
	f.overlay.handleInput("\x1b[B");
	assert.equal(f.bridge.getDraft(), "second");
	f.overlay.handleInput("\x1b[B");
	assert.equal(f.bridge.getDraft(), "draft");
	f.overlay.handleInput("\r");
	assert.deepEqual(f.sent, ["draft"]);
	f.bridge.reset();
	f.overlay.render(80);
	f.overlay.handleInput("\x1b[A");
	assert.equal(f.bridge.getDraft(), "", "new side threads cannot recall old prompts");
	f.overlay.dispose();
});

test("all key paths request redraw, invalidate input, and honor remapped actions", () => {
	const previous = getKeybindings();
	const kb = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.input.tab": "ctrl+t", "tui.input.submit": "ctrl+s", "tui.select.cancel": "ctrl+x",
		"tui.editor.historyPrevious": "ctrl+p",
	});
	setKeybindings(kb);
	const f = fixture(undefined, kb);
	try {
		for (const key of ["x", "\x14", " ", "\x1b[Z", "\x10"]) {
			const before = f.renders();
			f.overlay.handleInput(key);
			assert.ok(f.renders() > before);
		}
		assert.equal(f.state.tools, true);
		f.overlay.handleInput("\x13");
		assert.deepEqual(f.sent, ["x"]);
		f.overlay.handleInput("\x18");
		assert.equal(f.closes(), 1);
	} finally {
		f.overlay.dispose();
		setKeybindings(previous);
	}
});

test("disposal cancels confirmation, preserves view-owned grants, and is identity-safe and idempotent", async () => {
	const bridge = new JarvisOverlayBridge();
	const first = fixture(bridge);
	const second = fixture(bridge);
	second.state.tools = second.state.followUp = second.state.steer = true;
	const pending = bridge.requestConfirmation("title", "message");
	first.overlay.dispose();
	assert.equal(first.closes(), 0, "obsolete owner cannot close/reset current interaction");
	assert.ok(bridge.hasPendingConfirmation());
	const before = second.renders();
	bridge.notify("still attached");
	assert.ok(second.renders() > before);
	second.overlay.dispose();
	assert.equal(await pending, false);
	assert.equal(second.closes(), 1);
	assert.ok(second.state.tools && second.state.followUp && second.state.steer);
	second.overlay.dispose();
	second.overlay.handleInput("x");
	assert.equal(second.closes(), 1);
	assert.deepEqual(second.overlay.render(80), []);
	const after = second.renders();
	bridge.notify("detached");
	assert.equal(second.renders(), after);
});

test("C1/CSI/OSC/DCS/control payloads cannot reach transcript, labels, confirmation or input", async () => {
	const f = fixture();
	const unsafe = "visible\x9b2J text\x9d8;;hidden-url\x07label\x9d8;;\x9c\x90hidden-dcs\x9c\x1b[38:2:1:2:3mend\x00\x7f\x85\t";
	f.view.getMainFocusLabel = () => unsafe + "\nnext line";
	f.state.entries = [{ kind: "assistant", text: unsafe }];
	f.bridge.notify(unsafe);
	f.bridge.setStatus("status", unsafe);
	let lines = f.overlay.render(80);
	assertBounds(lines, 80, 40);
	assert.ok(!lines.join("").includes("hidden-url") && !lines.join("").includes("hidden-dcs"));
	assert.ok(!/[\x7f-\x9f]/.test(lines.join("")));
	assert.ok(!lines.join("").includes("\x1b[38:2"));
	const pending = f.bridge.requestConfirmation(unsafe, unsafe);
	lines = f.overlay.render(80);
	assert.ok(!/[\x7f-\x9f]/.test(lines.join("")));
	f.overlay.handleInput("n");
	assert.equal(await pending, false);
	f.overlay.handleInput(`\x1b[200~${unsafe}\x1b[201~`);
	lines = f.overlay.render(80);
	assert.ok(!lines.join("").includes("hidden-url"));
	assert.equal(f.bridge.getDraft(), "", "unsafe text must be rejected, not silently rewritten and sent");
	f.overlay.handleInput("safe");
	f.overlay.handleInput("\r");
	assert.deepEqual(f.sent, ["safe"]);
	f.overlay.dispose();
});

test("animation timers stop on disposal or when hidden by confirmation", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const f = fixture();
	f.state.streaming = true;
	f.bridge.setWorkingMessage("Thinking…");
	f.overlay.render(80);
	let before = f.renders();
	t.mock.timers.tick(160);
	assert.ok(f.renders() > before);
	void f.bridge.requestConfirmation("title", "message");
	f.overlay.render(80);
	before = f.renders();
	t.mock.timers.tick(160);
	assert.equal(f.renders(), before);
	f.bridge.resolveConfirmation(false);
	f.overlay.render(80);
	f.overlay.dispose();
	before = f.renders();
	t.mock.timers.tick(160);
	assert.equal(f.renders(), before);
});

class MemoryTerminal implements Terminal {
	rows = 40;
	columns = 100;
	kittyProtocolActive = true;
	input?: (data: string) => void;
	resize?: () => void;
	writes: string[] = [];
	start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
	stop() {}
	async drainInput() {}
	write(data: string) { this.writes.push(data); }
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	test(`${Renderer.name}: actual Pi 1 renderer routes overlay intro, input, focus, resize, and confirmation`, async () => {
		const saved = { motion: process.env.PI_JARVIS_NO_ANIMATION, color: process.env.NO_COLOR, term: process.env.TERM };
		delete process.env.PI_JARVIS_NO_ANIMATION; delete process.env.NO_COLOR; process.env.TERM = "xterm-256color";
		const terminal = new MemoryTerminal();
		const host = new Renderer(terminal);
		const f = fixture();
		const bridge = new JarvisOverlayBridge();
		let handle: ReturnType<TUI["showOverlay"]> | undefined;
		const component = attachOverlayBridge(new JarvisOverlayComponent(host, theme, bridge, f.view, () => handle?.hide(), undefined, { showIntro: true }), bridge, host);
		const baseInputs: string[] = [];
		const base = { render: () => ["base"], invalidate() {}, handleInput: (data: string) => baseInputs.push(data) };
		host.addChild(base);
		host.setFocus(base);
		host.start();
		try {
			handle = host.showOverlay(component, { width: "68%", minWidth: 68, maxHeight: "82%" });
			host.renderNow(true);
			assert.ok(component.render(68).some((line) => line.includes(CURSOR_MARKER)));
			assert.match(plain(component.render(68)), /A SECOND LANE OF THOUGHT/);
			terminal.input?.("hello");
			host.renderNow();
			assert.ok(plain(component.render(68)).includes("hello"));
			const pending = bridge.requestConfirmation("redirect?", "reviewed body");
			host.renderNow();
			terminal.input?.("\x1b[121u");
			assert.equal(await pending, true);
			terminal.columns = 20;
			terminal.rows = 6;
			terminal.resize?.();
			host.renderNow(true);
			assertBounds(component.render(20), 20, 6);
			terminal.input?.("\x1b");
			assert.deepEqual(baseInputs, []);
			assert.equal(host.hasOverlay(), false);
		} finally {
			component.dispose();
			host.stop();
			f.overlay.dispose();
			for (const [key, value] of [["PI_JARVIS_NO_ANIMATION", saved.motion], ["NO_COLOR", saved.color], ["TERM", saved.term]]) {
				if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
			}
		}
	});
}

test("short and narrow layouts expose the currently focused permission control", () => {
	const f = fixture();
	f.terminal.rows = 12;
	f.overlay.handleInput("\t");
	assert.ok(plain(f.overlay.render(28)).includes("[Repo tools"));
	f.overlay.handleInput("\t");
	assert.ok(plain(f.overlay.render(28)).includes("[Note main"));
	f.overlay.handleInput("\t");
	assert.ok(plain(f.overlay.render(28)).includes("[Redirect"));
	f.overlay.dispose();
});

test("Kitty key releases do not toggle or approve; submit failures are reported", async () => {
	const f = fixture();
	f.overlay.handleInput("\t");
	f.overlay.handleInput("\x1b[32;1:3u");
	assert.equal(f.state.tools, false);
	const pending = f.bridge.requestConfirmation("title", "body");
	f.overlay.render(80);
	f.overlay.handleInput("\x1b[121;1:3u");
	assert.ok(f.bridge.hasPendingConfirmation());
	f.overlay.handleInput("n");
	assert.equal(await pending, false);
	f.overlay.handleInput("\x1b[Z");
	f.view.sendMessage = async () => { throw new Error("send rejected"); };
	f.overlay.handleInput("message");
	f.overlay.handleInput("\r");
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(f.bridge.snapshot().notifications.some((notice) => notice.message.includes("send rejected")));
	f.view.sendMessage = () => { throw new Error("send threw"); };
	f.overlay.handleInput("message");
	f.overlay.handleInput("\r");
	assert.ok(f.bridge.snapshot().notifications.some((notice) => notice.message.includes("send threw")));
	f.overlay.dispose();
});

test("bridge confirmation admission fails closed; footer observers survive detach/reset and cannot break settlement", async () => {
	let open = false, changes = 0;
	const bridge = new JarvisOverlayBridge(() => open);
	const detachThrow = bridge.onChange(() => { throw new Error("observer failed"); });
	const detachFooter = bridge.onChange(() => { changes++; });
	assert.equal(await bridge.requestConfirmation("invisible", "reject"), false);
	assert.equal(bridge.hasPendingConfirmation(), false);
	const controller = new AbortController(); controller.abort();
	open = true;
	assert.equal(await bridge.requestConfirmation("aborted", "reject", controller.signal), false);
	const pending = bridge.requestConfirmation("visible", "review");
	bridge.detach(); bridge.setStatus("work", "background work"); bridge.notify("background update");
	assert.ok(changes >= 3);
	bridge.reset(); assert.equal(await pending, false);
	const before = changes;
	detachFooter(); detachFooter(); detachThrow(); bridge.refresh(); assert.equal(changes, before);
	assert.equal(await new JarvisOverlayBridge(() => { throw new Error("admission failed"); }).requestConfirmation("title", "body"), false);
	const standalone = new JarvisOverlayBridge(); const defaultPending = standalone.requestConfirmation("default", "body");
	assert.ok(standalone.hasPendingConfirmation()); standalone.resolveConfirmation(true); assert.equal(await defaultPending, true);
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	test(`${Renderer.name}: actual public host wheel ownership and keyboard line scrolling`, () => {
		const terminal = new MemoryTerminal();
		const host = new Renderer(terminal);
		const f = fixture(undefined, undefined, Array.from({ length: 100 }, (_, i) => ({ kind: "assistant", text: `record-${i}` })));
		const bridge = new JarvisOverlayBridge();
		const component = attachOverlayBridge(new JarvisOverlayComponent(host, theme, bridge, f.view, () => {}), bridge, host);
		host.addChild({ render: () => ["base"], invalidate() {}, handleInput() {} });
		host.start();
		let handle: ReturnType<TUI["showOverlay"]> | undefined;
		try {
			handle = host.showOverlay(component, { width: 68, maxHeight: "82%" }); host.renderNow(true);
			const bounds = handle.getBounds()!;
			const wheel = (code: number) => terminal.input?.(`\x1b[<${code};${bounds.col + 2};${bounds.row + 2}M`);
			const before = plain(component.render(68));
			wheel(64); host.renderNow();
			if (Renderer === TuiAltScreen) {
				assert.match(plain(component.render(68)), /History ·/);
				assert.doesNotMatch(plain(component.render(68)), /record-99/);
				wheel(65); host.renderNow(); assert.match(plain(component.render(68)), /Conversation · live/);
			} else assert.equal(plain(component.render(68)), before, "regular mode leaves wheel to terminal scrollback");
			terminal.input?.("draft");
			terminal.input?.("\x1b[1;3A"); host.renderNow();
			assert.match(plain(component.render(68)), /History ·/);
			assert.equal(bridge.getDraft(), "draft");
			terminal.input?.("\x1b[1;3B"); host.renderNow();
			assert.match(plain(component.render(68)), /Conversation · live/);
		} finally { component.dispose(); handle?.hide(); host.stop(); f.overlay.dispose(); }
	});
}
