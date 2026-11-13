# Hangar

## Positioning

Hangar is sold as the way to reduce the anxiety of working with many Claude Code sessions, making the work lighter and zen. Copy that presents it (the landing page in `cloud/public/`, the README) follows that direction; the landing's lead opens with "Stale session anxiety is no more."

## Releasing

The install scripts and download links of the landing (`cloud/public/install.sh`, `install.ps1`, `index.html`) pin one release by version and SHA-256. Every release, once its assets are published:

1. `node scripts/release-pin.js` pins the latest release (or `node scripts/release-pin.js vX.Y.Z`).
2. Commit the change.
3. `npx wrangler deploy` in `cloud/`.

The `Release pin` workflow (`.github/workflows/release-pin.yml`) fails when a release is published and on a daily schedule while the pins don't match the latest release.
