import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, CURSOR_MARKER, getKeybindings, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

export interface JarvisDisplayEntry {
	kind: "user" | "assistant" | "tool" | "system" | "status";
	text: string;
}

export interface JarvisOverlayView {
	isReady(): boolean;
	isStreaming(): boolean;
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

interface TranscriptBlock {
	lines: string[];
	preserveHeaderWhenClipped: boolean;
}

export class JarvisOverlayBridge {
	private requestRender?: () => void;
	private statuses = new Map<string, string>();
	private notifications: NotificationItem[] = [];
	private workingMessage?: string;
	private pendingConfirmation?: PendingConfirmationRecord;

	reset(): void {
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
	private readonly input = new Input({ prompt: "" });
	private readonly maxHeightProvider: () => number;
	private focusTarget: OverlayFocusTarget = "input";
	private historyIndex = -1;
	private historyDraft = "";
	private historyEntries: string[] = [];
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

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly bridge: JarvisOverlayBridge,
		private readonly view: JarvisOverlayView,
		private readonly close: () => void,
		private readonly keybindings: KeybindingsManager = getKeybindings(),
	) {
		this.maxHeightProvider = () => Math.max(0, Math.min(this.tui.terminal.rows, Math.max(1, Math.floor(this.tui.terminal.rows * 0.78))));

		this.input.onSubmit = (value) => {
			const message = sanitizeInlineText(value).trim();
			if (!message) {
				return;
			}
			this.input.setValue("");
			this.historyIndex = -1;
			this.historyDraft = "";
			try {
				void Promise.resolve(this.view.sendMessage(message)).catch((error: unknown) => {
					if (!this.disposed) this.bridge.notify(String(error), "error");
				});
			} catch (error) {
				this.bridge.notify(String(error), "error");
			}
		};
		this.input.onEscape = () => {
			this.dispose();
		};
	}

	attachBridge(): void {
		if (this.disposed) return;
		this.releaseBridge?.();
		this.releaseBridge = this.bridge.attach(() => this.tui.requestRender());
	}

	handleInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		try {
			this.handleKey(data);
		} finally {
			this.input.invalidate();
			this.tui.requestRender();
		}
	}

	private handleKey(data: string): void {
		const kb = this.keybindings;
		if (this.bridge.hasPendingConfirmation()) {
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

		const up = kb.matches(data, "tui.editor.historyPrevious") || kb.matches(data, "tui.editor.cursorUp");
		const down = kb.matches(data, "tui.editor.historyNext") || kb.matches(data, "tui.editor.cursorDown");
		if (up || down) {
			const entries = this.view.getDisplayEntries().filter((e) => e.kind === "user").map((e) => sanitizeInlineText(e.text));
			if (entries.length !== this.historyEntries.length || entries.some((text, i) => text !== this.historyEntries[i])) {
				if (this.historyIndex !== -1) this.input.setValue(this.historyDraft);
				this.historyIndex = -1;
				this.historyEntries = entries;
			}
			if (entries.length === 0) return;
			if (up) {
				if (this.historyIndex === -1) {
					this.historyDraft = this.input.getValue();
					this.historyIndex = entries.length - 1;
				} else {
					this.historyIndex = Math.max(0, this.historyIndex - 1);
				}
				this.input.setValue(entries[this.historyIndex]!);
			} else if (this.historyIndex !== -1) {
				this.historyIndex++;
				if (this.historyIndex >= entries.length) {
					this.historyIndex = -1;
					this.input.setValue(this.historyDraft);
				} else {
					this.input.setValue(entries[this.historyIndex]!);
				}
			}
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== before) this.historyIndex = -1;
	}

	render(width: number): string[] {
		if (this.disposed) return [];
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
			return [truncateToWidth(hasConfirmation ? "Enlarge to review; Esc cancel" : this.renderInputLine(width), width, "", true)];
		}
		const innerWidth = width - 4;
		const maxBodyLines = maxHeight - 2;
		let promptSectionLines: string[];
		if (snapshot.pendingConfirmation) {
			promptSectionLines = this.renderConfirmation(snapshot.pendingConfirmation, innerWidth, maxBodyLines);
		} else {
			promptSectionLines = [
				this.sectionDivider("Prompt", innerWidth),
				this.renderInputLine(innerWidth),
				truncateToWidth(this.theme.fg("dim", `${this.keyLabel("tui.input.tab")} cycle • ${this.keyLabel("tui.input.submit")} send/toggle • space toggle • ${this.keyLabel("tui.select.cancel")} close`), innerWidth, "", true),
			];
			if (maxBodyLines === 1) promptSectionLines = [this.renderInputLine(innerWidth)];
			else promptSectionLines = promptSectionLines.slice(-maxBodyLines);
		}
		let remainingLines = Math.max(0, maxBodyLines - promptSectionLines.length);
		const header = this.renderHeader(innerWidth);
		const topSections = remainingLines >= header.length ? header : remainingLines >= 2
			? [...header.slice(0, remainingLines - 1), header[header.length - 1]!]
			: header.slice(0, remainingLines);
		remainingLines -= topSections.length;
		const notificationLines = this.notificationLines(snapshot.notifications, innerWidth);
		if (remainingLines > 0) {
			const notices = notificationLines.slice(-remainingLines);
			topSections.push(...notices);
			remainingLines -= notices.length;
		}
		this.syncThinkingAnimation(Boolean(!hasConfirmation && remainingLines > 1 && snapshot.workingMessage && this.view.isStreaming()));
		if (remainingLines > 0) {
			topSections.push(this.sectionDivider("Conversation", innerWidth));
			topSections.push(...this.renderTranscript(innerWidth, remainingLines - 1, snapshot));
		}
		return [this.borderTop(innerWidth),
			...[...topSections, ...promptSectionLines].slice(0, maxBodyLines).map((line) => this.row(line, innerWidth)),
			this.borderBottom(innerWidth)];
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
		this.confirmationCanApprove = false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.input.focused = false;
		this.stopThinkingAnimation();
		const ownsInteraction = this.releaseBridge?.() ?? true;
		if (ownsInteraction) {
			this.bridge.resolveConfirmation(false);
			this.close();
		}
	}

	private renderHeader(innerWidth: number): string[] {
		const mainStatus = sanitizeInlineText(this.view.getMainStatusLabel());
		const mainStatusColor = mainStatus === "busy" ? "warning" : "success";
		const toolsToggle = this.renderToggle("Repo tools", this.view.isToolAccessEnabled(), this.focused && this.focusTarget === "tools");
		const followUpToggle = this.renderToggle("Note main", this.view.isFollowUpToMainEnabled(), this.focused && this.focusTarget === "followUp");
		const steerToggle = this.renderToggle("Redirect", this.view.isSteerToMainEnabled(), this.focused && this.focusTarget === "steer");
		const mainModel = sanitizeInlineText(this.view.getMainModelLabel());
		const sideModel = sanitizeInlineText(this.view.getModelLabel());
		const modelMode = sanitizeInlineText(this.view.getModelModeLabel());
		const focus = sanitizeInlineText(this.view.getMainFocusLabel());
		const delta = sanitizeInlineText(this.view.getMainDeltaLabel());
		const repoToolsDetail = sanitizeInlineText(this.view.getRepoToolsDetailLabel());
		// Keep the active control visible first when a narrow row cannot fit all three.
		const toggles = this.focusTarget === "followUp" ? [followUpToggle, steerToggle, toolsToggle]
			: this.focusTarget === "steer" ? [steerToggle, toolsToggle, followUpToggle]
				: [toolsToggle, followUpToggle, steerToggle];
		return [
			truncateToWidth(
				`${this.theme.bold(this.theme.fg("accent", "Jarvis"))} ${this.theme.fg("muted", "·")} ${this.theme.fg("accent", "Main")} ${this.theme.fg(mainStatusColor, mainStatus)}`,
				innerWidth,
			),
			truncateToWidth(this.theme.fg("muted", `Focus: ${focus}`), innerWidth, "", true),
			truncateToWidth(this.theme.fg("muted", `Since last: ${delta}`), innerWidth, "", true),
			truncateToWidth(this.theme.fg("muted", `Access: ${repoToolsDetail}`), innerWidth, "", true),
			truncateToWidth(
				`${this.theme.fg("muted", "Models:")} ${this.theme.fg("muted", `main ${mainModel}  ·  jarvis ${sideModel} (${modelMode})`)}` ,
				innerWidth,
				"",
				true,
			),
			truncateToWidth(toggles.join("  "), innerWidth, "", true),
		];
	}

	private renderTranscript(innerWidth: number, budget: number, snapshot: JarvisOverlaySnapshot): string[] {
		if (budget <= 0) {
			return [];
		}

		const blocks: TranscriptBlock[] = [];
		const displayEntries = this.view.getDisplayEntries();
		const showAnimatedThinkingFallback = Boolean(snapshot.workingMessage && this.view.isStreaming());
		let previousKind: JarvisDisplayEntry["kind"] | undefined;
		for (const entry of displayEntries) {
			if (
				previousKind !== undefined && previousKind !== entry.kind && previousKind !== "system" && entry.kind !== "system"
			) {
				blocks.push({ lines: [""], preserveHeaderWhenClipped: false });
			}
			blocks.push(this.createTranscriptBlock(this.renderEntry(entry, innerWidth), entry.kind !== "system"));
			previousKind = entry.kind;
		}
		if (showAnimatedThinkingFallback) {
			blocks.push(this.createTranscriptBlock(this.renderAnimatedThinkingFallback(innerWidth, snapshot.workingMessage!), false));
		}
		for (const status of snapshot.statuses) {
			blocks.push(this.createTranscriptBlock(this.wrapBlock(sanitizeOverlayDisplayText(status), innerWidth), false));
		}
		return this.clipTranscriptBlocks(blocks, budget);
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

	private renderInputLine(innerWidth: number): string {
		const prefix = innerWidth >= 2 ? `${this.theme.fg("accent", "›")} ` : "";
		const safeValue = sanitizeInlineText(this.input.getValue());
		if (safeValue !== this.input.getValue()) this.input.setValue(safeValue);
		const inputWidth = Math.max(1, innerWidth - visibleWidth(prefix));
		const rendered = this.input.render(inputWidth)[0] ?? "";
		return truncateToWidth(prefix + rendered, innerWidth, "", true);
	}

	private createTranscriptBlock(lines: string[], preserveHeaderWhenClipped: boolean): TranscriptBlock {
		return { lines, preserveHeaderWhenClipped };
	}

	private clipTranscriptBlocks(blocks: readonly TranscriptBlock[], budget: number): string[] {
		const visible: string[] = [];
		let remaining = budget;
		for (let i = blocks.length - 1; i >= 0 && remaining > 0; i--) {
			const block = blocks[i];
			if (block.lines.length <= remaining) {
				visible.unshift(...block.lines);
				remaining -= block.lines.length;
				continue;
			}
			visible.unshift(...this.clipTranscriptBlock(block, remaining));
			break;
		}
		return visible;
	}

	private clipTranscriptBlock(block: TranscriptBlock, budget: number): string[] {
		if (block.lines.length <= budget) {
			return [...block.lines];
		}
		if (block.preserveHeaderWhenClipped && budget > 1) {
			return [block.lines[0] ?? "", ...block.lines.slice(-(budget - 1))];
		}
		return block.lines.slice(-budget);
	}

	private notificationLines(items: readonly NotificationItem[], innerWidth: number): string[] {
		const recent = items.slice(-2);
		const lines: string[] = [];
		for (const item of recent) {
			const color = item.type === "error" ? "error" : item.type === "warning" ? "warning" : "muted";
			lines.push(this.sectionDivider("Notice", innerWidth));
			lines.push(...this.wrapBlock(this.theme.fg(color, sanitizeOverlayDisplayText(item.message)), innerWidth));
		}
		return lines;
	}

	private sectionDivider(label: string, innerWidth: number): string {
		const plain = ` ${label} `;
		const fillWidth = Math.max(0, innerWidth - plain.length);
		const left = Math.floor(fillWidth / 2);
		const right = fillWidth - left;
		return truncateToWidth(this.theme.fg("borderMuted", `${"─".repeat(left)}${plain}${"─".repeat(right)}`), innerWidth, "", true);
	}

	private renderToggle(label: string, enabled: boolean, focused: boolean): string {
		const text = `${label}: ${enabled ? "on" : "off"}`;
		const rendered = this.theme.fg(enabled ? "success" : "muted", text);
		return focused ? this.theme.bold(`[${rendered}]`) : rendered;
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

	private renderAnimatedThinkingFallback(innerWidth: number, message: string): string[] {
		const icons = ["◈", "◆", "◇", "✦", "✧", "✦"];
		const icon = icons[this.thinkingAnimationTick % icons.length] ?? "◈";
		const shimmerText = this.renderShimmeringThinkingText(sanitizeOverlayDisplayText(message));
		return this.wrapBlock(`${this.theme.bold(this.theme.fg("accent", icon))} ${shimmerText}`, innerWidth);
	}

	private renderShimmeringThinkingText(text: string): string {
		const chars = [...text];
		if (chars.length === 0) {
			return "";
		}
		const highlightIndex = this.thinkingAnimationTick % chars.length;
		return chars
			.map((char, index) => {
				const distance = Math.abs(index - highlightIndex);
				const color = distance === 0
					? [232, 239, 247]
					: distance === 1
						? [171, 182, 198]
						: [112, 122, 138];
				return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${char}`;
			})
			.join("") + "\x1b[0m";
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
		return `\x1b[48;2;24;28;36m${text}\x1b[0m`;
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
