import { h, timeAgo } from '../core/dom';
import { activeStatus, BADGES, type Profile, type PresenceStatus } from '../lib/types';
import { avatar, nameTag } from './avatar';

/** Discord-style profile card. Used for previews, popovers and the home page. */
export function profileCard(p: Profile, status: PresenceStatus | null, opts: { compact?: boolean } = {}): HTMLElement {
  const st = activeStatus(p);
  const banner = h('div', {
    class: 'pcard-banner',
    style: {
      background: p.banner_url ? `center / cover no-repeat url("${encodeURI(p.banner_url)}")` : p.banner_color,
    },
  });

  return h(
    'article',
    {
      class: `pcard ${opts.compact ? 'compact' : ''}`,
      style: { '--p1': p.theme_primary, '--p2': p.theme_accent },
    },
    p.profile_effect !== 'none' ? h('div', { class: `pfx pfx-${p.profile_effect}`, 'aria-hidden': 'true' }) : null,
    banner,
    h(
      'div',
      { class: 'pcard-top' },
      h('div', { class: 'pcard-avatar' }, avatar(p, 84, status)),
      p.badges.length
        ? h(
            'div',
            { class: 'pcard-badges' },
            p.badges.filter((b) => BADGES[b]).map((b) => h('span', { class: 'badge', title: BADGES[b].label }, BADGES[b].emoji)),
          )
        : null,
    ),
    h(
      'div',
      { class: 'pcard-body' },
      h('div', { class: 'pcard-name' }, nameTag(p)),
      h('div', { class: 'pcard-sub' }, `@${p.username}`, p.pronouns ? h('span', null, ` · ${p.pronouns}`) : null),
      st ? h('div', { class: 'pcard-status' }, st.emoji ? h('span', { class: 'emoji' }, st.emoji) : null, st.text ? h('span', null, st.text) : null) : null,
      p.now_playing
        ? h(
            'div',
            { class: 'pcard-section' },
            h('div', { class: 'pcard-label' }, 'Listening to Spotify'),
            h('div', { class: 'pcard-np' }, h('strong', null, p.now_playing.title), h('span', null, p.now_playing.artist)),
          )
        : null,
      p.bio && !opts.compact ? h('div', { class: 'pcard-section' }, h('div', { class: 'pcard-label' }, 'About me'), h('p', { class: 'pcard-bio' }, p.bio)) : null,
      !opts.compact ? h('div', { class: 'pcard-section' }, h('div', { class: 'pcard-label' }, 'Member since'), h('div', null, timeAgo(p.created_at))) : null,
    ),
  );
}
