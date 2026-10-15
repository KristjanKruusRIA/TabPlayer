import { model,Settings } from '@coderline/alphatab';
import { allNotes,captureNoteLinks,restoreNoteLinks } from '../editor/links';
import { scoreFromJson } from '../model-clone';

const needsNormalization=(staff:model.Staff)=>!staff.isPercussion&&staff.tuning.length===0&&staff.transpositionPitch!==0;

/** GPIF stores display transposition but reimports pitched Octave/Tone literally.
 * Stringed and percussion transposition remain outside this conversion. */
export function preparePitchedGpScore(score:model.Score,settings:Settings):model.Score {
  if(!score.tracks.some(track=>track.staves.some(needsNormalization)))return score;
  const pitches=new Map(allNotes(score).filter(note=>needsNormalization(note.beat.voice.bar.staff)&&note.isPiano).map(note=>[note.id,note.calculateRealValue(true,false)]));
  const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),settings);
  if(score.backingTrack?.rawAudioFile){
    copy.backingTrack??=new model.BackingTrack();copy.backingTrack.rawAudioFile=score.backingTrack.rawAudioFile.slice();
  }
  restoreNoteLinks(copy,captureNoteLinks(score));
  for(const note of allNotes(copy)){
    const pitch=pitches.get(note.id);if(pitch===undefined)continue;
    note.octave=Math.floor(pitch/12);note.tone=pitch-note.octave*12;
  }
  for(const track of copy.tracks)for(const staff of track.staves)if(needsNormalization(staff))staff.transpositionPitch=0;
  return copy;
}
