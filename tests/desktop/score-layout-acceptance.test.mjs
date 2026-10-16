import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,utimesSync,statSync,rmSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {importer,midi,Settings} from '@coderline/alphatab';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const digest=value=>createHash('sha256').update(value).digest('hex');
const load=()=>import('./score-layout-fixture.mjs');
const itinerary=[0,1,2,3,4,5,6,7,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];

test('literal24BarMultistaffGpRoundtrip',async()=>{
  const {buildScoreLayoutFixture}=await load();
  const {gpBytes,oracle}=buildScoreLayoutFixture(),settings=new Settings();
  assert.equal(digest(gpBytes),digest(buildScoreLayoutFixture().gpBytes),'deterministic GP ZIP');
  const score=importer.ScoreLoader.loadScoreFromBytes(gpBytes,settings);
  assert.equal(score.masterBars.length,24);assert.equal(score.tracks.length,2);
  assert.deepEqual(score.tracks.map(t=>t.staves.length),[1,2]);
  assert.deepEqual(score.systemsLayout,[3,3,3,3,3,3,3,3]);
  const notes=[],rests=[];
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars){
    assert.equal(bar.voices.length,2);
    for(const voice of bar.voices)for(const beat of voice.beats){
      const target={track:track.index,staff:staff.index,bar:bar.index,voice:voice.index,beat:beat.index};
      for(const note of beat.notes)notes.push({target,noteIndex:note.index,string:note.string,key:note.realValue});
      if(beat.isRest)rests.push({target});
    }
  }
  assert.deepEqual(notes,oracle.notes);assert.deepEqual(rests,oracle.rests);
  assert.equal(notes.length,288);assert.equal(rests.length,288);
  assert.deepEqual(notes[0],{target:{track:0,staff:0,bar:0,voice:0,beat:0},noteIndex:0,string:1,key:45});
  assert.equal(score.title,'Twenty-four windows');assert.equal(score.artist,'TabPlayer authored layout study');
  assert.equal(score.tracks[0].staves[0].bars[23].voices[0].beats[2].text,'Last window — complete');
  assert.ok(score.tracks[0].staves[0].bars[0].voices[0].beats[0].chord);
  assert.deepEqual(score.tracks[0].staves[0].tuning,[64,59,55,50,45,40]);
  assert.ok(score.tracks[0].staves[0].bars[0].voices[0].beats[0].lyrics?.includes('First'));
  const generator=new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(new midi.MidiFile(),true));generator.generate();
  assert.deepEqual(generator.tickLookup.masterBars.map(b=>b.masterBar.index),itinerary);
  assert.deepEqual(oracle.performedBars,itinerary);
  assert.deepEqual(oracle.occurrences[8],{bar:6,occurrence:1,startTick:30720,endTick:34560});
  assert.ok(oracle.gestureCases.length>=6);
  assert.deepEqual(oracle.initialPrint,{paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'ScoreTab'});
  assert.deepEqual(oracle.page,{widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'ScoreTab'});
});

test('publicGpEmptyBeatLimitationRemainsExplicit',async()=>{
  const {gpBytes,oracle}= (await load()).buildScoreLayoutFixture();
  const score=importer.ScoreLoader.loadScoreFromBytes(gpBytes,new Settings());
  assert.equal(score.tracks[1].staves[1].bars[23].voices[1].beats[3].isEmpty,false);
  assert.equal(score.tracks[1].staves[1].bars[23].voices[1].beats[3].isRest,true);
  assert.deepEqual(oracle.emptyBeats,[]);assert.equal(oracle.emptyBeatPending.authoredIsEmpty,true);assert.equal(oracle.emptyBeatPending.reimportedIsEmpty,false);
});

async function isolated(t){
  const base=mkdtempSync(resolve(tmpdir(),'score-layout-contract-'));
  t.after(()=>{const child=relative(resolve(tmpdir()),resolve(base));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(base,{recursive:true,force:true});});
  const put=(path,value)=>{const p=resolve(base,path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,value);return p;};
  put('tests/desktop/score-layout-fixture.mjs',readFileSync(resolve(root,'tests/desktop/score-layout-fixture.mjs')));
  for(const path of ['score-layout-observer.mjs','score-layout-acceptance.test.mjs','parity-score-layouts.mjs','score-layout-driver.test.mjs'])put(`tests/desktop/${path}`,'// isolated inventory');
  for(const dir of ['src','src-tauri/src','src-tauri/tests','src-tauri/capabilities','scripts','public'])put(`${dir}/sentinel.txt`,'source');
  put('package.json','{"type":"module"}');symlinkSync(resolve(root,'node_modules'),resolve(base,'node_modules'),'junction');
  const fixture=await import(pathToFileURL(resolve(base,'tests/desktop/score-layout-fixture.mjs')).href);
  const run='.analysis/desktop-smoke/score-layout-test-build';
  const executable=put(`${run}/build/tabplayer.exe`,'fresh fake executable');
  const configPath=put(`${run}/build/config.json`,'{}'),buildLogPath=put(`${run}/build/build.log`,'isolated build');
  const reportPath=put(`${run}/build/review.md`,'isolated passed review');
  const reference=put('docs/design/reference.txt','isolated reference');
  put('dist/index.html','fresh frontend');put('src-tauri/resources/resource.txt','fresh resource');
  const libraryRoot=resolve(dirname(executable),'Library');put(`${run}/build/Library/library.txt`,'fresh library');
  const audioTarget=resolve(base,'audio-target');put('audio-target/sound.sf2','fake audio bytes');
  const audioLink=resolve(dirname(executable),'audio');symlinkSync(audioTarget,audioLink,'junction');
  const sourceHashes=fixture.sourceManifest(),buildSourceSha256=fixture.manifestDigest(sourceHashes);
  const frontendManifestPath=put(`${run}/build/frontend.json`,JSON.stringify({buildSourceSha256,files:{'dist/index.html':digest('fresh frontend'),'src-tauri/resources/resource.txt':digest('fresh resource')}}));
  const runtimeResourceManifestPath=put(`${run}/build/runtime.json`,JSON.stringify({buildSourceSha256,libraryRoot,libraryFiles:{'library.txt':digest('fresh library')},audioLink,audioTarget,audioFiles:{'sound.sf2':digest('fake audio bytes')}}));
  const now=Date.now()-2000;for(const path of Object.keys(sourceHashes))utimesSync(resolve(base,path),new Date(now-2000),new Date(now-2000));utimesSync(executable,new Date(now),new Date(now));
  const admission={format:'TabPlayerScoreLayoutBuildAdmission',version:1,worktree:base,sourceReview:{frozenRevision:'a'.repeat(40),reportPath,reportSha256:digest(readFileSync(reportPath)),status:'passed'},rootReviewed:true,diagnosticFeature:'desktop-test',frontendDesktopTest:true,sourceHashes,buildSourceSha256,buildStartedAtUtc:new Date(now-500).toISOString(),builtAtUtc:new Date(now+500).toISOString(),executable,referencePacketHashes:{[reference]:digest(readFileSync(reference))}};
  for(const [name,path]of Object.entries({executable,configPath,buildLogPath,frontendManifestPath,runtimeResourceManifestPath})){admission[name]=path;admission[name.replace(/Path$/,'')+'Sha256']=digest(readFileSync(path));}
  const admissionPath=put(`${run}/admission.json`,JSON.stringify(admission));
  return {base,put,fixture,admission,admissionPath};
}

test('freshAdmissionRejectsChangedSourceExeResources',async t=>{
  const {base,fixture,admission}=await isolated(t);fixture.assertScoreLayoutAdmission(admission);
  for(const key of ['rootReviewed','frontendDesktopTest'])assert.throws(()=>fixture.assertScoreLayoutAdmission({...admission,[key]:false}));
  for(const key of ['executableSha256','configSha256','buildLogSha256','frontendManifestSha256','runtimeResourceManifestSha256','buildSourceSha256'])assert.throws(()=>fixture.assertScoreLayoutAdmission({...admission,[key]:'0'.repeat(64)}),key);
  for(const field of ['buildStartedAtUtc','builtAtUtc'])for(const value of ['invalid','1970-01-01T00:00:00Z'])assert.throws(()=>fixture.assertScoreLayoutAdmission({...admission,[field]:value}));
  assert.throws(()=>fixture.assertScoreLayoutAdmission({...admission,sourceReview:{...admission.sourceReview,status:'pending'}}));
  assert.throws(()=>fixture.assertScoreLayoutAdmission({...admission,sourceReview:{...admission.sourceReview,reportSha256:'0'.repeat(64)}}));
  for(const path of ['src/sentinel.txt','dist/index.html','src-tauri/resources/resource.txt','.analysis/desktop-smoke/score-layout-test-build/build/Library/library.txt','audio-target/sound.sf2','.analysis/desktop-smoke/score-layout-test-build/build/tabplayer.exe']){
    const p=resolve(base,path),before=readFileSync(p),stamp=statSync(p);writeFileSync(p,'changed');assert.throws(()=>fixture.assertScoreLayoutAdmission(admission),path);writeFileSync(p,before);utimesSync(p,stamp.atime,stamp.mtime);fixture.assertScoreLayoutAdmission(admission);
  }
  const changed=structuredClone(admission);delete changed.sourceHashes['tests/desktop/score-layout-driver.test.mjs'];assert.throws(()=>fixture.assertScoreLayoutAdmission(changed));
  writeFileSync(resolve(base,'dist/extra.txt'),'extra');assert.throws(()=>fixture.assertScoreLayoutAdmission(admission),'exact resource inventory');
});

test('admissionRejectsLinkedFilesPartialInventoriesAndForgedTimes',async t=>{
  const {base,fixture,admission,put}=await isolated(t);fixture.assertScoreLayoutAdmission(admission);
  assert.throws(()=>fixture.assertScoreLayoutAdmission({...admission,builtAtUtc:new Date(Date.now()+60000).toISOString()}));
  const outside=put('outside.exe','fresh fake executable');assert.throws(()=>fixture.assertScoreLayoutAdmission({...admission,executable:outside}));
  for(const [manifestPath,hashKey,mutate]of [
    [admission.frontendManifestPath,'frontendManifestSha256',m=>{delete m.files['src-tauri/resources/resource.txt'];}],
    [admission.runtimeResourceManifestPath,'runtimeResourceManifestSha256',m=>{m.libraryFiles={};}],
    [admission.runtimeResourceManifestPath,'runtimeResourceManifestSha256',m=>{m.audioFiles={};}],
    [admission.runtimeResourceManifestPath,'runtimeResourceManifestSha256',m=>{m.audioTarget=base;}],
  ]){const before=readFileSync(manifestPath),manifest=JSON.parse(before);mutate(manifest);writeFileSync(manifestPath,JSON.stringify(manifest));assert.throws(()=>fixture.assertScoreLayoutAdmission({...admission,[hashKey]:digest(readFileSync(manifestPath))}));writeFileSync(manifestPath,before);fixture.assertScoreLayoutAdmission(admission);}
  const linked=resolve(base,'dist/linked-resource');symlinkSync(resolve(base,'audio-target'),linked,'junction');assert.throws(()=>fixture.assertScoreLayoutAdmission(admission));
});

test('confirmationConsumesExactlyOneInitialTwelvePairReceipt',async t=>{
  const {fixture,admissionPath,put}=await isolated(t),layouts=['verticalPage','horizontalPage','grid','parchment','verticalScreen','horizontalScreen'];
  const screenshots=layouts.flatMap(layout=>[{layout,width:1600,height:1000},{layout,width:1024,height:600}]).map((pair,index)=>({...pair,path:put(`receipts/frame-${index}.png`,'isolated fake frame'),sha256:digest('isolated fake frame')}));
  const initialReceiptPath=put('receipts/initial.json',JSON.stringify({format:'TabPlayerScoreLayoutReceipt',version:1,scope:'initial',screenshots}));
  const correctionPacketPath=put('receipts/correction.json','{"corrections":[{"description":"authored test correction","contracts":["presentation"]}]}');
  const packet={attempt:1,initialReceiptPath,initialReceiptSha256:digest(readFileSync(initialReceiptPath)),correctionPacketPath,correctionPacketSha256:digest(readFileSync(correctionPacketPath)),affectedPairs:[{layout:'verticalPage',width:1600,height:1000}]};
  const confirmationPath=put('receipts/confirmation.json',JSON.stringify(packet));
  const badCorrection=put('receipts/unsupported-correction.json','{"corrections":[{"description":"unsupported","contracts":["runtime"]}]}');
  const badPacket=put('receipts/unsupported-packet.json',JSON.stringify({...packet,correctionPacketPath:badCorrection,correctionPacketSha256:digest(readFileSync(badCorrection))}));
  assert.throws(()=>fixture.prepareScoreLayoutFixture({admissionPath,confirmationPath:badPacket}),'unsupported correction family');
  const prepared=fixture.prepareScoreLayoutFixture({admissionPath,confirmationPath}),state=JSON.parse(readFileSync(prepared.statePath));fixture.assertScoreLayoutFixture(state,prepared.statePath);
  assert.throws(()=>fixture.prepareScoreLayoutFixture({admissionPath,confirmationPath}),'exclusive restart-persistent consumption');
  const alternateInitial=put('receipts/invalid-initial.json',JSON.stringify({format:'TabPlayerScoreLayoutReceipt',version:1,scope:'confirmation',screenshots}));
  const invalid=put('receipts/invalid-packet.json',JSON.stringify({...packet,initialReceiptPath:alternateInitial,initialReceiptSha256:digest(readFileSync(alternateInitial))}));assert.throws(()=>fixture.prepareScoreLayoutFixture({admissionPath,confirmationPath:invalid}));
  const duplicateInitial=put('duplicate-receipts/duplicate-initial.json',JSON.stringify({format:'TabPlayerScoreLayoutReceipt',version:1,scope:'initial',screenshots:Array(12).fill(screenshots[0])}));
  const duplicate=put('receipts/duplicate-packet.json',JSON.stringify({...packet,initialReceiptPath:duplicateInitial,initialReceiptSha256:digest(readFileSync(duplicateInitial))}));assert.throws(()=>fixture.prepareScoreLayoutFixture({admissionPath,confirmationPath:duplicate}));
  writeFileSync(screenshots[0].path,'changed');assert.throws(()=>fixture.assertScoreLayoutFixture(state,prepared.statePath),'initial captured bytes binding');writeFileSync(screenshots[0].path,'isolated fake frame');
  writeFileSync(state.confirmation.consumptionPath,'changed');assert.throws(()=>fixture.assertScoreLayoutFixture(state,prepared.statePath));
});

test('importsAndDefaultHelpAreInert',async t=>{
  const {base}=await isolated(t),before=readdirSync(base,{recursive:true}).sort();
  for(const args of [[],['--help']]){const result=spawnSync(process.execPath,[resolve(base,'tests/desktop/score-layout-fixture.mjs'),...args],{cwd:base,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Inert/);}
  assert.deepEqual(readdirSync(base,{recursive:true}).sort(),before);
});

test('fixtureStateRejectsEscapesAndChangedInput',async t=>{
  const {fixture,admissionPath,base}=await isolated(t);
  const prepared=fixture.prepareScoreLayoutFixture({admissionPath});
  const state=JSON.parse(readFileSync(prepared.statePath));fixture.assertScoreLayoutFixture(state,prepared.statePath);
  assert.equal(digest(readFileSync(prepared.statePath)),prepared.stateSha256);
  const again=fixture.prepareScoreLayoutFixture({admissionPath});assert.notEqual(again.statePath,prepared.statePath);
  assert.equal(state.casePaths.main,state.scorePath);assert.equal(state.casePaths.upperLimit,null);assert.ok(state.limits.some(s=>/upper/i.test(s)));
  const oversize=JSON.parse(readFileSync(state.casePaths.oversize));assert.equal(oversize.base.sha256,state.hashes[state.scorePath]);assert.equal(oversize.baselineEdits[0].type,'setPageLayout');
  assert.throws(()=>fixture.assertScoreLayoutFixture({...state,inputs:base},prepared.statePath));
  assert.throws(()=>fixture.assertScoreLayoutFixture({...state,scorePath:admissionPath},prepared.statePath));
  writeFileSync(state.scorePath,'changed');assert.throws(()=>fixture.assertScoreLayoutFixture(state,prepared.statePath));
});

const observer=()=>import('./score-layout-observer.mjs');
const serialized=(fn,window)=>new Function('window',`return (${fn.toString()})();`)(window);
function fakeWindow(options={}){
  const requests=[],status={ready:true,playing:false,generation:2,desiredGeneration:2,tick:0,seconds:0,error:null};
  let responseFactory=()=>({headers:{get:()=>options.header??'ok'},clone(){if(options.cloneFailure)throw Error('secret clone detail');return {json:async()=>options.result===undefined?status:options.result};},json:async()=>status});
  const original=function(...args){requests.push({receiver:this,args});return Promise.resolve(responseFactory());};
  const window={fetch:original,__TAURI_INTERNALS__:{convertFileSrc:(name,protocol)=>`https://${protocol}.localhost/${name}`}};
  const invoke=async function(command,args){if(options.missingFetch)return status;const response=await window.fetch(`https://ipc.localhost/${command}`,{method:options.method??'POST',body:options.body??JSON.stringify(args)});const result=await response.json();return options.mismatch?{...result,tick:99}:result;};
  Object.defineProperty(window.__TAURI_INTERNALS__,'invoke',{value:invoke,writable:false,configurable:false,enumerable:true});
  if(options.immutableFetch)Object.defineProperty(window,'fetch',{value:original,writable:false,configurable:false});
  return {window,requests,status,original,setResponse:fn=>{responseFactory=fn;}};
}

test('immutableInvokeForwardsExactFetchOnce',async()=>{
  const o=await observer(),fake=fakeWindow();const before=Object.getOwnPropertyDescriptor(fake.window.__TAURI_INTERNALS__,'invoke');
  const installed=await serialized(o.installScoreLayoutIpcObserver,fake.window);assert.equal(installed.fetchIdentityVerified,true);assert.deepEqual(Object.getOwnPropertyDescriptor(fake.window.__TAURI_INTERNALS__,'invoke'),before);
  const response={headers:{get:()=> 'ok'},clone:()=>({json:async()=>null})};fake.setResponse(()=>response);
  const receiver={},input='https://ipc.localhost/workspace_set_view',init={method:'POST',headers:{secret:'redact'},body:JSON.stringify({documentId:'doc',view:{target:{track:0,staff:0,bar:3,voice:0,beat:0}},invokeKey:'secret'})};
  const returned=await fake.window.fetch.call(receiver,input,init);assert.equal(returned,response);assert.equal(fake.requests.length,2);assert.equal(fake.requests[1].receiver,receiver);assert.equal(fake.requests[1].args[0],input);assert.equal(fake.requests[1].args[1],init);
  let evidence=serialized(o.readScoreLayoutEvidence,fake.window);assert.equal(evidence.calls.length,1);assert.deepEqual(evidence.calls[0],{id:1,command:'workspace_set_view',payload:{documentId:'doc',view:{target:{track:0,staff:0,bar:3,voice:0,beat:0}}},settled:true,ok:true,result:null});assert.ok(!JSON.stringify(evidence).includes('secret'));
  await fake.window.fetch('https://ipc.localhost/audio_status',{method:'POST',body:'{}'});evidence=serialized(o.readScoreLayoutEvidence,fake.window);assert.equal(evidence.calls.length,1);
});

test('cloneFailureNeverResends',async()=>{
  const o=await observer(),fake=fakeWindow();await serialized(o.installScoreLayoutIpcObserver,fake.window);
  const response={headers:{get:()=> 'ok'},clone(){throw Error('private path');}};fake.setResponse(()=>response);
  assert.equal(await fake.window.fetch('https://ipc.localhost/audio_command',{method:'POST',body:'{"command":{"type":"seekTick","tick":480}}'}),response);
  assert.equal(fake.requests.length,2);const e=serialized(o.readScoreLayoutEvidence,fake.window);assert.equal(e.calls[0].ok,false);assert.equal(e.failures.length,1);assert.ok(!JSON.stringify(e).includes('private path'));
  const failure=Error('original rejection');fake.setResponse(()=>{throw failure;});await assert.rejects(fake.window.fetch('https://ipc.localhost/audio_command',{method:'POST',body:'{}'}),error=>error===failure);assert.equal(fake.requests.length,3);
});

test('probeMustMatchNativeStatus',async()=>{
  const o=await observer();
  for(const options of [{missingFetch:true},{header:'error'},{body:'[]'},{method:'GET'},{mismatch:true},{result:null},{result:{ready:true}},{immutableFetch:true},{cloneFailure:true}]){
    const fake=fakeWindow(options);await assert.rejects(serialized(o.installScoreLayoutIpcObserver,fake.window),undefined,JSON.stringify(options));serialized(o.disposeScoreLayoutObservers,fake.window);assert.equal(fake.window.fetch,fake.original);
  }
});

test('nativeAcknowledgementsRequireExactCommandResultContracts',async()=>{
  const o=await observer(),fake=fakeWindow();await serialized(o.installScoreLayoutIpcObserver,fake.window);
  for(const command of ['audio_prepare','audio_command','audio_set_mix','workspace_set_view']){
    fake.setResponse(()=>({headers:{get:()=> 'ok'},clone:()=>({json:async()=>({accepted:true})})}));await fake.window.fetch(`https://ipc.localhost/${command}`,{method:'POST',body:'{}'});assert.equal(serialized(o.readScoreLayoutEvidence,fake.window).calls.at(-1).ok,false);
    fake.setResponse(()=>({headers:{get:()=> 'ok'},clone:()=>({json:async()=>null})}));await fake.window.fetch(`https://ipc.localhost/${command}`,{method:'POST',body:'{}'});assert.equal(serialized(o.readScoreLayoutEvidence,fake.window).calls.at(-1).ok,true);
  }
  for(const [result,ok]of [[{documentId:'other',revision:1,snapshot:{}},false],[{documentId:'doc',revision:-1,snapshot:{}},false],[{documentId:'doc',revision:1,snapshot:null},false],[{documentId:'doc',revision:1,snapshot:{}},true]]){
    fake.setResponse(()=>({headers:{get:()=> 'ok'},clone:()=>({json:async()=>result})}));await fake.window.fetch('https://ipc.localhost/apply_edit',{method:'POST',body:JSON.stringify({document:{documentId:'doc',revision:0},command:{type:'transposeSelection',semitones:1}})});assert.equal(serialized(o.readScoreLayoutEvidence,fake.window).calls.at(-1).ok,ok);
  }
});

test('pageLayoutReceiptRetainsApprovedPrintPayload',async()=>{
  const o=await observer(),fake=fakeWindow();await serialized(o.installScoreLayoutIpcObserver,fake.window);
  const layout={widthMm:210,heightMm:297,marginsMm:{top:0,right:15,bottom:0,left:15},scale:1,profile:'document'};
  fake.setResponse(()=>({headers:{get:()=> 'ok'},clone:()=>({json:async()=>({documentId:'doc',revision:1,snapshot:{}})})}));
  await fake.window.fetch('https://ipc.localhost/apply_edit',{method:'POST',body:JSON.stringify({document:{documentId:'doc',revision:0},command:{type:'setPageLayout',layout}})});
  assert.deepEqual(serialized(o.readScoreLayoutEvidence,fake.window).calls[0].payload.command,{type:'setPageLayout',layout});
});

test('inheritedFetchAndFacadeThrowsRetainExactOwnership',async()=>{
  const o=await observer(),fake=fakeWindow(),fetch=fake.window.fetch;delete fake.window.fetch;Object.setPrototypeOf(fake.window,{fetch});await serialized(o.installScoreLayoutIpcObserver,fake.window);
  const {Api}=apiClass(),api=new Api(),error=Error('facade failure'),original=function(){throw error;};
  Object.defineProperty(api.uiFacade,'highlightElements',{value:original,writable:true,enumerable:false,configurable:true});const before=Object.getOwnPropertyDescriptor(api.uiFacade,'highlightElements');
  await apiInstall(o,fake.window,Api);api.renderScore({});assert.throws(()=>api.uiFacade.highlightElements('opaque',0),value=>value===error);
  serialized(o.disposeScoreLayoutObservers,fake.window);assert.equal(Object.hasOwn(fake.window,'fetch'),false);assert.equal(fake.window.fetch,fetch);assert.deepEqual(Object.getOwnPropertyDescriptor(api.uiFacade,'highlightElements'),before);
});

test('latePostMessageFallbackFailsFinalAcceptance',async()=>{
  const o=await observer(),page=new EventEmitter(),signals=[];const off=o.observeTauriFallback(page,signals,()=> 'cleanup');
  page.emit('console',{type:()=> 'log',text:()=> 'IPC custom protocol failed, Tauri will now use the postMessage interface instead secret'});o.assertNoTauriFallback(signals);
  page.emit('console',{type:()=> 'warning',text:()=> 'IPC custom protocol failed, Tauri will now use the postMessage interface instead secret'});assert.deepEqual(signals,[{phase:'cleanup',kind:'tauri-postmessage-fallback'}]);off();assert.throws(()=>o.assertNoTauriFallback(signals));
});

function event(){const listeners=new Set();return {on(fn){listeners.add(fn);},off(fn){listeners.delete(fn);},emit(value){for(const fn of listeners)fn(value);},get size(){return listeners.size;}};}
async function apiInstall(o,window,Api){
  // Only the external browser module is substituted; the entire installer body is serialized.
  globalThis.__scoreLayoutTestApi=Api;
  const module=`data:text/javascript,${encodeURIComponent('export const AlphaTabApi=globalThis.__scoreLayoutTestApi;') }#${Math.random()}`;
  try{return await new Function('window',`return (${o.installScoreLayoutApiObserver.toString().replace("'/alphatab/alphaTab.mjs'",JSON.stringify(module))})();`)(window);}finally{delete globalThis.__scoreLayoutTestApi;}
}
function apiClass(inherited=false){
  const calls=[],result={},failure=Error('actual render failure');
  const facadePrototype={highlightElements(...args){calls.push({kind:'highlight',receiver:this,args});return result;},removeHighlights(...args){calls.push({kind:'remove',receiver:this,args});return result;}};
  const render=function(...args){calls.push({kind:'render',receiver:this,args});if(args[0]===failure)throw failure;this.renderStarted.emit();return result;};
  class Base{};Object.defineProperty(Base.prototype,'renderScore',{value:render,writable:true,configurable:true,enumerable:false});
  class Api extends Base{constructor(){super();this.renderStarted=event();this.partialRenderFinished=event();this.postRenderFinished=event();this.uiFacade=Object.create(facadePrototype);}}
  if(!inherited)Object.defineProperty(Api.prototype,'renderScore',Object.getOwnPropertyDescriptor(Base.prototype,'renderScore'));
  return {Api,calls,result,failure,facadePrototype};
}

test('publicApiObserverForwardsActualReceiverAndCopiesCurrentGeneration',async()=>{
  const o=await observer(),fake=fakeWindow(),{Api,calls,result,failure}=apiClass();await serialized(o.installScoreLayoutIpcObserver,fake.window);await apiInstall(o,fake.window,Api);
  assert.equal(serialized(o.readScoreLayoutEvidence,fake.window).capable,false);
  const api=new Api(),score={},tracks=[0,1];assert.equal(api.renderScore(score,tracks),result);assert.equal(calls[0].receiver,api);assert.equal(calls[0].args[0],score);assert.equal(calls[0].args[1],tracks);assert.equal(fake.window.__scoreLayoutAcceptance.publicApi,api);
  api.partialRenderFinished.emit({id:'opaque-a',x:0,y:25,width:500,height:120,firstMasterBarIndex:0,lastMasterBarIndex:2,renderResult:'<svg>ink</svg>'});api.postRenderFinished.emit();
  assert.equal(api.uiFacade.highlightElements('opaque group',2),result);assert.equal(api.uiFacade.removeHighlights(),result);
  let e=serialized(o.readScoreLayoutEvidence,fake.window);assert.equal(e.capable,true);assert.equal(e.generation,1);assert.equal(e.completedGeneration,1);assert.deepEqual(e.chunks,[{generation:1,id:'opaque-a',x:0,y:25,width:500,height:120,firstMasterBarIndex:0,lastMasterBarIndex:2,svg:'<svg>ink</svg>'}]);assert.deepEqual(e.highlights,[{generation:1,kind:'highlight',groupId:'opaque group',masterBarIndex:2},{generation:1,kind:'remove'}]);assert.ok(!('publicApi'in e));
  e.chunks[0].svg='mutated';assert.equal(serialized(o.readScoreLayoutEvidence,fake.window).chunks[0].svg,'<svg>ink</svg>');
  api.renderScore(score);e=serialized(o.readScoreLayoutEvidence,fake.window);assert.equal(e.generation,2);assert.equal(e.completedGeneration,null);assert.deepEqual(e.chunks,[]);assert.deepEqual(e.highlights,[]);assert.equal(api.renderStarted.size,1);
  assert.throws(()=>api.renderScore(failure),error=>error===failure);serialized(o.disposeScoreLayoutObservers,fake.window);assert.equal(api.renderStarted.size,0);assert.equal(fake.window.__scoreLayoutAcceptance.publicApi,null);
});

test('disposePreservesLaterOwnersAndDescriptors',async()=>{
  const o=await observer();
  for(const inherited of [false,true]){
    const fake=fakeWindow(),{Api}=apiClass(inherited),descriptor=Object.getOwnPropertyDescriptor(Api.prototype,'renderScore'),fetchDescriptor=Object.getOwnPropertyDescriptor(fake.window,'fetch');
    await apiInstall(o,fake.window,Api);await serialized(o.installScoreLayoutIpcObserver,fake.window);const api=new Api();api.renderScore({});const facade=api.uiFacade;
    assert.deepEqual(serialized(o.disposeScoreLayoutObservers,fake.window),{restored:true,released:true});assert.deepEqual(Object.getOwnPropertyDescriptor(Api.prototype,'renderScore'),descriptor);assert.deepEqual(Object.getOwnPropertyDescriptor(fake.window,'fetch'),fetchDescriptor);assert.equal(Object.hasOwn(facade,'highlightElements'),false);assert.deepEqual(serialized(o.disposeScoreLayoutObservers,fake.window),{restored:true,released:true});
  }
  const fake=fakeWindow(),{Api}=apiClass();await apiInstall(o,fake.window,Api);await serialized(o.installScoreLayoutIpcObserver,fake.window);const api=new Api();api.renderScore({});
  const render=Api.prototype.renderScore,fetch=fake.window.fetch,highlight=api.uiFacade.highlightElements;
  const laterRender=function(...args){return render.apply(this,args);},laterFetch=function(...args){return fetch.apply(this,args);},laterHighlight=function(...args){return highlight.apply(this,args);};
  Api.prototype.renderScore=laterRender;fake.window.fetch=laterFetch;api.uiFacade.highlightElements=laterHighlight;
  assert.deepEqual(serialized(o.disposeScoreLayoutObservers,fake.window),{restored:false,released:true});assert.equal(Api.prototype.renderScore,laterRender);assert.equal(fake.window.fetch,laterFetch);assert.equal(api.uiFacade.highlightElements,laterHighlight);assert.equal(api.renderStarted.size,0);api.renderScore({});assert.equal(fake.window.__scoreLayoutAcceptance.publicApi,null);
});
