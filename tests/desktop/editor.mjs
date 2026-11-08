import { readActiveDocument } from './document-context.mjs';
import { closeWelcomeLibrary,clickWorkstationButton,revealInspectorTab,waitForWorkspaceIdle } from './workstation-commands.mjs';
import { launch,connect,stop } from './harness.mjs';
import assert from 'node:assert/strict';
const id=launch();
let browser,page;
const idle=()=>waitForWorkspaceIdle(page);
const selection=()=>revealInspectorTab(page,'Selection');
const snapshot=()=>readActiveDocument(page);
try {
  browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await idle();await selection();
  await page.getByLabel('Fret',{exact:true}).fill('7');await page.getByRole('button',{name:'Set note',exact:true}).click();await idle();
  await clickWorkstationButton(page,'Add track');
  await clickWorkstationButton(page,'Track 2: Bass');await selection();
  await page.getByLabel('Fret',{exact:true}).fill('3');await page.getByRole('button',{name:'Set note',exact:true}).click();await idle();
  await clickWorkstationButton(page,'Track 1: Guitar');await selection();
  await page.getByLabel('Beat',{exact:true}).fill('2');
  const note=page.getByText('7',{exact:true});await note.waitFor();await note.click();
  assert.equal(await page.getByLabel('Beat',{exact:true}).inputValue(),'1');
  assert.equal(await page.getByLabel('Fret',{exact:true}).inputValue(),'7');
  assert.equal((await snapshot()).project.edits.length,3);
  await page.screenshot({path:'.analysis/editor-two-tracks.png'});
  console.log('Native editor: two tracks, fret entry, real rendered note selection, native command history passed.');
} finally {try{stop(id);}finally{if(browser)await browser.close();}}
