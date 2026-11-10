// Export: Word (.docx), PDF (print), HTML, Markdown — for one note or a compiled folder.
import { h, toast, modal, field, select, toggle } from '../../core/dom';
import type { Token, Tokens } from 'marked';
import { vault, resolveLink, fileUrlSync, readNote, notesIn, folderOrder } from '../vault';
import { nfs, noteName, baseName, saveDialog, blobToBase64 } from '../fs';
import * as fm from '../frontmatter';
import { render, renderMath, lex, IMAGE_EXT } from '../markdown';
import { notesPrefs } from '../prefs';
import { revealInExplorer } from '../../recorder/api';

type Docx = typeof import('docx');

const ctxFor = (path: string) => ({ resolve: (t: string) => resolveLink(t, path), fileUrl: fileUrlSync, notePath: path });

// ---- Word ---------------------------------------------------------------------------
interface RunStyle { bold?: boolean; italics?: boolean; strike?: boolean; underline?: boolean; code?: boolean; highlight?: boolean; color?: string; link?: string }

async function imageData(url: string): Promise<{ data: ArrayBuffer; type: 'png' | 'jpg' | 'gif' | 'bmp'; w: number; h: number } | null> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const type = /png/.test(blob.type) ? 'png' : /jpe?g/.test(blob.type) ? 'jpg' : /gif/.test(blob.type) ? 'gif' : /bmp/.test(blob.type) ? 'bmp' : null;
    if (!type) return null;
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 600 / bmp.width);
    return { data: await blob.arrayBuffer(), type, w: Math.round(bmp.width * scale), h: Math.round(bmp.height * scale) };
  } catch {
    return null;
  }
}

async function toDocxBlocks(D: Docx, md: string, path: string, state: { ol: number }): Promise<Array<InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>>> {
  const tokens = lex(md, ctxFor(path));
  const out: Array<InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>> = [];

  const inline = async (toks: Token[] | undefined, base: RunStyle = {}): Promise<Array<InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']> | InstanceType<Docx['ImageRun']>>> => {
    const runs: Array<InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']> | InstanceType<Docx['ImageRun']>> = [];
    let st: RunStyle = { ...base };
    const stack: RunStyle[] = [];
    const text = (t: string, s: RunStyle) => {
      if (!t) return;
      const r = new D.TextRun({ text: t, bold: s.bold, italics: s.italics, strike: s.strike, underline: s.underline ? {} : undefined, font: s.code ? 'Consolas' : undefined, highlight: s.highlight ? 'yellow' : undefined, color: s.color, style: s.link ? 'Hyperlink' : undefined });
      runs.push(s.link ? new D.ExternalHyperlink({ link: s.link, children: [r] }) : r);
    };
    for (const t of toks ?? []) {
      const g = t as Tokens.Generic;
      switch (t.type) {
        case 'strong': runs.push(...(await inline(g.tokens, { ...st, bold: true }))); break;
        case 'em': runs.push(...(await inline(g.tokens, { ...st, italics: true }))); break;
        case 'del': runs.push(...(await inline(g.tokens, { ...st, strike: true }))); break;
        case 'highlight': runs.push(...(await inline(g.tokens, { ...st, highlight: true }))); break;
        case 'codespan': text(g.text, { ...st, code: true }); break;
        case 'link': runs.push(...(await inline(g.tokens, { ...st, link: /^https?:/.test(g.href) ? g.href : undefined }))); break;
        case 'br': runs.push(new D.TextRun({ text: '', break: 1 })); break;
        case 'wikilink':
          if (g.embed && IMAGE_EXT.test(g.target)) {
            const p = resolveLink(g.target, path);
            const img = p ? await imageData(fileUrlSync(p)) : null;
            if (img) runs.push(new D.ImageRun({ type: img.type, data: img.data, transformation: { width: img.w, height: img.h } }));
          } else if (!g.embed) text(g.alias || g.target, st);
          break;
        case 'image': {
          const img = await imageData(/^https?:/.test(g.href) ? g.href : fileUrlSync(resolveLink(g.href, path) ?? g.href));
          if (img) runs.push(new D.ImageRun({ type: img.type, data: img.data, transformation: { width: img.w, height: img.h } }));
          break;
        }
        case 'tag': text(`#${g.tag}`, { ...st, color: '5865F2' }); break;
        case 'mathInline': text(g.text, { ...st, italics: true }); break;
        case 'comment': break;
        case 'html': {
          const s = g.text as string;
          if (/^<u>/i.test(s)) { stack.push(st); st = { ...st, underline: true }; }
          else if (/^<span[^>]*color:\s*#?([0-9a-f]{6})/i.test(s)) { stack.push(st); st = { ...st, color: /color:\s*#?([0-9a-f]{6})/i.exec(s)![1] }; }
          else if (/^<\/(u|span)>/i.test(s)) st = stack.pop() ?? { ...base };
          break;
        }
        case 'escape':
        case 'text':
          if (g.tokens?.length) runs.push(...(await inline(g.tokens, st)));
          else text((g.text as string).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), st);
          break;
        default:
          if (g.text) text(g.text, st);
      }
    }
    return runs;
  };

  const HEADINGS = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6];

  const block = async (t: Token, quoteDepth = 0): Promise<void> => {
    const g = t as Tokens.Generic;
    const quote = quoteDepth ? { indent: { left: 360 * quoteDepth }, border: { left: { style: D.BorderStyle.SINGLE, size: 12, color: 'AAAAAA', space: 8 } } } : {};
    switch (t.type) {
      case 'heading': out.push(new D.Paragraph({ heading: HEADINGS[g.depth - 1], children: await inline(g.tokens) })); break;
      case 'paragraph': out.push(new D.Paragraph({ children: await inline(g.tokens), ...quote })); break;
      case 'text': out.push(new D.Paragraph({ children: await inline(g.tokens ?? [{ type: 'text', raw: g.raw, text: g.text } as Token]), ...quote })); break;
      case 'list': {
        const instance = state.ol++;
        const walk = async (list: Tokens.List, level: number) => {
          for (const item of list.items) {
            const first = item.tokens.find((x) => x.type === 'text' || x.type === 'paragraph') as Tokens.Generic | undefined;
            const box = item.task ? new D.TextRun({ text: item.checked ? '☑ ' : '☐ ' }) : null;
            const runs = first ? await inline(first.tokens ?? [{ type: 'text', raw: first.text, text: first.text } as Token]) : [];
            out.push(new D.Paragraph({
              children: box ? [box, ...runs] : runs,
              ...(list.ordered ? { numbering: { reference: 'ol', level, instance } } : { bullet: { level } }),
            }));
            for (const sub of item.tokens) if (sub.type === 'list') await walk(sub as Tokens.List, Math.min(level + 1, 8));
          }
        };
        await walk(t as Tokens.List, 0);
        break;
      }
      case 'blockquote': for (const x of g.tokens ?? []) await block(x, quoteDepth + 1); break;
      case 'callout':
        out.push(new D.Paragraph({ children: await inline(g.titleTokens, { bold: true }), shading: { type: D.ShadingType.CLEAR, fill: 'EEF2FF', color: 'auto' }, ...{ indent: { left: 360 }, border: { left: { style: D.BorderStyle.SINGLE, size: 18, color: '5865F2', space: 8 } } } }));
        for (const x of g.tokens ?? []) await block(x, quoteDepth + 1);
        break;
      case 'code':
        for (const line of (g.text as string).split('\n')) out.push(new D.Paragraph({ children: [new D.TextRun({ text: line || ' ', font: 'Consolas', size: 20 })], shading: { type: D.ShadingType.CLEAR, fill: 'F3F3F3', color: 'auto' } }));
        break;
      case 'mathBlock': out.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: g.text, italics: true })] })); break;
      case 'hr': out.push(new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } }, children: [] })); break;
      case 'table': {
        const tb = t as Tokens.Table;
        const row = async (cells: Tokens.TableCell[], header: boolean) => new D.TableRow({ tableHeader: header, children: await Promise.all(cells.map(async (c) => new D.TableCell({ children: [new D.Paragraph({ children: await inline(c.tokens, header ? { bold: true } : {}) })] }))) });
        out.push(new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows: [await row(tb.header, true), ...(await Promise.all(tb.rows.map((r) => row(r, false))))] }));
        break;
      }
      case 'space': case 'html': break;
      default: if (g.text) out.push(new D.Paragraph({ text: g.text }));
    }
  };
  for (const t of tokens) await block(t);
  return out;
}

async function buildDocx(parts: Array<{ title: string | null; body: string; path: string; pageBreak: boolean }>, docTitle: string): Promise<Blob> {
  const D = await import('docx');
  const font = notesPrefs.get().pageFont.split(',')[0].replace(/"/g, '').trim() || 'Calibri';
  const state = { ol: 0 };
  const children: Array<InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>> = [];
  for (const p of parts) {
    if (p.title) children.push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, pageBreakBefore: p.pageBreak && children.length > 0, children: [new D.TextRun(p.title)] }));
    else if (p.pageBreak && children.length) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    children.push(...(await toDocxBlocks(D, p.body, p.path, state)));
  }
  const levels = Array.from({ length: 9 }, (_, level) => ({ level, format: D.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } }));
  const doc = new D.Document({
    title: docTitle,
    creator: 'Omni',
    styles: { default: { document: { run: { font, size: 24 } } } },
    numbering: { config: [{ reference: 'ol', levels }] },
    sections: [{ properties: { page: { size: notesPrefs.get().pageSize === 'letter' ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 } } }, children }],
  });
  return D.Packer.toBlob(doc);
}

// ---- PDF (print) & HTML ------------------------------------------------------------------
async function printHtml(title: string, html: string): Promise<void> {
  const root = h('div', { id: 'print-root', class: `print-root size-${notesPrefs.get().pageSize}`, style: { '--page-font': notesPrefs.get().pageFont } });
  root.innerHTML = html;
  document.body.appendChild(root);
  document.body.classList.add('printing');
  await renderMath(root);
  await Promise.all([...root.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  const prevTitle = document.title;
  document.title = title;
  const cleanup = () => {
    root.remove();
    document.body.classList.remove('printing');
    document.title = prevTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 60_000);
}

function htmlDoc(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>
body{font-family:${notesPrefs.get().pageFont};max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}
img{max-width:100%}blockquote,.callout{border-left:4px solid #5865f2;margin:1em 0;padding:.2em 1em;background:#f5f6ff}
pre{background:#f3f3f3;padding:12px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}mark{background:#fff3a3}
.page-break{page-break-after:always}</style></head><body>${inner}</body></html>`;
}

// ---- Public API ---------------------------------------------------------------------------
export type ExportFormat = 'docx' | 'pdf' | 'html' | 'md';

async function saveAs(name: string, format: ExportFormat, make: () => Promise<{ data: string; base64: boolean }>): Promise<void> {
  const labels = { docx: 'Word document', html: 'Web page', md: 'Markdown', pdf: 'PDF' };
  const path = await saveDialog(`${name}.${format}`, format, labels[format]);
  if (!path) return;
  try {
    const { data, base64 } = await make();
    await nfs.exportWrite(path, data, base64);
    toast(`Exported ${baseName(path.replace(/\\/g, '/'))}`, 'success');
    void revealInExplorer(path);
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error', 7000);
  }
}

export async function exportNote(path: string, format: ExportFormat): Promise<void> {
  const text = await readNote(path);
  const body = fm.body(text);
  const name = noteName(path);
  if (format === 'pdf') return printHtml(name, render(body, ctxFor(path)));
  await saveAs(name, format, async () => {
    if (format === 'docx') return { data: await blobToBase64(await buildDocx([{ title: null, body, path, pageBreak: false }], name)), base64: true };
    if (format === 'html') return { data: htmlDoc(name, render(body, ctxFor(path))), base64: false };
    return { data: text, base64: false };
  });
}

/** Documents in binder order (folders become parts, recursively). */
async function orderedDocs(folder: string, recursive: boolean): Promise<string[]> {
  const order = await folderOrder();
  const v = vault.get();
  const kids = v.entries.filter((e) => (folder ? e.path.startsWith(`${folder}/`) : true) && e.path.slice(folder ? folder.length + 1 : 0).split('/').length === 1);
  const idx = (p: string) => { const i = (order[folder] ?? []).indexOf(baseName(p)); return i < 0 ? 1e6 : i; };
  kids.sort((a, b) => idx(a.path) - idx(b.path) || a.path.localeCompare(b.path, undefined, { numeric: true }));
  const out: string[] = [];
  for (const k of kids) {
    if (k.is_dir) { if (recursive) out.push(...(await orderedDocs(k.path, true))); }
    else if (v.notes.has(k.path)) out.push(k.path);
  }
  return out;
}

export async function compileDialog(folder: string): Promise<void> {
  let format: ExportFormat = 'docx';
  let titles = true;
  let separator: 'page' | 'rule' | 'none' = 'page';
  let recursive = notesIn(folder, false).length === 0;
  const count = h('p', { class: 'muted' });
  const refresh = async () => { const n = (await orderedDocs(folder, recursive)).length; count.textContent = `${n} document${n === 1 ? '' : 's'} will be combined in binder order (drag to reorder them in the Corkboard).`; };
  const body = h('div', { class: 'stack' },
    count,
    field('Format', select(format, [['docx', 'Word (.docx)'], ['pdf', 'PDF (print dialog)'], ['md', 'Markdown (.md)'], ['html', 'Web page (.html)']], (v) => (format = v))),
    field('Between documents', select(separator, [['page', 'Page break'], ['rule', 'Scene break (***)'], ['none', 'Nothing']], (v) => (separator = v))),
    toggle(titles, (v) => (titles = v), 'Use each document’s name as a chapter title'),
    toggle(recursive, (v) => { recursive = v; void refresh(); }, 'Include subfolders'),
    h('div', { class: 'row end' }, h('button', { class: 'ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'primary', onclick: () => { close(); void compile(folder, { format, titles, separator, recursive }); } }, 'Compile')),
  );
  const close = modal(`Compile “${folder ? baseName(folder) : 'vault'}”`, body, { width: 480 });
  void refresh();
}

async function compile(folder: string, o: { format: ExportFormat; titles: boolean; separator: 'page' | 'rule' | 'none'; recursive: boolean }): Promise<void> {
  const docs = await orderedDocs(folder, o.recursive);
  if (!docs.length) return toast('No documents to compile', 'error');
  const name = folder ? baseName(folder) : 'Manuscript';
  const parts = await Promise.all(docs.map(async (p) => ({ path: p, title: o.titles ? noteName(p) : null, body: fm.body(await readNote(p)) })));
  if (o.format === 'pdf' || o.format === 'html') {
    const sep = o.separator === 'page' ? '<div class="page-break"></div>' : o.separator === 'rule' ? '<p class="scene-break">* * *</p>' : '';
    const html = parts.map((p, i) => `${i ? sep : ''}${p.title ? `<h1 class="chapter-title">${p.title.replace(/</g, '&lt;')}</h1>` : ''}${render(p.body, ctxFor(p.path))}`).join('');
    if (o.format === 'pdf') return printHtml(name, html);
    return saveAs(name, 'html', async () => ({ data: htmlDoc(name, html), base64: false }));
  }
  if (o.format === 'md') {
    const sep = o.separator === 'page' ? '\n\n<div style="page-break-after:always"></div>\n\n' : o.separator === 'rule' ? '\n\n* * *\n\n' : '\n\n';
    return saveAs(name, 'md', async () => ({ data: parts.map((p) => `${p.title ? `# ${p.title}\n\n` : ''}${p.body.trim()}`).join(sep), base64: false }));
  }
  await saveAs(name, 'docx', async () => {
    const withSep = o.separator === 'rule' ? parts.map((p, i) => ({ ...p, body: i && !p.title ? `* * *\n\n${p.body}` : p.body })) : parts;
    return { data: await blobToBase64(await buildDocx(withSep.map((p) => ({ ...p, pageBreak: o.separator === 'page' })), name)), base64: true };
  });
}

export { buildDocx };
