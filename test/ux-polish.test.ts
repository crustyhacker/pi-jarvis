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

test("multiline drafts survive close/reopen and presentation close does not revoke view-owned grants", () => {
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
	assert.ok(f.state.tools && f.state.note && f.state.redirect);
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

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const F2 = "\x1bOQ", F3 = "\x1bOR";

function selectable(f: ReturnType<typeof fixture>) {
	const models: string[] = [], thinking: string[] = [];
	f.view.getThinkingLabel = () => "auto → high";
	f.view.getModelChoices = async () => [
		{ value: "follow-main", label: "Follow main model" },
		{ value: "clear", label: "Clear project override" },
		...Array.from({ length: 40 }, (_, i) => ({ value: `fixture/model-${i}`, label: `fixture/model-${i}` })),
	];
	f.view.configureModel = async request => { models.push(request); };
	f.view.configureThinking = async request => { thinking.push(request); };
	return { models, thinking };
}

test("F2/F3 configure inside the overlay; physical, follow-main/clear and every thinking choice preserve drafts", async () => {
	const f = fixture();
	const configured = selectable(f);
	try {
		f.overlay.handleInput("  unsent\n    message");
		for (const search of ["Follow main", "Clear project", "fixture/model-39"]) {
			f.overlay.handleInput(F2);
			assert.match(plain(f.overlay.render(64)), /Loading host model/);
			await tick();
			f.overlay.handleInput(search);
			assert.match(plain(f.overlay.render(64)), /project override \(main unchanged\)/);
			f.overlay.handleInput("\r"); await tick();
			assert.equal(f.bridge.getDraft(), "  unsent\n    message");
		}
		assert.deepEqual(configured.models, ["follow-main", "clear", "fixture/model-39"]);
		for (const [search, expected] of [["auto", "auto"], ["follow-main", "follow-main"], ["off", "off"],
			["minimal", "minimal"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"], ["clear", "clear"]]) {
			f.overlay.handleInput(F3);
			f.overlay.handleInput(search);
			f.overlay.render(64); f.overlay.handleInput("\r"); await tick();
			assert.equal(configured.thinking.at(-1), expected);
		}
		assert.deepEqual(f.sent, []);
		assert.equal(f.closes(), 0);
	} finally { f.overlay.dispose(); }
});

test("selector failures and busy rejection stay visible without replacing the prompt", async () => {
	const f = fixture(); selectable(f);
	try {
		f.overlay.handleInput("  preserve draft");
		f.view.configureModel = async () => { throw new Error("Busy: wait or stop, then retry"); };
		f.overlay.handleInput(F2); await tick(); f.overlay.render(64);
		f.overlay.handleInput("\r"); await tick();
		assert.match(plain(f.overlay.render(64)), /Busy: wait or stop/);
		assert.equal(f.bridge.getDraft(), "  preserve draft");
		f.overlay.handleInput("\x1b");
		assert.match(plain(f.overlay.render(64)), /preserve draft/);
		f.view.configureThinking = async () => { f.bridge.notify("Busy: wait or stop", "warning"); };
		f.overlay.handleInput(F3); f.overlay.render(64); f.overlay.handleInput("\r"); await tick();
		assert.match(plain(f.overlay.render(64)), /Busy: wait or stop/);
		assert.equal(f.bridge.getDraft(), "  preserve draft");
		f.view.getModelChoices = async () => { throw new Error("Registry unavailable"); };
		f.overlay.handleInput(F2); await tick();
		assert.match(plain(f.overlay.render(64)), /Registry unavailable/);
	} finally { f.overlay.dispose(); }
});

test("async choices/configuration cannot resurrect a dismissed, reset or confirmation-preempted selector", async () => {
	for (const end of ["back", "close", "reset", "branch", "confirm"]) {
		const f = fixture(); const configured = selectable(f);
		let resolve!: (value: { value: string; label: string }[]) => void;
		f.view.getModelChoices = () => new Promise(done => { resolve = done; });
		try {
			f.overlay.handleInput("draft"); f.overlay.handleInput(F2);
			if (end === "back") f.overlay.handleInput("\x1b");
			if (end === "close") f.overlay.dispose();
			if (end === "reset") f.bridge.reset();
			if (end === "branch") f.bridge.resetTranscript();
			if (end === "confirm") {
				const review = f.bridge.requestConfirmation("Foreground review", "body");
				// Preemption is synchronous on bridge emission, without an input gap.
				f.bridge.resolveConfirmation(false); assert.equal(await review, false);
			}
			resolve([{ value: "fixture/late", label: "SHOULD NEVER APPEAR" }]); await tick();
			assert.doesNotMatch(plain(f.overlay.render(64)), /SHOULD NEVER APPEAR|Loading host model/);
			assert.deepEqual(configured.models, []);
		} finally { f.overlay.dispose(); }
	}
	for (const end of ["back", "close", "reset", "confirm"]) {
		const f = fixture(); selectable(f);
		let reject!: (error: Error) => void;
		f.view.configureThinking = () => new Promise((_, fail) => { reject = fail; });
		try {
			f.overlay.handleInput("draft"); f.overlay.handleInput(F3); f.overlay.render(64); f.overlay.handleInput("\r");
			if (end === "back") f.overlay.handleInput("\x1b");
			if (end === "close") f.overlay.dispose();
			if (end === "reset") f.bridge.reset();
			if (end === "confirm") { void f.bridge.requestConfirmation("Preempt", "body"); f.bridge.resolveConfirmation(false); }
			reject(new Error("STALE CONFIGURATION ERROR")); await tick();
			assert.doesNotMatch(plain(f.overlay.render(64)), /STALE CONFIGURATION ERROR|Applying project/);
			assert.equal(f.bridge.snapshot().notifications.length, 0);
		} finally { f.overlay.dispose(); }
	}
});

test("paste framing precedes F2/F3/stop and selector paste never selects, cancels, submits or toggles", async () => {
	const f = fixture(); const configured = selectable(f); let stopped = 0;
	f.view.cancelWork = async () => { stopped++; };
	try {
		f.overlay.handleInput("draft");
		f.overlay.handleInput("\x1b[20"); f.overlay.handleInput("0~");
		for (const key of [F2, F3, "\x03", "\x1b", "\t", "\r"]) f.overlay.handleInput(key);
		f.overlay.handleInput("\x1b[201~\r");
		assert.equal(stopped, 0); assert.equal(f.closes(), 0); assert.equal(f.bridge.getDraft(), "draft");
		for (const shortcut of [F2, F3]) {
			f.overlay.handleInput(shortcut); await tick(); f.overlay.render(64);
			f.overlay.handleInput("\x1b[20"); f.overlay.handleInput("0~");
			for (const key of ["y", "n", F2, F3, "\x03", "\x1b", "\t", "\r", " "]) f.overlay.handleInput(key);
			f.overlay.handleInput("\x1b[20"); f.overlay.handleInput("1~\r");
			assert.match(plain(f.overlay.render(64)), /project override/);
			assert.equal(stopped, 0); assert.equal(f.bridge.getDraft(), "draft");
			f.overlay.handleInput("\x1b");
		}
		assert.deepEqual(configured.models, []); assert.deepEqual(configured.thinking, []);
		assert.deepEqual(f.sent, []); assert.equal(f.state.tools || f.state.note || f.state.redirect, false);
		assert.equal(f.closes(), 0);
	} finally { f.overlay.dispose(); }
});

test("confirmation preempts picker and owns paste even across external cancellation", async () => {
	const f = fixture(); const configured = selectable(f);
	try {
		f.overlay.handleInput("draft"); f.overlay.handleInput(F3); f.overlay.render(64);
		f.overlay.handleInput("\x1b[200~ignored");
		const review = f.bridge.requestConfirmation("Redirect review", "Main stays unchanged unless confirmed");
		f.overlay.render(64); f.overlay.handleInput("y");
		assert.ok(f.bridge.hasPendingConfirmation());
		f.bridge.resolveConfirmation(false); assert.equal(await review, false);
		f.overlay.handleInput("\x1b[201~\r");
		assert.equal(f.bridge.getDraft(), "draft"); assert.deepEqual(f.sent, []);
		assert.deepEqual(configured.thinking, []);
		assert.doesNotMatch(plain(f.overlay.render(64)), /project override/);
	} finally { f.overlay.dispose(); }
});

test("Ctrl+C stops only outside review; Escape closes; errors preserve draft and paste never stops", async () => {
	const f = fixture(); selectable(f); let stopped = 0;
	f.view.cancelWork = async () => { stopped++; throw new Error("Stop failed"); };
	try {
		f.overlay.handleInput("draft"); f.overlay.handleInput("\x03"); await tick();
		assert.equal(stopped, 1); assert.equal(f.closes(), 0);
		assert.match(plain(f.overlay.render(64)), /Stop failed/); assert.equal(f.bridge.getDraft(), "draft");
		f.overlay.handleInput(F3); f.overlay.render(64); f.overlay.handleInput("\x03");
		assert.equal(stopped, 1); assert.doesNotMatch(plain(f.overlay.render(64)), /project override/);
		const review = f.bridge.requestConfirmation("Review", "body"); f.overlay.render(64); f.overlay.handleInput("\x03");
		assert.equal(await review, false); assert.equal(stopped, 1);
		f.overlay.handleInput("\x1b[200~\x03\x1b[201~"); assert.equal(stopped, 1);
		f.overlay.handleInput("\x1b"); assert.equal(f.closes(), 1);
	} finally { f.overlay.dispose(); }
});

test("Tab discovers Model/Thinking/History controls and focused arrows scroll without editing or recall", async () => {
	const f = fixture(undefined, history(100)); selectable(f);
	try {
		f.overlay.handleInput("draft");
		for (let i = 0; i < 4; i++) f.overlay.handleInput("\t");
		assert.match(plain(f.overlay.render(50)), /\[F2 Model/);
		f.overlay.handleInput("\r"); await tick(); assert.match(plain(f.overlay.render(50)), /project override/);
		f.overlay.handleInput("\x1b");
		for (let i = 0; i < 5; i++) f.overlay.handleInput("\t");
		assert.match(plain(f.overlay.render(50)), /\[F3 Thinking/);
		f.overlay.handleInput(" "); assert.match(plain(f.overlay.render(50)), /project override/);
		f.overlay.handleInput("\x1b");
		for (let i = 0; i < 6; i++) f.overlay.handleInput("\t");
		assert.match(plain(f.overlay.render(50)), /\[History ↑\/↓\]/);
		f.overlay.handleInput("\x1b[A");
		const reading = transcript(f.overlay.render(50));
		assert.ok(!reading.join("\n").includes("record-99"));
		f.state.entries.push({ kind: "assistant", text: "record-100" });
		assert.deepEqual(transcript(f.overlay.render(50)), reading);
		f.overlay.handleInput("\x1b[B"); f.overlay.render(50);
		f.overlay.handleInput("\x1b[1;5F"); assert.match(plain(f.overlay.render(50)), /record-100/);
		assert.equal(f.bridge.getDraft(), "draft");
	} finally { f.overlay.dispose(); }
});

test("80x24 compact UI exposes terminal-style Message prompt, all shortcuts and at least three transcript rows", () => {
	const f = fixture(undefined, history(100)); selectable(f);
	try {
		f.terminal.rows = 24;
		for (const text of ["", "one\n  two\n    three\nfour"]) {
			f.bridge.setDraft(text); // A fresh mount reflects bridge restore.
			const component = new JarvisOverlayComponent({ terminal: f.terminal, requestRender() {} } as unknown as TUI, theme, f.bridge, f.view, () => {});
			component.focused = true;
			try {
				const lines = component.render(54); const output = plain(lines);
				for (const hint of ["F2 Model", "F3 Thinking", "ctrl+c stop", "esc close", "pageUp/pageDown", "alt+↑/↓ history", "ctrl+end live", "tab controls", "jarvis >", "Prompt · Message"]) assert.ok(output.includes(hint), hint);
				assert.ok(transcript(lines).length >= 3);
				assert.ok(lines.some(line => line.includes(CURSOR_MARKER)));
				assert.ok(lines.every(line => visibleWidth(line) <= 54));
				if (text) assert.match(output, /\.\.\./);
			} finally { component.dispose(); }
		}
	} finally { f.overlay.dispose(); }
});

test("embedded picker selection stays visible after PageDown and tiny resize preserves IME cursor and draft", async () => {
	const f = fixture(); const configured = selectable(f);
	try {
		f.overlay.handleInput("中文👨‍👩‍👧‍👦\n  draft"); f.overlay.handleInput(F2); await tick();
		f.terminal.rows = 12;
		f.overlay.render(40);
		for (let i = 0; i < 7; i++) {
			f.overlay.handleInput("\x1b[6~");
			const output = plain(f.overlay.render(40));
			assert.match(output, /→ .*fixture\/model/);
		}
		for (const width of [1, 2, 3, 4, 8, 40]) {
			const lines = f.overlay.render(width);
			assert.ok(lines.length <= f.terminal.rows);
			assert.ok(lines.every(line => visibleWidth(line) <= width));
		}
		f.terminal.rows = 40; f.overlay.render(40); f.overlay.handleInput("\r"); await tick();
		assert.equal(configured.models.length, 1);
		assert.equal(f.bridge.getDraft(), "中文👨‍👩‍👧‍👦\n  draft");
	} finally { f.overlay.dispose(); }
});

test("prompt panel uses public semantic light/dark colors, a Message label and no OS-shell glyph", () => {
	const f = fixture();
	try {
		for (const appearance of ["light", "dark"]) {
			const bgRoles: string[] = [];
			const palette = {
				appearance,
				fg: (role: string, text: string) => `\x1b[${role === "accent" ? 36 : role === "text" ? 37 : 90}m${text}\x1b[39m`,
				bg: (role: string, text: string) => { bgRoles.push(role); return `\x1b[${role === "userMessageBg" ? appearance === "light" ? 47 : 40 : 49}m${text}\x1b[49m`; },
				bold: (text: string) => text,
			} as unknown as Theme;
			const overlay = new JarvisOverlayComponent({ terminal: f.terminal, requestRender() {} } as unknown as TUI, palette, f.bridge, f.view, () => {});
			overlay.focused = true;
			try {
				overlay.handleInput("one\n  two"); const lines = overlay.render(54); const output = plain(lines);
				assert.match(output, /Prompt · Message/); assert.match(output, /jarvis > one/); assert.match(output, /\.\.\.   two/);
				assert.ok(bgRoles.includes("userMessageBg") && bgRoles.includes("customMessageBg"));
				assert.ok(lines.some(line => line.includes(CURSOR_MARKER)));
				assert.ok(lines.every(line => visibleWidth(line) <= 54)); assert.ok(!output.includes("$"));
			} finally { overlay.dispose(); f.bridge.setDraft(""); }
		}
	} finally { f.overlay.dispose(); }
});

test("tiny redraw, invalidation, unfocus and resize-before-redraw cannot apply an invisible picker choice", async () => {
	for (const change of ["tiny", "zero", "invalidate", "resize", "unfocus"]) {
		const f = fixture(); const configured = selectable(f);
		try {
			f.overlay.handleInput("draft"); f.overlay.handleInput(F3); f.overlay.render(80); f.overlay.handleInput("\x1b[B");
			if (change === "tiny") { f.terminal.rows = 2; f.terminal.columns = 2; f.overlay.render(2); }
			if (change === "zero") f.overlay.render(0);
			if (change === "invalidate") f.overlay.invalidate();
			if (change === "resize") { f.terminal.rows = 2; f.terminal.columns = 2; }
			if (change === "unfocus") f.overlay.focused = false;
			f.overlay.handleInput("\r"); await tick(); assert.deepEqual(configured.thinking, [], change);
			f.terminal.rows = 40; f.terminal.columns = 100; f.overlay.focused = true; f.overlay.render(80);
			f.overlay.handleInput("\r"); await tick(); assert.deepEqual(configured.thinking, ["follow-main"], "fresh visible selection works");
			assert.equal(f.bridge.getDraft(), "draft");
		} finally { f.overlay.dispose(); }
	}
});
