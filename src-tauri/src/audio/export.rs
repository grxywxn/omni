//! FLAC export (24-bit, lossless) using the pure-Rust `flacenc` encoder.

use std::path::Path;

use flacenc::component::BitRepr;
use flacenc::error::Verify;

use super::wav::Audio;

pub fn write_flac(path: &Path, a: &Audio) -> Result<(), String> {
    let channels = a.channels.len();
    let frames = a.frames();
    let mut interleaved: Vec<i32> = Vec::with_capacity(frames * channels);
    for i in 0..frames {
        for c in &a.channels {
            let v = if c[i].is_finite() { c[i] } else { 0.0 };
            interleaved.push((v.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32);
        }
    }
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, e)| format!("FLAC config error: {e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(&interleaved, channels, 24, a.rate as usize);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| format!("FLAC encode error: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).map_err(|e| format!("FLAC write error: {e:?}"))?;
    std::fs::write(path, sink.as_slice()).map_err(|e| e.to_string())
}
