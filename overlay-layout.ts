import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { JarvisOverlaySnapshot, JarvisOverlayView } from "./overlay.js";

export interface JarvisHeaderOptions {
	expanded: boolean;
	focusTarget: "input" | "tools" | "followUp" | "steer" | "model" | "thinking" | "history";
	focused: boolean;
	/** Pre-rendered side activity; idle Ready is deliberately omitted by the caller. */
	activity?: string;
	infoNotice?: boolean;
}

interface PermissionControl {
	target: "tools" | "followUp" | "steer";
	label: string;
	enabled: boolean;
}

/**
 * Stateless, width-bounded header. Details are opt-in and the permission row is
 * always last, so the overlay can retain it when applying a height budget.
 * Call with the content width (excluding the overlay's border/padding).
 */
export function renderJarvisHeader(
	theme: Theme,
	view: JarvisOverlayView,
	width: number,
	options: JarvisHeaderOptions,
): string[] {
	width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (width === 0) return [];

	const sideModel = inlineText(view.getModelLabel()) || "unknown";
	const status = inlineText(view.getMainStatusLabel()) || "unknown";
	const statusColor = status === "busy" ? "warning" : status === "idle" ? "success" : "muted";
	const title = theme.bold(theme.fg("accent", "Jarvis"));
	const main = theme.fg("muted", "Main");
	const state = theme.fg(statusColor, status);
	const separator = theme.fg("dim", " · ");
	const headings = [
		`${title}${separator}${main} ${state}`,
		`${title}${separator}${state}`,
		`${title} ${state}`,
		`${main} ${state}`,
		state,
	];
	let heading = headings.find((candidate) => visibleWidth(candidate) <= width) ?? fit(state, width, "");
	if (options.activity) {
		heading = fit(`${heading}${separator}${options.activity}`, width);
	}
	// Drop only the provider prefix. Keep model IDs that themselves contain '/'.
	const compactModel = sideModel.slice(sideModel.indexOf("/") + 1) || sideModel;
	const modelWidth = width - visibleWidth(heading) - visibleWidth(separator);
	if (modelWidth >= Math.min(4, visibleWidth(compactModel))) {
		heading += separator + theme.fg("muted", fitPlain(compactModel, modelWidth));
	}

	if (options.infoNotice && visibleWidth(heading) + 9 <= width) heading += theme.fg("dim", " · notice");
	const lines = [fit(heading, width)];
	if (options.expanded) {
		const mode = inlineText(view.getModelModeLabel());
		lines.push(
			fit(theme.fg("muted", `Focus: ${inlineText(view.getMainFocusLabel()) || "idle"}`), width),
			fit(theme.fg("muted", `Main model: ${inlineText(view.getMainModelLabel()) || "unknown"}`), width),
			fit(theme.fg("muted", `Jarvis model: ${sideModel}${mode ? ` (${mode})` : ""}`), width),
			fit(theme.fg("muted", `Since last: ${inlineText(view.getMainDeltaLabel()) || "unchanged"}`), width),
			fit(theme.fg("muted", `Access: ${inlineText(view.getRepoToolsDetailLabel()) || "unknown"}`), width),
		);
	}
	lines.push(renderPermissions(theme, [
		{ target: "tools", label: "Repo tools", enabled: view.isToolAccessEnabled() },
		{ target: "followUp", label: "Note main", enabled: view.isFollowUpToMainEnabled() },
		{ target: "steer", label: "Redirect", enabled: view.isSteerToMainEnabled() },
	], width, options));
	return lines;
}

/** Width-aware selector/history controls; never hide the focused target. */
export function renderJarvisControls(theme: Theme, view: JarvisOverlayView, width: number, options: JarvisHeaderOptions): string {
	width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (!width) return "";
	const model = options.expanded ? inlineText(view.getModelModeLabel()) : "";
	const thinking = options.expanded ? inlineText(view.getThinkingLabel?.() ?? "") : compactThinking(view.getThinkingLabel?.() ?? "");
	const controls = [
		{ target: "model", label: "F2 Model", detail: model },
		{ target: "thinking", label: "F3 Thinking", detail: thinking },
		{ target: "history", label: "History ↑/↓", detail: "" },
	];
	const selected = controls.findIndex((control) => control.target === options.focusTarget);
	const ordered = selected > 0 ? [...controls.slice(selected), ...controls.slice(0, selected)] : controls;
	const render = (control: typeof controls[number], detail: boolean) => {
		const label = control.label + (detail && control.detail ? `: ${control.detail}` : "");
		return options.focused && options.focusTarget === control.target ? theme.bold(theme.fg("accent", `[${label}]`)) : theme.fg("muted", label);
	};
	for (const detailTargets of [new Set(["model", "thinking"]), new Set([selected < 0 ? "thinking" : options.focusTarget]), new Set<string>()]) {
		const row = ordered.map((control) => render(control, detailTargets.has(control.target))).join(theme.fg("dim", " • "));
		if (visibleWidth(row) <= width) return row;
	}
	// At typical inner widths retain both picker shortcuts. History/Tab paths
	// are also explained by the always-visible keyboard hints.
	return fit(ordered.slice(0, 2).map((control) => render(control, false)).join(" • "), width, "");
}

/**
 * One independent activity row, without animation, notices or transcript text.
 * Priority: startup, streaming/processing, waiting queue, ready. A working
 * message is shown only during active work; queue counts exclude the active
 * request. The overlay owns reserving space for this row and any notices.
 */
export function renderJarvisActivity(
	theme: Theme,
	snapshot: JarvisOverlaySnapshot,
	view: JarvisOverlayView,
	width: number,
): string {
	width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (width === 0) return "";

	const ready = view.isReady();
	const streaming = view.isStreaming();
	const processing = view.getIsProcessing?.() ?? false;
	const waiting = view.getQueuedMessageCount?.() ?? 0;
	const queued = Number.isFinite(waiting) ? Math.max(0, Math.floor(waiting)) : 0;
	const active = streaming || processing;
	const label = !ready ? active ? "Starting Jarvis…" : queued > 0 ? "Waiting to start…" : "Not ready"
		: streaming ? "Working…" : processing ? "Processing…"
		: queued > 0 ? `${queued} queued` : "Ready";
	const color = !ready || (!active && queued > 0) ? "warning" : active ? "accent" : "success";
	const separator = theme.fg("dim", " · ");
	let row = theme.fg(color, label);
	if (queued > 0 && (!ready || active)) row += separator + theme.fg("muted", `${queued} queued`);
	// Keep state and waiting count before potentially lengthy custom work text.
	const message = active && ready ? inlineText(snapshot.workingMessage ?? "") : "";
	const detailWidth = width - visibleWidth(row) - visibleWidth(separator);
	if (message && message !== label && detailWidth >= Math.min(4, visibleWidth(message))) {
		row += separator + theme.fg("muted", fitPlain(message, detailWidth));
	}
	return fit(row, width);
}

/** Presentation-only summary of the public full thinking label, never configuration. */
function compactThinking(label: string): string {
	const safe = inlineText(label);
	return /\beffective\s+([^;)]+)/i.exec(safe)?.[1]?.trim()
		?? safe.split(/→|->/).at(-1)?.replace(/^thinking\s+/i, "").trim() ?? "";
}

/**
 * Quiet surfaces derived from the active theme, not a fixed purple panel.
 * Resolve on every call: theme invalidation may replace concrete token colors.
 * Older minimal themes used by hosts/fixtures retain semantic bg fallbacks.
 */
export function jarvisSurface(theme: Theme, text: string, surface: "chrome" | "conversation" | "prompt"): string {
	if (typeof theme.style === "function" && theme.colors) {
		const base = theme.colors.toolPendingBg;
		const ink = theme.colors.text;
		const neutral = mixColors(base, ink, theme.appearance === "light" ? 0.02 : 0.035);
		const bg = surface === "chrome" ? base : surface === "conversation" ? neutral
			: mixColors(base, theme.colors.userMessageBg, 0.45);
		return theme.style(text, { bg, ...(surface === "conversation" ? { fg: "text" as const } : {}) });
	}
	return typeof theme.bg === "function" ? theme.bg(surface === "prompt" ? "userMessageBg" : "toolPendingBg", text) : text;
}

function renderPermissions(theme: Theme, controls: PermissionControl[], width: number, options: JarvisHeaderOptions): string {
	const render = (control: PermissionControl, text: string) => {
		const styled = theme.fg(control.enabled ? "success" : "muted", text);
		return options.focused && options.focusTarget === control.target ? theme.bold(styled) : styled;
	};
	const text = (control: PermissionControl, compact = false) => {
		const value = `${control.label}${compact ? " " : ": "}${control.enabled ? "on" : "off"}`;
		return options.focused && options.focusTarget === control.target ? `[${value}]` : value;
	};
	const fullRow = controls.map((control) => render(control, text(control))).join("  ");
	if (visibleWidth(fullRow) <= width) return fullRow;

	// On narrow terminals prefer the selected control, not a clipped third label.
	const selected = controls.findIndex((control) => control.target === options.focusTarget);
	const ordered = selected > 0 ? [...controls.slice(selected), ...controls.slice(0, selected)] : controls;
	const first = ordered[0]!;
	const focused = options.focused && options.focusTarget === first.target;
	const candidates = [text(first), text(first, true), focused ? `[${first.label}]` : first.label, first.label];
	const firstText = candidates.find((candidate) => visibleWidth(candidate) <= width)
		?? (focused ? width === 1 ? "[" : `[${fitPlain(first.label, width - 2, "")}]` : fitPlain(first.label, width, ""));
	let row = render(first, firstText);
	let shown = 1;
	for (const control of ordered.slice(1)) {
		const next = render(control, text(control));
		if (visibleWidth(row) + 2 + visibleWidth(next) > width) break;
		row += `  ${next}`;
		shown++;
	}
	if (shown < controls.length && visibleWidth(row) + 2 <= width) row += theme.fg("dim", " …");
	return fit(row, width, "");
}

function fit(text: string, width: number, ellipsis = "…"): string {
	return truncateToWidth(text, Math.max(0, width), ellipsis);
}

// Pi truncation may append an ANSI reset even to plain text. Remove it before
// applying the caller's semantic theme.
function fitPlain(text: string, width: number, ellipsis = "…"): string {
	return stripTerminalSequences(fit(text, width, ellipsis));
}

/** Strip untrusted terminal payloads before styling; preserve grapheme text. */
function inlineText(text: string): string {
	return text
		.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t\u2028\u2029]/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
		.replace(/ +/g, " ")
		.trim();
}
