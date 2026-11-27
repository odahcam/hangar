# Hangar

## Positioning

Hangar is sold as the way to reduce the anxiety of working with many Claude Code sessions, making the work lighter and zen. Copy that presents it (the landing page in `cloud/public/`, the README) follows that direction; the landing's lead opens with "Stale session anxiety is no more."

## Tests

Every feature and behavior gets exhaustive e2e specs.

## CI

- `.github/workflows/ci.yml` runs on pushes to `main`, on PRs and by hand; a branch without a PR runs it with
  `gh workflow run ci.yml --ref <branch>`.
- Jobs: relay, macOS, Windows. Runners are free for this public repo. The macOS job stays: it builds the release's
  `Hangar.zip`, runs `test:build` and the remote control end to end.
- Runner faults, not Hangar's: the macOS job cancelled with no steps run, and "desktop app did not come up" on Windows.
  Run it again.

## Releasing

The install scripts and download links of the landing (`cloud/public/install.sh`, `install.ps1`, `index.html`) pin one release by version and SHA-256. Every release, once its assets are published:

1. `node scripts/release-pin.js vX.Y.Z --from <dir>` pins it, `<dir>` holding the files attached to the release: the digests come from them, and the published assets must match them byte for byte.
2. Commit the change.
3. `npx wrangler deploy` in `cloud/`.

The `Release pin` workflow (`.github/workflows/release-pin.yml`) fails when a release is published and on a daily schedule while the pins don't match the latest release.
