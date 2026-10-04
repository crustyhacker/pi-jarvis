# pi-jarvis Agent Notes

## Project Scope
- `pi-jarvis` is a Pi extension that opens a `/jarvis` side-conversation overlay.
- Core runtime files: `index.ts`, `side-session.ts`, `native-mcp.ts`, `overlay.ts`, `overlay-layout.ts`, `draft-editor.ts`, `transcript-viewport.ts`, `jarvis-branding.ts`, `model-picker.ts`, `jarvis-config.ts`, `session-ref.ts`, `memory-{types,config,content,store,service,extension}.ts`, and `archive-{types,config,store,service,extension}.ts`.
- Current baseline: Pi 1.0.0 (`@earendil-works` packages), Node.js >=22.19.0. Older Pi hosts are not supported.

## Current `/jarvis-model` and `/jarvis-thinking` Behavior
- `/jarvis` requires `ctx.mode === "tui"`; other modes must not boot or prompt a hidden side session.
- `/jarvis-model` with no request opens a searchable host-registry model picker in TUI mode; other modes report status.
- `/jarvis-model <provider/model>` writes a project-scoped override to `.pi/jarvis.json`.
- `/jarvis-model --global <provider/model>` writes the default global override to the active Pi agent directory's `extensions/pi-jarvis.json` (by default `~/.pi/agent/extensions/pi-jarvis.json`).
- `/jarvis-model [--project|--global] follow-main` stores a scoped `follow-main` override.
- `/jarvis-model [--project|--global] clear` removes that scope's override so fallback applies.
- `/jarvis-thinking [--project|--global] auto|follow-main|off|minimal|low|medium|high|xhigh|max` stores a scoped thinking override without changing the main session thinking level.
- `/jarvis-thinking [--project|--global] clear` removes that scope's thinking override so fallback applies.
- Resolution order is: project config, then global config, then built-in defaults (`follow-main` for model, `auto` for thinking). Global writes never override an active project setting.
- Config writes use atomic same-directory replacement. Malformed shared JSON requires manual repair: model/thinking set/clear must never replace/delete it and reset unknown memory privacy controls. Keep I/O errors distinct and parser input snippets out of UI errors. Legacy model/thinking cross-process writes remain unlocked.
- `auto` thinking follows main only when `/jarvis` follows the main model; pinned `/jarvis` models default to thinking `off`.
- `follow-main` thinking follows the main thinking level regardless of model selection, except xAI `/jarvis` models force thinking `off`.
- `/compact`, `/tree`, and `/new` entered inside `/jarvis` operate on the isolated `/jarvis` side-session, not the main Pi session.
- `Note main` and `Redirect` stay disabled when the active `/jarvis` model is incompatible with bridge tools.
- Published packages keep Pi runtime packages as optional peers, not bundled dependencies. Never load the legacy MCP adapter. Version 1.6.0 adds native MCP to Repo tools opt-in alongside read/bash/edit/write.
- Physical models delegate to the host's public registry for auth and dispatch. Virtual/router models explicitly reject; do not access the registry's private backing runtime.
- Side resources/settings honor `ctx.isProjectTrusted()`. Local tool execution and bridge delivery recheck live permissions; closing the overlay revokes them and cancels pending confirmations.
- Use `agent_settled`, not `agent_end`, for final idle state. Main context must honor Pi context-edit/compaction projection.
- Runtime disposal must not detach the overlay's bridge subscription. Queue ownership must survive side `/new` but not main-session replacement; failed/uncertain sends are not auto-retried.

## Overlay UX (1.5.0)
- Compact header by default; Ctrl+O expands diagnostics, PageUp/PageDown scroll transcript, Ctrl+End follows live, Ctrl+L dismisses notices.
- Use Pi's public multiline Editor. Enter sends; Shift+Enter/Ctrl+J inserts newline. Preserve indentation and reject unsafe/oversized drafts (64 KiB) explicitly.
- Bridge-owned in-memory drafts survive close/reopen. Bridge reset clears draft/recall on side `/new` or main/side-reference replacement; side-tree navigation only resets scroll.
- Consume bracketed paste before global shortcuts and confirmation keys; pasted content must not toggle permissions or approve a redirect.
- Queue count excludes active work; processing includes boot and complete queue settlement. Keep activity separate from scrollback and never replay uncertain sends.
- Bound overlay history (500 entries, 512K UTF-16 units total, 64K per entry) with explicit omission notices; never truncate persisted history.

## Branding intro (1.6.1)
- The first overlay for each main-session ID in the loaded extension shows a 1.8-second neon/chrome ASCII sweep, then returns to the compact UI. Reopen, side `/new`, tree navigation, and returning to an already-seen main session must not replay it. Reload/restart resets this in-memory bookkeeping.
- The intro is decoration, never a boot/queue gate. Keep editor, permissions, and activity available. Input dismisses it without being consumed; paste framing still precedes shortcuts. Confirmations and warnings/errors preempt it.
- Use a bounded, unreferenced, lazily started timer; stop on dismissal, expiry, or disposal. No blinking, flashing, terminal-clearing commands, transcript entries, or persisted session changes.
- Suppress with `PI_JARVIS_NO_ANIMATION=1`, non-empty `NO_COLOR`, or `TERM=dumb`. Use compact/no intro on small terminals and readable palettes for light themes and 256-color output.
- `jarvis-branding.ts` owns the original wordmark. `npm run render:branding` regenerates README SVGs with local renderer fixtures, not live provider/session data. Label fixture previews honestly.

## Native MCP (1.6.0)
- Use Pi's root-exported native factories, not private registry/runtime/transport internals. Jarvis owns separate configured-server connections; main-only extension registrations are not inherited.
- No native startup/credential expansion while initially off. Respect project trust, enabled states, native tool exposures, and live Repo tools permission for direct/deferred/codemode/resource execution.
- Revocation invalidates permission generations, hides owned tools, aborts calls and invokes owned native shutdown. Stale prepared tools and late registrations cannot regain access after re-enable.
- Pi cancellation is best effort: already-started handshake/authentication/remote work may finish or time out after shutdown is requested. Do not promise immediate child teardown, rollback, or sandboxing.
- Keep server administration in main Pi. Disable codemode model helpers (`models: false`); preserve independent Note main/Redirect gates and the overlay-owned bridge subscription.
- Tests use temporary agent/workspace directories and local fixture servers only; never start real user MCP servers or resolve real credentials during validation.

## Shared memory (1.7.0)
- Main Pi and the isolated Jarvis SDK session explicitly mount one shared local service. Memory is enabled by default in trusted projects, independently of Repo tools, Note main, Redirect, and overlay open/close. It can share historical facts even when bridge delivery is off; it never steers or queues work.
- `/jarvis-memory` reports status; `help` documents controls. `[--global|--project] on|off|capture on|off|recall on|off|clear` controls default to GLOBAL (unlike model/thinking). Per-field project > global > defaults, except global enabled=false is a master kill switch. Untrusted projects and config errors pause all memory. Full off means no memory-record reads/capture/injection/tool execution; retain data. Explicit admin inspection still requires enabled memory; capture/recall-only pauses do not block manual commands.
- Inside the overlay, `/memory …` and `/jarvis-memory …` execute immediately without model/boot/queue work. `clear` removes settings, never data; `forget-all --confirm [--global|--all]` defaults to only the current project's records. Data scope flags follow the action.
- Disclose capture/recall before first use and only then persist the global disclosure marker. No silent historical import, background providers, embeddings, real user credential access, or real MCP servers during tests. Isolate every test's agent/workspace directories.
- Capture only new finalized user/assistant text, not thinking/tool/custom/system/attachment data or aborted/error output. Stage only event metadata (max 256 anchors); resolve at turn/settlement boundaries from at most 1,024 newly persisted parent-chain entries, stopping before the old leaf. Never archive intermediate message_end payloads before later redaction hooks. Discard pending anchors on revocation, session/tree change or disposal; never backfill. Secret filtering is best-effort, not a guarantee; reject suspected secrets in curated notes. Cap text at 16 KiB UTF-8; omit oversized archive captures, reject oversized notes. Archive retains newest 10,000 records; curated notes cap at 1,000 without automatic deletion.
- Keep auto recall scoped to global + canonical current cwd; explicit all-project search is supported. Request-local context injection is bounded to 6,000 bytes of untrusted record JSON plus notice; search results 12,000 bytes with excerpt/omission markers. Never persist automatically injected context via appendEntry/sendMessage or treat stored instructions as authority. Explicit tool calls/results still follow normal Pi persistence; don't promise that disabling/forgetting erases earlier tool results or already-viewed output.
- Store is lazy local SQLite under the active agent directory (`extensions/pi-jarvis-memory/memory.sqlite`), not a project-selected path. SQLite coordinates record writers; memory settings use atomic cooperative locking that legacy model/thinking writes do not participate in. Fail closed on malformed settings; never repair automatically.
- Memory guidance is also request-local: use a custom advisory so Pi's later forced-prompt projection cannot discard it. Preserve other prompt/tool state; a mid-turn disable removes both advisory and recalled records from future requests.
- Model tools recheck live trust/settings/cancellation and permission generations at execution, including captured definitions. Broadcast observed policy changes across mounted lanes and revoke per-binding generations at session/tree boundaries; don't promise live push delivery across processes. Model forget requires cancellable human review and transactionally compares the reviewed version. Tombstones prevent identical event/title resurrection, not every semantic mention; Pi transcripts, backups and already-sent context remain. Do not promise encryption, a sandbox, or forensic erasure.

## Optional full-session archive (1.8.0)
- `archive-{types,config,store,service,extension}.ts` implement an independent OFF-by-default archive, explicitly mounted in main and Jarvis. Defaults enabled=false/capture=true/modelAccess=false; per-field project > global > defaults except explicit global enabled=false is master-off. Untrusted/config errors pause everything. Never enable/import real user data in tests.
- Separate settings: `<agentDir>/extensions/pi-jarvis-archive.json` and `.pi/jarvis-archive.json`, top-level `archive`. Controls default global. on/model-access on/clear require `--confirm-sensitive`; clear removes settings, not data, and fallback can re-enable. Archive tools are read-only and need modelAccess; humans can inspect with only capture/modelAccess off, but not full off.
- `/jarvis-archive` and overlay `/archive` commands are local, immediate, no provider/boot/queue work. Search/read/session default current-project; all-project access is explicit. Model tools cannot change controls, import, or delete. No auto context injection.
- Archive accepted finalized journal entries unredacted, including exposed thinking/tool/system/custom/error/inline-image data. Never capture intermediate message_end/tool_result/raw-provider payloads before later redactors. Baseline existing entry IDs on activation, never auto-backfill; parent/header provenance retained. Snapshots are not crash-safe audit logging and cannot recover unpersisted events, earlier truncation or external referenced files. Warn on storage/observation failures, not silent replay.
- Lazy private SQLite FTS5 at `<agentDir>/extensions/pi-jarvis-archive/archive.sqlite`, no automatic retention eviction. 64 MiB raw-entry/index budgets and 64K UTF-16 normalization-context hard rejection, no truncation of accepted raw JSON or silent partial indexing. Identical serialized payloads deduplicate across lanes; conflicting payloads for one identity fail without replacement. Search/read output max 24,000 JSON bytes plus notice; raw read offsets count Unicode codepoints and preserve pagination through output shrinking. Oversized display provenance is explicitly abbreviated; read(part=metadata) / read --metadata pages exact original metadata so every accepted entry stays accessible. Images/signatures are raw-retained, not text-indexed. Never load full payloads for search or scan all raw bodies on open.
- Explicit human import streams one selected regular v3 JSONL file, honors its header's project/session provenance, checks live capture/epoch/cancellation at chunk/record boundaries, reports partial commits, never mutates source. No directory scans/legacy auto-migration. Scoped forget-session/prune require --confirm; tombstones stop identical entry resurrection, not all copies. No encryption, sandbox, forensic erase, or hard total-disk-quota claims.
- Keep live trust/settings and per-binding stale-definition guards independent of Repo tools. Reader permission changes must not discard pending recording. Main owner closes storage after final archive snapshot; the side owner snapshots finalized entries before revoking its lifetime/context, without closing the shared service. Preserve archive finalization before main boot-generation invalidation. Settings observations propagate between mounted lanes, not by a cross-process watcher.

## Git and Release Policy
- Every new commit MUST have an annotated **stable version tag `vX.Y.Z`**. No `dev`, alpha, beta, release-candidate, build-metadata, or SHA-only tags. This is a released extension, not a prerelease channel.
- Before committing, choose the next unused stable version and update package metadata, lockfile, README, and a dated changelog entry together. Tag every commit, including intermediate and merge commits; never leave a new commit untagged. Run `npm run check:tags`, then push the commit and version tag atomically. Do not move or replace existing tags or rewrite shared history.
- Prefer fast-forwarding the exact validated commits to `main`; a new merge commit also requires its own version bump and tag. Every pushed `vX.Y.Z` tag triggers validated GitHub release packaging; npm publication remains manual.
- Stable-only CI enforcement starts after historical baseline `4b6b4e6`, preserving already-pushed history. Branch/PR jobs validate on Node 22.19.0 and 24 and reject missing, lightweight, prerelease, or SHA-only version coverage. Each new tag must match that commit's package metadata, lockfile, README, and changelog.
- Existing release assets must not be overwritten with differing bytes. See `RELEASING.md` for branch/tag protection and merge/fork constraints; CI alone cannot prevent administrator bypass.

## Validation
- Run `npm test` for full validation.
- Run `npm run build` before release packaging.
- Run `npm run verify:release` to validate npm pack payload and release metadata expectations.
- Run `npm run check:tags` after tagging commits to validate annotated-tag policy.

## Docs To Keep In Sync
- `README.md`
- `CHANGELOG.md`
- `package.json` version
- this `AGENTS.md` when command/config behavior changes
