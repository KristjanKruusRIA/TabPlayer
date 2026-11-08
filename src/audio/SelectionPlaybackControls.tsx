import { useEffect } from 'react';
import { useI18n } from '../i18n';
import type { MeasureOccurrence } from './types';
import type { CursorPlaybackChoice,PassagePlaybackChoice } from './selection-playback-types';
import { requireCursorChoice,requirePassageChoice } from './selection-playback';

export interface SelectionPlaybackControlsProps {
  cursorChoices:readonly CursorPlaybackChoice[];passageChoices:readonly PassagePlaybackChoice[];occurrences:readonly Readonly<MeasureOccurrence>[];
  cursorChoice:CursorPlaybackChoice|null;passageChoice:PassagePlaybackChoice|null;disabled:boolean;
  onCursorChoice:(choice:CursorPlaybackChoice|null)=>void;onPassageChoice:(choice:PassagePlaybackChoice|null)=>void;
  onPlayCursor:()=>void;onPlaySelection:()=>void;onLoopSelection:()=>void;
}
export function SelectionPlaybackControls({cursorChoices,passageChoices,occurrences,cursorChoice,passageChoice,disabled,onCursorChoice,onPassageChoice,onPlayCursor,onPlaySelection,onLoopSelection}:SelectionPlaybackControlsProps):React.JSX.Element {
  const { t } = useI18n();
  const cursorLabel=(choice:CursorPlaybackChoice)=>{
    const occurrence=occurrences[choice.occurrenceIndex];return occurrence?t('transport.bar_occurrence',{bar:occurrence.bar+1,occurrence:occurrence.occurrence+1}):null;
  };
  const passageLabel=(choice:PassagePlaybackChoice)=>{
    const start=occurrences[choice.startOccurrence],end=occurrences[choice.endOccurrence];
    return start&&end?t('transport.passage_range',{startBar:start.bar+1,startOccurrence:start.occurrence+1,endBar:end.bar+1,endOccurrence:end.occurrence+1}):null;
  };
  let cursorIndex=-1,passageIndex=-1;
  try {if(cursorChoice&&cursorLabel(cursorChoice)){requireCursorChoice(cursorChoices,cursorChoice);cursorIndex=cursorChoices.findIndex(choice=>choice.generation===cursorChoice.generation&&choice.occurrenceIndex===cursorChoice.occurrenceIndex&&choice.startTick===cursorChoice.startTick);}}catch{/* Stale controlled choices remain unavailable until the parent accepts a current choice. */}
  try {if(passageChoice&&passageLabel(passageChoice)){requirePassageChoice(passageChoices,passageChoice);passageIndex=passageChoices.findIndex(choice=>choice.generation===passageChoice.generation&&choice.startOccurrence===passageChoice.startOccurrence&&choice.endOccurrence===passageChoice.endOccurrence&&choice.startTick===passageChoice.startTick&&choice.endTick===passageChoice.endTick);}}catch{/* The parent owns selected choices and their resets. */}
  useEffect(()=>{if(cursorChoices.length===1&&cursorIndex<0&&cursorLabel(cursorChoices[0]))onCursorChoice({...cursorChoices[0]});},[cursorChoices,cursorIndex,occurrences,onCursorChoice]);
  useEffect(()=>{if(passageChoices.length===1&&passageIndex<0&&passageLabel(passageChoices[0]))onPassageChoice({...passageChoices[0]});},[passageChoices,passageIndex,occurrences,onPassageChoice]);
  return <details><summary>{t('transport.selected_playback')}</summary><fieldset disabled={disabled} style={{flexWrap:'wrap'}}>
    <label>{t('transport.cursor_occurrence')}<select style={{width:'auto',maxWidth:'100%'}} value={cursorIndex<0?'':String(cursorIndex)} disabled={!cursorChoices.length} onChange={event=>{if(disabled)return;const choice=cursorChoices[Number(event.target.value)];onCursorChoice(event.target.value!==''&&choice?{...choice}:null);}}>
      <option value="">{t('transport.choose_occurrence')}</option>{cursorChoices.map((choice,index)=><option key={index} value={index} disabled={!cursorLabel(choice)}>{cursorLabel(choice)??t('transport.unavailable_occurrence')}</option>)}
    </select></label>
    <button type="button" disabled={cursorIndex<0} onClick={()=>{if(!disabled&&cursorIndex>=0)onPlayCursor();}}>{t('transport.play_from_cursor_choice')}</button>
    <label>{t('transport.selection_occurrence')}<select style={{width:'auto',maxWidth:'100%'}} value={passageIndex<0?'':String(passageIndex)} disabled={!passageChoices.length} onChange={event=>{if(disabled)return;const choice=passageChoices[Number(event.target.value)];onPassageChoice(event.target.value!==''&&choice?{...choice}:null);}}>
      <option value="">{t('transport.choose_occurrence')}</option>{passageChoices.map((choice,index)=><option key={index} value={index} disabled={!passageLabel(choice)}>{passageLabel(choice)??t('transport.unavailable_occurrence')}</option>)}
    </select></label>
    <button type="button" disabled={passageIndex<0} onClick={()=>{if(!disabled&&passageIndex>=0)onPlaySelection();}}>{t('transport.play_selection')}</button>
    <button type="button" disabled={passageIndex<0} onClick={()=>{if(!disabled&&passageIndex>=0)onLoopSelection();}}>{t('transport.loop_selection')}</button>
    <p>{t('transport.passage_help1')}</p>
    <p>{t('transport.passage_help2')}</p>
  </fieldset></details>;
}
