import assert from "node:assert/strict";
import Module from "node:module";
import { after, test } from "node:test";
import type {
	ArchiveKeychainEntry,
	ArchiveKeychainEntryFactory,
	ArchiveKeychainEntryOptions,
} from "../archive-keychain.js";

// Guard BEFORE the runtime import. Even with the optional dependency installed,
// every native require in this worker is blocked or replaced by a JS-only fake.
// Never load a real binding, instantiate native Entry, or contact a user store.
const KEYRING = "@napi-rs/keyring";
type Loader = (specifier: string, ...args: unknown[]) => unknown;
const loader = Module as unknown as { _load: Loader };
const originalLoad = loader._load;
let fakeNativeLoad: ((specifier: string) => unknown) | undefined;
const nativeLoads: string[] = [];
loader._load = function (specifier, ...args) {
	if (specifier === KEYRING || specifier.startsWith(`${KEYRING}/`) || specifier.startsWith(`${KEYRING}-`)) {
		nativeLoads.push(specifier);
		if (!fakeNativeLoad) throw new Error("Real native credential access is forbidden in this test.");
		return fakeNativeLoad(specifier);
	}
	return Reflect.apply(originalLoad, this, [specifier, ...args]);
};
after(() => { loader._load = originalLoad; });
const { ARCHIVE_KEYCHAIN_SERVICE, NativeArchiveKeychain } = await import("../archive-keychain.js");

const account = "a".repeat(64);
const otherAccount = "b".repeat(64);
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const privateMarker = "fixture-private-native-details-not-real";

async function withNativeLoader(runLoad: (specifier: string) => unknown, run: () => Promise<void>): Promise<void> {
	assert.equal(fakeNativeLoad, undefined);
	fakeNativeLoad = runLoad;
	try { await run(); } finally { fakeNativeLoad = undefined; }
}

function entry(patch: Partial<ArchiveKeychainEntry> = {}): ArchiveKeychainEntry {
	return {
		async getPassword() { return undefined; },
		async setPassword() {},
		async deleteCredential() { return false; },
		...patch,
	};
}

async function safeError(operation: Promise<unknown>, message?: string): Promise<void> {
	await assert.rejects(operation, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(Object.hasOwn(error, "cause"), false);
		assert.equal(Object.hasOwn(error, "code"), false);
		assert.doesNotMatch(error.message, new RegExp(privateMarker));
		assert.doesNotMatch(error.stack ?? "", new RegExp(privateMarker));
		if (message) assert.equal(error.message, message);
		return true;
	});
}

test("runtime import and both constructors are inert, with no native credential reads", () => {
	assert.deepEqual(nativeLoads, []);
	let calls = 0;
	new NativeArchiveKeychain();
	new NativeArchiveKeychain(() => { calls++; return entry(); });
	assert.equal(calls, 0);
	assert.deepEqual(nativeLoads, []);
});

test("fake-only roundtrip uses the stable service, opaque account and Secret Service pin", async () => {
	const values = new Map<string, string>();
	const calls: { service: string; account: string; options: ArchiveKeychainEntryOptions }[] = [];
	let reads = 0, deletions = 0;
	const factory: ArchiveKeychainEntryFactory = (service, account, options) => {
		calls.push({ service, account, options });
		return entry({
			async getPassword() { reads++; return values.get(account); },
			async setPassword(value) { values.set(account, value); },
			async deleteCredential() { deletions++; return values.delete(account); },
		});
	};
	const store = new NativeArchiveKeychain(factory);
	assert.equal(await store.get(account), undefined);
	await store.set(account, key);
	assert.equal(values.get(account), key.toString("base64"));
	assert.deepEqual(await store.get(account), key);
	const returned = (await store.get(account))!;
	assert.notEqual(returned, key);
	returned.fill(0);
	assert.deepEqual(await store.get(account), key, "returned buffers do not own the stored value");
	assert.equal(await store.get(otherAccount), undefined);
	await store.set(otherAccount, Buffer.alloc(32, 255));
	const beforeDelete = reads;
	await store.delete(account);
	await store.delete(account);
	assert.equal(reads, beforeDelete, "deletion needs no racy read preflight");
	assert.equal(deletions, 2, "true and false deletion results both succeed");
	assert.equal(await store.get(account), undefined);
	assert.deepEqual(await store.get(otherAccount), Buffer.alloc(32, 255));
	assert.ok(calls.length > 0);
	for (const call of calls) {
		assert.equal(call.service, "pi-jarvis-archive");
		assert.equal(call.service, ARCHIVE_KEYCHAIN_SERVICE);
		assert.ok(call.account === account || call.account === otherAccount);
		assert.deepEqual(call.options, { linux: { store: "secret-service" } });
	}
	assert.deepEqual(key, Buffer.from(Array.from({ length: 32 }, (_, i) => i)), "input stays caller-owned");
});

test("rejects every invalid account before entry creation, including a trailing newline", async () => {
	let calls = 0;
	const store = new NativeArchiveKeychain(() => { calls++; return entry(); });
	for (const invalid of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64),
		`${account}\n`, `${account}\r`, ` ${account}`, "é".repeat(64), "/fixture/agent", "fixture-vault-uuid", null, undefined, 7]) {
		const value = invalid as string;
		await safeError(store.get(value), "Invalid archive keychain account.");
		await safeError(store.set(value, key), "Invalid archive keychain account.");
		await safeError(store.delete(value), "Invalid archive keychain account.");
	}
	assert.equal(calls, 0);
});

test("only 32-byte Buffers can be stored, never passwords or arbitrary binary inputs", async () => {
	let calls = 0;
	const store = new NativeArchiveKeychain(() => { calls++; return entry(); });
	for (const invalid of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32),
		"fixture-password-not-real", key.toString("base64"), null, undefined, { length: 32 }]) {
		await safeError(store.set(account, invalid as Buffer), "Archive keychain keys must be 32-byte Buffers.");
	}
	assert.equal(calls, 0);
});

test("set snapshots the key before calling a factory or awaiting native work", async () => {
	const input = Buffer.alloc(32, 17);
	const expected = input.toString("base64");
	let observed = "";
	const store = new NativeArchiveKeychain(() => {
		input.fill(23); // Deliberate fake-side caller mutation, not an adapter mutation.
		return entry({ async setPassword(value) { observed = value; } });
	});
	await store.set(account, input);
	assert.equal(observed, expected);
});

test("get accepts canonical 32-byte base64 only, while verified missing results stay absent", async () => {
	let response: unknown;
	const store = new NativeArchiveKeychain(() => entry({ async getPassword() { return response as string; } }));
	for (const absent of [undefined, null]) {
		response = absent;
		assert.equal(await store.get(account), undefined);
	}
	for (const valid of [key, Buffer.alloc(32), Buffer.alloc(32, 255), Buffer.alloc(32, 251)]) {
		response = valid.toString("base64");
		assert.deepEqual(await store.get(account), valid);
	}
	const encoded = Buffer.alloc(32).toString("base64");
	const noncanonicalPaddingBits = `${encoded.slice(0, 42)}B=`;
	assert.deepEqual(Buffer.from(noncanonicalPaddingBits, "base64"), Buffer.alloc(32));
	for (const invalid of ["", "fixture-password-not-real", encoded.slice(0, -1), `${encoded}=`,
		` ${encoded}`, `${encoded} `, `${encoded}\n`, `${encoded}\r\n`, encoded.replace(/A/, " "),
		Buffer.alloc(32, 255).toString("base64").replaceAll("/", "_"),
		Buffer.alloc(32, 251).toString("base64").replaceAll("+", "-"),
		Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"),
		noncanonicalPaddingBits, true, 0, key, [], { toString() { throw new Error(privateMarker); } }]) {
		response = invalid;
		await safeError(store.get(account), "Invalid remembered archive key in the OS credential store.");
	}
});

test("all synchronous factory errors are sanitized without inspecting thrown details", async () => {
	const nativeError = Object.assign(new Error(privateMarker, { cause: new Error(privateMarker) }), { code: privateMarker });
	let inspected = false;
	const hostile = { get message() { inspected = true; throw new Error(privateMarker); } };
	for (const thrown of [nativeError, hostile, privateMarker, null, undefined]) {
		const store = new NativeArchiveKeychain(() => { throw thrown; });
		await safeError(store.get(account), "Could not read the remembered archive key from the OS credential store.");
		await safeError(store.set(account, key), "Could not remember the archive key in the OS credential store.");
		await safeError(store.delete(account), "Could not delete the remembered archive key from the OS credential store.");
	}
	assert.equal(inspected, false);
});

test("native method throws/rejections fail closed, even errors claiming the entry is absent", async () => {
	for (const rejectAsync of [false, true]) {
		for (const fault of [new Error(privateMarker), Object.assign(new Error("NoEntry"), { code: "NoEntry" }), privateMarker]) {
			const fail = () => { if (rejectAsync) return Promise.reject(fault); throw fault; };
			const store = new NativeArchiveKeychain(() => entry({ getPassword: fail, setPassword: fail, deleteCredential: fail }));
			await safeError(store.get(account));
			await safeError(store.set(account, key));
			await safeError(store.delete(account));
		}
	}
});

test("deletion only accepts the API's boolean success/absent values", async () => {
	for (const invalid of [undefined, null, 0, 1, "false", "true", {}]) {
		const store = new NativeArchiveKeychain(() => entry({ async deleteCredential() { return invalid as boolean; } }));
		await safeError(store.delete(account), "Invalid archive key deletion response from the OS credential store.");
	}
});

test("default factory lazy-requires the verified version and passes options to a JS-only fake AsyncEntry", async () => {
	const constructed: { service: string; account: string; options: ArchiveKeychainEntryOptions }[] = [];
	const values = new Map<string, string>();
	class FakeAsyncEntry implements ArchiveKeychainEntry {
		constructor(service: string, private account: string, options: ArchiveKeychainEntryOptions) {
			constructed.push({ service, account, options });
		}
		async getPassword() { return values.get(this.account) ?? null; }
		async setPassword(value: string) { values.set(this.account, value); }
		async deleteCredential() { return values.delete(this.account); }
	}
	const loads: string[] = [];
	await withNativeLoader((specifier) => {
		loads.push(specifier);
		if (specifier === `${KEYRING}/package.json`) return { version: "2.1.0" };
		assert.equal(specifier, KEYRING);
		return { AsyncEntry: FakeAsyncEntry };
	}, async () => {
		const store = new NativeArchiveKeychain();
		assert.deepEqual(loads, []);
		assert.equal(await store.get(account), undefined);
		await store.set(account, key);
		assert.deepEqual(await store.get(account), key);
		await store.delete(account);
		await store.delete(account);
	});
	assert.deepEqual(loads, Array.from({ length: 5 }, () => [`${KEYRING}/package.json`, KEYRING]).flat());
	assert.equal(constructed.length, 5);
	for (const value of constructed) assert.deepEqual(value, {
		service: "pi-jarvis-archive", account, options: { linux: { store: "secret-service" } },
	});
});

test("default factory never loads native code for invalid requests or unsupported operating systems", async () => {
	const loads: string[] = [];
	await withNativeLoader((specifier) => { loads.push(specifier); throw new Error(privateMarker); }, async () => {
		const store = new NativeArchiveKeychain();
		await safeError(store.get("invalid-account"));
		await safeError(store.set(account, Buffer.alloc(31)));
		await safeError(store.delete("invalid-account"));
		assert.deepEqual(loads, []);
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
		try {
			Object.defineProperty(process, "platform", { ...descriptor, value: "freebsd" });
			await safeError(store.get(account));
			await safeError(store.set(account, key));
			await safeError(store.delete(account));
			assert.deepEqual(loads, []);
		} finally { Object.defineProperty(process, "platform", descriptor); }
	});
});

test("missing dependency, binding or constructor never reaches real native code and fails closed", async () => {
	for (const failedSpecifier of [`${KEYRING}/package.json`, KEYRING]) {
		await withNativeLoader((specifier) => {
			if (specifier === failedSpecifier) throw new Error(privateMarker, { cause: new Error(privateMarker) });
			return { version: "2.1.0" };
		}, async () => {
			const store = new NativeArchiveKeychain();
			await safeError(store.get(account));
			await safeError(store.set(account, key));
			await safeError(store.delete(account));
		});
	}
	for (const binding of [undefined, null, {}, { AsyncEntry: 1 }, { AsyncEntry: class { constructor() { throw new Error(privateMarker); } } }]) {
		await withNativeLoader((specifier) => specifier === `${KEYRING}/package.json` ? { version: "2.1.0" } : binding,
			async () => { await safeError(new NativeArchiveKeychain().get(account)); });
	}
});

test("unverified package versions are rejected BEFORE loading their binding (no older fallback API)", async () => {
	for (const manifest of [null, undefined, {}, { version: "1.3.0" }, { version: "2.0.0" },
		{ version: "2.2.0" }, { version: 2.1 }]) {
		const loads: string[] = [];
		await withNativeLoader((specifier) => {
			loads.push(specifier);
			assert.equal(specifier, `${KEYRING}/package.json`);
			return manifest;
		}, async () => { await safeError(new NativeArchiveKeychain().get(account)); });
		assert.deepEqual(loads, [`${KEYRING}/package.json`]);
	}
});
