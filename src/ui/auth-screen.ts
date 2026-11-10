import { h, field, toast } from '../core/dom';
import { signIn, signUp, isFirstAccount } from '../lib/auth';
import { decodeConnectionCode, normalizeUrl, saveConfig, testConfig } from '../lib/supabase';
import { titlebar } from './titlebar';

export function renderAuthScreen(root: HTMLElement): void {
  let mode: 'signin' | 'signup' = 'signin';
  const card = h('div', { class: 'auth-card' });

  const render = async () => {
    const first = mode === 'signup' ? await isFirstAccount() : false;
    const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
    const password = h('input', { type: 'password', required: true, minlength: '8', autocomplete: mode === 'signin' ? 'current-password' : 'new-password' });
    const username = h('input', { required: true, pattern: '[a-z0-9_.]{2,32}', placeholder: 'lowercase, e.g. anne_a', autocomplete: 'username' });
    const display = h('input', { maxlength: '40', placeholder: 'How your name appears' });
    const invite = h('input', { placeholder: 'e.g. 7F3A9C21BE' });
    invite.addEventListener('input', () => (invite.value = invite.value.toUpperCase()));
    username.addEventListener('input', () => (username.value = username.value.toLowerCase().replace(/[^a-z0-9_.]/g, '')));

    const submit = h('button', { type: 'submit', class: 'primary wide' }, mode === 'signin' ? 'Sign in' : 'Create account');
    const err = h('div', { class: 'form-error', role: 'alert' });

    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          err.textContent = '';
          submit.disabled = true;
          try {
            if (mode === 'signin') {
              await signIn(email.value, password.value);
            } else {
              const signedIn = await signUp({
                email: email.value,
                password: password.value,
                username: username.value,
                displayName: display.value,
                inviteCode: invite.value,
              });
              if (!signedIn) {
                toast('Account created! Check your email to confirm it, then sign in.', 'success', 7000);
                mode = 'signin';
                void render();
              }
            }
          } catch (ex) {
            err.textContent = (ex as Error).message;
          } finally {
            submit.disabled = false;
          }
        },
      },
      mode === 'signup' ? field('Display name', display) : null,
      mode === 'signup' ? field('Username', username, '2–32 characters: a–z, 0–9, _ and .') : null,
      field('Email', email),
      field('Password', password, mode === 'signup' ? 'At least 8 characters.' : undefined),
      mode === 'signup' && !first ? field('Invite code', invite, 'Ask the person who runs your Omni group for one.') : null,
      mode === 'signup' && first ? h('div', { class: 'note' }, "👑 You're the first person here, so you don't need an invite. You'll be the founder and can invite others.") : null,
      err,
      submit,
    );

    card.replaceChildren(
      h('div', { class: 'auth-logo' }, h('span', { class: 'logo-mark' }), h('span', null, 'Omni')),
      h('h1', null, mode === 'signin' ? 'Welcome back' : 'Create your account'),
      h('p', { class: 'muted' }, mode === 'signin' ? 'Sign in to pick up where you left off.' : 'Music, notes and recording — in one light app.'),
      form,
      h(
        'p',
        { class: 'auth-switch' },
        mode === 'signin' ? 'New here? ' : 'Already have an account? ',
        h('button', { class: 'link', type: 'button', onclick: () => { mode = mode === 'signin' ? 'signup' : 'signin'; void render(); } }, mode === 'signin' ? 'Create an account' : 'Sign in'),
      ),
    );
    (form.querySelector('input') as HTMLInputElement | null)?.focus();
  };

  root.replaceChildren(titlebar(), h('div', { class: 'auth-screen' }, card));
  void render();
}

/** First launch: connect this copy of Omni to your Supabase project. */
export function renderSetupScreen(root: HTMLElement): void {
  let mode: 'code' | 'manual' = 'code';
  const card = h('div', { class: 'auth-card' });

  const render = () => {
    const err = h('div', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'primary wide' }, 'Connect');
    const code = h('textarea', { rows: '3', class: 'code', placeholder: 'OMNI-CONNECT:…' });
    const url = h('input', { placeholder: 'https://abcdefgh.supabase.co', autocomplete: 'off' });
    const key = h('input', { placeholder: 'eyJhbGciOi… or sb_publishable_…', autocomplete: 'off' });

    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          err.textContent = '';
          const cfg = mode === 'code' ? decodeConnectionCode(code.value) : { url: normalizeUrl(url.value), key: key.value.trim() };
          if (!cfg) {
            err.textContent = "That doesn't look like a connection code. It starts with OMNI-CONNECT:";
            return;
          }
          submit.disabled = true;
          submit.textContent = 'Checking…';
          try {
            await testConfig(cfg);
            saveConfig(cfg);
            location.reload();
          } catch (ex) {
            err.textContent = (ex as Error).message;
            submit.disabled = false;
            submit.textContent = 'Connect';
          }
        },
      },
      mode === 'code'
        ? [
            h('p', null, 'Paste the connection code from the person who invited you.'),
            field('Connection code', code),
          ]
        : [
            h('p', null, 'Setting up your own group? Enter your Supabase project details (Project Settings → API).'),
            field('Project URL', url),
            field('Anon / publishable key', key, 'Never the service_role / secret key.'),
          ],
      err,
      submit,
    );

    card.replaceChildren(
      h('div', { class: 'auth-logo' }, h('span', { class: 'logo-mark' }), h('span', null, 'Omni')),
      h('h1', null, 'Connect Omni'),
      form,
      h(
        'p',
        { class: 'auth-switch' },
        h('button', { class: 'link', type: 'button', onclick: () => { mode = mode === 'code' ? 'manual' : 'code'; render(); } },
          mode === 'code' ? "I'm the founder — enter project details" : 'I have a connection code'),
      ),
    );
  };

  root.replaceChildren(titlebar(), h('div', { class: 'auth-screen' }, card));
  render();
}
