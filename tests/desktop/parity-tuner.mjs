import {waitForWorkspaceIdle,closeWelcomeLibrary,clickWorkstationButton} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';

// Tuner (U18): the desktop-test build offers a synthesized "Test tone" input. A low A nine cents sharp is played into
// it; the chromatic tuner must name A2 and its cents, and the all-strings tuner must hear the open A string of the
// standard-tuned blank track and leave the others unheard.
const sharp=110*2**(9/1200);
const id=launch({TABPLAYER_TUNER_TEST_TONE:String(sharp)});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Native contract first.
  const native=await page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;const inputs=await invoke('tuner_inputs');await invoke('tuner_start',{inputId:'test-tone'});
    let reading;for(let attempt=0;attempt<60;attempt++){await new Promise(done=>setTimeout(done,100));reading=await invoke('tuner_read',{strings:[]});if(reading.pitch)break;}
    const open=[329.63,246.94,196,146.83,110,82.41];let strings;for(let attempt=0;attempt<60;attempt++){await new Promise(done=>setTimeout(done,100));strings=(await invoke('tuner_read',{strings:open})).strings;if(strings[4]!==null)break;}
    await invoke('tuner_stop',{session:null});const after=await invoke('tuner_read',{strings:[]});return {inputs,reading,strings,after};});
  assert.ok(native.inputs.some(input=>input.id==='test-tone'),JSON.stringify(native.inputs));
  assert.ok(native.reading.pitch,'the test tone is heard');
  const cents=1200*Math.log2(native.reading.pitch.frequency/110);
  assert.ok(Math.abs(cents-9)<1,`chromatic cents ${cents}`);
  assert.ok(native.strings[4]!==null&&Math.abs(1200*Math.log2(native.strings[4]/110)-9)<3,`string reading ${native.strings}`);
  // The tone's harmonics (220, 330 Hz...) must not be taken for the high strings.
  assert.deepEqual(native.strings.map((value,index)=>index===4||value===null),[true,true,true,true,true,true],`only the A string is heard: ${native.strings}`);
  assert.equal(native.after.running,false);
  // Then the panel.
  await clickWorkstationButton(page,'Practice',{waitForIdle:false});
  const panel=page.locator('summary').filter({hasText:/^Tuner$/}).locator('..');await panel.evaluate(node=>{node.open=true;});await panel.getByRole('option',{name:'Test tone'}).waitFor({state:'attached'});
  await panel.getByLabel('Input').selectOption('test-tone');
  await panel.getByRole('button',{name:'Start listening'}).click();
  const shown=panel.locator('.tuner-reading');await shown.filter({hasText:'A2'}).waitFor({timeout:10000});
  const chromatic=await shown.textContent();assert.equal(await panel.getByRole('status').textContent(),'A2','screen readers hear only the note');assert.match(chromatic,/\+(8\.\d|9\.\d) cents/);
  await panel.getByLabel('Mode').selectOption('strings');
  const row=panel.getByRole('row',{name:/String 5 \(A2\)/});await row.filter({hasText:/cents/}).waitFor({timeout:10000});
  const strings=await panel.getByRole('row').allTextContents();
  assert.equal(strings.filter(text=>text.includes('Not heard')).length,5,JSON.stringify(strings));
  await mkdir(resolve('.analysis/parity'),{recursive:true});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:resolve('.analysis/parity/native-tuner.png')});
  // Closing the Practice popover with Escape, as a user would, must release the input.
  assert.equal(await panel.evaluate(node=>!!node.closest('details.gp-practice')),true,'the tuner sits in the Practice popover');
  await panel.getByRole('button',{name:'Stop listening'}).focus();await page.keyboard.press('Escape');
  const popover=page.locator('details.gp-practice'),escapeClosed=!await popover.evaluate(node=>node.open);
  assert.equal(escapeClosed,true,'Escape inside the popover closes it');
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('details.gp-practice')!==null&&document.activeElement?.tagName==='SUMMARY'),true,'focus returns to the Practice button');
  const released=await page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;let reading;for(let attempt=0;attempt<50;attempt++){reading=await invoke('tuner_read',{strings:[]});if(!reading.running)break;await new Promise(done=>setTimeout(done,100));}return reading.running;});
  assert.equal(released,false,'closing the popover stops capture');
  await clickWorkstationButton(page,'Practice',{waitForIdle:false});await panel.getByRole('button',{name:'Start listening'}).waitFor();
  // And Start then Stop still work after reopening.
  await panel.getByRole('button',{name:'Start listening'}).click();await panel.getByRole('button',{name:'Stop listening'}).click();await panel.getByRole('button',{name:'Start listening'}).waitFor();
  assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);assert.deepEqual(errors,[]);
  const result={toneHz:sharp,nativeCents:cents,nativeStrings:native.strings,chromatic,strings,popoverCloseStops:!released,escapeClosed};
  await writeFile(join(directory,'tuner-result.json'),JSON.stringify(result,null,2));
  console.log('Tuner passed:',JSON.stringify(result));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
