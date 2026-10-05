// Deterministic documentation artwork from the actual public renderer.
// No model, session runtime, user config, MCP server, or terminal is started.
import { mkdirSync, writeFileSync } from "node:fs";
import { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { renderJarvisIntro } from "../dist/jarvis-branding.js";
import { JarvisOverlayBridge, JarvisOverlayComponent } from "../dist/overlay.js";

const fgNames = "accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode".split(" ");
const fg = Object.fromEntries(fgNames.map((name) => [name, "#dcd9ef"]));
Object.assign(fg, { accent: "#5de2ff", borderAccent: "#ff70cd", borderMuted: "#77659a", muted: "#aaa0c3", dim: "#8f83a7", success: "#70e2bc", warning: "#ffb97e" });
const bg = Object.fromEntries("selectedBg searchMatchBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg".split(" ").map((name) => [name, "#171127"]));
// Purple-heavy fixture exercises separation even when a theme's custom panel
// background is saturated. This is demo artwork, not the user's live theme.
bg.customMessageBg = "#3a3453";
bg.userMessageBg = "#1e1b2d";
const theme = new Theme(fg, bg, "truecolor", { name: "Jarvis demo", appearance: "dark" });
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function svg(lines, title, description, columns, neon = false) {
	const cell = 8.4, lineHeight = 20, padding = 28;
	const width = Math.ceil(columns * cell + padding * 2), height = lines.length * lineHeight + padding * 2;
	const nodes = [];
	for (let row = 0; row < lines.length; row++) {
		let color = "#dcd9ef", background = "#100c1e", bold = false, column = 0, offset = 0;
		const line = lines[row].replaceAll(CURSOR_MARKER, "");
		const paint = (text) => {
			if (!text) return;
			const count = visibleWidth(text), x = padding + column * cell, y = padding + row * lineHeight;
			if (background !== "#100c1e") nodes.push(`<rect x="${x}" y="${y - 15}" width="${count * cell}" height="${lineHeight}" fill="${background}"/>`);
			// Explicit cell positions keep the preview faithful in SVG viewers
			// that ignore textLength or choose slightly different monospace metrics.
			for (const char of text) {
				if (char !== " ") nodes.push(`<text x="${padding + column * cell}" y="${y}" fill="${color}"${bold ? ' font-weight="bold"' : ""}>${escape(char)}</text>`);
				column += visibleWidth(char);
			}
		};
		for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
			paint(line.slice(offset, match.index));
			const codes = (match[1] || "0").split(";").map(Number);
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				if (code === 0) { color = "#dcd9ef"; background = "#100c1e"; bold = false; }
				if (code === 1) bold = true;
				if (code === 22) bold = false;
				if (code === 39) color = "#dcd9ef";
				if (code === 49) background = "#100c1e";
				if ((code === 38 || code === 48) && codes[i + 1] === 2) {
					const rgb = `rgb(${codes.slice(i + 2, i + 5).join(",")})`;
					if (code === 38) color = rgb; else background = rgb;
					i += 4;
				}
			}
			offset = match.index + match[0].length;
		}
		paint(line.slice(offset));
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${escape(title)}</title><desc id="desc">${escape(description)}</desc>
<defs><linearGradient id="edge"><stop stop-color="#5de2ff"/><stop offset="0.5" stop-color="#bd8aff"/><stop offset="1" stop-color="#ff70cd"/></linearGradient></defs>
<rect width="${width}" height="${height}" rx="14" fill="#100c1e"/>
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="13" fill="none" stroke="${neon ? "url(#edge)" : "#3f305d"}" stroke-width="2"/>
<g font-family="'DejaVu Sans Mono', Consolas, monospace" font-size="14" xml:space="preserve">${nodes.join("\n")}</g>
</svg>\n`;
}

mkdirSync("docs/assets", { recursive: true });
writeFileSync("docs/assets/jarvis-logo.svg", svg(renderJarvisIntro(theme, 68, 8, 900).slice(0, 7), "Jarvis / Pi", "Original ASCII wordmark with a cyan, violet, and pink chrome sweep. A second lane of thought.", 68, true));
const bridge = new JarvisOverlayBridge();
const view = {
	isReady: () => true, isStreaming: () => false,
	getModelLabel: () => "demo/side", getModelModeLabel: () => "follow main",
	getThinkingLabel: () => "thinking auto (effective medium; project setting)",
	getModelChoices: async () => [{ value: "follow-main", label: "Follow main" }, { value: "demo/side", label: "demo/side" }],
	async configureModel() { throw new Error("Documentation fixture must never configure models"); },
	async configureThinking() { throw new Error("Documentation fixture must never configure thinking"); },
	async cancelWork() { throw new Error("Documentation fixture must never cancel work"); },
	getMainStatusLabel: () => "working", getMainModelLabel: () => "demo/main",
	getMainFocusLabel: () => "Reviewing the current change", getMainDeltaLabel: () => "",
	getRepoToolsDetailLabel: () => "repo tools off",
	isToolAccessEnabled: () => false, isFollowUpToMainEnabled: () => false, isSteerToMainEnabled: () => false,
	toggleToolAccess() {}, toggleFollowUpToMain() {}, toggleSteerToMain() {},
	getDisplayEntries: () => [
		{ kind: "user", text: "Give me a second opinion without interrupting the main session." },
		{ kind: "assistant", text: "That's what I'm here for. We can think through the trade-offs here while the main lane keeps moving." },
		{ kind: "assistant", text: "Repo tools and native MCP stay off until you opt in. Notes and redirects have their own permission controls." },
	],
	async sendMessage() { throw new Error("Documentation fixture must never send"); },
};
bridge.notify("Saved Jarvis thinking for this project. Effective thinking is medium.", "info");
const overlay = new JarvisOverlayComponent({ terminal: { rows: 34, columns: 100 }, requestRender() {} }, theme, bridge, view, () => {});
try {
	writeFileSync("docs/assets/jarvis-overlay.svg", svg(overlay.render(88), "Jarvis compact overlay preview", "Actual Jarvis renderer with deterministic demo conversation and a custom dark palette. Not a live provider session.", 88));
} finally { overlay.dispose(); }
console.log("Generated docs/assets/jarvis-logo.svg and jarvis-overlay.svg (deterministic renderer fixtures).");
