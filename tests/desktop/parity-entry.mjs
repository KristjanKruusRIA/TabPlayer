import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { directory,launch,connect,stop } from './harness.mjs';

const saved=resolve(directory,'gp8-entry.tabplayer'),exported=resolve(directory,'gp8-entry.gp');
let id=launch({TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported,TABPLAYER_TEST_OPEN:saved});
let browser,page;
const result={};
try {
  browser=await connect();page=browser.contexts()[0].pages()[0];
  await page.getByRole('button',{name:'New',exact:true}).waitFor();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.context().route('**/*',route=>{
    const url=new URL(route.request().url());
    return ['tauri.localhost','ipc.localhost','127.0.0.1','localhost'].includes(url.hostname)||['data:','blob:'].includes(url.protocol)?route.continue():route.abort();
  });
  const snapshot=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('project_snapshot'));
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const idle=async()=>{
    await page.waitForFunction(()=>!document.querySelector('nav button')?.disabled);
    assert.equal(await page.getByRole('alert').count(),0,await page.getByRole('alert').allTextContents());
  };
  const button=async name=>{await page.getByRole('button',{name,exact:true}).click();await idle();};
  const change=(label,value)=>page.getByLabel(label,{exact:true}).fill(String(value));
  const details=label=>page.locator('summary').filter({hasText:label}).first().evaluate(node=>{node.parentElement.open=true;});
  await change('New notation track name','Piano');await button('Add pitched track');await button('Track 2: Piano');
  await change('Written pitch','C4');await button('Add pitched note');await change('Written pitch','E4');await button('Add pitched note');
  await page.getByRole('combobox',{name:/^Chord note/}).selectOption('1');await change('Written pitch','F4');await button('Update pitched note');
  assert.equal((await snapshot()).project.edits.at(-1).pitch,65);
  await button('Undo');assert.equal((await snapshot()).redoEdit.pitch,65);await button('Redo');
  await details('Staff, voices');await change('Sounding transposition',12);await button('Apply staff settings');
  await details('Notes & techniques');await page.getByRole('combobox',{name:/^Dynamics/}).selectOption('3');await idle();
  assert.equal((await snapshot()).project.edits.at(-1).patch.dynamics,3);
  await page.locator('.inspector').evaluate(node=>{node.scrollTop=0;});await page.screenshot({path:resolve('.analysis/parity/native-piano.png')});
  await change('New notation track name','Kit');await button('Add percussion track');await button('Track 3: Kit');
  await page.getByRole('combobox',{name:/^Percussion articulation/}).selectOption('91');await button('Add percussion note');
  await page.getByRole('combobox',{name:/^Percussion articulation/}).selectOption('92');await button('Add percussion note');
  await details('Song metadata');await change('Album','Parity session');await button('Apply song metadata');
  await details('Directions');await page.getByLabel('Segno',{exact:true}).check();await button('Apply directions');
  await button('Append measure');await button('Show instrument');
  await page.locator('.inspector').evaluate(node=>{node.scrollTop=0;});await page.screenshot({path:resolve('.analysis/parity/native-drums.png')});
  await page.waitForFunction(()=>{const play=[...document.querySelectorAll('button')].find(node=>node.textContent==='Play');return play&&!play.disabled;},{},{timeout:20000});
  await button('Play');
  const deadline=Date.now()+10000;let last;
  do{last=await status();if(last.playing&&last.renderedFrames>2048&&last.outputPeak>.001)break;await page.waitForTimeout(50);}while(Date.now()<deadline);
  assert.ok(last.playing&&last.outputPeak>.001,JSON.stringify(last));result.nativeAudio={outputPeak:last.outputPeak,renderedFrames:last.renderedFrames};await button('Stop');
  await button('Save');await button('Export GP');
  const native=JSON.parse(readFileSync(saved,'utf8'));assert.equal(native.edits.length,(await snapshot()).project.edits.length);
  const bytes=readFileSync(exported);
  const music=await page.evaluate(async bytes=>{
    const {importer,model,Settings,midi}=await import('/alphatab/alphaTab.mjs');
    const score=importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),new Settings()),file=new midi.MidiFile();
    new midi.MidiFileGenerator(score,new Settings(),new midi.AlphaSynthMidiFileHandler(file)).generate();
    return {album:score.album,drumClef:score.tracks[2].staves[0].bars.at(-1).clef,notes:file.tracks.flatMap(track=>track.events).filter(event=>event instanceof midi.NoteOnEvent).map(event=>({track:event.track,pitch:event.noteKey})),neutral:model.Clef.Neutral};
  },[...bytes]);
  assert.equal(music.album,'Parity session');assert.equal(music.drumClef,music.neutral);
  assert.deepEqual(music.notes.filter(note=>note.track===1).map(note=>note.pitch),[48,53]);
  assert.deepEqual(music.notes.filter(note=>note.track===2).map(note=>note.pitch),[38,46]);
  result.gpRoundtrip=music;result.commands=native.edits.length;assert.deepEqual(errors,[]);
  await browser.close();browser=null;stop(id);id=launch({TABPLAYER_TEST_OPEN:saved});
  browser=await connect();page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'Open',exact:true}).waitFor();await button('Open');
  assert.equal((await snapshot()).project.edits.length,native.edits.length);result.processRestartReopen=true;
  // A real authored WAV also checks GP references after an edit/rebuild, not just ZIP bytes.
  const wave=new Uint8Array(44+48000*2),view=new DataView(wave.buffer),ascii=(offset,text)=>[...text].forEach((char,index)=>wave[offset+index]=char.charCodeAt(0));
  ascii(0,'RIFF');view.setUint32(4,wave.length-8,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,48000,true);view.setUint32(28,96000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,96000,true);
  for(let sample=0;sample<48000;sample++)view.setInt16(44+sample*2,Math.round(Math.sin(2*Math.PI*220*sample/48000)*8192),true);
  const backed=resolve(directory,'gp8-backed.gp'),backedExport=resolve(directory,'gp8-backed-export.gp');
  const backedBytes=await page.evaluate(async({bytes,wave})=>{
    const {importer,exporter,model,Settings}=await import('/alphatab/alphaTab.mjs'),settings=new Settings();
    const score=importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),settings);score.backingTrack=new model.BackingTrack();score.backingTrack.rawAudioFile=Uint8Array.from(wave);
    return [...new exporter.Gp7Exporter().export(score,settings)];
  },{bytes:[...bytes],wave:[...wave]});
  writeFileSync(backed,Uint8Array.from(backedBytes));const hash=createHash('sha256').update(readFileSync(backed)).digest('hex');
  await browser.close();browser=null;stop(id);id=launch({TABPLAYER_TEST_OPEN:backed,TABPLAYER_TEST_EXPORT:backedExport});
  browser=await connect();page=browser.contexts()[0].pages()[0];await page.getByRole('button',{name:'Open',exact:true}).waitFor();await button('Open');
  await details('Song metadata');await change('Album','Backed study');await button('Apply song metadata');
  const readyDeadline=Date.now()+15000;let prepared;
  do{prepared=await status();if(prepared.ready&&Math.abs(prepared.backingDurationSeconds-1)<.001)break;await page.waitForTimeout(50);}while(Date.now()<readyDeadline);
  assert.ok(prepared.ready&&Math.abs(prepared.backingDurationSeconds-1)<.001,JSON.stringify(prepared));
  await button('Export GP');
  const reopenedAudio=await page.evaluate(async bytes=>{
    const {importer,Settings}=await import('/alphatab/alphaTab.mjs');return [...importer.ScoreLoader.loadScoreFromBytes(Uint8Array.from(bytes),new Settings()).backingTrack.rawAudioFile];
  },[...readFileSync(backedExport)]);
  assert.deepEqual(Uint8Array.from(reopenedAudio),wave);assert.equal(createHash('sha256').update(readFileSync(backed)).digest('hex'),hash);result.embeddedBacking={bytes:wave.length,durationSeconds:prepared.backingDurationSeconds,sourceUnchanged:true};
  writeFileSync(resolve('.analysis/parity/native-entry-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page){await page.screenshot({path:resolve('.analysis/parity/native-entry-failure.png')});console.error('Inspector:',(await page.locator('.inspector').innerText()).slice(0,1800));}throw error;}
finally{if(browser)await browser.close();stop(id);}
