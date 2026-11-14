// THE-213: a typed digit writes the fret at once on the cursor's string (no Enter), a second digit within a second joins it into a
// two-digit fret as ONE undo step, and keys typed while an edit is still being applied are neither lost nor misplaced.
// Real mouse click on the tab, real key events. usage: node tests/desktop/parity-fret-typing.mjs [small|large]
import assert from 'node:assert/strict';
import { openScore,settle,sleep,click,fretPoint,press,watchIpc,nowOnPage,ipcSince } from './entry-mix-support.mjs';

const size=process.argv[2]??'small',session=await openScore(size),{page,cdp}=session,report={size,steps:{}};
const noteOf=edit=>edit?.type==='sequence'?edit.commands.find(step=>step.type==='setNote'):edit;
const position=()=>page.evaluate(()=>document.querySelector('.statusbar-position')?.textContent??'');
try{
  const point=await fretPoint(page,2);
  await click(cdp,point.x,point.y);await sleep(500);
  const start=await position();
  await watchIpc(page);
  const step=async(name,fn)=>{
    await settle(page,600);const before=await session.edits();const since=await nowOnPage(page);await fn();await settle(page,1200);
    const after=await session.edits();report.steps[name]={ipc:await ipcSince(page,since),added:after.length-before.length,last:JSON.stringify(after.at(-1)).slice(0,200),position:await position()};
    return {before,after};
  };

  // 1. A digit writes at once, with no Enter, and the cursor stays.
  let {before,after}=await step('digit 5',async()=>{await press(cdp,'5');});
  assert.equal(after.length-before.length,1,'one digit is one edit');assert.equal(noteOf(after.at(-1)).fret,5);assert.equal(report.steps['digit 5'].position,start,'the cursor did not move');
  // Enter afterwards records nothing: the note already has that fret.
  ({before,after}=await step('Enter after the digit',async()=>{await press(cdp,'Enter');}));
  assert.equal(after.length-before.length,0,'Enter after a written digit adds nothing');

  // 2. Two digits typed quickly are one fret, one undo step.
  await press(cdp,'ArrowRight');await sleep(300);const second=await position();
  ({before,after}=await step('1 then 2',async()=>{await press(cdp,'1');await sleep(120);await press(cdp,'2');}));
  assert.equal(after.length-before.length,1,'1 then 2 is one edit in the history');assert.equal(noteOf(after.at(-1)).fret,12);
  await press(cdp,'z',{modifiers:2});await settle(page,800);
  assert.equal((await session.edits()).length,before.length,'one undo takes back both digits');
  report.steps['undo of 12']={edits:(await session.edits()).length,expected:before.length};

  // 2b. Zero never joins: 0 then 5 is fret 5 (two edits).
  await press(cdp,'ArrowRight');await sleep(300);
  ({before,after}=await step('0 then 5',async()=>{await press(cdp,'0');await sleep(120);await press(cdp,'5');}));
  assert.equal(after.length-before.length,2,'0 then 5 is two edits');assert.equal(noteOf(after.at(-1)).fret,5);

  // 3. Two digits that are not a fret: the second is a new single digit.
  ({before,after}=await step('9 then 9',async()=>{await press(cdp,'9');await sleep(120);await press(cdp,'9');}));
  assert.equal(noteOf(after.at(-1)).fret,9,'99 is no fret, so the second 9 is a fret 9 of its own');

  // 4. A second digit after the window is a new fret.
  ({before,after}=await step('1, wait, 2',async()=>{await press(cdp,'1');await sleep(1500);await press(cdp,'2');}));
  assert.equal(after.length-before.length,2,'a digit after the window is a separate edit');assert.equal(noteOf(after.at(-1)).fret,2);

  // 5. Fast typing while the first edit is still being applied: nothing lost, nothing on the wrong beat.
  await press(cdp,'ArrowRight');await sleep(300);
  ({before,after}=await step('1,2 at 30 ms on a new beat',async()=>{await press(cdp,'1',{hold:5});await sleep(30);await press(cdp,'2',{hold:5});}));
  assert.equal(noteOf(after.at(-1)).fret,12,'fast 1,2 is 12');assert.equal(after.length-before.length,1);
  console.log(JSON.stringify({ok:true,...report},null,1));
}catch(error){console.log(JSON.stringify(report,null,1));throw error;}
finally{await session.close();}
