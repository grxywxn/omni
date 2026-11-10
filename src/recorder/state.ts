// Recorder state that outlives the Recorder page (recording continues while you browse Omni).
import { Store } from '../core/store';
import { rec, type Status, type TrackSpec } from './api';

export interface TrackConfig extends TrackSpec {
  /** Processing preset id for this track. */
  preset: string;
}

export interface RecorderPrefs {
  folder: string;
  tracks: TrackConfig[];
  autoProcess: boolean;
  openEditorAfter: boolean;
  exportFormat: 'wav24' | 'wav16' | 'flac' | 'wav32f';
  exportTracks: boolean;
  exportMix: boolean;
  /** Per-track settings overrides from "Customise" (keyed by track id). */
  overrides: Record<string, import('./presets').Settings>;
}

const KEY = 'omni.recorder.prefs';
const DEFAULTS: RecorderPrefs = {
  folder: '',
  tracks: [{ id: 'mic1', label: 'Microphone', device: '', kind: 'input', mono: true, gain_db: 0, preset: 'youtube' }],
  autoProcess: true,
  openEditorAfter: true,
  exportFormat: 'wav24',
  exportTracks: true,
  exportMix: false,
  overrides: {},
};

function load(): RecorderPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const recPrefs = new Store<RecorderPrefs>(load());
recPrefs.subscribe((p) => localStorage.setItem(KEY, JSON.stringify(p)), false);
export const patchRecPrefs = (patch: Partial<RecorderPrefs>) => recPrefs.update((p) => ({ ...p, ...patch }));

/** Live status, polled while a session (recording or sound check) is running. */
export const status = new Store<Status>({ active: false, writing: false, paused: false, elapsed: 0, bytes: 0, levels: [] });
/** Smoothed meter levels (0..1) with peak-hold, per track id. */
export const meters = new Store<Map<string, { level: number; hold: number; clip: number; error: string | null }>>(new Map());

/** Name/time for the take currently being recorded. */
export const current = { name: '', created: '', dir: null as string | null };

let timer: ReturnType<typeof setInterval> | null = null;

export function startPolling(): void {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const s = await rec.status();
      status.set(s);
      const m = new Map(meters.get());
      const now = Date.now();
      for (const l of s.levels) {
        const prev = m.get(l.id) ?? { level: 0, hold: 0, clip: 0, error: null };
        const level = Math.max(l.peak, prev.level * 0.82); // falls smoothly
        const hold = l.peak >= prev.hold ? l.peak : Math.max(0, prev.hold - 0.01);
        m.set(l.id, { level, hold, clip: l.clipped ? now : prev.clip, error: l.error });
      }
      meters.set(m);
      if (!s.active) stopPolling();
    } catch {
      stopPolling();
    }
  }, 60);
}

export function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
  meters.set(new Map());
}

/** Convert linear peak to a 0..1 meter position (−60 dB … 0 dB). */
export function meterPos(lin: number): number {
  if (lin <= 0.001) return 0;
  const db = 20 * Math.log10(lin);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
