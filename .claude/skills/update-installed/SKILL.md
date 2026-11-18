---
name: update-installed
description: Install or update the released Hangar on a machine — macOS, or Windows reached through a remote shell. Use when asked to install or update Hangar somewhere.
---

# Installing the released app

Which machines, and the remote shell that reaches them: the user's own skill for their machines, if any (not in this
repo).

## macOS

`curl -fsSL https://hangar.odahcam.com/install.sh | sh` checks the pinned SHA-256, quits the running app, replaces
`/Applications/Hangar.app` and opens it. Check: `defaults read /Applications/Hangar.app/Contents/Info CFBundleShortVersionString`.

## Windows, through a remote shell

A pipe on the command line may not get through: write a script on the machine, run it, remove it.

- Script, at `<TEMP>\hangar-update.ps1`: `irm https://hangar.odahcam.com/install.ps1 | iex`
- Run: `powershell -NoProfile -ExecutionPolicy Bypass -File <TEMP>\hangar-update.ps1`

Check: `(Get-Item $env:LOCALAPPDATA\Hangar\Hangar.exe).VersionInfo.ProductVersion`.

The script's own `Start-Process` doesn't open the app from a remote shell. Open it with
`explorer.exe <LOCALAPPDATA>\Hangar\Hangar.exe` (path without quotes) and check `Get-Process Hangar`. Where that's
refused too, ask the user to open it.
