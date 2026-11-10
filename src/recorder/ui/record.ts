import { h, icon, toast, toggle, select } from '../../core/dom';
import { Disposer } from '../../core/store';
import { rec, pickFolder, revealInExplorer, defaultRecordingsFolder, fmtDuration, fmtBytes, type Devices } from '../api';
import { recPrefs, patchRecPrefs, status, meters, current, startPolling, meterPos, type TrackConfig } from '../state';
import { allPresets, presetById } from '../presets';
import { processTake } from './process';

let devicesCache: Devices | null = null;

function newTrack(kind: 'input' | 'loopback', n: number): TrackConfig {
  return kind === 'input'
    ? { id: `mic${Date.now()}`, label: `Microphone ${n}`, device: '', kind, mono: true, gain_db: 0, preset: 'youtube' }
    : { id: `sys${Date.now()}`, label: 'System audio', device: '', kind, mono: false, gain_db: 0, preset: 'raw' };
}

function defaultTakeName(): string {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  return `Take ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

export function recordView(opts: { openTake: (dir: string) => void }): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  const el = h('div', { class: 'rec-view' });
  let nameValue = defaultTakeName();
  let busy = false;

  const meterEls = new Map<string, { bar: HTMLElement; hold: HTMLElement; clip: HTMLElement; err: HTMLElement }>();

  const ensureFolder = async (): Promise<string | null> => {
    let f = recPrefs.get().folder;
    if (!f) {
      f = await defaultRecordingsFolder();
      if (f) patchRecPrefs({ folder: f });
    }
    return f || null;
  };

  const specs = () => recPrefs.get().tracks.map(({ preset: _p, ...spec }) => spec);

  const soundCheck = async (on: boolean) => {
    try {
      if (on) {
        await rec.start(specs());
        startPolling();
      } else {
        await rec.stop();
      }
    } catch (e) {
      toast((e as Error).message, 'error', 6000);
    }
    render();
  };

  const startRecording = async () => {
    if (busy) return;
    const folder = await ensureFolder();
    if (!folder) return toast('Choose where to save recordings first.', 'error');
    if (!recPrefs.get().tracks.length) return toast('Add at least one track.', 'error');
    busy = true;
    try {
      current.name = nameValue.trim() || defaultTakeName();
      current.created = new Date().toISOString();
      current.dir = await rec.start(specs(), folder, current.name);
      startPolling();
    } catch (e) {
      toast((e as Error).message, 'error', 7000);
    } finally {
      busy = false;
      render();
    }
  };

  const stopRecording = async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      const r = await rec.stop(current.name, current.created);
      r.errors.forEach((e) => toast(e, 'error', 7000));
      if (r.dir && r.take) {
        toast(`Saved “${r.take.name}” (${fmtDuration(r.take.seconds)})`, 'success');
        nameValue = defaultTakeName();
        const p = recPrefs.get();
        if (p.autoProcess) {
          const settings = Object.fromEntries(p.tracks.map((t) => [t.id, p.overrides[t.id] ?? presetById(t.preset).settings]));
          await processTake(r.dir, settings);
        }
        if (p.openEditorAfter) opts.openTake(r.dir);
      }
    } catch (e) {
      toast((e as Error).message, 'error', 7000);
    } finally {
      busy = false;
      render();
    }
  };

  const togglePause = async () => {
    try {
      await rec.pause(!status.get().paused);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const deviceSelect = (t: TrackConfig, onChange: (kind: 'input' | 'loopback', device: string) => void) => {
    const dv = devicesCache;
    const s = h(
      'select',
      { onchange: () => { const [k, ...rest] = s.value.split('::'); onChange(k as 'input' | 'loopback', rest.join('::')); } },
      h(
        'optgroup',
        { label: 'Microphones & inputs' },
        h('option', { value: 'input::', selected: t.kind === 'input' && !t.device }, 'Windows default microphone'),
        (dv?.inputs ?? []).map((x) => h('option', { value: `input::${x.name}`, selected: t.kind === 'input' && t.device === x.name }, x.name)),
      ),
      h(
        'optgroup',
        { label: 'System audio (what your PC plays)' },
        h('option', { value: 'loopback::', selected: t.kind === 'loopback' && !t.device }, 'Default speakers / headphones'),
        (dv?.outputs ?? []).map((x) => h('option', { value: `loopback::${x.name}`, selected: t.kind === 'loopback' && t.device === x.name }, x.name)),
      ),
    );
    return s;
  };

  const updateTrack = (id: string, patch: Partial<TrackConfig>) => {
    patchRecPrefs({ tracks: recPrefs.get().tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  };

  const trackRow = (t: TrackConfig, locked: boolean) => {
    const bar = h('span', { class: 'meter-fill' });
    const hold = h('span', { class: 'meter-hold' });
    const clip = h('span', { class: 'meter-clip', title: 'Clipping! Lower the input level in Windows or the gain here.' }, 'CLIP');
    const err = h('span', { class: 'track-err' });
    meterEls.set(t.id, { bar, hold, clip, err });

    const label = h('input', { class: 'track-label', value: t.label, maxlength: '40', disabled: locked });
    label.addEventListener('change', () => updateTrack(t.id, { label: label.value.trim() || t.label }));

    const gainOut = h('span', { class: 'range-value' }, `${t.gain_db > 0 ? '+' : ''}${t.gain_db} dB`);
    const gain = h('input', { type: 'range', min: '-12', max: '24', step: '1', value: String(t.gain_db), disabled: locked });
    gain.addEventListener('input', () => (gainOut.textContent = `${Number(gain.value) > 0 ? '+' : ''}${gain.value} dB`));
    gain.addEventListener('change', () => updateTrack(t.id, { gain_db: Number(gain.value) }));

    const presetSel = select(t.preset, allPresets().map((p) => [p.id, p.name] as [string, string]), (v) => {
      const o = { ...recPrefs.get().overrides };
      delete o[t.id];
      patchRecPrefs({ overrides: o });
      updateTrack(t.id, { preset: v });
    });

    return h(
      'div',
      { class: `track-card kind-${t.kind}` },
      h('div', { class: 'track-icon' }, icon(t.kind === 'input' ? 'mic' : 'music', 18)),
      h(
        'div',
        { class: 'track-main' },
        h(
          'div',
          { class: 'track-top' },
          label,
          deviceSelect(t, (kind, device) => updateTrack(t.id, { kind, device, mono: kind === 'input' ? t.mono : false, preset: kind === 'loopback' && t.kind === 'input' ? 'raw' : t.preset })),
          h('button', { class: 'icon-btn', title: 'Remove track', disabled: locked, onclick: () => patchRecPrefs({ tracks: recPrefs.get().tracks.filter((x) => x.id !== t.id) }) }, icon('x', 16)),
        ),
        h('div', { class: 'meter' }, bar, hold, h('span', { class: 'meter-scale' }), clip),
        err,
        h(
          'div',
          { class: 'track-opts' },
          h('label', { class: 'mini-field' }, h('span', null, 'Gain'), gain, gainOut),
          h('label', { class: 'mini-field' }, h('span', null, 'Clean-up'), presetSel, recPrefs.get().overrides[t.id] ? h('span', { class: 'pill' }, 'customised') : null),
          toggle(t.mono, (v) => updateTrack(t.id, { mono: v }), 'Mono'),
        ),
      ),
    );
  };

  const render = () => {
    const p = recPrefs.get();
    const s = status.get();
    const recording = s.active && s.writing;
    const checking = s.active && !s.writing;
    meterEls.clear();

    el.replaceChildren(
      h(
        'section',
        { class: 'rec-hero' },
        h(
          'div',
          { class: 'rec-clock' },
          h('span', { class: `rec-dot ${recording && !s.paused ? 'live' : ''}` }),
          h('span', { class: 'rec-time' }, fmtDuration(recording ? s.elapsed : 0, true)),
          recording ? h('span', { class: 'muted' }, s.paused ? 'Paused' : `Recording · ${fmtBytes(s.bytes)}`) : h('span', { class: 'muted' }, checking ? 'Sound check — nothing is being saved' : 'Ready'),
        ),
        h(
          'div',
          { class: 'rec-transport' },
          recording
            ? [
                h('button', { class: 'transport-btn', title: 'Pause / resume (Ctrl+Shift+P)', onclick: () => void togglePause() }, s.paused ? icon('mic', 22) : h('span', { class: 'pause-glyph' })),
                h('button', { class: 'rec-btn stop', title: 'Stop (Ctrl+Shift+R)', disabled: busy, onclick: () => void stopRecording() }, h('span', { class: 'stop-glyph' })),
              ]
            : [
                h('button', { class: `transport-btn ${checking ? 'on' : ''}`, title: 'Check your levels without recording', onclick: () => void soundCheck(!checking) }, icon('sliders', 20)),
                h('button', { class: 'rec-btn', title: 'Start recording (Ctrl+Shift+R)', disabled: busy, onclick: () => void startRecording() }, h('span', { class: 'rec-glyph' })),
              ],
        ),
        h('input', { class: 'take-name', value: nameValue, disabled: recording, 'aria-label': 'Take name', oninput: (e: Event) => (nameValue = (e.target as HTMLInputElement).value) }),
      ),
      h(
        'section',
        { class: 'rec-section' },
        h('div', { class: 'rec-section-head' }, h('h3', null, 'Tracks'), h('span', { class: 'muted' }, 'Each track is saved as its own file, perfectly in sync.')),
        h('div', { class: 'tracks' }, p.tracks.map((t) => trackRow(t, recording || checking))),
        h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'secondary', disabled: recording || checking, onclick: () => patchRecPrefs({ tracks: [...p.tracks, newTrack('input', p.tracks.filter((x) => x.kind === 'input').length + 1)] }) }, icon('mic', 16), 'Add microphone'),
          h('button', { class: 'secondary', disabled: recording || checking, onclick: () => patchRecPrefs({ tracks: [...p.tracks, newTrack('loopback', 1)] }) }, icon('music', 16), 'Add system audio'),
          h('button', { class: 'ghost', disabled: recording || checking, onclick: () => { devicesCache = null; void loadDevices(); } }, 'Refresh devices'),
        ),
      ),
      h(
        'section',
        { class: 'rec-section grid-2' },
        h(
          'div',
          { class: 'stack' },
          h('h3', null, 'Save to'),
          h('div', { class: 'folder-row' }, h('code', { class: 'folder-path', title: p.folder }, p.folder || 'Documents\\Omni Recordings (default)'),
            h('button', { class: 'secondary', disabled: recording, onclick: async () => { const f = await pickFolder('Where should recordings be saved?', p.folder || undefined); if (f) patchRecPrefs({ folder: f }); } }, 'Change…'),
            p.folder ? h('button', { class: 'ghost', onclick: () => void revealInExplorer(p.folder) }, 'Open') : null),
          h('p', { class: 'muted' }, 'Each take gets its own folder with the original recording kept safely in “raw”.'),
        ),
        h(
          'div',
          { class: 'stack' },
          h('h3', null, 'When I stop'),
          toggle(p.autoProcess, (v) => patchRecPrefs({ autoProcess: v }), 'Clean up automatically (noise removal, EQ, loudness…)'),
          toggle(p.openEditorAfter, (v) => patchRecPrefs({ openEditorAfter: v }), 'Open the take in the editor'),
        ),
      ),
    );
    paintMeters();
  };

  const paintMeters = () => {
    const m = meters.get();
    const now = Date.now();
    for (const [id, els] of meterEls) {
      const v = m.get(id);
      els.bar.style.width = `${(1 - meterPos(v?.level ?? 0)) * 100}%`;
      els.hold.style.left = `${meterPos(v?.hold ?? 0) * 100}%`;
      els.clip.classList.toggle('on', !!v && now - v.clip < 1500);
      els.err.textContent = v?.error ?? '';
    }
  };

  const loadDevices = async () => {
    if (devicesCache) return;
    try {
      devicesCache = await rec.devices();
      render();
    } catch (e) {
      el.prepend(h('div', { class: 'note' }, (e as Error).message));
    }
  };

  // Re-render on state changes that affect layout; meters update in place.
  let lastKey = '';
  d.add(status.subscribe((s) => {
    const key = `${s.active}|${s.writing}|${s.paused}`;
    if (key !== lastKey) { lastKey = key; render(); return; }
    const t = el.querySelector('.rec-time');
    if (t) t.textContent = fmtDuration(s.writing ? s.elapsed : 0, true);
    const sub = el.querySelector('.rec-clock .muted');
    if (sub && s.writing && !s.paused) sub.textContent = `Recording · ${fmtBytes(s.bytes)}`;
  }));
  d.add(meters.subscribe(paintMeters, false));
  d.add(recPrefs.subscribe(() => !status.get().active && render(), false));

  // Keyboard shortcuts while Omni is focused.
  const onKey = (e: KeyboardEvent) => {
    if (!el.isConnected || !e.ctrlKey || !e.shiftKey) return;
    if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      const s = status.get();
      void (s.active && s.writing ? stopRecording() : startRecording());
    } else if (e.key.toLowerCase() === 'p' && status.get().writing) {
      e.preventDefault();
      void togglePause();
    }
  };
  window.addEventListener('keydown', onKey);
  d.add(() => window.removeEventListener('keydown', onKey));

  render();
  void loadDevices();
  void ensureFolder().then(() => render());
  // If a recording was already running (you came back to this page), pick it up.
  void rec.status().then((s) => { status.set(s); if (s.active) startPolling(); }).catch(() => {});

  return { el, dispose: () => d.dispose() };
}

