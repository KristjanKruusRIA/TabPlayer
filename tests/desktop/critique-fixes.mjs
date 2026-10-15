import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {launch,connect,stop,directory} from './harness.mjs';

const output=resolve(directory,'critique-fixes'),fixture=resolve(directory,'engraving-fixture.gp');
mkdirSync(output,{recursive:true});
const hash=()=>createHash('sha256').update(readFileSync(fixture)).digest('hex');
const result={sourceHash:hash(),states:[],errors:[]};
let pid,browser,page;
const save=()=>writeFileSync(resolve(output,'validation.json'),JSON.stringify(result,null,2));
try{
  pid=launch({TABPLAYER_TEST_OPEN:fixture});result.pid=pid;save();browser=await connect();page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(10000);
  page.on('pageerror',error=>result.errors.push(error.message));
  const idle=()=>page.waitForFunction(()=>!document.querySelector('.toolbar nav button')?.disabled);
  const click=async name=>{await page.getByRole('button',{name,exact:true}).click();await idle();};
  const summary=async name=>{const node=page.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first();if(!(await node.evaluate(element=>element.parentElement.open)))await node.click();};
  const snapshot=async name=>{
    await page.waitForTimeout(150);const path=resolve(output,`${name}.png`);await page.screenshot({path});
    const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,regions:Object.fromEntries(['.paper-scroll','.live-instrument-view','.instrument-view','.inspector','.score-tools'].map(selector=>{const element=document.querySelector(selector);return [selector,element?{height:element.clientHeight,width:element.clientWidth,scrollHeight:element.scrollHeight,scrollWidth:element.scrollWidth,overflowY:getComputedStyle(element).overflowY}:null];})),focus:{tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.slice(0,80)}}));
    assert.ok(layout.documentWidth<=layout.width,`Document overflow at ${name}`);result.states.push({name,path,layout});save();
  };
  await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:'Open',exact:true}).waitFor();await idle();
  await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent?.startsWith('New score'));
  await snapshot('new-1280');
  const workspace=page.getByRole('region',{name:'Score workspace'}),editTask=page.locator('.inspector-task[id$="-edit"]');
  await click('Select bar');await workspace.focus();await page.keyboard.press('Control+c');await page.getByLabel('Paste repetitions').waitFor({state:'attached'});
  await editTask.locator(':scope>summary').click();assert.equal(await editTask.evaluate(element=>element.open),false);
  await workspace.focus();await page.keyboard.press('Control+Shift+v');
  await page.waitForFunction(()=>document.querySelector('.inspector-task[id$="-edit"]')?.open&&document.activeElement?.textContent==='Musical clipboard');
  result.clipboardReveal=true;await click('Open');await page.waitForFunction(()=>document.querySelector('.document-title')?.textContent?.includes('engraving'));
  assert.ok((await page.locator('.statusbar').innerText()).startsWith('Not saved'),'Imported score must not claim to be saved or new');
  await page.getByRole('img',{name:'Edit target',exact:true}).waitFor();await page.waitForTimeout(250);
  result.initial=await readActiveDocument(page);
  const caret=page.getByRole('img',{name:'Edit target',exact:true});
  const oldCaret=await caret.boundingBox();await workspace.focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('.score-hint')?.textContent?.includes('Beat 2'));
  await page.waitForFunction(before=>{const box=document.querySelector('.score-edit-target')?.getBoundingClientRect();return box&&(Math.abs(box.x-before.x)>.1||Math.abs(box.y-before.y)>.1);},oldCaret);
  result.caret={before:oldCaret,after:await caret.boundingBox(),announcement:await page.locator('.score-edit-announcement').innerText()};await snapshot('caret-beat-2');
  await page.keyboard.press('ArrowLeft');await click('Show instrument');
  for(const width of [960,1280,1600]){
    await page.setViewportSize({width,height:900});await snapshot(`compact-${width}`);
    assert.ok((await page.locator('.score-tools').boundingBox()).height<=120,'Score toolbar must stay compact');
    const artwork=await page.getByRole('img',{name:'Guitar fretboard'}).boundingBox(),canvas=await page.locator('.instrument-canvas').boundingBox();
    assert.ok(artwork&&canvas&&artwork.width<=canvas.width+.5,'Fretted artwork must fit available width');
  }
  await page.setViewportSize({width:1280,height:900});await click('Expand instrument view');await snapshot('expanded-1280');await click('Compact instrument view');
  for(const [track,name] of [['Track 3: Drums','drums-1280'],['Track 2: Grand Piano','keys-1280']]){
    await click(track);await snapshot(name);
    assert.doesNotMatch(await page.locator('.score-edit-announcement').innerText(),/string/i,'Piano and drums must omit string context');
    if(await page.locator('.score-edit-entry').count())assert.doesNotMatch(await page.locator('.score-edit-entry').innerText(),/string/i);
  }
  await click('Track 1: Guitar6');await click('Hide instrument');
  const tuning=page.getByLabel('Tuning (notes, high to low)',{exact:true});await tuning.fill('E4 WHAT');await click('Apply tuning');
  assert.equal(await tuning.getAttribute('aria-invalid'),'true');assert.ok(await tuning.evaluate(element=>element===document.activeElement));
  const tuningError=page.getByRole('alert').filter({hasText:'WHAT'});await tuningError.waitFor();const errorBox=await tuningError.boundingBox();assert.ok(errorBox&&errorBox.y>=0&&errorBox.y+errorBox.height<=900,'Tuning error must be visible');
  await snapshot('tuning-error-1280');await tuning.fill('E4 B3 G3 D3 A2 E2');
  await click('Practice');await summary('Practice settings');await page.getByLabel('Relative speed (%)').fill('123');await click('Presentation');await summary('Page layout');
  await page.getByLabel('Width (mm)',{exact:true}).fill('250');await snapshot('presentation-1280');await click('Edit');await click('Practice');assert.equal(await page.getByLabel('Relative speed (%)').inputValue(),'123');
  await click('Presentation');assert.equal(await page.getByLabel('Width (mm)',{exact:true}).inputValue(),'250');await click('Edit');
  await click('Edit chord diagram');const harmony=page.getByRole('dialog',{name:'Harmony chord',exact:true});await harmony.waitFor();
  await harmony.getByRole('button',{name:'Generate shapes',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.harmony-body fieldset')?.disabled);
  const nameInput=await harmony.getByLabel('Chord name',{exact:true}).elementHandle();await page.waitForFunction(input=>input===document.activeElement,nameInput);
  result.harmonyInitial=await harmony.evaluate(element=>({bodyScroll:element.querySelector('.harmony-body')?.scrollTop,focus:document.activeElement?.closest('label')?.textContent??document.activeElement?.tagName}));
  assert.ok(result.harmonyInitial.bodyScroll<10,'Harmony must open at the beginning');await snapshot('harmony-initial-1280');await click('Generate shapes');
  const candidates=harmony.getByRole('button',{name:/^Use shape /});assert.ok(await candidates.count()>1);await candidates.nth(1).click();assert.equal(await candidates.nth(1).getAttribute('aria-pressed'),'true');
  for(const width of [960,1600]){await page.setViewportSize({width,height:900});await snapshot(`harmony-shapes-${width}`);const apply=await harmony.getByRole('button',{name:'Apply chord',exact:true}).boundingBox();assert.ok(apply&&apply.y>=0&&apply.y+apply.height<=900,'Harmony Apply must stay visible');}
  await page.keyboard.press('Escape');assert.equal(await harmony.count(),0);await page.setViewportSize({width:1280,height:900});
  const help=page.locator('.keyboard-help');await help.locator('summary').click();await snapshot('help-1280');await page.keyboard.press('Escape');assert.equal(await help.getAttribute('open'),null);
  await click('Export score');const exports=page.getByRole('dialog',{name:'Export score',exact:true});await snapshot('export-gp-1280');
  const checks=await exports.locator('.export-check').evaluateAll(labels=>labels.map(label=>{const input=label.querySelector('input'),box=label.getBoundingClientRect(),check=input.getBoundingClientRect();return {label:label.textContent.trim(),inputWidth:check.width,verticalDifference:Math.abs((check.y+check.height/2)-(box.y+box.height/2))};}));
  assert.ok(checks.every(check=>check.inputWidth<30&&check.verticalDifference<3));result.exportChecks=checks;
  await exports.getByRole('combobox',{name:'Export format'}).selectOption('wav');await snapshot('export-audio-1280');
  await exports.getByRole('combobox',{name:'Export format'}).selectOption('gp');await exports.locator('.export-track>label input').evaluateAll(nodes=>nodes.forEach(node=>{if(node.checked)node.click();}));
  await exports.getByRole('button',{name:'Export',exact:true}).click();assert.equal(await exports.getByRole('alert').innerText(),'Select at least one track to export.');await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('.transport fieldset')?.disabled,{},{timeout:60000});await workspace.focus();await page.keyboard.press('Space');await page.getByRole('button',{name:'Pause',exact:true}).waitFor();await page.keyboard.press('Space');await page.getByRole('button',{name:'Play',exact:true}).waitFor();await click('Stop');
  result.final=await readActiveDocument(page);assert.deepEqual(result.final.project,result.initial.project);assert.equal(hash(),result.sourceHash);assert.deepEqual(result.errors,[]);
  result.passed=true;save();console.log(JSON.stringify({passed:true,states:result.states.map(state=>state.name),sourceHash:result.sourceHash,pid}));
}catch(error){result.failure=String(error.stack??error);if(page)await page.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});save();throw error;}
finally{if(browser)await browser.close();if(pid){stop(pid);result.stoppedPid=pid;save();console.log(`STOPPED ${pid}`);}}
