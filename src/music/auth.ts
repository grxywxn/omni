// Spotify sign-in using the Authorization Code + PKCE flow (no client secret needed).
import { Store } from '../core/store';
import { isTauri, openExternal } from '../core/native';

export const REDIRECT_PORT = 43821;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-top-read',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ');

const CLIENT_KEY = 'omni.spotify.clientId';
const TOKEN_KEY = 'omni.spotify.tokens';

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number; // ms epoch
}

export const spotifyConnected = new Store<boolean>(loadTokens() !== null);

export function getClientId(): string {
  return localStorage.getItem(CLIENT_KEY) ?? '';
}
export function setClientId(id: string): void {
  localStorage.setItem(CLIENT_KEY, id.trim());
}

function loadTokens(): Tokens | null {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null');
    return t && t.access && t.refresh ? t : null;
  } catch {
    return null;
  }
}
function saveTokens(t: Tokens | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  else localStorage.removeItem(TOKEN_KEY);
  spotifyConnected.set(t !== null);
}

export function disconnectSpotify(): void {
  saveTokens(null);
}

// ---- PKCE helpers -------------------------------------------------------------
function randomString(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`Spotify sign-in failed: ${desc}`);
  }
  const prev = loadTokens();
  return {
    access: json.access_token,
    refresh: json.refresh_token ?? prev?.refresh ?? '',
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
  };
}

/** Full sign-in: opens Spotify in your browser, waits for the redirect, swaps the code for tokens. */
export async function connectSpotify(): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new Error('Enter your Spotify Client ID first.');
  if (!isTauri) throw new Error('Spotify sign-in works in the desktop app.');

  const verifier = randomString(64);
  const state = randomString(16);
  const url =
    'https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
      state,
    });

  const { invoke } = await import('@tauri-apps/api/core');
  const waiting = invoke<string>('wait_for_oauth', { port: REDIRECT_PORT, timeoutSecs: 300 });
  await openExternal(url);
  const path = await waiting;

  const params = new URLSearchParams(path.split('?')[1] ?? '');
  if (params.get('error')) {
    const e = params.get('error');
    throw new Error(e === 'access_denied' ? 'You cancelled the Spotify sign-in.' : `Spotify said: ${e}`);
  }
  if (params.get('state') !== state) throw new Error('Sign-in check failed (state mismatch). Please try again.');
  const code = params.get('code');
  if (!code) throw new Error('Spotify did not return a sign-in code.');

  saveTokens(
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
  );
}

export async function cancelConnect(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('cancel_oauth').catch(() => {});
}

let refreshing: Promise<string> | null = null;

/** A valid access token, refreshed automatically when needed. */
export async function accessToken(force = false): Promise<string> {
  const t = loadTokens();
  if (!t) throw new Error('Not connected to Spotify');
  if (!force && Date.now() < t.expiresAt) return t.access;
  refreshing ??= (async () => {
    try {
      const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: getClientId() });
      saveTokens(fresh);
      return fresh.access;
    } catch (e) {
      // Refresh token revoked/expired → ask to reconnect.
      saveTokens(null);
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
