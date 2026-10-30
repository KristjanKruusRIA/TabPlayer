import { midi,model,Settings, type io } from '@coderline/alphatab';
import { validateSelection,type ExportSelection } from './types';
import { selectStaves } from './selection';
import { deadBrushMidiDurations,noteAudioMidiAdjustments,prepareMidiScore } from '../audio/plan';
import { hasNoteAudio } from '../editor/note-audio';
import { gpControllerEvents,prepareGpMidiScore } from '../interchange/automation';
class TrackName extends midi.MidiEvent {
  constructor(track:number,readonly name:string){super(track,0,midi.MidiEventType.Meta);}
  writeTo(stream:io.IWriteable){const bytes=new TextEncoder().encode(this.name);stream.writeByte(255);stream.writeByte(3);midi.MidiFile.writeVariableInt(stream,bytes.length);stream.write(bytes,0,bytes.length);}
}
class ExportMidiHandler extends midi.AlphaSynthMidiFileHandler {
  pairs:{on:midi.NoteOnEvent;off:midi.NoteOffEvent;attack:number}[]=[];
  private attacks=new Map<number,number>();
  // Guitar Pro mixes are fractional on the 0–16 scale; alphaTab scales them by 8 unrounded
  // and the writer truncates, so round volume and pan as the playback plan does.
  override addControlChange(track:number,tick:number,channel:number,controller:number,value:number){
    super.addControlChange(track,tick,channel,controller,controller===7||controller===10?Math.round(value):value);
  }
  override addNote(track:number,start:number,length:number,key:number,velocity:number,channel:number){
    super.addNote(track,start,length,key,velocity,channel);
    const attack=this.attacks.get(track)??0;this.attacks.set(track,attack+1);
    key=Math.max(0,Math.min(127,key));velocity=Math.max(0,Math.min(127,velocity));start+=this.tickShift;
    this.pairs.push({on:new midi.NoteOnEvent(track,start,channel,key,velocity),off:new midi.NoteOffEvent(track,start+length,channel,key,velocity),attack});
  }
}
const stateKey=(event:midi.MidiEvent)=> event instanceof midi.ProgramChangeEvent?`p/${event.track}/${event.channel}`:
  event instanceof midi.ControlChangeEvent?`c/${event.track}/${event.channel}/${event.controller}`:
  event instanceof midi.PitchBendEvent?`b/${event.track}/${event.channel}`:
  event instanceof midi.TempoChangeEvent?'tempo':event instanceof midi.TimeSignatureEvent?'meter':null;
function shifted(event:midi.MidiEvent,tick:number,track:number):midi.MidiEvent {
  // Concrete event prototypes retain alphaTab's public binary encoding; source events stay immutable.
  return Object.assign(Object.create(Object.getPrototypeOf(event)),event,{tick,track});
}
export function exportMidi(score:model.Score,selection:ExportSelection):Uint8Array {
  validateSelection(score.tracks.length,score.masterBars.length,selection,score.tracks.map(t=>t.staves.length));
  const source=new midi.MidiFile();source.format=midi.MidiFileFormat.MultiTrack;
  const prepared=prepareGpMidiScore(prepareMidiScore(selectStaves(score,selection)),new Settings());
  // Keep source track identities for handler routing, but allocate SMF channels
  // globally: imported logical channels above 15 would otherwise wrap on write.
  prepared.tracks=selection.tracks.map(i=>prepared.tracks[i]);
  const melodic=prepared.tracks.filter(track=>!track.isPercussion);
  if(melodic.length>15)throw new Error('MIDI supports at most 15 melodic tracks. Select fewer tracks to export.');
  const channels=Array.from({length:16},(_,i)=>i).filter(i=>i!==9);let channel=0;
  for(const track of prepared.tracks){track.playbackInfo.primaryChannel=track.isPercussion?9:channels[channel++];track.playbackInfo.secondaryChannel=track.playbackInfo.primaryChannel;}
  for(const track of melodic)track.playbackInfo.secondaryChannel=channels[channel++]??track.playbackInfo.primaryChannel;
  const settings=new Settings(),handler=new ExportMidiHandler(source,true);const generator=new midi.MidiFileGenerator(prepared,settings,handler);
  generator.applyTranspositionPitches=true;generator.generate();
  const performed=generator.tickLookup.masterBars.map(bar=>({bar:bar.masterBar.index,startTick:bar.start+source.tickShift,endTick:bar.end+source.tickShift}));
  for(const event of gpControllerEvents(prepared,performed))source.addEvent(new midi.ControlChangeEvent(event.track,event.tick,event.channel,event.controller,event.value));
  const selected=new Set(selection.tracks);const remap=new Map(selection.tracks.map((n,i)=>[n,i+1]));
  const conductor=(e:midi.MidiEvent)=>e instanceof midi.TempoChangeEvent||e instanceof midi.TimeSignatureEvent;
  // 1.8.4's aggregate events getter recurses for multiple tracks.
  const events=source.tracks.flatMap(track=>track.events).sort((a,b)=>a.tick-b.tick).filter(e=>conductor(e)||selected.has(e.track));
  const noteSpans=handler.pairs,invalid=noteSpans.filter(pair=>pair.off.tick<=pair.on.tick);
  if(invalid.length){
    // Use the same source-note proof and public unbrushed duration as playback.
    const durations=new Map(deadBrushMidiDurations(selectStaves(score,selection)).map(value=>[`${value.track}/${value.attack}`,value.length]));
    for(const pair of invalid){const length=durations.get(`${pair.on.track}/${pair.attack}`);if(!length)throw new Error('MIDI export could not recover a nonpositive note duration.');pair.off.tick=pair.on.tick+length;}
  }
  // A note's own start, length and velocity settings, found by the same attack ordinals as the corrections above.
  const audible=new Map((hasNoteAudio(score)?noteAudioMidiAdjustments(selectStaves(score,selection)):[]).map(value=>[`${value.track}/${value.attack}`,value]));
  if(audible.size)for(const pair of noteSpans){
    const value=audible.get(`${pair.on.track}/${pair.attack}`);if(!value)continue;
    pair.on.tick+=value.shift;pair.off.tick=pair.on.tick+value.length;pair.on.noteVelocity=pair.off.noteVelocity=value.velocity;
  }
  const output=new midi.MidiFile();output.division=source.division;output.format=midi.MidiFileFormat.MultiTrack;
  for(const track of selection.tracks)output.addEvent(new TrackName(remap.get(track)!,score.tracks[track].name));
  const bars=generator.tickLookup.masterBars.filter(b=>!selection.range||(b.masterBar.index>=selection.range.first&&b.masterBar.index<=selection.range.last));
  const segments:{start:number;end:number}[]=[];
  for(const bar of bars){
    const leading=prepared.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars[bar.masterBar.index].voices.flatMap(v=>v.beats.filter(b=>b.graceType!==model.GraceType.None).map(b=>generator.tickLookup.getRelativeBeatPlaybackRange(b)?.startTick??0))));
    const previous=segments.at(-1),start=Math.max(0,bar.start+source.tickShift+Math.min(0,...leading)),end=bar.end+source.tickShift;
    if(previous&&start<=previous.end)previous.end=Math.max(previous.end,end);else segments.push({start,end});
  }
  let offset=0;
  for(const segment of segments) {
    const state=new Map<string,midi.MidiEvent>();
    for(const e of events){if(e.tick>segment.start)break;const key=stateKey(e);if(key)state.set(key,e);}
    for(const e of state.values())output.addEvent(shifted(e,offset,conductor(e)?0:remap.get(e.track)!));
    for(const e of events) {
      if(e.tick<segment.start||e.tick>=segment.end||e instanceof midi.EndOfTrackEvent||e instanceof midi.NoteOnEvent||e instanceof midi.NoteOffEvent||stateKey(e)&&e.tick===segment.start)continue;
      const track=conductor(e)?0:remap.get(e.track)!;
      output.addEvent(shifted(e,e.tick-segment.start+offset,track));
    }
    for(const {on,off} of noteSpans){if(on.tick>=segment.end||off.tick<=segment.start)continue;const track=remap.get(on.track)!;output.addEvent(shifted(on,Math.max(on.tick,segment.start)-segment.start+offset,track));output.addEvent(shifted(off,Math.min(off.tick,segment.end)-segment.start+offset,track));}
    offset+=segment.end-segment.start;
  }
  for(let track=0;track<=selection.tracks.length;track++)output.addEvent(new midi.EndOfTrackEvent(track,offset));
  return output.toBinary();
}
