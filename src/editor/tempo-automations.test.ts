import {expect,it} from 'vitest';
import {model} from '@coderline/alphatab';
import {applyTempoAutomations} from './tempo-automations';
import type {RatioTempoPoint} from './tempo-types';

function authored() {
  const score=new model.Score();score.title='Preserve this';
  for(let index=0;index<3;index++)score.addMasterBar(new model.MasterBar());
  score.masterBars[1].timeSignatureNumerator=6;score.masterBars[1].timeSignatureDenominator=8;
  score.masterBars[1].isRepeatStart=true;score.masterBars[2].repeatCount=2;
  const section=new model.Section();section.text='Chorus';section.marker='B';score.masterBars[1].section=section;
  score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=new Uint8Array([9,8,7]);
  for(const bar of score.masterBars) {
    const old=model.Automation.buildTempoAutomation(true,0,135,2);old.text='Old label';old.isVisible=false;bar.tempoAutomations=[old];
  }
  return score;
}
const points:RatioTempoPoint[]=[{bar:0,ratio:0,bpm:12.5,linear:false},{bar:0,ratio:1/3,bpm:480.25,linear:true},{bar:1,ratio:3/8,bpm:90.125,linear:false},{bar:1,ratio:1,bpm:72,linear:true}];

it('replaces every tempo array at exact arbitrary ratios and preserves unrelated score state',()=>{
  const score=authored(),before=JSON.parse(model.JsonConverter.scoreToJson(score)),input=structuredClone(points);
  const masters=[...score.masterBars],section=score.masterBars[1].section,backing=score.backingTrack;
  applyTempoAutomations(score,points);
  expect(score.tempo).toBe(12.5);
  expect(score.masterBars.map(bar=>bar.tempoAutomations.map(tempo=>[tempo.ratioPosition,tempo.value,tempo.isLinear,tempo.isVisible,tempo.text,tempo.type]))).toEqual([
    [[0,12.5,false,true,'',model.AutomationType.Tempo],[1/3,480.25,true,true,'',model.AutomationType.Tempo]],
    [[3/8,90.125,false,true,'',model.AutomationType.Tempo],[1,72,true,true,'',model.AutomationType.Tempo]],[],
  ]);
  const after=JSON.parse(model.JsonConverter.scoreToJson(score));
  delete before.tempo;delete after.tempo;
  for(const value of [before,after])for(const bar of value.masterbars)delete bar.tempoautomations;
  expect(after).toEqual(before);expect(score.masterBars).toEqual(masters);
  expect(score.masterBars[1].section).toBe(section);expect(score.backingTrack).toBe(backing);expect(points).toEqual(input);
});

it('validates every point and addressed bar before changing any authored state',()=>{
  const invalid:unknown[]=[[],[{bar:1,ratio:0,bpm:120,linear:false}],
    [...points,{bar:3,ratio:0,bpm:60,linear:false}],
    [...points,{bar:2,ratio:0,bpm:NaN,linear:false}],
    [...points,{bar:2,ratio:0,bpm:120,linear:0}],
    [...points,{bar:2,ratio:0,bpm:120,linear:false,extra:1}],
    [{bar:0,ratio:0,bpm:120,linear:false},{bar:0,ratio:0,bpm:60,linear:false}],
    [{bar:0,ratio:0,bpm:120,linear:false},{bar:0,ratio:1.01,bpm:60,linear:false}],
  ];
  for(const value of invalid) {
    const score=authored(),before=model.JsonConverter.scoreToJson(score),arrays=score.masterBars.map(bar=>bar.tempoAutomations);
    expect(()=>applyTempoAutomations(score,value as RatioTempoPoint[])).toThrow();
    expect(model.JsonConverter.scoreToJson(score)).toBe(before);
    score.masterBars.forEach((bar,index)=>expect(bar.tempoAutomations).toBe(arrays[index]));
  }
});

it('resets old label and visibility metadata even when numeric tempos match',()=>{
  const score=authored();applyTempoAutomations(score,[{bar:0,ratio:0,bpm:135,linear:true}]);
  expect(score.masterBars[0].tempoAutomations[0]).toMatchObject({text:'',isVisible:true,isLinear:true,value:135});
  expect(score.masterBars[1].tempoAutomations).toEqual([]);
  const array=score.masterBars[0].tempoAutomations,tempo=array[0];
  applyTempoAutomations(score,[{bar:0,ratio:0,bpm:135,linear:true}]);
  expect(score.masterBars[0].tempoAutomations).toBe(array);expect(array[0]).toBe(tempo);
});
