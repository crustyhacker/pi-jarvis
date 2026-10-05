import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { SharedArchiveService, type ArchiveContext } from "../archive-service.js";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	StdinBuffer, TuiMainScreen, TuiAltScreen, Editor, getKeybindings, stripTerminalSequences, type Component, type Focusable, type TUI, type Terminal,
} from "@earendil-works/pi-tui";
import { ArchiveSecretInput, promptArchiveSecret, isArchiveSecretPromptActive, revokeArchiveSecretPrompt } from "../archive-secret-input.js";

// Actual public renderers + host splitter with in-memory Terminal (never ProcessTerminal,
// stdin/stdout, GUI, provider, history, clipboard or credentials). Public custom lifecycle
// only; ordinary public Editor captures any accidental tail routing without submitting it.
const START = "\x1b[200~", END = "\x1b[201~";
const theme = { fg: (_: string, text: string) => text } as Theme;
type Owned = Component & Partial<Focusable> & { dispose?(): void };
type Factory = (host: TUI, theme: Theme, kb: KeybindingsManager, done: (value: string | undefined) => void) =>
	Owned | Promise<Owned>;

function code(component: Component): string {
	const rendered = component.render(160).map(stripTerminalSequences).join("\n");
	const match = rendered.match(/\b([A-HJ-NP-Z2-9]{4} [A-HJ-NP-Z2-9]{4} [A-HJ-NP-Z2-9]{4})\b/);
	assert.ok(match, "read only the synthetic rendered post-intent challenge, never a secret getter");
	return match[1]!.replace(/ /g, "");
}

function memoryTerminal() {
	let input: ((data: string) => void) | undefined, resize: (() => void) | undefined;
	const writes: string[] = [];
	return {
		columns: 160, rows: 24, kittyProtocolActive: false, writes,
		start(onInput: (data: string) => void, onResize: () => void) { input = onInput; resize = onResize; },
		stop() { input = resize = undefined; },
		write(data: string) { writes.push(data); },
		emit(data: string) { assert.ok(input); input(data); },
		resize() { resize?.(); },
		async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
		clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	} satisfies Terminal & { writes: string[]; emit(data: string): void; resize(): void };
}
async function hostFixture(t: TestContext, signal?: AbortSignal, mode: "regular" | "fullscreen" = "regular",
	launch?: (ctx: Pick<ExtensionContext, "mode" | "ui">) => Promise<string | undefined>) {
	const terminal = memoryTerminal();
	const host = mode === "regular" ? new TuiMainScreen(terminal) :
		new TuiAltScreen(terminal, false, undefined, { mouse: false, copyOnSelect: false });
	let component: Owned | undefined, mounted = false, closed = false, closeCalls = 0, packetCount = 0;
	const restoredEditor: string[] = [], warnings: string[] = [];
	const editor = new Editor(host, { borderColor: (text) => text, selectList: {
		selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text,
		scrollInfo: (text) => text, noMatch: (text) => text,
	} });
	editor.setText("synthetic main draft");
	const originalHandle = editor.handleInput.bind(editor);
	editor.handleInput = (packet: string) => { restoredEditor.push(packet); originalHandle(packet); };
	editor.onSubmit = () => assert.fail("no synthetic tail may submit ordinary Editor");
	host.addChild(editor); host.setFocus(editor); host.start();
	const ctx = { mode: "tui", ui: new Proxy({
		custom: (factory: Factory, options: { overlay?: boolean }) => new Promise<string | undefined>((resolve, reject) => {
			assert.equal(options.overlay, false);
			Promise.resolve(factory(host, theme, getKeybindings() as KeybindingsManager, (value) => {
				assert.equal(value, undefined, "host custom result never owns password");
				if (closed) return;
				closed = true; closeCalls++; mounted = false;
				host.clear(); host.addChild(editor); host.setFocus(editor); // Public synchronous editor restoration.
				resolve(value); component?.dispose?.();
			})).then((owned) => {
				component = owned;
				if (!closed) { mounted = true; host.clear(); host.addChild(component); host.setFocus(component); }
			}, reject);
		}),
		notify: (message: string, kind: string) => { assert.equal(kind, "warning"); warnings.push(message); },
	}, { get(target, key) {
		assert.ok(key === "custom" || key === "notify", "no ordinary UI/editor/settings/persistence APIs");
		return target[key as keyof typeof target];
	} }) } as unknown as Pick<ExtensionContext, "mode" | "ui">;
	const result = launch ? launch(ctx) : promptArchiveSecret(ctx, "Synthetic host fixture", signal);
	const buffer = new StdinBuffer();
	const forward = (packet: string) => { packetCount++; terminal.emit(packet); };
	buffer.on("paste", (content) => forward(START + content + END));
	buffer.on("data", forward);
	t.after(async () => {
		buffer.destroy(); buffer.removeAllListeners();
		component?.dispose?.(); // Forced test host teardown, NOT ordinary operation cancellation.
		await result; host.stop();
	});
	await nextTurn();
	assert.ok(component);
	if (mode === "regular") assert.ok(mounted);
	return {
		buffer, result, component: component!, ctx, host, terminal, editor, warnings,
		closeCalls: () => closeCalls, packetCount: () => packetCount,
		assertHeld() {
			assert.equal(closeCalls, 0, "unverified intent/abort cannot restore ordinary Editor");
			assert.equal(mounted, true);
			assert.equal(host.getFocusedComponent(), component);
			assert.equal(isArchiveSecretPromptActive(), true);
			assert.deepEqual(restoredEditor, [], "no delayed synthetic tail reaches ordinary Editor");
			assert.equal(editor.getText(), "synthetic main draft");
			const output = component!.render(160).map(stripTerminalSequences).join("\n");
			assert.ok(!output.includes("fixture-prefix") && !output.includes("fixture-secret-tail"));
		},
		verify() { buffer.process(code(component!)); buffer.process("\r"); },
		editorInput: () => restoredEditor.join(""),
	};
}

test("public StdinBuffer: embedded END + CR/Escape/Ctrl+C + tail cannot complete or restore editor", async (t) => {
	for (const key of ["\r", "\x1b", "\x03", "\x1b[13u", "\x1b[27u", "\x1b[99;5u"]) {
		await t.test(JSON.stringify(key), async (t) => {
			const h = await hostFixture(t);
			h.buffer.process(START + "fixture-prefix" + END + key + "fixture-secret-tail" + END);
			await delay(80); // Past the host's sequence/ESC timeouts; not a component grace period.
			h.assertHeld();
			assert.ok(h.packetCount() > 10, "regression truly exercises separate host events, not one component packet");
			h.buffer.process("\r");
			h.assertHeld(); // Tail text/unknown keys never satisfy a challenge.
		});
	}
});

test("public StdinBuffer: forged submit/cancel tails stay held across distinct turns and arbitrary delays", async (t) => {
	for (const key of ["\r", "\x1b", "\x03"]) {
		for (const wait of [0, 90, 230]) {
			await t.test(`${JSON.stringify(key)} / ${wait}ms`, async (t) => {
				const h = await hostFixture(t);
				h.buffer.process(START + "fixture-prefix" + END.slice(0, 2));
				await delay(wait);
				h.buffer.process(END.slice(2)); // Host re-wraps prefix as one paste event.
				await nextTurn();
				h.assertHeld();
				await delay(wait);
				h.buffer.process(key); // Unlike concatenated legacy ESC+text, standalone ESC becomes a cancel key.
				await delay(Math.max(80, wait));
				h.assertHeld();
				assert.ok(code(h.component), "post-intent challenge must exist even for cancel");
				h.buffer.process("fixture-secret-");
				await delay(wait);
				h.buffer.process("tail" + END.slice(0, 4));
				await nextTurn();
				h.buffer.process(END.slice(4)); // Orphan outer END is also framing, never a finish key.
				await delay(80);
				h.assertHeld();
				h.buffer.process("\r");
				h.assertHeld();
			});
		}
	}
});

test("public StdinBuffer: legitimate paste submits only after freshly typed, not pasted, code", async (t) => {
	const h = await hostFixture(t);
	const secret = "  synthetic-中🙂e\u0301  ";
	h.buffer.process(START + secret);
	await nextTurn();
	h.buffer.process(END);
	h.assertHeld();
	h.buffer.process("\r");
	h.assertHeld();
	const originalCode = code(h.component);
	h.buffer.process(START + originalCode + END); // Pasting even the displayed code cannot verify.
	h.buffer.process("\r");
	h.assertHeld();
	const fresh = code(h.component);
	assert.notEqual(fresh, originalCode, "a failed submit attempt generates a fresh cryptographic challenge");
	for (const ch of fresh) { h.buffer.process(ch); await nextTurn(); }
	h.assertHeld(); // A full code alone is not completion.
	h.buffer.process("\r");
	assert.equal(await h.result, secret);
	assert.equal(h.closeCalls(), 1);
	assert.equal(h.editorInput(), "");
	assert.deepEqual(h.component.render(160), []);
});

test("public StdinBuffer: paste cancel requires verification, including changing a submit intent", async (t) => {
	for (const cancel of ["\x1b", "\x03"]) {
		for (const changeIntent of [false, true]) {
			await t.test(`${JSON.stringify(cancel)} / ${changeIntent ? "change-submit" : "direct-cancel"}`, async (t) => {
				const h = await hostFixture(t);
				h.buffer.process(START + "fixture-prefix" + END);
				let submitCode: string | undefined;
				if (changeIntent) { h.buffer.process("\r"); submitCode = code(h.component); }
				h.buffer.process(cancel);
				await delay(80);
				h.assertHeld();
				assert.notEqual(code(h.component), submitCode);
				h.verify();
				assert.equal(await h.result, undefined);
				assert.equal(h.closeCalls(), 1);
				assert.equal(h.editorInput(), "");
				assert.deepEqual(h.component.render(160), []);
			});
		}
	}
});

test("public-host prompt gate spans verification; next typed prompt also requires challenge", async (t) => {
	const h = await hostFixture(t);
	const blocked = { mode: "tui", ui: new Proxy({}, { get() { assert.fail("busy prompts cannot access another lane's UI"); } }) } as
		Pick<ExtensionContext, "mode" | "ui">;
	h.buffer.process(START + "fixture-prefix" + END);
	assert.equal(await promptArchiveSecret(blocked, "Synthetic busy"), undefined);
	h.buffer.process("\r");
	assert.equal(await promptArchiveSecret(blocked, "Synthetic busy verifying"), undefined);
	h.buffer.process("\x03");
	h.assertHeld();
	assert.equal(await promptArchiveSecret(blocked, "Synthetic busy cancelling"), undefined);
	h.verify();
	assert.equal(await h.result, undefined);
	const next = await hostFixture(t);
	next.buffer.process("synthetic-typed");
	next.buffer.process("\r");
	next.assertHeld();
	next.verify();
	assert.equal(await next.result, "synthetic-typed");
	assert.equal(next.closeCalls(), 1);
});

test("regular public renderer: policy AbortSignal revokes backend now but holds pending host paste/verification", async (t) => {
	for (const phase of ["host-paste-pending", "editing", "submit", "cancel"] as const) {
		await t.test(phase, async (t) => {
			const controller = new AbortController();
			const h = await hostFixture(t, controller.signal);
			let stale: string | undefined;
			if (phase !== "editing") h.buffer.process(START + "fixture-prefix" + (phase === "host-paste-pending" ? "" : END));
			else h.buffer.process("synthetic-private");
			if (phase === "submit" || phase === "cancel") {
				h.buffer.process(phase === "submit" ? "\r" : "\x03"); stale = code(h.component);
			}
			h.assertHeld();
			controller.abort();
			assert.equal(await h.result, undefined, "backend result must settle while custom UI is still held");
			const fresh = code(h.component);
			assert.notEqual(fresh, stale);
			revokeArchiveSecretPrompt(); controller.abort();
			assert.equal(code(h.component), fresh);
			h.assertHeld();
			if (phase === "host-paste-pending") { // Entire paste was invisible to component when revoked.
				await delay(90); h.buffer.process(END); h.assertHeld();
			}
			for (const tail of ["\r", "\x1b", "\x03", "fixture-secret-tail", END]) {
				await delay(90); h.buffer.process(tail); await delay(80); h.assertHeld();
			}
			if (stale) { h.buffer.process(stale); h.buffer.process("\r"); h.assertHeld(); }
			h.buffer.process(START + code(h.component) + END); h.buffer.process("\r"); h.assertHeld();
			const exact = code(h.component);
			h.buffer.process(exact.slice(0, -1)); h.buffer.process("\r"); h.assertHeld();
			h.verify(); await nextTurn();
			assert.equal(h.closeCalls(), 1); assert.equal(h.editorInput(), "");
			assert.equal(isArchiveSecretPromptActive(), false); assert.equal(await h.result, undefined);
		});
	}
});

test("fullscreen public renderer refuses before any secret component is mounted", async (t) => {
	const h = await hostFixture(t, undefined, "fullscreen");
	assert.equal(await h.result, undefined);
	assert.equal(h.component instanceof ArchiveSecretInput, false);
	assert.deepEqual(h.component.render(160), []);
	assert.equal(h.closeCalls(), 1);
	assert.equal(h.host.getFocusedComponent(), h.editor);
	assert.equal(h.editorInput(), "");
	assert.deepEqual(h.warnings, ["Archive password input requires regular TUI mode. Restart with pi --tui-mode regular."]);
	assert.equal(isArchiveSecretPromptActive(), false);
	// No secret entry attempted in unsupported fullscreen; search is not made modal.
});

test("regular public renderer pre-component debug does not steal focus or reveal hidden input", async (t) => {
	const h = await hostFixture(t);
	let debugCalls = 0;
	h.host.onDebug = () => { debugCalls++; h.host.render(160); };
	h.buffer.process("synthetic-private"); h.buffer.process("\r");
	h.buffer.process(code(h.component).slice(0, 5));
	h.buffer.process("\x1b[100;6u"); // Kitty Ctrl+Shift+D, handled before component.
	assert.equal(debugCalls, 1); h.assertHeld();
	assert.ok(!h.terminal.writes.join("").includes("synthetic-private"));
	h.buffer.process("\x1b[102;6u"); // Fullscreen search key has no regular renderer focus-stealing handler.
	h.buffer.process("fixture-secret-tail"); h.assertHeld();
	h.buffer.process("\r"); h.verify();
	assert.equal(await h.result, "synthetic-private");
});

test("initial START split after lone ESC past host timeout cannot close even before framing seen", async (t) => {
	const h = await hostFixture(t);
	h.buffer.process("synthetic-typed"); h.buffer.process(START.slice(0, 1));
	await delay(90); h.assertHeld(); assert.ok(code(h.component));
	h.buffer.process(START.slice(1) + "fixture-secret-tail" + END);
	await nextTurn(); h.assertHeld();
	h.buffer.process("\r"); h.assertHeld();
	h.verify(); assert.equal(await h.result, undefined);
});

test("forced host replacement/disposal revokes without stale done; quarantine cannot survive replacement", async (t) => {
	const h = await hostFixture(t);
	h.buffer.process(START + "fixture-prefix");
	// Host takes ownership away using public APIs; its disposal is not a normal policy abort.
	h.host.clear(); h.host.addChild(h.editor); h.host.setFocus(h.editor);
	h.component.dispose!();
	assert.equal(await h.result, undefined); assert.equal(h.closeCalls(), 0);
	assert.equal(isArchiveSecretPromptActive(), false); assert.deepEqual(h.component.render(160), []);
	const next = await hostFixture(t);
	h.component.handleInput!("\r"); h.component.dispose!();
	assert.equal(next.host.getFocusedComponent(), next.component);
	assert.equal(isArchiveSecretPromptActive(), true);
	// Deliberately no guarantee for bytes delivered after forced focus replacement.
});

// Real SharedArchiveService -> policy -> vault.pause -> pending AbortSignal -> prompt.
// Test-only readiness seam, disposable EMPTY roots; cancel at first prompt BEFORE
// second password/KDF/migration/SQLite/native credentials. No commands are registered.
test("SharedArchiveService protective OFF/config-error/untrusted observation cancels backend without releasing public UI", async (t) => {
	for (const policyChange of ["off", "config-error", "untrusted"] as const) {
		await t.test(policyChange, async (t) => {
			const root = mkdtempSync(join(tmpdir(), "pi-jarvis-secret-policy-"));
			const agentDir = join(root, "agent"), project = join(root, "project");
			mkdirSync(join(agentDir, "extensions"), { recursive: true }); mkdirSync(project);
			const config = join(agentDir, "extensions", "pi-jarvis-archive.json");
			writeFileSync(config, JSON.stringify({ archive: { enabled: true, capture: true, modelAccess: false } }));
			let promptResult: Promise<string | undefined> | undefined, operation: Promise<string> | undefined;
			let ctx: ArchiveContext, signal: AbortSignal | undefined, trusted = true, calls = 0;
			const service = new SharedArchiveService(agentDir, { vault: {
				keychain: { get: async () => assert.fail("no keychain"), set: async () => assert.fail("no keychain"),
					delete: async () => assert.fail("no keychain") },
				prompt: (context, title, operationSignal) => {
					assert.equal(++calls, 1, "must never reach repeat-password/KDF/native storage");
					signal = operationSignal;
					return promptResult = promptArchiveSecret(context, title, operationSignal);
				},
			} });
			t.after(() => { service.close("quit"); rmSync(root, { recursive: true, force: true }); });
			const h = await hostFixture(t, undefined, "regular", promptCtx => {
				ctx = { ...promptCtx, cwd: project, hasUI: true, isProjectTrusted: () => trusted,
					sessionManager: { getSessionId: () => "synthetic-main-owner" } } as ArchiveContext;
				operation = service.command("encryption on --confirm-sensitive --confirm-stopped", ctx);
				return operation.then(() => undefined);
			});
			assert.ok(signal && !signal.aborted);
			h.buffer.process(START + "fixture-prefix"); // Whole host paste pending; component sees nothing yet.
			if (policyChange === "untrusted") trusted = false;
			else writeFileSync(config, policyChange === "off" ? '{"archive":{"enabled":false}}' : "{fixture-malformed-config");
			assert.equal(service.policy(ctx!).enabled, false);
			assert.equal(signal.aborted, true);
			assert.equal(await promptResult, undefined, "operation result already revoked while input sink focused");
			assert.match(await operation!, /Archive migration cancelled\/failed/); // Backend may conservatively report uncertain publication; fixture below proves no target.
			assert.equal(await h.result, undefined); h.assertHeld();
			const fresh = code(h.component);
			service.policy(ctx!); service.policy(ctx!);
			assert.equal(code(h.component), fresh, "repeated protective observations are idempotent");
			await delay(90); h.buffer.process(END + "\r"); h.assertHeld();
			for (const tail of ["\x1b", "\x03", "fixture-secret-tail", END]) {
				await delay(90); h.buffer.process(tail); await delay(80); h.assertHeld();
			}
			h.buffer.process(START + code(h.component) + END); h.buffer.process("\r"); h.assertHeld();
			h.verify(); await nextTurn();
			assert.equal(h.closeCalls(), 1); assert.equal(h.editorInput(), ""); assert.equal(isArchiveSecretPromptActive(), false);
			assert.equal(existsSync(service.store.path), false);
			assert.deepEqual(readdirSync(join(agentDir, "extensions")), ["pi-jarvis-archive.json"], "no vault marker/database created");
			const require = createRequire(import.meta.url);
			assert.ok(!Object.keys(require.cache).some(path => path.includes("@napi-rs/keyring") || path.includes("better-sqlite3-multiple-ciphers")));
		});
	}
});

test("public regular renderer: synchronous preparation abort reserves before callback and later mounts only a cancellation sink", async t => {
	const controller = new AbortController(); let preparations = 0;
	const h = await hostFixture(t, undefined, "regular", ctx => promptArchiveSecret(ctx, "Synthetic preparation fixture", controller.signal, () => {
		preparations++; assert.equal(isArchiveSecretPromptActive(), true);
		controller.abort(); return Promise.resolve();
	}));
	assert.equal(preparations, 1); assert.equal(await h.result, undefined); h.assertHeld();
	h.buffer.process(START + "fixture-secret-tail"); // Buffered by the real host splitter after backend cancellation.
	h.assertHeld(); h.buffer.process(END + "\r"); h.assertHeld();
	h.buffer.process("\x1b[99;5u"); h.verify(); await nextTurn();
	assert.equal(h.closeCalls(), 1); assert.equal(h.editorInput(), ""); assert.equal(isArchiveSecretPromptActive(), false);
});

test("default SharedArchiveService prompt reserves during preparation and policy revocation cannot release its later public sink", async t => {
	const root = mkdtempSync(join(tmpdir(), "pi-jarvis-secret-default-prepare-"));
	const agentDir = join(root, "agent"), project = join(root, "project");
	mkdirSync(join(agentDir, "extensions"), { recursive: true }); mkdirSync(project);
	const config = join(agentDir, "extensions", "pi-jarvis-archive.json");
	writeFileSync(config, JSON.stringify({ archive: { enabled: true, capture: true, modelAccess: false } }));
	let ctx: ArchiveContext, operation: Promise<string> | undefined, preparations = 0;
	const service: SharedArchiveService = new SharedArchiveService(agentDir, {
		beforeSecretPrompt: (): Promise<void> => {
			assert.equal(++preparations, 1, "stop before repeat-password/KDF/native storage");
			assert.equal(isArchiveSecretPromptActive(), true, "default service cannot await outside the reservation");
			writeFileSync(config, '{"archive":{"enabled":false}}');
			assert.equal(service.policy(ctx!).enabled, false); // Genuine vault pending AbortSignal, not a fake prompt.
			assert.equal(isArchiveSecretPromptActive(), true); return Promise.resolve();
		}, vault: { keychain: { get: async () => assert.fail("no keychain"), set: async () => assert.fail("no keychain"),
			delete: async () => assert.fail("no keychain") } },
	});
	t.after(() => { service.close("quit"); rmSync(root, { recursive: true, force: true }); });
	const h = await hostFixture(t, undefined, "regular", promptCtx => {
		ctx = { ...promptCtx, cwd: project, hasUI: true, isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "synthetic-preparation-owner" } } as ArchiveContext;
		operation = service.command("encryption on --confirm-sensitive --confirm-stopped", ctx);
		return operation.then(() => undefined);
	});
	assert.equal(await h.result, undefined); assert.match(await operation!, /Archive migration cancelled\/failed/);
	h.assertHeld(); h.buffer.process(START + "fixture-secret-tail" + END + "\r"); h.assertHeld();
	h.buffer.process("\x1b[99;5u"); h.verify(); await nextTurn();
	assert.equal(h.closeCalls(), 1); assert.equal(h.editorInput(), ""); assert.equal(isArchiveSecretPromptActive(), false);
	assert.equal(existsSync(service.store.path), false);
	assert.deepEqual(readdirSync(join(agentDir, "extensions")), ["pi-jarvis-archive.json"]);
	const require = createRequire(import.meta.url);
	assert.ok(!Object.keys(require.cache).some(path => path.includes("@napi-rs/keyring") || path.includes("better-sqlite3-multiple-ciphers")));
});
