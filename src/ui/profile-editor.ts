import { h, field, toast, select, icon } from '../core/dom';
import { Disposer } from '../core/store';
import { me, updateProfile, uploadProfileImage } from '../lib/profiles';
import { statusOf } from '../lib/presence';
import type { AvatarDecoration, EditableProfile, NameEffect, Profile, ProfileEffect } from '../lib/types';
import { profileCard } from './profile-card';
import { avatar } from './avatar';

const DECORATIONS: Array<[AvatarDecoration, string]> = [
  ['none', 'None'],
  ['halo', 'Halo'],
  ['neon', 'Neon pulse'],
  ['rainbow', 'Rainbow spin'],
  ['gold', 'Gold ring'],
  ['orbit', 'Orbit'],
];
const NAME_FX: Array<[NameEffect, string]> = [
  ['none', 'Plain'],
  ['gradient', 'Gradient'],
  ['glow', 'Glow'],
  ['rainbow', 'Rainbow'],
];
const PROFILE_FX: Array<[ProfileEffect, string]> = [
  ['none', 'None'],
  ['sparkle', 'Sparkles'],
  ['snow', 'Snowfall'],
  ['aurora', 'Aurora'],
];

const EDITABLE_KEYS: Array<keyof EditableProfile> = [
  'username', 'display_name', 'pronouns', 'bio', 'avatar_url', 'banner_url', 'banner_color',
  'theme_primary', 'theme_accent', 'name_color', 'name_effect', 'avatar_decoration', 'profile_effect',
];

export function profileEditor(): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  const original = me.get();
  if (!original) return { el: h('div', null, 'Not signed in'), dispose: () => {} };

  let draft: Profile = { ...original };
  const preview = h('div', { class: 'editor-preview' });
  const saveBar = h('div', { class: 'save-bar', hidden: true });

  const dirtyPatch = (): EditableProfile => {
    const base = me.get() ?? original;
    const patch: Record<string, unknown> = {};
    for (const k of EDITABLE_KEYS) if (draft[k] !== base[k]) patch[k] = draft[k];
    return patch as EditableProfile;
  };

  const refresh = () => {
    preview.replaceChildren(h('div', { class: 'preview-label' }, 'Preview'), profileCard(draft, statusOf(draft.id)));
    saveBar.hidden = Object.keys(dirtyPatch()).length === 0;
  };

  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => {
    draft = { ...draft, [k]: v };
    refresh();
  };

  // ---- inputs ---------------------------------------------------------------
  const text = (k: 'display_name' | 'pronouns' | 'username', max: number, placeholder = '') => {
    const i = h('input', { value: draft[k] ?? '', maxlength: String(max), placeholder });
    i.addEventListener('input', () => {
      if (k === 'username') i.value = i.value.toLowerCase().replace(/[^a-z0-9_.]/g, '');
      set(k, (i.value || (k === 'username' ? draft.username : null)) as Profile[typeof k]);
    });
    return i;
  };
  const color = (k: 'banner_color' | 'theme_primary' | 'theme_accent' | 'name_color') => {
    const i = h('input', { type: 'color', value: draft[k] });
    i.addEventListener('input', () => set(k, i.value));
    return i;
  };

  const bioField = () => {
    const bio = h('textarea', { rows: '4', maxlength: '400', placeholder: 'Tell people a little about yourself' }, draft.bio ?? '');
    const bioCount = h('span', { class: 'field-hint' }, `${(draft.bio ?? '').length}/400`);
    bio.addEventListener('input', () => {
      bioCount.textContent = `${bio.value.length}/400`;
      set('bio', bio.value || null);
    });
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'About me'), bio, bioCount);
  };

  const imagePicker = (kind: 'avatar' | 'banner') => {
    const key = kind === 'avatar' ? 'avatar_url' : 'banner_url';
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    const btn = h('button', { type: 'button', class: 'secondary', onclick: () => file.click() }, icon('upload', 15), kind === 'avatar' ? 'Change avatar' : 'Change banner');
    const remove = h('button', { type: 'button', class: 'ghost', onclick: () => set(key, null) }, 'Remove');
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      btn.disabled = true;
      btn.lastChild!.textContent = 'Uploading…';
      try {
        const url = await uploadProfileImage(kind, f);
        set(key, url);
        toast(`${kind === 'avatar' ? 'Avatar' : 'Banner'} uploaded — remember to save.`, 'success');
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        btn.disabled = false;
        btn.lastChild!.textContent = kind === 'avatar' ? 'Change avatar' : 'Change banner';
      }
    });
    return h('div', { class: 'row' }, btn, remove, file);
  };

  // Decoration picker shows a live mini-avatar for each option.
  const decoGrid = h('div', { class: 'choice-grid' });
  const renderDeco = () =>
    decoGrid.replaceChildren(
      ...DECORATIONS.map(([v, label]) =>
        h(
          'button',
          { type: 'button', class: `choice ${draft.avatar_decoration === v ? 'active' : ''}`, onclick: () => { set('avatar_decoration', v); renderDeco(); } },
          avatar({ ...draft, avatar_decoration: v }, 44, null),
          h('span', null, label),
        ),
      ),
    );
  renderDeco();

  const save = h('button', { class: 'primary' }, 'Save changes');
  save.addEventListener('click', async () => {
    const patch = dirtyPatch();
    if (!Object.keys(patch).length) return;
    save.disabled = true;
    try {
      await updateProfile(patch);
      draft = { ...(me.get() ?? draft) };
      refresh();
      toast('Profile saved', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      save.disabled = false;
    }
  });
  const reset = h('button', { class: 'ghost', onclick: () => { draft = { ...(me.get() ?? original) }; rebuild(); } }, 'Reset');
  saveBar.append(h('span', null, 'You have unsaved changes'), h('div', { class: 'row' }, reset, save));

  const form = h('div', { class: 'editor-form' });
  const rebuild = () => {
    form.replaceChildren(
      h('h3', null, 'Identity'),
      h('div', { class: 'grid-2' }, field('Display name', text('display_name', 40)), field('Username', text('username', 32), 'a–z, 0–9, _ and .')),
      field('Pronouns', text('pronouns', 40, 'e.g. she/her')),
      bioField(),

      h('h3', null, 'Avatar & banner'),
      field('Avatar (PNG, JPG, WebP or animated GIF, up to 8 MB)', imagePicker('avatar')),
      field('Banner image', imagePicker('banner')),
      field('Banner colour (used when there is no banner image)', color('banner_color')),

      h('h3', null, 'Profile theme'),
      h('div', { class: 'grid-2' }, field('Primary', color('theme_primary')), field('Accent', color('theme_accent'))),

      h('h3', null, 'Avatar decoration'),
      decoGrid,

      h('h3', null, 'Effects'),
      h(
        'div',
        { class: 'grid-2' },
        field('Name style', select(draft.name_effect, NAME_FX, (v) => set('name_effect', v))),
        field('Second name colour', color('name_color'), 'Used by Gradient and Glow (with your accent).'),
      ),
      field('Profile effect', select(draft.profile_effect, PROFILE_FX, (v) => set('profile_effect', v))),
    );
    renderDeco();
    refresh();
  };
  rebuild();

  // If your profile changes elsewhere (another PC), refresh the preview's base.
  d.add(me.subscribe(() => refresh(), false));

  const el = h('div', { class: 'profile-editor' }, form, preview, saveBar);
  return { el, dispose: () => d.dispose() };
}
