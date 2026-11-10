import '../music/music.css';
import { h } from '../core/dom';
import { Disposer } from '../core/store';
import { spotifyConnected } from '../music/auth';
import { startPlayer, togglePlay, next, previous, sdkStatus } from '../music/player';
import { loadLibrary, musicRoute, go, goBack, goForward, canGoBack, canGoForward, library } from '../music/library';
import { musicPrefs } from '../music/prefs';
import { viewFor, type View } from '../music/ui/views';
import { libraryPanel } from '../music/ui/library-panel';
import { playerBar, miniPlayer } from '../music/ui/playerbar';
import { setupScreen, openMusicSettings } from '../music/ui/setup';
import { micon } from '../music/ui/common';
import { bindTintRoot } from '../music/ui/tint';

let miniMounted = false;

/** The sidebar mini-player lives for the rest of the session once music has started. */
function mountMini(): void {
  if (miniMounted) return;
  const slot = document.querySelector('.mini-player-slot');
  if (!slot) return;
  miniMounted = true;
  slot.appendChild(miniPlayer());
}

export function mount(el: HTMLElement): () => void {
  const d = new Disposer();
  let inner: Disposer | null = null;

  const render = (connected: boolean) => {
    inner?.dispose();
    inner = new Disposer();
    if (!connected) {
      el.replaceChildren(h('div', { class: 'music-root setup' }, setupScreen()));
      return;
    }
    startPlayer();
    mountMini();
    if (!library.get().me) void loadLibrary();
    el.replaceChildren(app(inner));
  };

  d.add(spotifyConnected.subscribe((c) => render(c)));
  d.add(() => inner?.dispose());
  return () => d.dispose();
}

function app(d: Disposer): HTMLElement {
  const main = h('div', { class: 'music-main' });
  const lib = libraryPanel();
  const bar = playerBar();
  d.add(lib.dispose);
  d.add(bar.dispose);

  const backBtn = h('button', { class: 'icon-btn round', title: 'Back (Alt+←)', onclick: () => goBack() }, micon('back', 18));
  const fwdBtn = h('button', { class: 'icon-btn round', title: 'Forward (Alt+→)', onclick: () => goForward() }, micon('forward', 18));
  const searchBtn = h('button', { class: 'msearch-btn', onclick: () => go({ view: 'search' }) }, micon('search', 16), h('span', null, 'Search'), h('kbd', null, 'Ctrl F'));
  const homeBtn = h('button', { class: 'icon-btn round', title: 'Music home', onclick: () => go({ view: 'home' }) }, micon('home', 18));
  const notice = h('div', { class: 'sdk-notice', hidden: true });

  const top = h(
    'div',
    { class: 'music-top' },
    backBtn,
    fwdBtn,
    homeBtn,
    searchBtn,
    h('div', { class: 'spacer' }),
    h('button', { class: 'icon-btn round', title: 'Music settings', onclick: () => openMusicSettings() }, micon('settings', 18)),
  );

  const root = h('div', { class: 'music-root' }, top, notice, h('div', { class: 'music-body' }, lib.el, main), bar.el);
  bindTintRoot(root);
  d.add(() => bindTintRoot(null));

  // ---- Page routing --------------------------------------------------------------
  let view: View | null = null;
  d.add(musicRoute.subscribe((r) => {
    view?.dispose();
    view = viewFor(r);
    main.replaceChildren(view.el);
    main.scrollTop = 0;
    backBtn.disabled = !canGoBack();
    fwdBtn.disabled = !canGoForward();
    searchBtn.classList.toggle('active', r.view === 'search');
  }));
  d.add(() => view?.dispose());

  // ---- Appearance preferences ----------------------------------------------------
  d.add(musicPrefs.subscribe((p) => {
    root.dataset.player = p.playerPosition;
    root.dataset.playerStyle = p.playerStyle;
    root.dataset.art = p.artShape;
    root.style.setProperty('--lib-w', `${p.libraryWidth}px`);
    if (!p.dynamicColor) root.style.removeProperty('--tint');
  }));

  d.add(sdkStatus.subscribe((s) => {
    notice.hidden = !(s.status === 'unsupported' || s.status === 'error');
    notice.textContent = s.message ?? '';
  }));

  // ---- Keyboard ------------------------------------------------------------------
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected || root.closest('[hidden]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
    if (e.code === 'Space' && !typing && !e.ctrlKey) { e.preventDefault(); void togglePlay(); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); go({ view: 'search' }); }
    else if (e.ctrlKey && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); void next(); }
    else if (e.ctrlKey && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); void previous(); }
  };
  window.addEventListener('keydown', onKey);
  d.add(() => window.removeEventListener('keydown', onKey));

  // Drag the library edge to resize it.
  const grip = h('div', { class: 'lib-resize', title: 'Drag to resize' });
  lib.el.appendChild(grip);
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = musicPrefs.get().libraryWidth;
    const move = (ev: MouseEvent) => root.style.setProperty('--lib-w', `${Math.max(200, Math.min(460, startW + ev.clientX - startX))}px`);
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      musicPrefs.update((p) => ({ ...p, libraryWidth: Math.max(200, Math.min(460, startW + ev.clientX - startX)) }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  return root;
}
