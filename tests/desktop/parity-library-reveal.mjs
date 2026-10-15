import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connect,directory,launch} from './harness.mjs';
import {readDocumentRecord} from './document-context.mjs';
import {clickWorkspaceCommand,waitForWorkspaceIdle} from './workstation-commands.mjs';
import {assertLibraryFixtureHashes,libraryDirectory} from './library-fixture.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&resolve(a.replace(/^\\\\\?\\/,'')).toLowerCase()===resolve(b.replace(/^\\\\\?\\/,'')).toLowerCase();
const projectView=project=>({...structuredClone(project),assets:Object.fromEntries(Object.entries(project.assets).map(([id,asset])=>[id,{filename:asset.filename,mediaType:asset.mediaType,byteLength:Buffer.from(asset.bytesBase64,'base64').length}]))});
const ownedCheck='$p=Get-Process -Id $env:REVEAL_OWNED_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:REVEAL_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:REVEAL_OWNED_START){throw "Captured reveal process identity changed"}};';

// Paths/selections are returned only after filtering the expected fixture parent.
// All preexisting shell HWNDs are retained privately to protect reused windows.
const shellObservation=`
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class RevealWindow{
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}'
function Read-RevealWindow($window){
 $document=$window.Document
 $folder=[string]$document.Folder.Self.Path
 if(-not [string]::Equals($folder,$env:REVEAL_EXPECTED_PARENT,[StringComparison]::OrdinalIgnoreCase)){return $null}
 $handle=[long]$window.HWND
 [uint32]$windowOwner=0
 $null=[RevealWindow]::GetWindowThreadProcessId([IntPtr]$handle,[ref]$windowOwner)
 $explorer=Get-Process -Id $windowOwner -ErrorAction Stop
 if(-not [string]::Equals($explorer.Path,(Join-Path $env:WINDIR 'explorer.exe'),[StringComparison]::OrdinalIgnoreCase)){throw 'Matching folder is not hosted by Windows Explorer'}
 $selected=@();$items=$document.SelectedItems()
 for($j=0;$j -lt $items.Count;$j++){$selected+=([string]$items.Item($j).Path)}
 return @{hwnd=$handle.ToString();pid=$explorer.Id;executable=$explorer.Path;startTicks=$explorer.StartTime.ToUniversalTime().Ticks.ToString();visible=[RevealWindow]::IsWindowVisible([IntPtr]$handle);folder=$folder;selected=$selected}
}
$shell=New-Object -ComObject Shell.Application
$windows=$shell.Windows()
`;

// Root alone executes this driver; import performs no runtime work.
export async function runLibraryRevealAcceptance({execute=false,statePath}={}){
  assert.equal(execute,true,'Explicit execute:true / --run is required');
  assert.ok(typeof statePath==='string'&&isAbsolute(statePath),'Absolute prepared fixture state path is required');
  assert.equal(process.platform,'win32');
  const stateBytes=readFileSync(statePath),state=JSON.parse(stateBytes),stateSha256=hash(stateBytes);
  assert.equal(state.format,'TabPlayerLibraryAcceptance');assert.equal(state.version,1);assert.equal(state.authored,true);
  assert.ok(isAbsolute(state.workDirectory));assert.equal(resolve(statePath),resolve(state.workDirectory,'fixture-state.json'));
  const child=relative(libraryDirectory,state.workDirectory);
  assert.ok(child.startsWith('file-library-')&&!child.startsWith('..')&&!isAbsolute(child));assertLibraryFixtureHashes(state);
  const executable=realpathSync(resolve(directory,'tabplayer.exe'));
  const result={status:'running',actualWindowsRevealAcceptance:false,statePath,stateSha256,authorCheckpoint:state.authorCheckpoint,executable,executableSha256:hash(readFileSync(executable)),sourceHashes:Object.fromEntries(['src/workspace/WorkspaceLibrary.ts','src/workspace/WorkspaceApp.tsx','src-tauri/src/file_library/commands.rs','src-tauri/src/reveal.rs'].map(path=>[path,hash(readFileSync(path))])),steps:[],pending:['macOS/Linux actual folder reveal.'],limits:['Actual Windows Explorer COM/window observation only; no SH request-only acceptance.','No screenshot, physical audio or recovery lifecycle acceptance.']};
  let identity=null,browser=null,page=null,observed=null,beforeHandles=new Set();
  const errors=[],step=(name,value)=>{result.steps.push({name,atUnixMs:Date.now(),value});return value;};
  const ps=(command,extra={})=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-STA','-Command',`$ErrorActionPreference='Stop';${command}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,REVEAL_OWNED_PID:identity?String(identity.pid):'',REVEAL_OWNED_EXE:executable,REVEAL_OWNED_START:identity?.startTicks??'',REVEAL_EXPECTED_PARENT:dirname(state.sourcePath),REVEAL_EXPECTED_FILE:state.sourcePath,...extra}}).trim();
  const inspect=()=>JSON.parse(ps(`${ownedCheck}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();hwnd=$p.MainWindowHandle.ToInt64().ToString()}|ConvertTo-Json -Compress}`));
  function owned(){assert.ok(identity);const current=inspect();assert.ok(current,'Owned app must remain live');assert.equal(current.hwnd,identity.hwnd);return current;}
  const invoke=command=>page.evaluate(command=>window.__TAURI_INTERNALS__.invoke(command),command);
  const workspace=()=>invoke('workspace_snapshot');
  const idle=()=>waitForWorkspaceIdle(page,{timeout:25000});
  async function poll(action,predicate,label,timeout=30000){const until=Date.now()+timeout;let value;do{value=await action();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);throw Error(`${label}: ${JSON.stringify(value)}`);}
  async function audio(owner){assert.deepEqual((await workspace()).active,owner);const value=await invoke('audio_status');assert.deepEqual((await workspace()).active,owner);return value;}
  function shellWindows(){
    owned();const value=JSON.parse(ps(`${ownedCheck}if($null -eq $p){throw 'Owned app exited'};${shellObservation}
      $handles=@();$matches=@();for($i=0;$i -lt $windows.Count;$i++){
        $window=$windows.Item($i);if($null -eq $window){continue}
        try{$handles+=([long]$window.HWND).ToString();$folder=[string]$window.Document.Folder.Self.Path}catch{continue}
        if([string]::Equals($folder,$env:REVEAL_EXPECTED_PARENT,[StringComparison]::OrdinalIgnoreCase)){$matches+=(Read-RevealWindow $window)}
      };@{windowHandles=$handles;matches=$matches}|ConvertTo-Json -Depth 5 -Compress`));owned();return value;
  }
  function cleanupExplorer(){
    if(!observed||beforeHandles.has(observed.hwnd))return {status:'preserved',reason:'No new exclusively observed Explorer HWND; reused windows are preserved.'};
    owned();const receipt=JSON.parse(ps(`${ownedCheck}if($null -eq $p){throw 'Owned app exited'};${shellObservation}
      $expected=ConvertFrom-Json $env:REVEAL_EXPECTED_WINDOW;$receipt=@{status='preserved';reason='Captured Explorer window no longer matches or is absent.'}
      for($i=0;$i -lt $windows.Count;$i++){
        $window=$windows.Item($i);if($null -eq $window){continue}
        try{$handle=([long]$window.HWND).ToString()}catch{continue}
        if($handle -cne $expected.hwnd){continue}
        $current=Read-RevealWindow $window
        if($null -eq $current){break}
        if($current.pid -ne $expected.pid -or $current.startTicks -cne $expected.startTicks -or -not [string]::Equals($current.executable,$expected.executable,[StringComparison]::OrdinalIgnoreCase)){break}
        if(-not $current.visible -or $current.selected.Count -ne 1 -or -not [string]::Equals($current.selected[0],$env:REVEAL_EXPECTED_FILE,[StringComparison]::OrdinalIgnoreCase)){break}
        $window.Quit();$receipt=@{status='close-requested';hwnd=$current.hwnd;pid=$current.pid;startTicks=$current.startTicks;folder=$current.folder};break
      };$receipt|ConvertTo-Json -Depth 4 -Compress`,{REVEAL_EXPECTED_WINDOW:JSON.stringify(observed)}));owned();return receipt;
  }
  try{
    await new Promise((accept,reject)=>{const server=createServer();server.once('error',reject);server.listen(9223,'127.0.0.1',()=>server.close(error=>error?reject(error):accept()));});
    result.nativeDirectory=mkdtempSync(resolve(state.workDirectory,'reveal-native-'));
    const profilesBefore=new Set(readdirSync(directory).filter(name=>/^profile-\d+$/.test(name)));
    const pid=launch({TABPLAYER_TEST_SESSION_DIR:result.nativeDirectory,TABPLAYER_TEST_OPEN:state.sourcePath});
    identity=JSON.parse(ps(`$p=Get-Process -Id ${pid} -ErrorAction Stop;if(-not [string]::Equals($p.Path,$env:REVEAL_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected reveal executable'};@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();hwnd=$p.MainWindowHandle.ToInt64().ToString()}|ConvertTo-Json -Compress`));
    assert.equal(identity.pid,pid);assert.match(identity.startTicks,/^[1-9][0-9]+$/);identity=await poll(async()=>inspect(),value=>value&&value.hwnd!=='0','Captured app HWND');owned();result.identity=identity;
    browser=await connect();owned();page=browser.contexts()[0].pages()[0];assert.ok(page);page.setDefaultTimeout(25000);page.on('pageerror',error=>errors.push(error.message));await page.locator('.app-shell').waitFor();
    const profiles=readdirSync(directory).filter(name=>/^profile-\d+$/.test(name)&&!profilesBefore.has(name));assert.equal(profiles.length,1);result.profileDirectory=resolve(directory,profiles[0]);
    const welcome=page.getByRole('dialog',{name:'Library',exact:true});await welcome.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await welcome.getByRole('button',{name:'Close',exact:true}).click();await welcome.waitFor({state:'hidden'});await idle();await clickWorkspaceCommand(page,'Open');await idle();
    const before=await workspace(),owner={...before.active},record=await readDocumentRecord(page,owner.documentId);assert.ok(samePath(record.snapshot.path,state.sourcePath));assert.equal(record.snapshot.dirty,false);assert.deepEqual(record.snapshot.project,projectView(state.project));
    const nativeBefore=await poll(()=>audio(owner),value=>value.ready&&!value.error&&!value.playing,'Native source ready/stopped');
    const shellBefore=shellWindows();beforeHandles=new Set(shellBefore.windowHandles);step('Before actual File reveal',{workspace:before,record,audio:nativeBefore,matchingExplorerWindows:shellBefore.matches});
    assert.equal(shellBefore.matches.some(value=>value.visible&&samePath(value.folder,dirname(state.sourcePath))&&value.selected.length===1&&samePath(value.selected[0],state.sourcePath)),false,'Inconclusive baseline: an existing visible Explorer window already has the exact source selected; preserve it and do not invoke reveal');
    owned();const file=page.locator('summary').filter({hasText:/^File$/});if(!await file.evaluate(node=>node.parentElement.open))await file.click();await page.getByRole('button',{name:'Open containing folder',exact:true}).click();await idle();owned();
    const windows=await poll(async()=>shellWindows().matches,values=>values.some(value=>value.visible&&samePath(value.folder,dirname(state.sourcePath))&&value.selected.length===1&&samePath(value.selected[0],state.sourcePath)),'Actual visible Explorer folder and selected source file');
    observed=windows.find(value=>value.visible&&samePath(value.folder,dirname(state.sourcePath))&&value.selected.length===1&&samePath(value.selected[0],state.sourcePath));assert.match(observed.startTicks,/^[1-9][0-9]+$/);assert.ok(observed.pid>0&&observed.hwnd!=='0');
    assert.equal(await page.locator('.session-error[role="alert"]').filter({hasText:'Library:'}).count(),0,'Actual File reveal must not report a caught Library error');
    const after=await workspace(),nativeAfter=await audio(owner);assert.deepEqual(after,before);assert.deepEqual(await readDocumentRecord(page,owner.documentId),record);
    for(const key of ['generation','desiredGeneration','ready','playing','tick','seconds','durationSeconds','speed','metronome','error','deviceId','backingDurationSeconds','practice','loop','range'])assert.deepEqual(nativeAfter[key],nativeBefore[key],`Reveal preserves native audio ${key}`);
    assert.deepEqual(errors,[]);assertLibraryFixtureHashes(state);assert.equal(hash(readFileSync(statePath)),stateSha256);
    step('Actual Explorer observation',{window:observed,wasExistingWindow:beforeHandles.has(observed.hwnd),workspace:after,record:await readDocumentRecord(page,owner.documentId),audio:nativeAfter});result.status='passed';result.actualWindowsRevealAcceptance=true;return result;
  }catch(error){result.status='failed';step('Failure',{error:String(error),pageErrors:errors});error.libraryRevealResult=result;throw error;}
  finally{
    try{if(identity&&inspect()){owned();try{step('Explorer cleanup',cleanupExplorer());}catch(error){step('Explorer window preserved',{reason:String(error)});}finally{owned();step('Exact owned app cleanup',ps(`${ownedCheck}if($null -eq $p){throw 'Owned app exited'};Stop-Process -Id $p.Id;$null=$p.WaitForExit(5000);'Captured reveal instance terminated'`));}}}
    finally{if(browser)await browser.close();assertLibraryFixtureHashes(state);assert.equal(hash(readFileSync(statePath)),stateSha256);result.stateSha256After=hash(readFileSync(statePath));result.resultPath=resolve(state.workDirectory,'outputs',`library-reveal-${Date.now()}-result.json`);writeFileSync(result.resultPath,JSON.stringify(result,null,2),{flag:'wx'});}
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options={};for(const arg of process.argv.slice(2)){if(arg==='--run')options.execute=true;else if(arg.startsWith('--state='))options.statePath=arg.slice(8);else throw Error('Explicit --run --state=<absolute prepared fixture-state.json> required');}
  console.log(JSON.stringify(await runLibraryRevealAcceptance(options),null,2));
}
