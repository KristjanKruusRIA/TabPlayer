import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.connectOverCDP(process.env.TABPLAYER_CDP_URL ?? 'http://127.0.0.1:9223');
const page=browser.contexts()[0].pages()[0];
try {
  page.on('pageerror',error=>console.log('Page error:',error.message));
  await page.addInitScript(()=>{
    window.__audioTest={peak:0,chunks:0,playedSamples:0,running:false};
    const original=MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage=function(data,...args){
      if(data?.cmd==='alphaSynth.output.addSamples') {
        window.__audioTest.chunks++;
        for(const value of data.samples)window.__audioTest.peak=Math.max(window.__audioTest.peak,Math.abs(value));
      }
      return original.call(this,data,...args);
    };
    const OriginalNode=window.AudioWorkletNode;
    window.AudioWorkletNode=class extends OriginalNode {
      constructor(context,...args){super(context,...args);this.port.addEventListener('message',event=>{
        if(event.data?.cmd==='alphaSynth.output.samplesPlayed'){window.__audioTest.playedSamples+=event.data.samples;window.__audioTest.running=context.state==='running';}
      });}
    };
  });
  await page.context().route('**/*',route=>{
    const url=new URL(route.request().url());return ['127.0.0.1','tauri.localhost','ipc.localhost'].includes(url.hostname)?route.continue():route.abort();
  });
  await page.reload();
  await page.getByLabel('Fret',{exact:true}).fill('7');await page.getByRole('button',{name:'Set note',exact:true}).click();
  await page.waitForFunction(()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Play');return button && !button.matches(':disabled');});
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.waitForFunction(()=>window.__audioTest.playedSamples>10000 && window.__audioTest.peak>.001);
  const signal=await page.evaluate(()=>window.__audioTest);assert.equal(signal.running,true);console.log('Native audio output',signal);
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.getByLabel('Seek measure',{exact:true}).fill('4');await page.getByRole('button',{name:'Seek',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.transport output').textContent.includes('M4'));
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByLabel('Speed').selectOption('50');
  await page.getByRole('button',{name:'Loop',exact:true}).click();await page.getByRole('button',{name:'Play',exact:true}).click();
  const initial=await page.evaluate(()=>window.__audioTest.playedSamples);
  await page.waitForFunction(previous=>window.__audioTest.playedSamples-previous>500000,initial,{timeout:15000});
  assert.ok((await page.locator('.transport output').innerText()).includes('M1'));
  await page.getByLabel('Fret',{exact:true}).fill('9');await page.getByRole('button',{name:'Set note',exact:true}).click();
  await page.waitForFunction(()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Play');return button && !button.matches(':disabled');});
  assert.equal(await page.getByRole('button',{name:'Pause',exact:true}).count(),0);
  await page.evaluate(()=>{window.__audioTest.peak=0;window.__audioTest.playedSamples=0;});
  await page.getByRole('button',{name:'Play',exact:true}).click();await page.waitForFunction(()=>window.__audioTest.peak>.001);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  console.log('Pause, seek last measure, speed 50%, looping, stop on edit, refreshed MIDI playback passed with external requests blocked.');
} finally {await page.context().unrouteAll({behavior:'ignoreErrors'});await browser.close();}
