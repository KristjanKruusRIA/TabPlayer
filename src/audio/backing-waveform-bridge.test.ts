import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import protocol from '../../tests/backing-waveform-protocol.json';
import {createDocumentBackingWaveformBridge,makeEmbeddedWaveformSource,validateBackingWaveformRequest} from './backing-waveform-bridge';
import {MAX_WAVEFORM_AUDIO_BYTES,type BackingWaveform,type WaveformSourceInput} from './backing-waveform-types';
import type {DocumentRevision} from '../workspace/types';

const nativeInvoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:nativeInvoke}));

const owner={documentId:'document-waveform',activationId:'activation-waveform'};
const document={documentId:owner.documentId,revision:7};
const asset={kind:'asset' as const,assetId:'a'.repeat(64)};
const embedded={kind:'embedded' as const,sourceKey:'b'.repeat(64),sha256:'c'.repeat(64),bytesBase64:'AA=='};
function waveform(source:WaveformSourceInput=asset):BackingWaveform {
  return {owner:{...owner},document:{...document},source:source.kind==='asset'?{...source}:{kind:'embedded',sourceKey:source.sourceKey,sha256:source.sha256},
    durationMs:1000,sampleRate:4,frameCount:4,channels:2,bucketCount:2,
    peaks:[{min:[-.9,-.7],max:[.6,.8]},{min:[-.5,-.3],max:[.2,.4]}]};
}

beforeEach(()=>{nativeInvoke.mockReset();});
afterEach(()=>{vi.restoreAllMocks();});

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

describe('document-bound backing waveform bridge',()=>{
  it('copies and freezes the owner and bridge and sends only the captured query',async()=>{
    const inputOwner={...owner},bridge=createDocumentBackingWaveformBridge(inputOwner);
    inputOwner.documentId='retired-document';inputOwner.activationId='retired-activation';
    expect(Object.isFrozen(bridge)).toBe(true);expect(Object.isFrozen(bridge.owner)).toBe(true);
    expect(bridge.owner).not.toBe(inputOwner);expect(bridge.owner).toEqual(owner);
    expect(()=>Object.assign(bridge.owner,{activationId:'changed'})).toThrow();
    const response=waveform();nativeInvoke.mockResolvedValue(response);
    await expect(bridge.read(document,asset,2)).resolves.toEqual(response);
    expect(nativeInvoke.mock.calls).toEqual([['backing_waveform',{request:{owner,document,source:asset,buckets:2}}]]);
    expect(nativeInvoke.mock.calls[0][1].request.owner).toBe(bridge.owner);
  });

  for(const source of [asset,embedded])it(`captures ${source.kind} metadata before awaiting native work`,async()=>{
    const inputDocument={...document},inputSource={...source};
    let resolve!:(value:BackingWaveform)=>void;
    nativeInvoke.mockImplementation(()=>new Promise<BackingWaveform>(done=>{resolve=done;}));
    const read=createDocumentBackingWaveformBridge(owner).read(inputDocument,inputSource,2);
    const sent=nativeInvoke.mock.calls[0][1].request;
    expect(sent.document).not.toBe(inputDocument);expect(sent.source).not.toBe(inputSource);
    inputDocument.revision=9;
    if(inputSource.kind==='asset')inputSource.assetId='d'.repeat(64);
    else {inputSource.sourceKey='d'.repeat(64);inputSource.sha256='e'.repeat(64);inputSource.bytesBase64='AQ==';}
    expect(sent).toEqual({owner,document,source,buckets:2});
    const response=waveform(source);resolve(response);await expect(read).resolves.toEqual(response);
  });

  for(const source of [asset,embedded])it(`accepts a matching flat ${source.kind} receipt without changing inputs`,async()=>{
    const inputDocument={...document},inputSource={...source},before=structuredClone(inputSource),response=waveform(source);
    nativeInvoke.mockResolvedValue(response);
    await expect(createDocumentBackingWaveformBridge(owner).read(inputDocument,inputSource,2)).resolves.toEqual(response);
    expect(inputDocument).toEqual(document);expect(inputSource).toEqual(before);
    expect(response.source).not.toHaveProperty('bytesBase64');
  });

  for(const [name,inputDocument,inputSource,buckets] of [
    ['wrong document',{...document,documentId:'other'},asset,2],
    ['fractional revision',{...document,revision:.5},asset,2],
    ['unknown document field',{...document,path:'private.wav'} as DocumentRevision,asset,2],
    ['unknown source field',document,{...asset,path:'private.wav'} as WaveformSourceInput,2],
    ['uppercase wire digest',document,{...asset,assetId:'A'.repeat(64)},2],
    ['zero buckets',document,asset,0],['too many buckets',document,asset,8193],
  ] as const)it(`rejects ${name} before invoking native code`,async()=>{
    await expect(createDocumentBackingWaveformBridge(owner).read(inputDocument,inputSource,buckets)).rejects.toThrow();
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  for(const badOwner of [{...owner,documentId:''},{...owner,activationId:''}])it('rejects an empty captured owner before invoking native code',async()=>{
    await expect(createDocumentBackingWaveformBridge(badOwner).read(document,asset,2)).rejects.toThrow();
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it('preserves strict array rejection before copying request metadata',async()=>{
    nativeInvoke.mockResolvedValue(waveform());
    const bridge=createDocumentBackingWaveformBridge(owner);
    const arrayDocument=Object.assign([],{...document}) as unknown as DocumentRevision;
    const arraySource=Object.assign([],{...asset}) as unknown as WaveformSourceInput;
    await expect(bridge.read(arrayDocument,asset,2)).rejects.toThrow();
    await expect(bridge.read(document,arraySource,2)).rejects.toThrow();
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  const invalidReceipts:[string,(response:BackingWaveform)=>unknown][]=[
    ['nonobject',()=>null],['array',()=>[]],['nested result',response=>({result:response})],
    ['extra field',response=>({...response,pcm:[]})],['missing field',response=>{const {durationMs:_,...rest}=response;return rest;}],
    ['wrong owner document',response=>({...response,owner:{...owner,documentId:'other'}})],
    ['stale activation',response=>({...response,owner:{...owner,activationId:'stale'}})],
    ['unknown owner field',response=>({...response,owner:{...owner,path:'private.wav'}})],
    ['wrong document',response=>({...response,document:{...document,documentId:'other'}})],
    ['stale revision',response=>({...response,document:{...document,revision:6}})],
    ['unknown document field',response=>({...response,document:{...document,path:'private.wav'}})],
    ['wrong asset',response=>({...response,source:{...asset,assetId:'d'.repeat(64)}})],
    ['wrong source kind',response=>({...response,source:{kind:'embedded',sourceKey:'b'.repeat(64),sha256:'c'.repeat(64)}})],
    ['source bytes',response=>({...response,source:{...asset,bytesBase64:'AA=='}})],
    ['zero sample rate',response=>({...response,sampleRate:0})],['fractional sample rate',response=>({...response,sampleRate:4.5})],
    ['nonfinite sample rate',response=>({...response,sampleRate:Infinity})],
    ['sample rate outside native integer range',response=>({...response,sampleRate:4294967296})],
    ['empty frames',response=>({...response,frameCount:0})],['fractional frames',response=>({...response,frameCount:4.5})],
    ['unsafe frames',response=>({...response,frameCount:Number.MAX_SAFE_INTEGER+1})],
    ['invalid channels',response=>({...response,channels:3})],
    ['wrong bucket count',response=>({...response,bucketCount:1})],['extra peaks',response=>({...response,peaks:[...response.peaks,response.peaks[0]]})],
    ['missing peaks',response=>({...response,peaks:[]})],['unknown peak field',response=>({...response,peaks:[{...response.peaks[0],rms:0},response.peaks[1]]})],
    ['short tuple',response=>({...response,peaks:[{min:[0],max:[1,1]},response.peaks[1]]})],
    ['long tuple',response=>({...response,peaks:[{min:[0,0,0],max:[1,1]},response.peaks[1]]})],
    ['reversed extrema',response=>({...response,peaks:[{min:[.8,-.2],max:[.2,.2]},response.peaks[1]]})],
    ['nonfinite peak',response=>({...response,peaks:[{min:[NaN,0],max:[1,1]},response.peaks[1]]})],
    ['infinite peak',response=>({...response,peaks:[{min:[0,0],max:[1,Infinity]},response.peaks[1]]})],
    ['zero duration',response=>({...response,durationMs:0})],['nonfinite duration',response=>({...response,durationMs:Infinity})],
    ['inconsistent duration',response=>({...response,durationMs:999})],
  ];
  for(const [name,change] of invalidReceipts)it(`rejects ${name} in a native receipt`,async()=>{
    nativeInvoke.mockResolvedValue(change(waveform()));
    await expect(createDocumentBackingWaveformBridge(owner).read(document,asset,2)).rejects.toThrow();
  });

  for(const change of [
    {kind:'embedded',sourceKey:'d'.repeat(64),sha256:embedded.sha256},
    {kind:'embedded',sourceKey:embedded.sourceKey,sha256:'d'.repeat(64)},
    {...embedded},
  ])it('rejects mismatched embedded identity or returned embedded bytes',async()=>{
    nativeInvoke.mockResolvedValue({...waveform(embedded),source:change});
    await expect(createDocumentBackingWaveformBridge(owner).read(document,embedded,2)).rejects.toThrow();
  });

  it('requires one bucket per frame when fewer frames than requested exist',async()=>{
    const response={...waveform(),durationMs:250,frameCount:1,channels:1,bucketCount:1,peaks:[{min:[-.5,-.5],max:[.5,.5]}]};
    nativeInvoke.mockResolvedValue(response);
    await expect(createDocumentBackingWaveformBridge(owner).read(document,asset,8192)).resolves.toEqual(response);
    nativeInvoke.mockResolvedValue({...response,bucketCount:2,peaks:[...response.peaks,...response.peaks]});
    await expect(createDocumentBackingWaveformBridge(owner).read(document,asset,8192)).rejects.toThrow();
  });

  it('allows only floating-point rounding in the derived duration',async()=>{
    const response={...waveform(),durationMs:1000+Number.EPSILON*1000,sampleRate:4};
    nativeInvoke.mockResolvedValue(response);
    await expect(createDocumentBackingWaveformBridge(owner).read(document,asset,2)).resolves.toEqual(response);
    nativeInvoke.mockResolvedValue({...response,durationMs:1000.00001});
    await expect(createDocumentBackingWaveformBridge(owner).read(document,asset,2)).rejects.toThrow();
  });

  it('preserves finite peaks above unity and the native sample-rate upper bound',async()=>{
    const response={...waveform(),durationMs:4000/4294967295,sampleRate:4294967295,
      peaks:[{min:[-2,-3],max:[2,3]},{min:[-.5,-.3],max:[.2,.4]}]};
    nativeInvoke.mockResolvedValue(response);
    await expect(createDocumentBackingWaveformBridge(owner).read(document,asset,2)).resolves.toEqual(response);
  });

  it('propagates native query failures without invoking another command',async()=>{
    nativeInvoke.mockRejectedValue(new Error('Source retired.'));
    await expect(createDocumentBackingWaveformBridge(owner).read(document,asset,2)).rejects.toThrow('Source retired.');
    expect(nativeInvoke.mock.calls).toEqual([['backing_waveform',{request:{owner,document,source:asset,buckets:2}}]]);
  });
});

describe('embedded waveform source construction',()=>{
  it('normalizes a mixed-case base digest while hashing actual eight-bit audio bytes',async()=>{
    const bytes=Uint8Array.of(0,1,127,128,255),before=bytes.slice();
    const source=await makeEmbeddedWaveformSource('Ab'.repeat(32),bytes);
    expect(source).toEqual({kind:'embedded',sourceKey:'ab'.repeat(32),sha256:createHash('sha256').update(before).digest('hex'),bytesBase64:'AAF/gP8='});
    expect(bytes).toEqual(before);expect(()=>validateBackingWaveformRequest({owner,document,source,buckets:2})).not.toThrow();
  });

  it('round-trips nontrivial eight-bit input with standard padded base64',async()=>{
    const bytes=Uint8Array.from({length:131075},(_,index)=>index%256),source=await makeEmbeddedWaveformSource(asset.assetId,bytes);
    expect(Uint8Array.from(atob(source.bytesBase64),value=>value.charCodeAt(0))).toEqual(bytes);
    expect(source.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(source.bytesBase64).toMatch(/^[A-Za-z0-9+/]+=$/);
  });

  it('hashes and encodes only the supplied byte view',async()=>{
    const bytes=Uint8Array.of(55,128,255,0,66);
    await expect(makeEmbeddedWaveformSource(asset.assetId,bytes.subarray(1,4))).resolves.toEqual({
      kind:'embedded',sourceKey:asset.assetId,sha256:createHash('sha256').update(Uint8Array.of(128,255,0)).digest('hex'),bytesBase64:'gP8A'});
  });

  it('keeps the digest and encoded bytes consistent across an asynchronous digest',async()=>{
    const bytes=Uint8Array.of(128,255,0),original=bytes.slice(),digest=crypto.subtle.digest.bind(crypto.subtle);
    let release:(()=>void)|undefined;
    const hashing=vi.spyOn(crypto.subtle,'digest').mockImplementation((algorithm,data)=>new Promise<ArrayBuffer>((resolve,reject)=>{
      release=()=>{digest(algorithm,data).then(resolve,reject);};
    }));
    const pending=makeEmbeddedWaveformSource(asset.assetId,bytes);
    const result=expect(pending).resolves.toEqual({kind:'embedded',sourceKey:asset.assetId,sha256:createHash('sha256').update(original).digest('hex'),bytesBase64:'gP8A'});
    bytes.fill(17);release?.();await result;
    expect(hashing).toHaveBeenCalledOnce();
  });

  for(const sourceKey of ['', 'a'.repeat(63),'g'.repeat(64),'a'.repeat(65)])it(`rejects malformed base digest length ${sourceKey.length}`,async()=>{
    const hashing=vi.spyOn(crypto.subtle,'digest');
    await expect(makeEmbeddedWaveformSource(sourceKey,Uint8Array.of(1))).rejects.toThrow();expect(hashing).not.toHaveBeenCalled();
  });

  it('rejects audio larger than the new raw-container ceiling before hashing or copying',async()=>{
    const bytes=new Uint8Array(1),hashing=vi.spyOn(crypto.subtle,'digest');
    Object.defineProperty(bytes,'byteLength',{value:MAX_WAVEFORM_AUDIO_BYTES+1});
    await expect(makeEmbeddedWaveformSource(asset.assetId,bytes)).rejects.toThrow(/512|limit|large/i);
    expect(hashing).not.toHaveBeenCalled();
  });
});
