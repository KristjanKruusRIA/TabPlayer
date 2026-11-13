import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Left-handed neck and the combined neck + keyboard: the neck mirrors with upright fret numbers, the choice
// survives hiding the view, and both instruments of the combined view mark the same selected-bar notes.
const fixture=resolve(directory,'instrument-handedness-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();
  for(const fret of [0,1,2,3]){const value=new model.Beat();value.duration=4;const note=new model.Note();note.string=1;note.fret=fret;value.addNote(note);voice.addBeat(value);}
  bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await page.waitForFunction(()=>window.__TAURI_INTERNALS__.invoke('audio_status').then(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration),null,{timeout:15000,polling:100});
  const before=await readActiveDocument(page);
  await clickWorkstationButton(page,'Show instrument');
  const view=page.getByRole('region',{name:'Instrument view'});
  await view.getByRole('combobox',{name:'Show'}).selectOption('bar');await view.locator('g[data-note-id]').nth(3).waitFor();
  const numbers=()=>view.locator('[data-fret-number]').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>[node.dataset.fretNumber,node.getBoundingClientRect().x])));
  const marks=()=>view.locator('g[data-note-id]').evaluateAll(nodes=>nodes.map(node=>({fret:Number(node.dataset.fret),x:node.getBoundingClientRect().x})).sort((a,b)=>a.fret-b.fret));
  let right=await numbers(),rightMarks=await marks();assert.ok(right[0]<right[12],'right-handed nut on the left');assert.ok(rightMarks[0].x<rightMarks[3].x);
  const left=view.getByRole('checkbox',{name:'Left-handed'});await left.check();
  await view.getByRole('group',{name:'Guitar fretboard, left-handed'}).waitFor();
  const mirrored=await numbers(),mirroredMarks=await marks();
  assert.ok(mirrored[0]>mirrored[12],'left-handed nut on the right');assert.ok(mirroredMarks[0].x>mirroredMarks[3].x,'higher frets to the left');
  assert.deepEqual(mirroredMarks.map(mark=>mark.fret),[0,1,2,3]);
  // Fret number text is not mirrored: its glyphs keep a normal left-to-right layout.
  const upright=await view.locator('[data-fret-number="12"]').evaluate(node=>{const m=node.getScreenCTM();return m.a>0;});assert.equal(upright,true);
  await clickWorkstationButton(page,'Hide instrument');await clickWorkstationButton(page,'Show instrument');
  assert.equal(await view.getByRole('checkbox',{name:'Left-handed'}).isChecked(),true,'the choice is remembered');
  await view.getByRole('combobox',{name:'Show'}).selectOption('bar');
  await view.getByRole('combobox',{name:'Instrument view mode'}).selectOption('both');
  await view.getByRole('group',{name:'Guitar fretboard, left-handed'}).waitFor();await view.getByRole('group',{name:'Keyboard'}).waitFor();
  await view.getByRole('heading').filter({hasText:'Neck + keys'}).waitFor();
  const frets=await view.locator('g[data-note-id]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.key)).sort((a,b)=>a-b));
  const keys=await view.locator('g[data-key][data-active="true"]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.key)).sort((a,b)=>a-b));
  assert.deepEqual(frets,[40,41,42,43]);assert.deepEqual(keys,frets,'neck and keyboard mark the same pitches');
  await view.screenshot({path:resolve(directory,'instrument-handedness.png')});
  await left.uncheck().catch(()=>view.getByRole('checkbox',{name:'Left-handed'}).uncheck());
  const after=await readActiveDocument(page);assert.deepEqual(after.project,before.project);assert.equal(after.dirty,before.dirty);assert.deepEqual(errors,[]);
  writeFileSync(resolve(directory,'instrument-handedness-result.json'),JSON.stringify({right,mirrored,keys},null,2));
  console.log('Instrument handedness passed:',JSON.stringify({nut:[right[0],mirrored[0]],keys}));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
