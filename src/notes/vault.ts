// The open vault: file list + an in-memory index of every note (links, tags, properties).
import { Store } from '../core/store';
import { toast } from '../core/dom';
import { nfs, noteName, folderOf, joinRel, isMd, safeFileName, baseName, type Entry } from './fs';
import * as fm from './frontmatter';
import { extractLinks, extractTags, extractHeadings, wordCount, IMAGE_EXT, type Link, type Heading } from './markdown';
import { notesPrefs } from './prefs';

export interface NoteMeta {
  path: string;
  name: string;
  folder: string;
  mtime: number;
  text: string;
  props: Record<string, fm.Value>;
  links: Link[];
  tags: string[];
  headings: Heading[];
  words: number;
}

export interface VaultState {
  root: string;
  entries: Entry[];
  notes: Map<string, NoteMeta>;
  ready: boolean;
  /** Bumped on any change so views can re-render. */
  version: number;
}

export const vault = new Store<VaultState>({ root: '', entries: [], notes: new Map(), ready: false, version: 0 });

/** Fired when a note's content changed on disk or by another pane. */
export const changes = new Store<{ path: string; by: string } | null>(null);

const meta = (path: string, text: string, mtime: number): NoteMeta => {
  const props = fm.props(text);
  const bodyText = fm.body(text);
  const propTags = ([] as fm.Value[]).concat(props.tags ?? []).map((t) => String(t).replace(/^#/, '').toLowerCase()).filter(Boolean);
  return {
    path,
    name: noteName(path),
    folder: folderOf(path),
    mtime,
    text,
    props,
    links: extractLinks(bodyText),
    tags: [...new Set([...propTags, ...extractTags(bodyText)])],
    headings: extractHeadings(bodyText),
    words: wordCount(bodyText),
  };
};

function bump(patch: Partial<VaultState> = {}): void {
  vault.update((v) => ({ ...v, ...patch, version: v.version + 1 }));
}

const root = () => vault.get().root;

export async function openVault(path: string): Promise<void> {
  vault.set({ root: path, entries: [], notes: new Map(), ready: false, version: 0 });
  const [entries, files] = await Promise.all([nfs.scan(path), nfs.readAll(path)]);
  const notes = new Map<string, NoteMeta>();
  for (const f of files) notes.set(f.path, meta(f.path, f.content, f.mtime));
  vault.set({ root: path, entries, notes, ready: true, version: 1 });
}

/** Pick up changes made outside Omni (e.g. in Obsidian). */
export async function refreshFromDisk(): Promise<void> {
  const r = root();
  if (!r) return;
  const entries = await nfs.scan(r);
  const notes = new Map(vault.get().notes);
  const seen = new Set<string>();
  const changed: string[] = [];
  for (const e of entries) {
    if (e.is_dir || !isMd(e.path)) continue;
    seen.add(e.path);
    const cur = notes.get(e.path);
    if (!cur || cur.mtime !== e.mtime) {
      try {
        const f = await nfs.read(r, e.path);
        notes.set(e.path, meta(e.path, f.content, f.mtime));
        if (cur) changed.push(e.path);
      } catch {
        /* unreadable */
      }
    }
  }
  for (const p of [...notes.keys()]) if (!seen.has(p)) notes.delete(p);
  bump({ entries, notes });
  for (const p of changed) changes.set({ path: p, by: 'disk' });
}

async function rescanEntries(): Promise<void> {
  bump({ entries: await nfs.scan(root()) });
}

// ---- Link resolution --------------------------------------------------------------
/** Find the note (or file) a [[link]] points to, Obsidian-style. */
export function resolveLink(target: string, from = ''): string | null {
  const v = vault.get();
  let t = target.trim().replace(/\\/g, '/').replace(/^\//, '');
  if (!t) return null;
  const isFile = /\.[a-z0-9]{2,5}$/i.test(t) && !/\.md$/i.test(t);
  if (isFile) {
    const lower = t.toLowerCase();
    const hits = v.entries.filter((e) => !e.is_dir && (e.path.toLowerCase() === lower || e.path.toLowerCase().endsWith(`/${lower}`)));
    return hits[0]?.path ?? null;
  }
  t = t.replace(/\.md$/i, '');
  const lower = t.toLowerCase();
  if (v.notes.has(`${t}.md`)) return `${t}.md`;
  const fromFolder = folderOf(from);
  let best: string | null = null;
  for (const n of v.notes.values()) {
    const p = n.path.slice(0, -3).toLowerCase();
    const match = t.includes('/') ? p === lower || p.endsWith(`/${lower}`) : n.name.toLowerCase() === lower;
    if (match) {
      if (n.folder === fromFolder) return n.path;
      if (!best || n.path.length < best.length) best = n.path;
    }
  }
  if (best) return best;
  // Aliases
  for (const n of v.notes.values()) {
    const aliases = ([] as fm.Value[]).concat(n.props.aliases ?? n.props.alias ?? []);
    if (aliases.some((a) => String(a).toLowerCase() === lower)) return n.path;
  }
  return null;
}

/** Shortest unambiguous link text for a note. */
export function linkTextFor(path: string): string {
  const name = noteName(path);
  const dupes = [...vault.get().notes.values()].filter((n) => n.name.toLowerCase() === name.toLowerCase());
  return dupes.length > 1 ? path.replace(/\.md$/i, '') : name;
}

export function backlinks(path: string): Array<{ from: NoteMeta; contexts: string[] }> {
  const out: Array<{ from: NoteMeta; contexts: string[] }> = [];
  const name = noteName(path).toLowerCase();
  for (const n of vault.get().notes.values()) {
    if (n.path === path) continue;
    const hits = n.links.filter((l) => l.target && resolveLink(l.target, n.path) === path);
    if (!hits.length) continue;
    const lines = fm.body(n.text).split('\n').filter((l) => l.toLowerCase().includes(`[[${name}`) || hits.some((h) => l.includes(h.target)));
    out.push({ from: n, contexts: lines.slice(0, 3).map((l) => l.trim()) });
  }
  return out.sort((a, b) => a.from.name.localeCompare(b.from.name));
}

// ---- Reading & writing ------------------------------------------------------------
export async function readNote(path: string): Promise<string> {
  const cached = vault.get().notes.get(path);
  if (cached) return cached.text;
  const f = await nfs.read(root(), path);
  return f.content;
}

export async function writeNote(path: string, text: string, by = ''): Promise<void> {
  const mtime = await nfs.write(root(), path, text);
  const notes = new Map(vault.get().notes);
  const isNew = !notes.has(path);
  notes.set(path, meta(path, text, mtime));
  bump({ notes });
  if (isNew) await rescanEntries();
  changes.set({ path, by });
}

export function uniquePath(folder: string, name: string, ext = '.md'): string {
  const v = vault.get();
  const taken = new Set(v.entries.map((e) => e.path.toLowerCase()));
  for (const n of v.notes.keys()) taken.add(n.toLowerCase());
  const base = safeFileName(name);
  let p = joinRel(folder, `${base}${ext}`);
  for (let i = 1; taken.has(p.toLowerCase()); i++) p = joinRel(folder, `${base} ${i}${ext}`);
  return p;
}

export async function createNote(folder: string, name = 'Untitled', content = ''): Promise<string> {
  const p = uniquePath(folder, name);
  await writeNote(p, content);
  return p;
}

export async function createFolder(parent: string, name = 'New folder'): Promise<string> {
  const p = uniquePath(parent, name, '');
  await nfs.mkdir(root(), p);
  await rescanEntries();
  return p;
}

/** Rename/move a note and update [[links]] to it in every other note. */
export async function renamePath(from: string, to: string): Promise<string> {
  if (from === to) return to;
  const isNote = isMd(from);
  const oldLinkName = noteName(from);
  const oldResolved = new Map<string, NoteMeta>(); // notes linking to `from`
  if (isNote) for (const b of backlinks(from)) oldResolved.set(b.from.path, b.from);
  await nfs.move(root(), from, to);

  const notes = new Map(vault.get().notes);
  if (isNote) {
    const n = notes.get(from);
    notes.delete(from);
    if (n) notes.set(to, { ...meta(to, n.text, n.mtime) });
  } else {
    // Folder: re-key every note inside it.
    for (const [p, n] of [...notes]) {
      if (p.startsWith(`${from}/`)) {
        const np = to + p.slice(from.length);
        notes.delete(p);
        notes.set(np, meta(np, n.text, n.mtime));
      }
    }
  }
  bump({ notes });
  await rescanEntries();

  if (isNote && noteName(to) !== oldLinkName) {
    const newText = linkTextFor(to);
    const re = new RegExp(`(!?\\[\\[)${escapeRe(oldLinkName)}(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'gi');
    let count = 0;
    for (const n of oldResolved.values()) {
      const p = n.path === from ? to : n.path;
      const updated = n.text.replace(re, (_m, open, h = '', a = '') => `${open}${newText}${h}${a}]]`);
      if (updated !== n.text) {
        await writeNote(p, updated, 'rename');
        count++;
      }
    }
    if (count) toast(`Updated links in ${count} note${count === 1 ? '' : 's'}`, 'success', 2500);
  }
  changes.set({ path: to, by: 'rename' });
  return to;
}

export async function trashPath(path: string): Promise<void> {
  await nfs.trash(root(), path);
  const notes = new Map(vault.get().notes);
  for (const p of [...notes.keys()]) if (p === path || p.startsWith(`${path}/`)) notes.delete(p);
  bump({ notes });
  await rescanEntries();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- Attachments ----------------------------------------------------------------------
export async function saveAttachment(blob: Blob, suggested?: string): Promise<string> {
  const { blobToBase64 } = await import('./fs');
  const ext = (blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = suggested ? safeFileName(suggested.replace(/\.[^.]+$/, '')) : `Pasted image ${stamp}`;
  const folder = notesPrefs.get().attachments;
  const p = uniquePath(folder, name, `.${ext}`);
  await nfs.writeBase64(root(), p, await blobToBase64(blob));
  await rescanEntries();
  return p;
}

export function fileUrlSync(vaultPath: string): string {
  const r = root();
  const full = `${r}\\${vaultPath.replace(/\//g, '\\')}`;
  const conv = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string, proto?: string) => string } }).__TAURI_INTERNALS__?.convertFileSrc;
  return conv ? conv(full, 'asset') : vaultPath;
}

// ---- Small sidecar data (.omni folder) ---------------------------------------------------
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const s = await nfs.readOpt(root(), path);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await nfs.write(root(), path, JSON.stringify(data, null, 2));
}

/** Custom binder order per folder (Scrivener-style), stored in .omni/order.json. */
let orderCache: Record<string, string[]> | null = null;
export async function folderOrder(): Promise<Record<string, string[]>> {
  orderCache ??= await readJson<Record<string, string[]>>('.omni/order.json', {});
  return orderCache;
}
export async function setFolderOrder(folder: string, names: string[]): Promise<void> {
  const o = await folderOrder();
  o[folder] = names;
  await writeJson('.omni/order.json', o);
  bump();
}
export function resetOrderCache(): void {
  orderCache = null;
}

export function sortChildren(folder: string, children: Entry[], order: Record<string, string[]>): Entry[] {
  const custom = order[folder];
  const byName = (a: Entry, b: Entry) => (a.is_dir === b.is_dir ? baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true }) : a.is_dir ? -1 : 1);
  if (!custom?.length) return [...children].sort(byName);
  const idx = (e: Entry) => {
    const i = custom.indexOf(baseName(e.path));
    return i < 0 ? 1e6 : i;
  };
  return [...children].sort((a, b) => idx(a) - idx(b) || byName(a, b));
}

export function notesIn(folder: string, recursive: boolean): NoteMeta[] {
  const all = [...vault.get().notes.values()];
  return all.filter((n) => (recursive ? folder === '' || n.folder === folder || n.folder.startsWith(`${folder}/`) : n.folder === folder));
}

export function allTags(): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const n of vault.get().notes.values()) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

export function isImage(path: string): boolean {
  return IMAGE_EXT.test(path);
}
