//! Thin wrapper around `tauri-plugin-store` for persisted app settings
//! (theme, window layout, ...). Values are addressed by string keys in a
//! single JSON document (`settings.json` inside the app data dir).

use serde_json::Value;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

/// Store file name, relative to the app config/data directory.
pub const SETTINGS_FILE: &str = "settings.json";

/// Known setting keys. Keep in sync with the frontend.
pub mod keys {
    pub const THEME: &str = "theme";
}

/// Read a setting value, if present.
pub fn get_setting<R: Runtime>(app: &AppHandle<R>, key: &str) -> Option<Value> {
    let store = app.store(SETTINGS_FILE).ok()?;
    store.get(key)
}

/// Read a setting with a fallback default.
pub fn get_setting_or<R: Runtime>(app: &AppHandle<R>, key: &str, default: Value) -> Value {
    get_setting(app, key).unwrap_or(default)
}

/// Persist a setting value to disk.
pub fn set_setting<R: Runtime>(
    app: &AppHandle<R>,
    key: &str,
    value: impl Into<Value>,
) -> crate::error::Result<()> {
    let store = app.store(SETTINGS_FILE)?;
    store.set(key, value.into());
    store.save()?;
    Ok(())
}
