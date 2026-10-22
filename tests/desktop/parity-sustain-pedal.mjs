import {waitForWorkspaceIdle,clickWorkstationButton,clickWorkspaceCommand} from './workstation-commands.mjs';
import { readActiveDocument } from './document-context.mjs';
import assert from 'node:assert/strict';
import { mkdir,readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directory,launch,connect,stop } from './harness.mjs';
import { buildInstrumentFixture,fixturePath } from './instrument-fixture.mjs';

// Sustain pedal: Keys gets a press on measure 2 beat 1 and a release on beat 3 from Beat notation, the
// score shows the marks, a MIDI export carries the matching CC64 press/release, and Undo clears them.
function pedalEvents(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=n=>String.fromCharCode(...bytes.slice(p,p+=n)),u32=()=>{const n=view.getUint32(p);p+=4;return n;},u16=()=>{const n=view.getUint16(p);p+=2;return n;};
  const variable=()=>{let n=0,b;do{b=bytes[p++];n=n*128+(b&127);}while(b&128);return n;};
  assert.equal(ascii(4),'MThd');u32();u16();const tracks=u16();u16();const events=[];
  for(let track=0;track<tracks;track++){assert.equal(ascii(4),'MTrk');const end=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<end){tick+=variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;
      if(code===255){p++;const length=variable();p+=length;}else if(code===240||code===247){const length=variable();p+=length;}
      else{const kind=code&240,a=bytes[p++],b=kind===192||kind===208?undefined:bytes[p++];if(kind===176&&a===64)events.push({tick,channel:code&15,value:b});}}}
  return events.sort((a,b)=>a.tick-b.tick);
}
await buildInstrumentFixture();
const folder=join(directory,`export-${Date.now()}-sustain-pedal`);await mkdir(folder,{recursive:true});
const id=launch({TABPLAYER_TEST_OPEN:fixturePath,TABPLAYER_TEST_EXPORT_DIR:folder});let browser;
try{
  browser=await connect();const page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  await button('Open');await button('Track 4: Keys');
  await page.locator('summary').filter({hasText:'Beat notation'}).first().evaluate(node=>{node.parentElement.open=true;});
  const pedal=page.getByRole('combobox',{name:/^Sustain pedal/});
  const mark=async(beat,value)=>{await page.getByLabel('Measure',{exact:true}).fill('2');await page.getByLabel('Beat',{exact:true}).fill(String(beat));await waitForWorkspaceIdle(page);await pedal.selectOption(value);await button('Apply sustain pedal');};
  await mark(1,'down');await mark(3,'up');
  const edits=(await readActiveDocument(page)).project.edits.slice(-2);
  assert.deepEqual(edits.map(edit=>[edit.type,edit.target.track,edit.target.bar,edit.target.beat,edit.pedal]),[['setSustainPedal',3,1,0,'down'],['setSustainPedal',3,1,2,'up']]);
  await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
  const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('midi');
  await dialog.getByLabel('File name',{exact:true}).fill('pedal');await dialog.getByRole('button',{name:'Export',exact:true}).click();
  const deadline=Date.now()+60000;let file;
  while(Date.now()<deadline&&!(file=(await readdir(folder)).find(name=>name.endsWith('.mid'))))await new Promise(r=>setTimeout(r,200));
  assert.ok(file,'The MIDI export was written.');await waitForWorkspaceIdle(page);
  const events=pedalEvents(new Uint8Array(await readFile(join(folder,file))));
  const ticks=[...new Set(events.map(event=>event.tick))];
  // The first bar restates the released pedal, then measure 2 presses and releases it on both Keys channels.
  assert.deepEqual(ticks.map(tick=>events.filter(event=>event.tick===tick).map(event=>event.value)),[[0,0],[127,127],[0,0]],JSON.stringify(events));
  assert.equal(new Set(events.map(event=>event.channel)).size,2);
  assert.equal(ticks[2]-ticks[1],2880,'The release follows the quarter and half note after the press.');
  await button('Undo');await button('Undo');
  assert.equal(await pedal.inputValue(),'none');
  assert.deepEqual(errors,[]);
  console.log(`sustain pedal: MIDI CC64 ${events.map(event=>`${event.tick}/ch${event.channel}=${event.value}`).join(', ')}; undo cleared the marks.`);
}finally{if(browser)await browser.close().catch(()=>{});stop(id);}
