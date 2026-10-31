import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Wah: the Sound task's Wah block is recorded as track-sound edits; the exported WAV gets darker at the heel and
// brighter at the toe than at the heel, auto mode follows the playing, it plays live without errors, and Undo
// restores the manual pedal.
const fixture=resolve(directory,'wah-fixture.gp');
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
const folder=join(directory,`export-${Date.now()}-wah`);await mkdir(folder,{recursive:true});
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
  const results={dry:brightness(await exportWav('dry'))};
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Wah$/})});
  await details.locator('summary').click();
  const box=panel.getByLabel('Enable wah',{exact:true});await box.click();await waitForWorkspaceIdle(page);await page.waitForFunction(()=>document.querySelector('[aria-label="Enable wah"]')?.checked===true);
  const pedal=async value=>{const field=panel.getByLabel('wah Pedal position',{exact:true});await field.fill(String(value));await field.blur();await waitForWorkspaceIdle(page);};
  await pedal(0);results.heel=brightness(await exportWav('heel'));
  await pedal(1);results.toe=brightness(await exportWav('toe'));
  assert.ok(results.heel<results.dry*0.8,`heel darkens: ${JSON.stringify(results)}`);
  assert.ok(results.toe>results.heel*1.8,`toe is brighter than heel: ${JSON.stringify(results)}`);
  const mode=panel.getByLabel('Wah mode',{exact:true});await mode.selectOption('auto');await waitForWorkspaceIdle(page);
  results.auto=brightness(await exportWav('auto'));
  // Auto mode follows the decaying notes, so it sits between the closed heel and the open toe.
  assert.ok(results.auto>results.heel*1.2&&results.auto<results.toe*0.95,`auto wah follows the playing: ${JSON.stringify(results)}`);
  // The panel recorded the enable, both pedal positions and the mode as separate sound edits.
  const sounds=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound');
  assert.deepEqual(sounds.slice(-3).map(edit=>[edit.sound.effects.wah.position,edit.sound.effects.wah.mode]),[[0,'manual'],[1,'manual'],[1,'auto']]);
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await mode.inputValue(),'manual');assert.equal(await panel.getByLabel('wah Pedal position',{exact:true}).inputValue(),'1');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'wah-effect-result.json'),JSON.stringify(results,null,2));
  console.log('Wah effect passed:',JSON.stringify(results));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
