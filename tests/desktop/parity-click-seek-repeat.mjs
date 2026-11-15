// THE-216: clicks on a beat inside a repeated section (first four bars repeated, a first ending in bar 4, a second ending in bar 5).
// Stopped: a click and Space play from the clicked beat. Playing in the second pass: a click seeks within the second pass. With a loop on the
// second pass: a click inside stays in it. Real mouse and keys. usage: node tests/desktop/parity-click-seek-repeat.mjs
import assert from 'node:assert/strict';
import { openScore,sleep,click,drag,lerp,press } from './entry-mix-support.mjs';

const session=await openScore('repeat'),{page,cdp}=session,report={};
try{
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitFor=async(predicate,what,timeout=20000)=>{const until=Date.now()+timeout;let last;while(Date.now()<until){last=await status();if(predicate(last))return last;await sleep(50);}throw new Error(`Timed out waiting for ${what}: ${JSON.stringify({tick:last?.tick,phase:last?.practice?.phase,loop:last?.loop})}`);};
  const stop=async()=>{await page.locator('.transport-stopbutton').click();await sleep(500);};
  const fret=index=>page.evaluate(index=>{
    const numbers=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&text.getBoundingClientRect().width>0&&!/rgb\(2[0-2]\d, ?\d+, ?\d+\)|red/.test(getComputedStyle(text).fill)).map(text=>{const r=text.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    const top=Math.min(...numbers.map(n=>n.y)),system=numbers.filter(n=>n.y<top+120),columns=[...new Set(system.map(n=>Math.round(n.x/10)))].sort((a,b)=>a-b);
    return system.find(n=>Math.round(n.x/10)===columns[index]);
  },index);
  const clickFret=async index=>{let point=await fret(index);for(let wait=0;!point&&wait<50;wait++){await sleep(100);point=await fret(index);}await click(cdp,point.x,point.y);await sleep(500);};
  const inRepeat=10;                                   // a beat in bar 2, inside the repeated four bars

  // Stopped: the click picks the first pass, Space plays from it.
  await clickFret(inRepeat);
  const first=(await status()).tick;
  await press(cdp,' ');const started=await waitFor(x=>x.playing,'playback from the clicked beat');
  assert.ok(started.tick>=first-10&&started.tick<first+3840*2,`Space plays from the clicked beat in the repeat (tick ${started.tick}, clicked ${first})`);
  report.stopped={clickedTick:first,tick:started.tick};
  await stop();

  // Playing in the second pass: a click on the same beat seeks within the second pass.
  await clickFret(0);await press(cdp,' ');
  const secondPass=await waitFor(x=>x.playing&&x.tick>=3840*4+500,'the second pass',30000);
  await clickFret(inRepeat);await sleep(400);
  const after=await status();
  assert.ok(after.playing,'playback goes on');assert.ok(after.tick>=3840*4,`a click in the second pass seeks within the second pass (tick ${after.tick}, first pass beat was ${first})`);
  report.secondPass={before:secondPass.tick,after:after.tick};
  await press(cdp,' ');await sleep(300);await stop();

  // A loop on the second pass: select bar 2 and 3, choose the second occurrence, loop it, play, click inside.
  await clickFret(0);
  { const a=await fret(8),b=await fret(22);await drag(cdp,lerp([a.x,a.y],[b.x,b.y],8),25);await sleep(400);
    const more=page.locator('.transport-more');if(!await more.evaluate(node=>node.open))await more.locator(':scope>summary').click();
    const passage=more.locator('select').nth(1);
    const options=await passage.locator('option').count();assert.ok(options>=2,'the selection is played more than once, so there is a choice of occurrence');
    await passage.selectOption({index:options-1},{force:true});   // the panel is laid out off screen in this window
    await more.locator('button',{hasText:/^Loop selection$/}).evaluate(button=>button.click());await sleep(500);
    const looped=await waitFor(x=>x.loop,'the loop');
    assert.ok(looped.loop.startTick>=3840*4,`the loop is on the second pass (starts at ${looped.loop.startTick})`);
    // A click on a beat inside the loop (focus leaves the panel; the repeated bar's occurrence inside the loop is the one it means), then Space.
    await clickFret(12);await sleep(300);
    const stoppedInLoop=await status();
    assert.ok(stoppedInLoop.tick>=looped.loop.startTick-10&&stoppedInLoop.tick<looped.loop.endTick,`a click inside the loop while stopped means the occurrence in the loop (tick ${stoppedInLoop.tick})`);
    await press(cdp,' ');await waitFor(x=>x.playing&&x.tick>=looped.loop.startTick-10,'playback in the loop');
    await clickFret(12);await sleep(400);
    const inside=await status();
    assert.ok(inside.loop&&inside.loop.startTick===looped.loop.startTick,'the loop is unchanged');
    assert.ok(inside.tick>=looped.loop.startTick-10&&inside.tick<looped.loop.endTick,`a click inside the loop stays in the second pass (tick ${inside.tick}, loop ${looped.loop.startTick} to ${looped.loop.endTick})`);
    report.loop={loop:looped.loop,tick:inside.tick}; }
  console.log(JSON.stringify({ok:true,...report},null,1));
}catch(error){console.log(JSON.stringify(report,null,1));throw error;}
finally{await session.close();}
