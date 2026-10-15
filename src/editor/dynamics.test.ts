import { expect, it } from 'vitest';
import { midi, model, Settings } from '@coderline/alphatab';
import { blankProject } from '../project';
import { buildScore, previewEdit } from '../engine';
import { buildPlaybackPlan, buildPlaybackPlanFromJson } from '../audio/plan';
import { exportMidi } from '../export/midi';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const notes=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes;
function edited() {
  let project=previewEdit(blankProject(),{type:'setNote',target,string:6,fret:3}).project;
  project=previewEdit(project,{type:'setNote',target,string:1,fret:3}).project;
  return previewEdit(project,{type:'setNoteTechniques',target,string:6,patch:{dynamics:3}});
}

function smfVelocities(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=14;
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=(value<<7)|(byte&127);}while(byte&128);return value;};
  const values:number[]=[];
  for(let track=0;track<view.getUint16(10);track++) {
    p+=4;const end=p+4+view.getUint32(p);p+=4;let status=0;
    while(p<end) {
      variable();let byte=bytes[p++];if(byte<128){p--;byte=status;}else if(byte<240)status=byte;
      if(byte===255){p++;const length=variable();p+=length;}
      else if(byte===240||byte===247){const length=variable();p+=length;}
      else {const type=byte&240;if(type===144&&bytes[p+1]>0)values.push(bytes[p+1]);p+=type===192||type===208?1:2;}
    }
  }
  return values;
}

it('keeps the requested per-note dynamics through replay and later structural edits',()=>{
  const changed=edited();
  expect(notes(changed.score).map(n=>n.dynamics)).toEqual([3,5]);
  const saved=JSON.parse(JSON.stringify(changed.project));
  expect(notes(buildScore(saved)).map(n=>n.dynamics)).toEqual([3,5]);
  const added=previewEdit(saved,{type:'appendMeasure'});
  expect(notes(added.score).map(n=>n.dynamics)).toEqual([3,5]);
  expect(notes(buildScore({...saved,edits:saved.edits.slice(0,-1)})).map(n=>n.dynamics)).toEqual([5,5]);
});

it('keeps independent chord velocities in native worker plans and SMF export',()=>{
  const {score}=edited();
  // Check the clone boundaries independently of the replay assertion above.
  notes(score)[0].dynamics=3;
  const reference=new midi.MidiFile();
  new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(reference)).generate();
  const expected=reference.tracks.flatMap(t=>t.events).filter((e):e is midi.NoteOnEvent=>e instanceof midi.NoteOnEvent).map(e=>e.noteVelocity);
  expect(expected[0]).toBeLessThan(expected[1]);
  expect(buildPlaybackPlan(score,1).notes.map(n=>n.velocity)).toEqual(expected);
  expect(buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(score),['base/0'],1).notes.map(n=>n.velocity)).toEqual(expected);
  expect(smfVelocities(exportMidi(score,{tracks:[0],range:null}))).toEqual(expected);
});
