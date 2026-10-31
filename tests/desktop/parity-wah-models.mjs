import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Wah models: the Sound task's Wah model is recorded as a track-sound edit. With the pedal at the toe, the exported WAV
// is darker with the bass model and brighter with the wide model than with the classic. Changing the model while
// playing gives no errors, and Undo restores the previous model.
const fixture=resolve(directory,'wah-models-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // Sustained whole notes with a rich spectrum, so filter sweeps are measurable.
  for(const fret of [0,2]){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;const note=new model.Note();note.string=5;note.fret=fret;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
/** The left channel of a 16- or 24-bit stereo PCM WAV as numbers in -1..1. */
function leftChannel(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=new Float64Array(frames);
  for(let i=0;i<frames;i++){const at=44+i*2*width;out[i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return out;
}
/** Brightness: the RMS of the first difference over the RMS of the signal, which rises with frequency. */
function brightness(samples){let d=0,x=0;for(let i=24001;i<96000;i++){d+=(samples[i]-samples[i-1])**2;x+=samples[i]**2;}return Math.sqrt(d/x);}
/** Treble: the RMS of the second difference over the RMS of the signal, which rises with the square of frequency and so
 * weighs the top of the sweep. */
function treble(samples){let d=0,x=0;for(let i=24002;i<96000;i++){d+=(samples[i]-2*samples[i-1]+samples[i-2])**2;x+=samples[i]**2;}return Math.sqrt(d/x);}
const measure=samples=>({brightness:brightness(samples),treble:treble(samples)});
const folder=join(directory,`export-${Date.now()}-wah-models`);await mkdir(folder,{recursive:true});
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
    await new Promise(r=>setTimeout(r,300));return leftChannel(await readFile(join(folder,file)));
  };
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Wah$/})}).first();
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  await panel.getByLabel('Enable wah',{exact:true}).click();await waitForWorkspaceIdle(page);
  const field=panel.getByLabel('wah Pedal position',{exact:true});await field.fill('1');await field.blur();await waitForWorkspaceIdle(page);
  const select=panel.getByLabel('Wah model',{exact:true});
  assert.equal(await select.inputValue(),'classic');
  const lastWah=async()=>(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1)?.sound.effects.wah;
  const results={classic:measure(await exportWav('classic'))};
  for(const name of ['bass','wide','vintage']){
    await select.selectOption(name);await waitForWorkspaceIdle(page);
    const wah=await lastWah();assert.equal(wah.model,name);assert.equal(wah.position,1);assert.equal(wah.enabled,true);
    results[name]=measure(await exportWav(name));
  }
  const text=JSON.stringify(results);
  assert.ok(results.bass.brightness<results.classic.brightness*0.8,`the bass toe is darker than the classic toe: ${text}`);
  assert.ok(results.wide.treble>results.classic.treble*1.15,`the wide toe passes more treble than the classic toe: ${text}`);
  assert.ok(results.vintage.treble<results.classic.treble*0.8,`the vintage toe stops below the classic toe: ${text}`);
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);
  await select.selectOption('bass');await waitForWorkspaceIdle(page);
  await waitStatus(s=>s.playing&&s.generation===s.desiredGeneration&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await select.inputValue(),'vintage');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'wah-models-result.json'),JSON.stringify(results,null,2));
  console.log('Wah models passed:',text);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
