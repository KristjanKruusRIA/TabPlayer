import type { MessageCatalog, MessageKey } from './en';

export type SupportedLanguage = 'en' | 'et' | 'de';
export type LanguagePreference = 'system' | SupportedLanguage;
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['en', 'et', 'de'] as const;

export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type { MessageCatalog, MessageKey };

export interface I18nContextValue {
  lang: SupportedLanguage;
  preference: LanguagePreference;
  setPreference: (pref: LanguagePreference) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  catalog: MessageCatalog;
}
