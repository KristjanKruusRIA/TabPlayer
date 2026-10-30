// A30 desktop acceptance: one note's audio settings (sounding length, start offset, velocity change) are set from the inspector,
// each one undoable edit, leave the written score alone, and reach the native plan, a MIDI export and an audio export.
// Reuses the S14 build packet and owned-process checks. Build with tests/desktop/string-count-build.mjs, then:
// node tests/desktop/parity-note-audio.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';
import {assertStringCountBuild,assertStringCountIdentity,assertStringCountPortFree,stringCountEnvironment,validateStringCountArguments} from './parity-string-count.mjs';
import {strFromU8,unzipSync} from 'fflate';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
const hashFile=path=>sha256(readFileSync(path));
const first={track:0,staff:0,bar:0,voice:0,beat:0};
/** What the three fields are set to, one after the other. */
const settings={length:50,offset:240,velocity:20};

/** One bar of 4/4 at 120 bpm on a six-string guitar: a note on string 1 (fret 5), one on string 2 (fret 3), one on string 3 (fret 2), then a rest. 960 ticks is half a second. */
export async function buildNoteAudioFixture(){
  const {model,exporter,Settings}=await import('@coderline/alphatab'),options=new Settings(),score=new model.Score();
  score.title='Owned note audio acceptance';score.artist='TabPlayer public fixture';
  const master=new model.MasterBar();master.timeSignatureNumerator=4;master.timeSignatureDenominator=4;master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.addMasterBar(master);
  const track=new model.Track();track.name='Guitar';track.shortName='Gtr';Object.assign(track.playbackInfo,{program:25,primaryChannel:0,secondaryChannel:1});
  const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
  const bar=new model.Bar();bar.id=0;bar.clef=model.Clef.G2;staff.addBar(bar);const voice=new model.Voice();voice.id=0;bar.addVoice(voice);
  [[1,5],[2,3],[3,2],null].forEach((entry,index)=>{
    const beat=new model.Beat();beat.id=index;beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);
    if(entry){const note=new model.Note();note.id=index;note.string=entry[0];note.fret=entry[1];beat.addNote(note);}
  });
  score.finish(options);
  return Buffer.from(new exporter.Gp7Exporter().export(score,options));
}
/** A Standard MIDI File's note events, read byte by byte with no library: [tick, key, velocity] for every note on, and [tick, key] for every note off. */
export function readNotes(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),text=(at,count)=>String.fromCharCode(...bytes.subarray(at,at+count));
  assert.equal(text(0,4),'MThd');const tracks=view.getUint16(10),division=view.getUint16(12);let at=14;const on=[],off=[];
  for(let track=0;track<tracks;track++){
    assert.equal(text(at,4),'MTrk');const end=at+8+view.getUint32(at+4);at+=8;let tick=0,status=0;
    const variable=()=>{let value=0,byte;do{byte=bytes[at++];value=value*128+(byte&127);}while(byte&128);return value;};
    while(at<end){
      tick+=variable();let type=bytes[at];if(type&128){at++;if(type<240)status=type;}else type=status;
      if(type===255||type===240||type===247){if(type===255)at++;const length=variable();at+=length;}
      else{const kind=type&240,size=kind===192||kind===208?1:2,key=bytes[at],value=size===2?bytes[at+1]:0;at+=size;if(kind===144&&value>0)on.push([tick,key,value]);else if(kind===128||kind===144)off.push([tick,key]);}
    }
  }
  return {division,on:on.sort((a,b)=>a[0]-b[0]||a[1]-b[1]),off:off.sort((a,b)=>a[0]-b[0]||a[1]-b[1])};
}
/** The frame a 16-bit PCM WAV first rises above `threshold`, and its peak. */
export function readWave(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.readUInt16LE(34),16);const channels=bytes.readUInt16LE(22),rate=bytes.readUInt32LE(24);
  let onset=-1,peak=0;const frames=(bytes.length-44)/(2*channels);
  for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels;channel++){
    const value=Math.abs(bytes.readInt16LE(44+(frame*channels+channel)*2));if(value>peak)peak=value;if(onset<0&&value>=300)onset=frame;
  }
  return {onset,peak,rate,frames};
}

export async function runNoteAudioAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'note-audio-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'note-audio.gp'),identityPath=resolve(paths.results,'launch-identity.json'),exportFolder=paths.export;
  const result={format:'TabPlayerNoteAudioReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],edits:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
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
  const edits=async()=>(await record()).snapshot.project.edits;
  const field=name=>page.getByLabel(name,{exact:false});
  /** Opens a disclosure and every one around it. */
  const reveal=async locator=>locator.evaluate(node=>{for(let item=node.closest('details');item;item=item.parentElement?.closest('details'))item.open=true;});
  /** Exports through the dialog and waits for the file; the app shell stays busy while the dialog is open. The desktop-test GP path takes one fixed destination, so that file is renamed once written. */
  const gpTarget=resolve(exportFolder,'written.gp');
  const exportAs=async({format,name,extension,audio})=>{
    await ui.clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption(format);
    if(audio){await dialog.getByLabel('Bit depth').selectOption('16');await dialog.getByLabel('Effect tail (seconds)').fill('0.1');}
    await dialog.getByLabel('File name',{exact:true}).fill(name);await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const path=resolve(exportFolder,`${name}.${extension}`),written=format==='gp'?gpTarget:path,until=performance.now()+120000;
    while(performance.now()<until&&!existsSync(written)){const failure=dialog.getByRole('alert');if(await failure.count())throw Error(await failure.innerText());await sleep(200);}
    assert.ok(existsSync(written),`${name}.${extension} was written`);if(written!==path)renameSync(written,path);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await idle();await sleep(300);
    return path;
  };
  try{
    ui=await import('./workstation-commands.mjs');const {importer,Settings}=await import('@coderline/alphatab');load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
    writeFileSync(inputPath,await buildNoteAudioFixture(),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT_DIR:exportFolder,TABPLAYER_TEST_EXPORT:gpTarget,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
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

    // Before any setting: the baseline MIDI, audio and GP the later ones are compared with.
    const baseMidi=readNotes(readFileSync(await exportAs({format:'midi',name:'baseline',extension:'mid'})));
    assert.equal(baseMidi.division,960);assert.equal(baseMidi.on.length,3,'Three notes and a rest');
    assert.deepEqual(baseMidi.on.map(note=>note[0]),[0,960,1920],'Notes on beats 1, 2 and 3');
    assert.deepEqual(baseMidi.on.map(note=>note[1]),[45,48,52],'Frets 5, 3 and 2 on alphaTab strings 1, 2 and 3, counted from the lowest');
    const baseLength=baseMidi.off[0][0]-baseMidi.on[0][0];assert.ok(baseLength>=100,'The first note has a length to scale');
    const baseWave=readWave(readFileSync(await exportAs({format:'wav',name:'baseline',extension:'wav',audio:true})));
    assert.ok(baseWave.onset>=0&&baseWave.peak>300,'The baseline audio sounds');
    const baseGp=await exportAs({format:'gp',name:'baseline',extension:'gp'});
    assert.deepEqual(await record(),initial,'Exporting never edits');
    step('The baseline exports exist and the document is untouched',{baseMidi,baseWave:{onset:baseWave.onset,peak:baseWave.peak}});

    // The inspector: the first note's three fields, each committed on Enter or blur, each one setNoteTechniques edit.
    await ui.revealInspector(page);await page.getByRole('combobox',{name:/^String/}).first().selectOption('1');await idle();
    await reveal(page.locator('summary').filter({hasText:'Notes & techniques'}).first());
    await page.getByText('Note controls apply to string 1.',{exact:false}).waitFor();
    const length=field('Sounding length'),offset=field('Start offset'),velocity=field('Velocity change');
    assert.deepEqual([await length.inputValue(),await offset.inputValue(),await velocity.inputValue()],['100','0','0'],'A note starts at the plain values');
    assert.equal(await page.getByRole('button',{name:'Reset note audio',exact:true}).isDisabled(),true,'Nothing to reset yet');
    // A value is committed on Enter or blur, never while typing.
    await length.fill('5');await length.fill(String(settings.length));assert.deepEqual(await edits(),[],'Typing changes nothing');
    await length.press('Enter');
    const command=audio=>({type:'setNoteTechniques',target:first,string:1,patch:{audio}});
    const afterLength=await poll(record,value=>value.snapshot.project.edits.length===1,'length edit');await idle();
    assert.deepEqual(afterLength.snapshot.project.edits[0],command({length:settings.length,offset:0,velocity:0}),'Length alone');
    await offset.fill(String(settings.offset));await offset.blur();await idle();
    const afterOffset=await poll(record,value=>value.snapshot.project.edits.length===2,'offset edit');
    assert.deepEqual(afterOffset.snapshot.project.edits[1],command({length:settings.length,offset:settings.offset,velocity:0}),'The other fields are sent unchanged');
    await velocity.fill(String(settings.velocity));await velocity.press('Enter');await idle();
    const edited=await poll(record,value=>value.snapshot.project.edits.length===3,'velocity edit');
    assert.deepEqual(edited.snapshot.project.edits[2],command(settings),'All three settings');
    assert.ok(edited.snapshot.project.edits.every(edit=>edit.type==='setNoteTechniques'),'Settings ride on the existing note edit; no new command');
    result.edits.push(...edited.snapshot.project.edits);
    // An out-of-range value is refused with a message and sends nothing.
    await length.fill('9');await length.blur();await page.getByRole('alert').filter({hasText:/whole number from 10 to 400/}).waitFor();
    assert.equal((await edits()).length,3,'A refused value is not an edit');assert.equal(await length.inputValue(),String(settings.length),'The last good value returns');
    await native();
    await page.screenshot({path:resolve(paths.results,'01-inspector.png')});result.screenshots.push('01-inspector.png');
    step('Length, offset and velocity are set from the inspector, each one undoable edit',{edits:edited.snapshot.project.edits});

    // The native plan accepted it (the native side validates every plan), and a MIDI export carries the settings exactly.
    const status=await native();assert.equal(status.error,null);
    const midi=readNotes(readFileSync(await exportAs({format:'midi',name:'edited',extension:'mid'})));
    assert.equal(midi.on.length,3,'No note is added or lost');
    assert.equal(midi.on[0][0],baseMidi.on[0][0]+settings.offset,'The first note starts at the offset');
    assert.equal(midi.off[0][0]-midi.on[0][0],Math.round(baseLength*settings.length/100),'Its length is scaled');
    assert.equal(midi.on[0][2],baseMidi.on[0][2]+settings.velocity,'Its velocity is raised');
    assert.deepEqual(midi.on.slice(1),baseMidi.on.slice(1),'The other notes are untouched');
    assert.ok(midi.on[0][0]<midi.on[1][0],'The notes keep their order');
    step('A MIDI export carries the start, length and velocity',{midi});

    // An audio export starts the note later by the offset.
    const wave=readWave(readFileSync(await exportAs({format:'wav',name:'edited',extension:'wav',audio:true})));
    const shift=wave.onset-baseWave.onset,expected=Math.round(settings.offset/960*0.5*wave.rate);
    assert.ok(Math.abs(shift-expected)<wave.rate*0.01,`The audio starts ${shift} frames later; expected about ${expected}`);
    assert.ok(wave.peak>0,'The note is still audible');
    step('An audio export starts the note later by the offset',{shift,expected});

    // The written score is the same: a GP export has the same notes and rhythm, and no trace of the settings.
    const editedGp=await exportAs({format:'gp',name:'edited',extension:'gp'});
    const notesOf=path=>{const score=load(readFileSync(path)),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;return beats.map(beat=>[beat.duration,beat.dots,beat.notes.map(note=>[note.string,note.fret])]);};
    assert.deepEqual(notesOf(editedGp),notesOf(baseGp),'Written position is unchanged');
    const gpif=path=>strFromU8(unzipSync(readFileSync(path))['Content/score.gpif']);assert.equal(gpif(editedGp),gpif(baseGp),'Guitar Pro has no field for these, so the written score is the baseline byte for byte');
    assert.deepEqual((await record()).snapshot.project,edited.snapshot.project,'Export never edits');
    step('The written notes and rhythm are unchanged',{notes:notesOf(editedGp)});

    // Undo and redo take the settings off and put them back, one edit at a time.
    await button('Undo');assert.equal((await edits()).length,2);
    assert.equal(await velocity.inputValue(),'0','Undo shows the earlier value');
    await button('Undo');await button('Undo');assert.deepEqual((await record()).snapshot.project,initial.snapshot.project,'Undo restores the project');
    assert.deepEqual([await length.inputValue(),await offset.inputValue(),await velocity.inputValue()],['100','0','0']);
    await button('Redo');await button('Redo');await button('Redo');assert.deepEqual((await record()).snapshot.project,edited.snapshot.project,'Redo restores the edits');
    assert.deepEqual([await length.inputValue(),await offset.inputValue(),await velocity.inputValue()],[String(settings.length),String(settings.offset),String(settings.velocity)]);
    await native();step('Undo and redo restore the settings',{});

    // Reset takes the settings off in one edit that carries null.
    await page.getByRole('button',{name:'Reset note audio',exact:true}).click();await idle();
    const reset=await poll(record,value=>value.snapshot.project.edits.length===4,'reset edit');
    assert.deepEqual(reset.snapshot.project.edits[3],command(null),'Reset clears the settings');
    assert.deepEqual([await length.inputValue(),await offset.inputValue(),await velocity.inputValue()],['100','0','0']);
    const cleared=readNotes(readFileSync(await exportAs({format:'midi',name:'cleared',extension:'mid'})));
    assert.deepEqual(cleared,baseMidi,'With the settings cleared the MIDI export is the baseline again');
    step('Reset clears the settings and the export returns to the baseline',{});

    // A finalized document keeps its notes: the fields are disabled.
    await button('Finalize document');
    for(const name of ['Sounding length','Start offset','Velocity change'])assert.equal(await field(name).isDisabled(),true,`${name} is locked`);
    assert.equal((await edits()).length,4,'Locking is not an edit');
    await button('Unfinalize document');assert.equal(await field('Sounding length').isDisabled(),false);
    step('A finalized document disables the fields',{});
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for per-note audio settings. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runNoteAudioAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),edits:outcome.edits},null,2));}
}
