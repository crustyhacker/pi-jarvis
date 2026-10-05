// Optional local browser QA; Playwright is not a project dependency or CI prerequisite.
// Only immutable documentation assets are served, on a fresh loopback-only server.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
	const key = process.argv[i], value = process.argv[i + 1];
	if (!["--playwright-module", "--out-dir", "--browser"].includes(key) || !value) throw new Error("Usage: node scripts/check-showcase.mjs [--playwright-module PATH] [--out-dir DIRECTORY] [--browser EXECUTABLE]");
	options[key] = value;
}
const modulePath = options["--playwright-module"] || process.env.PLAYWRIGHT_MODULE_PATH;
let playwright;
try {
	playwright = await import(modulePath ? pathToFileURL(resolve(modulePath, modulePath.endsWith(".js") || modulePath.endsWith(".mjs") ? "" : "index.mjs")).href : "playwright");
} catch (error) {
	throw new Error("Optional Playwright unavailable. Supply --playwright-module PATH (existing module directory or entry file). No installation is performed.", { cause: error });
}
const outDir = options["--out-dir"] ? resolve(options["--out-dir"]) : mkdtempSync(resolve(tmpdir(), "jarvis-showcase-qa-"));
mkdirSync(outDir, { recursive: true });
const assetDir = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/assets");
const names = ["workspace", "history", "access"];
const assets = new Map(names.map((name) => [`/jarvis-${name}.svg`, readFileSync(resolve(assetDir, `jarvis-${name}.svg`))]));
const html = (dark) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/favicon.ico"><title>Jarvis conceptual documentation diagrams — QA</title><style>html{color-scheme:${dark ? "dark" : "light"};background:${dark ? "#0d1117" : "#ffffff"};color:${dark ? "#f0f6fc" : "#1f2328"};font-family:Arial,Helvetica,sans-serif}body{margin:0;padding:24px 8px}main{max-width:640px;margin:auto}h1{font-size:24px;line-height:1.4;margin:0 0 12px}p{font-size:16px;line-height:1.5;margin:0 0 24px}figure{margin:0 0 24px}img{display:block;width:100%;height:auto;border-radius:14px}figcaption{font-size:16px;line-height:1.5;margin-top:8px}</style><main><h1>Pi + Jarvis: two lanes, shared memory</h1><p>README-like fixture. Conceptual artwork, not live UI captures.</p>${names.map((name) => `<figure><img src="/jarvis-${name}.svg" alt="Jarvis ${name} conceptual diagram" data-name="${name}"><figcaption>${name[0].toUpperCase() + name.slice(1)} · local documentation fixture</figcaption></figure>`).join("")}</main></html>`;
const server = createServer((req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
	if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
	if (url.pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html(url.searchParams.get("theme") === "dark")); return; }
	if (assets.has(url.pathname)) { res.setHeader("Content-Type", "image/svg+xml; charset=utf-8"); res.end(assets.get(url.pathname)); return; }
	res.writeHead(404); res.end("Not found");
});
await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = options["--browser"] || process.env.SHOWCASE_BROWSER || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
let browser;
const errors = [], blocked = [], screenshots = [], layout = [];
async function context(viewport, colorScheme) {
	const ctx = await browser.newContext({ viewport, colorScheme, serviceWorkers: "block", reducedMotion: "reduce" });
	await ctx.route("**/*", (route) => {
		if (new URL(route.request().url()).origin === origin) return route.continue();
		blocked.push(route.request().url()); return route.abort();
	});
	ctx.on("page", (page) => {
		page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
	});
	return ctx;
}
async function shot(page, file, fullPage = true) {
	const path = resolve(outDir, file);
	await page.screenshot({ path, fullPage, animations: "disabled" });
	screenshots.push(path);
}
try {
	browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--disable-default-apps", "--disable-domain-reliability", "--disable-client-side-phishing-detection", "--safebrowsing-disable-auto-update", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
	for (const width of [1100, 390, 320]) for (const theme of ["light", "dark"]) {
		const ctx = await context({ width, height: 900 }, theme);
		try {
			const page = await ctx.newPage();
			await page.goto(`${origin}/?theme=${theme}`, { waitUntil: "networkidle" });
			const result = await page.evaluate(() => ({
				overflow: document.documentElement.scrollWidth > innerWidth,
				images: [...document.querySelectorAll("img")].map((img) => ({ name: img.dataset.name, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, width: img.getBoundingClientRect().width, left: img.getBoundingClientRect().left, right: img.getBoundingClientRect().right })),
			}));
			assert.equal(result.overflow, false, `${width}/${theme}: horizontal overflow`);
			assert.equal(result.images.length, 3);
			for (const img of result.images) {
				assert.ok(img.complete && img.naturalWidth === 640 && img.naturalHeight > 0, `${img.name}: invalid image`);
				assert.ok(img.left >= 0 && img.right <= width, `${img.name}: image outside viewport`);
				assert.ok(26 * img.width / 640 >= 12, `${img.name}: effective mobile body font below 12px`);
			}
			layout.push({ width, theme, ...result });
			await shot(page, `wrapper-${width}-${theme}.png`);
			if (width === 390 && theme === "dark") for (const name of names) {
				const path = resolve(outDir, `mobile-${name}.png`);
				await page.locator(`img[data-name="${name}"]`).screenshot({ path, animations: "disabled" });
				screenshots.push(path);
			}
		} finally { await ctx.close(); }
	}
	const textBounds = [];
	for (const name of names) {
		const ctx = await context({ width: 640, height: 1500 }, "dark");
		try {
			const page = await ctx.newPage();
			await page.goto(`${origin}/jarvis-${name}.svg`, { waitUntil: "networkidle" });
			const result = await page.evaluate(() => {
				const svg = document.documentElement;
				if (svg.localName !== "svg") return { failures: ["Invalid SVG/XML document"], textCount: 0 };
				const vb = svg.viewBox.baseVal, failures = [];
				const boxes = [...svg.querySelectorAll("text")].map((node) => {
					const b = node.getBBox(), card = node.closest("[data-bounds]"), bounds = card?.getAttribute("data-bounds").split(" ").map(Number);
					const box = { text: node.textContent, x: b.x, y: b.y, w: b.width, h: b.height, font: parseFloat(getComputedStyle(node).fontSize), card: card?.id };
					const within = ([x, y, w, h]) => b.x >= x - 0.5 && b.y >= y - 0.5 && b.x + b.width <= x + w + 0.5 && b.y + b.height <= y + h + 0.5;
					if (!within([vb.x, vb.y, vb.width, vb.height])) failures.push(`Outside viewBox: ${node.textContent}`);
					if (bounds && !within(bounds)) failures.push(`Outside card ${card.id}: ${node.textContent}`);
					if (box.font < 26) failures.push(`Small font: ${node.textContent}`);
					return box;
				});
				for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
					const a = boxes[i], b = boxes[j];
					if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5) failures.push(`Text overlap: ${a.text} / ${b.text}`);
				}
				return { failures, textCount: boxes.length, boxes, viewBox: [vb.x, vb.y, vb.width, vb.height] };
			});
			assert.deepEqual(result.failures, [], `${name}: SVG text bounds/overlap`);
			assert.ok(result.textCount > 15);
			textBounds.push({ name, ...result });
			// Standalone SVG documents have no HTML body; full-page capture can
			// hang in Chromium. Capture their exact viewBox-sized viewport.
			await page.setViewportSize({ width: 640, height: result.viewBox[3] });
			await shot(page, `direct-${name}.png`, false);
		}
		finally { await ctx.close(); }
	}
	assert.deepEqual(blocked, [], "Unexpected non-loopback network attempts");
	assert.deepEqual(errors, [], "Browser console, page or network errors");
	const hashes = Object.fromEntries([...assets].map(([name, bytes]) => [name.slice(1), createHash("sha256").update(bytes).digest("hex")]));
	const report = { browser: browser.version(), executablePath: executablePath || "Playwright cached Chromium", playwrightModule: modulePath || "playwright", screenshots, hashes, layout, textBounds, errors, blocked, limits: "Conceptual artwork only. README-like local wrapper, not GitHub/npm production rendering or live TUI. Bounds depend on the tested browser/platform font fallback. Browser route interception plus Chromium background-network disabling; no user profile, provider, archive, MCP or credential access." };
	writeFileSync(resolve(outDir, "results.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(`PASS: ${layout.length} wrapper scenarios, 3 direct SVG bounds/overlap checks, ${screenshots.length} screenshots; no errors/nonlocal requests.\nResults: ${resolve(outDir, "results.json")}`);
} finally {
	await browser?.close();
	await new Promise((yes, no) => server.close((error) => error ? no(error) : yes()));
}
