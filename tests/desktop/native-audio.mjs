import {waitForWorkspaceIdle,clickWorkstationButton,revealLeftTask,revealDock,revealPlaybackControls} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {launch,stop,connect,directory} from './harness.mjs';

mkdirSync(directory,{recursive:true});
const backing=join(directory,'native-authored-backing.wav'),saved=join(directory,'native-audio.tabplayer');
const movedBacking=join(directory,`native-authored-backing-${process.pid}-${Date.now()}.temporarily-unavailable.wav`);
const rate=48000,frames=rate*2,bytes=Buffer.alloc(44+frames*4);
bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
for(let frame=0;frame<frames;frame++){const tone=Math.round(Math.sin(frame/rate*440*Math.PI*2)*5000);bytes.writeInt16LE(tone,44+frame*4);bytes.writeInt16LE(tone,46+frame*4);}
writeFileSync(backing,bytes);
let id=launch({TABPLAYER_TEST_BACKING:backing,TABPLAYER_TEST_SAVE:saved}),browser,page,fixtureMoved=false;
const blockedExternal=[];
try {
  browser=await connect();page=browser.contexts()[0].pages()[0];
  const offlinePage=async()=>{
    await waitForWorkspaceIdle(page);
    page.on('pageerror',error=>console.log('Native audio page error:',error.message));
    await page.context().route('**/*',route=>{const url=new URL(route.request().url());if(['tauri.localhost','ipc.localhost','127.0.0.1','localhost'].includes(url.hostname)||['data:','blob:'].includes(url.protocol))return route.continue();blockedExternal.push(url.origin);return route.abort();});
    await page.addInitScript(()=>{
      window.__nativeAudioSmoke={webAudioSamples:0};
      const send=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(data,...args){if(data?.cmd==='alphaSynth.output.addSamples')window.__nativeAudioSmoke.webAudioSamples+=data.samples.length;return send.call(this,data,...args);};
    });
    await page.reload();
  };
  await offlinePage();
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const snapshot=()=>readActiveDocument(page);
  const idle=()=>waitForWorkspaceIdle(page);
  const waitStatus=async(predicate,timeout=10000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(25);}throw new Error(`Native status timed out: ${JSON.stringify(last)}`);};
  const ready=async()=>{await waitStatus(s=>s.ready&&!s.error);await page.waitForFunction(()=>{const play=Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Play');return play&&!play.matches(':disabled');});};
  const button=async(name)=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  await page.getByRole('combobox',{name:/^String/}).selectOption('6');await page.getByLabel('Fret',{exact:true}).fill('5');await button('Set note');await ready();
  await button('Show instrument');const instrument=page.getByRole('region',{name:'Instrument view'});await instrument.getByRole('img',{name:'Guitar fretboard'}).waitFor();assert.equal(await instrument.locator('g[data-note-id]').count(),0);
  const helper=resolve('src-tauri/target/debug/examples/capture_loopback.exe');if(!existsSync(helper))throw new Error('Build the capture_loopback Cargo example before this native smoke.');
  const capturedPath=join(directory,'native-app-loopback.wav');const readyDevice=await status();const capture=spawn(helper,[capturedPath,readyDevice.deviceId],{windowsHide:true});let captureLog='';
  const captureFinished=new Promise((resolve,reject)=>{capture.on('error',reject);capture.on('exit',code=>code===0?resolve():reject(new Error(`Loopback capture failed: ${code}; ${captureLog}`)));});
  void captureFinished.catch(()=>{});
  await new Promise((resolve,reject)=>{const until=setTimeout(()=>reject(new Error('Loopback capture did not become ready.')),5000);capture.stdout.on('data',bytes=>{captureLog+=bytes.toString();if(captureLog.includes('"ready":true')){clearTimeout(until);resolve();}});capture.stderr.on('data',bytes=>{captureLog+=bytes.toString();});capture.on('error',error=>{clearTimeout(until);reject(error);});});
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001);
  await instrument.locator('g[data-note-id][data-string="6"][data-fret="5"][data-key="69"]').waitFor({state:'visible'});
  const played=await status();assert.ok(played.deviceId);const cursor=page.locator('.at-cursor-beat').first();await cursor.waitFor({state:'visible'});const first=await cursor.boundingBox();
  await waitStatus(s=>s.seconds>.8);
  const later=await cursor.boundingBox();assert.ok(first&&later&&(first.x!==later.x||first.y!==later.y),'The native clock must move the public notation cursor.');
  await captureFinished;const captured=JSON.parse(readFileSync(capturedPath.replace(/\.wav$/,'.json'),'utf8'));assert.equal(captured.deviceId,played.deviceId);assert.equal(captured.finite,true);assert.ok(captured.peak>.001&&captured.rms>.0001);assert.ok(captured.durationSeconds>2.5&&captured.durationSeconds<3.5);assert.ok(captured.onsetFrame/captured.sampleRate<.5);assert.ok(Math.abs(captured.frequencyHz/440-1)<.03,`Captured A4 pitch: ${captured.frequencyHz}`);
  await revealLeftTask(page,'Sound');await page.getByRole('combobox',{name:/^Sound preset/}).selectOption('lead');await idle();assert.equal((await status()).generation,played.generation);assert.equal((await status()).playing,true);
  await revealDock(page,'Mixer');const mute=page.locator('.track-channel').first().getByLabel('Mute',{exact:true});
  const waitMute=checked=>page.waitForFunction(checked=>document.querySelector('.track-channel input[type="checkbox"]')?.checked===checked,checked);
  await mute.click();await waitMute(true);await idle();
  await button('Undo');await waitMute(false);assert.equal((await status()).generation,played.generation);assert.equal((await status()).playing,true);
  await button('Redo');await waitMute(true);assert.equal((await status()).generation,played.generation);
  await mute.click();await waitMute(false);await idle();await button('Pause');await waitStatus(s=>!s.playing);
  await revealDock(page,'Instrument');const paused=await status();await page.waitForTimeout(100);assert.equal((await status()).tick,paused.tick);
  await revealPlaybackControls(page);await page.getByLabel('Seek measure',{exact:true}).fill('1');await button('Seek');await waitStatus(s=>s.tick===0);await instrument.locator('g[data-note-id][data-key="69"]').waitFor({state:'visible'});
  await button('Play');await waitStatus(s=>s.playing);await button('Pause');await waitStatus(s=>!s.playing);
  const frozenMarks=await instrument.locator('g[data-note-id]').evaluateAll(nodes=>nodes.map(node=>[node.dataset.noteId,node.dataset.string,node.dataset.fret,node.dataset.key]));assert.ok(frozenMarks.length>0);await page.waitForTimeout(100);assert.deepEqual(await instrument.locator('g[data-note-id]').evaluateAll(nodes=>nodes.map(node=>[node.dataset.noteId,node.dataset.string,node.dataset.fret,node.dataset.key])),frozenMarks);
  const viewMode=instrument.getByRole('combobox',{name:/^Instrument view mode/});await viewMode.selectOption('keys');await instrument.locator('g[data-key="69"][data-active="true"]').waitFor({state:'visible'});await viewMode.selectOption('drums');await instrument.locator('[data-percussion-key="69"][data-active="true"]').waitFor({state:'visible'});await viewMode.selectOption('bass');await instrument.getByRole('img',{name:'Bass fretboard'}).waitFor();await viewMode.selectOption('auto');await instrument.getByRole('img',{name:'Guitar fretboard'}).waitFor();await instrument.screenshot({path:join(directory,'instrument-view.png')});
  await revealPlaybackControls(page);await page.getByLabel('Seek measure',{exact:true}).fill('4');await button('Seek');await waitStatus(s=>Math.abs(s.tick-11520)<.01);
  await button('Stop');await waitStatus(s=>!s.playing&&s.tick===0);await page.waitForFunction(()=>document.querySelectorAll('.instrument-view g[data-note-id]').length===0);
  await button('Add track');await ready();await button('Track 2: Bass');await instrument.getByRole('img',{name:'Bass fretboard'}).waitFor();assert.equal(await instrument.locator('[data-string-row]').count(),4);
  await page.getByRole('combobox',{name:/^String/}).selectOption('4');await page.getByLabel('Fret',{exact:true}).fill('2');await button('Set note');await ready();await button('Play');await waitStatus(s=>s.playing);await instrument.locator('g[data-note-id][data-string="4"][data-fret="2"][data-key="45"]').waitFor({state:'visible'});
  await button('Track 1: Guitar');await instrument.getByRole('img',{name:'Guitar fretboard'}).waitFor();assert.equal(await instrument.locator('[data-string-row]').count(),6);await button('Stop');await waitStatus(s=>!s.playing&&s.tick===0);await button('Track 2: Bass');await button('Remove track');await ready();await instrument.getByRole('img',{name:'Guitar fretboard'}).waitFor();
  await page.getByRole('combobox',{name:/^String/}).selectOption('6');await button('Hide instrument');assert.equal(await instrument.count(),0);
  await page.getByRole('combobox',{name:/^Speed/}).selectOption('50');await button('Loop');await button('Play');
  await waitStatus(s=>s.speed===.5&&s.tick>3600);
  await waitStatus(s=>s.playing&&s.tick<960);await button('Stop');await button('Clear loop');
  await page.getByLabel('Metronome',{exact:true}).click();await waitStatus(s=>s.metronome);
  await button('Play');await waitStatus(s=>s.playing);const beforeEdit=await status();await page.getByLabel('Fret',{exact:true}).fill('7');await button('Set note');await waitStatus(s=>s.generation>beforeEdit.generation);await ready();assert.equal((await status()).playing,false);assert.equal((await status()).speed,.5);assert.equal((await status()).metronome,true);
  for(const action of ['Undo','Redo']){await button(action);await ready();assert.equal((await status()).speed,.5);assert.equal((await status()).metronome,true);}
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001);await button('Stop');await waitStatus(s=>!s.playing&&s.tick===0);
  await button('Import backing');await waitStatus(s=>Math.abs(s.backingDurationSeconds-2)<.001);
  const withBacking=await snapshot();const setBacking=withBacking.project.edits.findLast(edit=>edit.type==='setBacking');assert.ok(setBacking.backing.assetId);const asset=withBacking.project.assets[setBacking.backing.assetId];assert.equal(asset.byteLength,bytes.length);assert.equal('bytesBase64' in asset,false);
  await button('Remove backing');await waitStatus(s=>s.backingDurationSeconds===null);
  await button('Undo');await waitStatus(s=>Math.abs(s.backingDurationSeconds-2)<.001);
  await button('Save');const savedSnapshot=await snapshot();assert.equal(savedSnapshot.dirty,false);assert.ok(existsSync(saved));
  assert.equal((await page.evaluate(()=>window.__nativeAudioSmoke)).webAudioSamples,0,'External media mode must never emit a second synthesizer stream.');
  await browser.close();browser=undefined;stop(id);id=null;
  const workspace=realpathSync(resolve('.')),fixtureDirectory=realpathSync(directory),fixtureRelative=relative(workspace,fixtureDirectory);
  assert.ok(!isAbsolute(fixtureRelative)&&!fixtureRelative.startsWith('..'),'The authored fixture must remain within this workspace.');
  assert.equal(dirname(realpathSync(backing)),fixtureDirectory);assert.equal(dirname(resolve(movedBacking)),resolve(directory));assert.equal(readFileSync(backing).equals(bytes),true);assert.equal(existsSync(movedBacking),false);
  renameSync(backing,movedBacking);fixtureMoved=true;assert.equal(existsSync(backing),false);
  id=launch({TABPLAYER_TEST_OPEN:saved});browser=await connect();page=browser.contexts()[0].pages()[0];await offlinePage();await button('Open');await ready();await waitStatus(s=>Math.abs(s.backingDurationSeconds-2)<.001);
  const reopened=await snapshot();assert.deepEqual(reopened.project,savedSnapshot.project);assert.equal(existsSync(backing),false,'Reopen must use the saved project asset while its authored source file is unavailable.');
  await revealDock(page,'Mixer');await page.locator('.track-channel').first().getByLabel('Mute',{exact:true}).click();await waitMute(true);await idle();await button('Play');
  const reopenedBackingSignal=await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.01);await button('Stop');await waitStatus(s=>!s.playing&&s.tick===0);
  await button('Undo');await waitMute(false);assert.deepEqual((await snapshot()).project,savedSnapshot.project);
  const beforeNew=await status();await button('New');await ready();assert.ok((await status()).generation>beforeNew.generation);assert.equal((await status()).playing,false);assert.equal((await status()).speed,1);assert.equal((await status()).metronome,false);
  assert.equal((await page.evaluate(()=>window.__nativeAudioSmoke)).webAudioSamples,0,'External media mode must never emit a second synthesizer stream.');
  const result={actualNativeCallbacks:true,played,captured,capturedPath,cursorMoved:true,noSecondSynth:true,settingsUndoPreservesPlayback:true,inclusiveLoop:true,instrumentViewsFollowSelectedTrack:true,instrumentViewsPauseStudyAndStop:true,instrumentViewModes:true,musicalEditStopsAndRefreshesPlayback:true,backingTransaction:true,selfContainedBackingRestartReopen:true,authoredBackingUnavailableDuringReopen:true,reopenedBackingSignal,newClearsTransport:true,offlineWebview:true,blockedExternal:[...new Set(blockedExternal)]};
  writeFileSync(join(directory,'native-audio-result.json'),JSON.stringify(result,null,2));await page.screenshot({path:join(directory,'native-audio.png')});
  console.log('Native CPAL playback and independent bounded WASAPI loopback PCM, cursor, pause/seek/loop/speed, sound history, backing transaction, self-contained offline restart/reopen and New passed.',captured);
} catch(error) {
  if(page){const failure=await page.evaluate(async()=>({status:await window.__TAURI_INTERNALS__.invoke('audio_status'),body:document.body.innerText.slice(0,12000)})).catch(()=>null);writeFileSync(join(directory,'native-audio-failure.json'),JSON.stringify(failure,null,2));console.log('Native smoke diagnostic:',failure);}
  throw error;
} finally {
  try {if(browser)await browser.close();} finally {
    try {if(id!==null)stop(id);} finally {
      if(fixtureMoved){assert.equal(existsSync(backing),false);assert.equal(dirname(realpathSync(movedBacking)),realpathSync(directory));assert.equal(readFileSync(movedBacking).equals(bytes),true);renameSync(movedBacking,backing);}
    }
  }
}
