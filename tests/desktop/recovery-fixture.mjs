import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exporter,importer,model,Settings} from '@coderline/alphatab';
import {JSDOM} from 'jsdom';
import {rolldown} from 'rolldown';
import {unzipSync,zipSync} from 'fflate';
import {sha256,backingSettings} from './document-tabs-fixture.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const recoveryDirectory=resolve(root,'.analysis/desktop-smoke');
const tuning=[64,59,55,50,45,40],settings=new Settings();
const target=(bar,beat,track=0)=>({track,staff:0,bar,voice:0,beat});
const note=(bar,beat,string,fret,track=0)=>({type:'setNote',target:target(bar,beat,track),string,fret});
const event=(track,bar,beat,key)=>({track,bar,beat,key,startTick:bar*3840+beat*960,endTick:bar*3840+(beat+1)*960});
const sorted=events=>events.map(value=>JSON.stringify(value)).sort();
let apiPromise;
async function fixtureApi(){
  apiPromise??=(async()=>{
    const entry='recovery-fixture-entry',modules=[['src/engine.ts','buildScore'],['src/project.ts','blankProject']];
    const bundle=await rolldown({input:entry,external:['@coderline/alphatab','fflate'],plugins:[{name:entry,resolveId:id=>id===entry?id:null,load:id=>id===entry?modules.map(([path,names])=>`export {${names}} from ${JSON.stringify(resolve(root,path).replaceAll('\\','/'))};`).join('\n'):null}]});
    try{const {output}=await bundle.generate({format:'es',paths:Object.fromEntries(['@coderline/alphatab','fflate'].map(name=>[name,import.meta.resolve(name)]))});return await import(`data:text/javascript;base64,${Buffer.from(output.find(item=>item.type==='chunk'&&item.isEntry).code).toString('base64')}`);}
    finally{await bundle.close();}
  })();return apiPromise;
}
async function withXml(action){
  const dom=new JSDOM(''),previous=['DOMParser','XMLSerializer'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  for(const [name]of previous)Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true,writable:true});
  try{return await action();}finally{for(const [name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}dom.window.close();}
}

// Literal pitches and quarter-note clocks form the oracle before any model is built.
function authorSource(measures,tracks){
  const score=new model.Score(),literal=[];score.title='Recovery — Õhtu 同じ 🎸';score.artist='TabPlayer original recovery study';
  for(let bar=0;bar<measures;bar++){const master=new model.MasterBar();if(!bar)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.addMasterBar(master);}
  let barId=0,beatId=0,noteId=0;
  const melodies=[[60,62,64,65],[48,50,52,53],[67,69,71,72],[55,57,59,60]],strings=[5,1,6,3],open=[59,40,64,50];
  for(let index=0;index<tracks;index++){
    const track=new model.Track(),staff=new model.Staff();track.name=['Literal lead','Literal low guitar','Literal high guitar','Literal middle guitar'][index];track.shortName=`G${index+1}`;
    Object.assign(track.playbackInfo,{program:25,primaryChannel:index*2,secondaryChannel:index*2+1});staff.stringTuning.tunings=[...tuning];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
    for(let bar=0;bar<measures;bar++){
      const value=new model.Bar(),voice=new model.Voice();value.id=barId;voice.id=barId++;value.clef=model.Clef.G2;staff.addBar(value);value.addVoice(voice);
      for(let beat=0;beat<4;beat++){
        const b=new model.Beat(),n=new model.Note(),key=melodies[index][beat];b.id=beatId++;b.duration=model.Duration.Quarter;b.isEmpty=false;voice.addBeat(b);n.id=noteId++;n.string=strings[index];n.fret=key-open[index];b.addNote(n);literal.push(event(index,bar,beat,key));
      }
    }
  }
  score.rebuildRepeatGroups();score.finish(settings);
  const bytes=zipSync(unzipSync(new exporter.Gp7Exporter().export(score,settings)),{mtime:new Date(2000,0,1)});
  assertRecoveryNoteEvents(importer.ScoreLoader.loadScoreFromBytes(bytes,settings),literal);
  return {bytes,sha256:sha256(bytes),measureCount:measures,trackCount:tracks,literalEvents:literal};
}
function backingBytes(seconds,rate,hz){
  const frames=seconds*rate,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){const left=Math.round(Math.sin(2*Math.PI*hz*frame/rate)*1800),right=Math.round(Math.sin(2*Math.PI*(hz+41)*frame/rate)*1400);bytes.writeInt16LE(left,44+frame*4);bytes.writeInt16LE(right,46+frame*4);}
  return {bytes,sha256:sha256(bytes),sampleRate:rate,channels:2,durationSeconds:seconds,frequencyHz:[hz,hz+41]};
}
export function readRecoveryNoteEvents(score){
  return score.tracks.flatMap((track,index)=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(n=>({track:index,bar:bar.index,beat:beat.index,key:n.realValue,startTick:bar.masterBar.start+beat.playbackStart,endTick:bar.masterBar.start+beat.playbackStart+beat.playbackDuration})))))));
}
export function assertRecoveryNoteEvents(score,expected){assert.deepEqual(sorted(readRecoveryNoteEvents(score)),sorted(expected),'Literal complete note events, independent of recovery/history implementation');}
const replaceKey=(events,track,bar,beat,key)=>events.map(value=>value.track===track&&value.bar===bar&&value.beat===beat?{...value,key}:{...value});
const view=(bar,beat,track,zoom,kind,selectedString)=>({target:target(bar,beat,track),selectedString,selectedNoteIndex:0,zoom,trackView:{kind},instrumentVisible:true});
function expectations(history,cursor,saved,phases){
  return {history,cursor,saved,historyLength:history.length,savedLength:saved.length,appliedEdits:history.slice(0,cursor),redoEdits:history.slice(cursor),canUndo:cursor>0,canRedo:cursor<history.length,dirty:JSON.stringify(history.slice(0,cursor))!==JSON.stringify(saved),...phases};
}

export async function buildRecoveryFixtures(){
  const api=await fixtureApi();return withXml(()=>{
    const source=authorSource(8,2),savedBacking=backingBytes(2,32000,181),redoBacking=backingBytes(2,32000,307);
    const untitledBase=api.blankProject(),nativeBase=api.blankProject(),importedBase={format:'TabPlayer',schemaVersion:2,engineVersion:'1.8.4',base:{kind:'file',filename:'recovery-original.gp',bytesBase64:Buffer.from(source.bytes).toString('base64'),sha256:source.sha256},edits:[],assets:{}};
    const untitledHistory=[note(0,0,6,5),note(2,1,5,3)],nativeSaved=[note(1,2,4,2)],nativeHistory=[...nativeSaved,note(3,1,3,4)];
    const saved=[note(0,0,5,8),{type:'setBacking',backing:backingSettings(savedBacking.sha256)}],history=[note(2,1,1,15,1),note(5,2,5,10),{type:'setBacking',backing:backingSettings(redoBacking.sha256)}];
    const importedApplied=replaceKey(source.literalEvents,1,2,1,55),importedRedo=replaceKey(importedApplied,0,5,2,69);
    const documents={
      untitled:{baseProject:untitledBase,view:view(2,1,0,85,'selected',5),operations:untitledHistory.map(command=>({action:'edit',command})),expected:expectations(untitledHistory,2,[],{appliedEvents:[event(0,0,0,69),event(0,2,1,62)],trackCount:1,measureCount:4})},
      imported:{baseProject:importedBase,view:view(5,2,1,125,'all',1),operations:[{action:'edit',command:saved[0]},{action:'backing',asset:'savedBacking',command:saved[1]},{action:'save'},{action:'undo'},{action:'undo'},{action:'edit',command:history[0]},{action:'edit',command:history[1]},{action:'backing',asset:'redoBacking',command:history[2]},{action:'undo'},{action:'undo'}],expected:expectations(history,1,saved,{sourceEvents:source.literalEvents,appliedEvents:importedApplied,afterFirstRedoEvents:importedRedo,afterAllRedoEvents:importedRedo,savedEvents:replaceKey(source.literalEvents,0,0,0,67),appliedBackingHash:null,savedBackingHash:savedBacking.sha256,redoBackingHash:redoBacking.sha256,retainedAssetHashes:[savedBacking.sha256,redoBacking.sha256],ordinaryAppliedAssetHashes:[],ordinaryAllRedoAssetHashes:[redoBacking.sha256],trackCount:2,measureCount:8})},
      nativeBlank:{baseProject:{...nativeBase,edits:nativeSaved},view:view(3,1,0,110,'selected',3),operations:[{action:'edit',command:nativeHistory[1]}],expected:expectations(nativeHistory,2,nativeSaved,{appliedEvents:[event(0,1,2,57),event(0,3,1,54)],savedEvents:[event(0,1,2,57)],trackCount:1,measureCount:4})},
    };
    for(const document of Object.values(documents)){
      document.baseHash=sha256(JSON.stringify(document.baseProject.base));
      const assets=Object.fromEntries([savedBacking,redoBacking].map(backing=>[backing.sha256,{filename:'authored.wav',mediaType:'audio/wav',byteLength:backing.bytes.length}]));
      const check=(edits,events)=>assertRecoveryNoteEvents(api.buildScore({...document.baseProject,edits,assets}),events);
      check(document.expected.appliedEdits,document.expected.appliedEvents);
      if(document.expected.savedEvents)check(document.expected.saved,document.expected.savedEvents);
      if(document.expected.afterFirstRedoEvents)check(document.expected.history.slice(0,2),document.expected.afterFirstRedoEvents);
      if(document.expected.afterAllRedoEvents)check(document.expected.history,document.expected.afterAllRedoEvents);
    }
    assert.equal(authorSource(8,2).sha256,source.sha256,'Public source authoring is deterministic');
    return {authored:true,order:['untitled','imported','nativeBlank'],active:'imported',documents,source,backings:{savedBacking,redoBacking},limits:['Original authored public alphaTab 1.8.4 fixtures; original GP8 runtime parity is unverified.','Operation descriptors are harness instructions, never native IPC or recovery envelopes.','saved describes an independent branch; ordinary saves contain applied edits and referenced assets only.']};
  });
}

// Opt-in only: 100 measures, four tracks, 1600 literal notes and a 3-minute
// 48 kHz stereo 16-bit WAV (34,560,044 bytes). Import/build of small fixtures
// never allocates this backing or an encoded copy of it.
export async function buildRecoveryPerformanceFixture(){
  const api=await fixtureApi(),source=authorSource(100,4),backing=backingBytes(180,48000,229);
  await withXml(()=>assertRecoveryNoteEvents(api.buildScore({format:'TabPlayer',schemaVersion:2,engineVersion:'1.8.4',base:{kind:'file',filename:'recovery-performance.gp',bytesBase64:Buffer.from(source.bytes).toString('base64'),sha256:source.sha256},edits:[],assets:{}}),source.literalEvents));
  return {authored:true,source,backing};
}

export function writeRecoveryFixtures(fixture,prefix=`recovery-${Date.now()}-${randomUUID()}`){
  assert.match(prefix,/^recovery-[a-zA-Z0-9-]+$/);mkdirSync(recoveryDirectory,{recursive:true});const hashes={};
  const put=(name,bytes)=>{const path=resolve(recoveryDirectory,`${prefix}-${name}`);writeFileSync(path,bytes,{flag:'wx'});hashes[path]=sha256(bytes);return path;};
  const sourcePath=put('original.gp',fixture.source.bytes);
  if(fixture.backing){const backingPath=put('performance.wav',fixture.backing.bytes);return {prefix,sourcePath,backingPath,hashes,sourceHash:fixture.source.sha256,backingHash:fixture.backing.sha256};}
  const backings=Object.fromEntries(Object.entries(fixture.backings).map(([name,backing])=>[name,{path:put(`${name}.wav`,backing.bytes),sha256:backing.sha256,byteLength:backing.bytes.length}]));
  const nativeBlankPath=put('native-blank.tabplayer',Buffer.from(JSON.stringify(fixture.documents.nativeBlank.baseProject,null,2)));
  const documents=structuredClone(fixture.documents);documents.imported.baseProject.base.filename=sourcePath;documents.imported.baseHash=sha256(JSON.stringify(documents.imported.baseProject.base));
  documents.untitled.savePath=resolve(recoveryDirectory,`${prefix}-untitled-saved.tabplayer`);documents.imported.savePath=resolve(recoveryDirectory,`${prefix}-imported-saved.tabplayer`);documents.nativeBlank.path=nativeBlankPath;
  const metadata={authored:true,prefix,order:fixture.order,active:fixture.active,sourcePath,sourceHash:fixture.source.sha256,backings,nativeBlankPath,nativeBlankHash:hashes[nativeBlankPath],documents,hashes,limits:fixture.limits};
  // Source bytes already live in the original GP; metadata is an oracle, not
  // another base64 source copy. Use the in-memory build result if bytes are needed.
  const recorded=structuredClone(metadata);delete recorded.documents.imported.baseProject.base.bytesBase64;
  const metadataPath=put('fixture.json',Buffer.from(JSON.stringify(recorded,null,2)));return {...metadata,metadataPath};
}
export function assertRecoveryFixtureHashes(fixture){for(const [path,hash]of Object.entries(fixture.hashes))assert.equal(sha256(readFileSync(path)),hash,`Preserve authored input: ${path}`);}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const fixture=writeRecoveryFixtures(await buildRecoveryFixtures());assertRecoveryFixtureHashes(fixture);console.log(JSON.stringify({metadataPath:fixture.metadataPath,hashes:fixture.hashes},null,2));}
