// The Properties block shown at the top of a note (Obsidian-style), with typed inputs.
import { h, icon } from '../../core/dom';
import * as fm from '../frontmatter';
import { fileUrlSync, resolveLink, isImage } from '../vault';

const IMAGE_KEYS = /^(image|cover|portrait|banner|photo|picture)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function imageFromProp(v: fm.Value | undefined, from: string): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = v.replace(/^!?\[\[|\]\]$/g, '').trim();
  if (/^https?:/i.test(t)) return t;
  const p = resolveLink(t, from) ?? (isImage(t) ? t : null);
  return p ? fileUrlSync(p) : null;
}

export function propertiesBlock(text: string, notePath: string, onChange: (patch: Record<string, fm.Value | undefined>) => void): HTMLElement {
  const props = fm.props(text);
  const keys = Object.keys(props);
  const portrait = imageFromProp(props.image ?? props.portrait ?? props.cover, notePath);
  const type = typeof props.type === 'string' ? props.type : '';

  const row = (key: string) => {
    const v = props[key];
    let input: HTMLElement;
    if (typeof v === 'boolean') {
      const cb = h('input', { type: 'checkbox', checked: v, onchange: () => onChange({ [key]: cb.checked }) });
      input = cb;
    } else if (typeof v === 'number') {
      const n = h('input', { type: 'number', value: String(v), onchange: () => onChange({ [key]: n.value === '' ? null : Number(n.value) }) });
      input = n;
    } else if (Array.isArray(v)) {
      const t = h('input', { value: v.map((x) => fm.valueText(x)).join(', '), placeholder: 'Comma-separated', onchange: () => onChange({ [key]: t.value.split(',').map((s) => s.trim()).filter(Boolean) }) });
      input = t;
    } else if (typeof v === 'string' && DATE_RE.test(v)) {
      const d = h('input', { type: 'date', value: v, onchange: () => onChange({ [key]: d.value }) });
      input = d;
    } else if (v !== null && typeof v === 'object') {
      input = h('code', { class: 'prop-raw', title: 'Edit this in Source mode' }, fm.valueText(v));
    } else {
      const t = h('input', { value: fm.valueText(v), placeholder: 'Empty', onchange: () => onChange({ [key]: t.value === '' ? null : t.value }) });
      input = t;
    }
    return h(
      'div',
      { class: 'prop-row' },
      h('span', { class: 'prop-key', title: key }, key),
      h('div', { class: 'prop-val' }, input),
      h('button', { class: 'icon-btn prop-del', title: `Remove “${key}”`, onclick: () => onChange({ [key]: undefined }) }, icon('x', 14)),
    );
  };

  const newKey = h('input', { class: 'prop-new', placeholder: '+ Add property', list: 'prop-suggestions' });
  newKey.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && newKey.value.trim()) {
      const k = newKey.value.trim().replace(/[:\s]+/g, '_');
      onChange({ [k]: k === 'tags' || k === 'aliases' ? [] : null });
    }
  });

  return h(
    'details',
    { class: `props ${type ? `type-${type}` : ''}`, open: keys.length > 0 },
    h('summary', null, icon('sliders', 14), 'Properties', keys.length ? h('span', { class: 'muted' }, ` ${keys.length}`) : null),
    h(
      'div',
      { class: 'props-body' },
      portrait && IMAGE_KEYS.test(Object.keys(props).find((k) => IMAGE_KEYS.test(k)) ?? '') ? h('img', { class: 'prop-portrait', src: portrait, alt: '' }) : null,
      h('div', { class: 'props-rows' }, keys.map(row), newKey),
      h('datalist', { id: 'prop-suggestions' }, ['tags', 'aliases', 'type', 'status', 'date', 'synopsis', 'target', 'image', 'relations', 'role', 'location'].map((k) => h('option', { value: k }))),
    ),
  );
}
