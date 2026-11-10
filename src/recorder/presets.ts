// Voice processing presets. Every stage can be switched on/off.
// The shape matches `Settings` in src-tauri/src/audio/take.rs.

export interface Settings {
  mono: boolean;
  denoise: { enabled: boolean; amount: number };
  highpass: { enabled: boolean; freq: number };
  gate: { enabled: boolean; threshold: number; range: number; attack: number; hold: number; release: number };
  eq: { enabled: boolean; low: number; mud: number; presence: number; air: number };
  deesser: { enabled: boolean; freq: number; threshold: number; reduction: number };
  compressor: { enabled: boolean; threshold: number; ratio: number; attack: number; release: number; makeup: number };
  loudness: { enabled: boolean; target: number; ceiling: number };
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  settings: Settings;
  custom?: boolean;
}

const off = { enabled: false };

export const BUILT_IN: Preset[] = [
  {
    id: 'youtube',
    name: 'YouTube voice',
    description: 'Clean, clear and loud enough for YouTube (−14 LUFS). A great default.',
    settings: {
      mono: true,
      denoise: { enabled: true, amount: 0.85 },
      highpass: { enabled: true, freq: 80 },
      gate: { enabled: true, threshold: -50, range: 18, attack: 2, hold: 150, release: 180 },
      eq: { enabled: true, low: 1.5, mud: -2.5, presence: 2.5, air: 2 },
      deesser: { enabled: true, freq: 6000, threshold: -28, reduction: 6 },
      compressor: { enabled: true, threshold: -22, ratio: 3, attack: 10, release: 120, makeup: 0 },
      loudness: { enabled: true, target: -14, ceiling: -1 },
    },
  },
  {
    id: 'warm',
    name: 'Warm podcast',
    description: 'Fuller, richer low end and gentle levelling. Good for long talks.',
    settings: {
      mono: true,
      denoise: { enabled: true, amount: 0.7 },
      highpass: { enabled: true, freq: 70 },
      gate: { enabled: true, threshold: -52, range: 12, attack: 3, hold: 180, release: 220 },
      eq: { enabled: true, low: 3, mud: -2, presence: 1, air: 0.5 },
      deesser: { enabled: true, freq: 5500, threshold: -30, reduction: 5 },
      compressor: { enabled: true, threshold: -24, ratio: 3.5, attack: 15, release: 150, makeup: 0 },
      loudness: { enabled: true, target: -16, ceiling: -1 },
    },
  },
  {
    id: 'bright',
    name: 'Bright & crisp',
    description: 'Extra clarity and sparkle for a modern, punchy voice.',
    settings: {
      mono: true,
      denoise: { enabled: true, amount: 0.85 },
      highpass: { enabled: true, freq: 100 },
      gate: { enabled: true, threshold: -48, range: 18, attack: 2, hold: 140, release: 160 },
      eq: { enabled: true, low: 0, mud: -3, presence: 4, air: 4 },
      deesser: { enabled: true, freq: 6500, threshold: -27, reduction: 7 },
      compressor: { enabled: true, threshold: -20, ratio: 3, attack: 8, release: 100, makeup: 0 },
      loudness: { enabled: true, target: -14, ceiling: -1 },
    },
  },
  {
    id: 'rescue',
    name: 'Noisy room rescue',
    description: 'Strongest noise removal and gating for fans, traffic, generators or echoey rooms.',
    settings: {
      mono: true,
      denoise: { enabled: true, amount: 1 },
      highpass: { enabled: true, freq: 120 },
      gate: { enabled: true, threshold: -42, range: 30, attack: 2, hold: 120, release: 120 },
      eq: { enabled: true, low: -1, mud: -3, presence: 3, air: 1 },
      deesser: { enabled: true, freq: 6000, threshold: -28, reduction: 6 },
      compressor: { enabled: true, threshold: -22, ratio: 4, attack: 8, release: 110, makeup: 0 },
      loudness: { enabled: true, target: -14, ceiling: -1 },
    },
  },
  {
    id: 'natural',
    name: 'Natural / light touch',
    description: 'Gentle clean-up that keeps your voice as it is.',
    settings: {
      mono: true,
      denoise: { enabled: true, amount: 0.5 },
      highpass: { enabled: true, freq: 70 },
      gate: { ...off, threshold: -50, range: 12, attack: 3, hold: 150, release: 200 },
      eq: { ...off, low: 0, mud: 0, presence: 0, air: 0 },
      deesser: { enabled: true, freq: 6000, threshold: -26, reduction: 4 },
      compressor: { enabled: true, threshold: -18, ratio: 2, attack: 20, release: 200, makeup: 0 },
      loudness: { enabled: true, target: -14, ceiling: -1 },
    },
  },
  {
    id: 'raw',
    name: 'Raw (no processing)',
    description: 'Leave the audio exactly as recorded. Ideal for system audio, music or game sound.',
    settings: {
      mono: false,
      denoise: { ...off, amount: 0.8 },
      highpass: { ...off, freq: 80 },
      gate: { ...off, threshold: -50, range: 18, attack: 2, hold: 150, release: 180 },
      eq: { ...off, low: 0, mud: 0, presence: 0, air: 0 },
      deesser: { ...off, freq: 6000, threshold: -28, reduction: 6 },
      compressor: { ...off, threshold: -22, ratio: 3, attack: 10, release: 120, makeup: 0 },
      loudness: { ...off, target: -14, ceiling: -1 },
    },
  },
];

const KEY = 'omni.recorder.presets';

export function customPresets(): Preset[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function allPresets(): Preset[] {
  return [...BUILT_IN, ...customPresets()];
}

export function presetById(id: string | undefined): Preset {
  return allPresets().find((p) => p.id === id) ?? BUILT_IN[0];
}

export function saveCustomPreset(name: string, settings: Settings, description = 'Your own preset'): Preset {
  const p: Preset = { id: `custom-${Date.now()}`, name, description, settings: clone(settings), custom: true };
  localStorage.setItem(KEY, JSON.stringify([...customPresets(), p]));
  return p;
}

export function deleteCustomPreset(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(customPresets().filter((p) => p.id !== id)));
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
