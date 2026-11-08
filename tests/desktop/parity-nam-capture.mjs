import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile,rm,writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// NAM capture in the amp slot: a user imports a .nam file, chooses it for the track's amp, plays it, undoes and redoes the
// choice, saves and reopens the document, and hears the capture in the exported WAV. With the file deleted from the library,
// the document reopens unchanged, says the built-in amp plays instead, and still exports sound. The file picker is replaced by
// TABPLAYER_TEST_NAM_CAPTURE, a list of paths joined by `|`. The audio status carries no non-finite counter. The live
// output peak cannot see a NaN (it is a running f64 `max`, which skips NaN), so the real guard is the WAV writer, which refuses to write
// a non-finite sample (export/wav.rs) and fails the export. Samples read back from a 16 or 24 bit WAV are always finite, so the
// per-sample finite check below cannot catch one; it only confirms the files decode. The live checks show no native error
// and a peak above the floor.
const fixture=resolve(directory,'nam-capture-fixture.gp');
const capture=resolve('src-tauri/tests/fixtures/nam/wavenet.nam');
const run=resolve(directory,`nam-capture-${Date.now()}`),exportDir=join(run,'export'),appData=join(run,'app-data'),saved=join(run,'saved');
await mkdir(exportDir,{recursive:true});await mkdir(appData,{recursive:true});
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<2;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;
    if(index===0)for(const [string,fret] of [[1,0],[3,2]]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
    voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
function channels(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const rate=bytes.readUInt32LE(24),bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=[new Float64Array(frames),new Float64Array(frames)];
  for(let i=0;i<frames;i++)for(let c=0;c<2;c++){const at=44+(i*2+c)*width;out[c][i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return {samples:out,rate};
}
/** RMS and peak over 0.3 to 1.4 s of both channels; every sample must be finite. */
const stats=({samples:[l,r],rate})=>{let sum=0,peak=0,n=0;for(let i=Math.round(rate*.3);i<Math.round(rate*1.4);i++){for(const v of [l[i],r[i]]){assert.ok(Number.isFinite(v),'finite sample');sum+=v*v;peak=Math.max(peak,Math.abs(v));n++;}}return {rms:Math.sqrt(sum/n),peak};};

let id=null,browser=null;const results={};
const open=async(env,file)=>{
  id=launch({TABPLAYER_TEST_OPEN:file,TABPLAYER_TEST_EXPORT_DIR:exportDir,TABPLAYER_TEST_APP_DATA_DIR:appData,TABPLAYER_TEST_SAVE:saved,...env});
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
    while(Date.now()<deadline&&!(file=(await readdir(exportDir)).find(entry=>entry===`${name}.wav`))){
      const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(file,`${name}.wav was written`);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await waitForWorkspaceIdle(page);
    await new Promise(r=>setTimeout(r,300));return readFile(join(exportDir,file));
  };
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
  const details=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Amp$/})});
  if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  return {page,button,status,waitStatus,exportWav,panel,errors};
};
const amp=async page=>(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').at(-1)?.sound.effects.amp;
const close=async()=>{try{if(browser)await browser.close();}finally{browser=null;if(id!==null)stop(id);id=null;}};
const play=async a=>{await a.button('Play');const s=await a.waitStatus(s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error);assert.ok(Number.isFinite(s.outputPeak),'finite output peak');await a.button('Stop');return s.outputPeak;};

try{
  // ---- First run: import, choose, play, undo, redo, export, save.
  let a=await open({TABPLAYER_TEST_NAM_CAPTURE:capture},fixture);
  const box=a.panel.getByLabel('Enable amp',{exact:true});await box.click();await waitForWorkspaceIdle(a.page);assert.equal(await box.isChecked(),true);
  const builtin=await a.exportWav('builtin'),plain=stats(channels(builtin));
  assert.ok(plain.rms>.001,'built-in amp export is not silent');
  const picker=a.panel.getByRole('combobox',{name:'Amp capture',exact:true});
  assert.equal(await picker.inputValue(),'');
  await a.panel.getByRole('button',{name:'Import capture…',exact:true}).click();await waitForWorkspaceIdle(a.page);
  let chosen;{const deadline=Date.now()+20000;while(Date.now()<deadline&&!(chosen=(await amp(a.page))?.capture))await a.page.waitForTimeout(100);assert.ok(chosen,'capture chosen');}
  assert.match(chosen.id,/^[0-9a-f]{32}$/);assert.equal(chosen.name,'wavenet');assert.equal(chosen.levelDb,0);
  assert.equal(await picker.inputValue(),chosen.id);
  assert.deepEqual((await readdir(join(appData,'nam-captures'))).sort(),[`${chosen.id}.json`,`${chosen.id}.nam`]);
  assert.equal(await a.panel.locator('.sound-ir-notice').count(),0,'no notice while the library has the capture');
  await a.waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);
  results.peakLive=await play(a);
  const withCapture=await a.exportWav('capture'),cs=stats(channels(withCapture));
  assert.ok(cs.rms>.001,`capture export is not silent: ${JSON.stringify(cs)}`);
  assert.ok(!withCapture.equals(builtin),'the capture replaces the built-in amp');
  results.export={builtin:plain,capture:cs};
  await a.button('Undo');assert.equal((await amp(a.page))?.capture,undefined,'undo removes the capture');assert.equal(await picker.inputValue(),'');
  await a.button('Redo');assert.deepEqual((await amp(a.page)).capture,chosen);assert.equal(await picker.inputValue(),chosen.id);
  assert.ok(withCapture.equals(await a.exportWav('capture-redo')),'redo exports the same audio');
  assert.deepEqual(a.errors,[]);
  await a.button('Save');const savedPath=`${saved}.tabplayer`;assert.ok(existsSync(savedPath));
  const project=JSON.parse(await readFile(savedPath,'utf8'));
  assert.deepEqual(project.edits.filter(e=>e.type==='setTrackSound').at(-1).sound.effects.amp.capture,chosen);
  assert.ok(!(await readFile(savedPath)).includes('"weights"'),'the document holds no model');
  await close();

  // ---- Reopen with the library intact.
  a=await open({},savedPath);
  assert.deepEqual((await amp(a.page)).capture,chosen,'reopened document names the capture');
  assert.equal(await a.panel.locator('.sound-ir-notice').count(),0);
  assert.equal(await a.panel.getByRole('combobox',{name:'Amp capture',exact:true}).inputValue(),chosen.id);
  assert.ok(withCapture.equals(await a.exportWav('capture-reopen')),'reopened document exports the same audio');
  await close();

  // ---- Delete the library file, reopen: notice, document unchanged, still sound.
  await rm(join(appData,'nam-captures'),{recursive:true,force:true});
  const before=await readFile(savedPath);
  a=await open({},savedPath);
  const doc=await readActiveDocument(a.page);
  assert.deepEqual(doc.project.edits.filter(e=>e.type==='setTrackSound').at(-1).sound.effects.amp.capture,chosen,'document keeps its reference');
  const notice=a.panel.locator('.sound-ir-notice').first();await notice.waitFor();
  const text=await notice.innerText();assert.match(text,/“wavenet” is not in this computer's capture library, so the built-in amp plays instead/);
  results.notice=text;
  const missing=await a.exportWav('missing'),fallback=stats(channels(missing));assert.ok(fallback.rms>.001,'fallback is not silent');
  results.export.missing=fallback;results.missingEqualsBuiltin=missing.equals(builtin);
  assert.equal(results.missingEqualsBuiltin,true,'a missing capture exports exactly the built-in amp');
  await play(a);
  assert.deepEqual((await readActiveDocument(a.page)).project,doc.project,'viewing changes nothing');
  assert.ok((await readFile(savedPath)).equals(before),'saved file untouched');
  assert.deepEqual(a.errors,[]);
  await writeFile(join(directory,'nam-capture-result.json'),JSON.stringify(results,null,2));
  console.log('NAM capture passed:',JSON.stringify(results));
}finally{await close();}
