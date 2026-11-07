import {waitForWorkspaceIdle,closeWelcomeLibrary,clickWorkstationButton,revealInspectorTab,selectWorkspaceTrack,hidePlaybackControls} from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// MIDI output (A26): tracks routed to a MIDI port are sent there in time with playback, each on its own channel
// (drums on channel 10), with every note released, and are silent in the internal sound. The desktop-test build offers
// a "Test MIDI output" port that records what it receives; a real system port is used too when Windows has one.
const fixture=await buildInstrumentFixture();
const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_MIDI_OUT_TEST:'1'});let browser;
const TEST='Test MIDI output',SYSTEM='Microsoft GS Wavetable Synth';
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);
  await clickWorkstationButton(page,'Open',{waitForIdle:false});await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const invoke=(command,args)=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
  const until=async(read,predicate,label,timeout=10000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await read();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`${label} timed out: ${JSON.stringify(last)}`);};
  const ports=(await invoke('midi_out_ports')).map(port=>port.name);
  assert.ok(ports.includes(TEST),`the test port is listed: ${ports}`);
  const panel=page.locator('section[aria-labelledby="inspector-track-midi-out"]'),output=panel.getByLabel('Output');
  const route=async(track,port)=>{
    await selectWorkspaceTrack(page,track);await revealInspectorTab(page,'Track');
    await output.selectOption(port);await waitForWorkspaceIdle(page);
    assert.equal(await output.inputValue(),port,`${track} shows ${port||'the internal sound'}`);
  };
  const names=fixture.tracks.map((track,index)=>`Track ${index+1}: ${track.name}`);
  // One choice is one undoable edit.
  await route(names[3],TEST);
  await clickWorkstationButton(page,'Undo');await revealInspectorTab(page,'Track');assert.equal(await output.inputValue(),'','undo returns Keys to the internal sound');
  await clickWorkstationButton(page,'Redo');await revealInspectorTab(page,'Track');assert.equal(await output.inputValue(),TEST,'redo routes it again');
  for(const track of names.slice(0,3))await route(track,TEST);
  await panel.getByText(`Sent to ${TEST}.`).waitFor();
  await invoke('midi_out_test_log');
  // Two bars at 60 bpm: chords at 0 s and at 5 s.
  await clickWorkstationButton(page,'Play',{waitForIdle:false});await until(()=>invoke('audio_status'),s=>s.playing,'score playing');
  let loudest=0;const playUntil=Date.now()+6200;
  while(Date.now()<playUntil){loudest=Math.max(loudest,(await invoke('audio_status')).outputPeak);await page.waitForTimeout(100);}
  await clickWorkstationButton(page,'Stop',{waitForIdle:false});await until(()=>invoke('audio_status'),s=>!s.playing,'score stopped');
  await page.waitForTimeout(500);
  const log=await invoke('midi_out_test_log');
  const status=await invoke('midi_out_status');
  // Every track is on the port, so the internal sound is silent.
  assert.ok(loudest<1e-4,`internal output stays silent while every track is routed: ${loudest}`);
  const on=log.filter(entry=>(entry.bytes[0]&0xf0)===0x90&&entry.bytes[2]>0);
  const off=log.filter(entry=>(entry.bytes[0]&0xf0)===0x80||((entry.bytes[0]&0xf0)===0x90&&entry.bytes[2]===0));
  const channelOf=keys=>[...new Set(on.filter(entry=>keys.includes(entry.bytes[1])).map(entry=>entry.bytes[0]&0x0f))];
  const program=channel=>log.find(entry=>entry.bytes[0]===(0xc0|channel))?.bytes[1];
  // Keys plays C E G then D F# A; Guitar9 includes C#1 and G#1, which no other track plays; drums play kick and crash.
  const keysChannels=channelOf([67]),guitarChannels=channelOf([25,32]),drumChannels=channelOf([36,49]);
  assert.equal(drumChannels.length,1);assert.equal(drumChannels[0],9,'drums on channel 10');
  assert.equal(guitarChannels.length,1);assert.notEqual(guitarChannels[0],9);
  assert.ok(keysChannels.length===1&&![9,guitarChannels[0]].includes(keysChannels[0]),`Keys has its own channel: ${keysChannels} vs ${guitarChannels}`);
  assert.equal(program(guitarChannels[0]),25,'the guitar program is sent');assert.equal(program(keysChannels[0]),0,'the keys program is sent');
  // In time: the second Keys chord starts 5 s after the first.
  const keysOn=key=>on.find(entry=>(entry.bytes[0]&0x0f)===keysChannels[0]&&entry.bytes[1]===key);
  const first=keysOn(60),second=keysOn(62);assert.ok(first&&second,'both Keys chords were sent');
  const gap=second.ms-first.ms;assert.ok(Math.abs(gap-5000)<5,`second chord 5000 ms after the first: ${gap}`);
  // Every note sent is released by the time playback has stopped.
  const held=new Map();
  for(const entry of log){
    const kind=entry.bytes[0]&0xf0,channel=entry.bytes[0]&0x0f,key=`${channel}:${entry.bytes[1]}`;
    if(kind===0x90&&entry.bytes[2]>0)held.set(key,(held.get(key)??0)+1);
    else if(kind===0x80||kind===0x90)held.set(key,Math.max(0,(held.get(key)??0)-1));
    else if(kind===0xb0&&(entry.bytes[1]===123||entry.bytes[1]===120))for(const k of held.keys())if(k.startsWith(`${channel}:`))held.set(k,0);
  }
  assert.deepEqual([...held].filter(([,count])=>count>0),[],'no note is left sounding');
  const testPort=status.ports.find(port=>port.name===TEST);
  assert.ok(testPort?.open&&!testPort.error,JSON.stringify(status));assert.equal(status.dropped,0,JSON.stringify(status));assert.equal(status.late,0,`no message more than 5 ms late: ${JSON.stringify(status)}`);
  await mkdir(resolve('.analysis/parity'),{recursive:true});await page.screenshot({path:resolve('.analysis/parity/native-midi-out.png')});
  // A count-in bar first: nothing renders for 4 s at 60 bpm, and the first chord still follows its last click, on time.
  await clickWorkstationButton(page,'Practice');const practice=page.locator('summary').filter({hasText:'Practice settings'}).locator('..');await practice.evaluate(node=>{node.open=true;});
  const setCountIn=async bars=>{await practice.getByLabel('Count-in bars',{exact:true}).fill(String(bars));await hidePlaybackControls(page);await practice.getByRole('button',{name:'Apply practice settings'}).click();await until(()=>invoke('audio_status'),s=>s.practice.settings.countIn.bars===bars,`count-in ${bars}`);};
  await setCountIn(1);
  const beforeCount=await invoke('midi_out_status');await invoke('midi_out_test_log');
  const pressed=Date.now();
  await clickWorkstationButton(page,'Play',{waitForIdle:false});
  await until(()=>invoke('audio_status'),s=>s.practice.phase==='countIn','counting in');
  await until(()=>invoke('audio_status'),s=>s.practice.phase==='playing','count-in over',8000);
  await page.waitForTimeout(5600);
  await clickWorkstationButton(page,'Stop',{waitForIdle:false});await until(()=>invoke('audio_status'),s=>!s.playing,'score stopped after the count-in');
  await page.waitForTimeout(500);
  const countLog=await invoke('midi_out_test_log'),afterCount=await invoke('midi_out_status');
  const countOn=countLog.filter(entry=>(entry.bytes[0]&0xf0)===0x90&&entry.bytes[2]>0&&(entry.bytes[0]&0x0f)===keysChannels[0]);
  const firstCount=countOn.find(entry=>entry.bytes[1]===60),secondCount=countOn.find(entry=>entry.bytes[1]===62);
  assert.ok(firstCount&&secondCount,'both Keys chords were sent after the count-in');
  const countGap=secondCount.ms-firstCount.ms,wait=firstCount.unixMs-pressed;
  assert.ok(Math.abs(countGap-5000)<5,`with a count-in the second chord is 5000 ms after the first: ${countGap}`);
  assert.ok(wait>3900&&wait<4400,`the first chord follows the 4 s count-in: ${wait} ms after Play was pressed`);
  assert.equal(afterCount.late-beforeCount.late,0,`no message late after the count-in: ${JSON.stringify(afterCount)}`);
  const countIn={gapMs:countGap,firstChordAfterPressMs:wait,late:afterCount.late-beforeCount.late,maxLateMs:afterCount.maxLateMs};
  await setCountIn(0);
  // A real system port, when Windows has one: the track is sent there and the port opens without error.
  let system=null;
  if(ports.includes(SYSTEM)){
    await route(names[3],SYSTEM);
    await clickWorkstationButton(page,'Play',{waitForIdle:false});await until(()=>invoke('audio_status'),s=>s.playing,'score playing');
    await page.waitForTimeout(1500);await clickWorkstationButton(page,'Stop',{waitForIdle:false});
    system=await until(()=>invoke('midi_out_status'),s=>s.ports.some(port=>port.name===SYSTEM&&port.open),`${SYSTEM} open`);
    const entry=system.ports.find(port=>port.name===SYSTEM);assert.equal(entry.error,null);assert.ok(entry.tracks.length===1,JSON.stringify(system));
    await route(names[3],'');
  }
  assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);assert.deepEqual(errors,[]);
  const result={countIn,ports,loudest,channels:{keys:keysChannels[0],guitar:guitarChannels[0],drums:drumChannels[0]},gapMs:gap,messages:log.length,noteOns:on.length,noteOffs:off.length,status,system};
  await writeFile(join(directory,'midi-out-result.json'),JSON.stringify(result,null,2));
  console.log('MIDI output passed:',JSON.stringify(result));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
