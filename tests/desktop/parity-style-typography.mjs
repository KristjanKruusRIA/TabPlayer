// D12 desktop acceptance: text typography (font family, text, title and tab-number sizes) and the Classic, Jazz and Rock
// notation presets change how the score is drawn through one undoable setEngraving edit, with no overflowing text and
// the exported music unchanged; a saved style carries its typography; and a version 1 style library from before
// typography is read, listed and upgraded without losing its styles. Reuses the S14 build packet and owned-process
// checks. Build with tests/desktop/string-count-build.mjs, then:
// node tests/desktop/parity-style-typography.mjs --run --build=<absolute build.json>
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
const typed={family:'mono',textScale:1.5,titleScale:1.5,tabScale:1.25};
const oldStyleId='7d9b0b64-3a9e-4a52-9c1e-0d1f3f6f2a10';

export async function runStyleTypographyAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  // The user's real library must be untouched; the run's library lives in its own app-data folder.
  const realLibrary=resolve(process.env.APPDATA,'dev.tabplayer.desktop','style-library.json'),realHash=()=>existsSync(realLibrary)?hashFile(realLibrary):null,realBefore=realHash();
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'style-typography-')),appData=resolve(runDirectory,'app-data'),results=resolve(runDirectory,'results'),exportDirectory=resolve(runDirectory,'export'),input=resolve(runDirectory,'input');
  for(const path of [appData,results,exportDirectory,input])mkdirSync(path);
  const libraryPath=resolve(appData,'style-library.json'),inputPath=resolve(input,'typography.gp'),exportBase=resolve(exportDirectory,'typography');
  const result={format:'TabPlayerStyleTypographyReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,appData,libraryPath,realLibrary,realBefore,assertions:[],exports:[],screenshots:[],launches:[],pageErrors:[],fallbacks:[],cleanup:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');assert.equal(hashFile(packet.executable),packet.executableSha256.toLowerCase(),'Executable bytes changed');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  const stop=async()=>{if(browser){await browser.close();browser=null;page=null;}if(identity){if(inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);assert.equal(inspect(),null);identity=null;}await poll(portRows,rows=>rows.length===0,'diagnostic port released');};
  let ui,load,jsonModel;
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
  const percent=async(label,value)=>{const field=page.getByLabel(label,{exact:true});await field.fill(String(value));await field.press('Enter');};
  const openPanels=async()=>{await button('Presentation');for(const name of ['Engraving','Typography','Notation style presets','Saved styles'])await details(name);};
  // Notes of the exported score: typography may change how the score is drawn, never what it holds.
  const notesOf=bytes=>JSON.stringify(load(bytes).tracks.map(track=>track.staves.map(staff=>staff.bars.map(bar=>bar.voices.map(voice=>voice.beats.map(beat=>[beat.duration,beat.notes.map(note=>[note.string,note.fret,note.realValue])]))))));
  let baseline=null;
  const exportCheck=async label=>{
    const beforeRecord=await record(),path=`${exportBase}.gp`;assert.equal(existsSync(path),false);await button('Export GP');const bytes=readFileSync(path),music=notesOf(bytes);
    baseline??=music;assert.equal(music,baseline,`${label}: the exported notes are unchanged`);assert.deepEqual(await record(),beforeRecord,'Export must not change project/history/revision');
    const saved=resolve(exportDirectory,`${String(result.exports.length+1).padStart(2,'0')}-${label}.gp`);renameSync(path,saved);result.exports.push({label,path:saved,sha256:sha256(bytes)});await native();
  };
  const rendered=async()=>sha256(Buffer.from((await page.locator('[aria-label="Music notation"] svg').evaluateAll(nodes=>nodes.map(node=>node.outerHTML))).join('')));
  // The text actually drawn: its families, its largest non-music size, and any text that spills outside its own page tile.
  const drawn=()=>page.locator('[aria-label="Music notation"] svg').evaluateAll(nodes=>{
    const texts=nodes.flatMap(svg=>[...svg.querySelectorAll('text')].filter(text=>text.textContent.trim()).map(text=>({svg,text,style:getComputedStyle(text)})));
    const words=texts.filter(({style})=>!/alphatab|bravura/i.test(style.fontFamily));
    const spill=texts.filter(({svg,text})=>{const box=svg.getBoundingClientRect(),rect=text.getBoundingClientRect();return rect.width>0&&(rect.left<box.left-2||rect.right>box.right+2||rect.top<box.top-2||rect.bottom>box.bottom+2);}).map(({text})=>text.textContent);
    return {families:[...new Set(words.map(({style})=>style.fontFamily))],largest:Math.max(0,...words.map(({style})=>parseFloat(style.fontSize))),count:words.length,spill};
  });
  const edits=async()=>(await record()).snapshot.project.edits;
  try{
    ui=await import('./workstation-commands.mjs');const {importer,model,Settings}=await import('@coderline/alphatab');load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());jsonModel=model.JsonConverter;void jsonModel;
    writeFileSync(inputPath,await buildSavedTuningsFixture(),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
    assert.equal(existsSync(libraryPath),false);

    // Launch 1: typography is one undoable edit that changes the drawing and nothing in the music.
    await launch('launch-1');let initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);
    await native();await exportCheck('before');
    const plain=await drawn(),drawnBefore=await rendered();assert.ok(plain.count>0,'The score draws text');assert.deepEqual(plain.spill,[],'No text spills before the change');assert.ok(!plain.families.some(family=>/consolas|monospace/i.test(family)),'No monospace text before the change');
    await openPanels();
    await choose('Text font','mono');await percent('Text size (%)',150);await percent('Title size (%)',150);await percent('Tab number size (%)',125);
    assert.deepEqual((await record()).snapshot.project.edits,[],'Typing and choosing never edit the document before Apply');
    await button('Apply engraving');
    const applied=await record();assert.deepEqual(applied.snapshot.project.edits.map(edit=>edit.type),['setEngraving']);assert.deepEqual(applied.snapshot.project.edits[0].engraving.typography,typed);
    const large=await poll(drawn,value=>value.families.some(family=>/consolas|monospace/i.test(family)),'the score is drawn in the chosen font');
    assert.ok(large.largest>plain.largest,'Text is drawn larger');assert.deepEqual(large.spill,[],'No text spills after the change');
    const drawnTyped=await rendered();assert.notEqual(drawnTyped,drawnBefore);await shot('typography-applied');await exportCheck('typography');
    await button('Undo');assert.deepEqual((await record()).snapshot.project,initial.snapshot.project,'Undo restores the record');assert.equal(await poll(rendered,value=>value===drawnBefore,'undo restores the drawing'),drawnBefore);await exportCheck('typography-undo');
    await button('Redo');assert.deepEqual((await record()).snapshot.project,applied.snapshot.project,'Redo restores the record');assert.equal(await poll(rendered,value=>value===drawnTyped,'redo restores the drawing'),drawnTyped);
    step('Typography is one undoable edit that changes the drawing without overflow and leaves the music unchanged',{typography:typed,plain,large});

    // The smallest sizes must lay out too, without the music changing.
    await percent('Text size (%)',50);await percent('Title size (%)',50);await percent('Tab number size (%)',75);await button('Apply engraving');
    const small=await poll(drawn,value=>value.largest<plain.largest,'smaller text');assert.deepEqual(small.spill,[],'No text spills at the smallest sizes');await exportCheck('smallest');
    assert.equal((await edits()).length,2);

    // Presets fill the form and edit nothing until Apply; the applied preset is one more undoable edit.
    const countBefore=(await edits()).length;await page.getByRole('button',{name:'Load Jazz preset',exact:true}).click();await idle();
    assert.equal((await edits()).length,countBefore,'Loading a preset never edits the document');
    await button('Apply engraving');
    const jazz=await record(),jazzEdit=jazz.snapshot.project.edits.at(-1);assert.equal(jazz.snapshot.project.edits.length,countBefore+1);
    assert.deepEqual(jazzEdit.engraving.typography,{family:'serif',textScale:1.15,titleScale:1.4,tabScale:null});assert.equal(jazzEdit.engraving.stylesheet.chords,'both');assert.equal(jazzEdit.engraving.stylesheet.barNumbers,'all');
    const jazzDrawn=await poll(drawn,value=>value.families.every(family=>!/consolas|monospace/i.test(family)),'Jazz serif text');assert.deepEqual(jazzDrawn.spill,[]);await shot('jazz-preset');await exportCheck('jazz');
    await button('Undo');assert.equal((await edits()).length,countBefore);await button('Redo');assert.deepEqual((await record()).snapshot.project,jazz.snapshot.project);
    step('A notation preset fills the form, applies as one undoable edit and leaves the music unchanged',{jazzEdit});

    // A saved style carries its typography into the personal library (version 2).
    await page.getByLabel('Style name',{exact:true}).fill('Jazz house');await page.getByRole('button',{name:'Save current style',exact:true}).click();
    await poll(()=>existsSync(libraryPath),Boolean,'library file written');await page.getByRole('status').filter({hasText:'Saved Jazz house.'}).waitFor();
    const library=json(libraryPath);assert.equal(library.version,2);assert.equal(library.entries.length,1);assert.deepEqual(library.entries[0].engraving.typography,jazzEdit.engraving.typography);assert.deepEqual(library.entries[0].engraving.profiles,[]);
    assert.deepEqual(await record(),jazz,'Saving a style never edits the document');
    // Force default style clears typography with the rest, as one undoable edit.
    await page.getByRole('button',{name:'Force default style',exact:true}).click();await idle();
    const forced=await record();assert.equal(forced.snapshot.project.edits.length,jazz.snapshot.project.edits.length+1);assert.equal(Object.hasOwn(forced.snapshot.project.edits.at(-1).engraving,'typography'),false,'Default typography is not stored');
    assert.equal(await poll(rendered,value=>value===drawnBefore,'the factory style draws the original score'),drawnBefore);await exportCheck('forced');
    await button('Undo');assert.deepEqual((await record()).snapshot.project,jazz.snapshot.project);
    step('A saved style carries typography and Force default style clears it',{entry:library.entries[0]});
    await stop();

    // Launch 2: a version 1 library written before typography is read, listed, applied and upgraded on the next save.
    const oldEngraving={stylesheet:{...library.entries[0].engraving.stylesheet,barNumbers:'hidden'},notation:library.entries[0].engraving.notation,systemSpacing:null,profiles:[]};
    const oldLibrary=Buffer.from(JSON.stringify({format:'tabplayer-style-library',version:1,entries:[{id:oldStyleId,name:'Older style',engraving:oldEngraving}]}));writeFileSync(libraryPath,oldLibrary);const oldHash=hashFile(libraryPath);
    baseline=null;await launch('launch-2');initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);await openPanels();
    await page.getByRole('combobox',{name:'Saved style',exact:true}).selectOption(oldStyleId);
    assert.equal(hashFile(libraryPath),oldHash,'Reading a version 1 library never rewrites it');assert.equal(await page.getByRole('alert').filter({hasText:'Could not read saved styles'}).count(),0,'A version 1 library is not damaged');
    await page.getByRole('button',{name:'Apply saved style',exact:true}).click();await idle();
    const oldApplied=await record();assert.equal(oldApplied.snapshot.project.edits.length,1);assert.equal(oldApplied.snapshot.project.edits[0].engraving.stylesheet.barNumbers,'hidden');assert.equal(Object.hasOwn(oldApplied.snapshot.project.edits[0].engraving,'typography'),false);
    await page.getByLabel('Style name',{exact:true}).fill('Newer style');await page.getByRole('button',{name:'Save current style',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved Newer style.'}).waitFor();
    const upgraded=json(libraryPath);assert.equal(upgraded.version,2);assert.deepEqual(upgraded.entries.map(entry=>entry.name),['Older style','Newer style']);assert.deepEqual(upgraded.entries[0].engraving,oldEngraving,'The older style is kept as it was');
    await shot('old-library-upgraded');step('A version 1 style library stays readable and is upgraded to version 2 on the next save',{oldHash,upgraded});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for style typography and notation presets. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runStyleTypographyAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),screenshots:outcome.screenshots},null,2));}
}
