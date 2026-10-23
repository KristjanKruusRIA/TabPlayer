import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Effect order: the Sound task's blocks can be moved along the signal chain, and each move is a track-sound edit.
// In exported WAVs of a short note through a distortion and a dotted-quarter delay, the distortion before the delay
// leaves each repeat about half the one before, while the distortion after the delay squeezes the falling repeats
// back up. The same order exports the same samples twice, it plays live without errors, and Undo moves the block back.
const fixture=resolve(directory,'effect-order-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // A sixteenth-note A3, then rests for the repeats to ring out.
  for(let index=0;index<3;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();
    if(index===0){
      const note=new model.Note();note.string=3;note.fret=2;
      const beat=new model.Beat();beat.duration=model.Duration.Sixteenth;beat.addNote(note);voice.addBeat(beat);
      for(const duration of [model.Duration.Sixteenth,model.Duration.Eighth,model.Duration.Half]){const rest=new model.Beat();rest.duration=duration;rest.isEmpty=false;voice.addBeat(rest);}
    }else{const beat=new model.Beat();beat.duration=model.Duration.Whole;voice.addBeat(beat);}
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
/** RMS of both channels between two times in seconds. */
const rms=({samples,rate},from,to)=>{const a=Math.round(rate*from),b=Math.round(rate*to);let sum=0;for(const channel of samples)for(let i=a;i<b;i++)sum+=channel[i]**2;return Math.sqrt(sum/(2*(b-a)));};
const folder=join(directory,`export-${Date.now()}-effect-order`);await mkdir(folder,{recursive:true});
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
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const open=async name=>{const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:new RegExp(`^${name}$`)})});if(!await details.evaluate(node=>node.open))await details.locator('summary').click();};
  const settle=()=>waitForWorkspaceIdle(page);
  const order=()=>panel.locator('.sound-block-name').allTextContents();
  await open('Drive');await open('Delay');
  await panel.getByLabel('Enable drive',{exact:true}).click();await settle();
  await panel.getByLabel('Drive model',{exact:true}).selectOption('distortion');await settle();
  await panel.getByLabel('drive Drive',{exact:true}).fill('0.8');await settle();
  await panel.getByLabel('Enable delay',{exact:true}).click();await settle();
  await panel.getByLabel('Delay time',{exact:true}).selectOption('1.5');await settle();
  await panel.getByLabel('delay Feedback',{exact:true}).fill('0.5');await settle();
  await panel.getByLabel('delay Mix',{exact:true}).fill('1');await settle();
  const recorded=async()=>(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects;
  const chosen=await recorded();
  assert.deepEqual({drive:[chosen.drive.enabled,chosen.drive.model,chosen.drive.drive],delay:[chosen.delay.enabled,chosen.delay.quarterNotes,chosen.delay.feedback,chosen.delay.mix]},{drive:[true,'distortion',0.8],delay:[true,1.5,0.5,1]});
  /** Each of three repeats' level against the one before; the note starts at the beginning of the export. */
  const ratios=render=>{const levels=[1,2,3].map(k=>rms(render,0.75*k+0.01,0.75*k+0.25));return levels.slice(1).map((level,k)=>level/levels[k]);};
  const before=await exportWav('drive-then-delay'),again=await exportWav('drive-then-delay-again');
  assert.deepEqual([...before.samples[0]],[...again.samples[0]],'the same order exports the same samples');
  // Drive sits seventh in the default chain; nine moves take it past every block up to the delay.
  for(let move=0;move<9;move++){await panel.getByRole('button',{name:'Move Drive later',exact:true}).click();await settle();}
  assert.deepEqual((await order()).slice(13),['Tremolo','Delay','Drive','Reverb']);
  const after=await exportWav('delay-then-drive');
  const results={before:ratios(before),after:ratios(after),firstRepeat:{before:rms(before,0.76,1.0),after:rms(after,0.76,1.0)}};
  const text=JSON.stringify(results);
  for(const ratio of results.before)assert.ok(ratio>0.3&&ratio<0.7,`the drive before the delay leaves each repeat about half the last: ${text}`);
  for(const ratio of results.after)assert.ok(ratio>0.8,`the drive after the delay squeezes the repeats up: ${text}`);
  // The panel recorded the order as a sound edit.
  const effects=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects;
  assert.deepEqual(effects.order,['microphone','gate','compressor','wah','octaver','pitch','amp','cabinet','eq','vibrato','phaser','flanger','chorus','tremolo','delay','drive','reverb']);
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');assert.deepEqual((await order()).slice(13),['Tremolo','Drive','Delay','Reverb']);
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'effect-order-result.json'),JSON.stringify(results,null,2));
  console.log('Effect order passed:',text);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
