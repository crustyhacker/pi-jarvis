import { existsSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { JarvisModelPicker } from "./model-picker.js";
import { buildMainSessionContext, type MainSessionContextPayload } from "./main-context.js";
import { MainSessionTracker } from "./main-session-state.js";
import { attachOverlayBridge, JarvisOverlayBridge, JarvisOverlayComponent, type JarvisDisplayEntry, type JarvisOverlayView } from "./overlay.js";
import { createJarvisSessionRef, readJarvisSessionRef, JARVIS_SESSION_REF_CUSTOM_TYPE, type JarvisSessionRef } from "./session-ref.js";
import {
	MalformedJarvisConfigError,
	clearJarvisModelSelectionSetting,
	clearJarvisThinkingSelectionSetting,
	loadJarvisModelSelectionSetting,
	loadJarvisThinkingSelectionSetting,
	saveJarvisModelSelectionSetting,
	saveJarvisThinkingSelectionSetting,
	type JarvisModelSelectionScope,
	type JarvisThinkingLevel,
	type StoredJarvisModelSelection,
	type StoredJarvisThinkingSelection,
} from "./jarvis-config.js";
import { JarvisSideSessionRuntime, createSideSessionFile } from "./side-session.js";
import { SharedMemoryService } from "./memory-service.js";
import { createMemoryExtensionFactory } from "./memory-extension.js";
import { SharedArchiveService } from "./archive-service.js";
import { createArchiveExtensionFactory } from "./archive-extension.js";

type JarvisModelSelection =
	| { mode: "follow-main" }
	| { mode: "pinned"; model: Model<any> };

type JarvisModelSelectionSource = JarvisModelSelectionScope | "default";
type JarvisThinkingSelectionSource = JarvisModelSelectionScope | "default";

type JarvisThinkingSelection = StoredJarvisThinkingSelection;

type ParsedJarvisModelCommand = {
	request: string;
	scope: JarvisModelSelectionScope;
	clearScope: boolean;
};

type ParsedJarvisThinkingCommand = {
	request: string;
	scope: JarvisModelSelectionScope;
	clearScope: boolean;
};

type ResolvedJarvisModelSelection = {
	selection: JarvisModelSelection;
	source: JarvisModelSelectionSource;
	unavailable?: {
		scope: JarvisModelSelectionScope;
		modelReference: string;
	};
};

type ResolvedJarvisThinkingSelection = {
	selection: JarvisThinkingSelection;
	source: JarvisThinkingSelectionSource;
};

type JarvisSideCommand =
	| { name: "compact"; customInstructions?: string }
	| { name: "new" }
	| { name: "tree"; targetId?: string; summarize: boolean; customInstructions?: string };

type MainState = {
	bridge: JarvisOverlayBridge;
	memory: SharedMemoryService;
	archive: SharedArchiveService;
	mainSession: MainSessionTracker;
	mainContext: MainSessionContextPayload;
	lastJarvisSeenMainContext?: MainSessionContextPayload;
	sessionRef?: JarvisSessionRef;
	runtime?: JarvisSideSessionRuntime;
	bootPromise?: Promise<JarvisSideSessionRuntime>;
	bootGeneration: number;
	flushPromise?: Promise<void>;
	closeOverlay?: () => void;
	overlayOpen?: boolean;
	queuedMessages: string[];
	model?: Model<any>;
	jarvisModelSelection: JarvisModelSelection;
	jarvisModelSelectionSource: JarvisModelSelectionSource;
	jarvisThinkingSelection: JarvisThinkingSelection;
	jarvisThinkingSelectionSource: JarvisThinkingSelectionSource;
	thinkingLevel?: string;
	systemPrompt: string;
	themeProvider: () => ExtensionContext["ui"]["theme"];
	allowSideTools: boolean;
	allowFollowUpToMain: boolean;
	allowSteerToMain: boolean;
};

class StaleJarvisBootError extends Error {
	constructor() {
		super("/jarvis startup was superseded by a newer session lifecycle event.");
		this.name = "StaleJarvisBootError";
	}
}

function isStaleJarvisBootError(error: unknown): error is StaleJarvisBootError {
	return error instanceof StaleJarvisBootError;
}

export default function jarvisExtension(pi: ExtensionAPI): void {
	// Presentation-only memory, keyed by MAIN identity, never by the side tree.
	// Reopening or returning to a session does not replay the intro.
	const introSeenSessions = new Set<string>();
	const mainSession = new MainSessionTracker();
	const state: MainState = {
		bridge: new JarvisOverlayBridge(),
		memory: new SharedMemoryService(getAgentDir()),
		archive: new SharedArchiveService(getAgentDir()),
		mainSession,
		mainContext: buildMainSessionContext(mainSession.snapshot()),
		lastJarvisSeenMainContext: undefined,
		queuedMessages: [],
		jarvisModelSelection: { mode: "follow-main" },
		jarvisModelSelectionSource: "default",
		jarvisThinkingSelection: { mode: "auto" },
		jarvisThinkingSelectionSource: "default",
		systemPrompt: "",
		themeProvider: () => {
			throw new Error("/jarvis theme requested before UI was available.");
		},
		allowSideTools: false,
		allowFollowUpToMain: false,
		allowSteerToMain: false,
		bootGeneration: 0,
	};

	pi.registerCommand("jarvis", {
		description: "Open the /jarvis side conversation overlay",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/jarvis requires Pi's interactive terminal UI.", "warning");
				return;
			}
			const archiveRequest = parseArchiveCommand(args);
			if (archiveRequest !== undefined) {
				await dispatchArchiveCommand(state, archiveRequest, ctx, Boolean(state.overlayOpen));
				return;
			}
			const memoryRequest = parseMemoryCommand(args);
			if (memoryRequest !== undefined) {
				dispatchMemoryCommand(state, memoryRequest, ctx, Boolean(state.overlayOpen));
				return;
			}
			if (state.overlayOpen) {
				ctx.ui.notify("/jarvis is already open.", "info");
				return;
			}
			updateContextState(pi, state, ctx);
			state.overlayOpen = true;

			void ensureRuntime(pi, state, ctx).catch((error) => {
				if (isStaleJarvisBootError(error)) {
					return;
				}
				state.bridge.notify(error instanceof Error ? error.message : String(error), "error");
			});

			const initialMessage = normalizeInitialMessage(args);
			if (initialMessage) {
				queueMessage(state, initialMessage);
				void flushQueuedMessages(pi, state, ctx);
			}

			const overlayView = createOverlayView(pi, state, ctx);
			try {
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => {
						state.themeProvider = () => theme;
						let closed = false;
						const closeOverlay = () => {
							if (closed) return;
							closed = true;
							resetTransientAccessControls(state);
							state.bridge.resolveConfirmation(false);
							done(undefined);
							queueMicrotask(() => tui.requestRender());
						};
						state.closeOverlay = closeOverlay;
						const sessionId = ctx.sessionManager.getSessionId();
						const component = attachOverlayBridge(
							new JarvisOverlayComponent(tui, theme, state.bridge, overlayView, closeOverlay, keybindings,
								{ showIntro: !introSeenSessions.has(sessionId) }),
							state.bridge,
							tui,
						);
						introSeenSessions.add(sessionId);
						return component;
					},
					{
						overlay: true,
						overlayOptions: {
							width: "68%",
							minWidth: 68,
							maxHeight: "82%",
							anchor: "center",
						},
					},
				);
			} finally {
				state.overlayOpen = false;
				state.closeOverlay = undefined;
				resetTransientAccessControls(state);
				state.bridge.resolveConfirmation(false);
			}
		},
	});

	pi.registerCommand("jarvis-model", {
		description: "Set the model used by /jarvis without changing the main agent model",
		handler: async (args, ctx) => {
			updateContextState(pi, state, ctx);

			let parsedCommand: ParsedJarvisModelCommand;
			try {
				parsedCommand = parseJarvisModelCommand(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const { request, scope, clearScope } = parsedCommand;
			const scopeLabel = formatJarvisModelSelectionScope(scope);

			const loadModels = async (): Promise<readonly Model<any>[]> => {
				try {
					return await getAvailableJarvisModels(ctx.modelRegistry);
				} catch (error) {
					ctx.ui.notify(`Failed to refresh /jarvis models: ${error instanceof Error ? error.message : String(error)}`, "error");
					return [];
				}
			};
			const selectModelFromMenu = async (models: readonly Model<any>[], initialSearchInput?: string): Promise<Model<any> | undefined> => {
				models = models.filter((model) => model.api !== "pi-virtual");
				if (models.length === 0) {
					ctx.ui.notify("No /jarvis models are currently available from the main model registry.", "warning");
					return undefined;
				}
				return ctx.ui.custom<Model<any> | undefined>(
					(tui, theme, keybindings, done) => new JarvisModelPicker(
						tui, theme, keybindings, models, (model) => done(model), () => done(undefined), initialSearchInput,
					),
				);
			};

			const rollbackSelection = async (
				previousSelection: JarvisModelSelection,
				previousSource: JarvisModelSelectionSource,
			): Promise<void> => {
				await applyJarvisModelSelection(state, previousSelection);
				state.jarvisModelSelectionSource = previousSource;
			};

			const persistSelection = async (selection: JarvisModelSelection): Promise<void> => {
				const previousSelection = state.jarvisModelSelection;
				const previousSource = state.jarvisModelSelectionSource;
				const stored = toStoredJarvisModelSelection(selection);
				const resolved = resolveJarvisModelSelectionFromSettings(
					scope === "project" ? stored : loadJarvisModelSelectionForClear(ctx.cwd, "project", ctx),
					scope === "global" ? stored : loadJarvisModelSelectionForClear(ctx.cwd, "global", ctx),
					ctx.modelRegistry,
				);
				await applyJarvisModelSelection(state, resolved.selection);
				try {
					saveJarvisModelSelectionSetting(ctx.cwd, scope, stored);
					state.jarvisModelSelectionSource = resolved.source;
				} catch (error) {
					await rollbackSelection(previousSelection, previousSource);
					throw error;
				}
			};

			const clearScopedSelection = async (): Promise<ResolvedJarvisModelSelection> => {
				const previousSelection = state.jarvisModelSelection;
				const previousSource = state.jarvisModelSelectionSource;
				const projectSelection = scope === "project" ? undefined : loadJarvisModelSelectionForClear(ctx.cwd, "project", ctx);
				const globalSelection = scope === "global" ? undefined : loadJarvisModelSelectionForClear(ctx.cwd, "global", ctx);
				const resolvedSelection = resolveJarvisModelSelectionFromSettings(projectSelection, globalSelection, ctx.modelRegistry);
				await applyJarvisModelSelection(state, resolvedSelection.selection);
				try {
					clearJarvisModelSelectionSetting(ctx.cwd, scope);
					state.jarvisModelSelectionSource = resolvedSelection.source;
					return resolvedSelection;
				} catch (error) {
					await rollbackSelection(previousSelection, previousSource);
					throw error;
				}
			};

			const pinSelectedModel = async (model: Model<any>): Promise<void> => {
				try {
					await persistSelection({ mode: "pinned", model });
				} catch (error) {
					ctx.ui.notify(
						`Failed to pin /jarvis to ${formatModelLabel(model)} ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}

				ctx.ui.notify(
					`Saved /jarvis model ${formatModelLabel(model)} ${scopeLabel}. /jarvis is ${describeJarvisModelSelection(state)}. The main model is still ${formatModelLabel(state.model)}.`,
					"info",
				);
			};

			if (clearScope) {
				let resolvedSelection: ResolvedJarvisModelSelection;
				try {
					resolvedSelection = await clearScopedSelection();
				} catch (error) {
					ctx.ui.notify(
						`Failed to clear the /jarvis model setting ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}

				if (resolvedSelection.unavailable) {
					ctx.ui.notify(
						`Configured /jarvis model ${resolvedSelection.unavailable.modelReference} from the ${resolvedSelection.unavailable.scope} setting is unavailable. Falling back to follow-main.`,
						"warning",
					);
				}

				ctx.ui.notify(`Cleared the /jarvis model setting ${scopeLabel}. /jarvis is now ${describeJarvisModelSelection(state)}.`, "info");
				return;
			}

			if (request.toLowerCase() === "follow-main") {
				try {
					await persistSelection({ mode: "follow-main" });
				} catch (error) {
					ctx.ui.notify(
						`Failed to switch /jarvis back to follow-main ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(`Saved follow-main ${scopeLabel}. /jarvis is ${describeJarvisModelSelection(state)}.`, "info");
				return;
			}

			if (!request) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(
						`/jarvis is ${describeJarvisModelSelection(state)}. Use /jarvis-model [--project|--global] clear, /jarvis-model [--project|--global] follow-main, or /jarvis-model [--project|--global] <provider/model>.`,
						"info",
					);
					return;
				}

				const selectedModel = await selectModelFromMenu(await loadModels());
				if (!selectedModel) {
					return;
				}
				await pinSelectedModel(selectedModel);
				return;
			}

			const availableModels = await loadModels();
			const exactModel = findExactAvailableModelMatch(request, availableModels);
			if (exactModel) {
				await pinSelectedModel(exactModel);
				return;
			}

			if (ctx.mode !== "tui") {
				const errorMessage =
					availableModels.length === 0
						? "No /jarvis models are currently available from the main model registry."
						: `Unknown /jarvis model "${request}". Use /jarvis-model [--project|--global] clear, /jarvis-model [--project|--global] follow-main, or an exact provider/model from the current model registry.`;
				ctx.ui.notify(errorMessage, "error");
				return;
			}

			const selectedModel = await selectModelFromMenu(availableModels, request);
			if (!selectedModel) {
				return;
			}
			await pinSelectedModel(selectedModel);
		},
	});

	pi.registerCommand("jarvis-thinking", {
		description: "Set the thinking level used by /jarvis without changing the main agent thinking level",
		handler: async (args, ctx) => {
			updateContextState(pi, state, ctx);

			let parsedCommand: ParsedJarvisThinkingCommand;
			try {
				parsedCommand = parseJarvisThinkingCommand(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const { request, scope, clearScope } = parsedCommand;
			const scopeLabel = formatJarvisModelSelectionScope(scope);

			const rollbackSelection = async (
				previousSelection: JarvisThinkingSelection,
				previousSource: JarvisThinkingSelectionSource,
			): Promise<void> => {
				await applyJarvisThinkingSelection(state, previousSelection);
				state.jarvisThinkingSelectionSource = previousSource;
			};

			const persistSelection = async (selection: JarvisThinkingSelection): Promise<void> => {
				const previousSelection = state.jarvisThinkingSelection;
				const previousSource = state.jarvisThinkingSelectionSource;
				const resolved = resolveJarvisThinkingSelectionFromSettings(
					scope === "project" ? selection : loadJarvisThinkingSelectionForClear(ctx.cwd, "project", ctx),
					scope === "global" ? selection : loadJarvisThinkingSelectionForClear(ctx.cwd, "global", ctx),
				);
				await applyJarvisThinkingSelection(state, resolved.selection);
				try {
					saveJarvisThinkingSelectionSetting(ctx.cwd, scope, selection);
					state.jarvisThinkingSelectionSource = resolved.source;
				} catch (error) {
					await rollbackSelection(previousSelection, previousSource);
					throw error;
				}
			};

			const clearScopedSelection = async (): Promise<ResolvedJarvisThinkingSelection> => {
				const previousSelection = state.jarvisThinkingSelection;
				const previousSource = state.jarvisThinkingSelectionSource;
				const projectSelection = scope === "project" ? undefined : loadJarvisThinkingSelectionForClear(ctx.cwd, "project", ctx);
				const globalSelection = scope === "global" ? undefined : loadJarvisThinkingSelectionForClear(ctx.cwd, "global", ctx);
				const resolvedSelection = resolveJarvisThinkingSelectionFromSettings(projectSelection, globalSelection);
				await applyJarvisThinkingSelection(state, resolvedSelection.selection);
				try {
					clearJarvisThinkingSelectionSetting(ctx.cwd, scope);
					state.jarvisThinkingSelectionSource = resolvedSelection.source;
					return resolvedSelection;
				} catch (error) {
					await rollbackSelection(previousSelection, previousSource);
					throw error;
				}
			};

			if (clearScope) {
				try {
					await clearScopedSelection();
				} catch (error) {
					ctx.ui.notify(
						`Failed to clear the /jarvis thinking setting ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(`Cleared the /jarvis thinking setting ${scopeLabel}. /jarvis is now ${describeJarvisThinkingSelection(state)}.`, "info");
				return;
			}

			const normalizedRequest = request.toLowerCase();
			let selection: JarvisThinkingSelection | undefined;
			if (normalizedRequest === "auto") {
				selection = { mode: "auto" };
			} else if (normalizedRequest === "follow-main") {
				selection = { mode: "follow-main" };
			} else if (isJarvisThinkingLevel(normalizedRequest)) {
				selection = { mode: "pinned", thinkingLevel: normalizedRequest };
			}

			if (!selection) {
				ctx.ui.notify(
					`/jarvis is ${describeJarvisThinkingSelection(state)}. Use /jarvis-thinking [--project|--global] clear, auto, follow-main, off, minimal, low, medium, high, xhigh, or max.`,
					request ? "error" : "info",
				);
				return;
			}

			try {
				await persistSelection(selection);
			} catch (error) {
				ctx.ui.notify(
					`Failed to set /jarvis thinking ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			ctx.ui.notify(`Set /jarvis thinking to ${formatJarvisThinkingSelection(selection)} ${scopeLabel}. Effective /jarvis thinking is ${getDesiredJarvisThinkingLevel(state) ?? "off"}.`, "info");
		},
	});

	pi.registerCommand("jarvis-archive", {
		description: "Optional full-session archive: controls, indexed search, explicit import and deletion (help for syntax)",
		handler: async (args, ctx) => { await dispatchArchiveCommand(state, args, ctx, false); },
	});

	pi.registerCommand("jarvis-memory", {
		description: "Shared main Pi/Jarvis memory: status, on/off, capture/recall, search, remember, edit, forget (help for syntax)",
		handler: async (args, ctx) => { dispatchMemoryCommand(state, args, ctx, false); },
	});

	pi.on("session_before_switch", () => { state.runtime?.flushArchive?.(); state.archive.cancelImports(); });
	pi.on("session_before_fork", () => { state.runtime?.flushArchive?.(); state.archive.cancelImports(); });
	pi.on("session_before_tree", () => { state.runtime?.flushArchive?.(); state.archive.cancelImports(); });
	pi.on("session_start", async (_event, ctx) => {
		state.runtime?.flushArchive?.();
		state.archive.cancelImports();
		state.closeOverlay?.();
		state.bootGeneration += 1;
		state.runtime?.dispose();
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.queuedMessages = [];
		state.bridge.refresh();
		state.lastJarvisSeenMainContext = undefined;
		state.allowSideTools = false;
		state.allowFollowUpToMain = false;
		state.allowSteerToMain = false;
		state.mainSession.reset(formatModelLabel(ctx.model));
		const branchEntries = ctx.sessionManager.getBranch();
		state.sessionRef = readJarvisSessionRef(branchEntries);

		let resolvedSelection: ResolvedJarvisModelSelection = {
			selection: { mode: "follow-main" },
			source: "default",
		};
		let resolvedThinkingSelection: ResolvedJarvisThinkingSelection = {
			selection: { mode: "auto" },
			source: "default",
		};
		resolvedSelection = resolveConfiguredJarvisModelSelection(ctx.cwd, ctx.modelRegistry, (scope, error) => {
			ctx.ui.notify(`Failed to load the ${scope} /jarvis model setting: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
		resolvedThinkingSelection = resolveConfiguredJarvisThinkingSelection(ctx.cwd, (scope, error) => {
			ctx.ui.notify(`Failed to load the ${scope} /jarvis thinking setting: ${error instanceof Error ? error.message : String(error)}`, "error");
		});

		state.jarvisModelSelection = resolvedSelection.selection;
		state.jarvisModelSelectionSource = resolvedSelection.source;
		state.jarvisThinkingSelection = resolvedThinkingSelection.selection;
		state.jarvisThinkingSelectionSource = resolvedThinkingSelection.source;
		updateContextState(pi, state, ctx);
		enforceCompatibilityGuard(state);
		if (resolvedSelection.unavailable) {
			ctx.ui.notify(
				`Configured /jarvis model ${resolvedSelection.unavailable.modelReference} from the ${resolvedSelection.unavailable.scope} setting is unavailable. /jarvis is now ${describeJarvisModelSelection(state)}.`,
				"warning",
			);
		}
		state.bridge.reset();
	});

	pi.on("agent_start", async (_event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleAgentStart();
		refreshMainContext(state);
	});

	pi.on("agent_end", async (_event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleAgentEnd();
		refreshMainContext(state);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleAgentSettled();
		refreshMainContext(state);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const sessionRef = readJarvisSessionRef(ctx.sessionManager.getBranch());
		if (sessionRef?.file !== state.sessionRef?.file) {
			state.runtime?.flushArchive?.();
			state.closeOverlay?.();
			state.bootGeneration += 1;
			state.runtime?.dispose();
			state.runtime = undefined;
			state.bootPromise = undefined;
			state.flushPromise = undefined;
			state.queuedMessages = [];
			state.bridge.refresh();
			state.lastJarvisSeenMainContext = undefined;
			state.sessionRef = sessionRef;
			resetTransientAccessControls(state);
			state.bridge.reset();
		}
		state.mainSession.reset(formatModelLabel(ctx.model));
		updateContextState(pi, state, ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageStart(event);
		refreshMainContext(state);
	});

	pi.on("message_update", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageUpdate(event);
		refreshMainContext(state);
	});

	pi.on("message_end", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleMessageEnd(event);
		refreshMainContext(state);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleToolExecutionStart(event);
		refreshMainContext(state);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.mainSession.handleToolExecutionEnd(event);
		refreshMainContext(state);
	});

	pi.on("model_select", async (event, ctx) => {
		updateContextState(pi, state, ctx);
		state.model = event.model;
		state.mainSession.handleModelSelect(formatModelLabel(event.model));
		refreshMainContext(state);
		enforceCompatibilityGuard(state);
		if (
			!state.runtime ||
			(state.jarvisModelSelection.mode !== "follow-main" && state.jarvisThinkingSelection.mode !== "follow-main")
		) {
			return;
		}
		try {
			await syncRuntimeModelSelection(state);
		} catch (error) {
			state.bridge.notify(`Failed to sync /jarvis model: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		updateContextState(pi, state, ctx);
		try {
			await syncRuntimeModelSelection(state);
		} catch (error) {
			state.bridge.notify(`Failed to sync /jarvis thinking: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		state.runtime?.flushArchive?.();
		state.closeOverlay?.();
		state.bootGeneration += 1;
		state.runtime?.dispose();
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.queuedMessages = [];
		state.bridge.refresh();
		state.lastJarvisSeenMainContext = undefined;
		state.jarvisModelSelection = { mode: "follow-main" };
		state.jarvisModelSelectionSource = "default";
		state.jarvisThinkingSelection = { mode: "auto" };
		state.jarvisThinkingSelectionSource = "default";
		state.allowSideTools = false;
		state.allowFollowUpToMain = false;
		state.allowSteerToMain = false;
		state.mainSession.reset(formatModelLabel(state.model));
		refreshMainContext(state);
		// Cancel any pending confirmation and clear transient overlay state so a
		// side-session tool execute still waiting on confirmSteerToMain does not
		// hang while the session is torn down.
		state.bridge.reset();
	});

	createMemoryExtensionFactory(state.memory, "main")(pi);
	createArchiveExtensionFactory(state.archive, "main")(pi);
	// Close shared storage only after the archive lane's final snapshot/disposal.
	pi.on("session_shutdown", () => { state.archive.close(); });
}

function updateContextState(pi: ExtensionAPI, state: MainState, ctx: ExtensionContext): void {
	state.model = ctx.model;
	state.thinkingLevel = pi.getThinkingLevel();
	state.systemPrompt = ctx.getSystemPrompt();
	state.themeProvider = () => ctx.ui.theme;
	state.mainSession.refreshFromContext(ctx, formatModelLabel(state.model));
	refreshMainContext(state);
}

function refreshMainContext(state: MainState): void {
	state.mainContext = buildMainSessionContext(state.mainSession.snapshot());
	state.bridge.refresh();
}

function resetTransientAccessControls(state: MainState): void {
	state.allowSideTools = false;
	state.allowFollowUpToMain = false;
	state.allowSteerToMain = false;
	state.runtime?.setToolAccessEnabled(false);
}

function getDesiredJarvisModel(state: MainState): Model<any> | undefined {
	return state.jarvisModelSelection.mode === "pinned" ? state.jarvisModelSelection.model : state.model;
}

function getDesiredJarvisThinkingLevel(state: MainState): string | undefined {
	const desiredModel = getDesiredJarvisModel(state);
	if (desiredModel?.provider === "xai") {
		return "off";
	}
	if (state.jarvisThinkingSelection.mode === "pinned") {
		return state.jarvisThinkingSelection.thinkingLevel;
	}
	if (state.jarvisThinkingSelection.mode === "follow-main") {
		return state.thinkingLevel;
	}
	return state.jarvisModelSelection.mode === "follow-main" ? state.thinkingLevel : "off";
}

function toStoredJarvisModelSelection(selection: JarvisModelSelection): StoredJarvisModelSelection {
	return selection.mode === "follow-main"
		? { mode: "follow-main" }
		: { mode: "pinned", provider: selection.model.provider, modelId: selection.model.id };
}

function formatJarvisModelSelectionSource(source: JarvisModelSelectionSource): string {
	if (source === "project") {
		return "project setting";
	}
	if (source === "global") {
		return "global setting";
	}
	return "default";
}

function formatJarvisModelSelectionScope(scope: JarvisModelSelectionScope): string {
	return scope === "project" ? "for this project" : "globally";
}

function parseJarvisModelCommand(args: string): ParsedJarvisModelCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let scope: JarvisModelSelectionScope = "project";
	let scopeExplicitlySet = false;
	const requestTokens: string[] = [];

	for (const token of tokens) {
		if (token === "--project" || token === "--global") {
			if (scopeExplicitlySet) {
				throw new Error("Choose only one scope flag: --project or --global.");
			}
			scope = token === "--global" ? "global" : "project";
			scopeExplicitlySet = true;
			continue;
		}
		requestTokens.push(token);
	}

	const request = requestTokens.join(" " );
	return {
		request,
		scope,
		clearScope: request.toLowerCase() === "clear",
	};
}

function parseJarvisThinkingCommand(args: string): ParsedJarvisThinkingCommand {
	const parsed = parseJarvisModelCommand(args);
	return {
		request: parsed.request,
		scope: parsed.scope,
		clearScope: parsed.clearScope,
	};
}

function isJarvisThinkingLevel(value: string): value is JarvisThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function formatJarvisThinkingSelection(selection: JarvisThinkingSelection): string {
	if (selection.mode === "auto") {
		return "auto";
	}
	if (selection.mode === "follow-main") {
		return "follow-main";
	}
	return selection.thinkingLevel;
}

function describeJarvisThinkingSelection(state: MainState): string {
	const sourceLabel = formatJarvisModelSelectionSource(state.jarvisThinkingSelectionSource);
	return `thinking ${formatJarvisThinkingSelection(state.jarvisThinkingSelection)} (effective ${getDesiredJarvisThinkingLevel(state) ?? "off"}; ${sourceLabel})`;
}

function resolveStoredJarvisModelSelection(
	storedSelection: StoredJarvisModelSelection,
	source: JarvisModelSelectionSource,
	modelRegistry: ExtensionContext["modelRegistry"],
): ResolvedJarvisModelSelection {
	if (storedSelection.mode === "follow-main") {
		return {
			selection: { mode: "follow-main" },
			source,
		};
	}

	const restoredModel = modelRegistry.find(storedSelection.provider, storedSelection.modelId);
	if (!restoredModel) {
		return {
			selection: { mode: "follow-main" },
			source: "default",
			unavailable: {
				scope: source === "default" ? "project" : source,
				modelReference: `${storedSelection.provider}/${storedSelection.modelId}`,
			},
		};
	}

	return {
		selection: { mode: "pinned", model: restoredModel },
		source,
	};
}

function resolveJarvisModelSelectionFromSettings(
	projectSelection: StoredJarvisModelSelection | undefined,
	globalSelection: StoredJarvisModelSelection | undefined,
	modelRegistry: ExtensionContext["modelRegistry"],
): ResolvedJarvisModelSelection {
	if (projectSelection) {
		const resolvedProjectSelection = resolveStoredJarvisModelSelection(projectSelection, "project", modelRegistry);
		if (!resolvedProjectSelection.unavailable) {
			return resolvedProjectSelection;
		}
		if (globalSelection) {
			const resolvedGlobalSelection = resolveStoredJarvisModelSelection(globalSelection, "global", modelRegistry);
			if (!resolvedGlobalSelection.unavailable) {
				return {
					...resolvedGlobalSelection,
					unavailable: resolvedProjectSelection.unavailable,
				};
			}
		}
		return resolvedProjectSelection;
	}
	if (globalSelection) {
		return resolveStoredJarvisModelSelection(globalSelection, "global", modelRegistry);
	}
	return {
		selection: { mode: "follow-main" },
		source: "default",
	};
}

function resolveConfiguredJarvisModelSelection(
	cwd: string,
	modelRegistry: ExtensionContext["modelRegistry"],
	onScopeError?: (scope: JarvisModelSelectionScope, error: unknown) => void,
): ResolvedJarvisModelSelection {
	let projectSelection: StoredJarvisModelSelection | undefined;
	let globalSelection: StoredJarvisModelSelection | undefined;

	try {
		projectSelection = loadJarvisModelSelectionSetting(cwd, "project");
	} catch (error) {
		onScopeError?.("project", error);
	}

	try {
		globalSelection = loadJarvisModelSelectionSetting(cwd, "global");
	} catch (error) {
		onScopeError?.("global", error);
	}

	return resolveJarvisModelSelectionFromSettings(projectSelection, globalSelection, modelRegistry);
}

function resolveJarvisThinkingSelectionFromSettings(
	projectSelection: StoredJarvisThinkingSelection | undefined,
	globalSelection: StoredJarvisThinkingSelection | undefined,
): ResolvedJarvisThinkingSelection {
	if (projectSelection) {
		return { selection: projectSelection, source: "project" };
	}
	if (globalSelection) {
		return { selection: globalSelection, source: "global" };
	}
	return { selection: { mode: "auto" }, source: "default" };
}

function resolveConfiguredJarvisThinkingSelection(
	cwd: string,
	onScopeError?: (scope: JarvisModelSelectionScope, error: unknown) => void,
): ResolvedJarvisThinkingSelection {
	let projectSelection: StoredJarvisThinkingSelection | undefined;
	let globalSelection: StoredJarvisThinkingSelection | undefined;

	try {
		projectSelection = loadJarvisThinkingSelectionSetting(cwd, "project");
	} catch (error) {
		onScopeError?.("project", error);
	}

	try {
		globalSelection = loadJarvisThinkingSelectionSetting(cwd, "global");
	} catch (error) {
		onScopeError?.("global", error);
	}

	return resolveJarvisThinkingSelectionFromSettings(projectSelection, globalSelection);
}

function loadJarvisModelSelectionForClear(
	cwd: string,
	scope: JarvisModelSelectionScope,
	ctx: ExtensionCommandContext,
): StoredJarvisModelSelection | undefined {
	try {
		return loadJarvisModelSelectionSetting(cwd, scope);
	} catch (error) {
		if (!(error instanceof MalformedJarvisConfigError)) throw error;
		ctx.ui.notify(`Ignoring malformed ${scope} /jarvis model setting while resolving settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return undefined;
	}
}

function loadJarvisThinkingSelectionForClear(
	cwd: string,
	scope: JarvisModelSelectionScope,
	ctx: ExtensionCommandContext,
): StoredJarvisThinkingSelection | undefined {
	try {
		return loadJarvisThinkingSelectionSetting(cwd, scope);
	} catch (error) {
		if (!(error instanceof MalformedJarvisConfigError)) throw error;
		ctx.ui.notify(`Ignoring malformed ${scope} /jarvis thinking setting while resolving settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return undefined;
	}
}

function isModelBridgeCompatible(model: Model<any> | undefined): boolean {
	if (!model) {
		return true;
	}
	if (model.provider === "xai" && model.id.includes("multi-agent")) {
		return false;
	}
	return true;
}

function enforceCompatibilityGuard(state: MainState): void {
	const desired = getDesiredJarvisModel(state);
	if (!isModelBridgeCompatible(desired)) {
		state.allowFollowUpToMain = false;
		state.allowSteerToMain = false;
		state.bridge.notify(`Disabled Follow-up/Steer: ${formatModelLabel(desired)} does not support bridge tools.`, "warning");
	}
	state.runtime?.setToolAccessEnabled(state.allowSideTools);
}

function getJarvisModelModeLabel(selection: JarvisModelSelection): string {
	return selection.mode === "follow-main" ? "follow main" : "pinned";
}

function describeJarvisModelSelection(state: MainState): string {
	const activeModelLabel = formatModelLabel(getDesiredJarvisModel(state));
	const sourceLabel = formatJarvisModelSelectionSource(state.jarvisModelSelectionSource);
	return state.jarvisModelSelection.mode === "follow-main"
		? `following the main model (${activeModelLabel}; ${sourceLabel})`
		: `pinned to ${activeModelLabel} (${sourceLabel})`;
}

async function getAvailableJarvisModels(modelRegistry: ExtensionContext["modelRegistry"]): Promise<readonly Model<any>[]> {
	await modelRegistry.refresh();
	return modelRegistry.getAvailable();
}

function findExactAvailableModelMatch(
	modelReference: string,
	availableModels: readonly Model<any>[],
): Model<any> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

async function syncRuntimeModelSelection(state: MainState): Promise<void> {
	if (!state.runtime) {
		return;
	}
	await state.runtime.syncModel(getDesiredJarvisModel(state), getDesiredJarvisThinkingLevel(state));
}

async function applyJarvisModelSelection(state: MainState, selection: JarvisModelSelection): Promise<void> {
	if (selection.mode === "pinned" && selection.model.api === "pi-virtual") {
		throw new Error("/jarvis requires a physical model; Pi's public registry does not expose virtual routing.");
	}
	const previousSelection = state.jarvisModelSelection;
	state.jarvisModelSelection = selection;
	try {
		await syncRuntimeModelSelection(state);
		enforceCompatibilityGuard(state);
	} catch (error) {
		state.jarvisModelSelection = previousSelection;
		try {
			await syncRuntimeModelSelection(state);
			enforceCompatibilityGuard(state);
		} catch {
			// Keep the original sync failure; rollback is best-effort only.
		}
		throw error;
	}
}

async function applyJarvisThinkingSelection(state: MainState, selection: JarvisThinkingSelection): Promise<void> {
	const previousSelection = state.jarvisThinkingSelection;
	state.jarvisThinkingSelection = selection;
	try {
		await syncRuntimeModelSelection(state);
	} catch (error) {
		state.jarvisThinkingSelection = previousSelection;
		try {
			await syncRuntimeModelSelection(state);
		} catch {
			// Keep the original sync failure; rollback is best-effort only.
		}
		throw error;
	}
}

async function executeJarvisSideCommand(
	pi: ExtensionAPI,
	state: MainState,
	ctx: ExtensionCommandContext,
	runtime: JarvisSideSessionRuntime,
	command: JarvisSideCommand,
): Promise<JarvisSideSessionRuntime> {
	if (command.name === "compact") {
		await runtime.compactJarvisContext(command.customInstructions);
		return runtime;
	}
	if (command.name === "tree") {
		if (!command.targetId) {
			runtime.addSystemMessage(runtime.describeSessionTree());
			return runtime;
		}
		const generation = state.bootGeneration;
		await runtime.navigateSessionTree(command.targetId, {
			summarize: command.summarize,
			customInstructions: command.customInstructions,
		});
		if (generation === state.bootGeneration && state.runtime === runtime) {
			state.bridge.resetTranscript();
		}
		return runtime;
	}

	state.runtime?.flushArchive?.();
	const generation = ++state.bootGeneration;
	state.runtime?.dispose();
	state.runtime = undefined;
	state.bootPromise = undefined;
	state.lastJarvisSeenMainContext = undefined;
	resetTransientAccessControls(state);
	state.bridge.reset();
	const sessionFile = await createSideSessionFile(ctx.cwd);
	if (generation !== state.bootGeneration) throw new StaleJarvisBootError();
	const sessionRef = createJarvisSessionRef(sessionFile);
	state.sessionRef = sessionRef;
	pi.appendEntry(JARVIS_SESSION_REF_CUSTOM_TYPE, sessionRef);
	const nextRuntime = await ensureRuntime(pi, state, ctx);
	nextRuntime.addSystemMessage("Started a new /jarvis side session.");
	return nextRuntime;
}

function normalizeInitialMessage(args: string): string | undefined {
	const message = args.trim();
	return message.length > 0 ? message : undefined;
}

function queueMessage(state: MainState, message: string): void {
	state.queuedMessages.push(message);
	state.bridge.refresh();
}

function parseArchiveCommand(message: string): string | undefined {
	const match = /^\/(?:jarvis-archive|archive)(?:\s+([\s\S]*))?$/.exec(message.trim());
	return match ? match[1] ?? "" : undefined;
}

async function dispatchArchiveCommand(state: MainState, args: string, ctx: ExtensionContext, overlay: boolean): Promise<void> {
	const generation = state.bootGeneration;
	try {
		const text = await state.archive.command(args, ctx);
		// Never deliver an old import completion into a replaced main/side thread.
		if (generation !== state.bootGeneration) return;
		if (overlay && state.runtime) state.runtime.addSystemMessage(text);
		else if (overlay) state.bridge.notify(text, "info");
		else if (ctx.hasUI) ctx.ui.notify(text, "info");
		else process.stderr.write(`${text}\n`);
	} catch (error) {
		if (generation !== state.bootGeneration) return;
		const text = error instanceof Error ? error.message : "Archive operation failed.";
		if (overlay) state.bridge.notify(text, "error");
		else if (ctx.hasUI) ctx.ui.notify(text, "error");
		else process.stderr.write(`${text}\n`);
	}
}

function parseMemoryCommand(message: string): string | undefined {
	const match = /^\/(?:jarvis-memory|memory)(?:\s+([\s\S]*))?$/.exec(message.trim());
	return match ? match[1] ?? "" : undefined;
}

function dispatchMemoryCommand(state: MainState, args: string, ctx: ExtensionContext, overlay: boolean): void {
	try {
		const text = state.memory.command(args, ctx);
		if (overlay && state.runtime) state.runtime.addSystemMessage(text);
		else if (overlay) state.bridge.notify(text, "info");
		else if (ctx.hasUI) ctx.ui.notify(text, "info");
		else process.stderr.write(`${text}\n`);
	} catch (error) {
		const text = error instanceof Error ? error.message : "Shared memory operation failed.";
		if (overlay) state.bridge.notify(text, "error");
		else if (ctx.hasUI) ctx.ui.notify(text, "error");
		else process.stderr.write(`${text}\n`);
	}
}

function parseJarvisSideCommand(message: string): JarvisSideCommand | undefined {
	const text = message.trim();
	if (text === "/new") {
		return { name: "new" };
	}
	if (text === "/compact") {
		return { name: "compact" };
	}
	if (text.startsWith("/compact ")) {
		return { name: "compact", customInstructions: text.slice("/compact ".length).trim() || undefined };
	}
	if (text === "/tree") {
		return { name: "tree", summarize: false };
	}
	if (text.startsWith("/tree ")) {
		const args = text.slice("/tree ".length).trim();
		if (args === "--summarize") throw new Error("Use /tree --summarize <entry-id> [instructions].");
		const summarizePrefix = "--summarize ";
		if (args.startsWith(summarizePrefix)) {
			const rest = args.slice(summarizePrefix.length).trim();
			const [targetId, ...instructionTokens] = rest.split(/\s+/).filter(Boolean);
			return {
				name: "tree",
				targetId,
				summarize: true,
				customInstructions: instructionTokens.join(" ").trim() || undefined,
			};
		}
		const [targetId] = args.split(/\s+/).filter(Boolean);
		return { name: "tree", targetId, summarize: false };
	}
	return undefined;
}

function createOverlayView(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): JarvisOverlayView {
	const queue = state.queuedMessages;
	const syncToolAccess = () => {
		state.runtime?.setToolAccessEnabled(state.allowSideTools);
	};

	return {
		isReady: () => state.runtime?.isReady() ?? false,
		isStreaming: () => state.runtime?.isStreaming() ?? false,
		getQueuedMessageCount: () => state.queuedMessages === queue ? queue.length : 0,
		getIsProcessing: () => state.queuedMessages === queue && Boolean(state.bootPromise || state.flushPromise),
		getModelLabel: () => state.runtime?.getModelLabel() ?? formatModelLabel(getDesiredJarvisModel(state)),
		getModelModeLabel: () => getJarvisModelModeLabel(state.jarvisModelSelection),
		getMainStatusLabel: () => state.mainContext.summary.mainStatus,
		getMainModelLabel: () => state.mainContext.summary.mainModelLabel,
		getMainFocusLabel: () => state.mainContext.summary.workState.currentAction,
		getMainDeltaLabel: () => formatMainContextDeltaLabel(state.lastJarvisSeenMainContext, state.mainContext),
		getRepoToolsDetailLabel: () => state.runtime?.getRepoToolsDetailLabel() ?? (state.allowSideTools ? "local tools only" : "repo tools off"),
		isToolAccessEnabled: () => state.allowSideTools,
		isFollowUpToMainEnabled: () => state.allowFollowUpToMain,
		isSteerToMainEnabled: () => state.allowSteerToMain,
		toggleToolAccess: () => {
			state.allowSideTools = !state.allowSideTools;
			syncToolAccess();
		},
		toggleFollowUpToMain: () => {
			if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
				state.bridge.notify("Follow-up is not supported by the current /jarvis model.", "warning");
				return;
			}
			state.allowFollowUpToMain = !state.allowFollowUpToMain;
			syncToolAccess();
		},
		toggleSteerToMain: () => {
			if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
				state.bridge.notify("Steer is not supported by the current /jarvis model.", "warning");
				return;
			}
			state.allowSteerToMain = !state.allowSteerToMain;
			syncToolAccess();
		},
		getDisplayEntries: () => getOverlayEntries(state),
		sendMessage: async (text: string) => {
			if (state.queuedMessages !== queue) return;
			const archiveCommand = parseArchiveCommand(text);
			if (archiveCommand !== undefined) {
				await dispatchArchiveCommand(state, archiveCommand, ctx, true);
				return;
			}
			// Memory controls must work immediately, even while a side turn is busy.
			const memoryCommand = parseMemoryCommand(text);
			if (memoryCommand !== undefined) {
				dispatchMemoryCommand(state, memoryCommand, ctx, true);
				return;
			}
			queueMessage(state, text);
			if (state.queuedMessages !== queue) return;
			await flushQueuedMessages(pi, state, ctx);
		},
	};
}

function getOverlayEntries(state: MainState): JarvisDisplayEntry[] {
	let entries: JarvisDisplayEntry[];
	if (state.runtime) {
		// Do not append per-render UI status to runtime-owned transcript arrays.
		entries = [...state.runtime.getDisplayEntries()];
	} else {
		const hasRestorableSessionRef = Boolean(state.sessionRef?.file && existsSync(state.sessionRef.file));
		entries = [
			{
				kind: "system",
				text: hasRestorableSessionRef
					? "Connecting to your prior /jarvis conversation…"
					: "Starting /jarvis side conversation…",
			},
		];
	}

	if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
		entries.push({ kind: "status", text: "Relay disabled: current /jarvis model is incompatible with bridge tools" });
	}

	return entries;
}

function formatMainContextDeltaLabel(
	previousContext: MainSessionContextPayload | undefined,
	currentContext: MainSessionContextPayload,
): string {
	if (!previousContext) {
		return "first /jarvis turn";
	}
	if (currentContext.summary.workState.currentAction !== previousContext.summary.workState.currentAction) {
		return `focus → ${currentContext.summary.workState.currentAction}`;
	}
	if (currentContext.summary.validation.summary !== previousContext.summary.validation.summary) {
		return `validation → ${currentContext.summary.validation.summary}`;
	}
	if (currentContext.summary.mainStatus !== previousContext.summary.mainStatus) {
		return `main status → ${currentContext.summary.mainStatus}`;
	}
	if (currentContext.summary.mainModelLabel !== previousContext.summary.mainModelLabel) {
		return `model → ${currentContext.summary.mainModelLabel}`;
	}
	const previousFiles = new Set(previousContext.summary.workState.recentFiles);
	const newFiles = currentContext.summary.workState.recentFiles.filter((file) => !previousFiles.has(file));
	if (newFiles.length > 0) {
		return `new files → ${newFiles.join(", ")}`;
	}
	if (currentContext.summary.latestUserRequest && currentContext.summary.latestUserRequest !== previousContext.summary.latestUserRequest) {
		return `request → ${currentContext.summary.latestUserRequest}`;
	}
	if (currentContext.summary.latestAssistantText && currentContext.summary.latestAssistantText !== previousContext.summary.latestAssistantText) {
		return `assistant → ${currentContext.summary.latestAssistantText}`;
	}
	return "no significant change";
}

async function flushQueuedMessages(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): Promise<void> {
	if (state.flushPromise) return state.flushPromise;

	// Queue identity survives a side /new, but not a main-session replacement.
	// A stale completion must never consume or unlock a replacement queue.
	const queue = state.queuedMessages;
	const isCurrent = () => state.queuedMessages === queue;
	let flushPromise: Promise<void>;
	// Publish ownership before any refresh or asynchronous work can reenter.
	flushPromise = Promise.resolve().then(async () => {
		if (!isCurrent()) return;
		try {
			updateContextState(pi, state, ctx);
			let runtime = await ensureRuntime(pi, state, ctx);
			if (!isCurrent()) return;
			while (queue.length > 0 && isCurrent()) {
				// Consume once: a failed command must not poison the queue, and an
				// uncertain provider/tool send must not be retried automatically.
				const message = queue.shift()!;
				state.bridge.refresh();
				if (!isCurrent()) return;
				try {
					const command = parseJarvisSideCommand(message);
					if (command) {
						runtime = await executeJarvisSideCommand(pi, state, ctx, runtime, command);
					} else {
						await runtime.syncModel(getDesiredJarvisModel(state), getDesiredJarvisThinkingLevel(state));
						if (!isCurrent()) return;
						const seenContext = state.mainContext;
						await runtime.sendMessage(message);
						if (isCurrent()) state.lastJarvisSeenMainContext = seenContext;
					}
					if (!isCurrent()) return;
				} catch (error) {
					if (!isCurrent() || isStaleJarvisBootError(error)) return;
					state.bridge.notify(`Failed to process /jarvis input: ${error instanceof Error ? error.message : String(error)}. Input was not retried.`, "error");
				}
			}
		} catch (error) {
			if (!isCurrent() || isStaleJarvisBootError(error)) return;
			queue.length = 0;
			state.bridge.refresh();
			if (!isCurrent()) return;
			state.bridge.notify(`/jarvis startup failed: ${error instanceof Error ? error.message : String(error)}. Please submit again.`, "error");
		}
	}).finally(() => {
		if (state.flushPromise === flushPromise) {
			state.flushPromise = undefined;
			state.bridge.refresh();
		}
	});
	state.flushPromise = flushPromise;
	state.bridge.refresh();
	return flushPromise;
}

async function ensureRuntime(pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext): Promise<JarvisSideSessionRuntime> {
	if (state.runtime) {
		return state.runtime;
	}
	if (state.bootPromise) {
		return state.bootPromise;
	}

	const bootGeneration = state.bootGeneration;
	const isCurrentBoot = () => state.bootGeneration === bootGeneration;
	state.bridge.setWorkingMessage("Starting /jarvis…");
	let bootPromise: Promise<JarvisSideSessionRuntime>;
	bootPromise = (async () => {
		let sessionFile = state.sessionRef?.file;
		if (!sessionFile || !existsSync(sessionFile)) {
			sessionFile = await createSideSessionFile(ctx.cwd);
			if (!isCurrentBoot()) {
				throw new StaleJarvisBootError();
			}
			const sessionRef = createJarvisSessionRef(sessionFile);
			state.sessionRef = sessionRef;
			pi.appendEntry(JARVIS_SESSION_REF_CUSTOM_TYPE, sessionRef);
		}

		const runtime = await JarvisSideSessionRuntime.create({
			bridge: state.bridge,
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			memory: state.memory,
			memoryTrustProvider: () => isCurrentBoot() && ctx.isProjectTrusted(),
			archive: state.archive,
			archiveTrustProvider: () => isCurrentBoot() && ctx.isProjectTrusted(),
			modelRegistry: ctx.modelRegistry,
			model: getDesiredJarvisModel(state),
			jarvisModelModeProvider: () => state.jarvisModelSelection.mode,
			thinkingLevel: getDesiredJarvisThinkingLevel(state),
			sessionFile,
			systemPromptProvider: () => state.systemPrompt,
			mainContextProvider: () => state.mainContext,
			toolAccessProvider: () => isCurrentBoot() && state.allowSideTools,
			communicationPermissionsProvider: () => ({
				allowFollowUpToMain: isCurrentBoot() && state.allowFollowUpToMain,
				allowSteerToMain: isCurrentBoot() && state.allowSteerToMain,
			}),
			sendFollowUpToMain: (message: string) => {
				if (!isCurrentBoot() || !state.allowFollowUpToMain) throw new Error("/jarvis follow-up permission expired.");
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			},
			// Route the confirmation through the /jarvis overlay itself via the
			// bridge. The main session's UI confirm would otherwise render inside
			// the base layer (the pi editor container) and sit hidden behind the
			// /jarvis overlay, leaving the side-session tool execute hung on a
			// promise the user could never answer.
			confirmSteerToMain: (message: string, signal?: AbortSignal) =>
				state.bridge.requestConfirmation(
					"Send /jarvis steer to main?",
					`This will steer the main agent with:\n\n${message}`,
					signal,
				),
			sendSteerToMain: (message: string) => {
				if (!isCurrentBoot() || !state.allowSteerToMain) throw new Error("/jarvis redirect permission expired.");
				pi.sendUserMessage(message, { deliverAs: "steer" });
			},
			themeProvider: state.themeProvider,
		});

		if (!isCurrentBoot()) {
			runtime.dispose();
			throw new StaleJarvisBootError();
		}

		state.runtime = runtime;
		state.bridge.setWorkingMessage(undefined);
		return runtime;
	})().catch((error) => {
		if (!isCurrentBoot()) throw new StaleJarvisBootError();
		state.bridge.setWorkingMessage(undefined);
		throw error;
	}).finally(() => {
		if (state.bootPromise === bootPromise) {
			state.bootPromise = undefined;
			state.bridge.refresh();
		}
	});
	state.bootPromise = bootPromise;
	state.bridge.refresh();

	return bootPromise;
}

function formatModelLabel(model: Model<any> | undefined): string {
	if (!model) {
		return "model unavailable";
	}
	return `${model.provider}/${model.id}`;
}
