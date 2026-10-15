import { useEffect,useMemo,useState } from 'react';
import type { HarmonyInterval,HarmonyTransposePanelProps } from '../editor/harmony-types';
import { resolveSelectionBeats } from '../editor/range-selection';
import { validateParityCommand } from '../parity-commands';
import { getHarmonyChord } from './chord-source';

type Quality=Extract<HarmonyInterval,{kind:'chromatic'}>['quality'];
const numbers=['Unison','Second','Third','Fourth','Fifth','Sixth','Seventh'];
const numeric=(value:string)=>Number(value.trim()||'NaN');

export function HarmonyTransposePanel({score,selection,busy,onEdit}:HarmonyTransposePanelProps) {
  const [mode,setMode]=useState<HarmonyInterval['kind']>('semitones'),[semitones,setSemitones]=useState('1'),[steps,setSteps]=useState('1'),[number,setNumber]=useState(3),[quality,setQuality]=useState<Quality>('major'),[direction,setDirection]=useState<'up'|'down'>('up'),[octaves,setOctaves]=useState('0');
  const [includeKeys,setIncludeKeys]=useState(false),[includeChords,setIncludeChords]=useState(false),[error,setError]=useState('');
  useEffect(()=>setError(''),[score,selection]);
  const scope=useMemo(()=>{
    let skipped=0,error='';
    try{if(selection)for(const beat of resolveSelectionBeats(score,selection)){
      const staff=beat.voice.bar.staff;if(staff.isPercussion||!beat.chordId)continue;
      const chord=staff.getChord(beat.chordId);if(chord&&getHarmonyChord(chord).nameMode!=='theory')skipped++;
    }}catch(cause){error=cause instanceof Error?cause.message:String(cause);}
    return {skipped,error};
  },[score,selection]);
  const changeMode=(value:HarmonyInterval['kind'])=>{
    setMode(value);setError('');if(value==='diatonic'){setIncludeKeys(false);setIncludeChords(false);}
  };
  const apply=()=>{
    if(busy||!selection||scope.error)return;
    const interval:HarmonyInterval=mode==='semitones'?{kind:'semitones',semitones:numeric(semitones)}:mode==='diatonic'?{kind:'diatonic',steps:numeric(steps)}:{kind:'chromatic',number,quality,direction,octaves:numeric(octaves)};
    const command={type:'transposeHarmony' as const,selection,interval,includeKeySignatures:mode!=='diatonic'&&includeKeys,includeChords:mode!=='diatonic'&&includeChords};
    try{validateParityCommand(command);onEdit(command);setError('');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  };
  return <details className="editor-section" open><summary>Harmony transposition</summary><fieldset disabled={busy}>
    <label>Transposition mode<select value={mode} onChange={event=>changeMode(event.target.value as HarmonyInterval['kind'])}><option value="semitones">Signed semitones</option><option value="chromatic">Named chromatic interval</option><option value="diatonic">Diatonic scale steps</option></select></label>
    {mode==='semitones'&&<label>Signed semitones<input type="number" min={-127} max={127} step={1} value={semitones} onChange={event=>setSemitones(event.target.value)}/></label>}
    {mode==='diatonic'&&<><label>Signed diatonic steps<input type="number" min={-70} max={70} step={1} value={steps} onChange={event=>setSteps(event.target.value)}/></label><p className="muted">Uses each measure’s written major or natural-minor key. One step moves to the next scale degree.</p></>}
    {mode==='chromatic'&&<>
      <div className="pair"><label>Interval number<select value={number} onChange={event=>setNumber(Number(event.target.value))}>{numbers.map((name,index)=><option key={name} value={index+1}>{index+1} · {name}</option>)}</select></label><label>Interval quality<select value={quality} onChange={event=>setQuality(event.target.value as Quality)}><option value="perfect">Perfect</option><option value="major">Major</option><option value="minor">Minor</option><option value="augmented">Augmented</option><option value="diminished">Diminished</option></select></label></div>
      <div className="pair"><label>Interval direction<select value={direction} onChange={event=>setDirection(event.target.value as 'up'|'down')}><option value="up">Up</option><option value="down">Down</option></select></label><label>Extra octaves<input type="number" min={0} max={9} step={1} value={octaves} onChange={event=>setOctaves(event.target.value)}/></label></div>
    </>}
    <label><input type="checkbox" disabled={mode==='diatonic'} checked={includeKeys} onChange={event=>setIncludeKeys(event.target.checked)}/>Transpose key signatures</label>
    <label><input type="checkbox" disabled={mode==='diatonic'} checked={includeChords} onChange={event=>setIncludeChords(event.target.checked)}/>Transpose theory chords</label>
    <p className="muted">Key changes require complete measures across all tracks. Chord changes require every note in each selected beat.</p>
    {selection?<p className="muted" aria-label="Skipped chord references">{scope.skipped} manual or context-changed chord {scope.skipped===1?'reference':'references'} will be skipped.</p>:<p className="muted">Select music using Music selection to transpose harmony.</p>}
    {(scope.error||error)&&<p role="alert">{scope.error||error}</p>}
    <button type="button" disabled={!selection||!!scope.error} onClick={apply}>Transpose harmony</button>
  </fieldset></details>;
}
