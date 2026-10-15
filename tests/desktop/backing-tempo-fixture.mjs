import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exporter,importer,midi,model,Settings} from '@coderline/alphatab';
import {unzipSync,zipSync} from 'fflate';

export const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const tempoDirectory=resolve(repository,'.analysis/desktop-smoke');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
// Read-only hash of the P15 executable observed before this P16 driver was authored.
export const rejectedPriorExecutableSha256='fe93eb9c4855a0d99f1511defc24a673c14d79f25b79753fd5cf601b9c85e803';
const encode=value=>Buffer.from(JSON.stringify(value,null,2));
const normalized=path=>resolve(path).replaceAll('\\','/').toLowerCase();
export const backingOf=project=>[...project.baselineEdits,...project.edits].filter(edit=>edit.type==='setBacking').at(-1)?.backing;
export const projectView=project=>({...structuredClone(project),assets:Object.fromEntries(Object.entries(project.assets).map(([id,asset])=>[id,{filename:asset.filename,mediaType:asset.mediaType,byteLength:Buffer.from(asset.bytesBase64,'base64').length}]))});

// No Git subprocess, build, fixture creation or application launch is performed by this query.
export function sourceManifest(){
  const files=[];
  const walk=path=>{for(const entry of readdirSync(resolve(repository,path),{withFileTypes:true})){const child=`${path}/${entry.name}`;if(entry.isDirectory())walk(child);else if(entry.isFile())files.push(child);else throw Error(`Unexpected source link: ${child}`);}};
  for(const path of ['src','src-tauri/src','src-tauri/tests','src-tauri/capabilities','tests/desktop','scripts','public'])walk(path);
  for(const path of ['index.html','package.json','package-lock.json','tsconfig.json','vite.config.ts','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','src-tauri/tauri.test.conf.json','src-tauri/build.rs'])if(existsSync(resolve(repository,path)))files.push(path);
  return Object.fromEntries([...new Set(files)].sort().map(path=>[path,sha256(readFileSync(resolve(repository,path)))]));
}
export const manifestDigest=manifest=>sha256(JSON.stringify(manifest));
export function assertAdmission(admission){
  assert.equal(admission.format,'TabPlayerBackingTempoBuildAdmission');assert.equal(admission.version,1);
  assert.equal(normalized(realpathSync(admission.worktree)),normalized(realpathSync(repository)));
  assert.equal(admission.diagnosticFeature,'desktop-test');assert.equal(admission.frontendDesktopTest,true);
  assert.equal(admission.rootReviewed,true,'Root must review the frozen source before preparing');
  assert.ok(isAbsolute(admission.executable));assert.equal(normalized(realpathSync(admission.executable)),normalized(admission.executable));
  assert.match(admission.executableSha256,/^[a-f0-9]{64}$/);assert.equal(sha256(readFileSync(admission.executable)),admission.executableSha256);
  assert.deepEqual(admission.sourceHashes,sourceManifest(),'Exact reviewed/build source changed');
  assert.equal(admission.buildSourceSha256,manifestDigest(admission.sourceHashes));
  assert.ok(Number.isFinite(Date.parse(admission.builtAtUtc)),'Explicit root build timestamp required');
  const newestSource=Math.max(...Object.keys(admission.sourceHashes).map(path=>statSync(resolve(repository,path)).mtimeMs));
  assert.ok(Date.parse(admission.builtAtUtc)>=newestSource,'Build admission predates current source');
  assert.ok(statSync(admission.executable).mtimeMs>=newestSource,'Executable predates current source');
  assert.equal(admission.rejectedPriorExecutableSha256,rejectedPriorExecutableSha256,'Admission must identify the observed old P15 executable');assert.notEqual(admission.executableSha256,rejectedPriorExecutableSha256,'Never launch the prior P15 executable');
}

// Original PCM16: quiet opposite-polarity tones and literal impulses at gate boundaries.
function authoredWave(){
  const sampleRate=8000,channels=2,frameCount=128000,durationMs=16000;
  const impulses=[[0,28000,-28000],[7999,26000,-26000],[8000,-28000,28000],[24000,30000,-30000],[32000,-30000,30000],[55999,24000,-24000],[56000,31000,-31000],[127999,-26000,26000]];
  const bytes=Buffer.alloc(44+frameCount*channels*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*channels*2,28);bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frameCount*channels*2,40);
  for(let frame=0;frame<frameCount;frame++){const tone=Math.round(1800*Math.sin(2*Math.PI*200*frame/sampleRate));bytes.writeInt16LE(tone,44+frame*4);bytes.writeInt16LE(-tone,46+frame*4);}
  for(const [frame,left,right]of impulses){bytes.writeInt16LE(left,44+frame*4);bytes.writeInt16LE(right,46+frame*4);}
  return {bytes,oracle:{sampleRate,channels,frameCount,durationMs,impulses,toneHz:200,toneAmplitude:1800}};
}

function authoredScore({bars=2,meter=[4,4],intra=false,repeat=false,grace=false,embedded=null,title='Reference clock study'}={}){
  const score=new model.Score(),config=new Settings();score.title=title;score.artist='TabPlayer authored verification';
  for(let index=0;index<bars;index++){const master=new model.MasterBar();master.timeSignatureNumerator=meter[0];master.timeSignatureDenominator=meter[1];if(index===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2),...(intra?[model.Automation.buildTempoAutomation(false,1/3,60,2)]:[])];if(intra&&index===1)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,.5,180,2)];score.addMasterBar(master);}
  if(repeat){score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;}
  const track=new model.Track(),staff=new model.Staff();track.name='Reference guitar';track.shortName='Ref';Object.assign(track.playbackInfo,{program:25,primaryChannel:0,secondaryChannel:1});staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showStandardNotation=true;staff.showTablature=true;track.addStaff(staff);score.addTrack(track);
  let serial=0;for(let index=0;index<bars;index++){const bar=new model.Bar(),voice=new model.Voice();bar.id=index;voice.id=index;bar.clef=model.Clef.G2;staff.addBar(bar);bar.addVoice(voice);const pulses=meter[0],addBeat=(pulse,isGrace=false)=>{const beat=new model.Beat(),note=new model.Note();beat.id=serial;note.id=serial++;beat.duration=meter[1]===8?model.Duration.Eighth:model.Duration.Quarter;beat.isEmpty=false;if(isGrace){beat.duration=model.Duration.Eighth;beat.graceType=model.GraceType.BeforeBeat;}note.string=6;note.fret=isGrace?1:5+index*4+pulse;beat.addNote(note);voice.addBeat(beat);};if(grace&&index===0)addBeat(0,true);for(let pulse=0;pulse<pulses;pulse++)addBeat(pulse);}
  if(embedded){score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=embedded;}
  score.rebuildRepeatGroups();score.finish(config);
  const bytes=Buffer.from(zipSync(unzipSync(new exporter.Gp7Exporter().export(score,config)),{mtime:new Date(2000,0,1)})),copy=importer.ScoreLoader.loadScoreFromBytes(bytes,config);
  assert.equal(copy.masterBars.length,bars);assert.deepEqual(copy.masterBars.map(bar=>[bar.timeSignatureNumerator,bar.timeSignatureDenominator]),Array.from({length:bars},()=>meter));
  assert.deepEqual(copy.tracks[0].staves[0].bars.map(bar=>bar.voices[0].beats.filter(beat=>beat.graceType===model.GraceType.None).map(beat=>beat.notes[0].fret)),Array.from({length:bars},(_,bar)=>Array.from({length:meter[0]},(_,pulse)=>5+bar*4+pulse)));
  const generator=new midi.MidiFileGenerator(copy,config,new midi.AlphaSynthMidiFileHandler(new midi.MidiFile(),true));generator.generate();
  if(repeat)assert.deepEqual(generator.tickLookup.masterBars.map(bar=>[bar.masterBar.index,bar.start,bar.end]),[[0,0,3840],[1,3840,7680],[0,7680,11520],[1,11520,15360]]);
  if(intra){assert.equal(copy.masterBars[0].tempoAutomations[1].value,60);assert.ok(Math.abs(copy.masterBars[0].tempoAutomations[1].ratioPosition-1/3)<1e-8);}
  if(grace)assert.equal(copy.tracks[0].staves[0].bars[0].voices[0].beats[0].graceType,model.GraceType.BeforeBeat);
  if(embedded)assert.deepEqual(Buffer.from(copy.backingTrack.rawAudioFile),embedded);
  return bytes;
}

export function buildBackingTempoFixture(){
  const wave=authoredWave();
  return {wave,scores:{main:authoredScore({intra:true,title:'Two spans — original reference study'}),repeat:authoredScore({repeat:true,title:'Repeated passes — original conflict study'}),compound:authoredScore({bars:1,meter:[6,8],title:'Six pulses — original meter study'}),grace:authoredScore({bars:1,grace:true,title:'Grace entrance — original gate study'}),unique:authoredScore({bars:3,title:'Unique source window — original excerpt study'}),embedded:authoredScore({embedded:wave.bytes,title:'Original embedded read-only study'})},invalidAudio:Buffer.from('Authored malformed WAV for the actual source-error state.'),oracles:{twoSpan:{pins:[[0,1000],[3840,3000],[7680,7000]],tempos:[120,60],durationSeconds:6,seek:{tick:4800,seconds:3,sourceMs:4000}},fromScore:{anchors:[{bar:0,occurrence:0,ratio:1/3,audioMs:5000/3},{bar:1,occurrence:0,ratio:.5,audioMs:19000/3}],entryMs:1000,exitMs:7000},compound:{pulses:[0,500,1000,1500,2000,2500],durationSeconds:3,bpm:60},grace:{entryTick:120,exitTick:3960,preRollSeconds:.0625,durationSeconds:2.0625},unique:{bar:2,startSourceMs:3750,endSourceMs:5750,frameToleranceMs:1.5/44.1},repeat:{route:[0,1,0,1],conflictTempos:[60,120]}}};
}

export function prepareBackingTempoFixture({admissionPath}={}){
  assert.ok(typeof admissionPath==='string'&&isAbsolute(admissionPath),'Explicit absolute reviewed build admission required');
  const admissionBytes=readFileSync(admissionPath),admission=JSON.parse(admissionBytes);assertAdmission(admission);
  const fixture=buildBackingTempoFixture();mkdirSync(tempoDirectory,{recursive:true});const workDirectory=mkdtempSync(resolve(tempoDirectory,'backing-tempo-')),inputs=resolve(workDirectory,'inputs'),outputs=resolve(workDirectory,'outputs');mkdirSync(inputs);mkdirSync(outputs);const hashes={};
  const put=(name,bytes)=>{const path=resolve(inputs,name);writeFileSync(path,bytes,{flag:'wx'});hashes[path]=sha256(bytes);return path;};
  const wavePath=put('authored-stereo-impulses-tone.wav',fixture.wave.bytes),scorePaths=Object.fromEntries(Object.entries(fixture.scores).map(([name,bytes])=>[name,put(`authored-${name}.gp`,bytes)])),assetId=sha256(fixture.wave.bytes);
  const settings={assetId,offsetMs:0,anchors:[],mix:{gain:.73,pan:-.2,mute:false,solo:false}},reference=(entryAudioMs,exitAudioMs,anchors=[])=>({...settings,anchors,referenceSync:{entryAudioMs,exitAudioMs}});
  const project=(scoreName,backing=settings,audio=fixture.wave.bytes)=>({format:'TabPlayer',schemaVersion:3,engineVersion:'1.8.4',base:{kind:'file',filename:scorePaths[scoreName],bytesBase64:fixture.scores[scoreName].toString('base64'),sha256:sha256(fixture.scores[scoreName])},baselineEdits:backing?[{type:'setBacking',backing}]:[],edits:[],assets:backing?{[backing.assetId]:{filename:wavePath,mediaType:'audio/wav',bytesBase64:audio.toString('base64')}}:{}});
  const invalidId=sha256(fixture.invalidAudio),projects={main:project('main'),repeat:project('repeat',reference(1000,13000,[{bar:0,occurrence:1,ratio:0,audioMs:9000}])),compound:project('compound',reference(0,3000)),grace:project('grace',reference(1000,3000)),unique:project('unique',{...settings,offsetMs:250}),eof:project('main',reference(1000,15000,[{bar:1,occurrence:0,ratio:0,audioMs:7000}])),error:project('main',{...settings,assetId:invalidId},fixture.invalidAudio)};
  const projectPaths=Object.fromEntries(Object.entries(projects).map(([name,value])=>[name,put(`${name}.tabplayer`,encode(value))]));
  const state={format:'TabPlayerBackingTempoAcceptance',version:1,authored:true,ownershipId:randomUUID(),workDirectory,inputs,outputs,wavePath,scorePaths,projectPaths,projects,assetId,hashes,oracles:{...fixture.oracles,wave:fixture.wave.oracle},admission,admissionSha256:sha256(admissionBytes),sourceHashes:sourceManifest(),limits:['Original authored GP/WAV only; no user song, private bank, recording or physical audio.','Native PCM/source-gate evidence is a separately joined root receipt; this UI driver establishes no audible equivalence.','GP bracket interchange, macOS/Linux runtime and shipping remain unverified.','Visual capture is one bounded batch plus at most one explicit root confirmation.']};
  const statePath=resolve(workDirectory,'fixture-state.json');writeFileSync(statePath,encode(state),{flag:'wx'});return {statePath,stateSha256:sha256(readFileSync(statePath)),workDirectory,admissionSha256:state.admissionSha256};
}

export function contained(parent,child){const value=relative(realpathSync(parent),realpathSync(child));assert.ok(value&&!value.startsWith('..')&&!isAbsolute(value),`Path must stay within owned root: ${child}`);}
export function assertBackingTempoFixture(state,statePath){
  assert.equal(state.format,'TabPlayerBackingTempoAcceptance');assert.equal(state.version,1);assert.equal(state.authored,true);assert.match(state.ownershipId,/^[a-f0-9-]{36}$/);assert.ok(isAbsolute(statePath));assert.equal(basename(statePath),'fixture-state.json');assert.equal(resolve(statePath),resolve(state.workDirectory,'fixture-state.json'));contained(tempoDirectory,state.workDirectory);assert.match(basename(state.workDirectory),/^backing-tempo-[a-zA-Z0-9]+$/);assert.equal(resolve(state.inputs),resolve(state.workDirectory,'inputs'));assert.equal(resolve(state.outputs),resolve(state.workDirectory,'outputs'));contained(state.workDirectory,state.inputs);contained(state.workDirectory,state.outputs);contained(state.workDirectory,statePath);
  const paths=[state.wavePath,...Object.values(state.scorePaths),...Object.values(state.projectPaths)];assert.equal(Object.keys(state.hashes).length,paths.length);assert.equal(new Set(paths).size,paths.length);
  for(const path of paths){contained(state.inputs,path);assert.match(state.hashes[path],/^[a-f0-9]{64}$/);assert.equal(sha256(readFileSync(path)),state.hashes[path],`Preserve authored input ${path}`);}
  assert.deepEqual(state.sourceHashes,sourceManifest(),'Fixture source changed since explicit preparation');assertAdmission(state.admission);
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2);
  if(args.length===0||args.length===1&&args[0]==='--help')console.log('Inert. Root only: --prepare --admission=<absolute reviewed current-source build admission.json>. No files, processes, browser, audio or cleanup on default/--help.');
  else{assert.equal(args.length,2);assert.equal(args[0],'--prepare');assert.ok(args[1].startsWith('--admission='));console.log(JSON.stringify(prepareBackingTempoFixture({admissionPath:args[1].slice(12)}),null,2));}
}
