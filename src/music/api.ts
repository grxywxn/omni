// Spotify Web API client — uses the endpoint names in force since the February 2026 changes.
import { accessToken } from './auth';

const BASE = 'https://api.spotify.com/v1';

export interface Image { url: string; width?: number | null; height?: number | null }
export interface ArtistRef { id: string; name: string; uri: string }
export interface AlbumRef { id: string; name: string; uri: string; images: Image[]; release_date?: string; album_type?: string; artists?: ArtistRef[] }
export interface Track {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  explicit?: boolean;
  artists: ArtistRef[];
  album?: AlbumRef;
  is_local?: boolean;
  type?: string;
}
export interface PlaylistItem { added_at?: string; item?: Track | null; track?: Track | null }
export interface Playlist {
  id: string;
  uri: string;
  name: string;
  description?: string | null;
  images: Image[] | null;
  owner: { id: string; display_name?: string | null };
  public?: boolean | null;
  collaborative?: boolean;
  snapshot_id?: string;
  items?: { total: number; href?: string; items?: PlaylistItem[] };
  tracks?: { total: number };
}
export interface Album extends AlbumRef { tracks: Paging<Track>; total_tracks?: number }
export interface Artist { id: string; name: string; uri: string; images?: Image[]; genres?: string[] }
export interface Paging<T> { items: T[]; total: number; next: string | null; offset: number; limit: number }
export interface Device { id: string | null; name: string; type: string; is_active: boolean; volume_percent: number | null; supports_volume?: boolean }
export interface PlaybackState {
  device: Device;
  is_playing: boolean;
  shuffle_state: boolean;
  repeat_state: 'off' | 'track' | 'context';
  progress_ms: number | null;
  item: Track | null;
  context: { uri: string; type: string } | null;
}
export interface Me { id: string; display_name: string | null; images?: Image[] }

export class SpotifyError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}, attempt = 0): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : BASE + path);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) url.searchParams.set(k, String(v));
  const token = await accessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && attempt === 0) {
    await accessToken(true); // token rejected early — refresh once and retry
    return request(method, path, opts, 1);
  }
  if (res.status === 429 && attempt < 3) {
    const wait = Math.min(10, Number(res.headers.get('Retry-After') ?? '2')) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return request(method, path, opts, attempt + 1);
  }
  if (res.status === 204 || res.status === 202) return undefined as T;
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message ?? `Spotify error ${res.status}`;
    throw new SpotifyError(friendly(res.status, msg), res.status);
  }
  return json as T;
}

function friendly(status: number, msg: string): string {
  if (status === 403 && /premium/i.test(msg)) return 'This needs Spotify Premium.';
  if (status === 403 && /user may not be registered|not registered/i.test(msg)) {
    return 'This Spotify account is not on your app’s user list. Add it under “User Management” in the Spotify developer dashboard.';
  }
  if (status === 404 && /device/i.test(msg)) return 'No active Spotify device. Pick one from the devices menu.';
  return msg;
}

const get = <T>(p: string, q?: Record<string, string | number | boolean | undefined>) => request<T>('GET', p, { query: q });

/** Item from a playlist entry (new `item` field; older responses used `track`). */
export const entryTrack = (e: PlaylistItem): Track | null => e.item ?? e.track ?? null;
export const playlistTotal = (p: Playlist) => p.items?.total ?? p.tracks?.total ?? 0;
export const bestImage = (imgs: Image[] | null | undefined, min = 0): string | undefined => {
  if (!imgs?.length) return undefined;
  const sorted = [...imgs].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 640) >= min) ?? sorted[sorted.length - 1]).url;
};

export const api = {
  me: () => get<Me>('/me'),

  // ---- Library ----
  myPlaylists: (offset = 0) => get<Paging<Playlist>>('/me/playlists', { limit: 50, offset }),
  async allMyPlaylists(): Promise<Playlist[]> {
    const out: Playlist[] = [];
    for (let offset = 0; offset < 1000; offset += 50) {
      const page = await this.myPlaylists(offset);
      out.push(...page.items.filter(Boolean));
      if (!page.next) break;
    }
    return out;
  },
  likedTracks: (offset = 0) => get<Paging<{ added_at: string; track: Track }>>('/me/tracks', { limit: 50, offset }),
  savedAlbums: (offset = 0) => get<Paging<{ added_at: string; album: Album }>>('/me/albums', { limit: 50, offset }),
  recentlyPlayed: () => get<{ items: Array<{ track: Track; played_at: string }> }>('/me/player/recently-played', { limit: 30 }),
  topTracks: () => get<Paging<Track>>('/me/top/tracks', { limit: 20, time_range: 'short_term' }),

  /** Save tracks/albums/playlists to your library (max 40 URIs per call). */
  saveToLibrary: (uris: string[]) => request<void>('PUT', '/me/library', { query: { uris: uris.slice(0, 40).join(',') } }),
  removeFromLibrary: (uris: string[]) => request<void>('DELETE', '/me/library', { query: { uris: uris.slice(0, 40).join(',') } }),
  libraryContains: (uris: string[]) => get<boolean[]>('/me/library/contains', { uris: uris.slice(0, 40).join(',') }),

  // ---- Playlists ----
  playlist: (id: string) => get<Playlist>(`/playlists/${id}`),
  playlistItems: (id: string, offset = 0) => get<Paging<PlaylistItem>>(`/playlists/${id}/items`, { limit: 50, offset, additional_types: 'track' }),
  createPlaylist: (name: string, description = '', isPublic = false) =>
    request<Playlist>('POST', '/me/playlists', { body: { name, description, public: isPublic } }),
  updatePlaylist: (id: string, changes: { name?: string; description?: string; public?: boolean; collaborative?: boolean }) =>
    request<void>('PUT', `/playlists/${id}`, { body: changes }),
  addToPlaylist: (id: string, uris: string[], position?: number) =>
    request<{ snapshot_id: string }>('POST', `/playlists/${id}/items`, { body: { uris: uris.slice(0, 100), position } }),
  removeFromPlaylist: (id: string, uris: string[], snapshot_id?: string) =>
    request<{ snapshot_id: string }>('DELETE', `/playlists/${id}/items`, { body: { items: uris.map((uri) => ({ uri })), snapshot_id } }),
  reorderPlaylist: (id: string, range_start: number, insert_before: number, snapshot_id?: string) =>
    request<{ snapshot_id: string }>('PUT', `/playlists/${id}/items`, { body: { range_start, insert_before, range_length: 1, snapshot_id } }),

  // ---- Catalogue ----
  album: (id: string) => get<Album>(`/albums/${id}`),
  albumTracks: (id: string, offset = 0) => get<Paging<Track>>(`/albums/${id}/tracks`, { limit: 50, offset }),
  artist: (id: string) => get<Artist>(`/artists/${id}`),
  artistAlbums: (id: string) => get<Paging<AlbumRef>>(`/artists/${id}/albums`, { limit: 30, include_groups: 'album,single' }),
  /** Search returns at most 10 per type per page (2026 limit) — page with offset. */
  search: (q: string, types: string[], offset = 0) =>
    get<{ tracks?: Paging<Track>; albums?: Paging<AlbumRef>; artists?: Paging<Artist>; playlists?: Paging<Playlist | null> }>('/search', {
      q,
      type: types.join(','),
      limit: 10,
      offset,
    }),

  // ---- Player ----
  playback: () => get<PlaybackState | undefined>('/me/player', { additional_types: 'track' }),
  devices: () => get<{ devices: Device[] }>('/me/player/devices'),
  transfer: (deviceId: string, play = true) => request<void>('PUT', '/me/player', { body: { device_ids: [deviceId], play } }),
  play: (opts: { context_uri?: string; uris?: string[]; offset?: { position?: number; uri?: string }; position_ms?: number } = {}, deviceId?: string) =>
    request<void>('PUT', '/me/player/play', { query: { device_id: deviceId }, body: Object.keys(opts).length ? opts : undefined }),
  pause: (deviceId?: string) => request<void>('PUT', '/me/player/pause', { query: { device_id: deviceId } }),
  next: (deviceId?: string) => request<void>('POST', '/me/player/next', { query: { device_id: deviceId } }),
  previous: (deviceId?: string) => request<void>('POST', '/me/player/previous', { query: { device_id: deviceId } }),
  seek: (ms: number, deviceId?: string) => request<void>('PUT', '/me/player/seek', { query: { position_ms: Math.round(ms), device_id: deviceId } }),
  volume: (pct: number, deviceId?: string) => request<void>('PUT', '/me/player/volume', { query: { volume_percent: Math.round(pct), device_id: deviceId } }),
  shuffle: (on: boolean, deviceId?: string) => request<void>('PUT', '/me/player/shuffle', { query: { state: on, device_id: deviceId } }),
  repeat: (mode: 'off' | 'track' | 'context', deviceId?: string) => request<void>('PUT', '/me/player/repeat', { query: { state: mode, device_id: deviceId } }),
  queue: () => get<{ currently_playing: Track | null; queue: Track[] }>('/me/player/queue'),
  addToQueue: (uri: string, deviceId?: string) => request<void>('POST', '/me/player/queue', { query: { uri, device_id: deviceId } }),
};

/** Check liked status for many tracks at once (batches of 40). */
export async function likedMap(uris: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const unique = [...new Set(uris)].filter((u) => u.startsWith('spotify:track:'));
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    try {
      const res = await api.libraryContains(chunk);
      chunk.forEach((u, j) => out.set(u, Boolean(res?.[j])));
    } catch {
      /* non-critical */
    }
  }
  return out;
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
