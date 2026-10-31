import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Tempo sync: the Sound task's Tremolo tempo sync records a quarter note per cycle as a track-sound edit and disables
// the free rate. In an exported WAV of a held organ chord whose tempo falls from 120 to 60 bpm, the synced tremolo
// pulses at 2 Hz and then 1 Hz, while a free 3 Hz tremolo keeps 3 Hz through the change. It plays live without errors,
// and Undo restores the sync.
const fixture=resolve(directory,'tempo-sync-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Organ';track.playbackInfo.program=16;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // Two bars at 120 bpm and two at 60 bpm of an A3 and E4 chord, then a bar of rest.
  for(let index=0;index<5;index++){
    const master=new model.MasterBar();
    if(index===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
    if(index===2)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,60,2)];
    score.addMasterBar(master);const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;
    if(index<4)for(const [string,fret] of [[3,2],[2,5]]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
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
/** The tremolo's rate in hertz between two times in seconds, from the times of its troughs: the quietest 20 ms of each
 * stretch where the level falls below a quarter of the loudest 20 ms, until it rises past half of it again. Also
 * returns how many troughs it found. */
function pulseRate({samples:[l,r],rate},from,to){
  const step=Math.round(rate*.02),levels=[];
  for(let at=Math.round(rate*from);at+step<=Math.round(rate*to);at+=step){let sum=0;for(let i=at;i<at+step;i++)sum+=((l[i]+r[i])/2)**2;levels.push({time:at/rate,level:Math.sqrt(sum/step)});}
  const loud=Math.max(...levels.map(entry=>entry.level)),troughs=[];let low=null;
  for(const entry of levels){
    if(low?entry.level<loud/2:entry.level<loud/4){if(!low||entry.level<low.level)low=entry;}
    else if(low){troughs.push(low.time);low=null;}
  }
  assert.ok(troughs.length>=3,`found troughs between ${from} and ${to} s: ${troughs}`);
  return {hz:(troughs.length-1)/(troughs.at(-1)-troughs[0]),troughs:troughs.length};
}
const folder=join(directory,`export-${Date.now()}-tempo-sync`);await mkdir(folder,{recursive:true});
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
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Tremolo$/})});
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  const box=panel.getByLabel('Enable tremolo',{exact:true}),sync=panel.getByLabel('Tremolo tempo sync',{exact:true}),rate=panel.getByLabel('tremolo Rate (Hz)',{exact:true});
  await box.click();await waitForWorkspaceIdle(page);assert.equal(await box.isChecked(),true);
  await panel.getByLabel('tremolo Depth',{exact:true}).fill('1');await waitForWorkspaceIdle(page);
  await sync.selectOption('1');await waitForWorkspaceIdle(page);assert.equal(await rate.isDisabled(),true);
  const synced=await exportWav('synced-quarter');
  const recorded=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.tremolo;
  assert.deepEqual(recorded,{enabled:true,rateHz:5,depth:1,shape:'sine',syncQuarterNotes:1});
  await sync.selectOption('0');await waitForWorkspaceIdle(page);assert.equal(await rate.isDisabled(),false);
  await rate.fill('3');await waitForWorkspaceIdle(page);
  const free=await exportWav('free-3hz');
  // Bars 1 and 2 play from 0 to 4 s at 120 bpm, bars 3 and 4 from 4 to 12 s at 60 bpm.
  const results={synced:{fast:pulseRate(synced,.1,3.9),slow:pulseRate(synced,4.1,11.9)},free:{fast:pulseRate(free,.1,3.9),slow:pulseRate(free,4.1,11.9)}};
  const text=JSON.stringify(results);
  assert.ok(Math.abs(results.synced.fast.hz-2)<.05&&Math.abs(results.synced.slow.hz-1)<.03,`a quarter-note tremolo follows the tempo: ${text}`);
  assert.ok(Math.abs(results.free.fast.hz-3)<.05&&Math.abs(results.free.slow.hz-3)<.05,`a free tremolo keeps its rate: ${text}`);
  const final=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.tremolo;
  assert.deepEqual(final,{enabled:true,rateHz:3,depth:1,shape:'sine'});
  await button('Play');await waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);await button('Stop');
  await button('Undo');await button('Undo');assert.equal(await sync.inputValue(),'1');assert.equal(await rate.isDisabled(),true);
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'tempo-sync-result.json'),JSON.stringify(results,null,2));
  console.log('Tempo sync passed:',text);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
