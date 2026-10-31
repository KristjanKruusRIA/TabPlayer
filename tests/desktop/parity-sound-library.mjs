import {waitForWorkspaceIdle,clickWorkstationButton,revealDock,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Sound library and clipboard: a track's sound is saved by name, a single pedal and the whole sound are copied to
// another track as one undoable sound edit each, the saved sound is applied there too, the library survives a
// restart of the app, and deleting a saved sound asks first and is stored as well.
const fixture=resolve(directory,'sound-library-fixture.gp');
{
  const score=new model.Score();
  for(const [name,program,tunings] of [['Guitar',25,[64,59,55,50,45,40]],['Bass',33,[43,38,33,28]]]){
    const track=new model.Track(),staff=new model.Staff();track.name=name;track.playbackInfo.program=program;staff.stringTuning.tunings=tunings;track.addStaff(staff);score.addTrack(track);
  }
  score.addMasterBar(new model.MasterBar());
  for(const track of score.tracks){const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;const note=new model.Note();note.string=2;note.fret=0;beat.addNote(note);voice.addBeat(beat);bar.addVoice(voice);track.staves[0].addBar(bar);}
  score.finish(new Settings());await writeFile(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const profile=resolve(directory,`profile-sound-library-${Date.now()}`);
async function session(run){
  const id=launch({TABPLAYER_TEST_OPEN:fixture,WEBVIEW2_USER_DATA_FOLDER:profile});let browser;
  try{
    browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await clickWorkstationButton(page,'Open');await waitForWorkspaceIdle(page);
    await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'});
    const click=async(name,scope=panel)=>{await scope.getByRole('button',{name,exact:true}).click();await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
    await run({page,panel,click});
    assert.deepEqual(errors,[]);
  }finally{try{if(browser)await browser.close();}finally{stop(id);}}
}
const result={};
await session(async({page,panel,click})=>{
  const sounds=async()=>(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound');
  // Track 1: a deep square tremolo, saved by name and copied whole and as a pedal.
  const tremolo=panel.locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Tremolo$/})});
  await tremolo.locator('summary').click();
  const depth=panel.getByLabel('tremolo Depth',{exact:true});await depth.fill('0.9');await depth.blur();await waitForWorkspaceIdle(page);
  await panel.getByLabel('Tremolo shape',{exact:true}).selectOption('square');await waitForWorkspaceIdle(page);
  await panel.getByLabel('Enable tremolo',{exact:true}).click();await waitForWorkspaceIdle(page);
  await page.waitForFunction(()=>document.querySelector('[aria-label="Enable tremolo"]')?.checked===true);
  const guitar=(await sounds()).at(-1);assert.equal(guitar.trackId,'base/0');assert.deepEqual(guitar.sound.effects.tremolo,{enabled:true,rateHz:5,depth:.9,shape:'square'});
  await panel.getByLabel('Saved sound name',{exact:true}).fill('Wobble');await click('Save sound');
  assert.equal(await panel.getByRole('status').innerText(),'Saved “Wobble”.');
  await click('Copy sound');await click('Copy pedal: Tremolo');
  // Track 2 has no sound of its own yet; pasting the pedal changes only its tremolo.
  await revealDock(page,'Mixer');await page.getByRole('button',{name:'Track 2: Bass',exact:true}).click();await waitForWorkspaceIdle(page);
  const before=(await sounds()).length;
  await click('Paste pedal: Tremolo');
  let edits=await sounds();assert.equal(edits.length,before+1);
  const pasted=edits.at(-1);assert.equal(pasted.trackId,'base/1');assert.deepEqual(pasted.sound.effects.tremolo,guitar.sound.effects.tremolo);
  assert.equal(pasted.sound.effects.amp.enabled,false);
  await clickWorkstationButton(page,'Undo');await waitForWorkspaceIdle(page);assert.equal((await sounds()).length,before);
  await click('Paste sound');edits=await sounds();assert.equal(edits.length,before+1);
  assert.equal(edits.at(-1).trackId,'base/1');assert.deepEqual(edits.at(-1).sound,guitar.sound);
  await clickWorkstationButton(page,'Undo');await waitForWorkspaceIdle(page);
  await panel.getByLabel('Saved sound',{exact:true}).selectOption('Wobble');await click('Apply saved sound');
  edits=await sounds();assert.equal(edits.at(-1).trackId,'base/1');assert.deepEqual(edits.at(-1).sound,guitar.sound);
  result.copied={pedal:pasted.sound.effects.tremolo,whole:true,applied:true};
});
await session(async({panel,click})=>{
  // After a restart the saved sound is still listed; deleting it asks first.
  const saved=panel.getByLabel('Saved sound',{exact:true});
  assert.deepEqual(await saved.locator('option').allTextContents(),['Choose a saved sound','Wobble']);
  await saved.selectOption('Wobble');await click('Delete saved sound');
  const confirm=panel.getByRole('group',{name:'Delete “Wobble”?',exact:true});await click('Delete',confirm);
  assert.deepEqual(await saved.locator('option').allTextContents(),['No saved sounds yet']);
});
await session(async({panel})=>{
  // The deletion is stored too.
  assert.deepEqual(await panel.getByLabel('Saved sound',{exact:true}).locator('option').allTextContents(),['No saved sounds yet']);
  result.persisted=true;
});
await writeFile(join(directory,'sound-library-result.json'),JSON.stringify(result,null,2));
console.log('Sound library passed:',JSON.stringify(result));
