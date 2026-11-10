// The playback engine. Lives for the whole session once Music has been opened,
// so music keeps playing when you switch to Notes, Settings, etc.
import { Store, debounce } from '../core/store';
import { toast } from '../core/dom';
import { accessToken, spotifyConnected } from './auth';
import { api, bestImage, likedMap, type Track } from './api';
import { musicPrefs, patchMusicPrefs } from './prefs';
import { me, updateProfile } from '../lib/profiles';

// ---- Minimal typings for Spotify's Web Playback SDK -----------------------------
interface SdkTrack { uri: string; id: string | null; name: string; duration_ms: number; artists: Array<{ name: string; uri: string }>; album: { name: string; uri: string; images: Array<{ url: string; width?: number }> } }
interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat_mode: 0 | 1 | 2;
  context: { uri: string | null };
  track_window: { current_track: SdkTrack | null };
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (arg: any) => void): boolean;
  togglePlay(): Promise<void>;
  resume(): Promise<void>;
  pause(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  activateElement(): Promise<void>;
}
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer };
  }
}

// ---- State ---------------------------------------------------------------------
export interface NowTrack {
  uri: string;
  id: string | null;
  name: string;
  artists: Array<{ name: string; uri: string }>;
  album: { name: string; uri: string };
  art?: string;
  artSmall?: string;
  duration: number;
}

export interface PlayerState {
  track: NowTrack | null;
  playing: boolean;
  position: number;
  /** When `position` was measured (for smooth progress). */
  at: number;
  shuffle: boolean;
  repeat: 'off' | 'track' | 'context';
  volume: number;
  deviceId: string | null;
  deviceName: string | null;
  deviceType: string | null;
  contextUri: string | null;
  liked: boolean;
}

export type SdkStatus = 'off' | 'loading' | 'ready' | 'unsupported' | 'error';

export const player = new Store<PlayerState>({
  track: null,
  playing: false,
  position: 0,
  at: Date.now(),
  shuffle: false,
  repeat: 'off',
  volume: musicPrefs.get().volume,
  deviceId: null,
  deviceName: null,
  deviceType: null,
  contextUri: null,
  liked: false,
});
export const sdkStatus = new Store<{ status: SdkStatus; message?: string }>({ status: 'off' });

let sdk: SdkPlayer | null = null;
let omniDeviceId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

export const isOmniDevice = () => player.get().deviceId !== null && player.get().deviceId === omniDeviceId;
export const omniDevice = () => omniDeviceId;

export function livePosition(s = player.get()): number {
  if (!s.track) return 0;
  const p = s.playing ? s.position + (Date.now() - s.at) : s.position;
  return Math.min(p, s.track.duration);
}

function fromApiTrack(t: Track): NowTrack {
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artists: t.artists.map((a) => ({ name: a.name, uri: a.uri })),
    album: { name: t.album?.name ?? '', uri: t.album?.uri ?? '' },
    art: bestImage(t.album?.images, 300),
    artSmall: bestImage(t.album?.images, 64),
    duration: t.duration_ms,
  };
}

function fromSdkTrack(t: SdkTrack): NowTrack {
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artists: t.artists.map((a) => ({ name: a.name, uri: a.uri })),
    album: { name: t.album.name, uri: t.album.uri },
    art: bestImage(t.album.images, 300),
    artSmall: bestImage(t.album.images, 64),
    duration: t.duration_ms,
  };
}

function setState(patch: Partial<PlayerState>): void {
  const prev = player.get();
  const next = { ...prev, ...patch };
  if (prev.track?.uri !== next.track?.uri) next.liked = false;
  player.set(next);
  if (prev.track?.uri !== next.track?.uri && next.track) void refreshLiked();
}

async function refreshLiked(): Promise<void> {
  const t = player.get().track;
  if (!t) return;
  const m = await likedMap([t.uri]);
  if (player.get().track?.uri === t.uri) player.set({ ...player.get(), liked: m.get(t.uri) ?? false });
}

// ---- Start-up ------------------------------------------------------------------
/** Called the first time Music opens. Safe to call repeatedly. */
export function startPlayer(): void {
  if (started || !spotifyConnected.get()) return;
  started = true;
  void loadSdk();
  void syncFromApi();
  startPolling();
  setupMediaSession();
  setupNowPlayingShare();
  spotifyConnected.subscribe((c) => {
    if (!c) stopPlayer();
  }, false);
}

export function stopPlayer(): void {
  started = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  sdk?.disconnect();
  sdk = null;
  omniDeviceId = null;
  sdkStatus.set({ status: 'off' });
  setState({ track: null, playing: false, deviceId: null, deviceName: null });
}

function loadSdk(): Promise<void> {
  sdkStatus.set({ status: 'loading' });
  return new Promise((resolve) => {
    const failTimer = setTimeout(() => {
      if (sdkStatus.get().status === 'loading') {
        sdkStatus.set({ status: 'unsupported', message: "Omni's built-in player didn't start. You can still play on your phone or another Spotify device from the devices menu." });
      }
      resolve();
    }, 20_000);

    window.onSpotifyWebPlaybackSDKReady = () => {
      if (!window.Spotify) return;
      const p = new window.Spotify.Player({
        name: 'Omni',
        getOAuthToken: (cb) => void accessToken().then(cb).catch(() => {}),
        volume: musicPrefs.get().volume / 100,
      });
      sdk = p;
      p.addListener('ready', ({ device_id }: { device_id: string }) => {
        omniDeviceId = device_id;
        clearTimeout(failTimer);
        sdkStatus.set({ status: 'ready' });
        resolve();
        // Nothing playing anywhere? Make Omni the active device (paused) so Play just works.
        if (musicPrefs.get().preferThisPc && !player.get().deviceId) {
          void api.transfer(device_id, false).then(() => syncFromApi()).catch(() => {});
        }
      });
      p.addListener('not_ready', () => {
        if (player.get().deviceId === omniDeviceId) setState({ playing: false });
      });
      p.addListener('initialization_error', ({ message }: { message: string }) => {
        clearTimeout(failTimer);
        sdkStatus.set({ status: 'unsupported', message: `Omni's built-in player isn't supported on this PC (${message}). Use another Spotify device from the devices menu.` });
        resolve();
      });
      p.addListener('authentication_error', ({ message }: { message: string }) => {
        sdkStatus.set({ status: 'error', message: `Spotify sign-in problem: ${message}. Try reconnecting in Music settings.` });
      });
      p.addListener('account_error', () => {
        sdkStatus.set({ status: 'error', message: 'Playing inside Omni needs Spotify Premium.' });
      });
      p.addListener('playback_error', ({ message }: { message: string }) => toast(`Playback error: ${message}`, 'error'));
      p.addListener('player_state_changed', (s: SdkState | null) => {
        if (!s) return;
        const cur = s.track_window.current_track;
        setState({
          track: cur ? fromSdkTrack(cur) : null,
          playing: !s.paused,
          position: s.position,
          at: Date.now(),
          shuffle: s.shuffle,
          repeat: s.repeat_mode === 2 ? 'track' : s.repeat_mode === 1 ? 'context' : 'off',
          deviceId: omniDeviceId,
          deviceName: 'Omni (this PC)',
          deviceType: 'Computer',
          contextUri: s.context?.uri ?? null,
        });
      });
      void p.connect();
    };

    if (!document.getElementById('spotify-sdk')) {
      const s = document.createElement('script');
      s.id = 'spotify-sdk';
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.async = true;
      s.onerror = () => {
        clearTimeout(failTimer);
        sdkStatus.set({ status: 'unsupported', message: "Couldn't load Spotify's player. Check your internet connection." });
        resolve();
      };
      document.head.appendChild(s);
    } else if (window.Spotify) {
      window.onSpotifyWebPlaybackSDKReady();
    }
  });
}

/** Pull the current state from Spotify (needed when another device is playing). */
export async function syncFromApi(): Promise<void> {
  try {
    const s = await api.playback();
    if (!s) {
      if (!isOmniDevice()) setState({ playing: false, deviceId: null, deviceName: null, deviceType: null });
      return;
    }
    setState({
      track: s.item ? fromApiTrack(s.item) : null,
      playing: s.is_playing,
      position: s.progress_ms ?? 0,
      at: Date.now(),
      shuffle: s.shuffle_state,
      repeat: s.repeat_state,
      volume: s.device.volume_percent ?? player.get().volume,
      deviceId: s.device.id,
      deviceName: s.device.id === omniDeviceId ? 'Omni (this PC)' : s.device.name,
      deviceType: s.device.type,
      contextUri: s.context?.uri ?? null,
    });
  } catch {
    /* offline or token issue — try again next tick */
  }
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  let tick = 0;
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    tick++;
    // SDK pushes its own updates; other devices need polling. Slow poll keeps things in sync either way.
    if (!isOmniDevice() || tick % 6 === 0) void syncFromApi();
  }, 2500);
}

// ---- Controls ------------------------------------------------------------------
const afterRemote = () => setTimeout(() => void syncFromApi(), 350);

async function run(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Where to play when you start something new. */
function targetDevice(): string | undefined {
  const s = player.get();
  if (s.deviceId) return s.deviceId;
  if (omniDeviceId && musicPrefs.get().preferThisPc) return omniDeviceId;
  return undefined;
}

export async function togglePlay(): Promise<void> {
  const s = player.get();
  void sdk?.activateElement();
  if (isOmniDevice() && sdk) return run(() => sdk!.togglePlay());
  setState({ playing: !s.playing, position: livePosition(), at: Date.now() });
  await run(() => (s.playing ? api.pause(s.deviceId ?? undefined) : api.play({}, targetDevice())));
  afterRemote();
}

export async function next(): Promise<void> {
  if (isOmniDevice() && sdk) return run(() => sdk!.nextTrack());
  await run(() => api.next(player.get().deviceId ?? undefined));
  afterRemote();
}

export async function previous(): Promise<void> {
  if (isOmniDevice() && sdk) return run(() => sdk!.previousTrack());
  await run(() => api.previous(player.get().deviceId ?? undefined));
  afterRemote();
}

export async function seek(ms: number): Promise<void> {
  setState({ position: ms, at: Date.now() });
  if (isOmniDevice() && sdk) return run(() => sdk!.seek(ms));
  await run(() => api.seek(ms, player.get().deviceId ?? undefined));
}

const pushVolume = debounce((v: number) => {
  if (isOmniDevice() && sdk) void sdk.setVolume(v / 100);
  else if (player.get().deviceId) void api.volume(v, player.get().deviceId!).catch(() => {});
}, 120);

export function setVolume(v: number): void {
  const vol = Math.max(0, Math.min(100, Math.round(v)));
  setState({ volume: vol });
  patchMusicPrefs({ volume: vol });
  pushVolume(vol);
}

export async function toggleShuffle(): Promise<void> {
  const on = !player.get().shuffle;
  setState({ shuffle: on });
  await run(() => api.shuffle(on, player.get().deviceId ?? undefined));
}

export async function cycleRepeat(): Promise<void> {
  const order = ['off', 'context', 'track'] as const;
  const mode = order[(order.indexOf(player.get().repeat) + 1) % order.length];
  setState({ repeat: mode });
  await run(() => api.repeat(mode, player.get().deviceId ?? undefined));
}

/** Play an album/playlist/artist, optionally starting at a given track. */
export async function playContext(contextUri: string, startUri?: string, startIndex?: number): Promise<void> {
  void sdk?.activateElement();
  const offset = startUri ? { uri: startUri } : startIndex !== undefined ? { position: startIndex } : undefined;
  await run(() => api.play({ context_uri: contextUri, ...(offset ? { offset } : {}) }, targetDevice()));
  afterRemote();
}

/** Play a list of tracks (e.g. Liked Songs, search results). */
export async function playTracks(uris: string[], startIndex = 0): Promise<void> {
  void sdk?.activateElement();
  // The API accepts a limited list; send a window around the chosen track.
  const from = Math.max(0, startIndex - 20);
  const slice = uris.slice(from, from + 300);
  await run(() => api.play({ uris: slice, offset: { position: startIndex - from } }, targetDevice()));
  afterRemote();
}

export async function shufflePlay(contextUri: string): Promise<void> {
  void sdk?.activateElement();
  setState({ shuffle: true });
  await run(async () => {
    await api.shuffle(true, targetDevice()).catch(() => {});
    await api.play({ context_uri: contextUri }, targetDevice());
  });
  afterRemote();
}

export async function addToQueue(uri: string): Promise<void> {
  await run(async () => {
    await api.addToQueue(uri, player.get().deviceId ?? undefined);
    toast('Added to queue', 'success', 1800);
  });
}

export async function transferTo(deviceId: string): Promise<void> {
  void sdk?.activateElement();
  await run(() => api.transfer(deviceId, player.get().playing));
  setTimeout(() => void syncFromApi(), 600);
}

export async function toggleLikeCurrent(): Promise<void> {
  const s = player.get();
  if (!s.track) return;
  const liked = !s.liked;
  setState({ liked });
  await run(() => (liked ? api.saveToLibrary([s.track!.uri]) : api.removeFromLibrary([s.track!.uri])));
  window.dispatchEvent(new CustomEvent('omni:liked-changed', { detail: { uri: s.track.uri, liked } }));
}

// ---- Windows media keys & overlay (Media Session) --------------------------------
function setupMediaSession(): void {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    ms.setActionHandler('play', () => void togglePlay());
    ms.setActionHandler('pause', () => void togglePlay());
    ms.setActionHandler('nexttrack', () => void next());
    ms.setActionHandler('previoustrack', () => void previous());
  } catch {
    /* not supported */
  }
  let lastUri = '';
  player.subscribe((s) => {
    try {
      ms.playbackState = s.playing ? 'playing' : 'paused';
      if (s.track && s.track.uri !== lastUri) {
        lastUri = s.track.uri;
        ms.metadata = new MediaMetadata({
          title: s.track.name,
          artist: s.track.artists.map((a) => a.name).join(', '),
          album: s.track.album.name,
          artwork: s.track.art ? [{ src: s.track.art, sizes: '300x300' }] : [],
        });
      }
    } catch {
      /* ignore */
    }
  });
}

// ---- "Listening to" on your Omni profile ---------------------------------------
function setupNowPlayingShare(): void {
  let shared: string | null = null;
  let pausedSince: number | null = null;

  const push = debounce((value: { title: string; artist: string; art?: string; url?: string } | null) => {
    if (!me.get()) return;
    void updateProfile({ now_playing: value }).catch(() => {});
  }, 3000);

  const evaluate = () => {
    const s = player.get();
    const allowed = musicPrefs.get().shareNowPlaying;
    if (s.playing) pausedSince = null;
    else pausedSince ??= Date.now();
    const stale = pausedSince !== null && Date.now() - pausedSince > 90_000;

    const want = allowed && s.track && !stale ? s.track.uri : null;
    if (want === shared) return;
    shared = want;
    if (want && s.track) {
      const id = s.track.uri.split(':').pop();
      push({
        title: s.track.name,
        artist: s.track.artists.map((a) => a.name).join(', '),
        art: s.track.artSmall,
        url: id ? `https://open.spotify.com/track/${id}` : undefined,
      });
    } else push(null);
  };
  player.subscribe(evaluate, false);
  musicPrefs.subscribe(evaluate, false);
  setInterval(evaluate, 30_000);
  window.addEventListener('beforeunload', () => {
    if (shared) void updateProfile({ now_playing: null }).catch(() => {});
  });
}
