// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strFromU8,unzipSync } from 'fflate';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlaybackPlan,buildPlaybackPlanFromJson } from '../audio/plan';
import { captureNoteLinks } from '../editor/links';
import { exportMidi } from '../export/midi';
import { exportGpInterchange,loadInterchangeScore } from './gp';

const settings=new Settings();
const selection={tracks:[0],range:{first:0,last:0}};
function fixture(offset:number,display=0,written=60,alternate=62) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  score.addMasterBar(new model.MasterBar());score.addTrack(track);track.addStaff(staff);
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  track.name='Pitched trill';staff.stringTuning.tunings=[];staff.showTablature=false;
  staff.transpositionPitch=offset;staff.displayTranspositionPitch=display;
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat(),note=new model.Note();
  staff.addBar(bar);bar.addVoice(voice);voice.addBeat(beat);beat.duration=model.Duration.Whole;beat.isEmpty=false;
  note.octave=Math.floor(written/12);note.tone=written%12;note.trillValue=alternate;note.trillSpeed=model.Duration.Sixteenth;beat.addNote(note);
  score.finish(settings);note.dynamics=3;return score;
}
const noteOf=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];

// Reads SMF chunks, delta clocks and running status without alphaTab's MIDI reader/generator.
function decode(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(size:number)=>String.fromCharCode(...bytes.slice(p,p+=size));
  const u16=()=>{const n=view.getUint16(p);p+=2;return n;},u32=()=>{const n=view.getUint32(p);p+=4;return n;};
  const variable=()=>{let n=0,b;do{b=bytes[p++];n=n*128+(b&127);}while(b&128);return n;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const tracks=u16(),ppq=u16();
  const attacks:{tick:number;key:number;velocity:number}[]=[],releases:{tick:number;key:number}[]=[],ends:number[]=[];
  for(let track=0;track<tracks;track++) {
    expect(ascii(4)).toBe('MTrk');const size=u32(),end=p+size;let tick=0,running=0;
    while(p<end) {
      tick+=variable();let status=bytes[p++];
      if(status<128){p--;status=running;}else if(status<240)running=status;
      if(status===255){const kind=bytes[p++],length=variable();if(kind===47)ends.push(tick);p+=length;}
      else if(status===240||status===247){const length=variable();p+=length;}
      else {const kind=status&240,key=bytes[p++],value=kind===192||kind===208?0:bytes[p++];
        if(kind===144&&value>0)attacks.push({tick,key,velocity:value});
        else if(kind===128||kind===144)releases.push({tick,key});
      }
    }
    expect(p).toBe(end);
  }
  expect(p).toBe(bytes.length);return {ppq,attacks,releases,ends};
}
const attacks=(base:number,alternate:number)=>Array.from({length:16},(_,i)=>({tick:i*240,key:i%2===0?base:alternate,velocity:63}));
const releases=(base:number,alternate:number)=>Array.from({length:16},(_,i)=>({tick:(i+1)*240,key:i%2===0?base:alternate}));
function assertRoutes(score:model.Score,base:number,alternate:number) {
  const json=model.JsonConverter.scoreToJson(score),links=captureNoteLinks(score),note=noteOf(score);
  const canonical={id:note.id,octave:note.octave,tone:note.tone,trillValue:note.trillValue,dynamics:note.dynamics};
  const mid=exportMidi(score,selection),decoded=decode(mid);
  expect(decoded.attacks).toEqual(attacks(base,alternate));expect(decoded.releases).toEqual(releases(base,alternate));
  expect(decoded.ppq).toBe(960);expect(decoded.ends).toEqual([3840,3840]);
  for(const plan of [buildPlaybackPlan(score,7),buildPlaybackPlanFromJson(json,['base/0'],7)]) {
    expect(plan.notes.map(n=>({tick:n.startTick,key:n.key,velocity:n.velocity}))).toEqual(attacks(base,alternate));
    expect(plan.notes.map(n=>({tick:n.endTick,key:n.key}))).toEqual(releases(base,alternate));
    expect(plan.notes.map(n=>n.source)).toEqual(Array.from({length:16},()=>({target:{track:0,staff:0,bar:0,voice:0,beat:0},string:0})));
    expect(plan.ppq).toBe(960);expect(plan.durationTick).toBe(3840);
  }
  const gp=exportGpInterchange(score,settings),doc=new DOMParser().parseFromString(strFromU8(unzipSync(gp)['Content/score.gpif']),'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  const nodes=[...doc.querySelectorAll('GPIF > Notes > Note')];expect(nodes).toHaveLength(1);
  expect(nodes[0].querySelector('Trill')?.textContent).toBe(String(alternate));
  expect(Number(nodes[0].querySelector('Property[name="Octave"] > Number')?.textContent)*12+Number(nodes[0].querySelector('Property[name="Tone"] > Step')?.textContent)).toBe(base);
  const refs=[...doc.querySelectorAll('GPIF > Beats > Beat > Notes')].flatMap(n=>n.textContent!.trim().split(/\s+/));
  expect(refs).toEqual([String(note.id)]);expect(nodes[0].getAttribute('id')).toBe(refs[0]);
  expect(decode(exportMidi(loadInterchangeScore(gp,settings),selection)).attacks.map(n=>({tick:n.tick,key:n.key}))).toEqual(attacks(base,alternate).map(({tick,key})=>({tick,key})));
  expect(model.JsonConverter.scoreToJson(score)).toBe(json);expect(captureNoteLinks(score)).toEqual(links);
  expect(noteOf(score)).toMatchObject(canonical);return {mid,gp};
}

it.each([{offset:12,base:48,alternate:50},{offset:-12,base:72,alternate:74},{offset:0,base:60,alternate:62}])('pitched_trill_literal_midi_plan_and_gp_contract offset $offset',({offset,base,alternate})=>{
  const pair=assertRoutes(fixture(offset),base,alternate);
  // Explicit root-only artifact retention: existing directory, exclusive creation, stable names.
  const directory=process.env.TABPLAYER_PITCHED_TRILL_ARTIFACT_DIR;
  if(directory&&offset!==0){const name=`pitched-trills-${offset===12?'plus12':'minus12'}`;writeFileSync(join(directory,`${name}.mid`),pair.mid,{flag:'wx'});writeFileSync(join(directory,`${name}.gp`),pair.gp,{flag:'wx'});}
});
it('display_plus7_preserves_literal_sounding_trill_and_low_boundary_zero_two',()=>{
  assertRoutes(fixture(12,7),48,50);assertRoutes(fixture(-12,7),72,74);assertRoutes(fixture(12,7,12,14),0,2);
});
it('mixed_pitched_offsets_keep_independent_trills_in_midi_and_both_plan_routes',()=>{
  const score=fixture(12),lower=fixture(-12).tracks[0].staves[0];score.tracks[0].addStaff(lower);score.finish(settings);
  for(const staff of score.tracks[0].staves)staff.bars[0].voices[0].beats[0].notes[0].dynamics=3;
  const json=model.JsonConverter.scoreToJson(score),links=captureNoteLinks(score);
  const expected=[...attacks(48,50),...attacks(72,74)].sort((a,b)=>a.tick-b.tick||a.key-b.key);
  expect(decode(exportMidi(score,selection)).attacks.sort((a,b)=>a.tick-b.tick||a.key-b.key)).toEqual(expected);
  for(const plan of [buildPlaybackPlan(score,7),buildPlaybackPlanFromJson(json,['base/0'],7)])expect(plan.notes.map(n=>({tick:n.startTick,key:n.key,velocity:n.velocity})).sort((a,b)=>a.tick-b.tick||a.key-b.key)).toEqual(expected);
  const doc=new DOMParser().parseFromString(strFromU8(unzipSync(exportGpInterchange(score,settings))['Content/score.gpif']),'application/xml');
  expect([...doc.querySelectorAll('GPIF > Notes > Note > Trill')].map(n=>n.textContent)).toEqual(['50','74']);
  expect(model.JsonConverter.scoreToJson(score)).toBe(json);expect(captureNoteLinks(score)).toEqual(links);
});
it('trill_chord_retains_ordinary_neighbor_without_lane_carrier_attacks',()=>{
  const score=fixture(12),trill=noteOf(score),neighbor=new model.Note();neighbor.octave=5;neighbor.tone=7;trill.beat.addNote(neighbor);score.finish(settings);trill.dynamics=3;neighbor.dynamics=6;
  const json=model.JsonConverter.scoreToJson(score),expected=[...attacks(48,50),{tick:0,key:55,velocity:111}].sort((a,b)=>a.tick-b.tick||a.key-b.key);
  expect(decode(exportMidi(score,selection)).attacks.sort((a,b)=>a.tick-b.tick||a.key-b.key)).toEqual(expected);
  for(const plan of [buildPlaybackPlan(score,7),buildPlaybackPlanFromJson(json,['base/0'],7)]) {
    expect(plan.notes.map(n=>({tick:n.startTick,key:n.key,velocity:n.velocity})).sort((a,b)=>a.tick-b.tick||a.key-b.key)).toEqual(expected);
    expect(plan.notes.filter(n=>n.key===55)).toMatchObject([{startTick:0,endTick:3840,key:55,velocity:111,source:{target:{track:0,staff:0,bar:0,voice:0,beat:0},string:0}}]);
    expect(plan.notes.filter(n=>n.key!==55)).toHaveLength(16);
  }
  expect(model.JsonConverter.scoreToJson(score)).toBe(json);
});
