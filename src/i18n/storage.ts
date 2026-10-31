import type { LanguagePreference, PreferenceStorage, SupportedLanguage } from './types';
import { SUPPORTED_LANGUAGES } from './types';

const LANGUAGE_KEY = 'tabplayer.language';
const INPUT_PREFS_KEY = 'tabplayer.input.preferences';

export const browserStorage = (): PreferenceStorage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function resolveLanguage(
  preference: LanguagePreference,
  systemLanguage?: string,
): SupportedLanguage {
  if (preference !== 'system' && (SUPPORTED_LANGUAGES as readonly string[]).includes(preference)) {
    return preference as SupportedLanguage;
  }
  const raw = (systemLanguage ?? (typeof navigator !== 'undefined' ? navigator.language : '') ?? '').trim().toLowerCase();
  if (raw.startsWith('et')) return 'et';
  if (raw.startsWith('de')) return 'de';
  return 'en';
}

export function readLanguagePreference(storage: PreferenceStorage | undefined = browserStorage()): LanguagePreference {
  try {
    const direct = storage?.getItem(LANGUAGE_KEY);
    if (direct && (direct === 'system' || (SUPPORTED_LANGUAGES as readonly string[]).includes(direct))) {
      return direct as LanguagePreference;
    }
  } catch {
    // ignore
  }

  try {
    const inputPrefsRaw = storage?.getItem(INPUT_PREFS_KEY);
    if (inputPrefsRaw) {
      const parsed = JSON.parse(inputPrefsRaw) as Record<string, unknown>;
      if (typeof parsed.language === 'string' && (parsed.language === 'system' || (SUPPORTED_LANGUAGES as readonly string[]).includes(parsed.language))) {
        return parsed.language as LanguagePreference;
      }
    }
  } catch {
    // ignore
  }

  return 'system';
}

export function writeLanguagePreference(
  preference: LanguagePreference,
  storage: PreferenceStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(LANGUAGE_KEY, preference);
  } catch {
    // Storage can be unavailable
  }

  try {
    let current: Record<string, unknown> = {};
    const existing = storage?.getItem(INPUT_PREFS_KEY);
    if (existing) {
      try {
        current = JSON.parse(existing) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
    current.language = preference;
    storage?.setItem(INPUT_PREFS_KEY, JSON.stringify(current));
  } catch {
    // Storage can be unavailable
  }
}
