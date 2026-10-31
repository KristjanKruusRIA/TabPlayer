import { model } from '@coderline/alphatab';
import { integer } from './common';
import { planFingering } from './fingering';
import { detachNote } from './links';
import { resolvePercussionArticulation,standardPercussionCatalog } from './percussion-catalog';

function pitch(value:number) {if(!integer(value,0,127))throw new Error('The converted pitch is outside the playable MIDI range.');}
function candidate(note:model.Note,staff:model.Staff,proposal:Partial<model.Note>={}) {
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat(),result=new model.Note();bar.staff=staff;voice.bar=bar;beat.voice=voice;result.beat=beat;
  for(const key of ['string','fret','octave','tone','percussionArticulation','harmonicType','harmonicValue'] as const)result[key]=note[key];
  Object.assign(result,proposal);return result;
}
function noteTechnique(note:model.Note) {
  return note.isHarmonic||note.hasBend||note.isContinuedBend||!!note.bendOrigin||note.slideInType!==model.SlideInType.None||note.slideOutType!==model.SlideOutType.None||!!note.slideOrigin||!!note.slideTarget||note.isHammerPullOrigin||!!note.hammerPullOrigin||!!note.hammerPullDestination||note.isLeftHandTapped||note.isPalmMute||note.isLetRing||note.isDead||note.showStringNumber||note.vibrato!==model.VibratoType.None;
}
function beatTechnique(beat:model.Beat) {
  return beat.hasRasgueado||beat.pop||beat.slap||beat.tap||beat.deadSlapped||beat.brushType!==model.BrushType.None||beat.pickStroke!==model.PickStroke.None||beat.hasWhammyBar||beat.whammyBarType!==model.WhammyType.None||beat.isContinuedWhammy||beat.vibrato!==model.VibratoType.None||beat.isBarre||beat.golpe!==model.GolpeType.None||beat.wahPedal!==model.WahPedal.None;
}
const articulationKeys=['id','elementType','staffLine','noteHeadDefault','noteHeadHalf','noteHeadWhole','techniqueSymbol','techniqueSymbolPlacement','outputMidiNumber'] as const;
const sameArticulation=(a:model.InstrumentArticulation,b:model.InstrumentArticulation)=>articulationKeys.every(key=>a[key]===b[key]);
function cloneArticulation(source:model.InstrumentArticulation) {const copy=new model.InstrumentArticulation();for(const key of articulationKeys)(copy[key] as string|number)=source[key];return copy;}
function drumMapping(beat:model.Beat,source:model.Track,destination:model.Track) {
  const planned=new model.Track();planned.percussionArticulations=destination.percussionArticulations.slice();
  const ids=beat.notes.map(note=>{
    const articulation=resolvePercussionArticulation(source,note.percussionArticulation);
    if(!note.isPercussion||!articulation)throw new Error('The source percussion articulation cannot be resolved.');
    for(const id of new Set([...planned.percussionArticulations.map((_,index)=>index),...standardPercussionCatalog.map(entry=>entry.id)])){
      const existing=resolvePercussionArticulation(planned,id);if(existing&&sameArticulation(articulation,existing))return id;
    }
    // Growing the custom list must not shadow an existing standard fallback.
    for(let fallback=resolvePercussionArticulation(planned,planned.percussionArticulations.length);fallback;fallback=resolvePercussionArticulation(planned,planned.percussionArticulations.length))planned.percussionArticulations.push(cloneArticulation(fallback));
    const id=planned.percussionArticulations.length;planned.percussionArticulations.push(cloneArticulation(articulation));return id;
  });
  return {ids,appended:planned.percussionArticulations.slice(destination.percussionArticulations.length)};
}
function rhythmRest(beat:model.Beat) {
  for(const note of [...beat.notes]){detachNote(note);beat.removeNote(note);}
  beat.noteStringLookup.clear();beat.noteValueLookup.clear();beat.minNote=null;beat.maxNote=null;beat.minStringNote=null;beat.maxStringNote=null;
  beat.isEmpty=false;beat.pop=false;beat.slap=false;beat.tap=false;beat.deadSlapped=false;beat.brushType=model.BrushType.None;beat.brushDuration=0;beat.pickStroke=model.PickStroke.None;beat.rasgueado=model.Rasgueado.None;
  beat.whammyBarType=model.WhammyType.None;beat.whammyBarPoints=null;beat.maxWhammyPoint=null;beat.minWhammyPoint=null;beat.isContinuedWhammy=false;beat.vibrato=model.VibratoType.None;beat.tremoloPicking=undefined;
  beat.barreFret=-1;beat.barreShape=model.BarreShape.None;beat.golpe=model.GolpeType.None;beat.wahPedal=model.WahPedal.None;beat.isLetRing=false;beat.isPalmMute=false;
}

/** Converts a detached copied beat; callers own final model rebuilding and link checks. */
export function convertClipboardBeat(beat:model.Beat,sourceStaff:model.Staff,destinationStaff:model.Staff):void {
  if(sourceStaff.isPercussion!==destinationStaff.isPercussion){rhythmRest(beat);return;}
  if(sourceStaff.isPercussion){
    const mapping=drumMapping(beat,sourceStaff.track,destinationStaff.track);
    destinationStaff.track.percussionArticulations.push(...mapping.appended);for(let i=0;i<beat.notes.length;i++)beat.notes[i].percussionArticulation=mapping.ids[i];beat.noteValueLookup.clear();return;
  }
  const sourceStringed=sourceStaff.isStringed,destinationStringed=destinationStaff.isStringed,gesture=beatTechnique(beat);
  if(sourceStringed!==destinationStringed&&(gesture||beat.notes.some(noteTechnique)))throw new Error('This string technique or gesture cannot be converted to the destination instrument.');
  const sourceNotes=beat.notes.map(note=>{
    if(note.isPercussion||(!note.isStringed&&!note.isPiano))throw new Error('Choose melodic source notes for pitch conversion.');
    if(note.isStringed&&(!integer(note.string,1,sourceStaff.tuning.length)||!integer(note.fret,0,127)))throw new Error('The source string placement is invalid.');
    const value=candidate(note,sourceStaff);pitch(value.realValueWithoutHarmonic);pitch(value.realValue);return value;
  });
  const proposals:Partial<model.Note>[]=destinationStringed?
    planFingering(destinationStaff,beat.notes.map((note,index)=>({note,pitch:sourceNotes[index].realValue,preferredString:note.isStringed?note.string:null,fixedString:note.isStringed&&(gesture||noteTechnique(note))?note.string:null})),127).map(({string,fret})=>({string,fret,octave:-1,tone:-1,percussionArticulation:-1})):
    sourceNotes.map(note=>{const written=note.realValue+destinationStaff.transpositionPitch;pitch(written);return {string:-1,fret:-1,octave:Math.floor(written/12),tone:written%12,percussionArticulation:-1};});
  for(let i=0;i<beat.notes.length;i++){
    const converted=candidate(beat.notes[i],destinationStaff,proposals[i]);pitch(converted.realValueWithoutHarmonic);pitch(converted.realValue);
    if(converted.realValue!==sourceNotes[i].realValue)throw new Error('No playable conversion preserves the source pitch.');
    if(((converted.displayValueWithoutBend-sourceNotes[i].displayValueWithoutBend)%12+12)%12!==0)proposals[i].accidentalMode=model.NoteAccidentalMode.Default;
  }
  beat.noteStringLookup.clear();beat.noteValueLookup.clear();for(let i=0;i<beat.notes.length;i++){const note=beat.notes[i];Object.assign(note,proposals[i]);if(note.isStringed)beat.noteStringLookup.set(note.string,note);}
}
