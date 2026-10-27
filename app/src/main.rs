// Hangar desktop app: one process. The web UI runs in the system webview (WKWebView, WebView2) and calls the core
// in-process through the `api` command, the same router hangar-server exposes over HTTP to the tests.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use hangar_core::{Config, Hangar};
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

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
    let sep = || PredefinedMenuItem::separator(app);
    let view = Submenu::with_items(app, "View", true, &[&reload])?;
    #[cfg(target_os = "macos")]
    let menu = {
        let hangar = Submenu::with_items(app, "Hangar", true, &[
            &PredefinedMenuItem::about(app, Some("About Hangar"), None)?, &sep()?, &login, &sep()?,
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
        let hangar = Submenu::with_items(app, "Hangar", true, &[&login, &sep()?, &PredefinedMenuItem::quit(app, Some("Quit"))?])?;
        Menu::with_items(app, &[&hangar, &view])?
    };
    Ok((menu, login))
}

fn refresh_login_item(app: &AppHandle) {
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let _ = app.state::<LoginItem>().0.set_checked(enabled);
}

fn toggle_login_item(app: &AppHandle) {
    let launcher = app.autolaunch();
    let result = if launcher.is_enabled().unwrap_or(false) { launcher.disable() } else { launcher.enable() };
    if let Err(e) = result {
        eprintln!("open at login: {e}");
    }
    refresh_login_item(app);
}

#[cfg(target_os = "macos")]
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    let hangar = Hangar::open(Config::from_env()).unwrap_or_else(|e| {
        eprintln!("hangar: {e}");
        std::process::exit(1);
    });
    hangar.spawn_background();

    let mut app = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    // Off-screen test instances must neither restore nor overwrite the real window position.
    if std::env::var_os("HANGAR_WINDOW_OFFSCREEN").is_none() {
        app = app.plugin(tauri_plugin_window_state::Builder::default().build());
    }
    app
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(hangar)
        .invoke_handler(tauri::generate_handler![api])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "login" => toggle_login_item(app),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("location.reload()");
                }
            }
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let (menu, login) = build_menu(&handle)?;
            app.set_menu(menu)?;
            app.manage(LoginItem(login));
            refresh_login_item(&handle);

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
            let window = builder
                .title("Hangar")
                .inner_size(1100.0, 800.0)
                .min_inner_size(480.0, 400.0)
                // Links that leave the app open in the default browser.
                .on_navigation(move |url| {
                    let internal = !matches!(url.scheme(), "http" | "https") || matches!(url.host_str(), Some("tauri.localhost" | "localhost"));
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
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main(_app);
            }
        });
}
