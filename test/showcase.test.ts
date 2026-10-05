import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const generator = resolve(root, "scripts/render-showcase.mjs");
const files = ["jarvis-access.svg", "jarvis-history.svg", "jarvis-workspace.svg"];
const readAsset = (file: string) => readFileSync(resolve(root, "docs/assets", file), "utf8");
const run = (...args: string[]) => {
	const result = spawnSync(process.execPath, args, { cwd: tmpdir(), encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout;
};

type XmlNode = { name: string; attrs: Record<string, string>; text: string; children: XmlNode[] };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]!);
// Deliberately small, dependency-free XML subset parser for these assets, not
// a general XML library. Rejects DTDs, processing instructions and unknown tags.
// Actual browser XML parsing and getBBox checks live in check-showcase.mjs.
function parseSvg(xml: string): XmlNode {
	const allowed = new Set(["svg", "title", "desc", "defs", "linearGradient", "stop", "rect", "path", "g", "circle", "text"]);
	const document: XmlNode = { name: "document", attrs: {}, text: "", children: [] };
	const stack = [document];
	const tokens = xml.match(/<[^>]*>|[^<]+/g) ?? [];
	assert.equal(tokens.join(""), xml, "unparsed XML bytes");
	for (const token of tokens) {
		assert.doesNotMatch(token, /&(?!amp;|lt;|gt;|quot;|apos;)/, "unknown or unescaped XML entity");
		if (!token.startsWith("<")) { stack.at(-1)!.text += decode(token); continue; }
		if (token.startsWith("</")) {
			assert.ok(stack.length > 1);
			assert.equal(token, `</${stack.pop()!.name}>`, "balanced XML elements");
			continue;
		}
		const match = /^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)>$/.exec(token);
		assert.ok(match, `invalid XML tag: ${token}`);
		assert.ok(allowed.has(match[1]!), `disallowed SVG element: ${match[1]}`);
		const attrs: Record<string, string> = {};
		let remaining = match[2]!;
		while (remaining.trim()) {
			const attr = /^\s+([A-Za-z][A-Za-z0-9:-]*)="([^"<>]*)"/.exec(remaining);
			assert.ok(attr, `invalid attribute syntax: ${remaining}`);
			assert.ok(!(attr[1]! in attrs), "duplicate attribute");
			assert.doesNotMatch(attr[1]!, /^on|href$/i, "active or linked resource attribute");
			attrs[attr[1]!] = decode(attr[2]!);
			remaining = remaining.slice(attr[0].length);
		}
		const node: XmlNode = { name: match[1]!, attrs, text: "", children: [] };
		stack.at(-1)!.children.push(node);
		if (!match[3]) stack.push(node);
	}
	assert.equal(stack.length, 1, "unclosed XML tags");
	assert.equal(document.children.length, 1);
	assert.equal(document.text.trim(), "");
	assert.equal(document.children[0]!.name, "svg");
	return document.children[0]!;
}
const flatten = (node: XmlNode): XmlNode[] => [node, ...node.children.flatMap(flatten)];
const assetText = (file: string) => flatten(parseSvg(readAsset(file))).filter((node) => ["text", "desc"].includes(node.name)).map((node) => node.text).join("\n");
const visibleText = (file: string) => flatten(parseSvg(readAsset(file))).filter(node => node.name === "text").map(node => node.text).join("\n");

test("showcase generation is deterministic, isolated and matches all three checked-in assets", () => {
	const temp = mkdtempSync(resolve(tmpdir(), "jarvis-showcase-test-"));
	try {
		const first = resolve(temp, "first"), second = resolve(temp, "nested", "second");
		run(generator, "--out-dir", first);
		run(generator, "--out-dir", second);
		assert.deepEqual(readdirSync(first).sort(), files);
		assert.deepEqual(readdirSync(second).sort(), files);
		for (const file of files) {
			const bytes = readFileSync(resolve(first, file));
			assert.deepEqual(bytes, readFileSync(resolve(second, file)));
			assert.deepEqual(bytes, readFileSync(resolve(root, "docs/assets", file)), `${file}: regenerate stale artwork`);
		}
	} finally { rmSync(temp, { recursive: true, force: true }); }
});

test("SVG text escaping handles markup, quotes and entity-like input", () => {
	const input = `<script a="x" b='y'>&amp; & text</script>`;
	const output = run("--input-type=module", "-e", `import { escapeXml } from ${JSON.stringify(new URL("../scripts/render-showcase.mjs", import.meta.url).href)}; process.stdout.write(escapeXml(${JSON.stringify(input)}));`);
	assert.equal(output, "&lt;script a=&quot;x&quot; b=&apos;y&apos;&gt;&amp;amp; &amp; text&lt;/script&gt;");
	assert.equal(parseSvg(`<svg><text>${output}</text></svg>`).children[0]!.text, input);
});

test("accessible self-contained SVGs have safe XML, legible fonts and card/baseline bounds", () => {
	for (const file of files) {
		const xml = readAsset(file), svg = parseSvg(xml), nodes = flatten(svg);
		assert.equal(svg.attrs.xmlns, "http://www.w3.org/2000/svg");
		assert.equal(svg.attrs.width, "640");
		const height = Number(svg.attrs.height);
		assert.ok(height >= 700 && height <= 1500, "bounded card height");
		assert.equal(svg.attrs.viewBox, `0 0 640 ${height}`);
		assert.equal(svg.attrs.role, "img");
		assert.equal(svg.attrs["aria-labelledby"], "title desc");
		assert.equal(nodes.filter((n) => n.name === "title").length, 1);
		assert.equal(nodes.filter((n) => n.name === "desc").length, 1);
		assert.ok(nodes.find((n) => n.name === "title")!.text.length > 12);
		assert.ok(nodes.find((n) => n.name === "desc")!.text.length > 100);
		assert.match(xml, /Conceptual diagram • not a live UI/);
		assert.doesNotMatch(xml, /<!|<\?|<script|foreignObject|@import|@font-face|data:|javascript:|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i);
		const ids = nodes.map((n) => n.attrs.id).filter(Boolean);
		assert.equal(new Set(ids).size, ids.length, "unique IDs");
		for (const node of nodes) {
			for (const value of Object.values(node.attrs)) for (const match of value.matchAll(/url\(([^)]+)\)/g)) {
				assert.match(match[1]!, /^#[a-z]+$/);
				assert.ok(ids.includes(match[1]!.slice(1)), "local paint reference resolves");
			}
			if (node.name === "text") {
				const font = Number(node.attrs["font-size"]), x = Number(node.attrs.x), y = Number(node.attrs.y);
				assert.ok(font >= 26 && font <= 36);
				assert.ok(x >= 0 && x <= 640 && y >= font && y <= height);
				assert.ok(26 * 304 / 640 >= 12, "320px wrapper body text remains at least 12px");
			}
			if (node.attrs["data-card"]) {
				const [x, y, w, h] = node.attrs["data-bounds"]!.split(" ").map(Number) as [number, number, number, number];
				assert.ok(x >= 0 && y >= 0 && x + w <= 640 && y + h <= height);
				assert.deepEqual([node.children[0]!.attrs.x, node.children[0]!.attrs.y, node.children[0]!.attrs.width, node.children[0]!.attrs.height].map(Number), [x, y, w, h]);
				for (const text of flatten(node).filter((n) => n.name === "text")) {
					assert.ok(Number(text.attrs.x) >= x && Number(text.attrs.x) <= x + w);
					assert.ok(Number(text.attrs.y) - Number(text.attrs["font-size"]) >= y && Number(text.attrs.y) <= y + h, `text baseline outside ${node.attrs.id}`);
				}
			}
		}
	}
});

test("workspace accurately separates lanes, shared memory and authority", () => {
	assert.ok(visibleText("jarvis-workspace.svg").includes("Recalls may reach your model/provider."), "provider disclosure must be visible, not only alt/description text");
	const text = assetText("jarvis-workspace.svg");
	for (const phrase of ["Main Pi / primary session", "Jarvis / isolated side session", "Main context → Jarvis only", "Summary + delta, not a full copy", "ON in trusted projects • plaintext", "Bounded recall: global + this project", "Facts are context, not instructions.", "No automatic steering or task handoff", "separate controls"]) assert.ok(text.includes(phrase), phrase);
});

test("history is explicit and preserves the archive encryption/privacy boundary", () => {
	const visible = visibleText("jarvis-history.svg");
	for (const phrase of ["Plaintext • unredacted • may hold secrets", "Provider may see reads—even encrypted."]) assert.ok(visible.includes(phrase), "privacy boundary must be visible: " + phrase);
	const text = assetText("jarvis-history.svg");
	for (const phrase of ["Archive: OFF by default", "Review files & metadata only", "Approve the exact reviewed set", "Skip duplicates • per-file reports", "Browse sessions • see provenance", "Sources are not modified.", "No startup scan or automatic import.", "Human search ≠ model access", "Model reads: a separate opt-in.", "OFF by default • archive only", "Protects active DB, index & journals.", "Not original Pi transcripts, memory,", "retained plaintext backups", "Pause capture before safe setup."]) assert.ok(text.includes(phrase), phrase);
	const positions = ["Preview", "Confirm", "Import", "Search"].map((step) => text.indexOf(`\n${step}\n`));
	assert.ok(positions.every((position) => position >= 0));
	assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test("permissions use fresh-owner OFF, close-not-stop, visible confirmation and explicit revocation", () => {
	const text = assetText("jarvis-access.svg");
	for (const phrase of ["Fresh owner → three OFF gates", "read • bash • edit • write", "Native MCP • configured, side-owned", "Quiet follow-up to the main lane", "Visible confirmation for every send", "Close hides. Work continues.", "Same owner: enabled grants stay on.", "No new invisible Redirect approvals.", "/jarvis stop", "Clear queue • request cancellation", "/jarvis access off", "Revoke Repo tools, Note & Redirect.", "/jarvis status → visible in main Pi", "Main replacement • side /new", "Reload / quit • trust denial", "Background work is not a daemon.", "Memory & archive: separate controls."]) assert.ok(text.includes(phrase), phrase);
	assert.equal(flatten(parseSvg(readAsset("jarvis-access.svg"))).filter((n) => n.name === "text" && n.text === "OFF").length, 3);
	assert.doesNotMatch(text, /closing revokes|close revokes|sandbox|forensic erasure|guaranteed rollback/i);
});
