import { useEffect, useRef, useState } from 'react';
import type { ChordDefinition } from '../edit-types';

export function ChordDialog({strings,value,onChange,onClose,disabled=false}: {strings:number;value:ChordDefinition|null;onChange:(chord:ChordDefinition|null)=>void;onClose:()=>void;disabled?:boolean}) {
  const [name,setName]=useState(value?.name??''),[firstFret,setFirstFret]=useState(value?.firstFret??1),[frets,setFrets]=useState(value?.frets??Array.from({length:strings},()=>-1));const input=useRef<HTMLInputElement>(null),previousFocus=useRef<HTMLElement|null>(null);
  useEffect(()=>{previousFocus.current=document.activeElement as HTMLElement;input.current?.focus();return()=>previousFocus.current?.focus();},[]);
  return <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="Chord diagram" className="chord-dialog" onKeyDown={e=>{
    if(e.key==='Escape'){e.stopPropagation();onClose();}
    if(e.key==='Tab'){const focusable=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)'));const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  }}><h2>Chord diagram</h2><fieldset disabled={disabled}><label>Chord name<input ref={input} value={name} onChange={e=>setName(e.target.value)}/></label><label>First fret<input type="number" min={0} value={firstFret} onChange={e=>setFirstFret(Number(e.target.value))}/></label><p className="muted">High to low strings: -1 mute, 0 open, positive fret.</p>{frets.map((fret,index)=><label key={index}>Diagram string {index+1}<input type="number" min={-1} max={127} value={fret} onChange={e=>setFrets(frets.map((f,i)=>i===index?Number(e.target.value):f))}/></label>)}<div className="pair"><button onClick={()=>{onChange({name,firstFret,frets});onClose();}}>Apply chord</button><button onClick={()=>{onChange(null);onClose();}}>Remove chord</button></div></fieldset><button onClick={onClose}>Cancel</button></section></div>;
}
