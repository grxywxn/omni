import { h, popover, closePopover, toast, append } from '../../core/dom';
import { Disposer } from '../../core/store';
import { api, fmtTime, type Device } from '../api';
import {
  player, livePosition, togglePlay, next, previous, seek, setVolume, toggleShuffle, cycleRepeat,
  toggleLikeCurrent, transferTo, omniDevice, sdkStatus,
} from '../player';
import { musicPrefs } from '../prefs';
import { go, openUri } from '../library';
import { micon } from './common';

function deviceIcon(type: string | null): string {
  return type === 'Smartphone' ? 'devices' : type === 'Speaker' ? 'volume' : 'devices';
}

/** Devices menu: switch playback between Omni, your phone, speakers, etc. */
export async function openDevices(anchor: HTMLElement): Promise<void> {
  const list = h('div', { class: 'menu devices-menu' }, h('div', { class: 'menu-title' }, 'Play on'), h('div', { class: 'muted pad' }, 'Looking for devices…'));
  popover(anchor, list, 'top');
  try {
    const { devices } = await api.devices();
    const omni = omniDevice();
    const all: Device[] = [...devices];
    if (omni && !all.some((d) => d.id === omni)) all.unshift({ id: omni, name: 'Omni', type: 'Computer', is_active: false, volume_percent: null });
    const st = sdkStatus.get();
    list.replaceChildren();
    append(list, [
      h('div', { class: 'menu-title' }, 'Play on'),
      ...all.map((d) =>
        h(
          'button',
          { class: `menu-item ${d.is_active ? 'active' : ''}`, onclick: () => { closePopover(); if (d.id) void transferTo(d.id); } },
          micon(deviceIcon(d.type), 16),
          h('span', null, d.id === omni ? 'Omni (this PC)' : d.name, d.is_active ? h('span', { class: 'live' }, ' • playing here') : null),
        ),
      ),
      !all.length ? h('div', { class: 'muted pad' }, 'No devices found. Open Spotify on your phone or another device, then try again.') : null,
      st.status === 'unsupported' || st.status === 'error' ? h('div', { class: 'note small' }, st.message ?? '') : null,
    ]);
  } catch (e) {
    toast((e as Error).message, 'error');
    closePopover();
  }
}

export function playerBar(): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();

  const artBox = h('button', { class: 'pb-art', title: 'Go to album' });
  const title = h('button', { class: 'pb-title text-link' });
  const artists = h('div', { class: 'pb-artists' });
  const like = h('button', { class: 'icon-btn pb-like', title: 'Save to Liked Songs', onclick: () => void toggleLikeCurrent() });

  const shuffleBtn = h('button', { class: 'icon-btn', title: 'Shuffle', onclick: () => void toggleShuffle() }, micon('shuffle', 18));
  const playBtn = h('button', { class: 'pb-play', title: 'Play / pause (Space)', onclick: () => void togglePlay() });
  const repeatBtn = h('button', { class: 'icon-btn', title: 'Repeat', onclick: () => void cycleRepeat() }, micon('repeat', 18));
  const posLabel = h('span', { class: 'pb-time' }, '0:00');
  const durLabel = h('span', { class: 'pb-time' }, '0:00');
  const seekBar = h('input', { type: 'range', class: 'pb-seek', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
  let seeking = false;
  seekBar.addEventListener('input', () => {
    seeking = true;
    const dur = player.get().track?.duration ?? 0;
    posLabel.textContent = fmtTime((Number(seekBar.value) / 1000) * dur);
    paintRange(seekBar);
  });
  seekBar.addEventListener('change', () => {
    const dur = player.get().track?.duration ?? 0;
    void seek((Number(seekBar.value) / 1000) * dur);
    seeking = false;
  });

  const volBtn = h('button', { class: 'icon-btn', title: 'Mute' });
  const vol = h('input', { type: 'range', class: 'pb-vol', min: '0', max: '100', value: String(player.get().volume), 'aria-label': 'Volume' });
  let beforeMute = player.get().volume || 60;
  vol.addEventListener('input', () => { setVolume(Number(vol.value)); paintRange(vol); });
  volBtn.addEventListener('click', () => {
    const v = player.get().volume;
    if (v > 0) { beforeMute = v; setVolume(0); } else setVolume(beforeMute);
  });
  vol.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(player.get().volume + (e.deltaY < 0 ? 5 : -5)); }, { passive: false });

  const queueBtn = h('button', { class: 'icon-btn', title: 'Queue', onclick: () => go({ view: 'queue' }) }, micon('queue', 18));
  const devBtn: HTMLElement = h('button', { class: 'icon-btn', title: 'Devices', onclick: () => void openDevices(devBtn) }, micon('devices', 18));
  const deviceLabel = h('div', { class: 'pb-device' });

  const el = h(
    'footer',
    { class: 'playerbar' },
    h('div', { class: 'pb-left' }, artBox, h('div', { class: 'pb-meta' }, title, artists), like),
    h(
      'div',
      { class: 'pb-center' },
      h('div', { class: 'pb-controls' }, shuffleBtn, h('button', { class: 'icon-btn', title: 'Previous', onclick: () => void previous() }, micon('prev', 18)), playBtn, h('button', { class: 'icon-btn', title: 'Next', onclick: () => void next() }, micon('next', 18)), repeatBtn),
      h('div', { class: 'pb-progress' }, posLabel, seekBar, durLabel),
    ),
    h('div', { class: 'pb-right' }, queueBtn, devBtn, volBtn, vol),
    deviceLabel,
  );

  let lastTrack = '';
  const paint = () => {
    const s = player.get();
    const t = s.track;
    el.classList.toggle('empty', !t);
    if (t && t.uri !== lastTrack) {
      lastTrack = t.uri;
      artBox.replaceChildren(t.art ? h('img', { src: t.art, alt: '' }) : micon('music', 22));
      artBox.onclick = () => t.album.uri && openUri(t.album.uri);
      title.textContent = t.name;
      title.onclick = () => t.album.uri && openUri(t.album.uri);
      artists.replaceChildren(...t.artists.flatMap((a, i) => [i ? ', ' : '', h('button', { class: 'text-link', onclick: () => openUri(a.uri) }, a.name)]));
      durLabel.textContent = fmtTime(t.duration);
    } else if (!t) {
      lastTrack = '';
      artBox.replaceChildren(micon('music', 22));
      title.textContent = 'Nothing playing';
      artists.replaceChildren(h('span', { class: 'muted' }, 'Pick something to play'));
      durLabel.textContent = '0:00';
    }
    el.classList.toggle('is-playing', s.playing);
    artBox.classList.toggle('spinning', s.playing && musicPrefs.get().vinylSpin);
    playBtn.replaceChildren(micon(s.playing ? 'pause' : 'play', 20));
    shuffleBtn.classList.toggle('on', s.shuffle);
    repeatBtn.classList.toggle('on', s.repeat !== 'off');
    repeatBtn.dataset.mode = s.repeat;
    repeatBtn.title = s.repeat === 'track' ? 'Repeat: this song' : s.repeat === 'context' ? 'Repeat: all' : 'Repeat: off';
    like.classList.toggle('on', s.liked);
    like.replaceChildren(micon(s.liked ? 'heartFill' : 'heart', 18));
    like.hidden = !t;
    if (document.activeElement !== vol) vol.value = String(s.volume);
    paintRange(vol);
    volBtn.replaceChildren(micon(s.volume === 0 ? 'mute' : s.volume < 50 ? 'volumeLow' : 'volume', 18));
    const other = s.deviceId && s.deviceId !== omniDevice();
    deviceLabel.hidden = !other;
    deviceLabel.textContent = other ? `Playing on ${s.deviceName}` : '';
    devBtn.classList.toggle('on', !!other);
    tick();
  };

  const tick = () => {
    const s = player.get();
    if (seeking || !s.track) return;
    const p = livePosition(s);
    posLabel.textContent = fmtTime(p);
    seekBar.value = String(Math.round((p / Math.max(1, s.track.duration)) * 1000));
    paintRange(seekBar);
  };

  d.add(player.subscribe(paint));
  d.add(musicPrefs.subscribe(paint, false));
  const timer = setInterval(() => !document.hidden && player.get().playing && tick(), 500);
  d.add(() => clearInterval(timer));

  return { el, dispose: () => d.dispose() };
}

/** Fill the left part of a range input with the accent colour. */
function paintRange(r: HTMLInputElement): void {
  const pct = ((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min))) * 100;
  r.style.setProperty('--fill', `${pct}%`);
}

/** Small player shown in the sidebar while you're elsewhere in Omni. */
export function miniPlayer(): HTMLElement {
  const artEl = h('span', { class: 'mini-art' });
  const text = h('span', { class: 'mini-text' });
  const playBtn = h('button', { class: 'icon-btn', title: 'Play / pause', onclick: (e: Event) => { e.stopPropagation(); void togglePlay(); } });
  const nextBtn = h('button', { class: 'icon-btn', title: 'Next', onclick: (e: Event) => { e.stopPropagation(); void next(); } }, micon('next', 15));
  const bar = h('span', { class: 'mini-bar' });
  const el = h('div', { class: 'mini-player', role: 'button', title: 'Open Music', onclick: () => import('../../ui/shell').then((m) => m.navigate('music')) }, artEl, text, playBtn, nextBtn, bar);

  const paint = () => {
    const s = player.get();
    el.hidden = !s.track;
    if (!s.track) return;
    artEl.replaceChildren(s.track.artSmall ? h('img', { src: s.track.artSmall, alt: '' }) : micon('music', 16));
    text.replaceChildren(h('strong', null, s.track.name), h('span', null, s.track.artists.map((a) => a.name).join(', ')));
    playBtn.replaceChildren(micon(s.playing ? 'pause' : 'play', 15));
    bar.style.width = `${(livePosition(s) / Math.max(1, s.track.duration)) * 100}%`;
  };
  player.subscribe(paint);
  setInterval(() => !document.hidden && !el.hidden && paint(), 1000);
  return el;
}
