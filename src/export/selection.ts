import { model,Settings } from '@coderline/alphatab';
import { validateSelection,type ExportSelection } from './types';
/** A detached musical score for GP output. The original and its history are never edited. */
export function selectScore(score:model.Score,selection:ExportSelection):model.Score {
  const copy=selectStaves(score,selection);
  copy.tracks=selection.tracks.map(i=>copy.tracks[i]);
  if(selection.range){const {first,last}=selection.range;copy.masterBars=copy.masterBars.slice(first,last+1);for(const track of copy.tracks)for(const staff of track.staves)staff.bars=staff.bars.slice(first,last+1);}
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
