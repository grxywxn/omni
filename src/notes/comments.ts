// Word-style comments. Stored beside the vault in .omni/comments/<note>.json so the
// Markdown stays clean (and fully Obsidian-compatible).
import { Store } from '../core/store';
import { readJson, writeJson } from './vault';
import { me } from '../lib/profiles';
import { displayName } from '../lib/types';

export interface Reply { author: string; text: string; created: string }
export interface Comment {
  id: string;
  quote: string;
  text: string;
  author: string;
  created: string;
  resolved?: boolean;
  replies?: Reply[];
}

export const comments = new Store<{ path: string; list: Comment[] }>({ path: '', list: [] });

const file = (notePath: string) => `.omni/comments/${notePath}.json`;
const author = () => (me.get() ? displayName(me.get()!) : 'Me');

export async function loadComments(notePath: string): Promise<Comment[]> {
  const list = await readJson<Comment[]>(file(notePath), []);
  comments.set({ path: notePath, list });
  return list;
}

async function save(notePath: string, list: Comment[]): Promise<void> {
  comments.set({ path: notePath, list });
  await writeJson(file(notePath), list);
}

export async function addComment(notePath: string, quote: string, text: string): Promise<Comment> {
  const c: Comment = { id: `c${Date.now().toString(36)}`, quote, text, author: author(), created: new Date().toISOString() };
  const list = comments.get().path === notePath ? comments.get().list : await loadComments(notePath);
  await save(notePath, [...list, c]);
  return c;
}

export async function updateComment(notePath: string, id: string, patch: Partial<Comment>): Promise<void> {
  await save(notePath, comments.get().list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

export async function replyTo(notePath: string, id: string, text: string): Promise<void> {
  await save(notePath, comments.get().list.map((c) => (c.id === id ? { ...c, replies: [...(c.replies ?? []), { author: author(), text, created: new Date().toISOString() }] } : c)));
}

export async function deleteComment(notePath: string, id: string): Promise<void> {
  await save(notePath, comments.get().list.filter((c) => c.id !== id));
}

/** Move comments when a note is renamed. */
export async function moveComments(from: string, to: string): Promise<void> {
  const list = await readJson<Comment[]>(file(from), []);
  if (!list.length) return;
  await writeJson(file(to), list);
  await writeJson(file(from), []);
}
