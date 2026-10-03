import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings,
	stripTerminalSequences, visibleWidth, type TUI,
} from "@earendil-works/pi-tui";
import { JarvisDraftEditor, MAX_DRAFT_BYTES } from "../draft-editor.js";

const theme = { fg: (_: string, text: string) => text } as Theme;
const UP = "\x1b[A", DOWN = "\x1b[B", LEFT = "\x1b[D", RIGHT = "\x1b[C";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

function fixture(initialText = "") {
	const terminal = { rows: 40, columns: 120 };
	let renders = 0;
	const host = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
	const changes: string[] = [], submits: string[] = [], errors: string[] = [];
	const editor = new JarvisDraftEditor(host, theme, {
		onChange: (text) => changes.push(text), onSubmit: (text) => submits.push(text),
		onError: (message) => errors.push(message),
	}, initialText);
	editor.focused = true;
	return { editor, changes, submits, errors, terminal, renders: () => renders };
}

function assertBounds(lines: string[], width: number, height: number, focused: boolean) {
	assert.ok(lines.length <= height, `height ${lines.length} > ${height}`);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `width ${visibleWidth(line)} > ${width}`);
		assert.ok(!/[\r\n\t]/.test(line), "one terminal line per rendered row, with normalized tabs");
	}
	const cursors = lines.reduce((sum, line) => sum + line.split(CURSOR_MARKER).length - 1, 0);
	assert.equal(cursors, focused && width > 0 && height > 0 ? 1 : 0, "exactly one visible focused cursor");
}

test("keyboard edits preserve multiline indentation and submit the full untrimmed draft", () => {
	const f = fixture();
	f.editor.handleInput("  first");
	f.editor.handleInput("\x1b[13;2u"); // Kitty Shift+Enter
	f.editor.handleInput("    second");
	f.editor.handleInput("\n"); // Ctrl+J
	f.editor.handleInput("last  ");
	const expected = "  first\n    second\nlast  ";
	assert.equal(f.editor.getText(), expected);
	assert.equal(f.changes.at(-1), expected);
	assert.deepEqual(f.submits, []);
	f.editor.handleInput("\r");
	assert.deepEqual(f.submits, [expected]);
	assert.equal(f.editor.getText(), "");
	assert.equal(f.changes.at(-1), "", "submission publishes the cleared draft");
	assert.deepEqual(f.errors, []);
	assert.ok(f.renders() > 0);
});

test("restore is silent and Pi normalizes CRLF, bare CR, and tabs without flattening", () => {
	const f = fixture("\talpha\r\n  beta\rgamma\n");
	assert.equal(f.editor.getText(), "    alpha\n  beta\ngamma\n");
	assert.deepEqual(f.changes, []);
	f.editor.setText("\n\tnew\r\n\t\tline\n");
	assert.equal(f.editor.getText(), "\n    new\n        line\n");
	assert.deepEqual(f.changes, [], "bridge restoration is not a user edit");
	f.editor.handleInput("\r");
	assert.deepEqual(f.submits, ["\n    new\n        line\n"]);
	assert.deepEqual(f.changes, [""]);
});

test("unframed bulk input inserts all lines, including leading newline, through public Pi insertion", () => {
	const f = fixture("before");
	f.editor.handleInput("\r\n\tline\nend");
	assert.equal(f.editor.getText(), "before\n    line\nend");
	assert.deepEqual(f.submits, []);
	assert.deepEqual(f.changes, ["before\n    line\nend"]);
});

test("bracketed paste supports split framing and payload without submitting embedded returns", () => {
	const f = fixture("prefix");
	f.editor.handleInput("\x1b[20");
	f.editor.handleInput("0~\r");
	f.editor.handleInput("\n\tfirst\n  second\n");
	assert.equal(f.editor.getText(), "prefix", "incomplete paste never mutates or publishes a partial draft");
	assert.deepEqual(f.changes, []);
	f.editor.handleInput("\x1b[20");
	f.editor.handleInput("1~");
	assert.equal(f.editor.getText(), "prefix\n    first\n  second\n");
	assert.deepEqual(f.changes, ["prefix\n    first\n  second\n"]);
	assert.deepEqual(f.submits, []);
	f.editor.handleInput("\r");
	assert.deepEqual(f.submits, ["prefix\n    first\n  second\n"]);
});

test("large paste content and literal paste markers never collide or recursively expand", () => {
	const f = fixture();
	const first = Array.from({ length: 25 }, (_, index) => `  row ${index}: [paste #2 +20 lines]`).join("\n") + "\n";
	const second = `literal [paste #1 1200 chars]\n${"中文🙂 ".repeat(300)}\n`;
	f.editor.handleInput(paste(first));
	assert.equal(f.editor.getText(), first);
	f.editor.handleInput(paste(second));
	assert.equal(f.editor.getText(), first + second, "send/persistence sees all content, not a display marker");
	assert.equal(f.changes.at(-1), first + second);
	f.editor.handleInput("\r");
	assert.deepEqual(f.submits, [first + second]);
	// Replacing after submit cannot retain an old marker registry.
	f.editor.setText("[paste #1 +25 lines]");
	assert.equal(f.editor.getText(), "[paste #1 +25 lines]");
	assert.deepEqual(f.errors, []);
});

test("paste insertion at a multiline cursor preserves existing content and indentation", () => {
	const f = fixture("top\n  middle\nbottom");
	f.editor.render(80, 4);
	f.editor.handleInput(UP);
	f.editor.handleInput("\x01"); // Ctrl+A
	f.editor.handleInput(RIGHT);
	f.editor.handleInput(RIGHT);
	f.editor.handleInput(paste("A\r\n\tB"));
	assert.equal(f.editor.getText(), "top\n  A\n    Bmiddle\nbottom");
	assert.deepEqual(f.submits, []);
});

test("all viewports retain the cursor and respect wide/narrow bounds without editor borders", () => {
	const f = fixture(Array.from({ length: 30 }, (_, index) => `中文🙂 e\u0301 ${index}\tvalue`).join("\n"));
	for (const rows of [0, 1, 2, 4, 40]) {
		f.terminal.rows = rows;
		for (const width of [0, 1, 2, 3, 4, 5, 8, 20, 80]) {
			for (const height of [0, 1, 2, 3, 4, 8]) {
				const lines = f.editor.render(width, height);
				assertBounds(lines, width, height, true);
				assert.ok(!plain(lines).includes("─"), "wrapper content has no duplicate horizontal borders");
			}
		}
	}
	// Cursor inside a wide character, not just at the end of a line.
	f.editor.setText("中文🙂");
	f.editor.handleInput(LEFT);
	for (const width of [1, 2, 3, 4]) {
		const lines = f.editor.render(width, 1);
		assertBounds(lines, width, 1, true);
		assert.ok(lines[0].includes("\x1b[7m"), "one-cell cropping retains a visible fake cursor");
	}
	assert.equal(f.editor.getText(), "中文🙂", "rendering never changes the stored draft");
});

test("cursor-focused crop follows navigation through a long draft and resizes", () => {
	const f = fixture(Array.from({ length: 24 }, (_, index) => `row-${index.toString().padStart(2, "0")}`).join("\n"));
	for (let row = 23; row >= 0; row--) {
		const lines = f.editor.render(20, 1);
		assertBounds(lines, 20, 1, true);
		assert.ok(plain(lines).includes(`row-${row.toString().padStart(2, "0")}`));
		f.editor.handleInput(UP);
	}
	for (const height of [1, 2, 4, 1]) assertBounds(f.editor.render(4, height), 4, height, true);
});

test("focus is propagated and invalidation/disposal have no dangling cursor or user callbacks", () => {
	const f = fixture("draft");
	assertBounds(f.editor.render(10, 1), 10, 1, true);
	f.editor.focused = false;
	assertBounds(f.editor.render(10, 1), 10, 1, false);
	f.editor.focused = true;
	f.editor.invalidate();
	assertBounds(f.editor.render(10, 1), 10, 1, true);
	assert.deepEqual(f.changes, []);
	f.editor.dispose();
	f.editor.dispose();
	f.editor.focused = true;
	f.editor.handleInput("ignored");
	f.editor.setText("ignored");
	assert.equal(f.editor.focused, false);
	assert.deepEqual(f.editor.render(10, 1), []);
	assert.equal(f.editor.getText(), "draft");
	assert.deepEqual(f.changes, []);
});

test("native history Up/Down navigate multiline draft before browsing and restore the captured draft", () => {
	const f = fixture("draft-one\n  draft-two\ndraft-three");
	f.editor.addToHistory("old-one\n  old-two");
	f.editor.addToHistory("new-one\n  new-two");
	assert.deepEqual(f.changes, []);
	f.editor.render(80, 4);
	f.editor.handleInput(UP);
	f.editor.handleInput(UP);
	assert.equal(f.editor.getText(), "draft-one\n  draft-two\ndraft-three");
	assert.deepEqual(f.changes, [], "vertical cursor motion is not history replacement");
	f.editor.handleInput(UP); // first visual line: move to column zero
	assert.equal(f.editor.getText(), "draft-one\n  draft-two\ndraft-three");
	f.editor.handleInput(UP); // browse newest, cursor at first line
	assert.equal(f.editor.getText(), "new-one\n  new-two");
	f.editor.handleInput(DOWN); // navigate the multiline history entry
	assert.equal(f.editor.getText(), "new-one\n  new-two");
	f.editor.handleInput(DOWN); // restore draft captured before browsing
	assert.equal(f.editor.getText(), "draft-one\n  draft-two\ndraft-three");
	assert.equal(f.changes.at(-1), f.editor.getText());
});

test("successful submit does not auto-add history; explicit addToHistory uses native deduplication", () => {
	const f = fixture("first\n  second");
	f.editor.handleInput("\r");
	f.editor.handleInput(UP);
	assert.equal(f.editor.getText(), "", "coordinator owns adding successfully submitted messages");
	f.editor.addToHistory(f.submits[0]);
	f.editor.addToHistory(f.submits[0]);
	f.editor.handleInput(UP);
	assert.equal(f.editor.getText(), "first\n  second");
	f.editor.handleInput(UP); // no older duplicate
	f.editor.handleInput(DOWN);
	assert.equal(f.editor.getText(), "first\n  second");
	f.editor.handleInput(DOWN);
	assert.equal(f.editor.getText(), "");
});

test("configured Pi actions and Kitty releases/printables use native key handling", () => {
	const previous = getKeybindings();
	try {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.newLine": "ctrl+n", "tui.input.submit": "ctrl+s",
			"tui.editor.historyPrevious": "alt+p", "tui.editor.historyNext": "alt+n",
			"tui.editor.undo": "ctrl+z",
		}));
		const f = fixture();
		f.editor.handleInput("\x1b[97u"); // Kitty a
		f.editor.handleInput("\x1b[98;1:3u"); // Kitty release must not insert b
		assert.equal(f.editor.getText(), "a");
		f.editor.handleInput("\x0e"); // configured Ctrl+N
		f.editor.handleInput("  b");
		f.editor.handleInput("\x13"); // configured Ctrl+S
		assert.deepEqual(f.submits, ["a\n  b"]);
		f.editor.addToHistory("history-one\n  history-two");
		f.editor.setText("saved-draft");
		f.editor.handleInput("\x1bp");
		assert.equal(f.editor.getText(), "history-one\n  history-two");
		f.editor.handleInput("\x1bn");
		assert.equal(f.editor.getText(), "saved-draft");
		f.editor.setText("");
		f.editor.handleInput(paste("one\n  two"));
		f.editor.handleInput("\x1a");
		assert.equal(f.editor.getText(), "", "paste is one atomic native undo unit");
	} finally { setKeybindings(previous); }
});

test("xterm modifyOtherKeys printable packets are decoded by Pi without leaking escape tails", () => {
	const f = fixture();
	f.editor.handleInput("\x1b[27;1;97~");
	f.editor.handleInput("\x1b[27;2;65~");
	f.editor.handleInput("\x1b[27;2;32~");
	assert.equal(f.editor.getText(), "aA ");
	assert.equal(f.changes.at(-1), "aA ");
	f.editor.handleInput("\r");
	assert.deepEqual(f.submits, ["aA "]);
	assert.deepEqual(f.errors, []);
});

test("terminal control text operations are rejected atomically and never leak into render or submit", () => {
	const f = fixture("safe");
	const malicious = [
		"bad\x00text", "bad\x07text", "bad\x7ftext", "bad\x9b31mtext",
		"\x1b[31mred\x1b[0m", "\x1b]52;c;c2VjcmV0\x07",
		`spoof ${CURSOR_MARKER}`, "\x1bPpayload\x1b\\", "\x1b]8;;https://example.invalid\x1b\\link",
	];
	for (const text of malicious) {
		f.editor.setText(text);
		f.editor.handleInput(paste(text) + "\r");
		f.editor.addToHistory(text);
		assert.equal(f.editor.getText(), "safe");
		assert.deepEqual(f.submits, [], "a rejected paste cannot submit via its trailing input packet");
		assertBounds(f.editor.render(8, 1), 8, 1, true);
	}
	assert.equal(f.errors.length, malicious.length * 3);
	assert.deepEqual(f.changes, []);
	for (const input of ["\x00", "\x1b[999~", "\x1b]52;c;xxx\x07"]) f.editor.handleInput(input);
	assert.equal(f.editor.getText(), "safe", "unknown control packets cannot leak printable sequence tails");
	f.editor.handleInput("\r");
	assert.deepEqual(f.submits, ["safe"]);
});

test("64KiB UTF-8 limit rejects entire oversize edits/pastes/restores, without truncation or submission", () => {
	const f = fixture("keep");
	const limit = "x".repeat(MAX_DRAFT_BYTES);
	f.editor.setText(limit);
	assert.equal(f.editor.getText(), limit);
	assert.deepEqual(f.changes, []);
	f.editor.handleInput("y");
	f.editor.handleInput("\n");
	f.editor.setText(limit + "z");
	f.editor.handleInput(paste("z") + "\r");
	assert.equal(f.editor.getText(), limit);
	assert.deepEqual(f.submits, []);
	assert.deepEqual(f.changes, []);
	assert.equal(f.errors.length, 4);
	assert.ok(f.errors.every((error) => error.includes("64 KiB")));
	// Expanded tabs and UTF-8 bytes, not source characters, count toward the bound.
	f.editor.setText("keep");
	f.editor.setText("\t".repeat(MAX_DRAFT_BYTES / 4 + 1));
	f.editor.handleInput(paste("中".repeat(Math.ceil(MAX_DRAFT_BYTES / 3))));
	assert.equal(f.editor.getText(), "keep");
	assert.deepEqual(f.submits, []);
	f.editor.handleInput(paste("ok\r\n\tlast"));
	assert.equal(f.editor.getText(), "keepok\n    last");
	f.editor.handleInput("\r");
	assert.deepEqual(f.submits, ["keepok\n    last"]);
});

test("overflowing streamed paste is bounded and drains safely through a split end delimiter", () => {
	const f = fixture("saved");
	f.editor.handleInput("\x1b[200~" + "x".repeat(MAX_DRAFT_BYTES));
	assert.equal(f.errors.length, 1);
	for (let index = 0; index < 20; index++) f.editor.handleInput("x".repeat(MAX_DRAFT_BYTES));
	assert.equal(f.errors.length, 1, "one explicit notice per rejected paste");
	f.editor.handleInput("\x1b[20");
	f.editor.handleInput("1~\r");
	assert.equal(f.editor.getText(), "saved");
	assert.deepEqual(f.changes, []);
	assert.deepEqual(f.submits, []);
	f.editor.handleInput("!");
	assert.equal(f.editor.getText(), "saved!");
});

test("oversize native yank is rolled back before publishing; absent error callback throws explicitly", () => {
	const f = fixture("x".repeat(MAX_DRAFT_BYTES));
	f.editor.handleInput("\x15"); // Ctrl+U: kill line into native ring
	assert.equal(f.editor.getText(), "");
	f.editor.setText("y".repeat(MAX_DRAFT_BYTES));
	const changes = f.changes.length;
	f.editor.handleInput("\x19"); // Ctrl+Y: would exceed 64KiB
	assert.equal(f.editor.getText(), "y".repeat(MAX_DRAFT_BYTES));
	assert.equal(f.changes.length, changes);
	assert.equal(f.errors.length, 1);
	assert.deepEqual(f.submits, []);
	const host = { terminal: { rows: 10, columns: 40 }, requestRender() {} } as unknown as TUI;
	const editor = new JarvisDraftEditor(host, theme, { onChange() {}, onSubmit() {} }, "safe");
	assert.throws(() => editor.setText("x".repeat(MAX_DRAFT_BYTES + 1)), /64 KiB/);
	assert.equal(editor.getText(), "safe");
	assert.throws(() => editor.setText("unsafe\x1b[31m"), /control characters/);
	assert.equal(editor.getText(), "safe");
});

test("paste pre-routing consumes chunked shortcut packets before overlay actions", () => {
	const shortcuts = ["\x1b", "\t", "\x0f", "\x1b[5~", "\x1b[6~", "\x1b[Z", "\x0c", "\r", "y", "n"];
	for (const shortcut of shortcuts) {
		const f = fixture("draft");
		const globalPackets: string[] = [];
		const route = (data: string) => {
			if (f.editor.handlePasteInput(data)) return;
			globalPackets.push(data); // Simulates parent Escape/Tab/details/page/confirm routing.
		};
		route("\x1b[200~start");
		route(shortcut);
		assert.equal(f.editor.getText(), "draft", "paste remains atomic until completed");
		route("end\x1b[201~\r");
		assert.deepEqual(globalPackets, [], `paste shortcut ${JSON.stringify(shortcut)} never reaches parent`);
		assert.deepEqual(f.submits, [], "attached Enter cannot submit even an accepted paste");
		if (["\t", "\r", "y", "n"].includes(shortcut)) {
			assert.equal(f.editor.getText(), `draftstart${shortcut === "\t" ? "    " : shortcut === "\r" ? "\n" : shortcut}end`);
			assert.equal(f.errors.length, 0);
		} else {
			assert.equal(f.editor.getText(), "draft", "unsafe paste controls reject atomically");
			assert.equal(f.errors.length, 1);
		}
	}
});

test("paste discard is sticky across confirmation cancellation and split framing", () => {
	const f = fixture("saved");
	let confirmation = true;
	let approved = 0, closed = 0, toggled = 0;
	const route = (data: string) => {
		if (f.editor.handlePasteInput(data, confirmation)) return;
		if (confirmation && data === "y") { approved++; return; }
		if (data === "\x1b") { closed++; confirmation = false; return; }
		if (data === "\x0f") { toggled++; return; }
		f.editor.handleInput(data);
	};
	route("\x1b[20"); // Prefix is already confirmation-owned/discarded.
	confirmation = false; // Confirmation cancels externally before opener is complete.
	route("0~hello");
	route("\x1b");
	route("\x0f");
	route("\t");
	confirmation = true;
	route("y");
	confirmation = false;
	route("\x1b[20");
	route("1~\ry");
	assert.equal(f.editor.getText(), "saved");
	assert.deepEqual(f.changes, []);
	assert.deepEqual(f.submits, []);
	assert.deepEqual(f.errors, [], "discarded paste is neither edited nor validated as a draft");
	assert.equal(approved + closed + toggled, 0);
	assert.equal(f.editor.handlePasteInput("plain"), false, "discard resets after paste ends");
	f.editor.handleInput(paste(" accepted"));
	assert.equal(f.editor.getText(), "saved accepted");
});

test("confirmation appearing mid-paste discards previous buffered chunks and stays sticky", () => {
	const f = fixture("saved");
	assert.equal(f.editor.handlePasteInput("\x1b[200~before"), true);
	assert.equal(f.editor.handlePasteInput("ignored", true), true);
	assert.equal(f.editor.handlePasteInput("\x1b[201~\r", false), true);
	assert.equal(f.editor.getText(), "saved");
	assert.deepEqual(f.changes, []);
	assert.deepEqual(f.submits, []);
	assert.deepEqual(f.errors, []);
});

test("paste terminator suffixes never replay submit, globals, or confirmation keys", () => {
	for (const suffix of ["\r", "\x1b[13u", "\x1b", "\t", "\x0f", "\x1b[5~", "y", "n", "extra\r"]) {
		const f = fixture("prefix");
		f.editor.handleInput(paste("  body\n") + suffix);
		assert.equal(f.editor.getText(), "prefix  body\n");
		assert.deepEqual(f.submits, []);
		assert.deepEqual(f.changes, ["prefix  body\n"]);
		f.editor.handleInput("\r"); // A separate intentional keyboard packet still submits.
		assert.deepEqual(f.submits, ["prefix  body\n"]);
	}
	const f = fixture("draft");
	assert.equal(f.editor.handlePasteInput("\r" + paste("pasted") + "\r"), true);
	assert.equal(f.editor.getText(), "draftpasted", "ambiguous prefixes in framing packets aren't keys either");
	assert.deepEqual(f.submits, []);
});

test("paste pre-routing leaves ordinary keys alone and consumes malformed opener completion", () => {
	const f = fixture("saved");
	for (const data of ["hello", "\x1b", "\t", "\x0f", "\x1b[5~", "\r", "y"]) {
		assert.equal(f.editor.handlePasteInput(data, true), false);
	}
	assert.equal(f.editor.handlePasteInput("\x1b[20", true), true);
	assert.equal(f.editor.handlePasteInput("\r"), true, "an incomplete opener cannot replay an injected submit");
	assert.equal(f.editor.getText(), "saved");
	assert.deepEqual(f.submits, []);
	assert.equal(f.editor.handlePasteInput("normal"), false);
	f.editor.dispose();
	assert.equal(f.editor.handlePasteInput(paste("ignored")), false);
});

test("empty and single-line render use one row, while real empty draft lines remain visible", () => {
	const f = fixture();
	for (const text of ["", "single line", "中文🙂", "  indented", "trailing  "]) {
		f.editor.setText(text);
		for (const height of [1, 2, 4, 5, 12]) {
			assert.equal(f.editor.render(80, height).length, 1, `compact editor for ${JSON.stringify(text)}`);
		}
		f.editor.focused = false;
		assert.equal(f.editor.render(80, 5).length, 1);
		f.editor.focused = true;
	}
	for (const text of ["one\n", "one\n\n", "\n\n", "one\n  \n"]) {
		f.editor.setText(text);
		assert.equal(f.editor.render(80, 5).length, text.split("\n").length);
		// Moving the cursor above true trailing empty lines must not hide them as filler.
		for (let row = 1; row < text.split("\n").length; row++) f.editor.handleInput(UP);
		assert.equal(f.editor.render(80, 5).length, text.split("\n").length);
		assertBounds(f.editor.render(80, 5), 80, 5, true);
		assert.equal(f.editor.getText(), text);
	}
});
