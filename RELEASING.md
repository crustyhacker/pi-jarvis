# Validation and release workflow

npm publication remains **manual**. GitHub Actions validate source and prepare a GitHub release; they do not run `npm publish` or require an npm token.

## Every commit needs a version-number tag

Create an **annotated version tag** for every new commit before pushing it. SHA-only tags such as `commit-<sha>` do **not** satisfy policy.

- **Development:** `X.Y.Z-dev.N`, for example `1.6.0-dev.1`. Choose the next planned release version and increment the positive `N` for each commit. No leading zeros or leading `v`.
- **Release:** `vX.Y.Z`, matching the committed release metadata.

Development tags identify source snapshots; they leave the last released package version unchanged and never trigger GitHub releases or npm publishing. The deliberate absence of `v` keeps them outside the `v*` release workflow.

Fetch tags and choose an unused development version **before** committing (the value below is an example, not a tag to reuse):

```sh
git fetch origin --tags
tag=1.6.0-dev.3  # Choose the next unused version.
git commit -m "Describe the change"
git tag -a "$tag" -m "pi-jarvis $tag: describe the change"
npm run check:tags
git push --atomic origin HEAD "refs/tags/$tag"
```

Tag every commit in a multi-commit change, not just its tip. Do not move or replace an existing tag. Legacy SHA aliases may remain for traceability, but only version tags count toward coverage. The historical graph through `92734df` (the 1.5.0 release) is the policy baseline; subsequent reachable commits must satisfy the tag policy.

An annotated tag records a message and target; it is **not** a cryptographic signature or a guarantee of code provenance.

## Local validation

```sh
npm ci
npm test
npm run build
npm run verify:release
node scripts/check-tags.mjs
```

The tag check examines committed history, not uncommitted work. Tests use isolated configuration and local test MCP servers; they must never start a contributor's real MCP servers or call paid providers.

## Prepare a release

1. Update the version together in `package.json`, the lockfile root/package entry, and the README's **Current version**. Promote the changelog's unreleased notes to a unique, dated release entry.
2. Run the full validation above.
3. Commit the release metadata and annotate that commit with the matching version:

   ```sh
   git commit -m "Release pi-jarvis X.Y.Z"
   git tag -a vX.Y.Z -m "pi-jarvis X.Y.Z"
   git push --atomic origin HEAD refs/tags/vX.Y.Z
   ```

4. The release workflow checks out the exact tag, verifies its annotation and matching versions, runs validation, packs the npm archive, and creates the GitHub release with the package attached. Development version tags never create releases.
5. Download and inspect the attached archive, then publish it yourself:

   ```sh
   npm publish ./pi-jarvis-X.Y.Z.tgz --access public
   npm view pi-jarvis@X.Y.Z version dist.integrity
   ```

6. Confirm the npm integrity matches the GitHub package. Update the release notes to confirm npm publication only after that check succeeds.

Rerunning release automation must not overwrite a published package with different bytes. If an existing asset differs from the rebuilt archive, investigate the mismatch or release a new version instead of replacing the old asset.

## Repository enforcement

Actions report failures; they cannot prevent a repository administrator from bypassing checks, moving a tag, or pushing directly. Configure repository rules separately to require **`test (Node 22.19.0)`** and **`test (Node 24)`** on the default branch, restrict release-tag creation, and prevent tag deletion/updates.

Branch CI briefly refreshes tags to tolerate event delivery order. If you push a missing tag after CI has already failed, manually rerun that branch/PR check: a development-version tag-only push intentionally does not trigger a new run. Fork authors must push their annotations to their fork; CI fetches those into a separate namespace without replacing upstream tags.

GitHub's merge/squash/rebase UI can create new commits without your tags. Prefer maintaining the exact validated, tagged commits and fast-forwarding with an atomic branch-and-tag push. If a merge commit is necessary, it also needs its own annotated tag and validation. Do not assume a synthetic pull-request merge commit is a contributor commit that must be tagged.

Pull-request validation must use the actual PR head and its reachable history, not only GitHub's temporary merge ref. Fork pull-request jobs remain read-only and must not receive publishing credentials. Tags in a fork do not automatically become tags in this repository; maintainers must preserve the corresponding annotated tags when accepting the commits.
