// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { exporter,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { exportGpInterchange,loadInterchangeScore } from './gp';

const settings=new Settings();
const backingPath='Content/Assets/backing-track';
const originalAudio=Uint8Array.of(1,2,3);
const replacementAudio=Uint8Array.of(9,8,7);
const siblings={
  'Content/Assets/unrelated.ogg':Uint8Array.of(0,255),
  'Content/ScoreViews/authored.gpsv':strToU8('authored view'),
  'meta.json':strToU8('{"authored":true}'),
};
function authored(needsXml:boolean){
  const score=music();score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=originalAudio.slice();
  const entries=unzipSync(new exporter.Gp7Exporter().export(score,settings));
  const input=zipSync({...entries,...siblings}),source=loadInterchangeScore(input,settings);
  if(needsXml)source.tracks[0].staves[0].bars[0].voices[0].beats[0].automations.push(Object.assign(new model.Automation(),{type:model.AutomationType.Volume,value:6,ratioPosition:.25}));
  return source;
}
const xml=(entries:Record<string,Uint8Array>)=>new DOMParser().parseFromString(strFromU8(entries['Content/score.gpif']),'application/xml');

describe.each([{name:'ordinary writer',needsXml:false},{name:'XML-needed writer',needsXml:true}])('GP backing archive: $name',({needsXml})=>{
  it('replaces a colliding source backing asset and retains unrelated archive siblings',()=>{
    const source=authored(needsXml);source.backingTrack!.rawAudioFile=replacementAudio.slice();
    const output=exportGpInterchange(source,settings),entries=unzipSync(output),doc=xml(entries);
    const assetId=doc.querySelector('GPIF > BackingTrack > AssetId')!.textContent;
    expect(doc.querySelector(`GPIF > Assets > Asset[id="${assetId}"] > EmbeddedFilePath`)!.textContent).toBe(backingPath);
    expect.soft([...entries[backingPath]]).toEqual([...replacementAudio]);
    for(const [path,data]of Object.entries(siblings))expect([...entries[path]],path).toEqual([...data]);
    expect.soft([...loadInterchangeScore(output,settings).backingTrack!.rawAudioFile!]).toEqual([...replacementAudio]);
    expect([...source.backingTrack!.rawAudioFile!]).toEqual([...replacementAudio]);
  });
  it('keeps explicitly removed backing inactive after export and reopen',()=>{
    const source=authored(needsXml);source.backingTrack=undefined;
    const output=exportGpInterchange(source,settings),entries=unzipSync(output);
    expect(xml(entries).querySelector('GPIF > BackingTrack')).toBeNull();
    expect(loadInterchangeScore(output,settings).backingTrack).toBeUndefined();
    for(const [path,data]of Object.entries(siblings))expect([...entries[path]],path).toEqual([...data]);
    expect(source.backingTrack).toBeUndefined();
  });
});
