import { busySelect } from '../ui';
import { drumKitFor, drumKits, kitDifferences, sharedSounds } from '../editor/drum-kits';
import type { SoundEditing } from './useSoundEditing';

/** The drum kit of a drum track, shared by the inspector's Sound task and the rig. Only kits the sound bank really carries are offered; a choice is
 * `editing.setDrumKit`, one undoable `setTrackSound` edit. The select stays focusable while busy (`busySelect`). */
export function DrumKitPicker({editing,className}:{editing:SoundEditing;className?:string}) {
  const {current,busy}=editing,kit=drumKitFor(current.drumKit);
  return <section className={className} aria-label="Drum kit settings">
    <label>Drum kit<select value={kit.program} {...busySelect(busy)} onChange={e=>{void editing.setDrumKit(Number(e.target.value));}}>{drumKits.map(option=><option key={option.program} value={option.program}>{option.label}</option>)}</select></label>
    <p className="muted">{kit.changes.length?`${kit.label} changes ${kitDifferences(kit).join(', ')}.`:'Standard is the reference kit.'}</p>
    <details><summary>Which drum hits sound different</summary>
      <p className="muted">Every drum key has its own sound. Room and Jazz replay Standard's samples at other pitches; Brush changes the snare and electric snare.</p>
      <ul>{drumKits.filter(option=>option.changes.length).map(option=><li key={option.program}><strong>{option.label}</strong>: {kitDifferences(option).join(', ')}</li>)}</ul>
      <p className="muted">These notations play the same sound, so they differ on the page only (the bank has no separate rim shot, choke or half-open sample):</p>
      <ul>{sharedSounds().map(group=><li key={group.key}>{group.labels.join(' = ')}</li>)}</ul>
    </details>
  </section>;
}
