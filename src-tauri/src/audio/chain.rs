//! The voice processing chain. Every stage is optional.
//! Order: mono → 48 kHz → noise removal → high-pass → gate → EQ → de-esser → compressor → loudness + limiter.

use super::dsp::{self, Biquad, CompParams, DeessParams, FilterKind, GateParams};
use super::wav::Audio;

pub const OUT_RATE: u32 = 48_000;

/// Something that removes background noise from 48 kHz mono audio (RNNoise in the app).
pub trait Denoiser {
    fn process_48k_mono(&mut self, input: &[f32]) -> Vec<f32>;
}

pub struct EqParams {
    pub low_shelf_db: f32, // warmth/body (~120 Hz)
    pub mud_db: f32,       // boxiness (~300 Hz), usually a cut
    pub presence_db: f32,  // clarity (~3.5 kHz)
    pub air_db: f32,       // sparkle (~12 kHz shelf)
}

pub struct LoudnessParams {
    pub target_lufs: f32,
    pub ceiling_db: f32,
}

#[derive(Default)]
pub struct Chain {
    pub mono: bool,
    /// 0..=1 mix of denoised signal.
    pub denoise: Option<f32>,
    pub highpass_hz: Option<f32>,
    pub gate: Option<GateParams>,
    pub eq: Option<EqParams>,
    pub deess: Option<DeessParams>,
    pub compressor: Option<CompParams>,
    pub loudness: Option<LoudnessParams>,
}

pub struct Report {
    pub input_lufs: f32,
    pub output_lufs: f32,
    pub output_peak_db: f32,
}

pub fn process(
    input: &Audio,
    chain: &Chain,
    make_denoiser: &mut dyn FnMut() -> Box<dyn Denoiser>,
    progress: &mut dyn FnMut(f32),
) -> (Audio, Report) {
    progress(0.0);
    let input_lufs = dsp::integrated_lufs(&input.channels, input.rate);

    // 1. Channel layout.
    let mut chans: Vec<Vec<f32>> = if chain.mono && input.channels.len() > 1 { vec![input.to_mono()] } else { input.channels.clone() };

    // 2. Everything below runs at 48 kHz (what RNNoise expects and what YouTube uses).
    if input.rate != OUT_RATE {
        chans = chans.iter().map(|c| dsp::resample(c, input.rate, OUT_RATE)).collect();
    }
    let rate = OUT_RATE;
    progress(0.15);

    // 3. AI noise removal.
    if let Some(amount) = chain.denoise {
        let amount = amount.clamp(0.0, 1.0);
        for ch in chans.iter_mut() {
            let mut d = make_denoiser();
            let clean = d.process_48k_mono(ch);
            for (x, y) in ch.iter_mut().zip(clean.iter()) {
                *x = *y * amount + *x * (1.0 - amount);
            }
        }
    }
    progress(0.45);

    // 4. High-pass (rumble, desk bumps, AC hum harmonics) — 24 dB/octave.
    if let Some(hz) = chain.highpass_hz {
        for ch in chans.iter_mut() {
            Biquad::new(FilterKind::HighPass, hz as f64, 0.541, rate as f64).run(ch);
            Biquad::new(FilterKind::HighPass, hz as f64, 1.307, rate as f64).run(ch);
        }
    }

    // 5. Noise gate (keyed from the mono sum).
    if let Some(g) = &chain.gate {
        let key = Audio { rate, channels: chans.clone() }.to_mono();
        dsp::gate(&mut chans, &key, rate, g);
    }
    progress(0.55);

    // 6. EQ.
    if let Some(eq) = &chain.eq {
        for ch in chans.iter_mut() {
            let r = rate as f64;
            if eq.low_shelf_db.abs() > 0.05 { Biquad::new(FilterKind::LowShelf(eq.low_shelf_db as f64), 120.0, 0.707, r).run(ch); }
            if eq.mud_db.abs() > 0.05 { Biquad::new(FilterKind::Peak(eq.mud_db as f64), 300.0, 1.0, r).run(ch); }
            if eq.presence_db.abs() > 0.05 { Biquad::new(FilterKind::Peak(eq.presence_db as f64), 3500.0, 0.9, r).run(ch); }
            if eq.air_db.abs() > 0.05 { Biquad::new(FilterKind::HighShelf(eq.air_db as f64), 12000.0, 0.707, r).run(ch); }
        }
    }
    progress(0.65);

    // 7. De-esser.
    if let Some(d) = &chain.deess {
        dsp::deess(&mut chans, rate, d);
    }
    progress(0.75);

    // 8. Compressor.
    if let Some(c) = &chain.compressor {
        dsp::compress(&mut chans, rate, c);
    }
    progress(0.85);

    // 9. Loudness normalisation + true-peak-safe limiter.
    match &chain.loudness {
        Some(l) => {
            for _ in 0..2 {
                let now = dsp::integrated_lufs(&chans, rate);
                if now <= -69.0 { break; }
                let gain_db = (l.target_lufs - now).clamp(-30.0, 30.0);
                if gain_db.abs() < 0.2 { break; }
                let g = dsp::db_to_lin(gain_db);
                for ch in chans.iter_mut() {
                    for s in ch.iter_mut() { *s *= g; }
                }
                dsp::limit(&mut chans, rate, l.ceiling_db);
            }
        }
        None => {
            // Still never clip.
            if dsp::peak_db(&chans) > -0.3 {
                dsp::limit(&mut chans, rate, -0.3);
            }
        }
    }
    progress(1.0);

    let out = Audio { rate, channels: chans };
    let report = Report {
        input_lufs,
        output_lufs: dsp::integrated_lufs(&out.channels, rate),
        output_peak_db: dsp::peak_db(&out.channels),
    };
    (out, report)
}
