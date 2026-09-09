//! AI assistant commands (Phase 12).
//!
//! The API key never enters webview state: it is saved to the encrypted
//! credential store (entry `ai`, same AES-GCM file as session passwords)
//! and is read back only here, at request time. Everything else about the
//! provider (base URL, model, enabled flag) is non-secret and lives in the
//! frontend's settings store.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::{self, AiJob, AiJobs, AiProviderConfig};
use crate::credentials::CredentialStore;
use crate::error::{AppError, Result};

/// Delta event pushed onto the streaming channel during `ai_run`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamEvent {
    pub delta: String,
}

/// Final result of a completed run (also the command's return value).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunResult {
    pub text: String,
    pub model: String,
}

/// Whether a key is stored, plus a masked hint for the settings UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStatus {
    pub has_key: bool,
    /// e.g. `sk-…abc1` — enough to recognize, useless to an attacker.
    pub hint: Option<String>,
}

/// Store the provider API key in the encrypted credential store.
#[tauri::command]
pub fn ai_save_key(credentials: State<'_, CredentialStore>, key: String) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::Config("API key is empty".into()));
    }
    credentials.save_password(ai::KEY_ENTRY_ID, key, None)
}

/// Report whether a key is stored (without revealing it).
#[tauri::command]
pub fn ai_key_status(credentials: State<'_, CredentialStore>) -> Result<AiKeyStatus> {
    Ok(match credentials.get_password(ai::KEY_ENTRY_ID, None)? {
        Some(key) => {
            let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            AiKeyStatus {
                has_key: true,
                hint: Some(format!("…{tail}")),
            }
        }
        None => AiKeyStatus {
            has_key: false,
            hint: None,
        },
    })
}

/// Remove the stored API key.
#[tauri::command]
pub fn ai_delete_key(credentials: State<'_, CredentialStore>) -> Result<()> {
    credentials.delete_password(ai::KEY_ENTRY_ID, None)
}

/// Run one AI job, streaming text deltas onto `on_event`. `job_id` is
/// minted by the frontend and passed to `ai_cancel` to abort early.
#[tauri::command]
pub async fn ai_run(
    jobs: State<'_, AiJobs>,
    credentials: State<'_, CredentialStore>,
    job_id: u64,
    config: AiProviderConfig,
    job: AiJob,
    on_event: Channel<AiStreamEvent>,
) -> Result<AiRunResult> {
    let cancel = jobs.register(job_id);
    let key = credentials.get_password(ai::KEY_ENTRY_ID, None)?;
    let model = config.model.clone();
    let result = ai::run_job(&config, key.as_deref(), &job, &cancel, |delta| {
        // A dropped webview listener is not worth failing the run over.
        let _ = on_event.send(AiStreamEvent {
            delta: delta.to_string(),
        });
    })
    .await;
    jobs.finish(job_id);
    result.map(|text| AiRunResult { text, model })
}

/// Settings "test connection": one tiny completion with the stored key.
#[tauri::command]
pub async fn ai_test(
    jobs: State<'_, AiJobs>,
    credentials: State<'_, CredentialStore>,
    config: AiProviderConfig,
) -> Result<String> {
    let cancel = jobs.register(u64::MAX); // not cancellable (no id exposure)
    let key = credentials.get_password(ai::KEY_ENTRY_ID, None)?;
    let result = ai::run_job(
        &config,
        key.as_deref(),
        &AiJob {
            mode: ai::AiMode::Test,
            dialect: "mysql".into(),
            database: None,
            schema: None,
            prompt: None,
            sql: None,
            error: None,
        },
        &cancel,
        |_| {},
    )
    .await;
    jobs.finish(u64::MAX);
    result
}

/// Abort an in-flight job. Best effort: returns whether it was active.
#[tauri::command]
pub fn ai_cancel(jobs: State<'_, AiJobs>, job_id: u64) -> bool {
    jobs.cancel(job_id)
}
