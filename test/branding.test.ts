import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, styleText, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { INTRO_DURATION_MS, INTRO_FRAME_MS, JARVIS_LOGO, JARVIS_TAGLINE, JarvisIntroAnimation, renderJarvisIntro } from "../jarvis-branding.js";
import { JarvisOverlayBridge, JarvisOverlayComponent, type JarvisOverlayView } from "../overlay.js";

const theme = {
	appearance: "dark",
	fg: (_: string, text: string) => text,
	bold: (text: string) => text,
	style: (text: string, options: Parameters<typeof styleText>[1]) => styleText(text, options, "truecolor"),
} as unknown as Theme;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

function fixture() {
	const saved = { motion: process.env.PI_JARVIS_NO_ANIMATION, color: process.env.NO_COLOR, term: process.env.TERM };
	delete process.env.PI_JARVIS_NO_ANIMATION; delete process.env.NO_COLOR; process.env.TERM = "xterm-256color";
	const bridge = new JarvisOverlayBridge();
	const terminal = { columns: 100, rows: 40 };
	let closed = 0, toggled = 0, renders = 0;
	const sent: string[] = [];
	const host = { terminal, requestRender() { renders++; } } as unknown as TUI;
	const view: JarvisOverlayView = {
		isReady: () => true, isStreaming: () => false,
		getModelLabel: () => "test/side", getModelModeLabel: () => "follow main",
		getMainStatusLabel: () => "idle", getMainModelLabel: () => "test/main",
		getMainFocusLabel: () => "", getMainDeltaLabel: () => "",
		getRepoToolsDetailLabel: () => "repo tools off",
		isToolAccessEnabled: () => false, isFollowUpToMainEnabled: () => false, isSteerToMainEnabled: () => false,
		toggleToolAccess: () => { toggled++; }, toggleFollowUpToMain: () => { toggled++; }, toggleSteerToMain: () => { toggled++; },
		getDisplayEntries: () => [{ kind: "assistant", text: "Existing conversation" }],
		sendMessage: async (text) => { sent.push(text); },
	};
	const create = () => {
		const overlay = new JarvisOverlayComponent(host, theme, bridge, view, () => { closed++; }, undefined, { showIntro: true });
		overlay.focused = true; overlay.attachBridge(); return overlay;
	};
	const overlay = create();
	return { bridge, overlay, terminal, sent, create, toggled: () => toggled, closed: () => closed, renders: () => renders,
		dispose() {
			overlay.dispose();
			for (const [key, value] of [["PI_JARVIS_NO_ANIMATION", saved.motion], ["NO_COLOR", saved.color], ["TERM", saved.term]]) {
				if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
			}
		},
	};
}

test("ASCII frames share the README wordmark and stay bounded at every size", () => {
	for (const width of [0, 1, 4, 12, 30, 36, 40, 60, 100]) for (const height of [0, 1, 2, 7, 8, 20]) {
		for (const elapsed of [0, 700, INTRO_DURATION_MS]) {
			const lines = renderJarvisIntro(theme, width, height, elapsed);
			assert.ok(lines.length <= height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
	assert.ok(plain(renderJarvisIntro(theme, 80, 12, 0)).includes(JARVIS_TAGLINE));
	assert.equal(stripTerminalSequences(renderJarvisIntro(theme, 80, 12, 0)[6]!),
		" ".repeat(Math.floor((80 - JARVIS_TAGLINE.length) / 2)) + JARVIS_TAGLINE, "caption is centered, not padded to width before centering");
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	assert.ok(readme.includes(JARVIS_LOGO.join("\n")), "README fallback must use the same ASCII wordmark");
});

test("chrome sweep changes color, never glyphs; light themes and 256-color terminals work", () => {
	const first = renderJarvisIntro(theme, 80, 10, 0);
	const middle = renderJarvisIntro(theme, 80, 10, 900);
	assert.notDeepEqual(first, middle);
	assert.equal(plain(first), plain(middle));
	const light = { ...theme, appearance: "light" } as Theme;
	assert.notDeepEqual(renderJarvisIntro(light, 80, 10, 900), middle);
	const indexed = { ...theme, style: (text: string, options: Parameters<typeof styleText>[1]) => styleText(text, options, "256color") } as unknown as Theme;
	const lines = renderJarvisIntro(indexed, 80, 10, 900);
	assert.equal(plain(lines), plain(middle));
	assert.match(lines.join(""), /\x1b\[38;5;/);
	assert.doesNotMatch(lines.join(""), /\x1b\[38;2;|\x1b\[5m|\x1b\[2J/);
});

test("intro timer starts only on draw, stops at deadline, and cannot revive", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let now = 0, redraws = 0;
	const intro = new JarvisIntroAnimation(() => { redraws++; }, true, () => now);
	t.mock.timers.tick(5000); assert.equal(redraws, 0);
	assert.equal(intro.frame(), 0);
	now = 800; t.mock.timers.tick(INTRO_FRAME_MS);
	assert.equal(intro.frame(), 800); assert.equal(redraws, 1);
	now = INTRO_DURATION_MS; t.mock.timers.tick(INTRO_FRAME_MS);
	assert.equal(intro.frame(), undefined); assert.equal(redraws, 2);
	t.mock.timers.tick(10000); assert.equal(redraws, 2);
	intro.finish(); assert.equal(intro.frame(), undefined);
	const cancelled = new JarvisIntroAnimation(() => { redraws++; }, true, () => now);
	assert.equal(cancelled.frame(), 0);
	cancelled.finish(); assert.equal(cancelled.frame(), undefined);
	t.mock.timers.tick(10000); assert.equal(redraws, 2);
});

test("an actual intro timer is unreferenced and disposal stops future redraws", () => {
	const intro = new JarvisIntroAnimation(() => {}, true);
	intro.frame();
	const probe = intro as unknown as { timer?: NodeJS.Timeout };
	try { assert.equal(probe.timer?.hasRef(), false); }
	finally { intro.finish(); }
	assert.equal(probe.timer, undefined);
});

test("intro keeps permission controls and the editor visible; first input is not eaten", () => {
	const f = fixture();
	try {
		const first = f.overlay.render(80);
		assert.match(plain(first), /A SECOND LANE OF THOUGHT/);
		assert.match(plain(first), /Repo tools|Tools/);
		assert.ok(first.some((line) => line.includes(CURSOR_MARKER)));
		f.overlay.handleInput("h");
		assert.equal(f.bridge.getDraft(), "h");
		assert.match(plain(f.overlay.render(80)), /Existing conversation/);
		assert.doesNotMatch(plain(f.overlay.render(80)), /A SECOND LANE OF THOUGHT/);
		f.overlay.handleInput("i"); f.overlay.handleInput("\r");
		assert.deepEqual(f.sent, ["hi"]); assert.equal(f.toggled(), 0);
	} finally { f.dispose(); }
});

test("key-release packets do not dismiss the intro", () => {
	const f = fixture();
	try {
		f.overlay.render(80);
		f.overlay.handleInput("\x1b[97;1:3u");
		assert.match(plain(f.overlay.render(80)), /A SECOND LANE/);
		assert.equal(f.bridge.getDraft(), "");
	} finally { f.dispose(); }
});

test("paste skips decoration without executing pasted shortcuts or submitting", () => {
	const f = fixture();
	try {
		f.overlay.render(80);
		f.overlay.handleInput("\x1b[200~");
		f.overlay.handleInput("hello\n  world");
		f.overlay.handleInput("\x1b[201~");
		assert.equal(f.bridge.getDraft(), "hello\n  world");
		assert.equal(f.toggled(), 0); assert.deepEqual(f.sent, []);
		assert.doesNotMatch(plain(f.overlay.render(80)), /A SECOND LANE OF THOUGHT/);
		f.overlay.handleInput("\x1b"); assert.equal(f.closed(), 1);
		assert.deepEqual(f.overlay.render(80), []);
	} finally { f.dispose(); }
});

test("confirmation preempts intro and still requires visible review; errors preempt it too", async () => {
	const f = fixture();
	try {
		f.overlay.render(80);
		const confirmation = f.bridge.requestConfirmation("Review redirect", "Send this to main?");
		f.overlay.handleInput("y"); assert.ok(f.bridge.hasPendingConfirmation());
		const lines = plain(f.overlay.render(80));
		assert.match(lines, /Review redirect/); assert.doesNotMatch(lines, /A SECOND LANE/);
		f.overlay.handleInput("y"); assert.equal(await confirmation, true);
		const next = f.create();
		try {
			next.render(80); f.bridge.notify("Provider unavailable", "error");
			const output = plain(next.render(80));
			assert.match(output, /Provider unavailable/); assert.doesNotMatch(output, /A SECOND LANE/);
		} finally { next.dispose(); }
	} finally { f.dispose(); }
});

test("motion opt-out, NO_COLOR, and dumb terminals suppress intro", () => {
	const f = fixture();
	try {
		for (const [key, value] of [["PI_JARVIS_NO_ANIMATION", "1"], ["NO_COLOR", "1"], ["TERM", "dumb"]]) {
			const previous = process.env[key!]; process.env[key!] = value;
			const overlay = f.create();
			try { assert.doesNotMatch(plain(overlay.render(80)), /A SECOND LANE/); }
			finally { overlay.dispose(); if (previous === undefined) delete process.env[key!]; else process.env[key!] = previous; }
		}
	} finally { f.dispose(); }
});

test("resize never exceeds terminal bounds and a tiny terminal cancels decoration", () => {
	const f = fixture();
	try {
		f.overlay.render(80);
		for (const rows of [40, 12, 5, 2, 1, 0]) for (const width of [80, 30, 4, 1, 0]) {
			f.terminal.rows = rows; f.terminal.columns = width;
			const lines = f.overlay.render(width);
			assert.ok(lines.length <= rows); assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		f.terminal.rows = 40; f.terminal.columns = 100;
		assert.doesNotMatch(plain(f.overlay.render(80)), /A SECOND LANE/);
	} finally { f.dispose(); }
});

test("first PageUp or Alt+Up dismisses intro and scrolls instead of swallowing navigation", () => {
	for (const key of ["\x1b[5~", "\x1b[1;3A"]) {
		const f = fixture();
		try {
			assert.match(plain(f.overlay.render(80)), /A SECOND LANE/);
			f.overlay.handleInput(key);
			const output = plain(f.overlay.render(80));
			assert.doesNotMatch(output, /A SECOND LANE/);
			assert.match(output, /History ·/);
			assert.equal(f.bridge.getDraft(), "");
		} finally { f.dispose(); }
	}
});
