// W15 desktop acceptance: a finalized document refuses edits natively, keeps its mixer and redo stack, and stays finalized
// across save, restart and reopen until it is unfinalized. Reuses the S14 build packet and owned-process checks. Build with
// tests/desktop/string-count-build.mjs, then: node tests/desktop/parity-finalize.mjs --run --build=<absolute build.json>
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
const finalized={kind:'finalized'},refusal='This document is finalized. Unfinalize it to make changes.';
const target={track:0,staff:0,bar:0,voice:0,beat:0},banner='Finalized: editing is locked.';
const setNote=fret=>({type:'setNote',target,string:5,fret});

export async function runFinalizeAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'finalize-')),paths=Object.fromEntries(['session','fresh-session','profile','app-data','input','saved','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'finalize.gp'),savePath=resolve(paths.saved,'finalize.tabplayer'),identityPath=resolve(paths.results,'launch-identity.json');
  const result={format:'TabPlayerFinalizeReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],launches:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  let ui;
  const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot','audio_status','apply_edit','undo_edit','redo_edit'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args).then(value=>({value}),error=>({error:String(error)})),[command,args]);healthy();return value;};
  const value=async(command,args)=>{const outcome=await invoke(command,args);assert.equal(outcome.error,undefined,command);return outcome.value;};
  const workspace=()=>value('workspace_snapshot'),record=async()=>value('project_snapshot',{documentId:(await workspace()).active.documentId});
  const address=current=>({documentId:current.documentId,revision:current.revision});
  const native=()=>poll(()=>value('audio_status'),status=>{assert.equal(status.error,null);return status.ready&&status.generation===status.desiredGeneration;},'paused current native preparation');
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  const control=name=>page.getByRole('button',{name,exact:true}).first();
  const screenshot=async name=>{await page.screenshot({path:resolve(paths.results,name)});result.screenshots.push(name);};
  const refused=async(command,args)=>{const before=await record(),outcome=await invoke(command,args);assert.ok(outcome.error?.includes(refusal),`${command} is refused: ${JSON.stringify(outcome)}`);assert.deepEqual(await record(),before,`${command} changes nothing`);};
  const launch=async({session,open})=>{
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_OPEN:open,TABPLAYER_TEST_SAVE:savePath,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());result.launches.push(identity);
    assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths.profile,listeners());
    page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    await page.locator('.app-shell').waitFor();
  };
  const dismissLibrary=async()=>{const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});await idle();};
  const scoreReady=async()=>{await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();};
  // Only a saved document may come here: a clean close asks nothing, and the session then ends with a clean checkpoint.
  const close=async()=>{
    assert.equal((await record()).snapshot.dirty,false,'Close only saved documents');const closed=page.waitForEvent('close',{timeout:25000});void closed.catch(()=>{});
    ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};if(-not $p.CloseMainWindow()){throw 'Owned window rejected close message'}`);await closed;
    await poll(async()=>inspect(),actual=>actual===null,'clean exit');await browser.close();browser=null;page=null;identity=null;await poll(portRows,rows=>rows.length===0,'CDP port released');
  };
  const assertLocked=async expected=>{const current=await record();assert.deepEqual(current.snapshot.project.lock??null,expected,'Native lock');assert.equal(await page.getByText(banner,{exact:true}).count(),expected?1:0,'Banner follows the lock');return current;};
  const fileProject=()=>json(savePath);
  try{
    ui=await import('./workstation-commands.mjs');
    await buildInstrumentFixture();writeFileSync(inputPath,readFileSync(fixturePath),{flag:'wx'});result.input={inputPath,sha256:sha256(readFileSync(inputPath))};

    // First session: two edits with the second undone, so history and redo both exist when the lock lands.
    await launch({session:paths.session,open:inputPath});await dismissLibrary();await button('Open');await scoreReady();
    await ui.revealInspector(page);await button('Edit');
    const write=async fret=>{await page.getByRole('combobox',{name:'String',exact:true}).selectOption('5');await page.getByLabel('Fret',{exact:true}).fill(String(fret));await button('Set note');};
    await write(3);await write(5);await button('Undo');
    const unlocked=await assertLocked(null);assert.deepEqual(unlocked.snapshot.project.edits,[setNote(3)]);assert.deepEqual(unlocked.snapshot.redoEdit,setNote(5));assert.equal(unlocked.snapshot.canRedo,true);

    await button('Finalize document');await page.getByText(banner,{exact:true}).waitFor();
    await control('Unfinalize').click();await idle();await page.getByText(banner,{exact:true}).waitFor({state:'hidden'});assert.equal((await assertLocked(null)).snapshot.canRedo,true,'Finalizing and unfinalizing keep redo');
    await button('Finalize document');await page.getByText(banner,{exact:true}).waitFor();
    const locked=await assertLocked(finalized);assert.equal(locked.snapshot.dirty,true,'Finalizing is an unsaved change');assert.deepEqual(locked.snapshot.project.edits,unlocked.snapshot.project.edits,'The lock is not a history entry');
    for(const name of ['Set note','Undo','Redo'])assert.equal(await control(name).isDisabled(),true,`${name} is disabled`);
    await screenshot('01-finalized.png');step('Finalize shows the banner, disables editing and marks the document unsaved',{document:address(locked)});

    await refused('apply_edit',{document:address(locked),command:setNote(7),assetToken:null});await refused('undo_edit',{document:address(locked)});await refused('redo_edit',{document:address(locked)});
    step('Direct native edit, undo and redo are refused with the history unchanged',{refusal});

    await ui.revealDock(page,'Mixer');const channel=page.getByRole('region',{name:/^Channel 1: /});const mute=channel.getByRole('checkbox',{name:'Mute',exact:true});await mute.click();await idle();
    const mixed=await poll(record,current=>current.snapshot.project.edits.length===2,'mixer edit');assert.equal(mixed.snapshot.project.edits.at(-1).type,'setTrackMix');assert.equal(mixed.snapshot.project.edits.at(-1).mix.mute,true);assert.equal(mixed.snapshot.canRedo,false,'A mixer move clears redo like any edit');
    await assertLocked(finalized);step('The mixer still works, and clears redo like any edit',{edit:mixed.snapshot.project.edits.at(-1)});

    await button('Save');const saved=await poll(record,current=>!current.snapshot.dirty,'saved');assert.deepEqual(saved.snapshot.project.lock,finalized);assert.deepEqual(fileProject().lock,finalized,'The file stores the lock');
    const savedHash=sha256(readFileSync(savePath));step('Save writes the lock and clears the unsaved state',{savePath,sha256:savedHash});

    // Second launch on the same session: the clean checkpoint restores the document with no prompt.
    await close();await launch({session:paths.session,open:inputPath});await scoreReady();await idle();assert.equal(await page.getByRole('dialog').count(),0,'A clean restart asks nothing');
    const restarted=await assertLocked(finalized);assert.equal(restarted.documentId,saved.documentId);assert.equal(restarted.snapshot.dirty,false);assert.deepEqual(restarted.snapshot.project.edits,saved.snapshot.project.edits);
    await refused('apply_edit',{document:address(restarted),command:setNote(7),assetToken:null});await screenshot('02-restarted.png');step('A restart on the same session is still finalized and still refuses edits',{document:address(restarted)});

    // Third launch on a fresh session: only the saved file carries the lock.
    await close();await launch({session:paths['fresh-session'],open:savePath});await dismissLibrary();await button('Open');await scoreReady();
    const reopened=await assertLocked(finalized);assert.equal(reopened.snapshot.dirty,false);assert.deepEqual(reopened.snapshot.project.edits,saved.snapshot.project.edits);
    await refused('undo_edit',{document:address(reopened)});step('The saved file reopens finalized in a fresh session',{document:address(reopened)});

    await control('Unfinalize').click();await idle();await page.getByText(banner,{exact:true}).waitFor({state:'hidden'});
    const unfinalized=await assertLocked(null);assert.equal(unfinalized.snapshot.dirty,true,'Unfinalizing is an unsaved change');
    await ui.revealInspector(page);await button('Edit');await write(9);
    const edited=await poll(record,current=>current.snapshot.project.edits.length===3,'accepted edit');assert.deepEqual(edited.snapshot.project.edits.at(-1),setNote(9));
    await button('Save');await poll(record,current=>!current.snapshot.dirty,'saved unlocked');assert.notEqual(sha256(readFileSync(savePath)),savedHash);assert.equal('lock' in fileProject(),false,'An unlocked file has no lock field');
    step('Unfinalize allows edits, and Save removes the lock',{edit:edited.snapshot.project.edits.at(-1)});

    await close();await launch({session:paths['fresh-session'],open:savePath});await scoreReady();await idle();assert.equal(await page.getByRole('dialog').count(),0,'A clean restart asks nothing');
    const final=await assertLocked(null);assert.equal(final.snapshot.dirty,false);assert.deepEqual(final.snapshot.project.edits,edited.snapshot.project.edits);await screenshot('03-unlocked.png');
    step('After a restart the document opens unlocked with its edits',{document:address(final)});
    await close();healthy();
  }catch(error){failure=error;result.error={message:String(error),stack:error.stack};if(page)try{await page.screenshot({path:resolve(paths.results,'failure.png')});}catch{}}
  finally{
    try{if(browser)await browser.close();if(identity&&inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);}catch(error){failure??=error;}
    try{assertStringCountBuild(packet);}catch(error){failure??=error;}
    result.status=failure?'failed':'passed';result.finishedAtUtc=new Date().toISOString();writeFileSync(resolve(paths.results,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  }
  if(failure)throw failure;return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for finalizing a document. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runFinalizeAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name)},null,2));}
}
