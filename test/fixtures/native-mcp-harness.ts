import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAssistantMessageEventStream, getCurrentTools, InMemoryCredentialStore,
	type AssistantMessage, type JsonObject, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JarvisOverlayBridge } from "../../overlay.js";
import { createSideSessionFile, JarvisSideSessionRuntime } from "../../side-session.js";
import type { MainSessionContextPayload } from "../../main-context.js";

export const model: Model<any> = {
	id: "local-fixture", name: "Local MCP Test", provider: "native-mcp-test", api: "native-mcp-test-api",
	baseUrl: "https://never-request.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const mainContext: MainSessionContextPayload = {
	summary: {
		mainStatus: "idle", mainModelLabel: "fixture/main", currentToolActivity: { active: false, running: [] }, pendingMessages: false,
		workState: { attentionMode: "waiting", currentAction: "idle", activeFiles: [], recentFiles: [] }, validation: { status: "none", summary: "none" },
	}, summaryText: "main idle", workStateText: "idle", recentEntries: [], recentText: "none",
};
export type Call = { name: string; arguments: Record<string, unknown>; id?: string };
export type LedgerEntry = { event: string; pid: number; method?: string; name?: string; value?: string; uri?: string; revision?: number; envValue?: string; reason?: string };
export type CreateOptions = Partial<Parameters<typeof JarvisSideSessionRuntime.create>[0]>;
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function bounded<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms); })]);
	} finally { clearTimeout(timer); }
}
export async function until(check: () => boolean, label: string, ms = 8000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
		await delay(10);
	}
}
export function alive(pid: number) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
// Probe only our owned runtime; all interaction with the actual Pi SDK is public.
export function sessionOf(runtime: JarvisSideSessionRuntime): AgentSession {
	return (runtime as unknown as { session: AgentSession }).session;
}
function response(selected: Model<any>, calls?: Call[]) {
	const content: AssistantMessage["content"] = calls?.map((call, i) => ({ type: "toolCall", name: call.name, arguments: call.arguments as JsonObject, id: call.id ?? `fixture-call-${i}` })) ?? [{ type: "text", text: "fixture finished" }];
	const message: AssistantMessage = {
		role: "assistant", provider: selected.provider, model: selected.id, api: selected.api, content, timestamp: Date.now(), stopReason: calls ? "toolUse" : "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message });
	stream.end();
	return stream;
}
export class ScriptedHost {
	private steps: Call[][] = [];
	readonly contexts: TranscriptContext[] = [];
	private sequence = 0;
	setSteps(...steps: Call[][]) { assert.equal(this.steps.length, 0, "previous fixture plan consumed"); this.steps = steps; }
	readonly stream: Provider["streamSimple"] = (selected, context) => {
		assert.equal(selected.provider, model.provider, "never dispatch to a billed provider");
		this.contexts.push(context);
		const steps = this.steps.shift()?.map((call) => ({ ...call, id: call.id ?? `fixture-call-${++this.sequence}` }));
		return response(selected, steps);
	};
	declared() { return getCurrentTools(this.contexts.at(-1)?.messages ?? []).map((tool) => tool.name); }
	async prompt(runtime: JarvisSideSessionRuntime, ...steps: Call[][]) {
		this.setSteps(...steps);
		await bounded(runtime.sendMessage("Execute the deterministic local fixture plan."), "SDK fixture prompt");
		assert.equal(this.steps.length, 0, "all scripted turns consumed");
	}
}
export class LocalServer {
	readonly ledger: string;
	readonly control: string;
	readonly release: string;
	readonly callRelease: string;
	constructor(readonly name: string, root: string, readonly held = false) {
		this.ledger = join(root, `${name}.jsonl`);
		this.control = join(root, `${name}.control`);
		this.release = join(root, `${name}.release`);
		this.callRelease = join(root, `${name}.call-release`);
	}
	config(extra: Record<string, unknown> = {}) {
		return {
			command: process.execPath, args: [fileURLToPath(new URL("./native-mcp-server.mjs", import.meta.url)), this.ledger, this.control, this.held ? this.release : "", this.callRelease],
			timeout: 3, exposure: "direct", toolExposure: { deferred_echo: "deferred", code_echo: "codemode", hidden_echo: "hidden" }, ...extra,
		};
	}
	entries(): LedgerEntry[] {
		if (!existsSync(this.ledger)) return [];
		// A read can observe a partially appended last line. Only consume complete lines.
		return readFileSync(this.ledger, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line));
	}
	calls() { return this.entries().filter((entry) => entry.event === "call"); }
	unhold() { writeFileSync(this.release, "ready"); }
	unholdCall() { writeFileSync(this.callRelease, "ready"); }
	changeTools() { writeFileSync(this.control, "1"); }
	async started() { await until(() => this.entries().some((entry) => entry.method === "initialize"), `${this.name} initialize request`); }
	async stopped() {
		await until(() => this.entries().filter((entry) => entry.event === "start").every((entry) => !alive(entry.pid)), `${this.name} process exit`);
		assert.equal(this.entries().filter((entry) => entry.event === "stop").length, this.entries().filter((entry) => entry.event === "start").length, "native shutdown closes every fixture generation cleanly");
	}
}
export async function fixture(run: (f: {
	root: string; cwd: string; agentDir: string; bridge: JarvisOverlayBridge; host: ScriptedHost;
	server: (name?: string, held?: boolean) => LocalServer;
	globalConfig: (servers: Record<string, unknown>) => void; projectConfig: (servers: Record<string, unknown>) => void;
	create: (overrides?: CreateOptions) => Promise<JarvisSideSessionRuntime>;
}) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-native-mcp-"));
	const cwd = join(root, "workspace"), agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const runtimes: JarvisSideSessionRuntime[] = [], servers: LocalServer[] = [];
	const creating: Promise<JarvisSideSessionRuntime>[] = [];
	try {
		const scripted = new ScriptedHost();
		const hostRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const registry = new ModelRegistry(hostRuntime);
		registry.registerProvider({
			id: model.provider, name: "Zero-cost local host", getModels: () => [model],
			auth: { apiKey: { name: "Memory-only fixture credential", check: async ({ credential }) => credential?.key ? { type: "api_key" } : undefined,
				resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined } },
			stream: (selected, context, options) => scripted.stream(selected, context, options as SimpleStreamOptions | undefined), streamSimple: scripted.stream,
		});
		await hostRuntime.setRuntimeApiKey(model.provider, "local-test-not-a-real-key");
		const host = new Proxy(registry, { get(target, property) {
			assert.notEqual(property, "runtime", "public host registry facade only");
			if (property === "getAll") return () => [model];
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		} });
		const bridge = new JarvisOverlayBridge();
		await run({ root, cwd, agentDir, bridge, host: scripted,
			server: (name = "fixture", held = false) => { const server = new LocalServer(name, root, held); servers.push(server); return server; },
			globalConfig: (mcpServers) => writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers })),
			projectConfig: (mcpServers) => writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers })),
			create: (overrides = {}) => {
				const pending = (async () => {
					const runtime = await JarvisSideSessionRuntime.create({
						bridge, cwd, modelRegistry: host, model, thinkingLevel: "off", sessionFile: await createSideSessionFile(cwd), projectTrusted: true,
						systemPromptProvider: () => "You are a deterministic fixture.", mainContextProvider: () => mainContext, toolAccessProvider: () => false,
						communicationPermissionsProvider: () => ({ allowFollowUpToMain: false, allowSteerToMain: false }),
						sendFollowUpToMain: () => {}, confirmSteerToMain: async () => false, sendSteerToMain: () => {},
						themeProvider: () => ({} as ExtensionContext["ui"]["theme"]), ...overrides,
					});
					runtimes.push(runtime); return runtime;
				})();
				creating.push(pending); return bounded(pending, "side runtime creation");
			},
		});
	} finally {
		for (const server of servers) { server.unhold(); server.unholdCall(); }
		await bounded(Promise.allSettled(creating), "settle pending creates", 4000).catch(() => {});
		for (const runtime of runtimes) runtime.dispose();
		await bounded(Promise.allSettled(runtimes.map((runtime) => runtime.waitForDisposal())), "owned disposal callbacks", 4000).catch(() => {});
		// Assertion paths above verify native shutdown. Emergency cleanup is mandatory even on failure.
		await until(() => servers.every((server) => server.entries().filter((entry) => entry.event === "start").every((entry) => !alive(entry.pid))), "fixture cleanup", 2000).catch(() => {});
		for (const server of servers) for (const entry of server.entries().filter((item) => item.event === "start")) {
			if (alive(entry.pid)) { try { process.kill(entry.pid, "SIGKILL"); } catch {} }
		}
		await until(() => servers.every((server) => server.entries().filter((entry) => entry.event === "start").every((entry) => !alive(entry.pid))), "emergency fixture child exit", 1000).catch(() => {});
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		rmSync(root, { recursive: true, force: true });
	}
}
