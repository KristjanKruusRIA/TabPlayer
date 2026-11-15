// THE-215 part 2: the inspector has only Song and Track. This drives the real app with real clicks and keys and checks that
// every control that used to live in the Selection tab (or moved out of the Song and Track tabs) records the same edit from its
// new home and that Undo restores it; that the Score style, Sound and pedalboard, Tuning (Capo section), Mastering and Properties dialogs
// open and close properly; that a stored "selection" tab preference opens Track; and that nothing is covered, clipped or overflowing at the
// narrowest and widest sidebar in English, Estonian and German.
// usage (from the checkout root, after scripts/build-desktop-test.ps1): node tests/desktop/inspector-relocation.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openScore,settle,sleep } from './entry-mix-support.mjs';
import { revealInspectorTab,openProperties,closeProperties,clickWorkstationButton } from './workstation-commands.mjs';

const shots=resolve(process.argv[2]??'.analysis/desktop-smoke/inspector-relocation');mkdirSync(shots,{recursive:true});
const session=await openScore('small'),{page}=session,report={checks:[]};
const note=(name,evidence)=>{report.checks.push({name,evidence});console.log(`ok - ${name}`);};
const focusedLabel=()=>page.evaluate(()=>{const e=document.activeElement;return e?(e.getAttribute('aria-label')||e.textContent?.trim().slice(0,40)||e.tagName):'';});
/** Runs `action`, expects exactly one new edit of `type`, then Undo takes it back. Returns the edit. */
async function once(label,type,action) {
  const before=(await session.edits()).length;await action();await settle(page,400);
  const after=await session.edits();assert.equal(after.length,before+1,`${label}: exactly one edit (had ${before}, now ${after.length}: ${after.slice(before).map(e=>e.type)})`);
  assert.equal(after.at(-1).type,type,`${label}: edit type`);
  const edit=after.at(-1);
  await clickWorkstationButton(page,'Undo');await settle(page,400);
  assert.equal((await session.edits()).length,before,`${label}: Undo takes it back`);
  note(label,{type,edit});return edit;
}
async function nothing(label,action) {
  const before=(await session.edits()).length;await action();await settle(page,300);
  assert.equal((await session.edits()).length,before,`${label}: records nothing`);note(label,{});
}
const uncovered=root=>page.evaluate(selector=>{
  const rootNode=document.querySelector(selector);if(!rootNode)return {error:`no ${selector}`};
  const bad=[],tiny=[],clipped=[];let count=0;
  for(const node of rootNode.querySelectorAll('button,input,select,textarea,summary,[role=tab],[role=switch]')){
    if(node.closest('details:not([open])')&&!node.matches('details:not([open])>summary'))continue;
    if(node.closest('[hidden]'))continue;
    const r=node.getBoundingClientRect();if(r.width===0||r.height===0)continue;
    const scroller=node.closest('.workstation-inspector,.tp-dialog-body');if(scroller){const s=scroller.getBoundingClientRect();if(r.top<s.top-1||r.bottom>s.bottom+1)continue;}
    count++;
    if(node.matches('button,summary,[role=tab],input[type=checkbox]')&&Math.min(r.width,r.height)<24&&!node.closest('.slot-row')&&!node.closest('.partial-capo-strings,.banjo-drone,.check'))tiny.push({control:node.getAttribute('aria-label')||node.textContent.trim().slice(0,20),w:Math.round(r.width),h:Math.round(r.height)});
    const x=Math.min(Math.max(r.x+r.width/2,0),innerWidth-1),y=Math.min(Math.max(r.y+r.height/2,0),innerHeight-1);
    const top=document.elementFromPoint(x,y);
    if(!top||!(node===top||node.contains(top)||top.contains(node)))bad.push({control:node.getAttribute('aria-label')||node.textContent.trim().slice(0,30),covering:top?`${top.tagName}.${top.className}`:null});
    if(node.matches('button')&&node.scrollWidth>node.clientWidth+1&&getComputedStyle(node).textOverflow!=='ellipsis'&&node.textContent.trim())clipped.push(node.textContent.trim().slice(0,30));
  }
  return {bad,tiny,clipped,count,horizontalOverflow:rootNode.scrollWidth>rootNode.clientWidth+1};
},root);
const sidebar=async side=>{await page.locator('.inspector-resize').focus();for(let i=0;i<40;i++)await page.keyboard.press(side==='narrowest'?'ArrowRight':'ArrowLeft');await sleep(250);};
const dialogOpen=async(open,selector)=>{await open();const dialog=page.locator(selector);await dialog.waitFor();return dialog;};
const closeTop=async selector=>{await page.keyboard.press('Escape');await page.locator(selector).waitFor({state:'hidden'});};

try{
  // ---- tabs and the stored preference ----
  const tabs=page.getByRole('tablist',{name:'Inspector',exact:true}).getByRole('tab');
  assert.deepEqual(await tabs.allTextContents(),['Song','Track'],'the inspector has only Song and Track');
  note('the inspector has only Song and Track',await tabs.allTextContents());
  for(const [stored,expected] of [['selection','Track'],['bogus','Track'],['song','Song']]){
    await page.evaluate(value=>localStorage.setItem('tabplayer.inspectorTab',value),stored);await page.reload();await page.locator('.app-shell').waitFor();await settle(page,500);
    const selected=await page.getByRole('tablist',{name:'Inspector',exact:true}).getByRole('tab',{selected:true}).textContent();
    assert.equal(selected,expected,`stored "${stored}" opens ${expected}`);note(`a stored "${stored}" tab preference opens ${expected}`,{selected});
  }
  await page.evaluate(()=>localStorage.removeItem('tabplayer.inspectorTab'));

  // ---- status bar ----
  const status=await page.locator('.statusbar').textContent();
  assert.match(status,/String \d/);assert.match(status,/Fret \d+ · [A-G]/);assert.match(status,/\d+\/\d+ · \d+ BPM/);
  note('the status bar names the cursor position, the fret and pitch, the time signature and tempo',{status});

  // ---- Song tab ----
  await revealInspectorTab(page,'Song');await settle(page,300);
  await page.screenshot({path:resolve(shots,'after-song-tab.png')});
  const title=page.getByLabel('Title',{exact:true});
  await nothing('title left unchanged records nothing',async()=>{await title.focus();await title.blur();});
  await once('Title applies when left','setScoreInfo',async()=>{await title.fill('Etude relocated');await title.blur();});
  await page.getByText('More',{exact:true}).first().click();
  await once('Song metadata (Subtitle, behind More) applies when left','setScoreMetadata',async()=>{const field=page.getByLabel('Subtitle',{exact:true});await field.fill('Study');await field.blur();});
  await page.getByText('More',{exact:true}).first().click();
  const styleButton=page.getByRole('button',{name:'Score style…',exact:true});
  await styleButton.focus();
  const style=await dialogOpen(()=>styleButton.click(),'.score-style-dialog');
  assert.equal(await style.getByRole('tab').count(),3);
  report.scoreStyle=await uncovered('.score-style-dialog');assert.deepEqual(report.scoreStyle.bad,[],'score style: nothing covered');
  await style.getByRole('tab',{name:'Page and view'}).click();await page.screenshot({path:resolve(shots,'after-score-style-dialog.png')});
  const before=(await session.edits()).length;await closeTop('.score-style-dialog');
  assert.equal((await session.edits()).length,before,'closing the Score style dialog records nothing');
  assert.equal(await focusedLabel(),'Score style…','focus returns to the Score style button');
  note('Score style dialog: three groups, nothing covered, Escape closes it and focus returns',{});
  const slots=page.getByRole('list',{name:'Sound mastering'});
  const eq=slots.getByRole('switch',{name:/EQ/});
  assert.equal(await eq.isChecked(),false);await eq.click();await settle(page,300);assert.equal(await eq.isChecked(),true,'EQ switch is on');await eq.click();await settle(page,300);assert.equal(await eq.isChecked(),false);
  note('mastering slot switch flips the effect on and back off',{});
  await page.getByRole('button',{name:'Edit Reverb'}).click();await page.locator('.master-dialog').waitFor();
  await page.screenshot({path:resolve(shots,'after-mastering-dialog.png')});await closeTop('.master-dialog');
  note('mastering edit button opens the full master controls in a dialog',{});

  // ---- Track tab ----
  await revealInspectorTab(page,'Track');await settle(page,300);
  await page.screenshot({path:resolve(shots,'after-track-tab.png')});
  const name=page.getByLabel('Track name',{exact:true});
  await nothing('track name left unchanged records nothing',async()=>{await name.focus();await name.blur();});
  await once('Track name applies when left','setTrackInfo',async()=>{await name.fill('Lead');await name.blur();});
  await once('Track colour applies when the picker settles','setTrackColor',async()=>{await page.locator('.track-color-input').fill('#ff8800');});
  await once('Tablature toggle records the staff settings','setStaffSettings',async()=>{await page.getByRole('button',{name:'Show tablature',exact:true}).click();});
  await once('Notation toggle records the staff settings','setStaffSettings',async()=>{await page.getByRole('button',{name:'Show notation',exact:true}).click();});
  await page.locator('.track-notation-more summary').click();
  await once('Sounding transposition (More) applies when left','setStaffSettings',async()=>{const field=page.getByLabel('Sounding transposition',{exact:true});await field.fill('12');await field.blur();});
  await once('Add staff (More) records addStaff','addStaff',async()=>{await page.getByRole('button',{name:'Add staff',exact:true}).click();});
  await page.locator('.track-notation-more summary').click();
  // Tuning dialog with its Capo section.
  const tuning=page.locator('.track-settings .track-tuning-button').first();
  await tuning.click();const tdialog=page.getByRole('dialog',{name:'Tuning',exact:true});await tdialog.waitFor();
  assert.equal(await tdialog.getByLabel('Capo',{exact:true}).inputValue(),'0');
  await page.screenshot({path:resolve(shots,'after-tuning-dialog-capo.png')});
  await nothing('Keep fingering with the same tuning and capo records nothing',async()=>{await tdialog.getByRole('button',{name:'Keep fingering'}).click();await tdialog.waitFor({state:'hidden'});});
  await once('Capo in the Tuning dialog is one setStaffSettings','setStaffSettings',async()=>{await tuning.click();await tdialog.getByLabel('Capo',{exact:true}).fill('2');await tdialog.getByRole('button',{name:'Keep fingering'}).click();await tdialog.waitFor({state:'hidden'});});
  assert.equal(await focusedLabel().then(label=>label.includes('Edit tuning')),true,'focus returns to the tuning button');
  // Sounds.
  await once('Sound preset records one setTrackSound','setTrackSound',async()=>{await page.getByLabel('Sound preset',{exact:true}).selectOption('clean');});
  const editor=page.getByRole('button',{name:'Sound and pedalboard…',exact:true});await editor.focus();
  const sound=await dialogOpen(()=>editor.click(),'.sound-dialog');
  await page.screenshot({path:resolve(shots,'after-sound-dialog.png')});
  await once('A pedal switched on in the sound dialog records one setTrackSound','setTrackSound',async()=>{await sound.getByText('Chorus',{exact:true}).first().click();await sound.getByRole('checkbox',{name:/^Enable chorus/i}).check();});
  await closeTop('.sound-dialog');assert.equal(await focusedLabel(),'Sound and pedalboard…','focus returns to the sound editor button');
  await once('Interpretation: Playing style records one setTrackMix','setTrackMix',async()=>{await page.getByLabel('Playing style',{exact:true}).selectOption('pick');});
  note('Sounds and Interpretation controls record the same edits from compact rows',{});

  // ---- Properties dialog (what the Selection tab held) ----
  await openProperties(page,'note');
  await once('Note: Palm mute records setNoteTechniques','setNoteTechniques',async()=>{
    const dialog=page.getByRole('dialog',{name:'Properties',exact:true});
    const summary=dialog.locator('summary',{hasText:'Notes & techniques'});if(!await summary.evaluate(n=>n.parentElement.open))await summary.click();
    await dialog.getByLabel('Palm mute',{exact:true}).check();});
  await openProperties(page,'beat');
  await once('Beat: a 5:3 tuplet records setBeatRhythm','setBeatRhythm',async()=>{
    const dialog=page.getByRole('dialog',{name:'Properties',exact:true});
    await dialog.getByLabel('Tuplet numerator').fill('5');await dialog.getByLabel('Tuplet denominator').fill('3');await dialog.getByRole('button',{name:'Apply rhythm'}).click();});
  await openProperties(page,'bar');
  await once('Bar: the time signature records setMeasureSettings','setMeasureSettings',async()=>{
    const dialog=page.getByRole('dialog',{name:'Properties',exact:true});
    const summary=dialog.locator('summary',{hasText:'Measure & notation'});if(!await summary.evaluate(n=>n.parentElement.open))await summary.click();
    await dialog.getByLabel('Time numerator').fill('3');await dialog.getByRole('button',{name:'Apply measure settings'}).click();});
  await openProperties(page,'staff');
  await once('Staff and voices: Add voice records addVoice','addVoice',async()=>{
    const dialog=page.getByRole('dialog',{name:'Properties',exact:true});
    const summary=dialog.locator('summary',{hasText:'Staff, voices & layout'});if(!await summary.evaluate(n=>n.parentElement.open))await summary.click();
    await dialog.getByRole('button',{name:'Add voice',exact:true}).click();});
  await page.screenshot({path:resolve(shots,'after-properties-dialog.png')});
  await closeProperties(page);
  // The palette's Lyrics button opens the dialog at the Lyrics section.
  await page.locator('[data-palette-id="lyrics"]').click();
  const lyrics=page.getByRole('dialog',{name:'Properties',exact:true});await lyrics.waitFor();
  assert.equal((await focusedLabel()).startsWith('Lyrics'),true,`Lyrics summary focused, got ${await focusedLabel()}`);
  await closeProperties(page);note('the palette Lyrics button opens the Properties dialog at Lyrics',{});

  // ---- covered / clipped / overflow matrix ----
  report.matrix={};
  for(const language of ['en','et','de']){
    await page.evaluate(value=>window.localStorage.setItem('tabplayer.language',value),language);await page.reload();await page.locator('.app-shell').waitFor();await settle(page,500);
    assert.equal(await page.locator('.app-shell').getAttribute('lang'),language);
    report.matrix[language]={};
    for(const side of ['narrowest','widest']){
      await sidebar(side);const result={};
      for(const [tab,selector] of [['song','#inspector-panel-song'],['track','#inspector-panel-track']]){
        await page.locator(`[data-inspector-tab="${tab}"]`).click();await sleep(250);
        result[tab]=await uncovered(selector);
        if(tab==='song'){await page.locator('.song-information .inspector-more>summary').click();result.songMore=await uncovered(selector);await page.locator('.song-information .inspector-more>summary').click();}
        else{await page.locator('.track-notation-more .inspector-more>summary').click();result.trackMore=await uncovered(selector);await page.locator('.track-notation-more .inspector-more>summary').click();}
        await page.screenshot({path:resolve(shots,`matrix-${language}-${side}-${tab}.png`)});
      }
      for(const [key,value] of Object.entries(result)){
        assert.deepEqual(value.bad,[],`${language} ${side} ${key}: no control covered`);assert.equal(value.horizontalOverflow,false,`${language} ${side} ${key}: no horizontal overflow`);
        assert.deepEqual(value.clipped,[],`${language} ${side} ${key}: no clipped button text`);assert.deepEqual(value.tiny,[],`${language} ${side} ${key}: hit targets are at least 24 px`);
      }
      // The dialogs.
      await page.locator('[data-inspector-tab="song"]').click();
      const dialogs=[['style','.stylesheet-row button','.score-style-dialog'],['mastering','.slot-more','.master-dialog']];
      await page.locator('[data-inspector-tab="track"]').click();
      dialogs.push(['sound','.sound-editor-open','.sound-dialog']);
      for(const [key,opener,selector] of dialogs){
        await page.locator(`[data-inspector-tab="${key==='sound'?'track':'song'}"]`).click();
        await page.locator(opener).first().click();await page.locator(selector).waitFor();
        const found=await uncovered(selector);assert.deepEqual(found.bad,[],`${language} ${side} ${key} dialog: nothing covered`);assert.equal(found.horizontalOverflow,false,`${language} ${side} ${key} dialog: no sideways scroll`);
        assert.equal(await page.evaluate(sel=>{const d=document.querySelector(sel).getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight;},selector),true,`${language} ${side} ${key} dialog fits the window`);
        result[`${key}Dialog`]=found;await closeTop(selector);
      }
      await page.locator('[data-palette-id="lyrics"]').click();await page.locator('.properties-dialog').waitFor();
      const props=await uncovered('.properties-dialog');assert.deepEqual(props.bad,[],`${language} ${side} properties: nothing covered`);assert.equal(props.horizontalOverflow,false);
      await page.screenshot({path:resolve(shots,`matrix-${language}-${side}-properties.png`)});await closeTop('.properties-dialog');
      report.matrix[language][side]=Object.fromEntries(Object.entries(result).map(([key,value])=>[key,{controls:value.count}]));
    }
    note(`${language}: no covered, clipped or overflowing control at the narrowest and widest sidebar, in the tabs and the dialogs`,report.matrix[language]);
  }
  await page.evaluate(()=>window.localStorage.setItem('tabplayer.language','en'));
  console.log(JSON.stringify({checks:report.checks.length},null,1));
}finally{await session.close();}
