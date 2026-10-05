# Changelog

This changelog tracks the documented release history of this project. Earlier entries were reconstructed from the repository's release tags where fuller notes were not preserved at release time.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

> Historical note: releases before the `pi-jarvis` 1.x line refer to the project's earlier `pi-btw` and `/btw` naming. Those entries are preserved as historical release records and do not describe the current product name or command surface.

## [1.11.4] - 2026-10-05

### Documentation and showcase
- Expand the GitHub/npm landing page into a benefit-led showcase of shared memory, searchable history/import, optional archive encryption, independent side sessions, background work, model/thinking controls, local/native MCP tools and confirmed main-session handoffs.
- Add three deterministic, self-contained SVG workflow diagrams with descriptive text alternatives, plus a reproducible Playwright visual check for desktop/narrow layouts and SVG text bounds. Runtime packages do not gain a browser dependency.
- Correct stale documentation that associated ordinary overlay close with grant revocation; fresh-owner defaults and explicit stop/access-off remain distinct.
- Documentation, artwork and package-discoverability only: runtime behavior, controls, stored data and installed user settings are unchanged. npm publication remains manual.

## [1.11.3] - 2026-10-05

### Presentation refinement
- Soften flat tool-gray panels with a subtle blend from the active message palette, rejecting blends with insufficient body-text contrast. Preserve public theme/256-color rendering and minimal-theme fallbacks.
- Highlight keyboard-focused controls without changing labels or access states; clarify the conversation title and add short, quiet speaker-heading rules without extra rows or source-offset changes.
- Use rounded, focus-sensitive prompt borders and a stronger active prompt prefix. Refresh the deterministic renderer preview; no task, permission, model, scrolling, memory/archive or user-setting behavior changes.

## [1.11.2] - 2026-10-05

### Fixed
- Correct a cold archive-reader filesystem-observation race exposed by release validation: a creator can publish the main SQLite file and auxiliaries between separate stat checks. Re-observe a missing main file before declaring a true orphan; retain unsafe/pinned-missing-file refusals, read-only initialization rules and no uncertain-write replay.
- Preserve the 1.11.1 commit/tag after its release validation stopped before publication. This corrected release includes the conversation-first visual polish.

## [1.11.1] - 2026-10-05

### Presentation
- Give the conversation a distinct, padded reading panel with clearer message separation, calmer theme-aware surfaces and bounded paragraph width.
- Reduce default header clutter, keep named access states and controls discoverable, and move verbose focus/settings/diagnostics behind Ctrl+O. Use quieter contextual hints and summarized informational notices without hiding warnings/errors.
- Choose an initial overlay width capped at 118 columns using Pi's public geometry API; the body reading column caps at 96. The host clamps on shrink; reopen after enlargement to recalculate width. Refresh the deterministic README renderer preview.
- Preserve 1.11.0 task continuation, in-memory grants, stopping, scrolling, model/thinking selection and private-input boundaries. This is a presentation patch; no user theme/renderer/settings changes, new memory behavior or archive migration.

## [1.11.0] - 2026-10-05

### Overlay fixes
- Separate closing Jarvis's window from stopping assigned work; preserve in-memory Repo tools, Note main and Redirect choices across same-owner close/reopen. Keep background activity/access visible in main Pi with explicit local status, stop and access-off controls.
- Add in-window model/thinking selection using existing scoped settings without changing the main session model or thinking. Refuse changes during active work and invalidate stale picker/configuration results.
- Make transcript navigation discoverable with keyboard history focus and supported fullscreen wheel scrolling, while preserving the reading anchor as output arrives.
- Give the multiline prompt a distinct terminal-style message panel, retaining indentation, bounded draft validation and paste-before-shortcut handling.

### Permission and lifetime boundaries
- Closing cancels pending human reviews and refuses invisible future confirmations; Redirect never bypasses per-send approval. Access-off, observed trust denial, side `/new`, owner/reference replacement and teardown still revoke grants. Archive private-input preparation explicitly revokes grants before closing/yielding.
- Background work is owned by the live Pi session, not a detached daemon. Stop/revocation is best effort, not rollback or automatic replay; memory/archive controls remain independent.

## [1.10.2] - 2026-10-05

### Documentation and package discoverability
- Lead the GitHub/npm landing page with persistent memory shared by main Pi and Jarvis, including use without the overlay, reusable preferences/project decisions and searchable conversation captures.
- Add a one-minute, command-driven memory workflow, concrete cross-session use cases, scoped search and immediate privacy controls. Keep the optional full-session archive, explicit history import and archive-only encryption clearly separate.
- Refresh package description and search keywords. This is a documentation/metadata release: runtime behavior, defaults, user settings and stored data are unchanged; npm publication remains manual.

## [1.10.1] - 2026-10-05

### Fixed
- Make bulk-import receipt tests independent of filesystem directory enumeration order, including explicit forward/reverse discovery coverage. Retain exact acknowledged counts, EOF cancellation, unprocessed-file and unchanged-source assertions; runtime behavior is unchanged.
- Preserve the `v1.10.0` commit/tag after GitHub validation exposed the test-only ordering assumption. Its release job stopped before publishing an artifact; 1.10.1 is the corrected password-encryption release.

## [1.10.0] - 2026-10-05

### Added
- Optional password encryption for the full-session archive's active SQLite database, FTS index and journal/WAL content. Encryption is OFF by default and agent-wide, independent of recording, model access, shared memory and Repo tools; no existing archive or setting is automatically migrated or changed.
- Human-only local encryption status/on/off, unlock/lock, password rewrap, startup policy, verified generation migration, explicit rollback recovery, retired-source cleanup and abandoned-lock controls. Migration/recovery/cleanup require `--confirm-sensitive --confirm-stopped`; rollback also requires `--rollback`. Sources are retained until explicit cleanup, with at most eight retired generations.
- Main-session, process, fixed-duration, idle and explicitly OS-backed remembered unlock choices. Main Pi and Jarvis share a main-owned lease; supported main new/resume/fork handoffs preserve non-session grants and original timed deadlines. Startup defaults to manual; prompt/remember are explicit main-lifecycle choices.
- Private masked password entry only in Pi regular TUI (`pi --tui-mode regular`), with fresh typed verification for every submit/cancel, including typed-only input. Immediate backend cancellation retains a private cancel-only sink until verified exit; coordinated Jarvis/model-picker/main-memory-review admission prevents overlapping ordinary dialogs.

### Fixed
- Full-page archive reads accept valid noncanonical JSON without rewriting its original spelling; migration preserves exact raw/index/provenance data.
- Import partial counts retain acknowledged append outcomes when a later permission check or lock release fails, while uncertain commits remain uncounted and remaining work stops without replay.
- Preserve final side/main archive snapshots before ownership invalidation. Encryption guards preserve native SQLite locks, revoke on throwing/mid-operation trust denial, and recheck expiry after idle activity handling.

### Safety and limitations
- Plaintext remains the archive default; shared memory remains plaintext and unchanged. Encryption does not protect original Pi transcripts, attachments/exports, retained plaintext sources, outside backups or already-retrieved/provider-sent context. Password change rewraps the same random data key, not key rotation. Public/private-key unlocking remains deferred.
- Safe setup guidance reviews effective global/project controls and pauses CAPTURE before enabling/migrating when avoiding new plaintext archive captures. Archive administration requires enabled/trusted policy, not capture/model access; verify unlock/storage/cleanup before explicitly resuming capture. Global capture-off does not defeat project overrides. No automatic user-control or renderer changes.
- Locked/transition/invalid/unsafe vaults block reads, capture, imports and ordinary deletion without plaintext fallback or history backfill. Timed/idle grants cannot convert to plaintext; explicitly unlock session/process first. Missing known sources require manual inspection/restoration and preservation of possible target copies. Cleanup rechecks authorization between auxiliary/main deletions and may leave partial retained backups.
- Uncertain native cleanup, publication or lock release requires an actual Pi process restart before further access/recovery; logical reload/quit and new facades do not clear that safety block. Publication may already have succeeded; no automatic repair or replay of uncertain operations. Durable revisions are observed across processes at operation boundaries, not instant key erasure.
- Forced host reload/quit or trusted external focus replacement cannot preserve password-input quarantine; use verified cancellation. Trusted same-user code, swap/core dumps and post-verified-release/teardown input are outside this boundary. No independently audited cryptography, official/vendor-audited SQLCipher, FIPS, sandbox or forensic-erasure claim.
- Exact optional native backends are lazy loaded and fail closed when missing/incompatible. Linux glibc prebuilds require glibc >=2.35; local runtime validation is Linux-only. Remembered unlock requires an authorized OS credential service (Linux explicitly Secret Service, no kernel-keyring downgrade); real OS credential integration and other platforms are not certified by the local synthetic validation. No runtime install-script/build/download fallback.

## [1.9.1] - 2026-10-04

### Fixed
- Close a cold-start archive-reader race exposed by clean-runner release validation: readers can observe a newly created empty file before a concurrent writer finishes initializing it. Wait only within a bounded initialization window, without initializing/resetting the file or replaying record writes. Unknown nonempty schemas remain errors.
- Retain the 1.9.0 commit/tag without rewriting history; its GitHub package workflow was blocked by validation. This patch carries the bulk-import feature forward to a validated package release.

## [1.9.0] - 2026-10-04

### Added
- Human-only bulk history import: `/jarvis-archive import-all` recursively previews existing Pi session files under the active agent directory, or an explicitly selected directory, before a separate sensitive-data confirmation.
- One-use, expiring previews pin the reviewed file inventory; added files are not automatically included. Sequential imports preserve source project/session provenance, skip identical entries and tombstoned identities, and report malformed/legacy/conflicting files individually without modifying originals.
- Bounded, paged `/jarvis-archive import-report` results and `/jarvis-archive import-cancel`, with partial-commit counts and execution-time trust, policy, cancellation and session checks. No new model tools or automatic historical ingestion.

### Fixed
- Cooperative archive settings writers now recover an atomic-replacement race in the unlocked no-op preflight by rereading once under the existing lock. Policy readers and locked-read races still fail closed; malformed settings are never repaired and uncertain writes are never replayed. A lock released during pathname lookup is treated as contention within the existing bounded exclusive-acquisition loop, never stolen or blindly removed.

### Safety and documentation
- Bounded metadata-only discovery skips nested symlinks, hardlinked/nonregular files; incomplete or over-limit scans fail rather than producing a misleading partial preview. Reviewed source/directory identities are rechecked and bulk streams are capped at reviewed sizes. Concurrent changes are reported; this is not a filesystem snapshot or sandbox.
- Advertise bulk import alongside both independent memory features: default-on shared memory and the disabled-by-default full-session archive. Archive recording/model access remain explicit opt-ins; npm publication remains manual.

## [1.8.0] - 2026-10-04

### Added
- Separate optional full-session archive, OFF by default, explicitly mounted in main Pi and Jarvis independently of shared memory, Repo tools and bridge permissions.
- Global/project recording controls, a global master off switch, separately opt-in model access, and explicit sensitive-data acknowledgment. `/jarvis-archive` and overlay `/archive` controls run locally without model/queue work.
- Local SQLite FTS5 search, cross-project queries by explicit request, paged session browsing and raw-entry reads, session provenance/parent links, and complete accepted finalized entry payloads including exposed thinking, tool details and inline images.
- Human-only explicit v3 JSONL import with duplicate detection, partial/cancellation reporting, scoped deletion/pruning and identity tombstones. No automatic history import, context injection, eviction, external attachment reads, embeddings or background model calls.

### Documentation
- Promote both complementary memory features in the README: default-on shared memory and the separate, disabled-by-default full-session archive, with a side-by-side comparison of controls, retrieval and privacy.

### Safety and limitations
- Raw archive storage defaults to unredacted plaintext and can retain credentials/private data (optional archive-only encryption is added in 1.10.0); model reads can send it to the active provider. Off blocks record reads/writes while retaining data; trust/config failures pause access.
- Capture uses finalized journal snapshots after message-redaction hooks. It is not a crash-safe event/wire log: hidden/unpersisted content, earlier truncation, disabled periods and late shutdown writes cannot be recovered automatically. Oversized raw/index data beyond 64 MiB and pathological normalization contexts beyond 64K UTF-16 units are rejected explicitly, never silently shortened. Conflicting payloads for an existing identity fail without overwriting history.
- Bounds apply to search/read output, not accepted persisted payloads. Storage grows until explicit cleanup or filesystem limits; large writes/indexing can pause the UI. Deletion does not erase transcripts, result copies, backups or already-sent context, and is not forensic erasure.

## [1.7.0] - 2026-10-04

### Added
- Persistent local memory shared by main Pi and Jarvis across sessions and projects, enabled by default in trusted workspaces with first-use disclosure and a global master off switch.
- Separate automatic capture/recall controls, per-project overrides, and `/jarvis-memory` status, search, inspect, remember, edit, and forget commands. `/memory` inside the overlay manages memory immediately, independently of queued side work and Repo tools.
- Bounded new-message archive plus model-curated preferences, corrections, decisions and references with project/session provenance. Local keyword retrieval supplies request-local, explicitly untrusted context; all-project search is explicit. No old-session import, embeddings or background model calls.
- Lazy, permission-restricted SQLite persistence, concurrent-writer transactions, deterministic deduplication, identity tombstones, bounded retention, and isolated content/config/store/runtime regression coverage.

### Safety and limitations
- All model/thinking set/clear commands now preserve malformed shared JSON and require manual repair, rather than silently discarding memory privacy settings during recovery. Parse errors no longer echo input snippets.
- Capture waits for Pi's final message replacements/redaction hooks; bounded metadata-only staging never imports historical branches. Memory guidance survives Pi's forced side-prompt projection without becoming persisted prompt history.
- Full disable blocks capture, memory reads, injection and tool execution while retaining data. Untrusted projects and malformed/unreadable settings fail closed. Memory can share facts between lanes even with Note main off; it follows separate persistent controls, not overlay lifetime.
- Exclude thinking, tool results/calls, custom/system messages, attachments and failed/aborted outputs from automatic capture. Best-effort secret filtering is not a guarantee; local memory is plaintext, and recalled data reaches the active model.
- Recheck settings/trust and permission generations at execution. Model-requested forgetting requires cancellable confirmation and an atomic reviewed-version comparison; explicit user commands support scoped bulk deletion.
- Forgetting does not erase other mentions, original Pi transcripts, already-sent model context or backups, and SQLite deletion is not forensic erasure. Record writers coordinate across processes; legacy model/thinking config writes do not participate in the new memory-settings lock.

## [1.6.1] - 2026-10-03

### Added
- Original ASCII wordmark with a short, one-time cyan/violet/pink chrome intro on the first Jarvis open for each main session in the loaded extension.
- Immediate input/paste dismissal without losing input; confirmation and error precedence, tiny-terminal fallback, light/256-color support, and a reduced-motion opt-out via `PI_JARVIS_NO_ANIMATION=1`. Non-empty `NO_COLOR` and `TERM=dumb` also skip the intro.
- Matching GitHub README artwork, an actual-renderer demo preview, CI badge, and clearer native MCP feature coverage. Artwork is reproducible with `npm run render:branding` using local fixtures only.

### Safety and lifecycle
- The intro never delays runtime startup or queued prompts, changes permissions, or writes to session history. Its unreferenced timer stops on expiry, input, or overlay disposal.
- Reopen, side reset/tree navigation, and returning to an already-opened main session do not replay it. Restarting Pi or reloading the extension resets the in-memory first-open tracking.

## [1.6.0] - 2026-10-03

### Added
- Native Pi MCP in the isolated side-session, sharing the explicit Repo tools opt-in; direct, deferred, codemode, and resource calls use live permission and lifetime checks.
- Fresh MCP permission generations, guarded late registrations, cancellation signals, and native shutdown requests on disable or disposal. No MCP configuration/credential expansion or connections start while initially disabled.
- GitHub Actions for validation, annotated-tag policy checks, and release-tag packaging. Only matching annotated `vX.Y.Z` tags create GitHub releases; npm publishing remains manual.
- Deterministic local MCP integration fixtures and release-automation regression tests, plus `RELEASING.md` and `npm run check:tags`.

### Changed
- Every new commit requires an annotated stable `vX.Y.Z` tag and matching package, lockfile, README, and dated changelog versions. CI rejects prerelease and SHA-only coverage; there is no development-tag channel.

### Safety and limitations
- Jarvis uses its own MCP connections to configured servers; it does not take ownership of the main session's connections. Project MCP configuration honors project trust, and server administration stays in main Pi.
- Revocation blocks new Jarvis executions and requests cancellation; already-started native handshakes, authentication refreshes, or remote operations can finish or time out under Pi's lifecycle. Cancellation is not immediate teardown, rollback, or a sandbox.
- Codemode model helpers are disabled; this integration does not add classifier/image-model dispatch or restore the legacy MCP adapter.
- CI checks report tag-policy violations; enforcing protected branches/tags still requires repository rules. Stable-only tagging starts after historical commit `4b6b4e6`; already-pushed history is preserved rather than rewritten.

## [1.5.0] - 2026-10-03

### Added
- Compact, theme-aware overlay header with Ctrl+O diagnostics and independent startup, working, queue, and error feedback.
- PageUp/PageDown transcript scrollback with paused-reading position, hidden-line counts, and Ctrl+End return to live output.
- Public Pi multiline editor: Enter sends, Shift+Enter/Ctrl+J adds a line, and unsent drafts survive overlay close/reopen within the same side thread.

### Changed
- Cache wrapped transcript blocks and bound the overlay view to recent content with explicit omission notices; persisted session history is unchanged.
- Keep prompt history separate from changing transcript projections; side `/new` and main-session replacement clear drafts and recall history. Side-tree navigation resets scroll without discarding drafts.
- Reject unsafe or oversized pasted drafts explicitly rather than silently flattening, truncating, or submitting them; drafts are limited to 64 KiB.
- Preserve confirmation-review priority, permission revocation, generation-safe queue ownership, and no automatic replay of uncertain sends.
- Add focused layout, editor, scroll, queue, and integration regressions to the default test suite and verify the new packaged modules.

## [1.4.0] - 2026-10-03

### Changed
- Updated the validated host to Pi 1.0.0 (`@earendil-works`) and Node.js 22.19+, retaining optional host peers and no bundled runtime stack.
- Replaced obsolete SDK/picker APIs; physical-model requests delegate to the host registry, preserving custom providers and runtime-only authentication.
- Disabled unvalidated legacy MCP adapter auto-loading. This release is local-tools-only; native MCP and virtual/router models are explicitly unsupported.
- Added `max` thinking configuration and live follow-main thinking synchronization.

### Fixed
- Prevented stale boots, queues, and overlay callbacks from crossing main-session resets; side `/new` no longer starts duplicate flushes or detaches the overlay.
- Reconciled side-session references after main-tree navigation and stopped automatic replay of failed commands or uncertain sends.
- Preserved project override precedence during global writes; made config writes atomic and prevented destructive recovery from file I/O errors.
- Honored project trust in side resources/settings, cleaned up failed initialization, and supplied the correct workspace for lazily created session files.
- Rechecked local-tool and bridge permissions at execution time, cancelled pending redirects on abort/close, prevented sends after revocation, and rejected hidden terminal-control content in bridge messages.
- Used Pi's context projection for context edits and compaction ordering; recognized normal bash tool results in validation summaries and preserved concurrent tool identity.
- Distinguished attempt completion from final settlement during recovery; exposed side errors and refreshed live overlay state.
- Fixed narrow/short rendering, stale history indices, keyboard protocols/keybindings, terminal-control sanitation, light-theme rendering, and clipped redirect confirmations through mandatory paged review.
- Guarded terminal-only commands in RPC/JSON/print modes and awaited asynchronous model refresh.

### Validation
- Migrated existing tests to Pi 1.0.0 and added deterministic SDK, lifecycle, config, context, picker, and regular/fullscreen overlay regressions.
- Strengthened release metadata, lockfile, and tarball-content checks.

## [1.3.2] - 2026-04-28

### Fixed
- Reduced the default npm install footprint by keeping Pi host packages and `pi-mcp-adapter` as optional peer dependencies instead of installing the full Pi/AI/MCP dependency stack with `pi-jarvis`.

### Changed
- Documented optional MCP adapter behavior and added package-manifest regression coverage for the lightweight install contract.

## [1.3.0] - 2026-04-27

### Added
- Added `/jarvis-thinking` with project/global `auto`, `follow-main`, explicit thinking-level, and `clear` settings so `/jarvis` thinking can be configured independently from the main session.
- Added side-session handling for `/compact`, `/tree`, and `/new` when those commands are entered inside `/jarvis`.

### Changed
- Documented the `/jarvis-thinking` and side-session `/compact`/`/tree`/`/new` command behavior and expanded regression coverage for thinking config precedence, runtime sync, xAI forced-off behavior, and side-session command routing.

## [1.2.3] - 2026-04-23

### Fixed
- Prevented stale in-flight `/jarvis` boots from surviving `session_shutdown` / `session_start` and reattaching an obsolete side-session runtime after a session restart.
- Kept plain-string assistant turns visible in the recent main-session transcript context instead of collapsing the recent window to `none`.
- Made `/jarvis` fail closed when the newest stored side-session ref is malformed instead of silently reconnecting to an older session file.
- Preserved the speaker label when the overlay transcript is clipped mid-entry and stripped raw terminal control sequences from rendered transcript content.
- Added a shared `.gitignore` rule for project-local `.pi/` artifacts so fresh clones do not accidentally commit `.pi/jarvis.json`.

### Changed
- Documented the no-argument `/jarvis-model` picker path and the bridge-tool compatibility gate in the shipped README/AGENTS docs.
- Expanded regression coverage for stale boot invalidation, malformed newest session refs, plain-string assistant context extraction, overlay clipping, overlay control-sequence sanitization, and `.pi/` ignore hygiene.

## [1.2.2] - 2026-04-22

### Fixed
- Made `/jarvis` report MCP availability from the actual loaded tool set instead of extension-path discovery alone, so non-MCP extension paths no longer surface a false `MCP available` state.

### Changed
- Added regression coverage for the non-MCP extension-path case, shipped `AGENTS.md` in the published package surface, and aligned the README package-contents section with the actual npm tarball.
- Marked the stale phase-02 and next-session prompt files as historical implementation artifacts instead of live product guidance.

## [1.2.1] - 2026-04-22

### Fixed
- Hardened `/jarvis` state and overlay behavior by recognizing `npm pack --dry-run` as validation, avoiding false `done` summaries after passing validation alone, bounding latest-message refresh to post-compaction entries, preserving concurrent anonymous same-name tool activity, and keeping confirmation/footer content visible on short terminal heights.
- Improved `/jarvis-model` recovery by letting `clear` remove malformed scoped config files and by falling back between project and global settings independently when one layer is malformed.
- Tightened overlay transcript sanitization so multiline leaked tool-routing payloads are stripped while legitimate assistant content remains visible.

### Changed
- Added regression coverage for malformed config recovery, short-height confirmation rendering, package-manifest contract checks, and the new state/runtime edge cases covered by the audit sweep.
- Marked stale phase/versioned prompts as historical implementation artifacts and clarified the legacy `/btw` naming in the changelog history.

## [1.2.0] - 2026-04-22

### Added
- Added layered `/jarvis` model settings with project overrides in `.pi/jarvis.json`, global defaults in `~/.pi/agent/extensions/pi-jarvis.json`, and fallback to built-in `follow-main`.

### Changed
- Updated `/jarvis-model` to support scoped `--project` and `--global` writes plus `clear` semantics for falling back through the config layers.
- Replaced the prior branch-scoped `/jarvis` model persistence with explicit config-backed precedence and refreshed the regression coverage and README.

## [1.1.5] - 2026-04-19

### Changed
- Added the `pi-package` and `extension` keywords so `pi-jarvis` is discoverable by the `pi.dev` package index.

## [1.1.1] - 2026-04-17

### Fixed
- Fixed `/jarvis` overlay transcript leakage and redraw polish.

## [1.1.0] - 2026-04-17

### Changed
- Finished `/jarvis` awareness and overlay polish.

## [1.0.4] - 2026-04-16

### Fixed
- Stabilized `/jarvis` overlay behavior by sanitizing inherited main-agent workflow policy.
- Kept the polished `Thinking...` fallback animation and removed inconsistent structured thinking-step rendering.
- Updated regression coverage for overlay/runtime behavior.

## [1.0.0] - 2026-04-07

### Changed
- Prepared the first `1.x` release of `pi-jarvis`.

## [0.95.0] - 2026-04-07

### Added
- Added `/btw-model` side-session model selection.

## [0.9.0] - 2026-04-06

### Changed
- Release tag `v0.9.0`; detailed notes were not preserved in the changelog at the time.

## [0.8.0] - 2026-04-06

### Changed
- Bumped the package version to `0.8.0`.

## [0.7.0] - 2026-04-06

### Changed
- Release tag `v0.7.0`; detailed notes were not preserved in the changelog at the time.

## [0.6.0] - 2026-04-06

### Added
- Added `/btw` overlay forwarding toggles.

## [0.5.0] - 2026-04-06

### Added
- Added the `/btw` main-agent communication bridge.

## [0.4.0] - 2026-04-06

### Changed
- Removed direct repo and system tool access from `/btw`.

## [0.3.0] - 2026-04-06

### Added
- Injected live main-session context into `/btw`.

## [0.2.0] - 2026-04-06

### Added
- Added main-session summary context builders.

## [0.1.0] - 2026-04-06

### Added
- Initial public release of `pi-btw`, a Pi extension that opens a `/btw` side-conversation overlay inside the active Pi session.
- Persistent side-session storage and restoration for `/btw` conversations.
- Main-model synchronization so `/btw` follows the current Pi model selection.
- Automated type-check and regression test coverage.

### Changed
- Added live main-session state capture as groundwork for future context-aware `/btw` behavior without replaying the full transcript.
