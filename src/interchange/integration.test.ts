import { createHash } from 'node:crypto';
import { expect,it } from 'vitest';
import { midi,model,Settings } from '@coderline/alphatab';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { buildDocument,buildScore,exportGp,previewEdit } from '../engine';
import { blankProject } from '../project';
import { buildPlaybackPlan,buildPlaybackPlanFromJson } from '../audio/plan';
import { exportMidi } from '../export/midi';
import { music,noteAt } from '../editor/fixtures';
import { loadInterchangeScore } from './gp';
import { selectScore } from '../export/selection';

function source() {
  const score=music();
  noteAt(score).beat.automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,ratioPosition:1/3,value:8}));
  score.masterBars[0].isRepeatStart=true;score.masterBars[0].repeatCount=2;
  const entries=unzipSync(exportGp(score));entries['Content/Assets/authored.txt']=strToU8('preserved sibling');const bytes=zipSync(entries);
  return {...blankProject(),base:{kind:'file' as const,filename:'authored.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
}
function controlTicks(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=14;const ticks:number[]=[];
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=(value<<7)|(byte&127);}while(byte&128);return value;};
  for(let track=0;track<view.getUint16(10);track++) {
    p+=4;const end=p+4+view.getUint32(p);p+=4;let status=0,tick=0;
    while(p<end) {
      tick+=variable();let byte=bytes[p++];if(byte<128){p--;byte=status;}else if(byte<240)status=byte;
      if(byte===255){p++;const length=variable();p+=length;}
      else if(byte===240||byte===247){const length=variable();p+=length;}
      else {const type=byte&240;if(type===176&&bytes[p]===7&&bytes[p+1]===64)ticks.push(tick);p+=type===192||type===208?1:2;}
    }
  }
  return [...new Set(ticks)].sort((a,b)=>a-b);
}
it('retains GP automation and archive siblings across engine history and export',()=>{
  const changed=previewEdit(source(),{type:'appendMeasure'}),bytes=exportGp(changed.score);
  expect(unzipSync(bytes)['Content/Assets/authored.txt']).toEqual(strToU8('preserved sibling'));
  const copy=loadInterchangeScore(bytes,new Settings());
  expect(noteAt(copy).beat.automations.find(a=>a.type===model.AutomationType.Volume)).toMatchObject({ratioPosition:1/3,value:8});
});
it('schedules fractional mix controls on repeated bars in native plans, worker plans and SMF',()=>{
  const score=buildScore(source()),expected=[1280,5120];
  const ticks=(plan:ReturnType<typeof buildPlaybackPlan>)=>[...new Set(plan.midi.filter(e=>e.type==='controller'&&e.controller===7&&e.value===64).map(e=>e.tick))].sort((a,b)=>a-b);
  expect(ticks(buildPlaybackPlan(score,1))).toEqual(expected);
  expect(ticks(buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(score),['base/0'],1))).toEqual(expected);
  expect(controlTicks(exportMidi(score,{tracks:[0],range:null}))).toEqual(expected);
});
it('keeps newly authored drum pitches through the actual GP export/import entry points',()=>{
  let project=previewEdit(blankProject(),{type:'addPercussionTrack',name:'Drums',program:0}).project;
  for(const articulation of [91,92,114,124])project=previewEdit(project,{type:'addPercussionNote',target:{track:1,staff:0,bar:0,voice:0,beat:0},articulation}).project;
  const score=buildScore(project),bytes=exportGp(score),copy=loadInterchangeScore(bytes,new Settings());
  const file=new midi.MidiFile();new midi.MidiFileGenerator(copy,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();
  expect(file.tracks.flatMap(t=>t.events).filter((e):e is midi.NoteOnEvent=>e instanceof midi.NoteOnEvent).map(e=>e.noteKey)).toEqual([38,46,43,62]);
});
it('applies native track display transposition to every staff on import',()=>{
  const settings={tuning:[],capo:0,transposition:0,displayTransposition:5,clef:4,showTab:false,showNotation:true};
  let project=previewEdit(blankProject(),{type:'addPitchedTrack',name:'Piano',program:0}).project;
  project=previewEdit(project,{type:'setStaffSettings',track:1,staff:0,settings}).project;
  const score=previewEdit(project,{type:'addStaff',track:1,settings}).score;
  expect(loadInterchangeScore(exportGp(score),new Settings()).tracks[1].staves.map(staff=>staff.displayTranspositionPitch)).toEqual([5,5]);
});
it('keeps embedded backing references coherent through history and detached GP selections',()=>{
  const score=music(),audio=new Uint8Array([82,73,70,70,1,2,3,4]);
  score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=audio;
  const bytes=exportGp(score),project={...blankProject(),base:{kind:'file' as const,filename:'backed.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
  const built=buildDocument(project);expect(built.embeddedBacking).toEqual(audio);
  const changed=previewEdit(project,{type:'appendMeasure'});
  for(const selected of [changed.score,selectScore(changed.score,{tracks:[0],staves:{0:[0]},range:{first:0,last:1}})]) {
    expect(loadInterchangeScore(exportGp(selected),new Settings()).backingTrack?.rawAudioFile).toEqual(audio);
  }
  expect(audio).toEqual(new Uint8Array([82,73,70,70,1,2,3,4]));
});
