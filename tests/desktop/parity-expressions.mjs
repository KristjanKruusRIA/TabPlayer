import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Expression text: typed without a command, ff, [Verse], D.S. al Coda, bass, G major and Am run from the palette
// as undoable edits on the edit target's note, beat and measure; a 3/4 that would overfill the measure is
// explained and does nothing; the action list shows shortcuts; Ctrl+Z undoes the last expression.
const fixture=resolve(directory,'expressions-fixture.gp');
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<2;index++){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;const note=new model.Note();note.string=6;note.fret=0;value.addNote(note);voice.addBeat(value);}bar.addVoice(voice);staff.addBar(bar);}
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const id=launch({TABPLAYER_TEST_OPEN:fixture});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const workspace=page.getByRole('region',{name:'Score workspace'}),palette=page.getByRole('dialog',{name:'Commands',exact:true}),field=palette.getByRole('combobox',{name:'Command'});
  const open=async()=>{await workspace.focus();await page.keyboard.press('Control+Shift+P');await field.waitFor();};
  const run=async text=>{
    await open();await field.fill(text);
    const option=palette.getByRole('option').first();assert.equal(await option.getAttribute('aria-disabled'),'false',`${text}: ${await option.textContent()}`);
    await page.keyboard.press('Enter');await palette.waitFor({state:'detached'});await waitForWorkspaceIdle(page);
  };
  // The action list shows shortcuts beside the commands that have them.
  await open();await field.fill('save');
  assert.equal(await palette.getByRole('option').first().textContent(),'Save Ctrl+S');
  // A time signature the measure's four quarters would overfill is explained and cannot run.
  await field.fill('3/4');
  const refused=palette.getByRole('option').first();
  assert.equal(await refused.textContent(),'Time signature 3/4 for measure 1 — Measure 1 holds more music than 3/4 allows; shorten or remove beats first.');
  assert.equal(await refused.getAttribute('aria-disabled'),'true');
  await page.keyboard.press('Enter');assert.equal(await palette.isVisible(),true);
  await page.keyboard.press('Escape');await palette.waitFor({state:'detached'});
  for(const text of ['ff','[Verse]','D.S. al Coda','bass','G major','Am'])await run(text);
  const document=await readActiveDocument(page);
  assert.deepEqual(document.project.edits.map(edit=>edit.type),['setNoteTechniquesByIndex','setMeasureSettings','setDirections','setBarNotation','setBarNotation','setHarmonyChord']);
  assert.equal(document.dirty,true);
  const [dynamic,section,directions,clef,key,chord]=document.project.edits;
  assert.deepEqual([dynamic.patch,section.section,section.numerator,directions.directions,clef.clef,key.keySignature,key.clef,chord.chord.name,chord.chord.showDiagram],
    [{dynamics:model.DynamicValue.FF},'Verse',4,[model.Direction.JumpDalSegnoAlCoda],model.Clef.F4,1,model.Clef.F4,'Am',true]);
  // The chord name and section are engraved.
  const notation=page.locator('[aria-label="Music notation"]');
  await notation.locator('text').filter({hasText:/^Am$/}).first().waitFor();
  await notation.locator('text').filter({hasText:'Verse'}).first().waitFor();
  // Ctrl+Z undoes the last expression like any edit.
  await workspace.focus();await page.keyboard.press('Control+z');await waitForWorkspaceIdle(page);
  const undone=await readActiveDocument(page);
  assert.equal(undone.canRedo,true);await notation.locator('text').filter({hasText:/^Am$/}).first().waitFor({state:'detached'});
  assert.deepEqual(errors,[]);
  console.log('expressions: ff, [Verse], D.S. al Coda, bass, G major and Am ran as undoable edits; an overfilling 3/4 was explained; Save showed Ctrl+S.');
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/expressions-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
