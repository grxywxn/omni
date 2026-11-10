import { Store } from '../core/store';

export interface MusicPrefs {
  /** Show "Listening to …" on your Omni profile. */
  shareNowPlaying: boolean;
  /** Play in Omni itself when nothing else is playing. */
  preferThisPc: boolean;
  /** Tint the music view with colours from the album art. */
  dynamicColor: boolean;
  rowDensity: 'compact' | 'cozy' | 'roomy';
  showAlbumColumn: boolean;
  showAddedColumn: boolean;
  showLibraryArt: boolean;
  libraryWidth: number;
  playerPosition: 'bottom' | 'top';
  playerStyle: 'full' | 'minimal';
  artShape: 'square' | 'rounded' | 'circle';
  /** Spin the album art like a record while playing. */
  vinylSpin: boolean;
  volume: number;
}

const KEY = 'omni.music.prefs';
const DEFAULTS: MusicPrefs = {
  shareNowPlaying: true,
  preferThisPc: true,
  dynamicColor: true,
  rowDensity: 'cozy',
  showAlbumColumn: true,
  showAddedColumn: false,
  showLibraryArt: true,
  libraryWidth: 280,
  playerPosition: 'bottom',
  playerStyle: 'full',
  artShape: 'rounded',
  vinylSpin: false,
  volume: 70,
};

function load(): MusicPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const musicPrefs = new Store<MusicPrefs>(load());
musicPrefs.subscribe((p) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}, false);

export function patchMusicPrefs(patch: Partial<MusicPrefs>): void {
  musicPrefs.update((p) => ({ ...p, ...patch }));
}
