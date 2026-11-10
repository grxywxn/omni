-- ============================================================================
-- Omni — Phase 1 database schema (accounts, profiles, invites, profile media)
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- It is safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Invite codes: keeps Omni private to the few people you invite.
-- The very first account (you) needs no code and becomes the "founder".
-- ---------------------------------------------------------------------------
create table if not exists public.invite_codes (
  code        text primary key,
  max_uses    int  not null default 1 check (max_uses > 0),
  uses        int  not null default 0,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
alter table public.invite_codes enable row level security;
-- No policies on purpose: only the security-definer functions below touch it.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  username           text not null unique check (username ~ '^[a-z0-9_.]{2,32}$'),
  display_name       text check (char_length(display_name) <= 40),
  pronouns           text check (char_length(pronouns) <= 40),
  bio                text check (char_length(bio) <= 400),
  avatar_url         text,
  banner_url         text,
  banner_color       text not null default '#5865f2' check (banner_color  ~ '^#[0-9a-fA-F]{6}$'),
  theme_primary      text not null default '#1e1f2b' check (theme_primary ~ '^#[0-9a-fA-F]{6}$'),
  theme_accent       text not null default '#5865f2' check (theme_accent  ~ '^#[0-9a-fA-F]{6}$'),
  name_color         text not null default '#eb459e' check (name_color    ~ '^#[0-9a-fA-F]{6}$'),
  name_effect        text not null default 'none' check (name_effect in ('none','gradient','glow','rainbow')),
  avatar_decoration  text not null default 'none' check (avatar_decoration in ('none','halo','neon','rainbow','gold','orbit')),
  profile_effect     text not null default 'none' check (profile_effect in ('none','sparkle','snow','aurora')),
  presence_pref      text not null default 'online' check (presence_pref in ('online','idle','dnd','invisible')),
  status_emoji       text check (char_length(status_emoji) <= 16),
  status_text        text check (char_length(status_text) <= 128),
  status_expires_at  timestamptz,
  now_playing        jsonb,      -- filled by the Music module in Phase 4
  app_theme          jsonb,      -- your Omni theme, so it follows you between PCs
  badges             text[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles readable by members" on public.profiles;
create policy "profiles readable by members"
  on public.profiles for select to authenticated using (true);

drop policy if exists "members update own profile" on public.profiles;
create policy "members update own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Column-level permissions: members can edit their own profile fields,
-- but NOT their badges, id or timestamps.
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke select on public.profiles from anon;
grant select on public.profiles to authenticated;
grant update (
  username, display_name, pronouns, bio, avatar_url, banner_url, banner_color,
  theme_primary, theme_accent, name_color, name_effect, avatar_decoration,
  profile_effect, presence_pref, status_emoji, status_text, status_expires_at,
  now_playing, app_theme
) on public.profiles to authenticated;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Create a profile automatically on sign-up (and enforce invite codes).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_code     text := upper(coalesce(new.raw_user_meta_data ->> 'invite_code', ''));
  v_username text := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  v_display  text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '');
  v_count    int;
  v_badges   text[] := '{}';
begin
  select count(*) into v_count from public.profiles;

  if v_count > 0 then
    update public.invite_codes set uses = uses + 1
     where code = v_code and uses < max_uses;
    if not found then
      raise exception 'A valid invite code is required to join.';
    end if;
  end if;

  if v_count = 0 then v_badges := array['founder','early'];
  elsif v_count < 10 then v_badges := array['early'];
  end if;

  if v_username !~ '^[a-z0-9_.]{2,32}$' then
    v_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  insert into public.profiles (id, username, display_name, badges)
  values (new.id, v_username, left(coalesce(v_display, v_username), 40), v_badges);
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Friendly pre-check used by the sign-up form (returns an error message or null).
create or replace function public.validate_signup(p_username text, p_code text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if lower(coalesce(p_username, '')) !~ '^[a-z0-9_.]{2,32}$' then
    return 'Usernames are 2–32 characters: lowercase letters, numbers, _ and .';
  end if;
  if exists (select 1 from public.profiles where username = lower(p_username)) then
    return 'That username is taken.';
  end if;
  if exists (select 1 from public.profiles)
     and not exists (select 1 from public.invite_codes
                      where code = upper(coalesce(p_code, '')) and uses < max_uses) then
    return 'That invite code is invalid or has been used up.';
  end if;
  return null;
end $$;
grant execute on function public.validate_signup(text, text) to anon, authenticated;

-- Is this the first account? (Lets the sign-up form hide the invite field.)
create or replace function public.is_first_account() returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.profiles);
$$;
grant execute on function public.is_first_account() to anon, authenticated;

-- Founder-only: create and list invite codes.
create or replace function public.create_invite(p_max_uses int default 1) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not exists (select 1 from public.profiles
                  where id = auth.uid() and 'founder' = any(badges)) then
    raise exception 'Only the founder can create invite codes.';
  end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.invite_codes (code, max_uses, created_by)
  values (v_code, greatest(1, least(coalesce(p_max_uses, 1), 25)), auth.uid());
  return v_code;
end $$;
revoke execute on function public.create_invite(int) from public, anon;
grant execute on function public.create_invite(int) to authenticated;

create or replace function public.list_my_invites()
returns table (code text, max_uses int, uses int, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select code, max_uses, uses, created_at from public.invite_codes
   where created_by = auth.uid() order by created_at desc;
$$;
revoke execute on function public.list_my_invites() from public, anon;
grant execute on function public.list_my_invites() to authenticated;

-- ---------------------------------------------------------------------------
-- Live updates: push profile changes (status, avatar…) to everyone instantly.
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage for avatars and banners (GIFs allowed, 8 MB max).
-- Each member may only write inside a folder named after their user id.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-media', 'profile-media', true, 8388608,
        array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists "profile media read"   on storage.objects;
drop policy if exists "profile media insert" on storage.objects;
drop policy if exists "profile media update" on storage.objects;
drop policy if exists "profile media delete" on storage.objects;

create policy "profile media read" on storage.objects for select to authenticated
  using (bucket_id = 'profile-media');
create policy "profile media insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "profile media update" on storage.objects for update to authenticated
  using (bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "profile media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
