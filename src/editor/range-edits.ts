import { model } from '@coderline/alphatab';
import type { FingeringPlacement,RangeCommand,StrokeDirection,StrokeTechnique } from './range-types';
import type { PitchTarget } from './harmony-types';
import { integer,noteAt } from './common';
import { allNotes,captureNoteLinks,detachNote } from './links';
import { planFingering } from './fingering';
import { nextLinkedNote } from './techniques';
import { openStringKey } from './partial-capo';
import { resolveSelectionBeats,resolveSelectionNotes } from './range-selection';

function fields(value:object,keys:string[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid range command fields.');
}
function pitch(value:number,label='pitch') {if(!integer(value,0,127))throw new Error(`The ${label} is outside the playable MIDI pitch range.`);}
function candidate(note:model.Note,string:number,fret:number) {
  const value=new model.Note();value.beat=note.beat;value.string=string;value.fret=fret;value.harmonicType=note.harmonicType;value.harmonicValue=note.harmonicValue;return value;
}
function stringed(note:model.Note) {
  const staff=note.beat.voice.bar.staff;
  if(staff.isPercussion||!staff.tuning.length||!note.isStringed)throw new Error('Select stringed guitar or bass notes.');
  if(staff.tuning.length>12||!integer(note.string,1,staff.tuning.length)||!integer(note.fret,0,127))throw new Error('Invalid string or fret.');return staff;
}
function detachTie(from:model.Note,to:model.Note) {
  from.tieDestination=null;to.tieOrigin=null;to.isTieDestination=false;to.bendOrigin=null;to.isContinuedBend=false;
}
type Proposal={string?:number;fret?:number;octave?:number;tone?:number;trillValue?:number;accidentalMode?:model.NoteAccidentalMode};
function validateRelationships(score:model.Score,selected:Set<model.Note>,proposals:Map<model.Note,Proposal>,transpose:boolean,duplicateTies=false) {
  const notes=allNotes(score),lookup=new Map(notes.map(note=>[note.id,note])),detached:{from:model.Note;to:model.Note}[]=[];
  const noteString=(note:model.Note)=>proposals.get(note)?.string??note.string;
  const notePitch=(note:model.Note)=>{
    const proposed=proposals.get(note);if(!proposed)return note.realValue;
    return note.isStringed?candidate(note,proposed.string??note.string,proposed.fret??note.fret).realValue:(proposed.octave??note.octave)*12+(proposed.tone??note.tone)-note.beat.voice.bar.staff.transpositionPitch;
  };
  const next=(from:model.Note,proposed:boolean)=>{
    const staff=from.beat.voice.bar.staff,voice=from.beat.voice.index;
    for(let bar=from.beat.voice.bar.index;bar<staff.bars.length;bar++)for(let beat=bar===from.beat.voice.bar.index?from.beat.index+1:0;beat<(staff.bars[bar].voices[voice]?.beats.length??0);beat++){
      const found=staff.bars[bar].voices[voice].beats[beat].notes.find(note=>!note.isDead&&(from.isStringed?(proposed?noteString(note):note.string)===(proposed?noteString(from):from.string):note.isPiano===from.isPiano&&note.isPercussion===from.isPercussion&&(proposed?notePitch(note):note.realValue)===(proposed?notePitch(from):from.realValue)));
      if(found)return found;
    }return null;
  };
  for(const link of captureNoteLinks(score)){
    if(link.kind==='slur')continue;const from=lookup.get(link.from)!,to=lookup.get(link.to)!,a=selected.has(from),b=selected.has(to);
    if(transpose&&link.kind==='tie'&&a!==b){detached.push({from,to});continue;}
    const changed=(note:model.Note)=>noteString(note)!==note.string;
    if(a!==b&&((a&&changed(from))||(b&&changed(to))))throw new Error('A linked note outside the selection prevents changing this string.');
    const sameLane=from.beat.voice.bar.staff===to.beat.voice.bar.staff&&from.beat.voice.index===to.beat.voice.index;
    const forward=to.beat.voice.bar.index>from.beat.voice.bar.index||(to.beat.voice.bar===from.beat.voice.bar&&to.beat.index>from.beat.index);
    const nextNote=next(from,true),valid=sameLane&&forward&&(!from.isStringed||noteString(from)===noteString(to))&&(link.kind!=='tie'||notePitch(from)===notePitch(to))&&(duplicateTies&&link.kind==='tie'?nextNote?.beat===to.beat:nextNote===to);
    const previousNext=next(from,false),relevant=a||b||(duplicateTies&&link.kind==='tie'?previousNext?.beat===to.beat:previousNext===to);
    if(relevant&&!valid)throw new Error('The edit would break a forward, next-note relationship on this string or staff.');
  }
  return detached;
}
function validatePlacements(placements:FingeringPlacement[]) {
  const strings=new Set<number>();for(const placement of placements){if(strings.has(placement.string))throw new Error('The destination string is occupied.');strings.add(placement.string);const note=candidate(placement.note,placement.string,placement.fret);pitch(note.realValueWithoutHarmonic);pitch(note.realValue);}
}
export function applyPitchTargets(score:model.Score,targets:PitchTarget[]):void {
  if(!Array.isArray(targets))throw new Error('Choose pitch targets.');
  for(const target of targets){fields(target,['address','pitch']);pitch(target.pitch);}
  if(!targets.length)return;
  // Resolve the complete address set first, including duplicate/last-invalid checks.
  const notes=resolveSelectionNotes(score,{kind:'notes',notes:targets.map(target=>target.address)}),selected=new Set(notes),desired=new Map(targets.map(target=>[noteAt(score,target.address),target.pitch]));
  const proposals=new Map<model.Note,Proposal>(),beats=[...new Set(notes.map(note=>note.beat))];
  for(const note of notes){
    if(note.isPercussion||note.beat.voice.bar.staff.isPercussion)throw new Error('Percussion notes cannot be transposed.');
    const delta=desired.get(note)!-note.realValue;pitch(note.realValueWithoutHarmonic+delta);
    if(note.isTrill)pitch(note.trillValue+delta,'trill pitch');
    const origin=note.bendOrigin??(note.isContinuedBend?note.tieOrigin:null);
    if((note.isContinuedBend||note.bendOrigin)&&(!origin||!selected.has(origin)||desired.get(origin)!-origin.realValue!==delta))throw new Error('A continued bend requires its origin to move by the same interval.');
    const proposal:Proposal={accidentalMode:model.NoteAccidentalMode.Default,...note.isTrill?{trillValue:note.trillValue+delta}:{}};
    if(!note.isStringed){if(!note.isPiano)throw new Error('Select a pitched note.');const written=desired.get(note)!+note.beat.voice.bar.staff.transpositionPitch;pitch(written,'written pitch');proposal.octave=Math.floor(written/12);proposal.tone=written%12;}
    proposals.set(note,proposal);
  }
  for(const beat of beats){
    for(let a=0;a<beat.notes.length;a++)for(let b=a+1;b<beat.notes.length;b++){
      const first=beat.notes[a],second=beat.notes[b];
      if(first.isPiano&&second.isPiano&&(desired.get(first)??first.realValue)===(desired.get(second)??second.realValue)&&first.realValue!==second.realValue)throw new Error('The proposed chord introduces a duplicate pitch collision.');
    }
    if(!beat.notes.some(note=>selected.has(note)&&note.isStringed))continue;
    const staff=stringed(beat.notes[0]);for(const note of beat.notes)stringed(note);
    // Preserve existing equal duplicate members as one physical placement.
    const groups:model.Note[][]=[];
    for(const note of beat.notes){const group=groups.find(group=>group[0].string===note.string&&group[0].fret===note.fret&&group[0].realValue===note.realValue&&(desired.get(group[0])??group[0].realValue)===(desired.get(note)??note.realValue));if(group)group.push(note);else groups.push([note]);}
    let placements=groups.map(group=>{const note=group[0];return {note,string:note.string,fret:note.fret+(desired.get(note)??note.realValue)-note.realValue};});
    if(placements.some(placement=>!integer(placement.fret,0,127)||candidate(placement.note,placement.string,placement.fret).realValue!==(desired.get(placement.note)??placement.note.realValue))||new Set(placements.map(placement=>placement.string)).size!==placements.length)
      placements=planFingering(staff,groups.map(group=>{const note=group[0];return {note,pitch:desired.get(note)??note.realValue,preferredString:note.string,fixedString:group.some(member=>!selected.has(member))?note.string:null};}),127);
    validatePlacements(placements);
    placements.forEach((placement,index)=>{for(const note of groups[index])if(selected.has(note))Object.assign(proposals.get(note)!,{string:placement.string,fret:placement.fret});});
  }
  for(const note of notes)if(note.isStringed){const placement=proposals.get(note)!,result=candidate(note,placement.string!,placement.fret!);pitch(result.realValueWithoutHarmonic);if(result.realValue!==desired.get(note))throw new Error('The proposed fingering cannot preserve this exact harmonic pitch.');}
  const detached=validateRelationships(score,selected,proposals,true,true);
  // A moving bend origin must not strip the envelope from an unselected continuation.
  for(const {to} of detached)if(to.isContinuedBend||to.bendOrigin)throw new Error('A continued bend cannot be detached by this transposition.');
  for(const [note,proposal] of proposals)Object.assign(note,proposal);
  for(const {from,to} of detached){
    to.tieOrigin=null;to.isTieDestination=false;to.bendOrigin=null;to.isContinuedBend=false;
    if(from.tieDestination===to)from.tieDestination=to.beat.notes.find(note=>note.tieOrigin===from)??null;
  }
}
const strokeValues={
  pick:{down:model.PickStroke.Down,up:model.PickStroke.Up,none:model.PickStroke.None},
  brush:{down:model.BrushType.BrushDown,up:model.BrushType.BrushUp,none:model.BrushType.None},
  arpeggio:{down:model.BrushType.ArpeggioDown,up:model.BrushType.ArpeggioUp,none:model.BrushType.None},
} as const;
export function validateStrokePattern(technique:unknown,pattern:unknown):asserts pattern is StrokeDirection[] {
  if(typeof technique!=='string'||!Object.hasOwn(strokeValues,technique))throw new Error('Choose pick stroke, brush or arpeggio technique.');
  if(!Array.isArray(pattern)||!pattern.length||pattern.length>16||!pattern.every(step=>step==='down'||step==='up'||step==='none'))throw new Error('Choose a pattern of 1 to 16 down, up or none steps.');
}
/** Matches alphaTex's default spread: a quarter of the beat for brushes, the whole beat for arpeggios. */
function defaultBrushDuration(beat:model.Beat,technique:'brush'|'arpeggio') {
  beat.updateDurations();
  const struck=beat.notes.filter(note=>!note.isTieDestination).length||1;
  return Math.max(1,Math.round(beat.playbackDuration*(technique==='brush'?0.25:1)/struck));
}
/** Ordered patterns repeat over each voice lane's struck beats in time order. Rests, grace beats and beats
 * holding only tied notes take no step and lose the chosen technique, so a pattern can be cleared everywhere. */
function applyStrokePattern(beats:model.Beat[],technique:StrokeTechnique,pattern:StrokeDirection[]) {
  validateStrokePattern(technique,pattern);
  const lanes=new Map<string,model.Beat[]>(),skipped:model.Beat[]=[];
  for(const beat of beats){
    const staff=beat.voice.bar.staff;
    if(beat.notes.length&&(staff.isPercussion||!staff.tuning.length))throw new Error('Pick and brush patterns need a stringed guitar or bass staff.');
    if(!beat.notes.length||beat.graceType!==model.GraceType.None||beat.notes.every(note=>note.isTieDestination)){skipped.push(beat);continue;}
    const key=`${staff.track.index}/${staff.index}/${beat.voice.index}`;(lanes.get(key)??lanes.set(key,[]).get(key)!).push(beat);
  }
  const set=(beat:model.Beat,step:StrokeDirection)=>{
    if(technique==='pick'){beat.pickStroke=strokeValues.pick[step];return;}
    const value=strokeValues[technique][step],kind=(Object.values(strokeValues[technique]) as model.BrushType[]).includes(beat.brushType)&&beat.brushType!==model.BrushType.None;
    // A direction flip keeps a spread the user already set; a new brush or arpeggio gets an audible default.
    beat.brushDuration=value===model.BrushType.None?0:kind&&beat.brushDuration>0?beat.brushDuration:defaultBrushDuration(beat,technique);
    beat.brushType=value;
  };
  for(const beat of skipped)set(beat,'none');
  for(const lane of lanes.values()){
    lane.sort((a,b)=>a.voice.bar.index-b.voice.bar.index||a.index-b.index);
    lane.forEach((beat,index)=>set(beat,pattern[index%pattern.length]));
  }
}
/** The nearest earlier note that would link forward to this one: same string for stringed notes, same pitch otherwise. */
/** GP files reopen ties that reach back at most three bars (see measures.ts). */
const tieReach=3;
/** The note a tie into this one must come from: the nearest earlier note on its string (stringed) or of its
 * pitch (other staves), at most three bars back and with no rest or missing voice in between. */
function tieOriginFor(note:model.Note) {
  const staff=note.beat.voice.bar.staff,voice=note.beat.voice.index,last=note.beat.voice.bar.index;
  for(let bar=last;bar>=0&&last-bar<=tieReach;bar--){
    const beats=staff.bars[bar].voices[voice]?.beats;if(!beats)return null;
    for(let beat=bar===last?note.beat.index-1:beats.length-1;beat>=0;beat--){
      const value=beats[beat];if(!value.notes.length)return null;
      const candidate=value.notes.find(other=>note.isStringed?other.string===note.string:!other.isDead&&other.isPiano===note.isPiano&&other.realValue===note.realValue);
      if(!candidate)continue;
      // GP reopen copies the origin's fret and harmonic onto the destination, so they must already agree.
      const mismatch=candidate.isDead||candidate.realValue!==note.realValue||note.isStringed&&(candidate.fret!==note.fret||candidate.harmonicType!==note.harmonicType||candidate.harmonicValue!==note.harmonicValue);
      return mismatch?null:candidate;
    }
  }
  return null;
}
function untie(note:model.Note) {
  const origin=note.tieOrigin;if(origin?.tieDestination===note)origin.tieDestination=null;
  note.tieOrigin=null;note.isTieDestination=false;note.bendOrigin=null;note.isContinuedBend=false;
}
/** Ties every selected note from its origin, or removes the ties into them, as one edit; dead notes are left alone. */
function applySelectionTies(notes:model.Note[],tied:boolean) {
  if(typeof tied!=='boolean')throw new Error('Choose whether to tie or untie the selection.');
  if(!tied){
    const into=notes.filter(note=>note.tieOrigin||note.isTieDestination);
    if(!into.length)throw new Error('None of the selected notes are tied.');
    into.forEach(untie);return;
  }
  if(notes.some(note=>note.isPercussion||note.beat.voice.bar.staff.isPercussion))throw new Error('Drum hits cannot be tied.');
  const plan=notes.filter(note=>!note.isDead).map(note=>{
    const origin=tieOriginFor(note);
    if(!origin||nextLinkedNote(origin)!==note)throw new Error('Each selected note needs the same note on its string or staff, at most three bars earlier with no rest between, to tie from.');
    return [origin,note] as const;
  });
  const changes=plan.filter(([origin,note])=>note.tieOrigin!==origin||origin.tieDestination!==note||!note.isTieDestination);
  if(!changes.length)throw new Error(plan.length?'The selected notes are already tied.':'Select notes to tie.');
  const planned=new Set(plan.map(([,note])=>note));
  for(const [origin] of changes){const other=origin.tieDestination;if(other&&!planned.has(other)&&other.tieOrigin===origin)throw new Error('Tying here would cut an existing tie into a later note.');}
  for(const [origin,note] of changes){untie(note);origin.tieDestination=note;note.tieOrigin=origin;note.isTieDestination=true;}
}
export function applyRangeEdit(score:model.Score,command:RangeCommand):boolean {
  if(!['eraseSelection','transposeSelection','moveSelectionStrings','refingerSelection','setSelectionSustain','setSelectionStrokes','setSelectionTies'].includes(command.type))return false;
  const keys={eraseSelection:[],transposeSelection:['semitones'],moveSelectionStrings:['direction'],refingerSelection:['maxFret'],setSelectionSustain:['strings','kind','enabled'],setSelectionStrokes:['technique','pattern'],setSelectionTies:['tied']}[command.type];fields(command,['type','selection',...keys]);
  const beats=resolveSelectionBeats(score,command.selection),notes=resolveSelectionNotes(score,command.selection),selected=new Set(notes);
  if(command.type==='eraseSelection'){
    for(const note of notes){const beat=note.beat;detachNote(note);beat.removeNote(note);beat.notes.forEach((member,index)=>member.index=index);beat.isEmpty=false;}return true;
  }
  if(command.type==='setSelectionStrokes'){applyStrokePattern(beats,command.technique,command.pattern);return true;}
  if(command.type==='setSelectionTies'){applySelectionTies(notes,command.tied);return true;}
  if(command.type==='setSelectionSustain'){
    if(!Array.isArray(command.strings)||!command.strings.length||new Set(command.strings).size!==command.strings.length||!['letRing','palmMute'].includes(command.kind)||typeof command.enabled!=='boolean')throw new Error('Choose unique strings and a sustain setting.');
    const selection=command.selection,staves=selection.kind==='range'?selection.range.lanes.map(lane=>score.tracks[lane.track].staves[lane.staff]):selection.kind==='bars'?selection.tracks.flatMap(track=>score.tracks[track].staves):notes.map(note=>note.beat.voice.bar.staff);
    for(const staff of new Set(staves))if(staff.isPercussion||!staff.tuning.length||command.strings.some(value=>!integer(value,1,staff.tuning.length)))throw new Error('Choose existing strings on stringed guitar or bass lanes.');
    for(const note of notes)stringed(note);
    for(const note of notes)if(command.strings.includes(note.string))note[command.kind==='letRing'?'isLetRing':'isPalmMute']=command.enabled;return true;
  }
  const proposals=new Map<model.Note,Proposal>();
  if(command.type==='transposeSelection'){
    if(!integer(command.semitones,-127,127)||command.semitones===0)throw new Error('Choose nonzero semitones from −127 to 127.');
    const delta=command.semitones;
    for(const note of notes){
      if(note.isPercussion||note.beat.voice.bar.staff.isPercussion)throw new Error('Percussion notes cannot be transposed.');
      pitch(note.realValueWithoutHarmonic+delta);pitch(note.realValue+delta);
      if(note.isTrill)pitch(note.trillValue+delta,'trill pitch');
      proposals.set(note,{accidentalMode:model.NoteAccidentalMode.Default,...note.isTrill?{trillValue:note.trillValue+delta}:{}});
      if(!note.isStringed){if(!note.isPiano)throw new Error('Select a pitched note.');const written=note.octave*12+note.tone+delta;pitch(written,'written pitch');Object.assign(proposals.get(note)!,{octave:Math.floor(written/12),tone:written%12});}
    }
    for(const beat of beats){const moved=beat.notes.filter(note=>selected.has(note)&&note.isStringed);if(!moved.length)continue;const staff=stringed(moved[0]);for(const note of moved)stringed(note);
      let placements=beat.notes.map(note=>({note,string:note.string,fret:note.fret+(selected.has(note)?delta:0)}));
      if(placements.some(placement=>!integer(placement.fret,0,127)||candidate(placement.note,placement.string,placement.fret).realValue!==placement.note.realValue+(selected.has(placement.note)?delta:0))||new Set(placements.map(placement=>placement.string)).size!==placements.length)
        placements=planFingering(staff,beat.notes.map(note=>({note,pitch:note.realValue+(selected.has(note)?delta:0),preferredString:note.string,fixedString:selected.has(note)?null:note.string})),127);
      validatePlacements(placements);for(const placement of placements)if(selected.has(placement.note))Object.assign(proposals.get(placement.note)!,{string:placement.string,fret:placement.fret});
    }
  }else if(command.type==='moveSelectionStrings'){
    if(!['higher','lower'].includes(command.direction))throw new Error('Choose a string move direction.');
    for(const note of notes){const staff=stringed(note),strings=staff.tuning.map((_,index)=>({string:index+1,open:openStringKey(staff,index+1)})).sort((a,b)=>a.open-b.open||a.string-b.string);
      const current=strings.findIndex(value=>value.string===note.string),destination=strings[current+(command.direction==='higher'?1:-1)];
      if(!destination)throw new Error('There is no adjacent string in that direction.');
      if(strings.some(value=>value.string!==note.string&&value.open===strings[current].open)||strings.some(value=>value.string!==destination.string&&value.open===destination.open))throw new Error('Equal open pitches make the adjacent string ambiguous.');
      const fret=note.fret+strings[current].open-destination.open,test=candidate(note,destination.string,fret);
      if(!integer(fret,0,127)||test.realValue!==note.realValue)throw new Error('The adjacent string cannot preserve this pitch and harmonic.');
      proposals.set(note,{string:destination.string,fret});
    }
    for(const beat of beats)validatePlacements(beat.notes.map(note=>({note,string:proposals.get(note)?.string??note.string,fret:proposals.get(note)?.fret??note.fret})));
  }else{
    if(!integer(command.maxFret,1,127))throw new Error('Choose a maximum fret from 1 to 127.');
    for(const beat of [...beats].sort((a,b)=>a.voice.bar.index-b.voice.bar.index||a.index-b.index||a.voice.bar.staff.track.index-b.voice.bar.staff.track.index||a.voice.index-b.voice.index)){
      if(!beat.notes.length)continue;const staff=stringed(beat.notes[0]);for(const note of beat.notes)stringed(note);
      const linked=(note:model.Note)=>!!(note.tieOrigin||note.tieDestination||note.hammerPullOrigin||note.hammerPullDestination||note.slideOrigin||note.slideTarget);
      const placements=planFingering(staff,beat.notes.map(note=>({note,pitch:note.realValue,preferredString:note.string,fixedString:!selected.has(note)||linked(note)?note.string:null})),command.maxFret);
      validatePlacements(placements);for(const placement of placements)if(selected.has(placement.note))proposals.set(placement.note,{string:placement.string,fret:placement.fret});
    }
  }
  const detached=validateRelationships(score,selected,proposals,command.type==='transposeSelection');
  for(const [note,proposal] of proposals)Object.assign(note,proposal);for(const {from,to} of detached)detachTie(from,to);return true;
}
