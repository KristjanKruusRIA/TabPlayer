import type { model } from '@coderline/alphatab';
import { stringCapo } from '../editor/partial-capo';
import { fretPositions, type PositionNote } from '../instruments/fret-positions';

/** The wired Fretlight neck: six strings, frets 0 to 21, one LED each (documented in `docs/validation/2026-11-14-gp8-fretlight.md`). */
export const FRETLIGHT_STRINGS = 6;
export const FRETLIGHT_FRETS = 22;
export const FRETLIGHT_LEDS = FRETLIGHT_STRINGS * FRETLIGHT_FRETS;

/**
 * Which fret to light for a note written at `written` under a capo at `capo`.
 *  - `physical` (the default): the fret on the real neck, written + capo. A capo sits on the guitar the player holds, so
 *    the finger goes there; the on-screen view shows the written number, counted from the capo.
 *  - `written`: the number as written, the on-screen view's own number.
 * The design note left this open and nobody has tried it on a device. This is the one place it is decided.
 */
export type CapoMode = 'physical' | 'written';
export const DEFAULT_CAPO_MODE: CapoMode = 'physical';
export const ledFret = (written: number, capo: number, mode: CapoMode = DEFAULT_CAPO_MODE): number => mode === 'physical' ? written + capo : written;

/** The device numbers its strings from the high E; the score counts from the lowest string. */
export const deviceString = (scoreString: number): number => FRETLIGHT_STRINGS + 1 - scoreString;

/** Why nothing is lit: only a pitched staff with six strings is sent, whatever its tuning or instrument. */
export type FrameProblem = 'not_six_string';
/** The LEDs to light. `leds[(string - 1) * 22 + fret]`, string 1 the high E. */
export interface FretlightFrame { leds: boolean[]; problem: FrameProblem | null; /** Positions left out for being past fret 21 or not on a whole fret. */ dropped: number }

export const emptyFrame = (problem: FrameProblem | null = null): FretlightFrame => ({ leds: new Array<boolean>(FRETLIGHT_LEDS).fill(false), problem, dropped: 0 });

/**
 * The frame for the shown notes of one staff, the same positions the instrument view marks.
 *  - Strings and tuning: six strings, not percussion; anything else is sent as an empty frame with a problem. The tuning
 *    changes pitch, not where a finger goes, so a drop D neck lights the same frets.
 *  - Handedness: the device is a physical neck, so the on-screen left-handed mirror does not change the LEDs.
 *  - Capo: see `ledFret`; a partial capo counts on the strings it covers.
 *  - Frets past 21 are dropped and counted.
 */
export function frameFor(staff: model.Staff, notes: readonly PositionNote[], options: { capoMode?: CapoMode } = {}): FretlightFrame {
  if (staff.isPercussion || staff.tuning.length !== FRETLIGHT_STRINGS) return emptyFrame('not_six_string');
  const frame = emptyFrame();
  for (const { string, fret } of fretPositions(staff, notes)) {
    const physical = ledFret(fret, stringCapo(staff, string), options.capoMode);
    if (!Number.isInteger(physical) || physical < 0 || physical >= FRETLIGHT_FRETS) { frame.dropped++; continue; }
    frame.leds[(deviceString(string) - 1) * FRETLIGHT_FRETS + physical] = true;
  }
  return frame;
}

/** The lit LEDs, by device string then fret. */
export function litSet(frame: FretlightFrame): Array<{ string: number; fret: number }> {
  const lit: Array<{ string: number; fret: number }> = [];
  frame.leds.forEach((on, index) => { if (on) lit.push({ string: Math.floor(index / FRETLIGHT_FRETS) + 1, fret: index % FRETLIGHT_FRETS }); });
  return lit;
}
/** Equal for equal lit sets, so a status update that changes nothing sends nothing. */
export const frameKey = (frame: FretlightFrame): string => frame.leds.map(on => on ? '1' : '0').join('');
