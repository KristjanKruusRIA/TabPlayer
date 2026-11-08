import {waitForWorkspaceIdle,clickWorkspaceCommand,closeWelcomeLibrary,revealInspectorTab} from './workstation-commands.mjs';
import { readActiveDocument,readDocumentRecord } from './document-context.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {directory,launch,connect,stop} from './harness.mjs';
const source=process.env.TABPLAYER_TEST_GP;
if(!source)throw new Error('Set TABPLAYER_TEST_GP to an authorized private score.');
const bytes=readFileSync(source),hash=createHash('sha256').update(bytes).digest('hex');
const run=Date.now();const saved=resolve(directory,`roundtrip-${run}.tabplayer`),exported=resolve(directory,`roundtrip-${run}.gp`);
const environment={TABPLAYER_TEST_OPEN:source,TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported};
let id=launch(environment);let browser=await connect();let page=browser.contexts()[0].pages()[0];
const snapshot=()=>readActiveDocument(page);
const idle=()=>waitForWorkspaceIdle(page);
try {
  await closeWelcomeLibrary(page);
  await clickWorkspaceCommand(page,'Open',{waitForIdle:false});await idle();
  assert.equal((await snapshot()).project.base.sha256,hash);await revealInspectorTab(page,'Selection');
  assert.equal((await snapshot()).project.base.bytesBase64,bytes.toString('base64'));
  if(await page.getByRole('button',{name:'Set note',exact:true}).isDisabled()){
    await page.getByRole('button',{name:'Insert beat',exact:true}).click();await idle();
  }
  await page.getByRole('combobox',{name:/^String/}).selectOption('2');await page.getByLabel('Fret',{exact:true}).fill('7');await page.getByRole('button',{name:'Set note',exact:true}).click();await idle();
  assert.equal((await snapshot()).dirty,true);
  const origin=(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'))).active;
  const {documentId,revision}=await readDocumentRecord(page,origin.documentId);
  const failed=await page.evaluate(async address=>{try{await window.__TAURI_INTERNALS__.invoke('desktop_test_io',{action:'save',...address});return false;}catch{return true;}},{documentId,revision,path:resolve(directory,'missing-directory/out.tabplayer')});
  assert.equal(failed,true);assert.equal((await snapshot()).dirty,true);
  await clickWorkspaceCommand(page,'Save',{waitForIdle:false});await idle();
  const before=await snapshot();assert.equal(before.dirty,false);assert.equal(JSON.parse(readFileSync(saved,'utf8')).base.bytesBase64,bytes.toString('base64'));
  await browser.close();stop(id);id=launch({...environment,TABPLAYER_TEST_OPEN:saved});browser=await connect();page=browser.contexts()[0].pages()[0];
  await closeWelcomeLibrary(page);
  await clickWorkspaceCommand(page,'Open',{waitForIdle:false});await idle();
  assert.deepEqual((await snapshot()).project,before.project);assert.equal((await snapshot()).dirty,false);
  await clickWorkspaceCommand(page,'Export GP',{waitForIdle:false});await idle();
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),hash);
  assert.equal(readFileSync(exported).subarray(0,2).toString(),'PK');
  await page.screenshot({path:resolve(directory,'roundtrip.png')});
  writeFileSync(resolve(directory,'roundtrip-result.json'),JSON.stringify({saved,exported,sourceHash:hash,edits:before.project.edits.length,sourcePreserved:true,nativeRestartReopen:true},null,2));
  console.log('Packaged native I/O hooks: GP open → edit → failed save → native save → process restart → reopen → GP export, source bytes unchanged.');
} finally {await browser.close();try{stop(id);}catch{}}
