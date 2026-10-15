import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {createServer} from 'node:net';
import {basename,isAbsolute,resolve} from 'node:path';
import {chromium} from 'playwright';
import {readDocumentRecord} from './document-context.mjs';
import {clickWorkspaceCommand,clickWorkstationButton,revealInspector,waitForWorkspaceIdle} from './workstation-commands.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const helperHashes={
  'tests/desktop/answer-unsaved-dialog.ps1':'436b5b19827837bc79756398ab159dc1892fb915215652f787e6121e5c5e4ef0',
  'tests/desktop/cancel-dialog.ps1':'d85abd4537782dd09b36fe1cc0918e3e5357621de4cdb5dfae0dd3b61ab0231d',
};
const ownedCheck='$p=Get-Process -Id $env:PRODUCTION_RECOVERY_PID -ErrorAction SilentlyContinue; if($null -ne $p){if(-not [string]::Equals($p.Path,$env:PRODUCTION_RECOVERY_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:PRODUCTION_RECOVERY_START){throw "Captured production process identity changed"}};';

// Inert on import. Root supplies its separately identified production build.
// This driver writes no native files and never enables diagnostic routing.
export async function runProductionRecoveryAcceptance({executable,nativeDirectory,identifier}={}){
  assert.equal(typeof identifier,'string','Supply the isolated production identifier');
  assert.match(identifier,/^dev\.tabplayer\.recovery-validation\.[a-z0-9][a-z0-9.-]{5,}$/,'Use a unique isolated validation identifier');
  assert.ok(typeof executable==='string'&&isAbsolute(executable),'Executable must be absolute');
  assert.ok(typeof nativeDirectory==='string'&&isAbsolute(nativeDirectory),'Production native directory must be absolute');
  executable=realpathSync(executable);nativeDirectory=resolve(nativeDirectory);
  assert.equal(basename(executable).toLowerCase(),'tabplayer.exe');assert.ok(statSync(executable).isFile());
  assert.equal(basename(nativeDirectory).toLowerCase(),identifier,'Production app-data directory must belong to the isolated identifier');
  assert.equal(process.platform,'win32','WM_CLOSE/native dialogs are Windows-specific');
  const manifestPath=resolve(nativeDirectory,'recovery-v1/manifest.json');assert.equal(existsSync(manifestPath),false,'Use a fresh identifier; preserve existing production recovery');
  for(const [path,hash]of Object.entries(helperHashes))assert.equal(digest(readFileSync(path)),hash,`Frozen owned-dialog helper changed: ${path}`);
  const result={identifier,executable,executableSha256:digest(readFileSync(executable)),nativeDirectory,helperHashes,history:[],limits:['Actual production WM_CLOSE and dialog acceptance only when root executes this driver.','Native directory is observed read-only; no test-directory override, test IPC, controller interception, recovery injection, restart, or artifact cleanup.','A future fresh startup replacement blank is separate from the final empty Clean envelope.']};
  const recordStep=(name,value)=>{result.history.push({name,atUnixMs:Date.now(),value});return value;};
  const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>{const key=name.toUpperCase();return !key.startsWith('TABPLAYER_TEST_')&&!['TABPLAYER_DESKTOP_TEST','VITE_DESKTOP_TEST','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','WEBVIEW2_USER_DATA_FOLDER'].includes(key);}));
  let identity=null,browser=null,page=null,naturalExit=false;const errors=[];
  function ps(command){return execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...environment,PRODUCTION_RECOVERY_EXE:executable,PRODUCTION_RECOVERY_PID:identity?String(identity.pid):'',PRODUCTION_RECOVERY_START:identity?.startTicks??'',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223'}}).trim();}
  function inspect(){assert.ok(identity);return JSON.parse(ps(`${ownedCheck} if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));}
  function owned(){const current=inspect();assert.ok(current,'Captured production process must still be live');return current;}
  function closeWindow(){owned();const receipt=ps(`${ownedCheck} if($null -eq $p){throw 'Owned process exited before WM_CLOSE'}; if(-not $p.CloseMainWindow()){throw 'Owned main window rejected WM_CLOSE'}; 'Owned WM_CLOSE requested'`);return recordStep('WM_CLOSE',{identity,receipt});}
  function dialog(path,decision){owned();const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',path,'-AppProcessId',String(identity.pid),'-AppExecutable',executable,'-AppStartTicks',identity.startTicks];if(decision)args.push('-Decision',decision);const receipt=execFileSync('powershell.exe',args,{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim();return recordStep(decision?`Unsaved score: ${decision}`:'Native Save picker: Cancel',{identity,receipt});}
  async function workspace(){return page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'));}
  async function snapshot(){const value=await workspace();for(const document of value.documents)assert.deepEqual(await readDocumentRecord(page,document.documentId),document);return value;}
  const idle=()=>waitForWorkspaceIdle(page,{timeout:25000});
  async function button(name){await clickWorkstationButton(page,name,{waitForIdle:false});await idle();}
  async function activate(documentId){await page.locator(`[id=${JSON.stringify(`document-tab-${encodeURIComponent(documentId)}`)}]`).click();await idle();assert.equal((await workspace()).active.documentId,documentId);}
  function checkpoint(){
    const manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes);assert.equal(manifest.format,'TabPlayerRecoveryManifest');assert.equal(manifest.version,1);assert.ok(Number.isSafeInteger(manifest.epoch)&&manifest.epoch>0);assert.ok(Number.isSafeInteger(manifest.current.generation)&&manifest.current.generation>0);assert.match(manifest.current.sha256,/^[a-f0-9]{64}$/);
    const path=resolve(nativeDirectory,`recovery-v1/checkpoint-${manifest.current.generation}.json`),bytes=readFileSync(path);assert.equal(digest(bytes),manifest.current.sha256);const envelope=JSON.parse(bytes);assert.equal(envelope.format,'TabPlayerRecovery');assert.equal(envelope.version,1);assert.equal(envelope.epoch,manifest.epoch);assert.equal(envelope.generation,manifest.current.generation);assert.equal(digest(readFileSync(manifestPath)),digest(manifestBytes),'Observe one stable atomic manifest');
    return {manifest,manifestSha256:digest(manifestBytes),path,payloadSha256:digest(bytes),envelope};
  }
  const target={track:0,staff:0,bar:0,voice:0,beat:0};
  const command=fret=>({type:'setNote',target:{...target},string:6,fret});
  function assertRunning(value,live,histories){
    assert.equal(value.manifest.lifecycle,'running');assert.deepEqual(value.envelope.documents.map(document=>document.documentId),live.documents.map(document=>document.documentId));assert.equal(value.envelope.activeDocumentId,live.active.documentId);
    for(const [index,document]of value.envelope.documents.entries()){
      const actual=live.documents[index],history=histories[index];assert.equal(document.revision,actual.revision);assert.equal(document.importedPath,null);assert.equal(document.savedFileSha256,null);assert.equal(document.session.path,null);assert.deepEqual(document.session.saved,[]);assert.equal(document.session.cursor,1);assert.deepEqual(document.session.project.edits,history);assert.deepEqual(document.session.project.edits.slice(0,1),actual.snapshot.project.edits);assert.deepEqual(actual.snapshot.redoEdit,history[1]);assert.equal(actual.snapshot.dirty,true);assert.equal(actual.snapshot.canUndo,true);assert.equal(actual.snapshot.canRedo,true);
    }
  }
  async function acknowledged(live,histories){
    const deadline=Date.now()+45000;let last;
    do{try{const value=checkpoint();assertRunning(value,live,histories);await page.getByRole('status').filter({hasText:/Recovery backup complete\./}).waitFor({state:'visible',timeout:500});return recordStep('Acknowledged Running full branches',value);}catch(error){last=String(error);}await wait(50);}while(Date.now()<deadline);
    throw new Error(`Full Running backup not acknowledged: ${last}`);
  }
  async function unchanged(label,before,backup){
    owned();await idle();const live=await snapshot();assert.deepEqual(live,before,'Cancel preserves every tab, exact revision, live history and active owner');assert.equal(await page.getByRole('tab').count(),2);const disk=checkpoint();assert.equal(disk.manifest.lifecycle,'running');assert.equal(disk.manifestSha256,backup.manifestSha256,'Cancelled close cannot acknowledge a Clean/new-epoch replacement');assert.deepEqual(disk.manifest,backup.manifest);recordStep(label,{identity,live,checkpoint:disk});
  }
  async function editPair(first,second){
    await revealInspector(page);await button('Edit');await page.getByRole('combobox',{name:'String',exact:true}).selectOption('6');
    for(const fret of [first,second]){await page.getByLabel('Fret',{exact:true}).fill(String(fret));await button('Set note');}
    await button('Undo');const live=await snapshot(),active=live.documents.find(document=>document.documentId===live.active.documentId);assert.deepEqual(active.snapshot.project.edits,[command(first)]);assert.deepEqual(active.snapshot.redoEdit,command(second));assert.equal(active.snapshot.dirty,true);return active;
  }
  try{
    // Bind/close locally before launching: refuse to attach to somebody else's
    // already occupied CDP port. Root serializes the later launch/attachment.
    await new Promise((accept,reject)=>{const server=createServer();server.once('error',reject);server.listen(9223,'127.0.0.1',()=>server.close(error=>error?reject(error):accept()));});
    identity=JSON.parse(ps('$p=Start-Process -FilePath $env:PRODUCTION_RECOVERY_EXE -WindowStyle Hidden -PassThru; @{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress'));assert.ok(Number.isSafeInteger(identity.pid)&&identity.pid>0);assert.match(identity.startTicks,/^[1-9][0-9]+$/);assert.equal(identity.path.toLowerCase(),executable.toLowerCase());owned();recordStep('Owned production launch',identity);
    for(let attempt=0;attempt<150;attempt++){owned();try{browser=await chromium.connectOverCDP('http://127.0.0.1:9223');break;}catch{await wait(100);}}assert.ok(browser,'Owned production WebView did not expose CDP');page=browser.contexts()[0].pages()[0];assert.ok(page);page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1280,height:900});await idle();
    const initial=await snapshot();assert.equal(initial.documents.length,1);assert.equal(initial.documents[0].snapshot.project.base.kind,'blank');assert.equal(initial.documents[0].snapshot.path,null);assert.deepEqual(initial.documents[0].snapshot.project.edits,[]);recordStep('Fresh startup blank (first new score)',initial);
    const file=page.locator('summary').filter({hasText:/^File$/});await file.click();const preference=page.getByRole('checkbox',{name:'Restore previous session',exact:true});await preference.check();await page.waitForFunction(()=>{const input=Array.from(document.querySelectorAll('input[type="checkbox"]')).find(node=>node.parentElement?.textContent?.includes('Restore previous session'));return input?.checked===true&&!input.disabled;});await file.press('Escape');recordStep('Real File restore preference enabled',true);
    const A=await editPair(5,7);await clickWorkspaceCommand(page,'New');await idle();const B=await editPair(9,11),histories=[[command(5),command(7)],[command(9),command(11)]];assert.notEqual(A.documentId,B.documentId);
    const before=recordStep('Two dirty new tabs with redo',await snapshot());assert.deepEqual(before.documents.map(document=>document.documentId),[A.documentId,B.documentId]);const backup=await acknowledged(before,histories);
    closeWindow();dialog('tests/desktop/answer-unsaved-dialog.ps1','Save');dialog('tests/desktop/cancel-dialog.ps1');await unchanged('WM_CLOSE → Save → actual native picker Cancel preserved Running',before,backup);
    // Exercise both retained redo branches through real UI after cancellation.
    for(const [index,original]of before.documents.entries()){
      await activate(original.documentId);await button('Redo');let current=await readDocumentRecord(page,original.documentId);assert.deepEqual(current.snapshot.project.edits,histories[index]);assert.equal(current.snapshot.canRedo,false);await button('Undo');current=await readDocumentRecord(page,original.documentId);assert.deepEqual(current.snapshot.project.edits,original.snapshot.project.edits);assert.deepEqual(current.snapshot.redoEdit,original.snapshot.redoEdit);assert.ok(current.revision>original.revision);recordStep('Retained real UI Redo → Undo',current);
    }
    const resumed=await snapshot(),nextBackup=await acknowledged(resumed,histories);assert.equal(nextBackup.manifest.epoch,backup.manifest.epoch,'Ordinary continued history stays in the Running epoch');
    closeWindow();dialog('tests/desktop/answer-unsaved-dialog.ps1','Cancel');await unchanged('WM_CLOSE → Unsaved score Cancel preserved Running',resumed,nextBackup);
    const closed=page.waitForEvent('close',{timeout:30000});void closed.catch(()=>{});closeWindow();dialog('tests/desktop/answer-unsaved-dialog.ps1','Discard');dialog('tests/desktop/answer-unsaved-dialog.ps1','Discard');await closed;
    const exitDeadline=Date.now()+15000;while(inspect()&&Date.now()<exitDeadline)await wait(50);assert.equal(inspect(),null,'Final WM_CLOSE exits naturally');naturalExit=true;
    const clean=checkpoint();assert.equal(clean.manifest.lifecycle,'clean');assert.ok(clean.manifest.epoch>nextBackup.manifest.epoch);assert.equal(clean.manifest.previous,null);assert.deepEqual(clean.envelope.documents,[],'Discarded never-saved blanks are omitted, not replaced in the saved Clean envelope');assert.equal(clean.envelope.activeDocumentId,null);assert.deepEqual(errors,[]);recordStep('Natural exit with empty Clean projection',clean);result.naturalExit=true;result.pageErrors=errors;return result;
  }catch(error){recordStep('Failure',{error:String(error),pageErrors:errors});error.productionRecoveryResult=result;throw error;}
  finally{
    // Failed acceptance may leave a Running session. Preserve all disk evidence
    // and terminate only the exact instance this invocation launched.
    if(identity&&!naturalExit&&inspect()){owned();const receipt=ps(`${ownedCheck} if($null -eq $p){throw 'Owned process exited before cleanup'}; Stop-Process -Id $p.Id; $null=$p.WaitForExit(5000); 'Captured production instance terminated'`);recordStep('Failure cleanup owned kill',{identity,receipt});}
    if(browser)try{await browser.close();}catch{}
  }
}
