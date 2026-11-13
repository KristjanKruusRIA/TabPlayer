import { closeWelcomeLibrary } from './workstation-commands.mjs';
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';

// MIDI input (THE-70, U16 and U17), slice 1: a device reaches the page as chords, and nothing is written into the score.
// The desktop-test build offers a "Test MIDI input" port when TABPLAYER_MIDI_IN_TEST=1, and `midi_in_test_inject` feeds
// it bytes as a device would. Only the test port is used here, so no real MIDI device is needed (and none is exercised).
// Injection calls the same sink the driver callback calls, so it bypasses midir and the operating system's MIDI driver:
// this proves the path from the sink to the page, not the real driver, port opening or unplug detection.
const id=launch({TABPLAYER_MIDI_IN_TEST:'1'});let browser;
const TEST='Test MIDI input';
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await closeWelcomeLibrary(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const invoke=(command,args)=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
  const until=async(read,predicate,label,timeout=10000)=>{const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await read();if(predicate(last))return last;await page.waitForTimeout(50);}throw new Error(`${label} did not happen in time: ${JSON.stringify(last)}`);};
  // A device sends note-ons as 0x9n key velocity. The test port splits what is injected at each status byte.
  const noteOn=(key,velocity=100,channel=0)=>[0x90|channel,key,velocity];

  // Consent: the app has opened nothing on its own, and listing opens nothing.
  assert.equal((await invoke('midi_in_status')).state,'stopped');assert.equal((await invoke('midi_in_status')).session,0);
  const ports=(await invoke('midi_in_ports')).map(port=>port.name);
  assert.ok(ports.includes(TEST),`the test port is listed: ${ports}`);
  assert.equal((await invoke('midi_in_status')).state,'stopped','listing the ports opened none');
  await assert.rejects(()=>invoke('midi_in_test_inject',{bytes:noteOn(60)}),/not open/,'nothing can be injected before Start');

  // The panel is in the View menu.
  await page.locator('details.command-menu > summary',{hasText:/^View$/}).click();
  const panel=page.locator('details.midi-capture-panel');await panel.waitFor();
  // Nothing is listed until this section is opened.
  await panel.locator('summary').click();
  const input=panel.getByLabel('Input'),action=panel.getByRole('button',{name:/Start MIDI input|Stop MIDI input/});
  await panel.getByText('Not listening. Nothing is opened until you press Start.').waitFor();
  assert.equal(await action.getAttribute('aria-disabled'),'true','Start is unavailable until an input is chosen');
  await input.selectOption(TEST);
  assert.equal((await invoke('midi_in_status')).state,'stopped','choosing an input opened nothing');
  // Only the port name and the three settings are remembered.
  const stored=JSON.parse(await page.evaluate(()=>localStorage.getItem('tabplayer.midiCapture')));
  assert.deepEqual(Object.keys(stored).sort(),['chordWindowMs','minVelocity','port','stringMapping']);assert.equal(stored.port,TEST);

  // Start, then three notes within 20 ms are one chord.
  await panel.getByLabel('Chord window').fill('60');
  await action.click();await panel.getByText(`Listening to ${TEST}.`).waitFor();
  const running=await invoke('midi_in_status');assert.equal(running.state,'running');assert.equal(running.port,TEST);
  await invoke('midi_in_test_inject',{bytes:[...noteOn(60,100),...noteOn(64,90),...noteOn(67,80,2),0x80,60,0]});
  await panel.getByText('Last chord: C4 E4 G4. Velocity 100, 90, 80. Channel 1, 3.').waitFor();
  const afterFirst=await until(()=>invoke('midi_in_status'),s=>s.chords===1,'one chord counted');
  assert.equal(afterFirst.dropped,0);

  // A second chord later is a second chord.
  await page.waitForTimeout(150);
  await invoke('midi_in_test_inject',{bytes:[...noteOn(62,70),...noteOn(65,70)]});
  await panel.getByText(/^Last chord: D4 F4\./).waitFor();
  await until(()=>invoke('midi_in_status'),s=>s.chords===2,'two chords counted');

  // A velocity floor above a note's velocity drops it.
  await panel.getByLabel('Velocity floor').fill('50');
  await page.waitForTimeout(150);
  await invoke('midi_in_test_inject',{bytes:[...noteOn(72,20),...noteOn(74,90)]});
  await panel.getByText(/^Last chord: D5\./).waitFor();
  assert.ok((await invoke('midi_in_status')).belowFloor>=1,'the soft note was counted');
  await panel.getByLabel('Velocity floor').fill('1');

  // Hostile input: a burst of 100,000 messages leaves the interface responsive, and the app reports what it dropped.
  const before=await invoke('midi_in_status');
  // The burst is injected in ten chunks about 100 ms apart (a second in all) while the page is probed for animation frames,
  // so the probe runs for as long as the app is being flooded. A single injection returns in milliseconds and would show nothing.
  const began=Date.now();let done=false;
  const frames=[];
  const sampler=(async()=>{let last=Date.now();while(!done){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve(true))));const now=Date.now();frames.push(now-last);last=now;}})();
  const chunk=10000;
  for(let part=0;part<10;part++){
    const bytes=[];for(let i=part*chunk;i<(part+1)*chunk;i++)bytes.push(0x90|(i%16),i%128,1+(i%127));
    await invoke('midi_in_test_inject',{bytes});await page.waitForTimeout(100);
  }
  done=true;await sampler;const injected=Date.now()-began;
  const frame=Math.max(...frames);
  assert.ok(frames.length>=10,`the page drew frames throughout the burst: ${frames.length} probes in ${injected} ms`);
  assert.ok(frame<500,`no frame gap above 500 ms while flooded: worst ${frame} ms over ${frames.length} probes`);
  const flooded=await until(()=>invoke('midi_in_status'),s=>s.dropped>0,'drops reported',15000);
  const sent=flooded.chords-before.chords;
  assert.ok(sent<=8+32*Math.ceil((Date.now()-began)/1000+1),`chords sent stay under the rate limit: ${sent}`);
  await page.waitForTimeout(500);
  // Still alive afterwards: once the rate bucket has refilled, a lone chord arrives.
  await page.waitForTimeout(500);
  await invoke('midi_in_test_inject',{bytes:noteOn(48,100)});
  await panel.getByText(/^Last chord: C3\./).waitFor();

  // Stop closes it.
  await action.click();await panel.getByText('Not listening. Nothing is opened until you press Start.').waitFor();
  assert.equal((await invoke('midi_in_status')).state,'stopped');
  await assert.rejects(()=>invoke('midi_in_test_inject',{bytes:noteOn(60)}),/not open/,'closed again after Stop');
  assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);assert.deepEqual(errors,[]);

  await mkdir(resolve('.analysis/parity'),{recursive:true});await page.screenshot({path:resolve('.analysis/parity/native-midi-in.png')});
  const result={ports,chords:flooded.chords,dropped:flooded.dropped,burstInjectMs:injected,slowestFrameMs:frame,probes:frames.length};
  await writeFile(join(directory,'midi-in-result.json'),JSON.stringify(result,null,2));
  console.log('MIDI input passed:',JSON.stringify(result));
}finally{try{if(browser)await browser.close();}finally{stop(id);}}
