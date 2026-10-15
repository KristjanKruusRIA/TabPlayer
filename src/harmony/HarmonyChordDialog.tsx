import { useEffect,useRef,useState,type KeyboardEvent } from 'react';
import { model } from '@coderline/alphatab';
import type { ChordDegree,ChordFormulaId,ChordRecipe,HarmonyChord,HarmonyChordDialogProps,HarmonyCommand } from '../editor/harmony-types';
import { resolveSelectionNotes } from '../editor/range-selection';
import { chordTones,findChordShapes,formatChordName,recognizeChords } from './chords';
import { getHarmonyChord,setHarmonyChordSource } from './chord-source';
import { createHarmonyLibraryEntry,recallHarmonyLibraryEntry } from './library';
import { ChordDiagramPreview,soundingChordPitches } from './ChordDiagramPreview';

const newRecipe=():ChordRecipe=>({root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null});
const formulas:ReadonlyArray<readonly [ChordFormulaId,string]>=[['major','Major'],['minor','Minor'],['dim','Diminished'],['aug','Augmented'],['sus2','Suspended 2'],['sus4','Suspended 4'],['power','Power'],['6','Major 6'],['m6','Minor 6'],['7','Dominant 7'],['maj7','Major 7'],['m7','Minor 7'],['mMaj7','Minor major 7'],['m7b5','Half diminished'],['dim7','Diminished 7'],['9','Dominant 9'],['maj9','Major 9'],['m9','Minor 9'],['11','Dominant 11'],['m11','Minor 11'],['13','Dominant 13'],['7sus4','Suspended dominant 7']];
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);
function effective(value:HarmonyChord,staff:model.Staff):HarmonyChord {
  const chord=new model.Chord();setHarmonyChordSource(chord,value);Object.assign(chord,{staff,name:value.name,firstFret:value.firstFret,strings:[...value.frets],barreFrets:[...value.barreFrets],showName:value.showName,showDiagram:value.showDiagram,showFingering:value.showFingering});return getHarmonyChord(chord);
}
function initial(value:HarmonyChord|null,staff:model.Staff):HarmonyChord {
  return value?effective(value,staff):{name:'C',nameMode:'theory',recipe:newRecipe(),firstFret:1,frets:staff.tuning.map(()=>-1),fingers:staff.tuning.map(()=>-2),barreFrets:[],showName:true,showDiagram:true,showFingering:true};
}
export function HarmonyChordDialog({score,target,selection,value,busy,library,onEdit,onClose,onLibraryPut,onLibraryRemove}:HarmonyChordDialogProps) {
  const staff=score.tracks[target.track].staves[target.staff],beat=staff.bars[target.bar].voices[target.voice].beats[target.beat];
  const [draft,setDraft]=useState(()=>initial(value,staff)),[recipe,setRecipe]=useState(()=>draft.recipe??newRecipe()),[barres,setBarres]=useState(()=>draft.barreFrets.join(', ')),[text,setText]=useState(beat.text??'');
  const [shapes,setShapes]=useState<HarmonyChord[]>([]),[fill,setFill]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState(false),[libraryId,setLibraryId]=useState(''),[libraryLabel,setLibraryLabel]=useState(''),[status,setStatus]=useState('');
  const preservedShape=useRef(JSON.stringify([draft.frets,draft.barreFrets]));
  const nameInput=useRef<HTMLInputElement>(null),cancel=useRef<HTMLButtonElement>(null),contextKey=JSON.stringify([target,staff.tuning,staff.capo,staff.transpositionPitch]),valueKey=JSON.stringify(value);
  const install=(next:HarmonyChord)=>{preservedShape.current=JSON.stringify([next.frets,next.barreFrets]);setDraft(structuredClone(next));setRecipe(next.recipe?structuredClone(next.recipe):newRecipe());setBarres(next.barreFrets.join(', '));setShapes([]);setError('');};
  useEffect(()=>{install(initial(value,staff));setText(beat.text??'');setFill(false);setStatus('');},[score,contextKey,valueKey]);
  useEffect(()=>{const opener=document.activeElement;nameInput.current?.focus();return()=>{if(opener instanceof HTMLElement&&opener.isConnected)opener.focus();};},[]);
  useEffect(()=>{if(busy||pending)cancel.current?.focus();},[busy,pending]);
  function keyDown(event:KeyboardEvent<HTMLElement>){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
    if(event.key!=='Tab')return;const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)')),first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
  function updateRecipe(next:ChordRecipe){
    setRecipe(next);setShapes([]);try{const name=formatChordName(next);setDraft({...draft,name,nameMode:'theory',recipe:structuredClone(next)});setError('');}catch(cause){setError(message(cause));}
  }
  function updateFret(index:number,fret:number){
    const next={...draft,frets:draft.frets.map((value,i)=>i===index?fret:value),fingers:draft.fingers.map((value,i)=>i===index&&fret<=0&&draft.frets[index]!==fret?-2:value)};
    try{setDraft(effective(next,staff));setError('');}catch(cause){setDraft(next);setError(message(cause));}
  }
  function prepared():HarmonyChord {
    const entries=barres.trim()?barres.split(',').map(value=>value.trim()):[];if(entries.some(value=>!value))throw new Error('Enter comma-separated whole barre frets.');
    const next={...structuredClone(draft),barreFrets:entries.map(Number)};
    if(next.frets.length!==staff.tuning.length)throw new Error('Use one position for each current staff string.');
    if(JSON.stringify([next.frets,next.barreFrets])!==preservedShape.current){
      if(new Set(next.barreFrets).size!==next.barreFrets.length||next.barreFrets.some(fret=>!Number.isInteger(fret)||fret<=0||fret>127))throw new Error('Edited barres must use positive unique fret numbers.');
      for(const fret of next.barreFrets){const positions=next.frets.flatMap((value,index)=>value===fret?[index]:[]);if(positions.length<2||next.frets.slice(positions[0],positions.at(-1)!+1).some(value=>value<fret))throw new Error('Each edited barre must join at least two strings at that fret without crossing an open, muted or lower-fretted string.');}
    }
    if(next.nameMode==='theory'){chordTones(recipe);next.recipe=structuredClone(recipe);next.name=formatChordName(recipe);}
    const snapshot=effective(next,staff);if(next.nameMode==='theory'&&snapshot.nameMode!=='theory')throw new Error('Choose a shape containing exactly the formula tones and bass, or use a manual name.');return snapshot;
  }
  function submit(command:HarmonyCommand){try{onEdit(command);setError('');onClose();}catch(cause){setError(message(cause));}}
  function apply(){try{submit({type:'setHarmonyChord',target:{...target},chord:prepared(),fillEmptyBeat:fill});}catch(cause){setError(message(cause));}}
  let analysisError='';
  const pitches=selection?(()=>{try{return resolveSelectionNotes(score,selection).filter(note=>!note.beat.voice.bar.staff.isPercussion&&!note.isPercussion&&!note.isDead).map(note=>note.realValue);}catch(cause){analysisError=message(cause);return [];}})():soundingChordPitches(draft,staff).filter((pitch):pitch is number=>pitch!==null);
  let matches:ReturnType<typeof recognizeChords>=[];try{matches=recognizeChords(pitches,recipe.root);}catch(cause){analysisError=message(cause);}
  const trackChords=score.tracks[target.track].staves.flatMap(source=>[...source.chords??[]].map(([id,chord])=>({id:JSON.stringify([source.index,id]),source,chord})));
  const accidentals=<>{[-2,-1,0,1,2].map(value=><option key={value} value={value}>{value===0?'Natural':value===-2?'Double flat':value===-1?'Flat':value===1?'Sharp':'Double sharp'}</option>)}</>;
  return <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="Harmony chord" className="chord-dialog" onKeyDown={keyDown}><h2>Harmony chord</h2><fieldset disabled={busy||pending}>
    <label>Chord name<input ref={nameInput} value={draft.name} onChange={e=>{setDraft({...draft,name:e.target.value.replace(/^['‘’]/,''),nameMode:'manual',recipe:null});setError('');}}/></label>
    <label>Name mode<select value={draft.nameMode} onChange={e=>e.target.value==='theory'?updateRecipe(recipe):setDraft({...draft,nameMode:'manual',recipe:null})}><option value="theory">Theory</option><option value="manual">Manual</option></select></label>
    <p className="muted">Sounding chord analysis includes this staff's tuning, capo and sounding offset. A leading apostrophe selects a manual name.</p>
    <details open><summary>Formula</summary><fieldset>
      <div className="pair"><label>Root letter<select value={recipe.root.step} onChange={e=>updateRecipe({...recipe,root:{...recipe.root,step:Number(e.target.value)}})}>{[...'CDEFGAB'].map((name,index)=><option key={name} value={index}>{name}</option>)}</select></label><label>Root accidental<select value={recipe.root.alteration} onChange={e=>updateRecipe({...recipe,root:{...recipe.root,alteration:Number(e.target.value)}})}>{accidentals}</select></label></div>
      <label>Formula<select value={recipe.formula} onChange={e=>updateRecipe({...recipe,formula:e.target.value as ChordFormulaId})}>{formulas.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
      <div className="technique-grid">{([5,9,11,13] as const).map(degree=><label key={degree}>Alter degree {degree}<select value={recipe.alterations.find(value=>value.degree===degree)?.shift??0} onChange={e=>updateRecipe({...recipe,alterations:[...recipe.alterations.filter(value=>value.degree!==degree),...Number(e.target.value)===0?[]:[{degree,shift:Number(e.target.value) as -1|1}]]})}><option value={0}>Unchanged</option><option value={-1}>Flat</option><option value={1}>Sharp</option></select></label>)}</div>
      <div className="technique-grid">{([1,2,3,4,5,6,7,9,11,13] as ChordDegree[]).map(degree=><label className="check" key={degree}><input type="checkbox" checked={recipe.omissions.includes(degree)} onChange={e=>updateRecipe({...recipe,omissions:e.target.checked?[...recipe.omissions,degree]:recipe.omissions.filter(value=>value!==degree)})}/>Omit degree {degree}</label>)}</div>
      <label className="check"><input type="checkbox" checked={recipe.bass!==null} onChange={e=>updateRecipe({...recipe,bass:e.target.checked?{step:0,alteration:0}:null})}/>Slash bass</label>
      {recipe.bass&&<div className="pair"><label>Bass letter<select value={recipe.bass.step} onChange={e=>updateRecipe({...recipe,bass:{...recipe.bass!,step:Number(e.target.value)}})}>{[...'CDEFGAB'].map((name,index)=><option key={name} value={index}>{name}</option>)}</select></label><label>Bass accidental<select value={recipe.bass.alteration} onChange={e=>updateRecipe({...recipe,bass:{...recipe.bass!,alteration:Number(e.target.value)}})}>{accidentals}</select></label></div>}
      <button type="button" onClick={()=>{try{const found=findChordShapes(staff,recipe,{maxFret:24,maxSpan:4,limit:12});setShapes(found);setError(found.length?'':'No shapes found in frets 0–24 with a four-fret span.');}catch(cause){setError(message(cause));}}}>Generate shapes</button>
      {shapes.map((shape,index)=><button type="button" key={index} aria-label={`Use shape ${index+1}`} onClick={()=>{setDraft(structuredClone(shape));setBarres(shape.barreFrets.join(', '));setError('');}}>Shape {index+1}: {shape.frets.join(', ')}</button>)}
      {matches.length>0&&<div aria-label="Recognized chords"><p className="muted">Exact sounding pitch-class matches</p>{matches.map((match,index)=><button type="button" key={index} onClick={()=>updateRecipe(match.recipe)}>Use recognized {match.name}</button>)}</div>}
    </fieldset></details>
    <ChordDiagramPreview chord={draft} staff={staff} highlightRoot onToggle={busy||pending?null:updateFret}/>
    <details><summary>Shape and display</summary><fieldset>
      <label>First fret<input type="number" min={0} max={127} value={draft.firstFret} onChange={e=>setDraft({...draft,firstFret:Number(e.target.value)})}/></label>
      {draft.frets.map((fret,index)=><fieldset key={index}><legend>String {index+1}</legend><div className="pair"><label>String {index+1} fret<input type="number" min={-1} max={127} value={fret} onChange={e=>updateFret(index,Number(e.target.value))}/></label><label>String {index+1} finger<select value={draft.fingers[index]} onChange={e=>setDraft({...draft,fingers:draft.fingers.map((value,i)=>i===index?Number(e.target.value):value)})}>{[[-2,'Unknown'],[-1,'None / dead'],[0,'Thumb'],[1,'1'],[2,'2'],[3,'3'],[4,'4']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div><div className="pair"><button type="button" onClick={()=>updateFret(index,-1)}>Mute string {index+1}</button><button type="button" onClick={()=>updateFret(index,0)}>Open string {index+1}</button></div></fieldset>)}
      <label>Barre frets<input value={barres} onChange={e=>setBarres(e.target.value)} placeholder="Comma-separated absolute frets"/></label>
      {(['showName','showDiagram','showFingering'] as const).map((key,index)=><label className="check" key={key}><input type="checkbox" checked={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.checked})}/>{['Show name','Show diagram','Show fingering'][index]}</label>)}
    </fieldset></details>
    {beat.notes.length===0&&<label className="check"><input type="checkbox" checked={fill} onChange={e=>setFill(e.target.checked)}/>Fill empty beat with diagram notes</label>}
    <details><summary>Chord library</summary><fieldset>
      <label>Track chord<select defaultValue="" onChange={e=>{const entry=trackChords.find(value=>value.id===e.target.value);if(!entry)return;try{install(recallHarmonyLibraryEntry(createHarmonyLibraryEntry(crypto.randomUUID(),entry.chord.name||'Track chord',getHarmonyChord(entry.chord),entry.source),staff));}catch(cause){setError(message(cause));}}}><option value="">Choose a track chord</option>{trackChords.map(entry=><option key={entry.id} value={entry.id}>{entry.chord.name||'Unnamed'} · staff {entry.source.index+1}</option>)}</select></label>
      <label>Personal chord<select value={libraryId} onChange={e=>setLibraryId(e.target.value)}><option value="">Choose a saved chord</option>{library.entries.map(entry=><option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
      <button type="button" disabled={!libraryId} onClick={()=>{const entry=library.entries.find(value=>value.id===libraryId);if(!entry)return;try{install(recallHarmonyLibraryEntry(entry,staff));}catch(cause){setError(message(cause));}}}>Recall library chord</button>
      <label>Library label<input value={libraryLabel} onChange={e=>setLibraryLabel(e.target.value)} maxLength={400}/></label>
      <button type="button" onClick={async()=>{try{const entry=createHarmonyLibraryEntry(crypto.randomUUID(),libraryLabel,prepared(),staff);setPending(true);await onLibraryPut(entry);setStatus('Saved to library.');setError('');}catch(cause){setError(message(cause));}finally{setPending(false);}}}>Save to library</button>
      <button type="button" disabled={!libraryId} onClick={async()=>{try{setPending(true);await onLibraryRemove(libraryId);setLibraryId('');setStatus('Removed from library.');setError('');}catch(cause){setError(message(cause));}finally{setPending(false);}}}>Delete library chord</button>
    </fieldset></details>
    <label>Beat text<input value={text} onChange={e=>setText(e.target.value)}/></label><button type="button" onClick={()=>submit({type:'setBeatText',target:{...target},text})}>Apply beat text</button>
    {(error||analysisError)&&<p role="alert">{error||analysisError}</p>}{status&&<p role="status">{status}</p>}
    <div className="pair"><button type="button" className="primary" onClick={apply}>Apply chord</button><button type="button" onClick={()=>submit({type:'setHarmonyChord',target:{...target},chord:null,fillEmptyBeat:false})}>Remove chord</button></div>
  </fieldset><button ref={cancel} type="button" onClick={onClose}>Cancel</button></section></div>;
}
