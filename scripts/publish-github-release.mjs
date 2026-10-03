// GitHub release/assets only. No npm publishing, overwrite, delete, or npm credentials.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReleaseTag, options } from "./check-tags.mjs";
import { sha256, validateBundle } from "./release-archive.mjs";

try {
	const opts = options(process.argv.slice(2), ["--tag", "--head", "--tag-object", "--event-after", "--bundle-dir"]);
	if (!opts["--tag"] || !opts["--bundle-dir"] || (!opts["--tag-object"] && !opts["--event-after"])) throw new Error("Required: --tag --bundle-dir and --tag-object or --event-after (optionally --head)");
	const release = checkReleaseTag(opts["--tag"], opts["--head"], opts["--tag-object"], opts["--event-after"]);
	const bundle = JSON.parse(readFileSync(join(opts["--bundle-dir"], "release.json"), "utf8"));
	if (bundle.filename !== `pi-jarvis-${release.version}.tgz`) throw new Error("Invalid bundle filename");
	const bytes = readFileSync(join(opts["--bundle-dir"], bundle.filename));
	validateBundle(bytes, bundle, release);
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GH_TOKEN;
	if (!repository || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
	const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
	const root = `${api}/repos/${repository}`;
	async function request(url, { method = "GET", body, binary = false } = {}) {
		const response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`, Accept: binary ? "application/octet-stream" : "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28", "Content-Type": Buffer.isBuffer(body) ? "application/gzip" : "application/json",
			},
			body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
			signal: AbortSignal.timeout(120000),
		});
		if (response.status === 404) return { status: 404 };
		if (!response.ok) {
			const error = new Error(`GitHub ${method} ${url}: ${response.status} ${await response.text()}`);
			error.status = response.status;
			throw error;
		}
		return { status: response.status, data: binary ? Buffer.from(await response.arrayBuffer()) : await response.json() };
	}
	async function verifyRemoteTag() {
		const ref = (await request(`${root}/git/ref/tags/${encodeURIComponent(release.tag)}`)).data;
		if (ref?.object?.type !== "tag" || ref.object.sha !== release.tagObject) throw new Error("Remote release tag is missing, lightweight, or moved");
		const object = (await request(`${root}/git/tags/${release.tagObject}`)).data;
		if (object?.tag !== release.tag || object?.object?.type !== "commit" || object.object.sha !== release.commit) throw new Error("Remote annotated tag target/name changed");
	}
	await verifyRemoteTag();
	const releaseUrl = `${root}/releases/tags/${encodeURIComponent(release.tag)}`;
	let existing = (await request(releaseUrl)).data;
	if (!existing) {
		try {
			existing = (await request(`${root}/releases`, { method: "POST", body: {
				tag_name: release.tag, target_commitish: release.commit, name: release.tag,
				body: `${release.notes}\n\nNpm publishing is a separate, manual maintainer step.`, draft: true, prerelease: false,
			} })).data;
		} catch (error) {
			if (error.status !== 422) throw error;
			existing = (await request(releaseUrl)).data; // Another run may have created it.
			if (!existing) throw error;
		}
	}
	if (existing.tag_name !== release.tag || !Number.isSafeInteger(existing.id)) throw new Error("Existing GitHub release does not match tag");
	async function findAsset() {
		const matches = [];
		for (let page = 1; ; page++) {
			const assets = (await request(`${root}/releases/${existing.id}/assets?per_page=100&page=${page}`)).data;
			if (!Array.isArray(assets)) throw new Error("Invalid GitHub assets response");
			matches.push(...assets.filter((asset) => asset.name === bundle.filename));
			if (assets.length < 100) break;
		}
		if (matches.length > 1) throw new Error("Multiple released assets have the same name; refusing to overwrite");
		return matches[0];
	}
	async function requireSameAsset(asset) {
		if (!Number.isSafeInteger(asset.id) || asset.state !== "uploaded" || asset.size !== bytes.length) throw new Error("Existing released asset differs or is incomplete; refusing to overwrite");
		const remote = (await request(`${root}/releases/assets/${asset.id}`, { binary: true })).data;
		if (!remote || remote.length !== bytes.length || sha256(remote) !== bundle.sha256) throw new Error("Existing released bytes differ; refusing to overwrite");
	}
	let asset = await findAsset();
	if (asset) await requireSameAsset(asset);
	else {
		await verifyRemoteTag();
		const uploadUrl = new URL(existing.upload_url.replace(/\{.*$/, ""));
		// Never send the release token to a host other than GitHub's configured upload service.
		const allowedUploadOrigin = api === "https://api.github.com" ? "https://uploads.github.com" : new URL(api).origin;
		if (uploadUrl.origin !== allowedUploadOrigin) throw new Error("Unexpected GitHub asset upload origin");
		uploadUrl.searchParams.set("name", bundle.filename);
		try { await request(uploadUrl.href, { method: "POST", body: bytes }); }
		catch (error) { if (error.status !== 422) throw error; }
		asset = await findAsset();
		if (!asset) throw new Error("Release asset upload did not complete");
		await requireSameAsset(asset);
	}
	await verifyRemoteTag();
	if (existing.draft) await request(`${root}/releases/${existing.id}`, { method: "PATCH", body: { draft: false, make_latest: "legacy" } });
	console.log(`GitHub release ${release.tag}: validated asset ${bundle.filename} (${bundle.sha256}); npm publishing remains manual`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
