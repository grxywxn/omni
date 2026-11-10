import type { RealtimeChannel } from '@supabase/supabase-js';
import { sb, friendlyError } from './supabase';
import { Store } from '../core/store';
import type { EditableProfile, Profile } from './types';

/** Every member's profile, keyed by user id. Small group, so we keep them all. */
export const members = new Store<Map<string, Profile>>(new Map());
/** The signed-in user's profile. */
export const me = new Store<Profile | null>(null);

let channel: RealtimeChannel | null = null;

export async function loadProfiles(userId: string): Promise<void> {
  // The sign-up trigger creates the profile; retry briefly in case we're a split-second early.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await sb().from('profiles').select('*').order('created_at');
    if (error) throw new Error(friendlyError(error));
    const map = new Map<string, Profile>((data as Profile[]).map((p) => [p.id, p]));
    if (map.has(userId)) {
      members.set(map);
      me.set(map.get(userId)!);
      return;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error('Your profile could not be found. Did the database setup (schema.sql) run?');
}

/** Live profile changes from everyone (status, avatar, name…). */
export function watchProfiles(userId: string): void {
  channel?.unsubscribe();
  channel = sb()
    .channel('profiles-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
      const map = new Map(members.get());
      if (payload.eventType === 'DELETE') {
        map.delete((payload.old as Profile).id);
      } else {
        const p = payload.new as Profile;
        map.set(p.id, p);
        if (p.id === userId) me.set(p);
      }
      members.set(map);
    })
    .subscribe();
}

export function stopWatchingProfiles(): void {
  channel?.unsubscribe();
  channel = null;
  members.set(new Map());
  me.set(null);
}

export async function updateProfile(patch: EditableProfile): Promise<Profile> {
  const current = me.get();
  if (!current) throw new Error('Not signed in');
  if (patch.username !== undefined) patch.username = patch.username.trim().toLowerCase();
  const { data, error } = await sb().from('profiles').update(patch).eq('id', current.id).select('*').single();
  if (error) throw new Error(friendlyError(error));
  const p = data as Profile;
  me.set(p);
  const map = new Map(members.get());
  map.set(p.id, p);
  members.set(map);
  return p;
}

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_UPLOAD_MB = 8;

/** Upload an avatar or banner (GIFs allowed) and return its public URL. */
export async function uploadProfileImage(kind: 'avatar' | 'banner', file: File): Promise<string> {
  const current = me.get();
  if (!current) throw new Error('Not signed in');
  if (!ALLOWED.includes(file.type)) throw new Error('Use a PNG, JPG, WebP or GIF image.');
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`Images must be under ${MAX_UPLOAD_MB} MB.`);
  const path = `${current.id}/${kind}`;
  const bucket = sb().storage.from('profile-media');
  const { error } = await bucket.upload(path, file, { upsert: true, contentType: file.type, cacheControl: '3600' });
  if (error) throw new Error(friendlyError(error));
  const { data } = bucket.getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

export interface Invite {
  code: string;
  max_uses: number;
  uses: number;
  created_at: string;
}

export async function createInvite(maxUses: number): Promise<string> {
  const { data, error } = await sb().rpc('create_invite', { p_max_uses: maxUses });
  if (error) throw new Error(friendlyError(error));
  return String(data);
}

export async function listInvites(): Promise<Invite[]> {
  const { data, error } = await sb().rpc('list_my_invites');
  if (error) throw new Error(friendlyError(error));
  return (data ?? []) as Invite[];
}
