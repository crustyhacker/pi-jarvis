import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionProjection, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildMainSessionContext, extractRecentMainSessionEntries } from "../main-context.js";
import { MainSessionTracker, type MainSessionSnapshot } from "../main-session-state.js";

type Message = Extract<SessionEntry, { type: "message" }>["message"];
type Call = Extract<Extract<Message, { role: "assistant" }>["content"][number], { type: "toolCall" }>;
const timestamp = "2026-01-01T00:00:00.000Z";
const usage = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Fixed IDs, no timers, credentials, filesystem writes, or provider requests.
class Branch {
	entries: SessionEntry[] = [];
	private base(id: string) {
		return { id, parentId: this.entries.at(-1)?.id ?? null, timestamp };
	}
	message(id: string, message: Message): this {
		this.entries.push({ ...this.base(id), type: "message", message });
		return this;
	}
	user(id: string, content: string): this {
		return this.message(id, { role: "user", content, timestamp: 0 });
	}
	assistant(id: string, text: string, calls: Call[] = []): this {
		return this.message(id, {
			role: "assistant", content: [...(text ? [{ type: "text" as const, text }] : []), ...calls],
			api: "openai-completions", provider: "fixture", model: "fixture", usage,
			stopReason: calls.length ? "toolUse" : "stop", timestamp: 0,
		});
	}
	result(id: string, toolCallId: string, text: string, isError = false, toolName = "bash"): this {
		return this.message(id, {
			role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 0,
		});
	}
	edit(id: string, targetId: string, content: string | null): this {
		this.entries.push({
			...this.base(id), type: "context_edit", targetId, replacement: content === null ? null : { content },
		});
		return this;
	}
	compact(id: string, firstKeptEntryId: string, summary = "compacted history"): this {
		this.entries.push({ ...this.base(id), type: "compaction", firstKeptEntryId, summary, tokensBefore: 500 });
		return this;
	}
}
function bash(id: string, command: string): Call {
	return { type: "toolCall", id, name: "bash", arguments: { command } };
}
function context(entries: SessionEntry[], idle = true, pending = false): ExtensionContext {
	// Only the methods read by the tracker are needed; no SDK runtime is created.
	return {
		getSystemPrompt: () => "fixture prompt", getContextUsage: () => undefined,
		isIdle: () => idle, hasPendingMessages: () => pending,
		sessionManager: { getBranch: () => entries },
	} as unknown as ExtensionContext;
}
function snapshot(branch: Branch): MainSessionSnapshot {
	const tracker = new MainSessionTracker();
	tracker.refreshFromContext(context(branch.entries), "fixture/model");
	return tracker.snapshot();
}
function payload(branch: Branch) {
	return buildMainSessionContext(snapshot(branch), 100);
}

test("context edits replace/omit latest user and assistant without exposing raw content", () => {
	const branch = new Branch().user("u1", "earlier request").assistant("a1", "earlier answer")
		.user("u2", "ORIGINAL_REQUEST").assistant("a2", "ORIGINAL_ANSWER")
		.edit("e1", "u2", "revised request").edit("e2", "a2", "revised answer");
	const before = JSON.stringify(branch.entries);
	let result = payload(branch);
	assert.equal(result.summary.latestUserRequest, "revised request");
	assert.equal(result.summary.latestAssistantText, "revised answer");
	assert.ok(!result.recentText.includes("ORIGINAL"));
	assert.equal(JSON.stringify(branch.entries), before, "projection must not rewrite raw history");
	branch.edit("e3", "u2", null).edit("e4", "a2", null);
	result = payload(branch);
	assert.equal(result.summary.latestUserRequest, "earlier request");
	assert.equal(result.summary.latestAssistantText, "earlier answer");
	assert.ok(!result.recentText.includes("revised"));
	branch.edit("e5", "u2", "latest edit wins");
	assert.equal(payload(branch).summary.latestUserRequest, "latest edit wins");
	const tracker = new MainSessionTracker();
	tracker.refreshFromContext(context(branch.entries.slice(0, 4)), "fixture/model");
	assert.equal(tracker.snapshot().latestUserRequest, "ORIGINAL_REQUEST", "edits are branch relative");
});

test("all omitted messages clear latest fields; tool-only replacement does not reuse prior text", () => {
	const branch = new Branch().user("u", "omitted request").assistant("a", "omitted answer")
		.edit("eu", "u", null).edit("ea", "a", null);
	assert.equal(payload(branch).summary.latestUserRequest, undefined);
	assert.equal(payload(branch).summary.latestAssistantText, undefined);
	assert.deepEqual(payload(branch).recentEntries, []);
	branch.assistant("tool-only", "", [bash("call", "ls")]);
	assert.equal(payload(branch).summary.latestAssistantText, undefined);
});

test("canonical compaction places summary BEFORE retained messages, before tail limiting", () => {
	const branch = new Branch().user("old", "discarded").user("kept", "kept request")
		.assistant("answer", "latest answer").compact("c", "kept");
	assert.deepEqual(extractRecentMainSessionEntries(branch.entries, 1), [{ kind: "assistant", text: "latest answer" }]);
	assert.deepEqual(extractRecentMainSessionEntries(branch.entries, 3).map((entry) => entry.kind), ["status", "user", "assistant"]);
	assert.ok(!payload(branch).recentText.includes("discarded"));
	assert.equal(payload(branch).summary.latestUserRequest, "kept request");
	branch.edit("edit", "answer", "effective retained answer");
	assert.equal(extractRecentMainSessionEntries(branch.entries, 1)[0]?.text, "effective retained answer");
});

test("repeated compaction suppresses older retained summaries; retain-none and missing boundary match SDK", () => {
	const branch = new Branch().user("u", "kept").compact("c1", "u", "OLD_SUMMARY")
		.assistant("a", "current answer").compact("c2", "u", "NEW_SUMMARY");
	assert.ok(!payload(branch).recentText.includes("OLD_SUMMARY"));
	assert.deepEqual(payload(branch).recentEntries.map((entry) => entry.text), ["Compaction: NEW_SUMMARY", "kept", "current answer"]);
	branch.compact("c3", "c3", "retain none");
	assert.equal(payload(branch).summary.latestUserRequest, undefined);
	assert.equal(payload(branch).summary.latestAssistantText, undefined);
	assert.deepEqual(payload(branch).recentEntries, [{ kind: "status", text: "Compaction: retain none" }]);
	branch.user("new", "after compaction").compact("c4", "missing", "missing boundary");
	assert.equal(buildSessionProjection(branch.entries).messages.length, 1);
	assert.deepEqual(payload(branch).recentEntries, [{ kind: "status", text: "Compaction: missing boundary" }]);
});

test("custom message replacement/omission and recent file discovery use effective messages", () => {
	const branch = new Branch().assistant("a", "", [{ type: "toolCall", id: "read", name: "read", arguments: { path: "stale.ts" } }]);
	branch.entries.push({ type: "custom_message", id: "custom", parentId: "a", timestamp,
		customType: "fixture", content: "STALE_CUSTOM", display: true });
	branch.edit("ea", "a", "replacement text").edit("ec", "custom", "effective custom");
	assert.deepEqual(payload(branch).summary.workState.recentFiles, []);
	assert.ok(payload(branch).recentText.includes("effective custom"));
	assert.ok(!payload(branch).recentText.includes("STALE_CUSTOM"));
	branch.edit("omit", "custom", null);
	assert.ok(!payload(branch).recentText.includes("effective custom"));
});

test("ordinary bash tool call/result success is validation; stdout cannot fake failure", () => {
	const branch = new Branch().assistant("a", "", [bash("test", "npm test")])
		.result("r", "test", "tests passed\n\nCommand exited with code 9");
	const validation = payload(branch).summary.validation;
	assert.equal(validation.status, "passed");
	assert.equal(validation.command, "npm test");
	assert.equal(validation.exitCode, 0);
	assert.ok(validation.outputSnippet?.includes("tests passed"));
});

test("parallel bash results correlate only by exact ID and latest completion wins", () => {
	const branch = new Branch().assistant("a", "", [bash("tests", "npm test"), bash("build", "npm run build"), bash("listing", "ls")])
		.result("build-result", "build", "build output\n\nCommand exited with code 2", true)
		.result("listing-result", "listing", "listing output");
	assert.equal(payload(branch).summary.validation.command, "npm run build");
	assert.equal(payload(branch).summary.validation.exitCode, 2);
	branch.result("unknown-result", "unknown", "all green");
	assert.equal(payload(branch).summary.validation.status, "failed");
	branch.result("test-result", "tests", "test output");
	assert.equal(payload(branch).summary.validation.command, "npm test");
	assert.equal(payload(branch).summary.validation.status, "passed");
	branch.result("duplicate-result", "build", "duplicate output");
	assert.equal(payload(branch).summary.validation.command, "npm test");
});

test("bash cancellation, timeout, generic failure and explicit error-with-zero stay failed", () => {
	for (const output of ["partial\n\nCommand aborted", "Command timed out after 5 seconds", "execution blocked", "Command exited with code 0"]) {
		const branch = new Branch().assistant("a", "", [bash("call", "npm test")]).result("r", "call", output, true);
		const validation = payload(branch).summary.validation;
		assert.equal(validation.status, "failed");
		if (output.endsWith("Command aborted")) assert.equal(validation.summary, "npm test was cancelled");
	}
});

test("edited/omitted bash calls and results are not correlated with raw stale content", () => {
	const branch = new Branch().assistant("a", "", [bash("call", "npm test")]).result("r", "call", "original output");
	branch.edit("er", "r", "effective output");
	assert.equal(payload(branch).summary.validation.outputSnippet, "effective output");
	branch.edit("omit-result", "r", null);
	assert.equal(payload(branch).summary.validation.status, "none");
	branch.edit("restore-result", "r", "restored output").edit("omit-call", "a", null);
	assert.equal(payload(branch).summary.validation.status, "none");
	const wrongName = new Branch().assistant("a", "", [bash("call", "npm test")]).result("r", "call", "output", false, "read");
	assert.equal(payload(wrongName).summary.validation.status, "none");
});

test("manual bash remains supported, excluded manual commands and compacted results do not leak", () => {
	const branch = new Branch().message("manual", {
		role: "bashExecution", command: "npm run check", output: "clean", exitCode: 0,
		cancelled: false, truncated: false, timestamp: 0,
	});
	assert.equal(payload(branch).summary.validation.status, "passed");
	branch.message("excluded", { role: "bashExecution", command: "npm test", output: "private", exitCode: 1,
		cancelled: false, truncated: false, excludeFromContext: true, timestamp: 0 });
	assert.equal(payload(branch).summary.validation.command, "npm run check");
	assert.ok(!payload(branch).recentText.includes("private"));
	branch.compact("c", "c");
	assert.equal(payload(branch).summary.validation.status, "none");
});

test("running validation wins over previous failure", () => {
	const tracker = new MainSessionTracker();
	tracker.refreshFromContext(context(new Branch().assistant("a", "", [bash("old", "npm test")])
		.result("r", "old", "Command exited with code 1", true).entries, false), "fixture/model");
	tracker.handleToolExecutionStart({ toolCallId: "new", toolName: "bash", args: { command: "npm run build" } });
	const result = buildMainSessionContext(tracker.snapshot());
	assert.equal(result.summary.validation.status, "running");
	assert.equal(result.summary.validation.command, "npm run build");
	assert.equal(result.summary.workState.attentionMode, "validating");
});

test("tracker cannot finish a different concurrent identified tool on an unmatched or name-only end", () => {
	const tracker = new MainSessionTracker();
	tracker.handleToolExecutionStart({ toolCallId: "one", toolName: "bash" });
	tracker.handleToolExecutionStart({ toolCallId: "two", toolName: "bash" });
	tracker.handleToolExecutionEnd({ toolCallId: "stale", toolName: "bash" });
	tracker.handleToolExecutionEnd({ toolName: "bash" });
	assert.deepEqual(tracker.snapshot().toolExecution.running.map((call) => call.toolCallId), ["one", "two"]);
	tracker.handleToolExecutionEnd({ toolCallId: "two", toolName: "bash" });
	tracker.handleToolExecutionEnd({ toolCallId: "two", toolName: "bash" });
	assert.deepEqual(tracker.snapshot().toolExecution.running.map((call) => call.toolCallId), ["one"]);
	tracker.handleToolExecutionEnd({ toolCallId: "one" });
	assert.equal(tracker.snapshot().toolExecution.active, false);
});

test("legacy anonymous calls remain separate and can end FIFO without deleting identified calls", () => {
	const tracker = new MainSessionTracker();
	tracker.handleToolExecutionStart({ toolCallId: "identified", toolName: "read" });
	tracker.handleToolExecutionStart({ toolName: "read", args: { path: "first.ts" } });
	tracker.handleToolExecutionStart({ toolName: "read", args: { path: "second.ts" } });
	tracker.handleToolExecutionEnd({ toolCallId: "late-id", toolName: "read" });
	assert.deepEqual(tracker.snapshot().toolExecution.running.map((call) => call.args?.path), [undefined, "second.ts"]);
	tracker.handleToolExecutionEnd({ toolName: "read" });
	assert.deepEqual(tracker.snapshot().toolExecution.running.map((call) => call.toolCallId), ["identified"]);
});

test("agent_end is attempt cleanup, not idle: only settled/reset releases run busy latch", () => {
	const tracker = new MainSessionTracker();
	tracker.handleAgentStart();
	tracker.handleToolExecutionStart({ toolCallId: "tool", toolName: "bash" });
	tracker.handleAgentEnd();
	assert.equal(tracker.snapshot().busyState, "busy");
	assert.equal(tracker.snapshot().toolExecution.active, false);
	tracker.refreshFromContext(context([], true, true), "fixture/model");
	assert.equal(tracker.snapshot().busyState, "busy", "transient idle during recovery must not release latch");
	assert.equal(tracker.snapshot().hasPendingMessages, true);
	tracker.handleAgentStart(); // automatic retry
	tracker.handleAgentEnd();
	tracker.handleAgentSettled();
	assert.equal(tracker.snapshot().busyState, "idle");
	tracker.handleAgentStart();
	tracker.reset();
	tracker.refreshFromContext(context([]), "new/model");
	assert.equal(tracker.snapshot().busyState, "idle");
});

test("canonical refresh preserves streaming text and reconciles edits after attempt ends", () => {
	const branch = new Branch().assistant("prior", "persisted text");
	const tracker = new MainSessionTracker();
	tracker.refreshFromContext(context(branch.entries, false), "fixture/model");
	tracker.handleAgentStart();
	tracker.handleMessageStart({ message: { role: "assistant", content: [{ type: "text", text: "streaming text" }] } });
	branch.edit("edit", "prior", "effective persisted text");
	tracker.refreshFromContext(context(branch.entries, false), "fixture/model");
	assert.equal(tracker.snapshot().latestAssistantText, "streaming text");
	tracker.handleAgentEnd();
	tracker.refreshFromContext(context(branch.entries, false), "fixture/model");
	assert.equal(tracker.snapshot().latestAssistantText, "effective persisted text");
});


test("explicit IDs cannot collide with anonymous synthetic tracker keys", () => {
	const tracker = new MainSessionTracker();
	tracker.handleToolExecutionStart({ toolName: "read", args: { path: "anonymous.ts" } });
	tracker.handleToolExecutionStart({ toolCallId: "tool:read:0", toolName: "read", args: { path: "identified.ts" } });
	assert.equal(tracker.snapshot().toolExecution.running.length, 2);
	tracker.handleToolExecutionEnd({ toolCallId: "tool:read:0" });
	assert.deepEqual(tracker.snapshot().toolExecution.running.map((call) => call.args?.path), ["anonymous.ts"]);
});
