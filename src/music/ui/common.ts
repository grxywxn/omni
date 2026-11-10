import { h, icon, closePopover, type Child } from '../../core/dom';
import { go, openUri } from '../library';
import type { Image } from '../api';
import { bestImage } from '../api';

// ---- Extra icons used by the music UI --------------------------------------------
const MUSIC_ICONS: Record<string, string> = {
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5.5v13a1 1 0 0 0 1.55.83L16 13v5.5h2.5v-13H16V11L6.55 4.67A1 1 0 0 0 5 5.5z" fill="currentColor" stroke="none"/>',
  prev: '<path d="M19 5.5v13a1 1 0 0 1-1.55.83L8 13v5.5H5.5v-13H8V11l9.45-6.33A1 1 0 0 1 19 5.5z" fill="currentColor" stroke="none"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>',
  heartFill: '<path fill="currentColor" d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  volumeLow: '<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m23 9-6 6M17 9l6 6"/>',
  queue: '<path d="M3 6h13M3 12h13M3 18h9M17 15v6l5-3z"/>',
  devices: '<rect x="2" y="4" width="13" height="10" rx="1.5"/><path d="M6 18h5M8.5 14v4"/><rect x="17" y="8" width="5" height="12" rx="1"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  forward: '<path d="m9 18 6-6-6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
  grip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  library: '<path d="M4 4v16M9 4v16M14 4l5 16"/>',
};

export function micon(name: string, size = 18): SVGSVGElement {
  if (!MUSIC_ICONS[name]) return icon(name, size);
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MUSIC_ICONS[name]}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

/** Album / playlist art with a graceful placeholder. */
export function art(images: Image[] | null | undefined | string, size: number, cls = ''): HTMLElement {
  const url = typeof images === 'string' ? images : bestImage(images, size);
  return url
    ? h('img', { class: `art ${cls}`, src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', style: { width: `${size}px`, height: `${size}px` } })
    : h('span', { class: `art art-empty ${cls}`, style: { width: `${size}px`, height: `${size}px` } }, micon('music', Math.round(size * 0.4)));
}

/** Comma-separated clickable artist names. */
export function artistLinks(artists: Array<{ name: string; uri: string }>): HTMLElement {
  const el = h('span', { class: 'artist-links' });
  artists.forEach((a, i) => {
    if (i) el.append(', ');
    el.append(h('button', { class: 'text-link', onclick: (e: Event) => { e.stopPropagation(); openUri(a.uri); } }, a.name));
  });
  return el;
}

export function card(opts: { image?: Image[] | null | string; title: string; subtitle?: string; round?: boolean; onOpen: () => void; onPlay?: () => void }): HTMLElement {
  return h(
    'div',
    { class: `mcard ${opts.round ? 'round' : ''}`, role: 'button', tabindex: '0', onclick: opts.onOpen, onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && opts.onOpen() },
    h(
      'div',
      { class: 'mcard-art' },
      art(opts.image, 180),
      opts.onPlay
        ? h('button', { class: 'play-fab', 'aria-label': `Play ${opts.title}`, onclick: (e: Event) => { e.stopPropagation(); opts.onPlay!(); } }, micon('play', 20))
        : null,
    ),
    h('div', { class: 'mcard-title', title: opts.title }, opts.title),
    opts.subtitle ? h('div', { class: 'mcard-sub' }, opts.subtitle) : null,
  );
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'msection' }, h('h2', null, title), ...children);
}

// ---- Context menus ----------------------------------------------------------------
export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  run: () => void;
}

let openMenu: HTMLElement | null = null;
export function contextMenu(x: number, y: number, items: Array<MenuItem | 'sep'>): void {
  closePopover();
  openMenu?.remove();
  const el = h(
    'div',
    { class: 'menu ctx-menu', role: 'menu' },
    items.map((it) =>
      it === 'sep'
        ? h('div', { class: 'menu-sep' })
        : h('button', { class: `menu-item ${it.danger ? 'danger' : ''}`, role: 'menuitem', onclick: () => { close(); it.run(); } }, it.icon ? micon(it.icon, 16) : null, it.label),
    ),
  );
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  el.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  openMenu = el;
  const close = () => {
    el.remove();
    if (openMenu === el) openMenu = null;
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey);
  };
  const onDown = (e: MouseEvent) => !el.contains(e.target as Node) && close();
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
  });
}

export const spotifyLink = (uri: string) => {
  const [, type, id] = uri.split(':');
  return `https://open.spotify.com/${type}/${id}`;
};

export { go };
