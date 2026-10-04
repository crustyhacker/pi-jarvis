import assert from "node:assert/strict";
import test from "node:test";
import { extractMemoryText, sanitizeMemoryText } from "../memory-content.js";

// All credential-looking strings below are fabricated fixtures. No SDK runtime,
// network, filesystem/user data, wall clock, or real provider credentials are used.
const timestamp = 1_760_000_000_000;
function user<T>(content: T, extra: Record<string, unknown> = {}) {
	return { role: "user", content, timestamp, ...extra };
}
function assistant(content: unknown, extra: Record<string, unknown> = {}) {
	return { role: "assistant", content, stopReason: "stop", timestamp, ...extra };
}
function text(value: string) { return { type: "text", text: value }; }
function assertSafe(value: string) {
	assert.deepEqual(sanitizeMemoryText(value), { text: value, redacted: false, omitted: false });
}
function assertRedacted(input: string, secrets: string[]) {
	const result = sanitizeMemoryText(input);
	assert.equal(result.omitted, false);
	assert.equal(result.redacted, true);
	assert.ok(result.text.includes("[REDACTED]"));
	for (const secret of secrets) assert.ok(!result.text.includes(secret), `retained fixture secret ${secret}`);
	return result.text;
}

test("safe prose, indentation, multilingual text and code are not destructively rewritten", () => {
	for (const value of [
		"  Remember: prefer tabs, not spaces.\n\n\tKeep this indentation.  ",
		"日本語 中文 한국어 — مرحبا بالعالم — café — 👩‍💻 — فارسی می‌روم",
		"Use OPENAI_API_KEY from the environment; never put passwords in a repo.",
		"Use Bearer token authentication, and keep the private key on your machine.",
		"The password is required. A token identifies a parser node. The secret is not known.",
		"My password is stored in a password manager. Our passphrase is long and strong.",
		"Authorization:\nX-Api-Key: <api-key>",
		"ssh-ed25519 FABRICATED-PUBLIC-KEY fixture@example.test\n-----BEGIN CERTIFICATE-----\nFABRICATED-CERTIFICATE\n-----END CERTIFICATE-----",
		"```ts\nconst password = getPassword();\nconst apiKey = process.env.OPENAI_API_KEY;\nif (password === expected) return true;\n```",
		"api_key = os.getenv(\"OPENAI_API_KEY\")\ntoken = os.environ['ACCESS_TOKEN']",
		"api_key=<your-api-key>\npassword=\"<password>\"\ntoken=${ACCESS_TOKEN}\nsecret=***",
		"curl -H \"Authorization: Bearer <token>\" https://example.test",
		"Authorization: Bearer ${TOKEN}\nX-Api-Key: YOUR_API_KEY",
		'{"password": "<password>", "api_key": "YOUR_API_KEY", "token": "[REDACTED]"}',
	]) assertSafe(value);
});

test("redacts common assignment names without discarding unrelated facts", () => {
	for (const name of [
		"password", "passwd", "pwd", "passphrase", "DATABASE_PASSWORD", "apiKey", "api_key", "api-key",
		"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID",
		"access_token", "refreshToken", "client_secret", "private_key", "session-token", "token", "secret",
	]) {
		const output = assertRedacted(`Preference: use TypeScript.\n${name} = "synthetic-credential-${name}"\nKeep tests local.`, [`synthetic-credential-${name}`]);
		assert.ok(output.startsWith("Preference: use TypeScript.\n"));
		assert.ok(output.endsWith("\nKeep tests local."));
		assert.ok(output.includes(`${name} = "[REDACTED]"`));
	}
	const output = assertRedacted('{"password":"fixture-pass", "client_secret":"fixture-secret"}', ["fixture-pass", "fixture-secret"]);
	assert.deepEqual(JSON.parse(output), { password: "[REDACTED]", client_secret: "[REDACTED]" });
});

test("redacts HTTP auth/cookie headers, inline curl headers and header JSON", () => {
	for (const input of [
		"Authorization: Bearer fixture-auth-token\nRemember short replies.",
		"The copied header contains Bearer fixture-auth-token. Remember short replies.",
		"Proxy-Authorization: Basic Zml4dHVyZTpub3QtYS1zZWNyZXQ=\nRemember short replies.",
		"Authorization: Digest username=fixture, response=fixture-auth-token\nRemember short replies.",
		"Cookie: sessionid=fixture-auth-token; theme=dark\nRemember short replies.",
		"Set-Cookie: sessionid=fixture-auth-token; HttpOnly\nRemember short replies.",
		"X-Api-Key: fixture-auth-token\nRemember short replies.",
		'curl -H "Authorization: Bearer fixture-auth-token" https://example.test',
		'{"authorization":"Bearer fixture-auth-token"}',
	]) {
		const output = assertRedacted(input, ["fixture-auth-token", "Zml4dHVyZTpub3QtYS1zZWNyZXQ="]);
		if (input.includes("Remember")) assert.ok(output.endsWith("Remember short replies."));
	}
	assert.equal(sanitizeMemoryText("Bearer fixture-auth-token. Keep local tests.").text, "Bearer [REDACTED]. Keep local tests.");
});

test("redacts password phrases, CLI flags and URL passwords", () => {
	for (const input of [
		"My password is fixture-password. Remember my editor preference.",
		"Our passphrase was 'fixture-password'.",
		"fixture-client --password fixture-password --token=fixture-token",
		"fixture-client --api-key='fixture-password'",
		"Endpoint: postgres://fixture-user:fixture-password@example.test/database",
	]) assertRedacted(input, ["fixture-password", "fixture-token"]);
	assertSafe("Endpoint: postgres://fixture-user:${PASSWORD}@example.test/database");
});

test("redacts fabricated JWT and common provider key formats without relying on labels", () => {
	const jwt = `${Buffer.from('{"alg":"fixture"}').toString("base64url")}.${Buffer.from('{"sub":"fixture"}').toString("base64url")}.fixture_signature`;
	for (const fixture of [
		`sk-${"F".repeat(24)}`, `sk-proj-${"F".repeat(24)}`, `sk-ant-api03-${"F".repeat(24)}`,
		`sk-svcacct-${"F".repeat(24)}`, `AIza${"F".repeat(35)}`, `ghp_${"F".repeat(36)}`,
		`github_pat_${"F".repeat(40)}`, `xoxb-0000000000-${"F".repeat(20)}`,
		`AKIA${"F".repeat(16)}`, `ASIA${"F".repeat(16)}`, `hf_${"F".repeat(30)}`,
		`gsk_${"F".repeat(30)}`, `npm_${"F".repeat(30)}`, `sk_live_${"F".repeat(30)}`,
		`rk_test_${"F".repeat(30)}`, `SG.${"F".repeat(20)}.${"F".repeat(30)}`, `pplx-${"F".repeat(30)}`, `xai-${"F".repeat(30)}`, jwt,
	]) {
		const output = assertRedacted(`Keep local tests. Pasted value: ${fixture}\nUse TypeScript.`, [fixture]);
		assert.equal(output, "Keep local tests. Pasted value: [REDACTED]\nUse TypeScript.");
	}
});

test("drops whole private-key captures, including truncated and escaped PEM blocks", () => {
	for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "OPENSSH PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
		for (const input of [
			`Remember this.\n-----BEGIN ${label}-----\nFABRICATED-NOT-A-KEY\n-----END ${label}-----\nRemember that.`,
			`-----BEGIN ${label}-----\nFABRICATED-TRUNCATED`,
			`{"private_key":"-----BEGIN ${label}-----\\nFABRICATED\\n-----END ${label}-----"}`,
		]) assert.deepEqual(sanitizeMemoryText(input), { text: "", redacted: true, omitted: true });
	}
});

test("drops recognizable credential dumps/auth documents rather than remembering partial facts", () => {
	for (const input of [
		"[default]\naws_access_key_id=fixture-access\naws_secret_access_key=fixture-secret",
		"[profile fixture]\naws_session_token=fixture-session",
		'{"type":"service_account", "private_key_id":"fixture-id", "client_email":"fixture@example.test"}',
		'{"access_token":"fixture-access", "refresh_token":"fixture-refresh", "expires_in":3600}',
		"Credentials:\nusername=fixture\npassword=fixture-password\nRemember Python.",
		"# Secrets:\nAPI_KEY=fixture-api-key",
		"BEGIN_CREDENTIALS\npassword=fixture-password\nEND_CREDENTIALS",
		"BEGIN_CREDENTIALS\nOPAQUE-FIXTURE\nEND_CREDENTIALS",
	]) assert.deepEqual(sanitizeMemoryText(input), { text: "", redacted: true, omitted: true });
	assertSafe('{"access_token":"<access-token>", "refresh_token":"<refresh-token>"}');
	assertSafe("[default]\nregion=fixture-region");
});

test("strips ANSI, bracketed-paste markers, CR/C0/C1 and misleading bidi controls", () => {
	const input = "\x1b[200~\x1b[31mHello\x1b[0m\r\n\tworld\rnext\x00\x07\x08\x0b\x0c\x7f\x85\u202e!\u2066\x1b[201~";
	assert.deepEqual(sanitizeMemoryText(input), { text: "Hello\n\tworld\nnext!", redacted: false, omitted: false });
	assert.equal(sanitizeMemoryText("A\x1b(BB\x1b7C\x9b32mD\x9b0m").text, "ABCD");
	for (let control = 0; control <= 0x9f; control++) {
		if (control === 9 || control === 10 || control === 13 || (control >= 0x20 && control < 0x7f)) continue;
		const result = sanitizeMemoryText(String.fromCharCode(control));
		assert.equal(result.omitted, true, `control ${control}`);
	}
});

test("drops opaque OSC/DCS/SOS/PM/APC payloads, including C1 forms and incomplete sequences", () => {
	for (const start of ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_", "\x9d", "\x90", "\x98", "\x9e", "\x9f"]) {
		for (const end of ["\x1b\\", "\x9c"]) {
			assert.equal(sanitizeMemoryText(`Before${start}opaque-auth-fixture${end}After`).text, "BeforeAfter");
		}
		assert.equal(sanitizeMemoryText(`Before${start}unterminated-auth-fixture`).text, "Before");
	}
	assert.equal(sanitizeMemoryText("\x1b]52;c;FABRICATED-CLIPBOARD-DATA\x07Keep preferences.").text, "Keep preferences.");
	assert.equal(sanitizeMemoryText("\x1b]8;;https://example.test\x1b\\safe label\x1b]8;;\x1b\\").text, "safe label");
});

test("sanitation precedes privacy filtering, including obfuscated credential names/paste", () => {
	const input = "\x1b[200~Keep local tests.\npass\x1b[31mword\x1b[0m=fixture-password\napi\u200b_key=fixture-key\x1b[201~";
	const output = assertRedacted(input, ["fixture-password", "fixture-key"]);
	assert.equal(output, "Keep local tests.\npassword=[REDACTED]\napi_key=[REDACTED]");
	assert.deepEqual(sanitizeMemoryText("-----BEGIN RSA \x1b[0mPRIVATE KEY-----\nFABRICATED"), { text: "", redacted: true, omitted: true });
});

test("enforces UTF-8 bounds exactly for multilingual characters, never truncates a fact", () => {
	for (const value of ["abc", "é", "中文", "💡", "aé中💡\n\t"]) {
		const bytes = Buffer.byteLength(value, "utf8");
		assert.deepEqual(sanitizeMemoryText(value, bytes), { text: value, redacted: false, omitted: false });
		assert.deepEqual(sanitizeMemoryText(value, bytes - 1), { text: "", redacted: false, omitted: true });
	}
	assertSafe("💡".repeat(4096));
	assert.equal(sanitizeMemoryText("💡".repeat(4096) + "a").omitted, true);
	assertSafe("a".repeat(16_384));
	assert.deepEqual(sanitizeMemoryText("a".repeat(16_385)), { text: "", redacted: false, omitted: true });
	assertSafe("中".repeat(5461));
	assert.equal(sanitizeMemoryText("中".repeat(5462)).omitted, true);
});

test("omits empty/unsafe sizes, raw oversize even after cleanup, and redaction expansion", () => {
	for (const value of ["", "\r\n\t ", "\x1b[0m\x00", "\x1b]52;c;FABRICATED\x07"]) assert.equal(sanitizeMemoryText(value).omitted, true);
	for (const size of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(sanitizeMemoryText("fact", size).omitted, true);
	assert.deepEqual(sanitizeMemoryText("password=a", 10), { text: "", redacted: true, omitted: true });
	assert.equal(sanitizeMemoryText("\x00".repeat(16_384) + "fact").omitted, true, "do not silently retain a small fragment of an oversized capture");
	assert.equal(sanitizeMemoryText("x".repeat(1_000_000), Number.MAX_SAFE_INTEGER).omitted, true, "independent input processing cap");
	assert.equal(sanitizeMemoryText("x".repeat(20_000), 20_000).text.length, 20_000);
	assert.equal(sanitizeMemoryText(null as unknown as string).omitted, true);
});

test("best-effort is explicit: unlabelled arbitrary strings cannot all be recognized as secrets", () => {
	assertSafe("Unlabelled fixture value: arbitrary-unrecognized-format-12345");
});

test("extracts plain user/final assistant text and sanitizes before returning it", () => {
	const result = extractMemoryText(user("Preference: TypeScript.\r\npassword=fixture-password"));
	assert.deepEqual(result && { role: result.role, text: result.text }, { role: "user", text: "Preference: TypeScript.\npassword=[REDACTED]" });
	assert.match(result!.eventId, /^[a-f0-9]{64}$/);
	for (const stopReason of ["stop", "length", "toolUse"]) {
		const result = extractMemoryText(assistant([text("Final answer."), text("Use local fixtures.")], { stopReason }));
		assert.equal(result?.role, "assistant");
		assert.equal(result?.text, "Final answer.\nUse local fixtures.");
	}
});

test("only textual blocks are read: opaque thinking/images/tools/signatures/auth never enter memory", () => {
	const fail = () => { throw new Error("opaque fixture data was accessed"); };
	const blocks = [
		{ type: "thinking", get thinking() { return fail(); }, get thinkingSignature() { return fail(); } },
		{ type: "image", get data() { return fail(); } },
		{ type: "toolCall", get arguments() { return fail(); }, get thoughtSignature() { return fail(); } },
		{ type: "toolResult", get content() { return fail(); } },
		{ type: "auth", get token() { return fail(); } },
		{ type: "custom", text: "CUSTOM-FIXTURE-DO-NOT-STORE" },
		{ type: "text", text: "Visible answer.", get textSignature() { return fail(); } },
	];
	assert.equal(extractMemoryText(assistant(blocks))?.text, "Visible answer.");
	assert.equal(extractMemoryText(user([{ type: "image", data: "IMAGE-FIXTURE" }, text("Visible request.")]))?.text, "Visible request.");
	assert.equal(extractMemoryText(assistant(blocks.slice(0, -1))), undefined);
	assert.equal(extractMemoryText(user([{ type: "image", data: "IMAGE-FIXTURE" }])), undefined);
	assert.equal(extractMemoryText({ ...user("Visible request."), get auth() { return fail(); }, get id() { return fail(); } })?.text, "Visible request.");
});

test("rejects invalid roles, message wrappers, malformed content, nontext and empty outputs", () => {
	for (const value of [
		null, undefined, 0, "user request", [], {}, { role: "user" },
		{ role: "system", content: "SYSTEM-FIXTURE" }, { role: "toolResult", content: [text("TOOL-FIXTURE")] },
		{ role: "custom", content: "CUSTOM-FIXTURE" }, { role: "developer", content: "DEVELOPER-FIXTURE" },
		{ type: "message", message: user("WRAPPED-FIXTURE") },
		{ type: "message_update", ...assistant([text("STREAM-FIXTURE")]) },
		{ type: "custom_message", ...user("CUSTOM-FIXTURE") },
		user(0), user({ text: "OBJECT-FIXTURE" }), user(["STRING-BLOCK-FIXTURE"]),
		user([null]), user([{ type: "text", text: 123 }]), user([{ type: "text" }]), user(new Array(2)),
		user(""), assistant([text("\t\n\x00")]), assistant([]),
		user("-----BEGIN PRIVATE KEY-----\nFABRICATED"),
		Object.create({ role: "user", content: "INHERITED-FIXTURE" }),
	]) assert.equal(extractMemoryText(value), undefined);
});

test("rejects unfinished, aborted and failed assistant output even when text is present", () => {
	for (const stopReason of ["aborted", "error", "pending", "deferred", "unknown", undefined, null, 123]) {
		assert.equal(extractMemoryText(assistant([text("PARTIAL-FIXTURE")], { stopReason })), undefined);
	}
	assert.equal(extractMemoryText(assistant([text("FAILED-FIXTURE")], { isError: true })), undefined);
});

test("validates timestamps and uses deterministic identity when absent", () => {
	for (const value of [null, NaN, Infinity, -1, 1.1, "2026-01-01T00:00:00Z", {}, [], 8_640_000_000_000_001]) {
		assert.equal(extractMemoryText(user("Same request.", { timestamp: value })), undefined);
	}
	for (const value of [0, timestamp, 8_640_000_000_000_000, undefined]) {
		assert.ok(extractMemoryText(user("Same request.", { timestamp: value })));
	}
	const message = { role: "user", content: "No timestamp." };
	assert.equal(extractMemoryText(message)?.eventId, extractMemoryText(JSON.parse(JSON.stringify(message)))?.eventId);
	assert.notEqual(extractMemoryText(message)?.eventId, extractMemoryText({ ...message, content: "Different text." })?.eventId);
});

test("dedup is stable across clones/metadata/secret redaction; role/time/text distinguish events", () => {
	const message = user([text("Use TypeScript.")]);
	const id = extractMemoryText(message)!.eventId;
	assert.equal(extractMemoryText(message)!.eventId, id);
	assert.equal(extractMemoryText(JSON.parse(JSON.stringify(message)))!.eventId, id);
	assert.equal(extractMemoryText({ ...message, id: "mutable-id", auth: { token: "OPAQUE-FIXTURE" } })!.eventId, id);
	assert.equal(extractMemoryText(user("Use TypeScript."))!.eventId, id);
	assert.notEqual(extractMemoryText(assistant([text("Use TypeScript.")]))!.eventId, id);
	assert.notEqual(extractMemoryText({ ...message, timestamp: timestamp + 1 })!.eventId, id);
	assert.notEqual(extractMemoryText(user("Use Python."))!.eventId, id);
	assert.equal(extractMemoryText(user("password=fixture-A"))!.eventId, extractMemoryText(user("password=fixture-B"))!.eventId);
});

test("does not mutate messages or retain mutable content as event identity", () => {
	const block = Object.freeze(text("Keep local tests."));
	const message = Object.freeze(assistant(Object.freeze([block])));
	const before = JSON.stringify(message);
	const result = extractMemoryText(message)!;
	assert.equal(JSON.stringify(message), before);
	const mutable = user([text("Original preference.")]);
	const original = extractMemoryText(mutable)!;
	mutable.content[0].text = "Changed preference.";
	assert.equal(original.text, "Original preference.");
	assert.notEqual(extractMemoryText(mutable)!.eventId, original.eventId);
	assert.equal(result.text, "Keep local tests.");
});

test("rejects accessors/proxies safely without invoking data getters or serializing objects", () => {
	let calls = 0;
	const fail = () => { calls++; throw new Error("getter must not run"); };
	for (const key of ["role", "content", "timestamp", "stopReason", "type"]) {
		const message = assistant([text("Visible fixture.")]);
		Object.defineProperty(message, key, { get: fail });
		assert.equal(extractMemoryText(message), undefined);
	}
	assert.equal(extractMemoryText(user([{ type: "text", get text() { return fail(); } }])), undefined);
	assert.equal(extractMemoryText(new Proxy({}, { getOwnPropertyDescriptor: fail })), undefined);
	assert.equal(calls, 1, "only the explicit proxy descriptor trap ran; data accessors never run");
	assert.ok(extractMemoryText({ ...user("Visible fixture."), toJSON: fail }));
	assert.equal(calls, 1, "do not serialize message metadata for hashing");
});

test("bounds extraction early, including array count, total UTF-8 bytes and separators", () => {
	assert.equal(extractMemoryText(user("x".repeat(1_000_000))), undefined);
	assert.equal(extractMemoryText(assistant([text("中".repeat(5462))])), undefined);
	assert.equal(extractMemoryText(user([text("a".repeat(8192)), text("b".repeat(8192))])), undefined);
	assert.equal(extractMemoryText(user([text("a".repeat(8191)), text("b".repeat(8192))]))?.text.length, 16_384);
	const parts = Array.from({ length: 257 }, () => text("a"));
	assert.equal(extractMemoryText(user(parts)), undefined);
	assert.equal(extractMemoryText(user([{ type: "image", data: "x".repeat(1_000_000) }, text("Visible fixture.")]))?.text, "Visible fixture.");
	let reads = 0;
	const latePart = { get type() { reads++; return "text"; }, text: "Late fixture." };
	assert.equal(extractMemoryText(user([text("x".repeat(16_385)), latePart])), undefined);
	assert.equal(reads, 0);
});
