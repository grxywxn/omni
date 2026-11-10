import { h, icon, toast, setChildren } from '../../core/dom';
import { rec, revealInExplorer, pickFolder, fmtDuration, type TakeEntry } from '../api';
import { recPrefs, patchRecPrefs } from '../state';

export function takesView(opts: { openTake: (dir: string) => void }): { el: HTMLElement; dispose: () => void } {
  const el = h('div', { class: 'takes-view' });
  let alive = true;

  const render = (list: TakeEntry[] | null, error?: string) => {
    const folder = recPrefs.get().folder;
    setChildren(
      el,
      h(
        'div',
        { class: 'row takes-head' },
        h('div', { class: 'grow' }, h('h3', null, 'Your takes'), h('code', { class: 'folder-path' }, folder || 'No folder chosen yet')),
        h('button', { class: 'secondary', onclick: async () => { const f = await pickFolder('Choose your recordings folder', folder || undefined); if (f) { patchRecPrefs({ folder: f }); void load(); } } }, 'Change folder…'),
        folder ? h('button', { class: 'ghost', onclick: () => void revealInExplorer(folder) }, 'Open folder') : null,
      ),
      error ? h('div', { class: 'note' }, error) : null,
      list === null
        ? h('div', { class: 'empty' }, 'Loading…')
        : list.length
          ? h(
              'div',
              { class: 'take-grid' },
              list.map(({ dir, take }) =>
                h(
                  'button',
                  { class: 'take-card', onclick: () => opts.openTake(dir) },
                  h('div', { class: 'take-card-top' }, icon('mic', 18), h('strong', null, take.name)),
                  h('div', { class: 'muted' }, take.created ? new Date(take.created).toLocaleString() : ''),
                  h(
                    'div',
                    { class: 'take-card-meta' },
                    h('span', null, fmtDuration(take.seconds)),
                    h('span', null, `${take.tracks.length} track${take.tracks.length === 1 ? '' : 's'}`),
                    take.tracks.some((t) => t.processed) ? h('span', { class: 'pill' }, 'Cleaned up') : h('span', { class: 'pill muted-pill' }, 'Original'),
                  ),
                ),
              ),
            )
          : h('div', { class: 'empty' }, 'No takes yet. Record something and it will show up here.'),
    );
  };

  const load = async () => {
    const folder = recPrefs.get().folder;
    if (!folder) return render([]);
    render(null);
    try {
      const list = await rec.takes(folder);
      if (alive) render(list);
    } catch (e) {
      if (alive) render([], (e as Error).message);
      toast((e as Error).message, 'error');
    }
  };
  void load();
  return { el, dispose: () => { alive = false; } };
}
