import { h, field, toast, modal, toggle, select, confirmDialog } from '../../core/dom';
import { openExternal } from '../../core/native';
import { connectSpotify, cancelConnect, getClientId, setClientId, disconnectSpotify, REDIRECT_URI } from '../auth';
import { musicPrefs, patchMusicPrefs, type MusicPrefs } from '../prefs';
import { micon } from './common';

const copyBtn = (text: string) =>
  h('button', { class: 'secondary small-btn', type: 'button', onclick: () => void navigator.clipboard.writeText(text).then(() => toast('Copied', 'success', 1200)) }, 'Copy');

/** Step-by-step "Connect Spotify" guide shown until you're connected. */
export function setupScreen(): HTMLElement {
  const clientId = h('input', { value: getClientId(), placeholder: 'e.g. 1a2b3c4d5e6f…', autocomplete: 'off', spellcheck: 'false' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const connect = h('button', { class: 'primary big-btn', type: 'submit' }, micon('music', 18), 'Connect Spotify');
  const cancel = h('button', { class: 'ghost', type: 'button', hidden: true, onclick: () => void cancelConnect() }, 'Cancel');

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        err.textContent = '';
        const id = clientId.value.trim();
        if (!/^[0-9a-f]{32}$/i.test(id)) {
          err.textContent = 'A Client ID is 32 letters and numbers. Copy it from your app’s Settings page on the Spotify dashboard.';
          return;
        }
        setClientId(id);
        connect.disabled = true;
        connect.lastChild!.textContent = 'Waiting for you in the browser…';
        cancel.hidden = false;
        try {
          await connectSpotify();
          toast('Spotify connected!', 'success');
        } catch (ex) {
          const m = (ex as Error).message;
          if (m !== 'cancelled') err.textContent = m.includes('INVALID_CLIENT') || /redirect/i.test(m) ? `${m}. Check the Client ID and that the Redirect URI matches exactly.` : m;
        } finally {
          connect.disabled = false;
          connect.lastChild!.textContent = 'Connect Spotify';
          cancel.hidden = true;
        }
      },
    },
    field('Client ID', clientId),
    err,
    h('div', { class: 'row' }, connect, cancel),
  );

  return h(
    'div',
    { class: 'music-setup' },
    h('div', { class: 'setup-hero' }, h('span', { class: 'setup-icon' }, micon('music', 34)), h('h1', null, 'Connect your Spotify'), h('p', { class: 'muted' }, 'A one-time setup, about 3 minutes. Spotify requires every app to be registered by its owner — this is how Omni gets permission to play your music.')),
    h(
      'ol',
      { class: 'setup-steps' },
      h(
        'li',
        null,
        h('strong', null, 'Open the Spotify developer dashboard'),
        h('p', null, 'Sign in with your Spotify Premium account and accept the terms if asked.'),
        h('button', { class: 'secondary', type: 'button', onclick: () => void openExternal('https://developer.spotify.com/dashboard') }, 'Open developer.spotify.com'),
      ),
      h(
        'li',
        null,
        h('strong', null, 'Click “Create app” and fill in:'),
        h(
          'ul',
          { class: 'kv' },
          h('li', null, h('span', null, 'App name'), h('code', null, 'Omni')),
          h('li', null, h('span', null, 'Description'), h('code', null, 'My music player')),
          h('li', null, h('span', null, 'Redirect URI'), h('code', null, REDIRECT_URI), copyBtn(REDIRECT_URI)),
          h('li', null, h('span', null, 'APIs used'), h('span', null, 'tick ', h('b', null, 'Web API'), ' and ', h('b', null, 'Web Playback SDK'))),
        ),
        h('p', { class: 'muted' }, 'Paste the Redirect URI exactly — including http:// and /callback — and click Add before saving.'),
      ),
      h('li', null, h('strong', null, 'Copy the Client ID'), h('p', null, 'On your new app’s page, open ', h('b', null, 'Settings'), ' and copy the ', h('b', null, 'Client ID'), '. (You never need the Client Secret.)'), form),
      h(
        'li',
        null,
        h('strong', null, 'Sharing with friends? (optional)'),
        h('p', null, 'In the dashboard, open ', h('b', null, 'User Management'), ' and add each friend’s name and Spotify email. Spotify allows up to 5 people per personal app, and each needs Premium to play inside Omni. Give them the same Client ID.'),
      ),
    ),
  );
}

/** Music settings (gear button in the music top bar). */
export function openMusicSettings(): void {
  const p = musicPrefs.get();
  const set = <K extends keyof MusicPrefs>(k: K) => (v: MusicPrefs[K]) => patchMusicPrefs({ [k]: v } as Partial<MusicPrefs>);

  const body = h(
    'div',
    { class: 'stack-lg' },
    h(
      'section',
      { class: 'stack' },
      h('h3', null, 'Playback'),
      toggle(p.preferThisPc, set('preferThisPc'), 'Play in Omni when nothing else is playing'),
      toggle(p.shareNowPlaying, set('shareNowPlaying'), 'Show what I’m listening to on my Omni profile'),
    ),
    h(
      'section',
      { class: 'stack' },
      h('h3', null, 'Look & layout'),
      toggle(p.dynamicColor, set('dynamicColor'), 'Tint pages with colours from the album art'),
      toggle(p.showLibraryArt, set('showLibraryArt'), 'Show artwork in Your Library'),
      toggle(p.showAlbumColumn, set('showAlbumColumn'), 'Show the Album column in song lists'),
      toggle(p.showAddedColumn, set('showAddedColumn'), 'Show the Date added column'),
      toggle(p.vinylSpin, set('vinylSpin'), 'Spin the cover art like a record while playing'),
      h(
        'div',
        { class: 'grid-2' },
        field('Song row size', select(p.rowDensity, [['compact', 'Compact'], ['cozy', 'Cozy'], ['roomy', 'Roomy']], set('rowDensity'))),
        field('Player bar', select(p.playerPosition, [['bottom', 'Bottom'], ['top', 'Top']], set('playerPosition'))),
        field('Player style', select(p.playerStyle, [['full', 'Full'], ['minimal', 'Minimal']], set('playerStyle'))),
        field('Cover art shape', select(p.artShape, [['rounded', 'Rounded'], ['square', 'Square'], ['circle', 'Circle']], set('artShape'))),
      ),
      h('p', { class: 'muted' }, 'Colours, fonts and roundness follow your Omni theme (Settings → Appearance).'),
    ),
    h(
      'section',
      { class: 'stack' },
      h('h3', null, 'Spotify account'),
      h('p', { class: 'muted' }, `Client ID: ${getClientId() || '—'}`),
      h('div', null, h('button', { class: 'secondary', onclick: async () => {
        if (!(await confirmDialog('Disconnect Spotify', 'Disconnect Spotify from Omni on this PC? Your music and playlists stay on Spotify.', { confirmLabel: 'Disconnect', danger: true }))) return;
        disconnectSpotify();
        close();
      } }, 'Disconnect Spotify')),
    ),
  );
  const close = modal('Music settings', body, { width: 560 });
}
