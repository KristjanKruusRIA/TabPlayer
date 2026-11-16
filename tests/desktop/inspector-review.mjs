// THE-215 review fixes, driven in the real app with real clicks and keys:
//  1. a name or transposition typed for one track is recorded for that track, once, when the next click makes another track the active one (a click on a note of another track, or on its name);
//  2. a track with several staves has a staff selector, and its tuning is edited one staff at a time;
//  3. a select browsed with the arrow keys records one edit when it is left, not one per key;
//  4. an Apply in the Properties dialog keeps focus on its button (a second Enter does not close the dialog), and the dialog opens on its selected tab;
//  5. a dialog opened from the inspector stays visible when the window becomes short enough for the inspector to hide itself.
// usage (from the checkout root, after scripts/build-desktop-test.ps1): node tests/desktop/inspector-review.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openScore,settle,sleep,click,centre } from './entry-mix-support.mjs';
import { revealInspectorTab,openProperties,closeProperties,clickWorkstationButton,moveCursor,cursorPosition } from './workstation-commands.mjs';

const shots=resolve(process.argv[2]??'.analysis/desktop-smoke/inspector-review');mkdirSync(shots,{recursive:true});
const session=await openScore('small'),{page,cdp}=session,report={checks:[]};
const note=(name,evidence)=>{report.checks.push({name,evidence});console.log(`ok - ${name}`);};
/** The topmost or the lowest fret number the score draws: with every track shown, the first lies on the first track and the last on the last one.
 * Not counted: the red bar numbers, and the digits of the time signature and of the rotated track labels at the left of each staff (all left of x=560). */
const numberAt=(which)=>page.evaluate(which=>{
  const numbers=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&text.getBoundingClientRect().width>0&&text.getBoundingClientRect().x>560&&!/rgb\(2[0-2]\d, ?\d+, ?\d+\)|red/.test(getComputedStyle(text).fill));
  numbers.sort((a,b)=>a.getBoundingClientRect().y-b.getBoundingClientRect().y);
  const node=numbers[which==='first'?0:numbers.length-1];node.scrollIntoView({block:'center',inline:'nearest'});
  const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
},which);
const clickNote=async which=>{const point=await numberAt(which);await click(cdp,point.x,point.y);await settle(page,500);};
/** A real click on the name of track `index` in the overview: it makes that track the active one. */
const clickTrack=async index=>{const spot=await centre(page,`[role=row][aria-rowindex="${index+2}"] button.score-overview-track-name`);await click(cdp,spot.x,spot.y);await settle(page,500);};
const selectFirst=async()=>{await clickTrack(0);await clickNote('first');};
const trackText=()=>page.locator('.statusbar-track').first().textContent();
const undo=async()=>{await clickWorkstationButton(page,'Undo');await settle(page,400);};

try{
  // The score shows only the selected track by default; show every track so a click can land on another one.
  await page.getByRole('combobox',{name:/^Displayed tracks/}).selectOption('all');await settle(page,800);
  await selectFirst();
  await revealInspectorTab(page,'Track');await settle(page,300);
  await page.locator('.track-notation-more summary').click();
  const first=await trackText();

  // ---- 1. typed for one track, left by a click ----
  // A click on the name of another track in the overview makes that track the active one, so the selection moves while the field is being left:
  // the edit must still go to the first track, once, and the field must then show the other track.
  // A click on a real note of another track does NOT select it in this build (measured: the cursor and the active track stay where they were,
  // and the build before this branch behaves the same), so that click only takes focus from the field: the edit goes to the first track, once,
  // and the active track is unchanged.
  for(const [label,field,text,pick,leave,changesTrack] of [
    ['a track name, left by a click on a note of another track','Track name','Renamed first track',edit=>({type:edit.type,track:edit.track,value:edit.name}),()=>clickNote('last'),false],
    ['a track name, left by a click on another track\'s name','Track name','Renamed first track',edit=>({type:edit.type,track:edit.track,value:edit.name}),()=>clickTrack(2),true],
    ['a sounding transposition, left by a click on another track\'s name','Sounding transposition','-12',edit=>({type:edit.type,track:edit.track,value:edit.settings.transposition}),()=>clickTrack(2),true],
  ]) {
    await selectFirst();assert.equal(await trackText(),first,`${label}: the first note is on the first track`);
    const before=(await session.edits()).length,input=page.getByLabel(field,{exact:true});
    await input.click();await input.fill(text);
    await leave();
    const after=await trackText();
    if(changesTrack)assert.ok(after!==first&&after!==text,`${label}: the click made another track active (was ${first}, now ${after})`);
    else assert.ok(after===first||after===text,`${label}: a note of another track does not change the active track (was ${first}, now ${after})`);
    const made=(await session.edits()).slice(before);
    assert.equal(made.length,1,`${label}: exactly one edit (got ${made.map(edit=>edit.type)})`);
    const got=pick(made[0]);
    assert.equal(got.track,0,`${label}: recorded for the track it was typed for`);
    assert.equal(String(got.value),text);
    if(changesTrack)assert.notEqual(await page.getByLabel(field,{exact:true}).inputValue(),text,`${label}: the field now shows the other track`);
    await undo();assert.equal((await session.edits()).length,before,`${label}: Undo takes it back`);
    note(`${label}: recorded once, for the track it was typed for`,{edit:got});
  }

  // ---- 2. staff selector and per-staff tuning ----
  await selectFirst();
  const count=(await session.edits()).length;
  await page.getByRole('button',{name:'Add staff',exact:true}).click();await settle(page,500);
  assert.equal((await session.edits()).length,count+1,'Add staff is one edit');
  const selector=page.getByRole('combobox',{name:'Staff',exact:true});
  await selector.waitFor();assert.equal(await selector.locator('option').count(),2,'two staves');
  // By keyboard: the selector is the way to reach a second staff without the mouse.
  await moveCursor(page,{bar:3,beat:2});
  await selector.focus();await page.keyboard.press('ArrowDown');await settle(page,500);
  assert.match(await trackText(),/Staff 2$/,'the staff selector moved the cursor to staff 2');
  const at=await cursorPosition(page);assert.equal(at.bar,3,'the staff selector keeps the bar');assert.equal(at.beat,1,'the new staff is empty (one rest per bar), so the cursor goes to its first beat, the nearest one it has');
  const tuningButton=page.locator('.track-settings .track-tuning-button').first(),tuned=(await session.edits()).length;
  await tuningButton.click();const tuning=page.getByRole('dialog',{name:'Tuning',exact:true});await tuning.waitFor();
  const notes=tuning.getByLabel('Notes, high to low',{exact:true});const was=await notes.inputValue();
  await notes.fill(was.replace(/\S+$/,'D2'));await notes.press('Tab');
  await tuning.getByRole('button',{name:'Keep fingering'}).click();await tuning.waitFor({state:'hidden'});await settle(page,500);
  const retuned=(await session.edits()).slice(tuned);
  assert.equal(retuned.length,1,'one edit for the staff tuning');assert.equal(retuned[0].type,'setStaffSettings');assert.equal(retuned[0].staff,1,'the second staff was retuned');assert.equal(retuned[0].track,0);
  await undo();await undo();assert.equal((await session.edits()).length,count,'Undo takes both back');
  note('a track with several staves has a staff selector, and its tuning is one setStaffSettings on the selected staff',{retuned:retuned[0].settings.tuning});
  await selectFirst();

  // ---- 3. browsing a closed select with the arrow keys ----
  await page.locator('.track-info .inspector-more summary').click();
  const program=page.locator('label',{hasText:'Track MIDI instrument'}).locator('select'),browsed=(await session.edits()).length;
  await program.focus();for(let i=0;i<4;i++){await page.keyboard.press('ArrowDown');await sleep(60);}
  await settle(page,300);assert.equal((await session.edits()).length,browsed,'browsing the instrument with the arrow keys records nothing per key');
  await page.keyboard.press('Tab');await settle(page,500);
  const chosen=(await session.edits()).slice(browsed);assert.equal(chosen.length,1,'one edit when the select is left');assert.equal(chosen[0].type,'setTrackInfo');
  await undo();assert.equal((await session.edits()).length,browsed);
  note('browsing the MIDI instrument with the arrow keys records one edit when the select is left',{program:chosen[0].program});

  // ---- 4. Properties dialog: opens on its selected tab; Apply keeps focus ----
  await selectFirst();await revealInspectorTab(page,'Track');
  const dialog=await openProperties(page,'note');
  assert.equal(await page.evaluate(()=>{const e=document.activeElement;return e?.getAttribute('role')==='tab'&&e.getAttribute('aria-selected')==='true'?e.textContent:null;}),'Note','the dialog opens with focus on the selected tab');
  await closeProperties(page);
  const beat=await openProperties(page,'beat');
  const rhythm=await session.edits().then(edits=>edits.length);
  await beat.getByLabel('Tuplet numerator').fill('5');await beat.getByLabel('Tuplet denominator').fill('3');
  const apply=beat.getByRole('button',{name:'Apply rhythm'});await apply.click();await settle(page,500);
  assert.equal((await session.edits()).length,rhythm+1,'Apply is one edit');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent?.trim()),'Apply rhythm','focus stays on the Apply button');
  await page.keyboard.press('Enter');await settle(page,300);
  assert.equal(await page.getByRole('dialog',{name:'Properties',exact:true}).isVisible(),true,'a second Enter does not close the dialog');
  assert.equal((await session.edits()).length,rhythm+1,'a second Enter records nothing');
  await closeProperties(page);await undo();
  note('the Properties dialog opens on its selected tab and an Apply keeps focus on its button',{});

  // ---- 5. a dialog stays visible when the window becomes short ----
  const styleButton=page.getByRole('button',{name:'Score style…',exact:true});
  await revealInspectorTab(page,'Song');await styleButton.click();const style=page.locator('.score-style-dialog');await style.waitFor();
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:520,deviceScaleFactor:1,mobile:false});await sleep(800);
  try{
    assert.equal(await page.locator('.app-shell').getAttribute('data-compact-height'),'true','the window is short enough for the inspector to hide');
    assert.equal(await style.isVisible(),true,'the Score style dialog is still there');
    const inside=await page.evaluate(()=>{const r=document.querySelector('.score-style-dialog').getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;});
    assert.equal(inside,true,'the dialog is inside the short window');
    assert.equal(await page.evaluate(()=>{const r=document.querySelector('.score-style-dialog').getBoundingClientRect(),n=document.elementFromPoint(r.x+r.width/2,r.y+24);return !!n&&!!n.closest('.score-style-dialog');}),true,'nothing covers the dialog');
    await page.screenshot({path:resolve(shots,'short-window-dialog.png')});
  }finally{await cdp.send('Emulation.clearDeviceMetricsOverride');await sleep(500);}
  await page.keyboard.press('Escape');await style.waitFor({state:'hidden'});
  note('a dialog opened from the inspector stays visible and uncovered when the window becomes short',{});

  console.log(JSON.stringify({passed:true,checks:report.checks.length}));
}catch(error){try{await page.screenshot({path:resolve(shots,'failure.png')});}catch{ /* The page is gone. */ }throw error;}finally{await session.close();}
