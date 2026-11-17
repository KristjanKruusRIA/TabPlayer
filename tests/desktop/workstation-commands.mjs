// Document-operation idle is independent of native audio preparation/readiness.
/** @param {import('playwright').Page} page */
export function waitForWorkspaceIdle(page,options={}) {
  return page.locator('.app-shell[aria-busy="false"]').waitFor({state:'visible',...options});
}

/** A fresh session opens the Library with a welcome. It is modal, so nothing behind it takes a click until it is closed.
 * This waits for the welcome itself, so a launch that should show it and does not still fails. */
export async function closeWelcomeLibrary(page) {
  const library=page.getByRole('dialog',{name:'Library',exact:true});
  await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();
  await library.getByRole('button',{name:'Close',exact:true}).click();
  await library.waitFor({state:'hidden'});
}

const fileCommands=new Set(['New','Open','Save','Save As','Close score','Close all scores','Export score','Export GP','Import ASCII tab…','Import MIDI…','Batch convert…','Finalize document','Unfinalize document']);
const summary=(page,name)=>page.locator('summary').filter({hasText:name});
async function openDisclosure(locator) {
  if(!await locator.evaluate(node=>node.parentElement.open))await locator.click();
}

/** The modal dialogs the inspector's controls open (Properties, Score style, Sound and pedalboard, Sound mastering). Each makes the rest of the app inert while it is open. */
const inspectorDialogs=page=>[page.getByRole('dialog',{name:'Properties',exact:true}),page.getByRole('dialog',{name:'Add track',exact:true}),page.locator('.score-style-dialog'),page.locator('.sound-dialog'),page.locator('.master-dialog')];
async function dismiss(page,dialog) {
  if(await dialog.isVisible()){await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});}
}
/** Closes every open inspector dialog (they cover the rest of the app); each is dismissed with Escape, which records nothing. */
export async function closeInspectorDialogs(page) {
  for(const dialog of inspectorDialogs(page))await dismiss(page,dialog);
}

/** Reveal without waiting on an operation: native picker callers must answer it first. */
export async function revealWorkspaceCommand(page,name) {
  if(!fileCommands.has(name))throw new Error(`Unknown workspace command: ${name}`);
  await closeInspectorDialogs(page);
  const command=page.getByRole('button',{name,exact:true});
  if(!await command.isVisible())await openDisclosure(summary(page,/^File$/));
  await command.waitFor({state:'visible'});
  return command;
}

export async function clickWorkspaceCommand(page,name,{waitForIdle=true}={}) {
  await (await revealWorkspaceCommand(page,name)).click();
  if(waitForIdle)await waitForWorkspaceIdle(page);
}

async function showPane(page,name) {
  const view=summary(page,/^View$/);
  await openDisclosure(view);
  await page.getByRole('checkbox',{name,exact:true}).setChecked(true);
  await view.click();
}

/** Opens an inspector tab: Song (score information, style and mastering) or Track (track, notation, sound and interpretation).
 * The Selection tab is gone: its controls live in the palette, the status bar, the menus and the Properties dialog (see openProperties). */
export async function revealInspectorTab(page,tab) {
  if(!['Song','Track'].includes(tab))throw new Error(`Unknown inspector tab: ${tab}. The Selection tab is gone; use openProperties(page,tab).`);
  await closeInspectorDialogs(page);
  await revealInspector(page);
  const button=page.getByRole('tablist',{name:'Inspector',exact:true}).getByRole('tab',{name:tab,exact:true});
  if(await button.getAttribute('aria-selected')!=='true')await button.click();
}

const propertiesTabs={note:'Note',beat:'Beat',bar:'Bar',selection:'Selection',staff:'Staff and voices',entry:'Pitch entry',score:'Score'};
/** Opens the Properties dialog (the Note menu's Note properties) on a tab and returns the dialog locator.
 * @param {'note'|'beat'|'bar'|'selection'|'staff'|'entry'|'score'} tab */
export async function openProperties(page,tab='note') {
  if(!propertiesTabs[tab])throw new Error(`Unknown Properties tab: ${tab}`);
  const dialog=page.getByRole('dialog',{name:'Properties',exact:true});
  if(!await dialog.isVisible()) {
    await closeInspectorDialogs(page);
    await openDisclosure(summary(page,/^Note$/));
    await page.getByRole('button',{name:'Note properties…',exact:true}).click();
    await dialog.waitFor({state:'visible'});
  }
  const button=dialog.getByRole('tab',{name:propertiesTabs[tab],exact:true});
  if(await button.getAttribute('aria-selected')!=='true')await button.click();
  return dialog;
}
/** Opens the Properties dialog on whichever tab holds the disclosure whose summary matches `text` (a string is a substring, a RegExp is tested), opens it (and the ones around it) and returns the dialog.
 * What the Selection tab showed as 'Music selection', 'Musical clipboard', 'Measure & notation', 'Directions', 'Beat text'... is found this way without knowing the tab.
 * Buttons in the dialog close it again when clicked through clickWorkstationButton, so call this again before the next control that lives in a disclosure. */
export async function propertiesSection(page,text) {
  for(const tab of Object.keys(propertiesTabs)) {
    const dialog=await openProperties(page,tab);
    const summaryNode=dialog.locator('summary').filter({hasText:text}).first();
    if(await summaryNode.count()&&await summaryNode.isVisible()) {
      await summaryNode.evaluate(node=>{for(let item=node.parentElement;item;item=item.parentElement)if(item.tagName==='DETAILS')item.open=true;});
      return dialog;
    }
  }
  await closeProperties(page);
  throw new Error(`No Properties tab has a section matching ${text}`);
}
/** The text of the Properties dialog's Selection tab (the Music selection summary: 'N notes · M beats', 'Measures 1–4 · Tracks 1', the clipboard); the dialog is closed again. */
export async function selectionText(page) {
  const dialog=await openProperties(page,'selection');
  const text=await dialog.innerText();
  await closeProperties(page);
  return text;
}
/** Closes the Properties dialog if it is open. */
export async function closeProperties(page) {
  const dialog=page.getByRole('dialog',{name:'Properties',exact:true});
  if(await dialog.isVisible()){await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});}
}

/** The former left-pane tasks: Track and Sound live in the inspector's Track tab, Backing in the global view's Backing tab.
 * @param {'Track'|'Sound'|'Backing'} task */
export async function revealLeftTask(page,task) {
  if(!['Track','Sound','Backing'].includes(task))throw new Error(`Unknown left task: ${task}`);
  await closeInspectorDialogs(page);
  if(task==='Backing') {
    const nav=page.getByRole('navigation',{name:'Dock views',exact:true});
    if(!await nav.isVisible())await showPane(page,'Bottom dock');
    const button=nav.getByRole('button',{name:'Backing',exact:true});
    if(await button.getAttribute('aria-pressed')!=='true')await button.click();
    const expand=page.getByRole('button',{name:'Expand bottom dock',exact:true});
    if(await expand.isVisible())await expand.click();
    return;
  }
  await revealInspectorTab(page,'Track');
}

export async function revealInspector(page) {
  if(await page.locator('.workstation-inspector').isVisible())return;
  await showPane(page,'Inspector');
  await page.locator('.workstation-inspector').waitFor({state:'visible'});
}

/** The inspector's tabs share one panel, so a control is only visible on its own tab. This opens the first tab (or Properties dialog tab)
 * in which `locator` is visible and returns it; a driver that does not know where a control lives can call it before acting. Close the dialog afterwards (closeProperties). */
export async function revealInspectorControl(page,locator) {
  await revealInspector(page);
  for(const tab of ['Track','Song']) {
    await revealInspectorTab(page,tab);
    if(await locator.first().isVisible())return locator;
  }
  for(const tab of Object.keys(propertiesTabs)) {
    await openProperties(page,tab);
    if(await locator.first().isVisible())return locator;
  }
  await closeProperties(page);
  throw new Error(`Control is not visible on any inspector tab or Properties tab: ${locator}`);
}

/** Opens a disclosure (a <details> summary) inside `root` whose text matches, leaving it open. */
export async function openSection(root,text) {
  const summaryNode=root.locator('summary').filter({hasText:text}).first();
  if(!await summaryNode.evaluate(node=>node.parentElement.open))await summaryNode.click();
  return summaryNode;
}

// ---- The edit controls the Selection tab used to hold now live in the score itself (keys), the command palette and the status bar. ----
export const scoreWorkspace=page=>page.getByRole('region',{name:'Score workspace',exact:true});
/** The cursor reading in the status bar: 'Bar 1 · Beat 1 · String 6 · Voice 1'. */
export async function cursorPosition(page) {
  const text=await page.locator('.statusbar-position').first().textContent();
  const number=name=>Number(new RegExp(`${name} (\\d+)`).exec(text)?.[1]);
  return {text,bar:number('Bar'),beat:number('Beat'),string:number('String'),voice:number('Voice')};
}
/** Runs a command palette command (Ctrl+Shift+P, type, Enter): 'fret 7', 'duration 8', 'measure 3', 'tempo 96', 'insert beat', 'delete beat', 'make rest', 'append measure', 'remove measure'.
 * Waits for the palette to close and the document to be idle. */
export async function runCommand(page,text) {
  await closeInspectorDialogs(page);
  await scoreWorkspace(page).focus();await page.keyboard.press('Control+Shift+P');
  const palette=page.getByRole('dialog',{name:'Commands',exact:true}),field=palette.getByRole('combobox',{name:'Command'});
  await field.waitFor();await field.fill(text);await page.keyboard.press('Enter');
  // A command the palette refuses (a bad argument, no beat under the cursor) leaves it open with the reason; say so instead of timing out.
  try{await palette.waitFor({state:'detached',timeout:8000});}catch(error){throw new Error(`The command palette stayed open after '${text}': ${(await palette.innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,300)}`,{cause:error});}
  await waitForWorkspaceIdle(page);
}
/** The cursor goes to a measure (palette 'measure N'), a string (ArrowUp raises the string number) and a beat (1-based, ArrowRight/Left) in the score. */
export async function moveCursor(page,{bar,string,beat,voice}={}) {
  if(bar!==undefined&&(await cursorPosition(page)).bar!==bar)await runCommand(page,`measure ${bar}`);
  await scoreWorkspace(page).focus();
  // Ctrl+1..4 moves to that voice when it exists (asking for the next one that does not exist adds it, which is an edit, so only existing voices are asked for).
  if(voice!==undefined&&(await cursorPosition(page)).voice!==voice){await page.keyboard.press(`Control+${voice}`);await page.waitForTimeout(150);}
  if(beat!==undefined){
    for(let guard=0;guard<64;guard++){const now=(await cursorPosition(page)).beat;if(now===beat)break;await page.keyboard.press(now<beat?'ArrowRight':'ArrowLeft');await page.waitForTimeout(60);}
  }
  if(string!==undefined){
    for(let guard=0;guard<16;guard++){const now=(await cursorPosition(page)).string;if(now===string)break;await page.keyboard.press(now<string?'ArrowUp':'ArrowDown');await page.waitForTimeout(60);}
  }
  const now=await cursorPosition(page);
  for(const [key,value] of Object.entries({bar,string,beat,voice}))if(value!==undefined&&now[key]!==value)throw new Error(`Cursor is at ${now.text}; wanted ${key} ${value}`);
  return now;
}
/** What the Selection tab's string selector, Fret field and Set note button did: the cursor goes to `string` and the palette's 'fret N' writes the fret (one setNote). */
export async function writeNote(page,string,fret) {
  if(string!==undefined)await moveCursor(page,{string});
  await setFret(page,fret);
}
/** Writes a fret on the cursor string with the palette's 'fret N' (one plain setNote edit). */
export const setFret=(page,fret)=>runCommand(page,`fret ${fret}`);
/** Writes a fret by typing its digits in the score (the app joins digits typed within a second; auto duration may make the edit a sequence). */
export async function typeFret(page,fret) {
  await scoreWorkspace(page).focus();
  for(const digit of String(fret)){await page.keyboard.press(digit);await page.waitForTimeout(100);}
  await waitForWorkspaceIdle(page);
}
/** The edition palette (the complementary region beside the score). */
export const editionPalette=page=>page.getByRole('complementary',{name:'Edition palette'});
/** Beat text is the palette's Text button: it opens a field, Enter records one setBeatText (nothing is recorded when the text is unchanged). */
export async function setBeatText(page,text) {
  const palette=editionPalette(page);await palette.getByRole('button',{name:'Text',exact:true}).click();
  const field=palette.getByRole('textbox',{name:'Text'});await field.fill(text);await field.press('Enter');await waitForWorkspaceIdle(page);
}
/** The edition palette button (role toolbar 'Editing toolbar'). */
export const paletteButton=(page,id)=>page.locator(`[data-palette-id="${id}"]`);

const styleGroups={style:'Engraving and fonts',layout:'Spacing and grouping',page:'Page and view'};
/** Opens the 'Score style…' dialog from the Song tab (engraving, typography, stylesheet and saved styles in 'style'; bar widths, system gaps and staff groups in 'layout'; page layout and default view in 'page')
 * and returns it. The dialog is modal, but playback goes on behind it; call closeScoreStyle before touching anything else. Closing it records nothing. Its disclosures start closed each time it opens.
 * @param {'style'|'layout'|'page'} group */
export async function openScoreStyle(page,group='style') {
  const dialog=page.locator('.score-style-dialog');
  if(!await dialog.isVisible()) {
    await revealInspectorTab(page,'Song');
    await page.getByRole('button',{name:'Score style…',exact:true}).click();
    await dialog.waitFor({state:'visible'});
  }
  const tab=dialog.getByRole('tab',{name:styleGroups[group],exact:true});
  if(await tab.getAttribute('aria-selected')!=='true')await tab.click();
  return dialog;
}
/** Opens the Score style dialog at the group that holds the disclosure named `name` (the 'Design: ...' sections are Spacing and grouping, 'Page layout' and 'Default view' are Page and view, the rest is Engraving and fonts)
 * and opens that disclosure (and the ones around it). A button clicked through clickWorkstationButton closes the dialog again, so call this again before the next control. */
export async function styleSection(page,name) {
  const group=/^Design/.test(name)?'layout':/^(Page layout|Default view)$/.test(name)?'page':'style';
  const dialog=await openScoreStyle(page,group);
  await dialog.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first().evaluate(node=>{for(let item=node.parentElement;item;item=item.parentElement)if(item.tagName==='DETAILS')item.open=true;});
  return dialog;
}
export async function closeScoreStyle(page) {
  const dialog=page.locator('.score-style-dialog');
  if(await dialog.isVisible()){await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});}
}

/** Sets a Song tab field (Title, Artist, or one behind More: 'Initial tempo', 'Subtitle', 'Album', ...). It applies when the field is left, so this blurs it and waits for idle. */
export async function setSongField(page,label,value) {
  await revealInspectorTab(page,'Song');
  const more=page.locator('.song-information .inspector-more');
  if(!await more.evaluate(node=>node.open))await more.locator('summary').click();
  const field=page.getByLabel(label,{exact:true});await field.fill(String(value));await field.blur();await waitForWorkspaceIdle(page);
}
/** Sets a Track tab field that applies when it is left: 'Track name', 'Track short name', or one under Musical notation > More ('Sounding transposition', 'Display transposition', 'Staff clef'). */
export async function setTrackField(page,label,value) {
  await revealInspectorTab(page,'Track');
  let field=page.getByLabel(label,{exact:true});
  if(!await field.first().isVisible()){const more=page.locator('.track-notation-more .inspector-more');if(!await more.evaluate(node=>node.open))await more.locator('summary').click();field=page.getByLabel(label,{exact:true});}
  await field.fill(String(value));await field.blur();await waitForWorkspaceIdle(page);
}
/** Opens the Add track dialog (the new track name, instrument and tuning rows, the add button and the notation tracks) from Track > Add track… and returns it.
 * The dialog is modal and closes itself when a track is added; Escape leaves it with nothing added. */
export async function openAddTrackDialog(page) {
  const dialog=page.getByRole('dialog',{name:'Add track',exact:true});
  if(!await dialog.isVisible()){await closeInspectorDialogs(page);await clickTrackMenuItem(page,'Add track…');await dialog.waitFor({state:'visible'});}
  return dialog;
}
/** Clicks an item of the Track menu (or `menu`, such as 'Sound') in the command bar: 'Add track…', 'Move track up', 'Move track down', 'VST3 plug-in…'. */
export async function clickTrackMenuItem(page,name,menu='Track') {
  await openDisclosure(summary(page,new RegExp(`^${menu}$`)));
  await page.getByRole('button',{name,exact:true}).click();
}

/** Opens the 'Sound and pedalboard' dialog from the Track tab (optionally at a pedal's chip: 'Edit Drive') and returns the 'Track sound' panel inside it.
 * The dialog is modal: call closeSoundDialog before touching anything behind it. */
export async function openSoundDialog(page,chip=null) {
  const dialog=page.locator('.sound-dialog');
  if(!await dialog.isVisible()) {
    await revealInspectorTab(page,'Track');
    await (chip?page.getByRole('button',{name:chip,exact:true}):page.getByRole('button',{name:'Sound and pedalboard…',exact:true})).click();
    await dialog.waitFor({state:'visible'});
  }
  return dialog.getByRole('region',{name:'Track sound'});
}
export async function closeSoundDialog(page) {
  const dialog=page.locator('.sound-dialog');
  if(await dialog.isVisible()){await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await waitForWorkspaceIdle(page);}
}

/** Practice settings open from the toolbar's practice button. */
export async function revealPractice(page) {
  await closeInspectorDialogs(page);
  const menu=page.locator('details.gp-practice');
  if(!await menu.evaluate(node=>node.open))await menu.locator(':scope>summary').click();
}
/** The practice popover opens over the inspector tabs, so close it before touching anything behind it. */
export async function hidePractice(page) {
  const menu=page.locator('details.gp-practice');
  if(await menu.evaluate(node=>node.open))await menu.locator(':scope>summary').click();
}
/** @param {'Overview'|'Mixer'|'Instrument'} view */
export async function revealDock(page,view) {
  if(!['Overview','Mixer','Instrument'].includes(view))throw new Error(`Unknown dock view: ${view}`);
  await closeInspectorDialogs(page);
  const nav=page.getByRole('navigation',{name:'Dock views',exact:true});
  if(!await nav.isVisible())await showPane(page,'Bottom dock');
  const button=nav.getByRole('button',{name:view,exact:true});
  if(await button.getAttribute('aria-pressed')!=='true')await button.click();
  const expand=page.getByRole('button',{name:'Expand bottom dock',exact:true});
  if(await expand.isVisible())await expand.click();
}

const speedPresets=[10,25,50,75,100,125,150,200,250,300];
/** The transport steps through its speed presets with Slower and Faster; this presses them until the readout shows `percent`. */
export async function setPlaybackSpeed(page,percent) {
  if(!speedPresets.includes(percent))throw new Error(`Unknown speed preset: ${percent}`);
  const group=page.getByRole('group',{name:'Speed',exact:true}),readout=group.locator('.transport-speedvalue');
  for(let attempt=0;attempt<speedPresets.length;attempt++) {
    const text=await readout.evaluate(node=>'value' in node?node.value:node.textContent),current=Number.parseFloat(text);
    if(current===percent)return;
    await group.getByRole('button',{name:percent<current?'Slower':'Faster',exact:true}).click();
    await page.waitForFunction(([selector,previous])=>{const node=document.querySelector(selector);const text=node?('value' in node?node.value:node.textContent):'';return text!==previous;},['.transport-speedvalue',text],{timeout:10000});
  }
  throw new Error(`Speed did not reach ${percent}%`);
}

export async function revealPlaybackControls(page) {
  await closeInspectorDialogs(page);
  return openDisclosure(summary(page,/^More playback(?: · Error)?(?: ♮ [+−-]?\d+)?$/));
}

/** The More playback panel opens upward over the inspector, so close it before touching anything behind it. */
export async function hidePlaybackControls(page) {
  const more=summary(page,/^More playback(?: · Error)?(?: ♮ [+−-]?\d+)?$/);
  if(await more.evaluate(node=>node.parentElement.open))await more.click();
}

export async function selectWorkspaceTrack(page,name) {
  if(!/^Track \d+: /.test(name))throw new Error(`Unknown track button: ${name}`);
  await closeInspectorDialogs(page);
  const instrument=page.getByRole('navigation',{name:'Dock views',exact:true,includeHidden:true}).getByRole('button',{name:'Instrument',exact:true,includeHidden:true});
  const returnToInstrument=await instrument.getAttribute('aria-pressed')==='true';
  await revealDock(page,'Mixer');
  await page.getByRole('button',{name,exact:true}).click();
  if(returnToInstrument)await revealDock(page,'Instrument');
}

const paletteCommands={'Insert beat':'insert beat','Delete beat':'delete beat','Make rest':'make rest','Append measure':'append measure','Remove measure':'remove measure'};
// The Selection tab's chord and scale buttons are the edition palette's Chords and Scale diagram buttons; they open the same dialogs.
const paletteButtons={'Edit chord diagram':'Chords','Browse scales':'Scale diagram'};
const addTrackActions=new Set(['Add track','Add pitched track','Add percussion track']);
// Reordering is in the Track menu; the Information row's arrows choose the previous and next track.
const trackMenuActions=new Set(['Move track up','Move track down']);
const trackActions=new Set(['Remove track','Duplicate track','Previous track','Next track']);
const backingActions=new Set(['Import backing','Remove backing']);
const playbackActions=new Set(['Seek','Loop','Clear loop','Play from cursor','Play selection','Loop selection']);

// Existing acceptance wrappers use this presentation routing. Other actions keep
// their exact existing button label; no native command or acceptance is replaced.
/** Closes every open inspector dialog that does not hold the button `name` and returns the one that does (or null). */
async function closeDialogsBehind(page,name) {
  let host=null;
  for(const dialog of inspectorDialogs(page)) {
    if(!await dialog.isVisible())continue;
    if(name&&await dialog.getByRole('button',{name,exact:true}).count())host=dialog;else await dismiss(page,dialog);
  }
  return host;
}

export async function clickWorkstationButton(page,name,{waitForIdle=true}={}) {
  const host=await closeDialogsBehind(page,name);
  if(fileCommands.has(name))return clickWorkspaceCommand(page,name,{waitForIdle});
  if(/^Track \d+: /.test(name))await selectWorkspaceTrack(page,name);
  else {
    if(trackActions.has(name))await revealLeftTask(page,'Track');
    if(addTrackActions.has(name))await openAddTrackDialog(page);
    if(trackMenuActions.has(name)){await closeInspectorDialogs(page);await clickTrackMenuItem(page,name);if(waitForIdle)await waitForWorkspaceIdle(page);return;}
    if(backingActions.has(name))await revealLeftTask(page,'Backing');
    if(playbackActions.has(name))await revealPlaybackControls(page);
    // Edit, Practice and Presentation were inspector task buttons; Edit (the Selection tab) is gone, Practice is the toolbar popover and Presentation is the Song tab.
    // The old Selection-tab buttons for the cursor's beat and bar are the command palette's commands now (Ctrl+Shift+P).
    if(name==='Edit')return;
    else if(name in paletteCommands)await runCommand(page,paletteCommands[name]);
    else if(name in paletteButtons){await closeInspectorDialogs(page);await editionPalette(page).getByRole('button',{name:paletteButtons[name],exact:true}).click();}
    else if(name==='Practice')await revealPractice(page);
    else if(name==='Presentation')await revealInspectorTab(page,'Song');
    else {
      const control=page.getByRole('button',{name,exact:true});
      let found=host;
      if(!await control.first().isVisible()){await revealInspectorControl(page,control);found=null;for(const dialog of inspectorDialogs(page))if(await dialog.isVisible())found=dialog;}
      await control.click();
      // A control that lives in one of those dialogs closes it again behind the click, which would otherwise keep the rest of the app inert.
      if(found)await dismiss(page,found);
    }
  }
  if(waitForIdle)await waitForWorkspaceIdle(page);
}
