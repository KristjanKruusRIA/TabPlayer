// Cabinet impulse response desktop acceptance: a user imports their own cabinet WAV, picks it for a sound, trims it, and
// hears it in the exported audio; a refused file imports nothing; removing it from the library leaves the document alone and
// plays the built-in cabinet; and a saved document opened on a machine whose library lacks the response still opens, says so,
// plays the built-in cabinet, and plays the response again once the same file is imported. Every WAV is synthesized by this
// driver in its run directory; none is read from anywhere else. The file picker is replaced by TABPLAYER_TEST_CABINET_IR,
// a list of paths joined by `|`, taken one for each import. Build with tests/desktop/string-count-build.mjs, then:
//   node tests/desktop/parity-cabinet-ir.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
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

/** A PCM WAV file of interleaved `samples` in -1..1. */
function wav(samples,{rate=48000,bits=24,channels=1}={}){
  const width=bits/8,data=Buffer.alloc(samples.length*width);
  samples.forEach((value,index)=>{const x=Math.max(-1,Math.min(1,value));if(bits===16)data.writeInt16LE(Math.round(x*32767),index*2);else data.writeIntLE(Math.round(x*8388607),index*3,3);});
  const head=Buffer.alloc(44);head.write('RIFF',0);head.writeUInt32LE(36+data.length,4);head.write('WAVEfmt ',8);head.writeUInt32LE(16,16);head.writeUInt16LE(1,20);head.writeUInt16LE(channels,22);head.writeUInt32LE(rate,24);head.writeUInt32LE(rate*channels*width,28);head.writeUInt16LE(channels*width,32);head.writeUInt16LE(bits,34);head.write('data',36);head.writeUInt32LE(data.length,40);
  return Buffer.concat([head,data]);
}
/** A reproducible sequence in -1..1. */
function noise(length,seed){let state=seed>>>0||1;return Array.from({length},()=>{state^=state<<13;state>>>=0;state^=state>>>17;state^=state<<5;state>>>=0;return state/0xffffffff*2-1;});}
/** The first response: the signal, then half of it again 10 ms later, so its effect on a sound is an echo whose size is known. A
 * last tap far below the others ends the response, so the fade that closes it falls on nothing that matters. */
const echoResponse=()=>{const taps=new Array(1201).fill(0);taps[0]=.9;taps[480]=.45;taps[1200]=.0005;return wav(taps);};
/** The second: stereo, 44.1 kHz and 16-bit, a decaying burst of low-passed noise. */
const burstResponse=()=>{let low=0;const frames=Array.from({length:8820},(_,n)=>{low+=.4*(noise(1,n+7)[0]-low);return low*Math.exp(-n/1500)*.4+(n===0?.5:0);});return wav(frames.flatMap(v=>[v,v*.8]),{rate:44100,bits:16,channels:2});};
/** Both channels of a 16- or 24-bit stereo PCM WAV as numbers in -1..1, with the sample rate. */
function channels(bytes){
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');const rate=bytes.readUInt32LE(24),bits=bytes.readUInt16LE(34),width=bits/8,frames=bytes.readUInt32LE(40)/(2*width),out=[new Float64Array(frames),new Float64Array(frames)];
  for(let i=0;i<frames;i++)for(let c=0;c<2;c++){const at=44+(i*2+c)*width;out[c][i]=bits===16?bytes.readInt16LE(at)/32768:bytes.readIntLE(at,3)/8388608;}
  return {samples:out,rate};
}
const rms=({samples:[left],rate},from,to)=>{let sum=0;const a=Math.round(rate*from),b=Math.round(rate*to);for(let i=a;i<b;i++)sum+=left[i]**2;return Math.sqrt(sum/(b-a));};
/** The least-squares fit of `out` as `a` times `dry` plus `b` times `dry` `shift` frames earlier, and what is left over. */
function fit(out,dry,shift,from,to){
  let aa=0,ab=0,bb=0,ya=0,yb=0,yy=0;
  for(let n=from;n<to;n++){const a=dry[n],b=dry[n-shift],y=out[n];aa+=a*a;ab+=a*b;bb+=b*b;ya+=y*a;yb+=y*b;yy+=y*y;}
  const determinant=aa*bb-ab*ab,a=(ya*bb-yb*ab)/determinant,b=(yb*aa-ya*ab)/determinant;
  const residual=yy-2*(a*ya+b*yb)+a*a*aa+2*a*b*ab+b*b*bb;
  return {a,b,error:Math.sqrt(Math.max(residual,0)/yy)};
}

export async function runCabinetIrAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'cabinet-ir-')),names=['session','profile','app-data','input','export','results','session-2','profile-2','app-data-2'],paths=Object.fromEntries(names.map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const files={fixture:resolve(paths.input,'cabinet-ir.gp'),echo:resolve(paths.input,'echo-cabinet.wav'),burst:resolve(paths.input,'burst-cabinet.wav'),silent:resolve(paths.input,'silent-cabinet.wav'),notWav:resolve(paths.input,'not-a-cabinet.wav'),long:resolve(paths.input,'long-cabinet.wav'),saved:resolve(paths.input,'cabinet-ir-saved')};
  const result={format:'TabPlayerCabinetIrReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,assertions:[],screenshots:[],pageErrors:[],fallbacks:[],startedAtUtc:new Date().toISOString()};
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
  const sounds=async()=>(await record()).snapshot.project.edits.filter(edit=>edit.type==='setTrackSound');
  const cabinet=async()=>(await sounds()).at(-1).sound.effects.cabinet;

  /** Starts the app with its own session, profile and library folders, and connects to it. */
  const launch=async(suffix,environment)=>{
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const identityPath=resolve(paths.results,`launch-identity${suffix}.json`);
    const env={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths[`session${suffix}`],TABPLAYER_TEST_APP_DATA_DIR:paths[`app-data${suffix}`],TABPLAYER_TEST_EXPORT_DIR:paths.export,WEBVIEW2_USER_DATA_FOLDER:paths[`profile${suffix}`],WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath,...environment};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env}).trim());
    assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths[`profile${suffix}`],before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths[`profile${suffix}`],listeners());
    page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    await page.locator('.app-shell').waitFor();const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await idle();
  };
  const quit=async()=>{
    if(browser)await browser.close();browser=null;
    if(identity&&inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);
    identity=null;
  };
  /** Exports the score as `name`.wav through the export dialog, and returns the file's bytes. */
  const exportWav=async name=>{
    await ui.clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('wav');
    await dialog.getByLabel('File name',{exact:true}).fill(name);await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const path=resolve(paths.export,`${name}.wav`),until=Date.now()+120000;
    while(Date.now()<until&&!existsSync(path)){const failed=dialog.getByRole('alert');if(await failed.count())throw new Error(await failed.innerText());await sleep(200);}
    assert.ok(existsSync(path),`${name}.wav was written`);await dialog.waitFor({state:'detached',timeout:30000}).catch(()=>{});await idle();await sleep(300);
    return readFileSync(path);
  };
  const panel=()=>page.getByRole('region',{name:'Track sound'});
  const openSound=async()=>{
    await ui.revealLeftTask(page,'Sound');
    const details=panel().locator('details.sound-block').filter({has:page.locator('.sound-block-name',{hasText:/^Cabinet$/})});
    if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
  };
  const picker=()=>panel().getByRole('combobox',{name:'Cabinet impulse response',exact:true});
  const notice=()=>panel().locator('.sound-ir-notice');
  const refusal=()=>panel().locator('.sound-ir-problem');
  const library=()=>resolve(paths['app-data'],'cabinet-irs');
  const importFile=async()=>{owned();await panel().getByRole('button',{name:'Import cabinet impulse response',exact:true}).click();await idle();};
  const play=async()=>{await button('Play');await poll(()=>invoke('audio_status'),s=>s.playing&&s.renderedFrames>4096&&s.outputPeak>.001&&!s.error,'playing with sound');await button('Stop');};

  try{
    ui=await import('./workstation-commands.mjs');
    // A sustained E2 and E3 together, then a bar of rest.
    const {exporter,model,Settings}=await import('@coderline/alphatab');
    {const score=new model.Score(),track=new model.Track(),staff=new model.Staff();track.name='Guitar';track.playbackInfo.program=25;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);score.addTrack(track);
      for(let index=0;index<2;index++){score.addMasterBar(new model.MasterBar());const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Whole;if(index===0)for(const [string,fret] of [[1,0],[3,2]]){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);}
      score.finish(new Settings());writeFileSync(files.fixture,new exporter.Gp7Exporter().export(score,new Settings()),{flag:'wx'});}
    writeFileSync(files.echo,echoResponse(),{flag:'wx'});writeFileSync(files.burst,burstResponse(),{flag:'wx'});
    writeFileSync(files.silent,wav(new Array(4800).fill(0),{bits:16}),{flag:'wx'});
    writeFileSync(files.notWav,Buffer.from('RIFX this is text that only has a .wav name','latin1'),{flag:'wx'});
    writeFileSync(files.long,wav(noise(144000,5).map(v=>v*.01),{bits:16}),{flag:'wx'});
    result.input={echo:hashFile(files.echo),burst:hashFile(files.burst)};
    const imports=[files.echo,files.silent,files.notWav,files.long,files.burst].join('|');

    // ---- The first machine: import, refuse, pick, trim, hear it in the export, remove, and fall back.
    await launch('',{TABPLAYER_TEST_OPEN:files.fixture,TABPLAYER_TEST_SAVE:files.saved,TABPLAYER_TEST_CABINET_IR:imports});
    await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
    assert.deepEqual((await record()).snapshot.project.edits,[]);
    const dry=channels(await exportWav('dry'));
    await openSound();
    const enable=panel().getByLabel('Enable cabinet',{exact:true});await enable.click();await idle();assert.equal(await enable.isChecked(),true);
    await panel().getByRole('combobox',{name:'Cabinet model',exact:true}).selectOption('closed');await idle();
    assert.equal(await picker().inputValue(),'','No response is chosen by default');
    assert.equal(await notice().count(),0,'No notice while the built-in cabinet is chosen');
    const builtIn=await exportWav('built-in');
    assert.deepEqual(await cabinet(),{enabled:true,model:'closed'},'A cabinet without a response stores no response field');
    step('The cabinet starts on its built-in model and stores no response',{});

    // The first import copies the file into the library, picks it, and records its identity and nothing of its audio.
    await importFile();await poll(async()=>(await cabinet()).ir,ir=>!!ir,'the response is chosen');
    const chosen=(await cabinet()).ir;
    assert.match(chosen.id,/^[0-9a-f]{32}$/);assert.equal(chosen.name,'echo-cabinet');assert.equal(chosen.levelDb,0);assert.deepEqual(Object.keys(chosen).sort(),['id','levelDb','name']);
    assert.equal(await picker().inputValue(),chosen.id);
    assert.deepEqual(readdirSync(library()).sort(),[`${chosen.id}.json`,`${chosen.id}.wav`]);
    assert.equal(hashFile(resolve(library(),`${chosen.id}.wav`)),result.input.echo,'The library holds a copy of the file');
    assert.equal(await notice().count(),0,'No notice while the library has the response');
    step('Import copies the WAV into the library and the sound names it by identity',{id:chosen.id});

    // Files that are not acceptable import nothing, change nothing, and say why.
    const editsBefore=(await record()).snapshot.project.edits.length;
    for(const [label,message] of [['silent',/silent/],['not a WAV',/not a WAV/],['too long',/3\.0 seconds long/]]){
      await importFile();await refusal().waitFor();assert.match(await refusal().innerText(),message,label);
      assert.equal((await record()).snapshot.project.edits.length,editsBefore,`${label} records no edit`);
      assert.deepEqual(readdirSync(library()).sort(),[`${chosen.id}.json`,`${chosen.id}.wav`],`${label} stores nothing`);
      assert.equal(await picker().inputValue(),chosen.id);
    }
    step('A silent, non-WAV or overlong file is refused with a reason, stores nothing and changes nothing',{});

    // The response is in the exported audio: the sound plus half of itself ten milliseconds later, scaled once.
    const withEcho=channels(await exportWav('echo'));assert.equal(withEcho.rate,dry.rate);
    const shift=Math.round(dry.rate*.01),from=Math.round(dry.rate*.3),to=Math.round(dry.rate*1.4);
    const echo=fit(withEcho.samples[0],dry.samples[0],shift,from,to);
    assert.ok(Math.abs(echo.b/echo.a-.5)<.03&&echo.error<.03,`The export is the sound and half of it ${shift} frames later: ${JSON.stringify(echo)}`);
    assert.ok(rms(dry,.3,1.4)>.001,'The dry export is not silent');
    assert.ok(!builtIn.equals(readFileSync(resolve(paths.export,'echo.wav'))),'The response replaces the built-in cabinet');
    const half=fit(channels(builtIn).samples[0],dry.samples[0],shift,from,to);
    assert.ok(half.error>.1||Math.abs(half.b/half.a-.5)>.2,'The built-in cabinet does not give that echo');
    step('The exported audio is the sound through the response',{fit:echo,shift});

    // The level trim scales the response by exactly its gain.
    const level=panel().getByLabel('Cabinet impulse response level (dB)',{exact:true});
    await level.fill('6');await level.press('Enter');await idle();
    assert.equal((await cabinet()).ir.levelDb,6);
    const louder=channels(await exportWav('echo-plus-6'));
    assert.ok(Math.abs(rms(louder,.3,1.4)/rms(withEcho,.3,1.4)-10**(6/20))<.02,'+6 dB doubles the level');
    await level.fill('0');await level.press('Enter');await idle();assert.equal((await cabinet()).ir.levelDb,0);
    step('The level trim scales the response',{});

    // A second response from a stereo 44.1 kHz file is picked from the list in place of the first, and back.
    await importFile();await poll(async()=>(await cabinet()).ir,ir=>ir.name==='burst-cabinet','the second response is chosen');
    const second=(await cabinet()).ir;assert.notEqual(second.id,chosen.id);
    assert.equal((await picker().locator('option').allTextContents()).length,3,'Built-in, and two responses');
    const burst=await exportWav('burst');assert.ok(!burst.equals(readFileSync(resolve(paths.export,'echo.wav'))));
    await picker().selectOption(chosen.id);await idle();assert.equal((await cabinet()).ir.id,chosen.id);
    assert.ok(readFileSync(resolve(paths.export,'echo.wav')).equals(await exportWav('echo-again')),'Choosing the first again plays the first');
    step('Two responses can be chosen between',{second:second.id});

    // Removing it from the library edits nothing: the document keeps its reference, the notice says the built-in cabinet plays,
    // and the audio is the built-in cabinet's exactly. It is not silent.
    const editsAtRemoval=(await record()).snapshot.project.edits.length;
    await panel().getByRole('button',{name:'Remove cabinet impulse response from library',exact:true}).click();await idle();
    await notice().waitFor();
    assert.equal(await notice().innerText(),"The impulse response “echo-cabinet” is not in this computer's cabinet library, so the built-in closed cabinet plays instead. Import the file to use it; the document is unchanged.");
    assert.equal((await record()).snapshot.project.edits.length,editsAtRemoval,'Removing from the library records no edit');
    assert.equal((await cabinet()).ir.id,chosen.id,'The document still names the response');
    assert.ok(!existsSync(resolve(library(),`${chosen.id}.wav`)),'The file left the library');
    const fallback=await exportWav('fallback');
    assert.ok(fallback.equals(builtIn),'Without the response the export is the built-in cabinet, byte for byte');
    assert.ok(rms(channels(fallback),.3,1.4)>.001,'The fallback is not silent');
    await play();
    step('A removed response leaves the document unchanged, shows a notice, and plays the built-in cabinet',{});

    // Save the document, which names the response, on a machine that is about to lose it.
    await button('Save');
    const savedPath=`${files.saved}.tabplayer`;assert.ok(existsSync(savedPath));
    const saved=readFileSync(savedPath),project=JSON.parse(saved);
    assert.deepEqual(project.assets,{},'The document holds no audio');
    assert.ok(saved.length<200000&&!saved.includes('RIFF')&&!saved.toString('latin1').includes('UklGR'),'No audio is embedded');
    assert.deepEqual(project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.cabinet.ir,{id:chosen.id,name:'echo-cabinet',levelDb:0});
    result.saved={path:savedPath,sha256:hashFile(savedPath)};step('The saved document names the response and holds no audio',{});
    healthy();await quit();

    // ---- A second machine: the same document, an empty library.
    assertStringCountPortFree(portRows());
    await launch('-2',{TABPLAYER_TEST_OPEN:savedPath,TABPLAYER_TEST_CABINET_IR:files.echo});
    await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
    const shared=await record();
    assert.deepEqual(shared.snapshot.project.edits.filter(edit=>edit.type==='setTrackSound').at(-1).sound.effects.cabinet.ir,{id:chosen.id,name:'echo-cabinet',levelDb:0},'The document opens with its response named');
    await openSound();
    assert.equal(existsSync(resolve(paths['app-data-2'],'cabinet-irs')),false,'This machine has no library');
    await notice().waitFor();
    assert.match(await notice().innerText(),/“echo-cabinet” is not in this computer's cabinet library, so the built-in closed cabinet plays instead/);
    assert.equal(await picker().inputValue(),chosen.id);
    assert.deepEqual((await record()).snapshot.project,shared.snapshot.project,'Opening and viewing changes nothing');
    assert.ok((await exportWav('shared')).equals(builtIn),'It plays the built-in cabinet, exactly as without the response');
    await play();
    step('A document opened without the response opens, says so, and plays the built-in cabinet',{});

    // Importing the same file there is the same response, found by identity: the notice goes, and no edit is added.
    await importFile();await poll(async()=>await notice().count(),count=>count===0,'the notice clears');
    assert.deepEqual(readdirSync(resolve(paths['app-data-2'],'cabinet-irs')).sort(),[`${chosen.id}.json`,`${chosen.id}.wav`]);
    assert.deepEqual((await record()).snapshot.project,shared.snapshot.project,'Importing the file the document names adds no edit');
    assert.ok((await exportWav('restored')).equals(readFileSync(resolve(paths.export,'echo.wav'))),'The document plays the response again, as on the first machine');
    await play();
    step('Importing the same file restores the response by identity',{});
    healthy();
  }catch(error){failure=error;result.error={message:String(error),stack:error.stack};if(page)try{await page.screenshot({path:resolve(paths.results,'failure.png')});}catch{}}
  finally{
    try{await quit();}catch(error){failure??=error;}
    try{assertStringCountBuild(packet);}catch(error){failure??=error;}
    result.status=failure?'failed':'passed';result.finishedAtUtc=new Date().toISOString();writeFileSync(resolve(paths.results,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  }
  if(failure)throw failure;return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for user cabinet impulse responses. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runCabinetIrAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name)},null,2));}
}
