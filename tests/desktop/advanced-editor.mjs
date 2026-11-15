import { readActiveDocument } from './document-context.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { directory, launch, connect, stop } from './harness.mjs';
import { closeWelcomeLibrary, clickWorkstationButton, revealDock, revealInspectorControl, waitForWorkspaceIdle } from './workstation-commands.mjs';

const source=process.env.TABPLAYER_TEST_GP;
if(!source)throw new Error('Set TABPLAYER_TEST_GP to an authorized private score.');
const bytes=readFileSync(source),sourceHash=createHash('sha256').update(bytes).digest('hex'),saved=resolve(directory,`advanced-${Date.now()}.tabplayer`);
let id=launch({TABPLAYER_TEST_OPEN:source,TABPLAYER_TEST_SAVE:saved}),browser=await connect(),page=browser.contexts()[0].pages()[0];
const snapshot=()=>readActiveDocument(page);
const idle=async()=>{await waitForWorkspaceIdle(page);const error=page.getByRole('alert');if(await error.count())throw new Error(await error.textContent());};
const button=async(name,options)=>{await clickWorkstationButton(page,name,options);if(options?.waitForIdle===false)return;await idle();};
const dialog=()=>page.getByRole('dialog');
const dialogChange=async(label,value)=>dialog().getByLabel(label,{exact:true}).fill(String(value));
const openDetails=async text=>{const summary=page.locator('summary').filter({hasText:text}).first();await revealInspectorControl(page,summary);await summary.evaluate(node=>node.parentElement.open=true);};
const change=async(label,value)=>{const field=page.getByLabel(label,{exact:true});await revealInspectorControl(page,field);await field.fill(String(value));};
const combo=label=>page.getByRole('combobox',{name:new RegExp(`^${label}`)});
const ctl=async name=>{const control=page.getByRole('button',{name,exact:true});await revealInspectorControl(page,control);return control;};
const read=async(box,details)=>{await openDetails(details);await revealInspectorControl(page,box);return box.inputValue();};
const choose=async(box,value)=>{await revealInspectorControl(page,box);await box.selectOption(value);};
const tick=async(box)=>{await revealInspectorControl(page,box);await box.click();await page.waitForFunction(node=>node.checked,await box.elementHandle());};
// The Track tab's tuning is a row whose button opens the Tuning dialog; Add instrument has its own row and the same dialog.
const trackRow=/^Edit tuning/,newRow=/^Edit new track tuning/;
const tuningDialog=()=>page.getByRole('dialog',{name:'Tuning',exact:true});
const openTuning=async row=>{const rowButton=page.getByRole('button',{name:row});await revealInspectorControl(page,rowButton);await rowButton.click();await tuningDialog().waitFor();return tuningDialog();};
const notesOf=dialogBox=>dialogBox.getByLabel('Notes, high to low',{exact:true});
const libraryPreset=async(dialogBox,id)=>{const [instrument,strings]=id.split('-');await dialogBox.getByLabel('Instrument',{exact:true}).selectOption(instrument);await dialogBox.getByLabel('Number of strings',{exact:true}).selectOption(strings);await dialogBox.getByLabel('Preset',{exact:true}).selectOption(id);};
const finish=async(dialogBox,name)=>{await dialogBox.getByRole('button',{name,exact:true}).click();await dialogBox.waitFor({state:'hidden'});await idle();};
const rowText=async row=>{const rowButton=page.getByRole('button',{name:row});await revealInspectorControl(page,rowButton);return (await rowButton.textContent()).trim();};
const presetOfTrack=async()=>{const dialogBox=await openTuning(trackRow);const value=await dialogBox.getByLabel('Preset',{exact:true}).inputValue();await dialogBox.getByRole('button',{name:'Cancel',exact:true}).click();await dialogBox.waitFor({state:'hidden'});return value;};
const trackCount=async()=>{await revealDock(page,'Mixer');return page.getByRole('button',{name:/^Track \d+: /}).count();};
try {
  await closeWelcomeLibrary(page);await idle();await button('Open');assert.equal((await snapshot()).project.base.sha256,sourceHash);
  {const row=page.getByRole('button',{name:trackRow});await revealInspectorControl(page,row);if(await row.isDisabled())throw new Error('The smoke fixture must begin with a stringed instrument.');}
  const beforeInvalidTuning=await snapshot();{const dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('64,59,55,50,45,40');await dialogBox.getByRole('button',{name:'Keep fingering',exact:true}).click();await dialogBox.getByRole('alert').filter({hasText:'Invalid tuning note'}).waitFor();assert.deepEqual(await snapshot(),beforeInvalidTuning);await dialogBox.getByRole('button',{name:'Cancel',exact:true}).click();await dialogBox.waitFor({state:'hidden'});}
  // A tuning that differs from the fixture's (a standard guitar here, so D on string 1 differs): exactly one edit, of the right type and pitches.
  {const beforeCount=(await snapshot()).project.edits.length,dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('D4 B3 G3 D3 A2 E2');await finish(dialogBox,'Keep fingering');const edits=(await snapshot()).project.edits;assert.equal(edits.length,beforeCount+1);assert.equal(edits.at(-1).type,'setTuning');assert.deepEqual(edits.at(-1).tuning,[62,59,55,50,45,40]);}

  if(await (await ctl('Apply rhythm')).isDisabled())await button('Insert beat');
  await choose(page.getByRole('combobox',{name:/^Duration/}),'8');await button('Apply rhythm');
  await choose(page.getByRole('combobox',{name:/^String/}),'2');await change('Fret',7);await button('Set note');
  await openDetails('Notes & techniques');await tick(page.getByLabel('Palm mute',{exact:true}));await idle();
  await choose(page.getByRole('combobox',{name:/^Vibrato/}),'1');await idle();
  await openDetails('Bend curve');await tick(page.getByLabel('Enable Bend',{exact:true}));await change('Bend point 2 value',4);await button('Apply Bend curve');
  await openDetails('Selected instrument');await change('Track name','Advanced study');await change('Track short name','Adv');await choose(page.getByRole('combobox',{name:/^Track MIDI instrument/}),'27');await button('Apply instrument settings');
  await openDetails('Staff, voices & layout');await change('Staff tuning (notes, high to low)','E4 B3 G3 D3 A2 D2');await button('Apply staff settings');assert.deepEqual((await snapshot()).project.edits.at(-1).settings.tuning,[64,59,55,50,45,38]);if(await (await ctl('Add voice')).isDisabled()){await choose(page.getByRole('combobox',{name:/^Voice/}),'3');await button('Remove voice');}await button('Add voice');await choose(page.getByRole('combobox',{name:/^Voice/}),'0');await choose(page.getByRole('combobox',{name:/^Copy selected voice to/}),'1');await button('Copy voice range');await button('Add staff');await choose(page.locator('.workstation-inspector').getByRole('combobox',{name:/^Staff(?! tuning| clef)/}).first(),'0');
  await openDetails('Measure & notation');await change('Section label','Advanced verse');await button('Apply measure settings');await choose(page.getByRole('combobox',{name:/^Key signature/}),'2');await button('Apply bar notation');
  await openDetails('Beat text');await change('Beat text','Advanced editor smoke');await button('Apply beat text');await button('Edit chord diagram',{waitForIdle:false});await page.waitForFunction(()=>document.querySelector('[role="dialog"] fieldset')?.getAttribute('aria-disabled')!=='true');await dialogChange('Chord name','D');await dialog().locator('summary').filter({hasText:'Shape and display'}).evaluate(node=>node.parentElement.open=true);await dialogChange('String 1 fret',2);await dialogChange('String 2 fret',3);await dialogChange('String 3 fret',2);await dialog().getByRole('button',{name:'Apply chord',exact:true}).click();await dialog().waitFor({state:'hidden'});await idle();
  const beforeUndo=await snapshot();await button('Undo');assert.equal((await snapshot()).project.edits.length,beforeUndo.project.edits.length-1);await button('Redo');assert.deepEqual((await snapshot()).project,beforeUndo.project);
  await openDetails('Add instrument');await change('New track name','Preset bass six');await choose(combo('MIDI instrument'),'33');
  const beforePreset=await snapshot();{const dialogBox=await openTuning(newRow);await libraryPreset(dialogBox,'bass-6-standard-b');assert.equal(await notesOf(dialogBox).inputValue(),'C3 G2 D2 A1 E1 B0');await dialogBox.getByRole('button',{name:'Use tuning',exact:true}).click();await dialogBox.waitFor({state:'hidden'});assert.equal(await rowText(newRow),'C3 G2 D2 A1 E1 B0');}assert.deepEqual(await snapshot(),beforePreset);
  await button('Add track');const bassIndex=await trackCount();const bassLabel=`Track ${bassIndex}: Preset bass six`;await clickWorkstationButton(page,bassLabel);assert.equal(await presetOfTrack(),'bass-6-standard-b');
  const beforeBassDraft=await snapshot();{const dialogBox=await openTuning(trackRow);await libraryPreset(dialogBox,'bass-6-drop-a');assert.deepEqual(await snapshot(),beforeBassDraft);await finish(dialogBox,'Keep fingering');}assert.deepEqual((await snapshot()).project.edits.at(-1).tuning,[48,43,38,33,28,21]);
  {const dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('C3 G2 D2 A1 E1 Bb0');assert.equal(await dialogBox.getByLabel('Preset',{exact:true}).inputValue(),'custom');await finish(dialogBox,'Keep fingering');}assert.equal(await rowText(trackRow),'C3 G2 D2 A1 E1 A#0');
  const bassCustom=await snapshot();await button('Undo');assert.equal(await presetOfTrack(),'bass-6-drop-a');await button('Redo');assert.deepEqual((await snapshot()).project,bassCustom.project);assert.equal(await presetOfTrack(),'custom');
  await change('New track name','Preset guitar nine');await choose(combo('MIDI instrument'),'25');{const dialogBox=await openTuning(newRow);await libraryPreset(dialogBox,'guitar-9-standard-csharp');assert.equal(await notesOf(dialogBox).inputValue(),'E4 B3 G3 D3 A2 E2 B1 F#1 C#1');await dialogBox.getByRole('button',{name:'Use tuning',exact:true}).click();await dialogBox.waitFor({state:'hidden'});}await button('Add track');assert.deepEqual((await snapshot()).project.edits.at(-1).tuning,[64,59,55,50,45,40,35,30,25]);
  const guitarIndex=await trackCount(),guitarLabel=`Track ${guitarIndex}: Preset guitar nine`;await clickWorkstationButton(page,guitarLabel);assert.equal(await presetOfTrack(),'guitar-9-standard-csharp');await openDetails('Staff, voices & layout');
  const beforeStaffDraft=await snapshot();await choose(combo('Staff tuning preset'),'guitar-9-drop-b');assert.deepEqual(await snapshot(),beforeStaffDraft);await button('Apply staff settings');assert.deepEqual((await snapshot()).project.edits.at(-1).settings.tuning,[64,59,55,50,45,40,35,30,23]);await button('Undo');assert.equal(await read(combo('Staff tuning preset'),'Staff, voices & layout'),'guitar-9-standard-csharp');await button('Redo');assert.equal(await presetOfTrack(),'guitar-9-drop-b');
  {const dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('E4 B3 G3 D3 A2 E2 B1 F#1 D1');assert.equal(await dialogBox.getByLabel('Preset',{exact:true}).inputValue(),'custom');await finish(dialogBox,'Keep fingering');}assert.deepEqual((await snapshot()).project.edits.at(-1).tuning,[64,59,55,50,45,40,35,30,26]);assert.equal(await read(combo('Staff tuning preset'),'Staff, voices & layout'),'custom');
  await button('Save');const before=await snapshot();assert.equal(before.dirty,false);
  await page.screenshot({path:resolve(directory,'advanced-editor.png')});
  await browser.close();stop(id);id=launch({TABPLAYER_TEST_OPEN:saved});browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await idle();await button('Open');
  assert.deepEqual((await snapshot()).project,before.project);assert.equal((await snapshot()).project.base.bytesBase64,bytes.toString('base64'));assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),sourceHash);
  assert.equal(await rowText(trackRow),'E4 B3 G3 D3 A2 D2');
  await clickWorkstationButton(page,bassLabel);assert.equal(await rowText(trackRow),'C3 G2 D2 A1 E1 A#0');assert.equal(await presetOfTrack(),'custom');await clickWorkstationButton(page,guitarLabel);assert.equal(await rowText(trackRow),'E4 B3 G3 D3 A2 E2 B1 F#1 D1');
  await openDetails('Staff, voices & layout');assert.equal(await read(combo('Staff tuning preset'),'Staff, voices & layout'),'custom');
  const types=new Set(before.project.edits.map(e=>e.type));for(const type of ['setBeatRhythm','setNoteTechniques','setTrackInfo','addVoice','copyVoice','addStaff','setMeasureSettings','setBarNotation','setBeatText','setHarmonyChord'])assert(types.has(type),`Missing ${type}`);
  writeFileSync(resolve(directory,'advanced-editor-result.json'),JSON.stringify({sourceHash,sourcePreserved:true,nativeRestartReopen:true,tuningPresets:{bass6:true,guitar9:true,custom:true,historyRoundtrip:true},editCount:before.project.edits.length,commandTypes:[...types],saved},null,2));
  console.log('Advanced native editor: curves, articulation, imported program, voice copy, staff, measure, key, chord, bass6/guitar9 tuning presets and custom notes, undo/redo and save/restart/reopen passed.');
} finally {await browser.close();try{stop(id);}catch{}}
