import { expect, it } from 'vitest';
import protocol from '../../tests/backing-processing-protocol.json';
import { validateBackingSettings } from '../document-settings';

it.each(protocol.valid)('accepts processing protocol $id without changing settings',({backing})=>{
  const original=structuredClone(backing);
  expect(()=>validateBackingSettings(backing)).not.toThrow();
  expect(backing).toEqual(original);
});

it.each(protocol.invalid)('rejects processing protocol $id',({backing})=>{
  expect(()=>validateBackingSettings(backing)).toThrow();
});

it.each(['semitones','cents'])('rejects direct nonfinite %s',field=>{
  for(const value of [NaN,Infinity,-Infinity]) {
    const backing={...protocol.valid[0].backing,processing:{semitones:0,cents:0,filter:'none',[field]:value}};
    expect(()=>validateBackingSettings(backing)).toThrow();
  }
});

it('rejects explicitly undefined processing and required fields',()=>{
  expect(()=>validateBackingSettings({...protocol.valid[0].backing,processing:undefined})).toThrow();
  for(const field of ['semitones','cents','filter']) {
    expect(()=>validateBackingSettings({...protocol.valid[0].backing,processing:{semitones:0,cents:0,filter:'none',[field]:undefined}})).toThrow();
  }
});

it('defaults absent processing to the same neutral key',async()=>{
  const {defaultBackingProcessing,backingProcessingKey}=await import('./backing-processing');
  expect(defaultBackingProcessing()).toEqual({semitones:0,cents:0,filter:'none'});
  const first=defaultBackingProcessing();first.semitones=1;
  expect(defaultBackingProcessing()).toEqual({semitones:0,cents:0,filter:'none'});
  expect(backingProcessingKey(undefined)).toBe(backingProcessingKey(null));
  expect(backingProcessingKey(null)).toBe(backingProcessingKey({semitones:0,cents:0,filter:'none'}));
});

it('keys preserve individual pitch pairs and filter modes',async()=>{
  const {backingProcessingKey}=await import('./backing-processing');
  const pairs=[{semitones:0,cents:0},{semitones:-1,cents:100},{semitones:1,cents:-100},{semitones:1,cents:-50},{semitones:0,cents:50}];
  expect(new Set(pairs.map(pair=>backingProcessingKey({...pair,filter:'none'}))).size).toBe(5);
  const filters=['none','bassEnhance','bassAttenuation','mediumEnhance','mediumAttenuation','highEnhance','highAttenuation'] as const;
  expect(new Set(filters.map(filter=>backingProcessingKey({semitones:0,cents:0,filter}))).size).toBe(7);
  expect(backingProcessingKey({semitones:1,cents:-50,filter:'none'})).toBe(backingProcessingKey({semitones:1,cents:-50,filter:'none'}));
});
