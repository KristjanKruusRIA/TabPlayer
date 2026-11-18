import { readActiveDocument } from './document-context.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { directory, launch, connect, stop } from './harness.mjs';
import { closeWelcomeLibrary, clickWorkstationButton, openAddTrackDialog, revealDock, revealInspectorControl, revealInspectorTab, openProperties, closeProperties, openSection, setTrackField, runCommand, moveCursor, setFret, scoreWorkspace, paletteButton, waitForWorkspaceIdle } from './workstation-commands.mjs';

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
// The Add track dialog is modal: its fields are reached directly, not through the inspector tabs behind it.
const addDialogOpen=()=>page.getByRole('dialog',{name:'Add track',exact:true}).isVisible();
const change=async(label,value)=>{const field=page.getByLabel(label,{exact:true});if(!await addDialogOpen())await revealInspectorControl(page,field);await field.fill(String(value));};
const combo=label=>page.getByRole('combobox',{name:new RegExp(`^${label}`)});
const ctl=async name=>{const control=page.getByRole('button',{name,exact:true});await revealInspectorControl(page,control);return control;};
const read=async(box,details)=>{await openDetails(details);await revealInspectorControl(page,box);return box.inputValue();};
const choose=async(box,value)=>{if(!await addDialogOpen())await revealInspectorControl(page,box);await box.selectOption(value);};
const tick=async(box)=>{await revealInspectorControl(page,box);await box.click();await page.waitForFunction(node=>node.checked,await box.elementHandle());};
// The Track tab's tuning is a row whose button opens the Tuning dialog; the Add track dialog has its own row and the same dialog.
const trackRow=/^Edit tuning/,newRow=/^Edit new track tuning/;
const tuningDialog=()=>page.getByRole('dialog',{name:'Tuning',exact:true});
const openTuning=async row=>{const rowButton=page.getByRole('button',{name:row});if(!await addDialogOpen())await revealInspectorControl(page,rowButton);await rowButton.click();await tuningDialog().waitFor();return tuningDialog();};
const notesOf=dialogBox=>dialogBox.getByLabel('Notes, high to low',{exact:true});
const libraryPreset=async(dialogBox,id)=>{const [instrument,strings]=id.split('-');await dialogBox.getByLabel('Instrument',{exact:true}).selectOption(instrument);await dialogBox.getByLabel('Number of strings',{exact:true}).selectOption(strings);await dialogBox.getByLabel('Preset',{exact:true}).selectOption(id);};
const finish=async(dialogBox,name)=>{await dialogBox.getByRole('button',{name,exact:true}).click();await dialogBox.waitFor({state:'hidden'});await idle();};
const rowText=async row=>{const rowButton=page.getByRole('button',{name:row});if(!await addDialogOpen())await revealInspectorControl(page,rowButton);return (await rowButton.textContent()).trim();};
const presetOfTrack=async()=>{const dialogBox=await openTuning(trackRow);const value=await dialogBox.getByLabel('Preset',{exact:true}).inputValue();await dialogBox.getByRole('button',{name:'Cancel',exact:true}).click();await dialogBox.waitFor({state:'hidden'});return value;};
const trackCount=async()=>{await revealDock(page,'Mixer');return page.getByRole('button',{name:/^Track \d+: /}).count();};
try {
  await closeWelcomeLibrary(page);await idle();await button('Open');assert.equal((await snapshot()).project.base.sha256,sourceHash);
  {const row=page.getByRole('button',{name:trackRow});await revealInspectorControl(page,row);if(await row.isDisabled())throw new Error('The smoke fixture must begin with a stringed instrument.');}
  const beforeInvalidTuning=await snapshot();{const dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('64,59,55,50,45,40');await dialogBox.getByRole('button',{name:'Keep fingering',exact:true}).click();await dialogBox.getByRole('alert').filter({hasText:'Invalid tuning note'}).waitFor();assert.deepEqual(await snapshot(),beforeInvalidTuning);await dialogBox.getByRole('button',{name:'Cancel',exact:true}).click();await dialogBox.waitFor({state:'hidden'});}
  // A tuning that differs from the fixture's (a standard guitar here, so D on string 1 differs): exactly one edit, of the right type and pitches.
  {const beforeCount=(await snapshot()).project.edits.length,dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('D4 B3 G3 D3 A2 E2');await finish(dialogBox,'Keep fingering');const edits=(await snapshot()).project.edits;assert.equal(edits.length,beforeCount+1);assert.equal(edits.at(-1).type,'setTuning');assert.deepEqual(edits.at(-1).tuning,[62,59,55,50,45,40]);}

  // The Selection tab is gone: the cursor is moved in the score, rhythm and notes come from the command palette (Ctrl+Shift+P), the note, beat, bar and voice
  // panels are in the Properties dialog, the track and staff fields are in the Track tab, and beat text and the chord diagram are on the edition palette.
  if(!(await page.getByTestId('status-value').innerText()).trim())await button('Insert beat');
  await runCommand(page,'duration 8');await idle();
  await moveCursor(page,{string:2});await setFret(page,7);await idle();
  {
    const props=await openProperties(page,'note');await openSection(props,/^Notes & techniques$/);
    const palm=props.getByLabel('Palm mute',{exact:true});await palm.click();await page.waitForFunction(node=>node.checked,await palm.elementHandle());await idle();
    await props.getByRole('combobox',{name:/^Vibrato/}).selectOption('1');await idle();
    await openSection(props,/^Bend curve$/);const bend=props.getByLabel('Enable Bend',{exact:true});await bend.click();await page.waitForFunction(node=>node.checked,await bend.elementHandle());
    await props.getByLabel('Bend point 2 value',{exact:true}).fill('4');await button('Apply Bend curve');
  }
  // Track name, short name and MIDI instrument apply when left or chosen (one setTrackInfo each; there is no Apply instrument settings button).
  await setTrackField(page,'Track name','Advanced study');await idle();await setTrackField(page,'Track short name','Adv');await idle();
  {const more=page.locator('.track-info .inspector-more');if(!await more.evaluate(node=>node.open))await more.locator('summary').click();await page.getByRole('combobox',{name:/^Track MIDI instrument/}).selectOption('27');await idle();}
  // Retuning goes through the Tuning dialog (Keep fingering); the old Staff tuning field and Apply staff settings are gone.
  {const dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('E4 B3 G3 D3 A2 D2');await finish(dialogBox,'Keep fingering');}
  assert.equal((await snapshot()).project.edits.at(-1).type,'setTuning');assert.deepEqual((await snapshot()).project.edits.at(-1).tuning,[64,59,55,50,45,38]);
  {
    let props=await openProperties(page,'staff');await openSection(props,/^Staff, voices & layout$/);
    if(await props.getByRole('button',{name:'Add voice',exact:true}).isDisabled()){await closeProperties(page);await scoreWorkspace(page).focus();await page.keyboard.press('Control+4');await idle();props=await openProperties(page,'staff');await openSection(props,/^Staff, voices & layout$/);await button('Remove voice');props=await openProperties(page,'staff');await openSection(props,/^Staff, voices & layout$/);}
    await button('Add voice');
    // Ctrl+1 puts the cursor back on the first voice; the copy goes to the second.
    await scoreWorkspace(page).focus();await page.keyboard.press('Control+1');await idle();
    props=await openProperties(page,'staff');await openSection(props,/^Staff, voices & layout$/);await props.getByRole('combobox',{name:/^Copy selected voice to/}).selectOption('1');await button('Copy voice range');
  }
  // Add staff is under More in Musical notation (Track tab).
  await revealInspectorTab(page,'Track');{const more=page.locator('.track-notation-more .inspector-more');if(!await more.evaluate(node=>node.open))await more.locator('summary').click();}await button('Add staff');
  {
    const props=await openProperties(page,'bar');await openSection(props,/^Measure & notation$/);await props.getByLabel('Section label',{exact:true}).fill('Advanced verse');await button('Apply measure settings');
    const again=await openProperties(page,'bar');await openSection(again,/^Measure & notation$/);await again.getByRole('combobox',{name:/^Key signature/}).selectOption('2');await button('Apply bar notation');
  }
  // Beat text is the palette's TXT prompt; the chord diagram is the palette's Chords button, which opens the same dialog.
  {const palette=page.getByRole('complementary',{name:'Edition palette'});await palette.getByRole('button',{name:'Text',exact:true}).click();const field=palette.getByRole('textbox',{name:'Text'});await field.fill('Advanced editor smoke');await field.press('Enter');await idle();}
  await page.getByRole('complementary',{name:'Edition palette'}).getByRole('button',{name:'Chords',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role="dialog"] fieldset')?.getAttribute('aria-disabled')!=='true');await dialogChange('Chord name','D');await dialog().locator('summary').filter({hasText:'Shape and display'}).evaluate(node=>node.parentElement.open=true);await dialogChange('String 1 fret',2);await dialogChange('String 2 fret',3);await dialogChange('String 3 fret',2);await dialog().getByRole('button',{name:'Apply chord',exact:true}).click();await dialog().waitFor({state:'hidden'});await idle();
  const beforeUndo=await snapshot();await button('Undo');assert.equal((await snapshot()).project.edits.length,beforeUndo.project.edits.length-1);await button('Redo');assert.deepEqual((await snapshot()).project,beforeUndo.project);
  await openAddTrackDialog(page);await change('New track name','Preset bass six');await choose(combo('MIDI instrument'),'33');
  const beforePreset=await snapshot();{const dialogBox=await openTuning(newRow);await libraryPreset(dialogBox,'bass-6-standard-b');assert.equal(await notesOf(dialogBox).inputValue(),'C3 G2 D2 A1 E1 B0');await dialogBox.getByRole('button',{name:'Use tuning',exact:true}).click();await dialogBox.waitFor({state:'hidden'});assert.equal(await rowText(newRow),'C3 G2 D2 A1 E1 B0');}assert.deepEqual(await snapshot(),beforePreset);
  await button('Add track');const bassIndex=await trackCount();const bassLabel=`Track ${bassIndex}: Preset bass six`;await clickWorkstationButton(page,bassLabel);assert.equal(await presetOfTrack(),'bass-6-standard-b');
  const beforeBassDraft=await snapshot();{const dialogBox=await openTuning(trackRow);await libraryPreset(dialogBox,'bass-6-drop-a');assert.deepEqual(await snapshot(),beforeBassDraft);await finish(dialogBox,'Keep fingering');}assert.deepEqual((await snapshot()).project.edits.at(-1).tuning,[48,43,38,33,28,21]);
  {const dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('C3 G2 D2 A1 E1 Bb0');assert.equal(await dialogBox.getByLabel('Preset',{exact:true}).inputValue(),'custom');await finish(dialogBox,'Keep fingering');}assert.equal(await rowText(trackRow),'C3 G2 D2 A1 E1 A#0');
  const bassCustom=await snapshot();await button('Undo');assert.equal(await presetOfTrack(),'bass-6-drop-a');await button('Redo');assert.deepEqual((await snapshot()).project,bassCustom.project);assert.equal(await presetOfTrack(),'custom');
  await openAddTrackDialog(page);await change('New track name','Preset guitar nine');await choose(combo('MIDI instrument'),'25');{const dialogBox=await openTuning(newRow);await libraryPreset(dialogBox,'guitar-9-standard-csharp');assert.equal(await notesOf(dialogBox).inputValue(),'E4 B3 G3 D3 A2 E2 B1 F#1 C#1');await dialogBox.getByRole('button',{name:'Use tuning',exact:true}).click();await dialogBox.waitFor({state:'hidden'});}await button('Add track');assert.deepEqual((await snapshot()).project.edits.at(-1).tuning,[64,59,55,50,45,40,35,30,25]);
  const guitarIndex=await trackCount(),guitarLabel=`Track ${guitarIndex}: Preset guitar nine`;await clickWorkstationButton(page,guitarLabel);assert.equal(await presetOfTrack(),'guitar-9-standard-csharp');
  // A preset chosen in the Tuning dialog is a draft until Keep fingering.
  const beforeStaffDraft=await snapshot();{const dialogBox=await openTuning(trackRow);await libraryPreset(dialogBox,'guitar-9-drop-b');assert.deepEqual(await snapshot(),beforeStaffDraft);await finish(dialogBox,'Keep fingering');}assert.deepEqual((await snapshot()).project.edits.at(-1).tuning,[64,59,55,50,45,40,35,30,23]);await button('Undo');assert.equal(await presetOfTrack(),'guitar-9-standard-csharp');await button('Redo');assert.equal(await presetOfTrack(),'guitar-9-drop-b');
  {const dialogBox=await openTuning(trackRow);await notesOf(dialogBox).fill('E4 B3 G3 D3 A2 E2 B1 F#1 D1');assert.equal(await dialogBox.getByLabel('Preset',{exact:true}).inputValue(),'custom');await finish(dialogBox,'Keep fingering');}assert.deepEqual((await snapshot()).project.edits.at(-1).tuning,[64,59,55,50,45,40,35,30,26]);assert.equal(await presetOfTrack(),'custom');
  await button('Save');const before=await snapshot();assert.equal(before.dirty,false);
  await page.screenshot({path:resolve(directory,'advanced-editor.png')});
  await browser.close();stop(id);id=launch({TABPLAYER_TEST_OPEN:saved});browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await idle();await button('Open');
  assert.deepEqual((await snapshot()).project,before.project);assert.equal((await snapshot()).project.base.bytesBase64,bytes.toString('base64'));assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),sourceHash);
  assert.equal(await rowText(trackRow),'E4 B3 G3 D3 A2 D2');
  await clickWorkstationButton(page,bassLabel);assert.equal(await rowText(trackRow),'C3 G2 D2 A1 E1 A#0');assert.equal(await presetOfTrack(),'custom');await clickWorkstationButton(page,guitarLabel);assert.equal(await rowText(trackRow),'E4 B3 G3 D3 A2 E2 B1 F#1 D1');
  assert.equal(await presetOfTrack(),'custom');
  const types=new Set(before.project.edits.map(e=>e.type));for(const type of ['setBeatRhythm','setNoteTechniques','setTrackInfo','addVoice','copyVoice','addStaff','setMeasureSettings','setBarNotation','setBeatText','setHarmonyChord'])assert(types.has(type),`Missing ${type}`);
  writeFileSync(resolve(directory,'advanced-editor-result.json'),JSON.stringify({sourceHash,sourcePreserved:true,nativeRestartReopen:true,tuningPresets:{bass6:true,guitar9:true,custom:true,historyRoundtrip:true},editCount:before.project.edits.length,commandTypes:[...types],saved},null,2));
  console.log('Advanced native editor: curves, articulation, imported program, voice copy, staff, measure, key, chord, bass6/guitar9 tuning presets and custom notes, undo/redo and save/restart/reopen passed.');
} finally {await browser.close();try{stop(id);}catch{}}
