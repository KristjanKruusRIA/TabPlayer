import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {launch,connect,stop,directory} from './harness.mjs';
const run=Date.now(), exported=resolve(directory,`review-${run}.gp`);
const id=launch({TABPLAYER_TEST_SAVE:resolve(directory,`review-${run}.tabplayer`),TABPLAYER_TEST_EXPORT:exported,TABPLAYER_TEST_OPEN:exported});
const browser=await connect(),page=browser.contexts()[0].pages()[0];
let stage='startup';const errors=[];page.on('pageerror',error=>errors.push({stage,message:error.message,stack:error.stack}));
const idle=()=>page.waitForFunction(()=>!document.querySelector('nav button').disabled);
const click=async name=>{stage=name;await page.getByRole('button',{name,exact:true}).click();await idle();};
const fill=(name,value)=>page.getByLabel(name,{exact:true}).fill(String(value));
const ready=()=>page.getByRole('button',{name:'Play',exact:true}).waitFor().then(()=>page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Play'&&!b.disabled)));
const audible=async stage=>{console.log(`Checking PCM: ${stage}`);await page.evaluate(()=>{window.__reviewPeak=0;});await click('Play');await page.waitForFunction(()=>window.__reviewPeak>.001,null,{timeout:5000});await click('Stop');};
try {
  await page.getByRole('button',{name:'New',exact:true}).waitFor();
  await page.context().route('**/*',route=>['tauri.localhost','ipc.localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  await page.evaluate(async()=>{
    const {AlphaTabApi}=await import('/alphatab/alphaTab.mjs'),original=AlphaTabApi.prototype.renderScore;
    AlphaTabApi.prototype.renderScore=function(score,...args){window.__reviewScore=score;window.__reviewApi=this;return original.call(this,score,...args);};
    window.__reviewMix=[];
    for(const method of ['changeTrackMute','changeTrackSolo','changeTrackVolume']){const run=AlphaTabApi.prototype[method];AlphaTabApi.prototype[method]=function(tracks,value){window.__reviewMix.push({method,channels:tracks.flatMap(t=>[t.playbackInfo.primaryChannel,t.playbackInfo.secondaryChannel]),value});return run.call(this,tracks,value);};}
    window.__reviewPeak=0;window.__reviewChunks=0;
    const post=MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage=function(data,...args){if(data?.cmd==='alphaSynth.output.addSamples'){window.__reviewChunks++;for(const value of data.samples)window.__reviewPeak=Math.max(window.__reviewPeak,Math.abs(value));}return post.call(this,data,...args);};
  });
  await fill('Measure',2);for(let i=0;i<4;i++)await click('Delete beat');
  assert.equal(await page.getByRole('button',{name:'Set note',exact:true}).isDisabled(),true);
  await page.waitForFunction(()=>window.__reviewScore.tracks[0].staves[0].bars[1].voices[0].beats[0].isEmpty);
  await click('Insert beat');await fill('Measure',1);
  await fill('Beat',4);for(let i=0;i<3;i++)await click('Delete beat');
  await click('Insert beat');await fill('Beat',1);await fill('Dots',3);await click('Apply rhythm');
  await fill('Fret',7);await click('Set note');await fill('Beat',2);await fill('Fret',9);await click('Set note');
  await page.waitForFunction(()=>window.__reviewScore.tracks[0].staves[0].bars[0].voices[0].beats[0].playbackDuration===1800);
  assert.equal(await page.evaluate(()=>window.__reviewScore.tracks[0].staves[0].bars[0].voices[0].beats[1].absolutePlaybackStart),1800);
  await ready();await audible('authored triple dots');
  await click('Save');await click('Export GP');await click('Open');await ready();
  assert.equal(await page.evaluate(()=>window.__reviewScore.tracks[0].staves[0].bars[0].voices[0].beats[0].dots),3);
  assert.equal(await page.evaluate(()=>window.__reviewScore.tracks[0].staves[0].bars[0].voices[0].beats[0].playbackDuration),1800);
  await audible('reimported triple dots');
  await click('Add track');await ready();await page.getByLabel('Mute',{exact:true}).nth(1).check();
  await click('Remove track');await click('Undo');await ready();
  assert.equal(await page.getByLabel('Mute',{exact:true}).nth(0).isChecked(),false);
  assert.equal(await page.getByLabel('Mute',{exact:true}).nth(1).isChecked(),true);
  await click('Redo');await ready();assert.equal(await page.getByLabel('Mute',{exact:true}).isChecked(),true);
  await page.getByLabel('Mute',{exact:true}).uncheck();await click('Undo');await ready();
  await page.getByLabel('Solo',{exact:true}).nth(1).check();await click('Track 2: Bass');await click('Remove track');await ready();
  await audible('deleted solo track');
  await page.getByLabel('Mute',{exact:true}).check();await click('Save');await click('New');await ready();
  assert.equal(await page.getByLabel('Mute',{exact:true}).isChecked(),false);
  await fill('Fret',7);await click('Set note');await ready();
  await audible('New after mute');
  assert.deepEqual(errors,[]);
  console.log('Packaged regression checks passed: empty following measure; triple-dot render/timing/export/reimport; mixer undo/redo; audio after solo deletion and New. External requests blocked.');
} catch(error){
  console.log(JSON.stringify(await page.evaluate(()=>({peak:window.__reviewPeak,chunks:window.__reviewChunks,mix:window.__reviewMix?.slice(-20),score:window.__reviewScore?.tracks.map(t=>({name:t.name,playback:t.playbackInfo,notes:t.staves[0].bars[0].voices[0].beats.map(b=>b.notes.map(n=>({string:n.string,fret:n.fret,pitch:n.realValue})))})),state:window.__reviewApi?.player.state,ticks:window.__reviewApi?.tickPosition,context:window.__reviewApi?.player.output.context?.state,transport:document.querySelector('.transport')?.textContent})).catch(()=>({diagnosticsUnavailable:true})),null,2));
  throw error;
} finally {await page.context().unrouteAll({behavior:'ignoreErrors'});await browser.close();stop(id);}
