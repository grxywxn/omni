# Omni

A lightweight all-in-one desktop app for Windows. Phase 1 contains:

- **The app shell**: a custom title bar, a sidebar, a command palette (`Ctrl+K`), keyboard shortcuts, and a members panel.
- **Theming**: 8 built-in themes, a full colour editor, fonts, density, corner roundness, Windows 11 Mica/Acrylic window backgrounds, a custom CSS box, saved themes, and shareable theme codes. Your theme also syncs to your account.
- **Accounts**: sign-up is invite-only, with email and password. The first account becomes the **founder**, and only the founder can create invite codes.
- **Discord-style profiles**:
  - Animated GIF avatars and banners.
  - Profile theme colours.
  - 6 avatar decorations, 4 name effects and 3 profile effects.
  - Badges, pronouns and a bio.
  - Custom status with emoji and auto-clear.
  - Online / Idle / Do Not Disturb / Invisible, with automatic Idle after a set time.
  - Live updates across everyone's apps.

**Music (Spotify)**:
- Your full library: Liked Songs, playlists and saved albums.
- Search, plus album and artist pages, and a queue.
- Playlist management: create, rename, delete, add songs, remove songs, and drag to reorder.
- Like and unlike songs, play on this PC or on any of your Spotify devices, Windows media keys, and a mini player in the sidebar.
- "Listening to" shown on your profile.
- Lots of layout options: tinting from album art, column choices, row size, player position and style, cover-art shape, and a resizable library.

Notes and Recorder show "coming soon" screens until their phases are built.

---

## Getting started (no coding tools needed)

### 1. Install Omni
Run **`Omni_0.1.0_x64-setup.exe`**. Windows may show "Windows protected your PC" because the app isn't code-signed (signing costs money). Click **More info → Run anyway**.

### 2. Create your Supabase project (founder only, once, about 5 minutes)
1. Create a free account at <https://supabase.com>, then click **New project**. Choose any name and a strong database password. The nearest region to Nigeria is usually **West EU (Ireland)** or **Central EU (Frankfurt)**.
2. When the project is ready, open **SQL Editor → New query**. Paste in the whole of `supabase/schema.sql` from this zip and click **Run**. You should see "Success. No rows returned".
3. Optional, for a small private group: go to **Authentication → Sign In / Providers → Email** and turn **off** "Confirm email". Then people can sign in straight away.
4. Open **Project Settings → API**. Keep the page open: you need the **Project URL** and the **anon / publishable key**.

### 3. Connect and create your account
1. Open Omni. Click **"I'm the founder — enter project details"** and paste the URL and the anon key.
   ⚠️ Never use the `service_role` / secret key. Omni will refuse it.
2. Click **Create an account**. You're the first person, so you don't need an invite and you get the 👑 Founder badge.
3. Set up your profile in **Settings → My profile** and pick a theme in **Settings → Appearance**.

### 4. Invite friends
**Settings → Invites → Create invite** copies a ready-to-send message to your clipboard. It contains a *connection code* and an *invite code*. Send that message along with the installer. Your friend installs Omni, pastes the connection code, then creates an account with the invite code.

---

## Building from source (optional)

The installer is built automatically by GitHub Actions (`.github/workflows/build-windows.yml`) on every push to `main`. To build it yourself on Windows, install the [C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) ("Desktop development with C++"), [Rust](https://rustup.rs) and [Node.js LTS](https://nodejs.org), then run:

```powershell
npm install
npm run app        # run in development mode
npm run package    # builds src-tauri\target\release\bundle\nsis\*-setup.exe
```

## Music setup (once)

Open **Music** in Omni and follow the 4 on-screen steps:

1. Create an app at developer.spotify.com.
2. Paste in the Redirect URI it shows you.
3. Copy the app's Client ID into Omni.
4. Click **Connect Spotify**.

You need Spotify **Premium**.

Spotify limits that apply to every app outside Spotify's own (not limits in Omni):
- Up to **5 people** can use the Music section with your Client ID. Add them in the developer dashboard under **User Management**.
- Songs can only be *listed* for playlists you own or collaborate on. Other playlists still play and shuffle normally.
- Search shows 10 results per page. Scroll to load more.
- Artist "Top tracks" and Spotify's Browse pages aren't available to apps any more.

If the built-in player can't start on a PC, Omni shows a message. You can still pick your phone or another Spotify device from the **devices** button and control it from Omni.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl K` | Command palette (go anywhere, change status, switch theme, view profiles) |
| `Ctrl 1` – `Ctrl 4` | Home, Music, Notes, Recorder |
| `Ctrl ,` | Settings |
| `Ctrl M` | Show / hide members panel |
| `Esc` | Close dialogs |
| `Space` | Music: play / pause |
| `Ctrl F` | Music: search |
| `Ctrl Shift → / ←` | Music: next / previous song |
| `Alt ← / →` | Music: back / forward |
| Media keys | Play / pause, next, previous (also from the Windows volume overlay) |

## Why it's light on RAM

- **Tauri instead of Electron.** Omni uses the WebView2 engine that's already part of Windows instead of bundling its own copy of Chrome.
- **No UI framework.** The whole interface is plain TypeScript, so there's no React or Vue runtime in memory.
- **Modules load on demand and unload when you leave them.** You can change this in Settings → App behaviour.
- **Animations stop when Omni is minimised**, and you can turn them off completely.
- **The release build is size-optimised** (LTO, stripped symbols).

## Project layout

```text
omni/
├─ supabase/schema.sql      database: profiles, invites, storage, security rules
├─ src/
│  ├─ main.ts               start-up: auth → load profiles → shell
│  ├─ core/                 DOM helpers, stores, theme engine, settings, native window calls
│  ├─ lib/                  Supabase client, auth, profiles, presence, types
│  ├─ ui/                   shell, title bar, auth screen, profile card/editor, theme editor, status menu
│  ├─ modules/              home, settings, and placeholders for music / notes / recorder
│  └─ styles/               base.css (layout + controls), profile.css (avatars, effects, cards)
└─ src-tauri/               Rust side: window config, permissions, icons
```

## Troubleshooting

- **"Connected, but the database setup is missing".** Run `supabase/schema.sql` in the SQL Editor first.
- **Wrong server or new project.** Go to Settings → About → Disconnect from server, then connect again.
- **"Your profile could not be found".** `schema.sql` didn't run fully. Run it again; it's safe to re-run.
- **Sign-up says the invite code is invalid.** Codes are single-use unless the founder set a higher limit. Make a new one in Settings → Invites.
- **Forgotten password.** As the founder, open Supabase → Authentication → Users, select the person, and click "Send password recovery".
- **Mica or Acrylic doesn't show.** Mica needs Windows 11. On Windows 10, pick Acrylic or Solid.
- **Building from source fails with a linker error.** The C++ Build Tools are missing.
