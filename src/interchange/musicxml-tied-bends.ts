import { model,type Settings } from '@coderline/alphatab';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// A MusicXML bend is timed within its own note, and a tied note without <bend>
// keeps the pitch its tie carries. alphaTab 1.8.4 leaves such a note without bend
// points, so its playback stretches the origin's bend over the whole tie chain.
// This gives each one the hold a Guitar Pro tie carries.
const carried=(note:model.Note)=>[...note.bendPoints??[]].sort((a,b)=>a.offset-b.offset).pop()?.value??0;
// alphaTab already plays a tied note's own vibrato around the carried pitch; a hold would mute it.
const unbent=(note:model.Note)=>note.isTieDestination&&!note.hasBend&&!!note.tieOrigin?.hasBend&&note.vibrato===model.VibratoType.None;

export function applyMusicXmlTiedBends(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  const notes=score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)))));
  // Cheap structural gate before any source read.
  if(!notes.some(unbent))return score;
  try {
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!source.xml.includes('bend'))return score;
  } catch {
    return score;
  }
  // Score order visits each tie origin first, so a held chain carries the pitch on.
  for(const note of notes){
    if(!unbent(note))continue;
    const value=carried(note.tieOrigin!);
    note.addBendPoint(new model.BendPoint(0,value));note.addBendPoint(new model.BendPoint(model.BendPoint.MaxPosition,value));
    note.bendType=model.BendType.Hold;note.isContinuedBend=true;note.bendOrigin=note.tieOrigin;
  }
  return score;
}
