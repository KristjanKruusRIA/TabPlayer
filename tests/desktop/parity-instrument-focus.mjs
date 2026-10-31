import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Instrument view focus: while stopped, Show picks the selected beat, the selected bar or the beat after the
// selection; moving the edit target updates it; while paused, Next beat follows the playback position; the
// score is unchanged.
const fixture=resolve(directory,'instrument-focus-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  // Quarter notes on the low E string: frets 0-3 in measure 1, 5-8 in measure 2, 10-13 and 15-18 after.
  for(let index=0;index<4;index++){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;const note=new model.Note();note.string=1;note.fret=index*5+beat;value.addNote(note);voice.addBeat(value);}bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+15000;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(25);}throw new Error(`Native status timed out: ${JSON.stringify(last)}`);};
  await waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);
  const before=await readActiveDocument(page);
  await clickWorkstationButton(page,'Show instrument');
  const view=page.getByRole('region',{name:'Instrument view'}),show=view.getByRole('combobox',{name:'Show'}),workspace=page.getByRole('region',{name:'Score workspace'});
  const frets=()=>view.locator('g[data-note-id]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.fret)).sort((a,b)=>a-b));
  const expectFrets=async(caption,expected)=>{
    await page.waitForFunction(([caption,expected])=>{const nodes=[...document.querySelectorAll('.live-instrument-view g[data-note-id]')].map(node=>Number(node.dataset.fret)).sort((a,b)=>a-b);return document.querySelector(`.live-instrument-view [aria-label="${caption}"]`)&&JSON.stringify(nodes)===JSON.stringify(expected);},[caption,expected],{timeout:10000});
    assert.deepEqual(await frets(),expected,caption);
  };
  const cases={};
  await view.getByText('No notes sounding',{exact:true}).waitFor();
  await show.selectOption('beat');await expectFrets('Notes in the selected beat',[0]);cases.beat=await view.getByLabel('Notes in the selected beat').textContent();
  await show.selectOption('bar');await expectFrets('Notes in the selected bar',[0,1,2,3]);cases.bar=await view.getByLabel('Notes in the selected bar').textContent();
  await show.selectOption('next');await expectFrets('Notes in the next beat',[1]);
  // Moving the edit target moves the focus with it.
  await workspace.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await expectFrets('Notes in the next beat',[3]);
  for(let step=0;step<3;step++)await page.keyboard.press('ArrowRight');await expectFrets('Notes in the next beat',[7]);
  await show.selectOption('bar');await expectFrets('Notes in the selected bar',[5,6,7,8]);
  await show.selectOption('beat');await expectFrets('Notes in the selected beat',[6]);
  // While playing, the selected beat and bar stay put; the next beat follows the playback position rather than the selection.
  await clickWorkstationButton(page,'Play',{waitForIdle:false});await waitStatus(s=>s.playing&&s.tick>4800);
  await show.selectOption('bar');await expectFrets('Notes in the selected bar',[5,6,7,8]);await show.selectOption('beat');await expectFrets('Notes in the selected beat',[6]);assert.equal((await status()).playing,true,'still playing');
  await show.selectOption('next');await waitStatus(s=>s.playing&&s.tick>7800&&s.tick<8600);
  await clickWorkstationButton(page,'Pause',{waitForIdle:false});const paused=await waitStatus(s=>!s.playing);
  // Play starts at the selected beat (fret 6); pausing in measure 3 shows the beat after the pause, not fret 7.
  const onset=Math.floor(paused.tick/960)+1,expected=onset<16?[Math.floor(onset/4)*5+onset%4]:[];
  assert.ok(paused.tick>7680,`paused in measure 3 at ${paused.tick}`);await expectFrets('Notes in the next beat',expected);cases.paused={tick:paused.tick,next:expected};
  await clickWorkstationButton(page,'Stop',{waitForIdle:false});await waitStatus(s=>!s.playing&&s.tick===0);await expectFrets('Notes in the next beat',[7]);
  await show.selectOption('playing');await view.getByText('No notes sounding',{exact:true}).waitFor();
  const after=await readActiveDocument(page);assert.deepEqual(after.project,before.project);assert.equal(after.dirty,before.dirty);
  assert.deepEqual(errors,[]);
  await view.screenshot({path:resolve(directory,'instrument-focus.png')});
  writeFileSync(resolve(directory,'instrument-focus-result.json'),JSON.stringify({fixture,cases,unchanged:true},null,2));
  console.log('Instrument focus passed:',JSON.stringify(cases));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
