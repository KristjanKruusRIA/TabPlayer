import {waitForWorkspaceIdle,clickWorkstationButton,revealLeftTask} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// Sound preview: while the four-track fixture plays, Guitar9 previews the Lead factory preset. Native
// audio takes a mix whose only change is Guitar9's sound, playback keeps going without being prepared
// again, and Cancel sends the saved settings back with no edit recorded. A second preview kept with
// Keep records one undoable sound edit.
await buildInstrumentFixture();
const id=launch({TABPLAYER_TEST_OPEN:fixturePath});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const noAlerts=async()=>assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);
  await clickWorkstationButton(page,'Open');await waitForWorkspaceIdle(page);
  await page.waitForFunction(()=>(window.__tabplayerTestPrepares?.length??0)>0);
  await revealLeftTask(page,'Sound');const panel=page.getByRole('region',{name:'Track sound'}),preview=panel.getByLabel('Preview sound',{exact:true});
  const before=JSON.stringify((await readActiveDocument(page)).project);
  let saved;
  const ids=['base/0','base/1','base/2','base/3'],mixOf=(mixes,id)=>mixes[id]??{gain:1,pan:0,mute:false,solo:false},sameMixes=sent=>{for(const id of ids)assert.deepEqual(mixOf(sent,id),mixOf(saved.mixes,id),id);};
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const latest=async count=>{await page.waitForFunction(count=>(window.__tabplayerTestMixes?.length??0)>=count,mixes+count);return page.evaluate(()=>window.__tabplayerTestMixes.at(-1));};
  await clickWorkstationButton(page,'Play',{waitForIdle:false});
  const deadline=Date.now()+30000;let playing;do{playing=await status();if(playing.playing&&playing.outputPeak>.001)break;await page.waitForTimeout(50);}while(Date.now()<deadline);
  assert.ok(playing.playing&&playing.outputPeak>.001,JSON.stringify(playing));
  // The baseline is taken once playing, after any preparation that playing needed.
  const {saved:prepared,prepares,mixes}=await page.evaluate(()=>({saved:window.__tabplayerTestPrepares.at(-1),prepares:window.__tabplayerTestPrepares.length,mixes:window.__tabplayerTestMixes?.length??0}));
  saved=prepared;
  // Preview Lead while playing: only Guitar9's sound changes.
  await revealLeftTask(page,'Sound');await preview.selectOption('preset:lead');await waitForWorkspaceIdle(page);await noAlerts();
  const previewed=await latest(1);
  sameMixes(previewed.mixes);assert.deepEqual(previewed.backing,saved.backing);
  assert.equal(previewed.sounds['base/0'].presetId,'lead');assert.equal(previewed.sounds['base/0'].effects.amp.model,'lead');assert.equal(previewed.sounds['base/0'].effects.delay.enabled,true);
  for(const other of ['base/1','base/2','base/3'])assert.deepEqual(previewed.sounds[other],saved.sounds[other],other);
  assert.match(await panel.getByRole('status').innerText(),/^Previewing Lead\./);
  await page.waitForTimeout(600);
  const during=await status();assert.ok(during.playing&&!during.error&&during.generation===playing.generation&&during.outputPeak>.001,JSON.stringify(during));
  // Cancel restores the saved settings, and nothing was recorded.
  await panel.getByRole('button',{name:'Cancel preview',exact:true}).click();await waitForWorkspaceIdle(page);await noAlerts();
  const restored=await latest(2);assert.deepEqual(restored.sounds,saved.sounds);sameMixes(restored.mixes);
  assert.equal(JSON.stringify((await readActiveDocument(page)).project),before,'A canceled preview is not saved in the project.');
  assert.equal(await page.evaluate(()=>window.__tabplayerTestPrepares.length),prepares,'Previewing never prepares playback again.');
  const still=await status();assert.ok(still.playing&&still.generation===playing.generation,JSON.stringify(still));
  // Keep records the previewed sound as one undoable edit.
  await preview.selectOption('preset:crunch');await waitForWorkspaceIdle(page);await latest(3);
  await panel.getByRole('button',{name:'Keep previewed sound',exact:true}).click();await waitForWorkspaceIdle(page);await noAlerts();
  const edits=(await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound');
  assert.equal(edits.length,1,JSON.stringify(edits.map(edit=>[edit.trackId,edit.sound.presetId])));assert.equal(edits[0].trackId,'base/0');assert.equal(edits[0].sound.presetId,'crunch');
  assert.equal(await panel.getByRole('status').innerText(),'Kept Crunch.');
  // The kept sound is already playing, so keeping it sends nothing new.
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>window.__tabplayerTestMixes.length),mixes+3);
  assert.equal((await page.evaluate(()=>window.__tabplayerTestMixes.at(-1))).sounds['base/0'].presetId,'crunch');
  await clickWorkstationButton(page,'Undo');await waitForWorkspaceIdle(page);
  assert.equal((await readActiveDocument(page)).project.edits.filter(edit=>edit.type==='setTrackSound').length,0);
  assert.deepEqual((await latest(4)).sounds,saved.sounds,'Undo plays the saved sound again.');
  await clickWorkstationButton(page,'Stop');await waitForWorkspaceIdle(page);
  assert.deepEqual(errors,[]);
  console.log(`sound preview: Lead previewed on Guitar9 while playing (peak ${during.outputPeak.toFixed(3)}, generation ${playing.generation} kept), canceled back to the saved sounds, Crunch kept as one undoable edit and undone; ${prepares} preparation(s).`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
