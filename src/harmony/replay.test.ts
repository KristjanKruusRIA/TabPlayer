import {expect,it} from 'vitest';
import {model,Settings} from '@coderline/alphatab';
import {blankProject} from '../project';
import {buildDocument,previewEdit,exportGp} from '../engine';
import {getHarmonyChord} from './chord-source';
import type {HarmonyChord} from '../editor/harmony-types';
import {copyGpInterchangeSource,loadInterchangeScore} from '../interchange/gp';
import {scoreFromJson} from '../model-clone';
import {selectScore,selectStaves} from '../export/selection';

const target={track:0,staff:0,bar:0,voice:0,beat:0},chord:HarmonyChord={name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[],bass:null},firstFret:1,frets:[0,1,0,2,3,-1],fingers:[-2,1,-2,2,3,-2],barreFrets:[],showName:true,showDiagram:true,showFingering:true};
const beat=(score:model.Score)=>score.tracks[0].staves[0].bars[0].voices[0].beats[0];
const authored=()=>previewEdit(blankProject(),{type:'setHarmonyChord',target,chord,fillEmptyBeat:true});

it('keeps rich definitions through text-only edits, JSON project restart and history',()=>{
  const original=authored(),changed=previewEdit(original.project,{type:'setBeatText',target,text:'Exact\r\ntext'},original),reopened=buildDocument(JSON.parse(JSON.stringify(changed.project)));
  for(const built of [original,changed,reopened])expect(getHarmonyChord(beat(built.score).chord!)).toEqual(chord);
  expect(beat(reopened.score).text).toBe('Exact\r\ntext');expect(beat(reopened.score).notes.map(n=>n.realValue)).toEqual([64,60,55,52,48]);
  expect(buildDocument(original.project).score.tracks[0].staves[0].bars[0].voices[0].beats[0].text).toBeNull();expect(changed.project.edits).toHaveLength(2);
});
it('copies raw provenance through detached source hooks and export selections',()=>{
  const original=authored().score,copy=scoreFromJson(model.JsonConverter.scoreToJson(original),new Settings());copyGpInterchangeSource(original,copy);
  for(const score of [copy,selectScore(original,{tracks:[0],range:null}),selectStaves(original,{tracks:[0],range:null})]){
    expect(getHarmonyChord(beat(score).chord!)).toEqual(chord);expect(beat(score).chord!==beat(original).chord).toBe(true);
  }
});
it('recovers owned theory after undoing a stale staff context and keeps copyVoice source data',()=>{
  const original=authored(),settings={tuning:[64,59,55,50,45,40],capo:1,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true};
  const stale=previewEdit(original.project,{type:'setStaffSettings',track:0,staff:0,settings},original);
  expect(getHarmonyChord(beat(stale.score).chord!)).toEqual({...chord,nameMode:'manual',recipe:null});expect(getHarmonyChord(beat(buildDocument(original.project).score).chord!)).toEqual(chord);
  const voiced=previewEdit(original.project,{type:'addVoice',track:0,staff:0}),copied=previewEdit(voiced.project,{type:'copyVoice',track:0,staff:0,sourceVoice:0,destinationVoice:1,startBar:0,endBar:0});
  expect(getHarmonyChord(copied.score.tracks[0].staves[0].bars[0].voices[1].beats[0].chord!)).toEqual(chord);
});
it('commits harmony transpose as one command and restores exact music and recipe on rebuild',()=>{
  const original=authored(),before=model.JsonConverter.scoreToJson(original.score),next=previewEdit(original.project,{type:'transposeHarmony',selection:{kind:'bars',tracks:[0],firstBar:0,lastBar:0},interval:{kind:'semitones',semitones:2},includeKeySignatures:false,includeChords:true},original);
  expect(next.project.edits).toHaveLength(2);expect(beat(next.score).notes.map(n=>n.realValue)).toEqual([66,62,57,54,50]);expect(getHarmonyChord(beat(next.score).chord!).name).toBe('D');
  expect(model.JsonConverter.scoreToJson(original.score)).toBe(before);expect(getHarmonyChord(beat(buildDocument(original.project).score).chord!)).toEqual(chord);
  expect(getHarmonyChord(beat(buildDocument(next.project).score).chord!)).toEqual(getHarmonyChord(beat(next.score).chord!));
});
it('writes and reads proven GP finger/display fields without claiming recipe roundtrip',()=>{
  const original=authored().score,reopened=loadInterchangeScore(exportGp(original),new Settings()),actual=getHarmonyChord(beat(reopened).chord!);
  expect(actual).toEqual({...chord,nameMode:'manual',recipe:null});expect(getHarmonyChord(beat(original).chord!)).toEqual(chord);
});
