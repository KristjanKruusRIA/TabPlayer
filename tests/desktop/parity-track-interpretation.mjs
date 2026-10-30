// S22/S23 desktop acceptance: a track's interpretation (playing style, palm mute intensity, strong-beat accent, automatic
// let ring, automatic brush) is saved with the track mix as one undoable edit each, never rewrites the score, and changes
// the mixed audio a WAV export renders. Reuses the S14 build packet and owned-process checks. Build with
// tests/desktop/string-count-build.mjs, then: node tests/desktop/parity-track-interpretation.mjs --run --build=<absolute build.json>
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
const trackId='base/0';
const mix={gain:1,pan:0,mute:false,solo:false};

/** One steel guitar bar: a three-note chord, a palm-muted note, a note on the chord's string, and a rest. */
async function buildFixture(path){
  const {exporter,model,Settings}=await import('@coderline/alphatab');
  const settings=new Settings(),score=new model.Score();score.title='Interpretation';const first=new model.MasterBar();first.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,100,2)];score.addMasterBar(first);
  const track=new model.Track();track.name='Guitar';track.playbackInfo.program=25;track.playbackInfo.primaryChannel=0;track.playbackInfo.secondaryChannel=1;
  const staff=new model.Staff();staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
  const bar=new model.Bar();staff.addBar(bar);const voice=new model.Voice();bar.addVoice(voice);
  const beats=[0,1,2,3].map(()=>{const beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);return beat;});
  const add=(beat,string,fret)=>{const note=new model.Note();note.string=string;note.fret=fret;beats[beat].addNote(note);return note;};
  add(0,6,3);add(0,5,2);add(0,4,0);add(1,5,2).isPalmMute=true;add(2,5,3);
  score.finish(settings);writeFileSync(path,new exporter.Gp7Exporter().export(score,settings),{flag:'wx'});
}
/** The samples of a 16-bit stereo WAV. */
function wav(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.readUInt16LE(34),16);const count=bytes.readUInt32LE(40)/2,samples=new Int16Array(count);
  for(let i=0;i<count;i++)samples[i]=bytes.readInt16LE(44+i*2);
  return {sampleRate:bytes.readUInt32LE(24),samples};
}
const rms=(samples,from=0,to=samples.length)=>{let sum=0;for(let i=from;i<to;i++)sum+=samples[i]*samples[i];return Math.sqrt(sum/Math.max(1,to-from));};

export async function runTrackInterpretationAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'track-interpretation-')),paths=Object.fromEntries(['session','profile','app-data','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const inputPath=resolve(paths.input,'interpretation.gp'),identityPath=resolve(paths.results,'launch-identity.json');
  const result={format:'TabPlayerTrackInterpretationReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],edits:[],screenshots:[],exports:{},pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
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
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  const panel=()=>page.getByRole('region',{name:'Track interpretation',exact:true});
  const edits=async()=>(await record()).snapshot.project.edits;
  /** One change is exactly one native setTrackMix edit; Undo restores the record before it and Redo the one after. */
  const choose=async(label,control,expectedInterpretation,{checkbox=false}={})=>{
    const before=await record(),count=before.snapshot.project.edits.length;
    if(checkbox)await panel().getByRole('checkbox',{name:control,exact:true}).check();else await panel().getByRole('combobox',{name:control}).selectOption(label);
    await idle();
    const after=await poll(record,value=>value.snapshot.project.edits.length===count+1,`${control}: one edit`);
    const expected={type:'setTrackMix',trackId,mix:expectedInterpretation?{...mix,interpretation:expectedInterpretation}:mix};
    assert.deepEqual(after.snapshot.project.edits.at(-1),expected,`${control}: command`);
    await button('Undo');assert.deepEqual((await record()).snapshot.project,before.snapshot.project,`${control}: undo restores`);
    await button('Redo');assert.deepEqual((await record()).snapshot.project,after.snapshot.project,`${control}: redo restores`);
    result.edits.push({control,command:expected});return after;
  };
  /** Exports the mixed audio as 16-bit WAV through the dialog and returns its samples. */
  const exportWav=async name=>{
    await ui.clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('wav');
    await dialog.getByLabel('File type').selectOption('wav');await dialog.getByLabel('Sample rate').selectOption('44100');await dialog.getByLabel('Bit depth').selectOption('16');
    await dialog.getByLabel('File name',{exact:true}).fill(name);await dialog.getByText(`Saves as ${name}.wav`,{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const file=resolve(paths.export,`${name}.wav`),deadline=Date.now()+120000;
    while(Date.now()<deadline&&!existsSync(file)){const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());await sleep(200);}
    assert.ok(existsSync(file),`${name}.wav was written`);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await idle();await sleep(300);
    const decoded=wav(readFileSync(file));result.exports[name]={file,sha256:hashFile(file),frames:decoded.samples.length/2};return decoded;
  };
  try{
    ui=await import('./workstation-commands.mjs');
    await buildFixture(inputPath);result.input={inputPath,sha256:hashFile(inputPath)};
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_APP_DATA_DIR:paths['app-data'],TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT_DIR:paths.export,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
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

    await ui.revealLeftTask(page,'Sound');await panel().waitFor();
    assert.deepEqual(await panel().getByRole('combobox',{name:'Playing style'}).inputValue(),'','Style starts automatic');
    assert.equal(await panel().getByRole('checkbox',{name:'Automatic let ring',exact:true}).isChecked(),false);
    await page.screenshot({path:resolve(paths.results,'01-panel.png')});result.screenshots.push('01-panel.png');

    // The written playback, twice: the default is deterministic, so any later difference is the interpretation.
    const base=await exportWav('default-a'),again=await exportWav('default-b');
    assert.equal(result.exports['default-a'].sha256,result.exports['default-b'].sha256,'Default export is repeatable');
    assert.ok(rms(base.samples)>0,'The default export is not silent');
    assert.deepEqual(await edits(),[],'Exporting never edits');step('Default playback is repeatable',{sha256:result.exports['default-a'].sha256});

    // Each setting is one undoable edit; its export differs from the default and from every other setting.
    const variants=[
      ['style-fingers','Playing style','fingers',{style:'fingers'}],
      ['palm-mute-light','Palm mute intensity','light',{palmMute:'light'}],
      ['palm-mute-heavy','Palm mute intensity','heavy',{palmMute:'heavy'}],
      ['accent-light','Strong-beat accent','light',{accent:'light'}],
      ['accent-strong','Strong-beat accent','strong',{accent:'strong'}],
      ['brush-down','Automatic brush','down',{brush:'down'}],
      ['brush-up','Automatic brush','up',{brush:'up'}],
    ];
    const audio={};
    for(const [name,control,value,interpretation] of variants){
      await choose(value,control,interpretation);
      audio[name]=await exportWav(name);
      assert.notEqual(result.exports[name].sha256,result.exports['default-a'].sha256,`${name} sounds different from the default`);
      await panel().getByRole('combobox',{name:control}).selectOption('');await idle();
    }
    await choose(null,'Automatic let ring',{letRing:true},{checkbox:true});audio['let-ring']=await exportWav('let-ring');
    assert.notEqual(result.exports['let-ring'].sha256,result.exports['default-a'].sha256,'let ring sounds different from the default');
    const hashes=Object.values(result.exports).map(entry=>entry.sha256).filter((_,index)=>index!==1);
    assert.equal(new Set(hashes).size,hashes.length,'Every setting renders its own audio');
    // The direction of each change, not only that there is one.
    const half=Math.floor(base.samples.length/2);
    assert.ok(rms(audio['let-ring'].samples,0,half)>rms(base.samples,0,half),'Let ring sustains the first half');
    assert.ok(rms(audio['palm-mute-heavy'].samples)<rms(base.samples),'A heavy palm mute is softer');
    assert.ok(rms(audio['accent-strong'].samples)>rms(base.samples),'A strong accent is louder');
    step('Each interpretation setting renders distinct audio',{exports:result.exports});

    // Settings combine: a style and a palm mute intensity together differ from either alone. (The written marks that
    // outrank a style are covered note by note by the plan unit tests.)
    await panel().getByRole('checkbox',{name:'Automatic let ring',exact:true}).uncheck();await idle();
    await panel().getByRole('combobox',{name:'Playing style'}).selectOption('fingers');await idle();
    await panel().getByRole('combobox',{name:'Palm mute intensity'}).selectOption('light');await idle();
    const combined=await exportWav('style-and-light-mute');
    assert.notEqual(result.exports['style-and-light-mute'].sha256,result.exports['palm-mute-light'].sha256,'Style and mute intensity combine');
    assert.notEqual(result.exports['style-and-light-mute'].sha256,result.exports['style-fingers'].sha256,'Mute intensity still applies under a style');
    assert.ok(combined.samples.length>0);

    // Clearing every setting returns the written playback byte for byte.
    for(const control of ['Playing style','Palm mute intensity'])await panel().getByRole('combobox',{name:control}).selectOption('');
    await idle();const cleared=await exportWav('cleared');
    assert.equal(result.exports.cleared.sha256,result.exports['default-a'].sha256,'Clearing returns the default audio');
    assert.equal(cleared.samples.length,base.samples.length);
    const final=await record();assert.ok(final.snapshot.project.edits.every(edit=>edit.type==='setTrackMix'),'Only mix edits: the score is never rewritten');
    assert.equal(final.snapshot.project.edits.at(-1).mix.interpretation,undefined,'The cleared mix carries no interpretation key');
    step('Clearing restores the written playback and no score edit was made',{edits:final.snapshot.project.edits.length});

    await page.screenshot({path:resolve(paths.results,'02-cleared.png')});result.screenshots.push('02-cleared.png');
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
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for track interpretation. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runTrackInterpretationAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),edits:outcome.edits,exports:outcome.exports},null,2));}
}
