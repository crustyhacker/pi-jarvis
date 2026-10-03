import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { JarvisDraftEditor } from "./draft-editor.js";
import { renderJarvisHeader, renderJarvisActivity } from "./overlay-layout.js";
import { TranscriptViewport } from "./transcript-viewport.js";

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

type NotificationType = "info" | "warning" | "error";
type OverlayFocusTarget = "input" | "tools" | "followUp" | "steer";

const OVERLAY_FOCUS_ORDER: readonly OverlayFocusTarget[] = ["input", "tools", "followUp", "steer"];

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
	private thinkingAnimationTick = 0;
	private thinkingAnimationTimer?: NodeJS.Timeout;
	private transcriptCacheWidth = -1;
	private transcriptCache: Array<{ kind: JarvisDisplayEntry["kind"]; text: string; lines: string[] }> = [];
	private transcriptLines: string[] = [];
	private transcriptContinuationLabels: Array<string | undefined> = [];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly bridge: JarvisOverlayBridge,
		private readonly view: JarvisOverlayView,
		private readonly close: () => void,
		private readonly keybindings: KeybindingsManager = getKeybindings(),
	) {
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
		this.releaseBridge = this.bridge.attach(() => this.tui.requestRender());
	}

	handleInput(data: string): void {
		if (this.disposed) return;
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
		if (this.input.handlePasteInput(data, hasConfirmation)) {
			if (!hasConfirmation) this.focusTarget = "input";
			return;
		}
		if (isKeyRelease(data)) return;
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
		if (kb.matches(data, "tui.select.cancel")) {
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
		this.input.focused = this.focused && !hasConfirmation && this.focusTarget === "input";
		this.renderedRows = this.tui.terminal.rows;
		this.renderedColumns = this.tui.terminal.columns;
		this.confirmationCanApprove = false;
		if (width === 0 || maxHeight === 0) {
			this.stopThinkingAnimation();
			return [];
		}
		if (width < 5 || maxHeight < 3) {
			this.stopThinkingAnimation();
			return hasConfirmation ? [truncateToWidth("Enlarge to review; Esc cancel", width, "", true)] : this.renderInputLines(width, 1);
		}
		const innerWidth = width - 4;
		const maxBodyLines = maxHeight - 2;
		if (snapshot.pendingConfirmation) {
			this.stopThinkingAnimation();
			return [this.borderTop(innerWidth),
				...this.renderConfirmation(snapshot.pendingConfirmation, innerWidth, maxBodyLines).map((line) => this.row(line, innerWidth)),
				this.borderBottom(innerWidth)];
		}

		const inputLines = this.renderInputLines(innerWidth, Math.max(1, Math.min(5, Math.floor(maxBodyLines / 4))));
		const footerLines = maxBodyLines >= 10 ? [
			`${this.keyLabel("tui.input.submit")} send • ${this.keyLabel("tui.input.newLine")} newline • ${this.keyLabel("tui.input.tab")} access • ${this.keyLabel("tui.select.cancel")} close`,
			snapshot.notifications.length ? "ctrl+l dismiss notice • ctrl+o details • ctrl+end live"
				: `${this.keyLabel("tui.editor.pageUp")}/${this.keyLabel("tui.editor.pageDown")} scroll • ctrl+end live • ctrl+o details`,
		] : maxBodyLines >= 3 ? [`${this.keyLabel("tui.input.submit")} send • ${this.keyLabel("tui.input.newLine")} newline • ${this.keyLabel("tui.select.cancel")} close`] : [];
		const promptSection = [
			...(maxBodyLines >= 7 ? [this.sectionDivider("Message", innerWidth)] : []),
			...inputLines,
			...footerLines.map((line) => truncateToWidth(this.theme.fg("dim", line), innerWidth, "", true)),
		];
		let remaining = Math.max(0, maxBodyLines - promptSection.length);
		const header = renderJarvisHeader(this.theme, this.view, innerWidth, {
			expanded: this.expandedDetails, focusTarget: this.focusTarget, focused: this.focused,
		});
		// Keep a transcript row on normal terminals; keep the focused access
		// control available even on short ones. Details never consume the editor.
		const headerBudget = Math.min(header.length, Math.max(0, remaining - (remaining >= 5 ? 3 : 0)));
		const top: string[] = headerBudget >= header.length ? header : headerBudget >= 2
			? [...header.slice(0, headerBudget - 1), header[header.length - 1]!]
			: headerBudget === 1 ? [this.focusTarget === "input" ? header[0]! : header[header.length - 1]!] : [];
		remaining -= top.length;
		const active = Boolean(this.view.getIsProcessing?.() || this.view.isStreaming());
		this.syncThinkingAnimation(active && remaining > 0);
		if (remaining > 0) {
			const icon = active ? ["◈", "◆", "◇", "✦"][this.thinkingAnimationTick % 4] + " " : "";
			top.push(truncateToWidth(this.theme.fg("accent", icon) + renderJarvisActivity(this.theme, snapshot, this.view, innerWidth), innerWidth, "", true));
			remaining -= 1;
		}
		if (remaining > 2 && snapshot.notifications.length) {
			const notices = this.notificationLines(snapshot.notifications, innerWidth);
			const count = Math.min(this.expandedDetails ? 4 : 1, notices.length, remaining - 2);
			const visibleNotices = notices.slice(0, count);
			if (count < notices.length) visibleNotices[count - 1] = truncateToWidth(visibleNotices[count - 1]!, innerWidth - 1, "", true) + this.theme.fg("dim", "…");
			top.push(...visibleNotices);
			remaining -= count;
		}
		if (remaining > 0) {
			const transcript = this.renderTranscript(innerWidth, Math.max(0, remaining - 1), snapshot);
			const position = this.viewport.getStatus();
			const label = position.following ? "Conversation · live" : `History · ${position.hiddenBelow} lines below · ctrl+end live`;
			top.push(this.sectionDivider(label, innerWidth), ...transcript);
		}
		return [this.borderTop(innerWidth), ...[...top, ...promptSection].slice(0, maxBodyLines).map((line) => this.row(line, innerWidth)), this.borderBottom(innerWidth)];
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
		this.transcriptCacheWidth = -1;
		this.confirmationCanApprove = false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
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
			this.transcriptContinuationLabels = [];
			const cache: typeof this.transcriptCache = [];
			const labels = { user: "User:", assistant: "Jarvis:", tool: "Tool:", status: "Note:", system: "" };
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i]!;
				const previous = this.transcriptCache[i];
				const block = previous?.kind === entry.kind && previous.text === entry.text ? previous.lines : this.renderEntry(entry, innerWidth);
				cache.push({ ...entry, lines: block });
				if (i > 0 && entries[i - 1]!.kind !== entry.kind) { this.transcriptLines.push(""); this.transcriptContinuationLabels.push(undefined); }
				for (let j = 0; j < block.length; j++) {
					this.transcriptLines.push(block[j]!);
					this.transcriptContinuationLabels.push(j > 0 ? labels[entry.kind] || undefined : undefined);
				}
			}
			this.transcriptCache = cache;
		}
		const visible = this.viewport.render(this.transcriptLines, budget, innerWidth);
		const start = this.viewport.getStatus().startLine;
		const label = this.transcriptContinuationLabels[start];
		if (label && visible.length) visible[0] = truncateToWidth(`${this.theme.fg("muted", label)} ${visible[0]!.trimStart()}`, innerWidth, "", true);
		return visible;
	}

	private renderEntry(entry: JarvisDisplayEntry, innerWidth: number): string[] {
		const safeText = sanitizeOverlayDisplayText(entry.text);
		switch (entry.kind) {
			case "user":
				return this.wrapWithPrefix(this.theme.fg("accent", "User:"), safeText, innerWidth);
			case "assistant":
				return this.wrapWithPrefix(this.theme.fg("success", "Jarvis:"), safeText, innerWidth);
			case "tool":
				return this.wrapWithPrefix(this.theme.fg("warning", "Tool:"), safeText, innerWidth);
			case "status":
				return this.wrapWithPrefix(this.theme.fg("muted", "Note:"), safeText, innerWidth);
			case "system":
			default:
				return this.wrapBlock(this.theme.fg("muted", safeText), innerWidth);
		}
	}

	private renderInputLines(innerWidth: number, maxLines: number): string[] {
		const prefix = innerWidth >= 3 ? `${this.theme.fg("accent", "›")} ` : "";
		const inputWidth = Math.max(1, innerWidth - visibleWidth(prefix));
		return this.input.render(inputWidth, maxLines).map((line, index) => truncateToWidth(
			(index === 0 ? prefix : " ".repeat(visibleWidth(prefix))) + line, innerWidth, "", true,
		));
	}

	private notificationLines(items: readonly NotificationItem[], innerWidth: number): string[] {
		const item = items.at(-1);
		if (!item) return [];
		const color = item.type === "error" ? "error" : item.type === "warning" ? "warning" : "muted";
		const label = item.type === "error" ? "Error" : item.type === "warning" ? "Warning" : "Notice";
		return this.wrapBlock(this.theme.fg(color, `${label}: ${sanitizeOverlayDisplayText(item.message)}`), innerWidth);
	}

	private sectionDivider(label: string, innerWidth: number): string {
		const plain = ` ${label} `;
		const fillWidth = Math.max(0, innerWidth - plain.length);
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

	private wrapWithPrefix(prefix: string, text: string, innerWidth: number): string[] {
		const indentWidth = Math.min(innerWidth - 1, Math.max(7, visibleWidth(prefix) + 2));
		const wrapped = wrapTextWithAnsi(text || " ", Math.max(1, innerWidth - indentWidth));
		return wrapped.map((line, index) => {
			const label = index === 0 ? prefix : " ".repeat(Math.max(0, visibleWidth(prefix) + 1));
			return truncateToWidth(`${label} ${line}`, innerWidth, "", true);
		});
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
		return typeof this.theme.bg === "function" ? this.theme.bg("customMessageBg", text) : text;
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
