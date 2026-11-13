import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,resolve,dirname,win32} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const modes=Object.freeze(['verticalPage','horizontalPage','grid','parchment','verticalScreen','horizontalScreen']);
const captureMatrix=Object.freeze(modes.flatMap(layout=>[Object.freeze({layout,width:1600,height:1000}),Object.freeze({layout,width:1024,height:600})]));
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const equalPath=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const pairKey=pair=>`${pair.layout}/${pair.width}/${pair.height}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const initialCapturePath=resolve(repository,'.analysis/desktop-smoke/score-layout-initial-runtime.json');
const initialIdentityFields=['ownershipId','statePath','stateSha256','runDirectory','resultPath','admissionSha256','buildSourceSha256'];

export function assertScoreLayoutInitialAvailable(path){assert.equal(existsSync(path),false,'Initial capture allowance is already reserved/consumed');}
export function reserveScoreLayoutInitialCapture(path,result){
  assert.equal(result.scope,'initial');const identity=Object.fromEntries(initialIdentityFields.map(key=>{assert.ok(typeof result[key]==='string'&&result[key]);return [key,result[key]];}));
  const bytes=JSON.stringify({format:'TabPlayerScoreLayoutInitialCapture',version:1,...identity});writeFileSync(path,bytes,{flag:'wx'});return {path,sha256:hash(bytes)};
}
export function assertScoreLayoutInitialBinding(path,initial,receiptPath){
  const bytes=readFileSync(path),reservation=JSON.parse(bytes);assert.equal(reservation.format,'TabPlayerScoreLayoutInitialCapture');assert.equal(reservation.version,1);assert.equal(initial.scope,'initial');
  for(const key of initialIdentityFields)assert.equal(initial[key],reservation[key],`Initial capture identity differs: ${key}`);
  assert.ok(equalPath(receiptPath,reservation.resultPath),'Initial receipt path differs from reserved identity');return {path,sha256:hash(bytes)};
}

export function validateScoreLayoutArguments(args){
  assert.ok(Array.isArray(args)&&args.every(arg=>typeof arg==='string'));
  if(!args.length||args.length===1&&args[0]==='--help')return {mode:'help'};
  assert.equal(args.length,2,'Use --run OR --confirm-visual and one absolute --state path');
  const action=args.filter(arg=>arg==='--run'||arg==='--confirm-visual');
  const paths=args.filter(arg=>arg.startsWith('--state='));
  assert.equal(action.length,1);assert.equal(paths.length,1);
  const statePath=paths[0].slice(8);assert.ok(statePath&&(isAbsolute(statePath)||win32.isAbsolute(statePath)),'State path must be absolute');
  return {mode:action[0]==='--run'?'run':'confirm',statePath};
}

export function validateScoreLayoutRun(state,confirmation,{initial,consumed=false}={}){
  assert.equal(state.format,'TabPlayerScoreLayoutAcceptance');assert.equal(state.version,1);assert.equal(state.authored,true);
  assert.ok(state.ownershipId);for(const name of ['admissionSha256','buildSourceSha256'])assert.match(state[name]??'',/^[a-f0-9]{64}$/i);
  if(!confirmation){assert.equal(state.confirmation,undefined,'Confirmation state cannot execute initial gates');return captureMatrix.map(pair=>({...pair}));}
  assert.equal(consumed,false,'Second confirmation is forbidden');const packet=state.confirmation;assert.equal(packet?.attempt,1);
  for(const name of ['initialReceiptSha256','correctionPacketSha256'])assert.match(packet[name]??'',/^[a-f0-9]{64}$/i);
  assert.equal(initial?.format,'TabPlayerScoreLayoutReceipt');assert.equal(initial.version,1);assert.equal(initial.scope,'initial','Cannot confirm a confirmation');
  assert.deepEqual(initial.screenshots.map(({layout,width,height})=>({layout,width,height})),captureMatrix,'Confirmation requires the complete original twelve frames');
  assert.ok(Array.isArray(packet.affectedPairs)&&packet.affectedPairs.length>0&&packet.affectedPairs.length<=12);
  const keys=packet.affectedPairs.map(pairKey);assert.equal(new Set(keys).size,keys.length,'Duplicate confirmation pair');
  assert.ok(keys.every(key=>captureMatrix.some(pair=>pairKey(pair)===key)),'Unplanned confirmation pair');
  return captureMatrix.filter(pair=>keys.includes(pairKey(pair))).map(pair=>({...pair}));
}

export function assertScoreLayoutCapture(planned,captured,pair){
  assert.ok(planned.length>0&&planned.length<=12);assert.equal(new Set(planned.map(pairKey)).size,planned.length);
  assert.ok(planned.every(item=>captureMatrix.some(pair=>pairKey(item)===pairKey(pair))));
  assert.ok(!captured.some(item=>pairKey(item)===pairKey(pair)),'Duplicate capture');
  assert.equal(pairKey(pair),planned[captured.length]&&pairKey(planned[captured.length]),'Capture must follow frozen order and budget');
  assert.deepEqual(captured.map(pairKey),planned.slice(0,captured.length).map(pairKey),'Capture order');
}

export function validateScoreLayoutCorrections(packet){
  assert.deepEqual(Object.keys(packet??{}),['corrections']);assert.ok(Array.isArray(packet.corrections)&&packet.corrections.length>0);
  const supported=['presentation','fit','pointer'],selected=new Set();
  for(const correction of packet.corrections){assert.deepEqual(Object.keys(correction).sort(),['contracts','description']);assert.ok(typeof correction.description==='string'&&correction.description.trim());assert.ok(Array.isArray(correction.contracts)&&correction.contracts.length>0);for(const name of correction.contracts){assert.ok(supported.includes(name),`Unsupported correction contract ${name}`);selected.add(name);}}
  return supported.filter(name=>selected.has(name));
}

export function assertOwnedScoreLayoutProcess(expected,actual){
  assert.ok(Number.isSafeInteger(expected?.pid)&&expected.pid>0&&/^[1-9][0-9]+$/.test(expected.startTicks),'Invalid captured identity');
  assert.ok(actual&&actual.pid===expected.pid&&equalPath(actual.path,expected.path)&&actual.startTicks===expected.startTicks,'Captured process identity changed');
}

// WebView2 keeps its data in an EBWebView folder inside the profile it is given, so that folder counts as the owned profile.
export function assertScoreLayoutListener(identity,profile,rows){
  assert.ok(Array.isArray(rows)&&rows.length>0,'Missing owned listener');const path=profile.replaceAll('\\','/').toLowerCase();
  for(const row of rows){assert.ok(Array.isArray(row.chain)&&row.chain[0]?.pid===row.owner);assert.ok(row.chain.some(item=>item.pid===identity.pid),'Listener has foreign ancestry');assert.ok(row.chain.some(item=>{const command=String(item.commandLine).replaceAll('\\','/').toLowerCase(),offset=command.indexOf(path);return offset>=0&&/^(\/ebwebview)?(["\s]|$)/.test(command.slice(offset+path.length))&&['"','=',' '].includes(command[offset-1]);}),'Listener lacks exact owned profile');}
}

export function assertScoreLayoutWindow(kind,before,after,calls,proof){
  assert.equal(before.native.playing,false);assert.equal(after.native.playing,false);
  assert.deepEqual(after.owner,before.owner,'Document/audio owner changed');
  if(kind==='view-only'){
    assert.deepEqual(after.record,before.record,'View-only window changed project/history/revision/dirty/redo');
    assert.deepEqual(after.native,before.native,'View-only window changed native preparation/position/range/loop');
    assert.ok(!calls.some(row=>['audio_prepare','audio_command','audio_set_mix','apply_edit'].includes(row.command)),'Mutation inside view-only window');
  }else{
    assert.equal(kind,'range-proof');assert.ok(proof?.selectionVerified&&proof.changedNotesVerified&&proof.undoMusicVerified,'Range proof requires exact selection, changed notes and actual Undo');
    assert.ok(calls.some(row=>row.command==='apply_edit'&&row.acknowledged),'Range proof needs acknowledged edit');
    assert.ok(after.record.revision>before.record.revision,'Undo is a revision change, not a view-only baseline');
    assert.deepEqual(after.record.snapshot.project,before.record.snapshot.project,'Undo restores source music');
  }
}

// Self-contained browser evaluator. No production screen/hit mapper is imported.
export function readScoreLayoutNotePoint({target,noteIndex}){
  const fail=message=>{throw new Error(message);};
  const store=window.__scoreLayoutAcceptance,api=store?.publicApi;
  if(!api||!store.capable||store.completedGeneration!==store.generation||store.generation<1)fail('No completed current public renderer generation');
  if(!target||!['track','staff','bar','voice','beat'].every(key=>Number.isInteger(target[key])&&target[key]>=0))fail('Invalid literal target');
  const beat=api.score?.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
  if(!beat)fail('Literal beat is absent from actual public score');
  const note=noteIndex===null?null:beat.notes?.[noteIndex];if(noteIndex!==null&&!note)fail('Literal note absent');
  const bounds=(api.boundsLookup?.findBeats(beat)??[]).filter(row=>row.beat===beat);
  const matches=bounds.flatMap(bound=>{
    const system=bound.barBounds?.masterBarBounds?.staffSystemBounds;
    if(!system||!api.boundsLookup.staffSystems.includes(system))return [];
    return note?(bound.notes??[]).filter(row=>row.note===note).map(row=>({rect:row.noteHeadBounds,system})):[{rect:bound.realBounds,system}];
  }).filter(({rect})=>rect&&[rect.x,rect.y,rect.w,rect.h].every(Number.isFinite)&&rect.w>0&&rect.h>0);
  if(!matches.length)fail('Actual note/beat lacks public bounds');
  // Standard/TAB may both expose bounds. Prefer the first public bounds in source order;
  // each candidate still needs a unique current chunk and actual SVG transform.
  const {rect,system}=matches[0],sx=rect.x+rect.w/2,sy=rect.y+rect.h/2;
  if(!system.bars?.length||!system.bars.every(bar=>Number.isInteger(bar.index)))fail('Missing public system bar interval');
  const chunks=store.chunks.filter(chunk=>chunk.generation===store.generation&&chunk.firstMasterBarIndex<=target.bar&&chunk.lastMasterBarIndex>=target.bar&&
    chunk.firstMasterBarIndex===system.bars[0].index&&chunk.lastMasterBarIndex===system.bars.at(-1).index&&
    sx>=chunk.x&&sx<=chunk.x+chunk.width&&sy>=chunk.y&&sy<=chunk.y+chunk.height);
  if(chunks.length!==1)fail('Ambiguous or stale public chunk interval');const chunk=chunks[0];
  const visible=node=>{
    if(!node.isConnected||!node.getClientRects().length||node.closest('[aria-hidden="true"],[inert],.score-source-staging'))return false;
    for(let parent=node;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0&&style.opacity!=='')return false;}
    const r=node.getBoundingClientRect();return r.width>0&&r.height>0;
  };
  const normalize=(root,observed)=>{
    const copy=root.cloneNode(true);
    for(const element of [copy,...copy.querySelectorAll('*')]){
      // Only the observed public highlighting class may differ. An opaque group ID
      // must have been supplied by the facade and be present on this same element.
      if(observed&&element.classList.contains('at-highlight')&&(store.highlights??[]).some(row=>row.generation===store.generation&&row.kind==='highlight'&&row.groupId&&element.classList.contains(row.groupId)))element.classList.remove('at-highlight');
      if(element.hasAttribute('class')&&!element.getAttribute('class').trim())element.removeAttribute('class');
    }
    const canonical=node=>node.nodeType===3?['text',node.textContent]:node.nodeType===1?[node.localName,[...node.attributes].map(attr=>[attr.name,attr.value]).sort((a,b)=>a[0].localeCompare(b[0])),[...node.childNodes].map(canonical).filter(Boolean)]:null;
    return JSON.stringify(canonical(copy));
  };
  const reference=new DOMParser().parseFromString(chunk.svg,'image/svg+xml').documentElement;
  if(reference.localName!=='svg'||reference.querySelector('parsererror'))fail('Invalid public SVG render result');
  const signature=normalize(reference,false);
  const physical=[...document.querySelectorAll('.score-svg-chunk > svg')].filter(visible);
  const source=[...document.querySelectorAll('.score-live-paper [data-testid="score-source"] svg, .score-live-paper[data-testid="score-source"] svg')].filter(visible);
  const candidates=(physical.length?physical:source).filter(svg=>normalize(svg,true)===signature);
  if(candidates.length!==1)fail('Visible SVG association is missing or ambiguous');const svg=candidates[0];
  const dimension=name=>{const value=reference.getAttribute(name);return /^\d+(?:\.\d+)?(?:px)?$/.test(value??'')?parseFloat(value):NaN;};
  const width=dimension('width'),height=dimension('height');
  if(!Number.isFinite(width)||!Number.isFinite(height)||Math.abs(width-chunk.width)>1.01||Math.abs(height-chunk.height)>1.01)fail('Public event/SVG dimensions disagree');
  const viewBox=reference.getAttribute('viewBox');if(viewBox&&viewBox.trim().split(/[ ,]+/).slice(0,2).some(value=>Number(value)!==0))fail('Unsupported SVG origin convention');
  const matrix=svg.getScreenCTM();if(!matrix||!['a','b','c','d','e','f'].every(key=>Number.isFinite(matrix[key])))fail('Missing actual SVG screen transform');
  const local={x:sx-chunk.x,y:sy-chunk.y},point={x:matrix.a*local.x+matrix.c*local.y+matrix.e,y:matrix.b*local.x+matrix.d*local.y+matrix.f};
  if(!physical.length){
    const canvas=api.uiFacade?.getOffset(null,api.canvasElement);if(!canvas)fail('Missing public source canvas offset');
    if(Math.abs(point.x-(canvas.x-window.scrollX+sx))>2||Math.abs(point.y-(canvas.y-window.scrollY+sy))>2)fail('Public source origin does not agree with SVG CTM');
  }
  const box=svg.getBoundingClientRect();let clip={left:box.left,top:box.top,right:box.right,bottom:box.bottom};
  for(let parent=svg.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent),r=parent.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowX)){clip.left=Math.max(clip.left,r.left+parent.clientLeft);clip.right=Math.min(clip.right,r.left+parent.clientLeft+parent.clientWidth);}if(/auto|scroll|hidden|clip/.test(style.overflowY)){clip.top=Math.max(clip.top,r.top+parent.clientTop);clip.bottom=Math.min(clip.bottom,r.top+parent.clientTop+parent.clientHeight);}}
  return {target:{...target},noteIndex,sourceRect:{x:rect.x,y:rect.y,w:rect.w,h:rect.h},chunkId:chunk.id,visibleRect:clip,point,generation:store.generation};
}

function nativeInvariant(status){
  return Object.fromEntries(['ready','error','generation','desiredGeneration','tick','seconds','durationSeconds','backingDurationSeconds','speed','playing','practice','range','loop'].map(key=>[key,status[key]]));
}
function successfulCalls(calls){
  for(const row of calls){assert.equal(row.settled,true,'An observed command has not acknowledged');assert.equal(row.ok,true,`Native ${row.command} failed`);if(row.command!=='apply_edit')assert.equal(row.result,null);}
  return calls.map(row=>({...row,acknowledged:row.settled&&row.ok}));
}
const ownedScript='$p=Get-Process -Id $env:SCORE_OWNED_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:SCORE_OWNED_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:SCORE_OWNED_START){throw "Captured process identity changed"}};';

class Context{
  constructor(state,admission,result,deps){Object.assign(this,{state,admission,result,deps});this.executable=realpathSync(admission.executable);this.identity=null;this.page=null;this.browser=null;this.phase=null;this.sequence=0;this.observersInstalled=false;}
  step(action,values={}){this.result.steps.push({phase:this.phase,action,time:new Date().toISOString(),values});}
  ps(script,extra={}){return this.deps.execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,SCORE_OWNED_PID:String(this.identity?.pid??''),SCORE_OWNED_EXE:this.executable,SCORE_OWNED_START:this.identity?.startTicks??'',...extra}}).trim();}
  inspect(){const actual=JSON.parse(this.ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertOwnedScoreLayoutProcess(this.identity,actual);return actual;}
  healthy(){this.deps.observer.assertNoTauriFallback(this.result.transportFallbacks);assert.deepEqual(this.result.pageErrors,[],'Page error invalidates acceptance');}
  owned(){this.healthy();assert.ok(this.identity&&this.inspect(),'Owned process exited');assert.equal(hash(readFileSync(this.executable)),this.admission.executableSha256);}
  async poll(read,predicate,label,timeout=30000){const deadline=performance.now()+timeout;let value;do{value=await read();if(predicate(value))return value;await sleep(40);}while(performance.now()<deadline);throw Error(`Timed out: ${label}`);}
  async invoke(command,args={}){
    assert.ok(['workspace_snapshot','project_snapshot','audio_status','recovery_status','audio_command'].includes(command),'Driver permits read-only IPC and paused seek only');
    this.owned();if(command==='audio_command'){assert.equal(args.command?.type,'seekTick');const status=await this.nativeReady();assert.equal(status.playing,false);assert.equal(args.command.generation,status.generation);assert.deepEqual(args.owner,(await this.workspace()).active);}
    const value=await this.page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);this.healthy();return value;
  }
  workspace(){return this.invoke('workspace_snapshot');}
  async record(documentId){return this.invoke('project_snapshot',{documentId:documentId??(await this.workspace()).active.documentId});}
  async nativeReady(){return this.poll(()=>this.invoke('audio_status'),value=>{assert.equal(value.playing,false,'Unexpected running intent');return value.ready&&!value.error&&value.generation===value.desiredGeneration;},'native ready/current generation');}
  async snapshot(){return {owner:(await this.workspace()).active,record:await this.record(),native:nativeInvariant(await this.nativeReady())};}
  async evidence(){const result=await this.page.evaluate(this.deps.observer.readScoreLayoutEvidence);assert.deepEqual(result.failures,[],'Passive observer failed');return result;}
  async idle(){this.owned();await this.deps.ui.waitForWorkspaceIdle(this.page);this.healthy();}
  async published(){
    await this.idle();await this.poll(()=>this.evidence(),value=>value.capable&&value.generation>0&&value.completedGeneration===value.generation&&value.chunks.length>0,'actual public render receiver and completed current chunks');
    await this.page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    const before=await this.evidence();await this.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const after=await this.evidence();assert.equal(after.completedGeneration,after.generation);assert.equal(after.generation,before.generation,'Presentation changed during publication');this.healthy();
  }
  async stable(){
    let previous=null,matching=0;const started=performance.now(),first=(await this.evidence()).completedGeneration;
    const evidence=await this.poll(async()=>{await this.published();return this.evidence();},value=>{const key=JSON.stringify([value.generation,value.completedGeneration,value.apiRenders,value.calls.map(row=>[row.id,row.settled])]);matching=key===previous?matching+1:0;previous=key;return matching>=3&&value.calls.every(row=>row.settled);},'settled render/acknowledgement boundary');
    successfulCalls(evidence.calls);const renderCompletions=evidence.completedGeneration-first;assert.ok(renderCompletions<=8,'Unbounded render completion loop');return {renderCompletions,elapsedMs:performance.now()-started,evidence};
  }
  async action(name,work,{viewKeys=[],resizeOnly=false}={}){
    this.owned();await this.stable();const before=await this.snapshot(),evidence=await this.evidence(),start=performance.now();
    const priorView=await this.currentView();await work();await this.idle();const stable=await this.stable(),after=await this.snapshot(),calls=successfulCalls(stable.evidence.calls.slice(evidence.calls.length));
    assertScoreLayoutWindow('view-only',before,after,calls);
    const writes=calls.filter(row=>row.command==='workspace_set_view');if(resizeOnly)assert.equal(writes.length,0,'Derived resize wrote document view');
    for(const row of writes){assert.equal(row.payload.documentId,before.owner.documentId);const actual=row.payload.view;for(const key of Object.keys({...priorView,...actual}))if(!viewKeys.includes(key))assert.deepEqual(actual[key],priorView[key],`Unintended view field ${key}`);}
    const renderCompletions=stable.evidence.completedGeneration-evidence.completedGeneration;assert.ok(renderCompletions<=8,'Unbounded action render completion loop');
    this.step(name,{kind:'view-only',recordSha256:hash(JSON.stringify(after.record)),revision:after.record.revision,native:after.native,owner:after.owner,viewWrites:writes.map(row=>({id:row.id,view:row.payload.view})),renderCompletions,elapsedMs:performance.now()-start});return {before,after,calls};
  }
  async currentView(){
    const rows=(await this.evidence()).calls.filter(row=>row.command==='workspace_set_view'&&row.settled&&row.ok&&row.payload.documentId===this.documentId);
    if(rows.length)return rows.at(-1).payload.view;
    const checkpoint=await this.checkpoint();const document=checkpoint.envelope.documents.find(row=>row.documentId===this.documentId);assert.ok(document,'No durable initial document view');return document.view;
  }
  async fitBinding(){
    const record=await this.record(),view=await this.currentView();
    return {documentId:record.documentId,revision:record.revision,projectSha256:hash(JSON.stringify(record.snapshot.project)),trackView:view.trackView,profile:await this.page.evaluate(()=>window.__scoreLayoutAcceptance.publicApi.settings.display.staveProfile)};
  }
  async button(name){this.owned();await this.deps.ui.clickWorkstationButton(this.page,name);await this.idle();}
  async viewWrite(name,work,expected){
    const offset=(await this.evidence()).calls.length;await work();await this.idle();const row=await this.poll(async()=>{await this.published();return (await this.evidence()).calls.slice(offset).find(row=>row.command==='workspace_set_view'&&row.payload.documentId===this.documentId&&row.settled&&row.ok&&Object.entries(expected).every(([key,value])=>JSON.stringify(row.payload.view[key])===JSON.stringify(value)));},Boolean,`${name}: acknowledged native view`);successfulCalls([row]);return row;
  }
  async setMode(layout){if(await this.page.getByRole('combobox',{name:'Display mode',exact:true}).inputValue()!==layout)await this.viewWrite('mode',async()=>{await showDisplayControls(this.page);await this.page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption(layout);},{scoreDisplay:{layout,zoomMode:(await this.currentView()).scoreDisplay?.zoomMode==='fitPage'&&!modes.slice(0,3).includes(layout)?'fitWidth':(await this.currentView()).scoreDisplay?.zoomMode??'manual'}});await this.published();}
  async manual(value){await showDisplayControls(this.page);const view=await this.currentView(),layout=view.scoreDisplay?.layout??'parchment',zoom=this.page.getByLabel('Zoom (%)',{exact:true});
    // A page layout with no display of its own fits a narrow window until a zoom is chosen (THE-196): while Fit width shows pressed, Enter in the zoom field chooses the shown value even when it is already 100.
    const fitted=await this.page.getByRole('button',{name:'Fit width',exact:true}).getAttribute('aria-pressed')==='true';
    if(view.zoom!==value||fitted||(view.scoreDisplay?.zoomMode??'manual')!=='manual')await this.viewWrite('manual zoom',async()=>{await showDisplayControls(this.page);await zoom.fill(String(value));await zoom.press('Enter');},{zoom:value,scoreDisplay:{layout,zoomMode:'manual'}});await this.published();}
  async fit(mode){const layout=(await this.currentView()).scoreDisplay?.layout??'parchment';await this.viewWrite(mode,async()=>{await showDisplayControls(this.page);await this.page.getByRole('button',{name:mode==='fitWidth'?'Fit width':'Fit page',exact:true}).click();},{scoreDisplay:{layout,zoomMode:mode}});await this.published();}
  async point(target,noteIndex=0){
    await this.published();let point=await this.page.evaluate(readScoreLayoutNotePoint,{target,noteIndex});
    const clipped=value=>value.point.x<value.visibleRect.left||value.point.x>=value.visibleRect.right||value.point.y<value.visibleRect.top||value.point.y>=value.visibleRect.bottom;
    for(let attempt=0;attempt<3&&clipped(point);attempt++){
      await this.page.locator('.paper-scroll').evaluate((host,point)=>{const r=host.getBoundingClientRect();host.scrollBy({left:point.x-(r.left+host.clientWidth/2),top:point.y-(r.top+host.clientHeight/2),behavior:'instant'});},point.point);await this.published();point=await this.page.evaluate(readScoreLayoutNotePoint,{target,noteIndex});
    }
    assert.equal(clipped(point),false,'Pointer is clipped after host-only reveal');return point;
  }
  async click(note,options={}){this.owned();const point=await this.point(note.target,note.noteIndex??null);await this.page.mouse.click(point.point.x,point.point.y,options);await this.published();return point;}
  async installObservers(){this.observersInstalled=true;await this.page.evaluate(this.deps.observer.installScoreLayoutIpcObserver);await this.page.evaluate(this.deps.observer.installScoreLayoutApiObserver);this.healthy();}
  async start(phase,path,{sessionDirectory,restore=false}={}){
    assert.equal(this.identity,null);this.deps.fixture.assertScoreLayoutFixture(this.state,this.result.statePath);this.phase=phase;
    const directory=resolve(this.result.runDirectory,`${String(++this.sequence).padStart(2,'0')}-${phase}`);mkdirSync(directory);assert.ok(this.deps.fixture.contained(this.result.runDirectory,directory));
    this.phaseDirectory=directory;this.nativeDirectory=sessionDirectory??resolve(directory,'native');if(!sessionDirectory)mkdirSync(this.nativeDirectory);else assert.ok(this.deps.fixture.contained(this.result.runDirectory,sessionDirectory));
    const profileDirectory=resolve(directory,'profile');mkdirSync(profileDirectory);
    await new Promise((accept,reject)=>{const server=this.deps.createServer();server.once('error',reject);server.listen(9223,'127.0.0.1',()=>server.close(error=>error?reject(error):accept()));});
    const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.toUpperCase().startsWith('TABPLAYER_TEST_')));
    const receiptPath=resolve(directory,'launch-identity.json');Object.assign(environment,{TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:this.nativeDirectory,TABPLAYER_TEST_OPEN:path,WEBVIEW2_USER_DATA_FOLDER:profileDirectory,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',SCORE_OWNED_EXE:this.executable,SCORE_LAUNCH_RECEIPT:receiptPath});
    const script='$ErrorActionPreference="Stop";$captured=$null;try{$p=Start-Process -FilePath $env:SCORE_OWNED_EXE -WindowStyle Hidden -PassThru;$captured=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()};$text=$captured|ConvertTo-Json -Compress;$stream=[IO.File]::Open(($env:SCORE_LAUNCH_RECEIPT+".pending"),[IO.FileMode]::CreateNew);try{$bytes=[Text.Encoding]::UTF8.GetBytes($text);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()};[IO.File]::Move(($env:SCORE_LAUNCH_RECEIPT+".pending"),$env:SCORE_LAUNCH_RECEIPT);$text}catch{$failure=$_;if($null -ne $captured){$live=Get-Process -Id $captured.pid -ErrorAction SilentlyContinue;if($null -ne $live -and [string]::Equals($live.Path,$captured.path,[StringComparison]::OrdinalIgnoreCase) -and $live.StartTime.ToUniversalTime().Ticks.ToString() -ceq $captured.startTicks){Stop-Process -Id $live.Id;$null=$live.WaitForExit(5000)}};throw $failure}';
    try{this.identity=JSON.parse(this.deps.execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());}
    catch(error){if(existsSync(receiptPath))this.identity=json(receiptPath);throw error;}
    assertOwnedScoreLayoutProcess(this.identity,json(receiptPath));assert.ok(equalPath(this.identity.path,this.executable));this.owned();
    const readListeners=()=>JSON.parse(this.ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));const listener=await this.poll(readListeners,rows=>rows.length>0,'owned CDP listener');
    assertScoreLayoutListener(this.identity,profileDirectory,listener);
    this.result.launches.push({phase,identity:this.identity,receiptPath,nativeDirectory:this.nativeDirectory,profileDirectory,listener:listener.map(row=>({owner:row.owner,ancestors:row.chain.map(item=>item.pid),ownedProfileVerified:true}))});
    this.browser=await this.deps.connect();this.owned();const connectedListeners=readListeners();assertScoreLayoutListener(this.identity,profileDirectory,connectedListeners);assert.deepEqual(connectedListeners.map(row=>row.owner).sort(),listener.map(row=>row.owner).sort());this.page=this.browser.contexts()[0].pages()[0];assert.ok(this.page);this.page.setDefaultTimeout(25000);
    this.removeFallback=this.deps.observer.observeTauriFallback(this.page,this.result.transportFallbacks,phase);this.errorHandler=()=>this.result.pageErrors.push({phase,kind:'pageerror'});this.page.on('pageerror',this.errorHandler);
    await this.page.setViewportSize({width:1600,height:1000});await this.page.locator(restore?'[role="dialog"]':'.app-shell').waitFor();
    await this.installObservers();
    let began;
    if(restore){const dialog=this.page.getByRole('dialog',{name:'Recover unsaved work?',exact:true});began=performance.now();await dialog.getByRole('button',{name:'Restore',exact:true}).click();await this.idle();}
    else{const library=this.page.getByRole('dialog',{name:'Library',exact:true});await library.waitFor();await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await this.idle();began=performance.now();await this.deps.ui.clickWorkspaceCommand(this.page,'Open');}
    await this.published();const record=await this.record();this.documentId=record.documentId;assert.equal(record.snapshot.project.base.sha256,this.state.hashes[this.state.scorePath]);await this.nativeReady();
    this.result.performance.push({phase,operation:restore?'restored-render':'fresh-open-render',elapsedMs:performance.now()-began,...await this.page.evaluate(readScoreLayoutDom)});return record;
  }
  async checkpoint(){
    return this.poll(async()=>{
      const status=await this.invoke('recovery_status');assert.notEqual(status.state,'failed','Recovery checkpoint failed');if(status.state!=='ready')return null;
      const directory=resolve(this.nativeDirectory,'recovery-v1'),manifestPath=resolve(directory,'manifest.json');if(!existsSync(manifestPath))return null;
      const first=readFileSync(manifestPath),manifest=JSON.parse(first);assert.equal(manifest.format,'TabPlayerRecoveryManifest');assert.equal(manifest.version,1);assert.ok(Number.isSafeInteger(manifest.epoch)&&manifest.epoch>0);assert.ok(Number.isSafeInteger(manifest.current.generation)&&manifest.current.generation>0);
      const payload=readFileSync(resolve(directory,`checkpoint-${manifest.current.generation}.json`)),last=readFileSync(manifestPath);if(!first.equals(last))return null;assert.equal(hash(payload),manifest.current.sha256);const envelope=JSON.parse(payload);assert.equal(envelope.format,'TabPlayerRecovery');assert.equal(envelope.epoch,manifest.epoch);assert.equal(envelope.generation,manifest.current.generation);
      if(status.generation!==envelope.generation||status.capturedAtUnixMs!==envelope.capturedAtUnixMs)return null;
      return {manifest,envelope,receipt:{manifestSha256:hash(first),payloadSha256:hash(payload),epoch:envelope.epoch,generation:envelope.generation,capturedAtUnixMs:envelope.capturedAtUnixMs}};
    },Boolean,'stable acknowledged recovery checkpoint');
  }
  async close({crash=false}={}){
    if(!this.identity)return;
    let clean=false,cleanupError=null,exited=false;
    if(this.page&&!crash)try{clean=(await this.workspace()).documents.every(row=>!row.snapshot.dirty);}catch(error){cleanupError=error;}
    if(this.page&&this.observersInstalled){
      try{const disposed=await this.page.evaluate(this.deps.observer.disposeScoreLayoutObservers);assert.equal(disposed.released,true);assert.equal(disposed.restored,true);this.step('Restore owned passive observers',disposed);}catch(error){cleanupError??=error;}
      this.observersInstalled=false;
    }
    try{
      try{assert.equal(hash(readFileSync(this.executable)),this.admission.executableSha256);}catch(error){cleanupError??=error;}
      if(this.inspect()){
        let method='exact-identity-termination';
        if(clean&&!crash&&!cleanupError){
          try{this.ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};if(-not $p.CloseMainWindow()){throw 'Owned WM_CLOSE rejected'}`);await this.poll(()=>this.inspect(),value=>value===null,'exact owned WM_CLOSE',15000);method='WM_CLOSE';}
          catch(error){cleanupError??=error;}
        }
        if(this.inspect()){this.ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;$null=$p.WaitForExit(5000)}`);assert.equal(this.inspect(),null);}
        this.result.cleanup.push({phase:this.phase,identity:this.identity,method,retainedArtifacts:true});
      }
      exited=true;
    }catch(error){cleanupError??=error;}
    finally{
      try{this.healthy();}catch(error){cleanupError??=error;}
      try{if(this.browser)await this.browser.close();}catch(error){cleanupError??=error;}
      try{this.healthy();}catch(error){cleanupError??=error;}
      if(this.removeFallback)this.removeFallback();if(this.page&&this.errorHandler)this.page.off('pageerror',this.errorHandler);
      this.browser=null;this.page=null;this.removeFallback=null;if(exited)this.identity=null;
    }
    if(cleanupError)throw cleanupError;
  }
}

export {Context as ScoreLayoutContext};

// Copied DOM data only; current public API remains in the owned browser.
function readScoreLayoutDom(){
  const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const host=document.querySelector('.paper-scroll');if(!host)throw Error('Missing actual score scroll host');
  const store=window.__scoreLayoutAcceptance,style=getComputedStyle(host),sheets=[...document.querySelectorAll('.score-sheet')];
  const source=document.querySelector('[data-testid="score-source"]'),presented=document.querySelector('.score-presentation')??document.querySelector('.score-live-paper');
  return {innerWidth,innerHeight,devicePixelRatio,host:{...rect(host),clientWidth:host.clientWidth,clientHeight:host.clientHeight,scrollWidth:host.scrollWidth,scrollHeight:host.scrollHeight,scrollLeft:host.scrollLeft,scrollTop:host.scrollTop,paddingLeft:parseFloat(style.paddingLeft)||0,paddingRight:parseFloat(style.paddingRight)||0,paddingTop:parseFloat(style.paddingTop)||0,paddingBottom:parseFloat(style.paddingBottom)||0},scrollHosts:document.querySelectorAll('.paper-scroll').length,pages:sheets.map(sheet=>({...rect(sheet),chunks:[...sheet.querySelectorAll('.score-svg-chunk > svg')].map(svg=>svg.textContent)})),sourceNodes:source?.querySelectorAll('*').length??0,sourceSvgs:source?.querySelectorAll('svg').length??0,derivedNodes:document.querySelectorAll('.score-svg-chunk *').length,derivedSvgs:document.querySelectorAll('.score-svg-chunk > svg').length,chunkCount:store?.chunks.length??0,apiRenders:store?.apiRenders??0,generation:store?.generation,completedGeneration:store?.completedGeneration,presentation:presented?rect(presented):null,fontsStatus:document.fonts.status,memory:performance.memory?{source:'performance.memory.usedJSHeapSize',bytes:performance.memory.usedJSHeapSize}:null};
}

function readPublicNotes(){
  const store=window.__scoreLayoutAcceptance;if(!store?.publicApi||store.generation!==store.completedGeneration)throw Error('No completed actual score');
  return store.publicApi.score.tracks.flatMap((track,trackIndex)=>track.staves.flatMap((staff,staffIndex)=>staff.bars.flatMap((bar,barIndex)=>bar.voices.flatMap((voice,voiceIndex)=>voice.beats.flatMap((beat,beatIndex)=>beat.notes.map((note,noteIndex)=>({target:{track:trackIndex,staff:staffIndex,bar:barIndex,voice:voiceIndex,beat:beatIndex},noteIndex,string:note.string,key:note.realValue})))))));
}
const noteKey=note=>JSON.stringify([note.target.track,note.target.staff,note.target.bar,note.target.voice,note.target.beat,note.noteIndex]);
const sortedNotes=notes=>[...notes].sort((a,b)=>noteKey(a).localeCompare(noteKey(b)));
function assertNotes(actual,expected){assert.deepEqual(sortedNotes(actual),sortedNotes(expected),'Every actual public note pitch/string must match the independent authored oracle');}
async function allTracks(c){if(await c.page.getByRole('combobox',{name:'Displayed tracks',exact:true}).inputValue()!=='all')await c.viewWrite('display all authored staves',async()=>{await showDisplayControls(c.page);await c.page.getByRole('combobox',{name:'Displayed tracks',exact:true}).selectOption('all');},{trackView:{kind:'all'}});await c.stable();}
async function inspector(c){await c.deps.ui.revealInspector(c.page);await c.button('Edit');}
async function ordinary(c,note){
  const selectedString=Math.max(1,note.string??(await c.currentView()).selectedString),selectedNoteIndex=note.noteIndex??null;
  let point;const expected={target:note.target,selectedNoteIndex,selectedString};
  // Move to a distinct literal target first when the desired view is already current,
  // so every asserted ordinary click has its own native acknowledgement.
  const current=await c.currentView();if(JSON.stringify(current.target)===JSON.stringify(note.target)&&current.selectedNoteIndex===selectedNoteIndex){const other=c.oracle.notes.find(row=>row.target.track===note.target.track&&row.target.staff===note.target.staff&&row.target.voice===note.target.voice&&row.target.bar!==note.target.bar);assert.ok(other);await c.action('Seed distinct ordinary point in same lane',()=>c.click(other),{viewKeys:['target','selectedString','selectedNoteIndex']});}
  await c.action('Ordinary pointer → exact native target',async()=>{
    await c.viewWrite('ordinary actual note/beat click',async()=>{point=await c.click(note);},expected);
    await inspector(c);
    assert.equal(await c.page.getByLabel('Measure',{exact:true}).inputValue(),String(note.target.bar+1));assert.equal(await c.page.getByLabel('Beat',{exact:true}).inputValue(),String(note.target.beat+1));assert.equal(await c.page.getByRole('combobox',{name:'Staff',exact:true}).inputValue(),String(note.target.staff));assert.equal(await c.page.getByRole('combobox',{name:'Voice',exact:true}).inputValue(),String(note.target.voice));
    const announcement=await c.page.locator('.score-edit-announcement').innerText();assert.ok(announcement.includes(`measure ${note.target.bar+1}, beat ${note.target.beat+1}, voice ${note.target.voice+1}`));
    const location=await c.page.getByLabel('Editing location',{exact:true}).innerText();assert.ok(location.includes(`Staff ${note.target.staff+1} · Voice ${note.target.voice+1}`));
  },{viewKeys:['target','selectedString','selectedNoteIndex']});c.step('Independent pointer receipt',{...point,expectedNativeView:expected});
}
async function preflight(c){
  await allTracks(c);await c.manual(100);assertNotes(await c.page.evaluate(readPublicNotes),c.oracle.notes);
  await c.setMode('verticalPage');await c.stable();const dom=await c.page.evaluate(readScoreLayoutDom);assert.ok(dom.pages.length>=3,'Authored fixture has fewer than three pages; revise/refreeze inputs before captures');
  const first=dom.pages[0];for(const page of dom.pages){assert.ok(Math.abs(page.width-first.width)<=1/dom.devicePixelRatio);assert.ok(Math.abs(page.height-first.height)<=1/dom.devicePixelRatio);}
  assert.equal(dom.scrollHosts,1);assert.equal(dom.derivedSvgs,dom.chunkCount);assert.equal(dom.fontsStatus,'loaded');
  const integrity=await c.page.evaluate(()=>{
    const store=window.__scoreLayoutAcceptance,roots=[...document.querySelectorAll('.score-svg-chunk > svg')];
    const canonical=root=>{
      const copy=root.cloneNode(true);for(const element of copy.querySelectorAll('.at-highlight'))if(store.highlights.some(row=>row.generation===store.generation&&row.kind==='highlight'&&row.groupId&&element.classList.contains(row.groupId)))element.classList.remove('at-highlight');
      const node=value=>value.nodeType===3?['text',value.textContent]:value.nodeType===1?[value.localName,[...value.attributes].filter(a=>a.name!=='class'||a.value.trim()).map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0])),[...value.childNodes].map(node).filter(Boolean)]:null;return JSON.stringify(node(copy));
    };
    const matches=store.chunks.map(chunk=>{if(chunk.generation!==store.generation)throw Error('Stale chunk');const signature=canonical(new DOMParser().parseFromString(chunk.svg,'image/svg+xml').documentElement),found=roots.filter(svg=>canonical(svg)===signature);if(found.length!==1)throw Error('Incomplete or ambiguous SVG content association');return {chunkId:chunk.id,first:chunk.firstMasterBarIndex,last:chunk.lastMasterBarIndex,text:found[0].textContent};});
    const staging=document.querySelector('.score-source-staging');if(!staging||!staging.hasAttribute('inert')||staging.getAttribute('aria-hidden')!=='true'||staging.clientWidth<=0)throw Error('Invalid noninteractive source staging');
    return {matches,sourceWidth:staging.clientWidth,sourceHeight:staging.getBoundingClientRect().height,sourceOverflow:getComputedStyle(staging).overflow,fonts:[...new Set(roots.flatMap(svg=>[...svg.querySelectorAll('text')].map(node=>getComputedStyle(node).fontFamily)))],svgOverflow:[...new Set(roots.map(svg=>getComputedStyle(svg).overflow))]};
  });
  const content=integrity.matches.map(row=>row.text).join(' ');for(const text of [...c.oracle.leadingText,...c.oracle.trailingText])assert.ok(content.includes(text),`Missing authored content: ${text}`);assert.equal(integrity.sourceHeight,0);assert.ok(integrity.fonts.length);assert.ok(integrity.svgOverflow.every(value=>value==='visible'),'Copied notation must preserve SVG overflow');
  c.step('Three-page complete authored content preflight',{dom,integrity});
}
async function blankHit(c,layout){
  if(!modes.slice(0,3).includes(layout))return;
  const first=c.page.locator('.score-sheet').first();await first.scrollIntoViewIfNeeded();await c.published();const box=await first.boundingBox();assert.ok(box);
  await c.action('Physical blank margin is no hit',async()=>{const before=await c.currentView();await c.page.mouse.click(box.x+3,box.y+3);await c.stable();assert.deepEqual(await c.currentView(),before);},{resizeOnly:true});
  const pages=await c.page.evaluate(readScoreLayoutDom);const a=pages.pages[0],b=pages.pages[1];const point=layout==='horizontalPage'||layout==='grid'&&Math.abs(a.y-b.y)<1?{x:a.x+a.width+12,y:a.y+10}:{x:a.x+10,y:a.y+a.height+12};
  const host=pages.host;if(point.x>host.x&&point.x<host.x+host.width&&point.y>host.y&&point.y<host.y+host.height)await c.action('Physical gutter is no hit',()=>c.page.mouse.click(point.x,point.y),{resizeOnly:true});
  else{await c.page.locator('.paper-scroll').evaluate((node,point)=>{const r=node.getBoundingClientRect();node.scrollBy(point.x-r.left-node.clientWidth/2,point.y-r.top-node.clientHeight/2);},point);await c.published();const moved=await c.page.evaluate(readScoreLayoutDom),x=point.x-(moved.host.scrollLeft-host.scrollLeft),y=point.y-(moved.host.scrollTop-host.scrollTop);await c.action('Scrolled physical gutter is no hit',()=>c.page.mouse.click(x,y),{resizeOnly:true});}
}
async function pointerGroup(c){
  const samples=c.oracle.notes.filter(note=>[2,3,8,9,23].includes(note.target.bar)&&note.target.beat===0&&!(note.target.bar===2&&note.target.voice===1));
  for(const layout of modes){await c.setMode(layout);await c.manual(100);await inspector(c);
    for(const note of samples)await ordinary(c,note);
    for(const voice of [0,1]){const note=c.oracle.notes.find(row=>row.target.track===0&&row.target.bar===2&&row.target.beat===0&&row.target.voice===voice);await c.page.getByRole('combobox',{name:'Voice',exact:true}).selectOption(String(voice));await c.stable();await ordinary(c,note);}
    // Seed another staff: the coincident guitar note has no matching current lane,
    // so the independently authored lowest voice is the deterministic fallback.
    await ordinary(c,c.oracle.notes.find(row=>row.target.track===1&&row.target.staff===1&&row.target.bar===1&&row.target.voice===1));await ordinary(c,c.oracle.notes.find(row=>row.target.track===0&&row.target.bar===2&&row.target.beat===0&&row.target.voice===0));
    await ordinary(c,{...c.oracle.rests.find(row=>row.target.track===0&&row.target.staff===0&&row.target.voice===0),noteIndex:null});
    for(const empty of c.oracle.emptyBeats??[])await ordinary(c,{...empty,noteIndex:null});
    await blankHit(c,layout);
  }
}
async function drag(c,origin,destination,{handle}={}){
  let start;
  if(handle){const node=c.page.getByRole('button',{name:`Resize selection ${handle}`,exact:true});await node.scrollIntoViewIfNeeded();await c.published();const r=await node.boundingBox();assert.ok(r);start={x:r.x+r.width/2,y:r.y+r.height/2};}
  else start=(await c.point(origin,0)).point;
  await c.page.mouse.move(start.x,start.y);await c.page.mouse.down();
  try{const end=await c.point(destination,0);await c.page.mouse.move(end.point.x,end.point.y,{steps:16});}finally{await c.page.mouse.up();}
  await c.published();
}
async function gesture(c,entry,{reverse=false,key='Control'}={}){
  await inspector(c);const clear=c.page.getByRole('button',{name:'Clear selection',exact:true});if(await clear.isEnabled())await clear.click();await c.stable();
  const click=target=>c.click({target,noteIndex:0});
  const shift=async(origin,target)=>{await click(origin);await c.page.keyboard.down('Shift');try{await click(target);}finally{await c.page.keyboard.up('Shift');}};
  switch(entry.name){
    case 'shiftRange':await shift(entry.origin,entry.target);break;
    case 'toggleNotes':await c.page.keyboard.down(key);try{await click(entry.origin);await click(entry.target);}finally{await c.page.keyboard.up(key);}break;
    case 'tripleTrack':await c.click({target:entry.origin,noteIndex:0},{clickCount:3});break;
    case 'crossPageDrag':await drag(c,reverse?entry.target:entry.origin,reverse?entry.origin:entry.target);break;
    case 'resizeStart':case 'resizeEnd':{const seed=c.oracle.gestureCases.find(row=>row.name==='shiftRange');await shift(seed.origin,seed.target);await drag(c,entry.origin,entry.target,{handle:entry.name==='resizeStart'?'start':'end'});break;}
    default:throw Error(`Unimplemented frozen gesture ${entry.name}`);
  }
}
async function proveRange(c,entry,options){
  const before=await c.snapshot(),offset=(await c.evidence()).calls.length;await gesture(c,entry,options);await c.stable();assertScoreLayoutWindow('view-only',before,await c.snapshot(),successfulCalls((await c.evidence()).calls.slice(offset)));
  const notesBefore=await c.page.evaluate(readPublicNotes);assertNotes(notesBefore,c.oracle.notes);const editsAt=(await c.evidence()).calls.length;
  await c.page.getByLabel('Semitones',{exact:true}).fill('1');await c.button('Transpose selection');await c.published();await c.nativeReady();
  const edit=await c.poll(async()=>{await c.stable();return (await c.evidence()).calls.slice(editsAt).find(row=>row.command==='apply_edit'&&row.settled&&row.ok);},Boolean,'acknowledged actual UI selection edit');
  assert.equal(edit.payload.document.documentId,before.owner.documentId);assert.equal(edit.payload.command.type,'transposeSelection');assert.equal(edit.payload.command.semitones,1);assert.deepEqual(edit.payload.command.selection,entry.expectedSelection,'Exact full native selection endpoints/enumeration');
  const edited=await c.record();assert.deepEqual(edit.result,edited);assert.deepEqual(edited.snapshot.project.edits.at(-1).selection,entry.expectedSelection);
  const affected=new Set(entry.expectedAffectedNotes.map(noteKey)),expected=c.oracle.notes.map(row=>({...row,key:row.key+(affected.has(noteKey(row))?1:0)}));assert.ok(affected.size>0);assertNotes(await c.page.evaluate(readPublicNotes),expected);
  await c.button('Undo');await c.published();await c.nativeReady();assertNotes(await c.page.evaluate(readPublicNotes),c.oracle.notes);
  const after=await c.snapshot(),calls=successfulCalls((await c.evidence()).calls.slice(offset));assertScoreLayoutWindow('range-proof',before,after,calls,{selectionVerified:true,changedNotesVerified:true,undoMusicVerified:true});assert.equal(after.record.snapshot.canRedo,true);
  c.step('Disposable native selection/edit/Undo proof',{gesture:entry.name,options,expectedSelection:entry.expectedSelection,affectedNotes:entry.expectedAffectedNotes,edit:{documentId:edit.result.documentId,revision:edit.result.revision,command:edit.payload.command},beforeRevision:before.record.revision,afterRevision:after.record.revision,afterCanRedo:after.record.snapshot.canRedo,beforeGeneration:before.native.generation,afterGeneration:after.native.generation,claim:'music restored; revision/redo/preparation intentionally not a view-only baseline'});
}
async function gestureGroup(c){
  for(const entry of c.oracle.gestureCases){await c.start(`disposable-${entry.name}`,c.state.casePaths.main);await allTracks(c);await preflight(c);
    for(const layout of modes){await c.setMode(layout);await c.manual(50);await proveRange(c,entry,{});if(entry.name==='crossPageDrag')await proveRange(c,entry,{reverse:true});if(entry.name==='toggleNotes')await proveRange(c,entry,{key:'Meta'});}
    await c.close();
  }
}

function assertArrangement(dom,layout){
  assert.equal(dom.scrollHosts,1);assert.ok(dom.pages.length>=3);const tolerance=1/dom.devicePixelRatio;
  const first=dom.pages[0];for(const page of dom.pages){assert.ok(Math.abs(page.width-first.width)<=tolerance);assert.ok(Math.abs(page.height-first.height)<=tolerance);}
  for(let i=1;i<dom.pages.length;i++){
    const before=dom.pages[i-1],page=dom.pages[i];
    if(layout==='verticalPage'){assert.ok(Math.abs(page.x-first.x)<=tolerance);assert.ok(Math.abs(page.y-before.y-before.height-24)<=tolerance);}
    else if(layout==='horizontalPage'){assert.ok(Math.abs(page.y-first.y)<=tolerance);assert.ok(Math.abs(page.x-before.x-before.width-24)<=tolerance);}
    else if(Math.abs(page.y-before.y)<=tolerance)assert.ok(Math.abs(page.x-before.x-before.width-24)<=tolerance);
    else{assert.ok(Math.abs(page.x-first.x)<=tolerance);assert.ok(Math.abs(page.y-before.y-before.height-24)<=tolerance);}
  }
  if(layout==='grid'){const columns=Math.max(1,Math.floor((dom.host.clientWidth-dom.host.paddingLeft-dom.host.paddingRight+24)/(first.width+24)));assert.equal(dom.pages.filter(page=>Math.abs(page.y-first.y)<=tolerance).length,Math.min(columns,dom.pages.length));}
  assert.ok(dom.host.scrollWidth<=Math.max(dom.host.clientWidth,...dom.pages.map(page=>page.x-first.x+page.width+dom.host.paddingLeft+dom.host.paddingRight))+2,'Hidden source staging enlarged horizontal scroll extent');
}
export function assertScoreLayoutReactiveFit({layout,policy,natural,dom,actualPercent,manualPercent,activePolicy,target}){
  const available={width:dom.host.clientWidth-dom.host.paddingLeft-dom.host.paddingRight,height:dom.host.clientHeight-dom.host.paddingTop-dom.host.paddingBottom};
  assert.ok(natural.width>0&&natural.height>0&&available.width>0&&available.height>0);
  const raw=policy==='fitPage'?Math.min(available.width/natural.width,available.height/natural.height):layout==='verticalScreen'?Math.min(1,available.width/natural.width):available.width/natural.width;
  const expected=Math.min(300,Math.max(25,raw*100)),tolerance=1.1/dom.devicePixelRatio;
  assert.equal(manualPercent,'137.5','Retained manual zoom');assert.equal(activePolicy,policy,'Active fit policy');
  assert.ok(Number.isFinite(actualPercent)&&Math.abs(actualPercent-expected)<=.11+100/(dom.devicePixelRatio*natural.width),`Fit percent ${actualPercent} differs from independent full-target ${expected}`);
  const close=(actual,wanted)=>assert.ok(Math.abs(actual-wanted)<=tolerance,`Complete target geometry ${actual} differs from ${wanted}`);
  if(modes.slice(0,3).includes(layout)){close(target.width,natural.width*expected/100);close(target.height,natural.height*expected/100);}
  else{
    assert.ok(Math.abs(target.publicScale-expected/100)<1e-6,'Complete target geometry has stale public render scale');
    close(target.width,layout==='parchment'?natural.width*expected/100:available.width);
    assert.ok(target.contentWidth>0&&target.contentHeight>0,'Missing complete target geometry');
    close(target.contentWidth,target.svgWidth);close(target.contentHeight,target.svgHeight);
    if(layout==='verticalScreen')assert.ok(target.contentWidth<=Math.max(available.width,natural.contentWidth*expected/100)+tolerance,'Reflowed complete target geometry exceeds independent fit bound');
    else close(target.contentWidth,natural.contentWidth*expected/100);
    assert.ok(target.height+ tolerance>=target.contentHeight,'Complete target geometry is clipped');
  }
  return expected;
}
async function fitMath(c,layout,policy,natural){
  const dom=await c.page.evaluate(readScoreLayoutDom),available={width:dom.host.clientWidth-dom.host.paddingLeft-dom.host.paddingRight,height:dom.host.clientHeight-dom.host.paddingTop-dom.host.paddingBottom};
  const actualText=await c.page.locator('[aria-label="Actual zoom"]').innerText(),actual=Number(actualText.match(/([\d.]+)%/)?.[1]),target=modes.slice(0,3).includes(layout)?dom.pages[0]:await naturalTarget(c,layout);
  const expected=assertScoreLayoutReactiveFit({layout,policy,natural,dom,actualPercent:actual,manualPercent:await c.page.getByLabel('Zoom (%)',{exact:true}).inputValue(),activePolicy:(await c.currentView()).scoreDisplay.zoomMode,target});
  assert.equal(await c.page.getByRole('button',{name:policy==='fitWidth'?'Fit width':'Fit page',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await c.page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'137.5');
  const raw=policy==='fitPage'?Math.min(available.width/natural.width,available.height/natural.height):layout==='verticalScreen'?Math.min(1,available.width/natural.width):available.width/natural.width;
  if(raw*100<25||raw*100>300){const bound=raw*100<25?25:300;assert.equal(await c.page.getByRole('status').filter({hasText:`Fit is limited to ${bound}%. Scroll to view the full score.`}).count(),1);}
  c.step('Independent full target fit geometry',{layout,policy,natural,available,rawPercent:raw*100,expectedPercent:expected,actualPercent:actual,toleranceDevicePixels:1.1,target,dom});return expected;
}
async function naturalTarget(c,layout){
  const dom=await c.page.evaluate(readScoreLayoutDom);if(modes.slice(0,3).includes(layout))return {width:dom.pages[0].width,height:dom.pages[0].height};
  return c.page.evaluate(()=>{const store=window.__scoreLayoutAcceptance,live=document.querySelector('.score-live-paper'),source=document.querySelector('[data-testid="score-source"]');if(!live||!source)throw Error('Missing live paper');const r=live.getBoundingClientRect(),origin=source.getBoundingClientRect(),svgs=[...source.querySelectorAll('svg')].map(svg=>svg.getBoundingClientRect());if(!svgs.length||svgs.length!==store.chunks.length)throw Error('Incomplete current SVG target');return {width:r.width,height:r.height,contentWidth:Math.max(...store.chunks.map(chunk=>chunk.x+chunk.width)),contentHeight:Math.max(...store.chunks.map(chunk=>chunk.y+chunk.height)),svgWidth:Math.max(...svgs.map(svg=>svg.right-origin.left)),svgHeight:Math.max(...svgs.map(svg=>svg.bottom-origin.top)),publicScale:store.publicApi.settings.display.scale};});
}
/** Windows 610px tall or less fold the score display row into one "Score display" button (THE-196); open it before touching a display control. Not run: this driver needs a reviewed build admission. */
async function showDisplayControls(page){const toggle=page.getByRole('button',{name:'Score display',exact:true});if(await toggle.count()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();}
async function pane(c,name,checked){
  const summary=c.page.locator('summary').filter({hasText:/^View$/});if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();await c.page.getByRole('checkbox',{name,exact:true}).setChecked(checked);await summary.click();
}
async function measuredResizeFit(c,layout,resizes,reset){
  const binding=await c.fitBinding(),measurements=new Map();
  const key=async()=>{
    assert.deepEqual(await c.fitBinding(),binding,'Fit base score/tracks/profile binding changed');
    const {host}=await c.page.evaluate(readScoreLayoutDom);
    return JSON.stringify([layout,binding,...['clientWidth','clientHeight','paddingLeft','paddingRight','paddingTop','paddingBottom'].map(name=>host[name])]);
  };
  const measure=async()=>{
    assert.equal(await c.page.getByLabel('Zoom (%)',{exact:true}).inputValue(),'100');assert.equal((await c.currentView()).scoreDisplay?.zoomMode??'manual','manual');
    const natural=await naturalTarget(c,layout);if(layout==='verticalScreen'||layout==='horizontalScreen')natural.width=Math.max(natural.width,natural.contentWidth);
    const identity=await key();if(measurements.has(identity))assert.deepEqual(natural,measurements.get(identity),'Independent repeated base measurement differs');else measurements.set(identity,Object.freeze(natural));
    c.step('Independent manual-100 fit base',{layout,binding,geometryKey:identity,natural});
  };
  await c.action('Measure fit bases at manual 100%',()=>c.manual(100),{viewKeys:['zoom','scoreDisplay']});
  await c.action('Initial host for fit premeasurement',reset,{resizeOnly:true});await measure();
  for(const [name,work]of resizes){await c.action(`Premeasure: ${name}`,work,{resizeOnly:true});await measure();}
  await c.action('Restore initial measured host',reset,{resizeOnly:true});await measure();
  const frozen=async()=>{const identity=await key();assert.ok(measurements.has(identity),'No independent base measurement for current fit host');return measurements.get(identity);};
  await c.action('Retain fractional manual 137.5%',()=>c.manual(137.5),{viewKeys:['zoom','scoreDisplay']});await c.action('Fit width',()=>c.fit('fitWidth'),{viewKeys:['scoreDisplay']});const fitted=await fitMath(c,layout,'fitWidth',await frozen());
  let policy='fitWidth';if(modes.slice(0,3).includes(layout)){policy='fitPage';await c.action('Fit whole physical page',()=>c.fit(policy),{viewKeys:['scoreDisplay']});await fitMath(c,layout,policy,await frozen());}
  for(const [name,work]of resizes){await c.action(name,work,{resizeOnly:true});await fitMath(c,layout,policy,await frozen());}
  return fitted;
}
export async function initialScoreLayoutFitChecks(c,layout){
  const resizes=[
    ['Host narrow resize',()=>c.page.setViewportSize({width:1024,height:600})],['Host wide resize',()=>c.page.setViewportSize({width:1600,height:1000})],
    ['Hide left pane',()=>pane(c,'Track panel',false)],['Show left pane',()=>pane(c,'Track panel',true)],['Hide inspector',()=>pane(c,'Inspector',false)],['Show inspector',()=>pane(c,'Inspector',true)],
    ['Expand bottom dock',()=>c.deps.ui.revealDock(c.page,'Overview')],['Hide bottom dock',()=>pane(c,'Bottom dock',false)]
  ];
  return measuredResizeFit(c,layout,resizes,async()=>{await c.page.setViewportSize({width:1600,height:1000});await pane(c,'Track panel',true);await pane(c,'Inspector',true);await pane(c,'Bottom dock',false);});
}
export async function confirmationScoreLayoutFitChecks(c,pair){
  const reset=()=>c.page.setViewportSize({width:pair.width,height:pair.height});
  return measuredResizeFit(c,pair.layout,[['Affected host resize confirmation',()=>c.page.setViewportSize({width:pair.width+16,height:pair.height})],['Restore affected host size',reset]],reset);
}
async function viewGroup(c){
  await c.start('clean-view-only',c.state.casePaths.main);await allTracks(c);await preflight(c);let physicalMembership;
  for(const layout of modes){const began=performance.now();await c.action(`Select ${layout}`,()=>c.setMode(layout),{viewKeys:['scoreDisplay']});
    for(const zoom of [25,137.5,300,100]){await c.action(`Manual ${zoom}%`,()=>c.manual(zoom),{viewKeys:['zoom','scoreDisplay']});const dom=await c.page.evaluate(readScoreLayoutDom);
      if(modes.slice(0,3).includes(layout)){assertArrangement(dom,layout);const membership=dom.pages.map(page=>page.chunks);if(physicalMembership)assert.deepEqual(membership,physicalMembership,'View magnification/arrangement must preserve physical membership');else physicalMembership=membership;}
    }
    const fitted=await initialScoreLayoutFitChecks(c,layout);if(layout==='horizontalScreen')assert.equal(fitted,25,'Long authored strip must exercise actual lower fit limit');
    if(!modes.slice(0,3).includes(layout)){const fit=c.page.getByRole('button',{name:'Fit page',exact:true});assert.equal(await fit.isDisabled(),true);const descriptions=await fit.getAttribute('aria-describedby');assert.ok(descriptions);assert.equal(await c.page.locator(`[id=${JSON.stringify(descriptions)}]`).innerText(),'Fit page is available in page layouts.');}
    if(layout==='grid'){await c.action('Grid 25%',()=>c.manual(25),{viewKeys:['zoom','scoreDisplay']});const wide=await c.page.evaluate(readScoreLayoutDom);assertArrangement(wide,'grid');await c.action('Grid narrow columns',()=>c.page.setViewportSize({width:1024,height:600}),{resizeOnly:true});const narrow=await c.page.evaluate(readScoreLayoutDom);assertArrangement(narrow,'grid');assert.notEqual(narrow.pages.filter(page=>Math.abs(page.y-narrow.pages[0].y)<1).length,wide.pages.filter(page=>Math.abs(page.y-wide.pages[0].y)<1).length,'Host resize must exercise actual grid column change');await c.action('Restore wide host',()=>c.page.setViewportSize({width:1600,height:1000}),{resizeOnly:true});}
    c.result.performance.push({phase:c.phase,operation:'warm-layout-cycle',layout,elapsedMs:performance.now()-began,...await c.page.evaluate(readScoreLayoutDom)});
  }
  await pointerGroup(c);await pausedGroup(c);await c.close();
}
async function variantGroup(c){
  await c.start('immutable-oversize',c.state.casePaths.oversize);await allTracks(c);await c.manual(137.5);await c.setMode('verticalPage');await c.stable();const before=await c.snapshot();
  const error=c.page.locator('.score-page-error[role="alert"]');await error.waitFor();const text=await error.innerText();assert.ok(text.includes('Continuous view is shown at 137.5%'));assert.match(text,/fewer staves.*larger page.*print scale/i);assert.equal(await c.page.locator('.score-sheet').count(),0);assert.equal(await c.page.locator('.score-live-paper').count(),1);assert.equal(await c.page.getByRole('button',{name:'Fit page',exact:true}).isDisabled(),true);assert.equal((await c.currentView()).scoreDisplay.layout,'verticalPage');
  const described=await c.page.getByRole('button',{name:'Fit page',exact:true}).getAttribute('aria-describedby');assert.ok(described);assert.ok((await c.page.locator(`[id=${JSON.stringify(described)}]`).innerText()).length>0);
  // Root-authorized disposable settings proof. Main 297mm/all-tracks has already
  // passed physical preflight; print edits are excluded from view-only windows.
  const editOffset=(await c.evidence()).calls.length;await inspector(c);await c.button('Presentation');const summary=c.page.locator('summary').filter({hasText:/^Page layout$/});if(!await summary.evaluate(node=>node.parentElement.open))await summary.click();
  assert.equal(await c.page.getByLabel('Height (mm)',{exact:true}).inputValue(),'50');await c.page.getByLabel('Height (mm)',{exact:true}).fill('297');await c.button('Apply page layout');await c.published();await c.nativeReady();
  const edit=await c.poll(async()=>{await c.stable();return (await c.evidence()).calls.slice(editOffset).find(row=>row.command==='apply_edit'&&row.settled&&row.ok);},Boolean,'acknowledged UI paper retry');
  assert.deepEqual(edit.payload.command,{type:'setPageLayout',layout:{...c.oracle.oversizePage,heightMm:297}});assert.deepEqual(edit.result,await c.record());assert.equal(await error.count(),0,'Previously feasible paper height must restore physical presentation');assert.ok(await c.page.locator('.score-sheet').count()>0);assert.equal(await c.page.getByRole('button',{name:'Fit page',exact:true}).isEnabled(),true);assert.equal((await c.currentView()).scoreDisplay.layout,'verticalPage');assertNotes(await c.page.evaluate(readPublicNotes),c.oracle.notes);
  await c.button('Undo');await c.published();await c.nativeReady();const after=await c.snapshot();assert.deepEqual(after.record.snapshot.project,before.record.snapshot.project);assert.ok(after.record.revision>before.record.revision);assert.equal(after.record.snapshot.canRedo,true);assertNotes(await c.page.evaluate(readPublicNotes),c.oracle.notes);await error.waitFor();assert.equal(await c.page.getByLabel('Height (mm)',{exact:true}).inputValue(),'50');
  c.step('Disposable paper retry and actual Undo',{text,edit:{documentId:edit.result.documentId,revision:edit.result.revision,command:edit.payload.command},beforeRevision:before.record.revision,afterRevision:after.record.revision,beforeGeneration:before.native.generation,afterGeneration:after.native.generation,afterCanRedo:true,claim:'Music and original print settings restored; not a view-only baseline'});await c.close();
  if(c.state.casePaths.upperLimit===null)c.result.pendingGates.push({gate:'actual 300% fit-limit',reason:c.oracle.upperLimitPending??'No admitted content-fitting upper-limit variant'});
  else{await c.start('immutable-upper-limit',c.state.casePaths.upperLimit);await allTracks(c);await c.setMode('verticalPage');await c.manual(100);const natural=await naturalTarget(c,'verticalPage');await c.manual(137.5);await c.fit('fitWidth');assert.equal(await fitMath(c,'verticalPage','fitWidth',natural),300);await c.close();}
}

function readPausedCursor({target,ratio}){
  const store=window.__scoreLayoutAcceptance,api=store.publicApi,beat=api.score.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice].beats[target.beat];
  if(store.generation!==store.completedGeneration)throw Error('Cursor generation unfinished');
  const bounds=api.boundsLookup.findBeats(beat).find(row=>row.beat===beat),master=bounds.barBounds.masterBarBounds,system=master.staffSystemBounds;
  const next=beat.voice.beats[beat.index+1],nextBounds=next?api.boundsLookup.findBeats(next)?.find(row=>row.beat===next):null;
  const end=nextBounds&&nextBounds.barBounds.masterBarBounds.staffSystemBounds===system?nextBounds.onNotesX:bounds.realBounds.x+bounds.realBounds.w;
  const sourceX=bounds.onNotesX+(end-bounds.onNotesX)*ratio;
  const chunks=store.chunks.filter(row=>row.generation===store.generation&&row.firstMasterBarIndex<=target.bar&&row.lastMasterBarIndex>=target.bar);if(chunks.length!==1)throw Error('Cursor chunk ambiguous');const chunk=chunks[0];
  const canonical=root=>{const copy=root.cloneNode(true);for(const element of copy.querySelectorAll('.at-highlight'))if(store.highlights.some(row=>row.generation===store.generation&&row.kind==='highlight'&&row.groupId&&element.classList.contains(row.groupId)))element.classList.remove('at-highlight');const node=value=>value.nodeType===3?['text',value.textContent]:value.nodeType===1?[value.localName,[...value.attributes].filter(a=>a.name!=='class'||a.value.trim()).map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0])),[...value.childNodes].map(node).filter(Boolean)]:null;return JSON.stringify(node(copy));};
  const signature=canonical(new DOMParser().parseFromString(chunk.svg,'image/svg+xml').documentElement),physical=[...document.querySelectorAll('.score-svg-chunk > svg')],roots=physical.length?physical:[...document.querySelectorAll('.score-live-paper [data-testid="score-source"] svg')];
  const found=roots.filter(node=>!node.closest('[aria-hidden="true"],[inert]')&&node.getClientRects().length&&canonical(node)===signature);if(found.length!==1)throw Error('Cursor SVG association ambiguous');const svg=found[0],matrix=svg.getScreenCTM();if(!matrix)throw Error('Missing cursor oracle SVG CTM');
  const map=(x,y)=>({x:matrix.a*(x-chunk.x)+matrix.c*(y-chunk.y)+matrix.e,y:matrix.b*(x-chunk.x)+matrix.d*(y-chunk.y)+matrix.f});
  const expected=map(sourceX,master.visualBounds.y),barStart=map(master.visualBounds.x,master.visualBounds.y),barEnd=map(master.visualBounds.x+master.visualBounds.w,master.visualBounds.y+master.visualBounds.h);
  const rectangle=element=>{if(!element||element.hidden||!element.getClientRects().length)throw Error('Current visible cursor missing');const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const actualBeat=rectangle(document.querySelector(physical.length?'.score-playback-beat':'.score-live-paper .at-cursor-beat')),actualBar=rectangle(document.querySelector(physical.length?'.score-playback-bar':'.score-live-paper .at-cursor-bar'));
  const active=new Map();for(const row of store.highlights.filter(row=>row.generation===store.generation)){if(row.kind==='remove')active.clear();else active.set(row.groupId,row.masterBarIndex);}
  const highlights=[...active].map(([id,bar])=>{const source=[...document.querySelector('[data-testid="score-source"]').getElementsByClassName(id)],derived=physical.flatMap(svg=>[...svg.getElementsByClassName(id)]);return {id,bar,source:source.length,sourceHighlighted:source.filter(node=>node.classList.contains('at-highlight')).length,derived:derived.length,derivedHighlighted:derived.filter(node=>node.classList.contains('at-highlight')).length};});
  return {generation:store.generation,physical:!!physical.length,expected,expectedBar:{x:barStart.x,y:barStart.y,width:barEnd.x-barStart.x,height:barEnd.y-barStart.y},actualBeat,actualBar,highlights,devicePixelRatio};
}
function assertCursor(value){const tolerance=2/value.devicePixelRatio;assert.ok(Math.abs(value.actualBeat.x-value.expected.x)<=tolerance);assert.ok(Math.abs(value.actualBeat.y-value.expected.y)<=tolerance);for(const key of ['x','y','width','height'])assert.ok(Math.abs(value.actualBar[key]-value.expectedBar[key])<=tolerance,`Visible bar cursor ${key}`);assert.ok(value.highlights.length>0,'No observed opaque highlight group');for(const row of value.highlights){assert.ok(row.source>0);assert.equal(row.sourceHighlighted,row.source);if(value.physical){assert.ok(row.derived>0);assert.equal(row.derivedHighlighted,row.derived);}}}
async function pausedGroup(c){
  const secondsPerTick=1/1920;assert.ok(c.oracle.seekCases.every(row=>Math.abs(row.seconds-row.tick*secondsPerTick)<1e-6),'Literal seek oracle must have authored 120 BPM / 960 PPQ');
  const seeks=c.oracle.seekCases.flatMap(seek=>{if(seek.occurrence===0)return [seek];const first=c.oracle.occurrences.find(row=>row.bar===seek.target.bar&&row.occurrence===0),current=c.oracle.occurrences.find(row=>row.bar===seek.target.bar&&row.occurrence===seek.occurrence);assert.ok(first&&current);const delta=current.startTick-first.startTick;return [{...seek,tick:seek.tick-delta,seconds:seek.seconds-delta*secondsPerTick,occurrence:0,expectedProvenance:'literal-oracle-derived'},seek];});
  for(const layout of modes){await c.action('Stationary clock layout change',()=>c.setMode(layout),{viewKeys:['scoreDisplay']});await c.action('Stationary clock manual setup',()=>c.manual(100),{viewKeys:['zoom','scoreDisplay']});
    for(const seek of seeks){const owner=(await c.workspace()).active,before=await c.nativeReady(),callsAt=(await c.evidence()).calls.length;
      await c.invoke('audio_command',{owner,command:{type:'seekTick',tick:seek.tick,generation:before.generation}});
      const status=await c.poll(()=>c.nativeReady(),value=>value.tick===seek.tick&&Math.abs(value.seconds-seek.seconds)<1e-6,'exact paused tick/time');assert.deepEqual((await c.workspace()).active,owner);await c.published();
      const occurrence=c.oracle.occurrences.find(row=>row.bar===seek.target.bar&&row.occurrence===seek.occurrence);assert.ok(occurrence);assert.equal(occurrence.bar,seek.target.bar);assert.ok(seek.tick>occurrence.startTick&&seek.tick<occurrence.endTick);const ratio=(seek.tick-occurrence.startTick-seek.target.beat*960)/960;assert.ok(ratio>0&&ratio<1,'Authored seek must lie inside the beat');
      const cursor=await c.page.evaluate(readPausedCursor,{target:seek.target,ratio});assertCursor(cursor);
      const dom=await c.page.evaluate(readScoreLayoutDom),bar=cursor.actualBar;assert.ok(bar.x+bar.width>dom.host.x&&bar.x<dom.host.x+dom.host.width&&bar.y+bar.height>dom.host.y&&bar.y<dom.host.y+dom.host.height,'Native seek reveals in the same host on both axes');
      const calls=successfulCalls((await c.evidence()).calls.slice(callsAt));assert.equal(calls.filter(row=>row.command==='audio_command').length,1);assert.ok(!calls.some(row=>['audio_prepare','audio_set_mix','apply_edit'].includes(row.command)));
      await c.action('Stationary seek survives manual rerender',()=>c.manual(137.5),{viewKeys:['zoom','scoreDisplay']});assertCursor(await c.page.evaluate(readPausedCursor,{target:seek.target,ratio}));await c.action('Stationary seek returns manual 100',()=>c.manual(100),{viewKeys:['zoom','scoreDisplay']});
      c.step('Paused native seek and public cursor/highlight oracle',{layout,target:seek.target,occurrence:seek.occurrence,expectedProvenance:seek.expectedProvenance??'authored literal seek case',ratio,status:nativeInvariant(status),cursor,scroll:{left:dom.host.scrollLeft,top:dom.host.scrollTop}});
    }
  }
  const active=c.documentId,other=(await c.workspace()).documents.find(row=>row.documentId!==active);assert.ok(other,'Fresh session must retain the initial old document for remount check');
  const refs=await c.page.evaluateHandle(()=>({score:window.__scoreLayoutAcceptance.publicApi.score,nodes:[...document.querySelectorAll('.score-svg-chunk > svg,.score-playback-beat,.score-playback-bar')]}));
  try{await activate(c,other.documentId);assert.equal(await refs.evaluate(ref=>ref.nodes.every(node=>!node.isConnected)&&ref.score!==window.__scoreLayoutAcceptance.publicApi.score),true,'Old document refs must not paint current score');await activate(c,active);await c.nativeReady();c.step('Actual document remount releases old painted DOM',{oldNodesDisconnected:true,playing:false});}finally{await refs.dispose();}
}
async function activate(c,id){c.owned();await c.page.locator(`[id=${JSON.stringify(`document-tab-${encodeURIComponent(id)}`)}]`).click();await c.idle();c.documentId=id;assert.equal((await c.workspace()).active.documentId,id);await c.published();await c.nativeReady();}
async function recoveryGroup(c){
  await c.start('recovery-old-new',c.state.casePaths.main);const main=c.documentId,old=(await c.workspace()).documents.find(row=>row.documentId!==main);assert.ok(old,'Expected initial untouched old document');
  await activate(c,old.documentId);assert.equal(await c.page.getByRole('combobox',{name:'Display mode',exact:true}).inputValue(),'parchment');assert.equal((await c.currentView()).scoreDisplay,undefined);await c.action('Old omitted preference survives derived host resize',()=>c.page.setViewportSize({width:1024,height:600}),{resizeOnly:true});assert.equal((await c.currentView()).scoreDisplay,undefined);
  await activate(c,main);await c.page.setViewportSize({width:1600,height:1000});await allTracks(c);await c.manual(137.5);await c.setMode('grid');await c.fit('fitPage');const selected=c.oracle.notes.find(row=>row.target.track===1&&row.target.staff===1&&row.target.bar===9&&row.target.voice===1);await ordinary(c,selected);await c.stable();
  const views=new Map();for(const id of [old.documentId,main]){await activate(c,id);views.set(id,await c.currentView());}await activate(c,main);
  const before=await c.workspace(),checkpoint=await c.poll(()=>c.checkpoint(),value=>[...views].every(([id,view])=>JSON.stringify(value.envelope.documents.find(row=>row.documentId===id)?.view)===JSON.stringify(view)),'both exact acknowledged per-document views');
  assert.equal(checkpoint.envelope.documents.find(row=>row.documentId===old.documentId).view.scoreDisplay,undefined);assert.equal(checkpoint.envelope.documents.find(row=>row.documentId===main).view.zoom,137.5);const sessionDirectory=c.nativeDirectory;
  c.step('Stable manifest/payload before exact owned restart',{checkpoint:checkpoint.receipt,documents:checkpoint.envelope.documents.map(row=>({documentId:row.documentId,view:row.view,sessionSha256:hash(JSON.stringify(row.session))}))});await c.close({crash:true});
  await c.start('recovery-restored',c.state.casePaths.main,{sessionDirectory,restore:true});const after=await c.workspace();assert.deepEqual(after.documents,before.documents,'Recovery preserves complete project/history/revision/dirty/redo');assert.equal(after.active.documentId,main);assert.notEqual(after.active.activationId,before.active.activationId);
  for(const [id,view]of views){await activate(c,id);const layout=view.scoreDisplay?.layout??'parchment';assert.equal(await c.page.getByRole('combobox',{name:'Display mode',exact:true}).inputValue(),layout);assert.equal(await c.page.getByLabel('Zoom (%)',{exact:true}).inputValue(),String(view.zoom));if(view.scoreDisplay?.zoomMode==='fitPage')assert.equal(await c.page.getByRole('button',{name:'Fit page',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await c.page.getByLabel('Measure',{exact:true}).inputValue(),String(view.target.bar+1));assert.equal((await c.nativeReady()).playing,false);}
  const restored=await c.poll(()=>c.checkpoint(),value=>[...views].every(([id,view])=>JSON.stringify(value.envelope.documents.find(row=>row.documentId===id)?.view)===JSON.stringify(view)),'restored durable view checkpoint');
  for(const row of checkpoint.envelope.documents){const found=restored.envelope.documents.find(value=>value.documentId===row.documentId);assert.deepEqual(found.view,row.view);assert.deepEqual(found.session,row.session,'Exact recovery .session history/saved/cursor record');}
  c.step('Actual Restore retains independent views and sessions',{before:checkpoint.receipt,after:restored.receipt,views:[...views].map(([documentId,view])=>({documentId,view})),noAutoplay:true});await c.close();
}
async function captures(c,planned){
  await c.start(c.result.scope==='initial'?'initial-twelve-frames':'combined-confirmation',c.state.casePaths.main);await allTracks(c);await preflight(c);await pane(c,'Track panel',true);await pane(c,'Inspector',true);await pane(c,'Bottom dock',false);
  const known=c.oracle.seekCases[0];
  for(const pair of planned){assertScoreLayoutCapture(planned,c.result.screenshots,pair);await c.page.setViewportSize({width:pair.width,height:pair.height});await c.setMode(pair.layout);await c.manual(100);
    const status=await c.nativeReady(),owner=(await c.workspace()).active;if(status.tick!==known.tick)await c.invoke('audio_command',{owner,command:{type:'seekTick',tick:known.tick,generation:status.generation}});await c.poll(()=>c.nativeReady(),value=>value.tick===known.tick&&Math.abs(value.seconds-known.seconds)<1e-6,'capture paused clock');await c.stable();
    const dom=await c.page.evaluate(readScoreLayoutDom);assert.equal(dom.innerWidth,pair.width);assert.equal(dom.innerHeight,pair.height);assert.equal(dom.generation,dom.completedGeneration);assert.equal(dom.fontsStatus,'loaded');if(modes.slice(0,3).includes(pair.layout))assertArrangement(dom,pair.layout);else assert.equal(dom.pages.length,0);
    const path=resolve(c.result.runDirectory,`${String(c.result.screenshots.length+1).padStart(2,'0')}-${pair.layout}-${pair.width}x${pair.height}.png`);assert.equal(existsSync(path),false);c.owned();
    if(c.result.scope==='initial'){
      if(c.result.screenshots.length===0)c.result.initialCapture=reserveScoreLayoutInitialCapture(initialCapturePath,c.result);
      assert.deepEqual(assertScoreLayoutInitialBinding(initialCapturePath,c.result,c.result.resultPath),c.result.initialCapture);
    }
    await c.page.screenshot({path,fullPage:false});c.healthy();c.result.screenshots.push({...pair,path,sha256:hash(readFileSync(path)),generation:dom.generation,dom,pausedTick:known.tick,arrangement:modes.slice(0,3).includes(pair.layout)?pair.layout:'continuous'});
  }
  assert.equal(c.result.screenshots.length,planned.length);await c.close();
}

async function confirmationChecks(c,planned,contracts){
  for(const [index,pair]of planned.entries()){
    await c.start(`disposable-confirmation-${index+1}`,c.state.casePaths.main);await allTracks(c);await preflight(c);await c.page.setViewportSize({width:pair.width,height:pair.height});await c.setMode(pair.layout);await c.manual(100);
    if(contracts.includes('presentation')){const dom=await c.page.evaluate(readScoreLayoutDom);assert.equal(dom.innerWidth,pair.width);assert.equal(dom.innerHeight,pair.height);if(modes.slice(0,3).includes(pair.layout))assertArrangement(dom,pair.layout);else assert.equal(dom.pages.length,0);c.step('Affected presentation confirmation',{pair,dom});}
    if(contracts.includes('fit'))await confirmationScoreLayoutFitChecks(c,pair);
    if(contracts.includes('pointer')){await c.manual(100);for(const note of c.oracle.notes.filter(row=>[2,3,9].includes(row.target.bar)&&row.target.beat===0&&row.target.voice===0))await ordinary(c,note);for(const entry of c.oracle.gestureCases)await proveRange(c,entry,{});}
    c.step('Affected contracts completed',{pair,contracts,fullOldGatesRerun:false});await c.close();
  }
}

export async function runScoreLayoutAcceptance({statePath,confirmVisual=false}={}){
  validateScoreLayoutArguments([confirmVisual?'--confirm-visual':'--run',`--state=${statePath??''}`]);assert.equal(process.platform,'win32');assert.ok(equalPath(realpathSync(process.cwd()),realpathSync(repository)),'Use the authoritative worktree');
  if(!confirmVisual)assertScoreLayoutInitialAvailable(initialCapturePath);
  // Runtime dependencies and all side effects begin only at the explicit run entry.
  const [fixture,observer,ui,harness,child,net]=await Promise.all([import('./score-layout-fixture.mjs'),import('./score-layout-observer.mjs'),import('./workstation-commands.mjs'),import('./harness.mjs'),import('node:child_process'),import('node:net')]);
  const bytes=readFileSync(statePath),state=JSON.parse(bytes);fixture.assertScoreLayoutFixture(state,statePath);const admission=json(state.admissionPath);fixture.assertScoreLayoutAdmission(admission);
  let initial,initialCapture,corrections,contracts,consumptionPath,consumed=false;if(confirmVisual){assert.ok(state.confirmation);assert.equal(hash(readFileSync(state.confirmation.initialReceiptPath)),state.confirmation.initialReceiptSha256);assert.equal(hash(readFileSync(state.confirmation.correctionPacketPath)),state.confirmation.correctionPacketSha256);initial=json(state.confirmation.initialReceiptPath);initialCapture=assertScoreLayoutInitialBinding(initialCapturePath,initial,state.confirmation.initialReceiptPath);assert.deepEqual(initial.initialCapture,initialCapture);corrections=json(state.confirmation.correctionPacketPath);contracts=validateScoreLayoutCorrections(corrections);consumptionPath=resolve(repository,'.analysis/desktop-smoke/score-layout-confirmation-runtime.json');consumed=existsSync(consumptionPath);}
  const planned=validateScoreLayoutRun(state,confirmVisual,{initial,consumed}),runDirectory=mkdtempSync(resolve(state.outputs,'run-'));assert.ok(fixture.contained(state.outputs,runDirectory));
  const result={format:'TabPlayerScoreLayoutReceipt',version:1,status:'running',scope:confirmVisual?'confirmation':'initial',statePath,stateSha256:hash(bytes),ownershipId:state.ownershipId,sourceHashes:state.sourceHashes,buildSourceSha256:state.buildSourceSha256,admissionSha256:state.admissionSha256,runDirectory,launches:[],steps:[],screenshots:[],transportFallbacks:[],pageErrors:[],performance:[],cleanup:[],limits:[...state.limits,'Paused seeks only; no Play/device/listening/recording.','Passing driver assertions do not establish root ink acceptance, GP8 equivalence, other OS, installer, or full parity.'],pendingGates:[{gate:'actual ink',reason:'Root must inspect the bounded new frames together'},{gate:'running clock and stale queued callbacks',reason:'Not synthesized by desktop driver; accepted producer source-bound tests are separate evidence',sourceHashes:state.sourceHashes},{gate:'representative private-song performance',reason:'No separately authorized private specimen supplied'}]};
  result.resultPath=resolve(runDirectory,'result.json');const c=new Context(state,admission,result,{fixture,observer,ui,connect:harness.connect,execFileSync:child.execFileSync,createServer:net.createServer});c.oracle=json(state.oraclePath);if(!c.oracle.emptyBeats?.length)result.pendingGates.push({gate:'actual empty beat hit',reason:c.oracle.emptyBeatPending});
  let failure;
  try{
    if(confirmVisual){writeFileSync(consumptionPath,JSON.stringify({ownershipId:state.ownershipId,stateSha256:result.stateSha256,runDirectory,initialCapture,initialReceiptSha256:state.confirmation.initialReceiptSha256,correctionPacketSha256:state.confirmation.correctionPacketSha256,affectedPairs:planned}),{flag:'wx'});result.confirmation={...state.confirmation,initialCapture,corrections:corrections.corrections,contracts,consumptionPath};await confirmationChecks(c,planned,contracts);await captures(c,planned);}
    else{await gestureGroup(c);await viewGroup(c);await variantGroup(c);await recoveryGroup(c);await captures(c,planned);}
    c.healthy();
  }catch(error){failure=error;c.step('Acceptance failed',{message:String(error)});}
  finally{
    try{await c.close();fixture.assertScoreLayoutFixture(state,statePath);fixture.assertScoreLayoutAdmission(admission);assert.equal(hash(readFileSync(statePath)),result.stateSha256);assert.equal(hash(readFileSync(state.admissionPath)),result.admissionSha256);if(result.initialCapture)assert.deepEqual(assertScoreLayoutInitialBinding(initialCapturePath,result,result.resultPath),result.initialCapture);if(initialCapture)assert.deepEqual(assertScoreLayoutInitialBinding(initialCapturePath,initial,state.confirmation.initialReceiptPath),initialCapture);c.healthy();result.integrity={sourceInputsAdmissionExecutableResourcesUnchanged:true};}
    catch(error){failure??=error;c.step('Cleanup/integrity failure',{message:String(error)});}
    result.status=failure?'failed':'passed';result.resultPath=resolve(runDirectory,'result.json');writeFileSync(result.resultPath,JSON.stringify(result,null,2),{flag:'wx'});
  }
  if(failure){failure.scoreLayoutReceipt=result;throw failure;}return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options=validateScoreLayoutArguments(process.argv.slice(2));if(options.mode==='help')console.log('Inert desktop acceptance. Root only: --run --state=<absolute admitted state> OR --confirm-visual --state=<absolute confirmation state>. Import/default/help do not prepare, launch, connect, capture or clean up.');
  else console.log(JSON.stringify(await runScoreLayoutAcceptance({statePath:options.statePath,confirmVisual:options.mode==='confirm'}),null,2));
}
