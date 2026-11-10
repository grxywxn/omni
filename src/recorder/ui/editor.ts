import { h, icon, toast, modal, field, toggle, select } from '../../core/dom';
import { Disposer, debounce } from '../../core/store';
import { rec, fileUrl, revealInExplorer, pickFolder, fmtDuration, type TakeInfo, type TrackPeaks, type ExportOptions } from '../api';
import { recPrefs, patchRecPrefs } from '../state';
import { allPresets, presetById, type Settings } from '../presets';
import { processTake, chainEditor } from './process';

type Which = 'raw' | 'processed';

export function editorView(dir: string, opts: { back: () => void }): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  const el = h('div', { class: 'editor' }, h('div', { class: 'empty' }, 'Opening take…'));
  const audio = new Audio();
  audio.preload = 'auto';
  d.add(() => { audio.pause(); audio.src = ''; });

  let info: TakeInfo | null = null;
  let peaks: TrackPeaks[] = [];
  let which: Which = 'processed';
  let duration = 0;
  let sel: { a: number; b: number } | null = null;
  let zoom = 1;
  let busy = false;

  // ---- DOM skeleton -----------------------------------------------------------
  const title = h('input', { class: 'editor-title', maxlength: '80' });
  const meta = h('div', { class: 'muted editor-meta' });
  const abSwitch = h('div', { class: 'segmented' });
  const playBtn = h('button', { class: 'transport-btn', title: 'Play / pause (Space)' });
  const timeLabel = h('span', { class: 'editor-time' }, '0:00.0');
  const selLabel = h('span', { class: 'muted' });
  const undoBtn = h('button', { class: 'secondary', title: 'Undo (Ctrl+Z)' }, 'Undo');
  const cutBtn = h('button', { class: 'secondary', title: 'Delete selection (Del)' }, 'Cut');
  const trimBtn = h('button', { class: 'secondary', title: 'Keep only the selection' }, 'Trim');
  const zoomOut = h('button', { class: 'icon-btn', title: 'Zoom out (−)' }, icon('minus', 16));
  const zoomIn = h('button', { class: 'icon-btn', title: 'Zoom in (+)' }, '+');

  const lanes = h('div', { class: 'lanes' });
  const ruler = h('canvas', { class: 'ruler' });
  const overlay = h('div', { class: 'lane-overlay' });
  const selBox = h('div', { class: 'sel-box', hidden: true });
  const playhead = h('div', { class: 'playhead' });
  overlay.append(selBox, playhead);
  const inner = h('div', { class: 'wave-inner' }, ruler, lanes, overlay);
  const scroller = h('div', { class: 'wave-scroll' }, inner);
  const labels = h('div', { class: 'lane-labels' });

  const layout = () => {
    el.replaceChildren(
      h(
        'header',
        { class: 'editor-head' },
        h('button', { class: 'icon-btn', title: 'All takes', onclick: () => opts.back() }, '←'),
        h('div', { class: 'editor-title-wrap' }, title, meta),
        h('div', { class: 'row' },
          h('button', { class: 'secondary', onclick: () => openProcess() }, icon('sliders', 16), 'Clean up…'),
          h('button', { class: 'primary', onclick: () => openExport() }, icon('upload', 16), 'Export…'),
          h('button', { class: 'icon-btn', title: 'Show in File Explorer', onclick: () => void revealInExplorer(dir) }, icon('folder', 16))),
      ),
      h(
        'div',
        { class: 'editor-toolbar' },
        playBtn,
        timeLabel,
        selLabel,
        h('div', { class: 'spacer' }),
        abSwitch,
        h('div', { class: 'tool-group' }, cutBtn, trimBtn, h('button', { class: 'secondary', onclick: () => openSilence() }, 'Remove silences…'), undoBtn),
        h('div', { class: 'tool-group' }, zoomOut, zoomIn),
      ),
      h('div', { class: 'wave-area' }, labels, scroller),
      h('p', { class: 'muted editor-help' }, 'Drag across the waveform to select · click to jump · Space play · Del cut · Ctrl+Z undo · + / − zoom'),
    );
  };

  // ---- Loading ----------------------------------------------------------------
  const hasProcessed = () => !!info?.take.tracks.some((t) => t.processed);

  const load = async (keepTime = true) => {
    const t = keepTime ? audio.currentTime : 0;
    info = await rec.open(dir);
    if (!hasProcessed()) which = 'raw';
    title.value = info.take.name;
    const created = info.take.created ? new Date(info.take.created).toLocaleString() : '';
    meta.textContent = [created, `${info.take.tracks.length} track${info.take.tracks.length === 1 ? '' : 's'}`, ...info.take.tracks.filter((x) => x.lufs != null).map((x) => `${x.label}: ${x.lufs!.toFixed(1)} LUFS`)].filter(Boolean).join(' · ');
    undoBtn.toggleAttribute('disabled', !info.can_undo);
    await loadAudio(t);
    await loadPeaks();
    paintAB();
  };

  const loadAudio = async (t: number) => {
    const p = which === 'processed' ? info?.preview_processed : info?.preview_raw;
    if (!p) return;
    const wasPlaying = !audio.paused;
    audio.src = await fileUrl(p);
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = Math.min(t, audio.duration || 0);
      if (wasPlaying) void audio.play();
    }, { once: true });
  };

  const loadPeaks = async () => {
    const width = Math.round(scroller.clientWidth * zoom * Math.min(2, devicePixelRatio || 1));
    peaks = await rec.peaks(dir, which, Math.max(200, Math.min(8000, width)));
    duration = Math.max(0.01, ...peaks.map((p) => p.seconds));
    draw();
  };

  // ---- Drawing ------------------------------------------------------------------
  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const draw = () => {
    const w = Math.max(scroller.clientWidth, 200) * zoom;
    inner.style.width = `${w}px`;
    const dpr = devicePixelRatio || 1;
    const laneH = peaks.length > 2 ? 90 : 130;
    labels.replaceChildren(h('div', { class: 'ruler-spacer' }), ...peaks.map((p) => h('div', { class: 'lane-label', style: { height: `${laneH}px` } }, p.label)));
    lanes.replaceChildren();
    const color = which === 'processed' ? css('--accent') : css('--text-muted');
    for (const p of peaks) {
      const c = h('canvas', { class: 'lane', style: { height: `${laneH}px` } });
      c.width = Math.round(w * dpr);
      c.height = Math.round(laneH * dpr);
      const ctx = c.getContext('2d')!;
      const mid = c.height / 2;
      ctx.fillStyle = color;
      const span = (p.seconds / duration) * c.width;
      const n = p.peaks.length;
      for (let x = 0; x < span; x++) {
        const [lo, hi] = p.peaks[Math.min(n - 1, Math.floor((x / span) * n))];
        const y1 = mid - hi * mid * 0.95;
        const y2 = mid - lo * mid * 0.95;
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
      ctx.fillStyle = css('--border');
      ctx.fillRect(0, mid, c.width, 1);
      lanes.append(c);
    }
    // Ruler
    ruler.width = Math.round(w * dpr);
    ruler.height = Math.round(22 * dpr);
    const rc = ruler.getContext('2d')!;
    rc.scale(dpr, dpr);
    rc.fillStyle = css('--text-muted');
    rc.font = `11px ${css('--font') || 'sans-serif'}`;
    const pxPerSec = w / duration;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * pxPerSec > 70) ?? 600;
    for (let t = 0; t <= duration; t += step) {
      const x = t * pxPerSec;
      rc.fillRect(x, 14, 1, 8);
      rc.fillText(fmtDuration(t), x + 3, 11);
    }
    paintOverlay();
  };

  const xToTime = (clientX: number) => {
    const r = inner.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  const paintOverlay = () => {
    const w = inner.getBoundingClientRect().width || 1;
    playhead.style.left = `${(audio.currentTime / duration) * w}px`;
    timeLabel.textContent = `${fmtDuration(audio.currentTime, true)} / ${fmtDuration(duration)}`;
    if (sel && Math.abs(sel.b - sel.a) > 0.01) {
      const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
      selBox.hidden = false;
      selBox.style.left = `${(a / duration) * w}px`;
      selBox.style.width = `${((b - a) / duration) * w}px`;
      selLabel.textContent = `Selected ${fmtDuration(a, true)} – ${fmtDuration(b, true)} (${(b - a).toFixed(1)} s)`;
    } else {
      selBox.hidden = true;
      selLabel.textContent = '';
    }
    cutBtn.toggleAttribute('disabled', !sel || busy);
    trimBtn.toggleAttribute('disabled', !sel || busy);
    playBtn.replaceChildren(audio.paused ? icon('play', 18) : h('span', { class: 'pause-glyph small' }));
  };

  const paintAB = () => {
    abSwitch.replaceChildren(
      ...(['processed', 'raw'] as Which[]).map((w) =>
        h('button', {
          class: which === w ? 'active' : '',
          disabled: w === 'processed' && !hasProcessed(),
          title: w === 'processed' ? 'Hear the cleaned-up version' : 'Hear the original recording',
          onclick: async () => { which = w; await loadAudio(audio.currentTime); await loadPeaks(); paintAB(); },
        }, w === 'processed' ? 'Cleaned up' : 'Original'),
      ),
    );
  };

  // ---- Interaction ----------------------------------------------------------------
  overlay.addEventListener('mousedown', (e) => {
    const start = xToTime(e.clientX);
    const startX = e.clientX;
    sel = { a: start, b: start };
    const move = (ev: MouseEvent) => { sel = { a: start, b: xToTime(ev.clientX) }; paintOverlay(); };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (Math.abs(ev.clientX - startX) < 4) {
        sel = null;
        audio.currentTime = start;
      }
      paintOverlay();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  const togglePlay = () => (audio.paused ? void audio.play() : audio.pause());
  playBtn.addEventListener('click', togglePlay);
  let raf = 0;
  const tick = () => { paintOverlay(); if (!audio.paused) raf = requestAnimationFrame(tick); };
  audio.addEventListener('play', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); });
  audio.addEventListener('pause', paintOverlay);
  audio.addEventListener('ended', paintOverlay);
  d.add(() => cancelAnimationFrame(raf));

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    paintOverlay();
    try {
      await fn();
      await load();
    } catch (e) {
      toast(`${label} failed: ${(e as Error).message}`, 'error', 6000);
    } finally {
      busy = false;
      paintOverlay();
    }
  };

  const cutSel = () => {
    if (!sel) return;
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
    sel = null;
    void run('Cut', () => rec.cut(dir, a, b));
  };
  cutBtn.addEventListener('click', cutSel);
  trimBtn.addEventListener('click', () => {
    if (!sel) return;
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
    sel = null;
    audio.currentTime = 0;
    void run('Trim', () => rec.trim(dir, a, b));
  });
  undoBtn.addEventListener('click', () => void run('Undo', () => rec.undo(dir)));
  const rezoom = debounce(() => void loadPeaks(), 250);
  zoomIn.addEventListener('click', () => { zoom = Math.min(32, zoom * 2); draw(); rezoom(); });
  zoomOut.addEventListener('click', () => { zoom = Math.max(1, zoom / 2); draw(); rezoom(); });

  title.addEventListener('change', () => void rec.rename(dir, title.value.trim() || 'Take').catch((e) => toast(String(e), 'error')));

  const onKey = (e: KeyboardEvent) => {
    if (!el.isConnected || document.querySelector('.modal-backdrop')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName);
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); cutSel(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoBtn.click(); }
    else if (e.key === 'Escape') { sel = null; paintOverlay(); }
    else if (e.key === '+' || e.key === '=') zoomIn.click();
    else if (e.key === '-') zoomOut.click();
  };
  window.addEventListener('keydown', onKey);
  d.add(() => window.removeEventListener('keydown', onKey));

  const ro = new ResizeObserver(debounce(() => draw(), 100));
  ro.observe(scroller);
  d.add(() => ro.disconnect());

  // ---- Dialogs --------------------------------------------------------------------
  function openSilence() {
    if (!info) return;
    let threshold = -45, minMs = 700, keepMs = 350;
    const refs: Array<[string, string]> = info.take.tracks.map((t) => [t.id, t.label]);
    let reference = refs[0]?.[0] ?? '';
    const preview = h('p', { class: 'note' }, 'Adjust the settings, then check how much would be removed.');
    const slider = (label: string, min: number, max: number, step: number, val: number, unit: string, set: (v: number) => void, hint?: string) => {
      const out = h('span', { class: 'range-value' }, `${val} ${unit}`);
      const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(val) });
      r.addEventListener('input', () => { set(Number(r.value)); out.textContent = `${r.value} ${unit}`; void dry(); });
      return field(label, h('div', { class: 'range-row' }, r, out), hint);
    };
    const dry = debounce(async () => {
      try {
        const secs = await rec.removeSilence(dir, reference, threshold, minMs, keepMs, true);
        preview.textContent = secs > 0.05 ? `This would remove ${secs.toFixed(1)} s of pauses (${fmtDuration(duration)} → ${fmtDuration(duration - secs)}).` : 'No pauses long enough to shorten with these settings.';
      } catch (e) { preview.textContent = (e as Error).message; }
    }, 300);
    const body = h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, 'Shortens long pauses on every track at once, so everything stays in sync.'),
      refs.length > 1 ? field('Listen for speech on', select(reference, refs, (v) => { reference = v; void dry(); })) : null,
      slider('Silence is quieter than', -70, -20, 1, threshold, 'dB', (v) => (threshold = v), 'Raise it if pauses have background noise'),
      slider('Only shorten pauses longer than', 200, 3000, 50, minMs, 'ms', (v) => (minMs = v)),
      slider('Leave this much of each pause', 50, 1500, 50, keepMs, 'ms', (v) => (keepMs = v), 'Keeps a natural rhythm'),
      preview,
      h('div', { class: 'row end' },
        h('button', { class: 'ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => { close(); void run('Remove silences', async () => {
          const secs = await rec.removeSilence(dir, reference, threshold, minMs, keepMs, false);
          toast(`Removed ${secs.toFixed(1)} s of pauses`, 'success');
        }); } }, 'Remove silences')),
    );
    const close = modal('Remove silences', body, { width: 480 });
    void dry();
  }

  function openProcess() {
    if (!info) return;
    const p = recPrefs.get();
    const chosen: Record<string, Settings> = {};
    const rows = info.take.tracks.map((t) => {
      const cfg = p.tracks.find((x) => x.id === t.id);
      let presetId = cfg?.preset ?? 'youtube';
      chosen[t.id] = p.overrides[t.id] ?? presetById(presetId).settings;
      const custom = h('div', { class: 'chain-wrap', hidden: true });
      const presetSel = select(presetId, allPresets().map((x) => [x.id, x.name] as [string, string]), (v) => {
        presetId = v;
        chosen[t.id] = presetById(v).settings;
        if (!custom.hidden) { custom.replaceChildren(chainEditor(chosen[t.id], (s) => (chosen[t.id] = s))); }
      });
      return h(
        'div',
        { class: 'process-track' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, t.label), presetSel,
          h('button', { class: 'ghost', onclick: () => {
            custom.hidden = !custom.hidden;
            if (!custom.hidden && !custom.firstChild) custom.append(chainEditor(chosen[t.id], (s) => (chosen[t.id] = s)));
          } }, 'Customise')),
        custom,
      );
    });
    const body = h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted' }, 'Runs from your original recording each time, so you can try different settings freely.'),
      ...rows,
      h('div', { class: 'row end' },
        h('button', { class: 'ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'primary', onclick: async () => {
          close();
          // Remember customised settings for these tracks next time.
          patchRecPrefs({ overrides: { ...recPrefs.get().overrides, ...chosen } });
          busy = true;
          const r = await processTake(dir, chosen);
          busy = false;
          if (r) { which = 'processed'; await load(); }
        } }, 'Clean up')),
    );
    const close = modal('Clean up', body, { width: 640 });
  }

  function openExport() {
    if (!info) return;
    const p = recPrefs.get();
    let folder = dir;
    const o: ExportOptions = { folder, which: hasProcessed() ? 'processed' : 'raw', format: p.exportFormat, tracks: p.exportTracks, mix: p.exportMix };
    const folderLabel = h('code', { class: 'folder-path' }, folder);
    const body = h(
      'div',
      { class: 'stack' },
      field('Version', select(o.which, [['processed', 'Cleaned up'], ['raw', 'Original']], (v) => (o.which = v))),
      field('Format', select(o.format, [['wav24', 'WAV 24-bit (best for editing)'], ['wav16', 'WAV 16-bit (smaller)'], ['flac', 'FLAC (lossless, about half the size)'], ['wav32f', 'WAV 32-bit float']], (v) => (o.format = v))),
      toggle(o.tracks, (v) => (o.tracks = v), 'Each track as its own file'),
      toggle(o.mix, (v) => (o.mix = v), 'All tracks mixed into one file'),
      field('Save to', h('div', { class: 'folder-row' }, folderLabel, h('button', { class: 'secondary', onclick: async () => { const f = await pickFolder('Export to…', folder); if (f) { folder = f; folderLabel.textContent = f; } } }, 'Change…'))),
      h('div', { class: 'row end' },
        h('button', { class: 'ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'primary', onclick: async () => {
          if (!o.tracks && !o.mix) return toast('Pick tracks, a mix, or both', 'error');
          close();
          patchRecPrefs({ exportFormat: o.format, exportTracks: o.tracks, exportMix: o.mix });
          try {
            const files = await rec.export(dir, { ...o, folder });
            toast(`Exported ${files.length} file${files.length === 1 ? '' : 's'}`, 'success');
            if (files[0]) void revealInExplorer(files[0]);
          } catch (e) { toast(`Export failed: ${(e as Error).message}`, 'error', 7000); }
        } }, 'Export')),
    );
    const close = modal('Export', body, { width: 480 });
  }

  // ---- Start ------------------------------------------------------------------------
  layout();
  paintAB();
  requestAnimationFrame(() => {
    load(false).catch((e) => el.replaceChildren(h('div', { class: 'empty' }, (e as Error).message, h('div', null, h('button', { class: 'secondary', onclick: () => opts.back() }, 'Back')))));
  });

  return { el, dispose: () => d.dispose() };
}

