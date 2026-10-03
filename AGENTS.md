# pi-jarvis Agent Notes

## Project Scope
- `pi-jarvis` is a Pi extension that opens a `/jarvis` side-conversation overlay.
- Core runtime files: `index.ts`, `side-session.ts`, `overlay.ts`, `overlay-layout.ts`, `draft-editor.ts`, `transcript-viewport.ts`, `model-picker.ts`, `jarvis-config.ts`, `session-ref.ts`.
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
- Published package keeps Pi runtime packages as optional peers, not bundled dependencies. MCP adapter auto-loading is disabled: the published adapter does not declare Pi 1.0 support; native MCP is not enabled. Repo tools expose only read/bash/edit/write.
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

## Git and Release Policy
- Every commit must have an annotated git tag; this is mandatory. Release commits use `v<version>`; other commits use `commit-<short-sha>`.
- Push each commit with its tag. Keep release versions synchronized across package metadata, lockfile, README, and changelog.

## Validation
- Run `npm test` for full validation.
- Run `npm run build` before release packaging.
- Run `npm run verify:release` to validate npm pack payload and release metadata expectations.

## Docs To Keep In Sync
- `README.md`
- `CHANGELOG.md`
- `package.json` version
- this `AGENTS.md` when command/config behavior changes
