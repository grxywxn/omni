//! Live capture from microphones and "system audio" (WASAPI loopback) using cpal.
//! Each track runs on its own thread: the audio callback hands buffers to a writer
//! loop that applies gain, measures levels and streams to a 32-bit float WAV.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use serde::{Deserialize, Serialize};

use super::wav::StreamWriter;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Input,
    Loopback,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TrackSpec {
    pub id: String,
    pub label: String,
    /// Device name; empty = system default.
    pub device: String,
    pub kind: Kind,
    pub mono: bool,
    pub gain_db: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub is_default: bool,
    pub channels: u16,
    pub rate: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Devices {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

pub fn list_devices() -> Result<Devices, String> {
    let host = cpal::default_host();
    let def_in = host.default_input_device().and_then(|d| d.name().ok()).unwrap_or_default();
    let def_out = host.default_output_device().and_then(|d| d.name().ok()).unwrap_or_default();
    let mut inputs = Vec::new();
    for d in host.input_devices().map_err(|e| e.to_string())? {
        if let (Ok(name), Ok(cfg)) = (d.name(), d.default_input_config()) {
            inputs.push(DeviceInfo { is_default: name == def_in, name, channels: cfg.channels(), rate: cfg.sample_rate().0 });
        }
    }
    let mut outputs = Vec::new();
    for d in host.output_devices().map_err(|e| e.to_string())? {
        if let (Ok(name), Ok(cfg)) = (d.name(), d.default_output_config()) {
            outputs.push(DeviceInfo { is_default: name == def_out, name, channels: cfg.channels(), rate: cfg.sample_rate().0 });
        }
    }
    Ok(Devices { inputs, outputs })
}

/// Live state shared between a track's writer thread and the UI.
pub struct Shared {
    peak_bits: AtomicU32,
    clipped: AtomicBool,
    frames: AtomicU64,
    bytes: AtomicU64,
    error: Mutex<Option<String>>,
}

impl Shared {
    fn new() -> Self {
        Shared { peak_bits: AtomicU32::new(0), clipped: AtomicBool::new(false), frames: AtomicU64::new(0), bytes: AtomicU64::new(0), error: Mutex::new(None) }
    }
    fn bump_peak(&self, p: f32) {
        let cur = f32::from_bits(self.peak_bits.load(Ordering::Relaxed));
        if p > cur {
            self.peak_bits.store(p.to_bits(), Ordering::Relaxed);
        }
    }
    /// Peak since the last call (resets it).
    pub fn take_peak(&self) -> f32 {
        f32::from_bits(self.peak_bits.swap(0, Ordering::Relaxed))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrackResult {
    pub id: String,
    pub label: String,
    pub file: String,
    pub rate: u32,
    pub channels: u16,
    pub seconds: f64,
}

pub struct TrackHandle {
    pub spec: TrackSpec,
    pub shared: Arc<Shared>,
    pub rate: u32,
    thread: JoinHandle<Result<Option<TrackResult>, String>>,
}

pub struct Session {
    pub tracks: Vec<TrackHandle>,
    pub writing: bool,
    pub dir: Option<PathBuf>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    started: Instant,
    paused_total: Duration,
    paused_at: Option<Instant>,
}

impl Session {
    pub fn elapsed(&self) -> f64 {
        let now = self.paused_at.unwrap_or_else(Instant::now);
        (now - self.started).saturating_sub(self.paused_total).as_secs_f64()
    }
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    pub fn set_paused(&mut self, p: bool) {
        if p && self.paused_at.is_none() {
            self.paused_at = Some(Instant::now());
        } else if !p {
            if let Some(t) = self.paused_at.take() {
                self.paused_total += t.elapsed();
            }
        }
        self.paused.store(p, Ordering::SeqCst);
    }
    /// Stop all tracks and return what was recorded.
    pub fn stop(self) -> (Vec<TrackResult>, Vec<String>) {
        self.stop.store(true, Ordering::SeqCst);
        let mut out = Vec::new();
        let mut errors = Vec::new();
        for t in self.tracks {
            match t.thread.join() {
                Ok(Ok(Some(r))) => out.push(r),
                Ok(Ok(None)) => {}
                Ok(Err(e)) => errors.push(format!("{}: {e}", t.spec.label)),
                Err(_) => errors.push(format!("{}: recording thread crashed", t.spec.label)),
            }
        }
        (out, errors)
    }
}

pub fn safe_name(s: &str) -> String {
    let cleaned: String = s.chars().map(|c| if c.is_alphanumeric() || " -_().".contains(c) { c } else { '_' }).collect();
    let t = cleaned.trim().trim_matches('.').to_string();
    if t.is_empty() { "track".into() } else { t.chars().take(60).collect() }
}

fn find_device(spec: &TrackSpec) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let found = match spec.kind {
        Kind::Input => {
            if spec.device.is_empty() {
                host.default_input_device()
            } else {
                host.input_devices().map_err(|e| e.to_string())?.find(|d| d.name().map(|n| n == spec.device).unwrap_or(false))
            }
        }
        Kind::Loopback => {
            if spec.device.is_empty() {
                host.default_output_device()
            } else {
                host.output_devices().map_err(|e| e.to_string())?.find(|d| d.name().map(|n| n == spec.device).unwrap_or(false))
            }
        }
    };
    found.ok_or_else(|| format!("Device “{}” not found — was it unplugged?", if spec.device.is_empty() { "default" } else { &spec.device }))
}

fn build_stream<T>(device: &cpal::Device, config: &cpal::StreamConfig, tx: Sender<Vec<f32>>, shared: Arc<Shared>) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let v: Vec<f32> = data.iter().map(|&s| f32::from_sample(s)).collect();
                let _ = tx.send(v);
            },
            move |e| {
                if let Ok(mut slot) = shared.error.lock() {
                    *slot = Some(e.to_string());
                }
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// Start capturing. `dir = None` means "levels only" (sound check, nothing written).
pub fn start(specs: Vec<TrackSpec>, dir: Option<PathBuf>) -> Result<Session, String> {
    if specs.is_empty() {
        return Err("Add at least one track.".into());
    }
    if let Some(d) = &dir {
        std::fs::create_dir_all(d.join("raw")).map_err(|e| format!("Can't create the take folder: {e}"))?;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let mut tracks = Vec::new();
    let mut used_names = std::collections::HashSet::new();

    for spec in specs {
        let shared = Arc::new(Shared::new());
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u16), String>>();
        let mut name = safe_name(&spec.label);
        while !used_names.insert(name.to_lowercase()) {
            name.push('_');
        }
        let file = dir.as_ref().map(|d| d.join("raw").join(format!("{name}.wav")));
        let (stop_t, paused_t, shared_t, spec_t) = (stop.clone(), paused.clone(), shared.clone(), spec.clone());

        let thread = std::thread::Builder::new()
            .name(format!("rec-{}", spec.id))
            .spawn(move || run_track(spec_t, file, shared_t, stop_t, paused_t, ready_tx))
            .map_err(|e| e.to_string())?;

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok((rate, _ch))) => tracks.push(TrackHandle { spec, shared, rate, thread }),
            Ok(Err(e)) => {
                stop.store(true, Ordering::SeqCst);
                let _ = thread.join();
                for t in tracks {
                    let _ = t.thread.join();
                }
                return Err(format!("{}: {e}", spec.label));
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                return Err(format!("{}: the device didn't respond", spec.label));
            }
        }
    }
    Ok(Session { tracks, writing: dir.is_some(), dir, stop, paused, started, paused_total: Duration::ZERO, paused_at: None })
}

fn run_track(
    spec: TrackSpec,
    file: Option<PathBuf>,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    ready: Sender<Result<(u32, u16), String>>,
) -> Result<Option<TrackResult>, String> {
    // ---- Open the device ----
    let setup = (|| -> Result<(cpal::Stream, Receiver<Vec<f32>>, u32, u16), String> {
        let device = find_device(&spec)?;
        let supported = match spec.kind {
            Kind::Input => device.default_input_config(),
            Kind::Loopback => device.default_output_config(),
        }
        .map_err(|e| e.to_string())?;
        let config: cpal::StreamConfig = supported.config();
        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, tx, shared.clone())?,
            cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, tx, shared.clone())?,
            cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, tx, shared.clone())?,
            cpal::SampleFormat::I32 => build_stream::<i32>(&device, &config, tx, shared.clone())?,
            other => return Err(format!("unsupported sample format {other:?}")),
        };
        stream.play().map_err(|e| e.to_string())?;
        Ok((stream, rx, config.sample_rate.0, config.channels))
    })();

    let (stream, rx, rate, in_ch) = match setup {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    let out_ch: u16 = if spec.mono { 1 } else { in_ch };
    let mut writer = match &file {
        Some(p) => match StreamWriter::create(p, out_ch, rate) {
            Ok(w) => Some(w),
            Err(e) => {
                let _ = ready.send(Err(e.to_string()));
                return Err(e.to_string());
            }
        },
        None => None,
    };
    let _ = ready.send(Ok((rate, out_ch)));

    // ---- Writer loop ----
    let gain = 10f32.powf(spec.gain_db / 20.0);
    let in_ch_us = in_ch as usize;
    let mut frames_written: u64 = 0;
    let mut active = Duration::ZERO;
    let mut last_tick = Instant::now();
    let mut last_data = Instant::now();
    let mut buf: Vec<f32> = Vec::new();

    loop {
        let now = Instant::now();
        let is_paused = paused.load(Ordering::SeqCst);
        if !is_paused {
            active += now - last_tick;
        }
        last_tick = now;

        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(data) => {
                last_data = Instant::now();
                if is_paused {
                    continue;
                }
                let frames = data.len() / in_ch_us.max(1);
                buf.clear();
                let mut peak = 0.0f32;
                for f in 0..frames {
                    let frame = &data[f * in_ch_us..(f + 1) * in_ch_us];
                    if spec.mono {
                        let v = frame.iter().sum::<f32>() / in_ch_us as f32 * gain;
                        peak = peak.max(v.abs());
                        buf.push(v);
                    } else {
                        for &s in frame {
                            let v = s * gain;
                            peak = peak.max(v.abs());
                            buf.push(v);
                        }
                    }
                }
                shared.bump_peak(peak);
                if peak >= 0.999 {
                    shared.clipped.store(true, Ordering::Relaxed);
                }
                if let Some(w) = writer.as_mut() {
                    if let Err(e) = w.write_interleaved(&buf) {
                        *shared.error.lock().unwrap() = Some(format!("Disk write failed: {e}"));
                    }
                    frames_written += frames as u64;
                    shared.frames.store(frames_written, Ordering::Relaxed);
                    shared.bytes.store(w.bytes_written(), Ordering::Relaxed);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                // System audio produces no data while nothing is playing: fill the gap with
                // silence so this track stays in sync with the microphones.
                if spec.kind == Kind::Loopback && !is_paused && last_data.elapsed() > Duration::from_millis(100) {
                    if let Some(w) = writer.as_mut() {
                        let expected = (active.as_secs_f64() * rate as f64) as u64;
                        if expected > frames_written + (rate as u64 / 20) {
                            let missing = (expected - frames_written) as usize;
                            let zeros = vec![0.0f32; missing * out_ch as usize];
                            let _ = w.write_interleaved(&zeros);
                            frames_written += missing as u64;
                            shared.frames.store(frames_written, Ordering::Relaxed);
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }
    }

    drop(stream);
    // Drain anything still queued.
    while let Ok(data) = rx.try_recv() {
        if paused.load(Ordering::SeqCst) {
            continue;
        }
        if let Some(w) = writer.as_mut() {
            let frames = data.len() / in_ch_us.max(1);
            let mut b = Vec::with_capacity(frames * out_ch as usize);
            for f in 0..frames {
                let frame = &data[f * in_ch_us..(f + 1) * in_ch_us];
                if spec.mono {
                    b.push(frame.iter().sum::<f32>() / in_ch_us as f32 * gain);
                } else {
                    b.extend(frame.iter().map(|s| s * gain));
                }
            }
            let _ = w.write_interleaved(&b);
            frames_written += frames as u64;
        }
    }

    match (writer, file) {
        (Some(w), Some(p)) => {
            w.finish().map_err(|e| e.to_string())?;
            Ok(Some(TrackResult {
                id: spec.id,
                label: spec.label,
                file: p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
                rate,
                channels: out_ch,
                seconds: frames_written as f64 / rate as f64,
            }))
        }
        _ => Ok(None),
    }
}

/// Snapshot for the UI meters.
#[derive(Serialize)]
pub struct Level {
    pub id: String,
    pub peak: f32,
    pub clipped: bool,
    pub error: Option<String>,
}

pub fn levels(s: &Session) -> Vec<Level> {
    s.tracks
        .iter()
        .map(|t| Level {
            id: t.spec.id.clone(),
            peak: t.shared.take_peak(),
            clipped: t.shared.clipped.swap(false, Ordering::Relaxed),
            error: t.shared.error.lock().ok().and_then(|e| e.clone()),
        })
        .collect()
}

pub fn bytes_written(s: &Session) -> u64 {
    s.tracks.iter().map(|t| t.shared.bytes.load(Ordering::Relaxed)).sum()
}
