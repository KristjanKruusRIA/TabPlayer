import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Score errors: deleting a beat leaves measure 2 a quarter note short. The inspector lists it, the score
// marks the measure, the list entry selects it, and turning marking off hides the marker and is stored.
// Undo restores the full measure and clears both.
const fixture=resolve(directory,'score-errors-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<3;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;
    for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;const note=new model.Note();note.string=1;note.fret=beat;value.addNote(note);voice.addBeat(value);}
    bar.addVoice(voice);staff.addBar(bar);
  }
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const closeLibrary=async()=>{const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});};
  await closeLibrary();
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const fill=(name,value)=>page.getByLabel(name,{exact:true}).fill(String(value));
  const summary=()=>page.locator('summary').filter({hasText:/^Score errors \(/}).first();
  const open=()=>summary().evaluate(node=>{node.parentElement.open=true;});
  const markers=()=>page.locator('.score-error-bar');
  const message='Measure 2 · Guitar · Voice 1: 1 quarter note missing';
  await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  assert.equal(await summary().textContent(),'Score errors (0)');await open();
  await page.getByText('Every measure is complete.',{exact:true}).waitFor();assert.equal(await markers().count(),0);

  await fill('Measure',2);await fill('Beat',4);await button('Delete beat');
  await page.waitForFunction(()=>[...document.querySelectorAll('summary')].some(node=>node.textContent==='Score errors (1)'));
  await open();const entry=page.getByRole('button',{name:message,exact:true});await entry.waitFor();
  await markers().first().waitFor();assert.equal(await markers().count(),1);
  assert.equal(await markers().first().getAttribute('aria-label'),`Score error: ${message}`);
  const box=await markers().first().boundingBox();assert.ok(box&&box.width>20&&box.height>20,'The marker covers the measure.');

  await fill('Measure',1);await fill('Beat',1);await entry.click();
  assert.equal(await page.getByLabel('Measure',{exact:true}).inputValue(),'2','The entry selects the incomplete measure.');

  const mark=page.getByRole('checkbox',{name:'Mark errors in the score',exact:true});
  assert.equal(await mark.isChecked(),true);await mark.click();await markers().first().waitFor({state:'detached'});
  // A reload ends the desktop recovery session, so the stored viewer preference is checked directly.
  assert.equal(await page.evaluate(()=>localStorage.getItem('tabplayer.scoreErrors.mark')),'off');
  assert.equal(await summary().textContent(),'Score errors (1)','Turning marking off keeps the error listed.');
  await page.waitForTimeout(500);assert.equal(await markers().count(),0);
  await mark.click();await markers().first().waitFor();assert.equal(await markers().count(),1);

  await button('Undo');
  await page.waitForFunction(()=>[...document.querySelectorAll('summary')].some(node=>node.textContent==='Score errors (0)'));
  await markers().first().waitFor({state:'detached'});
  await page.waitForFunction(async()=>{const status=await window.__TAURI_INTERNALS__.invoke('audio_status');if(status.error)throw new Error(status.error);return status.ready;},undefined,{timeout:20000});
  assert.deepEqual(errors,[]);
  console.log(`score errors: "${message}" listed, marked and selectable; marking off is stored; undo clears it.`);
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/score-errors-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
