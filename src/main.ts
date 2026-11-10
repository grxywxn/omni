import './styles/base.css';
import './styles/profile.css';
import { h, toast } from './core/dom';
import { debounce } from './core/store';
import { theme, setTheme, hasLocalTheme, sanitizeTheme, type Theme } from './core/theme';
import './core/settings';
import { isConfigured } from './lib/supabase';
import { initAuth, session, signOut } from './lib/auth';
import { loadProfiles, watchProfiles, stopWatchingProfiles, me, updateProfile } from './lib/profiles';
import { startPresence, stopPresence } from './lib/presence';
import { renderAuthScreen, renderSetupScreen } from './ui/auth-screen';
import { titlebar } from './ui/titlebar';

const root = document.getElementById('app')!;
let teardown: (() => void) | null = null;

// Keep your theme on your account so it follows you to other PCs.
const syncTheme = debounce((t: Theme) => {
  if (me.get()) void updateProfile({ app_theme: t }).catch(() => { /* offline: the local copy is still saved */ });
}, 2500);

async function startApp(userId: string): Promise<void> {
  root.replaceChildren(titlebar(), h('div', { class: 'splash' }, h('span', { class: 'logo-mark big' }), h('span', { class: 'muted' }, 'Loading your space…')));
  try {
    await loadProfiles(userId);
  } catch (e) {
    root.replaceChildren(
      titlebar(),
      h('div', { class: 'auth-screen' }, h('div', { class: 'auth-card stack' }, h('h1', null, 'Something went wrong'), h('p', null, (e as Error).message), h('button', { class: 'primary', onclick: () => void signOut() }, 'Sign out'))),
    );
    return;
  }

  // New PC with no local theme yet? Use the one saved on your account.
  const remote = sanitizeTheme(me.get()?.app_theme);
  if (remote && !hasLocalTheme()) setTheme(remote);
  const unsubTheme = theme.subscribe((t) => syncTheme(t), false);

  watchProfiles(userId);
  startPresence(userId);
  const { renderShell } = await import('./ui/shell');
  const disposeShell = renderShell(root);

  teardown = () => {
    unsubTheme();
    disposeShell();
    stopPresence();
    stopWatchingProfiles();
  };
}

async function boot(): Promise<void> {
  if (!isConfigured()) {
    renderSetupScreen(root);
    return;
  }
  try {
    await initAuth();
  } catch (e) {
    toast(String(e), 'error');
  }
  let currentUser: string | null | undefined; // undefined = nothing rendered yet
  session.subscribe((s) => {
    const uid = s?.user.id ?? null;
    if (uid === currentUser) return;
    currentUser = uid;
    teardown?.();
    teardown = null;
    if (uid) void startApp(uid);
    else renderAuthScreen(root);
  });
}

void boot();
