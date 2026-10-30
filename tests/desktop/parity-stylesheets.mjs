// D13 desktop acceptance: a personal engraving style is saved to the app-data library, survives a restart, and is applied
// to another document as one undoable setEngraving edit that never changes the music. A damaged library is reported and
// left byte for byte. Reuses the S14 build packet and owned-process checks. Build with tests/desktop/string-count-build.mjs, then:
// node tests/desktop/parity-stylesheets.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
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
const styleName='House style',spacing=125;

export async function runStylesheetsAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  // The user's real library must be untouched; the run's library lives in its own app-data folder.
  const realLibrary=resolve(process.env.APPDATA,'dev.tabplayer.desktop','style-library.json'),realHash=()=>existsSync(realLibrary)?hashFile(realLibrary):null,realBefore=realHash();
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'stylesheets-')),appData=resolve(runDirectory,'app-data'),results=resolve(runDirectory,'results'),exportDirectory=resolve(runDirectory,'export'),input=resolve(runDirectory,'input');
  for(const path of [appData,results,exportDirectory,input])mkdirSync(path);
  const libraryPath=resolve(appData,'style-library.json'),firstPath=resolve(input,'first.gp'),secondPath=resolve(input,'second.gp'),exportBase=resolve(exportDirectory,'stylesheets');
  const result={format:'TabPlayerStylesheetsReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,appData,libraryPath,realLibrary,realBefore,assertions:[],exports:[],screenshots:[],launches:[],pageErrors:[],fallbacks:[],cleanup:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');assert.equal(hashFile(packet.executable),packet.executableSha256.toLowerCase(),'Executable bytes changed');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  const stop=async()=>{if(browser){await browser.close();browser=null;page=null;}if(identity){if(inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);assert.equal(inspect(),null);identity=null;}await poll(portRows,rows=>rows.length===0,'diagnostic port released');};
  let ui,load,jsonModel;
  const launch=async(label,inputPath)=>{
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const own=resolve(runDirectory,label),paths=Object.fromEntries(['session','profile'].map(name=>[name,resolve(own,name)]));for(const path of Object.values(paths))mkdirSync(path,{recursive:true});
    const identityPath=resolve(own,'launch-identity.json');
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_APP_DATA_DIR:appData,TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT:exportBase,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());
    assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths.profile,listeners());
    assert.equal(browser.contexts().length,1);assert.equal(browser.contexts()[0].pages().length,1);page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    result.launches.push({label,inputPath,identity,paths});
    await page.locator('.app-shell').waitFor();const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await idle();await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
  };
  const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot','audio_status'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
  const workspace=()=>invoke('workspace_snapshot'),record=async()=>invoke('project_snapshot',{documentId:(await workspace()).active.documentId});
  const native=()=>poll(()=>invoke('audio_status'),value=>{assert.equal(value.playing,false);assert.equal(value.error,null);return value.ready&&value.generation===value.desiredGeneration;},'paused current native preparation');
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  const shot=async name=>{const path=resolve(results,`${String(result.screenshots.length+1).padStart(2,'0')}-${name}.png`);await page.screenshot({path});result.screenshots.push(path);};
  const details=async name=>{await page.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first().evaluate(node=>{node.parentElement.open=true;});};
  const choose=(name,value)=>page.getByRole('combobox',{name:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:\\s|$)`)}).selectOption(value);
  const openStyles=async()=>{await button('Presentation');for(const name of ['Engraving','Stylesheet','Staff profiles','Saved styles'])await details(name);};
  // The whole score as exported, minus only the style: a style may change how the score is drawn, never what it holds.
  const musicOf=bytes=>{const raw=jsonModel.scoreToJson(load(bytes)),value=typeof raw==='string'?JSON.parse(raw):JSON.parse(JSON.stringify(raw));delete value.stylesheet;return JSON.stringify(value);};
  let baseline=null;
  const exportCheck=async label=>{
    const beforeRecord=await record(),path=`${exportBase}.gp`;assert.equal(existsSync(path),false);await button('Export GP');const bytes=readFileSync(path),music=musicOf(bytes);
    baseline??=music;assert.equal(music,baseline,`${label}: the exported score, apart from its style, is unchanged`);assert.deepEqual(await record(),beforeRecord,'Export must not change project/history/revision');
    const saved=resolve(exportDirectory,`${String(result.exports.length+1).padStart(2,'0')}-${label}.gp`);renameSync(path,saved);result.exports.push({label,path:saved,sha256:sha256(bytes),musicSha256:sha256(Buffer.from(music))});await native();
  };
  const rendered=async()=>sha256(Buffer.from((await page.locator('[aria-label="Music notation"] svg').evaluateAll(nodes=>nodes.map(node=>node.outerHTML))).join('')));
  const profileEdit=profile=>choose('Guitar notation profile',profile);
  try{
    ui=await import('./workstation-commands.mjs');const {importer,exporter,model,Settings}=await import('@coderline/alphatab');load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());jsonModel=model.JsonConverter;
    // Two different documents: the second has another title and another first note.
    const fixture=await buildSavedTuningsFixture(),second=load(fixture);second.title='Second stylesheet document';second.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret=5;
    writeFileSync(firstPath,fixture,{flag:'wx'});writeFileSync(secondPath,Buffer.from(new exporter.Gp7Exporter().export(second,new Settings())),{flag:'wx'});result.input={firstPath,secondPath,sha256:hashFile(firstPath),secondSha256:hashFile(secondPath)};
    assert.notEqual(musicOf(readFileSync(firstPath)),musicOf(readFileSync(secondPath)),'The documents differ');
    assert.equal(existsSync(libraryPath),false);

    // Launch 1: author a style in the first document, which has its own staff profile, and save it. Saving never edits the document.
    await launch('launch-1',firstPath);let initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);
    await openStyles();await page.locator('option',{hasText:'No saved styles yet'}).waitFor({state:'attached'});assert.equal(existsSync(libraryPath),false,'Reading must not create the library');
    await profileEdit('slash');await choose('Hide dynamics','true');await choose('Bar numbers','hidden');await page.getByLabel('System spacing (%)',{exact:true}).fill(String(spacing));await button('Apply engraving');
    const authored=await record();assert.deepEqual(authored.snapshot.project.edits.map(edit=>edit.type),['setEngraving']);assert.equal(authored.snapshot.project.edits[0].engraving.profiles.length,1,'The first document has a staff profile');
    await page.getByLabel('Style name',{exact:true}).fill(styleName);await page.getByRole('button',{name:'Save current style',exact:true}).click();
    await poll(()=>existsSync(libraryPath),Boolean,'library file written');await page.getByRole('status').filter({hasText:`Saved ${styleName}.`}).waitFor();
    const library=json(libraryPath);assert.deepEqual(Object.keys(library).sort(),['entries','format','version']);assert.equal(library.format,'tabplayer-style-library');assert.equal(library.version,2);assert.equal(library.entries.length,1);
    const [entry]=library.entries;assert.equal(entry.name,styleName);assert.deepEqual(entry.engraving.profiles,[]);assert.equal(entry.engraving.stylesheet.hideDynamics,true);assert.equal(entry.engraving.stylesheet.barNumbers,'hidden');assert.equal(entry.engraving.systemSpacing,spacing/100);
    assert.deepEqual(await record(),authored,'Saving leaves the project, history and revision unchanged');assert.equal(realHash(),realBefore,'Real user library untouched');await shot('style-saved');
    step('Saved the document style to the personal library without editing the document',{entry});
    await stop();

    // Launch 2: another document, after a restart. Apply is one edit; undo and redo restore the record; the music is unchanged.
    baseline=null;await launch('launch-2',secondPath);initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);
    // The second document gets its own, different staff profile first; the style must leave it alone.
    await openStyles();await profileEdit('numbered');await button('Apply engraving');
    const profiled=await record();assert.equal(profiled.snapshot.project.edits.length,1);const ownProfiles=profiled.snapshot.project.edits[0].engraving.profiles;
    assert.equal(ownProfiles.length,1);assert.equal(ownProfiles[0].profile,'numbered');await native();await exportCheck('before-apply');
    const drawnBefore=await rendered();await openStyles();
    await page.getByRole('combobox',{name:'Saved style',exact:true}).selectOption(entry.id);
    await page.getByRole('button',{name:'Apply saved style',exact:true}).click();await idle();await native();
    const applied=await record();assert.equal(applied.snapshot.project.edits.length,2,'Applying is exactly one more edit');const command=applied.snapshot.project.edits[1];
    assert.equal(command.type,'setEngraving');assert.deepEqual({...command.engraving,profiles:[]},entry.engraving,'The saved style is applied as stored');assert.deepEqual(command.engraving.profiles,ownProfiles,'The target document keeps its own staff profile');
    await page.getByRole('status').filter({hasText:`Applied ${styleName}.`}).waitFor();assert.equal(applied.snapshot.canUndo,true);
    const drawnApplied=await poll(rendered,value=>value!==drawnBefore,'the score is drawn differently once the style is applied');
    await shot('style-applied');await exportCheck('applied');
    await button('Undo');assert.deepEqual((await record()).snapshot.project,profiled.snapshot.project,'Undo restores the record');assert.equal(await poll(rendered,value=>value===drawnBefore,'undo restores the drawing'),drawnBefore);await exportCheck('undo');
    await button('Redo');assert.deepEqual((await record()).snapshot.project,applied.snapshot.project,'Redo restores the record');assert.equal(await poll(rendered,value=>value===drawnApplied,'redo restores the drawing'),drawnApplied);await exportCheck('redo');
    step('Applied the saved style to another document as one undoable edit; it kept its own profile and the music is unchanged',{command,ownProfiles,drawnBefore,drawnApplied});

    // Force default style returns the engraving to the defaults in one edit, and undo restores the style.
    await page.getByRole('button',{name:'Force default style',exact:true}).click();await idle();
    const forced=await record();assert.equal(forced.snapshot.project.edits.length,3);assert.equal(forced.snapshot.project.edits[2].engraving.stylesheet.hideDynamics,null);assert.equal(forced.snapshot.project.edits[2].engraving.systemSpacing,null);assert.deepEqual(forced.snapshot.project.edits[2].engraving.profiles,ownProfiles);
    await button('Undo');assert.deepEqual((await record()).snapshot.project,applied.snapshot.project);await exportCheck('forced-undo');
    step('Force default style was one undoable edit',{});
    assert.deepEqual(json(libraryPath),library,'Applying never changes the library');
    await stop();

    // Launch 3: a damaged library is reported and left byte for byte.
    const damaged=Buffer.from('{"format":"tabplayer-style-library","version":1,"entries":[{"broken":true}]}');writeFileSync(libraryPath,damaged);const damagedHash=hashFile(libraryPath);
    await launch('launch-3',firstPath);await openStyles();await page.getByRole('alert').filter({hasText:'Could not read saved styles'}).waitFor();assert.equal(await page.locator('option',{hasText:'No saved styles yet'}).count(),0,'A damaged library is not called empty');
    await page.getByLabel('Style name',{exact:true}).fill('Rejected');await page.getByRole('button',{name:'Save current style',exact:true}).click();
    // The failed save has its own message, separate from the read failure shown above it.
    await page.getByRole('alert').filter({hasNotText:'Could not read saved styles'}).filter({hasText:'Invalid style library'}).waitFor();
    await page.getByRole('alert').filter({hasText:'Could not read saved styles'}).waitFor();
    assert.equal(hashFile(libraryPath),damagedHash,'Damaged library left untouched');assert.deepEqual((await record()).snapshot.project.edits,[],'Failed save never edits the document');await shot('damaged-library');
    step('A damaged library is reported and left byte for byte',{damagedHash});
    assert.equal(realHash(),realBefore,'Real user library untouched');healthy();
  }catch(error){failure=error;result.error={message:String(error),stack:error.stack};if(page)try{await page.screenshot({path:resolve(results,'failure.png')});}catch{}}
  finally{
    try{await stop();result.cleanup.push({name:'Stop owned process',ok:true});}catch(error){failure??=error;result.cleanup.push({name:'Stop owned process',ok:false,error:String(error)});}
    try{assertStringCountBuild(packet);assert.equal(hashFile(buildPath),result.buildSha256);assert.equal(realHash(),realBefore);result.cleanup.push({name:'Build and real library integrity',ok:true});}catch(error){failure??=error;result.cleanup.push({name:'Build and real library integrity',ok:false,error:String(error)});}
    result.status=failure?'failed':'passed';result.finishedAtUtc=new Date().toISOString();writeFileSync(resolve(results,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  }
  if(failure)throw failure;return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for personal engraving styles. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runStylesheetsAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),screenshots:outcome.screenshots},null,2));}
}
