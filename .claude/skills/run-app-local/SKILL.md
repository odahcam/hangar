---
name: run-app-local
description: Run a local build of the Hangar desktop app on this Mac for the user to check a change, isolated from the installed app or with remote control on. Use when asked to run or open Hangar locally.
---

# Running the app locally

`npm run build:app` builds `target/debug/hangar`. `web/` is embedded in it: rebuild after a UI change.

## Isolated (beside the installed app)

```sh
cp -R "$HOME/Library/Application Support/Hangar" <scratch>/data
HANGAR_DATA_DIR=<scratch>/data HANGAR_SECRETS_DIR=<scratch>/secrets HANGAR_WEBVIEW_DATA=<scratch>/webview \
  HANGAR_CLASSIFY_START_MS=86400000 ./target/debug/hangar
```

The user's real sessions over a copy of the app's data. `HANGAR_WEBVIEW_DATA` makes it a test instance: no single
instance and remote control not started (no Keychain prompt, no machines in Settings). `HANGAR_CLASSIFY_START_MS`
keeps done detection (Haiku) from running.

## With remote control

Real data and device identity: the user quits the installed Hangar first (one identity, one instance), then
`./target/debug/hangar`. The Keychain asks to Allow (another binary), so the user has to be there.

## Afterwards

Stop it; with remote control, the user reopens the installed app. Delete the data copies: they hold the user's sessions.
