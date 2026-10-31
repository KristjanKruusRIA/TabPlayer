import {waitForWorkspaceIdle,clickWorkspaceCommand,clickWorkstationButton,revealInspector,setPlaybackSpeed} from './workstation-commands.mjs';
import { readDocumentRecord } from './document-context.mjs';
import assert from 'node:assert/strict';
import { readFile,readdir,mkdir,stat } from 'node:fs/promises';
import { basename,join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { launch,stop,connect,directory } from './harness.mjs';
await mkdir(directory,{recursive:true});
const runId=Date.now();
for(const {format,current=false,named=false} of [{format:'pdf',named:true},{format:'midi'},{format:'musicxml'},{format:'pdf'},{format:'svg'},{format:'png'},{format:'wav'},{format:'stems'},{format:'wav',current:true},{format:'stems',current:true}]) {
  let destination=join(directory,`export-${runId}-${format}${current?'-current':''}${format==='midi'?'.mid':format==='stems'?'':`.${format}`}`);
  // A named export lets the dialog's file-name template choose the file inside a fresh folder.
  const namedDirectory=join(directory,`export-${runId}-named`);if(named)await mkdir(namedDirectory,{recursive:true});
  const id=launch(named?{TABPLAYER_TEST_EXPORT_DIR:namedDirectory}:{TABPLAYER_TEST_EXPORT:destination});let browser;
  try {
    browser=await connect();const page=browser.contexts()[0].pages()[0];
    const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await revealInspector(page);await clickWorkstationButton(page,'Edit',{waitForIdle:false});await waitForWorkspaceIdle(page);
    await page.getByLabel('Fret',{exact:true}).fill('7');await page.getByRole('button',{name:'Set note',exact:true}).click();
    await waitForWorkspaceIdle(page);
    const {documentId}=(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('workspace_snapshot'))).active;
    const origin=await readDocumentRecord(page,documentId),before=origin.snapshot;assert.equal(before.dirty,true);
    if(current)await setPlaybackSpeed(page,50);
    await clickWorkspaceCommand(page,'Export score',{waitForIdle:false});
    const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption(format);
    if(format==='png')await dialog.getByRole('radio',{name:'150 dpi'}).click();
    if(named){
      // The inner dot checks that the extension is appended, not substituted, exactly as previewed.
      await dialog.getByLabel('File name',{exact:true}).fill('%T - %t. (%n of %N) %d');
      const preview=(await dialog.getByText(/^Saves as /).innerText()).replace(/^Saves as /,'');
      assert.match(preview,/^Untitled - .+\. \(1 of \d+\) \d{4}-\d{2}-\d{2}\.pdf$/);destination=join(namedDirectory,preview);
    }
    if(format==='wav'||format==='stems'){await dialog.getByRole('radio',{name:'24 bit'}).click();await dialog.getByLabel('Effect tail (seconds)').fill('0.1');if(current)await dialog.getByRole('radio',{name:'Current speed coefficient'}).click();}
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
    if(format==='png'){
      const b=await readFile(destination);assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      const chunks=[];for(let at=8;at<b.length;){const length=b.readUInt32BE(at);chunks.push({type:b.subarray(at+4,at+8).toString(),data:b.subarray(at+8,at+8+length)});at+=12+length;}
      const header=chunks.find(c=>c.type==='IHDR').data,width=header.readUInt32BE(0),height=header.readUInt32BE(4);assert.equal(header[8],8);assert.equal(header[9],6);
      const dims=chunks.find(c=>c.type==='pHYs').data;assert.equal(dims.readUInt32BE(0),5906);assert.equal(dims[8],1);
      assert.ok(width>1000&&height>1000,`Unexpected page size ${width}x${height} at 150 dpi`);
      // The first pixel of the first row is stored unfiltered under every PNG filter: an opaque white page.
      const pixels=inflateSync(Buffer.concat(chunks.filter(c=>c.type==='IDAT').map(c=>c.data)));assert.equal(pixels.length,height*(width*4+1));assert.deepEqual([...pixels.subarray(1,5)],[255,255,255,255]);
    }
    if(format==='pdf'){assert.equal((await readFile(destination)).subarray(0,5).toString(),'%PDF-');}
    if(format==='wav'){const b=await readFile(destination);assert.equal(b.subarray(0,4).toString(),'RIFF');assert.equal(b.readUInt16LE(22),2);assert.equal(b.readUInt32LE(24),48000);assert.equal(b.readUInt16LE(34),24);assert.equal(b.readUInt32LE(40)+44,b.length);assert.ok(b.subarray(44).some(n=>n!==0));if(current)assert.equal(b.readUInt32LE(40)/(2*3),772800);}
    if(format==='stems'){const m=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'));assert.ok(m.frames>0);if(current)assert.equal(m.frames,772800);assert.ok(m.tracks.some(t=>t.kind==='mix'));for(const t of m.tracks){assert.equal(t.filename.includes('/'),false);assert.equal(t.filename.includes('\\'),false);const b=await readFile(join(destination,t.filename));assert.equal(b.readUInt32LE(40)/(2*3),m.frames);}}
    await page.screenshot({path:join(directory,`exports-${format}.png`)});
    if(named)assert.deepEqual(await readdir(namedDirectory),[basename(destination)],'The template must name the only exported file.');
    console.log(`${format}${current?' at 50% practice speed':''}${named?' named from the file-name template':''}: native destination, valid output and immutable dirty snapshot passed.`);
  }finally{if(browser)await browser.close();stop(id);}
}
