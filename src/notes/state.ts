// Small shared state between the editor, panels and status bar.
import { Store } from '../core/store';

export interface ActiveNote {
  path: string;
  words: number;
  chars: number;
  saving: boolean;
  dirty: boolean;
  /** Words written in this session (since Omni opened). */
  sessionWords: number;
}

export const active = new Store<ActiveNote>({ path: '', words: 0, chars: 0, saving: false, dirty: false, sessionWords: 0 });

/** Words at session start per note, to compute words written today. */
export const sessionStart = new Map<string, number>();

export const ui = new Store<{ focus: boolean; rightTab: string; commentFocus: string | null; searchQuery: string | null }>({
  focus: false,
  rightTab: '',
  commentFocus: null,
  searchQuery: null,
});
