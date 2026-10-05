---
name: release
description: Prepare a Vybecord release — version bump, release commit, release notes, and the exact build, tag and gh release commands. Use when the user asks to release, ship, publish or bump the version.
disable-model-invocation: true
---

Releases are made by hand from `desktop-app`; there is no release CI. The full checklist is
in README.md → Contributing → "Release checklist". Steps:

1. Run `/verify`. Do not release on a red check.
2. Ask the version if not given (patch for fixes, minor for features or UI changes).
3. `npm version <x.y.z> --no-git-tag-version` (updates package.json and package-lock.json).
4. Draft release notes from `git log <previous-tag>..HEAD`, in the style of RELEASE_NOTES.md:
   a bold lead sentence per change saying what the user saw, then why. Save them to
   `release-notes-<x.y.z>.md` for `gh release create`, and show them to the user.
5. Commit `Release <x.y.z>: <one-line summary>` with only the version bump.
6. If `extension/` changed since the last release, bump `extension/manifest.json`.
7. The rest needs Windows — hand the user these commands, in order, without running them:
   `npm run dist`, `node scripts/pack-extension.mjs` (only if step 6 applied),
   `git tag <x.y.z>`, `git push origin desktop-app`, `git push origin <x.y.z>`, and the
   `gh release create` command from the README with **all five assets**
   (latest.yml, setup.exe, .blockmap, both extension zips). Without latest.yml installed copies never update.

Never push a tag or publish a release without the user's explicit go-ahead.
