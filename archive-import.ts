import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ArchiveInput } from "./archive-types.js";

export const ARCHIVE_IMPORT_LIMITS = Object.freeze({ candidates: 10_000, entries: 50_000, depth: 64, manifestBytes: 8 * 1024 * 1024, previewMs: 10 * 60 * 1000 });
const LINE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);

type DirectoryIdentity = { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint };
type FileIdentity = DirectoryIdentity & { size: bigint };
export interface ImportDirectory { path: string; identity: DirectoryIdentity; parent?: ImportDirectory }
export interface ImportCandidate { index: number; path: string; identity: FileIdentity; parent: ImportDirectory }
export interface ImportInventory { root: string; candidates: ImportCandidate[]; skipped: number }

/** Reasons are fixed, human-safe strings, never native/parser input snippets. */
export class ArchiveImportFailure extends Error {
	constructor(readonly reason: string, readonly stop = false, readonly changed = false) { super(reason); }
}
const changedSource = () => new ArchiveImportFailure("Source or reviewed directory changed; replacement was not imported.", false, true);
function directoryIdentity(stat: BigIntStats): DirectoryIdentity { return { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }; }
function fileIdentity(stat: BigIntStats): FileIdentity { return { ...directoryIdentity(stat), size: stat.size }; }
function sameDirectory(stat: BigIntStats, identity: DirectoryIdentity): boolean {
	return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
}
function sameFile(stat: BigIntStats, identity: FileIdentity): boolean {
	return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.dev === identity.dev && stat.ino === identity.ino &&
		stat.size === identity.size && stat.mtimeNs === identity.mtimeNs && stat.ctimeNs === identity.ctimeNs;
}

/** Node has no portable openat directory sandbox. Pin/check every reviewed
 * ancestor and the opened FD instead; concurrent rename checks are best effort. */
async function verifyDirectories(directory: ImportDirectory, check: () => void, scanning = false): Promise<void> {
	const chain: ImportDirectory[] = [];
	for (let item: ImportDirectory | undefined = directory; item; item = item.parent) chain.push(item);
	for (const item of chain.reverse()) {
		check();
		let stat: BigIntStats;
		try { stat = await lstat(item.path, { bigint: true }); }
		catch { check(); throw changedSource(); }
		check();
		if (!sameDirectory(stat, item.identity) || (scanning && (stat.mtimeNs !== item.identity.mtimeNs || stat.ctimeNs !== item.identity.ctimeNs))) throw changedSource();
	}
}

/** Metadata-only, sequential discovery. Any incomplete scan rejects the entire
 * preview; no partial inventory is advertised as 'all'. Nested links are never
 * intentionally followed. The selected root alias is resolved exactly once. */
export async function discoverArchiveImports(path: string, check: () => void): Promise<ImportInventory> {
	if (!isAbsolute(path)) throw new ArchiveImportFailure("Bulk import requires an absolute directory.");
	check();
	try {
		const root = await realpath(path); check();
		const stat = await lstat(root, { bigint: true }); check();
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArchiveImportFailure("Bulk import root must be a readable directory.");
		let manifestBytes = 0, visited = 0, skipped = 0;
		const candidates: ImportCandidate[] = [];
		const directories: ImportDirectory[] = [];
		const budget = (path: string, overhead: number) => {
			manifestBytes += Buffer.byteLength(path) + overhead;
			if (manifestBytes > ARCHIVE_IMPORT_LIMITS.manifestBytes) throw new ArchiveImportFailure("Bulk preview exceeds the 8 MiB inventory limit; choose a smaller root.");
		};
		const makeDirectory = (path: string, stat: BigIntStats, parent?: ImportDirectory): ImportDirectory => {
			budget(path, 256);
			const directory = { path, identity: directoryIdentity(stat), parent };
			directories.push(directory);
			return directory;
		};
		const walk = async (directory: ImportDirectory, depth: number): Promise<void> => {
			if (depth > ARCHIVE_IMPORT_LIMITS.depth) throw new ArchiveImportFailure("Bulk preview exceeds the directory depth limit (64); choose a smaller root.");
			await verifyDirectories(directory, check, true); check();
			const handle = await opendir(directory.path);
			try {
				check();
				await verifyDirectories(directory, check, true); check();
				for (;;) {
					const entry = await handle.read(); check();
					if (!entry) break;
					if (++visited > ARCHIVE_IMPORT_LIMITS.entries) throw new ArchiveImportFailure("Bulk preview exceeds the 50,000 visited-entry limit; choose a smaller root.");
					await verifyDirectories(directory, check, true); check();
					const path = join(directory.path, entry.name);
					const info = await lstat(path, { bigint: true }); check();
					// The cursor's type and lstat must agree if a race changed it.
					if (entry.isSymbolicLink() !== info.isSymbolicLink() || entry.isDirectory() !== info.isDirectory() || entry.isFile() !== info.isFile()) throw changedSource();
					if (info.isSymbolicLink()) { skipped++; continue; }
					if (info.isDirectory()) { await walk(makeDirectory(path, info, directory), depth + 1); check(); continue; }
					if (!info.isFile() || info.nlink !== 1n) { skipped++; continue; }
					if (!entry.name.endsWith(".jsonl")) continue;
					if (candidates.length >= ARCHIVE_IMPORT_LIMITS.candidates) throw new ArchiveImportFailure("Bulk preview exceeds the 10,000 candidate limit; choose a smaller root.");
					budget(path, 512);
					candidates.push({ index: candidates.length, path, identity: fileIdentity(info), parent: directory });
				}
				await verifyDirectories(directory, check, true); check();
			} finally { await handle.close(); }
			check();
		};
		await walk(makeDirectory(root, stat), 0); check();
		// A previously visited child can mutate while later siblings are scanned.
		// Recheck all directory stamps before publishing a complete preview. These
		// stamps are NOT required at confirmation: new files after preview remain
		// outside the exact reviewed set, without invalidating unchanged candidates.
		for (const directory of directories) { await verifyDirectories(directory, check, true); check(); }
		return { root, candidates, skipped };
	} catch (error) {
		check();
		if (error instanceof ArchiveImportFailure) throw error;
		throw new ArchiveImportFailure("Bulk preview failed: root/directories are unreadable or changed. No partial preview was retained.");
	}
}

export interface ImportCounts { saved: number; duplicates: number; deleted: number }
export interface TranscriptImportResult extends ImportCounts {
	complete: boolean;
	line: number;
	project?: string;
	sessionId?: string;
	reason?: string;
	stop?: boolean;
	changed?: boolean;
	cleanupFailed?: boolean;
}
export type ImportAppendOutcome = "saved" | "duplicate" | "deleted";
interface TranscriptImportOptions {
	check: () => void;
	/** Synchronous receipt only after Store.append returns, before outer vault
	 * post-action guards/lock release. A later throw stops but keeps this count. */
	append: (input: ArchiveInput, acknowledge: (outcome: ImportAppendOutcome) => void) => void;
	project: (path: string) => string;
	headerEntry: (header: { timestamp?: unknown }) => ArchiveInput["entry"];
	candidate?: ImportCandidate;
}
// Only known entry-validation/conflict/size errors may continue to another file.
// Unknown backend failures (including SQLite/path ownership errors) stop a batch.
function appendFailure(error: unknown, acknowledged: boolean): ArchiveImportFailure {
	// Once acknowledged, any later failure is an outer guard/cleanup failure,
	// not an entry rejection that could permit the batch to continue.
	const message = !acknowledged && error instanceof Error ? error.message : "";
	if (/^Invalid archive (?:input|project|session ID|lane|session entry|entry ID|entry type|parent ID|timestamp|role|JSON number|JSON value|JSON object|JSON serialization)$/.test(message) ||
		message === "Archive entry identity has a conflicting serialized payload; not saved or replaced" ||
		/^Archive (?:entry exceeds 64 MiB UTF-8|search index exceeds 64 MiB UTF-8 normalization\/index budget|search normalization context exceeds 64K UTF-16 budget); (?:not saved or truncated|entry not saved or truncated)$/.test(message)) {
		return new ArchiveImportFailure("Invalid, conflicting or oversized archive entry; completed entries remain.");
	}
	return new ArchiveImportFailure("Archive storage is unavailable or failed; remaining files were not attempted.", true);
}

/** Shared streaming v3 importer. Bulk reads are frozen at the reviewed size and
 * verify nanosecond metadata before/after each bounded FD read and at EOF.
 * Single-file callers retain their established counts/text and streaming gates. */
export async function importArchiveTranscript(path: string, options: TranscriptImportOptions): Promise<TranscriptImportResult> {
	const { check, candidate } = options;
	const counts: ImportCounts = { saved: 0, duplicates: 0, deleted: 0 };
	let line = 0, header: { id: string; cwd: string } | undefined;
	let file: Awaited<ReturnType<typeof open>> | undefined;
	let failure: ArchiveImportFailure | undefined, cleanupFailed = false;
	try {
		if (candidate) {
			check(); await verifyDirectories(candidate.parent, check); check();
			let stat: BigIntStats;
			try { stat = await lstat(path, { bigint: true }); } catch { check(); throw changedSource(); }
			check();
			if (!sameFile(stat, candidate.identity)) throw changedSource();
		}
		check();
		file = await open(path, READ_FLAGS);
		check();
		const stat = await file.stat({ bigint: true });
		check();
		if (!stat.isFile() || stat.nlink !== 1n) throw candidate ? changedSource() : new ArchiveImportFailure("Import source must be a regular single-link file.");
		if (candidate && (!sameFile(stat, candidate.identity) || candidate.identity.size > BigInt(Number.MAX_SAFE_INTEGER))) throw changedSource();
		let pending: Buffer[] = [], size = 0, position = 0;
		const frozenSize = candidate ? Number(candidate.identity.size) : undefined;
		const verify = async () => {
			if (!candidate) return;
			check();
			const current = await file!.stat({ bigint: true }); check();
			if (!sameFile(current, candidate.identity)) throw changedSource();
			await verifyDirectories(candidate.parent, check); check();
		};
		const save = (entry: ArchiveInput["entry"]) => {
			let accepting = true, acknowledged = false;
			try {
				options.append({ project: header!.cwd, sessionId: header!.id, lane: "import", entry }, outcome => {
					if (!accepting || acknowledged || !["saved", "duplicate", "deleted"].includes(outcome)) throw new Error("Invalid synchronous archive append receipt.");
					acknowledged = true;
					if (outcome === "saved") counts.saved++; else if (outcome === "duplicate") counts.duplicates++; else counts.deleted++;
				});
				if (!acknowledged) throw new Error("Archive append receipt missing.");
			} catch (error) { throw appendFailure(error, acknowledged); }
			finally { accepting = false; }
			// Also stop on legacy/capture/import-owner revocation after an ack,
			// including the last record with no following newline or append.
			check();
		};
		const consume = (bytes: Buffer) => {
			line++;
			if (!bytes.length) return;
			check();
			let parsed: any;
			try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
			catch { throw new ArchiveImportFailure("Invalid UTF-8/JSON transcript line (input content omitted)."); }
			if (!header) {
				if (parsed?.type !== "session" || parsed.version !== 3 || typeof parsed.id !== "string" || !parsed.id.length || parsed.id.length > 512 || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd)) throw new ArchiveImportFailure("A v3 Pi session header with session ID and absolute cwd is required.");
				let entry: ArchiveInput["entry"];
				try { header = { id: parsed.id, cwd: options.project(parsed.cwd) }; entry = options.headerEntry(parsed); }
				catch { throw new ArchiveImportFailure("Invalid session header provenance or timestamp."); }
				save(entry);
			} else save(parsed);
		};
		for (;;) {
			if (candidate) await verify();
			if (frozenSize !== undefined && position >= frozenSize) break;
			const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, frozenSize === undefined ? CHUNK_BYTES : frozenSize - position));
			check();
			const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
			check();
			if (candidate) await verify();
			if (!bytesRead) {
				if (frozenSize !== undefined && position !== frozenSize) throw changedSource();
				break;
			}
			position += bytesRead;
			const chunk = buffer.subarray(0, bytesRead);
			let start = 0;
			for (let index = 0; index < chunk.length; index++) {
				if (chunk[index] !== 10) continue;
				const fragment = chunk.subarray(start, index); size += fragment.length;
				if (size > LINE_BYTES) throw new ArchiveImportFailure("Transcript line exceeds the explicit 64 MiB safety ceiling; nothing was truncated.");
				pending.push(fragment); consume(Buffer.concat(pending, size)); pending = []; size = 0; start = index + 1;
			}
			if (start < chunk.length) { const fragment = chunk.subarray(start); size += fragment.length; pending.push(fragment); }
			if (size > LINE_BYTES) throw new ArchiveImportFailure("Transcript line exceeds the explicit 64 MiB safety ceiling; nothing was truncated.");
		}
		check();
		if (size) consume(Buffer.concat(pending, size));
		if (!header) throw new ArchiveImportFailure("No session header found.");
		if (candidate) await verify();
		check();
	} catch (error) {
		failure = error instanceof ArchiveImportFailure ? error : new ArchiveImportFailure("Source could not be opened/read or import failed (input content omitted).");
	} finally {
		try { await file?.close(); }
		catch { cleanupFailed = true; failure = new ArchiveImportFailure("Source descriptor cleanup failed; source was not modified.", true); }
	}
	// A last-record policy/session change or cancellation during close must still
	// stop a bulk batch, even when all that file's entries already committed.
	if (candidate || !failure) {
		try { check(); } catch (error) {
			failure = error instanceof ArchiveImportFailure ? error : new ArchiveImportFailure("Archive import permission/session expired.", true);
		}
	}
	return { ...counts, complete: !failure, line, project: header?.cwd, sessionId: header?.id,
		...(failure ? { reason: failure.reason, stop: failure.stop, changed: failure.changed } : {}), ...(cleanupFailed ? { cleanupFailed: true } : {}) };
}
