import { useSyncExternalStore } from 'react';
import { en, type MessageCatalog, type MessageKey } from './en';
import { et } from './et';
import { de } from './de';
import {
  readLanguagePreference,
  resolveLanguage,
  writeLanguagePreference,
} from './storage';
import type {
  I18nContextValue,
  LanguagePreference,
  PreferenceStorage,
  SupportedLanguage,
} from './types';
import { SUPPORTED_LANGUAGES } from './types';

export const catalogs: Record<SupportedLanguage, MessageCatalog> = {
  en,
  et,
  de,
};

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, token) => {
    return token in params ? String(params[token]) : `{${token}}`;
  });
}

export function getMessage(
  lang: SupportedLanguage,
  key: MessageKey,
  params?: Record<string, string | number>,
  customCatalogs: Record<SupportedLanguage, Partial<Record<string, string>>> = catalogs,
): string {
  const chosenCatalog = customCatalogs[lang];
  let text = chosenCatalog?.[key as string];
  if (!text || typeof text !== 'string') {
    text = customCatalogs.en?.[key as string];
  }
  if (!text || typeof text !== 'string') {
    // Missing keys must fall back to English, never show a key
    return '';
  }
  return interpolate(text, params);
}

// Reactive store for language preference
type Listener = () => void;
const listeners = new Set<Listener>();

let currentPreference: LanguagePreference = readLanguagePreference();

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

export function setLanguagePreference(next: LanguagePreference, storage?: PreferenceStorage): void {
  if (currentPreference === next) return;
  currentPreference = next;
  writeLanguagePreference(next, storage);
  notifyListeners();
}

export function getLanguagePreference(): LanguagePreference {
  return currentPreference;
}

export function getResolvedLanguage(systemLang?: string): SupportedLanguage {
  return resolveLanguage(currentPreference, systemLang);
}

const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useI18n(): I18nContextValue {
  const preference = useSyncExternalStore<LanguagePreference>(subscribe, getLanguagePreference, () => 'system');
  const lang = resolveLanguage(preference);
  const catalog = catalogs[lang];

  const t = (key: MessageKey, params?: Record<string, string | number>): string => {
    return getMessage(lang, key, params);
  };

  const setPreference = (next: LanguagePreference) => {
    setLanguagePreference(next);
  };

  return {
    lang,
    preference,
    setPreference,
    t,
    catalog,
  };
}

export * from './types';
export * from './storage';
export { en, et, de };
