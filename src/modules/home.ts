import { h, icon } from '../core/dom';
import { Disposer } from '../core/store';
import { me, members } from '../lib/profiles';
import { presence, statusOf } from '../lib/presence';
import { activeStatus, displayName } from '../lib/types';
import { profileCard } from '../ui/profile-card';
import { avatar, nameTag } from '../ui/avatar';
import { navigate, openProfile } from '../ui/shell';
import type { ModuleId } from '../core/settings';

const TILES: Array<{ id: ModuleId; icon: string; title: string; text: string; phase?: string }> = [
  { id: 'recorder', icon: 'mic', title: 'Recorder', text: 'Multi-track voice recording with presets & AI noise removal.', phase: 'Phase 2' },
  { id: 'notes', icon: 'notes', title: 'Notes', text: 'Markdown vault with Notion, Word, Scrivener & Campfire tools.', phase: 'Phase 3' },
  { id: 'music', icon: 'music', title: 'Music', text: 'Your Spotify library in a lighter, fully themeable player.', phase: 'Phase 4' },
];

function greeting(): string {
  const hr = new Date().getHours();
  return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}

export function mount(el: HTMLElement): () => void {
  const d = new Disposer();
  const left = h('div', { class: 'home-main' });
  const right = h('div', { class: 'home-side' });
  el.append(h('div', { class: 'home' }, left, right));

  const render = () => {
    const p = me.get();
    if (!p) return;
    const others = [...members.get().values()].filter((m) => m.id !== p.id);
    const online = others.filter((m) => !['offline', 'invisible'].includes(statusOf(m.id)));

    left.replaceChildren(
      h('h1', { class: 'home-title' }, `${greeting()}, `, nameTag(p)),
      h('p', { class: 'muted' }, 'Everything in one place. Press ', h('kbd', null, 'Ctrl K'), ' any time to jump around.'),
      h(
        'div',
        { class: 'tiles' },
        TILES.map((t) =>
          h(
            'button',
            { class: 'tile', onclick: () => navigate(t.id) },
            h('span', { class: 'tile-icon' }, icon(t.icon, 22)),
            h('span', { class: 'tile-title' }, t.title, t.phase ? h('span', { class: 'pill' }, t.phase) : null),
            h('span', { class: 'tile-text' }, t.text),
          ),
        ),
      ),
      h('h2', null, `Online now — ${online.length}`),
      online.length
        ? h(
            'div',
            { class: 'online-grid' },
            online.map((m) => {
              const st = activeStatus(m);
              const b: HTMLElement = h(
                'button',
                { class: 'online-card', onclick: () => openProfile(m, b) },
                avatar(m, 48, statusOf(m.id)),
                h('span', { class: 'online-card-text' }, h('strong', null, displayName(m)), h('span', { class: 'muted' }, m.now_playing ? `🎧 ${m.now_playing.title}` : st ? `${st.emoji ?? ''} ${st.text ?? ''}` : '')),
              );
              return b;
            }),
          )
        : h('p', { class: 'muted' }, others.length ? 'Nobody else is online right now.' : 'Invite friends from Settings → Invites to see them here.'),
    );
    right.replaceChildren(
      profileCard(p, statusOf(p.id)),
      h('button', { class: 'secondary wide', onclick: () => navigate('settings', 'profile') }, 'Edit profile'),
    );
  };
  d.add(me.subscribe(render));
  d.add(members.subscribe(render, false));
  d.add(presence.subscribe(render, false));
  return () => d.dispose();
}
