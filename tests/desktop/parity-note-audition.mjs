// S16/E17 desktop acceptance: string, tuning and edit auditions reach the native output. Reuses the S14 build packet and
// owned-process checks. Build with tests/desktop/string-count-build.mjs, then:
// node tests/desktop/parity-note-audition.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';
import {assertStringCountBuild,assertStringCountIdentity,assertStringCountPortFree,stringCountEnvironment,validateStringCountArguments} from './parity-string-count.mjs';
import {buildSavedTuningsFixture} from './parity-saved-tunings.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
const hashFile=path=>sha256(readFileSync(path));

export async function runNoteAuditionAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'audition-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'audition.gp'),identityPath=resolve(paths.results,'launch-identity.json');
  const result={format:'TabPlayerNoteAuditionReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],auditions:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
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
  const status=()=>invoke('audio_status');
  const native=()=>poll(status,value=>{assert.equal(value.error,null);return value.ready&&value.generation===value.desiredGeneration;},'paused current native preparation');
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  // An audition counts when the native serial rises and the mixed clip is audible.
  const heard=async(label,action)=>{
    const before=(await status()).auditionSerial??0;await action();
    const started=await poll(status,value=>(value.auditionSerial??0)>before,`${label} audition`);
    // The peak is a running maximum of the sounding clip, so read it once most of the clip has played.
    await sleep(1200);const after=await status();assert.equal(after.auditionSerial,started.auditionSerial,`${label}: one clip`);
    assert.equal(after.playing,false,'Audition never starts playback');assert.ok(after.auditionPeak>0.001,`${label}: audible clip`);
    result.auditions.push({label,serial:after.auditionSerial,peak:after.auditionPeak});return after;
  };
  const silent=async(label,action)=>{const before=(await status()).auditionSerial??0;await action();await sleep(1500);assert.equal((await status()).auditionSerial??0,before,`${label}: no audition`);result.auditions.push({label,silent:true});};
  try{
    ui=await import('./workstation-commands.mjs');
    writeFileSync(inputPath,await buildSavedTuningsFixture(),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT:resolve(paths.export,'audition'),WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());
    assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths.profile,listeners());
    page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    await page.locator('.app-shell').waitFor();const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await idle();await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
    const initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);

    // S16: a single string and the whole tuning, from the track's tuning field, without editing.
    await ui.revealLeftTask(page,'Track');const field=page.locator('.tuning-field').first();
    await heard('string 6',()=>field.getByRole('button',{name:'Play string 6 (E2)',exact:true}).click());
    await heard('string 1',()=>field.getByRole('button',{name:'Play string 1 (E4)',exact:true}).click());
    const single=result.auditions[0].peak,strum=await heard('tuning',()=>field.getByRole('button',{name:'Play tuning',exact:true}).click());
    assert.ok(strum.auditionPeak>=single*0.5,`Strummed tuning is about as loud as one string: ${strum.auditionPeak} vs ${single}`);
    // A typed draft is auditioned as typed, before any Apply.
    await page.getByLabel('Tuning (notes, high to low)',{exact:true}).fill('D4 A3 F3 D3 A2 D2');
    await heard('draft string 6',()=>field.getByRole('button',{name:'Play string 6 (D2)',exact:true}).click());
    assert.deepEqual(await record(),initial,'Tuning auditions never edit');step('String, tuning and draft auditions sounded without editing',{auditions:result.auditions});
    await page.screenshot({path:resolve(paths.results,'01-tuning-buttons.png')});result.screenshots.push('01-tuning-buttons.png');

    // E17: entering a note plays it; with the preference off it stays silent.
    await ui.revealInspectorTab(page,'Selection');const fret=page.getByLabel('Fret',{exact:true}).first();
    await fret.fill('5');await heard('set note',async()=>{await page.getByRole('button',{name:'Set note',exact:true}).click();await idle();});
    let current=await record();assert.equal(current.snapshot.project.edits.length,1);assert.equal(current.snapshot.project.edits[0].type,'setNote');
    await silent('undo',()=>button('Undo'));
    await page.locator('summary',{hasText:'View'}).first().click();const preference=page.getByRole('checkbox',{name:'Play notes while editing',exact:true});
    assert.equal(await preference.isChecked(),true,'Preference defaults on');await preference.uncheck();await page.keyboard.press('Escape');
    await fret.fill('7');await silent('set note with preference off',async()=>{await page.getByRole('button',{name:'Set note',exact:true}).click();await idle();});
    current=await record();assert.equal(current.snapshot.project.edits.length,1);step('Note entry auditions follow the preference; undo is silent',{auditions:result.auditions});
    healthy();
  }catch(error){failure=error;result.error={message:String(error),stack:error.stack};if(page)try{await page.screenshot({path:resolve(paths.results,'failure.png')});}catch{}}
  finally{
    try{if(browser)await browser.close();if(identity&&inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);}catch(error){failure??=error;}
    try{assertStringCountBuild(packet);}catch(error){failure??=error;}
    result.status=failure?'failed':'passed';result.finishedAtUtc=new Date().toISOString();writeFileSync(resolve(paths.results,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  }
  if(failure)throw failure;return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for note audition. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runNoteAuditionAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),auditions:outcome.auditions},null,2));}
}
