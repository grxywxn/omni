// Album-art colour tint for the music view ("dynamic colour").
import { musicPrefs } from '../prefs';

let root: HTMLElement | null = null;
let lastUrl: string | null = null;
const cache = new Map<string, string>();

export function bindTintRoot(el: HTMLElement | null): void {
  root = el;
}

function apply(color: string | null): void {
  if (!root) return;
  if (!color || !musicPrefs.get().dynamicColor) root.style.removeProperty('--tint');
  else root.style.setProperty('--tint', color);
}

/** Pass an image URL to sample, a CSS colour, or null to clear. */
export function setTint(source: string | null): void {
  lastUrl = source;
  if (!source) return apply(null);
  if (source.startsWith('#')) return apply(source);
  const cached = cache.get(source);
  if (cached) return apply(cached);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, 24, 24);
      const data = ctx.getImageData(0, 0, 24, 24).data;
      // Average of the more colourful pixels, so greys don't wash it out.
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
        const sat = Math.max(R, G, B) - Math.min(R, G, B);
        const w = 1 + sat / 32;
        r += R * w; g += G * w; b += B * w; n += w;
      }
      // Keep it dark enough for readable white text.
      const scale = Math.min(1, 150 / Math.max(1, Math.max(r, g, b) / n));
      const hex = '#' + [r, g, b].map((v) => Math.round((v / n) * scale).toString(16).padStart(2, '0')).join('');
      cache.set(source, hex);
      if (lastUrl === source) apply(hex);
    } catch {
      apply(null); // image host didn't allow reading pixels
    }
  };
  img.onerror = () => apply(null);
  img.src = source;
}
