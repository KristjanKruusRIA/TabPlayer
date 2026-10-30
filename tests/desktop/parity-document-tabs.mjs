import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {isAbsolute,relative,resolve} from 'node:path';
import {connect,directory,launch,stop} from './harness.mjs';
import {readDocumentRecord} from './document-context.mjs';
import {buildDocumentTabsFixtures,assertFixtureHashes,documentTabsDirectory,sha256} from './document-tabs-fixture.mjs';

// Execution belongs to root. One isolated harness app on CDP 9223 and one
// existing loopback helper at a time; no browser clock drives native transport.
assert.equal(resolve(directory),documentTabsDirectory,'Run from the repository root');
const fixture=buildDocumentTabsFixtures(),output=name=>resolve(directory,`${fixture.prefix}-${name}`);
const executable=realpathSync(resolve(directory,'tabplayer.exe'));
const helper=realpathSync(resolve('src-tauri/target/debug/examples/capture_loopback.exe'));
const helperRelative=relative(realpathSync('.'),helper);
assert.ok(!isAbsolute(helperRelative)&&!helperRelative.startsWith('..'),'Use the existing workspace capture helper');
const result={authored:true,fixture:fixture.metadataPath,inputs:fixture.hashes,checks:{},captures:[],screenshots:[],outputs:{},limits:[...fixture.limits,'Windows acceptance only. This script cannot establish macOS/Linux audio or forced-crash recovery.','Normal Save picker cancellation is tested through production save_project IPC; it is separate from diagnostic Close All Save.'],originalGp8RuntimeAcceptance:false};
const audioCaptureRequested=process.env.TABPLAYER_TABS_UI_ONLY!=='1';
result.audioCapture={requested:audioCaptureRequested,completed:false};
if(!audioCaptureRequested)result.limits.push('UI-only execution: no physical audio capture was performed in this run.');
const visualCaptureRequested=process.env.TABPLAYER_TABS_SKIP_VISUALS!=='1';
result.visualCapture={requested:visualCaptureRequested,completed:false};
if(!visualCaptureRequested)result.limits.push('Functional retry: the previously accepted visual batch was not repeated in this run.');
const errors=[],children=new Set();let id=null,browser=null,page=null,A,B;
const invoke=(command,args={})=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
const workspace=()=>invoke('workspace_snapshot');
const status=()=>invoke('audio_status');
const address=record=>({documentId:record.documentId,revision:record.revision});
const record=documentId=>readDocumentRecord(page,documentId);
const idle=async()=>{await waitForWorkspaceIdle(page,{timeout:15000});await page.waitForFunction(()=>document.querySelector('[role="tablist"]')?.getAttribute('aria-busy')==='false',undefined,{timeout:15000});};
async function button(name){await clickWorkstationButton(page,name,{waitForIdle:false});await idle();}
async function waitStatus(predicate,timeout=15000){
  const deadline=Date.now()+timeout;let value;
  do{value=await status();if(value&&predicate(value))return value;await page.waitForTimeout(25);}while(Date.now()<deadline);
  throw new Error(`Native status timeout: ${JSON.stringify(value)}`);
}
async function reject(command,args,pattern){const result=await page.evaluate(async([command,args])=>{try{await window.__TAURI_INTERNALS__.invoke(command,args);return {rejected:false};}catch(reason){return {rejected:true,reason};}},[command,args]);assert.equal(result.rejected,true,`Expected ${command} to reject`);assert.equal(typeof result.reason,'string');assert.match(result.reason,pattern);}
async function ready(){return waitStatus(value=>value.ready&&!value.error);}
async function stopped(){const value=await ready();assert.equal(value.playing,false);assert.equal(value.range,null);assert.equal(value.loop,null);return value;}
async function stopPlayback(){await button('Stop');await waitStatus(value=>!value.playing&&value.tick===0);}
async function closeApp(){
  const ownedBrowser=browser,ownedId=id;browser=null;page=null;
  try{if(ownedBrowser)await ownedBrowser.close();}finally{if(ownedId!==null){stop(ownedId);id=null;}}
}
async function start(exportPath=output('exports'),savePath=output('ui-save.tabplayer')){
  await closeApp();id=launch({TABPLAYER_TEST_OPEN:fixture.documents.A.projectPath,TABPLAYER_TEST_SAVE:savePath,TABPLAYER_TEST_BACKING:fixture.documents.A.backingPath,TABPLAYER_TEST_EXPORT:exportPath});
  browser=await connect();page=browser.contexts()[0].pages()[0];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1600,height:1100});
  const library=page.getByRole('dialog',{name:'Library',exact:true});
  if(await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor({timeout:5000}).then(()=>true,()=>false)){await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});}
  await waitForWorkspaceIdle(page);await idle();
}
async function reload(){await page.reload();await waitForWorkspaceIdle(page);await idle();await ready();}
async function add(path){
  const intake=await invoke('desktop_test_io',{action:'read',path});assert.equal(intake.kind,'candidate');
  const value=await invoke('workspace_add',{token:intake.candidate.token});return value.active.documentId;
}
async function initialPair(){
  const blank=(await workspace()).documents[0];A=await add(fixture.documents.A.projectPath);B=await add(fixture.documents.B.projectPath);
  await invoke('workspace_close',{documents:[{...address(blank),discard:false}]});await reload();assert.equal((await workspace()).documents.length,2);
}
const tab=documentId=>page.locator(`#document-tab-${documentId}`);
async function activate(documentId){await tab(documentId).click();await idle();assert.equal((await workspace()).active.documentId,documentId);return stopped();}
async function location(measure,beat=1){await button('Edit');await page.getByLabel('Measure',{exact:true}).fill(String(measure));await page.getByLabel('Beat',{exact:true}).fill(String(beat));await page.getByLabel('Editing location',{exact:true}).filter({hasText:`Measure ${measure} · Beat ${beat}`}).waitFor();}
async function view(name){const value=fixture.view[name];await location(value.measure,value.beat);await page.getByLabel('Zoom (%)',{exact:true}).fill(String(value.zoom));await page.getByRole('combobox',{name:/^Displayed tracks/}).selectOption(value.display);}
async function assertView(name){const value=fixture.view[name];assert.equal(await page.getByLabel('Measure',{exact:true}).inputValue(),String(value.measure));assert.equal(await page.getByLabel('Beat',{exact:true}).inputValue(),String(value.beat));assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),String(value.zoom));assert.equal(await page.getByRole('combobox',{name:/^Displayed tracks/}).inputValue(),value.display);}
async function note(fret){await page.getByRole('combobox',{name:/^String/}).selectOption('5');await page.getByLabel('Fret',{exact:true}).fill(String(fret));await button('Set note');}
async function disclosure(label){const summary=page.locator('summary').filter({hasText:new RegExp(`^${label}$`)}).first();if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();}
function ownedProcess(pid,path){
  execFileSync('powershell.exe',['-NoProfile','-Command','$p=Get-Process -Id $env:TABS_OWNED_PID -ErrorAction Stop; if(-not [string]::Equals($p.Path,$env:TABS_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase)){throw "Unexpected owned process"}'],{windowsHide:true,env:{...process.env,TABS_OWNED_PID:String(pid),TABS_OWNED_EXE:path}});
}
function answer(decision){ownedProcess(id,executable);const receipt=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','tests/desktop/answer-unsaved-dialog.ps1','-AppProcessId',String(id),'-AppExecutable',executable,'-Decision',decision],{encoding:'utf8',windowsHide:true,timeout:15000});return receipt.trim();}
function cancelPicker(){ownedProcess(id,executable);return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','tests/desktop/cancel-dialog.ps1','-AppProcessId',String(id)],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();}
async function closeDecisions(label,decisions){
  await clickWorkspaceCommand(page,label,{waitForIdle:false});
  const receipts=decisions.map(answer);await idle();return receipts;
}
function hashOutput(path){result.outputs[path]=sha256(readFileSync(path));}

// The capture process pattern is the existing parity-selection-playback.mjs
// bounded output-loopback pattern. The score/backing frequency assertions below
// are independently specified by this fixture rather than production plans.
function terminateCapture(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  ownedProcess(child.pid,helper);
  execFileSync('powershell.exe',['-NoProfile','-Command','$p=Get-Process -Id $env:TABS_OWNED_PID -ErrorAction Stop; if(-not [string]::Equals($p.Path,$env:TABS_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase)){throw "Unexpected capture process"}; Stop-Process -Id $p.Id; $null=$p.WaitForExit(5000)'],{windowsHide:true,env:{...process.env,TABS_OWNED_PID:String(child.pid),TABS_OWNED_EXE:helper}});
}
function readWave(path){
  const bytes=readFileSync(path);assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');let cursor=12,rate,channels,bits,format,data;
  while(cursor+8<=bytes.length){const tag=bytes.toString('ascii',cursor,cursor+4),size=bytes.readUInt32LE(cursor+4),start=cursor+8;assert.ok(start+size<=bytes.length);if(tag==='fmt '){format=bytes.readUInt16LE(start);channels=bytes.readUInt16LE(start+2);rate=bytes.readUInt32LE(start+4);bits=bytes.readUInt16LE(start+14);if(format===65534){assert.equal(bytes.subarray(start+24,start+40).toString('hex'),'0300000000001000800000aa00389b71');format=3;}}if(tag==='data')data=bytes.subarray(start,start+size);cursor=start+size+(size&1);}
  assert.equal(format,3);assert.equal(bits,32);assert.equal(channels,2);assert.ok(rate&&data);const samples=Array.from({length:data.length/8},(_,index)=>(data.readFloatLE(index*8)+data.readFloatLE(index*8+4))/2);assert.ok(samples.every(Number.isFinite));
  const rms=(left,right)=>{const part=samples.slice(Math.floor(left*rate),Math.floor(right*rate));assert.ok(part.length);return Math.sqrt(part.reduce((sum,sample)=>sum+sample*sample,0)/part.length);};
  const band=(hz,left=.5,right=2.5)=>{const first=Math.floor(left*rate),last=Math.floor(right*rate);assert.ok(last<=samples.length);let real=0,imaginary=0,total=0;for(let frame=first;frame<last;frame++){const w=.5-.5*Math.cos(2*Math.PI*(frame-first)/(last-first-1)),angle=2*Math.PI*hz*frame/rate;real+=samples[frame]*w*Math.cos(angle);imaginary+=samples[frame]*w*Math.sin(angle);total+=w;}return 2*Math.hypot(real,imaginary)/total;};
  return {rate,frames:samples.length,rms,band};
}
async function capture(name,action=async()=>{}){
  const path=output(`${name}.wav`),deviceId=(await status()).deviceId;assert.ok(deviceId);
  const child=spawn(helper,[path,deviceId],{windowsHide:true});children.add(child);let log='',readyRecord;
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Loopback ${name} exited ${code}: ${log}`)));});void done.catch(()=>{});
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Loopback did not become ready: ${log}`)),6000);child.stdout.on('data',chunk=>{log+=chunk.toString();for(const line of log.split(/\r?\n/)){try{const value=JSON.parse(line);if(value.ready){readyRecord=value;clearTimeout(timer);resolve();}}catch{}}});child.stderr.on('data',chunk=>{log+=chunk.toString();});done.catch(error=>{clearTimeout(timer);reject(error);});});
    await action();await Promise.race([done,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`Loopback ${name} exceeded 10 seconds`)),10000);void done.finally(()=>clearTimeout(timer)).catch(()=>{});})]);
    const metrics=JSON.parse(readFileSync(path.replace(/\.wav$/,'.json'),'utf8')),wave=readWave(path);assert.equal(metrics.deviceId,deviceId);assert.equal(metrics.sampleRate,readyRecord.sampleRate);assert.equal(wave.rate,metrics.sampleRate);assert.equal(metrics.finite,true);assert.ok(metrics.durationSeconds>2.5&&metrics.durationSeconds<3.5);assert.equal(wave.frames,metrics.frames);
    writeFileSync(output(`${name}-capture.log`),log,{flag:'wx'});result.captures.push({name,path,sha256:sha256(readFileSync(path)),metrics});return wave;
  }finally{terminateCapture(child);children.delete(child);}
}
async function physical(name){
  const own=fixture.documents[name],other=fixture.documents[name==='A'?'B':'A'];
  const wave=await capture(`physical-${name}-${result.captures.length}`,async()=>{await button('Play');await waitStatus(value=>value.playing&&value.tick>0);});
  const scoreBand=hz=>Math.max(...Array.from({length:12},(_,index)=>wave.band(hz,.4+index*.15,.55+index*.15)));
  const bands={score:scoreBand(own.scoreHz),otherScore:scoreBand(other.scoreHz),backing:wave.band(own.frequencyHz),otherBacking:wave.band(other.frequencyHz)};
  assert.ok(bands.score>.00003,`Literal MIDI ${own.key} must be physically present: ${JSON.stringify(bands)}`);assert.ok(bands.backing>.0001);assert.ok(bands.otherScore<bands.score*.15,JSON.stringify(bands));assert.ok(bands.otherBacking<bands.backing*.1,JSON.stringify(bands));
  result.checks[`physical-${name}-${result.captures.length}`]={literalMidi:own.key,scoreHz:own.scoreHz,backingHz:own.frequencyHz,bands};
}
async function screenshotBatch(){
  for(const width of [960,1280,1600]){
    await page.setViewportSize({width,height:1100});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    const geometry=await page.evaluate(()=>{const bounds=selector=>{const rect=document.querySelector(selector)?.getBoundingClientRect();return rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null;};const tabs=document.querySelector('[role="tablist"]');return {tracks:bounds('.tracks'),score:bounds('.score-workspace'),inspector:bounds('.inspector'),tabs:{client:tabs.clientWidth,scroll:tabs.scrollWidth},bodyWidth:document.body.scrollWidth,viewport:innerWidth,instrument:!!document.querySelector('.instrument-view')};});
    assert.ok(geometry.tracks.x<geometry.score.x&&geometry.score.x<geometry.inspector.x);assert.ok(geometry.instrument);assert.ok(geometry.bodyWidth<=width+1,'Tab overflow must remain inside its horizontal strip');
    const path=output(`tabs-${width}.png`);await page.screenshot({path});result.screenshots.push({path,width,sha256:sha256(readFileSync(path)),geometry});
  }
  assert.ok(result.screenshots[0].geometry.tabs.scroll>result.screenshots[0].geometry.tabs.client,'Long duplicate titles exercise overflow');
}

async function staleOwner(){
  await activate(A);const first=(await workspace()).active;await activate(B);await activate(A);const current=(await workspace()).active;assert.notEqual(current.activationId,first.activationId);
  const before=await status(),generation=Math.max(before.generation,before.desiredGeneration??0)+100;
  // Delayed first-A owner with a reserved future generation must reject before
  // touching generation atomics, including the lock-bypassing Invalidate path.
  for(const command of [{type:'invalidate',generation},{type:'seekTick',generation,tick:3840},{type:'play',generation}])await reject('audio_command',{owner:first,command},/owner/i);
  await reject('audio_prepare',{owner:first,plan:{generation,ppq:960,durationTick:3840,durationMs:2000,tracks:[],tempos:[{tick:0,bpm:120}],occurrences:[{bar:0,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:0,endTick:3840,startMs:0,endMs:2000}],notes:[],midi:[]},settings:emptySettings(),embeddedBytes:null,sourceKey:'stale-A',practice:null},/owner/i);
  await reject('audio_set_mix',{owner:first,settings:emptySettings(),generation},/owner/i);
  const after=await status();assert.equal(after.generation,before.generation);assert.equal(after.desiredGeneration,before.desiredGeneration);assert.equal(after.playing,false);assert.equal(after.tick,before.tick);result.checks.staleABA={first,current,before,after,reservedGeneration:generation};
}
function emptySettings(){return {sounds:{},mixes:{},backing:null,print:{paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'ScoreTab'},engraving:{stylesheet:{hideDynamics:null,brackets:'inherit',extendBarLines:null,systemSeparators:null,tuning:null,chords:'inherit',singleNames:'inherit',multiNames:'inherit',firstNames:'inherit',otherNames:'inherit',firstNameDirection:'inherit',otherNameDirection:'inherit',barNumbers:'inherit',multiRests:'inherit',hideEmptyStaves:null,hideEmptyFirstSystem:null,singleStaffBrackets:null},notation:{tabRhythm:'inherit',fingering:'inherit',smallGraceTab:null,extendBendArrows:null,extendLineEffects:null,parenthesizeTiedBends:null,showTiedBendNumbers:null,showDiveWhammyZeros:null},systemSpacing:null,profiles:[]},page:null};}

async function exportFormat(format){
  const before=await record(A);await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.waitFor({state:'visible'});await dialog.getByRole('combobox',{name:/^Export format/}).selectOption(format);
  if(format==='wav'||format==='stems'){await dialog.getByLabel('Effect tail (seconds)',{exact:true}).fill('0.1');await dialog.getByLabel('Measure range',{exact:true}).check();await dialog.getByLabel('First measure',{exact:true}).fill('1');await dialog.getByLabel('Last measure',{exact:true}).fill('2');}
  await dialog.getByRole('button',{name:'Export',exact:true}).click();const deadline=Date.now()+60000;
  while(await dialog.isVisible()){
    assert.ok(Date.now()<deadline,`${format} export exceeded 60 seconds`);const alerts=dialog.getByRole('alert');if(await alerts.count())throw new Error(await alerts.innerText());
    const progress=dialog.getByRole('progressbar',{name:'Export progress'});if(await progress.count()){const jobId=await progress.getAttribute('data-job-id');if(jobId){const progressValue=await invoke('export_status',{documentId:A,id:jobId});assert.notEqual(progressValue?.status,'failed',progressValue?.error);}}
    await page.waitForTimeout(50);
  }
  await idle();
  const path=format==='stems'?output('exports'):output(`exports.${format==='midi'?'mid':format}`);assert.ok(existsSync(path));
  if(format==='stems'){const manifest=JSON.parse(readFileSync(resolve(path,'manifest.json'),'utf8'));assert.ok(manifest.frames>0);assert.ok(manifest.tracks.length>=2);for(const track of manifest.tracks){assert.equal(/[\\/]/.test(track.filename),false);hashOutput(resolve(path,track.filename));}hashOutput(resolve(path,'manifest.json'));}
  else {const bytes=readFileSync(path);assert.equal(bytes.subarray(0,format==='pdf'?5:4).toString('ascii'),{midi:'MThd',pdf:'%PDF-',wav:'RIFF',gp:'PK\x03\x04'}[format]);hashOutput(path);}
  assert.deepEqual(await record(A),before);result.checks[`export-${format}`]={document:address(before),path};
}
async function exportBusyCancel(){
  await activate(A);
  const source=await record(A),other=await record(B),durationTick=960*2*600;
  const plan={generation:1,ppq:960,durationTick,durationMs:600000,tracks:[{id:'literal',program:25,percussion:false}],tempos:[{tick:0,bpm:120}],occurrences:[{bar:0,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:0,endTick:durationTick,startMs:0,endMs:600000}],notes:[{id:'literal-60',trackId:'literal',source:{target:{track:0,staff:0,bar:0,voice:0,beat:0},string:5},occurrence:0,startTick:0,endTick:durationTick,key:60,velocity:100,articulation:'picked',legatoFrom:null,pitch:[{tick:0,semitones:0}]}],midi:[]};
  const payload={document:address(source),plan,request:{tracks:[{id:'literal',name:'Literal A',preset:'gm',kind:'score'}],range:null,format:{sampleRate:48000,bitDepth:16},speed:1,metronome:false,tailSeconds:0,includeBacking:false,includeMix:true},settings:emptySettings(),embeddedBytes:null,stems:false};
  await activate(B);const inactiveBefore=await workspace();await reject('export_audio',payload,/^Select the originating score before exporting\.$/);assert.deepEqual(await workspace(),inactiveBefore);result.checks.inactiveExportOriginRejected=true;await activate(A);
  const jobId=await invoke('export_audio',payload);assert.ok(jobId);
  try{
    assert.equal((await invoke('export_status',{documentId:A,id:jobId}))?.status,'running','Bounded long offline render must remain running for busy checks');
    assert.equal(await invoke('export_status',{documentId:B,id:jobId}),null);await reject('cancel_export',{documentId:B,id:jobId},/^Export job is no longer active\.$/);
    await reject('workspace_activate',{documentId:B},/^Finish or cancel the current export before changing documents\.$/);
    await reject('desktop_test_io',{action:'export',documentId:A,revision:source.revision,path:output('busy.gp'),bytes:[1,2,3]},/^Finish or cancel the current export first\.$/);
    await reject('export_audio',payload,/^An export is already running\.$/);
  }finally{await invoke('cancel_export',{documentId:A,id:jobId});}
  const deadline=Date.now()+15000;let value;
  do{value=await invoke('export_status',{documentId:A,id:jobId});if(value?.status!=='running')break;await page.waitForTimeout(25);}while(Date.now()<deadline);
  assert.equal(value?.status,'cancelled',JSON.stringify(value));assert.deepEqual(await record(A),source);assert.deepEqual(await record(B),other);result.checks.exportBusyCancel={document:address(source),activeDocumentId:A,jobId,terminal:value};
}

try{
  await start();await initialPair();await activate(A);await button('Import backing');await ready();assert.ok((await record(A)).snapshot.project.assets[fixture.documents.A.backingHash]);
  await button('Undo');const redoA=await record(A);assert.equal(redoA.snapshot.canRedo,true);assert.equal(redoA.snapshot.redoEdit.backing.assetId,fixture.documents.A.backingHash);
  await activate(B);await activate(A);assert.deepEqual(await record(A),redoA);await button('Redo');await ready();
  if(audioCaptureRequested){await location(1);await physical('A');await activate(B);const silenceB=await capture('switch-A-to-B-stopped');assert.ok(silenceB.rms(.5,2.5)<.00015);await location(1);await physical('B');await activate(A);const silenceA=await capture('reactivate-A-stopped');assert.ok(silenceA.rms(.5,2.5)<.00015);await location(1);await physical('A');await stopPlayback();result.checks.stoppedTransitionsNoAutoplay=true;result.audioCapture.completed=true;}
  await view('A');await button('Show instrument');await note(3);const editedA=await record(A);assert.equal(editedA.snapshot.dirty,true);
  await activate(B);await view('B');await note(10);const editedB=await record(B);assert.equal(editedB.snapshot.dirty,true);await activate(A);await assertView('A');assert.deepEqual(await record(A),editedA);
  await button('Undo');assert.equal((await record(A)).snapshot.canRedo,true);assert.deepEqual(await record(B),editedB);await button('Redo');await activate(B);await assertView('B');await activate(A);await assertView('A');result.checks.dirtyHistoryViewIsolation=true;
  await activate(B);const beforeDuplicate=await workspace();const intake=await invoke('desktop_test_io',{action:'read',path:fixture.documents.A.projectPath.toUpperCase()});assert.deepEqual(intake,{kind:'existing',documentId:A});assert.deepEqual(await workspace(),beforeDuplicate);await button('Open');assert.equal((await workspace()).active.documentId,A);assert.equal((await workspace()).documents.length,2);for(const entry of beforeDuplicate.documents)assert.deepEqual(await record(entry.documentId),entry);await assertView('A');result.checks.dirtyNativeAliasIntake=true;
  // Cross-document clip stays in the workspace store. Select/copy a phrase in
  // A through keyboard handlers; paste through B's current mounted editor.
  await location(2,1);const score=page.getByRole('region',{name:'Score workspace'});await score.focus();await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Control+c');await idle();await activate(B);await button('Track 2: Silent second guitar');await location(4,1);const beforePaste=await record(B);await page.getByRole('region',{name:'Score workspace'}).focus();await page.keyboard.press('Control+v');await idle();const pasted=await record(B);assert.equal(pasted.snapshot.project.edits.at(-1).type,'pasteMusic');assert.equal(pasted.snapshot.project.edits.at(-1).options.target.track,1);assert.ok(pasted.snapshot.project.edits.length>beforePaste.snapshot.project.edits.length);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);const untouchedA=await record(A);await button('Undo');assert.deepEqual((await record(B)).snapshot.project,beforePaste.snapshot.project);assert.deepEqual(await record(A),untouchedA);await button('Redo');result.checks.crossDocumentClipboard=true;
  const overflowIds=[];for(const path of fixture.overflowPaths)overflowIds.push(await add(path));await reload();
  await activate(A);await view('A');await button('Show instrument');if(visualCaptureRequested){await screenshotBatch();result.visualCapture.completed=true;}
  // Keyboard roving focus alone must not activate. Enter and Ctrl+Tab activate
  // through normal UI paths and keep a single associated tabpanel.
  await tab(A).focus();await page.keyboard.press('ArrowRight');assert.equal((await workspace()).active.documentId,A);await page.keyboard.press('Enter');await idle();assert.equal((await workspace()).active.documentId,B);await page.keyboard.press('Control+Shift+Tab');await idle();assert.equal((await workspace()).active.documentId,A);assert.equal(await page.getByRole('tabpanel').count(),1);assert.equal(await tab(A).getAttribute('aria-controls'),await page.getByRole('tabpanel').getAttribute('id'));result.checks.keyboardAndPanel=true;
  await invoke('workspace_close',{documents:await Promise.all(overflowIds.map(async documentId=>({...address(await record(documentId)),discard:false})))});await reload();
  await staleOwner();
  const beforeSaveB=await record(B),savedA=output('A-saved.tabplayer'),aBeforeSave=await record(A);
  await activate(B);const saveReceipt=await invoke('desktop_test_io',{action:'save',...address(aBeforeSave),path:savedA});assert.equal(saveReceipt.documentId,A);assert.equal(saveReceipt.snapshot.dirty,false);assert.deepEqual(await record(B),beforeSaveB);const savedAData=JSON.parse(readFileSync(savedA,'utf8'));assert.equal(sha256(Buffer.from(savedAData.base.bytesBase64,'base64')),fixture.documents.A.sourceHash);assert.equal(sha256(Buffer.from(savedAData.assets[fixture.documents.A.backingHash].bytesBase64,'base64')),fixture.documents.A.backingHash);hashOutput(savedA);result.checks.inactiveBoundSave={document:address(aBeforeSave),path:savedA};await reload();
  const guardBefore=await workspace();await reject('desktop_test_io',{action:'save',...address(await record(A)),path:fixture.documents.B.projectPath},/destination|another|open|preserve/i);assert.deepEqual(await workspace(),guardBefore);
  await activate(A);await button('Undo');const beforeRedoSave=await record(A);const compact=output('A-with-redo.tabplayer');await invoke('desktop_test_io',{action:'save',...address(beforeRedoSave),path:compact});const disk=JSON.parse(readFileSync(compact,'utf8'));assert.equal(disk.edits.length,beforeRedoSave.snapshot.project.edits.length);assert.equal((await record(A)).snapshot.canRedo,true);hashOutput(compact);await reload();await button('Redo');
  // Undo all the way to the backing import, preserving its redo-only asset.
  while((await record(A)).snapshot.project.edits.length>0)await button('Undo');const redoOnly=await record(A);assert.equal(redoOnly.snapshot.redoEdit.type,'setBacking');
  await activate(B);const beforeBackingGuard=await workspace();await reject('desktop_test_io',{action:'save',...address(await record(B)),path:fixture.documents.A.backingAlias},/destination|preserve/i);assert.deepEqual(await workspace(),beforeBackingGuard);result.checks.inactiveNativeAndRedoBackingProtection=true;
  const noRedo=output('A-redo-only-saved.tabplayer');await invoke('desktop_test_io',{action:'save',...address(redoOnly),path:noRedo});const noRedoDisk=JSON.parse(readFileSync(noRedo,'utf8'));assert.deepEqual(noRedoDisk.edits,[]);assert.deepEqual(noRedoDisk.assets,{});hashOutput(noRedo);assert.equal((await record(A)).snapshot.canRedo,true);
  await reload();await activate(A);await button('Redo');await ready();
  // Explicit production Save As still opens the real native picker in the test
  // build. Cancellation must leave the addressed native record unchanged.
  const beforeCancelSave=await record(A);await page.evaluate(document=>{window.__documentTabsPendingSave=window.__TAURI_INTERNALS__.invoke('save_project',{document,saveAs:true});},address(beforeCancelSave));const pickerReceipt=cancelPicker();assert.equal(await page.evaluate(()=>window.__documentTabsPendingSave),null);assert.deepEqual(await record(A),beforeCancelSave);result.checks.normalSavePickerCancel={document:address(beforeCancelSave),pickerReceipt};
  for(const format of ['midi','pdf','wav','stems','gp'])await exportFormat(format);
  await exportBusyCancel();
  // Discard A then Cancel B must leave every tab/history/view unchanged.
  await view('A');await note(4);await activate(B);await view('B');await note(11);const closeBefore=await workspace();const cancelled=await closeDecisions('Close all scores',['Discard','Cancel']);assert.deepEqual(await workspace(),closeBefore);await assertView('B');await activate(A);await assertView('A');result.checks.closeAllDiscardThenCancel={receipts:cancelled};
  // Save A then Cancel B retains both tabs while A's explicit save stays saved.
  const saveCancel=await closeDecisions('Close all scores',['Save','Cancel']);assert.equal((await record(A)).snapshot.dirty,false);assert.equal((await record(B)).snapshot.dirty,true);assert.equal((await workspace()).documents.length,2);result.checks.closeAllSaveThenCancel={receipts:saveCancel};hashOutput(output('ui-save.tabplayer'));
  await activate(B);const activeBeforeInactiveClose=(await workspace()).active;const inactiveLabel=await tab(A).getAttribute('aria-label');await page.getByRole('button',{name:`Close ${inactiveLabel}`,exact:true}).click();await idle();assert.deepEqual((await workspace()).active,activeBeforeInactiveClose);assert.equal((await workspace()).documents.length,1);result.checks.inactiveClose=true;
  result.checks.activeLastClose={receipts:await closeDecisions('Close score',['Discard'])};let blank=await workspace();assert.equal(blank.documents.length,1);assert.equal(blank.documents[0].snapshot.project.base.kind,'blank');assert.equal(blank.documents[0].snapshot.dirty,false);
  await note(5);result.checks.closeAllDiscard={receipts:await closeDecisions('Close all scores',['Discard'])};blank=await workspace();assert.equal(blank.documents.length,1);assert.equal(blank.documents[0].snapshot.dirty,false);
  assertFixtureHashes(fixture);
  // Reopen schema 1, ordinary schema 2 and compacted redo save in fresh native
  // processes after the harness force-stops its exact owned test PID. These
  // saved-file reopen checks establish no graceful-close or crash recovery.
  for(const [name,path,expected]of [['schema1',fixture.documents.A.schema1Path,null],['schema2',savedA,JSON.parse(readFileSync(savedA,'utf8'))],['redoCompacted',noRedo,noRedoDisk]]){
    await start(output(`reopen-${name}-export`),output(`reopen-${name}-save.tabplayer`));const opened=await add(path);await reload();const value=await record(opened);assert.equal(value.snapshot.project.schemaVersion,3);assert.deepEqual(value.snapshot.project.baselineEdits,[]);assert.equal(value.snapshot.project.base.sha256,fixture.documents.A.sourceHash);assert.equal(value.snapshot.dirty,false);assert.equal(value.snapshot.canRedo,false);
    if(expected)assert.deepEqual(value.snapshot.project.edits,expected.edits);if(name==='redoCompacted')assert.deepEqual(value.snapshot.project.assets,{});result.checks[`freshProcess-${name}`]=value;
  }
  // Destination is an inactive B backing source. Production WAV export must
  // reject it while A is active, preserving both documents and original bytes.
  await start(fixture.documents.B.backingPath);await initialPair();await activate(A);const protectedBefore=await workspace();
  const nativeA=await record(A);await reject('export_audio',{document:address(nativeA),plan:{generation:1,ppq:960,durationTick:3840,durationMs:2000,tracks:[{id:'literal',program:25,percussion:false}],tempos:[{tick:0,bpm:120}],occurrences:[{bar:0,occurrence:0,meterNumerator:4,meterDenominator:4,startTick:0,endTick:3840,startMs:0,endMs:2000}],notes:[],midi:[]},request:{tracks:[{id:'literal',name:'Literal A',preset:'gm',kind:'score'}],range:null,format:{sampleRate:48000,bitDepth:16},speed:1,metronome:false,tailSeconds:0,includeBacking:false,includeMix:true},settings:emptySettings(),embeddedBytes:null,stems:false},/destination|preserve/i);assert.deepEqual(await workspace(),protectedBefore);result.checks.inactiveBackingExportProtection=true;
  assertFixtureHashes(fixture);assert.deepEqual(errors,[]);result.passed=true;writeFileSync(output('result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result,null,2));
}catch(error){result.passed=false;result.failure=String(error?.stack??error);if(page){try{result.last={workspace:await workspace(),audio:await status(),body:(await page.locator('body').innerText()).slice(-5000)};}catch(stateError){result.stateError=String(stateError);}}writeFileSync(output('failure.json'),JSON.stringify(result,null,2),{flag:'wx'});throw error;}
finally{for(const child of children)terminateCapture(child);await closeApp();assertFixtureHashes(fixture);}
