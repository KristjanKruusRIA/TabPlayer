// Native OLE file-drop acceptance driver.
// Run: node tests/desktop/parity-file-drop.mjs --run --state=<absolute prepared fixture-state.json> [--replay-consumed]
// Prepare the state first with: node tests/desktop/parity-file-library.mjs --prepare
//
// The OS-level drop needs the test window in the foreground. The driver asks for it with a bounded retry (a restore,
// AllowSetForegroundWindow for the app's own process, SetForegroundWindow, and the AttachThreadInput pattern from
// select-library-folder.ps1). It sends no key presses and never takes another process's input by force. If Windows still
// refuses, that is an environment limit, not a failed assertion, and it is reported separately.
//
// Exit codes (the final stdout line is the verdict word):
//   0  PASSED            every drop assertion held.
//   1  FAILED            an assertion or the app failed, or the arguments were wrong. A real failure.
//   3  NEEDS FOREGROUND  Windows would not give the test window the foreground after every retry. No drop was sent in
//                        that step and no drop assertion was evaluated or relaxed. Rerun with nothing else holding focus.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {basename,isAbsolute,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connect,directory,launch} from './harness.mjs';
import {readDocumentRecord} from './document-context.mjs';
import {clickWorkspaceCommand,clickWorkstationButton,waitForWorkspaceIdle} from './workstation-commands.mjs';
import {assertLibraryFixtureHashes,libraryDirectory} from './library-fixture.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const helper='tests/desktop/drop-score-files.ps1',helperHash='e62909d473897920a941138b7ef3c93145706c07306311906f27e1425e0965b8';
const pathKey=path=>resolve(path.replace(/^\\\\\?\\/,'')).toLowerCase();
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&pathKey(a)===pathKey(b);
const projectView=project=>({...structuredClone(project),assets:Object.fromEntries(Object.entries(project.assets).map(([id,asset])=>[id,{filename:asset.filename,mediaType:asset.mediaType,byteLength:Buffer.from(asset.bytesBase64,'base64').length}]))});
const ownedCheck='$p=Get-Process -Id $env:DROP_OWNED_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:DROP_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:DROP_OWNED_START){throw "Captured drop process identity changed"}};';
const windowSource=`using System;using System.Runtime.InteropServices;public static class OwnedDropWindow{
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect r);
 [StructLayout(LayoutKind.Sequential)] public struct Rect{public int Left,Top,Right,Bottom;}
}`;

/** Windows would not give the owned window the foreground. An environment limit, not a failed drop assertion. */
export class NeedsForegroundError extends Error{constructor(message,attempts){super(message);this.name='NeedsForegroundError';this.attempts=attempts;}}
export const exitCodes={passed:0,failed:1,needsForeground:3};
const foregroundAttempts=4,foregroundPauseMs=750;
// One foreground request. Refusal is reported as foreground:false so the caller can retry; identity errors still throw.
const foregroundScript=`${ownedCheck}if($null -eq $p){throw 'Owned app exited'};$p.Refresh();$h=$p.MainWindowHandle;if($h.ToInt64().ToString() -cne $env:DROP_OWNED_HWND){throw 'Owned HWND changed'};Add-Type -TypeDefinition '${windowSource}';[uint32]$owner=0;$null=[OwnedDropWindow]::GetWindowThreadProcessId($h,[ref]$owner);if($owner -ne $p.Id){throw 'HWND owner changed'};if([OwnedDropWindow]::IsIconic($h)){$null=[OwnedDropWindow]::ShowWindow($h,9)};$null=[OwnedDropWindow]::AllowSetForegroundWindow($p.Id);$asked=[OwnedDropWindow]::SetForegroundWindow($h);if([OwnedDropWindow]::GetAncestor([OwnedDropWindow]::GetForegroundWindow(),2) -ne $h){$holder=[OwnedDropWindow]::GetWindowThreadProcessId([OwnedDropWindow]::GetForegroundWindow(),[ref]$owner);$me=[OwnedDropWindow]::GetCurrentThreadId();$attached=($holder -ne 0 -and $holder -ne $me -and [OwnedDropWindow]::AttachThreadInput($me,$holder,$true));try{$null=[OwnedDropWindow]::BringWindowToTop($h);$asked=[OwnedDropWindow]::SetForegroundWindow($h)}finally{if($attached){$null=[OwnedDropWindow]::AttachThreadInput($me,$holder,$false)}}};Start-Sleep -Milliseconds 100;$front=([OwnedDropWindow]::GetAncestor([OwnedDropWindow]::GetForegroundWindow(),2) -eq $h);if(-not $front){@{foreground=$false;asked=[bool]$asked}|ConvertTo-Json -Compress}else{$r=New-Object OwnedDropWindow+Rect;if(-not [OwnedDropWindow]::GetClientRect($h,[ref]$r)){throw 'Client rectangle unavailable'};@{foreground=$true;hwnd=$h.ToInt64().ToString();width=$r.Right-$r.Left;height=$r.Bottom-$r.Top}|ConvertTo-Json -Compress}`;

// Inert on import. Root alone runs this against its isolated diagnostic binary.
export async function runFileDropAcceptance({execute=false,statePath,replayConsumed=false}={}){
  assert.equal(execute,true,'Explicit execute:true / --run is required');
  assert.equal(typeof replayConsumed,'boolean');
  assert.ok(typeof statePath==='string'&&isAbsolute(statePath),'Absolute existing fixture state path is required');
  assert.equal(process.platform,'win32');
  const stateBytes=readFileSync(statePath),state=JSON.parse(stateBytes),stateSha256=hash(stateBytes);
  assert.equal(state.format,'TabPlayerLibraryAcceptance');assert.equal(state.version,1);assert.equal(state.authored,true);
  assert.ok(isAbsolute(state.workDirectory));assert.equal(resolve(statePath),resolve(state.workDirectory,'fixture-state.json'));
  assert.ok(relative(libraryDirectory,state.workDirectory).startsWith('file-library-')&&!relative(libraryDirectory,state.workDirectory).startsWith('..'));
  assertLibraryFixtureHashes(state);assert.equal(hash(readFileSync(helper)),helperHash);
  const executable=realpathSync(resolve(directory,'tabplayer.exe'));
  const result={status:'running',actualOSDropAcceptance:false,statePath,stateSha256,authorCheckpoint:state.authorCheckpoint,executable,executableSha256:hash(readFileSync(executable)),helperSha256:helperHash,sourceHashes:Object.fromEntries(['src/main.tsx','src/workspace/WorkspaceLibrary.ts','src/workspace/WorkspaceController.ts','src-tauri/src/lib.rs','src-tauri/src/file_library/commands.rs'].map(path=>[path,hash(readFileSync(path))])),steps:[],groups:[],pending:['Real OS drops during export and a session transition.','macOS/Linux drop and reveal behavior.','No public observer exists for the native candidate registry; exact tab counts and optional one-time token rejection do not inspect that registry.'],limits:['Actual native OLE source and Tauri callback proof only; no Explorer/manual mouse drag claim.','No audio, long score, screenshot or recovery lifecycle acceptance.']};
  let identity=null,browser=null,page=null,listenerInstalled=false;
  const errors=[],step=(name,value)=>{result.steps.push({name,atUnixMs:Date.now(),value});return value;};
  const ps=(command,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,...extra,DROP_OWNED_PID:identity?String(identity.pid):'',DROP_OWNED_EXE:executable,DROP_OWNED_START:identity?.startTicks??''}}).trim();
  const inspect=()=>JSON.parse(ps(`${ownedCheck}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();hwnd=$p.MainWindowHandle.ToInt64().ToString()}|ConvertTo-Json -Compress}`));
  const owned=()=>{assert.ok(identity);const value=inspect();assert.ok(value,'Captured app is no longer live');assert.equal(value.hwnd,identity.hwnd);return value;};
  const invoke=(command,args={})=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
  const workspace=()=>invoke('workspace_snapshot'),record=id=>readDocumentRecord(page,id);
  const idle=()=>waitForWorkspaceIdle(page,{timeout:25000});
  const dialog=()=>page.getByRole('dialog',{name:'Library',exact:true});
  async function poll(action,predicate,label,timeout=25000){const end=Date.now()+timeout;let value;do{value=await action();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<end);throw Error(`${label}: ${JSON.stringify(value)}`);}
  async function checkpoint(source){return poll(async()=>{try{const bytes=readFileSync(resolve(result.nativeDirectory,'recovery-v1/manifest.json')),manifest=JSON.parse(bytes);assert.equal(manifest.lifecycle,'running');const payload=readFileSync(resolve(result.nativeDirectory,`recovery-v1/checkpoint-${manifest.current.generation}.json`));assert.equal(hash(payload),manifest.current.sha256);const envelope=JSON.parse(payload);assert.equal(envelope.epoch,manifest.epoch);assert.equal(envelope.generation,manifest.current.generation);assert.equal(hash(readFileSync(resolve(result.nativeDirectory,'recovery-v1/manifest.json'))),hash(bytes));const document=envelope.documents.find(item=>item.documentId===source.documentId);if(document?.revision!==source.revision)return null;return {manifest,document,payloadSha256:hash(payload)};}catch{return null;}},value=>value?.document?.session.cursor===1,'Exact source history acknowledged on disk');}
  async function closeLibrary(){await dialog().getByRole('button',{name:'Close',exact:true}).click();await dialog().waitFor({state:'hidden'});await idle();}
  async function events(){return page.evaluate(()=>structuredClone(window.__ownedFileDropProbe.events));}
  async function drop(paths,target){
    owned();assert.equal(hash(readFileSync(helper)),helperHash);for(const path of paths){assert.ok(isAbsolute(path));const child=relative(state.workDirectory,path);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));}
    const point=await target.evaluate(node=>{const r=node.getBoundingClientRect();const left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);if(right<=left||bottom<=top)throw Error('Drop target has no visible client area');return {x:(left+right)/2,y:(top+bottom)/2,width:innerWidth,height:innerHeight};});
    // Exact owned HWND only, no key presses. A bounded retry; a persistent refusal is NeedsForegroundError, never a failed assertion.
    let native=null;for(let attempt=1;attempt<=foregroundAttempts&&!native;attempt++){const reply=JSON.parse(ps(foregroundScript,{DROP_OWNED_HWND:identity.hwnd}));if(reply.foreground)native=reply;else{step('Foreground request refused',{attempt,asked:reply.asked});if(attempt<foregroundAttempts)await new Promise(accept=>setTimeout(accept,foregroundPauseMs));}}
    if(!native)throw new NeedsForegroundError(`Windows refused the owned foreground request in ${foregroundAttempts} attempts; another window holds the foreground.`,foregroundAttempts);
    assert.ok(native.width>0&&native.height>0);const clientX=Math.floor(point.x*native.width/point.width),clientY=Math.floor(point.y*native.height/point.height);assert.ok(clientX>=0&&clientX<native.width&&clientY>=0&&clientY<native.height);
    const beforeEvents=await events();owned();const startedAtUnixMs=Date.now();
    const receipt=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',resolve(helper),'-AppProcessId',String(identity.pid),'-AppExecutable',executable,'-AppStartTicks',identity.startTicks,'-TargetWindowHandle',identity.hwnd,'-ClientX',String(clientX),'-ClientY',String(clientY),'-OwnedDirectory',state.workDirectory,'-FilePathsJson',JSON.stringify(paths)],{encoding:'utf8',windowsHide:true,timeout:20000}));
    owned();assert.equal(receipt.kind,'native-ole-source-completed');assert.equal(receipt.pid,identity.pid);assert.ok(samePath(receipt.executable,executable));assert.equal(String(receipt.utcStartTicks),identity.startTicks);assert.equal(String(receipt.window),identity.hwnd);assert.equal(receipt.hresult,262400);assert.equal(receipt.effect,1);assert.ok(receipt.queryCount>0&&receipt.feedbackCount>0);assert.equal(receipt.files.length,paths.length);
    receipt.files.forEach((file,index)=>{assert.ok(samePath(file.path,paths[index]));const bytes=readFileSync(paths[index]);assert.equal(file.bytes,bytes.length);assert.equal(file.sha256,hash(bytes));});
    const observed=await poll(events,value=>value.length>beforeEvents.length,'Actual native score-files-dropped event');assert.equal(observed.length,beforeEvents.length+1);const event=observed.at(-1);assert.equal(event.event,'score-files-dropped');assert.equal(event.payload.count,paths.length);assert.equal(typeof event.payload.dropToken,'string');assert.ok(event.payload.dropToken.length>0);assert.ok(event.atUnixMs>=startedAtUnixMs);
    return {receipt,event,point:{css:point,native,clientX,clientY}};
  }
  try{
    await new Promise((accept,reject)=>{const server=createServer();server.once('error',reject);server.listen(9223,'127.0.0.1',()=>server.close(error=>error?reject(error):accept()));});
    result.nativeDirectory=mkdtempSync(resolve(state.workDirectory,'drop-native-'));const profilesBefore=new Set(readdirSync(directory).filter(name=>/^profile-\d+$/.test(name)));
    const pid=launch({TABPLAYER_TEST_SESSION_DIR:result.nativeDirectory,TABPLAYER_TEST_OPEN:state.sourcePath});
    identity=JSON.parse(ps(`$p=Get-Process -Id ${pid} -ErrorAction Stop;if(-not [string]::Equals($p.Path,$env:DROP_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected drop executable'};@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();hwnd=$p.MainWindowHandle.ToInt64().ToString()}|ConvertTo-Json -Compress`));assert.equal(identity.pid,pid);assert.match(identity.startTicks,/^[1-9][0-9]+$/);
    // HWND can be created after Start-Process; capture it once before any boundary.
    identity=await poll(async()=>inspect(),value=>value&&value.hwnd!=='0','Owned main HWND');owned();result.identity=identity;browser=await connect();owned();page=browser.contexts()[0].pages()[0];assert.ok(page);page.setDefaultTimeout(25000);page.on('pageerror',error=>errors.push(error.message));await page.locator('.app-shell').waitFor();
    const profiles=readdirSync(directory).filter(name=>/^profile-\d+$/.test(name)&&!profilesBefore.has(name));assert.equal(profiles.length,1);result.profileDirectory=resolve(directory,profiles[0]);step('Owned diagnostic launch',identity);
    await dialog().getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await closeLibrary();await clickWorkspaceCommand(page,'Open');await idle();
    let ws=await workspace();const sourceId=ws.active.documentId,opened=await record(sourceId);assert.ok(samePath(opened.snapshot.path,state.sourcePath));assert.deepEqual(opened.snapshot.project,projectView(state.project));await clickWorkstationButton(page,'Undo');await idle();const source=await record(sourceId);assert.equal(source.snapshot.dirty,true);assert.equal(source.snapshot.canUndo,true);assert.equal(source.snapshot.canRedo,true);assert.deepEqual(source.snapshot.project.edits,state.project.edits.slice(0,1));assert.deepEqual(source.snapshot.redoEdit,state.project.edits[1]);const acknowledged=await checkpoint(source);assert.deepEqual(acknowledged.document.session.project,state.project);assert.deepEqual(acknowledged.document.session.saved,state.project.edits);step('Real File Open and Undo dirty/full redo',{source,acknowledged});
    await page.evaluate(async()=>{if(window.__ownedFileDropProbe)throw Error('Drop probe already installed');const probe={events:[]};window.__ownedFileDropProbe=probe;const handler=window.__TAURI_INTERNALS__.transformCallback(event=>probe.events.push({atUnixMs:Date.now(),event:event.event,id:event.id,payload:structuredClone(event.payload)}));probe.id=await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'score-files-dropped',target:{kind:'Any'},handler});});listenerInstalled=true;
    ws=await workspace();const prior=await Promise.all(ws.documents.map(item=>record(item.documentId)));
    const alias=resolve(state.sourcePath,'..',basename(state.sourcePath).toUpperCase());assert.notEqual(alias,state.sourcePath);assert.equal(hash(readFileSync(alias)),state.hashes[state.sourcePath]);
    const mixed=await drop([alias,state.folderOther,state.invalidPath,state.unsupportedPath,state.sourcePath],page.locator('.score-workspace'));
    const alert=page.locator('.session-error[role="alert"]').filter({hasText:/3 scores opened\./});await alert.waitFor({state:'visible'});await idle();const message=await alert.innerText();assert.ok(message.includes('Unsupported score file:'));assert.ok(message.includes(basename(state.unsupportedPath)));assert.ok(/schema|version|incompatible|project/i.test(message));assert.ok(message.length<2000,'Bounded visible per-item errors');
    const afterMixed=await workspace();assert.equal(afterMixed.documents.length,ws.documents.length+1);assert.equal(afterMixed.active.documentId,sourceId);for(const original of prior)assert.deepEqual(await record(original.documentId),original);const added=afterMixed.documents.filter(item=>!ws.documents.some(old=>old.documentId===item.documentId));assert.equal(added.length,1);const crate=await record(added[0].documentId);assert.ok(samePath(crate.snapshot.path,state.folderOther));assert.deepEqual(crate.snapshot.project,projectView(state.other));assert.equal(crate.snapshot.dirty,false);assert.equal(crate.snapshot.canUndo,false);assert.equal(crate.snapshot.canRedo,false);assert.deepEqual((await checkpoint(source)).document.session,acknowledged.document.session);
    let replay={status:'not-requested'};if(replayConsumed){assert.ok(Date.now()-mixed.event.atUnixMs<25000,'Replay must precede the native 30-second TTL');let rejection;try{await invoke('workspace_drop_stage',{dropToken:mixed.event.payload.dropToken,index:0});}catch(error){rejection=String(error);}assert.match(rejection??'',/already consumed/);assert.deepEqual(await workspace(),afterMixed);assert.deepEqual(await record(sourceId),source);replay={status:'passed',kind:'Actual native callback token replay; not an OS stale-drop event',rejection};}
    result.groups.push({name:'mixed-actual-native-OLE-drop',status:'passed',...mixed,message,workspace:afterMixed,crate,replay});
    const file=page.locator('summary').filter({hasText:/^File$/});if(!await file.evaluate(node=>node.parentElement.open))await file.click();await page.getByRole('button',{name:'Library',exact:true}).click();await dialog().waitFor();assert.equal(await page.locator('.app-shell').getAttribute('aria-busy'),'true');
    const held=await workspace(),heldRecords=await Promise.all(held.documents.map(item=>record(item.documentId)));const busy=await drop([state.folderOther],dialog());
    const rejected=page.locator('.session-error[role="alert"]').filter({hasText:'Finish the current Library operation before dropping scores.'});await rejected.waitFor({state:'visible',timeout:5000});assert.equal(await dialog().isVisible(),true);assert.deepEqual(await workspace(),held);for(const original of heldRecords)assert.deepEqual(await record(original.documentId),original);const rejectionText=await rejected.innerText();await closeLibrary();assert.deepEqual(await workspace(),held);assert.deepEqual(await record(sourceId),source);assert.deepEqual((await checkpoint(source)).document.session,acknowledged.document.session);assert.deepEqual(errors,[]);
    result.groups.push({name:'actual-OLE-drop-with-Library-lease',status:'passed',...busy,message:rejectionText,workspace:held,leaseReleased:true});assertLibraryFixtureHashes(state);assert.equal(hash(readFileSync(statePath)),stateSha256);result.status='passed';result.actualOSDropAcceptance=true;return result;
  }catch(error){result.status=error instanceof NeedsForegroundError?'needs-foreground':'failed';step(result.status==='failed'?'Failure':'Needs foreground',{error:String(error),pageErrors:errors});error.fileDropResult=result;throw error;}
  finally{
    try{if(identity&&inspect()){owned();try{if(listenerInstalled&&page&&!page.isClosed()){await page.evaluate(async()=>{const probe=window.__ownedFileDropProbe;window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener('score-files-dropped',probe.id);await window.__TAURI_INTERNALS__.invoke('plugin:event|unlisten',{event:'score-files-dropped',eventId:probe.id});delete window.__ownedFileDropProbe;});}}finally{owned();step('Exact owned diagnostic cleanup',ps(`${ownedCheck}if($null -eq $p){throw 'Owned app exited'};Stop-Process -Id $p.Id;$null=$p.WaitForExit(5000);'Captured drop instance terminated'`));}}}
    finally{if(browser)await browser.close();assertLibraryFixtureHashes(state);assert.equal(hash(readFileSync(statePath)),stateSha256);result.stateSha256After=hash(readFileSync(statePath));result.resultPath=resolve(state.workDirectory,'outputs',`native-ole-drop-${Date.now()}-result.json`);writeFileSync(result.resultPath,JSON.stringify(result,null,2),{flag:'wx'});}
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options={};for(const arg of process.argv.slice(2)){if(arg==='--run')options.execute=true;else if(arg.startsWith('--state='))options.statePath=arg.slice(8);else if(arg==='--replay-consumed')options.replayConsumed=true;else throw Error('Explicit --run --state=<absolute prepared fixture-state.json> [--replay-consumed] required');}
  try{
    console.log(JSON.stringify(await runFileDropAcceptance(options),null,2));
    console.log('PASSED');process.exitCode=exitCodes.passed;
  }catch(error){
    if(error instanceof NeedsForegroundError){
      console.log(JSON.stringify({status:'needs-foreground',message:error.message,attempts:error.attempts,resultPath:error.fileDropResult?.resultPath},null,2));
      console.log('NEEDS FOREGROUND');process.exitCode=exitCodes.needsForeground;
    }else{console.error(error);console.log('FAILED');process.exitCode=exitCodes.failed;}
  }
}
