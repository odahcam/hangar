// Hangar desktop app: one process. The web UI runs in the system webview (WKWebView, WebView2) and calls the core
// in-process through the `api` command, the same router hangar-server exposes over HTTP to the tests.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use hangar_core::cloud::oauth::AuthError;
use hangar_core::{Config, Hangar};
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

/// Passed by the login item: Hangar comes up without its window (on Windows, in the tray).
const HIDDEN: &str = "--hidden";

/// A hangar:// link: only the sign-in callback means anything, and the core accepts it only for the sign-in it is
/// waiting for (state, issuer). On Windows the link arrives as the argument of a second instance, from anyone.
fn open_link(app: &AppHandle, url: &str) {
    if !url.starts_with(hangar_core::cloud::oauth::REDIRECT_URI) {
        return;
    }
    let Some(cloud) = app.state::<Arc<Hangar>>().cloud() else { return };
    let (app, url) = (app.clone(), url.to_string());
    std::thread::spawn(move || {
        let r = cloud.complete_login(&url);
        // A link that isn't for the sign-in under way (any web page can open one) is dropped without a sound.
        if matches!(&r, Err(AuthError::Invalid(e)) if ["state", "iss", "query", "callback"].contains(&e.as_str())) {
            return;
        }
        show_main(&app);
        if let Some(w) = app.get_webview_window("main") {
            let err = r.err().map(|e| e.to_string()).unwrap_or_default();
            let _ = w.eval(format!("cloudLinked({})", serde_json::Value::String(err)));
        }
    });
}

/// The UI's whole API: `api(method, path, body)` resolves to the JSON body or rejects with its `error`.
#[tauri::command(async)]
fn api(hangar: tauri::State<'_, Arc<Hangar>>, method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let r = hangar.handle(&method, &path, &body);
    if r.status < 400 {
        Ok(r.body)
    } else {
        Err(r.body["error"].as_str().map_or_else(|| r.status.to_string(), String::from))
    }
}

struct LoginItem(CheckMenuItem<Wry>);

fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<Wry>, CheckMenuItem<Wry>)> {
    let login = CheckMenuItem::with_id(app, "login", "Open at Login", true, false, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let sep = || PredefinedMenuItem::separator(app);
    let view = Submenu::with_items(app, "View", true, &[&reload])?;
    #[cfg(target_os = "macos")]
    let menu = {
        let hangar = Submenu::with_items(app, "Hangar", true, &[
            &PredefinedMenuItem::about(app, Some("About Hangar"), None)?, &sep()?, &settings, &login, &sep()?,
            &PredefinedMenuItem::hide(app, Some("Hide Hangar"))?, &PredefinedMenuItem::quit(app, Some("Quit Hangar"))?,
        ])?;
        // Without an Edit menu, copy/paste/select-all shortcuts do nothing inside the web view.
        let edit = Submenu::with_items(app, "Edit", true, &[
            &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?, &sep()?,
            &PredefinedMenuItem::cut(app, None)?, &PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ])?;
        let window = Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::close_window(app, None)?, &PredefinedMenuItem::minimize(app, None)?])?;
        Menu::with_items(app, &[&hangar, &edit, &view, &window])?
    };
    // WebView2 handles the editing shortcuts itself; the menu bar only carries what has no other home.
    #[cfg(not(target_os = "macos"))]
    let menu = {
        let hangar = Submenu::with_items(app, "Hangar", true, &[&settings, &login, &sep()?, &PredefinedMenuItem::quit(app, Some("Quit"))?])?;
        Menu::with_items(app, &[&hangar, &view])?
    };
    Ok((menu, login))
}

/// The login item, the person's own: a LaunchAgent on macOS, HKCU's Run key on Windows (never HKLM's, which an
/// elevated app would otherwise get, starting Hangar for every user of the machine).
fn launcher(app: &AppHandle) -> Option<auto_launch::AutoLaunch> {
    let exe = std::env::current_exe().ok()?;
    #[cfg(target_os = "macos")]
    let exe = exe.canonicalize().ok()?;
    let mut b = auto_launch::AutoLaunchBuilder::new();
    b.set_app_name(&app.package_info().name).set_app_path(&exe.display().to_string()).set_args(&[HIDDEN]);
    #[cfg(target_os = "macos")]
    b.set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent);
    #[cfg(windows)]
    b.set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser);
    b.build().map_err(|e| eprintln!("open at login: {e}")).ok()
}

fn login_enabled(app: &AppHandle) -> bool {
    launcher(app).is_some_and(|l| l.is_enabled().unwrap_or(false))
}

fn refresh_login_item(app: &AppHandle) {
    let _ = app.state::<LoginItem>().0.set_checked(login_enabled(app));
}

/// A test instance leaves the login item alone (it would point it at the test build), unless a spec is about it.
static LOGIN_ITEM: AtomicBool = AtomicBool::new(true);

fn toggle_login_item(app: &AppHandle) {
    if !LOGIN_ITEM.load(Ordering::SeqCst) {
        return;
    }
    let Some(l) = launcher(app) else { return };
    let result = if l.is_enabled().unwrap_or(false) { l.disable() } else { l.enable() };
    if let Err(e) = result {
        eprintln!("open at login: {e}");
    }
    refresh_login_item(app);
}

/// The window started hidden and hasn't been shown yet: its saved size and place (window-state) wait for its first
/// showing, since restoring a maximized or full-screen window shows it.
static STATE_PENDING: AtomicBool = AtomicBool::new(false);
/// window-state's file as the hidden launch found it (None: there was none).
static SAVED_STATE: OnceLock<Option<Vec<u8>>> = OnceLock::new();

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if STATE_PENDING.swap(false, Ordering::SeqCst) {
            let _ = w.restore_state(StateFlags::all() - StateFlags::VISIBLE);
        }
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The app menu's and the tray's items.
fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "login" => toggle_login_item(app),
        "tray-open" => show_main(app),
        "tray-quit" => app.exit(0),
        "reload" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("location.reload()");
            }
        }
        // Settings is a view of the page (web/index.html), the same one its header button opens.
        "settings" => {
            show_main(app);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("showView('settings')");
            }
        }
        _ => {}
    }
}

/// Debug builds: the desktop e2e specs pick a menu or tray item, which the DevTools protocol can't reach.
#[cfg(debug_assertions)]
#[tauri::command]
fn e2e_menu(app: AppHandle, id: String) {
    on_menu(&app, &id);
}

/// Windows: the tray icon brings the window back (a click, or Open Hangar) and quits.
#[cfg(windows)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItem::with_id(app, "tray-open", "Open Hangar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Hangar")
        .menu(&Menu::with_items(app, &[&open, &quit])?)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    // `Hangar --offer` / `--pair <code>`: a command that asks the running app (see core/src/cli.rs).
    if let Some(code) = hangar_core::cli::client() {
        std::process::exit(code);
    }
    let hangar = Hangar::open(Config::from_env()).unwrap_or_else(|e| {
        eprintln!("hangar: {e}");
        std::process::exit(1);
    });
    hangar.spawn_background();
    // Test instances run side by side on throwaway data: no single instance, no device identity in the real keychain.
    let test_instance = std::env::var_os("HANGAR_WEBVIEW_DATA").is_some();
    let hidden = std::env::args().any(|a| a == HIDDEN);
    let login_item = !test_instance || std::env::var_os("HANGAR_E2E_LOGIN").is_some();
    LOGIN_ITEM.store(login_item, Ordering::SeqCst);
    #[cfg(debug_assertions)]
    let handlers: fn(tauri::ipc::Invoke<Wry>) -> bool = tauri::generate_handler![api, e2e_menu];
    #[cfg(not(debug_assertions))]
    let handlers: fn(tauri::ipc::Invoke<Wry>) -> bool = tauri::generate_handler![api];

    let mut app = tauri::Builder::default();
    if !test_instance {
        // First: a second launch (on Windows, how a hangar:// link arrives; a pairing command) hands its arguments to
        // this instance and quits.
        app = app.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if hangar_core::cli::serve(&app.state::<Arc<Hangar>>(), &argv) {
                return;
            }
            for a in argv.iter().skip(1) {
                open_link(app, a);
            }
            if !argv.iter().any(|a| a == HIDDEN) {
                show_main(app);
            }
        }));
    }
    let mut app = app.plugin(tauri_plugin_deep_link::init()).plugin(tauri_plugin_opener::init());
    // Off-screen test instances must neither restore nor overwrite the real window position, unless given a file of
    // their own (HANGAR_WINDOW_STATE, absolute: it replaces the config dir's).
    let state_file = std::env::var("HANGAR_WINDOW_STATE").ok();
    if std::env::var_os("HANGAR_WINDOW_OFFSCREEN").is_none() || state_file.is_some() {
        // Whether the window shows is the launch's to say (HIDDEN), not the last session's.
        let mut state = tauri_plugin_window_state::Builder::default().with_state_flags(StateFlags::all() - StateFlags::VISIBLE);
        if let Some(f) = state_file {
            state = state.with_filename(f);
        }
        if hidden {
            state = state.skip_initial_state("main");
            STATE_PENDING.store(true, Ordering::SeqCst);
        }
        app = app.plugin(state.build());
    }
    app
        .manage(hangar)
        .invoke_handler(handlers)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            if STATE_PENDING.load(Ordering::SeqCst) {
                if let Ok(dir) = handle.path().app_config_dir() {
                    let _ = SAVED_STATE.set(std::fs::read(dir.join(handle.filename())).ok());
                }
            }
            // Remote control starts once this is the only instance: a second launch quits in the plugin above, before
            // it could load the device identity or open a second link to the relay.
            if !test_instance {
                let hangar = app.state::<Arc<Hangar>>();
                if let Err(e) = hangar.start_cloud() {
                    eprintln!("cloud: {e}");
                }
                // Only the one instance types into herdr's terminals.
                hangar.spawn_herdr();
                // Started by a pairing command when the app wasn't running.
                hangar_core::cli::serve(&hangar, &std::env::args().collect::<Vec<_>>());
            }
            // macOS delivers links as events; on Windows the installer registers the scheme, and a dev build
            // registers it here.
            #[cfg(all(windows, debug_assertions))]
            let _ = app.deep_link().register_all();
            let links = handle.clone();
            app.deep_link().on_open_url(move |e| {
                for u in e.urls() {
                    open_link(&links, u.as_str());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for u in urls {
                    open_link(&handle, u.as_str());
                }
            }
            let (menu, login) = build_menu(&handle)?;
            app.set_menu(menu)?;
            app.manage(LoginItem(login));
            refresh_login_item(&handle);
            // A login item written before it passed HIDDEN is written again, with it.
            if let Some(l) = launcher(&handle).filter(|l| login_item && l.is_enabled().unwrap_or(false)) {
                let _ = l.enable();
            }
            #[cfg(windows)]
            if !test_instance {
                build_tray(&handle)?;
            }

            let opener = handle.clone();
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            // The desktop e2e target runs app instances side by side: each needs its own webview profile
            // (on Windows, its own WebView2 browser process and DevTools port).
            if let Some(dir) = std::env::var_os("HANGAR_WEBVIEW_DATA") {
                builder = builder.data_directory(dir.into());
            }
            // ...and must not flood the desktop: off screen, unfocused, out of the taskbar. Still "visible", so the
            // webview isn't throttled the way a hidden window would be.
            if std::env::var_os("HANGAR_WINDOW_OFFSCREEN").is_some() {
                builder = builder.position(-32000.0, -32000.0).focused(false).skip_taskbar(true);
            }
            // ...and drives the webview over the DevTools protocol (WebView2 only). Extra browser arguments replace
            // Tauri's own, so they are kept, and --disable-features is merged since a second one would override the first.
            #[cfg(windows)]
            if let Ok(args) = std::env::var("HANGAR_WEBVIEW_ARGS") {
                let mut features = vec!["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"];
                let mut rest = vec![];
                for a in args.split_whitespace() {
                    match a.strip_prefix("--disable-features=") {
                        Some(f) => features.extend(f.split(',')),
                        None => rest.push(a),
                    }
                }
                builder = builder.additional_browser_args(&format!("--disable-features={} {}", features.join(","), rest.join(" ")));
            }
            let window = builder
                .title("Hangar")
                .visible(!hidden)
                .inner_size(1100.0, 800.0)
                .min_inner_size(480.0, 400.0)
                // Links that leave the app open in the default browser. `tauri dev` serves the page from 127.0.0.1.
                .on_navigation(move |url| {
                    let internal = !matches!(url.scheme(), "http" | "https") || matches!(url.host_str(), Some("tauri.localhost" | "localhost" | "127.0.0.1"));
                    if !internal {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    internal
                })
                .build()?;
            // On macOS closing the window keeps Hangar running (done detection, backups); the Dock icon brings it back.
            #[cfg(target_os = "macos")]
            {
                let w = window.clone();
                window.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }
            #[cfg(not(target_os = "macos"))]
            let _ = window;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Hangar")
        .run(|app, event| match event {
            // Never shown: window-state just saved the hidden window's default size (its exit handler runs before
            // this one) over the state it was waiting to restore; that state goes back.
            tauri::RunEvent::Exit if STATE_PENDING.load(Ordering::SeqCst) => {
                if let (Ok(dir), Some(saved)) = (app.path().app_config_dir(), SAVED_STATE.get()) {
                    let file = dir.join(app.filename());
                    let _ = match saved {
                        Some(bytes) => std::fs::write(file, bytes),
                        None => std::fs::remove_file(file),
                    };
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
