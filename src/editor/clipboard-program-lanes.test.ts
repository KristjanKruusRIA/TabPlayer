import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music } from './fixtures';
import { makeMusicClip } from './clipboard-source';
import { preparePasteMusic } from './clipboard-paste';
import { scoreFromJson } from '../model-clone';
import type { ClipboardCommand,PasteFilters } from './clipboard-types';

const filters:PasteFilters={diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false};
function twoVoices(programs:[number,number]|null) {
  const score=music(),bar=score.tracks[0].staves[0].bars[0],second=new model.Voice();
  for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=5;note.fret=1;beat.addNote(note);second.addBeat(beat);}
  bar.addVoice(second);
  for(const other of score.tracks[0].staves[0].bars.slice(1)){const voice=new model.Voice();for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;voice.addBeat(beat);}other.addVoice(voice);}
  const result=scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings());
  if(programs)result.tracks[0].staves[0].bars[0].voices.forEach((voice,index)=>voice.beats[0].automations=[Object.assign(new model.Automation(),{type:model.AutomationType.Instrument,value:programs[index],ratioPosition:0,isLinear:false})]);
  return result;
}
const command=(clip:ReturnType<typeof makeMusicClip>,trackAutomations:boolean):ClipboardCommand=>({type:'pasteMusic',clip,options:{target:{track:0,staff:0,bar:1,voice:0,beat:0},destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters:{...filters,trackAutomations}}});

it('contradictory program changes in two lanes are refused only while track automations are pasted',()=>{
  const clip=makeMusicClip(twoVoices([25,30]),{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');
  expect(()=>preparePasteMusic(twoVoices(null),command(clip,true))).toThrow(/Contradictory program/);
  const result=preparePasteMusic(twoVoices(null),command(clip,false)).score,voices=result.tracks[0].staves[0].bars[1].voices;
  expect(voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations)).filter(value=>value.type===model.AutomationType.Instrument)).toEqual([]);
  expect(voices).toHaveLength(2);expect(voices[1].beats[0].notes).toHaveLength(1);
});
it('agreeing program changes in two lanes paste with the filter on',()=>{
  const clip=makeMusicClip(twoVoices([25,25]),{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');
  expect(()=>preparePasteMusic(twoVoices(null),command(clip,true))).not.toThrow();
});
