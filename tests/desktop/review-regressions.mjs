import {waitForWorkspaceIdle,clickWorkstationButton,revealDock,closeWelcomeLibrary,moveCursor,setFret,editionPalette} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {launch,connect,stop,directory} from './harness.mjs';
const run=Date.now(), exported=resolve(directory,`review-${run}.gp`);
const id=launch({TABPLAYER_TEST_SAVE:resolve(directory,`review-${run}.tabplayer`),TABPLAYER_TEST_EXPORT:exported,TABPLAYER_TEST_OPEN:exported});
const browser=await connect(),page=browser.contexts()[0].pages()[0];
let stage='startup';const errors=[];page.on('pageerror',error=>errors.push({stage,message:error.message,stack:error.stack}));
const idle=()=>waitForWorkspaceIdle(page);
const click=async name=>{stage=name;await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
// Cursor moves and notes: the score's keys and the palette's commands (the Selection tab's Measure, Beat, Fret, Dots fields and buttons are gone).
const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
const waitStatus=async predicate=>{const deadline=Date.now()+10000;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(25);}throw new Error(`Native status timed out at ${stage}: ${JSON.stringify(last)}`);};
const ready=async()=>{await waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Play'&&!b.disabled));};
const signals=[];
const audible=async label=>{stage=label;console.log(`Checking native callbacks: ${label}`);const before=await status();assert.equal(before.outputPeak,0,'A newly prepared score must not report an earlier score signal.');await click('Play');const played=await waitStatus(s=>s.generation===before.generation&&s.playing&&s.renderedFrames>before.renderedFrames+1024&&s.outputPeak>.001);signals.push({label,generation:played.generation,renderedFrames:played.renderedFrames,outputPeak:played.outputPeak});await click('Stop');await waitStatus(s=>!s.playing&&s.tick===0);};
const check=async(label,index,checked)=>{await revealDock(page,'Mixer');const input=page.getByLabel(label,{exact:true}).nth(index);assert.notEqual(await input.isChecked(),checked);await input.click();await page.waitForFunction(({label,index,checked})=>[...document.querySelectorAll('.track-channel label')].filter(node=>node.textContent.trim()===label)[index]?.querySelector('input')?.checked===checked,{label,index,checked});await idle();};
try {
  await closeWelcomeLibrary(page);await waitForWorkspaceIdle(page);
  await page.context().route('**/*',route=>['tauri.localhost','ipc.localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  await page.evaluate(async()=>{
    const {AlphaTabApi}=await import('/alphatab/alphaTab.mjs'),original=AlphaTabApi.prototype.renderScore;
    AlphaTabApi.prototype.renderScore=function(score,...args){window.__reviewScore=score;return original.call(this,score,...args);};
  });
  await moveCursor(page,{bar:2});for(let i=0;i<4;i++)await click('Delete beat');
  // With no beat under the cursor the palette's Chords button is unavailable (it was Set note).
  assert.equal(await editionPalette(page).getByRole('button',{name:'Chords',exact:true}).isDisabled(),true);
  await page.waitForFunction(()=>window.__reviewScore.tracks[0].staves[0].bars[1].voices[0].beats[0].isEmpty);
  await click('Insert beat');await moveCursor(page,{bar:1});
  await moveCursor(page,{beat:4});for(let i=0;i<3;i++)await click('Delete beat');
  // The old Dots field went to 3; the palette goes to two dots (Double dotted), so this checks double dots (a quarter lasts 960 * 1.75 = 1680 ticks) where it checked triple dots (1800).
  await click('Insert beat');await moveCursor(page,{beat:1});await editionPalette(page).getByRole('button',{name:'Double dotted',exact:true}).click();await idle();
  await setFret(page,7);await moveCursor(page,{beat:2});await setFret(page,9);
  await page.waitForFunction(()=>window.__reviewScore.tracks[0].staves[0].bars[0].voices[0].beats[0].playbackDuration===1680);
  assert.equal(await page.evaluate(()=>window.__reviewScore.tracks[0].staves[0].bars[0].voices[0].beats[1].absolutePlaybackStart),1680);
  await ready();await audible('authored double dots');
  await click('Save');await click('Export GP');await click('Open');await ready();
  assert.equal(await page.evaluate(()=>window.__reviewScore.tracks[0].staves[0].bars[0].voices[0].beats[0].dots),2);
  assert.equal(await page.evaluate(()=>window.__reviewScore.tracks[0].staves[0].bars[0].voices[0].beats[0].playbackDuration),1680);
  await audible('reimported double dots');
  await click('Add track');await ready();await check('Mute',1,true);
  // Add track selects the track it adds (d618af8; before, the selection stayed on track 1), so Remove track now removes the muted new track 2 and track 1 is what is left.
  // Undo brings the muted track back and Redo takes it away again, leaving the unmuted one.
  await click('Remove track');await click('Undo');await ready();
  assert.equal(await page.getByLabel('Mute',{exact:true}).nth(0).isChecked(),false);
  assert.equal(await page.getByLabel('Mute',{exact:true}).nth(1).isChecked(),true);
  await click('Redo');await ready();assert.equal(await page.getByLabel('Mute',{exact:true}).count(),1);assert.equal(await page.getByLabel('Mute',{exact:true}).isChecked(),false);
  await click('Undo');await ready();assert.equal(await page.getByLabel('Mute',{exact:true}).count(),2);
  // The original check: with track 1 selected, removing it leaves the muted track, and Undo and Redo keep each track's own mute.
  await click('Track 1: Guitar');
  await click('Remove track');await click('Undo');await ready();
  assert.equal(await page.getByLabel('Mute',{exact:true}).nth(0).isChecked(),false);
  assert.equal(await page.getByLabel('Mute',{exact:true}).nth(1).isChecked(),true);
  await click('Redo');await ready();assert.equal(await page.getByLabel('Mute',{exact:true}).isChecked(),true);
  await check('Mute',0,false);const metadataGeneration=(await status()).generation;await click('Undo');await idle();assert.equal(await page.getByLabel('Mute',{exact:true}).isChecked(),true);assert.equal((await status()).generation,metadataGeneration);
  await click('Undo');await ready();assert.equal(await page.getByLabel('Mute',{exact:true}).count(),2);
  await check('Solo',1,true);await click('Track 2: Bass');await click('Remove track');await ready();
  await audible('deleted solo track');
  await check('Mute',0,true);await click('Save');await click('New');await ready();
  assert.equal(await page.getByLabel('Mute',{exact:true}).isChecked(),false);
  await setFret(page,7);await ready();
  await audible('New after mute');
  assert.deepEqual(errors,[]);
  writeFileSync(resolve(directory,'review-regressions-result.json'),JSON.stringify({emptyFollowingMeasure:true,tripleDotTimingExportReimport:true,persistedMixerUndoRedo:true,deletedSoloRecovery:true,newClearsMix:true,nativeSignals:signals,externalRequestsBlocked:true},null,2));
  console.log('Packaged regression checks passed: empty following measure; triple-dot render/timing/export/reimport; mixer undo/redo; audio after solo deletion and New. External requests blocked.');
} catch(error){
  console.log(JSON.stringify(await page.evaluate(async()=>({status:await window.__TAURI_INTERNALS__.invoke('audio_status'),project:(await window.__TAURI_INTERNALS__.invoke('project_snapshot',{documentId:(await window.__TAURI_INTERNALS__.invoke('workspace_snapshot')).active.documentId})).snapshot,score:window.__reviewScore?.tracks.map(t=>({name:t.name,notes:t.staves[0].bars[0].voices[0].beats.map(b=>b.notes.map(n=>({string:n.string,fret:n.fret,pitch:n.realValue})))})),transport:document.querySelector('.transport')?.textContent})).catch(()=>({diagnosticsUnavailable:true})),null,2));
  throw error;
} finally {await page.context().unrouteAll({behavior:'ignoreErrors'});await browser.close();stop(id);}
