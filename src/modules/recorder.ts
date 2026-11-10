import '../recorder/recorder.css';
import { h, setChildren } from '../core/dom';
import { isTauri } from '../core/native';
import { recordView } from '../recorder/ui/record';
import { takesView } from '../recorder/ui/takes';
import { editorView } from '../recorder/ui/editor';
import { mountRecIndicator } from '../recorder/ui/indicator';

type Tab = { kind: 'record' } | { kind: 'takes' } | { kind: 'edit'; dir: string };

// Remember where you were if you leave the Recorder and come back.
let lastTab: Tab = { kind: 'record' };

export function mount(el: HTMLElement): () => void {
  mountRecIndicator();
  if (!isTauri) {
    el.append(h('div', { class: 'empty' }, 'The Recorder works in the Omni desktop app.'));
    return () => {};
  }
  const tabs = h('nav', { class: 'rec-tabs' });
  const body = h('div', { class: 'rec-body' });
  el.append(h('div', { class: 'recorder' }, h('div', { class: 'rec-header' }, h('h1', null, 'Recorder'), tabs), body));

  let dispose: (() => void) | null = null;
  const show = (t: Tab) => {
    lastTab = t;
    dispose?.();
    const view =
      t.kind === 'record'
        ? recordView({ openTake: (dir) => show({ kind: 'edit', dir }) })
        : t.kind === 'takes'
          ? takesView({ openTake: (dir) => show({ kind: 'edit', dir }) })
          : editorView(t.dir, { back: () => show({ kind: 'takes' }) });
    dispose = view.dispose;
    body.replaceChildren(view.el);
    setChildren(
      tabs,
      h('button', { class: `rec-tab ${t.kind === 'record' ? 'active' : ''}`, onclick: () => show({ kind: 'record' }) }, 'Record'),
      h('button', { class: `rec-tab ${t.kind === 'takes' ? 'active' : ''}`, onclick: () => show({ kind: 'takes' }) }, 'Takes'),
      t.kind === 'edit' ? h('button', { class: 'rec-tab active' }, 'Editor') : null,
    );
  };
  show(lastTab);
  return () => dispose?.();
}
