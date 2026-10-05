# Archive encryption design and operating contract — 1.10.0

Password-based archive encryption is **optional and OFF by default**, independently of archive enablement, capture, model access, shared memory, Repo tools and bridge permissions. It is agent-wide within the active Pi agent directory, shared by main Pi and Jarvis. Installation does not change user controls, encrypt an existing archive or import history. Public/private-key unlocking is deferred.

This document describes the password-based feature and its operating/security boundaries. It is **not an independent cryptographic audit, official/vendor-audited SQLCipher, FIPS certification, sandbox or forensic-erasure claim**.

## Safe initial setup

These controls are explicit human choices, not authorization for an agent/extension to change settings automatically.

1. Start Pi yourself with **`pi --tui-mode regular`**. Stop all other Pi instances using the agent directory, including older versions, before migration, recovery or cleanup. Check free space for both source and target; migration retains the source.
2. Review `/jarvis-archive status`: configured/effective enabled, capture and model-access fields, trust, errors and global/project paths. Project fields override global defaults, except explicit global enabled=false is master-off. Repair malformed settings manually without dropping privacy controls.
3. **If avoiding new plaintext archive captures, pause CAPTURE before enabling or migrating.** For the current project, explicitly choose `/jarvis-archive --project capture off` and verify effective capture off. Global capture off does not defeat project capture on; review all intended scopes. Do not begin sensitive work before verifying the pause. Pi's original transcripts and shared memory still follow their own behavior/controls.
4. Enable only the intended archive scope in a trusted project, keeping capture/model access off unless separately intended. For example, `/jarvis-archive --project on --confirm-sensitive` cannot override a global master-off; any global enablement must be a deliberate user choice recognizing other projects' exposure. Unlock, migration and cleanup require enabled/trusted archive policy, **not capture or model access**.
5. Run `encryption on --confirm-sensitive --confirm-stopped` through `/jarvis-archive`, enter the new password twice, and freshly verify each submission. Inspect encryption status and manually verify the active archive while capture remains off. Successful encryption grants a session unlock; it does not change capture settings or import old Pi history.
6. If removing plaintext remnants, verify the encrypted active archive is usable first, then explicitly run `encryption cleanup --confirm-sensitive --confirm-stopped` with a live unlock. Cleanup ends the local grant; unlock again, inspect status/retired plaintext counts and any partial-cleanup report. Outside backups/original transcripts are untouched. Do not describe retained plaintext copies as encrypted.
7. **Resume capture explicitly only when ready**, at the scope you paused, and check effective status again. Paused/locked periods are not backfilled. Model access remains a separate sensitive opt-in.

## Security boundary and key envelope

- Encrypt the **active archive SQLite database, FTS index and SQLite journal/WAL content**, not just message bodies. Ordinary encrypted operation creates no temporary plaintext database. Require `temp_store=MEMORY`; the pinned engine does not provide a newer encrypted-temporary-file guarantee.
- Generate a random 256-bit data key, independent of the password. The versioned password envelope uses asynchronous scrypt (`N=131072`, `r=8`, `p=1`, 32-byte salt, 256 MiB memory ceiling) and AES-256-GCM wrapping (12-byte nonce, 16-byte tag). KDF concurrency is bounded to two per process. Envelope parameters/identities are authenticated; unsupported/tampered envelopes fail closed.
- Passwords are valid Unicode, **1–4096 UTF-8 bytes**, without control characters or line breaks; there is no trimming/normalization. Choose a strong unique password and keep it outside Pi conversation history. There is no password-recovery bypass. Node's already-started scrypt work cannot be interrupted; stale/cancelled results cannot grant access.
- Password changes require a live encrypted unlock and existing-database authentication, ask for the new password twice, and end the local grant. They rewrap the **same data key**, not data-key rotation. Old key/envelope backups may still unlock data encrypted with that key.
- Remembered unlock explicitly stores the random data key, not the password, in an authorized OS credential store. Never use an unprotected key file. Missing/failed support leaves access locked, with no kernel-keyring, plaintext database, ordinary-input or alternate-credential fallback. A user can separately choose a manual password unlock; it is not an automatic downgrade.
- This does **not** encrypt original Pi JSONL/session files, shared-memory SQLite, external referenced attachments, exports, independently retained backups or previously retrieved/provider-sent context. Migration retains its source, including plaintext, until explicit cleanup. Vault metadata (generation identities, wrapping parameters, startup/grant policy) and filesystem metadata are not concealed.
- Authorized reads of an unlocked archive can send content to the active model/provider when model access is enabled; encryption does not replace that permission. Swap, core dumps, trusted extensions, native/runtime copies and malicious same-user code are outside protection. Buffer/reference clearing and file deletion are best effort, not forensic erasure.

## Password input and ownership

Use public `ctx.ui.custom` in the main editor area, not a nested overlay. Passwords never enter command arguments, environment variables, ordinary editors/history, model tools, session entries, notifications or logs. The public Input component sees masks, not secret undo/history. Password entry closes Jarvis and revokes its transient overlay permissions before using the main editor area.

**Only Pi regular TUI is supported:** the user explicitly starts `pi --tui-mode regular`. Non-TUI, fullscreen, missing and unknown renderer modes refuse password entry. There is no ordinary-editor/RPC/CLI/environment fallback and no automatic renderer-setting change. Stock fullscreen can process its search shortcut before a focused component and cannot provide this boundary.

**Every submission or cancellation intent**, including typed-only Enter, Escape and Ctrl+C, requires a **fresh displayed 12-symbol/60-bit verification code typed by hand, followed by Enter**. Pasted codes cannot authorize completion. Responses are bounded and not echoed. Repeated hostile input can deny service; tiny views may require resizing to read the code. This is not a timing/drain heuristic or proof that every transport byte has arrived.

Backend cancellation and UI lifetime are separate. Observed policy/trust/cancellation changes immediately revoke backend authorization and wipe owned secret references. They retain a **cancel-only private input sink** until a fresh post-cancellation code is verified. Backend resolution alone must not restore the ordinary editor into a buffered paste tail.

Private-input ownership is reserved **synchronously before** closing Jarvis or yielding for its public lifecycle. That owner spans preparation, deferred factory/mount, verification, cancellation sink and public custom completion. Jarvis, its model picker and main-memory deletion review share the admission gate; an already-open ordinary dialog causes refusal rather than overlapping mounting. Failed preparation safely releases only its own reservation without restoring an unrelated editor. Late callbacks cannot release a newer owner. Cancellable main switch/fork/tree navigation is refused while ownership remains; complete verified exit, then retry.

**Unsupported quarantine boundaries:** forced host reload/quit or trusted external focus replacement can restore/replace the editor before extension shutdown. Abandonment wipes/revokes owned state without stale `done()` or waiting for an unfocused sink, but cannot preserve input ownership after host/process teardown. Other trusted code with screen/input/process access is not isolated. Bytes after genuine human-verified release or host/process teardown are not quarantined. **Do not force reload/exit during password entry; use the displayed verified cancellation.**

## Human commands

These commands are local, agent-wide and human-only, not project-scoped settings or model tools. No password/key/path/scope arguments are accepted. Overlay `/archive …` interception remains local and does not boot a side model.

```text
/jarvis-archive encryption [status]
/jarvis-archive encryption on|off|cleanup --confirm-sensitive --confirm-stopped
/jarvis-archive encryption recover --rollback --confirm-sensitive --confirm-stopped
/jarvis-archive encryption break-lock --confirm-sensitive --confirm-stopped
/jarvis-archive unlock [session|process|remember|for MINUTES|idle MINUTES]
/jarvis-archive lock
/jarvis-archive password
/jarvis-archive startup manual|prompt|remember
```

- `encryption on` migrates the active archive to an encrypted generation. It does not enable recording/model access or change capture settings. Success unlocks for the current main session.
- `encryption off` converts the active archive to plaintext; it **does not turn recording off**. Conversely, ordinary `/jarvis-archive off` pauses archive access/capture without decrypting or deleting retained files. Neither setting disables Pi's original transcripts or shared memory.
- Enabled/trusted archive policy is required for unlocking, migration, cleanup, rollback recovery and normal data operations. Capture/model access can remain off for human administration/inspection. Encryption status and explicit lock remain available while archive data access is paused.
- `lock` revokes locally first, then attempts durable remembered-authorization revocation and best-effort credential deletion. Failure can leave remembered authorization/key material; report it honestly rather than silently repair. Status inspection is not a record read.
- Minutes are integers **1–10080**; default unlock is `session`. The confirmation flags are human acknowledgments of sensitivity and stopping other Pi instances, not commands that stop processes themselves.

## Unlock lifetimes and startup

- **Session:** owned by the main-session identity and shared with Jarvis. Side `/new` and overlay close do not end it; replacing the main session does.
- **Process:** process-local grant survives supported main `new`/`resume`/`fork` factory recreation, but not extension reload, quit or actual process restart. Old callbacks/context detach and native connections close before handoff.
- **Fixed duration (`for`):** original deadline is preserved through supported handoff, never renewed by status/access.
- **Idle (`idle`):** refresh only on successful archive data operations, never status/policy checks. Supported handoff preserves the current deadline. Timed grants use monotonic and wall-clock checks; expiry is enforced at operation boundaries even after suspend/delayed timers. No immediate key erasure during OS sleep is promised. Timers are lazy, bounded and unreferenced.
- **Remember:** persistent-local lease plus a unique explicitly authorized OS account holding the random key. `unlock remember` sets **startup remember**. `startup remember` requires an already unlocked encrypted archive and explicitly authorizes restoration; OS authorization/service availability applies.
- **Startup manual:** default, with no automatic password prompt or credential restore. Choosing it clears remembered authorization and locks locally.
- **Startup prompt:** clears remembered authorization and locks locally; later permitted main startup requests a password for a session grant, only through regular TUI.
- **Startup remember:** restores the explicitly remembered key on later permitted main startup, authenticating the existing database before granting access. Missing/corrupt/denied key/service stays locked, without an automatic password or backend fallback.
- **Forget/revoke semantics:** an explicit nonremember unlock clears prior remembered authorization (remembered startup becomes manual). Explicit lock rotates/clears durable authorization before best-effort native deletion; failed deletion may leave a key in the OS store, but successful durable revocation no longer authorizes that grant. Password rewrap clears remembered authorization and ends the local grant. Cleanup also ends the local grant; it does not necessarily clear an existing startup-remember choice.

Startup runs only from **main lifecycle**, never Jarvis boot. Archive full-off, untrusted/malformed policy and restart-required storage suppress prompts, credential work and database authentication. Restoring trust does not silently reuse a revoked local grant. Explicit lock, observed policy/trust failure, durable revision changes and unsafe storage can revoke any local grant.

Locked, transitional, invalid or restart-required vaults block record reads, capture, imports and ordinary deletion. Reset capture baselines; never queue plaintext for later recording or backfill after unlock. Cancel previews/imports and reject stale tools. Every observed trust denial, including a throwing trust getter, reaches the shared vault, not merely one lane's tool visibility. Restoring permission cannot revive an observed revoked grant. Recheck authorization after idle activity handling as well as after data operations; touching a lease can itself observe expiry. Import counts retain only acknowledged append outcomes even if a later guard/lock release fails; uncertain commits are not inferred or replayed. Cross-process durable revisions are observed at operation boundaries, **not instantaneous key erasure or push notification**.

Async prompts/KDF/keychain results bind to owner, revision, live policy and cancellation generations. Stale results cannot grant a newer owner or overwrite newer metadata. Final main/side journal snapshots precede side disposal and boot/lifetime invalidation; retiring-side cleanup must not accidentally revoke the main grant as a false new trust denial.

## Persistent layout and migration

- Fixed root: `<agentDir>/extensions/pi-jarvis-archive`. Plaintext defaults to `archive.sqlite`; managed storage uses strict bounded `archive.vault.json`, cooperative `archive.vault.lock` and generations `vaults/<UUID>/archive.sqlite`. No project-selected key/database paths.
- Metadata is at most **64 KiB**: versioned Ready or non-nested Transition, strict envelopes/identities, active generation, startup grant and at most **eight distinct retired generations**. Further migration requires explicit cleanup when at capacity. Ready `active=legacy` with no envelope is reserved for explicit initial rollback. Unknown fields, duplicate JSON members and unsupported metadata are rejected, not automatically repaired.
- Canonicalize only the selected agent root. Appended owned paths retain no-follow, ownership, identity and privacy checks. The managed marker makes older strict-layout Jarvis code refuse rather than silently write plaintext. This is a cooperative boundary, not a hostile-filesystem/same-user sandbox.
- Serialize managed operations under a bounded cooperative lock with same-directory fsync/rename publication. No automatic stale-lock stealing, uncertain-write replay or unsafe deletion. Explicit break-lock requires a demonstrably dead local PID on the same host and identity/token rechecks; live/unknown locks are refused. Stop **all other Pi instances**, including old versions, before migration/recovery/cleanup.
- Source/active-file observations use stat-only identity, ownership, type, permission and link checks. Never open and close another database/SHM descriptor to inspect a live SQLite file: POSIX close can release that process's native transaction locks. These checks preserve locks, not an immutable filesystem snapshot.
- Migration records Transition before creating a fresh target. Hold a stable source transaction; stream exact stored raw JSON spelling, index text, provenance, row IDs and tombstones; verify typed hashes/counts and FTS integrity. Checkpoint, close and fsync the target before Ready publication. Preserve noncanonical valid raw JSON spelling; do not parse/stringify or renormalize accepted raw/index text during transfer. This preserves logical data/index semantics, not identical physical database bytes.
- An originally absent legacy source is a legitimate empty archive; a missing published/known source is not. Record initial legacy-source presence and recheck before copying and rollback deletion. A missing/empty/unsafe/changed known source leaves the unpublished target/Transition available for **manual inspection/restoration**, never empty replacement publication or deletion of the only potential copy. Prototype metadata with unknown presence is conservative. Checks do not prove a hostile filesystem snapshot or every source page's durability.
- Keep the source as an explicit retired generation, **including any plaintext source**. Encryption does not remove this exposure automatically. Status identifies active storage and retired plaintext counts. Disk capacity must cover both generations; no hard total-disk quota or automatic retention eviction. Outside backups are not cleaned up.
- **Plaintext conversion refuses fixed/idle timed unlocks before key copying or Transition publication.** Explicitly select `unlock session` or `unlock process` first if intending conversion; migration must not extend a timed grant by copying its key and stopping the timer.

## Cleanup and explicit recovery

Cleanup affects only recognized retired SQLite files under the owned layout, never active storage, arbitrary files or outside backups. It preflights/pins candidates, deletes auxiliaries before the main database, and rechecks source/live authorization between deletions. Encrypted active cleanup requires a live lease and **existing-database authentication** before deleting anything. A missing active database, encrypted or managed plaintext, is not recreated and cannot authorize deleting potential backups.

A failed unlink/fsync or mid-cleanup authority loss can leave a **partial retained backup**. Metadata is retained as appropriate to the failed operation; uncertain deletion is not automatically replayed. Inspect status/files, do not promise rollback or that all retained backup files remain complete. Successful cleanup ends the local lease; unlock again before encrypted record access/capture. Plaintext sources, originals and outside backups require separate human assessment; deletion is not forensic erasure.

Explicit `recover --rollback` is a separate **source-checked, unpublished-target-only** recovery operation, not automatic migration retry/resume. It requires a pending Transition and safe verification of the recorded source presence/absence before target deletion. A missing known source requires manual inspection/restoration and preservation of the potential target copy. Rollback preserves a managed marker, ends the local grant, and establishes a fresh capture baseline without backfill. Invalid metadata is not repaired automatically.

## Uncertain native resources and publication

A native close error can leave a live handle, including when opening/authentication fails before the Store receives it. Preserve the sanitized own-data `closeFailed` signal through adapter, Store and migration failures. Never retry uncertain close or delete/recover files beneath such a handle.

A bounded canonical-root process registry marks restart-required uncertainty. It survives fresh facades, aliases, main-session changes and logical module reload/quit; disposal does not evict/reset it. Overflow/unknown-root uncertainty fails closed. **Only an actual Pi process restart resets this state.** No startup credentials/database authentication or cleanup/rollback while restart-required.

Grant access only after successful lock release and fresh owner/policy/revision checks. A thrown rename/fsync/release can follow successful publication: **publication may have succeeded**. Require status/manual inspection and actual-process restart before further access/recovery, never invent a guaranteed Transition or replay an uncertain operation. Restart clears the process-local safety block, not missing sources, invalid metadata or a durable Transition. Stale catches cannot mutate/revoke newer owners; genuine leaked-resource uncertainty remains root-wide.

## Native dependencies and compatibility

- Exact optional **`better-sqlite3-multiple-ciphers@13.0.3`**, lazy loaded. Set/read back the SQLCipher-4-compatible AES-256-CBC/HMAC-SHA512 profile, use binary `raw:` key encoding and authenticate schema before initialization. A bare 32-byte `.key()` input would invoke a password KDF instead.
- `node:sqlite` remains the plaintext default. No encrypted-open failure falls back to it. Missing/omitted/incompatible bindings fail explicitly; runtime does not execute install scripts or auto-build/download fallback binaries. Development dependencies may be installed with lifecycle scripts disabled, but encrypted operation still requires a usable native binding.
- Linux glibc prebuilds require **glibc >=2.35**. Upstream advertises musl/macOS/Windows binaries, but **local runtime validation is Linux-only**. Other platforms are not certified by that evidence. This is SQLite3MultipleCiphers compatibility, not an official/vendor-audited SQLCipher binding or FIPS claim.
- No `sqlcipher_export`/`sqlite3mc_export`; ordinary backup cannot select a keyed destination. Use the separately keyed verified streaming migration, not those unsupported APIs.
- Exact optional **`@napi-rs/keyring@2.1.0`**, asynchronous API. Linux explicitly selects **Secret Service**, with no kernel-keyring downgrade; macOS/Windows use the adapter's native OS stores. Unique opaque grant accounts, no credential enumeration. Service availability/platform authorization applies; headless or locked services may refuse remembered unlock. Manual password unlock does not require storing a remembered key.

## Engineering validation scope

Local runtime validation used Linux, temporary synthetic agent/workspace/archive/history directories, fake prompts/keychains/providers, disposable native SQLite and actual public Pi renderers/splitter with in-memory terminals. It did not inspect/migrate user archives, resolve real OS credentials or call providers/network. Recorded full matrices covered **Node 22.19.0 / 24.21.0** and **Pi 1.0.0 / 1.0.2**. Pi 1.0.0 and Node >=22.19.0 remain the minimum baseline; older hosts are unsupported.

Regression coverage includes wrong/tampered keys, missing dependencies, encrypted FTS/WAL/journal canaries, exact migration fidelity, native before-close failure handles, stale completions, timed expiry, policy/trust changes, lifecycle handoff, source loss and partial cleanup. Private-input review used public regular-host routing and adversarial admission/cancellation schedules; finite tests are not proof of exhaustive transport timing or isolation from trusted code. Keychain validation uses injected fakes, **not real OS credential integration certification**.

Engineering tests and scoped code review are not an independent cryptographic audit, platform-wide guarantee or forensic-erasure proof. Release maintenance must keep README/AGENTS/help/changelog and stable package metadata synchronized, validate full tests/build/package payload, and use the repository's annotated stable-version policy. No automatic live-data activation accompanies a version upgrade.
