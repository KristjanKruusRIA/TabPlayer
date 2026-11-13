import { closeWelcomeLibrary,waitForWorkspaceIdle } from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch,connect,stop } from './harness.mjs';

// MIDI input (THE-70, U17), slice 3: with "MIDI guitar strings" set, a note that arrives on a mapped channel is written on that
// string at the fret that gives its pitch (lowest-first and highest-first); a chord that cannot be written that way (a pitch the
// mapped string cannot reach, two notes on one channel, a string that already holds another note) is refused whole with a message
// naming note and string, nothing is written and the chord is counted; a note on channel 10 is placed by the fingering rule and
// counted; undo takes a chord's notes out of the score; Reset restores the defaults; with the mapping off the placement is the
// slice 2 fingering rule. Channels are injected through the test port, so this does not exercise midir or a real MIDI guitar.
const id=launch({TABPLAYER_MIDI_IN_TEST:'1'});let browser;
const TEST='Test MIDI input';
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const invoke=(command,args)=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
  const until=async(read,predicate,label,timeout=10000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await read();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`${label} did not happen in time: ${JSON.stringify(last)}`);};
  const edits=async()=>(await readActiveDocument(page)).project.edits;
  // The notes the score holds, read from the edits that are in force: [bar, beat, string, fret] in the order written.
  const scoreNotes=async()=>(await edits()).flatMap(edit=>edit.type==='sequence'?edit.commands:[edit]).filter(step=>step.type==='setNote').map(step=>[step.target.bar,step.target.beat,step.string,step.fret]);
  // A note-on on a channel (0 to 15): the status byte carries the channel.
  const noteOn=(channel,key,velocity=100)=>[0x90|channel,key,velocity];
  const play=bytes=>invoke('midi_in_test_inject',{bytes});
  const placement=step=>[step.string,step.fret];
  const placed=edit=>(edit.type==='sequence'?edit.commands:[edit]).filter(step=>step.type==='setNote').map(placement);
  const targetOf=edit=>edit.type==='sequence'?edit.commands.find(step=>step.type==='setNote').target:edit.target;

  const viewSummary=page.locator('details.command-menu > summary',{hasText:/^View$/});
  const panel=page.locator('details.midi-capture-panel');
  const openPanel=async()=>{await viewSummary.click();if(!await panel.evaluate(node=>node.open))await panel.locator('summary').click();};
  const closeMenu=async()=>{await viewSummary.focus();await page.keyboard.press('Escape');await page.waitForTimeout(200);};
  const menuOpen=()=>page.evaluate(()=>document.querySelector('details.midi-capture-panel').parentElement.closest('details').open);
  const workspace=page.getByRole('region',{name:'Score workspace'});
  const mapping=panel.getByLabel('MIDI guitar strings');
  // A real click on the select, then the choice: neither may close the View menu around it.
  const choose=async value=>{await mapping.click();await mapping.selectOption(value);assert.equal(await menuOpen(),true,'choosing a mapping did not close the View menu');};
  const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('tabplayer.midiCapture')));

  await openPanel();
  await panel.getByLabel('Input').selectOption(TEST);
  await panel.getByRole('button',{name:'Start MIDI input'}).click();await panel.getByText(`Listening to ${TEST}.`).waitFor();
  assert.equal(await mapping.inputValue(),'off','the mapping starts off');
  assert.deepEqual(await mapping.locator('option').allTextContents(),['Off (keyboard)','Channel 1 is the bottom tab line','Channel 1 is the top tab line']);
  await choose('lowestFirst');
  assert.equal((await stored()).stringMapping,'lowestFirst','the choice is a viewer setting kept in this window');
  await closeMenu();
  await workspace.focus();await page.keyboard.press('n');
  const start=(await edits()).length,startNotes=await scoreNotes();

  // Mapped chord: channel c is string c+1 from the bottom line. By the fingering rule these would sit on other strings.
  await play([...noteOn(0,43),...noteOn(1,50),...noteOn(2,57)]);
  const first=(await until(edits,list=>list.length===start+1,'one edit for the mapped chord')).at(-1);
  assert.equal(first.type,'sequence');
  assert.deepEqual(placed(first),[[1,3],[2,5],[3,7]],'G2 on string 1 fret 3, D3 on string 2 fret 5, A3 on string 3 fret 7');
  const where=targetOf(first);

  // A single note from channel 1 sits on string 2 at fret 12 (the cost rule would use string 4 at a low fret).
  await page.waitForTimeout(200);
  await play([...noteOn(1,57)]);
  const single=(await until(edits,list=>list.length===start+2,'a single mapped note')).at(-1);
  assert.deepEqual(placed(single),[[2,12]]);
  assert.deepEqual(targetOf(single),{...where,beat:where.beat+1},'the cursor moved on after the first chord');

  // A pitch the mapped string cannot reach: refused whole, naming note and string, nothing written, counted. (Another string
  // could play it; the chord is refused rather than re-fingered.)
  await page.waitForTimeout(200);
  await play([...noteOn(0,20)]);
  await page.getByText(/G#0 on string 1 is outside what this instrument can play/).waitFor();
  assert.equal((await edits()).length,start+2,'a refused chord writes nothing');
  await openPanel();
  await panel.getByText(/^1 chord did not reach the score\./).waitFor();
  await closeMenu();

  // Two notes on one channel: refused whole, naming both notes and the string.
  await workspace.focus();await page.waitForTimeout(200);
  await play([...noteOn(2,50),...noteOn(2,57)]);
  await page.getByText(/D3 A3 on string 3: one channel sent two notes/).waitFor();
  assert.equal((await edits()).length,start+2,'a refused chord writes nothing');
  await openPanel();
  await panel.getByText(/^2 chords did not reach the score\./).waitFor();
  await closeMenu();

  // A note on channel 10 has no string: it is written by the fingering rule, the message says so, and the panel counts it.
  await workspace.focus();await page.waitForTimeout(200);
  await play([...noteOn(9,52)]);
  const moved=(await until(edits,list=>list.length===start+3,'a note on channel 10')).at(-1);
  // Where the fingering rule puts it depends on where the hand was (it is near fret 12 after the earlier notes); the pitch is what must hold.
  const open=[40,45,50,55,59,64],[[string,fret]]=placed(moved);
  assert.equal(placed(moved).length,1);assert.equal(open[string-1]+fret,52,'channel 10 note is E3 at some string and fret');
  await page.getByText(/E3 came on channel 10, which has no string on this track/).waitFor();
  await openPanel();
  await panel.getByText(/^1 note was written on another string/).waitFor();
  await closeMenu();

  // A string that already holds another note on the beat: go back to the first chord's beat and play string 3 again with another pitch.
  await workspace.focus();
  const expected=[...startNotes,[where.bar,where.beat,1,3],[where.bar,where.beat,2,5],[where.bar,where.beat,3,7],[where.bar,where.beat+1,2,12],[where.bar,where.beat+2,string,fret]];
  assert.deepEqual(await scoreNotes(),expected,'the score holds exactly the mapped notes');
  for(let step=0;step<3;step++)await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  await play([...noteOn(2,60)]);
  await page.getByText(/C4 on string 3 cannot be written: that string already holds another note/).waitFor();
  assert.deepEqual(await scoreNotes(),expected,'a refused chord writes nothing');

  // Undo takes each chord out of the score: the notes, not just the edit count.
  await page.keyboard.press('Control+z');
  await until(scoreNotes,notes=>notes.length===expected.length-1,'undo takes the channel 10 note back');
  await page.keyboard.press('Control+z');
  await until(scoreNotes,notes=>notes.length===expected.length-2,'undo takes the single note back');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await until(scoreNotes,notes=>notes.length===startNotes.length,'undo takes the chord back'),startNotes,'the score is as it was before the chords');

  // Highest first: channel 1 is the top line, so channel 0 is string 6 and channel 5 is string 1.
  await openPanel();await choose('highestFirst');
  assert.equal((await stored()).stringMapping,'highestFirst');
  await closeMenu();
  await workspace.focus();await page.waitForTimeout(200);
  await play([...noteOn(0,64),...noteOn(5,40),...noteOn(1,59)]);
  const high=(await until(edits,list=>list.length===start+1,'one edit with highest first')).at(-1);
  assert.deepEqual(placed(high),[[6,0],[1,0],[5,0]],'E4 on string 6, E2 on string 1, B3 on string 5, each open');

  // Reset restores the chord window, the velocity floor and the mapping, and keeps the chosen input.
  await openPanel();
  await panel.getByLabel('Chord window').fill('200');
  await panel.getByRole('button',{name:'Reset to defaults'}).click();
  assert.deepEqual(await stored(),{port:TEST,chordWindowMs:60,minVelocity:1,stringMapping:'off'});
  assert.equal(await mapping.inputValue(),'off');
  assert.equal(await menuOpen(),true,'Reset did not close the View menu');
  await closeMenu();

  // Mapping off is the fingering rule of slice 2, whatever the channels.
  await workspace.focus();await page.waitForTimeout(200);
  await page.keyboard.press('Control+z');
  await until(scoreNotes,notes=>notes.length===startNotes.length,'undo takes the highest-first chord back');
  await play([...noteOn(3,40),...noteOn(4,47),...noteOn(5,52)]);
  const off=(await until(edits,list=>list.length===start+1,'one edit with the mapping off')).at(-1);
  assert.deepEqual(placed(off),[[1,0],[2,2],[3,2]],'with the mapping off the channel is ignored');

  assert.deepEqual(errors,[]);
  await mkdir(resolve('.analysis/parity'),{recursive:true});await page.screenshot({path:resolve('.analysis/parity/native-midi-in-guitar.png')});
  console.log('MIDI guitar mapping passed:',JSON.stringify({mapped:placed(first),single:placed(single),moved:placed(moved),high:placed(high),off:placed(off)}));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
