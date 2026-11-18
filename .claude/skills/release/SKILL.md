---
name: release
description: Cut a Hangar release (vX.Y.Z) — bump, CI, GitHub release from the CI's installers, pin, deploy — now or at a set time. Use when asked to release, publish or ship a version.
---

# Release

1. Bump `version` in `Cargo.toml` (`[workspace.package]`) and `package.json`; `cargo metadata -q --format-version 1 >/dev/null`
   updates `Cargo.lock`. Commit `vX.Y.Z` on `main` (or in the PR going into it) and push.
2. Wait for that commit's CI, green on relay, macOS and Windows:
   `gh run list --commit <sha> --workflow ci.yml`, then `gh run watch <id> --exit-status`.
3. Tag the commit on `main`: `git tag -a vX.Y.Z -m vX.Y.Z <sha> && git push origin vX.Y.Z`.
4. The installers are that run's artifacts: `gh run download <id> -n hangar-macOS` (`Hangar.zip`) and
   `-n hangar-Windows` (`Hangar_X.Y.Z_x64-setup.exe`, under `target/release/bundle/nsis/`). Check the app in the zip:
   `unzip -p Hangar.zip Hangar.app/Contents/Info.plist | plutil -extract CFBundleShortVersionString raw -`.
5. `gh release create vX.Y.Z Hangar.zip Hangar_X.Y.Z_x64-setup.exe --verify-tag --title "Hangar X.Y.Z" --notes "…"`;
   the notes say only what shipped.
6. Pin, commit, deploy (CLAUDE.md, Releasing): `node scripts/release-pin.js vX.Y.Z --from <dir with the two files>`,
   commit `Pin vX.Y.Z in the install scripts and the landing`, push `main`, `npx wrangler deploy` in `cloud/` (a
   "fetch failed" there is connectivity: run it again). Check: `curl -s https://hangar.odahcam.com/install.sh | grep VERSION=`.

The `Release pin` workflow fails on the release event until the pin is pushed; its run after the push passes.

At a set time: a one-shot `CronCreate` whose prompt is these steps, waiting for the CI if it's still running and
stopping (and telling the user) if it fails.
