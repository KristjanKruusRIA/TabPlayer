import {waitForWorkspaceIdle,clickWorkspaceCommand,clickWorkstationButton,revealInspector} from './workstation-commands.mjs';
import { readDocumentRecord } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFile,mkdir,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { launch,stop,connect,directory } from './harness.mjs';
await mkdir(directory,{recursive:true});
const runId=Date.now();
for(const {format,current=false} of [{format:'midi'},{format:'musicxml'},{format:'pdf'},{format:'svg'},{format:'wav'},{format:'stems'},{format:'wav',current:true},{format:'stems',current:true}]) {
  const destination=join(directory,`export-${runId}-${format}${current?'-current':''}${format==='midi'?'.mid':format==='stems'?'':`.${format}`}`);
  const id=launch({TABPLAYER_TEST_EXPORT:destination});let browser;
  try {
    browser=await connect();const page=browser.contexts()[0].pages()[0];
    const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await revealInspector(page);await clickWorkstationButton(page,'Edit',{waitForIdle:false});await waitForWorkspaceIdle(page);
    await page.getByLabel('Fret',{exact:true}).fill('7');await page.getByRole('button',{name:'Set note',exact:true}).click();
    await waitForWorkspaceIdle(page);
    const {documentId}=(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'))).active;
    const origin=await readDocumentRecord(page,documentId),before=origin.snapshot;assert.equal(before.dirty,true);
    if(current)await page.getByRole('combobox',{name:/^Speed/}).selectOption('50');
    await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption(format);
    if(format==='wav'||format==='stems'){await dialog.getByLabel('Bit depth').selectOption('24');await dialog.getByLabel('Effect tail (seconds)').fill('0.1');if(current)await dialog.getByRole('combobox',{name:/^Speed/}).selectOption('current');}
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    const deadline=Date.now()+120000;let exists=false;
    while(Date.now()<deadline){
      try{await stat(destination);exists=true;break;}catch{}
      const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(await failure.innerText());
      const progress=page.getByRole('progressbar',{name:'Export progress'});
      if(await progress.count()){
        const jobId=await progress.getAttribute('data-job-id');
        if(jobId){const status=await page.evaluate(({documentId,id})=>window.__TAURI_INTERNALS__.invoke('export_status',{documentId,id}),{documentId,id:jobId});assert.notEqual(status?.status,'failed',status?.error??'Native export failed.');assert.notEqual(status?.status,'cancelled','Export unexpectedly cancelled.');}
      }
      await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(exists,`Missing ${format} output; UI: ${await page.locator('body').innerText()}`);
    assert.deepEqual(await readDocumentRecord(page,documentId),origin,'Export must preserve document history, source bytes and dirty state.');
    if(format==='midi'){const bytes=await readFile(destination);assert.equal(bytes.subarray(0,4).toString(),'MThd');assert.equal(bytes.readUInt16BE(12),960);}
    if(format==='musicxml'){const text=await readFile(destination,'utf8');assert.ok(text.startsWith('<?xml'));assert.match(text,/<score-partwise/);}
    if(format==='svg'){const text=await readFile(destination,'utf8');assert.ok(text.startsWith('<svg'));assert.ok(!text.includes('<text'));assert.ok(text.match(/<path /g).length>2,'SVG must contain outlined notation beyond the background');assert.match(text,/viewBox="0 0 /);assert.match(text,/fill="#ffffff"|fill="#fff"/);}
    if(format==='pdf'){assert.equal((await readFile(destination)).subarray(0,5).toString(),'%PDF-');}
    if(format==='wav'){const b=await readFile(destination);assert.equal(b.subarray(0,4).toString(),'RIFF');assert.equal(b.readUInt16LE(22),2);assert.equal(b.readUInt32LE(24),48000);assert.equal(b.readUInt16LE(34),24);assert.equal(b.readUInt32LE(40)+44,b.length);assert.ok(b.subarray(44).some(n=>n!==0));if(current)assert.equal(b.readUInt32LE(40)/(2*3),772800);}
    if(format==='stems'){const m=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'));assert.ok(m.frames>0);if(current)assert.equal(m.frames,772800);assert.ok(m.tracks.some(t=>t.kind==='mix'));for(const t of m.tracks){assert.equal(t.filename.includes('/'),false);assert.equal(t.filename.includes('\\'),false);const b=await readFile(join(destination,t.filename));assert.equal(b.readUInt32LE(40)/(2*3),m.frames);}}
    await page.screenshot({path:join(directory,`exports-${format}.png`)});
    console.log(`${format}${current?' at 50% practice speed':''}: native destination, valid output and immutable dirty snapshot passed.`);
  }finally{if(browser)await browser.close();stop(id);}
}
