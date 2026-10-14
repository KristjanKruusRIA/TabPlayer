import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { directory, launch, connect, stop } from './harness.mjs';

const source=process.env.TABPLAYER_TEST_GP;
if(!source)throw new Error('Set TABPLAYER_TEST_GP to an authorized private score.');
const bytes=readFileSync(source),sourceHash=createHash('sha256').update(bytes).digest('hex'),saved=resolve(directory,`advanced-${Date.now()}.tabplayer`);
let id=launch({TABPLAYER_TEST_OPEN:source,TABPLAYER_TEST_SAVE:saved}),browser=await connect(),page=browser.contexts()[0].pages()[0];
const snapshot=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('project_snapshot'));
const idle=async()=>{await page.waitForFunction(()=>!document.querySelector('nav button').disabled);const error=page.getByRole('alert');if(await error.count())throw new Error(await error.textContent());};
const button=async name=>{await page.getByRole('button',{name,exact:true}).click();await idle();};
const openDetails=async text=>{const summary=page.locator('summary').filter({hasText:text}).first();await summary.evaluate(node=>node.parentElement.open=true);};
const change=async(label,value)=>page.getByLabel(label,{exact:true}).fill(String(value));
try {
  await button('Open');assert.equal((await snapshot()).project.base.sha256,sourceHash);
  await page.locator('.track-card').filter({hasText:/\d+ strings/}).first().getByRole('button').click();
  if(await page.getByRole('button',{name:'Apply tuning',exact:true}).isDisabled())throw new Error('The smoke fixture must begin with a stringed instrument.');
  if(await page.getByRole('button',{name:'Apply rhythm',exact:true}).isDisabled())await button('Insert beat');
  await page.getByRole('combobox',{name:/^Duration/}).selectOption('8');await button('Apply rhythm');
  await page.getByRole('combobox',{name:/^String/}).selectOption('2');await change('Fret',7);await button('Set note');
  await openDetails('Notes & techniques');await page.getByLabel('Palm mute',{exact:true}).check();await idle();
  await page.getByRole('combobox',{name:/^Vibrato/}).selectOption('1');await idle();
  await openDetails('Bend curve');await page.getByLabel('Enable Bend',{exact:true}).check();await change('Bend point 2 value',4);await button('Apply Bend curve');
  await openDetails('Selected instrument');await change('Track name','Advanced study');await change('Track short name','Adv');await page.getByRole('combobox',{name:/^Track MIDI instrument/}).selectOption('27');await button('Apply instrument settings');
  await openDetails('Staff, voices & layout');if(await page.getByRole('button',{name:'Add voice',exact:true}).isDisabled())await button('Remove voice');await button('Add voice');await page.getByRole('combobox',{name:/^Copy selected voice to/}).selectOption('1');await button('Copy voice range');await button('Add staff');
  await openDetails('Measure & notation');await change('Section label','Advanced verse');await button('Apply measure settings');await page.getByRole('combobox',{name:/^Key signature/}).selectOption('2');await button('Apply bar notation');
  await openDetails('Beat text & chord');await change('Beat text','Advanced editor smoke');await button('Apply beat text');await button('Edit chord diagram');await change('Chord name','D');await change('Diagram string 1',2);await change('Diagram string 2',3);await change('Diagram string 3',2);await button('Apply chord');
  const beforeUndo=await snapshot();await button('Undo');assert.equal((await snapshot()).project.edits.length,beforeUndo.project.edits.length-1);await button('Redo');assert.deepEqual((await snapshot()).project,beforeUndo.project);
  await button('Save');const before=await snapshot();assert.equal(before.dirty,false);
  await page.screenshot({path:resolve(directory,'advanced-editor.png')});
  await browser.close();stop(id);id=launch({TABPLAYER_TEST_OPEN:saved});browser=await connect();page=browser.contexts()[0].pages()[0];await button('Open');
  assert.deepEqual((await snapshot()).project,before.project);assert.equal((await snapshot()).project.base.bytesBase64,bytes.toString('base64'));assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),sourceHash);
  const types=new Set(before.project.edits.map(e=>e.type));for(const type of ['setBeatRhythm','setNoteTechniques','setTrackInfo','addVoice','copyVoice','addStaff','setMeasureSettings','setBarNotation','setBeatAnnotation'])assert(types.has(type),`Missing ${type}`);
  writeFileSync(resolve(directory,'advanced-editor-result.json'),JSON.stringify({sourceHash,sourcePreserved:true,nativeRestartReopen:true,editCount:before.project.edits.length,commandTypes:[...types],saved},null,2));
  console.log('Advanced native editor: curves, articulation, imported program, voice copy, staff, measure, key, chord, undo/redo and save/restart/reopen passed.');
} finally {await browser.close();try{stop(id);}catch{}}
