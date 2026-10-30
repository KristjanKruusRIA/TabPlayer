import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealDock} from './workstation-commands.mjs';
import {readActiveDocument} from './document-context.mjs';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {exporter,model,Settings} from '@coderline/alphatab';
import {directory,launch,connect,stop} from './harness.mjs';

// A18 master effects: the Mixer's Master strip edits the song-level chain. Each change is one saved, undoable
// `setMaster` edit; the exported WAV is the mix the chain shaped (the overall level scales it, the limiter keeps every
// sample under its ceiling); Undo brings back exactly the unmastered export; and the chain stays usable while playing.
// Build the desktop test app (scripts/build-desktop-test.ps1), copy it to .analysis/desktop-smoke/tabplayer.exe, then:
//   node tests/desktop/parity-master-effects.mjs
const fixture=resolve(directory,'master-effects-fixture.gp');
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
/** The parameters and samples of a 16- or 24-bit stereo WAV, as integers. */
function wav(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const bits=bytes.readUInt16LE(34),width=bits/8,count=bytes.readUInt32LE(40)/width,samples=new Int32Array(count);
  for(let i=0;i<count;i++)samples[i]=bits===16?bytes.readInt16LE(44+i*width):bytes.readIntLE(44+i*width,3);
  return {sampleRate:bytes.readUInt32LE(24),channels:bytes.readUInt16LE(22),bits,samples};
}
const peakOf=pcm=>{let peak=0;for(const sample of pcm.samples)peak=Math.max(peak,Math.abs(sample));return peak/2**(pcm.bits-1);};
const toDb=amplitude=>20*Math.log10(amplitude);
const folder=join(directory,`export-${Date.now()}-master`);await mkdir(folder,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:fixture,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+20000;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`Native status timed out: ${JSON.stringify(last)}`);};
  const edits=async()=>(await readActiveDocument(page)).project.edits;
  await button('Open');await waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);
  assert.deepEqual(await edits(),[],'A new document has no edits, so no master');

  /** Exports a WAV through the dialog and returns it. */
  let count=0;
  const exportWav=async()=>{
    const name=`master-${++count}`,expected=`${name}.wav`;
    await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('wav');
    await dialog.getByLabel('File type').selectOption('wav');await dialog.getByLabel('Sample rate').selectOption('48000');await dialog.getByLabel('Bit depth').selectOption('24');
    await dialog.getByLabel('File name',{exact:true}).fill(name);await dialog.getByText(`Saves as ${name}.wav`,{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const deadline=Date.now()+120000;
    while(Date.now()<deadline&&!existsSync(join(folder,expected))){
      const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(existsSync(join(folder,expected)),`${expected} was written`);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await waitForWorkspaceIdle(page);
    await new Promise(r=>setTimeout(r,300));return wav(await readFile(join(folder,expected)));
  };
  const master=()=>page.getByRole('region',{name:'Master',exact:true});
  /** Waits until the edit log holds `count` edits, then for the workspace to be idle. The idle flag clears before an
   * edit's round trip starts, so idle on its own can be seen before the edit has begun and the next control would
   * commit from the old settings. */
  const settled=async count=>{
    const deadline=Date.now()+20000;let seen;
    while(Date.now()<deadline){seen=(await edits()).length;if(seen===count)break;await page.waitForTimeout(50);}
    assert.equal(seen,count,`the edit log reached ${count} edits`);await waitForWorkspaceIdle(page);
  };
  /** Sets a master slider as a drag does: it follows the draft, then commits once when the gesture ends. */
  const slide=async(label,value)=>{
    await revealDock(page,'Mixer');const wanted=(await edits()).length+1;
    await master().getByRole('slider',{name:label,exact:true}).evaluate((node,value)=>{
      node.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,String(value));
      node.dispatchEvent(new Event('input',{bubbles:true}));node.blur();
    },value);
    await settled(wanted);
  };
  const open=async name=>{await revealDock(page,'Mixer');const summary=master().locator('summary').filter({hasText:new RegExp(`^${name}`)});if(await summary.locator('xpath=..').getAttribute('open')===null)await summary.click();};

  // 1. Untouched: the strip says so, and the export is the unmastered mix.
  await revealDock(page,'Mixer');await master().waitFor();
  await master().getByText('Untouched',{exact:true}).waitFor();
  const plain=await exportWav(),plainPeak=peakOf(plain);
  assert.ok(plainPeak>.02,`the chord is audible (peak ${plainPeak.toFixed(3)})`);
  // The limiter's lowest ceiling is -12 dB, so the fixture has to peak above about -11 dB for it to have work to do.
  assert.ok(toDb(plainPeak)>-11,`the fixture chord peaks at ${toDb(plainPeak).toFixed(2)} dB, too quiet to test the limiter (needs above -11 dB)`);
  assert.deepEqual(await edits(),[],'Exporting never edits');

  // 2. The overall level is one edit, and it scales the export by exactly its gain.
  await slide('Master level',-6);
  let log=await edits();assert.equal(log.length,1);assert.equal(log[0].type,'setMaster');assert.equal(log[0].master.gainDb,-6);
  await master().getByText('Changed',{exact:true}).waitFor();
  const quiet=await exportWav(),quietPeak=peakOf(quiet);
  assert.ok(Math.abs(toDb(quietPeak)-(toDb(plainPeak)-6))<.3,`-6 dB level: peak ${toDb(plainPeak).toFixed(2)} dB became ${toDb(quietPeak).toFixed(2)} dB`);
  await slide('Master level',0);
  assert.equal((await edits()).length,2,'A second drag is a second edit');

  // 3. The limiter keeps every exported sample under its ceiling, 3 dB below where the mix peaks (but not below -12).
  const ceilingDb=Math.max(-12,Math.floor((toDb(plainPeak)-3)*2)/2);
  assert.ok(toDb(plainPeak)>ceilingDb+1,`the unmastered peak ${toDb(plainPeak).toFixed(2)} dB is above the ceiling ${ceilingDb} dB, so the limiter has work to do`);
  // The switch is controlled, so a click, not check(); the summary reads "(on)" once the edit has come back.
  await open('Limiter');await master().getByRole('checkbox',{name:'Limiter on',exact:true}).click();
  await master().locator('summary').filter({hasText:'Limiter (on)'}).waitFor();await settled(3);
  await slide('Master limiter ceiling',ceilingDb);
  log=await edits();assert.equal(log.length,4);
  assert.deepEqual([log.at(-1).master.limiter.enabled,log.at(-1).master.limiter.ceilingDb],[true,ceilingDb]);
  const limited=await exportWav(),limitedPeak=peakOf(limited),ceiling=10**(ceilingDb/20);
  assert.ok(limitedPeak<=ceiling+1/2**(limited.bits-1),`limited peak ${limitedPeak} is at or under the ceiling ${ceiling}`);
  assert.ok(limitedPeak<plainPeak*.95,`the limiter lowered the peak (${plainPeak.toFixed(3)} to ${limitedPeak.toFixed(3)})`);
  assert.ok(limitedPeak>ceiling*.9,`and held it near the ceiling, not far below it (${limitedPeak.toFixed(3)})`);

  // 4. Undo through every master edit brings back the unmastered export, sample for sample.
  for(let index=0;index<4;index++)await button('Undo');
  assert.deepEqual(await edits(),[]);
  const restored=await exportWav();
  assert.equal(restored.samples.length,plain.samples.length);
  let differ=0;for(let i=0;i<plain.samples.length;i++)if(restored.samples[i]!==plain.samples[i])differ++;
  assert.equal(differ,0,'Undo restores the default chain, which is bit for bit the unmastered mix');
  await button('Redo');await button('Redo');await button('Redo');await button('Redo');
  assert.equal((await edits()).length,4,'Redo restores the master edits');

  // 5. The chain changes while playing without stopping or failing playback.
  await button('Play');
  const playing=await waitStatus(s=>s.playing&&s.outputPeak>.001);
  await slide('Master level',-3);
  const during=await status();assert.ok(during.playing&&!during.error&&during.generation===playing.generation,`playback carried on: ${JSON.stringify(during)}`);
  assert.ok(during.outputPeak<=ceiling+1e-4||during.outputPeak<=playing.outputPeak+1e-4,`the playing peak stays under the limiter ceiling (${during.outputPeak})`);
  await button('Stop');

  // 6. Reset puts the chain back to its defaults in one edit.
  const before=(await edits()).length;
  await revealDock(page,'Mixer');await master().getByRole('button',{name:'Reset master',exact:true}).click();await waitForWorkspaceIdle(page);
  log=await edits();assert.equal(log.length,before+1);
  assert.deepEqual([log.at(-1).master.gainDb,log.at(-1).master.limiter.enabled],[0,false]);
  await master().getByText('Untouched',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log(`master effects: level -6 dB scaled the export from ${toDb(plainPeak).toFixed(2)} to ${toDb(quietPeak).toFixed(2)} dB; limiter at ${ceilingDb} dB held it to ${toDb(limitedPeak).toFixed(2)} dB; undo restored ${plain.samples.length} samples exactly; level changed while playing; reset is one edit.`);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
