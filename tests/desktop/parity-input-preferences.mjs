// L08 desktop acceptance: the score-input preferences (keypad durations, preview, auto-duration, diagram paste) are saved, and keypad
// keys set duration as single undoable native edits only when enabled. Reuses the S14 build packet and owned-process checks. Build with
// tests/desktop/string-count-build.mjs, then: node tests/desktop/parity-input-preferences.mjs --run --build=<absolute build.json>
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

export async function runInputPreferencesAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'input-preferences-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'input-preferences.gp'),identityPath=resolve(paths.results,'launch-identity.json'),exportBase=resolve(paths.export,'input-preferences');
  const result={format:'TabPlayerInputPreferencesReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],edits:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
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
  const stop=async()=>{await browser.close();browser=null;page=null;if(inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);assert.equal(inspect(),null);identity=null;await poll(portRows,rows=>rows.length===0,'diagnostic port released');};
  const launch=async session=>{
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT:exportBase,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());
    assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths.profile,listeners());
    page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    await page.locator('.app-shell').waitFor();const library=page.getByRole('dialog',{name:'Library',exact:true});if(await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor({timeout:5000}).then(()=>true,()=>false)){await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});}
    await idle();await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
  };
  try{
    ui=await import('./workstation-commands.mjs');const {importer,Settings}=await import('@coderline/alphatab');load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
    await buildInstrumentFixture();writeFileSync(inputPath,readFileSync(fixturePath),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
    await launch(paths.session);
    let initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);


    const workspace$=()=>page.getByRole('region',{name:'Score workspace',exact:true});
    const prefs=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('tabplayer.input.preferences')??'null'));
    const viewMenu=async()=>{
      const region=page.getByRole('region',{name:'Workspace view',exact:true});
      if(!await region.isVisible())await page.locator('summary',{hasText:/^View$/}).click();
      await region.waitFor({state:'visible'});return region;
    };
    const labels={preview:'Play notes while editing',auto:'Auto-duration: a note written on a rest takes the last duration',keypad:'Keypad sets duration (1-7, . for dot)',diagrams:'Paste includes chord diagrams'};
    const box=async name=>(await viewMenu()).getByRole('checkbox',{name:labels[name],exact:true});
    // Real key events carry the key a keyboard sends: Playwright's keyboard.press('Numpad2') reports ArrowDown, the NumLock-off shape.
    const press=(key,code)=>workspace$().dispatchEvent('keydown',{key,code,bubbles:true,cancelable:true});
    const field=async name=>{await ui.revealInspector(page);return page.getByLabel(name,{exact:true});};
    const fret=async()=>(await field('Fret')).inputValue();

    // With the preference off a keypad key types a fret and makes no edit.
    assert.notEqual(await fret(),'2');
    await press('2','Numpad2');await poll(fret,value=>value==='2','keypad 2 types fret 2');
    assert.deepEqual(await record(),initial,'Keypad is inert while the preference is off');
    step('Keypad keys type frets and make no edit by default',{});

    // The View menu holds every score-input choice and remembers them.
    for(const name of Object.keys(labels))await (await box(name)).waitFor();
    assert.equal(await (await box('diagrams')).isChecked(),true,'Diagram paste defaults on');
    assert.equal(await (await box('keypad')).isChecked(),false,'Keypad defaults off');
    assert.equal(await (await box('auto')).isChecked(),false,'Auto-duration defaults off');
    await (await box('keypad')).check();await (await box('auto')).check();await (await box('diagrams')).uncheck();
    assert.deepEqual(await prefs(),{autoDuration:true,numpadDurations:true,pasteDiagrams:false});
    assert.deepEqual(await record(),initial,'Preferences never edit the score');

    // Read path: after a reload the stored choices come back into the menu and the clipboard panel.
    // A restart with a fresh session and the same profile: localStorage is what must survive.
    await sleep(3000);await stop();const again=resolve(runDirectory,'session-2');mkdirSync(again);await launch(again);
    await workspace$().waitFor();initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);
    assert.equal(await (await box('keypad')).isChecked(),true);assert.equal(await (await box('auto')).isChecked(),true);assert.equal(await (await box('diagrams')).isChecked(),false);
    await ui.revealInspector(page);
    // Paste options appear once something is copied; copying never edits.
    const open=name=>page.locator('summary').filter({hasText:name}).first().evaluate(node=>{node.parentElement.open=true;});
    await open('Music selection');await button('Select bar');await workspace$().focus();await page.keyboard.press('Control+c');await idle();await open('Musical clipboard');
    const filter=page.getByLabel('Chord diagrams',{exact:true});await filter.waitFor();
    assert.equal(await filter.isChecked(),false,'Clipboard diagram filter starts from the preference');
    await (await box('diagrams')).check();assert.equal(await filter.isChecked(),true,'Turning the preference on moves the filter');
    await (await box('diagrams')).uncheck();assert.equal(await filter.isChecked(),false);
    assert.deepEqual(await prefs(),{autoDuration:true,numpadDurations:true,pasteDiagrams:false});
    step('Preferences are saved, reloaded and drive the clipboard filter',{prefs:await prefs()});

    // NumLock off: the keypad reports navigation keys, which keep navigating and never edit.
    const stringSelect=async()=>{await ui.revealInspector(page);return page.getByRole('combobox',{name:/^String/}).first();};const stringBefore=await (await stringSelect()).inputValue();
    await press('ArrowDown','Numpad2');await poll(async()=>(await stringSelect()).inputValue(),value=>value!==stringBefore,'ArrowDown moved the string');
    assert.deepEqual(await record(),initial);
    // A keypad duration that changes nothing (keypad 1 on a whole note) adds no edit.
    await press('1','Numpad1');await idle();assert.deepEqual(await record(),initial,'No-op keypad key makes no edit');
    step('NumLock-off keys navigate and no-op durations make no edit',{});

    // Auto-duration: a note on a rest, then a note on a differing rest takes the remembered duration first.
    const edits=async()=>(await record()).snapshot.project.edits;
    const tap=async(code,times=1)=>{await workspace$().focus();for(let i=0;i<times;i++)await page.keyboard.press(code);await idle();};
    await tap('ArrowRight',3);// bar 2 beat 3, a quarter rest
    await tap('Enter');
    const afterFirst=await poll(edits,value=>value.length===1,'first note');
    assert.equal(afterFirst[0].type,'setNote');assert.deepEqual(afterFirst[0].target,{track:0,bar:1,voice:0,beat:2,staff:0});
    await tap('ArrowRight',2);// bar 3 beat 2, a half rest
    await tap('Enter');
    const afterSecond=await poll(edits,value=>value.length===3,'duration then note');
    assert.deepEqual(afterSecond[1],{type:'setDuration',target:{track:0,bar:2,voice:0,beat:1,staff:0},duration:4,dots:0});
    assert.equal(afterSecond[2].type,'setNote');assert.deepEqual(afterSecond[2].target,afterSecond[1].target);
    step('Auto-duration sets the remembered duration before writing on a differing rest',{edits:afterSecond.slice(1)});
    await tap('ArrowLeft',5);

    // Keypad 2 is a half note, keypad . dots it: each key is exactly one undoable edit on the selected beat.
    const first={track:0,...at};
    const keypad=async(label,key,code,expected)=>{
      const before=await record(),count=before.snapshot.project.edits.length;
      await press(key,code);await idle();
      const after=await poll(record,value=>value.snapshot.project.edits.length===count+1,`${label}: one edit`);
      assert.deepEqual(after.snapshot.project.edits.at(-1),expected,`${label}: command`);
      await button('Undo');assert.deepEqual((await record()).snapshot.project,before.snapshot.project,`${label}: undo restores`);
      await button('Redo');assert.deepEqual((await record()).snapshot.project,after.snapshot.project,`${label}: redo restores`);
      result.edits.push({label,command:expected});return after;
    };
    await keypad('keypad 2','2','Numpad2',{type:'setDuration',target:first,duration:2,dots:0});
    await keypad('keypad dot','.','NumpadDecimal',{type:'setDuration',target:first,duration:2,dots:1});
    step('Keypad keys set duration and dot as single edits',{edits:result.edits});

    // Preview stays an independent choice.
    const preview=await box('preview');
    const heard=await preview.isChecked();await preview.setChecked(!heard);
    assert.equal(await page.evaluate(()=>localStorage.getItem('tabplayer.audition.whileEditing')),heard?'off':'on');
    await (await box('preview')).setChecked(heard);step('Preview toggle is saved separately',{});

    // The saved score carries every change.
    const final=await record();assert.equal(final.snapshot.project.edits.length,5);
    const exportPath=`${exportBase}.gp`;assert.equal(existsSync(exportPath),false);await button('Export GP');
    const score=load(readFileSync(exportPath)),bars=score.tracks[0].staves[0].bars,beatAt=(bar,index)=>bars[bar].voices[0].beats[index];
    assert.equal(beatAt(0,0).duration,2);assert.equal(beatAt(0,0).dots,1);
    assert.equal(beatAt(1,2).notes.length,1);assert.equal(beatAt(2,1).duration,4);assert.equal(beatAt(2,1).notes.length,1);
    assert.deepEqual(await record(),final,'Export never edits');step('Exported GP reads back the dotted half and both written notes',{exportPath,sha256:hashFile(exportPath)});

    // Keypad off again: the key types a fret and edits nothing.
    await (await box('keypad')).uncheck();
    await press('3','Numpad3');await poll(fret,value=>value==='3','keypad 3 types fret 3');
    assert.deepEqual(await record(),final);step('Keypad preference off again types frets',{});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for score-input preferences. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runInputPreferencesAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),edits:outcome.edits},null,2));}
}
