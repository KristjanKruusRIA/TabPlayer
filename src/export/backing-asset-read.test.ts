import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createDocumentBridge} from '../bridge';
import type {BackingAssetReadResponse} from './backing-asset-types';
import {validateExportBackingByteLength} from './backing-asset-read';

const nativeInvoke=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:nativeInvoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({message:vi.fn(),confirm:vi.fn()}));

const document={documentId:'backing-document',revision:7};
const assetId='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
function receipt():BackingAssetReadResponse {
  return {document:{...document},assetId,sha256:assetId,bytesBase64:'YWJj'};
}
const read=()=>createDocumentBridge(document.documentId).readBackingAsset(assetId,document.revision);

beforeEach(()=>{nativeInvoke.mockReset();});
afterEach(()=>{vi.restoreAllMocks();});

describe('current-document backing asset read',()=>{
  it.each([536870911,536870912])('permits a raw container of %s bytes at the export-only limit',byteLength=>{
    expect(()=>validateExportBackingByteLength(byteLength)).not.toThrow();
  });

  it('rejects a raw container of 512 MiB plus one byte without allocating the container',()=>{
    expect(()=>validateExportBackingByteLength(536870913)).toThrow('Backing asset exceeds the 512 MiB export read limit.');
  });

  it('sends only the captured document, revision and asset, verifies SHA256 and returns owned bytes',async()=>{
    const response=receipt(),before=structuredClone(response);
    nativeInvoke.mockResolvedValue(response);
    const bytes=await read();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([97,98,99]);
    expect(nativeInvoke.mock.calls).toEqual([['read_export_backing',{request:{document,assetId}}]]);
    expect(response).toEqual(before);
    bytes[0]=0;
    expect(Array.from(await read())).toEqual([97,98,99]);
  });

  it('keeps each concurrent request bound to its captured revision',async()=>{
    const bridge=createDocumentBridge(document.documentId);
    let resolve!:(value:unknown)=>void;
    nativeInvoke.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const first=bridge.readBackingAsset(assetId,7).catch(error=>error);
    nativeInvoke.mockResolvedValueOnce({...receipt(),document:{...document,revision:8}});
    await expect(bridge.readBackingAsset(assetId,8)).resolves.toEqual(new Uint8Array([97,98,99]));
    resolve({...receipt(),document:{...document,revision:8}});
    expect(await first).toEqual(new Error('Backing asset response belongs to another document or source.'));
  });

  for(const [name,documentId,inputAssetId,revision] of [
    ['empty document','',assetId,7],
    ['path source',document.documentId,'C:/private/audio.wav',7],
    ['uppercase digest',document.documentId,assetId.toUpperCase(),7],
    ['short digest',document.documentId,'a'.repeat(63),7],
    ['negative revision',document.documentId,assetId,-1],
    ['fractional revision',document.documentId,assetId,.5],
    ['unsafe revision',document.documentId,assetId,Number.MAX_SAFE_INTEGER+1],
    ['NaN revision',document.documentId,assetId,NaN],
    ['infinite revision',document.documentId,assetId,Infinity],
  ] as const)it(`rejects ${name} before invoking native code`,async()=>{
    await expect(createDocumentBridge(documentId).readBackingAsset(inputAssetId,revision)).rejects.toThrow('Invalid backing asset read request.');
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  for(const [name,response] of [
    ['null',null],['array',[]],['string','receipt'],
    ['missing field',{document,assetId,sha256:assetId}],
    ['extra field',{...receipt(),path:'audio.wav'}],
    ['extra document field',{...receipt(),document:{...document,path:'score.tabplayer'}}],
    ['missing document field',{...receipt(),document:{documentId:document.documentId}}],
    ['array document',{...receipt(),document:[]}],
    ['nonstring bytes',{...receipt(),bytesBase64:[97,98,99]}],
    ['null document',{...receipt(),document:null}],
  ] as const)it(`rejects malformed response: ${name}`,async()=>{
    nativeInvoke.mockResolvedValue(response);
    await expect(read()).rejects.toThrow('Invalid backing asset read response.');
  });

  for(const [name,response] of [
    ['document',{...receipt(),document:{...document,documentId:'another-document'}}],
    ['revision',{...receipt(),document:{...document,revision:8}}],
    ['revision type',{...receipt(),document:{...document,revision:'7'}}],
    ['asset',{...receipt(),assetId:'f'.repeat(64)}],
    ['digest',{...receipt(),sha256:'f'.repeat(64)}],
    ['uppercase digest',{...receipt(),sha256:assetId.toUpperCase()}],
    ['nonstring digest',{...receipt(),sha256:null}],
  ] as const)it(`rejects response ${name} that differs from the captured request`,async()=>{
    nativeInvoke.mockResolvedValue(response);
    await expect(read()).rejects.toThrow('Backing asset response belongs to another document or source.');
  });

  for(const bytesBase64 of ['YWJj\n','YWI\n','YWI\r','YW Jj','YWJ','YWJj=','Y===','====','YW-j','YW_j','@@==','AB==','AAB='])it(`rejects noncanonical base64 ${JSON.stringify(bytesBase64)}`,async()=>{
    nativeInvoke.mockResolvedValue({...receipt(),bytesBase64});
    await expect(read()).rejects.toThrow('Invalid backing asset base64.');
  });

  it.each([
    ['empty','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855','',[]],
    ['one byte','ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb','YQ==',[97]],
    ['two bytes','fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603','YWI=',[97,98]],
    ['binary bytes','6509423fd9da5c225d2f8619ffae394b40f9f7686fee55a38c54b1424ac65f46','AP+AAQ==',[0,255,128,1]],
  ] as const)('verifies real SHA256 for %s with valid padding',async(_name,digest,bytesBase64,bytes)=>{
    nativeInvoke.mockResolvedValue({...receipt(),assetId:digest,sha256:digest,bytesBase64});
    await expect(createDocumentBridge(document.documentId).readBackingAsset(digest,7)).resolves.toEqual(new Uint8Array(bytes));
  });

  it('rejects altered bytes even when both claimed digests match the requested asset',async()=>{
    nativeInvoke.mockResolvedValue({...receipt(),bytesBase64:'YWJk'});
    await expect(read()).rejects.toThrow('Backing asset bytes do not match the requested digest.');
  });

  it('propagates native stale-state or read failures without returning bytes',async()=>{
    const failure=new Error('Backing asset changed during export.');
    nativeInvoke.mockRejectedValue(failure);
    await expect(read()).rejects.toBe(failure);
  });

  it('propagates a WebCrypto digest failure without returning unverified bytes',async()=>{
    const failure=new Error('Digest unavailable.');
    nativeInvoke.mockResolvedValue(receipt());
    vi.spyOn(crypto.subtle,'digest').mockRejectedValueOnce(failure);
    await expect(read()).rejects.toBe(failure);
  });
});
