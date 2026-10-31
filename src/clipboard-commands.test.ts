import { expect,it } from 'vitest';
import { validateMusicClipEnvelope,validateParityCommand } from './parity-commands';

const clip={format:'TabPlayerClip',version:1,engineVersion:'1.8.4',mode:'singleTrack',kind:'phrase',scoreJson:'{}',links:[]};
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const filters={diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false};
const options={target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'currentBar',filters};
const command={type:'pasteMusic',clip,options};
it('accepts exact clipboard envelopes and valid link/map domains without parsing model semantics',()=>{
  expect(()=>validateParityCommand(command)).not.toThrow();
  for(const kind of ['tie','slur','hammerPull','slide'])for(const slideOutType of kind==='slide'?[1,2]:[null])expect(()=>validateMusicClipEnvelope({...clip,links:[{from:0,to:1,kind,slideOutType}]})).not.toThrow();
  expect(()=>validateParityCommand({...command,clip:{...clip,mode:'multiTrack',kind:'bars'},options:{...options,count:1000,placement:'beforeBar',destinations:[{sourceTrack:4294967295,track:1,staffMap:[0,4294967295]}]}})).not.toThrow();
});
it('rejects missing or extra outer, clip, destination, filter and target fields',()=>{
  for(const bad of [
    {...command,extra:true},{type:'pasteMusic',clip},{...command,clip:{...clip,extra:true}},
    {...command,options:{...options,extra:true}},{...command,options:{...options,target:{...target,extra:true}}},
    {...command,options:{...options,destinations:[{...options.destinations[0],extra:true}]}},
    {...command,options:{...options,filters:{...filters,extra:true}}},
  ])expect(()=>validateParityCommand(bad)).toThrow();
  for(const key of Object.keys(clip)){const missing={...clip} as Record<string,unknown>;delete missing[key];expect(()=>validateMusicClipEnvelope(missing)).toThrow();}
  for(const key of Object.keys(options)){const missing={...options} as Record<string,unknown>;delete missing[key];expect(()=>validateParityCommand({...command,options:missing})).toThrow();}
  for(const key of Object.keys(filters)){const missing={...filters} as Record<string,unknown>;delete missing[key];expect(()=>validateParityCommand({...command,options:{...options,filters:missing}})).toThrow();}
});
it('rejects invalid clip tags, JSON syntax, link modes and required nullable slide types',()=>{
  for(const patch of [{format:'Other'},{version:2},{engineVersion:'1.0'},{kind:'notes'},{mode:'all'},{scoreJson:'{'},{scoreJson:'null'},{scoreJson:'[]'},{scoreJson:0},{links:null},
    {links:[{from:0,to:1,kind:'tie'}]},{links:[{from:0,to:1,kind:'tie',slideOutType:1}]},{links:[{from:0,to:1,kind:'slide',slideOutType:null}]},
    {links:[{from:-1,to:1,kind:'slur',slideOutType:null}]},{links:[{from:0,to:1,kind:'slide',slideOutType:3}]},
    {links:[{from:0,to:1,kind:'slur',slideOutType:null},{from:0,to:1,kind:'slur',slideOutType:null}]},
  ])expect(()=>validateMusicClipEnvelope({...clip,...patch})).toThrow();
});
it('rejects nonfinite counts and malformed or ambiguous mappings before history',()=>{
  for(const count of [0,1001,-1,.5,NaN,Infinity])expect(()=>validateParityCommand({...command,options:{...options,count}})).toThrow();
  for(const destinations of [[],null,[{sourceTrack:0,track:0,staffMap:[]}],[{sourceTrack:0,track:0,staffMap:[0,0]}],
    [{sourceTrack:.5,track:0,staffMap:[0]}],[{sourceTrack:0,track:4294967296,staffMap:[0]}],
    [{sourceTrack:0,track:0,staffMap:[0]},{sourceTrack:0,track:1,staffMap:[0]}],
    [{sourceTrack:0,track:0,staffMap:[0]},{sourceTrack:1,track:0,staffMap:[0]}],
  ])expect(()=>validateParityCommand({...command,options:{...options,destinations}})).toThrow();
  expect(()=>validateParityCommand({...command,options:{...options,placement:'after'}})).toThrow();
  for(const flag of [null,'true',1])expect(()=>validateParityCommand({...command,options:{...options,filters:{...filters,texts:flag}}})).toThrow();
});
it('rejects sparse runtime arrays and overflowing JSON numbers before native serialization',()=>{
  expect(()=>validateMusicClipEnvelope({...clip,links:Array(1)})).toThrow();
  expect(()=>validateParityCommand({...command,options:{...options,destinations:Array(1)}})).toThrow();
  expect(()=>validateParityCommand({...command,options:{...options,destinations:[{sourceTrack:0,track:0,staffMap:Array(1)}]}})).toThrow();
  expect(()=>validateMusicClipEnvelope({...clip,scoreJson:'{"value":1e999}'})).toThrow();
});
