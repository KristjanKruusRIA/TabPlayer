import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {basename,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {exporter,model,Settings} from '@coderline/alphatab';
import {unzipSync,zipSync} from 'fflate';
import {contained,manifestDigest,repository,sha256,sourceManifest,rejectedPriorExecutableSha256} from './backing-tempo-fixture.mjs';
export {contained,manifestDigest,repository,sha256,sourceManifest};
export const processingDirectory=resolve(repository,'.analysis/desktop-smoke');
const canonical=path=>realpathSync(path).replaceAll('\\','/').toLowerCase();
const encode=value=>Buffer.from(JSON.stringify(value,null,2));

export function assertProcessingAdmission(value){
  assert.equal(value.format,'TabPlayerBackingProcessingBuildAdmission');assert.equal(value.version,1);
  assert.equal(canonical(value.worktree),canonical(repository));assert.equal(value.rootReviewed,true);
  assert.equal(value.diagnosticFeature,'desktop-test');assert.equal(value.frontendDesktopTest,true);
  assert.ok(isAbsolute(value.executable));assert.equal(canonical(value.executable),resolve(value.executable).replaceAll('\\','/').toLowerCase());
  assert.match(value.executableSha256,/^[a-f0-9]{64}$/);assert.equal(sha256(readFileSync(value.executable)),value.executableSha256);
  assert.ok(Array.isArray(value.rejectedExecutableSha256)&&new Set(value.rejectedExecutableSha256).size>=2,'Root must record P15 and current pre-P17 executable hashes');
  assert.ok(value.rejectedExecutableSha256.includes(rejectedPriorExecutableSha256));
  for(const hash of value.rejectedExecutableSha256){assert.match(hash,/^[a-f0-9]{64}$/);assert.notEqual(hash,value.executableSha256,'Old diagnostic rejected');}
  assert.deepEqual(value.sourceHashes,sourceManifest(),'Reviewed/build source changed');assert.equal(value.buildSourceSha256,manifestDigest(value.sourceHashes));
  const newest=Math.max(...Object.keys(value.sourceHashes).map(path=>statSync(resolve(repository,path)).mtimeMs));
  assert.ok(Date.parse(value.builtAtUtc)>=newest);assert.ok(statSync(value.executable).mtimeMs>=newest);
  assert.ok(isAbsolute(value.frontendManifestPath));assert.equal(sha256(readFileSync(value.frontendManifestPath)),value.frontendManifestSha256,'Root frontend resource receipt changed');
  const resources=JSON.parse(readFileSync(value.frontendManifestPath));assert.equal(resources.buildSourceSha256,value.buildSourceSha256);
  for(const directory of ['dist','src-tauri/resources']){
    const paths=[];const walk=path=>{for(const entry of readdirSync(resolve(repository,path),{withFileTypes:true})){const child=`${path}/${entry.name}`;if(entry.isDirectory())walk(child);else{assert.ok(entry.isFile(),'Resource links are not admitted');paths.push(child);}}};walk(directory);
    assert.ok(paths.length>0);assert.deepEqual(Object.keys(resources.files).filter(path=>path.startsWith(`${directory}/`)).sort(),paths.sort());for(const path of paths)assert.equal(sha256(readFileSync(resolve(repository,path))),resources.files[path],`Built resource changed: ${path}`);
  }
}

function wave(frequencies){
  const rate=48000,frames=rate*8,bytes=Buffer.alloc(44+frames*4);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
  for(let frame=0;frame<frames;frame++){const sample=Math.round(frequencies.reduce((sum,hz)=>sum+800*Math.sin(2*Math.PI*hz*frame/rate),0));bytes.writeInt16LE(sample,44+frame*4);bytes.writeInt16LE(-sample,46+frame*4);}
  return bytes;
}
function score(embedded){
  const value=new model.Score(),settings=new Settings();value.title='Original pitch and filter study';value.artist='TabPlayer authored verification';
  const track=new model.Track(),staff=new model.Staff();track.name='Original guitar';staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);value.addTrack(track);
  for(let barIndex=0;barIndex<4;barIndex++){const master=new model.MasterBar();master.timeSignatureNumerator=4;master.timeSignatureDenominator=4;if(barIndex===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];value.addMasterBar(master);const bar=new model.Bar(),voice=new model.Voice();bar.id=barIndex;voice.id=barIndex;staff.addBar(bar);bar.addVoice(voice);for(let i=0;i<4;i++){const beat=new model.Beat(),note=new model.Note();beat.id=barIndex*4+i;note.id=beat.id;beat.isEmpty=false;beat.duration=model.Duration.Quarter;note.string=6;note.fret=5+i;beat.addNote(note);voice.addBeat(beat);}}
  if(embedded){value.backingTrack=new model.BackingTrack();value.backingTrack.rawAudioFile=embedded;}
  value.rebuildRepeatGroups();value.finish(settings);return Buffer.from(zipSync(unzipSync(new exporter.Gp7Exporter().export(value,settings)),{mtime:new Date(2000,0,1)}));
}
export function prepareBackingProcessingFixture({admissionPath}={}){
  assert.ok(typeof admissionPath==='string'&&isAbsolute(admissionPath));const admissionBytes=readFileSync(admissionPath),admission=JSON.parse(admissionBytes);assertProcessingAdmission(admission);
  mkdirSync(processingDirectory,{recursive:true});const workDirectory=mkdtempSync(resolve(processingDirectory,'backing-processing-')),inputs=resolve(workDirectory,'inputs'),outputs=resolve(workDirectory,'outputs');mkdirSync(inputs);mkdirSync(outputs);
  const hashes={},put=(name,bytes)=>{const path=resolve(inputs,name);writeFileSync(path,bytes,{flag:'wx'});hashes[path]=sha256(bytes);return path;};
  const tone=wave([440]),bands=wave([80,1000,10000]),scoreBytes=score(),wavePath=put('original-440.wav',tone),bandsPath=put('original-three-bands.wav',bands),scorePaths={main:put('original.gp',scoreBytes),embedded:put('original-embedded.gp',score(tone))};
  const project=(bytes,path)=>({format:'TabPlayer',schemaVersion:3,engineVersion:'1.8.4',base:{kind:'file',filename:scorePaths.main,bytesBase64:scoreBytes.toString('base64'),sha256:sha256(scoreBytes)},baselineEdits:[{type:'setBacking',backing:{assetId:sha256(bytes),offsetMs:0,anchors:[],mix:{gain:1,pan:0,mute:false,solo:false}}}],edits:[],assets:{[sha256(bytes)]:{filename:path,mediaType:'audio/wav',bytesBase64:bytes.toString('base64')}}});
  const projects={main:project(tone,wavePath),bands:project(bands,bandsPath)},projectPaths=Object.fromEntries(Object.entries(projects).map(([key,value])=>[key,put(`${key}.tabplayer`,encode(value))]));
  const state={format:'TabPlayerBackingProcessingAcceptance',version:1,authored:true,ownershipId:randomUUID(),workDirectory,inputs,outputs,hashes,wavePath,bandsPath,scorePaths,projectPaths,admission,admissionSha256:sha256(admissionBytes),sourceHashes:sourceManifest(),limits:['Original authored score/audio only. No Play, device change, physical listening/capture or proprietary runtime.','Native decoded Arc reuse requires joined native tests; status exposes timing/generation but no Arc identity.','One new-control visual batch; root alone reviews or authorizes one correction/confirmation.']};
  const statePath=resolve(workDirectory,'fixture-state.json');writeFileSync(statePath,encode(state),{flag:'wx'});return {statePath,stateSha256:sha256(readFileSync(statePath)),workDirectory};
}
export function assertBackingProcessingFixture(state,statePath){
  assert.equal(state.format,'TabPlayerBackingProcessingAcceptance');assert.equal(state.version,1);assert.equal(state.authored,true);assert.match(state.ownershipId,/^[a-f0-9-]{36}$/);
  assert.ok(isAbsolute(statePath));assert.equal(resolve(statePath),resolve(state.workDirectory,'fixture-state.json'));contained(processingDirectory,state.workDirectory);assert.match(basename(state.workDirectory),/^backing-processing-[a-zA-Z0-9]+$/);
  for(const name of ['inputs','outputs']){assert.equal(resolve(state[name]),resolve(state.workDirectory,name));contained(state.workDirectory,state[name]);}
  const paths=[state.wavePath,state.bandsPath,...Object.values(state.scorePaths),...Object.values(state.projectPaths)];assert.equal(new Set(paths).size,paths.length);assert.deepEqual(Object.keys(state.hashes).sort(),paths.sort());
  for(const path of paths){contained(state.inputs,path);assert.equal(sha256(readFileSync(path)),state.hashes[path]);}
  assert.deepEqual(state.sourceHashes,sourceManifest());assertProcessingAdmission(state.admission);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const args=process.argv.slice(2);if(!args.length||args.length===1&&args[0]==='--help')console.log('Inert. Root only: --prepare --admission=<absolute reviewed current build admission.json>.');else{assert.equal(args.length,2);assert.equal(args[0],'--prepare');assert.ok(args[1].startsWith('--admission='));console.log(JSON.stringify(prepareBackingProcessingFixture({admissionPath:args[1].slice(12)}),null,2));}}
