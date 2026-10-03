// A dependency-free, local-only MCP stdio peer. stdout is exclusively JSON-RPC.
// The test controls initialization/list changes via temp files, never network/auth.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [ledger, control, release, callRelease] = process.argv.slice(2);
const record = (event, details = {}) => appendFileSync(ledger, `${JSON.stringify({ event, pid: process.pid, ...details })}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
let revision = 0;
let initialized = false;
let stopping = false;
const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const tool = (name, readOnlyHint = true) => ({
	name, description: `${name} deterministic fixture operation`, inputSchema: schema,
	annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: false, openWorldHint: false },
});
const tools = () => [tool("direct_echo"), tool("deferred_echo"), tool("code_echo"), tool("destructive_echo", false), tool("hidden_echo"), tool(revision === 0 ? "withdrawn_echo" : "late_echo")];
const stop = (reason) => {
	if (stopping) return;
	stopping = true;
	record("stop", { reason });
	clearInterval(watcher);
	process.exit(0);
};
const watcher = setInterval(() => {
	if (!initialized || !existsSync(control)) return;
	const next = Number(readFileSync(control, "utf8"));
	if (next === revision) return;
	revision = next;
	record("list-change", { revision });
	send({ method: "notifications/tools/list_changed" });
}, 10);
record("start", { envValue: process.env.MCP_FIXTURE_VALUE });
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
const input = createInterface({ input: process.stdin });
input.on("close", () => stop("stdin"));
input.on("line", async (line) => {
	let request;
	try { request = JSON.parse(line); } catch { return; }
	const { id, method, params = {} } = request;
	record("request", { method });
	if (method === "initialize") {
		while (release && !existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
		record("initialized");
		reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: { listChanged: false } }, serverInfo: { name: "pi-jarvis-local-fixture", version: "1.0.0" }, instructions: "Deterministic fixture, no credentials or network." });
	} else if (method === "notifications/initialized") {
		initialized = true;
	} else if (method === "tools/list") {
		record("tools-listed", { revision });
		reply(id, { tools: tools() });
	} else if (method === "tools/call") {
		if (!tools().some((item) => item.name === params.name)) {
			send({ id, error: { code: -32602, message: "Fixture tool withdrawn" } });
			return;
		}
		record("call-start", { name: params.name, value: params.arguments?.value });
		while (params.arguments?.value === "held" && !existsSync(callRelease)) await new Promise((resolve) => setTimeout(resolve, 10));
		// Even readOnlyHint:true operations leave an audit trace: hints do not grant access.
		record("call", { name: params.name, value: params.arguments?.value });
		const text = `fixture:${params.name}:${params.arguments?.value}`;
		reply(id, { content: [{ type: "text", text }], structuredContent: { text } });
	} else if (method === "resources/list") {
		record("resources-listed");
		reply(id, { resources: [{ uri: "fixture://note", name: "fixture-note", mimeType: "text/plain" }] });
	} else if (method === "resources/templates/list") {
		record("templates-listed");
		reply(id, { resourceTemplates: [{ uriTemplate: "fixture://note/{id}", name: "fixture-template", mimeType: "text/plain" }] });
	} else if (method === "resources/read") {
		record("resource-read", { uri: params.uri });
		reply(id, { contents: [{ uri: params.uri, mimeType: "text/plain", text: "local fixture resource body" }] });
	} else if (method === "ping") reply(id, {});
	else if (id !== undefined) send({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } });
});
