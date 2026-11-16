import type { model } from '@coderline/alphatab';
import type { StaffSettings } from '../edit-types';
import { getBanjoDrone } from './banjo-drone';
import { getPartialCapo, noPartialCapo } from './partial-capo';

/** The settings a staff has now, as `setStaffSettings` takes them; `clef` is the clef of the bar being edited. */
export const readStaffSettings = (staff: model.Staff, clef: number): StaffSettings => ({ tuning: [...staff.tuning], capo: staff.capo, transposition: staff.transpositionPitch, displayTransposition: staff.displayTranspositionPitch, clef, showTab: staff.showTablature, showNotation: staff.showStandardNotation });

/** Whether `next` leaves the staff as it is, so applying it records nothing. A field left out of `next` means unchanged. */
export function staffSettingsUnchanged(staff: model.Staff, clef: number, next: StaffSettings & { tuningName?: string }): boolean {
  const saved = readStaffSettings(staff, clef), same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return same(next.tuning, saved.tuning) && next.capo === saved.capo && next.transposition === saved.transposition && next.displayTransposition === saved.displayTransposition && next.clef === saved.clef && next.showTab === saved.showTab && next.showNotation === saved.showNotation
    && (next.partialCapo === undefined || same(next.partialCapo, getPartialCapo(staff) ?? noPartialCapo)) && (next.droneFret === undefined || next.droneFret === getBanjoDrone(staff)) && (next.tuningName === undefined || next.tuningName === staff.stringTuning.name);
}
