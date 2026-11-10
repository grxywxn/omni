import { h, modal, field, toast, toggle, confirmDialog } from '../../core/dom';
import { api, type Playlist } from '../api';
import { library, ownsPlaylist, refreshPlaylists, go } from '../library';
import { art } from './common';

/** Pick a playlist to add tracks to (or create a new one). */
export function addToPlaylistDialog(uris: string[]): void {
  const mine = library.get().playlists.filter(ownsPlaylist);
  const filter = h('input', { placeholder: 'Find a playlist' });
  const list = h('div', { class: 'pick-list' });

  const add = async (p: Playlist) => {
    try {
      await api.addToPlaylist(p.id, uris);
      toast(`Added to ${p.name}`, 'success', 2000);
      close();
      void refreshPlaylists();
      window.dispatchEvent(new CustomEvent('omni:playlist-changed', { detail: { id: p.id } }));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const render = () => {
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren(
      h('button', { class: 'pick-item new', onclick: () => { close(); playlistDialog(null, uris); } }, h('span', { class: 'art art-empty', style: 'width:40px;height:40px' }, '+'), h('strong', null, 'New playlist')),
      ...mine
        .filter((p) => !q || p.name.toLowerCase().includes(q))
        .map((p) => h('button', { class: 'pick-item', onclick: () => void add(p) }, art(p.images, 40), h('span', null, p.name))),
    );
  };
  filter.addEventListener('input', render);
  render();
  const close = modal(uris.length > 1 ? `Add ${uris.length} songs to playlist` : 'Add to playlist', h('div', { class: 'stack' }, filter, list), { width: 420 });
}

/** Create a playlist (p = null) or edit one you own. */
export function playlistDialog(p: Playlist | null, addUris: string[] = []): void {
  const name = h('input', { maxlength: '100', value: p?.name ?? '', placeholder: 'My playlist', required: true });
  const desc = h('textarea', { rows: '3', maxlength: '300', placeholder: 'Add an optional description' }, p?.description ? decodeHtml(p.description) : '');
  let isPublic = p?.public ?? false;
  let collaborative = p?.collaborative ?? false;

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        try {
          if (p) {
            await api.updatePlaylist(p.id, { name: name.value.trim(), description: desc.value.trim(), public: isPublic, collaborative: collaborative && !isPublic });
            toast('Playlist updated', 'success');
            window.dispatchEvent(new CustomEvent('omni:playlist-changed', { detail: { id: p.id } }));
          } else {
            const created = await api.createPlaylist(name.value.trim() || 'My playlist', desc.value.trim(), isPublic);
            if (addUris.length) await api.addToPlaylist(created.id, addUris);
            toast('Playlist created', 'success');
            go({ view: 'playlist', id: created.id });
          }
          close();
          void refreshPlaylists();
        } catch (ex) {
          toast((ex as Error).message, 'error');
        }
      },
    },
    field('Name', name),
    field('Description', desc),
    toggle(isPublic, (v) => (isPublic = v), 'Public (shows on your Spotify profile)'),
    p ? toggle(collaborative, (v) => (collaborative = v), 'Collaborative (friends can add songs; must be private)') : null,
    h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, p ? 'Save' : 'Create')),
  );
  const close = modal(p ? 'Edit playlist' : 'New playlist', form, { width: 440 });
}

/** Remove a playlist from your library (deletes it for you; Spotify keeps it for others who follow it). */
export async function removePlaylist(p: Playlist): Promise<void> {
  const owned = library.get().me?.id === p.owner.id;
  const ok = await confirmDialog(
    owned ? 'Delete playlist' : 'Remove playlist',
    owned ? `Delete “${p.name}”? You can recover it from spotify.com/account within 90 days.` : `Remove “${p.name}” from your library?`,
    { confirmLabel: owned ? 'Delete' : 'Remove', danger: true },
  );
  if (!ok) return;
  try {
    await api.removeFromLibrary([p.uri]);
    toast(owned ? 'Playlist deleted' : 'Removed from your library', 'success');
    library.update((l) => ({ ...l, playlists: l.playlists.filter((x) => x.id !== p.id) }));
    go({ view: 'home' });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export function decodeHtml(s: string): string {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}
