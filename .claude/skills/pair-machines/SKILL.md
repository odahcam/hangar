---
name: pair-machines
description: Pair a machine into the odahcam account's remote control from a command line (Hangar --offer / --pair), locally or through a remote shell. Use when asked to pair or add a machine for remote control.
---

# Pairing from the command line

The running app does the work (`core/src/cli.rs`); the command hands it the request. Both apps running and signed in to
the same odahcam account.

The binary: macOS `/Applications/Hangar.app/Contents/MacOS/Hangar`, Windows `%LOCALAPPDATA%\Hangar\Hangar.exe`.

1. On a machine already in the account: `<binary> --offer` prints a code and waits up to 5 minutes for a machine to
   join with it. Run it in the background and read the code from its output.
2. On the machine joining, `<binary> --pair` reads the code on stdin. The code never appears in any command line (not
   `--pair`'s, not a remote shell's, not `sh -c`/`cmd /c` there): keep it in a variable read from the `--offer` output
   and feed it with a shell builtin, `printf '%s\n' "$CODE" | <binary> --pair`; through a remote shell, the same into
   that shell's own stdin, its command being only `<binary> --pair`. Never write the code to a file, a commit, a PR or
   a chat message.
3. On the machine to be controlled: Settings → "Let my other machines control this one".
