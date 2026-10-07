import type { Settings } from './contracts';

/** Dictation settings for one application, chosen by the executable of the target window. */
export interface AppProfile {
  /** Lowercase executable name, e.g. "telegram.exe". */
  app: string;
  /** '' keeps the global choice. */
  model: Settings['model'] | '';
  /** '' keeps the global language; a profile language never uses a second language. */
  language: string;
  /** Press Enter after insertion, e.g. to send a chat message. */
  enter: boolean;
  /** Proofread through the configured API before insertion (needs the API enabled). */
  proofread: boolean;
}

const MODELS = ['auto', 'tiny', 'base', 'small', 'turbo', 'turbo-hq', 'gigaam'];
const MAX_PROFILES = 50;

/** "C:\\Apps\\Telegram.exe", "Telegram" and "telegram.exe" all name telegram.exe. */
export function normalizeApp(value: string): string {
  const name = value.trim().split(/[\\/]/u).pop()!.trim().toLowerCase();
  if (!name || name.length > 200 || /[<>:"|?*\u0000-\u001f]/u.test(name)) return '';
  return name.endsWith('.exe') ? name : `${name}.exe`;
}

export function findProfile(profiles: AppProfile[], process: string | null | undefined): AppProfile | null {
  const app = process ? normalizeApp(process) : '';
  return (app && profiles.find(profile => profile.app === app)) || null;
}

/** Settings for one dictation in that application. */
export function applyProfile(settings: Settings, profile: AppProfile | null): Settings {
  if (!profile) return settings;
  return {
    ...settings,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.language ? { language: profile.language, language2: '' } : {}),
  };
}

/** Untrusted settings data: keeps valid profiles, one per application. */
export function validateProfiles(raw: unknown): AppProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const profiles: AppProfile[] = [];
  for (const value of raw.slice(0, MAX_PROFILES)) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const app = typeof item.app === 'string' ? normalizeApp(item.app) : '';
    if (!app || seen.has(app)) continue;
    seen.add(app);
    profiles.push({
      app,
      model: MODELS.includes(String(item.model)) ? item.model as Settings['model'] : '',
      language: typeof item.language === 'string' && /^(auto|[a-z]{2,3})$/u.test(item.language) ? item.language : '',
      enter: item.enter === true,
      proofread: item.proofread === true,
    });
  }
  return profiles;
}
