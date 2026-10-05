import { randomBytes } from "node:crypto";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input, Key, decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth,
	type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";

export const MAX_ARCHIVE_SECRET_BYTES = 4096;
const REJECTION = "Secret input rejected. Use a non-empty single line of at most 4096 UTF-8 bytes.";
const PASTE_START = "\x1b[200~", PASTE_END = "\x1b[201~";
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const CHALLENGE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols; no I/O/0/1.
const CHALLENGE_LENGTH = 12; // 60 independent random bits, generated only after an intent.
const VERIFICATION_REJECTION = "Verification rejected. Enter requests a fresh code; Escape requests cancel.";
const MODE_WARNING = "Archive password input requires regular TUI mode. Restart with pi --tui-mode regular.";
const RNG_FAILURE = "Verification unavailable. Prompt remains open; Enter retries, Escape requests cancel.";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function newChallenge(): string {
	const bytes = randomBytes(CHALLENGE_LENGTH);
	try { return Array.from(bytes, (byte) => CHALLENGE_ALPHABET[byte & 31]).join(""); }
	finally { bytes.fill(0); }
}
// Main and Jarvis callers share this module; only one owned prompt may be active.
type PromptOwner = { revoke(): void; abandon(): void };
let activePrompt: PromptOwner | undefined;

/** Includes cancelled input sinks and pending public custom lifecycles. */
export function isArchiveSecretPromptActive(): boolean { return activePrompt !== undefined; }
/** Ordinary policy/session revocation: immediate result cancellation, NOT input release. */
export function revokeArchiveSecretPrompt(): void { activePrompt?.revoke(); }
/**
 * OWNER ONLY: host already ending/forcibly replaced. Never invokes custom done or
 * restores an editor. Quarantine cannot outlive lost host ownership. Do not use
 * this for ordinary policy cancellation or wait for an unfocused sink at shutdown.
 */
export function abandonArchiveSecretPrompt(): void { activePrompt?.abandon(); }

function validText(text: string): boolean {
	if (UNSAFE.test(text) || Buffer.byteLength(text, "utf8") > MAX_ARCHIVE_SECRET_BYTES) return false;
	// Reject ill-formed UTF-16 rather than silently UTF-8-encoding replacement characters.
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp >= 0xd800 && cp <= 0xdfff) return false;
	}
	return true;
}

function delimiterTail(text: string, delimiter: string): number {
	for (let size = Math.min(text.length, delimiter.length - 1); size > 0; size--) {
		if (text.endsWith(delimiter.slice(0, size))) return size;
	}
	return 0;
}

function printable(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	// Pi 1.0.2 does not root-export decodePrintableKey; support xterm's plain/Shift packets.
	const xterm = /^\x1b\[27;[12];(\d+)~$/.exec(data);
	if (!xterm) return undefined;
	const cp = Number(xterm[1]);
	return cp >= 32 && cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined;
}

/**
 * One interaction, with no history, undo, kill ring, clipboard, or change callbacks.
 * Public Input receives ONLY masks: it has no masking hook and retains undo/kill-ring
 * values, so using it to edit actual secrets would be inappropriate. Clearing owned
 * references on completion is not forensic zeroization of JavaScript strings.
 * EVERY keyboard completion requires a fresh displayed challenge generated AFTER
 * the intent, even before framing (the host may buffer a whole paste/initial ESC).
 * Terminal APIs cannot distinguish arbitrarily delayed forged paste tails from
 * typing; there is deliberately no timing heuristic.
 * Verification responses may themselves be secret tails: never echo or send them to
 * Input/history. This is a probabilistic clipboard boundary, not protection against
 * trusted input injectors/extensions with screen access. cancel() revokes results
 * but holds a cancel-only sink; dispose() means forced host ownership loss, no done.
 */
export class ArchiveSecretInput implements Component, Focusable {
	private secret = "";
	private cursor = 0; // UTF-16 offset at a grapheme boundary, never terminal columns.
	private ended = false;
	private hasFocus = false;
	private error = "";
	private readonly title: string;
	private onDone?: (value: string | undefined) => void;
	private inPaste = false;
	private startTail = "";
	private pasteTail = "";
	private pasteBuffer = "";
	private pasteRejected = false;
	private intent?: "submit" | "cancel";
	private challenge = "";
	private response = "";
	private responseInvalid = false;
	private cancelled = false;
	private verificationGeneration = 0;
	private onRevoke?: () => void;
	private onDispose?: () => void;
	private readonly challengeForTest?: () => string;

	constructor(
		private readonly tui: Pick<TUI, "terminal" | "requestRender">,
		private readonly theme: Pick<Theme, "fg">,
		private readonly keybindings: Pick<KeybindingsManager, "matches">,
		title: string,
		onDone: (value: string | undefined) => void,
		// Only challengeForTest is a test seam; production never supplies RNG overrides.
		options: { challengeForTest?: () => string; onRevoke?: () => void; onDispose?: () => void } = {},
	) {
		this.title = Array.from(title.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "")).slice(0, 256).join("");
		this.onDone = onDone;
		this.challengeForTest = options.challengeForTest;
		this.onRevoke = options.onRevoke;
		this.onDispose = options.onDispose;
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = !this.ended && value; }

	handleInput(data: string): void {
		if (this.ended || !data || this.handlePasteInput(data)) return;
		// Do not let the public release helper misclassify literal text such as ':3u'.
		if (data.startsWith("\x1b[") && isKeyRelease(data)) return;
		const kb = this.keybindings;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || kb.matches(data, "tui.select.cancel")) {
			this.beginVerification("cancel");
			return;
		}
		if (this.cancelled || this.intent) { this.handleVerification(data); return; }
		// LF and modified newline keys are never accepted as password text or submission.
		if (data === "\n" || kb.matches(data, "tui.input.newLine")) {
			this.reject();
			return;
		}
		if (matchesKey(data, Key.enter) || kb.matches(data, "tui.input.submit")) {
			if (!this.secret || !validText(this.secret)) this.reject();
			else this.beginVerification("submit");
			return;
		}
		const boundaries = this.boundaries();
		const position = boundaries.indexOf(this.cursor);
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.cursor = boundaries[Math.max(0, position - 1)]!;
		} else if (kb.matches(data, "tui.editor.cursorRight")) {
			this.cursor = boundaries[Math.min(boundaries.length - 1, position + 1)]!;
		} else if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.cursor = 0;
		} else if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.cursor = this.secret.length;
		} else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.remove(boundaries[Math.max(0, position - 1)]!, this.cursor);
		} else if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.remove(this.cursor, boundaries[Math.min(boundaries.length - 1, position + 1)]!);
		} else if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.remove(0, this.cursor);
		} else if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.remove(this.cursor, this.secret.length);
		} else if ((["tui.editor.undo", "tui.editor.yank", "tui.editor.yankPop", "tui.input.copy",
			"tui.editor.historyPrevious", "tui.editor.historyNext", "tui.editor.cursorUp", "tui.editor.cursorDown"] as const)
			.some((action) => kb.matches(data, action))) {
			// Deliberately no recall, undo, copy, or yank of secret material.
			return;
		} else {
			this.insert(printable(data) ?? data);
			return;
		}
		this.invalidate();
	}

	private beginVerification(intent: "submit" | "cancel"): void {
		// Clear the old code BEFORE asking the RNG. Failure must never leave it usable.
		if (this.ended) return;
		const generation = ++this.verificationGeneration;
		this.intent = this.cancelled ? "cancel" : intent;
		this.challenge = this.response = "";
		this.responseInvalid = false;
		this.error = "";
		try {
			const code = (this.challengeForTest ?? newChallenge)();
			if (typeof code !== "string" || code.length !== CHALLENGE_LENGTH ||
				Array.from(code).some((ch) => !CHALLENGE_ALPHABET.includes(ch))) throw new Error();
			// RNG/host callbacks may reenter revoke/dispose. Never reinstall stale authority.
			if (!this.ended && generation === this.verificationGeneration) this.challenge = code;
		} catch {
			// No fallback, arbitrary RNG error text, completion, or leaked input.
			if (!this.ended && generation === this.verificationGeneration) this.error = RNG_FAILURE;
		}
		this.invalidate();
	}

	private handleVerification(data: string): void {
		const kb = this.keybindings;
		if (matchesKey(data, Key.enter) || kb.matches(data, "tui.input.submit")) {
			if (this.challenge && !this.responseInvalid && this.response === this.challenge) {
				this.finish(!this.cancelled && this.intent === "submit" ? this.secret : undefined);
			} else this.beginVerification(this.intent ?? "cancel"); // Each attempt needs a new post-intent code.
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.response = "";
			this.responseInvalid = false;
		} else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.response = this.response.slice(0, -1);
		} else {
			const text = printable(data) ?? data;
			// Accept the displayed grouping spaces, but keep no whitespace or unknown tails.
			// No sliding-window/suffix matching: an overlong/unknown response poisons the attempt.
			if (text.length > CHALLENGE_LENGTH + 2 || !/^[A-HJ-NP-Z2-9a-hj-np-z ]+$/.test(text)) {
				this.response = "";
				this.responseInvalid = true;
			} else if (!this.responseInvalid) {
				const candidate = this.response + text.replace(/ /g, "").toUpperCase();
				if (candidate.length > CHALLENGE_LENGTH) {
					this.response = "";
					this.responseInvalid = true;
				} else this.response = candidate;
			}
		}
		// Do not render response content OR its length; it may be a secret paste tail.
		this.invalidate();
	}

	/** Always route paste framing/content before ANY completion/cancel keys. */
	private handlePasteInput(data: string): boolean {
		if (!this.inPaste) {
			const pending = Boolean(this.startTail);
			const packet = this.startTail + data;
			const start = packet.indexOf(PASTE_START);
			const end = packet.indexOf(PASTE_END);
			const tail = Math.max(delimiterTail(packet, PASTE_START), delimiterTail(packet, PASTE_END));
			// A standalone Escape is a key, with no ambiguity timer. Partial framing of
			// two or more bytes and orphan END markers are conservatively drained too.
			if (start < 0 && end < 0 && !pending && tail <= 1) return false;
			if (this.intent) { this.response = ""; this.responseInvalid = true; }
			this.startTail = "";
			if (start < 0 || (end >= 0 && end < start)) {
				if (tail > 1) this.startTail = packet.slice(-tail);
				else { this.resetPaste(); this.reject(); }
				return true; // Never replay a malformed framing packet as keys.
			}
			this.inPaste = true;
			data = packet.slice(start + PASTE_START.length); // Drop ambiguous keyboard prefixes.
		}
		const packet = this.pasteTail + data;
		this.pasteTail = "";
		const end = packet.indexOf(PASTE_END);
		if (end < 0) {
			const tail = delimiterTail(packet, PASTE_END);
			this.pasteTail = tail ? packet.slice(-tail) : "";
			this.appendPaste(packet.slice(0, packet.length - tail));
			return true;
		}
		this.appendPaste(packet.slice(0, end));
		const text = this.pasteBuffer, rejected = this.pasteRejected;
		this.resetPaste();
		if (!rejected && !this.cancelled && !this.intent) this.insert(text);
		// Everything attached after the terminator is consumed, including Enter/approval.
		return true;
	}

	private appendPaste(text: string): void {
		if (this.pasteRejected || this.cancelled || this.intent) return; // Verification never buffers/accepts paste text.
		if (UNSAFE.test(text) || this.pasteBuffer.length + text.length > MAX_ARCHIVE_SECRET_BYTES) {
			this.pasteRejected = true;
		} else {
			const candidate = this.pasteBuffer + text;
			if (Buffer.byteLength(this.secret, "utf8") + Buffer.byteLength(candidate, "utf8") > MAX_ARCHIVE_SECRET_BYTES) {
				this.pasteRejected = true;
			} else {
				this.pasteBuffer = candidate;
			}
		}
		if (this.pasteRejected) { this.pasteBuffer = ""; this.reject(); }
	}

	private insert(text: string): void {
		if (this.cancelled || !text) return;
		if (text.length > MAX_ARCHIVE_SECRET_BYTES || !validText(text) ||
			Buffer.byteLength(this.secret, "utf8") + Buffer.byteLength(text, "utf8") > MAX_ARCHIVE_SECRET_BYTES) {
			this.reject();
			return;
		}
		const end = this.cursor + text.length;
		this.secret = this.secret.slice(0, this.cursor) + text + this.secret.slice(this.cursor);
		// An inserted combining character/ZWJ may merge neighboring graphemes.
		this.cursor = this.boundaries().find((boundary) => boundary >= end) ?? this.secret.length;
		this.error = "";
		this.invalidate();
	}

	private boundaries(): number[] {
		return [...Array.from(segmenter.segment(this.secret), (part) => part.index), this.secret.length];
	}

	private remove(start: number, end: number): void {
		this.secret = this.secret.slice(0, start) + this.secret.slice(end);
		this.cursor = this.boundaries().find((boundary) => boundary >= start) ?? this.secret.length;
		this.error = "";
	}

	render(width: number): string[] {
		width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		const rows = Math.max(0, Math.floor(this.tui.terminal.rows));
		if (this.ended || !width || !rows) return [];
		if (this.cancelled || this.intent) {
			// Empty public Input is solely a cursor renderer, never a verification editor.
			const input = new Input({ prompt: "" });
			input.focused = this.focused;
			const [cursor = ""] = input.render(rows === 1 ? 1 : width);
			const grouped = this.challenge.match(/.{4}/g)?.join(" ") ?? "";
			const code = truncateToWidth(this.theme.fg("accent", grouped || "Verification unavailable."), width, "");
			const hint = truncateToWidth(this.theme.fg(this.error ? "error" : "muted", this.error ||
				`${this.cancelled ? "Operation cancelled. To resume" : `To ${this.intent}`}: type code + Enter (not pasted; input hidden). Escape: new cancel code.`), width, "");
			if (rows === 1) return [truncateToWidth(code, width - 1, "") + cursor];
			if (rows === 2) return [code, cursor];
			if (rows === 3) return [code, cursor, hint];
			return [truncateToWidth(this.theme.fg("accent", this.title), width, ""), code, cursor, hint];
		}
		const boundaries = this.boundaries();
		const input = new Input({ prompt: "" });
		// Use public APIs only, with an ASCII mask mirror. Its undo entries also contain
		// masks only. Synthetic paste sets the mirror cursor independent of key remaps.
		input.handleInput(PASTE_START + "*".repeat(boundaries.indexOf(this.cursor)) + PASTE_END);
		input.setValue("*".repeat(boundaries.length - 1));
		input.focused = this.focused;
		const [mask = ""] = input.render(width);
		const header = truncateToWidth(this.theme.fg("accent", this.title), width, "");
		const hint = truncateToWidth(this.theme.fg(this.error ? "error" : "muted",
			this.error || "Enter/Escape: request submit/cancel code · input is masked"), width, "");
		// Keep the mask and IME cursor even in a one-row, one-column viewport.
		return rows === 1 ? [mask] : rows === 2 ? [mask, hint] : [header, mask, hint];
	}

	invalidate(): void {
		if (!this.ended) {
			try { this.tui.requestRender(); } catch { /* No arbitrary host error output. Hold closed. */ }
		}
	}
	/** Operation revocation. Immediate wipe/result cancellation, NEVER custom done. */
	cancel(): void {
		if (this.ended || this.cancelled) return;
		this.cancelled = true;
		this.clearOwned();
		const revoke = this.onRevoke;
		this.onRevoke = undefined;
		try { revoke?.(); } catch { /* Owned result callback cannot downgrade the sink. */ }
		this.beginVerification("cancel"); // Always fresh POST-abort, including pre-paste abort.
	}
	/** Forced host disposal/ownership loss. Wipe/revoke but NEVER invoke stale done. */
	dispose(): void {
		if (this.ended) return;
		this.ended = true;
		this.hasFocus = false;
		this.clearOwned();
		const revoke = this.onRevoke, disposed = this.onDispose;
		this.onDone = this.onRevoke = this.onDispose = undefined;
		try { revoke?.(); } catch { /* No arbitrary callback error output. */ }
		try { disposed?.(); } catch { /* Host ownership is already lost; never call done. */ }
	}

	private reject(): void { this.error = this.intent ? VERIFICATION_REJECTION : REJECTION; this.invalidate(); }
	private resetPaste(): void {
		this.inPaste = false;
		this.startTail = this.pasteTail = this.pasteBuffer = "";
		this.pasteRejected = false;
	}
	private clearOwned(): void {
		++this.verificationGeneration;
		this.secret = "";
		this.cursor = 0;
		this.error = "";
		this.intent = undefined;
		this.challenge = this.response = "";
		this.responseInvalid = false;
		this.resetPaste();
	}
	private finish(value: string | undefined): void {
		if (this.ended) return;
		this.ended = true;
		this.hasFocus = false;
		this.clearOwned();
		const done = this.onDone;
		this.onDone = this.onRevoke = this.onDispose = undefined;
		done?.(this.cancelled ? undefined : value);
	}
}

/**
 * Regular-renderer TUI ONLY, editor-area custom UI (NOT an overlay). Checks the
 * injected public host.mode BEFORE creating/mounting any secret input. Fullscreen
 * has pre-component focus-stealing search; unknown/fullscreen must fail closed.
 * Optional prepare runs AFTER synchronous reservation and BEFORE custom UI request;
 * callers close/suspend Jarvis there, refusing already-open ordinary dialogs. The
 * same owner spans preparation, deferred factory/mount and the entire UI lifetime.
 * Callers MUST retain custom input ownership.
 * EVERY input submit/cancel requires a fresh 60-bit post-intent code typed + Enter.
 * Tiny views can clip codes: resize. No timing barrier proves all tails have arrived.
 *
 * Abort/revoke settles the operation result undefined immediately and wipes owned
 * refs, but keeps a CANCEL-ONLY sink and busy gate until a POST-abort code releases
 * the public custom lifecycle. No password may escape that sink. Result and UI
 * completion are separate promises. Forced host disposal/reload/quit or trusted
 * focus replacement cannot preserve quarantine: abandon (owner only), never call
 * stale done/restore editor or deadlock shutdown awaiting an unfocused UI. Owners
 * must block cancellable session switches/forks/tree changes while this UI is active.
 * Reload resets host UI before extension hooks: that forced path is unsupported.
 * No after-human-completion/parent-shell tail guarantee or forensic JS erasure.
 *
 * Undefined means unavailable/busy/cancelled. No ordinary input/RPC/Editor/chat or
 * CLI fallback, settings changes or private hooks. Trusted screen-reading/input
 * injecting extensions are outside this boundary. Backend revalidates live policy.
 */
export function promptArchiveSecret(
	ctx: Pick<ExtensionContext, "mode" | "ui">,
	title: string,
	signal?: AbortSignal,
	prepare?: () => void | Promise<void>,
): Promise<string | undefined> {
	if (ctx.mode !== "tui" || signal?.aborted || activePrompt) return Promise.resolve(undefined);
	let component: ArchiveSecretInput | undefined;
	let uiEnded = false, closeRequested = false, factoryUsed = false, revoked = false, completed = false;
	let value: string | undefined;
	let resolveResult: ((value: string | undefined) => void) | undefined;
	const result = new Promise<string | undefined>((resolve) => { resolveResult = resolve; });
	const settle = (secret?: string) => {
		const resolve = resolveResult;
		resolveResult = undefined;
		resolve?.(secret);
	};
	const release = () => {
		if (uiEnded) return;
		uiEnded = true; // Invalidate all callbacks BEFORE disposal/reentrant host activity.
		try { signal?.removeEventListener("abort", onAbort); } catch { /* Continue wiping/releasing owned refs. */ }
		const owned = component;
		component = undefined;
		value = undefined;
		if (activePrompt === owner) activePrompt = undefined;
		owned?.dispose(); // Never custom done; host ownership is finished/lost.
	};
	const owner: PromptOwner = {
		revoke() {
			if (uiEnded || revoked) return;
			revoked = true;
			value = undefined;
			// Clear component refs before result continuation, then fresh post-revoke code.
			component?.cancel();
			settle();
		},
		abandon() {
			if (uiEnded) return;
			revoked = true;
			value = undefined;
			release();
			settle();
		},
	};
	const onAbort = () => owner.revoke();
	activePrompt = owner;
	// A component's cancel callback also supports immediate result revocation before
	// it calls RNG/render. It never authorizes done or changes the UI busy lifetime.
	const onRevoke = () => { revoked = true; value = undefined; settle(); };
	const inert = (): Component & Focusable & { dispose(): void } => ({
		get focused() { return false; }, set focused(_value: boolean) {},
		render: () => [], handleInput() {}, invalidate() {}, dispose() {},
	});
	const finishLifecycle = (ok: boolean) => {
		if (uiEnded) return;
		const secret = ok && completed && !revoked && !signal?.aborted ? value : undefined;
		release();
		settle(secret);
	};
	const mount = () => {
		// Preparation can settle after forced teardown or a newer owner. Never
		// request late custom UI (even an inert factory) after losing ownership.
		if (uiEnded || activePrompt !== owner) return;
		try {
			const uiFinished = ctx.ui.custom<string | undefined>((host, theme, keybindings, done) => {
				if (uiEnded || factoryUsed || activePrompt !== owner) return inert();
				factoryUsed = true;
				let regular = false;
				try { regular = host.mode === "regular"; } catch { /* Unknown mode is unsupported. */ }
				// A public getter/notification can reenter forced teardown; no late mounting.
				if (uiEnded || activePrompt !== owner) return inert();
				if (!regular) {
					// Fixed message only; never renderer values, input or exception snippets.
					try { ctx.ui.notify(MODE_WARNING, "warning"); }
					catch { /* Refusal stays fail-closed if notifications are unavailable. */ }
					if (!uiEnded && activePrompt === owner) { closeRequested = true; done(undefined); }
					return inert(); // Host's closed-before-mount check prevents activation.
				}
				const owned = new ArchiveSecretInput(host, theme, keybindings, title, (secret) => {
					if (uiEnded || closeRequested || activePrompt !== owner) return;
					closeRequested = true;
					completed = true;
					value = revoked || signal?.aborted ? undefined : secret;
					try { done(undefined); } // Host custom promise never retains the password result.
					catch { finishLifecycle(false); } // Host completion failed/lost ownership: no retry/stale done.
				}, { onRevoke, onDispose: () => owner.abandon() });
				// Abort before a deferred factory must mount a cancellation-only sink, not
				// call done and expose bytes buffered by the host to its ordinary editor.
				component = owned;
				if (revoked || signal?.aborted) owned.cancel();
				return owned;
			}, { overlay: false });
			// No await in the result path: policy/key/KDF cancellation is prompt even if
			// this public lifecycle stays pending until the user acknowledges the sink.
			void Promise.resolve(uiFinished).then(() => finishLifecycle(true), () => finishLifecycle(false));
		} catch {
			finishLifecycle(false); // Host errors never render arbitrary error strings.
		}
	};
	try {
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) owner.revoke();
		if (!uiEnded && activePrompt === owner) {
			// No-prepare callers keep synchronous custom/factory invocation. With
			// preparation, reservation already blocks reentrant/raced admissions.
			if (prepare) void Promise.resolve(prepare()).then(mount, () => finishLifecycle(false));
			else mount();
		}
	} catch {
		// Refusal/throw before any custom request must not mount over an ordinary
		// dialog or call stale done. Release only this owner and wipe owned refs.
		finishLifecycle(false);
	}
	return result.then((secret) => signal?.aborted ? undefined : secret);
}
