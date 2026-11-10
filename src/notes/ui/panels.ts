// Right sidebar panels for the current note.
import { h, icon, toast, modal, confirmDialog, setChildren } from '../../core/dom';
import { Disposer } from '../../core/store';
import { vault, backlinks, resolveLink, readNote, writeNote } from '../vault';
import { nfs, noteName } from '../fs';
import * as fm from '../frontmatter';
import { wordCount } from '../markdown';
import { notesPrefs, patchNotesPrefs } from '../prefs';
import { comments, updateComment, deleteComment, replyTo } from '../comments';
import { active, ui } from '../state';

export interface PanelActions {
  open: (path: string, o?: { newPane?: boolean }) => void;
  openLink: (target: string) => void;
  scrollToHeading: (text: string) => void;
  comment: () => void;
  currentPath: () => string;
}

type Tab = 'outline' | 'links' | 'comments' | 'snapshots' | 'stats';
const TABS: Array<[Tab, string, string]> = [
  ['outline', 'sliders', 'Outline'],
  ['links', 'link', 'Links & backlinks'],
  ['comments', 'smile', 'Comments'],
  ['snapshots', 'clock', 'Snapshots'],
  ['stats', 'info', 'Word count & targets'],
];

// ---- Snapshots (Scrivener) ----------------------------------------------------------------
const snapDir = (path: string) => `.omni/snapshots/${path}`;

export async function takeSnapshot(path: string, label = ''): Promise<void> {
  const text = await readNote(path);
  const stamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
  const name = `${stamp}${label ? ` ${label.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40)}` : ''}.md`;
  await nfs.write(vault.get().root, `${snapDir(path)}/${name}`, text);
  toast('Snapshot saved', 'success', 1500);
}

/** Line diff (LCS) for comparing a snapshot with the current text. */
function diffLines(a: string[], b: string[]): Array<{ t: ' ' | '-' | '+'; s: string }> {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [...a.map((s) => ({ t: '-' as const, s })), ...b.map((s) => ({ t: '+' as const, s }))];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Array<{ t: ' ' | '-' | '+'; s: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: a[i++] });
    else out.push({ t: '+', s: b[j++] });
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}

export function rightPanel(actions: PanelActions): { el: HTMLElement; dispose: () => void; refresh: () => void } {
  const d = new Disposer();
  let tab: Tab = notesPrefs.get().rightTab;
  const tabsEl = h('div', { class: 'side-tabs' });
  const body = h('div', { class: 'side-body' });
  const el = h('aside', { class: 'notes-right' }, tabsEl, body);

  const paintTabs = () => tabsEl.replaceChildren(...TABS.map(([id, ic, title]) => h('button', { class: `side-tab ${tab === id ? 'active' : ''}`, title, onclick: () => { tab = id; patchNotesPrefs({ rightTab: id }); render(); } }, icon(ic, 17))));

  const empty = (msg: string) => h('div', { class: 'empty small' }, msg);

  const outline = (path: string) => {
    const n = vault.get().notes.get(path);
    const hs = n?.headings ?? [];
    const min = Math.min(...hs.map((x) => x.level), 6);
    body.replaceChildren(
      h('div', { class: 'side-heading' }, 'Outline'),
      ...(hs.length ? hs.map((x) => h('button', { class: 'outline-row', style: { paddingLeft: `${10 + (x.level - min) * 14}px` }, onclick: () => actions.scrollToHeading(x.text) }, x.text)) : [empty('Add headings (# Title) to see an outline.')]),
    );
  };

  const links = (path: string) => {
    const n = vault.get().notes.get(path);
    const back = backlinks(path);
    const out = (n?.links ?? []).filter((l) => l.target);
    const seen = new Set<string>();
    body.replaceChildren(
      h('div', { class: 'side-heading' }, `Backlinks · ${back.length}`),
      ...(back.length
        ? back.map((b) => h('button', { class: 'backlink', onclick: (e: MouseEvent) => actions.open(b.from.path, { newPane: e.ctrlKey }) }, h('strong', null, b.from.name), ...b.contexts.map((c) => h('div', { class: 'backlink-ctx' }, c))))
        : [empty('No other notes link here yet.')]),
      h('div', { class: 'side-heading' }, 'Outgoing links'),
      ...(out.length
        ? out.filter((l) => !seen.has(l.target) && seen.add(l.target)).map((l) => {
            const r = resolveLink(l.target, path);
            return h('button', { class: `outlink ${r ? '' : 'unresolved'}`, title: r ? r : 'Not created yet — click to create', onclick: () => actions.openLink(l.target) }, l.embed ? '⧉ ' : '', l.target);
          })
        : [empty('No links in this note.')]),
    );
  };

  const commentsTab = (path: string) => {
    const c = comments.get();
    const list = c.path === path ? c.list : [];
    const open = list.filter((x) => !x.resolved);
    const resolved = list.filter((x) => x.resolved);
    const focus = ui.get().commentFocus;
    const card = (cm: (typeof list)[number]) => {
      const reply = h('input', { class: 'comment-reply', placeholder: 'Reply…' });
      reply.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && reply.value.trim()) { await replyTo(path, cm.id, reply.value.trim()); } });
      return h(
        'div',
        { class: `comment-card ${focus === cm.id ? 'focused' : ''} ${cm.resolved ? 'resolved' : ''}` },
        h('div', { class: 'comment-quote' }, `“${cm.quote}”`),
        h('div', { class: 'comment-meta' }, h('strong', null, cm.author), h('span', { class: 'muted small' }, new Date(cm.created).toLocaleString())),
        h('div', { class: 'comment-text' }, cm.text),
        ...(cm.replies ?? []).map((r) => h('div', { class: 'comment-replyline' }, h('strong', null, `${r.author}: `), r.text)),
        cm.resolved ? null : reply,
        h('div', { class: 'row' },
          h('button', { class: 'ghost small-btn', onclick: () => void updateComment(path, cm.id, { resolved: !cm.resolved }) }, cm.resolved ? 'Reopen' : '✓ Resolve'),
          h('button', { class: 'ghost small-btn', onclick: () => void deleteComment(path, cm.id) }, 'Delete')),
      );
    };
    setChildren(body,
      h('div', { class: 'row pad-x' }, h('div', { class: 'side-heading grow' }, `Comments · ${open.length}`), h('button', { class: 'secondary small-btn', onclick: () => actions.comment() }, '+ Comment')),
      open.length ? open.map(card) : empty('Select text in the note, then click 💬 (or “+ Comment”).'),
      resolved.length ? [h('div', { class: 'side-heading' }, `Resolved · ${resolved.length}`), ...resolved.map(card)] : null,
    );
    if (focus) body.querySelector('.comment-card.focused')?.scrollIntoView({ block: 'center' });
  };

  const snapshots = async (path: string) => {
    const label = h('input', { placeholder: 'Optional label, e.g. “before rewrite”' });
    const list = h('div', { class: 'snap-list' }, empty('Loading…'));
    body.replaceChildren(
      h('div', { class: 'side-heading' }, 'Snapshots'),
      h('p', { class: 'muted small pad-x' }, 'Save a copy of this note as it is now. Compare or roll back later.'),
      h('div', { class: 'row pad-x' }, label, h('button', { class: 'primary small-btn', onclick: async () => { await takeSnapshot(path, label.value.trim()); void snapshots(path); } }, 'Take')),
      list,
    );
    const entries = (await nfs.list(vault.get().root, snapDir(path)).catch(() => [])).filter((e) => !e.is_dir).sort((a, b) => b.path.localeCompare(a.path));
    if (!entries.length) return list.replaceChildren(empty('No snapshots yet.'));
    list.replaceChildren(
      ...entries.map((e) => {
        const nm = e.path.split('/').pop()!.replace(/\.md$/, '');
        const date = nm.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)/, ' $1:$2:$3');
        const lbl = nm.slice(20);
        const view = async () => {
          const snap = (await nfs.read(vault.get().root, e.path)).content;
          const cur = await readNote(path);
          const diff = diffLines(fm.body(snap).split('\n'), fm.body(cur).split('\n'));
          const changed = diff.filter((x) => x.t !== ' ').length;
          const close = modal(`Snapshot · ${date}${lbl ? ` · ${lbl}` : ''}`, h('div', { class: 'stack' },
            h('p', { class: 'muted' }, `${wordCount(fm.body(snap))} words then → ${wordCount(fm.body(cur))} now · ${changed} changed line${changed === 1 ? '' : 's'}. Red = only in the snapshot, green = only now.`),
            h('div', { class: 'diff' }, ...diff.map((x) => h('div', { class: `diff-line d${x.t === ' ' ? 'same' : x.t === '-' ? 'del' : 'add'}` }, x.s || ' '))),
            h('div', { class: 'row end' },
              h('button', { class: 'ghost', onclick: () => close() }, 'Close'),
              h('button', { class: 'primary', onclick: async () => {
                if (!(await confirmDialog('Restore snapshot', 'Replace the current note with this snapshot? (The current version is snapshotted first, so you can undo this.)', { confirmLabel: 'Restore' }))) return;
                await takeSnapshot(path, 'before restore');
                await writeNote(path, snap, 'snapshot');
                close();
                toast('Snapshot restored', 'success');
              } }, 'Restore this version')),
          ), { width: 820 });
        };
        return h('button', { class: 'snap-row', onclick: () => void view() }, h('strong', null, date), lbl ? h('span', null, lbl) : null, h('span', { class: 'muted small' }, `${Math.round(e.size / 6)} words approx.`));
      }),
    );
  };

  const stats = (path: string) => {
    const a = active.get();
    const n = vault.get().notes.get(path);
    const target = Number(n?.props.target) || 0;
    const session = notesPrefs.get().sessionTarget;
    const ring = (value: number, max: number, labelText: string) => {
      const pct = max ? Math.min(1, value / max) : 0;
      return h('div', { class: 'target' },
        h('div', { class: 'target-bar' }, h('div', { class: `target-fill ${pct >= 1 ? 'done' : ''}`, style: { width: `${pct * 100}%` } })),
        h('div', { class: 'row' }, h('span', { class: 'grow' }, labelText), h('strong', null, max ? `${value.toLocaleString()} / ${max.toLocaleString()}` : value.toLocaleString())));
    };
    const targetInput = h('input', { type: 'number', min: '0', step: '100', value: target ? String(target) : '', placeholder: 'e.g. 1500' });
    targetInput.addEventListener('change', async () => {
      const text = await readNote(path);
      await writeNote(path, fm.updateProps(text, { target: targetInput.value ? Number(targetInput.value) : undefined }));
      render();
    });
    const sessionInput = h('input', { type: 'number', min: '0', step: '100', value: String(session) });
    sessionInput.addEventListener('change', () => { patchNotesPrefs({ sessionTarget: Number(sessionInput.value) || 0 }); render(); });
    body.replaceChildren(
      h('div', { class: 'side-heading' }, 'This note'),
      h('div', { class: 'stat-grid' },
        h('div', null, h('strong', null, a.words.toLocaleString()), h('span', null, 'words')),
        h('div', null, h('strong', null, a.chars.toLocaleString()), h('span', null, 'characters')),
        h('div', null, h('strong', null, `${Math.max(1, Math.round(a.words / 230))} min`), h('span', null, 'reading time')),
        h('div', null, h('strong', null, String((n?.links.length ?? 0))), h('span', null, 'links'))),
      ring(a.words, target, 'Note target'),
      h('label', { class: 'field pad-x' }, h('span', { class: 'field-label' }, 'Target for this note (words)'), targetInput),
      h('div', { class: 'side-heading' }, 'This session'),
      ring(a.sessionWords, session, 'Words written since opening Omni'),
      h('label', { class: 'field pad-x' }, h('span', { class: 'field-label' }, 'Session target'), sessionInput),
      h('div', { class: 'side-heading' }, 'Vault'),
      h('p', { class: 'muted small pad-x' }, `${vault.get().notes.size} notes · ${[...vault.get().notes.values()].reduce((s, x) => s + x.words, 0).toLocaleString()} words in total`),
    );
  };

  const render = () => {
    paintTabs();
    const path = actions.currentPath();
    if (!path || !vault.get().notes.has(path)) {
      body.replaceChildren(empty('Open a note to see its details here.'));
      return;
    }
    if (tab === 'outline') outline(path);
    else if (tab === 'links') links(path);
    else if (tab === 'comments') commentsTab(path);
    else if (tab === 'snapshots') void snapshots(path);
    else stats(path);
  };

  let lastV = -1;
  d.add(vault.subscribe((v) => { if (v.version !== lastV && tab !== 'snapshots' && tab !== 'stats') { lastV = v.version; render(); } }, false));
  d.add(comments.subscribe(() => tab === 'comments' && render(), false));
  let lastWords = -1;
  d.add(active.subscribe((a) => { if (tab === 'stats' && a.words !== lastWords) { lastWords = a.words; render(); } }, false));
  d.add(ui.subscribe((u) => {
    if (u.rightTab && u.rightTab !== tab) { tab = u.rightTab as Tab; render(); }
    else if (u.commentFocus && tab === 'comments') render();
  }, false));

  render();
  return { el, dispose: () => d.dispose(), refresh: render };
}

export { noteName };
