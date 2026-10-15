import {describe,expect,it} from 'vitest';
import protocol from '../../tests/backing-waveform-protocol.json';
import {validateBackingWaveformRequest} from './backing-waveform-bridge';

describe('strict backing waveform request protocol',()=>{
  for(const item of protocol.valid)it(item.name,()=>{
    const before=structuredClone(item.request);
    expect(()=>validateBackingWaveformRequest(item.request)).not.toThrow();
    expect(item.request).toEqual(before);
  });
  for(const item of protocol.invalid)it(item.name,()=>{
    const before=structuredClone(item.request);
    expect(()=>validateBackingWaveformRequest(item.request)).toThrow();
    expect(item.request).toEqual(before);
  });
  for(const buckets of [NaN,Infinity,-Infinity])it(`rejects nonfinite bucket count ${buckets}`,()=>{
    expect(()=>validateBackingWaveformRequest({...protocol.valid[0].request,buckets})).toThrow();
  });
  for(const value of [null,[],17,'request'])it(`rejects nonobject ${JSON.stringify(value)}`,()=>{
    expect(()=>validateBackingWaveformRequest(value)).toThrow();
  });
});
