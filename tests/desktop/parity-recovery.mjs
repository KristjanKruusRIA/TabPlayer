import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {isAbsolute,relative,resolve,toNamespacedPath} from 'node:path';
import {cpus,release,totalmem} from 'node:os';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {rolldown} from 'rolldown';
import {connect,directory,launch} from './harness.mjs';
import {readDocumentRecord} from './document-context.mjs';
import {sha256,backingSettings} from './document-tabs-fixture.mjs';
import {buildRecoveryFixtures,buildRecoveryPerformanceFixture,writeRecoveryFixtures,assertRecoveryFixtureHashes,assertRecoveryNoteEvents} from './recovery-fixture.mjs';
import {clickWorkspaceCommand,clickWorkstationButton,revealInspector,revealDock,waitForWorkspaceIdle} from './workstation-commands.mjs';

// Importing is inert: no files, fixture allocations, native app, CDP connection,
// process helper or acceptance group is created until explicitly requested.
export const recoveryAcceptanceGroups=Object.freeze(['crash','clean','paths','corruption','ownership','performance','visual']);
const wait=ms=>new Promise(accept=>setTimeout(accept,ms));
const address=record=>({documentId:record.documentId,revision:record.revision});
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const canonicalFilePath=path=>toNamespacedPath(realpathSync.native(path)).toLowerCase();
let enginePromise;
async function engine(){
  enginePromise??=(async()=>{
    const entry='recovery-acceptance-engine',source=resolve('src/engine.ts').replaceAll('\\','/');
    const bundle=await rolldown({input:entry,external:['@coderline/alphatab','fflate'],plugins:[{name:entry,resolveId:id=>id===entry?id:null,load:id=>id===entry?`export {buildScore} from ${JSON.stringify(source)};`:null}]});
    try{const {output}=await bundle.generate({format:'es',paths:Object.fromEntries(['@coderline/alphatab','fflate'].map(name=>[name,import.meta.resolve(name)]))});return import(`data:text/javascript;base64,${Buffer.from(output.find(value=>value.type==='chunk'&&value.isEntry).code).toString('base64')}`);}
    finally{await bundle.close();}
  })();return enginePromise;
}
async function assertNotes(project,expected){
  const api=await engine(),dom=new JSDOM(''),previous=['DOMParser','XMLSerializer'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  for(const [name]of previous)Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true,writable:true});
  try{assertRecoveryNoteEvents(api.buildScore(project),expected);}
  finally{for(const [name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}dom.window.close();}
}
function assertApplied(record,expected){
  assert.deepEqual(record.snapshot.project.edits,expected.appliedEdits,'Actual native applied commands');
  assert.equal(record.snapshot.dirty,expected.dirty,'Saved comparison is independent of the current history branch');
  assert.equal(record.snapshot.canUndo,expected.canUndo);
  assert.equal(record.snapshot.canRedo,expected.canRedo);
  assert.deepEqual(record.snapshot.redoEdit??null,expected.redoEdits[0]??null,'Native next-redo preview');
}
function recognizedFiles(root){
  if(!existsSync(root))return {};
  return Object.fromEntries(readdirSync(root).filter(name=>name==='manifest.json'||/^checkpoint-\d+\.json$/.test(name)).sort().map(name=>{
    const path=resolve(root,name);assert.equal(lstatSync(path).isFile(),true);return [name,sha256(readFileSync(path))];
  }));
}
function treeHashes(root){
  if(!existsSync(root))return {};
  const result={};
  function visit(path){for(const entry of readdirSync(path,{withFileTypes:true})){const child=resolve(path,entry.name);if(entry.isDirectory())visit(child);else if(entry.isFile())result[relative(root,child).replaceAll('\\','/')]=sha256(readFileSync(child));else throw new Error(`Unexpected nonregular diagnostic entry: ${child}`);}}
  visit(root);return result;
}
function assertDiagnostics(before,diagnostics){
  for(const [name,hash]of Object.entries(before))assert.ok(Object.entries(diagnostics).some(([path,value])=>path.split('/').at(-1)===name&&value===hash),`Explicit new session preserves ${name} and its exact bytes`);
}
function checkpointAt(nativeDirectory){
  const recovery=resolve(nativeDirectory,'recovery-v1'),manifestPath=resolve(recovery,'manifest.json'),manifest=json(manifestPath);
  assert.equal(manifest.format,'TabPlayerRecoveryManifest');assert.equal(manifest.version,1);
  assert.ok(Number.isSafeInteger(manifest.epoch)&&manifest.epoch>0);
  assert.ok(Number.isSafeInteger(manifest.current.generation)&&manifest.current.generation>0);
  assert.match(manifest.current.sha256,/^[a-f0-9]{64}$/);
  const payloadPath=resolve(recovery,`checkpoint-${manifest.current.generation}.json`),bytes=readFileSync(payloadPath);
  assert.equal(sha256(bytes),manifest.current.sha256,'Manifest acknowledges exact complete bytes');
  const envelope=JSON.parse(bytes.toString('utf8'));
  assert.equal(envelope.format,'TabPlayerRecovery');assert.equal(envelope.version,1);
  assert.equal(envelope.epoch,manifest.epoch);assert.equal(envelope.generation,manifest.current.generation);
  return {manifest,envelope,manifestPath,payloadPath,receipt:{epoch:manifest.epoch,generation:manifest.current.generation,lifecycle:manifest.lifecycle,capturedAtUnixMs:envelope.capturedAtUnixMs,sha256:manifest.current.sha256,encodedBytes:bytes.length,manifestSha256:sha256(readFileSync(manifestPath)),previous:manifest.previous}};
}
function assertLossless(checkpoint,fixture,ids){
  const {envelope}=checkpoint;
  assert.deepEqual(envelope.documents.map(document=>document.documentId),fixture.order.map(name=>ids[name]));
  assert.equal(envelope.activeDocumentId,ids[fixture.active]);
  for(const name of fixture.order){
    const document=envelope.documents.find(value=>value.documentId===ids[name]),expected=fixture.documents[name].expected;
    assert.deepEqual(document.session.project.edits,expected.history,`${name}: complete branch`);
    assert.equal(document.session.cursor,expected.cursor,`${name}: cursor`);
    assert.deepEqual(document.session.saved,expected.saved,`${name}: independently saved branch`);
    assert.deepEqual(document.view,fixture.documents[name].view,`${name}: native acknowledged location`);
    if(document.session.path===null)assert.equal(document.savedFileSha256,null);
    else assert.equal(document.savedFileSha256,sha256(readFileSync(document.session.path)),`${name}: exact read/write file receipt`);
    if(name==='imported')assert.equal(canonicalFilePath(document.importedPath),canonicalFilePath(fixture.sourcePath),'Imported alias matches its actual source independently of Windows path spelling');
    else assert.equal(document.importedPath,null,`${name}: native/blank entries have no imported alias`);
    if(name==='imported'){
      assert.equal(document.session.project.base.sha256,fixture.sourceHash);
      assert.equal(sha256(Buffer.from(document.session.project.base.bytesBase64,'base64')),fixture.sourceHash);
      assert.deepEqual(Object.keys(document.session.project.assets).sort(),[...expected.retainedAssetHashes].sort());
      for(const backing of Object.values(fixture.backings))assert.equal(sha256(Buffer.from(document.session.project.assets[backing.sha256].bytesBase64,'base64')),backing.sha256,'Saved-only and redo-only bytes survive');
    }
  }
}
function argumentsFor(argv){
  const options={groups:[],performance:false,list:false,selfTest:false};
  for(const arg of argv){
    if(arg==='--list')options.list=true;
    else if(arg==='--self-test')options.selfTest=true;
    else if(arg==='--performance')options.performance=true;
    else if(arg.startsWith('--group='))options.groups.push(...arg.slice(8).split(','));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if(options.groups.some(group=>!recoveryAcceptanceGroups.includes(group)))throw new Error(`Groups: ${recoveryAcceptanceGroups.join(', ')}`);
  options.groups=[...new Set(options.groups)];
  if(options.groups.includes('performance')&&!options.performance)throw new Error('The performance group also requires explicit --performance.');
  if(!options.list&&!options.selfTest&&!options.groups.length)throw new Error('Select a bounded group with --group=<name>; use --list for names.');
  return options;
}

// One context owns all app/helper PIDs. No close, kill, corrupting write or
// relaunch is allowed against an application or session outside this context.
class AcceptanceContext{
  constructor({prefix,group,executable,fixture,result}){
    Object.assign(this,{prefix,group,executable,fixture,result});
    this.nativeDirectory=mkdtempSync(resolve(directory,`${prefix}-${group}-session-`));
    assert.equal(isAbsolute(this.nativeDirectory),true);
    this.pid=null;this.identity=null;this.browser=null;this.page=null;this.helpers=new Set();
    this.savePath=resolve(directory,`${prefix}-${group}-ordinary.tabplayer`);
    this.importedSavePath=resolve(directory,`${prefix}-${group}-imported.tabplayer`);
    this.processes=[];this.errors=[];
    result.nativeDirectory=this.nativeDirectory;result.processes=this.processes;
  }
  ps(command,extra={}){return execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,RECOVERY_OWNED_PID:String(this.pid),RECOVERY_OWNED_EXE:this.executable,RECOVERY_OWNED_START:this.identity?.start??'',...extra}}).trim();}
  inspect(pid=this.pid){
    return JSON.parse(this.ps('$p=Get-Process -Id $env:RECOVERY_INSPECT_PID -ErrorAction SilentlyContinue; if($null -eq $p){"null"; exit 0}; if(-not [string]::Equals($p.Path,$env:RECOVERY_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase)){throw "Unexpected process at owned PID"}; $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | Select-Object ProcessId,ParentProcessId,Name); @{pid=$p.Id;path=$p.Path;start=$p.StartTime.ToUniversalTime().Ticks.ToString();children=$children} | ConvertTo-Json -Depth 4 -Compress',{RECOVERY_INSPECT_PID:String(pid)}));
  }
  owned(){const current=this.inspect();assert.ok(current,'Owned process is still live');assert.equal(current.start,this.identity.start,'Do not control a reused PID');return current;}
  live(){const current=this.inspect();if(current)assert.equal(current.start,this.identity.start,'Do not control a reused PID');return current!==null;}
  async noDebugServer(){
    const deadline=Date.now()+8000;
    do{try{await fetch('http://127.0.0.1:9223/json/version',{signal:AbortSignal.timeout(250)});}catch{return;}await wait(50);}while(Date.now()<deadline);
    throw new Error('CDP 9223 is already occupied; refusing to attach to another app.');
  }
  async start({open=this.fixture.sourcePath,nativeDirectory=this.nativeDirectory,backing=this.fixture.backings?.redoBacking.path??''}={}){
    assert.equal(this.pid,null);await this.noDebugServer();
    this.pid=launch({TABPLAYER_TEST_SESSION_DIR:nativeDirectory,TABPLAYER_TEST_OPEN:open,TABPLAYER_TEST_SAVE:this.savePath,TABPLAYER_TEST_BACKING:backing});
    this.identity=this.inspect();assert.ok(this.identity);this.processes.push({...this.identity,nativeDirectory});
    this.browser=await connect();this.page=this.browser.contexts()[0].pages()[0];assert.ok(this.page);
    this.page.setDefaultTimeout(20000);this.page.on('pageerror',error=>this.errors.push(error.message));
    await this.page.setViewportSize({width:1280,height:900});await this.dismissWelcome();return this.page;
  }
  // A fresh session opens the Library with a welcome, which is modal and holds the workspace busy; a restored session does not, so it is closed only when it appears.
  async dismissWelcome(){
    const library=this.page.getByRole('dialog',{name:'Library',exact:true});
    if(await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor({timeout:6000}).then(()=>true,()=>false)){await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});}
  }
  invoke(command,args={}){return this.page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);}
  workspace(){return this.invoke('workspace_snapshot');}
  record(documentId){return readDocumentRecord(this.page,documentId);}
  async active(){return this.record((await this.workspace()).active.documentId);}
  idle(){return waitForWorkspaceIdle(this.page,{timeout:25000});}
  async button(name){await clickWorkstationButton(this.page,name,{waitForIdle:false});await this.idle();}
  async activate(documentId){
    await this.page.locator(`[id=${JSON.stringify(`document-tab-${encodeURIComponent(documentId)}`)}]`).click();await this.idle();assert.equal((await this.workspace()).active.documentId,documentId);
  }
  async choice(name){await this.page.getByRole('dialog').getByRole('button',{name,exact:true}).click();await this.idle();}
  async prompt(title='Recover unsaved work?'){await this.page.getByRole('dialog',{name:title,exact:true}).waitFor({state:'visible'});return this.page.getByRole('dialog',{name:title,exact:true});}
  async ack({after=0,predicate=()=>true,timeout=40000}={}){
    const deadline=Date.now()+timeout;let status;
    do{
      status=await this.invoke('recovery_status');
      if(status.state==='failed')throw new Error(`Checkpoint failed: ${status.error}`);
      if(status.state==='ready'&&status.generation>after){const checkpoint=checkpointAt(this.nativeDirectory);if(checkpoint.receipt.generation===status.generation&&checkpoint.receipt.capturedAtUnixMs===status.capturedAtUnixMs&&predicate(checkpoint))return checkpoint;}
      await wait(25);
    }while(Date.now()<deadline);
    throw new Error(`Acknowledged expected checkpoint did not arrive: ${JSON.stringify(status)}`);
  }
  async stopped(){
    const deadline=Date.now()+30000;let value;
    do{value=await this.invoke('audio_status');if(value?.ready&&!value.error){assert.equal(value.playing,false);assert.equal(value.tick,0);assert.equal(value.range,null);assert.equal(value.loop,null);return value;}await wait(25);}while(Date.now()<deadline);
    throw new Error(`Restored audio did not become ready/stopped: ${JSON.stringify(value)}`);
  }
  async disconnect(){if(this.browser){try{await this.browser.close();}catch{}this.browser=null;this.page=null;}}
  async kill(reason='forced process crash'){
    const pid=this.pid;assert.ok(this.identity);this.result.kills??=[];this.result.kills.push({pid,start:this.identity.start,reason,atUnixMs:Date.now()});
    this.ps('$p=Get-Process -Id $env:RECOVERY_OWNED_PID -ErrorAction Stop; if(-not [string]::Equals($p.Path,$env:RECOVERY_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:RECOVERY_OWNED_START){throw "Owned process identity changed before force termination"}; Stop-Process -Id $p.Id; $null=$p.WaitForExit(5000)');
    assert.equal(this.live(),false);await this.disconnect();this.pid=null;this.identity=null;await this.noDebugServer();
  }
  closeWindow(){this.owned();return this.ps('$p=Get-Process -Id $env:RECOVERY_OWNED_PID -ErrorAction Stop; if(-not [string]::Equals($p.Path,$env:RECOVERY_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:RECOVERY_OWNED_START){throw "Owned window identity changed"}; if(-not $p.CloseMainWindow()){throw "Owned window rejected close message"}; "Owned close requested"');}
  dialog(script,extra=[]){
    this.owned();return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-AppProcessId',String(this.pid),'-AppExecutable',this.executable,'-AppStartTicks',this.identity.start,...extra],{encoding:'utf8',windowsHide:true,timeout:15000}).trim();
  }
  answer(decision){return this.dialog('tests/desktop/answer-unsaved-dialog.ps1',['-Decision',decision]);}
  async nativeClose(decisions){
    const closed=this.page.waitForEvent('close',{timeout:25000});void closed.catch(()=>{});
    const request=this.closeWindow(),receipts=decisions.map(decision=>this.answer(decision));await closed;
    const deadline=Date.now()+10000;while(this.live()&&Date.now()<deadline)await wait(50);assert.equal(this.live(),false,'Clean close exits naturally');
    await this.disconnect();this.pid=null;this.identity=null;await this.noDebugServer();return {request,receipts};
  }
  async preference(checked){
    const summary=this.page.locator('.workstation-command summary').filter({hasText:/^File$/});
    const file=await summary.count()?summary:this.page.locator('summary').filter({hasText:/^File$/});
    if(!await file.evaluate(node=>node.parentElement.open))await file.click();
    const checkbox=this.page.getByRole('checkbox',{name:'Restore previous session',exact:true});if(await checkbox.isChecked()!==checked)await checkbox.click();
    await this.page.waitForFunction(checked=>{const input=Array.from(document.querySelectorAll('input[type="checkbox"]')).find(node=>node.parentElement?.textContent?.includes('Restore previous session'));return input?.checked===checked&&!input.disabled;},checked);
    const path=resolve(this.nativeDirectory,'session-preferences.json');if(existsSync(path))assert.equal(json(path).restorePreviousSession,checked);else assert.equal(checked,true,'A missing preference file means the default true');await file.press('Escape');
  }
  async editNote(fret,{bar=0,beat=0,string=6}={}){
    await revealInspector(this.page);await this.button('Edit');await this.page.getByLabel('Measure',{exact:true}).fill(String(bar+1));await this.page.getByLabel('Beat',{exact:true}).fill(String(beat+1));await this.page.getByRole('combobox',{name:'String',exact:true}).selectOption(String(string));await this.page.getByLabel('Fret',{exact:true}).fill(String(fret));
    const before=await this.active();await this.button('Set note');const after=await this.active();assert.ok(after.revision>before.revision);assert.deepEqual(after.snapshot.project.edits.at(-1),{type:'setNote',target:{track:0,staff:0,bar,voice:0,beat},string,fret});return after;
  }
  async pickerCancel(){
    this.owned();const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','tests/desktop/cancel-dialog.ps1','-AppProcessId',String(this.pid),'-AppExecutable',this.executable,'-AppStartTicks',this.identity.start],{windowsHide:true,timeout:15000,killSignal:'SIGKILL'});this.helpers.add(child);let output='';
    child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{output+=bytes;});
    const done=new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',code=>{this.helpers.delete(child);code===0?accept(output.trim()):reject(new Error(`Owned picker helper failed ${code}: ${output}`));});});void done.catch(()=>{});return done;
  }
  diskWrite(path,bytes){
    assert.equal(this.pid,null,'Fault writes happen only between owned launches');const rel=relative(realpathSync(this.nativeDirectory),realpathSync(path));assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));
    assert.equal(lstatSync(path).isFile(),true);assert.equal(lstatSync(path).isSymbolicLink(),false);writeFileSync(path,bytes);
  }
  async finish(){for(const child of this.helpers)child.kill('SIGKILL');this.helpers.clear();if(this.pid!==null){if(this.live())await this.kill('bounded acceptance cleanup');else{await this.disconnect();this.pid=null;this.identity=null;}}assertRecoveryFixtureHashes(this.fixture);}
}

async function prepare(context){
  const {fixture}=context;await context.start();await context.idle();
  const initial=await context.workspace(),ids={untitled:initial.active.documentId};
  assert.equal(initial.documents.length,1);assert.deepEqual(initial.documents[0].snapshot.project.edits,[]);
  for(const name of fixture.order){
    if(name!=='untitled'){
      const path=name==='imported'?fixture.sourcePath:fixture.nativeBlankPath;
      const intake=await context.invoke('desktop_test_io',{action:'read',path});assert.equal(intake.kind,'candidate');
      const value=await context.invoke('workspace_add',{token:intake.candidate.token});ids[name]=value.active.documentId;
    }
    for(const operation of fixture.documents[name].operations){
      const before=await context.record(ids[name]),document=address(before);
      if(operation.action==='edit')await context.invoke('apply_edit',{document,command:operation.command});
      else if(operation.action==='undo')await context.invoke('undo_edit',{document});
      else if(operation.action==='save')await context.invoke('desktop_test_io',{action:'save',...document,path:context.importedSavePath});
      else if(operation.action==='backing'){
        const backing=fixture.backings[operation.asset],candidate=await context.invoke('stage_embedded_backing',{documentId:document.documentId,bytes:Array.from(readFileSync(backing.path))});
        assert.ok(candidate);assert.equal(candidate.assetId,backing.sha256);await context.invoke('apply_edit',{document,command:operation.command,assetToken:candidate.token});
      }else throw new Error(`Unknown fixture operation ${operation.action}`);
    }
    const actual=await context.record(ids[name]);assertApplied(actual,fixture.documents[name].expected);await assertNotes(actual.snapshot.project,fixture.documents[name].expected.appliedEvents);
    await context.invoke('workspace_set_view',{documentId:ids[name],view:fixture.documents[name].view});
  }
  await context.invoke('workspace_activate',{documentId:ids[fixture.active]});
  const before=await context.workspace(),checkpoint=await context.ack({predicate:value=>value.envelope.documents.length===fixture.order.length&&value.envelope.activeDocumentId===ids[fixture.active]});
  assertLossless(checkpoint,fixture,ids);
  context.result.prepared={ids,workspace:before,checkpoint:checkpoint.receipt};return {ids,before,checkpoint};
}
async function assertView(context,expected){
  const {page}=context;await revealInspector(page);await context.button('Edit');
  assert.equal(await page.getByLabel('Measure',{exact:true}).inputValue(),String(expected.target.bar+1));assert.equal(await page.getByLabel('Beat',{exact:true}).inputValue(),String(expected.target.beat+1));
  assert.equal(await page.getByRole('combobox',{name:'Staff',exact:true}).inputValue(),String(expected.target.staff));assert.equal(await page.getByRole('combobox',{name:'Voice',exact:true}).inputValue(),String(expected.target.voice));
  assert.equal(await page.getByRole('combobox',{name:'String',exact:true}).inputValue(),String(expected.selectedString));assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),String(expected.zoom));assert.equal(await page.getByRole('combobox',{name:/^Displayed tracks/}).inputValue(),expected.trackView.kind);
  const instrument=page.getByRole('navigation',{name:'Dock views',exact:true,includeHidden:true}).getByRole('button',{name:'Instrument',exact:true,includeHidden:true});assert.equal(await instrument.getAttribute('aria-pressed'),String(expected.instrumentVisible));
  const announcement=await page.locator('.score-edit-announcement').innerText();assert.match(announcement,new RegExp(`measure ${expected.target.bar+1}, beat ${expected.target.beat+1}, voice ${expected.target.voice+1}`));
  if(expected.selectedNoteIndex!==null)assert.match(announcement,new RegExp(`, note ${expected.selectedNoteIndex+1}$`));
  const trackName=expected.target.track===1?'Literal low guitar':null;if(trackName)assert.match(await page.getByLabel('Editing location',{exact:true}).innerText(),new RegExp(`^${trackName}`));
}
async function restored(context,prepared,{paths}={}){
  await context.prompt();const promptText=await context.page.getByRole('dialog').innerText();await context.choice('Restore');
  const workspace=await context.workspace();assert.deepEqual(workspace.documents.map(document=>document.documentId),context.fixture.order.map(name=>prepared.ids[name]));assert.equal(workspace.active.documentId,prepared.ids[context.fixture.active]);assert.notEqual(workspace.active.activationId,prepared.before.active.activationId,'Restoration creates a fresh activation');
  for(const name of context.fixture.order){
    const record=await context.record(prepared.ids[name]),before=prepared.before.documents.find(value=>value.documentId===prepared.ids[name]);assert.equal(record.revision,before.revision);assertApplied(record,context.fixture.documents[name].expected);await assertNotes(record.snapshot.project,context.fixture.documents[name].expected.appliedEvents);
    if(paths&&name in paths)assert.equal(record.snapshot.path,paths[name]);
    await context.activate(record.documentId);await assertView(context,context.fixture.documents[name].view);await context.stopped();
  }
  await context.activate(prepared.ids[context.fixture.active]);return {workspace,promptText,stopped:await context.stopped()};
}
async function withoutOriginals(fixture,action){
  const moved=[];
  try{for(const path of [fixture.sourcePath,...Object.values(fixture.backings).map(value=>value.path)]){const absent=`${path}.absent-${randomUUID()}`;assert.equal(existsSync(absent),false);renameSync(path,absent);moved.push([path,absent]);}return await action();}
  finally{for(const [path,absent]of moved.reverse()){assert.equal(existsSync(path),false,'Never overwrite an unexpected recreated original');renameSync(absent,path);}}
}

async function crash(context){
  const prepared=await prepare(context);await context.kill();
  const expected=context.fixture.documents.imported.expected;let appliedCopy;await withoutOriginals(context.fixture,async()=>{await context.start();context.result.restore=await restored(context,prepared);
  const id=prepared.ids.imported;await context.activate(id);
  await clickWorkspaceCommand(context.page,'Save');await context.idle();let record=await context.record(id);
  assert.equal(record.snapshot.dirty,false);assert.equal(record.snapshot.canRedo,true);
  const appliedBytes=readFileSync(context.savePath),appliedDisk=JSON.parse(appliedBytes);assert.deepEqual(appliedDisk.edits,expected.appliedEdits);assert.deepEqual(Object.keys(appliedDisk.assets),expected.ordinaryAppliedAssetHashes);
  appliedCopy=resolve(directory,`${context.prefix}-ordinary-applied.tabplayer`);writeFileSync(appliedCopy,appliedBytes,{flag:'wx'});
  await context.button('Redo');record=await context.record(id);assert.deepEqual(record.snapshot.project.edits,expected.history.slice(0,2));await assertNotes(record.snapshot.project,expected.afterFirstRedoEvents);assert.equal(record.snapshot.canRedo,true);
  await context.button('Redo');record=await context.record(id);assert.deepEqual(record.snapshot.project.edits,expected.history);await assertNotes(record.snapshot.project,expected.afterAllRedoEvents);assert.equal(record.snapshot.canRedo,false);assert.equal(record.snapshot.project.edits.at(-1).backing.assetId,expected.redoBackingHash);
  const redoneAudio=await context.stopped();assert.equal(redoneAudio.backingDurationSeconds,2,'Redo prepares retained embedded backing while both original WAVs are absent');
  await clickWorkspaceCommand(context.page,'Save As');await context.idle();const redone=json(context.savePath);assert.deepEqual(redone.edits,expected.history);assert.deepEqual(Object.keys(redone.assets),expected.ordinaryAllRedoAssetHashes);assert.equal(sha256(Buffer.from(redone.assets[expected.redoBackingHash].bytesBase64,'base64')),expected.redoBackingHash);
  context.result.ordinarySave={applied:{path:appliedCopy,sha256:sha256(appliedBytes)},redone:{path:context.savePath,sha256:sha256(readFileSync(context.savePath))},originalsAbsentThroughRedo:true,redoneBackingDurationSeconds:redoneAudio.backingDurationSeconds};});
  await context.kill('separate ordinary-file reopen, not clean session restoration');
  const fresh=mkdtempSync(resolve(directory,`${context.prefix}-ordinary-reopen-session-`));await context.start({open:appliedCopy,nativeDirectory:fresh});await context.idle();await clickWorkspaceCommand(context.page,'Open');await context.idle();const reopened=await context.active();assert.equal(reopened.snapshot.canRedo,false);assert.equal(reopened.snapshot.dirty,false);assert.deepEqual(reopened.snapshot.project.edits,expected.appliedEdits);await assertNotes(reopened.snapshot.project,expected.appliedEvents);context.result.ordinaryReopen={nativeDirectory:fresh,document:address(reopened),canRedo:false};
}
async function clean(context){
  await context.start();await context.idle();const edited=await context.editNote(5);await context.ack();
  const before=await context.workspace();context.closeWindow();context.result.cancel=context.answer('Cancel');await context.idle();assert.deepEqual(await context.workspace(),before);assert.equal(context.live(),true);assert.equal(checkpointAt(context.nativeDirectory).manifest.lifecycle,'running');
  const pendingCancel=context.pickerCancel(),pendingSave=context.invoke('save_project',{document:address(edited),saveAs:true});void pendingSave.catch(()=>{});const [pickerReceipt,saved]=await Promise.all([pendingCancel,pendingSave]);assert.equal(saved,null);assert.deepEqual(await context.workspace(),before);context.result.productionSavePickerCancel={document:address(edited),receipt:pickerReceipt,route:'Production save_project; diagnostic close Save uses a fixed path and has no later picker.'};
  await context.preference(true);await context.page.getByLabel('Zoom (%)',{exact:true}).fill('115');await revealDock(context.page,'Instrument');
  context.result.saveClose=await context.nativeClose(['Save']);const first=checkpointAt(context.nativeDirectory);assert.equal(first.manifest.lifecycle,'clean');assert.equal(first.envelope.documents.length,1);assert.deepEqual(first.envelope.documents[0].session.saved,edited.snapshot.project.edits);assert.deepEqual(first.envelope.documents[0].session.project.edits,edited.snapshot.project.edits);assert.equal(first.envelope.documents[0].view.zoom,115);
  await context.start();await context.idle();assert.equal(await context.page.getByRole('dialog').count(),0);let record=await context.active();assert.equal(record.documentId,edited.documentId);assert.equal(record.snapshot.dirty,false);assert.deepEqual(record.snapshot.project.edits,edited.snapshot.project.edits);assert.equal(await context.page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'115');await context.stopped();
  await context.editNote(9);context.result.discardClose=await context.nativeClose(['Discard']);const discarded=checkpointAt(context.nativeDirectory);assert.equal(discarded.manifest.lifecycle,'clean');assert.deepEqual(discarded.envelope.documents[0].session.project.edits,edited.snapshot.project.edits,'Discard clean projection restores the saved branch');
  await context.start();await context.idle();record=await context.active();assert.equal(record.snapshot.dirty,false);assert.deepEqual(record.snapshot.project.edits,edited.snapshot.project.edits);
  await context.editNote(11);await context.preference(false);context.result.preferenceOffClose=await context.nativeClose(['Discard']);const off=checkpointAt(context.nativeDirectory);assert.equal(off.manifest.lifecycle,'clean');assert.deepEqual(off.envelope.documents,[]);
  await context.start();await context.idle();record=await context.active();assert.notEqual(record.documentId,edited.documentId);assert.deepEqual(record.snapshot.project.edits,[]);await context.editNote(13);const crashAck=await context.ack();await context.kill('preference-off crash still requires an explicit recovery choice');await context.start();await context.prompt();await context.choice('Discard recovery');assert.deepEqual((await context.active()).snapshot.project.edits,[]);context.result.preferenceOffCrashChoice={checkpoint:crashAck.receipt,choice:'Discard recovery',retirement:checkpointAt(context.nativeDirectory).receipt};
  await context.editNote(1);await clickWorkspaceCommand(context.page,'New');await context.idle();await context.editNote(2);const pair=await context.workspace();
  await clickWorkspaceCommand(context.page,'Close all scores',{waitForIdle:false});const cancelReceipts=['Discard','Cancel'].map(decision=>context.answer(decision));await context.idle();assert.deepEqual(await context.workspace(),pair);
  await clickWorkspaceCommand(context.page,'Close all scores',{waitForIdle:false});const saveReceipts=['Save','Cancel'].map(decision=>context.answer(decision));await context.idle();const partial=await context.workspace();assert.deepEqual(partial.documents.map(value=>value.documentId),pair.documents.map(value=>value.documentId));assert.equal(partial.documents[0].snapshot.dirty,false);assert.equal(partial.documents[1].snapshot.dirty,true);context.result.cancelledCloseAll={discardThenCancel:cancelReceipts,saveThenCancel:saveReceipts,workspace:partial};
  context.result.finalClose=await context.nativeClose(['Discard']);assert.equal(checkpointAt(context.nativeDirectory).manifest.lifecycle,'clean');
}
async function paths(context){
  const prepared=await prepare(context),imported=await context.record(prepared.ids.imported),before=await context.workspace(),nativeHash=sha256(readFileSync(context.fixture.nativeBlankPath));
  const collision=await context.page.evaluate(async args=>{try{await window.__TAURI_INTERNALS__.invoke('desktop_test_io',args);return null;}catch(error){return String(error);}},{action:'save',...address(imported),path:context.fixture.nativeBlankPath});assert.match(collision,/destination|another|open|preserve/i);assert.deepEqual(await context.workspace(),before);assert.equal(sha256(readFileSync(context.fixture.nativeBlankPath)),nativeHash);context.result.destinationCollision={document:address(imported),reason:collision,unchangedSha256:nativeHash};
  await context.kill();const nativeBytes=readFileSync(context.fixture.nativeBlankPath),savedMissing=`${context.importedSavePath}.absent-${randomUUID()}`;renameSync(context.importedSavePath,savedMissing);writeFileSync(context.fixture.nativeBlankPath,Buffer.concat([nativeBytes,Buffer.from('\n')]));
  try{await withoutOriginals(context.fixture,async()=>{await context.start();context.result.restore=await restored(context,prepared,{paths:{imported:null,nativeBlank:null}});});}
  finally{if(context.pid!==null)await context.kill('restore changed/missing-source inputs before preservation check');assert.equal(existsSync(context.importedSavePath),false);renameSync(savedMissing,context.importedSavePath);writeFileSync(context.fixture.nativeBlankPath,nativeBytes);}
  assertRecoveryFixtureHashes(context.fixture);context.result.changedNativeFileDetached=true;context.result.missingNativeFileDetached=true;
}
async function corruption(context){
  const prepared=await prepare(context),first=prepared.checkpoint;
  const document=await context.record(prepared.ids.untitled),extra={type:'setNote',target:{track:0,staff:0,bar:1,voice:0,beat:0},string:6,fret:17};await context.invoke('apply_edit',{document:address(document),command:extra});
  const second=await context.ack({after:first.receipt.generation,predicate:value=>value.envelope.documents.find(item=>item.documentId===prepared.ids.untitled)?.session.project.edits.length===3});assert.deepEqual(second.manifest.previous,first.manifest.current);await context.kill();context.diskWrite(second.payloadPath,Buffer.from('{truncated current checkpoint'));
  await context.start();const fallbackDialog=await context.prompt();const fallbackTime=await fallbackDialog.locator('time').getAttribute('datetime');assert.equal(new Date(fallbackTime).getTime(),first.receipt.capturedAtUnixMs);context.result.fallback={from:second.receipt,to:first.receipt,restore:await restored(context,prepared)};
  // Ordinary close must retire before acknowledgement. Corrupting its new epoch
  // can make recovery unavailable, but can never select the old discarded tab.
  await context.activate(prepared.ids.nativeBlank);await clickWorkspaceCommand(context.page,'Close score',{waitForIdle:false});const receipt=context.answer('Discard');await context.idle();const afterClose=await context.workspace();assert.equal(afterClose.documents.some(value=>value.documentId===prepared.ids.nativeBlank),false);
  const retired=checkpointAt(context.nativeDirectory);assert.ok(retired.manifest.epoch>first.manifest.epoch);assert.equal(retired.manifest.previous,null);assert.equal(retired.envelope.documents.some(value=>value.documentId===prepared.ids.nativeBlank),false);await context.kill();context.diskWrite(retired.payloadPath,Buffer.from('{retired current unavailable'));
  await context.start();await context.prompt('Recovery unavailable');assert.equal(await context.page.getByRole('button',{name:'Restore',exact:true}).count(),0);await context.choice('Start new session');assert.equal((await context.workspace()).documents.length,1);assert.deepEqual((await context.active()).snapshot.project.edits,[]);context.result.retirement={receipt,checkpoint:retired.receipt,closedDocumentId:prepared.ids.nativeBlank,startNew:checkpointAt(context.nativeDirectory).receipt};
  for(const kind of ['future','corrupt']){
    await context.editNote(kind==='future'?19:21);const acknowledged=await context.ack();await context.kill();const original=readFileSync(acknowledged.manifestPath),fault=kind==='future'?Buffer.from(JSON.stringify({...acknowledged.manifest,version:2})):Buffer.from('{corrupt manifest');context.diskWrite(acknowledged.manifestPath,fault);
    const beforeFault=recognizedFiles(resolve(context.nativeDirectory,'recovery-v1'));await context.start();const dialog=await context.prompt('Recovery unavailable');const text=await dialog.innerText();assert.deepEqual(recognizedFiles(resolve(context.nativeDirectory,'recovery-v1')),beforeFault,'Startup choice must precede any manifest/payload replacement');await context.choice('Start new session');const diagnostics=treeHashes(resolve(context.nativeDirectory,'recovery-v1','diagnostic'));assertDiagnostics(beforeFault,diagnostics);assert.equal((await context.workspace()).documents.length,1);assert.deepEqual((await context.active()).snapshot.project.edits,[]);context.result[kind]={acknowledged:acknowledged.receipt,priorManifestSha256:sha256(original),faultSha256:sha256(fault),prompt:text,diagnostics,newCheckpoint:checkpointAt(context.nativeDirectory).receipt};
  }
}
async function ownership(context){
  await context.start();await context.idle();const original=await context.editNote(7),acknowledged=await context.ack(),before={recovery:recognizedFiles(resolve(context.nativeDirectory,'recovery-v1')),preferences:existsSync(resolve(context.nativeDirectory,'session-preferences.json'))?sha256(readFileSync(resolve(context.nativeDirectory,'session-preferences.json'))):null};context.owned();
  const second=spawn(context.executable,[],{windowsHide:true,env:{...process.env,TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:context.nativeDirectory,TABPLAYER_TEST_SAVE:context.savePath,TABPLAYER_TEST_OPEN:context.fixture.sourcePath,WEBVIEW2_USER_DATA_FOLDER:resolve(directory,`${context.prefix}-second-profile`),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223'}});let output='';second.stdout.on('data',bytes=>{output+=bytes;});second.stderr.on('data',bytes=>{output+=bytes;});
  const terminal=new Promise((accept,reject)=>{second.once('error',reject);second.once('close',(code,signal)=>accept({code,signal}));});void terminal.catch(()=>{});
  let outcome;
  try{let timer;try{outcome=await Promise.race([terminal,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Second owned process did not reject its locked native directory.')),12000);})]);}finally{clearTimeout(timer);}
  // A second launch of the same app identifier is handed to the running window by the single-instance plugin: it exits 0 before the session lock is tried, so no lock message is printed. The lock message itself is covered at process level by src-tauri/tests/recovery_process.rs.
  assert.equal(outcome.code,0,'The second launch is handed to the running window and exits 0');assert.doesNotMatch(output,/already using this session/,'The hand-off prints no session-lock message');}
  finally{if(second.exitCode===null&&second.signalCode===null){const identity=context.inspect(second.pid);assert.ok(identity);second.kill('SIGKILL');await terminal;}}
  context.owned();assert.deepEqual(recognizedFiles(resolve(context.nativeDirectory,'recovery-v1')),before.recovery);assert.equal(existsSync(resolve(context.nativeDirectory,'session-preferences.json'))?sha256(readFileSync(resolve(context.nativeDirectory,'session-preferences.json'))):null,before.preferences);assert.deepEqual(await context.active(),original);context.result.secondProcess={pid:second.pid,...outcome,output,unchanged:before};
  await context.kill('OS lock release after process failure');await context.start();await context.prompt();await context.choice('Restore');const recovered=await context.active();assert.equal(recovered.documentId,original.documentId);assert.deepEqual(recovered.snapshot,original.snapshot);context.result.lockReleased={checkpoint:acknowledged.receipt,document:address(recovered),stopped:await context.stopped()};
}
function assertInterruptionPacket(value,expected,kind){
  assert.equal(value.kind,kind);assert.equal(value.helperPid,expected.helperPid);assert.equal(value.pid,expected.pid);assert.equal(value.utcStartTicks,expected.start);assert.equal(value.expectedGeneration,expected.generation);assert.equal(value.expectedManifestSha256,expected.manifestSha256);
  for(const key of ['executable','sessionDirectory'])assert.equal(toNamespacedPath(resolve(value[key])).toLowerCase(),toNamespacedPath(resolve(expected[key])).toLowerCase(),`Resident helper retains exact ${key}`);
  if(kind==='result'){
    assert.equal(typeof value.killed,'boolean');assert.equal(typeof value.timedOut,'boolean');
    if(value.killed){const name=relative(resolve(expected.sessionDirectory,'recovery-v1'),value.tempPath),match=/^\.checkpoint-([1-9]\d*)\.json\.[A-Za-z0-9]{6}$/.exec(name);assert.ok(match);assert.ok(Number.isSafeInteger(Number(match[1]))&&Number(match[1])>expected.generation);assert.ok(Number.isSafeInteger(value.tempBytes)&&value.tempBytes>0);assert.ok(Number.isSafeInteger(value.observedAtUnixMs)&&value.observedAtUnixMs>0&&Number.isSafeInteger(value.killAtUnixMs)&&value.killAtUnixMs>=value.observedAtUnixMs);assert.equal(value.timedOut,false);assert.equal(value.error,null);}
  }
}
async function armRecoveryInterruption(context,checkpoint){
  context.owned();const expected={pid:context.pid,executable:context.executable,start:context.identity.start,sessionDirectory:context.nativeDirectory,generation:checkpoint.receipt.generation,manifestSha256:checkpoint.receipt.manifestSha256};
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','tests/desktop/interrupt-recovery-write.ps1','-AppProcessId',String(expected.pid),'-AppExecutable',expected.executable,'-AppStartTicks',expected.start,'-SessionDirectory',expected.sessionDirectory,'-ExpectedGeneration',String(expected.generation),'-ExpectedManifestSha256',expected.manifestSha256],{windowsHide:true,timeout:25000,killSignal:'SIGKILL'});context.helpers.add(child);expected.helperPid=child.pid;
  let output='',stderr='',result,acceptReady,rejectReady;const ready=new Promise((accept,reject)=>{acceptReady=accept;rejectReady=reject;});void ready.catch(()=>{});
  child.stdout.on('data',bytes=>{output+=bytes;for(const line of output.split(/\r?\n/))try{const value=JSON.parse(line);if(value.kind==='ready'){assertInterruptionPacket(value,expected,'ready');acceptReady(value);}else if(value.kind==='result')result=value;}catch(error){if(error instanceof assert.AssertionError)rejectReady(error);}});child.stderr.on('data',bytes=>{stderr+=bytes;});
  const done=new Promise((accept,reject)=>{child.once('error',error=>{rejectReady(error);reject(error);});child.once('close',(code,signal)=>{context.helpers.delete(child);try{assert.equal(code,0,`Resident interruption helper ${code}/${signal}: ${stderr}`);assertInterruptionPacket(result,expected,'result');accept(result);}catch(error){rejectReady(error);reject(error);}});});void done.catch(()=>{});
  let timer;const armed=await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Resident interruption helper did not arm: ${stderr}`)),8000);})]).finally(()=>clearTimeout(timer));context.result.interruptionHelper={armed};
  return {async complete(){const value=await done;context.result.interruptionHelper.result=value;context.result.interruptionHelper.output=output;context.result.interruptionHelper.stderr=stderr;
    if(value.killed){assert.equal(context.live(),false,'Pinned helper kill must correspond to the actual owned process exit');context.result.kills??=[];context.result.kills.push({pid:expected.pid,start:expected.start,helperPid:expected.helperPid,reason:'Resident watcher terminated its cached exact process handle during an uncommitted payload write',atUnixMs:value.killAtUnixMs});await context.disconnect();context.pid=null;context.identity=null;await context.noDebugServer();}return value;}};
}
async function performance(context){
  const built=await buildRecoveryPerformanceFixture(),files=writeRecoveryFixtures(built,`${context.prefix}-performance`);
  await context.start({open:files.sourcePath,backing:files.backingPath});await context.idle();await clickWorkspaceCommand(context.page,'Open');await context.idle();const base=await context.active();await assertNotes(base.snapshot.project,built.source.literalEvents);const first=await context.ack({predicate:value=>value.envelope.activeDocumentId===base.documentId});
  const before=Date.now(),candidate=await context.invoke('stage_backing',{documentId:base.documentId});assert.ok(candidate);assert.equal(candidate.assetId,built.backing.sha256);
  const command={type:'setBacking',backing:backingSettings(candidate.assetId)};
  await context.invoke('apply_edit',{document:address(base),command,assetToken:candidate.token});
  const large=await context.ack({after:first.receipt.generation,predicate:value=>value.envelope.documents.find(document=>document.documentId===base.documentId)?.session.project.edits.at(-1)?.backing?.assetId===built.backing.sha256,timeout:60000}),largeReadyAt=Date.now(),largeDocument=await context.record(base.documentId);
  const savedAsset=large.envelope.documents.find(document=>document.documentId===base.documentId).session.project.assets[built.backing.sha256];assert.equal(sha256(Buffer.from(savedAsset.bytesBase64,'base64')),built.backing.sha256);
  const interruption=await armRecoveryInterruption(context,large),writeAttemptAt=Date.now();await context.invoke('apply_edit',{document:address(largeDocument),command:{type:'setBeatText',target:{track:0,staff:0,bar:0,voice:0,beat:0},text:'Large checkpoint interruption sentinel'}});
  const interrupted=await interruption.complete(),observed=interrupted.killed?{path:interrupted.tempPath,bytes:interrupted.tempBytes,atUnixMs:interrupted.observedAtUnixMs,manifestGeneration:interrupted.expectedGeneration,manifestSha256:interrupted.expectedManifestSha256,killAtUnixMs:interrupted.killAtUnixMs}:null;
  context.result.measurement={measures:100,tracks:4,literalNotes:1600,backingBytes:built.backing.bytes.length,sourceSha256:built.source.sha256,backingSha256:built.backing.sha256,baseline:first.receipt,largeCheckpoint:large.receipt,mutationToAcknowledgementMs:largeReadyAt-before,mutationToAcknowledgementScope:'Includes stage/decode, the 2-second quiet period, capture and complete write; not an isolated native write-duration measurement.',nextWriteObservationElapsedMs:Date.now()-writeAttemptAt,workspaceCaptureDurationMs:null,workspaceCaptureLimit:'Public status has no capture-duration or concurrent-job metric; root native latched tests supply those checks.',duringWrite:{verified:false,observation:observed,reason:interrupted.error??'Resident cached-handle kill completed; inspect persisted post-kill evidence.'},latestCompleteEncodedBytes:large.receipt.encodedBytes};
  if(!interrupted.killed)await context.kill('Resident watcher missed the bounded payload window; interrupted-write coverage remains unverified');
  const afterKill=checkpointAt(context.nativeDirectory),tempAfterKill=observed&&existsSync(observed.path)?{bytes:statSync(observed.path).size,sha256:sha256(readFileSync(observed.path))}:null,publicationInterrupted=!!observed&&afterKill.receipt.generation===large.receipt.generation&&afterKill.receipt.sha256===large.receipt.sha256;
  context.result.measurement.duringWrite={verified:publicationInterrupted&&tempAfterKill!==null&&tempAfterKill.bytes>0,publicationInterrupted,observation:observed,tempAfterKill,manifestAfterKill:afterKill.receipt,reason:publicationInterrupted?(tempAfterKill?'A positive-size uncommitted payload temp remains after the verified owned-process kill.':'The prior manifest survived; payload-temp disappearance means the exact payload-write kill phase is unverified.'):'The new manifest may have committed before the process was terminated; interrupted-write coverage is unverified.'};
  await context.start({backing:files.backingPath});await context.prompt();await context.choice('Restore');const recovered=await context.active();assert.equal(recovered.documentId,base.documentId);await assertNotes(recovered.snapshot.project,built.source.literalEvents);
  if(publicationInterrupted){assert.deepEqual(recovered.snapshot.project.edits,largeDocument.snapshot.project.edits);assert.ok(recovered.snapshot.project.assets[built.backing.sha256]);context.result.measurement.previousAcknowledgementRestored=true;}
  else context.result.measurement.previousAcknowledgementRestored='unverified: the kill may follow a completed checkpoint';
  context.result.measurement.oversize='Not exercised by this 34.6 MB backing. Native bounded-reader/writer tests and a separately authorized oversize runtime case are still required.';
  for(const [path,hash]of Object.entries(files.hashes))assert.equal(sha256(readFileSync(path)),hash);await context.stopped();
}

async function holdOwnedManifest(context){
  context.owned();const path=resolve(context.nativeDirectory,'recovery-v1','manifest.json'),releasePath=resolve(directory,`${context.prefix}-visual-release-${randomUUID()}`);assert.equal(lstatSync(path).isFile(),true);assert.equal(existsSync(releasePath),false);
  const script=`$ErrorActionPreference='Stop'
$app=Get-Process -Id $env:RECOVERY_LOCK_APP_PID -ErrorAction Stop
if(-not [string]::Equals($app.Path,$env:RECOVERY_LOCK_APP_EXE,[StringComparison]::OrdinalIgnoreCase) -or $app.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:RECOVERY_LOCK_APP_START){throw 'Owned application identity changed before manifest sharing lock'}
$root=[IO.Path]::GetFullPath($env:RECOVERY_LOCK_DIRECTORY)
$target=[IO.Path]::GetFullPath($env:RECOVERY_LOCK_TARGET)
if(-not [string]::Equals($target,[IO.Path]::Combine($root,'recovery-v1','manifest.json'),[StringComparison]::OrdinalIgnoreCase)){throw 'Only the owned session manifest may be locked'}
$item=Get-Item -LiteralPath $target -ErrorAction Stop
if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Manifest must be a regular owned file'}
$handle=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
$released=$false
try {
  @{ready=$true;pid=$PID;path=$target} | ConvertTo-Json -Compress | Write-Output
  $clock=[Diagnostics.Stopwatch]::StartNew()
  while($clock.Elapsed.TotalSeconds -lt 45){if([IO.File]::Exists($env:RECOVERY_LOCK_RELEASE)){$released=$true;break};Start-Sleep -Milliseconds 20}
} finally {$handle.Dispose()}
if(-not $released){throw 'Bounded manifest sharing lock timed out before explicit release'}
@{released=$true;pid=$PID;path=$target} | ConvertTo-Json -Compress | Write-Output`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:50000,killSignal:'SIGKILL',env:{...process.env,RECOVERY_LOCK_APP_PID:String(context.pid),RECOVERY_LOCK_APP_EXE:context.executable,RECOVERY_LOCK_APP_START:context.identity.start,RECOVERY_LOCK_DIRECTORY:context.nativeDirectory,RECOVERY_LOCK_TARGET:path,RECOVERY_LOCK_RELEASE:releasePath}});context.helpers.add(child);
  let output='',acceptReady,rejectReady;const ready=new Promise((accept,reject)=>{acceptReady=accept;rejectReady=reject;});void ready.catch(()=>{});
  child.stdout.on('data',bytes=>{output+=bytes;for(const line of output.split(/\r?\n/))try{const value=JSON.parse(line);if(value.ready)acceptReady(value);}catch{}});child.stderr.on('data',bytes=>{output+=bytes;});
  const done=new Promise((accept,reject)=>{child.once('error',error=>{rejectReady(error);reject(error);});child.once('close',(code,signal)=>{context.helpers.delete(child);const error=new Error(`Manifest sharing helper exited ${code}/${signal}: ${output}`);rejectReady(error);code===0?accept({code,signal,output}):reject(error);});});void done.catch(()=>{});
  let timer;const identity=await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Owned manifest helper was not ready: ${output}`)),8000);})]).finally(()=>clearTimeout(timer));assert.equal(identity.pid,child.pid);assert.equal(identity.path.toLowerCase(),path.toLowerCase(),'The helper holds only the exact requested manifest; avoid reopening its exclusive handle');
  context.result.manifestLock={...identity,releasePath,maximumSeconds:45};
  return {async release(){writeFileSync(releasePath,'release\n',{flag:'wx'});let timer;const receipt=await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Manifest sharing helper did not release its owned handle.')),6000);})]).finally(()=>clearTimeout(timer));context.result.manifestLock.released=receipt;}};
}
async function visual(context){
  await context.start();await context.idle();const titles=[],ids=[];
  for(let index=0;index<20;index++){
    if(index)await clickWorkspaceCommand(context.page,'New');await context.idle();const before=await context.active(),title=`Étude ${String(index+1).padStart(2,'0')} — Õhtu 同じ 🎸 · Independently authored long Unicode score title for the recovery document list and narrow workstation`;
    const command={type:'setScoreInfo',title,artist:'TabPlayer original visual acceptance studies',tempo:120};const after=await context.invoke('apply_edit',{document:address(before),command});assert.equal(after.snapshot.dirty,true);assert.deepEqual(after.snapshot.project.edits.at(-1),command);titles.push(title);ids.push(before.documentId);
  }
  assert.equal(new Set(ids).size,20);const acknowledged=await context.ack({predicate:value=>value.envelope.documents.length===20&&value.envelope.documents.every((document,index)=>document.documentId===ids[index]&&document.session.project.edits.at(-1)?.title===titles[index])});context.result.longListCheckpoint={...acknowledged.receipt,documentIds:ids,titles};await context.kill('acknowledged original twenty-document visual fixture');await context.start();const prompt=await context.prompt();assert.deepEqual(await prompt.getByRole('listitem').allTextContents(),titles);context.result.screenshots=[];
  async function screenshot(state,width,height,dialogName){
    await context.page.setViewportSize({width,height});await context.page.evaluate(async()=>{await document.fonts.ready;await new Promise(accept=>requestAnimationFrame(()=>requestAnimationFrame(accept)));});
    const geometry=await context.page.evaluate(dialogName=>{
      const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight};};
      const dialog=document.querySelector('[role="dialog"]'),list=document.querySelector('.recovery-documents'),feedback=document.querySelector('.recovery-feedback');
      return {viewport:{width:innerWidth,height:innerHeight},body:rect(document.body),bodyScrollWidth:document.body.scrollWidth,documentScrollWidth:document.documentElement.scrollWidth,dialog:dialogName?rect(dialog):null,list:rect(list),feedback:rect(feedback),footer:rect(document.querySelector('footer')),focus:document.activeElement?.textContent?.slice(0,160)??null};
    },dialogName??null);
    assert.ok(geometry.bodyScrollWidth<=width+1&&geometry.documentScrollWidth<=width+1,'Page has no horizontal overflow');
    if(dialogName){await context.page.getByRole('dialog',{name:dialogName,exact:true}).waitFor();assert.ok(geometry.dialog?.width>0&&geometry.dialog.x>=-1&&geometry.dialog.y>=-1&&geometry.dialog.right<=width+1&&geometry.dialog.bottom<=height+1,'Real dialog stays inside the viewport');}
    else assert.ok(geometry.feedback?.height>0&&geometry.footer?.bottom<=height+1&&geometry.feedback.bottom<=height+1,'Recovery feedback remains visible in the viewport');
    const path=resolve(directory,`${context.prefix}-visual-${state}-${width}.png`);await context.page.screenshot({path});const bytes=readFileSync(path);assert.ok(bytes.length>1000);assert.equal(bytes.subarray(1,4).toString(),'PNG');context.result.screenshots.push({state,path,sha256:sha256(bytes),geometry,inspection:'Root must open the actual PNG and compare it with the generated concepts; capture alone does not approve appearance.'});return geometry;
  }
  const region=context.page.getByRole('region',{name:'Recoverable documents',exact:true});context.result.scrollProof=[];
  for(const [width,height]of [[960,720],[1280,900],[1600,1000]]){
    await region.evaluate(node=>{node.scrollTop=0;});await screenshot('recovery-top',width,height,'Recover unsaved work?');
    const scroll=await region.evaluate(node=>{const before=node.scrollTop;node.scrollTop=node.scrollHeight;return {before,after:node.scrollTop,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight};});assert.ok(scroll.scrollHeight>scroll.clientHeight&&scroll.after>scroll.before,'Twenty real long titles scroll inside the list');context.result.scrollProof.push({width,height,...scroll});if(width===960)await screenshot('recovery-bottom',width,height,'Recover unsaved work?');
  }
  await context.choice('Discard recovery');context.result.startNewChoice='Discard recovery (the valid crash prompt has this explicit fresh-session action; Start new session is reserved for unavailable recovery)';assert.equal((await context.workspace()).documents.length,1);assert.deepEqual((await context.active()).snapshot.project.edits,[]);
  for(const [width,height,format]of [[960,720,'gp'],[1280,900,'wav']]){
    await context.page.setViewportSize({width,height});const before=await context.active();await clickWorkspaceCommand(context.page,'Export score',{waitForIdle:false});const dialog=context.page.getByRole('dialog',{name:'Export score',exact:true});await dialog.waitFor();await dialog.getByRole('combobox',{name:'Export format',exact:true}).selectOption(format);await screenshot(`export-${format}`,width,height,'Export score');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});await context.idle();assert.deepEqual(await context.active(),before,'Opening/cancelling export does not mutate music');
  }
  const baseline=await context.ack(),lease=await holdOwnedManifest(context);let changed,failed;
  const waitStatus=async predicate=>{const deadline=Date.now()+25000;let value;do{value=await context.invoke('recovery_status');if(predicate(value))return value;await wait(25);}while(Date.now()<deadline);throw new Error(`Visual recovery status timed out: ${JSON.stringify(value)}`);};
  try{
    changed=await context.editNote(5);failed=await waitStatus(value=>value.state==='failed');assert.equal(failed.generation,baseline.receipt.generation);assert.equal(failed.capturedAtUnixMs,baseline.receipt.capturedAtUnixMs);assert.ok(failed.error);
    const feedback=context.page.locator('.recovery-feedback');await feedback.getByText(/Recovery backup failed:/).waitFor();const last=feedback.locator('time');assert.equal(new Date(await last.getAttribute('datetime')).getTime(),baseline.receipt.capturedAtUnixMs);
    await feedback.getByRole('button',{name:'Retry',exact:true}).click();await context.page.evaluate(()=>new Promise(accept=>requestAnimationFrame(()=>requestAnimationFrame(accept))));await context.page.waitForFunction(()=>{const button=Array.from(document.querySelectorAll('.recovery-feedback button')).find(node=>node.textContent==='Retry');return button&&!button.disabled;});const retryFailed=await waitStatus(value=>value.state==='failed');assert.equal(retryFailed.generation,baseline.receipt.generation);assert.equal(retryFailed.capturedAtUnixMs,baseline.receipt.capturedAtUnixMs);context.result.failedRetry={baseline:baseline.receipt,first:failed,retry:retryFailed};await screenshot('recovery-failed-retry',960,720);await screenshot('recovery-failed-retry',1280,900);
  }finally{await lease.release();}
  const preserved=checkpointAt(context.nativeDirectory);assert.equal(preserved.receipt.sha256,baseline.receipt.sha256);assert.equal(preserved.receipt.generation,baseline.receipt.generation);await context.page.locator('.recovery-feedback').getByRole('button',{name:'Retry',exact:true}).click();const ready=await context.ack({after:baseline.receipt.generation,predicate:value=>value.envelope.documents.some(document=>document.documentId===changed.documentId&&JSON.stringify(document.session.project.edits)===JSON.stringify(changed.snapshot.project.edits))});await context.page.locator('.recovery-feedback').getByText(/Recovery backup complete\./).waitFor();assert.equal(await context.page.locator('.recovery-feedback').getByRole('button',{name:'Retry',exact:true}).count(),0);context.result.successfulRetry=ready.receipt;await screenshot('recovery-ready-after-retry',1280,900);
}

export async function runRecoveryAcceptance({groups=['crash'],performance:allowPerformance=false,outputPrefix}={}){
  assert.ok(Array.isArray(groups)&&groups.length>0&&groups.every(group=>recoveryAcceptanceGroups.includes(group)));assert.equal(new Set(groups).size,groups.length);assert.equal(typeof allowPerformance,'boolean');assert.ok(!groups.includes('performance')||allowPerformance,'Performance is an additional explicit opt-in');
  const prefix=outputPrefix??`recovery-acceptance-${Date.now()}-${randomUUID()}`;assert.match(prefix,/^recovery-[a-zA-Z0-9-]+$/);assert.equal(process.platform,'win32','Native dialog/WM_CLOSE acceptance is Windows-specific');mkdirSync(directory,{recursive:true});
  const fixture=writeRecoveryFixtures(await buildRecoveryFixtures(),`${prefix}-inputs`),executable=realpathSync(resolve(directory,'tabplayer.exe'));
  const result={authored:true,prefix,fixture:fixture.metadataPath,inputs:fixture.hashes,executable,executableSha256:sha256(readFileSync(executable)),options:{groups,performance:allowPerformance},host:{platform:process.platform,arch:process.arch,node:process.version,osRelease:release(),logicalCpus:cpus().length,cpuModel:cpus()[0]?.model??null,totalMemoryBytes:totalmem()},groups:[],task8Complete:false,pendingGates:[{gate:'Clean close → Save → later native Save picker Cancel',state:'pending',reason:'The diagnostic frontend routes close Save to fixed-path desktop_test_io. Root must run its distinct isolated production-frontend/native build; the separate production save_project Cancel below cannot close this gate.'},{gate:'Recovery capture duration, overlap, >512 MiB failure and clean-exit escape',state:'pending',reason:'Requires root native/runtime measurements and oversize verification outside this bounded authored script.'},{gate:'Combined recovery/workstation viewport review and joined tests/review',state:'pending',reason:'Owned by root and not claimed by these functional groups.'}],limits:[...fixture.limits,'Actual Windows diagnostic process crashes only; no physical power-loss, GP8 runtime or macOS/Linux runtime equivalence is established.','This harness does not record or require a quiet audio window. Previously accepted W05 physical captures are not repeated.','Diagnostic close Save uses a fixed path; production Save-picker cancellation is verified separately, not claimed as close→Save→picker Cancel.','Views are prepared through the public native view command and verified through the real restored UI; no hidden frontend controller hook or recovery-envelope injection is used.','Large-asset capture duration, overlap and encoded >512 MiB escape require root native/runtime evidence; the optional real-write crash reports whether an in-flight payload was actually observed.']};
  const actions={crash,clean,paths,corruption,ownership,performance,visual};let active;
  try{for(const group of groups){const receipt={group,startedAtUnixMs:Date.now(),passed:false,passedScope:'Selected functional group assertions only; Task 8 completion requires the separate pending gates.',task8Complete:false,pendingGates:result.pendingGates};result.groups.push(receipt);active=new AcceptanceContext({prefix,group,executable,fixture,result:receipt});try{await actions[group](active);assert.deepEqual(active.errors,[]);receipt.passed=true;}catch(error){receipt.failure=String(error?.stack??error);if(active.page)try{receipt.last={workspace:await active.workspace(),body:(await active.page.locator('body').innerText()).slice(-8000)};}catch(stateError){receipt.stateError=String(stateError);}throw error;}finally{receipt.errors=active.errors;receipt.finishedAtUnixMs=Date.now();try{await active.finish();}finally{active=null;writeFileSync(resolve(directory,`${prefix}-${group}-result.json`),JSON.stringify(receipt,null,2),{flag:'wx'});}}}result.passed=true;return result;}
  catch(error){result.passed=false;result.failure=String(error?.stack??error);if(active?.page)try{result.last={workspace:await active.workspace(),body:(await active.page.locator('body').innerText()).slice(-8000)};}catch(stateError){result.stateError=String(stateError);}throw error;}
  finally{assertRecoveryFixtureHashes(fixture);const path=resolve(directory,`${prefix}-result.json`);writeFileSync(path,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({path,...result},null,2));}
}

async function selfTest(){
  let nativePathVariantChecks=0;if(process.platform==='win32'){const normal=resolve('tests/desktop/recovery-fixture.mjs'),namespaced=toNamespacedPath(normal),expected=toNamespacedPath(realpathSync.native(normal)).toLowerCase();assert.equal(canonicalFilePath(normal),expected);assert.equal(canonicalFilePath(namespaced),expected);nativePathVariantChecks=2;}
  assert.deepEqual(argumentsFor(['--group=crash,clean','--group=crash']).groups,['crash','clean']);assert.throws(()=>argumentsFor(['--group=performance']),/requires explicit/);assert.throws(()=>argumentsFor(['--group=unknown']),/Groups/);assert.throws(()=>argumentsFor([]),/bounded group/);assert.deepEqual(argumentsFor(['--group=performance','--performance']).groups,['performance']);assert.deepEqual(argumentsFor(['--group=visual']).groups,['visual']);
  const fixture=await buildRecoveryFixtures(),expected=fixture.documents.imported.expected;
  const record={snapshot:{project:{edits:expected.appliedEdits},dirty:true,canUndo:true,canRedo:true,redoEdit:expected.redoEdits[0]}};assertApplied(record,expected);
  for(const mutation of [value=>{value.snapshot.project.edits=[];},value=>{value.snapshot.dirty=false;},value=>{value.snapshot.canRedo=false;},value=>{value.snapshot.redoEdit=null;}]){const changed=structuredClone(record);mutation(changed);assert.throws(()=>assertApplied(changed,expected));}
  const blank=fixture.documents.untitled;await assertNotes({...blank.baseProject,edits:blank.expected.appliedEdits},blank.expected.appliedEvents);await assert.rejects(()=>assertNotes({...blank.baseProject,edits:[]},blank.expected.appliedEvents));
  assertDiagnostics({'manifest.json':'a','checkpoint-8.json':'b'},{'manifest.json':'a','checkpoint-8.json':'b'});assert.throws(()=>assertDiagnostics({'manifest.json':'a','checkpoint-8.json':'b'},{'manifest.json':'a'}),/preserves checkpoint/);
  const pinned={pid:80,helperPid:81,executable:resolve(directory,'tabplayer.exe'),start:'639276745465339362',sessionDirectory:resolve(directory,'resident-protocol-only'),generation:3,manifestSha256:'a'.repeat(64)};
  const ready={kind:'ready',helperPid:81,pid:80,executable:pinned.executable,utcStartTicks:pinned.start,sessionDirectory:pinned.sessionDirectory,expectedGeneration:3,expectedManifestSha256:pinned.manifestSha256};assertInterruptionPacket(ready,pinned,'ready');
  const killed={...ready,kind:'result',killed:true,timedOut:false,tempPath:resolve(pinned.sessionDirectory,'recovery-v1','.checkpoint-4.json.A1b2C3'),tempBytes:1,observedAtUnixMs:10,killAtUnixMs:11,error:null};assertInterruptionPacket(killed,pinned,'result');
  const mismatches=[{pid:82},{helperPid:83},{utcStartTicks:'639276745465339363'},{executable:resolve(directory,'other.exe')},{sessionDirectory:resolve(directory,'other-session')},{expectedGeneration:4},{expectedManifestSha256:'b'.repeat(64)},{tempPath:resolve(directory,'.checkpoint-4.json.A1b2C3')},{tempPath:resolve(pinned.sessionDirectory,'recovery-v1','.checkpoint-4.json.A1b2C3x')},{tempBytes:0},{killAtUnixMs:9},{timedOut:true},{error:'owner mismatch'}];for(const mismatch of mismatches)assert.throws(()=>assertInterruptionPacket({...killed,...mismatch},pinned,'result'));assertInterruptionPacket({...killed,killed:false,timedOut:true,error:'Missed bounded write window',tempPath:null,tempBytes:0,observedAtUnixMs:0,killAtUnixMs:0},pinned,'result');
  console.log(JSON.stringify({selfTest:true,nativePathVariantChecks,argumentChecks:6,appliedOracleSensitivityChecks:4,literalNoteOracleSensitivityChecks:1,diagnosticPayloadLossSensitivityChecks:1,residentHelperProtocolRejectionChecks:mismatches.length,appsLaunched:0,filesWritten:0}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const options=argumentsFor(process.argv.slice(2));if(options.list)console.log(recoveryAcceptanceGroups.join('\n'));else if(options.selfTest)await selfTest();else await runRecoveryAcceptance(options);}
