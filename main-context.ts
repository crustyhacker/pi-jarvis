import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MainSessionSnapshot } from "./main-session-state.js";

export const DEFAULT_MAIN_SESSION_RECENT_LIMIT = 8;

const SUMMARY_TEXT_LIMIT = 240;
const RECENT_ENTRY_TEXT_LIMIT = 320;
const TOOL_CALL_TEXT_LIMIT = 72;
const FILE_REFERENCE_LIMIT = 5;
const KNOWN_FILE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"md",
	"yaml",
	"yml",
	"toml",
	"sh",
	"txt",
	"css",
	"html",
	"xml",
	"py",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"swift",
	"php",
	"sql",
	"lock",
]);

export type MainAttentionMode = "planning" | "reading" | "editing" | "validating" | "searching" | "waiting" | "waiting-for-user" | "blocked" | "done";

export interface MainSessionWorkStatePayload {
	attentionMode: MainAttentionMode;
	currentAction: string;
	primaryFile?: string;
	activeFiles: readonly string[];
	recentFiles: readonly string[];
}

export type MainValidationStatus = "running" | "passed" | "failed" | "none";

export interface MainSessionValidationPayload {
	status: MainValidationStatus;
	command?: string;
	summary: string;
	outputSnippet?: string;
	exitCode?: number;
}

export interface MainSessionSummaryPayload {
	mainStatus: MainSessionSnapshot["busyState"];
	mainModelLabel: string;
	currentToolActivity: {
		active: boolean;
		running: readonly string[];
	};
	latestUserRequest?: string;
	latestAssistantText?: string;
	pendingMessages: boolean;
	contextUsage?: MainSessionSnapshot["contextUsage"];
	workState: MainSessionWorkStatePayload;
	validation: MainSessionValidationPayload;
}

export interface MainSessionRecentEntry {
	kind: "user" | "assistant" | "tool" | "status";
	text: string;
}

export interface MainSessionContextPayload {
	summary: MainSessionSummaryPayload;
	summaryText: string;
	workStateText: string;
	recentEntries: readonly MainSessionRecentEntry[];
	recentText: string;
}

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type MainMessage = MessageEntry["message"];
type ValidationExecution = {
	command: string;
	output: string;
	cancelled: boolean;
	failed?: boolean;
	exitCode?: number;
};
type TextBlockLike = {
	type: "text";
	text: string;
};
type ImageBlockLike = {
	type: "image";
	mimeType?: string;
};
type ToolCallBlockLike = {
	type: "toolCall";
	id?: string;
	name: string;
	arguments?: Record<string, unknown>;
};

export function buildMainSessionContext(
	snapshot: MainSessionSnapshot,
	limit: number = DEFAULT_MAIN_SESSION_RECENT_LIMIT,
): MainSessionContextPayload {
	const summary = buildMainSessionSummary(snapshot);
	const recentEntries = extractRecentMainSessionEntries(snapshot.branchEntries, limit);
	const workStateText = formatWorkStateSummary(summary.workState);

	return {
		summary,
		summaryText: formatMainSessionSummary(summary),
		workStateText,
		recentEntries,
		recentText: formatRecentMainSessionEntries(recentEntries),
	};
}

export function buildMainSessionSummary(
	snapshot: MainSessionSnapshot,
): MainSessionSummaryPayload {
	const workState = deriveMainSessionWorkState(snapshot);
	const validation = deriveValidationState(snapshot);

	return {
		mainStatus: snapshot.busyState,
		mainModelLabel: snapshot.modelLabel,
		currentToolActivity: {
			active: snapshot.toolExecution.active,
			running: snapshot.toolExecution.running.map((toolCall) => formatToolCall(toolCall.toolName, toolCall.args)),
		},
		latestUserRequest: normalizeSummaryField(snapshot.latestUserRequest),
		latestAssistantText: normalizeSummaryField(snapshot.latestAssistantText),
		pendingMessages: snapshot.hasPendingMessages,
		contextUsage: snapshot.contextUsage
			? {
				...snapshot.contextUsage,
			}
			: undefined,
		workState,
		validation,
	};
}

export function formatMainSessionSummary(summary: MainSessionSummaryPayload): string {
	return [
		"Main session summary:",
		`- Main status: ${summary.mainStatus}`,
		`- Model: ${summary.mainModelLabel}`,
		`- Current tool activity: ${formatToolActivity(summary.currentToolActivity)}`,
		`- Current focus: ${summary.workState.currentAction}`,
		`- Attention mode: ${formatAttentionMode(summary.workState.attentionMode)}`,
		`- Active files: ${formatFileList(summary.workState.activeFiles)}`,
		`- Recent files: ${formatFileList(summary.workState.recentFiles)}`,
		`- Validation: ${summary.validation.summary}`,
		`- Latest user request: ${summary.latestUserRequest ?? "none"}`,
		`- Latest assistant text: ${summary.latestAssistantText ?? "none"}`,
		`- Pending messages: ${summary.pendingMessages ? "yes" : "no"}`,
		`- Context usage: ${formatContextUsage(summary.contextUsage)}`,
	].join("\n");
}

export function extractRecentMainSessionEntries(
	branchEntries: MainSessionSnapshot["branchEntries"],
	limit: number = DEFAULT_MAIN_SESSION_RECENT_LIMIT,
): readonly MainSessionRecentEntry[] {
	const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_MAIN_SESSION_RECENT_LIMIT;
	if (safeLimit === 0) {
		return [];
	}

	const messages = buildSessionProjection([...branchEntries]).messages;
	const normalizedEntries = messages.flatMap((message) => normalizeMessage(message));
	return normalizedEntries.slice(-safeLimit);
}

export function formatRecentMainSessionEntries(entries: readonly MainSessionRecentEntry[]): string {
	if (entries.length === 0) {
		return "Recent main session: none";
	}

	return [
		"Recent main session:",
		...entries.map((entry) => `- ${entry.kind}: ${entry.text}`),
	].join("\n");
}

function deriveValidationState(snapshot: MainSessionSnapshot): MainSessionValidationPayload {
	const runningCommand = getActiveValidationCommand(snapshot.toolExecution.running);
	if (runningCommand) {
		return {
			status: "running",
			command: runningCommand,
			summary: `${runningCommand} is running`,
		};
	}

	const latestValidationEntry = findLatestValidationEntry(snapshot.branchEntries);
	if (!latestValidationEntry) {
		return {
			status: "none",
			summary: "none",
		};
	}

	const command = normalizeText(latestValidationEntry.command);
	const outputSnippet = normalizeSummaryField(latestValidationEntry.output);
	if (latestValidationEntry.cancelled) {
		return {
			status: "failed",
			command,
			summary: `${command} was cancelled`,
			outputSnippet,
		};
	}

	if (latestValidationEntry.exitCode === 0 && !latestValidationEntry.failed) {
		return {
			status: "passed",
			command,
			summary: `${command} passed`,
			outputSnippet,
			exitCode: 0,
		};
	}

	const exitCode = latestValidationEntry.exitCode ?? undefined;
	const suffix = outputSnippet ? ` — ${outputSnippet}` : "";
	return {
		status: "failed",
		command,
		summary: `${command} failed${exitCode === undefined ? "" : ` (exit ${exitCode})`}${suffix}`,
		outputSnippet,
		exitCode,
	};
}

function findLatestValidationEntry(branchEntries: MainSessionSnapshot["branchEntries"]): ValidationExecution | undefined {
	const messages = buildSessionProjection([...branchEntries]).messages;
	const pendingCalls = new Map<string, ToolCallBlockLike>();
	let latest: ValidationExecution | undefined;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const call of extractToolCalls(message.content)) {
				if (call.id) {
					pendingCalls.set(call.id, call);
				}
			}
		} else if (message.role === "bashExecution") {
			if (!message.excludeFromContext && classifyValidationCommand(message.command)) {
				latest = message;
			}
		} else if (message.role === "toolResult") {
			const call = pendingCalls.get(message.toolCallId);
			pendingCalls.delete(message.toolCallId);
			if (call?.name !== "bash" || message.toolName !== "bash") {
				continue;
			}
			const command = typeof call.arguments?.command === "string" ? normalizeText(call.arguments.command) : "";
			if (!classifyValidationCommand(command)) {
				continue;
			}
			const output = extractVisibleTextContent(message.content);
			// Pi's built-in bash persists isError and textual terminal status, not
			// structuredContent.exit_code. Only parse the status on failed results,
			// so arbitrary successful stdout cannot masquerade as a failure.
			const exitMatch = message.isError ? output.trimEnd().match(/(?:^|\n)Command exited with code (-?\d+)$/) : undefined;
			latest = {
				command,
				output,
				failed: message.isError,
				cancelled: message.isError && /(?:^|\n)Command aborted$/.test(output.trimEnd()),
				exitCode: message.isError ? (exitMatch ? Number(exitMatch[1]) : undefined) : 0,
			};
		}
	}
	return latest;
}

function formatWorkStateSummary(workState: MainSessionWorkStatePayload): string {
	return [
		"Main work state:",
		`- Attention mode: ${formatAttentionMode(workState.attentionMode)}`,
		`- Current focus: ${workState.currentAction}`,
		`- Active files: ${formatFileList(workState.activeFiles)}`,
		`- Recent files: ${formatFileList(workState.recentFiles)}`,
	].join("\n");
}

function deriveMainSessionWorkState(snapshot: MainSessionSnapshot): MainSessionWorkStatePayload {
	const activeFiles = extractActiveFiles(snapshot.toolExecution.running);
	const recentFiles = extractRecentFiles(snapshot.branchEntries, activeFiles);
	const primaryFile = activeFiles[0] ?? recentFiles[0];
	const validationCommand = getActiveValidationCommand(snapshot.toolExecution.running);
	const validation = deriveValidationState(snapshot);

	if (validationCommand) {
		return {
			attentionMode: "validating",
			currentAction: `running ${validationCommand}`,
			primaryFile,
			activeFiles,
			recentFiles,
		};
	}

	if (snapshot.toolExecution.running.some((toolCall) => toolCall.toolName === "edit" || toolCall.toolName === "write")) {
		return {
			attentionMode: "editing",
			currentAction: primaryFile ? `editing ${primaryFile}` : "editing the workspace",
			primaryFile,
			activeFiles,
			recentFiles,
		};
	}

	if (snapshot.toolExecution.running.some((toolCall) => toolCall.toolName === "read")) {
		return {
			attentionMode: "reading",
			currentAction: primaryFile ? `reading ${primaryFile}` : "reading the workspace",
			primaryFile,
			activeFiles,
			recentFiles,
		};
	}

	if (snapshot.toolExecution.running.some((toolCall) => ["grep", "find", "ls", "mcp"].includes(toolCall.toolName))) {
		return {
			attentionMode: "searching",
			currentAction: primaryFile ? `searching around ${primaryFile}` : "searching the workspace",
			primaryFile,
			activeFiles,
			recentFiles,
		};
	}

	if (snapshot.busyState === "busy") {
		return {
			attentionMode: "planning",
			currentAction: primaryFile ? `planning around ${primaryFile}` : "planning the next step",
			primaryFile,
			activeFiles,
			recentFiles,
		};
	}

	if (validation.status === "failed") {
		return {
			attentionMode: "blocked",
			currentAction: validation.command ? `blocked on ${validation.command}` : "blocked by the last validation failure",
			primaryFile,
			activeFiles,
			recentFiles,
		};
	}

	if (snapshot.hasPendingMessages) {
		return {
			attentionMode: "waiting",
			currentAction: "waiting on queued messages",
			primaryFile,
			activeFiles,
			recentFiles,
		};
	}

	if (looksCompleted(snapshot.latestAssistantText, validation.status)) {
		return {
			attentionMode: "done",
			currentAction: primaryFile ? `completed work around ${primaryFile}` : "completed the last task",
			primaryFile,
			activeFiles,
			recentFiles,
		};
	}

	return {
		attentionMode: "waiting-for-user",
		currentAction: "waiting for user input",
		primaryFile,
		activeFiles,
		recentFiles,
	};
}

function looksCompleted(latestAssistantText: string | undefined, _validationStatus: MainValidationStatus): boolean {
	const normalized = normalizeText(latestAssistantText).toLowerCase();
	if (!normalized) {
		return false;
	}
	return /^(done|completed|finished|wrapped up|all set|implemented|fixed|updated)\b/.test(normalized);
}

function formatAttentionMode(attentionMode: MainAttentionMode): string {
	return attentionMode.replace(/-/g, " " );
}

function extractActiveFiles(runningToolCalls: readonly MainSessionSnapshot["toolExecution"]["running"][number][]): string[] {
	const files = new Set<string>();
	for (const toolCall of runningToolCalls) {
		for (const file of extractFilesFromToolCall(toolCall)) {
			files.add(file);
			if (files.size >= FILE_REFERENCE_LIMIT) {
				return [...files];
			}
		}
	}
	return [...files];
}

function extractRecentFiles(branchEntries: MainSessionSnapshot["branchEntries"], activeFiles: readonly string[]): string[] {
	const files = new Set<string>(activeFiles);
	const messages = buildSessionProjection([...branchEntries]).messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		for (const file of extractFilesFromMessage(messages[i]!)) {
			files.add(file);
			if (files.size >= FILE_REFERENCE_LIMIT) {
				return [...files];
			}
		}
	}
	return [...files];
}

function getActiveValidationCommand(runningToolCalls: readonly MainSessionSnapshot["toolExecution"]["running"][number][]): string | undefined {
	for (const toolCall of runningToolCalls) {
		if (toolCall.toolName !== "bash") {
			continue;
		}
		const command = typeof toolCall.args?.command === "string" ? normalizeText(toolCall.args.command) : "";
		const classifiedCommand = classifyValidationCommand(command);
		if (classifiedCommand) {
			return classifiedCommand;
		}
	}
	return undefined;
}

function classifyValidationCommand(command: string): string | undefined {
	const normalizedCommand = normalizeText(command);
	if (!normalizedCommand) {
		return undefined;
	}

	for (const segment of splitShellCommandSegments(normalizedCommand)) {
		const strippedSegment = stripShellPrefix(segment);
		if (!strippedSegment || strippedSegment.startsWith("cd ")) {
			continue;
		}
		if (isValidationSegment(strippedSegment)) {
			return normalizedCommand;
		}
	}

	return undefined;
}

function splitShellCommandSegments(command: string): string[] {
	return command
		.split(/\s*(?:&&|;)\s*/g)
		.map((segment) => normalizeText(segment))
		.filter((segment): segment is string => Boolean(segment));
}

function stripShellPrefix(segment: string): string {
	let normalized = normalizeText(segment);
	let previous = "";
	while (normalized && normalized !== previous) {
		previous = normalized;
		normalized = normalizeText(
			normalized
				.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/, "")
				.replace(/^(?:\/usr\/bin\/|\/bin\/)?env\s+/, "")
				.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/, ""),
		);
	}
	return normalized;
}

function isValidationSegment(segment: string): boolean {
	if (/^npm\s+test(?:\s|$)/.test(segment)) {
		return true;
	}
	if (/^npm\s+run\s+check(?:\s|$)/.test(segment)) {
		return true;
	}
	if (/^npm\s+run\s+build(?:\s|$)/.test(segment)) {
		return true;
	}
	if (/^npm\s+run\s+verify:release(?:\s|$)/.test(segment)) {
		return true;
	}
	if (/^npm\s+pack(?:\s|$)/.test(segment) && /(?:^|\s)--dry-run(?:[=\s]|$)/.test(segment)) {
		return true;
	}
	if (/^(?:npx\s+)?tsc(?:\s|$)/.test(segment) && /(?:^|\s)--noEmit(?:\s|$)/.test(segment)) {
		return true;
	}
	if (/^(?:npx\s+)?tsc(?:\s|$)/.test(segment) && /(?:^|\s)(?:-p|--project)\s+tsconfig\.build\.json(?:\s|$)/.test(segment)) {
		return true;
	}
	if (/^node(?:\s|$)/.test(segment) && /\btest\/jarvis\.test\.ts(?:\s|$)/.test(segment)) {
		return true;
	}
	return false;
}

function extractFilesFromMessage(message: MainMessage): string[] {
	switch (message.role) {
		case "assistant":
			return extractToolCalls(message.content).flatMap((toolCall) => extractFilesFromToolCall({ toolName: toolCall.name, args: toolCall.arguments }));
		case "bashExecution":
			return message.excludeFromContext ? [] : extractFileReferencesFromText(message.command);
		default:
			return [];
	}
}

function extractFilesFromToolCall(toolCall: { toolName: string; args?: Record<string, unknown> }): string[] {
	if (toolCall.toolName === "bash") {
		return extractFileReferencesFromText(typeof toolCall.args?.command === "string" ? toolCall.args.command : "");
	}

	const files = new Set<string>();
	collectFileReferences(toolCall.args, files);
	return [...files];
}

function collectFileReferences(value: unknown, files: Set<string>, depth: number = 0): void {
	if (depth > 3 || files.size >= FILE_REFERENCE_LIMIT || value === null || typeof value === "undefined") {
		return;
	}

	if (typeof value === "string") {
		for (const file of extractFileReferencesFromText(value)) {
			files.add(file);
			if (files.size >= FILE_REFERENCE_LIMIT) {
				return;
			}
		}
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectFileReferences(item, files, depth + 1);
			if (files.size >= FILE_REFERENCE_LIMIT) {
				return;
			}
		}
		return;
	}

	if (!isRecord(value)) {
		return;
	}

	for (const nestedValue of Object.values(value)) {
		collectFileReferences(nestedValue, files, depth + 1);
		if (files.size >= FILE_REFERENCE_LIMIT) {
			return;
		}
	}
}

function extractFileReferencesFromText(text: string): string[] {
	const matches = text.match(/(?:^|[\s"'`=:(])((?:\.{1,2}\/|\/)?[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]{1,10})(?=$|[\s"'`):,])/g) ?? [];
	const files = new Set<string>();
	for (const match of matches) {
		const normalized = normalizeFileReference(match);
		if (normalized) {
			files.add(normalized);
		}
	}
	return [...files];
}

function normalizeFileReference(value: string): string | undefined {
	const trimmed = value.trim().replace(/^["'`(=:]+|["'`),:;]+$/g, "");
	if (!trimmed || trimmed.includes("://") || trimmed.endsWith("/")) {
		return undefined;
	}
	const extension = trimmed.split(".").at(-1)?.toLowerCase();
	if (!extension || !KNOWN_FILE_EXTENSIONS.has(extension)) {
		return undefined;
	}
	return trimmed;
}

function formatFileList(files: readonly string[]): string {
	return files.length > 0 ? files.join(", ") : "none";
}

function normalizeSummaryField(value: string | undefined): string | undefined {
	const normalized = normalizeText(value);
	if (!normalized) {
		return undefined;
	}
	return truncateText(normalized, SUMMARY_TEXT_LIMIT);
}

function normalizeMessage(message: MainMessage): MainSessionRecentEntry[] {
	switch (message.role) {
		case "user":
			return createRecentEntries("user", extractVisibleTextContent(message.content));
		case "assistant": {
			const entries = createRecentEntries("assistant", extractAssistantText(message.content));
			for (const toolCall of extractToolCalls(message.content)) {
				entries.push(...createRecentEntries("tool", formatToolCall(toolCall.name, toolCall.arguments)));
			}
			return entries;
		}
		case "toolResult": {
			const output = extractVisibleTextContent(message.content);
			const prefix = message.isError ? `error from ${message.toolName}` : message.toolName;
			return createRecentEntries("tool", output ? `${prefix}: ${output}` : `${prefix}: (no text output)`);
		}
		case "custom":
			return message.display ? createRecentEntries("status", extractVisibleTextContent(message.content)) : [];
		case "bashExecution": {
			if (message.excludeFromContext) {
				return [];
			}
			const status = message.cancelled
				? "cancelled"
				: message.exitCode === 0
					? "ok"
					: `exit ${message.exitCode ?? "?"}`;
			const output = normalizeText(message.output);
			return createRecentEntries("tool", output ? `$ ${message.command} (${status}) — ${output}` : `$ ${message.command} (${status})`);
		}
		case "branchSummary":
			return createRecentEntries("status", `Branch summary: ${message.summary}`);
		case "compactionSummary":
			return createRecentEntries("status", `Compaction: ${message.summary}`);
		default:
			return [];
	}
}

function createRecentEntries(kind: MainSessionRecentEntry["kind"], text: string): MainSessionRecentEntry[] {
	const normalized = normalizeText(text);
	if (!normalized) {
		return [];
	}

	return [{ kind, text: truncateText(normalized, RECENT_ENTRY_TEXT_LIMIT) }];
}

function extractVisibleTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (isTextBlock(block)) {
			parts.push(block.text);
			continue;
		}
		if (isImageBlock(block)) {
			parts.push(`[image${block.mimeType ? `: ${block.mimeType}` : ""}]`);
		}
	}

	return parts.join("\n\n");
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (isTextBlock(block)) {
			parts.push(block.text);
		}
	}

	return parts.join("\n\n");
}

function extractToolCalls(content: unknown): ToolCallBlockLike[] {
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: ToolCallBlockLike[] = [];
	for (const block of content) {
		if (isToolCallBlock(block)) {
			toolCalls.push({
				type: "toolCall",
				id: typeof block.id === "string" ? block.id : undefined,
				name: block.name,
				arguments: readArgsRecord(block.arguments),
			});
		}
	}

	return toolCalls;
}

function formatToolActivity(toolActivity: MainSessionSummaryPayload["currentToolActivity"]): string {
	if (!toolActivity.active || toolActivity.running.length === 0) {
		return "none";
	}
	return toolActivity.running.join(", " );
}

function formatContextUsage(contextUsage: MainSessionSummaryPayload["contextUsage"]): string {
	if (!contextUsage) {
		return "unknown";
	}

	const tokens = contextUsage.tokens === null ? "unknown" : String(contextUsage.tokens);
	const percent = contextUsage.percent === null ? "unknown" : `${trimTrailingZeroes(contextUsage.percent.toFixed(1))}%`;
	return `${tokens}/${contextUsage.contextWindow} tokens (${percent})`;
}

function formatToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
	if (toolName === "mcp") {
		const tool = typeof args?.tool === "string" ? args.tool : undefined;
		if (tool) {
			return `mcp ${tool}`;
		}
		if (typeof args?.search === "string") {
			return `mcp search ${args.search}`;
		}
		if (typeof args?.describe === "string") {
			return `mcp describe ${args.describe}`;
		}
		if (typeof args?.connect === "string") {
			return `mcp connect ${args.connect}`;
		}
	}

	if (!args || Object.keys(args).length === 0) {
		return toolName;
	}

	const json = JSON.stringify(args);
	return json.length > TOOL_CALL_TEXT_LIMIT
		? `${toolName} ${json.slice(0, TOOL_CALL_TEXT_LIMIT - 3)}...`
		: `${toolName} ${json}`;
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function trimTrailingZeroes(value: string): string {
	return value.replace(/\.0$/, "");
}

function normalizeText(text: string | undefined): string {
	if (!text) {
		return "";
	}
	return text.replace(/\s+/g, " " ).trim();
}

function readArgsRecord(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || Array.isArray(value)) {
		return undefined;
	}
	return value;
}

function isTextBlock(value: unknown): value is TextBlockLike {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageBlock(value: unknown): value is ImageBlockLike {
	return isRecord(value) && value.type === "image" && (typeof value.mimeType === "string" || typeof value.mimeType === "undefined");
}

function isToolCallBlock(value: unknown): value is ToolCallBlockLike {
	return isRecord(value) && value.type === "toolCall" && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
