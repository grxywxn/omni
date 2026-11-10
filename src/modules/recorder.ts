import { comingSoon } from './placeholder';

export function mount(el: HTMLElement): void {
  comingSoon(el, {
    icon: 'mic',
    title: 'Recorder',
    phase: 'Phase 2',
    points: [
      'Several microphones plus system audio, each on its own track',
      'Save WAV or FLAC to any folder you choose',
      'AI noise removal (RNNoise) — on/off per track',
      'Voice presets: EQ, compressor, de-esser, noise gate, YouTube loudness (−14 LUFS)',
      'Waveform editor: trim, cut, remove silences, then export',
    ],
  });
}
