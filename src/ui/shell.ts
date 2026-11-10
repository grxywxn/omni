import { h, icon, popover, toast, closePopover, append } from '../core/dom';
import { Store, Disposer } from '../core/store';
import { settings, patchSettings, type ModuleId } from '../core/settings';
import { theme, setTheme, PRESETS } from '../core/theme';
import { me, members } from '../lib/profiles';
import { presence, statusOf, autoIdle } from '../lib/presence';
import { signOut } from '../lib/auth';
import { activeStatus, displayName, PRESENCE_LABEL, type Profile } from '../lib/types';
import { avatar, nameTag } from './avatar';
import { profileCard } from './profile-card';
import { statusMenu, openCustomStatus, setPresence } from './status-menu';
import { titlebar } from './titlebar';

export type MountFn = (el: HTMLElement) => (() => void) | void;

interface ModuleDef {
  id: ModuleId;
  title: string;
  icon: string;
  load: () => Promise<{ mount: MountFn }>;
}

// Each module is a separate code chunk, downloaded & parsed only when first opened.
const MODULES: ModuleDef[] = [
  { id: 'home', title: 'Home', icon: 'home', load: () => import('../modules/home') },
  { id: 'music', title: 'Music', icon: 'music', load: () => import('../modules/music') },
  { id: 'notes', title: 'Notes', icon: 'notes', load: () => import('../modules/notes') },
  { id: 'recorder', title: 'Recorder', icon: 'mic', load: () => import('../modules/recorder') },
  { id: 'settings', title: 'Settings', icon: 'settings', load: () => import('../modules/settings') },
];

export const route = new Store<{ module: ModuleId; sub?: string }>({ module: settings.get().startModule });

export function navigate(module: ModuleId, sub?: string): void {
  route.set({ module, sub });
}

/** Open someone's profile card next to an element. */
export function openProfile(p: Profile, anchor: HTMLElement): void {
  popover(anchor, profileCard(p, statusOf(p.id)), 'left');
}

export function renderShell(root: HTMLElement): () => void {
  const d = new Disposer();

  const content = h('main', { class: 'content' });
  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Modules' });
  const membersPanel = h('aside', { class: 'members-panel', 'aria-label': 'Members' });
  const paletteBtn = h(
    'button',
    { class: 'palette-btn', onclick: () => openPalette() },
    icon('search', 15),
    h('span', null, 'Search or run a command'),
    h('kbd', null, 'Ctrl K'),
  );

  root.replaceChildren(titlebar(paletteBtn), h('div', { class: 'layout' }, sidebar, content, membersPanel));

  // ---- Sidebar ------------------------------------------------------------
  const navButtons = new Map<ModuleId, HTMLElement>();
  const navTop = h('div', { class: 'nav-group' });
  for (const m of MODULES.filter((m) => m.id !== 'settings')) {
    const b = h('button', { class: 'nav-item', title: m.title, onclick: () => navigate(m.id) }, icon(m.icon, 20), h('span', { class: 'nav-label' }, m.title));
    navButtons.set(m.id, b);
    navTop.appendChild(b);
  }
  const userPanel = h('div', { class: 'user-panel' });
  const settingsBtn = h('button', { class: 'nav-item', title: 'Settings', onclick: () => navigate('settings') }, icon('settings', 20), h('span', { class: 'nav-label' }, 'Settings'));
  navButtons.set('settings', settingsBtn);
  sidebar.append(navTop, h('div', { class: 'nav-spacer' }), h('div', { class: 'mini-player-slot' }), settingsBtn, userPanel);

  const renderUserPanel = () => {
    const p = me.get();
    if (!p) return;
    const st = activeStatus(p);
    const s = statusOf(p.id);
    const btn: HTMLElement = h(
      'button',
      { class: 'user-chip', title: 'Set status', onclick: () => popover(btn, statusMenu(), 'top') },
      avatar(p, 34, s),
      h(
        'span',
        { class: 'user-chip-text nav-label' },
        h('span', { class: 'user-chip-name' }, displayName(p)),
        h('span', { class: 'user-chip-status' }, st ? `${st.emoji ?? ''} ${st.text ?? ''}`.trim() : PRESENCE_LABEL[s]),
      ),
    );
    userPanel.replaceChildren(btn);
  };
  d.add(me.subscribe(renderUserPanel));
  d.add(autoIdle.subscribe(renderUserPanel, false));

  d.add(settings.subscribe((s) => {
    sidebar.classList.toggle('labels', s.sidebarLabels);
    membersPanel.classList.toggle('hidden', !s.showMembersPanel);
  }));

  // ---- Module router --------------------------------------------------------
  const alive = new Map<ModuleId, { el: HTMLElement; cleanup?: () => void }>();
  let current: ModuleId | null = null;
  let loadToken = 0;

  const show = async (id: ModuleId) => {
    for (const [mid, b] of navButtons) b.classList.toggle('active', mid === id);
    document.body.dataset.module = id;
    if (id === current) return;
    const prev = current;
    current = id;

    if (prev) {
      const entry = alive.get(prev);
      if (entry) {
        if (settings.get().keepModulesAlive) entry.el.hidden = true;
        else {
          entry.cleanup?.();
          entry.el.remove();
          alive.delete(prev);
        }
      }
    }

    const existing = alive.get(id);
    if (existing) {
      existing.el.hidden = false;
      return;
    }
    const token = ++loadToken;
    const el = h('section', { class: 'module', dataset: { module: id } }, h('div', { class: 'loading' }, 'Loading…'));
    content.appendChild(el);
    alive.set(id, { el });
    try {
      const def = MODULES.find((m) => m.id === id)!;
      const mod = await def.load();
      // You may have switched away while this chunk was loading.
      if (token !== loadToken || current !== id || !el.isConnected) {
        el.remove();
        if (alive.get(id)?.el === el) alive.delete(id);
        return;
      }
      el.replaceChildren();
      const cleanup = mod.mount(el) ?? undefined;
      alive.set(id, { el, cleanup });
    } catch (e) {
      console.error(e);
      el.replaceChildren(h('div', { class: 'empty' }, `Couldn't load ${id}: ${(e as Error).message}`));
    }
  };
  d.add(route.subscribe((r) => void show(r.module)));
  d.add(() => {
    for (const { el, cleanup } of alive.values()) {
      cleanup?.();
      el.remove();
    }
    alive.clear();
  });

  // ---- Members panel --------------------------------------------------------
  const renderMembers = () => {
    const all = [...members.get().values()];
    const online: Profile[] = [];
    const offline: Profile[] = [];
    for (const p of all) {
      const s = statusOf(p.id);
      (s === 'offline' || s === 'invisible' ? offline : online).push(p);
    }
    const byName = (a: Profile, b: Profile) => displayName(a).localeCompare(displayName(b));
    online.sort(byName);
    offline.sort(byName);

    const row = (p: Profile) => {
      const st = activeStatus(p);
      const s = statusOf(p.id);
      const el: HTMLElement = h(
        'button',
        { class: `member-row ${s === 'offline' || s === 'invisible' ? 'is-offline' : ''}`, onclick: () => openProfile(p, el) },
        avatar(p, 32, s, { decoration: false }),
        h(
          'span',
          { class: 'member-text' },
          nameTag(p, 'member-name'),
          p.now_playing
            ? h('span', { class: 'member-status' }, `🎧 ${p.now_playing.title}`)
            : st
              ? h('span', { class: 'member-status' }, `${st.emoji ?? ''} ${st.text ?? ''}`.trim())
              : null,
        ),
      );
      return el;
    };

    membersPanel.replaceChildren();
    append(membersPanel, [
      h('div', { class: 'members-head' }, h('span', null, 'Members'), h('button', { class: 'icon-btn', title: 'Hide members (Ctrl+M)', onclick: () => patchSettings({ showMembersPanel: false }) }, icon('sidebar', 16))),
      h('div', { class: 'members-section' }, `Online — ${online.length}`),
      online.map(row),
      offline.length ? h('div', { class: 'members-section' }, `Offline — ${offline.length}`) : null,
      offline.map(row),
    ]);
  };
  d.add(members.subscribe(renderMembers));
  d.add(presence.subscribe(renderMembers, false));
  d.add(autoIdle.subscribe(renderMembers, false));
  // Statuses with an expiry need re-checking now and then.
  const expiryTimer = setInterval(() => { renderMembers(); renderUserPanel(); }, 60_000);
  d.add(() => clearInterval(expiryTimer));

  // ---- Keyboard shortcuts ---------------------------------------------------
  const onKey = (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); openPalette(); }
    else if (k === 'm') { e.preventDefault(); patchSettings({ showMembersPanel: !settings.get().showMembersPanel }); }
    else if (k === ',') { e.preventDefault(); navigate('settings'); }
    else if (/^[1-4]$/.test(k)) { e.preventDefault(); navigate(MODULES[Number(k) - 1].id); }
  };
  window.addEventListener('keydown', onKey);
  d.add(() => window.removeEventListener('keydown', onKey));

  return () => d.dispose();
}

// ---- Command palette ---------------------------------------------------------
interface Command {
  label: string;
  hint?: string;
  run: () => void;
}

function commands(): Command[] {
  const list: Command[] = [
    ...MODULES.map((m, i) => ({ label: `Go to ${m.title}`, hint: m.id === 'settings' ? 'Ctrl ,' : `Ctrl ${i + 1}`, run: () => navigate(m.id) })),
    { label: 'Edit my profile', run: () => navigate('settings', 'profile') },
    { label: 'Open theme editor', run: () => navigate('settings', 'appearance') },
    { label: 'Set a custom status', run: () => openCustomStatus() },
    { label: 'Status: Online', run: () => void setPresence('online') },
    { label: 'Status: Idle', run: () => void setPresence('idle') },
    { label: 'Status: Do Not Disturb', run: () => void setPresence('dnd') },
    { label: 'Status: Invisible', run: () => void setPresence('invisible') },
    { label: 'Toggle members panel', hint: 'Ctrl M', run: () => patchSettings({ showMembersPanel: !settings.get().showMembersPanel }) },
    { label: 'Toggle sidebar labels', run: () => patchSettings({ sidebarLabels: !settings.get().sidebarLabels }) },
    { label: 'Toggle animations', run: () => patchSettings({ animations: !settings.get().animations }) },
    ...PRESETS.map((t) => ({
      label: `Theme: ${t.name}`,
      run: () => setTheme({ ...t, customCss: theme.get().customCss, backdrop: theme.get().backdrop }),
    })),
    { label: 'Sign out', run: () => void signOut().catch((e) => toast(String(e), 'error')) },
  ];
  for (const p of members.get().values()) {
    list.push({ label: `View profile: ${displayName(p)} (@${p.username})`, run: () => {
      const anchor = document.querySelector('.palette-btn') as HTMLElement;
      popover(anchor, profileCard(p, statusOf(p.id)), 'bottom');
    } });
  }
  return list;
}

function openPalette(): void {
  closePopover();
  if (document.querySelector('.palette')) return;
  const all = commands();
  let selected = 0;
  let filtered = all;
  const input = h('input', { class: 'palette-input', placeholder: 'Type a command…', 'aria-label': 'Command' });
  const list = h('div', { class: 'palette-list', role: 'listbox' });

  const close = () => backdrop.remove();
  const runAt = (i: number) => {
    const c = filtered[i];
    if (!c) return;
    close();
    c.run();
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    filtered = all.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
    selected = Math.min(selected, Math.max(0, filtered.length - 1));
    list.replaceChildren(
      ...(filtered.length
        ? filtered.slice(0, 50).map((c, i) =>
            h(
              'button',
              { class: `palette-item ${i === selected ? 'active' : ''}`, role: 'option', onmousemove: () => { if (selected !== i) { selected = i; render(); } }, onclick: () => runAt(i) },
              h('span', null, c.label),
              c.hint ? h('kbd', null, c.hint) : null,
            ),
          )
        : [h('div', { class: 'palette-empty' }, 'No matching commands')]),
    );
    (list.querySelector('.active') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(filtered.length - 1, selected + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(selected); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  const backdrop = h('div', { class: 'palette-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, h('div', { class: 'palette' }, input, list));
  document.body.appendChild(backdrop);
  render();
  input.focus();
}
