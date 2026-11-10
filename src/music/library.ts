import { Store } from '../core/store';
import { toast } from '../core/dom';
import { api, type Album, type Me, type Playlist } from './api';

export interface LibraryState {
  me: Me | null;
  playlists: Playlist[];
  albums: Album[];
  loading: boolean;
  error: string | null;
}

export const library = new Store<LibraryState>({ me: null, playlists: [], albums: [], loading: false, error: null });

export const ownsPlaylist = (p: Playlist) => !!library.get().me && (p.owner.id === library.get().me!.id || !!p.collaborative);

export async function loadLibrary(): Promise<void> {
  library.update((l) => ({ ...l, loading: true, error: null }));
  try {
    const [me, playlists, albums] = await Promise.all([
      api.me(),
      api.allMyPlaylists(),
      api.savedAlbums().then((p) => p.items.map((i) => i.album)).catch(() => [] as Album[]),
    ]);
    library.set({ me, playlists, albums, loading: false, error: null });
  } catch (e) {
    library.update((l) => ({ ...l, loading: false, error: (e as Error).message }));
  }
}

export async function refreshPlaylists(): Promise<void> {
  try {
    const playlists = await api.allMyPlaylists();
    library.update((l) => ({ ...l, playlists }));
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---- In-music navigation with back/forward ----------------------------------------
export type MusicRoute =
  | { view: 'home' }
  | { view: 'search'; q?: string }
  | { view: 'liked' }
  | { view: 'queue' }
  | { view: 'playlist'; id: string }
  | { view: 'album'; id: string }
  | { view: 'artist'; id: string };

const back: MusicRoute[] = [];
const fwd: MusicRoute[] = [];
export const musicRoute = new Store<MusicRoute>({ view: 'home' });

export function go(r: MusicRoute): void {
  const cur = musicRoute.get();
  if (JSON.stringify(cur) === JSON.stringify(r)) return;
  back.push(cur);
  if (back.length > 50) back.shift();
  fwd.length = 0;
  musicRoute.set(r);
}
export const canGoBack = () => back.length > 0;
export const canGoForward = () => fwd.length > 0;
export function goBack(): void {
  const r = back.pop();
  if (!r) return;
  fwd.push(musicRoute.get());
  musicRoute.set(r);
}
export function goForward(): void {
  const r = fwd.pop();
  if (!r) return;
  back.push(musicRoute.get());
  musicRoute.set(r);
}

/** Open whatever a spotify: URI points to. */
export function openUri(uri: string): void {
  const [, type, id] = uri.split(':');
  if (type === 'album') go({ view: 'album', id });
  else if (type === 'artist') go({ view: 'artist', id });
  else if (type === 'playlist') go({ view: 'playlist', id });
  else if (type === 'collection') go({ view: 'liked' });
}

/** Re-render the current page (e.g. after editing a playlist). */
export function reloadView(): void {
  musicRoute.set({ ...musicRoute.get() } as MusicRoute);
}
