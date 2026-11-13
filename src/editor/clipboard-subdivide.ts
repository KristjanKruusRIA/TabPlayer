import { model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { copyGpInterchangeSource } from '../interchange/gp';
import { rhythmTicks } from './common';
import { captureNoteLinks,restoreNoteLinks } from './links';
import type { BeatRange,MusicPoint } from './range-types';

/** One beat that a tick cut falls strictly inside. */
interface Straddle {beat:model.Beat;start:number;length:number}
/** A sustained beat can be cut into at most this many written pieces per side. */
const MAX_PIECES_PER_SIDE=4;

function straddling(voice:model.Voice,tick:number):Straddle|null {
  const nominal=voice.bar.masterBar.calculateDuration(false);let start=0;
  for(const beat of voice.beats){
    const length=rhythmTicks(beat,nominal);
    if(length>0&&start<tick&&tick<start+length)return {beat,start,length};
    start+=length;
  }
  return null;
}
function cutPoints(range:BeatRange):MusicPoint[] {return [range.start,range.end];}

/** True when a range edge falls strictly inside a beat of one of its lanes. */
export function rangeCutsBeat(score:model.Score,range:BeatRange):boolean {
  for(const lane of range.lanes)for(const point of cutPoints(range)){
    const voice=score.tracks[lane.track]?.staves[lane.staff]?.bars[point.bar]?.voices[lane.voice];
    if(voice&&straddling(voice,point.tick))return true;
  }
  return false;
}

/**
 * Note fields that describe how the note sounds for its whole length; every piece carries them.
 * Everything else on a note is an attack mark and stays on the first piece, or is refused (bend, trill, dead),
 * or moves with the outgoing link to the last piece (slide out, hammer or pull, tie, slur).
 * Fields not listed (ids, indices, link pointers, derived getters, `style`) are bookkeeping.
 */
const noteFields=['string','fret','octave','tone','percussionArticulation','harmonicType','harmonicValue','accidentalMode','dynamics','isPalmMute','isLetRing','vibrato','isGhost','durationPercent'] as const;
/** Beat fields that last the whole beat: dynamics, vibrato, octave sign, hairpin, tremolo picking, slash notation, wah pedal. */
const beatFields=['dynamics','vibrato','ottava','crescendo','slashed','wahPedal'] as const;
function refuseUnsplittable(beat:model.Beat) {
  if(beat.overrideDisplayDuration!==undefined)throw new Error('A beat with an overridden written length cannot be split at the range edge. Select whole beats.');
  if(beat.whammyBarPoints?.length)throw new Error('A beat with a whammy bar cannot be split at the range edge. Select whole beats.');
  for(const note of beat.notes){
    if(note.bendType!==model.BendType.None||note.bendPoints?.length||note.isContinuedBend||note.bendOrigin)throw new Error('A bent note cannot be split at the range edge. Select whole beats.');
    if(note.trillValue>=0)throw new Error('A trilled note cannot be split at the range edge. Select whole beats.');
    if(note.isDead)throw new Error('A dead note cannot be split at the range edge. Select whole beats.');
  }
}
/** Written length of a detached piece, computed the way `rhythmTicks` does for a placed beat. */
function writtenTicks(piece:model.Beat) {
  const base=Math.trunc(3840/(piece.duration<0?1/-piece.duration:piece.duration));let ticks=base;for(let dot=1;dot<=piece.dots;dot++)ticks+=Math.trunc(base/2**dot);
  return piece.tupletNumerator>0&&piece.tupletDenominator>0?Math.trunc(ticks*piece.tupletDenominator/piece.tupletNumerator):ticks;
}
/** Written values a person would write: plain or single-dotted, whole note down to a 64th. */
const written=[1,2,4,8,16,32,64].flatMap(duration=>[0,1].map(dots=>{const base=3840/duration;return {duration,dots,ticks:base+base/2*dots};})).sort((a,b)=>b.ticks-a.ticks);
/** The fewest written values that add up to `ticks` exactly, longest first, or null. */
function decompose(ticks:number):Array<{duration:number;dots:number}>|null {
  if(!Number.isInteger(ticks)||ticks<=0)return null;
  const best=new Array<number>(ticks+1).fill(-1),count=new Array<number>(ticks+1).fill(Infinity);count[0]=0;
  for(let amount=1;amount<=ticks;amount++)for(let index=0;index<written.length;index++){const previous=amount-written[index].ticks;if(previous>=0&&count[previous]+1<count[amount]){count[amount]=count[previous]+1;best[amount]=index;}}
  if(best[ticks]<0)return null;
  const result=[];for(let amount=ticks;amount>0;amount-=written[best[amount]].ticks)result.push({duration:written[best[amount]].duration,dots:written[best[amount]].dots});
  return result.sort((a,b)=>(3840/b.duration)*(1+b.dots/2)-(3840/a.duration)*(1+a.dots/2));
}
/** Exact written pieces for `ticks`; a tuplet beat keeps its ratio so its pieces stay inside the group. */
function pieces(beat:model.Beat,ticks:number,total:number):model.Beat[] {
  const refuse=()=>new Error(`The sustained beat cannot be cut at the range edge: ${ticks} of its ${total} ticks have no exact written length.`);
  const tuplet=beat.tupletNumerator>0&&beat.tupletDenominator>0,nominal=tuplet?ticks*beat.tupletNumerator/beat.tupletDenominator:ticks,values=decompose(nominal);
  if(!values)throw refuse();
  if(values.length>MAX_PIECES_PER_SIDE)throw new Error(`The sustained beat cannot be cut at the range edge: ${ticks} of its ${total} ticks would need more than ${MAX_PIECES_PER_SIDE} tied notes.`);
  const result=values.map(value=>Object.assign(new model.Beat(),{duration:value.duration,dots:value.dots,isEmpty:false,...tuplet?{tupletNumerator:beat.tupletNumerator,tupletDenominator:beat.tupletDenominator}:{}}));
  if(result.reduce((acc,piece)=>acc+writtenTicks(piece),0)!==ticks)throw refuse();
  return result;
}

/**
 * Cut the beat at `tick` into tied pieces of exact written lengths, in place on a detached working copy.
 * The first piece is the original beat and keeps every beat property. Techniques on notes stay on it, except
 * that outgoing ties, slurs, slides and hammer or pull links leave from the final piece, where the sound ends.
 */
function splitBeat(found:Straddle,tick:number,ids:{beat:number;note:number}) {
  const {beat,start,length}=found,voice=beat.voice;refuseUnsplittable(beat);
  if(voice.bar.masterBar.isFreeTime)throw new Error('A sustained beat in a free-time measure cannot be split at the range edge.');
  const before=pieces(beat,tick-start,length),after=pieces(beat,start+length-tick,length),sequence=[...before,...after];
  const first=sequence[0];beat.duration=first.duration;beat.dots=first.dots;beat.tupletNumerator=first.tupletNumerator;beat.tupletDenominator=first.tupletDenominator;
  if(!beat.tupletNumerator||beat.tupletNumerator<=0){beat.tupletNumerator=-1;beat.tupletDenominator=-1;}
  const chain:model.Beat[]=[beat];
  for(const piece of sequence.slice(1)){
    const next=new model.Beat();next.id=++ids.beat;next.duration=piece.duration;next.dots=piece.dots;next.tupletNumerator=piece.tupletNumerator;next.tupletDenominator=piece.tupletDenominator;next.isEmpty=false;for(const key of beatFields)Object.assign(next,{[key]:beat[key]});if(beat.tremoloPicking)next.tremoloPicking=Object.assign(new model.TremoloPickingEffect(),beat.tremoloPicking);
    chain.push(next);
  }
  const last=chain[chain.length-1];
  for(const origin of beat.notes){
    const outgoing={tie:origin.tieDestination,slur:origin.slurDestination,slide:origin.slideTarget,slideOut:origin.slideOutType,hammer:origin.hammerPullDestination,hammerOrigin:origin.isHammerPullOrigin};
    let previous=origin;
    for(const piece of chain.slice(1)){
      const note=new model.Note();note.id=++ids.note;for(const key of noteFields)Object.assign(note,{[key]:origin[key]});
      piece.addNote(note);note.tieOrigin=previous;previous.tieDestination=note;note.isTieDestination=true;previous=note;
    }
    if(previous!==origin){
      const tail=previous;
      // The original outgoing tie now leaves from the tail; the chain tie from the origin was installed above.
      if(outgoing.tie){tail.tieDestination=outgoing.tie;outgoing.tie.tieOrigin=tail;}
      if(outgoing.slur){origin.slurDestination=null;tail.slurDestination=outgoing.slur;outgoing.slur.slurOrigin=tail;}
      if(outgoing.slide||outgoing.slideOut!==model.SlideOutType.None){origin.slideTarget=null;origin.slideOutType=model.SlideOutType.None;tail.slideOutType=outgoing.slideOut;if(outgoing.slide){tail.slideTarget=outgoing.slide;outgoing.slide.slideOrigin=tail;}}
      if(outgoing.hammer||outgoing.hammerOrigin){origin.hammerPullDestination=null;origin.isHammerPullOrigin=false;tail.isHammerPullOrigin=outgoing.hammerOrigin;if(outgoing.hammer){tail.hammerPullDestination=outgoing.hammer;outgoing.hammer.hammerPullOrigin=tail;}}
    }
  }
  const index=voice.beats.indexOf(beat),following=beat.nextBeat;
  voice.beats.splice(index,1,...chain);
  voice.beats.forEach((item,position)=>{item.index=position;item.voice=voice;});
  chain.forEach((item,position)=>{item.previousBeat=position===0?beat.previousBeat:chain[position-1];item.nextBeat=position===chain.length-1?following:chain[position+1];});
  if(following)following.previousBeat=last;
}

/**
 * A detached copy of `score` whose beats are cut at both range edges, so the copied phrase holds exactly the
 * selected time. Returns `score` itself when no lane has a beat that an edge falls inside.
 */
export function subdivideRange(score:model.Score,range:BeatRange):model.Score {
  if(!rangeCutsBeat(score,range))return score;
  const work=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());restoreNoteLinks(work,captureNoteLinks(score));copyGpInterchangeSource(score,work);
  const ids={beat:0,note:0};
  for(const track of work.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats){ids.beat=Math.max(ids.beat,beat.id);for(const note of beat.notes)ids.note=Math.max(ids.note,note.id);}
  for(const lane of range.lanes)for(const point of cutPoints(range)){
    const voice=work.tracks[lane.track].staves[lane.staff].bars[point.bar].voices[lane.voice],found=straddling(voice,point.tick);
    if(found)splitBeat(found,point.tick,ids);
  }
  return work;
}
