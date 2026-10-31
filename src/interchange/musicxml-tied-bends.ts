import { model,type Settings } from '@coderline/alphatab';
import { readMusicXmlSource } from './musicxml-tempo-offsets';

// A MusicXML bend is timed within its own note, and a tied note without <bend>
// keeps the pitch its tie carries. alphaTab 1.8.4 leaves such a note without bend
// points, so its playback stretches the origin's bend over the whole tie chain.
// This gives each one the hold a Guitar Pro tie carries.
// A tied note with its own <bend> bends from that carried pitch, but alphaTab starts
// its curve at 0 (or at the depth of a first release); the curve is shifted up to it.
const carried=(note:model.Note)=>[...note.bendPoints??[]].sort((a,b)=>a.offset-b.offset).pop()?.value??0;
// alphaTab already plays a tied note's own vibrato around the carried pitch; a hold would mute it.
const unbent=(note:model.Note)=>note.isTieDestination&&!note.hasBend&&!!note.tieOrigin?.hasBend&&note.vibrato===model.VibratoType.None;
const continued=(note:model.Note)=>note.isTieDestination&&note.hasBend&&!!note.tieOrigin?.hasBend;

// Whether every bend reads as a change from the pitch before it. alphaTab takes the size of
// a negative bend that is neither a release nor a pre-bend, and a pre-bend on a tied note
// has no pitch before it. TuxGuitar writes absolute values (a release to 0.0), not changes.
function shiftable(xml:string){
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror')||[...doc.getElementsByTagName('*')].some(node=>node.prefix!==null||node.namespaceURI!==null))return false;
  if([...doc.getElementsByTagName('software')].some(node=>/tuxguitar/i.test(node.textContent??'')))return false;
  for(const note of doc.getElementsByTagName('note')){
    const stop=[...note.getElementsByTagName('tied'),...note.getElementsByTagName('tie')].some(tie=>tie.getAttribute('type')==='stop');
    for(const bend of note.getElementsByTagName('bend')){
      const alter=Number.parseFloat(bend.getElementsByTagName('bend-alter')[0]?.textContent??'');
      const release=bend.getElementsByTagName('release').length>0,pre=bend.getElementsByTagName('pre-bend').length>0;
      if(Number.isNaN(alter)||(alter===0&&release))return false;
      if(alter<0&&!release&&!pre)return false;
      if(stop&&pre)return false;
    }
  }
  return true;
}

// Note.finish classified a note tied after a hold this pass added as not continued.
const continuedTypes=new Map([[model.BendType.Prebend,model.BendType.Hold],[model.BendType.PrebendBend,model.BendType.Bend],[model.BendType.PrebendRelease,model.BendType.Release]]);

export function applyMusicXmlTiedBends(score:model.Score,bytes:Uint8Array,settings:Settings):model.Score {
  const notes=score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)))));
  // Cheap structural gate before any source read.
  if(!notes.some(note=>unbent(note)||continued(note)))return score;
  let xml:string;
  try {
    const source=readMusicXmlSource(bytes,settings);
    if(!source||!source.xml.includes('bend'))return score;
    xml=source.xml;
  } catch {
    return score;
  }
  let shift=false;
  try { shift=shiftable(xml); } catch { shift=false; }
  // Score order visits each tie origin first, so a held chain carries the pitch on.
  for(const note of notes){
    if(shift&&continued(note)){
      // In place, so maxBendPoint stays the highest; an even shift keeps Note.finish's bend type.
      const points=note.bendPoints!,by=carried(note.tieOrigin!)-[...points].sort((a,b)=>a.offset-b.offset)[0].value;
      if(!points.every(point=>point.value+by>=0))continue;
      for(const point of points)point.value+=by;
      if(!note.isContinuedBend){note.isContinuedBend=true;note.bendType=continuedTypes.get(note.bendType)??note.bendType;}
      note.bendOrigin=note.tieOrigin;
      // As Note.finish does for a note that starts bent.
      if(note.initialBendValue>0)note.accidentalMode=model.NoteAccidentalMode.Default;
      continue;
    }
    if(!unbent(note))continue;
    const value=carried(note.tieOrigin!);
    note.addBendPoint(new model.BendPoint(0,value));note.addBendPoint(new model.BendPoint(model.BendPoint.MaxPosition,value));
    note.bendType=model.BendType.Hold;note.isContinuedBend=true;note.bendOrigin=note.tieOrigin;
  }
  return score;
}
