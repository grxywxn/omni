// A folder seen as a database (Notion), corkboard (Scrivener) or timeline (Campfire).
import { h, icon, select, toggle, setChildren } from '../../core/dom';
import { Disposer } from '../../core/store';
import { vault, notesIn, writeNote, createNote, folderOrder, setFolderOrder, type NoteMeta } from '../vault';
import { baseName, noteName } from '../fs';
import * as fm from '../frontmatter';
import { plainText } from '../markdown';
import { notesPrefs, patchNotesPrefs } from '../prefs';
import { imageFromProp } from './properties';
import { compileDialog } from './export';

type Layout = 'table' | 'board' | 'gallery' | 'corkboard' | 'timeline';
const LAYOUTS: Array<[Layout, string, string]> = [
  ['table', 'Table', 'Database table — edit properties like a spreadsheet'],
  ['board', 'Board', 'Kanban board grouped by a property — drag cards between columns'],
  ['gallery', 'Gallery', 'Cards with images (great for characters & places)'],
  ['corkboard', 'Corkboard', 'Index cards in manuscript order — drag to reorder (Scrivener)'],
  ['timeline', 'Timeline', 'Notes with a date property, in order (Campfire)'],
];

const STATUS_COLORS: Record<string, string> = { 'to do': '#80848e', todo: '#80848e', draft: '#f0b232', 'in progress': '#5865f2', doing: '#5865f2', revised: '#9b59b6', review: '#e67e22', done: '#23a55a', final: '#23a55a' };
const statusColor = (s: string) => STATUS_COLORS[s.toLowerCase()] ?? `hsl(${[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 55% 55%)`;

/** Sortable key for dates like 2026-03-01, "1032", "Year 12 Spring". */
function dateKey(v: fm.Value | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  const iso = Date.parse(s);
  if (/^\d{4}-\d{2}(-\d{2})?/.test(s) && !isNaN(iso)) return iso / 86_400_000;
  const n = /-?\d+(\.\d+)?/.exec(s);
  return n ? Number(n[0]) * 365 : null;
}

export function folderView(folder: string, opts: { open: (path: string, o?: { newPane?: boolean }) => void; initialLayout?: string }): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  const el = h('div', { class: 'folder-view' });
  const view = () => notesPrefs.get().views[folder] ?? { layout: 'table' };
  const setView = (patch: Partial<ReturnType<typeof view>>) => patchNotesPrefs({ views: { ...notesPrefs.get().views, [folder]: { ...view(), ...patch } } });
  if (opts.initialLayout) setView({ layout: opts.initialLayout });
  let filter = '';

  const notes = (): NoteMeta[] => {
    const v = view();
    const q = filter.toLowerCase();
    return notesIn(folder, !!v.recursive).filter((n) => !q || n.name.toLowerCase().includes(q) || Object.values(n.props).some((x) => fm.valueText(x).toLowerCase().includes(q)));
  };

  const setProp = async (n: NoteMeta, key: string, value: fm.Value | undefined) => {
    await writeNote(n.path, fm.updateProps(n.text, { [key]: value }), 'folder-view');
  };

  const parseInput = (raw: string, old: fm.Value | undefined): fm.Value => {
    if (raw === '') return null;
    if (Array.isArray(old)) return raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (typeof old === 'number' && !isNaN(Number(raw))) return Number(raw);
    if (typeof old === 'boolean') return raw === 'true';
    return raw;
  };

  const addNote = async (props: Record<string, fm.Value> = {}) => {
    const p = await createNote(folder, 'Untitled', Object.keys(props).length ? fm.updateProps('', props) : '');
    opts.open(p);
  };

  // ---- Table ---------------------------------------------------------------------
  const table = (list: NoteMeta[]) => {
    const keys = new Set<string>();
    list.forEach((n) => Object.keys(n.props).forEach((k) => keys.add(k)));
    const cols = (view().columns ?? [...keys].filter((k) => k !== 'pins').slice(0, 8));
    const addCol = h('input', { class: 'add-col', placeholder: '+ column', list: 'fv-keys' });
    addCol.addEventListener('keydown', (e) => { if (e.key === 'Enter' && addCol.value.trim()) setView({ columns: [...cols, addCol.value.trim()] }); });
    const cell = (n: NoteMeta, k: string) => {
      const v = n.props[k];
      if (typeof v === 'boolean') return h('td', null, h('input', { type: 'checkbox', checked: v, onchange: (e: Event) => void setProp(n, k, (e.target as HTMLInputElement).checked) }));
      const inp = h('input', { class: 'cell-input', value: fm.valueText(v) });
      inp.addEventListener('change', () => void setProp(n, k, parseInput(inp.value, v)));
      inp.addEventListener('keydown', (e) => e.key === 'Enter' && inp.blur());
      return h('td', null, inp);
    };
    return h('div', { class: 'fv-table-wrap' },
      h('table', { class: 'fv-table' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), ...cols.map((k) => h('th', null, h('span', null, k), h('button', { class: 'icon-btn col-x', title: 'Hide column', onclick: () => setView({ columns: cols.filter((c) => c !== k) }) }, '×'))), h('th', null, 'Words'), h('th', null, addCol))),
        h('tbody', null, ...list.map((n) => h('tr', null,
          h('td', { class: 'name-cell' }, h('button', { class: 'text-link', onclick: (e: MouseEvent) => opts.open(n.path, { newPane: e.ctrlKey }) }, n.name)),
          ...cols.map((k) => cell(n, k)),
          h('td', { class: 'muted' }, n.words.toLocaleString()),
          h('td'))))),
      h('datalist', { id: 'fv-keys' }, [...keys].map((k) => h('option', { value: k }))),
      h('button', { class: 'ghost fv-add', onclick: () => void addNote() }, '+ New'),
    );
  };

  // ---- Board ------------------------------------------------------------------------
  const board = (list: NoteMeta[]) => {
    const key = view().groupBy ?? 'status';
    const groups = new Map<string, NoteMeta[]>();
    for (const n of list) {
      const g = fm.valueText(n.props[key]) || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(n);
    }
    const defaults = key === 'status' ? ['to do', 'in progress', 'done'] : [];
    for (const g of defaults) if (!groups.has(g)) groups.set(g, []);
    let dragging: NoteMeta | null = null;
    const newCol = h('input', { class: 'add-col', placeholder: '+ Add column' });
    newCol.addEventListener('keydown', (e) => { if (e.key === 'Enter' && newCol.value.trim()) { groups.set(newCol.value.trim(), []); render(); } });
    return h('div', { class: 'fv-board' },
      ...[...groups].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : defaults.indexOf(a[0]) - defaults.indexOf(b[0]) || a[0].localeCompare(b[0]))).map(([g, items]) => {
        const col = h('div', {
          class: 'fv-col',
          ondragover: (e: DragEvent) => { e.preventDefault(); col.classList.add('over'); },
          ondragleave: () => col.classList.remove('over'),
          ondrop: async (e: DragEvent) => { e.preventDefault(); col.classList.remove('over'); if (dragging) { await setProp(dragging, key, g || undefined); dragging = null; } },
        },
        h('div', { class: 'fv-col-head' }, h('span', { class: 'status-dot', style: { background: g ? statusColor(g) : 'var(--border)' } }), h('strong', null, g || `No ${key}`), h('span', { class: 'muted' }, String(items.length))),
        ...items.map((n) => h('div', { class: 'fv-card', draggable: 'true', ondragstart: () => (dragging = n), onclick: (e: MouseEvent) => opts.open(n.path, { newPane: e.ctrlKey }) },
          h('strong', null, n.name),
          h('div', { class: 'muted small clamp' }, fm.valueText(n.props.synopsis) || plainText(fm.body(n.text)).slice(0, 120)))),
        h('button', { class: 'ghost fv-add', onclick: () => void addNote(g ? { [key]: g } : {}) }, '+ New'));
        return col;
      }),
      h('div', { class: 'fv-col ghost-col' }, newCol),
    );
  };

  // ---- Gallery -------------------------------------------------------------------
  const gallery = (list: NoteMeta[]) => h('div', { class: 'fv-gallery' },
    ...list.map((n) => {
      const img = imageFromProp(n.props.image ?? n.props.cover ?? n.props.portrait, n.path);
      return h('button', { class: 'fv-gcard', onclick: (e: MouseEvent) => opts.open(n.path, { newPane: e.ctrlKey }) },
        img ? h('img', { src: img, alt: '' }) : h('div', { class: 'fv-gph' }, n.name.slice(0, 1).toUpperCase()),
        h('strong', null, n.name),
        h('span', { class: 'muted small' }, [n.props.type, n.props.role, n.props.region].filter(Boolean).map((x) => fm.valueText(x)).join(' · ')));
    }),
    h('button', { class: 'fv-gcard add', onclick: () => void addNote() }, '+ New'),
  );

  // ---- Corkboard (Scrivener) ----------------------------------------------------------
  const corkboard = async (list: NoteMeta[]) => {
    const order = (await folderOrder())[folder] ?? [];
    const idx = (n: NoteMeta) => { const i = order.indexOf(baseName(n.path)); return i < 0 ? 1e6 : i; };
    const items = list.filter((n) => n.folder === folder).sort((a, b) => idx(a) - idx(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const total = items.reduce((s, n) => s + n.words, 0);
    const target = items.reduce((s, n) => s + (Number(n.props.target) || 0), 0);
    let from = -1;
    const card = (n: NoteMeta, i: number) => {
      const status = fm.valueText(n.props.status);
      const t = Number(n.props.target) || 0;
      const syn = h('textarea', { class: 'card-synopsis', placeholder: 'Write a synopsis…', rows: '4' }, fm.valueText(n.props.synopsis));
      syn.addEventListener('change', () => void setProp(n, 'synopsis', syn.value.trim() || null));
      syn.addEventListener('click', (e) => e.stopPropagation());
      return h('div', {
        class: 'index-card', draggable: 'true',
        ondragstart: () => (from = i),
        ondragover: (e: DragEvent) => e.preventDefault(),
        ondrop: async (e: DragEvent) => {
          e.preventDefault();
          if (from < 0 || from === i) return;
          const names = items.map((x) => baseName(x.path));
          const [m] = names.splice(from, 1);
          names.splice(i, 0, m);
          await setFolderOrder(folder, names);
          render();
        },
        ondblclick: () => opts.open(n.path),
      },
      h('div', { class: 'card-top', style: { borderColor: status ? statusColor(status) : 'transparent' } },
        h('span', { class: 'card-num' }, String(i + 1)), h('strong', { class: 'grow' }, n.name), status ? h('span', { class: 'card-status', style: { background: statusColor(status) } }, status) : null),
      syn,
      h('div', { class: 'card-foot' }, h('span', null, `${n.words.toLocaleString()} words`), t ? h('div', { class: 'mini-target' }, h('div', { style: { width: `${Math.min(100, (n.words / t) * 100)}%` } })) : null,
        h('button', { class: 'ghost small-btn', onclick: () => opts.open(n.path) }, 'Open')));
    };
    return h('div', { class: 'stack' },
      h('div', { class: 'cork-stats' }, h('span', null, `${items.length} documents · ${total.toLocaleString()} words`), target ? h('div', { class: 'target-bar wide' }, h('div', { class: 'target-fill', style: { width: `${Math.min(100, (total / target) * 100)}%` } })) : null, target ? h('span', { class: 'muted' }, `${Math.round((total / target) * 100)}% of ${target.toLocaleString()}`) : null),
      h('div', { class: 'corkboard' }, ...items.map(card), h('button', { class: 'index-card add', onclick: () => void addNote({ type: 'scene', status: 'to do', synopsis: null }) }, '+ New document')),
    );
  };

  // ---- Timeline (Campfire) --------------------------------------------------------------
  const timeline = (list: NoteMeta[]) => {
    const dated = list.map((n) => ({ n, k: dateKey(n.props.date ?? n.props.when ?? n.props.year) })).filter((x) => x.k !== null).sort((a, b) => a.k! - b.k!);
    const undated = list.length - dated.length;
    return h('div', { class: 'timeline' },
      dated.length ? null : h('div', { class: 'note' }, 'Give notes a ', h('code', null, 'date'), ' property (e.g. 2026-03-01, or “Year 1032”) to place them here. The “Timeline event” template does this for you.'),
      ...dated.map(({ n }, i) => h('div', { class: `tl-item ${i % 2 ? 'right' : 'left'}` },
        h('div', { class: 'tl-dot' }),
        h('button', { class: 'tl-card', onclick: (e: MouseEvent) => opts.open(n.path, { newPane: e.ctrlKey }) },
          h('span', { class: 'tl-date' }, fm.valueText(n.props.date ?? n.props.when ?? n.props.year)),
          h('strong', null, n.name),
          h('span', { class: 'muted small clamp' }, plainText(fm.body(n.text)).replace(/^.*\n/, '').slice(0, 140))))),
      undated ? h('p', { class: 'muted small center' }, `${undated} note${undated === 1 ? '' : 's'} without a date not shown.`) : null,
      h('button', { class: 'ghost fv-add', onclick: () => void addNote({ type: 'event', date: new Date().toISOString().slice(0, 10) }) }, '+ New event'),
    );
  };

  const render = async () => {
    const v = view();
    const list = notes();
    const layout = (v.layout as Layout) ?? 'table';
    const search = h('input', { class: 'fv-filter', placeholder: 'Filter…', value: filter });
    search.addEventListener('input', () => { filter = search.value; void renderBody(); });
    const keys = new Set<string>();
    notesIn(folder, !!v.recursive).forEach((n) => Object.keys(n.props).forEach((k) => keys.add(k)));
    const bodyEl = h('div', { class: 'fv-body' });
    const renderBody = async () => {
      const l = notes();
      setChildren(bodyEl, layout === 'table' ? table(l) : layout === 'board' ? board(l) : layout === 'gallery' ? gallery(l) : layout === 'corkboard' ? await corkboard(l) : timeline(l));
    };
    setChildren(el,
      h('header', { class: 'fv-head' },
        h('div', { class: 'grow' }, h('h1', null, folder ? baseName(folder) : 'All notes'), h('span', { class: 'muted' }, `${list.length} note${list.length === 1 ? '' : 's'}${folder ? ` in ${folder}` : ''}`)),
        h('button', { class: 'secondary', title: 'Combine these documents into one manuscript (.docx, PDF, Markdown)', onclick: () => void compileDialog(folder) }, icon('upload', 15), 'Compile…')),
      h('div', { class: 'fv-bar' },
        h('div', { class: 'segmented' }, ...LAYOUTS.map(([id, label, title]) => h('button', { class: layout === id ? 'active' : '', title, onclick: () => { setView({ layout: id }); void render(); } }, label))),
        layout === 'board' ? h('label', { class: 'mini-field' }, h('span', null, 'Group by'), select(v.groupBy ?? 'status', [...new Set(['status', ...keys])].map((k) => [k, k] as [string, string]), (g) => { setView({ groupBy: g }); void render(); })) : null,
        toggle(!!v.recursive, (r) => { setView({ recursive: r }); void render(); }, 'Include subfolders'),
        h('div', { class: 'spacer' }),
        search),
      bodyEl,
    );
    await renderBody();
  };

  let lastV = -1;
  d.add(vault.subscribe((v) => {
    if (v.version === lastV) return;
    lastV = v.version;
    // Don't re-render while typing in a cell.
    if (el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement!.tagName)) return;
    void render();
  }));
  return { el, dispose: () => d.dispose() };
}

export { noteName };
