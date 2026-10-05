import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAssistantMessageEventStream, InMemoryCredentialStore,
	type AssistantMessage, type Model, type Provider, type ProviderHeaders, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader, ModelRegistry, ModelRuntime,
	type AgentSession, type AgentSessionEvent, type ExtensionContext, type ExtensionFactory, type ExtensionToolContext,
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

async function hostRegistry(
	streamSimple: Provider["streamSimple"] = (selected) => response(selected),
	beforeAuth?: (signal: AbortSignal) => Promise<void>,
) {
	const hostRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const registry = new ModelRegistry(hostRuntime);
	const provider: Provider = {
		id: model.provider, name: "Host custom provider", getModels: () => [model],
		auth: { apiKey: {
			name: "Test memory credential",
			check: async ({ credential }) => credential?.key ? { type: "api_key" } : undefined,
			resolve: async ({ credential, signal }) => {
				await beforeAuth?.(signal);
				return credential?.key ? {
					auth: { apiKey: credential.key, headers: { "x-host": "yes" }, baseUrl: "https://request.invalid" },
					env: { SIDE_TEST: "host" },
				} : undefined;
			},
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
}) => Promise<void>, stream?: Provider["streamSimple"], beforeAuth?: (signal: AbortSignal) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-side-runtime-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const runtimes: JarvisSideSessionRuntime[] = [];
	try {
		const { host } = await hostRegistry(stream, beforeAuth);
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
		await Promise.all(runtimes.map((runtime) => runtime.waitForDisposal()));
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

test("declined trust protects SDK settings/resources/MCP; trusted MCP still requires opt-in", async () => {
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
		assert.equal(runtime.getRepoToolsDetailLabel(), "local tools + native MCP");
		assert.equal(existsSync(marker), false);
		const trusted = sessionOf(await create({ projectTrusted: true }));
		assert.equal(trusted.settingsManager.isProjectTrusted(), true);
		assert.equal(trusted.settingsManager.getProjectSettings().defaultThinkingLevel, "high");
		assert.equal(trusted.resourceLoader.getSystemPrompt(), "PROJECT SYSTEM MUST NOT LOAD");
		assert.equal(trusted.resourceLoader.getPrompts().prompts.some((p) => p.name === "protected"), true);
		assert.equal(existsSync(marker), false, "trusted project MCP must not start while Repo tools is off");
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


async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	assert.fail("timed out waiting for isolated SDK fixture state");
}

test("stop uses public SDK abort/clearQueue and keeps the side owner, grants and bridge reusable", async () => {
	let calls = 0;
	await fixture(async ({ create, bridge }) => {
		const runtime = await create({ toolAccessProvider: () => true });
		const session = sessionOf(runtime), file = session.sessionManager.getSessionFile();
		let renders = 0; bridge.attach(() => { renders++; });
		const sending = runtime.sendMessage("cancel active synthetic stream");
		await until(() => calls === 1 && session.isStreaming);
		await session.steer("discard SDK waiting input");
		assert.ok(session.pendingMessageCount > 0);
		await runtime.cancelWork(); await sending;
		assert.equal(session.pendingMessageCount, 0);
		assert.equal(session.isStreaming, false); assert.equal(runtime.isReady(), true);
		assert.equal(runtime.getThinkingLevel(), session.thinkingLevel, "actual thinking uses only the public SDK property");
		assert.ok(session.getActiveToolNames().includes("read"), "stop does not revoke access");
		assert.equal(bridge.snapshot().workingMessage, undefined);
		assert.equal(sessionOf(runtime), session); assert.equal(session.sessionManager.getSessionFile(), file);
		const before = renders; bridge.notify("still subscribed after stop"); assert.ok(renders > before);
		await runtime.sendMessage("new explicit input"); assert.equal(calls, 2, "cancelled SDK queue never replays");
	}, (selected, _context, options) => {
		calls++;
		if (calls > 1) return response(selected);
		const stream = createAssistantMessageEventStream();
		void response(selected).result().then(message => {
			stream.push({ type: "start", partial: message });
			const abort = () => {
				stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted", errorMessage: "Synthetic stream cancelled" } });
				stream.end();
			};
			if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
		});
		return stream;
	});
});

test("foreground-only confirmation blocks closed redirects but does not revoke separately granted Note main", async () => {
	await fixture(async ({ create }) => {
		let foreground = true, notes = 0, redirects = 0;
		const bridge = new JarvisOverlayBridge(() => foreground);
		const runtime = await create({
			bridge,
			communicationPermissionsProvider: () => ({ allowFollowUpToMain: true, allowSteerToMain: true }),
			confirmSteerToMain: (message, signal) => bridge.requestConfirmation("Redirect", message, signal),
			sendFollowUpToMain: () => { notes++; }, sendSteerToMain: () => { redirects++; },
		});
		const pending = executeSteer(runtime);
		foreground = false; bridge.resolveConfirmation(false);
		assert.equal(((await pending).details as { status: string }).status, "cancelled");
		assert.equal(((await executeSteer(runtime)).details as { status: string }).status, "cancelled");
		assert.equal(bridge.hasPendingConfirmation(), false, "closed tools never hang awaiting an invisible review");
		const session = sessionOf(runtime);
		await session.getToolDefinition("jarvis_send_follow_up_to_main")!.execute("background-note", { message: "user-authorized note" }, undefined, undefined,
			session.extensionRunner.createContext() as ExtensionToolContext);
		assert.equal(notes, 1); assert.equal(redirects, 0);
		foreground = true;
		const reopened = executeSteer(runtime); bridge.resolveConfirmation(true);
		assert.equal(((await reopened).details as { status: string }).status, "sent"); assert.equal(redirects, 1);
	});
});

function latch() {
	let release!: () => void;
	const promise = new Promise<void>(resolve => { release = resolve; });
	return { promise, release };
}

// Load fixture hooks with the public inline-extension loader and mount its
// public records. Do not patch prompt(), inspect an Agent or host internals.
async function mountFixtureHooks(session: AgentSession, agentDir: string, factory: ExtensionFactory): Promise<void> {
	const loader = new DefaultResourceLoader({
		cwd: session.sessionManager.getCwd(), agentDir, noExtensions: true,
		settingsManager: session.settingsManager, extensionFactories: [factory],
	});
	await loader.reload();
	session.resourceLoader.getExtensions().extensions.unshift(...loader.getExtensions().extensions);
}

test("immediate stop revokes actual SDK idle preflight without a provider call; fresh explicit input works", async () => {
	let calls = 0;
	await fixture(async ({ create, bridge }) => {
		const runtime = await create({ toolAccessProvider: () => true });
		const session = sessionOf(runtime);
		const old = runtime.sendMessage("stop before SDK startup");
		const stopping = runtime.cancelWork();
		await Promise.all([old, stopping]);
		assert.equal(calls, 0, "idle SDK abort must not allow the pending prompt to dispatch later");
		assert.equal(session.isStreaming, false);
		assert.equal(session.pendingMessageCount, 0);
		assert.equal(runtime.isReady(), true);
		assert.equal(sessionOf(runtime), session);
		assert.ok(session.getActiveToolNames().includes("read"));
		assert.equal(bridge.snapshot().workingMessage, undefined);
		await runtime.sendMessage("fresh explicit post-stop request");
		assert.equal(calls, 1, "no cancelled input is retried or queued");
	}, selected => { calls++; return response(selected); });
});

for (const operation of ["stop", "dispose"] as const) {
	test(`${operation} revokes delayed SDK preflight; new sends cannot revive the old permit`, async () => {
		let calls = 0;
		await fixture(async ({ create, agentDir }) => {
			const runtime = await create();
			const session = sessionOf(runtime);
			const entered = latch(), held = latch();
			await mountFixtureHooks(session, agentDir, pi => {
				pi.on("before_agent_start", async event => {
					if (event.prompt !== "old held preflight") return;
					entered.release();
					await held.promise;
				});
			});
			const old = runtime.sendMessage("old held preflight");
			try {
				await entered.promise;
				assert.equal(session.isStreaming, false, "hook really precedes active SDK ownership");
				if (operation === "stop") await runtime.cancelWork();
				else runtime.dispose();
				const freshRuntime = operation === "stop" ? runtime : await create();
				await freshRuntime.sendMessage("fresh while old SDK preflight is still held");
				assert.equal(calls, 1);
				held.release();
				await old;
				assert.equal(calls, 1, "fresh permit must not authorize late cancelled dispatch");
				await freshRuntime.sendMessage("fresh after old SDK prompt settles");
				assert.equal(calls, 2);
				if (operation === "stop") assert.equal(session.pendingMessageCount, 0);
				else await assert.rejects(runtime.sendMessage("disposed input"), /not ready/);
			} finally {
				held.release();
				await old.catch(() => {});
			}
		}, selected => { calls++; return response(selected); });
	});
}

test("a delayed old input cannot enter a fresh active SDK run after stop", async () => {
	let calls = 0;
	const finishFresh = latch();
	await fixture(async ({ create, agentDir }) => {
		const runtime = await create(), session = sessionOf(runtime);
		const entered = latch(), held = latch();
		await mountFixtureHooks(session, agentDir, pi => {
			pi.on("input", async event => {
				if (event.text !== "old input") return;
				entered.release();
				await held.promise;
			});
		});
		const old = runtime.sendMessage("old input");
		let fresh: Promise<void> | undefined;
		try {
			await entered.promise;
			await runtime.cancelWork();
			fresh = runtime.sendMessage("fresh active input");
			await until(() => calls === 1 && session.isStreaming);
			held.release();
			await old;
			assert.equal(session.pendingMessageCount, 0, "revoked input must not become a steer/follow-up in a new run");
			finishFresh.release();
			await fresh;
			assert.equal(calls, 1);
			assert.equal(session.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("old input")), false);
			await runtime.sendMessage("another explicit post-stop input");
			assert.equal(calls, 2);
		} finally {
			held.release(); finishFresh.release();
			await Promise.allSettled([old, fresh]);
		}
	}, selected => {
		calls++;
		if (calls > 1) return response(selected);
		const stream = createAssistantMessageEventStream();
		void finishFresh.promise.then(async () => {
			const message = await response(selected).result();
			stream.push({ type: "done", reason: "stop", message }); stream.end();
		});
		return stream;
	});
});

for (const operation of ["stop", "dispose"] as const) {
	test(`${operation} during synthetic host auth prevents provider dispatch despite late auth completion`, async () => {
		let calls = 0, holdAuth = false;
		let authSignal: AbortSignal | undefined;
		const entered = latch(), held = latch(), authFinished = latch();
		await fixture(async ({ create }) => {
			const runtime = await create();
			holdAuth = true;
			const old = runtime.sendMessage("held host auth");
			let stopping: Promise<void> | undefined;
			try {
				await entered.promise;
				assert.equal(calls, 0);
				if (operation === "stop") stopping = runtime.cancelWork();
				else runtime.dispose();
				assert.equal(authSignal?.aborted, true, "permit reaches the host's public auth operation");
				holdAuth = false;
				held.release();
				await Promise.all([old, stopping, authFinished.promise]);
				assert.equal(calls, 0, "auth resolver deliberately ignores cancellation; no late provider call is allowed");
				const freshRuntime = operation === "stop" ? runtime : await create();
				await freshRuntime.sendMessage("fresh explicit request after held auth");
				assert.equal(calls, 1);
			} finally {
				holdAuth = false; held.release();
				await Promise.allSettled([old, stopping]);
			}
		}, selected => { calls++; return response(selected); }, async signal => {
			if (!holdAuth) return;
			authSignal = signal; entered.release();
			await held.promise; // Deliberately non-cooperative fixture resolver.
			authFinished.release();
		});
	});
}

test("stop during asynchronous SDK header transforms rejects before host provider dispatch", async () => {
	let calls = 0, headersSeen = 0;
	await fixture(async ({ create, agentDir }) => {
		const runtime = await create(), session = sessionOf(runtime);
		const entered = latch(), held = latch();
		await mountFixtureHooks(session, agentDir, pi => {
			pi.on("before_provider_headers", async event => {
				headersSeen++;
				assert.equal(event.headers["x-host"], "yes", "host assembles auth exactly once before transforms");
				event.headers["x-fixture"] = "preserved";
				if (headersSeen !== 1) return;
				entered.release(); await held.promise;
			});
		});
		const old = runtime.sendMessage("held header transform");
		let stopping: Promise<void> | undefined;
		try {
			await entered.promise;
			stopping = runtime.cancelWork();
			held.release();
			await Promise.all([old, stopping]);
			assert.equal(calls, 0);
			await runtime.sendMessage("fresh explicit request after header cancellation");
			assert.equal(calls, 1);
			assert.equal(headersSeen, 2);
		} finally {
			held.release(); await Promise.allSettled([old, stopping]);
		}
	}, (selected, _context, options) => {
		calls++;
		assert.equal(options?.headers?.["x-fixture"], "preserved");
		assert.equal(options?.apiKey, "test-only-runtime-key");
		return response(selected);
	});
});

test("both delegated public stream methods capture and enforce the request permit", async () => {
	let calls = 0, transformed = 0;
	const { host } = await hostRegistry(selected => { calls++; return response(selected); });
	let permit = new AbortController();
	const { modelRuntime } = await createSideModelRuntime(host, () => permit.signal);
	permit.abort();
	assert.throws(() => modelRuntime.stream(model, { messages: [] }), { name: "AbortError" });
	assert.throws(() => modelRuntime.streamSimple(model, { messages: [] }), { name: "AbortError" });
	assert.equal(calls, 0);
	for (const method of ["stream", "streamSimple"] as const) {
		permit = new AbortController();
		const captured = permit;
		const entered = latch(), held = latch();
		const result = modelRuntime[method](model, { messages: [] }, {
			transformHeaders: async (headers: ProviderHeaders) => {
				transformed++; entered.release(); await held.promise;
				return { ...headers, "x-delegated": "yes" };
			},
		}).result();
		await entered.promise;
		captured.abort();
		permit = new AbortController(); // Must not revive the captured request.
		held.release();
		const cancelled = await result;
		assert.equal(cancelled.stopReason, "error");
		assert.match(cancelled.errorMessage!, /aborted/);
		assert.equal(calls, 0);
		assert.equal((await modelRuntime[method](model, { messages: [] }).result()).stopReason, "stop");
		assert.equal(calls, 1);
		calls = 0;
	}
	assert.equal(transformed, 2, "existing header transforms run only once");
});
