import { model,Settings } from '@coderline/alphatab';
import type { DrumMapRef } from '../edit-types';
import { resolveInputDrumMap } from '../audio/drum-map';
import type { MessageKey } from '../i18n';
import { midiPrograms } from '../midi-programs';
import { stripCdataEnd,type MidiSong } from './midi-smf';
import {
  MEASURE_LIMIT,
  SPAN,
  WHOLE,
  barIndex,
  buildTargetBars as buildTargetRhythmBars,
  createRhythmGrid,
  placeChords,
  safeScoreFileName,
  snapHitsToGrid,
  type RhythmBar,
  type RhythmQuantization,
  type RhythmStats,
  type RhythmTupletMode,
  type TargetBar,
  type TimedHit,
  writeQuantizedStaffBars,
} from './quantize-bars';

/** Smallest note value a note may start or stop on, as the denominator of a whole note. */
export type MidiQuantization = RhythmQuantization;
export type MidiTupletMode = RhythmTupletMode;
export type MidiTargetBar = TargetBar;
export interface MidiPartInfo {
  index:number;name:string;channel:number;program:number;defaultPercussion:boolean;
  noteCount:number;keys:readonly {key:number;count:number}[];
}
export type MidiPartInstrument='auto'|'guitar'|'bass'|'keys'|'drums';
export interface MidiPartOverride {
  kind?:MidiTrackKind;
  program?:number;
  /** Open string MIDI pitches, highest string first (matching `staff.tuning` and `tuningPresets`). */
  tuning?:readonly number[];
  /** Whole-octave transpose applied to incoming note keys before fingering or notation (e.g. `-1` for Kontakt C3=60 exports). */
  octaveShift?:number;
}
export interface MidiImportOptions {
  quantization:MidiQuantization;
  tuplets:MidiTupletMode;
  /** The most voices a track may use for overlapping notes. */
  voices:1|2|3|4;
  /** Guitar and bass programs become tablature staves when every note can be fingered. */
  tablature:boolean;
  /** Use the MIDI meter map for a new score. When false, quantize in 4/4. */
  importTimeSignatures?:boolean;
  importKeySignatures?:boolean;
  importTempo?:boolean;
  /** 0-based planned part indices forced to percussion even if not on MIDI channel 10. */
  drumParts?:readonly number[];
  /** When present, only these 0-based planned part indices are imported. */
  selectedParts?:readonly number[];
  /** Per-part instrument kind, GM program and tuning overrides indexed by 0-based planned part index. */
  partOverrides?:Readonly<Record<number,MidiPartOverride>>;
  /** Source drum map translating incoming drum MIDI keys to standard articulations (General MIDI when absent). */
  drumMap?:DrumMapRef;
  /** Per-key overrides applied on top of `drumMap` (`null` skips that incoming MIDI key). */
  drumKeyOverrides?:Readonly<Record<number,number|null>>;
  /** Existing score measure time signatures to quantize against instead of reading meters from the MIDI file. */
  targetBars?:readonly MidiTargetBar[];
}
export const defaultMidiImportOptions:MidiImportOptions={quantization:16,tuplets:'triplets',voices:2,tablature:true};

export type MidiTrackKind='guitar'|'bass'|'keys'|'drums';
export type MidiImportNote=
  |{code:'unsupported_meters'}
  |{code:'deferred_meters';count:number}
  |{code:'later_instruments';count:number}
  |{code:'unplayable_tab';count:number}
  |{code:'dropped_drum_notes';count:number}
  |{code:'shortened_notes';count:number}
  |{code:'merged_notes';count:number}
  |{code:'appended_measures';count:number};
export interface MidiImportSummary {
  title:string;format:0|1;measures:number;tempo:number;
  tracks:{partIndex?:number;name:string;kind:MidiTrackKind;program:number;notes:number;voices:number}[];
  /** Short sentences about what the import changed or left out. */
  notes:MidiImportNote[];
}
export interface MidiImport {score:model.Score;summary:MidiImportSummary}

const TRACK_LIMIT=32;
const settings=new Settings();
const fail=(message:string):never=>{throw new Error(message);};

/** Open strings from the lowest, as MIDI keys. */
const guitarStrings=[40,45,50,55,59,64],bassStrings=[28,33,38,43];

type Bar = RhythmBar;
type Hit = TimedHit;
type Stats = RhythmStats;
interface Chord {start:number;end:number;keys:number[];voice:number}
interface Source {partIndex:number;displayName:string;rawPartName:string;multiChannel:boolean;channel:number;program:number;percussion:boolean;notes:{key:number;start:number;end:number}[];laterPrograms:number}

function buildBars(song:MidiSong,notes:MidiImportNote[],importTimeSignatures:boolean):Bar[] {
  const wholeTicks=song.division*4,bars:Bar[]=[];
  const sourceMeters=importTimeSignatures?song.meters:[];
  const meters=sourceMeters.filter(meter=>meter.numerator>=1&&meter.numerator<=32&&meter.denominator>=1&&meter.denominator<=32);
  if(meters.length<sourceMeters.length)notes.push({code:'unsupported_meters'});
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
  if(deferred)notes.push({code:'deferred_meters',count:deferred});
  return bars;
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

function programName(program:number,percussion:boolean){return percussion?'Drums':midiPrograms[program]??`Instrument ${program+1}`;}

function sourceDisplayName(rawPartName:string,multiChannel:boolean,program:number,percussion:boolean):string {
  const label=programName(program,percussion);
  return multiChannel?(rawPartName?`${rawPartName} (${label})`:label):rawPartName||label;
}

function plan(song:MidiSong):Source[] {
  const sources:Source[]=[];
  for(const part of song.parts){
    const channels=[...new Set(part.notes.map(note=>note.channel))].sort((a,b)=>a-b);
    const multiChannel=channels.length>1;
    for(const channel of channels){
      const mine=part.notes.filter(note=>note.channel===channel),first=mine.reduce((least,note)=>Math.min(least,note.start),Infinity);
      const changes=song.programs.filter(change=>change.channel===channel);
      const before=changes.filter(change=>change.tick<=first).at(-1)??changes[0],program=before?.program??0;
      const percussion=channel===9,displayName=sourceDisplayName(part.name,multiChannel,program,percussion);
      sources.push({partIndex:sources.length,displayName,rawPartName:part.name,multiChannel,channel,program,percussion,laterPrograms:changes.filter(change=>change.tick>(before?.tick??0)&&change.program!==program).length,notes:mine.map(note=>({key:note.key,start:note.start,end:note.end}))});
    }
  }
  if(sources.length>TRACK_LIMIT)fail(`MIDI import is limited to ${TRACK_LIMIT} instrument parts; this file has ${sources.length}.`);
  return sources;
}

/** Lists every instrument part (MIDI track + channel) in the file along with the MIDI keys it uses and their hit counts. */
export function inspectMidiParts(song:MidiSong):MidiPartInfo[] {
  return plan(song).map(source=>{
    const counts=new Map<number,number>();
    for(const item of source.notes)counts.set(item.key,(counts.get(item.key)??0)+1);
    const keys=[...counts.entries()].sort((a,b)=>a[0]-b[0]).map(([key,count])=>({key,count}));
    return {
      index:source.partIndex,name:source.displayName,channel:source.channel,program:source.program,
      defaultPercussion:source.percussion,noteCount:source.notes.length,keys,
    };
  });
}

function buildTargetBars(targetBars:readonly MidiTargetBar[],maxNoteStart:number,quantization:MidiQuantization,notes:MidiImportNote[]):Bar[] {
  const built=buildTargetRhythmBars(targetBars,maxNoteStart,quantization,`MIDI import is limited to ${MEASURE_LIMIT} measures.`);
  if(built.appended)notes.push({code:'appended_measures',count:built.appended});
  return built.bars;
}

function note(key:number,string:number|undefined,open:number[]|null,percussion:boolean,tied:boolean):model.Note {
  const value=new model.Note();
  if(percussion)value.percussionArticulation=key;
  else if(string!==undefined&&open){value.string=string+1;value.fret=key-open[string];}
  else{const safeKey=Math.max(0,Math.min(127,key));value.octave=Math.floor(safeKey/12);value.tone=safeKey%12;}
  if(tied)value.isTieDestination=true;
  return value;
}

/** Converts a parsed MIDI file into an editable score: quantized rhythm, tuplets, voices, programs and tempo. */
export function importMidi(song:MidiSong,options:MidiImportOptions=defaultMidiImportOptions,fallbackTitle=''):MidiImport {
  const notes:MidiImportNote[]=[],wholeTicks=song.division*4,toUnits=(tick:number)=>tick*WHOLE/wholeTicks;
  const stats:Stats={shortened:0,merged:0};
  const allSources=plan(song);
  const selectedSet=options.selectedParts?new Set(options.selectedParts):null;
  const activeSources=selectedSet?allSources.filter(source=>selectedSet.has(source.partIndex)):allSources;
  const drumSet=new Set(options.drumParts??[]);
  const later=activeSources.reduce((sum,source)=>sum+source.laterPrograms,0);
  if(later)notes.push({code:'later_instruments',count:later});

  const prepared=activeSources.map(source=>{
    const override=options.partOverrides?.[source.partIndex];
    const percussion=override?.kind!==undefined?override.kind==='drums':source.percussion||drumSet.has(source.partIndex);
    const effectiveProgram=percussion?0
      :override?.program!==undefined?override.program
      :override?.kind==='guitar'?(source.program>=24&&source.program<=31?source.program:25)
      :override?.kind==='bass'?(source.program>=32&&source.program<=39?source.program:33)
      :override?.kind==='keys'?(source.program>=24&&source.program<=39?0:source.program)
      :source.program;
    const name=sourceDisplayName(source.rawPartName,source.multiChannel,effectiveProgram,percussion);
    return {source,percussion,effectiveProgram,override,name};
  });
  const inputDrumMap=prepared.some(item=>item.percussion)?resolveInputDrumMap(options.drumMap,options.drumKeyOverrides):null;
  let dropped=0;
  const mappedSources=prepared.map(item=>{
    const shift=!item.percussion&&item.override?.octaveShift?Math.trunc(item.override.octaveShift)*12:0;
    let hits:Hit[]=item.source.notes.map(entry=>({key:entry.key+shift,start:toUnits(entry.start),end:toUnits(entry.end)}));
    if(item.percussion&&inputDrumMap){
      const kept:Hit[]=[];
      for(const hit of hits){
        const mapped=inputDrumMap[hit.key&127];
        if(mapped===null)dropped++;
        else kept.push({key:mapped,start:hit.start,end:hit.end});
      }
      hits=kept;
    }
    return {...item,hits};
  });
  let maxNoteStart=-1;
  for(const item of mappedSources)for(const hit of item.hits)if(hit.start>maxNoteStart)maxNoteStart=hit.start;

  const bars=options.targetBars?buildTargetBars(options.targetBars,maxNoteStart,options.quantization,notes):buildBars(song,notes,options.importTimeSignatures!==false);
  const total=bars.at(-1)!.start+bars.at(-1)!.length;
  const score=new model.Score();score.title=stripCdataEnd(song.title||fallbackTitle);score.artist='';
  for(const bar of bars){const master=new model.MasterBar();master.timeSignatureNumerator=bar.numerator;master.timeSignatureDenominator=bar.denominator;score.addMasterBar(master);}

  // Tempo: bar-level automations at the bar-relative position of each change.
  // Until the first tempo event a MIDI file plays at 120 BPM.
  const sourceTempos=options.importTempo===false?[]:song.tempos;
  const tempos=sourceTempos[0]?.tick===0?sourceTempos:[{tick:0,microsPerQuarter:500000},...sourceTempos];
  let lastTempo=0,firstTempo=120;
  for(const tempo of tempos){
    const bpm=Math.max(1,Math.min(999,Math.round(60e6/tempo.microsPerQuarter)));
    if(bpm===lastTempo)continue;
    const unit=toUnits(tempo.tick),bar=barIndex(bars,unit),ratio=Math.min(0.999,Math.max(0,(unit-bars[bar].start)/bars[bar].length));
    score.masterBars[bar].tempoAutomations.push(model.Automation.buildTempoAutomation(false,Math.round(ratio*1000)/1000,bpm,2));
    if(!lastTempo)firstTempo=bpm;
    lastTempo=bpm;
  }
  const summary:MidiImportSummary['tracks']=[];let unplayable=0;
  const channelsInUse=new Set<number>([9]);
  const nextChannel=()=>{let value=0;while(channelsInUse.has(value))value++;channelsInUse.add(value);return value;};
  for(const {source,percussion,effectiveProgram,override,name,hits:rawHits} of mappedSources){
    if(!rawHits.length)continue;
    const grid=createRhythmGrid(bars,rawHits,options.quantization,options.tuplets);
    const hits=snapHitsToGrid(grid,rawHits,percussion);
    const chords=placeChords(hits,percussion?1:options.voices,stats);
    const voicesUsed=chords.reduce((most,chord)=>Math.max(most,chord.voice),0)+1;

    // Kind of staff.
    const program=effectiveProgram;
    const targetInstrument:'guitar'|'bass'|null=percussion||override?.kind==='keys'
      ?null
      :override?.kind==='guitar'
        ?'guitar'
        :override?.kind==='bass'
          ?'bass'
          :program>=32&&program<=39
            ?'bass'
            :program>=24&&program<=31
              ?'guitar'
              :null;
    let kind:MidiTrackKind=percussion?'drums':'keys',open:number[]|null=null,fingering:Map<Chord,Map<number,number>>|null=null;
    if(!percussion&&options.tablature&&targetInstrument){
      const strings=override?.tuning&&override.tuning.length>0
        ?[...override.tuning].reverse()
        :targetInstrument==='bass'
          ?bassStrings
          :guitarStrings;
      fingering=fingerChords(chords,strings);
      if(fingering){open=strings;kind=targetInstrument;}else unplayable++;
    }

    const track=new model.Track();track.name=name;track.shortName=name.slice(0,12);
    track.playbackInfo.program=percussion?0:program;
    track.playbackInfo.primaryChannel=percussion?9:nextChannel();track.playbackInfo.secondaryChannel=percussion?9:nextChannel();
    const staff=new model.Staff();
    staff.isPercussion=percussion;staff.showStandardNotation=true;staff.showTablature=!!open;
    if(open)staff.stringTuning.tunings=[...open].reverse();
    track.addStaff(staff);score.addTrack(track);
    const keysAll=hits.map(hit=>hit.key).sort((a,b)=>a-b),median=keysAll[keysAll.length>>1];
    const clef=percussion
      ?model.Clef.Neutral
      :targetInstrument==='bass'
        ?model.Clef.F4
        :targetInstrument==='guitar'
          ?model.Clef.G2
          :median<57
            ?model.Clef.F4
            :model.Clef.G2;

    writeQuantizedStaffBars(staff,bars,grid,chords,voicesUsed,options.quantization,clef,(piece,beat,partIndex)=>{
      const fingers=fingering?.get(piece.chord!);
      for(const keyValue of [...piece.chord!.keys].sort((a,b)=>a-b)){
        beat.addNote(note(keyValue,fingers?.get(keyValue),open,percussion,piece.tied||partIndex>0));
      }
    });
    summary.push({partIndex:source.partIndex,name,kind,program:percussion?0:program,notes:hits.length,voices:voicesUsed});
  }
  if(!summary.length)fail('This MIDI file has no notes this import can read.');
  if(unplayable)notes.push({code:'unplayable_tab',count:unplayable});
  if(dropped)notes.push({code:'dropped_drum_notes',count:dropped});
  if(stats.shortened)notes.push({code:'shortened_notes',count:stats.shortened});
  if(stats.merged)notes.push({code:'merged_notes',count:stats.merged});
  // Key signatures carry on from the bar they start in. The setter reads the staves, so it runs once they exist.
  let key=0,minor=false,keyIndex=0;const keys=options.importKeySignatures===false?[]:song.keys;
  for(const [index,master] of score.masterBars.entries()){
    while(keyIndex<keys.length&&toUnits(keys[keyIndex].tick)<=bars[index].start+bars[index].length/2){key=Math.max(-7,Math.min(7,keys[keyIndex].sharps));minor=keys[keyIndex].minor;keyIndex++;}
    master.keySignature=key as model.KeySignature;master.keySignatureType=minor?model.KeySignatureType.Minor:model.KeySignatureType.Major;
  }

  score.finish(settings);
  return {score,summary:{title:score.title,format:song.format,measures:bars.length,tempo:firstTempo,tracks:summary,notes}};
}

export function formatMidiImportNote(note:MidiImportNote|string,t:(key:MessageKey,params?:Record<string,string|number>)=>string):string {
  if(typeof note==='string')return note.endsWith('.')?note:`${note[0]?.toUpperCase()??''}${note.slice(1)}.`;
  switch(note.code){
    case 'unsupported_meters':
      return t('midi_import.note_unsupported_meters');
    case 'deferred_meters':
      return t(note.count===1?'midi_import.note_deferred_meters_one':'midi_import.note_deferred_meters_other',{count:note.count});
    case 'later_instruments':
      return t(note.count===1?'midi_import.note_later_instruments_one':'midi_import.note_later_instruments_other',{count:note.count});
    case 'unplayable_tab':
      return t(note.count===1?'midi_import.note_unplayable_tab_one':'midi_import.note_unplayable_tab_other',{count:note.count});
    case 'dropped_drum_notes':
      return t(note.count===1?'midi_import.note_dropped_drum_notes_one':'midi_import.note_dropped_drum_notes_other',{count:note.count});
    case 'shortened_notes':
      return t(note.count===1?'midi_import.note_shortened_notes_one':'midi_import.note_shortened_notes_other',{count:note.count});
    case 'merged_notes':
      return t(note.count===1?'midi_import.note_merged_notes_one':'midi_import.note_merged_notes_other',{count:note.count});
    case 'appended_measures':
      return t(note.count===1?'midi_import.note_appended_measures_one':'midi_import.note_appended_measures_other',{count:note.count});
  }
}

/** The score file name for an import: the MIDI file's name with a .gp extension, short enough for the native limit. */
export function midiImportFileName(source:string):string {
  return safeScoreFileName(source,'Imported MIDI');
}
