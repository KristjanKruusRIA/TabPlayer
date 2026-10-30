// U05 desktop acceptance: a marked and fingered scale diagram is authored from the Scale browser as one native edit with exact undo
// and redo, and the exported GP file carries every mark. Reuses the S14 build packet and owned-process checks. Build with
// tests/desktop/string-count-build.mjs, then: node tests/desktop/parity-scale-diagrams.mjs --run --build=<absolute build.json>
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

export async function runScaleDiagramAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'scale-diagrams-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'scale-diagrams.gp'),identityPath=resolve(paths.results,'launch-identity.json'),exportBase=resolve(paths.export,'scale-diagrams');
  const result={format:'TabPlayerScaleDiagramReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],edits:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
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

    // The Scale browser is a modal over the selected beat; it edits nothing until a diagram is applied.
    const scales=page.getByRole('dialog',{name:'Scale browser',exact:true}),section=()=>scales.getByRole('region',{name:'Scale diagram',exact:true});
    await button('Browse scales');await scales.waitFor();
    assert.equal(await scales.getByRole('button',{name:'Apply diagram to beat',exact:true}).count(),0,'No apply before a diagram exists');
    assert.deepEqual(await record(),initial,'Opening the browser never edits');

    // From scratch: the 9-string staff gives a 9-string diagram; mark the open low string as the tonic and finger a fretted note.
    const t={track:0,staff:0,bar:0,voice:0,beat:0};
    await scales.getByRole('button',{name:'Blank diagram',exact:true}).click();
    await scales.getByLabel('Diagram name',{exact:true}).fill('Open position');
    await scales.getByLabel('Default shape',{exact:true}).selectOption('diamond');
    await scales.getByLabel('String 9, open',{exact:true}).click();
    await scales.getByLabel('Mark text',{exact:true}).fill('E');
    await scales.getByLabel('Mark color',{exact:true}).fill('#b5df73');
    await scales.getByLabel('Mark text color',{exact:true}).fill('#161c24');
    await scales.getByLabel('Default shape',{exact:true}).selectOption('circle');
    await scales.getByLabel('String 5, fret 3',{exact:true}).click();
    await scales.getByLabel('Mark text',{exact:true}).fill('1');
    await scales.getByLabel('Mark shape',{exact:true}).selectOption('square');
    await scales.getByLabel('String 5, fret 7',{exact:true}).click();
    await scales.getByLabel('Mark text',{exact:true}).fill('3');
    await scales.getByLabel('String 5, fret 7: circle mark "3"',{exact:true}).dblclick();
    assert.equal(await scales.getByLabel(/String 5, fret 7: /).count(),0,'Double-click removes a mark');
    assert.deepEqual(await record(),initial,'Drafting never edits');
    await page.screenshot({path:resolve(paths.results,'01-draft.png')});result.screenshots.push('01-draft.png');
    const expected={type:'setScaleDiagram',target:t,diagram:{
      name:'Open position',strings:9,frets:12,firstFret:1,orientation:'horizontal',showFretMarkers:true,
      marks:[{string:9,fret:0,shape:'diamond',color:'#b5df73',text:'E',textColor:'#161c24'},{string:5,fret:3,shape:'square',color:'#2f6fed',text:'1',textColor:'#ffffff'}],
    }};
    const prior=await record(),count=prior.snapshot.project.edits.length;
    await scales.getByRole('button',{name:'Apply diagram to beat',exact:true}).click();await idle();
    const added=await poll(record,value=>value.snapshot.project.edits.length===count+1,'one scale diagram edit');
    assert.deepEqual(added.snapshot.project.edits.at(-1),expected,'The applied command carries every mark');
    result.edits.push({label:'apply scale diagram',command:expected});
    await section().getByText(/with 2 marks\./).waitFor();
    await page.screenshot({path:resolve(paths.results,'02-applied.png')});result.screenshots.push('02-applied.png');
    step('A marked and fingered diagram is one native edit',{command:expected});

    // History: undo removes the diagram and redo restores it, exactly.
    await scales.getByRole('button',{name:'Close scales',exact:true}).click();await scales.waitFor({state:'hidden'});
    await button('Undo');assert.deepEqual((await record()).snapshot.project,prior.snapshot.project,'Undo restores');
    await button('Redo');assert.deepEqual((await record()).snapshot.project,added.snapshot.project,'Redo restores');
    step('Undo and redo restore the project exactly',{});

    // The exported GP file carries the diagram and every mark, and still loads as a normal GP file.
    const exportPath=`${exportBase}.gp`;assert.equal(existsSync(exportPath),false);await button('Export GP');
    const {unzipSync,strFromU8}=await import('fflate'),bytes=readFileSync(exportPath),gpif=strFromU8(unzipSync(new Uint8Array(bytes))['Content/score.gpif']);
    const doc=gpif;
    assert.match(doc,/<Property name="TabPlayerScaleDiagrams">/);
    assert.equal((doc.match(/<Mark /g)??[]).length,2,'Both marks are exported');
    for(const fragment of ['name="TabPlayerScaleDiagrams"','strings="9"','frets="12"','orientation="horizontal"','shape="diamond"','color="#b5df73"','shape="square"','color="#2f6fed"','<Text>E</Text>','<Text>1</Text>','<Name>Open position</Name>'])assert.ok(doc.includes(fragment),`GPIF carries ${fragment}`);
    const score=load(bytes);assert.equal(score.tracks.length,4,'The exported file still loads');
    assert.deepEqual(await record(),added,'Export never edits');step('Exported GP carries the diagram and every mark',{exportPath,sha256:hashFile(exportPath)});

    // Deleting removes the diagram again as one edit.
    await button('Browse scales');await scales.waitFor();
    await scales.getByRole('button',{name:'Delete diagram from beat',exact:true}).click();await idle();
    const removed=await poll(record,value=>value.snapshot.project.edits.length===count+2,'one delete edit');
    assert.deepEqual(removed.snapshot.project.edits.at(-1),{type:'setScaleDiagram',target:t,diagram:null});
    await scales.getByRole('button',{name:'Close scales',exact:true}).click();step('Delete clears the diagram as one edit',{});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for scale diagram authoring and GP export. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runScaleDiagramAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),edits:outcome.edits},null,2));}
}
