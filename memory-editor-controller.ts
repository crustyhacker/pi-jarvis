import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, OverlayHandle } from "@earendil-works/pi-tui";
import { isArchiveSecretPromptActive } from "./archive-secret-input.js";
import { MemoryEditorOverlay } from "./memory-editor.js";
import type { MemoryContext } from "./memory-service.js";
import type { MemoryEditorBackend, MemoryEditorService } from "./memory-editor-types.js";

/** Only human service methods are exposed. Cancellation is NOT a trust observation. */
export function createMemoryEditorBackend(service: MemoryEditorService, ctx: MemoryContext, check: () => void): MemoryEditorBackend {
	const ensureActive = () => {
		check();
		const policy = service.editorAccess(ctx);
		check();
		if (!policy.enabled) throw new Error("Shared memory access is paused. Use /jarvis-memory status.");
	};
	const operation = <T>(run: () => T): T => {
		ensureActive();
		const result = run();
		ensureActive();
		return result;
	};
	return {
		projectLabel: ctx.cwd,
		ensureActive,
		list: query => operation(() => service.editorList(query, ctx, check)),
		get: (id, scope) => operation(() => service.editorGet(id, ctx, scope, check)),
		create: draft => operation(() => service.editorCreate(draft, ctx, check)),
		update: (expected, draft, scope) => operation(() => service.editorUpdate(expected, draft, ctx, scope, check)),
		forget: (expected, scope) => operation(() => service.editorForget(expected, ctx, scope, check)),
		// DATA only. The UI flags an explicit refresh, never overwrites a draft.
		onChange: listener => service.onNotesChange(() => {
			try { check(); } catch { return; }
			listener();
		}),
	};
}

export interface MemoryEditorHostState {
	memory: MemoryEditorService & { onChange(listener: () => void): () => void };
	queuedMessages: string[];
	bootGeneration: number;
	bridge: { getThreadGeneration(): number };
	closeOverlay?: (forced?: boolean, handoff?: object) => void;
	waitOverlayClosed?: () => Promise<void>;
	cancelOverlayHandoff?: (owner: object) => void;
	modelPickerOpen?: boolean;
	memoryReviewOpen?: boolean;
	memoryEditorOwner?: object;
	closeMemoryEditor?: (forced?: boolean) => void;
	memoryEditorDirty?: () => boolean;
}

/** Forced host replacement must wipe without restoring an obsolete custom screen. */
export function invalidateMemoryEditor(state: MemoryEditorHostState, forced = true): void {
	state.closeMemoryEditor?.(forced);
}

const inert = (): Component & Focusable => ({
	focused: false, render: () => [], handleInput() {}, invalidate() {},
});

/** Reservation occurs in the synchronous prefix, BEFORE overlay close or any yield. */
export async function openMemoryEditor(state: MemoryEditorHostState, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The curated-memory editor requires Pi's interactive terminal UI.", "warning");
		return;
	}
	if (isArchiveSecretPromptActive() || state.modelPickerOpen || state.memoryReviewOpen || state.memoryEditorOwner) {
		ctx.ui.notify("Finish the private archive prompt or current Jarvis picker/memory dialog before opening the memory editor.", "warning");
		return;
	}
	const owner = {}, queue = state.queuedMessages, boot = state.bootGeneration;
	const thread = state.bridge.getThreadGeneration(), manager = ctx.sessionManager, sessionId = manager.getSessionId();
	const lifetime = new AbortController();
	let resolveRetired!: () => void;
	const retired = new Promise<void>(resolve => { resolveRetired = resolve; });
	const cancelHandoff = state.cancelOverlayHandoff;
	let ended = false, customRequested = false, factoryUsed = false, observing = false;
	let component: MemoryEditorOverlay | undefined;
	let finish: (() => void) | undefined;
	let terminalColumns: (() => number) | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let offPolicy: (() => void) | undefined;
	const signal = ctx.signal;
	state.memoryEditorOwner = owner;
	const owns = () => !ended && state.memoryEditorOwner === owner;
	const check = () => {
		if (!owns() || lifetime.signal.aborted || signal?.aborted || state.queuedMessages !== queue ||
			state.bootGeneration !== boot || state.bridge.getThreadGeneration() !== thread ||
			ctx.sessionManager !== manager || manager.getSessionId() !== sessionId || isArchiveSecretPromptActive()) {
			throw new Error("Memory editor owner expired; reopen it in the current session.");
		}
	};
	const release = (forced = false) => {
		if (state.memoryEditorOwner !== owner) return;
		if (!ended) {
			ended = true; // Invalidate data callbacks before disposal/reentrant completion.
			lifetime.abort();
			signal?.removeEventListener("abort", pause);
			try { offPolicy?.(); } catch { /* Continue owner cleanup. */ }
			offPolicy = undefined;
			try { component?.dispose(); } catch { /* Never restore/retry a disposed UI. */ }
			component = undefined;
			state.memoryEditorDirty = undefined;
		}
		if (!forced && customRequested) {
			// Retain admission until the public lifecycle actually unmounts. A done
			// callback/host disposal can reenter before its promise has settled.
			const done = finish; finish = undefined;
			done?.();
			return;
		}
		state.memoryEditorOwner = undefined;
		state.closeMemoryEditor = undefined;
		finish = undefined;
		// A forced boundary must also retire the exact pending Jarvis handoff.
		// Neither wait depends on the abandoned public custom promise settling.
		cancelHandoff?.(owner);
		resolveRetired();
		// Hide only this exact public overlay on forced replacement. Never call
		// stale done (or OverlayHandle.hide, which owns the custom lifecycle).
		try { overlayHandle?.setHidden(true); } catch { /* Host already ended. */ }
		overlayHandle = undefined;
	};
	const pause = () => {
		if (!owns() || lifetime.signal.aborted) return;
		lifetime.abort();
		if (!customRequested) { release(true); return; }
		component?.invalidateAccess("Memory access or editor ownership expired. Close and reopen after reviewing /jarvis-memory status.");
	};
	const backend = createMemoryEditorBackend(state.memory, ctx, check);
	state.closeMemoryEditor = release;
	state.memoryEditorDirty = () => component?.isDirty() ?? false;
	try {
		signal?.addEventListener("abort", pause, { once: true });
		// Policy-only observations can pause/wipe immediately; ordinary note changes
		// never invalidate the policy generation or discard an unsaved draft.
		offPolicy = state.memory.onChange(() => {
			if (!owns() || observing || lifetime.signal.aborted) return;
			observing = true;
			try { backend.ensureActive(); } catch { pause(); }
			finally { observing = false; }
		});
		backend.ensureActive(); // Full off denies before any record read or UI close.
		const waitOverlayClosed = state.waitOverlayClosed;
		state.closeOverlay?.(false, owner); // Ordinary close: assigned work and grants survive.
		await Promise.race([waitOverlayClosed?.() ?? Promise.resolve(), retired]);
		await Promise.resolve(); // Let the host unmount Jarvis before the next custom UI.
		backend.ensureActive();
		customRequested = true;
		const custom = ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			// Even a clean deferred close must mount its own overlay first:
			// public Pi completion pops the topmost overlay, not an exact handle.
			if (state.memoryEditorOwner !== owner || factoryUsed) return inert();
			factoryUsed = true;
			terminalColumns = () => tui.terminal.columns;
			finish = () => {
				if (state.memoryEditorOwner !== owner || state.queuedMessages !== queue ||
					state.bootGeneration !== boot || state.bridge.getThreadGeneration() !== thread ||
					ctx.sessionManager !== manager || manager.getSessionId() !== sessionId ||
					isArchiveSecretPromptActive() || state.modelPickerOpen || state.memoryReviewOpen ||
					!overlayHandle || overlayHandle.isHidden() || !overlayHandle.isFocused()) {
					release(true); return;
				}
				done(undefined);
			};
			if (ended) return inert();
			try { backend.ensureActive(); }
			catch { release(); return inert(); }
			const owned = new MemoryEditorOverlay(tui, theme, keybindings, backend, () => {
				if (owns()) release();
			});
			if (!owns()) { owned.dispose(); return inert(); }
			component = owned;
			if (lifetime.signal.aborted) owned.invalidateAccess("Memory access expired. Close and reopen after reviewing status.");
			// Public component lifecycle wrapper: an external host disposal is forced,
			// so it must release our reservation without calling an obsolete done().
			return {
				get focused() { return owned.focused; },
				set focused(value: boolean) { owned.focused = value; },
				render: width => owned.render(width),
				handleInput: data => owned.handleInput(data),
				handleMouse: event => owned.handleMouse(event),
				invalidate: () => owned.invalidate(),
				dispose: () => release(true),
			};
		}, {
			overlay: true, overlayOptions: () => {
				const columns = terminalColumns?.();
				return { width: Number.isFinite(columns) && columns! > 0
					? Math.min(144, Math.max(60, Math.floor(columns! * 0.9))) : "90%", minWidth: 60, maxHeight: "90%", anchor: "center" };
			},
			onHandle: handle => {
				if (state.memoryEditorOwner !== owner || overlayHandle) { handle.setHidden(true); return; }
				overlayHandle = handle;
				if (ended) release();
			},
		});
		await Promise.race([custom, retired]);
	} catch {
		// Fixed text: never echo raw DB/settings/input/credential errors.
		if (owns()) ctx.ui.notify("Memory editor unavailable or access expired. Review /jarvis-memory status and reopen.", "warning");
	} finally {
		// A settled/failed public lifecycle is already unmounted; no stale done.
		release(true);
	}
}
