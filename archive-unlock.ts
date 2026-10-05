export type ArchiveUnlockMode =
	| { mode: "session" }
	| { mode: "process" }
	| { mode: "timed"; durationMs: number; idle: boolean }
	| { mode: "persistent" };

/** Opaque scheduler handle; object handles are unreferenced when supported. */
export type ArchiveUnlockTimer = number | { unref?(): unknown };

export interface ArchiveUnlockLeaseOptions {
	/** Close the backend; caller reports cleanup failures. Timer callbacks cannot propagate them. */
	onRevoke?: () => void;
	/** Must return finite, monotonic milliseconds. Never called by the constructor. */
	now?: () => number;
	/** Finite wall-clock milliseconds; defaults to Date.now for suspend detection. */
	wallNow?: () => number;
	/** Like setTimeout: invoke asynchronously, once, after the supplied delay. */
	setTimer?: (callback: () => void, delayMs: number) => ArchiveUnlockTimer;
	clearTimer?: (timer: ArchiveUnlockTimer) => void;
}

export interface ArchiveUnlockStatus {
	readonly unlocked: boolean;
	readonly mode: ArchiveUnlockMode["mode"] | undefined;
	/** Undefined when locked or untimed; not a wall-clock timestamp. */
	readonly deadlineRemainingMs: number | undefined;
	readonly generation: number;
}

const MIN_DURATION_MS = 60_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
type ClockReading = { monotonic: number; wall: number };

function validateIdentity(value: string, label: string): void {
	if (typeof value !== "string" || value.length < 1 || value.length > 512) {
		throw new TypeError(`${label} must be a string of 1 to 512 characters`);
	}
}

function copySelection(selection: ArchiveUnlockMode): ArchiveUnlockMode {
	if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
		throw new TypeError("Invalid archive unlock mode");
	}
	switch (selection.mode) {
		case "session": case "process": case "persistent":
			return { mode: selection.mode };
		case "timed": {
			const { durationMs, idle } = selection;
			if (typeof durationMs !== "number" || !Number.isFinite(durationMs)
				|| durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS || typeof idle !== "boolean") {
				throw new TypeError("Timed unlock requires 60 seconds to 7 days and a boolean idle flag");
			}
			return { mode: "timed", durationMs, idle };
		}
		default: throw new TypeError("Invalid archive unlock mode");
	}
}

/**
 * Process-local key lease, independent of files, credentials, and archive backends.
 * Persistent mode has process-mode lifetime here; a controller owns OS restore/forget.
 * Only touch() marks archive activity. Status/key checks never refresh idle expiry.
 * Timed leases expire on either monotonic or wall deadline: wall advance detects suspend,
 * while wall rollback cannot extend the monotonic limit. No immediate erasure during OS
 * sleep is promised; delayed timers are enforced on the next access.
 * Zeroization covers only buffers owned here, not caller copies or runtime/native copies.
 */
export class ArchiveUnlockLease {
	#key?: Buffer;
	#borrowed = new Set<Buffer>();
	#owner?: string;
	#revision?: string;
	#selection?: ArchiveUnlockMode;
	#deadline?: number;
	#wallDeadline?: number;
	#timer?: { handle?: ArchiveUnlockTimer };
	#generation = 0;
	#notifying = false;
	readonly #onRevoke: () => void;
	readonly #now: () => number;
	readonly #wallNow: () => number;
	readonly #setTimer: NonNullable<ArchiveUnlockLeaseOptions["setTimer"]>;
	readonly #clearTimer: NonNullable<ArchiveUnlockLeaseOptions["clearTimer"]>;

	constructor(options: ArchiveUnlockLeaseOptions = {}) {
		if (!options || typeof options !== "object" || Array.isArray(options)) {
			throw new TypeError("Invalid archive unlock lease options");
		}
		for (const name of ["onRevoke", "now", "wallNow", "setTimer", "clearTimer"] as const) {
			if (options[name] !== undefined && typeof options[name] !== "function") {
				throw new TypeError(`Archive unlock ${name} must be a function`);
			}
		}
		this.#onRevoke = options.onRevoke ?? (() => {});
		this.#now = options.now ?? (() => performance.now());
		this.#wallNow = options.wallNow ?? (() => Date.now());
		this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	get generation(): number {
		this.#checkLive();
		return this.#generation;
	}

	/** A fresh, secret-free snapshot. Reading it also enforces overdue expiry. */
	get status(): ArchiveUnlockStatus {
		const clocks = this.#deadline === undefined ? undefined : this.#readClocks();
		const unlocked = this.#checkLive(undefined, clocks);
		return Object.freeze({
			unlocked,
			mode: this.#selection?.mode,
			deadlineRemainingMs: this.#deadline === undefined ? undefined : this.#remaining(clocks!),
			generation: this.#generation,
		});
	}

	/** Validate and copy before displacing a grant; replacement revokes its backend first. */
	unlock(key32Buffer: Buffer, ownerMainSessionId: string, vaultRevision: string, selection: ArchiveUnlockMode): void {
		if (!Buffer.isBuffer(key32Buffer) || key32Buffer.byteLength !== 32) {
			throw new TypeError("Archive unlock key must be a 32-byte Buffer");
		}
		validateIdentity(ownerMainSessionId, "Main session ID");
		validateIdentity(vaultRevision, "Vault revision");
		const selected = copySelection(selection);
		if (this.#notifying) throw new Error("Cannot unlock during archive revocation");
		const clocks = selected.mode === "timed" ? this.#readClocks() : undefined;
		const deadline = selected.mode === "timed" ? clocks!.monotonic + selected.durationMs : undefined;
		const wallDeadline = selected.mode === "timed" ? clocks!.wall + selected.durationMs : undefined;
		if (deadline !== undefined && (!Number.isFinite(deadline) || !Number.isFinite(wallDeadline))) {
			throw new TypeError("Invalid archive unlock clock");
		}
		const owned = Buffer.from(key32Buffer);
		try {
			this.revoke();
			this.#key = owned;
			this.#owner = ownerMainSessionId;
			this.#revision = vaultRevision;
			this.#selection = selected;
			this.#deadline = deadline;
			this.#wallDeadline = wallDeadline;
			this.#generation++;
			if (deadline !== undefined) this.#schedule(clocks!);
		} finally {
			if (this.#key !== owned) owned.fill(0);
		}
	}

	/**
	 * Strictly synchronous: returns fn's result, or throws if locked/expired/mismatched.
	 * Async functions are rejected before invocation; other thenable results are rejected
	 * afterwards. The temporary key is zeroed even on errors (and on reentrant revoke).
	 * Never retain the supplied buffer or start asynchronous work with it. Runtime guards
	 * cannot undo work/copies made by a callback before it returns a thenable.
	 */
	withKey<T>(vaultRevision: string, fn: (key: Buffer) => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
		validateIdentity(vaultRevision, "Vault revision");
		if (!this.#checkLive(vaultRevision)) throw new Error("Archive is locked");
		if (typeof fn !== "function") throw new TypeError("Archive key callback must be a function");
		const kind = Object.prototype.toString.call(fn);
		if (kind === "[object AsyncFunction]" || kind === "[object AsyncGeneratorFunction]") {
			throw new TypeError("Archive key callback must be synchronous");
		}
		const temporary = Buffer.from(this.#key!);
		this.#borrowed.add(temporary);
		try {
			const result = fn(temporary);
			if (result !== null && (typeof result === "object" || typeof result === "function")
				&& typeof (result as { then?: unknown }).then === "function") {
				throw new TypeError("Archive key callback must be synchronous");
			}
			return result;
		} finally {
			temporary.fill(0);
			this.#borrowed.delete(temporary);
		}
	}

	isUnlocked(vaultRevision: string): boolean {
		validateIdentity(vaultRevision, "Vault revision");
		return this.#checkLive(vaultRevision);
	}

	/** Refresh only a live idle-timed deadline, never an absolute deadline. */
	touch(): void {
		const clocks = this.#deadline === undefined ? undefined : this.#readClocks();
		if (!this.#checkLive(undefined, clocks)) return;
		if (this.#selection?.mode === "timed" && this.#selection.idle) {
			this.#deadline = clocks!.monotonic + this.#selection.durationMs;
			this.#wallDeadline = clocks!.wall + this.#selection.durationMs;
			// Keep the one existing alarm. At its old deadline it rearms for the remaining
			// idle window, rather than allocating a timer on every archive operation.
		}
	}

	sessionChanged(newMainSessionId: string): void {
		validateIdentity(newMainSessionId, "Main session ID");
		if (this.#checkLive() && this.#selection?.mode === "session" && newMainSessionId !== this.#owner) this.revoke();
	}

	/** Idempotent. Clear all owned secrets and invalidate/clear the alarm before notification. */
	revoke(): void {
		if (!this.#key) return;
		const key = this.#key;
		const timer = this.#timer;
		this.#key = undefined;
		this.#owner = undefined;
		this.#revision = undefined;
		this.#selection = undefined;
		this.#deadline = undefined;
		this.#wallDeadline = undefined;
		this.#timer = undefined;
		this.#generation++;
		key.fill(0);
		for (const borrowed of this.#borrowed) borrowed.fill(0);
		this.#borrowed.clear();
		this.#notifying = true;
		try {
			try {
				if (timer?.handle !== undefined) this.#clearTimer(timer.handle);
			} finally {
				this.#onRevoke();
			}
		} finally {
			this.#notifying = false;
		}
	}

	/** Same as revoke(); no permanent disposed state or external resources. */
	dispose(): void { this.revoke(); }

	#readClocks(): ClockReading {
		const monotonic = this.#now(), wall = this.#wallNow();
		if (typeof monotonic !== "number" || !Number.isFinite(monotonic)
			|| typeof wall !== "number" || !Number.isFinite(wall)) throw new TypeError("Invalid archive unlock clock");
		return { monotonic, wall };
	}

	#remaining(clocks: ClockReading): number {
		return Math.min(this.#deadline! - clocks.monotonic, this.#wallDeadline! - clocks.wall);
	}

	#checkLive(revision?: string, clocks?: ClockReading): boolean {
		if (!this.#key) return false;
		if ((revision !== undefined && revision !== this.#revision)
			|| (this.#deadline !== undefined && this.#remaining(clocks ?? this.#readClocks()) <= 0)) {
			this.revoke();
			return false;
		}
		return true;
	}

	#schedule(clocks: ClockReading): void {
		try {
			const previous = this.#timer;
			this.#timer = undefined;
			if (previous?.handle !== undefined) this.#clearTimer(previous.handle);
			const timer: { handle?: ArchiveUnlockTimer } = {};
			this.#timer = timer;
			let scheduled = false, calledInline = false;
			const delay = Math.min(MAX_DURATION_MS, Math.max(1, Math.ceil(this.#remaining(clocks))));
			timer.handle = this.#setTimer(() => {
				if (!scheduled) { calledInline = true; return; }
				if (this.#timer !== timer) return; // Cleared, superseded, or an old grant.
				try {
					const current = this.#readClocks();
					if (this.#checkLive(undefined, current)) this.#schedule(current);
				} catch {
					// Never crash the host from a delayed clock/scheduler/cleanup failure.
					// revoke clears secrets before notifying; the owner reports close errors.
					try { this.revoke(); } catch { /* Access remains revoked. */ }
				}
			}, delay);
			scheduled = true;
			if (calledInline || timer.handle === undefined || timer.handle === null) {
				throw new TypeError("Invalid archive unlock timer");
			}
			if (typeof timer.handle === "object") timer.handle.unref?.();
		} catch (error) {
			this.revoke();
			throw error;
		}
	}
}
