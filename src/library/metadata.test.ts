import { afterEach, describe, expect, it, vi } from 'vitest';
import { importer, type model } from '@coderline/alphatab';
import { zipSync } from 'fflate';
import { buildDocument, exportGp } from '../engine';
import { blankProject, type EditCommand, type ProjectInput } from '../project';
import { makeMusicClip } from '../editor/clipboard-source';
import { extractMetadata, projectMetadata } from './metadata';
import type { LibraryMetadata, MetadataEdit, MetadataInput } from './types';

const sha256='a'.repeat(64), MiB=1024*1024;
const summary=(score:model.Score):LibraryMetadata=>({title:score.title,artist:score.artist,album:score.album,trackNames:score.tracks.map(track=>track.name),metadataTruncated:false});
const source=(bytes:Uint8Array):MetadataInput=>({sha256,base:{kind:'file',bytesBase64:Buffer.from(bytes).toString('base64')},edits:[]});
const fields={subTitle:'',album:'Album',words:'',music:'',copyright:'',tab:'',notices:'',instructions:''};
const metadataEdits:MetadataEdit[]=[
  {type:'setScoreInfo',title:'',artist:'Composer'}, {type:'setScoreMetadata',album:'Album'},
  {type:'addTrack',name:''}, {type:'addPitchedTrack',name:'Keys'}, {type:'addPercussionTrack',name:'Drums'},
  {type:'setTrackInfo',track:0,name:''}, {type:'moveTrack',track:0,to:2}, {type:'removeTrack',track:1},
];
const canonicalEdits:EditCommand[]=[
  {type:'setScoreInfo',title:'',artist:'Composer',tempo:120}, {type:'setScoreMetadata',fields},
  {type:'addTrack',name:'',tuning:[64,59,55,50,45,40],program:24}, {type:'addPitchedTrack',name:'Keys',program:0},
  {type:'addPercussionTrack',name:'Drums',program:0}, {type:'setTrackInfo',track:0,name:'',shortName:'',program:24},
  {type:'moveTrack',track:0,to:2}, {type:'removeTrack',track:1},
];

afterEach(()=>vi.restoreAllMocks());

describe('metadata projection',()=>{
  it.each(['blank','file'] as const)('matches canonical applied %s score across baseline and user edits',kind=>{
    const original=blankProject();original.base={...original.base as Extract<typeof original.base,{kind:'blank'}>,title:'Original',artist:'Author'};
    if(kind==='file')original.base={kind:'file',filename:'Original.gp',bytesBase64:Buffer.from(exportGp(buildDocument(original).score)).toString('base64'),sha256};
    const project={...original,baselineEdits:canonicalEdits.slice(0,3),edits:canonicalEdits.slice(3)},before=JSON.stringify(project);
    const actual=extractMetadata({sha256,base:original.base,edits:metadataEdits});
    expect(actual).toEqual({sha256,metadata:summary(buildDocument(project).score),error:null});
    expect(JSON.stringify(project)).toBe(before);
  });

  it.each([1,2,3].flatMap(schemaVersion=>['blank','file'].map(kind=>({schemaVersion,kind}))))('matches actual schema $schemaVersion migration with unrelated advanced $kind histories',({schemaVersion,kind})=>{
    const original=blankProject(),target={track:0,staff:0,bar:0,voice:0,beat:0};
    if(kind==='file')original.base={kind:'file',filename:'History.gp',bytesBase64:Buffer.from(exportGp(buildDocument(original).score)).toString('base64'),sha256};
    const clip=makeMusicClip(buildDocument(original).score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');
    const edits:EditCommand[]=[
      {type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:'[Verse] hello world'}]},
      {type:'setBeatText',target,text:'Am'},
      {type:'setHarmonyChord',target,chord:{name:'A',nameMode:'manual',recipe:null,firstFret:0,frets:[0,0,2,2,2,0],fingers:[0,0,1,2,3,0],barreFrets:[],showName:true,showDiagram:true,showFingering:false},fillEmptyBeat:false},
      {type:'pasteMusic',clip,options:{target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}},
      {type:'appendMeasure'}, {type:'setScoreInfo',title:'After history',artist:'Artist',tempo:90},
    ];
    const current={...original,edits};let project:ProjectInput=current;
    if(schemaVersion===1){const {assets:_,baselineEdits:__,...rest}=current;project={...rest,schemaVersion:1};}
    if(schemaVersion===2){const {baselineEdits:_,...rest}=current;project={...rest,schemaVersion:2};}
    expect(extractMetadata({sha256,base:original.base,edits:[{type:'setScoreInfo',title:'After history',artist:'Artist'}]}).metadata).toEqual(summary(buildDocument(project).score));
  });

  it('preserves empty replacements and uses Instrument only for unnamed additions',()=>{
    const base={title:'Title',artist:'Artist',album:'Album',trackNames:['Guitar'],metadataTruncated:false};
    expect(projectMetadata(base,[...metadataEdits,{type:'setScoreInfo',title:'',artist:''},{type:'setScoreMetadata',album:''}])).toEqual({title:'',artist:'',album:'',trackNames:['Instrument','','Drums'],metadataTruncated:false});
    expect(base.trackNames).toEqual(['Guitar']);
    expect(projectMetadata(base,[{type:'addTrack',name:''}]).trackNames).toEqual(['Guitar','Instrument']);
    for(const move of [{track:0,to:0},{track:0,to:1},{track:1,to:0},{track:0,to:-1}])expect(()=>projectMetadata(base,[{type:'moveTrack',...move}])).toThrow(/track/i);
  });

  it.each([-1,.5,1,Number.NaN])('rejects invalid rename index %s',track=>{
    expect(()=>projectMetadata({title:'',artist:'',album:'',trackNames:['Guitar'],metadataTruncated:false},[{type:'setTrackInfo',track,name:'Bad'}])).toThrow(/track/i);
  });
  it('rejects removal of the last track and invalid field types',()=>{
    const base={title:'',artist:'',album:'',trackNames:['Guitar'],metadataTruncated:false};
    expect(()=>projectMetadata(base,[{type:'removeTrack',track:0}])).toThrow(/track/i);
    expect(()=>projectMetadata(base,[{type:'setScoreMetadata',album:null} as unknown as MetadataEdit])).toThrow();
    expect(()=>projectMetadata(base,[{type:'addTrack',name:'Second'},{type:'removeTrack',track:2}])).toThrow(/track/i);
  });

  it('bounds final UTF-8 summary without breaking surrogate pairs or shifting edit indices',()=>{
    const edits:MetadataEdit[]=Array.from({length:260},(_,index)=>({type:'addTrack',name:`Track ${index}`}));
    edits.push({type:'setTrackInfo',track:260,name:'Last valid track'});
    const result=projectMetadata({title:'🎸'.repeat(1025),artist:'é'.repeat(2050),album:'',trackNames:['Guitar'],metadataTruncated:false},edits);
    expect(Buffer.byteLength(result.title)).toBe(4096);expect(result.title).toBe('🎸'.repeat(1024));
    expect(Buffer.byteLength(result.artist)).toBe(4096);expect(result.trackNames).toHaveLength(256);expect(result.metadataTruncated).toBe(true);
  });
});

// Patch independent ZIP headers after real compression, so declarations can lie
// while the decompressor still encounters the full actual output.
function archive(sizes:number[],declared?:number):Uint8Array {
  const zip=zipSync(Object.fromEntries(sizes.map((size,index)=>[`entry-${index}`,new Uint8Array(size)])),{level:9});
  if(declared!==undefined){const view=new DataView(zip.buffer,zip.byteOffset,zip.byteLength);for(let offset=0;offset<zip.length-30;offset++){
    if(view.getUint32(offset,true)===0x04034b50)view.setUint32(offset+22,declared,true);
    if(view.getUint32(offset,true)===0x02014b50)view.setUint32(offset+24,declared,true);
  }}
  return zip;
}

describe('bounded score admission',()=>{
  it('rejects ZIP extra lengths that the importer interprets as negative offsets',()=>{
    const bytes=zipSync({entry:[new Uint8Array([1]),{extra:{1234:new Uint8Array(32764)}}]});
    const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockReturnValue(buildDocument(blankProject()).score);
    const result=extractMetadata(source(bytes));
    expect(result.metadata).toBeNull();expect(result.error).toMatch(/ZIP/);expect(load).not.toHaveBeenCalled();
  });

  it('rejects local entries concealed after the end of an admitted DEFLATE stream',()=>{
    const outer=archive([0]),hidden=archive([24*MiB,24*MiB,24*MiB]);
    const outerView=new DataView(outer.buffer,outer.byteOffset,outer.byteLength),hiddenView=new DataView(hidden.buffer,hidden.byteOffset,hidden.byteLength);
    const outerCentral=outerView.getUint32(outer.length-6,true),hiddenCentral=hiddenView.getUint32(hidden.length-6,true);
    const bytes=new Uint8Array(outer.length+hiddenCentral);
    bytes.set(outer.subarray(0,outerCentral));bytes.set(hidden.subarray(0,hiddenCentral),outerCentral);bytes.set(outer.subarray(outerCentral),outerCentral+hiddenCentral);
    const view=new DataView(bytes.buffer),central=outerCentral+hiddenCentral;
    view.setUint32(18,outerView.getUint32(18,true)+hiddenCentral,true);
    view.setUint32(central+20,outerView.getUint32(outerCentral+20,true)+hiddenCentral,true);
    view.setUint32(bytes.length-6,central,true);
    const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockReturnValue(buildDocument(blankProject()).score);
    const result=extractMetadata(source(bytes));
    expect(result.metadata).toBeNull();expect(result.error).toMatch(/ZIP/);expect(load).not.toHaveBeenCalled();
  },20000);

  it.each([
    ['three understated 24 MiB entries',()=>archive([24*MiB,24*MiB,24*MiB],1)],
    ['aggregate actual output beyond 64 MiB',()=>archive([24*MiB,24*MiB,24*MiB])],
    ['actual output beyond 32 MiB per entry',()=>archive([33*MiB],1)],
    ['declared/output mismatch',()=>archive([100],1)],
    ['oversized declaration',()=>archive([1],33*MiB)],
    ['more than 4096 entries',()=>archive(Array(4097).fill(0))],
  ] as const)('rejects %s before the importer receives bytes',(_,bytes)=>{
    const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes');
    const result=extractMetadata(source(bytes()));
    expect(result.metadata).toBeNull();expect(result.error).toBeTruthy();expect(load).not.toHaveBeenCalled();
  },20000);

  it.each(['unknown-size','zip64','local-central mismatch'] as const)('rejects unsupported %s ZIP form before importing',kind=>{
    const zip=archive([12]),view=new DataView(zip.buffer,zip.byteOffset,zip.byteLength);
    if(kind==='unknown-size')view.setUint16(6,view.getUint16(6,true)|8,true);
    if(kind==='zip64')view.setUint32(22,0xffffffff,true);
    if(kind==='local-central mismatch')view.setUint32(22,11,true);
    const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes');
    expect(extractMetadata(source(zip)).error).toBeTruthy();expect(load).not.toHaveBeenCalled();
  });

  it('accepts real authored GP metadata after the complete ZIP admission pass',()=>{
    const project={...blankProject(),edits:[{type:'setScoreInfo',title:'Élan',artist:'Artist',tempo:90},{type:'setScoreMetadata',fields},{type:'addPitchedTrack',name:'Keys',program:0}] as EditCommand[]};
    const score=buildDocument(project).score,result=extractMetadata(source(exportGp(score)));
    expect(result).toEqual({sha256,metadata:summary(score),error:null});
  });

  it('sets the importer decoding buffer bound',()=>{
    const score=buildDocument(blankProject()).score,load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockReturnValue(score);
    expect(extractMetadata(source(new Uint8Array([1]))).error).toBeNull();
    expect(load.mock.calls[0][1]?.importer.maxDecodingBufferSize).toBe(32*MiB);
  });

  it('rejects GPX declarations above 64 MiB and malformed compressed bitstreams',()=>{
    const bytes=new Uint8Array(8);bytes.set([66,67,70,90]);new DataView(bytes.buffer).setUint32(4,64*MiB+1,true);
    const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes');
    expect(extractMetadata(source(bytes)).error).toMatch(/GPX/i);
    new DataView(bytes.buffer).setUint32(4,10,true);expect(extractMetadata(source(bytes)).error).toMatch(/GPX/i);expect(load).not.toHaveBeenCalled();
  });

  it('rejects compressed score input above 64 MiB before decoding or import',()=>{
    const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes');
    const result=extractMetadata({sha256,base:{kind:'file',bytesBase64:'A'.repeat(Math.ceil((64*MiB+1)/3)*4)},edits:[]});
    expect(result.error).toMatch(/64 MiB/);expect(load).not.toHaveBeenCalled();
  });
});
