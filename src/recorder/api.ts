// Typed wrappers around the native Recorder commands (src-tauri/src/audio).
import { isTauri } from '../core/native';
import type { Settings } from './presets';

export type TrackKind = 'input' | 'loopback';

export interface TrackSpec {
  id: string;
  label: string;
  /** Device name; '' = Windows default. */
  device: string;
  kind: TrackKind;
  mono: boolean;
  gain_db: number;
}
export interface DeviceInfo { name: string; is_default: boolean; channels: number; rate: number }
export interface Devices { inputs: DeviceInfo[]; outputs: DeviceInfo[] }
export interface Level { id: string; peak: number; clipped: boolean; error: string | null }
export interface Status { active: boolean; writing: boolean; paused: boolean; elapsed: number; bytes: number; levels: Level[] }
export interface TakeTrack { id: string; label: string; file: string; processed: boolean; lufs: number | null }
export interface Take { name: string; created: string; seconds: number; tracks: TakeTrack[]; preset: string | null }
export interface TakeEntry { dir: string; take: Take }
export interface TakeInfo { take: Take; can_undo: boolean; preview_raw: string | null; preview_processed: string | null }
export interface TrackPeaks { id: string; label: string; seconds: number; peaks: Array<[number, number]> }
export interface ProcessReport { id: string; input_lufs: number; output_lufs: number; peak_db: number }
export interface ExportOptions { folder: string; which: 'processed' | 'raw'; format: 'wav16' | 'wav24' | 'wav32f' | 'flac'; tracks: boolean; mix: boolean }

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('The Recorder works in the Omni desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : (e as Error)?.message ?? String(e));
  }
}

export const rec = {
  devices: () => call<Devices>('rec_devices'),
  start: (tracks: TrackSpec[], folder?: string, name?: string) => call<string | null>('rec_start', { tracks, folder: folder ?? null, name: name ?? null }),
  pause: (paused: boolean) => call<void>('rec_pause', { paused }),
  status: () => call<Status>('rec_status'),
  stop: (name?: string, created?: string) => call<{ dir: string | null; take: Take | null; errors: string[] }>('rec_stop', { name: name ?? null, created: created ?? null }),
  takes: (folder: string) => call<TakeEntry[]>('takes_list', { folder }),
  open: (dir: string) => call<TakeInfo>('take_open', { dir }),
  process: (dir: string, settings: Record<string, Settings>) => call<ProcessReport[]>('take_process', { dir, settings }),
  progress: () => call<number>('take_progress'),
  peaks: (dir: string, which: 'raw' | 'processed', buckets: number) => call<TrackPeaks[]>('take_peaks', { dir, which, buckets }),
  cut: (dir: string, start: number, end: number) => call<void>('take_cut', { dir, start, end }),
  trim: (dir: string, start: number, end: number) => call<void>('take_trim', { dir, start, end }),
  removeSilence: (dir: string, reference: string, threshold: number, minMs: number, keepMs: number, dryRun: boolean) =>
    call<number>('take_remove_silence', { dir, reference, threshold, minMs, keepMs, dryRun }),
  undo: (dir: string) => call<void>('take_undo', { dir }),
  export: (dir: string, options: ExportOptions) => call<string[]>('take_export', { dir, options }),
  rename: (dir: string, name: string) => call<void>('take_rename', { dir, name }),
};

export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ directory: true, multiple: false, title, defaultPath });
  return typeof r === 'string' ? r : null;
}

export async function revealInExplorer(path: string): Promise<void> {
  if (!isTauri) return;
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(path);
}

export async function defaultRecordingsFolder(): Promise<string> {
  if (!isTauri) return '';
  const { documentDir, join } = await import('@tauri-apps/api/path');
  return join(await documentDir(), 'Omni Recordings');
}

export async function fileUrl(path: string): Promise<string> {
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  return `${convertFileSrc(path)}?v=${Date.now()}`;
}

export function fmtDuration(s: number, withTenths = false): string {
  const neg = s < 0;
  s = Math.abs(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const t = withTenths ? `.${Math.floor((s * 10) % 10)}` : '';
  const core = h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${core}${t}`;
}

export function fmtBytes(b: number): string {
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
