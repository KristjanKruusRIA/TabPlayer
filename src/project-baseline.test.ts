import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {importer,model} from '@coderline/alphatab';
import {buildDocument,buildScore,effectiveAudioSettings,exportGp,previewEdit,replayDocumentSettings,trackIdentity,validateProject} from './engine';
import {blankProject,type EditCommand} from './project';
import {defaultEffects,defaultMix} from './document-settings';
import {makeMusicClip} from './editor/clipboard-source';

const protocol=JSON.parse(readFileSync(new URL('../tests/project-baseline-protocol.json',import.meta.url),'utf8')) as {version:number;cases:{name:string;project:unknown;valid:boolean}[]};
it.each(protocol.cases)('baseline protocol $name',({project,valid})=>{
  const before=JSON.stringify(project);
  if(valid){
    const input=project as {schemaVersion:number;baselineEdits?:unknown[];edits:unknown[]},result=validateProject(project);
    expect(result.schemaVersion).toBe(3);expect(result.baselineEdits).toEqual(input.baselineEdits??[]);expect(result.edits).toEqual(input.edits);
  }else expect(()=>validateProject(project)).toThrow();
  expect(JSON.stringify(project)).toBe(before);
});

const target={track:0,staff:0,bar:0,voice:0,beat:0};
it.each(['blank','imported'] as const)('replays a %s template prefix with exact added-track identities, settings and exported music',kind=>{
  let base=blankProject().base;
  if(kind==='imported'){
    const original=buildScore({...blankProject(),edits:[{type:'addPitchedTrack',name:'Piano',program:0}]}),bytes=exportGp(original);
    base={kind:'file',filename:'Original ensemble.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  const baseCount=kind==='imported'?2:1;
  const added:EditCommand={type:'addTrack',name:'Five string bass',tuning:[43,38,33,28,23],program:33};
  const trackId=`added/1/${JSON.stringify(added)}`;
  const edits:EditCommand[]=[{type:'setNote',target,string:6,fret:3},added,{type:'setNote',target:{...target,track:baseCount},string:5,fret:2},
    {type:'setTrackSound',trackId,sound:{voiceId:null,presetId:'bass',effects:defaultEffects()}},
    {type:'setTrackMix',trackId,mix:{...defaultMix(),gain:.65,pan:-.2}},
    {type:'setScoreInfo',title:'Original ensemble',artist:'TabPlayer',tempo:105}];
  const source={...blankProject(),base,edits},before=structuredClone(source);model.Score.resetIds();const expected=buildDocument(source);
  const template={...source,baselineEdits:structuredClone(edits),edits:[]};model.Score.resetIds();const actual=buildDocument(template);
  expect(model.JsonConverter.scoreToJson(actual.score)).toBe(model.JsonConverter.scoreToJson(expected.score));
  expect(actual.score.tracks.map(trackIdentity)).toEqual([...Array.from({length:baseCount},(_,index)=>`base/${index}`),trackId]);expect(actual.settings).toEqual(expected.settings);
  expect(exportGp(actual.score)).toEqual(exportGp(expected.score));expect(source).toEqual(before);
  const next=previewEdit(template,{type:'addPitchedTrack',name:'Keys',program:0});
  expect(next.project.baselineEdits).toEqual(edits);expect(next.project.edits).toHaveLength(1);
  expect(trackIdentity(next.score.tracks[baseCount+1])).toBe(`added/${edits.length}/${JSON.stringify(next.project.edits[0])}`);
});

it('replays a baseline paste before settings-only changes with its backing measure map',()=>{
  const clip=makeMusicClip(buildScore(blankProject()),{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack'),id='a'.repeat(64);
  const project={...blankProject(),assets:{[id]:{filename:'Backing.wav',mediaType:'audio/wav',byteLength:44}},baselineEdits:[
    {type:'setBacking',backing:{assetId:id,offsetMs:0,anchors:[{bar:2,occurrence:0,ratio:0,audioMs:3000}],mix:defaultMix()}},
    {type:'pasteMusic',clip,options:{target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}},
  ] as EditCommand[]};
  const built=buildDocument(project),next={...project,edits:[{type:'setTrackMix',trackId:'base/0',mix:{...defaultMix(),gain:.6}}] as EditCommand[]};
  expect(built.score.masterBars).toHaveLength(5);expect(built.settings.backing?.anchors[0].bar).toBe(3);
  expect(replayDocumentSettings(next,built).settings).toEqual(buildDocument(next).settings);
});

it('validates complete core command envelopes in both history arrays',()=>{
  const command={type:'setNote',target,string:6,fret:5};
  for(const field of ['baselineEdits','edits']){
    expect(()=>validateProject({...blankProject(),[field]:[{...command,unexpected:true}]})).toThrow(/fields/);
    const missing:{type:string;target?:typeof target;string:number;fret:number}={...command};delete missing.target;
    expect(()=>validateProject({...blankProject(),[field]:[missing]})).toThrow(/fields/);
  }
});

it('replays baseline settings and later measure maps in the settings-only route',()=>{
  const id='a'.repeat(64),project={...blankProject(),assets:{[id]:{filename:'Original backing.wav',mediaType:'audio/wav',byteLength:44}},
    baselineEdits:[{type:'setBacking',backing:{assetId:id,offsetMs:125,anchors:[{bar:2,occurrence:0,ratio:0,audioMs:3000}],mix:defaultMix()}}] as EditCommand[],
    edits:[{type:'removeMeasure',bar:1}] as EditCommand[]};
  const built=buildDocument(project),next={...project,edits:[...project.edits,{type:'setTrackMix',trackId:'base/0',mix:{...defaultMix(),gain:.4}} as EditCommand]};
  expect(replayDocumentSettings(next,built).settings).toEqual(buildDocument(next).settings);
  expect(built.settings.backing?.anchors[0].bar).toBe(1);
});

it('keeps an explicit baseline score-only choice through imported embedded backing and settings replay',()=>{
  const source=buildScore(blankProject());source.backingTrack={rawAudioFile:new Uint8Array([82,73,70,70])};
  const load=vi.spyOn(importer.ScoreLoader,'loadScoreFromBytes').mockImplementation(()=>source);
  try{
    const project={...blankProject(),base:{kind:'file' as const,filename:'Original.gp',bytesBase64:'AA==',sha256:'a'.repeat(64)},baselineEdits:[{type:'setBacking',backing:null}] as EditCommand[]};
    const built=buildDocument(project);expect(built.embeddedBacking).not.toBeNull();expect(effectiveAudioSettings(project,built).backing).toBeNull();
    const next=previewEdit(project,{type:'setTrackMix',trackId:'base/0',mix:{...defaultMix(),gain:.7}},built);
    expect(effectiveAudioSettings(next.project,next).backing).toBeNull();expect(replayDocumentSettings(next.project,next).settings.backing).toBeNull();
  }finally{load.mockRestore();}
});
