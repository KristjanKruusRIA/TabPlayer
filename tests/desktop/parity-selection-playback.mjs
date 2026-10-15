import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {isAbsolute,relative,resolve} from 'node:path';
import {connect,directory,launch,stop} from './harness.mjs';
import {buildSelectionFixtures,selectionDirectory,sha256} from './selection-playback-fixture.mjs';

// Root owns execution, the existing diagnostic build/CDP port and listening.
// No settings changes, model injection or extra native diagnostic commands.
assert.equal(resolve(directory),selectionDirectory,'Run from this script’s repository root');
const fixture=buildSelectionFixtures(),prefix=fixture.prefix,output=name=>resolve(directory,`${prefix}-${name}`);
const helper=resolve('src-tauri/target/debug/examples/capture_loopback.exe');
assert.ok(existsSync(helper),'Root must build the existing capture_loopback example before this smoke');
const workspace=realpathSync('.'),helperPath=realpathSync(helper),helperRelative=relative(workspace,helperPath);
assert.ok(!isAbsolute(helperRelative)&&!helperRelative.startsWith('..'),'Capture helper must be inside this workspace');
const errors=[],captures=new Set(),result={authored:true,fixture:fixture.metadataPath,sourceHashes:Object.fromEntries(Object.entries(fixture.fixtures).map(([name,value])=>[name,value.sha256])),screenshots:[],captures:[],checks:{},limits:[...fixture.limits],originalGp8RuntimeAcceptance:false};
let id=null,browser=null,page=null,owner=null,saved=output('saved.tabplayer');
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
const snapshot=()=>readActiveDocument(page);
const idle=()=>page.waitForFunction(()=>!document.querySelector('nav[aria-label="File and history"] button')?.disabled);
async function waitStatus(predicate,timeout=15000){
  const deadline=Date.now()+timeout;let value;
  do{value=await status();if(predicate(value))return value;await page.waitForTimeout(20);}while(Date.now()<deadline);
  throw new Error(`Native status timed out: ${JSON.stringify(value)}`);
}
async function button(name){await page.getByRole('button',{name,exact:true}).click();await idle();}
async function noAlerts(){assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);}
async function disclosure(label){const summary=page.locator('summary').filter({hasText:new RegExp(`^${label}$`)}).first();if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();}
async function close(){
  const ownedBrowser=browser,ownedId=id;browser=null;page=null;
  try{if(ownedBrowser)await ownedBrowser.close();}finally{if(ownedId!==null){stop(ownedId);id=null;}}
}
async function open(path){
  await close();id=launch({TABPLAYER_TEST_OPEN:path,TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_BACKING:fixture.backing.path});
  browser=await connect();page=browser.contexts()[0].pages()[0];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1600,height:1100});await page.getByRole('button',{name:'Open',exact:true}).waitFor();await button('Open');
  owner=(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'))).active;
  await waitStatus(value=>value.ready&&!value.error);await page.locator('[aria-label="Music notation"] svg').first().waitFor();await disclosure('Selected playback');await noAlerts();
}
async function cursor(measure,beat=1,voice=0){
  await button('Edit');await page.getByLabel('Measure',{exact:true}).fill(String(measure));await page.getByRole('combobox',{name:'Voice',exact:true}).selectOption(String(voice));await page.getByLabel('Beat',{exact:true}).fill(String(beat));
  await page.getByLabel('Editing location',{exact:true}).filter({hasText:`Measure ${measure} · Beat ${beat}`}).waitFor();
}
const workspaceRegion=()=>page.getByRole('region',{name:'Score workspace'});
async function selectTiePassage(occurrence=1){
  await cursor(1,2);await workspaceRegion().focus();await page.keyboard.press('Shift+ArrowRight');
  await page.getByLabel('Editing location',{exact:true}).filter({hasText:'Measure 1 · Beat 3'}).waitFor();
  assert.match(await page.locator('.inspector').innerText(),/2 notes · 2 beats/);
  const choices=page.getByRole('combobox',{name:'Selection occurrence',exact:true});await choices.selectOption({label:`Measure 1, occurrence ${occurrence} → measure 1, occurrence ${occurrence}`});
}
async function assertRange(startTick,endTick){
  const value=await waitStatus(value=>value.range?.startTick===startTick&&value.range?.endTick===endTick);
  const range=page.getByRole('status',{name:'Selected playback range'});await range.waitFor();
  await page.waitForFunction(([start,end])=>{const node=document.querySelector('[aria-label="Selected playback range"]');return Number(node?.getAttribute('data-start-tick'))===start&&Number(node?.getAttribute('data-end-tick'))===end;},[startTick,endTick]);
  return value;
}
async function stopPlayback(){await button('Stop');await waitStatus(value=>!value.playing&&value.tick===0&&value.range===null);}
async function picture(name,width=1600){await page.setViewportSize({width,height:1100});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});const path=output(`${name}-${width}.png`);await page.screenshot({path});result.screenshots.push(path);}
async function practice(mode,fields={},checks={}){
  await button('Practice');await disclosure('Practice settings');const panel=page.getByRole('region',{name:'Practice tools'});
  await panel.getByRole('combobox',{name:'Tempo mode',exact:true}).selectOption(mode);
  for(const [label,value]of Object.entries(fields))await panel.getByLabel(label,{exact:true}).fill(String(value));
  for(const [label,value]of Object.entries(checks))await panel.getByLabel(label,{exact:true}).setChecked(value);
  await panel.getByRole('button',{name:'Apply practice settings',exact:true}).click();
  return waitStatus(value=>value.practice.settings.tempo.kind===mode&&Object.entries(fields).every(([label,expected])=>label==='Count-in bars'?value.practice.settings.countIn.bars===expected:label==='Fixed tempo (BPM)'?value.practice.settings.tempo.bpm===expected:label==='Relative speed (%)'?Math.abs(value.practice.settings.tempo.ratio-expected/100)<1e-9:true));
}

function stopCapture(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  // PID reuse must never terminate anything except the exact owned executable.
  execFileSync('powershell.exe',['-NoProfile','-Command','$p=Get-Process -Id $env:SELECTION_CAPTURE_PID -ErrorAction SilentlyContinue; if($p){if($p.Path -ne $env:SELECTION_CAPTURE_EXE){throw "Unexpected selection capture process"}; Stop-Process -Id $p.Id; $null=$p.WaitForExit(5000)}'],{windowsHide:true,env:{...process.env,SELECTION_CAPTURE_PID:String(child.pid),SELECTION_CAPTURE_EXE:helperPath}});
}
async function capture(name){
  const path=output(`${name}.wav`),deviceId=(await status()).deviceId;assert.ok(deviceId);
  const child=spawn(helperPath,[path,deviceId],{windowsHide:true});captures.add(child);let log='',readyRecord;
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Capture ${name} failed (${code}): ${log}`)));});void done.catch(()=>{});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Capture ${name} did not become ready: ${log}`)),6000);
    child.stdout.on('data',bytes=>{log+=bytes.toString();for(const line of log.split(/\r?\n/)){try{const value=JSON.parse(line);if(value.ready){readyRecord=value;clearTimeout(timer);resolve();}}catch{}}});
    child.stderr.on('data',bytes=>{log+=bytes.toString();});child.once('error',error=>{clearTimeout(timer);reject(error);});done.catch(error=>{clearTimeout(timer);reject(error);});
  });
  return {async finish(){await done;captures.delete(child);writeFileSync(output(`${name}-capture.log`),log);const metrics=JSON.parse(readFileSync(path.replace(/\.wav$/,'.json'),'utf8'));
    assert.equal(metrics.deviceId,deviceId);assert.equal(metrics.sampleRate,readyRecord.sampleRate);assert.equal(metrics.finite,true);assert.ok(metrics.durationSeconds>2.5&&metrics.durationSeconds<3.5);assert.ok(metrics.peak>.001&&metrics.rms>.0001);
    const wave=readWave(path);assert.equal(wave.rate,metrics.sampleRate);assert.equal(wave.frames,metrics.frames);const evidence={name,path,sha256:sha256(readFileSync(path)),metrics};result.captures.push(evidence);return {...evidence,wave};}};
}
function readWave(path){
  const bytes=readFileSync(path);assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');let cursor=12,rate,channels,format,bits,data;
  while(cursor+8<=bytes.length){const tag=bytes.toString('ascii',cursor,cursor+4),length=bytes.readUInt32LE(cursor+4),start=cursor+8;assert.ok(start+length<=bytes.length);if(tag==='fmt '){format=bytes.readUInt16LE(start);channels=bytes.readUInt16LE(start+2);rate=bytes.readUInt32LE(start+4);bits=bytes.readUInt16LE(start+14);if(format===65534){assert.ok(length>=40);assert.equal(bytes.readUInt16LE(start+16),22);assert.equal(bytes.readUInt16LE(start+18),32);assert.equal(bytes.subarray(start+24,start+40).toString('hex'),'0300000000001000800000aa00389b71');format=3;}}if(tag==='data')data=bytes.subarray(start,start+length);cursor=start+length+(length%2);}
  assert.equal(format,3);assert.equal(bits,32);assert.equal(channels,2);assert.ok(rate>0&&data);const frames=data.length/8,samples=new Float32Array(frames);
  for(let index=0;index<frames;index++){const left=data.readFloatLE(index*8),right=data.readFloatLE(index*8+4);assert.ok(Number.isFinite(left)&&Number.isFinite(right));samples[index]=(left+right)/2;}
  const rms=(start,end)=>{const first=Math.max(0,Math.floor(start*rate)),last=Math.min(frames,Math.floor(end*rate));assert.ok(last>first);let sum=0;for(let frame=first;frame<last;frame++)sum+=samples[frame]**2;return Math.sqrt(sum/(last-first));};
  const band=(hz,start,end)=>{const first=Math.floor(start*rate),last=Math.min(frames,Math.floor(end*rate));assert.ok(last>first);let real=0,imag=0,weight=0;for(let frame=first;frame<last;frame++){const w=.5-.5*Math.cos(2*Math.PI*(frame-first)/(last-first-1)),angle=2*Math.PI*hz*frame/rate;real+=samples[frame]*w*Math.cos(angle);imag+=samples[frame]*w*Math.sin(angle);weight+=w;}return 2*Math.hypot(real,imag)/weight;};
  const onset=()=>{for(let start=0;start+.03<frames/rate;start+=.01)if(rms(start,start+.03)>.0001)return start;throw new Error('No sustained physical audio onset');};
  return {rate,frames,rms,band,onset};
}

try{
  await open(fixture.fixtures.main.path);const baseline=await snapshot();assert.deepEqual(baseline.project.edits,[]);assert.equal(baseline.project.base.sha256,fixture.fixtures.main.sha256);
  await button('Show instrument');const instrument=page.getByRole('region',{name:'Instrument view'});
  await cursor(1,2);assert.equal(await page.getByRole('button',{name:'Play',exact:true}).isDisabled(),true,'Repeated cursor requires an occurrence');
  await page.getByRole('combobox',{name:'Cursor occurrence',exact:true}).selectOption({label:'Measure 1, occurrence 2'});await button('Play');
  const second=await waitStatus(value=>value.playing&&value.tick>=8640&&value.tick<10000);assert.equal(second.range,null);assert.equal(second.loop,null);result.checks.cursorOccurrence2=second;await stopPlayback();

  const beforeSelection=await status();await selectTiePassage();const selected=await status();assert.equal(selected.tick,beforeSelection.tick);assert.equal(selected.playing,false);assert.equal(selected.range,null);assert.equal(selected.loop,null);assert.equal(selected.generation,beforeSelection.generation);assert.deepEqual(await snapshot(),baseline);
  await button('Loop selection');const armed=await waitStatus(value=>value.loop?.startTick===960&&value.loop?.endTick===2880);assert.equal(armed.playing,false);assert.equal(armed.range,null);
  await button('Play');await waitStatus(value=>value.playing&&value.practice.completedPasses>=1);await button('Pause');const loopPaused=await waitStatus(value=>!value.playing);await page.waitForTimeout(100);assert.equal((await status()).tick,loopPaused.tick);assert.deepEqual((await status()).loop,loopPaused.loop);
  await button('Play');await waitStatus(value=>value.playing&&value.loop?.startTick===960);await stopPlayback();assert.deepEqual((await status()).loop,{startTick:960,endTick:2880});await button('Clear loop');await waitStatus(value=>value.loop===null);result.checks.loopNoAutoplayPauseResume=true;

  await selectTiePassage();await button('Play selection');await assertRange(960,2880);await waitStatus(value=>value.playing&&value.tick>1100);await button('Pause');const paused=await waitStatus(value=>!value.playing);await page.waitForTimeout(120);assert.equal((await status()).tick,paused.tick);assert.deepEqual(paused.range,{startTick:960,endTick:2880});
  // Healthy reselect is an existing finite bridge action, not a diagnostic hook.
  await page.evaluate(({owner,value})=>window.__TAURI_INTERNALS__.invoke('audio_command',{owner,command:{type:'selectDevice',generation:value.generation,deviceId:value.deviceId}}),{owner,value:paused});
  const recreated=await waitStatus(value=>value.ready&&value.practice.phase==='paused');assert.equal(recreated.tick,paused.tick);assert.deepEqual(recreated.range,paused.range);await button('Play');
  const ended=await waitStatus(value=>!value.playing&&value.practice.phase==='ended');assert.equal(ended.tick,2880);assert.equal(ended.practice.completedPasses,0);assert.equal(ended.practice.countInRemaining,0);assert.equal(ended.practice.pulse,null);await page.waitForFunction(()=>document.querySelectorAll('.instrument-view g[data-note-id]').length===0);result.checks.finitePauseResumeHealthyDevice=ended;
  await stopPlayback();await selectTiePassage();const selectedCapture=await capture('one-shot');await button('Play selection');await assertRange(960,2880);await waitStatus(value=>value.practice.phase==='ended'&&value.tick===2880);const bounded=await selectedCapture.finish();
  assert.ok(bounded.wave.rms(.2,.7)>.0001);assert.ok(bounded.wave.rms(2.2,2.9)<.0001,'Physical output is quiet after finite cutoff; native tests establish exact callback frame exclusivity');result.checks.finitePcmSilence=true;

  await stopPlayback();await cursor(1,4);await page.getByRole('combobox',{name:'Cursor occurrence',exact:true}).selectOption({label:'Measure 1, occurrence 1'});const sentinelCapture=await capture('sentinel-positive-control');await button('Play from cursor');const sentinel=await sentinelCapture.finish();await stopPlayback();
  const sentinelHz=fixture.expected.sentinelHz,positiveOnset=sentinel.wave.onset(),boundedOnset=bounded.wave.onset();
  const positive=sentinel.wave.band(sentinelHz,positiveOnset+.05,positiveOnset+.25);
  assert.ok(positive>.00005,'Exclusive-end sentinel has a detectable physical positive control');
  const boundedBands=Array.from({length:9},(_,index)=>bounded.wave.band(sentinelHz,boundedOnset+.8+index*.1,boundedOnset+1+index*.1)),boundedMaximum=Math.max(...boundedBands);
  assert.ok(boundedMaximum<positive*.1,`Exclusive-end sentinel must be absent around the onset-aligned cutoff: ${boundedMaximum} versus positive control ${positive}`);
  result.checks.sentinelPositiveControl={sentinelHz,positiveOnset,boundedOnset,positive,boundedMaximum,ratio:boundedMaximum/positive,maximumRatio:.1};

  // Explicit Seek must win even though the canonical cursor points elsewhere.
  await cursor(1,2);await page.getByLabel('Seek measure',{exact:true}).fill('3');await button('Seek');await waitStatus(value=>value.tick===11520);assert.equal(await page.getByRole('button',{name:'Play',exact:true}).getAttribute('title'),'Play from transport position');await button('Play');await waitStatus(value=>value.playing&&value.tick>=11520&&value.tick<12500&&value.range===null);await stopPlayback();result.checks.explicitSeekPriority=true;

  await practice('fixed',{'Fixed tempo (BPM)':240,'Count-in bars':1,'Metronome volume (%)':0},{'Visual metronome':true,'Count in between loops':true});await selectTiePassage();await button('Play selection');const counting=await waitStatus(value=>value.practice.phase==='countIn');assert.equal(counting.tick,960);assert.deepEqual(counting.range,{startTick:960,endTick:2880});await button('Pause');const countPaused=await waitStatus(value=>value.practice.phase==='paused'&&value.practice.countInRemaining>0);await page.waitForTimeout(100);assert.equal((await status()).practice.countInRemaining,countPaused.practice.countInRemaining);await button('Play');await waitStatus(value=>value.practice.phase==='ended'&&value.tick===2880);assert.equal((await status()).practice.completedPasses,0);await stopPlayback();
  await button('Loop selection');await button('Play');const betweenLoops=await waitStatus(value=>value.practice.completedPasses===1&&value.practice.phase==='countIn');assert.equal(betweenLoops.tick,960);assert.equal(betweenLoops.range,null);assert.ok(betweenLoops.practice.countInRemaining>0);await stopPlayback();await button('Clear loop');result.checks.betweenLoopCount=true;
  await practice('progressive',{'Starting speed (%)':100,'Finishing speed (%)':150,'Increment (percentage points)':25,'Repetitions per speed':1,'Count-in bars':0},{'Count in between loops':false});await selectTiePassage();await button('Loop selection');const loopCapture=await capture('partial-loop');await button('Play');const wrapped=await waitStatus(value=>value.practice.completedPasses>=2);assert.ok(wrapped.practice.effectiveRatio>=1.25);const loopAudio=await loopCapture.finish();assert.ok(loopAudio.wave.rms(.2,2.5)>.0001);await button('Clear loop');const clearedRunning=await waitStatus(value=>value.loop===null);assert.equal(clearedRunning.playing,true);assert.equal(clearedRunning.range,null);await stopPlayback();result.checks.fixedCountAndProgressiveLoop=true;

  await practice('relative',{'Relative speed (%)':100,'Count-in bars':0});await selectTiePassage();await button('Play selection');await assertRange(960,2880);
  // The existing measure button reads Loop while only a finite range is active.
  // Exercise its native ClearLoop contract with the existing finite bridge API.
  await page.evaluate(({owner,generation})=>window.__TAURI_INTERNALS__.invoke('audio_command',{owner,command:{type:'clearLoop',generation}}),{owner,generation:(await status()).generation});
  await waitStatus(value=>value.range===null&&value.loop===null&&value.playing);await stopPlayback();
  await selectTiePassage();await button('Play selection');await assertRange(960,2880);await page.getByLabel('Seek measure',{exact:true}).fill('2');await button('Seek');await waitStatus(value=>value.range===null&&value.playing&&value.tick>=3840);await stopPlayback();result.checks.clearAndSeekRetireFiniteRange=true;

  // Score projection and actual pointer/keyboard selection stay canonical.
  await page.getByRole('combobox',{name:'Displayed tracks',exact:true}).selectOption('all');await page.getByLabel('Zoom (%)',{exact:true}).fill('115');await cursor(1,2);
  const fret=page.locator('[aria-label="Music notation"] svg text').filter({hasText:/^5$/}).first();await fret.scrollIntoViewIfNeeded();await fret.click();assert.match(await page.getByLabel('Editing location',{exact:true}).innerText(),/Selection guitar · Measure 1 · Beat 2/);
  await page.keyboard.press('Shift+ArrowRight');assert.match(await page.locator('.inspector').innerText(),/2 notes · 2 beats/);await page.getByRole('combobox',{name:'Selection occurrence',exact:true}).selectOption({label:'Measure 1, occurrence 2 → measure 1, occurrence 2'});await button('Play selection');await assertRange(8640,10560);await waitStatus(value=>value.practice.phase==='ended');await stopPlayback();result.checks.canonicalZoomAllTracksPointerAndShift=true;
  for(const width of [960,1280,1600])await picture('selected-playback-layout',width);

  // A display-only authored history entry must preserve the active native span.
  await selectTiePassage();await button('Play selection');await assertRange(960,2880);await button('Pause');const displayBefore=await waitStatus(value=>!value.playing);
  await button('Presentation');await disclosure('Engraving');await page.getByLabel('System spacing (%)',{exact:true}).fill('110');await button('Apply engraving');await noAlerts();assert.equal((await status()).generation,displayBefore.generation);assert.deepEqual((await status()).range,displayBefore.range);
  await button('Undo');assert.deepEqual((await status()).range,displayBefore.range);assert.equal((await status()).generation,displayBefore.generation);await button('Redo');assert.deepEqual((await status()).range,displayBefore.range);await stopPlayback();result.checks.presentationHistoryKeepsRange=true;
  const withPresentation=await snapshot();await cursor(2,1);await page.getByRole('combobox',{name:'String',exact:true}).selectOption('6');await page.getByLabel('Fret',{exact:true}).fill('9');await button('Set note');await waitStatus(value=>value.ready&&value.generation>displayBefore.generation&&value.range===null&&value.loop===null&&!value.playing);
  const afterEdit=await status();await button('Undo');await waitStatus(value=>value.ready&&value.generation>afterEdit.generation&&value.range===null);assert.deepEqual((await snapshot()).project,withPresentation.project);const afterUndo=await status();await button('Redo');await waitStatus(value=>value.ready&&value.generation>afterUndo.generation&&value.range===null);await button('Undo');await waitStatus(value=>value.ready&&!value.playing);result.checks.musicalHistoryInvalidatesGeneration=true;

  // Selection/transport alone must leave even the redo slot untouched.
  const historyBefore=await snapshot();await selectTiePassage();await button('Loop selection');await button('Clear loop');await button('Play selection');await waitStatus(value=>value.practice.phase==='ended');await stopPlayback();assert.deepEqual(await snapshot(),historyBefore);result.checks.transportPreservesFullHistory=true;
  await button('Import backing');await waitStatus(value=>value.ready&&value.backingDurationSeconds===12);const backed=await snapshot();const backingEdit=backed.project.edits.findLast(edit=>edit.type==='setBacking');assert.equal(backingEdit.backing.assetId,fixture.backing.sha256);assert.equal(backed.project.assets[backingEdit.backing.assetId].byteLength,readFileSync(fixture.backing.path).length);
  await selectTiePassage();const backingCapture=await capture('bounded-backing');await button('Play selection');await waitStatus(value=>value.practice.phase==='ended'&&value.tick===2880);const cutBacking=await backingCapture.finish();assert.ok(cutBacking.wave.rms(.2,.7)>.0001);assert.ok(cutBacking.wave.rms(2.2,2.9)<.0001);await stopPlayback();
  await cursor(3,4);const tailCapture=await capture('unbounded-backing-tail');await button('Play from cursor');const beyondScore=await waitStatus(value=>value.playing&&value.tick>15360&&value.range===null);const tail=await tailCapture.finish();assert.ok(tail.wave.rms(.7,2.5)>.0001,'Null cursor start retains the longer backing tail');await stopPlayback();result.checks.backingBoundedVsOrdinaryEof={beyondScore};

  await button('Save');const savedSnapshot=await snapshot(),stored=JSON.parse(readFileSync(saved,'utf8'));assert.equal(savedSnapshot.dirty,false);assert.deepEqual(stored.base,savedSnapshot.project.base);assert.deepEqual(stored.edits,savedSnapshot.project.edits);assert.equal(stored.schemaVersion,2);assert.equal(sha256(Buffer.from(stored.assets[backingEdit.backing.assetId].bytesBase64,'base64')),fixture.backing.sha256);const actualSaved=saved;
  saved=output('reopened-save.tabplayer');await open(actualSaved);assert.deepEqual((await snapshot()).project,savedSnapshot.project);assert.equal((await status()).range,null);assert.equal((await status()).loop,null);assert.equal((await status()).backingDurationSeconds,12);result.checks.nativeSaveRestartReopen=true;

  // Whole-track passage must include the first ending; second-pass starts that
  // would skip it are excluded. No hidden source beat is selected for simile.
  await open(fixture.fixtures.main.path);await button('Select track');assert.equal(await page.getByRole('combobox',{name:'Selection occurrence',exact:true}).locator('option').count(),2);await button('Loop selection');const completeRoute=await waitStatus(value=>value.loop?.startTick===0&&value.loop?.endTick===15360);assert.equal(completeRoute.playing,false);await button('Clear loop');result.checks.routeRequiresInternalEnding=true;
  await open(fixture.fixtures.grace.path);await cursor(3,1);await button('Select bar');await button('Loop selection');const simile=await waitStatus(value=>value.loop!==null);assert.equal(simile.playing,false);assert.ok(simile.loop.endTick>simile.loop.startTick);await picture('simile-whole-bar');result.checks.completeSimileBar=true;
  await open(fixture.fixtures.rhythm.path);await cursor(2,1);await workspaceRegion().focus();await page.keyboard.press('Shift+ArrowRight');await button('Loop selection');const swing=await waitStatus(value=>value.loop!==null);assert.deepEqual(swing.loop,{startTick:960,endTick:1920});assert.equal(swing.playing,false);result.checks.pickupAndSwingPartialLoop=true;
  await open(fixture.fixtures.directed.path);await cursor(1,1);assert.equal(await page.getByRole('combobox',{name:'Cursor occurrence',exact:true}).locator('option').count(),3);await page.getByRole('combobox',{name:'Cursor occurrence',exact:true}).selectOption({label:'Measure 1, occurrence 2'});await button('Play from cursor');await waitStatus(value=>value.playing&&value.tick>=15360);await stopPlayback();result.checks.directedOccurrence2=true;
  await button('New');await waitStatus(value=>value.ready&&value.range===null&&value.loop===null&&!value.playing);result.checks.newClearsPlayback=true;

  for(const source of Object.values(fixture.fixtures))assert.equal(sha256(readFileSync(source.path)),source.sha256);assert.equal(sha256(readFileSync(fixture.backing.path)),fixture.backing.sha256);assert.deepEqual(errors,[]);
  result.actualDeviceRates=[...new Set(result.captures.map(value=>value.metrics.sampleRate))];result.checks.sourceBytesUnchanged=true;result.pageErrors=errors;
  result.limits.push('Queue saturation/stale-generation rejection, device fault recovery, fractional same-tick event ceilings and exact 44.1/48 kHz sample counts require native tests; this UI smoke does not induce faults or flood commands.','No numeric endpoint editor exists for collapsed-simile subdivisions; their rejection is covered by pure resolver tests.','Sparse-note pointer toggles/drag resize and original GP8 target comparison remain separate acceptance work.','Screenshots require root inspection; scripts do not assert visual fidelity.');
  writeFileSync(output('result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){
  if(page){await page.screenshot({path:output('failure.png')}).catch(()=>{});const failure={error:String(error),status:await status().catch(()=>null),snapshot:await snapshot().catch(()=>null),body:await page.locator('body').innerText().catch(()=>null)};writeFileSync(output('failure.json'),JSON.stringify(failure,null,2));}
  throw error;
}finally{
  try{for(const child of captures)stopCapture(child);}finally{await close();}
}
