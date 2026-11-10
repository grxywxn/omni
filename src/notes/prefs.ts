import { Store } from '../core/store';

export type EditorMode = 'live' | 'source' | 'reading';

export interface NotesPrefs {
  root: string;
  attachments: string;
  dailyFolder: string;
  templatesFolder: string;
  defaultMode: EditorMode;
  pageView: boolean;
  pageSize: 'a4' | 'letter';
  pageFont: string;
  editorFont: string;
  editorSize: number;
  readableWidth: boolean;
  spellcheck: boolean;
  showToolbar: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  rightTab: 'outline' | 'links' | 'comments' | 'snapshots' | 'stats';
  sessionTarget: number;
  bookmarks: string[];
  recent: string[];
  /** Per-folder view settings. */
  views: Record<string, { layout: string; groupBy?: string; columns?: string[]; recursive?: boolean }>;
}

const KEY = 'omni.notes.prefs';
const DEFAULTS: NotesPrefs = {
  root: '',
  attachments: 'Attachments',
  dailyFolder: 'Daily',
  templatesFolder: 'Templates',
  defaultMode: 'live',
  pageView: false,
  pageSize: 'a4',
  pageFont: 'Georgia, "Times New Roman", serif',
  editorFont: '',
  editorSize: 16,
  readableWidth: true,
  spellcheck: true,
  showToolbar: true,
  leftOpen: true,
  rightOpen: true,
  leftWidth: 260,
  rightWidth: 280,
  rightTab: 'outline',
  sessionTarget: 1000,
  bookmarks: [],
  recent: [],
  views: {},
};

function load(): NotesPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const notesPrefs = new Store<NotesPrefs>(load());
notesPrefs.subscribe((p) => localStorage.setItem(KEY, JSON.stringify(p)), false);
export const patchNotesPrefs = (patch: Partial<NotesPrefs>) => notesPrefs.update((p) => ({ ...p, ...patch }));

export function pushRecent(path: string): void {
  const r = [path, ...notesPrefs.get().recent.filter((x) => x !== path)].slice(0, 30);
  patchNotesPrefs({ recent: r });
}
