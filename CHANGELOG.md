# Changelog

This changelog tracks the documented release history of this project. Earlier entries were reconstructed from the repository's release tags where fuller notes were not preserved at release time.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

> Historical note: releases before the `pi-jarvis` 1.x line refer to the project's earlier `pi-btw` and `/btw` naming. Those entries are preserved as historical release records and do not describe the current product name or command surface.

## [1.8.0] - 2026-10-04

### Added
- Separate optional full-session archive, OFF by default, explicitly mounted in main Pi and Jarvis independently of shared memory, Repo tools and bridge permissions.
- Global/project recording controls, a global master off switch, separately opt-in model access, and explicit sensitive-data acknowledgment. `/jarvis-archive` and overlay `/archive` controls run locally without model/queue work.
- Local SQLite FTS5 search, cross-project queries by explicit request, paged session browsing and raw-entry reads, session provenance/parent links, and complete accepted finalized entry payloads including exposed thinking, tool details and inline images.
- Human-only explicit v3 JSONL import with duplicate detection, partial/cancellation reporting, scoped deletion/pruning and identity tombstones. No automatic history import, context injection, eviction, external attachment reads, embeddings or background model calls.

### Documentation
- Promote both complementary memory features in the README: default-on shared memory and the separate, disabled-by-default full-session archive, with a side-by-side comparison of controls, retrieval and privacy.

### Safety and limitations
- Raw archive storage is unredacted plaintext and can retain credentials/private data; model reads can send it to the active provider. Off blocks record reads/writes while retaining data; trust/config failures pause access.
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
