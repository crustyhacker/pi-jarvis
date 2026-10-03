import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { JarvisOverlayBridge, JarvisOverlayComponent, attachOverlayBridge, type JarvisDisplayEntry, type JarvisOverlayView } from "../overlay.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
function fixture(bridge = new JarvisOverlayBridge(), entries: JarvisDisplayEntry[] = [], ready = true) {
	const terminal = { rows: 40, columns: 100 };
	const state = { entries, ready, processing: false, streaming: false, queued: 0, tools: false, note: false, redirect: false };
	const sent: string[] = [];
	let closes = 0;
	const host = { terminal, requestRender() {} } as unknown as TUI;
	const view: JarvisOverlayView = {
		isReady: () => state.ready, isStreaming: () => state.streaming,
		getIsProcessing: () => state.processing, getQueuedMessageCount: () => state.queued,
		getModelLabel: () => "test/side", getModelModeLabel: () => "follow main",
		getMainStatusLabel: () => "busy", getMainModelLabel: () => "test/main",
		getMainFocusLabel: () => "editing", getMainDeltaLabel: () => "new request",
		getRepoToolsDetailLabel: () => "local tools only",
		isToolAccessEnabled: () => state.tools, isFollowUpToMainEnabled: () => state.note,
		isSteerToMainEnabled: () => state.redirect,
		toggleToolAccess: () => { state.tools = !state.tools; },
		toggleFollowUpToMain: () => { state.note = !state.note; },
		toggleSteerToMain: () => { state.redirect = !state.redirect; },
		getDisplayEntries: () => state.entries, sendMessage: async (text) => { sent.push(text); },
	};
	const overlay = attachOverlayBridge(new JarvisOverlayComponent(host, theme, bridge, view, () => {
		closes++;
		state.tools = state.note = state.redirect = false;
	}), bridge, host);
	overlay.focused = true;
	return { overlay, bridge, state, terminal, sent, view, closes: () => closes };
}
const history = (count: number): JarvisDisplayEntry[] => Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `record-${i}` }));

function transcript(lines: string[]): string[] {
	const text = lines.map(stripTerminalSequences);
	const start = text.findIndex((line) => line.includes("Conversation ·") || line.includes("History ·"));
	const end = text.findIndex((line) => line.includes("Message"));
	assert.ok(start >= 0 && end > start);
	return text.slice(start + 1, end);
}

test("multiline drafts survive close/reopen, but permission grants do not", () => {
	const f = fixture();
	f.overlay.handleInput("  first");
	f.overlay.handleInput("\n");
	f.overlay.handleInput("    second");
	f.overlay.handleInput("\x1b[13;2u");
	assert.equal(f.bridge.getDraft(), "  first\n    second\n");
	assert.deepEqual(f.sent, []);
	f.state.tools = f.state.note = f.state.redirect = true;
	f.overlay.handleInput("\x1b");
	assert.equal(f.closes(), 1);
	assert.equal(f.state.tools || f.state.note || f.state.redirect, false);
	const reopened = fixture(f.bridge);
	try {
		assert.ok(plain(reopened.overlay.render(80)).includes("second"));
		f.overlay.handleInput("obsolete");
		assert.equal(f.bridge.getDraft(), "  first\n    second\n");
		reopened.overlay.handleInput("\r");
		assert.deepEqual(reopened.sent, ["  first\n    second\n"]);
		assert.equal(f.bridge.getDraft(), "");
	} finally { reopened.overlay.dispose(); }
});

test("restored prompt history seeds after asynchronous startup without replacing a draft", () => {
	const f = fixture(undefined, [], false);
	try {
		f.overlay.handleInput("draft");
		f.state.entries = [{ kind: "user", text: "restored prompt" }];
		f.state.ready = true;
		f.overlay.render(80);
		assert.equal(f.bridge.getDraft(), "draft");
		f.overlay.handleInput("\x01");
		f.overlay.handleInput("\x1b[A");
		assert.equal(f.bridge.getDraft(), "restored prompt");
		f.overlay.handleInput("\x1b[B");
		assert.equal(f.bridge.getDraft(), "draft");
	} finally { f.overlay.dispose(); }
});

test("scroll pauses live following during append and PageDown/Ctrl+End resume it", () => {
	const f = fixture(undefined, history(100));
	try {
		assert.ok(plain(f.overlay.render(80)).includes("record-99"));
		f.overlay.handleInput("\x1b[5~");
		const paused = f.overlay.render(80);
		assert.ok(plain(paused).includes("History ·"));
		assert.ok(!plain(paused).includes("record-99"));
		f.state.entries.push({ kind: "assistant", text: "record-100" });
		assert.deepEqual(transcript(f.overlay.render(80)), transcript(paused));
		f.overlay.handleInput("\x1b[1;5F");
		assert.ok(plain(f.overlay.render(80)).includes("record-100"));
		f.overlay.handleInput("\x1b[5~");
		f.overlay.render(80);
		f.overlay.handleInput("\x1b[6~");
		assert.ok(plain(f.overlay.render(80)).includes("Conversation · live"));
	} finally { f.overlay.dispose(); }
});

test("branch navigation resets scroll only; a new thread clears drafts and recall", () => {
	const f = fixture(undefined, [...history(100), { kind: "user", text: "old prompt" }]);
	try {
		f.overlay.handleInput("  unsent\n    code");
		f.overlay.render(80);
		f.overlay.handleInput("\x1b[5~");
		assert.ok(plain(f.overlay.render(80)).includes("History ·"));
		f.state.entries = [{ kind: "assistant", text: "new branch" }];
		f.bridge.resetTranscript();
		assert.ok(plain(f.overlay.render(80)).includes("Conversation · live"));
		assert.equal(f.bridge.getDraft(), "  unsent\n    code");
		f.bridge.reset();
		f.overlay.render(80);
		f.overlay.handleInput("\x1b[A");
		assert.equal(f.bridge.getDraft(), "");
		assert.deepEqual(f.sent, []);
	} finally { f.overlay.dispose(); }
});

test("compact diagnostics, activity and dismissible errors do not depend on transcript tail", () => {
	const f = fixture(undefined, history(100));
	try {
		let output = plain(f.overlay.render(80));
		assert.ok(!output.includes("Since last:"));
		assert.ok(output.includes("Jarvis · Main busy · side"));
		f.overlay.handleInput("\x0f");
		output = plain(f.overlay.render(80));
		assert.ok(output.includes("Since last: new request"));
		assert.ok(output.includes("Access: local tools only"));
		f.overlay.handleInput("\x1b[5~");
		f.state.ready = false;
		f.state.processing = true;
		f.state.queued = 2;
		output = plain(f.overlay.render(80));
		assert.ok(output.includes("Starting Jarvis…") && output.includes("2 queued"));
		f.state.ready = f.state.streaming = true;
		f.bridge.setWorkingMessage("Thinking…");
		output = plain(f.overlay.render(80));
		assert.ok(output.includes("Working…") && output.includes("2 queued"));
		assert.ok(output.includes("History ·"));
		f.state.streaming = false;
		assert.ok(plain(f.overlay.render(80)).includes("Processing…"));
		f.state.processing = false;
		f.state.queued = 0;
		f.bridge.setWorkingMessage(undefined);
		f.bridge.notify("request failed", "error");
		f.overlay.handleInput("draft");
		output = plain(f.overlay.render(80));
		assert.ok(output.includes("Ready") && output.includes("Error: request failed"));
		f.overlay.handleInput("\x0c");
		assert.ok(!plain(f.overlay.render(80)).includes("request failed"));
		assert.equal(f.bridge.getDraft(), "draft");
	} finally { f.overlay.dispose(); }
});

test("chunked paste never activates overlay shortcuts or permission controls", () => {
	const f = fixture();
	try {
		f.overlay.handleInput("\t"); // permission focused
		f.overlay.handleInput("\x1b[200~");
		for (const packet of ["first", "\t", "second", "\r", "third"]) f.overlay.handleInput(packet);
		f.overlay.handleInput("\x1b[201~");
		assert.equal(f.state.tools || f.state.note || f.state.redirect, false);
		assert.equal(f.bridge.getDraft(), "first    second\nthird");
		assert.deepEqual(f.sent, []);
		f.overlay.handleInput("\x1b[200~");
		for (const key of ["\x1b", "\x0f", "\x0c", "\x1b[5~"]) f.overlay.handleInput(key);
		f.overlay.handleInput("\x1b[201~");
		assert.equal(f.closes(), 0);
		assert.equal(f.bridge.getDraft(), "first    second\nthird", "reject entire unsafe paste");
		assert.ok(!plain(f.overlay.render(80)).includes("Since last:"));
	} finally { f.overlay.dispose(); }
});

test("confirmation owns paste input, even if it is cancelled halfway through", async () => {
	const f = fixture();
	try {
		f.overlay.handleInput("draft");
		const pending = f.bridge.requestConfirmation("Redirect", "do not approve pasted keys");
		f.overlay.render(80);
		f.overlay.handleInput("\x1b[200~");
		for (const key of ["y", "n", "\t", "\x1b", "\r"]) f.overlay.handleInput(key);
		assert.ok(f.bridge.hasPendingConfirmation());
		f.bridge.resolveConfirmation(false);
		assert.equal(await pending, false);
		f.overlay.handleInput("discard me");
		f.overlay.handleInput("\x1b[201~\r");
		assert.equal(f.bridge.getDraft(), "draft");
		assert.deepEqual(f.sent, []);
		assert.equal(f.closes(), 0);
	} finally { f.overlay.dispose(); }
});

test("thread reset during paste drains old framing without replaying permission or submit keys", () => {
	const f = fixture();
	try {
		f.overlay.handleInput("\x1b[200~old draft");
		f.bridge.reset();
		f.overlay.render(80);
		for (const key of ["\t", "\r", "\x1b", "\x0f", "new thread must not see this"]) f.overlay.handleInput(key);
		f.overlay.handleInput("\x1b[201~");
		assert.equal(f.bridge.getDraft(), "");
		assert.deepEqual(f.sent, []);
		assert.equal(f.state.tools || f.state.note || f.state.redirect, false);
		assert.equal(f.closes(), 0);
		f.overlay.handleInput("fresh");
		assert.equal(f.bridge.getDraft(), "fresh");
	} finally { f.overlay.dispose(); }
});

test("bounded scrollback marks omitted history and does not mutate source entries", () => {
	const entries = history(510);
	const f = fixture(undefined, entries);
	try {
		f.overlay.render(80);
		for (let i = 0; i < 100; i++) f.overlay.handleInput("\x1b[5~");
		const output = plain(f.overlay.render(80));
		assert.ok(output.includes("Older content omitted"));
		assert.ok(output.includes("record-10"));
		assert.ok(!output.includes("record-0"));
		assert.equal(entries.length, 510);
		assert.equal(entries[0]!.text, "record-0");
	} finally { f.overlay.dispose(); }
});

test("bounded overlay rollover preserves the reading anchor; invalidation and empty replacement clear caches", () => {
	const f = fixture(undefined, history(510));
	try {
		f.overlay.render(80);
		f.overlay.handleInput("\x1b[5~");
		const reading = transcript(f.overlay.render(80));
		f.state.entries.push({ kind: "assistant", text: "record-510" });
		assert.deepEqual(transcript(f.overlay.render(80)), reading);
		f.overlay.invalidate();
		assert.deepEqual(transcript(f.overlay.render(80)), reading);
		f.state.entries = [];
		assert.deepEqual(transcript(f.overlay.render(80)), [], "empty input cannot reuse cached source rows");
	} finally { f.overlay.dispose(); }
});

test("multiline input keeps a cursor and terminal-column bounds through tiny resizes", () => {
	const f = fixture();
	try {
		f.overlay.handleInput("中文🙂\n  indented\nlast");
		for (const rows of [1, 2, 3, 5, 8, 12, 20, 40]) {
			f.terminal.rows = rows;
			for (const width of [1, 2, 3, 4, 5, 8, 20, 40, 80]) {
				const lines = f.overlay.render(width);
				assert.ok(lines.length <= rows);
				assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)), `cursor missing at ${width}x${rows}`);
				for (const line of lines) assert.ok(visibleWidth(line) <= width);
			}
		}
		assert.equal(f.bridge.getDraft(), "中文🙂\n  indented\nlast");
	} finally { f.overlay.dispose(); }
});
