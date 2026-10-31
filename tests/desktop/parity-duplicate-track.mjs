import {waitForWorkspaceIdle,clickWorkstationButton,revealDock} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// Duplicating a track: the four-track fixture's Bass6 gets a copy right after it that is selected,
// keeps the notes and tuning, plays on its own channel, and survives a GP export; Undo removes it.
await buildInstrumentFixture();
const exported=resolve(directory,'gp8-duplicate-track.gp');rmSync(exported,{force:true});
const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT:exported});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const tracks=async()=>{await revealDock(page,'Mixer');return page.getByRole('button',{name:/^Track \d+: /}).evaluateAll(nodes=>nodes.map(node=>(node.getAttribute('aria-label')??node.textContent??'').trim()));};
  await button('Open');await button('Track 2: Bass6');
  await page.locator('.track-settings').getByRole('button',{name:'Duplicate track',exact:true}).click();await waitForWorkspaceIdle(page);
  assert.deepEqual((await readActiveDocument(page)).project.edits.at(-1),{type:'duplicateTrack',track:1});
  assert.deepEqual((await tracks()).slice(0,5),['Track 1: Guitar9','Track 2: Bass6','Track 3: Bass6','Track 4: Drums','Track 5: Keys']);
  // The copy is selected: Move track up is enabled for it and the heading names it.
  assert.equal(await page.locator('.track-settings h2').innerText(),'Bass6');
  assert.equal(await page.locator('.track-settings').getByRole('button',{name:'Move track down',exact:true}).isDisabled(),false);
  await button('Export GP');
  const exportedTracks=await page.evaluate(async bytes=>{const {importer,Settings}=await import('/alphatab/alphaTab.mjs');const score=importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),new Settings());
    const notes=track=>track.staves[0].bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(note=>`${note.string}/${note.fret}`))));
    return score.tracks.map(track=>({name:track.name,tuning:[...track.staves[0].tuning],channel:track.playbackInfo.primaryChannel,notes:notes(track)}));},[...readFileSync(exported)]);
  assert.deepEqual(exportedTracks.map(track=>track.name),['Guitar9','Bass6','Bass6','Drums','Keys']);
  assert.ok(exportedTracks[1].notes.length>0);
  assert.deepEqual(exportedTracks[2].notes,exportedTracks[1].notes);assert.deepEqual(exportedTracks[2].tuning,exportedTracks[1].tuning);
  assert.equal(new Set(exportedTracks.filter(track=>track.name!=='Drums').map(track=>track.channel)).size,4,'Every melodic track keeps its own channel.');
  await button('Undo');
  assert.deepEqual((await tracks()).slice(0,4),['Track 1: Guitar9','Track 2: Bass6','Track 3: Drums','Track 4: Keys']);
  assert.deepEqual(errors,[]);
  console.log(`duplicate track: ${exportedTracks.map(track=>`${track.name}@${track.channel}`).join(', ')}; undo removed the copy.`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
