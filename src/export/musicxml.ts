import { model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { getLyricsSource } from '../editor/lyrics-source';
import { tokenizeLyrics } from '../editor/lyrics';
import { trackMixAutomations } from '../interchange/automation';
import { scoreFromJson } from '../model-clone';
import { selectScore } from './selection';
import { withPlainDrone } from '../editor/banjo-drone';
import { isNoteCautionary } from '../editor/cautionary';
import type { ExportSelection } from './types';

// An owned MusicXML 4.0 score-partwise writer. Durations use 960 divisions per
// quarter, TabPlayer's tick unit. Anything this writer cannot express faithfully
// throws instead of being dropped; later slices widen the supported set.
const divisions=960;
const unsupported=(feature:string):never=>{throw new Error(`MusicXML export does not support ${feature} yet.`);};
const escape=(text:string)=>{
  // XML 1.0 cannot carry these characters at all, even escaped.
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(text))unsupported('control characters in text');
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
};
const element=(name:string,content:string|number,attributes='')=>`<${name}${attributes}>${content}</${name}>`;
const number=(value:number)=>String(Number(value.toFixed(6)));

// Key-aware spelling: scale degrees take the key's letter (E♯ in F♯ major, C♭ in
// G♭ major); other pitches use sharps in sharp keys and flats in flat keys.
const naturals:[string,number][]=[['C',0],['D',2],['E',4],['F',5],['G',7],['A',9],['B',11]];
const sharpSteps:[string,number][]=[['C',0],['C',1],['D',0],['D',1],['E',0],['F',0],['F',1],['G',0],['G',1],['A',0],['A',1],['B',0]];
const flatSteps:[string,number][]=[['C',0],['D',-1],['D',0],['E',-1],['E',0],['F',0],['G',-1],['G',0],['A',-1],['A',0],['B',-1],['B',0]];
function spelling(value:number,fifths:number):[string,number] {
  const altered=fifths>0?'FCGDAEB'.slice(0,fifths):'BEADGCF'.slice(0,-fifths);
  for(const [step,natural] of naturals){
    const alter=altered.includes(step)?Math.sign(fifths):0;
    if(((natural+alter)%12+12)%12===value%12)return [step,alter];
  }
  return (fifths<0?flatSteps:sharpSteps)[value%12];
}
// A forced accidental takes the enharmonic spelling with that offset, as alphaTab's
// resolveSpelling does; <accidental> reads back as the same mode.
const forced=new Map<model.NoteAccidentalMode,[number,string]>([[model.NoteAccidentalMode.ForceNatural,[0,'natural']],[model.NoteAccidentalMode.ForceSharp,[1,'sharp']],[model.NoteAccidentalMode.ForceFlat,[-1,'flat']],[model.NoteAccidentalMode.ForceDoubleSharp,[2,'double-sharp']],[model.NoteAccidentalMode.ForceDoubleFlat,[-2,'flat-flat']]]);
const accidentalNames=new Map<number,string>([[0,'natural'],[1,'sharp'],[-1,'flat'],[2,'double-sharp'],[-2,'flat-flat']]);
// A cautionary note always shows its accidental, so the sign is written even when the key supplies it.
function pitch(value:number,fifths:number,mode:model.NoteAccidentalMode=model.NoteAccidentalMode.Default,cautionary=false){
  if(!Number.isInteger(value)||value<0||value>127)unsupported('a pitch outside octaves 0–9');
  let [step,alter]=spelling(value,fifths),accidental='';
  if(mode!==model.NoteAccidentalMode.Default){
    const rule=forced.get(mode)??unsupported('this accidental mode'),[offset,name]=rule;
    const match=naturals.find(([,natural])=>((natural+offset)%12+12)%12===value%12)??unsupported('a forced accidental this pitch cannot take');
    [step,alter,accidental]=[match[0],offset,element('accidental',name)];
  }
  const octave=Math.floor((value-alter)/12)-1;
  if(octave<0||octave>9)unsupported('a pitch outside octaves 0–9');
  if(cautionary)accidental=element('accidental',accidentalNames.get(alter)??unsupported('a cautionary accidental on this pitch'),' cautionary="yes"');
  return {pitch:element('pitch',element('step',step)+(alter?element('alter',alter):'')+element('octave',octave)),accidental};
}
function tuningStep(value:number){
  if(!Number.isInteger(value)||value<12||value>127)unsupported('a tuning outside octaves 0–9');
  const [step,alter]=sharpSteps[value%12];
  return element('tuning-step',step)+(alter?element('tuning-alter',alter):'')+element('tuning-octave',Math.floor(value/12)-1);
}

const typeNames=new Map<number,string>([[-4,'long'],[-2,'breve'],[1,'whole'],[2,'half'],[4,'quarter'],[8,'eighth'],[16,'16th'],[32,'32nd'],[64,'64th'],[128,'128th'],[256,'256th']]);
function beatTicks(beat:model.Beat){
  const duration=beat.duration as number,base=duration>0?divisions*4/duration:divisions*4*-duration;
  let value=base*(2-1/2**beat.dots);
  if(beat.hasTuplet)value=value*beat.tupletDenominator/beat.tupletNumerator;
  if(!typeNames.has(duration)||!Number.isInteger(value))unsupported('this rhythm');
  return value;
}

// Fields this slice writes, or derived/layout fields; every other field must keep
// the default of a pristine model object so nothing is silently lost.
const written={
  // Presentation is not written: colours (style) and every stylesheet display choice.
  score:new Set(['title','artist','words','copyright','masterbars','tracks','stylesheet','style','defaultsystemslayout','systemslayout']),
  // Beaming rules are display grouping.
  master:new Set(['alternateendings','fermata','isrepeatstart','repeatcount','timesignaturenumerator','timesignaturedenominator','timesignaturecommon','tempoautomations','start','displayscale','displaywidth','beamingrules']),
  track:new Set(['staves','playbackinfo','name','shortname','color','defaultsystemslayout','systemslayout','isvisibleonmultitrack']),
  // Mute and solo are player state and the port is MIDI routing, not notation.
  playback:new Set(['program','primarychannel','secondarychannel','volume','balance','ismute','issolo','port']),
  staff:new Set(['bars','stringtuning','displaytranspositionpitch','showtablature','showstandardnotation','standardnotationlinecount']),
  bar:new Set(['id','clef','clefottava','voices','keysignature','keysignaturetype','displayscale','displaywidth']),
  voice:new Set(['id','beats']),
  // Stem direction is display; dynamics are written as directions.
  beat:new Set(['id','notes','isempty','duration','dots','tupletnumerator','tupletdenominator','automations','displaystart','playbackstart','displayduration','playbackduration','overridedisplayduration','preferredbeamdirection','dynamics','gracetype','lyrics','pickstroke','tap','tremolopicking']),
  // Bend points are written as <bend> elements (their type is derived from them).
  note:new Set(['id','fret','string','octave','tone','istiedestination','tiedestinationnoteid','tieoriginnoteid','accidentalmode','tabplayercautionary','dynamics','bendtype','bendpoints','iscontinuedbend','accentuated','isstaccato','vibrato','ornament','ishammerpullorigin','hammerpulloriginnoteid','hammerpulldestinationnoteid','slideouttype','slideoriginnoteid','slidetargetnoteid','isghost','ispalmmute']),
};
type Json=Record<string,unknown>;
const toJson=(score:model.Score):Json=>{const value:unknown=model.JsonConverter.scoreToJson(score);return (typeof value==='string'?JSON.parse(value):value) as Json;};
let pristine:Record<keyof typeof written,Json>|null=null;
function defaults(){
  if(pristine)return pristine;
  const score=new model.Score(),track=new model.Track();score.addTrack(track);track.ensureStaveCount(1);
  const master=new model.MasterBar();score.addMasterBar(master);
  const bar=new model.Bar();track.staves[0].addBar(bar);const voice=new model.Voice();bar.addVoice(voice);
  const beat=new model.Beat();voice.addBeat(beat);const note=new model.Note();note.octave=4;beat.addNote(note);
  score.finish(new Settings());
  const json=toJson(score),tracks=json.tracks as Json[],staves=tracks[0].staves as Json[],bars=staves[0].bars as Json[],voices=bars[0].voices as Json[],beats=voices[0].beats as Json[];
  pristine={score:json,master:(json.masterbars as Json[])[0],track:tracks[0],playback:tracks[0].playbackinfo as Json,staff:staves[0],bar:bars[0],voice:voices[0],beat:beats[0],note:(beats[0].notes as Json[])[0]};
  return pristine;
}
function check(kind:keyof typeof written,value:Json){
  const base=defaults()[kind];
  for(const key of new Set([...Object.keys(base),...Object.keys(value)])){
    if(written[kind].has(key))continue;
    if(JSON.stringify(value[key]??null)!==JSON.stringify(base[key]??null))unsupported(`${kind} ${key}`);
  }
}

function clef(bar:model.Bar,tab:boolean,number=''){
  if(tab)return element('clef',element('sign','TAB')+element('line',5),number);
  const signs:Partial<Record<model.Clef,[string,number]>>={[model.Clef.G2]:['G',2],[model.Clef.F4]:['F',4],[model.Clef.C3]:['C',3],[model.Clef.C4]:['C',4]};
  const sign=signs[bar.clef]??unsupported('this clef');
  const change=bar.clefOttava===model.Ottavia._8vb?-1:bar.clefOttava===model.Ottavia._8va?1:bar.clefOttava===model.Ottavia.Regular?0:unsupported('this clef ottava');
  return element('clef',element('sign',sign[0])+element('line',sign[1])+(change?element('clef-octave-change',change):''),number);
}
function time(master:model.MasterBar){
  const symbol=!master.timeSignatureCommon?'':master.timeSignatureNumerator===4&&master.timeSignatureDenominator===4?' symbol="common"':master.timeSignatureNumerator===2&&master.timeSignatureDenominator===2?' symbol="cut"':unsupported('a common-time symbol on this meter');
  return element('time',element('beats',master.timeSignatureNumerator)+element('beat-type',master.timeSignatureDenominator),symbol);
}
function tempoDirection(change:model.Automation,master:model.MasterBar){
  if(change.isLinear)unsupported('gradual tempo changes');
  const tick=Number((change.ratioPosition*master.calculateDuration()).toFixed(6));
  if(!Number.isInteger(tick))unsupported('a tempo change between ticks');
  // A hidden tempo keeps its label hidden too.
  return element('direction',(change.text&&change.isVisible?element('direction-type',element('words',escape(change.text))):'')+element('direction-type',element('metronome',element('beat-unit','quarter')+element('per-minute',number(change.value)),change.isVisible?'':' print-object="no"'))
    +(tick?element('offset',tick,' sound="yes"'):'')+`<sound tempo="${number(change.value)}"/>`,' placement="above"');
}

// A bend curve (offsets 0–60, values in quarter tones) as one <bend> per value change:
// bend-alter in semitones relative to the previous value, negative for pre-bends and
// releases, with first-beat/last-beat as percentages of the note's duration.
function bends(note:model.Note){
  const points=[...note.bendPoints??[]].sort((a,b)=>a.offset-b.offset);
  if(!points.length)return '';
  const percent=(offset:number)=>number(offset*100/model.BendPoint.MaxPosition);
  // A bend continued over a tie starts at the pitch its tie carries: changes are written
  // relative to it (a hold writes nothing), never as a pre-bend.
  // A curve tied into a note without its own bend plays stretched over the tie; MusicXML
  // times each bend within its note, so that timing cannot be written.
  if(note.tieDestination&&!note.tieDestination.hasBend&&points.some(point=>point.value!==points[0].value))unsupported('a bend that continues into a tied note without its own bend');
  // The import reads a tied note's pre-bend as an absolute-valued source and stops
  // correcting continued bends anywhere in the file.
  if(points[0].value&&!note.isContinuedBend&&note.isTieDestination)unsupported('a pre-bend on a tied note');
  if(note.isContinuedBend){
    const carried=[...note.tieOrigin?.bendPoints??[]].sort((a,b)=>a.offset-b.offset).pop()?.value;
    if(carried!==points[0].value)unsupported('a continued bend that does not start at the bent pitch');
    // alphaTab spaces a note's bends evenly over it and ignores first-beat and last-beat.
    // The import writes each change as two points, so repeated points count once.
    const corners=points.filter((point,index)=>!index||point.offset!==points[index-1].offset||point.value!==points[index-1].value);
    if(corners[0].value&&corners.some(point=>point.value!==corners[0].value)){
      const step=model.BendPoint.MaxPosition/(corners.length-1);
      if(corners.some((point,index)=>point.offset!==index*step||(index&&point.value===corners[index-1].value)))unsupported('a continued bend whose changes are not evenly spaced');
    }
    // Two changes import as four points, whose middle Note.finish drops on a bent continuation.
    if(points[0].value&&points.filter((point,index)=>index&&point.value!==points[index-1].value).length===2)unsupported('a continued bend with exactly two changes');
  }
  let result=points[0].value&&!note.isContinuedBend?element('bend',element('bend-alter',number(-points[0].value/2))+'<pre-bend/>'):'';
  for(let index=1;index<points.length;index++){
    const from=points[index-1],to=points[index];if(to.value===from.value)continue;
    result+=element('bend',element('bend-alter',number((to.value-from.value)/2))+(to.value<from.value?'<release/>':''),` first-beat="${percent(from.offset)}" last-beat="${percent(to.offset)}"`);
  }
  return result;
}

// TabPlayer's track-mix scale is 0–16; MusicXML volume is a percentage and pan is in degrees.
function mixDirection(change:model.Automation,master:model.MasterBar,instrument:string,staff:string){
  if(change.isLinear)unsupported('gradual mix changes');
  if(change.text)unsupported('mix text');
  const tick=Number((change.ratioPosition*master.calculateDuration()).toFixed(6));
  if(!Number.isInteger(tick))unsupported('a mix change between ticks');
  const value=change.type===model.AutomationType.Volume?element('volume',number(change.value*100/16)):element('pan',number(change.value*180/16-90));
  return element('direction',element('direction-type','<words/>')+(tick?element('offset',tick,' sound="yes"'):'')+staff+element('sound',element('midi-instrument',value,` id="${instrument}"`)));
}

// TabPlayer keeps a hyphenated syllable's trailing '-'; MusicXML states it as <syllabic>.
// alphaTab numbers lyric lines by first appearance, so an unseen earlier line is
// registered with an empty lyric before a later one.
function lyricsOf(beat:model.Beat,state:{seen:Set<number>;open:boolean[]}){
  const lines=beat.lyrics??[];let last=lines.length-1;while(last>=0&&!lines[last])last--;
  let result='';
  for(let line=0;line<=last;line++){
    const text=lines[line]??'',number=` number="${line+1}"`;
    if(!text){if(!state.seen.has(line)){state.seen.add(line);result+=element('lyric','<text/>',number);}continue;}
    const joined=text.endsWith('-'),after=state.open[line]??false,body=joined?text.slice(0,-1):text;state.seen.add(line);state.open[line]=joined;
    // alphaTab trims lyric text on import, so edge spaces and empty syllables would not read back.
    if(!body.trim()||body!==body.trim())unsupported('a lyric syllable that is empty or has edge spaces');
    // A second trailing hyphen would read back as the single one <syllabic> restores.
    if(body.endsWith('-'))unsupported('a lyric syllable ending in a hyphen');
    result+=element('lyric',element('syllabic',joined?(after?'middle':'begin'):(after?'end':'single'))+element('text',escape(body)),number);
  }
  return result;
}

// Marks alphaTab's MusicXML import reads back one-to-one. Beat-level ones go on the
// beat's first note; any wavy line without a trill imports as a slight vibrato.
const accents=new Map([[model.AccentuationType.Normal,'<accent/>'],[model.AccentuationType.Heavy,'<strong-accent/>'],[model.AccentuationType.Tenuto,'<tenuto/>']]);
const ornaments=new Map([[model.NoteOrnament.Turn,'<turn/>'],[model.NoteOrnament.InvertedTurn,'<inverted-turn/>'],[model.NoteOrnament.LowerMordent,'<mordent/>'],[model.NoteOrnament.UpperMordent,'<inverted-mordent/>']]);
const strokes=new Map([[model.PickStroke.Up,'<up-bow/>'],[model.PickStroke.Down,'<down-bow/>']]);
function marks(note:model.Note,first:boolean){
  const accent=note.accentuated===model.AccentuationType.None?'':accents.get(note.accentuated)??unsupported('this accent');
  const ornament=note.ornament===model.NoteOrnament.None?'':ornaments.get(note.ornament)??unsupported('this ornament');
  if(note.vibrato!==model.VibratoType.None&&note.vibrato!==model.VibratoType.Slight)unsupported('a wide vibrato');
  // alphaTab plays a bent note's tie destination with the origin's vibrato, while the
  // import's held-tie pass gives that destination a hold, which mutes it.
  if(note.vibrato!==model.VibratoType.None&&note.hasBend&&note.tieDestination&&!note.tieDestination.hasBend)unsupported('vibrato on a bend tied into an unbent note');
  // Further down an unbent tie chain the source vibrates unbent, but the pass holds every link.
  if(note.vibrato!==model.VibratoType.None&&!note.hasBend&&note.tieOrigin&&!note.tieOrigin.hasBend){
    let origin:model.Note|null=note.tieOrigin;while(origin&&!origin.hasBend)origin=origin.isTieDestination?origin.tieOrigin:null;
    if(origin)unsupported('vibrato in an unbent tie chain after a bend');
  }
  const beat=note.beat,stroke=beat.pickStroke===model.PickStroke.None?'':strokes.get(beat.pickStroke)??unsupported('this pick stroke');
  // alphaTab reads smufl="buzzRoll" (or unmeasured with 0 marks) as a buzz roll, keeping its
  // marks; a buzz roll with marks stays measured so other readers keep the marks too.
  const picking=beat.tremoloPicking;
  if(picking&&(!Number.isInteger(picking.marks)||picking.marks<0||picking.marks>5||(picking.style!==model.TremoloPickingStyle.Default&&picking.style!==model.TremoloPickingStyle.BuzzRoll)))unsupported('this tremolo picking');
  const tremolo=!first||!picking?'':picking.style===model.TremoloPickingStyle.BuzzRoll?`<tremolo type="${picking.marks?'single':'unmeasured'}" smufl="buzzRoll">${picking.marks}</tremolo>`:`<tremolo type="single">${picking.marks}</tremolo>`;
  return {
    articulations:accent+(note.isStaccato?'<staccato/>':''),
    ornaments:ornament+(note.vibrato===model.VibratoType.Slight?'<wavy-line type="start"/><wavy-line type="stop"/>':'')+tremolo,
    technical:first?stroke+(beat.tap?'<tap/>':''):'',
  };
}

// A hammer-on or pull-off starts on its origin and stops on its destination; the pitch
// direction names it. A note can stop one and start the next. Like ties, overlapping
// spans take distinct number levels across the whole part.
function legato(note:model.Note,open:Map<model.Note,number>,levels:Map<model.Note,number>[]){
  const link=(origin:model.Note,destination:model.Note,type:string,level:number)=>{
    const [name,text]=destination.realValue<origin.realValue?['pull-off','P']:['hammer-on','H'];return `<${name} type="${type}" number="${level}">${text}</${name}>`;
  };
  let result='';const origin=note.hammerPullOrigin;
  if(origin&&origin.isHammerPullOrigin&&origin.hammerPullDestination===note){
    const level=open.get(origin);if(!level)unsupported('a hammer-on or pull-off without its origin');
    open.delete(origin);result+=link(origin,note,'stop',level!);
  }
  if(note.isHammerPullOrigin&&note.hammerPullDestination){
    const used=new Set(levels.flatMap(spans=>[...spans.values()]));let level=1;while(used.has(level))level++;
    if(level>16)unsupported('more than 16 simultaneous hammer-ons or pull-offs');
    open.set(note,level);result+=link(note,note.hammerPullDestination,'start',level);
  }
  return result;
}

// alphaTab imports a numbered <slide> start/stop pair as a shift slide to that exact note;
// MusicXML has no form it reads as a legato slide or a slide in or out.
function slide(note:model.Note,open:Map<model.Note,number>,levels:Map<model.Note,number>[]){
  if(note.slideOutType===model.SlideOutType.Legato)unsupported('a legato slide');
  if(note.slideOutType!==model.SlideOutType.None&&note.slideOutType!==model.SlideOutType.Shift)unsupported('a slide out');
  const link=(type:string,level:number)=>`<slide type="${type}" number="${level}" line-type="solid"/>`;
  let result='';const origin=note.slideOrigin;
  if(origin&&origin.slideOutType===model.SlideOutType.Shift&&origin.slideTarget===note){
    const level=open.get(origin);if(!level)unsupported('a slide without its origin');
    open.delete(origin);result+=link('stop',level!);
  }
  const target=note.slideOutType===model.SlideOutType.Shift?note.slideTarget:null;
  if(target){
    // The target keeps one origin, so a second slide into it would be written unclosed.
    if(target.slideOrigin!==note)unsupported('two slides into one note');
    // The import pairs in document order, which follows a voice but not across voices.
    if(target.beat.voice.index!==note.beat.voice.index||target.beat.voice.bar.staff!==note.beat.voice.bar.staff)unsupported('a slide into another voice');
    const used=new Set(levels.flatMap(spans=>[...spans.values()]));let level=1;while(used.has(level))level++;
    if(level>16)unsupported('more than 16 simultaneous slides');
    open.set(note,level);result+=link('start',level);
  }
  return result;
}

// MusicXML has no fermata length: alphaTab reads each mark's type onto its beat with length 0,
// and Beat.finish files it in the master bar at that beat's start.
const fermataShapes=new Map([[model.FermataType.Medium,'normal'],[model.FermataType.Short,'angled'],[model.FermataType.Long,'square']]);
const fermataOf=(beat:model.Beat)=>!beat.fermata||beat.graceType!==model.GraceType.None?'':`<fermata type="upright">${fermataShapes.get(beat.fermata.type)??unsupported('this fermata')}</fermata>`;
// A master-bar fermata reads back only from a written beat that starts where it stands.
// The master bar is authoritative: the detached copy rebuilds every beat's fermata from it.
function checkFermatas(copy:model.Score){
  for(const master of copy.masterBars)for(const offset of master.fermata?.keys()??[]){
    if(!copy.tracks.some(track=>track.staves.some(staff=>staff.bars[master.index]?.voices.some(voice=>!voice.isEmpty&&voice.beats.some(beat=>beat.graceType===model.GraceType.None&&beat.playbackStart===offset)))))unsupported('a fermata between beats');
  }
}

// alphaTab's MusicXML import links each hammer-on origin itself (see
// musicxml-hammer-pulls.ts), so every selected link must be one that relinking from the
// flags alone rebuilds. A link a range cuts is dropped, as ties are.
function checkHammerPulls(score:model.Score,copy:model.Score){
  const notes=(value:model.Score)=>value.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)))));
  const copied=notes(copy),linked=(note:model.Note|undefined)=>note?.isHammerPullOrigin?note.hammerPullDestination?.id??null:null;
  // Playback softens a destination through its backlink, so that side is compared too.
  const back=(note:model.Note|undefined)=>note?.hammerPullOrigin?.id??null;
  if(!copied.some(note=>note.isHammerPullOrigin||note.hammerPullOrigin)&&!notes(score).some(note=>note.isHammerPullOrigin))return;
  const json=toJson(copy);
  for(const track of json.tracks as Json[])for(const staff of track.staves as Json[])for(const bar of staff.bars as Json[])for(const voice of bar.voices as Json[])for(const beat of voice.beats as Json[])for(const note of beat.notes as Json[]){delete note.hammerpulloriginnoteid;delete note.hammerpulldestinationnoteid;}
  const rebuilt=new Map(notes(scoreFromJson(JSON.stringify(json),new Settings())).map(note=>[note.id,note]));
  const source=new Map(notes(score).map(note=>[note.id,note])),kept=new Set(copied.map(note=>note.id));
  for(const note of copied){
    const wanted=linked(source.get(note.id));
    const expected=wanted!==null&&kept.has(wanted)?wanted:null;
    const origin=back(source.get(note.id)),from=origin!==null&&kept.has(origin)?origin:null;
    if(linked(note)!==expected||linked(rebuilt.get(note.id))!==expected||back(note)!==from||back(rebuilt.get(note.id))!==from)unsupported('a hammer-on or pull-off the import cannot link back');
  }
}

const noteheadOf=(note:model.Note)=>note.isGhost?'<notehead parentheses="yes">normal</notehead>':'';
const playOf=(note:model.Note)=>note.isPalmMute?'<play><mute>palm</mute></play>':'';
function placeNoteAttributes(timing:string,accidental:string,notehead:string):string {
  const timeCut=timing.indexOf('<time-modification>'),staffCut=timing.indexOf('<staff>');
  if(timeCut>=0&&staffCut>=0){
    return timing.slice(0,timeCut)+accidental+timing.slice(timeCut,staffCut)+notehead+timing.slice(staffCut);
  }
  if(timeCut>=0){
    return timing.slice(0,timeCut)+accidental+timing.slice(timeCut)+notehead;
  }
  if(staffCut>=0){
    return timing.slice(0,staffCut)+accidental+notehead+timing.slice(staffCut);
  }
  return timing+accidental+notehead;
}

function endingNumbers(flags:number):number[]{
  if(!Number.isInteger(flags)||flags<=0||flags>255)unsupported('this alternate ending');
  const result:number[]=[];
  for(let i=0;i<8;i++)if((flags&(1<<i))!==0)result.push(i+1);
  return result;
}

function writePart(track:model.Track,score:model.Score,json:Json,scoreJson:Json,first:boolean,instrument:string,state:{dynamic:model.DynamicValue;started:boolean}){
  state.started=false;
  const mix=trackMixAutomations(track),sung={seen:new Set<number>(),open:[] as boolean[]};
  check('track',json);check('playback',json.playbackinfo as Json);
  (json.staves as Json[]).forEach(s=>check('staff',s));
  if(track.staves.some(s=>s.isPercussion))unsupported('percussion staves');
  if(track.staves.length>1&&track.staves.some(s=>s.stringTuning.tunings.length>0))unsupported('more than one staff per track');
  const staff0=track.staves[0],strings=staff0.stringTuning.tunings,stringed=strings.length>0;
  const tab=stringed&&staff0.showTablature&&!staff0.showStandardNotation;
  const both=track.staves.length===1&&stringed&&staff0.showTablature&&staff0.showStandardNotation;
  if(track.staves.length===1&&stringed&&!tab&&!both)unsupported('a stringed staff shown only as standard notation');
  const layouts=both?[{staffIndex:0,staff:'1',voices:0,technical:false},{staffIndex:0,staff:'2',voices:4,technical:true}]:track.staves.length>1?track.staves.map((_,s)=>({staffIndex:s,staff:String(s+1),voices:0,technical:true})):[{staffIndex:0,staff:'',voices:0,technical:true}];
  const ties=layouts.map(()=>new Map<model.Note,number>()),legatos=layouts.map(()=>new Map<model.Note,number>()),slides=layouts.map(()=>new Map<model.Note,number>());
  let measures='',previous:model.Bar|null=null;
  for(const [index,bar0] of staff0.bars.entries()){
    const master=bar0.masterBar;check('master',(scoreJson.masterbars as Json[])[master.index]);
    const length=master.calculateDuration();let content='';
    const flags=master.alternateEndings;
    if(!Number.isInteger(flags)||flags<0||flags>255)unsupported('this alternate ending');
    let startEndingXml='',stopEndingXml='';
    if(flags>0){
      const nums=endingNumbers(flags).join(', ');
      const prevMaster=index>0?staff0.bars[index-1].masterBar:null;
      const prevStopped=!prevMaster||prevMaster.repeatCount>0||prevMaster.alternateEndings!==flags;
      if(prevStopped)startEndingXml=element('ending',`${nums}.`,` number="${nums}" type="start"`);
      const nextMaster=index<staff0.bars.length-1?staff0.bars[index+1].masterBar:null;
      const nextStopped=!nextMaster||master.repeatCount>0||nextMaster.alternateEndings!==flags;
      if(nextStopped)stopEndingXml=element('ending','',` number="${nums}" type="stop"`);
    }
    // One unnumbered <key> applies to every staff on import, so staves that disagree cannot be written.
    if(track.staves.some(s=>s.bars[index].keySignature!==bar0.keySignature||s.bars[index].keySignatureType!==bar0.keySignatureType))unsupported('different key signatures on the staves of one track');
    const attributes:string[]=[];
    if(!previous)attributes.push(element('divisions',divisions));
    if(!previous||previous.keySignature!==bar0.keySignature||previous.keySignatureType!==bar0.keySignatureType)attributes.push(element('key',element('fifths',bar0.keySignature)+element('mode',bar0.keySignatureType===model.KeySignatureType.Minor?'minor':'major')));
    const previousMaster=previous?.masterBar;
    if(!previousMaster||previousMaster.timeSignatureNumerator!==master.timeSignatureNumerator||previousMaster.timeSignatureDenominator!==master.timeSignatureDenominator||previousMaster.timeSignatureCommon!==master.timeSignatureCommon)attributes.push(time(master));
    if(!previous&&layouts.length>1)attributes.push(element('staves',layouts.length));
    if(!previous){
      if(both){
        attributes.push(clef(bar0,false,' number="1"'));
        attributes.push(clef(bar0,true,' number="2"'));
      }else if(track.staves.length>1){
        layouts.forEach(layout=>attributes.push(clef(track.staves[layout.staffIndex].bars[index],false,` number="${layout.staff}"`)));
      }else{
        attributes.push(clef(bar0,tab,''));
      }
    }else{
      if(both){
        if(bar0.clef!==previous.clef||bar0.clefOttava!==previous.clefOttava)attributes.push(clef(bar0,false,' number="1"'));
      }else if(track.staves.length>1){
        layouts.forEach(layout=>{
          const b=track.staves[layout.staffIndex].bars[index],prevB=track.staves[layout.staffIndex].bars[index-1];
          if(b.clef!==prevB.clef||b.clefOttava!==prevB.clefOttava)attributes.push(clef(b,false,` number="${layout.staff}"`));
        });
      }else{
        if(bar0.clef!==previous.clef||bar0.clefOttava!==previous.clefOttava)attributes.push(clef(bar0,tab,''));
      }
    }
    if(!previous&&stringed)attributes.push(element('staff-details',(both?element('staff-type','alternate'):'')+element('staff-lines',strings.length)+strings.map((_,line)=>element('staff-tuning',tuningStep(strings[strings.length-1-line]),` line="${line+1}"`)).join(''),both?' number="2"':''));
    if(!previous){
      if(track.staves.length===1){
        const transpose=staff0.displayTranspositionPitch,octaveChange=Math.trunc(transpose/12),chromatic=transpose-12*octaveChange;
        if(transpose)attributes.push(element('transpose',element('chromatic',chromatic)+(octaveChange?element('octave-change',octaveChange):'')));
      }else{
        layouts.forEach(layout=>{
          const transpose=track.staves[layout.staffIndex].displayTranspositionPitch;
          if(transpose){
            const octaveChange=Math.trunc(transpose/12),chromatic=transpose-12*octaveChange;
            attributes.push(element('transpose',element('chromatic',chromatic)+(octaveChange?element('octave-change',octaveChange):''),` number="${layout.staff}"`));
          }
        });
      }
    }
    if(attributes.length)content+=element('attributes',attributes.join(''));
    if(master.isRepeatStart||startEndingXml){
      const leftStyle=master.isRepeatStart?element('bar-style','heavy-light'):'';
      const leftRepeat=master.isRepeatStart?'<repeat direction="forward"/>':'';
      content+=element('barline',leftStyle+startEndingXml+leftRepeat,' location="left"');
    }
    if(first){
      const tempos=[...master.tempoAutomations].sort((a,b)=>a.ratioPosition-b.ratioPosition);
      if(index===0&&!tempos.some(change=>change.ratioPosition===0))tempos.unshift(Object.assign(new model.Automation(),{type:model.AutomationType.Tempo,value:score.tempo,ratioPosition:0,isVisible:true}));
      content+=tempos.map(change=>tempoDirection(change,master)).join('');
    }
    content+=mix.filter(point=>point.bar===index).map(point=>mixDirection(point.automation,master,instrument,layouts[0].staff?element('staff',layouts[0].staff):'')).join('');
    const voices:{notes:string;total:number}[][]=layouts.map(()=>[]);
    const staffOf=(layout:typeof layouts[number])=>layout.staff?element('staff',layout.staff):'';
    if(both){
      const staffJson=(json.staves as Json[])[0],barJson=(staffJson.bars as Json[])[index];check('bar',barJson);
      const transpose=staff0.displayTranspositionPitch;
      for(const voice of bar0.voices){
        const voiceJson=(barJson.voices as Json[])[voice.index];check('voice',voiceJson);
        if(voice.index>=4&&!voice.isEmpty)unsupported('more than four voices on a notation + TAB staff');
        const notes=layouts.map(()=>'');let total=0;
        for(const beat of voice.beats){
          const beatJson=(voiceJson.beats as Json[])[beat.index];check('beat',beatJson);
          if(beat.lyrics?.some(Boolean)){
            if(voice.index!==0)unsupported('lyrics outside the first voice');
            if(!beat.notes.length)unsupported('lyrics on a rest');
          }
          const grace=beat.graceType===model.GraceType.OnBeat?'<grace/>':beat.graceType===model.GraceType.BeforeBeat?'<grace slash="yes"/>':'';
          if(beat.graceType!==model.GraceType.None){
            if(!grace)unsupported('a bend grace');
            if(!voice.beats.slice(beat.index+1).some(next=>next.graceType===model.GraceType.None))unsupported('a grace note without a following beat');
            if(!beat.notes.length)unsupported('a grace rest');
            if(beat.notes.some(note=>note.isTieDestination||note.tieDestination))unsupported('a tied grace note');
            if(beat.notes.some(note=>note.hasBend))unsupported('a bent grace note');
            if(beat.dots||beat.hasTuplet)unsupported('a dotted or tuplet grace note');
          }
          const start=index===0&&voice.index===0&&beat.index===0;
          if(beat.automations.some(change=>change.type!==model.AutomationType.Volume&&change.type!==model.AutomationType.Balance&&!(start&&change.type===model.AutomationType.Instrument&&change.value===track.playbackInfo.program)))unsupported('beat automations');
          if(!beat.notes.length&&(beat.pickStroke!==model.PickStroke.None||beat.tap))unsupported('a pick stroke or tap on a rest');
          if(!beat.notes.length&&beat.tremoloPicking)unsupported('tremolo picking on a rest');
          if(voice.isEmpty){if(beat.notes.length)unsupported('notes in an empty voice');continue;}
          if(beat.isEmpty)unsupported('an empty beat inside a voice');
          const voiceNumber=(layout:typeof layouts[number])=>element('voice',voice.index+1+layout.voices);
          if(beat.notes.some(note=>note.dynamics!==beat.dynamics))unsupported('note dynamics differing from their beat');
          const opening=!state.started;state.started=true;
          if(beat.dynamics!==state.dynamic||(opening&&beat.dynamics!==model.DynamicValue.F)){
            const name=(model.DynamicValue[beat.dynamics]??unsupported('this dynamic')).toLowerCase();
            notes[0]+=element('direction',element('direction-type',element('dynamics',`<${name}/>`))+staffOf(layouts[0]),' placement="below"');state.dynamic=beat.dynamics;
          }
          if(voice.beats.length===1&&!beat.notes.length&&beat.duration===model.Duration.Whole&&!beat.dots&&!beat.hasTuplet&&beat.displayDuration===length){
            const held=fermataOf(beat);
            layouts.forEach((layout,at)=>{notes[at]+=element('note','<rest measure="yes"/>'+element('duration',length)+voiceNumber(layout)+staffOf(layout)+(held?element('notations',held):''));});total=length;continue;
          }
          const ticks=grace?0:beatTicks(beat);
          if(beat.displayStart!==total||beat.displayDuration!==ticks)unsupported('a beat whose length differs from its note value');
          total+=ticks;
          const rhythm=(layout:typeof layouts[number])=>(grace?'':element('duration',ticks))+voiceNumber(layout)+element('type',typeNames.get(beat.duration as number)!)+'<dot/>'.repeat(beat.dots)
            +(beat.hasTuplet?element('time-modification',element('actual-notes',beat.tupletNumerator)+element('normal-notes',beat.tupletDenominator)):'')+staffOf(layout);
          const held=fermataOf(beat);
          if(!beat.notes.length){layouts.forEach((layout,at)=>{notes[at]+=element('note','<rest/>'+rhythm(layout)+(held?element('notations',held):''));});continue;}
          const sorted=[...beat.notes].sort((a,b)=>a.realValue-b.realValue),lyrics=lyricsOf(beat,sung);
          for(const [noteIndex,note] of sorted.entries()){
            check('note',(beatJson.notes as Json[])[note.index]);
            const written=pitch(note.calculateRealValue(false,false)-transpose,bar0.keySignature,note.accidentalMode,isNoteCautionary(note));
            layouts.forEach((layout,at)=>{
              const open=ties[at],links:[string,number][]=[];
              if(note.isTieDestination){
                const level=note.tieOrigin&&open.get(note.tieOrigin);if(!level)unsupported('a tie without its origin');
                open.delete(note.tieOrigin!);links.push(['stop',level!]);
              }
              if(note.tieDestination){
                const used=new Set(ties.flatMap(levels=>[...levels.values()]));let level=1;while(used.has(level))level++;
                if(level>16)unsupported('more than 16 simultaneous ties');open.set(note,level);links.push(['start',level]);
              }
              const fingering=layout.technical&&note.isStringed?element('string',strings.length-note.string+1)+element('fret',note.fret):'',bent=bends(note),mark=marks(note,noteIndex===0);
              if(note.vibrato!==model.VibratoType.None&&note.hasBend&&!bent)unsupported('vibrato on a bend held over a tie');
              const slurred=legato(note,legatos[at],legatos),technical=fingering||bent||mark.technical||slurred?element('technical',slurred+bent+mark.technical+fingering):'';
              const marked=(noteIndex===0?held:'')+(mark.ornaments?element('ornaments',mark.ornaments):'')+technical+(mark.articulations?element('articulations',mark.articulations):'');
              const tied=links.map(([type,level])=>`<tied type="${type}" number="${level}"/>`).join('')+slide(note,slides[at],slides);
              const timing=rhythm(layout).replace('</duration>',`</duration>${links.map(([type])=>`<tie type="${type}"/>`).join('')}`);
              notes[at]+=element('note',grace+(noteIndex?'<chord/>':'')+written.pitch+placeNoteAttributes(timing,written.accidental,noteheadOf(note))
                +(tied||marked?element('notations',tied+marked):'')+(at===0&&noteIndex===0?lyrics:'')+playOf(note));
            });
          }
        }
        layouts.forEach((_,at)=>{if(notes[at])voices[at].push({notes:notes[at],total});});
      }
    }else{
      for(const [at,layout] of layouts.entries()){
        const staff=track.staves[layout.staffIndex];
        const bar=staff.bars[index];
        const staffJson=(json.staves as Json[])[layout.staffIndex];
        const barJson=(staffJson.bars as Json[])[index];
        check('bar',barJson);
        const strings=staff.stringTuning.tunings;
        const transpose=staff.displayTranspositionPitch;
        for(const voice of bar.voices){
          const voiceJson=(barJson.voices as Json[])[voice.index];check('voice',voiceJson);
          let notes='';let total=0;
          for(const beat of voice.beats){
            const beatJson=(voiceJson.beats as Json[])[beat.index];check('beat',beatJson);
            if(beat.lyrics?.some(Boolean)){
              if(layout.staffIndex!==0||voice.index!==0)unsupported('lyrics outside the first voice');
              if(!beat.notes.length)unsupported('lyrics on a rest');
            }
            const grace=beat.graceType===model.GraceType.OnBeat?'<grace/>':beat.graceType===model.GraceType.BeforeBeat?'<grace slash="yes"/>':'';
            if(beat.graceType!==model.GraceType.None){
              if(!grace)unsupported('a bend grace');
              if(!voice.beats.slice(beat.index+1).some(next=>next.graceType===model.GraceType.None))unsupported('a grace note without a following beat');
              if(!beat.notes.length)unsupported('a grace rest');
              if(beat.notes.some(note=>note.isTieDestination||note.tieDestination))unsupported('a tied grace note');
              if(beat.notes.some(note=>note.hasBend))unsupported('a bent grace note');
              if(beat.dots||beat.hasTuplet)unsupported('a dotted or tuplet grace note');
            }
            const start=index===0&&layout.staffIndex===0&&voice.index===0&&beat.index===0;
            if(beat.automations.some(change=>change.type!==model.AutomationType.Volume&&change.type!==model.AutomationType.Balance&&!(start&&change.type===model.AutomationType.Instrument&&change.value===track.playbackInfo.program)))unsupported('beat automations');
            if(!beat.notes.length&&(beat.pickStroke!==model.PickStroke.None||beat.tap))unsupported('a pick stroke or tap on a rest');
            if(!beat.notes.length&&beat.tremoloPicking)unsupported('tremolo picking on a rest');
            if(voice.isEmpty){if(beat.notes.length)unsupported('notes in an empty voice');continue;}
            if(beat.isEmpty)unsupported('an empty beat inside a voice');
            const voiceNumber=element('voice',voice.index+1+layout.voices);
            if(beat.notes.some(note=>note.dynamics!==beat.dynamics))unsupported('note dynamics differing from their beat');
            const opening=!state.started;state.started=true;
            if(beat.dynamics!==state.dynamic||(opening&&beat.dynamics!==model.DynamicValue.F)){
              const name=(model.DynamicValue[beat.dynamics]??unsupported('this dynamic')).toLowerCase();
              notes+=element('direction',element('direction-type',element('dynamics',`<${name}/>`))+staffOf(layout),' placement="below"');state.dynamic=beat.dynamics;
            }
            if(voice.beats.length===1&&!beat.notes.length&&beat.duration===model.Duration.Whole&&!beat.dots&&!beat.hasTuplet&&beat.displayDuration===length){
              const held=fermataOf(beat);
              notes+=element('note','<rest measure="yes"/>'+element('duration',length)+voiceNumber+staffOf(layout)+(held?element('notations',held):''));total=length;continue;
            }
            const ticks=grace?0:beatTicks(beat);
            if(beat.displayStart!==total||beat.displayDuration!==ticks)unsupported('a beat whose length differs from its note value');
            total+=ticks;
            const rhythm=(grace?'':element('duration',ticks))+voiceNumber+element('type',typeNames.get(beat.duration as number)!)+'<dot/>'.repeat(beat.dots)
              +(beat.hasTuplet?element('time-modification',element('actual-notes',beat.tupletNumerator)+element('normal-notes',beat.tupletDenominator)):'')+staffOf(layout);
            const held=fermataOf(beat);
            if(!beat.notes.length){notes+=element('note','<rest/>'+rhythm+(held?element('notations',held):''));continue;}
            const sorted=[...beat.notes].sort((a,b)=>a.realValue-b.realValue),lyrics=lyricsOf(beat,sung);
            for(const [noteIndex,note] of sorted.entries()){
              check('note',(beatJson.notes as Json[])[note.index]);
              const written=pitch(note.calculateRealValue(false,false)-transpose,bar.keySignature,note.accidentalMode,isNoteCautionary(note));
              const open=ties[at],links:[string,number][]=[];
              if(note.isTieDestination){
                const level=note.tieOrigin&&open.get(note.tieOrigin);if(!level)unsupported('a tie without its origin');
                open.delete(note.tieOrigin!);links.push(['stop',level!]);
              }
              if(note.tieDestination){
                const used=new Set(ties.flatMap(levels=>[...levels.values()]));let level=1;while(used.has(level))level++;
                if(level>16)unsupported('more than 16 simultaneous ties');open.set(note,level);links.push(['start',level]);
              }
              const fingering=layout.technical&&note.isStringed?element('string',strings.length-note.string+1)+element('fret',note.fret):'',bent=bends(note),mark=marks(note,noteIndex===0);
              if(note.vibrato!==model.VibratoType.None&&note.hasBend&&!bent)unsupported('vibrato on a bend held over a tie');
              const slurred=legato(note,legatos[at],legatos),technical=fingering||bent||mark.technical||slurred?element('technical',slurred+bent+mark.technical+fingering):'';
              const marked=(noteIndex===0?held:'')+(mark.ornaments?element('ornaments',mark.ornaments):'')+technical+(mark.articulations?element('articulations',mark.articulations):'');
              const tied=links.map(([type,level])=>`<tied type="${type}" number="${level}"/>`).join('')+slide(note,slides[at],slides);
              const timing=rhythm.replace('</duration>',`</duration>${links.map(([type])=>`<tie type="${type}"/>`).join('')}`);
              notes+=element('note',grace+(noteIndex?'<chord/>':'')+written.pitch+placeNoteAttributes(timing,written.accidental,noteheadOf(note))
                +(tied||marked?element('notations',tied+marked):'')+(layout.staffIndex===0&&at===0&&noteIndex===0?lyrics:'')+playOf(note));
            }
          }
          if(notes)voices[at].push({notes,total});
        }
      }
    }
    const entries=layouts.flatMap((layout,at)=>voices[at].length?voices[at]:[{notes:element('note','<rest measure="yes"/>'+element('duration',length)+element('voice',1+layout.voices)+staffOf(layout)),total:length}]);
    entries.forEach(({notes,total},at)=>{content+=notes+(at<entries.length-1?element('backup',element('duration',total)):'');});
    if(master.repeatCount>0||stopEndingXml){
      const rightStyle=master.repeatCount>0?element('bar-style','light-heavy'):'';
      const rightRepeat=master.repeatCount>0?`<repeat direction="backward"${master.repeatCount===2?'':` times="${master.repeatCount}"`}/>`:'';
      content+=element('barline',rightStyle+stopEndingXml+rightRepeat,' location="right"');
    }
    measures+=element('measure',content,` number="${index+1}"`);previous=bar0;
  }
  if([...legatos,...slides].some(open=>open.size))unsupported('a hammer-on, pull-off or slide left open');
  return measures;
}

// An excerpt drops ties that cross its edges. A bend tied into or out of an unbent note
// then loses the pitch its tie carries, so such cuts are refused on the source score.
function checkCutBends(score:model.Score,selection:ExportSelection){
  const range=selection.range;if(!range)return;
  const changes=(note:model.Note)=>(note.bendPoints??[]).some(point=>point.value!==note.bendPoints![0].value);
  // The nearest bent note an unbent tie chain carries its pitch from.
  const bentOrigin=(note:model.Note)=>{let origin=note.isTieDestination?note.tieOrigin:null;while(origin&&!origin.hasBend)origin=origin.isTieDestination?origin.tieOrigin:null;return origin;};
  for(const index of selection.tracks)for(const [position,staff] of score.tracks[index].staves.entries()){
    if(selection.staves?.[index]&&!selection.staves[index].includes(position))continue;
    for(const bar of staff.bars.slice(range.first,range.last+1))for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes){
      const destination=note.tieDestination,origin=note.hasBend?null:bentOrigin(note);
      if(destination&&destination.beat.voice.bar.index>range.last&&!destination.hasBend&&changes(note))unsupported('a range that cuts a bend from its tied note');
      if(origin&&origin.beat.voice.bar.index<range.first)unsupported('a range that cuts a tied note from its bend');
    }
  }
}

function exportMusicXmlPlain(score:model.Score,selection:ExportSelection):Uint8Array {
  checkCutBends(score,selection);
  // Lyrics (including hidden ones) live in TabPlayer's own sources, outside the model data.
  for(const index of selection.tracks){
    const source=getLyricsSource(score.tracks[index])?.value;if(!source)continue;
    // Hidden lyrics have no syllables to write, and comments are not distributed.
    if(!source.visible&&source.lines.some(line=>line.text.trim()))unsupported('hidden lyrics');
    if(source.lines.some(line=>line.text.includes('[')))unsupported('lyric comments');
    // Words past the last note are kept in the source but never distributed to a beat.
    const bars=score.tracks[index].staves[0].bars;
    for(const line of source.lines){
      const words=tokenizeLyrics(line.text);let used=words.length;while(used&&!words[used-1])used--;
      if(used>bars.slice(line.startBar).flatMap(bar=>bar.voices[0]?.beats??[]).filter(beat=>!beat.isEmpty&&!beat.isRest).length)unsupported('lyrics with more syllables than notes');
    }
  }
  const copy=selectScore(score,selection),json=toJson(copy);check('score',json);checkHammerPulls(score,copy);checkFermatas(copy);
  if(copy.tracks.some(track=>track.staves.some(staff=>staff.transpositionPitch!==0)))unsupported('sounding transposition');
  // alphaTab's import keeps one running dynamic across all parts in document order.
  const state={dynamic:model.DynamicValue.F,started:false};
  const parts=copy.tracks.map((track,index)=>{
    const info=track.playbackInfo,id=`P${index+1}`;
    if(info.primaryChannel<0||info.primaryChannel>15)unsupported('MIDI channels above 16');
    return {
      list:element('score-part',element('part-name',escape(track.name))+(track.shortName?element('part-abbreviation',escape(track.shortName)):'')+element('score-instrument',element('instrument-name',escape(track.name)),` id="${id}-I1"`)
        +element('midi-instrument',element('midi-channel',info.primaryChannel+1)+element('midi-program',info.program+1)+element('volume',number(info.volume*100/16))+element('pan',number(info.balance*180/16-90)),` id="${id}-I1"`),` id="${id}"`),
      body:element('part',writePart(track,copy,(json.tracks as Json[])[index],json,index===0,`${id}-I1`,state),` id="${id}"`),
    };
  });
  const identification=[copy.artist?element('creator',escape(copy.artist),' type="composer"'):'',copy.words?element('creator',escape(copy.words),' type="lyricist"'):'',copy.copyright?element('rights',escape(copy.copyright)):''].join('');
  const xml='<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
    +element('score-partwise',(copy.title?element('work',element('work-title',escape(copy.title))):'')+(identification?element('identification',identification):'')
      +element('part-list',parts.map(part=>part.list).join(''))+parts.map(part=>part.body).join(''),' version="4.0"');
  return strToU8(xml);
}

/** A banjo drone is written as GP does: frets on the short string counted from its own start, so the pitches are the same. */
export function exportMusicXml(score:model.Score,selection:ExportSelection):Uint8Array {return withPlainDrone(score,()=>exportMusicXmlPlain(score,selection));}
