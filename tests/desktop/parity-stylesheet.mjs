import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {directory,launch,connect,stop} from './harness.mjs';
import {assertExport,buildStylesheetFixtures,hash,viewPath} from './stylesheet-fixture.mjs';

// Run only with the rebuilt diagnostic executable in the existing harness.
// The root runner owns the shared application/CDP port and visual acceptance.
const prefix=`style-${Date.now()}`,fixtures=buildStylesheetFixtures(prefix);
const result={authored:true,originalGp8RuntimeAcceptance:false,fixtures:Object.fromEntries(Object.entries(fixtures).map(([name,value])=>[name,{path:value.path,sha256:value.sha256}])),screenshots:[],exports:[],failures:[]};
const mixed='GP export cannot represent mixed common/cut and numeric measure choices. Export a uniform measure range or use consistent choices.';
const inherited='GP export cannot resolve inherited common/cut choices for every selected measure. Set each selected 4/4 or 2/2 measure explicitly before exporting changed choices.';
const errors=[];
let id=null,browser=null,page=null,destination,saved,session=0;
const snapshot=()=>readActiveDocument(page);
const idle=()=>waitForWorkspaceIdle(page);
const noAlerts=async()=>assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);
async function button(name){await clickWorkstationButton(page,name,{waitForIdle:false});await idle();}
async function close(){
  const ownedBrowser=browser,ownedId=id;browser=null;page=null;
  try{if(ownedBrowser)await ownedBrowser.close();}
  finally{if(ownedId!==null){stop(ownedId);id=null;}}
}
async function open(path,label){
  await close();session++;
  destination=resolve(directory,`${prefix}-${session}-${label}-export.gp`);
  saved=resolve(directory,`${prefix}-${session}-${label}.tabplayer`);
  id=launch({TABPLAYER_TEST_OPEN:path,TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:destination});
  browser=await connect();page=browser.contexts()[0].pages()[0];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1600,height:1000});
  await waitForWorkspaceIdle(page);await button('Open');await noAlerts();
  await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  const source=readFileSync(path),state=await snapshot();
  if(!path.endsWith('.tabplayer')){assert.equal(state.project.base.sha256,hash(source));assert.equal(state.project.base.bytesBase64,source.toString('base64'));assert.deepEqual(state.project.edits,[]);}
}
async function gestures(measure){
  await button('Edit');await page.getByLabel('Measure',{exact:true}).fill(String(measure));
  const summary=page.getByRole('region',{name:'Edit tools'}).locator('summary').filter({hasText:/^Bar gestures$/});
  // Disclosure is navigated inside the approved Edit organization.
  if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();
  const checkbox=page.getByLabel('Common / cut time',{exact:true});await checkbox.waitFor({state:'visible'});return checkbox;
}
async function flags(expected){
  const before=await snapshot(),actual=[];
  for(let index=0;index<3;index++){
    const checkbox=await gestures(index+1);actual.push(await checkbox.isChecked());
    assert.equal(await checkbox.isDisabled(),index===2);
  }
  assert.deepEqual(actual,expected,'The inspector reflects the product model for 4/4, 2/2 and 3/4');
  assert.deepEqual(await snapshot(),before,'Inspecting imported model flags does not author history');
  return actual;
}
async function apply(measure,enabled){
  const before=await snapshot(),checkbox=await gestures(measure);await checkbox.setChecked(enabled);await button('Apply measure gestures');await noAlerts();
  const after=await snapshot();assert.equal(after.project.edits.length,before.project.edits.length+1);
  assert.deepEqual(after.project.edits.at(-1),{type:'setMasterBarGestures',bar:measure-1,commonTime:enabled,doubleBar:false,tripletFeel:0,beaming:null});
  assert.deepEqual(after.project.base,before.project.base);return after;
}
async function capture(label){
  await gestures(1);await page.locator('.inspector').evaluate(node=>{node.scrollTop=0;});
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  const path=resolve(directory,`${prefix}-${label}.png`);await page.screenshot({path});result.screenshots.push(path);
  // Retain vector output as supplemental rendering evidence, not glyph proof.
  writeFileSync(resolve(directory,`${prefix}-${label}.svg.html`),await page.locator('[aria-label="Music notation"]').innerHTML());
}
const dialog=()=>page.getByRole('dialog',{name:'Export score',exact:true});
async function startDialog(){
  await button('Export score');await dialog().waitFor();await dialog().getByRole('combobox',{name:'Export format',exact:true}).selectOption('gp');
  await dialog().getByText('Engraving settings affect the screen and PDF. GP export preserves source styling and supports uniform common/cut choices; mixed measure choices cannot be exported.',{exact:true}).waitFor();
}
async function exportValid(surface,fixture,expectation,label){
  const before=await snapshot();
  // Removing only this session's owned destination proves a new native write.
  if(existsSync(destination))rmSync(destination);
  if(surface==='direct')await button('Export GP');
  else {await startDialog();await dialog().getByRole('button',{name:'Export',exact:true}).click();await dialog().waitFor({state:'hidden',timeout:30000});await idle();}
  await noAlerts();assert.ok(existsSync(destination));const bytes=readFileSync(destination);assertExport(bytes,fixture,expectation);
  assert.deepEqual(await snapshot(),before,'GP export preserves the complete native project snapshot');
  const copy=resolve(directory,`${prefix}-${label}-${surface}.gp`);writeFileSync(copy,bytes);result.exports.push({path:copy,sha256:hash(bytes),surface,...expectation});return copy;
}
async function exportFailure(surface,message,label){
  const before=await snapshot();let existing;
  if(surface==='direct'){if(existsSync(destination))rmSync(destination);}
  else {existing=Buffer.from(`owned output sentinel: ${label}`);writeFileSync(destination,existing);}
  if(surface==='direct')await button('Export GP');
  else {await startDialog();await dialog().getByRole('button',{name:'Export',exact:true}).click();await idle();}
  const alert=surface==='dialog'?dialog().getByRole('alert'):page.getByRole('alert');
  await alert.first().waitFor();const messages=await alert.allTextContents();
  if(typeof message==='string')assert.ok(messages.includes(message),JSON.stringify(messages));
  else assert.match(messages.join('\n'),message);
  if(existing)assert.deepEqual(readFileSync(destination),existing,'Failed dialog export leaves the existing output byte-exact');
  else assert.equal(existsSync(destination),false,'Failed direct export does not create an output');
  assert.deepEqual(await snapshot(),before,'Rejected export preserves source, edits, dirty state and redo');
  result.failures.push({label,surface,messages,output:existing?'unchanged':'absent'});
  const path=resolve(directory,`${prefix}-${label}-${surface}-error.png`);await page.screenshot({path});result.screenshots.push(path);
  if(surface==='dialog'){await dialog().getByRole('button',{name:'Cancel',exact:true}).click();await dialog().waitFor({state:'hidden'});}
}
async function saveRestart(label){
  await button('Save');await noAlerts();const before=await snapshot(),path=saved,stored=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(before.dirty,false);assert.deepEqual(stored,before.project);const oldId=id;
  await open(path,label);assert.notEqual(id,oldId,'Full native process restart');assert.deepEqual((await snapshot()).project,before.project);assert.equal((await snapshot()).dirty,false);
  return before;
}
async function undo(count=1){for(let index=0;index<count;index++)await button('Undo');}

try{
  // Imported true: common C, cut C and numeric 3/4 require root visual review.
  await open(fixtures.true.path,'true');await flags([true,true,false]);await capture('import-true-common-cut-and-three-four');
  const trueDirect=await exportValid('direct',fixtures.true,{current:true,legacy:false},'true');
  const trueDialog=await exportValid('dialog',fixtures.true,{current:true,legacy:false},'true');
  await apply(1,false);await apply(2,false);await flags([false,false,false]);
  const stored=await saveRestart('native-replay');await flags([false,false,false]);await capture('native-replay-numeric');
  assert.deepEqual((await snapshot()).project.edits,stored.project.edits);
  await undo();await flags([false,true,false]);assert.deepEqual((await snapshot()).redoEdit,stored.project.edits[1]);
  await exportFailure('direct',mixed,'restart-mixed');await button('Redo');await flags([false,false,false]);
  const falseDirect=await exportValid('direct',fixtures.true,{current:false,legacy:false,changed:true},'false');
  const falseDialog=await exportValid('dialog',fixtures.true,{current:false,legacy:false,changed:true},'false');
  await undo(2);await flags([true,true,false]);await exportValid('direct',fixtures.true,{current:true,legacy:false},'undo-source-styles');
  await button('Redo');await button('Redo');assert.deepEqual((await snapshot()).project,stored.project);result.nativeSaveRestartUndoRedo=true;

  // Reopen each actual native-written file, including both UI export paths.
  for(const [name,path,expected]of [['true-direct',trueDirect,true],['true-dialog',trueDialog,true],['false-direct',falseDirect,false],['false-dialog',falseDialog,false]]){
    await open(path,`reopen-${name}`);await flags([expected,expected,false]);await capture(`reopen-${name}`);
  }
  await open(fixtures.false.path,'import-false');await flags([false,false,false]);await capture('import-false-numeric');
  await exportValid('direct',fixtures.false,{current:false,legacy:true},'false-source');
  await apply(1,true);await apply(2,true);await exportValid('dialog',fixtures.false,{current:true,legacy:true,changed:true},'false-source-edited-true');
  await open(fixtures['legacy-only'].path,'legacy-only');await flags([true,true,false]);
  await apply(1,false);await apply(2,false);await exportValid('direct',fixtures['legacy-only'],{current:null,legacy:false,changed:true},'legacy-only-false');

  // Both error surfaces must recover; the first blocks an absent output, the
  // second must preserve an existing sentinel. Each failure gets a valid export.
  await open(fixtures.true.path,'mixed');
  for(const surface of ['direct','dialog']){
    await apply(1,false);await exportFailure(surface,mixed,'mixed');await undo();
    await exportValid(surface,fixtures.true,{current:true,legacy:false},`mixed-recovered-${surface}`);
  }
  await open(fixtures.inherited.path,'inherited');await flags([false,false,false]);
  await exportValid('direct',fixtures.inherited,{current:null,legacy:true},'untouched-inherited');
  await apply(1,false);await saveRestart('inherited-equal-false');await flags([false,false,false]);
  await exportFailure('direct',inherited,'inherited-equal-false');await apply(2,false);
  await exportValid('direct',fixtures.inherited,{current:false,legacy:false,changed:true},'inherited-resolved');
  await undo();await exportFailure('dialog',inherited,'inherited-equal-false');await button('Redo');
  await exportValid('dialog',fixtures.inherited,{current:false,legacy:false,changed:true},'inherited-resolved');
  result.equalFalseIntentSurvivesNativeReplay=true;

  for(const name of ['views','malformed-view']){
    const fixture=fixtures[name];await open(fixture.path,name);await flags([true,true,false]);
    await exportValid('direct',fixture,{current:true,legacy:false},`${name}-untouched`);
    for(const surface of ['direct','dialog']){
      await apply(1,false);await apply(2,false);
      const expected=name==='views'?/conflicts with the changed full-score choice.*Content\/Stylesheets\/scoreview2\.gpss/:/Unsupported GP common\/cut stylesheet:/;
      await exportFailure(surface,expected,name);await undo(2);
      await exportValid(surface,fixture,{current:true,legacy:false},`${name}-recovered-${surface}`);
    }
    if(name==='views')result.untouchedConflictingViewPreserved=viewPath;
  }
  for(const fixture of Object.values(fixtures))assert.equal(hash(readFileSync(fixture.path)),fixture.sha256,'Every authored source remains byte-exact');
  assert.deepEqual(errors,[]);result.pageErrors=errors;result.visualAcceptance='Pending root inspection of common C, cut C, numeric 4/4, 2/2 and 3/4 screenshots.';
  writeFileSync(resolve(directory,`${prefix}-result.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){
  if(page)await page.screenshot({path:resolve(directory,`${prefix}-failure.png`)}).catch(()=>{});
  throw error;
}finally{await close();}
