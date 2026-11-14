import { closeWelcomeLibrary,waitForWorkspaceIdle } from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch,connect,stop } from './harness.mjs';

// MIDI input (THE-70, U16), slice 2: with note entry on, a chord played on the test MIDI port is written at the cursor as one
// edit and the cursor moves on; one undo takes the whole chord back and puts the cursor back; nothing is written while note
// entry is off or while a menu is open (and a chord lost that way is counted); closing the menu with Escape returns the focus to
// the menu's own button. Injection feeds the same sink the driver's callback calls, so this does not exercise midir or a real device.
const id=launch({TABPLAYER_MIDI_IN_TEST:'1'});let browser;
const TEST='Test MIDI input';
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const invoke=(command,args)=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
  const until=async(read,predicate,label,timeout=10000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await read();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`${label} did not happen in time: ${JSON.stringify(last)}`);};
  const edits=async()=>(await readActiveDocument(page)).project.edits;
  const noteOn=(key,velocity=100)=>[0x90,key,velocity];
  // A chord is injected with the notes close together; the 60 ms window then closes it.
  const play=bytes=>invoke('midi_in_test_inject',{bytes});
  const placement=step=>[step.string,step.fret];
  const targetOf=edit=>edit.type==='sequence'?edit.commands.find(step=>step.type==='setNote').target:edit.target;

  // Start the test input from the View menu.
  const viewSummary=page.locator('details.command-menu > summary',{hasText:/^View$/});
  await viewSummary.click();
  const panel=page.locator('details.midi-capture-panel');await panel.locator('summary').click();
  await panel.getByLabel('Input').selectOption(TEST);
  await panel.getByRole('button',{name:'Start MIDI input'}).click();await panel.getByText(`Listening to ${TEST}.`).waitFor();
  // Pressing a button in the section did not close the menu.
  assert.equal(await page.evaluate(()=>document.querySelector('details.midi-capture-panel').parentElement.closest('details').open),true,'the View menu is still open');
  const workspace=page.getByRole('region',{name:'Score workspace'});
  const start=(await edits()).length;

  // With note entry off nothing is written, and nothing is said about it.
  await play([...noteOn(40),...noteOn(47),...noteOn(52)]);
  await panel.getByText(/^Last chord: E2 B2 E3\./).waitFor();
  await page.waitForTimeout(300);
  assert.equal((await edits()).length,start,'note entry is off, so the chord was only shown');
  assert.equal(await panel.getByText(/did not reach the score\./).count(),0,'a chord shown with note entry off is not counted as lost');

  // With note entry on but the menu still open the chord is not written behind it, and is counted.
  await workspace.focus();await page.keyboard.press('n');
  await play([...noteOn(40),...noteOn(47),...noteOn(52)]);
  await panel.getByText('1 chord did not reach the score.').waitFor();
  assert.equal((await edits()).length,start,'a chord is not written while a menu is open');

  // Escape closes the menu and its section, and the focus goes to the menu's own button, not the hidden section.
  await viewSummary.focus();await page.keyboard.press('Escape');
  const after=await page.evaluate(()=>({menu:document.querySelector('details.command-menu > summary').parentElement.open,section:document.querySelector('details.midi-capture-panel').open,focus:document.activeElement?.tagName+':'+document.activeElement?.textContent,view:[...document.querySelectorAll('details.command-menu > summary')].find(node=>node.textContent==='View')?.parentElement.open}));
  assert.equal(after.view,false,'the View menu closed');assert.equal(after.section,false,'the section closed with it');
  assert.equal(after.focus,'SUMMARY:View','the focus is on the View menu button');

  // With note entry on and no menu open the chord is one edit, with the placement a guitarist would play.
  await page.waitForTimeout(200);
  await workspace.focus();
  await play([...noteOn(40),...noteOn(47),...noteOn(52)]);
  const first=await until(edits,list=>list.length===start+1,'one edit for the chord');
  const written=first.at(-1);
  assert.equal(written.type,'sequence');
  assert.deepEqual(written.commands.filter(step=>step.type==='setNote').map(placement),[[1,0],[2,2],[3,2]],'E2 on the low E string, B2 and E3 on the A and D strings');
  assert.equal(written.commands.length,3,'the chord is three steps and nothing else');
  const where=targetOf(written);
  // Nothing follows the chord by itself.
  await page.waitForTimeout(400);
  assert.equal((await edits()).length,start+1,'no second edit follows the chord');

  // The cursor moved on: the next chord lands on the next beat.
  await play([...noteOn(45),...noteOn(52)]);
  const second=(await until(edits,list=>list.length===start+2,'a second chord')).at(-1);
  const next=targetOf(second);
  assert.deepEqual({...next,beat:next.beat-1},{...where},'the second chord is on the next beat');

  // One undo removes the second chord whole, and the cursor goes back: the same chord lands on that beat again.
  await workspace.focus();await page.keyboard.press('Control+z');
  await until(edits,list=>list.length===start+1,'undo takes the chord back');
  await page.waitForTimeout(200);await play([...noteOn(45),...noteOn(52)]);
  const again=(await until(edits,list=>list.length===start+2,'the chord again')).at(-1);
  assert.deepEqual(targetOf(again),next,'the cursor went back with the undo');

  // Playing a pitch the guitar cannot reach says so and writes nothing.
  const count=(await edits()).length;
  await page.waitForTimeout(200);await play([...noteOn(20)]);
  await page.getByText(/is outside what this instrument can play/).waitFor();
  assert.equal((await edits()).length,count);

  // Write notes while the score plays: with the setting off, playback pauses typed keys and chords, nothing waits for later, and stopping restores entry at once.
  // The checkbox is in the View menu next to this section and does not close the menu.
  const openPanel=async()=>{await viewSummary.click();if(!await panel.evaluate(node=>node.open))await panel.locator('summary').click();};
  const closeMenu=async()=>{await viewSummary.focus();await page.keyboard.press('Escape');await page.waitForTimeout(200);};
  await openPanel();
  const setting=page.getByLabel('Write notes while the score plays');
  assert.equal(await setting.isChecked(),true,'writing while the score plays is on by default');
  await setting.click();assert.equal(await setting.isChecked(),false);
  assert.equal(await page.evaluate(()=>document.querySelector('details.midi-capture-panel').parentElement.closest('details').open),true,'the View menu stays open when the setting is changed');
  await panel.getByText(/Chords are not written while the score plays/).waitFor();
  await closeMenu();
  const status=()=>invoke('audio_status');
  const lost=async()=>{await openPanel();const text=await panel.getByText(/chords? did not reach the score\./).first().textContent();await closeMenu();return Number(/^(\d+)/.exec(text)[1]);};
  const lostBefore=await lost(),editsBefore=(await edits()).length;
  await workspace.focus();await page.keyboard.press('Space');
  await until(status,value=>value.playing,'the score plays');
  await play([...noteOn(40),...noteOn(47)]);
  await page.keyboard.press('e');await page.keyboard.press('g');
  await page.getByText(/Note entry is paused while the score plays/).waitFor();
  assert.equal(await page.getByText(/Note entry is paused while the score plays/).count(),1,'the notice appears once');
  await page.waitForTimeout(300);
  assert.equal((await status()).playing,true,'still playing while the keys and the chord were refused');
  assert.equal((await edits()).length,editsBefore,'nothing is written while the score plays');
  assert.equal(await lost(),lostBefore+1,'the chord is counted as not reaching the score');
  await openPanel();await panel.getByText(/writing during playback is off/).waitFor();await closeMenu();
  // Stop: entry works again at once, and the keys and chord played during playback were not kept.
  await workspace.focus();await page.keyboard.press('Space');
  await until(status,value=>!value.playing,'the score stops');
  await page.waitForTimeout(300);
  assert.equal((await edits()).length,editsBefore,'nothing waited for later');
  await page.keyboard.press('e');
  await until(edits,list=>list.length===editsBefore+1,'a typed key is written once playback stops');
  await page.waitForTimeout(200);await play([...noteOn(40),...noteOn(47)]);
  await until(edits,list=>list.length===editsBefore+2,'a chord is written once playback stops');
  // Back on: the same key is written while the score plays.
  await openPanel();await setting.click();assert.equal(await setting.isChecked(),true);await closeMenu();
  await workspace.focus();await page.keyboard.press('Space');await until(status,value=>value.playing,'the score plays again');
  await page.keyboard.press('e');await until(edits,list=>list.length===editsBefore+3,'with the setting on a typed key is written while the score plays');
  await page.keyboard.press('Space');await until(status,value=>!value.playing,'the score stops again');

  assert.deepEqual(errors,[]);
  await mkdir(resolve('.analysis/parity'),{recursive:true});await page.screenshot({path:resolve('.analysis/parity/native-midi-in-entry.png')});
  console.log('MIDI input entry passed:',JSON.stringify({first:written.commands.map(placement),next}));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
