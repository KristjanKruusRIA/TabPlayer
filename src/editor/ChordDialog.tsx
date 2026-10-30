import { useState } from 'react';
import type { ChordDefinition } from '../edit-types';
import { Dialog } from '../ui/Dialog';

export function ChordDialog({strings,value,onChange,onClose,disabled=false}: {strings:number;value:ChordDefinition|null;onChange:(chord:ChordDefinition|null)=>void;onClose:()=>void;disabled?:boolean}) {
  const [name,setName]=useState(value?.name??''),[firstFret,setFirstFret]=useState(value?.firstFret??1),[frets,setFrets]=useState(value?.frets??Array.from({length:strings},()=>-1));
  return <Dialog title="Chord diagram" onClose={onClose} className="chord-dialog" actions={<button type="button" className="tp-button" onClick={onClose}>Cancel</button>}><fieldset disabled={disabled}><label>Chord name<input data-autofocus value={name} onChange={e=>setName(e.target.value)}/></label><label>First fret<input type="number" min={0} value={firstFret} onChange={e=>setFirstFret(Number(e.target.value))}/></label><p className="muted">High to low strings: -1 mute, 0 open, positive fret.</p>{frets.map((fret,index)=><label key={index}>Diagram string {index+1}<input type="number" min={-1} max={127} value={fret} onChange={e=>setFrets(frets.map((f,i)=>i===index?Number(e.target.value):f))}/></label>)}<div className="pair"><button type="button" onClick={()=>{onChange({name,firstFret,frets});onClose();}}>Apply chord</button><button type="button" onClick={()=>{onChange(null);onClose();}}>Remove chord</button></div></fieldset></Dialog>;
}
