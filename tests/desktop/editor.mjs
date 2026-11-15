import { readActiveDocument } from './document-context.mjs';
import { closeWelcomeLibrary,clickWorkstationButton,setFret,scoreWorkspace,cursorPosition,waitForWorkspaceIdle } from './workstation-commands.mjs';
import { launch,connect,stop } from './harness.mjs';
import assert from 'node:assert/strict';
const id=launch();
let browser,page;
const idle=()=>waitForWorkspaceIdle(page);
const snapshot=()=>readActiveDocument(page);
try {
  browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await idle();
  // The Fret field and Set note are gone: the command palette's 'fret N' writes the fret on the cursor string (one setNote).
  await setFret(page,7);await idle();
  await clickWorkstationButton(page,'Add track');
  await clickWorkstationButton(page,'Track 2: Bass');
  await setFret(page,3);await idle();
  await clickWorkstationButton(page,'Track 1: Guitar');
  // The cursor leaves beat 1 (the old Beat field), so the click on the written note has to bring it back.
  await scoreWorkspace(page).focus();await page.keyboard.press('ArrowRight');const moved=(await cursorPosition(page)).text;
  const note=page.getByText('7',{exact:true});await note.waitFor();await note.click();
  // The status bar reads the cursor: the click put it back on beat 1, whose note is the fret written first.
  assert.notEqual((await cursorPosition(page)).text,moved);assert.equal((await cursorPosition(page)).bar,1);assert.equal((await cursorPosition(page)).beat,1);
  assert.match(await page.getByTestId('status-value').innerText(),/^Fret 7/);
  assert.equal((await snapshot()).project.edits.length,3);
  await page.screenshot({path:'.analysis/editor-two-tracks.png'});
  console.log('Native editor: two tracks, fret entry, real rendered note selection, native command history passed.');
} finally {try{stop(id);}finally{if(browser)await browser.close();}}
