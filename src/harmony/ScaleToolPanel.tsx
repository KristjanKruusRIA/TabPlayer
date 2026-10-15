import { useEffect,useRef,useState,type KeyboardEvent } from 'react';
import type { HarmonyChord,ScaleToolPanelProps } from '../editor/harmony-types';
import { resolveSelectionNotes } from '../editor/range-selection';
import { matchScales,scalePatterns,scalePitches } from './scales';
import { harmonyPitchName,soundingChordPitches } from './ChordDiagramPreview';

const roots=['C','C# / Db','D','D# / Eb','E','F','F# / Gb','G','G# / Ab','A','A# / Bb','B'];
export function ScaleToolPanel({score,staff:currentStaff,selection,busy,onClose}:ScaleToolPanelProps) {
  const [root,setRoot]=useState(0),[pattern,setPattern]=useState('major'),[search,setSearch]=useState(''),[tag,setTag]=useState(''),[custom,setCustom]=useState('0, 2, 4, 5, 7, 9, 11');
  const first=useRef<HTMLSelectElement>(null),close=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const opener=document.activeElement;first.current?.focus();return()=>{if(opener instanceof HTMLElement&&opener.isConnected)opener.focus();};},[]);
  useEffect(()=>{if(busy)close.current?.focus();},[busy]);
  function keyDown(event:KeyboardEvent<HTMLElement>){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}if(event.key!=='Tab')return;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)')),start=controls[0],end=controls.at(-1);
    if(event.shiftKey&&document.activeElement===start){event.preventDefault();end?.focus();}else if(!event.shiftKey&&document.activeElement===end){event.preventDefault();start?.focus();}
  }
  const filtered=scalePatterns.filter(value=>(!tag||value.tags.includes(tag))&&`${value.name} ${value.tags.join(' ')}`.toLowerCase().includes(search.trim().toLowerCase())),active=pattern==='custom'?null:filtered.find(value=>value.id===pattern)??filtered[0];
  const intervals=active?[...active.intervals]:custom.trim().split(/[\s,]+/).filter(Boolean).map(Number);let pitches:number[]=[],error='';
  try{pitches=scalePitches(root,intervals,5);}catch(cause){error=cause instanceof Error?cause.message:String(cause);}
  let selected:ReturnType<typeof resolveSelectionNotes>=[];
  try{if(selection)selected=resolveSelectionNotes(score,selection).filter(note=>!note.beat.voice.bar.staff.isPercussion&&!note.isPercussion&&!note.isDead);}catch(cause){error ||= cause instanceof Error?cause.message:String(cause);}
  let matches:ReturnType<typeof matchScales>=[];try{matches=matchScales(selected.map(note=>note.realValue));}catch(cause){error ||= cause instanceof Error?cause.message:String(cause);}
  const staff=currentStaff??selected[0]?.beat.voice.bar.staff??score.tracks.flatMap(track=>track.staves).find(staff=>!staff.isPercussion),classes=new Set(pitches.map(pitch=>pitch%12));
  const open:HarmonyChord={name:'Scale',nameMode:'manual',recipe:null,firstFret:1,frets:staff?.tuning.map(()=>0)??[],fingers:staff?.tuning.map(()=>-2)??[],barreFrets:[],showName:false,showDiagram:true,showFingering:false};
  const fretPitches=staff?Array.from({length:13},(_,fret)=>soundingChordPitches({...open,frets:staff.tuning.map(()=>fret)},staff)):[],openPitches=fretPitches[0]??[];
  return <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="Scale browser" className="chord-dialog" onKeyDown={keyDown}><h2>Scale browser</h2><fieldset disabled={busy}>
    <label>Scale root<select ref={first} value={root} onChange={e=>setRoot(Number(e.target.value))}>{roots.map((name,index)=><option key={name} value={index}>{name}</option>)}</select></label>
    <label>Search scales<input value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <label>Scale tag<select value={tag} onChange={e=>setTag(e.target.value)}><option value="">All tags</option>{[...new Set(scalePatterns.flatMap(value=>value.tags))].map(value=><option key={value} value={value}>{value}</option>)}</select></label>
    <label>Scale pattern<select value={active?.id??'custom'} onChange={e=>setPattern(e.target.value)}>{filtered.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}<option value="custom">Custom intervals</option></select></label>
    {!filtered.length&&<p className="muted">No catalog scales match this search.</p>}
    {!active&&<label>Custom intervals<input value={custom} onChange={e=>setCustom(e.target.value)} placeholder="Sorted semitones including 0"/></label>}
    <p className="muted">Sixteen named patterns · all twelve roots. Notes and passage matches use sounding pitches, including capo and sounding offset.</p>
    {error&&<p role="alert">{error}</p>}
    {pitches.length>0&&<>
      <p aria-label="Scale notes">{pitches.map(harmonyPitchName).join(' ')}</p>
      <p aria-label="Scale degrees">Degrees: {pitches.map((_,index)=>index+1).join(' ')}</p>
      <p aria-label="Adjacent semitones">Adjacent semitones: {intervals.map((value,index)=>(intervals[index+1]??12)-value).join(' ')}</p>
      {staff&&staff.tuning.length>0?<svg role="img" aria-label="Scale fretboard" viewBox={`0 0 520 ${staff.tuning.length*30+35}`} style={{width:'100%',background:'#1d2530'}}>
        <title>Sounding scale tones on the current staff, frets 0 through 12</title>
        {Array.from({length:13},(_,fret)=><g key={fret}><line x1={70+fret*34} x2={70+fret*34} y1={23} y2={staff.tuning.length*30+15} stroke="#465363"/><text x={70+fret*34} y={13} fill="#97a6b6" fontSize={10} textAnchor="middle">{fret}</text></g>)}
        {openPitches.map((open,index)=><g key={index}><text x={3} y={40+index*30} fill="#fffdf8" fontSize={10}>{open===null?'?':harmonyPitchName(open)}</text><line x1={60} x2={490} y1={36+index*30} y2={36+index*30} stroke="#97a6b6"/>{Array.from({length:13},(_,fret)=>{const pitch=fretPitches[fret][index];if(pitch===null||!classes.has(pitch%12))return null;return <g key={fret} aria-label={`String ${index+1} fret ${fret}: ${harmonyPitchName(pitch)}${pitch%12===root?', root':''}`}><circle cx={70+fret*34} cy={36+index*30} r={10} fill={pitch%12===root?'#b5df73':'#fffdf8'}/><text x={70+fret*34} y={40+index*30} textAnchor="middle" fill="#161c24" fontSize={8}>{harmonyPitchName(pitch).replace(/-?\d+$/,'')}</text></g>;})}</g>)}
      </svg>:<svg role="img" aria-label="Scale keyboard" viewBox="0 0 480 100" style={{width:'100%'}}><title>Scale tones from C4 through B5</title>{Array.from({length:24},(_,index)=>{const pitch=60+index,black=[1,3,6,8,10].includes(pitch%12),active=classes.has(pitch%12);return <g key={pitch}><rect x={index*20} y={0} width={19} height={black?65:95} fill={active?(pitch%12===root?'#b5df73':'#d0d4dc'):(black?'#161c24':'#fffdf8')} stroke="#465363"/>{active&&<text x={index*20+9} y={black?55:85} fill="#161c24" fontSize={7} textAnchor="middle">{harmonyPitchName(pitch).replace(/-?\d+$/,'')}</text>}</g>;})}</svg>}
    </>}
    <details><summary>Selected passage matches</summary>{matches.length===0?<p>Select melodic notes to match scales.</p>:<><p className="muted">Distinct selected classes; fewer extra scale tones rank first after matched classes.</p><ol>{matches.map(match=><li key={`${match.patternId}/${match.root}`}><button type="button" onClick={()=>{setRoot(match.root);setPattern(match.patternId);setSearch('');setTag('');}}>{roots[match.root].split(' / ')[0]} {scalePatterns.find(pattern=>pattern.id===match.patternId)!.name}: {match.matched} / {match.total} selected classes, {match.extra} extra tones</button></li>)}</ol></>}</details>
  </fieldset><button ref={close} type="button" onClick={onClose}>Close scales</button></section></div>;
}
