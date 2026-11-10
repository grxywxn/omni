import '../notes/notes.css';
import { h, icon, toast, modal, popover, closePopover, setChildren } from '../core/dom';
import { Disposer, debounce } from '../core/store';
import { isTauri } from '../core/native';
import { vault, openVault, refreshFromDisk, createNote, resolveLink, writeNote, trashPath, resetOrderCache } from '../notes/vault';
import { nfs, noteName, folderOf, joinRel } from '../notes/fs';
import { notesPrefs, patchNotesPrefs, type EditorMode } from '../notes/prefs';
import { active, ui } from '../notes/state';
import { allTemplates, fill, BUILT_IN, type Template } from '../notes/templates';
import { noteEditor, type NoteEditor } from '../notes/ui/editor';
import { sidebar } from '../notes/ui/sidebar';
import { rightPanel, takeSnapshot } from '../notes/ui/panels';
import { folderView } from '../notes/ui/folderview';
import { graphView } from '../notes/ui/graph';
import { exportNote } from '../notes/ui/export';
import { fuzzy } from '../notes/ui/textedit';
import { pickFolder, revealInExplorer } from '../recorder/api';
import { WELCOME_NOTES } from '../notes/welcome';

type Content = { kind: 'note'; path: string } | { kind: 'folder'; path: string; layout?: string } | { kind: 'graph'; mode?: 'links' | 'relations' | 'local' } | { kind: 'empty' };

interface Pane {
  el: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  content: Content;
  editor: NoteEditor | null;
  dispose: (() => void) | null;
  back: Content[];
  fwd: Content[];
}

export function mount(el: HTMLElement): () => void {
  if (!isTauri) {
    el.append(h('div', { class: 'empty' }, 'Notes work in the Omni desktop app.'));
    return () => {};
  }
  const d = new Disposer();
  const root = h('div', { class: 'notes-root' });
  el.append(root);

  const start = async () => {
    const r = notesPrefs.get().root;
    if (!r) return setupScreen();
    root.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Opening your notes…'));
    try {
      if (vault.get().root !== r || !vault.get().ready) await openVault(r);
      resetOrderCache();
      d.add(workspace());
    } catch (e) {
      root.replaceChildren(h('div', { class: 'empty' }, `Couldn't open ${r}: ${(e as Error).message}`, h('div', { class: 'row center-row' },
        h('button', { class: 'secondary', onclick: () => { patchNotesPrefs({ root: '' }); void start(); } }, 'Choose another folder'))));
    }
  };

  // ---- First run ------------------------------------------------------------------------
  const setupScreen = () => {
    const createVault = async () => {
      const { documentDir, join } = await import('@tauri-apps/api/path');
      const docs = await documentDir();
      let name = 'Omni Notes';
      const existing = await nfs.list(docs, '').catch(() => []);
      for (let i = 2; existing.some((e) => e.path.toLowerCase() === name.toLowerCase()); i++) name = `Omni Notes ${i}`;
      await nfs.mkdir(docs, name);
      const r = await join(docs, name);
      for (const [p, text] of WELCOME_NOTES) await nfs.write(r, p, text);
      patchNotesPrefs({ root: r, recent: ['Welcome to Omni Notes.md'] });
      void start();
    };
    const openFolder = async () => {
      const f = await pickFolder('Choose a folder for your notes (any folder, or your Obsidian vault)');
      if (f) { patchNotesPrefs({ root: f, recent: [] }); void start(); }
    };
    root.replaceChildren(h('div', { class: 'notes-setup' },
      h('span', { class: 'setup-icon notes-icon' }, icon('notes', 34)),
      h('h1', null, 'Your notes'),
      h('p', { class: 'muted' }, 'Notes are plain Markdown files in a folder on your PC: private, offline, and readable by any app (including Obsidian).'),
      h('div', { class: 'setup-choices' },
        h('button', { class: 'setup-choice', onclick: () => void createVault() }, h('strong', null, '✨ Start fresh'), h('span', null, 'Create “Omni Notes” in Documents, with a short guided tour.')),
        h('button', { class: 'setup-choice', onclick: () => void openFolder() }, h('strong', null, '📂 Open a folder'), h('span', null, 'Use an existing folder or Obsidian vault. Omni keeps its own data in a hidden .omni folder.'))),
    ));
  };

  // ---- Workspace ------------------------------------------------------------------------------
  const workspace = (): (() => void) => {
    const w = new Disposer();
    const panesEl = h('div', { class: 'panes' });
    const status = h('footer', { class: 'notes-status' });
    const panes: Pane[] = [];
    let activePane = 0;

    const cur = () => panes[activePane];
    const activePath = () => (cur()?.content.kind === 'note' ? (cur().content as { path: string }).path : '');

    const left = sidebar({
      open: (p, o) => open({ kind: 'note', path: p }, o?.newPane),
      openFolder: (p, layout) => open({ kind: 'folder', path: p, layout }),
      newNote: (folder) => void newNote(folder),
      newFromTemplate: (folder) => templatePicker(folder),
      activePath,
      openGraph: () => open({ kind: 'graph' }),
    });
    const right = rightPanel({
      open: (p, o) => open({ kind: 'note', path: p }, o?.newPane),
      openLink: (t) => void openLink(t, activePath(), false),
      scrollToHeading: (t) => cur()?.editor?.scrollToHeading(t),
      comment: () => cur()?.editor?.commentOnSelection(),
      currentPath: activePath,
    });
    w.add(left.dispose);
    w.add(right.dispose);

    const resizer = (side: 'left' | 'right') => {
      const r = h('div', { class: `side-resize ${side}` });
      r.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const sx = e.clientX;
        const sw = side === 'left' ? notesPrefs.get().leftWidth : notesPrefs.get().rightWidth;
        const width = (ev: MouseEvent) => Math.max(180, Math.min(520, sw + (side === 'left' ? ev.clientX - sx : sx - ev.clientX)));
        const mv = (ev: MouseEvent) => root.style.setProperty(side === 'left' ? '--left-w' : '--right-w', `${width(ev)}px`);
        const up = (ev: MouseEvent) => {
          window.removeEventListener('mousemove', mv);
          window.removeEventListener('mouseup', up);
          patchNotesPrefs(side === 'left' ? { leftWidth: width(ev) } : { rightWidth: width(ev) });
        };
        window.addEventListener('mousemove', mv);
        window.addEventListener('mouseup', up);
      });
      return r;
    };

    root.replaceChildren(h('div', { class: 'left-wrap' }, left.el, resizer('left')), panesEl, h('div', { class: 'right-wrap' }, resizer('right'), right.el), status);

    w.add(notesPrefs.subscribe((p) => {
      root.classList.toggle('left-closed', !p.leftOpen);
      root.classList.toggle('right-closed', !p.rightOpen);
      root.style.setProperty('--left-w', `${p.leftWidth}px`);
      root.style.setProperty('--right-w', `${p.rightWidth}px`);
    }));
    w.add(ui.subscribe((u) => root.classList.toggle('focus-mode', u.focus)));
    w.add(ui.subscribe((u) => { if (u.rightTab && !notesPrefs.get().rightOpen) patchNotesPrefs({ rightOpen: true }); }, false));

    // ---- Panes -------------------------------------------------------------------------------
    const makePane = (): Pane => {
      const head = h('div', { class: 'pane-head' });
      const body = h('div', { class: 'pane-body' });
      const p: Pane = { el: h('section', { class: 'pane' }, head, body), head, body, content: { kind: 'empty' }, editor: null, dispose: null, back: [], fwd: [] };
      p.el.addEventListener('mousedown', () => { const i = panes.indexOf(p); if (i >= 0 && i !== activePane) { activePane = i; paintActive(); } }, true);
      return p;
    };

    const paintActive = () => {
      panes.forEach((p, i) => p.el.classList.toggle('active', i === activePane && panes.length > 1));
      right.refresh();
      left.reveal();
      paintStatus();
    };

    const show = (p: Pane, c: Content) => {
      p.dispose?.();
      p.editor = null;
      p.content = c;
      if (c.kind === 'note') {
        const ed = noteEditor(c.path, {
          openLink: (t, o) => void openLink(t, o.from, o.newPane, o.heading),
          openTag: (tag) => { patchNotesPrefs({ leftOpen: true }); left.search(`tag:#${tag}`); },
          onRenamed: (np) => { p.content = { kind: 'note', path: np }; paintHead(p); right.refresh(); },
        });
        p.editor = ed;
        p.dispose = ed.dispose;
        p.body.replaceChildren(ed.el);
      } else if (c.kind === 'folder') {
        const v = folderView(c.path, { open: (path, o) => open({ kind: 'note', path }, o?.newPane), initialLayout: c.layout });
        p.dispose = v.dispose;
        p.body.replaceChildren(v.el);
      } else if (c.kind === 'graph') {
        const center = () => {
          const other = panes.find((x) => x !== p && x.content.kind === 'note') ?? panes.find((x) => x.content.kind === 'note');
          return other ? (other.content as { path: string }).path : notesPrefs.get().recent[0] ?? '';
        };
        const v = graphView({ open: (path, o) => open({ kind: 'note', path }, o?.newPane || panes.length > 1), center, initialMode: c.mode });
        p.dispose = v.dispose;
        p.body.replaceChildren(v.el);
      } else {
        p.dispose = null;
        p.body.replaceChildren(emptyPane());
      }
      paintHead(p);
      paintActive();
    };

    const emptyPane = () => h('div', { class: 'pane-empty' },
      h('h2', null, 'Nothing open'),
      h('div', { class: 'pane-empty-actions' },
        h('button', { class: 'secondary', onclick: () => void newNote(folderOf(activePath())) }, 'New note', h('kbd', null, 'Ctrl N')),
        h('button', { class: 'secondary', onclick: () => templatePicker('') }, 'New from template', h('kbd', null, 'Ctrl Shift N')),
        h('button', { class: 'secondary', onclick: () => quickSwitcher() }, 'Open a note', h('kbd', null, 'Ctrl O')),
        h('button', { class: 'secondary', onclick: () => void dailyNote() }, 'Today’s daily note', h('kbd', null, 'Ctrl Shift D')),
        h('button', { class: 'secondary', onclick: () => open({ kind: 'graph' }) }, 'Graph view', h('kbd', null, 'Ctrl G'))));

    const paintHead = (p: Pane) => {
      const c = p.content;
      const title = c.kind === 'note' ? noteName(c.path) : c.kind === 'folder' ? (c.path || 'All notes') : c.kind === 'graph' ? 'Graph' : '';
      const modeBtns = c.kind === 'note' && p.editor
        ? h('div', { class: 'segmented small' }, ...(['live', 'source', 'reading'] as EditorMode[]).map((m) =>
            h('button', { class: p.editor!.mode() === m ? 'active' : '', title: m === 'live' ? 'Live preview (Ctrl+E)' : m === 'source' ? 'Raw Markdown' : 'Reading view (Ctrl+E)', onclick: () => { p.editor!.setMode(m); paintHead(p); } }, m === 'live' ? 'Edit' : m === 'source' ? 'Source' : 'Read')))
        : null;
      setChildren(p.head,
        h('button', { class: 'icon-btn', title: 'Back (Alt+←)', disabled: !p.back.length, onclick: () => goBack(p) }, '‹'),
        h('button', { class: 'icon-btn', title: 'Forward (Alt+→)', disabled: !p.fwd.length, onclick: () => goFwd(p) }, '›'),
        h('div', { class: 'pane-title' }, c.kind === 'note' && folderOf(c.path) ? h('span', { class: 'muted' }, `${folderOf(c.path)} / `) : null, title),
        modeBtns,
        c.kind === 'note' ? h('button', { class: `icon-btn ${notesPrefs.get().pageView ? 'on' : ''}`, title: 'Page view (Word-style pages)', onclick: () => { patchNotesPrefs({ pageView: !notesPrefs.get().pageView }); paintHead(p); } }, '📄') : null,
        h('button', { class: 'icon-btn', title: 'Split view (Ctrl+\\)', onclick: () => split() }, icon('sidebar', 16)),
        h('button', { class: 'icon-btn', title: 'Focus mode (Ctrl+Shift+Enter)', onclick: () => ui.update((u) => ({ ...u, focus: !u.focus })) }, '◎'),
        c.kind === 'note' ? h('button', { class: 'icon-btn', title: 'More', onclick: (e: MouseEvent) => noteMenu(p, e.currentTarget as HTMLElement) }, '⋯') : null,
        panes.length > 1 ? h('button', { class: 'icon-btn', title: 'Close pane', onclick: () => closePane(p) }, icon('x', 15)) : null,
      );
    };

    const noteMenu = (p: Pane, anchor: HTMLElement) => {
      const path = (p.content as { path: string }).path;
      const item = (label: string, fn: () => void, danger = false) => h('button', { class: `menu-item ${danger ? 'danger' : ''}`, onclick: () => { closePopover(); fn(); } }, label);
      const bm = notesPrefs.get().bookmarks.includes(path);
      const flushThen = (fn: () => void) => () => void p.editor!.flush().then(fn);
      popover(anchor, h('div', { class: 'menu' },
        h('div', { class: 'menu-title' }, 'Export'),
        item('Word document (.docx)', flushThen(() => void exportNote(path, 'docx'))),
        item('PDF (print)', flushThen(() => void exportNote(path, 'pdf'))),
        item('Web page (.html)', flushThen(() => void exportNote(path, 'html'))),
        item('Markdown copy (.md)', flushThen(() => void exportNote(path, 'md'))),
        h('div', { class: 'menu-sep' }),
        item('Take snapshot', flushThen(() => void takeSnapshot(path))),
        item(bm ? 'Remove bookmark' : 'Bookmark', () => patchNotesPrefs({ bookmarks: bm ? notesPrefs.get().bookmarks.filter((x) => x !== path) : [...notesPrefs.get().bookmarks, path] })),
        item('Open local graph', () => open({ kind: 'graph', mode: 'local' }, true)),
        item('Open folder as database', () => open({ kind: 'folder', path: folderOf(path) })),
        item('Show in File Explorer', () => void revealInExplorer(`${vault.get().root}\\${path.replace(/\//g, '\\')}`)),
        h('div', { class: 'menu-sep' }),
        item('Move to trash', async () => { await trashPath(path); show(p, { kind: 'empty' }); }, true),
      ), 'bottom');
    };

    const open = (c: Content, newPane = false) => {
      if (newPane && panes.length < 2) return split(c);
      if (newPane) activePane = activePane === 0 ? 1 : 0;
      const p = cur();
      if (JSON.stringify(p.content) === JSON.stringify(c)) return paintActive();
      if (p.content.kind !== 'empty') { p.back.push(p.content); p.fwd = []; }
      show(p, c);
    };
    const goBack = (p: Pane) => { const c = p.back.pop(); if (c) { p.fwd.push(p.content); show(p, c); } };
    const goFwd = (p: Pane) => { const c = p.fwd.pop(); if (c) { p.back.push(p.content); show(p, c); } };

    const split = (c?: Content) => {
      if (panes.length >= 2) {
        activePane = activePane === 0 ? 1 : 0;
        if (c) open(c);
        else paintActive();
        return;
      }
      const p = makePane();
      panes.push(p);
      panesEl.append(p.el);
      panesEl.classList.add('split');
      activePane = 1;
      show(p, c ?? panes[0].content);
      panes.forEach(paintHead);
    };
    const closePane = (p: Pane) => {
      p.dispose?.();
      panes.splice(panes.indexOf(p), 1);
      p.el.remove();
      panesEl.classList.remove('split');
      activePane = 0;
      panes.forEach(paintHead);
      paintActive();
    };

    const openLink = async (target: string, from: string, newPane = false, heading?: string) => {
      if (!target && heading) { cur()?.editor?.scrollToHeading(heading); return; }
      let p = resolveLink(target, from);
      if (!p) {
        const name = target.split('/').pop() ?? target;
        const folder = target.includes('/') ? folderOf(target) : folderOf(from);
        p = await createNote(folder, name, '');
        toast(`Created “${name}”`, 'success', 1500);
      }
      open({ kind: 'note', path: p }, newPane);
      if (heading) setTimeout(() => cur()?.editor?.scrollToHeading(heading), 300);
    };

    // ---- Commands ------------------------------------------------------------------------------
    const newNote = async (folder: string, name = 'Untitled', content = '') => {
      const p = await createNote(folder, name, content);
      open({ kind: 'note', path: p });
    };

    const dailyNote = async () => {
      const name = new Date().toISOString().slice(0, 10);
      const path = joinRel(notesPrefs.get().dailyFolder, `${name}.md`);
      if (!vault.get().notes.has(path)) {
        const tpl = allTemplates().find((t) => t.id === 'daily')!;
        await writeNote(path, fill(tpl.content, name));
      }
      open({ kind: 'note', path });
    };

    const templatePicker = (folder: string) => {
      const name = h('input', { placeholder: 'Name' });
      let chosen: Template = BUILT_IN[0];
      const grid = h('div', { class: 'tpl-grid' });
      const paint = () => grid.replaceChildren(...allTemplates().map((t) => h('button', { class: `tpl ${t.id === chosen.id ? 'active' : ''}`, onclick: () => { chosen = t; name.value = fill(t.title, ''); paint(); name.focus(); }, ondblclick: () => void create() }, h('span', { class: 'tpl-icon' }, t.icon), h('strong', null, t.name), h('span', { class: 'muted small' }, t.description))));
      const create = async () => {
        close();
        const title = name.value.trim() || fill(chosen.title, '');
        await newNote(folder, title, fill(chosen.content, title));
      };
      paint();
      name.addEventListener('keydown', (e) => e.key === 'Enter' && void create());
      const close = modal(`New note${folder ? ` in ${folder}` : ''}`, h('div', { class: 'stack' }, grid, h('div', { class: 'row' }, name, h('button', { class: 'primary', onclick: () => void create() }, 'Create')),
        h('p', { class: 'muted small' }, `Add your own templates by putting notes in the “${notesPrefs.get().templatesFolder}” folder.`)), { width: 760 });
    };

    const quickSwitcher = () => {
      const input = h('input', { class: 'palette-input', placeholder: 'Find or create a note…' });
      const list = h('div', { class: 'palette-list' });
      const backdrop = h('div', { class: 'palette-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && backdrop.remove() }, h('div', { class: 'palette' }, input, list));
      let sel = 0;
      let items: Array<{ label: string; hint: string; run: (split: boolean) => void }> = [];
      const paint = () => {
        const q = input.value.trim();
        const recent = notesPrefs.get().recent;
        items = [...vault.get().notes.values()]
          .map((n) => ({ n, s: q ? Math.max(fuzzy(q, n.name), fuzzy(q, n.path) - 10) : 100 - (recent.indexOf(n.path) < 0 ? 50 : recent.indexOf(n.path)) }))
          .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40)
          .map(({ n }) => ({ label: n.name, hint: n.folder, run: (s: boolean) => open({ kind: 'note', path: n.path }, s) }));
        if (q && !items.some((i) => i.label.toLowerCase() === q.toLowerCase())) items.push({ label: `Create “${q}”`, hint: 'new note', run: () => void newNote(folderOf(activePath()), q) });
        sel = Math.max(0, Math.min(sel, items.length - 1));
        list.replaceChildren(...items.map((it, i) => h('button', { class: `palette-item ${i === sel ? 'active' : ''}`, onclick: (e: MouseEvent) => { backdrop.remove(); it.run(e.ctrlKey); } }, h('span', null, it.label), h('span', { class: 'muted small' }, it.hint))));
        (list.querySelector('.active') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
      };
      input.addEventListener('input', () => { sel = 0; paint(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; backdrop.remove(); it?.run(e.ctrlKey); }
        else if (e.key === 'Escape') backdrop.remove();
      });
      document.body.appendChild(backdrop);
      paint();
      input.focus();
    };

    // ---- Status bar -----------------------------------------------------------------------------
    const paintStatus = () => {
      const a = active.get();
      const p = activePath();
      const target = Number(vault.get().notes.get(p)?.props.target) || 0;
      const sess = notesPrefs.get().sessionTarget;
      setChildren(status,
        h('button', { class: 'status-btn', title: 'Toggle left sidebar', onclick: () => patchNotesPrefs({ leftOpen: !notesPrefs.get().leftOpen }) }, icon('sidebar', 14)),
        h('span', { class: 'muted', title: vault.get().root }, `📁 ${vault.get().root.split(/[\\/]/).pop()}`),
        h('button', { class: 'status-btn', title: 'Use a different notes folder', onclick: async () => { const f = await pickFolder('Open another notes folder'); if (f) { patchNotesPrefs({ root: f, recent: [] }); w.dispose(); void start(); } } }, 'Change'),
        h('div', { class: 'spacer' }),
        p ? h('span', null, `${a.words.toLocaleString()} words`) : null,
        p ? h('span', { class: 'muted' }, `${a.chars.toLocaleString()} characters`) : null,
        p && target ? h('span', { class: 'status-target', title: 'Note target' }, h('span', { class: 'mini-target' }, h('span', { style: { width: `${Math.min(100, (a.words / target) * 100)}%` } })), `${Math.round((a.words / target) * 100)}%`) : null,
        sess ? h('span', { class: 'status-target', title: 'Words written this session' }, '✍️', h('span', { class: 'mini-target' }, h('span', { style: { width: `${Math.min(100, (a.sessionWords / sess) * 100)}%` } })), `${a.sessionWords}/${sess}`) : null,
        p ? h('span', { class: 'muted' }, a.saving ? 'Saving…' : a.dirty ? 'Edited' : 'Saved') : null,
        h('button', { class: 'status-btn', title: 'Toggle right sidebar', onclick: () => patchNotesPrefs({ rightOpen: !notesPrefs.get().rightOpen }) }, icon('sidebar', 14)),
      );
    };
    w.add(active.subscribe(paintStatus, false));

    // ---- Keyboard & external changes ---------------------------------------------------------------
    const onKey = (e: KeyboardEvent) => {
      if (!root.isConnected || root.closest('[hidden]') || document.querySelector('.modal-backdrop, .palette-backdrop')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && !e.shiftKey && k === 'n') { e.preventDefault(); void newNote(folderOf(activePath())); }
      else if (ctrl && e.shiftKey && k === 'n') { e.preventDefault(); templatePicker(folderOf(activePath())); }
      else if (ctrl && k === 'o') { e.preventDefault(); quickSwitcher(); }
      else if (ctrl && e.shiftKey && k === 'f') { e.preventDefault(); patchNotesPrefs({ leftOpen: true }); left.search(''); }
      else if (ctrl && e.shiftKey && k === 'd') { e.preventDefault(); void dailyNote(); }
      else if (ctrl && k === 'g') { e.preventDefault(); open({ kind: 'graph' }); }
      else if (ctrl && e.key === '\\') { e.preventDefault(); split(); }
      else if (ctrl && k === 'e') { e.preventDefault(); const ed = cur()?.editor; if (ed) { ed.setMode(ed.mode() === 'reading' ? 'live' : 'reading'); paintHead(cur()); } }
      else if (ctrl && k === 's') { e.preventDefault(); void cur()?.editor?.flush().then(() => toast('Saved', 'success', 900)); }
      else if (ctrl && e.shiftKey && e.key === 'Enter') { e.preventDefault(); ui.update((u) => ({ ...u, focus: !u.focus })); }
      else if (e.key === 'Escape' && ui.get().focus && !(e.target as HTMLElement).closest?.('textarea')) ui.update((u) => ({ ...u, focus: false }));
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(cur()); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goFwd(cur()); }
    };
    window.addEventListener('keydown', onKey);
    w.add(() => window.removeEventListener('keydown', onKey));
    const onFocus = debounce(() => void refreshFromDisk().catch(() => {}), 400);
    window.addEventListener('focus', onFocus);
    w.add(() => window.removeEventListener('focus', onFocus));
    w.add(() => panes.forEach((p) => p.dispose?.()));

    // ---- Start ------------------------------------------------------------------------------------
    const first = makePane();
    panes.push(first);
    panesEl.append(first.el);
    const last = notesPrefs.get().recent.find((p) => vault.get().notes.has(p));
    show(first, last ? { kind: 'note', path: last } : { kind: 'empty' });
    return () => w.dispose();
  };

  void start();
  return () => d.dispose();
}
