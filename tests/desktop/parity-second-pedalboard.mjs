import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Second pedalboard: Duplicate pedal puts a copy of the graphic EQ on a second pedalboard after the chain, as one
// track-sound edit. In exported WAVs of a chord, a −6 dB level on the graphic EQ lowers the export by 6 dB, its
// duplicate lowers it by 6 dB more, and setting the duplicate's level back to 0 dB restores the single EQ's level
// without touching the first. Removing the duplicate removes the second pedalboard. It plays live without errors,
// and Undo brings the duplicate back.
const fixture=resolve(directory,'second-pedalboard-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // A sustained E2, B2 and E3 together, then a bar of rest.
  for(let index=0;index<2;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;
    if(index===0)for(const [string,fret] of [[1,0],[2,2],[3,2]]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
    voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
/** Both channels of a 16- or 24-bit stereo PCM WAV as numbers in -1..1, with the sample rate. */
function channels(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const rate=bytes.readUInt32LE(24),bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=[new Float64Array(frames),new Float64Array(frames)];
  for(let i=0;i<frames;i++)for(let c=0;c<2;c++){const at=44+(i*2+c)*width;out[c][i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return {samples:out,rate};
}
/** The mid channel's RMS level in dBFS from 0.1 to 1.5 s. */
const level=({samples:[l,r],rate})=>{const a=Math.round(rate*.1),b=Math.round(rate*1.5);let sum=0;for(let i=a;i<b;i++)sum+=((l[i]+r[i])/2)**2;return 10*Math.log10(sum/(b-a));};
const folder=join(directory,`export-${Date.now()}-second-pedalboard`);await mkdir(folder,{recursive:true});
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
    await new Promise(r=>setTimeout(r,300));return level(channels(await readFile(join(folder,file))));
  };
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const lastSound=async()=>(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1)?.sound;
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Graphic EQ$/})}).first();
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  const results={};
  results.dry=await exportWav('dry');
  await panel.getByLabel('Enable graphicEq',{exact:true}).click();await waitForWorkspaceIdle(page);
  await panel.getByLabel('graphicEq Level (dB)',{exact:true}).fill('-6');await waitForWorkspaceIdle(page);
  results.single=await exportWav('single');
  await panel.getByRole('button',{name:'Duplicate pedal: Graphic EQ',exact:true}).click();await waitForWorkspaceIdle(page);
  await panel.getByRole('status').filter({hasText:'Duplicated the Graphic EQ pedal onto the second pedalboard.'}).waitFor();
  const duplicated=await lastSound();
  assert.deepEqual(duplicated.effects.second.graphicEq,duplicated.effects.graphicEq);
  assert.equal(duplicated.effects.second.graphicEq.levelDb,-6);
  results.doubled=await exportWav('doubled');
  const board=panel.getByRole('region',{name:'Second pedalboard',exact:true});
  const copy=board.locator('details.sound-block').first();if(!await copy.evaluate(node=>node.open))await copy.locator('summary').click();
  await board.getByLabel('Second pedalboard: graphicEq Level (dB)',{exact:true}).fill('0');await waitForWorkspaceIdle(page);
  const independent=await lastSound();
  assert.equal(independent.effects.second.graphicEq.levelDb,0);assert.equal(independent.effects.graphicEq.levelDb,-6);
  results.unity=await exportWav('unity');
  const text=JSON.stringify(results);
  assert.ok(Math.abs(results.single-results.dry+6)<.1,`the EQ level lowers the export by 6 dB: ${text}`);
  assert.ok(Math.abs(results.doubled-results.single+6)<.1,`the duplicate lowers it by 6 dB more: ${text}`);
  assert.ok(Math.abs(results.unity-results.single)<.05,`the duplicate at 0 dB leaves the single EQ's level: ${text}`);
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);
  await board.getByRole('button',{name:'Remove duplicate: Graphic EQ',exact:true}).click();await waitForWorkspaceIdle(page);
  assert.equal(Object.hasOwn((await lastSound()).effects,'second'),false);
  await board.waitFor({state:'detached'});
  await waitStatus(s=>s.playing&&!s.error);await button('Stop');
  await button('Undo');assert.equal((await lastSound()).effects.second.graphicEq.enabled,true);
  await board.waitFor();
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'second-pedalboard-result.json'),JSON.stringify(results,null,2));
  console.log('Second pedalboard passed:',text);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
