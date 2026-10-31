import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';

const source=new URL('./parity-score-layouts.mjs',import.meta.url);
const driver=existsSync(source)?await import(source.href):{};
function contract(name){assert.equal(typeof driver[name],'function',`Missing driver contract ${name}`);return driver[name];}
const identity={pid:42,path:'C:/owned/tabplayer.exe',startTicks:'638990000000000000'};
const matrix=['verticalPage','horizontalPage','grid','parchment','verticalScreen','horizontalScreen'].flatMap(layout=>[{layout,width:1600,height:1000},{layout,width:1024,height:600}]);

test('defaultAndHelpAreInert',()=>{
  const parse=contract('validateScoreLayoutArguments');
  assert.deepEqual(parse([]),{mode:'help'});assert.deepEqual(parse(['--help']),{mode:'help'});
  assert.deepEqual(parse(['--run','--state=C:/owned/state.json']),{mode:'run',statePath:'C:/owned/state.json'});
  for(const args of [['--run'],['--help','--run'],['--run','--state=relative.json'],['--run','--state=C:/a','--state=C:/b'],['--run','--confirm-visual','--state=C:/a'],['--wat']])assert.throws(()=>parse(args));
  const text=readFileSync(source,'utf8');assert.doesNotMatch(text,/^import .*from ['"]\.\/(?:harness|score-layout-fixture|score-layout-observer)/m,'Runtime dependency imports must be lazy');
});
test('rejectsUnadmittedOrSecondConfirmation',()=>{
  const admit=contract('validateScoreLayoutRun');
  const state={format:'TabPlayerScoreLayoutAcceptance',version:1,authored:true,ownershipId:'owned',admissionSha256:'a'.repeat(64),buildSourceSha256:'b'.repeat(64)};
  assert.throws(()=>admit({},false));assert.deepEqual(admit(state,false),matrix);
  const initial={format:'TabPlayerScoreLayoutReceipt',version:1,scope:'initial',screenshots:matrix,status:'passed'};
  const confirmed={...state,confirmation:{attempt:1,initialReceiptSha256:'c'.repeat(64),correctionPacketSha256:'d'.repeat(64),affectedPairs:[matrix[2]]}};
  assert.throws(()=>admit(confirmed,true,{initial,consumed:true}));
  assert.throws(()=>admit(confirmed,true,{initial:{...initial,scope:'confirmation'},consumed:false}));
  assert.deepEqual(admit(confirmed,true,{initial,consumed:false}),[matrix[2]]);
  assert.throws(()=>admit({...confirmed,confirmation:{...confirmed.confirmation,affectedPairs:[matrix[2],matrix[2]]}},true,{initial,consumed:false}));
});
test('captureMatrixIsExactly12',()=>{
  const budget=contract('assertScoreLayoutCapture');let captured=[];
  for(const pair of matrix){budget(matrix,captured,pair);captured.push(pair);}
  assert.equal(captured.length,12);assert.throws(()=>budget(matrix,captured,matrix[0]));
  assert.throws(()=>budget(matrix,[],{layout:'grid',width:1280,height:900}));
  assert.throws(()=>budget(matrix,[matrix[1]],matrix[0]),/order/i);
});
test('ownedCleanupRequiresPidPathAndStartTicks',()=>{
  const check=contract('assertOwnedScoreLayoutProcess');check(identity,{...identity,path:'c:\\owned\\TABPLAYER.exe'});
  for(const delta of [{pid:43},{path:'C:/other/tabplayer.exe'},{startTicks:'638990000000000001'}])assert.throws(()=>check(identity,{...identity,...delta}),/identity/i);
  assert.throws(()=>check(identity,null));assert.throws(()=>check({...identity,startTicks:''},identity));
});
test('rangeProofDoesNotClaimViewOnlyBaseline',()=>{
  const check=contract('assertScoreLayoutWindow');const before={record:{revision:1,snapshot:{project:{edits:[]},dirty:false,canRedo:false}},native:{playing:false,generation:2,tick:0},owner:{documentId:'a',activationId:'x'}};
  const after=structuredClone(before);after.record.revision=3;after.record.snapshot.canRedo=true;
  assert.throws(()=>check('view-only',before,after,[{command:'apply_edit',acknowledged:true}]));
  assert.throws(()=>check('view-only',before,before,[{command:'audio_command',acknowledged:true}]));
  check('view-only',before,structuredClone(before),[]);
  assert.throws(()=>check('range-proof',before,after,[],{}));
  check('range-proof',before,after,[{command:'apply_edit',acknowledged:true}],{selectionVerified:true,changedNotesVerified:true,undoMusicVerified:true});
});
function scene({duplicate=false,stale=false,hidden=false}={}){
  const dom=new JSDOM('<div class="paper-scroll"><div class="score-presentation"><div class="score-svg-chunk"><svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><path d="M1 2"/></svg></div></div></div>');
  const {window}=dom;const svg=window.document.querySelector('svg'),wrapper=svg.parentElement;
  if(duplicate)wrapper.after(wrapper.cloneNode(true));if(hidden)wrapper.setAttribute('aria-hidden','true');
  for(const node of window.document.querySelectorAll('*')){node.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:500,bottom:500,width:500,height:500});node.getClientRects=()=>[node.getBoundingClientRect()];Object.defineProperty(node,'clientWidth',{value:500});Object.defineProperty(node,'clientHeight',{value:500});}
  for(const node of window.document.querySelectorAll('svg'))node.getScreenCTM=()=>({a:2,b:0,c:0,d:2,e:10,f:20});
  const note={};const beat={notes:[note]};note.beat=beat;
  const system={realBounds:{x:0,y:20,w:100,h:80},bars:[{index:0}]};
  const api={score:{tracks:[{staves:[{bars:[{voices:[{beats:[beat]}]}]}]}]},boundsLookup:{staffSystems:[system],findBeats:()=>[{beat,notes:[{note,noteHeadBounds:{x:20,y:40,w:10,h:10}}],barBounds:{masterBarBounds:{staffSystemBounds:system}}}]}};
  window.__scoreLayoutAcceptance={publicApi:api,capable:true,generation:2,completedGeneration:stale?1:2,chunks:[{generation:2,id:'chunk',x:0,y:20,width:100,height:80,firstMasterBarIndex:0,lastMasterBarIndex:0,svg:svg.outerHTML}],highlights:[]};
  return dom;
}
test('duplicateSvgAssociationRejectsPointer',()=>{
  const point=contract('readScoreLayoutNotePoint');const target={track:0,staff:0,bar:0,voice:0,beat:0};
  for(const opts of [{duplicate:true},{stale:true},{hidden:true},{}]){
    const dom=scene(opts);const previous={window:globalThis.window,document:globalThis.document,getComputedStyle:globalThis.getComputedStyle,DOMParser:globalThis.DOMParser};
    Object.assign(globalThis,{window:dom.window,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),DOMParser:dom.window.DOMParser});
    try{const execute=(0,eval)(`(${point.toString()})`);if(Object.keys(opts).length)assert.throws(()=>execute({target,noteIndex:0}));else{const value=execute({target,noteIndex:0});assert.deepEqual(value.point,{x:60,y:70});assert.equal(value.chunkId,'chunk');assert.equal(value.generation,2);assert.deepEqual(value.target,target);}}
    finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}dom.window.close();}
  }
});

test('publicSvgPixelDimensionsAreAccepted',()=>{
  const read=contract('readScoreLayoutNotePoint'),dom=scene(),previous={window:globalThis.window,document:globalThis.document,getComputedStyle:globalThis.getComputedStyle,DOMParser:globalThis.DOMParser};
  const svg=dom.window.document.querySelector('svg');svg.setAttribute('width','100px');svg.setAttribute('height','80px');dom.window.__scoreLayoutAcceptance.chunks[0].svg=svg.outerHTML;
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),DOMParser:dom.window.DOMParser});
  try{assert.deepEqual(read({target:{track:0,staff:0,bar:0,voice:0,beat:0},noteIndex:0}).point,{x:60,y:70});}
  finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}dom.window.close();}
});

test('confirmationRejectsUnimplementedContracts',()=>{
  const validate=contract('validateScoreLayoutCorrections');
  assert.deepEqual(validate({corrections:[{description:'Clipped note marker',contracts:['pointer']},{description:'Fit rounding',contracts:['fit','presentation']}]}),['presentation','fit','pointer']);
  for(const packet of [{},{corrections:[]},{corrections:[{description:'',contracts:['fit']}]},{corrections:[{description:'Unbounded',contracts:['recovery']}]},{corrections:[{description:'Missing discriminator',contracts:[]}]},{corrections:[{description:'Unexpected',contracts:['fit'],extra:true}]}])assert.throws(()=>validate(packet));
});

test('ownedListenerRejectsForeignAncestryAndProfilePrefix',()=>{
  const check=contract('assertScoreLayoutListener');const profile='C:/owned/profile';
  const rows=[{owner:84,chain:[{pid:84,parent:42,commandLine:'webview.exe --user-data-dir="C:\\owned\\profile" --remote-debugging-port=9223'},{pid:42,parent:1,commandLine:'tabplayer.exe'}]}];
  check(identity,profile,rows);
  assert.throws(()=>check(identity,profile,[{...rows[0],chain:rows[0].chain.slice(0,1)}]));
  assert.throws(()=>check(identity,profile,[{...rows[0],chain:rows[0].chain.map(row=>({...row,commandLine:row.commandLine.replace('profile"','profile-other"')}))}]));
  assert.throws(()=>check(identity,profile,[]));
});


test('pointerRequiresPublicSystemBarInterval',()=>{
  const read=contract('readScoreLayoutNotePoint'),dom=scene(),previous={window:globalThis.window,document:globalThis.document,getComputedStyle:globalThis.getComputedStyle,DOMParser:globalThis.DOMParser};
  dom.window.__scoreLayoutAcceptance.publicApi.boundsLookup.staffSystems[0].bars=[];
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),DOMParser:dom.window.DOMParser});
  try{assert.throws(()=>read({target:{track:0,staff:0,bar:0,voice:0,beat:0},noteIndex:0}),/system|interval/i);}
  finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}dom.window.close();}
});


test('initialCaptureReservationSurvivesFailureAndRepeatedEntry',()=>{
  const available=contract('assertScoreLayoutInitialAvailable'),reserve=contract('reserveScoreLayoutInitialCapture'),bind=contract('assertScoreLayoutInitialBinding');
  const root=mkdtempSync(resolve(tmpdir(),'score-layout-capture-contract-')),path=resolve(root,'score-layout-initial-runtime.json');
  const result={scope:'initial',ownershipId:'owned-a',statePath:resolve(root,'state.json'),stateSha256:'a'.repeat(64),runDirectory:resolve(root,'run-a'),resultPath:resolve(root,'run-a/result.json'),admissionSha256:'b'.repeat(64),buildSourceSha256:'c'.repeat(64)};
  // A failed capability/functional attempt never reaches reserve, so it leaves
  // no consumed visual allowance and another pre-capture entry is permitted.
  available(path);available(path);assert.equal(existsSync(path),false);
  const receipt=reserve(path,result),bytes=readFileSync(path);assert.equal(receipt.path,path);assert.equal(receipt.sha256,createHash('sha256').update(bytes).digest('hex'));
  // Model the first screenshot rejecting: no frame/result array update occurs.
  assert.throws(()=>available(path),/initial.*(?:reserved|consumed)/i);
  assert.throws(()=>reserve(path,{...result,ownershipId:'owned-b',runDirectory:resolve(root,'run-b')}));assert.deepEqual(readFileSync(path),bytes);
  bind(path,result,result.resultPath);
  for(const key of ['ownershipId','statePath','stateSha256','runDirectory','resultPath','admissionSha256','buildSourceSha256'])assert.throws(()=>bind(path,{...result,[key]:'foreign'},result.resultPath),/initial|identity/i);
  assert.throws(()=>bind(path,result,resolve(root,'unrelated-result.json')),/initial|identity/i);
  assert.equal(JSON.parse(readFileSync(path)).ownershipId,result.ownershipId);
});

test('rejectedProbeDisposesThroughActualDriverCloseBeforeTeardown',async()=>{
  const DriverContext=contract('ScoreLayoutContext');const observer=await import('./score-layout-observer.mjs');
  const directory=mkdtempSync(resolve(tmpdir(),'score-layout-probe-contract-')),executable=resolve(directory,'inert-executable.txt');writeFileSync(executable,'inert');
  for(const cleanupFails of [false,true]){
    const events=[],original=async()=>new Response(JSON.stringify({ready:false,playing:false,generation:0,desiredGeneration:0,tick:0,seconds:0,error:null}),{headers:{'Tauri-Response':'ok'}});
    const prior=Object.getOwnPropertyDescriptor(globalThis,'window');const fake={fetch:original};fake.__TAURI_INTERNALS__={convertFileSrc:command=>`ipc://${command}`,invoke:async command=>{const response=await fake.fetch(`ipc://${command}`,{method:'POST',body:'{}'});return {...await response.json(),tick:1};}};
    Object.defineProperty(globalThis,'window',{value:fake,configurable:true,writable:true});
    const result={steps:[],cleanup:[],transportFallbacks:[],pageErrors:[]},deps={observer:{...observer,disposeScoreLayoutObservers:()=>{events.push('dispose');const disposed=observer.disposeScoreLayoutObservers();assert.equal(fake.fetch,original);return cleanupFails?{...disposed,restored:false}:disposed;}}};
    const c=new DriverContext({}, {executable,executableSha256:createHash('sha256').update('inert').digest('hex')},result,deps);c.identity={...identity};c.page={evaluate:async fn=>fn(),off:()=>{}};c.browser={close:async()=>events.push('disconnect')};let live=true;c.inspect=()=>live?identity:null;c.ps=()=>{events.push('terminate');assert.equal(fake.fetch,original,'Restore must precede exact process teardown');live=false;return '';};
    let primary;
    try{try{await c.installObservers();assert.fail('Probe mismatch must fail');}catch(error){primary=error;}assert.match(primary.message,/probe failed/);assert.notEqual(fake.fetch,original);if(cleanupFails)await assert.rejects(()=>c.close({crash:true}));else await c.close({crash:true});assert.match(primary.message,/probe failed/);assert.deepEqual(events,['dispose','terminate','disconnect']);assert.equal(c.identity,null);assert.equal(c.observersInstalled,false);}
    finally{if(prior)Object.defineProperty(globalThis,'window',prior);else delete globalThis.window;}
  }
});

test('reactiveFitRejectsOldScaleAndGeometryAfterHostShrink',()=>{
  const check=contract('assertScoreLayoutReactiveFit');
  const dom={devicePixelRatio:1,host:{clientWidth:800,clientHeight:600,paddingLeft:0,paddingRight:0,paddingTop:0,paddingBottom:0,scrollWidth:800,scrollHeight:600}};
  const input={layout:'verticalPage',policy:'fitWidth',natural:{width:1000,height:700},dom,actualPercent:80,manualPercent:'137.5',activePolicy:'fitWidth',target:{width:800,height:560}};
  assert.equal(check(input),80);
  const shrunken={...dom,host:{...dom.host,clientWidth:400,scrollWidth:400}};
  assert.throws(()=>check({...input,dom:shrunken}),/Fit percent/);
  assert.throws(()=>check({...input,dom:shrunken,actualPercent:40}),/target geometry/);
  assert.equal(check({...input,dom:shrunken,actualPercent:40,target:{width:400,height:280}}),40);
  assert.throws(()=>check({...input,manualPercent:'80'}),/manual/i);
  assert.throws(()=>check({...input,activePolicy:'manual'}),/policy/i);
  for(const layout of ['parchment','verticalScreen','horizontalScreen']){
    const live={...input,layout,natural:{width:1000,height:700,contentWidth:1000,contentHeight:700},target:{width:800,height:600,contentWidth:800,contentHeight:560,svgWidth:800,svgHeight:560,publicScale:.8}};
    assert.equal(check(live),80);assert.throws(()=>check({...live,target:{...live.target,publicScale:1}}),/stale public render scale/);
    assert.throws(()=>check({...live,target:{...live.target,svgWidth:600}}),/target geometry/);
    assert.throws(()=>check({...live,target:{...live.target,height:500}}),/clipped/);
  }
});
function fakeFitContext(stale){
  const state={width:1600,height:1000,left:true,right:true,dock:false,manual:100,policy:'manual',scale:1},events=[];
  const size=()=>({width:state.width-(state.left?220:0)-(state.right?272:0),height:state.height-200-(state.dock?240:0)});
  const percent=()=>{const available=size();return Math.max(25,Math.min(300,100*(state.policy==='fitPage'?Math.min(available.width/1000,available.height/1400):available.width/1000)));};
  const update=label=>{events.push({kind:'resize',label,policy:state.policy});if(state.policy!=='manual'&&!stale)state.scale=percent()/100;};
  const dom=()=>{const s=size();return {innerWidth:state.width,innerHeight:state.height,devicePixelRatio:1,host:{clientWidth:s.width,clientHeight:s.height,paddingLeft:0,paddingRight:0,paddingTop:0,paddingBottom:0,scrollWidth:Math.max(s.width,1000*state.scale),scrollHeight:Math.max(s.height,1400*state.scale)},pages:[{width:1000*state.scale,height:1400*state.scale}]};};
  const c={events,state,fitBinding:async()=>({documentId:'d',revision:1,projectSha256:'a',trackView:{kind:'all'},profile:3}),currentView:async()=>({zoom:state.manual,scoreDisplay:{layout:'verticalPage',zoomMode:state.policy}}),step:(action,value)=>events.push({kind:'step',action,value}),action:async(name,work)=>{events.push({kind:'action',name});await work();},manual:async value=>{events.push({kind:'manual',value});state.manual=value;state.policy='manual';state.scale=value/100;},fit:async policy=>{events.push({kind:'fit',policy});state.policy=policy;state.scale=percent()/100;}};
  c.page={setViewportSize:async value=>{Object.assign(state,value);update('viewport');},evaluate:async()=>dom(),getByLabel:()=>({inputValue:async()=>String(state.manual)}),getByRole:(role,{name}={})=>role==='checkbox'?{setChecked:async value=>{state[name==='Track panel'?'left':name==='Inspector'?'right':'dock']=value;update(name);}}:role==='status'?{filter:()=>({count:async()=>1})}:{getAttribute:async()=>String((name==='Fit page'?'fitPage':'fitWidth')===state.policy),isDisabled:async()=>false},locator:selector=>selector==='[aria-label="Actual zoom"]'?{innerText:async()=>`Actual zoom: ${state.scale*100}%`}:{filter:()=>({evaluate:async()=>false,click:async()=>{}})}};
  c.deps={ui:{revealDock:async()=>{state.dock=true;update('dock');}}};return c;
}
test('initialAndConfirmationResizePathsAssertBeforeAnyManualRefit',async()=>{
  const initial=contract('initialScoreLayoutFitChecks'),confirmation=contract('confirmationScoreLayoutFitChecks');
  for(const [name,run,count]of [['initial',c=>initial(c,'verticalPage'),8],['confirmation',c=>confirmation(c,{layout:'verticalPage',width:1024,height:1000}),2]]){
    const stale=fakeFitContext(true);await assert.rejects(()=>run(stale),/Fit percent|target geometry/,`${name} must catch stale resize fit`);
    const lastFit=stale.events.findLastIndex(row=>row.kind==='fit'),after=stale.events.slice(lastFit+1);assert.ok(after.some(row=>row.kind==='resize'));assert.ok(!after.some(row=>row.kind==='manual'||row.kind==='fit'),'No repair before the failing resize assertion');
    const current=fakeFitContext(false);await run(current);const start=current.events.findLastIndex(row=>row.kind==='fit'),tail=current.events.slice(start+1);assert.ok(!tail.some(row=>row.kind==='manual'||row.kind==='fit'));assert.equal(tail.filter(row=>row.kind==='step'&&row.action==='Independent full target fit geometry').length,count+1);
  }
});
