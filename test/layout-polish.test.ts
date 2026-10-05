import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderJarvisActivity, renderJarvisHeader, renderJarvisControls, type JarvisHeaderOptions } from "../overlay-layout.js";
import type { JarvisOverlaySnapshot, JarvisOverlayView } from "../overlay.js";

const plainTheme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const collapsed: JarvisHeaderOptions = { expanded: false, focusTarget: "input", focused: true };
const focusTargets = ["input", "tools", "followUp", "steer"] as const;
const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const forbidden = () => { throw new Error("layout must not perform actions or inspect transcript/activity"); };

function fixture(overrides: Partial<JarvisOverlayView> = {}): JarvisOverlayView {
	return {
		isReady: forbidden,
		isStreaming: forbidden,
		getModelLabel: () => "openai-codex/gpt-side",
		getModelModeLabel: () => "pinned project",
		getMainStatusLabel: () => "idle",
		getMainModelLabel: () => "openai-codex/gpt-main",
		getMainFocusLabel: () => "reviewing layout",
		getMainDeltaLabel: () => "3 new messages",
		getRepoToolsDetailLabel: () => "trusted project; read/bash/edit/write only",
		isToolAccessEnabled: () => false,
		isFollowUpToMainEnabled: () => false,
		isSteerToMainEnabled: () => false,
		toggleToolAccess: forbidden,
		toggleFollowUpToMain: forbidden,
		toggleSteerToMain: forbidden,
		getDisplayEntries: forbidden,
		sendMessage: forbidden,
		...overrides,
	};
}

function recordingTheme(colorOffset = 0) {
	const calls: { role: string; text: string }[] = [];
	const codes: Record<string, number> = { accent: 36, dim: 90, muted: 37, success: 32, warning: 33 };
	const theme = {
		fg: (role: string, text: string) => {
			assert.ok(role in codes, `non-semantic color: ${role}`);
			assert.ok(!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text), "theme received untrusted terminal controls");
			calls.push({ role, text });
			return `\x1b[${codes[role] + colorOffset}m${text}\x1b[39m`;
		},
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	return { theme, calls };
}

function assertBounds(lines: string[], width: number) {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
		// Theme styling and Pi's truncation reset are the only permitted sequences.
		const unstyled = line.replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(unstyled), JSON.stringify(line));
		assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(unstyled), "split surrogate pair");
	}
}

test("default header is three compact rows, with side model, main focus and named permissions", () => {
	const rows = plain(renderJarvisHeader(plainTheme, fixture(), 80, collapsed));
	assert.deepEqual(rows, [
		"Jarvis · Main idle · gpt-side",
		"Focus: reviewing layout",
		"Repo tools: off  Note main: off  Redirect: off",
	]);
	assert.ok(!rows.join("\n").includes("openai-codex"));
	assert.ok(!/Since last|Access|Models|pinned project|gpt-main/.test(rows.join("\n")));
});

test("collapsed rendering does not even request detail getters", () => {
	const view = fixture({
		getMainModelLabel: forbidden,
		getModelModeLabel: forbidden,
		getMainDeltaLabel: forbidden,
		getRepoToolsDetailLabel: forbidden,
	});
	assert.equal(renderJarvisHeader(plainTheme, view, 80, collapsed).length, 3);
});

test("expanded details include both full models, mode, delta and access, keeping permissions last", () => {
	const view = fixture();
	const compact = renderJarvisHeader(plainTheme, view, 80, collapsed);
	const rows = plain(renderJarvisHeader(plainTheme, view, 80, { ...collapsed, expanded: true }));
	assert.deepEqual(rows, [
		"Jarvis · Main idle · gpt-side",
		"Focus: reviewing layout",
		"Main model: openai-codex/gpt-main",
		"Jarvis model: openai-codex/gpt-side (pinned project)",
		"Since last: 3 new messages",
		"Access: trusted project; read/bash/edit/write only",
		"Repo tools: off  Note main: off  Redirect: off",
	]);
	assert.deepEqual(renderJarvisHeader(plainTheme, view, 80, collapsed), compact, "no retained details state");
});

test("focused permission names and state remain first and complete on narrow rows", () => {
	for (const expanded of [false, true]) {
		for (const [focusTarget, label] of [["tools", "Repo tools"], ["followUp", "Note main"], ["steer", "Redirect"]] as const) {
			for (const width of [17, 20, 24, 28, 40]) {
				const rows = renderJarvisHeader(plainTheme, fixture(), width, { expanded, focusTarget, focused: true });
				assert.ok(plain(rows).at(-1)!.startsWith(`[${label}: off]`), `${width}: ${plain(rows).at(-1)}`);
				assertBounds(rows, width);
			}
			const minimum = renderJarvisHeader(plainTheme, fixture(), label.length, { expanded, focusTarget, focused: true });
			assert.equal(plain(minimum).at(-1), label, "retain complete name when only the name fits");
		}
	}
});

test("wide permissions retain canonical order; inactive overlay has no focus brackets", () => {
	const view = fixture({ isToolAccessEnabled: () => true, isSteerToMainEnabled: () => true });
	for (const focusTarget of focusTargets) {
		const options = { ...collapsed, focusTarget };
		const row = plain(renderJarvisHeader(plainTheme, view, 80, options)).at(-1)!;
		assert.ok(row.indexOf("Repo tools") < row.indexOf("Note main"));
		assert.ok(row.indexOf("Note main") < row.indexOf("Redirect"));
		assert.equal(row.includes("["), focusTarget !== "input");
		const inactive = plain(renderJarvisHeader(plainTheme, view, 80, { ...options, focused: false })).at(-1)!;
		assert.equal(inactive, "Repo tools: on  Note main: off  Redirect: on");
	}
});

test("narrow permission rows omit whole secondary controls rather than clipping their state", () => {
	const row = plain(renderJarvisHeader(plainTheme, fixture(), 28, { ...collapsed, focusTarget: "steer" })).at(-1)!;
	assert.equal(row, "[Redirect: off] …");
	assert.ok(!row.includes("Repo") && !row.includes("Note"));
});

test("busy, idle, unknown and enabled permissions use semantic colors", () => {
	for (const [status, role] of [["busy", "warning"], ["idle", "success"], ["unavailable", "muted"]]) {
		const recorded = recordingTheme();
		renderJarvisHeader(recorded.theme, fixture({ getMainStatusLabel: () => status, isToolAccessEnabled: () => true }), 80, collapsed);
		assert.ok(recorded.calls.some((call) => call.text === status && call.role === role));
		assert.ok(recorded.calls.some((call) => call.text === "Repo tools: on" && call.role === "success"));
		assert.ok(recorded.calls.some((call) => call.text === "Note main: off" && call.role === "muted"));
	}
});

test("rendering always uses the supplied theme without retaining styled strings", () => {
	const view = fixture();
	const firstTheme = recordingTheme();
	const secondTheme = recordingTheme(10);
	const options = { ...collapsed, focusTarget: "tools" as const, expanded: true };
	const first = renderJarvisHeader(firstTheme.theme, view, 80, options);
	const second = renderJarvisHeader(secondTheme.theme, view, 80, options);
	assert.deepEqual(plain(first), plain(second));
	assert.notDeepEqual(first, second);
	assert.ok(first.join("").includes("\x1b[36mJarvis"));
	assert.ok(second.join("").includes("\x1b[46mJarvis"));
	assert.ok(!second.join("").includes("\x1b[36m"));
	assertBounds(first, 80);
	assertBounds(second, 80);
});

test("all tiny widths, focus targets and detail modes stay bounded with wide Unicode", () => {
	const unicode = "中文👨‍👩‍👧‍👦🇯🇵e\u0301/🧪".repeat(5);
	const view = fixture({
		getModelLabel: () => `openai-codex/${unicode}`,
		getMainFocusLabel: () => unicode,
		getMainModelLabel: () => unicode,
		getModelModeLabel: () => unicode,
		getMainDeltaLabel: () => unicode,
		getRepoToolsDetailLabel: () => unicode,
	});
	for (const theme of [plainTheme, recordingTheme().theme]) {
		for (const expanded of [false, true]) {
			for (const focusTarget of focusTargets) {
				for (let width = 0; width <= 80; width++) {
					const rows = renderJarvisHeader(theme, view, width, { expanded, focusTarget, focused: true });
					assert.equal(rows.length, width === 0 ? 0 : expanded ? 7 : 3);
					assertBounds(rows, width);
				}
			}
		}
	}
});

test("truncation preserves emoji graphemes and compact model IDs containing slashes", () => {
	const family = "👨‍👩‍👧‍👦";
	const view = fixture({ getModelLabel: () => "openai-codex/中文/model", getMainFocusLabel: () => `中文${family}e\u0301 ending` });
	assert.ok(plain(renderJarvisHeader(plainTheme, view, 80, collapsed))[0]!.endsWith("中文/model"));
	for (let width = 1; width <= 30; width++) {
		const focus = plain(renderJarvisHeader(plainTheme, view, width, collapsed))[1]!;
		for (const member of ["👨", "👩", "👧", "👦"]) {
			if (focus.includes(member)) assert.ok(focus.includes(family), "split ZWJ grapheme");
		}
		if (focus.includes("e")) assert.ok(focus.includes("e\u0301"), "split combining mark");
	}
});

test("every untrusted label is flattened and CSI/OSC/DCS/C1 payloads are removed before theming", () => {
	const unsafe = "safe\x1b[2J\x9b38:2:1:2:3m label\x1b]8;;hidden-url\x07\x9d0;hidden-title\x9c"
		+ "\x1bPhidden-dcs\x1b\\\x90hidden-c1-dcs\x9c\x1b_hidden-apc\x1b\\ end\x00\x7f\x85\r\n\t\u2028\u2029next";
	const view = fixture({
		getModelLabel: () => unsafe,
		getMainStatusLabel: () => unsafe,
		getMainFocusLabel: () => unsafe,
		getMainModelLabel: () => unsafe,
		getModelModeLabel: () => unsafe,
		getMainDeltaLabel: () => unsafe,
		getRepoToolsDetailLabel: () => unsafe,
	});
	for (const theme of [plainTheme, recordingTheme().theme]) {
		const rows = renderJarvisHeader(theme, view, 200, { ...collapsed, expanded: true });
		assertBounds(rows, 200);
		const text = plain(rows).join("\n");
		assert.ok(!text.includes("hidden-"));
		assert.ok(text.includes("Focus: safe label end next"));
		assert.ok(text.includes("Since last: safe label end next"));
		assert.ok(text.includes("Access: safe label end next"));
	}
});

test("rendering is read-only and invalid widths request no view state", () => {
	const view = Object.freeze(fixture());
	const options = Object.freeze({ ...collapsed });
	assert.deepEqual(renderJarvisHeader(plainTheme, view, 80, options), renderJarvisHeader(plainTheme, view, 80, options));
	const emptyView = new Proxy({} as JarvisOverlayView, { get: forbidden });
	for (const width of [-1, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.deepEqual(renderJarvisHeader(plainTheme, emptyView, width, options), []);
	}
	assertBounds(renderJarvisHeader(plainTheme, view, 10.8, options), 10);
});

function activityFixture(state: { ready?: boolean; streaming?: boolean; processing?: boolean; queued?: number } = {}) {
	return fixture({
		isReady: () => state.ready ?? true,
		isStreaming: () => state.streaming ?? false,
		getIsProcessing: () => state.processing ?? false,
		getQueuedMessageCount: () => state.queued ?? 0,
	});
}

const snapshot: JarvisOverlaySnapshot = { statuses: [], notifications: [] };

test("activity priority covers startup, active work, queued and ready without stale working text", () => {
	const working = { ...snapshot, workingMessage: "Thinking about the layout" };
	for (const [state, expected] of [
		[{ ready: false, streaming: true, processing: true, queued: 2 }, "Starting Jarvis… · 2 queued"],
		[{ ready: false }, "Not ready"],
		[{ ready: false, queued: 2 }, "Waiting to start… · 2 queued"],
		[{ streaming: true, processing: true, queued: 2 }, "Working… · 2 queued · Thinking about the layout"],
		[{ processing: true, queued: 1 }, "Processing… · 1 queued · Thinking about the layout"],
		[{ queued: 3 }, "3 queued"],
		[{}, "Ready"],
	] as const) {
		assert.equal(stripTerminalSequences(renderJarvisActivity(plainTheme, working, activityFixture(state), 80)), expected);
	}
	assert.equal(renderJarvisActivity(plainTheme, snapshot, activityFixture({ streaming: true }), 80), "Working…");
	assert.equal(renderJarvisActivity(plainTheme, snapshot, activityFixture({ processing: true }), 80), "Processing…");
});

test("activity supports legacy views without optional queue/processing getters and clamps counts", () => {
	const legacy = fixture({ isReady: () => true, isStreaming: () => false });
	assert.equal(renderJarvisActivity(plainTheme, snapshot, legacy, 80), "Ready");
	for (const queued of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(renderJarvisActivity(plainTheme, snapshot, activityFixture({ queued }), 80), "Ready");
	}
	assert.equal(renderJarvisActivity(plainTheme, snapshot, activityFixture({ queued: 2.9 }), 80), "2 queued");
});

test("activity colors remain semantic and state/queue precede long working text", () => {
	for (const [state, text, role] of [
		[{ ready: false, processing: true }, "Starting Jarvis…", "warning"],
		[{ ready: false }, "Not ready", "warning"],
		[{ streaming: true }, "Working…", "accent"],
		[{ processing: true }, "Processing…", "accent"],
		[{ queued: 2 }, "2 queued", "warning"],
		[{}, "Ready", "success"],
	] as const) {
		const recorded = recordingTheme();
		renderJarvisActivity(recorded.theme, snapshot, activityFixture(state), 80);
		assert.ok(recorded.calls.some((call) => call.role === role && call.text === text));
	}
	const row = renderJarvisActivity(plainTheme, { ...snapshot, workingMessage: "very long custom work text".repeat(10) }, activityFixture({ streaming: true, queued: 2 }), 24);
	assert.ok(stripTerminalSequences(row).startsWith("Working… · 2 queued"));
	assertBounds([row], 24);
});

test("activity is a sanitized bounded row, ignoring notices, status and transcript contents", () => {
	const work: JarvisOverlaySnapshot = {
		statuses: ["hidden status"],
		notifications: [{ message: "hidden notification", type: "error", timestamp: 0 }],
		workingMessage: "中文👨‍👩‍👧‍👦\nlabel\x1b[2J\x1b]0;hidden payload\x07\r\tend",
	};
	for (const theme of [plainTheme, recordingTheme().theme]) {
		for (const state of [{ ready: false }, { streaming: true, queued: 2 }, { processing: true }, {}, { queued: 2 }]) {
			for (let width = 0; width <= 80; width++) {
				const row = renderJarvisActivity(theme, work, activityFixture(state), width);
				assertBounds([row], width);
				assert.ok(!row.includes("hidden"));
				if (width === 0) assert.equal(row, "");
			}
		}
	}
	const row = renderJarvisActivity(plainTheme, work, activityFixture({ streaming: true }), 80);
	assert.equal(stripTerminalSequences(row), "Working… · 中文👨‍👩‍👧‍👦 label end");
	const emptyView = new Proxy({} as JarvisOverlayView, { get: forbidden });
	assert.equal(renderJarvisActivity(plainTheme, snapshot, emptyView, 0), "");
});

test("picker/history controls retain discoverable shortcuts and focused target across widths/themes", () => {
	const view = fixture({ getThinkingLabel: () => "auto → high" });
	for (const theme of [plainTheme, recordingTheme().theme]) {
		for (const focusTarget of ["input", "model", "thinking", "history"] as const) {
			for (let width = 0; width <= 100; width++) {
				const row = renderJarvisControls(theme, view, width, { ...collapsed, focusTarget });
				assertBounds([row], width);
				if (width >= 48) {
					assert.ok(stripTerminalSequences(row).includes("F2 Model"));
					assert.ok(stripTerminalSequences(row).includes("F3 Thinking"));
				}
			}
		}
	}
	assert.match(renderJarvisControls(plainTheme, view, 80, collapsed), /auto → high/);
	assert.match(renderJarvisControls(plainTheme, view, 20, { ...collapsed, focusTarget: "history" }), /^\[History ↑\/↓\]/);
});
