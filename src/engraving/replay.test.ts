import {expect,it,vi} from 'vitest';
import {model,Settings} from '@coderline/alphatab';
import {buildDocument,previewEdit,replayDocumentSettings,trackIdentity,exportGp} from '../engine';
import {blankProject} from '../project';
import {defaultPrintLayout} from '../document-settings';
import {makeMusicClip} from '../editor/clipboard-source';
import {defaultEngraving} from './projection';
import type {EngravingCommand,PageLayout} from './types';
import {createHash} from 'node:crypto';
import {selectScore} from '../export/selection';
import * as gp from '../interchange/gp';
import {scoreFromJson} from '../model-clone';

const page:PageLayout={widthMm:180,heightMm:240,marginsMm:{top:10,right:12,bottom:14,left:16},scale:1,profile:'document'};
const target={track:0,staff:0,bar:0,voice:0,beat:0};
const authored=()=>previewEdit(blankProject(),{type:'setNote',target,string:6,fret:5});

it('rejects a new staff that would make the saved live profile unrenderable before publication',()=>{
  const engraving=defaultEngraving();engraving.profiles=[{trackId:'base/0',profile:'tablature'}];
  const styled=previewEdit(blankProject(),{type:'setEngraving',engraving}),before=model.JsonConverter.scoreToJson(styled.score);
  expect(()=>previewEdit(styled.project,{type:'addStaff',track:0,settings:{tuning:[],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:false,showNotation:true}},styled)).toThrow(/tablature|tuned/i);
  expect(styled.score.tracks[0].staves).toHaveLength(1);expect(model.JsonConverter.scoreToJson(styled.score)).toBe(before);expect(styled.project.edits).toHaveLength(1);
});

it('keeps source per-track style exceptions with their track after deletion or export reordering',()=>{
  const project={...blankProject(),edits:[{type:'addTrack' as const,name:'Bass',tuning:[43,38,33,28],program:33},{type:'addTrack' as const,name:'Lead',tuning:[64,59,55,50,45,40],program:29}]},score=buildDocument(project).score;
  score.stylesheet.perTrackDisplayTuning=new Map([[0,true],[1,false],[2,true]]);score.stylesheet.perTrackChordDiagramsOnTop=new Map([[1,false],[2,true]]);score.stylesheet.perTrackMultiBarRest=new Set([1]);
  const reordered=selectScore(score,{tracks:[2,1],range:null});expect(reordered.stylesheet.perTrackDisplayTuning).toEqual(new Map([[1,false],[0,true]]));expect(reordered.stylesheet.perTrackChordDiagramsOnTop).toEqual(new Map([[1,false],[0,true]]));expect([...reordered.stylesheet.perTrackMultiBarRest!]).toEqual([1]);
  const bytes=exportGp(score),imported={...blankProject(),base:{kind:'file' as const,filename:'styles.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
  // Inject a parsed source with index-keyed styles; GP style writing is a separate evidence gate.
  const load=vi.spyOn(gp,'loadInterchangeScore').mockImplementation(()=>scoreFromJson(model.JsonConverter.scoreToJson(score),new Settings()));
  try{const built=buildDocument(imported),removed=previewEdit(imported,{type:'removeTrack',track:0},built);
    expect(removed.score.stylesheet.perTrackDisplayTuning).toEqual(new Map([[0,false],[1,true]]));expect(removed.score.stylesheet.perTrackChordDiagramsOnTop).toEqual(new Map([[0,false],[1,true]]));expect([...removed.score.stylesheet.perTrackMultiBarRest!]).toEqual([0]);
  }finally{load.mockRestore();}
  expect([...score.stylesheet.perTrackDisplayTuning!]).toEqual([[0,true],[1,false],[2,true]]);
});
function style():EngravingCommand {
  const engraving=defaultEngraving();engraving.stylesheet.hideDynamics=true;engraving.profiles=[{trackId:'base/0',profile:'standard'}];
  return {type:'setEngraving',engraving};
}

it.each([1,2,3] as const)('defaults missing presentation for unchanged version %s history',schemaVersion=>{
  const input=JSON.parse(JSON.stringify(blankProject()));input.schemaVersion=schemaVersion;
  if(schemaVersion<3)delete input.baselineEdits;if(schemaVersion===1)delete input.assets;
  const built=buildDocument(input);
  expect(built.settings.engraving).toEqual(defaultEngraving());expect(built.settings.page).toBeNull();expect(built.settings.print).toEqual(defaultPrintLayout());
});

it.each<EngravingCommand>([style(),{type:'setPageLayout',layout:page}])('keeps presentation $type detached from canonical music',command=>{
  const built=authored(),before=model.JsonConverter.scoreToJson(built.score),oldSettings=structuredClone(built.settings);
  const changed=previewEdit(built.project,command,built);
  expect(changed.score===built.score).toBe(true);expect(changed.embeddedBacking===built.embeddedBacking).toBe(true);
  expect(changed.project.edits).toHaveLength(2);expect(model.JsonConverter.scoreToJson(built.score)).toBe(before);expect(built.settings).toEqual(oldSettings);
  if(command.type==='setPageLayout'){expect(changed.settings.page).toEqual(page);command.layout.marginsMm.left=20;expect(changed.settings.page?.marginsMm.left).toBe(16);command.layout.marginsMm.left=16;}
  else{expect(changed.settings.engraving).toEqual(command.engraving);expect(changed.settings.engraving!==command.engraving).toBe(true);}
});

it('uses chronological page and legacy print precedence through settings history',()=>{
  const built=authored(),custom=previewEdit(built.project,{type:'setPageLayout',layout:page},built),layout={...defaultPrintLayout(),paper:'Letter' as const};
  const legacy=previewEdit(custom.project,{type:'setPrintLayout',layout},custom);
  expect(legacy.settings.page).toBeNull();expect(legacy.settings.print).toEqual(layout);
  const undo=replayDocumentSettings(custom.project,legacy),redo=replayDocumentSettings(legacy.project,undo);
  expect(undo.settings.page).toEqual(page);expect(redo.settings.page).toBeNull();expect(undo.score===built.score&&redo.score===built.score).toBe(true);
});

it('retains post-paste score identity through presentation apply undo and redo',()=>{
  const built=authored(),clip=makeMusicClip(built.score,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'singleTrack');
  const pasted=previewEdit(built.project,{type:'pasteMusic',clip,options:{target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters:{diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:false,sections:false}}},built);
  const styled=previewEdit(pasted.project,style(),pasted),paged=previewEdit(styled.project,{type:'setPageLayout',layout:page},styled);
  const undoPage=replayDocumentSettings(styled.project,paged),undoStyle=replayDocumentSettings(pasted.project,undoPage),redo=replayDocumentSettings(paged.project,undoStyle);
  for(const state of [styled,paged,undoPage,undoStyle,redo])expect(state.score===pasted.score&&state.embeddedBacking===pasted.embeddedBacking).toBe(true);
  expect(undoStyle.settings.engraving).toEqual(defaultEngraving());expect(redo.settings).toEqual(buildDocument(paged.project).settings);
});

it('rejects a missing track or inapplicable staff profile before changing settings',()=>{
  const built=authored(),before=structuredClone(built.settings),command=style();
  if(command.type!=='setEngraving')throw new Error('Fixture must set engraving.');
  command.engraving.profiles=[{trackId:'missing',profile:'standard'}];expect(()=>previewEdit(built.project,command,built)).toThrow(/track/i);
  const piano=previewEdit(built.project,{type:'addPitchedTrack',name:'Keys',program:0}),id=trackIdentity(piano.score.tracks[1]);
  command.engraving.profiles=[{trackId:id,profile:'tablature'}];expect(()=>previewEdit(piano.project,command,piano)).toThrow(/tablature|tuning|stringed|untuned/i);
  expect(built.settings).toEqual(before);
});
