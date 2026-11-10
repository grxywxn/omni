import { h, icon, field, toast, toggle, select, confirmDialog } from '../core/dom';
import { Disposer } from '../core/store';
import { settings, patchSettings, type ModuleId } from '../core/settings';
import { session, signOut, changePassword, changeEmail } from '../lib/auth';
import { me, createInvite, listInvites } from '../lib/profiles';
import { profileEditor } from '../ui/profile-editor';
import { themeEditor } from '../ui/theme-editor';
import { route } from '../ui/shell';
import { getConfig, encodeConnectionCode, clearConfig } from '../lib/supabase';

type Tab = 'profile' | 'appearance' | 'account' | 'invites' | 'app' | 'about';

const TABS: Array<{ id: Tab; label: string; icon: string; founderOnly?: boolean }> = [
  { id: 'profile', label: 'My profile', icon: 'user' },
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'account', label: 'Account', icon: 'shield' },
  { id: 'invites', label: 'Invites', icon: 'ticket', founderOnly: true },
  { id: 'app', label: 'App behaviour', icon: 'sliders' },
  { id: 'about', label: 'About', icon: 'info' },
];

export function mount(el: HTMLElement): () => void {
  const d = new Disposer();
  let tab: Tab = (route.get().sub as Tab) || 'profile';
  let disposeTab: (() => void) | null = null;

  const nav = h('nav', { class: 'settings-nav' });
  const body = h('div', { class: 'settings-body' });
  el.append(h('div', { class: 'settings' }, nav, body));

  const render = () => {
    const isFounder = me.get()?.badges.includes('founder') ?? false;
    nav.replaceChildren(
      h('div', { class: 'settings-nav-title' }, 'Settings'),
      ...TABS.filter((t) => !t.founderOnly || isFounder).map((t) =>
        h('button', { class: `settings-tab ${t.id === tab ? 'active' : ''}`, onclick: () => { tab = t.id; render(); } }, icon(t.icon, 16), t.label),
      ),
      h('div', { class: 'nav-spacer' }),
      h('button', { class: 'settings-tab danger', onclick: () => void signOut() }, icon('logout', 16), 'Sign out'),
    );
    disposeTab?.();
    disposeTab = null;
    const title = TABS.find((t) => t.id === tab)?.label ?? '';
    const header = h('h1', null, title);
    switch (tab) {
      case 'profile': {
        const ed = profileEditor();
        disposeTab = ed.dispose;
        body.replaceChildren(header, ed.el);
        break;
      }
      case 'appearance': {
        const ed = themeEditor();
        disposeTab = ed.dispose;
        body.replaceChildren(header, ed.el);
        break;
      }
      case 'account':
        body.replaceChildren(header, accountTab());
        break;
      case 'invites':
        body.replaceChildren(header, invitesTab());
        break;
      case 'app':
        body.replaceChildren(header, appTab());
        break;
      case 'about':
        body.replaceChildren(header, aboutTab());
        break;
    }
  };

  // Deep links like navigate('settings', 'appearance') while already here.
  d.add(route.subscribe((r) => {
    if (r.module === 'settings' && r.sub && r.sub !== tab) {
      tab = r.sub as Tab;
      render();
    }
  }, false));
  render();
  return () => {
    disposeTab?.();
    d.dispose();
  };
}

function accountTab(): HTMLElement {
  const email = session.get()?.user.email ?? '';
  const newEmail = h('input', { type: 'email', placeholder: 'new@example.com' });
  const pw1 = h('input', { type: 'password', minlength: '8', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', minlength: '8', autocomplete: 'new-password' });

  return h(
    'div',
    { class: 'stack-lg narrow' },
    h('section', { class: 'card' }, h('div', { class: 'muted' }, 'Signed in as'), h('strong', null, email)),
    h(
      'form',
      { class: 'card stack', onsubmit: async (e: Event) => {
        e.preventDefault();
        try {
          await changeEmail(newEmail.value);
          toast('Check both inboxes to confirm the change.', 'success', 6000);
          newEmail.value = '';
        } catch (ex) { toast((ex as Error).message, 'error'); }
      } },
      h('h3', null, 'Change email'),
      field('New email', newEmail),
      h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Update email')),
    ),
    h(
      'form',
      { class: 'card stack', onsubmit: async (e: Event) => {
        e.preventDefault();
        if (pw1.value !== pw2.value) return toast("Passwords don't match", 'error');
        if (pw1.value.length < 8) return toast('Use at least 8 characters', 'error');
        try {
          await changePassword(pw1.value);
          toast('Password changed', 'success');
          pw1.value = pw2.value = '';
        } catch (ex) { toast((ex as Error).message, 'error'); }
      } },
      h('h3', null, 'Change password'),
      h('div', { class: 'grid-2' }, field('New password', pw1), field('Repeat', pw2)),
      h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Change password')),
    ),
    h('p', { class: 'muted' }, 'Forgot a password? The founder can send a reset or delete an account from the Supabase dashboard (Authentication → Users).'),
  );
}

function inviteMessage(code: string): string {
  const cfg = getConfig();
  return [
    "You're invited to Omni!",
    '1. Install Omni and open it.',
    '2. Paste this connection code when asked:',
    cfg ? encodeConnectionCode(cfg) : '(connection code unavailable)',
    `3. Click "Create an account" and use invite code: ${code}`,
  ].join('\n');
}

function invitesTab(): HTMLElement {
  const list = h('div', { class: 'stack' }, h('div', { class: 'muted' }, 'Loading…'));
  const uses = select('1', [['1', 'One person'], ['3', 'Up to 3 people'], ['5', 'Up to 5 people'], ['10', 'Up to 10 people']], () => {});

  const load = async () => {
    try {
      const invites = await listInvites();
      list.replaceChildren(
        ...(invites.length
          ? invites.map((i) =>
              h(
                'div',
                { class: `invite-row ${i.uses >= i.max_uses ? 'used' : ''}` },
                h('code', null, i.code),
                h('span', { class: 'muted' }, `${i.uses}/${i.max_uses} used`),
                h('button', { class: 'ghost', title: 'Copy a ready-to-send message with everything they need', onclick: async () => {
                  await navigator.clipboard.writeText(inviteMessage(i.code)).catch(() => {});
                  toast('Invite message copied — paste it to your friend', 'success');
                } }, icon('copy', 16), 'Copy invite message'),
              ),
            )
          : [h('div', { class: 'muted' }, 'No invites yet.')]),
      );
    } catch (e) {
      list.replaceChildren(h('div', { class: 'form-error' }, (e as Error).message));
    }
  };
  void load();

  return h(
    'div',
    { class: 'stack-lg narrow' },
    h('p', null, 'Omni is invite-only. Creating an invite copies a message with everything your friend needs: the connection code and their invite code. Send it along with the Omni installer.'),
    h('div', { class: 'note' }, 'Heads-up for Phase 4: Spotify only lets 5 people in total use the Music section of a personal app, so you\'ll add those people in your Spotify developer dashboard too.'),
    h(
      'div',
      { class: 'card row' },
      field('Code can be used by', uses),
      h('button', { class: 'primary', onclick: async () => {
        try {
          const code = await createInvite(Number(uses.value));
          await navigator.clipboard.writeText(inviteMessage(code)).catch(() => {});
          toast('Invite created — the full message is copied, paste it to your friend', 'success', 5000);
          void load();
        } catch (e) { toast((e as Error).message, 'error'); }
      } }, 'Create invite'),
    ),
    h('h3', null, 'Your invites'),
    list,
  );
}

function appTab(): HTMLElement {
  const s = settings.get();
  const idle = h('input', { type: 'number', min: '0', max: '120', value: String(s.idleMinutes), style: 'width: 90px' });
  idle.addEventListener('change', () => patchSettings({ idleMinutes: Math.max(0, Math.min(120, Number(idle.value) || 0)) }));
  const modules: Array<[ModuleId, string]> = [['home', 'Home'], ['music', 'Music'], ['notes', 'Notes'], ['recorder', 'Recorder']];

  return h(
    'div',
    { class: 'stack-lg narrow' },
    h(
      'section',
      { class: 'card stack' },
      h('h3', null, 'Memory & performance'),
      toggle(s.keepModulesAlive, (v) => patchSettings({ keepModulesAlive: v }), 'Keep modules loaded after leaving them'),
      h('p', { class: 'muted' }, 'Off (recommended): a module is unloaded when you switch away, so only what you see uses RAM. On: switching back is instant but uses more memory. Music will keep playing either way once Phase 4 lands.'),
      toggle(s.animations, (v) => patchSettings({ animations: v }), 'Animations and profile effects'),
      h('p', { class: 'muted' }, 'Animations pause automatically when Omni is minimised.'),
    ),
    h(
      'section',
      { class: 'card stack' },
      h('h3', null, 'Behaviour'),
      field('Open on start', select(s.startModule, modules, (v) => patchSettings({ startModule: v }))),
      field('Show me as Idle after (minutes, 0 = never)', idle),
      toggle(s.showMembersPanel, (v) => patchSettings({ showMembersPanel: v }), 'Show members panel (Ctrl+M)'),
    ),
    h(
      'section',
      { class: 'card stack' },
      h('h3', null, 'Keyboard shortcuts'),
      h(
        'table',
        { class: 'shortcuts' },
        [
          ['Ctrl K', 'Command palette'],
          ['Ctrl 1–4', 'Home, Music, Notes, Recorder'],
          ['Ctrl ,', 'Settings'],
          ['Ctrl M', 'Toggle members panel'],
          ['Esc', 'Close dialogs'],
        ].map(([k, v]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, v))),
      ),
    ),
  );
}

function aboutTab(): HTMLElement {
  return h(
    'div',
    { class: 'stack-lg narrow' },
    h('section', { class: 'card stack' }, h('div', { class: 'auth-logo' }, h('span', { class: 'logo-mark' }), h('span', null, 'Omni 0.3.0')), h('p', null, 'Shell, themes, accounts, profiles, Music and Recorder.')),
    h(
      'section',
      { class: 'card stack' },
      h('h3', null, 'Roadmap'),
      h('ol', { class: 'steps' }, h('li', null, '✅ Shell, themes, accounts & profiles'), h('li', null, '✅ Music (Spotify)'), h('li', null, '✅ Recorder'), h('li', null, 'Notes')),
    ),
    h('section', { class: 'card stack' },
      h('h3', null, 'Server'),
      h('p', { class: 'muted' }, `Connected to ${getConfig()?.url ?? '—'}`),
      h('div', null, h('button', { class: 'secondary', onclick: async () => {
        if (!(await confirmDialog('Disconnect from server', 'Disconnect this PC from your Omni server? You can reconnect with a connection code.', { confirmLabel: 'Disconnect', danger: true }))) return;
        await signOut().catch(() => {});
        clearConfig();
        location.reload();
      } }, 'Disconnect from server'))),
    h('p', { class: 'muted' }, 'Built with Tauri, which uses the WebView2 already on Windows instead of shipping its own browser — that is where most of the RAM savings over Electron apps come from.'),
  );
}
