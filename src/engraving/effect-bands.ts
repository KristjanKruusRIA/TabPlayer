import type { Settings } from '@coderline/alphatab';

/** Gap in px between stacked effect bands above a staff (tempo, section marker, directions). alphaTab's default is 2, which leaves a tempo mark and a section name at the same bar start about 2 px apart; the screen renderer and PDF export both use this value so they stay in step. */
export const EFFECT_BAND_PADDING_BOTTOM=5;

export function applyEffectBandSpacing(settings:Settings):void {
  settings.display.effectBandPaddingBottom=EFFECT_BAND_PADDING_BOTTOM;
}
