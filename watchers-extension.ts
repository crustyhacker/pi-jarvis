import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveWatcherPolicy, saveWatcherPolicy } from "./watchers-config.js";
import { decodeCheckResult } from "./watchers-check.js";
import { WatcherService } from "./watchers-service.js";
import { watcherConditionWords, watcherSetRenderers } from "./watchers-render.js";
import { WATCHER_DEFAULTS, WATCHER_MESSAGE_TYPE, WATCHER_STATE_TYPE, type WatcherClock, type WatcherPolicy, type WatcherRecord, type WatcherScope } from "./watchers-types.js";

export const WATCHER_SET_DESCRIPTION = "Set a bounded watcher for this main Pi session, then finish your turn instead of polling. Write a nonempty label and a nonempty one- or two-sentence note explaining the wait and your intended next action. Prefer file_lines or path_quiet when they express the condition accurately. command must be a short foreground predicate: exit 0 means met, exit 1 means not yet, and other exits or execution failures end the watcher as check failed. Do not start background work, wait interactively, or choose a condition that cannot become true. A missing file_lines target is not yet; path_quiet requires an existing readable path and detects observed metadata quiet, not success. The full immutable supervised command is available through Pi's normal tool expansion (Ctrl+O); the first check uses Pi's bash tool hooks during this call. Denial refuses the watcher. Later bounded repeats run locally through pi.exec with the exact same command and cwd, WITHOUT bash hooks, custom backends, prefixes, or session environment. This is launch-time permission for bounded repetition, not a sandbox or new approval. Requests outside configured limits are refused. Interrupted watchers are reported, never automatically restarted.";
export const WATCHER_LIST_DESCRIPTION = "List watchers for this main Pi session, including conditions, states, elapsed time, deadlines, saved notes, and pending or uncertain notifications. Listing performs no checks and makes no model calls. A running watcher does not prove that observed work is progressing. Use jarvis_watcher_cancel to stop a watcher; do not poll this tool while waiting.";
export const WATCHER_CANCEL_DESCRIPTION = "Cancel one watcher by exact ID in this main Pi session. Stop future checks, abort an active check, and discard a notification not yet handed to Pi. Cancellation does not undo command effects or retract a notification already queued or delivered. Cancelling an already cancelled watcher is harmless. This tool does not change watcher settings or stop the work being observed.";

export interface WatcherExtensionOptions { available(): boolean; clock?: WatcherClock; notify?: (text: string, level: "info" | "warning", ctx: ExtensionContext) => void; }
export function createWatcherExtension(pi: ExtensionAPI, agentDir: string, options: WatcherExtensionOptions) {
	let ctx: ExtensionContext | undefined, active = false, generation = 0, signature = "";
	const launches = new Map<string, { command: string; timeout: number; observed: boolean; unchanged: boolean }>();
	const trusted = () => { try { return ctx?.isProjectTrusted() === true; } catch { return false; } };
	const policy = (): WatcherPolicy => {
		try { return active && ctx ? resolveWatcherPolicy(ctx.cwd, agentDir, trusted()).policy : { ...WATCHER_DEFAULTS }; }
		catch { return { ...WATCHER_DEFAULTS }; } // Retired/throwing contexts are denial.
	};
	const available = () => { try { return active && !!ctx && options.available(); } catch { return false; } };
	const feedback = (text: string, level: "info" | "warning" = "info") => {
		if (!ctx) return;
		if (options.notify) options.notify(text, level, ctx);
		else { try { if (ctx.hasUI) { ctx.ui.notify(text, level); return; } } catch { /* Retired UI. */ } process.stderr.write(`[pi-jarvis] ${text}\n`); }
	};
	const service = new WatcherService({
		policy, available, clock: options.clock,
		persist(records) { if (!active || !ctx) return; pi.appendEntry(WATCHER_STATE_TYPE, { version: 1, records }); },
		deliver(content, details) { if (!available()) throw new Error("Watcher owner unavailable."); pi.sendMessage({ customType: WATCHER_MESSAGE_TYPE, content, details, display: true }, { triggerTurn: true, deliverAs: "followUp" }); },
		async repeat(record, signal) {
			if (!available() || !policy().enabled || signal.aborted) throw new Error("Watcher repeat was revoked.");
			const result = await pi.exec("/bin/sh", ["-c", record.command], { cwd: record.cwd, signal, timeout: record.checkTimeoutSeconds * 1000 + 2000 });
			if (result.killed || result.code !== 0 || result.stderr.trim()) throw new Error("Watcher supervisor failed.");
			return decodeCheckResult(result.stdout, record.id, record.outputTailChars);
		},
		changed() {
			const rows = service.list(), running = rows.filter(r => r.state === "running" || r.state === "setting").length, pending = rows.filter(r => r.delivery === "pending" || r.delivery === "uncertain").length;
			try { ctx?.ui.setStatus?.("jarvis-watchers", running || pending ? `Watchers ${running} running · ${pending} pending/uncertain · /jarvis-watchers status` : undefined); } catch { /* Presentation only. */ }
			armNotices();
		},
		warn: text => feedback(text, "warning"),
	});
	const textResult = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
	const conditionSchema = Type.Union([
		Type.Object({ kind: Type.Literal("command"), command: Type.String({ minLength: 1, maxLength: 8192 }) }),
		Type.Object({ kind: Type.Literal("file_lines"), path: Type.String({ minLength: 1, maxLength: 4096 }), minLines: Type.Integer({ minimum: 1 }) }),
		Type.Object({ kind: Type.Literal("path_quiet"), path: Type.String({ minLength: 1, maxLength: 4096 }), quietMinutes: Type.Integer({ minimum: 1 }) }),
	]);
	const install = () => {
		const p = policy(), key = `${generation}:${JSON.stringify(p)}`;
		if (key === signature) return; signature = key;
		const installed = generation, installedPolicy = JSON.stringify(p), installedManager = ctx?.sessionManager, installedCwd = ctx?.cwd;
		const check = (context: ExtensionContext, signal?: AbortSignal) => {
			if (!active || !ctx || installed !== generation || installedManager !== context.sessionManager || installedCwd !== context.cwd || ctx.sessionManager.getSessionId() !== context.sessionManager.getSessionId() || !policy().enabled || JSON.stringify(policy()) !== installedPolicy || signal?.aborted || context.signal?.aborted) throw new Error("Watcher tool permission expired, is disabled, or was cancelled; use a fresh tool definition.");
		};
		pi.registerTool({
			name: "jarvis_watcher_set", label: "Set watcher", description: WATCHER_SET_DESCRIPTION,
			exposure: p.enabled ? "model-only" : "hidden", executionMode: "sequential",
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
			parameters: Type.Object({ label: Type.String({ minLength: 1, maxLength: 160 }), note: Type.String({ minLength: 1, maxLength: 2000 }), condition: conditionSchema,
				intervalSeconds: Type.Optional(Type.Integer({ minimum: 1 })), timeoutSeconds: Type.Integer({ minimum: 1 }), checkTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })) }),
			async execute(id, params, signal, onUpdate, context) {
				check(context, signal);
				if (process.platform === "win32") throw new Error("Watchers require a POSIX /bin/sh host in this version.");
				const record = await service.start(params, context.cwd, context.sessionManager.getSessionId(), async (r, operationSignal) => {
					const timeout = r.checkTimeoutSeconds + 2;
					const launch = { command: r.command, timeout, observed: false, unchanged: false };
					launches.set(id, launch);
					try {
						// Keep full bytes in the result and hook arguments. Only the tool
						// renderer's public expanded flag controls transcript presentation.
						await onUpdate?.(textResult(`Watcher: ${r.label}\nCondition: ${JSON.stringify(r.condition)}\nLaunch and all repeats use this exact command in ${r.cwd}:\n${r.command}`, { launchCommand: r.command, watcherDisplay: r }));
						if (!onUpdate && context.hasUI) context.ui.notify(`Watcher: ${r.label}\n${watcherConditionWords(r.condition, r.cwd)}\nEvery ${r.intervalSeconds}s · time limit ${(r.deadline - r.createdAt) / 1000}s\nWorking directory: ${r.cwd}\nFull launch/repeat command: ${r.command.split("\n").length} lines; expand the watcher tool with Ctrl+O to inspect it.`, "info");
						const outcome = await context.executeTool("bash", { command: r.command, timeout }, { signal: operationSignal });
						check(context, operationSignal);
						if (outcome.isError || !launch.observed || !launch.unchanged) throw new Error("Watcher refused: launch was denied, failed, altered by hooks, or could not be verified. No repeats were scheduled.");
						const result = outcome.result.structuredContent as { output?: unknown; exit_code?: unknown } | undefined;
						if (result?.exit_code !== 0 || typeof result.output !== "string") throw new Error("Watcher refused: launch did not return a verifiable supervised result. No repeats were scheduled.");
						return decodeCheckResult(result.output, r.id, r.outputTailChars);
					} finally { launches.delete(id); }
				}, signal);
				return textResult(`Watcher ${record.id}: ${record.state}${record.reason ? ` (${record.reason})` : ""}.\nNote: ${record.note}\nThe immutable launch/repeat command in ${record.cwd}:\n${record.command}\nRepeats are local and skip bash hooks, custom backends, prefixes, and session environment.`, record);
			},
			...watcherSetRenderers,
		});
		pi.registerTool({ name: "jarvis_watcher_list", label: "List watchers", description: WATCHER_LIST_DESCRIPTION, exposure: p.enabled ? "direct" : "hidden", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, parameters: Type.Object({}),
			async execute(_id, _params, signal, _update, context) { check(context, signal); service.refreshPolicy(); return textResult(service.status(), service.list()); } });
		pi.registerTool({ name: "jarvis_watcher_cancel", label: "Cancel watcher", description: WATCHER_CANCEL_DESCRIPTION, exposure: p.enabled ? "direct" : "hidden", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 160 }) }),
			async execute(_id, params, signal, _update, context) { check(context, signal); return textResult(service.cancel(params.id) ? "Watcher cancelled or already ended. A notification already handed to Pi cannot be retracted; command effects are not undone." : "No watcher with that ID in this main session."); } });
	};
	install(); // Hidden declarations only; no timers or settings I/O in the factory.
	pi.on("tool_result", event => {
		if (event.toolName !== "bash" || !event.parentToolCallId) return;
		const launch = launches.get(event.parentToolCallId); if (!launch) return;
		// This is the validated input actually handed to execute(), after tool_call hooks.
		launch.observed = true; launch.unchanged = event.input.command === launch.command && event.input.timeout === launch.timeout;
	});
	const restore = (context: ExtensionContext) => {
		const branch = context.sessionManager.getBranch(), observed = new Set<string>();
		let records: WatcherRecord[] = [];
		for (const entry of branch) {
			if (entry.type === "custom_message" && entry.customType === WATCHER_MESSAGE_TYPE) {
				const details = entry.details as { notificationId?: unknown } | undefined;
				if (typeof details?.notificationId === "string") observed.add(details.notificationId);
			}
			if (entry.type !== "custom" || entry.customType !== WATCHER_STATE_TYPE) continue;
			const data = entry.data as { version?: unknown; records?: unknown };
			if (data?.version !== 1 || !Array.isArray(data.records) || data.records.length > 150) { records = []; continue; }
			// Never execute restored command text. Refuse malformed state rather than silently replay it.
			records = data.records.filter((r: WatcherRecord) => r && r.version === 1 && typeof r.id === "string" && r.id.length <= 160 && typeof r.sessionId === "string" && typeof r.cwd === "string" && typeof r.command === "string" && r.command.length <= 100_000
				&& typeof r.label === "string" && !!r.label.trim() && r.label.length <= 160 && typeof r.note === "string" && !!r.note.trim() && r.note.length <= 2000
				&& Number.isSafeInteger(r.createdAt) && Number.isSafeInteger(r.deadline) && r.deadline > r.createdAt && r.deadline - r.createdAt <= 604_800_000
				&& ["running", "finished", "cancelled"].includes(r.state) && typeof r.output === "string" && r.output.length <= 4000 && typeof r.detail === "string" && r.detail.length <= 2000);
		}
		service.restore(structuredClone(records), context.sessionManager.getSessionId(), observed);
	};
	pi.on("session_start", (_event, context) => { ctx = context; active = true; generation++; install(); restore(context); });
	pi.on("session_tree", (_event, context) => { ctx = context; active = true; generation++; install(); restore(context); });
	const retireBoundary = () => { service.retire(); active = false; generation++; launches.clear(); };
	pi.on("session_before_switch", retireBoundary);
	pi.on("session_before_fork", retireBoundary);
	pi.on("session_before_tree", retireBoundary);
	pi.on("session_shutdown", () => { service.retire(); active = false; generation++; launches.clear(); try { ctx?.ui.setStatus?.("jarvis-watchers", undefined); } catch { /* Retired UI. */ } ctx = undefined; });
	const refresh = (_event: unknown, context: ExtensionContext) => {
		// A refused/cancelled navigation may keep the same host manager. Recover notes,
		// never timers; an actually replaced manager is admitted only by session_start.
		if (!active && ctx && ctx.sessionManager === context.sessionManager) { ctx = context; active = true; install(); restore(context); }
		if (!active) return; ctx = context; install(); service.refreshPolicy();
	};
	pi.on("before_agent_start", (event, context) => {
		refresh(event, context);
		const owned = ["jarvis_watcher_set", "jarvis_watcher_list", "jarvis_watcher_cancel"];
		if (Array.isArray(event.systemPromptOptions.selectedTools)) event.systemPromptOptions.selectedTools = [...event.systemPromptOptions.selectedTools.filter(name => !owned.includes(name)), ...(policy().enabled ? owned : [])];
	});
	pi.on("agent_settled", refresh);
	pi.on("tool_execution_end", refresh);
	// Pending notices held during a private/modal interaction get another chance without model polling.
	let noticeTimer: unknown;
	const setNoticeTimer = options.clock?.setTimer.bind(options.clock) ?? ((callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; });
	const clearNoticeTimer = options.clock?.clearTimer.bind(options.clock) ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	function armNotices() {
		if (!active || !service.list().some(r => r.delivery === "pending")) {
			if (noticeTimer !== undefined) clearNoticeTimer(noticeTimer);
			noticeTimer = undefined; return;
		}
		if (noticeTimer !== undefined) return;
		noticeTimer = setNoticeTimer(() => { noticeTimer = undefined; if (active) { install(); service.refreshPolicy(); armNotices(); } }, 1000);
	}
	pi.on("agent_settled", armNotices);
	pi.on("session_start", armNotices);
	pi.on("session_tree", armNotices);
	pi.on("session_shutdown", () => { if (noticeTimer !== undefined) clearNoticeTimer(noticeTimer); noticeTimer = undefined; });
	const command = async (args: string, context: ExtensionContext) => {
		if (ctx && ctx.sessionManager !== context.sessionManager) { feedback("Watcher command owner changed; use the current main session.", "warning"); return; }
		ctx = context;
		if (!active) { active = true; generation++; install(); restore(context); }
		const words = args.trim().split(/\s+/).filter(Boolean);
		let scope: WatcherScope = "global";
		if (words[0] === "--project" || words[0] === "--global") scope = words.shift()!.slice(2) as WatcherScope;
		const action = words.shift() ?? "status";
		try {
			if (action === "cancel" && words.length === 1) { feedback(service.cancel(words[0]!) ? "Watcher cancelled or already ended; queued notifications and command effects cannot be undone." : "No watcher with that ID."); return; }
			if (["on", "off", "clear"].includes(action) && !words.length) {
				if (!trusted()) throw new Error("Watcher settings require a trusted project.");
				saveWatcherPolicy(context.cwd, agentDir, scope, action === "clear" ? "clear" : { enabled: action === "on" });
			} else if (action === "set" && words.length === 2) {
				if (!trusted() || !Object.hasOwn(WATCHER_DEFAULTS, words[0]!) || words[0] === "enabled" || !/^\d+$/.test(words[1]!)) throw new Error("Use a supported numeric watcher setting in a trusted project.");
				saveWatcherPolicy(context.cwd, agentDir, scope, { [words[0]!]: Number(words[1]) });
			} else if (action !== "status" || words.length) throw new Error("Usage: /jarvis-watchers [--global|--project] status|on|off|clear|set FIELD INTEGER|cancel ID. clear removes settings, never history, and fallback may enable watchers.");
			install(); service.refreshPolicy(); armNotices();
			const resolved = resolveWatcherPolicy(context.cwd, agentDir, trusted());
			feedback(`Watchers ${resolved.policy.enabled ? "ON" : "off"} · ${JSON.stringify(resolved.policy)}\n${resolved.errors.join("\n")}\n${service.status()}`);
		} catch (error) { feedback(error instanceof Error ? error.message : "Watcher command failed.", "warning"); }
	};
	pi.registerCommand("jarvis-watchers", { description: "Local watcher status, cancellation, and scoped controls (off by default)", handler: command });
	return { service, command, status: () => service.status(), hasPendingSetup: () => service.hasPendingSetup() };
}
