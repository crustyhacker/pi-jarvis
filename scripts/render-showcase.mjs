// Original conceptual documentation artwork, not live UI captures.
// Dependency-free: no runtime, settings, providers, credentials or user data.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const C = { text: "#edf4ff", muted: "#bbcae2", cyan: "#67e8f9", violet: "#c4a5ff", edge: "#344663" };
const text = (x, y, value, size = 26, color = C.text, weight = 400, extra = "") => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}"${extra}>${escapeXml(value)}</text>`;
const rule = (y) => `<path d="M64 ${y}H576" fill="none" stroke="${C.edge}" stroke-width="2"/>`;
const card = (id, y, height, content, accent = C.edge) => `<g id="${id}" data-card="${id}" data-bounds="40 ${y} 560 ${height}"><rect x="40" y="${y}" width="560" height="${height}" rx="22" fill="url(#panel)" stroke="${accent}" stroke-width="1.5"/>${content}</g>`;
const header = (number, label, title, subtitle) => text(40, 48, `${number} / ${label}`, 26, C.cyan, 600) + text(40, 94, title, 34, C.text, 700) + text(40, 132, subtitle, 26, C.muted);
const footer = (y) => text(320, y, "Conceptual diagram • not a live UI", 26, C.muted, 400, ' text-anchor="middle"');
const shell = (height, title, description, content) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}" viewBox="0 0 640 ${height}" role="img" aria-labelledby="title desc">
<title id="title">${escapeXml(title)}</title>
<desc id="desc">${escapeXml(description)}</desc>
<defs>
<linearGradient id="canvas" x2="1" y2="1"><stop stop-color="#111a32"/><stop offset="1" stop-color="#080f20"/></linearGradient>
<linearGradient id="panel" x2="0" y2="1"><stop stop-color="#18263e"/><stop offset="1" stop-color="#111c31"/></linearGradient>
<linearGradient id="edge"><stop stop-color="#67e8f9"/><stop offset="1" stop-color="#ad87ff"/></linearGradient>
</defs>
<rect width="640" height="${height}" rx="28" fill="url(#canvas)"/>
<rect x="1" y="1" width="638" height="${height - 2}" rx="27" fill="none" stroke="#344663"/>
<path d="M40 12H600" stroke="url(#edge)" stroke-width="3" stroke-linecap="round"/>
<g font-family="Arial, Helvetica, sans-serif">${content}</g>
</svg>
`;

function workspace() {
	return shell(1134, "Two lanes. Shared local memory.", "Conceptual workspace: main Pi sends a summary and recent delta to an isolated Jarvis session, not a full context copy. Both explicitly mount shared local plaintext memory, on in trusted projects. Recall is bounded to global and current-project facts, not higher-priority instructions. Recalled facts can reach the active model/provider. No automatic steering or task handoff. Memory, archive, Repo tools and bridge controls are independent.",
		header("01", "THE WORKSPACE", "Two lanes. Shared memory.", "A second opinion, without losing focus.") +
		// A shared service rail has no arrow: mounting is not a task handoff.
		`<path d="M40 230H20V770H40M20 516H40" fill="none" stroke="${C.violet}" stroke-width="2"/><circle cx="20" cy="516" r="4" fill="${C.violet}"/>` +
		card("main-lane", 164, 132, text(64, 208, "Main Pi / primary session", 30, C.cyan, 700) + text(64, 250, "Keep your primary task moving.")) +
		`<path d="M320 296V322M320 392V420M312 410L320 420L328 410" fill="none" stroke="${C.cyan}" stroke-width="2" stroke-linecap="round"/>` +
		text(320, 351, "Main context → Jarvis only", 26, C.cyan, 600, ' text-anchor="middle"') + text(320, 387, "Summary + delta, not a full copy", 26, C.muted, 400, ' text-anchor="middle"') +
		card("jarvis-lane", 428, 178, text(64, 472, "Jarvis / isolated side session", 30, C.violet, 700) + text(64, 514, "Own model & thinking • scrollback") + text(64, 552, "Multiline draft • persistent history")) +
		text(320, 654, "Both lanes mount the same local store", 26, C.violet, 400, ' text-anchor="middle"') +
		card("shared-memory", 684, 296, text(64, 728, "Shared local memory", 30, C.violet, 700) + text(64, 770, "Preferences • decisions • search") + text(64, 810, "ON in trusted projects • plaintext", 26, C.cyan) + text(64, 850, "Bounded recall: global + this project") + text(64, 890, "Facts are context, not instructions.") + rule(911) + text(64, 952, "Recalls may reach your model/provider.", 26, C.muted), C.violet) +
		text(320, 1026, "Memory, archive & tool/bridge access", 26, C.muted, 400, ' text-anchor="middle"') + text(320, 1064, "have separate controls.", 26, C.muted, 400, ' text-anchor="middle"') + footer(1105));
}

function history() {
	const steps = [
		["Preview", "Review files & metadata only"],
		["Confirm", "Approve the exact reviewed set"],
		["Import", "Skip duplicates • per-file reports"],
		["Search", "Browse sessions • see provenance"],
	];
	const flow = steps.map(([title, body], i) => {
		const y = 398 + i * 96;
		return `${i < 3 ? `<path d="M78 ${y + 19}V${y + 71}" stroke="${C.edge}" stroke-width="2"/>` : ""}<circle cx="78" cy="${y - 10}" r="22" fill="#22374e" stroke="${i % 2 ? C.violet : C.cyan}"/>` + text(78, y - 1, i + 1, 26, C.text, 700, ' text-anchor="middle"') + text(116, y, title, 30, i % 2 ? C.violet : C.cyan, 700) + text(116, y + 36, body);
	}).join("");
	return shell(1460, "Find the original conversation.", "Conceptual optional archive workflow: OFF by default, plaintext and unredacted; it may contain secrets. Explicit metadata preview, sensitive confirmation of the reviewed set, bounded import with duplicate skipping and per-file reports, then search with session provenance. Sources are not modified and there is no automatic history import. Human inspection requires enabled archive but not model access; model reads are a separate opt-in and may send retrieved data to the provider even when storage is encrypted. Optional password encryption is off by default and covers only the active archive database, index and journals, not original Pi transcripts, shared memory or retained plaintext backups. Pause effective capture before safe encryption setup.",
		header("02", "YOUR HISTORY", "Find the original conversation.", "Indexed history, when you choose it.") +
		card("archive-default", 164, 112, text(64, 207, "Archive: OFF by default", 30, C.cyan, 700) + text(64, 249, "Plaintext • unredacted • may hold secrets")) +
		card("import-workflow", 304, 468, text(64, 348, "Your reviewed import workflow", 30, C.text, 700) + flow) +
		text(64, 817, "Sources are not modified.", 26, C.cyan, 600) + text(64, 855, "No startup scan or automatic import.", 26, C.muted) +
		card("archive-search", 886, 188, text(64, 930, "Human search ≠ model access", 30, C.violet, 700) + text(64, 970, "Human inspection: archive must be on.") + text(64, 1010, "Model reads: a separate opt-in.") + text(64, 1048, "Provider may see reads—even encrypted.", 26, C.muted)) +
		card("encryption-boundary", 1102, 284, text(64, 1146, "Optional password encryption", 30, C.violet, 700) + text(64, 1186, "OFF by default • archive only", 26, C.cyan) + text(64, 1224, "Protects active DB, index & journals.") + rule(1244) + text(64, 1282, "Not original Pi transcripts, memory,", 26, C.muted) + text(64, 1320, "or retained plaintext backups.", 26, C.muted) + text(64, 1358, "Pause capture before safe setup.", 26, C.cyan), C.violet) + footer(1430));
}

function access() {
	const off = (y) => `<rect x="498" y="${y - 29}" width="78" height="38" rx="10" fill="#24324a" stroke="#52647f"/>` + text(537, y - 1, "OFF", 26, C.text, 700, ' text-anchor="middle"');
	return shell(1422, "Access stays in your hands.", "Conceptual permissions: a fresh main/side owner starts Repo tools, Note main and Redirect OFF. Repo tools opt into read, bash, edit, write and configured side-owned native MCP. Note main delivers a quiet follow-up; Redirect requires visible confirmation for every send. Ordinary close hides presentation without stopping same-owner assigned work or revoking enabled grants, but cannot approve new invisible redirects. Explicit stop clears queued work and requests cancellation; access off revokes all three grants. Owner replacement, side /new, reload, quit and observed trust denial revoke grants. Work is not a detached daemon. Shared memory and archive have separate controls.",
		header("03", "YOUR PERMISSIONS", "Access stays in your hands.", "Opt in independently. Stay in control.") +
		card("fresh-owner", 164, 400, text(64, 208, "Fresh owner → three OFF gates", 30, C.text, 700) + text(64, 254, "Repo tools", 30, C.cyan, 700) + off(254) + text(64, 294, "read • bash • edit • write") + text(64, 332, "Native MCP • configured, side-owned", 26, C.muted) + rule(351) + text(64, 390, "Note main", 30, C.violet, 700) + off(390) + text(64, 430, "Quiet follow-up to the main lane") + rule(450) + text(64, 490, "Redirect", 30, C.cyan, 700) + off(490) + text(64, 532, "Visible confirmation for every send")) +
		card("ordinary-close", 592, 160, text(64, 636, "Close hides. Work continues.", 30, C.cyan, 700) + text(64, 678, "Same owner: enabled grants stay on.") + text(64, 718, "No new invisible Redirect approvals.", 26, C.muted), C.cyan) +
		card("explicit-controls", 780, 306, text(64, 824, "Explicit controls, no surprises", 30, C.text, 700) + text(64, 868, "/jarvis stop", 28, C.cyan, 600) + text(64, 906, "Clear queue • request cancellation") + text(64, 952, "/jarvis access off", 28, C.violet, 600) + text(64, 990, "Revoke Repo tools, Note & Redirect.") + rule(1012) + text(64, 1054, "/jarvis status → visible in main Pi", 26, C.muted)) +
		card("lifetime-boundary", 1114, 192, text(64, 1156, "Reset on owner change / teardown", 30, C.violet, 700) + text(64, 1196, "Main replacement • side /new") + text(64, 1234, "Reload / quit • trust denial") + text(64, 1274, "Background work is not a daemon.", 26, C.muted)) +
		text(320, 1348, "Memory & archive: separate controls.", 26, C.muted, 400, ' text-anchor="middle"') + footer(1392));
}

export function renderShowcase(outDir) {
	mkdirSync(outDir, { recursive: true });
	for (const [name, render] of [["workspace", workspace], ["history", history], ["access", access]]) {
		writeFileSync(resolve(outDir, `jarvis-${name}.svg`), render(), "utf8");
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 2 || args[0] !== "--out-dir" || !args[1])) {
		console.error("Usage: node scripts/render-showcase.mjs [--out-dir DIRECTORY]");
		process.exitCode = 1;
	} else {
		const outDir = args[1] ? resolve(args[1]) : resolve(dirname(fileURLToPath(import.meta.url)), "../docs/assets");
		renderShowcase(outDir);
		console.log(`Generated 3 conceptual showcase SVGs in ${outDir}`);
	}
}
