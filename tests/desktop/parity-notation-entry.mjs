// E05 desktop acceptance: the Standard notation entry staff enters pitches by mouse and keyboard on fretted and pitched
// staves as native edits with exact undo and redo. Reuses the S14 build packet and owned-process checks. Build with
// tests/desktop/string-count-build.mjs, then: node tests/desktop/parity-notation-entry.mjs --run --build=<absolute build.json>
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

export async function runNotationEntryAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'notation-entry-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'notation-entry.gp'),identityPath=resolve(paths.results,'launch-identity.json'),exportBase=resolve(paths.export,'notation-entry');
  const result={format:'TabPlayerNotationEntryReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],edits:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  let ui,load,Ottavia,prepared;
  const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot','audio_status'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
  const workspace=()=>invoke('workspace_snapshot'),record=async()=>invoke('project_snapshot',{documentId:(await workspace()).active.documentId});
  const native=()=>poll(()=>invoke('audio_status'),value=>{assert.equal(value.error,null);return value.ready&&value.generation===value.desiredGeneration;},'paused current native preparation');
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  const staff=()=>page.getByRole('group',{name:'Pitch entry staff',exact:true});
  const entry=name=>staff().getByRole('button',{name,exact:true});
  // The palette repeats Key signature as an icon button; the entry staff's own button is the one with text.
  const choose=name=>{const button=page.getByRole('button',{name,exact:true});return name==='Key signature'?button.and(page.locator(':not(.tp-glyph-btn)')):button;};
  const edits=async()=>(await record()).snapshot.project.edits;
  // An entry sends the expected commands, in order. Undo restores the record before them and Redo the one after;
  // `keep` leaves them applied, otherwise a last Undo removes them so the next probe starts from the same score.
  const probe=async(label,act,expected,keep=false)=>{
    const before=await record(),count=before.snapshot.project.edits.length;
    await act();await idle();
    const after=await poll(record,value=>value.snapshot.project.edits.length===count+expected.length,`${label}: ${expected.length} edit(s)`);
    const added=after.snapshot.project.edits.slice(count);
    assert.deepEqual(added.map(edit=>edit.type),expected.map(edit=>edit.type),`${label}: command types`);
    expected.forEach((edit,index)=>assert.deepEqual(Object.fromEntries(Object.entries(added[index]).filter(([key])=>key in edit)),edit,`${label}: command ${index}`));
    for(let i=0;i<expected.length;i++)await button('Undo');assert.deepEqual((await record()).snapshot.project,before.snapshot.project,`${label}: undo restores`);
    for(let i=0;i<expected.length;i++)await button('Redo');assert.deepEqual((await record()).snapshot.project,after.snapshot.project,`${label}: redo restores`);
    if(!keep){for(let i=0;i<expected.length;i++)await button('Undo');assert.deepEqual((await record()).snapshot.project,before.snapshot.project,`${label}: probe removed`);}
    result.edits.push({label,commands:expected,kept:keep});return after;
  };
  const press=async keys=>{await staff().focus();for(const key of keys)await page.keyboard.press(key);};
  try{
    ui=await import('./workstation-commands.mjs');const {importer,exporter,model,Settings}=await import('@coderline/alphatab');load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());Ottavia=model.Ottavia;
    await buildInstrumentFixture();
    // The guitar staff gets a Guitar Pro style display transposition, so the file covers both it and the others' zero.
    const fixtureScore=load(readFileSync(fixturePath));fixtureScore.tracks[0].staves[0].displayTranspositionPitch=-12;
    const inputBytes=new exporter.Gp7Exporter().export(fixtureScore,new Settings());writeFileSync(inputPath,inputBytes,{flag:'wx'});prepared=load(inputBytes);result.input={inputPath,sha256:hashFile(inputPath)};
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

    // Choosing an accidental or an octave never edits.
    await staff().waitFor();await choose('Sharp').click();await choose('Octave up').click();await choose('Octave down').click();await choose('Key signature').click();
    assert.deepEqual(await record(),initial,'Choosing an accidental or octave never edits');

    // Expectations come from the prepared file's own staff settings, using the rule alphaTab draws by:
    // written = sounding + clef ottava shift - displayTranspositionPitch. So sounding = written - offset.
    const ottava={[Ottavia._15ma]:-24,[Ottavia._8va]:-12,[Ottavia._8vb]:12,[Ottavia._15mb]:24};
    const offsetOf=trackIndex=>{const staff=prepared.tracks[trackIndex].staves[0];return (ottava[staff.bars[0].clefOttava]??0)-staff.displayTranspositionPitch;};
    // The lowest fret from 0 to 24 on a free string, the way the app's keyboard entry chooses.
    const lowestFret=(trackIndex,written,occupied)=>{const tuning=prepared.tracks[trackIndex].staves[0].tuning,key=written-offsetOf(trackIndex);let best=null;
      for(let string=1;string<=tuning.length;string++){if(occupied.includes(string))continue;const fret=key-tuning[tuning.length-string];if(fret>=0&&fret<=24&&(!best||fret<best.fret))best={string,fret};}
      assert.ok(best,'The fixture pitch is playable');return best;};
    const guitar=prepared.tracks[0].staves[0];assert.equal(guitar.displayTranspositionPitch,-12,'The guitar staff has a display transposition');

    // Fretted (Guitar9, display transposition -12): the written pitch is drawn an octave above the sounding pitch.
    const g={track:0,...at},occupied=[9,8,1];
    await probe('staff click adds',()=>entry('D5').click(),[{type:'setNote',target:g,...lowestFret(0,74,occupied)}]);
    await probe('sharp then click',async()=>{await choose('Sharp').click();await entry('F#5').click();},[{type:'setNote',target:g,...lowestFret(0,78,occupied)}]);
    assert.equal(await choose('Key signature').getAttribute('aria-pressed'),'true','The accidental lasts for one note');
    const flat=lowestFret(0,70,occupied);
    await probe('flat then click spells the flat',async()=>{await choose('Flat').click();await entry('Bb4').click();},[{type:'sequence',commands:[{type:'setNote',target:g,...flat},{type:'setNoteSpelling',target:g,noteIndex:occupied.length,accidentalMode:5}]}],true);
    await probe('click removes a present note',()=>entry('Remove E5').click(),[{type:'removeNote',target:g,string:9}],true);
    await page.screenshot({path:resolve(paths.results,'01-fretted-staff.png')});result.screenshots.push('01-fretted-staff.png');
    step('Staff clicks add, flat-spell and remove fretted notes, each undoable',{edits:result.edits});

    // Bass clef staff (Bass6): the same rule with the bass clef.
    await ui.selectWorkspaceTrack(page,'Track 2: Bass6');await staff().waitFor();
    const b={track:1,...at},bass=lowestFret(1,45,[6,4,1]);
    await probe('bass clef click adds',()=>entry('A2').click(),[{type:'setNote',target:b,...bass}],true);

    // Pitched (Keys, written pitch): mouse, then keyboard letters, accidentals and octave keys.
    await ui.selectWorkspaceTrack(page,'Track 4: Keys');await staff().waitFor();
    const k={track:3,...at};
    assert.equal(offsetOf(3),0,'The keys staff draws stored pitches as they are');
    await probe('pitched click adds',()=>entry('D4').click(),[{type:'addPitchedNote',target:k,pitch:62}],true);
    await probe('pitched click removes',()=>entry('Remove E4').click(),[{type:'removeNoteByIndex',target:k,noteIndex:1}],true);
    await probe('keyboard sharp then letter',()=>press(['#','f']),[{type:'addPitchedNote',target:k,pitch:66}],true);
    await probe('keyboard octave up then letter',()=>press(['PageUp','a']),[{type:'addPitchedNote',target:k,pitch:81}],true);
    await probe('keyboard cursor then Enter',()=>press(['ArrowDown','Enter']),[{type:'addPitchedNote',target:k,pitch:79}],true);
    await page.screenshot({path:resolve(paths.results,'02-pitched-staff.png')});result.screenshots.push('02-pitched-staff.png');
    step('Mouse and keyboard enter pitched notes with accidentals, octave keys and the cursor',{edits:result.edits});

    // Percussion has no pitch entry.
    await ui.selectWorkspaceTrack(page,'Track 3: Drums');await staff().waitFor();
    const kept=(await edits()).length;await press(['c']);await idle();
    assert.equal((await edits()).length,kept,'No pitch entry on a percussion staff');
    await page.getByText('Use the drum kit in the instrument view',{exact:false}).first().waitFor();step('Percussion staves refuse pitch entry',{});

    // The saved score carries every kept change, drawn where it was entered, with the flat spelling.
    const final=await record();assert.equal(final.snapshot.project.edits.length,8);
    const exportPath=`${exportBase}.gp`;assert.equal(existsSync(exportPath),false);await button('Export GP');
    const score=load(readFileSync(exportPath)),beat=track=>score.tracks[track].staves[0].bars[0].voices[0].beats[0].notes;
    assert.deepEqual(beat(0).map(note=>[note.string,note.fret]).sort((a,b)=>a[0]-b[0]),[[1,0],[flat.string,flat.fret],[8,1]].sort((a,b)=>a[0]-b[0]));
    const flatNote=beat(0).find(note=>note.string===flat.string);assert.equal(flatNote.displayValue,70,'Bb4 is drawn at the clicked pitch');assert.equal(flatNote.accidentalMode,5,'The flat spelling is saved');
    assert.equal(beat(1).find(note=>note.string===bass.string&&note.fret===bass.fret).displayValue,45,'The bass note is drawn at the clicked pitch');
    assert.deepEqual(beat(3).map(note=>note.displayValue).sort((a,b)=>a-b),[60,62,66,67,79,81],'Keys notes are drawn at the clicked pitches');
    assert.deepEqual(await record(),final,'Export never edits');step('Exported GP reads back every entered and removed note with its display value and spelling',{exportPath,sha256:hashFile(exportPath)});

    // A new blank document draws guitars at sounding pitch (display transposition 0), so E4 is the open first string.
    await button('New');await staff().waitFor();
    const blank={track:0,...at};
    await probe('blank guitar click',()=>entry('E4').click(),[{type:'setNote',target:blank,string:6,fret:0}]);
    step('A blank-project guitar enters at the pitch its staff displays',{});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for standard notation pitch entry. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runNotationEntryAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),edits:outcome.edits},null,2));}
}
