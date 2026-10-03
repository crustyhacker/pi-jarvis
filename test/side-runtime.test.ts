import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAssistantMessageEventStream, InMemoryCredentialStore,
	type AssistantMessage, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	ModelRegistry, ModelRuntime,
	type AgentSession, type AgentSessionEvent, type ExtensionContext, type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { JarvisOverlayBridge } from "../overlay.js";
import { createSideModelRuntime, createSideSessionFile, JarvisSideSessionRuntime } from "../side-session.js";
import type { MainSessionContextPayload } from "../main-context.js";

const model: Model<any> = {
	id: "custom-only", name: "Custom Only", provider: "side-test", api: "side-test-api",
	baseUrl: "https://catalog.invalid", reasoning: false, input: ["text"],
	contextWindow: 128000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const mainContext: MainSessionContextPayload = {
	summary: {
		mainStatus: "idle", mainModelLabel: "main/test", currentToolActivity: { active: false, running: [] },
		pendingMessages: false,
		workState: { attentionMode: "waiting", currentAction: "idle", activeFiles: [], recentFiles: [] },
		validation: { status: "none", summary: "none" },
	}, summaryText: "main idle", workStateText: "idle", recentEntries: [], recentText: "none",
};

function response(selected: Model<any>, content: AssistantMessage["content"] = [{ type: "text", text: "side reply" }], error?: string) {
	const message: AssistantMessage = {
		role: "assistant", provider: selected.provider, model: selected.id, api: selected.api,
		content, timestamp: Date.now(), stopReason: error ? "error" : content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		...(error ? { errorMessage: error } : {}),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	if (error) stream.push({ type: "error", reason: "error", error: message });
	else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
	stream.end();
	return stream;
}

async function hostRegistry(streamSimple: Provider["streamSimple"] = (selected) => response(selected)) {
	const hostRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const registry = new ModelRegistry(hostRuntime);
	const provider: Provider = {
		id: model.provider, name: "Host custom provider", getModels: () => [model],
		auth: { apiKey: {
			name: "Test memory credential",
			check: async ({ credential }) => credential?.key ? { type: "api_key" } : undefined,
			resolve: async ({ credential }) => credential?.key ? {
				auth: { apiKey: credential.key, headers: { "x-host": "yes" }, baseUrl: "https://request.invalid" },
				env: { SIDE_TEST: "host" },
			} : undefined,
		} },
		stream: (selected, context, options) => streamSimple(selected, context, options as SimpleStreamOptions | undefined), streamSimple,
	};
	registry.registerProvider(provider);
	await hostRuntime.setRuntimeApiKey(model.provider, "test-only-runtime-key");
	// Only this host model is catalogued. Any private runtime access fails loudly.
	const host = new Proxy(registry, {
		get(target, property) {
			assert.notEqual(property, "runtime", "the public host facade must suffice");
			if (property === "getAll") return () => target.getAll().filter((item) => item.provider.startsWith("side-test"));
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { host, hostRuntime };
}

// Test-only probe of our own wrapper; the SDK session below uses public APIs.
function sessionOf(runtime: JarvisSideSessionRuntime): AgentSession {
	return (runtime as unknown as { session: AgentSession }).session;
}

async function fixture(run: (f: {
	cwd: string; agentDir: string; bridge: JarvisOverlayBridge;
	create: (overrides?: Partial<Parameters<typeof JarvisSideSessionRuntime.create>[0]>) => Promise<JarvisSideSessionRuntime>;
}) => Promise<void>, stream?: Provider["streamSimple"]) {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-side-runtime-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const runtimes: JarvisSideSessionRuntime[] = [];
	try {
		const { host } = await hostRegistry(stream);
		const bridge = new JarvisOverlayBridge();
		await run({ cwd, agentDir, bridge, create: async (overrides = {}) => {
			const runtime = await JarvisSideSessionRuntime.create({
				bridge, cwd, modelRegistry: host, model, thinkingLevel: "off", sessionFile: await createSideSessionFile(cwd),
				systemPromptProvider: () => "You are Main.", mainContextProvider: () => mainContext,
				toolAccessProvider: () => false,
				communicationPermissionsProvider: () => ({ allowFollowUpToMain: false, allowSteerToMain: false }),
				sendFollowUpToMain: () => {}, confirmSteerToMain: async () => false, sendSteerToMain: () => {},
				themeProvider: () => ({} as ExtensionContext["ui"]["theme"]), ...overrides,
			});
			runtimes.push(runtime);
			return runtime;
		} });
	} finally {
		for (const runtime of runtimes) runtime.dispose();
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		rmSync(root, { recursive: true, force: true });
	}
}

test("host-only native catalog, runtime auth, and header instrumentation survive public SDK bridge", async () => {
	let received: { model: Model<any>; context: TranscriptContext; options?: SimpleStreamOptions } | undefined;
	const { host, hostRuntime } = await hostRegistry((selected, context, options) => {
		received = { model: selected, context, options };
		return response(selected);
	});
	const { modelRuntime, sync } = await createSideModelRuntime(host);
	assert.deepEqual(modelRuntime.getModels().map((m) => `${m.provider}/${m.id}`), ["side-test/custom-only"]);
	assert.deepEqual((await modelRuntime.getAvailable()).map((m) => m.id), [model.id]);
	assert.equal((await modelRuntime.getAuth(model))?.auth.apiKey, "test-only-runtime-key");
	let transforms = 0;
	await modelRuntime.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, {
		transformHeaders: (headers) => {
			transforms++;
			assert.equal(headers["x-host"], "yes", "transform receives HOST assembled auth headers");
			return { ...headers, "x-transformed": "yes" };
		},
	}).result();
	assert.equal(transforms, 1);
	assert.equal(received?.options?.apiKey, "test-only-runtime-key");
	assert.equal(received?.model.baseUrl, "https://request.invalid");
	assert.equal(received?.options?.env?.SIDE_TEST, "host");
	assert.equal(received?.options?.headers?.["x-transformed"], "yes");
	await hostRuntime.setRuntimeApiKey(model.provider, "test-only-replaced-key");
	await modelRuntime.stream(model, { messages: [] }).result();
	assert.equal(received?.options?.apiKey, "test-only-replaced-key", "auth is not copied or frozen at boot");
	const added = { ...model, id: "late-model" };
	host.registerProvider({ ...host.getProvider(model.provider)!, getModels: () => [model, added] });
	await sync(added);
	assert.ok(modelRuntime.getModel(model.provider, added.id));
	const newProviderModel = { ...model, id: "late-provider-model", provider: "side-test-late-provider" };
	host.registerProvider({ ...host.getProvider(model.provider)!, id: newProviderModel.provider, getModels: () => [newProviderModel] });
	await hostRuntime.setRuntimeApiKey(newProviderModel.provider, "test-only-late-key");
	await sync(newProviderModel);
	assert.ok(modelRuntime.getModel(newProviderModel.provider, newProviderModel.id));
	assert.equal((await modelRuntime.getAuth(newProviderModel))?.auth.apiKey, "test-only-late-key");
});

test("host legacy custom provider is dispatched rather than silently selecting SDK builtins", async () => {
	const { host } = await hostRegistry();
	let calls = 0;
	host.registerProvider("side-test-legacy", {
		apiKey: "test-only-legacy-key", api: model.api,
		models: [{ ...model, id: "legacy-only" }],
		streamSimple: (selected, _context, options) => {
			calls++;
			assert.equal(options?.apiKey, "test-only-legacy-key");
			return response(selected);
		},
	});
	const selected = host.find("side-test-legacy", "legacy-only")!;
	assert.ok(selected);
	const { modelRuntime, sync } = await createSideModelRuntime(host);
	await sync(selected);
	assert.ok(modelRuntime.getModel(selected.provider, selected.id));
	await modelRuntime.streamSimple(selected, { messages: [] }).result();
	assert.equal(calls, 1);
});

test("virtual selections explicitly reject without using private host routing", async () => {
	const { host } = await hostRegistry();
	host.registerVirtualModel({ provider: "side-test-router", id: "auto", name: "Auto", route: () => ({ model, thinkingLevel: "off" }) });
	const virtual = host.find("side-test-router", "auto")!;
	const { modelRuntime, sync } = await createSideModelRuntime(host);
	assert.equal(modelRuntime.getModel(virtual.provider, virtual.id), undefined);
	await assert.rejects(sync(virtual), /public host registry does not expose session-aware routing/);
	assert.throws(() => modelRuntime.streamSimple(virtual, { messages: [] }), /Select a physical model/);
	await fixture(async ({ create }) => {
		await assert.rejects(create({ model: virtual }), /cannot use virtual model/);
	});
});

test("real side SDK prompts use host custom stream, isolated lazy cwd, and settled working state", async () => {
	let calls = 0;
	await fixture(async ({ cwd, bridge, create }) => {
		assert.notEqual(cwd, process.cwd());
		const runtime = await create();
		const session = sessionOf(runtime);
		assert.equal(session.sessionManager.getCwd(), cwd);
		assert.equal(existsSync(session.sessionManager.getSessionFile()!), false, "new session file remains lazy until a response");
		let endWorking: string | undefined;
		session.subscribe((event) => {
			if (event.type === "agent_end") endWorking = bridge.snapshot().workingMessage;
		});
		await runtime.sendMessage("hello custom host");
		assert.equal(calls, 1);
		assert.equal(endWorking, "Thinking…", "agent_end is not settlement");
		assert.equal(bridge.snapshot().workingMessage, undefined);
		assert.ok(runtime.getDisplayEntries().some((entry) => entry.text === "side reply"));
		assert.equal(JSON.parse(readFileSync(session.sessionManager.getSessionFile()!, "utf8").split("\n")[0]!).cwd, cwd);
		const ui = session.extensionRunner.createContext().ui;
		ui.setWorkingVisible(false);
		assert.equal(ui.getEditorComponent(), undefined);
	}, (selected) => { calls++; return response(selected); });
});

test("declined trust applies to both SDK settings and loader; unsupported MCP never starts", async () => {
	await fixture(async ({ cwd, create }) => {
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "high", defaultTools: ["bash"] }));
		writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "PROJECT SYSTEM MUST NOT LOAD");
		writeFileSync(join(cwd, ".pi", "prompts", "protected.md"), "protected prompt");
		const marker = join(cwd, "mcp-started");
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {
			unsupported: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] },
		} }));
		const runtime = await create({ projectTrusted: false, toolAccessProvider: () => true });
		const session = sessionOf(runtime);
		assert.equal(session.settingsManager.isProjectTrusted(), false);
		assert.deepEqual(session.settingsManager.getProjectSettings(), {});
		assert.equal(session.resourceLoader.getSystemPrompt(), undefined);
		assert.equal(session.resourceLoader.getPrompts().prompts.some((p) => p.name === "protected"), false);
		assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "edit", "read", "write"]);
		assert.equal(session.getAllTools().some((tool) => tool.name.includes("mcp")), false);
		assert.match(runtime.getRepoToolsDetailLabel(), /MCP unavailable: adapter unsupported on Pi 1.0/);
		assert.equal(existsSync(marker), false);
		const trusted = sessionOf(await create({ projectTrusted: true }));
		assert.equal(trusted.settingsManager.isProjectTrusted(), true);
		assert.equal(trusted.settingsManager.getProjectSettings().defaultThinkingLevel, "high");
		assert.equal(trusted.resourceLoader.getSystemPrompt(), "PROJECT SYSTEM MUST NOT LOAD");
		assert.equal(trusted.resourceLoader.getPrompts().prompts.some((p) => p.name === "protected"), true);
		assert.equal(existsSync(marker), false, "MCP stays intentionally disabled even in trusted projects");
	});
});

async function executeSteer(runtime: JarvisSideSessionRuntime, signal?: AbortSignal) {
	const session = sessionOf(runtime);
	const tool = session.getToolDefinition("jarvis_send_steer_to_main")!;
	const ctx = session.extensionRunner.createContext() as ExtensionToolContext;
	return tool.execute("test-steer", { message: "redirect" }, signal, undefined, ctx);
}

test("redirect confirmation revalidates permissions and cancels on signal or disposal", async () => {
	await fixture(async ({ create }) => {
		let permitted = true, sends = 0;
		let confirm!: (value: boolean) => void;
		let signalPassed: AbortSignal | undefined;
		const runtime = await create({
			communicationPermissionsProvider: () => ({ allowFollowUpToMain: true, allowSteerToMain: permitted }),
			confirmSteerToMain: (_message, signal) => { signalPassed = signal; return new Promise((resolve) => { confirm = resolve; }); },
			sendSteerToMain: () => { sends++; },
			sendFollowUpToMain: () => { sends++; },
		});
		const session = sessionOf(runtime);
		for (const name of ["jarvis_send_follow_up_to_main", "jarvis_send_steer_to_main"]) {
			for (const message of ["visible\x1b]hidden instruction\x07", "visible\u009bhidden instruction"]) {
				const result = await session.getToolDefinition(name)!.execute("unsafe-send", { message }, undefined, undefined,
					session.extensionRunner.createContext() as ExtensionToolContext);
				assert.equal((result.details as { status: string }).status, "blocked", "hidden terminal content must never be forwarded");
			}
		}
		assert.equal(sends, 0);
		const pending = executeSteer(runtime);
		permitted = false;
		confirm(true);
		assert.equal(((await pending).details as { status: string }).status, "blocked");
		assert.equal(sends, 0);
		permitted = true;
		const abort = new AbortController();
		const cancelled = executeSteer(runtime, abort.signal);
		abort.abort();
		assert.equal(((await cancelled).details as { status: string }).status, "cancelled", "does not wait for stale dialog resolution");
		assert.equal(signalPassed?.aborted, true);
		confirm(true);
		const disposed = executeSteer(runtime);
		runtime.dispose();
		assert.equal(((await disposed).details as { status: string }).status, "cancelled");
		confirm(true);
		assert.equal(sends, 0);
	});
});

test("tool execution gate blocks already-issued and nested calls after access is disabled", async () => {
	let calls = 0;
	await fixture(async ({ cwd, create }) => {
		writeFileSync(join(cwd, "input.txt"), "safe");
		const runtime = await create({ toolAccessProvider: () => true });
		const session = sessionOf(runtime);
		const runner = session.extensionRunner;
		assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "parent/1", parentToolCallId: "parent", input: { path: "input.txt" } }), undefined);
		assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "mcp__server__write", toolCallId: "parent/2", parentToolCallId: "parent", input: {} }))?.block, true);
		session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolCallId === "read-first") runtime.setToolAccessEnabled(false);
		});
		await runtime.sendMessage("read then write");
		assert.equal(existsSync(join(cwd, "should-not-exist.txt")), false);
		const results = session.messages.filter((message) => message.role === "toolResult");
		assert.ok(results.some((message) => message.role === "toolResult" && message.toolCallId === "write-second" && message.isError));
		assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "parent/3", parentToolCallId: "parent", input: { path: "input.txt" } }))?.block, true);
	}, (selected) => {
		calls++;
		return response(selected, calls === 1 ? [
			{ type: "toolCall", id: "read-first", name: "read", arguments: { path: "input.txt" } },
			{ type: "toolCall", id: "write-second", name: "write", arguments: { path: "should-not-exist.txt", content: "bad" } },
		] : undefined);
	});
});

test("live host generation/tool provider gates execution even without setter or preflight", async () => {
	await fixture(async ({ cwd, create }) => {
		let currentGeneration = true;
		const runtime = await create({ toolAccessProvider: () => currentGeneration });
		const session = sessionOf(runtime);
		const write = session.getToolDefinition("write")!;
		const ctx = session.extensionRunner.createContext() as ExtensionToolContext;
		currentGeneration = false;
		await assert.rejects(write.execute("already-prepared", { path: "generation-expired.txt", content: "bad" }, undefined, undefined, ctx), /tool access is disabled/);
		assert.equal(existsSync(join(cwd, "generation-expired.txt")), false);
		assert.equal((await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "stale/1", parentToolCallId: "stale", input: { path: "any" } }))?.block, true);
	});
});

test("failed initialization disposes acquired session without detaching shared bridge", async () => {
	await fixture(async ({ bridge, create }) => {
		let renders = 0;
		bridge.attach(() => { renders++; });
		const originalBind = (await import("@earendil-works/pi-coding-agent")).AgentSession.prototype.bindExtensions;
		const originalDispose = (await import("@earendil-works/pi-coding-agent")).AgentSession.prototype.dispose;
		const prototype = (await import("@earendil-works/pi-coding-agent")).AgentSession.prototype;
		let disposals = 0;
		prototype.bindExtensions = async () => { throw new Error("test bind failure"); };
		prototype.dispose = function () { disposals++; originalDispose.call(this); };
		try {
			await assert.rejects(create(), /test bind failure/);
			assert.equal(disposals, 1);
			const before = renders;
			bridge.notify("still attached");
			assert.ok(renders > before);
		} finally { prototype.bindExtensions = originalBind; prototype.dispose = originalDispose; }
		const runtime = await create();
		runtime.dispose();
		const before = renders;
		bridge.notify("replacement overlay remains attached");
		assert.ok(renders > before);
	});
});

test("retry/compaction events preserve working state until settlement and expose terminal errors", async () => {
	await fixture(async ({ bridge, create }) => {
		const runtime = await create();
		const handle = (runtime as unknown as { handleEvent: (event: AgentSessionEvent) => void }).handleEvent.bind(runtime);
		handle({ type: "agent_start" });
		handle({ type: "agent_end", messages: [], willRetry: true });
		assert.equal(bridge.snapshot().workingMessage, "Thinking…");
		handle({ type: "compaction_start", reason: "overflow" });
		handle({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: true });
		assert.equal(bridge.snapshot().workingMessage, "Compacting /jarvis…");
		handle({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "overloaded" });
		assert.match(bridge.snapshot().workingMessage!, /Retrying/);
		handle({ type: "auto_retry_end", success: false, attempt: 2, finalError: "terminal failure" });
		assert.ok(runtime.getDisplayEntries().some((entry) => entry.text === "terminal failure"));
		handle({ type: "agent_settled" });
		assert.equal(bridge.snapshot().workingMessage, undefined);
	});
});
