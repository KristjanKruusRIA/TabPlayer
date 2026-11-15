// THE-216: a real click on a beat moves the playback position there (stopped, paused or playing), and Space plays from the cursor
// or stops, from any focus that is not a text field, select, open menu or dialog, without also activating the focused control.
// Real mouse clicks and real key events. usage: node tests/desktop/parity-click-seek-space.mjs [small|large]
import assert from 'node:assert/strict';
import { openScore,settle,sleep,click,centre,drag,lerp,fretPoint,press,transport } from './entry-mix-support.mjs';
import { revealPractice,hidePractice } from './workstation-commands.mjs';

const size=process.argv[2]??'small',session=await openScore(size),{page,cdp}=session,report={size,seek:{},space:{}};
try{
  const stop=async()=>{await page.locator('.transport-stopbutton').click();await sleep(500);};
  const dirty=async()=>(await session.snapshot()).dirty;
  // The index-th fret number along the first staff on the page (so later indexes are later beats, whatever the number of tracks).
  const firstStaffFret=index=>page.evaluate(index=>{
    const numbers=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&text.getBoundingClientRect().width>0&&!/rgb\(2[0-2]\d, ?\d+, ?\d+\)|red/.test(getComputedStyle(text).fill)).map(text=>{const r=text.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    const top=Math.min(...numbers.map(n=>n.y)),system=numbers.filter(n=>n.y<top+120);
    const bars=[...new Set(system.map(n=>Math.round(n.x/10)))].sort((a,b)=>a-b);
    // One number per distinct x, along the staff, any string.
    const columns=bars.map(column=>system.find(n=>Math.round(n.x/10)===column));return columns[index];
  },index);
  const clickFret=async index=>{let point=await firstStaffFret(index);for(let wait=0;!point&&wait<50;wait++){await sleep(100);point=await firstStaffFret(index);}await click(cdp,point.x,point.y);await sleep(500);return point;};
  const position=()=>page.evaluate(()=>document.querySelector('.statusbar-position')?.textContent??'');
  const frets=[3,8,13];

  // 1. The tick each click should give, learned while stopped.
  const edits0=(await session.edits()).length,dirty0=await dirty(),expected=[];
  for(const index of frets){await clickFret(index);expected.push((await transport(page)).tick);}
  report.seek.stopped={expected};
  assert.equal((await session.edits()).length,edits0,'clicking beats records nothing');assert.equal(await dirty(),dirty0,'clicking beats does not dirty the document');
  assert.ok(expected[0]>0,'a click while stopped moves the playback position off the start');
  assert.ok(expected[0]<expected[1]&&expected[1]<expected[2],'later beats give later positions');

  // 2. Stopped: Space starts from the clicked beat.
  await clickFret(frets[0]);
  await press(cdp,' ');await sleep(400);
  let now=await transport(page);
  assert.equal(now.playing,true,'Space starts playback');
  assert.ok(now.tick>=expected[0]-10&&now.tick<expected[0]+3840*2,`playback started at the clicked beat (tick ${now.tick}, clicked ${expected[0]})`);
  report.seek.spaceFromStopped=now;

  // 3. Playing: a click jumps there and playback goes on.
  await clickFret(frets[2]);await sleep(300);
  now=await transport(page);
  assert.equal(now.playing,true,'playback goes on after a click');
  assert.ok(now.tick>=expected[2]-10&&now.tick<expected[2]+3840*2,`a click while playing jumps to the beat (tick ${now.tick}, clicked ${expected[2]})`);
  report.seek.clickWhilePlaying=now;

  // 4. Space stops where it is; a click while paused moves the position; Space continues from there.
  await press(cdp,' ');await sleep(400);
  now=await transport(page);assert.equal(now.playing,false,'Space stops playback');assert.equal(now.phase,'paused');
  const pausedAt=now.tick;
  await clickFret(frets[1]);
  now=await transport(page);
  assert.ok(Math.abs(now.tick-expected[1])<=10,`a click while paused moves the position (tick ${now.tick}, clicked ${expected[1]}, was ${pausedAt})`);
  await press(cdp,' ');await sleep(400);
  now=await transport(page);assert.equal(now.playing,true);assert.ok(now.tick>=expected[1]-10&&now.tick<expected[1]+3840*2,'Space continues from the clicked beat');
  report.seek.clickWhilePaused={pausedAt,after:now};
  await stop();

  // 5. Space from each focus location.
  const focusCases={
    'score after a click':async()=>{await clickFret(frets[0]);},
    'toolbar button (note entry)':async()=>{const r=await centre(page,'button.note-entry-toggle');await click(cdp,r.x,r.y);},
    'dock mute button':async()=>{const r=await centre(page,'button[data-kind=mute]');await click(cdp,r.x,r.y);},
    'dock track name button':async()=>{const r=await centre(page,'button.score-overview-track-name');await click(cdp,r.x,r.y);await page.evaluate(()=>document.querySelector('button.score-overview-track-name').focus());},
    'dock volume range':async()=>{const r=await centre(page,'input.dock-fader');await click(cdp,r.x,r.y);},
    'dock pan knob':async()=>{const r=await centre(page,'.dock-pan [role=slider]');await click(cdp,r.x,r.y);},
    // At bar 1 this button refuses its click (it is unavailable) but keeps focus: Space still plays and pauses, and nothing else happens.
    'First bar button (unavailable, focused)':async()=>{await page.locator('.transport-stopbutton').click();await sleep(300);const r=await centre(page,'button[aria-label="First bar"]');await click(cdp,r.x,r.y);},
  };
  const mutating=new Set(['dock mute button']);
  for(const [name,focus] of Object.entries(focusCases)){
    await settle(page,500);await stop();
    await focus();await settle(page,600);
    const before=(await session.edits()).length,beforeDirty=await dirty();
    // A Space that finds the plan still being prepared (just after an edit) starts playback once it is ready: allow for that.
    await press(cdp,' ');let started=await transport(page);for(let wait=0;wait<40&&!started.playing;wait++){await sleep(100);started=await transport(page);}
    await sleep(300);
    await press(cdp,' ');await sleep(500);const stopped=await transport(page);
    await sleep(500);const later=await transport(page);
    const added=(await session.edits()).length-before;
    report.space[name]={started:started.playing,stopped:!stopped.playing,stillStopped:!later.playing,editsAddedBySpace:added};
    assert.equal(started.playing,true,`${name}: Space starts playback`);
    assert.equal(stopped.playing,false,`${name}: Space stops it`);
    assert.equal(later.playing,false,`${name}: nothing restarted it (no double action)`);
    assert.equal(added,0,`${name}: Space recorded no edit`);
    assert.equal(await dirty(),beforeDirty,`${name}: Space did not dirty the document`);
  }

  // The Play button itself: a click plays; Space then stops it, once.
  await settle(page,500);await stop();
  { const r=await centre(page,'[aria-keyshortcuts="Space"]');await click(cdp,r.x,r.y);await sleep(500);
    assert.equal((await transport(page)).playing,true);
    await press(cdp,' ');await sleep(600);assert.equal((await transport(page)).playing,false,'Space on the Play button stops it once');await sleep(500);assert.equal((await transport(page)).playing,false);
    report.space['Play button']='ok'; }

  // Key repeat toggles once.
  await settle(page,500);await stop();await clickFret(frets[0]);
  await press(cdp,' ',{repeats:6});await sleep(600);
  assert.equal((await transport(page)).playing,true,'a held Space toggles once, not on every repeat');report.space['held key']='toggled once';
  await press(cdp,' ');await sleep(400);await stop();

  // Places that keep Space: a select, a number field, an open menu, a dialog.
  const keeps=async(name,focus,cleanup)=>{
    await settle(page,500);await stop();await focus();await sleep(300);
    await press(cdp,' ');await sleep(500);const result=await transport(page);
    if(cleanup)await cleanup();
    assert.equal(result.playing,false,`${name}: Space is left to the control`);report.space[name]='not toggled';
  };
  await keeps('transport track select',async()=>{const r=await centre(page,'select.transport-lcd-track');await click(cdp,r.x,r.y);},async()=>{await press(cdp,'Escape');await sleep(200);});
  await keeps('open menu',async()=>{const r=await centre(page,'summary');await click(cdp,r.x,r.y);},async()=>{await press(cdp,'Escape');await sleep(200);await page.evaluate(()=>document.querySelectorAll('details[open]').forEach(d=>{d.open=false;}));});
  await keeps('dialog',async()=>{const button=page.locator('button[aria-label*="Print"],button[title*="Print"],button[title*="Export"]').first();await button.click();await page.getByRole('dialog').first().waitFor();},async()=>{await press(cdp,'Escape');await sleep(300);const dialog=page.getByRole('dialog').first();if(await dialog.isVisible().catch(()=>false)){await dialog.getByRole('button',{name:/^(close|cancel)/i}).first().click();await dialog.waitFor({state:'hidden'});}});


  // ---- Practice state survives clicks (THE-216, second pass). Setup goes through the app's own controls; the clicks and keys are real.
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const applyPractice=async({mode,fields={},metronome,countIn})=>{
    await revealPractice(page);
    const panel=page.locator('details.gp-practice');
    if(mode)await panel.getByLabel('Tempo mode').selectOption({label:mode});
    for(const [label,value] of Object.entries(fields))await panel.getByLabel(label,{exact:true}).fill(String(value));
    if(metronome!==undefined)await panel.getByRole('checkbox',{name:'Metronome',exact:true}).setChecked(metronome);
    if(countIn!==undefined)await panel.getByLabel('Count-in bars',{exact:true}).fill(String(countIn));
    await panel.getByRole('button',{name:'Apply practice settings'}).click();await settle(page,500);await hidePractice(page);
  };
  const waitFor=async(predicate,what,timeout=8000)=>{const until=Date.now()+timeout;let last;while(Date.now()<until){last=await status();if(predicate(last))return last;await sleep(50);}throw new Error(`Timed out waiting for ${what}: ${JSON.stringify({tick:last?.tick,phase:last?.practice?.phase,loop:last?.loop,range:last?.range})}`);};
  const loopButton=()=>page.locator('[data-action="loop"]');
  const inLoop=frets[1],outsideLoop=frets[0];   // bars 2 to 3 hold the beats at 3840 and 6240; the beat at 1440 is in bar 1
  let st;

  // A beat in the middle of the score (200 bars on the large one): scroll there, click it, and Space plays from it.
  await settle(page,500);await stop();
  await page.evaluate(()=>{const scroller=document.querySelector('.paper-scroll');scroller.scrollTop=(scroller.scrollHeight-scroller.clientHeight)/2;});await sleep(800);
  const middle=await page.evaluate(()=>{
    const scroller=document.querySelector('.paper-scroll').getBoundingClientRect();
    const numbers=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&!/rgb\(2[0-2]\d, ?\d+, ?\d+\)|red/.test(getComputedStyle(text).fill)).map(text=>{const r=text.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}).filter(n=>n.y>scroller.top+80&&n.y<scroller.bottom-80&&n.x>scroller.left+80&&n.x<scroller.right-80);
    return numbers[Math.floor(numbers.length/2)];
  });
  assert.ok(middle,'a beat is on screen after scrolling to the middle');
  await click(cdp,middle.x,middle.y);await sleep(500);
  now=await transport(page);report.seek.middleOfScore={tick:now.tick,position:await position()};
  if(size==='large')assert.ok(now.tick>3840*20,`a click in the middle of the 200-bar score seeks there (tick ${now.tick})`);
  await press(cdp,' ');await sleep(500);const middlePlaying=await transport(page);assert.equal(middlePlaying.playing,true);assert.ok(middlePlaying.tick>=now.tick-10,'Space plays from the clicked beat in the middle of the score');
  await stop();await page.evaluate(()=>{document.querySelector('.paper-scroll').scrollTop=0;});await sleep(500);

  // Loop active: a click inside seeks within it and keeps the loop and its passes; a click outside moves only the cursor.
  await settle(page,500);
  await page.getByLabel('Loop start',{exact:true}).fill('2');await page.getByLabel('Loop end',{exact:true}).fill('3');
  await loopButton().click();await sleep(500);
  st=await waitFor(x=>x.loop,'the loop');
  await clickFret(inLoop);await press(cdp,' ');await waitFor(x=>x.playing,'playback in the loop');
  const passesBefore=(await status()).practice.completedPasses;
  const positionBefore=await position();
  await clickFret(outsideLoop);await sleep(400);
  st=await status();
  assert.ok(st.loop,'the loop stays when a click lands outside it');assert.ok(st.tick>=3840-10,`a click outside the loop does not seek (tick ${st.tick})`);
  assert.notEqual(await position(),positionBefore,'the edit cursor still moved');
  await clickFret(inLoop);await sleep(300);
  st=await status();assert.ok(st.loop&&st.playing&&st.tick>=3840-10&&st.tick<11520,`a click inside the loop seeks within it (tick ${st.tick})`);
  assert.ok(st.practice.completedPasses>=passesBefore,'loop passes were not reset by a click');
  report.seek.loop={passesBefore,passesAfter:st.practice.completedPasses,tick:st.tick};
  await press(cdp,' ');await sleep(300);await loopButton().click();await sleep(300);await stop();

  // Speed trainer: progress is kept when the click lands inside the loop.
  await applyPractice({mode:'Progressive',fields:{'Starting speed (%)':100,'Finishing speed (%)':150,'Increment (percentage points)':25,'Repetitions per speed':1}});
  await page.getByLabel('Loop start',{exact:true}).fill('2');await page.getByLabel('Loop end',{exact:true}).fill('2');await loopButton().click();await sleep(400);
  await clickFret(inLoop);await press(cdp,' ');
  const trained=await waitFor(x=>x.playing&&x.practice.completedPasses>=1,'one trainer pass',20000);
  await clickFret(inLoop);await sleep(300);
  st=await status();assert.ok(st.practice.completedPasses>=trained.practice.completedPasses,`trainer progress kept by a click (${trained.practice.completedPasses} then ${st.practice.completedPasses})`);
  report.seek.trainer={before:trained.practice.completedPasses,after:st.practice.completedPasses};
  await press(cdp,' ');await sleep(300);await loopButton().click();await sleep(300);await stop();
  await applyPractice({mode:'Relative',fields:{'Relative speed (%)':100}});

  // Count-in: a click only moves the cursor; the count carries on.
  await applyPractice({countIn:2});
  await clickFret(frets[0]);await press(cdp,' ');
  await waitFor(x=>x.practice.phase==='countIn','a count-in');
  const countingTick=(await status()).tick;
  await clickFret(frets[2]);await sleep(300);
  st=await status();assert.equal(st.practice.phase,'countIn','the count-in goes on after a click');assert.ok(Math.abs(st.tick-countingTick)<10,'a click during the count-in does not seek');
  report.seek.countIn={phase:st.practice.phase};
  await waitFor(x=>x.practice.phase==='playing','the count-in to end',15000);await stop();await applyPractice({countIn:0});

  // Selection playback: drag-select a passage, play it, click inside and outside it.
  await settle(page,500);
  { const a=await firstStaffFret(6),b=await firstStaffFret(22);   // a passage several seconds long, so it is still playing when the clicks come
    await drag(cdp,lerp([a.x,a.y],[b.x,b.y],8),25);await sleep(400);
    const more=page.locator('.transport-more');if(!await more.evaluate(node=>node.open))await more.locator(':scope>summary').click();
    report.seek.selectionDebug=await page.evaluate(()=>({buttons:[...document.querySelectorAll('.transport-more button')].map(b=>b.textContent.trim().slice(0,30)+(b.disabled||b.getAttribute('aria-disabled')==='true'?' (disabled)':'')),open:document.querySelector('.transport-more')?.open,selected:document.querySelectorAll('.score-selection, [class*=selection]').length}));
    // The panel's button is laid out off screen in this window (Playwright finds it not visible), so it is pressed through the DOM; the selection, the clicks and the keys are real.
    await page.locator('.transport-more button',{hasText:/^Play selection$/}).evaluate(button=>button.click());await sleep(500);
    const played=await waitFor(x=>x.playing&&x.range,'the selection playing');
    await clickFret(3);await sleep(300);
    st=await status();assert.ok(st.range&&st.range.startTick===played.range.startTick,'the played selection stays when a click lands outside it');assert.ok(st.tick>=played.range.startTick-10,'a click outside the played selection does not seek');
    await clickFret(12);await sleep(300);
    st=await status();assert.ok(st.range&&st.playing,'the played selection goes on after a click inside it');
    report.seek.selection={range:st.range,tick:st.tick};
    await stop();if(await more.evaluate(node=>node.open))await more.locator(':scope>summary').click(); }

  // Metronome: playback from a clicked beat keeps the click going.
  await applyPractice({metronome:true});
  await clickFret(frets[1]);await press(cdp,' ');await sleep(500);
  st=await status();assert.equal(st.metronome,true);assert.ok(st.playing&&st.tick>=expected[1]-10,'playback from a clicked beat with the metronome on');report.seek.metronome={tick:st.tick};
  await stop();await applyPractice({metronome:false});

  // Shift, ctrl and right click only move the cursor.
  await stop();
  for(const [name,button,modifiers] of [['shift click','left',8],['ctrl click','left',2],['right click','right',0]]){
    await clickFret(frets[0]);await sleep(300);const restTick=(await status()).tick;
    const target=await firstStaffFret(frets[2]);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button,buttons:button==='left'?1:2,clickCount:1,modifiers});await sleep(30);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button,buttons:0,clickCount:1,modifiers});
    await sleep(400);now=await transport(page);
    assert.ok(Math.abs(now.tick-restTick)<10,`${name} does not seek (tick ${now.tick}, was ${restTick})`);
    await press(cdp,'Escape');
  }
  // A double click's second press does not seek (the first, plain press has: the click burst sends the last one only).
  await clickFret(frets[0]);await sleep(300);
  { const target=await firstStaffFret(frets[2]);
    for(const count of [1,2]){await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',buttons:1,clickCount:count});await sleep(5);await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',buttons:0,clickCount:count});await sleep(5);}
    await sleep(400);now=await transport(page);report.seek.doubleClick=now;
    assert.ok(now.tick<expected[2]-10,`a double click does not seek (tick ${now.tick})`); }

  // Nothing above (the clicks included) recorded history or made the document dirty, except the one deliberate mute click.
  const finalEdits=(await session.edits()).length-edits0;
  report.editsRecorded=finalEdits;
  console.log(JSON.stringify({ok:true,...report},null,1));
}catch(error){console.log(JSON.stringify(report,null,1));throw error;}
finally{await session.close();}
