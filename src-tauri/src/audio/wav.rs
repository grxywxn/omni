//! Minimal, dependency-free WAV reading and writing.
//! Audio is handled as planar f32 (one Vec per channel), range -1.0..=1.0.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

#[derive(Clone, Debug)]
pub struct Audio {
    pub rate: u32,
    pub channels: Vec<Vec<f32>>,
}

impl Audio {
    pub fn new(rate: u32, channels: usize) -> Self {
        Audio { rate, channels: vec![Vec::new(); channels.max(1)] }
    }
    pub fn frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }
    pub fn duration_secs(&self) -> f64 {
        self.frames() as f64 / self.rate.max(1) as f64
    }
    /// Average all channels into one.
    pub fn to_mono(&self) -> Vec<f32> {
        let n = self.frames();
        let ch = self.channels.len().max(1) as f32;
        (0..n).map(|i| self.channels.iter().map(|c| c[i]).sum::<f32>() / ch).collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SampleFormat {
    Int16,
    Int24,
    Float32,
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

/// Read a PCM (16/24/32-bit int) or IEEE float (32-bit) WAV file.
pub fn read(path: &Path) -> io::Result<Audio> {
    let mut f = BufReader::new(File::open(path)?);
    let mut hdr = [0u8; 12];
    f.read_exact(&mut hdr)?;
    if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" {
        return Err(bad("not a WAV file"));
    }
    let (mut fmt_tag, mut channels, mut rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    let mut data: Option<Vec<u8>> = None;
    loop {
        let mut ch = [0u8; 8];
        if f.read_exact(&mut ch).is_err() {
            break;
        }
        let id = [ch[0], ch[1], ch[2], ch[3]];
        let size = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]) as u64;
        match &id {
            b"fmt " => {
                let mut b = vec![0u8; size as usize];
                f.read_exact(&mut b)?;
                fmt_tag = u16::from_le_bytes([b[0], b[1]]);
                channels = u16::from_le_bytes([b[2], b[3]]);
                rate = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
                bits = u16::from_le_bytes([b[14], b[15]]);
                if fmt_tag == 0xFFFE && b.len() >= 26 {
                    fmt_tag = u16::from_le_bytes([b[24], b[25]]); // WAVE_FORMAT_EXTENSIBLE subformat
                }
            }
            b"data" => {
                // A recording that was cut off may have a 0 / wrong size — read to EOF instead.
                let mut b = Vec::new();
                if size == 0 || size == 0xFFFF_FFFF {
                    f.read_to_end(&mut b)?;
                } else {
                    let mut lim = (&mut f).take(size);
                    lim.read_to_end(&mut b)?;
                }
                data = Some(b);
                break;
            }
            _ => {
                f.seek(SeekFrom::Current(size as i64 + (size & 1) as i64))?;
            }
        }
    }
    let data = data.ok_or_else(|| bad("WAV has no data"))?;
    if channels == 0 || rate == 0 {
        return Err(bad("WAV has no format information"));
    }
    let nch = channels as usize;
    let bps = (bits / 8) as usize;
    if bps == 0 {
        return Err(bad("unsupported bit depth"));
    }
    let frames = data.len() / (bps * nch);
    let mut audio = Audio::new(rate, nch);
    for c in audio.channels.iter_mut() {
        c.reserve(frames);
    }
    for i in 0..frames {
        for c in 0..nch {
            let o = (i * nch + c) * bps;
            let s = &data[o..o + bps];
            let v = match (fmt_tag, bits) {
                (3, 32) => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
                (1, 16) => i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0,
                (1, 24) => (((s[2] as i32) << 24 | (s[1] as i32) << 16 | (s[0] as i32) << 8) >> 8) as f32 / 8_388_608.0,
                (1, 32) => i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32 / 2_147_483_648.0,
                (1, 8) => (s[0] as f32 - 128.0) / 128.0,
                _ => return Err(bad("unsupported WAV format")),
            };
            audio.channels[c].push(v);
        }
    }
    Ok(audio)
}

fn header(channels: u16, rate: u32, fmt: SampleFormat, data_len: u32) -> Vec<u8> {
    let (tag, bits): (u16, u16) = match fmt {
        SampleFormat::Int16 => (1, 16),
        SampleFormat::Int24 => (1, 24),
        SampleFormat::Float32 => (3, 32),
    };
    let block = channels * bits / 8;
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_len).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&tag.to_le_bytes());
    h.extend_from_slice(&channels.to_le_bytes());
    h.extend_from_slice(&rate.to_le_bytes());
    h.extend_from_slice(&(rate * block as u32).to_le_bytes());
    h.extend_from_slice(&block.to_le_bytes());
    h.extend_from_slice(&bits.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_len.to_le_bytes());
    h
}

fn encode_sample(out: &mut Vec<u8>, v: f32, fmt: SampleFormat) {
    let v = if v.is_finite() { v } else { 0.0 };
    match fmt {
        SampleFormat::Float32 => out.extend_from_slice(&v.to_le_bytes()),
        SampleFormat::Int16 => out.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes()),
        SampleFormat::Int24 => {
            let i = (v.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
            out.extend_from_slice(&i.to_le_bytes()[0..3]);
        }
    }
}

/// Write a whole file at once.
pub fn write(path: &Path, audio: &Audio, fmt: SampleFormat) -> io::Result<()> {
    let nch = audio.channels.len();
    let bytes = match fmt {
        SampleFormat::Int16 => 2,
        SampleFormat::Int24 => 3,
        SampleFormat::Float32 => 4,
    };
    let frames = audio.frames();
    let data_len = (frames * nch * bytes) as u32;
    let mut w = BufWriter::new(File::create(path)?);
    w.write_all(&header(nch as u16, audio.rate, fmt, data_len))?;
    let mut buf = Vec::with_capacity(8192 * nch * bytes);
    for i in 0..frames {
        for c in &audio.channels {
            encode_sample(&mut buf, c[i], fmt);
        }
        if buf.len() >= 8192 * nch * bytes {
            w.write_all(&buf)?;
            buf.clear();
        }
    }
    w.write_all(&buf)?;
    w.flush()
}

/// Streaming writer used while recording (32-bit float, header fixed up on finish).
pub struct StreamWriter {
    w: BufWriter<File>,
    channels: u16,
    rate: u32,
    data_len: u64,
    scratch: Vec<u8>,
}

impl StreamWriter {
    pub fn create(path: &Path, channels: u16, rate: u32) -> io::Result<Self> {
        let mut w = BufWriter::with_capacity(1 << 16, File::create(path)?);
        w.write_all(&header(channels, rate, SampleFormat::Float32, 0))?;
        Ok(StreamWriter { w, channels, rate, data_len: 0, scratch: Vec::new() })
    }

    /// Interleaved samples.
    pub fn write_interleaved(&mut self, samples: &[f32]) -> io::Result<()> {
        self.scratch.clear();
        for &s in samples {
            encode_sample(&mut self.scratch, s, SampleFormat::Float32);
        }
        self.data_len += self.scratch.len() as u64;
        self.w.write_all(&self.scratch)
    }

    pub fn bytes_written(&self) -> u64 {
        self.data_len + 44
    }

    pub fn finish(mut self) -> io::Result<()> {
        self.w.flush()?;
        let mut f = self.w.into_inner().map_err(|e| e.into_error())?;
        let len = self.data_len.min(u32::MAX as u64 - 36) as u32;
        f.seek(SeekFrom::Start(0))?;
        f.write_all(&header(self.channels, self.rate, SampleFormat::Float32, len))?;
        f.flush()
    }
}
