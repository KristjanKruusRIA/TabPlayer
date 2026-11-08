import assert from 'node:assert/strict';
import { launch,connect,stop } from './harness.mjs';
import { closeWelcomeLibrary,clickWorkstationButton,revealInspectorTab,waitForWorkspaceIdle } from './workstation-commands.mjs';

// THE-194: an edit rebuilds the native playback plan; a loop that was running must be armed again on the new plan.
const BAR=3840;
const id=launch();
let browser,page;
try {
  browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async(predicate,label,timeout=15000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(40);}throw new Error(`${label}: ${JSON.stringify(last)}`);};
  const loopButton=page.getByRole('button',{name:/^(Loop|Clear loop)$/});
  const message=()=>page.locator('.transport-messages').allTextContents();
  const edit=async fret=>{await revealInspectorTab(page,'Selection');await page.getByLabel('Fret',{exact:true}).fill(String(fret));await page.getByRole('button',{name:'Set note',exact:true}).click();await waitForWorkspaceIdle(page);};
  await waitStatus(value=>value.ready&&!value.error,'ready');
  const result={};

  // Loop bars 2 to 3, then fix a note: the loop must come back on the rebuilt plan.
  await page.getByLabel('Loop start',{exact:true}).fill('2');await page.getByLabel('Loop end',{exact:true}).fill('3');await loopButton.click();
  const armed=await waitStatus(value=>value.loop?.startTick===BAR&&value.loop?.endTick===3*BAR,'loop armed');
  await edit(7);
  const afterEdit=await waitStatus(value=>value.ready&&value.generation>armed.generation&&value.loop?.startTick===BAR&&value.loop?.endTick===3*BAR,'loop after edit');
  assert.equal(await loopButton.getAttribute('aria-pressed'),'true');
  assert.equal(await loopButton.textContent(),'Clear loop');
  assert.deepEqual(await message(),[]);
  result.editKeptLoop={generationBefore:armed.generation,generationAfter:afterEdit.generation,loop:afterEdit.loop};

  // Undo rebuilds the plan again; the loop still stands.
  await clickWorkstationButton(page,'Undo');
  const afterUndo=await waitStatus(value=>value.ready&&value.generation>afterEdit.generation&&value.loop?.startTick===BAR&&value.loop?.endTick===3*BAR,'loop after undo');
  result.undoKeptLoop={generation:afterUndo.generation,loop:afterUndo.loop};

  // The loop still plays: start it and see the position stay inside the two bars.
  await clickWorkstationButton(page,'Play',{waitForIdle:false});
  const playing=await waitStatus(value=>value.playing&&value.tick>=BAR&&value.tick<3*BAR,'playing inside the loop');
  await clickWorkstationButton(page,'Pause',{waitForIdle:false});
  result.playedInsideLoop={tick:playing.tick};

  // Clearing the loop, then editing, must not bring it back.
  await loopButton.click();await waitStatus(value=>value.loop===null,'loop cleared');
  await edit(5);
  await waitStatus(value=>value.ready&&value.generation>afterUndo.generation,'ready after second edit');
  assert.equal((await status()).loop,null);assert.equal(await loopButton.getAttribute('aria-pressed'),'false');
  result.clearedLoopStaysCleared=true;
  console.log(JSON.stringify(result));
} finally {try{stop(id);}finally{if(browser)await browser.close();}}
