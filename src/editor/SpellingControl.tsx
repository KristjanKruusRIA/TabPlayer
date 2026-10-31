import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';
import { EnumInput } from './controls';
import { isNoteCautionary } from './cautionary';

export function SpellingControl({score,target,noteIndex,busy,onEdit}:{score:model.Score;target:BeatTarget;noteIndex:number;busy:boolean;onEdit:(edit:EditCommand)=>void}) {
  const staff=score.tracks[target.track]?.staves[target.staff],note=staff?.bars[target.bar]?.voices[target.voice]?.beats[target.beat]?.notes[noteIndex];
  const cautionary=note?isNoteCautionary(note):false,inactive=!note||staff?.isPercussion;
  return <>
    <EnumInput label="Enharmonic spelling" value={note?.accidentalMode??model.NoteAccidentalMode.Default} enumeration={model.NoteAccidentalMode} disabled={busy||inactive} onValue={accidentalMode=>onEdit({type:'setNoteSpelling',target,noteIndex,accidentalMode})}/>
    <label className="check">
      <input
        type="checkbox"
        aria-label="Cautionary accidental"
        aria-disabled={busy||undefined}
        disabled={inactive}
        checked={cautionary}
        onClick={e=>{if(busy)e.preventDefault();}}
        onChange={e=>{
          if(busy)return;
          const next=e.target.checked;
          if(next===cautionary)return;
          onEdit({type:'setNoteCautionary',target,noteIndex,cautionary:next});
        }}
      />
      Cautionary accidental
    </label>
  </>;
}
