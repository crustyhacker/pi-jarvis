import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentSession, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { JarvisSideSessionRuntime } from "../side-session.js";
import { bounded, delay, fixture, sessionOf, until, type Call, type CreateOptions } from "./fixtures/native-mcp-harness.js";

const direct = "mcp__fixture__direct_echo", deferred = "mcp__fixture__deferred_echo", code = "mcp__fixture__code_echo";
const destructive = "mcp__fixture__destructive_echo", hidden = "mcp__fixture__hidden_echo";
const call = (name: string, value: string, id?: string): Call => ({ name, arguments: { value }, ...(id ? { id } : {}) });
const script = (source: string, id?: string): Call => ({ name: "codemode", arguments: { code: `// @options: {"timeout_ms": 3000}\n${source}` }, ...(id ? { id } : {}) });
const search = (): Call => ({ name: "tool_search", arguments: { query: "deferred_echo", limit: 1 } });
const repoTool = (name: string) => name.startsWith("mcp__") || ["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name);
async function connected(runtime: JarvisSideSessionRuntime, name = direct) {
	await bounded(runtime.waitForToolAccessChange(), "native lifecycle transition");
	await until(() => sessionOf(runtime).getActiveToolNames().includes(name), `native tool ${name} connected`);
}
async function disposeRuntime(runtime: JarvisSideSessionRuntime) {
	runtime.dispose();
	await bounded(runtime.waitForDisposal(), "owned native shutdown dispatch");
}
function textResults(session: AgentSession) {
	return session.messages.filter((message) => message.role === "toolResult").flatMap((message) => message.role === "toolResult" ? message.content.filter((part) => part.type === "text").map((part) => part.text) : []).join("\n");
}
function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function envCommand(marker: string) {
	return `!${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("./fixtures/native-mcp-env-command.mjs", import.meta.url)))} ${shellQuote(marker)}`;
}

// These run sequentially: the SDK's public getAgentDir() uses an environment variable.
// Each fixture owns an isolated workspace/agent directory, a zero-cost host, and every child PID.
test("native MCP is opt-in: off never starts servers or expands env commands, including prompts", { timeout: 20000 }, async () => {
	await fixture(async ({ root, host, server, globalConfig, projectConfig, create }) => {
		const global = server(), project = server("project"), disabled = server("disabled");
		const marker = join(root, "expanded"), projectMarker = join(root, "project-expanded");
		globalConfig({ fixture: global.config({ env: { MCP_FIXTURE_VALUE: envCommand(marker) } }), disabled: disabled.config({ enabled: false, env: { MCP_FIXTURE_VALUE: envCommand(marker) } }) });
		projectConfig({ project: project.config({ env: { MCP_FIXTURE_VALUE: envCommand(projectMarker) } }) });
		let permitted = false;
		const runtime = await create({ toolAccessProvider: () => permitted });
		assert.equal(sessionOf(runtime).getActiveToolNames().some(repoTool), false);
		await host.prompt(runtime, [call(direct, "off"), search(), script(`text(await tools.${code}({value:"off"}));`), { name: "read_mcp_resource", arguments: { server: "fixture", uri: "fixture://note" } }]);
		await bounded(runtime.waitForToolAccessChange(), "off lifecycle settled");
		await delay(75); // Allow any mistakenly queued background spawn/command expansion to become observable.
		assert.deepEqual(global.entries(), []);
		assert.deepEqual(project.entries(), []);
		assert.equal(existsSync(marker), false);
		assert.equal(existsSync(projectMarker), false);
		permitted = true;
		runtime.setToolAccessEnabled(true);
		await connected(runtime);
		await connected(runtime, "mcp__project__direct_echo");
		assert.equal(global.entries().find((entry) => entry.event === "start")?.envValue, "fixture-expanded");
		assert.equal(readFileSync(marker, "utf8"), "expanded\n", "only the opted-in enabled server resolves its env");
		assert.equal(readFileSync(projectMarker, "utf8"), "expanded\n");
		assert.deepEqual(disabled.entries(), [], "native enabled:false remains honored");
		await host.prompt(runtime, [call(direct, "on")]);
		assert.deepEqual(global.calls().map((entry) => entry.value), ["on"]);
		await disposeRuntime(runtime);
		await global.stopped(); await project.stopped();
	});
});

test("explicit re-enable recovers a failed native startup without replaying it automatically", { timeout: 20000 }, async () => {
	await fixture(async ({ create }) => {
		let permitted = false, fail = true, attempts = 0;
		const runtime = await create({ toolAccessProvider: () => permitted, nativeMcpOptions: {
			loadConfig: () => {
				attempts++;
				if (fail) throw new Error("fixture MCP configuration failure");
				return { servers: [], errors: [] };
			},
		} });
		assert.equal(attempts, 0);
		permitted = true;
		runtime.setToolAccessEnabled(true);
		await assert.rejects(runtime.waitForToolAccessChange(), /fixture MCP configuration failure/);
		assert.equal(attempts, 1);
		fail = false;
		permitted = false;
		runtime.setToolAccessEnabled(false);
		await runtime.waitForToolAccessChange();
		assert.equal(attempts, 1, "disable cannot retry failed configuration");
		permitted = true;
		runtime.setToolAccessEnabled(true);
		await runtime.waitForToolAccessChange();
		assert.equal(attempts, 2);
		await disposeRuntime(runtime);
		runtime.setToolAccessEnabled(true);
		assert.equal(runtime.getRepoToolsDetailLabel(), "repo tools off");
		assert.equal(attempts, 2);
	});
});

test("native MCP project trust ignores project configs/commands while allowing opted-in global servers", { timeout: 20000 }, async () => {
	await fixture(async ({ root, host, server, globalConfig, projectConfig, create }) => {
		const global = server("global"), replacement = server("replacement"), project = server("project");
		const marker = join(root, "untrusted-env-expansion");
		globalConfig({ fixture: global.config() });
		projectConfig({ fixture: replacement.config({ env: { MCP_FIXTURE_VALUE: envCommand(marker) } }), project: project.config() });
		const untrusted = await create({ projectTrusted: false, toolAccessProvider: () => true });
		await connected(untrusted);
		assert.equal(sessionOf(untrusted).settingsManager.isProjectTrusted(), false);
		await host.prompt(untrusted, [call(direct, "global-allowed")]);
		assert.equal(global.calls().length, 1);
		assert.deepEqual(replacement.entries(), []);
		assert.deepEqual(project.entries(), []);
		assert.equal(existsSync(marker), false);
		await disposeRuntime(untrusted); await global.stopped();
		const trusted = await create({ projectTrusted: true, toolAccessProvider: () => true });
		await connected(trusted); await connected(trusted, "mcp__project__direct_echo");
		await host.prompt(trusted, [call(direct, "project-override")]);
		assert.deepEqual(replacement.calls().map((entry) => entry.value), ["project-override"]);
		assert.equal(global.entries().filter((entry) => entry.event === "start").length, 1, "trusted same-name project entry replaces, not duplicates, global server");
		assert.equal(existsSync(marker), true);
		await disposeRuntime(trusted); await replacement.stopped(); await project.stopped();
	});
});

test("real native factory tools support direct/deferred/codemode/resources and SDK nested call pipeline", { timeout: 20000 }, async () => {
	await fixture(async ({ host, server, globalConfig, create }) => {
		const local = server(); globalConfig({ fixture: local.config() });
		const runtime = await create({ toolAccessProvider: () => true, systemPromptProvider: () => 'You are Main.\n<mcp_servers>\n- mcp__phantom (deferred): inherited main-only server\n</mcp_servers>' });
		await connected(runtime);
		const session = sessionOf(runtime);
		await host.prompt(runtime);
		const prompt = JSON.stringify(host.contexts.at(-1));
		assert.doesNotMatch(prompt, /mcp__phantom|inherited main-only server/, "main MCP discovery is not authoritative in the side prompt");
		assert.match(prompt, /mcp__fixture/, "native side MCP discovery section reaches the actual host request");
		assert.ok(host.declared().includes(direct));
		assert.ok(!host.declared().includes(deferred));
		assert.ok(!host.declared().includes(code));
		assert.ok(!host.declared().includes(hidden));
		assert.equal(session.getAllTools().find((tool) => tool.name === direct)?.annotations?.readOnlyHint, true);
		assert.equal(session.getAllTools().find((tool) => tool.name === direct)?.annotations?.destructiveHint, false);
		assert.equal(session.getAllTools().find((tool) => tool.name === destructive)?.annotations?.destructiveHint, true);
		const nested: { name: string; parent?: string }[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.parentToolCallId) nested.push({ name: event.toolName, parent: event.parentToolCallId });
		});
		try {
			await host.prompt(runtime, [call(direct, "direct"), call(destructive, "destructive")], [search()], [call(deferred, "deferred")], [script(`const matches = await searchTools("code_echo", {namespace:"mcp__fixture"}); text(matches); text(await tools.${code}({value:"script"}));`, "native-script")],
				[{ name: "list_mcp_resources", arguments: { server: "fixture" } }, { name: "list_mcp_resource_templates", arguments: { server: "fixture" } }, { name: "read_mcp_resource", arguments: { server: "fixture", uri: "fixture://note" } }],
				[script('text(await tools.read_mcp_resource({server:"fixture",uri:"fixture://note"}));', "resource-script")]);
		} finally { unsubscribe(); }
		assert.ok(session.getActiveToolNames().includes(deferred), "native tool_search loads a real deferred tool");
		assert.equal(session.messages.some((message) => message.role === "toolResult" && message.isError), false, textResults(session));
		assert.deepEqual(local.calls().map((entry) => [entry.name, entry.value]), [["direct_echo", "direct"], ["destructive_echo", "destructive"], ["deferred_echo", "deferred"], ["code_echo", "script"]]);
		assert.ok(nested.some((entry) => entry.name === code && entry.parent === "native-script"), "codemode uses public SDK nested execution with parent ID");
		assert.ok(nested.some((entry) => entry.name === "read_mcp_resource" && entry.parent === "resource-script"));
		await host.prompt(runtime, [script('text("models capability=" + typeof models);')]);
		const results = textResults(session);
		assert.match(results, /models capability=undefined/, "codemode cannot dispatch model helpers or incur provider billing");
		assert.match(results, /fixture:direct_echo:direct/);
		assert.match(results, /fixture:deferred_echo:deferred/);
		assert.match(results, /fixture:code_echo:script/);
		assert.match(results, /fixture-note/);
		assert.match(results, /fixture-template/);
		assert.match(results, /local fixture resource body/);
		assert.equal(session.messages.some((message) => message.role === "toolResult" && message.isError), false);
		await host.prompt(runtime, [call(hidden, "must-not-run")]);
		assert.equal(local.calls().some((entry) => entry.name === "hidden_echo"), false);
		await disposeRuntime(runtime); await local.stopped();
	});
});

test("live permissions gate prepared native/discovery/resource executions; annotations never grant access", { timeout: 20000 }, async () => {
	await fixture(async ({ host, server, globalConfig, create }) => {
		const local = server(); globalConfig({ fixture: local.config() });
		let permitted = true;
		const runtime = await create({ toolAccessProvider: () => permitted }); await connected(runtime);
		const session = sessionOf(runtime);
		await host.prompt(runtime, [search()]);
		const attempts = [call(direct, "read-only-denied"), call(destructive, "destructive-denied"), call(deferred, "loaded-denied"), call(code, "indirect-denied"), search(), script(`text(await tools.${code}({value:"nested-denied"}));`),
			{ name: "list_mcp_resources", arguments: { server: "fixture" } }, { name: "list_mcp_resource_templates", arguments: { server: "fixture" } }, { name: "read_mcp_resource", arguments: { server: "fixture", uri: "fixture://note" } }];
		const prepared = attempts.map((attempt) => ({ attempt, definition: session.getToolDefinition(attempt.name)! }));
		assert.ok(prepared.every((entry) => entry.definition), "probe actual native factory definitions before revocation");
		const ctx = session.extensionRunner.createContext() as ExtensionToolContext;
		const before = local.entries().length;
		permitted = false; // Host generation/access can expire without UI setter or preflight.
		for (const { attempt, definition } of prepared) await assert.rejects(
			bounded(Promise.resolve().then(() => definition.execute("prepared-before-revoke", attempt.arguments, undefined, undefined, ctx)), `blocked ${attempt.name}`),
			/disabled|cancelled|stale|revoked|not allowed/i,
		);
		assert.equal(local.entries().length, before, "prepared calls never contact the server or resolve credentials");
		assert.equal((await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: code, toolCallId: "parent/1", parentToolCallId: "parent", input: { value: "denied" } }))?.block, true);
		runtime.setToolAccessEnabled(false);
		await bounded(runtime.waitForToolAccessChange(), "native disable transition");
		await local.stopped();
		assert.equal(session.getActiveToolNames().some(repoTool), false);
		// Even adversarial activation of old exposures cannot bypass the execute/event gate.
		session.setActiveToolsByName(["tool_search", "codemode", direct, deferred, "read_mcp_resource"]);
		await host.prompt(runtime, [search(), script(`text(await tools.${code}({value:"exposure-bypass"}));`), call(direct, "exposure-bypass"), call(deferred, "exposure-bypass"), { name: "read_mcp_resource", arguments: { server: "fixture", uri: "fixture://note" } }]);
		assert.equal(local.calls().length, 0);
		assert.equal(local.entries().filter((entry) => entry.event === "start").length, 1);
		await disposeRuntime(runtime);
	});
});

test("disabling mid-batch revokes issued native calls; re-enable has fresh generation and close stops side-owned processes", { timeout: 20000 }, async () => {
	await fixture(async ({ host, bridge, server, globalConfig, create }) => {
		const local = server(); globalConfig({ fixture: local.config() });
		let permitted = true, renders = 0;
		bridge.attach(() => { renders++; });
		const runtime = await create({ toolAccessProvider: () => permitted }); await connected(runtime);
		const session = sessionOf(runtime);
		const oldRefs = [call(direct, "stale"), call(code, "stale"), call(destructive, "stale"), search(), script(`text(await tools.${code}({value:"stale"}));`), { name: "read_mcp_resource", arguments: { server: "fixture", uri: "fixture://note" } }]
			.map((attempt) => ({ attempt, definition: session.getToolDefinition(attempt.name)! }));
		assert.ok(oldRefs.every((entry) => entry.definition));
		const ctx = session.extensionRunner.createContext() as ExtensionToolContext;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolCallId === "revoke-after-first") {
				permitted = false; runtime.setToolAccessEnabled(false);
			}
		});
		try { await host.prompt(runtime, [call(direct, "first", "revoke-after-first"), { name: "read", arguments: { path: "unused-fixture-path" } }, call(destructive, "never-destructive", "second"), script(`text(await tools.${code}({value:"never-nested"}));`, "third"), search()]); }
		finally { unsubscribe(); }
		assert.deepEqual(local.calls().map((entry) => entry.value), ["first"]);
		assert.ok(session.messages.some((message) => message.role === "toolResult" && message.toolCallId === "second" && message.isError));
		await local.stopped();
		permitted = true; runtime.setToolAccessEnabled(true);
		await connected(runtime);
		await until(() => local.entries().filter((entry) => entry.event === "start").length === 2, "fresh MCP generation");
		for (const { attempt, definition } of oldRefs) await assert.rejects(
			Promise.resolve().then(() => definition.execute("old-generation", attempt.arguments, undefined, undefined, ctx)),
			/disabled|cancelled|stale|revoked|expired|not allowed/i,
		);
		await host.prompt(runtime, [call(direct, "fresh")], [script(`text(await tools.${code}({value:"fresh-script"}));`)]);
		assert.match(textResults(session), /fixture:code_echo:fresh-script/, textResults(session));
		assert.deepEqual(local.calls().map((entry) => entry.value), ["first", "fresh", "fresh-script"]);
		const fresh = session.getToolDefinition(direct)!;
		await disposeRuntime(runtime); await local.stopped();
		runtime.dispose(); // Idempotent.
		runtime.setToolAccessEnabled(true); // Lifetime revocation is irreversible.
		await assert.rejects(Promise.resolve().then(() => fresh.execute("disposed", { value: "disposed" }, undefined, undefined, ctx)), /disabled|cancelled|stale|revoked|not allowed/i);
		await delay(50);
		assert.equal(local.entries().filter((entry) => entry.event === "start").length, 2);
		const before = renders; bridge.notify("shared overlay remains subscribed"); assert.ok(renders > before);
	});
});

test("caller AbortSignal prevents an old codemode script continuing into a re-enabled permission epoch", { timeout: 20000 }, async () => {
	await fixture(async ({ host, server, globalConfig, create }) => {
		const local = server(); globalConfig({ fixture: local.config() });
		const runtime = await create({ toolAccessProvider: () => true }); await connected(runtime);
		const session = sessionOf(runtime);
		// A genuine assistant-issued parent is required by Pi's nested pipeline. Capture
		// its public caller signal, then cancel via public session.abort(), not a fake ctx.
		let callerSignal: AbortSignal | undefined;
		const unsubscribe = session.agent.subscribe((event, signal) => {
			if (event.type === "tool_execution_start" && event.toolCallId === "old-caller-script") callerSignal = signal;
		});
		const pending = host.prompt(runtime, [script(`try { await tools.${direct}({value:"held"}); } catch {}\ntext(await tools.${code}({value:"aborted-script-bypass"}));`, "old-caller-script")])
			.then(() => undefined, (error: unknown) => error);
		try {
			await until(() => local.entries().some((entry) => entry.event === "call-start" && entry.value === "held"), "old script started a real nested MCP call");
			assert.ok(callerSignal);
			const aborted = session.abort();
			await until(() => callerSignal?.aborted === true, "public caller signal aborted");
			runtime.setToolAccessEnabled(false); await bounded(runtime.waitForToolAccessChange(), "native disable transition"); await local.stopped();
			runtime.setToolAccessEnabled(true); await connected(runtime);
			local.unholdCall();
			const error = await bounded(pending, "caller-cancelled script");
			if (error) assert.match(String(error), /disabled|cancelled|stale|revoked|abort/i);
			await bounded(aborted, "SDK caller abort settled");
			assert.ok(session.messages.some((message) => message.role === "toolResult" && message.toolCallId === "old-caller-script" && message.isError));
		} finally { unsubscribe(); local.unholdCall(); await pending; }
		await host.prompt(runtime, [call(direct, "fresh-after-abort")]);
		assert.equal(local.entries().some((entry) => entry.event === "call-start" && entry.value === "aborted-script-bypass"), false, "old script cannot invoke even a newly re-enabled tool");
		assert.deepEqual(local.calls().map((entry) => entry.value), ["fresh-after-abort"]);
		await disposeRuntime(runtime); await local.stopped();
	});
});

test("late native connection and tools/list_changed refresh actual exposures and withdraw old tools", { timeout: 20000 }, async () => {
	await fixture(async ({ host, server, globalConfig, create }) => {
		const local = server("fixture", true); globalConfig({ fixture: local.config() });
		const runtime = await create({ toolAccessProvider: () => true });
		await local.started();
		const session = sessionOf(runtime);
		assert.equal(session.getActiveToolNames().includes(direct), false, "background server has not completed initialize");
		local.unhold(); await connected(runtime);
		const withdrawn = "mcp__fixture__withdrawn_echo", late = "mcp__fixture__late_echo";
		await host.prompt(runtime, [call(withdrawn, "before-change")]);
		const prepared = session.getToolDefinition(withdrawn)!;
		local.changeTools();
		await connected(runtime, late);
		assert.equal(session.getAllTools().find((tool) => tool.name === withdrawn)?.exposure, "hidden");
		assert.equal(session.getActiveToolNames().includes(withdrawn), false);
		await assert.rejects(prepared.execute("prepared-before-withdrawal", { value: "withdrawn-prepared" }, undefined, undefined,
			session.extensionRunner.createContext() as ExtensionToolContext), /disabled|withdrawn/i);
		await host.prompt(runtime, [call(late, "after-change")], [call(withdrawn, "withdrawn-must-not-run")]);
		assert.deepEqual(local.calls().map((entry) => entry.value), ["before-change", "after-change"]);
		assert.ok(local.entries().some((entry) => entry.event === "tools-listed" && entry.revision === 1));
		await disposeRuntime(runtime); await local.stopped();
	});
});

test("native deferred discovery waits for a late server and codemode reaches indirect resources", { timeout: 20000 }, async () => {
	await fixture(async ({ host, server, globalConfig, create }) => {
		const local = server("fixture", true);
		globalConfig({ fixture: local.config({ exposure: "deferred", toolExposure: { code_echo: "codemode", hidden_echo: "hidden" } }) });
		const runtime = await create({ toolAccessProvider: () => true });
		await local.started();
		const session = sessionOf(runtime);
		let searchStarted = false;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolCallId === "search-while-connecting") searchStarted = true;
		});
		const pending = host.prompt(runtime, [{ name: "tool_search", id: "search-while-connecting", arguments: { query: "direct_echo", limit: 1 } }], [call(direct, "late-deferred")],
			[script('text(await tools.list_mcp_resources({server:"fixture"})); text(await tools.list_mcp_resource_templates({server:"fixture"})); text(await tools.read_mcp_resource({server:"fixture",uri:"fixture://note"}));')]);
		try {
			await until(() => searchStarted, "native tool_search entered while server initializing");
			assert.equal(local.entries().some((entry) => entry.event === "tools-listed"), false);
			assert.equal(session.getActiveToolNames().includes(direct), false);
			local.unhold();
			await bounded(pending, "deferred discovery and indirect resource prompt");
		} finally { local.unhold(); unsubscribe(); await pending.catch(() => {}); }
		assert.deepEqual(local.calls().map((entry) => entry.value), ["late-deferred"]);
		assert.equal(session.getAllTools().find((tool) => tool.name === "read_mcp_resource")?.exposure, "deferred");
		assert.equal(session.getActiveToolNames().includes("read_mcp_resource"), false, "resources remain indirect, yet codemode can reach them");
		assert.equal(session.messages.some((message) => message.role === "toolResult" && message.isError), false, textResults(session));
		assert.match(textResults(session), /local fixture resource body/);
		await disposeRuntime(runtime); await local.stopped();
	});
});

for (const dispose of [false, true]) test(`revocation during native initialization rejects late registration and cleans the connection (${dispose ? "dispose" : "off"})`, { timeout: 20000 }, async () => {
	await fixture(async ({ host, server, globalConfig, create }) => {
		const local = server("fixture", true); globalConfig({ fixture: local.config() });
		let permitted = true;
		const runtime = await create({ toolAccessProvider: () => permitted });
		const session = sessionOf(runtime);
		await local.started();
		permitted = false;
		if (dispose) runtime.dispose(); else runtime.setToolAccessEnabled(false);
		// Native Pi 1.0 cannot synchronously kill client.connect() before assigning its client.
		// Releasing the deterministic handshake tests eventual cleanup, not an invented guarantee.
		local.unhold(); await local.stopped();
		assert.equal(local.calls().length, 0);
		if (!dispose) {
			assert.equal(session.getActiveToolNames().some(repoTool), false);
			await host.prompt(runtime, [call(direct, "late-bypass"), search(), script(`text(await tools.${code}({value:"late-bypass"}));`)]);
			assert.equal(local.calls().length, 0);
			permitted = true; runtime.setToolAccessEnabled(true); await connected(runtime);
			await host.prompt(runtime, [call(direct, "current-generation")]);
			assert.deepEqual(local.calls().map((entry) => entry.value), ["current-generation"]);
			await disposeRuntime(runtime); await local.stopped();
		} else assert.equal(runtime.isReady(), false);
	});
});

test("stale side initialization cannot return ready or leak native child after disposal", { timeout: 20000 }, async () => {
	await fixture(async ({ bridge, server, globalConfig, create }) => {
		const local = server(); globalConfig({ fixture: local.config() });
		// Own runtime probe plus public SDK lifecycle method, consistent with side-runtime tests.
		const prototype = JarvisSideSessionRuntime.prototype as unknown as { initialize(options: CreateOptions): Promise<void> };
		const originalInitialize = prototype.initialize, originalBind = AgentSession.prototype.bindExtensions;
		let captured: JarvisSideSessionRuntime | undefined, release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		prototype.initialize = function (options) { captured = this as unknown as JarvisSideSessionRuntime; return originalInitialize.call(this, options); };
		AgentSession.prototype.bindExtensions = async function (options) { await originalBind.call(this, options); await barrier; };
		let pending: Promise<JarvisSideSessionRuntime> | undefined;
		try {
			pending = create({ toolAccessProvider: () => true });
			const rejected = assert.rejects(pending, /disposed|stale|cancelled|initializ|lifetime/i);
			await local.started();
			assert.ok(captured);
			captured.dispose(); release();
			await bounded(rejected, "stale side creation rejection");
			assert.equal(captured.isReady(), false);
			await local.stopped();
			const before = bridge.snapshot(); bridge.notify("bridge survives stale boot"); assert.notDeepEqual(bridge.snapshot(), before);
		} finally {
			release();
			prototype.initialize = originalInitialize; AgentSession.prototype.bindExtensions = originalBind;
			if (pending) await pending.catch(() => {});
		}
	});
});
