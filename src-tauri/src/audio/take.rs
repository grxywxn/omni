//! A "take" is one recording session on disk:
//!   <folder>/<Take name>/take.json
//!                       /raw/<track>.wav        exactly what was captured
//!                       /processed/<track>.wav  after the voice chain (48 kHz)
//!                       /.undo/<n>/...          snapshots for Undo
//!                       /.preview-*.wav         mixes for listening in the editor

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::capture::{safe_name, TrackResult};
use super::chain::{self, Chain, Denoiser, EqParams, LoudnessParams};
use super::dsp::{self, CompParams, DeessParams, GateParams};
use super::wav::{self, Audio, SampleFormat};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TakeTrack {
    pub id: String,
    pub label: String,
    pub file: String,
    #[serde(default)]
    pub processed: bool,
    #[serde(default)]
    pub lufs: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Take {
    pub name: String,
    pub created: String,
    pub seconds: f64,
    pub tracks: Vec<TakeTrack>,
    #[serde(default)]
    pub preset: Option<String>,
}

pub fn take_file(dir: &Path) -> PathBuf {
    dir.join("take.json")
}

pub fn load(dir: &Path) -> Result<Take, String> {
    let s = std::fs::read_to_string(take_file(dir)).map_err(|e| format!("Can't open this take: {e}"))?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

pub fn save(dir: &Path, t: &Take) -> Result<(), String> {
    std::fs::write(take_file(dir), serde_json::to_string_pretty(t).unwrap()).map_err(|e| e.to_string())
}

pub fn create(dir: &Path, name: &str, created: &str, results: &[TrackResult]) -> Result<Take, String> {
    let t = Take {
        name: name.to_string(),
        created: created.to_string(),
        seconds: results.iter().map(|r| r.seconds).fold(0.0, f64::max),
        tracks: results.iter().map(|r| TakeTrack { id: r.id.clone(), label: r.label.clone(), file: r.file.clone(), processed: false, lufs: None }).collect(),
        preset: None,
    };
    save(dir, &t)?;
    Ok(t)
}

/// All takes in a folder, newest first.
pub fn list(folder: &Path) -> Vec<(PathBuf, Take)> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(folder) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Ok(t) = load(&p) {
                    out.push((p, t));
                }
            }
        }
    }
    out.sort_by(|a, b| b.1.created.cmp(&a.1.created));
    out
}

// ---- Processing settings (what the UI sends) ------------------------------------------
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Stage<T> {
    pub enabled: bool,
    #[serde(flatten)]
    pub p: T,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DenoiseS { pub amount: f32 }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HighpassS { pub freq: f32 }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GateS { pub threshold: f32, pub range: f32, pub attack: f32, pub hold: f32, pub release: f32 }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EqS { pub low: f32, pub mud: f32, pub presence: f32, pub air: f32 }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DeessS { pub freq: f32, pub threshold: f32, pub reduction: f32 }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CompS { pub threshold: f32, pub ratio: f32, pub attack: f32, pub release: f32, pub makeup: f32 }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LoudS { pub target: f32, pub ceiling: f32 }

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Settings {
    pub mono: bool,
    pub denoise: Stage<DenoiseS>,
    pub highpass: Stage<HighpassS>,
    pub gate: Stage<GateS>,
    pub eq: Stage<EqS>,
    pub deesser: Stage<DeessS>,
    pub compressor: Stage<CompS>,
    pub loudness: Stage<LoudS>,
}

impl Settings {
    pub fn to_chain(&self) -> Chain {
        Chain {
            mono: self.mono,
            denoise: self.denoise.enabled.then_some(self.denoise.p.amount),
            highpass_hz: self.highpass.enabled.then_some(self.highpass.p.freq),
            gate: self.gate.enabled.then(|| GateParams {
                threshold_db: self.gate.p.threshold,
                range_db: self.gate.p.range,
                attack_ms: self.gate.p.attack,
                hold_ms: self.gate.p.hold,
                release_ms: self.gate.p.release,
            }),
            eq: self.eq.enabled.then(|| EqParams { low_shelf_db: self.eq.p.low, mud_db: self.eq.p.mud, presence_db: self.eq.p.presence, air_db: self.eq.p.air }),
            deess: self.deesser.enabled.then(|| DeessParams { freq: self.deesser.p.freq, threshold_db: self.deesser.p.threshold, max_reduction_db: self.deesser.p.reduction }),
            compressor: self.compressor.enabled.then(|| CompParams {
                threshold_db: self.compressor.p.threshold,
                ratio: self.compressor.p.ratio,
                knee_db: 6.0,
                attack_ms: self.compressor.p.attack,
                release_ms: self.compressor.p.release,
                makeup_db: self.compressor.p.makeup,
            }),
            loudness: self.loudness.enabled.then(|| LoudnessParams { target_lufs: self.loudness.p.target, ceiling_db: self.loudness.p.ceiling }),
        }
    }
}

#[derive(Serialize)]
pub struct ProcessReport {
    pub id: String,
    pub input_lufs: f32,
    pub output_lufs: f32,
    pub peak_db: f32,
}

/// Run each track's raw audio through its chain into processed/.
pub fn process(
    dir: &Path,
    settings: &std::collections::HashMap<String, Settings>,
    make_denoiser: &mut dyn FnMut() -> Box<dyn Denoiser>,
    progress: &mut dyn FnMut(f32),
) -> Result<Vec<ProcessReport>, String> {
    let mut take = load(dir)?;
    std::fs::create_dir_all(dir.join("processed")).map_err(|e| e.to_string())?;
    let n = take.tracks.len().max(1) as f32;
    let mut reports = Vec::new();
    for (i, t) in take.tracks.iter_mut().enumerate() {
        let Some(s) = settings.get(&t.id) else { continue };
        let raw = wav::read(&dir.join("raw").join(&t.file)).map_err(|e| format!("{}: {e}", t.label))?;
        let (out, rep) = chain::process(&raw, &s.to_chain(), make_denoiser, &mut |p| progress((i as f32 + p) / n));
        wav::write(&dir.join("processed").join(&t.file), &out, SampleFormat::Float32).map_err(|e| e.to_string())?;
        t.processed = true;
        t.lufs = Some(rep.output_lufs);
        reports.push(ProcessReport { id: t.id.clone(), input_lufs: rep.input_lufs, output_lufs: rep.output_lufs, peak_db: rep.output_peak_db });
    }
    save(dir, &take)?;
    let _ = render_preview(dir, "processed");
    Ok(reports)
}

// ---- Editing (applies to raw AND processed files so they stay in sync) -----------------
fn all_audio_files(dir: &Path, take: &Take) -> Vec<PathBuf> {
    let mut v = Vec::new();
    for t in &take.tracks {
        for sub in ["raw", "processed"] {
            let p = dir.join(sub).join(&t.file);
            if p.exists() {
                v.push(p);
            }
        }
    }
    v
}

fn snapshot(dir: &Path, take: &Take) -> Result<(), String> {
    let undo = dir.join(".undo");
    std::fs::create_dir_all(&undo).map_err(|e| e.to_string())?;
    let mut existing: Vec<u64> = std::fs::read_dir(&undo).map_err(|e| e.to_string())?
        .flatten().filter_map(|e| e.file_name().to_string_lossy().parse().ok()).collect();
    existing.sort();
    let next = existing.last().copied().unwrap_or(0) + 1;
    let snap = undo.join(next.to_string());
    for f in all_audio_files(dir, take) {
        let rel = f.strip_prefix(dir).unwrap();
        let target = snap.join(rel);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::copy(&f, &target).map_err(|e| e.to_string())?;
    }
    std::fs::copy(take_file(dir), snap.join("take.json")).map_err(|e| e.to_string())?;
    // Keep the last 8 undo steps.
    while existing.len() >= 8 {
        let old = existing.remove(0);
        let _ = std::fs::remove_dir_all(undo.join(old.to_string()));
    }
    Ok(())
}

pub fn can_undo(dir: &Path) -> bool {
    std::fs::read_dir(dir.join(".undo")).map(|mut r| r.next().is_some()).unwrap_or(false)
}

pub fn undo(dir: &Path) -> Result<(), String> {
    let undo = dir.join(".undo");
    let mut existing: Vec<u64> = std::fs::read_dir(&undo).map_err(|_| "Nothing to undo".to_string())?
        .flatten().filter_map(|e| e.file_name().to_string_lossy().parse().ok()).collect();
    existing.sort();
    let last = existing.pop().ok_or("Nothing to undo")?;
    let snap = undo.join(last.to_string());
    for sub in ["raw", "processed"] {
        let src = snap.join(sub);
        if let Ok(rd) = std::fs::read_dir(&src) {
            for e in rd.flatten() {
                std::fs::copy(e.path(), dir.join(sub).join(e.file_name())).map_err(|e| e.to_string())?;
            }
        }
    }
    std::fs::copy(snap.join("take.json"), take_file(dir)).map_err(|e| e.to_string())?;
    std::fs::remove_dir_all(&snap).map_err(|e| e.to_string())?;
    refresh_previews(dir);
    Ok(())
}

/// Apply a cut list (in seconds) to every file in the take.
fn apply_cuts(dir: &Path, take: &mut Take, cuts_secs: &[(f64, f64)]) -> Result<(), String> {
    for f in all_audio_files(dir, take) {
        let mut a = wav::read(&f).map_err(|e| e.to_string())?;
        let r = a.rate as f64;
        let n = a.frames();
        let ranges: Vec<(usize, usize)> = cuts_secs.iter().map(|&(s, e)| (((s * r) as usize).min(n), ((e * r) as usize).min(n))).filter(|(s, e)| e > s).collect();
        dsp::remove_ranges(&mut a.channels, &ranges, a.rate);
        wav::write(&f, &a, SampleFormat::Float32).map_err(|e| e.to_string())?;
    }
    let removed: f64 = cuts_secs.iter().map(|(s, e)| (e - s).max(0.0)).sum();
    take.seconds = (take.seconds - removed).max(0.0);
    save(dir, take)?;
    refresh_previews(dir);
    Ok(())
}

pub fn cut(dir: &Path, start: f64, end: f64) -> Result<(), String> {
    let mut take = load(dir)?;
    snapshot(dir, &take)?;
    apply_cuts(dir, &mut take, &[(start.min(end), start.max(end))])
}

pub fn trim(dir: &Path, start: f64, end: f64) -> Result<(), String> {
    let mut take = load(dir)?;
    snapshot(dir, &take)?;
    let (s, e) = (start.min(end), start.max(end));
    let tail_end = take.seconds + 1.0;
    apply_cuts(dir, &mut take, &[(0.0, s), (e, tail_end)])
}

/// Shorten long pauses. Detection uses `reference_id`'s processed (or raw) audio.
pub fn remove_silence(dir: &Path, reference_id: &str, threshold_db: f32, min_ms: f32, keep_ms: f32, dry_run: bool) -> Result<f64, String> {
    let mut take = load(dir)?;
    let t = take.tracks.iter().find(|t| t.id == reference_id).or(take.tracks.first()).ok_or("No tracks")?.clone();
    let p = if t.processed { dir.join("processed").join(&t.file) } else { dir.join("raw").join(&t.file) };
    let a = wav::read(&p).map_err(|e| e.to_string())?;
    let mono = a.to_mono();
    let ranges = dsp::silence_ranges(&mono, a.rate, threshold_db, min_ms, keep_ms);
    let cuts: Vec<(f64, f64)> = ranges.iter().map(|&(s, e)| (s as f64 / a.rate as f64, e as f64 / a.rate as f64)).collect();
    let removed: f64 = cuts.iter().map(|(s, e)| e - s).sum();
    if dry_run || cuts.is_empty() {
        return Ok(removed);
    }
    drop(a);
    snapshot(dir, &take)?;
    apply_cuts(dir, &mut take, &cuts)?;
    Ok(removed)
}

// ---- Preview mixes & waveforms -------------------------------------------------------
fn mix(dir: &Path, take: &Take, which: &str) -> Result<Option<Audio>, String> {
    let mut out: Option<Vec<Vec<f32>>> = None;
    for t in &take.tracks {
        let p = dir.join(which).join(&t.file);
        if !p.exists() {
            continue;
        }
        let a = wav::read(&p).map_err(|e| e.to_string())?;
        let chans: Vec<Vec<f32>> = a.channels.iter().map(|c| dsp::resample(c, a.rate, chain::OUT_RATE)).collect();
        let (l, r) = if chans.len() >= 2 { (chans[0].clone(), chans[1].clone()) } else { (chans[0].clone(), chans[0].clone()) };
        let acc = out.get_or_insert_with(|| vec![Vec::new(), Vec::new()]);
        for (dst, src) in acc.iter_mut().zip([l, r]) {
            if dst.len() < src.len() {
                dst.resize(src.len(), 0.0);
            }
            for (d, s) in dst.iter_mut().zip(src.iter()) {
                *d += *s;
            }
        }
    }
    Ok(out.map(|mut channels| {
        if dsp::peak_db(&channels) > -0.3 {
            dsp::limit(&mut channels, chain::OUT_RATE, -0.3);
        }
        Audio { rate: chain::OUT_RATE, channels }
    }))
}

pub fn preview_path(dir: &Path, which: &str) -> PathBuf {
    dir.join(format!(".preview-{which}.wav"))
}

pub fn render_preview(dir: &Path, which: &str) -> Result<Option<PathBuf>, String> {
    let take = load(dir)?;
    match mix(dir, &take, which)? {
        Some(a) => {
            let p = preview_path(dir, which);
            wav::write(&p, &a, SampleFormat::Int16).map_err(|e| e.to_string())?;
            Ok(Some(p))
        }
        None => Ok(None),
    }
}

fn refresh_previews(dir: &Path) {
    let _ = render_preview(dir, "raw");
    if load(dir).map(|t| t.tracks.iter().any(|x| x.processed)).unwrap_or(false) {
        let _ = render_preview(dir, "processed");
    }
}

#[derive(Serialize)]
pub struct TrackPeaks {
    pub id: String,
    pub label: String,
    pub seconds: f64,
    pub peaks: Vec<(f32, f32)>,
}

pub fn peaks(dir: &Path, which: &str, buckets: usize) -> Result<Vec<TrackPeaks>, String> {
    let take = load(dir)?;
    let mut out = Vec::new();
    for t in &take.tracks {
        let mut p = dir.join(which).join(&t.file);
        if !p.exists() {
            p = dir.join("raw").join(&t.file);
        }
        let a = wav::read(&p).map_err(|e| e.to_string())?;
        out.push(TrackPeaks { id: t.id.clone(), label: t.label.clone(), seconds: a.duration_secs(), peaks: dsp::peaks(&a.to_mono(), buckets) });
    }
    Ok(out)
}

// ---- Export --------------------------------------------------------------------------
#[derive(Deserialize)]
pub struct ExportOptions {
    pub folder: String,
    pub which: String,  // "processed" | "raw"
    pub format: String, // "wav16" | "wav24" | "wav32f" | "flac"
    pub tracks: bool,
    pub mix: bool,
}

fn write_any(path_no_ext: &Path, a: &Audio, format: &str) -> Result<PathBuf, String> {
    match format {
        "flac" => {
            let p = path_no_ext.with_extension("flac");
            super::export::write_flac(&p, a)?;
            Ok(p)
        }
        f => {
            let p = path_no_ext.with_extension("wav");
            let fmt = match f { "wav16" => SampleFormat::Int16, "wav32f" => SampleFormat::Float32, _ => SampleFormat::Int24 };
            wav::write(&p, a, fmt).map_err(|e| e.to_string())?;
            Ok(p)
        }
    }
}

pub fn export(dir: &Path, o: &ExportOptions) -> Result<Vec<String>, String> {
    let take = load(dir)?;
    let folder = PathBuf::from(&o.folder);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let base = safe_name(&take.name);
    let mut files = Vec::new();
    if o.tracks {
        for t in &take.tracks {
            let mut p = dir.join(&o.which).join(&t.file);
            if !p.exists() {
                p = dir.join("raw").join(&t.file);
            }
            let a = wav::read(&p).map_err(|e| e.to_string())?;
            let out = write_any(&folder.join(format!("{base} - {}", safe_name(&t.label))), &a, &o.format)?;
            files.push(out.to_string_lossy().to_string());
        }
    }
    if o.mix {
        if let Some(a) = mix(dir, &take, &o.which)? {
            let out = write_any(&folder.join(format!("{base} - mix")), &a, &o.format)?;
            files.push(out.to_string_lossy().to_string());
        }
    }
    Ok(files)
}
