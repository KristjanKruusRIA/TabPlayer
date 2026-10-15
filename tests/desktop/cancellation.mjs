import { readActiveDocument,readDocumentRecord } from './document-context.mjs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { launch,connect,stop,directory } from './harness.mjs';
const processId=launch(),executable=resolve(directory,'tabplayer.exe');
let browser;const helpers=new Set();
function helper(script,args=[]) {
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-AppProcessId',String(processId),...args],{windowsHide:true,timeout:15000,killSignal:'SIGKILL'});
  helpers.add(child);child.on('close',()=>helpers.delete(child));
  let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
  const done=new Promise((accept,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?accept(output.trim()):reject(new Error(`Dialog helper failed (${code}): ${output}`)));});
  void done.catch(()=>{});return done;
}
function completion(promise,label) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} did not finish after dialog cancellation.`)),5000);})]).finally(()=>clearTimeout(timer));
}
try {
  browser=await connect();const page=browser.contexts()[0].pages()[0];
  await page.getByRole('button',{name:'New',exact:true}).waitFor();
  await page.getByLabel('Fret',{exact:true}).fill('7');await page.getByRole('button',{name:'Set note',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('nav[aria-label="File and history"] button')?.disabled);
  const workspace=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'));
  const before=await readActiveDocument(page),origin=await readDocumentRecord(page,workspace.active.documentId);
  assert.equal(before.dirty,true);
  // Diagnostic UI I/O uses fixed paths. These calls exercise the real production
  // native picker boundaries, whose Cancel result must leave the record intact.
  for(const label of ['Open','Save']) {
    const cancelled=helper('tests/desktop/cancel-dialog.ps1');
    const picker=page.evaluate(({label,documentId,revision})=>window.__TAURI_INTERNALS__.invoke(label==='Open'?'read_document':'save_project',label==='Open'?{}:{document:{documentId,revision},saveAs:true}),{label,documentId:origin.documentId,revision:origin.revision});
    void picker.catch(()=>{});
    const cancellation=await cancelled,result=await completion(picker,`${label} picker`);
    assert.equal(result,null);console.log(label,cancellation,'snapshot unchanged');
    assert.deepEqual(await readActiveDocument(page),before);
    assert.deepEqual(await readDocumentRecord(page,origin.documentId),origin);
    assert.deepEqual(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot')),workspace);
  }
  const cancelled=helper('tests/desktop/answer-unsaved-dialog.ps1',['-AppExecutable',executable,'-Decision','Cancel']);
  const close=page.getByRole('button',{name:'Close score',exact:true}).click();void close.catch(()=>{});
  await cancelled;await completion(close,'Close score');
  await page.waitForFunction(()=>!document.querySelector('nav[aria-label="File and history"] button')?.disabled);
  assert.deepEqual(await readActiveDocument(page),before);
  assert.deepEqual(await readDocumentRecord(page,origin.documentId),origin);
  assert.deepEqual(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot')),workspace);
  assert.ok(await page.locator('svg').count()>0);
  console.log('Close score Cancel preserves the dirty score, revision and active owner.');
} finally {
  for(const child of helpers)child.kill('SIGKILL');
  try{stop(processId);}finally{if(browser)await browser.close();}
}
