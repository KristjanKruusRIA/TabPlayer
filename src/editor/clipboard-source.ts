import { model,Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';
import { validateMusicClipEnvelope } from '../parity-commands';
import { isGpMixAutomation,trackMixAutomations } from '../interchange/automation';
import { durationValues,enumValue,integer,rhythmTicks,validateCapacity } from './common';
import { allNotes,captureNoteLinks,restoreNoteLinks } from './links';
import { resolveSelectionBeats,resolveSelectionNotes,validateMusicSelection } from './range-selection';
import { resolvePercussionArticulation } from './percussion-catalog';
import { nextLinkedNote,validateCurve } from './techniques';
import type { MusicSelection } from './range-types';
import type { ClipboardLink,ClipboardMode,MusicClip } from './clipboard-types';

type RecordValue=Record<string,unknown>;
const object=(value:unknown):RecordValue=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid clipboard model object.');return value as RecordValue;};
const array=(value:unknown,min=0,max=0xffffffff):unknown[]=>{if(!Array.isArray(value)||value.length<min||value.length>max)throw new Error('Invalid clipboard model arrays or counts.');return value;};
const json=(score:model.Score)=>model.JsonConverter.scoreToJson(score);
const settings=()=>new Settings();
function scalarFields(raw:RecordValue,defaults:object) {
  for(const [key,defaultValue]of Object.entries(defaults)){const serialized=key.toLowerCase();if(!Object.hasOwn(raw,serialized)||!['number','boolean','string'].includes(typeof defaultValue))continue;
    if(typeof raw[serialized]!==typeof defaultValue)throw new Error(`Invalid clipboard ${serialized} value type.`);
  }
}
function walkJson(value:unknown) {
  const pending:{value:unknown;depth:number}[]=[{value,depth:0}];
  while(pending.length){const item=pending.pop()!;if(item.depth>128)throw new Error('Clipboard model nesting is too deep.');
    if(typeof item.value==='number'&&!Number.isFinite(item.value))throw new Error('Clipboard numbers must be finite.');
    if(item.value&&typeof item.value==='object')for(const [key,child]of Object.entries(item.value)){
      if(['backingtrack','syncpoints','syncpointvalue','rawaudiofile'].includes(key.toLowerCase()))throw new Error('Clipboard must not contain backing audio or sync data.');
      if(key.toLowerCase()==='lyrics'&&child!==null)throw new Error('Clipboard must not contain lyrics.');
      pending.push({value:child,depth:item.depth+1});
    }
  }
}
function validateStructure(raw:RecordValue,clip:MusicClip) {
  walkJson(raw);const masters=array(raw.masterbars,1),tracks=array(raw.tracks,1);
  const empty=object(JSON.parse(json(new model.Score())));for(const master of masters)scalarFields(object(master),new model.MasterBar());
  for(const [key,value]of Object.entries(raw))if(!['masterbars','tracks'].includes(key)&&(!(key in empty)||JSON.stringify(value)!==JSON.stringify(empty[key])))throw new Error('Clipboard contains document metadata or unsupported root settings.');
  if(clip.mode==='singleTrack'&&tracks.length!==1)throw new Error('Single track clipboard requires one track.');
  if(clip.kind==='phrase'&&(clip.mode!=='singleTrack'||tracks.length!==1))throw new Error('Phrase clipboard requires one track and voice lane.');
  const ids=new Map<string,Set<number>>();
  const id=(kind:string,value:unknown)=>{if(typeof value!=='number'||!integer(value,0,0xffffffff))throw new Error('Clipboard model IDs must be unsigned integers.');const seen=ids.get(kind)??new Set<number>();if(seen.has(value))throw new Error(`Duplicate clipboard ${kind} ID.`);seen.add(value);ids.set(kind,seen);};
  for(const t of tracks){const track=object(t),staves=array(track.staves,1);scalarFields(track,new model.Track());scalarFields(object(track.playbackinfo),new model.PlaybackInformation());if(clip.kind==='phrase'&&staves.length!==1)throw new Error('Phrase clipboard requires one staff.');
    for(const s of staves){const staff=object(s),bars=array(staff.bars,masters.length,masters.length);scalarFields(staff,new model.Staff());
      for(const b of bars){const bar=object(b);id('bar',bar.id);const voices=array(bar.voices,1,4);if(clip.kind==='phrase'&&voices.length!==1)throw new Error('Phrase clipboard requires one voice.');
        for(const v of voices){const voice=object(v);id('voice',voice.id);for(const b of array(voice.beats)){const beat=object(b);id('beat',beat.id);scalarFields(beat,new model.Beat());
          if(beat.text!==null&&typeof beat.text!=='string'||beat.chordid!==null&&typeof beat.chordid!=='string')throw new Error('Invalid clipboard beat text or chord ID.');
          if(Object.hasOwn(beat,'overridedisplayduration')&&(typeof beat.overridedisplayduration!=='number'||!integer(beat.overridedisplayduration,1,0xffffffff)))throw new Error('Invalid clipboard rhythm override.');
          for(const automation of array(beat.automations))scalarFields(object(automation),new model.Automation());
          for(const n of array(beat.notes)){const note=object(n);id('note',note.id);scalarFields(note,new model.Note());if(staff.ispercussion!==true&&typeof note.percussionarticulation==='number'&&note.percussionarticulation>=0)throw new Error('Invalid clipboard articulation on a melodic staff.');
            enumValue(note.bendtype as number,model.BendType,'clipboard bend');enumValue(note.harmonictype as number,model.HarmonicType,'clipboard harmonic');enumValue(note.slideouttype as number,model.SlideOutType,'clipboard slide');
            if(note.iscontinuedbend&&!clip.links.some(link=>link.to===note.id&&link.kind==='tie'))throw new Error('Continued bend requires its internal origin.');
            if(note.istiedestination&&!clip.links.some(link=>link.to===note.id&&link.kind==='tie')||note.isslurdestination&&!clip.links.some(link=>link.to===note.id&&link.kind==='slur')||note.ishammerpullorigin&&!clip.links.some(link=>link.from===note.id&&link.kind==='hammerPull')||[model.SlideOutType.Shift,model.SlideOutType.Legato].includes(note.slideouttype as number)&&!clip.links.some(link=>link.from===note.id&&link.kind==='slide'))throw new Error('Clipboard contains an orphan note link flag.');
          }
        }}
      }
    }
  }
}
function knownFields(raw:unknown,normalized:unknown,path='score') {
  if(!raw||typeof raw!=='object')return;
  if(Array.isArray(raw)){if(!Array.isArray(normalized)||raw.length!==normalized.length)throw new Error(`Clipboard model conversion changed its structure at ${path}.`);raw.forEach((value,index)=>knownFields(value,normalized[index],`${path}[${index}]`));return;}
  const result=object(normalized);for(const [key,value]of Object.entries(raw)){
    if(!(key in result))throw new Error(`Unsupported clipboard model field: ${key}.`);knownFields(value,result[key],`${path}.${key}`);
  }
}
function context(score:model.Score,mode:ClipboardMode) {
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars){
    if(bar.simileMark===model.SimileMark.Simple&&bar.index===0)throw new Error('Clipboard simile needs its sounding predecessor.');
    if(bar.simileMark===model.SimileMark.FirstOfDouble&&(bar.index<2||staff.bars[bar.index+1]?.simileMark!==model.SimileMark.SecondOfDouble))throw new Error('Clipboard double simile needs both predecessors and members.');
    if(bar.simileMark===model.SimileMark.SecondOfDouble&&staff.bars[bar.index-1]?.simileMark!==model.SimileMark.FirstOfDouble)throw new Error('Clipboard contains a split double simile.');
  }
  if(mode==='multiTrack'){
    if(score.masterBars.some(master=>master.directions?.size))throw new Error('Direction-bearing multitrack clipboard is not supported.');
    const stack:number[]=[];for(const master of score.masterBars){if(master.isRepeatStart)stack.push(master.index);if(master.repeatCount){if(!stack.length)throw new Error('Copy the complete repeat group.');stack.pop();}if(master.alternateEndings&&!stack.length&&!score.masterBars.slice(0,master.index+1).some(previous=>previous.repeatCount))throw new Error('Copy the complete repeat endings.');}if(stack.length)throw new Error('Copy the complete repeat group.');
  }else if(score.masterBars.some(master=>master.isRepeatStart||master.repeatCount||master.alternateEndings||master.section||master.tempoAutomations.length||master.directions?.size))throw new Error('Single track clipboard must omit global structure.');
}
function validateModel(score:model.Score,clip:MusicClip) {
  context(score,clip.mode);
  for(const master of score.masterBars){if(!integer(master.timeSignatureNumerator,1,64)||![1,2,4,8,16,32,64].includes(master.timeSignatureDenominator))throw new Error('Invalid clipboard measure rhythm.');for(const automation of master.tempoAutomations)if(automation.type!==model.AutomationType.Tempo||!Number.isFinite(automation.value)||automation.value<=0||automation.ratioPosition<0||automation.ratioPosition>1)throw new Error('Invalid clipboard tempo automation.');
    if(master.fermata?.size){const nominal=master.calculateDuration(false),duration=master.isFreeTime?Math.max(0,...score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars[master.index].voices.map(voice=>voice.beats.reduce((sum,beat)=>sum+rhythmTicks(beat,nominal),0))))):nominal;
      for(const [offset,fermata]of master.fermata){enumValue(fermata.type,model.FermataType,'clipboard fermata');if(!Number.isFinite(offset)||offset<0||offset>duration||!Number.isFinite(fermata.length)||fermata.length<=0)throw new Error('Invalid clipboard fermata length or offset.');}
    }
  }
  for(const track of score.tracks){if(!integer(track.playbackInfo.program,0,127)||!integer(track.playbackInfo.bank,0,16383))throw new Error('Invalid clipboard instrument context.');
    for(const articulation of track.percussionArticulations){if(!integer(articulation.outputMidiNumber,0,127)||!Number.isInteger(articulation.staffLine)||typeof articulation.elementType!=='string')throw new Error('Invalid clipboard percussion articulation.');for(const symbol of [articulation.noteHeadDefault,articulation.noteHeadHalf,articulation.noteHeadWhole,articulation.techniqueSymbol])enumValue(symbol,model.MusicFontSymbol,'clipboard articulation symbol');enumValue(articulation.techniqueSymbolPlacement,model.TechniqueSymbolPlacement,'clipboard articulation placement');}
    for(const staff of track.staves){if(staff.tuning.length>12||staff.tuning.some(pitch=>!integer(pitch,0,127))||!integer(staff.capo,0,127)||!integer(staff.transpositionPitch,-127,127))throw new Error('Invalid clipboard tuning or transposition.');
      for(const bar of staff.bars){enumValue(bar.simileMark,model.SimileMark,'clipboard simile');enumValue(bar.clef,model.Clef,'clipboard clef');enumValue(bar.clefOttava,model.Ottavia,'clipboard clef ottava');enumValue(bar.keySignature,model.KeySignature,'clipboard key');enumValue(bar.keySignatureType,model.KeySignatureType,'clipboard key type');for(const marker of bar.sustainPedals){enumValue(marker.pedalType,model.SustainPedalMarkerType,'clipboard sustain marker');if(!Number.isFinite(marker.ratioPosition)||marker.ratioPosition<0||marker.ratioPosition>1)throw new Error('Invalid clipboard sustain position.');}
        for(const voice of bar.voices){validateCapacity(voice);for(const beat of voice.beats){
        if(!durationValues.includes(beat.duration as never)||!integer(beat.dots,0,3)||!((beat.tupletNumerator===-1&&beat.tupletDenominator===-1)||(integer(beat.tupletNumerator,1,0xffffffff)&&integer(beat.tupletDenominator,1,0xffffffff)))||(!beat.isEmpty&&beat.graceType===model.GraceType.None&&rhythmTicks(beat)<=0))throw new Error('Invalid clipboard beat rhythm.');
        enumValue(beat.graceType,model.GraceType,'clipboard grace rhythm');if(beat.isEmpty&&beat.notes.length)throw new Error('Empty clipboard beats cannot contain notes.');
        enumValue(beat.fade,model.FadeType,'clipboard fade');enumValue(beat.vibrato,model.VibratoType,'clipboard vibrato');enumValue(beat.ottava,model.Ottavia,'clipboard ottava');enumValue(beat.rasgueado,model.Rasgueado,'clipboard rasgueado');enumValue(beat.pickStroke,model.PickStroke,'clipboard pick stroke');enumValue(beat.brushType,model.BrushType,'clipboard brush');enumValue(beat.whammyBarType,model.WhammyType,'clipboard whammy');
        if(beat.whammyBarPoints)validateCurve({type:beat.whammyBarType,style:beat.whammyStyle,points:beat.whammyBarPoints.map(point=>({offset:point.offset,value:point.value}))},true);
        if(beat.chordId&&!staff.hasChord(beat.chordId))throw new Error('Clipboard chord is missing.');
        for(const automation of beat.automations){const validValue=automation.type===model.AutomationType.Instrument?integer(automation.value,0,127):automation.type===model.AutomationType.Bank?integer(automation.value,0,16383):isGpMixAutomation(automation)&&Number.isFinite(automation.value)&&automation.value>=0&&automation.value<=16;
          if(!validValue||!Number.isFinite(automation.ratioPosition)||automation.ratioPosition<0||automation.ratioPosition>1)throw new Error('Invalid or unsupported clipboard track automation.');
        }
        const strings=new Set<number>();for(const note of beat.notes){
          enumValue(note.dynamics,model.DynamicValue,'clipboard dynamics');enumValue(note.harmonicType,model.HarmonicType,'clipboard harmonic');enumValue(note.bendType,model.BendType,'clipboard bend');enumValue(note.slideOutType,model.SlideOutType,'clipboard slide');
          enumValue(note.accentuated,model.AccentuationType,'clipboard accent');enumValue(note.bendStyle,model.BendStyle,'clipboard bend style');enumValue(note.slideInType,model.SlideInType,'clipboard slide in');enumValue(note.vibrato,model.VibratoType,'clipboard note vibrato');enumValue(note.ornament,model.NoteOrnament,'clipboard ornament');enumValue(note.accidentalMode,model.NoteAccidentalMode,'clipboard accidental');
          if(!Number.isFinite(note.durationPercent)||note.durationPercent<=0)throw new Error('Invalid clipboard note duration.');
          if(!Number.isFinite(note.harmonicValue)||note.harmonicValue<0)throw new Error('Invalid clipboard harmonic value.');if(note.bendPoints)validateCurve({type:note.bendType,style:note.bendStyle,points:note.bendPoints.map(point=>({offset:point.offset,value:point.value}))});
          if(staff.isPercussion){if(!note.isPercussion||note.isStringed||!resolvePercussionArticulation(track,note.percussionArticulation))throw new Error('Invalid clipboard percussion articulation.');}
          else if(staff.tuning.length){if(!note.isStringed||note.isPercussion||!integer(note.string,1,staff.tuning.length)||!integer(note.fret,0,127)||strings.has(note.string))throw new Error('Invalid clipboard string or fret.');strings.add(note.string);}
          else if(!note.isPiano||note.isPercussion||note.isStringed||!integer(note.tone,0,11)||!integer(note.octave,0,10))throw new Error('Invalid clipboard pitched note.');
          if(!integer(note.realValueWithoutHarmonic,0,127)||!Number.isFinite(note.realValue)||note.realValue<0||note.realValue>127)throw new Error('Invalid clipboard sounding pitch.');
        }
      }}}
    }
  }
  const lookup=new Map(allNotes(score).map(note=>[note.id,note])),owners=new Set<string>();
  for(const link of clip.links){const from=lookup.get(link.from),to=lookup.get(link.to);if(!from||!to)throw new Error('Clipboard link refers to a missing note.');
    const a=from.beat,b=to.beat;if(a.voice.bar.staff!==b.voice.bar.staff||a.voice.index!==b.voice.index||b.voice.bar.index<a.voice.bar.index||(a.voice.bar===b.voice.bar&&b.index<=a.index))throw new Error('Clipboard links must run forward in one voice lane.');
    for(const key of [`${link.kind}/from/${from.id}`,`${link.kind}/to/${to.id}`]){if(owners.has(key))throw new Error('Clipboard note has duplicate link ownership.');owners.add(key);}
    if(link.kind!=='slur'&&(from.isStringed!==to.isStringed||from.isStringed&&from.string!==to.string||nextLinkedNote(from)!==to))throw new Error('Clipboard link must reach the next matching note.');
    if(link.kind==='tie'&&from.realValue!==to.realValue)throw new Error('Clipboard tie pitch must match.');if((link.kind==='hammerPull'||link.kind==='slide')&&!from.isStringed)throw new Error('Clipboard slide and hammer links require strings.');
  }
  for(const note of lookup.values())if(note.isContinuedBend&&!clip.links.some(link=>link.to===note.id&&link.kind==='tie'))throw new Error('Continued bend requires its internal origin.');
}
/** A validated, detached app snapshot; it contains no source document provenance. */
export function readMusicClip(value:unknown):MusicClip {
  validateMusicClipEnvelope(value);const clip=value as MusicClip,raw=object(JSON.parse(clip.scoreJson));validateStructure(raw,clip);
  const score=scoreFromMusicClip(clip);knownFields(raw,JSON.parse(json(score)));validateModel(score,clip);
  return {...clip,links:clip.links.map(link=>({...link}))};
}

/** Decode an already validated clip, retaining selected events despite public finish's default PC injection. */
export function scoreFromMusicClip(clip:MusicClip):model.Score {
  const score=scoreFromJson(clip.scoreJson,settings()),raw=object(JSON.parse(clip.scoreJson)),events=new Map<number,model.Automation[]>();
  for(const t of array(raw.tracks))for(const s of array(object(t).staves))for(const b of array(object(s).bars))for(const v of array(object(b).voices))for(const b of array(object(v).beats)){
    const beat=object(b);events.set(beat.id as number,array(beat.automations).map(value=>{const automation=object(value);return Object.assign(new model.Automation(),{isLinear:automation.islinear,type:automation.type,value:automation.value,ratioPosition:automation.ratioposition,text:automation.text,isVisible:automation.isvisible});}));
  }
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)beat.automations=events.get(beat.id)??[];
  restoreNoteLinks(score,clip.links.map(link=>({...link,slideOutType:link.slideOutType??undefined})));return score;
}

/** Copy and Cut resolve exactly the same finite scope against committed music. */
export function musicClipSelection(score:model.Score,selection:MusicSelection,mode:ClipboardMode):MusicSelection {
  if(mode!=='singleTrack'&&mode!=='multiTrack')throw new Error('Invalid clipboard mode.');validateMusicSelection(score,selection);
  const normalized=structuredClone(selection);
  if(normalized.kind==='range')for(const key of ['start','end'] as const){const point=normalized.range[key],master=score.masterBars[point.bar];
    const duration=master.isFreeTime?Math.max(0,...normalized.range.lanes.map(lane=>score.tracks[lane.track].staves[lane.staff].bars[point.bar].voices[lane.voice].beats.reduce((sum,beat)=>sum+rhythmTicks(beat,master.calculateDuration(false)),0))):master.calculateDuration(false);
    if(point.tick===duration&&score.masterBars[point.bar+1])normalized.range[key]={bar:point.bar+1,tick:0};
  }
  const addresses=normalized.kind==='range'?normalized.range.lanes:normalized.kind==='notes'?normalized.notes.map(note=>note.target):normalized.tracks.map(track=>({track,staff:0,voice:0}));
  const tracks=[...new Set(addresses.map(address=>address.track))].sort((a,b)=>a-b);
  if(mode==='singleTrack'){
    if(tracks.length!==1||normalized.kind!=='bars'&&new Set(addresses.map(address=>`${address.track}/${address.staff}/${address.voice}`)).size!==1)throw new Error('Single track partial phrases require one voice lane.');
    return normalized;
  }
  if(normalized.kind==='bars')return {...normalized,tracks};
  if(normalized.kind==='range')return {kind:'bars',tracks,firstBar:normalized.range.start.bar,lastBar:normalized.range.end.bar-(normalized.range.end.tick===0?1:0)};
  const bars=normalized.notes.map(note=>note.target.bar);return {kind:'bars',tracks,firstBar:Math.min(...bars),lastBar:Math.max(...bars)};
}

/** Build a new selected-music score, never a document plus a selection mask. */
export function makeMusicClip(score:model.Score,selection:MusicSelection,mode:ClipboardMode):MusicClip {
  selection=musicClipSelection(score,selection,mode);
  const selectedBeats=resolveSelectionBeats(score,selection),selectedNotes=new Set(resolveSelectionNotes(score,selection));
  const tracks=selection.kind==='bars'?selection.tracks:selection.kind==='range'?selection.range.lanes.map(lane=>lane.track):selection.notes.map(note=>note.target.track);
  const indices=[...new Set(tracks)].sort((a,b)=>a-b),kind=mode==='multiTrack'||selection.kind==='bars'?'bars':'phrase';
  const lanes=new Set(selectedBeats.map(beat=>`${beat.voice.bar.staff.track.index}/${beat.voice.bar.staff.index}/${beat.voice.index}`));
  if(mode==='singleTrack'&&(indices.length!==1||kind==='phrase'&&lanes.size!==1))throw new Error('Single track partial phrases require one voice lane.');
  if(kind==='phrase'&&!selectedBeats.length)throw new Error('Select complete beats or copy complete empty bars.');
  let first=selection.kind==='bars'?selection.firstBar:Math.min(...selectedBeats.map(beat=>beat.voice.bar.index)),last=selection.kind==='bars'?selection.lastBar:Math.max(...selectedBeats.map(beat=>beat.voice.bar.index));
  if(selection.kind==='range'&&mode==='multiTrack'){first=selection.range.start.bar;last=selection.range.end.bar-(selection.range.end.tick===0?1:0);}
  if(!integer(first,0,score.masterBars.length-1)||!integer(last,first,score.masterBars.length-1))throw new Error('Select existing clipboard measures.');
  if(mode==='multiTrack'){
    const projection=new model.Score();for(const source of score.masterBars){const master=new model.MasterBar();master.isRepeatStart=source.isRepeatStart;master.repeatCount=source.repeatCount;master.alternateEndings=source.alternateEndings;projection.addMasterBar(master);}
    for(const group of new Set(projection.masterBars.map(master=>master.repeatGroup))){if(!group.isOpened&&!group.closings.length&&!group.masterBars.some(master=>master.alternateEndings))continue;const start=group.opening!.index;let end=group.closings.at(-1)?.index??group.masterBars.at(-1)!.index;while(end+1<projection.masterBars.length&&projection.masterBars[end+1].alternateEndings)end++;if(first<=end&&last>=start&&(first>start||last<end))throw new Error('Copy the complete repeat group and endings.');}
  }
  const clone=scoreFromJson(json(score),settings()),snapshot=new model.Score(),keptIds=new Set<number>(),spans=new Map<number,{start:number;end:number}>();
  for(let index=first;index<=last;index++){const master=clone.masterBars[index];master.syncPoints=undefined;master.nextMasterBar=null;master.previousMasterBar=null;
    if(mode==='singleTrack'){master.isRepeatStart=false;master.repeatCount=0;master.alternateEndings=0;master.section=null;master.tempoAutomations=[];master.directions=null;}
    snapshot.addMasterBar(master);
  }
  for(const index of indices){const source=score.tracks[index],copy=clone.tracks[index],track=new model.Track();track.name=copy.name;track.shortName=copy.shortName;track.color=copy.color;track.playbackInfo=copy.playbackInfo;track.percussionArticulations=copy.percussionArticulations;snapshot.addTrack(track);
    const sourceLane=selectedBeats[0]?.voice,staffIndices=kind==='phrase'?[sourceLane!.bar.staff.index]:copy.staves.map((_,staff)=>staff);
    for(const staffIndex of staffIndices){const staff=copy.staves[staffIndex],original=source.staves[staffIndex],oldBars=staff.bars;staff.bars=[];track.addStaff(staff);
      for(let barIndex=first;barIndex<=last;barIndex++){const bar=oldBars[barIndex],originalBar=original.bars[barIndex];if(kind==='phrase'){
          const voice=bar.voices[sourceLane!.index],oldBeats=voice.beats,originalVoice=originalBar.voices[sourceLane!.index],selected=originalVoice.beats.map((beat,index)=>selectedBeats.includes(beat)?index:-1).filter(index=>index>=0);
          if(!selected.length)throw new Error('Mixed empty or partial voice lanes require complete-bar copying.');const start=Math.min(...selected),end=Math.max(...selected);let tick=0;const positions=originalVoice.beats.map(beat=>{const current=tick;tick+=rhythmTicks(beat,score.masterBars[barIndex].calculateDuration(false));return current;});
          spans.set(barIndex,{start:positions[start],end:positions[end]+rhythmTicks(originalVoice.beats[end],score.masterBars[barIndex].calculateDuration(false))});voice.beats=[];
          for(let beatIndex=start;beatIndex<=end;beatIndex++){const beat=oldBeats[beatIndex],originalBeat=originalVoice.beats[beatIndex];
            if(selection.kind==='notes'&&!selectedBeats.includes(originalBeat)){const gap=new model.Beat();gap.id=beat.id;gap.duration=beat.duration;gap.dots=beat.dots;gap.tupletNumerator=beat.tupletNumerator;gap.tupletDenominator=beat.tupletDenominator;gap.graceType=beat.graceType;gap.isEmpty=beat.isEmpty;gap.overrideDisplayDuration=beat.overrideDisplayDuration;voice.addBeat(gap);}
            else{beat.notes=beat.notes.filter((_,noteIndex)=>selectedNotes.has(originalBeat.notes[noteIndex]));voice.addBeat(beat);}
          }
          const duration=score.masterBars[barIndex].calculateDuration(false),selectedTime=(tick:number)=>selected.some(index=>tick>=positions[index]&&tick<positions[index]+rhythmTicks(originalVoice.beats[index],duration));
          const master=snapshot.masterBars[barIndex-first];if(master.fermata)master.fermata=new Map([...master.fermata].filter(([tick])=>selectedTime(tick)).map(([tick,value])=>[tick-positions[start],value]));
          bar.voices=[];bar.addVoice(voice);bar.sustainPedals=bar.sustainPedals.filter(marker=>selectedTime(marker.ratioPosition*duration));
          for(const marker of bar.sustainPedals)marker.ratioPosition-=positions[start]/duration;
        }
        for(const voice of bar.voices)for(const beat of voice.beats){beat.lyrics=null;beat.automations=beat.automations.filter(automation=>!isGpMixAutomation(automation)&&!automation.syncPointValue);for(const note of beat.notes)keptIds.add(note.id);}
        staff.addBar(bar);
      }
      const referenced=new Set(staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.map(beat=>beat.chordId))));staff.chords=staff.chords?new Map([...staff.chords].filter(([id])=>referenced.has(id))):null;
    }
    for(const point of trackMixAutomations(source)){if(point.bar<first||point.bar>last)continue;const duration=score.masterBars[point.bar].calculateDuration(false),span=spans.get(point.bar)??{start:0,end:duration},tick=point.automation.ratioPosition*duration;if(tick<span.start||tick>=span.end)continue;
      const carrier=track.staves.flatMap(staff=>staff.bars[point.bar-first].voices.flatMap(voice=>voice.beats))[0];if(!carrier)throw new Error('Copied controller event requires an existing beat carrier.');
      carrier.automations.push(Object.assign(new model.Automation(),point.automation,{ratioPosition:(tick-span.start)/duration}));
    }
  }
  const links:ClipboardLink[]=captureNoteLinks(score).filter(link=>keptIds.has(link.from)&&keptIds.has(link.to)).map(link=>({...link,slideOutType:link.slideOutType??null}));
  for(const note of allNotes(score))if(keptIds.has(note.id)&&note.isContinuedBend&&(!note.bendOrigin||!keptIds.has(note.bendOrigin.id)))throw new Error('Continued bend needs its external origin; copy the full chain.');
  for(const note of allNotes(snapshot)){note.tieOrigin=null;note.tieDestination=null;note.isTieDestination=false;note.slurOrigin=null;note.slurDestination=null;note.isSlurDestination=false;note.hammerPullOrigin=null;note.hammerPullDestination=null;note.isHammerPullOrigin=false;note.slideOrigin=null;note.slideTarget=null;if(note.slideOutType===model.SlideOutType.Shift||note.slideOutType===model.SlideOutType.Legato)note.slideOutType=model.SlideOutType.None;note.bendOrigin=null;}
  restoreNoteLinks(snapshot,links.map(link=>({...link,slideOutType:link.slideOutType??undefined})));
  const clip:MusicClip={format:'TabPlayerClip',version:1,engineVersion:'1.8.4',mode,kind,scoreJson:json(snapshot),links};return readMusicClip(clip);
}
