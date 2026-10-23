import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Reverb models: the Sound task's Reverb block records its model as a track-sound edit; in exported WAVs of a
// plucked note each model rings on after it, a hall longer than a plate and a plate longer than a room, a plate
// brightest and a spring darkest, and the hall, plate and spring tails are stereo. It plays live without errors,
// and Undo restores the previous model.
const fixture=resolve(directory,'reverb-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // One plucked quarter note, then rests for the tail.
  for(let index=0;index<3;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();
    const durations=index===0?[model.Duration.Quarter,model.Duration.Quarter,model.Duration.Half]:[model.Duration.Whole];
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
/** The correlation of the two channels between two times in seconds. */
const correlation=({samples:[l,r],rate},from,to)=>{const [a,b]=span(rate,from,to);let lr=0,ll=0,rr=0;for(let i=a;i<b;i++){lr+=l[i]*r[i];ll+=l[i]**2;rr+=r[i]**2;}return lr/Math.sqrt(ll*rr);};
/** Energy of both channels through a band-pass biquad (RBJ, 0 dB peak, Q 1.4) between two times in seconds. */
function bandEnergy({samples,rate},hz,from,to){
  const w=2*Math.PI*hz/rate,alpha=Math.sin(w)/2.8,a0=1+alpha,b0=alpha/a0,b2=-alpha/a0,a1=-2*Math.cos(w)/a0,a2=(1-alpha)/a0,[a,b]=span(rate,from,to);let sum=0;
  for(const channel of samples){let x1=0,x2=0,y1=0,y2=0;for(let i=0;i<b;i++){const y=b0*channel[i]+b2*x2-a1*y1-a2*y2;x2=x1;x1=channel[i];y2=y1;y1=y;if(i>=a)sum+=y*y;}}
  return sum;
}
const folder=join(directory,`export-${Date.now()}-reverb`);await mkdir(folder,{recursive:true});
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
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Reverb$/})});
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  const field=async(name,value)=>{const input=panel.getByLabel(`reverb ${name}`,{exact:true});await input.fill(String(value));await input.blur();await waitForWorkspaceIdle(page);};
  const choose=async kind=>{await panel.getByLabel('Reverb model',{exact:true}).selectOption(kind);await waitForWorkspaceIdle(page);};
  const box=panel.getByLabel('Enable reverb',{exact:true});
  await box.click();await waitForWorkspaceIdle(page);assert.equal(await box.isChecked(),true);
  await field('Mix',0.5);
  const renders={};
  for(const kind of ['room','hall','plate','spring']){await choose(kind);renders[kind]=await exportWav(kind);}
  // The tail's level from 0.9 to 1.4 s against the plucked note's first half second, and from 0.6 to 1.5 s its
  // 6 kHz octave against its 1 kHz octave and how alike its channels are.
  const tail=render=>20*Math.log10(rms(render,0.9,1.4)/rms(render,0,0.5));
  const bright=render=>10*Math.log10(bandEnergy(render,6000,0.6,1.5)/bandEnergy(render,1000,0.6,1.5));
  const results={dry:{tailDb:tail(dry)},...Object.fromEntries(Object.entries(renders).map(([kind,render])=>[kind,{tailDb:tail(render),brightDb:bright(render),correlation:correlation(render,0.6,1.5)}]))};
  for(const kind of ['room','hall','plate','spring'])assert.ok(results[kind].tailDb>results.dry.tailDb+10,`${kind} rings on after the note: ${JSON.stringify(results)}`);
  assert.ok(results.room.tailDb<results.plate.tailDb&&results.plate.tailDb<results.hall.tailDb,`a hall rings longest and a room shortest: ${JSON.stringify(results)}`);
  assert.ok(results.plate.brightDb>results.hall.brightDb&&results.hall.brightDb>results.spring.brightDb,`a plate is brightest and a spring darkest: ${JSON.stringify(results)}`);
  for(const kind of ['hall','plate','spring'])assert.ok(results[kind].correlation<0.9,`${kind} is stereo: ${JSON.stringify(results)}`);
  // The panel recorded the model as a sound edit.
  const final=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.reverb;
  assert.deepEqual(final,{enabled:true,model:'spring',room:.5,damping:.5,mix:.5});
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await panel.getByLabel('Reverb model',{exact:true}).inputValue(),'plate');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'reverb-models-result.json'),JSON.stringify(results,null,2));
  console.log('Reverb models passed:',JSON.stringify(results));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
