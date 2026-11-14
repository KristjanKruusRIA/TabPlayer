// THE-213: Volume and Pan follow a real mouse drag in the dock rows, the dock mixer and the Mixer view, record ONE undoable edit
// when the gesture ends (none when it ends where it began), are never disabled by the app being busy, and keyboard steps are one edit each.
// usage (from the checkout root, after scripts/build-desktop-test.ps1): node tests/desktop/parity-mix-drag.mjs [small|large]
import assert from 'node:assert/strict';
import { openScore,settle,sleep,centre,lerp,drag,press,click } from './entry-mix-support.mjs';

const size=process.argv[2]??'small',session=await openScore(size),{page,cdp}=session,report={size,runs:{}};
try{
  const watch=selector=>page.evaluate(selector=>{
    const node=[...document.querySelectorAll(selector)].find(item=>item.offsetParent!==null);
    const state=window.__mixDrag={disabled:[],up:0,busy:[],attached:true,node};
    new MutationObserver(list=>{for(const m of list)state.disabled.push({a:m.attributeName,v:m.target.getAttribute(m.attributeName),t:performance.now()});}).observe(node,{attributes:true,attributeFilter:['disabled']});
    new MutationObserver(list=>{for(const m of list)state.busy.push(m.target.getAttribute('aria-busy'));}).observe(document.querySelector('.app-shell'),{attributes:true,attributeFilter:['aria-busy']});
    window.addEventListener('pointerup',()=>state.up++,{capture:true,once:true});
  },selector);
  const outcome=()=>page.evaluate(()=>{const s=window.__mixDrag;return {disabledChanges:s.disabled.length,disabledNow:s.node.disabled??null,ariaDisabled:s.node.getAttribute('aria-disabled'),up:s.up,attached:s.node.isConnected,busy:s.busy,value:s.node.value??s.node.getAttribute('aria-valuenow')};});
  /** Drags the control `selector` along `path(rect)`, and checks the edits it recorded. */
  async function run(name,selector,path,{expected,tolerance,field,returns=false,steps=14,midway=null}) {
    await settle(page);
    const before=await session.edits(),rect=await centre(page,selector);
    rect.value=await page.evaluate(selector=>{const node=[...document.querySelectorAll(selector)].find(item=>item.offsetParent!==null);return Number(node.value??node.getAttribute('aria-valuenow'));},selector);
    await watch(selector);
    await drag(cdp,path(rect,steps),25,midway);
    await settle(page);
    const after=await session.edits(),added=after.slice(before.length),result=await outcome();
    report.runs[name]={added:added.map(edit=>edit.type),...result,expected};
    assert.equal(result.up>=1,true,`${name}: the release reached the window`);
    assert.equal(result.disabledChanges,0,`${name}: the dragged control was never disabled (${JSON.stringify(result)})`);
    assert.equal(result.attached,true,`${name}: the control stayed mounted`);
    if(returns){assert.equal(added.length,0,`${name}: a drag that ends where it began records nothing`);return;}
    assert.equal(added.length,1,`${name}: one edit for the whole drag, got ${added.length}`);
    assert.equal(added[0].type,'setTrackMix',`${name}: the edit is a track mix`);
    const got=added[0].mix[field];
    assert.ok(Math.abs(got-expected)<=tolerance,`${name}: ${field} ${got} should be near ${expected}`);
    report.runs[name].recorded=got;
  }
  const horizontal=fraction=>(rect,steps)=>{const y=rect.y,start=[rect.left+rect.width*0.95-3,y];return lerp(start,[rect.left+rect.width*fraction,y],steps);};
  const verticalUp=pixels=>(rect,steps)=>lerp([rect.x,rect.y],[rect.x,rect.y-pixels],steps);
  const there=pixels=>(rect,steps)=>[...lerp([rect.x,rect.y],[rect.x,rect.y-pixels],steps/2),...lerp([rect.x,rect.y-pixels],[rect.x,rect.y],steps/2)];

  // A real click on the thumb, a little off its centre, records nothing; a key released mid-drag does not commit it early.
  const thumbClicks=async label=>{
    await settle(page);
    const before=await session.edits();
    const geometry=await page.evaluate(()=>{const n=[...document.querySelectorAll('input.dock-fader')].find(i=>i.offsetParent!==null);const r=n.getBoundingClientRect();return {left:r.left,width:r.width,y:r.top+r.height/2,value:Number(n.value),min:Number(n.min),max:Number(n.max)};});
    const centre=geometry.left+3.5+(geometry.value-geometry.min)/(geometry.max-geometry.min)*(geometry.width-7);
    for(const offset of [-3,0,3]){await click(cdp,centre+offset,geometry.y);await sleep(200);}
    await settle(page);
    const after=await session.edits();
    report.runs[label]={added:after.length-before.length,at:geometry,edits:after.slice(before.length).map(edit=>JSON.stringify(edit.mix??edit).slice(0,120))};
    assert.equal(after.length-before.length,0,`${label}: clicks on the thumb, at and a little off its centre, record nothing`);
  };
  await thumbClicks('thumbClicksAtMaximum');
  // The dock's track rows (Overview): volume is a range, pan a knob.
  await run('dockVolume','input.dock-fader',horizontal(.3),{expected:.3,tolerance:.12,field:'gain'});
  // Grabs the thumb where it is (its centre at the current value), moves away and comes back to that point.
  await thumbClicks('thumbClicksAfterDrag');
  await run('dockVolumeBackToStart','input.dock-fader',(rect,steps)=>{const y=rect.y,a=[rect.left+3.5+rect.value*(rect.width-7),y],away=[a[0]+rect.width*.3,y];return [...lerp(a,away,steps/2),...lerp(away,a,steps/2)];},{returns:true});
  await run('dockVolumeKeyReleasedMidDrag','input.dock-fader',horizontal(.45),{expected:.45,tolerance:.12,field:'gain',midway:async()=>{await press(cdp,'Shift',{hold:10});}});
  await run('dockPan','.dock-pan [role=slider]',verticalUp(40),{expected:.5,tolerance:.15,field:'pan'});
  await run('dockPanBackToStart','.dock-pan [role=slider]',there(30),{returns:true});

  // Keyboard: each step is one edit.
  await settle(page);
  let before=(await session.edits()).length;
  await page.locator('input.dock-fader').first().focus();await press(cdp,'ArrowLeft');await settle(page);
  assert.equal((await session.edits()).length-before,1,'one arrow step on the dock volume is one edit');
  before=(await session.edits()).length;
  await page.locator('.dock-pan [role=slider]').first().focus();await press(cdp,'ArrowRight');await settle(page);
  assert.equal((await session.edits()).length-before,1,'one arrow step on the dock pan is one edit');

  // The dock's Mixer mode: the same controls as full-width ranges.
  await page.getByRole('navigation',{name:'Dock views'}).getByRole('button',{name:'Mixer',exact:true}).click();await sleep(800);
  await run('dockMixerVolume','.track-mixer input[aria-label^="Volume "]',horizontal(.6),{expected:.6,tolerance:.12,field:'gain'});
  await run('dockMixerPan','.track-mixer input[aria-label^="Pan "]',horizontal(.9),{expected:.8,tolerance:.15,field:'pan'});
  await page.getByRole('navigation',{name:'Dock views'}).getByRole('button',{name:'Overview',exact:true}).click();

  // The Mixer view.
  await page.getByRole('radio',{name:'Mixer'}).click().catch(()=>page.getByRole('button',{name:'Mixer',exact:true}).first().click());await sleep(1000);
  await run('mixerViewFader','.mixer-strip-fader [role=slider]',(rect,steps)=>{const bottom=rect.top+rect.height-30;return lerp([rect.x,bottom],[rect.x,bottom-rect.height*.4],steps);},{expected:.4,tolerance:.15,field:'gain'});
  await run('mixerViewPan','.mixer-strip-pan [role=slider]',verticalUp(-30),{expected:.575,tolerance:.1,field:'pan'});
  await run('mixerViewPanBackToStart','.mixer-strip-pan [role=slider]',there(30),{returns:true});

  // Undo takes a whole drag back in one step.
  const undoable=(await session.snapshot()).canUndo;assert.equal(undoable,true);
  console.log(JSON.stringify({ok:true,...report},null,1));
}catch(error){console.log(JSON.stringify(report,null,1));throw error;}
finally{await session.close();}
