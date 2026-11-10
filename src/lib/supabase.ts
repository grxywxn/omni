import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Where Omni's accounts live. Either baked in at build time (.env) or entered in the
// app on first launch (saved on this PC), so one installer works for everyone.
export interface BackendConfig {
  url: string;
  key: string;
}

const STORAGE_KEY = 'omni.backend';
const CODE_PREFIX = 'OMNI-CONNECT:';

function fromEnv(): BackendConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_KEY?.trim();
  if (!url || !key || url.includes('YOUR-PROJECT')) return null;
  return { url, key };
}

function fromStorage(): BackendConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (c && typeof c.url === 'string' && typeof c.key === 'string') return c;
  } catch {
    /* ignore */
  }
  return null;
}

export function getConfig(): BackendConfig | null {
  return fromStorage() ?? fromEnv();
}

export const isConfigured = () => getConfig() !== null;

export function normalizeUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

export function validateConfig(c: BackendConfig): string | null {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(c.url)) return 'The project URL should look like https://abcdefgh.supabase.co';
  if (c.key.length < 20) return "That key looks too short. Copy the whole 'anon' / 'publishable' key.";
  if (/service_role|sb_secret_/i.test(c.key) || keyRole(c.key) === 'service_role') {
    return "That's the secret (service_role) key — never put it in the app. Use the anon / publishable key.";
  }
  return null;
}

function keyRole(key: string): string | null {
  try {
    return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role ?? null;
  } catch {
    return null;
  }
}

/** Check the details work and the database setup (schema.sql) has been run. */
export async function testConfig(c: BackendConfig): Promise<void> {
  const problem = validateConfig(c);
  if (problem) throw new Error(problem);
  let res: Response;
  try {
    res = await fetch(`${c.url}/rest/v1/rpc/is_first_account`, {
      method: 'POST',
      headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    throw new Error("Couldn't reach that project. Check the URL and your internet connection.");
  }
  if (res.status === 401 || res.status === 403) throw new Error('The key was rejected. Copy the anon / publishable key again.');
  if (res.status === 404) throw new Error('Connected, but the database setup is missing. Run supabase/schema.sql in the SQL Editor first.');
  if (!res.ok) throw new Error(`The server answered with an error (${res.status}).`);
}

export function saveConfig(c: BackendConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

export function clearConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** A single line friends can paste instead of two values. (The anon key is safe to share.) */
export function encodeConnectionCode(c: BackendConfig): string {
  return CODE_PREFIX + btoa(JSON.stringify({ u: c.url, k: c.key }));
}

export function decodeConnectionCode(code: string): BackendConfig | null {
  try {
    const raw = code.trim();
    if (!raw.startsWith(CODE_PREFIX)) return null;
    const o = JSON.parse(atob(raw.slice(CODE_PREFIX.length)));
    return typeof o.u === 'string' && typeof o.k === 'string' ? { url: o.u, key: o.k } : null;
  } catch {
    return null;
  }
}

let client: SupabaseClient | null = null;

export function sb(): SupabaseClient {
  if (!client) {
    const c = getConfig();
    if (!c) throw new Error('Omni is not connected to a server yet.');
    client = createClient(c.url, c.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'omni.auth' },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }
  return client;
}

/** Turn Supabase/Postgres errors into something a person can read. */
export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/invite code/i.test(msg)) return 'A valid invite code is required to join.';
  if (/Database error saving new user/i.test(msg)) return 'Sign-up was rejected — check your invite code and username.';
  if (/Invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/Email not confirmed/i.test(msg)) return 'Please confirm your email first (check your inbox), then sign in.';
  if (/duplicate key.*username/i.test(msg) || /profiles_username_key/.test(msg)) return 'That username is taken.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Can't reach the server. Check your internet connection.";
  return msg;
}
