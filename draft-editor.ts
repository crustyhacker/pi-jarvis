import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, Editor, decodeKittyPrintable, getKeybindings, isKeyRelease, matchesKey, parseKey,
	sliceByColumn, truncateToWidth, visibleWidth, type Focusable, type Keybinding, type TUI,
} from "@earendil-works/pi-tui";

export const MAX_DRAFT_BYTES = 64 * 1024;

export interface JarvisDraftEditorCallbacks {
	onSubmit: (text: string) => void;
	onChange: (text: string) => void;
	/** Without a handler, rejected text raises an explicit error instead. */
	onError?: (message: string) => void;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const EDITOR_ACTIONS: readonly Keybinding[] = [
	"tui.editor.cursorUp", "tui.editor.cursorDown", "tui.editor.historyPrevious", "tui.editor.historyNext",
	"tui.editor.cursorLeft", "tui.editor.cursorRight", "tui.editor.cursorWordLeft", "tui.editor.cursorWordRight",
	"tui.editor.cursorLineStart", "tui.editor.cursorLineEnd", "tui.editor.jumpForward", "tui.editor.jumpBackward",
	"tui.editor.pageUp", "tui.editor.pageDown", "tui.editor.deleteCharBackward", "tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward", "tui.editor.deleteWordForward", "tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd", "tui.editor.yank", "tui.editor.yankPop", "tui.editor.undo",
	"tui.input.newLine", "tui.input.submit", "tui.input.tab", "tui.input.copy",
];

// Only used for the size preflight. Actual normalization belongs to Pi's public
// setText/insertTextAtCursor APIs (CRLF/CR -> LF, tabs -> four spaces).
function normalizedBytes(text: string): number {
	return Buffer.byteLength(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "), "utf8");
}

function delimiterTail(text: string, delimiter: string): number {
	for (let size = Math.min(text.length, delimiter.length - 1); size > 0; size--) {
		if (text.endsWith(delimiter.slice(0, size))) return size;
	}
	return 0;
}

/** A content-only, bounded viewport around Pi's public multiline Editor. */
export class JarvisDraftEditor implements Focusable {
	private readonly editor: Editor;
	private disposed = false;
	private submitted = false;
	private inPaste = false;
	private pasteBuffer = "";
	private pasteTail = "";
	private pasteRejected = false;
	private pasteDiscard = false;
	private startTail = "";

	constructor(
		private readonly tui: TUI,
		theme: Theme,
		private readonly callbacks: JarvisDraftEditorCallbacks,
		initialText = "",
	) {
		this.editor = new Editor(tui, {
			borderColor: (text) => theme.fg("borderMuted", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("muted", text),
			},
		}, { paddingX: 0 });
		// Pi submits a trimmed value. Capture the full pre-submit draft in
		// dispatch instead; let Pi still own clearing and its undo lifecycle.
		this.editor.onSubmit = () => { this.submitted = true; };
		this.setText(initialText);
	}

	get focused(): boolean { return this.editor.focused; }
	set focused(value: boolean) { this.editor.focused = !this.disposed && value; }

	/** Includes all pasted text, never a display-only paste placeholder. */
	getText(): string { return this.editor.getExpandedText(); }
	/** Parent mouse handlers must not act on protocol bytes inside paste either. */
	hasPendingPaste(): boolean { return this.inPaste || Boolean(this.startTail); }

	/** Silent programmatic replacement/restore; does not publish onChange. */
	setText(text: string): void {
		if (this.disposed || !this.acceptText(text)) return;
		this.resetPaste();
		this.editor.setText(text);
		this.invalidate();
	}

	addToHistory(text: string): void {
		if (this.disposed || !this.acceptText(text)) return;
		// addToHistory itself does not normalize line endings/tabs. Normalize
		// through a temporary public Editor without changing this draft/cursor.
		const normalizer = new Editor(this.tui, {
			borderColor: (value) => value,
			selectList: { selectedPrefix: (v) => v, selectedText: (v) => v, description: (v) => v,
				scrollInfo: (v) => v, noMatch: (v) => v },
		});
		normalizer.setText(text);
		this.editor.addToHistory(normalizer.getExpandedText());
	}

	/**
	 * Route this BEFORE confirmation/global shortcuts. Returns true when the
	 * entire packet was consumed as paste framing/content, never as keys.
	 * Discard is sticky through the paste, even if confirmation later closes.
	 */
	handlePasteInput(data: string, discard = false): boolean {
		if (this.disposed || !data) return false;
		if (!this.inPaste) {
			const pendingStart = Boolean(this.startTail);
			const packet = this.startTail + data;
			const start = packet.indexOf(PASTE_START);
			const tail = delimiterTail(packet, PASTE_START);
			// A lone Escape remains an ordinary close/cancel key outside paste.
			if (start < 0 && !pendingStart && tail <= 1) return false;
			this.pasteDiscard ||= discard;
			this.startTail = "";
			if (start < 0) {
				if (tail > 1) this.startTail = packet.slice(packet.length - tail);
				else this.resetPaste(); // Consume, don't replay a malformed opener.
				return true;
			}
			this.inPaste = true;
			// No ambiguous keyboard prefix in a framing packet gets replayed.
			data = packet.slice(start + PASTE_START.length);
		} else {
			this.pasteDiscard ||= discard;
		}
		if (this.pasteDiscard) this.pasteBuffer = "";
		const packet = this.pasteTail + data;
		this.pasteTail = "";
		const end = packet.indexOf(PASTE_END);
		if (end < 0) {
			const tail = delimiterTail(packet, PASTE_END);
			this.pasteTail = packet.slice(packet.length - tail);
			if (!this.pasteDiscard) this.appendPaste(packet.slice(0, packet.length - tail));
			return true;
		}
		if (!this.pasteDiscard) this.appendPaste(packet.slice(0, end));
		const paste = this.pasteBuffer;
		const rejected = this.pasteRejected || this.pasteDiscard;
		this.resetPaste();
		// Public insertion avoids Pi marker-ID collisions with literal markers,
		// stale history, and recursively expanded IDs. Anything attached AFTER
		// the terminator is dropped, including Enter or confirmation shortcuts.
		if (!rejected) this.insertText(paste);
		return true;
	}

	/** Carry only framing across a thread reset, discarding all old paste text. */
	inheritPasteDrain(previous: JarvisDraftEditor): void {
		this.resetPaste();
		this.inPaste = previous.inPaste;
		this.startTail = previous.startTail;
		this.pasteTail = previous.pasteTail;
		this.pasteDiscard = this.inPaste || Boolean(this.startTail);
	}

	handleInput(data: string): void {
		if (this.disposed || !data || this.handlePasteInput(data)) return;
		this.dispatch(data);
	}

	/** Crops around the public cursor marker, including one-cell viewports. */
	render(width: number, maxLines: number): string[] {
		width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		maxLines = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : 0;
		if (this.disposed || !width || !maxLines) return [];
		const focused = this.focused;
		let lines: string[];
		// Obtain cursor geometry even while unfocused, then remove the marker.
		// Width >=3 avoids Pi's one-column wide-grapheme wrapping edge case.
		this.editor.focused = true;
		try { lines = this.editor.render(Math.max(3, width)).slice(1, -1); }
		finally { this.editor.focused = focused; }
		const cursor = Math.max(0, lines.findIndex((line) => line.includes(CURSOR_MARKER)));
		const start = Math.max(0, Math.min(cursor - Math.floor(maxLines / 2), lines.length - maxLines));
		return lines.slice(start, start + maxLines).map((line) => {
			const marker = line.indexOf(CURSOR_MARKER);
			if (visibleWidth(line) > width && marker >= 0) {
				const before = line.slice(0, marker);
				const beforeWidth = visibleWidth(before);
				const prefix = sliceByColumn(before, Math.max(0, beforeWidth - width + 1), width - 1, true);
				let suffix = sliceByColumn(line.slice(marker + CURSOR_MARKER.length), 0, width - visibleWidth(prefix), true);
				// A wide cursor grapheme cannot fit in one cell; retain a visible
				// cursor cell rather than dropping either the cursor or its marker.
				if (!visibleWidth(suffix)) suffix = "\x1b[7m \x1b[0m";
				line = prefix + CURSOR_MARKER + suffix;
			} else {
				line = truncateToWidth(line, width, "");
			}
			return focused ? line : line.replaceAll(CURSOR_MARKER, "");
		});
	}

	invalidate(): void {
		if (this.disposed) return;
		this.editor.invalidate();
		this.tui.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.focused = false;
		this.disposed = true;
		this.resetPaste();
		this.editor.onSubmit = undefined;
	}

	private error(message: string): false {
		if (this.callbacks.onError) this.callbacks.onError(message);
		else throw new Error(message);
		return false;
	}

	private acceptText(text: string, existingBytes = 0): boolean {
		const rejection = this.textError(text, existingBytes);
		return rejection ? this.error(rejection) : true;
	}

	private textError(text: string, existingBytes = 0): string | undefined {
		// Reject complete text operations instead of leaking printable tails of
		// ANSI/OSC/APC sequences. LF/CR/tabs are data and Pi normalizes them.
		if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) {
			return "Draft rejected: terminal control characters are not allowed.";
		}
		if (existingBytes + normalizedBytes(text) > MAX_DRAFT_BYTES) {
			return "Draft rejected: maximum size is 64 KiB. Nothing was truncated or sent.";
		}
		return undefined;
	}

	private appendPaste(text: string): void {
		if (this.pasteRejected) return;
		this.pasteBuffer += text;
		if (normalizedBytes(this.pasteBuffer) + Buffer.byteLength(this.getText(), "utf8") > MAX_DRAFT_BYTES) {
			this.pasteRejected = true;
			this.pasteBuffer = "";
			this.error("Paste rejected: draft maximum size is 64 KiB. Nothing was truncated or sent.");
		}
	}

	private resetPaste(): void {
		this.inPaste = false;
		this.pasteBuffer = this.pasteTail = this.startTail = "";
		this.pasteRejected = this.pasteDiscard = false;
	}

	private insertText(text: string): boolean {
		const before = this.getText();
		if (!this.acceptText(text, Buffer.byteLength(before, "utf8"))) return false;
		this.editor.insertTextAtCursor(text);
		this.publishChange(before);
		return true;
	}

	private dispatch(data: string): void {
		if (isKeyRelease(data)) return;
		const kb = getKeybindings();
		const action = EDITOR_ACTIONS.some((id) => kb.matches(data, id));
		const legacyNewline = data === "\x1b\r" || data === "\x1b[13;2~";
		const extraEditingKey = matchesKey(data, "shift+backspace") || matchesKey(data, "shift+delete");
		const key = parseKey(data);
		// Pi exposes a Kitty printable decoder and a protocol-independent key
		// parser. The latter also recognizes xterm modifyOtherKeys characters;
		// use its identity only for preflight, leaving actual decoding to Pi.
		const printable = decodeKittyPrintable(data) ?? (
			key === "space" || key === "shift+space" ? " " :
			key?.length === 1 ? key : key?.startsWith("shift+") && key.length === 7 ? key.slice(-1) : undefined
		);
		if (!action && !legacyNewline && !extraEditingKey && printable === undefined) {
			// Unknown escape/control packets are not text. Bulk printable input,
			// including unframed multiline text, uses Pi's normalized insertion.
			if (data.startsWith("\x1b") || (data.length === 1 && data.charCodeAt(0) < 32)) return;
			if (/[\r\n\t]/.test(data)) { this.insertText(data); return; }
		}
		const before = this.getText();
		if (printable !== undefined || (!action && !legacyNewline && !extraEditingKey)) {
			if (!this.acceptText(printable ?? data, Buffer.byteLength(before, "utf8"))) return;
		}
		if ((kb.matches(data, "tui.input.newLine") || legacyNewline || data === "\n") &&
			!this.acceptText("\n", Buffer.byteLength(before, "utf8"))) return;
		this.submitted = false;
		this.editor.handleInput(data);
		const after = this.getText();
		// Defensive guard for Pi actions such as yank/undo/history. All external
		// text is already checked; reject any unexpected expanded oversize edit.
		const rejection = this.textError(after);
		if (rejection) {
			this.editor.setText(before);
			this.invalidate();
			this.error(rejection);
			return;
		}
		const submitted = this.submitted;
		this.publishChange(before);
		if (submitted && before.trim()) this.callbacks.onSubmit(before);
	}

	private publishChange(before: string): void {
		const after = this.getText();
		if (after !== before) this.callbacks.onChange(after);
		this.invalidate();
	}
}
