import type { RealtimeChannel } from '@supabase/supabase-js';
import { sb } from './supabase';
import { Store } from '../core/store';
import { settings } from '../core/settings';
import { me } from './profiles';
import type { PresencePref, PresenceStatus } from './types';

/** Live online state of other members (absent = offline). */
export const presence = new Store<Map<string, PresenceStatus>>(new Map());
/** True when you've been inactive longer than the idle timeout. */
export const autoIdle = new Store<boolean>(false);

let channel: RealtimeChannel | null = null;
let userId = '';
let lastActivity = Date.now();
let idleTimer: ReturnType<typeof setInterval> | null = null;
let unsubs: Array<() => void> = [];

function effective(pref: PresencePref): PresenceStatus {
  if (pref === 'online' && autoIdle.get()) return 'idle';
  return pref;
}

/** What to show for a given member (handles "invisible" for yourself). */
export function statusOf(id: string): PresenceStatus {
  if (id === userId) {
    const p = me.get();
    return p ? effective(p.presence_pref) : 'offline';
  }
  return presence.get().get(id) ?? 'offline';
}

async function track(): Promise<void> {
  if (!channel) return;
  const p = me.get();
  if (!p) return;
  const status = effective(p.presence_pref);
  if (status === 'invisible') await channel.untrack();
  else await channel.track({ status, at: Date.now() });
}

const onActivity = () => {
  lastActivity = Date.now();
  if (autoIdle.get()) autoIdle.set(false);
};

export function startPresence(id: string): void {
  stopPresence();
  userId = id;
  channel = sb().channel('omni-presence', { config: { presence: { key: id } } });
  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel!.presenceState<{ status: PresenceStatus; at: number }>();
      const map = new Map<string, PresenceStatus>();
      for (const [key, metas] of Object.entries(state)) {
        // Same account on two PCs: take the most recent.
        const latest = [...metas].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
        if (latest) map.set(key, latest.status);
      }
      presence.set(map);
    })
    .subscribe((s) => {
      if (s === 'SUBSCRIBED') void track();
    });

  // Re-announce when you change status or go idle/active.
  let lastPref = me.get()?.presence_pref;
  unsubs.push(
    me.subscribe((p) => {
      if (p && p.presence_pref !== lastPref) {
        lastPref = p.presence_pref;
        void track();
      }
    }, false),
    autoIdle.subscribe(() => void track(), false),
  );

  for (const ev of ['mousemove', 'keydown', 'mousedown', 'wheel'] as const) {
    window.addEventListener(ev, onActivity, { passive: true });
  }
  idleTimer = setInterval(() => {
    const mins = settings.get().idleMinutes;
    if (mins > 0 && !autoIdle.get() && Date.now() - lastActivity > mins * 60_000) autoIdle.set(true);
  }, 30_000);
}

export function stopPresence(): void {
  unsubs.forEach((u) => u());
  unsubs = [];
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  for (const ev of ['mousemove', 'keydown', 'mousedown', 'wheel'] as const) {
    window.removeEventListener(ev, onActivity);
  }
  if (channel) {
    void channel.untrack();
    void channel.unsubscribe();
  }
  channel = null;
  presence.set(new Map());
}
