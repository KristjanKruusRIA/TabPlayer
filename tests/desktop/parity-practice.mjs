import {waitForWorkspaceIdle,clickWorkstationButton,revealDock,revealPlaybackControls} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildPracticeFixture,practiceFixture } from './practice-fixture.mjs';

buildPracticeFixture();const sourceHash=createHash('sha256').update(readFileSync(practiceFixture)).digest('hex');
const backingPath=resolve(directory,'gp8-practice-backing.wav'),backingRate=48000,backingFrames=backingRate*2,backingBytes=Buffer.alloc(44+backingFrames*4);
backingBytes.write('RIFF');backingBytes.writeUInt32LE(backingBytes.length-8,4);backingBytes.write('WAVEfmt ',8);backingBytes.writeUInt32LE(16,16);backingBytes.writeUInt16LE(1,20);backingBytes.writeUInt16LE(2,22);backingBytes.writeUInt32LE(backingRate,24);backingBytes.writeUInt32LE(backingRate*4,28);backingBytes.writeUInt16LE(4,32);backingBytes.writeUInt16LE(16,34);backingBytes.write('data',36);backingBytes.writeUInt32LE(backingFrames*4,40);
for(let frame=0;frame<backingFrames;frame++){const sample=Math.round(Math.sin(frame/backingRate*880*Math.PI*2)*5000);backingBytes.writeInt16LE(sample,44+frame*4);backingBytes.writeInt16LE(sample,46+frame*4);}writeFileSync(backingPath,backingBytes);
const helper=resolve('src-tauri/target/debug/examples/capture_loopback.exe');assert.ok(existsSync(helper),'Build the bounded output-loopback example first.');
function capture(path,deviceId){
  const process=spawn(helper,[path,deviceId],{windowsHide:true});let log='';
  const done=new Promise((accept,reject)=>{process.on('error',reject);process.on('exit',code=>code===0?accept():reject(new Error(`Loopback failed ${code}: ${log}`)));});void done.catch(()=>{});
  const ready=new Promise((accept,reject)=>{const timeout=setTimeout(()=>reject(new Error('Loopback did not become ready')),5000);process.stdout.on('data',data=>{log+=data.toString();if(log.includes('"ready":true')){clearTimeout(timeout);accept();}});process.stderr.on('data',data=>{log+=data.toString();});process.on('error',reject);});
  return {ready,done,metrics:()=>JSON.parse(readFileSync(path.replace(/\.wav$/,'.json'),'utf8'))};
}
function wave(path,threshold=.001){
  const bytes=readFileSync(path);let rate,channels,bits,format,start,length;
  for(let cursor=12;cursor+8<=bytes.length;){const tag=bytes.toString('ascii',cursor,cursor+4),size=bytes.readUInt32LE(cursor+4);if(tag==='fmt '){format=bytes.readUInt16LE(cursor+8);channels=bytes.readUInt16LE(cursor+10);rate=bytes.readUInt32LE(cursor+12);bits=bytes.readUInt16LE(cursor+22);if(format===0xfffe&&size>=40)format=bytes.readUInt16LE(cursor+32);}if(tag==='data'){start=cursor+8;length=size;break;}cursor+=8+size+(size&1);}
  assert.ok(start&&rate&&channels);assert.ok((format===3&&bits===32)||(format===1&&bits===16));const stride=channels*bits/8,pcm=Array.from({length:length/stride},(_,index)=>format===3?bytes.readFloatLE(start+index*stride):bytes.readInt16LE(start+index*stride)/32768);
  const onsets=[];let last=-Infinity;for(let index=0;index<pcm.length;index++)if(Math.abs(pcm[index])>threshold){if(index-last>rate*.15)onsets.push(index);last=index;}
  return {rate,pcm,onsets};
}
let id=launch({TABPLAYER_TEST_OPEN:practiceFixture,TABPLAYER_TEST_BACKING:backingPath,TABPLAYER_TEST_SAVE:resolve(directory,'gp8-practice.tabplayer')}),browser,page;const result={};
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  await page.addInitScript(()=>{window.__practiceSmoke={webAudioSamples:0};const send=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(data,...args){if(data?.cmd==='alphaSynth.output.addSamples')window.__practiceSmoke.webAudioSamples+=data.samples.length;return send.call(this,data,...args);};});await page.reload();await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>readActiveDocument(page);
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async(predicate,timeout=15000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(25);}throw new Error(`Native practice timeout: ${JSON.stringify(last)}`);};
  const idle=async()=>{await waitForWorkspaceIdle(page,{timeout:15000});assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const toggle=async(locator,checked)=>{if(await locator.isChecked()!==checked)await locator.click();const deadline=Date.now()+5000;while(await locator.isChecked()!==checked){assert.ok(Date.now()<deadline,'Native checkbox change was not acknowledged.');await page.waitForTimeout(25);}await idle();};
  const ready=()=>waitStatus(value=>value.ready&&!value.error);
  await button('Open');await ready();const owner=(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'))).active;const baseline=await snapshot();await button('Show instrument');
  await button('Practice');const panel=page.locator('summary').filter({hasText:'Practice settings'}).locator('..');await panel.evaluate(node=>{node.open=true;});
  const mode=value=>panel.getByRole('combobox',{name:/^Tempo mode/}).selectOption(value);
  const fill=(label,value)=>panel.getByLabel(label,{exact:true}).fill(String(value));
  const apply=async predicate=>{await panel.getByRole('button',{name:'Apply practice settings'}).click();return waitStatus(value=>predicate(value.practice.settings));};
  await fill('Relative speed (%)',123);await fill('Metronome volume (%)',0);await panel.getByLabel('Visual metronome',{exact:true}).check();await apply(settings=>settings.tempo.kind==='relative'&&settings.tempo.ratio===1.23&&settings.metronome.visual);
  await button('Play');await waitStatus(value=>value.playing&&Math.abs(value.practice.currentBpm-147.6)<1e-9&&value.practice.pulse?.serial>0);await button('Stop');
  result.endpointPitch=[];
  for(const percent of [10,300]){
    await fill('Relative speed (%)',percent);await apply(settings=>settings.tempo.kind==='relative'&&settings.tempo.ratio===percent/100);
    const path=resolve(directory,`gp8-practice-speed-${percent}.wav`),recording=capture(path,(await status()).deviceId);await recording.ready;await button('Play');await recording.done;await button('Stop');
    const metrics=recording.metrics();assert.equal(metrics.finite,true);assert.ok(metrics.peak>.001);assert.ok(Math.abs(metrics.frequencyHz/440-1)<.03,`${percent}% pitch ${metrics.frequencyHz}`);result.endpointPitch.push({percent,...metrics});
  }
  await mode('fixed');await fill('Fixed tempo (BPM)',90);await fill('Count-in bars',1);await fill('Metronome volume (%)',40);await apply(settings=>settings.tempo.kind==='fixed'&&settings.tempo.bpm===90&&settings.countIn.bars===1);
  await button('Play');const counting=await waitStatus(value=>value.practice.phase==='countIn');assert.equal(counting.tick,0);assert.equal(counting.seconds,0);assert.equal(await page.locator('.instrument-view g[data-note-id]').count(),0);
  await button('Pause');const paused=await waitStatus(value=>value.practice.phase==='paused'&&value.practice.countInRemaining>0);await page.waitForTimeout(120);const still=await status();assert.equal(still.tick,0);assert.equal(still.practice.countInRemaining,paused.practice.countInRemaining);assert.equal(still.practice.pulse.serial,paused.practice.pulse.serial);
  await page.evaluate(({owner,value})=>window.__TAURI_INTERNALS__.invoke('audio_command',{owner,command:{type:'selectDevice',deviceId:value.deviceId,generation:value.generation}}),{owner,value:still});const restored=await waitStatus(value=>value.ready&&value.practice.phase==='paused');assert.equal(restored.tick,0);assert.equal(restored.practice.countInRemaining,still.practice.countInRemaining);assert.equal(restored.practice.pulse.serial,still.practice.pulse.serial);result.healthyDeviceCountRecovery=true;
  await button('Play');await waitStatus(value=>value.practice.phase==='playing'&&value.tick>0);await button('Stop');result.countPauseResume=true;
  const firstPath=resolve(directory,'gp8-practice-count-loopback.wav'),firstCapture=capture(firstPath,(await status()).deviceId);await firstCapture.ready;await button('Play');await firstCapture.done;
  const countWave=wave(firstPath);assert.ok(countWave.onsets.length>=5,JSON.stringify(countWave.onsets));for(let index=1;index<4;index++)assert.ok(Math.abs((countWave.onsets[index]-countWave.onsets[index-1])/countWave.rate-2/3)<.003);
  assert.ok(Math.abs((countWave.onsets[4]-countWave.onsets[0])/countWave.rate-8/3)<.02);result.countPcm={sampleRate:countWave.rate,onsets:countWave.onsets,metrics:firstCapture.metrics()};
  await button('Stop');await fill('Count-in bars',0);await apply(settings=>settings.countIn.bars===0);
  const fixedPath=resolve(directory,'gp8-practice-fixed-loopback.wav'),fixedCapture=capture(fixedPath,(await status()).deviceId);await fixedCapture.ready;await button('Play');await fixedCapture.done;
  // Recorded releases have their own quiet transients; isolate the louder attack peaks.
  const fixedWave=wave(fixedPath,fixedCapture.metrics().peak*.4);assert.ok(fixedWave.onsets.length>=5,JSON.stringify(fixedWave.onsets));for(let index=1;index<fixedWave.onsets.length;index++)assert.ok(Math.abs((fixedWave.onsets[index]-fixedWave.onsets[index-1])/fixedWave.rate-2/3)<.004);
  result.fixedPcm={sampleRate:fixedWave.rate,onsets:fixedWave.onsets,metrics:fixedCapture.metrics()};await button('Stop');
  await button('Export score');const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByRole('combobox',{name:/^Export format/}).selectOption('wav');assert.equal(await dialog.getByRole('option',{name:'Current speed coefficient'}).evaluate(option=>option.disabled),true);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();result.fixedExportGuard=true;
  await fill('Count-in bars',1);await apply(settings=>settings.countIn.bars===1);await revealPlaybackControls(page);await page.getByLabel('Seek measure',{exact:true}).fill('2');await button('Seek');await waitStatus(value=>value.tick===3840);await button('Play');await waitStatus(value=>value.practice.phase==='countIn'&&value.tick===3840);await button('Stop');result.seekThenCount=true;
  await mode('progressive');await fill('Starting speed (%)',50);await fill('Finishing speed (%)',100);await fill('Increment (percentage points)',20);await fill('Repetitions per speed',1);await panel.getByLabel('Count in between loops',{exact:true}).check();await apply(settings=>settings.tempo.kind==='progressive');
  await revealPlaybackControls(page);await page.getByLabel('Loop start',{exact:true}).fill('1');await page.getByLabel('Loop end',{exact:true}).fill('1');await button('Loop');await waitStatus(value=>value.loop?.startTick===0&&value.loop?.endTick===3840);await button('Play');
  const progressed=await waitStatus(value=>value.practice.completedPasses===1&&value.practice.phase==='countIn',13000);assert.ok(Math.abs(progressed.practice.effectiveRatio-.7)<1e-9);assert.equal(progressed.tick,0);await button('Pause');await waitStatus(value=>value.practice.phase==='paused');result.progressiveNextCount=true;await button('Stop');await button('Clear loop');
  assert.deepEqual((await snapshot()).project,baseline.project);assert.equal((await snapshot()).dirty,baseline.dirty);assert.equal(createHash('sha256').update(readFileSync(practiceFixture)).digest('hex'),sourceHash);result.practiceDoesNotEdit=true;
  await mode('fixed');await fill('Fixed tempo (BPM)',90);await apply(settings=>settings.tempo.kind==='fixed');await button('Import backing');await ready();await waitStatus(value=>value.backingDurationSeconds===2&&value.practice.settings.tempo.kind==='relative');await page.getByText('Fixed tempo disabled because this score has backing audio.',{exact:true}).waitFor();assert.equal(await panel.getByRole('option',{name:'Fixed',exact:true}).evaluate(option=>option.disabled),true);await toggle(page.getByLabel('Backing mute',{exact:true}),true);await ready();assert.equal(await panel.getByRole('option',{name:'Fixed',exact:true}).evaluate(option=>option.disabled),true);await toggle(page.getByLabel('Backing mute',{exact:true}),false);await ready();
  await fill('Relative speed (%)',300);await fill('Count-in bars',1);await fill('Metronome volume (%)',0);await apply(settings=>settings.tempo.kind==='relative'&&settings.tempo.ratio===3&&settings.metronome.volume===0);await revealDock(page,'Mixer');await page.locator('.track-channel').first().getByLabel('Mute',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.track-channel input[type="checkbox"]').checked);await idle();await ready();
  const backingCapturePath=resolve(directory,'gp8-practice-backing-count.wav'),backingCapture=capture(backingCapturePath,(await status()).deviceId);await backingCapture.ready;await button('Play');await backingCapture.done;await button('Stop');const backingWave=wave(backingCapturePath),backingMetrics=backingCapture.metrics();assert.ok(backingWave.onsets.length>0);assert.ok(backingWave.onsets[0]/backingWave.rate>=2/3-.02);assert.ok(backingWave.onsets[0]/backingWave.rate<1);assert.ok(Math.abs(backingMetrics.frequencyHz/880-1)<.03);result.backingCountDelaysAudio={...backingMetrics};await button('Remove backing');await ready();assert.equal(await panel.getByRole('option',{name:'Fixed',exact:true}).evaluate(option=>option.disabled),false);
  await panel.scrollIntoViewIfNeeded();await page.screenshot({path:resolve('.analysis/parity/native-practice.png')});await button('Save');await button('New');await ready();assert.deepEqual((await status()).practice.settings,{tempo:{kind:'relative',ratio:1},metronome:{enabled:false,volume:.4,visual:false},countIn:{bars:0,betweenLoops:false}});result.newResetsPractice=true;
  assert.equal((await page.evaluate(()=>window.__practiceSmoke)).webAudioSamples,0);result.noSecondSynth=true;assert.deepEqual(errors,[]);writeFileSync(resolve('.analysis/parity/native-practice-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page){await page.screenshot({path:resolve('.analysis/parity/native-practice-failure.png')});console.error(await page.evaluate(async()=>({status:await window.__TAURI_INTERNALS__.invoke('audio_status'),body:document.body.innerText.slice(-3500)})));}throw error;}
finally{if(browser)await browser.close();stop(id);}
