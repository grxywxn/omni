import { h, modal, toast, toggle, field } from '../../core/dom';
import { rec, type ProcessReport } from '../api';
import { type Settings, clone, saveCustomPreset } from '../presets';

/** Run the clean-up chain with a progress dialog. Returns reports, or null if it failed. */
export async function processTake(dir: string, settings: Record<string, Settings>): Promise<ProcessReport[] | null> {
  const bar = h('div', { class: 'progress-fill' });
  const label = h('div', { class: 'muted' }, 'Removing noise and polishing your voice…');
  const close = modal('Cleaning up', h('div', { class: 'stack' }, label, h('div', { class: 'progress' }, bar)), { width: 420 });
  const timer = setInterval(async () => {
    try {
      const p = await rec.progress();
      bar.style.width = `${Math.round(p * 100)}%`;
    } catch { /* ignore */ }
  }, 200);
  try {
    const reports = await rec.process(dir, settings);
    const summary = reports.map((r) => `${r.output_lufs.toFixed(1)} LUFS`).join(', ');
    if (reports.length) toast(`Done — loudness ${summary}`, 'success', 4000);
    return reports;
  } catch (e) {
    toast(`Clean-up failed: ${(e as Error).message}`, 'error', 8000);
    return null;
  } finally {
    clearInterval(timer);
    close();
  }
}

type Num = { key: string; label: string; min: number; max: number; step: number; unit: string; hint?: string };

const STAGES: Array<{ key: keyof Settings; title: string; about: string; nums: Num[] }> = [
  { key: 'denoise', title: 'AI noise removal', about: 'RNNoise removes fans, hum, traffic and room noise while keeping speech.', nums: [{ key: 'amount', label: 'Strength', min: 0, max: 1, step: 0.05, unit: '%' }] },
  { key: 'highpass', title: 'Rumble filter', about: 'Cuts deep rumble, desk bumps and mic-stand noise below the voice.', nums: [{ key: 'freq', label: 'Cut below', min: 40, max: 200, step: 5, unit: 'Hz' }] },
  {
    key: 'gate', title: 'Noise gate', about: 'Turns down the background between sentences.',
    nums: [
      { key: 'threshold', label: 'Opens above', min: -70, max: -20, step: 1, unit: 'dB', hint: 'Lower = more sensitive' },
      { key: 'range', label: 'Turn down by', min: 3, max: 60, step: 1, unit: 'dB' },
      { key: 'hold', label: 'Hold', min: 0, max: 500, step: 10, unit: 'ms' },
      { key: 'release', label: 'Release', min: 20, max: 600, step: 10, unit: 'ms' },
    ],
  },
  {
    key: 'eq', title: 'Tone (EQ)', about: 'Shape your voice: warmth, boxiness, clarity and air.',
    nums: [
      { key: 'low', label: 'Warmth (120 Hz)', min: -8, max: 8, step: 0.5, unit: 'dB' },
      { key: 'mud', label: 'Boxiness (300 Hz)', min: -8, max: 8, step: 0.5, unit: 'dB' },
      { key: 'presence', label: 'Clarity (3.5 kHz)', min: -8, max: 8, step: 0.5, unit: 'dB' },
      { key: 'air', label: 'Air (12 kHz)', min: -8, max: 8, step: 0.5, unit: 'dB' },
    ],
  },
  {
    key: 'deesser', title: 'De-esser', about: 'Softens harsh “s” and “sh” sounds.',
    nums: [
      { key: 'freq', label: 'Frequency', min: 3500, max: 9000, step: 100, unit: 'Hz' },
      { key: 'threshold', label: 'Threshold', min: -50, max: -5, step: 1, unit: 'dB' },
      { key: 'reduction', label: 'Max reduction', min: 1, max: 15, step: 0.5, unit: 'dB' },
    ],
  },
  {
    key: 'compressor', title: 'Compressor', about: 'Evens out loud and quiet moments so you’re easy to hear.',
    nums: [
      { key: 'threshold', label: 'Threshold', min: -40, max: 0, step: 1, unit: 'dB' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 10, step: 0.5, unit: ':1' },
      { key: 'attack', label: 'Attack', min: 1, max: 100, step: 1, unit: 'ms' },
      { key: 'release', label: 'Release', min: 20, max: 500, step: 10, unit: 'ms' },
      { key: 'makeup', label: 'Make-up gain', min: 0, max: 12, step: 0.5, unit: 'dB' },
    ],
  },
  {
    key: 'loudness', title: 'Loudness', about: 'Matches platform loudness and prevents clipping. YouTube: −14 LUFS.',
    nums: [
      { key: 'target', label: 'Target', min: -24, max: -9, step: 0.5, unit: 'LUFS' },
      { key: 'ceiling', label: 'Peak ceiling', min: -3, max: -0.1, step: 0.1, unit: 'dB' },
    ],
  },
];

/** Panel to switch stages on/off and adjust them. Calls onChange with a fresh copy. */
export function chainEditor(initial: Settings, onChange: (s: Settings) => void): HTMLElement {
  const s = clone(initial);
  const emit = () => onChange(clone(s));
  const root = h('div', { class: 'chain' });

  root.append(h('div', { class: 'chain-row' }, toggle(s.mono, (v) => { s.mono = v; emit(); }, 'Mono output (recommended for a single voice)')));

  for (const st of STAGES) {
    const stage = s[st.key] as unknown as Record<string, number | boolean>;
    const body = h('div', { class: `chain-body ${stage.enabled ? '' : 'off'}` });
    for (const n of st.nums) {
      const pct = n.unit === '%';
      const fmt = (v: number) => (pct ? `${Math.round(v * 100)}%` : `${v > 0 && n.unit === 'dB' && st.key === 'eq' ? '+' : ''}${v} ${n.unit}`);
      const out = h('span', { class: 'range-value' }, fmt(stage[n.key] as number));
      const r = h('input', { type: 'range', min: String(n.min), max: String(n.max), step: String(n.step), value: String(stage[n.key]) });
      r.addEventListener('input', () => { stage[n.key] = Number(r.value); out.textContent = fmt(Number(r.value)); });
      r.addEventListener('change', emit);
      body.append(field(n.label, h('div', { class: 'range-row' }, r, out), n.hint));
    }
    root.append(
      h(
        'div',
        { class: 'chain-stage' },
        h('div', { class: 'chain-head' }, toggle(!!stage.enabled, (v) => { stage.enabled = v; body.classList.toggle('off', !v); emit(); }, st.title), h('span', { class: 'muted' }, st.about)),
        body,
      ),
    );
  }

  const presetName = h('input', { placeholder: 'Name, e.g. “My bedroom mic”', maxlength: '40' });
  root.append(
    h('div', { class: 'row save-preset' }, presetName, h('button', { class: 'secondary', onclick: () => {
      const name = presetName.value.trim();
      if (!name) return toast('Give the preset a name first', 'error');
      saveCustomPreset(name, s);
      presetName.value = '';
      toast(`Preset “${name}” saved — pick it from any track’s Clean-up menu`, 'success');
    } }, 'Save as preset')),
  );
  return root;
}
