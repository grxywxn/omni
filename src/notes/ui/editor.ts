import { h, toast, popover, closePopover, setChildren } from '../../core/dom';
import { Disposer, debounce } from '../../core/store';
import { openExternal } from '../../core/native';
import * as fm from '../frontmatter';
import { render, renderMath, plainText, wordCount, slug, IMAGE_EXT } from '../markdown';
import { splitBlocks, joinBlocks, toggleTask } from '../blocks';
import { vault, changes, readNote, writeNote, resolveLink, linkTextFor, renamePath, fileUrlSync, saveAttachment } from '../vault';
import { folderOf, joinRel, noteName, safeFileName } from '../fs';
import { notesPrefs, pushRecent, type EditorMode } from '../prefs';
import { comments, loadComments, addComment, moveComments } from '../comments';
import { active, sessionStart, ui } from '../state';
import { SLASH } from './slash';
import { propertiesBlock } from './properties';
import { mapWidget } from './map';
import { Suggest, fuzzy, caretCoords, autosize, insertText, toggleWrap, setLinePrefix, continueList, indentLines } from './textedit';

export interface EditorOptions {
  openLink: (target: string, o: { newPane: boolean; heading?: string; from: string }) => void;
  openTag: (tag: string) => void;
  onRenamed: (newPath: string) => void;
}

export interface NoteEditor {
  el: HTMLElement;
  path: () => string;
  setMode: (m: EditorMode) => void;
  mode: () => EditorMode;
  scrollToHeading: (text: string) => void;
  commentOnSelection: () => void;
  flush: () => Promise<void>;
  dispose: () => void;
}

let editorSeq = 0;

export function noteEditor(initialPath: string, opts: EditorOptions): NoteEditor {
  const id = `ed${++editorSeq}`;
  const d = new Disposer();
  let path = initialPath;
  let text = '';
  let blocks: string[] = [];
  let mode: EditorMode = notesPrefs.get().defaultMode;
  let editing = -1;
  let ta: HTMLTextAreaElement | null = null; // the textarea being edited
  let dirty = false;
  let loaded = false;
  const history: string[] = [];
  const future: string[] = [];
  const suggest = new Suggest();
  let suggestOwner: HTMLTextAreaElement | null = null; // which textarea the open menu belongs to
  d.add(() => suggest.destroy());

  // ---- DOM ------------------------------------------------------------------------
  const titleInput = h('input', { class: 'note-title', spellcheck: 'false', 'aria-label': 'Note title' });
  const crumbs = h('div', { class: 'note-crumbs' });
  const propsSlot = h('div', { class: 'props-slot' });
  const mapSlot = h('div', { class: 'map-slot' });
  const bodyEl = h('div', { class: 'note-body' });
  const toolbar = h('div', { class: 'note-toolbar' });
  const page = h('div', { class: 'note-page' }, crumbs, titleInput, propsSlot, mapSlot, bodyEl);
  const scroller = h('div', { class: 'note-scroll' }, page);
  const el = h('div', { class: 'note-editor' }, toolbar, scroller);

  const ctx = () => ({
    resolve: (t: string) => resolveLink(t, path),
    fileUrl: (p: string) => fileUrlSync(p),
    notePath: path,
    commentQuotes: comments.get().path === path ? comments.get().list.filter((c) => !c.resolved).map((c) => ({ id: c.id, quote: c.quote })) : [],
  });

  const body = () => (mode === 'source' && sourceTa ? sourceTa.value : joinBlocks(blocks));
  const fullText = () => fm.setBody(text, body());
  const syncText = () => (text = fullText());

  const applyPrefs = () => {
    const p = notesPrefs.get();
    el.classList.toggle('readable', p.readableWidth);
    el.classList.toggle('page-view', p.pageView);
    el.dataset.page = p.pageSize;
    el.style.setProperty('--note-size', `${p.editorSize}px`);
    if (p.editorFont) el.style.setProperty('--note-font', p.editorFont);
    else el.style.removeProperty('--note-font');
    el.style.setProperty('--page-font', p.pageFont);
    toolbar.hidden = !p.showToolbar || mode === 'reading';
  };
  d.add(notesPrefs.subscribe(applyPrefs));

  // ---- Stats & saving ------------------------------------------------------------------
  const publishStats = () => {
    const b = body();
    const words = wordCount(b);
    if (!sessionStart.has(path)) sessionStart.set(path, words);
    const written = [...sessionStart.entries()].reduce((s, [p, w0]) => s + Math.max(0, (p === path ? words : vault.get().notes.get(p)?.words ?? w0) - w0), 0);
    active.set({ path, words, chars: b.replace(/\s/g, '').length, saving: active.get().saving, dirty, sessionWords: written });
  };

  const save = async () => {
    if (!dirty || !loaded) return;
    syncText();
    dirty = false;
    active.update((a) => ({ ...a, saving: true, dirty: false }));
    try {
      await writeNote(path, text, id);
    } catch (e) {
      dirty = true;
      toast(`Couldn't save: ${(e as Error).message}`, 'error', 6000);
    } finally {
      active.update((a) => ({ ...a, saving: false }));
    }
  };
  const scheduleSave = debounce(() => void save(), 700);
  const markDirty = () => {
    dirty = true;
    active.update((a) => ({ ...a, dirty: true }));
    scheduleSave();
    publishStats();
  };

  const pushHistory = () => {
    const b = joinBlocks(blocks);
    if (history[history.length - 1] !== b) {
      history.push(b);
      if (history.length > 200) history.shift();
      future.length = 0;
    }
  };

  // ---- Rendering ------------------------------------------------------------------------
  const fillEmbeds = (root: HTMLElement) => {
    root.querySelectorAll<HTMLElement>('.embed[data-embed]').forEach((em) => {
      const target = em.dataset.embed!;
      const p = resolveLink(target, path);
      const title = em.querySelector('.embed-title') as HTMLElement;
      const bodyBox = em.querySelector('.embed-body') as HTMLElement;
      if (!p) {
        bodyBox.textContent = 'Note not found';
        return;
      }
      title.onclick = (e) => { e.stopPropagation(); opts.openLink(target, { newPane: false, from: path }); };
      let src = fm.body(vault.get().notes.get(p)?.text ?? '');
      const hd = em.dataset.heading;
      if (hd) {
        const lines = src.split('\n');
        const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim().toLowerCase() === hd.toLowerCase());
        if (start >= 0) {
          const lvl = /^#+/.exec(lines[start])![0].length;
          const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && /^#+/.exec(l)![0].length <= lvl);
          src = lines.slice(start, end < 0 ? undefined : end).join('\n');
        }
      }
      bodyBox.innerHTML = render(src.replace(/!\[\[(?![^\]]*\.(png|jpe?g|gif|webp|svg))/gi, '[['), { ...ctx(), notePath: p, commentQuotes: [] });
    });
  };

  const decorate = (root: HTMLElement) => {
    fillEmbeds(root);
    void renderMath(root);
  };

  const renderBlockContent = (i: number) => {
    const c = h('div', { class: 'block-content' });
    c.innerHTML = render(blocks[i], ctx());
    if (!c.textContent!.trim() && !c.querySelector('img,hr,input,.embed,.math')) c.classList.add('empty-block');
    decorate(c);
    return c;
  };

  const blockEl = (i: number) => {
    const grip = h('span', { class: 'block-grip', draggable: 'true', title: 'Drag to move · click for options' }, '⋮⋮');
    const b = h('div', { class: 'block', dataset: { i: String(i) } }, grip, renderBlockContent(i));
    grip.addEventListener('dragstart', (e) => {
      dragFrom = i;
      e.dataTransfer?.setData('text/plain', String(i));
      b.classList.add('dragging');
    });
    grip.addEventListener('dragend', () => b.classList.remove('dragging'));
    grip.addEventListener('click', (e) => blockMenu(i, e.currentTarget as HTMLElement));
    b.addEventListener('dragover', (e) => { if (dragFrom >= 0) { e.preventDefault(); b.classList.add('drop-target'); } });
    b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('drop-target');
      if (dragFrom < 0 || dragFrom === i) return;
      pushHistory();
      const [moved] = blocks.splice(dragFrom, 1);
      blocks.splice(dragFrom < i ? i - 1 : i, 0, moved);
      dragFrom = -1;
      renderBody();
      markDirty();
    });
    return b;
  };
  let dragFrom = -1;

  let sourceTa: HTMLTextAreaElement | null = null;

  const renderBody = () => {
    editing = -1;
    ta = null;
    sourceTa = null;
    if (mode === 'live') {
      bodyEl.replaceChildren(...blocks.map((_, i) => blockEl(i)), h('div', { class: 'block-add', title: 'Click to write', onclick: () => newBlockAt(blocks.length, '') }));
    } else if (mode === 'source') {
      const t = h('textarea', { class: 'source-ta', spellcheck: String(notesPrefs.get().spellcheck) }, joinBlocks(blocks).replace(/\n$/, ''));
      sourceTa = t;
      wireTextarea(t, true);
      bodyEl.replaceChildren(t);
      requestAnimationFrame(() => autosize(t));
    } else {
      const c = h('div', { class: 'reading' });
      c.innerHTML = render(joinBlocks(blocks), ctx());
      decorate(c);
      bodyEl.replaceChildren(c);
    }
  };

  const renderHeader = () => {
    titleInput.value = noteName(path);
    const folder = folderOf(path);
    setChildren(crumbs, folder ? folder.split('/').map((f, i) => [i ? h('span', { class: 'sep' }, '/') : null, h('span', null, f)]) : null);
    propsSlot.replaceChildren(propertiesBlock(text, path, (patch) => {
      syncText();
      text = fm.updateProps(text, patch);
      dirty = true;
      void save();
      renderHeader();
    }));
    const props = fm.props(text);
    mapSlot.replaceChildren(
      ...(props.type === 'map'
        ? [mapWidget(text, path, (pins) => {
            syncText();
            text = fm.updateProps(text, { pins: pins.map((p) => ({ x: p.x, y: p.y, ...(p.note ? { note: p.note } : {}), ...(p.label ? { label: p.label } : {}) })) });
            dirty = true;
            void save();
          }, (t) => opts.openLink(t, { newPane: false, from: path }))]
        : []),
    );
  };

  const renderAll = () => {
    el.className = `note-editor mode-${mode}`;
    applyPrefs();
    renderHeader();
    renderBody();
    renderToolbar();
    publishStats();
  };

  // ---- Block editing ----------------------------------------------------------------------
  const commit = () => {
    if (editing < 0 || !ta) return;
    const i = editing;
    const parts = splitBlocks(ta.value);
    const before = blocks.slice();
    blocks.splice(i, 1, ...parts);
    editing = -1;
    ta = null;
    suggest.close();
    if (JSON.stringify(before) !== JSON.stringify(blocks)) pushHistory();
    renderBody();
  };

  const editBlock = (i: number, caret: number | 'start' | 'end' = 'end') => {
    if (mode !== 'live') return;
    if (editing === i && ta) return;
    if (editing >= 0) {
      // Commit without re-rendering everything twice.
      const cur = editing;
      const parts = splitBlocks(ta!.value);
      blocks.splice(cur, 1, ...parts);
      if (cur < i) i += parts.length - 1;
      editing = -1;
      ta = null;
      renderBody();
    }
    if (i >= blocks.length) i = blocks.length - 1;
    if (i < 0) return newBlockAt(0, '');
    const host = bodyEl.querySelector<HTMLElement>(`.block[data-i="${i}"]`);
    if (!host) return;
    const t = h('textarea', { class: 'block-ta', rows: '1', spellcheck: String(notesPrefs.get().spellcheck) }, blocks[i]);
    host.classList.add('editing');
    host.querySelector('.block-content')!.replaceWith(t);
    editing = i;
    ta = t;
    wireTextarea(t, false);
    autosize(t);
    t.focus();
    const pos = caret === 'start' ? 0 : caret === 'end' ? t.value.length : Math.max(0, Math.min(t.value.length, caret));
    t.setSelectionRange(pos, pos);
    if (document.querySelector('.notes-root.focus-mode')) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const newBlockAt = (i: number, content: string) => {
    if (mode !== 'live') return;
    if (editing >= 0 && ta) {
      const parts = splitBlocks(ta.value);
      blocks.splice(editing, 1, ...parts);
      if (editing < i) i += parts.length - 1;
      editing = -1;
      ta = null;
    }
    pushHistory();
    blocks.splice(i, 0, content);
    renderBody();
    editBlock(i, 'end');
  };

  /** Guess where in the Markdown source a click on the rendered text landed. */
  const caretFromClick = (e: MouseEvent, i: number, contentEl: HTMLElement): number => {
    const src = blocks[i];
    const pos = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!pos || !contentEl.contains(pos.startContainer)) return src.length;
    const r = document.createRange();
    r.setStart(contentEl, 0);
    r.setEnd(pos.startContainer, pos.startOffset);
    const before = r.toString();
    const tail = before.slice(-14);
    if (!tail) return 0;
    const idx = src.indexOf(tail);
    if (idx >= 0) return idx + tail.length;
    const words = tail.trim().split(/\s+/).pop() ?? '';
    const j = words ? src.indexOf(words) : -1;
    return j >= 0 ? j + words.length : src.length;
  };

  bodyEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLElement>('a.wikilink');
    if (link) {
      e.preventDefault();
      opts.openLink(link.dataset.href ?? '', { newPane: e.ctrlKey || e.metaKey, heading: link.dataset.heading || undefined, from: path });
      return;
    }
    const ext = target.closest<HTMLAnchorElement>('a.external, a[href^="http"]');
    if (ext) {
      e.preventDefault();
      void openExternal(ext.dataset.external ?? ext.href);
      return;
    }
    const tag = target.closest<HTMLElement>('a.tag');
    if (tag) {
      e.preventDefault();
      opts.openTag(tag.dataset.tag!);
      return;
    }
    const mark = target.closest<HTMLElement>('mark.comment-mark');
    if (mark) {
      ui.update((u) => ({ ...u, rightTab: 'comments', commentFocus: mark.dataset.comment ?? null }));
    }
    if (target.closest('summary') || target.closest('.embed-title')) return;
    const blockHost = target.closest<HTMLElement>('.block');
    if (!blockHost || mode !== 'live') return;
    const i = Number(blockHost.dataset.i);
    if (target instanceof HTMLInputElement && target.classList.contains('task')) {
      e.preventDefault();
      pushHistory();
      blocks[i] = toggleTask(blocks[i], Number(target.dataset.task));
      const fresh = blockEl(i);
      blockHost.replaceWith(fresh);
      markDirty();
      return;
    }
    if (target.closest('.block-grip') || blockHost.classList.contains('editing')) return;
    if (window.getSelection()?.toString()) return; // selecting text to comment on
    const content = blockHost.querySelector<HTMLElement>('.block-content');
    editBlock(i, content ? caretFromClick(e, i, content) : 'end');
  });

  // Reading mode: checkboxes still work.
  bodyEl.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (mode !== 'reading' || !t.classList.contains('task')) return;
    pushHistory();
    const whole = joinBlocks(blocks);
    blocks = splitBlocks(toggleTask(whole, Number(t.dataset.task)));
    markDirty();
  });

  // ---- Textarea behaviour (shared by block editing and Source mode) ----------------------------
  const wireTextarea = (t: HTMLTextAreaElement, isSource: boolean) => {
    t.addEventListener('input', () => {
      autosize(t);
      if (!isSource && editing >= 0) blocks[editing] = t.value;
      markDirty();
      triggerSuggest(t);
    });
    t.addEventListener('keydown', (e) => onKey(e, t, isSource));
    t.addEventListener('blur', (e) => {
      const to = e.relatedTarget as HTMLElement | null;
      if (to && (toolbar.contains(to) || suggest.el.contains(to))) return;
      setTimeout(() => {
        if (document.activeElement === t) return;
        if (suggestOwner === t) suggest.close();
        if (!isSource && ta === t) commit();
      }, 120);
    });
    t.addEventListener('paste', (e) => void onPaste(e, t));
    t.addEventListener('drop', (e) => void onDrop(e, t));
  };

  const onKey = (e: KeyboardEvent, t: HTMLTextAreaElement, isSource: boolean) => {
    if (suggest.key(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleWrap(t, '**'); return; }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); toggleWrap(t, '*'); return; }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'u') { e.preventDefault(); toggleWrap(t, '<u>', '</u>'); return; }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); toggleWrap(t, '=='); return; }
    if (ctrl && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); insertLink(t); return; }
    if (ctrl && e.key === '`') { e.preventDefault(); toggleWrap(t, '`'); return; }
    if (e.key === 'Tab') { e.preventDefault(); indentLines(t, e.shiftKey); return; }
    if (isSource) {
      if (e.key === 'Enter' && !e.shiftKey && continueList(t)) e.preventDefault();
      return;
    }
    const v = t.value;
    const pos = t.selectionStart;
    const noSel = pos === t.selectionEnd;
    const inFence = /^\s*(```|~~~|\$\$)/.test(v);
    if (e.key === 'Escape') { e.preventDefault(); commit(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !inFence) {
      if (continueList(t)) { e.preventDefault(); return; }
      if (noSel && pos === v.length && !/^\|/.test(v.split('\n').pop() ?? '')) {
        // Enter at the end of a block starts a new block (Notion-style). Shift+Enter = new line.
        e.preventDefault();
        newBlockAt(editing + 1, '');
        return;
      }
    }
    if (e.key === 'Backspace' && noSel && pos === 0 && editing > 0) {
      e.preventDefault();
      const i = editing;
      const cur = v;
      const prevLen = blocks[i - 1].length;
      pushHistory();
      blocks.splice(i, 1);
      editing = -1;
      ta = null;
      if (cur.trim()) blocks[i - 1] = `${blocks[i - 1]}\n${cur}`;
      renderBody();
      editBlock(i - 1, prevLen + (cur.trim() ? 1 : 0));
      markDirty();
      return;
    }
    if (e.key === 'ArrowUp' && noSel && !v.slice(0, pos).includes('\n') && editing > 0) { e.preventDefault(); editBlock(editing - 1, 'end'); return; }
    if (e.key === 'ArrowDown' && noSel && !v.slice(pos).includes('\n') && editing < blocks.length - 1) { e.preventDefault(); editBlock(editing + 1, 'start'); return; }
  };

  const triggerSuggest = (t: HTMLTextAreaElement) => {
    suggestOwner = t;
    const before = t.value.slice(0, t.selectionStart);
    const link = /(!?)\[\[([^\]\n]*)$/.exec(before);
    if (link) {
      const q = link[2];
      const embed = link[1] === '!';
      const notes = [...vault.get().notes.values()].map((n) => ({ label: n.name, hint: n.folder, path: n.path, s: fuzzy(q, n.name) }));
      const files = embed ? vault.get().entries.filter((x) => !x.is_dir && IMAGE_EXT.test(x.path)).map((f) => ({ label: f.path.split('/').pop()!, hint: '🖼 image', path: f.path, s: fuzzy(q, f.path) })) : [];
      const items = [...files, ...notes].filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 30).map((x) => ({
        label: x.label, hint: x.hint, icon: x.hint.startsWith('🖼') ? '🖼' : '📄',
        run: () => {
          const linkText = /\.md$/i.test(x.path) ? linkTextFor(x.path) : x.label;
          t.setSelectionRange(t.selectionStart - q.length, t.selectionStart);
          const closing = t.value.slice(t.selectionEnd, t.selectionEnd + 2) === ']]' ? '' : ']]';
          insertText(t, `${linkText}${closing}`);
          if (!closing) t.setSelectionRange(t.selectionStart + 2, t.selectionStart + 2);
        },
      }));
      if (q && !items.some((i) => i.label.toLowerCase() === q.toLowerCase()) && !embed) {
        items.push({ label: `Create “${q}”`, hint: 'new note', icon: '＋', run: () => { insertText(t, ']]'); } });
      }
      suggest.show(caretCoords(t), items);
      return;
    }
    const slash = /(^|\s)\/([\w-]*)$/.exec(before.split('\n').pop() ?? '');
    if (slash) {
      const q = slash[2];
      const items = SLASH.map((c) => ({ c, s: Math.max(fuzzy(q, c.label), fuzzy(q, c.keywords) - 20) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map(({ c }) => ({
        label: c.label, icon: c.icon,
        run: () => {
          t.setSelectionRange(t.selectionStart - q.length - 1, t.selectionStart);
          const txt = c.id === 'date' ? new Date().toISOString().slice(0, 10) + '|' : c.text;
          const at = txt.indexOf('|');
          insertText(t, txt.replace('|', ''));
          if (at >= 0) {
            const end = t.selectionStart;
            const pos = end - (txt.length - 1 - at);
            t.setSelectionRange(pos, pos);
          }
          autosize(t);
          if (c.id === 'link' || c.id === 'embed' || c.id === 'image') triggerSuggest(t);
        },
      }));
      suggest.show(caretCoords(t), items);
      return;
    }
    suggest.close();
  };

  const insertLink = (t: HTMLTextAreaElement) => {
    const sel = t.value.slice(t.selectionStart, t.selectionEnd);
    if (/^https?:\/\//.test(sel)) insertText(t, `[](${sel})`, 1, 1);
    else if (sel) insertText(t, `[${sel}](https://)`, sel.length + 3, sel.length + 11);
    else { insertText(t, '[[]]', 2, 2); triggerSuggest(t); }
  };

  const onPaste = async (e: ClipboardEvent, t: HTMLTextAreaElement) => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    try {
      const p = await saveAttachment(file);
      insertText(t, `![[${p.split('/').pop()}]]`);
    } catch (err) {
      toast(`Couldn't save the image: ${(err as Error).message}`, 'error');
    }
  };

  const onDrop = async (e: DragEvent, t: HTMLTextAreaElement) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const p = await saveAttachment(f, f.name);
      insertText(t, `![[${p.split('/').pop()}]]\n`);
    }
  };

  // ---- Block menu (click the ⋮⋮ grip) ------------------------------------------------------------
  const blockMenu = (i: number, anchor: HTMLElement) => {
    const item = (label: string, fn: () => void) => h('button', { class: 'menu-item', onclick: () => { closePopover(); fn(); } }, label);
    const turn = (prefix: string) => () => { pushHistory(); blocks[i] = blocks[i].split('\n').map((l) => prefix + l.replace(/^(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, '')).join('\n'); renderBody(); markDirty(); };
    popover(anchor, h('div', { class: 'menu' },
      h('div', { class: 'menu-title' }, 'Turn into'),
      item('Text', turn('')), item('Heading 1', turn('# ')), item('Heading 2', turn('## ')), item('Heading 3', turn('### ')),
      item('Bulleted list', turn('- ')), item('To-do list', turn('- [ ] ')), item('Quote', turn('> ')),
      h('div', { class: 'menu-sep' }),
      item('Duplicate', () => { pushHistory(); blocks.splice(i + 1, 0, blocks[i]); renderBody(); markDirty(); }),
      item('Add block below', () => newBlockAt(i + 1, '')),
      item('Move up', () => { if (i > 0) { pushHistory(); [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]]; renderBody(); markDirty(); } }),
      item('Move down', () => { if (i < blocks.length - 1) { pushHistory(); [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]]; renderBody(); markDirty(); } }),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item danger', onclick: () => { closePopover(); pushHistory(); blocks.splice(i, 1); renderBody(); markDirty(); } }, 'Delete block'),
    ), 'right');
  };

  // ---- Formatting toolbar (Word-style) --------------------------------------------------------------
  const withTa = (fn: (t: HTMLTextAreaElement) => void) => () => {
    const t = ta ?? sourceTa;
    if (t) { fn(t); t.focus(); return; }
    if (mode === 'live') {
      newBlockAt(blocks.length, '');
      if (ta) fn(ta);
    }
  };
  const tb = (label: HTMLElement | string, title: string, fn: () => void) =>
    h('button', { class: 'tb-btn', title, onmousedown: (e: Event) => e.preventDefault(), onclick: fn }, label);

  const renderToolbar = () => {
    const style = h('select', { class: 'tb-style', title: 'Paragraph style', onmousedown: (e: Event) => e.stopPropagation() },
      ...[['p', 'Normal text'], ['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['quote', 'Quote'], ['code', 'Code']].map(([v, l]) => h('option', { value: v }, l)));
    style.addEventListener('change', () => {
      const v = style.value;
      withTa((t) => {
        if (v === 'code') return toggleWrap(t, '```\n', '\n```');
        setLinePrefix(t, v === 'p' ? '' : v === 'quote' ? '> ' : `${'#'.repeat(Number(v[1]))} `);
      })();
      style.value = 'p';
    });
    const color = h('input', { type: 'color', class: 'tb-color', value: '#e03e3e', title: 'Text colour' });
    color.addEventListener('change', () => withTa((t) => toggleWrap(t, `<span style="color:${color.value}">`, '</span>'))());
    toolbar.replaceChildren(
      style,
      h('span', { class: 'tb-sep' }),
      tb(h('b', null, 'B'), 'Bold (Ctrl+B)', withTa((t) => toggleWrap(t, '**'))),
      tb(h('i', null, 'I'), 'Italic (Ctrl+I)', withTa((t) => toggleWrap(t, '*'))),
      tb(h('u', null, 'U'), 'Underline (Ctrl+U)', withTa((t) => toggleWrap(t, '<u>', '</u>'))),
      tb(h('s', null, 'S'), 'Strikethrough', withTa((t) => toggleWrap(t, '~~'))),
      tb(h('mark', null, 'H'), 'Highlight (Ctrl+Shift+H)', withTa((t) => toggleWrap(t, '=='))),
      h('label', { class: 'tb-btn tb-color-wrap', title: 'Text colour' }, h('span', { class: 'tb-a' }, 'A'), color),
      tb(h('code', null, '<>'), 'Inline code', withTa((t) => toggleWrap(t, '`'))),
      tb('🔗', 'Link (Ctrl+K)', withTa(insertLink)),
      h('span', { class: 'tb-sep' }),
      tb('•', 'Bulleted list', withTa((t) => setLinePrefix(t, '- '))),
      tb('1.', 'Numbered list', withTa((t) => setLinePrefix(t, (i) => `${i + 1}. `))),
      tb('☑', 'To-do list', withTa((t) => setLinePrefix(t, '- [ ] '))),
      tb('💡', 'Callout', withTa((t) => insertText(t, '> [!note] Title\n> ', 10, 15))),
      tb('▦', 'Table', withTa((t) => insertText(t, '| Column 1 | Column 2 |\n| --- | --- |\n| | |'))),
      tb('—', 'Divider', () => newBlockAt(editing >= 0 ? editing + 1 : blocks.length, '---')),
      h('span', { class: 'tb-sep' }),
      tb('💬', 'Comment on selected text', () => commentOnSelection()),
      tb('↶', 'Undo (Ctrl+Z)', undo),
      tb('↷', 'Redo (Ctrl+Y)', redo),
    );
  };

  const undo = () => {
    if (editing >= 0) commit();
    const prev = history.pop();
    if (prev === undefined) return;
    future.push(joinBlocks(blocks));
    blocks = splitBlocks(prev);
    renderBody();
    markDirty();
  };
  const redo = () => {
    const next = future.pop();
    if (next === undefined) return;
    history.push(joinBlocks(blocks));
    blocks = splitBlocks(next);
    renderBody();
    markDirty();
  };

  const onDocKey = (e: KeyboardEvent) => {
    if (!el.isConnected || el.closest('[hidden]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName);
    if (typing || !el.contains(document.activeElement) && document.activeElement !== document.body) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  };
  window.addEventListener('keydown', onDocKey);
  d.add(() => window.removeEventListener('keydown', onDocKey));

  // ---- Comments ------------------------------------------------------------------------------------
  const commentOnSelection = () => {
    let quote = '';
    if (ta && ta.selectionStart !== ta.selectionEnd) quote = plainText(ta.value.slice(ta.selectionStart, ta.selectionEnd)).replace(/\n/g, ' ');
    else quote = window.getSelection()?.toString().trim() ?? '';
    if (!quote) return toast('Select some text first, then click 💬', 'info');
    quote = quote.slice(0, 300);
    const input = h('textarea', { rows: '3', placeholder: 'Add a comment…', class: 'comment-input' });
    const box = h('div', { class: 'menu comment-pop' }, h('div', { class: 'muted comment-quote' }, `“${quote}”`), input,
      h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: async () => {
        if (!input.value.trim()) return;
        closePopover();
        await addComment(path, quote, input.value.trim());
        if (editing >= 0) commit(); else renderBody();
        ui.update((u) => ({ ...u, rightTab: 'comments' }));
      } }, 'Comment')));
    popover(toolbar.querySelector('[title^="Comment"]') as HTMLElement ?? toolbar, box, 'bottom');
    input.focus();
  };

  // ---- Title / rename -----------------------------------------------------------------------------
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
    if (e.key === 'ArrowDown' && mode === 'live') { e.preventDefault(); blocks.length ? editBlock(0, 'start') : newBlockAt(0, ''); }
  });
  titleInput.addEventListener('change', async () => {
    const name = safeFileName(titleInput.value);
    if (!name || name === noteName(path)) { titleInput.value = noteName(path); return; }
    await flush();
    const to = joinRel(folderOf(path), `${name}.md`);
    try {
      const from = path;
      path = await renamePath(from, to);
      await moveComments(from, path);
      opts.onRenamed(path);
      pushRecent(path);
      renderHeader();
    } catch (e) {
      toast((e as Error).message, 'error');
      titleInput.value = noteName(path);
    }
  });

  // ---- External changes --------------------------------------------------------------------------------
  d.add(changes.subscribe((c) => {
    if (!c || c.path !== path || c.by === id || !loaded) return;
    const latest = vault.get().notes.get(path)?.text;
    if (latest === undefined || latest === fullText()) return;
    if (dirty || editing >= 0) {
      toast(`“${noteName(path)}” changed elsewhere — keeping your edits.`, 'info', 4000);
      return;
    }
    text = latest;
    blocks = splitBlocks(fm.body(text));
    renderHeader();
    renderBody();
    publishStats();
  }, false));
  d.add(comments.subscribe((c) => { if (c.path === path && loaded && editing < 0 && mode !== 'source') renderBody(); }, false));

  // ---- Load ------------------------------------------------------------------------------------------
  const load = async () => {
    try {
      text = await readNote(path);
    } catch (e) {
      bodyEl.replaceChildren(h('div', { class: 'empty' }, (e as Error).message));
      return;
    }
    blocks = splitBlocks(fm.body(text));
    loaded = true;
    pushRecent(path);
    await loadComments(path).catch(() => {});
    renderAll();
    if (!blocks.length && mode === 'live') {
      if (noteName(path).startsWith('Untitled')) { titleInput.focus(); titleInput.select(); }
    }
  };
  void load();

  async function flush(): Promise<void> {
    if (editing >= 0 && ta) {
      blocks[editing] = ta.value;
    }
    if (dirty) await save();
  }

  const setMode = (m: EditorMode) => {
    if (m === mode) return;
    if (mode === 'source' && sourceTa) blocks = splitBlocks(sourceTa.value);
    if (editing >= 0) commit();
    mode = m;
    renderAll();
  };

  const scrollToHeading = (textH: string) => {
    if (mode === 'reading') {
      bodyEl.querySelector(`#${CSS.escape(slug(textH))}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const i = blocks.findIndex((b) => /^#{1,6}\s/.test(b) && b.replace(/^#+\s*/, '').trim() === textH.trim());
    if (i >= 0) bodyEl.querySelector(`.block[data-i="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return {
    el,
    path: () => path,
    setMode,
    mode: () => mode,
    scrollToHeading,
    commentOnSelection,
    flush,
    dispose: () => {
      void flush();
      d.dispose();
    },
  };
}

