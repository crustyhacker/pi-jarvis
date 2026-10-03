import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	type ExtensionFactory,
	type McpExtensionOptions,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type NativeMcpOptions = {
	hasToolAccess: () => boolean;
	lifetimeSignal?: AbortSignal;
	/** Public native options, primarily useful for isolated SDK fixtures. */
	mcpOptions?: McpExtensionOptions;
	onChange?: () => void;
};

type NativeHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown | Promise<unknown>;
type Generation = {
	abort: AbortController;
	definitions: Map<string, ToolDefinition>;
	unsubscribers: Set<() => void>;
	starts: Set<NativeHandler>;
	shutdowns: Set<NativeHandler>;
};

/** Remove the MAIN session's discovery section before composing the side prompt. */
export function stripMcpServerSection(prompt: string): string {
	return prompt.replace(/<mcp_servers>\s*[\s\S]*?<\/mcp_servers>/gi, "").trim();
}

/**
 * Own the public factories' registrations, not the host's MCP servers/runtime.
 * Pi 1.0's factories have no lifecycle handle, and AgentSession.dispose() does
 * not emit session_shutdown. Retain their public lifecycle callbacks so the
 * owner can start only on opt-in and request shutdown before SDK invalidation.
 *
 * Revocation blocks NEW executions/lifecycle entry, hides definitions, cancels
 * scripts/call signals, and invalidates prepared references across re-enable.
 * Native shutdown is best-effort for ALREADY STARTED work: an in-flight MCP
 * handshake or OAuth refresh/cleanup can finish or time out (and have effects)
 * after revocation. The public factories cannot cancel those internals. This is
 * permission control, NOT a sandbox or a promise to undo running operations.
 */
export class NativeMcpController {
	private pi?: ExtensionAPI;
	private start?: { event: SessionStartEvent; ctx: ExtensionContext };
	private current?: Generation;
	private readonly ownedNames = new Set<string>();
	private enabled = false;
	private disposed = false;
	private revision = 0;
	private transition: Promise<void> = Promise.resolve();
	private readonly onLifetimeAbort = () => { void this.dispose().catch(() => {}); };

	constructor(private readonly options: NativeMcpOptions) {
		options.lifetimeSignal?.addEventListener("abort", this.onLifetimeAbort, { once: true });
	}

	readonly extensionFactory: ExtensionFactory = (pi) => {
		this.pi = pi;
		pi.on("session_start", async (event, ctx) => {
			this.start = { event, ctx }; // Genuine SIDE event/context from bindExtensions().
			await this.setEnabled(this.options.hasToolAccess());
		});
		pi.on("session_shutdown", async (event) => {
			await this.dispose(event);
		});
	};

	ownsTool(name: string): boolean {
		return this.ownedNames.has(name);
	}

	isToolAvailable(name: string): boolean {
		const generation = this.current;
		const definition = generation?.definitions.get(name);
		return !!generation && this.isLive(generation) && !!definition && definition.exposure !== "hidden";
	}

	/** Preserve direct tools, native discovery activation, and tool_search loads. */
	getActiveToolNames(): string[] {
		return this.pi?.getActiveTools().filter((name) => this.isToolAvailable(name)) ?? [];
	}

	setEnabled(enabled: boolean): Promise<void> {
		if (this.disposed) return this.transition;
		this.enabled = enabled;
		const revision = ++this.revision;
		// Revoke synchronously, even when a previous enable is still queued.
		const closing = enabled && this.options.hasToolAccess() ? Promise.resolve() : this.revoke({ type: "session_shutdown", reason: "reload" });
		this.transition = Promise.all([this.transition.catch(() => {}), closing]).then(async () => {
			if (revision !== this.revision || !this.enabled || this.disposed || !this.start || !this.pi || !this.options.hasToolAccess() || this.options.lifetimeSignal?.aborted) return;
			if (this.current) return;
			const generation: Generation = {
				abort: new AbortController(), definitions: new Map(), unsubscribers: new Set(), starts: new Set(), shutdowns: new Set(),
			};
			this.current = generation;
			const facade = this.createFacade(this.pi, generation);
			try {
				// No factories, config reads, credential expansion, or connections while off.
				for (const factory of [
					createCodemodeExtension({ mode: "on", models: false }),
					createToolSearchExtension(),
					createMcpExtension(this.options.mcpOptions),
				]) {
					if (!this.isLive(generation)) return;
					await factory(facade);
				}
				for (const handler of generation.starts) {
					if (!this.isLive(generation)) return;
					await handler(this.start.event, this.start.ctx);
				}
				this.options.onChange?.();
			} catch (error) {
				await this.revoke({ type: "session_shutdown", reason: "reload" });
				throw error;
			}
		});
		return this.transition;
	}

	waitForChange(): Promise<void> {
		return this.transition;
	}

	dispose(event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" }): Promise<void> {
		if (this.disposed) return this.transition;
		this.disposed = true;
		this.enabled = false;
		this.revision++;
		this.options.lifetimeSignal?.removeEventListener("abort", this.onLifetimeAbort);
		const closing = this.revoke(event);
		this.transition = Promise.allSettled([this.transition, closing]).then((results) => {
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		});
		return this.transition;
	}

	private isLive(generation: Generation): boolean {
		return this.current === generation && this.enabled && !this.disposed && !generation.abort.signal.aborted && !this.options.lifetimeSignal?.aborted && this.options.hasToolAccess();
	}

	private assertLive(generation: Generation, signal?: AbortSignal): void {
		if (!this.isLive(generation) || signal?.aborted) throw new Error("/jarvis native MCP access is disabled, cancelled, or belongs to an expired permission generation.");
	}

	private revoke(event: SessionShutdownEvent): Promise<void> {
		const generation = this.current;
		this.current = undefined;
		if (!generation) return Promise.resolve();
		generation.abort.abort();
		const errors: unknown[] = [];
		const attempt = (action: () => void) => { try { action(); } catch (error) { errors.push(error); } };
		for (const unsubscribe of generation.unsubscribers) attempt(unsubscribe);
		generation.unsubscribers.clear();
		// Native shutdown itself does not withdraw definitions. Do so before any
		// awaited work; late registration through this old facade is discarded.
		for (const definition of generation.definitions.values()) {
			attempt(() => { this.pi?.registerTool({ ...definition, exposure: "hidden", defaultActive: false }); });
		}
		attempt(() => { this.pi?.setActiveTools(this.pi.getActiveTools().filter((name) => !this.ownedNames.has(name))); });
		attempt(() => { this.options.onChange?.(); });
		const start = this.start;
		// Invoke immediately: native shutdown bumps its own startup generation
		// synchronously before yielding to connection.close(). No fake main events.
		// A stale SDK facade or failed overlay render must not prevent closing.
		return Promise.allSettled([...generation.shutdowns].map(async (handler) => {
			if (start) await handler(event, start.ctx);
		})).then((results) => {
			for (const result of results) if (result.status === "rejected") errors.push(result.reason);
			if (errors.length > 0) throw new AggregateError(errors, "/jarvis native MCP shutdown encountered errors.");
		});
	}

	private createFacade(pi: ExtensionAPI, generation: Generation): ExtensionAPI {
		const on = ((name: ExtensionEvent["type"], handler: NativeHandler): (() => void) => {
			if (name === "session_start" || name === "session_shutdown") {
				const handlers = name === "session_start" ? generation.starts : generation.shutdowns;
				handlers.add(handler);
				return () => { handlers.delete(handler); };
			}
			// `on` is overloaded by event. Only the public factories' registrations
			// cross this adapter; keep each event/result unchanged except prompt composition.
			const register = pi.on as (name: ExtensionEvent["type"], handler: NativeHandler) => () => void;
			const unsubscribe = register(name, async (event, ctx) => {
				if (!this.isLive(generation)) {
					if (event.type === "tool_call" && generation.definitions.has(event.toolName)) return { block: true, reason: "/jarvis native MCP access is disabled." };
					return;
				}
				const result = await handler(event, ctx);
				if (!this.isLive(generation)) {
					if (event.type === "tool_call" && generation.definitions.has(event.toolName)) return { block: true, reason: "/jarvis native MCP permission expired while preparing the call." };
					return;
				}
				if (event.type === "before_agent_start") {
					const promptEvent = event as BeforeAgentStartEvent;
					const section = promptEvent.systemPromptOptions.sections.mcp_servers;
					// Jarvis uses a forced identity/context prompt. Native structured
					// sections alone would be lost; append ONLY the SIDE discovery list.
					return { systemPrompt: [stripMcpServerSection(promptEvent.systemPrompt), section ? `<mcp_servers>\n${section}\n</mcp_servers>` : ""].filter(Boolean).join("\n\n") };
				}
				return result;
			});
			generation.unsubscribers.add(unsubscribe);
			return () => { generation.unsubscribers.delete(unsubscribe); unsubscribe(); };
		}) as ExtensionAPI["on"];

		return new Proxy(pi, {
			get: (target, property) => {
				if (property === "on") return on;
				if (property === "registerCommand") return () => {};
				if (property === "registerTool") return (definition: ToolDefinition) => {
					if (!this.isLive(generation)) return;
					const wrapped = this.wrapTool(definition, generation);
					generation.definitions.set(definition.name, wrapped);
					this.ownedNames.add(definition.name);
					target.registerTool(wrapped);
					this.options.onChange?.();
				};
				if (property === "setActiveTools") return (names: string[]) => {
					if (!this.isLive(generation)) return;
					target.setActiveTools(names.filter((name) => !this.ownedNames.has(name) || this.isToolAvailable(name)));
					this.options.onChange?.();
				};
				if (property === "appendEntry") return (...args: Parameters<ExtensionAPI["appendEntry"]>) => {
					this.assertLive(generation);
					return target.appendEntry(...args);
				};
				// Deliberately omit side /mcp administration. Config/auth discovery,
				// refresh, expansion, and transports stay on Pi's native defaults;
				// manage login/exposure/enabled settings in the MAIN Pi /mcp UI.
				return Reflect.get(target, property);
			},
		});
	}

	private wrapTool(definition: ToolDefinition, generation: Generation): ToolDefinition {
		return {
			...definition,
			// Serialize model-issued side batches just like local side tools. The
			// script's explicit ctx.executeTool concurrency still uses live gates.
			executionMode: "sequential",
			execute: async (id, params, signal, onUpdate, ctx) => {
				this.assertLive(generation, signal);
				// A tools/list_changed withdrawal can happen within the same
				// permission epoch, after an SDK call already captured this definition.
				if (!this.isToolAvailable(definition.name)) throw new Error("/jarvis native MCP tool is disabled or withdrawn.");
				const signals = [generation.abort.signal, signal, this.options.lifetimeSignal].filter((value): value is AbortSignal => !!value);
				const callSignal = AbortSignal.any(signals);
				// An OLD codemode script must not call tools from a NEW permission
				// generation, even if a nested call was queued while access was on.
				// SDK tool contexts are frozen. Shadow public members on a fresh
				// facade instead of violating frozen-property Proxy invariants.
				const context: typeof ctx = Object.create(ctx);
				Object.defineProperties(context, {
					signal: { value: callSignal },
					executeTool: { value: (name: string, args: Record<string, unknown>, options?: Parameters<typeof ctx.executeTool>[2]) => {
						this.assertLive(generation, callSignal);
						return ctx.executeTool(name, args, { ...options, signal: options?.signal ? AbortSignal.any([callSignal, options.signal]) : callSignal });
					} },
				});
				const result = await definition.execute(id, params, callSignal, onUpdate, context);
				this.assertLive(generation, callSignal);
				return result;
			},
		};
	}
}
