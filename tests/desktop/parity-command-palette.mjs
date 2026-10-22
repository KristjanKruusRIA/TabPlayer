import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Command palette: Ctrl+Shift+P from the score opens it; typed commands set a fret and a duration, move to a measure and
// change the tempo as ordinary undoable edits; a bad argument is explained and does nothing; Undo runs from
// the palette; Escape closes it and returns focus to the score.
const fixture=resolve(directory,'command-palette-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<4;index++){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;const note=new model.Note();note.string=6;note.fret=0;value.addNote(note);voice.addBeat(value);}bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await idle();await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const workspace=page.getByRole('region',{name:'Score workspace'}),palette=page.getByRole('dialog',{name:'Commands',exact:true}),field=palette.getByRole('combobox',{name:'Command'});
  const edits=async()=>(await readActiveDocument(page)).project.edits;
  const command=async(text,{run=true}={})=>{
    await workspace.focus();await page.keyboard.press('Control+Shift+P');await field.waitFor();
    assert.equal(await field.evaluate(node=>node===document.activeElement),true,'The command field takes focus.');
    await field.fill(text);await page.keyboard.press('Enter');
    if(run){await palette.waitFor({state:'detached'});await idle();}
  };

  await command('fret 7');
  assert.deepEqual((await edits()).map(edit=>[edit.type,edit.string,edit.fret]),[['setNote',6,7]]);
  // A plain beat's rhythm reaches the native engine with tuplet 1/1, which it accepts.
  await command('duration 8');
  assert.deepEqual((await edits()).at(-1),{type:'setBeatRhythm',target:{track:0,staff:0,bar:0,voice:0,beat:0},duration:8,dots:0,tupletNumerator:1,tupletDenominator:1,graceType:0});
  await command('go to measure 3');
  assert.equal(await page.getByLabel('Measure',{exact:true}).inputValue(),'3');
  await command('tempo 90');
  assert.deepEqual((await edits()).at(-1),{type:'setScoreInfo',title:'',artist:'',tempo:90});

  await command('measure 9',{run:false});
  assert.equal(await palette.getByRole('option').first().textContent(),'Go to measure — Type a measure number from 1 to 4.');
  assert.equal(await palette.isVisible(),true,'An invalid command keeps the palette open.');
  await page.keyboard.press('Escape');await palette.waitFor({state:'detached'});
  assert.equal(await workspace.evaluate(node=>node===document.activeElement),true,'Escape returns focus to the score.');
  assert.equal((await edits()).length,3);

  await command('undo');
  assert.deepEqual((await edits()).map(edit=>edit.type),['setNote','setBeatRhythm']);
  await page.waitForFunction(async()=>{const status=await window.__TAURI_INTERNALS__.invoke('audio_status');if(status.error)throw new Error(status.error);return status.ready;},undefined,{timeout:20000});
  assert.deepEqual(errors,[]);
  console.log('command palette: fret, duration, measure and tempo commands ran as undoable edits; a bad measure was explained; undo and Escape behaved.');
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/command-palette-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
