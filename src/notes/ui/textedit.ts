// Helpers for editing Markdown inside a <textarea>.
import { h } from '../../core/dom';

export function autosize(t: HTMLTextAreaElement): void {
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight}px`;
}

/** Replace the selection (keeps native undo working where supported). */
export function insertText(t: HTMLTextAreaElement, text: string, selectFrom?: number, selectTo?: number): void {
  t.focus();
  const start = t.selectionStart;
  const ok = document.execCommand?.('insertText', false, text);
  if (!ok) {
    t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (selectFrom !== undefined) t.setSelectionRange(start + selectFrom, start + (selectTo ?? selectFrom));
}

/** Toggle wrapping the selection with markers, e.g. ** for bold. */
export function toggleWrap(t: HTMLTextAreaElement, before: string, after = before): void {
  const { selectionStart: s, selectionEnd: e, value } = t;
  const sel = value.slice(s, e);
  if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
    t.setSelectionRange(s - before.length, e + after.length);
    insertText(t, sel, 0, sel.length);
    return;
  }
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    insertText(t, sel.slice(before.length, sel.length - after.length));
    return;
  }
  insertText(t, `${before}${sel}${after}`, before.length, before.length + sel.length);
}

function lineRange(t: HTMLTextAreaElement): [number, number] {
  const v = t.value;
  const a = v.lastIndexOf('\n', t.selectionStart - 1) + 1;
  let b = v.indexOf('\n', t.selectionEnd);
  if (b < 0) b = v.length;
  return [a, b];
}

/** Apply a transform to every selected line (headings, lists, quotes). */
export function mapLines(t: HTMLTextAreaElement, fn: (line: string, i: number) => string): void {
  const [a, b] = lineRange(t);
  const lines = t.value.slice(a, b).split('\n');
  t.setSelectionRange(a, b);
  const out = lines.map(fn).join('\n');
  insertText(t, out, 0, out.length);
}

const LIST_PREFIX = /^(\s*)((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s?(?:\[![^\]]*\][+-]?\s*)?)/;

export function setLinePrefix(t: HTMLTextAreaElement, prefix: string | ((i: number) => string)): void {
  mapLines(t, (l, i) => {
    const want = typeof prefix === 'function' ? prefix(i) : prefix;
    const stripped = l.replace(/^#{1,6}\s+/, '').replace(LIST_PREFIX, '$1');
    const cur = (LIST_PREFIX.exec(l)?.[2] ?? /^#{1,6}\s+/.exec(l)?.[0] ?? '');
    return cur.trim() && cur.trim() === want.trim() ? stripped : `${want}${stripped.trimStart()}`;
  });
}

/** Enter inside a list continues the list; on an empty item it ends the list. Returns true if handled. */
export function continueList(t: HTMLTextAreaElement): boolean {
  const v = t.value;
  const pos = t.selectionStart;
  if (pos !== t.selectionEnd) return false;
  const a = v.lastIndexOf('\n', pos - 1) + 1;
  const line = v.slice(a, pos);
  const m = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line);
  const q = /^(\s*>\s?)(.*)$/.exec(line);
  if (m) {
    if (!m[7].trim() && v.slice(pos, v.indexOf('\n', pos) < 0 ? v.length : v.indexOf('\n', pos)).trim() === '') {
      // Empty item: remove the marker and leave the list.
      t.setSelectionRange(a, pos);
      insertText(t, m[1]);
      return true;
    }
    const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
    insertText(t, `\n${m[1]}${marker}${m[5]}${m[6] ? '[ ] ' : ''}`);
    return true;
  }
  if (q) {
    if (!q[2].trim()) {
      t.setSelectionRange(a, pos);
      insertText(t, '');
      return true;
    }
    insertText(t, `\n${q[1].replace(/\[![^\]]*\][+-]?\s*/, '')}`);
    return true;
  }
  return false;
}

export function indentLines(t: HTMLTextAreaElement, outdent: boolean): void {
  mapLines(t, (l) => (outdent ? l.replace(/^(\t| {1,4})/, '') : `\t${l}`));
}

/** Pixel position of the caret inside a textarea (for popups). */
export function caretCoords(t: HTMLTextAreaElement): { x: number; y: number } {
  const cs = getComputedStyle(t);
  const mirror = document.createElement('div');
  const props = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderTopWidth', 'boxSizing', 'whiteSpace', 'wordWrap', 'tabSize'] as const;
  for (const p of props) (mirror.style as unknown as Record<string, string>)[p] = cs[p];
  Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', width: `${t.clientWidth}px`, left: '0', top: '0' });
  mirror.textContent = t.value.slice(0, t.selectionStart);
  const span = document.createElement('span');
  span.textContent = '​';
  mirror.appendChild(span);
  document.body.appendChild(mirror);
  const r = t.getBoundingClientRect();
  const x = r.left + span.offsetLeft - t.scrollLeft;
  const y = r.top + span.offsetTop - t.scrollTop + parseFloat(cs.lineHeight || '20');
  mirror.remove();
  return { x, y };
}

// ---- Suggestion popup (slash menu, [[link]] suggestions) ------------------------------
export interface SuggestItem {
  label: string;
  hint?: string;
  icon?: string;
  run: () => void;
}

export class Suggest {
  el: HTMLElement;
  private items: SuggestItem[] = [];
  private index = 0;
  open = false;

  constructor() {
    this.el = h('div', { class: 'suggest', role: 'listbox', hidden: true });
    document.body.appendChild(this.el);
  }

  show(at: { x: number; y: number }, items: SuggestItem[]): void {
    this.items = items;
    this.index = 0;
    this.open = items.length > 0;
    this.el.hidden = !this.open;
    if (!this.open) return;
    this.paint();
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(at.x, innerWidth - r.width - 8)}px`;
    this.el.style.top = `${at.y + r.height + 8 > innerHeight ? at.y - r.height - 28 : at.y + 4}px`;
  }

  private paint(): void {
    this.el.replaceChildren(
      ...this.items.slice(0, 40).map((it, i) =>
        h(
          'button',
          { class: `suggest-item ${i === this.index ? 'active' : ''}`, onmousedown: (e: Event) => { e.preventDefault(); this.pick(i); } },
          it.icon ? h('span', { class: 'suggest-icon' }, it.icon) : null,
          h('span', { class: 'suggest-label' }, it.label),
          it.hint ? h('span', { class: 'suggest-hint' }, it.hint) : null,
        ),
      ),
    );
    (this.el.querySelector('.active') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }

  /** Returns true if the key was used by the popup. */
  key(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === 'ArrowDown') { this.index = (this.index + 1) % Math.min(40, this.items.length); this.paint(); }
    else if (e.key === 'ArrowUp') { this.index = (this.index - 1 + Math.min(40, this.items.length)) % Math.min(40, this.items.length); this.paint(); }
    else if (e.key === 'Enter' || e.key === 'Tab') this.pick(this.index);
    else if (e.key === 'Escape') this.close();
    else return false;
    e.preventDefault();
    return true;
  }

  pick(i: number): void {
    const it = this.items[i];
    this.close();
    it?.run();
  }

  close(): void {
    this.open = false;
    this.el.hidden = true;
  }

  destroy(): void {
    this.el.remove();
  }
}

/** Score for fuzzy matching (higher is better, -1 = no match). */
export function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  const i = t.indexOf(q);
  if (i === 0) return 100 - t.length * 0.01;
  if (i > 0) return 80 - i - t.length * 0.01;
  let ti = 0, score = 0;
  for (const c of q) {
    const f = t.indexOf(c, ti);
    if (f < 0) return -1;
    score += f === ti ? 2 : 1;
    ti = f + 1;
  }
  return score;
}
