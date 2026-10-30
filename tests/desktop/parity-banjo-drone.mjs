// S20 desktop acceptance: a 5-string banjo's short drone string. A GP file of a banjo in open G tuning is opened; the drone is set from
// the Staff panel as one undoable edit; the instrument view then writes neck fret numbers on string 1 (fret 7 sounds A4), shows the
// missing frets 1 to 5 as unavailable, and the native playback plan agrees; the exported GP sounds the same pitches when read by an
// independent reader. Reuses the S14 build packet and owned-process checks. Build with tests/desktop/string-count-build.mjs, then:
// node tests/desktop/parity-banjo-drone.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';
import {assertStringCountBuild,assertStringCountIdentity,assertStringCountPortFree,stringCountEnvironment,validateStringCountArguments} from './parity-string-count.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
const hashFile=path=>sha256(readFileSync(path));

/** Open G banjo, high to low: string 1 is the drone G4 (67), the last tuning entry. Beat 1 of each bar holds the open drone string and string 2 (D3) at fret 2.
 * The file holds no drone: GP's own banjo drone property is not known here, so the drone is set in the app. */
export async function buildBanjoFixture(){
  const {model,exporter,Settings}=await import('@coderline/alphatab'),settings=new Settings(),score=new model.Score();
  score.title='Owned banjo drone acceptance';score.artist='TabPlayer public fixture';
  for(let i=0;i<2;i++){const bar=new model.MasterBar();bar.timeSignatureNumerator=4;bar.timeSignatureDenominator=4;score.addMasterBar(bar);}
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  const track=new model.Track();track.name='Banjo';track.shortName='Bnj';Object.assign(track.playbackInfo,{program:105,primaryChannel:0,secondaryChannel:1});
  const staff=new model.Staff();staff.stringTuning.tunings=[62,59,55,50,67];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
  let noteId=0;
  for(let barIndex=0;barIndex<2;barIndex++){
    const bar=new model.Bar();bar.id=barIndex;bar.clef=model.Clef.G2;staff.addBar(bar);const voice=new model.Voice();voice.id=barIndex;bar.addVoice(voice);
    const beat=new model.Beat();beat.id=barIndex;beat.duration=model.Duration.Whole;beat.isEmpty=false;voice.addBeat(beat);
    for(const [string,fret] of [[1,0],[2,2]]){const note=new model.Note();note.id=noteId++;note.string=string;note.fret=fret;beat.addNote(note);}
  }
  score.finish(settings);
  return Buffer.from(new exporter.Gp7Exporter().export(score,settings));
}
export async function runBanjoDroneAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'banjo-drone-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'banjo-drone.gp'),identityPath=resolve(paths.results,'launch-identity.json'),exportBase=resolve(paths.export,'banjo-drone');
  const result={format:'TabPlayerBanjoDroneReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],edits:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
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
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const view=()=>page.getByRole('region',{name:'Instrument view',exact:true});
  const edits=async()=>(await record()).snapshot.project.edits;
  /** The sounding key the native playback plan gives each string of the selected beat, read from the instrument view's marks. */
  const keys=async()=>{
    await native();
    const marks=await poll(()=>view().locator('.fret-note').evaluateAll(nodes=>nodes.map(node=>[Number(node.dataset.string),Number(node.dataset.key),Number(node.dataset.fret)])),value=>value.length===2,'two planned notes of the selected beat');
    return marks.sort((a,b)=>a[0]-b[0]);
  };
  try{
    ui=await import('./workstation-commands.mjs');
    writeFileSync(inputPath,await buildBanjoFixture(),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
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
    assert.equal(initial.snapshot.project.partialCapo,undefined,'An unedited project carries no marker');

    // No drone yet: the open drone string and string 2 at fret 2 sound as plain strings.
    await button('Show instrument');await view().locator('svg[aria-label*="fretboard"]').waitFor();
    await view().getByRole('combobox',{name:'Instrument view mode',exact:true}).selectOption('guitar');
    await view().getByRole('combobox',{name:/^Show/}).selectOption('beat');
    const plain=await keys();assert.deepEqual(plain.map(mark=>mark[1]),[67,52],'Before the drone: open G4 and E3');
    assert.doesNotMatch(await view().locator('.instrument-detail').innerText(),/Banjo drone/);
    await page.screenshot({path:resolve(paths.results,'01-imported.png')});result.screenshots.push('01-imported.png');
    step('The imported banjo sounds as a plain 5-string staff',{keys:plain});

    // Set the drone from the Staff panel: one edit, nothing before Apply.
    await ui.revealInspector(page);
    await page.locator('summary').filter({hasText:'Staff, voices'}).first().evaluate(node=>{node.parentElement.open=true;});
    const droneBox=page.getByRole('checkbox',{name:/^Short drone string/});assert.equal(await droneBox.isChecked(),false);
    await droneBox.check();assert.equal(await page.getByLabel('Drone string starts at fret',{exact:true}).inputValue(),'5','The usual banjo drone fret is the default');
    assert.deepEqual(await edits(),[],'Choosing the drone changes nothing until it is applied');
    await button('Apply staff settings');
    const set=await poll(record,value=>value.snapshot.project.edits.length===1,'one staff settings edit');
    assert.equal(set.snapshot.project.edits[0].type,'setStaffSettings');assert.equal(set.snapshot.project.edits[0].settings.droneFret,5,'The command carries the drone fret');
    assert.equal(set.snapshot.project.partialCapo,undefined,'A drone is not a partial capo marker');
    assert.match(await view().locator('.instrument-detail').innerText(),/Banjo drone from fret 5/,'The readout names the drone');
    // Fret 0 and string 2 are unchanged by a drone: it only shortens the neck of string 1.
    assert.deepEqual((await keys()).map(mark=>mark[1]),[67,52],'The open drone string and the other strings keep their pitch');
    result.edits.push(set.snapshot.project.edits[0]);
    step('Setting the drone is one edit that keeps open-string pitches',{});

    // Write neck fret 7 on the drone string: it sounds two semitones above open (A4 = 69), not seven.
    const editing=view().getByRole('checkbox',{name:'Click to edit notes',exact:true});await editing.check();
    const missing=view().getByRole('button',{name:/^String 1, fret 3 does not exist on the banjo drone string/});
    assert.equal(await missing.getAttribute('aria-disabled'),'true','Frets 1 to 5 of the drone string are unavailable');
    const count=(await edits()).length;await missing.click({force:true});await idle();assert.equal((await edits()).length,count,'Clicking a missing fret edits nothing');
    await view().getByRole('button',{name:'String 1, fret 7 (A4)',exact:true}).click();await idle();
    const entered=await poll(edits,value=>value.length===count+1,'one entry edit');
    assert.deepEqual(entered.at(-1),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:1,fret:7});
    await editing.uncheck();
    const droned=await keys();assert.deepEqual(droned.map(mark=>mark[1]),[69,52],'Neck fret 7 on the drone string sounds A4, as the native plan says');
    assert.deepEqual(droned.map(mark=>mark[2]),[7,2],'The written frets are kept');
    await page.screenshot({path:resolve(paths.results,'02-drone.png')});result.screenshots.push('02-drone.png');
    result.edits.push(entered.at(-1));
    step('Drone string frets are neck numbers: fret 7 sounds A4 and frets 1 to 5 are unavailable',{keys:droned});

    // Undo and redo restore the project and the sound exactly.
    const full=await record();
    await button('Undo');assert.deepEqual((await keys()).map(mark=>mark[1]),[67,52],'Undo restores the open string');
    await button('Undo');assert.deepEqual((await record()).snapshot.project,initial.snapshot.project,'Undoing both edits restores the project');
    assert.doesNotMatch(await view().locator('.instrument-detail').innerText(),/Banjo drone/,'Undo removes the drone');
    await button('Redo');await button('Redo');assert.deepEqual((await record()).snapshot.project,full.snapshot.project,'Redo restores both edits');
    assert.deepEqual((await keys()).map(mark=>mark[1]),[69,52],'Redo restores the pitches');
    step('Undo and redo restore the drone and its notes exactly',{});

    // The exported GP sounds the same pitches when read by an independent reader.
    const exportPath=`${exportBase}.gp`;assert.equal(existsSync(exportPath),false);await button('Export GP');
    const exported=readFileSync(exportPath);
    const {importer,Settings}=await import('@coderline/alphatab'),reopened=importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(exported),new Settings());
    const staff=reopened.tracks[0].staves[0],notes=staff.bars[0].voices[0].beats[0].notes.map(note=>[note.string,note.fret,note.realValue]).sort((a,b)=>a[0]-b[0]);
    assert.deepEqual(staff.tuning,[62,59,55,50,67],'The tuning is written unchanged');
    assert.deepEqual(notes.map(note=>note[2]),[69,52],'The reopened file sounds the pitches the app played');
    assert.deepEqual(notes.map(note=>note[1]),[2,2],'GP gets the fret counted from the short string, which sounds the same; a drone flag is not written');
    assert.deepEqual((await record()).snapshot.project,full.snapshot.project,'Export never edits');
    step('The exported GP sounds the same pitches',{exportPath,sha256:hashFile(exportPath),notes});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for the banjo drone. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runBanjoDroneAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),edits:outcome.edits},null,2));}
}
