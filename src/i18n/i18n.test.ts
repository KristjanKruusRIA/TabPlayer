// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  catalogs,
  getMessage,
  readLanguagePreference,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  useI18n,
  writeLanguagePreference,
  type LanguagePreference,
  type MessageKey,
  type SupportedLanguage,
} from './index';

describe('i18n catalog completeness', () => {
  const enKeys = Object.keys(catalogs.en) as MessageKey[];

  it('defines English as the source catalog with a substantial set of keys', () => {
    expect(enKeys.length).toBeGreaterThan(50);
  });

  it('contains complete Estonian translations for every English key', () => {
    for (const key of enKeys) {
      const etValue = (catalogs.et as Record<string, string>)[key];
      expect(etValue, `Missing Estonian key: ${key}`).toBeDefined();
      expect(typeof etValue).toBe('string');
      expect(etValue.trim().length, `Empty Estonian translation for: ${key}`).toBeGreaterThan(0);
    }
  });

  it('contains complete German translations for every English key', () => {
    for (const key of enKeys) {
      const deValue = (catalogs.de as Record<string, string>)[key];
      expect(deValue, `Missing German key: ${key}`).toBeDefined();
      expect(typeof deValue).toBe('string');
      expect(deValue.trim().length, `Empty German translation for: ${key}`).toBeGreaterThan(0);
    }
  });

  it('does not have orphaned keys in Estonian or German catalogs', () => {
    const enSet = new Set(enKeys);
    for (const key of Object.keys(catalogs.et)) {
      expect(enSet.has(key as MessageKey), `Orphaned key in et: ${key}`).toBe(true);
    }
    for (const key of Object.keys(catalogs.de)) {
      expect(enSet.has(key as MessageKey), `Orphaned key in de: ${key}`).toBe(true);
    }
  });
});

describe('i18n fallback behavior', () => {
  it('falls back to English when a key is missing or empty in a language', () => {
    const customCatalogs = {
      en: { 'test.hello': 'Hello', 'test.only_en': 'Only in English' },
      et: { 'test.hello': 'Tere' },
      de: { 'test.hello': 'Hallo' },
    };
    expect(getMessage('et', 'test.hello' as any, undefined, customCatalogs as any)).toBe('Tere');
    expect(getMessage('et', 'test.only_en' as any, undefined, customCatalogs as any)).toBe('Only in English');
    expect(getMessage('de', 'test.only_en' as any, undefined, customCatalogs as any)).toBe('Only in English');
  });

  it('never displays a raw key name even if key is missing from all catalogs', () => {
    const message = getMessage('et', 'non.existent.key' as any);
    expect(message).not.toBe('non.existent.key');
    expect(message).toBe('');
  });

  it('resolves system language and falls back to English for unsupported locales', () => {
    expect(resolveLanguage('system', 'et-EE')).toBe('et');
    expect(resolveLanguage('system', 'et')).toBe('et');
    expect(resolveLanguage('system', 'de-DE')).toBe('de');
    expect(resolveLanguage('system', 'de-AT')).toBe('de');
    expect(resolveLanguage('system', 'en-US')).toBe('en');
    expect(resolveLanguage('system', 'en-GB')).toBe('en');
    expect(resolveLanguage('system', 'fr-FR')).toBe('en');
    expect(resolveLanguage('system', 'ja-JP')).toBe('en');
    expect(resolveLanguage('system', '')).toBe('en');
    expect(resolveLanguage('system', undefined)).toBe('en');
  });

  it('respects explicit language preference over system language', () => {
    expect(resolveLanguage('et', 'de-DE')).toBe('et');
    expect(resolveLanguage('de', 'en-US')).toBe('de');
    expect(resolveLanguage('en', 'et-EE')).toBe('en');
  });
});

describe('i18n preference storage', () => {
  let mockStore: Record<string, string>;
  const storage = {
    getItem: (key: string) => mockStore[key] ?? null,
    setItem: (key: string, value: string) => { mockStore[key] = value; },
  };

  beforeEach(() => {
    mockStore = {};
  });

  it('reads default system preference when storage is empty', () => {
    expect(readLanguagePreference(storage)).toBe('system');
  });

  it('round-trips preferences to storage', () => {
    writeLanguagePreference('et', storage);
    expect(readLanguagePreference(storage)).toBe('et');
    writeLanguagePreference('de', storage);
    expect(readLanguagePreference(storage)).toBe('de');
    writeLanguagePreference('system', storage);
    expect(readLanguagePreference(storage)).toBe('system');
  });

  it('reads language saved with existing input preferences', () => {
    storage.setItem('tabplayer.input.preferences', JSON.stringify({ autoDuration: true, language: 'de' }));
    expect(readLanguagePreference(storage)).toBe('de');
  });

  it('writes language both to tabplayer.language and into tabplayer.input.preferences', () => {
    storage.setItem('tabplayer.input.preferences', JSON.stringify({ autoDuration: true }));
    writeLanguagePreference('et', storage);
    expect(storage.getItem('tabplayer.language')).toBe('et');
    const inputPrefs = JSON.parse(storage.getItem('tabplayer.input.preferences')!);
    expect(inputPrefs.language).toBe('et');
    expect(inputPrefs.autoDuration).toBe(true);
  });
});

describe('useI18n hook and runtime switching', () => {
  beforeEach(() => {
    localStorage.clear();
    writeLanguagePreference('system');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('switches languages at runtime and updates messages immediately', () => {
    const { result } = renderHook(() => useI18n());
    expect(result.current.preference).toBe('system');
    
    act(() => {
      result.current.setPreference('et');
    });
    expect(result.current.preference).toBe('et');
    expect(result.current.lang).toBe('et');
    expect(result.current.t('action.undo')).toBe('Võta tagasi');

    act(() => {
      result.current.setPreference('de');
    });
    expect(result.current.preference).toBe('de');
    expect(result.current.lang).toBe('de');
    expect(result.current.t('action.undo')).toBe('Rückgängig');

    act(() => {
      result.current.setPreference('en');
    });
    expect(result.current.preference).toBe('en');
    expect(result.current.lang).toBe('en');
    expect(result.current.t('action.undo')).toBe('Undo');
  });

  it('interpolates parameters correctly', () => {
    const { result } = renderHook(() => useI18n());
    act(() => {
      result.current.setPreference('en');
    });
    const msg = result.current.t('transport.bar_x_of_y', { current: 3, total: 16 });
    expect(msg).toBe('Bar 3 of 16');
  });
});

describe('i18n pinned wording', () => {
  it('keeps the English text the desktop drivers and tests rely on', () => {
    expect(catalogs.en['batch.title']).toBe('Batch convert scores');
  });

  it('keeps the command palette words in translated hints', () => {
    for (const lang of ['et', 'de'] as const) {
      for (const key of ['palette.placeholder', 'palette.no_matches', 'help.shortcut_palette', 'help.topic.editing.p3'] as const) {
        const text = getMessage(lang, key);
        expect(text, `${lang} ${key}`).not.toMatch(/\b(takt|krihv|bund|eb-dur)\b/i);
      }
    }
  });

  it('uses grammatical singular and plural document counts', () => {
    expect(getMessage('en', 'recovery.recoverable_one', { count: 1 })).toBe('1 recoverable document');
    expect(getMessage('et', 'recovery.recoverable_one', { count: 1 })).toBe('1 taastatav dokument');
    expect(getMessage('et', 'recovery.recoverable_other', { count: 3 })).toBe('3 taastatavat dokumenti');
    expect(getMessage('de', 'recovery.recoverable_one', { count: 1 })).toBe('1 wiederherstellbares Dokument');
    expect(getMessage('de', 'recovery.recoverable_other', { count: 3 })).toBe('3 wiederherstellbare Dokumente');
  });

  it('uses Strg in German shortcut text', () => {
    for (const key of Object.keys(catalogs.de) as MessageKey[]) expect(catalogs.de[key], key).not.toContain('Ctrl');
  });
});
