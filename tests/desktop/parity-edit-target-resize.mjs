// THE-208: the blue edit-target box follows the score when the page moves without the score being drawn again. The page is centred in
// the score area, so a resize of the window, or a panel opened or closed beside it, moves the page. After every such change the box
// must sit on the first beat, where the green playback cursor is. Run from the checkout root after the desktop test build (see CLAUDE.md).
import {waitForWorkspaceIdle,closeWelcomeLibrary,clickWorkstationButton} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {directory,launch,connect,stop} from './harness.mjs';

const example=resolve(directory,'library/examples/example-windowline.tabplayer');
assert.ok(existsSync(example),'Run scripts/build-desktop-test.ps1 first: the Library example is missing.');
const out=resolve(process.env.TABPLAYER_PARITY_OUT??'.analysis/parity');mkdirSync(out,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:example});
let browser,page;const result={checks:[]},errors=[];
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const frames=count=>page.evaluate(count=>new Promise(done=>{let left=count;const step=()=>--left<=0?done():requestAnimationFrame(step);requestAnimationFrame(step);}),count);
const read=()=>page.evaluate(()=>{
  const rect=node=>{const box=node?.getBoundingClientRect();return box?{x:box.x,y:box.y,w:box.width,h:box.height}:null;};
  return {box:rect(document.querySelector('.score-edit-target')),cursor:rect(document.querySelector('.at-cursor-beat')),paper:rect(document.querySelector('.score-live-paper')),refreshMs:performance.getEntriesByName('tabplayer:overlay-refresh').at(-1)?.duration??null};
});
const relative=new Map();
/**
 * The box is checked against the page it sits on, twice: on the first frame after the change, so a one-frame lag fails, and once settled.
 * Settled, and while the target is the first beat, the green cursor line is the oracle. Whatever the beat, the box keeps its place on the page:
 * `track` names a position measured when the page last changed for another reason (a resize and a panel move the page, not the score).
 */
async function measure(label,{track=null,first=true,settle=true}={}){
  for(const stage of settle?['first frame','settled']:['first frame']){
    if(stage==='first frame')await frames(1);else{await frames(2);await sleep(250);}
    const found=await read(),{box,cursor,paper}=found,where=`${label} (${stage})`;
    assert.ok(box,`${where}: the edit-target box is missing`);
    // The cursor line is alphaTab's own and may trail a frame itself, so it is the oracle once settled; the first frame is judged by the box's place on the page.
    if(first&&stage==='settled'){
      assert.ok(cursor,`${where}: the playback cursor is missing`);
      const middle=cursor.x+cursor.w/2;
      assert.ok(box.x-1<=middle&&middle<=box.x+box.w+1,`${where}: the box (x ${box.x.toFixed(1)}..${(box.x+box.w).toFixed(1)}) does not hold the first beat (cursor at ${middle.toFixed(1)})`);
      assert.ok(box.y<cursor.y+cursor.h&&box.y+box.h>cursor.y,`${where}: the box is not on the cursor's system`);
    }
    if(paper){
      assert.ok(box.x>=paper.x-1&&box.x+box.w<=paper.x+paper.w+1,`${where}: the box lies outside the page`);
      if(track){
        // A page of another width was laid out again (the score reflowed), so its marks legitimately stand elsewhere: compare like with like.
        const key=`${track} @${Math.round(paper.w)}`,here=box.x-paper.x;if(!relative.has(key))relative.set(key,here);
        assert.ok(Math.abs(here-relative.get(key))<=1,`${where}: the box moved ${(here-relative.get(key)).toFixed(1)} px on the page`);
      }
    }
    if(stage==='settled'||!settle){result.checks.push({label:where,...found});await page.screenshot({path:resolve(out,`edit-target-resize-${result.checks.length}-${label.replace(/[^a-z0-9]+/gi,'-')}.png`)});}
  }
}
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1280,height:800});
  await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);
  await page.getByRole('img',{name:'Edit target',exact:true}).waitFor();
  const sizes=[[1280,800],[960,600],[1600,1000],[1280,800],[1600,1000],[960,600],[1440,900],[1440,600],[1440,1000],[1281,900],[1333,900]];
  // First beat: the cursor line is the oracle, and the position on the page must not change under a resize.
  await measure('beat 1 1280x800',{track:'beat 1'});
  for(const [width,height] of sizes){await page.setViewportSize({width,height});await measure(`beat 1 ${width}x${height}`,{track:'beat 1'});}
  // The cost of one refresh on this score, as the last resize measured it.
  result.refreshMs=(await read()).refreshMs;
  // Second beat: the box moves with the target, and again keeps its place on the page through every resize.
  const workspace=page.getByRole('region',{name:'Score workspace'});
  await page.setViewportSize({width:1280,height:800});await workspace.focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('.score-hint')?.textContent?.includes('Beat 2'));
  await measure('beat 2 1280x800',{first:false,track:'beat 2'});
  for(const [width,height] of sizes){await page.setViewportSize({width,height});await measure(`beat 2 ${width}x${height}`,{first:false,track:'beat 2'});}
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(()=>document.querySelector('.score-hint')?.textContent?.includes('Beat 1'));
  // Zoom: a new render, so the box is placed by the render's own finish.
  await page.setViewportSize({width:1600,height:1000});await measure('1600x1000 before zoom');
  const zoom=page.getByLabel('Zoom (%)',{exact:true});
  for(const value of [150,75,100]){await zoom.click({clickCount:3});await page.keyboard.type(String(value));await page.keyboard.press('Tab');await waitForWorkspaceIdle(page);await measure(`zoom ${value}`);}
  // Layout: another mode, and back.
  const mode=page.getByRole('combobox',{name:'Display mode',exact:true});
  const original=await mode.inputValue();result.mode=original;
  for(const next of ['horizontalScreen','verticalScreen',original]){await mode.selectOption(next);await waitForWorkspaceIdle(page);await measure(`mode ${next}`);}
  // A panel beside the score: the View menu's checkboxes show and hide it, and the score area changes width.
  const view=page.locator('summary').filter({hasText:/^View$/});
  const toggle=async(name,on)=>{if(!await view.evaluate(node=>node.parentElement.open))await view.click();await page.getByRole('checkbox',{name,exact:true}).setChecked(on);await view.click();await waitForWorkspaceIdle(page);};
  for(const name of ['Inspector','Bottom dock']){
    const checkbox=async()=>{if(!await view.evaluate(node=>node.parentElement.open))await view.click();const state=await page.getByRole('checkbox',{name,exact:true}).isChecked();await view.click();return state;};
    const was=await checkbox();
    await toggle(name,!was);await measure(`${name} ${was?'closed':'opened'}`,{track:name});
    await toggle(name,was);await measure(`${name} ${was?'opened':'closed'}`,{track:name});
  }
  // The symbol popover opens beside a score symbol and stays open, also in the smallest window, where it is taller than the score area: the
  // scrollbar it brings moves the centred page a few pixels as it opens, which is not the page moving away from the symbol.
  for(const [width,height] of [[960,600],[1280,800]]){
    await page.setViewportSize({width,height});await frames(2);await sleep(300);
    const title=page.locator('[aria-label="Music notation"] svg text').filter({hasText:/^Windowline$/}).first();
    await title.scrollIntoViewIfNeeded();await title.dblclick();
    const popover=page.getByRole('dialog').filter({has:page.locator('.score-symbol-popover,[class*="symbol"]')}).or(page.locator('.score-symbol-popover')).first();
    await popover.waitFor({state:'visible',timeout:5000});
    await frames(3);await sleep(800);
    assert.ok(await popover.isVisible(),`the symbol popover closed on its own at ${width}x${height}`);
    result.checks.push({label:`symbol popover stays open ${width}x${height}`,visible:true});
    await page.screenshot({path:resolve(out,`edit-target-resize-popover-${width}x${height}.png`)});
    await page.keyboard.press('Escape');await popover.waitFor({state:'hidden',timeout:5000});
  }
  assert.deepEqual(errors,[]);
  result.passed=true;
}catch(error){result.passed=false;result.failure=String(error?.stack??error);throw error;}
finally{
  writeFileSync(resolve(out,'edit-target-resize.json'),JSON.stringify(result,null,2));
  try{await browser?.close();}catch{}stop(id);
}
console.log(`edit-target resize: ${result.checks.length} placements checked`);
