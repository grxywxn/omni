import { comingSoon } from './placeholder';

export function mount(el: HTMLElement): void {
  comingSoon(el, {
    icon: 'music',
    title: 'Music',
    phase: 'Phase 4',
    points: [
      'Sign in with Spotify (Premium) and play your whole library',
      'Playlists and Liked Songs: create, edit, reorder by drag and drop',
      'Queue, search, shuffle/repeat, mini-player and global media keys',
      'Every part of the player themeable, plus compact and focus layouts',
      '“Listening to” shown on your Omni profile',
    ],
  });
}
