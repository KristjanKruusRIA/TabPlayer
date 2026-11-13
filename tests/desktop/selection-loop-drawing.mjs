import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { launch,connect,stop,directory } from './harness.mjs';
import { closeWelcomeLibrary,waitForWorkspaceIdle,revealPlaybackControls,clickWorkstationButton } from './workstation-commands.mjs';

// THE-193: the selected passage and the running loop are drawn on the score, the overview and the position display.
// Select a passage that crosses a line break, loop it, and photograph the three places at 1280x800 and 960x600.
// Screenshots go outside the repository (THE193_SHOTS, default: tabplayer-the-193 under the operating system's temp folder).
const shots=process.env.THE193_SHOTS??resolve(tmpdir(),'tabplayer-the-193');
mkdirSync(shots,{recursive:true});
const example=resolve(directory,'library/examples/example-windowline.tabplayer');
const id=launch({TABPLAYER_TEST_OPEN:example});
let browser,page;
const result={shots:[],checks:{}};
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
async function waitStatus(predicate,label,timeout=15000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(40);}throw new Error(`${label}: ${JSON.stringify(last)}`);}
/** Each fret number of the displayed tab staves, with its place on the screen. Bar numbers and the like are not digits drawn at tab size. */
const frets=()=>page.evaluate(()=>[...document.querySelectorAll('[aria-label="Music notation"] svg text')].filter(node=>/^\d+$/.test(node.textContent??'')).map(node=>{const box=node.getBoundingClientRect();return {text:node.textContent,x:box.x+box.width/2,y:box.y+box.height/2,w:box.width,h:box.height};}));
/** The page's systems from the layout of its fret numbers: the six lines of one tab staff are under 100px apart, two systems are further. */
async function systems(){
  const all=(await frets()).filter(item=>item.h>6&&item.h<30).sort((a,b)=>a.y-b.y||a.x-b.x),rows=[];
  for(const item of all){const row=rows.at(-1);if(row&&item.y-row.last<100){row.items.push(item);row.last=item.y;}else rows.push({last:item.y,items:[item]});}
  return rows.map(row=>({y:row.items[0].y,items:row.items.sort((a,b)=>a.x-b.x)}));
}
const shot=async name=>{const path=resolve(shots,`${name}.png`);await page.screenshot({path});result.shots.push(path);return path;};
const box=selector=>page.locator(selector).first().boundingBox();
try {
  browser=await connect();page=browser.contexts()[0].pages()[0];
  await page.setViewportSize({width:1280,height:800});
  await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  await clickWorkstationButton(page,'Open');await waitForWorkspaceIdle(page);
  await waitStatus(value=>value.ready&&!value.error,'ready');
  await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await page.waitForTimeout(800);

  // The page is wider than the score area at 1280 (a known friction), so fit it to the width; select on a tall window so both systems are on screen, then go back to the size under test.
  // An untouched score now opens fitted when the page is wider than its area, so press Fit width only if it is not on already (a second press turns it off).
  const fitWidth=page.getByRole('button',{name:'Fit width',exact:true});
  if(await fitWidth.getAttribute('aria-pressed')!=='true')await fitWidth.click();
  await page.setViewportSize({width:1280,height:1300});await page.waitForTimeout(900);
  // A passage across a line break: from a note in the last bar of the first system to one in the first bar of the second.
  const rows=await systems();
  assert.ok(rows.length>=2,`the score needs two systems, found ${rows.length}`);
  const first=rows[0].items.at(-1),second=rows[1].items[0];
  await page.mouse.click(first.x,first.y);
  await page.keyboard.down('Shift');await page.mouse.click(second.x,second.y);await page.keyboard.up('Shift');
  await page.waitForTimeout(400);
  const bands=await page.locator('.score-range-block').count();
  result.checks.selectionBands=bands;
  assert.ok(bands>=2,`a passage across a line break draws a band per system, found ${bands}`);
  await page.setViewportSize({width:1280,height:800});await page.waitForTimeout(600);
  await shot('1280-selection-only');

  // Loop it: Loop selection (More playback, Selected playback) arms the loop on the selected passage.
  await revealPlaybackControls(page);
  const summary=page.locator('summary').filter({hasText:/^Selected playback$/}).first();
  if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();
  await page.getByRole('button',{name:'Loop selection',exact:true}).click();
  const armed=await waitStatus(value=>value.loop!==null,'loop armed');
  result.checks.loop=armed.loop;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const loopBands=await page.locator('.score-loop-band').count();
  result.checks.loopBands=loopBands;assert.ok(loopBands>=2,`the loop draws a band per system, found ${loopBands}`);
  result.checks.chip=await page.locator('.transport-lcd-loop').textContent();
  result.checks.status=await page.getByText(/^Looping bars?/).first().textContent();
  result.checks.overviewMarks=await page.locator('.score-overview-loop').count();
  assert.ok(result.checks.overviewMarks>=1);
  // Both systems at once, to see the passage across the line break whole.
  await page.setViewportSize({width:1280,height:1300});await page.waitForTimeout(700);
  await page.locator('.paper-scroll').evaluate(node=>{node.scrollTop=0;});await shot('1280x1300-line-break');
  for(const [width,height] of [[1280,800],[960,600]]){
    await page.setViewportSize({width,height});await page.waitForTimeout(600);
    await page.locator('.paper-scroll').evaluate(node=>{node.scrollTop=0;});await page.waitForTimeout(150);
    await shot(`${width}-selection-and-loop`);
    // The second system's part of the passage, scrolled into the short score area.
    await page.locator('.paper-scroll').evaluate(node=>{const band=document.querySelectorAll('.score-loop-band')[1];node.scrollTop=band?band.offsetTop-30:node.scrollHeight;});await page.waitForTimeout(200);
    await shot(`${width}-selection-and-loop-second-system`);
    result.checks[`pointerEvents${width}`]=await page.evaluate(()=>[...document.querySelectorAll('.score-range-block,.score-loop-band,.score-overview-loop')].map(node=>getComputedStyle(node).pointerEvents));
    assert.ok(result.checks[`pointerEvents${width}`].every(value=>value==='none'));
  }
  // The same selection and loop in the other layouts, and after a zoom: the bands follow the renderer's own bounds in each.
  await page.setViewportSize({width:1280,height:1300});
  const layout=page.getByRole('combobox').filter({has:page.locator('option[value="verticalPage"]')}).first();
  result.checks.layouts={};
  for(const name of ['verticalPage','horizontalPage','grid','verticalScreen','horizontalScreen','parchment']){
    await layout.selectOption(name);await page.waitForTimeout(1200);
    const counts={selection:await page.locator('.score-range-block').count(),loop:await page.locator('.score-loop-band').count()};
    result.checks.layouts[name]=counts;
    await shot(`1280x1300-layout-${name}`);
  }
  for(const [name,counts] of Object.entries(result.checks.layouts))assert.ok(counts.selection>=1&&counts.loop>=1,`${name} draws both: ${JSON.stringify(counts)}`);
  writeFileSync(resolve(shots,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} catch(error) {
  if(page)await page.screenshot({path:resolve(shots,'failure.png')}).catch(()=>{});
  throw error;
} finally {try{stop(id);}finally{if(browser)await browser.close();}}
