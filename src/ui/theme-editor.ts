import { h, field, toast, select, toggle, modal } from '../core/dom';
import { debounce } from '../core/store';
import {
  theme, setTheme, patchTheme, patchColors, PRESETS, FONTS, savedThemes, saveCustomTheme, deleteCustomTheme,
  encodeTheme, decodeTheme, type Theme, type ThemeColors,
} from '../core/theme';
import { settings, patchSettings } from '../core/settings';
import { isTauri } from '../core/native';

const COLOR_LABELS: Array<[keyof ThemeColors, string]> = [
  ['accent', 'Accent'],
  ['accentText', 'Text on accent'],
  ['bg', 'Background'],
  ['sidebar', 'Sidebar'],
  ['surface', 'Panels & cards'],
  ['surfaceAlt', 'Inputs & hover'],
  ['border', 'Borders'],
  ['text', 'Text'],
  ['textMuted', 'Muted text'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['danger', 'Danger'],
];

function swatch(t: Theme, active: boolean, onclick: () => void, onDelete?: () => void): HTMLElement {
  const c = t.colors;
  return h(
    'div',
    { class: `theme-swatch ${active ? 'active' : ''}` },
    h(
      'button',
      { type: 'button', class: 'theme-swatch-btn', onclick, title: t.name },
      h(
        'span',
        { class: 'theme-swatch-preview', style: { background: c.bg } },
        h('span', { style: { background: c.sidebar } }),
        h('span', { style: { background: c.surface } }, h('i', { style: { background: c.accent } }), h('b', { style: { background: c.textMuted } })),
      ),
      h('span', { class: 'theme-swatch-name' }, t.name),
    ),
    onDelete ? h('button', { type: 'button', class: 'theme-swatch-del', title: 'Delete theme', onclick: onDelete }, '×') : null,
  );
}

export function themeEditor(): { el: HTMLElement; dispose: () => void } {
  const el = h('div', { class: 'theme-editor stack-lg' });

  const render = () => {
    const t = theme.get();
    const s = settings.get();
    const saved = savedThemes();

    const colorInputs = COLOR_LABELS.map(([k, label]) => {
      const i = h('input', { type: 'color', value: t.colors[k] });
      i.addEventListener('input', () => patchColors({ [k]: i.value }));
      return h('label', { class: 'color-field' }, i, h('span', null, label));
    });

    const range = (value: number, min: number, max: number, step: number, onInput: (v: number) => void, fmt: (v: number) => string) => {
      const out = h('span', { class: 'range-value' }, fmt(value));
      const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
      r.addEventListener('input', () => {
        out.textContent = fmt(Number(r.value));
        onInput(Number(r.value));
      });
      return h('div', { class: 'range-row' }, r, out);
    };

    const fontOptions: Array<[string, string]> = FONTS.some(([v]) => v === t.font) ? FONTS : [...FONTS, [t.font, 'Custom']];

    const css = h('textarea', { class: 'code', rows: '8', spellcheck: 'false', placeholder: '/* Your own CSS, e.g. */\n.sidebar { border-right: 2px solid var(--accent); }' }, t.customCss);
    css.addEventListener('input', debounce(() => patchTheme({ customCss: css.value }), 400));

    el.replaceChildren(
      h(
        'section',
        null,
        h('h3', null, 'Themes'),
        h('div', { class: 'theme-grid' }, PRESETS.map((p) => swatch(p, t.id === p.id, () => setTheme({ ...p, backdrop: t.backdrop, transparency: t.transparency, customCss: t.customCss })))),
        saved.length
          ? [
              h('h4', null, 'My themes'),
              h('div', { class: 'theme-grid' }, saved.map((p) => swatch(p, t.id === p.id, () => setTheme(p), () => { deleteCustomTheme(p.id); render(); }))),
            ]
          : null,
        h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'secondary', onclick: () => saveAs() }, 'Save as my theme'),
          h('button', { class: 'secondary', onclick: () => copyCode() }, 'Copy theme code'),
          h('button', { class: 'secondary', onclick: () => importCode() }, 'Import theme code'),
        ),
      ),
      h('section', null, h('h3', null, 'Colours'), h('div', { class: 'color-grid' }, colorInputs)),
      h(
        'section',
        null,
        h('h3', null, 'Layout & text'),
        h(
          'div',
          { class: 'grid-2' },
          field('Font', select(t.font, fontOptions, (v) => patchTheme({ font: v }))),
          field('Density', select(t.density, [['compact', 'Compact'], ['cozy', 'Cozy'], ['comfortable', 'Comfortable']], (v) => patchTheme({ density: v }))),
          field('Text size', range(t.fontSize, 12, 18, 1, (v) => patchTheme({ fontSize: v }), (v) => `${v}px`)),
          field('Corner roundness', range(t.radius, 0, 20, 1, (v) => patchTheme({ radius: v }), (v) => `${v}px`)),
        ),
        h('div', { class: 'stack' }, toggle(s.sidebarLabels, (v) => patchSettings({ sidebarLabels: v }), 'Show labels in the sidebar'), toggle(s.animations, (v) => patchSettings({ animations: v }), 'Animations and profile effects')),
      ),
      h(
        'section',
        null,
        h('h3', null, 'Window'),
        h(
          'div',
          { class: 'grid-2' },
          field(
            'Background material',
            select(t.backdrop, [['solid', 'Solid colour'], ['mica', 'Mica (Windows 11)'], ['acrylic', 'Acrylic blur']], (v) => { patchTheme({ backdrop: v }); render(); }),
            isTauri ? 'Mica is the lightest on resources; Acrylic blurs whatever is behind the window.' : 'Takes effect in the desktop app.',
          ),
          t.backdrop !== 'solid' ? field('See-through amount', range(t.transparency, 0, 0.8, 0.05, (v) => patchTheme({ transparency: v }), (v) => `${Math.round(v * 100)}%`)) : h('span'),
        ),
      ),
      h('section', null, h('h3', null, 'Custom CSS'), h('p', { class: 'muted' }, 'Restyle anything. Changes apply as you type; delete it all to undo.'), css),
    );
  };

  const saveAs = () => {
    const name = h('input', { maxlength: '40', value: theme.get().id.startsWith('custom-') ? theme.get().name : `${theme.get().name} (mine)` });
    const body = h(
      'form',
      { class: 'stack', onsubmit: (e: Event) => {
        e.preventDefault();
        const current = theme.get();
        const t: Theme = { ...current, id: current.id.startsWith('custom-') ? current.id : `custom-${Date.now()}`, name: name.value.trim() || 'My theme' };
        saveCustomTheme(t);
        setTheme(t);
        close();
        render();
        toast('Theme saved', 'success');
      } },
      field('Theme name', name),
      h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Save')),
    );
    const close = modal('Save theme', body, { width: 380 });
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(encodeTheme(theme.get()));
      toast('Theme code copied — paste it to a friend!', 'success');
    } catch {
      toast("Couldn't access the clipboard", 'error');
    }
  };

  const importCode = () => {
    const area = h('textarea', { class: 'code', rows: '5', placeholder: 'Paste an OMNI-THEME: code here' });
    const body = h(
      'form',
      { class: 'stack', onsubmit: (e: Event) => {
        e.preventDefault();
        const t = decodeTheme(area.value);
        if (!t) return toast("That doesn't look like a valid theme code", 'error');
        const imported = { ...t, id: `custom-${Date.now()}` };
        saveCustomTheme(imported);
        setTheme(imported);
        close();
        render();
        toast(`Imported “${imported.name}”`, 'success');
      } },
      area,
      h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Import')),
    );
    const close = modal('Import a theme', body, { width: 480 });
  };

  render();
  return { el, dispose: () => {} };
}
