import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackageManifest = {
	name: string;
	version: string;
	files?: string[];
	main?: string;
	types?: string;
	exports?: Record<string, unknown>;
	pi?: { extensions?: string[] };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	engines?: Record<string, string>;
};
type NpmPackEntry = { name?: string; version?: string; files?: Array<{ path: string }> };

function parsePackJson(stdout: string): NpmPackEntry[] {
	// stderr may contain diagnostics with brackets; it must never enter this parser.
	const entries: unknown = JSON.parse(stdout.trim());
	assert.ok(Array.isArray(entries) && entries.length === 1, "npm pack must return exactly one package");
	assert.ok(entries[0] && typeof entries[0] === "object" && Array.isArray(entries[0].files), "invalid npm pack metadata");
	return entries as NpmPackEntry[];
}

function runNpm(args: string[], timeout: number): string {
	const result = spawnSync("npm", args, { encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 });
	assert.ifError(result.error);
	assert.equal(result.signal, null, `npm ${args.join(" ")} terminated by ${result.signal}`);
	assert.equal(result.status, 0, `npm ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

function normalizeManifestEntry(path: string): string {
	return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

function main(): void {
	assert.throws(() => parsePackJson("warning [bad]\n[]"));
	assert.throws(() => parsePackJson("[]"));
	const manifest = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
		name: string; version: string; lockfileVersion: number;
		packages: Record<string, PackageManifest>;
	};
	assert.equal(manifest.name, "pi-jarvis");
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
	assert.equal(lock.name, manifest.name);
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.lockfileVersion, 3);
	assert.equal(lock.packages[""].version, manifest.version);
	for (const key of ["devDependencies", "peerDependencies", "peerDependenciesMeta", "engines"] as const) {
		assert.deepEqual(lock.packages[""][key], manifest[key], `lockfile root ${key} must match manifest`);
	}
	assert.ok(readFileSync("README.md", "utf8").includes(`<strong>Current version:</strong> ${manifest.version}`), "README version must match manifest");
	assert.ok(readFileSync("CHANGELOG.md", "utf8").includes(`## [${manifest.version}]`), "current version must have changelog entry");
	assert.equal(manifest.main, "./dist/index.js");
	assert.equal(manifest.types, "./dist/index.d.ts");
	assert.deepEqual(manifest.exports?.["."], { types: "./dist/index.d.ts", default: "./dist/index.js" });
	assert.equal(manifest.exports?.["./package.json"], "./package.json");
	assert.deepEqual(manifest.pi?.extensions, ["./dist/index.js"]);
	const hostPeers = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
	assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), hostPeers.slice().sort(), "only validated Pi host peers may be advertised");
	assert.deepEqual(Object.keys(manifest.peerDependenciesMeta ?? {}).sort(), hostPeers.slice().sort());
	assert.deepEqual(manifest.dependencies ?? {}, {}, "published extension must not install its host runtime");
	for (const peer of hostPeers) {
		assert.equal(manifest.peerDependencies?.[peer], "*", "Pi package docs require wildcard host peers");
		assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true);
		assert.equal(manifest.devDependencies?.[peer], "1.0.0", "migration tests must use current Pi 1.0.0");
		assert.equal(lock.packages[`node_modules/${peer}`]?.version, "1.0.0");
	}
	for (const forbidden of ["pi-mcp-adapter", "@mariozechner/pi-ai", "@mariozechner/pi-coding-agent", "@mariozechner/pi-tui"]) {
		assert.equal(manifest.dependencies?.[forbidden], undefined);
		assert.equal(manifest.devDependencies?.[forbidden], undefined);
		assert.equal(manifest.peerDependencies?.[forbidden], undefined);
		assert.equal(lock.packages[`node_modules/${forbidden}`], undefined);
	}

	// Build explicitly, then inspect payload without npm implicitly running prepack again.
	runNpm(["run", "build"], 120_000);
	const [packed] = parsePackJson(runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], 60_000));
	assert.equal(packed.name, manifest.name);
	assert.equal(packed.version, manifest.version);
	const packedPaths = new Set((packed.files ?? []).map((entry) => normalizeManifestEntry(entry.path)));
	for (const path of ["package.json", "README.md", "AGENTS.md", "LICENSE", ...[
		"index", "jarvis-config", "main-context", "main-session-state", "model-picker", "overlay", "session-ref", "side-session",
		"draft-editor", "overlay-layout", "transcript-viewport",
	].flatMap((name) => [`dist/${name}.js`, `dist/${name}.d.ts`])]) {
		assert.ok(existsSync(join(process.cwd(), path)), `missing built/release artifact: ${path}`);
		assert.ok(packedPaths.has(path), `missing expected packaged path: ${path}`);
	}
	for (const entry of manifest.files ?? []) {
		const path = normalizeManifestEntry(entry);
		assert.ok(path === "dist" ? [...packedPaths].some((p) => p.startsWith("dist/")) : packedPaths.has(path), `missing files entry: ${path}`);
	}
	for (const path of packedPaths) {
		assert.ok(!/(^|\/)(test|tmp|prompts|coord|node_modules|\.pi|\.git)\//.test(path), `forbidden payload path: ${path}`);
		assert.ok(!path.endsWith(".tgz"), `archive must not be repacked: ${path}`);
		assert.ok(path.startsWith("dist/") || ["package.json", "README.md", "AGENTS.md", "LICENSE"].includes(path), `unexpected source artifact: ${path}`);
		assert.ok(!path.startsWith("dist/mcp-policy."), `stale removed artifact: ${path}`);
	}
	console.log("release verification passed");
}

main();
