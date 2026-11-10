//! Recorder: capture, processing, editing and export, exposed as Tauri commands.

pub mod capture;
pub mod chain;
pub mod denoise;
pub mod dsp;
pub mod export;
pub mod take;
pub mod wav;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use capture::{Session, TrackSpec};
use take::{ExportOptions, Settings, Take};

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static PROGRESS: AtomicU32 = AtomicU32::new(0);

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Let the editor's <audio> element read files from this take folder.
fn allow_dir(app: &tauri::AppHandle, dir: &std::path::Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

#[tauri::command]
pub async fn rec_devices() -> Result<capture::Devices, String> {
    blocking(capture::list_devices).await
}

/// Start recording into `<folder>/<name>/`, or a silent sound check when `folder` is None.
#[tauri::command]
pub async fn rec_start(tracks: Vec<TrackSpec>, folder: Option<String>, name: Option<String>) -> Result<Option<String>, String> {
    blocking(move || {
        if let Some(old) = SESSION.lock().unwrap().take() {
            let _ = old.stop();
        }
        let dir = match folder {
            Some(f) => {
                let base = capture::safe_name(name.as_deref().unwrap_or("Take"));
                let mut d = PathBuf::from(f).join(&base);
                let mut i = 2;
                while d.exists() {
                    d = d.with_file_name(format!("{base} ({i})"));
                    i += 1;
                }
                Some(d)
            }
            None => None,
        };
        let session = capture::start(tracks, dir.clone())?;
        *SESSION.lock().unwrap() = Some(session);
        Ok(dir.map(|d| d.to_string_lossy().to_string()))
    })
    .await
}

#[tauri::command]
pub fn rec_pause(paused: bool) {
    if let Some(s) = SESSION.lock().unwrap().as_mut() {
        s.set_paused(paused);
    }
}

#[derive(Serialize)]
pub struct Status {
    active: bool,
    writing: bool,
    paused: bool,
    elapsed: f64,
    bytes: u64,
    levels: Vec<capture::Level>,
}

#[tauri::command]
pub fn rec_status() -> Status {
    match SESSION.lock().unwrap().as_ref() {
        Some(s) => Status { active: true, writing: s.writing, paused: s.is_paused(), elapsed: s.elapsed(), bytes: capture::bytes_written(s), levels: capture::levels(s) },
        None => Status { active: false, writing: false, paused: false, elapsed: 0.0, bytes: 0, levels: vec![] },
    }
}

#[derive(Serialize)]
pub struct StopResult {
    dir: Option<String>,
    take: Option<Take>,
    errors: Vec<String>,
}

#[tauri::command]
pub async fn rec_stop(app: tauri::AppHandle, name: Option<String>, created: Option<String>) -> Result<StopResult, String> {
    blocking(move || {
        let Some(session) = SESSION.lock().unwrap().take() else {
            return Ok(StopResult { dir: None, take: None, errors: vec![] });
        };
        let dir = session.dir.clone();
        let (results, errors) = session.stop();
        let mut take_out = None;
        if let Some(d) = &dir {
            if !results.is_empty() {
                let t = take::create(d, name.as_deref().unwrap_or("Take"), created.as_deref().unwrap_or(""), &results)?;
                let _ = take::render_preview(d, "raw");
                allow_dir(&app, d);
                take_out = Some(t);
            }
        }
        Ok(StopResult { dir: dir.map(|d| d.to_string_lossy().to_string()), take: take_out, errors })
    })
    .await
}

#[derive(Serialize)]
pub struct TakeEntry {
    dir: String,
    take: Take,
}

#[tauri::command]
pub async fn takes_list(folder: String) -> Result<Vec<TakeEntry>, String> {
    blocking(move || Ok(take::list(&PathBuf::from(folder)).into_iter().map(|(d, t)| TakeEntry { dir: d.to_string_lossy().to_string(), take: t }).collect())).await
}

#[derive(Serialize)]
pub struct TakeInfo {
    take: Take,
    can_undo: bool,
    preview_raw: Option<String>,
    preview_processed: Option<String>,
}

#[tauri::command]
pub async fn take_open(app: tauri::AppHandle, dir: String) -> Result<TakeInfo, String> {
    blocking(move || {
        let d = PathBuf::from(&dir);
        allow_dir(&app, &d);
        let t = take::load(&d)?;
        let raw = take::preview_path(&d, "raw");
        if !raw.exists() {
            let _ = take::render_preview(&d, "raw");
        }
        let processed = take::preview_path(&d, "processed");
        if t.tracks.iter().any(|x| x.processed) && !processed.exists() {
            let _ = take::render_preview(&d, "processed");
        }
        Ok(TakeInfo {
            can_undo: take::can_undo(&d),
            preview_raw: raw.exists().then(|| raw.to_string_lossy().to_string()),
            preview_processed: processed.exists().then(|| processed.to_string_lossy().to_string()),
            take: t,
        })
    })
    .await
}

#[tauri::command]
pub async fn take_process(dir: String, settings: HashMap<String, Settings>) -> Result<Vec<take::ProcessReport>, String> {
    PROGRESS.store(0, Ordering::Relaxed);
    blocking(move || {
        let r = take::process(
            &PathBuf::from(dir),
            &settings,
            &mut || Box::new(denoise::Rnnoise::new()),
            &mut |p| PROGRESS.store((p.clamp(0.0, 1.0) * 1000.0) as u32, Ordering::Relaxed),
        );
        PROGRESS.store(1000, Ordering::Relaxed);
        r
    })
    .await
}

#[tauri::command]
pub fn take_progress() -> f32 {
    PROGRESS.load(Ordering::Relaxed) as f32 / 1000.0
}

#[tauri::command]
pub async fn take_peaks(dir: String, which: String, buckets: usize) -> Result<Vec<take::TrackPeaks>, String> {
    blocking(move || take::peaks(&PathBuf::from(dir), &which, buckets.clamp(100, 8000))).await
}

#[tauri::command]
pub async fn take_cut(dir: String, start: f64, end: f64) -> Result<(), String> {
    blocking(move || take::cut(&PathBuf::from(dir), start, end)).await
}

#[tauri::command]
pub async fn take_trim(dir: String, start: f64, end: f64) -> Result<(), String> {
    blocking(move || take::trim(&PathBuf::from(dir), start, end)).await
}

#[tauri::command]
pub async fn take_remove_silence(dir: String, reference: String, threshold: f32, min_ms: f32, keep_ms: f32, dry_run: bool) -> Result<f64, String> {
    blocking(move || take::remove_silence(&PathBuf::from(dir), &reference, threshold, min_ms, keep_ms, dry_run)).await
}

#[tauri::command]
pub async fn take_undo(dir: String) -> Result<(), String> {
    blocking(move || take::undo(&PathBuf::from(dir))).await
}

#[tauri::command]
pub async fn take_export(dir: String, options: ExportOptions) -> Result<Vec<String>, String> {
    blocking(move || take::export(&PathBuf::from(dir), &options)).await
}

#[tauri::command]
pub async fn take_rename(dir: String, name: String) -> Result<(), String> {
    blocking(move || {
        let d = PathBuf::from(dir);
        let mut t = take::load(&d)?;
        t.name = name.trim().chars().take(80).collect();
        take::save(&d, &t)
    })
    .await
}
