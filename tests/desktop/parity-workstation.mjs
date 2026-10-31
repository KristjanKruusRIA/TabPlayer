import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connect,directory,launch,stop} from './harness.mjs';
import {readDocumentRecord} from './document-context.mjs';
import {clickWorkspaceCommand,clickWorkstationButton,revealWorkspaceCommand,revealDock,revealInspector,revealLeftTask,revealPlaybackControls,selectWorkspaceTrack,waitForWorkspaceIdle} from './workstation-commands.mjs';
import {buildWorkstationFixture,writeWorkstationFixture,assertWorkstationFixtureHashes} from './workstation-fixture.mjs';
import {sha256} from './document-tabs-fixture.mjs';

// Root runs against its accepted joined binary; importing this module does not
// allocate fixtures, launch an app, connect CDP or run an acceptance workflow.
export async function runWorkstationAcceptance({captures=false,long=false,backing=false}={}){
  for(const value of [captures,long,backing])assert.equal(typeof value,'boolean');
  const fixture=writeWorkstationFixture(await buildWorkstationFixture({long,backing})),output=name=>resolve(directory,`${fixture.prefix}-${name}`),savePath=output('saved.tabplayer');
  const executable=realpathSync(resolve(directory,'tabplayer.exe')),result={fixture:fixture.metadataPath,executable,executableHash:sha256(readFileSync(executable)),options:{captures,long,backing},checks:{},screenshots:[],limits:[...fixture.limits,'Windows diagnostic build, one owned process/CDP 9223; no PCM capture or hardware audio fidelity claim.','Production picker cancellation is separate from diagnostic File action routing.','Recovery prompt/status/error screenshots and durable session acceptance are root-owned.']};
  let id=null,browser=null,page=null,owner=null;const helpers=new Set(),errors=[];
  const invoke=(command,args={})=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
  const workspace=()=>invoke('workspace_snapshot');
  const record=()=>readDocumentRecord(page,owner.documentId);
  const address=record=>({documentId:record.documentId,revision:record.revision});
  const idle=()=>waitForWorkspaceIdle(page,{timeout:20000});
  const published=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  async function sameOwner(){assert.deepEqual((await workspace()).active,owner,'Native inspection must retain its captured AudioOwner');}
  async function status(){await sameOwner();const value=await invoke('audio_status');await sameOwner();return value;}
  async function waitStatus(predicate,timeout=20000){const deadline=Date.now()+timeout;let value;do{value=await status();if(value&&predicate(value))return value;await page.waitForTimeout(25);}while(Date.now()<deadline);throw new Error(`Native status timeout: ${JSON.stringify(value)}`);}
  async function button(name){const count=(await observations()).commands.length;await clickWorkstationButton(page,name,{waitForIdle:false});await idle();await published();for(const command of (await observations()).commands.slice(count))assert.deepEqual(command.owner,owner,'UI audio mutation uses the captured owner');}
  async function disclosure(name){const summary=page.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first();if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();return summary;}
  const observations=()=>page.evaluate(()=>({prepareCount:window.__workstationObservation.prepares.length,prepareOwner:window.__workstationObservation.prepares.at(-1)?.owner??null,plan:window.__workstationObservation.prepares.at(-1)?.plan??null,commands:window.__workstationObservation.commands,mixes:window.__workstationObservation.mixes,edits:window.__workstationObservation.edits}));
  function completion(promise){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Production picker did not resolve after cancellation.')),5000);})]).finally(()=>clearTimeout(timer));}
  async function checkAddressedEdit(before,type){const after=await record();assert.ok(after.revision>before.revision);assert.equal(after.snapshot.project.edits.at(-1).type,type);const observed=(await observations()).edits.at(-1);assert.deepEqual(observed.document,address(before));assert.equal(observed.command.type,type);return after;}
  function cancelPicker(){
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','tests/desktop/cancel-dialog.ps1','-AppProcessId',String(id)],{windowsHide:true,timeout:15000,killSignal:'SIGKILL'});helpers.add(child);let text='';child.stdout.on('data',chunk=>{text+=chunk;});child.stderr.on('data',chunk=>{text+=chunk;});
    const done=new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',code=>{helpers.delete(child);code===0?accept(text.trim()):reject(new Error(`Owned native picker helper exited ${code}: ${text}`));});});void done.catch(()=>{});return done;
  }
  async function productionPickerCancellation(label){
    await revealWorkspaceCommand(page,label);const before=await record(),beforeWorkspace=await workspace();
    const cancelled=cancelPicker(),pending=invoke(label==='Open'?'read_document':'save_project',label==='Open'?{}:{document:address(before),saveAs:true});void pending.catch(()=>{});
    const receipt=await cancelled;assert.equal(await completion(pending),null);await page.keyboard.press('Escape');await idle();assert.deepEqual(await record(),before);assert.deepEqual(await workspace(),beforeWorkspace);
    return {route:'production native picker (diagnostic File commands use fixed paths)',document:address(before),receipt};
  }
  async function invariant(action){
    const before=await record(),native=await status(),observed=await observations();assert.equal(native.playing,true);
    assert.deepEqual(observed.prepareOwner,owner);const planHash=sha256(JSON.stringify(observed.plan));await action();await published();const after=await status(),next=await observations();
    assert.deepEqual(await record(),before);assert.equal(after.generation,native.generation);assert.equal(after.desiredGeneration,native.desiredGeneration);assert.equal(after.playing,true);assert.equal(after.practice.phase,native.practice.phase);assert.deepEqual(after.range,native.range);assert.deepEqual(after.loop,native.loop);assert.ok(after.tick>=native.tick);assert.ok(after.seconds>=native.seconds);
    assert.equal(next.prepareCount,observed.prepareCount);assert.equal(sha256(JSON.stringify(next.plan)),planHash);assert.equal(next.commands.length,observed.commands.length,'View-only actions issue no native transport command');
    return {document:address(before),owner,before:native,after,planHash};
  }
  async function viewCheckbox(name,checked){const summary=await disclosure('View');await page.getByRole('checkbox',{name,exact:true}).setChecked(checked);await summary.press('Escape');await published();return summary;}
  async function pasteRevealCheck(hidden){
    await revealInspector(page);await button('Edit');await page.getByRole('combobox',{name:/^Duration/}).selectOption('8');
    if(hidden)await viewCheckbox('Inspector',false);else await revealLeftTask(page,'Sound');
    const before=await record(),native=await status();await page.getByRole('region',{name:'Score workspace',exact:true}).focus();await page.keyboard.press('Control+Shift+V');await page.locator('.inspector').waitFor({state:'visible'});
    const clipboard=page.locator('.inspector summary').filter({hasText:/^Musical clipboard$/});await clipboard.waitFor();assert.equal(await clipboard.evaluate(node=>node===document.activeElement),true);assert.equal(await page.getByRole('combobox',{name:/^Duration/}).inputValue(),'8');assert.deepEqual(await record(),before);
    const after=await status();assert.equal(after.generation,native.generation);assert.equal(after.playing,native.playing);assert.deepEqual(after.range,native.range);assert.deepEqual(after.loop,native.loop);return {hidden,document:address(before),focused:'Clipboard',durationDraft:'8'};
  }
  async function screenshot(name,width,height,setup){
    await page.setViewportSize({width,height});await setup();await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    const geometry=await page.evaluate(()=>{const inspector=document.querySelector('.workstation-inspector'),rail=document.querySelector('.workstation-rail');return {width:innerWidth,height:innerHeight,bodyWidth:document.body.scrollWidth,paper:document.querySelector('.paper')?.getBoundingClientRect().width,notation:document.querySelectorAll('[aria-label="Music notation"] svg').length,inspector:inspector?.getBoundingClientRect().width?{client:inspector.clientWidth,scroll:inspector.scrollWidth}:null,rail:rail?.getBoundingClientRect().width?[...rail.querySelectorAll('button')].map(node=>{const text=document.createRange();text.selectNodeContents(node);return {name:node.textContent,lines:text.getClientRects().length,client:node.clientWidth,scroll:node.scrollWidth};}):[]};});assert.ok(geometry.notation>0&&geometry.paper>0);assert.ok(geometry.bodyWidth<=width+1,'Horizontal scrolling stays inside panes');if(geometry.inspector)assert.ok(geometry.inspector.scroll<=geometry.inspector.client,'Inspector forms fit the pane');for(const button of geometry.rail){assert.equal(button.lines,1,`${button.name} rail label stays on one line`);assert.ok(button.scroll<=button.client,`${button.name} rail label fits`);}
    const path=output(`${name}-${width}.png`);await page.screenshot({path});const bytes=readFileSync(path);assert.ok(bytes.length>1000);assert.equal(bytes.subarray(1,4).toString(),'PNG');result.screenshots.push({name,path,sha256:sha256(bytes),geometry,inspection:'Root must open once and confirm loaded/nonblank named state.'});
  }
  try{
    id=launch({TABPLAYER_TEST_OPEN:fixture.path,TABPLAYER_TEST_SAVE:savePath,...(fixture.backingPath?{TABPLAYER_TEST_BACKING:fixture.backingPath}:{})});result.pid=id;browser=await connect();page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.setViewportSize({width:1280,height:900});await idle();
    // Same observation seam as instruments.mjs: forward every actual fetch,
    // inspect only public command bodies, never IPC headers/authentication keys.
    await page.evaluate(()=>{
      window.__workstationObservation={prepares:[],commands:[],mixes:[],edits:[]};const nativeFetch=window.fetch.bind(window);
      window.fetch=function(input,options){try{const url=new URL(input instanceof Request?input.url:String(input),location.href);if(url.hostname==='ipc.localhost'&&typeof options?.body==='string'){const name=url.pathname.slice(1),body=JSON.parse(options.body),log=window.__workstationObservation;if(name==='audio_prepare')log.prepares.push(structuredClone(body));if(name==='audio_command')log.commands.push(structuredClone(body));if(name==='audio_set_mix')log.mixes.push(structuredClone(body));if(name==='apply_edit')log.edits.push(structuredClone(body));}}catch{}return nativeFetch(input,options);};
    });
    await clickWorkspaceCommand(page,'Open');owner={...(await workspace()).active};await waitStatus(value=>value.ready&&!value.error);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
    const initial=await record();assert.equal(initial.snapshot.project.base.sha256,fixture.sha256);assert.equal(initial.snapshot.dirty,false);const initialPlan=(await observations()).plan;assert.ok(initialPlan,'Observe actual acknowledged native audio_prepare');
    const actual=initialPlan.notes.map(note=>({track:note.source.target.track,bar:note.source.target.bar,key:note.key,startTick:note.startTick,endTick:note.endTick}));assert.deepEqual(actual.map(note=>JSON.stringify(note)).sort(),fixture.literalNotes.map(note=>JSON.stringify(note)).sort(),'Actual native plan matches independent original note oracle');assert.equal(initialPlan.generation,(await status()).generation);assert.deepEqual((await observations()).prepareOwner,owner);
    result.checks.fileOpen={document:address(initial),owner,sourceHash:fixture.sha256};
    await revealInspector(page);await button('Edit');await page.getByRole('combobox',{name:'String',exact:true}).selectOption('6');await page.getByLabel('Fret',{exact:true}).fill('8');const beforeEdit=await record(),editNative=await status();await button('Set note');const edited=await checkAddressedEdit(beforeEdit,'setNote');await waitStatus(value=>value.ready&&!value.error&&value.generation>editNative.generation);assert.equal((await observations()).plan.notes.find(note=>note.source.target.track===0&&note.source.target.bar===0).key,72);
    await button('Undo');const undone=await record();assert.deepEqual(undone.snapshot.project.edits,initial.snapshot.project.edits);assert.equal(undone.snapshot.canRedo,true);await button('Redo');assert.deepEqual((await record()).snapshot.project.edits,edited.snapshot.project.edits);result.checks.history={edit:address(edited),undo:address(undone),redo:address(await record())};
    result.checks.productionPickerCancellation={open:await productionPickerCancellation('Open'),save:await productionPickerCancellation('Save')};
    await clickWorkspaceCommand(page,'Save');await idle();const saved=await record();assert.equal(saved.snapshot.path,savePath);assert.equal(saved.snapshot.dirty,false);assert.deepEqual(JSON.parse(readFileSync(savePath)).edits,saved.snapshot.project.edits);result.checks.fileSave={document:address(saved),path:savePath,sha256:sha256(readFileSync(savePath))};
    if(backing){await button('Import backing');await waitStatus(value=>value.ready&&value.backingDurationSeconds===8);const value=await record();assert.equal(value.snapshot.project.edits.at(-1).backing.assetId,fixture.backing.sha256);result.checks.backing={document:address(value),sha256:fixture.backing.sha256};}
    // Each real mix UI change must commit its exact command/current revision.
    await revealDock(page,'Mixer');const channel=page.getByRole('region',{name:`Channel 1: ${fixture.tracks[0].name}`,exact:true});const mixReceipts=[];
    for(const [kind,value]of [['mute',true],['solo',true],['gain',.55],['pan',-.25]]){
      if(kind==='mute'||kind==='solo'){
        // Native persisted mix edits settle asynchronously; inspect after the commit.
        const checkbox=channel.getByRole('checkbox',{name:kind==='mute'?'Mute':'Solo',exact:true}),before=await record();assert.equal(await checkbox.isChecked(),!value);await checkbox.click();await idle();await published();assert.equal(await checkbox.isChecked(),value);const after=await checkAddressedEdit(before,'setTrackMix');assert.equal(after.snapshot.project.edits.at(-1).mix[kind],value);mixReceipts.push({kind,value,document:address(after)});
      }else{
        const slider=channel.getByRole('slider',{name:`${kind==='gain'?'Volume':'Pan'} ${fixture.tracks[0].name}`,exact:true}),start=Number(await slider.inputValue()),steps=Math.round((value-start)/.05);
        for(let step=0;step<Math.abs(steps);step++){const before=await record();await slider.press(steps>0?'ArrowRight':'ArrowLeft');await idle();const after=await checkAddressedEdit(before,'setTrackMix');assert.ok(Math.abs(after.snapshot.project.edits.at(-1).mix[kind]-(start+(step+1)*Math.sign(steps)*.05))<1e-8);mixReceipts.push({kind,value:after.snapshot.project.edits.at(-1).mix[kind],document:address(after)});}
      }
      await waitStatus(native=>native.ready&&!native.error);
    }
    // Restore audible mix through the same actual controls.
    for(const label of ['Mute','Solo']){const checkbox=channel.getByRole('checkbox',{name:label,exact:true}),before=await record();assert.equal(await checkbox.isChecked(),true);await checkbox.click();await idle();await published();assert.equal(await checkbox.isChecked(),false);const after=await checkAddressedEdit(before,'setTrackMix');assert.equal(after.snapshot.project.edits.at(-1).mix[label.toLowerCase()],false);}
    const nativeMix=(await observations()).mixes.at(-1);assert.ok(nativeMix);assert.deepEqual(nativeMix.owner,owner);assert.equal(nativeMix.settings.mixes['base/0'].gain,.55);assert.equal(nativeMix.settings.mixes['base/0'].pan,-.25);result.checks.mixer={mixReceipts,nativeMixOwner:nativeMix.owner};
    await revealInspector(page);await button('Edit');await disclosure('Music selection');await button('Select track');const selectionPanel=page.locator('details.editor-section').filter({has:page.locator('summary').filter({hasText:/^Music selection$/})}),selection=await selectionPanel.getByText(`Measures 1–${fixture.measureCount} · Tracks 1`,{exact:true}).innerText();await revealPlaybackControls(page);await disclosure('Selected playback');await page.getByRole('combobox',{name:'Selection occurrence',exact:true}).selectOption('0');await button('Play selection');await waitStatus(value=>value.playing&&value.range!==null&&value.tick>0);
    await page.locator('summary').filter({hasText:/^More playback/}).press('Escape');await revealDock(page,'Overview');const grid=page.getByRole('grid',{name:'Written measure overview',exact:true});
    result.checks.overview=await invariant(async()=>{
      await grid.locator('[data-overview-track="1"][data-overview-bar="1"]').click();await page.locator('[aria-label="Editing location"]').filter({hasText:fixture.tracks[1].name}).waitFor();await page.keyboard.press('ArrowRight');await page.keyboard.press('Space');await page.keyboard.press('End');await grid.locator(`[data-overview-track="1"][data-overview-bar="${fixture.measureCount-1}"]`).waitFor();assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-overview-bar')),String(fixture.measureCount-1));await page.keyboard.press('Home');await page.keyboard.press('Enter');
      for(let track=2;track<=6;track++){await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await page.locator('[aria-label="Editing location"]').filter({hasText:fixture.tracks[track].name}).waitFor();}
      for(let track=6;track>1;track--)await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');await page.keyboard.press('Escape');assert.equal(await page.getByRole('region',{name:'Score workspace',exact:true}).evaluate(node=>node===document.activeElement),true);assert.equal(await selectionPanel.getByText(selection,{exact:true}).count(),1);
    });
    await page.evaluate(()=>{const grid=document.querySelector('[aria-label="Written measure overview"]');window.__workstationGridProbe={first:grid.querySelector('[role="gridcell"]'),mutations:0,observer:new MutationObserver(records=>{window.__workstationGridProbe.mutations+=records.filter(record=>record.type==='childList').length;})};window.__workstationGridProbe.observer.observe(grid,{childList:true,subtree:true});});
    const clockBefore=await status();await waitStatus(value=>value.tick>clockBefore.tick+240);const continuity=await page.evaluate(()=>{const grid=document.querySelector('[aria-label="Written measure overview"]'),probe=window.__workstationGridProbe;probe.observer.disconnect();return {cells:grid.querySelectorAll('[role="gridcell"]').length,width:grid.clientWidth,height:grid.clientHeight,bodyWidth:document.body.scrollWidth,viewport:innerWidth,retainedFirst:probe.first===grid.querySelector('[role="gridcell"]'),childListMutations:probe.mutations};});assert.equal(continuity.retainedFirst,true);assert.equal(continuity.childListMutations,0);assert.ok(continuity.bodyWidth<=continuity.viewport+1);
    // Two-cell overscan on each side, one partially visible cell and one retained focus target.
    const maxWindowCells=Math.min(fixture.tracks.length,Math.ceil(Math.max(0,continuity.height-28)/28)+5)*Math.min(fixture.measureCount,Math.ceil(Math.max(0,continuity.width-144)/28)+5)+1;
    if(long)assert.ok(continuity.cells<=maxWindowCells,`Long overview stays within its viewport window (${continuity.cells}/${maxWindowCells} cells)`);result.checks.gridContinuity={...continuity,maxWindowCells,before:clockBefore,after:await status()};
    // Pause freezes actual native time, allowing exact literal highlight checks.
    await button('Pause');const paused=await waitStatus(value=>!value.playing);await selectWorkspaceTrack(page,`Track 4: ${fixture.tracks[3].name}`);await revealDock(page,'Instrument');const bar=Math.floor(paused.tick/3840),literal=fixture.literalNotes.filter(note=>note.track===3&&note.bar===bar);assert.ok(literal.length,'Paused within an authored piano note');await page.waitForFunction(keys=>JSON.stringify([...document.querySelectorAll('.instrument-view [data-key][data-active="true"]')].map(node=>Number(node.dataset.key)).sort())===JSON.stringify(keys),literal.map(note=>note.key).sort());assert.equal((await status()).tick,paused.tick);result.checks.instrument={track:3,tick:paused.tick,keys:literal.map(note=>note.key)};
    await button('Stop');await waitStatus(value=>!value.playing&&value.tick===0);await selectWorkspaceTrack(page,`Track 1: ${fixture.tracks[0].name}`);await page.setViewportSize({width:960,height:720});
    await revealLeftTask(page,'Track');const tuning=page.getByLabel('Tuning (notes, high to low)',{exact:true});await tuning.fill('D4 A3 F3 C3 G2 D2');await viewCheckbox('Track panel',false);await revealLeftTask(page,'Track');assert.equal(await tuning.inputValue(),'D4 A3 F3 C3 G2 D2');
    result.checks.pasteReveal=[await pasteRevealCheck(true),await pasteRevealCheck(false)];await revealLeftTask(page,'Track');assert.equal(await tuning.inputValue(),'D4 A3 F3 C3 G2 D2');result.checks.tuningDraft='D4 A3 F3 C3 G2 D2';
    await revealPlaybackControls(page);await disclosure('Selected playback');for(const label of ['Seek measure','Loop start','Loop end'])await page.getByLabel(label,{exact:true}).waitFor();await page.getByRole('combobox',{name:'Cursor occurrence',exact:true}).waitFor();await page.getByRole('combobox',{name:'Selection occurrence',exact:true}).waitFor();
    const beforeError=await record(),errorNative=await status(),errorCommands=(await observations()).commands.length;await page.getByLabel('Loop start',{exact:true}).fill('2');await page.getByLabel('Loop end',{exact:true}).fill('1');await button('Loop');await page.getByRole('alert').filter({hasText:'Loop end must follow its start.'}).waitFor();assert.deepEqual(await record(),beforeError);assert.equal((await observations()).commands.length,errorCommands);assert.equal((await status()).generation,errorNative.generation);
    const more=page.locator('summary').filter({hasText:/^More playback(?: · Error)?$/});assert.equal(await more.textContent(),'More playback · Error');const errorGeometry=await page.evaluate(()=>({feedbackBottom:document.querySelector('.transport-feedback[role="alert"]').getBoundingClientRect().bottom,panelTop:document.querySelector('.transport-more-content').getBoundingClientRect().top}));assert.ok(errorGeometry.feedbackBottom<=errorGeometry.panelTop,'Expanded playback controls leave error feedback visible');await more.press('Escape');assert.equal(await more.evaluate(node=>node===document.activeElement),true);result.checks.morePlayback={controls:true,error:'Loop end must follow its start.',errorGeometry,document:address(beforeError),owner};
    if(captures)await screenshot('playback-error',960,720,()=>revealPlaybackControls(page));
    await revealPlaybackControls(page);await page.getByLabel('Loop start',{exact:true}).fill('1');await button('Loop');await waitStatus(value=>value.loop!==null);await button('Clear loop');await waitStatus(value=>value.loop===null);assert.equal(await page.getByRole('alert').count(),0);await more.press('Escape');
    if(captures){
      await screenshot('overview',1280,900,()=>revealDock(page,'Overview'));
      await screenshot('mixer',1600,1000,()=>revealDock(page,'Mixer'));
      await screenshot('sound',960,720,()=>revealLeftTask(page,'Sound'));
      await screenshot('instrument',960,720,()=>revealDock(page,'Instrument'));
      await screenshot('inspector-expanded',1280,900,async()=>{await revealInspector(page);await button('Edit');await disclosure('Advanced rhythm');await disclosure('Music selection');await disclosure('Musical clipboard');});
    }
    assertWorkstationFixtureHashes(fixture);assert.deepEqual(errors,[]);result.pageErrors=errors;result.document=address(await record());result.finalNative=await status();result.inputs=fixture.hashes;
    const path=output('result.json');writeFileSync(path,JSON.stringify(result,null,2),{flag:'wx'});return {...result,resultPath:path};
  }catch(error){writeFileSync(output('failure.json'),JSON.stringify({error:String(error),pid:id,owner,status:page&&owner?await status().catch(()=>null):null,record:page&&owner?await record().catch(()=>null):null,pageErrors:errors},null,2),{flag:'wx'});throw error;}
  finally{for(const child of helpers)child.kill('SIGKILL');try{if(browser)await browser.close();}finally{if(id!==null)stop(id);}}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const flags=new Set(process.argv.slice(2));for(const flag of flags)assert.ok(['--captures','--long','--backing'].includes(flag),`Unknown workstation acceptance flag: ${flag}`);console.log(JSON.stringify(await runWorkstationAcceptance({captures:flags.has('--captures'),long:flags.has('--long'),backing:flags.has('--backing')}),null,2));}
