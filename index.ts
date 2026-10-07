import { existsSync } from "node:fs";
import type { Component, Focusable, OverlayHandle } from "@earendil-works/pi-tui";
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
import { invalidateMemoryEditor, openMemoryEditor } from "./memory-editor-controller.js";
import { SharedArchiveService } from "./archive-service.js";
import { createArchiveExtensionFactory } from "./archive-extension.js";
import { abandonArchiveSecretPrompt, isArchiveSecretPromptActive, revokeArchiveSecretPrompt } from "./archive-secret-input.js";

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
	mainArchiveSnapshot?: () => void;
	mainSession: MainSessionTracker;
	mainContext: MainSessionContextPayload;
	lastJarvisSeenMainContext?: MainSessionContextPayload;
	sessionRef?: JarvisSessionRef;
	runtime?: JarvisSideSessionRuntime;
	bootPromise?: Promise<JarvisSideSessionRuntime>;
	bootGeneration: number;
	flushPromise?: Promise<void>;
	stopPromise?: Promise<void>;
	workGeneration: number;
	configuring?: object;
	statusContext?: ExtensionContext;
	trustProvider?: () => boolean;
	overlayOwner?: object;
	closeOverlay?: (forced?: boolean, handoff?: object, privatePreparation?: boolean) => void;
	waitOverlayClosed?: () => Promise<void>;
	cancelOverlayHandoff?: (owner: object) => void;
	overlayOpen?: boolean;
	modelPickerOpen?: boolean;
	memoryReviewOpen?: boolean;
	memoryEditorOwner?: object;
	closeMemoryEditor?: (forced?: boolean) => void;
	memoryEditorDirty?: () => boolean;
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
	// Do not let an older saving picker overwrite a newer accepted choice in
	// the same presentation after out-of-order catalog completion.
	let embeddedModelRequest: object | undefined;
	let embeddedThinkingRequest: object | undefined;
	const mainSession = new MainSessionTracker();
	const state: MainState = {
		bridge: new JarvisOverlayBridge(() => Boolean(state.overlayOpen) && !state.memoryEditorOwner && !isArchiveSecretPromptActive()),
		memory: new SharedMemoryService(getAgentDir()),
		archive: new SharedArchiveService(getAgentDir(), {
			beforeSecretPrompt: async () => {
				if (state.modelPickerOpen || state.memoryReviewOpen || state.memoryEditorOwner) {
					throw new Error("Finish the current Jarvis picker, memory review or editor before entering an archive password.");
				}
				// Password preparation explicitly revokes access BEFORE closing/yielding.
				// Ordinary presentation close deliberately preserves these grants.
				resetTransientAccessControls(state);
				state.closeOverlay?.(false, undefined, true);
				await Promise.resolve();
			},
		}),
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
		workGeneration: 0,
	};

	state.bridge.onChange(() => refreshMainStatus(state));

	pi.registerCommand("jarvis", {
		description: "Open Jarvis; status, stop, or access off control background work locally",
		handler: async (args, ctx) => {
			const localControl = parseLocalControl(args, true);
			if (localControl) { await dispatchLocalControl(state, localControl, ctx, Boolean(state.overlayOpen)); return; }
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/jarvis requires Pi's interactive terminal UI.", "warning");
				return;
			}
			if (isArchiveSecretPromptActive()) {
				ctx.ui.notify("Finish the private archive password/exit verification before opening Jarvis.", "warning");
				return;
			}
			const archiveRequest = parseArchiveCommand(args);
			if (archiveRequest !== undefined) {
				await dispatchArchiveCommand(state, archiveRequest, ctx, Boolean(state.overlayOpen));
				return;
			}
			const memoryRequest = parseMemoryCommand(args);
			if (memoryRequest !== undefined) {
				await dispatchMemoryCommand(state, memoryRequest, ctx, Boolean(state.overlayOpen));
				return;
			}
			if (state.memoryEditorOwner || state.modelPickerOpen || state.memoryReviewOpen) {
				ctx.ui.notify("Finish the current Jarvis picker, memory review or editor before opening Jarvis.", "warning");
				return;
			}
			if (state.overlayOpen) {
				ctx.ui.notify("/jarvis is already open.", "info");
				return;
			}
			if (state.configuring) {
				ctx.ui.notify("Wait for /jarvis configuration to finish, then reopen.", "warning");
				return;
			}
			updateContextState(pi, state, ctx);
			// A presentation can be closed while its public factory is still pending.
			// Retire that request without invoking its topmost-pop completion.
			state.closeOverlay?.(true);
			const overlayOwner = {};
			state.overlayOwner = overlayOwner;
			state.overlayOpen = true;
			state.bridge.refresh();

			void ensureRuntime(pi, state, ctx).catch((error) => {
				if (isStaleJarvisBootError(error)) {
					return;
				}
				state.bridge.notify(error instanceof Error ? error.message : String(error), "error");
			});

			const initialMessage = normalizeInitialMessage(args);
			if (initialMessage && !state.stopPromise) {
				queueMessage(state, initialMessage);
				void flushQueuedMessages(pi, state, ctx);
			}

			const overlayView = createOverlayView(pi, state, ctx, configureModel, configureThinking);
			const queue = state.queuedMessages, boot = state.bootGeneration;
			const manager = ctx.sessionManager, sessionId = manager.getSessionId();
			let terminalColumns: (() => number) | undefined;
			let closed = false, abandoned = false, finished = false, factoryUsed = false;
			let handoff: object | undefined;
			let component: JarvisOverlayComponent | undefined, handle: OverlayHandle | undefined;
			let finishOverlay: (() => void) | undefined;
			let resolveOverlayClosed!: () => void;
			const overlayClosed = new Promise<void>(resolve => { resolveOverlayClosed = resolve; });
			const waitOverlayClosed = () => overlayClosed;
			const current = () => state.overlayOwner === overlayOwner && state.queuedMessages === queue &&
				state.bootGeneration === boot && ctx.sessionManager === manager && manager.getSessionId() === sessionId;
			const admitted = () => current() && !abandoned && !isArchiveSecretPromptActive() &&
				!state.modelPickerOpen && !state.memoryReviewOpen &&
				(handoff ? state.memoryEditorOwner === handoff : !state.memoryEditorOwner);
			const settle = () => {
				resolveOverlayClosed();
				if (state.waitOverlayClosed === waitOverlayClosed) state.waitOverlayClosed = undefined;
				if (state.cancelOverlayHandoff === cancelHandoff) state.cancelOverlayHandoff = undefined;
				if (state.closeOverlay === closeOverlay) state.closeOverlay = undefined;
				if (state.overlayOwner === overlayOwner) {
					state.overlayOwner = undefined;
					state.overlayOpen = false;
					state.bridge.resolveConfirmation(false);
					state.bridge.refresh();
				}
			};
			const abandon = () => {
				abandoned = closed = true;
				finishOverlay = undefined;
				try { component?.dispose(); } catch { /* Retired UI must not block settlement. */ }
				component = undefined;
				// Exact visibility only: public custom done() pops the TOPMOST
				// overlay, not necessarily this interaction's overlay.
				try { handle?.setHidden(true); } catch { /* Host may already have ended. */ }
				handle = undefined;
				settle();
			};
			const complete = (privatePreparation = false) => {
				if (!closed || finished || abandoned) return;
				// A private prompt reserves its gate BEFORE closing the current
				// mounted Jarvis window. This synchronous close capability is not
				// retained by deferred factories/onHandle callbacks.
				const canComplete = () => admitted() || (privatePreparation && current() && !abandoned
					&& !state.modelPickerOpen && !state.memoryReviewOpen && !state.memoryEditorOwner);
				if (!canComplete()) { abandon(); return; }
				if (!handle) {
					// Private preparation cannot wait for an obsolete deferred
					// presentation; retire it without ever retaining this capability.
					if (privatePreparation) abandon();
					return;
				}
				let foreground = false;
				try { foreground = !handle.isHidden() && handle.isFocused(); } catch { /* Host ended. */ }
				if (!foreground || !canComplete()) { abandon(); return; }
				finished = true;
				const done = finishOverlay; finishOverlay = undefined;
				done?.();
			};
			const closeOverlay = (forced = false, modalOwner?: object, privatePreparation = false) => {
				if (forced) { abandon(); return; }
				if (closed) return;
				handoff = modalOwner;
				closed = true;
				if (state.overlayOwner === overlayOwner) {
					state.overlayOpen = false;
					state.bridge.resolveConfirmation(false);
					state.bridge.refresh();
				}
				complete(privatePreparation);
			};
			const cancelHandoff = (owner: object) => { if (handoff === owner) abandon(); };
			state.closeOverlay = closeOverlay;
			state.waitOverlayClosed = waitOverlayClosed;
			state.cancelOverlayHandoff = cancelHandoff;
			try {
				const custom = ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => {
						const inert = (): Component & Focusable => ({ focused: false, render: () => [], handleInput() {}, invalidate() {} });
						if (!admitted() || factoryUsed) { abandon(); return inert(); }
						factoryUsed = true;
						finishOverlay = () => done(undefined);
						if (closed) return inert();
						terminalColumns = () => tui.terminal.columns;
						state.themeProvider = () => theme;
						const sessionId = ctx.sessionManager.getSessionId();
						component = attachOverlayBridge(
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
						overlayOptions: () => {
							const columns = terminalColumns?.();
							return {
								// Keep a comfortable reading width instead of stretching
								// paragraphs across an ultrawide terminal. Pi still clamps
								// the minimum to the available space on small terminals.
								width: Number.isFinite(columns) && columns! > 0
									? Math.min(118, Math.max(68, Math.floor(columns! * 0.8))) : "68%",
								minWidth: 68,
								maxHeight: "82%",
								anchor: "center",
							};
						},
						onHandle: mounted => {
							if (!admitted() || handle) {
								try { mounted.setHidden(true); } finally { abandon(); }
								return;
							}
							handle = mounted;
							complete();
						},
					},
				);
				// Forced replacement can abandon the public promise indefinitely.
				// Our request and handoff wait still settle; late mounts remain inert.
				await Promise.race([custom, overlayClosed]);
			} finally { abandon(); }
		},
	});

	const configureModel = async (args: string, ctx: ExtensionCommandContext, embedded = false): Promise<void> => {
		const owner = state.queuedMessages, interaction = state.overlayOwner, thread = state.bridge.getThreadGeneration();
		const requestToken = {};
		let accepted = false;
		const superseded = () => accepted && (embeddedModelRequest !== requestToken || state.bridge.getThreadGeneration() !== thread);
		const notify = (message: string, type?: "info" | "warning" | "error") => {
			if (state.queuedMessages !== owner || (embedded && (superseded() || state.overlayOwner !== interaction || !state.overlayOpen))) return;
			if (embedded) state.bridge.notify(message, type); else ctx.ui.notify(message, type);
		};
		const assertOwner = () => {
			if (state.queuedMessages !== owner || isArchiveSecretPromptActive() || state.memoryEditorOwner || (embedded && (superseded() || state.overlayOwner !== interaction || !state.overlayOpen))) {
				throw new Error("/jarvis configuration owner changed; submit again in the current session.");
			}
		};
		updateContextState(pi, state, ctx);
		if (isArchiveSecretPromptActive() || state.memoryEditorOwner) {
			notify("Finish the private archive password/exit verification or memory editor before configuring Jarvis.", "warning");
			return;
		}

		let parsedCommand: ParsedJarvisModelCommand;
		try {
			parsedCommand = parseJarvisModelCommand(args);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}

		const { request, scope, clearScope } = parsedCommand;
		const scopeLabel = formatJarvisModelSelectionScope(scope);
		if ((request || (ctx.mode === "tui" && !embedded)) && isJarvisBusy(state)) {
			notify("/jarvis is busy. Wait or use /jarvis stop, then retry model/thinking selection.", "warning");
			return;
		}
		if (embedded) { embeddedModelRequest = requestToken; accepted = true; }

		const loadModels = async (): Promise<readonly Model<any>[]> => {
			try {
				return await getAvailableJarvisModels(ctx.modelRegistry);
			} catch (error) {
				notify(`Failed to refresh /jarvis models: ${error instanceof Error ? error.message : String(error)}`, "error");
				return [];
			}
		};
		const selectModelFromMenu = async (models: readonly Model<any>[], initialSearchInput?: string): Promise<Model<any> | undefined> => {
			if (embedded) {
				notify("Select an exact physical provider/model inside Jarvis.", "warning");
				return undefined;
			}
			if (state.queuedMessages !== owner) return undefined;
			models = models.filter((model) => model.api !== "pi-virtual");
			if (models.length === 0) {
				notify("No /jarvis models are currently available from the main model registry.", "warning");
				return undefined;
			}
			if (isArchiveSecretPromptActive() || state.modelPickerOpen || state.memoryReviewOpen || state.memoryEditorOwner || state.overlayOpen) {
				notify("Finish the current private archive prompt or Jarvis dialog before opening the model picker.", "warning");
				return undefined;
			}
			state.modelPickerOpen = true;
			try {
				return await ctx.ui.custom<Model<any> | undefined>(
					(tui, theme, keybindings, done) => new JarvisModelPicker(
						tui, theme, keybindings, models, (model) => done(model), () => done(undefined), initialSearchInput,
					),
				);
			} finally { state.modelPickerOpen = false; }
		};

		const rollbackSelection = async (
			previousSelection: JarvisModelSelection,
			previousSource: JarvisModelSelectionSource,
		): Promise<void> => {
			await applyJarvisModelSelection(state, previousSelection);
			if (state.queuedMessages !== owner) return;
			state.jarvisModelSelectionSource = previousSource;
		};

		const persistSelection = async (selection: JarvisModelSelection): Promise<void> => withIdleConfiguration(state, async (guard) => {
			assertOwner();
			const previousSelection = state.jarvisModelSelection;
			const previousSource = state.jarvisModelSelectionSource;
			const stored = toStoredJarvisModelSelection(selection);
			const resolved = resolveJarvisModelSelectionFromSettings(
				scope === "project" ? stored : loadJarvisModelSelectionForClear(ctx.cwd, "project", ctx),
				scope === "global" ? stored : loadJarvisModelSelectionForClear(ctx.cwd, "global", ctx),
				ctx.modelRegistry,
			);
			assertOwner();
			await applyJarvisModelSelection(state, resolved.selection);
			try {
				assertOwner();
				guard();
				saveJarvisModelSelectionSetting(ctx.cwd, scope, stored);
				state.jarvisModelSelectionSource = resolved.source;
			} catch (error) {
				if (state.queuedMessages === owner) await rollbackSelection(previousSelection, previousSource);
				throw error;
			}
		});

		const clearScopedSelection = async (): Promise<ResolvedJarvisModelSelection> => withIdleConfiguration(state, async (guard) => {
			assertOwner();
			const previousSelection = state.jarvisModelSelection;
			const previousSource = state.jarvisModelSelectionSource;
			const projectSelection = scope === "project" ? undefined : loadJarvisModelSelectionForClear(ctx.cwd, "project", ctx);
			const globalSelection = scope === "global" ? undefined : loadJarvisModelSelectionForClear(ctx.cwd, "global", ctx);
			const resolvedSelection = resolveJarvisModelSelectionFromSettings(projectSelection, globalSelection, ctx.modelRegistry);
			assertOwner();
			await applyJarvisModelSelection(state, resolvedSelection.selection);
			try {
				assertOwner();
				guard();
				clearJarvisModelSelectionSetting(ctx.cwd, scope);
				state.jarvisModelSelectionSource = resolvedSelection.source;
				return resolvedSelection;
			} catch (error) {
				if (state.queuedMessages === owner) await rollbackSelection(previousSelection, previousSource);
				throw error;
			}
		});

		const pinSelectedModel = async (model: Model<any>): Promise<void> => {
			try {
				await persistSelection({ mode: "pinned", model });
			} catch (error) {
				notify(
					`Failed to pin /jarvis to ${formatModelLabel(model)} ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			notify(
				`Saved /jarvis model ${formatModelLabel(model)} ${scopeLabel}. /jarvis is ${describeJarvisModelSelection(state)}. The main model is still ${formatModelLabel(state.model)}.`,
				"info",
			);
		};

		if (clearScope) {
			let resolvedSelection: ResolvedJarvisModelSelection;
			try {
				resolvedSelection = await clearScopedSelection();
			} catch (error) {
				notify(
					`Failed to clear the /jarvis model setting ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			if (resolvedSelection.unavailable) {
				notify(
					`Configured /jarvis model ${resolvedSelection.unavailable.modelReference} from the ${resolvedSelection.unavailable.scope} setting is unavailable. Falling back to follow-main.`,
					"warning",
				);
			}

			notify(`Cleared the /jarvis model setting ${scopeLabel}. /jarvis is now ${describeJarvisModelSelection(state)}.`, "info");
			return;
		}

		if (request.toLowerCase() === "follow-main") {
			try {
				await persistSelection({ mode: "follow-main" });
			} catch (error) {
				notify(
					`Failed to switch /jarvis back to follow-main ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			notify(`Saved follow-main ${scopeLabel}. /jarvis is ${describeJarvisModelSelection(state)}.`, "info");
			return;
		}

		if (!request) {
			if (ctx.mode !== "tui") {
				notify(
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
		if (state.queuedMessages !== owner || (embedded && !state.overlayOpen)) return;
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
			notify(errorMessage, "error");
			return;
		}

		const selectedModel = await selectModelFromMenu(availableModels, request);
		if (!selectedModel) {
			return;
		}
		await pinSelectedModel(selectedModel);
	};

	pi.registerCommand("jarvis-model", {
		description: "Set the model used by /jarvis without changing the main agent model",
		handler: configureModel,
	});

	const configureThinking = async (args: string, ctx: ExtensionCommandContext, embedded = false): Promise<void> => {
		const owner = state.queuedMessages, interaction = state.overlayOwner, thread = state.bridge.getThreadGeneration();
		const requestToken = {};
		let accepted = false;
		const superseded = () => accepted && (embeddedThinkingRequest !== requestToken || state.bridge.getThreadGeneration() !== thread);
		const notify = (message: string, type?: "info" | "warning" | "error") => {
			if (state.queuedMessages !== owner || (embedded && (superseded() || state.overlayOwner !== interaction || !state.overlayOpen))) return;
			if (embedded) state.bridge.notify(message, type); else ctx.ui.notify(message, type);
		};
		const assertOwner = () => {
			if (state.queuedMessages !== owner || isArchiveSecretPromptActive() || state.memoryEditorOwner || (embedded && (superseded() || state.overlayOwner !== interaction || !state.overlayOpen))) {
				throw new Error("/jarvis configuration owner changed; submit again in the current session.");
			}
		};
		updateContextState(pi, state, ctx);
		if (isArchiveSecretPromptActive() || state.memoryEditorOwner) {
			notify("Finish the private archive password/exit verification or memory editor before configuring Jarvis.", "warning");
			return;
		}

		let parsedCommand: ParsedJarvisThinkingCommand;
		try {
			parsedCommand = parseJarvisThinkingCommand(args);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}

		const { request, scope, clearScope } = parsedCommand;
		const scopeLabel = formatJarvisModelSelectionScope(scope);
		if (request && isJarvisBusy(state)) {
			notify("/jarvis is busy. Wait or use /jarvis stop, then retry model/thinking selection.", "warning");
			return;
		}
		if (embedded) { embeddedThinkingRequest = requestToken; accepted = true; }

		const rollbackSelection = async (
			previousSelection: JarvisThinkingSelection,
			previousSource: JarvisThinkingSelectionSource,
		): Promise<void> => {
			await applyJarvisThinkingSelection(state, previousSelection);
			if (state.queuedMessages !== owner) return;
			state.jarvisThinkingSelectionSource = previousSource;
		};

		const persistSelection = async (selection: JarvisThinkingSelection): Promise<void> => withIdleConfiguration(state, async (guard) => {
			assertOwner();
			const previousSelection = state.jarvisThinkingSelection;
			const previousSource = state.jarvisThinkingSelectionSource;
			const resolved = resolveJarvisThinkingSelectionFromSettings(
				scope === "project" ? selection : loadJarvisThinkingSelectionForClear(ctx.cwd, "project", ctx),
				scope === "global" ? selection : loadJarvisThinkingSelectionForClear(ctx.cwd, "global", ctx),
			);
			assertOwner();
			await applyJarvisThinkingSelection(state, resolved.selection);
			try {
				assertOwner();
				guard();
				saveJarvisThinkingSelectionSetting(ctx.cwd, scope, selection);
				state.jarvisThinkingSelectionSource = resolved.source;
			} catch (error) {
				if (state.queuedMessages === owner) await rollbackSelection(previousSelection, previousSource);
				throw error;
			}
		});

		const clearScopedSelection = async (): Promise<ResolvedJarvisThinkingSelection> => withIdleConfiguration(state, async (guard) => {
			assertOwner();
			const previousSelection = state.jarvisThinkingSelection;
			const previousSource = state.jarvisThinkingSelectionSource;
			const projectSelection = scope === "project" ? undefined : loadJarvisThinkingSelectionForClear(ctx.cwd, "project", ctx);
			const globalSelection = scope === "global" ? undefined : loadJarvisThinkingSelectionForClear(ctx.cwd, "global", ctx);
			const resolvedSelection = resolveJarvisThinkingSelectionFromSettings(projectSelection, globalSelection);
			assertOwner();
			await applyJarvisThinkingSelection(state, resolvedSelection.selection);
			try {
				assertOwner();
				guard();
				clearJarvisThinkingSelectionSetting(ctx.cwd, scope);
				state.jarvisThinkingSelectionSource = resolvedSelection.source;
				return resolvedSelection;
			} catch (error) {
				if (state.queuedMessages === owner) await rollbackSelection(previousSelection, previousSource);
				throw error;
			}
		});

		if (clearScope) {
			try {
				await clearScopedSelection();
			} catch (error) {
				notify(
					`Failed to clear the /jarvis thinking setting ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			notify(`Cleared the /jarvis thinking setting ${scopeLabel}. /jarvis is now ${describeJarvisThinkingSelection(state)}.`, "info");
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
			notify(
				`/jarvis is ${describeJarvisThinkingSelection(state)}. Use /jarvis-thinking [--project|--global] clear, auto, follow-main, off, minimal, low, medium, high, xhigh, or max.`,
				request ? "error" : "info",
			);
			return;
		}

		try {
			await persistSelection(selection);
		} catch (error) {
			notify(
				`Failed to set /jarvis thinking ${scopeLabel}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}

		notify(`Set /jarvis thinking to ${formatJarvisThinkingSelection(selection)} ${scopeLabel}. Effective /jarvis thinking is ${state.runtime?.getThinkingLevel?.() ?? getDesiredJarvisThinkingLevel(state) ?? "off"}.`, "info");
	};

	pi.registerCommand("jarvis-thinking", {
		description: "Set the thinking level used by /jarvis without changing the main agent thinking level",
		handler: configureThinking,
	});

	pi.registerCommand("jarvis-archive", {
		description: "Optional full-session archive: controls, indexed search, explicit import and deletion (help for syntax)",
		handler: async (args, ctx) => { await dispatchArchiveCommand(state, args, ctx, false); },
	});

	pi.registerCommand("jarvis-memory", {
		description: "Shared main Pi/Jarvis memory: editor, status, on/off, capture/recall, search, remember, edit, forget (help for syntax)",
		handler: async (args, ctx) => { await dispatchMemoryCommand(state, args, ctx, false); },
	});

	const beforeMainNavigation = (_event: unknown, ctx: ExtensionContext) => {
		if (isArchiveSecretPromptActive()) {
			// Permission/work cancellation must not restore an editor into a paste
			// tail. Keep the private cancellation sink and reject this transition.
			revokeArchiveSecretPrompt();
			ctx.ui.notify("Archive password entry cancelled. Complete its private exit verification, then retry session navigation.", "warning");
			return { cancel: true as const };
		}
		if (state.memoryEditorOwner) {
			if (state.memoryEditorDirty?.()) {
				ctx.ui.notify("Save or explicitly discard the memory editor draft before session navigation.", "warning");
				return { cancel: true as const };
			}
			invalidateMemoryEditor(state, false);
		}
		state.runtime?.flushArchive?.();
		state.archive.cancelImports();
	};
	pi.on("session_before_switch", beforeMainNavigation);
	pi.on("session_before_fork", beforeMainNavigation);
	pi.on("session_before_tree", beforeMainNavigation);
	pi.on("session_start", async (_event, ctx) => {
		invalidateMemoryEditor(state);
		clearMainStatus(state);
		state.runtime?.flushArchive?.();
		state.archive.cancelImports();
		state.closeOverlay?.(true);
		try { state.runtime?.dispose(); }
		finally { state.bootGeneration += 1; }
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.stopPromise = undefined;
		state.configuring = undefined;
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
		await state.archive.start(ctx);
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
		invalidateMemoryEditor(state);
		const sessionRef = readJarvisSessionRef(ctx.sessionManager.getBranch());
		if (sessionRef?.file !== state.sessionRef?.file) {
			state.archive.cancelImports();
			state.runtime?.flushArchive?.();
			state.closeOverlay?.(true);
			try { state.runtime?.dispose(); }
			finally { state.bootGeneration += 1; }
			state.runtime = undefined;
			state.bootPromise = undefined;
			state.flushPromise = undefined;
			state.stopPromise = undefined;
			state.configuring = undefined;
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
		// Forced reload/exit may already have replaced/stopped host UI. Wipe and
		// revoke without a stale done() restoring an editor; no tail quarantine
		// across host-forced replacement/process exit is claimed.
		abandonArchiveSecretPrompt();
		invalidateMemoryEditor(state);
		state.runtime?.flushArchive?.();
		state.mainArchiveSnapshot?.();
		state.closeOverlay?.(true);
		// Dispose performs a final side snapshot too. Its lifetime must end
		// before the supplemental boot guard changes, or a retiring side lane
		// would revoke the shared process lease as apparent trust loss.
		try { state.runtime?.dispose(); }
		finally { state.bootGeneration += 1; }
		state.runtime = undefined;
		state.bootPromise = undefined;
		state.flushPromise = undefined;
		state.stopPromise = undefined;
		state.configuring = undefined;
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
		clearMainStatus(state);
	});

	createMemoryExtensionFactory(state.memory, "main", {
		confirmForget: async (review, signal, ctx) => {
			// A background main turn must not replace the private password sink.
			if (!ctx.hasUI || signal?.aborted || isArchiveSecretPromptActive() || state.memoryReviewOpen || state.modelPickerOpen || state.memoryEditorOwner || state.overlayOpen) return false;
			state.memoryReviewOpen = true;
			try { return await ctx.ui.confirm("Forget this shared memory?", review, { signal }); }
			finally { state.memoryReviewOpen = false; }
		},
	})(pi);
	createArchiveExtensionFactory(state.archive, "main", {
		registerFinalSnapshot: snapshot => { state.mainArchiveSnapshot = snapshot; },
	})(pi);
	// Close shared storage only after the archive lane's final snapshot/disposal.
	pi.on("session_shutdown", (event) => { state.archive.close(event.reason); });
}

function updateContextState(pi: ExtensionAPI, state: MainState, ctx: ExtensionContext): void {
	state.model = ctx.model;
	state.thinkingLevel = pi.getThinkingLevel();
	state.systemPrompt = ctx.getSystemPrompt();
	state.themeProvider = () => ctx.ui.theme;
	bindMainStatus(state, ctx);
	state.trustProvider = () => ctx.isProjectTrusted();
	checkTransientTrust(state);
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
	// Resolve before runtime/native tool synchronization can refresh/reenter.
	state.bridge.resolveConfirmation(false);
	state.runtime?.setToolAccessEnabled(false);
	state.bridge.refresh();
}


/** Trust observations are fail-closed and revoke grants, never silently revive. */
function checkTransientTrust(state: MainState): boolean {
	let trusted = false;
	try { trusted = state.trustProvider?.() === true; } catch { /* Throwing is denial. */ }
	if (!trusted && (state.allowSideTools || state.allowFollowUpToMain || state.allowSteerToMain || state.bridge.hasPendingConfirmation())) {
		resetTransientAccessControls(state);
	}
	return trusted;
}

const MAIN_STATUS_KEY = "jarvis-background";
function clearMainStatus(state: MainState): void {
	try { state.statusContext?.ui.setStatus?.(MAIN_STATUS_KEY, undefined); } catch { /* Retired UI may be unavailable. */ }
	state.statusContext = undefined;
}
function bindMainStatus(state: MainState, ctx: ExtensionContext): void {
	if (state.statusContext && state.statusContext.ui !== ctx.ui) clearMainStatus(state);
	state.statusContext = ctx;
}
function describeJarvisActivity(state: MainState): string {
	const activity = state.stopPromise ? "stopping" : state.bootPromise ? "starting" : state.flushPromise || state.runtime?.isStreaming() ? "working" : "idle";
	return `Jarvis ${state.overlayOpen ? "open" : "closed"} · ${activity} · ${state.queuedMessages.length} queued · Repo tools ${state.allowSideTools ? "ON" : "off"} · Note main ${state.allowFollowUpToMain ? "ON" : "off"} · Redirect ${state.allowSteerToMain ? "ON (foreground confirm)" : "off"}`;
}
function refreshMainStatus(state: MainState): void {
	if (!state.statusContext) return;
	checkTransientTrust(state);
	const visible = state.overlayOpen || state.bootPromise || state.flushPromise || state.stopPromise || state.runtime?.isStreaming() || state.allowSideTools || state.allowFollowUpToMain || state.allowSteerToMain;
	try {
		if (typeof state.statusContext.ui.setStatus === "function") {
			const activity = state.stopPromise ? "stopping" : state.bootPromise ? "starting" : state.flushPromise || state.runtime?.isStreaming() ? "working" : "idle";
			// Prioritize all three grants before optional controls on an 80-column footer.
			const footer = `Jarvis ${state.overlayOpen ? "open" : "bg"} ${activity} · q${state.queuedMessages.length} · repo ${state.allowSideTools ? "ON" : "off"} · note ${state.allowFollowUpToMain ? "ON" : "off"} · redirect ${state.allowSteerToMain ? "ASK" : "off"} · /jarvis stop`;
			state.statusContext.ui.setStatus(MAIN_STATUS_KEY, visible ? footer : undefined);
		}
	} catch { /* Footer presentation must not interfere with running work. */ }
}

function isJarvisBusy(state: MainState): boolean {
	return Boolean(state.bootPromise || state.flushPromise || state.stopPromise || state.configuring || state.runtime?.isStreaming() || state.queuedMessages.length);
}
async function withIdleConfiguration<T>(state: MainState, operation: (guard: () => void) => Promise<T>): Promise<T> {
	if (isJarvisBusy(state)) throw new Error("/jarvis is busy. Wait or use /jarvis stop, then retry model/thinking selection.");
	const owner = state.queuedMessages, token = {};
	state.configuring = token;
	const guard = () => {
		if (state.queuedMessages !== owner || state.configuring !== token) throw new Error("/jarvis configuration owner changed.");
		if (state.bootPromise || state.flushPromise || state.stopPromise || state.runtime?.isStreaming()) throw new Error("/jarvis became busy. Stop/wait, then retry configuration.");
	};
	try { guard(); return await operation(guard); }
	finally { if (state.configuring === token) { state.configuring = undefined; state.bridge.refresh(); } }
}

type LocalControl = "status" | "stop" | "access off";
function parseLocalControl(text: string, allowBare = false): LocalControl | undefined {
	const input = text.trim().replace(/\s+/g, " ").toLowerCase();
	const match = /^\/(?:jarvis )?(status|stop|access off)$/.exec(input);
	if (match) return match[1] as LocalControl;
	return allowBare && ["status", "stop", "access off"].includes(input) ? input as LocalControl : undefined;
}
async function dispatchLocalControl(state: MainState, control: LocalControl, ctx: ExtensionContext, overlay: boolean): Promise<void> {
	bindMainStatus(state, ctx);
	state.trustProvider = () => ctx.isProjectTrusted();
	checkTransientTrust(state);
	const owner = state.queuedMessages;
	let text: string;
	try {
		if (control === "stop") {
			await cancelJarvisWork(state);
			text = "Stopped /jarvis work; waiting inputs discarded. Already-started external effects cannot be rolled back.";
		} else if (control === "access off") {
			resetTransientAccessControls(state);
			text = "Jarvis Repo tools, Note main and Redirect access off; pending confirmations cancelled. Already-started external effects cannot be rolled back.";
		} else {
			text = `${describeJarvisActivity(state)}. Close/reopen preserves work and access for this owner. /jarvis stop cancels work; /jarvis access off revokes the three grants. Background work ends on owner replacement/reload/quit, not a daemon.`;
		}
		if (state.queuedMessages !== owner) return;
		if (overlay) state.bridge.notify(text, "info");
		else if (ctx.hasUI) ctx.ui.notify(text, "info");
		else process.stderr.write(`${text}\n`);
	} catch (error) {
		if (state.queuedMessages !== owner) return;
		const message = `Failed to stop /jarvis: ${error instanceof Error ? error.message : String(error)}. Waiting inputs were discarded; nothing was retried.`;
		if (overlay) state.bridge.notify(message, "error");
		else if (ctx.hasUI) ctx.ui.notify(message, "error");
		else process.stderr.write(`${message}\n`);
	}
	state.bridge.refresh();
}
function cancelJarvisWork(state: MainState): Promise<void> {
	if (state.stopPromise) return state.stopPromise;
	const owner = state.queuedMessages, boot = state.bootPromise, flush = state.flushPromise;
	state.workGeneration += 1;
	owner.length = 0;
	let stopping: Promise<void>;
	stopping = Promise.resolve().then(async () => {
		const first = state.runtime;
		let failure: unknown;
		try { await first?.cancelWork(); } catch (error) { failure = error; }
		// Retain a booting runtime for reuse, but never send its cancelled input.
		try { await boot; } catch { /* Startup errors are already reported by its owner. */ }
		try { await flush; } catch (error) { failure ??= error; }
		if (state.queuedMessages === owner && state.runtime !== first) {
			try { await state.runtime?.cancelWork(); } catch (error) { failure ??= error; }
		}
		if (failure) throw failure;
	}).finally(() => {
		if (state.stopPromise === stopping) { state.stopPromise = undefined; state.bridge.refresh(); }
	});
	state.stopPromise = stopping;
	state.bridge.resolveConfirmation(false);
	state.bridge.refresh();
	return stopping;
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
	return `thinking ${formatJarvisThinkingSelection(state.jarvisThinkingSelection)} (effective ${state.runtime?.getThinkingLevel?.() ?? getDesiredJarvisThinkingLevel(state) ?? "off"}; ${sourceLabel})`;
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
	return modelRegistry.getAvailable().filter((model) => model.api !== "pi-virtual");
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
	const owner = state.queuedMessages;
	const previousSelection = state.jarvisModelSelection;
	state.jarvisModelSelection = selection;
	try {
		await syncRuntimeModelSelection(state);
		if (state.queuedMessages !== owner) throw new Error("/jarvis configuration owner changed.");
		enforceCompatibilityGuard(state);
	} catch (error) {
		if (state.queuedMessages !== owner) throw error;
		state.jarvisModelSelection = previousSelection;
		try {
			await syncRuntimeModelSelection(state);
			if (state.queuedMessages === owner) enforceCompatibilityGuard(state);
		} catch {
			// Keep the original sync failure; rollback is best-effort only.
		}
		throw error;
	}
}

async function applyJarvisThinkingSelection(state: MainState, selection: JarvisThinkingSelection): Promise<void> {
	const owner = state.queuedMessages;
	const previousSelection = state.jarvisThinkingSelection;
	state.jarvisThinkingSelection = selection;
	try {
		await syncRuntimeModelSelection(state);
		if (state.queuedMessages !== owner) throw new Error("/jarvis configuration owner changed.");
	} catch (error) {
		if (state.queuedMessages !== owner) throw error;
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
		invalidateMemoryEditor(state, false);
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

	invalidateMemoryEditor(state, false);
	state.archive.cancelImports();
	state.runtime?.flushArchive?.();
	let generation: number;
	try { state.runtime?.dispose(); }
	finally { generation = ++state.bootGeneration; }
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

async function dispatchMemoryCommand(state: MainState, args: string, ctx: ExtensionContext, overlay: boolean): Promise<void> {
	if (/^editor(?:\s|$)/.test(args.trim())) {
		if (args.trim() !== "editor") {
			ctx.ui.notify("Use /jarvis-memory editor without arguments; choose search and scope inside the editor.", "warning");
			return;
		}
		await openMemoryEditor(state, ctx);
		return;
	}
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

function createOverlayView(
	pi: ExtensionAPI, state: MainState, ctx: ExtensionCommandContext,
	configureModel: (request: string, ctx: ExtensionCommandContext, embedded?: boolean) => Promise<void>,
	configureThinking: (request: string, ctx: ExtensionCommandContext, embedded?: boolean) => Promise<void>,
): JarvisOverlayView {
	const queue = state.queuedMessages, interaction = state.overlayOwner;
	const ownsPresentation = () => state.queuedMessages === queue && state.overlayOwner === interaction && state.overlayOpen && !state.memoryEditorOwner && !isArchiveSecretPromptActive();
	const syncToolAccess = () => {
		state.runtime?.setToolAccessEnabled(state.allowSideTools);
		state.bridge.refresh();
	};

	return {
		isReady: () => state.runtime?.isReady() ?? false,
		isStreaming: () => state.runtime?.isStreaming() ?? false,
		getQueuedMessageCount: () => state.queuedMessages === queue ? queue.length : 0,
		getIsProcessing: () => state.queuedMessages === queue && Boolean(state.bootPromise || state.flushPromise || state.stopPromise),
		getModelLabel: () => state.runtime?.getModelLabel() ?? formatModelLabel(getDesiredJarvisModel(state)),
		getModelModeLabel: () => getJarvisModelModeLabel(state.jarvisModelSelection),
		getThinkingLabel: () => describeJarvisThinkingSelection(state),
		getModelChoices: async () => {
			const models = await getAvailableJarvisModels(ctx.modelRegistry);
			if (!ownsPresentation()) return [];
			return [
				{ value: "follow-main", label: "Follow main model" },
				{ value: "clear", label: "Clear project override" },
				...models.map(model => ({ value: formatModelLabel(model), label: formatModelLabel(model) })),
			];
		},
		configureModel: async request => { if (ownsPresentation()) await configureModel(request, ctx, true); },
		configureThinking: async request => { if (ownsPresentation()) await configureThinking(request, ctx, true); },
		cancelWork: async () => { if (state.queuedMessages === queue) await dispatchLocalControl(state, "stop", ctx, true); },
		getMainStatusLabel: () => state.mainContext.summary.mainStatus,
		getMainModelLabel: () => state.mainContext.summary.mainModelLabel,
		getMainFocusLabel: () => state.mainContext.summary.workState.currentAction,
		getMainDeltaLabel: () => formatMainContextDeltaLabel(state.lastJarvisSeenMainContext, state.mainContext),
		getRepoToolsDetailLabel: () => state.runtime?.getRepoToolsDetailLabel() ?? (state.allowSideTools ? "local tools only" : "repo tools off"),
		isToolAccessEnabled: () => state.allowSideTools,
		isFollowUpToMainEnabled: () => state.allowFollowUpToMain,
		isSteerToMainEnabled: () => state.allowSteerToMain,
		toggleToolAccess: () => {
			if (!ownsPresentation() || !checkTransientTrust(state)) return;
			state.allowSideTools = !state.allowSideTools;
			syncToolAccess();
		},
		toggleFollowUpToMain: () => {
			if (!ownsPresentation() || !checkTransientTrust(state)) return;
			if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
				state.bridge.notify("Follow-up is not supported by the current /jarvis model.", "warning");
				return;
			}
			state.allowFollowUpToMain = !state.allowFollowUpToMain;
			syncToolAccess();
		},
		toggleSteerToMain: () => {
			if (!ownsPresentation() || !checkTransientTrust(state)) return;
			if (!isModelBridgeCompatible(getDesiredJarvisModel(state))) {
				state.bridge.notify("Steer is not supported by the current /jarvis model.", "warning");
				return;
			}
			state.allowSteerToMain = !state.allowSteerToMain;
			syncToolAccess();
		},
		getDisplayEntries: () => getOverlayEntries(state),
		sendMessage: async (text: string) => {
			if (state.queuedMessages !== queue || isArchiveSecretPromptActive()) return;
			const localControl = parseLocalControl(text);
			if (localControl) { await dispatchLocalControl(state, localControl, ctx, true); return; }
			const archiveCommand = parseArchiveCommand(text);
			if (archiveCommand !== undefined) {
				await dispatchArchiveCommand(state, archiveCommand, ctx, true);
				return;
			}
			// Memory controls must work immediately, even while a side turn is busy.
			const memoryCommand = parseMemoryCommand(text);
			if (memoryCommand !== undefined) {
				await dispatchMemoryCommand(state, memoryCommand, ctx, true);
				return;
			}
			if (state.queuedMessages !== queue) return;
			if (state.stopPromise || state.configuring) {
				state.bridge.notify("Wait for /jarvis stop/configuration to finish, then submit again. Input was not queued.", "warning");
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
	const workGeneration = state.workGeneration;
	const isCurrent = () => state.queuedMessages === queue && state.workGeneration === workGeneration;
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
			toolAccessProvider: () => isCurrentBoot() && checkTransientTrust(state) && state.allowSideTools,
			communicationPermissionsProvider: () => {
				const permitted = isCurrentBoot() && checkTransientTrust(state);
				return { allowFollowUpToMain: permitted && state.allowFollowUpToMain, allowSteerToMain: permitted && state.allowSteerToMain };
			},
			sendFollowUpToMain: (message: string) => {
				if (!isCurrentBoot() || !checkTransientTrust(state) || !state.allowFollowUpToMain) throw new Error("/jarvis follow-up permission expired.");
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
				if (!isCurrentBoot() || !checkTransientTrust(state) || !state.overlayOpen || state.memoryEditorOwner || isArchiveSecretPromptActive() || !state.allowSteerToMain) throw new Error("/jarvis redirect permission expired.");
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
