import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exporter,importer,midi,model,Settings} from '@coderline/alphatab';
import {unzipSync,zipSync} from 'fflate';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const waveformDirectory=resolve(root,'.analysis/desktop-smoke');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const sourcePaths=['tests/desktop/backing-waveform-fixture.mjs','tests/desktop/parity-backing-waveform.mjs'];
const encode=value=>Buffer.from(JSON.stringify(value,null,2));
export const backingOf=project=>[...project.baselineEdits,...project.edits].filter(edit=>edit.type==='setBacking').at(-1)?.backing;
export const projectView=project=>({...structuredClone(project),assets:Object.fromEntries(Object.entries(project.assets).map(([id,asset])=>[id,{filename:asset.filename,mediaType:asset.mediaType,byteLength:Buffer.from(asset.bytesBase64,'base64').length}]))});
const settings=()=>({offsetMs:0,anchors:[],mix:{gain:.73,pan:-.2,mute:false,solo:false}});

// Literal PCM16 impulses, including opposite stereo polarity and the final frame.
// Everything else is silence; no song, bank, recording or device is involved.
function authoredWave(channels){
  const sampleRate=8000,frameCount=128000,durationMs=16000;
  const impulses=[[0,24576,-24576],[1,-8192,8192],[7999,16384,-16384],[8000,-16384,16384],[20000,32767,-32768],[44000,-24576,24576],[52000,12288,-12288],[64000,28672,-28672],[88000,-20480,20480],[127999,8192,-8192]];
  const bytes=Buffer.alloc(44+frameCount*channels*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*channels*2,28);bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frameCount*channels*2,40);
  for(const [frame,left,right]of impulses)for(let channel=0;channel<channels;channel++)bytes.writeInt16LE(channel?right:left,44+(frame*channels+channel)*2);
  return {bytes,oracle:{sampleRate,frameCount,durationMs,channels,bucketCount:8192,impulses}};
}

function authoredScore(audio){
  const score=new model.Score(),config=new Settings();score.title='Glass tide — original waveform study';score.artist='TabPlayer authored verification';score.defaultSystemsLayout=3;
  for(let index=0;index<3;index++){const master=new model.MasterBar();master.timeSignatureNumerator=6;master.timeSignatureDenominator=8;if(index===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2),model.Automation.buildTempoAutomation(false,1/3,60,2)];if(index===2)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.addMasterBar(master);}
  score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;
  const track=new model.Track(),staff=new model.Staff();track.name='Waveform guitar';track.shortName='Wave';Object.assign(track.playbackInfo,{program:25,primaryChannel:0,secondaryChannel:1});staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showStandardNotation=true;staff.showTablature=true;track.addStaff(staff);score.addTrack(track);
  let serial=0;for(let index=0;index<3;index++){const bar=new model.Bar(),voice=new model.Voice();bar.id=index;voice.id=index;bar.clef=model.Clef.G2;staff.addBar(bar);bar.addVoice(voice);for(let pulse=0;pulse<6;pulse++){const beat=new model.Beat(),note=new model.Note();beat.id=serial;note.id=serial++;beat.duration=model.Duration.Eighth;beat.isEmpty=false;note.string=6;note.fret=index===0?[5,7,9,11,13,15][pulse]:index===1?2:3;beat.addNote(note);voice.addBeat(beat);}}
  if(audio){score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=audio;}
  score.rebuildRepeatGroups();score.finish(config);
  const bytes=Buffer.from(zipSync(unzipSync(new exporter.Gp7Exporter().export(score,config)),{mtime:new Date(2000,0,1)})),copy=importer.ScoreLoader.loadScoreFromBytes(bytes,config);
  assert.deepEqual(copy.masterBars.map(bar=>[bar.timeSignatureNumerator,bar.timeSignatureDenominator]),[[6,8],[6,8],[6,8]]);assert.equal(copy.masterBars[0].isRepeatStart,true);assert.equal(copy.masterBars[1].repeatCount,2);assert.deepEqual(copy.masterBars[0].tempoAutomations.map(tempo=>tempo.value),[120,60]);assert.ok(Math.abs(copy.masterBars[0].tempoAutomations[1].ratioPosition-1/3)<1e-8);
  const generator=new midi.MidiFileGenerator(copy,config,new midi.AlphaSynthMidiFileHandler(new midi.MidiFile(),true));generator.generate();assert.deepEqual(generator.tickLookup.masterBars.map(bar=>[bar.masterBar.index,bar.start,bar.end]),[[0,0,2880],[1,2880,5760],[0,5760,8640],[1,8640,11520],[2,11520,14400]]);
  assert.deepEqual(copy.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0].fret),[5,7,9,11,13,15]);if(audio)assert.deepEqual(Buffer.from(copy.backingTrack.rawAudioFile),audio);else assert.equal(copy.backingTrack,undefined);
  return bytes;
}

// Pure authoring/roundtrip checks. Calling this function creates no files.
export function buildBackingWaveformFixture(){
  const stereo=authoredWave(2),mono=authoredWave(1),score=authoredScore(),embedded=authoredScore(mono.bytes);
  const grid=[{bar:0,occurrence:0,times:[0,250,500,1000,1500,2000]},{bar:1,occurrence:0,times:[2500,3000,3500,4000,4500,5000]},{bar:0,occurrence:1,times:[5500,5750,6000,6500,7000,7500]},{bar:1,occurrence:1,times:[8000,8500,9000,9500,10000,10500]},{bar:2,occurrence:0,times:[11000,11250,11500,11750,12000,12250]}];
  return {score,embedded,stereo,mono,grid,invalidAudio:Buffer.from('Original deliberately malformed WAV container for the waveform decoder error/Retry view.')};
}

export function prepareBackingWaveformFixture(){
  const fixture=buildBackingWaveformFixture();mkdirSync(waveformDirectory,{recursive:true});const workDirectory=mkdtempSync(resolve(waveformDirectory,'backing-waveform-')),inputs=resolve(workDirectory,'inputs'),outputs=resolve(workDirectory,'outputs');mkdirSync(inputs);mkdirSync(outputs);const hashes={};
  const put=(name,bytes)=>{const path=resolve(inputs,name);writeFileSync(path,bytes,{flag:'wx'});hashes[path]=sha256(bytes);return path;};
  const scorePath=put('authored-repeat-6-8.gp',fixture.score),embeddedPath=put('authored-original-embedded.gp',fixture.embedded),stereoPath=put('authored-opposite-stereo.wav',fixture.stereo.bytes),monoPath=put('authored-mono.wav',fixture.mono.bytes),invalidPath=put('authored-malformed.wav',fixture.invalidAudio);
  const base={kind:'file',filename:scorePath,bytesBase64:fixture.score.toString('base64'),sha256:sha256(fixture.score)},project={format:'TabPlayer',schemaVersion:3,engineVersion:'1.8.4',base,baselineEdits:[],edits:[],assets:{}};
  const withAsset=(bytes,filename)=>{const value=structuredClone(project),assetId=sha256(bytes);value.assets[assetId]={filename,mediaType:'audio/wav',bytesBase64:bytes.toString('base64')};value.baselineEdits=[{type:'setBacking',backing:{...settings(),assetId}}];return value;};
  const sourcePath=put('score-only.tabplayer',encode(project)),monoProject=withAsset(fixture.mono.bytes,monoPath),monoProjectPath=put('mono-asset.tabplayer',encode(monoProject)),errorProject=withAsset(fixture.invalidAudio,invalidPath),errorProjectPath=put('malformed-asset.tabplayer',encode(errorProject));
  const state={format:'TabPlayerBackingWaveformAcceptance',version:1,authored:true,ownershipId:randomUUID(),workDirectory,inputs,outputs,sourcePath,scorePath,embeddedPath,stereoPath,monoPath,monoProjectPath,errorProjectPath,project,monoProject,errorProject,grid:fixture.grid,oracles:{stereo:fixture.stereo.oracle,mono:fixture.mono.oracle},hashes,sourceHashes:Object.fromEntries(sourcePaths.map(path=>[path,sha256(readFileSync(resolve(root,path)))])),limits:['Original authored GP/WAV fixtures only; no original GP8 runtime or physical audio fidelity claim.','Only root launches the diagnostic application; all processes, profiles, sessions, saves and captures belong to this fixture.','Screenshots require actual root and independent visual review. Pointercancel/lostcapture and all-OS shipping require separate evidence.']};
  const statePath=resolve(workDirectory,'fixture-state.json');writeFileSync(statePath,encode(state),{flag:'wx'});return {...state,statePath,stateSha256:sha256(readFileSync(statePath))};
}

function contained(parent,child){const value=relative(realpathSync(parent),realpathSync(child));assert.ok(value&&!value.startsWith('..')&&!isAbsolute(value),`Path must stay inside its owned directory: ${child}`);}
export function assertBackingWaveformFixture(state,statePath){
  assert.equal(state.format,'TabPlayerBackingWaveformAcceptance');assert.equal(state.version,1);assert.equal(state.authored,true);assert.match(state.ownershipId,/^[a-f0-9-]{36}$/);assert.ok(isAbsolute(statePath));assert.equal(basename(statePath),'fixture-state.json');assert.equal(resolve(statePath),resolve(state.workDirectory,'fixture-state.json'));contained(waveformDirectory,state.workDirectory);assert.match(basename(state.workDirectory),/^backing-waveform-[a-zA-Z0-9]+$/);assert.equal(resolve(state.inputs),resolve(state.workDirectory,'inputs'));assert.equal(resolve(state.outputs),resolve(state.workDirectory,'outputs'));contained(state.workDirectory,state.inputs);contained(state.workDirectory,state.outputs);contained(state.workDirectory,statePath);
  const inputPaths=['sourcePath','scorePath','embeddedPath','stereoPath','monoPath','monoProjectPath','errorProjectPath'];for(const key of inputPaths){contained(state.inputs,state[key]);assert.ok(Object.hasOwn(state.hashes,state[key]));}assert.equal(Object.keys(state.hashes).length,8);for(const [path,digest]of Object.entries(state.hashes)){contained(state.inputs,path);assert.match(digest,/^[a-f0-9]{64}$/);assert.equal(sha256(readFileSync(path)),digest,`Preserve authored waveform input: ${path}`);}for(const path of sourcePaths)assert.equal(sha256(readFileSync(resolve(root,path))),state.sourceHashes[path],`Driver/fixture changed after preparation: ${path}`);
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const args=process.argv.slice(2);if(args.length===0)console.log('Inert. Explicit --prepare creates a new owned authored waveform fixture.');else{assert.deepEqual(args,['--prepare'],'Only explicit --prepare is supported');console.log(JSON.stringify(prepareBackingWaveformFixture(),null,2));}}
