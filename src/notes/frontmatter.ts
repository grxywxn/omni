// YAML front matter ("Properties"), Obsidian-compatible.
// Only the keys you change are rewritten; everything else is kept byte-for-byte,
// so complex YAML written by other apps survives untouched.

export type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

interface Entry {
  key: string;
  lines: string[];
}

export interface Doc {
  entries: Entry[];
  body: string;
  /** Text before the first key (e.g. comments). */
  preamble: string[];
}

const FENCE = /^---\s*$/;

export function split(text: string): { front: string[] | null; body: string } {
  const norm = text.replace(/^﻿/, '');
  const lines = norm.split(/\r?\n/);
  if (!FENCE.test(lines[0] ?? '')) return { front: null, body: norm };
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i]) || /^\.\.\.\s*$/.test(lines[i])) {
      return { front: lines.slice(1, i), body: lines.slice(i + 1).join('\n') };
    }
  }
  return { front: null, body: norm };
}

export function parse(text: string): Doc {
  const { front, body } = split(text);
  const doc: Doc = { entries: [], body, preamble: [] };
  if (!front) return doc;
  for (const line of front) {
    const m = /^([^\s#\-][^:]*?):(?:\s|$)/.exec(line) ?? /^([^\s#\-][^:]*?):$/.exec(line);
    if (m && !/^\s/.test(line)) doc.entries.push({ key: m[1].trim(), lines: [line] });
    else if (doc.entries.length) doc.entries[doc.entries.length - 1].lines.push(line);
    else doc.preamble.push(line);
  }
  return doc;
}

// ---- Scalars ---------------------------------------------------------------------
function parseScalar(raw: string): Value {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  s = s.replace(/\s+#.*$/, ''); // trailing comment
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) return splitFlow(s.slice(1, -1)).map(parseScalar);
  if (s.startsWith('{') && s.endsWith('}')) return parseFlowMap(s);
  return s;
}

/** Split a flow collection on commas that aren't inside quotes/brackets. */
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', q: string | null = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length);
}

function parseFlowMap(s: string): { [k: string]: Value } {
  const o: { [k: string]: Value } = {};
  for (const part of splitFlow(s.slice(1, -1))) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    o[part.slice(0, i).trim().replace(/^["']|["']$/g, '')] = parseScalar(part.slice(i + 1));
  }
  return o;
}

export function entryValue(e: Entry): Value {
  const first = e.lines[0];
  const rest = first.slice(first.indexOf(':') + 1).trim();
  if (rest && rest !== '|' && rest !== '>') return parseScalar(rest);
  const tail = e.lines.slice(1).filter((l) => l.trim() && !/^\s*#/.test(l));
  if (rest === '|' || rest === '>') return tail.map((l) => l.trim()).join(rest === '|' ? '\n' : ' ');
  if (!tail.length) return null;
  if (tail.every((l) => /^\s*-\s/.test(l) || /^\s*-$/.test(l))) return tail.map((l) => parseScalar(l.replace(/^\s*-\s?/, '')));
  // Nested map
  const o: { [k: string]: Value } = {};
  for (const l of tail) {
    const m = /^\s+([^:]+):\s*(.*)$/.exec(l);
    if (m) o[m[1].trim()] = parseScalar(m[2]);
  }
  return o;
}

// ---- Emitting ----------------------------------------------------------------------
function needsQuotes(s: string): boolean {
  return (
    s === '' ||
    /^[\s]|[\s]$/.test(s) ||
    /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) ||
    /: |\s#/.test(s) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s) ||
    /[\n\r\t]/.test(s)
  );
}

export function emitScalar(v: Value): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return needsQuotes(v) ? JSON.stringify(v) : v;
  if (Array.isArray(v)) return `[${v.map(emitScalar).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${k}: ${emitScalar(x)}`).join(', ')}}`;
}

function emit(key: string, v: Value): string[] {
  if (Array.isArray(v)) {
    if (!v.length) return [`${key}: []`];
    return [`${key}:`, ...v.map((x) => `  - ${emitScalar(x)}`)];
  }
  if (v && typeof v === 'object') {
    return [`${key}:`, ...Object.entries(v).map(([k, x]) => `  ${k}: ${emitScalar(x)}`)];
  }
  const s = emitScalar(v);
  return [s === '' ? `${key}:` : `${key}: ${s}`];
}

export function serialize(doc: Doc): string {
  if (!doc.entries.length && !doc.preamble.length) return doc.body;
  const lines = [...doc.preamble, ...doc.entries.flatMap((e) => e.lines)];
  return `---\n${lines.join('\n')}\n---\n${doc.body}`;
}

// ---- Convenience API ------------------------------------------------------------------
export function props(text: string): Record<string, Value> {
  const d = parse(text);
  const o: Record<string, Value> = {};
  for (const e of d.entries) o[e.key] = entryValue(e);
  return o;
}

export function body(text: string): string {
  return split(text).body;
}

/** Set (or with `undefined`, remove) properties. Untouched keys keep their exact text. */
export function updateProps(text: string, patch: Record<string, Value | undefined>): string {
  const d = parse(text);
  for (const [k, v] of Object.entries(patch)) {
    const i = d.entries.findIndex((e) => e.key === k);
    if (v === undefined) {
      if (i >= 0) d.entries.splice(i, 1);
      continue;
    }
    const entry = { key: k, lines: emit(k, v) };
    if (i >= 0) d.entries[i] = entry;
    else d.entries.push(entry);
  }
  return serialize(d);
}

export function setBody(text: string, newBody: string): string {
  const d = parse(text);
  d.body = newBody;
  return serialize(d);
}

/** Display a property value as text. */
export function valueText(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(valueText).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
