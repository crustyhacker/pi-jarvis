import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, Input, KeybindingsManager, StdinBuffer, TUI_KEYBINDINGS, TuiMainScreen,
	stripTerminalSequences, visibleWidth, type Terminal, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { MemoryEditorOverlay } from "../memory-editor.js";
import type { MemoryEditorBackend, MemoryEditorQuery, MemoryEditorScope, MemoryNoteDraft } from "../memory-editor-types.js";
import type { MemoryRecord } from "../memory-types.js";

const UP = "\x1b[A", DOWN = "\x1b[B", LEFT = "\x1b[D", RIGHT = "\x1b[C", PGDN = "\x1b[6~", PGUP = "\x1b[5~";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const id = (text: string) => createHash("sha256").update(text).digest("hex");
function note(index: number, project: string, changes: Partial<MemoryRecord> = {}): MemoryRecord {
	return { id: id(`note-${index}`), kind: "note", title: `Note ${index.toString().padStart(3, "0")}`, text: `  Body ${index}\n    second line`,
		category: "project", scope: "project", project, source: { lane: "jarvis", sessionId: `session-${index}`, eventId: `event-${index}`, role: "assistant" },
		createdAt: 1000 + index, updatedAt: 2000 + index, ...changes };
}
function fixture(t: TestContext, count = 3, options: { promised?: boolean; columns?: number; rows?: number; real?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "jarvis-memory-ui-"));
	const agent = join(root, "agent"), project = join(root, "workspace"); mkdirSync(agent); mkdirSync(project);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let onInput: ((data: string) => void) | undefined, closePresentation: (() => void) | undefined;
	const terminal = { columns: options.columns ?? 120, rows: options.rows ?? 40,
		start(input: (data: string) => void) { onInput = input; }, stop() {}, async drainInput() {}, kittyProtocolActive: false, setTitle() {}, setProgress() {},
		write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {} } satisfies Terminal;
	let renders = 0, closed = 0, allowed = true;
	const tui = options.real ? new TuiMainScreen(terminal) : { terminal, mode: "regular", requestRender: () => { renders++; } } as unknown as TUI;
	const kb = new KeybindingsManager(TUI_KEYBINDINGS);
	const theme = { fg: (_: string, text: string) => text } as Theme;
	const records = Array.from({ length: count }, (_, index) => note(index, project));
	const calls = { lists: [] as MemoryEditorQuery[], gets: [] as [string, MemoryEditorScope][], creates: [] as MemoryNoteDraft[],
		updates: [] as { expected: MemoryRecord; draft: MemoryNoteDraft; scope: MemoryEditorScope }[], deletes: [] as { expected: MemoryRecord[]; scope: MemoryEditorScope }[] };
	let listener: (() => void) | undefined;
	const result = <T>(value: T): T | Promise<T> => options.promised ? Promise.resolve(value) : value;
	const backend: MemoryEditorBackend = {
		projectLabel: project,
		ensureActive() { if (!allowed) throw new Error("PRIVATE fake policy content MUST NOT LEAK"); },
		list(query) {
			calls.lists.push({ ...query });
			const notes = records.filter((r) => r.kind === "note")
				.filter((r) => query.scope === "all" || (query.scope === "global" ? r.scope === "global" : query.scope === "project" ? r.scope === "project" && r.project === project : r.scope === "global" || r.project === project))
				.filter((r) => !query.category || r.category === query.category).filter((r) => !query.lane || r.source.lane === query.lane)
				.filter((r) => !query.query || (r.title + " " + r.text).toLowerCase().includes(query.query.toLowerCase()))
				.sort((a, b) => query.sort === "title" ? a.title.localeCompare(b.title) : query.sort === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt);
			const offset = query.offset ?? 0, limit = query.limit ?? 20;
			return result({ records: notes.slice(offset, offset + limit).map((r) => ({ id: r.id, title: r.title, category: r.category, scope: r.scope,
				project: r.project, lane: r.source.lane, createdAt: r.createdAt, updatedAt: r.updatedAt, textBytes: Buffer.byteLength(r.text) })),
				total: notes.length, offset, nextOffset: offset + limit < notes.length ? offset + limit : null });
		},
		get(key, scope) { calls.gets.push([key, scope]); return result(records.find((r) => r.id === key)); },
		create(draft) {
			calls.creates.push({ ...draft });
			if (records.some((r) => r.title === draft.title && r.scope === draft.scope)) throw new Error("title collision");
			const created = note(records.length, project, { ...draft, id: id(draft.title), source: { lane: "manual", sessionId: "human", eventId: "human-create" } });
			records.push(created); listener?.(); return result(created);
		},
		update(expected, draft, scope) {
			calls.updates.push({ expected: structuredClone(expected), draft: { ...draft }, scope });
			const index = records.findIndex((r) => r.id === expected.id);
			if (index < 0 || JSON.stringify(records[index]) !== JSON.stringify(expected)) throw new Error("conflict: changed externally");
			records[index] = { ...records[index]!, ...draft, project: draft.scope === "project" && expected.scope === "global" ? project : expected.project,
				id: id(draft.title), updatedAt: records[index]!.updatedAt + 1 };
			listener?.(); return result(records[index]!);
		},
		forget(expected, scope) {
			calls.deletes.push({ expected: structuredClone(expected), scope });
			for (const r of expected) if (JSON.stringify(records.find((n) => n.id === r.id)) !== JSON.stringify(r)) throw new Error("conflict");
			for (const r of expected) records.splice(records.findIndex((n) => n.id === r.id), 1);
			listener?.(); return result(expected.length);
		},
		onChange(fn) { listener = fn; return () => { listener = undefined; }; },
	};
	const ui = new MemoryEditorOverlay(tui, theme, kb, backend, () => { closed++; closePresentation?.(); });
	ui.focused = true;
	if (options.real) tui.setFocus(ui);
	t.after(() => ui.dispose());
	const lines = (width = terminal.columns, height?: number) => ui.render(width, height);
	return { ui, tui, kb, backend, records, calls, project, agent, terminal, theme, lines, screen: () => plain(lines()),
		renders: () => renders, closed: () => closed, deny: () => { allowed = false; }, allow: () => { allowed = true; }, notify: () => listener?.(),
		input: (data: string) => { assert.ok(onInput); onInput(data); }, onClose: (callback: () => void) => { closePresentation = callback; } };
}
type Fixture = ReturnType<typeof fixture>;
function nativeFixture(t: TestContext) {
	const f = fixture(t, 1, { real: true }), tui = f.tui;
	assert.ok(tui instanceof TuiMainScreen);
	const ordinary = new Input({ prompt: "" }), submissions: string[] = [], packets: string[] = [];
	ordinary.onSubmit = (text) => { submissions.push(text); };
	f.tui.addChild(ordinary); f.tui.setFocus(ordinary);
	const overlay = f.tui.showOverlay(f.ui, { width: "90%", maxHeight: "90%" });
	f.onClose(() => overlay.hide()); // Synthetic host custom completion; never extension-side handle hiding.
	f.tui.start();
	const buffer = new StdinBuffer(); // Actual public defaults: lone ESC 10ms, partial sequence 50ms.
	buffer.on("data", (data) => { packets.push(data); f.input(data); });
	buffer.on("paste", (data) => { packets.push(paste(data)); f.input(paste(data)); }); // ProcessTerminal's public framing path.
	t.after(() => { buffer.destroy(); f.tui.stop(); });
	return { ...f, tui, ordinary, submissions, packets, buffer };
}
async function delay(ms: number) { await new Promise<void>((resolve) => setTimeout(resolve, ms)); }
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function key(f: Fixture, data: string) { f.ui.handleInput(data); await settle(); return f.screen(); }
async function back(f: Fixture) { await key(f, "\x1b"); return await key(f, "\r"); }
async function edit(f: Fixture) { await settle(); await key(f, "e"); assert.match(f.screen(), /Edit note/); }
async function replace(f: Fixture, title: string, body: string) {
	await key(f, "\x01"); await key(f, "\x0b"); await key(f, paste(title));
	await key(f, "\t"); await key(f, "\x01"); await key(f, "\x0b"); // New/create body is empty; existing body use Ctrl+Home and kills below.
	if (f.screen().includes("second line")) {
		await key(f, "\x1b[1;5H"); await key(f, "\x0b"); await key(f, "\x04"); await key(f, "\x0b");
	}
	await key(f, paste(body));
}
async function reviewAll(f: Fixture) {
	for (let limit = 0; limit < 10000; limit++) {
		const match = /Review page (\d+)\/(\d+)/.exec(f.screen());
		assert.ok(match, f.screen());
		if (match[1] === match[2]) return;
		await key(f, PGDN);
	}
	assert.fail("review pagination failed to progress");
}
function bounds(lines: string[], width: number, height: number) {
	assert.ok(lines.length <= height);
	for (const line of lines) { assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`); assert.ok(!/[\r\n\t]/.test(line)); }
}

test("cached note-only browser uses exact API, pagination and explicit refresh; no render reads", async (t) => {
	const f = fixture(t, 45); await settle();
	assert.equal(f.calls.lists.length, 1); assert.deepEqual(f.calls.lists[0], { scope: "current", sort: "updated", offset: 0, limit: 20 });
	assert.match(f.screen(), /1–20 of 45/);
	for (let i = 0; i < 20; i++) f.ui.render(90);
	assert.equal(f.calls.lists.length, 1); assert.equal(f.calls.gets.length, 0);
	await key(f, PGDN); assert.match(f.screen(), /21–40 of 45/);
	await key(f, "]"); assert.match(f.screen(), /41–45 of 45/);
	await key(f, PGUP); assert.match(f.screen(), /21–40 of 45/);
	await key(f, "r"); assert.equal(f.calls.lists.at(-1)?.offset, 20);
});

test("named scope/category/source/sort fields and literal search cover current/project/global/all", async (t) => {
	const f = fixture(t, 4); await settle();
	f.records[0]!.scope = "global"; f.records[1]!.project = join(f.project, "foreign"); f.records[2]!.category = "reference"; f.records[3]!.source.lane = "manual";
	await key(f, "\x1bOQ"); assert.equal(f.calls.lists.at(-1)?.scope, "project"); // F2
	await key(f, "\x1bOQ"); assert.equal(f.calls.lists.at(-1)?.scope, "global");
	await key(f, "\x1bOQ"); assert.equal(f.calls.lists.at(-1)?.scope, "all");
	await key(f, "\x1bOR"); assert.equal(f.calls.lists.at(-1)?.category, "user"); // F3
	await key(f, "\x1bOS"); assert.equal(f.calls.lists.at(-1)?.lane, "main"); // F4
	await key(f, "\x1b[15~"); assert.equal(f.calls.lists.at(-1)?.sort, "created"); // F5
	await key(f, "\x06"); await key(f, paste('literal OR "query"')); await key(f, "\r");
	assert.equal(f.calls.lists.at(-1)?.query, 'literal OR "query"'); assert.equal(f.calls.lists.at(-1)?.offset, 0);
	assert.match(f.screen(), /No curated notes match/);
});

test("full inspector scrolls all body and provenance without truncating metadata or unsafe timestamps", async (t) => {
	const f = fixture(t, 1, { columns: 50, rows: 18 });
	const r = f.records[0]!; r.text = "HEAD\n" + "中🙂 text\n".repeat(1000) + "BODY-TAIL";
	r.project = "/" + "p".repeat(4080) + "PROJECT-TAIL";
	r.source.sessionId = "s".repeat(490) + "SESSION-TAIL"; r.source.eventId = "e".repeat(490) + "EVENT-TAIL";
	r.source.role = "assistant"; r.createdAt = Number.MAX_SAFE_INTEGER; r.updatedAt = Number.MAX_SAFE_INTEGER;
	await settle(); await key(f, "\x1bOQ"); await key(f, "\x1bOQ"); await key(f, "\x1bOQ"); await key(f, "\r");
	const seen = new Set<string>();
	for (let i = 0; i < 300; i++) { seen.add(f.screen()); await key(f, PGDN); }
	// Reassemble only viewport content (not repeated headers/footers) across wrap/page boundaries.
	const text = [...seen].map((screen) => screen.split("\n").slice(4, -3).join("")).join("");
	for (const marker of [r.id.slice(0, 30), "PROJECT-TAIL", "SESSION-TAIL", "EVENT-TAIL", "BODY-TAIL", String(Number.MAX_SAFE_INTEGER), "not last author"]) assert.ok(text.includes(marker), marker);
	assert.equal(f.calls.gets.length, 1); assert.ok(!text.includes("conversation"));
});

test("untrusted controls are escaped in list/inspector/form display, and unchanged originals are never rewritten", async (t) => {
	const f = fixture(t, 1);
	f.records[0]!.title = "unsafe\x1b]52;c;opaque\x07\ntitle";
	f.records[0]!.text = "body\x1b[2Jtail";
	f.records[0]!.source.eventId = "event\x1b]0;title\x07";
	await settle(); await key(f, "r"); const browser = f.lines(); bounds(browser, 120, 36);
	assert.ok(!browser.join("").includes("\x1b]52")); assert.ok(browser.join("").includes("\\u001b"));
	await key(f, "\r"); assert.ok(f.screen().includes("\\u001b[2J"));
	await key(f, "e"); assert.equal(f.ui.isDirty(), false);
	assert.ok(!f.lines().join("").includes("\x1b]52"));
	await key(f, "\x13"); assert.equal(f.calls.updates.length, 0); assert.match(f.screen(), /rejected/);
});

test("create uses public Input/Editor, all fields, multiline indentation and explicit global save review", async (t) => {
	const f = fixture(t, 0, { promised: true }); await settle();
	await key(f, "n"); await replace(f, "Unicode 中文 é 👨‍👩‍👧‍👦", "  first\r\n\tsecond\nlast  ");
	await key(f, "\t"); await key(f, RIGHT); // project -> reference
	await key(f, "\t"); await key(f, "\r"); // project -> global
	assert.ok(f.ui.isDirty()); await key(f, "\x13");
	assert.match(f.screen(), /SAVE REVIEW/); assert.match(f.screen(), /GLOBAL/); assert.match(f.screen(), /reference/);
	assert.equal(f.calls.creates.length, 0);
	await reviewAll(f); await key(f, "y");
	assert.equal(f.calls.creates.length, 1);
	assert.deepEqual(f.calls.creates[0], { title: "Unicode 中文 é 👨‍👩‍👧‍👦", text: "  first\n    second\nlast  ", category: "reference", scope: "global" });
	assert.equal(f.ui.isDirty(), false); assert.match(f.screen(), /Note saved/);
});

test("form letters/delete/Ctrl+D/Ctrl+F edit text instead of firing browser actions; Enter never saves", async (t) => {
	const f = fixture(t, 0); await settle(); await key(f, "n");
	await key(f, paste("ned ")); await key(f, "\x06"); await key(f, "x");
	assert.equal(f.calls.gets.length, 0); assert.equal(f.calls.deletes.length, 0);
	await key(f, "\t"); await key(f, "ned"); await key(f, "\r"); await key(f, "  indented"); await key(f, "\n"); await key(f, "last");
	assert.equal(f.calls.creates.length, 0); assert.match(f.screen(), /indented/);
	await key(f, "\x13"); await reviewAll(f); await key(f, "y");
	assert.equal(f.calls.creates[0]?.text, "ned\n  indented\nlast");
});

test("duplicate is create-only; edits include title/body/category/scope and preserve original provenance/destination", async (t) => {
	const f = fixture(t, 1); await settle();
	const original = structuredClone(f.records[0]!);
	await key(f, "d"); assert.ok(f.ui.isDirty()); assert.match(f.screen(), /copy/);
	await key(f, "\x13"); await reviewAll(f); await key(f, "y");
	assert.equal(f.calls.creates[0]?.title, original.title + " copy"); assert.equal(f.calls.updates.length, 0);
	await back(f); await key(f, "r"); await key(f, DOWN); await edit(f);
	await key(f, "\x01"); await key(f, "\x0b"); await key(f, paste("Renamed note"));
	await key(f, "\t"); await key(f, paste("\n  appended"));
	await key(f, "\t"); await key(f, RIGHT); await key(f, "\t"); await key(f, RIGHT);
	await key(f, "\x13"); await reviewAll(f); await key(f, "y");
	const updated = f.calls.updates[0]!;
	assert.equal(updated.draft.title, "Renamed note"); assert.equal(updated.draft.category, "reference"); assert.equal(updated.draft.scope, "global");
	assert.deepEqual(updated.expected.source, original.source); assert.equal(updated.expected.createdAt, original.createdAt);
});

test("foreign project destination remains original; global to project points at current workspace", async (t) => {
	const f = fixture(t, 1); f.records[0]!.project = join(f.project, "other-project"); await settle();
	for (let i = 0; i < 3; i++) await key(f, "\x1bOQ");
	await edit(f); await key(f, "\x13");
	assert.match(f.screen(), /other-project/); await reviewAll(f); await key(f, "y");
	assert.equal(f.calls.updates[0]?.expected.project, join(f.project, "other-project"));
	const g = fixture(t, 1); g.records[0]!.scope = "global"; g.records[0]!.project = join(g.project, "origin"); await settle(); await edit(g);
	await key(g, "\t"); await key(g, "\t"); await key(g, "\t"); await key(g, RIGHT); await key(g, "\x13");
	assert.ok(g.screen().includes(g.project)); assert.ok(!g.screen().includes("PROJECT — " + join(g.project, "origin")));
});

test("title max 160 Unicode points and body max 16KiB UTF8 reject whole oversize operations", async (t) => {
	const f = fixture(t, 0); await settle(); await key(f, "n");
	await key(f, paste("🙂".repeat(160))); assert.match(f.screen(), /160\/160/);
	await key(f, paste("🙂")); assert.match(f.screen(), /Paste rejected/);
	await key(f, "\t"); await key(f, paste("x".repeat(16384))); assert.match(f.screen(), /16384\/16384/);
	await key(f, paste("é")); assert.match(f.screen(), /Paste rejected/);
	await key(f, "\x13"); await reviewAll(f); await key(f, "y");
	assert.equal([...f.calls.creates[0]!.title].length, 160); assert.equal(Buffer.byteLength(f.calls.creates[0]!.text), 16384);
});

test("pasted controls/suspected secrets/line breaks in title are explicit rejections without saves", async (t) => {
	const f = fixture(t, 0); await settle(); await key(f, "n");
	await key(f, paste("bad\ntitle")); assert.equal(f.ui.isDirty(), false);
	await key(f, paste("safe title")); await key(f, "\t"); await key(f, paste("safe\x1b]52;c;private\x07"));
	await key(f, "\x13"); assert.equal(f.calls.creates.length, 0);
	await key(f, paste("password=synthetic-example-do-not-use")); await key(f, "\x13");
	assert.match(f.screen(), /suspected secret/); assert.equal(f.calls.creates.length, 0);
});

test("public grapheme editing and IME cursor survive tiny widths/heights, focus, resize and theme invalidation", async (t) => {
	const f = fixture(t, 0); await settle(); await key(f, "n");
	const grapheme = "👨‍👩‍👧‍👦"; await key(f, paste("中é" + grapheme));
	await key(f, LEFT); await key(f, "\x1b[3~"); // Delete whole family, not one surrogate/joiner.
	await key(f, "\t"); await key(f, paste("中文🙂 é\n".repeat(30))); await key(f, LEFT);
	for (const width of [0, 1, 2, 3, 4, 12, 24, 80, 120, 300]) {
		for (const height of [0, 1, 2, 4, 8, 14, 36]) {
			const lines = f.lines(width, height); bounds(lines, width, height);
			assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, width > 0 && height > 0 ? 1 : 0, `${width}x${height}`);
		}
	}
	f.ui.focused = false; assert.ok(!f.lines().join("").includes(CURSOR_MARKER));
	f.ui.focused = true; f.theme.fg = ((_color: unknown, text: string) => `\x1b[37m${text}\x1b[0m`) as Theme["fg"];
	f.ui.invalidate(); bounds(f.lines(), 120, 36);
	await key(f, "\x13"); await reviewAll(f); await key(f, "y");
	assert.equal(f.calls.creates[0]?.title, "中é");
});

test("split paste framing comes before every shortcut and drops prefix/suffix keys, even reviews", async (t) => {
	const f = fixture(t, 1); await settle();
	for (const payload of ["n", "e", "d", " ", "\x04", "\x13", "\x1b", "y\r", "\x1bOQ"]) {
		await key(f, paste(payload) + "n\r");
	}
	assert.equal(f.closed(), 0); assert.equal(f.calls.gets.length, 0); assert.equal(f.calls.creates.length, 0); assert.equal(f.calls.deletes.length, 0);
	await edit(f); await key(f, "\x05");
	await key(f, "\x1b[20"); await key(f, "0~ appended"); await key(f, "\x1b[20"); await key(f, "1~\x13");
	assert.ok(f.ui.isDirty()); assert.ok(!f.screen().includes("SAVE REVIEW"));
	await key(f, "\x13"); f.screen();
	await key(f, "\x1b[20"); await key(f, "0~y\r"); await key(f, "\x1b[201~y\r");
	assert.equal(f.calls.updates.length, 0);
	await reviewAll(f); await key(f, "y"); assert.equal(f.calls.updates.length, 1);
});

test("single deletion and selected-batch deletion show exact IDs/titles/scopes and require every page", async (t) => {
	const f = fixture(t, 8, { columns: 70, rows: 18 }); await settle();
	for (let i = 0; i < 8; i++) { await key(f, " "); await key(f, DOWN); }
	await key(f, "\x04"); assert.equal(f.calls.gets.length, 8); assert.match(f.screen(), /8 exact note/);
	await key(f, "y"); assert.equal(f.calls.deletes.length, 0); assert.match(f.screen(), /Approval blocked/);
	let reviewed = "";
	for (let limit = 0; limit < 100; limit++) {
		reviewed += f.screen() + "\n";
		const match = /Review page (\d+)\/(\d+)/.exec(f.screen())!;
		if (match[1] === match[2]) break;
		await key(f, PGDN);
	}
	for (const r of f.records) { assert.ok(reviewed.includes(r.id)); assert.ok(reviewed.includes(r.title)); }
	await key(f, "y"); assert.equal(f.calls.deletes[0]?.expected.length, 8); assert.equal(f.records.length, 0);
	const g = fixture(t, 1); await settle(); await key(g, "\r"); await key(g, "\x1b[3;5~"); await reviewAll(g); await key(g, "\r");
	assert.equal(g.calls.deletes[0]?.expected[0]?.title, "Note 000");
});

test("selection stays across pages, caps at 50, clears on filters; explicit single bypasses selected batch", async (t) => {
	const f = fixture(t, 60); await settle();
	for (let p = 0; p < 3; p++) {
		for (let i = 0; i < 20; i++) { await key(f, " "); await key(f, DOWN); }
		if (p < 2) { await key(f, PGDN); for (let i = 0; i < 20; i++) await key(f, UP); }
	}
	assert.match(f.screen(), /Selection limit is 50/);
	await key(f, "\x1b[3;5~"); await reviewAll(f); await key(f, "y"); assert.equal(f.calls.deletes[0]?.expected.length, 1);
	await key(f, "\x1bOQ"); assert.match(f.screen(), /Selected 0\/50/);
});

test("dirty Escape then Enter requires visible discard review; cancellation keeps draft; clean close disposes once", async (t) => {
	const f = fixture(t, 0); await settle(); await key(f, "n"); await key(f, paste("Unsaved"));
	await back(f); assert.match(f.screen(), /DISCARD DRAFT/); assert.equal(f.closed(), 0); assert.ok(f.ui.isDirty());
	await key(f, paste("y\r\x1b")); assert.ok(f.ui.isDirty());
	await key(f, "n"); assert.match(f.screen(), /Create note/); assert.ok(f.ui.isDirty());
	await back(f); await reviewAll(f); await key(f, "y"); assert.equal(f.ui.isDirty(), false);
	await back(f); assert.equal(f.closed(), 1); f.ui.dispose(); f.ui.handleInput("\x1b"); assert.equal(f.closed(), 1);
	assert.deepEqual(f.lines(), []); assert.equal(f.calls.creates.length, 0);
});

test("save conflict preserves complete draft and exact expected record; explicit reload discards only after review", async (t) => {
	const f = fixture(t, 1); await edit(f); await key(f, "\x05"); await key(f, paste(" changed locally"));
	const expected = structuredClone(f.records[0]!); f.records[0]!.text = "EXTERNAL body"; f.notify();
	assert.ok(f.ui.isDirty()); assert.equal(f.calls.gets.length, 1);
	await key(f, "\x13"); await reviewAll(f); await key(f, "y");
	assert.match(f.screen(), /Conflict/); assert.match(f.screen(), /changed locally/); assert.ok(f.ui.isDirty());
	assert.deepEqual(f.calls.updates[0]?.expected, expected);
	await key(f, "\x13"); assert.equal(f.calls.updates.length, 1); assert.match(f.screen(), /Ctrl\+R/);
	await key(f, "\x12"); assert.match(f.screen(), /DISCARD DRAFT/); assert.equal(f.calls.gets.length, 1);
	await reviewAll(f); await key(f, "y"); assert.equal(f.calls.gets.length, 2); assert.equal(f.ui.isDirty(), false); assert.match(f.screen(), /EXTERNAL body/);
});

test("collision/tombstone/unknown failures preserve drafts and sanitize errors without automatic write replay", async (t) => {
	for (const message of ["title collision", "tombstone: forgotten title", "SQL parser PRIVATE synthetic secret content"]) {
		const f = fixture(t, 0); f.backend.create = () => { f.calls.creates.push({ title: "call", text: "", scope: "project", category: "project" }); throw new Error(message); };
		await settle(); await key(f, "n"); await replace(f, "Draft title", "Draft body"); await key(f, "\x13"); await reviewAll(f); await key(f, "y");
		assert.ok(f.ui.isDirty()); assert.match(f.screen(), /Draft title/); assert.ok(!f.screen().includes("PRIVATE"));
		await settle(); for (let i = 0; i < 10; i++) f.screen(); assert.equal(f.calls.creates.length, 1);
	}
});

test("concurrent deletion compare failure neither clears selection nor retries", async (t) => {
	const f = fixture(t, 2); await settle(); await key(f, " "); await key(f, DOWN); await key(f, " "); await key(f, "\x04");
	f.records[0]!.updatedAt++; f.notify(); await reviewAll(f); await key(f, "y");
	assert.equal(f.records.length, 2); assert.equal(f.calls.deletes.length, 1); assert.match(f.screen(), /Conflict/);
	for (let i = 0; i < 5; i++) f.screen(); assert.equal(f.calls.deletes.length, 1);
});

test("save/deletion/discard approval requires fresh focused render, every page, stable dimensions and valid layout", async (t) => {
	const f = fixture(t, 0); await settle(); await key(f, "n"); await replace(f, "Review guard", "body");
	f.ui.handleInput("\x13"); f.ui.handleInput("y"); await settle(); assert.equal(f.calls.creates.length, 0);
	f.screen(); f.ui.focused = false; f.ui.handleInput("y"); await settle(); assert.equal(f.calls.creates.length, 0);
	f.ui.focused = true; f.ui.handleInput("y"); await settle(); assert.equal(f.calls.creates.length, 0);
	f.screen(); f.terminal.columns--; f.ui.handleInput("y"); await settle(); assert.equal(f.calls.creates.length, 0);
	f.ui.render(29, 9); f.ui.handleInput("y"); await settle(); assert.equal(f.calls.creates.length, 0);
	f.ui.invalidate(); f.ui.handleInput("y"); await settle(); assert.equal(f.calls.creates.length, 0);
	await reviewAll(f); await key(f, "y"); assert.equal(f.calls.creates.length, 1);
});

test("policy observation wipes drafts/reviews/data and permanently pauses this owner without render I/O", async (t) => {
	const f = fixture(t, 1); await edit(f); await key(f, paste("private draft")); await key(f, "\x13"); f.deny(); f.notify();
	assert.equal(f.ui.isDirty(), false); const text = f.screen(); assert.match(text, /Memory access paused/);
	for (const phrase of ["private draft", "Note 000", "Body 0", "session-0", "SAVE REVIEW", "PRIVATE fake"]) assert.ok(!text.includes(phrase));
	const lists = f.calls.lists.length, gets = f.calls.gets.length; f.allow();
	for (const input of ["y", "r", "n", "\x13", "\x04"]) await key(f, input);
	assert.equal(f.calls.lists.length, lists); assert.equal(f.calls.gets.length, gets); assert.equal(f.calls.updates.length, 0);
	await back(f); assert.equal(f.closed(), 1);
});

test("late read/write/list success and rejection after disposal/invalidation never show or call stale done", async (t) => {
	for (const action of ["read", "write", "list"] as const) {
		for (const stop of ["dispose", "invalidate"] as const) {
			const f = fixture(t, 1); await settle();
			let resolve!: (value: any) => void;
			const deferred = new Promise<any>((r) => { resolve = r; });
			if (action === "read") { f.backend.get = () => deferred; f.ui.handleInput("\r"); }
			else if (action === "list") { f.backend.list = () => deferred; f.ui.handleInput("r"); }
			else {
				await edit(f); await key(f, paste(" local")); await key(f, "\x13"); await reviewAll(f);
				f.backend.update = () => deferred; f.ui.handleInput("y");
			}
			if (stop === "dispose") f.ui.dispose(); else f.ui.invalidateAccess("synthetic owner reset");
			resolve(action === "list" ? { records: [], total: 0, offset: 0, nextOffset: null } : note(99, f.project)); await settle();
			assert.equal(f.closed(), 0); assert.equal(f.ui.isDirty(), false); assert.ok(!f.screen().includes("Note 099"));
		}
	}
	const g = fixture(t, 1); await settle(); let reject!: (reason: Error) => void;
	g.backend.get = () => new Promise((_resolve, r) => { reject = r; }); g.ui.handleInput("\r"); g.ui.dispose(); reject(new Error("late private failure")); await settle();
	assert.deepEqual(g.lines(), []); assert.equal(g.closed(), 0);
});

test("reset in split paste drains remaining payload rather than treating it as close/approval", async (t) => {
	const f = fixture(t, 0); await settle(); await key(f, "n"); await key(f, "\x1b[200~draft"); f.ui.invalidateAccess("session reset");
	await key(f, "\x1b\x13y\r\x1b[201~\x1b"); assert.equal(f.closed(), 0); assert.equal(f.calls.creates.length, 0);
	await back(f); assert.equal(f.closed(), 1);
});

test("observer flags cached browser out-of-date without record reads or replacing dirty form", async (t) => {
	const f = fixture(t, 1); await edit(f); await key(f, paste(" local"));
	const calls = [f.calls.lists.length, f.calls.gets.length]; f.notify();
	assert.deepEqual([f.calls.lists.length, f.calls.gets.length], calls); assert.ok(f.ui.isDirty()); assert.match(f.screen(), /local/); assert.match(f.screen(), /Notes changed/);
});

test("regular mouse is terminal-owned; only public normalized fullscreen wheel navigates cached view", async (t) => {
	const f = fixture(t, 1); await settle(); await key(f, "\r");
	const event = { type: "wheel", wheelDelta: 2 } as TuiMouseEvent;
	assert.equal(f.ui.handleMouse(event), undefined);
	Object.defineProperty(f.tui, "mode", { value: "fullscreen" }); const gets = f.calls.gets.length;
	assert.equal(f.ui.handleMouse(event)?.handled, true); assert.equal(f.calls.gets.length, gets);
	await key(f, "\x1b[200~"); assert.equal(f.ui.handleMouse(event)?.render, false);
});

test("real public TUI focus/overlay rendering carries child cursor and closes the custom owner only explicitly", async (t) => {
	const f = fixture(t, 0, { real: true }); await settle();
	const overlay = f.tui.showOverlay(f.ui, { width: "90%", maxHeight: "90%" }); f.tui.renderNow();
	assert.equal(f.ui.focused, true); await key(f, "n"); await key(f, paste("Public TUI"));
	assert.ok(f.lines().join("").includes(CURSOR_MARKER)); f.tui.renderNow();
	overlay.unfocus({ target: null }); assert.equal(f.ui.focused, false);
	f.ui.handleInput("\x13"); assert.ok(!f.screen().includes("SAVE REVIEW"));
	overlay.focus(); f.tui.renderNow(); assert.equal(f.ui.focused, true);
	f.ui.dispose(); assert.equal(f.closed(), 0); overlay.hide();
});

test("all opener/end framing splits including lone ESC and field/review pastes cannot become actions", async (t) => {
	const f = fixture(t, 0); await settle(); await key(f, "n");
	const start = "\x1b[200~", end = "\x1b[201~";
	for (let split = 1; split < start.length; split++) {
		await key(f, start.slice(0, split)); await key(f, start.slice(split) + "x");
		await key(f, end.slice(0, split)); await key(f, end.slice(split) + "\x13\x1b");
	}
	assert.equal(f.closed(), 0); assert.equal(f.calls.creates.length, 0); assert.match(f.screen(), /5\/160/);
	await key(f, "\t"); await key(f, paste("body")); await key(f, "\t");
	await key(f, paste(" \r\x1b\x13")); await key(f, "\t"); await key(f, paste(" \r\x1b\x13"));
	assert.match(f.screen(), /Category: project/); assert.match(f.screen(), /Scope: project/);
	await key(f, "\x13"); await reviewAll(f);
	await key(f, "\x1b[2"); await key(f, "00~y\r"); await key(f, "\x1b[201~y\r"); assert.equal(f.calls.creates.length, 0);
	await key(f, "y"); assert.equal(f.calls.creates[0]?.title, "xxxxx"); assert.equal(f.calls.creates[0]?.scope, "project");
});

test("exact 50-note batch review across result pages is bounded and approves only reviewed versions", async (t) => {
	const f = fixture(t, 50); await settle();
	for (let page = 0; page < 3; page++) {
		const count = page < 2 ? 20 : 10;
		for (let i = 0; i < count; i++) { await key(f, " "); await key(f, DOWN); }
		if (page < 2) { await key(f, PGDN); for (let i = 0; i < 20; i++) await key(f, UP); }
	}
	await key(f, "\x04"); assert.equal(f.calls.gets.length, 50); assert.match(f.screen(), /50 exact note/);
	await key(f, "y"); assert.equal(f.calls.deletes.length, 0);
	await reviewAll(f); await key(f, "y"); assert.equal(f.calls.deletes[0]?.expected.length, 50); assert.equal(f.records.length, 0);
});

test("tiny title cursor and duplicate title respect Unicode graphemes without split-surrogate truncation", async (t) => {
	const f = fixture(t, 1); f.records[0]!.title = "x".repeat(153) + "👨‍👩‍👧‍👦"; await settle(); await key(f, "d");
	for (const width of [1, 2, 3, 4, 12]) {
		const lines = f.lines(width, 1); bounds(lines, width, 1); assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
	}
	await key(f, "\x13"); await reviewAll(f); await key(f, "y");
	assert.equal(f.calls.creates[0]?.title, "x".repeat(153) + " copy");
});

test("help is discoverable and complete via scrolling without loading records or changing drafts", async (t) => {
	const f = fixture(t, 0, { columns: 70, rows: 18 }); await settle(); await key(f, "n"); await key(f, paste("draft"));
	await key(f, "\x1bOP"); assert.match(f.screen(), /human administration/);
	let text = "";
	for (let i = 0; i < 30; i++) { text += f.screen(); await key(f, PGDN); }
	assert.match(text, /Ctrl\+S/); assert.match(text, /F2 scope/); assert.match(text, /Ctrl\+Delete/);
	assert.equal(f.calls.gets.length, 0); await back(f); assert.ok(f.ui.isDirty()); assert.match(f.screen(), /draft/);
});

test("native StdinBuffer delayed lone-ESC paste opener never exits or reaches underlying Input", async (t) => {
	const f = nativeFixture(t); await settle();
	f.buffer.process("\x1b"); await delay(25);
	assert.deepEqual(f.packets, ["\x1b"], "probe must actually exercise the host's timed-out lone ESC");
	f.buffer.process("[200~SYNTHETIC_PASTED_NOTE_CANARY\r\x1b[201~"); await delay(60);
	assert.deepEqual({ closed: f.closed(), value: f.ordinary.getValue(), submissions: f.submissions }, { closed: 0, value: "", submissions: [] });
	assert.equal(f.tui.getFocusedComponent(), f.ui);
	assert.equal(f.calls.creates.length + f.calls.updates.length + f.calls.deletes.length, 0);
});

test("Escape arming is deterministic: second ESC never exits, other keys are swallowed, and focus loss disarms", async (t) => {
	const f = fixture(t, 0); await settle();
	await key(f, "\x1b"); assert.equal(f.closed(), 0); assert.match(f.screen(), /Escape pending/);
	await key(f, "\x1b"); assert.equal(f.closed(), 0);
	await key(f, "n"); assert.equal(f.closed(), 0); assert.ok(!f.screen().includes("Create note"));
	await key(f, "\x1b"); f.ui.focused = false; f.ui.focused = true;
	await key(f, "\r"); assert.equal(f.closed(), 0); assert.equal(f.calls.gets.length, 0);
	// A complete Kitty Escape has the same gesture; its release packet is not a second action.
	await key(f, "\x1b[27u"); await key(f, "\x1b[27;1:3u"); assert.equal(f.closed(), 0);
	await key(f, "\r"); assert.equal(f.closed(), 1);
});

function fragments(text: string, cuts: number): string[] {
	const result: string[] = []; let start = 0;
	for (let index = 1; index < text.length; index++) if (cuts & (1 << (index - 1))) { result.push(text.slice(start, index)); start = index; }
	result.push(text.slice(start)); return result;
}
test("all 32 delimiter partitions drain valid paste before browser and review keys, including bytewise ESC", async (t) => {
	const f = fixture(t, 1); await settle();
	const start = "\x1b[200~", end = "\x1b[201~";
	const drain = async (cuts: number) => {
		for (const chunk of fragments(start, cuts)) await key(f, chunk);
		await key(f, "CANARY\rnedy \x13\x04\x1b\t\x06");
		for (const chunk of fragments(end, cuts)) await key(f, chunk);
	};
	for (let cuts = 0; cuts < 32; cuts++) await drain(cuts);
	assert.equal(f.closed(), 0); assert.equal(f.calls.gets.length, 0); assert.equal(f.calls.lists.length, 1);
	assert.match(f.screen(), /Selected 0\/50/);
	await edit(f); await key(f, "\x13"); await reviewAll(f);
	for (let cuts = 0; cuts < 32; cuts++) await drain(cuts);
	assert.equal(f.calls.updates.length, 0); assert.match(f.screen(), /SAVE REVIEW/);
	await reviewAll(f); await key(f, "y"); assert.equal(f.calls.updates.length, 1);
});

test("user Escape followed by a new split paste opener cannot close or authorize save/delete/discard", async (t) => {
	for (const review of ["save", "delete", "discard"] as const) {
		const f = fixture(t, 1); await settle();
		if (review === "delete") await key(f, "\x04");
		else { await edit(f); await key(f, paste(" locally changed")); if (review === "save") await key(f, "\x13"); else await back(f); }
		await reviewAll(f);
		await key(f, "\x1b"); assert.match(f.screen(), /Escape pending/);
		await key(f, "\x1b"); assert.equal(f.closed(), 0);
		for (const chunk of ["[", "2", "0", "0", "~y\r\x13\x04\x1b", "\x1b", "[", "2", "0", "1", "~"]) await key(f, chunk);
		assert.match(f.screen(), /REVIEW/); assert.equal(f.closed(), 0);
		assert.equal(f.calls.creates.length + f.calls.updates.length + f.calls.deletes.length, 0);
		if (review !== "delete") assert.ok(f.ui.isDirty());
		await back(f); assert.ok(!f.screen().includes("REVIEW")); // Enter resolves cancellation, never approval.
		assert.equal(f.calls.updates.length + f.calls.deletes.length, 0);
	}
});

test("native StdinBuffer timed-out paste START/END at every boundary and multiple delayed packets retain ownership", async (t) => {
	const start = "\x1b[200~", end = "\x1b[201~";
	for (let split = 1; split < start.length; split++) {
		const f = nativeFixture(t); await settle();
		f.buffer.process(start.slice(0, split)); await delay(split === 1 ? 25 : 70);
		assert.ok(f.packets.includes(start.slice(0, split)), "partial opener must really time out at the public host");
		f.buffer.process(start.slice(split) + "SYNTHETIC_DELAYED_CANARY\rnedy \x13\x04\x1b" + end.slice(0, split));
		await delay(70); f.buffer.process(end.slice(split)); await delay(70);
		assert.equal(f.closed(), 0, `boundary ${split}`); assert.equal(f.tui.getFocusedComponent(), f.ui);
		assert.equal(f.ordinary.getValue(), ""); assert.deepEqual(f.submissions, []);
		assert.equal(f.calls.gets.length, 0); assert.equal(f.calls.lists.length, 1); assert.match(f.screen(), /Selected 0\/50/);
		f.buffer.destroy(); f.tui.stop();
	}
	const f = nativeFixture(t); await settle();
	// A user Escape, then a second ESC that is the start of a paste, separated beyond host timeouts.
	f.buffer.process("\x1b"); await delay(25);
	for (const chunk of start) { f.buffer.process(chunk); await delay(70); }
	f.buffer.process("SYNTHETIC_BYTEWISE_CANARY\ry\x13\x04");
	for (const chunk of end) { f.buffer.process(chunk); await delay(70); }
	assert.equal(f.closed(), 0); assert.equal(f.tui.getFocusedComponent(), f.ui);
	assert.equal(f.ordinary.getValue(), ""); assert.deepEqual(f.submissions, []);
	assert.equal(f.calls.gets.length + f.calls.creates.length + f.calls.updates.length + f.calls.deletes.length, 0);
});

test("native delayed framing cannot approve a displayed save, deletion or dirty discard review", async (t) => {
	for (const kind of ["save", "delete", "discard"] as const) {
		const f = nativeFixture(t); await settle();
		if (kind === "delete") await key(f, "\x04");
		else { await edit(f); await key(f, paste(" local draft")); if (kind === "save") await key(f, "\x13"); else await back(f); }
		await reviewAll(f); f.tui.renderNow();
		f.buffer.process("\x1b"); await delay(25); f.buffer.process("[2"); await delay(70);
		f.buffer.process("00~y\r\x1b\x13\x04\x1b[20"); await delay(70); f.buffer.process("1~"); await delay(70);
		assert.match(f.screen(), /REVIEW/); assert.equal(f.closed(), 0); assert.equal(f.tui.getFocusedComponent(), f.ui);
		assert.equal(f.calls.updates.length + f.calls.creates.length + f.calls.deletes.length, 0);
		assert.equal(f.ordinary.getValue(), ""); assert.deepEqual(f.submissions, []);
		if (kind !== "delete") assert.ok(f.ui.isDirty());
	}
});

test("fresh native Escape then Enter positive control closes once and returns focus without note submission", async (t) => {
	const f = nativeFixture(t); await settle();
	f.buffer.process("\x1b"); await delay(25);
	assert.equal(f.closed(), 0); assert.equal(f.tui.getFocusedComponent(), f.ui); assert.match(f.screen(), /Escape pending/);
	f.buffer.process("\r"); await settle();
	assert.equal(f.closed(), 1); assert.equal(f.tui.getFocusedComponent(), f.ordinary);
	assert.equal(f.ordinary.getValue(), ""); assert.deepEqual(f.submissions, []); assert.deepEqual(f.lines(), []);
	// Fresh post-exit human input works: this is a paste boundary, not a trusted-TTY sandbox.
	f.buffer.process("synthetic human input after verified exit");
	assert.equal(f.ordinary.getValue(), "synthetic human input after verified exit"); assert.deepEqual(f.submissions, []);
});

test("narrow browser shows F1 and Escape-then-Enter early, with bracketed active filter and useful selection hints", async (t) => {
	const f = fixture(t, 1, { columns: 99 }); await settle();
	for (const width of [40, 80, 99]) {
		const lines = f.lines(width); bounds(lines, width, 36);
		assert.match(stripTerminalSequences(lines.at(-2)!), /^F1 help.*Esc then Enter close/);
		assert.match(stripTerminalSequences(lines.at(-3)!), /Selected 0\/50.*Space select/);
	}
	for (const label of ["List", "Scope: current", "Category: any", "Source: any", "Sort: updated", "Search"]) {
		assert.ok(stripTerminalSequences(f.lines(24)[2]!).startsWith(`[${label}]`), label);
		await key(f, "\t");
	}
	assert.equal(f.calls.lists.length, 1); assert.equal(f.calls.gets.length, 0);
	assert.ok(f.lines(80).at(-3)!.includes("Ctrl+F search"));
});
