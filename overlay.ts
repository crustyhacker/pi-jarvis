import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, isKeyRelease, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { JarvisDraftEditor } from "./draft-editor.js";
import { renderJarvisHeader, renderJarvisActivity, renderJarvisControls, jarvisSurface } from "./overlay-layout.js";
import { JarvisChoicePicker, type JarvisPickerChoice } from "./model-picker.js";
import { TranscriptViewport, type TranscriptLineAnchor } from "./transcript-viewport.js";
import { JarvisIntroAnimation, renderJarvisIntro } from "./jarvis-branding.js";

export interface JarvisDisplayEntry {
	kind: "user" | "assistant" | "tool" | "system" | "status";
	text: string;
}

export interface JarvisOverlayView {
	isReady(): boolean;
	isStreaming(): boolean;
	/** Waiting inputs only, excluding the active request. */
	getQueuedMessageCount?(): number;
	/** Whole queue operation, including startup and local side commands. */
	getIsProcessing?(): boolean;
	getModelLabel(): string;
	getModelModeLabel(): string;
	getThinkingLabel?(): string;
	getModelChoices?(): Promise<readonly JarvisPickerChoice[]>;
	configureModel?(request: string): Promise<void>;
	configureThinking?(request: string): Promise<void>;
	cancelWork?(): Promise<void>;
	getMainStatusLabel(): string;
	getMainModelLabel(): string;
	getMainFocusLabel(): string;
	getMainDeltaLabel(): string;
	getRepoToolsDetailLabel(): string;
	isToolAccessEnabled(): boolean;
	isFollowUpToMainEnabled(): boolean;
	isSteerToMainEnabled(): boolean;
	toggleToolAccess(): void;
	toggleFollowUpToMain(): void;
	toggleSteerToMain(): void;
	getDisplayEntries(): JarvisDisplayEntry[];
	sendMessage(text: string): Promise<void>;
}

interface TranscriptEntryLayout {
	lines: string[];
	/** UTF-16 offsets in sanitized source; -1 is the separate role heading. */
	offsets: number[];
	continuations: boolean[];
}

type NotificationType = "info" | "warning" | "error";
type OverlayFocusTarget = "input" | "tools" | "followUp" | "steer" | "model" | "thinking" | "history";

const OVERLAY_FOCUS_ORDER: readonly OverlayFocusTarget[] = ["input", "tools", "followUp", "steer", "model", "thinking", "history"];

type PickerState = {
	kind: "model" | "thinking";
	thread: number;
	transcript: number;
	picker?: JarvisChoicePicker;
	loading: boolean;
	saving: boolean;
	error?: string;
};

const THINKING_CHOICES: readonly JarvisPickerChoice[] = [
	{ value: "auto", label: "auto (follow main when model follows main; otherwise off)" },
	{ value: "follow-main", label: "follow-main (follow main thinking)" },
	...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
	{ value: "clear", label: "clear (remove project thinking override)" },
];

interface NotificationItem {
	message: string;
	type: NotificationType;
	timestamp: number;
}

export interface JarvisPendingConfirmation {
	title: string;
	message: string;
}

interface PendingConfirmationRecord extends JarvisPendingConfirmation {
	resolve: (value: boolean) => void;
}

export interface JarvisOverlaySnapshot {
	statuses: string[];
	notifications: NotificationItem[];
	workingMessage?: string;
	pendingConfirmation?: JarvisPendingConfirmation;
}

export class JarvisOverlayBridge {
	private requestRender?: () => void;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly canConfirm: () => boolean = () => true) {}

	/** Presentation-independent observers, e.g. the main-session footer. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private statuses = new Map<string, string>();
	private notifications: NotificationItem[] = [];
	private workingMessage?: string;
	private pendingConfirmation?: PendingConfirmationRecord;
	private draft = "";
	private threadGeneration = 0;
	private transcriptGeneration = 0;

	getDraft(): string { return this.draft; }
	getThreadGeneration(): number { return this.threadGeneration; }
	getTranscriptGeneration(): number { return this.transcriptGeneration; }
	/** Branch navigation resets scroll without discarding an unrelated draft. */
	resetTranscript(): void { this.transcriptGeneration += 1; this.emit(); }
	setDraft(text: string): void { this.draft = text; }

	dismissNotifications(): void {
		this.notifications = [];
		this.emit();
	}

	reset(): void {
		this.threadGeneration += 1;
		this.transcriptGeneration += 1;
		this.draft = "";
		this.statuses.clear();
		this.notifications = [];
		this.workingMessage = undefined;
		const pending = this.pendingConfirmation;
		this.pendingConfirmation = undefined;
		this.emit();
		pending?.resolve(false);
	}

	attach(requestRender: () => void): () => boolean {
		this.requestRender = requestRender;
		this.emit();
		// A stale overlay must never detach a newer interaction's subscriber.
		return () => {
			if (this.requestRender !== requestRender) return false;
			this.requestRender = undefined;
			return true;
		};
	}

	getConfirmationToken(): object | undefined {
		return this.pendingConfirmation;
	}

	detach(): void {
		this.requestRender = undefined;
	}

	refresh(): void {
		this.emit();
	}

	setStatus(key: string, value: string | undefined): void {
		if (!value) {
			this.statuses.delete(key);
		} else {
			this.statuses.set(key, value);
		}
		this.emit();
	}

	notify(message: string, type: NotificationType = "info"): void {
		this.notifications.push({ message, type, timestamp: Date.now() });
		if (this.notifications.length > 6) {
			this.notifications = this.notifications.slice(-6);
		}
		this.emit();
	}

	setWorkingMessage(message?: string): void {
		this.workingMessage = message;
		this.emit();
	}

	requestConfirmation(title: string, message: string, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(false);
		try { if (!this.canConfirm()) return Promise.resolve(false); }
		catch { return Promise.resolve(false); }
		if (this.pendingConfirmation) {
			const previous = this.pendingConfirmation;
			this.pendingConfirmation = undefined;
			previous.resolve(false);
		}
		return new Promise<boolean>((resolve) => {
			const record: PendingConfirmationRecord = { title, message, resolve: (value) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			} };
			const onAbort = () => {
				if (this.pendingConfirmation === record) this.resolveConfirmation(false);
			};
			this.pendingConfirmation = record;
			signal?.addEventListener("abort", onAbort, { once: true });
			this.emit();
		});
	}

	resolveConfirmation(value: boolean): void {
		const pending = this.pendingConfirmation;
		if (!pending) {
			return;
		}
		this.pendingConfirmation = undefined;
		this.emit();
		pending.resolve(value);
	}

	hasPendingConfirmation(): boolean {
		return this.pendingConfirmation !== undefined;
	}

	getPendingConfirmation(): JarvisPendingConfirmation | undefined {
		if (!this.pendingConfirmation) {
			return undefined;
		}
		return { title: this.pendingConfirmation.title, message: this.pendingConfirmation.message };
	}

	snapshot(): JarvisOverlaySnapshot {
		return {
			statuses: Array.from(this.statuses.values()),
			notifications: [...this.notifications],
			workingMessage: this.workingMessage,
			pendingConfirmation: this.getPendingConfirmation(),
		};
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try { listener(); } catch { /* Observers cannot break work/confirmation settlement. */ }
		}
		this.requestRender?.();
	}
}

export class JarvisOverlayComponent implements Component, Focusable {
	focused = false;
	private input: JarvisDraftEditor;
	private readonly maxHeightProvider: () => number;
	private focusTarget: OverlayFocusTarget = "input";
	private expandedDetails = false;
	private threadGeneration: number;
	private transcriptGeneration: number;
	private historySeeded = false;
	private readonly viewport = new TranscriptViewport();
	private disposed = false;
	private pickerState?: PickerState;
	private stopping = false;
	private releaseBridge?: () => boolean;
	private confirmationToken?: object;
	private confirmationLayout = "";
	private confirmationOffset = 0;
	private confirmationPageSize = 1;
	private confirmationLineCount = 0;
	private confirmationSeen = new Set<number>();
	private confirmationCanApprove = false;
	private renderedRows = 0;
	private renderedColumns = 0;
	private readonly intro: JarvisIntroAnimation;
	private thinkingAnimationTick = 0;
	private thinkingAnimationTimer?: NodeJS.Timeout;
	private transcriptCacheWidth = -1;
	private transcriptCache: Array<{ kind: JarvisDisplayEntry["kind"]; text: string; layout: TranscriptEntryLayout }> = [];
	private transcriptLines: string[] = [];
	/** Layout row identities let even blank spacing/repeated role headings anchor. */
	private transcriptViewportRows: string[] = [];
	private transcriptSourceIds = new Map<string, number>();
	private transcriptNextSourceId = 0;
	private transcriptContinuationLabels: Array<string | undefined> = [];
	private transcriptAnchors: Array<TranscriptLineAnchor | undefined> = [];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly bridge: JarvisOverlayBridge,
		private readonly view: JarvisOverlayView,
		private readonly close: () => void,
		private readonly keybindings: KeybindingsManager = getKeybindings(),
		options: { showIntro?: boolean } = {},
	) {
		this.intro = new JarvisIntroAnimation(() => { if (!this.disposed) this.tui.requestRender(); },
			options.showIntro === true && process.env.PI_JARVIS_NO_ANIMATION !== "1" && !process.env.NO_COLOR && process.env.TERM !== "dumb");
		this.maxHeightProvider = () => Math.max(0, Math.min(this.tui.terminal.rows, Math.max(1, Math.floor(this.tui.terminal.rows * 0.78))));

		this.threadGeneration = bridge.getThreadGeneration();
		this.transcriptGeneration = bridge.getTranscriptGeneration();
		this.input = this.createEditor();
	}

	private createEditor(): JarvisDraftEditor {
		const generation = this.bridge.getThreadGeneration();
		const editor = new JarvisDraftEditor(this.tui, this.theme, {
			onChange: (text) => {
				if (!this.disposed && generation === this.bridge.getThreadGeneration()) this.bridge.setDraft(text);
			},
			onError: (message) => {
				if (!this.disposed && generation === this.bridge.getThreadGeneration()) this.bridge.notify(message, "warning");
			},
			onSubmit: (message) => {
				if (!message.trim() || this.disposed || generation !== this.bridge.getThreadGeneration()) return;
				editor.addToHistory(message);
				this.viewport.toLatest();
				try {
					void Promise.resolve(this.view.sendMessage(message)).catch((error: unknown) => {
						if (!this.disposed && generation === this.bridge.getThreadGeneration()) this.bridge.notify(String(error), "error");
					});
				} catch (error) {
					this.bridge.notify(String(error), "error");
				}
			},
		}, this.bridge.getDraft());
		this.historySeeded = this.view.isReady();
		if (this.historySeeded) this.seedHistory(editor);
		return editor;
	}

	private seedHistory(editor: JarvisDraftEditor): void {
		for (const entry of this.view.getDisplayEntries().filter((entry) => entry.kind === "user").slice(-100)) editor.addToHistory(entry.text);
	}

	private syncThread(): void {
		const transcriptGeneration = this.bridge.getTranscriptGeneration();
		if (transcriptGeneration !== this.transcriptGeneration) {
			this.transcriptGeneration = transcriptGeneration;
			this.viewport.reset();
			this.transcriptCacheWidth = -1;
			this.dismissPicker();
		}
		const generation = this.bridge.getThreadGeneration();
		if (generation === this.threadGeneration) {
			if (!this.historySeeded && this.view.isReady()) {
				this.seedHistory(this.input);
				this.historySeeded = true;
			}
			return;
		}
		const previousInput = this.input;
		this.threadGeneration = generation;
		this.input = this.createEditor();
		this.input.inheritPasteDrain(previousInput);
		previousInput.dispose();
		this.viewport.reset();
	}

	attachBridge(): void {
		if (this.disposed) return;
		this.releaseBridge?.();
		this.releaseBridge = this.bridge.attach(() => {
			if (this.bridge.hasPendingConfirmation()) this.dismissPicker();
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		// Dismiss only the decoration; deliver this very same input normally.
		// Paste framing is still consumed before shortcuts in handleKey().
		if (!isKeyRelease(data)) this.intro.finish();
		try {
			this.syncThread();
			this.handleKey(data);
		} finally {
			this.input.invalidate();
			this.tui.requestRender();
		}
	}

	private handleKey(data: string): void {
		const kb = this.keybindings;
		const hasConfirmation = this.bridge.hasPendingConfirmation();
		if (hasConfirmation) this.dismissPicker();
		// The same framing owner drains paste even across picker/confirmation/reset.
		if (this.input.handlePasteInput(data, hasConfirmation || Boolean(this.pickerState))) {
			if (!hasConfirmation && !this.pickerState) this.focusTarget = "input";
			return;
		}
		if (isKeyRelease(data)) return;
		// Pi's default select.cancel includes Ctrl+C; Jarvis reserves it for stop.
		if (matchesKey(data, "ctrl+c")) {
			// Review owns input: Ctrl+C cancels review, never approves or stops
			// a task as a side effect of selector/confirmation cancellation.
			if (hasConfirmation) this.bridge.resolveConfirmation(false);
			else if (this.pickerState) this.dismissPicker();
			else this.stopWork();
			return;
		}
		if (hasConfirmation) {
			if (matchesKey(data, "y") || matchesKey(data, "shift+y")) {
				if (this.focused && this.confirmationCanApprove && this.confirmationToken === this.bridge.getConfirmationToken()
					&& this.renderedRows === this.tui.terminal.rows && this.renderedColumns === this.tui.terminal.columns) {
					this.bridge.resolveConfirmation(true);
				}
				return;
			}
			if (matchesKey(data, "n") || matchesKey(data, "shift+n") || kb.matches(data, "tui.select.cancel")) {
				this.bridge.resolveConfirmation(false);
				return;
			}
			if (this.confirmationToken !== this.bridge.getConfirmationToken()) return;
			if (kb.matches(data, "tui.select.pageDown") || kb.matches(data, "tui.select.down")) {
				this.confirmationOffset = Math.min(Math.max(0, this.confirmationLineCount - this.confirmationPageSize),
					this.confirmationOffset + (kb.matches(data, "tui.select.pageDown") ? this.confirmationPageSize : 1));
			} else if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.up")) {
				this.confirmationOffset = Math.max(0, this.confirmationOffset - (kb.matches(data, "tui.select.pageUp") ? this.confirmationPageSize : 1));
			}
			// Other keys cannot submit input or toggle permissions while reviewing.
			return;
		}
		if (this.pickerState) {
			if (matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel")) this.dismissPicker();
			else if (!this.pickerState.loading && !this.pickerState.saving) this.pickerState.picker?.handleInput(data);
			return;
		}
		if (matchesKey(data, "f2") || matchesKey(data, "f3")) {
			this.openPicker(matchesKey(data, "f2") ? "model" : "thinking");
			return;
		}
		if (matchesKey(data, "escape") || kb.matches(data, "tui.select.cancel")) {
			this.dispose();
			return;
		}
		if (matchesKey(data, "ctrl+o")) {
			this.expandedDetails = !this.expandedDetails;
			return;
		}
		if (matchesKey(data, "ctrl+l")) {
			this.bridge.dismissNotifications();
			return;
		}
		if (matchesKey(data, "ctrl+end")) {
			this.viewport.toLatest();
			return;
		}
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.viewport.pageUp();
			return;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.viewport.pageDown();
			return;
		}
		if (matchesKey(data, "alt+up") || matchesKey(data, "alt+down")) {
			this.viewport.scrollLines(matchesKey(data, "alt+up") ? -1 : 1);
			return;
		}
		if (this.focusTarget === "history" && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
			this.viewport.scrollLines(kb.matches(data, "tui.select.up") ? -1 : 1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.cycleFocus(-1);
			return;
		}
		if (kb.matches(data, "tui.input.tab")) {
			this.cycleFocus(1);
			return;
		}
		if (this.focusTarget !== "input" && (matchesKey(data, "space") || kb.matches(data, "tui.input.submit"))) {
			this.toggleFocusedControl();
			return;
		}
		if (this.focusTarget !== "input") return;

		this.input.handleInput(data);
	}

	render(width: number): string[] {
		if (this.disposed) return [];
		this.syncThread();
		width = Math.max(0, Math.floor(width));
		const maxHeight = this.maxHeightProvider();
		const snapshot = this.bridge.snapshot();
		const hasConfirmation = Boolean(snapshot.pendingConfirmation);
		if (hasConfirmation) this.dismissPicker();
		if (hasConfirmation || this.pickerState || snapshot.notifications.some((item) => item.type !== "info")) this.intro.finish();
		this.input.focused = this.focused && !hasConfirmation && !this.pickerState && this.focusTarget === "input";
		this.renderedRows = this.tui.terminal.rows;
		this.renderedColumns = this.tui.terminal.columns;
		this.confirmationCanApprove = false;
		if (width === 0 || maxHeight === 0) {
			this.pickerState?.picker?.invalidate();
			this.intro.finish();
			this.stopThinkingAnimation();
			return [];
		}
		if (width < 5 || maxHeight < 3) {
			this.pickerState?.picker?.invalidate();
			this.intro.finish();
			this.stopThinkingAnimation();
			return hasConfirmation || this.pickerState ? [truncateToWidth("Enlarge to review; Esc cancel", width, "", true)] : this.renderInputLines(width, 1);
		}
		const innerWidth = width - 4;
		const maxBodyLines = maxHeight - 2;
		if (snapshot.pendingConfirmation) {
			this.stopThinkingAnimation();
			return [this.borderTop(innerWidth),
				...this.renderConfirmation(snapshot.pendingConfirmation, innerWidth, maxBodyLines).map((line) => this.row(line, innerWidth)),
				this.borderBottom(innerWidth)];
		}

		if (this.pickerState) {
			this.stopThinkingAnimation();
			return [this.borderTop(innerWidth), ...this.renderPicker(innerWidth, maxBodyLines).map((line) => this.row(line, innerWidth)), this.borderBottom(innerWidth)];
		}

		// Keep at least three history rows on typical terminals, even with a
		// multiline draft. The editor's public cursor crop retains all draft text.
		const inputBudget = Math.max(1, Math.min(5, maxBodyLines >= 14 ? maxBodyLines - 14 : Math.floor(maxBodyLines / 4)));
		const inputLines = this.renderInputLines(innerWidth, inputBudget);
		const footerLines = this.renderHints(innerWidth, maxBodyLines, snapshot.notifications.length > 0);
		const panel = maxBodyLines >= 9 && innerWidth >= 12;
		const promptSection = [
			...(maxBodyLines >= 7 ? [this.promptBorder("Prompt · Message", innerWidth, true)] : []),
			...inputLines,
			...(panel ? [this.promptBorder("", innerWidth, false)] : []),
			...footerLines.map((line) => truncateToWidth(this.theme.fg("dim", line), innerWidth, "", true)),
		];
		let remaining = Math.max(0, maxBodyLines - promptSection.length);
		const active = Boolean(this.view.getIsProcessing?.() || this.view.isStreaming());
		this.syncThinkingAnimation(active);
		const activity = renderJarvisActivity(this.theme, snapshot, this.view, innerWidth);
		const icon = active ? this.theme.fg("accent", ["◈", "◆", "◇", "✦"][this.thinkingAnimationTick % 4] + " ") : "";
		const header = renderJarvisHeader(this.theme, this.view, innerWidth, {
			expanded: this.expandedDetails, focusTarget: this.focusTarget, focused: this.focused,
			activity: this.expandedDetails || stripTerminalSequences(activity) !== "Ready" ? icon + activity : undefined,
			infoNotice: !this.expandedDetails && snapshot.notifications.some(item => item.type === "info"),
		});
		// Keep a transcript row on normal terminals; keep the focused access
		// control available even on short ones. Details never consume the editor.
		const importantNotice = snapshot.notifications.some(item => item.type !== "info");
		const headerBudget = Math.min(header.length, Math.max(0, remaining - (remaining >= 7 ? 6 : remaining >= 5 ? 3 : 0) - (importantNotice ? 1 : 0)));
		const top: string[] = headerBudget >= header.length ? header : headerBudget >= 2
			? [...header.slice(0, headerBudget - 1), header[header.length - 1]!]
			: headerBudget === 1 ? [this.focusTarget === "input" ? header[0]! : header[header.length - 1]!] : [];
		remaining -= top.length;
		if (remaining > 1 || ["model", "thinking", "history"].includes(this.focusTarget)) {
			if (remaining === 0 && top.length) { top.pop(); remaining++; }
			if (remaining > 0) {
				top.push(renderJarvisControls(this.theme, this.view, innerWidth, { expanded: this.expandedDetails, focusTarget: this.focusTarget, focused: this.focused }));
				remaining--;
			}
		}
		const visibleNotifications = this.expandedDetails ? snapshot.notifications : snapshot.notifications.filter(item => item.type !== "info");
		if (remaining > 0 && visibleNotifications.length) {
			const notices = this.notificationLines(visibleNotifications, innerWidth);
			const count = Math.min(this.expandedDetails ? 4 : 1, notices.length, importantNotice ? Math.max(1, remaining - 2) : Math.max(0, remaining - 2));
			const visibleNotices = notices.slice(0, count);
			if (count > 0 && count < notices.length) visibleNotices[count - 1] = truncateToWidth(visibleNotices[count - 1]!, innerWidth - 1, "", true) + this.theme.fg("dim", "…");
			top.push(...visibleNotices);
			remaining -= count;
		}
		if (remaining < 3) this.intro.finish();
		const introFrame = this.intro.frame();
		if (introFrame !== undefined) {
			// Seed only on initial layout/reflow, not every animation tick. The
			// first scrolling key dismisses decoration AND navigates real history.
			if (this.transcriptCacheWidth !== innerWidth || this.viewport.getStatus().totalLines === 0) this.renderTranscript(innerWidth, Math.max(0, remaining - 1), snapshot);
			top.push(...renderJarvisIntro(this.theme, innerWidth, remaining, introFrame));
		} else if (remaining > 0) {
			top.push(...this.renderConversation(innerWidth, remaining, snapshot));
		}
		return [this.borderTop(innerWidth), ...[...top, ...promptSection].slice(0, maxBodyLines).map((line) => this.row(line, innerWidth)), this.borderBottom(innerWidth)];
	}

	/** Fullscreen public normalized events only; regular-mode wheel is terminal-owned. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || event.type !== "wheel") return undefined;
		this.syncThread();
		if (this.bridge.hasPendingConfirmation() || this.input.hasPendingPaste()) return { handled: true, render: false };
		if (this.pickerState) {
			return this.pickerState.picker?.handleMouse(event) ?? { handled: true, render: false };
		}
		this.intro.finish();
		this.viewport.scrollLines(event.wheelDelta ?? 0);
		this.tui.requestRender();
		return { handled: true, render: true };
	}

	private openPicker(kind: PickerState["kind"]): void {
		const configure = kind === "model" ? this.view.configureModel : this.view.configureThinking;
		if (!configure || (kind === "model" && !this.view.getModelChoices)) {
			this.bridge.notify(`Jarvis ${kind} selection is unavailable in this host.`, "warning");
			return;
		}
		this.intro.finish();
		this.focusTarget = "input";
		const state: PickerState = { kind, thread: this.bridge.getThreadGeneration(), transcript: this.bridge.getTranscriptGeneration(), loading: true, saving: false };
		this.pickerState = state;
		const load = async () => {
			try {
				const choices = kind === "model" ? await this.view.getModelChoices!() : THINKING_CHOICES;
				if (!this.pickerIsCurrent(state)) return;
				state.picker = new JarvisChoicePicker(this.tui, this.theme, this.keybindings, choices,
					(choice) => { void this.applyChoice(state, choice.value); }, () => this.dismissPicker(),
					`Jarvis ${kind} · project override (main unchanged)`);
				state.loading = false;
			} catch (error) {
				if (!this.pickerIsCurrent(state)) return;
				state.loading = false;
				state.error = String(error);
			}
			if (this.pickerIsCurrent(state)) this.tui.requestRender();
		};
		void load();
	}

	private pickerIsCurrent(state: PickerState): boolean {
		return !this.disposed && this.pickerState === state && state.thread === this.bridge.getThreadGeneration()
			&& state.transcript === this.bridge.getTranscriptGeneration() && !this.bridge.hasPendingConfirmation();
	}

	private async applyChoice(state: PickerState, request: string): Promise<void> {
		if (!this.pickerIsCurrent(state) || state.saving || !this.focused
			|| this.renderedRows !== this.tui.terminal.rows || this.renderedColumns !== this.tui.terminal.columns) return;
		state.saving = true;
		state.error = undefined;
		this.tui.requestRender();
		try {
			if (state.kind === "model") await this.view.configureModel!(request);
			else await this.view.configureThinking!(request);
			if (this.pickerIsCurrent(state)) this.dismissPicker();
		} catch (error) {
			if (!this.pickerIsCurrent(state)) return;
			state.saving = false;
			state.error = String(error);
		}
		if (!this.disposed && state.thread === this.bridge.getThreadGeneration()) this.tui.requestRender();
	}

	private dismissPicker(): void {
		if (!this.pickerState) return;
		this.pickerState.picker?.invalidate();
		this.pickerState = undefined;
		this.focusTarget = "input";
	}

	private renderPicker(width: number, budget: number): string[] {
		const state = this.pickerState!;
		if (state.loading || state.saving || !state.picker) {
			return [this.theme.fg("accent", `Jarvis ${state.kind}`),
				this.theme.fg("muted", state.loading ? "Loading host model choices…" : state.saving ? "Applying project override…" : "Selection unavailable"),
				...this.wrapBlock(this.theme.fg("error", sanitizeOverlayDisplayText(state.error ?? "")), width).slice(0, Math.max(0, budget - 3)),
				this.theme.fg("dim", "Esc back • draft preserved")].slice(0, budget);
		}
		state.picker.focused = this.focused;
		const errorLines = state.error ? this.wrapBlock(this.theme.fg("error", `Error: ${sanitizeOverlayDisplayText(state.error)}`), width).slice(0, Math.max(1, Math.min(3, budget - 4))) : [];
		return [...state.picker.render(width, Math.max(1, budget - errorLines.length)), ...errorLines].slice(0, budget);
	}

	private stopWork(): void {
		if (this.stopping) return;
		if (!this.view.cancelWork) { this.bridge.notify("Stop is unavailable in this host.", "warning"); return; }
		this.stopping = true;
		const generation = this.bridge.getThreadGeneration();
		const stop = async () => {
			try { await this.view.cancelWork!(); }
			catch (error) { if (!this.disposed && generation === this.bridge.getThreadGeneration()) this.bridge.notify(String(error), "error"); }
			finally { this.stopping = false; }
		};
		void stop();
	}

	private renderHints(width: number, budget: number, hasNotice: boolean): string[] {
		if (budget < 3) return [];
		const submit = this.keyLabel("tui.input.submit");
		const newline = this.keyLabel("tui.input.newLine");
		const core = `${submit} send • ${newline} newline • esc close • ctrl+c stop`;
		const compact = `${submit} send • ${newline === "shift+enter" ? "⇧enter" : newline} ↵ • esc close • ctrl+c stop`;
		const first = visibleWidth(core) <= width ? core : visibleWidth(compact) <= width ? compact : "esc close • ctrl+c stop";
		const tab = this.keyLabel("tui.input.tab");
		const context = this.expandedDetails ? `alt+↑/↓ history • ctrl+end live • ${tab} controls`
			: ["tools", "followUp", "steer"].includes(this.focusTarget) ? `${submit}/space toggle • ${tab} next`
			: ["model", "thinking"].includes(this.focusTarget) ? `${submit}/space choose • ${tab} next`
			: this.focusTarget === "history" ? `↑/↓ scroll • alt+↑/↓ history • ${tab} next`
			: `${tab} controls`;
		return [first, `${context} • ctrl+o details${hasNotice ? " • ctrl+l dismiss" : ""}`];
	}

	private renderConversation(width: number, budget: number, snapshot: JarvisOverlaySnapshot): string[] {
		const framed = width >= 16 && budget >= 5;
		const panelWidth = framed ? width - 2 : width;
		const padding = framed ? width >= 40 ? 2 : 1 : 0;
		const readingWidth = Math.max(1, Math.min(96, panelWidth - padding * 2));
		const inset = padding + Math.floor(Math.max(0, panelWidth - padding * 2 - readingWidth) / 2);
		// Vertical air is optional: never buy it with the last three reading rows.
		const air = framed && budget >= 9 ? 1 : 0;
		const transcript = this.renderTranscript(readingWidth, Math.max(0, budget - (framed ? 2 : 1) - air * 2), snapshot);
		const position = this.viewport.getStatus();
		const scroll = `${this.keyLabel("tui.editor.pageUp")}/${this.keyLabel("tui.editor.pageDown")} scroll`;
		const state = position.following ? `live · ${scroll}` : `History · ${position.hiddenBelow} below · ctrl+end live`;
		const continued = this.transcriptContinuationLabels[position.startLine];
		// A clipped message's speaker precedes optional scroll chrome, so even
		// narrow titles retain identity without replacing or clipping body text.
		const role = continued ? `${continued} · ` : "";
		const fullTitle = `${role}Conversation · ${state}`;
		const shortScroll = `${this.keyLabel("tui.editor.pageUp").replace(/^pageUp$/, "PgUp")}/${this.keyLabel("tui.editor.pageDown").replace(/^pageDown$/, "PgDn")}`;
		const compactTitle = `${role}${position.following ? `Conversation · live · ${shortScroll}` : state}`;
		const titleWidth = framed ? width - 4 : width - 2;
		const title = visibleWidth(fullTitle) <= titleWidth ? fullTitle : visibleWidth(compactTitle) <= titleWidth ? compactTitle
			: `${role}Conversation${role ? "" : position.following ? " · live" : " · History"}`;
		const border = (top: boolean, label = "") => {
			const text = label ? ` ${truncateToWidth(label, Math.max(0, width - 4), "", true)} ` : "";
			return this.theme.fg("borderMuted", `${top ? "╭" : "╰"}${text}${"─".repeat(Math.max(0, width - visibleWidth(text) - 2))}${top ? "╮" : "╯"}`);
		};
		const row = (line: string) => {
			const content = " ".repeat(inset) + line;
			const padded = content + " ".repeat(Math.max(0, panelWidth - visibleWidth(content)));
			const body = jarvisSurface(this.theme, padded, "conversation");
			return framed ? this.theme.fg("borderMuted", "│") + body + this.theme.fg("borderMuted", "│") : body;
		};
		return [framed ? border(true, title) : this.sectionDivider(title, width),
			...(air && transcript.length ? [row("")] : []), ...transcript.map(row),
			...(air && transcript.length ? [row("")] : []), ...(framed ? [border(false)] : [])];
	}

	private promptBorder(label: string, width: number, top: boolean): string {
		const text = label ? ` ${label} ` : "";
		return truncateToWidth(this.theme.fg("borderAccent", (top ? "┌" : "└") + text + "─".repeat(Math.max(0, width - visibleWidth(text) - 1))), width, "", true);
	}

	private renderConfirmation(confirmation: JarvisPendingConfirmation, innerWidth: number, budget: number): string[] {
		const token = this.bridge.getConfirmationToken();
		const layout = `${innerWidth}:${budget}`;
		if (token !== this.confirmationToken || layout !== this.confirmationLayout) {
			this.confirmationToken = token;
			this.confirmationLayout = layout;
			this.confirmationOffset = 0;
			this.confirmationSeen.clear();
		}
		// Wrap the title too, and do not silently truncate wide graphemes during review.
		const content = [
			...wrapTextWithAnsi(`▶ ${sanitizeInlineText(confirmation.title)}`, innerWidth),
			...sanitizeOverlayDisplayText(confirmation.message).split("\n").flatMap((line) => line ? wrapTextWithAnsi(line, innerWidth) : [""]),
		];
		this.confirmationLineCount = content.length;
		if (budget < 4 || innerWidth < 4 || content.some((line) => visibleWidth(line) > innerWidth)) {
			return [truncateToWidth("Enlarge to review; Esc cancel", innerWidth, "", true)].slice(0, budget);
		}
		const allFits = content.length + 3 <= budget;
		this.confirmationPageSize = allFits ? content.length : Math.max(1, budget - 3);
		this.confirmationOffset = Math.min(this.confirmationOffset, Math.max(0, content.length - this.confirmationPageSize));
		const visible = content.slice(this.confirmationOffset, this.confirmationOffset + this.confirmationPageSize);
		for (let i = this.confirmationOffset; i < this.confirmationOffset + visible.length; i++) this.confirmationSeen.add(i);
		this.confirmationCanApprove = this.confirmationSeen.size === content.length;
		const cancelKey = this.keyLabel("tui.select.cancel");
		const review = allFits ? `Press Y to confirm, N or ${cancelKey === "esc" ? "Esc" : cancelKey} to cancel.`
			: `${this.confirmationOffset + 1}-${this.confirmationOffset + visible.length}/${content.length} • ${this.keyLabel("tui.select.pageUp")}/${this.keyLabel("tui.select.pageDown")} review`;
		const hint = this.confirmationCanApprove ? `Y confirm • N/${cancelKey} cancel` : `Review all pages before Y • N/${cancelKey} cancel`;
		return [this.sectionDivider("Confirm", innerWidth), ...visible,
			truncateToWidth(this.theme.fg("muted", review), innerWidth, "", true),
			truncateToWidth(this.theme.fg("dim", hint), innerWidth, "", true)];
	}

	invalidate(): void {
		this.input.invalidate();
		this.pickerState?.picker?.invalidate();
		this.transcriptCacheWidth = -1;
		this.confirmationCanApprove = false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.dismissPicker();
		this.intro.finish();
		this.input.focused = false;
		this.input.dispose();
		this.stopThinkingAnimation();
		const ownsInteraction = this.releaseBridge?.() ?? true;
		if (ownsInteraction) {
			this.bridge.resolveConfirmation(false);
			this.close();
		}
	}

	private renderTranscript(innerWidth: number, budget: number, snapshot: JarvisOverlaySnapshot): string[] {
		if (budget <= 0) return [];
		const allEntries = [...this.view.getDisplayEntries(), ...snapshot.statuses.map((text): JarvisDisplayEntry => ({ kind: "status", text }))];
		// Bound rendered history, not the persisted side transcript. The omitted
		// prefix is explicit and discoverable when scrolling to the beginning.
		const entries: JarvisDisplayEntry[] = [];
		let remainingChars = 512 * 1024;
		let omitted = allEntries.length > 500;
		for (let i = allEntries.length - 1; i >= Math.max(0, allEntries.length - 500) && remainingChars > 0; i--) {
			const entry = allEntries[i]!;
			const limit = Math.min(64 * 1024, remainingChars);
			const clipped = entry.text.length > limit;
			const text = clipped ? `[Earlier text omitted from overlay]\n${entry.text.slice(-limit)}` : entry.text;
			entries.unshift({ kind: entry.kind, text });
			remainingChars -= Math.min(entry.text.length, limit);
			omitted ||= clipped || (remainingChars === 0 && i > 0);
		}
		if (omitted) entries.unshift({ kind: "status", text: "Older content omitted from this bounded overlay view; persisted session history is unchanged." });
		const changed = this.transcriptCacheWidth !== innerWidth || entries.length !== this.transcriptCache.length
			|| entries.some((entry, i) => entry.kind !== this.transcriptCache[i]?.kind || entry.text !== this.transcriptCache[i]?.text);
		if (changed) {
			if (this.transcriptCacheWidth !== innerWidth) this.transcriptCache = [];
			this.transcriptCacheWidth = innerWidth;
			this.transcriptLines = [];
			this.transcriptViewportRows = [];
			this.transcriptContinuationLabels = [];
			this.transcriptAnchors = [];
			const cache: typeof this.transcriptCache = [];
			const sourceIds = new Map<string, number>();
			const labels = { user: "User:", assistant: "Jarvis:", tool: "Tool:", status: "Note:", system: "System:" };
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i]!;
				const previous = this.transcriptCache[i];
				const layout = previous?.kind === entry.kind && previous.text === entry.text ? previous.layout : this.renderEntry(entry, innerWidth);
				cache.push({ ...entry, layout });
				const safeText = sanitizeOverlayDisplayText(entry.text);
				const key = `${entry.kind}:${safeText.slice(0, 500)}`;
				const sourceId = sourceIds.get(key) ?? this.transcriptSourceIds.get(key) ?? ++this.transcriptNextSourceId;
				sourceIds.set(key, sourceId);
				if (i > 0) {
					this.transcriptLines.push(""); this.transcriptViewportRows.push(`${sourceId}/-2`);
					this.transcriptContinuationLabels.push(undefined); this.transcriptAnchors.push({ key, offset: -2 });
				}
				for (let j = 0; j < layout.lines.length; j++) {
					this.transcriptLines.push(layout.lines[j]!);
					this.transcriptViewportRows.push(`${sourceId}/${layout.offsets[j]}`);
					this.transcriptContinuationLabels.push(layout.continuations[j] ? labels[entry.kind] : undefined);
					this.transcriptAnchors.push({ key, offset: layout.offsets[j]! });
				}
			}
			this.transcriptCache = cache;
			this.transcriptSourceIds = sourceIds;
		}
		// Give the existing viewport layout identities instead of decoration.
		// Otherwise identical headings and empty spacer rows conceal rollover,
		// preventing its source-character anchors from being consulted. IDs never
		// enter the transcript or terminal; the selected range paints real rows.
		this.viewport.render(this.transcriptViewportRows, budget, innerWidth, this.transcriptAnchors);
		const position = this.viewport.getStatus();
		return this.transcriptLines.slice(position.startLine, position.endLine);
	}

	private renderEntry(entry: JarvisDisplayEntry, innerWidth: number): TranscriptEntryLayout {
		const safeText = sanitizeOverlayDisplayText(entry.text);
		const labels = { user: "User:", assistant: "Jarvis:", tool: "Tool:", status: "Note:", system: "System:" };
		const colors = { user: "accent", assistant: "success", tool: "warning", status: "muted", system: "muted" } as const;
		const layout: TranscriptEntryLayout = {
			lines: [truncateToWidth(this.theme.bold(this.theme.fg(colors[entry.kind], labels[entry.kind])), innerWidth, "", true)],
			offsets: [-1], continuations: [false],
		};
		let paragraphOffset = 0;
		for (const paragraph of safeText.split("\n")) {
			let consumed = 0;
			for (const line of wrapTextWithAnsi(paragraph, Math.max(1, innerWidth))) {
				// Track source before styling/padding: headings and frame insets are
				// not source characters. Public wrapping may skip boundary whitespace.
				const found = line ? paragraph.indexOf(line, consumed) : consumed;
				const offset = found >= 0 ? found : consumed;
				layout.lines.push(truncateToWidth(this.theme.fg(entry.kind === "system" || entry.kind === "status" ? "muted" : "text", line), innerWidth, "", true));
				layout.offsets.push(paragraphOffset + offset);
				layout.continuations.push(true);
				consumed = offset + line.length;
			}
			paragraphOffset += paragraph.length + 1;
		}
		return layout;
	}

	private renderInputLines(innerWidth: number, maxLines: number): string[] {
		const prompt = innerWidth >= 12 ? "jarvis > " : innerWidth >= 3 ? "> " : "";
		const continuation = innerWidth >= 12 ? "     ... " : innerWidth >= 3 ? "| " : "";
		const inputWidth = Math.max(1, innerWidth - visibleWidth(prompt));
		return this.input.render(inputWidth, maxLines).map((line, index) => {
			const content = truncateToWidth(this.theme.fg("accent", index === 0 ? prompt : continuation) + this.theme.fg("text", line), innerWidth, "", true);
			const padded = content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
			return jarvisSurface(this.theme, padded, "prompt");
		});
	}

	private notificationLines(items: readonly NotificationItem[], innerWidth: number): string[] {
		const item = [...items].reverse().find(item => item.type !== "info") ?? items.at(-1);
		if (!item) return [];
		const latest = items.at(-1)!;
		const visible = latest !== item && latest.type === "info" ? [item, latest] : [item];
		return visible.flatMap(notice => {
			const color = notice.type === "error" ? "error" : notice.type === "warning" ? "warning" : "muted";
			const label = notice.type === "error" ? "Error" : notice.type === "warning" ? "Warning" : "Notice";
			return this.wrapBlock(this.theme.fg(color, `${label}: ${sanitizeOverlayDisplayText(notice.message)}`), innerWidth);
		});
	}

	private sectionDivider(label: string, innerWidth: number): string {
		const plain = ` ${label} `;
		const fillWidth = Math.max(0, innerWidth - visibleWidth(plain));
		const left = Math.floor(fillWidth / 2);
		const right = fillWidth - left;
		return truncateToWidth(this.theme.fg("borderMuted", `${"─".repeat(left)}${plain}${"─".repeat(right)}`), innerWidth, "", true);
	}

	private keyLabel(action: Parameters<KeybindingsManager["getKeys"]>[0]): string {
		return this.keybindings.getKeys(action)[0]?.replace("escape", "esc") ?? "unbound";
	}

	private cycleFocus(direction: 1 | -1): void {
		const currentIndex = OVERLAY_FOCUS_ORDER.indexOf(this.focusTarget);
		const nextIndex = (currentIndex + direction + OVERLAY_FOCUS_ORDER.length) % OVERLAY_FOCUS_ORDER.length;
		this.focusTarget = OVERLAY_FOCUS_ORDER[nextIndex] ?? "input";
	}

	private toggleFocusedControl(): void {
		switch (this.focusTarget) {
			case "tools":
				this.view.toggleToolAccess();
				break;
			case "followUp":
				this.view.toggleFollowUpToMain();
				break;
			case "steer":
				this.view.toggleSteerToMain();
				break;
			case "model":
			case "thinking":
				this.openPicker(this.focusTarget);
				break;
			case "history":
				break;
		}
	}

	private syncThinkingAnimation(active: boolean): void {
		if (active) {
			if (!this.thinkingAnimationTimer) {
				this.thinkingAnimationTimer = setInterval(() => {
					this.thinkingAnimationTick += 1;
					this.tui.requestRender();
				}, 80);
				this.thinkingAnimationTimer.unref?.();
			}
			return;
		}
		this.stopThinkingAnimation();
	}

	private stopThinkingAnimation(): void {
		if (!this.thinkingAnimationTimer) {
			return;
		}
		clearInterval(this.thinkingAnimationTimer);
		this.thinkingAnimationTimer = undefined;
		this.thinkingAnimationTick = 0;
	}

	private wrapBlock(text: string, innerWidth: number): string[] {
		const wrapped = wrapTextWithAnsi(text || " ", Math.max(1, innerWidth));
		return wrapped.map((line) => truncateToWidth(line, innerWidth, "", true));
	}

	private row(content: string, innerWidth: number): string {
		content = truncateToWidth(content, innerWidth, "", true);
		const visible = visibleWidth(content);
		const padded = content + " ".repeat(Math.max(0, innerWidth - visible));
		const bg = this.overlayBackground(padded);
		return `${this.theme.fg("borderMuted", "│")} ${bg} ${this.theme.fg("borderMuted", "│")}`;
	}

	private borderTop(innerWidth: number): string {
		return this.theme.fg("borderAccent", `╭${"─".repeat(innerWidth + 2)}╮`);
	}

	private borderBottom(innerWidth: number): string {
		return this.theme.fg("borderAccent", `╰${"─".repeat(innerWidth + 2)}╯`);
	}

	private overlayBackground(text: string): string {
		return jarvisSurface(this.theme, text, "chrome");
	}
}

function sanitizeOverlayDisplayText(text: string): string {
	return text
		.replace(/\r/g, "")
		.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.replace(/\t/g, "    ");
}

function sanitizeInlineText(text: string): string {
	return sanitizeOverlayDisplayText(text).replace(/\n/g, " ");
}

export function attachOverlayBridge(component: JarvisOverlayComponent, _bridge: JarvisOverlayBridge, _tui: TUI): JarvisOverlayComponent {
	component.attachBridge();
	return component;
}

export function cursorMarkerPresent(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes(CURSOR_MARKER));
}
