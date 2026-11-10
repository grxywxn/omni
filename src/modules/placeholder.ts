import { h, icon } from '../core/dom';

/** Shared "coming soon" view for modules that arrive in later phases. */
export function comingSoon(el: HTMLElement, opts: { icon: string; title: string; phase: string; points: string[] }): void {
  el.append(
    h(
      'div',
      { class: 'coming-soon' },
      h('span', { class: 'coming-icon' }, icon(opts.icon, 40)),
      h('h1', null, opts.title),
      h('span', { class: 'pill' }, `Arrives in ${opts.phase}`),
      h('ul', { class: 'coming-list' }, opts.points.map((p) => h('li', null, p))),
    ),
  );
}
