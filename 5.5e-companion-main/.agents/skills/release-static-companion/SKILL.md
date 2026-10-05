---
name: release-static-companion
description: Prepare, validate, deploy, or roll back a 5.5e Companion GitHub Pages release. Use when creating a GitHub Release, checking release readiness, diagnosing the release workflow, redeploying Pages, or planning a rollback for this repository.
---

# Release Static Companion

1. Read `references/release-process.md` and run `npm run verify`.
2. Confirm the target commit is on `main` and the validation workflow is green.
3. Publish a non-prerelease GitHub Release with a new semver-style tag.
4. Watch `Release to GitHub Pages` and verify the live DM, player, and installed-app update paths.
5. Roll back by publishing a new tag pointing at the known-good commit; never move a previously deployed tag.
