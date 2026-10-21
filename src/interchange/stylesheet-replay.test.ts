// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook} from '@testing-library/react';
import {createHash} from 'node:crypto';
import {exporter,midi,model,Settings} from '@coderline/alphatab';
import {strToU8,unzipSync,zipSync} from 'fflate';
import {music} from '../editor/fixtures';
import {applyBarGestureEdit} from '../editor/bar-gestures';
import {applyNotationEdit} from '../editor/notation';
import {getTimeSignatureExportIntent,initializeTimeSignatureSource} from '../editor/time-signature-source';
import {captureNoteLinks,restoreNoteLinks} from '../editor/links';
import {makeMusicClip} from '../editor/clipboard-source';
import {preparePasteMusic} from '../editor/clipboard-paste';
import {buildScore,exportGp} from '../engine';
import {blankProject,type EditCommand,type Project} from '../project';
import {DocumentController} from '../controller';
import type {NativeBridge} from '../bridge';
import {defaultDocumentSettings} from '../document-settings';
import {selectScore} from '../export/selection';
import type {ExportNativeBridge} from '../export/bridge';
import {useExportCoordinator} from '../export/useExportCoordinator';
import {copyGpInterchangeSource,exportGpInterchange,loadInterchangeScore} from './gp';
import {readGpStylesheetSymbol} from './stylesheet-wire';
import {readLegacyStylesheetSymbol} from './stylesheet-legacy';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
const settings=new Settings(),current='Content/Stylesheets/score.gpss',legacy='Content/BinaryStylesheet';
const yes=Uint8Array.of(0x5a,4,0x2a,2,8,1),no=Uint8Array.of(0x5a,4,0x2a,2,8,0),absent=Uint8Array.of(8,1);
const legacyFlag=(value:boolean)=>Uint8Array.of(0,0,0,1,24,...strToU8('Staff/drawTimeSignatureC'),0,Number(value));
const mixed='GP export cannot represent mixed common/cut and numeric measure choices.';
const inherited='GP export cannot resolve inherited common/cut choices for every selected measure.';
function authored(flag:Uint8Array=yes,view?:Uint8Array):Uint8Array {
  const score=music();score.masterBars[1].timeSignatureNumerator=2;score.masterBars[1].timeSignatureDenominator=2;
  for(const index of [2,3]){score.masterBars[index].timeSignatureNumerator=3;score.tracks[0].staves[0].bars[index].voices[0].beats.pop();}
  score.finish(settings);
  const entries=unzipSync(new exporter.Gp7Exporter().export(score,settings));
  entries[current]=flag.slice();entries[legacy]=legacyFlag(flag!==yes);entries['Content/Assets/authored.bin']=Uint8Array.of(0,255,31,4);
  if(view)entries['Content/Stylesheets/scoreview1.gpss']=view.slice();return zipSync(entries);
}
function project(bytes:Uint8Array,edits:EditCommand[]=[]):Project {
  return {...blankProject(),base:{kind:'file',filename:'authored.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')},edits};
}
const gestures=(bar:number,commonTime:boolean):EditCommand=>({type:'setMasterBarGestures',bar,commonTime,doubleBar:false,tripletFeel:0,beaming:null});
const flags=(score:model.Score)=>score.masterBars.map(master=>master.timeSignatureCommon);
const bytes=(score:model.Score)=>unzipSync(exportGpInterchange(score,settings));
function standardMidi(score:model.Score){const file=new midi.MidiFile();new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file,true)).generate();return Array.from(file.toBinary());}

it.each([[yes,[true,true,false,false]],[no,[false,false,false,false]],[absent,[false,false,false,false]]] as const)('public import uses current local symbol choice %j', (flag,expected)=>{
  const input=authored(flag),before=input.slice(),score=loadInterchangeScore(input,settings);expect(flags(score)).toEqual(expected);expect(input).toEqual(before);
});
it('legacy-only imports its symbol while present current absence never falls back',()=>{
  const entries=unzipSync(authored(absent));delete entries[current];entries[legacy]=legacyFlag(true);
  expect(flags(loadInterchangeScore(zipSync(entries),settings))).toEqual([true,true,false,false]);
});
it('untouched current and conflicting opaque views survive no-XML export exactly',()=>{
  const input=authored(yes,Uint8Array.of(255)),original=unzipSync(input),score=loadInterchangeScore(input,settings),before=standardMidi(score),out=bytes(score);
  for(const [path,value]of Object.entries(original))if(path!=='Content/score.gpif')expect(out[path],path).toEqual(value);
  expect(standardMidi(score)).toEqual(before);expect(getTimeSignatureExportIntent(score)).toEqual({changed:false,value:null});
});
it('source-free uniform true writes the legacy key without inventing current GPSS',()=>{
  const score=music();for(const master of score.masterBars)master.timeSignatureCommon=true;const before=standardMidi(score),out=bytes(score);
  expect(out[current]).toBeUndefined();expect(readLegacyStylesheetSymbol(out[legacy])).toBe(true);expect(standardMidi(score)).toEqual(before);
  expect(flags(loadInterchangeScore(zipSync(out),settings))).toEqual([true,true,true,true]);
});
it('native replay reconstructs explicit equal-false intent and rejects unresolved neighbors',()=>{
  const input=authored(absent),before=input.slice(),one=project(input,[gestures(0,false)]);expect(()=>exportGp(buildScore(one))).toThrow(inherited);
  const complete={...one,edits:[...one.edits,gestures(1,false)]},reopened=buildScore(JSON.parse(JSON.stringify(complete)));
  const output=unzipSync(exportGp(reopened));expect(readGpStylesheetSymbol(output[current])).toBe(false);expect(readLegacyStylesheetSymbol(output[legacy])).toBe(false);
  expect(input).toEqual(before);expect(complete.edits).toEqual([gestures(0,false),gestures(1,false)]);
});
it('mixed authoring rejects, Undo restores exact styles and Redo rejects after native rebuild',()=>{
  const input=authored(),original=unzipSync(input),edited=project(input,[gestures(0,false)]);
  expect(()=>exportGp(buildScore(edited))).toThrow(mixed);
  const undone=bytes(buildScore({...edited,edits:[]}));expect(undone[current]).toEqual(original[current]);expect(undone[legacy]).toEqual(original[legacy]);
  expect(()=>exportGp(buildScore(JSON.parse(JSON.stringify(edited))))).toThrow(mixed);
});
it('invalid gestures and measure settings leave explicit intent untouched',()=>{
  const score=loadInterchangeScore(authored(absent),settings),before=model.JsonConverter.scoreToJson(score);
  expect(()=>applyBarGestureEdit(score,{...gestures(0,false),beaming:{unit:8,groups:[1]}} as never)).toThrow();
  expect(()=>applyNotationEdit(score,{type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section:'',tempos:[{beat:0,bpm:0,linear:false}]},0)).toThrow();
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(getTimeSignatureExportIntent(score)).toEqual({changed:false,value:null});
});
it('successful measure settings explicitly clear inherited common time',()=>{
  const input=authored(absent),edit:EditCommand={type:'setMeasureSettings',bar:0,numerator:4,denominator:4,pickup:false,freeTime:false,repeatStart:false,repeatCount:0,endings:[],section:'',tempos:[]};
  expect(()=>exportGp(buildScore(project(input,[edit])))).toThrow(inherited);
});
it('aligned clone and uniform excerpt keep intent attached before filtering masters',()=>{
  const score=buildScore(project(authored(),[gestures(0,false)])),copy=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),settings);copyGpInterchangeSource(score,copy);
  expect(()=>exportGp(copy)).toThrow(mixed);
  const numeric=bytes(selectScore(copy,{tracks:[0],range:{first:0,last:0}})),symbol=bytes(selectScore(copy,{tracks:[0],range:{first:1,last:1}}));
  expect(readGpStylesheetSymbol(numeric[current])).toBe(false);expect(readGpStylesheetSymbol(symbol[current])).toBe(true);expect(()=>exportGp(score)).toThrow(mixed);
});
it('marker-only clones retain source absence without archive provenance',()=>{
  const score=music();initializeTimeSignatureSource(score,null);
  const copy=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(score),settings);copyGpInterchangeSource(score,copy);
  expect(getTimeSignatureExportIntent(copy)).toEqual({changed:false,value:null});
  applyBarGestureEdit(copy,gestures(0,false) as never);expect(()=>exportGp(copy)).toThrow(inherited);expect(getTimeSignatureExportIntent(score)).toEqual({changed:false,value:null});
});

it('style-only projection retains tied links, chord data and detached backing bytes',()=>{
  const score=loadInterchangeScore(authored(),settings),voice=score.tracks[0].staves[0].bars[0].voices[0];voice.beats[1].notes[0].isTieDestination=true;
  const chord=Object.assign(new model.Chord(),{name:'G',firstFret:1,strings:[3,0,0,0,2,3],showName:true,showDiagram:true});score.tracks[0].staves[0].addChord('authored',chord);voice.beats[0].chordId='authored';
  score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=Uint8Array.of(82,73,70,70,1,2,3,4);score.finish(settings);
  const before=model.JsonConverter.scoreToJson(score),links=captureNoteLinks(score),audio=score.backingTrack.rawAudioFile.slice(),reference=standardMidi(score);
  const copy=model.JsonConverter.jsonToScore(before,settings);restoreNoteLinks(copy,links);copyGpInterchangeSource(score,copy);
  for(const bar of [0,1])applyBarGestureEdit(copy,gestures(bar,false) as never);
  expect(captureNoteLinks(copy)).toEqual(links);expect(copy.backingTrack?.rawAudioFile).toEqual(audio);expect(copy.backingTrack?.rawAudioFile).not.toBe(score.backingTrack.rawAudioFile);
  const round=loadInterchangeScore(exportGp(copy),settings);expect(round.backingTrack?.rawAudioFile).toEqual(audio);expect(standardMidi(round)).toEqual(reference);
  expect(round.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0].isTieDestination).toBe(true);expect(round.tracks[0].staves[0].getChord(round.tracks[0].staves[0].bars[0].voices[0].beats[0].chordId!)?.strings).toEqual(chord.strings);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(score.backingTrack.rawAudioFile).toEqual(audio);
});
it('insertion copies inherited context, deletion removes intent and legacy append stays numeric',()=>{
  const input=authored(absent),inserted=buildScore(project(input,[{type:'insertMeasures',beforeBar:1,count:1},gestures(0,false),gestures(2,false)]));
  expect(()=>exportGp(inserted)).toThrow(inherited);
  const complete=buildScore(project(input,[{type:'insertMeasures',beforeBar:1,count:1},gestures(0,false),gestures(1,false),gestures(2,false)]));expect(readGpStylesheetSymbol(bytes(complete)[current])).toBe(false);
  const removed=buildScore(project(authored(),[gestures(0,false),{type:'removeMeasures',firstBar:0,lastBar:0}]));expect(readGpStylesheetSymbol(bytes(removed)[current])).toBe(true);
  const all=music();for(const master of all.masterBars)master.timeSignatureCommon=true;const allInput=new exporter.Gp7Exporter().export(all,settings),entries=unzipSync(allInput);entries[current]=yes;entries[legacy]=legacyFlag(true);
  const appended=buildScore(project(zipSync(entries),[{type:'appendMeasure'}]));expect(flags(appended)).toEqual([true,true,true,true,false]);expect(()=>exportGp(appended)).toThrow(mixed);
});
it('changed view conflicts fail visibly while untouched and equal view bytes are preserved',()=>{
  const input=authored(yes,no),unchanged=loadInterchangeScore(input,settings);expect(bytes(unchanged)['Content/Stylesheets/scoreview1.gpss']).toEqual(no);
  const bad=buildScore(project(input,[gestures(0,false),gestures(1,false)]));expect(readGpStylesheetSymbol(bytes(bad)[current])).toBe(false);
  const conflict=buildScore(project(authored(yes,yes),[gestures(0,false),gestures(1,false)]));expect(()=>exportGp(conflict)).toThrow(/scoreview1\.gpss/);
});
it('malformed active style rejects atomically; invalid inactive legacy stays a public-loader limit',()=>{
  const input=authored(),before=input.slice(),existing=buildScore(blankProject()),snapshot=model.JsonConverter.scoreToJson(existing),entries=unzipSync(input);
  entries[current]=Uint8Array.of(0x5a,4,0x2a);expect(()=>loadInterchangeScore(zipSync(entries),settings)).toThrow(/^Unsupported GP common\/cut stylesheet:/);
  entries[current]=yes;entries[legacy]=Uint8Array.of(0,0,0,1,1,65,3,255,255);expect(()=>loadInterchangeScore(zipSync(entries),settings)).toThrow();
  expect(model.JsonConverter.scoreToJson(existing)).toBe(snapshot);expect(input).toEqual(before);
});

it('clipboard master replacement is explicit while a phrase retains destination inheritance',()=>{
  const source=loadInterchangeScore(authored(absent),settings),target={track:0,staff:0,bar:0,voice:0,beat:0},filters={diagrams:true,texts:true,timers:true,trackAutomations:true,masterAutomations:true,sections:true};
  const bars=makeMusicClip(source,{kind:'bars',tracks:[0],firstBar:0,lastBar:0},'multiTrack');
  const inserted=preparePasteMusic(source,{type:'pasteMusic',clip:bars,options:{target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'beforeBar',filters}}).score;
  expect(()=>exportGp(inserted)).toThrow(inherited);
  const clip=makeMusicClip(source,{kind:'notes',notes:[{target,noteIndex:0}]},'singleTrack');
  const destination=loadInterchangeScore(authored(absent),settings);for(const beat of destination.tracks[0].staves[0].bars[0].voices[0].beats)beat.notes=[];
  const pasted=preparePasteMusic(destination,{type:'pasteMusic',clip,options:{target,destinations:[{sourceTrack:0,track:0,staffMap:[0]}],count:1,placement:'currentBar',filters:{...filters,masterAutomations:false,sections:false}}}).score;
  expect(getTimeSignatureExportIntent(pasted)).toEqual({changed:false,value:null});expect(bytes(pasted)[current]).toEqual(absent);
  expect(getTimeSignatureExportIntent(source)).toEqual({changed:false,value:null});
});

it('XML-adapter export preserves raw lyrics, source siblings, MIDI and clocks with changed styling',()=>{
  const input=authored(),original=unzipSync(input),raw='[VERSE]\r\nHel-lo & < ]]> Ω';
  const score=buildScore(project(input,[gestures(0,false),gestures(1,false),{type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:0,text:raw}]}]));
  const before=standardMidi(score),json=model.JsonConverter.scoreToJson(score),clocks=score.masterBars.map(master=>[master.start,master.calculateDuration()]),output=exportGp(score),out=unzipSync(output),round=loadInterchangeScore(output,settings);
  expect(readGpStylesheetSymbol(out[current])).toBe(false);expect(readLegacyStylesheetSymbol(out[legacy])).toBe(false);
  for(const [path,value]of Object.entries(original))if(!['Content/score.gpif',current,legacy].includes(path))expect(out[path],path).toEqual(value);
  expect(standardMidi(round)).toEqual(before);expect(round.masterBars.map(master=>[master.start,master.calculateDuration()])).toEqual(clocks);expect(model.JsonConverter.scoreToJson(score)).toBe(json);
  const doc=new DOMParser().parseFromString(new TextDecoder().decode(out['Content/score.gpif']),'application/xml');expect(doc.querySelector('Tracks > Track > Lyrics > Line > Text')?.textContent).toBe(raw);
});

const invalidCases=[['mixed',()=>project(authored(),[gestures(0,false)]),mixed],['inherited',()=>project(authored(absent),[gestures(0,false)]),inherited],['view',()=>project(authored(yes,yes),[gestures(0,false),gestures(1,false)]),'scoreview1.gpss']] as const;
it.each(invalidCases)('direct controller %s export clears busy/error and never calls the writer on failure',async(_name,make,message)=>{
  const exportGp=vi.fn(async()=>true),bridge={documentId:'stylesheet-test',snapshot:async()=>({documentId:'stylesheet-test',revision:0,snapshot:{project:make(),path:null,dirty:false,canUndo:true,canRedo:false}}),confirmExport:async()=>true,exportGp} as unknown as NativeBridge;
  const controller=await DocumentController.create(bridge),initial=controller.getState().snapshot;
  await expect(controller.export()).rejects.toThrow(message);expect(exportGp).not.toHaveBeenCalled();expect(controller.getState()).toMatchObject({busy:false,error:expect.stringContaining(message)});expect(controller.getState().snapshot).toBe(initial);
  for(const master of controller.getState().score.masterBars)if(master.timeSignatureNumerator===4||master.timeSignatureNumerator===2)master.timeSignatureCommon=true;
  await controller.export();expect(exportGp).toHaveBeenCalledOnce();expect(controller.getState()).toMatchObject({busy:false,error:null});
});

it.each(invalidCases)('export coordinator %s error is atomic and a later uniform excerpt succeeds',async(_name,make,message)=>{
  const score=buildScore(make()),exportGp=vi.fn(async()=>true),bridge={confirmExport:async()=>true,exportGp,readBackingAsset:async()=>{throw new Error('Unexpected backing read.');}};
  const {result}=renderHook(()=>useExportCoordinator({revision:7,native:{exportPdf:async()=>null,exportMidi:async()=>true,exportMusicXml:async()=>true,exportSvg:async()=>true,exportAudio:async()=>null,status:async()=>null,cancel:async()=>{}} satisfies ExportNativeBridge,score,settings:defaultDocumentSettings(),currentSpeed:1,bridge}));
  await act(async()=>{await expect(result.current.run({format:'gp',selection:{tracks:[0],range:null}})).rejects.toThrow(message);});
  expect(exportGp).not.toHaveBeenCalled();expect(result.current.busy).toBe(false);expect(result.current.progress).toBeUndefined();
  await act(async()=>{expect(await result.current.run({format:'gp',selection:{tracks:[0],range:{first:2,last:2}}})).toBe(true);});expect(exportGp).toHaveBeenCalledOnce();expect(result.current.busy).toBe(false);
});
