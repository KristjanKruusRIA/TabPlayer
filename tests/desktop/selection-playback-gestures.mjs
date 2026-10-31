import {waitForWorkspaceIdle,clickWorkstationButton,revealPlaybackControls} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {connect,directory,launch,stop} from './harness.mjs';
import {buildSelectionFixtures,selectionDirectory,sha256} from './selection-playback-fixture.mjs';

// Root executes against its existing diagnostic build; no PCM capture here.
assert.equal(resolve(directory),selectionDirectory);
const fixture=buildSelectionFixtures(`selection-gesture-${Date.now()}-${process.pid}`),prefix=fixture.prefix;
const output=name=>resolve(directory,`${prefix}-${name}`),errors=[],checks={};
let id=null,browser=null,page=null;
const snapshot=()=>readActiveDocument(page);
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
const idle=()=>waitForWorkspaceIdle(page);
const published=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const transport=value=>({generation:value.generation,tick:value.tick,playing:value.playing,range:value.range,loop:value.loop});
async function button(name){await clickWorkstationButton(page,name,{waitForIdle:false});await idle();await published();}
async function waitStatus(predicate){const deadline=Date.now()+15000;let value;do{value=await status();if(predicate(value))return value;await page.waitForTimeout(20);}while(Date.now()<deadline);throw new Error(`Native gesture status timed out: ${JSON.stringify(value)}`);}
async function disclosure(label){if(label==='Selected playback')await revealPlaybackControls(page);const summary=page.locator('summary').filter({hasText:new RegExp(`^${label}$`)}).first();if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();await published();}
async function dismissPlayback(){const summary=page.locator('.transport-more>summary');if(await summary.evaluate(node=>node.parentElement.open)){await summary.press('Escape');await published();}}
async function center(locator){await dismissPlayback();await locator.scrollIntoViewIfNeeded();await published();const box=await locator.boundingBox();assert.ok(box&&box.width>0&&box.height>0,'Actual rendered gesture target must have geometry');return {x:box.x+box.width/2,y:box.y+box.height/2};}
async function location(beat){await page.getByLabel('Editing location',{exact:true}).filter({hasText:`Selection guitar · Measure 1 · Beat ${beat}`}).waitFor();await published();}
async function count(notes,beats){await page.locator('.inspector').getByText(`${notes} ${notes===1?'note':'notes'} · ${beats} ${beats===1?'beat':'beats'}`,{exact:true}).waitFor();await published();}
const frets=value=>page.locator('[aria-label="Music notation"] svg text').filter({hasText:new RegExp(`^${value}$`)});
const occurrence=async number=>{await disclosure('Selected playback');return page.getByRole('combobox',{name:'Selection occurrence',exact:true}).selectOption({label:`Measure 1, occurrence ${number} → measure 1, occurrence ${number}`});};
async function unchanged(before,native){assert.deepEqual(await snapshot(),before,'Gesture/transport must preserve complete project history and redo');if(native)assert.deepEqual(transport(await status()),transport(native),'Selecting alone must preserve native clock, range, loop, generation and run intent');}
async function stopPlayback(){await button('Stop');await waitStatus(value=>value.tick===0&&!value.playing&&value.range===null);}
async function playPassage(start,end){
  await button('Play selection');await waitStatus(value=>value.range?.startTick===start&&value.range?.endTick===end);
  await page.waitForFunction(([start,end])=>{const node=document.querySelector('[aria-label="Selected playback range"]');return Number(node?.getAttribute('data-start-tick'))===start&&Number(node?.getAttribute('data-end-tick'))===end;},[start,end]);
  const ended=await waitStatus(value=>!value.playing&&value.practice.phase==='ended'&&value.tick===end);assert.equal(ended.loop,null);assert.equal(ended.practice.completedPasses,0);return transport(ended);
}

try{
  id=launch({TABPLAYER_TEST_OPEN:fixture.fixtures.main.path});browser=await connect();page=browser.contexts()[0].pages()[0];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1280,height:1100});await waitForWorkspaceIdle(page);await button('Open');await waitStatus(value=>value.ready&&!value.error);
  await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await page.getByRole('combobox',{name:'Displayed tracks',exact:true}).selectOption('all');await page.getByLabel('Zoom (%)',{exact:true}).fill('115');await published();
  // Make a real redo entry, then restore source music before acceptance.
  const beforeEdit=await status();await button('Edit');await disclosure('Beat text');await page.getByLabel('Beat text',{exact:true}).fill('Original gesture redo sentinel');await button('Apply beat text');
  const edited=await waitStatus(value=>value.ready&&value.generation>beforeEdit.generation);await button('Undo');await waitStatus(value=>value.ready&&value.generation>edited.generation);
  const baseline=await snapshot();assert.equal(baseline.canRedo,true);assert.equal(baseline.redoEdit.type,'setBeatText');assert.deepEqual(baseline.project.edits,[]);assert.equal(baseline.project.base.sha256,fixture.fixtures.main.sha256);
  const stationary=await status();assert.equal(stationary.playing,false);assert.equal(stationary.tick,0);

  // Sparse notes: both clicks hit actual tablature glyphs; labels prove hits.
  await page.getByRole('region',{name:'Score workspace'}).focus();await page.keyboard.press('Escape');
  let point=await center(frets(5).first());await page.keyboard.down('Control');try{await page.mouse.click(point.x,point.y);}finally{await page.keyboard.up('Control');}
  await location(2);await count(1,1);assert.equal(await page.getByRole('img',{name:'Selected note 1',exact:true}).count(),1);
  assert.equal(await frets(21).count(),1,'Authored sentinel must have one unambiguous rendered fret21');
  point=await center(frets(21));await page.keyboard.down('Control');try{await page.mouse.click(point.x,point.y);}finally{await page.keyboard.up('Control');}
  await location(4);await count(2,2);assert.equal(await page.getByRole('img',{name:/^Selected note \d+$/}).count(),4,'Two selected notes have both staff and tablature markers');await unchanged(baseline,stationary);
  await occurrence(2);await published();await unchanged(baseline,stationary);checks.sparseOccurrence2=await playPassage(8640,11520);await unchanged(baseline);await stopPlayback();
  await occurrence(1);await published();await button('Loop selection');const loop=await waitStatus(value=>value.loop?.startTick===960&&value.loop?.endTick===3840);assert.equal(loop.playing,false);assert.equal(loop.range,null);assert.equal(loop.tick,960);await unchanged(baseline);await button('Clear loop');await waitStatus(value=>value.loop===null);checks.sparseBoundingLoopNoAutoplay=true;

  // Establish beat3's actual caret geometry in case its tied fret is omitted.
  await dismissPlayback();
  await page.getByLabel('Beat',{exact:true}).fill('3');await page.getByRole('combobox',{name:'String',exact:true}).selectOption('6');await location(3);
  await page.getByRole('img',{name:'Edit target',exact:true}).scrollIntoViewIfNeeded();await published();
  // Keep both endpoints in the current score viewport, then measure anew.
  await center(frets(5).first());await center(page.getByRole('img',{name:'Edit target',exact:true}));
  const origin=await frets(5).first().boundingBox(),caret=await page.getByRole('img',{name:'Edit target',exact:true}).boundingBox();assert.ok(origin&&caret);
  const currentOrigin={x:origin.x+origin.width/2,y:origin.y+origin.height/2},currentDestination={x:caret.x+caret.width/2,y:caret.y+caret.height/2};
  for(const point of [currentOrigin,currentDestination])assert.ok(point.x>0&&point.x<1280&&point.y>0&&point.y<1100,'Both fresh source beat positions must be in the viewport');
  const beforeDrag=await status();await page.mouse.move(currentOrigin.x,currentOrigin.y);await page.mouse.down();try{await page.mouse.move(currentDestination.x,currentDestination.y,{steps:12});}finally{await page.mouse.up();}
  await location(2);await count(2,2);await page.getByRole('button',{name:'Resize selection end',exact:true}).waitFor();await unchanged(baseline,beforeDrag);
  await occurrence(1);await published();checks.dragPartialPassage=await playPassage(960,2880);await unchanged(baseline);await stopPlayback();

  // Resize through the public handle, using fresh post-scroll geometry.
  await frets(21).scrollIntoViewIfNeeded();await published();const handle=await center(page.getByRole('button',{name:'Resize selection end',exact:true}));
  const sentinelBox=await frets(21).boundingBox();assert.ok(sentinelBox);const end={x:sentinelBox.x+sentinelBox.width/2,y:sentinelBox.y+sentinelBox.height/2};
  const beforeResize=await status();await page.mouse.move(handle.x,handle.y);await page.mouse.down();try{await page.mouse.move(end.x,end.y,{steps:12});}finally{await page.mouse.up();}
  await count(3,3);await location(2);await unchanged(baseline,beforeResize);await occurrence(1);await published();await button('Loop selection');
  const resized=await waitStatus(value=>value.loop?.startTick===960&&value.loop?.endTick===3840);assert.equal(resized.playing,false);assert.equal(resized.range,null);await button('Clear loop');await waitStatus(value=>value.loop===null);
  checks.resizeBoundingPassage=await playPassage(960,3840);await unchanged(baseline);await stopPlayback();
  assert.equal(sha256(readFileSync(fixture.fixtures.main.path)),fixture.fixtures.main.sha256);assert.deepEqual(errors,[]);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);
  await disclosure('Selected playback');await published();const screenshot=output('1280.png');await page.screenshot({path:screenshot});
  const result={fixture:fixture.metadataPath,sourceSha256:fixture.fixtures.main.sha256,checks,historyIncludingRedoUnchanged:true,zoomPercent:115,displayedTracks:'all',screenshot,pageErrors:errors,evidence:'Actual native UI gestures and callback status only; existing physical PCM evidence is separate. No capture performed here.',visualAcceptance:'Root must inspect the single 1280 screenshot.'};
  writeFileSync(output('result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){if(page)writeFileSync(output('failure.json'),JSON.stringify({error:String(error),status:await status().catch(()=>null),snapshot:await snapshot().catch(()=>null),body:await page.locator('body').innerText().catch(()=>null)},null,2));throw error;}
finally{try{if(browser)await browser.close();}finally{if(id!==null)stop(id);}}
