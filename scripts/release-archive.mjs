import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const shasum = (bytes) => createHash("sha1").update(bytes).digest("hex");

// Inspect, never extract, npm's regular-file tar format. Reject links and traversal.
export function archiveFiles(bytes) {
	const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
	const files = new Map();
	let offset = 0;
	const field = (block, start, length) => block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
	for (; offset + 512 <= tar.length; ) {
		const block = tar.subarray(offset, offset + 512);
		if (block.every((byte) => byte === 0)) break;
		const sizeText = field(block, 124, 12).trim();
		const size = parseInt(sizeText, 8);
		const checksum = parseInt(field(block, 148, 8).trim(), 8);
		const actualChecksum = block.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
		if (!/^[0-7]+$/.test(sizeText) || !Number.isSafeInteger(size) || checksum !== actualChecksum) throw new Error("Invalid tar header");
		const prefix = field(block, 345, 155);
		const name = `${prefix ? `${prefix}/` : ""}${field(block, 0, 100)}`;
		const type = block[156];
		if (type !== 0 && type !== 48) throw new Error(`Non-regular tar entry: ${name}`);
		if (!name.startsWith("package/") || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe tar path: ${name}`);
		const path = name.slice(8);
		if (files.has(path)) throw new Error(`Duplicate tar path: ${path}`);
		const end = offset + 512 + size;
		if (end > tar.length) throw new Error("Truncated tar entry");
		files.set(path, tar.subarray(offset + 512, end));
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	if (offset + 1024 > tar.length || !tar.subarray(offset).every((byte) => byte === 0)) throw new Error("Invalid tar terminator");
	return files;
}

export function validateArchive(bytes, { name, version }) {
	const files = archiveFiles(bytes);
	for (const path of files.keys()) {
		if (!path.startsWith("dist/") && !["package.json", "README.md", "AGENTS.md", "LICENSE", "docs/archive-encryption-design.md"].includes(path)) throw new Error(`Forbidden packaged path: ${path}`);
		if (/(^|\/)(test|tmp|prompts|coord|node_modules|\.pi|\.git)\//.test(path) || path.endsWith(".tgz") || path.startsWith("dist/mcp-policy.")) throw new Error(`Forbidden packaged path: ${path}`);
	}
	for (const path of ["package.json", "README.md", "AGENTS.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
		if (!files.has(path)) throw new Error(`Missing packaged path: ${path}`);
	}
	const manifest = JSON.parse(files.get("package.json").toString("utf8"));
	if (name !== "pi-jarvis" || manifest.name !== name || manifest.version !== version) throw new Error("Packaged manifest does not match release");
	const readmeVersions = [...files.get("README.md").toString("utf8").matchAll(/<strong>Current version:<\/strong>\s*([^\s<]+)/g)];
	if (readmeVersions.length !== 1 || readmeVersions[0][1] !== version) throw new Error("Packaged README does not match release");
	return files;
}

export function validateBundle(bytes, bundle, release) {
	for (const key of ["tag", "tagObject", "commit", "name", "version", "notes"]) {
		if (bundle[key] !== release[key]) throw new Error(`Release bundle ${key} does not match exact tag checkout`);
	}
	if (bundle.filename !== `pi-jarvis-${release.version}.tgz` || bundle.sha256 !== sha256(bytes) || bundle.integrity !== integrity(bytes) || bundle.size !== bytes.length) throw new Error("Release archive digest, size, or filename mismatch");
	return validateArchive(bytes, release);
}
