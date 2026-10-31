import {waitForWorkspaceIdle,clickWorkstationButton,revealDock} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// Moving a track: the four-track fixture's Bass6 moves up to first place, keeps its notes and
// selection, and a GP export carries the new order; Undo restores the original order.
await buildInstrumentFixture();
const exported=resolve(directory,'gp8-move-track.gp');rmSync(exported,{force:true});
const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT:exported});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const tracks=async()=>{await revealDock(page,'Mixer');return page.getByRole('button',{name:/^Track \d+: /}).evaluateAll(nodes=>nodes.map(node=>(node.getAttribute('aria-label')??node.textContent??'').trim()));};
  await button('Open');
  const before=await tracks();assert.deepEqual(before.map(text=>text.replace(/^Track \d+: /,'')).slice(0,4),['Guitar9','Bass6','Drums','Keys']);
  await button('Track 2: Bass6');
  await page.locator('.track-settings').getByRole('button',{name:'Move track up',exact:true}).click();await waitForWorkspaceIdle(page);
  const document=await readActiveDocument(page);
  assert.deepEqual(document.project.edits.at(-1),{type:'moveTrack',track:1,to:0});
  assert.deepEqual((await tracks()).slice(0,2),['Track 1: Bass6','Track 2: Guitar9']);
  // The selection follows the moved track, so the panel still shows Bass6 and it can't move further up.
  assert.equal(await page.locator('.track-settings h2').innerText(),'Bass6');
  assert.equal(await page.locator('.track-settings').getByRole('button',{name:'Move track up',exact:true}).isDisabled(),true);
  await button('Export GP');
  const order=await page.evaluate(async bytes=>{const {importer,Settings}=await import('/alphatab/alphaTab.mjs');const score=importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),new Settings());return score.tracks.map(track=>[track.name,track.staves[0].bars.some(bar=>bar.voices.some(voice=>voice.beats.some(beat=>beat.notes.length)))]);},[...readFileSync(exported)]);
  assert.deepEqual(order.map(([name])=>name),['Bass6','Guitar9','Drums','Keys']);
  assert.equal(order[0][1],true,'Bass6 keeps its notes after the move.');
  await button('Undo');
  assert.deepEqual((await tracks()).slice(0,2),['Track 1: Guitar9','Track 2: Bass6']);
  // Undo moves Bass6 back to second place and the selection goes with it.
  assert.equal(await page.locator('.track-settings h2').innerText(),'Bass6');
  assert.deepEqual(errors,[]);
  console.log(`move track: ${order.map(([name])=>name).join(', ')}; undo restored the order.`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
