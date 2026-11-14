import { useI18n } from '../i18n';
import { useEffect,useState } from 'react';
import type { RangeCommand,RangePanelProps,StrokeDirection,StrokeTechnique,VoiceAddress } from './range-types';
import { resolveSelectionBeats,resolveSelectionNotes,selectionForBars,selectionForTrack,validateMusicSelection } from './range-selection';
import { eraseCommandFor } from './range-cut';

function scopeLanes({score,target}:Pick<RangePanelProps,'score'|'target'>,bar:number,scope:string):VoiceAddress[] {
  return score.tracks.filter(track=>scope==='all'||track.index===target.track).flatMap(track=>track.staves.filter(staff=>(scope!=='lane'&&scope!=='staff')||staff.index===target.staff).flatMap(staff=>(staff.bars[bar]?.voices??[]).filter(voice=>scope!=='lane'||voice.index===target.voice).map(voice=>({track:track.index,staff:staff.index,voice:voice.index}))));
}
const strokeSteps=new Map<string,StrokeDirection>([['d','down'],['down','down'],['u','up'],['up','up'],['-','none'],['none','none']]);
/** Reads "D U -" style patterns; words and commas are accepted too. */
function parseStrokes(text:string):StrokeDirection[]|null {
  const steps=text.trim().toLowerCase().split(/[\s,]+/).filter(Boolean).map(step=>strokeSteps.get(step));
  return steps.length&&steps.length<=16&&steps.every(step=>step!==undefined)?steps as StrokeDirection[]:null;
}
function readScope({score,target,selection}:Pick<RangePanelProps,'score'|'target'|'selection'>) {
  if(!selection)return 'lane';
  const equal=(a:string[],b:string[])=>a.length===b.length&&a.every(value=>b.includes(value));
  if(selection.kind==='bars')return equal(selection.tracks.map(String),[String(target.track)])?'track':equal(selection.tracks.map(String),score.tracks.map(track=>String(track.index)))?'all':'custom';
  if(selection.kind==='notes')return 'custom';
  const key=(lane:VoiceAddress)=>`${lane.track}/${lane.staff}/${lane.voice}`;
  return ['lane','staff','track','all'].find(scope=>equal(selection.range.lanes.map(key),scopeLanes({score,target},selection.range.start.bar,scope).map(key)))??'custom';
}
export function RangePanel({score,target,selection,busy,locked=false,onSelection,onEdit}:RangePanelProps) {
  const { t } = useI18n();
  const [semitones,setSemitones]=useState('1'),[maxFret,setMaxFret]=useState('24'),[strings,setStrings]=useState<number[]>([]),[scope,setScope]=useState(()=>readScope({score,target,selection})),[error,setError]=useState('');
  const [technique,setTechnique]=useState<StrokeTechnique>('pick'),[pattern,setPattern]=useState('D U');
  const staff=score.tracks[target.track]?.staves[target.staff];
  useEffect(()=>{setSemitones('1');setMaxFret('24');setStrings(staff?.tuning.map((_,index)=>index+1)??[]);setScope(readScope({score,target,selection}));setError('');},[score,selection,target.track,target.staff,target.bar,target.voice,target.beat]);
  let selectedBeats:ReturnType<typeof resolveSelectionBeats>=[],selectedNotes:ReturnType<typeof resolveSelectionNotes>=[],selectionError='';
  if(selection)try{selectedBeats=resolveSelectionBeats(score,selection);selectedNotes=resolveSelectionNotes(score,selection);}catch(reason){selectionError=reason instanceof Error?reason.message:String(reason);}
  const selectedLanes:VoiceAddress[]=selection&&!selectionError&&selection.kind==='range'?selection.range.lanes:selection&&!selectionError&&selection.kind==='bars'?selection.tracks.flatMap(track=>score.tracks[track].staves.flatMap(staff=>staff.bars.slice(selection.firstBar,selection.lastBar+1).flatMap(bar=>bar.voices.map(voice=>({track,staff:staff.index,voice:voice.index}))))):selectedBeats.map(beat=>({track:beat.voice.bar.staff.track.index,staff:beat.voice.bar.staff.index,voice:beat.voice.index}));
  const lanes=[...new Set(selectedLanes.map(lane=>t('editor.lane_label',{track:lane.track+1,staff:lane.staff+1,voice:lane.voice+1})))];
  const available=!!selection&&!selectionError&&selectedNotes.length>0;
  const hasStrings=available&&selectedLanes.every(lane=>{const staff=score.tracks[lane.track].staves[lane.staff];return !staff.isPercussion&&staff.tuning.length>0;})&&selectedNotes.every(note=>note.isStringed&&!note.isPercussion);
  const melodic=available&&selectedNotes.every(note=>!note.isPercussion&&!note.beat.voice.bar.staff.isPercussion);
  const action=(work:()=>void)=>{try{work();setError('');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};
  const edit=(command:RangeCommand)=>action(()=>onEdit(command));
  const shift=(value:number)=>{
    if(!selection)return;
    if(!Number.isInteger(value)||value===0||value< -127||value>127){setError(t('editor.err_semitones'));return;}
    edit({type:'transposeSelection',selection,semitones:value});
  };
  const sustain=(kind:'letRing'|'palmMute',enabled:boolean)=>{
    if(!selection)return;if(!strings.length){setError(t('editor.err_choose_string'));return;}
    edit({type:'setSelectionSustain',selection,strings:[...strings].sort((a,b)=>a-b),kind,enabled});
  };
  const strokes=(steps:StrokeDirection[]|null)=>{
    if(!selection)return;if(!steps){setError(t('editor.err_stroke_steps'));return;}
    edit({type:'setSelectionStrokes',selection,technique,pattern:steps});
  };
  const broaden=()=>action(()=>{
    if(!selection)return;
    if(selection.kind==='bars'){
      const tracks=scope==='all'?score.tracks.map(track=>track.index):[target.track];onSelection(selectionForBars(score,tracks,selection.firstBar,selection.lastBar));return;
    }
    if(selection.kind!=='range')return;
    const lanes=scopeLanes({score,target},selection.range.start.bar,scope);
    const value={kind:'range' as const,range:{...selection.range,lanes}};validateMusicSelection(score,value);onSelection(value);
  });
  const fretAction=()=>{
    const value=Number(maxFret);if(!maxFret.trim()||!Number.isInteger(value)||value<1||value>127){setError(t('editor.err_max_fret'));return;}
    if(selection)edit({type:'refingerSelection',selection,maxFret:value});
  };
  return <details className="editor-section" open><summary>{t('editor.music_selection')}</summary><fieldset disabled={busy}>
    <div className="editor-actions">
      <button onClick={()=>action(()=>onSelection(selectionForBars(score,[target.track],target.bar,target.bar)))}>{t('editor.select_bar')}</button>
      <button onClick={()=>action(()=>onSelection(selectionForTrack(score,target.track)))}>{t('editor.select_track')}</button>
      <button onClick={()=>action(()=>onSelection(selectionForBars(score,score.tracks.map(track=>track.index),0,score.masterBars.length-1)))}>{t('editor.select_all')}</button>
      <button disabled={!selection} onClick={()=>onSelection(null)}>{t('editor.clear_selection')}</button>
    </div>
    <p>{selectedNotes.length} {selectedNotes.length===1?t('editor.note_singular'):t('editor.note_plural')} · {selectedBeats.length} {selectedBeats.length===1?t('editor.beat_singular'):t('editor.beat_plural')}</p>
    {selection?.kind==='bars'&&<p>{t('editor.bars_tracks_summary',{first:selection.firstBar+1,last:selection.lastBar+1,tracks:selection.tracks.map(track=>track+1).join(', ')})}</p>}
    {lanes.map(lane=><p key={lane}>{lane}</p>)}
    <label>{t('editor.selection_scope')}<select value={scope} disabled={!selection||selection.kind==='notes'} onChange={event=>setScope(event.target.value)}>
      <option value="custom" disabled>{t('editor.scope_custom')}</option><option value="lane" disabled={selection?.kind==='bars'}>{t('editor.scope_lane')}</option><option value="staff" disabled={selection?.kind==='bars'}>{t('editor.scope_current_staff')}</option><option value="track">{t('editor.scope_current_track')}</option><option value="all">{t('editor.scope_all_tracks')}</option>
    </select></label>
    <button disabled={!selection||selection.kind==='notes'||!!selectionError||scope==='custom'} onClick={broaden}>{t('editor.apply_selection_scope')}</button>
    <fieldset disabled={!available||locked}><legend>{t('editor.selected_notes')}</legend>
      <button onClick={()=>selection&&edit(eraseCommandFor(score,selection,{track:target.track,staff:target.staff,voice:target.voice}))}>{t('editor.erase_selected_notes')}</button>
      <div className="editor-actions"><button disabled={!melodic} onClick={()=>selection&&edit({type:'setSelectionTies',selection,tied:true})}>{t('editor.tie_selected_notes')}</button><button onClick={()=>selection&&edit({type:'setSelectionTies',selection,tied:false})}>{t('editor.untie_selected_notes')}</button><button disabled={!melodic} title="Ties each note to the earlier note on its string and gives it that fret" onClick={()=>selection&&edit({type:'tieSelectionToEarlierPitch',selection})}>Tie to earlier pitch</button></div>
      <fieldset disabled={!melodic}><legend>{t('editor.transpose')}</legend>
        <div className="editor-actions"><button onClick={()=>shift(-1)}>{t('editor.down_semitone')}</button><button onClick={()=>shift(1)}>{t('editor.up_semitone')}</button><button onClick={()=>shift(-12)}>{t('editor.down_octave')}</button><button onClick={()=>shift(12)}>{t('editor.up_octave')}</button></div>
        <label>{t('editor.semitones')}<input type="number" min={-127} max={127} step={1} value={semitones} onChange={event=>setSemitones(event.target.value)}/></label><button onClick={()=>shift(semitones.trim()?Number(semitones):0)}>{t('editor.transpose_selection')}</button>
      </fieldset>
      <fieldset disabled={!hasStrings}><legend>{t('editor.guitar_and_bass')}</legend>
        <div className="editor-actions"><button onClick={()=>selection&&edit({type:'moveSelectionStrings',selection,direction:'higher'})}>{t('editor.move_to_higher_string')}</button><button onClick={()=>selection&&edit({type:'moveSelectionStrings',selection,direction:'lower'})}>{t('editor.move_to_lower_string')}</button></div>
        <label>{t('editor.maximum_fret')}<input type="number" min={1} max={127} step={1} value={maxFret} onChange={event=>setMaxFret(event.target.value)}/></label><button onClick={fretAction}>{t('editor.refinger_selection')}</button>
        <fieldset><legend>{t('editor.sustain_strings')}</legend>{staff?.tuning.map((_,index)=>{const string=index+1;return <label key={string}><input type="checkbox" checked={strings.includes(string)} onChange={event=>setStrings(event.target.checked?[...strings,string]:strings.filter(value=>value!==string))}/>{t('editor.string_n',{string})}</label>;})}</fieldset>
        <div className="editor-actions"><button onClick={()=>sustain('letRing',true)}>{t('editor.enable_let_ring')}</button><button onClick={()=>sustain('letRing',false)}>{t('editor.disable_let_ring')}</button><button onClick={()=>sustain('palmMute',true)}>{t('editor.enable_palm_mute')}</button><button onClick={()=>sustain('palmMute',false)}>{t('editor.disable_palm_mute')}</button></div>
        <fieldset><legend>{t('editor.picking_and_strumming')}</legend>
          <label>{t('editor.pattern_technique')}<select value={technique} onChange={event=>setTechnique(event.target.value as StrokeTechnique)}><option value="pick">{t('editor.technique_pick')}</option><option value="brush">{t('editor.technique_brush')}</option><option value="arpeggio">{t('editor.technique_arpeggio')}</option></select></label>
          <div className="editor-actions"><button onClick={()=>setPattern('D U')}>{t('editor.alternate_picking')}</button><button onClick={()=>setPattern('D')}>{t('editor.all_downstrokes')}</button></div>
          <label>{t('editor.stroke_pattern')}<input value={pattern} aria-describedby="stroke-pattern-help" onChange={event=>setPattern(event.target.value)}/></label>
          <p className="muted" id="stroke-pattern-help">{t('editor.stroke_pattern_help')}</p>
          <div className="editor-actions"><button onClick={()=>strokes(parseStrokes(pattern))}>{t('editor.apply_stroke_pattern')}</button><button onClick={()=>strokes(['none'])}>{t('editor.clear_strokes')}</button></div>
        </fieldset>
      </fieldset>
    </fieldset>
    {(selectionError||error)&&<p role="alert">{selectionError||error}</p>}
  </fieldset></details>;
}
