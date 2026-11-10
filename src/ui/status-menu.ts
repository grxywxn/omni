import { h, modal, closePopover, toast, field, select } from '../core/dom';
import { updateProfile, me } from '../lib/profiles';
import { activeStatus, PRESENCE_LABEL, type PresencePref } from '../lib/types';

const PREFS: Array<[PresencePref, string]> = [
  ['online', 'Online'],
  ['idle', 'Idle'],
  ['dnd', 'Do Not Disturb — you appear busy'],
  ['invisible', 'Invisible — you appear offline'],
];

export async function setPresence(pref: PresencePref): Promise<void> {
  try {
    await updateProfile({ presence_pref: pref });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** The menu that opens when you click your own avatar in the sidebar. */
export function statusMenu(): HTMLElement {
  const p = me.get();
  const st = p ? activeStatus(p) : null;
  return h(
    'div',
    { class: 'menu' },
    h(
      'button',
      { class: 'menu-item', onclick: () => { closePopover(); openCustomStatus(); } },
      h('span', { class: 'emoji' }, st?.emoji || '😊'),
      h('span', null, st ? st.text || 'Edit custom status' : 'Set a custom status'),
    ),
    st ? h('button', { class: 'menu-item muted', onclick: () => { closePopover(); void clearStatus(); } }, 'Clear custom status') : null,
    h('div', { class: 'menu-sep' }),
    PREFS.map(([v, label]) =>
      h(
        'button',
        { class: `menu-item ${p?.presence_pref === v ? 'active' : ''}`, onclick: () => { closePopover(); void setPresence(v); } },
        h('span', { class: `presence-dot inline ${v}` }),
        h('span', null, label),
      ),
    ),
  );
}

async function clearStatus(): Promise<void> {
  try {
    await updateProfile({ status_emoji: null, status_text: null, status_expires_at: null });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

const QUICK_EMOJI = ['😊', '😎', '🎧', '🎬', '🎙️', '📚', '✍️', '💻', '☕', '🍕', '🎮', '😴', '🤒', '🏖️', '🔥', '✨', '💜', '🚀', '🧠', '🌙'];

type Expiry = 'never' | '30m' | '1h' | '4h' | 'today';
const EXPIRY: Array<[Expiry, string]> = [
  ['today', 'Today'],
  ['4h', '4 hours'],
  ['1h', '1 hour'],
  ['30m', '30 minutes'],
  ['never', "Don't clear"],
];

function expiresAt(e: Expiry): string | null {
  const now = new Date();
  if (e === 'never') return null;
  if (e === 'today') {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }
  const mins = e === '30m' ? 30 : e === '1h' ? 60 : 240;
  return new Date(now.getTime() + mins * 60_000).toISOString();
}

export function openCustomStatus(): void {
  const p = me.get();
  if (!p) return;
  const st = activeStatus(p);
  let emoji = st?.emoji ?? '😊';
  let expiry: Expiry = 'today';

  const emojiBtn = h('button', { class: 'emoji-btn', type: 'button', 'aria-label': 'Emoji' }, emoji);
  const emojiInput = h('input', { class: 'emoji-input', maxlength: '8', placeholder: 'or type/paste any emoji', value: '' });
  const textInput = h('input', { maxlength: '128', placeholder: "What's happening?", value: st?.text ?? '' });

  const setEmoji = (e: string) => {
    emoji = e;
    emojiBtn.textContent = e || '·';
  };
  emojiInput.addEventListener('input', () => setEmoji(emojiInput.value.trim()));

  const grid = h(
    'div',
    { class: 'emoji-grid' },
    QUICK_EMOJI.map((e) => h('button', { type: 'button', class: 'emoji-cell', onclick: () => setEmoji(e) }, e)),
  );

  const save = async () => {
    try {
      await updateProfile({
        status_emoji: emoji || null,
        status_text: textInput.value.trim() || null,
        status_expires_at: expiresAt(expiry),
      });
      close();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const body = h(
    'form',
    { class: 'stack', onsubmit: (e: Event) => { e.preventDefault(); void save(); } },
    h('div', { class: 'status-row' }, emojiBtn, textInput),
    grid,
    emojiInput,
    field('Clear after', select(expiry, EXPIRY, (v) => (expiry = v))),
    h(
      'div',
      { class: 'row end' },
      h('button', { type: 'button', class: 'ghost', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, 'Save status'),
    ),
  );
  const close = modal('Set a custom status', body, { width: 440 });
  textInput.focus();
}

export const presenceLabel = (pref: PresencePref) => PRESENCE_LABEL[pref];
