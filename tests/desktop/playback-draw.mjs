import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importer,exporter,Settings } from '@coderline/alphatab';
import { launch,connect,stop } from './harness.mjs';
import { closeWelcomeLibrary,clickWorkspaceCommand,waitForWorkspaceIdle } from './workstation-commands.mjs';
import { click,drag,lerp,sleep } from './entry-mix-support.mjs';
import { ownerScoreFiles } from './draw-equivalence.mjs';
import { startFrameSampler,resetFrameSampler,markFrame,expectHighlight,stopFrameSampler,drawStatsLog,clearDrawStatsLog } from './draw-probes.mjs';

// THE-213 (draw speed): during playback the score area never presents a blank system and the sounding beat is highlighted, across line changes, a loop wrap and a click-seek.
// alphaTab moves the playback cursor inside an animation frame: it highlights the sounding beats in the drawing of the system and then scrolls; a system that is only painted
// when its browser reports it (lazy painting) would be blank for that frame and keep no highlight. The probe samples every presented frame (draw-probes.mjs) on a generated
// score, and on each of the owner's scores when TP_OWNER_SCORES names a folder that exists. usage: node tests/desktop/playback-draw.mjs
const BUDGET={blankFrames:0,/** Frames of a run without a highlighted beat: the first beat after a start, a seek or a loop wrap may wait for alphaTab's next update. */noHighlightFrames:3};

function generate(bars) {
  const slash=String.fromCharCode(92),newline=String.fromCharCode(10);
  let text=`${slash}title "Playback draw"${newline}${slash}tempo 360${newline}${slash}track "Guitar"${newline}${slash}staff {tabs}${newline}${slash}instrument 25${newline}${slash}tuning (e4 b3 g3 d3 a2 e2)${newline}`;
  for(let b=0;b<bars;b++){let bar=':8 ';for(let i=0;i<8;i++)bar+=`${(b+i*3)%12}.${1+((b+i)%6)} `;text+=`${bar}|${newline}`;}
  const settings=new Settings(),reader=new importer.AlphaTexImporter();reader.initFromString(text,settings);
  return Uint8Array.from(new exporter.Gp7Exporter().export(reader.readScore(),settings));
}

/** Plays `path` through line changes, a click-seek and a loop wrap; returns what the frame sampler saw. */
async function probe(path,label,flags={},{strict=true,controlNoHighlight}={}) {
  const id=launch({TABPLAYER_TEST_OPEN:path});let browser=null;
  try {
    browser=await connect();const page=browser.contexts()[0].pages()[0];
    await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
    await clickWorkspaceCommand(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);
    await page.waitForFunction(()=>document.querySelector('.score-tools')?.textContent.includes('measures'),{},{timeout:180000});
    const cdp=await page.context().newCDPSession(page);
    const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
    const waitFor=async(predicate,what,timeout=40000)=>{const until=Date.now()+timeout;let last;while(Date.now()<until){last=await status();if(predicate(last))return last;await sleep(40);}throw new Error(`${label}: timed out waiting for ${what}: ${JSON.stringify({tick:last?.tick,playing:last?.playing})}`);};
    await page.waitForFunction(()=>{const button=document.querySelector('[aria-keyshortcuts="Space"]');return button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&document.querySelector('.app-shell')?.getAttribute('aria-busy')==='false';},{},{timeout:180000});
    // DRAW_FLAGS='{"paintOnCursor":false}' switches a change off to show that the probe sees what it was made to see.
    await page.evaluate(flags=>Object.assign(window.__tabplayerDrawFlags,flags),{...flags,...JSON.parse(process.env.DRAW_FLAGS??'{}')});
    // The flags act on the next draw: a changed layout draws the score again with them.
    if(Object.keys(flags).length){const mode=page.getByRole('combobox',{name:'Display mode',exact:true});await mode.selectOption('verticalScreen');await sleep(1200);await mode.selectOption('parchment');await sleep(1500);}
    await sleep(1500);
    const space=async()=>{await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '});await sleep(20);await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});};
    /** The fret numbers in view as {x,y} in client coordinates, top row first. */
    const frets=()=>page.evaluate(()=>{
      const area=document.querySelector('.paper-scroll').getBoundingClientRect();
      return [...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&!/rgb\(2[0-2]\d, ?\d+, ?\d+\)|red/.test(getComputedStyle(text).fill)).map(text=>{const box=text.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2,w:box.width};}).filter(n=>n.w>0&&n.y>area.top+25&&n.y<area.bottom-25&&n.x>area.left+10&&n.x<area.right-10).sort((a,b)=>a.y-b.y||a.x-b.x);
    });
    const firstFret=async()=>{for(let attempt=0;attempt<80;attempt++){const found=await frets();if(found.length>=3)return found[0];await page.evaluate(()=>{const host=document.querySelector('.paper-scroll');host.scrollTop+=250;host.scrollLeft+=0;});await sleep(200);}throw new Error('no fret numbers in view');};
    await clearDrawStatsLog(page);
    await page.evaluate(()=>{document.querySelector('.paper-scroll').scrollTop=0;});await sleep(400);
    const start=await firstFret();await click(cdp,start.x,start.y);await sleep(500);
    await startFrameSampler(page);await expectHighlight(page,false);
    // 1. Play through line changes.
    await space();await waitFor(x=>x.playing,'playback');await sleep(800);await expectHighlight(page,true);await resetFrameSampler(page);
    const until=Date.now()+60000;
    while(Date.now()<until&&(await page.evaluate(()=>window.__frames.lineChanges))<3)await sleep(200);
    const afterLines=await page.evaluate(()=>({lineChanges:window.__frames.lineChanges,blank:window.__frames.blank,noHighlight:window.__frames.noHighlight}));
    assert.ok(afterLines.lineChanges>=3,`${label}: the cursor changed line ${afterLines.lineChanges} times (3 wanted)`);
    // 2. A click-seek while playing: on the number farthest from the cursor among those in view.
    const cursorTop=await page.evaluate(()=>document.querySelector('.at-cursor-bar')?.getBoundingClientRect().top??0);
    const candidates=await frets();assert.ok(candidates.length>0,`${label}: nothing to click`);
    const target=candidates.reduce((far,n)=>Math.abs(n.y-cursorTop)>Math.abs(far.y-cursorTop)?n:far);
    await markFrame(page,'click-seek');await click(cdp,target.x,target.y);await sleep(900);
    assert.ok((await status()).playing,`${label}: playback goes on after the click-seek`);
    // A seek back to the start of the score, which is out of view by now: scroll up, click the first number.
    await page.evaluate(()=>{document.querySelector('.paper-scroll').scrollTop=0;});await sleep(300);
    const home=await firstFret();await markFrame(page,'seek-home');await click(cdp,home.x,home.y);await sleep(1200);
    assert.ok((await status()).playing,`${label}: playback goes on after the seek to the start`);
    // 3. Stop, select across a line break, loop it, play, and let it wrap twice.
    await expectHighlight(page,false);await markFrame(page,'stop');await page.locator('.transport-stopbutton').click();await sleep(600);
    await page.evaluate(()=>{document.querySelector('.paper-scroll').scrollTop=0;});await sleep(400);
    // Two rows of numbers in view (the selection crosses a line break); scroll down until there are two.
    let firstRow=[],secondRow=[];
    for(let attempt=0;attempt<80&&!secondRow.length;attempt++){
      const rows=await frets();
      if(rows.length){const top=rows[0].y,lower=rows.find(n=>n.y>top+60);if(lower){firstRow=rows.filter(n=>n.y<top+8);secondRow=rows.filter(n=>Math.abs(n.y-lower.y)<8);}}
      if(!secondRow.length){await page.evaluate(()=>{document.querySelector('.paper-scroll').scrollTop+=250;});await sleep(200);}
    }
    assert.ok(secondRow.length,`${label}: two systems with numbers in view for the loop`);
    const from=firstRow.at(-1),to=secondRow[Math.min(1,secondRow.length-1)];
    await drag(cdp,lerp([from.x,from.y],[to.x,to.y],10),25);await sleep(500);
    const more=page.locator('.transport-more');if(!await more.evaluate(node=>node.open))await more.locator(':scope>summary').click();
    await more.locator('button',{hasText:/^Loop selection$/}).evaluate(button=>button.click());await sleep(600);
    const looped=await waitFor(x=>x.loop,'the loop');
    // Focus is on the panel after its button: a click on a number inside the loop puts it back on the score (and keeps the loop).
    await click(cdp,to.x,to.y);await sleep(400);
    await markFrame(page,'loop-play');await space();await waitFor(x=>x.playing,'playback in the loop');await sleep(600);await expectHighlight(page,true);
    let wraps=0,previous=(await status()).tick;const loopUntil=Date.now()+40000;
    while(wraps<2&&Date.now()<loopUntil){const now=(await status()).tick;if(now<previous-500)wraps++;previous=now;await sleep(60);}
    assert.ok(wraps>=2,`${label}: the loop wrapped ${wraps} times (2 wanted; loop ${looped.loop.startTick} to ${looped.loop.endTick})`);
    await sleep(300);await expectHighlight(page,false);
    const frames=await stopFrameSampler(page);
    await page.locator('.transport-stopbutton').click().catch(()=>{});
    const counts=(await drawStatsLog(page));
    const result={score:label,frames:frames.frames,blankFrames:frames.blank,blankAt:frames.blankFrames,longestBlankRun:frames.longestBlankRun,noHighlightFrames:frames.noHighlight,noHighlightRuns:frames.noHighlightRuns.slice(0,12),noHighlightInfo:frames.noHighlightInfo,blankInfo:frames.blankInfo,marks:frames.marks,lineChangesBeforeSeek:afterLines.lineChanges,loopWraps:wraps,drawCounts:{entries:counts.length,maxEmptyInView:Math.max(0,...counts.map(c=>c.emptyInView)),overPainted:counts.filter(c=>c.painted>c.allowed+1).length}};
    console.log(JSON.stringify(result));
    if(!strict)return result;
    assert.equal(frames.blank,BUDGET.blankFrames,`${label}: ${frames.blank} presented frames had a system in view without a drawing (frames ${frames.blankFrames.join(',')})`);
    // A beat that is only a rest has nothing to highlight (a real score has such bars): a score's frames without highlight are compared with a run of the same steps on the complete render.
    assert.ok(frames.noHighlight<=(controlNoHighlight===undefined?BUDGET.noHighlightFrames:controlNoHighlight+BUDGET.noHighlightFrames),`${label}: ${frames.noHighlight} presented frames while playing had no highlighted beat (frames ${frames.noHighlightFrames.join(',')})`);
    assert.equal(result.drawCounts.maxEmptyInView,0,`${label}: a draw or a scroll left a system in view empty`);
    return result;
  } finally {
    if(browser)await browser.close().catch(()=>{});
    stop(id);
  }
}

const directory=mkdtempSync(join(tmpdir(),'tabplayer-playback-draw-')),results=[];
try {
  if(process.env.PLAYBACK_SKIP_GENERATED!=='1'){const file=join(directory,'long.gp');writeFileSync(file,generate(48));results.push(await probe(file,'generated score'));}
  for(const [index,path] of ownerScoreFiles(process.env.TP_OWNER_SCORES).entries()) {
    if(process.env.PLAYBACK_ONLY&&Number(process.env.PLAYBACK_ONLY)!==index)continue;
    // The same steps on the complete render first: it shows how many frames a score has no highlighted beat for by itself (bars with only rests have nothing to highlight).
    const control=await probe(path,`owner score ${index+1} (complete render)`,{lazy:false,ahead:0,paintOnCursor:false},{strict:false});
    results.push(control,await probe(path,`owner score ${index+1}`,{},{controlNoHighlight:control.noHighlightFrames}));
  }
  console.log(JSON.stringify(results,null,2));
} finally {rmSync(directory,{recursive:true,force:true});}
