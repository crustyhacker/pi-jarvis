import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWatcherExtension } from "../watchers-extension.js";
import { saveWatcherPolicy } from "../watchers-config.js";
import { WATCHER_MESSAGE_TYPE, type WatcherRequest } from "../watchers-types.js";
import { deferred, drain, FakeClock, fixture, result } from "./watchers-fixture.js";

const request = { label: "fixture marker", note: "Wait for the marker. Inspect the synthetic result.", condition: { kind: "command", command: "exit 0" }, intervalSeconds: 10, timeoutSeconds: 120 };
function harness(enabled = true) {
	const f = fixture(), clock = new FakeClock(), handlers = new Map<string, Array<(e: any, ctx: any) => any>>(), tools = new Map<string, any>(), commands = new Map<string, any>(), entries: any[] = [], notices: string[] = [], updates: any[] = [], sends: any[] = [], repeats: any[] = [], launches: any[] = [], statuses = new Map<string, string | undefined>();
	let available = true, trusted = true, deny = false, mutate = false, busy = false, firstGate: Promise<void> | undefined;
	if (enabled) saveWatcherPolicy(f.cwd, f.agentDir, "global", { enabled: true });
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name,t), registerCommand: (n: string,c: any) => commands.set(n,c), on: (n: string,h: any) => { handlers.set(n,[...(handlers.get(n) ?? []),h]); },
		appendEntry: (customType: string,data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (m: any,o: any) => { assert.deepEqual(o,{ triggerTurn: true, deliverAs: "followUp" }); sends.push({ m,o,delivered: !busy }); },
		exec: async (exe: string,args: string[],opts: any) => { repeats.push({ exe,args,opts }); const record = controller.service.list().find(r => r.state === "running")!; return { code: 0, killed: false, stdout: JSON.stringify(result(record.id,0)), stderr: "" }; },
	};
	const ctx: any = { cwd: f.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => trusted, sessionManager: { getBranch: () => entries, getSessionId: () => "extension-fixture" }, ui: { notify: (text: string) => notices.push(text), setStatus: (key: string,text: string | undefined) => statuses.set(key,text) },
		async executeTool(_name: string,args: any) {
			launches.push(structuredClone(args)); await firstGate;
			if (deny) return { isError: true, result: { content: [{ type: "text", text: "Denied by fixture hook" }] } };
			const actual = mutate ? { ...args, command: `${args.command}\n# changed by fixture hook` } : args;
			await emit("tool_result", { toolName: "bash", parentToolCallId: "setup-fixture", input: actual });
			const record = controller.service.list().find(r => r.state === "setting")!;
			return { isError: false, result: { content: [], structuredContent: { exit_code: 0, output: JSON.stringify(result(record.id)) } } };
		},
	};
	async function emit(name: string, event: any = {}) { for (const handler of handlers.get(name) ?? []) await handler(event,ctx); }
	const controller = createWatcherExtension(pi, f.agentDir, { clock, available: () => available });
	return { ...f, ctx, pi, clock, tools, commands, entries, notices, updates, sends, repeats, launches, statuses, controller, emit,
		available: (v: boolean) => { available = v; }, trusted: (v: boolean) => { trusted = v; }, deny: () => { deny = true; }, mutate: () => { mutate = true; }, gate: (g: Promise<void>) => { firstGate = g; }, busy: (v: boolean) => { busy = v; if (!v) for (const send of sends) send.delivered = true; },
		set: (params: WatcherRequest = request as WatcherRequest) => tools.get("jarvis_watcher_set").execute("setup-fixture", params, undefined, (u: any) => { updates.push(u); }, ctx),
		shutdown: async () => { await emit("session_shutdown"); f.close(); },
	};
}
test("factory exposes only hidden declarations, starts no timers and writes no session entries", async () => {
	const h = harness(false); try { assert.equal(h.tools.get("jarvis_watcher_set").exposure, "hidden"); assert.equal(h.clock.timers.size,0); assert.equal(h.entries.length,0); await h.emit("session_start"); assert.equal(h.entries.length,0); } finally { await h.shutdown(); }
});
test("displayed, launched and repeated command bytes and cwd are identical, supervisor included", async () => {
	const h = harness(); try {
		await h.emit("session_start"); await h.set(); const r = h.controller.service.list()[0]!;
		assert.equal(h.updates[0].details.launchCommand,r.command); assert.ok(h.updates[0].content[0].text.endsWith(r.command)); assert.equal(h.launches[0].command,r.command);
		await h.clock.advance(10_000); assert.equal(h.repeats.length,1); assert.equal(h.repeats[0].exe,"/bin/sh"); assert.deepEqual(h.repeats[0].args,["-c",r.command]); assert.equal(h.repeats[0].opts.cwd,r.cwd);
		assert.ok(r.command.includes("Check runtime limit reached.")); assert.match(h.sends[0].m.content,/"reason": "met"/);
	} finally { await h.shutdown(); }
});
test("watcher launch and final result collapse to themed plain-language summaries using Pi expansion state", async () => {
	// This fixture has no live application's binding metadata: show an explicitly labelled default.
	const h = harness(); try {
		await h.emit("session_start");
		const params: WatcherRequest = { ...request, condition: { kind: "file_lines", path: "watcher-demo.txt", minLines: 3 } };
		const final = await h.set(params), tool = h.tools.get("jarvis_watcher_set"), record = h.controller.service.list()[0]!;
		const colours: string[] = [], theme = { fg: (colour: string, text: string) => { colours.push(colour); return text; } };
		const context = { args: params, cwd: h.cwd, state: {}, expanded: false, isError: false };
		for (const result of [h.updates[0], final]) {
			const lines = tool.renderResult(result, { expanded: false, isPartial: result === h.updates[0] }, theme, context).render(180).map((line: string) => line.trimEnd());
			assert.equal(lines.length, 5);
			assert.match(lines[0]!, /Watcher · fixture marker/);
			assert.equal(lines[1], "file watcher-demo.txt reaches 3 lines");
			assert.equal(lines[2], "Every 10s · time limit 120s");
			assert.equal(lines[3], `Working directory: ${h.cwd}`);
			assert.equal(lines[4], `Full launch/repeat command: ${record.command.split("\n").length} lines · ctrl+o (default) to expand`);
			assert.equal(lines.join("\n").includes("function main"), false);
			assert.equal(lines.join("\n").includes(record.command), false);
		}
		assert.equal(tool.renderCall(params, theme, context).render(180).length, 0, "progress/result owns the command block, not a duplicated call header");
		assert.ok(colours.length > 0); assert.ok(colours.every(colour => colour === "accent"), "use the semantic accent, not added-code/success green or hard-coded colour");
		assert.equal(h.launches[0].command, record.command, "collapsed presentation must not collapse the approved arguments");
	} finally { await h.shutdown(); }
});
test("Pi-expanded watcher launch and final result show the exact immutable command and collapse again", async () => {
	const h = harness(); try {
		await h.emit("session_start");
		const params: WatcherRequest = { ...request, condition: { kind: "file_lines", path: "watcher-demo.txt", minLines: 3 } };
		const final = await h.set(params), tool = h.tools.get("jarvis_watcher_set"), record = h.controller.service.list()[0]!;
		const painted: string[] = [], theme = { fg: (_colour: string, text: string) => { painted.push(text); return text; } };
		const context = { args: params, cwd: h.cwd, state: {}, expanded: true, isError: false };
		for (const result of [h.updates[0], final]) {
			const component = tool.renderResult(result, { expanded: true, isPartial: result === h.updates[0] }, theme, context);
			assert.equal(painted.at(-1), record.command, "the renderer receives the complete original command bytes without reformatting");
			const lines = component.render(32768).map((line: string) => line.trimEnd());
			assert.equal(lines[4], `Full launch/repeat command: ${record.command.split("\n").length} lines · ctrl+o (default) to collapse`);
			assert.equal(lines.slice(5).join("\n"), record.command);
			const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, { ...context, expanded: false }).render(180);
			assert.equal(collapsed.length, 5);
		}
		await h.clock.advance(10000);
		assert.equal(h.updates[0].details.launchCommand, record.command);
		assert.equal(h.launches[0].command, record.command);
		assert.deepEqual(h.repeats[0].args, ["-c", record.command]);
		assert.equal(h.repeats[0].opts.cwd, record.cwd);
	} finally { await h.shutdown(); }
});
test("launch denial refuses the watcher and schedules nothing", async () => {
	const h = harness(); try { await h.emit("session_start"); h.deny(); await assert.rejects(h.set(),/launch was denied/); assert.equal(h.controller.service.list().length,0); await h.clock.advance(300_000); assert.equal(h.repeats.length,0); assert.equal(h.sends.length,0); } finally { await h.shutdown(); }
});
test("launch argument mutation refuses repetition of an unverified command", async () => {
	const h = harness(); try { await h.emit("session_start"); h.mutate(); await assert.rejects(h.set(),/altered by hooks/); assert.equal(h.controller.service.list().length,0); assert.equal(h.clock.timers.size,0); } finally { await h.shutdown(); }
});
test("busy wake-up requests followUp once and is delivered only after existing work", async () => {
	const h = harness(); try { await h.emit("session_start"); await h.set(); h.busy(true); await h.clock.advance(10_000); assert.equal(h.sends.length,1); assert.equal(h.sends[0].delivered,false); h.busy(false); assert.equal(h.sends[0].delivered,true); await h.clock.advance(200_000); assert.equal(h.sends.length,1); } finally { await h.shutdown(); }
});
test("local status and cancellation work without a tool call or side boot", async () => {
	const h = harness(); try { await h.emit("session_start"); await h.set(); const r = h.controller.service.list()[0]!; await h.controller.command("status",h.ctx); assert.match(h.notices.at(-1)!,/waited 0s · ends/); await h.controller.command(`cancel ${r.id}`,h.ctx); await h.clock.advance(120_000); assert.equal(h.repeats.length,0); assert.equal(h.launches.length,1); } finally { await h.shutdown(); }
});
test("prepared tool refuses execution after trust denial", async () => {
	const h = harness(); try { await h.emit("session_start"); const prepared = h.tools.get("jarvis_watcher_set"); h.trusted(false); await assert.rejects(prepared.execute("fixture",request,undefined,undefined,h.ctx),/permission expired/); assert.equal(h.launches.length,0); } finally { await h.shutdown(); }
});
test("main lifecycle replacement aborts pending setup and rejects its late result", async () => {
	const h = harness(), gate = deferred<void>(); try { await h.emit("session_start"); h.gate(gate.promise); const pending = h.set(); await drain(); assert.equal(h.controller.hasPendingSetup(),true); await h.emit("session_shutdown"); gate.resolve(); await assert.rejects(pending,/permission expired/); assert.equal(h.repeats.length,0); assert.equal(h.sends.length,0); } finally { h.close(); }
});
test("private input holds a timeout notification until the fake-clock admission check", async () => {
	const h = harness(); try { await h.emit("session_start"); await h.set(); h.available(false); await h.clock.advance(120_000); assert.equal(h.sends.length,0); h.available(true); await h.clock.advance(1000); assert.equal(h.sends.length,1); assert.match(h.sends[0].m.content,/"reason": "timed out"/); } finally { await h.shutdown(); }
});
test("off control cancels checks without touching shared memory or archive files", async () => {
	const h = harness(); try { await h.emit("session_start"); await h.set(); await h.controller.command("off",h.ctx); assert.equal(h.tools.get("jarvis_watcher_set").exposure,"hidden"); await h.clock.advance(120_000); assert.equal(h.repeats.length,0); assert.equal(h.sends.length,0); } finally { await h.shutdown(); }
});

const model: Model<any> = { id: "local-fixture", name: "Local watcher fixture", provider: "watcher-fixture", api: "watcher-fixture-api", baseUrl: "https://never-requested.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(content: AssistantMessage["content"] = [{ type: "text", text: "fixture idle" }]) {
	const message: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api, content, timestamp: Date.now(), stopReason: content.some(c => c.type === "toolCall") ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); return stream;
}
async function sdk(streamSimple: Provider["streamSimple"], run: (f: ReturnType<typeof fixture>, clock: FakeClock, session: AgentSession, controller: ReturnType<typeof createWatcherExtension>, repeatDone: ReturnType<typeof deferred<void>>) => Promise<void>, deny = false) {
	const f = fixture(), clock = new FakeClock(), repeatDone = deferred<void>(); let session: AgentSession | undefined, controller!: ReturnType<typeof createWatcherExtension>;
	try {
		writeFileSync(join(f.agentDir,"settings.json"),JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" })); saveWatcherPolicy(f.cwd,f.agentDir,"global",{ enabled: true });
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		new ModelRegistry(runtime).registerProvider({ id: model.provider, name: "Local watcher fixture", getModels: () => [model], auth: { apiKey: { name: "Fixture auth", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: { apiKey: "fixture-only" } }) } }, stream: (m,c,o) => streamSimple(m,c,o as SimpleStreamOptions), streamSimple });
		await runtime.setRuntimeApiKey(model.provider,"fixture-only");
		const settingsManager = SettingsManager.create(f.cwd,f.agentDir,{ projectTrusted: true });
		const resourceLoader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Local fixture only.", extensionFactories: [
			(pi: ExtensionAPI) => { controller = createWatcherExtension({ ...pi, exec: async (...args) => { const r = await pi.exec(...args); repeatDone.resolve(); return r; } },f.agentDir,{ clock, available: () => true }); },
			(pi: ExtensionAPI) => { if (deny) pi.on("tool_call",e => e.toolName === "bash" ? { block: true, reason: "Fixture denies bash" } : undefined); },
		] });
		await resourceLoader.reload();
		({ session } = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader, settingsManager, sessionManager: SessionManager.create(f.cwd,join(f.agentDir,"sessions")) }));
		await session.bindExtensions({ onError: error => { assert.fail(error.error); } });
		await run(f,clock,session,controller,repeatDone);
	} finally { session?.dispose(); f.close(); }
}
test("real Pi idle wake uses normal initial bash hooks, with no fixture model calls while waiting", async () => {
	let requests = 0, marker = "";
	await sdk((_m,context) => { requests++; return requests === 1 ? response([{ type: "toolCall", id: "set-real", name: "jarvis_watcher_set", arguments: { ...request, condition: { kind: "command", command: `test -e '${marker}'` } } }]) : response(); }, async (f,clock,session,controller,repeatDone) => {
		marker = join(f.cwd,"done"); await session.prompt("Set the fixture watcher."); assert.equal(requests,2); assert.equal(controller.service.list()[0]!.state,"running");
		const notification = deferred<void>(); session.subscribe(e => { if (e.type === "message_end" && e.message.role === "custom" && e.message.customType === WATCHER_MESSAGE_TYPE) notification.resolve(); });
		writeFileSync(marker,"fixture"); await clock.advance(10_000); await repeatDone.promise; await notification.promise; await session.waitForIdle(); assert.equal(requests,3);
		const messages = session.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === WATCHER_MESSAGE_TYPE); assert.equal(messages.length,1); assert.match((messages[0] as any).content,/"reason": "met"/);
	});
});
test("real Pi busy wake is queued after the held turn and delivered once", async () => {
	let requests = 0, marker = "", release!: () => void; const started = deferred<void>();
	await sdk((_m,context) => {
		requests++;
		if (requests === 1) return response([{ type: "toolCall", id: "set-busy", name: "jarvis_watcher_set", arguments: { ...request, condition: { kind: "command", command: `test -e '${marker}'` } } }]);
		if (requests === 3) {
			const stream = createAssistantMessageEventStream();
			release = () => { const done = response(); void done.result().then(m => { stream.push({ type: "done", reason: "stop", message: m }); stream.end(); }); }; started.resolve(); return stream;
		}
		return response();
	}, async (f,clock,session,controller,repeatDone) => {
		marker = join(f.cwd,"done"); await session.prompt("Set fixture watcher."); assert.equal(requests,2);
		const busy = session.prompt("Hold this turn."); await started.promise;
		writeFileSync(marker,"fixture"); await clock.advance(10_000); await repeatDone.promise; await drain();
		assert.equal(requests,3); assert.equal(controller.service.list()[0]!.delivery,"submitted"); assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === WATCHER_MESSAGE_TYPE).length,0);
		release(); await busy; await session.waitForIdle(); assert.equal(requests,4); assert.equal(session.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === WATCHER_MESSAGE_TYPE).length,1);
	});
});
test("real Pi bash permission denial cannot start the predicate or schedule repeats", async () => {
	let requests = 0;
	await sdk(() => { requests++; return requests === 1 ? response([{ type: "toolCall", id: "set-denied", name: "jarvis_watcher_set", arguments: request }]) : response(); }, async (_f,clock,session,controller) => {
		await session.prompt("Attempt denied fixture watcher."); assert.equal(controller.service.list().length,0); assert.equal(clock.timers.size,0); assert.equal(requests,2);
		const tool = session.messages.find(m => m.role === "toolResult" && m.toolName === "jarvis_watcher_set") as any; assert.equal(tool.isError,true); assert.match(tool.content[0].text,/launch was denied/);
	}, true);
});
