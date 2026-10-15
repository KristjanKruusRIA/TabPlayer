import type { model } from '@coderline/alphatab';
import { trackIdentity } from '../engine';
import { repairSelection } from '../selection';
import type { DocumentViewState } from './types';
export function initialDocumentView():DocumentViewState {
  return {target:{track:0,staff:0,bar:0,voice:0,beat:0},selectedString:6,selectedNoteIndex:null,zoom:100,trackView:{kind:'selected'},instrumentVisible:false};
}
export function repairDocumentView(score:model.Score,view:DocumentViewState):DocumentViewState {
  const target=repairSelection(score,view.target),staff=score.tracks[target.track].staves[target.staff];
  const notes=staff.bars[target.bar].voices[target.voice].beats[target.beat]?.notes ?? [];
  const ids=new Set(score.tracks.map(trackIdentity));
  const custom=view.trackView.kind==='custom'?view.trackView.trackIds.filter(id=>ids.has(id)):[];
  return {target,selectedString:staff.isPercussion||!staff.tuning.length?1:Number.isInteger(view.selectedString)?Math.max(1,Math.min(view.selectedString,staff.tuning.length)):1,
    selectedNoteIndex:view.selectedNoteIndex!==null&&Number.isInteger(view.selectedNoteIndex)&&view.selectedNoteIndex>=0&&view.selectedNoteIndex<notes.length?view.selectedNoteIndex:null,
    zoom:Number.isFinite(view.zoom)&&view.zoom>=25&&view.zoom<=300?view.zoom:100,
    trackView:view.trackView.kind==='custom'?custom.length?{kind:'custom',trackIds:custom}:{kind:'selected'}:{kind:view.trackView.kind},instrumentVisible:view.instrumentVisible};
}
