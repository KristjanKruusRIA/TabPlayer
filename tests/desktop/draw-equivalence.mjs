import assert from 'node:assert/strict';
import { existsSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clickWorkstationButton } from './workstation-commands.mjs';

// THE-213 (draw speed): the score is laid out whole but painted only where it is in view. After each of a series of edits the drawing in the page is compared with a
// complete render of the same score made in a renderer of its own (`globalThis.__tabplayerCheckDraw`, see src/engraving/draw-check.ts): the geometry and SVG of every
// system, and the bounds used for clicks and the playback cursor. The series changes notes, durations, the number of beats and bars (so the line breaks), and tracks,
// and takes edits back. Nothing here reads a title or a track name.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** Runs the series on the score the page shows. Returns what happened per step; throws on a difference. */
export async function runDrawEquivalence(page,cdp,{label='score'}={}) {
  await page.evaluate(()=>{
    const state=window.__drawEq={last:performance.now()};
    const host=document.querySelector('.score-paper-host');
    new MutationObserver(()=>{state.last=performance.now();}).observe(host,{subtree:true,childList:true,characterData:true});
    new MutationObserver(()=>{state.last=performance.now();}).observe(document.querySelector('.app-shell'),{attributes:true,attributeFilter:['aria-busy']});
  });
  const quiet=async(ms=600)=>{
    await page.waitForFunction(quietFor=>{
      const button=document.querySelector('[aria-keyshortcuts="Space"]'),state=window.__drawEq;
      return button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&document.querySelector('.app-shell')?.getAttribute('aria-busy')==='false'&&performance.now()-state.last>quietFor;
    },ms,{polling:50,timeout:120000});
  };
  const key=async(name,{modifiers=0,code=name,vk}={})=>{
    const digit=/^\d$/.test(name),definition={key:name,code:digit?`Digit${name}`:code,windowsVirtualKeyCode:vk??(digit?48+Number(name):0)};
    await cdp.send('Input.dispatchKeyEvent',{type:digit&&!modifiers?'keyDown':'rawKeyDown',...definition,modifiers,...digit&&!modifiers?{text:name}:{}});await sleep(15);
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:definition.key,code:definition.code,windowsVirtualKeyCode:definition.windowsVirtualKeyCode,modifiers});await sleep(120);
  };
  const click=async point=>{for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1});await sleep(250);};
  /** The n-th fret number in view (scrolling down until there are enough): clicking it puts the cursor and the keyboard focus on the score. */
  const fretInView=async(n=2)=>{
    for(let attempt=0;attempt<80;attempt++) {
      const found=await page.evaluate(n=>{
        const area=document.querySelector('.paper-scroll').getBoundingClientRect();
        const numbers=[...document.querySelector('.score-paper-host').querySelectorAll('svg text')].filter(text=>/^\d{1,2}$/.test(text.textContent)).filter(text=>{
          const fill=getComputedStyle(text).fill;if(/rgb\(2(0|2)\d, ?\d+, ?\d+\)/.test(fill)||/red/.test(fill))return false;
          const box=text.getBoundingClientRect();return box.width>0&&box.top>area.top+20&&box.bottom<area.bottom-20&&box.left>area.left&&box.right<area.right;
        });
        if(numbers.length<=n)return null;const box=numbers[n].getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};
      },n);
      if(found)return found;
      await page.evaluate(()=>{document.querySelector('.paper-scroll').scrollTop+=250;});await sleep(200);
    }
    throw new Error('no fret number in view');
  };
  const focusScore=async()=>{await click(await fretInView());await quiet();};
  const steps=[];let previous=null;
  const check=async(name,{changes=true}={})=>{
    await quiet();
    const result=await page.evaluate(()=>window.__tabplayerCheckDraw());
    assert.ok(result.equal,`${label}: after "${name}" the drawing differs from a complete render: ${result.differences.slice(0,3).join(' || ')}`);
    assert.ok(result.pieces>0,`${label}: after "${name}" nothing is laid out`);
    const changed=previous===null||result.signature!==previous.signature;
    if(changes)assert.ok(changed,`${label}: "${name}" did not change the drawing, so it checked nothing`);
    steps.push({name,pieces:result.pieces,bars:result.bars,changed,breaksMoved:previous!==null&&result.breaks!==previous.breaks});
    previous=result;
  };
  const toolbar=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await sleep(250);await quiet();};

  await quiet();await focusScore();await check('opened',{changes:false});
  await key('ArrowRight',{vk:39});await key('7');await check('a typed digit');
  await key('ArrowRight',{vk:39});await key('1');await key('2');await sleep(300);await check('a two-digit fret');
  // A shorter duration: the cursor's beat may already be a sixteenth in a real score, so the next shorter one is tried until the drawing changes.
  for(const name of ['Sixteenth note (1/16)','Thirty-second note (1/32)','Sixty-fourth note (1/64)']) {
    await toolbar(name);
    if((await page.evaluate(()=>window.__tabplayerCheckDraw())).signature!==previous.signature)break;
  }
  await check('a shorter duration');
  await focusScore();await key('z',{modifiers:2,code:'KeyZ',vk:90});await check('undo');
  await key('y',{modifiers:2,code:'KeyY',vk:89});await check('redo');
  // Beats go and come back, five at a time: the bar gets narrower, then wider, and the line breaks after it move.
  await focusScore();for(let i=0;i<5;i++)await key('Delete',{modifiers:8,vk:46});await check('five beats deleted');
  for(let i=0;i<5;i++)await key('Insert',{modifiers:2,vk:45});await check('five beats inserted');
  await focusScore();await toolbar('Append measure');await check('a measure appended');
  await toolbar('Remove measure');await check('a measure removed');
  // Another track: the cursor goes there, the score shows it, a digit is typed on it, and the edit is taken back.
  await focusScore();await key('ArrowDown',{modifiers:2,vk:40});await sleep(400);await quiet();
  await check('another track shown',{changes:false});
  await focusScore();await key('5');await check('a digit on the other track');
  await key('z',{modifiers:2,code:'KeyZ',vk:90});await check('undo on the other track');
  // Scrolling: every system in view is painted by the time the scroll has settled, and the drawing still equals a complete render.
  await page.evaluate(()=>{const host=document.querySelector('.paper-scroll');host.scrollTop=host.scrollHeight;});await sleep(500);await quiet();
  const unpainted=await page.evaluate(()=>{
    const area=document.querySelector('.paper-scroll').getBoundingClientRect(),surface=document.querySelector('.score-paper-host .at-surface');
    return [...surface.children].filter(piece=>{const box=piece.getBoundingClientRect();return box.height>0&&box.bottom>area.top&&box.top<area.bottom&&!piece.querySelector('svg');}).length;
  });
  assert.equal(unpainted,0,`${label}: ${unpainted} systems in view were left blank after scrolling`);
  await check('scrolled to the end',{changes:false});
  await page.evaluate(()=>{document.querySelector('.paper-scroll').scrollTop=0;});await sleep(500);await check('scrolled back',{changes:false});
  // Layouts that place the lines by content (the screen layouts) move their line breaks when a bar gets wider or narrower; the page layouts are painted whole.
  const layout=async value=>{await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption(value);await sleep(700);await quiet();};
  for(const mode of ['verticalScreen','horizontalScreen','verticalPage']) {
    await layout(mode);await check(`${mode}: shown`,{changes:false});
    if(mode==='verticalPage')continue;
    await focusScore();for(let i=0;i<8;i++)await key('Delete',{modifiers:8,vk:46});await check(`${mode}: eight beats deleted`);
    await key('z',{modifiers:2,code:'KeyZ',vk:90});await check(`${mode}: undo`);
    for(let i=0;i<8;i++)await key('Insert',{modifiers:2,vk:45});await check(`${mode}: eight beats inserted`);
  }
  await layout('parchment');await check('parchment again',{changes:false});
  return {steps,breaksMoved:steps.filter(step=>step.breaksMoved).length};
}

/** The owner's scores, when a folder of them is named (`TP_OWNER_SCORES`) and exists; their names and contents never leave this process. */
export function ownerScoreFiles(directory) {
  if(!directory||!existsSync(directory))return [];
  return readdirSync(directory).filter(name=>/\.(gp|gpx|gp3|gp4|gp5)$/i.test(name)).sort().map(name=>join(directory,name));
}
