import { h } from '../core/dom';
import { displayName, type Profile, type PresenceStatus, PRESENCE_LABEL } from '../lib/types';

function initials(p: Pick<Profile, 'display_name' | 'username'>): string {
  const n = displayName(p).trim();
  const parts = n.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Avatar with optional decoration frame and presence dot. */
export function avatar(
  p: Pick<Profile, 'display_name' | 'username' | 'avatar_url' | 'avatar_decoration' | 'theme_accent' | 'name_color'>,
  size: number,
  status?: PresenceStatus | null,
  opts: { decoration?: boolean } = {},
): HTMLElement {
  const deco = opts.decoration === false ? 'none' : p.avatar_decoration;
  const img = p.avatar_url
    ? h('img', { class: 'avatar-img', src: p.avatar_url, alt: '', draggable: 'false', loading: 'lazy', decoding: 'async' })
    : h('span', { class: 'avatar-fallback', style: { background: p.theme_accent } }, initials(p));
  return h(
    'span',
    {
      class: `avatar deco-${deco}`,
      style: { '--size': `${size}px`, '--deco-a': p.theme_accent, '--deco-b': p.name_color },
    },
    img,
    status ? h('span', { class: `presence-dot ${status}`, title: PRESENCE_LABEL[status], 'aria-label': PRESENCE_LABEL[status] }) : null,
  );
}

/** Display name with the member's chosen name effect. */
export function nameTag(p: Pick<Profile, 'display_name' | 'username' | 'name_effect' | 'theme_accent' | 'name_color'>, cls = ''): HTMLElement {
  return h(
    'span',
    { class: `name-tag name-fx-${p.name_effect} ${cls}`, style: { '--n1': p.theme_accent, '--n2': p.name_color } },
    displayName(p),
  );
}
