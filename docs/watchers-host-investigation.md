# Watchers: bounded host API investigation

This is the step-one source investigation, not a claim that watchers are implemented or tested.

## Versions and scope

Inspected the installed Pi 1.1.0 extension documentation, public declarations, and compiled implementation. Compared the relevant API/implementation with pi-jarvis's Pi 1.0.0 development dependency. No providers, user MCP servers, archives, passwords, or credentials were used. No tests or live watcher commands were run in this step.

Larra located the Jarvis entrypoint, but its branch index did not cover main and did not provide the installed host sources. Ordinary read-only tools supplied those gaps.

## Result: use launch-time approval, not a retained tool context

The public extension contract exposes nested `executeTool` only on `ExtensionToolContext`, while a tool is executing. Ordinary lifecycle/timer contexts do not expose it. There is no documented general idle tool dispatcher in either inspected version.

Relevant Pi files (relative to the coding-agent package):

- `docs/extensions.md`, Tools: nested `ctx.executeTool` calls use validation, `tool_call`, `tool_result`, and execution events.
- `dist/core/extensions/types.d.ts`, `ExtensionContext`, `ExtensionToolContext`, `ExtensionAPI`: `executeTool` belongs to the tool context; `exec` is a separate extension API.
- `dist/core/extensions/runner.js`, `createToolContext`: binds a nested call to its parent tool ID and defaults to the parent signal.
- `dist/core/agent-session.js`, `_executeNestedToolCall`: uses the current assistant message; refuses when none exists.
- `dist/core/nested-tool-calls.js`, `NestedToolCallRunner.execute` / `takeRecord`: associates the nested record with a parent tool result and consumes it when that result completes.

Retaining a tool context after its tool returns would rely on undocumented lifetime/recording behavior. Watchers will not use that approach or private session internals.

The user approved this fallback:

1. During `jarvis_watcher_set`, show the complete check command and run the first check through `ctx.executeTool("bash", ...)` while the setting tool is still executing.
2. If bash is unavailable, execution is denied/cancelled, or the outcome cannot be safely classified, refuse registration. Do not schedule a repeat after denial.
3. Fix the approved execution command, cwd, deadline, interval, and limits before scheduling. Never change the command after setup; condition-generated commands are equally immutable.
4. Run later checks with public `pi.exec` in that same cwd. These checks do **not** rerun bash permission or result hooks. Recheck live watcher policy, trust, ownership, cancellation, and deadlines at boundaries.
5. Do not resume/replay interrupted checks automatically.

This is launch-time permission for bounded repetition, not per-check shell approval and not a sandbox. Pi does not itself prompt before every bash call: configured hooks own that decision. Reject empty/whitespace-only labels and notes before the first check.

## Waking and queuing

Use a displayed custom message with `triggerTurn: true` and `deliverAs: "followUp"`:

```ts
pi.sendMessage(
  { customType: "jarvis.watcher", content, display: true, details },
  { triggerTurn: true, deliverAs: "followUp" },
);
```

- `dist/core/agent-session.js`, `sendCustomMessage`: runs a new prompt while idle; uses the agent follow-up queue while streaming.
- `pi-agent-core/dist/agent-loop.js`, `runLoop`: consumes follow-ups when current pending work would otherwise finish, not as steering.
- `dist/core/extensions/loader.js`, `sendMessage`, and `agent-session.js`, extension `bindCore`: the public send is void; asynchronous failures are reported by the host, not acknowledged to the caller. Do not claim crash-safe exactly-once delivery or automatically retry an uncertain notification.
- `dist/core/messages.js`, `convertToLlm`: custom messages become user-role provider content. The message must explicitly identify the extension as its author and disclaim user approval. UI/session custom identity does not provide a separate provider notification role.

No model requests are needed between setup and notification.

## Additional constraints found in source

### Bare pi.exec is insufficient for strict check limits

`dist/core/exec.d.ts` defines timeout in **milliseconds**; bash tool timeout uses **seconds**. `dist/core/exec.js`, `execCommand`, buffers stdout and stderr without a size limit and sends SIGTERM to its immediate child on timeout/abort. Its later SIGKILL branch tests `proc.killed`, which indicates that a signal was sent, not that the child exited. It does not establish the bash tool's process-group cleanup contract.

Therefore implementation must not advertise raw `pi.exec` as a hard output/time/process-tree limiter. A bounded foreground supervisor is required **inside the immutable execution command shown and checked at launch**, not appended secretly to later repeats. It must bound emitted output, enforce check/deadline cancellation, and attempt child-group cleanup. Show both the original predicate and the complete supervised execution command. Runtime tests for this belong to the single targeted validation run after implementation.

Even supervised execution cannot guarantee cleanup after host SIGKILL or for deliberately escaped/daemonized descendants. Restrict checks to foreground predicates and explain the limitation plainly.

### Same bytes/cwd does not imply the same bash backend

`dist/core/tools/bash.js`, `createShellToolDefinition` / `resolveSpawnContext`, permits command prefixes, spawn hooks, environment changes, custom shells, and replacement execution operations. `extensions/loader.js`, `exec`, goes directly to local `execCommand` with an explicit cwd; it does not inherit the bash tool's backend or hooks.

Document explicitly that repeats are local and do not reproduce remote/container/custom bash execution, shell prefixes, or session-specific environment behavior. Never describe this fallback as preserving the isolation of a customized bash tool. Keep runner/shell choices explicit. Fail closed if first-check mutation, missing structured outcome, or a noncompatible first-check environment prevents establishing an exact repeatable execution command. The execution-result observer must inspect the actual validated arguments, not assume the requested arguments survived hooks unchanged.

### Exit and named-condition rules

- `command`: exit 0 is met; exit 1 is not yet; other exits, signals, launch/runtime errors are check failed.
- `file_lines`: a missing target is not yet, so creation can satisfy the watcher later.
- `path_quiet`: bounded recursive metadata, never follow symlinks; refuse over-cap inventories; missing/unreadable targets are check failed. Quiet is not proof of successful completion.

## Checkpoint

Branch `watchers` was created from main at v1.13.1. Runtime implementation and targeted tests remain for subsequent steps. Existing untracked files were left alone.

No commits or tags were created. The supplied repository policy requires stable tags on every new commit and conflicts with the user's no-tag development-commit request; leave this work uncommitted rather than violate either restriction. No pushes.
