// U12 desktop acceptance: clicking the instrument view enters and deletes fretted, pitched and drum notes as single
// native edits with exact undo and redo. Reuses the S14 build packet and owned-process checks. Build with
// tests/desktop/string-count-build.mjs, then: node tests/desktop/parity-instrument-entry.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
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
const hashFile=path=>sha256(readFileSync(path));
const at={bar:0,voice:0,beat:0,staff:0};

export async function runInstrumentEntryAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'instrument-entry-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'instrument-entry.gp'),identityPath=resolve(paths.results,'launch-identity.json'),exportBase=resolve(paths.export,'instrument-entry');
  const result={format:'TabPlayerInstrumentEntryReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],edits:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  let ui,load;
  const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot','audio_status'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
  const workspace=()=>invoke('workspace_snapshot'),record=async()=>invoke('project_snapshot',{documentId:(await workspace()).active.documentId});
  const native=()=>poll(()=>invoke('audio_status'),value=>{assert.equal(value.error,null);return value.ready&&value.generation===value.desiredGeneration;},'paused current native preparation');
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  const view=()=>page.getByRole('region',{name:'Instrument view',exact:true});
  const edits=async()=>(await record()).snapshot.project.edits;
  // One click is exactly one native edit with this command; Undo restores the record before it and Redo the one after.
  const click=async(label,name,expected)=>{
    const before=await record(),count=before.snapshot.project.edits.length;
    await view().getByRole('button',{name,exact:true}).click();await idle();
    const after=await poll(record,value=>value.snapshot.project.edits.length===count+1,`${label}: one edit`);
    assert.deepEqual(after.snapshot.project.edits.at(-1),expected,`${label}: command`);
    await button('Undo');assert.deepEqual((await record()).snapshot.project,before.snapshot.project,`${label}: undo restores`);
    await button('Redo');assert.deepEqual((await record()).snapshot.project,after.snapshot.project,`${label}: redo restores`);
    result.edits.push({label,command:expected});return after;
  };
  try{
    ui=await import('./workstation-commands.mjs');const {importer,Settings}=await import('@coderline/alphatab');load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
    await buildInstrumentFixture();writeFileSync(inputPath,readFileSync(fixturePath),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT:exportBase,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
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

    // Read-only by default: the view is a picture with no click targets.
    await button('Show instrument');await view().getByRole('img',{name:'Guitar fretboard',exact:true}).waitFor();
    assert.equal(await view().locator('[data-entry-target]').count(),0,'No targets until edit mode');
    const editing=view().getByRole('checkbox',{name:'Click to edit notes',exact:true});assert.equal(await editing.isChecked(),false,'Edit mode defaults off');
    await editing.check();await view().getByRole('group',{name:'Guitar fretboard',exact:true}).waitFor();
    assert.deepEqual(await record(),initial,'Turning edit mode on never edits');step('Edit mode is opt-in and changes nothing',{});

    // Fretted: the 9-string's first beat holds strings 9 (E4), 8 (C4) and 1 (C#1), all open but string 8 at fret 1.
    const g={track:0,...at};
    await click('fretboard add','String 5, fret 3 (C3)',{type:'setNote',target:g,string:5,fret:3});
    await click('fretboard change fret','String 5, fret 5 (D3)',{type:'setNote',target:g,string:5,fret:5});
    await click('fretboard remove','Remove string 9, fret 0 (E4)',{type:'removeNote',target:g,string:9});
    await view().getByRole('button',{name:'String 9, fret 0 (E4)',exact:true}).waitFor();
    await page.screenshot({path:resolve(paths.results,'01-fretboard.png')});result.screenshots.push('01-fretboard.png');
    step('Fretboard clicks add, refret and remove, each one undoable edit',{edits:result.edits});

    // Pitched: the keys track's first beat is C4 E4 G4.
    await ui.selectWorkspaceTrack(page,'Track 4: Keys');await view().getByRole('group',{name:'Keyboard',exact:true}).waitFor();
    const k={track:3,...at};
    await click('keyboard add','D4',{type:'addPitchedNote',target:k,pitch:62});
    await click('keyboard remove','Remove E4',{type:'removeNoteByIndex',target:k,noteIndex:1});
    await page.screenshot({path:resolve(paths.results,'02-keyboard.png')});result.screenshots.push('02-keyboard.png');
    step('Keyboard clicks add and remove pitched notes',{edits:result.edits});

    // Drums: the first beat holds kick and crash; the track's own table maps the snare to its id 2.
    await ui.selectWorkspaceTrack(page,'Track 3: Drums');await view().getByRole('group',{name:'Drum kit',exact:true}).waitFor();
    const d={track:2,...at};
    await click('drum add','Snare',{type:'addPercussionNote',target:d,articulation:2});
    await click('drum remove','Remove Kick 2',{type:'removeNoteByIndex',target:d,noteIndex:0});
    await page.screenshot({path:resolve(paths.results,'03-drums.png')});result.screenshots.push('03-drums.png');
    step('Drum clicks add and remove percussion notes',{edits:result.edits});

    // The saved score carries every change.
    const final=await record();assert.equal(final.snapshot.project.edits.length,7);
    const exportPath=`${exportBase}.gp`;assert.equal(existsSync(exportPath),false);await button('Export GP');
    const score=load(readFileSync(exportPath)),beat=track=>score.tracks[track].staves[0].bars[0].voices[0].beats[0].notes;
    assert.deepEqual(beat(0).map(note=>[note.string,note.fret]).sort((a,b)=>a[0]-b[0]),[[1,0],[5,5],[8,1]]);
    assert.deepEqual(beat(3).map(note=>note.realValue).sort((a,b)=>a-b),[60,62,67]);
    assert.deepEqual(beat(2).map(note=>score.tracks[2].percussionArticulations[note.percussionArticulation].outputMidiNumber).sort((a,b)=>a-b),[38,49]);
    assert.deepEqual(await record(),final,'Export never edits');step('Exported GP reads back every entered and deleted note',{exportPath,sha256:hashFile(exportPath)});

    // Edit mode off: the view is read-only again.
    await view().getByRole('checkbox',{name:'Click to edit notes',exact:true}).uncheck();await view().getByRole('img',{name:'Drum kit',exact:true}).waitFor();
    assert.equal(await view().locator('[data-entry-target]').count(),0);assert.deepEqual(await record(),final);step('Turning edit mode off restores the read-only view',{});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for instrument view note entry. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runInstrumentEntryAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),edits:outcome.edits},null,2));}
}
