import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Help: F1 opens help on the topic for the focused area (the score → Editing the score), the Help menu opens
// About and updates, and Check for updates discloses that this build has no update service and the installed
// version. Opening and closing help keeps the unsaved edit, its history and the open tabs, and returns focus.
const version=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8')).version;
const fixture=resolve(directory,'help-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<2;index++){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;const note=new model.Note();note.string=6;note.fret=0;value.addNote(note);voice.addBeat(value);}bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const workspace=page.getByRole('region',{name:'Score workspace'});
  await workspace.focus();await page.keyboard.press('Control+Shift+P');
  const palette=page.getByRole('dialog',{name:'Commands',exact:true});await palette.getByRole('combobox',{name:'Command'}).fill('fret 7');await page.keyboard.press('Enter');
  await palette.waitFor({state:'detached'});await waitForWorkspaceIdle(page);
  const state=async()=>{const document=await readActiveDocument(page),workspaceState=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'));return {edits:document.project.edits.length,dirty:document.dirty,canUndo:document.canUndo,tabs:workspaceState.documents.length};};
  const before=await state();assert.deepEqual({...before,tabs:undefined},{edits:1,dirty:true,canUndo:true,tabs:undefined});

  // With nothing focused, F1 still opens help, on Getting started.
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
  assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
  await page.keyboard.press('F1');
  const help=page.getByRole('dialog',{name:'TabPlayer help',exact:true});await help.waitFor();
  assert.equal(await help.getByRole('button',{name:'Getting started',exact:true}).getAttribute('aria-current'),'true');
  await page.keyboard.press('Escape');await help.waitFor({state:'detached'});
  await workspace.focus();await page.keyboard.press('F1');
  await help.waitFor();
  assert.equal(await help.getByRole('button',{name:'Editing the score',exact:true}).getAttribute('aria-current'),'true');
  assert.match(await help.getByRole('article',{name:'Editing the score'}).textContent(),/command palette/);
  await help.getByRole('button',{name:'About and updates',exact:true}).click();
  await help.getByRole('button',{name:'Check for updates',exact:true}).click();
  assert.equal(await help.getByRole('status').textContent(),`You have TabPlayer ${version}. This build has no update service, so it cannot check for newer versions. Install a newer build to update; your scores are not affected.`);
  await page.keyboard.press('Escape');await help.waitFor({state:'detached'});
  assert.equal(await workspace.evaluate(node=>node===document.activeElement),true,'Closing help returns focus to the score.');
  assert.deepEqual(await state(),before,'Help leaves the edit, its history and the tabs as they were.');

  await page.locator('summary').filter({hasText:/^Help$/}).click();
  await page.getByRole('button',{name:'About and updates',exact:true}).click();
  await help.getByRole('article',{name:'About and updates'}).filter({hasText:`TabPlayer ${version} for desktop.`}).waitFor();
  await help.getByRole('button',{name:'Close',exact:true}).click();await help.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.activeElement!==document.body&&document.activeElement?.isConnected),true,'Closing help from the menu leaves focus in the window.');
  assert.deepEqual(await state(),before);
  assert.deepEqual(errors,[]);
  console.log(`help: F1 opened Getting started with nothing focused and the editing topic from the score; About disclosed version ${version} with no update service; edits and tabs were unchanged.`);
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/help-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
