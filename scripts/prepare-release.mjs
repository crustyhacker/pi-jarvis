// Run npm ci/test/build/verify:release first. This packs that validated build, without lifecycle scripts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkReleaseTag, checkTags, git, options } from "./check-tags.mjs";
import { integrity, sha256, shasum, validateArchive } from "./release-archive.mjs";

let scratch;
try {
	const opts = options(process.argv.slice(2), ["--tag", "--head", "--tag-object", "--event-after", "--baseline", "--out-dir"]);
	if (!opts["--tag"] || !opts["--out-dir"]) throw new Error("Required: --tag vX.Y.Z --out-dir NEW_DIRECTORY");
	checkTags({ head: opts["--head"], baseline: opts["--baseline"] });
	const release = checkReleaseTag(opts["--tag"], opts["--head"], opts["--tag-object"], opts["--event-after"]);
	git("diff", "--exit-code", "HEAD", "--");
	scratch = mkdtempSync(join(tmpdir(), "pi-jarvis-pack-"));
	const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
		encoding: "utf8", timeout: 60000, maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
	}));
	if (!Array.isArray(packed) || packed.length !== 1) throw new Error("npm pack must produce exactly one package");
	const pack = packed[0];
	const filename = `pi-jarvis-${release.version}.tgz`;
	if (pack.filename !== filename || pack.name !== release.name || pack.version !== release.version) throw new Error("npm pack metadata does not match the tag");
	const bytes = readFileSync(join(scratch, filename));
	if (pack.integrity !== integrity(bytes) || pack.shasum !== shasum(bytes)) throw new Error("npm pack archive digest mismatch");
	const files = validateArchive(bytes, release);
	if (JSON.stringify([...files.keys()].sort()) !== JSON.stringify(pack.files.map((file) => file.path).sort())) throw new Error("Archive and npm pack file lists differ");
	for (const [path, contents] of files) {
		if (!contents.equals(readFileSync(path))) throw new Error(`Packed bytes differ from validated build: ${path}`);
	}
	git("diff", "--exit-code", "HEAD", "--");
	const out = resolve(opts["--out-dir"]);
	mkdirSync(out); // Never overwrite a local tarball or a previous bundle.
	writeFileSync(join(out, filename), bytes, { flag: "wx" });
	writeFileSync(join(out, "release.json"), `${JSON.stringify({ ...release, filename, size: bytes.length, sha256: sha256(bytes), integrity: integrity(bytes) }, null, 2)}\n`, { flag: "wx" });
	console.log(`Validated release bundle: ${join(out, filename)} (${sha256(bytes)})`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
