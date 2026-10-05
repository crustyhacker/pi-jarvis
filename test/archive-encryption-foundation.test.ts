import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createArchiveEnvelope, rewrapArchiveEnvelope, unlockArchiveEnvelope } from "../archive-crypto.js";
import { openEncryptedArchiveDatabase } from "../archive-sqlite.js";
import { ArchiveStore } from "../archive-store.js";

// Component interoperability only: no runtime activation, credential store or migration.
test("password envelopes unlock the encrypted archive and rewrap without rewriting its data", async () => {
	const root = mkdtempSync(join(tmpdir(), "jarvis-encryption-composition-"));
	const agent = join(root, "agent"), project = join(root, "project");
	mkdirSync(agent); mkdirSync(project);
	const marker = "fixtureunencryptedcanary7a9f";
	const entry = { id: "fixture-entry", parentId: null, type: "message", timestamp: "2026-10-04T00:00:00.000Z", message: { role: "user", content: marker } };
	const keys: Buffer[] = [];
	let store: ArchiveStore | undefined;
	try {
		const created = await createArchiveEnvelope("fixture old password, not a real secret");
		keys.push(created.key);
		store = new ArchiveStore(agent, { databaseFactory: (path, options) => openEncryptedArchiveDatabase(path, created.key, options) });
		assert.equal(store.append({ project, sessionId: "fixture-session", lane: "main", entry }), "saved");
		store.close();
		const encrypted = readFileSync(store.path);
		assert.equal(encrypted.includes(Buffer.from(marker)), false);
		assert.notEqual(encrypted.subarray(0, 16).toString(), "SQLite format 3\0");
		created.key.fill(0);
		await assert.rejects(unlockArchiveEnvelope(created.envelope, "fixture wrong password"), /Unable to unlock archive/);

		const unlocked = await unlockArchiveEnvelope(created.envelope, "fixture old password, not a real secret");
		keys.push(unlocked);
		const changed = await rewrapArchiveEnvelope(created.envelope, unlocked, "fixture replacement password");
		assert.equal(changed.vaultId, created.envelope.vaultId);
		assert.deepEqual(readFileSync(store.path), encrypted, "rewrapping touches no SQLite files");
		unlocked.fill(0);
		await assert.rejects(unlockArchiveEnvelope(changed, "fixture old password, not a real secret"), /Unable to unlock archive/);
		const replacement = await unlockArchiveEnvelope(changed, "fixture replacement password");
		keys.push(replacement);
		store = new ArchiveStore(agent, { databaseFactory: (path, options) => openEncryptedArchiveDatabase(path, replacement, options) });
		const page = store.search({ project, query: marker });
		assert.equal(page.records.length, 1);
		assert.equal(store.read(page.records[0]!.id, project)?.content, JSON.stringify(entry));
	} finally {
		try { store?.close(); } finally {
			for (const key of keys) key.fill(0);
			rmSync(root, { recursive: true, force: true });
		}
	}
});
