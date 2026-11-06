import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Edition palette: with a note selected, GP8's articulation, tuplet, ottava, string-number and text controls each make
// one undoable edit that the native core accepts (including the new stringNumber field); Undo removes one edit per
// click; the palette column does not overflow sideways. Screenshots: palette-before.png and palette-after.png.
const fixture=resolve(directory,'edition-palette-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<4;index++){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;
    for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;for(let string=1;string<=6;string++){const note=new model.Note();note.string=string;note.fret=2;value.addNote(note);}voice.addBeat(value);}
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
  const palette=page.getByRole('complementary',{name:'Edition palette'});await palette.waitFor();
  const edits=async()=>(await readActiveDocument(page)).project.edits;
  const button=name=>palette.getByRole('button',{name,exact:true});
  await palette.screenshot({path:resolve(directory,'palette-before.png')});

  const overflow=await palette.evaluate(node=>node.scrollWidth-node.clientWidth);
  assert.ok(overflow<=0,`The palette does not scroll sideways (overflow ${overflow}px).`);
  for(const name of ['Heavy accent','Show string number','Tuplet','8va (octave up)','Text','Strum down','Spell with flat'])
    assert.equal(await button(name).isEnabled(),true,`${name} is usable on a selected note.`);

  const step=async(action,check)=>{const before=(await edits()).length;await action();await idle();const after=await edits();assert.equal(after.length,before+1,'One click is one edit.');check(after.at(-1));};
  await step(()=>button('Heavy accent').click(),edit=>assert.deepEqual([edit.type,edit.patch],['setNoteTechniques',{accent:2}]));
  await step(()=>button('Show string number').click(),edit=>assert.deepEqual(edit.patch,{stringNumber:true}));
  assert.equal(await button('Show string number').getAttribute('aria-pressed'),'true');
  await step(()=>button('8va (octave up)').click(),edit=>assert.equal(edit.type,'setOttava'));
  await step(()=>button('Strum down').click(),edit=>assert.deepEqual(edit.patch,{brushType:2}));
  await step(async()=>{await button('Tuplet').click();await palette.getByRole('menuitemradio',{name:/5:4/}).click();},edit=>assert.deepEqual([edit.type,edit.tupletNumerator,edit.tupletDenominator],['setBeatRhythm',5,4]));
  await step(async()=>{await button('Text').click();const field=palette.getByRole('textbox',{name:'Text'});await field.fill('intro');await field.press('Enter');},edit=>assert.deepEqual(edit,{type:'setBeatText',target:{track:0,staff:0,bar:0,voice:0,beat:0},text:'intro'}));
  await palette.screenshot({path:resolve(directory,'palette-after.png')});

  const count=(await edits()).length;
  await page.getByRole('region',{name:'Score workspace'}).focus();await page.keyboard.press('Control+z');await idle();
  assert.equal((await edits()).length,count-1,'Undo removes one palette edit.');
  assert.deepEqual(errors,[]);
  console.log('edition palette: accent, string number, 8va, strum, tuplet list and text each ran as one native edit; undo removed one; no sideways overflow.');
}finally{await browser?.close().catch(()=>{});stop(id);}
