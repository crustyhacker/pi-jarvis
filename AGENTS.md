# pi-jarvis Agent Notes

## Project Scope
- `pi-jarvis` is a Pi extension that opens a `/jarvis` side-conversation overlay.
- Core runtime files: `index.ts`, `side-session.ts`, `native-mcp.ts`, `overlay.ts`, `overlay-layout.ts`, `draft-editor.ts`, `transcript-viewport.ts`, `jarvis-branding.ts`, `model-picker.ts`, `jarvis-config.ts`, `session-ref.ts`.
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
- Config writes use atomic same-directory replacement. I/O errors must not trigger malformed-JSON recovery. Cross-process concurrent config writes are not locked.
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
