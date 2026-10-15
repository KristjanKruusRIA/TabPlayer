import { model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { copyGpInterchangeSource } from '../interchange/gp';
import { isGpMixAutomation,trackMixAutomations } from '../interchange/automation';
import { readMusicClip,scoreFromMusicClip } from './clipboard-source';
import { convertClipboardBeat } from './clipboard-conversion';
import { allNotes,captureNoteLinks,restoreNoteLinks,type NoteLinks } from './links';
import { applyMeasureEdit,planMeasureMap } from './measures';
import { mapLyricsMeasures } from './lyrics-measures';
import { integer,rhythmTicks } from './common';
import type { ClipboardCommand,MusicClip,PasteDestination,PasteFilters,PreparedMusicPaste } from './clipboard-types';
import type { BarIndexMap } from './measures-types';

const settings=new Settings();
const encode=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
const automation=(value:model.Automation)=>Object.assign(new model.Automation(),value);
const identity=(score:model.Score):BarIndexMap=>({oldToNew:score.masterBars.map((_,index)=>index),inserted:[]});
const beats=(bar:model.Bar)=>bar.voices.flatMap(voice=>voice.beats);
const processed=(voice:model.Voice)=>voice.beats.some(beat=>!beat.isEmpty)||(voice.index===0&&voice.bar.voices.every(lane=>lane.beats.every(beat=>beat.isEmpty)));
function onsets(voice:model.Voice) {let tick=0;return voice.beats.map(beat=>{const point={beat,tick};tick+=rhythmTicks(beat,voice.bar.masterBar.calculateDuration(false));return point;});}
function clone(score:model.Score) {
  const copy=scoreFromJson(encode(score),settings);restoreNoteLinks(copy,captureNoteLinks(score));copyGpInterchangeSource(score,copy);return copy;
}
function decode(clip:MusicClip) {
  const score=scoreFromMusicClip(clip);restoreNoteLinks(score,clip.links.map(link=>({from:link.from,to:link.to,kind:link.kind,...link.kind==='slide'?{slideOutType:link.slideOutType!}:{}})));return score;
}
function targetAndMappings(score:model.Score,source:model.Score,command:ClipboardCommand):PasteDestination[] {
  const {target,destinations,count,filters,placement}=command.options;
  if(!target||Object.values(target).some(value=>!integer(value,0,0xffffffff))||!score.masterBars[target.bar]||!score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice])throw new Error('Choose an existing destination track, staff, measure and voice.');
  if(!integer(count,1,1000)||!filters||Object.keys(filters).length!==6||['diagrams','texts','timers','trackAutomations','masterAutomations','sections'].some(key=>typeof filters[key as keyof PasteFilters]!=='boolean'))throw new Error('Choose a repeat count from 1 to 1000 and all six paste filters.');
  if(command.clip.mode==='singleTrack'&&(filters.masterAutomations||filters.sections))throw new Error('Single-track paste cannot copy master tempo or section structure.');
  if(placement!==(command.clip.kind==='bars'?'beforeBar':'currentBar'))throw new Error('Paste complete bars before a measure or a phrase at the current beat.');
  if(!Array.isArray(destinations)||destinations.length!==source.tracks.length)throw new Error('Map every copied track exactly once.');
  const from=new Set<number>(),to=new Set<number>();
  for(const mapping of destinations){
    const track=score.tracks[mapping.track],original=source.tracks[mapping.sourceTrack];
    if(!integer(mapping.sourceTrack)||!integer(mapping.track)||!track||!original||from.has(mapping.sourceTrack)||to.has(mapping.track)||!Array.isArray(mapping.staffMap)||mapping.staffMap.length!==original.staves.length||new Set(mapping.staffMap).size!==mapping.staffMap.length)throw new Error('Use unique existing source and destination tracks and staves.');
    from.add(mapping.sourceTrack);to.add(mapping.track);
    mapping.staffMap.forEach((index,staff)=>{if(!integer(index)||!track.staves[index])throw new Error('Map every copied staff to an existing destination staff.');for(const bar of original.staves[staff].bars)for(let voice=0;voice<bar.voices.length;voice++)if(command.clip.kind==='bars'&&!track.staves[index].bars[target.bar]?.voices[voice])throw new Error('The destination must already contain every copied voice.');});
  }
  if(command.clip.kind==='phrase'&&(destinations[0].track!==target.track||destinations[0].staffMap[0]!==target.staff))throw new Error('Map a phrase to the selected destination staff and voice.');
  return destinations;
}
function reserveIds(destination:model.Score) {
  const voices=new Set(destination.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.map(voice=>voice.id))))),beatIds=new Set(destination.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>beats(bar).map(beat=>beat.id))))),notes=new Set(allNotes(destination).map(note=>note.id));
  const take=(used:Set<number>,create:()=>number)=>{let id=create();while(used.has(id))id=create();used.add(id);return id;};
  return (source:model.Score):NoteLinks=>{
    const oldLinks=captureNoteLinks(source),ids=new Map<number,number>();
    for(const track of source.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices){voice.id=take(voices,()=>new model.Voice().id);for(const beat of voice.beats){beat.id=take(beatIds,()=>new model.Beat().id);for(const note of beat.notes){const old=note.id;note.id=take(notes,()=>new model.Note().id);ids.set(old,note.id);}}}
    return oldLinks.map(link=>({...link,from:ids.get(link.from)!,to:ids.get(link.to)!}));
  };
}
function preserveObjects(score:model.Score) {
  return {bars:new Set(score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars))),voices:new Set(score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices)))),beats:new Set(score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(beats))))};
}
function finishFreshIds(score:model.Score,preserved:ReturnType<typeof preserveObjects>) {
  const fix=<T extends {id:number}>(objects:T[],existing:Set<T>,create:()=>number)=>{const used=new Set([...existing].map(value=>value.id));for(const value of objects)if(!existing.has(value)){while(used.has(value.id))value.id=create();used.add(value.id);}};
  const bars=score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars));fix(bars,preserved.bars,()=>new model.Bar().id);fix(bars.flatMap(bar=>bar.voices),preserved.voices,()=>new model.Voice().id);fix(bars.flatMap(beats),preserved.beats,()=>new model.Beat().id);
}
function installChords(source:model.Staff,destination:model.Staff,repeat:number) {
  const renamed=new Map<string,string>();
  for(const [id,chord] of source.chords??[]){let name=`clipboard-${repeat}-${id}`;while(destination.chords?.has(name))name=`_${name}`;destination.addChord(name,chord);renamed.set(id,name);}
  return renamed;
}
function prepareBeat(beat:model.Beat,source:model.Staff,destination:model.Staff,filters:PasteFilters,chords:Map<string,string>) {
  convertClipboardBeat(beat,source,destination);beat.lyrics=null;beat.timer=null;
  beat.chordId=filters.diagrams&&beat.chordId?chords.get(beat.chordId)??null:null;
  if(!filters.texts)beat.text=null;if(!filters.timers)beat.showTimer=false;
  beat.automations=filters.trackAutomations?beat.automations.filter(value=>!isGpMixAutomation(value)&&!value.syncPointValue&&[model.AutomationType.Instrument,model.AutomationType.Bank].includes(value.type)):[];
}
type State={tempo:model.Automation;tracks:Map<number,Map<model.AutomationType,model.Automation>>;pedals:Map<model.Staff,model.SustainPedalMarkerType>};
function stateAt(score:model.Score,bar:number,mappings:PasteDestination[],tick=0):State {
  let tempo=model.Automation.buildTempoAutomation(false,0,score.tempo,2);
  for(const master of score.masterBars.slice(0,bar+1))for(const change of [...master.tempoAutomations].sort((a,b)=>a.ratioPosition-b.ratioPosition))if(master.index<bar||change.ratioPosition*master.calculateDuration(false)<tick)tempo=change;
  const tracks=new Map<number,Map<model.AutomationType,model.Automation>>(),pedals=new Map<model.Staff,model.SustainPedalMarkerType>();
  for(const mapping of mappings){const track=score.tracks[mapping.track],values=new Map<model.AutomationType,model.Automation>([
    [model.AutomationType.Instrument,Object.assign(new model.Automation(),{type:model.AutomationType.Instrument,value:track.playbackInfo.program})],
    [model.AutomationType.Bank,Object.assign(new model.Automation(),{type:model.AutomationType.Bank,value:track.playbackInfo.bank})],
    [model.AutomationType.Volume,Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:track.playbackInfo.volume})],
    [model.AutomationType.Balance,Object.assign(new model.Automation(),{type:model.AutomationType.Balance,value:track.playbackInfo.balance})]
  ]);
    const points=trackMixAutomations(track).filter(point=>point.bar<bar||point.bar===bar&&point.automation.ratioPosition*score.masterBars[point.bar].calculateDuration(false)<tick).map(point=>({bar:point.bar,tick:point.automation.ratioPosition*score.masterBars[point.bar].calculateDuration(false),change:point.automation}));
    for(const staff of track.staves)for(const measure of staff.bars.slice(0,bar+1))for(const voice of measure.voices.filter(processed))for(const point of onsets(voice))for(const change of point.beat.automations)if((measure.index<bar||point.tick<tick)&&!isGpMixAutomation(change)&&!change.syncPointValue&&[model.AutomationType.Instrument,model.AutomationType.Bank].includes(change.type))points.push({bar:measure.index,tick:point.tick,change});
    for(const point of points.sort((a,b)=>a.bar-b.bar||a.tick-b.tick))values.set(point.change.type,point.change);tracks.set(mapping.track,values);
    for(const index of mapping.staffMap){const staff=track.staves[index];let value=model.SustainPedalMarkerType.Up;for(const measure of staff.bars.slice(0,bar+1))for(const marker of [...measure.sustainPedals].sort((a,b)=>a.ratioPosition-b.ratioPosition))if((measure.index<bar||marker.ratioPosition*measure.masterBar.calculateDuration(false)<tick)&&marker.pedalType!==model.SustainPedalMarkerType.Hold)value=marker.pedalType;pedals.set(staff,value);}
  }
  return {tempo,tracks,pedals};
}
function restoreSuffix(score:model.Score,bar:number,state:State,changed:Map<number,Set<model.AutomationType>>,pedals:Set<model.Staff>,tempo:boolean,tick=0) {
  const master=score.masterBars[bar];if(!master)return;
  const ratio=tick/master.calculateDuration(false);
  if(tempo&&!master.tempoAutomations.some(value=>value.ratioPosition===ratio))master.tempoAutomations.unshift(Object.assign(automation(state.tempo),{ratioPosition:ratio}));
  for(const [index,types] of changed){const track=score.tracks[index],bars=track.staves.map(staff=>staff.bars[bar]),storage=bars.flatMap(beats)[0],active=bars.flatMap(measure=>measure.voices.filter(processed).flatMap(onsets)),boundary=active.find(point=>point.tick===tick&&point.beat.graceType===model.GraceType.None)?.beat;
    for(const type of types){
      const mix=isGpMixAutomation({type} as model.Automation);
      if(!mix&&active.some(point=>point.tick===tick&&point.beat.graceType===model.GraceType.BeforeBeat&&point.beat.notes.length))throw new Error('Cannot restore a program or bank before sounding grace notes at the suffix boundary.');
      const explicit=mix?trackMixAutomations(track).some(point=>point.bar===bar&&point.automation.type===type&&point.automation.ratioPosition===ratio):active.some(point=>point.tick===tick&&point.beat.automations.some(value=>value.type===type&&!value.syncPointValue));if(explicit)continue;
      if(!mix&&!boundary)throw new Error('Cannot restore a program or bank at the exact suffix boundary; no processed beat starts there.');
      const carrier=mix?storage:boundary!;if(!carrier)throw new Error('Missing a suffix automation carrier.');carrier.automations.unshift(Object.assign(automation(state.tracks.get(index)!.get(type)!),{ratioPosition:mix?ratio:0}));
    }
  }
  for(const staff of pedals){const measure=staff.bars[bar];if(!measure||measure.sustainPedals.some(marker=>marker.ratioPosition===ratio&&marker.pedalType!==model.SustainPedalMarkerType.Hold))continue;measure.sustainPedals.push(Object.assign(new model.SustainPedalMarker(),{bar:measure,ratioPosition:ratio,pedalType:state.pedals.get(staff)??model.SustainPedalMarkerType.Up}));measure.sustainPedals.sort((a,b)=>a.ratioPosition-b.ratioPosition);}
}
function recordChanges(beat:model.Beat,track:number,changed:Map<number,Set<model.AutomationType>>) {for(const change of beat.automations){let types=changed.get(track);if(!types){types=new Set();changed.set(track,types);}types.add(change.type);}}
function guardMixedProgramLanes(score:model.Score,barIndices:Iterable<number>,changed:Map<number,Set<model.AutomationType>>) {
  for(const [trackIndex,types]of changed)for(const type of [model.AutomationType.Instrument,model.AutomationType.Bank]){
    if(!types.has(type))continue;const track=score.tracks[trackIndex];
    for(const index of barIndices){const lanes=new Set<string>(),values=new Set<number>();for(const staff of track.staves)for(const voice of staff.bars[index]?.voices.filter(processed)??[])for(const beat of voice.beats)for(const value of beat.automations)if(value.type===type&&!value.syncPointValue){lanes.add(`${staff.index}/${voice.index}`);values.add(value.value);}
      if(lanes.size>1&&values.size>1)throw new Error('Contradictory program or bank streams in multiple processed lanes cannot yet be pasted without public MIDI event loss.');
    }
  }
}
function relink(score:model.Score) {
  score.masterBars.forEach((master,index)=>{master.index=index;master.score=score;master.previousMasterBar=score.masterBars[index-1]??null;master.nextMasterBar=score.masterBars[index+1]??null;});
  for(const track of score.tracks)for(const staff of track.staves)staff.bars.forEach((bar,index)=>{bar.index=index;bar.staff=staff;bar.previousBar=staff.bars[index-1]??null;bar.nextBar=staff.bars[index+1]??null;bar.voices.forEach((voice,voiceIndex)=>{voice.index=voiceIndex;voice.bar=bar;voice.beats.forEach((beat,beatIndex)=>{beat.index=beatIndex;beat.voice=voice;beat.notes.forEach((note,noteIndex)=>{note.index=noteIndex;note.beat=beat;});});});});
  score.rebuildRepeatGroups();
}
function insert(score:model.Score,beforeBar:number,count:number) {const command={type:'insertMeasures',beforeBar,count} as const,map=planMeasureMap(score.masterBars.length,command);mapLyricsMeasures(score,map);applyMeasureEdit(score,command);return map;}
function validateLinks(score:model.Score,links:NoteLinks,enforceGpBoundary=true) {
  const lookup=new Map(allNotes(score).map(note=>[note.id,note]));
  for(const link of links){const from=lookup.get(link.from),to=lookup.get(link.to);if(!from||!to)continue;
    if(from.beat.voice.bar.staff!==to.beat.voice.bar.staff||from.beat.voice.index!==to.beat.voice.index||to.beat.voice.bar.index<from.beat.voice.bar.index||(to.beat.voice.bar===from.beat.voice.bar&&to.beat.index<=from.beat.index))throw new Error('Pasted note links must remain forward in one staff and voice.');
    if(link.kind==='slur')continue;
    if(from.isStringed&&from.string!==to.string||link.kind==='tie'&&from.realValue!==to.realValue)throw new Error('The destination cannot preserve this note link pitch or string.');
    let next:model.Note|undefined;const staff=from.beat.voice.bar.staff;
    for(let bar=from.beat.voice.bar.index;bar<=to.beat.voice.bar.index&&!next;bar++)for(const beat of staff.bars[bar].voices[from.beat.voice.index].beats.slice(bar===from.beat.voice.bar.index?from.beat.index+1:0)){next=beat.notes.find(note=>!note.isDead&&(from.isStringed?note.string===from.string:note.realValue===from.realValue));if(next)break;}
    if(next!==to||enforceGpBoundary&&to.beat.voice.bar.index-from.beat.voice.bar.index>3)throw new Error('The destination breaks a next-note relationship or GP tie search boundary.');
  }
}
function protectedLinks(score:model.Score,links:NoteLinks) {return links.filter(link=>{try{validateLinks(score,[link],false);return true;}catch{return false;}});}

function pasteBars(score:model.Score,clip:MusicClip,source:model.Score,command:ClipboardCommand,mappings:PasteDestination[]):PreparedMusicPaste {
  const {target,count,filters}=command.options,total=source.masterBars.length*count;if(!integer(total,1,1000))throw new Error('Paste at most 1000 inserted measures.');
  if(clip.mode==='multiTrack'&&source.masterBars.some(master=>master.isRepeatStart||master.repeatCount||master.alternateEndings)){
    for(const master of score.masterBars){const group=master.repeatGroup;if((group.isOpened||group.closings.length)&&group.opening&&group.opening.index<target.bar&&(group.closings.at(-1)?.index??score.masterBars.length)>=target.bar)throw new Error('Copied repeats cannot be nested into a destination repeat context.');}
  }
  const state=stateAt(score,target.bar,mappings),allocate=reserveIds(score),links=captureNoteLinks(score),retainedLinks=protectedLinks(score,links),pastedLinks:NoteLinks=[],barMap=insert(score,target.bar,total),changed=new Map<number,Set<model.AutomationType>>(),pedals=new Set<model.Staff>();let changedTempo=false;
  // Inserted rests must follow copied meter even on unmapped destination staves.
  if(clip.mode==='multiTrack')for(let offset=0;offset<total;offset++)for(const track of score.tracks)for(const staff of track.staves){const measure=staff.bars[target.bar+offset];for(const voice of measure.voices){voice.beats=[];const rest=new model.Beat();rest.duration=1;rest.isEmpty=voice.index!==0||source.masterBars[offset%source.masterBars.length].isFreeTime;voice.addBeat(rest);}}
  for(let repeat=0;repeat<count;repeat++){
    const part=repeat===0?source:decode(clip),newLinks=allocate(part);links.push(...newLinks);pastedLinks.push(...newLinks);
    for(let bar=0;bar<part.masterBars.length;bar++)if(clip.mode==='multiTrack'){
      const original=part.masterBars[bar];original.tempoAutomations=filters.masterAutomations?original.tempoAutomations:[];if(!filters.sections)original.section=null;
      if(original.tempoAutomations.length)changedTempo=true;score.masterBars[target.bar+repeat*part.masterBars.length+bar]=original;
    }
    for(const mapping of mappings){const original=part.tracks[mapping.sourceTrack],destination=score.tracks[mapping.track],mix=filters.trackAutomations?trackMixAutomations(original):[];
      mapping.staffMap.forEach((staffIndex,sourceIndex)=>{
        const from=original.staves[sourceIndex],to=destination.staves[staffIndex],chords=filters.diagrams?installChords(from,to,repeat):new Map<string,string>();
        from.bars.forEach((bar,barIndex)=>{
          const destinationIndex=target.bar+repeat*part.masterBars.length+barIndex,measure=to.bars[destinationIndex],capacity=score.masterBars[destinationIndex].calculateDuration(false);
          if(bar.voices.length>measure.voices.length)throw new Error('The destination must already contain every copied voice.');
          for(const voice of bar.voices){if(!score.masterBars[destinationIndex].isFreeTime&&voice.beats.reduce((sum,beat)=>sum+rhythmTicks(beat,part.masterBars[barIndex].calculateDuration(false)),0)>capacity)throw new Error('Copied rhythms do not fit the inherited destination meter.');for(const beat of voice.beats){prepareBeat(beat,from,to,filters,chords);recordChanges(beat,mapping.track,changed);}measure.voices[voice.index]=voice;}
          if(clip.mode==='multiTrack'){measure.clef=bar.clef;measure.clefOttava=bar.clefOttava;measure.keySignature=bar.keySignature;measure.keySignatureType=bar.keySignatureType;}
          measure.simileMark=bar.simileMark;measure.sustainPedals=filters.trackAutomations?bar.sustainPedals.map(marker=>{const ratioPosition=marker.ratioPosition*part.masterBars[barIndex].calculateDuration(false)/capacity;if(!Number.isFinite(ratioPosition)||ratioPosition<0||ratioPosition>1)throw new Error('A copied sustain marker does not fit the inherited destination meter.');return Object.assign(new model.SustainPedalMarker(),marker,{bar:measure,ratioPosition});}):[];if(measure.sustainPedals.some(marker=>marker.pedalType!==model.SustainPedalMarkerType.Hold))pedals.add(to);
        });
      });
      for(const point of mix){const index=target.bar+repeat*part.masterBars.length+point.bar,measure=destination.staves[mapping.staffMap[0]].bars[index],ratio=point.automation.ratioPosition*part.masterBars[point.bar].calculateDuration(false)/score.masterBars[index].calculateDuration(false);if(!Number.isFinite(ratio)||ratio<0||ratio>=1)throw new Error('A copied controller breakpoint does not fit the destination measure.');const value=Object.assign(automation(point.automation),{ratioPosition:ratio});beats(measure)[0].automations.push(value);recordChanges(beats(measure)[0],mapping.track,changed);}
    }
  }
  relink(score);restoreNoteLinks(score,links);validateLinks(score,retainedLinks,false);validateLinks(score,pastedLinks);restoreSuffix(score,target.bar+total,state,changed,pedals,changedTempo);guardMixedProgramLanes(score,[...barMap.inserted,...score.masterBars[target.bar+total]?[target.bar+total]:[]],changed);return {score,barMap};
}

type Placement={beat:model.Beat;source:model.Staff;bar:number;tick:number;length:number;repeat:number};
type PhraseEvents={mix:Array<{tick:number;value:model.Automation}>;pedals:Array<{tick:number;value:model.SustainPedalMarker}>};
function phraseEvents(score:model.Score):PhraseEvents {
  const mix:PhraseEvents['mix']=[],pedals:PhraseEvents['pedals']=[],staff=score.tracks[0].staves[0],points=trackMixAutomations(score.tracks[0]);let offset=0;
  for(const bar of staff.bars){const capacity=bar.masterBar.calculateDuration(false),span=bar.voices[0].beats.reduce((sum,beat)=>sum+rhythmTicks(beat,capacity),0);
    for(const point of points.filter(point=>point.bar===bar.index)){const local=point.automation.ratioPosition*capacity;if(local>=0&&local<span)mix.push({tick:offset+local,value:automation(point.automation)});}
    for(const marker of bar.sustainPedals){const local=marker.ratioPosition*capacity;if(local>=0&&local<span)pedals.push({tick:offset+local,value:Object.assign(new model.SustainPedalMarker(),marker)});}
    offset+=span;
  }
  return {mix,pedals};
}
function restBeats(ticks:number):model.Beat[] {
  const choices:Array<{duration:number;dots:number;ticks:number}>=[];
  for(const duration of [-4,-2,1,2,4,8,16,32,64,128,256])for(let dots=0;dots<=3;dots++){const base=Math.trunc(3840/(duration<0?1/-duration:duration));let ticks=base;for(let dot=1;dot<=dots;dot++)ticks+=Math.trunc(base/2**dot);choices.push({duration,dots,ticks});}
  choices.sort((a,b)=>b.ticks-a.ticks||a.dots-b.dots);const result:model.Beat[]=[];let remaining=ticks;
  for(const choice of choices)while(remaining>=choice.ticks){result.push(Object.assign(new model.Beat(),{duration:choice.duration,dots:choice.dots,isEmpty:false}));remaining-=choice.ticks;}
  if(remaining===0)return result;
  // Truncated dots at 1/256 have 22/25/26 tick lengths, so a greedy
  // decomposition can fail even when another exact supported sum exists.
  const path=new Int32Array(ticks+1);path.fill(-1);path[0]=-2;
  for(let amount=1;amount<=ticks;amount++)for(let index=0;index<choices.length;index++){const previous=amount-choices[index].ticks;if(previous>=0&&path[previous]!==-1){path[amount]=index;break;}}
  if(path[ticks]===-1)throw new Error('The remaining gap cannot be represented by exact supported rests.');
  const exact:model.Beat[]=[];for(let amount=ticks;amount>0;){const choice=choices[path[amount]];exact.push(Object.assign(new model.Beat(),{duration:choice.duration,dots:choice.dots,isEmpty:false}));amount-=choice.ticks;}return exact;
}
function materializePhraseRests(score:model.Score) {
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices){
    if(voice.beats.length!==1||!voice.beats[0].isFullBarRest)continue;const beat=voice.beats[0],rests=restBeats(bar.masterBar.calculateDuration(false)),first=rests.shift()!;beat.duration=first.duration;beat.dots=first.dots;beat.tupletNumerator=-1;beat.tupletDenominator=-1;voice.beats=[beat,...rests];voice.beats.forEach((item,index)=>{item.voice=voice;item.index=index;});
  }
}
function pastePhrase(score:model.Score,clip:MusicClip,source:model.Score,command:ClipboardCommand,mappings:PasteDestination[]):PreparedMusicPaste {
  const {target,count,filters}=command.options,staff=score.tracks[target.track].staves[target.staff],firstVoice=staff.bars[target.bar].voices[target.voice];
  if(target.beat>firstVoice.beats.length||firstVoice.beats.slice(target.beat).some(beat=>beat.notes.length))throw new Error('Paste a phrase into a trailing rest or empty suffix.');
  if(score.masterBars[target.bar].isFreeTime)throw new Error('Free-time phrase placement is not supported.');
  const allocate=reserveIds(score),links=captureNoteLinks(score),retainedLinks=protectedLinks(score,links),pastedLinks:NoteLinks=[],parts:model.Score[]=[],events:PhraseEvents[]=[],placements:Placement[]=[],changes=new Map<number,Set<model.AutomationType>>(),pedals=new Set<model.Staff>(),affected=new Set<number>();
  let bar=target.bar,tick=firstVoice.beats.slice(0,target.beat).reduce((sum,beat)=>sum+rhythmTicks(beat),0),insertAt:number|null=null,insertCount=0;
  const inherited=(index:number)=>score.masterBars[Math.max(0,Math.min(index-1,score.masterBars.length-1))];
  const master=()=>insertAt!==null&&bar>=insertAt?inherited(insertAt):score.masterBars[bar];
  const nextBar=()=>{
    bar++;tick=0;
    if(insertAt!==null){insertCount++;if(insertCount>1000)throw new Error('Paste at most 1000 inserted measures.');return;}
    const voice=staff.bars[bar]?.voices[target.voice];
    if(!voice&&bar<score.masterBars.length)throw new Error('The destination must already contain the phrase voice in every reused measure.');
    if(!voice||voice.beats.some(beat=>beat.notes.length)){insertAt=bar;insertCount=1;}
    else if(score.masterBars[bar].isFreeTime)throw new Error('Free-time phrase placement is not supported.');
  };
  for(let repeat=0;repeat<count;repeat++){
    const part=repeat===0?source:decode(clip);events.push(phraseEvents(part));materializePhraseRests(part);parts.push(part);const newLinks=allocate(part);links.push(...newLinks);pastedLinks.push(...newLinks);const from=part.tracks[0].staves[0];let pending:model.Beat[]=[];
    for(const measure of from.bars)for(const beat of measure.voices[0].beats){const length=rhythmTicks(beat,measure.masterBar.calculateDuration(false));if(length===0){pending.push(beat);continue;}
      if(length>master().calculateDuration(false))throw new Error('A copied beat is longer than the complete destination measure.');
      if(tick+length>master().calculateDuration(false)){restBeats(master().calculateDuration(false)-tick);nextBar();if(length>master().calculateDuration(false))throw new Error('A copied beat is longer than the complete destination measure.');}
      for(const grace of pending)placements.push({beat:grace,source:from,bar,tick,length:0,repeat});pending=[];placements.push({beat,source:from,bar,tick,length,repeat});affected.add(bar);tick+=length;
    }
    if(pending.length)throw new Error('A phrase must include the attack belonging to its trailing grace group.');
  }
  if(!placements.length)throw new Error('Choose a phrase with a complete written rhythm.');restBeats(master().calculateDuration(false)-tick);
  const midBar=insertAt===null&&tick<master().calculateDuration(false),suffixOld=insertAt??(midBar?bar:bar+1),suffixTick=midBar?tick:0,state=stateAt(score,suffixOld,mappings,suffixTick),barMap=insertAt===null?identity(score):insert(score,insertAt,insertCount),suffix=insertAt===null?suffixOld:insertAt+insertCount;
  const removedMix=new Set([...affected].flatMap(index=>staff.bars[index].voices[target.voice].beats.flatMap(beat=>beat.automations.filter(isGpMixAutomation))));
  const chordMaps=parts.map((part,repeat)=>filters.diagrams?installChords(part.tracks[0].staves[0],staff,repeat):new Map<string,string>()),existingMix=trackMixAutomations(score.tracks[target.track]).filter(point=>affected.has(point.bar)&&removedMix.has(point.automation));
  const metadata=new Map<number,Array<{tick:number;beat:model.Beat}>>();
  for(const index of affected){const voice=staff.bars[index].voices[target.voice];if(!voice)throw new Error('The destination must already contain the phrase voice in each reused measure.');let onset=0;const retained:Array<{tick:number;beat:model.Beat}>=[];for(const beat of voice.beats){if(index!==target.bar||beat.index>=target.beat)retained.push({tick:onset,beat});onset+=rhythmTicks(beat);}metadata.set(index,retained);}
  for(const index of affected){const voice=staff.bars[index].voices[target.voice],prefix=index===target.bar?voice.beats.slice(0,target.beat):[],output=[...prefix];let onset=prefix.reduce((sum,beat)=>sum+rhythmTicks(beat),0);
    for(const placement of placements.filter(item=>item.bar===index)){output.push(...restBeats(placement.tick-onset));prepareBeat(placement.beat,placement.source,staff,filters,chordMaps[placement.repeat]);recordChanges(placement.beat,target.track,changes);output.push(placement.beat);onset=placement.tick+placement.length;}
    output.push(...restBeats(score.masterBars[index].calculateDuration(false)-onset));voice.beats=output;output.forEach((beat,beatIndex)=>{beat.voice=voice;beat.index=beatIndex;beat.automations=beat.automations.filter(value=>!isGpMixAutomation(value));});
    for(const saved of metadata.get(index)??[]){const original=saved.beat,values=original.automations.filter(value=>!isGpMixAutomation(value)&&!value.syncPointValue),outside=!placements.some(item=>item.bar===index&&item.length>0&&saved.tick>=item.tick&&saved.tick<item.tick+item.length),keepText=outside||!filters.texts,keepDiagram=outside||!filters.diagrams,keepTimer=outside||!filters.timers;
      const needs=(keepText&&!!original.text)||(keepDiagram&&!!original.chordId)||(keepTimer&&original.showTimer)||values.length>0||(outside&&original.lyrics!==null);if(!needs)continue;let position=0;const destination=output.find(beat=>{const match=position===saved.tick;position+=rhythmTicks(beat,score.masterBars[index].calculateDuration(false));return match;});if(!destination)throw new Error('A retained destination annotation or automation has no exact beat onset after phrase reflow.');if(keepText)destination.text=original.text;if(keepDiagram)destination.chordId=original.chordId;if(keepTimer)destination.showTimer=original.showTimer;if(outside&&original.lyrics)destination.lyrics=[...original.lyrics];destination.automations.unshift(...values.map(automation));}
  }
  for(const point of existingMix){const carrier=beats(staff.bars[point.bar])[0];carrier.automations.push(automation(point.automation));}
  for(let repeat=0;repeat<parts.length;repeat++)if(filters.trackAutomations){
    const location=(sourceTick:number)=>{let elapsed=0;const placement=placements.filter(item=>item.repeat===repeat&&item.length>0).find(item=>{const match=sourceTick>=elapsed&&sourceTick<elapsed+item.length;elapsed+=item.length;return match;});if(!placement)throw new Error('A copied controller has no exact phrase position.');return {bar:placement.bar,ratio:(placement.tick+sourceTick-(elapsed-placement.length))/score.masterBars[placement.bar].calculateDuration(false)};};
    for(const point of events[repeat].mix){const position=location(point.tick),value=Object.assign(automation(point.value),{ratioPosition:position.ratio}),carrier=beats(staff.bars[position.bar])[0];carrier.automations.push(value);recordChanges(carrier,target.track,changes);}
    for(const point of events[repeat].pedals){const position=location(point.tick),measure=staff.bars[position.bar];measure.sustainPedals.push(Object.assign(new model.SustainPedalMarker(),point.value,{bar:measure,ratioPosition:position.ratio}));if(point.value.pedalType!==model.SustainPedalMarkerType.Hold)pedals.add(staff);}
  }
  relink(score);restoreNoteLinks(score,links);validateLinks(score,retainedLinks,false);validateLinks(score,pastedLinks);restoreSuffix(score,suffix,state,changes,pedals,false,suffixTick);guardMixedProgramLanes(score,new Set([...affected,...score.masterBars[suffix]?[suffix]:[]]),changes);return {score,barMap};
}

/** Prepare one complete mutation on a detached destination; native history is root-owned. */
export function preparePasteMusic(score:model.Score,command:ClipboardCommand):PreparedMusicPaste {
  const clip=readMusicClip(command.clip),source=decode(clip),mappings=targetAndMappings(score,source,{...command,clip});
  const destination=clone(score),preserved=preserveObjects(destination),result=clip.kind==='bars'?pasteBars(destination,clip,source,command,mappings):pastePhrase(destination,clip,source,command,mappings);finishFreshIds(result.score,preserved);return result;
}
