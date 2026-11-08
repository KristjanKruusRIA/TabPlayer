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

/** Reveal without waiting on an operation: native picker callers must answer it first. */
export async function revealWorkspaceCommand(page,name) {
  if(!fileCommands.has(name))throw new Error(`Unknown workspace command: ${name}`);
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

/** Opens an inspector tab: Song (score settings), Track (track, sound and interpretation) or Selection (the editor). */
export async function revealInspectorTab(page,tab) {
  if(!['Song','Track','Selection'].includes(tab))throw new Error(`Unknown inspector tab: ${tab}`);
  await revealInspector(page);
  const button=page.getByRole('tablist',{name:'Inspector',exact:true}).getByRole('tab',{name:tab,exact:true});
  if(await button.getAttribute('aria-selected')!=='true')await button.click();
}

/** The former left-pane tasks: Track and Sound live in the inspector's Track tab, Backing in the global view's Backing tab.
 * @param {'Track'|'Sound'|'Backing'} task */
export async function revealLeftTask(page,task) {
  if(!['Track','Sound','Backing'].includes(task))throw new Error(`Unknown left task: ${task}`);
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

/** The three inspector tabs share one panel, so a control is only visible on its own tab. This opens the first tab in which `locator`
 * is visible and returns it; a driver that does not know where a control lives can call it before acting. */
export async function revealInspectorControl(page,locator) {
  await revealInspector(page);
  for(const tab of ['Selection','Track','Song']) {
    await revealInspectorTab(page,tab);
    if(await locator.first().isVisible())return locator;
  }
  throw new Error(`Control is not visible on any inspector tab: ${locator}`);
}

/** Practice settings open from the toolbar's practice button. */
export async function revealPractice(page) {
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

export function revealPlaybackControls(page) {
  return openDisclosure(summary(page,/^More playback(?: · Error)?$/));
}

/** The More playback panel opens upward over the inspector, so close it before touching anything behind it. */
export async function hidePlaybackControls(page) {
  const more=summary(page,/^More playback(?: · Error)?$/);
  if(await more.evaluate(node=>node.parentElement.open))await more.click();
}

export async function selectWorkspaceTrack(page,name) {
  if(!/^Track \d+: /.test(name))throw new Error(`Unknown track button: ${name}`);
  const instrument=page.getByRole('navigation',{name:'Dock views',exact:true,includeHidden:true}).getByRole('button',{name:'Instrument',exact:true,includeHidden:true});
  const returnToInstrument=await instrument.getAttribute('aria-pressed')==='true';
  await revealDock(page,'Mixer');
  await page.getByRole('button',{name,exact:true}).click();
  if(returnToInstrument)await revealDock(page,'Instrument');
}

const trackActions=new Set(['Apply tuning','Apply instrument settings','Add track','Remove track','Add pitched track','Add percussion track']);
const backingActions=new Set(['Import backing','Remove backing']);
const playbackActions=new Set(['Seek','Loop','Clear loop','Play from cursor','Play selection','Loop selection']);

// Existing acceptance wrappers use this presentation routing. Other actions keep
// their exact existing button label; no native command or acceptance is replaced.
export async function clickWorkstationButton(page,name,{waitForIdle=true}={}) {
  if(fileCommands.has(name))return clickWorkspaceCommand(page,name,{waitForIdle});
  if(/^Track \d+: /.test(name))await selectWorkspaceTrack(page,name);
  else {
    if(trackActions.has(name))await revealLeftTask(page,'Track');
    if(name==='Add track')await openDisclosure(page.locator('.track-settings summary').filter({hasText:/^Add instrument$/}));
    if(name==='Apply instrument settings')await openDisclosure(page.locator('.track-settings summary').filter({hasText:/^Selected instrument$/}));
    if(backingActions.has(name))await revealLeftTask(page,'Backing');
    if(playbackActions.has(name))await revealPlaybackControls(page);
    // Edit, Practice and Presentation were inspector task buttons; they are now the Selection tab, the toolbar practice popover and the Song tab.
    if(name==='Edit')await revealInspectorTab(page,'Selection');
    else if(name==='Practice')await revealPractice(page);
    else if(name==='Presentation')await revealInspectorTab(page,'Song');
    else {const control=page.getByRole('button',{name,exact:true});if(!await control.first().isVisible())await revealInspectorControl(page,control);await control.click();}
  }
  if(waitForIdle)await waitForWorkspaceIdle(page);
}
