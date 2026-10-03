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

## Explicit limitations / proposed next improvements

1. **Native MCP integration (high priority).** Automatic loading of the legacy adapter is disabled: its published peer ranges do not declare Pi 1.0 support. Integrate Pi's built-in factories only with direct/deferred/nested execution gates, late tool registration, trust, and teardown tests. Local read/bash/edit/write tools remain available by opt-in.
2. **Virtual/router models (high priority).** The public extension registry does not expose session-aware virtual routing. These models reject explicitly; pin Jarvis to a physical model. Prefer an upstream supported runtime bridge rather than reaching into private fields.
3. **Cross-process configuration locking.** Atomic replacement prevents partial files, but two processes can still overwrite concurrent changes. Add a portable lock/recovery protocol and multiprocess tests before claiming concurrent-writer support.
4. **Large-history performance and UX.** Cache main context projections and wrapped transcript blocks; add a bounded scrollback view and a multi-line draft editor. Profile long sessions before introducing incremental caches.
5. **Broader release automation.** Add CI across supported Node versions and operating systems, a reusable clean-host tarball smoke test, and manual terminal acceptance checks.
6. **Upstream development dependency advisory.** `npm audit --omit=dev` is clean. Full audit retains a high-severity `brace-expansion` advisory through Pi 1.0.0's published shrinkwrap (`5.0.9`, patched in `5.0.12`). Other reported development advisories were resolved through lockfile updates. A root override did not supersede that shrinkwrap and was not retained. This dependency is not shipped by Jarvis; update the validated Pi host when an upstream corrected release is available.
