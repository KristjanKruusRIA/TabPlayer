import { expect,it } from 'vitest';
import { importer,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { allNotes,captureNoteLinks } from '../editor/links';
import { applyHarmonyEdit } from '../harmony/edits';
import { getHarmonyChord } from '../harmony/chord-source';
import { applyLyricsEdit } from '../editor/lyrics';
import { getLyricsSource } from '../editor/lyrics-source';
import { exportMidi } from '../export/midi';
import { copyGpInterchangeSource,exportGpInterchange,loadInterchangeScore } from './gp';

const settings=new Settings(),path='Content/score.gpif',target={track:0,staff:1,bar:0,voice:0,beat:0};
const chord={name:'Dm legacy',nameMode:'manual' as const,recipe:null,firstFret:1,frets:[1,3,2,0,-1,-1],fingers:[1,3,2,-2,-2,-2],barreFrets:[],showName:false,showDiagram:true,showFingering:false};
function authored(freeTime=false) {
  const score=music(),staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];score.tracks[0].addStaff(staff);
  for(const master of score.masterBars){master.isFreeTime=freeTime;const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.isEmpty=true;beat.duration=model.Duration.Quarter;voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
  score.finish(settings);const first=score.tracks[0].staves[0].bars[0].voices[0].beats[0];first.dynamics=3;first.notes[0].dynamics=3;
  const next=first.nextBeat!;first.notes[0].tieDestination=next.notes[0];next.notes[0].tieOrigin=first.notes[0];next.notes[0].isTieDestination=true;
  applyHarmonyEdit(score,{type:'setHarmonyChord',target,chord,fillEmptyBeat:false},1);return score;
}
const carrier=(score:model.Score)=>score.tracks[0].staves[1].bars[0].voices[0].beats[0];
const fingerprint=(score:model.Score)=>JSON.stringify([model.JsonConverter.scoreToJson(score),captureNoteLinks(score),score.tracks.map(getLyricsSource),score.tracks[0].staves.flatMap(staff=>[...staff.chords??[]].map(([id,chord])=>[id,getHarmonyChord(chord)])),score.backingTrack?.rawAudioFile]);
const durations=(score:model.Score)=>({master:score.masterBars.map(bar=>bar.calculateDuration()),staves:score.tracks[0].staves.map(staff=>staff.bars.map(bar=>({bar:bar.calculateDuration(),voices:bar.voices.map(voice=>voice.calculateDuration())})))});
function smf(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),notes:number[][]=[],ends:number[]=[];let cursor=8+view.getUint32(4),track=0;
  const variable=()=>{let value=0,byte:number;do{byte=bytes[cursor++];value=value*128+(byte&127);}while(byte&128);return value;};
  while(cursor<bytes.length){const end=cursor+8+view.getUint32(cursor+4);cursor+=8;let tick=0,running=0;
    while(cursor<end){tick+=variable();let status=bytes[cursor++];if(status<128){cursor--;status=running;}else if(status<240)running=status;
      if(status===255){const type=bytes[cursor++],length=variable();if(type===47)ends.push(tick);cursor+=length;}
      else if(status===240||status===247)cursor+=variable();
      else{const kind=status&240,key=bytes[cursor++],value=kind===192||kind===208?0:bytes[cursor++];if(kind===128||kind===144)notes.push([track,tick,kind,key,value]);}
    }track++;
  }return {notes,ends};
}

it.each([false,true])('projects_only_a_detached_quarter_carrier_to_a_standard_silent_rest_without_changing_the_music_clock (free time %s)',freeTime=>{
  const score=authored(freeTime),before=fingerprint(score),clock=durations(score),midi=smf(exportMidi(score,{tracks:[0],range:null})),bytes=exportGpInterchange(score,settings),reopened=loadInterchangeScore(bytes,settings),after=durations(reopened);
  expect(carrier(reopened).chordId).toBe(carrier(score).chordId);expect(getHarmonyChord(carrier(reopened).chord!)).toEqual(chord);
  expect(carrier(reopened).notes).toEqual([]);expect(carrier(reopened).isEmpty).toBe(false);expect(carrier(reopened).duration).toBe(4);
  expect(clock.master).toEqual([3840,3840,3840,3840]);expect(after.master).toEqual(clock.master);expect(after.staves[0]).toEqual(clock.staves[0]);
  expect(clock.staves[1][0]).toEqual({bar:0,voices:[0]});expect(after.staves[1][0]).toEqual({bar:960,voices:[960]});
  expect(smf(exportMidi(reopened,{tracks:[0],range:null}))).toEqual(midi);expect(midi.ends).toEqual([15360,15360]);expect(midi.notes.some(event=>event[2]===144&&event[4]===63)).toBe(true);
  expect(allNotes(reopened)).toHaveLength(allNotes(score).length);expect(fingerprint(score)).toBe(before);expect(carrier(score).isEmpty).toBe(true);
  const xml=new DOMParser().parseFromString(strFromU8(unzipSync(bytes)[path]),'application/xml');expect(xml.querySelector('GPIF > Bars > Bar:nth-child(5) > Voices')?.textContent).not.toBe('-1');
});

it('keeps_the_existing_explicit_rest_path_and_does_not_apply_empty_carrier_rhythm_restrictions_to_it',()=>{
  const score=authored(),beat=carrier(score);beat.isEmpty=false;beat.duration=model.Duration.Half;score.finish(settings);const before=fingerprint(score),reopened=loadInterchangeScore(exportGpInterchange(score,settings),settings);
  expect(carrier(reopened).chordId).toBe(beat.chordId);expect(carrier(reopened).duration).toBe(2);expect(fingerprint(score)).toBe(before);
});

it.each(['duration','dots','multiple','clock'] as const)('rejects_an_unsupported_empty_carrier_%s_without_inventing_a_rhythm_or_changing_source',kind=>{
  const score=authored(),beat=carrier(score);
  if(kind==='duration')beat.duration=0 as model.Duration;if(kind==='dots')beat.dots=1;
  if(kind==='multiple'){const another=new model.Beat();another.isEmpty=true;beat.voice.addBeat(another);}
  if(kind==='clock'){score.masterBars[0].isAnacrusis=true;const voice=score.tracks[0].staves[0].bars[0].voices[0];voice.beats=voice.beats.slice(0,1);voice.beats[0].duration=model.Duration.Eighth;score.finish(settings);}
  const before=fingerprint(score);expect(()=>exportGpInterchange(score,settings)).toThrow(/carrier|rhythm|clock/i);expect(fingerprint(score)).toBe(before);
});

it('preserves_source_links_dynamics_archive_backing_and_raw_cdata_lyrics_through_the_conditional_carrier_clone',()=>{
  const score=authored();applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:'exact\r\n]]> lyric'}]});score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=new Uint8Array([82,73,70,70,1,2,3,4]);
  const entries=unzipSync(exportGpInterchange(score,settings));entries['Content/Assets/carrier-sentinel.txt']=strToU8('archive sibling');const archive=loadInterchangeScore(zipSync(entries),settings);copyGpInterchangeSource(archive,score);
  // Installing archive provenance should not replace this authored lyric source.
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:'exact\r\n]]> lyric'}]});
  const before=fingerprint(score),links=captureNoteLinks(score),bytes=exportGpInterchange(score,settings),output=unzipSync(bytes),reopened=loadInterchangeScore(bytes,settings);
  expect(output['Content/Assets/carrier-sentinel.txt']).toEqual(strToU8('archive sibling'));expect(reopened.backingTrack?.rawAudioFile).toEqual(score.backingTrack.rawAudioFile);expect(getLyricsSource(reopened.tracks[0])?.value.lines[0].text).toBe('exact\r\n]]> lyric');
  expect(getHarmonyChord(carrier(reopened).chord!)).toEqual(chord);expect(captureNoteLinks(score)).toEqual(links);expect(fingerprint(score)).toBe(before);
  expect(importer.ScoreLoader.loadScoreFromBytes(bytes,settings).tracks[0].staves[1].bars[0].voices[0].beats[0].chordId).toBe(carrier(score).chordId);
});
