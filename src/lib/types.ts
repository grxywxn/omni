export type PresencePref = 'online' | 'idle' | 'dnd' | 'invisible';
/** What other people see. `invisible` only ever shows for yourself. */
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';

export type NameEffect = 'none' | 'gradient' | 'glow' | 'rainbow';
export type AvatarDecoration = 'none' | 'halo' | 'neon' | 'rainbow' | 'gold' | 'orbit';
export type ProfileEffect = 'none' | 'sparkle' | 'snow' | 'aurora';

export interface NowPlaying {
  title: string;
  artist: string;
  art?: string;
  url?: string;
}

export interface Profile {
  id: string;
  username: string;
  display_name: string | null;
  pronouns: string | null;
  bio: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  banner_color: string;
  theme_primary: string;
  theme_accent: string;
  name_color: string;
  name_effect: NameEffect;
  avatar_decoration: AvatarDecoration;
  profile_effect: ProfileEffect;
  presence_pref: PresencePref;
  status_emoji: string | null;
  status_text: string | null;
  status_expires_at: string | null;
  now_playing: NowPlaying | null;
  app_theme: unknown;
  badges: string[];
  created_at: string;
  updated_at: string;
}

export type EditableProfile = Partial<
  Pick<
    Profile,
    | 'username' | 'display_name' | 'pronouns' | 'bio' | 'avatar_url' | 'banner_url' | 'banner_color'
    | 'theme_primary' | 'theme_accent' | 'name_color' | 'name_effect' | 'avatar_decoration'
    | 'profile_effect' | 'presence_pref' | 'status_emoji' | 'status_text' | 'status_expires_at'
    | 'now_playing' | 'app_theme'
  >
>;

export const BADGES: Record<string, { emoji: string; label: string }> = {
  founder: { emoji: '👑', label: 'Founder' },
  early: { emoji: '🌱', label: 'Early member' },
  creator: { emoji: '🎬', label: 'Creator' },
  dev: { emoji: '🛠️', label: 'Developer' },
};

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  invisible: 'Invisible',
  offline: 'Offline',
};

export function activeStatus(p: Profile): { emoji: string | null; text: string | null } | null {
  if (!p.status_emoji && !p.status_text) return null;
  if (p.status_expires_at && new Date(p.status_expires_at).getTime() < Date.now()) return null;
  return { emoji: p.status_emoji, text: p.status_text };
}

export const displayName = (p: Pick<Profile, 'display_name' | 'username'>) => p.display_name?.trim() || p.username;
