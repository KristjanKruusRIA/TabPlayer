import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connect,directory,launch} from './harness.mjs';
import {readDocumentRecord} from './document-context.mjs';
import {clickWorkstationButton,closeWelcomeLibrary,revealInspector,waitForWorkspaceIdle} from './workstation-commands.mjs';
import {assertStringCountBuild,validateStringCountArguments} from './parity-string-count.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const answerHelper='tests/desktop/answer-unsaved-dialog.ps1',answerHash='436b5b19827837bc79756398ab159dc1892fb915215652f787e6121e5c5e4ef0';
const closeHelper='tests/desktop/post-window-close.ps1',closeHash='a58b0818b179b73ed9227bd6e659206f0b1044af903db45182eaf0c22d0de446';
const ownedCheck='$p=Get-Process -Id $env:RESUME_OWNED_PID -ErrorAction SilentlyContinue; if($null -ne $p){if(-not [string]::Equals($p.Path,$env:RESUME_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:RESUME_OWNED_START){throw "Captured resume process identity changed"}};';

// One controlled IPC fault: the first plugin:window|destroy request is answered with a Tauri error response by a CDP Fetch
// interception of http://ipc.localhost (Tauri 2.12 made window.__TAURI_INTERNALS__ immutable, so the JS-side wrapper this
// driver used to install is impossible). Shutdown/resume/audio stay real: every other request is continued untouched.
// The close is a WM_CLOSE posted to the real Tauri window's HWND, not Process.CloseMainWindow(), which can address the
// single-instance plugin's hidden helper window instead.
// Explicit execution is required; import and the default call are inert.
// The executable is bound by the current-source build packet from string-count-build.mjs instead of one pinned old binary hash.
export async function runResumePlaybackAcceptance({execute=false,buildPath}={}){
  assert.equal(execute,true,'Explicit execute:true (or CLI --run --build=<packet>) is required');assert.equal(process.platform,'win32');
  assert.equal(typeof buildPath,'string','An absolute --build=<TabPlayerStringCountBuild JSON> is required');const packet=JSON.parse(readFileSync(buildPath,'utf8'));assertStringCountBuild(packet);
  const executable=realpathSync(resolve(directory,'tabplayer.exe'));assert.equal(digest(readFileSync(answerHelper)),answerHash);assert.equal(digest(readFileSync(closeHelper)),closeHash);assert.equal(digest(readFileSync(executable)),packet.executableSha256,'Copy the packet executable to .analysis/desktop-smoke/tabplayer.exe first');
  const nativeDirectory=mkdtempSync(resolve(directory,'resume-session-')),profilesBefore=new Set(readdirSync(directory).filter(name=>/^profile-[0-9]+$/.test(name)));
  const result={executable,executableSha256:digest(readFileSync(executable)),nativeDirectory,history:[],fault:'One plugin:window|destroy IPC request answered with a Tauri error response by a CDP Fetch interception of ipc.localhost; the request never reaches native code, so this is not an actual OS destruction failure.',limits:['No native IPC is faked except the one injected destroy answer: actual session_shutdown, session_resume, audio_prepare and transport are forwarded.','No autoplay, score edit, reload or second player is used to trigger resumed preparation.','No physical audio, screenshot, true OS destruction failure or cross-platform claim.']};
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
  // Every ipc.localhost POST seen over CDP: {command, acknowledged, payload?, injected?, error?}. They are observed with
  // Network events, which never hold a request; only the one plugin:window|destroy request is paused (Fetch domain) and
  // answered. Pausing every IPC request would deadlock this driver: the Unsaved score dialog is itself an IPC request
  // (plugin:dialog|message), and a held request never shows its dialog.
  const calls=[],faultErrors=[],entries=new Map(),payloads=[];let destroyCalls=0,cdp=null;
  const tracked=['session_shutdown','session_resume','audio_prepare','audio_command'];
  const header=(headers,name)=>Object.entries(headers??{}).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
  const commandOf=url=>decodeURIComponent(new URL(url).pathname.slice(1));
  function register(networkId,request){
    let entry=entries.get(networkId);if(entry)return entry;
    entry={command:commandOf(request.url),acknowledged:false};entries.set(networkId,entry);calls.push(entry);
    if(tracked.includes(entry.command)){
      payloads.push((async()=>{
        const text=request.postData!==undefined?request.postData:request.hasPostData?(await cdp.send('Network.getRequestPostData',{requestId:networkId})).postData:undefined;
        if(text!==undefined)entry.payload=JSON.parse(text);
      })().catch(error=>faultErrors.push(`payload ${entry.command}: ${error}`)));
    }
    return entry;
  }
  async function installDestroyFault(){
    cdp=await browser.contexts()[0].newCDPSession(page);
    cdp.on('Network.requestWillBeSent',event=>{if(event.request.method==='POST'&&event.request.url.startsWith('http://ipc.localhost/'))register(event.requestId,event.request);});
    cdp.on('Network.responseReceived',event=>{
      const entry=entries.get(event.requestId);if(!entry||entry.injected)return;
      const outcome=header(event.response.headers,'Tauri-Response');
      if(outcome==='ok')entry.acknowledged=true;else entry.error=`Tauri-Response ${outcome??'missing'}, HTTP ${event.response.status}`;
    });
    cdp.on('Fetch.requestPaused',event=>{void (async()=>{
      try{
        if(event.request.method!=='POST'||commandOf(event.request.url)!=='plugin:window|destroy'){await cdp.send('Fetch.continueRequest',{requestId:event.requestId});return;}
        const entry=register(event.networkId??event.requestId,event.request);
        if(++destroyCalls!==1){await cdp.send('Fetch.continueRequest',{requestId:event.requestId});return;}
        entry.injected=true;entry.error='Injected window destruction failure';
        // The answer a failing native command gets: Tauri-Response: error with the error as JSON, readable cross-origin.
        await cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Tauri-Response',value:'error'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Expose-Headers',value:'Tauri-Response'}],body:Buffer.from(JSON.stringify(entry.error)).toString('base64')});
      }catch(error){
        faultErrors.push(String(error));
        try{await cdp.send('Fetch.continueRequest',{requestId:event.requestId});}catch{}
      }
    })();});
    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:'http://ipc.localhost/plugin%3Awindow%7Cdestroy',requestStage:'Request'}]});
    await page.evaluate(()=>{window.__resumePlaybackShell=document.querySelector('.app-shell');if(!window.__resumePlaybackShell)throw Error('No app shell to retain');});
  }
  const observations=async()=>{await Promise.all(payloads);return {calls:structuredClone(calls),destroyCalls,faultErrors:[...faultErrors],retainedShell:await page.evaluate(()=>window.__resumePlaybackShell===document.querySelector('.app-shell')),fretDraft:await page.evaluate(()=>document.querySelector('.inspector input[type="number"][max="127"]')?.value)};};
  async function until(predicate,what,timeout=20000){const deadline=Date.now()+timeout;while(!predicate()){if(Date.now()>deadline)throw new Error(`Timed out waiting for ${what}`);await wait(25);}}
  try{
    await new Promise((accept,reject)=>{const server=createServer();server.once('error',reject);server.listen(9223,'127.0.0.1',()=>server.close(error=>error?reject(error):accept()));});
    const pid=launch({TABPLAYER_TEST_SESSION_DIR:nativeDirectory});identity=JSON.parse(ps(`$p=Get-Process -Id ${pid} -ErrorAction Stop; if(-not [string]::Equals($p.Path,$env:RESUME_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected resume executable'}; @{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`));assert.equal(identity.pid,pid);assert.match(identity.startTicks,/^[1-9][0-9]+$/);owned();step('Owned diagnostic launch',identity);
    browser=await connect();owned();page=browser.contexts()[0].pages()[0];assert.ok(page);page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1280,height:900});await closeWelcomeLibrary(page);await idle();
    const profiles=readdirSync(directory).filter(name=>/^profile-[0-9]+$/.test(name)&&!profilesBefore.has(name));assert.equal(profiles.length,1,'One fresh profile from the unchanged harness');result.profileDirectory=resolve(directory,profiles[0]);
    await revealInspector(page);await button('Edit');await page.getByRole('combobox',{name:'String',exact:true}).selectOption('6');
    for(const [beat,fret]of [[1,5],[2,7]]){await page.getByLabel('Beat',{exact:true}).fill(String(beat));await page.getByLabel('Fret',{exact:true}).fill(String(fret));await button('Set note');}await button('Undo');await page.getByLabel('Beat',{exact:true}).fill('1');await page.getByLabel('Zoom (%)',{exact:true}).fill(String(expectedView.zoom));assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'115');await page.getByLabel('Fret',{exact:true}).fill('19');
    const before=await snapshot(),owner={...before.active},record=before.documents[0];assert.deepEqual(record.snapshot.project.edits,history.slice(0,1));assert.deepEqual(record.snapshot.redoEdit,history[1]);assert.equal(record.snapshot.dirty,true);assert.equal(record.snapshot.canRedo,true);const beforeNative=await nativeStatus(owner,value=>value.ready&&!value.error&&!value.playing&&value.tick===0),beforeCheckpoint=await running(before);step('Before close',{workspace:before,native:beforeNative,checkpoint:beforeCheckpoint,baseSha256:digest(JSON.stringify(record.snapshot.project.base))});
    await installDestroyFault();
    owned();step('WM_CLOSE',execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',closeHelper,'-AppProcessId',String(identity.pid),'-AppExecutable',executable,'-AppStartTicks',identity.startTicks],{encoding:'utf8',windowsHide:true,timeout:20000}).trim());owned();step('Actual Unsaved Discard',(await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',answerHelper,'-AppProcessId',String(identity.pid),'-AppExecutable',executable,'-AppStartTicks',identity.startTicks,'-Decision','Discard'],{encoding:'utf8',windowsHide:true,timeout:20000})).stdout.trim());
    await until(()=>calls.some(call=>call.command==='session_resume'&&call.acknowledged),'acknowledged session_resume');await idle();owned();assert.deepEqual(await snapshot(),before);assert.equal(await page.getByLabel('Fret',{exact:true}).inputValue(),'19');
    const resumed=await nativeStatus(owner,value=>value.ready&&!value.error&&!value.playing&&value.tick===0&&value.generation>Math.max(beforeNative.generation,beforeNative.desiredGeneration??0));assert.equal(resumed.range,null);assert.equal(resumed.loop,null);const post=await running(before,beforeCheckpoint.manifest.current.generation);assert.ok(post.manifest.epoch>beforeCheckpoint.manifest.epoch);assert.deepEqual(post.envelope.documents[0].session.project,beforeCheckpoint.envelope.documents[0].session.project);assert.deepEqual(post.envelope.documents[0].view,beforeCheckpoint.envelope.documents[0].view);assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'115');
    const observed=await observations();assert.deepEqual(observed.faultErrors,[],'The CDP interception handled every request');assert.equal(observed.retainedShell,true);assert.equal(observed.destroyCalls,1);assert.equal(observed.calls.filter(call=>call.command==='session_shutdown'&&call.acknowledged).length,1);assert.equal(observed.calls.filter(call=>call.command==='session_resume'&&call.acknowledged).length,1);assert.equal(observed.calls.filter(call=>call.command==='plugin:window|destroy'&&call.injected).length,1);assert.equal(observed.calls.filter(call=>call.command==='plugin:window|destroy'&&call.acknowledged).length,0);assert.equal(observed.calls.filter(call=>call.command==='audio_command'&&['play','playRange','pause'].includes(call.payload.command.type)).length,0,'Resume never autoplays');const prepared=observed.calls.filter(call=>call.command==='audio_prepare'&&call.acknowledged).at(-1);assert.ok(prepared);assert.deepEqual(prepared.payload.owner,owner);assert.equal(prepared.payload.plan.generation,resumed.generation);assert.deepEqual(prepared.payload.plan.notes.map(note=>[note.key,note.startTick,note.endTick]),[[69,0,960]]);step('Real shutdown/resume, stopped fresh generation and Running backup',{native:resumed,checkpoint:post,observed});
    await button('Play');const playing=await nativeStatus(owner,value=>value.playing&&value.tick>0&&value.generation===resumed.generation);await button('Pause');const paused=await nativeStatus(owner,value=>!value.playing&&value.generation===resumed.generation);assert.ok(paused.tick>=playing.tick);assert.deepEqual(await snapshot(),before);assert.equal(await page.getByLabel('Fret',{exact:true}).inputValue(),'19');assert.equal(await page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'115');const afterPlaybackCheckpoint=await running(before,beforeCheckpoint.manifest.current.generation);assert.deepEqual(afterPlaybackCheckpoint.envelope.documents[0].view,beforeCheckpoint.envelope.documents[0].view);assert.deepEqual(afterPlaybackCheckpoint.envelope.documents[0].view,post.envelope.documents[0].view);assert.equal((await observations()).retainedShell,true);assert.deepEqual(errors,[]);assert.deepEqual(faultErrors,[]);step('Actual UI Play/Pause without editing',{playing,paused,workspace:await snapshot(),checkpoint:afterPlaybackCheckpoint,observed:await observations()});result.pageErrors=errors;return result;
  }catch(error){step('Failure',{error:String(error),pageErrors:errors});error.resumePlaybackResult=result;throw error;}
  finally{
    let restorationError=null;
    if(identity&&inspect()){
      owned();if(cdp)try{await cdp.send('Fetch.disable');step('IPC interception disabled',true);}catch(error){step('Fault restoration failure',String(error));restorationError=error;}
      owned();step('Owned diagnostic cleanup',ps(`${ownedCheck} if($null -eq $p){throw 'Owned process exited before cleanup'}; Stop-Process -Id $p.Id; $null=$p.WaitForExit(5000); 'Captured resume instance terminated'`));
    }
    if(browser)try{await browser.close();}catch{}
    if(restorationError){restorationError.resumePlaybackResult=result;throw restorationError;}
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const options=validateStringCountArguments(process.argv.slice(2));assert.equal(options.mode,'run','Explicit --run --build=<absolute packet> is required');console.log(JSON.stringify(await runResumePlaybackAcceptance({execute:true,buildPath:options.buildPath}),null,2));}
