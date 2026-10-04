import { createHash } from "node:crypto";

const DEFAULT_MAX_BYTES = 16_384;
// Bound work even when a caller supplies an excessively large maxBytes.
const MAX_INPUT_BYTES = 262_144;
const MAX_CONTENT_PARTS = 256;
const REDACTED = "[REDACTED]";

export interface SanitizedMemoryText {
	text: string;
	redacted: boolean;
	omitted: boolean;
}

/** Strip terminal sequences, including their opaque payloads, in one bounded pass. */
function stripTerminalControls(input: string): string {
	const output: string[] = [];
	for (let i = 0; i < input.length;) {
		const code = input.charCodeAt(i);
		const escape = code === 0x1b;
		const next = escape ? input.charCodeAt(i + 1) : code;
		const osc = escape ? next === 0x5d : code === 0x9d;
		const stringControl = osc || (escape
			? [0x50, 0x58, 0x5e, 0x5f].includes(next)
			: [0x90, 0x98, 0x9e, 0x9f].includes(code));
		if (stringControl) {
			i += escape ? 2 : 1;
			// An unterminated OSC/DCS/etc. consumes the rest, never exposing its data.
			while (i < input.length) {
				if (input.charCodeAt(i) === 0x9c || (osc && input.charCodeAt(i) === 7)) { i++; break; }
				if (input.charCodeAt(i) === 0x1b && input[i + 1] === "\\") { i += 2; break; }
				i++;
			}
			continue;
		}
		if ((escape && next === 0x5b) || code === 0x9b) {
			i += escape ? 2 : 1;
			while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x3f) i++;
			if (i < input.length && input.charCodeAt(i) >= 0x40 && input.charCodeAt(i) <= 0x7e) i++;
			continue;
		}
		if (escape) {
			i++;
			while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
			if (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x7e) i++;
			continue;
		}
		if (code === 13) {
			output.push("\n");
			i += input.charCodeAt(i + 1) === 10 ? 2 : 1;
			continue;
		}
		// Keep tabs/newlines, and preserve multilingual joiners (U+200C/U+200D).
		if ((code < 0x20 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f)
			|| code === 0x200b || code === 0x200e || code === 0x200f
			|| (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff) {
			i++;
			continue;
		}
		output.push(input[i++]);
	}
	return output.join("");
}

// Intentionally recognizable placeholders/references, not arbitrary "safe" words.
function isExampleOrReference(value: string): boolean {
	let bare = value.trim();
	if (/^["'`]/.test(bare) && bare.at(-1) === bare[0]) bare = bare.slice(1, -1);
	bare = bare.replace(/^(?:Bearer|Basic|Token)\s+/i, "");
	return /^(?:\[REDACTED\]|<[^<>\r\n]+>|\*{3,}|\.{3}|YOUR[_-][A-Z0-9_-]+|EXAMPLE[_-][A-Z0-9_-]+|REDACTED)$/i.test(bare)
		|| /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\})$/.test(bare)
		|| /^(?:process\.env\.[A-Z_][A-Z0-9_]*|os\.environ\[["'][A-Z_][A-Z0-9_]*["']\]|(?:os\.getenv|getenv)\(["'][A-Z_][A-Z0-9_]*["']\))$/.test(bare)
		|| /^[a-z_$][\w.$]*\([\w.$]*\)$/i.test(bare);
}

const SECRET_NAME = String.raw`(?:[a-z][\w.-]{0,64}[_-])?(?:password|passwd|pwd|passphrase|api[_ -]?key|secret[_ -]?(?:access[_ -]?)?key|private[_ -]?key(?:[_ -]?id)?|access[_ -]?key(?:[_ -]?id)?|(?:access|refresh|auth|bearer|session|id)[_ -]?token|client[_ -]?secret|token|secret|authorization|proxy[_-]authorization|cookie|set[_-]cookie)`;
const SECRET_VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60|(?:os\.getenv|getenv)\(["'][A-Z_][A-Z0-9_]*["']\)|os\.environ\[["'][A-Z_][A-Z0-9_]*["']\]|\$\{[A-Z_][A-Z0-9_]*\}|<[^<>\r\n]+>|\[REDACTED\]|(?:Bearer|Basic|Token)[ \t]+(?:\$\{[A-Z_][A-Z0-9_]*\}|<[^<>\r\n]+>|\[REDACTED\]|[^\s,;\x26}\]"\x27\x60]+)|[^\s,;\x26}\]"'\x60]+)`;
function assignments(): RegExp {
	return new RegExp(String.raw`((?:["']?\b${SECRET_NAME}\b["']?)[ \t]*(?:=(?!=)|:)[ \t]*)(${SECRET_VALUE})`, "gi");
}

function isCredentialBlock(text: string): boolean {
	if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/i.test(text)
		|| /\bBEGIN[ _-]+(?:CREDENTIALS|SECRETS|PASSWORDS)\b/i.test(text)) return true;
	const secrets = [...text.matchAll(assignments())].filter((match) => !isExampleOrReference(match[2]));
	if (!secrets.length) return false;
	// Known credential-file shapes/dump labels: omit the whole capture, not a partial fact.
	return /(?:^|\n)[ \t]*\[(?:default|profile[^\]\n]*)\]/i.test(text)
		&& /\baws_(?:access_key_id|secret_access_key|session_token)\s*=/i.test(text)
		|| /["']type["']\s*:\s*["']service_account["']/i.test(text)
			&& /["'](?:private_key|private_key_id)["']\s*:/i.test(text)
		|| /(?:^|\n)[ \t]*(?:#+[ \t]*)?(?:credentials|secrets|passwords|auth(?:entication)? dump)[ \t]*:[ \t]*(?:\n|$)/i.test(text)
		|| /["']access_token["']\s*:/i.test(text) && /["']refresh_token["']\s*:/i.test(text) && secrets.length >= 2;
}

/**
 * Best-effort privacy filtering, NOT a guarantee of detecting every secret.
 * maxBytes is a UTF-8 bound on both input and output (hard processing cap: 256 KiB).
 * Oversized captures, credential blocks and empty results are omitted, never truncated.
 * `redacted` reports recognized sensitive data, not ordinary control/CRLF cleanup.
 */
export function sanitizeMemoryText(input: string, maxBytes = DEFAULT_MAX_BYTES): SanitizedMemoryText {
	const omit = (redacted = false): SanitizedMemoryText => ({ text: "", redacted, omitted: true });
	if (typeof input !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return omit();
	const limit = Math.min(maxBytes, MAX_INPUT_BYTES);
	// UTF-16 length is a cheap lower bound on UTF-8 bytes; do not scan giant strings.
	if (input.length > limit || Buffer.byteLength(input, "utf8") > limit) return omit();
	let text = stripTerminalControls(input);
	if (isCredentialBlock(text)) return omit(true);
	let redacted = false;
	const replaceValue = (value: string): string => {
		if (!value.trim() || isExampleOrReference(value)) return value;
		redacted = true;
		return /^["'`]/.test(value) && value.at(-1) === value[0] ? value[0] + REDACTED + value[0] : REDACTED;
	};
	// Whole header values include cookie/digest parameters, not just the first token.
	text = text.replace(/^([ \t]*(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)[ \t]*:[ \t]*)([^\n]*)$/gim,
		(_match, prefix: string, value: string) => prefix + replaceValue(value));
	// Inline curl/HTTP examples and JSON headers, including quoted header names.
	text = text.replace(/(\b(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic|Token)[ \t]+)([^\s"'`,;<>]+)/gi,
		(_match, prefix: string, value: string) => prefix + replaceValue(value));
	text = text.replace(assignments(), (_match, prefix: string, value: string) => prefix + replaceValue(value));
	text = text.replace(new RegExp(String.raw`(--(?:password|passwd|passphrase|api-key|access-token|token|client-secret)(?:=|[ \t]+))(${SECRET_VALUE})`, "gi"),
		(_match, prefix: string, value: string) => prefix + replaceValue(value));
	text = text.replace(/(\b(?:my|our)\s+(?:password|passphrase)\s+(?:is|was)\s+)("[^"\n]*"|'[^'\n]*'|[^\s,;.]+)/gi,
		(_match, prefix: string, value: string) => {
			// Preserve ordinary password advice; these words are not literal disclosures.
			if (/^(?:a|an|the|not|stored|kept|saved|managed|encrypted|hashed|strong|weak|long|short|secure|safe|private|correct|incorrect|required|optional|unknown|forgotten)$/i.test(value)) return prefix + value;
			return prefix + replaceValue(value);
		});
	text = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
		(match, prefix: string, user: string, password: string) => {
			if (isExampleOrReference(password)) return match;
			redacted = true;
			return `${prefix}${user}:${REDACTED}@`;
		});
	// Standalone bearer values need to look token-like, rather than normal prose.
	text = text.replace(/(\bBearer[ \t]+)([A-Za-z0-9._~+/-]{15,}[A-Za-z0-9_~+/-]={0,2})/gi,
		(_match, prefix: string, value: string) => prefix + replaceValue(value));
	// Common provider formats and JWTs. Formats evolve; unknown/unlabelled secrets may survive.
	text = text.replace(/\b(?:sk-(?:(?:proj|svcacct)-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{12,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:hf_|gsk_|pplx-|xai-)[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
		() => { redacted = true; return REDACTED; });
	if (!text.trim() || Buffer.byteLength(text, "utf8") > limit) return omit(redacted);
	return { text, redacted, omitted: false };
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// No getters, inherited content, JSON serialization of messages, or opaque metadata access.
function dataValue(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) throw new TypeError("Message accessors are not supported");
	return descriptor.value;
}

/**
 * Accept raw, finalized public message shapes, not streaming events/session wrappers.
 * Only visible text is considered; signatures, thinking, tools and attachments are ignored.
 * User finalization and capturing *new messages only* are the caller's responsibility.
 * Assistant stop/length/toolUse are finalized; pending/deferred/failed outputs are excluded.
 * Event identity uses sanitized text plus role and a validated millisecond timestamp;
 * absent timestamps use a deterministic text hash. No wall clock or mutable-object identity.
 */
export function extractMemoryText(message: unknown): { role: "user" | "assistant"; text: string; eventId: string } | undefined {
	try {
		if (!isObject(message) || dataValue(message, "type") !== undefined) return undefined;
		const role = dataValue(message, "role");
		if (role !== "user" && role !== "assistant") return undefined;
		if (role === "assistant" && !["stop", "length", "toolUse"].includes(dataValue(message, "stopReason") as string)) return undefined;
		if (dataValue(message, "isError") === true) return undefined;
		const timestamp = dataValue(message, "timestamp");
		if (timestamp !== undefined && (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)
			|| timestamp < 0 || timestamp > 8_640_000_000_000_000)) return undefined;
		const content = dataValue(message, "content");
		let raw: string;
		if (typeof content === "string") {
			raw = content;
		} else if (Array.isArray(content)) {
			const length = dataValue(content, "length") as number;
			if (length > MAX_CONTENT_PARTS) return undefined;
			const parts: string[] = [];
			let bytes = 0;
			for (let i = 0; i < length; i++) {
				const part = dataValue(content, String(i));
				if (!isObject(part)) return undefined;
				if (dataValue(part, "type") !== "text") continue;
				const text = dataValue(part, "text");
				if (typeof text !== "string" || text.length > DEFAULT_MAX_BYTES) return undefined;
				bytes += Buffer.byteLength(text, "utf8") + (parts.length ? 1 : 0);
				if (bytes > DEFAULT_MAX_BYTES) return undefined;
				parts.push(text);
			}
			raw = parts.join("\n");
		} else {
			return undefined;
		}
		const sanitized = sanitizeMemoryText(raw);
		if (sanitized.omitted) return undefined;
		const eventId = createHash("sha256").update(JSON.stringify([role, timestamp ?? null, sanitized.text])).digest("hex");
		return { role, text: sanitized.text, eventId };
	} catch {
		// Malformed/proxied external objects must not break automatic capture.
		return undefined;
	}
}
