import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
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
