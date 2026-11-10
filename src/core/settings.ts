import { Store } from './store';

export type ModuleId = 'home' | 'music' | 'notes' | 'recorder' | 'settings';

export interface AppSettings {
  /** Keep a module's view in memory after you leave it (faster switching, more RAM). */
  keepModulesAlive: boolean;
  /** Animated avatar decorations, profile effects, transitions. */
  animations: boolean;
  /** Minutes without input before you show as Idle. 0 = never. */
  idleMinutes: number;
  showMembersPanel: boolean;
  sidebarLabels: boolean;
  startModule: ModuleId;
}

const KEY = 'omni.settings';

const DEFAULTS: AppSettings = {
  keepModulesAlive: false,
  animations: true,
  idleMinutes: 10,
  showMembersPanel: true,
  sidebarLabels: true,
  startModule: 'home',
};

function load(): AppSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = new Store<AppSettings>(load());

settings.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
  document.documentElement.classList.toggle('no-anim', !s.animations);
}, true);

export function patchSettings(patch: Partial<AppSettings>): void {
  settings.update((s) => ({ ...s, ...patch }));
}

// Pause CSS animations whenever the window is hidden/minimised — saves CPU.
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('paused', document.hidden);
});
