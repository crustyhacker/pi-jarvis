import { createHash } from "node:crypto";
import {
	closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
	opendirSync, realpathSync, type Stats,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { MemoryInput, MemoryQuery, MemoryRecord, MemorySaveResult } from "./memory-types.js";

// Importing/constructing a disabled store must not even load SQLite. Node 22/24 may
// emit its experimental warning on the first actual access, not at extension load.
const require = createRequire(import.meta.url);
export const MEMORY_STORE_LIMITS = Object.freeze({ conversations: 10_000, notes: 1_000, tombstones: 100_000, identities: 100_000 });
const VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const WAL_RETRY_INTERVAL_MS = 20;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_TITLE_CHARS = 160;
const AUXILIARIES = ["memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm", "memory.sqlite-journal"];
const SCHEMA = [
	`CREATE TABLE records (
		id TEXT PRIMARY KEY CHECK(length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
		kind TEXT NOT NULL CHECK(kind IN ('note', 'conversation')),
		category TEXT NOT NULL CHECK(category IN ('user', 'feedback', 'project', 'reference')),
		scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
		project TEXT NOT NULL CHECK(length(CAST(project AS BLOB)) BETWEEN 1 AND 4096),
		lane TEXT NOT NULL CHECK(lane IN ('main', 'jarvis', 'manual')),
		session_id TEXT NOT NULL CHECK(length(CAST(session_id AS BLOB)) BETWEEN 1 AND 512),
		event_id TEXT NOT NULL CHECK(length(CAST(event_id AS BLOB)) BETWEEN 1 AND 512),
		role TEXT CHECK(role IN ('user', 'assistant')),
		created_at INTEGER NOT NULL CHECK(created_at > 0 AND created_at <= 9007199254740991),
		updated_at INTEGER NOT NULL CHECK(updated_at >= created_at AND updated_at <= 9007199254740991),
		title TEXT NOT NULL CHECK(length(title) <= 160),
		text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 16384),
		search_title TEXT NOT NULL CHECK(length(CAST(search_title AS BLOB)) <= 16384),
		search_text TEXT NOT NULL CHECK(length(CAST(search_text AS BLOB)) <= 1179648)
	) STRICT`,
	`CREATE TABLE tombstones (
		id TEXT PRIMARY KEY CHECK(length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
		deleted_at INTEGER NOT NULL CHECK(deleted_at > 0 AND deleted_at <= 9007199254740991)
	) STRICT`,
	`CREATE INDEX records_scope ON records(scope, project, kind, updated_at DESC, id)`,
	`CREATE INDEX records_recency ON records(kind, updated_at DESC, id)`,
	`CREATE VIRTUAL TABLE records_fts USING fts5(search_title, search_text, content='records', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`,
];
// FTS5 creates these private-to-SQLite shadow tables. Validate the exact schema,
// too, rather than accepting arbitrary tables under the index's name prefix.
const SHADOW_SCHEMA = [
	"CREATE TABLE 'records_fts_data'(id INTEGER PRIMARY KEY, block BLOB)",
	"CREATE TABLE 'records_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
	"CREATE TABLE 'records_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)",
	"CREATE TABLE 'records_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID",
];
const SCHEMA_LIMIT = SCHEMA.length + SHADOW_SCHEMA.length + 1;
const schemaSql = (sql: string) => sql.replace(/\s+/g, " ").trim();
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const failure = (message: string): never => { throw new Error(`Invalid memory ${message}`); };

function string(value: unknown, name: string, bytes: number, nonempty = true): asserts value is string {
	if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > bytes ||
		Buffer.from(value, "utf8").toString("utf8") !== value || (nonempty && !value.trim())) failure(name);
}
function project(value: unknown): asserts value is string {
	string(value, "project", 4096);
	// The caller supplies canonical cwd. Do not traverse paths supplied in records.
	if (!isAbsolute(value) || resolve(value) !== value) failure("project");
}
function title(value: unknown, kind: unknown): asserts value is string {
	string(value, "title", MAX_TITLE_CHARS * 4, kind === "note");
	if ([...value].length > MAX_TITLE_CHARS || (kind === "note" && !normalize(value))) failure("title");
}
function validateInput(input: MemoryInput): void {
	if (!input || typeof input !== "object") failure("input");
	if (input.kind !== "note" && input.kind !== "conversation") failure("kind");
	if (!["user", "feedback", "project", "reference"].includes(input.category)) failure("category");
	if (input.scope !== "global" && input.scope !== "project") failure("scope");
	project(input.project);
	title(input.title, input.kind);
	string(input.text, "text", MAX_TEXT_BYTES);
	if (!input.source || typeof input.source !== "object" || !["main", "jarvis", "manual"].includes(input.source.lane)) failure("source");
	string(input.source.sessionId, "session ID", 512);
	string(input.source.eventId, "event ID", 512);
	if (input.source.role !== undefined && input.source.role !== "user" && input.source.role !== "assistant") failure("role");
}
function identity(input: MemoryInput): string {
	const parts = input.kind === "note"
		? ["note", input.scope, input.scope === "project" ? input.project : "", normalize(input.title)]
		: ["conversation", input.project, input.source.lane, input.source.sessionId, input.source.eventId];
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function validId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) failure("ID");
}
function timestamp(value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) failure("timestamp");
}
function decode(row: Record<string, unknown>): MemoryRecord {
	const record: MemoryRecord = {
		id: row.id as string, kind: row.kind as MemoryRecord["kind"], category: row.category as MemoryRecord["category"],
		scope: row.scope as MemoryRecord["scope"], project: row.project as string,
		title: row.title as string, text: row.text as string,
		source: { lane: row.lane as MemoryRecord["source"]["lane"], sessionId: row.session_id as string, eventId: row.event_id as string },
		createdAt: row.created_at as number, updatedAt: row.updated_at as number,
	};
	if (row.role !== null) record.source.role = row.role as MemoryRecord["source"]["role"];
	validateInput(record);
	validId(record.id);
	timestamp(record.createdAt);
	timestamp(record.updatedAt);
	if (record.updatedAt < record.createdAt || identity(record) !== record.id) failure("record identity");
	return record;
}
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function stat(path: string): Stats | undefined {
	try { return lstatSync(path); } catch (error) { if (absent(error)) return undefined; throw error; }
}
function owner(stats: Stats): void {
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) failure("storage owner");
}
function regular(stats: Stats): void {
	if (!stats.isFile() || stats.nlink !== 1) failure("storage file");
	owner(stats);
}

function sqliteLocked(error: unknown): boolean {
	const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
	// Node exposes SQLite's numeric (possibly extended) result code. Never infer
	// retryability from error text or retry other I/O/schema/corruption failures.
	return code === "ERR_SQLITE_ERROR" && typeof errcode === "number" && Number.isInteger(errcode) &&
		((errcode & 0xff) === 5 || (errcode & 0xff) === 6); // SQLITE_BUSY / SQLITE_LOCKED
}

function initializeWal(db: DatabaseSync): void {
	// DELETE -> WAL can return SQLITE_BUSY immediately despite busy_timeout,
	// especially on Node 22 when another opener acquires its validation lock.
	// Retry ONLY this idempotent pragma, after schema validation has committed.
	// Disable native waits so each attempt cannot restart a full timeout budget.
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
				Atomics.wait(sleep, 0, 0, Math.min(WAL_RETRY_INTERVAL_MS, remaining));
				if (performance.now() >= deadline) throw error;
			}
		}
	} finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
}

/** Local-only persistence. Policy/trust checks belong to the caller. Deletion is
 * logical, not forensic erasure. Path checks mitigate accidents, not concurrent
 * malicious same-user OS races. SQLite coordinates cooperating processes. */
export class MemoryStore {
	readonly path: string;
	private readonly agentDir: string;
	private db?: DatabaseSync;
	private file?: Stats;
	private root?: string;
	private canonicalPath?: string;
	private readonly statements = new Map<string, StatementSync>();

	constructor(agentDir: string) {
		string(agentDir, "agent directory", 4096);
		this.agentDir = resolve(agentDir);
		this.path = join(this.agentDir, "extensions", "pi-jarvis-memory", "memory.sqlite");
	}

	private get databasePath(): string { return this.canonicalPath ?? this.path; }

	private checkDirectories(create: boolean): boolean {
		// The agent root is a trusted user-selected location: Pi supports symlinked
		// agent directories, and /tmp itself is an alias on macOS. Resolve it only
		// on access; then enforce NO links in the extension-owned subtree.
		let root: string;
		try { root = realpathSync(this.agentDir); } catch (error) {
			if (!absent(error)) throw error;
			if (this.root) failure("replaced agent root");
			if (!create) return false;
			mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
			root = realpathSync(this.agentDir);
		}
		if (this.root && root !== this.root) failure("replaced agent root");
		const rootInfo = stat(root);
		if (!rootInfo?.isDirectory()) failure("agent directory");
		owner(rootInfo!);
		this.root = root;
		this.canonicalPath = join(root, "extensions", "pi-jarvis-memory", "memory.sqlite");
		for (const directory of [join(root, "extensions"), dirname(this.databasePath)]) {
			let info = stat(directory);
			if (!info && create) {
				try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
				info = stat(directory);
			}
			if (!info) { if (!create) return false; return failure("storage directory"); }
			if (!info.isDirectory() || info.isSymbolicLink()) failure("storage directory");
			owner(info);
		}
		// Refuse unexpected entries, without an unbounded readdir.
		const handle = opendirSync(dirname(this.databasePath));
		try {
			for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
				if (!AUXILIARIES.includes(entry.name)) failure("storage entry");
			}
		} finally { handle.closeSync(); }
		return true;
	}

	private checkFiles(): void {
		for (const name of AUXILIARIES) {
			const path = join(dirname(this.databasePath), name);
			const info = stat(path);
			if (!info) continue;
			if (path !== this.databasePath && !stat(this.databasePath)) failure("orphaned SQLite auxiliary file");
			regular(info);
			if (path === this.databasePath) {
				if (info.size > MAX_DATABASE_BYTES) failure("database size");
				if (this.file && (info.dev !== this.file.dev || info.ino !== this.file.ino)) failure("replaced database");
			}
		}
		if (this.file && !stat(this.databasePath)) failure("missing database");
	}

	private prepare(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db!.prepare(sql);
			// Cache only a fixed, bounded set of SQL shapes, never query/user values.
			if (this.statements.size < 128) this.statements.set(sql, statement);
		}
		return statement;
	}

	private open(): DatabaseSync {
		if (this.db) {
			try {
				if (!this.checkDirectories(false)) failure("missing storage directory");
				this.checkFiles();
				if (this.prepare("PRAGMA user_version").get()?.user_version !== VERSION) failure("database version");
				return this.db;
			} catch (error) { this.close(); throw error; }
		}
		this.checkDirectories(true);
		this.checkFiles();
		const directoryFd = openSync(dirname(this.databasePath), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
		try { fchmodSync(directoryFd, 0o700); } finally { closeSync(directoryFd); }
		// Open with NOFOLLOW before SQLite's path-based open. SQLite has no public
		// fd constructor; a hostile same-user rename race is not sandboxed here.
		let fd: number;
		try {
			fd = openSync(this.databasePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			fd = openSync(this.databasePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
		}
		try {
			this.file = fstatSync(fd);
			regular(this.file);
			if (this.file.size > MAX_DATABASE_BYTES) failure("database size");
			fchmodSync(fd, 0o600);
		} finally { closeSync(fd); }
		try {
			const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
			this.db = new DatabaseSync(this.databasePath, { enableDoubleQuotedStringLiterals: false, allowExtension: false });
			const db = this.db;
			db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY`);
			db.exec("BEGIN IMMEDIATE");
			try {
				const version = db.prepare("PRAGMA user_version").get()?.user_version;
				const schema = db.prepare(`SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT ${SCHEMA_LIMIT}`).all();
				if (version === 0 && schema.length === 0) {
					for (const sql of SCHEMA) db.exec(sql);
					db.exec(`PRAGMA user_version=${VERSION}`);
				} else if (version !== VERSION) failure("database version");
				this.validateDatabase();
				db.exec("COMMIT");
			} catch (error) { db.exec("ROLLBACK"); throw error; }
			initializeWal(db);
			const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
			db.exec(`PRAGMA max_page_count=${Math.floor(MAX_DATABASE_BYTES / pageSize)}; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=16777216`);
			this.checkFiles();
			return db;
		} catch (error) { this.close(); throw error; }
	}

	private existing(): DatabaseSync | undefined {
		if (this.db) return this.open();
		if (!this.checkDirectories(false)) return undefined;
		this.checkFiles();
		return stat(this.databasePath) ? this.open() : undefined;
	}

	private count(table: "records" | "tombstones", kind?: "note" | "conversation"): number {
		const row = kind
			? this.prepare("SELECT count(*) AS count FROM records WHERE kind=?").get(kind)
			: this.prepare(`SELECT count(*) AS count FROM ${table}`).get();
		return Number(row!.count);
	}

	private validateDatabase(): void {
		const schema = this.db!.prepare(`SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT ${SCHEMA_LIMIT}`).all().map(row => schemaSql(String(row.sql))).sort();
		if (JSON.stringify(schema) !== JSON.stringify([...SCHEMA, ...SHADOW_SCHEMA].map(schemaSql).sort())) failure("database schema");
		const records = this.count("records");
		const tombstones = this.count("tombstones");
		if (records + tombstones > MEMORY_STORE_LIMITS.identities) failure("identity budget");
		if (records > MEMORY_STORE_LIMITS.notes + MEMORY_STORE_LIMITS.conversations ||
			this.count("records", "note") > MEMORY_STORE_LIMITS.notes ||
			this.count("records", "conversation") > MEMORY_STORE_LIMITS.conversations ||
			tombstones > MEMORY_STORE_LIMITS.tombstones) failure("database retention");
		const check = this.db!.prepare("PRAGMA quick_check(1)").get();
		if (!check || Object.values(check)[0] !== "ok") failure("database integrity");
		// Iterate, never materialize a full database in JS. Cardinality is capped above.
		for (const row of this.db!.prepare(`SELECT *, CAST(project AS BLOB) AS project_bytes,
			CAST(title AS BLOB) AS title_bytes, CAST(text AS BLOB) AS text_bytes,
			CAST(session_id AS BLOB) AS session_id_bytes, CAST(event_id AS BLOB) AS event_id_bytes FROM records`).iterate()) {
			decode(row);
			if (row.search_title !== normalize(String(row.title)) || row.search_text !== normalize(String(row.text))) failure("search index content");
			for (const key of ["project", "title", "text", "session_id", "event_id"]) {
				if (!Buffer.from(String(row[key]), "utf8").equals(row[`${key}_bytes`] as Uint8Array)) failure("database encoding");
			}
		}
		for (const row of this.db!.prepare("SELECT * FROM tombstones").iterate()) {
			validId(row.id);
			timestamp(row.deleted_at);
		}
		if (this.db!.prepare("SELECT 1 FROM records JOIN tombstones USING(id) LIMIT 1").get()) failure("tombstoned record");
		// FTS5 rank=1 checks the index against its external content, not just the
		// index's internal structure. Never silently rebuild a corrupt index.
		this.db!.exec("INSERT INTO records_fts(records_fts, rank) VALUES('integrity-check', 1)");
	}

	private write<T>(action: () => T): T {
		const db = this.open();
		db.exec("BEGIN IMMEDIATE");
		try { const result = action(); db.exec("COMMIT"); return result; }
		catch (error) { db.exec("ROLLBACK"); throw error; }
	}

	private row(id: string): MemoryRecord | undefined {
		const row = this.prepare("SELECT * FROM records WHERE id=?").get(id);
		return row ? decode(row) : undefined;
	}

	private insertIndex(rowid: SQLInputValue, title: string, text: string): void {
		this.prepare("INSERT INTO records_fts(rowid, search_title, search_text) VALUES(?,?,?)").run(rowid, normalize(title), normalize(text));
	}

	private deleteIndex(rowid: SQLInputValue, title: string, text: string): void {
		this.prepare("INSERT INTO records_fts(records_fts,rowid,search_title,search_text) VALUES('delete',?,?,?)").run(rowid, title, text);
	}

	private deleteRecords(filter: string, args: SQLInputValue[]): number {
		for (const row of this.prepare(`SELECT rowid, search_title, search_text FROM records WHERE ${filter}`).iterate(...args)) {
			this.deleteIndex(row.rowid, String(row.search_title), String(row.search_text));
		}
		return Number(this.prepare(`DELETE FROM records WHERE ${filter}`).run(...args).changes);
	}

	private reserveIdentity(): void {
		// Every live record reserves one future tombstone. Only new identities
		// consume capacity; deleting a live record merely transfers its slot.
		if (this.count("records") + this.count("tombstones") >= MEMORY_STORE_LIMITS.identities) {
			throw new Error("Memory identity budget exhausted; new saves are paused, forgetting remains available");
		}
	}

	private addTombstone(id: string): void {
		if (this.prepare("SELECT 1 FROM tombstones WHERE id=?").get(id)) return;
		if (this.count("tombstones") >= MEMORY_STORE_LIMITS.tombstones) throw new Error("Memory tombstone limit reached");
		this.prepare("INSERT INTO tombstones(id, deleted_at) VALUES(?, ?)").run(id, Date.now());
	}

	save(input: MemoryInput, options?: { explicit?: boolean }): MemorySaveResult {
		validateInput(input);
		if (options !== undefined && (!options || typeof options !== "object" || (options.explicit !== undefined && typeof options.explicit !== "boolean"))) failure("save options");
		const id = identity(input);
		return this.write(() => {
			if (this.prepare("SELECT 1 FROM tombstones WHERE id=?").get(id)) {
				if (!options?.explicit) return { outcome: "forgotten" };
				this.prepare("DELETE FROM tombstones WHERE id=?").run(id);
			}
			const existing = this.row(id);
			if (existing) {
				const sameProvenance = existing.category === input.category && existing.project === input.project &&
					existing.source.lane === input.source.lane && existing.source.sessionId === input.source.sessionId &&
					existing.source.eventId === input.source.eventId && existing.source.role === input.source.role;
				if (input.kind === "conversation" || (existing.text === input.text && existing.title === input.title && sameProvenance)) return { record: existing, outcome: "duplicate" };
				const updated = this.replace(existing, input.text, input.title, input);
				return { record: updated, outcome: "updated" };
			}
			if (input.kind === "note" && this.count("records", "note") >= MEMORY_STORE_LIMITS.notes) throw new Error("Memory note limit reached");
			if (input.kind === "conversation") {
				// Make room BEFORE insertion, in the same transaction, so even a
				// backwards wall clock cannot silently prune the newly saved message.
				// Curated notes and tombstones never expire.
				this.deleteRecords(`id IN (SELECT id FROM records WHERE kind='conversation'
					ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?)`, [MEMORY_STORE_LIMITS.conversations - 1]);
			}
			this.reserveIdentity(); // After pruning/explicit restoration has freed a slot.
			const now = Date.now();
			const inserted = this.prepare(`INSERT INTO records(id,kind,category,scope,project,title,text,search_title,search_text,lane,session_id,event_id,role,created_at,updated_at)
				VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.kind, input.category, input.scope, input.project, input.title, input.text,
				normalize(input.title), normalize(input.text), input.source.lane, input.source.sessionId, input.source.eventId, input.source.role ?? null, now, now);
			this.insertIndex(inserted.lastInsertRowid, input.title, input.text);
			return { record: this.row(id)!, outcome: "saved" };
		});
	}

	private replace(existing: MemoryRecord, text: string, newTitle: string, provenance?: MemoryInput): MemoryRecord {
		const newId = identity({ ...existing, title: newTitle });
		if (newId !== existing.id) {
			if (this.row(newId)) throw new Error("Memory title already exists");
			if (this.prepare("SELECT 1 FROM tombstones WHERE id=?").get(newId)) throw new Error("Memory title was forgotten; use explicit remember");
			// Renaming a note changes its deterministic ID. Return the new ID, and
			// tombstone its old title so automatic saves cannot resurrect that fact.
			this.reserveIdentity(); // Rename retains the old identity as a tombstone.
			this.addTombstone(existing.id);
		}
		const indexed = this.prepare("SELECT rowid, search_title, search_text FROM records WHERE id=?").get(existing.id)!;
		this.deleteIndex(indexed.rowid, String(indexed.search_title), String(indexed.search_text));
		const latest = provenance ?? existing;
		this.prepare(`UPDATE records SET id=?, title=?, text=?, search_title=?, search_text=?, category=?, project=?,
			lane=?, session_id=?, event_id=?, role=?, updated_at=? WHERE id=?`).run(newId, newTitle, text,
			normalize(newTitle), normalize(text), latest.category, latest.project, latest.source.lane, latest.source.sessionId,
			latest.source.eventId, latest.source.role ?? null, Math.max(Date.now(), existing.updatedAt + 1), existing.id);
		this.insertIndex(indexed.rowid, newTitle, text);
		return this.row(newId)!;
	}

	update(id: string, currentProject: string, text: string, newTitle?: string): MemoryRecord | undefined {
		validId(id); project(currentProject); string(text, "text", MAX_TEXT_BYTES);
		if (newTitle !== undefined) title(newTitle, "conversation");
		if (!this.existing()) return undefined;
		return this.write(() => {
			const record = this.row(id);
			if (!record || (record.scope === "project" && record.project !== currentProject)) return undefined;
			const changedTitle = newTitle ?? record.title;
			title(changedTitle, record.kind);
			return this.replace(record, text, changedTitle);
		});
	}

	list(query: MemoryQuery): MemoryRecord[] {
		if (!query || typeof query !== "object") failure("query");
		project(query.project);
		const scope = query.scope === undefined ? "current" : query.scope;
		if (!["current", "global", "all"].includes(scope)) failure("query scope");
		if (query.kind !== undefined && query.kind !== "note" && query.kind !== "conversation") failure("query kind");
		if (query.limit !== undefined && (typeof query.limit !== "number" || !Number.isSafeInteger(query.limit))) failure("query limit");
		if (query.query !== undefined) string(query.query, "search query", 2048, false);
		const words = [...new Set(normalize(query.query ?? "").split(" ").filter(Boolean))];
		if (words.length > 128 || [...(query.query ?? "")].length > 512) failure("search query");
		const limit = Math.max(1, Math.min(50, query.limit ?? 20));
		const where: string[] = [];
		const args: SQLInputValue[] = [];
		if (words.length) {
			where.push("records_fts MATCH ?");
			args.push(words.map(word => `"${word.replace(/"/g, '""')}"`).join(" OR "));
		}
		if (scope === "current") { where.push("(r.scope='global' OR (r.scope='project' AND r.project=?))"); args.push(query.project); }
		else if (scope === "global") where.push("r.scope='global'");
		if (query.kind) { where.push("r.kind=?"); args.push(query.kind); }
		args.push(limit);
		if (!this.existing()) return [];
		// FTS5 tokenizes Unicode-normalized text. Quote EVERY literal term: user
		// quotes/operators/prefix wildcards can never alter the query grammar.
		const from = words.length ? "records_fts CROSS JOIN records r ON r.rowid=records_fts.rowid" : "records r";
		const rank = words.length ? "bm25(records_fts, 8.0, 1.0)" : "0";
		// CROSS JOIN keeps the FTS cursor outermost: otherwise SQLite may reopen
		// MATCH/BM25 once per project row and recompute global term stats.
		// Rank metadata first and fetch only <=50 selected bodies. Even a common
		// keyword must not materialize/normalize 10,000 large messages in the TUI.
		return this.prepare(`WITH matched AS MATERIALIZED (
			SELECT r.rowid AS record_rowid, r.id, r.updated_at, r.created_at,
				CASE r.kind WHEN 'note' THEN 0 ELSE 1 END AS priority, ${rank} AS search_rank FROM ${from}
			${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			ORDER BY priority, search_rank ASC, r.updated_at DESC, r.created_at DESC, r.id ASC LIMIT ?
		) SELECT r.* FROM matched m JOIN records r ON r.rowid=m.record_rowid
		ORDER BY m.priority, m.search_rank ASC, m.updated_at DESC, m.created_at DESC, m.id ASC`)
			.all(...args).map(decode);
	}

	get(id: string, currentProject: string, allProjects = false): MemoryRecord | undefined {
		validId(id); project(currentProject);
		if (typeof allProjects !== "boolean") failure("all-projects flag");
		if (!this.existing()) return undefined;
		const record = this.row(id);
		return record && (allProjects || record.scope === "global" || record.project === currentProject) ? record : undefined;
	}

	forget(id: string, currentProject: string, allProjects = false, expected?: MemoryRecord): boolean {
		validId(id); project(currentProject);
		if (typeof allProjects !== "boolean") failure("all-projects flag");
		if (expected !== undefined) {
			validateInput(expected); validId(expected.id); timestamp(expected.createdAt); timestamp(expected.updatedAt);
			if (expected.id !== id || expected.updatedAt < expected.createdAt || identity(expected) !== id) failure("expected record");
		}
		if (!this.existing()) {
			if (expected) throw new Error("Memory changed during confirmation");
			return false;
		}
		return this.write(() => {
			const record = this.row(id);
			if (expected && JSON.stringify(record) !== JSON.stringify(expected)) throw new Error("Memory changed during confirmation");
			if (!record || (!allProjects && record.scope === "project" && record.project !== currentProject)) return false;
			this.addTombstone(id);
			this.deleteRecords("id=?", [id]);
			return true;
		});
	}

	/** Human-only privacy operation; never expose this method as a model tool. */
	forgetAll(currentProject: string, scope: "project" | "global" | "all" = "project"): number {
		project(currentProject);
		if (!["project", "global", "all"].includes(scope)) failure("forget-all scope");
		if (!this.existing()) return 0;
		return this.write(() => {
			const filter = scope === "project" ? "scope='project' AND project=?" : scope === "global" ? "scope='global'" : "1";
			const args: SQLInputValue[] = scope === "project" ? [currentProject] : [];
			const needed = Number(this.prepare(`SELECT count(*) AS count FROM records WHERE (${filter})
				AND id NOT IN (SELECT id FROM tombstones)`).get(...args)!.count);
			if (this.count("tombstones") + needed > MEMORY_STORE_LIMITS.tombstones) throw new Error("Memory tombstone limit reached");
			this.prepare(`INSERT INTO tombstones(id, deleted_at) SELECT id, ? FROM records WHERE ${filter}
				ON CONFLICT(id) DO NOTHING`).run(Date.now(), ...args);
			return this.deleteRecords(filter, args);
		});
	}

	close(): void {
		const db = this.db;
		this.db = undefined;
		this.file = undefined;
		this.root = undefined;
		this.canonicalPath = undefined;
		this.statements.clear();
		db?.close();
	}
}
