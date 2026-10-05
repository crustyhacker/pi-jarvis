import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createArchiveEnvelope, rewrapArchiveEnvelope, unlockArchiveEnvelope, ArchiveCryptoError } from "./archive-crypto.js";
import { NativeArchiveKeychain, type ArchiveKeychain } from "./archive-keychain.js";
import { copyArchiveStore } from "./archive-migration.js";
import { promptArchiveSecret } from "./archive-secret-input.js";
import { openEncryptedArchiveDatabase } from "./archive-sqlite.js";
import { ArchiveStore } from "./archive-store.js";
import { ArchiveUnlockLease, type ArchiveUnlockMode } from "./archive-unlock.js";
import { ArchiveVaultFiles, ArchiveVaultFilesError, type ArchiveVaultLocked, type VaultGeneration, type VaultReady, type VaultState, type VaultTransition } from "./archive-vault-files.js";

/** Main commands/start use the main context; execute also accepts the side SDK context. */
export type ArchiveVaultContext = Pick<ExtensionContext,
	"cwd" | "isProjectTrusted" | "sessionManager" | "ui" | "hasUI" | "mode"> & { signal?: AbortSignal };
export interface ArchiveVaultOptions {
	/** Live trusted && archive.enabled; capture/modelAccess are separate caller gates. */
	isAllowed(ctx: ArchiveVaultContext): boolean;
	onChange(): void;
	/** Caller closes Jarvis before the default non-overlay masked prompt. */
	prompt?(ctx: ArchiveVaultContext, title: string, signal: AbortSignal): Promise<string | undefined>;
	keychain?: ArchiveKeychain;
}

const FORMAT = "pi-jarvis-archive-vault";
const HANDOFF = Symbol.for("pi-jarvis.archive-vault.handoff.v1");
const MAX_HANDOFFS = 64;
// Separate from transferable grants: never cleared by a logical shutdown or
// module reload. Only a real process restart establishes that leaked native
// handles are gone. Bounded without unsafe eviction: overflow/unknown root
// poisons the process globally. This registry contains no keys or contexts.
const POISON = Symbol.for("pi-jarvis.archive-vault.poison.v1");
const MAX_POISON_ROOTS = 64;
const UNSAFE = "Archive vault unavailable. Resource cleanup failed or storage publication/release is uncertain; stop Pi and inspect, then restart the Pi process before further archive access or storage changes.";
type PoisonRegistry = { roots: Set<string>; all: boolean };
function poisonRegistry(): PoisonRegistry {
	const global = globalThis as typeof globalThis & { [POISON]?: PoisonRegistry };
	return global[POISON] ??= { roots: new Set(), all: false };
}
function poisonRoot(root?: string): void {
	const registry = poisonRegistry();
	if (!root || (!registry.roots.has(root) && registry.roots.size >= MAX_POISON_ROOTS)) registry.all = true;
	else registry.roots.add(root);
}
function poisoned(root: string): boolean {
	const registry = poisonRegistry();
	return registry.all || registry.roots.has(root);
}
function closeUncertain(error: unknown): boolean {
	// Adapter factory failures may precede Store.db assignment; consume their
	// sanitized OWN-data marker as well as the migration helper's bookkeeping.
	// Never evaluate a getter or depend on a private/exported error class.
	return error instanceof Error && Object.getOwnPropertyDescriptor(error, "closeFailed")?.value === true;
}
function releaseUncertain(error: unknown): boolean {
	return (error instanceof ArchiveVaultFilesError && error.code === "LOCK_RELEASE_FAILED") || error instanceof AggregateError;
}
const NOTICE = "Capture was paused; no history was backfilled. Source retained: explicit cleanup is needed. Stop all other Pi instances before storage changes. Deletion is not forensic erasure; original Pi transcripts, shared memory and backups are unaffected.";
const SOURCE_INSPECTION = "Archive source is missing, empty, unsafe or changed. Manual source inspection/restoration is required; target publication/deletion refused.";
const SYNTAX = "Invalid archive vault command. Passwords, keys, paths and scope flags are never accepted as arguments.";
class VaultError extends Error {}
function fail(message: string): never { throw new VaultError(message); }
function signature(state: VaultState | undefined): string { return state ? JSON.stringify(state) : "absent"; }
function withoutRemember(state: VaultReady, startup: VaultReady["startup"] = state.startup === "remember" ? "manual" : state.startup): VaultReady {
	return { format: FORMAT, version: 1, phase: "ready", revision: randomUUID(), active: state.active, startup, retired: state.retired };
}
function synchronous(action: Function): void {
	if (typeof action !== "function" || /\[object Async(?:Generator)?Function\]/.test(Object.prototype.toString.call(action))) {
		fail("Archive vault actions must be synchronous.");
	}
}
function resultSync<T>(result: T): T {
	if (result !== null && (typeof result === "object" || typeof result === "function") &&
		typeof (result as { then?: unknown }).then === "function") fail("Archive vault actions must be synchronous.");
	return result;
}

type Core = {
	files: ArchiveVaultFiles;
	lease: ArchiveUnlockLease;
	store?: ArchiveStore;
	onRevoke?: () => void;
	closeFailed: boolean;
	canonicalRoot?: string;
};
type Handoff = { core: Core; state: VaultReady; signature: string };
type RegistryGlobal = typeof globalThis & { [HANDOFF]?: Map<string, Handoff> };
function registry(create = false): Map<string, Handoff> | undefined {
	const global = globalThis as RegistryGlobal;
	if (!global[HANDOFF] && create) global[HANDOFF] = new Map();
	return global[HANDOFF];
}
function markCoreUnsafe(core: Core): void {
	core.closeFailed = true;
	let root = core.canonicalRoot;
	if (!root) {
		try { root = core.canonicalRoot = core.files.agentRootPath; } catch { /* Unknown root fails closed globally. */ }
	}
	poisonRoot(root);
}
function closeCore(core: Core): void {
	const store = core.store;
	core.store = undefined;
	try { store?.close(); } catch { markCoreUnsafe(core); }
}
function newCore(agentDir: string): Core {
	const core: Core = { files: new ArchiveVaultFiles(agentDir), lease: undefined!, closeFailed: false };
	// The lease/timer owns ONLY this detachable core, never an old facade/context/callback.
	core.lease = new ArchiveUnlockLease({ onRevoke: () => { closeCore(core); core.onRevoke?.(); } });
	return core;
}
type Pending = {
	abort: AbortController;
	epoch: number;
	owner: string;
	ctx: ArchiveVaultContext;
	signature: string;
	detach: () => void;
};
type Permit = { ctx: ArchiveVaultContext; state: VaultReady; epoch: number; locked: ArchiveVaultLocked };

/**
 * Agent-wide, fail-closed storage/lease controller. No settings writes or model tools.
 * Constructors are inert except taking an already-owned in-memory handoff. Public
 * filesystem/SQLite APIs are cooperative guards, not a hostile same-user sandbox.
 */
export class ArchiveVault {
	readonly #agentDir: string;
	readonly #registryKey: string;
	readonly #legacy: ArchiveStore;
	readonly #options: ArchiveVaultOptions;
	readonly #prompt: NonNullable<ArchiveVaultOptions["prompt"]>;
	readonly #keychain: ArchiveKeychain;
	readonly #core: Core;
	#state?: VaultState;
	#signature = "absent";
	#known = false;
	#bad = false;
	#disposed = false;
	#owner?: string;
	#epoch = 0;
	#pending?: Pending;
	#permit?: Permit;
	#legacyPermit?: { ctx: ArchiveVaultContext; epoch: number };
	#legacyBusy = false;
	#notifying = false;
	#suppressRevoke = false;
	#busy = false;
	#credentialWarning = false;
	#startSequence = 0;

	constructor(agentDir: string, legacyStore: ArchiveStore, options: ArchiveVaultOptions) {
		this.#agentDir = resolve(agentDir);
		this.#registryKey = this.#agentDir;
		this.#legacy = legacyStore;
		this.#options = options;
		this.#prompt = options.prompt ?? promptArchiveSecret;
		this.#keychain = options.keychain ?? new NativeArchiveKeychain(); // inert/lazy
		const handoffs = registry(), owned = handoffs?.get(this.#registryKey);
		if (owned) {
			handoffs!.delete(this.#registryKey);
			this.#core = owned.core;
			this.#state = owned.state;
			this.#signature = owned.signature;
			this.#known = true;
		} else this.#core = newCore(this.#agentDir);
		this.#core.onRevoke = () => { if (!this.#suppressRevoke && !this.#disposed) this.#invalidate(); };
	}

	#notify(): void {
		if (this.#notifying || this.#disposed) return;
		this.#notifying = true;
		const epoch = this.#epoch, owner = this.#owner;
		try { this.#options.onChange(); } catch {
			if (!this.#disposed && this.#epoch === epoch && this.#owner === owner) {
				markCoreUnsafe(this.#core); this.#invalidate(false);
			}
		}
		finally { this.#notifying = false; }
	}
	#closeLegacy(): void { try { this.#legacy.close(); } catch { markCoreUnsafe(this.#core); } }
	#cancel(): void {
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.detach();
		pending?.abort.abort();
	}
	#invalidate(notify = true): void {
		if (this.#disposed) return;
		this.#epoch++;
		this.#cancel();
		this.#permit = undefined;
		this.#legacyPermit = undefined;
		closeCore(this.#core);
		this.#closeLegacy();
		this.#suppressRevoke = true;
		try { this.#core.lease.revoke(); } finally { this.#suppressRevoke = false; }
		if (notify) this.#notify();
	}

	#syncSafety(): boolean {
		// Called only by an explicit probe/allowed operation, never construction.
		const root = this.#core.files.agentRootPath;
		this.#core.canonicalRoot = root;
		if (this.#core.closeFailed) poisonRoot(root);
		if (poisoned(root)) {
			this.#core.closeFailed = true;
			if (this.#pending || this.#permit || this.#legacyPermit || this.#core.store || this.#core.lease.status.unlocked) this.#invalidate(false);
		}
		return this.#core.closeFailed;
	}
	#assertSafe(): void { if (this.#syncSafety()) fail(UNSAFE); }
	#unsafeCompletion(root: string | undefined, epoch: number, owner: string | undefined): void {
		poisonRoot(root);
		// Late work belongs to this facade, NOT a core adopted by its successor.
		if (!this.#disposed && this.#epoch === epoch && this.#owner === owner) {
			markCoreUnsafe(this.#core);
			this.#invalidate(false);
		}
	}
	#withLock<T>(run: (locked: ArchiveVaultLocked) => T): T {
		const root = this.#core.files.agentRootPath, epoch = this.#epoch, owner = this.#owner;
		let completed = false;
		try { return this.#core.files.withLock(locked => { const result = run(locked); completed = true; return result; }); }
		catch (error) {
			if (!this.#disposed && this.#epoch === epoch && this.#owner === owner && (completed || releaseUncertain(error))) this.#unsafeCompletion(root, epoch, owner);
			throw error;
		}
	}
	async #withLockAsync<T>(run: (locked: ArchiveVaultLocked) => Promise<T>): Promise<T> {
		const root = this.#core.files.agentRootPath, epoch = this.#epoch, owner = this.#owner;
		let completed = false;
		try { return await this.#core.files.withLockAsync(async locked => { const result = await run(locked); completed = true; return result; }); }
		catch (error) {
			if (!this.#disposed && this.#epoch === epoch && this.#owner === owner && (completed || releaseUncertain(error))) this.#unsafeCompletion(root, epoch, owner);
			throw error;
		}
	}


	#write(locked: ArchiveVaultLocked, state: VaultState): void {
		const root = this.#core.canonicalRoot, epoch = this.#epoch, owner = this.#owner;
		try { locked.write(state); }
		catch (error) {
			// Atomic rename/directory fsync may have succeeded before reporting
			// failure. No replay, grant, or plaintext access after this uncertainty.
			this.#unsafeCompletion(root, epoch, owner);
			throw error;
		}
	}

	#allowed(ctx: ArchiveVaultContext): boolean {
		try { return !this.#disposed && !ctx.signal?.aborted && ctx.isProjectTrusted() && this.#options.isAllowed(ctx); }
		catch { return false; }
	}
	#lockPresent(): boolean {
		try { lstatSync(join(this.#core.files.rootPath, "archive.vault.lock")); return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
	}
	#publish(state: VaultState | undefined): void {
		this.#state = state;
		this.#signature = signature(state);
		this.#known = true;
		this.#bad = false;
	}
	#observe(locked?: ArchiveVaultLocked): VaultState | undefined {
		if (this.#disposed) fail("Archive vault owner has been revoked.");
		try {
			this.#syncSafety();
			const state = locked ? locked.read() : this.#core.files.read();
			const changed = this.#known && (this.#bad || signature(state) !== this.#signature);
			this.#publish(state); // Publish before callbacks, which may reenter.
			if (changed) this.#invalidate();
			return state;
		} catch (error) {
			const wasBad = this.#bad;
			this.#bad = true;
			this.#state = undefined;
			if (!wasBad) this.#invalidate();
			throw error;
		}
	}

	/** Base-policy revocation only: no metadata writes, native credentials or autorestore. */
	pause(): void {
		if (this.#disposed) return;
		if (this.#pending || this.#permit || this.#legacyPermit || this.#core.lease.status.unlocked || this.#core.store) this.#invalidate();
		else this.#closeLegacy();
	}

	available(ctx: ArchiveVaultContext): boolean {
		if (this.#disposed) return false;
		if (!this.#allowed(ctx)) { this.pause(); return false; }
		try {
			const state = this.#observe();
			if (this.#core.closeFailed) return false;
			if (this.#busy || this.#pending) return false;
			if (!state) return !this.#lockPresent(); // Legacy writes cannot race a new marker.
			// Ordinary managed operation locks are contention, not policy revocation.
			// execute reports a bounded busy failure without dropping capture baselines.
			return state.phase === "ready" && this.#activePresent(state) && (!state.active.envelope || this.#core.lease.isUnlocked(state.revision));
		} catch { return false; }
	}

	description(): string {
		if (this.#disposed) return "Archive vault owner revoked.";
		let status: string;
		try {
			const state = this.#observe();
			if (this.#bad) status = "Archive vault metadata unavailable; manual inspection required.";
			else if (state?.phase === "transition") status = "Archive vault transition pending; recording and reads blocked. Explicit rollback recovery required; source retained.";
			else if (this.#lockPresent()) status = "Archive vault busy; abandoned locks require explicit recovery.";
			else if (!state) status = "Archive encryption off (legacy plaintext).";
			else if (!state.active.envelope) status = `Archive encryption off (managed plaintext); ${state.retired.length} retired generation(s).`;
			else {
				const lease = this.#core.lease.status;
				status = `Archive encryption on; ${lease.unlocked ? `unlocked (${lease.mode === "persistent" ? "persistent-local" : lease.mode})` : "locked"}; startup ${state.startup}; ${state.retired.length} retired generation(s).`;
			}
			if (state?.phase === "ready") {
				const relative = state.active.id === "legacy" ? "archive.sqlite" : `vaults/${state.active.id}/archive.sqlite`;
				status += ` Active storage: ${relative}; ${state.retired.filter(g => !g.envelope).length} retired plaintext generation(s).`;
			}
		} catch { status = "Archive vault metadata/storage unavailable; manual inspection required. No plaintext fallback."; }
		if (this.#core.closeFailed) status = UNSAFE;
		if (this.#credentialWarning) status += " OS credential cleanup failed; a remembered key may remain.";
		return status;
	}

	/** Supplied legacyStore must also use this as its live ArchiveStoreOptions.guard. */
	guardLegacy(): void {
		if (this.#disposed) fail("Archive vault owner has been revoked.");
		if (this.#legacyBusy) {
			const permit = this.#legacyPermit;
			if (!permit || permit.epoch !== this.#epoch) fail("Archive access was revoked.");
			if (!this.#allowed(permit.ctx)) {
				// Reentrant policy observation may have replaced/disposed this owner.
				if (!this.#disposed && this.#legacyPermit === permit && permit.epoch === this.#epoch) this.#invalidate();
				fail("Archive access was revoked.");
			}
			if (this.#disposed || this.#legacyPermit !== permit || permit.epoch !== this.#epoch) fail("Archive access was revoked.");
		}
		this.#assertSafe();
		// Observe metadata through the same invalidation/baseline path as managed
		// access, rather than merely denying a legacy read with a stale baseline.
		if (this.#observe() || this.#lockPresent()) fail("Legacy archive access blocked by managed vault storage.");
	}
	#activePresent(state: VaultReady): boolean {
		// No SQLite body or native access. Only explicit legacy rollback may have
		// no source DB; every published UUID target was durably initialized.
		if (state.active.id === "legacy") return true;
		try {
			const info = lstatSync(join(this.#core.files.rootPath, "vaults", state.active.id, "archive.sqlite"));
			return info.isFile() && !info.isSymbolicLink() && info.size > 0;
		} catch { return false; }
	}
	#sourcePresent(generation: VaultGeneration, files: Pick<ArchiveVaultFiles, "generationFiles">): boolean {
		try {
			const info = files.generationFiles(generation);
			if (info.databaseBytes === undefined && !info.filesPresent) return false;
			if (info.databaseBytes !== undefined && info.databaseBytes > 0) return true;
		} catch { /* Unsafe metadata-only preflight is not an empty archive. */ }
		return fail(SOURCE_INSPECTION);
	}
	#requireSource(generation: VaultGeneration, expected: boolean, files: Pick<ArchiveVaultFiles, "generationFiles">): void {
		if (this.#sourcePresent(generation, files) !== expected) fail(SOURCE_INSPECTION);
	}
	#guardPermit(permit: Permit): void {
		// Stale work must not observe policy or revoke a newer/adopted core.
		if (this.#disposed || this.#permit !== permit || permit.epoch !== this.#epoch) fail("Archive access was revoked.");
		if (!this.#allowed(permit.ctx)) {
			if (!this.#disposed && this.#permit === permit && permit.epoch === this.#epoch) this.#invalidate();
			fail("Archive access was revoked.");
		}
		if (this.#disposed || this.#permit !== permit || permit.epoch !== this.#epoch) fail("Archive access was revoked.");
		this.#assertSafe();
		if (signature(permit.locked.read()) !== signature(permit.state)) { this.#observe(permit.locked); fail("Archive vault revision changed."); }
		if (!this.#activePresent(permit.state)) fail("Managed archive database is missing or unsafe; no database was created.");
		if (permit.state.active.envelope && !this.#core.lease.isUnlocked(permit.state.revision)) fail("Archive is locked.");
	}
	#managedStore(state: VaultReady): ArchiveStore {
		if (!this.#core.store) {
			this.#core.store = new ArchiveStore(this.#core.files.agentRootPath, {
				managed: true, ...(state.active.id === "legacy" ? {} : { storageId: state.active.id }),
				guard: () => { const permit = this.#permit; if (!permit) fail("Archive operation has ended."); this.#guardPermit(permit); },
				...(state.active.envelope ? { databaseFactory: (path: string) =>
					this.#core.lease.withKey(state.revision, key => openEncryptedArchiveDatabase(path, key, { create: false })) } : {}),
			});
		}
		return this.#core.store;
	}

	execute<T>(ctx: ArchiveVaultContext, action: (store: ArchiveStore) => T): T {
		synchronous(action);
		if (!this.available(ctx)) fail("Archive unavailable: disabled, untrusted, locked, busy or invalid vault state.");
		const state = this.#state, owner = this.#owner, root = this.#core.canonicalRoot;
		if (!state) {
			if (this.#legacyBusy) fail("Archive vault operation blocked.");
			const epoch = this.#epoch;
			this.guardLegacy();
			this.#legacyBusy = true;
			this.#legacyPermit = { ctx, epoch };
			try {
				const result = resultSync(action(this.#legacy));
				this.guardLegacy();
				if (!this.#allowed(ctx) || epoch !== this.#epoch) fail("Archive access was revoked.");
				return result;
			} catch (error) {
				if (closeUncertain(error)) this.#unsafeCompletion(root, epoch, owner);
				this.#closeLegacy(); throw error;
			}
			finally { this.#legacyBusy = false; this.#legacyPermit = undefined; }
		}
		if (state.phase !== "ready" || this.#permit) fail("Archive vault operation blocked.");
		return this.#withLock(locked => {
			if (signature(locked.read()) !== signature(state)) { this.#observe(locked); fail("Archive vault revision changed."); }
			const permit: Permit = { ctx, state, epoch: this.#epoch, locked };
			this.#permit = permit;
			try {
				this.#guardPermit(permit);
				const result = resultSync(action(this.#managedStore(state)));
				this.#guardPermit(permit);
				this.#core.lease.touch(); // successful data activity ONLY; may synchronously revoke
				this.#guardPermit(permit); // Never return data after touch observes expiry/authority loss.
				return result;
			} catch (error) {
				if (closeUncertain(error)) this.#unsafeCompletion(root, permit.epoch, owner);
				if (!this.#disposed && this.#epoch === permit.epoch && this.#owner === owner) closeCore(this.#core);
				throw error;
			}
			finally { if (this.#permit === permit) this.#permit = undefined; }
		});
	}

	#main(ctx: ArchiveVaultContext, replace = false): string {
		if (this.#disposed) fail("Archive vault owner has been revoked.");
		const owner = ctx.sessionManager.getSessionId();
		if (!owner || owner.length > 512) fail("Archive main-session identity unavailable.");
		if (this.#owner && this.#owner !== owner) {
			if (!replace) fail("Archive command belongs to a different main session.");
			this.#epoch++;
			this.#cancel();
			closeCore(this.#core);
			this.#core.lease.sessionChanged(owner);
			this.#notify();
		}
		this.#owner = owner;
		return owner;
	}
	#ready(ctx: ArchiveVaultContext, encrypted = false): VaultReady {
		if (!this.#allowed(ctx)) { this.#invalidate(); fail("Archive must be enabled in a trusted project."); }
		this.#assertSafe();
		const state = this.#observe();
		if (!state || state.phase !== "ready" || (encrypted && !state.active.envelope)) fail("No ready encrypted archive; inspect encryption status/recovery.");
		return state;
	}
	#begin(ctx: ArchiveVaultContext, state: VaultState | undefined): Pending {
		const owner = this.#main(ctx);
		if (!this.#allowed(ctx)) { this.#invalidate(); fail("Archive must be enabled in a trusted project."); }
		this.#assertSafe();
		if (this.#pending || this.#busy || this.#permit) fail("Archive vault operation already pending.");
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		const pending: Pending = { abort, epoch: this.#epoch, owner, ctx, signature: signature(state), detach: () => ctx.signal?.removeEventListener("abort", onAbort) };
		this.#pending = pending;
		this.#check(pending);
		return pending;
	}
	#check(pending: Pending, locked?: ArchiveVaultLocked): void {
		if (this.#disposed || pending !== this.#pending || pending.epoch !== this.#epoch || pending.abort.signal.aborted ||
			this.#owner !== pending.owner || pending.ctx.sessionManager.getSessionId() !== pending.owner || !this.#allowed(pending.ctx)) {
			if (!this.#disposed && pending === this.#pending) this.#invalidate();
			fail("Archive operation cancelled or permission/owner changed.");
		}
		this.#assertSafe();
		const state = locked ? locked.read() : this.#core.files.read();
		if (signature(state) !== pending.signature) { this.#observe(locked); fail("Archive vault revision changed."); }
	}
	#end(pending: Pending): void {
		pending.detach();
		if (this.#pending === pending) this.#pending = undefined;
	}
	async #secret(pending: Pending, title: string): Promise<string> {
		this.#check(pending);
		const secret = await this.#prompt(pending.ctx, title, pending.abort.signal);
		this.#check(pending);
		if (secret === undefined) fail("Archive password prompt cancelled or unavailable; no input fallback.");
		return secret;
	}
	async #newPassword(pending: Pending): Promise<string> {
		const first = await this.#secret(pending, "New archive password");
		const second = await this.#secret(pending, "Repeat new archive password");
		if (first !== second) fail("Archive passwords did not match.");
		return first;
	}
	#authenticate(generation: VaultGeneration, key: Buffer, guard: () => void): void {
		guard();
		const root = this.#core.files.agentRootPath, epoch = this.#epoch, owner = this.#owner;
		const store = new ArchiveStore(root, { managed: true,
			...(generation.id === "legacy" ? {} : { storageId: generation.id }), guard,
			databaseFactory: (path, options) => {
				guard();
				if (options.create) fail("Unlock cannot create an archive database.");
				return openEncryptedArchiveDatabase(path, key, { create: false });
			},
		});
		try {
			// Approved existing-only store seam validates cipher and exact schema,
			// without scanning raw record bodies or initializing an absent database.
			if (!store.migrationDatabase(false, guard)) fail("Encrypted archive database is missing; unlock cannot create it.");
			guard();
		} catch (error) {
			if (closeUncertain(error)) this.#unsafeCompletion(root, epoch, owner);
			throw error;
		} finally {
			try { store.close(); } catch (error) {
				this.#unsafeCompletion(root, epoch, owner); throw error;
			}
		}
	}
	#published(pending: Pending, state: VaultReady): void {
		this.#publish(state);
		pending.signature = signature(state);
	}
	#commit(state: VaultReady, key?: Buffer, mode?: ArchiveUnlockMode): void {
		this.#invalidate(false);
		this.#assertSafe();
		this.#publish(state);
		if (key && mode) this.#core.lease.unlock(key, this.#owner!, state.revision, mode);
	}
	async #delete(account?: string): Promise<string> {
		if (!account) return "";
		try { await this.#keychain.delete(account); return ""; }
		catch { this.#credentialWarning = true; return " OS credential deletion failed; a remembered key may remain, but the durable marker no longer authorizes this grant."; }
	}
	async #remember(pending: Pending, state: VaultReady, key: Buffer): Promise<string> {
		const revision = randomUUID();
		// Fixed JSON tuple; canonical root and a unique durable grant revision.
		const account = createHash("sha256").update(JSON.stringify([
			this.#core.files.agentRootPath, state.active.id, revision,
		])).digest("hex");
		let attempted = false, committed = false;
		try {
			this.#check(pending);
			this.#withLock(locked => this.#authenticate(state.active, key, () => this.#check(pending, locked)));
			this.#check(pending);
			attempted = true;
			await this.#keychain.set(account, key);
			this.#check(pending);
			this.#withLock(locked => {
				this.#check(pending, locked);
				const next: VaultReady = { ...withoutRemember(state, "remember"), revision, remember: { account } };
				this.#write(locked, next);
				this.#published(pending, next);
			});
			this.#check(pending);
			this.#commit(this.#state as VaultReady, key, { mode: "persistent" });
			committed = true;
			this.#notify();
			this.#assertSafe();
			return "Archive unlocked (persistent-local); startup remember. Explicit lock forgets this grant." + await this.#delete(state.remember?.account);
		} finally {
			if (attempted && !committed) await this.#delete(account); // unique account: late set never reauthorizes a locked grant
		}
	}
	async #unlock(ctx: ArchiveVaultContext, mode: ArchiveUnlockMode): Promise<string> {
		const state = this.#ready(ctx, true);
		this.#invalidate();
		const pending = this.#begin(ctx, state);
		let key: Buffer | undefined;
		try {
			key = await unlockArchiveEnvelope(state.active.envelope, await this.#secret(pending, "Unlock archive"), pending.abort.signal);
			this.#check(pending);
			if (mode.mode === "persistent") return await this.#remember(pending, state, key);
			this.#withLock(locked => {
				this.#check(pending, locked);
				this.#authenticate(state.active, key!, () => this.#check(pending, locked));
				// Nonpersistent unlock is process-local unless it must durably forget
				// an existing remembered grant. Independent Pi processes may unlock
				// the same unchanged generation without revoking each other.
				const next = state.remember ? withoutRemember(state) : state;
				if (state.remember) this.#write(locked, next);
				this.#published(pending, next);
			});
			this.#check(pending);
			this.#commit(this.#state as VaultReady, key, mode);
			this.#notify();
			this.#assertSafe();
			return `Archive unlocked (${mode.mode === "timed" ? mode.idle ? "idle timeout" : "fixed duration" : mode.mode}).` + await this.#delete(state.remember?.account);
		} finally { key?.fill(0); this.#end(pending); }
	}

	async #lock(): Promise<string> {
		this.#invalidate(); // Cancel/revoke BEFORE attempting any durable/native work.
		const accounts = new Set<string>();
		const remember = (ready: VaultReady | null) => { if (ready?.remember) accounts.add(ready.remember.account); };
		let transition = false;
		try {
			const state = this.#observe();
			if (!state) return "Archive locked locally; encryption is not configured.";
			if (state.phase === "transition") { remember(state.from); remember(state.to); } else remember(state);
			const epoch = this.#epoch, owner = this.#owner;
			// Async acquisition lets this facade's cancelled migration reach its
			// guarded boundary and release, rather than blocking its event loop.
			await this.#withLockAsync(async locked => {
				if (this.#disposed || this.#epoch !== epoch || this.#owner !== owner) fail("Archive lock owner was revoked.");
				const current = locked.read();
				if (!current) fail("Archive vault state changed before durable lock.");
				let next: VaultState;
				if (current.phase === "transition") {
					transition = true;
					remember(current.from); remember(current.to);
					next = { ...current, revision: randomUUID(), from: current.from ? withoutRemember(current.from) : null, to: withoutRemember(current.to) };
				} else { remember(current); next = withoutRemember(current); }
				// Rotate even an idle transition: another owner must not publish
				// against an unchanged signature after this explicit global lock.
				this.#write(locked, next);
				this.#publish(next);
			});
			if (!this.#disposed && this.#epoch === epoch && this.#owner === owner) this.#invalidate(false);
			this.#notify();
			let warning = "";
			for (const account of accounts) warning += await this.#delete(account);
			return (transition ? "Archive locked durably; transition remains blocked. Explicit rollback recovery required; source retained." :
				"Archive locked; remembered authorization cleared. Other processes observe this at operation boundaries.") + warning;
		} catch {
			for (const account of accounts) await this.#delete(account);
			return "Archive locked locally, but durable revocation could not be confirmed. Publication may have succeeded; inspect metadata/lock and encryption status. Remembered authorization/key may remain; no automatic repair." + (this.#core.closeFailed ? " " + UNSAFE : "");
		}
	}
	async #startup(ctx: ArchiveVaultContext, startup: VaultReady["startup"]): Promise<string> {
		const state = this.#ready(ctx, startup !== "manual");
		if (startup === "remember") {
			if (!this.#core.lease.isUnlocked(state.revision)) fail("Unlock the encrypted archive before choosing startup remember.");
			const pending = this.#begin(ctx, state);
			let key: Buffer | undefined;
			try {
				key = this.#core.lease.withKey(state.revision, value => Buffer.from(value));
				return await this.#remember(pending, state, key);
			} finally { key?.fill(0); this.#end(pending); }
		}
		this.#invalidate();
		this.#withLock(locked => {
			if (!this.#allowed(ctx) || signature(locked.read()) !== signature(state)) fail("Archive permission or revision changed.");
			const next = withoutRemember(state, startup);
			this.#write(locked, next);
			this.#publish(next);
		});
		this.#notify();
		return `Archive startup ${startup}; local lease locked.` + await this.#delete(state.remember?.account);
	}
	async #password(ctx: ArchiveVaultContext): Promise<string> {
		const state = this.#ready(ctx, true);
		if (!this.#core.lease.isUnlocked(state.revision)) fail("Unlock the encrypted archive before changing its password.");
		const pending = this.#begin(ctx, state);
		const key = this.#core.lease.withKey(state.revision, value => Buffer.from(value));
		try {
			this.#withLock(locked => this.#authenticate(state.active, key, () => this.#check(pending, locked)));
			const envelope = await rewrapArchiveEnvelope(state.active.envelope, key, await this.#newPassword(pending), pending.abort.signal);
			this.#check(pending);
			this.#withLock(locked => {
				this.#check(pending, locked);
				if (!this.#core.lease.isUnlocked(state.revision)) fail("Archive lease expired; password unchanged.");
				this.#authenticate(state.active, key, () => this.#check(pending, locked));
				const next = { ...withoutRemember(state), active: { ...state.active, envelope } };
				this.#write(locked, next);
				this.#published(pending, next);
			});
			this.#check(pending);
			this.#commit(this.#state as VaultReady); // Rewrap intentionally ends the local grant.
			this.#notify();
			this.#assertSafe();
			return "Archive password changed; archive locked. This rewraps the same data key, not key rotation: old key/envelope backups may still unlock it." + await this.#delete(state.remember?.account);
		} finally { key.fill(0); this.#end(pending); }
	}

	#notice(ctx: ArchiveVaultContext, message: string): void {
		try { if (ctx.hasUI) ctx.ui.notify(message, "warning"); }
		catch { fail("Archive safety notice unavailable; no storage changes were started."); }
	}
	async #migrate(ctx: ArchiveVaultContext, encrypt: boolean): Promise<string> {
		if (!this.#allowed(ctx)) fail("Archive must be enabled in a trusted project.");
		this.#assertSafe();
		const state = this.#observe();
		if (state?.phase === "transition") fail("Transition pending; explicit rollback recovery required.");
		if (!!state?.active.envelope === encrypt) return `Archive encryption already ${encrypt ? "on" : "off"}.`;
		if ((state?.retired.length ?? 0) >= 8) fail("Retired-generation limit reached; explicit cleanup required before migration.");
		const sourceGeneration = state?.active ?? { id: "legacy", envelope: null };
		const sourcePresent = this.#sourcePresent(sourceGeneration, this.#core.files);
		if (sourceGeneration.id !== "legacy" && !sourcePresent) fail(SOURCE_INSPECTION); // BEFORE notice/prompt/marker.
		// Migration closes/revokes the ordinary grant before asynchronous copying.
		// Do not silently extend a timed key beyond its original deadline.
		if (!encrypt && this.#core.lease.status.mode === "timed") {
			fail("Plaintext conversion cannot use a timed unlock. Explicitly unlock session or process before migration; no storage changes were started.");
		}
		this.#notice(ctx, `${encrypt ? "Encrypting a new archive generation" : "Converting the active archive to plaintext"}. All other Pi instances must be stopped. Capture pauses without backfill; source stays as an explicit backup until cleanup. Originals/shared memory/backups are unaffected; deletion is not forensic erasure.`);
		let sourceKey: Buffer | undefined, targetKey: Buffer | undefined;
		if (!encrypt) {
			if (!state || !this.#core.lease.isUnlocked(state.revision)) fail("Unlock the encrypted archive before plaintext conversion.");
			sourceKey = this.#core.lease.withKey(state.revision, key => Buffer.from(key));
		}
		this.#invalidate();
		let pending: Pending;
		try { pending = this.#begin(ctx, state); }
		catch (error) { sourceKey?.fill(0); throw error; }
		let marked = false, readyAttempted = false, sourceFailed = false;
		try {
			let active: VaultGeneration;
			if (encrypt) {
				const created = await createArchiveEnvelope(await this.#newPassword(pending), pending.abort.signal);
				targetKey = created.key;
				active = { id: created.envelope.vaultId, envelope: created.envelope };
			} else active = { id: randomUUID(), envelope: null };
			this.#check(pending);
			const next: VaultReady = { format: FORMAT, version: 1, phase: "ready", revision: randomUUID(), active,
				startup: encrypt && state?.startup === "prompt" ? "prompt" : "manual",
				retired: [...(state?.retired ?? []), state?.active ?? { id: "legacy", envelope: null }] };
			const transition: VaultTransition = { format: FORMAT, version: 1, phase: "transition", revision: randomUUID(), from: state ?? null, to: next };
			await this.#withLockAsync(async locked => {
				this.#busy = true;
				try {
					this.#check(pending, locked);
					if (this.#core.closeFailed) fail("Resource close failed; stop Pi and inspect before migration.");
					const checkSource = () => {
						try { this.#requireSource(sourceGeneration, sourcePresent, locked); }
						catch (error) { sourceFailed = true; throw error; }
					};
					checkSource();
					if (sourceGeneration.id === "legacy") transition.legacySourcePresent = sourcePresent;
					this.#write(locked, transition); // Recoverable marker BEFORE target directories/DB.
					marked = true;
					this.#publish(transition);
					pending.signature = signature(transition);
					this.#notify();
					const guard = () => { this.#check(pending, locked); checkSource(); };
					guard();
					locked.ensureStorageDir(active.id);
					const source = new ArchiveStore(this.#core.files.agentRootPath, { managed: true,
						...(sourceGeneration.id === "legacy" ? {} : { storageId: sourceGeneration.id }), guard,
						...(sourceKey ? { databaseFactory: (path: string, options: { create: boolean }) => {
							guard(); if (options.create) fail("Migration source cannot be created.");
							return openEncryptedArchiveDatabase(path, sourceKey!, { create: false });
						} } : {}) });
					const target = new ArchiveStore(this.#core.files.agentRootPath, { managed: true, storageId: active.id, guard,
						...(targetKey ? { databaseFactory: (path: string, options: { create: boolean }) => { guard(); return openEncryptedArchiveDatabase(path, targetKey!, options); } } : {}) });
					try { await copyArchiveStore(source, target, guard); }
					catch (error) {
						if (closeUncertain(error)) this.#unsafeCompletion(this.#core.canonicalRoot, pending.epoch, pending.owner);
						throw error;
					}
					guard();
					readyAttempted = true;
					this.#write(locked, next); // Only verified/checkpointed/closed/fsynced targets become active.
					this.#published(pending, next);
				} finally { this.#busy = false; }
			});
			this.#check(pending); // Release succeeded; fresh owner/policy/revision before grant.
			this.#commit(next, targetKey, encrypt ? { mode: "session" } : undefined);
			this.#notify();
			this.#assertSafe();
			return `Archive encryption ${encrypt ? "enabled; unlocked for this main session" : "disabled; active archive is now plaintext"}. ${NOTICE}` + await this.#delete(state?.remember?.account);
		} catch (error) {
			if (closeUncertain(error) || (readyAttempted && !this.#disposed && this.#pending === pending)) {
				this.#unsafeCompletion(this.#core.canonicalRoot, pending.epoch, pending.owner);
			}
			if (!this.#disposed && this.#pending === pending && this.#epoch === pending.epoch) this.#invalidate();
			let transitionVerified = false;
			if (marked && !this.#disposed) {
				try { transitionVerified = this.#core.files.read()?.phase === "transition"; } catch { /* No phase claim without verification. */ }
			}
			if (this.#core.closeFailed || readyAttempted) return `Archive migration/publication outcome is uncertain; publication may have succeeded. This operation did not grant access; inspect encryption status and restart the Pi process before access or recovery.${transitionVerified ? " Verified durable transition remains blocked." : ""} Never retry automatically. ${NOTICE}`;
			if (sourceFailed) return SOURCE_INSPECTION + (transitionVerified ? " Durable transition remains blocked; unpublished target retained. No automatic rollback/replay." : " No storage changes were started; inspect encryption status.");
			return transitionVerified ? `Archive migration did not complete; durable transition remains blocked. Explicit rollback recovery required; never retry automatically. ${NOTICE}` : "Archive migration cancelled/failed; publication may have succeeded. Inspect encryption status; no automatic retry.";
		} finally { sourceKey?.fill(0); targetKey?.fill(0); this.#end(pending); }
	}
	async #cleanup(ctx: ArchiveVaultContext): Promise<string> {
		const state = this.#ready(ctx);
		const encrypted = !!state.active.envelope;
		if (encrypted && !this.#core.lease.isUnlocked(state.revision)) fail("Unlock the encrypted active archive before cleanup.");
		if (this.#busy || this.#permit || this.#legacyBusy) fail("Archive vault operation already pending.");
		this.#notice(ctx, "Cleanup deletes only retired archive generations. Stop all other Pi instances. Deletion is not forensic erasure; originals/shared memory/backups remain.");
		// Cancel other work and close data handles, but retain the ORIGINAL lease
		// and timer until synchronous authenticated cleanup ends. No copied key or
		// extended deadline: every authorization check consults that live lease.
		this.#epoch++;
		this.#cancel();
		closeCore(this.#core);
		this.#closeLegacy();
		const pending = this.#begin(ctx, state);
		let removed = 0, failed = 0;
		try {
			this.#withLock(locked => {
				let authorizationFailed = false;
				const authorized = () => {
					try {
						this.#check(pending, locked);
						// Do not delete potential backup copies beneath a missing active
						// generation, including plaintext. Empty legacy rollback with no
						// retired data is the only legitimate absent active case here.
						if (state.active.id !== "legacy" || state.retired.length) this.#requireSource(state.active, true, locked);
						if (encrypted && !this.#core.lease.isUnlocked(state.revision)) fail("Archive unlock expired or was revoked; cleanup stopped.");
					} catch (error) { authorizationFailed = true; throw error; }
				};
				authorized();
				if (encrypted) this.#core.lease.withKey(state.revision, key => this.#authenticate(state.active, key, authorized));
				authorized(); // Existing cipher/schema authenticated BEFORE any deletion.
				const retained: VaultGeneration[] = [];
				for (const generation of state.retired) {
					authorized();
					try { locked.cleanupGeneration(generation, authorized); removed++; }
					catch (error) {
						if (authorizationFailed) throw error; // Never downgrade lost authority to a per-file failure.
						retained.push(generation); failed++;
					}
				}
				authorized();
				const next = { ...state, revision: randomUUID(), retired: retained };
				this.#write(locked, next);
				this.#published(pending, next);
			});
			this.#check(pending);
			this.#commit(this.#state as VaultReady); // Cleanup always ends the local grant.
			this.#notify();
			this.#assertSafe();
			return `Archive cleanup: ${removed} retired generation(s) removed; ${failed} retained after cleanup failure (possibly partial backups). Active archive retained; local lease locked. Deletion is not forensic erasure; originals/shared memory/backups are unaffected.`;
		} finally {
			if (!this.#disposed && this.#pending === pending && this.#epoch === pending.epoch && this.#owner === pending.owner) this.#invalidate();
			this.#end(pending);
		}
	}

	async #recover(ctx: ArchiveVaultContext): Promise<string> {
		if (!this.#allowed(ctx)) fail("Archive must be enabled in a trusted project.");
		this.#assertSafe();
		const state = this.#observe();
		if (state?.phase !== "transition") fail("No pending archive transition to roll back.");
		this.#notice(ctx, "Explicit rollback may discard only the known unpublished target after verifying source presence/absence. Missing or unsafe sources require manual inspection/restoration; keep the potential copy. Stop all other Pi instances; no automatic replay/backfill or forensic erasure.");
		this.#invalidate();
		let unrecordedAbsent = false;
		this.#withLock(locked => {
			const generation = state.from?.active ?? { id: "legacy", envelope: null };
			let sourceFailed = false;
			const guard = () => {
				if (!this.#allowed(ctx) || signature(locked.read()) !== signature(state)) fail("Archive permission or revision changed.");
				this.#assertSafe();
				try {
					const present = this.#sourcePresent(generation, locked);
					if (generation.id !== "legacy" || state.legacySourcePresent === true) {
						if (!present) fail(SOURCE_INSPECTION);
					} else if (state.legacySourcePresent === false) {
						if (present) fail(SOURCE_INSPECTION);
					} else if (!present) {
						// Old prototype did not record absence. Existing target files
						// might be the only copy; never delete or promote them.
						if (locked.generationFiles(state.to.active).filesPresent) fail(SOURCE_INSPECTION);
						unrecordedAbsent = true;
					}
				} catch (error) { sourceFailed = true; throw error; }
			};
			guard(); // BEFORE target preflight or any deletion.
			try { if (!unrecordedAbsent) locked.cleanupGeneration(state.to.active, guard); }
			catch (error) { if (sourceFailed) fail(SOURCE_INSPECTION); throw error; }
			guard();
			const source: VaultReady = state.from ? withoutRemember(state.from) : {
				format: FORMAT, version: 1, phase: "ready", revision: randomUUID(), active: { id: "legacy", envelope: null }, startup: "manual", retired: [],
			};
			this.#write(locked, source); // Keep marker even on rollback to legacy plaintext.
			this.#publish(source);
		});
		this.#notify();
		const sourceNotice = unrecordedAbsent ? "Legacy source presence was unrecorded; no source or target data files were found and no data files were deleted. Inspect storage before use." :
			state.legacySourcePresent === false ? "Legacy source was explicitly absent; unpublished target discarded." : "Source retained.";
		return `Archive transition rolled back explicitly; local lease locked and marker preserved. ${sourceNotice} Capture resumes from a fresh baseline; no backfill.` + await this.#delete(state.from?.remember?.account);
	}

	/** Only call from the MAIN session_start path, never a Jarvis side boot. */
	async start(ctx: ArchiveVaultContext): Promise<void> {
		const sequence = ++this.#startSequence;
		let owner: string | undefined, epoch = this.#epoch, attempted = false;
		try {
			owner = this.#main(ctx, true);
			epoch = this.#epoch;
			if (!this.#allowed(ctx)) { this.#invalidate(); return; }
			this.#assertSafe(); // BEFORE keychain get, prompt, or database authentication.
			const state = this.#observe();
			if (state?.phase !== "ready" || !state.active.envelope || this.#core.lease.isUnlocked(state.revision)) return;
			if (state.startup === "manual") return;
			if (state.startup === "prompt") {
				attempted = true;
				const work = this.#unlock(ctx, { mode: "session" });
				epoch = this.#epoch;
				await work; return;
			}
			const pending = this.#begin(ctx, state);
			epoch = this.#epoch;
			let key: Buffer | undefined;
			try {
				attempted = true;
				key = await this.#keychain.get(state.remember!.account);
				this.#check(pending);
				if (!key || !Buffer.isBuffer(key) || key.length !== 32) fail("Remembered archive key unavailable; no password/input fallback.");
				this.#withLock(locked => {
					this.#check(pending, locked);
					this.#authenticate(state.active, key!, () => this.#check(pending, locked));
				});
				this.#check(pending);
				this.#commit(state, key, { mode: "persistent" });
				epoch = this.#epoch;
				this.#notify();
				this.#assertSafe();
			} finally { key?.fill(0); this.#end(pending); }
		} catch {
			// A completion from an old start may not revoke a successor or call its
			// stale context/UI, even when the same facade receives another start.
			if (!this.#disposed && this.#startSequence === sequence && this.#owner === owner &&
				(this.#epoch === epoch || this.#core.closeFailed) && this.#allowed(ctx)) {
				this.#invalidate();
				try { if (ctx.hasUI) ctx.ui.notify(this.#core.closeFailed ? UNSAFE + (attempted ? " Archive startup restore did not provide a usable grant; no fallback." : " Archive startup restore was not performed; no fallback.") : "Archive startup unlock unavailable or cancelled; archive remains locked. No fallback.", "warning"); } catch { /* Host notification failure is not a data fallback. */ }
			}
		}
	}

	/** Undefined ONLY for another command namespace. Never reflects argument text. */
	async command(args: string, ctx: ArchiveVaultContext): Promise<string | undefined> {
		const parts = args.trim().split(/\s+/), action = parts[0];
		if (!["encryption", "unlock", "lock", "password", "startup"].includes(action)) return undefined;
		this.#startSequence++; // A command successor owns its own warnings/results.
		try {
			this.#main(ctx);
			if (args.length > 256) fail(SYNTAX);
			const rest = parts.slice(1);
			if (action === "encryption" && (!rest.length || (rest.length === 1 && rest[0] === "status"))) return this.description();
			if (action === "lock") { if (rest.length) fail(SYNTAX); return await this.#lock(); }
			if (action === "password") { if (rest.length) fail(SYNTAX); return await this.#password(ctx); }
			if (action === "startup") {
				if (rest.length !== 1 || !["manual", "prompt", "remember"].includes(rest[0])) fail(SYNTAX);
				return await this.#startup(ctx, rest[0] as VaultReady["startup"]);
			}
			if (action === "unlock") {
				let mode: ArchiveUnlockMode;
				if (!rest.length || (rest.length === 1 && rest[0] === "session")) mode = { mode: "session" };
				else if (rest.length === 1 && rest[0] === "process") mode = { mode: "process" };
				else if (rest.length === 1 && rest[0] === "remember") mode = { mode: "persistent" };
				else if (rest.length === 2 && ["for", "idle"].includes(rest[0]) && /^[1-9]\d{0,4}$/.test(rest[1]) && Number(rest[1]) <= 10080) {
					mode = { mode: "timed", durationMs: Number(rest[1]) * 60_000, idle: rest[0] === "idle" };
				} else fail(SYNTAX);
				return await this.#unlock(ctx, mode);
			}
			const control = rest[0], flags = rest.slice(1);
			const expected = control === "recover" ? ["--rollback", "--confirm-sensitive", "--confirm-stopped"] : ["--confirm-sensitive", "--confirm-stopped"];
			if (!["on", "off", "cleanup", "recover", "break-lock"].includes(control) || flags.length !== expected.length || new Set(flags).size !== flags.length || !expected.every(flag => flags.includes(flag))) fail(SYNTAX);
			if (control === "break-lock") {
				this.#assertSafe();
				this.#invalidate();
				return this.#core.files.breakAbandonedLock() ? "Abandoned local archive lock explicitly removed. Inspect encryption status before recovery; no automatic replay." : "No abandoned archive lock to remove.";
			}
			if (control === "cleanup") return await this.#cleanup(ctx);
			if (control === "recover") return await this.#recover(ctx);
			return await this.#migrate(ctx, control === "on");
		} catch (error) {
			if (error instanceof VaultError) return error.message + (this.#credentialWarning ? " OS credential cleanup failed; a key may remain." : "");
			if (error instanceof ArchiveCryptoError) return error.message;
			return (this.#core.closeFailed ? UNSAFE + " Publication may have succeeded; inspect encryption status. No plaintext/input fallback or automatic retry." :
				"Archive vault operation failed; access remains fail-closed. Inspect encryption status; no plaintext/input fallback or automatic repair.") +
				(this.#credentialWarning ? " OS credential cleanup failed; a key may remain." : "");
		}
	}

	shutdown(reason?: string): void {
		if (this.#disposed) return;
		this.#epoch++;
		this.#cancel();
		this.#permit = undefined;
		closeCore(this.#core);
		this.#closeLegacy();
		let handoff = false;
		try {
			const state = this.#core.files.read(), status = this.#core.lease.status;
			handoff = ["new", "resume", "fork"].includes(reason ?? "") && !this.#core.closeFailed && !this.#lockPresent() &&
				state?.phase === "ready" && !!state.active.envelope && signature(state) === this.#signature && status.unlocked && status.mode !== "session";
			if (handoff) {
				const handoffs = registry(true)!;
				const previous = handoffs.get(this.#registryKey);
				if (previous) { previous.core.onRevoke = undefined; previous.core.lease.revoke(); }
				handoffs.delete(this.#registryKey);
				while (handoffs.size >= MAX_HANDOFFS) {
					const key = handoffs.keys().next().value!;
					const old = handoffs.get(key)!; handoffs.delete(key);
					old.core.onRevoke = undefined; old.core.lease.revoke();
				}
				handoffs.set(this.#registryKey, { core: this.#core, state: state as VaultReady, signature: this.#signature });
			}
		} catch { handoff = false; }
		this.#core.onRevoke = undefined;
		if (!handoff) this.#core.lease.revoke();
		if (!["new", "resume", "fork"].includes(reason ?? "")) {
			const handoffs = registry();
			if (reason === "quit") {
				// Logical quit clears pending grants, NEVER restart-required poison.
				if (handoffs) { for (const entry of handoffs.values()) { entry.core.onRevoke = undefined; entry.core.lease.revoke(); } handoffs.clear(); }
			} else {
				// An SDK runtime reload/unknown disposal owns only this agent root.
				const entry = handoffs?.get(this.#registryKey);
				if (entry) { handoffs!.delete(this.#registryKey); entry.core.onRevoke = undefined; entry.core.lease.revoke(); }
			}
		}
		this.#disposed = true; // Permanent; late results must never touch an adopted core.
		this.#owner = undefined;
	}
}
