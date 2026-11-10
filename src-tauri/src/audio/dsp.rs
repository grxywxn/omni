//! Dependency-free audio processing building blocks.

use std::f64::consts::PI;

#[inline]
pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}
#[inline]
pub fn lin_to_db(x: f32) -> f32 {
    20.0 * x.max(1e-9).log10()
}
#[inline]
fn coef(ms: f32, rate: f32) -> f32 {
    // One-pole smoothing coefficient for a time constant in milliseconds.
    if ms <= 0.0 { 0.0 } else { (-1.0 / (ms * 0.001 * rate)).exp() }
}

// ---- Biquad filters (RBJ Audio EQ Cookbook) ------------------------------------
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f64, b1: f64, b2: f64, a1: f64, a2: f64,
    z1: f64, z2: f64,
}

pub enum FilterKind {
    HighPass,
    LowPass,
    BandPass,
    Peak(f64),      // gain dB
    LowShelf(f64),  // gain dB
    HighShelf(f64), // gain dB
}

impl Biquad {
    pub fn new(kind: FilterKind, freq: f64, q: f64, rate: f64) -> Self {
        let freq = freq.clamp(10.0, rate * 0.45);
        let w0 = 2.0 * PI * freq / rate;
        let (cw, sw) = (w0.cos(), w0.sin());
        let alpha = sw / (2.0 * q);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterKind::HighPass => ((1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0, 1.0 + alpha, -2.0 * cw, 1.0 - alpha),
            FilterKind::LowPass => ((1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0, 1.0 + alpha, -2.0 * cw, 1.0 - alpha),
            FilterKind::BandPass => (alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cw, 1.0 - alpha),
            FilterKind::Peak(g) => {
                let a = 10f64.powf(g / 40.0);
                (1.0 + alpha * a, -2.0 * cw, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cw, 1.0 - alpha / a)
            }
            FilterKind::LowShelf(g) => {
                let a = 10f64.powf(g / 40.0);
                let s = 2.0 * a.sqrt() * alpha;
                (a * ((a + 1.0) - (a - 1.0) * cw + s), 2.0 * a * ((a - 1.0) - (a + 1.0) * cw), a * ((a + 1.0) - (a - 1.0) * cw - s),
                 (a + 1.0) + (a - 1.0) * cw + s, -2.0 * ((a - 1.0) + (a + 1.0) * cw), (a + 1.0) + (a - 1.0) * cw - s)
            }
            FilterKind::HighShelf(g) => {
                let a = 10f64.powf(g / 40.0);
                let s = 2.0 * a.sqrt() * alpha;
                (a * ((a + 1.0) + (a - 1.0) * cw + s), -2.0 * a * ((a - 1.0) + (a + 1.0) * cw), a * ((a + 1.0) + (a - 1.0) * cw - s),
                 (a + 1.0) - (a - 1.0) * cw + s, 2.0 * ((a - 1.0) - (a + 1.0) * cw), (a + 1.0) - (a - 1.0) * cw - s)
            }
        };
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0.0, z2: 0.0 }
    }

    /// Take another filter's coefficients but keep this filter's state (no clicks).
    pub fn retune(&mut self, other: &Biquad) {
        self.b0 = other.b0; self.b1 = other.b1; self.b2 = other.b2; self.a1 = other.a1; self.a2 = other.a2;
    }

    pub fn from_coeffs(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Self {
        Biquad { b0, b1, b2, a1, a2, z1: 0.0, z2: 0.0 }
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        // Transposed direct form II.
        let x = x as f64;
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y as f32
    }

    pub fn run(&mut self, buf: &mut [f32]) {
        for s in buf.iter_mut() {
            *s = self.tick(*s);
        }
    }
}

// ---- Resampling (windowed sinc) --------------------------------------------------
fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 { 1.0 } else { (PI * x).sin() / (PI * x) }
}

/// High-quality resample of one channel. 32-tap Blackman-windowed sinc.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    const HALF: i64 = 16;
    let ratio = to as f64 / from as f64;
    let cutoff = ratio.min(1.0) * 0.97;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    let n = input.len() as i64;
    for i in 0..out_len {
        let t = i as f64 / ratio;
        let center = t.floor() as i64;
        let mut acc = 0.0f64;
        let mut wsum = 0.0f64;
        for k in (center - HALF + 1)..=(center + HALF) {
            let d = t - k as f64;
            let win_pos = (d / HALF as f64).clamp(-1.0, 1.0);
            let w = 0.42 + 0.5 * (PI * win_pos).cos() + 0.08 * (2.0 * PI * win_pos).cos();
            let c = cutoff * sinc(cutoff * d) * w;
            wsum += c;
            if k >= 0 && k < n {
                acc += input[k as usize] as f64 * c;
            }
        }
        out.push(if wsum.abs() > 1e-9 { (acc / wsum) as f32 } else { 0.0 });
    }
    out
}

// ---- Noise gate ------------------------------------------------------------------
pub struct GateParams {
    pub threshold_db: f32,
    pub range_db: f32, // how much to turn down when closed (e.g. 30 dB); not fully muted = more natural
    pub attack_ms: f32,
    pub hold_ms: f32,
    pub release_ms: f32,
}

/// Gate driven by the level of `key` (normally the signal itself), applied to all channels.
pub fn gate(channels: &mut [Vec<f32>], key: &[f32], rate: u32, p: &GateParams) {
    let r = rate as f32;
    let env_c = coef(5.0, r);
    let att = coef(p.attack_ms.max(0.1), r);
    let rel = coef(p.release_ms.max(1.0), r);
    let hold = (p.hold_ms * 0.001 * r) as usize;
    let open_thr = db_to_lin(p.threshold_db);
    let close_thr = db_to_lin(p.threshold_db - 4.0); // hysteresis avoids chatter
    let floor = db_to_lin(-p.range_db.abs());
    let (mut env, mut gain, mut held, mut open) = (0.0f32, floor, 0usize, false);
    for i in 0..key.len() {
        let a = key[i].abs();
        env = a.max(env * env_c + a * (1.0 - env_c));
        if env > open_thr {
            open = true;
            held = hold;
        } else if env < close_thr {
            if held > 0 { held -= 1; } else { open = false; }
        }
        let target = if open { 1.0 } else { floor };
        let c = if target > gain { att } else { rel };
        gain = target + (gain - target) * c;
        for ch in channels.iter_mut() {
            ch[i] *= gain;
        }
    }
}

// ---- Compressor ------------------------------------------------------------------
pub struct CompParams {
    pub threshold_db: f32,
    pub ratio: f32,
    pub knee_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
}

/// Feed-forward, stereo-linked compressor with a soft knee.
pub fn compress(channels: &mut [Vec<f32>], rate: u32, p: &CompParams) {
    if channels.is_empty() { return; }
    let r = rate as f32;
    let att = coef(p.attack_ms.max(0.1), r);
    let rel = coef(p.release_ms.max(1.0), r);
    let ratio = p.ratio.max(1.0);
    let knee = p.knee_db.max(0.0);
    let makeup = db_to_lin(p.makeup_db);
    let mut gr_db = 0.0f32; // smoothed gain reduction (positive = reduce)
    let n = channels[0].len();
    for i in 0..n {
        let peak = channels.iter().map(|c| c[i].abs()).fold(0.0f32, f32::max);
        let x = lin_to_db(peak);
        let over = x - p.threshold_db;
        let target = if knee > 0.0 && over.abs() <= knee / 2.0 {
            (1.0 - 1.0 / ratio) * (over + knee / 2.0).powi(2) / (2.0 * knee)
        } else if over > 0.0 {
            over * (1.0 - 1.0 / ratio)
        } else {
            0.0
        };
        let c = if target > gr_db { att } else { rel };
        gr_db = target + (gr_db - target) * c;
        let g = db_to_lin(-gr_db) * makeup;
        for ch in channels.iter_mut() {
            ch[i] *= g;
        }
    }
}

// ---- De-esser --------------------------------------------------------------------
pub struct DeessParams {
    pub freq: f32,
    pub threshold_db: f32,
    pub max_reduction_db: f32,
}

/// Dynamic high-shelf: when sibilance ("sss") in the detector band exceeds the threshold,
/// a high-shelf filter dips the treble by just the needed amount.
pub fn deess(channels: &mut [Vec<f32>], rate: u32, p: &DeessParams) {
    if channels.is_empty() { return; }
    let r = rate as f64;
    let n = channels[0].len();
    let mut detectors: Vec<Biquad> = channels.iter().map(|_| Biquad::new(FilterKind::BandPass, p.freq as f64 * 1.25, 1.2, r)).collect();
    let mut shelves: Vec<Biquad> = channels.iter().map(|_| Biquad::new(FilterKind::HighShelf(0.0), p.freq as f64, 0.707, r)).collect();
    let att = coef(0.5, rate as f32);
    let rel = coef(50.0, rate as f32);
    let thr = p.threshold_db;
    let maxr = p.max_reduction_db.abs();
    let (mut env, mut gr, mut applied) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..n {
        let mut det = 0.0f32;
        for (c, ch) in channels.iter().enumerate() {
            det = det.max(detectors[c].tick(ch[i]).abs());
        }
        let ec = if det > env { att } else { rel };
        env = det + (env - det) * ec;
        let over = lin_to_db(env) - thr;
        let target = if over > 0.0 { (over * 0.8).min(maxr) } else { 0.0 };
        let gc = if target > gr { att } else { rel };
        gr = target + (gr - target) * gc;
        // Re-tune the shelf only when the reduction has moved noticeably (cheap).
        if (gr - applied).abs() > 0.25 || (gr < 0.05 && applied != 0.0) {
            applied = if gr < 0.05 { 0.0 } else { gr };
            for sh in shelves.iter_mut() {
                sh.retune(&Biquad::new(FilterKind::HighShelf(-(applied as f64)), p.freq as f64, 0.707, r));
            }
        }
        for (c, ch) in channels.iter_mut().enumerate() {
            ch[i] = shelves[c].tick(ch[i]);
        }
    }
}

// ---- Limiter ---------------------------------------------------------------------
/// Look-ahead peak limiter: nothing exceeds `ceiling_db`, without hard clipping.
/// Gain = trailing average (L samples) of a forward-looking minimum (L samples) of the
/// required gain, so the gain is already down when each peak arrives.
pub fn limit(channels: &mut [Vec<f32>], rate: u32, ceiling_db: f32) {
    if channels.is_empty() { return; }
    let n = channels[0].len();
    if n == 0 { return; }
    let ceiling = db_to_lin(ceiling_db);
    let look = (((rate as f32) * 0.004) as usize).max(1); // 4 ms
    let rel = coef(120.0, rate as f32);
    let need: Vec<f32> = (0..n)
        .map(|i| {
            let p = channels.iter().map(|c| c[i].abs()).fold(0.0f32, f32::max);
            if p > ceiling { ceiling / p } else { 1.0 }
        })
        .collect();
    // Forward sliding minimum over need[i ..= i+look] using a monotonic deque.
    let mut m = vec![1.0f32; n];
    let mut dq: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    let mut next = 0usize;
    for i in 0..n {
        let end = (i + look).min(n - 1);
        while next <= end {
            while let Some(&back) = dq.back() {
                if need[back] >= need[next] { dq.pop_back(); } else { break; }
            }
            dq.push_back(next);
            next += 1;
        }
        while let Some(&front) = dq.front() {
            if front < i { dq.pop_front(); } else { break; }
        }
        m[i] = need[*dq.front().unwrap()];
    }
    // Trailing moving average over `look` samples (smooth attack), then release smoothing.
    let mut sum = 0.0f64;
    let mut g = 1.0f32;
    for i in 0..n {
        sum += m[i] as f64;
        if i >= look { sum -= m[i - look] as f64; }
        let cnt = (i + 1).min(look) as f64;
        let mut avg = (sum / cnt) as f32;
        if i + 1 < look {
            avg = avg.min(m[i]); // window not full yet at the very start
        }
        g = if avg < g { avg } else { avg + (g - avg) * rel };
        for ch in channels.iter_mut() {
            ch[i] = (ch[i] * g).clamp(-ceiling, ceiling);
        }
    }
}

// ---- Loudness (ITU-R BS.1770 / EBU R128 integrated LUFS) ----------------------------
pub fn integrated_lufs(channels: &[Vec<f32>], rate: u32) -> f32 {
    if channels.is_empty() || channels[0].is_empty() {
        return -70.0;
    }
    let r = rate as f64;
    let n = channels[0].len();
    // K-weighting filters, exact BS.1770 coefficients for any sample rate (as in libebur128).
    let (shelf_c, hp_c) = {
        let (f0, g, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
        let k = (PI * f0 / r).tan();
        let vh = 10f64.powf(g / 20.0);
        let vb = vh.powf(0.4996667741545416);
        let a0 = 1.0 + k / q + k * k;
        let shelf = ((vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0);
        let (f0, q) = (38.13547087602444, 0.5003270373238773);
        let k = (PI * f0 / r).tan();
        let d = 1.0 + k / q + k * k;
        let hp = (1.0, -2.0, 1.0, 2.0 * (k * k - 1.0) / d, (1.0 - k / q + k * k) / d);
        (shelf, hp)
    };
    let mut sq_sum = vec![0.0f64; n];
    for ch in channels {
        let mut shelf = Biquad::from_coeffs(shelf_c.0, shelf_c.1, shelf_c.2, shelf_c.3, shelf_c.4);
        let mut hp = Biquad::from_coeffs(hp_c.0, hp_c.1, hp_c.2, hp_c.3, hp_c.4);
        for (i, &x) in ch.iter().enumerate() {
            let y = hp.tick(shelf.tick(x)) as f64;
            sq_sum[i] += y * y;
        }
    }
    let block = (0.4 * r) as usize;
    let step = (0.1 * r) as usize;
    if n < block {
        let ms = sq_sum.iter().sum::<f64>() / n as f64;
        return (-0.691 + 10.0 * ms.max(1e-12).log10()) as f32;
    }
    // Prefix sums for fast block energy.
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + sq_sum[i];
    }
    let mut blocks = Vec::new();
    let mut s = 0;
    while s + block <= n {
        blocks.push((prefix[s + block] - prefix[s]) / block as f64);
        s += step;
    }
    let loud = |z: f64| -0.691 + 10.0 * z.max(1e-12).log10();
    let abs_gated: Vec<f64> = blocks.iter().cloned().filter(|&z| loud(z) > -70.0).collect();
    if abs_gated.is_empty() {
        return -70.0;
    }
    let rel_thr = loud(abs_gated.iter().sum::<f64>() / abs_gated.len() as f64) - 10.0;
    let rel_gated: Vec<f64> = abs_gated.into_iter().filter(|&z| loud(z) > rel_thr).collect();
    if rel_gated.is_empty() {
        return -70.0;
    }
    loud(rel_gated.iter().sum::<f64>() / rel_gated.len() as f64) as f32
}

pub fn peak_db(channels: &[Vec<f32>]) -> f32 {
    lin_to_db(channels.iter().flat_map(|c| c.iter()).fold(0.0f32, |m, &x| m.max(x.abs())))
}

// ---- Silence detection --------------------------------------------------------------
/// Returns (start, end) sample ranges to REMOVE so that silences longer than
/// `min_silence_ms` are shortened to `keep_ms`.
pub fn silence_ranges(key: &[f32], rate: u32, threshold_db: f32, min_silence_ms: f32, keep_ms: f32) -> Vec<(usize, usize)> {
    let win = ((rate as f32) * 0.01) as usize; // 10 ms windows
    if win == 0 || key.len() < win {
        return vec![];
    }
    let thr = db_to_lin(threshold_db);
    let nwin = key.len() / win;
    let silent: Vec<bool> = (0..nwin)
        .map(|w| {
            let s = &key[w * win..(w + 1) * win];
            let rms = (s.iter().map(|x| x * x).sum::<f32>() / win as f32).sqrt();
            rms < thr
        })
        .collect();
    let min_w = (min_silence_ms / 10.0).ceil() as usize;
    let keep = ((keep_ms * 0.001 * rate as f32) as usize).max(1);
    let mut out = Vec::new();
    let mut w = 0;
    while w < nwin {
        if !silent[w] {
            w += 1;
            continue;
        }
        let start = w;
        while w < nwin && silent[w] {
            w += 1;
        }
        if w - start >= min_w {
            let (s, e) = (start * win, if w == nwin { key.len() } else { w * win });
            // Keep half the padding at each edge so speech isn't clipped.
            let a = s + keep / 2;
            let b = e.saturating_sub(keep / 2);
            if b > a {
                out.push((a, b));
            }
        }
    }
    out
}

/// Remove the given sample ranges (sorted, non-overlapping) from every channel, with tiny crossfades.
pub fn remove_ranges(channels: &mut [Vec<f32>], ranges: &[(usize, usize)], rate: u32) {
    let fade = ((rate as f32) * 0.005) as usize; // 5 ms
    for ch in channels.iter_mut() {
        let mut out = Vec::with_capacity(ch.len());
        let mut pos = 0;
        for &(a, b) in ranges {
            let (a, b) = (a.min(ch.len()), b.min(ch.len()));
            if a < pos || b <= a {
                continue;
            }
            out.extend_from_slice(&ch[pos..a]);
            // Crossfade the join to avoid clicks.
            let f = fade.min(out.len()).min(ch.len() - b);
            let base = out.len() - f;
            for k in 0..f {
                let t = (k as f32 + 0.5) / f as f32;
                out[base + k] = out[base + k] * (1.0 - t) + ch[b + k] * t;
            }
            pos = b + f;
        }
        if pos < ch.len() {
            out.extend_from_slice(&ch[pos..]);
        }
        *ch = out;
    }
}

/// Min/max pairs for drawing a waveform.
pub fn peaks(mono: &[f32], buckets: usize) -> Vec<(f32, f32)> {
    let buckets = buckets.max(1);
    if mono.is_empty() {
        return vec![(0.0, 0.0); buckets];
    }
    (0..buckets)
        .map(|b| {
            let a = b * mono.len() / buckets;
            let e = ((b + 1) * mono.len() / buckets).max(a + 1).min(mono.len());
            mono[a..e].iter().fold((0.0f32, 0.0f32), |(lo, hi), &x| (lo.min(x), hi.max(x)))
        })
        .collect()
}
