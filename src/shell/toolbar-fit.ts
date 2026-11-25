import type { SupportedLanguage } from '../i18n/types';

export const compactScoreDisplayWidth = 1366;

// Keep the wider thresholds previously measured for showing the Key group beside the full transport.
const keyInRowMeasured = { en: 2035, et: 2135, de: 2230 } satisfies Record<SupportedLanguage, number>;
const toolbarMargin = 20;
const round = (value: number) => Math.ceil(value / 5) * 5;
export interface ToolbarFit {
  /** Below this width the transport has a row of its own. */
  transportRowBelow: number;
  /** From this width the display group shares the first row. */
  singleRowFrom: number;
  /** From this width the Key group is in the transport row in the single row layout; between singleRowFrom and this it is in More playback. */
  keyInRowFrom: number;
}
export const toolbarFit = Object.fromEntries((['en', 'et', 'de'] as const).map(language => [language, {
  transportRowBelow: compactScoreDisplayWidth,
  singleRowFrom: compactScoreDisplayWidth,
  keyInRowFrom: round(keyInRowMeasured[language] + toolbarMargin),
} satisfies ToolbarFit])) as Record<SupportedLanguage, ToolbarFit>;

/** The Key group is folded into More playback in a narrow window (the toolbar's own 1100px) and in the single row layout until the row also holds it. */
export function keyFoldQuery(language: SupportedLanguage): string {
  const { singleRowFrom, keyInRowFrom } = toolbarFit[language];
  return `(max-width: 1100px), (width >= ${singleRowFrom}px) and (width < ${keyInRowFrom}px)`;
}
