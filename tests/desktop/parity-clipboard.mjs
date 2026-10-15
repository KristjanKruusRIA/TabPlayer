import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

await buildInstrumentFixture();const sourceHash=createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
const saved=resolve(directory,'gp8-clipboard.tabplayer'),exported=resolve(directory,'gp8-clipboard.gp'),result={};
let id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported}),browser,page;
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'Open',exact:true}).waitFor();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>readActiveDocument(page);
  const idle=async()=>{await page.waitForFunction(()=>!document.querySelector('nav button')?.disabled);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await page.getByRole('button',{name,exact:true}).click();await idle();};
  const details=label=>page.locator('summary').filter({hasText:label}).first().evaluate(node=>{node.parentElement.open=true;});
  const change=(label,value)=>page.getByLabel(label,{exact:true}).fill(String(value));
  await button('Open');await button('Track 4: Keys');await details('Music selection');await button('Select bar');
  const workspace=page.getByRole('region',{name:'Score workspace'});await workspace.focus();await page.keyboard.press('Control+c');await idle();
  await details('Musical clipboard');await page.getByText('Complete bars inserted before measure 1',{exact:true}).waitFor();assert.equal((await snapshot()).project.edits.length,0);
  await button('New');await details('Musical clipboard');await page.getByText('Complete bars inserted before measure 1',{exact:true}).waitFor();
  await change('Paste repetitions',2);await page.getByLabel('Track automations',{exact:true}).uncheck();await button('Paste music');
  let native=await snapshot();assert.equal(native.project.edits.length,1);assert.equal(native.project.edits[0].type,'pasteMusic');assert.equal(native.project.edits[0].options.count,2);
  assert.ok(!native.project.edits[0].clip.scoreJson.includes('Authored instrument view fixture'));assert.ok(!native.project.edits[0].clip.scoreJson.includes('TabPlayer desktop verification'));result.crossDocumentClipboard=true;
  await button('Undo');assert.match(await page.locator('.score-tools').innerText(),/4 measures/);await button('Redo');assert.match(await page.locator('.score-tools').innerText(),/6 measures/);
  await button('Play');await page.waitForFunction(async()=>{const status=await window.__TAURI_INTERNALS__.invoke('audio_status');return status.playing;},undefined,{timeout:15000});
  const playing=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  await page.locator('.track-card').first().getByLabel('Mute',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.track-card input[type="checkbox"]').checked);await idle();
  for(const action of ['Undo','Redo','Undo']){await button(action);const status=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));assert.equal(status.generation,playing.generation);assert.equal(status.playing,true);}
  result.settingsHistoryAfterPasteKeepsAudio=true;await button('Stop');
  await button('Select bar');await workspace.focus();await page.keyboard.press('Control+x');await idle();assert.equal((await snapshot()).project.edits.at(-1).type,'eraseSelection');await button('Undo');
  await button('Save');await button('Export GP');native=await snapshot();const persisted=JSON.parse(readFileSync(saved,'utf8'));assert.equal(persisted.edits.length,1);
  const pitches=async(path=exported)=>page.evaluate(async bytes=>{const {importer,midi,Settings}=await import('/alphatab/alphaTab.mjs'),score=importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),new Settings()),file=new midi.MidiFile();new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();return file.tracks.flatMap(track=>track.events).filter(event=>event instanceof midi.NoteOnEvent).map(event=>[event.tick,event.noteKey,event.noteVelocity]);},[...readFileSync(path)]);
  const notes=await pitches();assert.deepEqual(notes.map(note=>note[1]),[60,64,67,60,64,67]);assert.deepEqual(notes.map(note=>note[0]),[0,0,0,3840,3840,3840]);result.literalMidi=notes;
  await page.locator('.inspector').evaluate(node=>{node.scrollTop=500;});await page.screenshot({path:resolve('.analysis/parity/native-clipboard.png')});
  assert.deepEqual(errors,[]);await browser.close();browser=null;stop(id);id=launch({TABPLAYER_TEST_OPEN:saved,TABPLAYER_TEST_EXPORT:exported});browser=await connect();page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'Open',exact:true}).waitFor();await button('Open');
  await details('Musical clipboard');await page.getByText('The musical clipboard is empty.',{exact:true}).waitFor();assert.deepEqual((await snapshot()).project.edits,persisted.edits);
  await button('Export GP');assert.deepEqual(await pitches(),notes);assert.equal(createHash('sha256').update(readFileSync(fixturePath)).digest('hex'),sourceHash);
  result.emptyClipboardRestartReplay=true;result.undoRedoCut=true;
  await browser.close();browser=null;stop(id);id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT:exported});browser=await connect();page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'Open',exact:true}).waitFor();await button('Open');await button('Track 4: Keys');await change('Measure',2);await page.getByRole('region',{name:'Score workspace'}).focus();await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Control+c');await idle();await details('Musical clipboard');await page.getByText('Phrase at the current beat · Measure 2, beat 2',{exact:true}).waitFor();await button('New');await change('Measure',1);await change('Beat',1);await details('Musical clipboard');await button('Paste music');await button('Export GP');const phraseNotes=await pitches();assert.deepEqual(phraseNotes.map(note=>note[1]),[62,66,69]);assert.deepEqual(phraseNotes.map(note=>note[0]),[960,960,960]);result.partialPhrasePianoToGuitar=true;
  await browser.close();browser=null;stop(id);id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT:exported});browser=await connect();page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'Open',exact:true}).waitFor();await button('Open');await details('Music selection');await button('Select bar');await page.getByRole('combobox',{name:/^Selection scope/}).selectOption('all');await button('Apply selection scope');await details('Musical clipboard');await page.getByRole('combobox',{name:/^Copy\/cut mode/}).selectOption('multiTrack');await button('Copy music');await button('Cut music');assert.equal((await snapshot()).project.edits.at(-1).type,'removeMeasures');assert.match(await page.locator('.score-tools').innerText(),/3 measures/);await button('Undo');await button('Paste music');assert.match(await page.locator('.score-tools').innerText(),/5 measures/);const pasted=(await snapshot()).project.edits.at(-1);assert.equal(pasted.type,'pasteMusic');assert.equal(pasted.options.destinations.length,4);await button('Export GP');
  const original=await pitches(fixturePath),multiNotes=await pitches();const expected=[...original.filter(note=>note[0]<3840),...original.map(([tick,...note])=>[tick+3840,...note])],sort=notes=>notes.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);assert.deepEqual(sort(multiNotes),sort(expected));result.multitrackCutPaste=true;
  await page.getByRole('combobox',{name:/^Destination track for copied track 2/}).selectOption('0');const beforeFailure=await snapshot();await page.getByRole('button',{name:'Paste music',exact:true}).click();await page.getByRole('alert').filter({hasText:'unique existing destination track'}).waitFor();assert.deepEqual((await snapshot()).project,beforeFailure.project);result.invalidMappingIsAtomic=true;
  assert.equal(createHash('sha256').update(readFileSync(fixturePath)).digest('hex'),sourceHash);result.originalSourceUnchanged=true;writeFileSync(resolve('.analysis/parity/native-clipboard-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/native-clipboard-failure.png')});throw error;}
finally{if(browser)await browser.close();stop(id);}
