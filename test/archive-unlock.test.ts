import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
	ArchiveUnlockLease,
	type ArchiveUnlockLeaseOptions,
	type ArchiveUnlockMode,
	type ArchiveUnlockTimer,
} from "../archive-unlock.js";

const MIN = 60_000;
const MAX = 7 * 24 * 60 * 60 * 1000;
const OWNER = "fixture-main";
const REVISION = "fixture-vault:1";
const timed = (idle = false, durationMs = MIN): ArchiveUnlockMode => ({ mode: "timed", durationMs, idle });
const zero = (buffer: Buffer) => assert.ok(buffer.every((byte) => byte === 0));

interface FakeTimer {
	callback: () => void;
	delayMs: number;
	due: number;
	active: boolean;
	unrefs: number;
	unref(): void;
}

function fixture(onRevoke?: () => void) {
	let now = 0, wall = 0, revocations = 0, clockReads = 0, wallReads = 0;
	const timers: FakeTimer[] = [];
	const cleared: FakeTimer[] = [];
	const lease = new ArchiveUnlockLease({
		onRevoke() { revocations++; onRevoke?.(); },
		now() { clockReads++; return now; },
		wallNow() { wallReads++; return wall; },
		setTimer(callback, delayMs) {
			const timer: FakeTimer = {
				callback, delayMs, due: now + delayMs, active: true, unrefs: 0,
				unref() { this.unrefs++; },
			};
			timers.push(timer);
			return timer;
		},
		clearTimer(handle) { const timer = handle as FakeTimer; timer.active = false; cleared.push(timer); },
	});
	return {
		lease, timers, cleared, key: Buffer.alloc(32, 0x73),
		grant(selection: ArchiveUnlockMode = { mode: "process" }, revision = REVISION, owner = OWNER) {
			lease.unlock(this.key, owner, revision, selection);
		},
		advance(ms: number) { now += ms; wall += ms; },
		advanceMonotonic(ms: number) { now += ms; },
		advanceWall(ms: number) { wall += ms; },
		fire(timer: FakeTimer) { timer.active = false; timer.callback(); },
		revocations: () => revocations,
		clockReads: () => clockReads,
		wallReads: () => wallReads,
		activeTimers: () => timers.filter((timer) => timer.active),
	};
}

/** Observe owned allocations without exposing secrets through the production API. */
function observeCopies(t: TestContext): Buffer[] {
	const copies: Buffer[] = [];
	const original = Buffer.from;
	t.mock.method(Buffer, "from", (...args: unknown[]) => {
		const copy = Reflect.apply(original, Buffer, args) as Buffer;
		if (Buffer.isBuffer(args[0]) && args[0].length === 32) copies.push(copy);
		return copy;
	});
	return copies;
}

test("constructor and locked access allocate no timers or read the clock", () => {
	const f = fixture();
	assert.equal(f.lease.generation, 0);
	assert.deepEqual(f.lease.status, { unlocked: false, mode: undefined, deadlineRemainingMs: undefined, generation: 0 });
	assert.equal(f.lease.isUnlocked(REVISION), false);
	let calls = 0;
	assert.throws(() => f.lease.withKey(REVISION, () => { calls++; }), /locked/);
	f.lease.touch(); f.lease.sessionChanged(OWNER); f.lease.revoke(); f.lease.dispose();
	assert.equal(calls, 0);
	assert.equal(f.clockReads(), 0);
	assert.equal(f.wallReads(), 0);
	assert.equal(f.timers.length, 0);
	assert.equal(f.cleared.length, 0);
	assert.equal(f.revocations(), 0);
	const defaults = new ArchiveUnlockLease();
	assert.equal(defaults.generation, 0);
	defaults.dispose();
});

test("reject invalid constructor arguments without invoking supplied hooks", () => {
	for (const value of [null, 1, "bad", []]) {
		assert.throws(() => new ArchiveUnlockLease(value as unknown as ArchiveUnlockLeaseOptions), TypeError);
	}
	for (const name of ["onRevoke", "now", "wallNow", "setTimer", "clearTimer"]) {
		for (const value of [null, false, 1, "bad", {}]) {
			assert.throws(() => new ArchiveUnlockLease({ [name]: value } as ArchiveUnlockLeaseOptions), TypeError);
		}
	}
});

test("all untimed modes have no alarms or deadline and survive elapsed time", () => {
	for (const mode of ["session", "process", "persistent"] as const) {
		const f = fixture();
		f.grant({ mode });
		assert.equal(f.lease.generation, 1);
		assert.equal(f.lease.status.mode, mode);
		assert.equal(f.lease.status.deadlineRemainingMs, undefined);
		f.advance(MAX * 2); f.lease.touch();
		assert.equal(f.lease.isUnlocked(REVISION), true);
		assert.equal(f.timers.length, 0);
		assert.equal(f.clockReads(), 0);
		assert.equal(f.wallReads(), 0);
		f.lease.dispose();
		assert.equal(f.revocations(), 1);
	}
});

test("session boundaries revoke only session mode, not process/timed/persistent", () => {
	for (const selection of [{ mode: "session" }, { mode: "process" }, { mode: "persistent" }, timed(), timed(true)] as ArchiveUnlockMode[]) {
		const f = fixture(); f.grant(selection);
		f.advance(1000);
		f.lease.sessionChanged(OWNER);
		assert.equal(f.lease.isUnlocked(REVISION), true);
		f.lease.sessionChanged("fixture-other-main");
		assert.equal(f.lease.isUnlocked(REVISION), selection.mode !== "session");
		assert.equal(f.revocations(), selection.mode === "session" ? 1 : 0);
		if (selection.mode === "timed") assert.equal(f.lease.status.deadlineRemainingMs, MIN - 1000);
		f.lease.sessionChanged(OWNER); // Returning to an owner never restores a revoked grant.
		assert.equal(f.lease.isUnlocked(REVISION), selection.mode !== "session");
		f.lease.dispose();
	}
});

test("duration endpoints, fractional milliseconds, and both timed modes are accepted", () => {
	for (const idle of [false, true]) for (const durationMs of [MIN, MIN + 0.5, MAX]) {
		const f = fixture(); f.grant(timed(idle, durationMs));
		assert.equal(f.lease.status.mode, "timed");
		assert.equal(f.lease.status.deadlineRemainingMs, durationMs);
		assert.equal(f.timers.length, 1);
		assert.equal(f.timers[0]!.delayMs, Math.ceil(durationMs));
		assert.equal(f.timers[0]!.unrefs, 1);
		assert.ok(f.timers[0]!.delayMs <= MAX);
		f.advance(durationMs - 0.25);
		assert.equal(f.lease.isUnlocked(REVISION), true);
		f.advance(0.25);
		assert.equal(f.lease.isUnlocked(REVISION), false);
		assert.equal(f.revocations(), 1);
		assert.equal(f.activeTimers().length, 0);
	}
});

test("invalid keys, identities, or selections never displace a valid grant", () => {
	const f = fixture(); f.grant(timed(true));
	const assertPreserved = () => {
		assert.equal(f.lease.generation, 1);
		assert.equal(f.lease.isUnlocked(REVISION), true);
		assert.equal(f.lease.status.deadlineRemainingMs, MIN);
		assert.equal(f.revocations(), 0);
		assert.equal(f.timers.length, 1);
		assert.equal(f.cleared.length, 0);
		f.lease.withKey(REVISION, (key) => assert.deepEqual(key, f.key));
	};
	for (const key of [null, undefined, "key", new Uint8Array(32), Buffer.alloc(31), Buffer.alloc(33)]) {
		assert.throws(() => f.lease.unlock(key as Buffer, OWNER, REVISION, timed()), TypeError);
		assertPreserved();
	}
	for (const identity of ["", "a".repeat(513), null, 3, {}, undefined]) {
		assert.throws(() => f.lease.unlock(f.key, identity as string, REVISION, timed()), TypeError);
		assert.throws(() => f.lease.unlock(f.key, OWNER, identity as string, timed()), TypeError);
		assert.throws(() => f.lease.isUnlocked(identity as string), TypeError);
		assert.throws(() => f.lease.withKey(identity as string, () => {}), TypeError);
		assert.throws(() => f.lease.sessionChanged(identity as string), TypeError);
		assertPreserved();
	}
	const invalid = [null, undefined, "session", [], {}, { mode: "unknown" },
		...[-1, 0, MIN - 0.1, MAX + 0.1, NaN, Infinity, -Infinity, "60000", undefined]
			.map((durationMs) => ({ mode: "timed", durationMs, idle: false })),
		...[undefined, null, 0, 1, "false"].map((idle) => ({ mode: "timed", durationMs: MIN, idle }))];
	for (const selection of invalid) {
		assert.throws(() => f.lease.unlock(f.key, OWNER, REVISION, selection as ArchiveUnlockMode), TypeError);
		assertPreserved();
	}
	f.lease.dispose();
});

test("one- and 512-code-unit identities and a 32-byte Buffer view are accepted", () => {
	for (const length of [1, 512]) {
		const lease = new ArchiveUnlockLease();
		const backing = Buffer.alloc(64, 0x31);
		const key = backing.subarray(16, 48);
		lease.unlock(key, "o".repeat(length), "r".repeat(length), { mode: "session" });
		assert.equal(lease.isUnlocked("r".repeat(length)), true);
		lease.sessionChanged("o".repeat(length));
		lease.withKey("r".repeat(length), (temporary) => assert.deepEqual(temporary, key));
		lease.dispose();
		assert.ok(backing.every((byte) => byte === 0x31));
	}
});

test("grant copies the selection, key buffers, and leaves caller-owned copies alone", (t) => {
	const copies = observeCopies(t);
	const f = fixture();
	const selection = { mode: "timed", durationMs: MIN, idle: false } as const;
	f.grant(selection);
	const owned = copies[0]!;
	assert.notEqual(owned, f.key);
	assert.deepEqual(owned, f.key);
	Object.assign(selection, { mode: "session", durationMs: MAX, idle: true });
	f.key.fill(0x45);
	let borrowed!: Buffer, callerCopy!: Buffer;
	assert.equal(f.lease.withKey(REVISION, (key) => {
		borrowed = key;
		assert.notEqual(key, owned);
		assert.ok(key.every((byte) => byte === 0x73));
		callerCopy = Buffer.from(key);
		key.fill(0x22); // Does not mutate the owned grant.
		return 42;
	}), 42);
	zero(borrowed);
	assert.ok(owned.every((byte) => byte === 0x73));
	assert.equal(f.lease.status.mode, "timed");
	assert.equal(f.lease.status.deadlineRemainingMs, MIN);
	f.advance(1000); f.lease.touch();
	assert.equal(f.lease.status.deadlineRemainingMs, MIN - 1000, "mutating selection cannot enable idle refresh");
	f.lease.revoke(); zero(owned);
	assert.ok(f.key.every((byte) => byte === 0x45));
	assert.ok(callerCopy.every((byte) => byte === 0x73), "no zeroization promise for caller copies");
	callerCopy.fill(0);
});

test("withKey returns synchronous values and zeroes copies on success, throw, and direct return", () => {
	const f = fixture(); f.grant();
	const error = new Error("fixture callback failure");
	let borrowed!: Buffer;
	assert.throws(() => f.lease.withKey(REVISION, (key) => { borrowed = key; throw error; }), (caught) => caught === error);
	zero(borrowed);
	assert.equal(f.lease.isUnlocked(REVISION), true);
	assert.deepEqual(f.lease.withKey(REVISION, () => ({ ok: true })), { ok: true });
	assert.equal(f.lease.withKey(REVISION, () => undefined), undefined);
	zero(f.lease.withKey(REVISION, (key) => key));
	assert.equal(f.revocations(), 0);
	f.lease.dispose();
});

test("withKey rejects native async callbacks before invocation and thenables after invocation", () => {
	const f = fixture(); f.grant();
	let calls = 0, thenCalls = 0, borrowed!: Buffer;
	assert.throws(() => {
		// @ts-expect-error Async results are forbidden by the synchronous generic API.
		f.lease.withKey(REVISION, async (key) => { calls++; return key.length; });
	}, /synchronous/);
	assert.equal(calls, 0);
	assert.throws(() => f.lease.withKey(REVISION, (key) => {
		borrowed = key;
		return { then() { thenCalls++; } };
	}), /synchronous/);
	zero(borrowed);
	assert.equal(thenCalls, 0, "the guard must not execute an arbitrary thenable");
	assert.throws(() => {
		// @ts-expect-error Even a non-async function returning a Promise is forbidden.
		f.lease.withKey(REVISION, (key) => { borrowed = key; return Promise.resolve(1); });
	}, /synchronous/);
	zero(borrowed);
	assert.throws(() => f.lease.withKey(REVISION, null as unknown as () => number), TypeError);
	assert.equal(f.lease.isUnlocked(REVISION), true);
	f.lease.dispose();
});

test("a throwing then getter cannot bypass temporary-buffer cleanup", () => {
	const f = fixture(); f.grant();
	let borrowed!: Buffer;
	const error = new Error("fixture then getter");
	const result: { readonly then: unknown } = { get then() { throw error; } };
	assert.throws(() => f.lease.withKey(REVISION, (key) => { borrowed = key; return result; }), (caught) => caught === error);
	zero(borrowed);
	f.lease.dispose();
});

test("status contains only public lease metadata, never key, owner, or revision", () => {
	const f = fixture(); f.grant(timed(true));
	const snapshot = f.lease.status;
	assert.deepEqual(Object.keys(snapshot).sort(), ["deadlineRemainingMs", "generation", "mode", "unlocked"]);
	assert.equal(Object.isFrozen(snapshot), true);
	const serialized = JSON.stringify(snapshot);
	assert.equal(serialized, '{"unlocked":true,"mode":"timed","deadlineRemainingMs":60000,"generation":1}');
	assert.ok(!serialized.includes(f.key.toString("hex")));
	assert.ok(!serialized.includes(OWNER) && !serialized.includes(REVISION));
	assert.equal(JSON.stringify(f.lease), "{}", "private fields do not serialize secrets either");
	f.advance(1000); f.lease.touch();
	assert.equal(snapshot.deadlineRemainingMs, MIN, "previous snapshots are detached");
	f.lease.dispose();
	assert.equal(snapshot.unlocked, true);
});

test("absolute timing is never extended by touch, key use, status, or session changes", () => {
	const f = fixture(); f.grant(timed());
	f.advance(MIN - 1);
	f.lease.touch(); f.lease.sessionChanged("other-main");
	f.lease.withKey(REVISION, () => {});
	assert.equal(f.lease.generation, 1);
	assert.equal(f.lease.status.deadlineRemainingMs, 1);
	assert.equal(f.lease.isUnlocked(REVISION), true);
	assert.equal(f.timers.length, 1);
	f.advance(1);
	f.lease.touch();
	assert.equal(f.lease.isUnlocked(REVISION), false);
	assert.equal(f.revocations(), 1);
});

test("idle timing refreshes only explicit activity and lazily rearms one bounded timer", () => {
	const f = fixture(); f.grant(timed(true));
	const first = f.timers[0]!;
	f.advance(MIN - 1000); f.lease.touch();
	assert.equal(f.lease.status.deadlineRemainingMs, MIN);
	assert.equal(f.timers.length, 1, "activity does not allocate a timer per event");
	f.advance(1000); f.fire(first);
	assert.equal(f.lease.status.deadlineRemainingMs, MIN - 1000);
	assert.equal(f.timers.length, 2);
	assert.equal(f.timers[1]!.delayMs, MIN - 1000);
	assert.equal(f.activeTimers().length, 1);
	assert.equal(f.revocations(), 0);
	f.fire(first); // A replay of the old idle alarm cannot disturb its successor.
	assert.equal(f.timers.length, 2);
	assert.equal(f.revocations(), 0);
	f.advance(MIN - 1001);
	assert.equal(f.lease.isUnlocked(REVISION), true);
	f.advance(1); f.fire(f.timers[1]!);
	assert.equal(f.lease.isUnlocked(REVISION), false);
	assert.equal(f.revocations(), 1);
	assert.equal(f.activeTimers().length, 0);
});

test("idle reads, key access, generations, and main session changes are not activity", () => {
	const f = fixture(); f.grant(timed(true));
	for (let i = 0; i < 5; i++) {
		f.advance(10_000);
		assert.equal(f.lease.isUnlocked(REVISION), true);
		assert.equal(f.lease.status.deadlineRemainingMs, MIN - (i + 1) * 10_000);
		assert.equal(f.lease.generation, 1);
		f.lease.withKey(REVISION, () => {});
		f.lease.sessionChanged(`main-${i}`);
	}
	f.advance(10_000); f.lease.touch(); // Activity cannot resurrect an expired idle lease.
	assert.equal(f.lease.status.unlocked, false);
	assert.equal(f.revocations(), 1);
});

test("every live access enforces expiry even when the timer never runs", () => {
	for (const access of ["isUnlocked", "withKey", "touch", "sessionChanged", "status", "generation"] as const) {
		const f = fixture(); f.grant(timed(true));
		const timer = f.timers[0]!;
		f.advance(MAX); // Simulate a suspended event loop and a very late callback.
		let calls = 0;
		switch (access) {
			case "isUnlocked": assert.equal(f.lease.isUnlocked(REVISION), false); break;
			case "withKey": assert.throws(() => f.lease.withKey(REVISION, () => { calls++; }), /locked/); break;
			case "touch": f.lease.touch(); break;
			case "sessionChanged": f.lease.sessionChanged(OWNER); break;
			case "status": assert.equal(f.lease.status.unlocked, false); break;
			case "generation": assert.equal(f.lease.generation, 2); break;
		}
		assert.equal(calls, 0);
		assert.equal(f.lease.status.unlocked, false);
		assert.equal(f.revocations(), 1);
		assert.equal(f.activeTimers().length, 0);
		f.fire(timer); f.fire(timer); f.lease.revoke(); f.lease.dispose();
		assert.equal(f.revocations(), 1, access);
	}
});

test("vault revision mismatch immediately revokes every mode and never invokes callbacks", () => {
	for (const selection of [{ mode: "session" }, { mode: "process" }, { mode: "persistent" }, timed(), timed(true)] as ArchiveUnlockMode[]) {
		for (const access of ["isUnlocked", "withKey"] as const) {
			const f = fixture(); f.grant(selection);
			let calls = 0;
			if (access === "isUnlocked") assert.equal(f.lease.isUnlocked("vault:changed"), false);
			else assert.throws(() => f.lease.withKey("vault:changed", () => { calls++; }), /locked/);
			assert.equal(calls, 0);
			assert.equal(f.lease.isUnlocked(REVISION), false);
			assert.equal(f.lease.generation, 2);
			assert.equal(f.revocations(), 1);
			assert.equal(f.activeTimers().length, 0);
			for (const timer of f.timers) f.fire(timer);
			assert.equal(f.revocations(), 1);
		}
	}
});

test("a firing early alarm rearms at the deadline rather than polling", () => {
	const f = fixture(); f.grant(timed());
	const timer = f.timers[0]!;
	f.advance(1_234.5); f.fire(timer);
	assert.equal(f.timers.length, 2);
	assert.equal(f.timers[1]!.delayMs, Math.ceil(MIN - 1_234.5));
	assert.equal(f.activeTimers().length, 1);
	assert.equal(f.timers[1]!.unrefs, 1);
	f.fire(timer);
	assert.equal(f.timers.length, 2, "replayed alarms cannot rearm again");
	f.advance(MIN); f.fire(f.timers[1]!);
	assert.equal(f.revocations(), 1);
	assert.equal(f.activeTimers().length, 0);
});

test("late and replayed timers cannot revoke newer timed or untimed grants", () => {
	for (const selection of [timed(false, MIN * 2), { mode: "process" }, { mode: "persistent" }] as ArchiveUnlockMode[]) {
		const f = fixture(); f.grant(timed());
		const stale = f.timers[0]!;
		f.advance(1000); f.grant(selection); // Same revision, distinct grant/timer identity.
		assert.equal(f.revocations(), 1);
		assert.equal(f.lease.generation, 3);
		assert.equal(stale.active, false);
		f.advance(MIN); f.fire(stale); f.fire(stale);
		assert.equal(f.lease.isUnlocked(REVISION), true);
		assert.equal(f.lease.status.mode, selection.mode);
		assert.equal(f.revocations(), 1);
		if (selection.mode === "timed") {
			assert.equal(f.activeTimers().length, 1);
			f.advance(MIN); f.fire(f.timers[1]!);
			assert.equal(f.revocations(), 2);
		} else assert.equal(f.activeTimers().length, 0);
		f.lease.dispose();
	}
});

test("replacement, revoke, and dispose clear owned buffers and timers before onRevoke", (t) => {
	const copies = observeCopies(t);
	let expectedOwned: Buffer;
	let expectedGeneration = 2;
	const f = fixture(() => {
		zero(expectedOwned);
		assert.equal(f.activeTimers().length, 0);
		assert.equal(f.lease.status.unlocked, false);
		assert.equal(f.lease.generation, expectedGeneration);
		f.lease.revoke(); f.lease.dispose(); // Reentrant cleanup cannot notify twice.
	});
	f.grant(timed()); expectedOwned = copies[0]!;
	f.grant({ mode: "persistent" });
	zero(copies[0]!);
	assert.equal(f.lease.generation, 3);
	assert.equal(f.revocations(), 1);
	expectedOwned = copies[1]!; expectedGeneration = 4;
	f.lease.dispose(); f.lease.dispose(); f.lease.revoke();
	zero(copies[1]!);
	assert.equal(f.lease.generation, 4);
	assert.equal(f.revocations(), 2);
	assert.equal(f.cleared.length, 1);
	f.grant(); // Dispose is the specified revoke alias, not permanent disablement.
	assert.equal(f.lease.generation, 5);
	expectedOwned = copies[2]!; expectedGeneration = 6;
	f.lease.revoke();
});

test("reentrant revoke also clears in-flight temporary keys before its notification", () => {
	let first!: Buffer, second!: Buffer;
	const f = fixture(() => { zero(first); zero(second); });
	f.grant();
	f.lease.withKey(REVISION, (key) => {
		first = key;
		f.lease.withKey(REVISION, (nested) => {
			second = nested;
			f.lease.revoke();
			zero(first); zero(second);
		});
	});
	zero(first); zero(second);
	assert.equal(f.revocations(), 1);
});

test("notification errors still leave a revoked lease and a zeroed unadopted replacement", (t) => {
	const copies = observeCopies(t);
	const error = new Error("fixture backend close failed");
	const f = fixture(() => { throw error; }); f.grant(timed());
	assert.throws(() => f.grant(), (caught) => caught === error);
	zero(copies[0]!); zero(copies[1]!);
	assert.equal(f.lease.status.unlocked, false);
	assert.equal(f.activeTimers().length, 0);
	assert.equal(f.lease.generation, 2);
	assert.equal(f.revocations(), 1);
	f.lease.revoke(); f.lease.dispose();
	assert.equal(f.revocations(), 1);
});

test("reentrant grants during notification are refused without compromising cleanup", () => {
	const f = fixture(() => assert.throws(() => f.grant(), /during archive revocation/));
	f.grant(timed()); f.lease.revoke();
	assert.equal(f.lease.status.unlocked, false);
	assert.equal(f.revocations(), 1);
	assert.equal(f.activeTimers().length, 0);
});

test("scheduler failure revokes the newly granted secret exactly once", (t) => {
	const copies = observeCopies(t);
	let revocations = 0;
	const error = new Error("fixture scheduler failure");
	const lease = new ArchiveUnlockLease({
		now: () => 0,
		onRevoke() { revocations++; zero(copies[0]!); },
		setTimer() { throw error; }, clearTimer() { assert.fail("no timer was returned"); },
	});
	assert.throws(() => lease.unlock(Buffer.alloc(32, 0x29), OWNER, REVISION, timed()), (caught) => caught === error);
	assert.equal(lease.status.unlocked, false);
	assert.equal(lease.generation, 2);
	assert.equal(revocations, 1);
	lease.dispose(); assert.equal(revocations, 1);
});

test("clearTimer errors do not skip revocation notification or retain owned keys", (t) => {
	const copies = observeCopies(t);
	let revocations = 0;
	const error = new Error("fixture clearTimer failure");
	const lease = new ArchiveUnlockLease({
		now: () => 0, setTimer: () => 0,
		clearTimer() { zero(copies[0]!); throw error; },
		onRevoke() { zero(copies[0]!); revocations++; },
	});
	lease.unlock(Buffer.alloc(32, 0x29), OWNER, REVISION, timed());
	assert.throws(() => lease.revoke(), (caught) => caught === error);
	assert.equal(lease.status.unlocked, false);
	assert.equal(revocations, 1);
	lease.dispose(); assert.equal(revocations, 1);
});

test("injected numeric handles including zero are cleared and need no unref method", () => {
	const clears: ArchiveUnlockTimer[] = [];
	const lease = new ArchiveUnlockLease({ now: () => 0, setTimer: () => 0, clearTimer: (timer) => { clears.push(timer); } });
	lease.unlock(Buffer.alloc(32), OWNER, REVISION, timed());
	lease.dispose();
	assert.deepEqual(clears, [0]);
});

test("inline schedulers are rejected and their returned handle is cleaned up", () => {
	let clears = 0, revocations = 0;
	const lease = new ArchiveUnlockLease({
		now: () => 0, setTimer(callback) { callback(); return 0; },
		clearTimer() { clears++; }, onRevoke() { revocations++; },
	});
	assert.throws(() => lease.unlock(Buffer.alloc(32), OWNER, REVISION, timed()), /Invalid archive unlock timer/);
	assert.equal(clears, 1);
	assert.equal(revocations, 1);
	assert.equal(lease.status.unlocked, false);
});

test("invalid injected clocks reject timed grants without displacing an untimed lease", () => {
	for (const name of ["now", "wallNow"] as const) for (const value of [NaN, Infinity, -Infinity, "0"]) {
		let revocations = 0;
		const lease = new ArchiveUnlockLease({
			now: () => 0, wallNow: () => 0, [name]: () => value as number, onRevoke() { revocations++; },
			setTimer() { assert.fail("bad clock must not start a timer"); }, clearTimer() {},
		});
		lease.unlock(Buffer.alloc(32), OWNER, REVISION, { mode: "process" });
		assert.throws(() => lease.unlock(Buffer.alloc(32), OWNER, REVISION, timed()), /clock/);
		assert.equal(lease.isUnlocked(REVISION), true);
		assert.equal(lease.generation, 1);
		assert.equal(revocations, 0);
		lease.dispose();
	}
});

test("default timers use performance.now and Date.now, unref, and clear on disposal", (t) => {
	let now = 12_345.5, wall = 1_700_000_000_000, scheduled = 0, clockReads = 0;
	const handles: ReturnType<typeof setTimeout>[] = [];
	const cleared: ReturnType<typeof setTimeout>[] = [];
	const originalSet = globalThis.setTimeout;
	const originalClear = globalThis.clearTimeout;
	t.mock.method(performance, "now", () => { clockReads++; return now; });
	t.mock.method(Date, "now", () => { clockReads++; return wall; });
	t.mock.method(globalThis, "setTimeout", (...args: unknown[]) => {
		scheduled++;
		const handle = Reflect.apply(originalSet, globalThis, args) as ReturnType<typeof setTimeout>;
		handles.push(handle);
		return handle;
	});
	t.mock.method(globalThis, "clearTimeout", (...args: unknown[]) => {
		cleared.push(args[0] as ReturnType<typeof setTimeout>);
		Reflect.apply(originalClear, globalThis, args);
	});
	const lease = new ArchiveUnlockLease();
	assert.equal(scheduled, 0);
	assert.equal(clockReads, 0);
	try {
		lease.unlock(Buffer.alloc(32), OWNER, REVISION, timed());
		assert.equal(scheduled, 1);
		assert.equal(handles[0]!.hasRef(), false);
		now += 3000;
		assert.equal(lease.status.deadlineRemainingMs, MIN - 3000);
		wall += MIN;
		assert.equal(lease.isUnlocked(REVISION), false, "default wall clock detects paused monotonic time");
	} finally { lease.dispose(); }
	assert.deepEqual(cleared, handles);
	assert.equal(lease.status.unlocked, false);
});

test("suspend/wall advance expires on every access even with frozen monotonic time and a late timer", () => {
	for (const idle of [false, true]) for (const access of ["isUnlocked", "withKey", "touch", "sessionChanged", "status", "generation"] as const) {
		const f = fixture(); f.grant(timed(idle));
		const timer = f.timers[0]!;
		f.advanceWall(MIN); // CLOCK_MONOTONIC and its timer did not advance during suspend.
		let calls = 0;
		switch (access) {
			case "isUnlocked": assert.equal(f.lease.isUnlocked(REVISION), false); break;
			case "withKey": assert.throws(() => f.lease.withKey(REVISION, () => { calls++; }), /locked/); break;
			case "touch": f.lease.touch(); break;
			case "sessionChanged": f.lease.sessionChanged(OWNER); break;
			case "status": assert.equal(f.lease.status.unlocked, false); break;
			case "generation": assert.equal(f.lease.generation, 2); break;
		}
		assert.equal(calls, 0);
		assert.equal(f.revocations(), 1);
		assert.equal(f.activeTimers().length, 0);
		f.fire(timer); f.lease.touch();
		f.advanceWall(-MIN); // A later correction cannot revive the expired grant either.
		assert.equal(f.lease.isUnlocked(REVISION), false);
		assert.equal(f.revocations(), 1);
	}
});

test("wall forward movement is reflected in status and the next bounded alarm", () => {
	const f = fixture(); f.grant(timed());
	f.advanceWall(10_000);
	assert.equal(f.lease.status.deadlineRemainingMs, MIN - 10_000);
	f.fire(f.timers[0]!);
	assert.equal(f.revocations(), 0);
	assert.equal(f.timers[1]!.delayMs, MIN - 10_000);
	assert.equal(f.activeTimers().length, 1);
	f.advanceWall(MIN - 10_000);
	f.fire(f.timers[1]!);
	assert.equal(f.revocations(), 1);
	assert.equal(f.lease.status.unlocked, false);
});

test("wall rollback cannot extend an absolute lease past its monotonic deadline", () => {
	const f = fixture(); f.grant(timed());
	f.advance(20_000);
	f.advanceWall(-MAX);
	assert.equal(f.lease.status.deadlineRemainingMs, MIN - 20_000);
	f.lease.touch(); f.lease.withKey(REVISION, () => {});
	f.fire(f.timers[0]!);
	assert.equal(f.timers[1]!.delayMs, MIN - 20_000, "rollback cannot extend the alarm delay either");
	f.advanceMonotonic(MIN - 20_001);
	assert.equal(f.lease.isUnlocked(REVISION), true);
	assert.equal(f.lease.status.deadlineRemainingMs, 1);
	f.advanceMonotonic(1);
	assert.equal(f.lease.isUnlocked(REVISION), false);
	assert.equal(f.revocations(), 1);
});

test("idle touch resets both live deadlines, not just the monotonic deadline", () => {
	const f = fixture(); f.grant(timed(true));
	f.advance(20_000); f.lease.touch();
	f.advanceMonotonic(MIN - 1000);
	f.advanceWall(MIN - 1);
	assert.equal(f.lease.isUnlocked(REVISION), true, "wall deadline was refreshed by activity");
	assert.equal(f.lease.status.deadlineRemainingMs, 1);
	f.advanceWall(1);
	f.lease.touch(); // Monotonic time has not yet reached its refreshed deadline.
	assert.equal(f.lease.isUnlocked(REVISION), false, "wall expiry takes precedence over new activity");
	assert.equal(f.revocations(), 1);
});

test("idle activity after wall rollback still cannot exceed its refreshed monotonic limit", () => {
	const f = fixture(); f.grant(timed(true));
	f.advance(20_000); f.advanceWall(-MAX); f.lease.touch();
	assert.equal(f.lease.status.deadlineRemainingMs, MIN);
	f.advanceMonotonic(MIN - 1);
	assert.equal(f.lease.isUnlocked(REVISION), true);
	f.advanceMonotonic(1); f.lease.touch();
	assert.equal(f.lease.status.unlocked, false);
	assert.equal(f.revocations(), 1);
});

test("timer cleanup failure revokes access without an uncaught host exception", t => {
	const copies = observeCopies(t);
	const f = fixture(() => { throw new Error("fixture backend close failure"); });
	f.grant(timed()); f.advance(MIN);
	assert.doesNotThrow(() => f.fire(f.timers[0]!));
	assert.equal(f.lease.isUnlocked(REVISION), false);
	assert.equal(f.revocations(), 1);
	assert.equal(f.activeTimers().length, 0);
	zero(copies[0]!);
});

test("timer clock failure wipes the lease and attempts cleanup without escaping", t => {
	const copies = observeCopies(t);
	let badClock = false, alarm: (() => void) | undefined, revocations = 0;
	const lease = new ArchiveUnlockLease({
		now: () => { if (badClock) throw new Error("fixture clock failure"); return 0; },
		wallNow: () => 0,
		setTimer: callback => { alarm = callback; return 1; }, clearTimer: () => {},
		onRevoke: () => { revocations++; },
	});
	lease.unlock(Buffer.alloc(32, 0x47), OWNER, REVISION, timed());
	badClock = true;
	assert.doesNotThrow(() => alarm!());
	assert.equal(lease.isUnlocked(REVISION), false);
	assert.equal(revocations, 1);
	zero(copies[0]!);
});

test("wall-only expiry zeroes owned keys and clears the timer before notification", (t) => {
	const copies = observeCopies(t);
	const f = fixture(() => {
		zero(copies[0]!);
		assert.equal(f.activeTimers().length, 0);
		assert.equal(f.lease.status.unlocked, false);
	});
	f.grant(timed());
	f.advanceWall(MAX);
	assert.equal(f.lease.isUnlocked(REVISION), false);
	assert.equal(f.revocations(), 1);
});
