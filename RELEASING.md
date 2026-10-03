# Validation and release workflow

Every new commit uses an annotated **stable `vX.Y.Z` tag**. This is a released extension: do not use `dev`, alpha, beta, RC, build-metadata, or SHA-only tags. npm publication remains **manual**; GitHub Actions never run `npm publish` or require an npm token.

## Every commit is versioned

1. Fetch tags and choose the next unused stable version. Use a patch bump for fixes, documentation, and policy changes; use a minor/major bump when appropriate for the change.
2. Update `package.json`, the lockfile root/package entry, the README's **Current version**, and a unique, dated changelog entry together. Every commit's tag must match its own committed metadata.
3. Run tests, build, and package verification before committing.
4. Commit, create an annotated version tag, validate committed history, and push the commit and tag atomically:

   ```sh
   git fetch origin --tags
   # Choose X.Y.Z and update/validate all release metadata before committing.
   git commit -m "Release pi-jarvis X.Y.Z"
   git tag -a vX.Y.Z -m "pi-jarvis X.Y.Z"
   npm run check:tags
   git push --atomic origin HEAD refs/tags/vX.Y.Z
   ```

Tag **every** commit in a multi-commit change, not just its tip. Intermediate and merge commits also require their own version bump and tag. Prefer fast-forwarding the exact validated commits to `main` rather than creating unnecessary merge commits. A tag is not a branch: a version tag on a commit already on `main` needs no separate merge.

Do not move or replace existing tags or rewrite shared history. Stable-only enforcement begins after historical commit `4b6b4e699d46b4381f6a8ca5f0f71f95c84102af`; earlier published history is grandfathered rather than rewritten. New commits cannot use the former development-tag convention.

An annotated tag records a message and target; it is **not** a cryptographic signature or a guarantee of code provenance.

## Local validation

```sh
npm ci
npm test
npm run build
npm run verify:release
# After committing and tagging:
npm run check:tags
```

The tag check examines committed history, not uncommitted work. Tests use isolated configuration and local test MCP servers; they must never start a contributor's real MCP servers or call paid providers.

## GitHub release and manual npm publication

Every pushed `vX.Y.Z` tag triggers release automation, including tags on intermediate commits. The workflow checks out the exact tag, verifies its annotation, matching versions, and all post-baseline commits, runs validation, packs the npm archive, and creates the GitHub release with the package attached. Reserve unique versions when working across branches or forks.

After the workflow succeeds, download and inspect the attached archive, then publish it yourself:

```sh
npm publish ./pi-jarvis-X.Y.Z.tgz --access public
npm view pi-jarvis@X.Y.Z version dist.integrity
```

Confirm the npm integrity matches the GitHub package. Update release notes to confirm npm publication only after that check succeeds.

Rerunning release automation must not overwrite a published package with different bytes. If an existing asset differs from the rebuilt archive, investigate the mismatch or release a new version instead of replacing the old asset.

## Repository enforcement

Actions report failures; they cannot prevent a repository administrator from bypassing checks, moving a tag, or pushing directly. Configure repository rules separately to require **`test (Node 22.19.0)`** and **`test (Node 24)`** on the default branch, restrict release-tag creation, and prevent tag deletion/updates.

Branch CI briefly refreshes tags to tolerate event delivery order. If a version tag arrives after branch/PR CI has already failed, manually rerun that check: a tag-only push triggers release automation, not a new branch/PR check. Fork authors must push their annotations to their fork; CI fetches those into a separate namespace without replacing upstream tags.

GitHub's merge/squash/rebase UI can create new commits without matching versions and tags. Preserve the validated commits and fast-forward with an atomic branch-and-tag push. If a merge commit is necessary, it needs its own synchronized version, annotated tag, and validation. GitHub's synthetic pull-request merge ref is not a contributor commit that must be tagged.

Pull-request validation uses the actual PR head and its reachable history. Fork pull-request jobs remain read-only and must not receive publishing credentials. Tags in a fork do not automatically become tags in this repository; maintainers must preserve the corresponding annotated tags when accepting the commits.
