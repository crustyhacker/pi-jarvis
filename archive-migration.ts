import { createHash, type Hash } from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { ArchiveDatabase, ArchiveRow, ArchiveSqlValue } from "./archive-sqlite.js";
import { ArchiveStore, ARCHIVE_STORE_LIMITS } from "./archive-store.js";

const RECORD_FIELDS = ["record_rowid", "id", "project", "session_id", "entry_id", "parent_id", "lane", "type", "role", "timestamp", "timestamp_ms", "bytes", "characters", "raw_json", "search_text", "excerpt"] as const;
const TOMBSTONE_FIELDS = ["record_rowid", "id", "deleted_at"] as const;
const TEXT_FIELDS = { id: 64, project: 4096, session_id: 512, entry_id: 512, parent_id: 512, lane: 6, type: 512, role: 512, timestamp: 128, excerpt: 481 * 4 } as const;
// Malformed archives must not materialize oversized metadata or silently replace
// invalid UTF-8 through a driver's TEXT decoder. Transfer bounded BLOBs instead.
const RECORD_METADATA = `r.rowid AS record_rowid,${Object.entries(TEXT_FIELDS).map(([field, bytes]) => `CASE WHEN r.${field} IS NULL THEN NULL WHEN length(CAST(r.${field} AS BLOB))<=${bytes} THEN CAST(r.${field} AS BLOB) ELSE 0 END AS ${field}`).join(",")},r.timestamp_ms,r.bytes,r.characters,
 EXISTS(SELECT 1 FROM tombstones t WHERE t.id=r.id) AS tombstoned,
 length(CAST(r.raw_json AS BLOB)) AS actual_bytes,length(r.raw_json) AS actual_characters,
 length(CAST(r.search_text AS BLOB)) AS index_bytes,typeof(r.raw_json) AS raw_type,typeof(r.search_text) AS index_type`;
const INSERT_RECORD = `INSERT INTO records(rowid,id,project,session_id,entry_id,parent_id,lane,type,role,timestamp,timestamp_ms,bytes,characters,raw_json,search_text,excerpt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const RAW_AGREES = `SELECT json_type(raw_json)='object'
 AND json_type(raw_json,'$.id')='text' AND json_extract(raw_json,'$.id') IS entry_id
 AND json_type(raw_json,'$.type')='text' AND json_extract(raw_json,'$.type') IS type
 AND json_type(raw_json,'$.timestamp')='text' AND json_extract(raw_json,'$.timestamp') IS timestamp
 AND json_type(raw_json,'$.parentId') IN ('text','null') AND json_extract(raw_json,'$.parentId') IS parent_id
 AND (json_type(raw_json,'$.message.role') IS NULL OR json_type(raw_json,'$.message.role')='text')
 AND json_extract(raw_json,'$.message.role') IS role AS agrees FROM records WHERE rowid=?`;
type Counts = { records: number; tombstones: number };
type CommitState = "not-attempted" | "uncertain" | "committed";

/** Error details are recovery bookkeeping, never native messages or raw data.
 * partial counts are rows staged, NOT a claim of durable partial publication. */
class ArchiveMigrationError extends Error {
	constructor(readonly partial: Counts, readonly commit: CommitState, readonly rollbackFailed: boolean, readonly closeFailed: boolean) {
		super("Archive migration failed; target was not published. Inspect the transition before recovery; do not automatically retry.");
		this.name = "ArchiveMigrationError";
	}
}
function invalid(): never { throw new Error("Invalid archive migration data"); }
function counts(db: ArchiveDatabase): Counts {
	const row = db.prepare("SELECT (SELECT count(*) FROM records) AS records,(SELECT count(*) FROM tombstones) AS tombstones").get()!;
	for (const field of ["records", "tombstones"] as const) if (!Number.isSafeInteger(row[field]) || (row[field] as number) < 0) invalid();
	return { records: row.records as number, tombstones: row.tombstones as number };
}
function equalCounts(a: Counts, b: Counts): boolean { return a.records === b.records && a.tombstones === b.tombstones; }
function integrity(db: ArchiveDatabase): void {
	// rank=1 compares the entire FTS index against its external content table.
	// Native SQL is synchronous/noninterruptible; guard checks bracket each call.
	db.prepare("INSERT INTO records_fts(records_fts,rank) VALUES('integrity-check',1)").run();
}
function integer(value: unknown): asserts value is number { if (!Number.isSafeInteger(value)) invalid(); }
function tombstone(row: ArchiveRow): void {
	row.id = body(row.id, 64, 64).text;
	integer(row.record_rowid); integer(row.deleted_at);
	if ((row.deleted_at as number) <= 0 || typeof row.id !== "string" || !/^[0-9a-f]{64}$/.test(row.id)) invalid();
}
function body(value: unknown, bytes: number, ceiling: number): { text: string; bytes: Buffer } {
	if (!(value instanceof Uint8Array) || value.byteLength !== bytes || bytes > ceiling) invalid();
	const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength), text = buffer.toString("utf8");
	// Preserve EXACT bytes, rejecting invalid UTF-8 rather than replacement chars.
	if (!Buffer.from(text, "utf8").equals(buffer)) invalid();
	return { text, bytes: buffer };
}
/** Length-prefixed typed tuples, with table domain and stable rowid ordering.
 * Never JSON.stringify bodies/tuples or concatenate all rows in memory. */
function tuple(hash: Hash, table: string, values: unknown[]): void {
	hash.update(`${table}:${values.length}:`);
	for (const value of values) {
		if (value === null) { hash.update("null:"); continue; }
		if (typeof value === "number") { integer(value); hash.update(`integer:${value}:`); continue; }
		const data = Buffer.isBuffer(value) ? value : typeof value === "string" ? Buffer.from(value, "utf8") : invalid();
		hash.update(`text:${data.length}:`); hash.update(data);
	}
}
async function pause(guard: () => void): Promise<void> { guard(); await yieldImmediate(); guard(); }

/** Visit at most one record (metadata + budget-checked raw/index) per iteration.
 * JSON validation/agreement stays in SQLite; no parse/stringify/normalization.
 * Copying FTS one row at a time rebuilds it only from stored search_text. */
async function records(store: ArchiveStore, db: ArchiveDatabase, hash: Hash, guard: () => void, target?: ArchiveDatabase, progress?: Counts): Promise<number> {
	let cursor: number | undefined, count = 0;
	for (;;) {
		guard();
		const row = db.prepare(`SELECT ${RECORD_METADATA} FROM records r${cursor === undefined ? "" : " WHERE r.rowid>?"} ORDER BY r.rowid LIMIT 1`).get(...(cursor === undefined ? [] : [cursor]));
		if (!row) return count;
		for (const [field, ceiling] of Object.entries(TEXT_FIELDS)) {
			if (row[field] === null && (field === "parent_id" || field === "role")) continue;
			if (!(row[field] instanceof Uint8Array)) invalid();
			row[field] = body(row[field], (row[field] as Uint8Array).byteLength, ceiling).text;
		}
		store.migrationValidateRecord(row);
		const rowid = row.record_rowid as number;
		if (cursor !== undefined && rowid <= cursor) invalid();
		// Check actual budgets BEFORE retrieving bodies or invoking JSON functions.
		if (db.prepare("SELECT json_valid(raw_json) AS valid FROM records WHERE rowid=?").get(rowid)?.valid !== 1 ||
			db.prepare(RAW_AGREES).get(rowid)?.agrees !== 1) invalid();
		{
			const payload = db.prepare("SELECT CAST(raw_json AS BLOB) AS raw_json,CAST(search_text AS BLOB) AS search_text FROM records WHERE rowid=?").get(rowid)!;
			const raw = body(payload.raw_json, row.bytes as number, ARCHIVE_STORE_LIMITS.entryBytes);
			const index = body(payload.search_text, row.index_bytes as number, ARCHIVE_STORE_LIMITS.indexBytes);
			// No body is retained across the yield below.
			const values = RECORD_FIELDS.map(field => field === "raw_json" ? raw.text : field === "search_text" ? index.text : row[field]) as ArchiveSqlValue[];
			if (target) {
				if (Number(target.prepare(INSERT_RECORD).run(...values).changes) !== 1) invalid();
				target.prepare("INSERT INTO records_fts(rowid,search_text) VALUES(?,?)").run(rowid, index.text);
			}
			tuple(hash, "records", RECORD_FIELDS.map(field => field === "raw_json" ? raw.bytes : field === "search_text" ? index.bytes : row[field]));
		}
		count++; if (progress) progress.records = count;
		cursor = rowid;
		await pause(guard); guard();
	}
}
async function tombstones(db: ArchiveDatabase, hash: Hash, guard: () => void, target?: ArchiveDatabase, progress?: Counts): Promise<number> {
	let cursor: number | undefined, count = 0;
	for (;;) {
		guard();
		const row = db.prepare(`SELECT rowid AS record_rowid,CAST(CASE WHEN length(CAST(id AS BLOB))=64 THEN id END AS BLOB) AS id,deleted_at FROM tombstones${cursor === undefined ? "" : " WHERE rowid>?"} ORDER BY rowid LIMIT 1`).get(...(cursor === undefined ? [] : [cursor]));
		if (!row) return count;
		tombstone(row);
		const rowid = row.record_rowid as number;
		if (cursor !== undefined && rowid <= cursor) invalid();
		if (target && Number(target.prepare("INSERT INTO tombstones(rowid,id,deleted_at) VALUES(?,?,?)").run(rowid, row.id as string, row.deleted_at as number).changes) !== 1) invalid();
		tuple(hash, "tombstones", TOMBSTONE_FIELDS.map(field => row[field]));
		count++; if (progress) progress.tombstones = count;
		cursor = rowid;
		await pause(guard); guard();
	}
}

/** Caller holds the filesystem operation lock, marks a recoverable transition,
 * stops older Pi instances and closes all other source/target connections.
 * BEGIN IMMEDIATE is a stable copy boundary, NOT online legacy-writer exclusion.
 * Success means a verified, closed, fsynced target; caller publishes metadata.
 * Source is retained with original record content. Never replay uncertain commit. */
export async function copyArchiveStore(source: ArchiveStore, target: ArchiveStore, guard: () => void): Promise<Counts> {
	let sourceTransaction = false, targetTransaction = false, commit: CommitState = "not-attempted";
	let rollbackFailed = false, closeFailed = false, failed = false, sourceCloseAttempted = false, targetCloseAttempted = false;
	const partial: Counts = { records: 0, tombstones: 0 };
	try {
		if (!(source instanceof ArchiveStore) || !(target instanceof ArchiveStore) || typeof guard !== "function" || source === target) invalid();
		guard();
		// Canonical-path preflight occurs before opening a second SQLite handle.
		if (source.migrationLocation(guard) === target.migrationLocation(guard)) invalid();
		const from = source.migrationDatabase(false, guard);
		let expected: Counts = { records: 0, tombstones: 0 };
		if (from) {
			sourceTransaction = true; from.exec("BEGIN IMMEDIATE");
			source.migrationValidateSchema(from);
			expected = counts(from);
		}
		const to = target.migrationDatabase(true, guard)!;
		targetTransaction = true; to.exec("BEGIN IMMEDIATE");
		target.migrationValidateSchema(to);
		if (!equalCounts(counts(to), { records: 0, tombstones: 0 })) invalid();
		integrity(to);
		await pause(guard); guard();
		const original = createHash("sha256"), copied = createHash("sha256");
		if (from) {
			await records(source, from, original, guard, to, partial); guard();
			await tombstones(from, original, guard, to, partial); guard();
			if (!equalCounts(counts(from), expected)) invalid();
			// Validate bounded bodies before the noninterruptible FTS scan.
			integrity(from);
		}
		if (!equalCounts(expected, partial) || !equalCounts(counts(to), expected)) invalid();
		const verified = { records: await records(target, to, copied, guard), tombstones: 0 }; guard();
		verified.tombstones = await tombstones(to, copied, guard); guard();
		if (!equalCounts(verified, expected) || original.digest("hex") !== copied.digest("hex")) invalid();
		integrity(to);
		source.migrationLocation(guard); target.migrationLocation(guard);
		guard();
		commit = "uncertain";
		to.exec("COMMIT"); // Exactly ONE attempt; a thrown result is uncertain.
		commit = "committed"; targetTransaction = false;
		if (sourceTransaction) {
			sourceTransaction = false; // No replay of a failed rollback.
			try { source.migrationRollback(guard); } catch { rollbackFailed = true; throw new Error("Migration rollback failed"); }
		}
		sourceCloseAttempted = true;
		try { source.close(); } catch { closeFailed = true; throw new Error("Migration close failed"); }
		const checkpoint = to.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
		if (!checkpoint || checkpoint.busy !== 0 || checkpoint.log !== 0 || checkpoint.checkpointed !== 0) invalid();
		targetCloseAttempted = true;
		try { target.close(); } catch { closeFailed = true; throw new Error("Migration close failed"); }
		target.migrationSync(guard);
		guard();
	} catch (error) {
		failed = true;
		// A factory can fail before Store.db is assigned, after unsuccessfully
		// closing its native handle. Preserve that safe uncertainty signal.
		if (error && (typeof error === "object" || typeof error === "function")) {
			try { closeFailed ||= Object.getOwnPropertyDescriptor(error, "closeFailed")?.value === true; }
			catch { closeFailed = true; }
		}
	}
	finally {
		if (sourceTransaction) { try { source.migrationRollback(guard); } catch { rollbackFailed = true; } }
		if (targetTransaction) { try { target.migrationRollback(guard); } catch { rollbackFailed = true; } }
		// Closing is mandatory cleanup even after cancellation. No retry of close,
		// commit, copy or publication if the backend reports an uncertain result.
		if (!sourceCloseAttempted) { try { source.close(); } catch { closeFailed = true; } }
		if (!targetCloseAttempted) { try { target.close(); } catch { closeFailed = true; } }
	}
	if (failed || rollbackFailed || closeFailed) throw new ArchiveMigrationError({ ...partial }, commit, rollbackFailed, closeFailed);
	return { ...partial };
}
