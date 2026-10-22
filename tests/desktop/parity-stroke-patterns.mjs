import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importer,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// Stroke patterns: Select track on Guitar9, apply alternate picking and a brush pattern through the
// Music selection panel, export GP and check every sounding beat of each voice follows the pattern in
// time order (rests skipped), while notes, the drums lane refusal and undo/redo behave.
await buildInstrumentFixture();
const exported=resolve(directory,'gp8-stroke-patterns'),gp=`${exported}.gp`;
const load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
const lanes=score=>score.tracks[0].staves[0].bars[0].voices.map((_,voice)=>score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[voice]?.beats??[]).filter(beat=>beat.notes.length));
const pitches=score=>score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(note=>note.realValue)))))).join(',');
const source=load(readFileSync(fixturePath));
let id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT:exported}),browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const panel=()=>page.locator('summary').filter({hasText:'Music selection'}).first().evaluate(node=>{node.parentElement.open=true;});
  const click=async name=>{await panel();await page.getByRole('button',{name,exact:true}).click();await idle();};
  const exportGp=async()=>{await button('Export GP');return load(readFileSync(gp));};
  await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await button('Track 1: Guitar9');await click('Select track');
  await page.getByRole('combobox',{name:/^Pattern technique/}).selectOption('pick');await click('Alternate picking');await click('Apply stroke pattern');
  const picked=await exportGp(),expected=['D','U'];
  for(const lane of lanes(picked))lane.forEach((beat,index)=>assert.equal(beat.pickStroke,expected[index%2]==='D'?model.PickStroke.Down:model.PickStroke.Up,`beat ${index} of a Guitar9 voice`));
  assert.equal(pitches(picked),pitches(source),'Patterns never change notes.');
  await page.getByRole('combobox',{name:/^Pattern technique/}).selectOption('brush');await page.getByLabel('Stroke pattern',{exact:true}).fill('D D U -');await click('Apply stroke pattern');
  const brushed=await exportGp(),brushes=[model.BrushType.BrushDown,model.BrushType.BrushDown,model.BrushType.BrushUp,model.BrushType.None];
  for(const lane of lanes(brushed))lane.forEach((beat,index)=>{assert.equal(beat.brushType,brushes[index%4]);assert.ok(beat.pickStroke!==model.PickStroke.None,'brushes keep the pick strokes');assert.equal(beat.brushDuration>0,brushes[index%4]!==model.BrushType.None,'brushes stay audible after GP export');});
  const edits=(await readActiveDocument(page)).project.edits.slice(-2);
  assert.deepEqual(edits.map(edit=>[edit.type,edit.technique,edit.pattern]),[['setSelectionStrokes','pick',['down','up']],['setSelectionStrokes','brush',['down','down','up','none']]]);
  assert.deepEqual(edits[0].selection,{kind:'bars',tracks:[0],firstBar:0,lastBar:source.masterBars.length-1});
  await button('Track 3: Drums');await click('Select track');
  assert.equal(await page.getByRole('button',{name:'Apply stroke pattern',exact:true}).isDisabled(),true,'Drums cannot take stroke patterns.');
  await button('Undo');const undone=await exportGp();assert.ok(lanes(undone).flat().every(beat=>beat.brushType===model.BrushType.None));
  await button('Redo');assert.deepEqual((await readActiveDocument(page)).project.edits.slice(-2),edits);
  // Redo prepares playback again; it must come back ready without an error.
  await page.waitForFunction(async()=>{const status=await window.__TAURI_INTERNALS__.invoke('audio_status');if(status.error)throw new Error(status.error);return status.ready;},undefined,{timeout:20000});
  assert.deepEqual(errors,[]);
  console.log(`stroke patterns: Guitar9 ${lanes(picked).map(lane=>lane.length).join('+')} sounding beats alternate D/U and take brush D D U -; drums refused; undo/redo kept.`);
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/stroke-patterns-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
