import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { archiveConfigPath, saveArchivePolicy } from "../archive-config.js";
import { SharedArchiveService, type ArchiveContext } from "../archive-service.js";
import type { ArchiveInput, ArchivePage, ArchiveRead, ArchiveSummary } from "../archive-types.js";

// Public human-command fixtures only: no SDK session boot, provider, credentials,
// MCP, environment redirection, real settings or historical user transcripts.
interface Fixture {
	root: string; agentDir: string; sessions: string; projectA: string; projectB: string;
	service: SharedArchiveService;
	context: (cwd?: string, sessionId?: string, trusted?: () => boolean) => ArchiveContext;
}
async function fixture(run: (f: Fixture) => void | Promise<void>): Promise<void> {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-jarvis-archive-bulk-"));
	const agentDir = join(root, "agent"), sessions = join(agentDir, "sessions");
	const projectA = join(root, "project-a"), projectB = join(root, "project-b");
	for (const path of [sessions, projectA, projectB]) fs.mkdirSync(path, { recursive: true });
	const service = new SharedArchiveService(agentDir);
	const context: Fixture["context"] = (cwd = projectA, sessionId = "bulk-owner", trusted = () => true) => ({
		cwd, mode: "tui", hasUI: true, isProjectTrusted: trusted,
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({ type: "session", version: 3, id: sessionId, cwd, timestamp: "2026-01-01T00:00:00.000Z" }),
			getEntries: () => { assert.fail("bulk commands must not inspect the active journal"); },
		} as unknown as ArchiveContext["sessionManager"],
		ui: { notify: () => {}, confirm: async () => { assert.fail("bulk confirmation must be an explicit command/token, not a UI prompt"); } } as unknown as ArchiveContext["ui"],
	});
	try { await run({ root, agentDir, sessions, projectA, projectB, service, context }); }
	finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const message = (id: string, text = "bulkfixture accepted", parentId: string | null = null): ArchiveInput["entry"] => ({
	id, parentId, type: "message", timestamp: "2026-01-02T03:04:05.000Z",
	message: { role: "user", content: text, timestamp: 100 },
});
function transcript(f: Fixture, relative: string, entries: unknown[] = [message("first")], options: { cwd?: string; id?: string; version?: number; extra?: Record<string, unknown> } = {}): string {
	const path = join(f.sessions, relative);
	fs.mkdirSync(dirname(path), { recursive: true });
	const header = { type: "session", version: options.version ?? 3, id: options.id ?? relative, cwd: options.cwd ?? f.projectA,
		timestamp: "2026-01-01T00:00:00.000Z", ...options.extra };
	fs.writeFileSync(path, [header, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n");
	return path;
}
const enable = (f: Fixture, ctx = f.context()) => f.service.command("on --confirm-sensitive", ctx);
function json<T>(output: string): T {
	// The existing read API prefixes UNTRUSTED notice text; bulk responses are
	// encoded JSON. Do not depend on incidental pretty-printing/notice placement.
	const start = output.indexOf("{");
	assert.ok(start >= 0, "command response must include JSON");
	assert.ok(Buffer.byteLength(output.slice(start)) <= 24_000, "JSON output exceeds 24K budget");
	assert.doesNotMatch(output, /[\u001b\u007f-\u009f\u202a-\u202e\u2066-\u2069]/, "terminal controls must be escaped");
	return JSON.parse(output.slice(start)) as T;
}
interface Preview {
	kind: string; previewId: string; root: string; rootAbbreviated?: boolean;
	candidates: number; skipped: number; samples: Array<{ index: number; path: string; pathAbbreviated?: boolean }>;
	omitted: number; expiresAt: string; confirmCommand: string;
}
interface Counts {
	saved: number; duplicates: number; deleted: number; succeeded: number; failed: number;
	changed: number; skipped: number; unprocessed: number; total: number; discoverySkipped: number;
}
interface Summary extends Counts { kind: string; reportId: string; root: string; stopped?: boolean | string; notice: string }
interface FileResult {
	index: number; path: string; pathAbbreviated?: boolean; status: string;
	saved: number; duplicates: number; deleted: number; line?: number; reason?: string;
}
interface Report extends Counts {
	kind: string; reportId: string; offset: number; records: FileResult[]; nextOffset: number | null; omitted: number;
}
async function preview(f: Fixture, ctx = f.context(), directory?: string): Promise<Preview> {
	const output = await f.service.command(`import-all${directory === undefined ? "" : " " + directory}`, ctx);
	const result = json<Preview & { token?: string }>(output);
	assert.equal(result.kind, "archive-import-preview");
	// Prefer the structured token; tolerate a displayed exact next command so
	// regressions do not assume token length/alphabet or a particular UI layout.
	result.previewId ??= result.token ?? /--preview\s+(\S+)/.exec(result.confirmCommand ?? output)?.[1] ?? "";
	assert.ok(result.previewId);
	assert.match(result.confirmCommand, /import-all\s+--confirm-sensitive\s+--preview\s+/);
	assert.ok(result.confirmCommand.includes(result.previewId));
	assert.ok(Number.isSafeInteger(result.candidates) && result.candidates >= 0);
	assert.ok(Number.isSafeInteger(result.skipped) && result.skipped >= 0);
	assert.ok(Number.isFinite(Date.parse(result.expiresAt)));
	assert.ok(Array.isArray(result.samples));
	return result;
}
const confirmArgs = (p: Preview, directory?: string) => `import-all --confirm-sensitive --preview ${p.previewId}${directory === undefined ? "" : " " + directory}`;
function counts(result: Counts): void {
	for (const key of ["saved", "duplicates", "deleted", "succeeded", "failed", "changed", "skipped", "unprocessed", "total", "discoverySkipped"] as const) {
		assert.ok(Number.isSafeInteger(result[key]) && result[key] >= 0, `missing/invalid count ${key}`);
	}
	assert.equal(result.succeeded + result.failed + result.changed + result.skipped + result.unprocessed, result.total);
}
async function confirm(f: Fixture, p: Preview, ctx = f.context(), directory?: string): Promise<Summary> {
	const result = json<Summary>(await f.service.command(confirmArgs(p, directory), ctx));
	assert.equal(result.kind, "archive-import-summary"); counts(result);
	assert.ok(result.reportId); assert.match(result.notice, /source.*unchanged|source.*not modified/i);
	return result;
}
async function report(f: Fixture, id: string, ctx = f.context(), offset = 0): Promise<Report> {
	const result = json<Report>(await f.service.command(`import-report ${id} ${offset}`, ctx));
	assert.equal(result.kind, "archive-import-report"); assert.equal(result.reportId, id); assert.equal(result.offset, offset);
	counts(result); assert.ok(Array.isArray(result.records));
	if (result.nextOffset !== null) {
		assert.ok(result.nextOffset > offset, "report pagination must make progress");
		assert.equal(result.nextOffset, offset + result.records.length, "report offset tracks file ordinals, not bytes");
	}
	for (const item of result.records) {
		assert.ok(Number.isSafeInteger(item.index) && item.index >= 0 && item.index < result.total);
		assert.ok(["succeeded", "failed", "changed", "skipped", "unprocessed"].includes(item.status));
	}
	return result;
}
async function allResults(f: Fixture, id: string, ctx = f.context()): Promise<FileResult[]> {
	let offset = 0; const results: FileResult[] = [];
	for (;;) {
		const page = await report(f, id, ctx, offset); results.push(...page.records);
		if (page.nextOffset === null) { assert.equal(results.length, page.total); break; }
		assert.ok(page.omitted > 0, "bounded report must disclose omitted results"); offset = page.nextOffset;
	}
	assert.deepEqual(results.map(item => item.index), Array.from({ length: results.length }, (_, i) => i));
	return results;
}
const search = (f: Fixture, query: string, ctx = f.context(), all = true) => json<ArchivePage>(f.service.search({ query, scope: all ? "all" : "current", limit: 50 }, ctx, false)).records;
function sessionRecords(f: Fixture, id: string, ctx = f.context()): ArchiveSummary[] {
	let offset = 0; const found: ArchiveSummary[] = [];
	for (;;) {
		const page = json<ArchivePage>(f.service.session({ sessionId: id, scope: "all", limit: 50, offset }, ctx, false));
		found.push(...page.records); if (page.nextOffset === null) return found;
		assert.ok(page.nextOffset > offset); offset = page.nextOffset;
	}
}
function raw(f: Fixture, id: string, ctx = f.context()): unknown {
	let offset = 0, content = "";
	for (;;) {
		const page = json<ArchiveRead>(f.service.read({ id, scope: "all", offset, limit: 12_000 }, ctx, false));
		content += page.content; if (page.nextOffset === null) return JSON.parse(content);
		assert.ok(page.nextOffset > offset); offset = page.nextOffset;
	}
}
function snapshot(path: string) {
	const stat = fs.statSync(path, { bigint: true });
	return { bytes: fs.readFileSync(path), dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs, nlink: stat.nlink };
}
function noRecords(t: TestContext, f: Fixture): () => void {
	const calls: string[] = [];
	for (const method of ["append", "search", "read", "session", "stats", "forgetSession", "prune"] as const) {
		t.mock.method(f.service.store, method, () => { calls.push(method); throw new Error("Unexpected archive record access"); });
	}
	return () => assert.deepEqual(calls, [], "preview/disabled commands must not touch archive records");
}
function noBodies(t: TestContext): () => void {
	const reads: string[] = [];
	const guard = (path: unknown) => {
		if (String(path).endsWith(".jsonl")) { reads.push(String(path)); throw new Error("Preview transcript body access forbidden"); }
	};
	for (const [module, method] of [[fs, "readFileSync"], [fs, "openSync"], [fs, "createReadStream"], [fsp, "readFile"], [fsp, "open"]] as const) {
		const original = module[method as keyof typeof module] as (...args: any[]) => any;
		t.mock.method(module as any, method, (...args: any[]) => { guard(args[0]); return Reflect.apply(original, module, args); });
	}
	syncBuiltinESMExports();
	return () => assert.deepEqual(reads, [], "preview must discover metadata without opening transcript bodies");
}
function restore(t: TestContext): void { t.mock.restoreAll(); syncBuiltinESMExports(); }
const safeError = (error: unknown) => {
	assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE_(?:SOURCE|NATIVE|CONFIG)_CANARY/); return true;
};

test("bulk preview is lazy, metadata-only, recursive and defaults to this temporary agent's sessions", async t => {
	await fixture(async f => {
		const a = transcript(f, "encoded-project-a/nested/a.jsonl"), b = transcript(f, "encoded-project-b/b.jsonl", [], { cwd: f.projectB });
		fs.writeFileSync(join(f.sessions, "ignored.JSONL"), "PRIVATE_SOURCE_CANARY");
		fs.writeFileSync(join(f.sessions, "ignored.txt"), "PRIVATE_SOURCE_CANARY");
		await enable(f); const untouched = [a, b].map(snapshot);
		const assertNoRecords = noRecords(t, f), assertNoBodies = noBodies(t);
		try {
			const p = await preview(f); assert.equal(p.root, fs.realpathSync(f.sessions)); assert.equal(p.candidates, 2);
			assert.ok(p.samples.length <= p.candidates); assertNoRecords(); assertNoBodies();
			assert.equal(fs.existsSync(f.service.store.path), false);
			assert.equal(fs.existsSync(dirname(f.service.store.path)), false);
		} finally { restore(t); }
		assert.deepEqual([a, b].map(snapshot), untouched);
	});
});

test("default OFF, untrusted, capture OFF, corrupt settings and an aborted command fail closed without record/body access", async t => {
	await fixture(async f => {
		transcript(f, "private.jsonl");
		const assertNoRecords = noRecords(t, f), assertNoBodies = noBodies(t);
		try {
			await assert.rejects(f.service.command("import-all", f.context()), /disabled|capture|permitted/);
			await enable(f);
			await assert.rejects(f.service.command("import-all", f.context(f.projectA, "bulk-owner", () => false)), /disabled|untrusted/);
			await f.service.command("capture off", f.context());
			await assert.rejects(f.service.command("import-all", f.context()), /disabled|capture|permitted/);
			await f.service.command("capture on", f.context());
			await assert.rejects(f.service.command("import-all", { ...f.context(), signal: AbortSignal.abort() }), /cancel|disabled/);
			const path = archiveConfigPath(f.projectA, f.agentDir, "project"); fs.mkdirSync(dirname(path), { recursive: true });
			fs.writeFileSync(path, '{"archive": PRIVATE_CONFIG_CANARY');
			await assert.rejects(f.service.command("import-all", f.context()), safeError);
			assert.equal(fs.readFileSync(path, "utf8"), '{"archive": PRIVATE_CONFIG_CANARY');
			assertNoRecords(); assertNoBodies(); assert.equal(fs.existsSync(f.service.store.path), false);
		} finally { restore(t); }
	});
});

test("bulk confirmation requires both sensitive acknowledgement and a prior valid preview token", async () => {
	await fixture(async f => {
		transcript(f, "a.jsonl"); await enable(f);
		for (const args of ["import-all --confirm-sensitive", "import-all --confirm-sensitive --preview fabricated", "import-all --preview fabricated", "import-all --confirm"]) {
			await assert.rejects(f.service.command(args, f.context()));
		}
		const p = await preview(f);
		await assert.rejects(f.service.command(`import-all --preview ${p.previewId}`, f.context()), /confirm-sensitive|acknowledg|sensitive/);
		assert.equal(fs.existsSync(f.service.store.path), false);
		const fresh = await preview(f), result = await confirm(f, fresh);
		assert.equal(result.saved, 2); assert.equal(result.total, 1);
		await assert.rejects(f.service.command(confirmArgs(fresh), f.context()), /preview|expired|token/);
	});
});

test("recursive import honors source headers, raw content and synthetic header provenance, not directory names/references", async () => {
	await fixture(async f => {
		const parent = join(f.root, "outside-parent.jsonl"), attachment = join(f.root, "outside-attachment.txt");
		fs.writeFileSync(parent, "PARENT_BODY_MUST_NOT_IMPORT"); fs.writeFileSync(attachment, "ATTACHMENT_MUST_NOT_IMPORT");
		const values = [message("user", "crossprojectfixture from actual header"), {
			id: "tool", parentId: "user", type: "message", timestamp: "2026-01-02T03:04:06Z",
			message: { role: "toolResult", content: [{ type: "text", text: "crossprojectfixture raw secret=fixture-only" },
				{ type: "image", mimeType: "image/png", data: "RAW_IMAGE_CANARY" }], isError: true, attachmentPath: attachment },
		}];
		const foreign = transcript(f, "misleading-project-a/deeper/foreign.jsonl", values, { cwd: f.projectB, id: "header-b", extra: { parentSession: parent, exactMetadata: "HEADER_CANARY" } });
		const local = transcript(f, "misleading-project-b/local.jsonl", [message("local", "crossprojectfixture local")], { cwd: f.projectA, id: "header-a" });
		const originals = [foreign, local, parent, attachment].map(snapshot); await enable(f);
		const p = await preview(f), result = await confirm(f, p);
		assert.equal(result.saved, 5); assert.equal(result.succeeded, 2); assert.equal(result.failed, 0);
		const found = search(f, "crossprojectfixture"); assert.equal(found.length, 3);
		assert.equal(search(f, "crossprojectfixture", f.context(), false).length, 1);
		assert.ok(found.filter(record => record.sessionId === "header-b").every(record => record.project === f.projectB && record.lane === "import"));
		const archived = sessionRecords(f, "header-b"); assert.equal(archived.length, 3);
		for (const value of values) assert.deepEqual(raw(f, archived.find(record => record.entryId === value.id)!.id), value);
		const sourceHeader = JSON.parse(fs.readFileSync(foreign, "utf8").split("\n")[0]!);
		assert.deepEqual(raw(f, archived.find(record => record.type === "archive_session_header")!.id), {
			id: "__pi_jarvis_archive_header__", parentId: null, type: "archive_session_header", timestamp: sourceHeader.timestamp, header: sourceHeader,
		});
		assert.equal(search(f, "PARENT_BODY_MUST_NOT_IMPORT").length, 0); assert.equal(search(f, "ATTACHMENT_MUST_NOT_IMPORT").length, 0);
		assert.deepEqual([foreign, local, parent, attachment].map(snapshot), originals);
		assert.ok((await allResults(f, result.reportId)).every(item => item.status === "succeeded"));
	});
});

test("malformed/legacy/partial files report safe per-file failures and continue; repeat batches dedup and respect tombstones", async () => {
	await fixture(async f => {
		const good = transcript(f, "01-good.jsonl", [message("good", "continuefixture valid")], { id: "good-session" });
		const legacy = transcript(f, "02-legacy.jsonl", [message("old")], { id: "old-session", version: 2 });
		const malformed = join(f.sessions, "03-malformed.jsonl"); fs.writeFileSync(malformed, '{"PRIVATE_SOURCE_CANARY": broken}\n');
		const partial = transcript(f, "04-partial.jsonl", [message("accepted", "continuefixture partial")], { id: "partial-session" });
		fs.appendFileSync(partial, '{"PRIVATE_SOURCE_CANARY": broken}\n' + JSON.stringify(message("not-accepted", "MUST_NOT_SKIP_BAD_LINE")) + "\n");
		const after = transcript(f, "05-after.jsonl", [message("after", "continuefixture after")], { id: "after-session" });
		const paths = [good, legacy, malformed, partial, after], originals = paths.map(snapshot); await enable(f);
		const result = await confirm(f, await preview(f)); assert.equal(result.saved, 6); assert.equal(result.succeeded, 2); assert.equal(result.failed, 3);
		const records = await allResults(f, result.reportId);
		assert.equal(records.find(item => item.path === partial)!.saved, 2);
		assert.ok(records.filter(item => item.status === "failed").every(item => item.reason && Number.isSafeInteger(item.line)));
		assert.doesNotMatch(JSON.stringify(records), /PRIVATE_SOURCE_CANARY|SyntaxError|Unexpected token/);
		assert.equal(search(f, "continuefixture").length, 3); assert.equal(search(f, "MUST_NOT_SKIP_BAD_LINE").length, 0);
		const repeated = await confirm(f, await preview(f)); assert.equal(repeated.saved, 0); assert.equal(repeated.duplicates, 6); assert.equal(repeated.failed, 3);
		await f.service.command("forget-session --all --confirm good-session", f.context());
		const tombstoned = await confirm(f, await preview(f)); assert.equal(tombstoned.saved, 0); assert.equal(tombstoned.deleted, 2); assert.equal(tombstoned.duplicates, 4);
		assert.deepEqual(paths.map(snapshot), originals);
	});
});

test("conflicting identities fail that file without replacement; invalid UTF-8/schema files do not stop valid files", async () => {
	await fixture(async f => {
		const good = transcript(f, "01-original.jsonl", [message("same", "conflictfixture original")], { id: "shared-session" });
		transcript(f, "02-conflict.jsonl", [message("same", "MUST_NOT_REPLACE_ORIGINAL")], { id: "shared-session" });
		const utf8 = transcript(f, "03-utf8.jsonl", [], { id: "utf8-session" }); fs.appendFileSync(utf8, Buffer.from([255, 254, 10]));
		transcript(f, "04-schema.jsonl", [{ ...message("invalid", "PRIVATE_SOURCE_CANARY"), parentId: 42 }], { id: "schema-session" });
		transcript(f, "05-valid.jsonl", [message("valid", "conflictfixture after")], { id: "after-session" });
		await enable(f);
		// Establish the original independently of unspecified filesystem cursor
		// order; the batch must never replace it with a conflicting payload.
		await f.service.command(`import --confirm-sensitive ${good}`, f.context());
		const result = await confirm(f, await preview(f)); assert.equal(result.failed, 3); assert.equal(result.succeeded, 2);
		assert.equal(result.saved, 4); assert.equal(result.duplicates, 3);
		const original = sessionRecords(f, "shared-session").find(record => record.entryId === "same")!;
		assert.deepEqual(raw(f, original.id), message("same", "conflictfixture original"));
		assert.equal(search(f, "MUST_NOT_REPLACE_ORIGINAL").length, 0);
		assert.doesNotMatch(JSON.stringify(await allResults(f, result.reportId)), /PRIVATE_SOURCE_CANARY/);
		assert.deepEqual(JSON.parse(fs.readFileSync(good, "utf8").split("\n")[1]!), message("same", "conflictfixture original"));
	});
});

test("preview skips nested symlinks, hardlinks and FIFOs without following/opening them; selected root symlink resolves once", { skip: process.platform === "win32" }, async t => {
	await fixture(async f => {
		const good = transcript(f, "good.jsonl", [message("good", "linkfixture accepted")]);
		const outside = join(f.root, "outside"); fs.mkdirSync(outside);
		const external = join(outside, "external.jsonl"); fs.copyFileSync(good, external);
		fs.symlinkSync(outside, join(f.sessions, "linked-directory")); fs.symlinkSync(external, join(f.sessions, "linked-file.jsonl"));
		fs.linkSync(external, join(f.sessions, "hardlinked-file.jsonl"));
		execFileSync("mkfifo", [join(f.sessions, "pipe.jsonl")]);
		const rootLink = join(f.root, "selected-root"); fs.symlinkSync(f.sessions, rootLink);
		await enable(f); const assertNoBodies = noBodies(t);
		let p: Preview;
		try { p = await preview(f, f.context(), rootLink); assert.equal(p.root, fs.realpathSync(f.sessions)); assert.equal(p.candidates, 1); assert.ok(p.skipped >= 4); assertNoBodies(); }
		finally { restore(t); }
		const result = await confirm(f, p!); assert.equal(result.saved, 2); assert.equal(result.discoverySkipped, p!.skipped);
		assert.equal(search(f, "linkfixture").length, 1); assert.equal(fs.statSync(external).nlink, 2);
	});
});

for (const change of ["replace", "same-size rewrite", "append", "remove", "symlink", "hardlink", "FIFO"] as const) {
	test(`reviewed candidate ${change} is rejected without importing replacement; other reviewed files continue`, { skip: process.platform === "win32" && ["symlink", "hardlink", "FIFO"].includes(change) }, async () => {
		await fixture(async f => {
			const selected = transcript(f, "01-selected.jsonl", [message("selected", "PINNED_OLD_BODY")], { id: "selected-session" });
			transcript(f, "02-good.jsonl", [message("good", "safetyfixture other")], { id: "good-session" });
			const replacement = join(f.root, "replacement.jsonl"); fs.copyFileSync(selected, replacement);
			await enable(f); const p = await preview(f);
			if (change === "replace") { fs.rmSync(selected); fs.copyFileSync(replacement, selected); }
			else if (change === "same-size rewrite") {
				const before = fs.statSync(selected); const text = fs.readFileSync(selected, "utf8").replace("PINNED_OLD_BODY", "MUTANT_NEW_BODY");
				fs.writeFileSync(selected, text); fs.utimesSync(selected, before.atime, before.mtime);
			} else if (change === "append") fs.appendFileSync(selected, JSON.stringify(message("extra", "MUTANT_NEW_BODY")) + "\n");
			else if (change === "remove") fs.rmSync(selected);
			else if (change === "hardlink") fs.linkSync(selected, join(f.root, "second-link.jsonl"));
			else { fs.rmSync(selected); if (change === "symlink") fs.symlinkSync(replacement, selected); else execFileSync("mkfifo", [selected]); }
			const result = await confirm(f, p); assert.equal(result.total, 2); assert.equal(result.saved, 2); assert.equal(result.succeeded, 1);
			assert.equal(result.changed + result.failed + result.skipped, 1);
			assert.equal(sessionRecords(f, "selected-session").length, 0, "identity must be checked before header/body import");
			assert.equal(search(f, "safetyfixture").length, 1); assert.equal(search(f, "MUTANT_NEW_BODY").length, 0);
		});
	});
}

for (const parent of ["root", "nested directory", "nested symlink"] as const) {
	test(`replacing the reviewed ${parent} cannot import even an unchanged candidate inode`, { skip: process.platform === "win32" && parent === "nested symlink" }, async () => {
		await fixture(async f => {
			transcript(f, "nested/a.jsonl", [message("a", "DIRECTORY_SWAP_MUST_NOT_IMPORT")]); await enable(f);
			const p = await preview(f), selected = parent === "root" ? f.sessions : join(f.sessions, "nested"), moved = join(f.root, "moved-directory");
			fs.renameSync(selected, moved);
			if (parent === "nested symlink") fs.symlinkSync(moved, selected);
			else { fs.mkdirSync(selected); fs.renameSync(join(moved, parent === "root" ? "nested" : "a.jsonl"), join(selected, parent === "root" ? "nested" : "a.jsonl")); }
			// Safe root-wide refusal or a per-file changed report is acceptable;
			// neither is allowed to read/import through substituted parents.
			let output: string | undefined;
			try { output = await f.service.command(confirmArgs(p), f.context()); }
			catch (error) { safeError(error); }
			if (output !== undefined) { const result = json<Summary>(output); assert.equal(result.saved, 0); assert.equal(result.succeeded, 0); }
			assert.equal(fs.existsSync(f.service.store.path), false);
		});
	});
}

test("files added after preview are not automatically rescanned/imported, even under new nested directories", async () => {
	await fixture(async f => {
		transcript(f, "reviewed.jsonl", [message("old", "inventoryfixture reviewed")], { id: "reviewed" }); await enable(f);
		const p = await preview(f); transcript(f, "new-directory/new.jsonl", [message("new", "MUST_NOT_IMPORT_UNREVIEWED")], { id: "new" });
		const result = await confirm(f, p); assert.equal(result.total, 1); assert.equal(result.saved, 2);
		assert.equal(search(f, "MUST_NOT_IMPORT_UNREVIEWED").length, 0);
		assert.equal((await allResults(f, result.reportId)).length, 1);
		const next = await confirm(f, await preview(f)); assert.equal(next.total, 2); assert.equal(next.saved, 2); assert.equal(next.duplicates, 2);
	});
});

test("custom root confirmation may omit directory; explicitly different roots are rejected and relative roots refused", async () => {
	await fixture(async f => {
		const path = transcript(f, "nested/a.jsonl"); const directory = dirname(path); await enable(f);
		await assert.rejects(f.service.command("import-all relative-directory", f.context()), /absolute|directory|root/);
		const p = await preview(f, f.context(), directory); assert.equal(p.candidates, 1); assert.equal(p.root, fs.realpathSync(directory));
		await assert.rejects(f.service.command(confirmArgs(p, f.sessions), f.context()), /match|root|directory|preview/);
		assert.equal(fs.existsSync(f.service.store.path), false);
		const fresh = await preview(f, f.context(), directory); assert.equal((await confirm(f, fresh)).saved, 2);
	});
});

test("one preview replaces another, expires at ten minutes, and is consumed before concurrent confirmations can await", async t => {
	await fixture(async f => {
		transcript(f, "a.jsonl"); await enable(f);
		const old = await preview(f), newer = await preview(f); assert.notEqual(newer.previewId, old.previewId);
		await assert.rejects(f.service.command(confirmArgs(old), f.context()), /preview|expired|token/);
		const expiring = await preview(f), now = Date.now(); t.mock.method(Date, "now", () => now + 10 * 60 * 1000 + 1000);
		try { await assert.rejects(f.service.command(confirmArgs(expiring), f.context()), /preview|expired|token/); }
		finally { restore(t); }
		assert.equal(fs.existsSync(f.service.store.path), false);
		const live = await preview(f);
		const attempts = await Promise.allSettled([f.service.command(confirmArgs(live), f.context()), f.service.command(confirmArgs(live), f.context())]);
		assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
		const accepted = attempts.find(value => value.status === "fulfilled") as PromiseFulfilledResult<string>;
		assert.equal(json<Summary>(accepted.value).saved, 2);
	});
});

for (const revoke of ["cancel", "off/on", "capture off/on", "trust", "session", "cwd", "epoch"] as const) {
	test(`preview cannot survive ${revoke} revocation or move to a different owner`, async () => {
		await fixture(async f => {
			let trusted = true, owner = "bulk-owner"; const ctx = f.context(f.projectA, owner, () => trusted);
			ctx.sessionManager.getSessionId = () => owner;
			transcript(f, "a.jsonl"); await enable(f, ctx); const p = await preview(f, ctx);
			if (revoke === "cancel") await f.service.command("import-cancel", ctx);
			else if (revoke === "off/on") { await f.service.command("off", ctx); await enable(f, ctx); }
			else if (revoke === "capture off/on") { await f.service.command("capture off", ctx); await f.service.command("capture on", ctx); }
			else if (revoke === "trust") trusted = false;
			else if (revoke === "session") owner = "replacement-owner";
			else if (revoke === "cwd") ctx.cwd = f.projectB;
			else f.service.invalidate();
			await assert.rejects(f.service.command(confirmArgs(p), ctx)); assert.equal(fs.existsSync(f.service.store.path), false);
		});
	});
}

test("import-cancel works while OFF and changes neither settings nor sources", async () => {
	await fixture(async f => {
		const path = transcript(f, "a.jsonl"), original = snapshot(path);
		assert.match(await f.service.command("import-cancel", f.context()), /cancel|invalidat/i);
		assert.equal(fs.existsSync(join(f.agentDir, "extensions")), false);
		await enable(f); const p = await preview(f); await f.service.command("off", f.context());
		const config = archiveConfigPath(f.projectA, f.agentDir, "global"), before = fs.readFileSync(config);
		await f.service.command("import-cancel", f.context()); assert.deepEqual(fs.readFileSync(config), before);
		await enable(f); await assert.rejects(f.service.command(confirmArgs(p), f.context()));
		assert.deepEqual(snapshot(path), original); assert.equal(fs.existsSync(f.service.store.path), false);
	});
});

for (const revoke of ["cancel", "signal", "capture", "global off", "trust", "session", "cwd"] as const) {
	test(`active bulk ${revoke} stops the current file/remaining batch without automatic resume`, async t => {
		await fixture(async f => {
			let trusted = true, owner = "bulk-owner"; const abort = new AbortController(), ctx = { ...f.context(f.projectA, owner, () => trusted), signal: abort.signal };
			ctx.sessionManager.getSessionId = () => owner;
			transcript(f, "01-current.jsonl", [message("first", "stopfixture accepted"), message("second", "MUST_NOT_RESUME_BATCH")], { id: "current" });
			for (const id of ["02-next", "03-last"]) transcript(f, id + ".jsonl", [message("first", "stopfixture accepted"), message("later", "MUST_NOT_RESUME_BATCH")], { id });
			await enable(f, ctx); const p = await preview(f, ctx), append = f.service.store.append.bind(f.service.store); let triggered = false;
			t.mock.method(f.service.store, "append", (input: ArchiveInput) => {
				const result = append(input);
				if (!triggered && input.entry.type === "message") {
					triggered = true;
					if (revoke === "cancel") f.service.cancelImports();
					else if (revoke === "signal") abort.abort();
					else if (revoke === "capture") saveArchivePolicy(f.projectA, f.agentDir, "global", { capture: false });
					else if (revoke === "global off") saveArchivePolicy(f.projectA, f.agentDir, "global", { enabled: false });
					else if (revoke === "trust") trusted = false;
					else if (revoke === "session") owner = "replacement-owner";
					else ctx.cwd = f.projectB;
				}
				return result;
			});
			const result = await confirm(f, p, ctx); assert.equal(result.saved, 2); assert.ok(result.stopped); assert.equal(result.unprocessed, 2);
			restore(t); trusted = true; owner = "bulk-owner"; ctx.cwd = f.projectA;
			saveArchivePolicy(f.projectA, f.agentDir, "global", { enabled: true, capture: true });
			assert.equal(search(f, "stopfixture").length, 1); assert.equal(search(f, "MUST_NOT_RESUME_BATCH").length, 0);
			await assert.rejects(f.service.command(confirmArgs(p), f.context()), /preview|expired|token/);
			assert.equal(search(f, "MUST_NOT_RESUME_BATCH").length, 0);
		});
	});
}

for (const mutation of ["append", "truncate"] as const) {
	test(`source ${mutation} during a file is detected at chunks/EOF and preserves only completed entries, then continues`, async t => {
		await fixture(async f => {
			const path = transcript(f, "01-mutating.jsonl", [message("first", "mutationfixture accepted"), message("large", "MUST_NOT_IMPORT_CHANGED " + "x".repeat(256 * 1024))], { id: "mutating" });
			transcript(f, "02-after.jsonl", [message("after", "mutationfixture after")], { id: "after" }); await enable(f);
			const p = await preview(f), append = f.service.store.append.bind(f.service.store); let changed = false;
			t.mock.method(f.service.store, "append", (input: ArchiveInput) => {
				const result = append(input);
				if (!changed && input.sessionId === "mutating" && input.entry.id === "first") {
					changed = true;
					if (mutation === "append") fs.appendFileSync(path, JSON.stringify(message("injected", "MUST_NOT_IMPORT_CHANGED")) + "\n");
					else fs.truncateSync(path, 0);
				}
				return result;
			});
			const result = await confirm(f, p); restore(t);
			assert.equal(result.saved, 4); assert.equal(result.changed, 1); assert.equal(result.succeeded, 1);
			assert.equal(search(f, "MUST_NOT_IMPORT_CHANGED").length, 0); assert.equal(search(f, "mutationfixture").length, 2);
			const files = await allResults(f, result.reportId); assert.equal(files.find(item => item.path === path)!.saved, 2);
		});
	});
}

test("storage-wide failures stop remaining files and sanitize backend error details", async t => {
	await fixture(async f => {
		for (const id of ["01", "02", "03"]) transcript(f, id + ".jsonl", [message(id)], { id }); await enable(f);
		const p = await preview(f); t.mock.method(f.service.store, "append", () => { throw new Error("SQLITE_IOERR PRIVATE_NATIVE_CANARY"); });
		const result = await confirm(f, p); restore(t);
		assert.equal(result.saved, 0); assert.ok(result.stopped); assert.equal(result.unprocessed, 2);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NATIVE_CANARY|SQLITE_IOERR/);
		assert.doesNotMatch(JSON.stringify(await allResults(f, result.reportId)), /PRIVATE_NATIVE_CANARY|SQLITE_IOERR/);
	});
});

test("report is ephemeral/latest and owner-bound; human inspection permits capture/model-access OFF but not full OFF", async () => {
	await fixture(async f => {
		transcript(f, "a.jsonl"); await enable(f); const first = await confirm(f, await preview(f));
		await f.service.command("capture off", f.context()); assert.equal((await report(f, first.reportId)).total, 1);
		assert.equal(f.service.policy(f.context()).modelAccess, false);
		await assert.rejects(f.service.command(`import-report ${first.reportId}`, f.context(f.projectA, "other-session")), /report|owner|session|expired/);
		await assert.rejects(f.service.command(`import-report ${first.reportId}`, f.context(f.projectB)), /report|owner|project|expired/);
		await f.service.command("off", f.context()); await assert.rejects(f.service.command(`import-report ${first.reportId}`, f.context()), /disabled/);
		await enable(f); await f.service.command("capture on", f.context()); const second = await confirm(f, await preview(f));
		await assert.rejects(f.service.command(`import-report ${first.reportId}`, f.context()), /report|expired/);
		assert.equal((await report(f, second.reportId)).duplicates, 2);
		for (const offset of ["-1", "1.5", "NaN", "9007199254740992"]) await assert.rejects(f.service.command(`import-report ${second.reportId} ${offset}`, f.context()));
		const another = new SharedArchiveService(f.agentDir);
		try { await assert.rejects(another.command(`import-report ${second.reportId}`, f.context()), /report|expired/); }
		finally { another.close(); }
	});
});

test("bounded escaped long-path preview/report metadata discloses abbreviation and pages every ordinal without zero progress", async () => {
	await fixture(async f => {
		// Individual path components remain below NAME_MAX, complete paths below
		// PATH_MAX. Escaped '<' expands sixfold and forces the output budget.
		const components = Array.from({ length: 10 }, () => "<".repeat(170));
		for (let i = 0; i < 36; i++) transcript(f, join(...components, `${String(i).padStart(3, "0")}-${"<".repeat(100)}.jsonl`), [], { id: "long-path-" + i });
		await enable(f); const p = await preview(f); assert.equal(p.candidates, 36);
		assert.ok(p.omitted > 0 || p.samples.some(item => item.pathAbbreviated));
		assert.ok(p.samples.length > 0); assert.ok(p.samples.length < p.candidates || p.samples.some(item => item.pathAbbreviated));
		const result = await confirm(f, p); assert.equal(result.saved, 36); assert.equal(result.succeeded, 36);
		const first = await report(f, result.reportId); assert.ok(first.nextOffset !== null || first.records.some(item => item.pathAbbreviated));
		const records = await allResults(f, result.reportId); assert.equal(records.length, 36);
		assert.ok(records.some(item => item.pathAbbreviated), "long paths must disclose display abbreviation, preserving ordinal");
	});
});

test("unsafe terminal-control names are escaped in preview/report display", { skip: process.platform === "win32" }, async () => {
	await fixture(async f => {
		transcript(f, "control-\u001b[31m-\u0085-\u202e.jsonl"); await enable(f);
		const p = await preview(f); const result = await confirm(f, p);
		assert.equal((await allResults(f, result.reportId)).length, 1);
	});
});

test("depth/candidate limits refuse the entire preview instead of presenting a misleading partial all", async () => {
	for (const limit of ["depth", "candidates"] as const) await fixture(async f => {
		if (limit === "depth") {
			const path = join(f.sessions, ...Array.from({ length: 66 }, () => "d")); fs.mkdirSync(path, { recursive: true }); fs.writeFileSync(join(path, "a.jsonl"), "");
		} else for (let i = 0; i < 10_001; i++) fs.writeFileSync(join(f.sessions, i + ".jsonl"), "");
		await enable(f); await assert.rejects(f.service.command("import-all", f.context()), /limit|bound|many|depth|inventory/i);
		assert.equal(fs.existsSync(f.service.store.path), false);
		await assert.rejects(f.service.command("import-all --confirm-sensitive --preview fabricated", f.context()), /preview|token|expired/);
	});
});

test("unreadable nested directories reject preview entirely without leaking native error details", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
	await fixture(async f => {
		transcript(f, "good.jsonl"); const privateDir = join(f.sessions, "private"); fs.mkdirSync(privateDir); fs.chmodSync(privateDir, 0);
		try { await enable(f); await assert.rejects(f.service.command("import-all", f.context()), safeError); assert.equal(fs.existsSync(f.service.store.path), false); }
		finally { fs.chmodSync(privateDir, 0o700); }
	});
});

for (const revoke of ["signal", "trust", "session"] as const) {
	test(`discovery rechecks ${revoke} after asynchronous directory opens`, async t => {
		await fixture(async f => {
			let trusted = true, owner = "bulk-owner"; const abort = new AbortController(), ctx = { ...f.context(f.projectA, owner, () => trusted), signal: abort.signal };
			ctx.sessionManager.getSessionId = () => owner; transcript(f, "nested/a.jsonl"); await enable(f, ctx);
			const opendir = fsp.opendir;
			t.mock.method(fsp, "opendir", (async (...args: any[]) => {
				const result = await Reflect.apply(opendir, fsp, args);
				if (revoke === "signal") abort.abort(); else if (revoke === "trust") trusted = false; else owner = "replacement-owner";
				return result;
			}) as typeof fsp.opendir); syncBuiltinESMExports();
			try { await assert.rejects(f.service.command("import-all", ctx)); assert.equal(fs.existsSync(f.service.store.path), false); }
			finally { restore(t); }
		});
	});
}

test("opened FD identity is verified before its first body read if a candidate is replaced during open", async t => {
	await fixture(async f => {
		const selected = transcript(f, "selected.jsonl", [message("selected", "FD_REPLACEMENT_MUST_NOT_IMPORT")]);
		const replacement = join(f.root, "replacement.jsonl"); fs.copyFileSync(selected, replacement);
		await enable(f); const p = await preview(f), open = fsp.open; let intercepted = false, reads = 0;
		t.mock.method(fsp, "open", (async (...args: Parameters<typeof open>) => {
			if (String(args[0]) === selected) {
				intercepted = true; fs.renameSync(selected, join(f.root, "original.jsonl")); fs.renameSync(replacement, selected);
			}
			const handle = await Reflect.apply(open, fsp, args);
			if (String(args[0]) === selected) t.mock.method(handle, "read", (() => { reads++; assert.fail("unreviewed opened descriptor must never be read"); }) as typeof handle.read);
			return handle;
		}) as typeof open); syncBuiltinESMExports();
		try {
			const result = await confirm(f, p); assert.equal(intercepted, true); assert.equal(reads, 0);
			assert.equal(result.changed, 1); assert.equal(result.saved, 0); assert.equal(fs.existsSync(f.service.store.path), false);
		} finally { restore(t); }
	});
});

test("fstat after an awaited chunk read rejects mutation before parsing its bytes", async t => {
	await fixture(async f => {
		const path = transcript(f, "selected.jsonl", [message("selected", "CHUNK_REPLACEMENT_MUST_NOT_IMPORT")]);
		await enable(f); const p = await preview(f), open = fsp.open; let mutated = false;
		t.mock.method(fsp, "open", (async (...args: Parameters<typeof open>) => {
			const handle = await Reflect.apply(open, fsp, args);
			if (String(args[0]) === path) {
				const read = handle.read;
				t.mock.method(handle, "read", (async (...params: any[]) => {
					const result = await Reflect.apply(read, handle, params);
					if (!mutated) { mutated = true; fs.appendFileSync(path, "\n"); }
					return result;
				}) as typeof read);
			}
			return handle;
		}) as typeof open); syncBuiltinESMExports();
		try { const result = await confirm(f, p); assert.equal(mutated, true); assert.equal(result.changed, 1); assert.equal(result.saved, 0); }
		finally { restore(t); }
		assert.equal(fs.existsSync(f.service.store.path), false);
	});
});

test("bulk source changes on the final completed record are detected at EOF, not silently called successful", async t => {
	await fixture(async f => {
		const path = transcript(f, "selected.jsonl", [message("final", "eoffixture accepted")]); await enable(f);
		const p = await preview(f), append = f.service.store.append.bind(f.service.store);
		t.mock.method(f.service.store, "append", (input: ArchiveInput) => {
			const result = append(input);
			if (input.entry.id === "final") fs.appendFileSync(path, JSON.stringify(message("injected", "EOF_INJECTION_MUST_NOT_IMPORT")) + "\n");
			return result;
		});
		const result = await confirm(f, p); restore(t);
		assert.equal(result.saved, 2); assert.equal(result.changed, 1); assert.equal(result.succeeded, 0);
		assert.equal(search(f, "EOF_INJECTION_MUST_NOT_IMPORT").length, 0);
		assert.equal((await allResults(f, result.reportId))[0]!.status, "changed");
	});
});

for (const revoke of ["signal", "trust", "session"] as const) {
	test(`bulk ${revoke} is checked during chunks of an unfinished line, before any large entry completes`, async t => {
		await fixture(async f => {
			let trusted = true, owner = "bulk-owner"; const abort = new AbortController(), ctx = { ...f.context(f.projectA, owner, () => trusted), signal: abort.signal };
			ctx.sessionManager.getSessionId = () => owner;
			const path = transcript(f, "01-large.jsonl", [message("large", "UNFINISHED_MUST_NOT_IMPORT " + "x".repeat(256 * 1024))]);
			await enable(f, ctx); const p = await preview(f, ctx), open = fsp.open; let chunks = 0;
			t.mock.method(fsp, "open", (async (...args: Parameters<typeof open>) => {
				const handle = await Reflect.apply(open, fsp, args);
				if (String(args[0]) === path) {
					const read = handle.read;
					t.mock.method(handle, "read", (async (...params: any[]) => {
						const result = await Reflect.apply(read, handle, params);
						if (++chunks === 2) {
							if (revoke === "signal") abort.abort(); else if (revoke === "trust") trusted = false; else owner = "replacement-owner";
						}
						return result;
					}) as typeof read);
				}
				return handle;
			}) as typeof open); syncBuiltinESMExports();
			try { const result = await confirm(f, p, ctx); assert.equal(result.saved, 1); assert.ok(result.stopped); assert.equal(chunks, 2); }
			finally { restore(t); }
			assert.equal(search(f, "UNFINISHED_MUST_NOT_IMPORT").length, 0);
		});
	});
}

test("bulk import performs append/dedup only, never backend history search/read/session/stats scans", async t => {
	await fixture(async f => {
		transcript(f, "a.jsonl"); await enable(f);
		const calls: string[] = [];
		for (const method of ["search", "read", "session", "stats", "forgetSession", "prune"] as const) {
			t.mock.method(f.service.store, method, () => { calls.push(method); assert.fail("import must not scan backend history"); });
		}
		assert.equal((await confirm(f, await preview(f))).saved, 2);
		assert.equal((await confirm(f, await preview(f))).duplicates, 2);
		assert.deepEqual(calls, []); restore(t);
	});
});

test("a final unterminated JSONL record is accepted intact while empty files fail without blocking other files", async () => {
	await fixture(async f => {
		const path = transcript(f, "unterminated.jsonl", [message("last", "unterminatedfixture accepted")]);
		const bytes = fs.readFileSync(path); fs.writeFileSync(path, bytes.subarray(0, bytes.length - 1));
		fs.writeFileSync(join(f.sessions, "empty.jsonl"), ""); const original = snapshot(path); await enable(f);
		const result = await confirm(f, await preview(f)); assert.equal(result.saved, 2); assert.equal(result.succeeded, 1); assert.equal(result.failed, 1);
		assert.equal(search(f, "unterminatedfixture").length, 1); assert.deepEqual(snapshot(path), original);
	});
});

test("unexpected asynchronous scan errors discard the whole preview and sanitize native errors", async t => {
	await fixture(async f => {
		transcript(f, "nested/a.jsonl"); await enable(f);
		const previous = await preview(f), opendir = fsp.opendir;
		t.mock.method(fsp, "opendir", (async (...args: any[]) => {
			if (String(args[0]) === join(f.sessions, "nested")) throw new Error("PRIVATE_NATIVE_CANARY EACCES secret path");
			return Reflect.apply(opendir, fsp, args);
		}) as typeof opendir); syncBuiltinESMExports();
		try { await assert.rejects(f.service.command("import-all", f.context()), safeError); }
		finally { restore(t); }
		await assert.rejects(f.service.command(confirmArgs(previous), f.context()), /preview|expired|token/);
		assert.equal(fs.existsSync(f.service.store.path), false);
	});
});

for (const location of ["root", "completed-child"] as const) {
	test(`detectable ${location} directory mutation at scan EOF rejects the entire preview`, async t => {
		await fixture(async f => {
			transcript(f, location === "root" ? "first.jsonl" : "nested/first.jsonl"); await enable(f);
			const opendir = fsp.opendir; let changed = false;
			t.mock.method(fsp, "opendir", (async (...args: any[]) => {
				const handle = await Reflect.apply(opendir, fsp, args);
				if (String(args[0]) === f.sessions) {
					const read = handle.read.bind(handle);
					handle.read = (async () => {
						const entry = await read();
						if (!entry && !changed) {
							changed = true;
							const path = transcript(f, location === "root" ? "late.jsonl" : "nested/late.jsonl");
							fs.utimesSync(dirname(path), new Date(), new Date(Date.now() + 10_000));
						}
						return entry;
					}) as typeof handle.read;
				}
				return handle;
			}) as typeof opendir); syncBuiltinESMExports();
			try { await assert.rejects(f.service.command("import-all", f.context()), /changed|preview/i); }
			finally { restore(t); }
			assert.equal(changed, true); assert.equal(fs.existsSync(f.service.store.path), false);
		});
	});
}

test("single-file cleanup failures retain their distinct safe diagnostic and completed counts", async t => {
	await fixture(async f => {
		const source = transcript(f, "cleanup.jsonl", []); await enable(f);
		const open = fsp.open;
		t.mock.method(fsp, "open", (async (...args: any[]) => {
			const handle = await Reflect.apply(open, fsp, args);
			if (String(args[0]) === source) {
				const close = handle.close.bind(handle);
				handle.close = async () => { await close(); throw new Error("PRIVATE_NATIVE_CANARY"); };
			}
			return handle;
		}) as typeof open); syncBuiltinESMExports();
		try { await assert.rejects(f.service.command(`import --confirm-sensitive ${source}`, f.context()), error => {
			safeError(error); assert.match((error as Error).message, /^Archive source cleanup failed: 1 saved/); return true;
		}); } finally { restore(t); }
	});
});

test("descriptor cleanup failure stops a batch even after a malformed source already failed", async t => {
	await fixture(async f => {
		for (const name of ["first.jsonl", "second.jsonl"]) {
			const path = transcript(f, name, []); fs.appendFileSync(path, "PRIVATE_SOURCE_CANARY invalid JSON\n");
		}
		await enable(f); const p = await preview(f), source = p.samples[0]!.path;
		const open = fsp.open;
		t.mock.method(fsp, "open", (async (...args: any[]) => {
			const handle = await Reflect.apply(open, fsp, args);
			if (String(args[0]) === source) {
				const close = handle.close.bind(handle);
				handle.close = async () => { await close(); throw new Error("PRIVATE_NATIVE_CANARY"); };
			}
			return handle;
		}) as typeof open); syncBuiltinESMExports();
		let result: Summary;
		try { result = await confirm(f, p); } finally { restore(t); }
		assert.equal(result.stopped, true); assert.equal(result.saved, 1);
		assert.equal(result.failed, 1); assert.equal(result.unprocessed, 1);
		const entries = await allResults(f, result.reportId);
		assert.match(entries[0]!.reason!, /cleanup/i); assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_/);
	});
});

test("single-file cancellation while opening prevents any subsequent transcript body read", async t => {
	await fixture(async f => {
		const source = transcript(f, "cancel-at-open.jsonl"); await enable(f);
		const controller = new AbortController(), ctx = { ...f.context(), signal: controller.signal };
		const open = fsp.open; let reads = 0;
		t.mock.method(fsp, "open", (async (...args: any[]) => {
			const handle = await Reflect.apply(open, fsp, args);
			if (String(args[0]) === source) {
				controller.abort();
				t.mock.method(handle, "read", async () => { reads++; assert.fail("revoked source must not be read"); });
			}
			return handle;
		}) as typeof open); syncBuiltinESMExports();
		try { await assert.rejects(f.service.command(`import --confirm-sensitive ${source}`, ctx), /0 saved/); }
		finally { restore(t); }
		assert.equal(reads, 0); assert.equal(fs.existsSync(f.service.store.path), false);
	});
});

test("an empty valid inventory has a confirmable zero-file report rather than importing anything else", async () => {
	await fixture(async f => {
		await enable(f); const p = await preview(f); assert.equal(p.candidates, 0);
		const result = await confirm(f, p); assert.equal(result.total, 0); assert.equal(result.saved, 0);
		assert.deepEqual(await allResults(f, result.reportId), []); assert.equal(fs.existsSync(f.service.store.path), false);
	});
});

for (const revoke of ["cancel", "signal", "trust", "capture"] as const) {
	test(`legacy bulk final-record ${revoke} at EOF keeps its receipt and stops remaining files`, async t => {
		await fixture(async f => {
			let trusted = true;
			const abort = new AbortController(), ctx = { ...f.context(f.projectA, "bulk-owner", () => trusted), signal: abort.signal };
			const path = transcript(f, "01-final.jsonl", [message("final", "receipteoffixture")]);
			fs.writeFileSync(path, fs.readFileSync(path).subarray(0, fs.statSync(path).size - 1));
			transcript(f, "02-next.jsonl", [message("next", "RECEIPT_MUST_NOT_RESUME")]);
			const before = snapshot(path); await enable(f, ctx); const p = await preview(f, ctx);
			assert.equal(p.samples[0]!.path, path);
			const append = f.service.store.append.bind(f.service.store); let receipts = 0;
			t.mock.method(f.service.store, "append", (input: ArchiveInput) => {
				const result = append(input); receipts++;
				if (input.entry.id === "final") {
					if (revoke === "cancel") f.service.cancelImports();
					else if (revoke === "signal") abort.abort();
					else if (revoke === "trust") trusted = false;
					else saveArchivePolicy(f.projectA, f.agentDir, "global", { capture: false });
				}
				return result;
			});
			const result = await confirm(f, p, ctx);
			assert.equal(result.saved, 2); assert.ok(result.stopped); assert.equal(result.failed, 1); assert.equal(result.unprocessed, 1);
			assert.equal(receipts, 2); restore(t); trusted = true;
			const files = await allResults(f, result.reportId); assert.equal(files[0]!.saved, 2); assert.equal(files[0]!.status, "failed");
			assert.equal(search(f, "receipteoffixture").length, 1); assert.equal(search(f, "RECEIPT_MUST_NOT_RESUME").length, 0);
			assert.deepEqual(snapshot(path), before);
		});
	});
}
