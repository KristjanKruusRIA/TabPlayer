// Cut of a range that ends inside a held note (THE-66, E02/E08).
// Blank score, bar 1 made [half note, quarter, quarter]; the range is made with the keyboard, its end moved into the half note with Alt+Shift+Comma,
// then Cut, Undo, Paste, and a restart replay of the saved project.
// The keys only make ranges whose END is inside a note, so this covers that case. A start edge inside a note, a middle cut, tuplets, ties,
// grace notes, several voices and the refusals are covered by unit tests only (src/editor/cut-sustained.test.ts).
import {waitForWorkspaceIdle,closeWelcomeLibrary,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';

const saved=resolve(directory,'gp8-cut-sustained.tabplayer'),exported=resolve(directory,'gp8-cut-sustained.gp'),result={};
let id=launch({TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported}),browser,page;
const attach=async()=>{browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);};
try{
  await attach();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>readActiveDocument(page);
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  // [start tick, end tick, key] of every note, so a wrong length shows, not only a wrong start.
  const noteOns=async()=>page.evaluate(async bytes=>{const {importer,midi,Settings}=await import('/alphatab/alphaTab.mjs'),score=importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),new Settings()),file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();const events=file.tracks.flatMap(track=>track.events),open=new Map(),notes=[];for(const event of events.slice().sort((a,b)=>a.tick-b.tick)){if(event instanceof midi.NoteOnEvent&&event.noteVelocity>0){const list=open.get(event.noteKey)??[];list.push(event.tick);open.set(event.noteKey,list);}else if(event instanceof midi.NoteOffEvent){const start=open.get(event.noteKey)?.shift();if(start!==undefined)notes.push([start,event.tick,event.noteKey]);}}return notes.sort((a,b)=>a[0]-b[0]||a[2]-b[2]);},[...readFileSync(exported)]);
  await button('New');
  const workspace=page.getByRole('region',{name:'Score workspace'});await workspace.focus();
  // Bar 1 = [half note, quarter, quarter]: a note on beat 1, beat 2 deleted, beat 1 made a half note.
  await page.getByLabel('Fret',{exact:true}).fill('5');await button('Set note');
  await workspace.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Shift+Delete');await idle();await page.keyboard.press('ArrowLeft');
  await page.locator('label').filter({hasText:/^Duration/}).locator('select').selectOption('2');await button('Apply rhythm');
  const base=(await snapshot()).project.edits.length;
  // Range over beats 1 and 2 (Shift+Right), then the end back by the entry duration twice: it now ends 960 ticks into the half note, between two beats' worth of its length.
  await workspace.focus();await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Alt+Shift+Comma');await page.keyboard.press('Alt+Shift+Comma');
  await page.getByText(/Range selection · from measure 1, beat 1 to measure 1, beat 2/).waitFor();
  await page.screenshot({path:resolve('.analysis/parity/native-cut-sustained-band.png')});
  assert.equal((await snapshot()).project.edits.length,base,'moving the range end records nothing');result.rangeEndInsideNote=true;
  await page.keyboard.press('Control+c');await idle();assert.equal((await snapshot()).project.edits.length,base,'Copy records nothing');
  await page.keyboard.press('Control+x');await idle();
  const cut=(await snapshot()).project.edits;assert.equal(cut.length,base+1,'Cut is one edit');assert.equal(cut.at(-1).type,'cutSelection');
  assert.deepEqual(cut.at(-1).selection.range.end,{bar:0,tick:960});result.cutIsOneCutSelection=true;
  await button('Export GP');const afterCut=await noteOns();assert.equal(afterCut.length,1);assert.deepEqual(afterCut[0].slice(0,2),[960,1920],'the cut took the first 960 ticks of the half note and left the tail, starting at 960');result.score=afterCut;
  await button('Undo');assert.equal((await snapshot()).project.edits.length,base);await button('Export GP');const original=await noteOns();assert.equal(original.length,1);assert.deepEqual(original[0].slice(0,2),[0,1920],'undo gives the whole half note back');result.undoRestores=true;
  await button('Redo');await button('Save');
  // Paste the cut time back at beat 2 of the shortened note's rest: the clip is the copy of the same range.
  await workspace.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Control+v');await idle();
  assert.equal((await snapshot()).project.edits.at(-1).type,'pasteMusic');result.pasteAfterCut=true;
  await button('Undo');
  assert.deepEqual(errors,[]);await browser.close();browser=null;stop(id);
  // Restart: the saved project (with the cutSelection in its log) replays to the same music.
  id=launch({TABPLAYER_TEST_OPEN:saved,TABPLAYER_TEST_EXPORT:exported});await attach();await button('Open');
  assert.equal((await snapshot()).project.edits.at(-1).type,'cutSelection');await button('Export GP');assert.deepEqual(await noteOns(),afterCut);result.restartReplay=true;
  writeFileSync(resolve('.analysis/parity/native-cut-sustained-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/native-cut-sustained-failure.png')});throw error;}
finally{if(browser)await browser.close();stop(id);}
