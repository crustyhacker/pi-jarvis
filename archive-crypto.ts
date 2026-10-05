import {
	createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt,
} from "node:crypto";
import { types } from "node:util";

export const ARCHIVE_ENVELOPE_FORMAT = "pi-jarvis-archive-key";
export const ARCHIVE_ENVELOPE_VERSION = 1;
export const ARCHIVE_ENVELOPE_CIPHER = "sqlcipher4";
const WRAP_CIPHER = "aes-256-gcm";
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 4096;
const MAX_ACTIVE_KDFS = 2;
let activeKdfs = 0;

/** Version 1 supports exactly one password slot. Other slot kinds require a new version. */
export interface ArchiveKeyEnvelope {
	readonly format: typeof ARCHIVE_ENVELOPE_FORMAT;
	readonly version: typeof ARCHIVE_ENVELOPE_VERSION;
	readonly vaultId: string;
	readonly cipher: typeof ARCHIVE_ENVELOPE_CIPHER;
	readonly passwordSlot: {
		readonly kind: "password";
		readonly kdf: { readonly name: "scrypt"; readonly N: 131072; readonly r: 8; readonly p: 1 };
		readonly wrapCipher: "aes-256-gcm";
		readonly salt: string;
		readonly nonce: string;
		readonly wrappedKey: string;
		readonly tag: string;
	};
}

export type ArchiveCryptoErrorCode =
	| "INVALID_ENVELOPE" | "INVALID_PASSWORD" | "INVALID_KEY"
	| "UNLOCK_FAILED" | "CRYPTO_FAILED" | "BUSY" | "ABORTED";
const messages: Record<ArchiveCryptoErrorCode, string> = {
	INVALID_ENVELOPE: "Invalid archive key envelope.",
	INVALID_PASSWORD: "Archive password must be valid Unicode, 1–4096 UTF-8 bytes, without control characters or line breaks.",
	INVALID_KEY: "Archive key must be a 32-byte Buffer.",
	UNLOCK_FAILED: "Unable to unlock archive.",
	CRYPTO_FAILED: "Archive cryptography operation failed.",
	BUSY: "Archive password processing is busy. Try again later.",
	ABORTED: "Archive cryptography operation cancelled.",
};

/** Fixed messages/codes only: never includes passwords, envelope data, native errors or causes. */
export class ArchiveCryptoError extends Error {
	constructor(readonly code: ArchiveCryptoErrorCode) {
		super(messages[code]);
		this.name = "ArchiveCryptoError";
	}
}

function fail(code: ArchiveCryptoErrorCode): never { throw new ArchiveCryptoError(code); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail("ABORTED"); }

function validatePassword(password: string): void {
	if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_BYTES
		|| Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES
		|| /[\p{Cc}\p{Zl}\p{Zp}]/u.test(password)) fail("INVALID_PASSWORD");
	// Buffer.from would silently replace lone UTF-16 surrogates with U+FFFD. Reject instead.
	for (let i = 0; i < password.length; i++) {
		const unit = password.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = password.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff)) fail("INVALID_PASSWORD");
		} else if (unit >= 0xdc00 && unit <= 0xdfff) fail("INVALID_PASSWORD");
	}
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!input || typeof input !== "object" || types.isProxy(input)) fail("INVALID_ENVELOPE");
	const prototype: unknown = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) fail("INVALID_ENVELOPE");
	const ownKeys = Reflect.ownKeys(input);
	if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
		fail("INVALID_ENVELOPE");
	}
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("INVALID_ENVELOPE");
		result[key] = descriptor.value;
	}
	return result;
}

function base64(input: unknown, bytes: number): string {
	if (typeof input !== "string" || input.length !== Math.ceil(bytes / 3) * 4
		|| !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) fail("INVALID_ENVELOPE");
	const decoded = Buffer.from(input, "base64");
	if (decoded.length !== bytes || decoded.toString("base64") !== input) fail("INVALID_ENVELOPE");
	return input;
}

/**
 * Accepts an already-decoded JSON object, not JSON text. Returns a detached validated snapshot.
 * A JSON loader must enforce its own size/duplicate-member limits before decoding; duplicates
 * cannot be recovered from an object after JSON.parse. No getters/proxies or extra fields accepted.
 */
export function parseArchiveEnvelope(input: unknown): ArchiveKeyEnvelope {
	try {
		const root = record(input, ["format", "version", "vaultId", "cipher", "passwordSlot"]);
		if (root.format !== ARCHIVE_ENVELOPE_FORMAT || root.version !== ARCHIVE_ENVELOPE_VERSION
			|| root.cipher !== ARCHIVE_ENVELOPE_CIPHER || typeof root.vaultId !== "string"
			|| !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(root.vaultId)) {
			fail("INVALID_ENVELOPE");
		}
		const slot = record(root.passwordSlot, ["kind", "kdf", "wrapCipher", "salt", "nonce", "wrappedKey", "tag"]);
		const kdf = record(slot.kdf, ["name", "N", "r", "p"]);
		if (slot.kind !== "password" || slot.wrapCipher !== WRAP_CIPHER || kdf.name !== "scrypt"
			|| kdf.N !== SCRYPT_N || kdf.r !== SCRYPT_R || kdf.p !== SCRYPT_P) fail("INVALID_ENVELOPE");
		return {
			format: ARCHIVE_ENVELOPE_FORMAT, version: ARCHIVE_ENVELOPE_VERSION,
			vaultId: root.vaultId, cipher: ARCHIVE_ENVELOPE_CIPHER,
			passwordSlot: {
				kind: "password", kdf: { name: "scrypt", N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
				wrapCipher: WRAP_CIPHER, salt: base64(slot.salt, 32), nonce: base64(slot.nonce, 12),
				wrappedKey: base64(slot.wrappedKey, 32), tag: base64(slot.tag, 16),
			},
		};
	} catch {
		fail("INVALID_ENVELOPE");
	}
}

/** All public metadata, in a fixed order. Ciphertext/tag are authenticated by GCM itself. */
function aad(envelope: ArchiveKeyEnvelope): Buffer {
	const slot = envelope.passwordSlot;
	return Buffer.from(JSON.stringify([
		envelope.format, envelope.version, envelope.vaultId, envelope.cipher,
		slot.kind, slot.kdf.name, slot.kdf.N, slot.kdf.r, slot.kdf.p,
		slot.wrapCipher, slot.salt, slot.nonce,
	]), "utf8");
}

async function deriveWrappingKey(password: string, salt: Buffer, signal?: AbortSignal): Promise<Buffer> {
	checkAbort(signal);
	if (activeKdfs >= MAX_ACTIVE_KDFS) fail("BUSY");
	activeKdfs++;
	let passwordBytes: Buffer | undefined;
	let derived: Buffer | undefined;
	try {
		passwordBytes = Buffer.from(password, "utf8");
		derived = await new Promise<Buffer>((resolve, reject) => {
			scrypt(passwordBytes!, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (error, key) => {
				if (error) {
					key?.fill(0);
					reject(new ArchiveCryptoError("CRYPTO_FAILED"));
				} else resolve(key);
			});
		});
		checkAbort(signal);
		if (!Buffer.isBuffer(derived) || derived.length !== 32) fail("CRYPTO_FAILED");
		return derived;
	} catch (error) {
		derived?.fill(0);
		if (error instanceof ArchiveCryptoError) throw error;
		return fail("CRYPTO_FAILED");
	} finally {
		passwordBytes?.fill(0);
		activeKdfs--;
	}
}

function freshEnvelope(vaultId: string): ArchiveKeyEnvelope {
	return {
		format: ARCHIVE_ENVELOPE_FORMAT, version: ARCHIVE_ENVELOPE_VERSION,
		vaultId, cipher: ARCHIVE_ENVELOPE_CIPHER,
		passwordSlot: {
			kind: "password", kdf: { name: "scrypt", N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
			wrapCipher: WRAP_CIPHER, salt: randomBytes(32).toString("base64"),
			nonce: randomBytes(12).toString("base64"), wrappedKey: "", tag: "",
		},
	};
}

function wrap(envelope: ArchiveKeyEnvelope, key: Buffer, wrappingKey: Buffer): ArchiveKeyEnvelope {
	const cipher = createCipheriv(WRAP_CIPHER, wrappingKey, Buffer.from(envelope.passwordSlot.nonce, "base64"), { authTagLength: 16 });
	cipher.setAAD(aad(envelope));
	const wrappedKey = Buffer.concat([cipher.update(key), cipher.final()]);
	return {
		...envelope,
		passwordSlot: { ...envelope.passwordSlot, wrappedKey: wrappedKey.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
	};
}

/**
 * Generates a random archive DEK, independent of the password. Caller owns/wipes the returned key.
 * AbortSignal is checked before/after work; Node scrypt cannot be interrupted once started.
 * Buffer wiping is best effort, not forensic erasure of JS strings or native/runtime copies.
 */
export async function createArchiveEnvelope(password: string, signal?: AbortSignal): Promise<{ envelope: ArchiveKeyEnvelope; key: Buffer }> {
	checkAbort(signal);
	validatePassword(password);
	let key: Buffer | undefined;
	let wrappingKey: Buffer | undefined;
	try {
		const envelope = freshEnvelope(randomUUID());
		key = randomBytes(32);
		wrappingKey = await deriveWrappingKey(password, Buffer.from(envelope.passwordSlot.salt, "base64"), signal);
		checkAbort(signal);
		const wrapped = wrap(envelope, key, wrappingKey);
		checkAbort(signal);
		return { envelope: wrapped, key };
	} catch (error) {
		key?.fill(0);
		if (error instanceof ArchiveCryptoError) throw error;
		return fail("CRYPTO_FAILED");
	} finally {
		wrappingKey?.fill(0);
	}
}

/** Wrong passwords, malformed/tampered envelopes and native crypto failures share one safe error. */
export async function unlockArchiveEnvelope(input: unknown, password: string, signal?: AbortSignal): Promise<Buffer> {
	checkAbort(signal);
	validatePassword(password);
	let wrappingKey: Buffer | undefined;
	let partial: Buffer | undefined;
	let final: Buffer | undefined;
	let key: Buffer | undefined;
	try {
		const envelope = parseArchiveEnvelope(input);
		const slot = envelope.passwordSlot;
		wrappingKey = await deriveWrappingKey(password, Buffer.from(slot.salt, "base64"), signal);
		checkAbort(signal);
		const decipher = createDecipheriv(WRAP_CIPHER, wrappingKey, Buffer.from(slot.nonce, "base64"), { authTagLength: 16 });
		decipher.setAAD(aad(envelope));
		decipher.setAuthTag(Buffer.from(slot.tag, "base64"));
		partial = decipher.update(Buffer.from(slot.wrappedKey, "base64"));
		final = decipher.final();
		key = Buffer.concat([partial, final]);
		if (key.length !== 32) fail("UNLOCK_FAILED");
		checkAbort(signal);
		return key;
	} catch (error) {
		key?.fill(0);
		if (error instanceof ArchiveCryptoError && (error.code === "ABORTED" || error.code === "BUSY")) throw error;
		return fail("UNLOCK_FAILED");
	} finally {
		wrappingKey?.fill(0);
		partial?.fill(0);
		final?.fill(0);
	}
}

/**
 * PRECONDITION: caller supplies this vault's previously validated, unlocked DEK. Without the old
 * password this function cannot prove a key matches the old envelope. Passing a wrong key makes
 * the new envelope unusable for the existing archive. Does not validate/re-encrypt archive payloads.
 * Preserves vaultId/cipher; generates a new salt/nonce. Never wipes/mutates the caller-owned key.
 */
export async function rewrapArchiveEnvelope(input: unknown, key: Buffer, newPassword: string, signal?: AbortSignal): Promise<ArchiveKeyEnvelope> {
	checkAbort(signal);
	validatePassword(newPassword);
	const oldEnvelope = parseArchiveEnvelope(input);
	if (!Buffer.isBuffer(key) || key.length !== 32) fail("INVALID_KEY");
	let keyCopy: Buffer | undefined;
	let wrappingKey: Buffer | undefined;
	try {
		keyCopy = Buffer.from(key);
		const envelope = freshEnvelope(oldEnvelope.vaultId);
		wrappingKey = await deriveWrappingKey(newPassword, Buffer.from(envelope.passwordSlot.salt, "base64"), signal);
		checkAbort(signal);
		const wrapped = wrap(envelope, keyCopy, wrappingKey);
		checkAbort(signal);
		return wrapped;
	} catch (error) {
		if (error instanceof ArchiveCryptoError) throw error;
		return fail("CRYPTO_FAILED");
	} finally {
		keyCopy?.fill(0);
		wrappingKey?.fill(0);
	}
}
