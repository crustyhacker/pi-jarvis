import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const POLICY_BASELINE = "92734dfa452dc5def523ff2a801b78f68ebcb506";
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

export function options(args, allowed) {
	const result = {};
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i];
		if (!allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith("--") || key in result) {
			throw new Error(`Expected option/value pairs: ${allowed.join(", ")}`);
		}
		result[key] = args[i + 1];
	}
	return result;
}

export function commit(ref) {
	return git("rev-parse", "--verify", `${ref}^{commit}`);
}

function requireFullHistory() {
	if (git("rev-parse", "--is-shallow-repository") !== "false") throw new Error("Full git history and tags are required (fetch-depth: 0)");
}

export function releaseMetadata(sha, tag) {
	const version = tag.slice(1);
	if (!tag.startsWith("v") || !versionPattern.test(version)) throw new Error(`Invalid release tag: ${tag}; expected vX.Y.Z`);
	const read = (path) => git("show", `${sha}:${path}`);
	const pkg = JSON.parse(read("package.json"));
	const lock = JSON.parse(read("package-lock.json"));
	if (pkg.version !== version || lock.version !== version || lock.packages?.[""]?.version !== version ||
		lock.name !== pkg.name || lock.packages?.[""]?.name !== pkg.name) {
		throw new Error(`${tag}: package/lockfile version or name mismatch at ${sha}`);
	}
	const readmeVersions = [...read("README.md").matchAll(/<strong>Current version:<\/strong>\s*([^\s<]+)/g)].map((m) => m[1]);
	if (readmeVersions.length !== 1 || readmeVersions[0] !== version) throw new Error(`${tag}: README current version mismatch`);
	const changelog = read("CHANGELOG.md");
	const entries = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/gm)];
	const released = entries.filter((entry) => entry[1] !== "Unreleased");
	if (released[0]?.[1] !== version || !released[0]?.[2] || released.filter((entry) => entry[1] === version).length !== 1) {
		throw new Error(`${tag}: first released changelog entry must be unique, dated, and match the version`);
	}
	const start = released[0].index + released[0][0].length;
	const end = changelog.indexOf("\n## [", start);
	const notes = changelog.slice(start, end === -1 ? undefined : end).trim();
	if (!notes) throw new Error(`${tag}: changelog entry is empty`);
	return { name: pkg.name, version, notes };
}

function annotatedTag(ref, name) {
	if (git("cat-file", "-t", ref) !== "tag") throw new Error(`${name}: tag must be annotated, not lightweight`);
	const object = git("cat-file", "-p", ref);
	const header = object.split("\n\n", 1)[0];
	const target = /^object ([0-9a-f]+)$/m.exec(header)?.[1];
	if (!/^type commit$/m.test(header) || !target) throw new Error(`${name}: annotated tag must directly target a commit (no nested tags)`);
	if (/^tag (.+)$/m.exec(header)?.[1] !== name) throw new Error(`${name}: annotated object's tag name does not match its ref`);
	return { commit: target, tagObject: git("rev-parse", "--verify", ref) };
}

export function checkReleaseTag(tag, head = "HEAD", expectedTagObject, eventAfter) {
	requireFullHistory();
	const result = annotatedTag(`refs/tags/${tag}`, tag);
	if (result.commit !== commit(head) || result.commit !== commit("HEAD")) throw new Error(`${tag}: tag target must equal expected commit and exact checkout HEAD`);
	if (expectedTagObject && result.tagObject !== expectedTagObject) throw new Error(`${tag}: tag object changed since the push event`);
	// GitHub payloads/contexts may expose the annotation OID or normalize to its
	// commit. Accept only these exact two objects, never another ref/target. The
	// bundle pins the annotation OID across validate/publish even when normalized.
	if (eventAfter && eventAfter !== result.tagObject && eventAfter !== result.commit) throw new Error(`${tag}: pushed event object does not match annotated tag or target commit`);
	return { tag, ...result, ...releaseMetadata(result.commit, tag) };
}

export function checkTags({ head = "HEAD", baseline = POLICY_BASELINE, tagPrefix } = {}) {
	requireFullHistory();
	const tip = commit(head);
	const exempt = commit(baseline); // Fail closed if the policy baseline is not available.
	const commits = git("rev-list", tip, `^${exempt}`).split("\n").filter(Boolean);
	const required = new Set(commits);
	const covered = new Set();
	const errors = [];
	const prefixes = ["refs/tags/"];
	if (tagPrefix) {
		if (!/^refs\/policy\/[a-zA-Z0-9/-]+\/$/.test(tagPrefix)) throw new Error("Extra tags must use a refs/policy/.../ namespace");
		prefixes.push(tagPrefix);
	}
	const refs = git("for-each-ref", "--format=%(refname)", ...prefixes).split("\n").filter(Boolean);
	for (const ref of refs) {
		const prefix = prefixes.find((p) => ref.startsWith(p));
		const name = ref.slice(prefix.length);
		if (!name.startsWith("commit-") && !name.startsWith("v")) continue;
		let target;
		try { target = commit(ref); } catch { continue; }
		if (!required.has(target)) continue;
		try {
			const info = annotatedTag(ref, name);
			if (name.startsWith("commit-")) {
				const short = /^commit-([0-9a-f]{7,40})$/.exec(name)?.[1];
				if (!short || !target.startsWith(short) || commit(short) !== target) throw new Error(`${name}: must use an unambiguous 7–40 digit target commit SHA`);
			} else {
				releaseMetadata(info.commit, name);
			}
			covered.add(target);
		} catch (error) { errors.push(error.message); }
	}
	for (const sha of commits) {
		if (!covered.has(sha)) errors.push(`${sha}: missing annotated commit-${sha.slice(0, 7)} or matching vX.Y.Z tag`);
	}
	if (errors.length) throw new Error(errors.join("\n"));
	return { head: tip, checked: commits.length, baseline: exempt };
}

export function main(args = process.argv.slice(2)) {
	const opts = options(args, ["--head", "--baseline", "--tag-prefix", "--release-tag", "--tag-object", "--event-after"]);
	const result = checkTags({ head: opts["--head"], baseline: opts["--baseline"], tagPrefix: opts["--tag-prefix"] });
	if ((opts["--tag-object"] || opts["--event-after"]) && !opts["--release-tag"]) throw new Error("--tag-object / --event-after requires --release-tag");
	if (opts["--release-tag"]) checkReleaseTag(opts["--release-tag"], opts["--head"], opts["--tag-object"], opts["--event-after"]);
	console.log(`Tag policy passed: ${result.checked} post-baseline commits checked`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
