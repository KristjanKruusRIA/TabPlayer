import type { MusicSelection } from '../editor/range-types';

/** The bar that picks the system for a gap: the start of a range, the first bar of a bar selection, the lowest bar among selected notes, else the caret's bar. */
export function selectedGapBar(selection:MusicSelection|null,caretBar:number):number {
  if(!selection)return caretBar;
  if(selection.kind==='range')return selection.range.start.bar;
  if(selection.kind==='bars')return selection.firstBar;
  return selection.notes.length?Math.min(...selection.notes.map(note=>note.target.bar)):caretBar;
}
