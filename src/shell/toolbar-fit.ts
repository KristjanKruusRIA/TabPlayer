import type { SupportedLanguage } from '../i18n/types';

/**
 * Where the toolbar's groups fit in one row. The numbers are measured in a desktop run (see the validation note of
 * 2026-11-14 on the native view settings), not guessed: a sweep in steps of 5px, for each language, looked for a control
 * of any toolbar group that has another element at its centre, and recorded the first width from which there is none.
 * The captions of the display group differ by language (it is about 524px wide in English, 626 in Estonian, 720 in German),
 * and the transport row is about 1003px wide with the Key group in it and about 870 without; a selection adds the 34px loop-selection button.
 *
 * Three layouts, widest first:
 * - single row: left, display, transport and right groups side by side (needs the most width);
 * - two rows: left, transport and right, with the display group below;
 * - the transport on a row of its own, above left, display and right.
 * Inside the single row the Key group lives in More playback until the row also holds it.
 */
export const toolbarMeasured = {
  /** Spare pixels kept over every measured width. */
  margin: 20,
  /** The first width at which the two-row layout, with the Key group in the row, had no covered control (all languages). */
  twoRowKeyClean: 1495,
  /** The first width at which the single row, with the Key group folded away, had no covered control (with a selection, so the loop-selection button is in the row). */
  singleRowClean: { en: 1900, et: 2005, de: 2095 } satisfies Record<SupportedLanguage, number>,
  /** The first width at which the single row held the Key group in the row without a covered control. */
  singleRowKeyClean: { en: 2035, et: 2135, de: 2230 } satisfies Record<SupportedLanguage, number>,
};

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
  transportRowBelow: round(toolbarMeasured.twoRowKeyClean + toolbarMeasured.margin),
  singleRowFrom: Math.max(1880, round(toolbarMeasured.singleRowClean[language] + toolbarMeasured.margin)),
  keyInRowFrom: round(toolbarMeasured.singleRowKeyClean[language] + toolbarMeasured.margin),
} satisfies ToolbarFit])) as Record<SupportedLanguage, ToolbarFit>;

/** The Key group is folded into More playback in a narrow window (the toolbar's own 1100px) and in the single row layout until the row also holds it. */
export function keyFoldQuery(language: SupportedLanguage): string {
  const { singleRowFrom, keyInRowFrom } = toolbarFit[language];
  return `(max-width: 1100px), (width >= ${singleRowFrom}px) and (width < ${keyInRowFrom}px)`;
}
