import { statSync } from "node:fs";
import { createRequire } from "node:module";

export type ArchiveSqlValue = string | number | bigint | null | NodeJS.ArrayBufferView;
export type ArchiveRow = Record<string, unknown>;
export interface ArchiveStatement {
	run(...values: ArchiveSqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	get(...values: ArchiveSqlValue[]): ArchiveRow | undefined;
	all(...values: ArchiveSqlValue[]): ArchiveRow[];
}
export interface ArchiveDatabase {
	prepare(sql: string): ArchiveStatement;
	exec(sql: string): void;
	close(): void;
}

/** Structural native boundary: no static optional-package import or node:sqlite cast. */
export interface ArchiveNativeDatabase extends ArchiveDatabase {
	key(value: Buffer): number;
}
export interface ArchiveNativeDatabaseConstructor {
	new(path: string, options: { fileMustExist: boolean; timeout: number }): ArchiveNativeDatabase;
}
export interface EncryptedArchiveDatabaseOptions {
	create?: boolean;
	/** Dependency injection for synthetic tests; never sourced from user configuration. */
	loadDatabase?: () => ArchiveNativeDatabaseConstructor;
}

const require = createRequire(import.meta.url);
const BACKEND = "better-sqlite3-multiple-ciphers";
const BACKEND_VERSION = "13.0.3";
const PROFILE = Object.freeze({
	cipher: "sqlcipher", legacy: 4, legacy_page_size: 4096, kdf_iter: 256000,
	fast_kdf_iter: 2, hmac_use: 1, hmac_pgno: 1, hmac_salt_mask: 58,
	kdf_algorithm: 2, hmac_algorithm: 2, plaintext_header_size: 0,
	hmac_check: 1, mc_legacy_wal: 0,
});

function unavailable(): Error {
	return new Error(`Archive encryption backend unavailable. Install the optional ${BACKEND}@${BACKEND_VERSION} package on a supported platform (Linux glibc >=2.35 or supported musl/macOS/Windows x64/arm64). No plaintext fallback was used.`);
}
function defaultLoadDatabase(): ArchiveNativeDatabaseConstructor {
	// Inspect the exact manifest before executing package JS/loading its binary.
	const metadata = require(`${BACKEND}/package.json`) as { version?: unknown };
	if (metadata?.version !== BACKEND_VERSION) throw new Error("Unsupported encryption backend version");
	return require(BACKEND) as ArchiveNativeDatabaseConstructor;
}
function nativeUnavailable(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "MODULE_NOT_FOUND" || code === "ERR_DLOPEN_FAILED";
}
function safeError(message: string, error?: unknown, closeFailed = false): Error {
	const value = (error ?? {}) as { code?: unknown; errcode?: unknown };
	const primary = typeof value.errcode === "number" && Number.isInteger(value.errcode) ? value.errcode & 0xff : undefined;
	// Only retryable lock classifications cross this boundary, never native text/cause.
	const busy = primary === 5 || (typeof value.code === "string" && /^SQLITE_BUSY(?:_|$)/.test(value.code));
	const locked = primary === 6 || (typeof value.code === "string" && /^SQLITE_LOCKED(?:_|$)/.test(value.code));
	const result = new Error(message);
	if (busy || locked) Object.assign(result, { code: busy ? "SQLITE_BUSY" : "SQLITE_LOCKED", errcode: busy ? 5 : 6 });
	// The caller must not delete/recover storage under a potentially live native
	// handle, including failed initialization before a database was returned.
	if (closeFailed) Object.assign(result, { closeFailed: true });
	return result;
}

/** SQLCipher-4-compatible AES-256-CBC/HMAC-SHA512. Caller owns filesystem privacy,
 * schema validation and WAL initialization. This is not a path sandbox, vendor
 * SQLCipher binding, forensic-erasure guarantee, or an independent crypto audit. */
export function openEncryptedArchiveDatabase(path: string, key: Buffer, options: EncryptedArchiveDatabaseOptions = {}): ArchiveDatabase {
	if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("Invalid encrypted archive path");
	if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Archive encryption requires a 32-byte key");
	if (!options || typeof options !== "object" || (options.create !== undefined && typeof options.create !== "boolean") ||
		(options.loadDatabase !== undefined && typeof options.loadDatabase !== "function")) throw new Error("Invalid encrypted archive open options");
	const create = options.create === true;
	if (!create) {
		// Zero bytes cannot authenticate a key. Never initialize a read/open request.
		// A raced path replacement is not sandboxed; ArchiveStore pins identities.
		try { if (statSync(path).size === 0) throw new Error("Empty archive"); }
		catch { throw safeError("Unable to open an existing encrypted archive; no database was created"); }
	}
	let Constructor: ArchiveNativeDatabaseConstructor;
	try {
		Constructor = (options.loadDatabase ?? defaultLoadDatabase)();
		if (typeof Constructor !== "function") throw new Error("Invalid native constructor");
	} catch { throw unavailable(); }
	let native: ArchiveNativeDatabase;
	try { native = new Constructor(path, { fileMustExist: !create, timeout: 5_000 }); }
	catch (error) {
		if (nativeUnavailable(error)) throw unavailable();
		throw safeError("Unable to open encrypted archive", error);
	}
	try {
		// No password/DEK in SQL. SQLite silently ignores unknown pragmas, so verify.
		for (const [name, value] of Object.entries(PROFILE)) native.exec(`PRAGMA ${name}=${typeof value === "string" ? `'${value}'` : value}`);
		for (const [name, value] of Object.entries(PROFILE)) {
			const row = native.prepare(`PRAGMA ${name}`).get();
			if (!row || String(Object.values(row)[0]) !== String(value)) throw new Error("Unsupported cipher profile");
		}
		// A bare 32-byte Buffer is a passphrase to sqlite3mc. Its documented raw
		// prefix also accepts binary bytes, so avoid immutable hex/SQL key strings.
		const encoded = Buffer.alloc(36);
		encoded.write("raw:", 0, "ascii"); key.copy(encoded, 4);
		try { if (native.key(encoded) !== 0) throw new Error("Native key setup failed"); }
		finally { encoded.fill(0); }
		// Unlike configuration pragmas, cipher_salt is obtained from the active
		// encrypted write codec. Unknown/no-op key APIs must not yield plaintext.
		const saltRow = native.prepare("PRAGMA cipher_salt").get();
		const salt = saltRow && Object.values(saltRow)[0];
		if (typeof salt !== "string" || !/^[0-9a-f]{32}$/i.test(salt)) throw new Error("Encryption codec inactive");
		for (const name of ["cipher", "legacy", "hmac_use", "hmac_check", "hmac_algorithm", "plaintext_header_size"] as const) {
			const row = native.prepare(`PRAGMA ${name}`).get();
			if (!row || String(Object.values(row)[0]) !== String(PROFILE[name])) throw new Error("Encryption profile changed");
		}
		// 2.4.0 does not encrypt temporary files. Set memory-only temp storage before
		// any data query; no fallback to file-backed temp or claims about swap/core dumps.
		native.exec("PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF");
		if (native.prepare("PRAGMA temp_store").get()?.temp_store !== 2) throw new Error("Memory-only temporary storage unavailable");
		// key() returning SQLITE_OK is not authentication. This bounded query must
		// succeed before caller initialization; failure never resets or repairs a DB.
		native.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
	} catch (error) {
		let closeFailed = false;
		try { native.close(); } catch { closeFailed = true; }
		throw safeError("Unable to unlock encrypted archive or verify its encryption profile", error, closeFailed);
	}
	let closed = false;
	const invoke = <T>(action: () => T): T => {
		if (closed) throw new Error("Encrypted archive database is closed");
		try { return action(); } catch (error) { throw safeError("Encrypted archive SQLite operation failed", error); }
	};
	return Object.freeze({
		prepare(sql: string): ArchiveStatement {
			const statement = invoke(() => native.prepare(sql));
			return Object.freeze({
				run: (...values: ArchiveSqlValue[]) => invoke(() => statement.run(...values)),
				get: (...values: ArchiveSqlValue[]) => invoke(() => statement.get(...values)),
				all: (...values: ArchiveSqlValue[]) => invoke(() => statement.all(...values)),
			});
		},
		exec(sql: string): void { invoke(() => native.exec(sql)); },
		close(): void {
			if (closed) return;
			closed = true;
			try { native.close(); } catch (error) { throw safeError("Unable to close encrypted archive", error, true); }
		},
	});
}
