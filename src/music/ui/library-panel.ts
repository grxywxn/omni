import { h } from '../../core/dom';
import { Disposer } from '../../core/store';
import { library, musicRoute, go, ownsPlaylist } from '../library';
import { player, playContext } from '../player';
import { musicPrefs } from '../prefs';
import { playlistTotal } from '../api';
import { art, contextMenu, micon } from './common';
import { playlistDialog, removePlaylist } from './dialogs';

type Filter = 'all' | 'mine' | 'followed' | 'albums';

export function libraryPanel(): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  let filter: Filter = 'all';
  const search = h('input', { class: 'lib-search', placeholder: 'Search your library' });
  const chips = h('div', { class: 'chips small' });
  const list = h('div', { class: 'lib-list' });

  const el = h(
    'aside',
    { class: 'lib-panel' },
    h(
      'div',
      { class: 'lib-head' },
      h('span', { class: 'lib-title' }, micon('library', 18), 'Your Library'),
      h('button', { class: 'icon-btn', title: 'New playlist', onclick: () => playlistDialog(null) }, micon('plus', 18)),
    ),
    chips,
    search,
    list,
  );

  const paintChips = () => {
    const opts: Array<[Filter, string]> = [['all', 'All'], ['mine', 'Made by you'], ['followed', 'Followed'], ['albums', 'Albums']];
    chips.replaceChildren(...opts.map(([v, l]) => h('button', { class: `chip ${filter === v ? 'active' : ''}`, onclick: () => { filter = v; paintChips(); render(); } }, l)));
  };

  const render = () => {
    const lib = library.get();
    const r = musicRoute.get();
    const q = search.value.trim().toLowerCase();
    const showArt = musicPrefs.get().showLibraryArt;
    const ctx = player.get().contextUri;
    const playingCtx = player.get().playing ? ctx : null;
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    const items: HTMLElement[] = [];

    const row = (opts: { active: boolean; playing: boolean; image: Parameters<typeof art>[0] | null; special?: HTMLElement; title: string; sub: string; onOpen: () => void; onPlay: () => void; onMenu?: (e: MouseEvent) => void }) =>
      h(
        'button',
        {
          class: `lib-item ${opts.active ? 'active' : ''} ${opts.playing ? 'playing' : ''}`,
          onclick: opts.onOpen,
          ondblclick: opts.onPlay,
          oncontextmenu: opts.onMenu ? (e: MouseEvent) => { e.preventDefault(); opts.onMenu!(e); } : undefined,
        },
        showArt ? opts.special ?? art(opts.image, 44) : null,
        h('span', { class: 'lib-text' }, h('span', { class: 'lib-name' }, opts.title), h('span', { class: 'lib-sub' }, opts.sub)),
        opts.playing ? h('span', { class: 'eq small' }, h('i'), h('i'), h('i')) : null,
      );

    if ((filter === 'all' || filter === 'mine') && match('Liked Songs')) {
      const uri = lib.me ? `spotify:user:${lib.me.id}:collection` : '';
      items.push(row({ active: r.view === 'liked', playing: !!uri && playingCtx === uri, image: null, special: h('span', { class: 'art liked-art', style: 'width:44px;height:44px' }, micon('heartFill', 18)), title: 'Liked Songs', sub: 'Playlist', onOpen: () => go({ view: 'liked' }), onPlay: () => uri && void playContext(uri) }));
    }
    if (filter !== 'albums') {
      for (const p of lib.playlists) {
        const mine = ownsPlaylist(p);
        if (filter === 'mine' && !mine) continue;
        if (filter === 'followed' && mine) continue;
        if (!match(p.name)) continue;
        items.push(
          row({
            active: r.view === 'playlist' && r.id === p.id,
            playing: playingCtx === p.uri,
            image: p.images,
            title: p.name,
            sub: `Playlist • ${mine ? `${playlistTotal(p)} songs` : p.owner.display_name ?? p.owner.id}`,
            onOpen: () => go({ view: 'playlist', id: p.id }),
            onPlay: () => void playContext(p.uri),
            onMenu: (e) =>
              contextMenu(e.clientX, e.clientY, [
                { label: 'Play', icon: 'play', run: () => void playContext(p.uri) },
                ...(p.owner.id === lib.me?.id ? [{ label: 'Edit details', icon: 'edit', run: () => playlistDialog(p) }] : []),
                'sep',
                { label: p.owner.id === lib.me?.id ? 'Delete playlist' : 'Remove from library', icon: 'trash', danger: true, run: () => void removePlaylist(p) },
              ]),
          }),
        );
      }
    }
    if (filter === 'all' || filter === 'albums') {
      for (const a of lib.albums) {
        if (!match(a.name)) continue;
        items.push(row({ active: r.view === 'album' && r.id === a.id, playing: playingCtx === a.uri, image: a.images, title: a.name, sub: `Album • ${a.artists?.map((x) => x.name).join(', ') ?? ''}`, onOpen: () => go({ view: 'album', id: a.id }), onPlay: () => void playContext(a.uri) }));
      }
    }
    if (lib.loading && !items.length) list.replaceChildren(h('div', { class: 'muted pad' }, 'Loading your library…'));
    else if (lib.error) list.replaceChildren(h('div', { class: 'form-error pad' }, lib.error));
    else list.replaceChildren(...(items.length ? items : [h('div', { class: 'muted pad' }, q ? 'Nothing matches.' : 'Nothing here yet.')]));
  };

  search.addEventListener('input', render);
  paintChips();
  d.add(library.subscribe(render));
  d.add(musicRoute.subscribe(render, false));
  let lastKey = '';
  d.add(player.subscribe((s) => {
    const key = `${s.contextUri}|${s.playing}`;
    if (key !== lastKey) { lastKey = key; render(); }
  }, false));
  d.add(musicPrefs.subscribe(render, false));

  return { el, dispose: () => d.dispose() };
}
