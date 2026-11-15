// THE-215: the Track tab shows the tuning as one row (a button with the notes, a play button) and the track actions as one row of icon
// buttons. The button opens a Tuning dialog that holds the whole editor; nothing is recorded until Keep fingering, Keep pitch or Change
// string count, Cancel and Escape discard, and focus goes back to the button. Real mouse and key input; no control is covered.
// usage (from the checkout root, after scripts/build-desktop-test.ps1): node tests/desktop/parity-tuning-dialog.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openScore,settle,sleep } from './entry-mix-support.mjs';
import { revealInspectorTab,clickWorkstationButton } from './workstation-commands.mjs';

const shots=resolve(process.argv[2]??'.analysis/desktop-smoke/tuning-dialog');mkdirSync(shots,{recursive:true});
const session=await openScore('small'),{page}=session,report={checks:[],shots};
const note=(name,evidence)=>{report.checks.push({name,evidence});console.log(`ok - ${name}`);};
const focused=()=>page.evaluate(()=>{const e=document.activeElement;return e?{tag:e.tagName,label:e.getAttribute('aria-label')||e.textContent?.trim().slice(0,40)||'',inDialog:!!e.closest('[role=dialog]')}:null;});
const tuningEdits=async()=>(await session.edits()).filter(edit=>edit.type==='setTuning'||edit.type==='setStringCount');
const editButton=()=>page.locator('.track-settings .track-tuning-button').first();
/** Every enabled control that is visible inside `root` must be the topmost element at its own centre. */
const uncovered=root=>page.evaluate(selector=>{
  const rootNode=document.querySelector(selector);if(!rootNode)return {error:`no ${selector}`};
  const bad=[],seen=[];
  for(const node of rootNode.querySelectorAll('button,input,select,summary,[role=slider],[role=tab]')){
    if(node.closest('details:not([open])')&&!node.matches('details:not([open])>summary'))continue;
    const r=node.getBoundingClientRect();if(r.width===0||r.height===0)continue;
    // Only what the pane or dialog body shows right now can be covered; the rest is scrolled out of view.
    const scroller=node.closest('.workstation-inspector,.tp-dialog-body');if(scroller){const s=scroller.getBoundingClientRect();if(r.top<s.top||r.bottom>s.bottom)continue;}
    const x=Math.min(Math.max(r.x+r.width/2,0),innerWidth-1),y=Math.min(Math.max(r.y+r.height/2,0),innerHeight-1);
    const top=document.elementFromPoint(x,y);seen.push(node.getAttribute('aria-label')||node.textContent.trim().slice(0,20));
    if(!top||!(node===top||node.contains(top)||top.contains(node)))bad.push({control:node.getAttribute('aria-label')||node.textContent.trim().slice(0,30),tag:`${node.tagName}.${node.className}`,covering:top?`${top.tagName}.${top.className}`:null});
  }
  return {bad,count:seen.length,horizontalOverflow:rootNode.scrollWidth>rootNode.clientWidth+1};
},root);
const panelHeights=()=>page.evaluate(()=>{const p=document.querySelector('#inspector-panel-track');return {scrollHeight:p.scrollHeight,viewport:innerHeight,width:document.querySelector('.workstation-inspector').getBoundingClientRect().width};});
try{
  await revealInspectorTab(page,'Track');await settle(page);
  const row=editButton();await row.waitFor();
  note('Track tab shows the tuning as one button with the notes',{text:await row.textContent(),label:await row.getAttribute('aria-label')});
  assert.match(await row.textContent(),/E4 B3 G3 D3 A2 E2/);
  assert.equal(await page.locator('.track-settings .track-tuning-row').locator('select,input[type=text]').count(),0,'the sidebar row has no select or text field');
  const actions=await page.locator('.track-actions button').evaluateAll(list=>list.map(b=>({label:b.getAttribute('aria-label'),title:b.getAttribute('title'),w:Math.round(b.getBoundingClientRect().width),h:Math.round(b.getBoundingClientRect().height)})));
  assert.deepEqual(actions.map(a=>a.label),['Move track up','Move track down','Duplicate track','Remove track']);
  note('four track actions are one row of named icon buttons',actions);
  report.trackTab=await panelHeights();
  await page.screenshot({path:resolve(shots,'after-track-tab.png')});

  // The sidebar at its narrowest and widest: nothing covered, nothing overflowing.
  const handle=page.getByRole('separator',{name:'Resize inspector'});
  for(const [label,key] of [['narrowest','Home'],['widest','End']]){
    await handle.focus();for(let i=0;i<40;i++)await page.keyboard.press(key==='Home'?'ArrowRight':'ArrowLeft');
    await sleep(200);const result=await uncovered('.track-settings');report[label]={...await panelHeights(),...result};
    assert.deepEqual(result.bad,[],`${label}: no control is covered`);assert.equal(result.horizontalOverflow,false,`${label}: no horizontal overflow`);
    await page.screenshot({path:resolve(shots,`after-track-tab-${label}.png`)});
  }
  note('narrowest and widest sidebar: no covered control, no overflow',{narrowest:report.narrowest,widest:report.widest});

  // Cancel: a real click on the button, a change, Cancel. Nothing recorded, focus back on the button.
  const base=await session.edits();
  await row.click();const dialog=page.getByRole('dialog',{name:'Tuning',exact:true});await dialog.waitFor();
  assert.equal((await focused()).inDialog,true,'focus moved into the dialog');
  await dialog.getByRole('button',{name:'Lower string 6 a semitone'}).click();
  assert.equal(await dialog.getByLabel('Notes, high to low').inputValue(),'E4 B3 G3 D3 A2 D#2');
  assert.equal((await session.edits()).length,base.length,'a step records nothing');
  assert.equal(await row.textContent().then(text=>/E4 B3 G3 D3 A2 E2/.test(text)),true,'the sidebar still shows the saved tuning');
  const inDialog=await uncovered('.tuning-dialog');report.dialog={...inDialog};assert.deepEqual(inDialog.bad,[],'dialog: no control covered');assert.equal(inDialog.horizontalOverflow,false);
  await page.screenshot({path:resolve(shots,'after-tuning-dialog.png')});
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal((await session.edits()).length,base.length,'Cancel records nothing');
  assert.equal((await focused()).label.includes('Edit tuning'),true,`focus returns to the Edit button, got ${JSON.stringify(await focused())}`);
  note('Cancel discards and returns focus to the button',await focused());

  // Escape discards too, and picking a preset from the Library selects only fills the draft.
  await row.click();await dialog.waitFor();
  await dialog.getByLabel('Instrument',{exact:true}).selectOption('guitar');await dialog.getByLabel('Number of strings').selectOption('6');await dialog.getByLabel('Preset',{exact:true}).selectOption('guitar-6-drop-d');
  assert.equal(await dialog.getByLabel('Notes, high to low').inputValue(),'E4 B3 G3 D3 A2 D2');assert.equal((await session.edits()).length,base.length,'a preset fills the draft only');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal((await session.edits()).length,base.length,'Escape records nothing');assert.equal((await focused()).label.includes('Edit tuning'),true,'Escape returns focus');
  note('Escape discards and returns focus',await focused());

  // Apply: exactly one edit, and Undo restores the track.
  await row.click();await dialog.waitFor();
  await dialog.getByLabel('Preset',{exact:true}).selectOption('guitar-6-drop-d');await dialog.getByRole('button',{name:'Keep fingering',exact:true}).click();await dialog.waitFor({state:'hidden'});await settle(page);
  const after=await session.edits();assert.equal(after.length,base.length+1,'one edit');
  assert.deepEqual(after.at(-1),{type:'setTuning',track:after.at(-1).track,tuning:[64,59,55,50,45,38],tuningName:'Drop D'});
  assert.match(await row.textContent(),/E4 B3 G3 D3 A2 D2/);assert.equal((await focused()).label.includes('Edit tuning'),true,'focus returns after Apply');
  note('Keep fingering records one setTuning',after.at(-1));
  // Applying the current tuning again records nothing.
  await row.click();await dialog.waitFor();await dialog.getByRole('button',{name:'Keep fingering',exact:true}).click();await dialog.waitFor({state:'hidden'});await settle(page);
  assert.equal((await session.edits()).length,base.length+1,'an unchanged tuning records nothing');
  await clickWorkstationButton(page,'Undo');await settle(page);
  assert.equal((await tuningEdits()).length,(base.filter(edit=>edit.type==='setTuning'||edit.type==='setStringCount')).length,'Undo takes the tuning edit back');
  assert.match(await row.textContent(),/E4 B3 G3 D3 A2 E2/);
  note('Undo restores the tuning',await row.textContent());

  // Keep pitch.
  await row.click();await dialog.waitFor();await dialog.getByRole('button',{name:'Lower string 6 a semitone'}).click();await dialog.getByRole('button',{name:'Keep pitch',exact:true}).click();await dialog.waitFor({state:'hidden'});await settle(page);
  const kept=(await session.edits()).at(-1);assert.equal(kept.keepPitch,true);note('Keep pitch sends keepPitch',kept);
  await clickWorkstationButton(page,'Undo');await settle(page);

  // Saved tunings opens over the dialog; Escape closes only it.
  await row.click();await dialog.waitFor();await dialog.getByRole('button',{name:'Saved tunings…'}).click();
  const saved=page.getByRole('dialog',{name:'Saved tunings',exact:true});await saved.waitFor();await page.keyboard.press('Escape');await saved.waitFor({state:'hidden'});
  assert.equal(await dialog.isVisible(),true,'Escape closed only the saved tunings dialog');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  note('Saved tunings nests: Escape closes only the top dialog',{});

  // Add instrument uses the same row and dialog: Use tuning fills the draft for the new track and records nothing.
  await page.locator('details.track-add>summary').click();
  const newRow=page.getByRole('button',{name:/^Edit new track tuning/});await newRow.click();await dialog.waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Keep fingering'}).count(),0,'a new track has no fingering to keep');
  await dialog.getByLabel('Instrument',{exact:true}).selectOption('bass');await dialog.getByLabel('Number of strings').selectOption('5');await dialog.getByLabel('Preset',{exact:true}).selectOption('bass-5-standard-b');
  await dialog.getByRole('button',{name:'Use tuning',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.match(await newRow.textContent(),/G2 D2 A1 E1 B0/);assert.equal((await session.edits()).length,base.length,'Use tuning records nothing');
  assert.equal((await focused()).label.includes('Edit new track tuning'),true,'focus returns to the new-track row');
  const added=await uncovered('.track-settings');assert.deepEqual(added.bad,[],'Add instrument: no control covered');
  await page.screenshot({path:resolve(shots,'after-add-instrument.png')});
  note('Add instrument uses the same dialog in draft mode',{row:await newRow.textContent()});

  // The play button plays the saved tuning without recording anything.
  const before=(await session.edits()).length;await page.locator('.track-settings .track-tuning-play').first().click();await sleep(300);assert.equal((await session.edits()).length,before);
  note('the sidebar play button records nothing',{});
  // The row and the dialog in every language at the narrowest and widest sidebar: nothing covered, nothing overflowing or clipped,
  // the selects not squeezed, the footer inside the dialog, and the step buttons big enough to hit.
  report.languages={};
  for(const language of ['de','et','en']){
    await page.evaluate(value=>window.localStorage.setItem('tabplayer.language',value),language);await page.reload();await page.locator('.app-shell').waitFor();await settle(page,500);
    assert.equal(await page.locator('.app-shell').getAttribute('lang'),language,'the shell names its language');
    await page.locator('[data-inspector-tab="track"]').click();await settle(page,300);
    report.languages[language]={};
    for(const [label,key] of [['narrowest','ArrowRight'],['widest','ArrowLeft']]){
      await page.locator('.inspector-resize').focus();for(let i=0;i<40;i++)await page.keyboard.press(key);await sleep(200);
      const sidebar=await uncovered('.track-settings');
      const rowFit=await page.evaluate(()=>{const b=document.querySelector('.track-settings .track-tuning-button'),t=b.querySelector('.track-tuning-notes'),r=b.getBoundingClientRect();return {rowHeight:Math.round(r.height),notesTruncated:t.scrollWidth>t.clientWidth,oneLine:t.getBoundingClientRect().height<=22,width:Math.round(r.width)};});
      assert.deepEqual(sidebar.bad,[],`${language} ${label}: sidebar row not covered`);assert.equal(sidebar.horizontalOverflow,false,`${language} ${label}: sidebar has no horizontal overflow`);assert.equal(rowFit.oneLine,true,`${language} ${label}: the tuning row stays one line`);
      await editButton().click();const tdlg=page.locator('.tuning-dialog');await tdlg.waitFor();
      const fit=await page.evaluate(()=>{
        const d=document.querySelector('.tuning-dialog'),dr=d.getBoundingClientRect();
        const outside=[...d.querySelectorAll('button,input,select')].filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&(r.left<dr.left-0.5||r.right>dr.right+0.5);}).map(n=>n.getAttribute('aria-label')||n.textContent.trim().slice(0,24));
        const selects=[...d.querySelectorAll('.tuning-library select')].map(n=>Math.round(n.getBoundingClientRect().width));
        const clippedLabels=[...d.querySelectorAll('.tp-dialog-foot button,.tuning-dialog-label')].filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.textContent.trim());
        const steps=[...d.querySelectorAll('.tuning-string-step')].map(n=>{const r=n.getBoundingClientRect();return Math.round(Math.min(r.width,r.height));});
        const foot=d.querySelector('.tp-dialog-foot').getBoundingClientRect();
        return {dialogWidth:Math.round(dr.width),outside,selects,clippedLabels,minStep:Math.min(...steps),footerInside:foot.left>=dr.left-0.5&&foot.right<=dr.right+0.5,scrollOverflow:d.scrollWidth>d.clientWidth+1||d.querySelector('.tp-dialog-body').scrollWidth>d.querySelector('.tp-dialog-body').clientWidth+1};
      });
      const covered=await uncovered('.tuning-dialog');
      assert.deepEqual(covered.bad,[],`${language} ${label}: dialog not covered`);assert.equal(covered.horizontalOverflow,false);
      assert.deepEqual(fit.outside,[],`${language} ${label}: every dialog control is inside the dialog`);assert.deepEqual(fit.clippedLabels,[],`${language} ${label}: no clipped button or label`);
      assert.equal(fit.scrollOverflow,false,`${language} ${label}: the dialog does not scroll sideways`);assert.equal(fit.footerInside,true);
      {const [instrumentWidth,countWidth,presetWidth]=fit.selects;assert.ok(instrumentWidth>=100&&countWidth>=70&&presetWidth>=150,`${language} ${label}: Library selects are ${fit.selects.join(', ')} px wide (instrument, strings, preset)`);}
      assert.ok(fit.minStep>=24,`${language} ${label}: step buttons are ${fit.minStep}px`);
      report.languages[language][label]={rowFit,fit};
      await page.screenshot({path:resolve(shots,`dialog-${language}-${label}.png`)});
      await page.keyboard.press('Escape');await tdlg.waitFor({state:'hidden'});
    }
  }
  note('en, et and de at the narrowest and widest sidebar: the row and dialog fit, selects stay readable, step buttons are at least 24 px',report.languages);

  console.log(JSON.stringify(report,null,1));
}finally{await session.close();}
