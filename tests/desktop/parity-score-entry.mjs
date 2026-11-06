import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// E05/W19 note entry on the rendered score: with Note entry on, clicking a line or space of the notation staff writes
// that pitch on the clicked beat as one native edit that one Undo removes, and the pointer previews the pitch first;
// letters type a melody that advances beat by beat and into the next bar; + and . change the rhythm; a semitone move
// spelled flat is one edit that keeps the note on its string. Screenshots: score-entry-ghost.png and score-entry-after.png.
const fixture=resolve(directory,'score-entry-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<3;index++){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;
    for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;value.isEmpty=false;voice.addBeat(value);}
    bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await idle();await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const edits=async()=>(await readActiveDocument(page)).project.edits;
  const workspace=page.getByRole('region',{name:'Score workspace'});
  const caret=()=>page.locator('.score-edit-target').boundingBox();
  const stepsOf=edit=>edit.type==='sequence'?edit.commands.map(step=>step.type):[edit.type];

  const toggle=page.getByRole('button',{name:'Note entry',exact:true});
  await toggle.click();await idle();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
  await page.getByText(/Note entry is on/).waitFor();

  // The notation staff's five lines are the first five thin, wide rectangles of the first system, top to bottom.
  const lines=await page.evaluate(()=>{
    const rects=[...document.querySelectorAll('[aria-label="Music notation"] svg rect')].map(rect=>rect.getBoundingClientRect()).filter(box=>box.height>0&&box.height<2.5&&box.width>40);
    const ys=[...new Set(rects.map(box=>Math.round((box.y+box.height/2)*10)/10))].sort((a,b)=>a-b);return ys.slice(0,5);
  });
  assert.equal(lines.length,5,`five notation lines found (${lines})`);
  const space=(lines[4]-lines[0])/8,first=await caret();assert.ok(first,'edit target shown');
  const x=first.x+first.width/2,at=step=>lines[4]-step*space;

  // Hovering previews the pitch on the line or space under the pointer.
  const ghost=page.locator('.score-entry-ghost-label');
  for(const [step,name] of [[0,'E4'],[1,'F4'],[2,'G4'],[8,'F5'],[10,'A5'],[-2,'C4']]){await page.mouse.move(x,at(step));await ghost.waitFor();assert.equal(await ghost.textContent(),name,`preview at step ${step}`);}
  await page.mouse.move(x,at(2));await page.screenshot({path:resolve(directory,'score-entry-ghost.png')});

  // A click on the G line writes G4 on the first beat as one edit and moves on; one Undo removes it.
  await page.mouse.click(x,at(2));await idle();
  let list=await edits();assert.equal(list.length,1,'one click is one edit');
  assert.deepEqual([list[0].type,list[0].target],['setNote',{track:0,staff:0,bar:0,voice:0,beat:0}]);
  const moved=await caret();assert.ok(moved.x>first.x+1,'the cursor advanced to the next beat');
  await workspace.focus();await page.keyboard.press('Control+z');await idle();assert.deepEqual(await edits(),[],'one Undo removes the clicked note');

  // Typing a melody from the first beat: each letter is one edit, the cursor runs on into the next bar.
  await workspace.focus();for(let index=0;index<4;index++)await page.keyboard.press('ArrowLeft');
  for(const key of ['c','d','e','f','g']){await page.keyboard.press(key);await idle();}
  list=await edits();assert.equal(list.length,5,'five letters, five edits');assert.ok(list.every(edit=>edit.type==='setNote'));
  assert.deepEqual(list.map(edit=>[edit.target.bar,edit.target.beat]),[[0,0],[0,1],[0,2],[0,3],[1,0]]);

  // + makes the next beat shorter and . dots it, each one edit.
  await page.keyboard.press('+');await idle();await page.keyboard.press('.');await idle();
  list=await edits();assert.deepEqual(list.slice(-2).map(edit=>[edit.type,edit.duration,edit.dots]),[['setDuration',8,0],['setDuration',8,1]]);

  // A semitone down from the G just typed is spelled G flat: removal, note and spelling in one edit, one Undo.
  await page.keyboard.press('ArrowLeft');await idle();const before=(await edits()).length;
  await page.keyboard.press('Alt+Shift+ArrowDown');await idle();list=await edits();
  assert.equal(list.length,before+1,'a semitone move is one edit');assert.deepEqual(stepsOf(list.at(-1)),['setNote','setNoteSpelling'],'the note moves along its string, spelled flat');
  await page.screenshot({path:resolve(directory,'score-entry-after.png')});
  await page.keyboard.press('Control+z');await idle();assert.equal((await edits()).length,before,'one Undo takes the whole move back');

  // Turning entry off gives letters back to nothing and clicks back to selecting.
  await page.keyboard.press('n');await idle();assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  await page.keyboard.press('a');await idle();assert.equal((await edits()).length,before,'letters write nothing with entry off');
  assert.deepEqual(errors,[]);
  console.log('score entry: preview names lines and spaces; a click wrote G4 as one edit and one undo removed it; five letters wrote five edits across the barline; + and . changed the rhythm; a flat move was one edit.');
}finally{await browser?.close().catch(()=>{});stop(id);}
