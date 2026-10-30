// L01 desktop acceptance: the Library's Folders section filters the indexed catalog by title, artist and instrument (track
// name), offers no genre filter because the index records none, and opening a result adds a tab without touching the open
// score. Reuses the S14 build packet and owned-process checks. Build with tests/desktop/string-count-build.mjs, then:
// node tests/desktop/parity-library-browse.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';
import {assertStringCountBuild,assertStringCountIdentity,assertStringCountPortFree,stringCountEnvironment,validateStringCountArguments} from './parity-string-count.mjs';
import {buildLibraryFixture,writeLibraryFixture} from './library-fixture.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
const allowed=['workspace_snapshot','project_snapshot','file_library_snapshot','file_library_search'];

export async function runLibraryBrowseAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'library-browse-')),paths=Object.fromEntries(['session','profile','app-data','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const result={format:'TabPlayerLibraryBrowseReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$rows+=@{pid=[int]$port.OwningProcess,address=[string]$port.LocalAddress,port=[int]$port.LocalPort}};ConvertTo-Json -InputObject $rows -Compress`));
  let ui;
  const invoke=async(command,args={})=>{assert.ok(allowed.includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
  const workspace=()=>invoke('workspace_snapshot'),record=async id=>invoke('project_snapshot',{documentId:id??(await workspace()).active.documentId});
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const search=(filters,text='')=>invoke('file_library_search',{query:{rootId:null,text,title:'',artist:'',instrument:'',...filters,sort:'title',offset:0,limit:100}});
  const dialog=()=>page.getByRole('dialog',{name:'Library',exact:true});
  const row=title=>dialog().getByRole('button',{name:`Select ${title}`,exact:true});
  const filter=async(label,value)=>{await dialog().getByLabel(label,{exact:true}).fill(value);};
  const clear=async()=>{await dialog().getByRole('button',{name:'Clear filters',exact:true}).click();for(const label of ['Title filter','Artist filter','Instrument filter'])assert.equal(await dialog().getByLabel(label,{exact:true}).inputValue(),'');};
  try{
    ui=await import('./workstation-commands.mjs');
    const fixture=await buildLibraryFixture(),state=writeLibraryFixture(fixture),first=state.metadata,second=state.otherMetadata;
    const only=(a,b)=>a.trackNames.find(name=>!b.trackNames.includes(name));
    const firstTrack=only(first,second),secondTrack=only(second,first);assert.ok(firstTrack&&secondTrack,'Fixture scores need a track name of their own');
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_OPEN:state.sourcePath,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:resolve(paths.results,'launch-identity.json')};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());
    assertStringCountIdentity(identity,json(resolve(paths.results,'launch-identity.json')));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths.profile,listeners());
    page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    await page.locator('.app-shell').waitFor();await dialog().getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await dialog().getByRole('button',{name:'Close',exact:true}).click();await dialog().waitFor({state:'hidden'});
    await idle();await ui.clickWorkstationButton(page,'Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await idle();

    // The score that is open before any browsing starts.
    const start=await workspace(),openId=start.active.documentId,openBefore=await record(openId);
    assert.equal(start.documents.length,1);assert.equal(openBefore.snapshot.project.base.title,first.title);assert.ok(samePath(openBefore.snapshot.path,state.sourcePath));assert.equal(openBefore.snapshot.dirty,false);
    step('A score is open before browsing',{openId,title:first.title});

    // Add the fixture folder through the real folder picker and index it.
    const library=async()=>{const file=page.locator('summary').filter({hasText:/^File$/});if(!await file.evaluate(node=>node.parentElement.open))await file.click();await page.getByRole('button',{name:'Library',exact:true}).click();await dialog().waitFor();};
    await library();await dialog().getByRole('navigation',{name:'Library sections',exact:true}).getByRole('button',{name:'Folders',exact:true}).click();
    await dialog().getByRole('button',{name:'Add folder…',exact:true}).click();owned();
    const picked=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','tests/desktop/select-library-folder.ps1','-AppProcessId',String(identity.pid),'-AppExecutable',packet.executable,'-AppStartTicks',identity.startTicks,'-OwnedDirectory',state.workDirectory,'-FolderPath',state.folderRoot],{encoding:'utf8',windowsHide:true,timeout:30000,cwd:repository}).trim();
    const catalog=await poll(()=>invoke('file_library_snapshot'),value=>value.roots.some(root=>samePath(root.path,state.folderRoot)),'Folder added');
    await dialog().getByRole('button',{name:'Refresh',exact:true}).click();await dialog().getByText(/^Scan complete/).waitFor();
    await row(first.title).waitFor();await row(second.title).waitFor();
    step('Indexed folder lists both scores',{picked,roots:catalog.roots});

    // Every filter narrows the list, and the native search agrees with the screen.
    const documentsBefore=await workspace();
    const expectOnly=async(shown,hidden)=>{await row(shown.title).waitFor();await row(hidden.title).waitFor({state:'hidden'});};
    await filter('Artist filter',second.artist);await expectOnly(second,first);
    let native=await search({artist:second.artist.toUpperCase()});assert.equal(native.total,1,'Artist filter is case-insensitive and exact to one score');assert.deepEqual(native.rows[0].metadata,second);
    await clear();await row(first.title).waitFor();
    await filter('Title filter',first.title.slice(0,5));await expectOnly(first,second);
    native=await search({title:first.title.slice(0,5)});assert.equal(native.total,1);assert.deepEqual(native.rows[0].metadata,first);
    await clear();
    await filter('Instrument filter',firstTrack);await expectOnly(first,second);
    await filter('Instrument filter',secondTrack);await expectOnly(second,first);
    native=await search({instrument:secondTrack});assert.equal(native.total,1);assert.deepEqual(native.rows[0].metadata,second);
    // Filters combine: the first score's artist with the second score's track matches nothing.
    await filter('Artist filter',first.artist);await dialog().getByText(/^No scores match this search/).waitFor();assert.equal((await search({artist:first.artist,instrument:secondTrack})).total,0);
    // A field filter never matches another field: the artist is not a track name.
    await clear();await filter('Instrument filter',second.artist);await dialog().getByText(/^No scores match this search/).waitFor();assert.equal((await search({instrument:second.artist})).total,0);
    await clear();await row(first.title).waitFor();await row(second.title).waitFor();
    // The index records no genre, so there is no genre filter and no row carries one.
    assert.equal(await dialog().getByLabel(/genre/i).count(),0,'No genre control');
    for(const found of (await search({})).rows)assert.deepEqual(Object.keys(found.metadata).sort(),['album','artist','metadataTruncated','title','trackNames'],'Only real indexed fields');
    await page.screenshot({path:resolve(paths.results,'01-filters.png')});result.screenshots.push('01-filters.png');
    assert.deepEqual(await workspace(),documentsBefore,'Searching never changes the open documents');
    step('Title, artist and instrument filters narrow the index, combine, and no genre filter exists',{});

    // Opening a result adds a tab and leaves the open score alone.
    await filter('Artist filter',second.artist);await expectOnly(second,first);
    await row(second.title).click();await dialog().getByRole('button',{name:'Open',exact:true}).click();await dialog().waitFor({state:'hidden'});await idle();
    const after=await poll(workspace,value=>value.documents.length===2,'Result opened as a second tab');
    assert.notEqual(after.active.documentId,openId,'The result is the new active tab');
    assert.ok(after.documents.some(entry=>entry.documentId===openId),'The original tab remains');
    const added=await record();assert.equal(added.snapshot.project.base.title,second.title);assert.ok(samePath(added.snapshot.path,state.folderOther));
    assert.deepEqual(await record(openId),openBefore,'The open score is untouched');
    await page.locator(`[id=${JSON.stringify(`document-tab-${encodeURIComponent(openId)}`)}]`).click();await idle();
    assert.equal((await workspace()).active.documentId,openId);assert.deepEqual(await record(),openBefore,'Switching back shows the same score');
    await page.screenshot({path:resolve(paths.results,'02-two-tabs.png')});result.screenshots.push('02-two-tabs.png');
    step('Opening a search result adds a tab and leaves the open score unchanged',{openId,addedId:added.snapshot.path});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for Library browsing filters. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runLibraryBrowseAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name)},null,2));}
}
