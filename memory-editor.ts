import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER, Editor, Input, decodeKittyPrintable, isKeyRelease, matchesKey, parseKey,
	sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component, type Focusable, type KeybindingsManager, type TUI,
	type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { sanitizeMemoryText } from "./memory-content.js";
import { jarvisSurface } from "./overlay-layout.js";
import type { MemoryEditorBackend, MemoryEditorPage, MemoryEditorQuery, MemoryEditorScope, MemoryNoteDraft, MemoryNoteSummary } from "./memory-editor-types.js";
import type { MemoryCategory, MemoryLane, MemoryRecord } from "./memory-types.js";

const BODY_BYTES = 16 * 1024, TITLE_POINTS = 160, PAGE_SIZE = 20;
const START = "\x1b[200~", END = "\x1b[201~";
const CATEGORIES: MemoryCategory[] = ["user", "feedback", "project", "reference"];
const SCOPES: MemoryEditorScope[] = ["current", "project", "global", "all"];
const LANES: (MemoryLane | undefined)[] = [undefined, "main", "jarvis", "manual"];
type Mode = "browse" | "inspect" | "form" | "search" | "help" | "review" | "paused";
type Review = {
	kind: "save" | "delete" | "discard";
	back: Mode;
	action?: "back" | "close" | "reload";
	draft?: MemoryNoteDraft;
	expected?: MemoryRecord;
	records?: MemoryRecord[];
	scope: MemoryEditorScope;
	page: number;
	seen: Set<number>;
	geometry?: string;
	pages: number;
};

/** Human-only note editor. Rendering is cached-data-only; no host dialogs or record polling. */
export class MemoryEditorOverlay implements Component, Focusable {
	private _focused = false;
	private disposed = false;
	private paused = "";
	private epoch = 0;
	private revision = 0;
	private busy = "";
	private mutating = false;
	private notice = "";
	private needsRefresh = false;
	private unsubscribe?: () => void;
	private closeCallback?: () => void;
	private mode: Mode = "browse";
	private helpBack: Mode = "browse";
	private query: MemoryEditorQuery = { scope: "current", sort: "updated", offset: 0, limit: PAGE_SIZE };
	private page: MemoryEditorPage = { records: [], total: 0, offset: 0, nextOffset: null };
	private index = 0;
	private listTop = 0;
	private listHeight = 1;
	private browserFocus = 0;
	private record?: MemoryRecord;
	private inspectScroll = 0;
	private inspectLines = 0;
	private viewport = 1;
	private selected = new Map<string, MemoryNoteSummary>();
	private title = new Input({ prompt: "" });
	private search = new Input({ prompt: "" });
	private body: Editor;
	private expected?: MemoryRecord;
	private baseline?: MemoryNoteDraft;
	private category: MemoryCategory = "project";
	private scope: "project" | "global" = "project";
	private formFocus = 0;
	private conflict = false;
	private originalTitle?: { raw: string; shown: string };
	private originalBody?: { raw: string; shown: string };
	private review?: Review;
	private frame?: { revision: number; columns: number; rows: number; review?: Review; page?: number };
	// Framing is owned outside all inputs, and survives access invalidation as a discard-only drain.
	private inPaste = false;
	private startTail = "";
	// A legacy ESC is also the first byte of START. Only a subsequent Enter resolves back/close;
	// never use a timer or a second ESC to release the host modal's input ownership.
	private backArmed = false;
	private endTail = "";
	private pasteText = "";
	private pasteTarget?: "title" | "body" | "search";
	private pasteRejected = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly backend: MemoryEditorBackend,
		onClose: () => void,
	) {
		this.closeCallback = onClose;
		this.body = this.newBody();
		if (!this.active()) return;
		this.unsubscribe = backend.onChange?.(() => {
			if (this.disposed || this.paused || !this.active()) return;
			this.needsRefresh = true;
			this.notice = "Notes changed; R refreshes the browser. Drafts and reviewed versions are preserved.";
			this.changed();
		});
		this.refresh(); // Explicit command admission, not render-time I/O.
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = !this.disposed && value;
		if (!this._focused) this.backArmed = false; // Retain possible framing, not a stale exit gesture.
		this.frame = undefined;
		this.focusChildren();
	}

	isDirty(): boolean {
		if (!this.baseline || this.disposed || this.paused) return false;
		const draft = this.draft();
		return draft.title !== this.baseline.title || draft.text !== this.baseline.text
			|| draft.category !== this.baseline.category || draft.scope !== this.baseline.scope;
	}

	invalidateAccess(reason: string): void {
		if (this.disposed || this.paused) return;
		this.epoch++;
		this.paused = "Memory access paused. " + display(reason);
		this.mode = "paused";
		this.wipe();
		this.unsubscribe?.(); this.unsubscribe = undefined;
		this.changed();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true; this._focused = false; this.epoch++;
		this.unsubscribe?.(); this.unsubscribe = undefined;
		this.closeCallback = undefined;
		this.wipe();
		this.pasteText = this.startTail = this.endTail = ""; this.inPaste = false;
	}

	private wipe(): void {
		this.page = { records: [], total: 0, offset: 0, nextOffset: null };
		this.record = this.expected = this.baseline = this.review = undefined;
		this.originalTitle = this.originalBody = undefined;
		this.selected.clear(); this.query = { scope: "current", sort: "updated", limit: PAGE_SIZE, offset: 0 };
		this.title = new Input({ prompt: "" }); this.search = new Input({ prompt: "" });
		// Drop editors, undo stacks and kill rings rather than merely setText("").
		this.body = this.newBody();
		this.pasteText = ""; this.pasteTarget = undefined; this.pasteRejected = true; this.backArmed = false;
		this.busy = this.notice = ""; this.mutating = this.needsRefresh = this.conflict = false;
		this.frame = undefined; this.focusChildren();
	}

	private newBody(): Editor {
		const editor = new Editor(this.tui, {
			borderColor: (text) => this.theme.fg("borderMuted", text),
			selectList: { selectedPrefix: (t) => this.theme.fg("accent", t), selectedText: (t) => this.theme.fg("text", t),
				description: (t) => this.theme.fg("muted", t), scrollInfo: (t) => this.theme.fg("dim", t), noMatch: (t) => this.theme.fg("warning", t) },
		}, { paddingX: 0 });
		editor.disableSubmit = true;
		return editor;
	}

	private active(): boolean {
		if (this.disposed || this.paused) return false;
		try { this.backend.ensureActive(); return true; }
		catch { this.invalidateAccess("Reopen with a fresh command after restoring access."); return false; }
	}

	private changed(): void {
		this.revision++; this.frame = undefined; this.focusChildren();
		if (!this.disposed) this.tui.requestRender();
	}

	private focusChildren(): void {
		const editing = this.focused && !this.paused && !this.busy;
		this.title.focused = editing && this.mode === "form" && this.formFocus === 0;
		this.body.focused = editing && this.mode === "form" && this.formFocus === 1;
		this.search.focused = editing && this.mode === "search";
	}

	private async operation<T>(label: string, work: () => T | Promise<T>, done: (value: T) => void, mutation = false): Promise<void> {
		if (this.busy || !this.active()) return;
		const epoch = this.epoch;
		this.busy = label; this.mutating = mutation; this.changed();
		try {
			const result = await work();
			if (this.disposed || this.paused || epoch !== this.epoch || !this.active()) return;
			this.busy = ""; this.mutating = false; done(result);
		} catch (error) {
			if (this.disposed || this.paused || epoch !== this.epoch || !this.active()) return;
			this.busy = ""; this.mutating = false;
			this.conflict = /conflict|changed|missing|no longer|stale/i.test(error instanceof Error ? error.message : "");
			this.notice = operationError(error);
			if (this.mode === "review") { this.mode = this.review?.back ?? "browse"; this.review = undefined; }
		}
		if (!this.disposed && !this.paused && epoch === this.epoch) this.changed();
	}

	private refresh(offset = this.query.offset ?? 0): void {
		const query = { ...this.query, offset };
		void this.operation("Loading notes…", () => this.backend.list(query), (page) => {
			this.query = query; this.page = { ...page, records: page.records.map((r) => ({ ...r })) };
			this.index = Math.min(this.index, Math.max(0, page.records.length - 1)); this.listTop = 0;
			this.needsRefresh = false;
			this.notice = page.total ? "" : "No curated notes match. N creates a note; adjust filters or search.";
		});
	}

	private load(action: "inspect" | "edit" | "duplicate", id = this.page.records[this.index]?.id): void {
		if (!id) { this.notice = "Choose a note first."; this.changed(); return; }
		const scope = this.query.scope;
		void this.operation("Reading note…", () => this.backend.get(id, scope), (record) => {
			if (!record || record.kind !== "note") { this.notice = "Note no longer available. R refreshes."; return; }
			this.record = clone(record); this.inspectScroll = 0;
			if (action === "inspect") this.mode = "inspect";
			else this.startForm(action === "edit" ? record : undefined, action === "duplicate" ? record : undefined);
		});
	}

	private startForm(expected?: MemoryRecord, duplicate?: MemoryRecord): void {
		this.expected = expected ? clone(expected) : undefined;
		const source = expected ?? duplicate;
		this.title = new Input({ prompt: "" }); this.body = this.newBody();
		const title = duplicate ? copyTitle(duplicate.title) : source?.title ?? "";
		const text = source?.text ?? "";
		this.originalTitle = textError(title, "title") ? { raw: title, shown: display(title) } : undefined;
		this.originalBody = UNSAFE.test(text) ? { raw: text, shown: display(text, true) } : undefined;
		this.title.setValue(this.originalTitle?.shown ?? title); this.title.handleInput("\x05");
		this.body.setText(this.originalBody?.shown ?? text);
		this.category = source?.category ?? "project"; this.scope = source?.scope ?? "project";
		this.baseline = expected ? this.draft() : { title: "", text: "", category: this.category, scope: this.scope };
		this.formFocus = 0; this.mode = "form"; this.conflict = false;
		this.notice = this.originalTitle || this.originalBody ? "Historical controls shown as literal escapes only. Original text is unchanged until you edit that field; review any replacement before saving."
			: duplicate ? "Duplicate is create-only. Choose a distinct title; origin for the new note is manual." : "";
	}

	private draft(): MemoryNoteDraft {
		const title = this.title.getValue(), text = this.body.getExpandedText();
		return { title: this.originalTitle?.shown === title ? this.originalTitle.raw : title,
			text: this.originalBody?.shown === text ? this.originalBody.raw : text, category: this.category, scope: this.scope };
	}

	private destination(draft: MemoryNoteDraft, expected = this.expected): string {
		return draft.scope === "global" ? "GLOBAL — may be recalled across projects" :
			"PROJECT — " + display(expected?.scope === "project" ? expected.project : this.backend.projectLabel);
	}

	private beginSave(): void {
		const draft = this.draft();
		const error = draftError(draft);
		if (error) { this.notice = error; this.changed(); return; }
		if (this.conflict) { this.notice = "Conflict: draft preserved. Ctrl+R reviews discarding it and reloads the current note; no force overwrite."; this.changed(); return; }
		this.review = { kind: "save", back: "form", draft, expected: this.expected ? clone(this.expected) : undefined,
			scope: this.query.scope, page: 0, seen: new Set(), pages: 0 };
		this.mode = "review"; this.notice = ""; this.changed();
	}

	private beginDelete(single = false): void {
		const ids = !single && this.selected.size ? [...this.selected.keys()] : [this.mode === "inspect" ? this.record?.id : this.page.records[this.index]?.id].filter((id): id is string => Boolean(id));
		if (!ids.length || ids.length > 50) { this.notice = "Select 1–50 notes for deletion."; this.changed(); return; }
		const scope = this.query.scope, epoch = this.epoch;
		void this.operation("Preparing exact deletion review…", async () => {
			const records: MemoryRecord[] = [];
			for (const id of ids) {
				if (epoch !== this.epoch || !this.active()) throw new Error("Access expired");
				const record = await this.backend.get(id, scope);
				if (!record || record.kind !== "note") throw new Error("Note missing");
				records.push(clone(record));
			}
			return records;
		}, (records) => {
			this.review = { kind: "delete", back: "browse", records, scope, page: 0, seen: new Set(), pages: 0 };
			this.mode = "review"; this.notice = "";
		});
	}

	private discard(action: "back" | "close" | "reload"): void {
		this.review = { kind: "discard", back: this.mode, action, scope: this.query.scope, page: 0, seen: new Set(), pages: 0 };
		this.mode = "review"; this.notice = ""; this.changed();
	}

	private approve(): void {
		const review = this.review, frame = this.frame;
		if (!review || !frame || frame.review !== review || frame.page !== review.page || frame.revision !== this.revision
			|| !this.focused || this.busy || frame.columns !== this.tui.terminal.columns || frame.rows !== this.tui.terminal.rows
			|| review.pages === 0 || review.seen.size !== review.pages) {
			this.notice = "Approval blocked: focus and display every review page in a valid layout first."; this.changed(); return;
		}
		if (review.kind === "discard") {
			const id = this.expected?.id;
			this.clearForm(); this.review = undefined;
			if (review.action === "close") { this.close(); return; }
			this.mode = "browse";
			if (review.action === "reload" && id) this.load("edit", id);
			this.changed();
		} else if (review.kind === "save") {
			void this.operation("Saving reviewed note…", () => review.expected
				? this.backend.update(clone(review.expected), { ...review.draft! }, review.scope)
				: this.backend.create({ ...review.draft! }), (record) => {
				this.clearForm(); this.review = undefined; this.record = clone(record); this.inspectScroll = 0; this.mode = "inspect";
				this.notice = "Note saved. R refreshes the browser."; this.needsRefresh = true;
			}, true);
		} else {
			void this.operation("Deleting reviewed notes…", () => this.backend.forget(review.records!.map(clone), review.scope), (count) => {
				this.review = undefined; this.selected.clear(); this.record = undefined; this.mode = "browse";
				this.notice = `${count} note(s) forgotten. Prior transcripts, viewed output and backups are not erased. R refreshes.`;
				this.needsRefresh = true;
			}, true);
		}
	}

	private clearForm(): void {
		this.title = new Input({ prompt: "" }); this.body = this.newBody();
		this.expected = this.baseline = undefined; this.originalTitle = this.originalBody = undefined; this.conflict = false;
	}

	private close(): void {
		const callback = this.closeCallback;
		this.dispose(); callback?.(); // Only explicit user close; never disposal/invalidation/late completion.
	}

	handleInput(data: string): void {
		if (this.disposed || !data) return;
		const framing = this.consumePaste(data);
		if (framing === "consumed" || isKeyRelease(data) || !this.focused) return;
		const kb = this.keybindings;
		if (framing !== "back" && (matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel"))) {
			// Complete protocol Escape/custom cancel uses the same discoverable two-key gesture.
			this.startTail = "\x1b"; this.backArmed = true; this.changed(); return;
		}
		const escape = framing === "back";
		if (this.paused) { if (escape) this.close(); return; }
		if (!this.active()) return;
		if (this.busy) {
			if (escape && !this.mutating && !this.isDirty()) this.close();
			return;
		}
		if (this.mode === "review") {
			if (escape || data === "n" || data === "N") { this.mode = this.review?.back ?? "browse"; this.review = undefined; this.notice = "Review cancelled; nothing approved."; this.changed(); }
			else if (data === "y" || data === "Y" || matchesKey(data, "enter")) this.approve();
			else if (matchesKey(data, "pageDown") || matchesKey(data, "right") || matchesKey(data, "down")) this.reviewPage(1);
			else if (matchesKey(data, "pageUp") || matchesKey(data, "left") || matchesKey(data, "up")) this.reviewPage(-1);
			return;
		}
		if (this.mode === "help") {
			if (escape || matchesKey(data, "f1")) { this.mode = this.helpBack; this.inspectScroll = 0; this.changed(); }
			else this.scrollInput(data);
			return;
		}
		if (matchesKey(data, "f1")) { this.helpBack = this.mode; this.mode = "help"; this.inspectScroll = 0; this.changed(); return; }
		if (this.mode === "form") {
			if (matchesKey(data, "ctrl+s")) { this.beginSave(); return; }
			if (matchesKey(data, "ctrl+r") && this.expected) { this.discard("reload"); return; }
			if (escape) {
				if (this.isDirty()) this.discard("back");
				else { this.clearForm(); this.mode = "browse"; this.changed(); }
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
				this.formFocus = (this.formFocus + (matchesKey(data, "tab") ? 1 : 3)) % 4; this.changed(); return;
			}
			if (this.formFocus < 2) this.editInput(data, this.formFocus ? "body" : "title");
			else if (matchesKey(data, "enter") || matchesKey(data, "space") || matchesKey(data, "right") || matchesKey(data, "left")) {
				if (this.formFocus === 2) this.category = cycle(CATEGORIES, this.category, matchesKey(data, "left") ? -1 : 1);
				else this.scope = this.scope === "project" ? "global" : "project";
				this.changed();
			}
			return;
		}
		if (this.mode === "search") {
			if (escape) { this.mode = "browse"; this.search = new Input({ prompt: "" }); this.changed(); }
			else if (matchesKey(data, "enter") || kb.matches(data, "tui.input.submit")) {
				this.query.query = this.search.getValue(); this.query.offset = 0; this.selected.clear(); this.record = undefined;
				this.mode = "browse"; this.changed(); this.refresh(0);
			} else this.editInput(data, "search");
			return;
		}
		if (escape) {
			if (this.mode === "inspect") { this.mode = "browse"; this.changed(); }
			else this.close();
			return;
		}
		if (matchesKey(data, "ctrl+f")) {
			this.search = new Input({ prompt: "" }); this.search.setValue(this.query.query ?? ""); this.search.handleInput("\x05");
			this.mode = "search"; this.changed(); return;
		}
		if (data === "r" || data === "R") { this.refresh(); return; }
		if (data === "n" || data === "N") { this.startForm(); this.changed(); return; }
		if (data === "e" || data === "E") { this.load("edit", this.mode === "inspect" ? this.record?.id : undefined); return; }
		if (data === "d" || data === "D") { this.load("duplicate", this.mode === "inspect" ? this.record?.id : undefined); return; }
		if (matchesKey(data, "delete") || matchesKey(data, "ctrl+d")) { this.beginDelete(); return; }
		if (matchesKey(data, "ctrl+delete")) { this.beginDelete(true); return; }
		if (this.mode === "inspect") { this.scrollInput(data); return; }
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) { this.browserFocus = (this.browserFocus + (matchesKey(data, "tab") ? 1 : 5)) % 6; this.changed(); return; }
		const filter = ["f2", "f3", "f4", "f5"].findIndex((key) => matchesKey(data, key as "f2"));
		if (filter >= 0) { this.cycleFilter(filter + 1); return; }
		if (this.browserFocus && (matchesKey(data, "enter") || matchesKey(data, "space") || matchesKey(data, "left") || matchesKey(data, "right"))) {
			if (this.browserFocus === 5) { this.handleInput("\x06"); return; }
			this.cycleFilter(this.browserFocus, matchesKey(data, "left") ? -1 : 1); return;
		}
		if (data === "]" || kb.matches(data, "tui.select.pageDown")) { if (this.page.nextOffset !== null) this.refresh(this.page.nextOffset); return; }
		if (data === "[" || kb.matches(data, "tui.select.pageUp")) { this.refresh(Math.max(0, this.page.offset - PAGE_SIZE)); return; }
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.index = Math.max(0, Math.min(this.page.records.length - 1, this.index + (kb.matches(data, "tui.select.up") ? -1 : 1))); this.changed();
		} else if (matchesKey(data, "space")) {
			const record = this.page.records[this.index];
			if (record) {
				if (this.selected.has(record.id)) this.selected.delete(record.id);
				else if (this.selected.size < 50) this.selected.set(record.id, { ...record });
				else this.notice = "Selection limit is 50. Unselect a note before adding another.";
				this.changed();
			}
		} else if (matchesKey(data, "ctrl+u")) { this.selected.clear(); this.changed(); }
		else if (kb.matches(data, "tui.select.confirm")) this.load("inspect");
	}

	private cycleFilter(field: number, direction = 1): void {
		if (field === 1) this.query.scope = cycle(SCOPES, this.query.scope, direction);
		else if (field === 2) this.query.category = cycle([undefined, ...CATEGORIES], this.query.category, direction);
		else if (field === 3) this.query.lane = cycle(LANES, this.query.lane, direction);
		else this.query.sort = cycle(["updated", "created", "title"] as const, this.query.sort ?? "updated", direction);
		this.selected.clear(); this.record = undefined; this.index = 0; this.refresh(0);
	}

	private scrollInput(data: string): void {
		if (matchesKey(data, "home")) this.inspectScroll = 0;
		else if (matchesKey(data, "end")) this.inspectScroll = Math.max(0, this.inspectLines - this.viewport);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "down")) this.inspectScroll += matchesKey(data, "down") ? 1 : this.viewport;
		else if (matchesKey(data, "pageUp") || matchesKey(data, "up")) this.inspectScroll -= matchesKey(data, "up") ? 1 : this.viewport;
		else return;
		this.inspectScroll = Math.max(0, Math.min(this.inspectScroll, Math.max(0, this.inspectLines - this.viewport))); this.changed();
	}

	private reviewPage(delta: number): void {
		if (!this.review) return;
		this.review.page = Math.max(0, Math.min(this.review.pages - 1, this.review.page + delta)); this.changed();
	}

	private editInput(data: string, target: "body" | "title" | "search", pasted = false): void {
		const before = target === "body" ? this.body.getExpandedText() : this[target].getValue();
		const printable = decodeKittyPrintable(data);
		if (!pasted && data.startsWith("\x1b") && !parseKey(data) && printable === undefined) return;
		if (pasted || (!data.startsWith("\x1b") && data.length > 1 && /[\r\n\t]/.test(data))) {
			if (target !== "body" && /[\r\n\t]/.test(data)) { this.notice = "Single-line field: paste rejected; no content was changed."; this.changed(); return; }
			const error = textError(data, target, before);
			if (error) { this.notice = error; this.changed(); return; }
			if (target === "body") this.body.insertTextAtCursor(data);
			else this[target].handleInput(data);
		} else {
			if (printable !== undefined || (!data.startsWith("\x1b") && !/[\x00-\x1f\x7f-\x9f]/.test(data))) {
				const error = textError(printable ?? data, target, before);
				if (error) { this.notice = error; this.changed(); return; }
			}
			if (target === "body") {
				if (matchesKey(data, "enter") || this.keybindings.matches(data, "tui.input.submit")) this.body.insertTextAtCursor("\n");
				else this.body.handleInput(data);
			} else this[target].handleInput(data);
		}
		const after = target === "body" ? this.body.getExpandedText() : this[target].getValue();
		const error = textError(after, target);
		if (error) {
			if (target === "body") this.body.setText(before); else this[target].setValue(before);
			this.notice = error;
		}
		this.changed();
	}

	/** Entire framing packet is consumed, including all prefix/suffix keys; split framing is bounded. */
	private consumePaste(data: string): "consumed" | "key" | "back" {
		if (!this.inPaste) {
			const pending = this.startTail, armed = this.backArmed, packet = pending + data;
			const start = packet.indexOf(START), tail = delimiterTail(packet, START);
			if (start < 0 && isKeyRelease(data)) return "consumed";
			if (start < 0 && !pending && !tail) return "key";
			this.startTail = ""; this.backArmed = false;
			if (start < 0) {
				// START continuations always win, including bytewise fragments after host timeouts.
				// ESC + ESC retains the second possible opener; it must not mean close.
				if (tail) this.startTail = packet.slice(-tail);
				this.backArmed = this.startTail === "\x1b" && data === "\x1b" && this.focused;
				if (armed || this.backArmed) this.changed();
				if (pending === "\x1b" && armed && !tail && matchesKey(data, "enter") && !isKeyRelease(data)) return "back";
				// A non-continuation cancels arming and is swallowed, never replayed as a shortcut.
				return "consumed";
			}
			if (armed) this.changed();
			this.inPaste = true; this.pasteText = this.endTail = ""; this.pasteRejected = false;
			this.pasteTarget = !this.focused || this.busy || this.paused ? undefined : this.mode === "search" ? "search"
				: this.mode === "form" && this.formFocus < 2 ? this.formFocus ? "body" : "title" : undefined;
			data = packet.slice(start + START.length);
		}
		const packet = this.endTail + data, end = packet.indexOf(END);
		this.endTail = "";
		const tail = end < 0 ? delimiterTail(packet, END) : 0;
		if (end < 0) this.endTail = packet.slice(packet.length - tail);
		if (this.pasteTarget && !this.pasteRejected) {
			this.pasteText += packet.slice(0, end < 0 ? packet.length - tail : end);
			const before = this.pasteTarget === "body" ? this.body.getExpandedText() : this[this.pasteTarget].getValue();
			if (textError(this.pasteText, this.pasteTarget, before)) {
				this.pasteRejected = true; this.pasteText = "";
				this.notice = "Paste rejected: unsafe content or field limit exceeded; nothing was truncated."; this.changed();
			}
		}
		if (end < 0) return "consumed";
		const text = this.pasteText, target = this.pasteTarget, rejected = this.pasteRejected;
		this.inPaste = false; this.pasteTarget = undefined; this.pasteText = this.endTail = "";
		if (target && !rejected && this.focused && !this.paused && !this.busy && this.active()) this.editInput(text, target, true);
		return "consumed";
	}

	// Match the host's public overlay maxHeight:"90%" so approval hints are never host-cropped.
	render(width: number, height = Math.floor(this.tui.terminal.rows * 0.9)): string[] {
		width = dimension(width); height = Math.min(dimension(height), dimension(this.tui.terminal.rows));
		this.frame = undefined;
		if (this.disposed || !width || !height) return [];
		this.focusChildren();
		if (this.paused) return this.fit([this.theme.fg("warning", this.paused), this.backArmed ? "Escape pending — Enter closes; another key cancels." : "Content and drafts cleared; reopen explicitly. Esc then Enter closes.", "Already viewed output/backups are not erased."], width, height);
		if (this.mode === "form" && (height < 14 || width < 24)) {
			const input = this.formFocus === 1 ? this.renderBody(width, Math.max(1, height - 1))
				: this.formFocus === 0 ? this.renderInput(this.title, width)
					: [`${this.formFocus === 2 ? "Category: " + this.category : "Scope: " + this.scope} • Enter changes`];
			return this.fit([...input, this.backArmed ? "Escape pending — Enter back" : "Enlarge for review; Esc then Enter back"], width, height);
		}
		if (height < 7 || width < 24) {
			return this.fit(["Curated notes — enlarge to review", this.backArmed ? "Escape pending — Enter back/close" : this.busy || this.notice || "F1 help · Esc then Enter back/close"], width, height);
		}
		const lines = [this.theme.fg("accent", "Curated memory • notes only"),
			this.theme.fg("muted", "Local plaintext, not a secret vault • may reach models • archive unaffected")];
		const contentHeight = Math.max(1, height - 5);
		if (this.mode === "review") this.renderReview(lines, width, contentHeight);
		else if (this.mode === "form") this.renderForm(lines, width, contentHeight);
		else if (this.mode === "search") {
			lines.push("Search literal keywords in the active scope (Enter apply, Esc then Enter cancel)", ...this.renderInput(this.search, width));
			lines.push(`Scope: ${this.query.scope} • Query is not an instruction or an FTS expression.`);
		} else if (this.mode === "help") this.renderDocument(lines, helpText(this.keybindings), width, contentHeight);
		else this.renderBrowser(lines, width, contentHeight);
		while (lines.length < height - 3) lines.push("");
		lines.push(this.theme.fg(this.busy ? "accent" : this.notice ? "warning" : "dim", this.busy || this.notice || (this.needsRefresh ? "Notes changed — R refresh" : `Selected ${this.selected.size}/50 • Space select • Ctrl+F search`)));
		lines.push(this.theme.fg("muted", this.hint()));
		lines.push(this.theme.fg("borderMuted", "─".repeat(width)));
		const result = this.fit(lines, width, height);
		if (this.mode === "review" && width >= 30 && width <= this.tui.terminal.columns && height >= 10
			&& height <= Math.floor(this.tui.terminal.rows * 0.9) && this.focused && !this.busy && this.review) {
			this.review.seen.add(this.review.page);
			this.frame = { revision: this.revision, columns: this.tui.terminal.columns, rows: this.tui.terminal.rows, review: this.review, page: this.review.page };
		}
		return result;
	}

	private renderReview(lines: string[], width: number, height: number): void {
		const review = this.review!;
		const doc: string[] = [];
		if (review.kind === "save") {
			const draft = review.draft!, original = review.expected;
			doc.push(`SAVE REVIEW — ${original ? "update exact reviewed version" : "create only (no title overwrite/restore)"}`,
				`Title: ${display(original?.title ?? "(new)")} → ${display(draft.title)}`,
				`Category: ${original?.category ?? "(new)"} → ${draft.category}`,
				`Scope: ${original?.scope ?? "(new)"} → ${draft.scope}`,
				`Destination: ${this.destination(draft, original)}`);
			if (original) doc.push(`Expected ID: ${display(original.id)}`, `Origin preserved: ${display(original.source.lane)} / ${display(original.source.sessionId)} / ${display(original.source.eventId)}`);
			doc.push(`Body (${Buffer.byteLength(draft.text, "utf8")}/${BODY_BYTES} UTF-8 bytes):`, display(draft.text, true));
		} else if (review.kind === "delete") {
			doc.push(`DELETE REVIEW — ${review.records!.length} exact note(s); atomic comparison, no force retry`,
				"Forget curated notes only. Prior viewed/model output, transcripts and backups remain.");
			for (const [i, record] of review.records!.entries()) doc.push(`${i + 1}. Title: ${display(record.title)}`, `ID: ${display(record.id)}`,
				`Scope: ${record.scope} • Project/origin: ${display(record.project)}`, `Version updated: ${date(record.updatedAt)}`);
		} else doc.push(`DISCARD DRAFT REVIEW — ${review.action === "reload" ? "reload current version" : review.action === "close" ? "close editor" : "return to browser"}`,
			`Unsaved title: ${display(this.title.getValue())}`, `Destination: ${this.destination(this.draft())}`,
			"Unsaved changes will be lost. This does not save or delete a stored note.");
		const wrapped = wrap(doc, width), pageHeight = Math.max(1, height - 1);
		const geometry = `${width}:${pageHeight}`;
		if (review.geometry !== geometry) { review.geometry = geometry; review.seen.clear(); }
		review.pages = Math.max(1, Math.ceil(wrapped.length / pageHeight));
		review.page = Math.min(review.page, review.pages - 1);
		lines.push(this.theme.fg("warning", `Review page ${review.page + 1}/${review.pages} • PgUp/PgDn • all pages required before Y/Enter`));
		lines.push(...wrapped.slice(review.page * pageHeight, (review.page + 1) * pageHeight));
	}

	private renderForm(lines: string[], width: number, height: number): void {
		const field = ["Title", "Body", "Category", "Scope"][this.formFocus];
		lines.push(`${this.expected ? "Edit" : "Create"} note ${this.isDirty() ? "[UNSAVED]" : ""} • Focus: ${field} • Tab changes field`,
			`Title (${[...this.title.getValue()].length}/${TITLE_POINTS} Unicode points):`, ...this.renderInput(this.title, width));
		lines.push(`${this.formFocus === 2 ? "> " : ""}Category: ${this.category}  ${this.formFocus === 3 ? "> " : ""}Scope: ${this.scope} (Enter/←→ on field)`);
		lines.push(truncateToWidth(`Destination: ${this.destination(this.draft())}`, width, "", true));
		lines.push(`Body (${Buffer.byteLength(this.body.getExpandedText(), "utf8")}/${BODY_BYTES} UTF-8 bytes) • Enter inserts newline`);
		lines.push(...this.renderBody(width, Math.max(1, height - 6)));
	}

	private renderInput(input: Input, width: number): string[] {
		return input.render(Math.max(3, width)).map((line) => cropCursor(line, width, input.focused));
	}

	private renderBody(width: number, height: number): string[] {
		const focused = this.body.focused;
		this.body.focused = true;
		let lines: string[];
		try { lines = this.body.render(Math.max(3, width)).slice(1, -1); }
		finally { this.body.focused = focused; }
		const cursor = Math.max(0, lines.findIndex((line) => line.includes(CURSOR_MARKER)));
		const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), lines.length - height));
		return lines.slice(start, start + height).map((line) => cropCursor(line, width, focused));
	}

	private renderBrowser(lines: string[], width: number, height: number): void {
		const fields = ["List", `Scope: ${this.query.scope}`, `Category: ${this.query.category ?? "any"}`,
			`Source: ${this.query.lane ?? "any"}`, `Sort: ${this.query.sort}`, "Search"];
		const focus = fields[this.browserFocus];
		// Put the active Tab target first: a narrow viewport must not hide which filter Enter changes.
		const filters = fields.slice(1, 5).filter((_field, index) => index + 1 !== this.browserFocus);
		lines.push(truncateToWidth(`[${focus}] • ${filters.join(" • ")}`, width, "", true),
			truncateToWidth(`Search: ${display(this.query.query || "(none)")} • ${this.page.offset + (this.page.records.length ? 1 : 0)}–${this.page.offset + this.page.records.length} of ${this.page.total}`, width, "", true));
		const available = Math.max(1, height - 2);
		if (this.mode === "inspect" && width < 90) { this.renderDocument(lines, this.record ? recordText(this.record) : ["Choose a note with Enter."], width, available); return; }
		const listWidth = width >= 90 ? Math.min(44, Math.floor(width * 0.4)) : width;
		this.listHeight = available;
		this.listTop = Math.max(0, Math.min(this.listTop, this.index));
		if (this.index >= this.listTop + available) this.listTop = this.index - available + 1;
		const list = this.page.records.slice(this.listTop, this.listTop + available).map((record, i) => {
			const current = this.listTop + i === this.index;
			const text = `${current ? ">" : " "}${this.selected.has(record.id) ? "[x]" : "[ ]"} ${record.scope === "global" ? "G" : "P"} ${display(record.title)}`;
			return this.theme.fg(current ? "accent" : "text", truncateToWidth(text, listWidth, "", true));
		});
		if (!list.length) list.push("No matching curated notes.");
		if (width < 90) { lines.push(...list); return; }
		const rightWidth = width - listWidth - 3;
		const doc = wrap(this.record ? [...(this.mode === "browse" ? ["Loaded note — Enter loads highlighted row."] : []), ...recordText(this.record)]
			: ["Inspector — Enter loads the selected note.", "Full text and original provenance are scrollable.", "No conversations or archive entries."], rightWidth);
		this.inspectLines = doc.length; this.viewport = available;
		this.inspectScroll = Math.max(0, Math.min(this.inspectScroll, Math.max(0, doc.length - available)));
		const right = doc.slice(this.inspectScroll, this.inspectScroll + available);
		for (let i = 0; i < available; i++) {
			const left = list[i] ?? "";
			lines.push(left + " ".repeat(Math.max(0, listWidth - visibleWidth(left))) + this.theme.fg("borderMuted", " │ ") + (right[i] ?? ""));
		}
	}

	private renderDocument(lines: string[], doc: string[], width: number, height: number): void {
		const wrapped = wrap(doc, width);
		this.inspectLines = wrapped.length; this.viewport = height;
		this.inspectScroll = Math.max(0, Math.min(this.inspectScroll, Math.max(0, wrapped.length - height)));
		lines.push(...wrapped.slice(this.inspectScroll, this.inspectScroll + height));
	}

	private hint(): string {
		if (this.backArmed) return "Escape pending — Enter back/close, never approve • another key cancels and is ignored";
		if (this.mode === "review") return "PgUp/PgDn all pages • Y/Enter approve • N or Esc then Enter cancel • no pasted approval";
		if (this.mode === "form") return "F1 help • Ctrl+S review save • Esc then Enter discard review • Tab fields • Ctrl+R reload";
		if (this.mode === "search") return "F1 help • Enter apply search • Esc then Enter cancel";
		if (this.mode === "help") return "F1 or Esc then Enter back • ↑↓/PgUp/PgDn/Home/End scroll";
		if (this.mode === "inspect") return "F1 help • Esc then Enter back • ↑↓/PgUp/PgDn/Home/End scroll • E edit • D duplicate";
		return "F1 help • Esc then Enter close • ↑↓ choose • Enter inspect • N/E/D • Delete review";
	}

	private fit(lines: string[], width: number, height: number): string[] {
		return lines.slice(0, height).map((line) => jarvisSurface(this.theme, truncateToWidth(line, width, "", true), "chrome"));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || this.tui.mode !== "fullscreen") return undefined;
		if (this.inPaste || this.startTail || this.disposed || this.paused || this.busy || !this.focused) return { handled: true, render: false };
		if (!this.active()) return { handled: true, render: true };
		const delta = event.wheelDelta ?? 0;
		if (!Number.isFinite(delta) || !delta) return { handled: true, render: false };
		if (this.mode === "inspect" || this.mode === "help") {
			this.inspectScroll = Math.max(0, Math.min(this.inspectScroll + Math.sign(delta) * Math.min(10, Math.ceil(Math.abs(delta))), Math.max(0, this.inspectLines - this.viewport)));
		} else if (this.mode === "review") this.reviewPage(Math.sign(delta));
		else if (this.mode === "browse") this.index = Math.max(0, Math.min(this.page.records.length - 1, this.index + Math.sign(delta)));
		else return { handled: true, render: false };
		this.changed(); return { handled: true, render: true };
	}

	invalidate(): void {
		this.frame = undefined;
		if (this.review) { this.review.geometry = undefined; this.review.seen.clear(); }
		this.title.invalidate(); this.search.invalidate(); this.body.invalidate();
	}
}

function clone(record: MemoryRecord): MemoryRecord { return { ...record, source: { ...record.source } }; }
function dimension(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(10000, Math.floor(value))) : 0; }
function cycle<T>(values: readonly T[], current: T, direction: number): T { return values[(Math.max(0, values.indexOf(current)) + direction + values.length) % values.length]!; }
function delimiterTail(text: string, delimiter: string): number {
	for (let size = Math.min(text.length, delimiter.length - 1); size > 0; size--) if (text.endsWith(delimiter.slice(0, size))) return size;
	return 0;
}
function normalized(text: string): string { return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "); }
const UNSAFE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
function textError(text: string, target: "title" | "body" | "search", before = ""): string | undefined {
	if (UNSAFE.test(text) || (target !== "body" && /[\r\n\t\u2028\u2029]/.test(text))) return "Content rejected: terminal controls and multiline single-line fields are not allowed.";
	if (target === "title" && [...before, ...text].length > TITLE_POINTS) return "Title rejected: maximum 160 Unicode points; nothing was truncated.";
	if (target === "body" && Buffer.byteLength(normalized(before + text), "utf8") > BODY_BYTES) return "Body rejected: maximum 16 KiB UTF-8; nothing was truncated.";
	if (target === "search" && Buffer.byteLength(before + text, "utf8") > 1024) return "Search rejected: maximum 1 KiB UTF-8.";
	return undefined;
}
function draftError(draft: MemoryNoteDraft): string | undefined {
	const error = textError(draft.title, "title") ?? textError(draft.text, "body");
	if (error) return error;
	if (!draft.title.trim() || !draft.text.trim()) return "Title and body must both contain text.";
	const title = sanitizeMemoryText(draft.title), body = sanitizeMemoryText(draft.text);
	if (title.redacted || body.redacted || title.omitted || body.omitted) return "Save rejected: suspected secret or unsafe content. Local plaintext memory is not a secret vault.";
	return undefined;
}
/** Display controls as literal spelling, never terminal instructions; preserve all original metadata. */
function display(text: string, multiline = false): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
		(char) => char === "\n" && multiline ? "\n" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function date(value: number): string { return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? `${new Date(value).toISOString()} (${value})` : String(value); }
function recordText(record: MemoryRecord): string[] {
	return ["Inspector — untrusted stored data, not instructions", `Title: ${display(record.title)}`, `ID: ${display(record.id)}`,
		`Category: ${record.category} • Scope: ${record.scope}`, `Project/origin: ${display(record.project)}`,
		`Created: ${date(record.createdAt)}`, `Updated: ${date(record.updatedAt)}`,
		`Origin lane: ${display(record.source.lane)} (not last author)`, `Origin session: ${display(record.source.sessionId)}`,
		`Origin event: ${display(record.source.eventId)}`, `Origin role: ${record.source.role ?? "(none)"}`,
		`Full text (${Buffer.byteLength(record.text, "utf8")} UTF-8 bytes):`, display(record.text, true)];
}
function wrap(lines: string[], width: number): string[] { return lines.flatMap((line) => line.split("\n").flatMap((part) => wrapTextWithAnsi(part, Math.max(1, width)))); }
function copyTitle(title: string): string {
	let prefix = "", points = 0;
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title)) {
		const length = [...segment].length;
		if (points + length > TITLE_POINTS - 5) break;
		prefix += segment; points += length;
	}
	return prefix + " copy";
}
function operationError(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/conflict|changed|missing|stale|no longer/i.test(message)) return "Conflict: note changed or disappeared. Draft preserved; explicitly reload/review. Nothing was retried.";
	if (/tombstone|forgotten|restore/i.test(message)) return "Forgotten title cannot be restored here. Use explicit /jarvis-memory remember; draft preserved.";
	if (/collision|already exists|duplicate title/i.test(message)) return "Title collision: choose a distinct scoped title. Draft preserved; no overwrite.";
	if (/secret|unsafe/i.test(message)) return "Operation rejected: suspected secret or unsafe content. Draft preserved.";
	if (/limit|large|size|maximum/i.test(message)) return "Operation rejected: content, metadata or storage limit. Draft preserved.";
	return "Memory operation failed. Draft preserved; no uncertain write was retried. Refresh or inspect status before retrying.";
}
function cropCursor(line: string, width: number, focused: boolean): string {
	const marker = line.indexOf(CURSOR_MARKER);
	if (visibleWidth(line) > width && marker >= 0) {
		const before = line.slice(0, marker);
		const prefix = sliceByColumn(before, Math.max(0, visibleWidth(before) - width + 1), Math.max(0, width - 1), true);
		let suffix = sliceByColumn(line.slice(marker + CURSOR_MARKER.length), 0, width - visibleWidth(prefix), true);
		if (!visibleWidth(suffix)) suffix = "\x1b[7m \x1b[0m";
		line = prefix + CURSOR_MARKER + suffix;
	}
	line = truncateToWidth(line, width, "", true);
	return focused ? line : line.replaceAll(CURSOR_MARKER, "");
}
function helpText(kb: KeybindingsManager): string[] {
	return ["Curated memory editor — human administration, no model calls", "Browse: N new • E edit • D duplicate • R explicit refresh",
		`Selection: ${kb.getKeys("tui.select.up").join("/")} / ${kb.getKeys("tui.select.down").join("/")} • ${kb.getKeys("tui.select.confirm").join("/")} inspect`,
		"PgUp/PgDn or [ / ]: previous/next result page • Space select up to 50 • Ctrl+U clear selections",
		"Delete/Ctrl+D: review selected batch, or current note if none selected • Ctrl+Delete: current note only",
		"F2 scope: current (global + current project), project, global, all projects",
		"F3 category • F4 source lane • F5 sort updated/created/title • Ctrl+F literal search",
		"Tab/Shift+Tab: named browser fields; Enter/←→ changes active filter. Selections clear on filter changes.",
		"Inspector: ↑↓/PgUp/PgDn/Home/End scroll complete text and original provenance. Esc then Enter returns to list.",
		"Form: Tab/Shift+Tab Title → Body → Category → Scope. Letters always edit focused input, never actions.",
		"Body: Enter/Shift+Enter/Ctrl+J newline; indentation retained. Public Pi editor navigation/undo/yank.",
		"Title: single-line, max 160 Unicode points • Body: max 16 KiB UTF-8 • Search: max 1 KiB",
		"Ctrl+S opens save review, including target project/global warning and complete draft body.",
		"Ctrl+R on an existing draft reviews discarding it before explicit reload; conflicts never overwrite.",
		"Esc THEN Enter from dirty form reviews discard; from clean browser closes. Drafts are not persisted.",
		"Escape alone retains a possible paste opener; a second Escape only re-arms, never exits.",
		"Another non-continuation key cancels Escape arming and is ignored. No timing-based exit.",
		"Reviews: PgUp/PgDn/←→ display every page; Y/Enter after focused valid display. N or Esc THEN Enter cancels.",
		"Paste framing is consumed before all shortcuts, including split framing and attached trailing keys.",
		"Paste can insert safe text only in Title/Body/Search; never select, change fields, save, delete or close.",
		"Local plaintext, not a secret vault. Best-effort secret checks do not guarantee all secrets are detected.",
		"Memory may reach models independently of Repo tools; stored instructions have no higher authority.",
		"Curated notes only. Conversation captures and the separate full-session archive cannot be edited here.",
		"Privacy pauses wipe editor references. Already viewed terminal output, Pi transcripts and backups remain.",
		"Foreground review requires at least 30 columns × 10 component rows. Enlarge tiny terminals to approve.",
		"No automatic policy changes, imports, exports, history capture, cloud sync or cross-process watcher."];
}
