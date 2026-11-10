import { Store } from './store';
import { setBackdrop, type Backdrop } from './native';

export interface ThemeColors {
  bg: string; // app background
  sidebar: string; // left rail
  surface: string; // cards, panels
  surfaceAlt: string; // inputs, hovered rows
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string; // text on accent buttons
  success: string;
  warning: string;
  danger: string;
}

export interface Theme {
  id: string;
  name: string;
  base: 'dark' | 'light';
  colors: ThemeColors;
  radius: number; // px
  font: string;
  fontSize: number; // px
  density: 'compact' | 'cozy' | 'comfortable';
  backdrop: Backdrop;
  /** 0–1. How see-through panels are when a Mica/Acrylic backdrop is on. */
  transparency: number;
  customCss: string;
}

export const FONTS: Array<[string, string]> = [
  ['"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif', 'Segoe UI (Windows)'],
  ['Bahnschrift, "Segoe UI", sans-serif', 'Bahnschrift'],
  ['Corbel, "Segoe UI", sans-serif', 'Corbel'],
  ['Candara, "Segoe UI", sans-serif', 'Candara'],
  ['Georgia, "Times New Roman", serif', 'Georgia (serif)'],
  ['"Cascadia Code", Consolas, monospace', 'Cascadia Code (mono)'],
];

const base = {
  radius: 10,
  font: FONTS[0][0],
  fontSize: 14,
  density: 'cozy' as const,
  backdrop: 'solid' as Backdrop,
  transparency: 0.25,
  customCss: '',
};

export const PRESETS: Theme[] = [
  {
    ...base, id: 'midnight', name: 'Midnight', base: 'dark',
    colors: { bg: '#15161c', sidebar: '#101116', surface: '#1d1f27', surfaceAlt: '#262935', border: '#2e3140', text: '#e8e9f0', textMuted: '#9a9db0', accent: '#7c6cff', accentText: '#ffffff', success: '#3ecf8e', warning: '#f5b84a', danger: '#f0566a' },
  },
  {
    ...base, id: 'amoled', name: 'AMOLED', base: 'dark',
    colors: { bg: '#000000', sidebar: '#000000', surface: '#0c0c0e', surfaceAlt: '#17171b', border: '#222228', text: '#f2f2f5', textMuted: '#8b8b96', accent: '#1ed760', accentText: '#000000', success: '#1ed760', warning: '#ffc247', danger: '#ff4d5e' },
  },
  {
    ...base, id: 'nord', name: 'Nord', base: 'dark',
    colors: { bg: '#2e3440', sidebar: '#272c36', surface: '#3b4252', surfaceAlt: '#434c5e', border: '#4c566a', text: '#eceff4', textMuted: '#a3acbd', accent: '#88c0d0', accentText: '#1d222b', success: '#a3be8c', warning: '#ebcb8b', danger: '#bf616a' },
  },
  {
    ...base, id: 'rose', name: 'Rosé', base: 'dark',
    colors: { bg: '#191724', sidebar: '#14121e', surface: '#1f1d2e', surfaceAlt: '#26233a', border: '#332f4a', text: '#e0def4', textMuted: '#908caa', accent: '#ebbcba', accentText: '#191724', success: '#9ccfd8', warning: '#f6c177', danger: '#eb6f92' },
  },
  {
    ...base, id: 'forest', name: 'Forest', base: 'dark',
    colors: { bg: '#141b17', sidebar: '#0f1512', surface: '#1b241f', surfaceAlt: '#233029', border: '#2d3c33', text: '#e3ece6', textMuted: '#93a69a', accent: '#6fcf97', accentText: '#0d1a12', success: '#6fcf97', warning: '#e9c46a', danger: '#e76f51' },
  },
  {
    ...base, id: 'sunset', name: 'Sunset', base: 'dark',
    colors: { bg: '#1c1420', sidebar: '#160f19', surface: '#251a2a', surfaceAlt: '#2f2236', border: '#3d2c45', text: '#f5e9f0', textMuted: '#b39cb0', accent: '#ff8a5c', accentText: '#1c1420', success: '#7bd389', warning: '#ffd166', danger: '#ff5d8f' },
  },
  {
    ...base, id: 'paper', name: 'Paper (light)', base: 'light',
    colors: { bg: '#f6f5f2', sidebar: '#ecebe6', surface: '#ffffff', surfaceAlt: '#f0efea', border: '#dedcd4', text: '#22211f', textMuted: '#6d6a63', accent: '#4f6bed', accentText: '#ffffff', success: '#1f9d63', warning: '#c78a12', danger: '#d43f4f' },
  },
  {
    ...base, id: 'frost', name: 'Frost (light)', base: 'light',
    colors: { bg: '#eef2f7', sidebar: '#e3e9f1', surface: '#ffffff', surfaceAlt: '#edf1f6', border: '#d4dce8', text: '#18202c', textMuted: '#5f6b7c', accent: '#0e8ce4', accentText: '#ffffff', success: '#16a34a', warning: '#d97706', danger: '#dc2626' },
  },
];

const KEY = 'omni.theme';
const SAVED_KEY = 'omni.savedThemes';

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

/** Validate & fill gaps in a theme from untrusted JSON (imports, account sync). */
export function sanitizeTheme(input: unknown): Theme | null {
  if (!input || typeof input !== 'object') return null;
  const t = input as Partial<Theme>;
  const fallback = PRESETS[0];
  const colors = { ...fallback.colors };
  if (t.colors && typeof t.colors === 'object') {
    for (const k of Object.keys(colors) as Array<keyof ThemeColors>) {
      const v = (t.colors as Partial<ThemeColors>)[k];
      if (isHex(v)) colors[k] = v;
    }
  }
  const num = (v: unknown, min: number, max: number, d: number) => (typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  return {
    id: typeof t.id === 'string' ? t.id.slice(0, 64) : `custom-${Date.now()}`,
    name: typeof t.name === 'string' ? t.name.slice(0, 40) : 'Imported theme',
    base: t.base === 'light' ? 'light' : 'dark',
    colors,
    radius: num(t.radius, 0, 24, fallback.radius),
    font: typeof t.font === 'string' && t.font.length < 200 && !/[;{}<>]/.test(t.font) ? t.font : fallback.font,
    fontSize: num(t.fontSize, 11, 20, fallback.fontSize),
    density: t.density === 'compact' || t.density === 'comfortable' ? t.density : 'cozy',
    backdrop: t.backdrop === 'mica' || t.backdrop === 'acrylic' ? t.backdrop : 'solid',
    transparency: num(t.transparency, 0, 0.8, fallback.transparency),
    customCss: typeof t.customCss === 'string' ? t.customCss.slice(0, 20000) : '',
  };
}

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeTheme(JSON.parse(raw)) ?? PRESETS[0];
  } catch {
    /* ignore */
  }
  return PRESETS[0];
}

export const theme = new Store<Theme>(loadTheme());
export const hasLocalTheme = () => localStorage.getItem(KEY) !== null;

let lastBackdrop: Backdrop | null = null;

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  const c = t.colors;
  const see = t.backdrop === 'solid' ? 1 : 1 - t.transparency;
  const vars: Record<string, string> = {
    '--bg': c.bg,
    '--sidebar': c.sidebar,
    '--surface': c.surface,
    '--surface-alt': c.surfaceAlt,
    '--border': c.border,
    '--text': c.text,
    '--text-muted': c.textMuted,
    '--accent': c.accent,
    '--accent-text': c.accentText,
    '--success': c.success,
    '--warning': c.warning,
    '--danger': c.danger,
    '--bg-rgb': hexToRgb(c.bg).join(' '),
    '--sidebar-rgb': hexToRgb(c.sidebar).join(' '),
    '--surface-rgb': hexToRgb(c.surface).join(' '),
    '--accent-rgb': hexToRgb(c.accent).join(' '),
    '--panel-alpha': String(see),
    '--radius': `${t.radius}px`,
    '--radius-sm': `${Math.max(0, Math.round(t.radius * 0.6))}px`,
    '--font': t.font,
    '--font-size': `${t.fontSize}px`,
    '--gap': t.density === 'compact' ? '6px' : t.density === 'comfortable' ? '14px' : '10px',
    '--row-h': t.density === 'compact' ? '30px' : t.density === 'comfortable' ? '42px' : '36px',
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.base = t.base;
  root.dataset.backdrop = t.backdrop;
  root.style.colorScheme = t.base;

  let custom = document.getElementById('omni-custom-css') as HTMLStyleElement | null;
  if (!custom) {
    custom = document.createElement('style');
    custom.id = 'omni-custom-css';
    document.head.appendChild(custom);
  }
  custom.textContent = t.customCss;

  if (t.backdrop !== lastBackdrop) {
    lastBackdrop = t.backdrop;
    void setBackdrop(t.backdrop);
  }
}

theme.subscribe((t) => {
  applyTheme(t);
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}, false);

export function setTheme(t: Theme): void {
  theme.set(t);
}

export function patchTheme(patch: Partial<Theme>): void {
  theme.update((t) => ({ ...t, ...patch }));
}

export function patchColors(patch: Partial<ThemeColors>): void {
  theme.update((t) => ({ ...t, colors: { ...t.colors, ...patch } }));
}

// ---- Saved custom themes ----------------------------------------------------
export function savedThemes(): Theme[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
    return Array.isArray(arr) ? (arr.map(sanitizeTheme).filter(Boolean) as Theme[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomTheme(t: Theme): void {
  const list = savedThemes().filter((x) => x.id !== t.id);
  list.unshift(t);
  localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 30)));
}

export function deleteCustomTheme(id: string): void {
  localStorage.setItem(SAVED_KEY, JSON.stringify(savedThemes().filter((x) => x.id !== id)));
}

/** Short shareable string for a theme ("theme code"). */
export function encodeTheme(t: Theme): string {
  return 'OMNI-THEME:' + btoa(unescape(encodeURIComponent(JSON.stringify(t))));
}

export function decodeTheme(code: string): Theme | null {
  try {
    const raw = code.trim().replace(/^OMNI-THEME:/, '');
    const json = raw.startsWith('{') ? raw : decodeURIComponent(escape(atob(raw)));
    return sanitizeTheme(JSON.parse(json));
  } catch {
    return null;
  }
}

// Apply immediately on load so there's no flash of the wrong colours.
applyTheme(theme.get());
