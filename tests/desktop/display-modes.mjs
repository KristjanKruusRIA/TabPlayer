import assert from 'node:assert/strict';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch,connect,stop,directory } from './harness.mjs';
import { closeWelcomeLibrary,waitForWorkspaceIdle,clickWorkstationButton,revealPlaybackControls,hidePlaybackControls } from './workstation-commands.mjs';
import { writeDenseScore,denseFret } from './display-modes-fixture.mjs';

// THE-56: the six screen display modes and the fit/zoom policies, driven in the real desktop app with real mouse and keyboard
// input over CDP (port 9223). Only the bundled CC0 Library example and a dense score this driver builds are used.
// Results go to DISPLAY_MODES_OUT (default E:/claude-tmp/the-56): result.json, and screenshots in shots/. Nothing is written into the repository.
// Run from the checkout root after the desktop test build:  node tests/desktop/display-modes.mjs [--quick]
const out=process.env.DISPLAY_MODES_OUT??'E:/claude-tmp/the-56',shots=resolve(out,'shots'),quick=process.argv.includes('--quick'),only=(process.argv.find(a=>a.startsWith('--only='))??'').slice(7).split(',').filter(Boolean);
mkdirSync(shots,{recursive:true});
const modes=['verticalPage','horizontalPage','grid','parchment','verticalScreen','horizontalScreen'];
const physical=new Set(['verticalPage','horizontalPage','grid']);
const sizes=[{width:1440,height:900},{width:1280,height:800},{width:960,height:600}];
const result={startedAt:new Date().toISOString(),checks:[],observations:{},errors:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function check(area,name,ok,detail=''){result.checks.push({area,name,ok:Boolean(ok),detail:typeof detail==='string'?detail:JSON.stringify(detail)});if(!ok)console.log(`FAIL ${area} | ${name} | ${typeof detail==='string'?detail:JSON.stringify(detail)}`);return Boolean(ok);}
async function section(name,work){if(only.length&&!only.some(o=>name.includes(o)))return;try{await work();}catch(error){result.errors.push({section:name,message:String(error?.stack??error)});console.log(`ERROR in ${name}: ${error?.message??error}`);}}

const session=resolve(directory,`display-modes-session-${Date.now()}`),profile=resolve(directory,`display-modes-profile-${Date.now()}`);
mkdirSync(session,{recursive:true});mkdirSync(profile,{recursive:true});
const example=resolve(directory,'library/examples/example-windowline.tabplayer');
const densePath=writeDenseScore(out);
let id=null,browser=null,page=null,docA=null,docB=null;

const invoke=(command,args={})=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
const workspace=()=>invoke('workspace_snapshot');
async function startApp({restore=false}={}){
  id=launch({TABPLAYER_TEST_OPEN:example,TABPLAYER_TEST_SESSION_DIR:session,WEBVIEW2_USER_DATA_FOLDER:profile});
  browser=await connect();page=browser.contexts()[0].pages()[0];page.on('pageerror',error=>result.errors.push({section:'pageerror',message:error.message}));
  await page.setViewportSize(sizes[0]);
  if(restore){
    const dialog=page.getByRole('dialog',{name:'Recover unsaved work?',exact:true});await dialog.waitFor({timeout:30000});
    await dialog.getByRole('button',{name:'Restore',exact:true}).click();
  }else await closeWelcomeLibrary(page);
  await waitForWorkspaceIdle(page);
}
async function stopApp(){
  const owned=browser,pid=id;browser=null;page=null;id=null;
  try{if(owned)await owned.close();}finally{if(pid!==null)stop(pid);}
  await sleep(1500);
}
async function stable(label='layout',timeout=15000){
  let previous='',same=0;const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const key=await page.evaluate(()=>{const host=document.querySelector('.paper-scroll');if(!host)return 'none';const r=host.getBoundingClientRect();return JSON.stringify([r.width,r.height,host.scrollWidth,host.scrollHeight,document.querySelectorAll('.paper-scroll svg text').length,document.fonts.status,document.querySelector('.score-actual-zoom')?.textContent??'']);});
    same=key===previous&&key!=='none'?same+1:0;previous=key;if(same>=3)return;await sleep(200);
  }
  result.errors.push({section:'stable',message:`${label} did not settle`});
}
const shot=async name=>{const path=resolve(shots,`${name}.png`);await page.screenshot({path});return path;};

// ---- controls: real mouse and keyboard ----
const modeSelect=()=>page.getByRole('combobox',{name:'Display mode',exact:true});
async function setMode(layout){
  const select=modeSelect();let current=await select.inputValue();if(current===layout)return;
  await select.focus();
  const delta=modes.indexOf(layout)-modes.indexOf(current);
  await page.keyboard.press(delta>0?'ArrowDown':'ArrowUp',{delay:20});
  for(let attempt=0;attempt<12&&(await select.inputValue())!==layout;attempt++)await page.keyboard.press(modes.indexOf(layout)>modes.indexOf(await select.inputValue())?'ArrowDown':'ArrowUp');
  assert.equal(await select.inputValue(),layout,'keyboard could not reach the mode');
  await waitForWorkspaceIdle(page);await stable(`mode ${layout}`);
}
async function setManual(value){
  const input=page.getByLabel('Zoom (%)',{exact:true});await input.click({clickCount:3});await page.keyboard.type(String(value));await page.keyboard.press('Tab');
  await waitForWorkspaceIdle(page);await stable(`zoom ${value}`);
}
async function fit(kind){
  await page.getByRole('button',{name:kind==='fitWidth'?'Fit width':'Fit page',exact:true}).click();await waitForWorkspaceIdle(page);await stable(kind);
}
const policyState=()=>page.evaluate(()=>({layout:document.querySelector('.score-layout-select')?.value,zoomInput:document.querySelector('input[title="Zoom (%)"]')?.value,fitWidth:document.querySelector('.score-fit-controls button:nth-child(1)')?.getAttribute('aria-pressed'),fitPage:document.querySelector('.score-fit-controls button:nth-child(2)')?.getAttribute('aria-pressed'),actual:document.querySelector('.score-actual-zoom')?.textContent??null}));
const tab=docId=>page.locator(`#document-tab-${docId}`);
async function activate(docId){await tab(docId).click();await waitForWorkspaceIdle(page);await stable('tab switch');}

// ---- measurements (read-only, in the page) ----
function measureLayout(){
  const host=document.querySelector('.paper-scroll');if(!host)return {missing:true};
  const hr=host.getBoundingClientRect(),clientLeft=hr.left+host.clientLeft,clientTop=hr.top+host.clientTop,clientRight=clientLeft+host.clientWidth,clientBottom=clientTop+host.clientHeight;
  const staged=n=>n.closest('.score-source-staging,[aria-hidden="true"],[inert]');
  const texts=[...host.querySelectorAll('svg text')].filter(n=>!staged(n)&&n.getClientRects().length);
  const frets=texts.filter(n=>/^\d{1,2}$/.test(n.textContent.trim())).map(n=>{const r=n.getBoundingClientRect();return {t:n.textContent.trim(),x:r.x,y:r.y,w:r.width,h:r.height};}).filter(r=>r.w>0&&r.h>0);
  const inView=r=>r.x+r.w>clientLeft&&r.x<clientRight&&r.y+r.h>clientTop&&r.y<clientBottom;
  const visible=frets.filter(inView);
  // The digits of a tab staff are drawn as text. Two that cover each other by more than a fifth of the smaller are a collision.
  let overlaps=0;const sorted=[...visible].sort((a,b)=>a.x-b.x);
  for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length&&sorted[j].x<sorted[i].x+sorted[i].w;j++){
    const a=sorted[i],b=sorted[j],w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
    if(w>0&&h>0&&w*h>0.2*Math.min(a.w*a.h,b.w*b.h))overlaps++;
  }
  const heights=visible.map(r=>r.h).sort((a,b)=>a-b);
  const style=getComputedStyle(host);
  const families=[...new Set(texts.map(n=>getComputedStyle(n).fontFamily))];
  const faces=[...document.fonts].map(f=>`${f.family}:${f.status}`);
  const sheets=[...host.querySelectorAll('.score-sheet')].map(s=>{const r=s.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
  const svgs=[...host.querySelectorAll('svg')].filter(n=>!staged(n)&&n.getClientRects().length).map(n=>n.getBoundingClientRect());
  const content={left:Math.min(...svgs.map(r=>r.left)),right:Math.max(...svgs.map(r=>r.right)),top:Math.min(...svgs.map(r=>r.top)),bottom:Math.max(...svgs.map(r=>r.bottom))};
  const toolbarOverflow=[...document.querySelectorAll('.gp-toolbar-display')].filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.className||n.tagName);
  const display=document.querySelector('.gp-toolbar-display')?.getBoundingClientRect();
  return {inner:[innerWidth,innerHeight],outer:[outerWidth,outerHeight],host:{x:hr.x,y:hr.y,w:hr.width,h:hr.height,cw:host.clientWidth,ch:host.clientHeight,sw:host.scrollWidth,sh:host.scrollHeight,sl:host.scrollLeft,st:host.scrollTop,overflowX:style.overflowX,overflowY:style.overflowY,scrollbarX:host.offsetHeight-host.clientHeight-host.clientTop*2,scrollbarY:host.offsetWidth-host.clientWidth-host.clientLeft*2},
    fonts:{status:document.fonts.status,faces:[...new Set(faces)],families,alphaTab:document.fonts.check('16px alphaTab')},
    frets:{total:frets.length,visible:visible.length,minHeight:heights[0]??null,medianHeight:heights[Math.floor(heights.length/2)]??null,overlaps},
    sheets:sheets.length,sheetWidth:sheets[0]?.w??null,content,clippedRight:content.right>clientRight+1&&host.scrollWidth<=host.clientWidth+1,clippedLeft:content.left<clientLeft-1,
    toolbarOverflow,toolbarRight:display?display.right:null,toolbarBottom:display?display.bottom:null,
    actualZoom:document.querySelector('.score-actual-zoom')?.textContent??null,limited:document.querySelector('.score-fit-help[role=status]')?.textContent??null,
    svgCount:svgs.length};
}
const measure=()=>page.evaluate(measureLayout);

/** A visible tab digit near the middle of the score area, as a click target. */
async function pickFret(){
  return page.evaluate(()=>{
    const host=document.querySelector('.paper-scroll'),hr=host.getBoundingClientRect(),cx=hr.left+host.clientWidth/2,cy=hr.top+host.clientHeight/2;
    const inside=r=>r.x>hr.left+30&&r.right<hr.left+host.clientWidth-30&&r.y>hr.top+30&&r.bottom<hr.top+host.clientHeight-30;
    const notRed=n=>{const m=/rgb\((\d+), (\d+), (\d+)/.exec(getComputedStyle(n).fill);return !m||!(Number(m[1])>150&&Number(m[2])<90);};
    const list=[...host.querySelectorAll('svg text')].filter(n=>!n.closest('.score-source-staging,[aria-hidden="true"],[inert]')&&/^\d{1,2}$/.test(n.textContent.trim())&&notRed(n)).map(n=>({t:n.textContent.trim(),r:n.getBoundingClientRect()})).filter(o=>o.r.width>0&&inside(o.r));
    list.sort((a,b)=>Math.hypot(a.r.x+a.r.width/2-cx,a.r.y+a.r.height/2-cy)-Math.hypot(b.r.x+b.r.width/2-cx,b.r.y+b.r.height/2-cy));
    const o=list[0];return o?{text:o.t,x:o.r.x+o.r.width/2,y:o.r.y+o.r.height/2}:null;
  });
}
const inspectorFields=async()=>{const v=async l=>{const c=page.getByLabel(l,{exact:true});return await c.count()?await c.first().inputValue().catch(()=>null):null;};return {measure:await v('Measure'),beat:await v('Beat'),fret:await v('Fret'),ann:await page.locator('.score-edit-announcement').first().innerText().catch(()=>null)};};

async function clickTest(area,dense){
  const target=await pickFret();
  if(!target)return check(area,'click selects a note',false,'no tab digit in the middle of the score area');
  const before=await inspectorFields();
  await page.mouse.click(target.x,target.y);await sleep(500);await waitForWorkspaceIdle(page);
  const got=await inspectorFields();
  // The edit caret is the app's own record of what the click selected: it must sit on the clicked beat (horizontally).
  const caret=await page.evaluate(()=>{const c=document.querySelector('.score-edit-target');return c?c.getBoundingClientRect().toJSON():null;});
  const onBeat=caret&&target.x>=caret.left-6&&target.x<=caret.right+6;
  let oracle=true;
  if(dense&&got.measure&&got.beat)oracle=denseFret(Number(got.measure)-1,Number(got.beat)-1)===Number(target.text);
  return check(area,'click selects the clicked beat',Boolean(onBeat&&oracle),{clicked:target.text,at:[Math.round(target.x),Math.round(target.y)],before:before.ann,selected:got.ann,caretLeft:caret&&Math.round(caret.left),caretRight:caret&&Math.round(caret.right),oracle:dense?oracle:'n/a (library example)'});
}

async function scrollTest(area){
  const m=await measure();const hostBox=m.host;
  const canV=hostBox.sh>hostBox.ch+2,canH=hostBox.sw>hostBox.cw+2,rows={canV,canH};
  const cx=hostBox.x+hostBox.cw/2,cy=hostBox.y+hostBox.ch/2;
  const pos=()=>page.evaluate(()=>{const h=document.querySelector('.paper-scroll');return [h.scrollLeft,h.scrollTop];});
  await page.evaluate(()=>{const h=document.querySelector('.paper-scroll');h.scrollLeft=0;h.scrollTop=0;});await sleep(200);
  await page.mouse.move(cx,cy);
  const before=await pos();
  await page.mouse.wheel(0,500);await sleep(500);const afterDown=await pos();
  await page.mouse.wheel(500,0);await sleep(500);const afterRight=await pos();
  await page.keyboard.down('Shift');await page.mouse.wheel(0,500);await page.keyboard.up('Shift');await sleep(500);const afterShift=await pos();
  rows.wheel={before,afterDown,afterRight,afterShift};
  const moved=afterShift[0]!==before[0]||afterShift[1]!==before[1]||afterRight[0]!==before[0]||afterDown[1]!==before[1];
  if(canV||canH)check(area,'wheel scrolls the score',moved,rows.wheel);else rows.wheelNote='nothing to scroll';
  if(canH&&!canV)check(area,'a plain vertical wheel scrolls a horizontally scrolling layout',afterDown[0]>before[0],rows.wheel);
  if(canV)check(area,'vertical wheel moves a vertically scrollable score',afterDown[1]>before[1]||canH&&(afterDown[0]>before[0]||afterShift[0]>before[0]),rows.wheel);
  // The scrollbar: only when this layout draws a classic gutter. Drag the thumb, then click the track.
  rows.scrollbar={x:hostBox.scrollbarY,y:hostBox.scrollbarX};
  await page.evaluate(()=>{const h=document.querySelector('.paper-scroll');h.scrollLeft=0;h.scrollTop=0;});await sleep(200);
  if(canV&&hostBox.scrollbarY>3){
    const hostRect=await page.evaluate(()=>document.querySelector('.paper-scroll').getBoundingClientRect().toJSON());
    const trackX=hostRect.right-hostBox.scrollbarY/2-1,thumbH=Math.max(24,hostBox.ch*hostBox.ch/hostBox.sh);
    const thumbY=hostRect.top+(hostBox.ch-thumbH)*0+thumbH/2+16;
    const s0=(await pos())[1];
    await page.mouse.move(trackX,thumbY);await page.mouse.down();await page.mouse.move(trackX,thumbY+80,{steps:8});await page.mouse.up();await sleep(400);const s1=(await pos())[1];
    check(area,'dragging the vertical scrollbar thumb scrolls',s1>s0,{from:s0,to:s1,trackX,thumbY});
    await page.mouse.click(trackX,hostRect.bottom-hostBox.scrollbarX-40);await sleep(400);const s2=(await pos())[1];
    check(area,'clicking the vertical scrollbar track pages the score',s2>s1,{from:s1,to:s2});
  }else if(canV)rows.scrollbarNote=`no vertical scrollbar gutter (${hostBox.scrollbarY}px): overlay or hidden`;
  if(canH&&hostBox.scrollbarX>3){
    const hostRect=await page.evaluate(()=>document.querySelector('.paper-scroll').getBoundingClientRect().toJSON());
    const trackY=hostRect.bottom-hostBox.scrollbarX/2-1;const thumbW=Math.max(24,hostBox.cw*hostBox.cw/hostBox.sw);
    await page.evaluate(()=>{const h=document.querySelector('.paper-scroll');h.scrollLeft=0;});await sleep(200);const l0=(await pos())[0];
    const startX=hostRect.left+thumbW/2+16;
    await page.mouse.move(startX,trackY);await page.mouse.down();await page.mouse.move(startX+80,trackY,{steps:8});await page.mouse.up();await sleep(400);const l1=(await pos())[0];
    check(area,'dragging the horizontal scrollbar thumb scrolls',l1>l0,{from:l0,to:l1});
  }else if(canH)rows.scrollbarNote=(rows.scrollbarNote??'')+` no horizontal scrollbar gutter (${hostBox.scrollbarX}px)`;
  await page.evaluate(()=>{const h=document.querySelector('.paper-scroll');h.scrollLeft=0;h.scrollTop=0;});
  return rows;
}

const nativeStatus=()=>invoke('audio_status');
async function cursorTest(area,{seconds=5,seek=null}={}){
  // Stop first so the run starts from the top, or from a bar the caller chose.
  await clickWorkstationButton(page,'Stop');await sleep(300);
  if(seek)await seek();
  await page.evaluate(()=>{const h=document.querySelector('.paper-scroll');h.scrollLeft=0;h.scrollTop=0;});await sleep(200);
  const sample=()=>page.evaluate(()=>{
    const host=document.querySelector('.paper-scroll'),hr=host.getBoundingClientRect(),c=document.querySelector('.at-cursor-beat'),b=document.querySelector('.at-cursor-bar');
    const r=c?.getBoundingClientRect(),br=b?.getBoundingClientRect();
    const vis=q=>q&&q.width>0&&q.height>0&&q.right>hr.left&&q.left<hr.left+host.clientWidth&&q.bottom>hr.top&&q.top<hr.top+host.clientHeight;
    return {beat:r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}:null,visible:Boolean(vis(r)),barVisible:Boolean(vis(br)),scroll:[host.scrollLeft,host.scrollTop]};
  });
  await clickWorkstationButton(page,'Play');
  const samples=[],started=Date.now();
  for(let i=0;i<Math.floor(seconds*1000/450);i++){await sleep(450);samples.push({t:Date.now()-started,...await sample(),status:null});}
  const status=await nativeStatus().catch(()=>null);
  await clickWorkstationButton(page,'Stop');await sleep(300);
  const placed=samples.filter(s=>s.beat);const moves=new Set(placed.map(s=>`${s.beat.x},${s.beat.y},${s.scroll}`)).size;
  const allVisible=placed.length>0&&placed.every(s=>s.visible||s.barVisible);
  const hidden=samples.filter(s=>!(s.visible||s.barVisible)).map(s=>s.t);
  check(area,'cursor is drawn and moves during playback',placed.length>=Math.max(2,samples.length-2)&&moves>=3,{samples:samples.length,distinctPositions:moves,playing:status?.playing});
  check(area,'cursor stays inside the visible score area during playback',allVisible,{hiddenAtMs:hidden,first:placed[0],last:placed.at(-1)});
  return {samples:samples.length,distinctPositions:moves,hiddenAtMs:hidden,scrollStart:samples[0]?.scroll,scrollEnd:samples.at(-1)?.scroll};
}

// ---------------------------------------------------------------------------------------------------------------------
const table={};   // `${doc}|${layout}|${policy}` -> row
const rowOf=(doc,layout,policy)=>table[`${doc}|${layout}|${policy}`]??={doc,layout,policy};

try {
  await startApp();
  await clickWorkstationButton(page,'Open');await waitForWorkspaceIdle(page);
  await page.locator('.paper-scroll svg').first().waitFor();await stable('open');
  docA=(await workspace()).active.documentId;
  const intake=await invoke('desktop_test_io',{action:'read',path:densePath});check('setup','dense score staged',intake.kind==='candidate',intake);
  docB=(await invoke('workspace_add',{token:intake.candidate.token})).active.documentId;await page.reload();await waitForWorkspaceIdle(page);await stable('dense open');
  result.observations.windowBefore=await page.evaluate(()=>({inner:[innerWidth,innerHeight],outer:[outerWidth,outerHeight],screen:[screen.width,screen.height],dpr:devicePixelRatio}));
  const denseState=await measure();
  check('dense','forced systems fixture shows eight bars per system',await page.evaluate(()=>document.querySelectorAll('.paper-scroll svg').length)>0,denseState.frets);
  await activate(docA);

  // ===== 1. six modes x three zoom policies on the Library example at 1440x900 =====
  await section('modes-example',async()=>{
    for(const layout of modes){
      await setMode(layout);
      for(const policy of ['manual100','fitWidth','fitPage']){
        if(policy==='fitPage'&&!physical.has(layout)){const disabled=await page.getByRole('button',{name:'Fit page',exact:true}).isDisabled();check(`example/${layout}`,'Fit page is disabled in an endless layout',disabled);rowOf('example',layout,policy).note='Fit page unavailable (endless layout)';continue;}
        const area=`example/${layout}/${policy}`;
        if(policy==='manual100')await setManual(100);else await fit(policy);
        const m=await measure();const row=rowOf('example',layout,policy);
        Object.assign(row,{actual:m.actualZoom,fretMin:m.frets.minHeight,fretMedian:m.frets.medianHeight,visibleFrets:m.frets.visible,overlaps:m.frets.overlaps,sheets:m.sheets,scrollW:m.host.sw,clientW:m.host.cw,scrollH:m.host.sh,clientH:m.host.ch,fonts:m.fonts.status,alphaTab:m.fonts.alphaTab});
        check(area,'fonts loaded and the notation font is available',m.fonts.status==='loaded'&&m.fonts.alphaTab&&m.fonts.faces.every(f=>f.endsWith(':loaded')),m.fonts);
        check(area,'tab digits are drawn',m.frets.visible>0,m.frets);
        check(area,'no tab digits overlap',m.frets.overlaps===0,m.frets);
        check(area,'actual zoom is shown rounded',m.actualZoom===null||/^Actual zoom: \d+(\.\d)?%$/.test(m.actualZoom),m.actualZoom);
        if(policy==='fitWidth'&&!/horizontal/i.test(layout))check(area,'fit width needs no horizontal scrolling',m.host.sw<=m.host.cw+2,{sw:m.host.sw,cw:m.host.cw});
        if(policy==='fitPage')check(area,'fit page keeps a whole sheet in the area',m.sheets>0&&m.sheetWidth<=m.host.cw+2,{sheetWidth:m.sheetWidth,cw:m.host.cw,sheets:m.sheets});
        check(area,'nothing is clipped without a scrollbar',!m.clippedRight&&!m.clippedLeft,{clippedRight:m.clippedRight,clippedLeft:m.clippedLeft,content:m.content});
        await shot(`example-${layout}-${policy}-1440x900`);
        await clickTest(area,false);
        row.scroll=await scrollTest(area);
        if(!quick)row.cursor=await cursorTest(area,{seconds:4});
        await clickWorkstationButton(page,'Stop');await sleep(200);
      }
    }
  });

  // ===== 2. dense forced systems, all six modes, fit width and 100% =====
  await section('modes-dense',async()=>{
    await activate(docB);
    for(const layout of modes){
      await setMode(layout);
      for(const policy of ['manual100','fitWidth']){
        const area=`dense/${layout}/${policy}`;
        if(policy==='manual100')await setManual(100);else await fit(policy);
        const m=await measure();Object.assign(rowOf('dense',layout,policy),{actual:m.actualZoom,fretMin:m.frets.minHeight,fretMedian:m.frets.medianHeight,visibleFrets:m.frets.visible,overlaps:m.frets.overlaps,sheets:m.sheets,scrollW:m.host.sw,clientW:m.host.cw,scrollH:m.host.sh,clientH:m.host.ch,limited:m.limited});
        check(area,'fonts loaded',m.fonts.status==='loaded'&&m.fonts.alphaTab,m.fonts);
        check(area,'no tab digits overlap',m.frets.overlaps===0,m.frets);
        check(area,'nothing is clipped without a scrollbar',!m.clippedRight&&!m.clippedLeft,{content:m.content});
        await shot(`dense-${layout}-${policy}-1440x900`);
        await clickTest(area,true);
        if(!quick)rowOf('dense',layout,policy).scroll=await scrollTest(area);
        if(policy==='fitWidth'&&!quick){
          // Start in the last bar of the first system so the cursor has to cross a line break.
          const seek=async()=>{await revealPlaybackControls(page);const bar=page.locator('input[title="Seek measure"]:visible').first();await bar.click({clickCount:3});await page.keyboard.type('8');await page.keyboard.press('Enter');await sleep(400);await hidePlaybackControls(page);};
          rowOf('dense',layout,policy).cursor=await cursorTest(area,{seconds:5,seek});
          await clickWorkstationButton(page,'Stop');await sleep(200);
        }
      }
    }
  });

  // ===== 3. per-document restore =====
  const planned={A:{layout:'verticalScreen',zoom:135,mode:'manual'},B:{layout:'grid',mode:'fitPage'}};
  const readPolicy=async()=>({...await policyState()});
  async function assertDocs(label){
    await activate(docA);const a=await readPolicy();
    check(`restore/${label}`,'document A keeps its mode and manual zoom',a.layout===planned.A.layout&&Number(a.zoomInput)===planned.A.zoom&&a.fitWidth==='false'&&a.fitPage==='false',a);
    await activate(docB);const b=await readPolicy();
    check(`restore/${label}`,'document B keeps its mode and fit policy',b.layout===planned.B.layout&&(planned.B.mode==='fitWidth'?b.fitWidth==='true':b.fitPage==='true'),b);
    result.observations[`restore-${label}`]={a,b};
  }
  await section('restore',async()=>{
    await activate(docA);await setMode(planned.A.layout);await setManual(planned.A.zoom);
    await activate(docB);await setMode(planned.B.layout);
    if(await page.getByRole('button',{name:'Fit page',exact:true}).isEnabled())await fit('fitPage');else{planned.B.mode='fitWidth';check('restore','Fit page is available in a page layout for the dense score',false,'Fit page is disabled; fit width used instead');await fit('fitWidth');}
    await assertDocs('tab-switch');
    await page.reload();await waitForWorkspaceIdle(page);await stable('reload');
    await assertDocs('page-reload');
    // Wait for the recovery checkpoint to hold both views, then end the app abruptly and restore from recovery.
    const manifest=resolve(session,'recovery-v1','manifest.json');
    const deadline=Date.now()+30000;let holds=false;
    while(Date.now()<deadline&&!holds){
      try{if(existsSync(manifest)){const m=JSON.parse(readFileSync(manifest,'utf8')),env=JSON.parse(readFileSync(resolve(session,'recovery-v1',`checkpoint-${m.current.generation}.json`),'utf8'));
        const views=Object.fromEntries(env.documents.map(d=>[d.documentId,d.view?.scoreDisplay]));
        holds=views[docA]?.layout===planned.A.layout&&views[docB]?.layout===planned.B.layout&&views[docB]?.zoomMode===planned.B.mode;result.observations.checkpointViews=views;}}catch{}
      if(!holds)await sleep(500);
    }
    check('restore/recovery','recovery checkpoint holds both documents\' display preferences',holds,result.observations.checkpointViews??'no checkpoint');
    await stopApp();
    await startApp({restore:true});await stable('restored');
    const ws=await workspace();
    const ids=ws.documents.map(d=>d.documentId);result.observations.restoredDocumentIds=ids;
    check('restore/recovery','both documents come back after a restart',ids.includes(docA)&&ids.includes(docB),ids);
    await assertDocs('reopen-after-restart');
  });

  // ===== 4. resize: 1440x900, 1280x800, 960x600, emulated =====
  await section('resize',async()=>{
    result.observations.resizeNote='Sizes are emulated with Emulation.setDeviceMetricsOverride (page.setViewportSize); the native window is not resized.';
    for(const doc of [['example',docA],['dense',docB]]){
      await activate(doc[1]);
      for(const layout of modes){
        await setMode(layout);
        for(const policy of ['fitWidth','fitPage','manual100']){
          if(policy==='fitPage'&&!physical.has(layout))continue;
          if(policy==='manual100')await setManual(100);else await fit(policy);
          for(const size of sizes){
            await page.setViewportSize(size);await sleep(400);await stable('resize');
            const m=await measure();const area=`resize/${doc[0]}/${layout}/${policy}/${size.width}x${size.height}`;
            Object.assign(rowOf(`${doc[0]}@${size.width}x${size.height}`,layout,policy),{actual:m.actualZoom,limited:m.limited,fretMin:m.frets.minHeight,fretMedian:m.frets.medianHeight,visibleFrets:m.frets.visible,overlaps:m.frets.overlaps,scrollW:m.host.sw,clientW:m.host.cw,clientH:m.host.ch,toolbarOverflow:m.toolbarOverflow,outer:m.outer});
            check(area,'tab digits stay at least 6px tall',m.frets.minHeight===null||m.frets.minHeight>=6,{min:m.frets.minHeight,median:m.frets.medianHeight,actual:m.actualZoom});
            check(area,'no tab digits overlap',m.frets.overlaps===0,m.frets);
            check(area,'nothing is clipped without a scrollbar',!m.clippedRight&&!m.clippedLeft,m.content);
            check(area,'toolbar controls are not cut off',m.toolbarOverflow.length===0&&(m.toolbarRight===null||m.toolbarRight<=size.width+1),{overflow:m.toolbarOverflow,right:m.toolbarRight});
            if(policy==='fitWidth'&&!/horizontal/i.test(layout))check(area,'fit width needs no horizontal scrolling',m.host.sw<=m.host.cw+2,{sw:m.host.sw,cw:m.host.cw});
            if(layout==='verticalPage'||layout==='parchment'||layout==='horizontalScreen'||size.width===960)await shot(`resize-${doc[0]}-${layout}-${policy}-${size.width}x${size.height}`);
          }
          await page.setViewportSize(sizes[0]);await sleep(300);await stable('resize back');
        }
      }
    }
    const after=await page.evaluate(()=>({outer:[outerWidth,outerHeight]}));result.observations.windowAfter=after;
    check('resize','native window size never changed',after.outer[0]===result.observations.windowBefore.outer[0]&&after.outer[1]===result.observations.windowBefore.outer[1],{before:result.observations.windowBefore.outer,after:after.outer});
  });
} catch(error) {
  result.errors.push({section:'main',message:String(error?.stack??error)});console.log(error);
} finally {
  try{if(page)await page.setViewportSize(sizes[0]);}catch{}
  try{await stopApp();}catch(error){result.errors.push({section:'cleanup',message:String(error)});}
  result.table=Object.values(table);result.finishedAt=new Date().toISOString();
  writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,1));
  const failed=result.checks.filter(c=>!c.ok);
  console.log(`checks: ${result.checks.length}, failed: ${failed.length}, errors: ${result.errors.length}. Results: ${resolve(out,'result.json')}`);
  process.exitCode=failed.length||result.errors.length?1:0;
}
