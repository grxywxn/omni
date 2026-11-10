import { h, icon } from '../core/dom';
import { isTauri, minimize, toggleMaximize, closeWindow } from '../core/native';

/** Custom window title bar (the native one is hidden so the whole window is themeable). */
export function titlebar(center?: HTMLElement): HTMLElement {
  return h(
    'header',
    { class: 'titlebar', 'data-tauri-drag-region': true, ondblclick: (e: MouseEvent) => (e.target as HTMLElement).hasAttribute('data-tauri-drag-region') && toggleMaximize() },
    h('div', { class: 'titlebar-brand', 'data-tauri-drag-region': true }, h('span', { class: 'logo-mark small' }), 'Omni'),
    h('div', { class: 'titlebar-center', 'data-tauri-drag-region': true }, center ?? null),
    isTauri
      ? h(
          'div',
          { class: 'window-controls' },
          h('button', { class: 'wc', 'aria-label': 'Minimise', onclick: () => minimize() }, icon('minus', 16)),
          h('button', { class: 'wc', 'aria-label': 'Maximise', onclick: () => toggleMaximize() }, icon('square', 14)),
          h('button', { class: 'wc close', 'aria-label': 'Close', onclick: () => closeWindow() }, icon('x', 16)),
        )
      : h('div', { class: 'window-controls placeholder' }),
  );
}
