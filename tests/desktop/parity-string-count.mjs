import assert from 'node:assert/strict';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,relative,resolve,win32} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sourceManifest,sha256} from './score-layout-fixture.mjs';
import {assertOwnedScoreLayoutProcess,assertScoreLayoutListener} from './parity-score-layouts.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const inside=(parent,path)=>{const part=relative(parent,path);return part&&!part.startsWith('..')&&!isAbsolute(part);};
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
const hashFile=path=>sha256(readFileSync(path));

export function validateStringCountArguments(args){
  if(!args.length||args.length===1&&args[0]==='--help')return {mode:'help'};
  assert.equal(args.length,2,'Use --run --build=<absolute JSON>');assert.equal(args[0],'--run');assert.ok(args[1].startsWith('--build='));
  const buildPath=args[1].slice(8);assert.ok(isAbsolute(buildPath)||win32.isAbsolute(buildPath),'Build packet path must be absolute');return {mode:'run',buildPath};
}
export function assertStringCountBuild(packet,{worktree=repository,manifest=sourceManifest,now=Date.now()}={}){
  assert.equal(packet.format,'TabPlayerStringCountBuild');assert.equal(packet.version,1);
  assert.ok(isAbsolute(packet.worktree)&&samePath(realpathSync(packet.worktree),realpathSync(worktree)),'Wrong worktree');
  assert.match(packet.sourceRevision??'',/^[a-f0-9]{40}$/i,'Base source revision required');
  assert.deepEqual(packet.sourceHashes,manifest(worktree),'Exact current source manifest differs');
  const start=Date.parse(packet.buildStartedAtUtc),end=Date.parse(packet.builtAtUtc);
  assert.ok(Number.isFinite(start)&&Number.isFinite(end)&&start<=end&&end<=now,'Ordered nonfuture build timestamps required');
  const newest=Math.max(...Object.keys(packet.sourceHashes).map(path=>statSync(resolve(worktree,path)).mtimeMs));
  assert.ok(start>=newest,'Build must begin after all frozen source writes');
  const runtime=dirname(packet.executable),owned=dirname(runtime),parent=resolve(worktree,'.analysis/desktop-smoke');
  assert.ok(samePath(dirname(owned),parent)&&/^string-count-[a-zA-Z0-9-]+$/.test(basename(owned))&&basename(runtime)==='runtime','Unique string-count directory/runtime required');
  for(const [path,hash] of [[packet.executable,packet.executableSha256],[packet.configPath,packet.configSha256],[packet.buildLogPath,packet.buildLogSha256]]){
    assert.ok(typeof path==='string'&&isAbsolute(path)&&inside(realpathSync(worktree),realpathSync(path))&&samePath(resolve(path),realpathSync(path)),'Canonical bound file inside worktree required');
    assert.ok(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink(),'Regular bound file required');assert.match(hash??'',/^[a-f0-9]{64}$/i);
    assert.equal(hashFile(path).toLowerCase(),hash.toLowerCase(),`Bound bytes changed: ${path}`);
  }
  assert.ok(/\.exe$/i.test(packet.executable)&&readFileSync(packet.executable).subarray(0,2).equals(Buffer.from('MZ')),'Bound Windows EXE required');
  const modified=statSync(packet.executable).mtimeMs;assert.ok(modified>=start&&modified<=end,'EXE mtime must lie inside build');return owned;
}
export function assertStringCountPortFree(rows){assert.ok(Array.isArray(rows));assert.equal(rows.length,0,'Diagnostic port 9223 is occupied; refusing before fixture writes/launch');}
export function stringCountEnvironment(environment){return Object.fromEntries(Object.entries(environment).filter(([name])=>!name.toUpperCase().startsWith('TABPLAYER_TEST_')));}
export const assertStringCountIdentity=assertOwnedScoreLayoutProcess;

// Third tuple fields are authored sounding MIDI pitches, independent of the editor.
const tracks=[
  {name:'Guitar6',program:25,tuning:[64,59,55,50,45,40],bars:[
    [[[1,0,40],[6,0,64]],[[2,2,47]],[[3,0,50],[4,2,57]],[[5,1,60]]],
    [[[6,12,76]],[[1,7,47],[3,4,54]],[[4,0,55]],[[2,3,48],[5,0,59]]]]},
  {name:'Bass6',program:33,tuning:[48,43,38,33,28,23],bars:[
    [[[1,0,23],[6,0,48]],[[2,0,28]],[[3,2,35]],[[4,0,38]]],
    [[[5,3,46]],[[6,5,53]],[[1,12,35],[4,2,40]],[[6,12,60]]]]},
];
export async function buildStringCountFixture(){
  const {model,exporter,Settings}=await import('@coderline/alphatab'),settings=new Settings(),score=new model.Score();score.title='Owned string-count acceptance';score.artist='TabPlayer public fixture';
  for(let i=0;i<2;i++){const bar=new model.MasterBar();bar.timeSignatureNumerator=4;bar.timeSignatureDenominator=4;score.addMasterBar(bar);}
  score.masterBars[0].tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];let noteId=0;
  for(const [index,definition] of tracks.entries()){
    const track=new model.Track();track.name=definition.name;track.shortName=definition.name;Object.assign(track.playbackInfo,{program:definition.program,primaryChannel:index*2,secondaryChannel:index*2+1});
    const staff=new model.Staff();staff.stringTuning.tunings=[...definition.tuning];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
    for(const [barIndex,beats] of definition.bars.entries()){
      const bar=new model.Bar();bar.id=index*2+barIndex;bar.clef=index===1?model.Clef.F4:model.Clef.G2;staff.addBar(bar);const voice=new model.Voice();voice.id=bar.id;bar.addVoice(voice);
      for(const [beatIndex,values] of beats.entries()){
        const beat=new model.Beat();beat.id=index*8+barIndex*4+beatIndex;beat.duration=model.Duration.Quarter;beat.isEmpty=false;voice.addBeat(beat);
        for(const [string,fret] of values){const note=new model.Note();note.id=noteId++;note.string=string;note.fret=fret;beat.addNote(note);}
      }
    }
  }
  score.finish(settings);const oracle={tracks:structuredClone(tracks)};assertStringCountMusic(score,oracle,'source');
  return {bytes:Buffer.from(new exporter.Gp7Exporter().export(score,settings)),oracle};
}
export function assertStringCountMusic(score,oracle,state){
  assert.ok(['source','seven','five'].includes(state));assert.equal(score.tracks.length,2);assert.equal(score.masterBars.length,2);assert.equal(score.tempo,120);
  const sorted=notes=>notes.map(row=>[...row]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
  for(const [index,definition] of oracle.tracks.entries()){
    const track=score.tracks[index];assert.equal(track.name,definition.name);assert.equal(track.playbackInfo.program,definition.program);assert.equal(track.staves.length,1);
    const staff=track.staves[0],tuning=index===0&&state!=='source'?[...definition.tuning,35]:index===1&&state==='five'?definition.tuning.slice(1):definition.tuning;
    assert.deepEqual([...staff.tuning],tuning);assert.equal(staff.bars.length,2);
    for(const [barIndex,beats] of definition.bars.entries()){
      assert.equal(staff.bars[barIndex].voices.length,1);const actual=staff.bars[barIndex].voices[0].beats;assert.equal(actual.length,4);
      for(const [beatIndex,values] of beats.entries()){
        const expected=values.map(([string,fret,pitch])=>index===0&&state!=='source'?[string+1,fret,pitch]:index===1&&state==='five'&&string===6?[5,fret+5,pitch]:[string,fret,pitch]);
        assert.equal(actual[beatIndex].duration,4);assert.equal(actual[beatIndex].dots,0);
        assert.deepEqual(sorted(actual[beatIndex].notes.map(note=>[note.string,note.fret,note.realValue])),sorted(expected),`${definition.name} bar ${barIndex+1} beat ${beatIndex+1}: exact placement/pitch`);
      }
    }
  }
}

// Observe forwarded IPC without replacing invoke or its transport fallback behavior.
async function installStringCountObserver(){
  const api=window.__TAURI_INTERNALS__,original=window.fetch;
  if(typeof api?.invoke!=='function'||typeof api?.convertFileSrc!=='function'||typeof original!=='function')throw Error('Native transport unavailable');
  const commands=['apply_edit','undo_edit','redo_edit','audio_command','audio_set_mix','audio_status'],urls=new Map(commands.map(command=>[api.convertFileSrc(command,'ipc'),command]));
  const state=window.__stringCountAcceptance={calls:[],failures:[]};
  const wrapper=async function(...args){
    const [input,init]=args,command=urls.get(typeof input==='string'?input:input?.url);if(!command||command==='audio_status'&&state.probe)return original.apply(this,args);
    const row={command,settled:false,ok:false};if(command==='audio_status')state.probe=row;else state.calls.push(row);
    try{row.args=JSON.parse(init.body);}catch{state.failures.push('Invalid native request');}
    let response;try{response=await original.apply(this,args);}catch(error){row.settled=true;state.failures.push('Native transport rejected');throw error;}
    try{row.result=await response.clone().json();row.ok=response.headers.get('Tauri-Response')==='ok';}catch{state.failures.push('Invalid native response');}
    row.settled=true;return response;
  };
  window.fetch=wrapper;if(window.fetch!==wrapper)throw Error('Cannot observe native transport');state.dispose=()=>{if(window.fetch!==wrapper)return false;window.fetch=original;return window.fetch===original;};
  const status=await api.invoke('audio_status');if(typeof status?.ready!=='boolean'||status.playing!==false||!state.probe?.settled||!state.probe.ok||JSON.stringify(state.probe.result)!==JSON.stringify(status))throw Error('Observed native paused status unavailable');return {installed:true,probe:state.probe};
}
const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';

export async function runStringCountAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,observers=false,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows()); // No input/run writes or launch before this gate.
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'run-')),paths=Object.fromEntries(['session','profile','input','export','results'].map(name=>[name,resolve(runDirectory,name)]));for(const path of Object.values(paths))mkdirSync(path);
  const result={format:'TabPlayerStringCountReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,paths,assertions:[],exports:[],pageErrors:[],fallbacks:[],cleanup:[],startedAtUtc:new Date().toISOString()};
  const resultPath=resolve(paths.results,'result.json'),identityPath=resolve(paths.results,'launch-identity.json'),inputPath=resolve(paths.input,'string-count.gp'),oraclePath=resolve(paths.input,'oracle.json'),exportBase=resolve(paths.export,'string-count');
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');assert.equal(hashFile(packet.executable),packet.executableSha256.toLowerCase(),'Executable bytes changed');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  try{
    const fixture=await buildStringCountFixture();writeFileSync(inputPath,fixture.bytes,{flag:'wx'});writeFileSync(oraclePath,JSON.stringify(fixture.oracle,null,2),{flag:'wx'});result.inputs={inputPath,inputSha256:hashFile(inputPath),oraclePath,oracleSha256:hashFile(oraclePath)};
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT:exportBase,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
    const launch='$ErrorActionPreference="Stop";$captured=$null;try{$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$captured=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()};$text=$captured|ConvertTo-Json -Compress;$stream=[IO.File]::Open(($env:STRING_COUNT_IDENTITY+".pending"),[IO.FileMode]::CreateNew);try{$bytes=[Text.Encoding]::UTF8.GetBytes($text);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()};[IO.File]::Move(($env:STRING_COUNT_IDENTITY+".pending"),$env:STRING_COUNT_IDENTITY);$text}catch{$failure=$_;if($null -ne $captured){$live=Get-Process -Id $captured.pid -ErrorAction SilentlyContinue;if($null -ne $live -and [string]::Equals($live.Path,$captured.path,[StringComparison]::OrdinalIgnoreCase) -and $live.StartTime.ToUniversalTime().Ticks.ToString() -ceq $captured.startTicks){Stop-Process -Id $live.Id;$null=$live.WaitForExit(5000)}};throw $failure}';
    try{identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',launch],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());}catch(error){if(existsSync(identityPath))identity=json(identityPath);throw error;}
    result.identity=identity;assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);result.listenerBefore=before;
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();const after=listeners();assertScoreLayoutListener(identity,paths.profile,after);assert.deepEqual(after.map(row=>row.owner).sort(),before.map(row=>row.owner).sort());result.listenerAfter=after;
    assert.equal(browser.contexts().length,1);assert.equal(browser.contexts()[0].pages().length,1);page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    const ui=await import('./workstation-commands.mjs');
    const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot','audio_status'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
    const workspace=()=>invoke('workspace_snapshot'),record=async()=>invoke('project_snapshot',{documentId:(await workspace()).active.documentId});
    const native=()=>poll(()=>invoke('audio_status'),value=>{assert.equal(value.playing,false);assert.equal(value.error,null);return value.ready&&value.generation===value.desiredGeneration;},'paused current native preparation');
    const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
    const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
    await page.locator('.app-shell').waitFor();observers=true;step('Install passive native observer',await page.evaluate(installStringCountObserver));
    const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();owned();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});await idle();
    const previous=(await workspace()).active;await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
    const initial=await record(),owner=(await workspace()).active;assert.equal(initial.snapshot.project.base.sha256,result.inputs.inputSha256);assert.deepEqual(initial.snapshot.project.edits,[]);assert.equal(initial.revision,0);assert.equal(initial.snapshot.canUndo,false);assert.equal(initial.snapshot.canRedo,false);assert.equal(initial.snapshot.dirty,false);
    const {importer,Settings}=await import('@coderline/alphatab');const load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
    const exportMusic=async(state,label)=>{
      const beforeRecord=await record(),path=`${exportBase}.gp`;assert.equal(existsSync(path),false,'Export must produce a fresh file');await button('Export GP');const bytes=readFileSync(path);assertStringCountMusic(load(bytes),fixture.oracle,state);assert.deepEqual(await record(),beforeRecord,'Export must not change project/history/revision');
      const saved=resolve(paths.export,`${String(result.exports.length+1).padStart(2,'0')}-${label}.gp`);assert.equal(existsSync(saved),false);renameSync(path,saved);result.exports.push({label,state,path:saved,sha256:sha256(bytes)});await native();
    };
    const commandG={type:'setStringCount',track:0,tuning:[64,59,55,50,45,40,35],keep:'high'},commandB={type:'setStringCount',track:1,tuning:[43,38,33,28,23],keep:'low'};
    const expectedRecord=(revision,edits,redoEdit=null)=>({...initial,revision,snapshot:{...initial.snapshot,project:{...initial.snapshot.project,edits},canUndo:edits.length>0,canRedo:redoEdit!==null,redoEdit,dirty:edits.length>0}});
    const checkRecord=async(revision,edits,redoEdit=null)=>{const actual=await record();assert.deepEqual(actual,expectedRecord(revision,edits,redoEdit),'Exact native project/history/revision');assert.deepEqual((await workspace()).active,owner,'Document/audio owner');step('Exact project/history/revision',{record:actual,native:await native()});};
    const change=async(text,keep)=>{owned();await ui.revealLeftTask(page,'Track');const tuning=page.getByLabel('Tuning (notes, high to low)',{exact:true});await tuning.fill(text);await page.getByRole('combobox',{name:/^Strings kept in place/}).selectOption(keep);owned();await page.getByRole('button',{name:'Change string count',exact:true}).click();await idle();};
    await exportMusic('source','source');await button('Track 1: Guitar6');await change('E4 B3 G3 D3 A2 E2 B1','high');await checkRecord(1,[commandG]);await exportMusic('seven','guitar-seven');
    await button('Undo');await checkRecord(2,[],commandG);await exportMusic('source','guitar-undo');await button('Redo');await checkRecord(3,[commandG]);await exportMusic('seven','guitar-redo');
    await button('Track 2: Bass6');const beforeRefusal=await record(),nativeBefore=await native();await change('C3 G2 D2 A1 E1','high');
    assert.match((await page.getByRole('alert').allTextContents()).join(' '),/no playable string/);assert.deepEqual(await record(),beforeRefusal,'Refusal must be atomic');assert.deepEqual(await native(),nativeBefore,'Refusal preserves native preparation');await exportMusic('seven','bass-refused');step('Low B0 removal refused atomically',{record:beforeRefusal});
    await change('G2 D2 A1 E1 B0','low');await checkRecord(4,[commandG,commandB]);await exportMusic('five','bass-five');
    await button('Undo');await checkRecord(5,[commandG],commandB);await exportMusic('seven','bass-undo');await button('Redo');await checkRecord(6,[commandG,commandB]);await exportMusic('five','bass-redo');
    const evidence=await page.evaluate(()=>({calls:window.__stringCountAcceptance.calls,failures:window.__stringCountAcceptance.failures}));assert.deepEqual(evidence.failures,[]);// Audio commands are observed too. Every call settles. At most one fails: the audio owner from before Open, refused
    // before the first edit once the opened document's owner has taken over. Every current-owner audio command
    // succeeds, and each edit is followed by at least one.
    for(const row of evidence.calls)assert.equal(row.settled,true);
    const refused=evidence.calls.flatMap((row,index)=>row.ok?[]:[index]),firstEdit=evidence.calls.findIndex(row=>row.command==='apply_edit');assert.ok(refused.length<=1,'At most one refused native command');
    for(const index of refused){const row=evidence.calls[index];assert.ok(index<firstEdit);assert.equal(row.command,'audio_command');assert.equal(row.result,'Audio owner is no longer active.');assert.deepEqual(row.args.owner,previous);assert.notDeepEqual(previous,owner);}
    const current=row=>row.command==='audio_command'&&row.args.owner.documentId===owner.documentId&&row.args.owner.activationId===owner.activationId;
    for(const row of evidence.calls.filter(current))assert.equal(row.ok,true);
    evidence.calls.forEach((row,index)=>{if(row.command!=='audio_command'){const after=evidence.calls.slice(index+1),until=after.findIndex(next=>next.command!=='audio_command');assert.ok((until<0?after:after.slice(0,until)).some(current),'Audio re-prepares after '+row.command);}});
    const edits=evidence.calls.filter(row=>row.command!=='audio_command');assert.deepEqual(edits.map(row=>row.command),['apply_edit','undo_edit','redo_edit','apply_edit','undo_edit','redo_edit']);
    for(const row of edits){assert.equal(row.settled,true);assert.equal(row.ok,true);assert.equal(row.result.documentId,initial.documentId);assert.ok(row.result.revision>row.args.document.revision);}
    assert.deepEqual(edits.filter(row=>row.command==='apply_edit').map(row=>row.args.command),[commandG,commandB]);result.nativeCommands=evidence;step('All exact exports, paused readiness and acknowledged native edits passed',{exportCount:result.exports.length});healthy();
  }catch(error){failure=error;result.error={message:String(error),stack:error.stack};}
  finally{
    const cleanup=async(name,action)=>{try{await action();result.cleanup.push({name,ok:true});}catch(error){failure??=error;result.cleanup.push({name,ok:false,error:String(error)});}};
    if(page&&observers)await cleanup('Preserve evidence and restore passive observer',async()=>{
      const evidence=await page.evaluate(()=>{const state=window.__stringCountAcceptance;return {calls:state?.calls,probe:state?.probe,failures:state?.failures,restored:state?.dispose()};});result.observerEvidence=evidence;assert.equal(evidence.restored,true);assert.deepEqual(evidence.failures,[]);
    });
    if(browser)await cleanup('Dispose browser connection',()=>browser.close());
    if(identity)await cleanup('Terminate only exact captured PID',()=>{if(inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);assert.equal(inspect(),null);});
    await cleanup('Frozen source/build/input integrity',()=>{assertStringCountBuild(packet);assert.equal(hashFile(buildPath),result.buildSha256);if(result.inputs){assert.equal(hashFile(inputPath),result.inputs.inputSha256);assert.equal(hashFile(oraclePath),result.inputs.oracleSha256);}healthy();});
    result.status=failure?'failed':'passed';result.finishedAtUtc=new Date().toISOString();result.resultPath=resultPath;writeFileSync(resultPath,JSON.stringify(result,null,2),{flag:'wx'});
  }
  if(failure){failure.stringCountReceipt=result;throw failure;}return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Inert desktop acceptance. Root only: --run --build=<absolute TabPlayerStringCountBuild JSON>. Import/default/help do not write fixtures, launch, connect or clean up.');
  else console.log(JSON.stringify(await runStringCountAcceptance(options),null,2));
}
