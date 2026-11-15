// Shared by parity-mix-drag.mjs, parity-fret-typing.mjs and parity-track-click.mjs (THE-213): real CDP mouse and key input
// against a small and a large generated score. Nothing here sets a control's value directly.
import { existsSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { closeWelcomeLibrary,waitForWorkspaceIdle,clickWorkspaceCommand } from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';

export const sleep=ms=>new Promise(done=>setTimeout(done,ms));
export const SIZES={small:{tracks:3,bars:8},large:{tracks:6,bars:200},/** One track whose first four bars repeat, the fourth with a first ending and a fifth bar for the second. */repeat:{tracks:1,bars:6,repeat:true}};

function alphaTex(tracks,bars,repeat=false) {
  const B=String.fromCharCode(92),N=String.fromCharCode(10);
  let out=`${B}title "Entry mix ${tracks}x${bars}"${N}${B}tempo 120${N}.${N}`;
  for(let t=0;t<tracks;t++){
    const bass=t%3===2;
    out+=`${B}track "Track ${t+1}"${N}${B}staff {tabs}${N}${B}instrument ${bass?33:25}${N}${B}tuning ${bass?'g2 d2 a1 e1':'e4 b3 g3 d3 a2 e2'}${N}`;
    const strings=bass?4:6;
    for(let b=0;b<bars;b++){
      // Repeat bars (alphaTex metadata at the start of the bar): open at the first, a close with a first ending at the fourth, the second ending the fifth.
      let bar=repeat?(b===0?`${B}ro `:b===3?`${B}ae (1) ${B}rc 2 `:b===4?`${B}ae (2) `:''):'';
      bar+=':8 ';
      for(let i=0;i<8;i++)bar+=`${(b+i*3+t)%12}.${1+((b+i+t)%strings)} `;
      out+=`${bar}|${N}`;
    }
  }
  return out;
}

/** Writes the score `size` names, made by alphaTab's own exporter inside the app, to the test directory; returns its path. */
export async function makeScore(size) {
  const {tracks,bars,repeat=false}=SIZES[size],path=resolve(directory,`entry-mix-${size}.gp`);
  // Made once per build directory: a second launch for the same file only widens the window in which another test app can take the port.
  if(existsSync(path))return path;
  const id=launch();let browser;
  try{
    browser=await connect();const page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);
    const bytes=await page.evaluate(async tex=>{
      const {importer,exporter,Settings}=await import('/alphatab/alphaTab.mjs');
      const settings=new Settings(),reader=new importer.AlphaTexImporter();reader.initFromString(tex,settings);
      return [...new exporter.Gp7Exporter().export(reader.readScore(),settings)];
    },alphaTex(tracks,bars,repeat));
    writeFileSync(path,Uint8Array.from(bytes));
  }finally{if(browser)await browser.close();stop(id);}
  return path;
}

/** Opens `size`'s score in the test app and returns the page, a CDP session and helpers; `close` ends the app. */
export async function openScore(size,environment={}) {
  const path=await makeScore(size);
  const id=launch({TABPLAYER_TEST_OPEN:path,...environment});let browser=null;
  // A start that fails (another agent's app on the port, a slow load) must not leave this app running.
  try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];
  await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  await clickWorkspaceCommand(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);
  await page.waitForFunction(()=>document.querySelector('.score-tools')?.textContent.includes('measures'),{},{timeout:180000});
  await page.waitForTimeout(2000);
  const cdp=await page.context().newCDPSession(page);
  const session={
    page,cdp,size,
    snapshot:()=>readActiveDocument(page),
    edits:async()=>(await readActiveDocument(page)).project.edits,
    async close(){try{await browser.close();}finally{stop(id);}},
  };
  // Where the cursor starts in a repeated bar Play waits for a chosen occurrence, so only the document being idle can be waited for.
  if(size==='repeat'){await waitForWorkspaceIdle(page);await sleep(1500);}else await settle(page);
  return session;
  }catch(error){try{await browser?.close();}catch{ /* Already gone. */ }try{stop(id);}catch{ /* Already gone. */ }throw error;}
}


/** Waits until the app is neither busy nor loading audio for a moment, so the next input starts from rest. */
export async function settle(page,quiet=800,timeout=180000) {
  await page.waitForFunction(()=>{
    const play=document.querySelector('[aria-keyshortcuts="Space"]');
    return play&&!play.disabled&&play.getAttribute('aria-disabled')!=='true'&&document.querySelector('.app-shell')?.getAttribute('aria-busy')==='false';
  },{},{polling:50,timeout});
  await sleep(quiet);
}

const mouseEvent=(cdp,type,x,y)=>cdp.send('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1});
export async function click(cdp,x,y) {
  await mouseEvent(cdp,'mouseMoved',x,y);await mouseEvent(cdp,'mousePressed',x,y);await sleep(40);await mouseEvent(cdp,'mouseReleased',x,y);
}
export const centre=async(page,selector)=>page.evaluate(selector=>{
  const node=[...document.querySelectorAll(selector)].find(item=>item.offsetParent!==null);
  if(!node)throw new Error(`Nothing visible matches ${selector}`);
  // A track below the dock's fold is scrolled to first, as a player would, so the click lands on it.
  node.scrollIntoView({block:'center',inline:'nearest'});
  const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,left:r.x,top:r.y,width:r.width,height:r.height};
},selector);
export const lerp=(from,to,steps)=>Array.from({length:steps+1},(_,index)=>[from[0]+(to[0]-from[0])*index/steps,from[1]+(to[1]-from[1])*index/steps]);
/** A real press, drag along `points` (a move every `delay` ms) and release. */
export async function drag(cdp,points,delay=25,midway=null) {
  await mouseEvent(cdp,'mouseMoved',...points[0]);await mouseEvent(cdp,'mousePressed',...points[0]);
  const half=Math.floor(points.length/2);
  for(const [index,point] of points.slice(1).entries()){await sleep(delay);await mouseEvent(cdp,'mouseMoved',...point);if(midway&&index+1===half)await midway();}
  await sleep(delay);await mouseEvent(cdp,'mouseReleased',...points.at(-1));
}

const keyDefinition=key=>{
  if(/^\d$/.test(key))return {key,code:`Digit${key}`,windowsVirtualKeyCode:48+Number(key),text:key};
  const named={' ':{key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '},Shift:{key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16},Control:{key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17},Enter:{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},Escape:{key:'Escape',code:'Escape',windowsVirtualKeyCode:27},ArrowRight:{key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},ArrowLeft:{key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37},ArrowUp:{key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38},ArrowDown:{key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40},z:{key:'z',code:'KeyZ',windowsVirtualKeyCode:90}};
  if(named[key])return named[key];throw new Error(`No key definition for ${key}`);
};
/** A real key press; `modifiers` is CDP's bit set (2 is Ctrl). */
export async function press(cdp,key,{hold=20,modifiers=0,repeats=0}={}) {
  const definition=keyDefinition(key);
  await cdp.send('Input.dispatchKeyEvent',{type:definition.text&&!modifiers?'keyDown':'rawKeyDown',modifiers,...definition});
  // Held-key repeats: the same key down again, flagged as auto-repeat.
  for(let repeat=0;repeat<repeats;repeat++){await sleep(30);await cdp.send('Input.dispatchKeyEvent',{type:definition.text&&!modifiers?'keyDown':'rawKeyDown',modifiers,autoRepeat:true,...definition});}
  await sleep(hold);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',modifiers,key:definition.key,code:definition.code,windowsVirtualKeyCode:definition.windowsVirtualKeyCode});
}

/** The centre of the n-th fret number drawn in the score (not a bar number), in viewport coordinates. */
export const fretPoint=(page,index)=>page.evaluate(index=>{
  const numbers=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)&&text.getBoundingClientRect().width>0&&!/rgb\(2[0-2]\d, ?\d+, ?\d+\)|red/.test(getComputedStyle(text).fill));
  const r=numbers[index].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,text:numbers[index].textContent};
},index);

/** Starts logging the document and audio IPC calls (name and time) and the app's busy flips; read them back with `ipcSince`. */
export const watchIpc=page=>page.evaluate(()=>{
  if(window.__ipcLog)return;const log=window.__ipcLog={ipc:[],busy:[]};
  new PerformanceObserver(list=>{for(const e of list.getEntries())if(/ipc\.localhost/.test(e.name))log.ipc.push({cmd:e.name.replace(/^.*ipc\.localhost\//,''),t:e.startTime,end:e.responseEnd});}).observe({entryTypes:['resource']});
  new MutationObserver(list=>{for(const m of list)log.busy.push({t:performance.now(),v:m.target.getAttribute('aria-busy')});}).observe(document.querySelector('.app-shell'),{attributes:true,attributeFilter:['aria-busy']});
});
export const nowOnPage=page=>page.evaluate(()=>performance.now());
export const ipcSince=(page,since)=>page.evaluate(since=>{
  const log=window.__ipcLog,counts={};for(const e of log.ipc.filter(e=>e.t>=since))counts[e.cmd]=(counts[e.cmd]||0)+1;
  const idle=log.busy.filter(b=>b.t>=since&&b.v==='false').at(-1);
  return {counts,busyEndedMs:idle?Math.round(idle.t-since):null};
},since);

/** Native transport status: tick, whether it plays and the practice phase. */
export const transport=page=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status')).then(status=>({tick:Math.round(status.tick),playing:Boolean(status.playing),phase:status.practice?.phase}));
