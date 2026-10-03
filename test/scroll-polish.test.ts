import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TranscriptViewport } from "../transcript-viewport.js";

const rows = (count: number) => Array.from({ length: count }, (_, i) => `Jarvis: row ${i}`);

const emptyStatus = {
	following: true, hiddenBelow: 0, totalLines: 0, startLine: 0, endLine: 0,
};

test("viewport starts at the tail and follows appended and streaming rows", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(10);
	assert.deepEqual(viewport.getStatus(), emptyStatus);
	assert.deepEqual(viewport.render(lines, 3, 40), lines.slice(-3));
	assert.deepEqual(viewport.getStatus(), {
		following: true, hiddenBelow: 0, totalLines: 10, startLine: 7, endLine: 10,
	});
	lines.push("Jarvis: streaming");
	assert.deepEqual(viewport.render(lines, 3, 40), lines.slice(-3));
	lines[10] += " update";
	assert.deepEqual(viewport.render(lines, 3, 40), lines.slice(-3));
});

test("PageUp pauses; appended streaming lines do not drag the read position", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(12);
	viewport.render(lines, 4, 40);
	viewport.pageUp();
	assert.deepEqual(viewport.getStatus(), {
		following: false, hiddenBelow: 4, totalLines: 12, startLine: 4, endLine: 8,
	});
	const reading = viewport.render(lines, 4, 40);
	lines[11] += " streaming update";
	lines.push(...rows(20));
	assert.deepEqual(viewport.render(lines, 4, 40), reading);
	assert.deepEqual(viewport.getStatus(), {
		following: false, hiddenBelow: 24, totalLines: 32, startLine: 4, endLine: 8,
	});
});

test("bounded source rollover retains a paused top row when it remains available", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(30);
	viewport.render(lines, 5, 40);
	viewport.pageUp();
	const reading = viewport.render(lines, 5, 40);
	lines.shift();
	lines.push("Jarvis: newest");
	assert.deepEqual(viewport.render(lines, 5, 40), reading);
	assert.equal(viewport.getStatus().startLine, 19);
	assert.equal(viewport.getStatus().following, false);
});

test("paused visible streaming text updates without changing the top index", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(4);
	viewport.render(lines, 5, 40);
	viewport.pageUp();
	lines[3] += " additional text";
	assert.deepEqual(viewport.render(lines, 5, 40), lines);
	assert.equal(viewport.getStatus().startLine, 0);
	assert.equal(viewport.getStatus().following, false);
});

test("page limits clamp, PageDown resumes at the tail, and toLatest is explicit", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(13);
	viewport.render(lines, 4, 40);
	for (let i = 0; i < 10; i++) viewport.pageUp();
	assert.deepEqual(viewport.render(lines, 4, 40), lines.slice(0, 4));
	assert.equal(viewport.getStatus().following, false);
	viewport.pageDown();
	assert.deepEqual(viewport.render(lines, 4, 40), lines.slice(4, 8));
	assert.equal(viewport.getStatus().following, false);
	viewport.pageDown();
	assert.equal(viewport.getStatus().startLine, 8);
	assert.equal(viewport.getStatus().following, false);
	viewport.pageDown();
	assert.deepEqual(viewport.render(lines, 4, 40), lines.slice(9));
	assert.equal(viewport.getStatus().following, true);
	viewport.pageDown();
	assert.equal(viewport.getStatus().startLine, 9);
	viewport.pageUp();
	viewport.toLatest();
	assert.equal(viewport.getStatus().following, true);
	assert.equal(viewport.getStatus().hiddenBelow, 0);
	lines.push("Jarvis: newest");
	assert.deepEqual(viewport.render(lines, 4, 40), lines.slice(-4));
});

test("short lists can pause before future append and resume without overscroll", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(2);
	assert.deepEqual(viewport.render(lines, 5, 40), lines);
	viewport.pageUp();
	assert.equal(viewport.getStatus().following, false);
	assert.equal(viewport.getStatus().startLine, 0);
	lines.push(...rows(6));
	assert.deepEqual(viewport.render(lines, 5, 40), lines.slice(0, 5));
	assert.equal(viewport.getStatus().hiddenBelow, 3);
	viewport.pageDown();
	assert.equal(viewport.getStatus().following, true);
	assert.deepEqual(viewport.render(lines, 5, 40), lines.slice(-5));
});

test("height resize preserves paused top, clamps sensibly, and updates page size", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(20);
	viewport.render(lines, 4, 40);
	viewport.pageUp();
	assert.deepEqual(viewport.render(lines, 2, 40), lines.slice(12, 14));
	viewport.pageUp();
	assert.deepEqual(viewport.render(lines, 2, 40), lines.slice(10, 12));
	assert.deepEqual(viewport.render(lines, 15, 40), lines.slice(5));
	assert.equal(viewport.getStatus().following, false, "resize to the tail does not resume live");
	assert.deepEqual(viewport.render(lines, 30, 40), lines);
	assert.equal(viewport.getStatus().startLine, 0);
	assert.equal(viewport.getStatus().following, false);
	viewport.pageDown();
	assert.equal(viewport.getStatus().following, true);
	assert.deepEqual(viewport.render(lines, 3, 40), lines.slice(-3));
});

test("same-width content shrink clamps a paused viewport without silently resuming", () => {
	const viewport = new TranscriptViewport();
	viewport.render(rows(20), 4, 40);
	viewport.pageUp();
	const smaller = rows(8);
	assert.deepEqual(viewport.render(smaller, 4, 40), smaller.slice(4));
	assert.deepEqual(viewport.getStatus(), {
		following: false, hiddenBelow: 0, totalLines: 8, startLine: 4, endLine: 8,
	});
	smaller.push("Jarvis: additional row");
	assert.deepEqual(viewport.render(smaller, 4, 40), smaller.slice(4, 8));
	assert.equal(viewport.getStatus().hiddenBelow, 1);
	viewport.pageDown();
	assert.equal(viewport.getStatus().following, true);
});

test("width reflow uses a bounded top-line anchor independent of ANSI theme", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(20);
	viewport.render(lines, 4, 40);
	viewport.pageUp();
	viewport.render(lines, 4, 40);
	const reflowed = [...rows(4).map((line) => `extra ${line}`), ...lines];
	reflowed[16] = `\x1b[32m${lines[12]}\x1b[0m`;
	const rendered = viewport.render(reflowed, 4, 30);
	assert.equal(stripTerminalSequences(rendered[0]!), lines[12]);
	assert.equal(viewport.getStatus().startLine, 16);
	assert.equal(viewport.getStatus().following, false);
});

test("wider reflow can anchor to a shared text prefix, or fall back to clamped index", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(12);
	viewport.render(lines, 3, 30);
	viewport.pageUp();
	viewport.render(lines, 3, 30);
	const wider = lines.filter((_, i) => i !== 0);
	wider[5] += " expanded continuation";
	assert.equal(viewport.render(wider, 3, 60)[0], wider[5]);
	assert.equal(viewport.getStatus().startLine, 5);
	const replacement = ["one", "two", "three", "four"];
	assert.deepEqual(viewport.render(replacement, 3, 20), replacement.slice(1));
	assert.equal(viewport.getStatus().following, false);
});

test("empty and explicit reset discard stale position even for same-length threads", () => {
	const viewport = new TranscriptViewport();
	viewport.pageUp();
	viewport.pageDown();
	viewport.toLatest();
	assert.deepEqual(viewport.getStatus(), emptyStatus);
	viewport.render(rows(20), 3, 40);
	viewport.pageUp();
	assert.deepEqual(viewport.render([], 3, 40), []);
	assert.deepEqual(viewport.getStatus(), emptyStatus);
	assert.deepEqual(viewport.render(rows(10), 3, 40), rows(10).slice(-3));
	viewport.pageUp();
	viewport.reset();
	assert.deepEqual(viewport.getStatus(), emptyStatus);
	const newThread = rows(10).map((line) => `new ${line}`);
	assert.deepEqual(viewport.render(newThread, 3, 40), newThread.slice(-3));
});

test("zero and invalid dimensions render nothing and do not lose a paused position", () => {
	const viewport = new TranscriptViewport();
	const lines = rows(10);
	viewport.render(lines, 3, 40);
	viewport.pageUp();
	viewport.render(lines, 3, 40);
	for (const [height, width] of [[0, 40], [3, 0], [-1, 40], [3, -1], [NaN, 40], [3, Infinity]]) {
		assert.deepEqual(viewport.render(lines, height!, width!), []);
		assert.equal(viewport.getStatus().startLine, 4);
		assert.equal(viewport.getStatus().endLine, 4);
		assert.equal(viewport.getStatus().following, false);
	}
	assert.deepEqual(viewport.render(lines, 3.9, 40.9), lines.slice(4, 7));
});

test("visible rows always fit width, including ANSI, CJK, emoji and combining marks", () => {
	const viewport = new TranscriptViewport();
	const lines = [
		"Jarvis: " + "very long text ".repeat(30),
		"\x1b[32m中文🙂👨‍👩‍👧‍👦🇯🇵e\u0301 content\x1b[0m",
		"two\nphysical\rrows",
		"",
	];
	for (const width of [0, 1, 2, 3, 4, 8, 15, 80]) {
		const rendered = viewport.render(lines, 10, width);
		assert.ok(rendered.length <= 10);
		for (const line of rendered) {
			assert.ok(visibleWidth(line) <= width, `row exceeds ${width}: ${JSON.stringify(line)}`);
			assert.ok(!/[\r\n]/.test(line));
		}
	}
	const plain = ["User: hello", "Jarvis: reply"];
	assert.deepEqual(viewport.render(plain, 10, 80), plain, "no added themes or padding");
});

test("all history is reachable and ordinary rendering reads only visible source rows", () => {
	let reads = 0;
	const count = 1_000_000;
	const virtualLines = new Proxy([] as string[], {
		get(_target, property) {
			if (property === "length") return count;
			if (typeof property === "string" && /^\d+$/.test(property)) {
				reads++;
				return `Jarvis: row ${property}`;
			}
			throw new Error(`unexpected history access: ${String(property)}`);
		},
	});
	const viewport = new TranscriptViewport();
	assert.deepEqual(viewport.render(virtualLines, 4, 40), [
		"Jarvis: row 999996", "Jarvis: row 999997", "Jarvis: row 999998", "Jarvis: row 999999",
	]);
	assert.equal(reads, 4, "no full-history copy, layout or cache");
	for (let i = 0; i < count / 4; i++) viewport.pageUp();
	assert.equal(viewport.getStatus().startLine, 0);
	assert.deepEqual(viewport.render(virtualLines, 4, 40), rows(4));
	assert.equal(reads, 8, "page actions do not read source");
	reads = 0;
	viewport.render(virtualLines, 4, 41);
	assert.ok(reads <= 513 + 4, `resize anchor scanned too much history: ${reads}`);
	viewport.toLatest();
	assert.equal(viewport.getStatus().startLine, count - 4);
});
