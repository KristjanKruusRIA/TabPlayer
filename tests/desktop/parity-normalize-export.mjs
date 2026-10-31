import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Normalization: Normalize in the Export dialog sets a mixed export to the chosen RMS level over both channels, and
// never lets a peak pass -1 dBFS. Without it the export is written as before.
const fixture=resolve(directory,'normalize-export-fixture.gp');
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
/** RMS over both channels of the whole file and the sample peak, in dB relative to full scale, of a 16- or 24-bit stereo WAV. */
function levels(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const bits=bytes.readUInt16LE(34),width=bits/8,count=bytes.readUInt32LE(40)/width;let sum=0,peak=0;
  for(let i=0;i<count;i++){const at=44+i*width,v=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;sum+=v*v;peak=Math.max(peak,Math.abs(v));}
  return {rmsDb:10*Math.log10(sum/count),peakDb:20*Math.log10(peak),frames:count/2};
}
const folder=join(directory,`export-${Date.now()}-normalize`);await mkdir(folder,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:fixture,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+20000;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`Native status timed out: ${JSON.stringify(last)}`);};
  await button('Open');await waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);
  /** Exports mixed 24-bit WAV through the dialog, normalized to `level` when given, and measures it. */
  const exportAudio=async({name,level})=>{
    await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('wav');
    await dialog.getByRole('radio',{name:'24 bit'}).click();
    if(level!==undefined){await dialog.getByLabel('Normalize',{exact:true}).check();await dialog.getByLabel('Normalized level (dB RMS)').fill(String(level));}
    await dialog.getByLabel('File name',{exact:true}).fill(name);await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const file=join(folder,`${name}.wav`),deadline=Date.now()+120000;
    while(Date.now()<deadline&&!existsSync(file)){const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());await new Promise(r=>setTimeout(r,200));}
    assert.ok(existsSync(file),`${name}.wav was written`);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await waitForWorkspaceIdle(page);
    await new Promise(r=>setTimeout(r,300));return levels(await readFile(file));
  };
  const results={plain:await exportAudio({name:'plain'})};
  for(const level of [-24,-16,-10])results[level]=await exportAudio({name:`normalized${-level}`,level});
  const text=JSON.stringify(results);
  for(const level of [-24,-16,-10]){
    const r=results[level];assert.equal(r.frames,results.plain.frames,text);assert.ok(r.peakDb<=-0.99,`no peak passes -1 dBFS: ${text}`);
    // The level is reached unless the peak ceiling holds it lower.
    if(results.plain.peakDb+(level-results.plain.rmsDb)<=-1)assert.ok(Math.abs(r.rmsDb-level)<0.05,`${level} dB RMS reached: ${text}`);
    else assert.ok(Math.abs(r.peakDb+1)<0.05&&r.rmsDb<level,`${level} held at the -1 dBFS ceiling: ${text}`);
    // The crest factor is unchanged: normalization is one gain.
    assert.ok(Math.abs((r.peakDb-r.rmsDb)-(results.plain.peakDb-results.plain.rmsDb))<0.05,`one gain: ${text}`);
  }
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'normalize-export-result.json'),JSON.stringify(results,null,2));
  console.log('Normalized export passed:',text);
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
