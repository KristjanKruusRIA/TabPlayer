// S15 desktop acceptance: saved personal tunings across a restart, with isolated app data. It reuses the S14 build packet,
// owned-process and listener checks. Build with tests/desktop/string-count-build.mjs, then:
// node tests/desktop/parity-saved-tunings.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
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
const original=[64,59,55,50,45,40],openD=[62,57,53,50,45,38],seven=[64,59,55,50,45,40,35];
const fixtureName='Fixture standard',firstName='Öine & <hääl> ]]>',secondName='Open D minor copy',renamed='Open D minor (renamed)';
const notes=[[1,0],[2,1],[3,2],[6,3]];

export async function buildSavedTuningsFixture(){
  const {model,exporter,Settings}=await import('@coderline/alphatab'),settings=new Settings(),score=new model.Score();score.title='Owned saved-tunings acceptance';score.artist='TabPlayer public fixture';
  const master=new model.MasterBar();master.timeSignatureNumerator=4;master.timeSignatureDenominator=4;score.addMasterBar(master);
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  const track=new model.Track();track.name='Guitar';track.shortName='Guitar';Object.assign(track.playbackInfo,{program:25,primaryChannel:0,secondaryChannel:1});
  const staff=new model.Staff();staff.stringTuning.tunings=[...original];staff.stringTuning.name=fixtureName;staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
  const bar=new model.Bar();bar.id=0;bar.clef=model.Clef.G2;staff.addBar(bar);const voice=new model.Voice();voice.id=0;bar.addVoice(voice);
  for(const [index,[string,fret]] of notes.entries()){const beat=new model.Beat();beat.id=index;beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);const note=new model.Note();note.id=index;note.string=string;note.fret=fret;beat.addNote(note);}
  score.finish(settings);return Buffer.from(new exporter.Gp7Exporter().export(score,settings));
}
const pitchText=/^[A-G][#b]?-?\d+( [A-G][#b]?-?\d+)*$/;
const libraryEntries=path=>{const library=json(path);assert.deepEqual(Object.keys(library).sort(),['entries','format','version']);assert.equal(library.format,'tabplayer-tuning-library');assert.equal(library.version,1);return library.entries;};

export async function runSavedTuningsAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  // The user's real library must be untouched; the run's library lives in its own app-data folder.
  const realLibrary=resolve(process.env.APPDATA,'dev.tabplayer.desktop','tuning-library.json'),realHash=()=>existsSync(realLibrary)?hashFile(realLibrary):null,realBefore=realHash();
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'tunings-')),appData=resolve(runDirectory,'app-data'),results=resolve(runDirectory,'results'),exportDirectory=resolve(runDirectory,'export'),input=resolve(runDirectory,'input');
  for(const path of [appData,results,exportDirectory,input])mkdirSync(path);
  const libraryPath=resolve(appData,'tuning-library.json'),inputPath=resolve(input,'saved-tunings.gp'),exportBase=resolve(exportDirectory,'saved-tunings');
  const result={format:'TabPlayerSavedTuningsReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,appData,libraryPath,realLibrary,realBefore,assertions:[],exports:[],screenshots:[],launches:[],pageErrors:[],fallbacks:[],cleanup:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');assert.equal(hashFile(packet.executable),packet.executableSha256.toLowerCase(),'Executable bytes changed');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  const stop=async()=>{if(browser){await browser.close();browser=null;page=null;}if(identity){if(inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);assert.equal(inspect(),null);identity=null;}await poll(portRows,rows=>rows.length===0,'diagnostic port released');};
  const launch=async label=>{
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
    result.launches.push({label,identity,paths});
    await page.locator('.app-shell').waitFor();const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await idle();await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
  };
  let ui;
  const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot','audio_status'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
  const workspace=()=>invoke('workspace_snapshot'),record=async()=>invoke('project_snapshot',{documentId:(await workspace()).active.documentId});
  const native=()=>poll(()=>invoke('audio_status'),value=>{assert.equal(value.playing,false);assert.equal(value.error,null);return value.ready&&value.generation===value.desiredGeneration;},'paused current native preparation');
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  const shot=async(name,locator=page)=>{const path=resolve(results,`${String(result.screenshots.length+1).padStart(2,'0')}-${name}.png`);await locator.screenshot({path});result.screenshots.push(path);};
  const tuningField=()=>page.getByLabel('Tuning (notes, high to low)',{exact:true});
  const dialog=()=>page.getByRole('dialog',{name:'Saved tunings',exact:true});
  const openDialog=async()=>{owned();await ui.revealLeftTask(page,'Track');await page.getByRole('button',{name:'Saved tunings for Tuning (notes, high to low)',exact:true}).click();await dialog().waitFor();await dialog().getByText('Loading saved tunings…').waitFor({state:'detached'});};
  const personal=()=>dialog().getByRole('region',{name:'Personal',exact:true}).getByRole('button');
  const personalRows=async()=>{const rows=personal();const out=[];for(let i=0;i<await rows.count();i++){const row=rows.nth(i);out.push({name:await row.locator('.saved-tuning-row-name').textContent(),pitches:await row.locator('.saved-tuning-row-pitches').textContent()});}return out;};
  const details=async(name,pitches)=>{const d=dialog();await d.getByLabel('Saved tuning pitches (notes, high to low)').fill(pitches);await d.getByLabel('Saved tuning name').fill(name);};
  // Each library action settles when the personal list shows the expected rows and no error.
  const dialogButton=async(name,expected)=>{owned();await dialog().getByRole('button',{name,exact:true}).click();await poll(async()=>({rows:await personalRows(),alert:await dialog().getByRole('alert').allTextContents()}),value=>{assert.deepEqual(value.alert,[],'Library error');return expected(value.rows);},`${name} settled`);healthy();};
  const staffOf=bytes=>{const score=load(bytes);assert.equal(score.tracks.length,1);return score.tracks[0].staves[0];};
  let load;
  const exportCheck=async(label,tuning,name)=>{
    const beforeRecord=await record(),path=`${exportBase}.gp`;assert.equal(existsSync(path),false);await button('Export GP');const bytes=readFileSync(path);const staff=staffOf(bytes);
    assert.deepEqual([...staff.tuning],tuning,`${label}: exported pitches`);assert.equal(staff.stringTuning.name,name,`${label}: exported tuning name`);assert.equal(staff.bars[0].voices[0].beats.flatMap(beat=>beat.notes).length,notes.length,`${label}: notes kept`);
    assert.deepEqual(await record(),beforeRecord,'Export must not change project/history/revision');
    const saved=resolve(exportDirectory,`${String(result.exports.length+1).padStart(2,'0')}-${label}.gp`);renameSync(path,saved);result.exports.push({label,path:saved,sha256:sha256(bytes),tuning,name});await native();
  };
  try{
    ui=await import('./workstation-commands.mjs');const {importer,Settings}=await import('@coderline/alphatab');load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
    writeFileSync(inputPath,await buildSavedTuningsFixture(),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
    assert.equal(existsSync(libraryPath),false);

    // First launch: two personal tunings with the same pitches. Saving never edits the document.
    await launch('launch-1');let initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);assert.equal(initial.snapshot.dirty,false);
    await openDialog();assert.deepEqual(await personalRows(),[]);assert.equal(existsSync(libraryPath),false,'Reading must not create the library');
    for(const text of await dialog().locator('.saved-tuning-row-pitches').allTextContents())assert.match(text,pitchText,'Full note and octave text');
    await details(firstName,'D4 A3 F3 D3 A2 D2');await dialogButton('Save as new',rows=>rows.length===1);await details(secondName,'D4 A3 F3 D3 A2 D2');await dialogButton('Save as new',rows=>rows.length===2);
    let rows=await personalRows();assert.deepEqual(rows,[{name:firstName,pitches:'D4 A3 F3 D3 A2 D2'},{name:secondName,pitches:'D4 A3 F3 D3 A2 D2'}]);
    let entries=libraryEntries(libraryPath);assert.equal(entries.length,2);assert.notEqual(entries[0].id.toLowerCase(),entries[1].id.toLowerCase());assert.deepEqual(entries.map(e=>[e.name,e.tuning]),[[firstName,openD],[secondName,openD]]);const ids=entries.map(e=>e.id);
    assert.deepEqual(await record(),initial,'Saving leaves the project, history and revision unchanged');assert.equal(realHash(),realBefore,'Real user library untouched');
    await shot('two-personal-tunings',dialog());
    await dialog().getByRole('button',{name:'Cancel',exact:true}).click();await dialog().waitFor({state:'detached'});assert.equal(await tuningField().inputValue(),'E4 B3 G3 D3 A2 E2','Cancel keeps the draft');
    step('Saved two same-pitch personal tunings without editing the document',{entries,record:initial.revision});
    await stop();

    // Second launch: the library survives a restart; rename keeps the identity; Use fills the draft only.
    await launch('launch-2');initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);
    await openDialog();assert.deepEqual(await personalRows(),rows,'Both entries after restart');await shot('after-restart',dialog());
    await personal().nth(1).click();assert.equal(await dialog().getByLabel('Saved tuning name').inputValue(),secondName);
    await dialog().getByLabel('Saved tuning name').fill(renamed);await dialogButton('Save changes',rows=>rows[1]?.name===renamed);
    entries=libraryEntries(libraryPath);assert.deepEqual(entries.map(e=>[e.id,e.name,e.tuning]),[[ids[0],firstName,openD],[ids[1],renamed,openD]],'Rename keeps identity, pitches and order');
    rows=await personalRows();assert.equal(rows[1].name,renamed);
    await personal().nth(0).click();await dialog().getByRole('button',{name:'Use tuning',exact:true}).click();await dialog().waitFor({state:'detached'});
    assert.equal(await tuningField().inputValue(),'D4 A3 F3 D3 A2 D2','Use fills the draft');assert.deepEqual(await record(),initial,'Use does not edit');
    step('Library survived restart, rename kept identity, Use filled the draft only',{entries});

    // Apply is one edit carrying pitches and name; undo and redo restore both.
    const commandA={type:'setTuning',track:0,tuning:openD,tuningName:firstName};
    await page.getByRole('button',{name:'Apply tuning',exact:true}).click();await idle();await native();
    let current=await record();assert.deepEqual(current.snapshot.project.edits,[commandA]);assert.equal(current.snapshot.canUndo,true);
    const notation=await page.locator('[aria-label="Music notation"]').first().textContent();result.notationShowsName=notation.includes(firstName);assert.equal(result.notationShowsName,true,"Score shows the applied tuning name");await shot('applied');
    await exportCheck('applied',openD,firstName);
    await button('Undo');current=await record();assert.deepEqual(current.snapshot.project.edits,[]);assert.deepEqual(current.snapshot.redoEdit,commandA);await exportCheck('undo',original,fixtureName);
    await button('Redo');current=await record();assert.deepEqual(current.snapshot.project.edits,[commandA]);await exportCheck('redo',openD,firstName);
    step('Apply, undo and redo carried pitches and name together',{commandA});

    // Deleting the library record leaves the applied snapshot alone.
    const beforeDelete=await record();await openDialog();await personal().nth(0).click();await dialogButton('Delete',rows=>rows.length===1);
    entries=libraryEntries(libraryPath);assert.deepEqual(entries.map(e=>e.id),[ids[1]]);assert.equal((await personalRows()).length,1);
    await dialog().getByRole('button',{name:'Cancel',exact:true}).click();await dialog().waitFor({state:'detached'});assert.deepEqual(await record(),beforeDelete,'Delete does not edit');
    await exportCheck('after-delete',openD,firstName);step('Library delete kept the applied name',{entries});

    // An invalid pitch is refused without damage.
    const beforeInvalid=await record();await tuningField().fill('E4 Q9 G3');await page.getByRole('button',{name:'Apply tuning',exact:true}).click();await idle();
    assert.ok((await page.getByRole('alert').allTextContents()).join(' ').length>0,'Invalid pitch shows an alert');assert.deepEqual(await record(),beforeInvalid,'Invalid pitch refused atomically');step('Invalid pitch refused',{});

    // A built-in seven-string tuning goes through the S14 string-count route with its name.
    await openDialog();const group=dialog().getByRole('group',{name:'Guitar · 7 strings',exact:true});const seventh=group.getByRole('button').first();const presetName=await seventh.locator('.saved-tuning-row-name').textContent();
    assert.equal(await seventh.locator('.saved-tuning-row-pitches').textContent(),'E4 B3 G3 D3 A2 E2 B1');await seventh.click();await dialog().getByRole('button',{name:'Use tuning',exact:true}).click();await dialog().waitFor({state:'detached'});
    await page.getByRole('combobox',{name:/^Strings kept in place/}).selectOption('high');await page.getByRole('button',{name:'Change string count',exact:true}).click();await idle();await native();
    const commandB={type:'setStringCount',track:0,tuning:seven,keep:'high',tuningName:presetName};current=await record();assert.deepEqual(current.snapshot.project.edits,[commandA,commandB]);
    await exportCheck('seven-string',seven,presetName);step('Built-in seven-string tuning applied through the string-count route',{commandB});

    // Short window: the dialog body scrolls and Cancel / Use tuning stay reachable.
    const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1000,height:420,deviceScaleFactor:1,mobile:false});
    try{
      // The shared Dialog frame owns the scrolling body and the foot, so those are measured; the foot must really hold both buttons.
      await openDialog();const layout=await dialog().evaluate(section=>{const rect=e=>e.getBoundingClientRect();const footer=[...section.querySelectorAll('.tp-dialog-foot button')].map(b=>({text:b.textContent,top:rect(b).top,bottom:rect(b).bottom}));const body=section.querySelector('.tp-dialog-body');return {height:innerHeight,footer,bodyScrolls:body.scrollHeight>body.clientHeight,overflow:getComputedStyle(body).overflowY};});
      assert.equal(layout.height,420);assert.deepEqual(layout.footer.map(b=>b.text),['Cancel','Use tuning']);for(const b of layout.footer)assert.ok(b.top>=0&&b.bottom<=420,`${b.text} reachable`);assert.equal(layout.bodyScrolls,true);assert.match(layout.overflow,/^(auto|scroll)$/);result.shortLayout=layout;await shot('short-height');
      await dialog().getByRole('button',{name:'Cancel',exact:true}).click();await dialog().waitFor({state:'detached'});
    }finally{await cdp.send('Emulation.clearDeviceMetricsOverride');}
    step('Short window keeps Cancel and Use tuning reachable',result.shortLayout);
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for saved tunings. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runSavedTuningsAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),notationShowsName:outcome.notationShowsName,screenshots:outcome.screenshots},null,2));}
}
