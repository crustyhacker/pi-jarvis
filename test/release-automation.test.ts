import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const script = (name: string) => join(project, "scripts", name);
type Repo = { root: string; cwd: string; baseline: string };
type Result = { status: number | null; stdout: string; stderr: string };

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(cwd: string): string {
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "test commit");
	return git(cwd, "rev-parse", "HEAD");
}
function addCommit(cwd: string, version = "1.5.0"): string {
	metadata(cwd, version);
	appendFileSync(join(cwd, "history.txt"), "new commit\n");
	return commit(cwd);
}
function versionTagFor(cwd: string, sha: string): string {
	return `v${JSON.parse(git(cwd, "show", `${sha}:package.json`)).version}`;
}
function annotate(cwd: string, sha: string, name = versionTagFor(cwd, sha)): string {
	git(cwd, "tag", "-a", name, sha, "-m", name);
	return git(cwd, "rev-parse", `refs/tags/${name}`);
}
function metadata(cwd: string, version = "1.5.0"): void {
	writeFileSync(join(cwd, "package.json"), JSON.stringify({
		name: "pi-jarvis", version, files: ["dist", "README.md", "AGENTS.md", "LICENSE"],
		// prepare-release must never run a lifecycle script.
		scripts: { prepack: "node -e 'process.exit(99)'" },
	}, null, 2));
	writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ name: "pi-jarvis", version, lockfileVersion: 3, packages: { "": { name: "pi-jarvis", version } } }));
	writeFileSync(join(cwd, "README.md"), `<p><strong>Current version:</strong> ${version}</p>\n`);
	writeFileSync(join(cwd, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n### Changed\n- Future work.\n\n## [${version}] - 2026-10-03\n\n### Added\n- Release notes.\n\n## [1.4.0] - 2026-10-02\n\n- Old notes.\n`);
}
function repo(t: TestContext): Repo {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-release-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "repo");
	mkdirSync(cwd);
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "config", "user.name", "Release test");
	git(cwd, "config", "user.email", "release@example.invalid");
	git(cwd, "config", "commit.gpgsign", "false");
	git(cwd, "config", "tag.gpgsign", "false");
	metadata(cwd);
	writeFileSync(join(cwd, "AGENTS.md"), "fixture agent notes\n");
	writeFileSync(join(cwd, "LICENSE"), "fixture license\n");
	mkdirSync(join(cwd, "dist"));
	writeFileSync(join(cwd, "dist", "index.js"), "export {};\n");
	writeFileSync(join(cwd, "dist", "index.d.ts"), "export {};\n");
	writeFileSync(join(cwd, "history.txt"), "historical commit\n");
	return { root, cwd, baseline: commit(cwd) };
}
function cli(cwd: string, name: string, args: string[], env: NodeJS.ProcessEnv = {}): Result {
	const result = spawnSync(process.execPath, [script(name), ...args], {
		cwd, encoding: "utf8", timeout: 30000, env: { ...process.env, ...env },
	});
	assert.ifError(result.error);
	return result;
}
function cliAsync(cwd: string, name: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script(name), ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => { child.kill(); reject(new Error("helper timed out")); }, 30000);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
	});
}
function ok(result: Result): void { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); }
function fails(result: Result, message: RegExp): void {
	assert.notEqual(result.status, 0, result.stdout);
	assert.match(result.stderr, message);
}
function check(r: Repo, args: string[] = []): Result {
	return cli(r.cwd, "check-tags.mjs", ["--baseline", r.baseline, ...args]);
}
function releaseFixture(t: TestContext): Repo & { head: string; object: string; bundleDir: string } {
	const r = repo(t);
	const head = addCommit(r.cwd);
	const object = annotate(r.cwd, head, "v1.5.0");
	const bundleDir = join(r.root, "bundle");
	ok(cli(r.cwd, "prepare-release.mjs", ["--baseline", r.baseline, "--tag", "v1.5.0", "--head", head, "--tag-object", object, "--out-dir", bundleDir]));
	return { ...r, head, object, bundleDir };
}

test("policy baseline and all reachable historical ancestors are exempt", (t) => {
	const r = repo(t);
	ok(check(r));
	const baseline = addCommit(r.cwd);
	ok(cli(r.cwd, "check-tags.mjs", ["--baseline", baseline]));
	fails(cli(r.cwd, "check-tags.mjs", ["--baseline", "0".repeat(40)]), /rev-parse|Command failed/);
});

test("multi-commit push needs tags on intermediate commits, not only its tip", (t) => {
	const r = repo(t);
	const first = addCommit(r.cwd);
	const second = addCommit(r.cwd, "1.5.1");
	annotate(r.cwd, second);
	fails(check(r), new RegExp(`${first}: missing annotated`));
	annotate(r.cwd, first);
	ok(check(r));
	assert.match(check(r).stdout, /2 post-baseline commits/);
});

test("PR checks use real head commits, not synthetic merge; actual merges check both parents", (t) => {
	const r = repo(t);
	git(r.cwd, "checkout", "-qb", "feature");
	writeFileSync(join(r.cwd, "feature.txt"), "feature\n");
	const feature = commit(r.cwd);
	annotate(r.cwd, feature);
	git(r.cwd, "checkout", "-q", "main");
	const main = addCommit(r.cwd, "1.5.1");
	annotate(r.cwd, main);
	git(r.cwd, "merge", "--no-ff", "--no-commit", "feature");
	metadata(r.cwd, "1.5.2");
	const merge = commit(r.cwd);
	ok(check(r, ["--head", feature]));
	fails(check(r), /missing annotated/);
	annotate(r.cwd, merge);
	git(r.cwd, "tag", "-d", versionTagFor(r.cwd, feature));
	fails(check(r), new RegExp(`${feature}: missing annotated`));
	annotate(r.cwd, feature);
	ok(check(r));
});

test("lightweight, SHA-only, non-version, wrong-target, malformed and nested tags cannot satisfy policy", async (t) => {
	for (const kind of ["lightweight", "sha-only", "wrong-prefix", "wrong-target", "nested", "renamed-object", "leading-zero-core", "unprefixed-dev", "release-candidate", "build-metadata", "unprefixed-stable", "prefixed-dev"]) {
		await t.test(kind, (t) => {
			const r = repo(t);
			const head = addCommit(r.cwd);
			const name = "v1.5.0";
			if (kind === "lightweight") git(r.cwd, "tag", name);
			if (kind === "sha-only") annotate(r.cwd, head, `commit-${head.slice(0, 7)}`);
			if (kind === "wrong-prefix") annotate(r.cwd, head, "notes");
			if (kind === "wrong-target") annotate(r.cwd, r.baseline, name);
			if (kind === "leading-zero-core") annotate(r.cwd, head, "v01.5.0");
			if (kind === "unprefixed-dev") annotate(r.cwd, head, "1.5.0-dev.1");
			if (kind === "release-candidate") annotate(r.cwd, head, "v1.5.0-rc.1");
			if (kind === "build-metadata") annotate(r.cwd, head, "v1.5.0+build.1");
			if (kind === "unprefixed-stable") annotate(r.cwd, head, "1.6.0");
			if (kind === "prefixed-dev") annotate(r.cwd, head, "v1.6.0-dev.1");
			if (kind === "nested") {
				annotate(r.cwd, head, "inner");
				git(r.cwd, "tag", "-a", name, "inner", "-m", "nested");
			}
			if (kind === "renamed-object") git(r.cwd, "update-ref", `refs/tags/${name}`, annotate(r.cwd, head, "inner"));
			fails(check(r), /missing annotated|must be annotated|directly target|does not match|unambiguous/);
		});
	}
});

test("an annotated stable version qualifies while a SHA-only alias does not", (t) => {
	const r = repo(t);
	const head = addCommit(r.cwd);
	annotate(r.cwd, head, `commit-${head.slice(0, 7)}`);
	fails(check(r), /missing annotated version tag.*SHA-only and prerelease tags do not qualify/);
	annotate(r.cwd, head, "v1.5.0");
	ok(check(r)); // Legacy SHA aliases do not grant policy coverage.
});

test("a dev alias is rejected even alongside a valid stable version on a new commit", (t) => {
	const r = repo(t);
	const head = addCommit(r.cwd);
	annotate(r.cwd, head, "v1.5.0");
	ok(check(r));
	annotate(r.cwd, head, "1.5.0-dev.1");
	fails(check(r), /Invalid release tag/);
});

test("stable versions in a fork namespace cover real PR commits", (t) => {
	const r = repo(t);
	const head = addCommit(r.cwd);
	const object = annotate(r.cwd, head, "v1.5.0");
	git(r.cwd, "update-ref", "refs/policy/fork-tags/v1.5.0", object);
	git(r.cwd, "tag", "-d", "v1.5.0");
	fails(check(r), /missing annotated version tag/);
	ok(check(r, ["--tag-prefix", "refs/policy/fork-tags/"]));
});

test("fork tags in private namespace count without replacing colliding parent tag", (t) => {
	const r = repo(t);
	const parentObject = annotate(r.cwd, r.baseline, "v1.5.0");
	const head = addCommit(r.cwd);
	const tagInput = `object ${head}\ntype commit\ntag v1.5.0\ntagger Release test <release@example.invalid> 1700000000 +0000\n\nfork release\n`;
	const object = execFileSync("git", ["mktag"], { cwd: r.cwd, input: tagInput, encoding: "utf8" }).trim();
	git(r.cwd, "update-ref", "refs/policy/fork-tags/v1.5.0", object);
	fails(check(r), /missing annotated/);
	ok(check(r, ["--tag-prefix", "refs/policy/fork-tags/"]));
	assert.equal(git(r.cwd, "rev-parse", "refs/tags/v1.5.0"), parentObject);
	fails(check(r, ["--tag-prefix", "refs/tags/"]), /refs\/policy/);
});

test("release metadata and dated first released changelog must match on every new commit", async (t) => {
	const mutations: Array<[string, (cwd: string) => void]> = [
		["manifest", (cwd) => { const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")); pkg.version = "1.6.0"; writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg)); }],
		["lock root", (cwd) => { const lock = JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8")); lock.packages[""].version = "1.6.0"; writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock)); }],
		["README", (cwd) => writeFileSync(join(cwd, "README.md"), "<strong>Current version:</strong> 1.6.0\n")],
		["README duplicate", (cwd) => appendFileSync(join(cwd, "README.md"), "<strong>Current version:</strong> 1.5.0\n")],
		["changelog stale", (cwd) => writeFileSync(join(cwd, "CHANGELOG.md"), "## [1.6.0] - 2026-10-04\n\n- New\n\n## [1.5.0] - 2026-10-03\n\n- Old\n")],
		["changelog undated", (cwd) => writeFileSync(join(cwd, "CHANGELOG.md"), "## [1.5.0]\n\n- Notes\n")],
		["changelog empty", (cwd) => writeFileSync(join(cwd, "CHANGELOG.md"), "## [1.5.0] - 2026-10-03\n")],
	];
	for (const [name, mutate] of mutations) await t.test(name, (t) => {
		const r = repo(t);
		mutate(r.cwd);
		const head = commit(r.cwd);
		annotate(r.cwd, head, "v1.5.0");
		fails(check(r), /mismatch|changelog entry|empty/);
	});
});

test("release tag requires stable semver, direct annotation, exact target, and event object", (t) => {
	const r = repo(t);
	const head = addCommit(r.cwd);
	const object = annotate(r.cwd, head, "v1.5.0");
	ok(check(r, ["--head", head, "--release-tag", "v1.5.0", "--tag-object", object]));
	// Both annotated OIDs and normalized commit SHAs occur in GitHub contexts;
	// accepting either must still enforce the exact annotated tag + peeled target.
	ok(check(r, ["--head", object, "--release-tag", "v1.5.0", "--event-after", object]));
	ok(check(r, ["--head", head, "--release-tag", "v1.5.0", "--event-after", head]));
	fails(check(r, ["--release-tag", "v1.5.0", "--event-after", r.baseline]), /pushed event object/);
	fails(check(r, ["--head", r.baseline, "--release-tag", "v1.5.0"]), /target must equal/);
	fails(check(r, ["--release-tag", "v1.5.0", "--tag-object", "0".repeat(40)]), /changed since the push event/);
	git(r.cwd, "tag", "-d", "v1.5.0");
	git(r.cwd, "tag", "v1.5.0");
	fails(check(r, ["--release-tag", "v1.5.0"]), /must be annotated/);
	git(r.cwd, "tag", "-d", "v1.5.0");
	annotate(r.cwd, head, "v01.5.0");
	fails(check(r), /Invalid release tag/);
});

test("old valid annotated release is explicitly checked even though history is exempt", (t) => {
	const r = repo(t);
	const object = annotate(r.cwd, r.baseline, "v1.5.0");
	ok(check(r, ["--release-tag", "v1.5.0", "--tag-object", object]));
	fails(check(r, ["--tag-object", object]), /requires --release-tag/);
	fails(cli(r.cwd, "check-tags.mjs", ["--unknown", "x"]), /Expected option/);
});

test("shallow checkout fails closed rather than silently exempting missing history", (t) => {
	const r = repo(t);
	annotate(r.cwd, addCommit(r.cwd));
	const shallow = join(r.root, "shallow");
	git(r.root, "clone", "-q", "--depth", "1", pathToFileURL(r.cwd).href, shallow);
	fails(cli(shallow, "check-tags.mjs", ["--baseline", r.baseline]), /Full git history/);
});

test("remote wrapper handles reordered tag pushes with bounded retries using local remotes", async (t) => {
	const r = repo(t);
	const head = addCommit(r.cwd);
	const remote = join(r.root, "remote.git");
	git(r.root, "init", "-q", "--bare", remote);
	git(r.cwd, "remote", "add", "origin", remote);
	git(r.cwd, "push", "-q", "origin", "main");
	const checkout = join(r.root, "checkout");
	git(r.root, "clone", "-q", "--branch", "main", remote, checkout);
	const args = ["--baseline", r.baseline, "--head", head, "--attempts", "12", "--delay-ms", "100"];
	const running = cliAsync(checkout, "check-remote-tags.mjs", args);
	await new Promise((resolve) => setTimeout(resolve, 300));
	annotate(r.cwd, head);
	git(r.cwd, "push", "-q", "origin", `refs/tags/${versionTagFor(r.cwd, head)}`);
	const result = await running;
	ok(result);
	assert.match(result.stderr, /Retrying/);
	fails(cli(checkout, "check-remote-tags.mjs", ["--attempts", "0"]), /Invalid retry bounds/);
	fails(cli(checkout, "check-remote-tags.mjs", ["--fork", "../../bad;echo"]), /Invalid fork/);
});

test("prepare CLI packs actual validated bytes, skips scripts, and preserves existing tarballs", (t) => {
	const r = repo(t);
	const head = addCommit(r.cwd);
	const object = annotate(r.cwd, head, "v1.5.0");
	const oldTarball = join(r.cwd, "pi-jarvis-1.5.0.tgz");
	writeFileSync(oldTarball, "preserve me exactly");
	const out = join(r.root, "bundle");
	const args = ["--baseline", r.baseline, "--tag", "v1.5.0", "--head", head, "--tag-object", object, "--out-dir", out];
	ok(cli(r.cwd, "prepare-release.mjs", args));
	assert.equal(readFileSync(oldTarball, "utf8"), "preserve me exactly");
	const bundle = JSON.parse(readFileSync(join(out, "release.json"), "utf8"));
	const bytes = readFileSync(join(out, bundle.filename));
	assert.equal(bundle.commit, head);
	assert.equal(bundle.tagObject, object);
	assert.equal(bundle.sha256, createHash("sha256").update(bytes).digest("hex"));
	assert.equal(bundle.size, bytes.length);
	assert.match(bundle.notes, /Release notes/);
	assert.doesNotMatch(bundle.notes, /Future work|Old notes/);
	fails(cli(r.cwd, "prepare-release.mjs", args), /EEXIST/);
	assert.deepEqual(readFileSync(join(out, bundle.filename)), bytes);
});

test("release payload permits only the named archive security document, not arbitrary docs", async (t) => {
	for (const name of ["archive-encryption-design.md", "private-notes.md"]) await t.test(name, t => {
		const r = repo(t), path = `docs/${name}`;
		const pkg = JSON.parse(readFileSync(join(r.cwd, "package.json"), "utf8"));
		pkg.files.push(path);
		writeFileSync(join(r.cwd, "package.json"), JSON.stringify(pkg));
		mkdirSync(join(r.cwd, "docs"));
		writeFileSync(join(r.cwd, path), "synthetic release boundary documentation\n");
		annotate(r.cwd, commit(r.cwd), "v1.5.0");
		const out = join(r.root, "bundle");
		const result = cli(r.cwd, "prepare-release.mjs", ["--baseline", r.baseline, "--tag", "v1.5.0", "--out-dir", out]);
		if (name === "archive-encryption-design.md") ok(result);
		else { fails(result, /Forbidden packaged path/); assert.equal(existsSync(out), false); }
	});
});

test("prepare rejects dirty tracked state and forbidden actual payloads", async (t) => {
	await t.test("dirty checkout", (t) => {
		const r = releaseFixture(t);
		appendFileSync(join(r.cwd, "README.md"), "dirty\n");
		fails(cli(r.cwd, "prepare-release.mjs", ["--baseline", r.baseline, "--tag", "v1.5.0", "--out-dir", join(r.root, "new-bundle")]), /diff|Command failed/);
	});
	await t.test("forbidden archive path", (t) => {
		const r = repo(t);
		const pkg = JSON.parse(readFileSync(join(r.cwd, "package.json"), "utf8"));
		pkg.files.push("secret.txt");
		writeFileSync(join(r.cwd, "package.json"), JSON.stringify(pkg));
		writeFileSync(join(r.cwd, "secret.txt"), "not release payload\n");
		annotate(r.cwd, commit(r.cwd), "v1.5.0");
		const out = join(r.root, "bundle");
		fails(cli(r.cwd, "prepare-release.mjs", ["--baseline", r.baseline, "--tag", "v1.5.0", "--out-dir", out]), /Forbidden packaged path/);
		assert.equal(existsSync(out), false);
	});
});

type MockOptions = { existing?: boolean; draft?: boolean; asset?: Buffer; movedTag?: boolean; incomplete?: boolean };
async function mockGitHub(t: TestContext, r: ReturnType<typeof releaseFixture>, options: MockOptions = {}) {
	let release: { id: number; tag_name: string; draft: boolean; upload_url: string } | undefined;
	let asset = options.asset;
	const requests: string[] = [];
	let origin = "";
	const filename = "pi-jarvis-1.5.0.tgz";
	const server = createServer(async (req, res) => {
		const url = new URL(req.url!, origin);
		requests.push(`${req.method} ${url.pathname}`);
		assert.equal(req.headers.authorization, "Bearer mock-token-not-a-secret");
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
		const root = "/repos/example/pi-jarvis";
		if (url.pathname === `${root}/git/ref/tags/v1.5.0`) return send(200, { object: { type: "tag", sha: options.movedTag ? "0".repeat(40) : r.object } });
		if (url.pathname === `${root}/git/tags/${r.object}`) return send(200, { tag: "v1.5.0", object: { type: "commit", sha: r.head } });
		if (url.pathname === `${root}/releases/tags/v1.5.0`) return send(release ? 200 : 404, release ?? {});
		if (url.pathname === `${root}/releases` && req.method === "POST") {
			const payload = JSON.parse(body.toString());
			assert.equal(payload.target_commitish, r.head);
			assert.equal(payload.draft, true);
			assert.match(payload.body, /manual maintainer step/);
			release = { id: 1, tag_name: payload.tag_name, draft: payload.draft, upload_url: `${origin}/uploads{?name,label}` };
			return send(201, release);
		}
		if (url.pathname === `${root}/releases/1/assets`) return send(200, asset ? [{ id: 11, name: filename, state: options.incomplete ? "starter" : "uploaded", size: asset.length }] : []);
		if (url.pathname === "/uploads" && req.method === "POST") {
			assert.equal(url.searchParams.get("name"), filename);
			asset = body;
			return send(201, { id: 11 });
		}
		if (url.pathname === `${root}/releases/assets/11` && asset) {
			res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(asset); return;
		}
		if (url.pathname === `${root}/releases/1` && req.method === "PATCH") {
			assert.equal(JSON.parse(body.toString()).draft, false);
			release!.draft = false;
			return send(200, release);
		}
		return send(404, {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	origin = `http://127.0.0.1:${address.port}`;
	if (options.existing) release = { id: 1, tag_name: "v1.5.0", draft: options.draft ?? false, upload_url: `${origin}/uploads{?name,label}` };
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	return {
		requests,
		publish: (eventAfter = r.head) => cliAsync(r.cwd, "publish-github-release.mjs", ["--tag", "v1.5.0", "--head", r.head, "--event-after", eventAfter, "--bundle-dir", r.bundleDir], {
			GITHUB_REPOSITORY: "example/pi-jarvis", GH_TOKEN: "mock-token-not-a-secret", GITHUB_API_URL: origin,
		}),
	};
}

test("GitHub publication is draft-first, validated, idempotent, and never overwrites released bytes", async (t) => {
	const r = releaseFixture(t);
	const bytes = readFileSync(join(r.bundleDir, "pi-jarvis-1.5.0.tgz"));
	await t.test("new release and identical rerun", async (t) => {
		const mock = await mockGitHub(t, r);
		ok(await mock.publish(r.object));
		ok(await mock.publish(r.head));
		assert.equal(mock.requests.filter((req) => req === "POST /repos/example/pi-jarvis/releases").length, 1);
		assert.equal(mock.requests.filter((req) => req === "POST /uploads").length, 1);
		assert.equal(mock.requests.filter((req) => req.startsWith("PATCH")).length, 1);
		assert.equal(mock.requests.filter((req) => req.startsWith("DELETE")).length, 0);
	});
	await t.test("existing published identical asset", async (t) => {
		const mock = await mockGitHub(t, r, { existing: true, asset: bytes });
		ok(await mock.publish());
		assert.ok(mock.requests.every((req) => req.startsWith("GET")));
	});
	await t.test("existing draft resumes after upload", async (t) => {
		const mock = await mockGitHub(t, r, { existing: true, draft: true, asset: bytes });
		ok(await mock.publish());
		assert.equal(mock.requests.filter((req) => req.startsWith("POST")).length, 0);
		assert.equal(mock.requests.filter((req) => req.startsWith("PATCH")).length, 1);
	});
	await t.test("existing release with missing asset", async (t) => {
		const mock = await mockGitHub(t, r, { existing: true });
		ok(await mock.publish());
		assert.deepEqual(mock.requests.filter((req) => !req.startsWith("GET")), ["POST /uploads"]);
	});
	await t.test("same length but different released bytes fail without mutations", async (t) => {
		const different = Buffer.from(bytes); different[different.length - 1] ^= 1;
		const mock = await mockGitHub(t, r, { existing: true, asset: different });
		fails(await mock.publish(), /Existing released bytes differ/);
		assert.ok(mock.requests.every((req) => req.startsWith("GET")));
	});
	await t.test("incomplete existing asset fails closed", async (t) => {
		const mock = await mockGitHub(t, r, { existing: true, asset: bytes, incomplete: true });
		fails(await mock.publish(), /differs or is incomplete/);
		assert.ok(mock.requests.every((req) => req.startsWith("GET")));
	});
	await t.test("remote moved tag fails before release creation", async (t) => {
		const mock = await mockGitHub(t, r, { movedTag: true });
		fails(await mock.publish(), /Remote release tag/);
		assert.ok(mock.requests.every((req) => req.startsWith("GET")));
	});
	await t.test("tampered local bundle fails before API access", async (t) => {
		const corruptedDir = join(r.root, "corrupt"); mkdirSync(corruptedDir);
		copyFileSync(join(r.bundleDir, "release.json"), join(corruptedDir, "release.json"));
		writeFileSync(join(corruptedDir, "pi-jarvis-1.5.0.tgz"), "tampered");
		fails(await cliAsync(r.cwd, "publish-github-release.mjs", ["--tag", "v1.5.0", "--tag-object", r.object, "--bundle-dir", corruptedDir]), /digest, size, or filename mismatch/);
	});
	await t.test("bundle annotation is pinned even with a normalized commit event", async () => {
		git(r.cwd, "tag", "-fa", "v1.5.0", "-m", "changed annotation");
		try {
			fails(await cliAsync(r.cwd, "publish-github-release.mjs", ["--tag", "v1.5.0", "--head", r.head, "--event-after", r.head, "--bundle-dir", r.bundleDir]), /bundle tagObject does not match/);
			fails(check(r, ["--release-tag", "v1.5.0", "--event-after", r.object]), /pushed event object/);
		} finally { git(r.cwd, "update-ref", "refs/tags/v1.5.0", r.object); }
	});
	await t.test("development version tag never qualifies for GitHub release", () => {
		const tag = "1.6.0-dev.1";
		const object = annotate(r.cwd, r.head, tag);
		fails(cli(r.cwd, "publish-github-release.mjs", ["--tag", tag, "--tag-object", object, "--bundle-dir", r.bundleDir]), /Invalid release tag/);
	});
});

test("workflow surface is pinned, least-privilege, and releases only on v* tag pushes", () => {
	const ci = readFileSync(join(project, ".github/workflows/ci.yml"), "utf8");
	const release = readFileSync(join(project, ".github/workflows/release.yml"), "utf8");
	for (const workflow of [ci, release]) {
		assert.doesNotMatch(workflow, /pull_request_target|secrets\.|run:.*npm publish|NPM_TOKEN|NODE_AUTH_TOKEN/);
		assert.match(workflow, /fetch-depth: 0/);
		assert.match(workflow, /persist-credentials: false/);
		for (const action of workflow.matchAll(/uses: (\S+)/g)) assert.match(action[1], /^actions\/[^@]+@[0-9a-f]{40}$/);
		for (const command of ["npm ci", "npm test", "npm run build", "npm run verify:release"]) assert.ok(workflow.includes(`run: ${command}`));
	}
	assert.match(ci, /node: \['22\.19\.0', '24'\]/);
	assert.match(ci, /github\.event\.pull_request\.head\.sha/);
	assert.match(ci, /--fork/);
	assert.doesNotMatch(ci, /contents: write|GH_TOKEN/);
	assert.match(release, /tags: \['v\*'\]/);
	assert.match(release, /needs: validate/);
	assert.match(release, /artifact-ids: \$\{\{ needs\.validate\.outputs\.artifact-id \}\}/);
	assert.match(release, /cancel-in-progress: false/);
	assert.match(release, /github\.event\.after/);
	assert.equal((release.match(/contents: write/g) ?? []).length, 1);
});
