// A small red "REC 1:23" pill in the sidebar, visible from anywhere in Omni while recording.
import { h } from '../../core/dom';
import { status } from '../state';
import { fmtDuration } from '../api';

let mounted = false;

export function mountRecIndicator(): void {
  if (mounted) return;
  const slot = document.querySelector('.mini-player-slot');
  if (!slot) return;
  mounted = true;
  const pill = h('button', { class: 'rec-indicator', hidden: true, title: 'Recording — open the Recorder', onclick: () => import('../../ui/shell').then((m) => m.navigate('recorder')) });
  slot.prepend(pill);
  status.subscribe((s) => {
    pill.hidden = !(s.active && s.writing);
    pill.classList.toggle('paused', s.paused);
    pill.replaceChildren(h('span', { class: 'rec-dot live' }), h('span', { class: 'rec-indicator-text' }, s.paused ? 'Paused' : `REC ${fmtDuration(s.elapsed)}`));
  });
}
