// Thin wrappers around Tauri so the UI also runs in a normal browser during development.

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type WindowApi = typeof import('@tauri-apps/api/window');
let winApi: Promise<WindowApi> | null = null;
const getWinApi = () => (winApi ??= import('@tauri-apps/api/window'));

export async function minimize(): Promise<void> {
  if (!isTauri) return;
  (await getWinApi()).getCurrentWindow().minimize();
}

export async function toggleMaximize(): Promise<void> {
  if (!isTauri) return;
  (await getWinApi()).getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!isTauri) return;
  (await getWinApi()).getCurrentWindow().close();
}

export type Backdrop = 'solid' | 'mica' | 'acrylic';

/** Windows 11 Mica / Acrylic window materials. Falls back silently where unsupported. */
export async function setBackdrop(kind: Backdrop): Promise<void> {
  if (!isTauri) return;
  try {
    const api = await getWinApi();
    const win = api.getCurrentWindow();
    if (kind === 'solid') await win.clearEffects();
    else await win.setEffects({ effects: [kind === 'mica' ? api.Effect.Mica : api.Effect.Acrylic] });
  } catch (e) {
    console.warn('Backdrop not supported on this system', e);
  }
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
