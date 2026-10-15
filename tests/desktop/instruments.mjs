import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launch,connect,stop,directory} from './harness.mjs';
import {buildInstrumentFixture,fixturePath,metadataPath} from './instrument-fixture.mjs';

const metadata=await buildInstrumentFixture(),sourceHash=createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
assert.equal(sourceHash,metadata.sha256);const id=launch({TABPLAYER_TEST_OPEN:fixturePath});let browser,page,stage='startup';
const blockedExternal=[],pageErrors=[],cases=[];
try {
  browser=await connect();page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'New',exact:true}).waitFor();
  page.on('pageerror',error=>pageErrors.push({stage,message:error.message}));
  await page.context().route('**/*',route=>{const url=new URL(route.request().url());if(['tauri.localhost','ipc.localhost','localhost','127.0.0.1'].includes(url.hostname)||['data:','blob:'].includes(url.protocol))return route.continue();blockedExternal.push(url.origin);return route.abort();});
  await page.reload();await page.getByRole('button',{name:'New',exact:true}).waitFor();
  await page.evaluate(hash=>{
    window.__instrumentPlans={};const nativeFetch=window.fetch.bind(window);
    window.fetch=function(input,options){
      // Tauri's invoke is immutable; its Windows IPC script calls global fetch.
      // Inspect only the authored audio_prepare body, never IPC headers/keys.
      try {
        const url=new URL(input instanceof Request?input.url:String(input),location.href);
        if(url.hostname==='ipc.localhost'&&url.pathname==='/audio_prepare'&&typeof options?.body==='string'){
          const args=JSON.parse(options.body);if(args.sourceKey===hash)window.__instrumentPlans[args.plan.generation]=structuredClone(args.plan);
        }
      } catch {}
      return nativeFetch(input,options);
    };
  },sourceHash);
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const snapshot=()=>readActiveDocument(page);
  const waitStatus=async(predicate,timeout=10000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await status();if(predicate(last))return last;await page.waitForTimeout(25);}throw new Error(`Native status timed out at ${stage}: ${JSON.stringify(last)}`);};
  const button=async name=>{stage=name;await page.getByRole('button',{name,exact:true}).click();await page.waitForFunction(()=>!document.querySelector('nav button')?.disabled);};
  await button('Open');const opened=await waitStatus(s=>s.ready&&!s.error&&s.generation===s.desiredGeneration);await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Play'&&!button.disabled));
  const before=await snapshot();assert.equal(before.project.base.sha256,sourceHash);
  const plan=await page.evaluate(generation=>window.__instrumentPlans[generation],opened.generation);assert.ok(plan,'Observe the authored audio_prepare payload for the acknowledged generation.');
  assert.equal(plan.durationTick,metadata.durationTick);assert.equal(new Set(plan.notes.map(note=>note.id)).size,metadata.notes.length);
  const tuples=notes=>notes.map(note=>{const target=note.source.target;return JSON.stringify([note.trackId,note.key,note.startTick,note.endTick,target.track,target.staff,target.bar,target.voice,target.beat,note.source.string]);}).sort();assert.deepEqual(tuples(plan.notes),tuples(metadata.notes));
  await button('Show instrument');const view=page.getByRole('region',{name:'Instrument view'}),mode=view.getByRole('combobox',{name:/^Instrument view mode/});await view.getByText('No notes sounding',{exact:true}).waitFor();
  const active=(track,tick)=>plan.notes.filter(note=>note.trackId===track.id&&note.startTick<=tick&&tick<note.endTick);
  const assertView=async(track,native,requested=track.instrument)=>{
    const expected=active(track,native.tick);assert.ok(expected.length,`Authored ${track.name} notes at actual tick ${native.tick}`);
    await view.getByRole('heading').filter({hasText:track.name}).waitFor();
    if(requested==='guitar'||requested==='bass') {
      await view.getByRole('img',{name:requested==='guitar'?'Guitar fretboard':'Bass fretboard'}).waitFor();assert.equal(await view.locator('[data-string-row]').count(),track.tuning.length);
      const desired=expected.map(note=>{const authored=metadata.notes.find(item=>item.trackId===note.trackId&&item.key===note.key&&item.startTick===note.startTick&&item.source.string===note.source.string);assert.ok(authored);return {id:note.id,string:String(note.source.string),fret:String(authored.fret),key:String(note.key)};}).sort((a,b)=>a.id.localeCompare(b.id));
      await page.waitForFunction(ids=>{const actual=[...document.querySelectorAll('.instrument-view g[data-note-id]')].map(node=>node.dataset.noteId).sort();return JSON.stringify(actual)===JSON.stringify(ids);},desired.map(note=>note.id).sort());
      const actual=await view.locator('g[data-note-id]').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.noteId,string:node.dataset.string,fret:node.dataset.fret,key:node.dataset.key})).sort((a,b)=>a.id.localeCompare(b.id)));assert.deepEqual(actual,desired);
    } else if(requested==='keys') {
      await view.getByRole('img',{name:'Keyboard'}).waitFor();const keys=[...new Set(expected.map(note=>note.key))].sort((a,b)=>a-b);
      await page.waitForFunction(keys=>JSON.stringify([...document.querySelectorAll('.instrument-view g[data-key][data-active="true"]')].map(node=>Number(node.dataset.key)).sort((a,b)=>a-b))===JSON.stringify(keys),keys);
    } else {
      await view.getByRole('img',{name:'Drum kit'}).waitFor();const labels=expected.map(note=>metadata.notes.find(item=>item.trackId===note.trackId&&item.key===note.key&&item.startTick===note.startTick)?.drum).filter(Boolean);
      for(const label of labels)await view.locator('.instrument-note').filter({hasText:label}).waitFor();assert.equal(await view.locator('g[data-drum][data-active="true"]').count()+await view.locator('[data-percussion-key][data-active="true"]').count(),new Set(expected.map(note=>note.key)).size);
    }
    return expected.map(note=>({id:note.id,key:note.key,startTick:note.startTick,endTick:note.endTick}));
  };
  await button('Play');const playing=await waitStatus(s=>s.playing&&s.tick>100&&s.tick<1000&&s.renderedFrames>1024&&s.outputPeak>.001);await assertView(metadata.tracks[0],playing);
  await button('Pause');const paused=await waitStatus(s=>!s.playing);const frozen=await assertView(metadata.tracks[0],paused);await page.waitForTimeout(100);assert.equal((await status()).tick,paused.tick);assert.deepEqual(await assertView(metadata.tracks[0],await status()),frozen);
  for(const track of metadata.tracks) {
    await button(`Track ${track.index+1}: ${track.name}`);const native=await status();assert.equal(native.tick,paused.tick);assert.equal(native.generation,opened.generation);
    const notes=await assertView(track,native);cases.push({track:track.name,mode:track.instrument,stringCount:track.tuning.length,nativeTick:native.tick,notes});await view.screenshot({path:join(directory,`instrument-${track.instrument}.png`)});
  }
  await button('Track 1: Guitar9');await mode.selectOption('keys');await assertView(metadata.tracks[0],await status(),'keys');await mode.selectOption('guitar');await assertView(metadata.tracks[0],await status(),'guitar');await mode.selectOption('auto');
  await button('Hide instrument');assert.equal(await view.count(),0);await button('Show instrument');await assertView(metadata.tracks[0],await status());
  await button('Stop');await waitStatus(s=>!s.playing&&s.tick===0);await view.getByText('No notes sounding',{exact:true}).waitFor();await page.waitForTimeout(100);assert.equal(await view.locator('.instrument-note').count(),0);
  const silent=metadata.sharedSilentWindows[0];await page.getByLabel('Seek measure',{exact:true}).fill(String(plan.occurrences.find(occurrence=>occurrence.startTick===silent.startTick).bar+1));await button('Seek');await waitStatus(s=>Math.abs(s.tick-silent.startTick)<.01);await view.getByText('No notes sounding',{exact:true}).waitFor();
  const last=plan.occurrences.at(-1);await page.getByLabel('Seek measure',{exact:true}).fill(String(last.bar+1));await button('Seek');const sought=await waitStatus(s=>Math.abs(s.tick-last.startTick)<.01);await assertView(metadata.tracks[0],sought);
  await page.getByRole('combobox',{name:/^Speed/}).selectOption('50');await waitStatus(s=>s.speed===.5);await page.getByLabel('Loop start',{exact:true}).fill('1');await page.getByLabel('Loop end',{exact:true}).fill('2');await button('Loop');await page.getByLabel('Seek measure',{exact:true}).fill('2');await button('Seek');await waitStatus(s=>Math.abs(s.tick-plan.occurrences[1].startTick)<.01);await button('Play');await waitStatus(s=>s.playing&&s.tick>plan.occurrences[1].startTick+100&&s.speed===.5);
  const wrapped=await waitStatus(s=>s.playing&&s.tick>100&&s.tick<1000&&s.speed===.5,20000);await assertView(metadata.tracks[0],wrapped);await button('Stop');await waitStatus(s=>!s.playing&&s.tick===0);await button('Clear loop');await view.getByText('No notes sounding',{exact:true}).waitFor();
  assert.deepEqual((await snapshot()).project,before.project);assert.equal(createHash('sha256').update(readFileSync(fixturePath)).digest('hex'),sourceHash);assert.deepEqual(pageErrors,[]);
  writeFileSync(join(directory,'instruments-result.json'),JSON.stringify({authoredFixture:fixturePath,metadataPath,sourceHash,sourceAndProjectUnchanged:true,nativeGeneration:opened.generation,observedPlanNoteIds:true,actualNativePlayback:playing,selectedTracks:cases,pauseFrozen:true,stopClear:true,seekAndSilentIntervals:true,practiceSpeed:.5,inclusiveLoop:true,hideShow:true,autoAndManualModes:true,externalRequestsBlocked:true,blockedExternal:[...new Set(blockedExternal)]},null,2));
  console.log('Native instrument views passed: Guitar9/Bass6/Drums/Keys, exact plan IDs and pitches, selected track, chords, Pause/Stop/seek/speed/loop, hide/show and immutable authored source.');
} catch(error) {
  if(page){const diagnostic=await page.evaluate(async()=>({status:await window.__TAURI_INTERNALS__.invoke('audio_status'),body:document.body.innerText.slice(0,10000)})).catch(()=>null);writeFileSync(join(directory,'instruments-failure.json'),JSON.stringify({stage,diagnostic,pageErrors},null,2));console.log('Instrument smoke diagnostic:',{stage,diagnostic});}
  throw error;
} finally {try{if(browser)await browser.close();}finally{stop(id);}}
