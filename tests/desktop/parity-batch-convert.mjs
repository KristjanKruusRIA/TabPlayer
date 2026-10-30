// F08 desktop acceptance: File > Batch convert… converts a mixed corpus of older scores, nested in folders, to new .gp files
// in a separate destination with a per-file report, leaving the originals and the open score untouched. Reuses the S14 build
// packet and owned-process checks. Build with tests/desktop/string-count-build.mjs (desktop-test feature), then:
//   node tests/desktop/parity-batch-convert.mjs --run --build=<absolute build.json>
// The native folder pickers answer from TABPLAYER_TEST_BATCH_SOURCE and TABPLAYER_TEST_BATCH_DESTINATION in desktop-test builds.
// Legacy fixtures come from .analysis/compatibility (here, in the main checkout, or TABPLAYER_COMPATIBILITY_DIR) when present;
// otherwise the corpus is generated MusicXML and the MusicXML type is chosen instead.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';
import {assertStringCountBuild,assertStringCountIdentity,assertStringCountPortFree,stringCountEnvironment,validateStringCountArguments} from './parity-string-count.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
const hashFile=path=>sha256(readFileSync(path));
const xml=title=>`<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
const tree=root=>readdirSync(root,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>relative(root,resolve(entry.parentPath,entry.name)).replaceAll('\\','/')).sort();
const hashes=root=>Object.fromEntries(tree(root).map(name=>[name,hashFile(resolve(root,name))]));

export async function runBatchConvertAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'batch-convert-')),paths=Object.fromEntries(['session','profile','app-data','source','destination','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const identityPath=resolve(paths.results,'launch-identity.json');
  const result={format:'TabPlayerBatchConvertReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  const poll=async(read,predicate,label)=>{const until=performance.now()+60000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  let ui;
  const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
  const workspace=()=>invoke('workspace_snapshot'),record=async()=>invoke('project_snapshot',{documentId:(await workspace()).active.documentId});
  const dialog=()=>page.getByRole('dialog',{name:'Batch convert scores',exact:true});
  // The dialog shows the picked folder's real path, which can differ in form from the one passed in, so match the unique tail.
  const shown=name=>new RegExp(`${basename(runDirectory)}[\\/]${name}$`,'i');
  const rowsOf=async()=>Object.fromEntries(await dialog().getByRole('table',{name:'Conversion report'}).locator('tbody tr').evaluateAll(rows=>rows.map(row=>[row.querySelector('th').textContent,[row.cells[0].textContent,row.cells[1].textContent]])));
  try{
    ui=await import('./workstation-commands.mjs');const {importer,Settings}=await import('@coderline/alphatab');
    // The corpus: legacy files in nested folders, a type that is not chosen, a broken file and a stray text file.
    const fixtureDirectories=[process.env.TABPLAYER_COMPATIBILITY_DIR,resolve(repository,'.analysis/compatibility'),resolve(repository,'../../../.analysis/compatibility')].filter(Boolean);
    const compatibility=fixtureDirectories.find(directory=>existsSync(resolve(directory,'guitarpro5-notes.gp5')));
    const legacy=[['guitarpro3-notes.gp3','old/three/riff.gp3'],['guitarpro4-notes.gp4','old/four.gp4'],['guitarpro5-notes.gp5','five.gp5'],['guitarpro6-notes.gpx','old/six.gpx']];
    const corpus={};
    const put=(name,bytes)=>{const path=resolve(paths.source,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes,{flag:'wx'});corpus[name]=sha256(Buffer.from(bytes));};
    let expected;
    if(compatibility){
      for(const [from,to] of legacy)put(to,readFileSync(resolve(compatibility,from)));
      put('current/seven.gp',readFileSync(resolve(compatibility,'guitarpro7-notes.gp')));put('lead.musicxml',xml('Lead sheet'));
      expected={converted:legacy.map(([,to])=>to),unchosen:['current/seven.gp','lead.musicxml']};
    }else{
      put('xml/a.musicxml',xml('A'));put('xml/deep/b.xml',xml('B'));put('c.musicxml',xml('C'));
      expected={converted:['xml/a.musicxml','xml/deep/b.xml','c.musicxml'],unchosen:[]};
    }
    const broken=compatibility?'old/broken.gp5':'xml/broken.xml';put(broken,Buffer.from('this is not a score'));put('notes.txt',Buffer.from('not a score file'));
    expected.failed=[broken];
    const sourceBefore=hashes(paths.source);assert.deepEqual(sourceBefore,corpus);result.corpus={source:sourceBefore,compatibility:compatibility??null};
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_BATCH_SOURCE:paths.source,TABPLAYER_TEST_BATCH_DESTINATION:paths.destination,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());
    assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths.profile,listeners());
    page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    await page.locator('.app-shell').waitFor();const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await ui.waitForWorkspaceIdle(page);

    // An open, edited score that the conversion must not touch.
    await ui.clickWorkstationButton(page,'New');await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    const open=await workspace(),openRecord=await record();

    // The dialog needs both folders; each pick answers from the test folders.
    await ui.clickWorkstationButton(page,'Batch convert…',{waitForIdle:false});await dialog().waitFor();
    assert.equal(await dialog().getByRole('button',{name:'Convert',exact:true}).isDisabled(),true,'Convert needs folders');
    await dialog().getByRole('button',{name:'Choose source folder…'}).click();await dialog().getByText(shown('source')).waitFor();
    assert.equal(await dialog().getByRole('button',{name:'Convert',exact:true}).isDisabled(),true,'Convert needs a destination');
    await dialog().getByRole('button',{name:'Choose destination folder…'}).click();await dialog().getByText(shown('destination')).waitFor();
    assert.equal(await dialog().getByRole('button',{name:'Convert',exact:true}).isEnabled(),true);
    const typeBox=name=>dialog().getByRole('group',{name:'File types'}).getByRole('checkbox',{name:new RegExp(name)});
    if(!compatibility){await typeBox('MusicXML').check();await typeBox('Guitar Pro 3').uncheck();await typeBox('Guitar Pro 6').uncheck();}
    assert.equal(await typeBox('Guitar Pro 7').isChecked(),false,'The current .gp type is not chosen by default');
    step('The dialog opens with legacy types chosen and converts only when both folders are picked',{});

    // Convert: a per-file report, new files in the destination, the broken file failing without stopping the rest.
    await dialog().getByRole('button',{name:'Convert',exact:true}).click();
    await dialog().getByRole('table',{name:'Conversion report'}).waitFor();
    let report=await rowsOf();
    await page.screenshot({path:resolve(paths.results,'01-report.png')});result.screenshots.push('01-report.png');
    assert.deepEqual(Object.keys(report).sort(),[...expected.converted,...expected.failed].sort(),'The report lists exactly the chosen types');
    for(const name of expected.converted)assert.equal(report[name][0],'Converted',`${name} converts`);
    for(const name of expected.failed)assert.equal(report[name][0],'Failed',`${name} fails alone`);
    for(const name of expected.unchosen)assert.equal(name in report,false,`${name} is not chosen`);
    const outputs=tree(paths.destination);
    assert.deepEqual(outputs,expected.converted.map(name=>name.replace(/\.[^.\/]+$/,'.gp')).sort(),'Folders are kept and every output is new');
    for(const name of outputs){
      const bytes=readFileSync(resolve(paths.destination,name));assert.deepEqual([...bytes.subarray(0,2)],[0x50,0x4b],`${name} is a GP archive`);
      const score=importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());assert.ok(score.tracks.length>0&&score.masterBars.length>0,`${name} reads back`);
    }
    await dialog().getByRole('status').filter({hasText:new RegExp(`^${expected.converted.length} converted, ${expected.failed.length} failed\\.$`)}).waitFor();
    const written=hashes(paths.destination);
    assert.deepEqual(hashes(paths.source),sourceBefore,'The originals are unchanged byte for byte');
    step('A mixed corpus converts with a per-file report, a failure does not stop the rest, and the originals are unchanged',{report,outputs});

    // Converting again never replaces what is there: numbered copies are written and the first results stay as they were.
    await dialog().getByRole('button',{name:'Convert',exact:true}).click();
    // Starting a run clears the previous report, so the table is back only when this run has finished.
    await dialog().getByRole('table',{name:'Conversion report'}).waitFor();
    report=await rowsOf();
    const second=tree(paths.destination);assert.equal(second.length,outputs.length*2);
    for(const name of outputs)assert.equal(hashFile(resolve(paths.destination,name)),written[name],`${name} was not replaced`);
    assert.ok(second.some(name=>/ \(2\)\.gp$/.test(name)),'Numbered copies are written');
    assert.ok(Object.values(report).some(([,detail])=>/because the name was taken/.test(detail)),'The report says a name was taken');
    assert.deepEqual(hashes(paths.source),sourceBefore);step('Nothing in the destination is replaced silently',{second});

    // Cancel: Escape during a run stops after the file under way, and the report matches the disk.
    const filesBefore=tree(paths.destination).length;
    await dialog().getByRole('button',{name:'Convert',exact:true}).click();await page.keyboard.press('Escape');
    await dialog().getByRole('table',{name:'Conversion report'}).waitFor();
    assert.equal(await dialog().getByRole('button',{name:'Close',exact:true}).isEnabled(),true,'The run has stopped');
    report=await rowsOf();
    const converted=Object.values(report).filter(([status])=>status==='Converted').length,notRun=Object.values(report).filter(([status])=>status==='Not converted').length;
    assert.equal(tree(paths.destination).length,filesBefore+converted,'Only converted files were written');
    assert.equal(converted+notRun+Object.values(report).filter(([status])=>status==='Failed').length,Object.keys(report).length);
    assert.deepEqual(hashes(paths.source),sourceBefore);step('Escape cancels between files and the report matches the disk',{converted,notRun});

    // The open score and its tab are exactly as they were.
    await dialog().getByRole('button',{name:'Close',exact:true}).click();await dialog().waitFor({state:'detached'});await ui.waitForWorkspaceIdle(page);
    const after=await workspace();assert.equal(after.documents.length,open.documents.length,'No tab was opened');assert.equal(after.active.documentId,open.active.documentId);
    assert.deepEqual(await record(),openRecord,'The open score is untouched');step('The open score is untouched and no document was opened',{});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for the batch GP converter. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runBatchConvertAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name)},null,2));}
}
