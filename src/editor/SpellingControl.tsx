import { useI18n } from '../i18n';
import { model } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';
import { busyGuard } from '../ui/useBusyGuard';
import { EnumInput } from './controls';
import { isNoteCautionary } from './cautionary';

export function SpellingControl({score,target,noteIndex,busy,onEdit}:{score:model.Score;target:BeatTarget;noteIndex:number;busy:boolean;onEdit:(edit:EditCommand)=>void}) {
  const { t } = useI18n();
  const staff=score.tracks[target.track]?.staves[target.staff],note=staff?.bars[target.bar]?.voices[target.voice]?.beats[target.beat]?.notes[noteIndex];
  const cautionary=note?isNoteCautionary(note):false,inactive=!note||staff?.isPercussion;
  // A click is one gesture and one edit; the box shows the stored mark, so a refused click leaves it as it was.
  const guard=busyGuard<HTMLInputElement>({busy,disabled:inactive,onClick:()=>onEdit({type:'setNoteCautionary',target,noteIndex,cautionary:!cautionary})});
  return <>
    <EnumInput label={t('editor.enharmonic_spelling')} value={note?.accidentalMode??model.NoteAccidentalMode.Default} enumeration={model.NoteAccidentalMode} disabled={inactive} busy={busy} onValue={accidentalMode=>onEdit({type:'setNoteSpelling',target,noteIndex,accidentalMode})}/>
    <label className="check">
      <input type="checkbox" aria-label={t('editor.cautionary_accidental')} checked={cautionary} readOnly {...guard}/>
      {t('editor.cautionary_accidental')}
    </label>
  </>;
}
