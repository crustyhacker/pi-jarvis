import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
	ARCHIVE_ENVELOPE_CIPHER, ARCHIVE_ENVELOPE_FORMAT, ARCHIVE_ENVELOPE_VERSION,
	ArchiveCryptoError, createArchiveEnvelope, parseArchiveEnvelope, rewrapArchiveEnvelope, unlockArchiveEnvelope,
	type ArchiveCryptoErrorCode,
} from "../archive-crypto.js";

// Synthetic fixtures only. No files, real passwords, user archives or native database backend.
// Nine real, sequential scrypt calls total; fault/coverage tests mock only scrypt, not GCM.
const PASSWORD = "  fixturé e\u0301 🔐  ";
const KEY_HEX = "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";
const KEK_HEX = "f8c5327c74d81ee23dc5425677ff8d26209c32db363a1ddda607ed83022116fc";
const AAD = '["pi-jarvis-archive-key",1,"11111111-2222-4333-8444-555555555555","sqlcipher4","password","scrypt",131072,8,1,"aes-256-gcm","AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","oKGio6Slpqeoqaqr"]';
function fixture() {
	return {
		format: "pi-jarvis-archive-key", version: 1,
		vaultId: "11111111-2222-4333-8444-555555555555", cipher: "sqlcipher4",
		passwordSlot: {
			kind: "password", kdf: { name: "scrypt", N: 131072, r: 8, p: 1 }, wrapCipher: "aes-256-gcm",
			salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", nonce: "oKGio6Slpqeoqaqr",
			wrappedKey: "LSsZJX8OxZs1hbfII4TWCam8pdY+Yxop0m5aplH7mXs=", tag: "WI+sL+GfzuQ1w5XCJUFOdw==",
		},
	};
}
function flipped(base64: string): string {
	const bytes = Buffer.from(base64, "base64");
	bytes[0] ^= 1;
	return bytes.toString("base64");
}
function errorCode(code: ArchiveCryptoErrorCode) {
	return (error: unknown): boolean => {
		assert.ok(error instanceof ArchiveCryptoError);
		assert.equal(error.code, code);
		assert.equal(error.name, "ArchiveCryptoError");
		assert.equal("cause" in error, false);
		if (code === "UNLOCK_FAILED") assert.equal(error.message, "Unable to unlock archive.");
		assert.doesNotMatch(error.message, /native-fixture-secret/);
		return true;
	};
}
function wiped(bytes: Buffer): void { assert.deepEqual(bytes, Buffer.alloc(bytes.length)); }

interface KdfCall {
	password: Buffer;
	salt: Buffer;
	length: number;
	options: { N: number; r: number; p: number; maxmem: number };
	callback: (error: Error | null, key: Buffer) => void;
}
function fakeScrypt(handle: (call: KdfCall) => void): typeof crypto.scrypt {
	return ((password: Buffer, salt: Buffer, length: number, options: KdfCall["options"], callback: KdfCall["callback"]) => {
		handle({ password, salt, length, options, callback });
	}) as unknown as typeof crypto.scrypt;
}
async function withCryptoPatch<K extends keyof typeof crypto, T>(name: K, replacement: typeof crypto[K], run: () => Promise<T>): Promise<T> {
	const original = crypto[name];
	crypto[name] = replacement;
	syncBuiltinESMExports();
	try { return await run(); } finally {
		crypto[name] = original;
		syncBuiltinESMExports();
	}
}
function immediateKdf() {
	const calls: KdfCall[] = [];
	const returned: Buffer[] = [];
	const passwords: Buffer[] = [];
	return {
		calls, returned, passwords,
		replacement: fakeScrypt((call) => {
			calls.push(call);
			passwords.push(Buffer.from(call.password));
			const key = Buffer.from(KEK_HEX, "hex");
			returned.push(key);
			queueMicrotask(() => call.callback(null, key));
		}),
		checkWiped() { for (const call of calls) wiped(call.password); for (const key of returned) wiped(key); },
	};
}
function deferredKdf() {
	const calls: KdfCall[] = [];
	const completed = new Set<number>();
	const returned: Buffer[] = [];
	function complete(index: number): void {
		if (completed.has(index)) return;
		completed.add(index);
		const key = Buffer.from(KEK_HEX, "hex");
		returned.push(key);
		calls[index].callback(null, key);
	}
	return { calls, returned, complete, replacement: fakeScrypt((call) => calls.push(call)), releaseAll() { calls.forEach((_, i) => complete(i)); } };
}

// Independent fixed-vector check using Node crypto directly, not the implementation's AAD builder.
test("reference fixture uses the exact standard scrypt parameters and AES-256-GCM AAD", async () => {
	const f = fixture();
	const password = Buffer.from(PASSWORD, "utf8");
	const key = Buffer.from(KEY_HEX, "hex");
	const derived = await new Promise<Buffer>((resolve, reject) => {
		crypto.scrypt(password, Buffer.from(f.passwordSlot.salt, "base64"), 32,
			{ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
			(error, result) => error ? reject(error) : resolve(result));
	});
	try {
		assert.equal(derived.toString("hex"), KEK_HEX);
		const cipher = crypto.createCipheriv("aes-256-gcm", derived, Buffer.from(f.passwordSlot.nonce, "base64"), { authTagLength: 16 });
		cipher.setAAD(Buffer.from(AAD, "utf8"));
		assert.equal(Buffer.concat([cipher.update(key), cipher.final()]).toString("base64"), f.passwordSlot.wrappedKey);
		assert.equal(cipher.getAuthTag().toString("base64"), f.passwordSlot.tag);
	} finally { password.fill(0); key.fill(0); derived.fill(0); }
});

test("unlocks the independent fixed envelope with exact Unicode and whitespace", async () => {
	const key = await unlockArchiveEnvelope(fixture(), PASSWORD);
	try { assert.equal(key.toString("hex"), KEY_HEX); } finally { key.fill(0); }
});

test("creates a random 32-byte DEK and strict, JSON-round-trippable password envelope", async () => {
	const created = await createArchiveEnvelope(PASSWORD);
	let unlocked: Buffer | undefined;
	try {
		assert.equal(created.key.length, 32);
		assert.notEqual(created.key.toString("hex"), KEY_HEX);
		assert.notEqual(created.key.toString("hex"), KEK_HEX);
		assert.equal(created.envelope.format, ARCHIVE_ENVELOPE_FORMAT);
		assert.equal(created.envelope.version, ARCHIVE_ENVELOPE_VERSION);
		assert.equal(created.envelope.cipher, ARCHIVE_ENVELOPE_CIPHER);
		assert.match(created.envelope.vaultId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.deepEqual(created.envelope.passwordSlot.kdf, { name: "scrypt", N: 131072, r: 8, p: 1 });
		for (const [field, size] of [["salt", 32], ["nonce", 12], ["wrappedKey", 32], ["tag", 16]] as const) {
			assert.equal(Buffer.from(created.envelope.passwordSlot[field], "base64").length, size);
			assert.notEqual(created.envelope.passwordSlot[field], fixture().passwordSlot[field]);
		}
		const json = JSON.stringify(created.envelope);
		assert.ok(!json.includes(PASSWORD));
		assert.ok(!json.includes(created.key.toString("base64")));
		assert.deepEqual(parseArchiveEnvelope(JSON.parse(json)), created.envelope);
		unlocked = await unlockArchiveEnvelope(JSON.parse(json), PASSWORD);
		assert.deepEqual(unlocked, created.key);
		assert.notEqual(unlocked, created.key);
	} finally { created.key.fill(0); unlocked?.fill(0); }
});

test("wrong (normalized) password and a real corrupted tag fail generically", async () => {
	assert.notEqual(PASSWORD.normalize("NFC"), PASSWORD);
	await assert.rejects(unlockArchiveEnvelope(fixture(), PASSWORD.normalize("NFC")), errorCode("UNLOCK_FAILED"));
	const corrupt = fixture();
	corrupt.passwordSlot.tag = flipped(corrupt.passwordSlot.tag);
	await assert.rejects(unlockArchiveEnvelope(corrupt, PASSWORD), errorCode("UNLOCK_FAILED"));
});

test("rewrap retains the same DEK/vault/cipher, uses fresh salt/nonce, and changes only the password slot", async () => {
	const original = fixture();
	const before = structuredClone(original);
	// This deterministic DEK is authenticated by the independent fixture above.
	const key = Buffer.from(KEY_HEX, "hex");
	let unlocked: Buffer | undefined;
	try {
		const changed = await rewrapArchiveEnvelope(original, key, "synthetic replacement 🦉");
		assert.equal(changed.vaultId, original.vaultId);
		assert.equal(changed.cipher, original.cipher);
		assert.equal(changed.format, original.format);
		assert.equal(changed.version, original.version);
		for (const field of ["salt", "nonce", "wrappedKey", "tag"] as const) {
			assert.notEqual(changed.passwordSlot[field], original.passwordSlot[field]);
		}
		assert.deepEqual(original, before);
		assert.equal(key.toString("hex"), KEY_HEX, "rewrap must not mutate caller-owned key");
		unlocked = await unlockArchiveEnvelope(changed, "synthetic replacement 🦉");
		assert.deepEqual(unlocked, key);
		await assert.rejects(unlockArchiveEnvelope(changed, PASSWORD), errorCode("UNLOCK_FAILED"));
	} finally { key.fill(0); unlocked?.fill(0); }
});

test("strict parser returns a detached snapshot and ignores JSON property order", () => {
	const original = fixture();
	const parsed = parseArchiveEnvelope(original);
	assert.deepEqual(parsed, original);
	assert.notEqual(parsed, original);
	assert.notEqual(parsed.passwordSlot, original.passwordSlot);
	assert.notEqual(parsed.passwordSlot.kdf, original.passwordSlot.kdf);
	original.passwordSlot.kdf.N = 2;
	original.passwordSlot.salt = "changed";
	assert.equal(parsed.passwordSlot.kdf.N, 131072);
	assert.equal(parsed.passwordSlot.salt, fixture().passwordSlot.salt);
	const f = fixture();
	assert.deepEqual(parseArchiveEnvelope({ passwordSlot: f.passwordSlot, cipher: f.cipher, vaultId: f.vaultId, version: f.version, format: f.format }), f);
	assert.deepEqual(parseArchiveEnvelope(Object.assign(Object.create(null), f)), f);
	Object.freeze(f.passwordSlot.kdf); Object.freeze(f.passwordSlot); Object.freeze(f);
	assert.deepEqual(parseArchiveEnvelope(f), f);
});

test("strict parser rejects missing/unknown fields, unsupported versions/kinds/parameters and wrong types", () => {
	const cases: unknown[] = [undefined, null, [], new Date(), Buffer.alloc(32), "{}", 1, true];
	const f = fixture();
	for (const name of Object.keys(f)) {
		const missing: Record<string, unknown> = { ...f }; delete missing[name]; cases.push(missing);
	}
	for (const name of Object.keys(f.passwordSlot)) {
		const slot: Record<string, unknown> = { ...f.passwordSlot }; delete slot[name]; cases.push({ ...f, passwordSlot: slot });
	}
	for (const name of Object.keys(f.passwordSlot.kdf)) {
		const kdf: Record<string, unknown> = { ...f.passwordSlot.kdf }; delete kdf[name];
		cases.push({ ...f, passwordSlot: { ...f.passwordSlot, kdf } });
	}
	cases.push(
		{ ...f, future: 1 }, { ...f, ["__proto__"]: {} }, { ...f, [Symbol("extra")]: 1 },
		{ ...f, format: "other" }, { ...f, version: 0 }, { ...f, version: 2 }, { ...f, version: "1" },
		{ ...f, vaultId: 123 }, { ...f, vaultId: "11111111-2222-1333-8444-555555555555" },
		{ ...f, vaultId: "11111111-2222-4333-0444-555555555555" },
		{ ...f, vaultId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" }, { ...f, cipher: "generic" },
		{ ...f, passwordSlot: null }, { ...f, passwordSlot: { ...f.passwordSlot, kind: "public-key" } },
		{ ...f, passwordSlot: { ...f.passwordSlot, wrapCipher: "aes-128-gcm" } },
		{ ...f, passwordSlot: { ...f.passwordSlot, extra: true } },
		{ ...f, passwordSlot: { ...f.passwordSlot, kdf: [] } },
		{ ...f, passwordSlot: { ...f.passwordSlot, kdf: { ...f.passwordSlot.kdf, name: "pbkdf2" } } },
		{ ...f, passwordSlot: { ...f.passwordSlot, kdf: { ...f.passwordSlot.kdf, maxmem: 1 } } },
	);
	for (const name of ["N", "r", "p"] as const) {
		for (const bad of [0, -1, Infinity, NaN, 1048576, String(f.passwordSlot.kdf[name])]) {
			cases.push({ ...f, passwordSlot: { ...f.passwordSlot, kdf: { ...f.passwordSlot.kdf, [name]: bad } } });
		}
	}
	for (const input of cases) assert.throws(() => parseArchiveEnvelope(input), errorCode("INVALID_ENVELOPE"));
	// Object input cannot contain duplicate names. Reject all raw JSON, including duplicate-member text.
	assert.throws(() => parseArchiveEnvelope('{"version":1,"version":2}'), errorCode("INVALID_ENVELOPE"));
});

test("strict parser rejects malformed/noncanonical/wrong-length base64 in every binary field", () => {
	const f = fixture();
	for (const field of ["salt", "nonce", "wrappedKey", "tag"] as const) {
		const good = f.passwordSlot[field];
		for (const bad of [null, 1, "", good + "\n", " " + good, good + "=", good.slice(1),
			good.replace(/=+$/, ""), "-" + good.slice(1), "_" + good.slice(1), "é" + good.slice(1),
			Buffer.alloc(1).toString("base64"), Buffer.alloc(33).toString("base64")]) {
			if (bad === good) continue;
			assert.throws(() => parseArchiveEnvelope({ ...f, passwordSlot: { ...f.passwordSlot, [field]: bad } }), errorCode("INVALID_ENVELOPE"));
		}
	}
	// Base64's unused pad bits must be zero even when Node would decode the same byte sequence.
	const noncanonicalSalt = f.passwordSlot.salt.slice(0, -2) + "9=";
	assert.deepEqual(Buffer.from(noncanonicalSalt, "base64"), Buffer.from(f.passwordSlot.salt, "base64"));
	assert.throws(() => parseArchiveEnvelope({ ...f, passwordSlot: { ...f.passwordSlot, salt: noncanonicalSalt } }), errorCode("INVALID_ENVELOPE"));
	const noncanonicalTag = f.passwordSlot.tag.slice(0, -3) + "x==";
	assert.deepEqual(Buffer.from(noncanonicalTag, "base64"), Buffer.from(f.passwordSlot.tag, "base64"));
	assert.throws(() => parseArchiveEnvelope({ ...f, passwordSlot: { ...f.passwordSlot, tag: noncanonicalTag } }), errorCode("INVALID_ENVELOPE"));
});

test("parser never invokes accessors, proxies or toJSON and rejects non-JSON object shapes", () => {
	let invoked = 0;
	const getter = { get() { invoked++; throw new Error("native-fixture-secret"); }, enumerable: true };
	const root = fixture(); Object.defineProperty(root, "format", getter);
	const slot = fixture(); Object.defineProperty(slot.passwordSlot, "salt", getter);
	const kdf = fixture(); Object.defineProperty(kdf.passwordSlot.kdf, "N", getter);
	const nonenumerable = fixture(); Object.defineProperty(nonenumerable, "format", { value: nonenumerable.format, enumerable: false });
	const proxy = new Proxy(fixture(), { ownKeys() { invoked++; throw new Error("native-fixture-secret"); } });
	const nestedProxy = fixture(); nestedProxy.passwordSlot.kdf = new Proxy(nestedProxy.passwordSlot.kdf, { getPrototypeOf() { invoked++; throw new Error("native-fixture-secret"); } });
	class NotJson { constructor() { Object.assign(this, fixture()); } }
	for (const input of [root, slot, kdf, nonenumerable, proxy, nestedProxy, new NotJson(), Object.create(fixture()),
		{ ...fixture(), toJSON() { invoked++; return fixture(); } }]) {
		assert.throws(() => parseArchiveEnvelope(input), errorCode("INVALID_ENVELOPE"));
	}
	assert.equal(invoked, 0);
});

test("every envelope field is authenticated or strictly fixed, with generic unlock failures", async () => {
	const f = fixture();
	const changes = [
		{ ...f, format: "different" }, { ...f, version: 2 }, { ...f, cipher: "different" },
		{ ...f, vaultId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
		{ ...f, passwordSlot: { ...f.passwordSlot, kind: "public-key" } },
		{ ...f, passwordSlot: { ...f.passwordSlot, wrapCipher: "aes-128-gcm" } },
		{ ...f, passwordSlot: { ...f.passwordSlot, kdf: { ...f.passwordSlot.kdf, name: "pbkdf2" } } },
		...["N", "r", "p"].map((name) => ({ ...f, passwordSlot: { ...f.passwordSlot, kdf: { ...f.passwordSlot.kdf, [name]: 2 } } })),
		...["salt", "nonce", "wrappedKey", "tag"].map((name) => ({ ...f, passwordSlot: { ...f.passwordSlot,
			[name]: flipped(f.passwordSlot[name as "salt" | "nonce" | "wrappedKey" | "tag"]),
		} })),
		{ ...f, unexpected: true }, null,
	];
	const mock = immediateKdf();
	await withCryptoPatch("scrypt", mock.replacement, async () => {
		for (const changed of changes) await assert.rejects(unlockArchiveEnvelope(changed, PASSWORD), errorCode("UNLOCK_FAILED"));
	});
	assert.equal(mock.calls.length, 5, "only valid vault/salt/nonce/ciphertext/tag changes reach the KDF");
	mock.checkWiped();
});

test("invalid passwords fail before any KDF; valid Unicode/whitespace is passed byte-for-byte without normalization", async () => {
	const key = Buffer.from(KEY_HEX, "hex");
	const mock = immediateKdf();
	try {
		await withCryptoPatch("scrypt", mock.replacement, async () => {
			const invalid: unknown[] = ["", null, 0, {}, true, "a".repeat(4097), "é".repeat(2049), "🔐".repeat(1025),
				"\ud800", "\udc00", "\ud800x", "x\udfff", "\u2028", "\u2029",
				...Array.from({ length: 32 }, (_, i) => `a${String.fromCharCode(i)}b`),
				...Array.from({ length: 33 }, (_, i) => `a${String.fromCharCode(i + 127)}b`),
			];
			for (const password of invalid) {
				await assert.rejects(createArchiveEnvelope(password as string), errorCode("INVALID_PASSWORD"));
				await assert.rejects(unlockArchiveEnvelope(fixture(), password as string), errorCode("INVALID_PASSWORD"));
				await assert.rejects(rewrapArchiveEnvelope(fixture(), key, password as string), errorCode("INVALID_PASSWORD"));
			}
			assert.equal(mock.calls.length, 0);
			const valid = [PASSWORD, PASSWORD.trim(), PASSWORD.normalize("NFC"), " ", "\u00a0a\u200db", "a".repeat(4096), "é".repeat(2048), "🔐".repeat(1024)];
			for (const password of valid) {
				const unlocked = await unlockArchiveEnvelope(fixture(), password);
				unlocked.fill(0);
			}
			assert.deepEqual(mock.passwords, valid.map((password) => Buffer.from(password, "utf8")));
			for (const call of mock.calls) {
				assert.equal(call.length, 32);
				assert.deepEqual(call.options, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
				assert.deepEqual(call.salt, Buffer.from(fixture().passwordSlot.salt, "base64"));
			}
		});
		mock.checkWiped();
	} finally { key.fill(0); for (const password of mock.passwords) password.fill(0); }
});

test("rewrap checks exact key shape and neither mutates nor wipes caller-owned keys on failure", async () => {
	const mock = immediateKdf();
	const good = Buffer.from(KEY_HEX, "hex");
	try {
		await withCryptoPatch("scrypt", mock.replacement, async () => {
			for (const bad of [null, new Uint8Array(32), Buffer.alloc(31), Buffer.alloc(33), "key"]) {
				await assert.rejects(rewrapArchiveEnvelope(fixture(), bad as Buffer, "fixture password"), errorCode("INVALID_KEY"));
			}
			await assert.rejects(rewrapArchiveEnvelope({}, good, "fixture password"), errorCode("INVALID_ENVELOPE"));
			assert.equal(mock.calls.length, 0);
			assert.equal(good.toString("hex"), KEY_HEX);
		});
	} finally { good.fill(0); }
});

test("in-flight KDFs are capped at two, with immediate busy rejection and no queue", async () => {
	const deferred = deferredKdf();
	const key = Buffer.from(KEY_HEX, "hex");
	try {
		await withCryptoPatch("scrypt", deferred.replacement, async () => {
			const first = createArchiveEnvelope("synthetic first");
			const second = createArchiveEnvelope("synthetic second");
			try {
				assert.equal(deferred.calls.length, 2);
				await assert.rejects(createArchiveEnvelope("synthetic third"), errorCode("BUSY"));
				await assert.rejects(unlockArchiveEnvelope(fixture(), PASSWORD), errorCode("BUSY"));
				await assert.rejects(rewrapArchiveEnvelope(fixture(), key, "synthetic third"), errorCode("BUSY"));
				assert.equal(deferred.calls.length, 2);
			} finally { deferred.releaseAll(); }
			for (const created of await Promise.all([first, second])) created.key.fill(0);
			const later = unlockArchiveEnvelope(fixture(), PASSWORD);
			assert.equal(deferred.calls.length, 3, "completed operations free slots");
			deferred.complete(2);
			const unlocked = await later;
			assert.equal(unlocked.toString("hex"), KEY_HEX);
			unlocked.fill(0);
		});
		for (const call of deferred.calls) wiped(call.password);
		for (const returned of deferred.returned) wiped(returned);
		assert.equal(key.toString("hex"), KEY_HEX);
	} finally { key.fill(0); deferred.releaseAll(); }
});

test("already-aborted calls do not derive; mid-KDF abort waits then wipes/discards late results", async () => {
	const deferred = deferredKdf();
	const callerKey = Buffer.from(KEY_HEX, "hex");
	const randomBuffers: Buffer[] = [];
	const originalRandomBytes = crypto.randomBytes;
	const trackedRandomBytes = ((length: number) => {
		const result = originalRandomBytes(length);
		randomBuffers.push(result);
		return result;
	}) as typeof crypto.randomBytes;
	try {
		await withCryptoPatch("scrypt", deferred.replacement, async () => {
			const preaborted = AbortSignal.abort(new Error("native-fixture-secret"));
			await assert.rejects(createArchiveEnvelope(PASSWORD, preaborted), errorCode("ABORTED"));
			await assert.rejects(unlockArchiveEnvelope(fixture(), PASSWORD, preaborted), errorCode("ABORTED"));
			await assert.rejects(rewrapArchiveEnvelope(fixture(), callerKey, PASSWORD, preaborted), errorCode("ABORTED"));
			assert.equal(deferred.calls.length, 0);
			await withCryptoPatch("randomBytes", trackedRandomBytes, async () => {
				const controller = new AbortController();
				const pending = createArchiveEnvelope(PASSWORD, controller.signal);
				controller.abort(new Error("native-fixture-secret"));
				let settled = false;
				void pending.then(() => { settled = true; }, () => { settled = true; });
				await Promise.resolve();
				assert.equal(settled, false, "Node's in-flight scrypt is not interruptible");
				deferred.complete(0);
				await assert.rejects(pending, errorCode("ABORTED"));
				assert.equal(randomBuffers.length, 3); // public salt, public nonce, sensitive DEK
				wiped(randomBuffers[2]);
			});
			for (const operation of ["unlock", "rewrap"] as const) {
				const controller = new AbortController();
				const pending = operation === "unlock"
					? unlockArchiveEnvelope(fixture(), PASSWORD, controller.signal)
					: rewrapArchiveEnvelope(fixture(), callerKey, PASSWORD, controller.signal);
				controller.abort();
				deferred.complete(deferred.calls.length - 1);
				await assert.rejects(pending, errorCode("ABORTED"));
			}
		});
		for (const call of deferred.calls) wiped(call.password);
		for (const returned of deferred.returned) wiped(returned);
		assert.equal(callerKey.toString("hex"), KEY_HEX);
	} finally { callerKey.fill(0); deferred.releaseAll(); }
});

test("unlock snapshots envelope before awaiting KDF and rewrap snapshots caller key", async () => {
	const deferred = deferredKdf();
	const key = Buffer.from(KEY_HEX, "hex");
	try {
		await withCryptoPatch("scrypt", deferred.replacement, async () => {
			const input = fixture();
			const pending = unlockArchiveEnvelope(input, PASSWORD);
			input.vaultId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
			input.passwordSlot.salt = flipped(input.passwordSlot.salt);
			input.passwordSlot.kdf.N = 2;
			deferred.complete(0);
			const unlocked = await pending;
			assert.equal(unlocked.toString("hex"), KEY_HEX);
			unlocked.fill(0);
			const rewrapping = rewrapArchiveEnvelope(fixture(), key, PASSWORD);
			key.fill(0xff); // caller mutation during the await must not change the captured DEK
			deferred.complete(1);
			const changed = await rewrapping;
			const reopening = unlockArchiveEnvelope(changed, PASSWORD);
			deferred.complete(2);
			const reopened = await reopening;
			assert.equal(reopened.toString("hex"), KEY_HEX);
			reopened.fill(0);
			assert.deepEqual(key, Buffer.alloc(32, 0xff));
		});
	} finally { key.fill(0); deferred.releaseAll(); }
});

test("native KDF callback errors/throws are sanitized and release capacity/wipe buffers", async () => {
	const calls: KdfCall[] = [];
	const returned: Buffer[] = [];
	const failing = fakeScrypt((call) => {
		calls.push(call);
		const key = Buffer.alloc(32, 0x42); returned.push(key);
		queueMicrotask(() => call.callback(new Error("native-fixture-secret"), key));
	});
	const key = Buffer.from(KEY_HEX, "hex");
	try {
		await withCryptoPatch("scrypt", failing, async () => {
			await assert.rejects(createArchiveEnvelope(PASSWORD), errorCode("CRYPTO_FAILED"));
			await assert.rejects(unlockArchiveEnvelope(fixture(), PASSWORD), errorCode("UNLOCK_FAILED"));
			await assert.rejects(rewrapArchiveEnvelope(fixture(), key, PASSWORD), errorCode("CRYPTO_FAILED"));
		});
		await withCryptoPatch("scrypt", fakeScrypt((call) => { calls.push(call); throw new Error("native-fixture-secret"); }), async () => {
			for (let i = 0; i < 3; i++) await assert.rejects(createArchiveEnvelope(PASSWORD), errorCode("CRYPTO_FAILED"));
		});
		for (const call of calls) wiped(call.password);
		for (const result of returned) wiped(result);
		assert.equal(key.toString("hex"), KEY_HEX);
	} finally { key.fill(0); }
});

test("authentication failure wipes unauthenticated partial plaintext and wrapping key", async () => {
	const mock = immediateKdf();
	const partials: Buffer[] = [];
	const original = crypto.createDecipheriv;
	const tracking = ((...args: Parameters<typeof original>) => {
		const decipher = original(...args);
		const update = decipher.update.bind(decipher);
		Object.defineProperty(decipher, "update", { value: (...updateArgs: Parameters<typeof update>) => {
			const partial = update(...updateArgs);
			if (Buffer.isBuffer(partial)) partials.push(partial);
			return partial;
		} });
		return decipher;
	}) as typeof crypto.createDecipheriv;
	await withCryptoPatch("scrypt", mock.replacement, async () => {
		await withCryptoPatch("createDecipheriv", tracking, async () => {
			const changed = fixture(); changed.passwordSlot.tag = flipped(changed.passwordSlot.tag);
			await assert.rejects(unlockArchiveEnvelope(changed, PASSWORD), errorCode("UNLOCK_FAILED"));
		});
	});
	assert.equal(partials.length, 1);
	assert.equal(partials[0].length, 32);
	wiped(partials[0]);
	mock.checkWiped();
});

test("abort immediately after successful authentication discards plaintext before returning", async () => {
	const mock = immediateKdf();
	const controller = new AbortController();
	const partials: Buffer[] = [];
	const original = crypto.createDecipheriv;
	const aborting = ((...args: Parameters<typeof original>) => {
		const decipher = original(...args);
		const update = decipher.update.bind(decipher);
		const final = decipher.final.bind(decipher);
		Object.defineProperty(decipher, "update", { value: (...updateArgs: Parameters<typeof update>) => {
			const result = update(...updateArgs); if (Buffer.isBuffer(result)) partials.push(result); return result;
		} });
		Object.defineProperty(decipher, "final", { value: () => { const result = final(); controller.abort(); return result; } });
		return decipher;
	}) as typeof crypto.createDecipheriv;
	await withCryptoPatch("scrypt", mock.replacement, async () => {
		await withCryptoPatch("createDecipheriv", aborting, async () => {
			await assert.rejects(unlockArchiveEnvelope(fixture(), PASSWORD, controller.signal), errorCode("ABORTED"));
		});
	});
	assert.equal(partials.length, 1);
	wiped(partials[0]);
	mock.checkWiped();
});
