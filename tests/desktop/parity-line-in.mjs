import {waitForWorkspaceIdle,closeWelcomeLibrary,clickWorkstationButton,clickWorkspaceCommand} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';

// Line-In (A28, A29): the desktop-test build offers a synthesized "Test tone" input. Monitoring it from the Practice
// tools must reach the native output with the Line-In's own sound and level, keep going while the score plays and the
// tools are closed, and stop on Stop.
const id=launch({TABPLAYER_LINE_IN_TEST_TONE:'220'});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const invoke=(command,args)=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
  const until=async(read,predicate,label,timeout=10000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await read();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`${label} timed out: ${JSON.stringify(last)}`);};
  const lineIn=()=>invoke('line_in_status');
  assert.ok((await invoke('line_in_inputs')).some(input=>input.id==='test-tone'),'the test input is listed');
  await clickWorkstationButton(page,'Practice',{waitForIdle:false});
  const panel=page.locator('summary').filter({hasText:/^Line-In$/}).locator('..');await panel.evaluate(node=>{node.open=true;});
  await panel.getByRole('option',{name:'Test tone'}).waitFor({state:'attached'});
  await panel.getByLabel('Input').selectOption('test-tone');await panel.getByLabel('Sound').selectOption('preset:clean');
  await panel.getByRole('button',{name:'Start monitoring'}).click();
  // The output level is measured in the output callback, where the Line-In joins the device stream.
  const heard=await until(lineIn,s=>s.running&&s.latencyMs!==null&&s.outputLevel>-40,'Line-In monitoring');
  await panel.getByText(/^Latency about \d+ ms$/).waitFor();
  // Quieter at a lower level.
  await panel.getByRole('slider',{name:/^Level/}).fill('0.2');
  // Audible but quieter. Levels are peaks since the previous status read, and the panel reads too, so a single read
  // can find an empty window and say -120; that is not a dropout (the underrun counter is asserted below).
  const quieter=await until(lineIn,s=>s.outputLevel>-60&&s.outputLevel<heard.outputLevel-6,'lower level');
  // The score plays alongside, and the Line-In carries on unchanged.
  await clickWorkstationButton(page,'Play',{waitForIdle:false});
  await until(()=>invoke('audio_status'),s=>s.playing,'score playing');
  const whilePlaying=await until(lineIn,s=>s.running&&s.outputLevel>-60&&Math.abs(s.outputLevel-quieter.outputLevel)<3,'Line-In while the score plays');
  await clickWorkstationButton(page,'Stop',{waitForIdle:false});await until(()=>invoke('audio_status'),s=>!s.playing,'score stopped');
  // Closing the Practice tools keeps monitoring, so the player can play along.
  await page.locator('details.gp-practice>summary').click();
  assert.equal(await page.locator('details.gp-practice').evaluate(node=>node.open),false);
  await page.waitForTimeout(500);const closed=await lineIn();assert.equal(closed.running,true,'monitoring continues with the tools closed');
  const badge=page.locator('details.gp-practice>summary');
  assert.equal(await badge.getAttribute('aria-label'),'Practice settings, Line-In on');assert.equal(await badge.locator('.line-in-badge').count(),1);
  // A new document remounts the editor; monitoring carries on and the panel picks it up again.
  await clickWorkspaceCommand(page,'New');await waitForWorkspaceIdle(page);
  await page.waitForTimeout(500);const switched=await lineIn();assert.equal(switched.running,true,'monitoring continues in another document');
  // No dropout over the whole run so far: play, close, new document.
  assert.deepEqual([switched.underruns,switched.skips,switched.dropped],[0,0,0],JSON.stringify(switched));
  assert.equal(await badge.getAttribute('aria-label'),'Practice settings, Line-In on');
  await mkdir(resolve('.analysis/parity'),{recursive:true});
  await clickWorkstationButton(page,'Practice',{waitForIdle:false});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:resolve('.analysis/parity/native-line-in.png')});
  await panel.evaluate(node=>{node.open=true;});await panel.getByRole('button',{name:'Stop monitoring'}).click();await panel.getByRole('button',{name:'Start monitoring'}).waitFor();
  assert.equal(await badge.getAttribute('aria-label'),'Practice settings');
  const after=await until(lineIn,s=>!s.running,'Line-In stopped');
  // The sound and level are remembered for next time.
  const remembered=await page.evaluate(()=>JSON.parse(localStorage.getItem('tabplayer.lineIn')));
  assert.deepEqual([remembered.inputId,remembered.choice,remembered.level],['test-tone','preset:clean',0.2]);
  assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);assert.deepEqual(errors,[]);
  const result={heard,quieter:quieter.outputLevel,whilePlaying:whilePlaying.outputLevel,closedRunning:closed.running,switched,after:after.running,remembered};
  await writeFile(join(directory,'line-in-result.json'),JSON.stringify(result,null,2));
  console.log('Line-In passed:',JSON.stringify(result));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
