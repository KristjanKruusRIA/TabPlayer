// Reload acceptance: a webview reload (page.reload(); synthetic F5 and Ctrl+R never reach WebView2's accelerators) must return to the
// live session with its open documents and unsaved edits, never to "Recovery unavailable". Reuses the S14 build packet and owned-process
// checks. Build with tests/desktop/string-count-build.mjs, then: node tests/desktop/parity-reload-recovery.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';
import {assertStringCountBuild,assertStringCountIdentity,assertStringCountPortFree,stringCountEnvironment,validateStringCountArguments} from './parity-string-count.mjs';
import {buildInstrumentFixture,fixturePath} from './instrument-fixture.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));

export async function runReloadRecoveryAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'reload-recovery-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'reload-recovery.gp'),identityPath=resolve(paths.results,'launch-identity.json'),exportBase=resolve(paths.export,'reload-recovery');
  const result={format:'TabPlayerReloadRecoveryReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  let ui;
  const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot','audio_status'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
  const workspace=()=>invoke('workspace_snapshot'),record=async()=>invoke('project_snapshot',{documentId:(await workspace()).active.documentId});
  const native=()=>poll(()=>invoke('audio_status'),value=>{assert.equal(value.error,null);return value.ready&&value.generation===value.desiredGeneration;},'paused current native preparation');
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  const closeWelcome=async()=>{const library=page.getByRole('dialog',{name:'Library',exact:true});if(await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor({timeout:5000}).then(()=>true,()=>false)){await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});}};
  // open=false attaches without opening the score, for a launch that must show the recovery prompt first.
  const launch=async (session,{open=true}={})=>{
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT:exportBase,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());
    assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths.profile,listeners());
    page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    if(!open)return;
    await page.locator('.app-shell').waitFor();await closeWelcome();
    await idle();await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
  };
  // A reload must land on the workspace, never on the recovery dialog; both the dialog and the failing text are asserted absent.
  const reloaded=async how=>{
    owned();
    // A window marker and timeOrigin both die with the old document, so a call that does not reload cannot pass.
    const origin=await page.evaluate(()=>{window.__reloadMarker=true;return performance.timeOrigin;});
    await page.reload();
    await poll(()=>page.evaluate(origin=>({marker:window.__reloadMarker===true,origin:performance.timeOrigin}),origin).catch(()=>({marker:true,origin})),value=>!value.marker&&value.origin!==origin,`${how} reloaded the page`);
    await page.locator('.app-shell').waitFor();await closeWelcome();
    assert.equal(await page.getByRole('dialog',{name:/Recovery unavailable|Recover unsaved work/}).count(),0,'No recovery dialog after reload');
    assert.equal(await page.getByText('Recovery startup has already been resolved.').count(),0,'Startup was not re-resolved');
    await idle();await native();
  };
  const stop=async()=>{if(browser){await browser.close();browser=null;page=null;}if(identity&&inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);};
  try{
    ui=await import('./workstation-commands.mjs');
    await buildInstrumentFixture();writeFileSync(inputPath,readFileSync(fixturePath),{flag:'wx'});
    await launch(paths.session);
    const initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);

    // One unsaved edit: the live native session holds it, and a reload must not lose it.
    await ui.revealInspector(page);await page.getByLabel('Fret',{exact:true}).fill('3');await button('Set note');
    const edited=await record();assert.equal(edited.snapshot.dirty,true);assert.equal(edited.snapshot.project.edits.length,1);
    const before=await workspace();
    step('Unsaved edit exists before reload',{edits:edited.snapshot.project.edits.length,documents:before.documents.length});

    for(const how of ['api']){
      await reloaded(how);
      const after=await workspace();
      assert.deepEqual(after.documents.map(d=>d.documentId),before.documents.map(d=>d.documentId),`${how}: same open documents in the same order`);
      assert.equal(after.active.documentId,before.active.documentId,`${how}: same active document`);
      assert.deepEqual(await record(),edited,`${how}: unsaved edit and history intact`);
      step(`Reload by ${how} returns to the current session with unsaved work`,{documents:after.documents.length});
    }

    // The reattached webview is a full editor: a further edit applies once and undoes cleanly.
    await ui.revealInspector(page);await page.getByLabel('Fret',{exact:true}).fill('5');await button('Set note');
    assert.equal((await record()).snapshot.project.edits.length,2);await button('Undo');assert.deepEqual(await record(),edited);
    step('Editing continues after reload',{});

    // A real crash is unchanged: kill the process outright and the next launch on the same session folder still prompts,
    // and reloading while that prompt is open keeps the prompt (startup is not skipped or resolved by the reload).
    await sleep(3000);await stop();await launch(paths.session,{open:false});
    const prompt=page.getByRole('dialog',{name:'Recover unsaved work?'});await prompt.waitFor({timeout:30000});
    step('Genuine crash recovery still prompts',{});
    await page.reload();await page.getByRole('dialog',{name:'Recover unsaved work?'}).waitFor({timeout:30000});
    assert.equal(await page.getByText('Recovery startup has already been resolved.').count(),0);
    step('Reload during the recovery prompt keeps the prompt',{});
    healthy();
  }catch(error){failure=error;result.error={message:String(error),stack:error.stack};if(page)try{await page.screenshot({path:resolve(paths.results,'failure.png')});}catch{}}
  finally{
    try{await stop();}catch(error){failure??=error;}
    try{assertStringCountBuild(packet);}catch(error){failure??=error;}
    result.status=failure?'failed':'passed';result.finishedAtUtc=new Date().toISOString();writeFileSync(resolve(paths.results,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  }
  if(failure)throw failure;return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for reload recovery. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runReloadRecoveryAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name)},null,2));}
}
