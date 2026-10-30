// S18 desktop acceptance: a capo and a partial capo combine per string. A GP file that already holds both reads back with the
// combined pitches in the native playback plan; a partial capo changed from the staff settings moves only the strings it
// covers, one undoable edit; and the exported GP holds the new capo properties. Reuses the S14 build packet and owned-process
// checks. Build with tests/desktop/string-count-build.mjs, then: node tests/desktop/parity-partial-capo.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';
import {assertStringCountBuild,assertStringCountIdentity,assertStringCountPortFree,stringCountEnvironment,validateStringCountArguments} from './parity-string-count.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
const hashFile=path=>sha256(readFileSync(path));
const open=[40,45,50,55,59,64];

/** One chord, a note per string at fret 3, on a guitar with capo 2; the partial capo is then written into the GPIF by hand, so the file
 * comes from outside the editor: fret 5 over strings 1 to 3, as GP stores it (one flag per string, lowest first). */
export async function buildPartialCapoFixture(){
  const {model,exporter,Settings}=await import('@coderline/alphatab'),settings=new Settings(),score=new model.Score();
  score.title='Owned partial capo acceptance';score.artist='TabPlayer public fixture';
  for(let i=0;i<2;i++){const bar=new model.MasterBar();bar.timeSignatureNumerator=4;bar.timeSignatureDenominator=4;score.addMasterBar(bar);}
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
  const track=new model.Track();track.name='Guitar';track.shortName='Gtr';Object.assign(track.playbackInfo,{program:25,primaryChannel:0,secondaryChannel:1});
  const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];staff.capo=2;staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
  let noteId=0;
  for(let barIndex=0;barIndex<2;barIndex++){
    const bar=new model.Bar();bar.id=barIndex;bar.clef=model.Clef.G2;staff.addBar(bar);const voice=new model.Voice();voice.id=barIndex;bar.addVoice(voice);
    const beat=new model.Beat();beat.id=barIndex;beat.duration=model.Duration.Whole;beat.isEmpty=false;voice.addBeat(beat);
    for(const string of [1,2,3,4,5,6]){const note=new model.Note();note.id=noteId++;note.string=string;note.fret=3;beat.addNote(note);}
    // A trill on string 1, stored as GP stores it: an absolute pitch counted from the staff capo alone (40 + 2 + 4).
    if(barIndex===0)beat.notes[0].trillValue=46;
  }
  score.finish(settings);
  const entries=unzipSync(new exporter.Gp7Exporter().export(score,settings)),xml=strFromU8(entries['Content/score.gpif']);
  const patched=xml.replace(/(<Property name="PartialCapoFret">\s*<Fret>)\d+/,'$15').replace(/(<Property name="PartialCapoStringFlags">\s*<Bitset>)[01]+/,'$1111000');
  assert.notEqual(patched,xml,'The exporter writes the partial capo properties');
  entries['Content/score.gpif']=strToU8(patched);
  return Buffer.from(zipSync(entries,{mtime:new Date(1980,0,1)}));
}
/** The sounding key of every string at fret 3, worked out from the rules rather than from the editor. */
export const combinedKeys=(capo,partialFret,partialStrings)=>open.map((pitch,at)=>pitch+3+(partialStrings.includes(at+1)?Math.max(capo,partialFret):capo));
/** The capo properties of a GP file as written, for comparison. */
export function readCapoProperties(bytes){
  const xml=strFromU8(unzipSync(bytes)['Content/score.gpif']),property=(name,child)=>new RegExp(`<Property name="${name}">\\s*<${child}>([^<]*)</${child}>`).exec(xml)?.[1];
  return {capo:Number(property('CapoFret','Fret')),partialFret:Number(property('PartialCapoFret','Fret')),flags:property('PartialCapoStringFlags','Bitset')};
}

export async function runPartialCapoAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'partial-capo-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'partial-capo.gp'),identityPath=resolve(paths.results,'launch-identity.json'),exportBase=resolve(paths.export,'partial-capo');
  const result={format:'TabPlayerPartialCapoReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],edits:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
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
    const marks=await poll(()=>view().locator('.fret-note').evaluateAll(nodes=>nodes.map(node=>[Number(node.dataset.string),Number(node.dataset.key),Number(node.dataset.fret)])),value=>value.length===6,'six planned notes of the selected beat');
    return marks.sort((a,b)=>a[0]-b[0]);
  };
  /** The open pitch each string row is titled with, lowest string first. */
  const openPitches=async()=>(await view().locator('[data-string-row] title').evaluateAll(nodes=>nodes.map(node=>node.textContent))).map(title=>{const [, string, pitch]=/^String (\d+) · (.+)$/.exec(title);return [Number(string),pitch];}).sort((a,b)=>a[0]-b[0]).map(entry=>entry[1]);
  const checked=async()=>Promise.all([1,2,3,4,5,6].map(string=>page.getByRole('checkbox',{name:new RegExp(`^String ${string} \\(`)}).isChecked()));
  try{
    ui=await import('./workstation-commands.mjs');
    writeFileSync(inputPath,await buildPartialCapoFixture(),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
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

    // The file's own capo (2) and partial capo (fret 5, strings 1-3): the plan sounds each string by its own rule.
    await button('Show instrument');await view().getByRole('img',{name:'Guitar fretboard',exact:true}).waitFor();
    await view().getByRole('combobox',{name:/^Show/}).selectOption('beat');
    assert.match(await view().locator('.instrument-detail').innerText(),/Capo 2.*Partial capo 5 on strings 1, 2, 3/s,'The readout names both capos');
    const opened=await keys(),expectedOpen=combinedKeys(2,5,[1,2,3]);
    assert.deepEqual(opened.map(mark=>mark[1]),expectedOpen,'Imported capo and partial capo: strings 1-3 sound by fret 5, strings 4-6 by capo 2');
    assert.deepEqual(opened.map(mark=>mark[2]),[3,3,3,3,3,3],'Fret numbers are kept');
    assert.notDeepEqual(expectedOpen,combinedKeys(2,0,[]),'The partial capo changes the pitches');
    assert.deepEqual(await openPitches(),['A2','D3','G3','A3','C#4','F#4'],'Open strings in the view include the capo that acts on each');
    await page.screenshot({path:resolve(paths.results,'01-imported.png')});result.screenshots.push('01-imported.png');
    step('A GP file with a capo and a partial capo plays and shows each string by its own capo',{keys:opened});

    // Change the partial capo from the staff settings: fret 7 over strings 4 and 5 only.
    await ui.revealInspector(page);
    await page.locator('summary').filter({hasText:'Staff, voices'}).first().evaluate(node=>{node.parentElement.open=true;});
    assert.deepEqual(await checked(),[true,true,true,false,false,false],'The settings show the staff\'s partial capo');
    assert.equal(await page.getByLabel('Partial capo fret',{exact:true}).inputValue(),'5');
    for(const string of [1,2,3])await page.getByRole('checkbox',{name:new RegExp(`^String ${string} \\(`)}).uncheck();
    for(const string of [4,5])await page.getByRole('checkbox',{name:new RegExp(`^String ${string} \\(`)}).check();
    const fret=page.getByLabel('Partial capo fret',{exact:true});await fret.fill('7');await fret.press('Enter');
    assert.deepEqual(await edits(),[],'Choosing a partial capo changes nothing until it is applied');
    await button('Apply staff settings');
    const after=await poll(record,value=>value.snapshot.project.edits.length===1,'one staff settings edit');
    assert.deepEqual(after.snapshot.project.edits[0].settings.partialCapo,{fret:7,strings:[4,5]},'The command carries the partial capo');
    assert.equal(after.snapshot.project.edits[0].settings.capo,2);
    assert.equal(after.snapshot.project.partialCapo,true,'The first edit of a file with a partial capo marks the project, so it keeps applying');
    const changed=await keys(),expectedChanged=combinedKeys(2,7,[4,5]);
    assert.deepEqual(changed.map(mark=>mark[1]),expectedChanged,'Strings 4 and 5 sound by fret 7; the other strings by the capo alone');
    assert.deepEqual(changed.map(mark=>mark[1]).slice(0,3),combinedKeys(2,0,[]).slice(0,3),'Strings 1-3 are back to the capo alone');
    assert.equal(changed[5][1],opened[5][1],'String 6 is untouched');
    await page.screenshot({path:resolve(paths.results,'02-changed.png')});result.screenshots.push('02-changed.png');
    result.edits.push(after.snapshot.project.edits[0]);
    step('A changed partial capo moves only the strings it covers, in one edit',{keys:changed});

    // Undo and redo restore the project and the sound exactly.
    await button('Undo');assert.deepEqual((await record()).snapshot.project,{...initial.snapshot.project,partialCapo:true},'Undo restores the project; the marker, which is not an edit, stays');
    assert.deepEqual((await keys()).map(mark=>mark[1]),expectedOpen,'Undo restores the pitches');
    await button('Redo');assert.deepEqual((await record()).snapshot.project,after.snapshot.project,'Redo restores the edit');
    assert.deepEqual((await keys()).map(mark=>mark[1]),expectedChanged,'Redo restores the pitches');
    step('Undo and redo restore the partial capo exactly',{});

    // A note entered from the view sounds at its string's own pitch.
    await view().getByRole('checkbox',{name:'Click to edit notes',exact:true}).check();
    const count=(await edits()).length;
    await view().getByRole('button',{name:/^String 6, fret 5 \(/}).click();await idle();
    const entered=await poll(edits,value=>value.length===count+1,'one entry edit');
    assert.deepEqual(entered.at(-1),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5});
    await view().getByRole('checkbox',{name:'Click to edit notes',exact:true}).uncheck();
    assert.equal((await keys())[5][1],64+2+5,'String 6 sounds at the capo plus the fret');
    step('Entry from the instrument view uses the string\'s own capo',{});

    // The exported GP holds the capo and the new partial capo, and its notes keep their frets.
    await button('Undo');
    const exportPath=`${exportBase}.gp`;assert.equal(existsSync(exportPath),false);await button('Export GP');
    const exported=readFileSync(exportPath),written=readCapoProperties(exported);
    assert.deepEqual(written,{capo:2,partialFret:7,flags:'000110'},'Capo 2 and a partial capo of fret 7 over strings 4 and 5, flags lowest string first');
    // Read the exported file back with an independent reader (alphaTab, which ignores the partial capo) and apply the written rules
    // by hand: the pitches must be the ones the app sounded, and the trill must be stored untouched, not drifted by the capo.
    const {importer,Settings}=await import('@coderline/alphatab'),reopened=importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(exported),new Settings());
    const staff=reopened.tracks[0].staves[0],covered=[...written.flags].flatMap((flag,at)=>flag==='1'?[at+1]:[]);
    const reread=staff.bars[0].voices[0].beats[0].notes.map(note=>[note.string,note.realValue+(covered.includes(note.string)?Math.max(staff.capo,written.partialFret)-staff.capo:0)]).sort((a,b)=>a[0]-b[0]);
    assert.deepEqual(reread.map(entry=>entry[1]),expectedChanged,'The reopened file sounds the pitches the app played');
    const trill=staff.bars[0].voices[0].beats[0].notes.find(note=>note.string===1);
    assert.equal(trill.trillValue,46,'The trill is written as it was read: relative to the staff capo alone, with no drift');
    assert.deepEqual((await record()).snapshot.project,after.snapshot.project,'Export never edits');
    step('The exported GP holds the capo and the partial capo',{exportPath,sha256:hashFile(exportPath),written});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for the partial capo. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runPartialCapoAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),edits:outcome.edits},null,2));}
}
