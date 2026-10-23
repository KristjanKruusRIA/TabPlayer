import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Drive pedal: the Sound task's Drive block is recorded as a track-sound edit; in exported WAVs each model
// sustains the plucked note and flattens its peaks, distortion more than overdrive; the level control scales the
// output, and Undo restores the previous setting. It plays live without errors.
const fixture=resolve(directory,'drive-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(const fret of [0,2]){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;const note=new model.Note();note.string=5;note.fret=fret;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
/** The left channel of a 16- or 24-bit stereo PCM WAV as numbers in -1..1, with its sample rate. */
function leftChannel(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const rate=bytes.readUInt32LE(24),bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=new Float64Array(frames);
  for(let i=0;i<frames;i++){const at=44+i*2*width;out[i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return {samples:out,rate};
}
/** RMS level over the first sustained note. */
const level=({samples,rate})=>{let sum=0;const from=Math.round(rate*0.5),to=Math.round(rate*1.5);for(let i=from;i<to;i++)sum+=samples[i]**2;return Math.sqrt(sum/(to-from));};
/** RMS level and peak between two times in seconds. */
const rmsBetween=({samples,rate},from,to)=>{let sum=0;for(let i=Math.round(rate*from);i<Math.round(rate*to);i++)sum+=samples[i]**2;return Math.sqrt(sum/(Math.round(rate*to)-Math.round(rate*from)));};
const peak=({samples,rate},from,to)=>{let most=0;for(let i=Math.round(rate*from);i<Math.round(rate*to);i++)most=Math.max(most,Math.abs(samples[i]));return most;};
const folder=join(directory,`export-${Date.now()}-drive`);await mkdir(folder,{recursive:true});
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
  const dry=await exportWav('dry');
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Drive$/})});
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  const field=async(name,value)=>{const input=panel.getByLabel(`drive ${name}`,{exact:true});await input.fill(String(value));await input.blur();await waitForWorkspaceIdle(page);};
  const choose=async kind=>{await panel.getByLabel('Drive model',{exact:true}).selectOption(kind);await waitForWorkspaceIdle(page);};
  const box=panel.getByLabel('Enable drive',{exact:true});
  await box.click();await waitForWorkspaceIdle(page);assert.equal(await box.isChecked(),true);
  await field('Drive',0.8);
  // Clipping shows in a plucked note as sustain and a lower crest factor: the note's first half second and its
  // fourth come out closer in level, and its peaks closer to its RMS.
  const sustain=render=>20*Math.log10(rmsBetween(render,1.5,2)/rmsBetween(render,0,0.5));
  const crest=render=>peak(render,0.5,1.5)/rmsBetween(render,0.5,1.5);
  const renders={};
  for(const kind of ['overdrive','distortion','fuzz']){await choose(kind);renders[kind]=await exportWav(kind);}
  await field('Level (dB)',-6);
  const quieter=await exportWav('fuzz-quieter');
  const results={dry:{sustainDb:sustain(dry),crest:crest(dry)},...Object.fromEntries(Object.entries(renders).map(([kind,render])=>[kind,{sustainDb:sustain(render),crest:crest(render),levelDb:20*Math.log10(level(render)/level(dry))}])),levelControlDb:20*Math.log10(level(quieter)/level(renders.fuzz))};
  for(const kind of ['overdrive','distortion','fuzz']){
    assert.ok(results[kind].sustainDb>results.dry.sustainDb+6,`${kind} sustains the note: ${JSON.stringify(results)}`);
    assert.ok(results[kind].crest<results.dry.crest*0.7,`${kind} flattens the peaks: ${JSON.stringify(results)}`);
  }
  assert.ok(results.distortion.sustainDb>results.overdrive.sustainDb&&results.distortion.crest<results.overdrive.crest,`distortion clips harder than overdrive: ${JSON.stringify(results)}`);
  assert.ok(Math.abs(results.levelControlDb+6)<1,`the level control lowers the output 6 dB: ${JSON.stringify(results)}`);
  // The panel recorded the drive settings as sound edits.
  const final=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.drive;
  assert.deepEqual(final,{enabled:true,model:'fuzz',drive:.8,tone:.5,levelDb:-6});
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.equal(await panel.getByLabel('drive Level (dB)',{exact:true}).inputValue(),'0');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'drive-effect-result.json'),JSON.stringify(results,null,2));
  console.log('Drive effect passed:',JSON.stringify(results));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
