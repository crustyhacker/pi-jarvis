import { createHash } from "node:crypto";
import {
	chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
	opendirSync, realpathSync, type Stats,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { ArchiveInput, ArchivePage, ArchiveRead, ArchiveSearch, ArchiveSummary } from "./archive-types.js";

// Importing/constructing the OFF store must not load SQLite (or its warning).
const require = createRequire(import.meta.url);
/** Raw JSON and the complete text index each have a 64 MiB UTF-8 ceiling.
 * Normalization also has a 64K UTF-16 context ceiling: overlong combining
 * sequences are rejected, never split, modified with joiners, or truncated. */
export const ARCHIVE_STORE_LIMITS = Object.freeze({ entryBytes: 64 * 1024 * 1024, indexBytes: 64 * 1024 * 1024, normalizationCharacters: 64 * 1024, queryCharacters: 512, queryTerms: 16, page: 50, read: 12_000, excerpt: 480 });
const VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const AUXILIARIES = ["archive.sqlite", "archive.sqlite-wal", "archive.sqlite-shm", "archive.sqlite-journal"];
const SCHEMA = [
	`CREATE TABLE records (
		id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),
		project TEXT NOT NULL CHECK(length(CAST(project AS BLOB)) BETWEEN 1 AND 4096),
		session_id TEXT NOT NULL CHECK(length(CAST(session_id AS BLOB)) BETWEEN 1 AND 512),
		entry_id TEXT NOT NULL CHECK(length(CAST(entry_id AS BLOB)) BETWEEN 1 AND 512),
		parent_id TEXT CHECK(length(CAST(parent_id AS BLOB)) BETWEEN 1 AND 512),
		lane TEXT NOT NULL CHECK(lane IN ('main','jarvis','import')),
		type TEXT NOT NULL CHECK(length(CAST(type AS BLOB)) BETWEEN 1 AND 512),
		role TEXT CHECK(length(CAST(role AS BLOB)) BETWEEN 1 AND 512),
		timestamp TEXT NOT NULL CHECK(length(timestamp) BETWEEN 1 AND 128),
		timestamp_ms INTEGER NOT NULL,
		bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 67108864),
		characters INTEGER NOT NULL CHECK(characters BETWEEN 1 AND bytes),
		raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
		search_text TEXT NOT NULL,
		excerpt TEXT NOT NULL CHECK(length(excerpt)<=481)
	) STRICT`,
	`CREATE TABLE tombstones (
		id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),
		deleted_at INTEGER NOT NULL CHECK(deleted_at>0)
	) STRICT`,
	`CREATE INDEX records_project ON records(project, timestamp_ms DESC, id)`,
	`CREATE INDEX records_session ON records(session_id, project, timestamp_ms, id)`,
	`CREATE INDEX records_timestamp ON records(timestamp_ms, id)`,
	`CREATE VIRTUAL TABLE records_fts USING fts5(search_text, content='records', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`,
];
const SHADOW_SCHEMA = [
	"CREATE TABLE 'records_fts_data'(id INTEGER PRIMARY KEY, block BLOB)",
	"CREATE TABLE 'records_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
	"CREATE TABLE 'records_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)",
	"CREATE TABLE 'records_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID",
];
const SCHEMA_LIMIT = SCHEMA.length + SHADOW_SCHEMA.length + 1;
const COLUMNS = "r.id,r.project,r.session_id,r.entry_id,r.parent_id,r.lane,r.type,r.role,r.timestamp,r.timestamp_ms,r.bytes,r.excerpt,EXISTS(SELECT 1 FROM tombstones t WHERE t.id=r.id) AS tombstoned";
function failure(message: string): never { throw new Error(`Invalid archive ${message}`); }
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\0]+/gu, " ").trim();
const schemaSql = (sql: string) => sql.replace(/\s+/g, " ").trim();

function string(value: unknown, name: string, bytes: number, nonempty = true): asserts value is string {
	if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > bytes ||
		Buffer.from(value).toString("utf8") !== value || (nonempty && !value.trim())) failure(name);
}
function project(value: unknown): asserts value is string {
	string(value, "project", 4096);
	// Canonical cwd is supplied by the service; never dereference record paths.
	if (!isAbsolute(value) || resolve(value) !== value) failure("project");
}
function validId(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) failure("ID");
}
function timestamp(value: unknown): number {
	string(value, "timestamp", 128);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) failure("timestamp");
	const milliseconds = Date.parse(value);
	if (!Number.isSafeInteger(milliseconds)) failure("timestamp");
	// Date.parse normalizes impossible dates, e.g. February 30; reject them.
	const day = Number(value.slice(8, 10));
	const month = Number(value.slice(5, 7));
	const year = Number(value.slice(0, 4));
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	if (month < 1 || month > 12 || day < 1 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || Number(value.slice(11, 13)) > 23) failure("timestamp");
	return milliseconds;
}
function identity(project: string, sessionId: string, entryId: string): string {
	return createHash("sha256").update(JSON.stringify([project, sessionId, entryId])).digest("hex");
}
function flags(currentProject: string, all: boolean): void {
	project(currentProject);
	if (typeof all !== "boolean") failure("all-projects flag");
}
function offset(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) failure("offset");
	return value;
}
function limit(value: number, maximum: number): number {
	if (!Number.isSafeInteger(value)) failure("limit");
	return Math.max(1, Math.min(maximum, value));
}
function role(entry: ArchiveInput["entry"]): string | undefined {
	const message = entry.message;
	if (message && typeof message === "object" && !Array.isArray(message)) {
		const value = (message as Record<string, unknown>).role;
		if (value !== undefined) { string(value, "role", 512); return value; }
	}
	return undefined;
}
function validateInput(input: ArchiveInput): void {
	if (!input || typeof input !== "object") failure("input");
	project(input.project);
	string(input.sessionId, "session ID", 512);
	if (!["main", "jarvis", "import"].includes(input.lane)) failure("lane");
	const entry = input.entry;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) failure("session entry");
	string(entry.id, "entry ID", 512);
	string(entry.type, "entry type", 512);
	if (entry.parentId !== null) string(entry.parentId, "parent ID", 512);
	timestamp(entry.timestamp);
	role(entry);
}

/** JSON-only data, with undefined object fields allowed because Pi uses them.
 * Never silently discard functions, non-finite numbers, or custom serializers.
 * Shared references are fine; JSON.stringify explicitly rejects actual cycles. */
function serialize(entry: ArchiveInput["entry"]): string {
	const seen = new WeakSet<object>();
	const pending: unknown[] = [entry];
	while (pending.length) {
		const value = pending.pop();
		if (value === null || typeof value === "string" || typeof value === "boolean") continue;
		if (typeof value === "number") { if (!Number.isFinite(value)) failure("JSON number"); continue; }
		if (!value || typeof value !== "object") failure("JSON value");
		if (seen.has(value)) continue;
		seen.add(value);
		const array = Array.isArray(value);
		if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) failure("JSON object");
		if (array) {
			for (const item of value) pending.push(item);
		} else {
			for (const item of Object.values(value)) if (item !== undefined) pending.push(item);
		}
	}
	let raw: string;
	try { raw = JSON.stringify(entry); } catch { return failure("JSON serialization"); }
	if (Buffer.byteLength(raw) > ARCHIVE_STORE_LIMITS.entryBytes) throw new Error("Archive entry exceeds 64 MiB UTF-8; not saved or truncated");
	return raw;
}

type IndexLimits = { bytes: number; normalizationCharacters: number };
function indexTooLarge(): never {
	throw new Error("Archive search index exceeds 64 MiB UTF-8 normalization/index budget; entry not saved or truncated");
}
function normalizeIndex(value: string, budget: number, segmentCharacters: number): string {
	const pieces: string[] = [];
	let carry = "", normalizedBytes = 0, lowercaseBytes = 0;
	const check = (tail: string) => {
		if (normalizedBytes + Buffer.byteLength(tail) > budget || lowercaseBytes + Buffer.byteLength(tail.toLowerCase()) > budget) indexTooLarge();
	};
	const emit = (piece: string) => {
		normalizedBytes += Buffer.byteLength(piece);
		// Default lowercase's only contextual mapping is final sigma; both
		// forms have equal byte length. Count bounded chunks, but lowercase
		// the budget-checked whole field below to preserve that context.
		lowercaseBytes += Buffer.byteLength(piece.toLowerCase());
		if (normalizedBytes > budget || lowercaseBytes > budget) indexTooLarge();
		if (piece) pieces.push(piece);
	};
	// Leave space for compatibility expansion (U+FDFA expands to 18 chars)
	// and the previous normalization context. All native normalizer inputs
	// are bounded; the actual expanded context is checked too.
	const chunkCharacters = Math.max(2, Math.floor(segmentCharacters / 32));
	for (let start = 0; start < value.length;) {
		let end = Math.min(value.length, start + chunkCharacters);
		if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
		const chunk = value.slice(start, end).normalize("NFKC");
		if (carry.length + chunk.length > segmentCharacters) throw new Error("Archive search normalization context exceeds 64K UTF-16 budget; entry not saved or truncated");
		// NFKC(NFKC(a)+NFKC(b)) = NFKC(a+b). Retain the last starter
		// and ALL following marks, not a guessed raw-string boundary. Every
		// nonzero-CCC character is a Mark; retaining CCC=0 marks as well is
		// conservative. Future composition/reordering cannot cross this
		// retained starter. This also keeps Hangul and compatibility Jamo
		// composition intact when chunks split their components.
		const combined = (carry + chunk).normalize("NFKC");
		const tail = /[^\p{M}]\p{M}*$/u.exec(combined);
		const cut = tail?.index ?? 0;
		emit(combined.slice(0, cut));
		carry = combined.slice(cut);
		check(carry);
		start = end;
	}
	emit(carry);
	// Both intermediate forms are budgeted before joining; whitespace/NUL
	// folding can only shrink them. This conservative pre-fold budget also
	// rejects excessive whitespace instead of allocating an oversized index.
	const text = pieces.join("").toLowerCase().replace(/[\s\0]+/gu, " ").trim();
	if (Buffer.byteLength(text) > budget) indexTooLarge();
	return text;
}

/** Index textual scalar fields, including arbitrary custom/tool details. Image
 * bytes and opaque provider signatures remain untouched in raw_json, not FTS.
 * Excerpts intentionally use the same NFKC/lowercase/whitespace-folded text. */
function searchable(input: ArchiveInput, limits: IndexLimits): string {
	const pieces: string[] = [];
	let bytes = 0;
	const add = (value: string) => {
		const separator = pieces.length ? 1 : 0;
		const remaining = limits.bytes - bytes - separator;
		if (remaining < 0) indexTooLarge();
		const text = normalizeIndex(value, remaining, limits.normalizationCharacters);
		bytes += separator + Buffer.byteLength(text);
		pieces.push(text);
	};
	const pending: unknown[] = [input.entry];
	while (pending.length) {
		const value = pending.pop();
		if (typeof value === "string") {
			if (!/^data:[^,]*;base64,/i.test(value)) add(value);
		} else if (Array.isArray(value)) {
			for (let i = value.length - 1; i >= 0; i--) pending.push(value[i]);
		} else if (value && typeof value === "object") {
			const object = value as Record<string, unknown>;
			const image = object.type === "image" || (typeof object.mimeType === "string" && object.mimeType.startsWith("image/"));
			const entries = Object.entries(object);
			for (let i = entries.length - 1; i >= 0; i--) {
				const [key, child] = entries[i];
				if (/signature$/i.test(key) || /^(?:base64|imageData)$/i.test(key) || (image && key === "data")) continue;
				pending.push(child);
			}
		}
	}
	for (const value of [input.project, input.sessionId, input.lane]) add(value);
	return pieces.join("\n");
}
function matchQuery(query: string): string | undefined {
	string(query, "search query", ARCHIVE_STORE_LIMITS.queryCharacters * 4, false);
	if ([...query].length > ARCHIVE_STORE_LIMITS.queryCharacters) failure("search query length");
	// Quotes group literal phrases. Neither operators, wildcards, punctuation,
	// nor unmatched quotes can become FTS/SQL grammar. Like memory, keywords OR.
	const terms = [...query.matchAll(/"([^"]*)"|([^\s"]+)/gu)].map(match => normalized(match[1] ?? match[2])).filter(Boolean);
	if (terms.reduce((n, term) => n + term.split(" ").length, 0) > ARCHIVE_STORE_LIMITS.queryTerms) failure("search query terms");
	return terms.length ? [...new Set(terms)].map(term => `"${term.replace(/"/g, '""')}"`).join(" OR ") : undefined;
}
function summary(row: Record<string, unknown>): ArchiveSummary {
	const value: ArchiveSummary = {
		id: row.id as string, project: row.project as string, sessionId: row.session_id as string,
		entryId: row.entry_id as string, parentId: row.parent_id as string | null,
		lane: row.lane as ArchiveSummary["lane"], type: row.type as string,
		timestamp: row.timestamp as string, bytes: row.bytes as number, excerpt: row.excerpt as string,
	};
	if (row.tombstoned !== 0) failure("tombstoned record");
	validId(value.id); project(value.project); string(value.sessionId, "session ID", 512);
	string(value.entryId, "entry ID", 512); string(value.type, "entry type", 512);
	if (value.parentId !== null) string(value.parentId, "parent ID", 512);
	if (!["main", "jarvis", "import"].includes(value.lane)) failure("lane");
	if (timestamp(value.timestamp) !== row.timestamp_ms || identity(value.project, value.sessionId, value.entryId) !== value.id) failure("record identity");
	if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > ARCHIVE_STORE_LIMITS.entryBytes) failure("record bytes");
	string(value.excerpt, "excerpt", 481 * 4, false);
	if ([...value.excerpt].length > 481) failure("excerpt");
	if (row.role !== null) { string(row.role, "role", 512); value.role = row.role; }
	return value;
}
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function stat(path: string): Stats | undefined {
	try { return lstatSync(path); } catch (error) { if (absent(error)) return undefined; throw error; }
}
function owner(info: Stats): void {
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) failure("storage owner");
}
function regular(info: Stats): void {
	if (!info.isFile() || info.nlink !== 1) failure("storage file");
	owner(info);
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sqliteLocked(error: unknown): boolean {
	const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
	return code === "ERR_SQLITE_ERROR" && typeof errcode === "number" && Number.isInteger(errcode) && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6);
}
function initializeWal(db: DatabaseSync): void {
	// The DELETE -> WAL upgrade can bypass native busy_timeout on Node 22.
	// Retry only this idempotent startup pragma, never writes/uncertain commits.
	const timeout = Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);
	const deadline = performance.now() + BUSY_TIMEOUT_MS;
	const sleep = new Int32Array(new SharedArrayBuffer(4));
	try {
		db.exec("PRAGMA busy_timeout=0");
		let statement: StatementSync | undefined;
		for (;;) {
			try {
				statement ??= db.prepare("PRAGMA journal_mode=WAL");
				if (statement.get()?.journal_mode !== "wal") failure("journal mode");
				return;
			} catch (error) {
				if (!sqliteLocked(error)) throw error;
				const remaining = deadline - performance.now();
				if (remaining <= 0) throw error;
				Atomics.wait(sleep, 0, 0, Math.min(20, remaining));
				if (performance.now() >= deadline) throw error;
			}
		}
	} finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
}

/** Local optional storage; policy/trust/cancellation are the service's gates.
 * Deletion is logical, not forensic erasure. Public SQLite opens by path: these
 * checks are not a sandbox against malicious concurrent same-user renames. */
export class ArchiveStore {
	readonly path: string;
	private readonly agentDir: string;
	private db?: DatabaseSync;
	private file?: Stats;
	private root?: string;
	private canonicalPath?: string;
	private readonly directories = new Map<string, Stats>();
	private readonly statements = new Map<string, StatementSync>();
	// Instance-local private limits allow tiny budget fixtures; no public or
	// service-controlled override of the production ceilings.
	private readonly indexLimits: IndexLimits = { bytes: ARCHIVE_STORE_LIMITS.indexBytes, normalizationCharacters: ARCHIVE_STORE_LIMITS.normalizationCharacters };

	constructor(agentDir: string) {
		string(agentDir, "agent directory", 4096);
		this.agentDir = resolve(agentDir);
		this.path = join(this.agentDir, "extensions", "pi-jarvis-archive", "archive.sqlite");
	}
	private get databasePath(): string { return this.canonicalPath ?? this.path; }

	private checkDirectories(create: boolean): boolean {
		// Resolve the user-selected root lazily; trusted root/ancestor aliases are
		// supported, while the owned subtree must never contain links.
		let root: string;
		try { root = realpathSync(this.agentDir); } catch (error) {
			if (!absent(error)) throw error;
			if (this.root) failure("replaced agent root");
			if (!create) return false;
			mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
			root = realpathSync(this.agentDir);
		}
		if (this.root && root !== this.root) failure("replaced agent root");
		this.root = root;
		this.canonicalPath = join(root, "extensions", "pi-jarvis-archive", "archive.sqlite");
		for (const directory of [root, join(root, "extensions"), dirname(this.databasePath)]) {
			let info = stat(directory);
			const previous = this.directories.get(directory);
			if (previous && (!info || !same(previous, info))) failure(directory === root ? "replaced agent root" : "replaced storage directory");
			if (!info && create) {
				try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
				info = stat(directory);
			}
			if (!info) return false;
			if (!info.isDirectory() || info.isSymbolicLink()) failure("storage directory");
			owner(info);
			this.directories.set(directory, info);
		}
		const handle = opendirSync(dirname(this.databasePath));
		try {
			for (let entry = handle.readSync(); entry; entry = handle.readSync()) if (!AUXILIARIES.includes(entry.name)) failure("storage entry");
		} finally { handle.closeSync(); }
		return true;
	}
	private checkFiles(): void {
		const database = stat(this.databasePath);
		if (this.file && (!database || !same(this.file, database))) failure(database ? "replaced database" : "missing database");
		for (const name of AUXILIARIES) {
			const info = name === "archive.sqlite" ? database : stat(join(dirname(this.databasePath), name));
			if (!info) continue;
			if (!database) failure("orphaned SQLite auxiliary file");
			regular(info);
		}
	}
	private privateFile(path: string): Stats | undefined {
		const info = stat(path);
		if (!info) { if (path !== this.databasePath) return undefined; return failure("missing database"); }
		regular(info);
		if (path === this.databasePath && this.file && !same(this.file, info)) failure("replaced database");
		// NEVER open/close another descriptor on a live SQLite database or shm:
		// POSIX closes release that process's fcntl locks, including SQLite's.
		// chmod is path-based and does not disturb locks. As with SQLite's own
		// public path open, identity checks cannot sandbox a hostile rename race.
		try { if ((info.mode & 0o777) !== 0o600) chmodSync(path, 0o600); }
		catch (error) { if (path !== this.databasePath && absent(error)) return undefined; throw error; }
		const after = stat(path);
		if (!after && path !== this.databasePath) return undefined;
		if (!after || !same(info, after)) failure("replaced storage file");
		regular(after);
		return after;
	}
	private tightenFiles(): void {
		for (const name of AUXILIARIES) {
			const path = join(dirname(this.databasePath), name);
			if (stat(path)) this.privateFile(path);
		}
	}
	private prepare(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db!.prepare(sql);
			// Fixed SQL shapes only; user inputs are always bound values.
			if (this.statements.size < 128) this.statements.set(sql, statement);
		}
		return statement;
	}
	private open(create: boolean): DatabaseSync {
		if (this.db) {
			try {
				if (!this.checkDirectories(false)) failure("missing storage directory");
				this.checkFiles();
				if (this.prepare("PRAGMA user_version").get()?.user_version !== VERSION) failure("database version");
				return this.db;
			} catch (error) { this.close(); throw error; }
		}
		if (!this.checkDirectories(create)) failure("missing storage directory");
		this.checkFiles();
		const directoryFd = openSync(dirname(this.databasePath), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
		try { fchmodSync(directoryFd, 0o700); } finally { closeSync(directoryFd); }
		// SQLite exposes no public fd constructor. Create safely before its
		// path open, and pin the inode even across close/failures.
		if (create) {
			let fd: number | undefined;
			try { fd = openSync(this.databasePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			if (fd !== undefined) {
				try { this.file = fstatSync(fd); regular(this.file); } finally { closeSync(fd); }
			}
		}
		this.file = this.privateFile(this.databasePath)!;
		this.tightenFiles();
		try {
			const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
			this.db = new DatabaseSync(this.databasePath, { enableDoubleQuotedStringLiterals: false, allowExtension: false });
			const db = this.db;
			db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY`);
			db.exec("BEGIN IMMEDIATE");
			try {
				const version = db.prepare("PRAGMA user_version").get()?.user_version;
				const schema = db.prepare(`SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT ${SCHEMA_LIMIT}`).all();
				if (create && version === 0 && schema.length === 0) {
					for (const sql of SCHEMA) db.exec(sql);
					db.exec(`PRAGMA user_version=${VERSION}`);
				} else if (version !== VERSION) failure("database version");
				this.validateSchema();
				db.exec("COMMIT");
			} catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
			initializeWal(db);
			db.exec("PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=16777216");
			this.checkFiles();
			this.tightenFiles();
			return db;
		} catch (error) { this.close(); throw error; }
	}
	private existing(): DatabaseSync | undefined {
		if (this.db) return this.open(false);
		if (!this.checkDirectories(false)) return undefined;
		this.checkFiles();
		return stat(this.databasePath) ? this.open(false) : undefined;
	}
	private validateSchema(): void {
		const schema = this.db!.prepare(`SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT ${SCHEMA_LIMIT}`).all().map(row => schemaSql(String(row.sql))).sort();
		if (JSON.stringify(schema) !== JSON.stringify([...SCHEMA, ...SHADOW_SCHEMA].map(schemaSql).sort())) failure("database schema");
		// Unlike bounded memory, this archive is unbounded. Never quick_check,
		// iterate/JSON-parse every record, or FTS integrity-scan all bodies on
		// open. Strict constraints validate writes, summaries/pages validate
		// accessed rows, and SQLite errors propagate without reset or repair.
	}
	private write<T>(action: () => T): T {
		const db = this.open(true);
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = action();
			db.exec("COMMIT");
			this.checkFiles();
			return result;
		} catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
	}

	append(input: ArchiveInput): "saved" | "duplicate" | "deleted" {
		validateInput(input);
		const raw = serialize(input.entry);
		const id = identity(input.project, input.sessionId, input.entry.id);
		return this.write(() => {
			if (this.prepare("SELECT 1 FROM tombstones WHERE id=?").get(id)) return "deleted";
			// Compare in the existing write transaction; never return the old
			// (potentially 64 MiB) raw payload into JS. Lane is provenance, not
			// identity: an identical import is still a duplicate.
			const existing = this.prepare("SELECT raw_json=? AS identical FROM records WHERE id=?").get(raw, id);
			if (existing) {
				if (existing.identical === 1) return "duplicate";
				throw new Error("Archive entry identity has a conflicting serialized payload; not saved or replaced");
			}
			const text = searchable(input, this.indexLimits);
			const inserted = this.prepare(`INSERT INTO records(id,project,session_id,entry_id,parent_id,lane,type,role,timestamp,timestamp_ms,bytes,characters,raw_json,search_text,excerpt)
				VALUES(?,?,?,?,?,?,?,?,?,?,?,length(?),?,?,substr(?,1,480)||CASE WHEN length(?)>480 THEN '…' ELSE '' END)`)
				.run(id, input.project, input.sessionId, input.entry.id, input.entry.parentId, input.lane, input.entry.type, role(input.entry) ?? null,
					input.entry.timestamp, timestamp(input.entry.timestamp), Buffer.byteLength(raw), raw, raw, text, text, text);
			this.prepare("INSERT INTO records_fts(rowid,search_text) VALUES(?,?)").run(inserted.lastInsertRowid, text);
			return "saved";
		});
	}

	search(query: ArchiveSearch): ArchivePage {
		if (!query || typeof query !== "object") failure("query");
		project(query.project);
		const scope = query.scope === undefined ? "current" : query.scope;
		if (scope !== "current" && scope !== "all") failure("search scope");
		const start = offset(query.offset === undefined ? 0 : query.offset);
		const size = limit(query.limit === undefined ? 20 : query.limit, ARCHIVE_STORE_LIMITS.page);
		const match = matchQuery(query.query === undefined ? "" : query.query);
		if (query.sessionId !== undefined) string(query.sessionId, "session ID", 512);
		const where: string[] = [];
		const args: SQLInputValue[] = [];
		if (match) { where.push("records_fts MATCH ?"); args.push(match); }
		if (scope === "current") { where.push("r.project=?"); args.push(query.project); }
		if (query.sessionId !== undefined) { where.push("r.session_id=?"); args.push(query.sessionId); }
		if (!this.existing()) return { records: [], nextOffset: null };
		const from = match ? "records_fts CROSS JOIN records r ON r.rowid=records_fts.rowid" : "records r";
		const rank = match ? "bm25(records_fts)" : "0";
		// Rank only metadata first. Neither this query nor summary decoding ever
		// selects raw_json/search_text into JS, even for multi-megabyte entries.
		const rows = this.prepare(`WITH matched AS MATERIALIZED (
			SELECT r.rowid AS record_rowid,r.id,r.timestamp_ms,${rank} AS search_rank FROM ${from}
			${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			ORDER BY search_rank,r.timestamp_ms DESC,r.id ASC LIMIT ? OFFSET ?
		) SELECT ${COLUMNS} FROM matched m JOIN records r ON r.rowid=m.record_rowid
		ORDER BY m.search_rank,m.timestamp_ms DESC,m.id ASC`).all(...args, size + 1, start);
		return { records: rows.slice(0, size).map(summary), nextOffset: rows.length > size ? start + size : null };
	}

	read(id: string, currentProject: string, all = false, start = 0, size = 12_000): ArchiveRead | undefined {
		validId(id); flags(currentProject, all); offset(start); size = limit(size, ARCHIVE_STORE_LIMITS.read);
		if (!this.existing()) return undefined;
		const row = this.prepare(`SELECT ${COLUMNS},characters,substr(raw_json,min(?,characters)+1,?) AS content,
			CAST(substr(raw_json,min(?,characters)+1,?) AS BLOB) AS content_bytes FROM records r WHERE r.id=?${all ? "" : " AND r.project=?"}`)
			.get(start, size, start, size, id, ...(all ? [] : [currentProject]));
		if (!row) return undefined;
		const record = summary(row);
		const total = Number(row.characters);
		if (!Number.isSafeInteger(total) || total < 1 || total > record.bytes) failure("record characters");
		const content = row.content;
		string(content, "read content", size * 4, false);
		if ([...content].length !== Math.max(0, Math.min(size, total - start)) ||
			!Buffer.from(content).equals(row.content_bytes as Uint8Array)) failure("read content encoding/length");
		// When one bounded page is a complete small record, also validate JSON
		// and raw/summary agreement. Large records are NEVER fully materialized
		// or parsed for page reads; their JSON was validated on append.
		if (start === 0 && total <= size) {
			let entry: ArchiveInput["entry"];
			try { entry = JSON.parse(content) as ArchiveInput["entry"]; } catch { return failure("raw record JSON"); }
			validateInput({ project: record.project, sessionId: record.sessionId, lane: record.lane, entry });
			if (entry.id !== record.entryId || entry.parentId !== record.parentId || entry.type !== record.type ||
				entry.timestamp !== record.timestamp || role(entry) !== record.role || Buffer.byteLength(content) !== record.bytes || JSON.stringify(entry) !== content) failure("raw record data");
		}
		return { record, content, offset: start,
			nextOffset: start + size < total ? start + size : null, totalCharacters: total, units: "unicode-codepoints" };
	}

	session(sessionId: string, currentProject: string, all = false, start = 0, size = 20): ArchivePage {
		string(sessionId, "session ID", 512); flags(currentProject, all); offset(start); size = limit(size, ARCHIVE_STORE_LIMITS.page);
		if (!this.existing()) return { records: [], nextOffset: null };
		const rows = this.prepare(`SELECT ${COLUMNS} FROM records r WHERE r.session_id=?${all ? "" : " AND r.project=?"}
			ORDER BY r.timestamp_ms ASC,r.id ASC LIMIT ? OFFSET ?`).all(sessionId, ...(all ? [] : [currentProject]), size + 1, start);
		return { records: rows.slice(0, size).map(summary), nextOffset: rows.length > size ? start + size : null };
	}

	stats(currentProject: string, all = false): { records: number; bytes: number } {
		flags(currentProject, all);
		if (!this.existing()) return { records: 0, bytes: 0 };
		const row = this.prepare(`SELECT count(*) AS records,coalesce(sum(bytes),0) AS bytes FROM records${all ? "" : " WHERE project=?"}`).get(...(all ? [] : [currentProject]))!;
		const records = Number(row.records), bytes = Number(row.bytes);
		if (!Number.isSafeInteger(records) || records < 0 || !Number.isSafeInteger(bytes) || bytes < records || bytes > records * ARCHIVE_STORE_LIMITS.entryBytes) failure("statistics");
		return { records, bytes };
	}
	private remove(filter: string, args: SQLInputValue[]): number {
		return this.write(() => {
			this.prepare(`INSERT INTO tombstones(id,deleted_at) SELECT id,? FROM records WHERE ${filter} ON CONFLICT(id) DO NOTHING`).run(Date.now(), ...args);
			// Bulk FTS deletion remains in SQLite, never loads whole text into JS.
			this.prepare(`INSERT INTO records_fts(records_fts,rowid,search_text) SELECT 'delete',rowid,search_text FROM records WHERE ${filter}`).run(...args);
			return Number(this.prepare(`DELETE FROM records WHERE ${filter}`).run(...args).changes);
		});
	}
	/** Human-only deletion APIs; the service must not expose these as model tools. */
	forgetSession(sessionId: string, currentProject: string, all = false): number {
		string(sessionId, "session ID", 512); flags(currentProject, all);
		if (!this.existing()) return 0;
		return this.remove(`session_id=?${all ? "" : " AND project=?"}`, [sessionId, ...(all ? [] : [currentProject])]);
	}
	prune(before: string, currentProject: string, all = false): number {
		const milliseconds = timestamp(before); flags(currentProject, all);
		if (!this.existing()) return 0;
		return this.remove(`timestamp_ms<?${all ? "" : " AND project=?"}`, [milliseconds, ...(all ? [] : [currentProject])]);
	}
	close(): void {
		const db = this.db;
		this.db = undefined;
		this.statements.clear();
		// Keep observed path/inode pins: even an explicit close is not consent to
		// silently read a replacement database or retargeted root.
		db?.close();
	}
}
