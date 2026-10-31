import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connect,directory,launch} from './harness.mjs';
import {readDocumentRecord} from './document-context.mjs';
import {clickWorkstationButton,revealInspector,waitForWorkspaceIdle} from './workstation-commands.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const answerHelper='tests/desktop/answer-unsaved-dialog.ps1',answerHash='436b5b19827837bc79756398ab159dc1892fb915215652f787e6121e5c5e4ef0';
const acceptedExecutableHash='8a8cb8b4d5572ccd47d935b08006b024aa0db2102aa7fd8323c319b3487780fe';
const ownedCheck='$p=Get-Process -Id $env:RESUME_OWNED_PID -ErrorAction SilentlyContinue; if($null -ne $p){if(-not [string]::Equals($p.Path,$env:RESUME_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:RESUME_OWNED_START){throw "Captured resume process identity changed"}};';

// One controlled JS host-call exception; shutdown/resume/audio stay real.
// Explicit execution is required; import and the default call are inert.
export async function runResumePlaybackAcceptance({execute=false}={}){
  assert.equal(execute,true,'Explicit execute:true (or CLI --run) is required');assert.equal(process.platform,'win32');
  const executable=realpathSync(resolve(directory,'tabplayer.exe'));assert.equal(digest(readFileSync(answerHelper)),answerHash);assert.equal(digest(readFileSync(executable)),acceptedExecutableHash,'Use the root-supplied resumed-playback build');
  const nativeDirectory=mkdtempSync(resolve(directory,'resume-session-')),profilesBefore=new Set(readdirSync(directory).filter(name=>/^profile-[0-9]+$/.test(name)));
  const result={executable,executableSha256:digest(readFileSync(executable)),nativeDirectory,history:[],fault:'One rejected JS plugin:window|destroy call; not an actual OS destruction failure.',limits:['No native IPC is faked: actual session_shutdown, session_resume, audio_prepare and transport are forwarded.','No autoplay, score edit, reload or second player is used to trigger resumed preparation.','No physical audio, screenshot, true OS destruction failure or cross-platform claim.']};
  const step=(name,value)=>{result.history.push({name,atUnixMs:Date.now(),value});return value;};
  let identity=null,browser=null,page=null;const errors=[];
  const ps=command=>execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,RESUME_OWNED_PID:identity?String(identity.pid):'',RESUME_OWNED_EXE:executable,RESUME_OWNED_START:identity?.startTicks??''}}).trim();
  function inspect(){assert.ok(identity);return JSON.parse(ps(`${ownedCheck} if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));}
  function owned(){assert.ok(inspect(),'Owned resume process must still be live');}
  const workspace=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'));
  const idle=()=>waitForWorkspaceIdle(page,{timeout:25000});
  async function button(name){await clickWorkstationButton(page,name,{waitForIdle:false});await idle();}
  async function snapshot(){const value=await workspace();assert.equal(value.documents.length,1);assert.deepEqual(await readDocumentRecord(page,value.active.documentId),value.documents[0]);return value;}
  async function status(owner){assert.deepEqual((await workspace()).active,owner);const value=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));assert.deepEqual((await workspace()).active,owner);return value;}
  async function nativeStatus(owner,predicate){const deadline=Date.now()+35000;let value;do{value=await status(owner);if(value&&predicate(value))return value;await wait(25);}while(Date.now()<deadline);throw new Error(`Native resume status timeout: ${JSON.stringify(value)}`);}
  function checkpoint(){
    const manifestPath=resolve(nativeDirectory,'recovery-v1/manifest.json'),manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes);assert.equal(manifest.format,'TabPlayerRecoveryManifest');assert.equal(manifest.version,1);assert.ok(Number.isSafeInteger(manifest.epoch)&&manifest.epoch>0);assert.ok(Number.isSafeInteger(manifest.current.generation)&&manifest.current.generation>0);assert.match(manifest.current.sha256,/^[a-f0-9]{64}$/);const path=resolve(nativeDirectory,`recovery-v1/checkpoint-${manifest.current.generation}.json`),bytes=readFileSync(path);assert.equal(digest(bytes),manifest.current.sha256);const envelope=JSON.parse(bytes);assert.equal(envelope.format,'TabPlayerRecovery');assert.equal(envelope.version,1);assert.equal(envelope.epoch,manifest.epoch);assert.equal(envelope.generation,manifest.current.generation);assert.equal(digest(readFileSync(manifestPath)),digest(manifestBytes));return {manifest,path,manifestSha256:digest(manifestBytes),payloadSha256:digest(bytes),envelope};
  }
  const history=[{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:5},{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:1},string:6,fret:7}];
  const expectedView={target:{...history[0].target},selectedString:6,selectedNoteIndex:null,zoom:115,trackView:{kind:'selected'},instrumentVisible:false};
  async function running(live,afterGeneration=0){
    const deadline=Date.now()+45000;let reason;
    do{try{const value=checkpoint();assert.equal(value.manifest.lifecycle,'running');assert.ok(value.manifest.current.generation>afterGeneration);assert.equal(value.envelope.activeDocumentId,live.active.documentId);assert.equal(value.envelope.documents.length,1);const document=value.envelope.documents[0];assert.equal(document.documentId,live.active.documentId);assert.equal(document.revision,live.documents[0].revision);assert.deepEqual(document.session.project.edits,history);assert.equal(document.session.cursor,1);assert.deepEqual(document.session.saved,[]);assert.equal(document.session.path,null);assert.deepEqual(document.view,expectedView,'Acknowledged recovery retains the complete nondefault editor view');return value;}catch(error){reason=String(error);}await wait(50);}while(Date.now()<deadline);throw new Error(`Running full-history checkpoint not observed: ${reason}`);
  }
  const observations=()=>page.evaluate(()=>({calls:window.__resumePlaybackProbe.calls,destroyCalls:window.__resumePlaybackProbe.destroyCalls,retainedShell:window.__resumePlaybackProbe.shell===document.querySelector('.app-shell'),fretDraft:document.querySelector('.inspector input[type="number"][max="127"]')?.value}));
  try{
    await new Promise((accept,reject)=>{const server=createServer();server.once('error',reject);server.listen(9223,'127.0.0.1',()=>server.close(error=>error?reject(error):accept()));});
    const pid=launch({TABPLAYER_TEST_SESSION_DIR:nativeDirectory});identity=JSON.parse(ps(`$p=Get-Process -Id ${pid} -ErrorAction Stop; if(-not [string]::Equals($p.Path,$env:RESUME_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected resume executable'}; @{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`));assert.equal(identity.pid,pid);assert.match(identity.startTicks,/^[1-9][0-9]+$/);owned();step('Owned diagnostic launch',identity);
    browser=await connect();owned();page=browser.contexts()[0].pages()[0];assert.ok(page);page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1280,height:900});await idle();
    const profiles=readdirSync(directory).filter(name=>/^profile-[0-9]+$/.test(name)&&!profilesBefore.has(name));assert.equal(profiles.length,1,'One fresh profile from the unchanged harness');result.profileDirectory=resolve(directory,profiles[0]);
    await revealInspector(page);await button('Edit');await page.getByRole('combobox',{name:'String',exact:true}).selectOption('6');
    for(const [beat,fret]of [[1,5],[2,7]]){await page.getByLabel('Beat',{exact:true}).fill(String(beat));await page.getByLabel('Fret',{exact:true}).fill(String(fret));await button('Set note');}await button('Undo');await page.getByLabel('Beat',{exact:true}).fill('1');await page.getByLabel('Zoom (%)',{exact:true}).fill(String(expectedView.zoom));assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'115');await page.getByLabel('Fret',{exact:true}).fill('19');
    const before=await snapshot(),owner={...before.active},record=before.documents[0];assert.deepEqual(record.snapshot.project.edits,history.slice(0,1));assert.deepEqual(record.snapshot.redoEdit,history[1]);assert.equal(record.snapshot.dirty,true);assert.equal(record.snapshot.canRedo,true);const beforeNative=await nativeStatus(owner,value=>value.ready&&!value.error&&!value.playing&&value.tick===0),beforeCheckpoint=await running(before);step('Before close',{workspace:before,native:beforeNative,checkpoint:beforeCheckpoint,baseSha256:digest(JSON.stringify(record.snapshot.project.base))});
    // core.invoke dynamically reads window.__TAURI_INTERNALS__.invoke. Runtime
    // invoke itself is immutable, so preserve it and shadow only that property
    // on an outer replacement object; every other member inherits unchanged.
    await page.evaluate(()=>{
      const descriptor=Object.getOwnPropertyDescriptor(window,'__TAURI_INTERNALS__'),original=window.__TAURI_INTERNALS__,invoke=original.invoke;
      if(!descriptor||!('value'in descriptor)||!descriptor.writable&&!descriptor.configurable)throw Error('Public Tauri internals container cannot be temporarily replaced');
      const probe={descriptor,original,shell:document.querySelector('.app-shell'),destroyCalls:0,calls:[]};window.__resumePlaybackProbe=probe;
      const replacement=Object.create(original);Object.defineProperty(replacement,'invoke',{value:function(...args){
        const command=args[0],entry={command,acknowledged:false};if(['session_shutdown','session_resume','audio_prepare','audio_command'].includes(command))entry.payload=structuredClone(args[1]);probe.calls.push(entry);
        if(command==='plugin:window|destroy'&&++probe.destroyCalls===1){entry.injected=true;entry.error='Injected window destruction failure';return Promise.reject(Error(entry.error));}
        const pending=Reflect.apply(invoke,original,args);Promise.resolve(pending).then(()=>{entry.acknowledged=true;},error=>{entry.error=String(error);});return pending;
      }});Object.defineProperty(window,'__TAURI_INTERNALS__',{...descriptor,value:replacement});if(window.__TAURI_INTERNALS__!==replacement)throw Error('Window destroy fault was not installed');
    });
    owned();step('WM_CLOSE',ps(`${ownedCheck} if($null -eq $p){throw 'Owned process exited before WM_CLOSE'}; if(-not $p.CloseMainWindow()){throw 'Owned main window rejected WM_CLOSE'}; 'Owned WM_CLOSE requested'`));owned();step('Actual Unsaved Discard',execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',answerHelper,'-AppProcessId',String(identity.pid),'-AppExecutable',executable,'-AppStartTicks',identity.startTicks,'-Decision','Discard'],{encoding:'utf8',windowsHide:true,timeout:20000}).trim());
    await page.waitForFunction(()=>window.__resumePlaybackProbe.calls.some(call=>call.command==='session_resume'&&call.acknowledged));await idle();owned();assert.deepEqual(await snapshot(),before);assert.equal(await page.getByLabel('Fret',{exact:true}).inputValue(),'19');
    const resumed=await nativeStatus(owner,value=>value.ready&&!value.error&&!value.playing&&value.tick===0&&value.generation>Math.max(beforeNative.generation,beforeNative.desiredGeneration??0));assert.equal(resumed.range,null);assert.equal(resumed.loop,null);const post=await running(before,beforeCheckpoint.manifest.current.generation);assert.ok(post.manifest.epoch>beforeCheckpoint.manifest.epoch);assert.deepEqual(post.envelope.documents[0].session.project,beforeCheckpoint.envelope.documents[0].session.project);assert.deepEqual(post.envelope.documents[0].view,beforeCheckpoint.envelope.documents[0].view);assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'115');
    const observed=await observations();assert.equal(observed.retainedShell,true);assert.equal(observed.destroyCalls,1);assert.equal(observed.calls.filter(call=>call.command==='session_shutdown'&&call.acknowledged).length,1);assert.equal(observed.calls.filter(call=>call.command==='session_resume'&&call.acknowledged).length,1);assert.equal(observed.calls.filter(call=>call.command==='plugin:window|destroy'&&call.injected).length,1);assert.equal(observed.calls.filter(call=>call.command==='plugin:window|destroy'&&call.acknowledged).length,0);assert.equal(observed.calls.filter(call=>call.command==='audio_command'&&['play','playRange','pause'].includes(call.payload.command.type)).length,0,'Resume never autoplays');const prepared=observed.calls.filter(call=>call.command==='audio_prepare'&&call.acknowledged).at(-1);assert.ok(prepared);assert.deepEqual(prepared.payload.owner,owner);assert.equal(prepared.payload.plan.generation,resumed.generation);assert.deepEqual(prepared.payload.plan.notes.map(note=>[note.key,note.startTick,note.endTick]),[[69,0,960]]);step('Real shutdown/resume, stopped fresh generation and Running backup',{native:resumed,checkpoint:post,observed});
    await button('Play');const playing=await nativeStatus(owner,value=>value.playing&&value.tick>0&&value.generation===resumed.generation);await button('Pause');const paused=await nativeStatus(owner,value=>!value.playing&&value.generation===resumed.generation);assert.ok(paused.tick>=playing.tick);assert.deepEqual(await snapshot(),before);assert.equal(await page.getByLabel('Fret',{exact:true}).inputValue(),'19');assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'115');const afterPlaybackCheckpoint=await running(before,beforeCheckpoint.manifest.current.generation);assert.deepEqual(afterPlaybackCheckpoint.envelope.documents[0].view,beforeCheckpoint.envelope.documents[0].view);assert.deepEqual(afterPlaybackCheckpoint.envelope.documents[0].view,post.envelope.documents[0].view);assert.equal((await observations()).retainedShell,true);assert.deepEqual(errors,[]);step('Actual UI Play/Pause without editing',{playing,paused,workspace:await snapshot(),checkpoint:afterPlaybackCheckpoint,observed:await observations()});result.pageErrors=errors;return result;
  }catch(error){step('Failure',{error:String(error),pageErrors:errors});error.resumePlaybackResult=result;throw error;}
  finally{
    let restorationError=null;
    if(identity&&inspect()){
      owned();if(page&&!page.isClosed())try{const restored=await page.evaluate(()=>{const probe=window.__resumePlaybackProbe;if(!probe)return null;Object.defineProperty(window,'__TAURI_INTERNALS__',probe.descriptor);if(window.__TAURI_INTERNALS__!==probe.original)throw Error('Original public invoke container was not restored');return true;});if(restored)step('Original public invoke container restored',true);}catch(error){step('Fault restoration failure',String(error));restorationError=error;}
      owned();step('Owned diagnostic cleanup',ps(`${ownedCheck} if($null -eq $p){throw 'Owned process exited before cleanup'}; Stop-Process -Id $p.Id; $null=$p.WaitForExit(5000); 'Captured resume instance terminated'`));
    }
    if(browser)try{await browser.close();}catch{}
    if(restorationError){restorationError.resumePlaybackResult=result;throw restorationError;}
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.deepEqual(process.argv.slice(2),['--run'],'Explicit --run is required');console.log(JSON.stringify(await runResumePlaybackAcceptance({execute:true}),null,2));}
