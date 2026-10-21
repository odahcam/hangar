# Hangar

A macOS app to catalog, prioritize and resume your Claude Code sessions, so you can close the ones you are not working on without losing track of them.

Hangar reads `~/.claude` directly. Every session shows up on its own; you set its status (to resume, in progress, done), its priority and a note. Resuming opens a Terminal tab with `claude --resume <id>`.

## Features

- **Pending / Done lists** of every session in `~/.claude/projects`, with drag-to-reorder priority, notes, and the Terminal tab of the sessions that are open.
- **Resume / go to tab / close**: drives Terminal.app to resume a closed session, focus an open one, or close it.
- **Transcript backup**: transcripts of pending sessions are copied to `~/Library/Application Support/Hangar/transcripts/`, so Claude Code's cleanup (`cleanupPeriodDays`) cannot delete them. Resume restores the copy if the original is gone.
- **Done detection**: sessions closed for 1h+ are checked by Claude Haiku (through your `claude` CLI). A "done" verdict is shown as a suggestion you confirm or dismiss; at confidence ≥ 0.90 with a verbatim quote of one of your messages, the session is marked done on its own (one click reopens it).
- **Insights**: RAM held by each open session, pending sessions by project and age, prompts per day, new vs. done per week, longest and costliest sessions, storage, idle Terminal tabs.
- **English and Portuguese** UI.

## Requirements

- macOS 13 or later
- [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI (`claude`)
- To build: Node.js ≥ 22.5 and Xcode command line tools (`swiftc`)

## Build

```sh
npm install
npm run build
open build/Hangar.app
```

Move `build/Hangar.app` to `/Applications` to keep it. The build is ad-hoc signed: on another Mac, open it the first time with right-click → Open. **Hangar → Open at Login** starts it with your session.

To run only the server during development: `npm start`, then open the URL printed on stderr.

## Data and privacy

- State (status, priority, notes) and caches: `~/Library/Application Support/Hangar/state.db`
- Server log: `~/Library/Logs/Hangar/server.log`
- Done detection sends the last ~24 messages of a closed session to Claude Haiku via `claude -p`, billed to your Claude account. Nothing else leaves your machine. The server listens on `127.0.0.1` only.

Claude Code deletes transcripts after 30 days by default. To keep them longer, set `"cleanupPeriodDays"` in `~/.claude/settings.json`.

## Limitations

- Terminal.app only (no iTerm2, Ghostty, etc.).
- The first time Hangar controls Terminal, macOS asks for Automation permission.
