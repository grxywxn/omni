//! AI noise removal using RNNoise (pure-Rust port `nnnoiseless`).

use nnnoiseless::DenoiseState;

use super::chain::Denoiser;

const FRAME: usize = 480; // 10 ms at 48 kHz

pub struct Rnnoise {
    state: Box<DenoiseState<'static>>,
}

impl Rnnoise {
    pub fn new() -> Self {
        Rnnoise { state: DenoiseState::new() }
    }
}

impl Denoiser for Rnnoise {
    fn process_48k_mono(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(input.len() + 2 * FRAME);
        let mut inbuf = [0.0f32; FRAME];
        let mut outbuf = [0.0f32; FRAME];
        // RNNoise works on 16-bit-scaled samples and has one frame of latency.
        let total_frames = input.len() / FRAME + 2;
        for f in 0..total_frames {
            for k in 0..FRAME {
                let idx = f * FRAME + k;
                inbuf[k] = if idx < input.len() { input[idx] * 32768.0 } else { 0.0 };
            }
            self.state.process_frame(&mut outbuf, &inbuf);
            out.extend(outbuf.iter().map(|s| s / 32768.0));
        }
        // Compensate the one-frame delay and the start-up fade.
        let mut aligned: Vec<f32> = out.into_iter().skip(FRAME).take(input.len()).collect();
        aligned.resize(input.len(), 0.0);
        aligned
    }
}
