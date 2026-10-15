import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';
import { EnumInput } from './controls';

export function SpellingControl({score,target,noteIndex,busy,onEdit}:{score:model.Score;target:BeatTarget;noteIndex:number;busy:boolean;onEdit:(edit:EditCommand)=>void}) {
  const staff=score.tracks[target.track]?.staves[target.staff],note=staff?.bars[target.bar]?.voices[target.voice]?.beats[target.beat]?.notes[noteIndex];
  return <EnumInput label="Enharmonic spelling" value={note?.accidentalMode??model.NoteAccidentalMode.Default} enumeration={model.NoteAccidentalMode} disabled={busy||!note||staff?.isPercussion} onValue={accidentalMode=>onEdit({type:'setNoteSpelling',target,noteIndex,accidentalMode})}/>;
}
