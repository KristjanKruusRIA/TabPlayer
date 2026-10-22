import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// Wah gestures: the first beat of the four-track fixture gets a closed wah from Beat notation,
// a GP export carries it, and Undo clears it again.
await buildInstrumentFixture();
const exported=resolve(directory,'gp8-wah.gp');rmSync(exported,{force:true});
const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT:exported});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  await button('Open');
  await page.locator('summary').filter({hasText:'Beat notation'}).first().evaluate(node=>{node.parentElement.open=true;});
  const wah=page.getByRole('combobox',{name:/^Wah pedal/});
  assert.equal(await wah.inputValue(),'0');
  await wah.selectOption('2');await button('Apply beat gestures');
  const edit=(await readActiveDocument(page)).project.edits.at(-1);
  assert.deepEqual({type:edit.type,patch:edit.patch},{type:'setBeatGestures',patch:{wahPedal:2}});
  await button('Export GP');
  const wahs=await page.evaluate(async bytes=>{const {importer,Settings}=await import('/alphatab/alphaTab.mjs');const score=importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),new Settings());
    return score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.filter(beat=>beat.wahPedal!==0).map(beat=>`${track.name}:${bar.index}:${beat.index}=${beat.wahPedal}`)))));},[...readFileSync(exported)]);
  assert.deepEqual(wahs,[`Guitar9:${edit.target.bar}:${edit.target.beat}=2`]);
  await button('Undo');
  assert.equal(await wah.inputValue(),'0');
  assert.deepEqual(errors,[]);
  console.log(`wah: exported ${wahs.join(', ')}; undo cleared it.`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
