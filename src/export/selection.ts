import { model,Settings } from '@coderline/alphatab';
import { validateSelection,type ExportSelection } from './types';
/** A detached musical score for GP output. The original and its history are never edited. */
export function selectScore(score:model.Score,selection:ExportSelection):model.Score {
  const copy=selectStaves(score,selection);
  copy.tracks=selection.tracks.map(i=>copy.tracks[i]);
  if(selection.range){
    const {first,last}=selection.range;
    // GP is a written-bar excerpt. MIDI separately exports played occurrences.
    let tempo=score.tempo;
    for(const bar of copy.masterBars.slice(0,first))for(const change of [...bar.tempoAutomations].sort((a,b)=>a.ratioPosition-b.ratioPosition))tempo=change.value;
    if(!copy.masterBars[first].tempoAutomations.some(change=>change.ratioPosition===0))copy.masterBars[first].tempoAutomations.unshift(Object.assign(new model.Automation(),{type:model.AutomationType.Tempo,value:tempo,isVisible:false}));
    for(const track of copy.tracks){
      const changes:{bar:number;tick:number;change:model.Automation}[]=[];
      for(const staff of track.staves)for(const bar of staff.bars.slice(0,first+1))for(const voice of bar.voices)for(const beat of voice.beats)for(const change of beat.automations){
        if(bar.index<first||beat.playbackStart===0&&change.ratioPosition===0)changes.push({bar:bar.index,tick:beat.playbackStart,change});
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
  return model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(copy),new Settings());
}
/** Retains original track indexing for public MIDI/playback plan generation. */
export function selectStaves(score:model.Score,selection:ExportSelection):model.Score {
  validateSelection(score.tracks.length,score.masterBars.length,selection,score.tracks.map(t=>t.staves.length));
  const copy=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),new Settings());
  for(const [track,staves]of Object.entries(selection.staves??{}))copy.tracks[Number(track)].staves=staves.map(i=>copy.tracks[Number(track)].staves[i]);
  return model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(copy),new Settings());
}
