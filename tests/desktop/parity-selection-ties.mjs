import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { directory,launch,connect,stop } from './harness.mjs';

// Selection ties: a two-voice guitar score repeats each pitch, so selecting measure 2 and choosing
// "Tie selected notes" ties every note of both voices in one edit. Measure 1 is refused because its
// first notes have nothing to tie from; Untie, undo/redo and GP export behave.
const fixture=resolve(directory,'selection-ties-fixture.gp'),exported=resolve(directory,'gp8-selection-ties'),gp=`${exported}.gp`;
{
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<3;index++){
    score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),melody=new model.Voice(),chords=new model.Voice();bar.clef=model.Clef.G2;
    for(let beat=0;beat<4;beat++){const value=new model.Beat();value.duration=4;const note=new model.Note();note.string=1;note.fret=5;value.addNote(note);melody.addBeat(value);}
    for(let beat=0;beat<2;beat++){const value=new model.Beat();value.duration=2;for(const string of [4,5]){const note=new model.Note();note.string=string;note.fret=2;value.addNote(note);}chords.addBeat(value);}
    bar.addVoice(melody);bar.addVoice(chords);staff.addBar(bar);
  }
  score.finish(new Settings());writeFileSync(fixture,new exporter.Gp7Exporter().export(score,new Settings()));
}
const load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
const tied=score=>score.tracks[0].staves[0].bars.map(bar=>bar.voices.map(voice=>voice.beats.map(beat=>beat.notes.map(note=>note.isTieDestination?'T':'-').join('')).join(' ')).join(' '));
const id=launch({TABPLAYER_TEST_OPEN:fixture,TABPLAYER_TEST_EXPORT:exported});let browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const panel=()=>page.locator('summary').filter({hasText:'Music selection'}).first().evaluate(node=>{node.parentElement.open=true;});
  const click=async(name,check=idle)=>{await panel();await page.getByRole('button',{name,exact:true}).click();await check();};
  const exportGp=async()=>{await button('Export GP');return load(readFileSync(gp));};
  const edits=async()=>(await readActiveDocument(page)).project.edits;
  await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  await click('Select bar');
  await click('Tie selected notes',async()=>{await waitForWorkspaceIdle(page);assert.match((await page.getByRole('alert').allTextContents()).join(' '),/to tie from/);});
  assert.equal((await edits()).length,0,'A refused tie records nothing.');
  await page.getByLabel('Measure',{exact:true}).fill('2');await click('Select bar',()=>waitForWorkspaceIdle(page));// The refusal stays on screen until the next successful edit replaces it.
  await click('Tie selected notes');
  assert.deepEqual((await edits()).map(edit=>[edit.type,edit.tied,edit.selection.firstBar,edit.selection.lastBar]),[['setSelectionTies',true,1,1]]);
  const joined=await exportGp();
  assert.deepEqual(tied(joined),['- - - - -- --','T T T T TT TT','- - - - -- --']);
  const origin=joined.tracks[0].staves[0].bars[1].voices[1].beats[0].notes[0].tieOrigin;assert.equal(origin?.beat.voice.bar.index,0,'Voice 2 ties back into measure 1.');
  await click('Untie selected notes');assert.deepEqual(tied(await exportGp()),['- - - - -- --','- - - - -- --','- - - - -- --']);
  await button('Undo');assert.deepEqual(tied(await exportGp()),tied(joined));
  await button('Undo');await button('Redo');assert.deepEqual(tied(await exportGp()),tied(joined));
  await page.waitForFunction(async()=>{const status=await window.__TAURI_INTERNALS__.invoke('audio_status');if(status.error)throw new Error(status.error);return status.ready;},undefined,{timeout:20000});
  assert.deepEqual(errors,[]);
  console.log(`selection ties: measure 2 ties ${tied(joined)[1]} across both voices in one edit; measure 1 refused; untie, undo/redo kept.`);
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/selection-ties-failure.png')}).catch(()=>{});throw error;}
finally{if(browser)await browser.close().catch(()=>{});stop(id);}
