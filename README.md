<h1><img src="web/icon.svg" width="40" align="top" alt=""> Hangar</h1>

Keep track of your Claude Code sessions, so you can close the ones you're not using without losing them.

Every session shows up on its own. You mark what to resume, set the order, write a note about where you stopped, and get back to any session with one click.

<img src="docs/images/pending.png" alt="Hangar showing pending sessions with status, priority, notes and a done suggestion">

## Install on macOS

**1. Download.** Get **Hangar.zip** from the [latest release](../../releases/latest).

**2. Move to Applications.** Double-click the zip, then drag **Hangar.app** into your **Applications** folder.

**3. Open it the first time.** Hangar isn't from the App Store, so macOS stops the first launch with this message. Click **Done**.

<img src="docs/images/gatekeeper-blocked.png" width="300" alt="macOS dialog: “Hangar” Not Opened">

Then open **System Settings → Privacy & Security**, scroll down to **Security**, and click **Open Anyway** next to the Hangar message.

<img src="docs/images/open-anyway.png" width="484" alt="Privacy & Security settings with the Open Anyway button">

macOS asks one last time. Click **Open Anyway** again and confirm with your password or Touch ID.

<img src="docs/images/open-anyway-confirm.png" width="300" alt="macOS dialog: Open “Hangar”? with the Open Anyway button">

You only do this once. From then on Hangar opens like any other app.

> **Prefer the Terminal?** This does the same as step 3:
> ```sh
> xattr -dr com.apple.quarantine /Applications/Hangar.app
> ```

**4. Start it with your Mac (optional).** In the menu bar, choose **Hangar → Open at Login**.

The first time you click **Resume**, macOS asks whether Hangar may control Terminal. Click **Allow**, since that's how it opens your sessions.

## Install on Windows

**1. Download.** Get **Hangar_…_x64-setup.exe** from the [latest release](../../releases/latest).

**2. Run it.** The installer isn't signed, so SmartScreen may say *Windows protected your PC*. Click **More info**, then **Run anyway**. Hangar installs for your user only, with no administrator prompt.

**3. Start it with Windows (optional).** In the app's menu, choose **Hangar → Open at Login**.

Resume opens the session in a new [Windows Terminal](https://aka.ms/terminal) tab (or a console window of its own if Windows Terminal isn't installed).

### What you need

- macOS 13 or later on Apple Silicon, or Windows 10/11 (64-bit; the installer adds the WebView2 runtime if it is missing)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed (the `claude` command)

## What it does

- **Pending and Done lists** with every session in `~/.claude` (or `$CLAUDE_CONFIG_DIR`): status (to resume, in progress, done), drag-to-reorder priority, notes, and which ones are open right now.
- **Several accounts**: every `~/.claude` and `~/.claude-*` folder is an account, plus any config folder you add in Settings (⚙, or Hangar → Settings…). Each session shows its account, the list filters by account, and accounts can be renamed, recolored or hidden. A session started with the wrong account can be copied or moved to another one, notes and status included.
- **Resume, go to tab, close**: opens a closed session in a new terminal tab under its own account, jumps to the tab of an open one (macOS), or closes it.
- **Transcript backup**: copies the transcripts of pending sessions into Hangar's data folder, so Claude Code's automatic cleanup can't delete them.
- **Done detection**: once a session has been closed for an hour, Claude Haiku reads its last messages. If it looks finished, you get a suggestion to confirm or dismiss. When it is at least 90% sure and can quote you saying so, it marks the session done by itself, and one click reopens it.
- **Insights**: how much RAM each open session holds, what's pending per project and for how long, prompts per day, longest and costliest sessions.
- **English and Portuguese**.

<img src="docs/images/insights.png" alt="Insights: prompts per day, new vs. done per week, longest sessions">

## Data and privacy

- Everything stays on your computer. State, notes and transcript backups live in `~/Library/Application Support/Hangar/` on macOS and `%APPDATA%\Hangar\` on Windows. Hangar opens no network port.
- Done detection sends the last ~24 messages of a closed session to Claude Haiku through your own `claude` CLI, billed to your Claude account (fractions of a cent per session).
- Claude Code deletes transcripts after 30 days by default. To keep them longer, set `"cleanupPeriodDays"` in `~/.claude/settings.json`.

## Limitations

- macOS: Terminal.app only (no iTerm2, Ghostty, etc.).
- Windows: Windows Terminal can't be asked for its tabs, so Hangar can't bring an open session's tab forward, list idle tabs or close them. An open session shows no Resume button (resuming it again would fork it); Close still stops it.
- Linux: not yet (see [#2](../../issues/2)).

## How it's built

- `core/`: the Rust core. Scans transcripts, keeps state in SQLite, runs done detection and insights, and drives the terminal through a `Platform` trait with one implementation per OS (`core/src/platform/`). Its whole API is one router, `Hangar::handle(method, path, body)`.
- `app/`: the desktop app ([Tauri](https://tauri.app)). One process: the web UI runs in the system webview (WKWebView, WebView2) and calls the router in-process.
- `web/`: the UI, shared by both.
- `hangar-server` (`core/src/bin/`): the same router over HTTP on `127.0.0.1`. The tests and `npm start` use it; the app doesn't.

## Build from source

Needs [Rust](https://rustup.rs), Node.js ≥ 22, and the Xcode command line tools (macOS) or the Visual Studio C++ Build Tools (Windows).

```sh
npm install
npm run build      # target/release/bundle/: Hangar.app on macOS, the NSIS installer on Windows
npm run app        # run the desktop app without packaging it
npm start          # only the core over HTTP; open the URL it prints in a browser
```

## Tests

```sh
npm test              # the core: scanning, state, terminal actions, done detection, insights, i18n, repo hygiene
npm run test:e2e      # the UI in Chrome, against the core over HTTP
npm run test:desktop  # the same UI specs, driving the real desktop app (Windows: WebView2 speaks the DevTools protocol)
npm run test:build    # builds the release app and checks the bundle, signature, and that it starts on its own
```

The suites are written against the API, not the implementation: the same suites that verified the old Node server now verify the Rust core. They never touch your real `~/.claude` or terminal: each test runs over a throwaway fixture directory, with fake `osascript`, `wt` and `claude` binaries in `test/bin/`. CI runs everything on macOS and Windows.

## License

Source-available, not open source. You may use Hangar and modify it for personal use; you may not redistribute it or modified versions, paid or free. Contributions through pull requests are welcome. See [LICENSE](LICENSE).
