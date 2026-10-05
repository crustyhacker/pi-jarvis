import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, Input, KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS, getKeybindings,
	stripTerminalSequences, visibleWidth, type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";
import { ArchiveSecretInput, MAX_ARCHIVE_SECRET_BYTES, promptArchiveSecret, isArchiveSecretPromptActive, revokeArchiveSecretPrompt, abandonArchiveSecretPrompt } from "../archive-secret-input.js";
// Keep the public-host regressions in the existing npm test entry point without
// changing package scripts/dependencies outside this task's three-file scope.
import "./archive-secret-input-host.test.js";

// ALL strings below are synthetic fixtures. No terminal, providers, session, filesystem,
// credential store, or actual user secrets are involved in these tests.
const theme = { fg: (_: string, text: string) => text } as Theme;
const LEFT = "\x1b[D", RIGHT = "\x1b[C", DEL = "\x1b[3~";
const START = "\x1b[200~", END = "\x1b[201~";
const paste = (text: string) => START + text + END;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

function displayedCode(component: Component): string {
	const match = plain(component.render(160)).match(/\b([A-HJ-NP-Z2-9]{4} [A-HJ-NP-Z2-9]{4} [A-HJ-NP-Z2-9]{4})\b/);
	assert.ok(match, "a post-intent code must be displayed, not read through a secret getter");
	return match[1]!.replace(/ /g, "");
}
function verify(component: Component): void {
	for (const ch of displayedCode(component)) component.handleInput!(ch);
	component.handleInput!("\r");
}

function fixture(keybindings = getKeybindings(), testOptions: { challengeForTest?: () => string } = {}) {
	const terminal = { rows: 12, columns: 80 };
	let renders = 0;
	const host = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
	const results: (string | undefined)[] = [];
	const component = new ArchiveSecretInput(host, theme, keybindings, "Fixture archive unlock", (value) => results.push(value), testOptions);
	component.focused = true;
	return { component, terminal, results, renders: () => renders };
}

function bounds(component: ArchiveSecretInput, width: number, rows: number, focused: boolean) {
	const lines = component.render(width);
	assert.ok(lines.length <= rows);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width);
		assert.ok(!/[\r\n\t]/.test(line));
	}
	assert.equal(lines.reduce((sum, line) => sum + line.split(CURSOR_MARKER).length - 1, 0),
		focused && width > 0 && rows > 0 ? 1 : 0);
	return lines;
}

test("public Input receives masks only; rendering never exposes the exact synthetic secret", () => {
	const f = fixture();
	const value = "  fixture-中🙂e\u0301-👩‍💻-:3u  ";
	f.component.handleInput(value);
	const oldSet = Input.prototype.setValue, oldHandle = Input.prototype.handleInput, oldRender = Input.prototype.render;
	let calls = 0;
	try {
		Input.prototype.setValue = function (text) { assert.match(text, /^\**$/); calls++; oldSet.call(this, text); };
		Input.prototype.handleInput = function (text) {
			assert.match(text, /^\x1b\[200~\**\x1b\[201~$/);
			calls++; oldHandle.call(this, text);
		};
		Input.prototype.render = function (width) { assert.match(this.getValue(), /^\**$/); return oldRender.call(this, width); };
		for (const rows of [0, 1, 2, 3, 10]) {
			f.terminal.rows = rows;
			for (const width of [0, 1, 2, 3, 4, 8, 64]) {
				for (const focus of [true, false]) {
					f.component.focused = focus;
					const output = plain(bounds(f.component, width, rows, focus));
					assert.ok(!output.includes("fixture-"));
					assert.ok(!/[中🙂👩💻\u0301]/u.test(output));
				}
			}
		}
	} finally {
		Input.prototype.setValue = oldSet;
		Input.prototype.handleInput = oldHandle;
		Input.prototype.render = oldRender;
	}
	assert.ok(calls > 0);
	f.component.handleInput("\r");
	f.terminal.rows = 12;
	verify(f.component);
	assert.deepEqual(f.results, [value], "spaces and Unicode are returned exactly, not normalized");
	assert.deepEqual(f.component.render(80), []);
});

test("grapheme editing, middle cursor, one-cell resizing and deletion preserve Unicode", () => {
	const f = fixture();
	f.component.handleInput("A中🙂e\u0301👩‍💻Z");
	f.component.handleInput(LEFT); // before Z
	f.component.handleInput(LEFT); // before whole ZWJ grapheme
	f.component.handleInput("\x7f"); // removes e + accent as one grapheme
	f.component.handleInput(DEL); // removes whole ZWJ grapheme
	f.component.handleInput("Q");
	f.component.handleInput(RIGHT);
	for (const width of [1, 2, 3, 6, 40, 1]) {
		f.terminal.rows = 1;
		const lines = bounds(f.component, width, 1, true);
		assert.match(plain(lines), /^[* ]*$/);
		assert.ok(lines[0]!.includes("\x1b[7m"));
	}
	f.component.handleInput("\r");
	f.terminal.rows = 12;
	verify(f.component);
	assert.deepEqual(f.results, ["A中🙂QZ"]);
});

test("combining insertion merges boundaries without normalizing precomposed/decomposed data", () => {
	for (const value of ["é", "e\u0301", "  \u200d  "]) {
		const f = fixture();
		for (const ch of value) f.component.handleInput(ch);
		f.component.handleInput(LEFT);
		f.component.handleInput(RIGHT);
		f.component.handleInput("\r");
		verify(f.component);
		assert.deepEqual(f.results, [value]);
	}
});

test("unsafe bulk/paste text and empty submission reject generically, atomically, without snippets", () => {
	const invalid = ["bad\x00fixture", "bad\x07fixture", "bad\tfixture", "bad\rfixture", "bad\nfixture",
		"bad\x7ffixture", "bad\x9bfixture", "bad\u2028fixture", "bad\u2029fixture", "\ud800", "\udc00",
		"\x1b[31mfixture", "\x1b]52;c;fixture\x07", CURSOR_MARKER];
	for (const value of invalid) {
		for (const framed of [false, true]) {
			const f = fixture();
			f.component.handleInput("kept");
			f.component.handleInput(framed ? paste(value) + "\r" : value);
			assert.deepEqual(f.results, []);
			const output = plain(f.component.render(120));
			assert.ok(output.includes("Secret input rejected."));
			assert.ok(!output.includes("bad") && !output.includes("kept"));
			f.component.handleInput("\r");
			assert.deepEqual(f.results, []);
			verify(f.component);
			assert.deepEqual(f.results, ["kept"]);
		}
	}
	const f = fixture();
	f.component.handleInput("\r");
	f.component.handleInput("\n");
	f.component.handleInput("\x1b[13;2u");
	assert.deepEqual(f.results, []);
	assert.ok(plain(f.component.render(120)).includes("Secret input rejected."));
	f.component.handleInput("  ");
	f.component.handleInput("\r");
	verify(f.component);
	assert.deepEqual(f.results, ["  "], "nonempty whitespace is not silently trimmed");
});

test("4096-byte UTF-8 cap rejects entire overflow edits and pastes, with no truncation", () => {
	for (const value of ["x".repeat(MAX_ARCHIVE_SECRET_BYTES), "🙂".repeat(MAX_ARCHIVE_SECRET_BYTES / 4)]) {
		const f = fixture();
		f.component.handleInput(paste(value));
		f.component.handleInput("x");
		f.component.handleInput(paste("中") + "\r");
		assert.deepEqual(f.results, []);
		assert.ok(plain(f.component.render(120)).includes("Secret input rejected."));
		f.component.handleInput("\r");
		assert.deepEqual(f.results, []);
		verify(f.component);
		assert.deepEqual(f.results, [value]);
	}
	const f = fixture();
	f.component.handleInput("kept");
	f.component.handleInput("中".repeat(Math.ceil(MAX_ARCHIVE_SECRET_BYTES / 3)));
	f.component.handleInput("x".repeat(MAX_ARCHIVE_SECRET_BYTES + 1));
	f.component.handleInput("\r");
	verify(f.component);
	assert.deepEqual(f.results, ["kept"]);
});

test("paste is atomic across fragmented framing and split surrogate pairs; tails cannot submit", () => {
	for (let startSplit = 2; startSplit < START.length; startSplit++) {
		for (let endSplit = 1; endSplit < END.length; endSplit++) {
			const f = fixture();
			f.component.handleInput(START.slice(0, startSplit));
			f.component.handleInput(START.slice(startSplit) + "  fixture-\ud83d");
			f.component.handleInput("\ude42e\u0301  " + END.slice(0, endSplit));
			assert.ok(!plain(f.component.render(120)).includes("*"), "no partial secret is accepted");
			f.component.handleInput(END.slice(endSplit) + "\ry");
			assert.deepEqual(f.results, []);
			f.component.handleInput("\r");
			assert.deepEqual(f.results, []);
			verify(f.component);
			assert.deepEqual(f.results, ["  fixture-🙂e\u0301  "]);
		}
	}
});

test("paste consumes embedded cancel/submit/approval keys and all attached prefixes/suffixes", () => {
	for (const key of ["\r", "\n", "\x1b", "\t", "\x03", "\x1b[13u", "\x1b[201~", "y", "n"]) {
		const f = fixture();
		f.component.handleInput("kept");
		f.component.handleInput(START + "body");
		f.component.handleInput(key);
		f.component.handleInput("tail" + END + "\r");
		assert.deepEqual(f.results, []);
		f.component.handleInput("\r");
		assert.deepEqual(f.results, []);
		verify(f.component);
		assert.deepEqual(f.results, [key === "y" || key === "n" ? "keptbody" + key + "tail" :
			key === END ? "keptbody" : "kept"]);
	}
	for (const suffix of ["\r", "\x1b[13u", "\x1b", "y", "n", "more\r", START + "ignored" + END]) {
		const f = fixture();
		f.component.handleInput("\r" + paste("fixture") + suffix);
		assert.deepEqual(f.results, []);
		f.component.handleInput("\r");
		assert.deepEqual(f.results, []);
		verify(f.component);
		assert.deepEqual(f.results, ["fixture"]);
	}
});

test("streamed oversized/rejected paste stays bounded, drains split terminator and never submits", () => {
	const f = fixture();
	f.component.handleInput("kept");
	const before = f.renders();
	f.component.handleInput(START + "x".repeat(MAX_ARCHIVE_SECRET_BYTES));
	for (let i = 0; i < 30; i++) f.component.handleInput("x".repeat(MAX_ARCHIVE_SECRET_BYTES));
	assert.equal(f.renders(), before + 1, "one generic rejection while draining");
	f.component.handleInput("\x1b[20");
	f.component.handleInput("1~\r");
	assert.deepEqual(f.results, []);
	f.component.handleInput("!");
	f.component.handleInput("\r");
	assert.deepEqual(f.results, []);
	verify(f.component);
	assert.deepEqual(f.results, ["kept!"]);
	const malformed = fixture();
	malformed.component.handleInput("kept");
	malformed.component.handleInput("\x1b[20");
	malformed.component.handleInput("\r");
	assert.deepEqual(malformed.results, []);
	malformed.component.handleInput("\r");
	assert.deepEqual(malformed.results, []);
	verify(malformed.component);
	assert.deepEqual(malformed.results, ["kept"]);
});

test("configured editing/submit keys, Kitty/xterm printable and release packets are safe", () => {
	const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS, {
		"tui.input.submit": "ctrl+s", "tui.editor.deleteCharBackward": "ctrl+h",
	});
	const f = fixture(kb);
	f.component.handleInput("\x1b[97u");
	f.component.handleInput("\x1b[98;1:3u");
	f.component.handleInput("\x1b[27;2;65~");
	f.component.handleInput("\x1b[128578u");
	f.component.handleInput("\x08");
	f.component.handleInput("\x13");
	verify(f.component);
	assert.deepEqual(f.results, ["aA"]);
});

test("history, copy, undo and yank cannot recall deleted or previous interaction secrets", () => {
	const f = fixture();
	f.component.handleInput("deleted-fixture");
	f.component.handleInput("\x15"); // delete to start; no kill ring
	for (const key of ["\x19", "\x1b[Z", "\x1b[A", "\x1b[B", "\x1f"]) f.component.handleInput(key);
	f.component.handleInput("new-fixture");
	f.component.handleInput("\r");
	verify(f.component);
	assert.deepEqual(f.results, ["new-fixture"]);
	const next = fixture();
	next.component.handleInput("\x19");
	next.component.handleInput("\r");
	assert.deepEqual(next.results, []);
});

test("EVERY typed Enter/Escape/Ctrl+C intent needs a fresh code from interaction start", () => {
	for (const key of ["\r", "\x1b", "\x03"]) {
		const f = fixture();
		f.component.handleInput("fixture");
		f.component.handleInput(key);
		assert.deepEqual(f.results, []);
		assert.ok(displayedCode(f.component));
		verify(f.component);
		assert.deepEqual(f.results, [key === "\r" ? "fixture" : undefined]);
	}
});

test("forced dispose clears buffers/callbacks without completion; late inputs stay inert", () => {
	const f = fixture();
	f.component.handleInput("fixture");
	f.component.handleInput(START + "unfinished-fixture");
	f.component.dispose();
	f.component.dispose();
	f.component.cancel();
	f.component.focused = true;
	const renders = f.renders();
	f.component.invalidate();
	f.component.handleInput("ignored");
	f.component.handleInput("\r");
	assert.deepEqual(f.results, [], "ownership loss must never invoke stale custom done");
	assert.equal(f.component.focused, false);
	assert.deepEqual(f.component.render(120), []);
	assert.equal(f.renders(), renders);
	const owned = f.component as unknown as { secret: string; pasteBuffer: string; onDone?: unknown };
	assert.equal(owned.secret, "");
	assert.equal(owned.pasteBuffer, "");
	assert.equal(owned.onDone, undefined);
});

test("paste/framing/rejection/edits cannot bypass always-challenged cancel", () => {
	for (const framing of [paste(""), paste("fixture"), paste("bad\rfixture"), END, "\x1b[20"]) {
		for (const cancel of ["\x1b", "\x03"]) {
			let calls = 0;
			const f = fixture(getKeybindings(), { challengeForTest: () => { calls++; return "ABCD2345WXYZ"; } });
			f.component.handleInput("fixture");
			f.component.handleInput(framing);
			if (framing === "\x1b[20") f.component.handleInput("broken"); // Malformed partial framing drains.
			assert.equal(calls, 0, "no challenge exists before an intent");
			f.component.handleInput("\x15"); // Even clearing the secret must not bypass the challenge.
			f.component.handleInput(cancel);
			assert.equal(calls, 1);
			assert.deepEqual(f.results, []);
			assert.equal(displayedCode(f.component), "ABCD2345WXYZ");
			verify(f.component);
			assert.deepEqual(f.results, [undefined]);
		}
	}
});

test("cancel intentions always generate fresh codes; old codes and unknown tails cannot finish", () => {
	const codes = ["ABCD2345WXYZ", "EFGH6789PQRS", "JKLM2345TUVW", "PQRS6789ABCD"];
	let calls = 0;
	const f = fixture(getKeybindings(), { challengeForTest: () => codes[calls++]! });
	f.component.handleInput(paste("fixture-private"));
	f.component.handleInput("\r");
	const submitCode = displayedCode(f.component);
	f.component.handleInput("\x1b");
	assert.equal(displayedCode(f.component), codes[1]);
	f.component.handleInput("\x03");
	assert.equal(displayedCode(f.component), codes[2]);
	assert.deepEqual(f.results, []);
	f.component.handleInput(submitCode); // A prior submit/cancel code is not authority.
	f.component.handleInput("\r");
	assert.deepEqual(f.results, []);
	assert.equal(displayedCode(f.component), codes[3]);
	verify(f.component);
	assert.deepEqual(f.results, [undefined]);
	assert.equal(calls, 4);
});

test("verification does not accept paste or echo/store undo of responses or secret tails", () => {
	const f = fixture();
	f.component.handleInput(paste("fixture-private"));
	f.component.handleInput("\r");
	const first = displayedCode(f.component);
	f.component.handleInput(paste(first));
	f.component.handleInput("\r");
	assert.deepEqual(f.results, [], "even the exact code pasted cannot verify");
	const before = plain(f.component.render(160));
	const oldSet = Input.prototype.setValue, oldHandle = Input.prototype.handleInput;
	try {
		Input.prototype.setValue = function (text) { assert.equal(text, ""); oldSet.call(this, text); };
		Input.prototype.handleInput = function () { assert.fail("verification never routes any response through public Input"); };
		for (const packet of ["fixture-hidden-tail", "Z".repeat(100_000), "\x1b[D", "\x19", "\x1f", "\x1b[A"]) {
			f.component.handleInput(packet);
			assert.equal(plain(f.component.render(160)), before, "neither response nor its length is echoed");
			const owned = f.component as unknown as { response: string };
			assert.ok(owned.response.length <= 12, "response is bounded even on huge tail events");
		}
		f.component.handleInput(displayedCode(f.component)); // No suffix/window matching on poisoned input.
		f.component.handleInput("\r");
		assert.deepEqual(f.results, []);
		verify(f.component);
	} finally {
		Input.prototype.setValue = oldSet;
		Input.prototype.handleInput = oldHandle;
	}
	assert.deepEqual(f.results, ["fixture-private"], "verification never modifies the retained private secret");
});

test("verification supports hidden backspace/clear, grouped lowercase and protocol printable keys", () => {
	const f = fixture();
	f.component.handleInput(paste("fixture"));
	f.component.handleInput("\r");
	const code = displayedCode(f.component);
	f.component.handleInput("unknown-tail");
	f.component.handleInput("\x15"); // Clear a poisoned attempt without an undo record.
	f.component.handleInput("A");
	f.component.handleInput("\x7f");
	f.component.handleInput(`\x1b[${code.charCodeAt(0)}u`);
	f.component.handleInput(`\x1b[${code.charCodeAt(0)};1:3u`); // Release cannot add a second symbol.
	f.component.handleInput(`\x1b[27;2;${code.charCodeAt(1)}~`);
	f.component.handleInput(code.slice(2, 4).toLowerCase() + " " + code.slice(4, 8).toLowerCase() + " " + code.slice(8).toLowerCase());
	f.component.handleInput("\r");
	assert.deepEqual(f.results, ["fixture"]);
});

test("challenge RNG failures and malformed test generator results hold the prompt fail-closed", () => {
	for (const failure of [() => { throw new Error("fixture-private-RNG-error"); }, () => "short",
		() => "A".repeat(100_000), () => "ABCD2345WX\r\n"]) {
		let calls = 0;
		const f = fixture(getKeybindings(), { challengeForTest: () => calls++ < 2 ? failure() : "ABCD2345WXYZ" });
		f.component.handleInput(paste("fixture-private"));
		f.component.handleInput("\r");
		assert.deepEqual(f.results, []);
		assert.match(plain(f.component.render(160)), /Verification unavailable/);
		assert.ok(!plain(f.component.render(160)).includes("fixture-private"));
		f.component.handleInput("\x1b"); // RNG failure must not downgrade keyboard cancellation.
		assert.deepEqual(f.results, []);
		f.component.handleInput("\r"); // Retry cancellation with a working RNG.
		verify(f.component);
		assert.deepEqual(f.results, [undefined]);
	}
	const f = fixture(getKeybindings(), { challengeForTest: () => { throw new Error("fixture"); } });
	f.component.handleInput(paste("fixture-private"));
	f.component.handleInput("\r");
	f.component.dispose();
	assert.deepEqual(f.results, [], "forced disposal revokes without stale done despite RNG failure");
});

test("RNG failure replacing a usable code revokes that old code without completing", () => {
	let calls = 0;
	const f = fixture(getKeybindings(), { challengeForTest: () => {
		if (calls++ === 0) return "ABCD2345WXYZ";
		throw new Error("fixture-private-RNG-error");
	} });
	f.component.handleInput(paste("fixture-private"));
	f.component.handleInput("\r");
	const stale = displayedCode(f.component);
	f.component.handleInput("\x1b"); // The cancel intent must revoke the submit code before generating.
	assert.ok(!plain(f.component.render(160)).includes(stale));
	f.component.handleInput(stale);
	f.component.handleInput("\r");
	assert.deepEqual(f.results, []);
	assert.match(plain(f.component.render(160)), /Verification unavailable/);
	assert.ok(!plain(f.component.render(160)).includes("fixture-private"));
	f.component.cancel();
	assert.deepEqual(f.results, [], "operation cancellation cannot release an RNG-failed sink");
	f.component.dispose();
});

test("verification preserves focus/cursor/resize bounds and clears all owned challenge data on dispose", () => {
	const f = fixture();
	f.component.handleInput(paste("fixture-private"));
	f.component.handleInput("\r");
	f.component.handleInput("fixture-hidden-tail");
	for (const rows of [0, 1, 2, 3, 4, 12]) {
		f.terminal.rows = rows;
		for (const width of [0, 1, 2, 4, 8, 15, 80]) {
			for (const focus of [true, false]) {
				f.component.focused = focus;
				const output = plain(bounds(f.component, width, rows, focus));
				assert.ok(!output.includes("fixture-private") && !output.includes("fixture-hidden-tail"));
			}
		}
	}
	f.component.dispose();
	f.component.cancel();
	assert.deepEqual(f.results, []);
	const owned = f.component as unknown as { secret: string; challenge: string; response: string; intent?: string };
	assert.equal(owned.secret, "");
	assert.equal(owned.challenge, "");
	assert.equal(owned.response, "");
	assert.equal(owned.intent, undefined);
});

// Fake public custom lifecycle: independent backend-result and UI-finished promises.
type OwnedComponent = Component & Partial<Focusable> & { dispose?(): void };
type Factory = (tui: TUI, theme: Theme, kb: KeybindingsManager, done: (value: string | undefined) => void) =>
	OwnedComponent | Promise<OwnedComponent>;
function fakeUI({ deferFactory = false, deferMount = false, deferFinish = false, mode = "regular" as unknown,
	onDone = () => {} } = {}) {
	const base: OwnedComponent = { focused: true, render: () => ["fixture main draft"], invalidate() {} };
	let focus = base, renders = 0, closeCalls = 0;
	const warnings: string[] = [];
	const requests: { start(): Promise<void>; mount(): void; finish(): void; fail(): void; component?: OwnedComponent; closed: boolean }[] = [];
	const setFocus = (next: OwnedComponent) => { focus.focused = false; focus = next; focus.focused = true; };
	const host = new Proxy({
		mode, terminal: { rows: 20, columns: 80 }, requestRender: () => { renders++; },
	}, { get: (target, key) => {
		assert.ok(key === "mode" || key === "terminal" || key === "requestRender", "public injected mode/render only");
		return target[key as keyof typeof target];
	} }) as unknown as TUI;
	const custom = (factory: Factory, options?: { overlay?: boolean }): Promise<string | undefined> => new Promise((resolve, reject) => {
		assert.equal(options?.overlay, false);
		const request: (typeof requests)[number] = {
			closed: false,
			finish: () => resolve(undefined),
			fail: () => reject(new Error("fixture private host error")),
			start: async () => {
				try {
					request.component = await factory(host, theme, getKeybindings() as KeybindingsManager, (value) => {
						assert.equal(value, undefined, "custom host result must not retain password");
						if (request.closed) return;
						request.closed = true;
						closeCalls++;
						setFocus(base);
						onDone();
						if (!deferFinish) request.finish();
						request.component?.dispose?.();
					});
					if (!request.closed && !deferMount) request.mount();
				} catch (error) { reject(error); }
			},
			mount: () => {
				if (request.closed) return;
				assert.ok(request.component);
				setFocus(request.component!);
			},
		};
		requests.push(request);
		if (!deferFactory) void request.start();
	});
	const ui = new Proxy({ custom, notify: (message: string, kind?: string) => {
		assert.equal(kind, "warning"); warnings.push(message);
	} }, { get: (target, key) => {
		assert.ok(key === "custom" || key === "notify", "no ordinary input/editor/settings/persistence");
		return target[key as keyof typeof target];
	} }) as unknown as ExtensionContext["ui"];
	return { ctx: { mode: "tui", ui } as Pick<ExtensionContext, "mode" | "ui">, host, requests, base, warnings,
		focus: () => focus, closeCalls: () => closeCalls, renders: () => renders };
}
const tick = () => Promise.resolve();

test("prompt is TUI-only and pre-aborted signals never access UI", async () => {
	const ui = new Proxy({}, { get() { assert.fail("no UI access allowed"); } }) as ExtensionContext["ui"];
	for (const mode of ["rpc", "print", "json"] as const) assert.equal(await promptArchiveSecret({ mode, ui }, "Fixture"), undefined);
	const controller = new AbortController(); controller.abort();
	assert.equal(await promptArchiveSecret({ mode: "tui", ui }, "Fixture", controller.signal), undefined);
});

test("injected public mode gate refuses fullscreen/unknown before input with fixed safe warning", async () => {
	for (const mode of ["fullscreen", undefined, null, "unknown"]) {
		const f = fakeUI({ mode });
		if (mode === undefined) Object.defineProperty(f.host, "mode", { value: undefined });
		assert.equal(await promptArchiveSecret(f.ctx, "Fixture"), undefined);
		assert.equal(f.closeCalls(), 1);
		assert.equal(f.focus(), f.base);
		assert.equal(f.requests[0]!.component instanceof ArchiveSecretInput, false);
		f.requests[0]!.component!.handleInput!("synthetic-private");
		assert.deepEqual(f.requests[0]!.component!.render(160), []);
		assert.deepEqual(f.warnings, ["Archive password input requires regular TUI mode. Restart with pi --tui-mode regular."]);
		assert.equal(isArchiveSecretPromptActive(), false);
	}
});

test("prompt completion uses done only and gate lasts through true custom UI completion", async () => {
	const f = fakeUI({ deferFinish: true });
	const result = promptArchiveSecret(f.ctx, "Fixture title");
	await tick();
	const component = f.requests[0]!.component!;
	component.handleInput!(paste("  fixture-中🙂  ") + "\r");
	component.handleInput!("\r");
	assert.equal(f.closeCalls(), 0);
	assert.equal(f.focus(), component);
	verify(component);
	assert.equal(f.closeCalls(), 1);
	assert.equal(f.focus(), f.base);
	assert.equal(isArchiveSecretPromptActive(), true, "done is not the public custom promise lifecycle end");
	assert.equal(await promptArchiveSecret(fakeUI().ctx, "busy"), undefined);
	f.requests[0]!.finish();
	assert.equal(await result, "  fixture-中🙂  ");
	assert.equal(isArchiveSecretPromptActive(), false);
});

test("abort before deferred factory/between factory and mount settles result but mounts cancel-only sink", async () => {
	for (const phase of ["factory", "mount"] as const) {
		const f = fakeUI({ deferFactory: phase === "factory", deferMount: true });
		const controller = new AbortController();
		const result = promptArchiveSecret(f.ctx, "Fixture", controller.signal);
		if (phase === "mount") await tick();
		controller.abort();
		assert.equal(await result, undefined, "backend cancellation must not await factory or acknowledgement");
		assert.equal(isArchiveSecretPromptActive(), true);
		assert.equal(f.closeCalls(), 0);
		if (phase === "factory") await f.requests[0]!.start();
		f.requests[0]!.mount();
		const component = f.requests[0]!.component!;
		assert.equal(f.focus(), component);
		assert.ok(displayedCode(component));
		verify(component);
		await tick();
		assert.equal(f.closeCalls(), 1);
		assert.equal(f.focus(), f.base);
		assert.equal(isArchiveSecretPromptActive(), false);
	}
});

test("abort/revoke wipes immediately, holds gate, is idempotent, rejects old/pasted codes", async () => {
	for (const phase of ["editing", "pending-paste", "submit", "cancel"] as const) {
		const f = fakeUI(), controller = new AbortController();
		const result = promptArchiveSecret(f.ctx, "Fixture", controller.signal);
		await tick();
		const component = f.requests[0]!.component! as ArchiveSecretInput;
		component.handleInput("fixture");
		if (phase === "pending-paste") component.handleInput(START + "pending-fixture");
		if (phase === "submit" || phase === "cancel") component.handleInput(phase === "submit" ? "\r" : "\x03");
		const stale = phase === "submit" || phase === "cancel" ? displayedCode(component) : undefined;
		controller.abort();
		assert.equal(await result, undefined);
		assert.equal(isArchiveSecretPromptActive(), true);
		assert.equal(f.closeCalls(), 0);
		const fresh = displayedCode(component);
		assert.notEqual(fresh, stale);
		const owned = component as unknown as { secret: string; pasteBuffer: string; pasteTail: string; startTail: string; response: string };
		for (const key of ["secret", "pasteBuffer", "pasteTail", "startTail", "response"] as const) assert.equal(owned[key], "");
		revokeArchiveSecretPrompt(); controller.abort(); component.cancel();
		assert.equal(displayedCode(component), fresh, "repeated revocation must not regenerate or clear acknowledgement");
		assert.equal(await promptArchiveSecret(fakeUI().ctx, "busy cancelled"), undefined);
		if (stale) { component.handleInput(stale); component.handleInput("\r"); assert.equal(f.closeCalls(), 0); }
		component.handleInput(paste(displayedCode(component))); component.handleInput("\r");
		assert.equal(f.closeCalls(), 0);
		verify(component); await tick();
		assert.equal(f.closeCalls(), 1);
		assert.equal(isArchiveSecretPromptActive(), false);
		assert.equal(await result, undefined, "sink can never revive the operation");
	}
});

test("signal listeners are removed at UI end, not merely revoked result; host disposal never done", async () => {
	for (const forced of [false, true]) {
		const f = fakeUI(), controller = new AbortController();
		let adds = 0, removes = 0;
		const signal = controller.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
		signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => { adds++; add(...args); };
		signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => { removes++; remove(...args); };
		const result = promptArchiveSecret(f.ctx, "Fixture", signal); await tick();
		const component = f.requests[0]!.component!;
		component.handleInput!("fixture"); controller.abort();
		assert.equal(await result, undefined);
		assert.equal(removes, 0);
		if (forced) component.dispose!(); else verify(component);
		await tick();
		assert.equal(adds, 1); assert.equal(removes, 1);
		assert.equal(f.closeCalls(), forced ? 0 : 1);
		assert.equal(isArchiveSecretPromptActive(), false);
	}
});

test("single gate releases after completion; stale abort/input/disposal cannot close newer UI", async () => {
	const f = fakeUI(), firstSignal = new AbortController();
	const first = promptArchiveSecret(f.ctx, "first", firstSignal.signal); await tick();
	const old = f.requests[0]!.component!;
	old.handleInput!("fixture-first"); old.handleInput!("\r"); verify(old);
	assert.equal(await first, "fixture-first");
	const second = promptArchiveSecret(f.ctx, "second"); await tick();
	const current = f.requests[1]!.component!;
	current.handleInput!("fixture-second");
	firstSignal.abort(); old.handleInput!("\r"); old.dispose!();
	assert.equal(f.focus(), current); assert.equal(f.closeCalls(), 1);
	current.handleInput!("\r"); verify(current);
	assert.equal(await second, "fixture-second"); assert.equal(f.closeCalls(), 2);
});

test("forced owner abandonment revokes without done; stale factory/UI finish cannot touch newer owner", async () => {
	const old = fakeUI({ deferFactory: true });
	const first = promptArchiveSecret(old.ctx, "old");
	abandonArchiveSecretPrompt(); abandonArchiveSecretPrompt();
	assert.equal(await first, undefined); assert.equal(isArchiveSecretPromptActive(), false);
	const f = fakeUI(); const second = promptArchiveSecret(f.ctx, "new"); await tick();
	await old.requests[0]!.start();
	const inert = old.requests[0]!.component!;
	inert.handleInput!("fixture"); inert.handleInput!("\r"); inert.dispose!();
	old.requests[0]!.fail(); await tick();
	assert.equal(old.closeCalls(), 0); assert.deepEqual(inert.render(160), []);
	assert.equal(isArchiveSecretPromptActive(), true); assert.equal(f.focus(), f.requests[0]!.component);
	f.requests[0]!.component!.dispose!(); assert.equal(await second, undefined);
	assert.equal(f.closeCalls(), 0);
});

test("host failures/unowned results fail closed, unregister listener and release only their gate", async () => {
	for (const custom of [async () => { throw new Error("fixture input error"); }, async () => "unowned result"]) {
		const ctx = { mode: "tui", ui: { custom } } as unknown as Pick<ExtensionContext, "mode" | "ui">;
		assert.equal(await promptArchiveSecret(ctx, "Fixture"), undefined); assert.equal(isArchiveSecretPromptActive(), false);
	}
	const f = fakeUI(); const result = promptArchiveSecret(f.ctx, "error"); await tick();
	f.requests[0]!.component!.handleInput!("fixture-private"); f.requests[0]!.fail();
	assert.equal(await result, undefined); assert.equal(f.closeCalls(), 0);
	assert.deepEqual(f.requests[0]!.component!.render(160), []);
});

test("title controls cannot spoof cursor/rendering and navigation errors never include input", () => {
	const f = fixture();
	const custom = new ArchiveSecretInput({ terminal: f.terminal, requestRender() {} } as unknown as TUI,
		theme, getKeybindings(), `Fixture\r\n\t${CURSOR_MARKER}\x1b]52;c;not-a-secret\x07中🙂`, () => {});
	custom.focused = true;
	for (const rows of [1, 2, 3]) {
		f.terminal.rows = rows;
		for (const width of [1, 8, 120]) bounds(custom, width, rows, true);
	}
	custom.dispose();
});

test("reentrant done/abort/dispose revokes prior to result continuation without stale close", async () => {
	const controller = new AbortController();
	const f = fakeUI({ onDone: () => { controller.abort(); revokeArchiveSecretPrompt(); } });
	const result = promptArchiveSecret(f.ctx, "Fixture", controller.signal); await tick();
	const component = f.requests[0]!.component!;
	component.handleInput!("fixture"); component.handleInput!("\r"); verify(component);
	assert.equal(await result, undefined); assert.equal(f.closeCalls(), 1);
	component.dispose!(); assert.equal(f.closeCalls(), 1); assert.equal(isArchiveSecretPromptActive(), false);
});

test("stale factory after host rejection is inert and cannot complete a newer prompt", async () => {
	let staleFactory: Factory | undefined;
	const stale = { mode: "tui", ui: { custom: async (factory: Factory) => {
		staleFactory = factory; throw new Error("fixture rejection");
	} } } as unknown as Pick<ExtensionContext, "mode" | "ui">;
	assert.equal(await promptArchiveSecret(stale, "stale"), undefined);
	const f = fakeUI(); const current = promptArchiveSecret(f.ctx, "current"); await tick();
	let staleCompletions = 0;
	const inert = await staleFactory!(f.host, theme, getKeybindings() as KeybindingsManager, () => { staleCompletions++; });
	inert.handleInput!("ignored"); inert.handleInput!("\r"); inert.dispose?.();
	assert.equal(staleCompletions, 0); assert.deepEqual(inert.render(80), []);
	assert.equal(f.focus(), f.requests[0]!.component);
	f.requests[0]!.component!.dispose!(); assert.equal(await current, undefined);
});

test("post-abort RNG failures remain bounded and revoked; reentrant generator cannot reinstall stale code", () => {
	for (const bad of [undefined, null, 0, NaN, {}, [], "I".repeat(12), "ＡＢＣＤ2345WXYZ"]) {
		const f = fixture(getKeybindings(), { challengeForTest: () => bad as string });
		f.component.handleInput("fixture-private");
		f.component.cancel();
		for (const packet of ["\r", "\x1b", "\x03", "ABCD2345WXYZ", "\r"]) f.component.handleInput(packet);
		assert.deepEqual(f.results, []); assert.match(plain(f.component.render(160)), /Verification unavailable/);
		assert.ok(!plain(f.component.render(160)).includes("fixture-private"));
		f.component.dispose(); assert.deepEqual(f.results, []);
	}
	let component: ArchiveSecretInput, calls = 0, revoked = 0;
	component = new ArchiveSecretInput({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme,
		getKeybindings(), "Fixture", () => assert.fail("no stale finish"), {
			challengeForTest: () => {
				if (calls++ === 0) { component.cancel(); return "ABCD2345WXYZ"; }
				return "EFGH6789PQRS";
			}, onRevoke: () => { revoked++; },
		});
	component.handleInput("fixture"); component.handleInput("\r");
	assert.equal(revoked, 1); assert.equal(displayedCode(component), "EFGH6789PQRS");
	component.dispose(); assert.deepEqual(component.render(160), []);
});


test("operation cancel immediately wipes every owned reference before result callback/RNG and never revives submit", () => {
	let component: ArchiveSecretInput, revokes = 0, generations = 0;
	const results: Array<string | undefined> = [];
	const state = () => component as unknown as { secret: string; pasteBuffer: string; startTail: string; pasteTail: string;
		response: string; challenge: string; intent?: string };
	component = new ArchiveSecretInput({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme,
		getKeybindings(), "Fixture", value => results.push(value), {
			challengeForTest: () => {
				generations++;
				if (generations > 1) assert.equal(revokes, 1, "revoke must precede new RNG work");
				return generations === 1 ? "ABCD2345WXYZ" : "EFGH6789PQRS";
			}, onRevoke: () => {
				revokes++;
				for (const key of ["secret", "pasteBuffer", "startTail", "pasteTail", "response", "challenge"] as const) assert.equal(state()[key], "");
				assert.equal(state().intent, undefined);
			},
		});
	component.handleInput("fixture-private"); component.handleInput("\r");
	component.handleInput("ABCD"); component.handleInput(START + "unfinished-private");
	component.cancel();
	assert.equal(revokes, 1); assert.equal(state().intent, "cancel"); assert.equal(displayedCode(component), "EFGH6789PQRS");
	component.handleInput("fixture-new-private"); component.handleInput("\r");
	assert.equal(state().secret, ""); assert.deepEqual(results, []);
	component.cancel(); assert.equal(revokes, 1); verify(component); assert.deepEqual(results, [undefined]);
});

test("RNG disposal/finish reentrancy never invokes stale completion or installs a late challenge", () => {
	let component: ArchiveSecretInput, completes = 0;
	component = new ArchiveSecretInput({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme,
		getKeybindings(), "Fixture", () => { completes++; }, {
			challengeForTest: () => { component.dispose(); return "ABCD2345WXYZ"; },
		});
	component.handleInput("fixture"); component.handleInput("\r");
	assert.equal(completes, 0); assert.deepEqual(component.render(160), []);
	let finished: ArchiveSecretInput;
	finished = new ArchiveSecretInput({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme,
		getKeybindings(), "Fixture", value => {
			completes++; assert.equal(value, "fixture");
			finished.handleInput("\r"); finished.cancel(); finished.dispose();
		});
	finished.handleInput("fixture"); finished.handleInput("\r"); verify(finished);
	assert.equal(completes, 1); assert.deepEqual(finished.render(160), []);
});

test("default RNG has no mount-time code; repeated post-intent samples are 12-symbol fresh codes", () => {
	const f = fixture(), seen = new Set<string>();
	assert.ok(!plain(f.component.render(160)).match(/\b[A-HJ-NP-Z2-9]{4} [A-HJ-NP-Z2-9]{4} [A-HJ-NP-Z2-9]{4}\b/));
	for (let i = 0; i < 128; i++) {
		f.component.handleInput(i % 2 ? "\x1b" : "\x03");
		const code = displayedCode(f.component); assert.equal(seen.has(code), false); seen.add(code);
		assert.equal(f.results.length, 0);
	}
	verify(f.component); assert.deepEqual(f.results, [undefined]); // Entropy follows crypto, not this sample test.
});

test("custom lifecycle failure after verified done revokes the staged password without another close", async () => {
	const f = fakeUI({ deferFinish: true }); const result = promptArchiveSecret(f.ctx, "Fixture"); await tick();
	const component = f.requests[0]!.component!;
	component.handleInput!("fixture-private"); component.handleInput!("\r"); verify(component);
	assert.equal(f.closeCalls(), 1); assert.equal(isArchiveSecretPromptActive(), true);
	f.requests[0]!.fail(); assert.equal(await result, undefined); assert.equal(f.closeCalls(), 1);
	assert.equal(isArchiveSecretPromptActive(), false);
});

test("public mode getter forced teardown/reentrancy returns inert factory and cannot close newer UI", async () => {
	const old = fakeUI({ deferFactory: true }), newer = fakeUI();
	const first = promptArchiveSecret(old.ctx, "Fixture old"); let second: Promise<string | undefined>;
	Object.defineProperty(old.host, "mode", { get: () => {
		abandonArchiveSecretPrompt(); second = promptArchiveSecret(newer.ctx, "Fixture newer"); return "regular";
	} });
	await old.requests[0]!.start(); assert.equal(await first, undefined); await tick();
	const stale = old.requests[0]!.component!;
	assert.deepEqual(stale.render(160), []); stale.handleInput!("fixture"); stale.handleInput!("\r"); stale.dispose!();
	assert.equal(old.closeCalls(), 0); old.requests[0]!.finish(); await tick();
	assert.equal(isArchiveSecretPromptActive(), true); assert.equal(newer.focus(), newer.requests[0]!.component);
	newer.requests[0]!.component!.dispose!(); assert.equal(await second!, undefined);
});

test("throwing unknown mode getter refuses with safe warning without touching theme/input", async () => {
	const f = fakeUI();
	Object.defineProperty(f.host, "mode", { get: () => { throw new Error("fixture private renderer value"); } });
	assert.equal(await promptArchiveSecret(f.ctx, "Fixture"), undefined);
	assert.equal(f.closeCalls(), 1); assert.deepEqual(f.requests[0]!.component!.render(160), []);
	assert.deepEqual(f.warnings, ["Archive password input requires regular TUI mode. Restart with pi --tui-mode regular."]);
});


test("throwing host done revokes result/gate without retrying stale completion", async () => {
	const f = fakeUI({ onDone: () => { throw new Error("fixture private host done error"); } });
	const result = promptArchiveSecret(f.ctx, "Fixture"); await tick();
	const component = f.requests[0]!.component!;
	component.handleInput!("fixture-private"); component.handleInput!("\r"); verify(component);
	assert.equal(await result, undefined); assert.equal(f.closeCalls(), 1);
	assert.equal(isArchiveSecretPromptActive(), false); component.dispose!(); assert.equal(f.closeCalls(), 1);
	f.requests[0]!.finish(); await tick(); assert.equal(f.closeCalls(), 1);
});

test("cancel callback reentrant text/throw cannot retain new secrets or downgrade verification", () => {
	let component: ArchiveSecretInput;
	component = new ArchiveSecretInput({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme,
		getKeybindings(), "Fixture", value => { assert.equal(value, undefined); }, {
			onRevoke: () => { component.handleInput("fixture-reentrant-private"); throw new Error("fixture private callback error"); },
		});
	component.handleInput("fixture-private"); component.cancel();
	const owned = component as unknown as { secret: string };
	assert.equal(owned.secret, ""); assert.ok(displayedCode(component));
	verify(component); assert.deepEqual(component.render(160), []);
});

test("public revoke without AbortSignal immediately cancels full pending verification response and holds UI", async () => {
	const f = fakeUI(), result = promptArchiveSecret(f.ctx, "Fixture"); await tick();
	const component = f.requests[0]!.component!;
	component.handleInput!("fixture-private"); component.handleInput!("\r");
	const old = displayedCode(component); component.handleInput!(old); // Complete response, not yet Enter.
	revokeArchiveSecretPrompt();
	assert.equal(await result, undefined); assert.equal(f.closeCalls(), 0); assert.equal(isArchiveSecretPromptActive(), true);
	const postRevoke = displayedCode(component); assert.notEqual(postRevoke, old);
	revokeArchiveSecretPrompt(); assert.equal(displayedCode(component), postRevoke);
	component.handleInput!("\r"); assert.equal(f.closeCalls(), 0, "pre-revoke full response was wiped");
	component.handleInput!(old); component.handleInput!("\r"); assert.equal(f.closeCalls(), 0);
	verify(component); await tick(); assert.equal(f.closeCalls(), 1); assert.equal(isArchiveSecretPromptActive(), false);
	assert.equal(await result, undefined);
});

// Preparation is part of the SAME owned lifetime, not an outer service await.
test("preparation reserves synchronously before reentrant admission, with no premature custom request", async () => {
	const f = fakeUI(); let finishPrepare!: () => void, nested!: Promise<string | undefined>, calls = 0;
	const result = promptArchiveSecret(f.ctx, "Fixture prepared", undefined, () => {
		calls++; assert.equal(isArchiveSecretPromptActive(), true);
		assert.equal(f.requests.length, 0);
		nested = promptArchiveSecret(f.ctx, "Fixture reentrant", undefined, () => assert.fail("busy must not prepare"));
		return new Promise<void>(resolve => { finishPrepare = resolve; });
	});
	assert.equal(calls, 1); assert.equal(isArchiveSecretPromptActive(), true);
	assert.equal(f.requests.length, 0); assert.equal(await nested, undefined);
	finishPrepare(); await tick(); await tick();
	assert.equal(f.requests.length, 1);
	const component = f.requests[0]!.component!;
	component.handleInput!("synthetic-prepared"); component.handleInput!("\r"); verify(component);
	assert.equal(await result, "synthetic-prepared"); assert.equal(isArchiveSecretPromptActive(), false);
	const ordinary = fakeUI(), noPrepare = promptArchiveSecret(ordinary.ctx, "Fixture immediate");
	assert.equal(ordinary.requests.length, 1, "no-prepare custom/factory invocation stays synchronous");
	await tick(); ordinary.requests[0]!.component!.dispose!(); assert.equal(await noPrepare, undefined);
});

test("unavailable/pre-aborted admission never calls preparation or accesses UI", async () => {
	const ui = new Proxy({}, { get() { assert.fail("no UI access"); } }) as ExtensionContext["ui"];
	const prepare = () => assert.fail("no preparation on refused admission");
	for (const mode of ["rpc", "print", "json"] as const) assert.equal(await promptArchiveSecret({ mode, ui }, "Fixture", undefined, prepare), undefined);
	const controller = new AbortController(); controller.abort();
	assert.equal(await promptArchiveSecret({ mode: "tui", ui }, "Fixture", controller.signal, prepare), undefined);
	assert.equal(isArchiveSecretPromptActive(), false);
});

for (const cancellation of ["synchronous-abort", "pending-abort", "pending-revoke"] as const) {
	test(`preparation ${cancellation} revokes result immediately but reserves through deferred factory/sink/UI end`, async () => {
		const f = fakeUI({ deferFactory: true, deferFinish: true }), controller = new AbortController();
		let finishPrepare!: () => void;
		const result = promptArchiveSecret(f.ctx, "Fixture", controller.signal, () => {
			assert.equal(isArchiveSecretPromptActive(), true);
			if (cancellation === "synchronous-abort") controller.abort();
			return new Promise<void>(resolve => { finishPrepare = resolve; });
		});
		if (cancellation === "pending-abort") controller.abort();
		if (cancellation === "pending-revoke") revokeArchiveSecretPrompt();
		assert.equal(await result, undefined); assert.equal(isArchiveSecretPromptActive(), true);
		assert.equal(f.requests.length, 0); assert.equal(f.closeCalls(), 0);
		assert.equal(await promptArchiveSecret(f.ctx, "Fixture busy"), undefined);
		finishPrepare(); await tick(); assert.equal(f.requests.length, 1);
		assert.equal(isArchiveSecretPromptActive(), true); await f.requests[0]!.start();
		const component = f.requests[0]!.component!;
		assert.ok(displayedCode(component), "late factory mounts cancel-only sink");
		component.handleInput!(paste("synthetic-late-secret")); component.handleInput!("\r");
		assert.equal(f.closeCalls(), 0); assert.ok(!plain(component.render(160)).includes("synthetic-late-secret"));
		verify(component); assert.equal(f.closeCalls(), 1); assert.equal(isArchiveSecretPromptActive(), true);
		f.requests[0]!.finish(); await tick(); assert.equal(isArchiveSecretPromptActive(), false);
		assert.equal(await result, undefined);
	});
}

for (const failure of ["throw", "reject", "abort-then-reject"] as const) {
	test(`preparation ${failure} releases/wipes without requesting custom or restoring an ordinary dialog`, async () => {
		const f = fakeUI(), controller = new AbortController(); let removes = 0;
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => { removes++; remove(...args); };
		const result = promptArchiveSecret(f.ctx, "Fixture", controller.signal, () => {
			assert.equal(isArchiveSecretPromptActive(), true);
			if (failure === "throw") throw new Error("synthetic-private-preparation-error");
			if (failure === "abort-then-reject") controller.abort();
			return Promise.reject(new Error("synthetic-private-preparation-error"));
		});
		assert.equal(await result, undefined); await tick();
		assert.equal(f.requests.length, 0); assert.equal(f.closeCalls(), 0); assert.equal(f.focus(), f.base);
		assert.equal(removes, 1); assert.deepEqual(f.warnings, []); assert.equal(isArchiveSecretPromptActive(), false);
		const next = promptArchiveSecret(f.ctx, "Fixture next"); await tick();
		controller.abort(); assert.equal(isArchiveSecretPromptActive(), true);
		f.requests[0]!.component!.dispose!(); assert.equal(await next, undefined);
	});
}

for (const late of ["resolve", "reject"] as const) {
	test(`abandoned preparation late ${late} cannot request custom or clear a newer owner`, async () => {
		const old = fakeUI(), current = fakeUI(), controller = new AbortController();
		let finish!: () => void, reject!: (reason: Error) => void;
		const first = promptArchiveSecret(old.ctx, "Fixture old", controller.signal, () => new Promise<void>((resolve, fail) => {
			finish = resolve; reject = fail;
		}));
		abandonArchiveSecretPrompt(); assert.equal(await first, undefined);
		const second = promptArchiveSecret(current.ctx, "Fixture current"); await tick();
		if (late === "resolve") finish(); else reject(new Error("synthetic late failure"));
		controller.abort(); await tick(); await tick();
		assert.equal(old.requests.length, 0); assert.equal(old.closeCalls(), 0);
		assert.equal(isArchiveSecretPromptActive(), true); assert.equal(current.focus(), current.requests[0]!.component);
		current.requests[0]!.component!.dispose!(); assert.equal(await second, undefined);
	});
}

for (const failure of [false, true]) {
	test(`synchronous preparation abandon/new-owner reentrancy ${failure ? "throws" : "returns"} without late mount/release`, async () => {
		const old = fakeUI(), current = fakeUI(); let second!: Promise<string | undefined>;
		const first = promptArchiveSecret(old.ctx, "Fixture old", undefined, () => {
			abandonArchiveSecretPrompt(); second = promptArchiveSecret(current.ctx, "Fixture current");
			if (failure) throw new Error("synthetic reentrant failure");
		});
		assert.equal(await first, undefined); await tick();
		assert.equal(old.requests.length, 0); assert.equal(old.closeCalls(), 0); assert.equal(isArchiveSecretPromptActive(), true);
		current.requests[0]!.component!.dispose!(); assert.equal(await second, undefined);
	});
}
