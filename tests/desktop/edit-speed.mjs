import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importer,exporter,Settings } from '@coderline/alphatab';
import { launch,connect,stop } from './harness.mjs';
import { closeWelcomeLibrary,clickWorkspaceCommand,waitForWorkspaceIdle } from './workstation-commands.mjs';

// THE-213: a note edit on a long score shows and accepts the next key within a fraction of a second, does not wait for playback to be
// prepared again, and an idle or cursor-moving editor does not redraw. The budgets are generous multiples of what one development
// machine measured (see docs/validation/2026-11-14-the-213-edit-speed.md), so a slower machine passes and a return of the old
// behaviour (a rebuild of the whole score for every edit, status events that redraw the app 30 times a second) fails.
const TRACKS=6,BARS=200;
const BUDGET={
  /** Key to native `apply_edit` answered. Was about 400 ms before the change. */
  editIpcMedianMs:120,
  /** Key to the editor free again with the score drawn. Was about 1000 ms. */
  editFreeMedianMs:450,editFreeWorstMs:900,
  /** One note edit's cost after the 20th is no worse than the first. */
  growthFactor:2,
  /** Each key of a burst typed 150 ms apart, while the earlier edits are still being prepared for playback. */
  burstIpcWorstMs:200,burstPrepares:2,
  /** Cursor move to the status bar showing it; the score is not drawn again. */
  cursorMedianMs:90,
  /** Idle for 3 s: status events per second the engine sends, and the share of the main thread busy. */
  idleStatusEvents:8,idleBusyPercent:8,
};
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),middle=sorted.length>>1;return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function generate(tracks,bars) {
  const slash=String.fromCharCode(92),newline=String.fromCharCode(10);
  let text=`${slash}title "Edit speed ${tracks}x${bars}"${newline}${slash}tempo 120${newline}`;
  for(let t=0;t<tracks;t++) {
    const bass=t%3===2,strings=bass?4:6;
    text+=`${slash}track "Track ${t+1}"${newline}${slash}staff {tabs}${newline}${slash}instrument ${bass?33:25}${newline}${slash}tuning (${bass?'g2 d2 a1 e1':'e4 b3 g3 d3 a2 e2'})${newline}`;
    for(let b=0;b<bars;b++){let bar=':8 ';for(let i=0;i<8;i++)bar+=`${(b+i*3+t)%12}.${1+((b+i+t)%strings)} `;text+=`${bar}|${newline}`;}
  }
  const settings=new Settings(),reader=new importer.AlphaTexImporter();reader.initFromString(text,settings);
  return Uint8Array.from(new exporter.Gp7Exporter().export(reader.readScore(),settings));
}

const directory=mkdtempSync(join(tmpdir(),'tabplayer-edit-speed-'));
const file=join(directory,'long.gp');writeFileSync(file,generate(TRACKS,BARS));
let id=null,browser=null,page=null;
const result={tracks:TRACKS,bars:BARS};
try {
  for(let attempt=0;;attempt++) {
    id=launch({TABPLAYER_TEST_OPEN:file});browser=await connect();page=browser.contexts()[0].pages()[0];
    // The welcome dialog is slow to appear on a cold start: a launch that never shows it is tried again.
    try{await closeWelcomeLibrary(page);break;}catch(error){if(attempt>=2)throw error;await browser.close().catch(()=>{});stop(id);id=null;}
  }
  await waitForWorkspaceIdle(page);
  await clickWorkspaceCommand(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);
  await page.waitForFunction(()=>document.querySelector('.score-tools')?.textContent.includes('measures'),{},{timeout:120000});
  const cdp=await page.context().newCDPSession(page);
  const playReady=timeout=>page.waitForFunction(()=>{const button=document.querySelector('[aria-keyshortcuts="Space"]');return button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&document.querySelector('.app-shell')?.getAttribute('aria-busy')==='false';},{},{timeout});
  await playReady(120000);await page.waitForTimeout(1500);

  // Page-side instruments: the native calls, the events, when the score's DOM and the busy flag changed.
  await page.evaluate(()=>{
    const probe=window.__editSpeed={ipc:[],events:{},keys:[],host:[],busy:[],position:[]};
    new PerformanceObserver(list=>{for(const entry of list.getEntries())if(/ipc\.localhost|\/ipc/.test(entry.name))probe.ipc.push({cmd:entry.name.replace(/^.*ipc\.localhost\//,''),start:entry.startTime,end:entry.responseEnd});}).observe({entryTypes:['resource']});
    const callbacks=window.__TAURI_INTERNALS__.callbacks,original=Map.prototype.get;
    callbacks.get=function(key){const handler=original.call(this,key);if(typeof handler!=='function')return handler;return function(message){const name=message&&message.event;if(name)probe.events[name]=(probe.events[name]||0)+1;return handler.apply(this,arguments);};};
    window.addEventListener('keydown',event=>probe.keys.push({key:event.key,at:event.timeStamp}),true);
    const host=document.querySelector('.score-paper-host');
    if(host)new MutationObserver(list=>probe.host.push({at:performance.now(),count:list.length})).observe(host,{subtree:true,childList:true});
    new MutationObserver(list=>{for(const record of list)if(record.target.matches?.('.app-shell')&&record.attributeName==='aria-busy')probe.busy.push({at:performance.now(),value:record.target.getAttribute('aria-busy')});}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['aria-busy']});
    let shown=document.querySelector('.statusbar-position')?.textContent;
    new MutationObserver(()=>{const text=document.querySelector('.statusbar-position')?.textContent;if(text!==shown){shown=text;probe.position.push({at:performance.now(),text});}}).observe(document.querySelector('.statusbar'),{subtree:true,childList:true,characterData:true});
  });
  const reset=()=>page.evaluate(()=>{const p=window.__editSpeed;p.ipc.length=0;p.events={};p.keys.length=0;p.host.length=0;p.busy.length=0;p.position.length=0;});
  const dump=()=>page.evaluate(()=>JSON.parse(JSON.stringify(window.__editSpeed)));
  const settle=()=>page.waitForFunction(()=>{
    const p=window.__editSpeed,button=document.querySelector('[aria-keyshortcuts="Space"]'),ready=button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&document.querySelector('.app-shell')?.getAttribute('aria-busy')==='false';
    const last=Math.max(0,...p.host.map(m=>m.at),...p.ipc.map(i=>i.end||0),...p.busy.map(b=>b.at));
    return ready&&performance.now()-last>700;
  },{polling:50,timeout:120000});
  const keyCodes={Enter:{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},ArrowRight:{key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},ArrowLeft:{key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37}};
  const press=async name=>{
    const code=keyCodes[name]??{key:name,code:`Digit${name}`,windowsVirtualKeyCode:48+Number(name),text:name};
    await cdp.send('Input.dispatchKeyEvent',{type:code.text?'keyDown':'rawKeyDown',...code});await sleep(15);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:code.key,code:code.code,windowsVirtualKeyCode:code.windowsVirtualKeyCode});
  };
  // Put the cursor on a note of the score.
  const point=await page.evaluate(()=>{
    const notes=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&text.getBoundingClientRect().width>0&&!/rgb\(2(0|2)\d, ?\d+, ?\d+\)/.test(getComputedStyle(text).fill));
    const box=notes[2].getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};
  });
  for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1});
  await page.waitForTimeout(500);await settle();

  // 1. One note edit, repeated: digit then Enter.
  const digits=[7,8,9,1,2,3,4,5,6];
  const editOnce=async index=>{
    await reset();await press(String(digits[index%digits.length]));await sleep(120);await press('Enter');await sleep(60);await settle();
    const data=await dump(),enter=data.keys.filter(k=>k.key==='Enter').at(-1).at,apply=data.ipc.find(i=>i.cmd.startsWith('apply_edit'));
    const freed=data.busy.filter(b=>b.value==='false').at(-1),drawn=data.host.at(-1);
    return {ipc:apply.end-enter,free:Math.max(freed?freed.at-enter:0,drawn?drawn.at-enter:0)};
  };
  const edits=[];for(let i=0;i<24;i++)edits.push(await editOnce(i));
  result.editIpcMedianMs=Math.round(median(edits.map(e=>e.ipc)));
  result.editFreeMedianMs=Math.round(median(edits.map(e=>e.free)));result.editFreeWorstMs=Math.round(Math.max(...edits.map(e=>e.free)));
  const early=median(edits.slice(1,7).map(e=>e.free)),late=median(edits.slice(-6).map(e=>e.free));result.editFreeEarlyMs=Math.round(early);result.editFreeLateMs=Math.round(late);
  assert.ok(result.editIpcMedianMs<=BUDGET.editIpcMedianMs,`note edit reaches native in ${result.editIpcMedianMs} ms (budget ${BUDGET.editIpcMedianMs})`);
  assert.ok(result.editFreeMedianMs<=BUDGET.editFreeMedianMs,`note edit shown and editor free in ${result.editFreeMedianMs} ms (budget ${BUDGET.editFreeMedianMs})`);
  assert.ok(result.editFreeWorstMs<=BUDGET.editFreeWorstMs,`slowest note edit ${result.editFreeWorstMs} ms (budget ${BUDGET.editFreeWorstMs})`);
  assert.ok(late<=early*BUDGET.growthFactor+30,`edits got slower as they accumulated (${Math.round(early)} ms early, ${Math.round(late)} ms late)`);

  // 2. A burst of edits typed while earlier ones are still being prepared for playback: none waits, and playback is prepared for the last only.
  await settle();await reset();
  const burstStart=await page.evaluate(()=>performance.now());
  for(let i=0;i<6;i++){await press(String(digits[i]));await sleep(40);await press('Enter');await sleep(110);}
  await settle();
  const burst=await dump(),applies=burst.ipc.filter(i=>i.cmd.startsWith('apply_edit')),prepares=burst.ipc.filter(i=>i.cmd.startsWith('audio_prepare'));
  result.burst={edits:applies.length,worstIpcMs:Math.round(Math.max(...applies.map(i=>i.end-i.start))),prepares:prepares.length};
  assert.equal(applies.length,6,'every key of the burst became an edit');
  assert.ok(result.burst.worstIpcMs<=BUDGET.burstIpcWorstMs,`an edit of the burst waited ${result.burst.worstIpcMs} ms (budget ${BUDGET.burstIpcWorstMs})`);
  assert.ok(prepares.length<=BUDGET.burstPrepares,`playback was prepared ${prepares.length} times for one burst (budget ${BUDGET.burstPrepares})`);
  // Playback is of the current document: native holds the newest plan and is ready.
  const status=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  assert.ok(status.ready&&!status.error&&status.generation===status.desiredGeneration,`native playback is prepared for the newest score (${JSON.stringify({ready:status.ready,generation:status.generation,desired:status.desiredGeneration,error:status.error})})`);

  // 3. Cursor moves: no score redraw, and quick.
  await settle();const moves=[];
  for(let i=0;i<20;i++){
    await reset();await press(i%2?'ArrowLeft':'ArrowRight');await sleep(250);
    const data=await dump();if(data.position[0])moves.push(data.position[0].at-data.keys[0].at);
    // The caret and the selection are drawn over the score (a few nodes); a drawn score is thousands.
    assert.ok(data.host.every(change=>change.count<40),`a cursor move drew the score again (${JSON.stringify(data.host)})`);
  }
  result.cursorMedianMs=Math.round(median(moves));result.cursorMoves=moves.length;
  assert.ok(moves.length>=15,'the status bar followed the cursor');
  assert.ok(result.cursorMedianMs<=BUDGET.cursorMedianMs,`cursor move shown in ${result.cursorMedianMs} ms (budget ${BUDGET.cursorMedianMs})`);

  // 4. Idle: nothing redraws, the engine says little, the main thread rests.
  await settle();await page.waitForTimeout(1000);await reset();
  await cdp.send('Performance.enable');
  const before=(await cdp.send('Performance.getMetrics')).metrics,metric=(list,name)=>list.find(m=>m.name===name).value;
  await page.waitForTimeout(3000);
  const after=(await cdp.send('Performance.getMetrics')).metrics,idle=await dump();
  result.idleBusyPercent=+(100*(metric(after,'TaskDuration')-metric(before,'TaskDuration'))/(metric(after,'Timestamp')-metric(before,'Timestamp'))).toFixed(1);
  result.idleStatusEvents=idle.events['native-audio-status']??0;result.idleHostMutations=idle.host.length;
  assert.equal(idle.host.length,0,'the score changed while idle');
  assert.ok(result.idleStatusEvents<=BUDGET.idleStatusEvents,`${result.idleStatusEvents} status events in 3 s of idle (budget ${BUDGET.idleStatusEvents})`);
  assert.ok(result.idleBusyPercent<=BUDGET.idleBusyPercent,`the main thread was ${result.idleBusyPercent}% busy while idle (budget ${BUDGET.idleBusyPercent}%)`);

  // 5. The document edited in place is the document a full rebuild gives: the app compares every edit with a rebuild for a few edits.
  await page.evaluate(()=>{window.__tabplayerCheckEdits=1;});
  const stats=await page.evaluate(()=>({...window.__tabplayerEditStats}));
  for(let i=0;i<3;i++){await press(String(digits[i]));await sleep(80);await press('Enter');await settle();}
  const checked=await page.evaluate(()=>({...window.__tabplayerEditStats}));
  result.equivalence={checked:checked.verified-stats.verified,mismatches:checked.mismatches-stats.mismatches,inPlace:checked.inPlace};
  assert.equal(result.equivalence.mismatches,0,'an edit made in place differed from a full rebuild');
  assert.ok(result.equivalence.checked>=3,'the edits were compared with a full rebuild');
  console.log(JSON.stringify(result,null,2));
} finally {
  if(browser)await browser.close().catch(()=>{});
  if(id!==null)stop(id);
  rmSync(directory,{recursive:true,force:true});
}
