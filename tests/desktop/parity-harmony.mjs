import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {importer,midi,Settings} from '@coderline/alphatab';
import {directory,launch,connect,stop} from './harness.mjs';

const saved=resolve(directory,'gp8-harmony.tabplayer'),exported=resolve(directory,'gp8-harmony.gp');
const label=`TabPlayer native harmony verification ${Date.now()}`,result={},created=[];
let id=launch({TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported}),browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>readActiveDocument(page);
  const library=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('harmony_library_read'));
  const baselineLibrary=await library();
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const details=name=>page.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first().evaluate(node=>{node.parentElement.open=true;});
  const fill=(name,value)=>page.getByLabel(name,{exact:true}).fill(String(value));
  const nameMode=async()=>(await page.getByRole('radiogroup',{name:'Name mode',exact:true}).getByRole('radio',{checked:true}).innerText()).toLowerCase();
  const combo=name=>page.getByRole('combobox',{name:new RegExp(`^${name}(?:\\s|$)`)});
  const chord=()=>page.getByRole('dialog',{name:'Harmony chord',exact:true});
  const openChord=async()=>{await details('Beat text & chord');await button('Edit chord diagram');await chord().getByRole('button',{name:'Generate shapes',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[role="dialog"] fieldset')?.disabled);};
  const exportPitches=async()=>{await button('Export GP');const score=importer.ScoreLoader.loadScoreFromBytes(readFileSync(exported),new Settings()),file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();return {score,pitches:file.tracks.flatMap(track=>track.events).filter(event=>event instanceof midi.NoteOnEvent).map(event=>event.noteKey)};};
  const restart=async()=>{await browser.close();browser=null;stop(id);id=launch({TABPLAYER_TEST_OPEN:saved,TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported});browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);await button('Open');};

  await openChord();await button('Generate shapes');await button('Use shape 1');
  await details('Chord library');await fill('Library label',label);const beforeLibrary=await snapshot();await button('Save to library');await page.getByRole('status').filter({hasText:'Saved to library.'}).waitFor();
  const entry=(await library()).entries.find(entry=>entry.label===label);assert.ok(entry);created.push(entry.id);assert.equal(entry.chord.nameMode,'theory');assert.equal(entry.chord.name,'C');assert.deepEqual((await snapshot()).project,beforeLibrary.project);
  await page.getByLabel('Fill empty beat with diagram notes',{exact:true}).check();await button('Apply chord');await chord().waitFor({state:'hidden'});
  let native=await snapshot();assert.equal(native.project.edits.length,1);const original=structuredClone(native.project.edits[0].chord);assert.deepEqual(original,entry.chord);
  const expected=original.frets.flatMap((fret,index)=>fret<0?[]:[[64,59,55,50,45,40][index]+fret]);assert.deepEqual([...new Set(expected.map(pitch=>pitch%12))].sort((a,b)=>a-b),[0,4,7]);
  await fill('Beat text','Native harmony text');await button('Apply beat text');await openChord();assert.equal(await page.getByLabel('Chord name',{exact:true}).inputValue(),'C');await button('Cancel');
  await details('Music selection');await button('Select bar');await combo('Transposition mode').selectOption('chromatic');await combo('Interval number').selectOption('2');await combo('Interval quality').selectOption('major');await page.getByLabel('Transpose theory chords',{exact:true}).check();
  const beforeTranspose=await snapshot();await button('Transpose harmony');native=await snapshot();assert.equal(native.project.edits.length,beforeTranspose.project.edits.length+1);assert.equal(native.project.edits.at(-1).type,'transposeHarmony');
  await openChord();assert.equal(await page.getByLabel('Chord name',{exact:true}).inputValue(),'D');await details('Shape and display');for(let index=0;index<6;index++)assert.equal(await page.getByLabel(`String ${index+1} fret`,{exact:true}).inputValue(),String(original.frets[index]<0?-1:original.frets[index]+2));await page.screenshot({path:resolve('.analysis/parity/native-harmony-chord.png')});await button('Cancel');
  await button('Undo');await openChord();assert.equal(await page.getByLabel('Chord name',{exact:true}).inputValue(),'C');await button('Cancel');await button('Redo');assert.deepEqual((await snapshot()).project,native.project);
  let music=await exportPitches();assert.deepEqual(music.pitches,expected.map(pitch=>pitch+2));const gpChord=music.score.tracks[0].staves[0].bars[0].voices[0].beats[0].chord;assert.equal(gpChord.name,'D');assert.deepEqual(gpChord.strings,original.frets.map(fret=>fret<0?-1:fret+2));
  result.generatedChord=true;result.atomicNamedTranspose=true;result.literalGpPitches=music.pitches;
  await button('Play');await page.waitForFunction(async()=>{const status=await window.__TAURI_INTERNALS__.invoke('audio_status');return status.playing&&status.tick>0;},undefined,{timeout:15000});await button('Stop');result.nativePlayback=true;
  await button('Browse scales');const scales=page.getByRole('dialog',{name:'Scale browser'});await combo('Scale pattern').selectOption('custom');await fill('Custom intervals','0, 2, 3, 5, 7, 8, 10');assert.match(await page.getByLabel('Scale notes',{exact:true}).innerText(),/C4.*D4.*D#4.*F4.*G4.*G#4.*A#4/);await page.screenshot({path:resolve('.analysis/parity/native-harmony-scales.png')});await button('Close scales');assert.deepEqual((await snapshot()).project,native.project);result.scaleBrowsingNoHistory=true;
  await button('Select bar');await page.getByRole('region',{name:'Score workspace'}).focus();await page.keyboard.press('Control+c');await idle();await details('Musical clipboard');await page.getByText('Complete bars inserted before measure 1',{exact:true}).waitFor();await button('Save');await button('New');await details('Musical clipboard');await button('Paste music');
  native=await snapshot();assert.equal(native.project.edits.length,1);const paste=native.project.edits[0];assert.equal(paste.type,'pasteMusic');assert.equal(paste.clip.version,2);assert.equal(paste.clip.harmony[0].chord.nameMode,'theory');assert.equal(paste.clip.harmony[0].chord.name,'D');
  await openChord();assert.equal(await nameMode(),'theory');assert.equal(await page.getByLabel('Chord name',{exact:true}).inputValue(),'D');await button('Cancel');await button('Save');const persisted=(await snapshot()).project;
  await restart();assert.deepEqual((await snapshot()).project,persisted);await details('Musical clipboard');await page.getByText('The musical clipboard is empty.',{exact:true}).waitFor();await openChord();assert.equal(await nameMode(),'theory');assert.equal(await page.getByLabel('Chord name',{exact:true}).inputValue(),'D');await button('Cancel');
  music=await exportPitches();assert.deepEqual(music.pitches,expected.map(pitch=>pitch+2));result.clipboardV2Restart=true;
  await button('New');await openChord();await details('Chord library');await combo('Personal chord').selectOption(entry.id);await button('Recall library chord');assert.equal(await page.getByLabel('Chord name',{exact:true}).inputValue(),'C');assert.equal((await snapshot()).project.edits.length,0);await page.getByLabel('Fill empty beat with diagram notes',{exact:true}).check();await button('Apply chord');assert.deepEqual((await snapshot()).project.edits[0].chord,entry.chord);result.personalLibraryAcrossNewAndProcessRestart=true;
  await openChord();await details('Chord library');await combo('Personal chord').selectOption(entry.id);await button('Delete library chord');await page.getByRole('status').filter({hasText:'Removed from library.'}).waitFor();assert.equal((await library()).entries.some(value=>value.id===entry.id),false);await button('Cancel');created.length=0;
  const finalLibrary=await library();for(const originalEntry of baselineLibrary.entries)assert.deepEqual(finalLibrary.entries.find(value=>value.id===originalEntry.id),originalEntry);assert.deepEqual(errors,[]);
  writeFileSync(resolve('.analysis/parity/native-harmony-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/native-harmony-failure.png')});throw error;}
finally{if(page)for(const entryId of created)await page.evaluate(id=>window.__TAURI_INTERNALS__.invoke('harmony_library_remove',{id}),entryId).catch(()=>{});if(browser)await browser.close();stop(id);}
