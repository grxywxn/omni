// Graph view: all links (Obsidian), a relationship web (Campfire) or the current note's neighbourhood.
import { h, select, toggle, setChildren } from '../../core/dom';
import { Disposer } from '../../core/store';
import { vault, resolveLink } from '../vault';
import * as fm from '../frontmatter';

type Mode = 'links' | 'relations' | 'local';

interface Node { id: string; label: string; group: string; x: number; y: number; vx: number; vy: number; deg: number; tag?: boolean; fixed?: boolean }
interface Edge { a: Node; b: Node; label?: string }

const PALETTE = ['#7c6cff', '#3ecf8e', '#f5b84a', '#f0566a', '#4cc9f0', '#f72585', '#90be6d', '#ff8a5c', '#b5179e', '#43aa8b', '#e9c46a', '#a0c4ff'];

/** Parse a relations entry like "[[Amaka]] — sister" or "Amaka: rival". */
function parseRelation(v: fm.Value): { target: string; label: string } | null {
  const s = fm.valueText(v).trim();
  if (!s) return null;
  const m = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]\s*[-—–:|]*\s*(.*)$/.exec(s);
  if (m) return { target: m[1].trim(), label: (m[3] || m[2] || '').trim() };
  const p = /^([^:—–-]+?)\s*[:—–-]\s*(.+)$/.exec(s);
  return p ? { target: p[1].trim(), label: p[2].trim() } : { target: s, label: '' };
}

export function graphView(opts: { open: (path: string, o?: { newPane?: boolean }) => void; center: () => string; initialMode?: Mode }): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  let mode: Mode = opts.initialMode ?? 'links';
  let colorBy: 'folder' | 'type' | 'tag' = 'folder';
  let showOrphans = true;
  let showTags = false;
  let depth = 2;
  let filter = '';

  const canvas = h('canvas', { class: 'graph-canvas' });
  const legend = h('div', { class: 'graph-legend' });
  const search = h('input', { class: 'graph-search', placeholder: 'Highlight…' });
  const controls = h('div', { class: 'graph-controls' });
  const el = h('div', { class: 'graph-view' }, canvas, controls, legend);

  let nodes: Node[] = [];
  let edges: Edge[] = [];
  let byId = new Map<string, Node>();
  let neighbors = new Map<Node, Set<Node>>();
  let alpha = 1;
  let scale = 1, tx = 0, ty = 0;
  let hover: Node | null = null;
  let dragNode: Node | null = null;

  const build = () => {
    const v = vault.get();
    const old = byId;
    nodes = [];
    edges = [];
    byId = new Map();
    const groupOf = (path: string): string => {
      const n = v.notes.get(path);
      if (!n) return '';
      if (colorBy === 'type') return fm.valueText(n.props.type) || 'note';
      if (colorBy === 'tag') return n.tags[0] ?? 'untagged';
      return n.folder || '/';
    };
    const add = (id: string, label: string, group: string, tag = false) => {
      let n = byId.get(id);
      if (n) return n;
      const prev = old.get(id);
      const a = Math.random() * Math.PI * 2, r = 50 + Math.random() * 250;
      n = prev ? { ...prev, label, group, deg: 0, tag } : { id, label, group, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, deg: 0, tag };
      byId.set(id, n);
      nodes.push(n);
      return n;
    };
    const link = (a: Node, b: Node, label?: string) => {
      if (a === b || edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) return;
      edges.push({ a, b, label });
      a.deg++;
      b.deg++;
    };

    if (mode === 'relations') {
      for (const n of v.notes.values()) {
        const rels = ([] as fm.Value[]).concat(n.props.relations ?? n.props.relationships ?? []);
        for (const r of rels) {
          const p = parseRelation(r);
          if (!p) continue;
          const to = resolveLink(p.target, n.path);
          if (!to) continue;
          link(add(n.path, n.name, groupOf(n.path)), add(to, v.notes.get(to)!.name, groupOf(to)), p.label);
        }
      }
      if (showOrphans) for (const n of v.notes.values()) if (fm.valueText(n.props.type) === 'character') add(n.path, n.name, groupOf(n.path));
    } else {
      const include = new Set<string>();
      if (mode === 'local') {
        const c = opts.center();
        if (c) {
          include.add(c);
          let frontier = [c];
          for (let i = 0; i < depth; i++) {
            const next: string[] = [];
            for (const p of frontier) {
              const n = v.notes.get(p);
              for (const l of n?.links ?? []) { const r = resolveLink(l.target, p); if (r && !include.has(r)) { include.add(r); next.push(r); } }
              for (const m of v.notes.values()) if (!include.has(m.path) && m.links.some((l) => resolveLink(l.target, m.path) === p)) { include.add(m.path); next.push(m.path); }
            }
            frontier = next;
          }
        }
      }
      for (const n of v.notes.values()) {
        if (mode === 'local' && !include.has(n.path)) continue;
        const a = add(n.path, n.name, groupOf(n.path));
        for (const l of n.links) {
          const r = resolveLink(l.target, n.path);
          if (r && v.notes.has(r) && (mode !== 'local' || include.has(r))) link(a, add(r, v.notes.get(r)!.name, groupOf(r)));
        }
        if (showTags) for (const t of n.tags) link(a, add(`#${t}`, `#${t}`, '#tags', true));
      }
      if (!showOrphans) {
        nodes = nodes.filter((n) => n.deg > 0 || n.id === opts.center());
        byId = new Map(nodes.map((n) => [n.id, n]));
      }
    }
    neighbors = new Map(nodes.map((n) => [n, new Set<Node>()]));
    for (const e of edges) { neighbors.get(e.a)?.add(e.b); neighbors.get(e.b)?.add(e.a); }
    alpha = 1;
    paintLegend();
  };

  const groups = () => [...new Set(nodes.map((n) => n.group))].sort();
  const colorOf = (g: string) => (g === '#tags' ? '#80848e' : PALETTE[groups().indexOf(g) % PALETTE.length]);

  const paintLegend = () => {
    const gs = groups().filter((g) => g !== '#tags').slice(0, 12);
    legend.replaceChildren(...gs.map((g) => h('span', { class: 'legend-item' }, h('i', { style: { background: colorOf(g) } }), g || '—')),
      h('span', { class: 'muted small' }, `${nodes.length} notes · ${edges.length} links`));
  };

  // ---- Physics ------------------------------------------------------------------------
  const tick = () => {
    const n = nodes.length;
    const k = mode === 'relations' ? 120 : 70;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        if (d2 > 250000) continue;
        const f = (1800 / d2) * alpha;
        const dist = Math.sqrt(d2);
        a.vx += (dx / dist) * f; a.vy += (dy / dist) * f;
        b.vx -= (dx / dist) * f; b.vy -= (dy / dist) * f;
      }
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((dist - k) / dist) * 0.04 * alpha;
      e.a.vx += dx * f; e.a.vy += dy * f;
      e.b.vx -= dx * f; e.b.vy -= dy * f;
    }
    for (const p of nodes) {
      p.vx -= p.x * 0.004 * alpha;
      p.vy -= p.y * 0.004 * alpha;
      if (p === dragNode || p.fixed) { p.vx = p.vy = 0; continue; }
      p.vx *= 0.82; p.vy *= 0.82;
      p.x += Math.max(-30, Math.min(30, p.vx));
      p.y += Math.max(-30, Math.min(30, p.vy));
    }
    alpha = Math.max(0.02, alpha * 0.985);
  };

  // ---- Drawing --------------------------------------------------------------------------
  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const radius = (n: Node) => (n.tag ? 3 : 4 + Math.sqrt(n.deg) * 1.6);

  const draw = () => {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    const c = canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hgt);
    c.translate(w / 2 + tx, hgt / 2 + ty);
    c.scale(scale, scale);
    const q = filter.toLowerCase();
    const focus = hover ? neighbors.get(hover) : null;
    const center = opts.center();
    const dim = (n: Node) => (focus && n !== hover && !focus.has(n)) || (q && !n.label.toLowerCase().includes(q));
    c.lineWidth = 1 / scale;
    for (const e of edges) {
      const active = hover && (e.a === hover || e.b === hover);
      c.strokeStyle = active ? css('--accent') : css('--border');
      c.globalAlpha = (dim(e.a) || dim(e.b)) && !active ? 0.15 : active ? 1 : 0.6;
      c.beginPath(); c.moveTo(e.a.x, e.a.y); c.lineTo(e.b.x, e.b.y); c.stroke();
      if (e.label && (scale > 0.7 || active)) {
        c.globalAlpha = active ? 1 : 0.75;
        c.fillStyle = css('--text-muted');
        c.font = `${10 / Math.max(scale, 0.6)}px ${css('--font')}`;
        c.textAlign = 'center';
        c.fillText(e.label, (e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2 - 3 / scale);
      }
    }
    for (const n of nodes) {
      c.globalAlpha = dim(n) ? 0.2 : 1;
      c.fillStyle = n.id === center ? css('--text') : colorOf(n.group);
      c.beginPath(); c.arc(n.x, n.y, radius(n) * (n === hover ? 1.4 : 1), 0, Math.PI * 2); c.fill();
      if (scale > 0.85 || n === hover || (focus?.has(n) ?? false) || n.id === center || mode === 'relations') {
        c.fillStyle = css('--text');
        c.font = `${(n === hover ? 13 : 11) / Math.max(scale, 0.7)}px ${css('--font')}`;
        c.textAlign = 'center';
        c.fillText(n.label, n.x, n.y + radius(n) + 12 / Math.max(scale, 0.7));
      }
    }
    c.globalAlpha = 1;
  };

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (document.hidden || !el.isConnected || el.closest('[hidden]')) return;
    if (alpha > 0.021 || dragNode) tick();
    draw();
  };
  raf = requestAnimationFrame(loop);
  d.add(() => cancelAnimationFrame(raf));

  // ---- Interaction ------------------------------------------------------------------------
  const toWorld = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - tx) / scale, y: (e.clientY - r.top - r.height / 2 - ty) / scale };
  };
  const pick = (e: MouseEvent) => {
    const p = toWorld(e);
    let best: Node | null = null, bd = Infinity;
    for (const n of nodes) {
      const dd = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
      if (dd < bd && dd < (radius(n) + 6) ** 2 / Math.min(1, scale)) { bd = dd; best = n; }
    }
    return best;
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const f = Math.exp(-e.deltaY * 0.0015);
    const ns = Math.max(0.15, Math.min(5, scale * f));
    tx = mx - ((mx - tx) * ns) / scale;
    ty = my - ((my - ty) * ns) / scale;
    scale = ns;
  }, { passive: false });
  canvas.addEventListener('mousemove', (e) => {
    if (!dragNode) {
      hover = pick(e);
      canvas.style.cursor = hover ? 'pointer' : 'grab';
    }
  });
  canvas.addEventListener('mouseleave', () => (hover = null));
  canvas.addEventListener('mousedown', (e) => {
    const n = pick(e);
    const sx = e.clientX, sy = e.clientY, stx = tx, sty = ty;
    let moved = false;
    if (n) { dragNode = n; alpha = Math.max(alpha, 0.3); }
    const move = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
      if (n) { const p = toWorld(ev); n.x = p.x; n.y = p.y; }
      else { tx = stx + ev.clientX - sx; ty = sty + ev.clientY - sy; }
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      dragNode = null;
      if (n && !moved && !n.tag) opts.open(n.id, { newPane: ev.ctrlKey || ev.metaKey });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  const paintControls = () => {
    setChildren(
      controls,
      select(mode, [['links', 'All links'], ['relations', 'Relationship web'], ['local', 'Around current note']], (m) => { mode = m; paintControls(); build(); }),
      select(colorBy, [['folder', 'Colour by folder'], ['type', 'Colour by type'], ['tag', 'Colour by tag']], (c) => { colorBy = c; build(); }),
      mode === 'local' ? select(String(depth) as '1' | '2' | '3', [['1', '1 step'], ['2', '2 steps'], ['3', '3 steps']], (v) => { depth = Number(v); build(); }) : null,
      toggle(showOrphans, (v) => { showOrphans = v; build(); }, mode === 'relations' ? 'Characters without relations' : 'Unlinked notes'),
      mode !== 'relations' ? toggle(showTags, (v) => { showTags = v; build(); }, 'Tags') : null,
      search,
      mode === 'relations' ? h('p', { class: 'muted small' }, 'Add a “relations” property to notes, e.g. [[Amaka]] — sister') : null,
    );
  };
  search.addEventListener('input', () => (filter = search.value));
  paintControls();

  let lastV = -1;
  d.add(vault.subscribe((v) => { if (v.version !== lastV) { lastV = v.version; build(); } }));
  return { el, dispose: () => d.dispose() };
}
