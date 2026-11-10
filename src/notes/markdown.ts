// Markdown → HTML with Obsidian extensions, plus helpers to extract links, tags, headings.
import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

// ---- Extraction (used by the index: backlinks, graph, tags, outline) -----------------
/** Remove fenced code, inline code, comments and math so we don't pick up fake links/tags. */
export function stripCode(md: string): string {
  return md
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, '');
}

export interface Link {
  target: string; // as written, without heading/alias
  heading?: string;
  alias?: string;
  embed: boolean;
}

const WIKI = /(!?)\[\[([^\]\n|#]*)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/gi;

export function extractLinks(md: string): Link[] {
  const src = stripCode(md);
  const out: Link[] = [];
  for (const m of src.matchAll(WIKI)) {
    if (!m[2].trim() && !m[3]) continue;
    out.push({ embed: m[1] === '!', target: m[2].trim(), heading: m[3]?.trim() || undefined, alias: m[4]?.trim() || undefined });
  }
  for (const m of src.matchAll(MDLINK)) {
    if (/^[a-z]+:\/\//i.test(m[3])) continue;
    out.push({ embed: m[1] === '!', target: decodeURIComponent(m[3]), alias: m[2] || undefined });
  }
  return out;
}

const TAG = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export function extractTags(md: string): string[] {
  const set = new Set<string>();
  for (const m of stripCode(md).matchAll(TAG)) set.add(m[2].replace(/\/$/, '').toLowerCase());
  return [...set];
}

export interface Heading { level: number; text: string; line: number }

export function extractHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let inCode = false;
  md.split('\n').forEach((l, i) => {
    if (/^(```|~~~)/.test(l)) inCode = !inCode;
    if (inCode) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2], line: i });
  });
  return out;
}

export function wordCount(md: string): number {
  const text = md.replace(/^---[\s\S]*?^---\s*$/m, '').replace(/%%[\s\S]*?%%/g, '').replace(/[#>*_`~=\[\]()|-]/g, ' ');
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) ?? []).length;
}

export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

/** Plain text (for search snippets, previews, card synopses). */
export function plainText(md: string): string {
  return stripCode(md)
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(WIKI, (_m, _e, t, _h, a) => a || t)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?\[![^\]]*\][+-]?\s*/gm, '')
    .replace(/^[#>\s]*|[*_~=`]/gm, '')
    .replace(/^\s*[-+*]\s+(\[.\]\s+)?/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---- Rendering --------------------------------------------------------------------
export interface RenderContext {
  /** Resolve a [[link]] target to a vault path, or null if no such note. */
  resolve: (target: string) => string | null;
  /** URL for a vault file (images). */
  fileUrl: (vaultPath: string) => string;
  /** Path of the note being rendered (for relative links). */
  notePath: string;
  /** Comments to highlight (quotes). */
  commentQuotes?: Array<{ id: string; quote: string }>;
}

let ctx: RenderContext = { resolve: () => null, fileUrl: (p) => p, notePath: '' };
let taskCounter = 0;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
export function joinPath(dir: string, rel: string): string {
  const parts = (dir ? `${dir}/${rel}` : rel).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

function imageFor(target: string, alt: string, sizeSpec?: string): string {
  const path = ctx.resolve(target) ?? joinPath(dirOf(ctx.notePath), target);
  const m = /^(\d+)(?:x(\d+))?$/.exec(sizeSpec ?? '');
  const size = m ? ` width="${m[1]}"${m[2] ? ` height="${m[2]}"` : ''}` : '';
  return `<img class="note-img" src="${esc(ctx.fileUrl(path))}" alt="${esc(alt)}"${size} data-path="${esc(path)}">`;
}

// breaks: true matches Obsidian's default (a single Enter shows as a new line).
const md = new Marked({ gfm: true, breaks: true });

md.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start: (src: string) => src.match(/!?\[\[/)?.index,
      tokenizer(src: string) {
        const m = /^(!?)\[\[([^\]\n|#]*)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\]/.exec(src);
        if (!m) return undefined;
        return { type: 'wikilink', raw: m[0], embed: m[1] === '!', target: m[2].trim(), heading: m[3]?.trim() ?? '', alias: m[4]?.trim() ?? '' };
      },
      renderer(t: Tokens.Generic) {
        const target = t.target as string;
        if (t.embed) {
          if (IMAGE_EXT.test(target)) return imageFor(target, target, t.alias as string);
          return `<div class="embed" data-embed="${esc(target)}" data-heading="${esc(t.heading as string)}"><div class="embed-title">${esc(target)}</div><div class="embed-body">…</div></div>`;
        }
        const resolved = target ? ctx.resolve(target) : ctx.notePath;
        const label = (t.alias as string) || (t.heading ? `${target}${target ? ' › ' : ''}${t.heading}` : target);
        return `<a class="wikilink${resolved ? '' : ' unresolved'}" data-href="${esc(target)}" data-heading="${esc(t.heading as string)}">${esc(label)}</a>`;
      },
    },
    {
      name: 'highlight',
      level: 'inline',
      start: (src: string) => src.indexOf('=='),
      tokenizer(src: string) {
        const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
        if (!m) return undefined;
        return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(t: Tokens.Generic) {
        return `<mark>${this.parser.parseInline(t.tokens ?? [])}</mark>`;
      },
    },
    {
      name: 'comment',
      level: 'inline',
      start: (src: string) => src.indexOf('%%'),
      tokenizer(src: string) {
        const m = /^%%[\s\S]*?%%/.exec(src);
        return m ? { type: 'comment', raw: m[0] } : undefined;
      },
      renderer: () => '',
    },
    {
      name: 'tag',
      level: 'inline',
      start: (src: string) => {
        const m = /(^|[\s(,;])#[\p{L}_\-/]/u.exec(src);
        return m ? m.index + m[1].length : undefined;
      },
      tokenizer(src: string) {
        const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src);
        return m ? { type: 'tag', raw: m[0], tag: m[1] } : undefined;
      },
      renderer: (t: Tokens.Generic) => `<a class="tag" data-tag="${esc((t.tag as string).toLowerCase())}">#${esc(t.tag as string)}</a>`,
    },
    {
      name: 'mathBlock',
      level: 'block',
      start: (src: string) => src.indexOf('$$'),
      tokenizer(src: string) {
        const m = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
        return m ? { type: 'mathBlock', raw: m[0], text: m[1].trim() } : undefined;
      },
      renderer: (t: Tokens.Generic) => `<div class="math math-block" data-tex="${esc(t.text as string)}">${esc(t.text as string)}</div>`,
    },
    {
      name: 'mathInline',
      level: 'inline',
      start: (src: string) => src.indexOf('$'),
      tokenizer(src: string) {
        const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src);
        return m ? { type: 'mathInline', raw: m[0], text: m[1] } : undefined;
      },
      renderer: (t: Tokens.Generic) => `<span class="math" data-tex="${esc(t.text as string)}">${esc(t.text as string)}</span>`,
    },
    {
      name: 'callout',
      level: 'block',
      start: (src: string) => src.match(/^>\s?\[!/m)?.index,
      tokenizer(src: string) {
        const m = /^>\s?\[!([\w-]+)\]([+-]?)[ \t]*(.*)(?:\n|$)((?:>.*(?:\n|$))*)/.exec(src);
        if (!m) return undefined;
        const inner = m[4].split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n');
        const kind = m[1].toLowerCase();
        const title = m[3] || kind.charAt(0).toUpperCase() + kind.slice(1);
        return { type: 'callout', raw: m[0], kind, fold: m[2], titleTokens: this.lexer.inlineTokens(title), tokens: this.lexer.blockTokens(inner, []) };
      },
      renderer(t: Tokens.Generic) {
        const kind = t.kind as string;
        const inner = this.parser.parse(t.tokens ?? []);
        const head = `<span class="callout-icon"></span><span class="callout-title-text">${this.parser.parseInline((t.titleTokens as Tokens.Generic[]) ?? [])}</span>`;
        if (t.fold) {
          return `<details class="callout" data-callout="${esc(kind)}"${t.fold === '+' ? ' open' : ''}><summary class="callout-title">${head}</summary><div class="callout-body">${inner}</div></details>`;
        }
        return `<div class="callout" data-callout="${esc(kind)}"><div class="callout-title">${head}</div><div class="callout-body">${inner}</div></div>`;
      },
    },
  ],
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${esc(slug(text))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    checkbox({ checked }) {
      return `<input type="checkbox" class="task" data-task="${taskCounter++}"${checked ? ' checked' : ''}> `;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        return `<a class="external" href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''} data-external="${esc(href)}">${text}</a>`;
      }
      const target = decodeURIComponent(href.split('#')[0]);
      const path = target ? joinPath(dirOf(ctx.notePath), target) : '';
      return `<a class="wikilink" data-href="${esc(path.replace(/\.md$/i, ''))}" data-heading="${esc(href.split('#')[1] ?? '')}">${text}</a>`;
    },
    image({ href, text }) {
      if (/^(https?:|data:)/i.test(href)) return `<img class="note-img" src="${esc(href)}" alt="${esc(text)}">`;
      return imageFor(decodeURIComponent(href), text);
    },
  },
});

const SANITIZE = {
  ADD_ATTR: ['data-href', 'data-heading', 'data-tag', 'data-task', 'data-embed', 'data-tex', 'data-callout', 'data-path', 'data-external', 'data-comment', 'open'],
  ADD_TAGS: ['details', 'summary', 'mark', 'u', 'sup', 'sub'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|asset|data|blob|http:\/\/asset\.localhost)[:/]|^[^:]*$/i,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
};

/** Render Markdown (no front matter) to safe HTML. */
export function render(markdown: string, context: RenderContext, taskOffset = 0): string {
  ctx = context;
  taskCounter = taskOffset;
  const html = md.parse(markdown, { async: false }) as string;
  let clean = DOMPurify.sanitize(html, SANITIZE) as string;
  if (context.commentQuotes?.length) clean = highlightComments(clean, context.commentQuotes);
  return clean;
}

/** Wrap commented quotes in the rendered HTML (text nodes only). */
function highlightComments(html: string, quotes: Array<{ id: string; quote: string }>): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const { id, quote } of quotes) {
    if (!quote.trim()) continue;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const i = node.textContent!.indexOf(quote);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + quote.length);
      const mark = document.createElement('mark');
      mark.className = 'comment-mark';
      mark.dataset.comment = id;
      range.surroundContents(mark);
      break;
    }
  }
  return tpl.innerHTML;
}

/** Render $math$ placeholders with KaTeX (loaded only when a note has math). */
export async function renderMath(root: HTMLElement): Promise<void> {
  const els = root.querySelectorAll<HTMLElement>('.math[data-tex]');
  if (!els.length) return;
  const katex = (await import('katex')).default;
  await import('katex/dist/katex.min.css');
  els.forEach((el) => {
    try {
      katex.render(el.dataset.tex!, el, { displayMode: el.classList.contains('math-block'), throwOnError: false });
    } catch {
      /* leave source visible */
    }
  });
}

/** Token stream (with Omni's extensions) — used by the Word exporter. */
export function lex(markdown: string, context: RenderContext) {
  ctx = context;
  return md.lexer(markdown);
}
