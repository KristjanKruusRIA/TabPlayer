import { model,Settings } from '@coderline/alphatab';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { midiPrograms } from '../midi-programs';
import type { MidiSong } from './midi-smf';

/** Smallest note value a note may start or stop on, as the denominator of a whole note. */
export type MidiQuantization=4|8|16|32|64;
export type MidiTupletMode='none'|'triplets'|'triplets-quintuplets';
export interface MidiImportOptions {
  quantization:MidiQuantization;
  tuplets:MidiTupletMode;
  /** The most voices a track may use for overlapping notes. */
  voices:1|2|3|4;
  /** Guitar and bass programs become tablature staves when every note can be fingered. */
  tablature:boolean;
}
export const defaultMidiImportOptions:MidiImportOptions={quantization:16,tuplets:'triplets',voices:2,tablature:true};

export type MidiTrackKind='guitar'|'bass'|'keys'|'drums';
export interface MidiImportSummary {
  title:string;format:0|1;measures:number;tempo:number;
  tracks:{name:string;kind:MidiTrackKind;program:number;notes:number;voices:number}[];
  /** Short sentences about what the import changed or left out. */
  notes:string[];
}
export interface MidiImport {score:model.Score;summary:MidiImportSummary}

const MEASURE_LIMIT=3000,TRACK_LIMIT=32,NAME_BYTES=190;
/** Units per whole note: divisible by every note value to a 64th and by 3 and 5, so tuplets stay whole numbers. */
const WHOLE=960,SPAN=WHOLE/4;
const settings=new Settings();
const fail=(message:string):never=>{throw new Error(message);};

/** Open strings from the lowest, as MIDI keys. */
const guitarStrings=[40,45,50,55,59,64],bassStrings=[28,33,38,43];
const percussionKeys=new Set(standardPercussionCatalog.map(entry=>entry.id).filter(id=>id>=35&&id<=81));

interface Bar {start:number;length:number;numerator:number;denominator:number}
interface Lattice {step:number;n:number;m:number}
interface Hit {key:number;start:number;end:number}
interface Chord {start:number;end:number;keys:number[];voice:number}
interface Source {name:string;channel:number;program:number;percussion:boolean;notes:{key:number;start:number;end:number}[];laterPrograms:number}
interface Stats {shortened:number;merged:number}

const tuplet=(step:number,n:number,m:number):Lattice=>({step,n,m});

function buildBars(song:MidiSong,notes:string[]):Bar[] {
  const wholeTicks=song.division*4,bars:Bar[]=[];
  const meters=song.meters.filter(meter=>meter.numerator>=1&&meter.numerator<=32&&meter.denominator>=1&&meter.denominator<=32);
  if(meters.length<song.meters.length)notes.push('time signatures this import cannot write were skipped');
  let tick=0,start=0,next=0,numerator=4,denominator=4,deferred=0;
  do{
    // A time signature that starts inside a bar takes effect at the next bar line.
    while(next<meters.length&&meters[next].tick<=tick){
      if(meters[next].tick<tick)deferred++;
      numerator=meters[next].numerator;denominator=meters[next].denominator;next++;
    }
    const length=numerator*WHOLE/denominator;
    bars.push({start,length,numerator,denominator});
    if(bars.length>MEASURE_LIMIT)fail(`MIDI import is limited to ${MEASURE_LIMIT} measures.`);
    start+=length;tick=Math.round(start*wholeTicks/WHOLE);
  }while(tick<song.endTick);
  if(deferred)notes.push(`${deferred} time signature ${deferred===1?'change that started':'changes that started'} inside a measure moved to the next bar line`);
  return bars;
}

const barIndex=(bars:Bar[],unit:number)=>{
  let low=0,high=bars.length-1;
  while(low<high){const middle=(low+high+1)>>1;if(bars[middle].start<=unit)low=middle;else high=middle-1;}
  return low;
};

interface Grid {bars:Bar[];straight:Lattice;lattices:Map<number,Lattice>}

/** Chooses, for each quarter note of a track, whether its onsets fit the straight grid or a tuplet grid better. */
function chooseLattices(grid:Grid,hits:Hit[],options:MidiImportOptions) {
  const step=WHOLE/options.quantization,candidates=[grid.straight];
  if(options.tuplets!=='none'&&options.quantization>=8)candidates.push(tuplet(step*2/3,3,2));
  if(options.tuplets==='triplets-quintuplets'&&options.quantization>=16)candidates.push(tuplet(step*4/5,5,4));
  if(candidates.length===1)return;
  const votes=new Map<number,number[]>();
  const vote=(unit:number)=>{
    const bar=grid.bars[barIndex(grid.bars,unit)],span=Math.floor((unit-bar.start)/SPAN),at=bar.start+span*SPAN;
    if((span+1)*SPAN>bar.length)return;
    const list=votes.get(at);if(list)list.push(unit-at);else votes.set(at,[unit-at]);
  };
  for(const hit of hits){vote(hit.start);vote(hit.end);}
  for(const [at,offsets] of votes){
    const cost=(lattice:Lattice)=>offsets.reduce((sum,offset)=>sum+Math.abs(offset-Math.round(offset/lattice.step)*lattice.step),0)
      +(lattice.n===0?0:(lattice.n===3?0.06:0.1)*step*(offsets.length+1));
    let best=grid.straight,bestCost=cost(best);
    for(const lattice of candidates.slice(1)){const value=cost(lattice);if(value<bestCost){best=lattice;bestCost=value;}}
    if(best!==grid.straight)grid.lattices.set(at,best);
  }
}

/** Start of the quarter-note span holding a unit, counted from its bar line. */
function spanStart(bars:Bar[],unit:number):number {
  const bar=bars[barIndex(bars,unit)];
  return bar.start+Math.floor((unit-bar.start)/SPAN)*SPAN;
}

function snap(grid:Grid,unit:number):number {
  const at=spanStart(grid.bars,unit),lattice=grid.lattices.get(at)??grid.straight;
  return at+Math.round((unit-at)/lattice.step)*lattice.step;
}

/** Sorted by start; notes that start together and last as long join one chord, the rest go to free voices. */
function placeChords(hits:Hit[],limit:number,stats:Stats):Chord[] {
  const lanes:Chord[][]=Array.from({length:limit},()=>[]);
  const ordered=[...hits].sort((a,b)=>a.start-b.start||b.key-a.key||a.end-b.end);
  for(const hit of ordered){
    const lastOf=(voice:number)=>lanes[voice].at(-1);
    let target=lanes.findIndex(lane=>{const last=lane.at(-1);return !!last&&last.start===hit.start&&last.end===hit.end&&!last.keys.includes(hit.key);});
    if(target<0)target=lanes.findIndex(lane=>!lane.length||lane.at(-1)!.end<=hit.start);
    if(target>=0){
      const last=lastOf(target);
      if(last&&last.start===hit.start&&last.end===hit.end)last.keys.push(hit.key);
      else lanes[target].push({start:hit.start,end:hit.end,keys:[hit.key],voice:target});
      continue;
    }
    // Every voice is busy. A note starting with a chord joins it; otherwise the voice that frees soonest is cut short.
    const sameStart=lanes.findIndex(lane=>lane.at(-1)!.start===hit.start);
    if(sameStart>=0){const chord=lastOf(sameStart)!;if(!chord.keys.includes(hit.key)){chord.keys.push(hit.key);if(chord.end!==hit.end)stats.merged++;}continue;}
    let victim=0;for(let voice=1;voice<lanes.length;voice++)if(lastOf(voice)!.end<lastOf(victim)!.end)victim=voice;
    lastOf(victim)!.end=hit.start;stats.shortened++;
    lanes[victim].push({start:hit.start,end:hit.end,keys:[hit.key],voice:victim});
  }
  return lanes.flat().sort((a,b)=>a.start-b.start||a.voice-b.voice);
}

/** Fingers every chord on the strings: low frets, near the previous chord, and no string sounding twice. Null when a chord cannot be played. */
function fingerChords(chords:Chord[],open:number[]):Map<Chord,Map<number,number>>|null {
  const result=new Map<Chord,Map<number,number>>(),busy=open.map(()=>0);let reference=5;
  for(const chord of chords){
    const keys=[...chord.keys].sort((a,b)=>b-a);
    const attempt=(respect:boolean):Map<number,number>|null=>{
      const used=new Set<number>(),chosen=new Map<number,number>();
      const search=(index:number):boolean=>{
        if(index===keys.length)return true;
        const key=keys[index];
        const options=open.flatMap((pitch,string)=>key>=pitch&&key-pitch<=24&&!used.has(string)&&(!respect||busy[string]<=chord.start)?[{string,fret:key-pitch}]:[])
          .sort((a,b)=>Math.abs(a.fret-reference)+a.fret/4-(Math.abs(b.fret-reference)+b.fret/4));
        for(const option of options){used.add(option.string);chosen.set(key,option.string);if(search(index+1))return true;used.delete(option.string);chosen.delete(key);}
        return false;
      };
      return search(0)?chosen:null;
    };
    const chosen=attempt(true)??attempt(false);
    if(!chosen)return null;
    result.set(chord,chosen);
    let total=0;for(const [key,string] of chosen){total+=key-open[string];busy[string]=chord.end;}
    reference=total/chosen.size;
  }
  return result;
}

const straightValues:[number,number,number][]=[[1440,1,1],[960,1,0],[720,2,1],[480,2,0],[360,4,1],[240,4,0],[180,8,1],[120,8,0],[90,16,1],[60,16,0],[45,32,1],[30,32,0],[15,64,0]];
function straightParts(length:number):{den:number;dots:number}[] {
  const parts:{den:number;dots:number}[]=[];
  while(length>0){
    const value=straightValues.find(entry=>entry[0]<=length);
    if(!value)return fail('A rhythm in this file does not fit a 64th-note grid.');
    parts.push({den:value[1],dots:value[2]});length-=value[0];
  }
  return parts;
}
const slotCounts=[24,16,12,8,6,4,3,2,1];
function tupletParts(slots:number,quantization:number):{den:number;dots:number}[] {
  const parts:{den:number;dots:number}[]=[];
  while(slots>0){
    const count=slotCounts.find(entry=>entry<=slots)!,dotted=count%3===0,base=dotted?count/3*2:count;
    parts.push({den:quantization/base,dots:dotted?1:0});slots-=count;
  }
  return parts;
}

interface Piece {start:number;end:number;chord:Chord|null;tied:boolean}

function splitAt(segments:Piece[],cuts:number[]):Piece[] {
  const result:Piece[]=[];
  for(const segment of segments){
    let start=segment.start,tied=segment.tied;
    let low=0,high=cuts.length;while(low<high){const middle=(low+high)>>1;if(cuts[middle]<=start)low=middle+1;else high=middle;}
    for(let index=low;index<cuts.length&&cuts[index]<segment.end;index++){
      result.push({start,end:cuts[index],chord:segment.chord,tied});start=cuts[index];tied=!!segment.chord;
    }
    result.push({start,end:segment.end,chord:segment.chord,tied});
  }
  return result;
}

function programName(program:number,percussion:boolean){return percussion?'Drums':midiPrograms[program]??`Instrument ${program+1}`;}

function plan(song:MidiSong,notes:string[]):Source[] {
  const sources:Source[]=[];
  for(const part of song.parts){
    const channels=[...new Set(part.notes.map(note=>note.channel))].sort((a,b)=>a-b);
    for(const channel of channels){
      const mine=part.notes.filter(note=>note.channel===channel),first=mine.reduce((least,note)=>Math.min(least,note.start),Infinity);
      const changes=part.programs.filter(change=>change.channel===channel).sort((a,b)=>a.tick-b.tick);
      const before=changes.filter(change=>change.tick<=first).at(-1)??changes[0],program=before?.program??0;
      const percussion=channel===9,label=programName(program,percussion);
      const name=channels.length>1?(part.name?`${part.name} (${label})`:label):part.name||label;
      sources.push({name,channel,program,percussion,laterPrograms:changes.filter(change=>change.tick>(before?.tick??0)&&change.program!==program).length,notes:mine.map(note=>({key:note.key,start:note.start,end:note.end}))});
    }
  }
  if(sources.length>TRACK_LIMIT)fail(`MIDI import is limited to ${TRACK_LIMIT} instrument parts; this file has ${sources.length}.`);
  const later=sources.reduce((sum,source)=>sum+source.laterPrograms,0);
  if(later)notes.push(`${later} instrument ${later===1?'change':'changes'} after the start of a part ${later===1?'was':'were'} not imported`);
  return sources;
}

function note(key:number,string:number|undefined,open:number[]|null,percussion:boolean,tied:boolean):model.Note {
  const value=new model.Note();
  if(percussion)value.percussionArticulation=key;
  else if(string!==undefined&&open){value.string=string+1;value.fret=key-open[string];}
  else{value.octave=Math.floor(key/12);value.tone=key%12;}
  if(tied)value.isTieDestination=true;
  return value;
}

const emptyVoice=()=>{const voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;voice.addBeat(beat);return voice;};

/** Converts a parsed MIDI file into an editable score: quantized rhythm, tuplets, voices, programs and tempo. */
export function importMidi(song:MidiSong,options:MidiImportOptions=defaultMidiImportOptions,fallbackTitle=''):MidiImport {
  const notes:string[]=[],bars=buildBars(song,notes),wholeTicks=song.division*4,toUnits=(tick:number)=>tick*WHOLE/wholeTicks;
  const total=bars.at(-1)!.start+bars.at(-1)!.length,stats:Stats={shortened:0,merged:0};
  const sources=plan(song,notes);
  const score=new model.Score();score.title=song.title||fallbackTitle;score.artist='';
  for(const bar of bars){const master=new model.MasterBar();master.timeSignatureNumerator=bar.numerator;master.timeSignatureDenominator=bar.denominator;score.addMasterBar(master);}

  // Tempo: bar-level automations at the bar-relative position of each change.
  // Until the first tempo event a MIDI file plays at 120 BPM.
  const tempos=song.tempos[0]?.tick===0?song.tempos:[{tick:0,microsPerQuarter:500000},...song.tempos];
  let lastTempo=0,firstTempo=120;
  for(const tempo of tempos){
    const bpm=Math.max(1,Math.min(999,Math.round(60e6/tempo.microsPerQuarter)));
    if(bpm===lastTempo)continue;
    const unit=toUnits(tempo.tick),bar=barIndex(bars,unit),ratio=Math.min(0.999,Math.max(0,(unit-bars[bar].start)/bars[bar].length));
    score.masterBars[bar].tempoAutomations.push(model.Automation.buildTempoAutomation(false,Math.round(ratio*1000)/1000,bpm,2));
    if(!lastTempo)firstTempo=bpm;
    lastTempo=bpm;
  }
  const summary:MidiImportSummary['tracks']=[];let used=0,unplayable=0,dropped=0;
  const channelsInUse=new Set<number>([9]);
  const nextChannel=()=>{let value=0;while(channelsInUse.has(value))value++;channelsInUse.add(value);return value;};
  for(const source of sources){
    const straight=tuplet(WHOLE/options.quantization,0,0),grid:Grid={bars,straight,lattices:new Map()};
    let hits:Hit[]=source.notes.map(item=>({key:item.key,start:toUnits(item.start),end:toUnits(item.end)}));
    if(source.percussion){
      const before=hits.length;hits=hits.filter(hit=>percussionKeys.has(hit.key));dropped+=before-hits.length;
    }
    if(!hits.length)continue;
    chooseLattices(grid,hits,options);
    const quantum=straight.step;
    hits=hits.map(hit=>{
      const start=snap(grid,hit.start);let end=snap(grid,hit.end);
      if(end<=start)end=start+(grid.lattices.get(spanStart(bars,start))?.step??quantum);
      return {key:hit.key,start,end:Math.min(end,total)};
    }).filter(hit=>hit.end>hit.start);
    if(source.percussion){
      // A drum hit has no useful length: it lasts until the next hit, up to the end of its quarter note.
      const onsets=[...new Set(hits.map(hit=>hit.start))].sort((a,b)=>a-b);
      hits=hits.map(hit=>{const next=onsets.find(onset=>onset>hit.start);return {key:hit.key,start:hit.start,end:Math.min(spanStart(bars,hit.start)+SPAN,next??total,total)};});
    }
    const merged=new Map<string,Hit>();for(const hit of hits){const id=`${hit.key}/${hit.start}`,other=merged.get(id);if(!other||hit.end>other.end)merged.set(id,hit);}
    hits=[...merged.values()];
    const chords=placeChords(hits,source.percussion?1:options.voices,stats);
    const voicesUsed=chords.reduce((most,chord)=>Math.max(most,chord.voice),0)+1;

    // Kind of staff.
    const program=source.program;
    let kind:MidiTrackKind=source.percussion?'drums':'keys',open:number[]|null=null,fingering:Map<Chord,Map<number,number>>|null=null;
    if(!source.percussion&&options.tablature&&program>=24&&program<=39){
      const strings=program>=32?bassStrings:guitarStrings;
      fingering=fingerChords(chords,strings);
      if(fingering){open=strings;kind=program>=32?'bass':'guitar';}else unplayable++;
    }

    // Spans written as tuplets are those where some note starts or stops off the straight grid.
    const edges=new Map<number,boolean>();
    for(const chord of chords)for(const point of [chord.start,chord.end]){
      const at=spanStart(bars,point);
      if(grid.lattices.has(at)&&point>at&&point<at+SPAN&&(point-at)%quantum!==0)edges.set(at,true);
    }
    const notated=[...edges.keys()].sort((a,b)=>a-b),cuts=[...bars.map(bar=>bar.start),...notated.flatMap(at=>[at,at+SPAN])];
    const cutPoints=[...new Set(cuts)].sort((a,b)=>a-b);

    const track=new model.Track();track.name=source.name;track.shortName=source.name.slice(0,12);
    track.playbackInfo.program=source.percussion?0:program;
    track.playbackInfo.primaryChannel=source.percussion?9:nextChannel();track.playbackInfo.secondaryChannel=source.percussion?9:nextChannel();
    const staff=new model.Staff();
    staff.isPercussion=source.percussion;staff.showStandardNotation=true;staff.showTablature=!!open;
    if(open)staff.stringTuning.tunings=[...open].reverse();
    track.addStaff(staff);score.addTrack(track);
    const keysAll=hits.map(hit=>hit.key).sort((a,b)=>a-b),median=keysAll[keysAll.length>>1];
    const clef=source.percussion?model.Clef.Neutral:median<57?model.Clef.F4:model.Clef.G2;

    const timelines:Piece[][]=Array.from({length:voicesUsed},(_,voice)=>{
      const pieces:Piece[]=[];let cursor=0;
      for(const chord of chords.filter(item=>item.voice===voice)){
        if(chord.start>cursor)pieces.push({start:cursor,end:chord.start,chord:null,tied:false});
        pieces.push({start:chord.start,end:chord.end,chord,tied:false});cursor=chord.end;
      }
      if(cursor<total)pieces.push({start:cursor,end:total,chord:null,tied:false});
      return splitAt(pieces,cutPoints);
    });
    const pointers=timelines.map(()=>0);
    for(const bar of bars){
      const barEnd=bar.start+bar.length,staffBar=new model.Bar();staffBar.clef=clef;
      for(const [voiceIndex,timeline] of timelines.entries()){
        const voice=new model.Voice(),beats:model.Beat[]=[];let sounded=false;
        while(pointers[voiceIndex]<timeline.length&&timeline[pointers[voiceIndex]].start<barEnd){
          const piece=timeline[pointers[voiceIndex]++],at=spanStart(bars,piece.start);
          const lattice=edges.has(at)&&piece.end<=at+SPAN?grid.lattices.get(at)!:null;
          const parts=lattice?tupletParts((piece.end-piece.start)/lattice.step,options.quantization):straightParts(piece.end-piece.start);
          for(const [partIndex,part] of parts.entries()){
            const beat=new model.Beat();beat.duration=part.den as model.Duration;beat.dots=part.dots;
            if(lattice){beat.tupletNumerator=lattice.n;beat.tupletDenominator=lattice.m;}
            if(piece.chord){
              sounded=true;
              const fingers=fingering?.get(piece.chord);
              for(const keyValue of [...piece.chord.keys].sort((a,b)=>a-b))beat.addNote(note(keyValue,fingers?.get(keyValue),open,source.percussion,piece.tied||partIndex>0));
            }
            beats.push(beat);
          }
        }
        if(voiceIndex>0&&!sounded){staffBar.addVoice(emptyVoice());continue;}
        for(const beat of beats)voice.addBeat(beat);
        staffBar.addVoice(voice);
      }
      staff.addBar(staffBar);
    }
    used+=hits.length;
    summary.push({name:source.name,kind,program:source.percussion?0:program,notes:hits.length,voices:voicesUsed});
  }
  if(!summary.length)fail('This MIDI file has no notes this import can read.');
  if(unplayable)notes.push(`${unplayable} guitar or bass ${unplayable===1?'part has':'parts have'} notes that cannot be fingered on strings, so ${unplayable===1?'it was':'they were'} imported as notation only`);
  if(dropped)notes.push(`${dropped} drum ${dropped===1?'note':'notes'} on sounds without a drum symbol ${dropped===1?'was':'were'} skipped`);
  if(stats.shortened)notes.push(`${stats.shortened} ${stats.shortened===1?'note was':'notes were'} cut short where more notes overlapped than the voices allow`);
  if(stats.merged)notes.push(`${stats.merged} ${stats.merged===1?'note was':'notes were'} given the length of the chord it starts with`);
  // Key signatures carry on from the bar they start in. The setter reads the staves, so it runs once they exist.
  let key=0,minor=false,keyIndex=0;const keys=song.keys;
  for(const [index,master] of score.masterBars.entries()){
    while(keyIndex<keys.length&&toUnits(keys[keyIndex].tick)<=bars[index].start+bars[index].length/2){key=Math.max(-7,Math.min(7,keys[keyIndex].sharps));minor=keys[keyIndex].minor;keyIndex++;}
    master.keySignature=key as model.KeySignature;master.keySignatureType=minor?model.KeySignatureType.Minor:model.KeySignatureType.Major;
  }

  score.finish(settings);
  return {score,summary:{title:score.title,format:song.format,measures:bars.length,tempo:firstTempo,tracks:summary,notes}};
}

/** The score file name for an import: the MIDI file's name with a .gp extension, short enough for the native limit. */
export function midiImportFileName(source:string):string {
  let base=source.replace(/\.[^.\\/]*$/,'').replace(/[\\/:*?"<>|\p{Cc}]+/gu,' ').trim();
  const encoder=new TextEncoder();
  while(encoder.encode(base).length>NAME_BYTES)base=[...base].slice(0,-1).join('').trimEnd();
  return `${base||'Imported MIDI'}.gp`;
}
