import {waitForWorkspaceIdle,closeWelcomeLibrary,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync,strFromU8 } from 'fflate';
import { directory,launch,connect,stop } from './harness.mjs';

const saved=resolve(directory,'gp8-notation.tabplayer'),exported=resolve(directory,'gp8-notation.gp');
const raw='[VERSE]\nHel-lo  world+today';
let id=launch({TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported,TABPLAYER_TEST_OPEN:saved}),browser,page;
const result={};
try {
  browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>readActiveDocument(page);
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.equal(await page.getByRole('alert').count(),0,await page.getByRole('alert').allTextContents());};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const change=(label,value)=>page.getByLabel(label,{exact:true}).fill(String(value));
  const details=label=>page.locator('summary').filter({hasText:label}).first().evaluate(node=>{node.parentElement.open=true;});
  for(let beat=1;beat<=4;beat++){await change('Beat',beat);await change('Fret',beat);await button('Set note');}
  await change('Beat',1);await details('Lyrics');await button('Add line');await change('Line 1 text',raw);await button('Apply lyrics');
  await details('Beat notation');await page.getByRole('combobox',{name:/^Stem direction/}).selectOption('inverted');await page.getByRole('checkbox',{name:'Show timer',exact:true}).check();await button('Apply beat gestures');
  await page.getByLabel('Range end beat',{exact:true}).fill('4');await page.getByRole('combobox',{name:/^Octave region/}).selectOption('1');await button('Apply octave region');
  await page.getByLabel('Range end beat',{exact:true}).fill('4');await page.getByRole('combobox',{name:/^Hairpin/}).selectOption('1');await page.getByRole('combobox',{name:/^Target dynamics/}).selectOption('7');await button('Apply hairpin');
  await page.getByRole('combobox',{name:/^Global fermata/}).selectOption('2');await change('Stored length','1.5');await button('Apply global fermata');
  await details('Bar gestures');await page.getByRole('combobox',{name:/^Clef octave/}).selectOption('1');await button('Apply clef octave');
  await page.getByLabel('Common / cut time',{exact:true}).check();await page.getByLabel('Double bar',{exact:true}).check();await button('Apply measure gestures');
  // GP keeps common/cut time as one score-wide style, so a mix of the two is written as the choice most bars make and warned about: give the other bars the same choice so every bar stays common.
  for(const measure of [2,3,4]){await change('Measure',measure);await page.getByLabel('Common / cut time',{exact:true}).check();await button('Apply measure gestures');}
  await page.locator('.inspector').evaluate(node=>{node.scrollTop=0;});await page.screenshot({path:resolve('.analysis/parity/native-notation.png')});
  await change('Measure',2);await details('Bar gestures');await page.getByRole('combobox',{name:/^Simile/}).selectOption('single');await button('Apply simile');
  await button('Save');await button('Export GP');
  const xml=strFromU8(unzipSync(readFileSync(exported))['Content/score.gpif']);
  const exportedFields=await page.evaluate(xml=>{
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    return {error:!!doc.querySelector('parsererror'),raw:doc.querySelector('Tracks > Track > Lyrics > Line > Text')?.textContent,visible:doc.querySelector('Tracks > Track > Lyrics')?.getAttribute('dispatched'),inverted:doc.querySelector('Beats > Beat > XProperties > XProperty[id="1124204545"] > Int')?.textContent,fermata:doc.querySelector('MasterBars > MasterBar > Fermatas > Fermata > Length')?.textContent};
  },xml);
  assert.deepEqual(exportedFields,{error:false,raw,visible:'true',inverted:'1',fermata:'1.5'});result.visibleGp=exportedFields;
  await details('Lyrics');await page.getByLabel('Visible',{exact:true}).uncheck();await button('Apply lyrics');await button('Undo');
  assert.equal((await snapshot()).redoEdit.visible,false);await button('Redo');await button('Save');await button('Export GP');
  await clickWorkstationButton(page,'Export score',{waitForIdle:false});await page.getByRole('dialog',{name:'Export score'}).getByRole('button',{name:'Export',exact:true}).click();
  await page.getByRole('dialog',{name:'Export score'}).waitFor({state:'hidden'});await idle();
  const hiddenXml=strFromU8(unzipSync(readFileSync(exported))['Content/score.gpif']);assert.match(hiddenXml,/<Lyrics dispatched="false">/);
  assert.ok(hiddenXml.includes('[VERSE]'));result.dialogHiddenExport=true;
  const native=JSON.parse(readFileSync(saved,'utf8'));assert.equal(native.edits.at(-1).visible,false);result.commands=native.edits.length;
  assert.deepEqual(errors,[]);await browser.close();browser=null;stop(id);id=launch({TABPLAYER_TEST_OPEN:saved});
  browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);await button('Open');
  await details('Lyrics');assert.equal(await page.getByLabel('Visible',{exact:true}).isChecked(),false);assert.equal(await page.getByRole('textbox',{name:/^Line 1 text/}).inputValue(),raw);
  assert.equal((await snapshot()).project.edits.length,native.edits.length);result.processRestartReopen=true;result.hiddenRawPreserved=true;
  writeFileSync(resolve('.analysis/parity/native-notation-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page)await page.screenshot({path:resolve('.analysis/parity/native-notation-failure.png')});throw error;}
finally{if(browser)await browser.close();stop(id);}
