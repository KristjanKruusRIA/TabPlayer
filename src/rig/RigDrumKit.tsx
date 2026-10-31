import { useEffect, useId, useRef, useState } from 'react';
import { busySelect } from '../ui';
import { drumKitFor, drumKits, kitDifferences, sharedSounds } from '../editor/drum-kits';
import type { SoundEditing } from '../audio/useSoundEditing';

/** The drum kit of a drum track, in the rig's head: a labelled select and a `?` button whose popover lists which hits differ between kits.
 * Choosing is `editing.setDrumKit`, one undoable `setTrackSound` edit; the select stays focusable while busy (`busySelect`).
 * The popover hangs under its button inside the kit's own box, and closes on Escape wherever focus is (clicking its text leaves focus on the page),
 * on a press outside it, and when focus moves outside it. The inspector keeps `DrumKitPicker`. */
export function RigDrumKit({editing}:{editing:SoundEditing}) {
  const {current,busy}=editing,kit=drumKitFor(current.drumKit);
  const note=kit.changes.length?`${kit.label} changes ${kitDifferences(kit).join(', ')}.`:'Standard is the reference kit.';
  const [open,setOpen]=useState(false),root=useRef<HTMLElement>(null),button=useRef<HTMLButtonElement>(null),ids=useId();
  useEffect(()=>{
    if(!open)return;
    const escape=(event:KeyboardEvent)=>{if(event.key!=='Escape')return;event.preventDefault();event.stopPropagation();setOpen(false);button.current?.focus();};
    const away=(event:Event)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('keydown',escape,true);document.addEventListener('pointerdown',away,true);document.addEventListener('focusin',away,true);
    return()=>{document.removeEventListener('keydown',escape,true);document.removeEventListener('pointerdown',away,true);document.removeEventListener('focusin',away,true);};
  },[open]);
  return <section ref={root} className="rig-drum-kit" aria-label="Drum kit settings">
    <label className="rig-kit-label"><span className="rig-kit-name">Drum kit</span><select className="rig-select" aria-describedby={`${ids}-note`} title={note} value={kit.program} {...busySelect(busy)} onChange={event=>{void editing.setDrumKit(Number(event.target.value));}}>{drumKits.map(option=><option key={option.program} value={option.program}>{option.label}</option>)}</select></label>
    <p id={`${ids}-note`} className="rig-visually-hidden">{note}</p>
    <button ref={button} type="button" className="rig-kit-help" aria-expanded={open} aria-controls={`${ids}-table`} aria-label="Which hits differ" title="Which hits differ" onClick={()=>setOpen(value=>!value)}>?</button>
    {open&&<div id={`${ids}-table`} className="rig-kit-table" role="group" aria-label="Which hits differ between kits">
      <p className="rig-note">Every drum key has its own sound. Room and Jazz replay Standard's samples at other pitches; Brush changes the snare and electric snare.</p>
      <ul>{drumKits.filter(option=>option.changes.length).map(option=><li key={option.program}><strong>{option.label}</strong>: {kitDifferences(option).join(', ')}</li>)}</ul>
      <p className="rig-note">These notations play the same sound, so they differ on the page only (the bank has no separate rim shot, choke or half-open sample):</p>
      <ul>{sharedSounds().map(group=><li key={group.key}>{group.labels.join(' = ')}</li>)}</ul>
    </div>}
  </section>;
}
