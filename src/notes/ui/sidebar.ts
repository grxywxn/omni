// Left sidebar: file tree (binder), search, tags, bookmarks.
import { h, icon, toast, setChildren, confirmDialog } from '../../core/dom';
import { Disposer, debounce } from '../../core/store';
import { type NoteMeta, vault, folderOrder, setFolderOrder, sortChildren, renamePath, trashPath, createFolder, allTags, isImage } from '../vault';
import { baseName, folderOf, joinRel, noteName, isMd, safeFileName, type Entry } from '../fs';
import { notesPrefs, patchNotesPrefs } from '../prefs';
import { plainText } from '../markdown';
import * as fm from '../frontmatter';
import { contextMenu } from '../../music/ui/common';
import { revealInExplorer } from '../../recorder/api';

export interface SidebarActions {
  open: (path: string, o?: { newPane?: boolean }) => void;
  openFolder: (path: string, layout?: string) => void;
  newNote: (folder: string) => void;
  newFromTemplate: (folder: string) => void;
  activePath: () => string;
  openGraph: () => void;
}

type Tab = 'files' | 'search' | 'tags' | 'bookmarks';

export function sidebar(actions: SidebarActions): { el: HTMLElement; dispose: () => void; search: (q: string) => void; reveal: () => void } {
  const d = new Disposer();
  let tab: Tab = 'files';
  const expanded = new Set<string>(JSON.parse(localStorage.getItem('omni.notes.expanded') ?? '[]'));
  const saveExpanded = () => localStorage.setItem('omni.notes.expanded', JSON.stringify([...expanded]));
  const tabs = h('div', { class: 'side-tabs' });
  const body = h('div', { class: 'side-body' });
  const el = h('aside', { class: 'notes-left' }, tabs, body);

  const paintTabs = () => {
    const t = (id: Tab, ic: string, title: string) => h('button', { class: `side-tab ${tab === id ? 'active' : ''}`, title, onclick: () => { tab = id; render(); } }, icon(ic, 17));
    tabs.replaceChildren(
      t('files', 'notes', 'Files'),
      t('search', 'search', 'Search (Ctrl+Shift+F)'),
      t('tags', 'ticket', 'Tags'),
      t('bookmarks', 'star', 'Bookmarks'),
      h('button', { class: 'side-tab', title: 'Graph view (Ctrl+G)', onclick: () => actions.openGraph() }, icon('graph', 17)),
      h('div', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'New note (Ctrl+N)', onclick: () => actions.newNote(currentFolder()) }, icon('edit', 16)),
      h('button', { class: 'icon-btn', title: 'New folder', onclick: async () => { const p = await createFolder(currentFolder()); expanded.add(p); saveExpanded(); renaming = p; render(); } }, icon('folder', 16)),
    );
  };

  const currentFolder = () => folderOf(actions.activePath());

  // ---- File tree ---------------------------------------------------------------------
  let renaming: string | null = null;
  let dragPath: string | null = null;

  const renderTree = async () => {
    const v = vault.get();
    const order = await folderOrder();
    const byParent = new Map<string, Entry[]>();
    for (const e of v.entries) {
      if (!e.is_dir && !isMd(e.path) && !isImage(e.path)) continue;
      const parent = folderOf(e.path);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent)!.push(e);
    }
    const activeP = actions.activePath();

    const node = (e: Entry, depth: number): HTMLElement[] => {
      const name = e.is_dir ? baseName(e.path) : isMd(e.path) ? noteName(e.path) : baseName(e.path);
      const open = expanded.has(e.path);
      const label = renaming === e.path
        ? h('input', { class: 'tree-rename', value: name })
        : h('span', { class: 'tree-name' }, name);
      if (label instanceof HTMLInputElement) {
        setTimeout(() => { label.focus(); label.select(); });
        const finish = async (ok: boolean) => {
          if (renaming !== e.path) return;
          renaming = null;
          const nn = safeFileName(label.value);
          if (ok && nn && nn !== name) {
            const to = joinRel(folderOf(e.path), e.is_dir || !isMd(e.path) ? nn : `${nn}.md`);
            try {
              const done = await renamePath(e.path, to);
              if (e.is_dir && expanded.has(e.path)) { expanded.delete(e.path); expanded.add(done); saveExpanded(); }
            } catch (err) { toast((err as Error).message, 'error'); }
          }
          render();
        };
        label.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void finish(true); if (ev.key === 'Escape') void finish(false); });
        label.addEventListener('blur', () => void finish(true));
      }
      const row = h(
        'div',
        {
          class: `tree-row ${e.is_dir ? 'dir' : 'file'} ${e.path === activeP ? 'active' : ''} ${!e.is_dir && !isMd(e.path) ? 'attachment' : ''}`,
          style: { paddingLeft: `${8 + depth * 14}px` },
          draggable: 'true',
          title: e.path,
          onclick: (ev: MouseEvent) => {
            if (renaming === e.path) return;
            if (e.is_dir) { open ? expanded.delete(e.path) : expanded.add(e.path); saveExpanded(); render(); }
            else if (isMd(e.path)) actions.open(e.path, { newPane: ev.ctrlKey || ev.metaKey });
          },
          oncontextmenu: (ev: MouseEvent) => { ev.preventDefault(); menuFor(e, ev); },
          ondragstart: (ev: DragEvent) => { dragPath = e.path; ev.dataTransfer?.setData('text/plain', e.path); },
          ondragover: (ev: DragEvent) => { if (dragPath && dragPath !== e.path) { ev.preventDefault(); row.classList.add(e.is_dir ? 'drop-into' : 'drop-before'); } },
          ondragleave: () => row.classList.remove('drop-into', 'drop-before'),
          ondrop: async (ev: DragEvent) => {
            ev.preventDefault();
            row.classList.remove('drop-into', 'drop-before');
            const from = dragPath;
            dragPath = null;
            if (!from || from === e.path) return;
            if (e.is_dir) {
              if (e.path.startsWith(`${from}/`)) return;
              try { await renamePath(from, joinRel(e.path, baseName(from))); expanded.add(e.path); saveExpanded(); } catch (err) { toast((err as Error).message, 'error'); }
            } else {
              // Reorder within a folder (Scrivener binder), moving folders if needed.
              const folder = folderOf(e.path);
              let moved = from;
              if (folderOf(from) !== folder) {
                try { moved = await renamePath(from, joinRel(folder, baseName(from))); } catch (err) { return toast((err as Error).message, 'error'); }
              }
              const siblings = sortChildren(folder, (byParent.get(folder) ?? []).filter((x) => x.path !== from), order).map((x) => baseName(x.path));
              const at = siblings.indexOf(baseName(e.path));
              siblings.splice(at < 0 ? siblings.length : at, 0, baseName(moved));
              await setFolderOrder(folder, siblings);
            }
            render();
          },
        },
        e.is_dir ? h('span', { class: `tree-caret ${open ? 'open' : ''}` }, '▸') : h('span', { class: 'tree-caret' }),
        e.is_dir ? icon('folder', 15) : isMd(e.path) ? null : icon('palette', 14),
        label,
      );
      const out: HTMLElement[] = [row];
      if (e.is_dir && open) for (const c of sortChildren(e.path, byParent.get(e.path) ?? [], order)) out.push(...node(c, depth + 1));
      return out;
    };

    const rootItems = sortChildren('', byParent.get('') ?? [], order);
    const rootDrop = h('div', {
      class: 'tree-root-drop',
      ondragover: (ev: DragEvent) => { if (dragPath) ev.preventDefault(); },
      ondrop: async (ev: DragEvent) => { ev.preventDefault(); const from = dragPath; dragPath = null; if (from && folderOf(from)) { await renamePath(from, baseName(from)).catch((er) => toast(String(er), 'error')); render(); } },
    }, 'Drop here to move to the top level');
    setChildren(body,
      h('div', { class: 'tree' }, rootItems.flatMap((e) => node(e, 0))),
      !rootItems.length ? h('div', { class: 'empty small' }, 'No notes yet. Press Ctrl+N to create one.') : null,
      rootDrop,
    );
  };

  const menuFor = (e: Entry, ev: MouseEvent) => {
    const items: Parameters<typeof contextMenu>[2] = [];
    if (e.is_dir) {
      items.push(
        { label: 'New note here', icon: 'plus', run: () => actions.newNote(e.path) },
        { label: 'New from template…', icon: 'notes', run: () => actions.newFromTemplate(e.path) },
        { label: 'New folder here', icon: 'plus', run: async () => { const p = await createFolder(e.path); expanded.add(e.path); expanded.add(p); saveExpanded(); renaming = p; render(); } },
        'sep',
        { label: 'Open as database', icon: 'library', run: () => actions.openFolder(e.path, 'table') },
        { label: 'Open corkboard', icon: 'library', run: () => actions.openFolder(e.path, 'corkboard') },
        { label: 'Open timeline', icon: 'clock', run: () => actions.openFolder(e.path, 'timeline') },
      );
    } else if (isMd(e.path)) {
      items.push(
        { label: 'Open in split view', icon: 'forward', run: () => actions.open(e.path, { newPane: true }) },
        { label: notesPrefs.get().bookmarks.includes(e.path) ? 'Remove bookmark' : 'Bookmark', icon: 'heart', run: () => toggleBookmark(e.path) },
      );
    }
    items.push(
      'sep',
      { label: 'Rename', icon: 'edit', run: () => { renaming = e.path; render(); } },
      { label: 'Show in File Explorer', icon: 'folder', run: () => void revealInExplorer(`${vault.get().root}\\${e.path.replace(/\//g, '\\')}`) },
      { label: 'Move to trash', icon: 'trash', danger: true, run: async () => {
        if (await confirmDialog('Move to trash', `Move “${baseName(e.path)}” to the vault’s .trash folder? You can restore it from there.`, { confirmLabel: 'Move to trash', danger: true })) {
          await trashPath(e.path).catch((er) => toast(String(er), 'error'));
        }
      } },
    );
    contextMenu(ev.clientX, ev.clientY, items);
  };

  const toggleBookmark = (p: string) => {
    const b = notesPrefs.get().bookmarks;
    patchNotesPrefs({ bookmarks: b.includes(p) ? b.filter((x) => x !== p) : [...b, p] });
    if (tab === 'bookmarks') render();
  };

  // ---- Search ------------------------------------------------------------------------
  let query = '';
  const renderSearch = () => {
    const input = h('input', { class: 'side-search', placeholder: 'Search notes…  (tag:#idea  path:Daily)', value: query });
    const results = h('div', { class: 'search-results' });
    const run = () => {
      query = input.value;
      const q = query.trim();
      if (!q) return results.replaceChildren(h('div', { class: 'empty small' }, 'Type to search every note’s title and text.'));
      const tokens = q.match(/("[^"]+"|\S+)/g) ?? [];
      const tagF = tokens.filter((t) => t.startsWith('tag:')).map((t) => t.slice(4).replace(/^#/, '').toLowerCase());
      const pathF = tokens.filter((t) => t.startsWith('path:')).map((t) => t.slice(5).toLowerCase());
      const words = tokens.filter((t) => !/^(tag|path):/.test(t)).map((t) => t.replace(/^"|"$/g, '').toLowerCase());
      const hits = [...vault.get().notes.values()]
        .filter((n) => tagF.every((t) => n.tags.some((x) => x === t || x.startsWith(`${t}/`))))
        .filter((n) => pathF.every((p) => n.path.toLowerCase().includes(p)))
        .map((n) => {
          const hay = `${n.name}\n${n.text}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return null;
          const score = words.reduce((s, w) => s + (n.name.toLowerCase().includes(w) ? 10 : 1), 0);
          return { n, score };
        })
        .filter((x): x is { n: NoteMeta; score: number } => !!x)
        .sort((a, b) => b.score - a.score)
        .slice(0, 100);
      results.replaceChildren(
        h('div', { class: 'muted small pad-x' }, `${hits.length} result${hits.length === 1 ? '' : 's'}`),
        ...hits.map(({ n }) => {
          const txt = plainText(fm.body(n.text));
          const w = words[0] ?? '';
          const i = w ? txt.toLowerCase().indexOf(w) : -1;
          const snippet = i >= 0 ? txt.slice(Math.max(0, i - 40), i + 80) : txt.slice(0, 100);
          const snipEl = h('div', { class: 'search-snippet' });
          if (w && i >= 0) {
            const j = snippet.toLowerCase().indexOf(w);
            snipEl.append(snippet.slice(0, j), h('mark', null, snippet.slice(j, j + w.length)), snippet.slice(j + w.length));
          } else snipEl.textContent = snippet;
          return h('button', { class: 'search-hit', onclick: (ev: MouseEvent) => actions.open(n.path, { newPane: ev.ctrlKey }) }, h('strong', null, n.name), h('span', { class: 'muted small' }, n.folder), snipEl);
        }),
      );
    };
    input.addEventListener('input', debounce(run, 150));
    body.replaceChildren(input, results);
    run();
    setTimeout(() => input.focus());
  };

  // ---- Tags ----------------------------------------------------------------------------
  const renderTags = () => {
    const tags = allTags();
    body.replaceChildren(
      ...(tags.length
        ? tags.map(([t, n]) => h('button', { class: 'tag-row', style: { paddingLeft: `${10 + (t.split('/').length - 1) * 14}px` }, onclick: () => api.search(`tag:#${t}`) }, h('span', { class: 'tag' }, `#${t.split('/').pop()}`), h('span', { class: 'muted small' }, String(n))))
        : [h('div', { class: 'empty small' }, 'No tags yet. Type #idea in any note.')]),
    );
  };

  // ---- Bookmarks -------------------------------------------------------------------------
  const renderBookmarks = () => {
    const b = notesPrefs.get().bookmarks.filter((p) => vault.get().notes.has(p));
    const recent = notesPrefs.get().recent.filter((p) => vault.get().notes.has(p)).slice(0, 12);
    const row = (p: string) => h('button', { class: 'tree-row file', onclick: () => actions.open(p), oncontextmenu: (ev: MouseEvent) => { ev.preventDefault(); contextMenu(ev.clientX, ev.clientY, [{ label: 'Remove bookmark', icon: 'x', run: () => toggleBookmark(p) }]); } }, h('span', { class: 'tree-name' }, noteName(p)), h('span', { class: 'muted small' }, folderOf(p)));
    body.replaceChildren(
      h('div', { class: 'side-heading' }, 'Bookmarks'),
      ...(b.length ? b.map(row) : [h('div', { class: 'empty small' }, 'Right-click a note → Bookmark.')]),
      h('div', { class: 'side-heading' }, 'Recent'),
      ...recent.map(row),
    );
  };

  const render = () => {
    paintTabs();
    if (tab === 'files') void renderTree();
    else if (tab === 'search') renderSearch();
    else if (tab === 'tags') renderTags();
    else renderBookmarks();
  };

  let lastVersion = -1;
  d.add(vault.subscribe((v) => {
    if (v.version === lastVersion) return;
    lastVersion = v.version;
    if (tab !== 'search') render();
  }));

  const api = {
    el,
    dispose: () => d.dispose(),
    search: (q: string) => { tab = 'search'; query = q; render(); },
    reveal: () => {
      const p = actions.activePath();
      let f = folderOf(p);
      while (f) { expanded.add(f); f = folderOf(f); }
      saveExpanded();
      if (tab === 'files') render();
    },
  };
  render();
  return api;
}
