import { model,Settings } from '@coderline/alphatab';
import { validateSelection,type ExportSelection } from './types';
import { scoreFromJson } from '../model-clone';
import { copyGpInterchangeSource,forgetTrackOrderedEntries } from '../interchange/gp';
import { isGpMixAutomation,trackMixAutomations } from '../interchange/automation';
import { captureNoteLinks,restoreNoteLinks } from '../editor/links';
import { applyLyricsEdit,reconstructTrackLyrics } from '../editor/lyrics';
import { getLyricsSource,setLyricsSource } from '../editor/lyrics-source';
import { remapStylesheetTracks } from '../engraving/projection';
import { setTempoUnit,tempoUnitOf } from '../editor/tempo-unit';

function materializeCutSimiles(score:model.Score,first:number,last:number):void {
  const links=captureNoteLinks(score),copies=new Map<number,Map<number,number>>();
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars.slice(first,last+1)) {
    const mark=bar.simileMark;
    if(mark===model.SimileMark.None)continue;
    const pairStart=mark===model.SimileMark.SecondOfDouble?bar.index-1:bar.index;
    if(mark===model.SimileMark.Simple?bar.index-1>=first:pairStart-2>=first&&pairStart+1<=last)continue;
    let source=bar;
    while(source.simileMark!==model.SimileMark.None) {
      const previous=staff.bars[source.index-(source.simileMark===model.SimileMark.Simple?1:2)];
      if(!previous)break;source=previous;
    }
    // Serialize only the sounding source bar; its parent objects are read-only shells.
    const shell=new model.Score();shell.masterBars=[source.masterBar];
    shell.tracks=[Object.assign(new model.Track(),track,{staves:[Object.assign(new model.Staff(),staff,{bars:[source]})]})];
    const cloned=scoreFromJson(model.JsonConverter.scoreToJson(shell),new Settings()).tracks[0].staves[0].bars[0];
    const offset=bar.index-source.index;let ids=copies.get(offset);if(!ids){ids=new Map();copies.set(offset,ids);}
    const mix=bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations.filter(isGpMixAutomation)));
    const lyrics=new Map(bar.voices[0].beats.map(beat=>[beat.playbackStart,beat.lyrics]));
    for(const voice of cloned.voices) {
      voice.id=new model.Voice().id;voice.bar=bar;
      for(const beat of voice.beats) {
        beat.id=new model.Beat().id;beat.fermata=null;beat.lyrics=voice.index===0?lyrics.get(beat.playbackStart)??null:null;
        beat.automations=beat.automations.filter(change=>!isGpMixAutomation(change));
        for(const note of beat.notes){const old=note.id;note.id=new model.Note().id;ids.set(old,note.id);}
      }
    }
    cloned.voices[0].beats[0].automations.push(...mix);bar.voices=cloned.voices;bar.simileMark=model.SimileMark.None;
  }
  if(copies.size)restoreNoteLinks(score,[...links,...[...copies.values()].flatMap(ids=>links.filter(link=>ids.has(link.from)&&ids.has(link.to)).map(link=>({...link,from:ids.get(link.from)!,to:ids.get(link.to)!})))]);
}
/** A detached musical score for GP output. The original and its history are never edited. */
export function selectScore(score:model.Score,selection:ExportSelection):model.Score {
  const copy=selectStaves(score,selection);
  remapStylesheetTracks(copy.stylesheet,copy.tracks.map((_,index)=>{const next=selection.tracks.indexOf(index);return next<0?null:next;}));
  copy.tracks=selection.tracks.map(i=>copy.tracks[i]);
  if(selection.range){
    const {first,last}=selection.range;
    const lyricSources=copy.tracks.map(getLyricsSource);
    // Excerpt hidden source using its placement on this detached full score only.
    lyricSources.forEach((source,track)=>{if(source&&!source.value.visible)applyLyricsEdit(copy,{type:'setTrackLyrics',track,visible:true,lines:source.value.lines.map(line=>line.startBar<copy.masterBars.length?line:{startBar:0,text:''})});});
    materializeCutSimiles(copy,first,last);
    // GP is a written-bar excerpt. MIDI separately exports played occurrences.
    let tempo=score.tempo,tempoUnit=tempoUnitOf(score.masterBars[0].tempoAutomations.find(change=>change.ratioPosition===0&&change.value===tempo)??new model.Automation());
    for(const bar of copy.masterBars.slice(0,first))for(const change of [...bar.tempoAutomations].sort((a,b)=>a.ratioPosition-b.ratioPosition)){tempo=change.value;tempoUnit=tempoUnitOf(change);}
    if(!copy.masterBars[first].tempoAutomations.some(change=>change.ratioPosition===0)){
      const inherited=Object.assign(new model.Automation(),{type:model.AutomationType.Tempo,value:tempo,isVisible:false});setTempoUnit(inherited,tempoUnit);
      copy.masterBars[first].tempoAutomations.unshift(inherited);
    }
    for(const track of copy.tracks){
      const changes:{bar:number;tick:number;change:model.Automation}[]=[];
      for(const staff of track.staves)for(const bar of staff.bars.slice(0,first+1))for(const voice of bar.voices)for(const beat of voice.beats)for(const change of beat.automations){
        const tick=isGpMixAutomation(change)?change.ratioPosition*bar.masterBar.calculateDuration(false):beat.playbackStart;
        if(bar.index<first||tick===0&&change.ratioPosition===0)changes.push({bar:bar.index,tick,change});
      }
      changes.sort((a,b)=>a.bar-b.bar||a.tick-b.tick||a.change.ratioPosition-b.change.ratioPosition);
      for(const {change}of changes){
        if(change.type===model.AutomationType.Instrument)track.playbackInfo.program=change.value;
        else if(change.type===model.AutomationType.Volume)track.playbackInfo.volume=change.value;
        else if(change.type===model.AutomationType.Balance)track.playbackInfo.balance=change.value;
        else if(change.type===model.AutomationType.Bank&&!change.syncPointValue)track.playbackInfo.bank=change.value;
      }
      for(const staff of track.staves){
        let held=false;
        for(const bar of staff.bars.slice(0,first))for(const marker of [...bar.sustainPedals].sort((a,b)=>a.ratioPosition-b.ratioPosition)){
          if(marker.pedalType===model.SustainPedalMarkerType.Down)held=true;else if(marker.pedalType===model.SustainPedalMarkerType.Up)held=false;
        }
        const pedals=staff.bars[first].sustainPedals;
        if(held&&!pedals.some(marker=>marker.ratioPosition===0&&marker.pedalType!==model.SustainPedalMarkerType.Hold))pedals.unshift(Object.assign(new model.SustainPedalMarker(),{pedalType:model.SustainPedalMarkerType.Down}));
        staff.bars=staff.bars.slice(first,last+1);
      }
    }
    for(const bar of copy.masterBars.slice(first,last+1)){
      const group=bar.repeatGroup,context=[group.opening!,...group.closings,...group.masterBars.filter(candidate=>candidate.alternateEndings!==0)];
      if(!group.isClosed||context.some(candidate=>candidate.index<first||candidate.index>last)){bar.isRepeatStart=false;bar.repeatCount=0;bar.alternateEndings=0;}
    }
    copy.masterBars=copy.masterBars.slice(first,last+1);
    copy.tracks.forEach((track,index)=>{
      const source=lyricSources[index],value=reconstructTrackLyrics(track);
      value.lines=value.lines.map(line=>({...line,startBar:Math.max(0,line.startBar-first)}));
      if(source) {
        value.visible=source.value.visible;
        for(const [lineIndex,line]of source.value.lines.entries())if(!value.lines[lineIndex]?.text)value.lines[lineIndex]={startBar:Math.max(0,Math.min(last-first,line.startBar-first)),text:''};
      }
      if(!value.visible)applyLyricsEdit(copy,{type:'setTrackLyrics',track:index,...value});else setLyricsSource(track,value,true);
    });
  }
  const notes=new Set(copy.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(b=>b.notes))))));
  for(const note of notes){
    if(note.tieOrigin&&!notes.has(note.tieOrigin)){note.tieOrigin=null;note.isTieDestination=false;}
    if(note.tieDestination&&!notes.has(note.tieDestination))note.tieDestination=null;
    if(note.slurOrigin&&!notes.has(note.slurOrigin)){note.slurOrigin=null;note.isSlurDestination=false;}
    if(note.slurDestination&&!notes.has(note.slurDestination))note.slurDestination=null;
    if(note.slideOrigin&&!notes.has(note.slideOrigin))note.slideOrigin=null;
    if(note.slideTarget&&!notes.has(note.slideTarget)){note.slideTarget=null;note.slideOutType=model.SlideOutType.None;}
    if(note.hammerPullOrigin&&!notes.has(note.hammerPullOrigin))note.hammerPullOrigin=null;
    if(note.hammerPullDestination&&!notes.has(note.hammerPullDestination)){note.hammerPullDestination=null;note.isHammerPullOrigin=false;}
  }
  const result=scoreFromJson(model.JsonConverter.scoreToJson(copy),new Settings());restoreNoteLinks(result,captureNoteLinks(copy));copyGpInterchangeSource(copy,result);
  // The source file's views describe its tracks by position; a subset or a new order would leave them describing other tracks.
  if(selection.tracks.length!==score.tracks.length||selection.tracks.some((track,index)=>track!==index))forgetTrackOrderedEntries(result);
  result.tracks.forEach((track,t)=>{
    (track as any).sourceIndex=(score.tracks[selection.tracks[t]] as any)?.sourceIndex??selection.tracks[t];
    track.staves.forEach(staff=>{
      staff.bars.forEach((bar,b)=>{
        const offset=(selection.range?.first??0)+b;
        (bar as any).sourceIndex=(score.tracks[selection.tracks[t]]?.staves[0]?.bars[offset] as any)?.sourceIndex??offset;
      });
    });
  });
  return result;
}
/** Retains original track indexing for public MIDI/playback plan generation. */
export function selectStaves(score:model.Score,selection:ExportSelection):model.Score {
  validateSelection(score.tracks.length,score.masterBars.length,selection,score.tracks.map(t=>t.staves.length));
  const copy=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());restoreNoteLinks(copy,captureNoteLinks(score));
  copyGpInterchangeSource(score,copy);
  for(const [index,staves]of Object.entries(selection.staves??{})) {
    const track=copy.tracks[Number(index)],mix=trackMixAutomations(track);
    track.staves=staves.map(i=>track.staves[i]);
    if(staves[0]!==0){const value=reconstructTrackLyrics(track);value.visible=getLyricsSource(track)?.value.visible??true;setLyricsSource(track,value,true);}
    for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)beat.automations=beat.automations.filter(change=>!isGpMixAutomation(change));
    for(const {bar,automation}of mix) {
      const voice=track.staves[0].bars[bar].voices[0];
      if(!voice.beats.length){const carrier=new model.Beat();carrier.isEmpty=true;voice.addBeat(carrier);}
      voice.beats[0].automations.push(Object.assign(new model.Automation(),automation));
    }
  }
  const result=scoreFromJson(model.JsonConverter.scoreToJson(copy),new Settings());restoreNoteLinks(result,captureNoteLinks(copy));copyGpInterchangeSource(copy,result);return result;
}
