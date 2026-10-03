# Pi 1.0 compatibility review

## Baseline and scope

- Prepared `pi-jarvis` 1.4.0 for Pi 1.0.0 (`@earendil-works`) and Node.js >=22.19.0.
- Four review/implementation workers used `openai-codex/gpt-6.1-sol:high`; no OpenRouter agents were used.
- Original tests/build/release checks passed on old Pi 0.69.0 dependencies, but masked current SDK incompatibilities.
- This review was completed before release publishing. The existing `pi-jarvis-1.3.1.tgz` was left untouched.

## Fixed

| Area | Changes |
| --- | --- |
| SDK | Current factory/UI contracts, searchable public-API model picker, awaited catalog refresh, physical-model dispatch through host credentials/custom providers |
| Isolation | Generation/queue ownership across resets, single side `/new` flush, main-tree reference reconciliation, no automatic replay of failed/uncertain inputs |
| Permissions | Project trust propagated to side resources/settings; execution-time local-tool checks; redirect permission/cancellation rechecks; overlay-owned cleanup |
| Context | Pi context-edit and compaction projection; ordinary bash tool-result validation; exact concurrent tool IDs; settlement-aware busy state |
| UI | Bounded narrow/short rendering, paged confirmation review before approval, history drift, keyboard protocols/remaps, control sanitation, theme-aware colors, live redraw |
| Config | Project precedence preserved after global writes; atomic file replacement; I/O errors distinguished from malformed JSON; `max` thinking |
| Packaging | Optional current-scope host peers, no bundled Pi stack, current development dependencies, stronger metadata/lock/payload checks; packaged AGENTS.md now visible to git |

## Validation

- `npm test`: passing (42 Node test results, including the existing assertion-based suite).
- `npm run build`: passing.
- `npm run verify:release`: passing.
- Packed tarball loaded through the installed Pi 1.0.0 resource loader from a clean temporary directory with no package-local Pi dependencies. Command registration/non-TUI behavior and `max` configuration passed without credentials or model/network requests.
- Deterministic real SDK tests cover host-only/native/legacy custom providers, runtime auth changes, trust, lifecycle, and tool revocation. Both regular and fullscreen TUI implementations are exercised with fake terminals.
- No live provider billing requests or human-driven terminal smoke test were performed.

## 1.5.0 UX follow-through

- Four workers used `openai-codex/gpt-6.1-sol:xhigh`; no OpenRouter agents.
- Compact themed header, expandable diagnostics, transcript paging/live follow, multiline editor, in-memory drafts, and independent queue/activity/notice feedback.
- Coordinator integration preserves confirmation priority, consumes chunked paste before shortcuts, clears drafts only at thread boundaries, and bounds display history without altering persisted sessions.
- New editor/layout/scroll/status/integration suites run in `npm test`; release verification requires all three new helper modules. Final validation: 121 test results passing, build passing, release verification passing. No live provider requests or human terminal smoke test for this UX pass.
- Prepared for release 1.5.0; the 1.4.0 release tag remains unchanged. GitHub release creation and npm publication are separate steps.

## Unreleased native MCP and release automation

- Native MCP is owned by the isolated side runtime through Pi's public extension factories and registration API. Repo tools opts into separate configured-server connections, native discovery/resources, and codemode without model helpers.
- Permission generations guard execution and nested calls; disable/close hides owned definitions, aborts call signals, and requests native shutdown. Main-server ownership, bridge permissions, project trust, and overlay subscriptions remain separate.
- Pi 1.0.0/1.0.1 do not provide a public owner cancellation hook covering in-flight MCP initialization/authentication. Already-started work may finish or time out after shutdown is requested; this integration does not claim instantaneous process teardown, rollback, or sandboxing.
- CI and release workflows validate real source commits, annotated tags, package metadata, and archive bytes. Release publication has write permission only after validation, never overwrites differing assets, and does not publish to npm. Branch/tag protection requires separate repository configuration.
- Validation: 171 Node test results passed (including real SDK/local MCP fixtures and temporary-repository/mock-GitHub release tests), plus build, release-payload verification, and local tag-policy checks. No live user MCP servers or paid provider calls were used. GitHub-hosted workflow execution is not claimed by local validation.
- Published 1.5.0 and its tags/assets remain unchanged; these changes are not a new release.

## Explicit limitations / proposed next improvements

1. **Native MCP lifecycle hardening.** The unreleased integration covers native direct/deferred/nested/resource gates, late registration, trust, and best-effort teardown. Strict cancellation during native connection/authentication initialization needs upstream public lifecycle hooks; neither reaching into private transports nor reviving the unsupported legacy adapter is acceptable.
2. **Virtual/router models (high priority).** The public extension registry does not expose session-aware virtual routing. These models reject explicitly; pin Jarvis to a physical model. Prefer an upstream supported runtime bridge rather than reaching into private fields.
3. **Cross-process configuration locking.** Atomic replacement prevents partial files, but two processes can still overwrite concurrent changes. Add a portable lock/recovery protocol and multiprocess tests before claiming concurrent-writer support.
4. **Large-history performance.** The 1.5.0 UX pass adds bounded scrollback, wrapped-block caching, and a multiline draft editor. Main-context projection caching remains a follow-up; profile long sessions before expanding incremental caches.
5. **Broader release coverage.** The unreleased workflows validate Node 22.19.0/24 and produce GitHub release packages. Add broader OS coverage, a reusable clean-host tarball smoke test, manual terminal acceptance checks, and repository protection rules. Keep npm publication manual unless separately authorized.
6. **Upstream development dependency advisory.** `npm audit --omit=dev` is clean. Full audit retains a high-severity `brace-expansion` advisory through Pi 1.0.0's published shrinkwrap (`5.0.9`, patched in `5.0.12`). Other reported development advisories were resolved through lockfile updates. A root override did not supersede that shrinkwrap and was not retained. This dependency is not shipped by Jarvis; update the validated Pi host when an upstream corrected release is available.
