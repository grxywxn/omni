import { h, toast } from '../../core/dom';
import { Disposer } from '../../core/store';
import { api, fmtTime, likedMap, type Track } from '../api';
import { player, playContext, playTracks, addToQueue } from '../player';
import { musicPrefs } from '../prefs';
import { openUri } from '../library';
import { art, artistLinks, contextMenu, micon, spotifyLink, type MenuItem } from './common';
import { addToPlaylistDialog } from './dialogs';

export interface TrackRow {
  track: Track;
  addedAt?: string;
}

export interface TrackListOptions {
  rows: TrackRow[];
  /** Play within this context (album / playlist / liked songs). */
  contextUri?: string;
  /** Editable playlist: enables remove + drag to reorder. */
  playlistId?: string;
  snapshotId?: string;
  showArt?: boolean;
  showAlbum?: boolean;
  /** Fetch the next page (infinite scroll). Return [] when done. */
  loadMore?: () => Promise<TrackRow[]>;
  onRemoved?: (uri: string) => void;
}

/** Track table. Returns the element and a dispose function. */
export function trackList(opts: TrackListOptions): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  const prefs = musicPrefs.get();
  const showAlbum = (opts.showAlbum ?? true) && prefs.showAlbumColumn;
  const showAdded = !!opts.rows[0]?.addedAt && prefs.showAddedColumn;
  const showArt = opts.showArt ?? true;
  const editable = !!opts.playlistId;
  let rows = [...opts.rows];
  let snapshot = opts.snapshotId;
  const liked = new Map<string, boolean>();

  const body = h('div', { class: 'tl-body', role: 'rowgroup' });
  const sentinel = h('div', { class: 'tl-sentinel' });
  const el = h(
    'div',
    { class: `tracklist density-${prefs.rowDensity} ${showAlbum ? 'with-album' : ''} ${showAdded ? 'with-added' : ''}`, role: 'table' },
    h(
      'div',
      { class: 'tl-head', role: 'row' },
      h('span', null, '#'),
      h('span', null, 'Title'),
      showAlbum ? h('span', null, 'Album') : null,
      showAdded ? h('span', null, 'Added') : null,
      h('span', null),
      h('span', { class: 'tl-dur' }, micon('clock', 15)),
      h('span', null),
    ),
    body,
    sentinel,
  );

  const uris = () => rows.map((r) => r.track.uri);

  const play = (i: number) => {
    const t = rows[i].track;
    if (opts.contextUri) void playContext(opts.contextUri, t.uri);
    else void playTracks(uris(), i);
  };

  const setLike = async (uri: string, value: boolean, btn: HTMLElement) => {
    liked.set(uri, value);
    paintHeart(btn, value);
    try {
      await (value ? api.saveToLibrary([uri]) : api.removeFromLibrary([uri]));
      window.dispatchEvent(new CustomEvent('omni:liked-changed', { detail: { uri, liked: value } }));
    } catch (e) {
      liked.set(uri, !value);
      paintHeart(btn, !value);
      toast((e as Error).message, 'error');
    }
  };

  const paintHeart = (btn: HTMLElement, on: boolean) => {
    btn.classList.toggle('on', on);
    btn.replaceChildren(micon(on ? 'heartFill' : 'heart', 16));
    btn.setAttribute('aria-label', on ? 'Remove from Liked Songs' : 'Save to Liked Songs');
  };

  const removeRow = async (i: number) => {
    const t = rows[i].track;
    try {
      const res = await api.removeFromPlaylist(opts.playlistId!, [t.uri], snapshot);
      snapshot = res?.snapshot_id ?? snapshot;
      rows = rows.filter((r) => r.track.uri !== t.uri);
      renderRows();
      opts.onRemoved?.(t.uri);
      toast('Removed from playlist', 'success', 1800);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const menuFor = (i: number): Array<MenuItem | 'sep'> => {
    const t = rows[i].track;
    const isLiked = liked.get(t.uri) ?? false;
    const items: Array<MenuItem | 'sep'> = [
      { label: 'Play', icon: 'play', run: () => play(i) },
      { label: 'Add to queue', icon: 'queue', run: () => void addToQueue(t.uri) },
      { label: 'Add to playlist…', icon: 'plus', run: () => addToPlaylistDialog([t.uri]) },
      {
        label: isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs',
        icon: isLiked ? 'heartFill' : 'heart',
        run: () => {
          const btn = body.querySelector<HTMLElement>(`[data-i="${i}"] .tl-like`);
          if (btn) void setLike(t.uri, !isLiked, btn);
        },
      },
      'sep',
    ];
    if (t.album?.uri) items.push({ label: 'Go to album', icon: 'disc', run: () => openUri(t.album!.uri) });
    if (t.artists[0]) items.push({ label: 'Go to artist', icon: 'user', run: () => openUri(t.artists[0].uri) });
    items.push({ label: 'Copy Spotify link', icon: 'link', run: () => void navigator.clipboard.writeText(spotifyLink(t.uri)).then(() => toast('Link copied', 'success', 1500)) });
    if (editable) items.push('sep', { label: 'Remove from this playlist', icon: 'trash', danger: true, run: () => void removeRow(i) });
    return items;
  };

  // ---- Drag to reorder (editable playlists) --------------------------------------
  let dragFrom = -1;
  const onDrop = async (to: number) => {
    const from = dragFrom;
    dragFrom = -1;
    if (from < 0 || from === to) return;
    const moved = rows.splice(from, 1)[0];
    rows.splice(to, 0, moved);
    renderRows();
    try {
      const insertBefore = to > from ? to + 1 : to;
      const res = await api.reorderPlaylist(opts.playlistId!, from, insertBefore, snapshot);
      snapshot = res?.snapshot_id ?? snapshot;
    } catch (e) {
      toast(`Couldn't reorder: ${(e as Error).message}`, 'error');
      rows.splice(to, 1);
      rows.splice(from, 0, moved);
      renderRows();
    }
  };

  const rowEl = (r: TrackRow, i: number) => {
    const t = r.track;
    const unplayable = t.is_local || !t.uri.startsWith('spotify:track:');
    const heart = h('button', { class: 'icon-btn tl-like', onclick: (e: Event) => { e.stopPropagation(); void setLike(t.uri, !(liked.get(t.uri) ?? false), heart); } });
    paintHeart(heart, liked.get(t.uri) ?? false);
    const row = h(
      'div',
      {
        class: `tl-row ${unplayable ? 'disabled' : ''}`,
        role: 'row',
        tabindex: '0',
        dataset: { i: String(i), uri: t.uri },
        draggable: editable ? 'true' : undefined,
        ondblclick: () => !unplayable && play(i),
        onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && !unplayable && play(i),
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, menuFor(i)); },
        ondragstart: (e: DragEvent) => { dragFrom = i; e.dataTransfer?.setData('text/plain', t.uri); row.classList.add('dragging'); },
        ondragend: () => row.classList.remove('dragging'),
        ondragover: (e: DragEvent) => { if (dragFrom >= 0) { e.preventDefault(); row.classList.add('drop-target'); } },
        ondragleave: () => row.classList.remove('drop-target'),
        ondrop: (e: DragEvent) => { e.preventDefault(); row.classList.remove('drop-target'); void onDrop(i); },
      },
      h('span', { class: 'tl-num' }, h('span', { class: 'n' }, String(i + 1)), h('button', { class: 'tl-play', 'aria-label': `Play ${t.name}`, onclick: (e: Event) => { e.stopPropagation(); if (!unplayable) play(i); } }, micon('play', 14)), h('span', { class: 'eq' }, h('i'), h('i'), h('i'))),
      h(
        'span',
        { class: 'tl-title' },
        showArt && t.album ? art(t.album.images, 40) : null,
        h('span', { class: 'tl-title-text' }, h('span', { class: 'tl-name' }, t.name, t.explicit ? h('span', { class: 'explicit', title: 'Explicit' }, 'E') : null), artistLinks(t.artists)),
      ),
      showAlbum ? h('span', { class: 'tl-album' }, t.album ? h('button', { class: 'text-link', onclick: (e: Event) => { e.stopPropagation(); openUri(t.album!.uri); } }, t.album.name) : '') : null,
      showAdded ? h('span', { class: 'tl-added' }, r.addedAt ? new Date(r.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '') : null,
      heart,
      h('span', { class: 'tl-dur' }, fmtTime(t.duration_ms)),
      h('button', { class: 'icon-btn tl-more', 'aria-label': 'More options', onclick: (e: MouseEvent) => { e.stopPropagation(); contextMenu(e.clientX, e.clientY, menuFor(i)); } }, micon('more', 16)),
    );
    return row;
  };

  const renderRows = () => {
    body.replaceChildren(...rows.map(rowEl));
    paintCurrent();
  };

  const paintCurrent = () => {
    const s = player.get();
    const uri = s.track?.uri;
    for (const row of body.children as HTMLCollectionOf<HTMLElement>) {
      const cur = row.dataset.uri === uri;
      row.classList.toggle('current', cur);
      row.classList.toggle('playing', cur && s.playing);
    }
  };

  const checkLikes = async (subset: TrackRow[]) => {
    const unknown = subset.map((r) => r.track.uri).filter((u) => !liked.has(u));
    if (!unknown.length) return;
    const m = await likedMap(unknown);
    for (const [u, v] of m) liked.set(u, v);
    for (const btn of body.querySelectorAll<HTMLElement>('.tl-row')) {
      const u = btn.dataset.uri!;
      if (m.has(u)) paintHeart(btn.querySelector('.tl-like')!, m.get(u)!);
    }
  };

  renderRows();
  void checkLikes(rows);

  let lastUri: string | undefined;
  let lastPlaying: boolean | undefined;
  d.add(player.subscribe((s) => {
    if (s.track?.uri === lastUri && s.playing === lastPlaying) return;
    lastUri = s.track?.uri;
    lastPlaying = s.playing;
    paintCurrent();
  }));

  const onLikedChanged = (e: Event) => {
    const { uri, liked: v } = (e as CustomEvent).detail as { uri: string; liked: boolean };
    liked.set(uri, v);
    const btn = body.querySelector<HTMLElement>(`.tl-row[data-uri="${CSS.escape(uri)}"] .tl-like`);
    if (btn) paintHeart(btn, v);
  };
  window.addEventListener('omni:liked-changed', onLikedChanged);
  d.add(() => window.removeEventListener('omni:liked-changed', onLikedChanged));

  // ---- Infinite scroll ----------------------------------------------------------
  if (opts.loadMore) {
    let busy = false;
    let done = false;
    const io = new IntersectionObserver(async (entries) => {
      if (!entries[0].isIntersecting || busy || done) return;
      busy = true;
      sentinel.textContent = 'Loading…';
      try {
        const more = await opts.loadMore!();
        if (!more.length) done = true;
        const start = rows.length;
        rows.push(...more);
        body.append(...more.map((r, j) => rowEl(r, start + j)));
        paintCurrent();
        void checkLikes(more);
      } catch (e) {
        toast((e as Error).message, 'error');
        done = true;
      } finally {
        busy = false;
        sentinel.textContent = '';
      }
    }, { rootMargin: '600px' });
    io.observe(sentinel);
    d.add(() => io.disconnect());
  }

  return { el, dispose: () => d.dispose() };
}
