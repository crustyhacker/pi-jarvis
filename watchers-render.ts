import { relative, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { keyText, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WatcherCondition, WatcherRecord, WatcherRequest } from "./watchers-types.js";

export type WatcherDisplay = Pick<WatcherRecord, "label" | "condition" | "cwd" | "intervalSeconds" | "createdAt" | "deadline" | "command" | "state" | "reason">;
interface WatcherRenderState { display?: WatcherDisplay; }
const singleLine = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
function displayPath(path: string, cwd: string): string {
	const local = relative(cwd, resolve(cwd, path));
	return singleLine(local && local !== ".." && !local.startsWith("../") ? local : path);
}
export function watcherConditionWords(condition: WatcherCondition, cwd: string): string {
	switch (condition.kind) {
		case "file_lines": return typeof condition.path === "string" && condition.minLines !== undefined ? `file ${displayPath(condition.path, cwd)} reaches ${condition.minLines} lines` : "File line-count condition (preparing…)";
		case "path_quiet": return typeof condition.path === "string" && condition.quietMinutes !== undefined ? `path ${displayPath(condition.path, cwd)} stays unchanged for ${condition.quietMinutes} minutes (metadata)` : "Path quiet condition (preparing…)";
		case "command": {
			if (typeof condition.command !== "string") return "Command condition (preparing…)";
			const command = singleLine(condition.command);
			return `command succeeds (exit 0): ${command.length > 120 ? `${command.slice(0, 117)}…` : command}`;
		}
	}
}
function displayFrom(value: unknown): WatcherDisplay | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as { watcherDisplay?: WatcherDisplay } & Partial<WatcherDisplay>;
	if (data.watcherDisplay) return displayFrom(data.watcherDisplay);
	if (typeof data.label !== "string" || !data.condition || !["command", "file_lines", "path_quiet"].includes(data.condition.kind)
		|| typeof data.cwd !== "string" || typeof data.command !== "string" || typeof data.intervalSeconds !== "number" || typeof data.createdAt !== "number" || typeof data.deadline !== "number") return undefined;
	return data as WatcherDisplay;
}
export function renderWatcherBlock(display: WatcherDisplay, theme: Theme, expanded = false): Text {
	// Headless/export renderers may not have Pi's application bindings installed.
	// Label the default honestly; never change bindings or force expansion state.
	const expandKey = keyText("app.tools.expand") || "ctrl+o (default)";
	const summary = [
		`Watcher · ${singleLine(display.label)}${display.state ? ` · ${display.state}${display.reason ? ` (${display.reason})` : ""}` : ""}`,
		watcherConditionWords(display.condition, display.cwd),
		`Every ${display.intervalSeconds}s · time limit ${(display.deadline - display.createdAt) / 1000}s`,
		`Working directory: ${singleLine(display.cwd)}`,
		`Full launch/repeat command: ${display.command.split("\n").length} lines · ${expandKey} to ${expanded ? "collapse" : "expand"}`,
	];
	// Use a semantic accent, not added-code/success green or hard-coded ANSI/RGB.
	// Only presentation changes: append the original string with no quoting,
	// indentation, line numbering, truncation or regenerated supervisor program.
	const text = summary.map(line => theme.fg("accent", line)).join("\n")
		+ (expanded ? `\n${theme.fg("accent", display.command)}` : "");
	return new Text(text, 0, 0);
}
export const watcherSetRenderers: Pick<ToolDefinition<any, any, WatcherRenderState>, "renderCall" | "renderResult"> = {
	renderCall(value, theme, context) {
		const args = value && typeof value === "object" ? value as Partial<WatcherRequest> : {};
		// Until execution prepares the immutable command, show only human intent.
		// The progress/result slot owns the expandable command, so it appears once.
		if (context.state.display) return new Text("", 0, 0);
		const lines = [`Watcher · ${singleLine(args.label ?? "setting…")}`];
		if (args.condition) lines.push(watcherConditionWords(args.condition, context.cwd));
		if (args.intervalSeconds !== undefined && args.timeoutSeconds !== undefined) lines.push(`Every ${args.intervalSeconds}s · time limit ${args.timeoutSeconds}s`);
		lines.push(`Working directory: ${singleLine(context.cwd)}`);
		return new Text(lines.map(line => theme.fg("accent", line)).join("\n"), 0, 0);
	},
	renderResult(result, { expanded }, theme, context) {
		const display = displayFrom(result.details);
		if (display) {
			context.state.display = display;
			return renderWatcherBlock(display, theme, expanded);
		}
		// Missing/failed/legacy results must remain visible rather than look like
		// successful watcher setup. No execution state is inferred from rendering.
		return new Text(theme.fg(context.isError ? "error" : "toolOutput", result.content.filter(c => c.type === "text").map(c => c.text).join("\n")), 0, 0);
	},
};
