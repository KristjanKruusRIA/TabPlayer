import {expect,it} from 'vitest';
import {validateParityCommand,validateMusicClipEnvelope} from './parity-commands';
import type {HarmonyChord,HarmonyCommand} from './editor/harmony-types';
import wireExamples from '../tests/protocol.json';

const target={track:0,staff:0,bar:0,voice:0,beat:0},selection={kind:'bars' as const,tracks:[0],firstBar:0,lastBar:0};
const chord:HarmonyChord={name:'Legacy',nameMode:'manual',recipe:null,firstFret:0,frets:[0,19,-1,2,30,0],fingers:[-2,1,-1,0,4,-2],barreFrets:[0,19,19],showName:false,showDiagram:false,showFingering:false};
const commands:HarmonyCommand[]=[{type:'setBeatText',target,text:'Exact\r\ntext'},{type:'setHarmonyChord',target,chord,fillEmptyBeat:false},{type:'setHarmonyChord',target,chord:null,fillEmptyBeat:false},
  ...[{kind:'semitones' as const,semitones:-127},{kind:'chromatic' as const,number:3,quality:'minor' as const,direction:'up' as const,octaves:1},{kind:'diatonic' as const,steps:2}].map(interval=>({type:'transposeHarmony' as const,selection,interval,includeKeySignatures:false,includeChords:false}))];
it('accepts every shared engraving, harmony and v2 wire fixture unchanged',()=>{
  expect(wireExamples).toHaveLength(76);for(const example of wireExamples.slice(59))expect(()=>validateParityCommand(example)).not.toThrow();
});
it('accepts exact v2 clipboard metadata while keeping v1 envelopes unchanged',()=>{
  const clip={format:'TabPlayerClip',version:2,engineVersion:'1.8.4',mode:'singleTrack',kind:'phrase',scoreJson:'{}',links:[],harmony:[{track:0,staff:0,chordId:' exact/id ',chord}]};
  expect(()=>validateMusicClipEnvelope(clip)).not.toThrow();expect(()=>validateMusicClipEnvelope({...clip,harmony:[]})).not.toThrow();
  for(const bad of [{...clip,version:1},{...clip,harmony:null},{...clip,harmony:Array(1)},{...clip,harmony:[clip.harmony[0],clip.harmony[0]]},
    {...clip,harmony:[{...clip.harmony[0],track:-1}]},{...clip,harmony:[{...clip.harmony[0],chordId:''}]},{...clip,harmony:[{...clip.harmony[0],extra:true}]},
  ])expect(()=>validateMusicClipEnvelope(bad)).toThrow();
});

it('accepts exact harmony commands and passive legacy chord domains',()=>{
  for(const command of commands)expect(()=>validateParityCommand(command)).not.toThrow();
  expect(()=>validateParityCommand({type:'setHarmonyChord',target,chord:{...chord,frets:[],fingers:[]},fillEmptyBeat:false})).not.toThrow();
});
it.each(commands)('rejects extra and missing required harmony fields: $type',command=>{
  expect(()=>validateParityCommand({...command,extra:true})).toThrow();
  for(const key of Object.keys(command).filter(key=>key!=='type')){const missing={...command} as Record<string,unknown>;delete missing[key];expect(()=>validateParityCommand(missing)).toThrow();}
});
it('rejects malformed nested chord definitions and sparse arrays before serialization',()=>{
  for(const patch of [{fingers:[-2]},{firstFret:-1},{frets:Array(6)},{fingers:Array(6)},{barreFrets:Array(1)},{nameMode:'theory',recipe:null},{showName:null},{extra:true},
    {name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0,extra:true},formula:'major',alterations:[],omissions:[],bass:null}},
    {name:'C',nameMode:'theory',recipe:{root:{step:0,alteration:0},formula:'major',alterations:[],omissions:[1,3,5],bass:null}},
  ])expect(()=>validateParityCommand({type:'setHarmonyChord',target,chord:{...chord,...patch},fillEmptyBeat:false})).toThrow();
});
it('rejects invalid intervals and diatonic include flags before candidate mutation',()=>{
  const base={type:'transposeHarmony',selection,includeKeySignatures:false,includeChords:false};
  for(const interval of [{kind:'semitones',semitones:0},{kind:'semitones',semitones:128},{kind:'diatonic',steps:0},{kind:'diatonic',steps:71},
    {kind:'chromatic',number:3,quality:'perfect',direction:'up',octaves:0},{kind:'chromatic',number:1,quality:'diminished',direction:'up',octaves:0},
    {kind:'chromatic',number:1,quality:'perfect',direction:'up',octaves:0},{kind:'chromatic',number:7,quality:'major',direction:'up',octaves:10},
    {kind:'chromatic',number:5,quality:'perfect',direction:'sideways',octaves:0},{kind:'semitones',semitones:2,extra:true},
  ])expect(()=>validateParityCommand({...base,interval})).toThrow();
  for(const flag of ['includeKeySignatures','includeChords'])expect(()=>validateParityCommand({...base,interval:{kind:'diatonic',steps:1},[flag]:true})).toThrow();
});
