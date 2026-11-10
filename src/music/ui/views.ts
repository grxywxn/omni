import { h, toast } from '../../core/dom';
import { Disposer, debounce } from '../../core/store';
import { api, bestImage, entryTrack, fmtTime, playlistTotal, SpotifyError, type Album, type Playlist, type Track } from '../api';
import { library, ownsPlaylist, go, reloadView, type MusicRoute } from '../library';
import { player, playContext, playTracks, shufflePlay } from '../player';
import { art, artistLinks, card, micon, section } from './common';
import { trackList, type TrackRow } from './tracklist';
import { playlistDialog, removePlaylist, decodeHtml } from './dialogs';
import { setTint } from './tint';


export interface View {
  el: HTMLElement;
  dispose: () => void;
}

/** Big header used by playlist / album / artist / liked pages. */
function header(opts: {
  image?: string;
  round?: boolean;
  kind: string;
  title: string;
  description?: string | null;
  meta: Array<string | HTMLElement | null>;
  actions: HTMLElement[];
  gradient?: string;
}): HTMLElement {
  if (opts.image) setTint(opts.image);
  return h(
    'header',
    { class: 'mheader' },
    h(
      'div',
      { class: 'mheader-main' },
      opts.image
        ? h('img', { class: `mheader-art ${opts.round ? 'round' : ''}`, src: opts.image, alt: '' })
        : h('div', { class: 'mheader-art art-empty', style: opts.gradient ? { background: opts.gradient } : undefined }, micon(opts.kind === 'Playlist' ? 'music' : 'heartFill', 64)),
      h(
        'div',
        { class: 'mheader-text' },
        h('span', { class: 'mheader-kind' }, opts.kind),
        h('h1', { class: 'mheader-title' }, opts.title),
        opts.description ? h('p', { class: 'mheader-desc' }, decodeHtml(opts.description).replace(/<[^>]+>/g, '')) : null,
        h('div', { class: 'mheader-meta' }, ...opts.meta.filter(Boolean).flatMap((m, i) => (i ? [h('span', { class: 'dot' }, '•'), m!] : [m!]))),
      ),
    ),
    h('div', { class: 'mheader-actions' }, ...opts.actions),
  );
}

function playButton(d: Disposer, onclick: () => void, contextUri?: string): HTMLElement {
  const btn = h('button', { class: 'big-play', 'aria-label': 'Play', onclick: () => onclick() }, micon('play', 24));
  // Turns into a pause button when this context is playing.
  if (contextUri) {
    const paint = () => {
      const s = player.get();
      const here = s.contextUri === contextUri && s.playing;
      btn.replaceChildren(micon(here ? 'pause' : 'play', 24));
    };
    d.add(player.subscribe(paint));
  }
  return btn;
}

function loading(): HTMLElement {
  return h('div', { class: 'mloading' }, h('span', { class: 'spinner' }), 'Loading…');
}

function errorBox(e: unknown, retry?: () => void): HTMLElement {
  return h('div', { class: 'empty' }, (e as Error).message, retry ? h('div', null, h('button', { class: 'secondary', onclick: retry }, 'Try again')) : null);
}

/** Async view helper: shows a spinner, then the rendered result. */
function asyncView(build: (d: Disposer) => Promise<HTMLElement>): View {
  const d = new Disposer();
  const el = h('div', { class: 'mview' }, loading());
  let alive = true;
  d.add(() => (alive = false));
  const load = () => {
    el.replaceChildren(loading());
    build(d)
      .then((content) => alive && el.replaceChildren(content))
      .catch((e) => alive && el.replaceChildren(errorBox(e, load)));
  };
  load();
  return { el, dispose: () => d.dispose() };
}

const toRows = (tracks: Track[], album?: Album): TrackRow[] =>
  tracks.filter(Boolean).map((t) => ({ track: album && !t.album ? { ...t, album } : t }));

// ---- Home -----------------------------------------------------------------------
function homeView(): View {
  return asyncView(async (d) => {
    setTint(null);
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const [recent, top] = await Promise.all([api.recentlyPlayed().catch(() => null), api.topTracks().catch(() => null)]);
    const lib = library.get();

    const quick = h(
      'div',
      { class: 'quick-grid' },
      h('button', { class: 'quick', onclick: () => go({ view: 'liked' }) }, h('span', { class: 'quick-art liked-art' }, micon('heartFill', 22)), h('span', null, 'Liked Songs')),
      ...lib.playlists.slice(0, 7).map((p) =>
        h('button', { class: 'quick', onclick: () => go({ view: 'playlist', id: p.id }), ondblclick: () => void playContext(p.uri) }, art(p.images, 56, 'quick-art'), h('span', null, p.name)),
      ),
    );

    const seen = new Set<string>();
    const recentTracks = (recent?.items ?? []).map((i) => i.track).filter((t) => t && !seen.has(t.uri) && seen.add(t.uri));

    const out = h('div', { class: 'stack-lg' }, h('h1', { class: 'mgreet' }, greet), quick);
    if (recentTracks.length) {
      const tl = trackList({ rows: toRows(recentTracks.slice(0, 10)) });
      d.add(tl.dispose);
      out.append(section('Recently played', tl.el));
    }
    if (top?.items.length) {
      const tl = trackList({ rows: toRows(top.items.slice(0, 10)) });
      d.add(tl.dispose);
      out.append(section('Your top tracks lately', tl.el));
    }
    if (lib.playlists.length) {
      out.append(
        section(
          'Your playlists',
          h('div', { class: 'card-grid' }, lib.playlists.slice(0, 18).map((p) => card({ image: p.images, title: p.name, subtitle: `${playlistTotal(p)} songs`, onOpen: () => go({ view: 'playlist', id: p.id }), onPlay: () => void playContext(p.uri) }))),
        ),
      );
    }
    if (lib.albums.length) {
      out.append(
        section(
          'Your albums',
          h('div', { class: 'card-grid' }, lib.albums.slice(0, 12).map((a) => card({ image: a.images, title: a.name, subtitle: a.artists?.map((x) => x.name).join(', '), onOpen: () => go({ view: 'album', id: a.id }), onPlay: () => void playContext(a.uri) }))),
        ),
      );
    }
    return out;
  });
}

// ---- Liked Songs ------------------------------------------------------------------
function likedView(): View {
  return asyncView(async (d) => {
    setTint('#5038a0');
    const first = await api.likedTracks(0);
    let offset = first.items.length;
    const meId = library.get().me?.id;
    const contextUri = meId ? `spotify:user:${meId}:collection` : undefined;
    const rows: TrackRow[] = first.items.map((i) => ({ track: i.track, addedAt: i.added_at }));
    const tl = trackList({
      rows,
      contextUri,
      loadMore: async () => {
        if (offset >= first.total) return [];
        const page = await api.likedTracks(offset);
        offset += page.items.length;
        return page.items.map((i) => ({ track: i.track, addedAt: i.added_at }));
      },
    });
    d.add(tl.dispose);
    return h(
      'div',
      null,
      header({
        kind: 'Playlist',
        title: 'Liked Songs',
        gradient: 'linear-gradient(135deg, #450af5, #c4efd9)',
        meta: [library.get().me?.display_name ?? null, `${first.total} songs`],
        actions: [
          playButton(d, () => (contextUri ? void playContext(contextUri) : void playTracks(rows.map((r) => r.track.uri))), contextUri),
          contextUri ? h('button', { class: 'icon-btn big', title: 'Shuffle play', onclick: () => void shufflePlay(contextUri) }, micon('shuffle', 22)) : h('span'),
        ],
      }),
      first.total ? tl.el : h('div', { class: 'empty' }, 'Songs you like will appear here. Tap the ♡ on any song.'),
    );
  });
}

// ---- Playlist ---------------------------------------------------------------------
function playlistView(id: string): View {
  return asyncView(async (d) => {
    const p = await api.playlist(id);
    const owned = ownsPlaylist(p);
    const total = playlistTotal(p);
    const hero = bestImage(p.images, 300);

    let listEl: HTMLElement;
    if (owned) {
      const first = await api.playlistItems(id, 0);
      let offset = first.items.length;
      const mapRows = (items: typeof first.items): TrackRow[] =>
        items.map((e) => ({ track: entryTrack(e)!, addedAt: e.added_at })).filter((r) => r.track && r.track.type !== 'episode');
      const tl = trackList({
        rows: mapRows(first.items),
        contextUri: p.uri,
        playlistId: p.owner.id === library.get().me?.id || p.collaborative ? p.id : undefined,
        snapshotId: p.snapshot_id,
        loadMore: async () => {
          if (offset >= first.total) return [];
          const page = await api.playlistItems(id, offset);
          offset += page.items.length;
          return mapRows(page.items);
        },
      });
      d.add(tl.dispose);
      listEl = total ? tl.el : h('div', { class: 'empty' }, 'This playlist is empty. Right-click any song and choose “Add to playlist…”.');
    } else {
      listEl = h(
        'div',
        { class: 'note playlist-locked' },
        h('strong', null, 'Spotify only lets apps list songs in playlists you own or collaborate on.'),
        h('p', null, 'You can still play and shuffle this playlist — the player shows each song as it plays. To browse its songs in Omni, save a copy: open it in Spotify and choose “Add to other playlist”, or ask the owner to make you a collaborator.'),
      );
    }

    const onChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.id === id) reloadView();
    };
    window.addEventListener('omni:playlist-changed', onChanged);
    d.add(() => window.removeEventListener('omni:playlist-changed', onChanged));

    const actions: HTMLElement[] = [
      playButton(d, () => void playContext(p.uri), p.uri),
      h('button', { class: 'icon-btn big', title: 'Shuffle play', onclick: () => void shufflePlay(p.uri) }, micon('shuffle', 22)),
    ];
    if (p.owner.id === library.get().me?.id) actions.push(h('button', { class: 'icon-btn big', title: 'Edit details', onclick: () => playlistDialog(p) }, micon('edit', 20)));
    const inLibrary = library.get().playlists.some((x) => x.id === p.id);
    if (inLibrary) actions.push(h('button', { class: 'icon-btn big', title: p.owner.id === library.get().me?.id ? 'Delete playlist' : 'Remove from library', onclick: () => void removePlaylist(p) }, micon('trash', 20)));
    else
      actions.push(
        h('button', { class: 'secondary', onclick: async () => {
          try {
            await api.saveToLibrary([p.uri]);
            toast('Saved to your library', 'success');
            library.update((l) => ({ ...l, playlists: [p, ...l.playlists] }));
          } catch (e) { toast((e as Error).message, 'error'); }
        } }, micon('plus', 16), 'Save to library'),
      );

    return h(
      'div',
      null,
      header({
        image: hero,
        kind: p.public ? 'Public playlist' : p.collaborative ? 'Collaborative playlist' : 'Playlist',
        title: p.name,
        description: p.description,
        meta: [p.owner.display_name ?? p.owner.id, total ? `${total} songs` : null],
        actions,
      }),
      listEl,
    );
  });
}

// ---- Album ------------------------------------------------------------------------
function albumView(id: string): View {
  return asyncView(async (d) => {
    const a = await api.album(id);
    let tracks = a.tracks.items;
    let next = a.tracks.next;
    while (next && tracks.length < 500) {
      const page = await api.albumTracks(id, tracks.length);
      tracks = tracks.concat(page.items);
      next = page.next;
    }
    const tl = trackList({ rows: toRows(tracks, a), contextUri: a.uri, showArt: false, showAlbum: false });
    d.add(tl.dispose);
    const totalMs = tracks.reduce((s, t) => s + t.duration_ms, 0);

    const saveBtn = h('button', { class: 'icon-btn big', title: 'Save album' }, micon('heart', 22));
    let saved = false;
    const paint = () => { saveBtn.classList.toggle('on', saved); saveBtn.replaceChildren(micon(saved ? 'heartFill' : 'heart', 22)); };
    api.libraryContains([a.uri]).then((r) => { saved = !!r?.[0]; paint(); }).catch(() => {});
    saveBtn.addEventListener('click', async () => {
      saved = !saved;
      paint();
      try {
        await (saved ? api.saveToLibrary([a.uri]) : api.removeFromLibrary([a.uri]));
        library.update((l) => ({ ...l, albums: saved ? [a, ...l.albums] : l.albums.filter((x) => x.id !== a.id) }));
      } catch (e) { saved = !saved; paint(); toast((e as Error).message, 'error'); }
    });

    return h(
      'div',
      null,
      header({
        image: bestImage(a.images, 300),
        kind: a.album_type === 'single' ? 'Single' : a.album_type === 'compilation' ? 'Compilation' : 'Album',
        title: a.name,
        meta: [a.artists ? artistLinks(a.artists) : null, a.release_date?.slice(0, 4) ?? null, `${tracks.length} songs, ${Math.round(totalMs / 60000)} min`],
        actions: [playButton(d, () => void playContext(a.uri), a.uri), h('button', { class: 'icon-btn big', title: 'Shuffle play', onclick: () => void shufflePlay(a.uri) }, micon('shuffle', 22)), saveBtn],
      }),
      tl.el,
    );
  });
}

// ---- Artist -----------------------------------------------------------------------
function artistView(id: string): View {
  return asyncView(async (d) => {
    const [a, albums] = await Promise.all([api.artist(id), api.artistAlbums(id).catch(() => null)]);
    const items = albums?.items ?? [];
    const full = items.filter((x) => x.album_type === 'album');
    const singles = items.filter((x) => x.album_type !== 'album');
    const grid = (list: typeof items) =>
      h('div', { class: 'card-grid' }, list.map((x) => card({ image: x.images, title: x.name, subtitle: `${x.release_date?.slice(0, 4) ?? ''} · ${x.album_type === 'single' ? 'Single' : 'Album'}`, onOpen: () => go({ view: 'album', id: x.id }), onPlay: () => void playContext(x.uri) })));
    return h(
      'div',
      null,
      header({
        image: bestImage(a.images, 300),
        round: true,
        kind: 'Artist',
        title: a.name,
        meta: [a.genres?.slice(0, 3).join(', ') || null],
        actions: [playButton(d, () => void playContext(a.uri), a.uri), h('button', { class: 'icon-btn big', title: 'Shuffle play', onclick: () => void shufflePlay(a.uri) }, micon('shuffle', 22))],
      }),
      full.length ? section('Albums', grid(full)) : null,
      singles.length ? section('Singles & EPs', grid(singles)) : null,
      !items.length ? h('div', { class: 'empty' }, 'No releases found.') : null,
    );
  });
}

// ---- Queue ------------------------------------------------------------------------
function queueView(): View {
  return asyncView(async (d) => {
    setTint(null);
    const q = await api.queue().catch((e) => {
      if (e instanceof SpotifyError && e.status === 404) return { currently_playing: null, queue: [] };
      throw e;
    });
    const out = h('div', { class: 'stack-lg' }, h('h1', null, 'Queue'));
    if (q.currently_playing) {
      const tl = trackList({ rows: toRows([q.currently_playing]) });
      d.add(tl.dispose);
      out.append(section('Now playing', tl.el));
    }
    if (q.queue.length) {
      const tl = trackList({ rows: toRows(q.queue) });
      d.add(tl.dispose);
      out.append(section('Next up', tl.el));
    }
    if (!q.currently_playing && !q.queue.length) out.append(h('div', { class: 'empty' }, 'Nothing queued. Right-click a song → Add to queue.'));
    // Refresh when the song changes.
    let last = player.get().track?.uri;
    d.add(player.subscribe((s) => { if (s.track?.uri !== last) { last = s.track?.uri; reloadView(); } }, false));
    return out;
  });
}

// ---- Search -----------------------------------------------------------------------
type SearchTab = 'all' | 'track' | 'artist' | 'album' | 'playlist';

function searchView(initial = ''): View {
  setTint(null);
  const d = new Disposer();
  const input = h('input', { class: 'msearch-input', placeholder: 'What do you want to listen to?', value: initial, autofocus: true });
  const tabsEl = h('div', { class: 'chips' });
  const results = h('div', { class: 'stack-lg' });
  let tab: SearchTab = 'all';
  let token = 0;

  const TABS: Array<[SearchTab, string]> = [['all', 'All'], ['track', 'Songs'], ['artist', 'Artists'], ['album', 'Albums'], ['playlist', 'Playlists']];
  const paintTabs = () => tabsEl.replaceChildren(...TABS.map(([v, l]) => h('button', { class: `chip ${tab === v ? 'active' : ''}`, onclick: () => { tab = v; paintTabs(); void run(); } }, l)));

  const run = async () => {
    const q = input.value.trim();
    const my = ++token;
    if (!q) {
      results.replaceChildren(h('div', { class: 'empty' }, 'Search for songs, artists, albums or playlists.'));
      return;
    }
    results.replaceChildren(loading());
    try {
      const types = tab === 'all' ? ['track', 'artist', 'album', 'playlist'] : [tab];
      const r = await api.search(q, types);
      if (my !== token) return;
      const blocks: HTMLElement[] = [];
      let offset = 0;

      if (r.tracks?.items.length) {
        const all = [...r.tracks.items];
        const tl = trackList({
          rows: toRows(all),
          loadMore: tab === 'track' ? async () => {
            offset += 10;
            if (offset >= Math.min(r.tracks!.total, 200)) return [];
            const more = await api.search(q, ['track'], offset);
            return toRows(more.tracks?.items ?? []);
          } : undefined,
        });
        d.add(tl.dispose);
        blocks.push(section('Songs', tl.el));
      }
      if (r.artists?.items.length) blocks.push(section('Artists', h('div', { class: 'card-grid' }, r.artists.items.map((a) => card({ image: a.images, title: a.name, subtitle: 'Artist', round: true, onOpen: () => go({ view: 'artist', id: a.id }), onPlay: () => void playContext(a.uri) })))));
      if (r.albums?.items.length) blocks.push(section('Albums', h('div', { class: 'card-grid' }, r.albums.items.map((a) => card({ image: a.images, title: a.name, subtitle: a.artists?.map((x) => x.name).join(', '), onOpen: () => go({ view: 'album', id: a.id }), onPlay: () => void playContext(a.uri) })))));
      const pls = (r.playlists?.items ?? []).filter((p): p is Playlist => !!p);
      if (pls.length) blocks.push(section('Playlists', h('div', { class: 'card-grid' }, pls.map((p) => card({ image: p.images, title: p.name, subtitle: `By ${p.owner.display_name ?? p.owner.id}`, onOpen: () => go({ view: 'playlist', id: p.id }), onPlay: () => void playContext(p.uri) })))));
      results.replaceChildren(...(blocks.length ? blocks : [h('div', { class: 'empty' }, `No results for “${q}”.`)]));
    } catch (e) {
      if (my === token) results.replaceChildren(errorBox(e));
    }
  };

  input.addEventListener('input', debounce(() => void run(), 350));
  paintTabs();
  void run();
  setTimeout(() => input.focus());
  return { el: h('div', { class: 'mview stack-lg' }, input, tabsEl, results), dispose: () => d.dispose() };
}

export function viewFor(r: MusicRoute): View {
  switch (r.view) {
    case 'home': return homeView();
    case 'search': return searchView(r.q);
    case 'liked': return likedView();
    case 'queue': return queueView();
    case 'playlist': return playlistView(r.id);
    case 'album': return albumView(r.id);
    case 'artist': return artistView(r.id);
  }
}

export { fmtTime };
