import { buildSessionProjection, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type BranchEntries = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
type ContextUsageSnapshot = ReturnType<ExtensionContext["getContextUsage"]>;

export type MainBusyState = "busy" | "idle";

export interface MainToolCallSnapshot {
	toolCallId?: string;
	toolName: string;
	args?: Record<string, unknown>;
}

export interface MainToolExecutionSnapshot {
	active: boolean;
	running: readonly MainToolCallSnapshot[];
}

export interface MainSessionSnapshot {
	busyState: MainBusyState;
	hasPendingMessages: boolean;
	modelLabel: string;
	toolExecution: MainToolExecutionSnapshot;
	latestUserRequest?: string;
	latestAssistantText?: string;
	systemPrompt: string;
	contextUsage?: ContextUsageSnapshot;
	branchEntries: BranchEntries;
}

type MessageLike = {
	role: string;
	content?: unknown;
};

type MessageEventLike = {
	message?: unknown;
};

type ToolExecutionStartEventLike = {
	toolCallId?: unknown;
	toolName?: unknown;
	args?: unknown;
};

type ToolExecutionEndEventLike = {
	toolCallId?: unknown;
	toolName?: unknown;
};

type ActiveToolCall = MainToolCallSnapshot & { key: string };

export class MainSessionTracker {
	private busyState: MainBusyState = "idle";
	private hasPendingMessages = false;
	private modelLabel = "model unavailable";
	private latestUserRequest?: string;
	private latestAssistantText?: string;
	private systemPrompt = "";
	private contextUsage?: ContextUsageSnapshot;
	private branchEntries: BranchEntries = [];
	private assistantStreaming = false;
	private agentRunActive = false;
	private anonymousToolCallCounter = 0;
	private readonly activeToolCalls = new Map<string, ActiveToolCall>();

	reset(modelLabel: string = "model unavailable"): void {
		this.busyState = "idle";
		this.hasPendingMessages = false;
		this.modelLabel = modelLabel;
		this.latestUserRequest = undefined;
		this.latestAssistantText = undefined;
		this.systemPrompt = "";
		this.contextUsage = undefined;
		this.branchEntries = [];
		this.assistantStreaming = false;
		this.agentRunActive = false;
		this.anonymousToolCallCounter = 0;
		this.activeToolCalls.clear();
	}

	refreshFromContext(ctx: ExtensionContext, modelLabel: string): void {
		this.modelLabel = modelLabel;
		this.systemPrompt = ctx.getSystemPrompt();
		this.contextUsage = ctx.getContextUsage();
		this.busyState = this.agentRunActive || !ctx.isIdle() ? "busy" : "idle";
		this.hasPendingMessages = ctx.hasPendingMessages();
		this.branchEntries = [...ctx.sessionManager.getBranch()];
		this.refreshMessagesFromBranch();
	}

	handleAgentStart(): void {
		this.agentRunActive = true;
		this.busyState = "busy";
	}

	handleAgentEnd(): void {
		// This ends only a low-level attempt; recovery and queued work may follow.
		this.assistantStreaming = false;
		this.activeToolCalls.clear();
	}

	handleAgentSettled(): void {
		this.agentRunActive = false;
		this.busyState = "idle";
		this.assistantStreaming = false;
		this.activeToolCalls.clear();
	}

	handleMessageStart(event: MessageEventLike): void {
		// Mark assistant streaming on message_start so a refreshFromContext
		// triggered by another event in the gap before message_update cannot
		// overwrite the in-flight latestAssistantText with the persisted prior
		// assistant message.
		this.captureMessage(event.message, true);
	}

	handleMessageUpdate(event: MessageEventLike): void {
		this.captureMessage(event.message, true);
	}

	handleMessageEnd(event: MessageEventLike): void {
		this.captureMessage(event.message, false);
	}

	handleToolExecutionStart(event: ToolExecutionStartEventLike): void {
		const toolName = typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : undefined;
		if (!toolName) {
			return;
		}

		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : undefined;
		const key = toolCallId ? `id:${toolCallId}` : `tool:${toolName}:${this.anonymousToolCallCounter++}`;
		this.activeToolCalls.set(key, {
			key,
			toolCallId,
			toolName,
			args: toRecord(event.args),
		});
	}

	handleToolExecutionEnd(event: ToolExecutionEndEventLike): void {
		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : undefined;
		const toolName = typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : undefined;
		if (toolCallId && this.activeToolCalls.delete(`id:${toolCallId}`)) {
			return;
		}
		if (!toolName) {
			return;
		}
		// An unmatched explicit ID must never finish a different identified call.
		// Older/partial events without a start ID can still be paired FIFO by name.
		const candidates = [...this.activeToolCalls.values()].filter((call) => call.toolName === toolName);
		const anonymous = candidates.find((call) => !call.toolCallId);
		if (anonymous) {
			this.activeToolCalls.delete(anonymous.key);
		} else if (!toolCallId && candidates.length === 1) {
			this.activeToolCalls.delete(candidates[0]!.key);
		}
	}

	handleModelSelect(modelLabel: string): void {
		this.modelLabel = modelLabel;
	}

	snapshot(): MainSessionSnapshot {
		return {
			busyState: this.busyState,
			hasPendingMessages: this.hasPendingMessages,
			modelLabel: this.modelLabel,
			toolExecution: {
				active: this.activeToolCalls.size > 0,
				running: [...this.activeToolCalls.values()].map(({ key: _key, ...toolCall }) => toolCall),
			},
			latestUserRequest: this.latestUserRequest,
			latestAssistantText: this.latestAssistantText,
			systemPrompt: this.systemPrompt,
			contextUsage: this.contextUsage,
			branchEntries: [...this.branchEntries],
		};
	}

	private captureMessage(messageValue: unknown, assistantStreaming?: boolean): void {
		const message = unwrapMessage(messageValue);
		if (!message) {
			return;
		}

		if (message.role === "user") {
			this.latestUserRequest = extractTextContent(message.content) || undefined;
			return;
		}

		if (message.role !== "assistant") {
			return;
		}

		if (typeof assistantStreaming === "boolean") {
			this.assistantStreaming = assistantStreaming;
		}
		this.latestAssistantText = extractAssistantText(message.content) || undefined;
	}

	private refreshMessagesFromBranch(): void {
		let latestUserRequest: string | undefined;
		let latestAssistantText: string | undefined;
		let sawLatestUserMessage = false;
		let sawLatestAssistantMessage = false;

		const messages = buildSessionProjection(this.branchEntries).messages;

		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (!message) {
				continue;
			}

			if (!sawLatestUserMessage && message.role === "user") {
				latestUserRequest = extractTextContent(message.content) || undefined;
				sawLatestUserMessage = true;
			}

			if (!sawLatestAssistantMessage && message.role === "assistant") {
				latestAssistantText = extractAssistantText(message.content) || undefined;
				sawLatestAssistantMessage = true;
			}

			if (sawLatestUserMessage && sawLatestAssistantMessage) {
				break;
			}
		}

		this.latestUserRequest = latestUserRequest;
		if (!this.assistantStreaming) {
			this.latestAssistantText = latestAssistantText;
		}
	}
}

function unwrapMessage(value: unknown): MessageLike | undefined {
	const direct = readMessageLike(value);
	if (direct) {
		return direct;
	}

	if (!isRecord(value)) {
		return undefined;
	}

	// SessionEntry of type "message" wraps the actual AgentMessage under .message;
	// extension event payloads sometimes wrap it under .data instead.
	return readMessageLike(value.message) ?? readMessageLike(value.data);
}

function readMessageLike(value: unknown): MessageLike | undefined {
	if (!isRecord(value) || typeof value.role !== "string") {
		return undefined;
	}

	return {
		role: value.role,
		content: value.content,
	};
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) {
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "image") {
			parts.push(`[image${typeof block.mimeType === "string" && block.mimeType ? `: ${block.mimeType}` : ""}]`);
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
		if (!isRecord(block)) {
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}

	return parts.join("\n\n");
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || Array.isArray(value)) {
		return undefined;
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
