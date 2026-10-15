import { describe,expect,it } from 'vitest';
import { writeFileSync,mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'rolldown';
import { model, Settings } from '@coderline/alphatab';
import { buildScore } from '../engine';
import { blankProject } from '../project';
import { exportMidi } from './midi';
import { loadInterchangeScore } from '../interchange/gp';
import { exportGp,previewEdit } from '../engine';
// Independent Standard MIDI byte decoder; does not use alphaTab's reader or writer.
function decode(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n));
  const u32=()=>{const n=view.getUint32(p);p+=4;return n;};const u16=()=>{const n=view.getUint16(p);p+=2;return n;};
  const variable=()=>{let v=0,n=0;do{n=bytes[p++];v=(v<<7)|(n&127);}while(n&128);return v;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);const format=u16(),tracks=u16(),division=u16();
  const events:{tick:number;type:number;channel?:number;data:number[];track:number}[]=[];
  for(let track=0;track<tracks;track++) {
    expect(ascii(4)).toBe('MTrk');const end=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<end){tick+=variable();let type=bytes[p++];if(type<128){p--;type=status;}else if(type<240)status=type;
      if(type===255){const meta=bytes[p++],len=variable();events.push({tick,type:meta,data:[...bytes.slice(p,p+=len)],track});}
      else if(type===240||type===247){p+=variable();}
      else {const kind=type&240;const n=kind===192||kind===208?1:2;events.push({tick,type:kind,channel:type&15,data:[...bytes.slice(p,p+=n)],track});}
    }
  }expect(p).toBe(bytes.length);return {events,format,division};
}
function score() {
  const s=buildScore(blankProject());s.tracks[0].name='Guitar Ä';s.tracks[0].playbackInfo.program=29;
  for(let bar=0;bar<4;bar++){const beat=s.tracks[0].staves[0].bars[bar].voices[0].beats[0];beat.automations=beat.automations.filter(a=>a.type!==model.AutomationType.Instrument);const n=new model.Note();n.string=6;n.fret=bar;n.isPalmMute=bar===1;beat.addNote(n);beat.isEmpty=false;}
  s.tracks[0].staves[0].capo=2;s.masterBars[1].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,90,2)];
  s.masterBars[1].isRepeatStart=true;s.masterBars[2].repeatCount=2;return model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(s),new Settings());
}
it('writes track mix controls when only the lower staff of an imported GP is selected',()=>{
  const score=previewEdit(blankProject(),{type:'addStaff',track:0,settings:{tuning:[],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:false,showNotation:true}}).score;
  score.tracks[0].staves[0].bars[0].voices[0].beats[0].automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:4,ratioPosition:.75}));
  const imported=loadInterchangeScore(exportGp(score),new Settings());
  const parsed=decode(exportMidi(imported,{tracks:[0],staves:{0:[1]},range:null}));
  expect(parsed.events.filter(event=>event.type===176&&event.data[0]===7&&event.data[1]===32).map(event=>event.tick)).toContain(2880);
});
function manyTracks(count:number,barCount=2){
  const s=new model.Score();for(let bar=0;bar<barCount;bar++)s.addMasterBar(new model.MasterBar());s.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  s.masterBars[1].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,90,2)];
  for(let index=0;index<count;index++){
    const track=new model.Track();track.name=`Instrument ${index+1}`;track.playbackInfo.program=10+index;track.playbackInfo.primaryChannel=index*2;track.playbackInfo.secondaryChannel=index*2+1;
    const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);s.addTrack(track);
    for(let bar=0;bar<barCount;bar++){
      const measure=new model.Bar();measure.clef=model.Clef.G2;const voice=new model.Voice();measure.addVoice(voice);staff.addBar(measure);
      for(let beat=0;beat<2;beat++){const b=new model.Beat();b.duration=model.Duration.Half;b.isEmpty=false;const n=new model.Note();n.string=6;n.fret=index+3;
        if(beat===1){n.bendType=model.BendType.Bend;n.addBendPoint(new model.BendPoint(0,0));n.addBendPoint(new model.BendPoint(60,4));}b.addNote(n);voice.addBeat(b);}
    }
  }
  s.finish(new Settings());return s;
}
describe('standard MIDI export',()=>{
  it('exports long-duration tremolo in a guarded process with exact rhythmic ticks',async()=>{
    const s=score();s.masterBars[0].timeSignatureNumerator=8;const voice=s.tracks[0].staves[0].bars[0].voices[0];voice.beats.splice(1);voice.beats[0].duration=-2;voice.beats[0].tremoloPicking=new model.TremoloPickingEffect();voice.beats[0].tremoloPicking.marks=4;
    mkdirSync('.analysis/expansion',{recursive:true});
    await build({input:'src/export/midi.ts',external:['@coderline/alphatab'],output:{file:'.analysis/expansion/midi-export-worker.mjs',format:'es'}});
    const file=pathToFileURL(resolve('.analysis/expansion/midi-export-worker.mjs')).href;
    const json=JSON.stringify(model.JsonConverter.scoreToJson(s));
    const script=`import {exportMidi} from ${JSON.stringify(file)};import{model,Settings}from '@coderline/alphatab';const score=model.JsonConverter.jsonToScore(${json},new Settings());process.stdout.write(Buffer.from(exportMidi(score,{tracks:[0],range:{first:0,last:0}})).toString('base64'));`;
    writeFileSync('.analysis/expansion/long-tremolo-worker.mjs',script);
    const result=await promisify(execFile)(process.execPath,['.analysis/expansion/long-tremolo-worker.mjs'],{timeout:4000,maxBuffer:1024*1024});
    const p=decode(new Uint8Array(Buffer.from(result.stdout,'base64')));expect(p.events.filter(e=>e.type===144).map(e=>e.tick)).toEqual([0,480,960,1440,1920,2400,2880,3360,3840,4320,4800,5280,5760,6240,6720,7200]);
  },8000);
  it('writes standard notes capo programs names tempo and repeated occurrences',()=>{
    const data=exportMidi(score(),{tracks:[0],range:null});const parsed=decode(data);
    expect(parsed.format).toBe(1);expect(parsed.division).toBe(960);
    expect(parsed.events.filter(e=>e.type===144).map(e=>e.data[0])).toEqual([66,67,68,67,68,69]);
    expect(parsed.events.filter(e=>e.type===192).map(e=>e.data[0])).toEqual([29,29]);
    expect(parsed.events.some(e=>e.type===3&&new TextDecoder().decode(new Uint8Array(e.data))==='Guitar Ä')).toBe(true);
    expect(parsed.events.filter(e=>e.type===81).map(e=>e.tick)).toEqual([0,3840,11520]);
    mkdirSync('.analysis/expansion',{recursive:true});writeFileSync('.analysis/expansion/authored-export.mid',data);
  });
  it('concatenates selected played bars with state at zero and balanced note boundaries',()=>{
    const p=decode(exportMidi(score(),{tracks:[0],range:{first:2,last:2}}));
    expect(p.events.filter(e=>e.type===144).map(e=>[e.tick,e.data[0]])).toEqual([[0,68],[3840,68]]);
    expect(p.events.filter(e=>e.type===81)[0]).toMatchObject({tick:0,data:[10,44,42]});
    expect(p.events.filter(e=>e.type===192)[0].tick).toBe(0);
    expect(p.events.filter(e=>e.type===128)).toHaveLength(2);
    expect(p.events.filter(e=>e.type===47).every(e=>e.tick===7680)).toBe(true);
  });
  it('exports bends using ordinary pitch wheel events and rejects invalid selections',()=>{
    const s=score();const note=s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0];note.bendType=model.BendType.Bend;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));
    const p=decode(exportMidi(s,{tracks:[0],range:null}));expect(p.events.some(e=>e.type===224&&((e.data[1]<<7)|e.data[0])>8192)).toBe(true);
    expect(()=>exportMidi(s,{tracks:[4],range:null})).toThrow(/track/i);
    expect(()=>exportMidi(s,{tracks:[0],range:{first:2,last:1}})).toThrow(/range/i);
  });
  it('clips a sustained tie crossing the start of a range instead of losing its sound',()=>{
    const s=score();s.masterBars[1].isRepeatStart=false;s.masterBars[2].repeatCount=0;
    const v0=s.tracks[0].staves[0].bars[0].voices[0],v1=s.tracks[0].staves[0].bars[1].voices[0];
    v0.beats.splice(1);v1.beats.splice(1);v0.beats[0].duration=model.Duration.Whole;v1.beats[0].duration=model.Duration.Whole;
    const a=v0.beats[0].notes[0],b=v1.beats[0].notes[0];b.fret=a.fret;b.isPalmMute=false;b.isTieDestination=true;
    const copy=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(s),new Settings());
    const p=decode(exportMidi(copy,{tracks:[0],range:{first:1,last:1}}));
    expect(p.events.filter(e=>e.type===144).map(e=>[e.tick,e.data[0]])).toEqual([[0,66]]);
    expect(p.events.filter(e=>e.type===128).map(e=>e.tick)).toEqual([3840]);
  });
  it('retains the first before-beat grace instead of cutting it at the shifted bar start',()=>{
    const s=score();const voice=s.tracks[0].staves[0].bars[0].voices[0];const grace=new model.Beat();grace.duration=model.Duration.Eighth;grace.graceType=model.GraceType.BeforeBeat;grace.isEmpty=false;const n=new model.Note();n.string=6;n.fret=0;grace.addNote(n);voice.beats.unshift(grace);
    const copy=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(s),new Settings());
    const p=decode(exportMidi(copy,{tracks:[0],range:{first:0,last:0}}));expect(p.events.filter(e=>e.type===144).map(e=>e.data[0])).toEqual([66,66]);expect(p.events.filter(e=>e.type===144)[0].tick).toBe(0);
  });
  it('isolates programs notes and controllers for ten simultaneous tracks with logical channels above fifteen',()=>{
    const s=manyTracks(10),before=JSON.stringify(model.JsonConverter.scoreToJson(s));expect(s.tracks[8].playbackInfo.primaryChannel).toBeGreaterThan(15);
    const bytes=exportMidi(s,{tracks:s.tracks.map(t=>t.index),range:{first:0,last:0}}),p=decode(bytes);
    const programs=new Map(p.events.filter(e=>e.type===192&&e.tick===0).map(e=>[e.channel,e.data[0]]));
    for(const note of p.events.filter(e=>e.type===144))expect(programs.get(note.channel)).toBe(10+note.track-1);
    const owners=new Map<number,number>();for(const event of p.events.filter(e=>e.channel!==undefined)){
      expect(event.channel).not.toBe(9);if(owners.has(event.channel!))expect(owners.get(event.channel!)).toBe(event.track);else owners.set(event.channel!,event.track);
    }
    expect(owners.size).toBe(15);expect(p.events.filter(e=>e.type===144)).toHaveLength(20);expect(p.events.some(e=>e.type===224&&e.data[1]>64)).toBe(true);
    expect(JSON.stringify(model.JsonConverter.scoreToJson(s))).toBe(before);mkdirSync('.analysis/expansion',{recursive:true});writeFileSync('.analysis/expansion/authored-many-track-export.mid',bytes);
  });
  it('reserves channel nine for percussion and keeps melodic bend channels distinct when capacity permits',()=>{
    const s=manyTracks(4),drums=s.tracks[3];drums.staves[0].isPercussion=true;drums.staves[0].stringTuning.tunings=[];
    for(const bar of drums.staves[0].bars)for(const beat of bar.voices[0].beats){beat.notes=[];const n=new model.Note();n.percussionArticulation=beat.index?42:38;beat.addNote(n);}
    s.finish(new Settings());const p=decode(exportMidi(s,{tracks:[0,1,2,3],range:{first:0,last:0}}));
    expect(p.events.filter(e=>e.type===144&&e.track===4).map(e=>[e.channel,e.data[0]])).toEqual([[9,38],[9,42]]);
    const melodic=new Set<number>();for(let track=1;track<=3;track++){
      const channels=new Set(p.events.filter(e=>e.type===144&&e.track===track).map(e=>e.channel!));expect(channels.size).toBe(2);
      for(const channel of channels){expect(channel).not.toBe(9);expect(melodic.has(channel)).toBe(false);melodic.add(channel);}
    }
  });
  it('rejects sixteen selected melodic tracks but exports a nonzero track alone with conductor tempo intact',()=>{
    const s=manyTracks(16),before=JSON.stringify(model.JsonConverter.scoreToJson(s));
    expect(()=>exportMidi(s,{tracks:s.tracks.map(t=>t.index),range:null})).toThrow(/15.*melodic.*select|select.*fewer.*tracks/i);
    const p=decode(exportMidi(s,{tracks:[8],range:{first:1,last:1}}));expect(p.events.filter(e=>e.type===144)).toHaveLength(2);
    expect(p.events.filter(e=>e.type===192).map(e=>[e.track,e.data[0]])).toEqual([[1,18],[1,18]]);
    expect(p.events.filter(e=>e.type===81)).toContainEqual({tick:0,type:81,data:[10,44,42],track:0});
    expect(p.events.filter(e=>e.type===144).every(e=>e.track===1&&e.channel!==9)).toBe(true);expect(JSON.stringify(model.JsonConverter.scoreToJson(s))).toBe(before);
  });
  it.each([false,true])('retains the dead brushed note duration with later same-pitch notes=%s',laterNotes=>{
    const s=manyTracks(1),voice=s.tracks[0].staves[0].bars[0].voices[0];voice.beats.splice(1);const beat=voice.beats[0];beat.duration=model.Duration.Quarter;beat.brushType=model.BrushType.BrushDown;beat.brushDuration=120;beat.notes[0].isDead=true;
    const high=new model.Note();high.string=1;high.fret=3;high.isDead=true;beat.addNote(high);if(!laterNotes)for(const later of s.tracks[0].staves[0].bars[1].voices[0].beats){later.notes=[];later.isEmpty=true;}s.finish(new Settings());const before=JSON.stringify(model.JsonConverter.scoreToJson(s));
    const p=decode(exportMidi(s,{tracks:[0],range:{first:0,last:0}}));
    expect(p.events.filter(e=>e.type===144).map(e=>e.tick)).toEqual([0,120]);expect(p.events.filter(e=>e.type===144).map(e=>e.data[0]).sort((a,b)=>a-b)).toEqual([43,67]);
    expect(p.events.filter(e=>e.type===128).map(e=>e.tick)).toEqual([60,180]);expect(JSON.stringify(model.JsonConverter.scoreToJson(s))).toBe(before);
  });
  it('corrects a selected nonzero-track dead brush using tempo inherited from the preceding bar',()=>{
    const s=manyTracks(10,3),voice=s.tracks[8].staves[0].bars[2].voices[0];voice.beats.splice(1);const beat=voice.beats[0];beat.duration=model.Duration.Quarter;beat.brushType=model.BrushType.BrushDown;beat.brushDuration=120;beat.notes[0].isDead=true;
    const high=new model.Note();high.string=1;high.fret=3;high.isDead=true;beat.addNote(high);s.finish(new Settings());const before=JSON.stringify(model.JsonConverter.scoreToJson(s));
    const p=decode(exportMidi(s,{tracks:[8],range:{first:2,last:2}}));expect(p.events.filter(e=>e.type===144).map(e=>[e.track,e.tick])).toEqual([[1,0],[1,120]]);
    expect(p.events.filter(e=>e.type===128).map(e=>e.tick)).toEqual([45,165]);expect(p.events.filter(e=>e.type===81)).toContainEqual({tick:0,type:81,data:[10,44,42],track:0});
    expect(JSON.stringify(model.JsonConverter.scoreToJson(s))).toBe(before);
  });
});
