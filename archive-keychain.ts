import { createRequire } from "node:module";

/** Caller supplies SHA-256(canonical agent-root + vault UUID), never a path or password. */
export interface ArchiveKeychain {
	get(account: string): Promise<Buffer | undefined>;
	set(account: string, key: Buffer): Promise<void>;
	delete(account: string): Promise<void>;
}

export const ARCHIVE_KEYCHAIN_SERVICE = "pi-jarvis-archive";

/** Local structural types keep the native dependency optional at build/test time. */
export interface ArchiveKeychainEntry {
	// The published AsyncEntry type says undefined, but its Rust Option also returns null.
	getPassword(): Promise<string | null | undefined>;
	setPassword(value: string): Promise<void>;
	deleteCredential(): Promise<boolean>;
}

export interface ArchiveKeychainEntryOptions {
	linux: { store: "secret-service" };
}

/** Injection is for isolated fake stores; the default factory alone loads native code. */
export type ArchiveKeychainEntryFactory = (
	service: string,
	account: string,
	options: ArchiveKeychainEntryOptions,
) => ArchiveKeychainEntry;

type EntryConstructor = new (
	service: string,
	account: string,
	options: ArchiveKeychainEntryOptions,
) => ArchiveKeychainEntry;

function nativeEntry(service: string, account: string, options: ArchiveKeychainEntryOptions): ArchiveKeychainEntry {
	if (process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32") {
		throw new Error("Unsupported OS credential store.");
	}
	const require = createRequire(import.meta.url);
	const manifest: unknown = require("@napi-rs/keyring/package.json");
	// Older versions ignore the Linux options and can silently fall back to keyutils.
	// Only this verified version's API is supported; review before upgrading it.
	if (typeof manifest !== "object" || manifest === null ||
		(manifest as { version?: unknown }).version !== "2.1.0") {
		throw new Error("Unsupported OS credential adapter version.");
	}
	const binding: unknown = require("@napi-rs/keyring");
	if (typeof binding !== "object" || binding === null ||
		typeof (binding as { AsyncEntry?: unknown }).AsyncEntry !== "function") {
		throw new Error("Unavailable OS credential adapter.");
	}
	const Entry = (binding as { AsyncEntry: EntryConstructor }).AsyncEntry;
	return new Entry(service, account, options);
}

function validateAccount(account: string): void {
	// The length check also excludes a trailing newline (JS '$' permits one).
	if (typeof account !== "string" || account.length !== 64 || !/^[a-f0-9]{64}$/.test(account)) {
		throw new Error("Invalid archive keychain account.");
	}
}

function decodeKey(value: unknown): Buffer {
	// Buffer.from(base64) is permissive; reject whitespace, URL-safe encoding,
	// omitted/excess padding, and nonzero unused padding bits, not just size.
	if (typeof value !== "string" || value.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
		throw new Error("Invalid remembered archive key in the OS credential store.");
	}
	const key = Buffer.from(value, "base64");
	if (key.length !== 32 || key.toString("base64") !== value) {
		key.fill(0);
		throw new Error("Invalid remembered archive key in the OS credential store.");
	}
	return key;
}

/**
 * Remember only a random 32-byte archive key, base64-encoded in the OS store.
 * Construction/import is inert. Call methods ONLY after explicit remembered-
 * unlock opt-in (including retrieval of that user's previously opted-in key).
 * Never enumerate credentials, store passwords, or fall back to files/keyutils.
 * Callers own returned Buffers and should zero them when their lifetime ends;
 * JS/native copies and immutable base64 strings cannot promise forensic erasure.
 */
export class NativeArchiveKeychain implements ArchiveKeychain {
	constructor(private readonly entryFactory: ArchiveKeychainEntryFactory = nativeEntry) {}

	private entry(account: string): ArchiveKeychainEntry {
		// Accepted/ignored on macOS and Windows; on Linux it forbids auto-fallback.
		return this.entryFactory(ARCHIVE_KEYCHAIN_SERVICE, account, { linux: { store: "secret-service" } });
	}

	async get(account: string): Promise<Buffer | undefined> {
		validateAccount(account);
		let value: unknown;
		try {
			value = await this.entry(account).getPassword();
		} catch {
			// Never forward native messages, arbitrary thrown objects, codes, or causes.
			throw new Error("Could not read the remembered archive key from the OS credential store.");
		}
		return value === undefined || value === null ? undefined : decodeKey(value);
	}

	async set(account: string, key: Buffer): Promise<void> {
		validateAccount(account);
		if (!Buffer.isBuffer(key) || key.length !== 32) {
			throw new Error("Archive keychain keys must be 32-byte Buffers.");
		}
		// Snapshot before native work/await; the caller retains ownership of its Buffer.
		const value = key.toString("base64");
		try {
			await this.entry(account).setPassword(value);
		} catch {
			throw new Error("Could not remember the archive key in the OS credential store.");
		}
	}

	async delete(account: string): Promise<void> {
		validateAccount(account);
		let deleted: unknown;
		try {
			deleted = await this.entry(account).deleteCredential();
		} catch {
			throw new Error("Could not delete the remembered archive key from the OS credential store.");
		}
		// Verified 2.1.0 API: false means NoEntry only; all other failures reject.
		if (deleted !== true && deleted !== false) {
			throw new Error("Invalid archive key deletion response from the OS credential store.");
		}
	}
}
