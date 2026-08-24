//! Phase 8 backend.
//!
//! Module layout:
//! - `commands`    — IPC commands (`<domain>_<verb_object>` naming) + registry
//! - `connections` — `DbConnection` trait, wire DTOs, engine drivers,
//!   `ConnectionManager` (one actor task per session)
//! - `ssh`         — `russh`-based localhost port-forward tunnels
//! - `credentials` — AES-GCM encrypted password file (argon2id KDF)
//! - `error`       — `AppError`, the single error type crossing IPC
//! - `settings`    — persisted app settings via tauri-plugin-store
//!
//! Desktop shell (Phase 8): native menu bar (`menu://click` events),
//! single-instance CLI handoff (`--connect <session>`, `--new-query`),
//! window-state persistence, and the gated auto-updater groundwork
//! (see `tauri.updater.conf.json` for release signing configuration).

// P0/P8 modules: several items are forward-looking scaffolding consumed in
// later phases; keep dead-code analysis useful by scoping the allowance here.
#![allow(dead_code)]

mod commands;
mod connections;
mod credentials;
mod error;
mod export;
mod find_text;
mod settings;
mod ssh;

use credentials::CredentialStore;
use ssh::SshTunnelManager;
use tauri::{Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

use commands::app::{parse_launch_intent, LaunchIntentState};
use connections::manager::ConnectionManager;

/// Event emitted when a second instance hands over its CLI arguments; the
/// frontend then calls `app_take_launch_intent` to fetch the payload.
const LAUNCH_INTENT_EVENT: &str = "app://launch-intent";

/// Native menu bar. Items carry NO accelerators — keyboard shortcuts are
/// owned by the frontend shortcuts registry (src/lib/shortcuts.ts); giving
/// both sides the same combo would double-fire. Clicks are forwarded to the
/// webview as `menu://click { id }`.
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::*;

    let file = SubmenuBuilder::new(app, "File")
        .text("menu-session-manager", "Session Manager…")
        .text("menu-new-query", "New Query Tab")
        .separator()
        .text("menu-quit", "Quit")
        .build()?;

    // Predefined edit roles keep Cmd/Ctrl+C/V working inside the webview,
    // especially on macOS where WKWebView routes editing through the menu.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .text("menu-toggle-theme", "Toggle Theme")
        .text("menu-toggle-log", "Toggle Message Log")
        .separator()
        .text("menu-refresh-tree", "Refresh Tree")
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .text("menu-shortcuts", "Keyboard Shortcuts")
        .text("menu-check-updates", "Check for Updates…")
        .separator()
        .text("menu-about", "About HeidiClone")
        .build()?;

    let menu = MenuBuilder::new(app).items(&[&file, &edit, &view, &help]).build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    commands::register_commands(
        tauri::Builder::default()
            // Single-instance MUST be registered first so a second launch
            // forwards its argv here instead of starting a new process.
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                let rest = argv.get(1..).unwrap_or(&[]);
                if let Some(intent) = parse_launch_intent(rest) {
                    app.state::<LaunchIntentState>().set(intent);
                    let _ = app.emit(LAUNCH_INTENT_EVENT, ());
                }
            }))
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_store::Builder::new().build())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_clipboard_manager::init())
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                    .build(),
            )
            .setup(|app| {
                app.manage(CredentialStore::load_default()?);
                app.manage(SshTunnelManager::new());
                app.manage(ConnectionManager::new());
                app.manage(LaunchIntentState::new());

                // Park any CLI launch intent; the webview pulls it once ready
                // via `app_take_launch_intent`.
                let args: Vec<String> = std::env::args().collect();
                if let Some(mut intent) = parse_launch_intent(args.get(1..).unwrap_or(&[])) {
                    let sessions =
                        commands::sessions::session_list_impl(app.handle()).unwrap_or_default();
                    intent.resolve_value(&sessions);
                    app.state::<LaunchIntentState>().set(intent);
                }

                #[cfg(desktop)]
                {
                    // Updater groundwork: the plugin refuses to initialize
                    // without a valid `plugins.updater` config object (its
                    // `pubkey` field is required), so register it only when
                    // the release overlay (`tauri.updater.conf.json`, passed
                    // via `tauri build --config`) provided one. Dev/local
                    // builds stay key-free and inert — `Check for Updates…`
                    // surfaces "auto-update unavailable" via the frontend's
                    // error handling.
                    if app.config().plugins.0.contains_key("updater") {
                        app.handle()
                            .plugin(tauri_plugin_updater::Builder::new().build())?;
                    }
                    app.handle().plugin(tauri_plugin_process::init())?;
                }

                build_menu(app)?;

                app.on_menu_event(|app, event| {
                    let _ = app.emit("menu://click", event.id().0.clone());
                });

                Ok(())
            }),
    )
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
