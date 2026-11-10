// Campfire-style maps: a picture with pins that link to notes.
import { h, icon, toast } from '../../core/dom';
import * as fm from '../frontmatter';
import { vault, linkTextFor } from '../vault';
import { imageFromProp } from './properties';
import { Suggest, fuzzy } from './textedit';

interface Pin { x: number; y: number; note?: string; label?: string }

export function mapWidget(text: string, notePath: string, onPins: (pins: Pin[]) => void, openLink: (target: string) => void): HTMLElement {
  const props = fm.props(text);
  const url = imageFromProp(props.image, notePath);
  const pins: Pin[] = (Array.isArray(props.pins) ? props.pins : []).filter((p): p is { [k: string]: fm.Value } => !!p && typeof p === 'object' && !Array.isArray(p)).map((p) => ({
    x: Number(p.x) || 0, y: Number(p.y) || 0, note: p.note ? String(p.note) : undefined, label: p.label ? String(p.label) : undefined,
  }));
  if (!url) {
    return h('div', { class: 'note map-empty' }, '🗺️ Set this note’s ', h('b', null, 'image'), ' property to a picture in your vault (e.g. ', h('code', null, 'Attachments/world.png'), ') to turn it into a map.');
  }
  let adding = false;
  const stage = h('div', { class: 'map-stage' });
  const img = h('img', { class: 'map-img', src: url, alt: '', draggable: 'false' });
  const addBtn = h('button', { class: 'secondary', onclick: () => { adding = !adding; addBtn.classList.toggle('on', adding); stage.classList.toggle('adding', adding); } }, icon('plus', 14), 'Add pin');
  const suggest = new Suggest();

  const paint = () => {
    stage.querySelectorAll('.map-pin').forEach((p) => p.remove());
    pins.forEach((p, i) => {
      stage.append(
        h('button', {
          class: 'map-pin',
          style: { left: `${p.x * 100}%`, top: `${p.y * 100}%` },
          title: `${p.label ?? p.note ?? 'Pin'}${p.note ? ' — click to open, right-click to remove' : ''}`,
          onclick: (e: Event) => { e.stopPropagation(); if (p.note) openLink(p.note); },
          oncontextmenu: (e: Event) => { e.preventDefault(); pins.splice(i, 1); onPins(pins); paint(); },
        }, h('span', { class: 'map-pin-dot' }), h('span', { class: 'map-pin-label' }, p.label ?? p.note ?? '')),
      );
    });
  };

  stage.addEventListener('click', (e) => {
    if (!adding) return;
    const r = img.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000;
    const y = Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000;
    const notes = [...vault.get().notes.values()].filter((n) => n.path !== notePath);
    const show = (q: string) =>
      suggest.show({ x: e.clientX, y: e.clientY }, [
        { label: q ? `Label only: “${q}”` : 'Label only (no linked note)', icon: '📍', run: () => finish({ x, y, label: q || 'Pin' }) },
        ...notes.map((n) => ({ n, s: fuzzy(q, n.name) })).filter((o) => o.s >= 0).sort((a, b) => b.s - a.s).slice(0, 12).map(({ n }) => ({
          label: n.name, hint: typeof n.props.type === 'string' ? n.props.type : n.folder, icon: '📄', run: () => finish({ x, y, note: linkTextFor(n.path), label: n.name }),
        })),
      ]);
    const q = h('input', { class: 'map-pin-search', placeholder: 'Link a note or type a label…', style: { left: `${x * 100}%`, top: `${y * 100}%` } });
    stage.append(q);
    q.focus();
    q.addEventListener('input', () => show(q.value));
    q.addEventListener('keydown', (ev) => { if (!suggest.key(ev) && ev.key === 'Escape') { q.remove(); suggest.close(); } });
    q.addEventListener('blur', () => setTimeout(() => { q.remove(); suggest.close(); }, 150));
    show('');
  });

  const finish = (p: Pin) => {
    pins.push(p);
    onPins(pins);
    paint();
    adding = false;
    addBtn.classList.remove('on');
    stage.classList.remove('adding');
    toast('Pin added', 'success', 1200);
  };

  stage.append(img);
  paint();
  return h('div', { class: 'map-widget' }, h('div', { class: 'map-toolbar' }, addBtn, h('span', { class: 'muted' }, `${pins.length} pin${pins.length === 1 ? '' : 's'} · right-click a pin to remove it`)), stage);
}

export type { Pin };
