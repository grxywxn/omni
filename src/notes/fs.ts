// Wrappers around the native vault commands (src-tauri/src/notes.rs).
import { isTauri } from '../core/native';

export interface Entry { path: string; is_dir: boolean; mtime: number; size: number }
export interface NoteFile { path: string; content: string; mtime: number }

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error('Notes work in the Omni desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : (e as Error)?.message ?? String(e));
  }
}

export const nfs = {
  scan: (root: string) => call<Entry[]>('vault_scan', { root }),
  readAll: (root: string) => call<NoteFile[]>('vault_read_all', { root }),
  read: (root: string, path: string) => call<NoteFile>('note_read', { root, path }),
  readOpt: (root: string, path: string) => call<string | null>('note_read_opt', { root, path }),
  write: (root: string, path: string, content: string) => call<number>('note_write', { root, path, content }),
  mtime: (root: string, path: string) => call<number>('note_mtime', { root, path }),
  mkdir: (root: string, path: string) => call<void>('dir_create', { root, path }),
  move: (root: string, from: string, to: string) => call<void>('path_move', { root, from, to }),
  trash: (root: string, path: string) => call<void>('path_trash', { root, path }),
  writeBase64: (root: string, path: string, data: string) => call<void>('file_write_base64', { root, path, data }),
  exportWrite: (path: string, data: string, base64: boolean) => call<void>('export_write', { path, data, base64 }),
  list: (root: string, path: string) => call<Entry[]>('dir_list', { root, path }),
};

export function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** Ask where to save an export. Returns null if cancelled. */
export async function saveDialog(defaultName: string, ext: string, label: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const r = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
  return r ?? null;
}

export const baseName = (p: string) => p.split('/').pop() ?? p;
export const noteName = (p: string) => baseName(p).replace(/\.md$/i, '');
export const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const joinRel = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
export const isMd = (p: string) => /\.md$/i.test(p);

/** Characters Windows doesn't allow in file names. */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120) || 'Untitled';
}
