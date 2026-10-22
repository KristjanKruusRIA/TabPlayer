import {waitForWorkspaceIdle,clickWorkstationButton,revealDock} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// Track focus: in the four-track fixture, the Mixer's focus slider sweeps Bass6 from focused to
// unfocused while playing. Native audio accepts mixes that change only the gains of the other tracks
// or of Bass6, focus follows the selection to Guitar9, Reset restores the saved mix exactly, nothing
// is prepared again, and the project gains no edits.
await buildInstrumentFixture();
const id=launch({TABPLAYER_TEST_OPEN:fixturePath});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  await button('Open');await revealDock(page,'Mixer');await button('Track 2: Bass6');
  const slider=page.getByRole('slider',{name:'Focus selected track'});
  // Focus waits for prepared playback; the preparation's settings are the saved mix.
  await page.waitForFunction(()=>(window.__tabplayerTestPrepares?.length??0)>0);await slider.and(page.locator(':enabled')).waitFor();
  const before=JSON.stringify((await readActiveDocument(page)).project);
  const {saved,prepares,mixes}=await page.evaluate(()=>({saved:window.__tabplayerTestPrepares.at(-1).mixes,prepares:window.__tabplayerTestPrepares.length,mixes:window.__tabplayerTestMixes?.length??0}));
  const ids=['base/0','base/1','base/2','base/3'],base=id=>saved[id]??{gain:1,pan:0,mute:false,solo:false};
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  // The latest accepted mix: every track listed, only gains differ from the saved mix.
  const gains=async count=>{
    await page.waitForFunction(count=>(window.__tabplayerTestMixes?.length??0)>=count,mixes+count);
    const sent=(await page.evaluate(()=>window.__tabplayerTestMixes.at(-1))).mixes;assert.deepEqual(Object.keys(sent).sort(),ids);
    for(const id of ids)assert.deepEqual({...sent[id],gain:base(id).gain},base(id),`${id} keeps its saved pan, mute and solo`);
    return Object.fromEntries(ids.map(id=>[id,sent[id].gain]));
  };
  const sweep=async(value,count)=>{await revealDock(page,'Mixer');await slider.evaluate((node,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,String(value));node.dispatchEvent(new Event('input',{bubbles:true}));},value);await waitForWorkspaceIdle(page);return gains(count);};
  assert.deepEqual(await sweep(50,1),{'base/0':.5,'base/1':1,'base/2':.5,'base/3':.5});
  assert.equal(await page.getByRole('region',{name:'Mixer'}).getByText('Focus 50%',{exact:true}).count(),1);
  await button('Play');
  const deadline=Date.now()+30000;let playing;do{playing=await status();if(playing.playing&&playing.outputPeak>.001)break;await page.waitForTimeout(50);}while(Date.now()<deadline);
  assert.ok(playing.playing&&playing.outputPeak>.001,JSON.stringify(playing));
  assert.deepEqual(await sweep(-100,2),{'base/0':1,'base/1':0,'base/2':1,'base/3':1});
  await button('Track 1: Guitar9');
  assert.deepEqual(await gains(3),{'base/0':0,'base/1':1,'base/2':1,'base/3':1},'Focus follows the selected track.');
  const still=await status();assert.ok(still.playing&&!still.error&&still.generation===playing.generation,JSON.stringify(still));
  await revealDock(page,'Mixer');await page.getByRole('button',{name:'Reset focus',exact:true}).click();await waitForWorkspaceIdle(page);
  await page.waitForFunction(count=>window.__tabplayerTestMixes.length>=count,mixes+4);
  assert.deepEqual((await page.evaluate(()=>window.__tabplayerTestMixes.at(-1))).mixes,saved,'Reset sends the saved mix itself.');
  assert.equal(await slider.inputValue(),'0');
  assert.equal(await page.evaluate(()=>window.__tabplayerTestPrepares.length),prepares,'Focus never prepares playback again.');
  await button('Stop');
  assert.equal(JSON.stringify((await readActiveDocument(page)).project),before,'Focus is not saved in the project.');
  assert.deepEqual(errors,[]);
  console.log(`focus: Bass6 focused 50% then unfocused 100% while playing (peak ${playing.outputPeak.toFixed(3)}, generation ${playing.generation} kept), moved to Guitar9, reset to the saved mix; ${prepares} preparation(s), project unchanged.`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
