import type { Session } from '@supabase/supabase-js';
import { sb, friendlyError } from './supabase';
import { Store } from '../core/store';

export const session = new Store<Session | null>(null);

export async function initAuth(): Promise<void> {
  const { data } = await sb().auth.getSession();
  session.set(data.session);
  sb().auth.onAuthStateChange((event, s) => {
    // Token refreshes keep the same user — don't rebuild the whole UI for them.
    if (event === 'TOKEN_REFRESHED' && s?.user.id === session.get()?.user.id) return;
    // Defer: calling Supabase from inside this callback can deadlock the auth client.
    if (s?.user.id !== session.get()?.user.id) setTimeout(() => session.set(s), 0);
  });
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(friendlyError(error));
}

export interface SignUpInput {
  email: string;
  password: string;
  username: string;
  displayName: string;
  inviteCode: string;
}

/** Returns true if the user is signed in straight away, false if they must confirm their email. */
export async function signUp(i: SignUpInput): Promise<boolean> {
  const username = i.username.trim().toLowerCase();
  const code = i.inviteCode.trim().toUpperCase();
  const check = await sb().rpc('validate_signup', { p_username: username, p_code: code });
  if (check.error) throw new Error(friendlyError(check.error));
  if (check.data) throw new Error(String(check.data));

  const { data, error } = await sb().auth.signUp({
    email: i.email.trim(),
    password: i.password,
    options: { data: { username, display_name: i.displayName.trim(), invite_code: code } },
  });
  if (error) throw new Error(friendlyError(error));
  return Boolean(data.session);
}

export async function isFirstAccount(): Promise<boolean> {
  const { data, error } = await sb().rpc('is_first_account');
  if (error) return false;
  return Boolean(data);
}

export async function signOut(): Promise<void> {
  await sb().auth.signOut();
}

export async function changePassword(newPassword: string): Promise<void> {
  const { error } = await sb().auth.updateUser({ password: newPassword });
  if (error) throw new Error(friendlyError(error));
}

export async function changeEmail(newEmail: string): Promise<void> {
  const { error } = await sb().auth.updateUser({ email: newEmail.trim() });
  if (error) throw new Error(friendlyError(error));
}
