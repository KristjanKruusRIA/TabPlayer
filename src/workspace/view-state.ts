import type { model } from '@coderline/alphatab';
import { trackIdentity } from '../engine';
import { repairSelection } from '../selection';
import { repairScoreDisplay } from '../engraving/screen-view';
import type { DocumentViewState } from './types';
import { currentViewDefaults,defaultDocumentView } from './view-defaults';
/** The first view of a score without one of its own, from the saved default view. */
export function initialDocumentView():DocumentViewState {
  return defaultDocumentView(currentViewDefaults());
}
export function repairDocumentView(score:model.Score,view:DocumentViewState):DocumentViewState {
  const target=repairSelection(score,view.target),staff=score.tracks[target.track].staves[target.staff];
  const notes=staff.bars[target.bar].voices[target.voice].beats[target.beat]?.notes ?? [];
  const ids=new Set(score.tracks.map(trackIdentity));
  const custom=view.trackView.kind==='custom'?view.trackView.trackIds.filter(id=>ids.has(id)):[];
  const scoreDisplay=repairScoreDisplay(view.scoreDisplay);
  return {target,selectedString:staff.isPercussion||!staff.tuning.length?1:Number.isInteger(view.selectedString)?Math.max(1,Math.min(view.selectedString,staff.tuning.length)):1,
    selectedNoteIndex:view.selectedNoteIndex!==null&&Number.isInteger(view.selectedNoteIndex)&&view.selectedNoteIndex>=0&&view.selectedNoteIndex<notes.length?view.selectedNoteIndex:null,
    zoom:Number.isFinite(view.zoom)&&view.zoom>=25&&view.zoom<=300?view.zoom:100,
    trackView:view.trackView.kind==='custom'?custom.length?{kind:'custom',trackIds:custom}:{kind:'selected'}:{kind:view.trackView.kind},instrumentVisible:view.instrumentVisible,...(scoreDisplay?{scoreDisplay}:{})};
}
