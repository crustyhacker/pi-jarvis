// Actual public memory-editor renderer with synthetic notes only. No service,
// SQLite, session, settings, provider or credential store is opened.
import { mkdirSync, writeFileSync } from "node:fs";
import { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { MemoryEditorOverlay } from "../dist/memory-editor.js";
import { escapeXml } from "./render-showcase.mjs";

const fgNames = "accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode".split(" ");
const foreground = Object.fromEntries(fgNames.map(name => [name, "#e4e9f5"]));
Object.assign(foreground, { accent: "#6ee7f5", borderAccent: "#bd9cff", borderMuted: "#586581", muted: "#acb9d1", dim: "#94a3bd", success: "#82dfb4", warning: "#ffc88c", error: "#ff93a5" });
const background = Object.fromEntries("selectedBg searchMatchBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg".split(" ").map(name => [name, "#141d30"]));
background.selectedBg = "#2a3b57";
const theme = new Theme(foreground, background, "truecolor", { name: "Memory editor demo", appearance: "dark" });
const project = "/demo/project";
const records = [
	{ id: "a".repeat(64), kind: "note", category: "project", scope: "project", project, title: "Build workflow",
		text: "Use npm for this project.\n\nRun tests in isolated workspaces. Never use real credentials or user history in test fixtures.",
		source: { lane: "main", sessionId: "demo-main-session", eventId: "demo-model-save" }, createdAt: 1767344400000, updatedAt: 1767348000000 },
	{ id: "b".repeat(64), kind: "note", category: "user", scope: "global", project, title: "Answer style",
		text: "Prefer concise explanations with clear file paths.", source: { lane: "manual", sessionId: "demo-main-session", eventId: "demo-manual-save" }, createdAt: 1767344400000, updatedAt: 1767347000000 },
	{ id: "c".repeat(64), kind: "note", category: "reference", scope: "project", project, title: "Architecture reference",
		text: "The public SDK contract is documented alongside the extension examples.", source: { lane: "jarvis", sessionId: "demo-side-session", eventId: "demo-side-save" }, createdAt: 1767344400000, updatedAt: 1767346000000 },
];
const backend = {
	projectLabel: project, ensureActive() {},
	list: () => ({ records: records.map(({ text, source, kind: _kind, ...record }) => ({ ...record, lane: source.lane, textBytes: Buffer.byteLength(text) })), total: records.length, offset: 0, nextOffset: null }),
	get: id => records.find(record => record.id === id),
	create() { throw new Error("Documentation fixture must not create notes"); },
	update() { throw new Error("Documentation fixture must not update notes"); },
	forget() { throw new Error("Documentation fixture must not delete notes"); },
	onChange: () => () => {},
};
const tui = { terminal: { rows: 42, columns: 148 }, requestRender() {} };
const editor = new MemoryEditorOverlay(tui, theme, getKeybindings(), backend, () => {});
try {
	editor.focused = true;
	await new Promise(resolve => setImmediate(resolve));
	editor.render(140);
	editor.handleInput("\r");
	await new Promise(resolve => setImmediate(resolve));
	const lines = editor.render(140);
	const cell = 7.8, rowHeight = 19, padding = 24;
	const width = 140 * cell + padding * 2, height = lines.length * rowHeight + padding * 2;
	const nodes = [];
	for (const [row, raw] of lines.entries()) {
		const line = raw.replaceAll(CURSOR_MARKER, "");
		let column = 0, offset = 0, fg = "#e4e9f5", bg = "#0b1221", bold = false;
		const paint = text => {
			if (!text) return;
			const count = visibleWidth(text), x = padding + column * cell, y = padding + row * rowHeight;
			if (bg !== "#0b1221") nodes.push(`<rect x="${x}" y="${y - 14}" width="${count * cell}" height="${rowHeight}" fill="${bg}"/>`);
			for (const char of text) {
				if (char !== " ") nodes.push(`<text x="${padding + column * cell}" y="${y}" fill="${fg}"${bold ? ' font-weight="bold"' : ""}>${escapeXml(char)}</text>`);
				column += visibleWidth(char);
			}
		};
		for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
			paint(line.slice(offset, match.index));
			const codes = (match[1] || "0").split(";").map(Number);
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				if (code === 0) { fg = "#e4e9f5"; bg = "#0b1221"; bold = false; }
				if (code === 1) bold = true;
				if (code === 22) bold = false;
				if (code === 39) fg = "#e4e9f5";
				if (code === 49) bg = "#0b1221";
				if ((code === 38 || code === 48) && codes[i + 1] === 2) {
					const color = `rgb(${codes.slice(i + 2, i + 5).join(",")})`;
					if (code === 38) fg = color; else bg = color;
					i += 4;
				}
			}
			offset = match.index + match[0].length;
		}
		paint(line.slice(offset));
	}
	mkdirSync("docs/assets", { recursive: true });
	writeFileSync("docs/assets/jarvis-memory-editor.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">Curated memory editor — renderer fixture</title><desc id="desc">Actual memory-editor component with three synthetic notes and a custom dark palette. Not a live user database or provider session. Browser, full note inspection and independent human editing controls.</desc><rect width="${width}" height="${height}" rx="12" fill="#0b1221"/><g font-family="'DejaVu Sans Mono',Consolas,monospace" font-size="13" xml:space="preserve">${nodes.join("\n")}</g></svg>\n`);
	console.log("Generated docs/assets/jarvis-memory-editor.svg from synthetic notes only.");
} finally { editor.dispose(); }
