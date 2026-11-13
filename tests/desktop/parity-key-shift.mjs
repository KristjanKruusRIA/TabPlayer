// P12: the playback key shift from the real app. Sets a shift from the transport and from the command palette, reads it
// acknowledged in audio_status, changes it while playing and checks the loop and generation are kept and the position stays
// inside the loop, resets it, and checks that no edit was made and the document was not marked modified. It also checks that
// every transport control, and the Key group wherever it lives, is inside the window at 960 by 600 with a selection present.
// Run from the checkout root after the desktop test build (see CLAUDE.md).
import {waitForWorkspaceIdle,closeWelcomeLibrary,clickWorkstationButton,revealPlaybackControls,hidePlaybackControls} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch,connect,stop } from './harness.mjs';
import { buildPracticeFixture,practiceFixture } from './practice-fixture.mjs';

buildPracticeFixture();
mkdirSync(resolve('.analysis/parity'),{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:practiceFixture});
let browser,page;const result={};
try{
  browser=await connect();page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const snapshot=()=>readActiveDocument(page);
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async(predicate,timeout=15000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(25);}throw new Error(`Timed out waiting for audio status: ${JSON.stringify(last)}`);};
  const idle=async()=>{await waitForWorkspaceIdle(page,{timeout:15000});assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const tonality=value=>value.practice.settings.tonality??0;
  await button('Open');await waitStatus(value=>value.ready&&!value.error);
  const baseline=await snapshot();
  const group=page.getByRole('group',{name:'Key',exact:true});
  const key=name=>group.getByRole('button',{name,exact:true});
  const shown=async()=>(await group.getByRole('status',{name:'Key shift'}).textContent()).trim();
  // In a narrow window the Key group is folded into More playback; open it when it is not in the row.
  const reachKey=async()=>{if(!await group.isVisible())await revealPlaybackControls(page);assert.ok(await group.isVisible(),'the Key group cannot be reached');};
  const leaveKey=async()=>{await hidePlaybackControls(page);};
  // Every transport control's right edge must be inside the window: scrollWidth would not show a control pushed past the edge.
  const outside=()=>page.evaluate(()=>{
    const found=[];
    for(const node of document.querySelectorAll('.gp-toolbar .transport button, .gp-toolbar .transport input, .gp-toolbar .transport select, .gp-toolbar .transport summary, .gp-toolbar .transport output, .gp-toolbar .transport-keymark')){
      if(node.closest('.transport-more-content'))continue;
      const box=node.getBoundingClientRect();if(box.width===0||box.height===0)continue;
      if(box.right>window.innerWidth+0.5||box.left<-0.5)found.push({control:node.getAttribute('aria-label')||node.getAttribute('title')||node.textContent.trim().slice(0,30),left:Math.round(box.left),right:Math.round(box.right)});
    }
    return {found,innerWidth:window.innerWidth,keyInRow:!!document.querySelector('.gp-toolbar .transport-primary>.transport-key')};
  });

  // A selection, so the 34px loop-selection button is in the row when the fit is measured.
  await page.getByRole('region',{name:'Score workspace'}).focus();await page.keyboard.press('Shift+ArrowRight');
  await page.waitForSelector('[data-action="loop-selection"]',{timeout:10000});
  for(const [width,height] of [[1280,800],[1101,700],[960,600]]){
    await page.setViewportSize({width,height});await page.waitForTimeout(400);
    const fit=await outside();result[`fit${width}`]=fit;
    assert.deepEqual(fit.found,[],`controls outside a ${width} wide window: ${JSON.stringify(fit)}`);
    assert.ok(await page.locator('[data-action="loop-selection"]').first().isVisible(),'the loop-selection button is in the row');
    assert.ok(await page.locator('.transport-more>summary').isVisible(),'More playback is visible');
    // Above the breakpoint the Key group is in the row (1101 is the tightest such width); at or below it, it is folded.
    assert.equal(fit.keyInRow,width>1100,`the Key group is ${fit.keyInRow?'':'not '}in the row at ${width}`);
    if(width>1100){
      // The in-row buttons work, and the row keeps them in the window.
      const row=page.locator('.gp-toolbar .transport-primary>.transport-key');
      await row.getByRole('button',{name:'Raise the key',exact:true}).click();await waitStatus(value=>tonality(value)===1);await idle();
      assert.equal((await row.getByRole('status',{name:'Key shift'}).textContent()).trim(),'+1');
      await row.getByRole('button',{name:'Original key',exact:true}).click();await waitStatus(value=>tonality(value)===0);await idle();
      // A real pointer double click is two steps: nothing moves under the pointer between the clicks.
      await row.getByRole('button',{name:'Raise the key',exact:true}).dblclick();await waitStatus(value=>tonality(value)===2);await idle();
      await row.getByRole('button',{name:'Original key',exact:true}).click();await waitStatus(value=>tonality(value)===0);await idle();
    }else{
      assert.equal(await page.locator('.transport-more>summary .transport-keymark').count(),0,'no mark on the summary at the original key');
    }
  }
  // At 960 wide the Key group is reachable, in the row or folded into More playback.
  await reachKey();for(const name of ['Lower the key','Raise the key','Original key'])assert.ok(await key(name).isVisible(),`${name} is not visible at 960 by 600`);await leaveKey();

  // A shift from the interface is acknowledged by the native status, one step per click.
  assert.equal(tonality(await status()),0);await reachKey();assert.equal(await shown(),'0');
  assert.equal(await key('Original key').getAttribute('aria-disabled'),'true');
  const generation=(await status()).generation;
  // A real pointer double click on the folded Raise is two steps: the popover does not move between the clicks.
  await key('Raise the key').dblclick();await waitStatus(value=>tonality(value)===2);await idle();await reachKey();
  await key('Original key').click();await waitStatus(value=>tonality(value)===0);await idle();await reachKey();
  for(let step=1;step<=3;step++){
    await key('Raise the key').click();
    await waitStatus(value=>tonality(value)===step&&value.ready);await idle();await reachKey();
  }
  assert.equal(await shown(),'+3');
  // The folded group leaves a labelled mark on the summary, and the summary grows to hold it: the mark is inside the window and inside the summary's box.
  const mark=await page.evaluate(()=>{const summary=document.querySelector('.transport-more>summary'),el=summary?.querySelector('.transport-keymark');if(!el)return null;const a=summary.getBoundingClientRect(),b=el.getBoundingClientRect();return {label:el.getAttribute('aria-label'),text:el.textContent,insideSummary:b.left>=a.left-0.5&&b.right<=a.right+0.5,insideWindow:b.right<=window.innerWidth+0.5&&b.left>=-0.5,overflow:summary.scrollWidth-summary.clientWidth};});
  assert.ok(mark,'a folded Key group leaves a mark on the More playback summary');assert.equal(mark.label,'Key +3');assert.ok(mark.insideSummary&&mark.insideWindow&&mark.overflow<=1,JSON.stringify(mark));
  result.foldedMark=mark;await leaveKey();const withMark=await outside();assert.deepEqual(withMark.found,[],`controls outside the window with the mark shown: ${JSON.stringify(withMark)}`);await reachKey();
  assert.equal((await status()).generation,generation,'a shift never prepares the score again');
  // A fast double click is two steps: the second waits for the first and both land.
  // Two activations in the same task, before native can answer the first (a pointer double click can miss the button when the layout moves under it): the second is queued behind the first and both land.
  await key('Raise the key').evaluate(node=>{node.click();node.click();});await waitStatus(value=>tonality(value)===5);await idle();await reachKey();assert.equal(await shown(),'+5');
  await key('Lower the key').click();await waitStatus(value=>tonality(value)===4);await idle();await reachKey();
  await key('Lower the key').click();await waitStatus(value=>tonality(value)===3);await idle();await leaveKey();

  // The same changes from the command palette, and its refusal of a command that cannot run.
  const workspace=page.getByRole('region',{name:'Score workspace'}),palette=page.getByRole('dialog',{name:'Commands',exact:true}),field=palette.getByRole('combobox',{name:'Command'});
  const command=async(text,{run=true}={})=>{await workspace.focus();await page.keyboard.press('Control+Shift+P');await field.waitFor();await field.fill(text);await page.keyboard.press('Enter');if(run){await palette.waitFor({state:'detached'});await idle();}};
  await command('raise the key');await waitStatus(value=>tonality(value)===4);
  await command('original key');await waitStatus(value=>tonality(value)===0);
  await command('original key',{run:false});
  assert.match(await palette.getByRole('option').first().textContent(),/already the original/);assert.equal(await palette.isVisible(),true);
  await page.keyboard.press('Escape');await palette.waitFor({state:'detached'});assert.equal(tonality(await status()),0);
  await command('raise the key');await waitStatus(value=>tonality(value)===1);

  // Change the shift while playing: the loop and generation are kept, nothing stops, and the position stays inside the loop.
  await revealPlaybackControls(page);await page.getByLabel('Loop start',{exact:true}).fill('1');await page.getByLabel('Loop end',{exact:true}).fill('2');await hidePlaybackControls(page);
  await button('Loop');const looped=await waitStatus(value=>value.loop!==null);
  await button('Play');const playing=await waitStatus(value=>value.playing&&value.tick>0);
  await reachKey();await key('Raise the key').click();
  const shifted=await waitStatus(value=>tonality(value)===2&&value.playing);await idle();
  assert.equal(shifted.generation,playing.generation);assert.deepEqual(shifted.loop,looped.loop);
  const inLoop=value=>value.tick>=looped.loop.startTick-1&&value.tick<=looped.loop.endTick+1;
  assert.ok(inLoop(shifted),`the position left the loop: ${shifted.tick} not in ${JSON.stringify(looped.loop)}`);
  await page.waitForTimeout(400);const later=await status();assert.ok(later.playing&&tonality(later)===2&&inLoop(later)&&later.generation===playing.generation);
  result.whilePlaying={before:playing.tick,after:shifted.tick,later:later.tick,loop:later.loop};

  // Reset returns to the original key and the control shows it.
  await reachKey();await key('Original key').click();await waitStatus(value=>tonality(value)===0);await idle();await reachKey();
  assert.equal(await shown(),'0');assert.equal(await key('Original key').getAttribute('aria-disabled'),'true');
  await leaveKey();await button('Stop');

  // A session setting: no edit, nothing marked modified.
  const after=await snapshot();
  assert.deepEqual(after.project,baseline.project);assert.equal(after.dirty,baseline.dirty);
  assert.deepEqual(errors,[]);
  await page.setViewportSize({width:1280,height:800});
  result.ok=true;writeFileSync(resolve('.analysis/parity/key-shift-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page){await page.screenshot({path:resolve('.analysis/parity/key-shift-failure.png')}).catch(()=>{});console.error(await page.evaluate(async()=>({status:await window.__TAURI_INTERNALS__.invoke('audio_status'),body:document.body.innerText.slice(-2500)})).catch(()=>null));}throw error;}
finally{if(browser)await browser.close();stop(id);}
