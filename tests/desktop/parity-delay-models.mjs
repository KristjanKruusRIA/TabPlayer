import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Delay models: the Sound task's Delay block records its model and a named division as track-sound edits. In
// exported WAVs of a short plucked note the first repeat lands one division after the note at the score's tempo,
// a digital repeat keeps the note's tone, and tape and analog repeats are darker than the note and grow darker on
// each repeat. It plays live without errors, and Undo restores the previous model.
const fixture=resolve(directory,'delay-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // One plucked sixteenth note, then rests for the tail.
  for(let index=0;index<3;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();
    const durations=index===0?[model.Duration.Sixteenth,model.Duration.Sixteenth,model.Duration.Eighth,model.Duration.Quarter,model.Duration.Half]:[model.Duration.Whole];
    durations.forEach((duration,at)=>{const beat=new model.Beat();beat.duration=duration;if(index===0&&at===0){const note=new model.Note();note.string=5;note.fret=0;beat.addNote(note);}voice.addBeat(beat);});
    bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
/** Both channels of a 16- or 24-bit stereo PCM WAV as numbers in -1..1, with the sample rate. */
function channels(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const rate=bytes.readUInt32LE(24),bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=[new Float64Array(frames),new Float64Array(frames)];
  for(let i=0;i<frames;i++)for(let c=0;c<2;c++){const at=44+(i*2+c)*width;out[c][i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return {samples:out,rate};
}
const span=(rate,from,to)=>[Math.round(rate*from),Math.round(rate*to)];
/** RMS of both channels between two times in seconds. */
const rms=({samples,rate},from,to)=>{const [a,b]=span(rate,from,to);let sum=0;for(const channel of samples)for(let i=a;i<b;i++)sum+=channel[i]**2;return Math.sqrt(sum/(2*(b-a)));};
/** Energy of both channels through a band-pass biquad (RBJ, 0 dB peak, Q 1.4) between two times in seconds. */
function bandEnergy({samples,rate},hz,from,to){
  const w=2*Math.PI*hz/rate,alpha=Math.sin(w)/2.8,a0=1+alpha,b0=alpha/a0,b2=-alpha/a0,a1=-2*Math.cos(w)/a0,a2=(1-alpha)/a0,[a,b]=span(rate,from,to);let sum=0;
  for(const channel of samples){let x1=0,x2=0,y1=0,y2=0;for(let i=0;i<b;i++){const y=b0*channel[i]+b2*x2-a1*y1-a2*y2;x2=x1;x1=channel[i];y2=y1;y1=y;if(i>=a)sum+=y*y;}}
  return sum;
}
const folder=join(directory,`export-${Date.now()}-delay`);await mkdir(folder,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:fixture,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+20000;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`Native status timed out: ${JSON.stringify(last)}`);};
  await button('Open');await waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);
  const exportWav=async name=>{
    await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('wav');
    await dialog.getByLabel('File name',{exact:true}).fill(name);await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const deadline=Date.now()+120000;let file;
    while(Date.now()<deadline&&!(file=(await readdir(folder)).find(entry=>entry===`${name}.wav`))){
      const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(file,`${name}.wav was written`);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await waitForWorkspaceIdle(page);
    await new Promise(r=>setTimeout(r,300));return channels(await readFile(join(folder,file)));
  };
  const dry=await exportWav('dry');
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Delay$/})});
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  const field=async(name,value)=>{const input=panel.getByLabel(`delay ${name}`,{exact:true});await input.fill(String(value));await input.blur();await waitForWorkspaceIdle(page);};
  const choose=async kind=>{await panel.getByLabel('Delay model',{exact:true}).selectOption(kind);await waitForWorkspaceIdle(page);};
  const time=async label=>{await panel.getByLabel('Delay time',{exact:true}).selectOption({label});await waitForWorkspaceIdle(page);};
  const box=panel.getByLabel('Enable delay',{exact:true});
  await box.click();await waitForWorkspaceIdle(page);assert.equal(await box.isChecked(),true);
  await field('Mix',0.5);await field('Feedback',0.5);
  const renders={};
  renders.digital=await exportWav('digital');
  await time('Dotted 1/8');renders.dotted=await exportWav('dotted');
  await time('1/8 triplet');renders.triplet=await exportWav('triplet');
  await time('1/4');
  for(const kind of ['tape','analog']){await choose(kind);renders[kind]=await exportWav(kind);}
  // The delay plays the note at half level and its repeats at half level, so the render less half the dry export
  // leaves the repeats alone.
  const repeats=render=>({rate:render.rate,samples:render.samples.map((channel,c)=>channel.map((value,i)=>value-0.5*(dry.samples[c][i]??0)))});
  /** The first time the 2 ms RMS envelope rises above a tenth of its highest value. */
  const onset=render=>{
    const step=Math.round(render.rate*0.002),levels=[];
    for(let at=0;at+step<=render.samples[0].length;at+=step)levels.push(rms(render,at/render.rate,(at+step)/render.rate));
    const peak=Math.max(...levels);return levels.findIndex(level=>level>peak/10)*0.002;
  };
  const start=onset(dry);
  // Tone: the 5 kHz octave against the 500 Hz octave in the first 100 ms of the note and of each repeat.
  const tone=(render,from)=>10*Math.log10(bandEnergy(render,5000,from,from+0.1)/bandEnergy(render,500,from,from+0.1));
  const results={dryTone:tone(dry,start)};
  for(const [name,division] of [['digital',0.5],['dotted',0.375],['triplet',1/6],['tape',0.5],['analog',0.5]]){
    const wet=repeats(renders[name]),first=onset(wet)-start;
    results[name]={division,firstRepeat:first};
    assert.ok(Math.abs(first-division)<0.008,`${name}'s first repeat lands one division after the note: ${JSON.stringify(results)}`);
    if(division===0.5)Object.assign(results[name],{tone:[1,2].map(k=>tone(wet,start+k*division)),secondToFirst:rms(wet,start+1,start+1.1)/rms(wet,start+0.5,start+0.6)});
  }
  for(const kind of ['digital','tape','analog'])results[kind].toneLoss=results[kind].tone.map(value=>results.dryTone-value);
  assert.ok(results.digital.toneLoss.every(loss=>Math.abs(loss)<0.1),`digital repeats keep the note's tone: ${JSON.stringify(results)}`);
  for(const kind of ['tape','analog']){
    const [first,second]=results[kind].toneLoss;
    assert.ok(first>0.5&&second>first+0.3,`${kind} repeats are darker than the note and darker on each repeat: ${JSON.stringify(results)}`);
  }
  assert.ok(Math.abs(results.digital.secondToFirst-0.5)<0.15,`digital repeats fall by the feedback: ${JSON.stringify(results)}`);
  // The panel recorded the model and division as sound edits.
  const final=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.delay;
  assert.deepEqual(final,{enabled:true,model:'analog',quarterNotes:1,feedback:.5,mix:.5});
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await panel.getByLabel('Delay model',{exact:true}).inputValue(),'tape');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'delay-models-result.json'),JSON.stringify(results,null,2));
  console.log('Delay models passed:',JSON.stringify(results));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
