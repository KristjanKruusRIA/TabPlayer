import { model } from '@coderline/alphatab';
import { selectScore } from './selection';
import type { ExportSelection } from './types';
import { getLyricsSource } from '../editor/lyrics-source';
import { reconstructTrackLyrics } from '../editor/lyrics';
import { withPlainDrone,getBanjoDrone } from '../editor/banjo-drone';
import { getPartialCapo } from '../editor/partial-capo';

/**
 * Guitar Pro 5 (.gp5) writer. alphaTab ships a Guitar Pro 7 exporter only and no GP3-5 or GPX writer, so this writes the
 * layout alphaTab's GP3-5 reader accepts (checked against a real file), as version 5.10. Music the format cannot hold is
 * listed in `losses`; music whose notes or rhythm it cannot hold at all is refused with a `Gp5Refusal`.
 */
export interface Gp5Export { bytes:Uint8Array; losses:string[] }
export class Gp5Refusal extends Error {}
const refuse=(message:string):never=>{throw new Gp5Refusal(message);};

const MAX_BARS=1000,MAX_BEATS=100,BASS_CLEF_BELOW=35;
// The 64-entry channel table: a track takes a slot and the one after it for effects; slot 9 of each port of 16 is percussion.
const PITCHED_SLOTS=[0,2,4,6,10,12,14].flatMap(offset=>[0,16,32,48].map(port=>port+offset)).sort((a,b)=>a-b),PERCUSSION_SLOTS=[9,25,41,57];
const encoder=new TextEncoder();
// The order the file lists them in.
const DIRECTIONS=[model.Direction.TargetCoda,model.Direction.TargetDoubleCoda,model.Direction.TargetSegno,model.Direction.TargetSegnoSegno,model.Direction.TargetFine,
  model.Direction.JumpDaCapo,model.Direction.JumpDaCapoAlCoda,model.Direction.JumpDaCapoAlDoubleCoda,model.Direction.JumpDaCapoAlFine,
  model.Direction.JumpDalSegno,model.Direction.JumpDalSegnoAlCoda,model.Direction.JumpDalSegnoAlDoubleCoda,model.Direction.JumpDalSegnoAlFine,
  model.Direction.JumpDalSegnoSegno,model.Direction.JumpDalSegnoSegnoAlCoda,model.Direction.JumpDalSegnoSegnoAlDoubleCoda,model.Direction.JumpDalSegnoSegnoAlFine,
  model.Direction.JumpDaCoda,model.Direction.JumpDaDoubleCoda];
// Tuplet count to the normal count it replaces, for the counts the file stores.
const TUPLETS=new Map([[3,2],[5,4],[6,4],[7,4],[9,8],[10,8],[11,8],[12,8],[13,8]]);
const DURATIONS=new Map([[model.Duration.Whole,-2],[model.Duration.Half,-1],[model.Duration.Quarter,0],[model.Duration.Eighth,1],[model.Duration.Sixteenth,2],[model.Duration.ThirtySecond,3],[model.Duration.SixtyFourth,4]]);
const DYNAMICS=new Map([[model.DynamicValue.PPP,1],[model.DynamicValue.PP,2],[model.DynamicValue.P,3],[model.DynamicValue.MP,4],[model.DynamicValue.MF,5],[model.DynamicValue.F,6],[model.DynamicValue.FF,7],[model.DynamicValue.FFF,8]]);
const FORTE=6,BEAM_UP=0,BEAM_DOWN=1;// alphaTab keeps its BeamDirection enum private

/** Counts what is left out, one line per kind. */
class Report {
  private readonly counts=new Map<string,number>();
  lose(text:string,count=1):void { if(count>0)this.counts.set(text,(this.counts.get(text)??0)+count); }
  list():string[] { return [...this.counts].map(([text,count])=>count>1?`${text} (${count})`:text); }
}
class Out {
  private readonly data:number[]=[];
  byte(value:number):void { this.data.push(value&255); }
  short(value:number):void { this.byte(value);this.byte(value>>8); }
  int(value:number):void { this.short(value);this.short(value>>16); }
  double(value:number):void { const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value);this.raw(new Uint8Array(view.buffer)); }
  raw(bytes:ArrayLike<number>):void { for(let i=0;i<bytes.length;i++)this.data.push(bytes[i]&255); }
  zeros(count:number):void { for(let i=0;i<count;i++)this.data.push(0); }
  toBytes():Uint8Array { return Uint8Array.from(this.data); }
}
/** UTF-8 cut at a character boundary to at most `max` bytes. */
function fit(text:string,max:number,report:Report):Uint8Array {
  const bytes=encoder.encode(text);if(bytes.length<=max)return bytes;
  let end=max;while(end>0&&(bytes[end]&0xc0)===0x80)end--;
  report.lose('Text longer than Guitar Pro 5 allows is shortened');return bytes.slice(0,end);
}
/** A length byte, then a field of exactly `field` bytes. */
function fixedString(out:Out,text:string,field:number,report:Report):void { const bytes=fit(text,field,report);out.byte(bytes.length);out.raw(bytes);out.zeros(field-bytes.length); }
/** An int holding length+1, a byte holding length, then the characters. */
function sizedString(out:Out,text:string,report:Report):void { const bytes=fit(text,255,report);out.int(bytes.length+1);out.byte(bytes.length);out.raw(bytes); }
function longString(out:Out,text:string):void { const bytes=encoder.encode(text);out.int(bytes.length);out.raw(bytes); }
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

/** The bar whose notes sound here: a simile (%) bar repeats the bar or two bars before it, which the file cannot say. */
function soundingBar(bar:model.Bar):model.Bar {
  const back=bar.simileMark===model.SimileMark.Simple?1:bar.simileMark===model.SimileMark.None?0:2;
  let source:model.Bar|null=bar;for(let i=0;i<back&&source;i++)source=source.previousBar;
  return source&&source!==bar?soundingBar(source):bar;
}
const spoken=(beat:model.Beat)=>beat.notes.length>0||!beat.isEmpty;
const trackName=(track:model.Track)=>track.name||`Track ${track.index+1}`;

function checkMusic(score:model.Score):void {
  if(!score.tracks.length||!score.masterBars.length)refuse('There is no music to export as Guitar Pro 5.');
  if(score.masterBars.length>MAX_BARS)refuse(`Guitar Pro 5 holds at most ${MAX_BARS} measures and this export has ${score.masterBars.length}. Choose a measure range.`);
  const percussion=score.tracks.filter(track=>track.staves[0]?.isPercussion).length;
  if(percussion>PERCUSSION_SLOTS.length||score.tracks.length-percussion>PITCHED_SLOTS.length)refuse(`Guitar Pro 5 holds at most ${PITCHED_SLOTS.length} pitched and ${PERCUSSION_SLOTS.length} percussion tracks. Choose fewer tracks.`);
  for(const bar of score.masterBars)if(bar.timeSignatureNumerator<1||bar.timeSignatureNumerator>255||bar.timeSignatureDenominator<1||bar.timeSignatureDenominator>64)refuse(`Measure ${bar.index+1} has a time signature Guitar Pro 5 cannot hold.`);
  for(const track of score.tracks){
    const name=trackName(track),staff=track.staves[0];
    if(!staff)refuse(`${name} has no staff to export as Guitar Pro 5.`);
    if(staff.bars.length!==score.masterBars.length)refuse(`${name} does not have a bar for every measure.`);
    if(staff.isPercussion)continue;
    if(!staff.tuning.length)refuse(`${name} has no strings. Guitar Pro 5 holds only stringed and percussion tracks.`);
    if(staff.tuning.length>7)refuse(`${name} has ${staff.tuning.length} strings and Guitar Pro 5 holds at most 7.`);
    if(getPartialCapo(staff))refuse(`${name} has a partial capo, which Guitar Pro 5 cannot hold without changing its pitches. Clear it, or export as Guitar Pro.`);
    if(staff.transpositionPitch!==0)refuse(`${name} is a transposing instrument, which Guitar Pro 5 cannot hold without changing its pitches.`);
    if(staff.capo<0||staff.capo>127)refuse(`${name} has a capo Guitar Pro 5 cannot hold.`);
  }
  for(const track of score.tracks){
    const staff=track.staves[0];
    for(const bar of staff.bars)for(const voice of soundingBar(bar).voices.slice(0,2)){
      const where=`${trackName(track)}, measure ${bar.index+1}`;
      if(voice.beats.length>MAX_BEATS)refuse(`${where} has more than ${MAX_BEATS} beats in a voice, more than Guitar Pro 5 holds.`);
      for(const beat of voice.beats){
        if(!spoken(beat))continue;
        if(!DURATIONS.has(beat.duration))refuse(`${where} has a note value Guitar Pro 5 cannot hold (a double whole note, or shorter than a 64th).`);
        if(beat.dots>1)refuse(`${where} has a double-dotted note, which Guitar Pro 5 cannot hold.`);
        if(beat.hasTuplet&&TUPLETS.get(beat.tupletNumerator)!==beat.tupletDenominator)refuse(`${where} has a ${beat.tupletNumerator}:${beat.tupletDenominator} tuplet, which Guitar Pro 5 cannot hold.`);
        if(!staff.isPercussion)for(const note of beat.notes){
          if(note.string<1||note.string>staff.tuning.length)refuse(`${where} has a note on a string the track does not have.`);
          if(!note.isDead&&!note.isTieDestination&&(note.fret<0||note.fret>127))refuse(`${where} has a fret number Guitar Pro 5 cannot hold.`);
        }
      }
    }
  }
}

function writeInfo(out:Out,score:model.Score,report:Report):void {
  fixedString(out,'FICHIER GUITAR PRO v5.10',30,report);
  for(const text of [score.title,score.subTitle,score.artist,score.album,score.words,score.music,score.copyright,score.tab,score.instructions])sizedString(out,text??'',report);
  const notices=score.notices?score.notices.split(/\r\n|\n|\r/):[];
  out.int(notices.length);for(const line of notices)sizedString(out,line,report);
}
function writeLyrics(out:Out,score:model.Score,report:Report):void {
  const found=score.tracks.map(track=>{
    const source=getLyricsSource(track)?.value??reconstructTrackLyrics(track);
    return source.visible?source.lines.filter(line=>line.text.trim().length>0):[];
  });
  const owner=found.findIndex(lines=>lines.length>0),lines=owner>=0?found[owner]:[];
  report.lose('Lyrics of tracks after the first with lyrics are left out',found.filter((list,index)=>index>owner&&list.length>0).length);
  report.lose('Lyrics lines after the fifth are left out',Math.max(0,lines.length-5));
  out.int(owner>=0?owner+1:0);
  for(let i=0;i<5;i++){out.int(lines[i]?lines[i].startBar+1:1);longString(out,lines[i]?.text??'');}
}
function writePageSetup(out:Out,report:Report):void {
  for(const value of [210,297,10,10,15,10,100])out.int(value);
  out.short(0x1ff);
  for(const text of ['%TITLE%','%SUBTITLE%','%ARTIST%','%ALBUM%','Words by %WORDS%','Music by %MUSIC%','Words & Music by %WORDSMUSIC%','Copyright %COPYRIGHT%','All Rights Reserved - International Copyright Secured','Page %N%/%P%'])sizedString(out,text,report);
}

function openingTempo(score:model.Score):number {
  const first=score.masterBars[0].tempoAutomations.filter(change=>change.type===model.AutomationType.Tempo).sort((a,b)=>a.ratioPosition-b.ratioPosition)[0];
  return first?.value??120;
}
/** Tempo changes after the opening one, keyed `bar:beat` by the beat of the first track they start at (a simile bar plays its source's beats). */
function tempoChanges(score:model.Score,report:Report):Map<string,number> {
  const placed=new Map<string,number>(),lead=score.tracks[0].staves[0];
  for(const bar of score.masterBars){
    const changes=bar.tempoAutomations.filter(change=>change.type===model.AutomationType.Tempo).sort((a,b)=>a.ratioPosition-b.ratioPosition);
    changes.forEach((change,order)=>{
      // Bar 0's changes at the very start are the opening tempo (a reader may list it twice); an identical repeat is no change.
      if(bar.index===0&&change.ratioPosition===0||order>0&&change.ratioPosition===changes[order-1].ratioPosition&&change.value===changes[order-1].value)return;
      if(change.isLinear)report.lose('Gradual tempo changes become sudden');
      const length=bar.calculateDuration(false),beat=soundingBar(lead.bars[bar.index]).voices[0]?.beats.find(candidate=>candidate.graceType===model.GraceType.None&&Math.abs(candidate.playbackStart/length-change.ratioPosition)<1e-4);
      const key=beat&&`${bar.index}:${beat.index}`;
      if(!beat||!spoken(beat))report.lose('Tempo changes that do not fall on a beat of the first track are left out');
      else{if(placed.has(key!))report.lose('Two tempo changes on one beat keep the last');placed.set(key!,change.value);}
    });
  }
  return placed;
}
function tempoValue(value:number,report:Report):number {
  if(!Number.isInteger(value))report.lose('Fractional tempos are rounded');
  return clamp(Math.round(value),1,32767);
}

function beamGroups(numerator:number,denominator:number):number[] {
  const compound=denominator>=8&&numerator>3&&numerator%3===0;
  const count=compound?numerator/3:Math.ceil(numerator*8/denominator/2);
  return Array.from({length:4},(_,index)=>index<Math.min(count,4)?(compound?3:2):0);
}
/** Each direction (coda, segno, D.C. and so on) names one measure in the file; later uses of the same direction cannot be kept. */
function writeDirections(out:Out,score:model.Score,report:Report):void {
  const where=new Map<number,number>();
  for(const bar of score.masterBars)for(const direction of bar.directions??[]){
    const slot=DIRECTIONS.indexOf(direction);
    if(slot<0||where.has(slot))report.lose('A direction used again in another measure is kept in the first only');
    else where.set(slot,bar.index+1);
  }
  DIRECTIONS.forEach((_,slot)=>out.short(where.get(slot)??-1));
  out.int(0);
}
function writeMasterBars(out:Out,score:model.Score,report:Report):void {
  let previous:model.MasterBar|null=null,previousKey:[number,number]=[0,0];
  for(const bar of score.masterBars){
    const key:[number,number]=[bar.keySignature,bar.keySignatureType],numerator=!previous||bar.timeSignatureNumerator!==previous.timeSignatureNumerator,denominator=!previous||bar.timeSignatureDenominator!==previous.timeSignatureDenominator;
    const repeatEnd=bar.isRepeatEnd,section=bar.section&&(bar.section.text||bar.section.marker)?bar.section:null,keyChange=!previous||key[0]!==previousKey[0]||key[1]!==previousKey[1];
    out.byte((numerator?1:0)|(denominator?2:0)|(bar.isRepeatStart?4:0)|(repeatEnd?8:0)|(bar.alternateEndings?16:0)|(section?32:0)|(keyChange?64:0)|(bar.isDoubleBar?128:0));
    if(numerator)out.byte(bar.timeSignatureNumerator);
    if(denominator)out.byte(bar.timeSignatureDenominator);
    if(repeatEnd)out.byte(clamp(bar.repeatCount,1,255));
    if(section){sizedString(out,section.text||section.marker,report);out.raw([255,0,0,0]);}
    if(keyChange){out.byte(bar.keySignature);out.byte(bar.keySignatureType);}
    if(numerator||denominator)out.raw(beamGroups(bar.timeSignatureNumerator,bar.timeSignatureDenominator));
    out.byte(bar.alternateEndings&255);
    if(bar.tripletFeel===model.TripletFeel.Triplet8th)out.byte(1);
    else if(bar.tripletFeel===model.TripletFeel.Triplet16th)out.byte(2);
    else{out.byte(0);if(bar.tripletFeel!==model.TripletFeel.NoTripletFeel)report.lose('Swing feels other than triplet eighths and sixteenths are left out');}
    out.byte(0);
    if(bar.isFreeTime)report.lose('Free-time measures become ordinary measures');
    previous=bar;previousKey=key;
  }
}

interface Slot { track:model.Track; slot:number; effect:number; dynamic:number }
function allocate(score:model.Score):Slot[] {
  const pitched=[...PITCHED_SLOTS],percussion=[...PERCUSSION_SLOTS];
  return score.tracks.map(track=>{const slot=(track.staves[0].isPercussion?percussion:pitched).shift()!;return {track,slot,effect:slot+1,dynamic:FORTE};});
}
function writeChannels(out:Out,slots:Slot[]):void {
  const used=new Map(slots.map(entry=>[entry.slot,entry.track.playbackInfo]));
  for(let index=0;index<64;index++){
    const info=used.get(index),percussion=index%16===9;
    out.int(info?clamp(info.program,0,127):percussion?0:25);out.byte(info?clamp(Math.round(info.volume),0,16):13);out.byte(info?clamp(Math.round(info.balance),0,16):8);out.zeros(6);
  }
}
function writeTrack(out:Out,entry:Slot,score:model.Score,report:Report):void {
  const {track}=entry,staff=track.staves[0],percussion=staff.isPercussion,info=track.playbackInfo;
  report.lose('Staves after the first of a track are left out',track.staves.length-1);
  out.byte((percussion?1:0)|(track.isVisibleOnMultiTrack?8:0)|(info.isSolo?16:0)|(info.isMute?32:0)|(score.stylesheet.perTrackDisplayTuning?.get(track.index)?128:0));
  fixedString(out,track.name,40,report);
  const strings=percussion?6:staff.tuning.length;
  out.int(strings);for(let i=0;i<7;i++)out.int(i<strings?(percussion?0:staff.tuning[i]):-1);
  out.int(Math.floor(entry.slot/16)+1);out.int(entry.slot+1);out.int(entry.effect+1);out.int(24);out.int(percussion?0:staff.capo);
  out.raw([track.color.r,track.color.g,track.color.b,0]);
  out.short(0x140|(staff.showTablature?1:0)|(staff.showStandardNotation?2:0));
  out.byte(0);out.byte(clamp(info.bank,0,127));out.byte(0);
  out.int(0);out.int(0);out.int(100);
  out.raw([1,2,3,4,5,6,7,8,9,10,255,3]);
  for(let i=0;i<16;i++)out.byte(255);
  out.int(0);sizedString(out,'',report);sizedString(out,'',report);
}

const dynamicOf=(beat:model.Beat,report:Report)=>{
  const value=DYNAMICS.get(beat.dynamics);
  if(value===undefined){report.lose('Dynamics outside ppp to fff are changed to the nearest');return beat.dynamics===model.DynamicValue.FFFF?8:1;}
  return value;
};
/** The MIDI key a percussion note plays: custom articulation tables map their index, standard ones are the key itself. */
const percussionKey=(note:model.Note)=>{const table=note.beat.voice.bar.staff.track.percussionArticulations,id=note.percussionArticulation;return clamp(id<table.length&&id>=0?table[id].outputMidiNumber:id,0,127);};

interface BeatContext { entry:Slot; staff:model.Staff; bar:number; tempos:Map<string,number>; report:Report }
interface Mix { volume?:number; balance?:number; instrument?:number; tempo?:number }
function mixOf(beat:model.Beat,context:BeatContext):Mix|null {
  const mix:Mix={},{entry,tempos}=context,barLength=beat.voice.bar.masterBar.calculateDuration(false);
  for(const change of beat.automations){
    if(change.type===model.AutomationType.Volume)mix.volume=clamp(Math.round(change.value),0,16);
    else if(change.type===model.AutomationType.Balance)mix.balance=clamp(Math.round(change.value),0,16);
    else if(change.type===model.AutomationType.Instrument&&!(beat.voice.bar.index===0&&beat.index===0&&change.value===entry.track.playbackInfo.program))mix.instrument=clamp(Math.round(change.value),0,127);
    else continue;
    if(Math.abs(change.ratioPosition-beat.playbackStart/barLength)>1e-3)context.report.lose('Mixer changes placed inside a beat move to the start of that beat');
  }
  const tempo=entry.track.index===0?tempos.get(`${context.bar}:${beat.index}`):undefined;
  if(tempo!==undefined)mix.tempo=tempoValue(tempo,context.report);
  return Object.keys(mix).length?mix:null;
}
function writeMix(out:Out,mix:Mix,report:Report):void {
  out.byte(mix.instrument??255);out.raw(new Array(16).fill(255));
  out.byte(mix.volume??255);out.byte(mix.balance??255);for(let i=0;i<4;i++)out.byte(255);
  sizedString(out,'',report);out.int(mix.tempo??-1);
  if(mix.volume!==undefined)out.byte(0);
  if(mix.balance!==undefined)out.byte(0);
  if(mix.tempo!==undefined){out.byte(0);out.byte(0);}
  out.byte(0);out.byte(254);sizedString(out,'',report);sizedString(out,'',report);
}
function writeChord(out:Out,chord:model.Chord,strings:number,report:Report):void {
  out.byte(1);out.zeros(16);
  fixedString(out,chord.name,21,report);out.zeros(4);
  out.int(chord.firstFret);for(let i=0;i<7;i++)out.int(i<strings?(chord.strings[i]??-1):-1);
  const barres=chord.barreFrets.slice(0,5);out.byte(barres.length);
  for(let i=0;i<5;i++)out.byte(barres[i]??0);
  for(let i=0;i<5;i++)out.byte(i<barres.length?1:0);
  for(let i=0;i<5;i++)out.byte(i<barres.length?strings:0);
  out.zeros(7);out.byte(0);out.raw(new Array(7).fill(255));out.byte(0);
}
const strokeLevel=(ticks:number)=>ticks<=0?4:ticks<=30?2:ticks<=60?3:ticks<=120?4:ticks<=240?5:6;
function writeBeatEffects(out:Out,beat:model.Beat,report:Report):boolean {
  const slap=beat.tap?1:beat.slap?2:beat.pop?3:0,brush=beat.brushType!==model.BrushType.None,up=beat.brushType===model.BrushType.BrushUp||beat.brushType===model.BrushType.ArpeggioUp;
  const whammy=!!beat.whammyBarPoints?.length&&beat.whammyBarType!==model.WhammyType.None,pick=beat.pickStroke!==model.PickStroke.None,rasgueado=beat.rasgueado!==model.Rasgueado.None;
  const flags1=(beat.vibrato!==model.VibratoType.None?2:0)|(beat.fade===model.FadeType.FadeIn?16:0)|(slap?32:0)|(brush?64:0),flags2=(rasgueado?1:0)|(pick?2:0)|(whammy?4:0);
  if(!flags1&&!flags2)return false;
  out.byte(flags1);out.byte(flags2);
  if(slap)out.byte(slap);
  if(whammy){
    const points=beat.whammyBarPoints!;
    out.byte(beat.whammyBarType===model.WhammyType.Dip?1:2);out.int(Math.max(...points.map(point=>Math.abs(point.value)))*25);out.int(points.length);
    for(const point of points){out.int(point.offset);out.int(point.value*25);out.byte(0);}
  }
  if(brush){const level=strokeLevel(beat.brushDuration);out.byte(up?level:0);out.byte(up?0:level);}
  if(pick)out.byte(beat.pickStroke===model.PickStroke.Up?1:2);
  return true;
}
function bendKind(type:model.BendType):number {
  switch(type){
    case model.BendType.BendRelease:return 2;
    case model.BendType.Prebend:return 4;
    case model.BendType.PrebendRelease:return 5;
    case model.BendType.Release:return 11;
    default:return 1;
  }
}
function writeNote(out:Out,note:model.Note,context:BeatContext,grace:model.Beat|null,dynamic:number|null,swapped:boolean):void {
  const {report,staff}=context,beat=note.beat,percussion=staff.isPercussion;
  const bends=note.bendPoints?.length?note.bendPoints:null,slideOut=note.slideOutType,slide=(slideOut===model.SlideOutType.Shift?1:slideOut===model.SlideOutType.Legato?2:slideOut===model.SlideOutType.OutDown||slideOut===model.SlideOutType.PickSlideDown?4:slideOut===model.SlideOutType.OutUp||slideOut===model.SlideOutType.PickSlideUp?8:0)|(note.slideInType===model.SlideInType.IntoFromBelow?16:0)|(note.slideInType===model.SlideInType.IntoFromAbove?32:0);
  if(slideOut===model.SlideOutType.PickSlideDown||slideOut===model.SlideOutType.PickSlideUp)report.lose('Pick slides become out slides');
  const harmonic=note.harmonicType,trill=note.isTrill,tremolo=beat.isTremolo,graceNote=grace?.notes[0]??null;
  const effects1=(bends?1:0)|(note.isHammerPullOrigin?2:0)|(note.isLetRing?8:0)|(graceNote?16:0),effects2=(note.isStaccato?1:0)|(note.isPalmMute?2:0)|(tremolo?4:0)|(slide?8:0)|(harmonic!==model.HarmonicType.None?16:0)|(trill?32:0)|(note.vibrato!==model.VibratoType.None?64:0);
  const fingers=note.leftHandFinger>=0||note.rightHandFinger>=0,timed=note.durationPercent!==1&&Number.isFinite(note.durationPercent);
  const heavy=note.accentuated===model.AccentuationType.Heavy,normal=note.accentuated===model.AccentuationType.Normal;
  out.byte((timed?1:0)|(heavy?2:0)|(note.isGhost?4:0)|(effects1||effects2?8:0)|(dynamic!==null?16:0)|32|(normal?64:0)|(fingers?128:0));
  out.byte(note.isDead?3:note.isTieDestination?2:1);
  if(dynamic!==null)out.byte(dynamic);
  out.byte(percussion?percussionKey(note):note.isTieDestination&&note.tieOrigin?note.tieOrigin.fret:note.fret);
  if(fingers){out.byte(note.leftHandFinger>=0?note.leftHandFinger:255);out.byte(note.rightHandFinger>=0?note.rightHandFinger:255);}
  if(timed)out.double(note.durationPercent);
  out.byte(swapped?2:0);
  if(!(effects1||effects2))return;
  out.byte(effects1);out.byte(effects2);
  if(bends){
    out.byte(bendKind(note.bendType));out.int(Math.max(...bends.map(point=>point.value))*25);out.int(bends.length);
    for(const point of bends){out.int(point.offset);out.int(point.value*25);out.byte(0);}
  }
  if(graceNote){
    out.byte(clamp(graceNote.fret,0,127));out.byte(DYNAMICS.get(grace!.dynamics)??FORTE);
    out.byte(graceNote.isHammerPullOrigin?3:graceNote.slideOutType===model.SlideOutType.Legato?1:0);out.byte(3);
    out.byte((graceNote.isDead?1:0)|(grace!.graceType===model.GraceType.OnBeat?2:0));
  }
  if(tremolo)out.byte(clamp(beat.tremoloPicking?.marks??1,1,3));
  if(slide)out.byte(slide);
  if(harmonic!==model.HarmonicType.None){
    const delta=clamp(Math.round(note.harmonicValue),0,127);
    if(harmonic===model.HarmonicType.Natural)out.byte(1);
    else if(harmonic===model.HarmonicType.Artificial){
      const target=(note.fret+note.stringTuning)%12+delta;out.byte(2);out.byte(target%12);out.byte(0);out.byte(Math.floor(target/12));
    }else if(harmonic===model.HarmonicType.Tap){out.byte(3);out.byte(delta);}
    else if(harmonic===model.HarmonicType.Pinch)out.byte(4);
    else if(harmonic===model.HarmonicType.Semi)out.byte(5);
    else{out.byte(4);report.lose('Feedback harmonics become pinch harmonics');}
  }
  if(trill){
    const fret=note.trillFret;if(fret<0||fret>127)report.lose('Trills to a fret outside the neck are left at the note');
    out.byte(clamp(fret,0,127));out.byte(note.trillSpeed===model.Duration.Sixteenth?1:note.trillSpeed===model.Duration.SixtyFourth?3:2);
  }
}
const WHITE_KEYS=new Set([0,2,4,5,7,9,11]),pitchClass=(note:model.Note)=>((note.realValueWithoutHarmonic%12)+12)%12;
function countLosses(beat:model.Beat,staff:model.Staff,report:Report):void {
  if(beat.fermata)report.lose('Fermatas are left out');
  if(beat.golpe!==model.GolpeType.None||beat.deadSlapped)report.lose('Golpe and dead-slap marks are left out');
  if(beat.slashed)report.lose('Slashed beats are left out');
  if(beat.crescendo!==model.CrescendoType.None)report.lose('Crescendo and diminuendo hairpins are left out');
  if(beat.wahPedal!==model.WahPedal.None)report.lose('Wah pedal marks are left out');
  if(beat.fade===model.FadeType.FadeOut||beat.fade===model.FadeType.VolumeSwell)report.lose('Fade-outs and volume swells are left out');
  if(beat.vibrato===model.VibratoType.Wide)report.lose('Wide beat vibrato becomes ordinary vibrato');
  if(beat.rasgueado!==model.Rasgueado.None&&beat.rasgueado!==model.Rasgueado.Ii)report.lose('Rasgueado patterns other than ii become ii');
  if(beat.brushType===model.BrushType.ArpeggioUp||beat.brushType===model.BrushType.ArpeggioDown)report.lose('Arpeggio strokes become brush strokes');
  if(beat.hasChord&&!beat.chord?.name)report.lose('Chord diagrams without a name are left out');
  for(const note of beat.notes){
    if(note.accentuated===model.AccentuationType.Tenuto)report.lose('Tenuto marks are left out');
    if(note.ornament!==model.NoteOrnament.None)report.lose('Turns and mordents are left out');
    if(note.isLeftHandTapped)report.lose('Left-hand tap marks are left out');
    // A hammer-on, pull-off or legato slide is also a slur to alphaTab, and the file has those; only other slurs are lost.
    if(note.isSlurOrigin&&!note.isHammerPullOrigin&&note.slideOutType!==model.SlideOutType.Legato)report.lose('Slurs are left out');
    if(note.vibrato===model.VibratoType.Wide)report.lose('Wide note vibrato becomes ordinary vibrato');
    if(note.accidentalMode!==model.NoteAccidentalMode.Default&&note.accidentalMode!==model.NoteAccidentalMode.ForceSharp&&note.accidentalMode!==model.NoteAccidentalMode.ForceFlat&&!(note.accidentalMode===model.NoteAccidentalMode.ForceNatural&&WHITE_KEYS.has(pitchClass(note)))&&!staff.isPercussion)report.lose('Accidental spellings other than sharp and flat are left out');
    if(note.durationPercent!==1&&!Number.isFinite(note.durationPercent))report.lose('Note lengths that are not numbers are left out');
  }
}
/** The accidental a note gets by default in its key, to see whether a forced sharp or flat swaps it in the file. */
function swaps(note:model.Note):boolean {
  if(note.accidentalMode!==model.NoteAccidentalMode.ForceSharp&&note.accidentalMode!==model.NoteAccidentalMode.ForceFlat)return false;
  if(WHITE_KEYS.has(pitchClass(note)))return false;
  const flats=note.beat.voice.bar.keySignature<0;
  return flats?note.accidentalMode===model.NoteAccidentalMode.ForceSharp:note.accidentalMode===model.NoteAccidentalMode.ForceFlat;
}
function writeBeat(out:Out,beat:model.Beat,previous:model.Beat|null,graces:model.Beat[],context:BeatContext):void {
  const {entry,staff,report}=context,notes=beat.notes,rest=!notes.length,duration=DURATIONS.get(beat.duration)??0;
  const chord=beat.hasChord&&beat.chord?.name?beat.chord:null,text=beat.text?beat.text:null,mix=mixOf(beat,context);
  report.lose('Grace notes after the first before one note are left out',Math.max(0,graces.length-1));
  const grace=graces.length?graces[graces.length-1]:null;
  countLosses(beat,staff,report);
  const buffer=new Out();
  const effects=writeBeatEffects(buffer,beat,report);
  out.byte((beat.dots?1:0)|(chord?2:0)|(text?4:0)|(effects?8:0)|(mix?16:0)|(beat.hasTuplet?32:0)|(rest?64:0));
  if(rest)out.byte(beat.isEmpty?0:2);
  out.byte(duration);
  if(beat.hasTuplet)out.int(beat.tupletNumerator);
  if(chord)writeChord(out,chord,staff.tuning.length,report);
  if(text)sizedString(out,text,report);
  if(effects)out.raw(buffer.toBytes());
  if(mix)writeMix(out,mix,report);
  // One note per string; the file marks the strings in use and then lists the notes from the highest string down.
  const lanes=new Map<number,model.Note>(),strings=staff.isPercussion?6:staff.tuning.length;
  notes.forEach((note,index)=>{
    const lane=staff.isPercussion?index:strings-note.string;
    if(lane<0||lane>=strings||lanes.has(lane)){report.lose('Notes beyond one per string, or beyond six percussion hits, in a beat are left out');return;}
    lanes.set(lane,note);
  });
  out.byte([...lanes.keys()].reduce((flags,lane)=>flags|(1<<(6-lane)),0));
  let graceUsed=!grace;
  const dynamic=lanes.size?dynamicOf(beat,report):FORTE,write=lanes.size>0&&!(dynamic===FORTE&&entry.dynamic===FORTE);
  for(const lane of [...lanes.keys()].sort((a,b)=>a-b)){
    const note=lanes.get(lane)!,attach=grace&&!graceUsed&&grace.notes[0]?.string===note.string?grace:null;
    if(attach)graceUsed=true;
    writeNote(out,note,context,attach,write?dynamic:null,swaps(note));
  }
  if(lanes.size)entry.dynamic=dynamic;
  if(grace&&!graceUsed)report.lose('Grace notes whose string the main note does not play are left out');
  const split=previous?.beamingMode===model.BeatBeamingMode.ForceSplitToNext,merge=previous?.beamingMode===model.BeatBeamingMode.ForceMergeWithNext,secondary=previous?.beamingMode===model.BeatBeamingMode.ForceSplitOnSecondaryToNext;
  const ottava=beat.ottava===model.Ottavia._8va?0x10:beat.ottava===model.Ottavia._8vb?0x20:beat.ottava===model.Ottavia._15ma?0x40:beat.ottava===model.Ottavia._15mb?0x100:0;
  out.short((split?1:0)|(beat.preferredBeamDirection===BEAM_DOWN?2:0)|(merge?4:0)|(beat.preferredBeamDirection===BEAM_UP?8:0)|ottava|(secondary?0x800:0));
  if(secondary)out.byte(1);
}
function writeVoice(out:Out,voice:model.Voice|undefined,context:BeatContext):void {
  if(!voice?.beats.some(spoken)){
    // A voice with nothing in it is one empty beat, as Guitar Pro writes it.
    out.int(1);out.byte(0x40);out.byte(0);out.byte(0);out.byte(0);out.short(0);return;
  }
  const main:{beat:model.Beat;graces:model.Beat[]}[]=[];let pending:model.Beat[]=[];
  for(const beat of voice.beats){
    if(beat.graceType!==model.GraceType.None){pending.push(beat);continue;}
    main.push({beat,graces:pending});pending=[];
  }
  context.report.lose('Grace notes at the end of a measure are left out',pending.length);
  out.int(main.length);
  main.forEach((item,position)=>writeBeat(out,item.beat,position>0?main[position-1].beat:null,item.graces,context));
}
function writeBars(out:Out,score:model.Score,slots:Slot[],tempos:Map<string,number>,report:Report):void {
  for(let b=0;b<score.masterBars.length;b++)for(const entry of slots){
    const staff=entry.track.staves[0],bar=staff.bars[b],source=soundingBar(bar),context:BeatContext={entry,staff,bar:b,tempos,report};
    out.byte(0);
    report.lose('Voices after the second are left out',source.voices.slice(2).filter(voice=>voice.beats.some(spoken)).length);
    for(let v=0;v<2;v++)writeVoice(out,source.voices[v],context);
    report.lose('Sustain pedal marks are left out',bar.sustainPedals.length);
    const key=score.tracks[0].staves[0].bars[b];
    if(bar.keySignature!==key.keySignature||bar.keySignatureType!==key.keySignatureType)report.lose('Key signatures that differ between tracks use the first track\'s');
    if(!staff.isPercussion){
      // The reader picks a bass clef when the lowest string is below B1 and a treble clef otherwise.
      const bass=staff.tuning[staff.tuning.length-1]<BASS_CLEF_BELOW?model.Clef.F4:model.Clef.G2;
      if(bar.clef!==bass&&bar.clef!==model.Clef.Neutral)report.lose('Clefs the file cannot store are replaced by the track\'s usual clef');
    }
  }
}

function writeScore(score:model.Score,report:Report):Uint8Array {
  checkMusic(score);
  const out=new Out(),slots=allocate(score),tempos=tempoChanges(score,report);
  writeInfo(out,score,report);writeLyrics(out,score,report);
  out.int(100);out.zeros(15);
  writePageSetup(out,report);
  sizedString(out,score.tempoLabel||'',report);out.int(tempoValue(openingTempo(score),report));out.byte(0);out.int(score.masterBars[0].keySignature);out.byte(0);
  writeChannels(out,slots);writeDirections(out,score,report);
  out.int(score.masterBars.length);out.int(score.tracks.length);
  writeMasterBars(out,score,report);
  for(const entry of slots)writeTrack(out,entry,score,report);
  writeBars(out,score,slots,tempos,report);
  return out.toBytes();
}

/**
 * Writes the selected tracks and measures as a Guitar Pro 5 file. `backing` says the document has backing audio, which the
 * format cannot hold. Throws `Gp5Refusal` when the music cannot be held without changing its notes or rhythm.
 */
export function exportGp5(score:model.Score,selection:ExportSelection,options:{backing?:boolean}={}):Gp5Export {
  const report=new Report(),detached=selectScore(score,selection);
  if(options.backing||score.backingTrack)report.lose('Backing audio and its synchronization are left out');
  for(const track of detached.tracks)for(const staff of track.staves)if(getBanjoDrone(staff))report.lose('Banjo drone staves are written as plain 5-string staves with the same pitches');
  const bytes=withPlainDrone(detached,()=>writeScore(detached,report));
  return {bytes,losses:report.list()};
}
/** The question asked before saving: what this file leaves out, and what no Guitar Pro 5 file keeps. */
export function gp5Warning(losses:string[]):{title:string;message:string} {
  const always='Page layout, styling, sound settings and backing audio are not stored in a Guitar Pro 5 file. Your native project and original file are preserved.';
  return {title:'Export Guitar Pro 5 file',message:losses.length?`Guitar Pro 5 cannot hold everything in this score. Left out or changed: ${losses.join('; ')}. ${always}`:`Everything in this selection can be written as Guitar Pro 5. ${always}`};
}
/** What an export of this selection would leave out, or why it would be refused, for the dialog to show before saving. */
export function previewGp5(score:model.Score,selection:ExportSelection,options:{backing?:boolean}={}):{losses:string[]}|{refusal:string} {
  try{return {losses:exportGp5(score,selection,options).losses};}
  catch(error){if(error instanceof Gp5Refusal)return {refusal:error.message};throw error;}
}
